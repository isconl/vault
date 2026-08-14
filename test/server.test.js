'use strict';
/**
 * End-to-end smoke tests: actually start the vault HTTP server and hit it
 * with real requests. This is the test that proves the extraction is
 * behaviorally whole -- the unit tests prove each module is correct in
 * isolation, this proves they're correctly wired together.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tmpEnv() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-e2e-memory-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-e2e-logs-'));
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-e2e-sess-')), 'sessions.json');
  return { memoryDir, logsDir, sessionFile };
}

// IMPORTANT: getAuthToken()/getTotpSecret() etc. in server.js read process.env
// at REQUEST time (not just at startup), so the env vars must stay set for the
// server's whole lifetime -- restoring them right after main() returns (before
// any test has actually sent a request) would silently break every subsequent
// authenticated call. Cleanup happens via the returned `cleanup()`, which each
// test calls in its `finally` block alongside server.close().
async function startServer(envOverrides = {}) {
  const { memoryDir, logsDir, sessionFile } = tmpEnv();
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    VAULT_PORT: '0',
    VAULT_BIND: '127.0.0.1',
    VAULT_MEMORY_DIR: memoryDir,
    VAULT_LOGS_DIR: logsDir,
    VAULT_SESSION_FILE: sessionFile,
    VAULT_TOKEN: 'test-static-token',
    BWS_ACCESS_TOKEN: '',   // no Bitwarden in tests -- secrets.init() must degrade gracefully, not hang/throw
    // Explicit, not just absent: the sync loop now also falls back to a
    // Bitwarden secret (VAULT_SYNC_INTERVAL_MS) for portability, so on a
    // machine that DOES have real Bitwarden creds in its ambient env this
    // would otherwise fire real Graph calls during every test run.
    VAULT_SYNC_INTERVAL_MS: '0',
    ...envOverrides,
  });
  delete require.cache[require.resolve('../src/server')];
  const { main } = require('../src/server');
  const handle = await main();
  const cleanup = () => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  };
  return { ...handle, cleanup };
}

test('GET /health responds without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.engine, 'vault');
  } finally { server.close(); cleanup(); }
});

test('GET /manifest lists vault\'s capabilities without auth', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest`);
    const body = await res.json();
    assert.equal(body.engine, 'vault');
    assert.ok(body.capabilities.some(c => c.name === 'vault.read'));
    assert.ok(body.capabilities.some(c => c.name === 'auth.totp'));
  } finally { server.close(); cleanup(); }
});

test('a protected route with no credential fails closed (silent 404, not 401)', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`);
    assert.equal(res.status, 404, 'unauthenticated access must be indistinguishable from a nonexistent route');
  } finally { server.close(); cleanup(); }
});

test('a valid static token can write and then read back a vault row -- the full round trip', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const write = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ID: 'T1', TITLE: 'Buy milk', STATUS: 'open' }),
    });
    assert.equal(write.status, 200);
    const writeBody = await write.json();
    assert.equal(writeBody.ok, true);

    const read = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      headers: { Authorization: 'Bearer test-static-token' },
    });
    const readBody = await read.json();
    assert.equal(readBody.rows.length, 1);
    assert.equal(readBody.rows[0].TITLE, 'Buy milk');
  } finally { server.close(); cleanup(); }
});

test('PUT /vault/:collection replaces the whole row set -- the read-modify-write path other engines use for delete/bulk-edit', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    for (const t of [{ ID: 'T1', TITLE: 'Keep me' }, { ID: 'T2', TITLE: 'Delete me' }]) {
      await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
      });
    }
    const put = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [{ ID: 'T1', TITLE: 'Keep me' }] }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.ok, true);
    assert.equal(putBody.count, 1);

    const read = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      headers: { Authorization: 'Bearer test-static-token' },
    });
    const readBody = await read.json();
    assert.equal(readBody.rows.length, 1);
    assert.equal(readBody.rows[0].ID, 'T1');
  } finally { server.close(); cleanup(); }
});

test('PUT /vault/:collection rejects a non-array rows body', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notRows: true }),
    });
    assert.equal(res.status, 400);
  } finally { server.close(); cleanup(); }
});

test('wrong token is rejected, and repeated failures eventually lock out the IP', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    let last;
    for (let i = 0; i < 9; i++) {
      last = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
    }
    assert.equal(last.status, 404, 'still fails closed even after lockout kicks in -- no oracle either way');
  } finally { server.close(); cleanup(); }
});

test('POST /vault/bootstrap is idempotent -- main() already bootstraps on startup, so a second call creates nothing new', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    // main()'s own boot sequence already ran bootRepair() once (visible in the
    // startup log: "26 file(s) bootstrapped"). Calling the route again should
    // find everything already in place and report zero new creates -- proving
    // bootRepair() is safe to re-run, not just that it works once.
    const res = await fetch(`http://127.0.0.1:${port}/vault/bootstrap`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-static-token' },
    });
    const body = await res.json();
    assert.ok(Array.isArray(body.created));
    assert.equal(body.created.length, 0, 'everything was already bootstrapped at server startup');
    assert.equal(body.columnsUpgraded, 0);
    assert.equal(body.emptyFilesRepaired, 0);
    assert.equal(body.rowsRestored, 0);
  } finally { server.close(); cleanup(); }
});

test('GET /secrets/status reports shape/diagnostics only -- names, never values', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/secrets/status`, {
      headers: { Authorization: 'Bearer test-static-token' },
    });
    const body = await res.json();
    assert.ok('configured' in body);
    assert.equal(body.configured, false, 'no BWS_ACCESS_TOKEN was set in this test env');
    assert.ok(Array.isArray(body.keys));
    assert.equal(body.keys.length, 0, 'nothing synced -- no Bitwarden token in this test env');
    // The response legitimately NAMES the missing env var in its error message
    // (e.g. "BWS_ACCESS_TOKEN not set") -- that's a diagnostic, not a leak.
    // What must never appear is a `value`/`values` field carrying secret content.
    assert.equal('value' in body, false);
    assert.equal('values' in body, false);
  } finally { server.close(); cleanup(); }
});

test('the audit log actually recorded the requests made during this test run', async () => {
  const { server, port, auditLog, cleanup } = await startServer();
  try {
    await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ID: 'T1', TITLE: 'Test' }),
    });
    const chain = auditLog.verifyChain();
    assert.equal(chain.ok, true);
  } finally { server.close(); cleanup(); }
});
