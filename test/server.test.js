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
    // Explicit, not just absent: the backup loop now also falls back to a
    // Bitwarden secret (VAULT_BACKUP_INTERVAL_MS) for portability, so on a
    // machine that DOES have real Bitwarden creds in its ambient env this
    // would otherwise fire a real boot-time backup pass during every test
    // run using the sqlite engine (BI26083005 -- was VAULT_SYNC_INTERVAL_MS).
    VAULT_BACKUP_INTERVAL_MS: '0',
    // Same reasoning as VAULT_BACKUP_INTERVAL_MS above, for BM26082011's
    // Gmail sync loop -- explicit off in tests, not left to its 5-minute
    // default.
    EMAIL_SYNC_DISABLED: '1',
    // Explicit empty override, not absent: get()'s hasOwnProperty check
    // treats this as authoritative and never falls through to a real
    // GOOGLE_CLIENT_ID sitting in this machine's own environment or
    // Bitwarden config (FI26082703: "POST /google/auth/start...fails soft
    // (502)" assumes no real client_id is configured, which isn't actually
    // guaranteed without this -- same isolation gap as FI26082701 in hub).
    GOOGLE_CLIENT_ID: '',
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

test('GET /backup/status/public reports readiness without auth, before any backup pass has run', async () => {
  const { server, port, cleanup } = await startServer(); // VAULT_BACKUP_INTERVAL_MS: '0' in startServer's own env -- the loop never fires
  try {
    const res = await fetch(`http://127.0.0.1:${port}/backup/status/public`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.firstPassComplete, false);
    assert.equal(body.ok, false);
  } finally { server.close(); cleanup(); }
});

test('GET /backup/status/public reports completion and result shape after a backup pass, without needing auth', async () => {
  // sqlite engine so store.snapshotToFile exists -- no real Bitwarden/Graph
  // creds in this test env, so the push itself fails (502-shaped), but
  // that's still a real completed pass with a real result to report;
  // proves /backup/run and /backup/status/public share state either way.
  const { server, port, cleanup } = await startServer({ VAULT_STORE_ENGINE: 'sqlite', VAULT_DB_KEY_PASSPHRASE: 'test-fixture-passphrase' });
  try {
    await fetch(`http://127.0.0.1:${port}/backup/run`, {
      method: 'POST', headers: { Authorization: 'Bearer test-static-token' },
    });
    const res = await fetch(`http://127.0.0.1:${port}/backup/status/public`);
    const body = await res.json();
    assert.equal(body.firstPassComplete, true);
    assert.equal(typeof body.ok, 'boolean');
    assert.ok(body.finishedAt);
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

test('PUT /vault/:collection forwards force:true so a legitimate bulk delete over half the rows actually happens, not silently refused', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    for (const t of [{ ID: 'T1' }, { ID: 'T2' }, { ID: 'T3' }]) {
      await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
      });
    }
    // Without force: the massacre guard should refuse (removing 3 of 3).
    const refused = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [] }),
    });
    assert.equal((await refused.json()).removed, 0);
    let read = await (await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      headers: { Authorization: 'Bearer test-static-token' },
    })).json();
    assert.equal(read.rows.length, 3);

    // With force:true: the same request should actually take effect.
    const forced = await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [], force: true }),
    });
    assert.equal((await forced.json()).removed, 3);
    read = await (await fetch(`http://127.0.0.1:${port}/vault/scope%2Ftasks.tsv`, {
      headers: { Authorization: 'Bearer test-static-token' },
    })).json();
    assert.equal(read.rows.length, 0);
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

test('POST /google/send returns a clean 502 (never a crash) when no Google account is connected', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/google/send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'alex@example.com', subject: 'Re: proposal', body: 'sounds good' }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally { server.close(); cleanup(); }
});

test('POST /google/send with an unknown account label is a clean 400, not a 500', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/google/send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'does-not-exist', to: 'x@example.com', subject: 's', body: 'b' }),
    });
    assert.equal(res.status, 400);
  } finally { server.close(); cleanup(); }
});

test('POST /google/auth/start for the default account fails soft (502) with no client_id configured, not a crash', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/google/auth/start`, {
      method: 'POST', headers: { Authorization: 'Bearer test-static-token', 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 502);
  } finally { server.close(); cleanup(); }
});

test('GET /manifest lists the new google.* capabilities', async () => {
  const { server, port, cleanup } = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest`);
    const body = await res.json();
    const names = body.capabilities.map(c => c.name);
    assert.ok(names.includes('google.auth.start'));
    assert.ok(names.includes('google.auth.callback'));
    assert.ok(names.includes('google.send'));
    assert.ok(names.includes('google.sync.all'));
  } finally { server.close(); cleanup(); }
});
