#!/usr/bin/env node
'use strict';
/**
 * vault engine -- HTTP entry point.
 *
 * Boot sequence (order matters, matches the discipline established while
 * porting from isconl-agent): secrets -> vault self-repair -> auth/graph
 * clients wired to the resolved config -> bind. Nothing serves a request
 * before secrets have loaded and the vault has been repaired -- serving a
 * pre-repair vault is exactly the class of bug the disaster-recovery code
 * in lib/store.js exists to prevent.
 *
 * Deliberately zero-framework (raw http.createServer, manual routing),
 * matching the style of the codebase this was extracted from.
 */

const http = require('http');
const path = require('path');
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createAuthModule } = require('../lib/auth');
const { createVaultStore } = require('../lib/store');
const { createGraphClient } = require('../lib/graph');
const blocksModule = require('../lib/blocks');
const onedriveSync = require('../lib/onedrive-sync');
const { createSyncLoop } = require('../lib/sync-loop');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.VAULT_PORT || process.env.PORT || '8081', 10);
const BIND = process.env.VAULT_BIND || '127.0.0.1';
const MEMORY_DIR = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.VAULT_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
const SESSION_FILE = process.env.VAULT_SESSION_FILE || path.join(__dirname, '..', 'runtime', 'sessions.json');
// Off by default -- the test suite calls main() repeatedly with no real
// Graph credentials configured, and an enabled-by-default loop would fire
// ~35 real HTTPS calls per test. Explicit opt-in (dev-local.sh sets this
// for real runs; Render should set it too) matches the fail-closed pattern
// the rest of this file already uses for auth.
const SYNC_INTERVAL_MS = parseInt(process.env.VAULT_SYNC_INTERVAL_MS || '0', 10);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function main() {
  // -- 1. Secrets -----------------------------------------------------------
  const secretsResult = await secretStore.init();
  console.log(`  secrets: ${secretsResult.source}, ${secretsResult.count} key(s)`);

  // -- 2. Audit log -----------------------------------------------------------
  const auditLog = createAuditLog({ logsDir: LOGS_DIR });

  // -- 3. Vault store: bootstrap + self-repair BEFORE serving any request ----
  const store = createVaultStore({ memoryDir: MEMORY_DIR, logsDir: LOGS_DIR, auditLog });
  const repairResult = store.bootRepair();

  // Day-scheduling engine (ported from isconl-agent's lib/blocks.js, dev
  // branch): injected against vault's own store/audit rather than the
  // monolith's globals, same pattern as every other lib/ module here.
  blocksModule.init({
    readTSV: store.read,
    appendTSV: store.append,
    rewriteTSV: store.rewrite,
    auditLog: (event, data) => auditLog.log(event, data),
  });
  console.log(`  vault: ${repairResult.created.length} file(s) bootstrapped, ` +
    `${repairResult.columnsUpgraded} column migration(s), ` +
    `${repairResult.emptyFilesRepaired} empty-file repair(s), ` +
    `${repairResult.rowsRestored} row(s) reconciled`);

  // -- 4. Auth ------------------------------------------------------------------
  const auth = createAuthModule({
    getAuthToken: () => process.env.VAULT_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('VAULT_TOKEN') || '',
    getTotpSecret: () => secretStore.get('TOTP_SECRET') || secretStore.get('ISCONL_TOTP_SECRET') || '',
    // Same key the legacy monolith reads (ISCONL_PIN_HASH) -- one Bitwarden
    // secret covers both surfaces rather than a vault-only duplicate.
    getPinDigest: () => secretStore.get('PIN_HASH') || secretStore.get('ISCONL_PIN_HASH') || process.env.VAULT_PIN_HASH || '',
    sessionFile: SESSION_FILE,
    trustProxy: /^(1|true|yes)$/i.test(process.env.VAULT_TRUST_PROXY || ''),
    auditLog,
  });

  // -- 5. Microsoft Graph client --------------------------------------------
  let graphConfig = {
    clientId: process.env.MSGRAPH_CLIENT_ID || secretStore.get('MSGRAPH_CLIENT_ID') || '',
    clientSecret: process.env.MSGRAPH_CLIENT_SECRET || secretStore.get('MSGRAPH_CLIENT_SECRET') || '',
    accessToken: process.env.MSGRAPH_ACCESS_TOKEN || '',
    refreshToken: secretStore.get('MSGRAPH_REFRESH_TOKEN') || '',
    // This app registration is locked to a specific Azure AD tenant --
    // /common/ and /consumers/ both fail (confirmed live, 2026-08-14).
    // Falls back to 'common' (graph.js's own default) if unset.
    tenantId: process.env.MSGRAPH_TENANT_ID || secretStore.get('MSGRAPH_TENANT_ID') || '',
  };
  const graph = createGraphClient({
    getConfig: () => graphConfig,
    setConfig: (patch) => { graphConfig = { ...graphConfig, ...patch }; },
    onTokenRefreshed: async (accessToken, refreshToken) => {
      await secretStore.persistSecret('MSGRAPH_REFRESH_TOKEN', refreshToken, 'Rotated by vault on token refresh');
    },
    auditLog,
  });

  // -- 5.5. OneDrive sync loop (boot-time pull + interval repeat) -------------
  const syncLoop = createSyncLoop({ onedriveSync, graph, store, auditLog });
  if (SYNC_INTERVAL_MS > 0) {
    syncLoop.start(SYNC_INTERVAL_MS);
    console.log(`  onedrive sync: enabled, every ${Math.round(SYNC_INTERVAL_MS / 1000)}s`);
  } else {
    console.log('  onedrive sync: disabled (set VAULT_SYNC_INTERVAL_MS to enable)');
  }

  // -- 6. FAIL CLOSED bind guard (same rule as the monolith this was extracted from) --
  const authConfigured = !!(process.env.VAULT_TOKEN || process.env.ISCONL_TOKEN || secretStore.get('VAULT_TOKEN')
    || secretStore.get('TOTP_SECRET') || secretStore.get('ISCONL_TOTP_SECRET') || process.env.VAULT_PIN_HASH);
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(BIND);
  if (!isLoopback && !authConfigured) {
    console.error('  REFUSING TO BIND: no credential configured and BIND is not loopback. ' +
      'Set VAULT_TOKEN, TOTP_SECRET (via Bitwarden), or VAULT_PIN_HASH first.');
    process.exit(1);
  }

  // -- 7. Routes ------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', engine: 'vault', version: manifest.version });
    }
    if (pathname === '/manifest' && req.method === 'GET') {
      return sendJson(res, 200, manifest);
    }

    // -- auth routes: public (they ARE the login), each with its own lockout --
    if (pathname === '/auth/methods' && req.method === 'GET') {
      return sendJson(res, 200, auth.methods());
    }
    if (pathname === '/auth/totp' && req.method === 'POST') {
      const ip = auth.clientIp(req);
      const lockout = auth.checkLoginLockout(ip);
      if (lockout.locked) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(lockout.retryAfterMs / 1000)) });
        return res.end(JSON.stringify({ success: false, lockedOut: true, error: `Too many attempts -- locked for ${Math.ceil(lockout.retryAfterMs / 1000)}s.` }));
      }
      let code = '';
      try { code = JSON.parse(await readBody(req) || '{}').code || ''; } catch {}
      const result = auth.verifyTotp(code);
      if (!result.ok) {
        auth.recordLoginFailure(ip);
        return sendJson(res, 401, { success: false, error: result.reason === 'TOTP not configured' ? 'TOTP is not configured on this instance' : 'Invalid or expired code' });
      }
      auth.clearLoginFailures(ip);
      const session = auth.issueSession();
      auditLog.log('totp_login', { ip, expiresAt: new Date(session.expiresAt).toISOString() });
      return sendJson(res, 200, { success: true, token: session.token, expiresAt: session.expiresAt });
    }

    if (pathname === '/auth/pin' && req.method === 'POST') {
      const ip = auth.clientIp(req);
      const lockout = auth.checkPinLockout(ip);
      if (lockout.locked) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(lockout.retryAfterMs / 1000)) });
        return res.end(JSON.stringify({ success: false, lockedOut: true, error: `Too many attempts -- PIN locked for ${Math.ceil(lockout.retryAfterMs / 1000)}s.` }));
      }
      let pin = '';
      try { pin = JSON.parse(await readBody(req) || '{}').pin || ''; } catch {}
      const result = auth.verifyPin(pin);
      if (!result.ok) {
        const { attemptsLeft } = auth.recordPinFailure(ip);
        auditLog.log('pin_failed', { ip, reason: result.reason });
        return sendJson(res, 401, { success: false, error: result.reason === 'PIN not configured' ? 'PIN sign-in is not enabled on this instance' : 'Incorrect PIN', attemptsLeft });
      }
      auth.clearPinFailures(ip);
      const session = auth.issueSession(8 * 60 * 60 * 1000);   // shorter-lived: a weaker credential buys less time
      auditLog.log('pin_login', { ip, expiresAt: new Date(session.expiresAt).toISOString() });
      return sendJson(res, 200, { success: true, token: session.token, expiresAt: session.expiresAt });
    }

    if (pathname === '/auth/verify' && req.method === 'POST') {
      const result = auth.authenticate(req);
      return sendJson(res, 200, { valid: result.ok, via: result.via || null });
    }

    // -- everything below requires auth ---------------------------------------
    if (!auth.checkAuth(req, res)) return;   // checkAuth already wrote the (silent, no-oracle) 404

    if (pathname === '/secrets/status' && req.method === 'GET') {
      return sendJson(res, 200, secretStore.status());
    }

    if (pathname.startsWith('/vault/') && pathname !== '/vault/bootstrap') {
      const collection = decodeURIComponent(pathname.slice('/vault/'.length));
      if (req.method === 'GET') {
        return sendJson(res, 200, { collection, rows: store.read(collection) });
      }
      if (req.method === 'POST') {
        let row = {};
        try { row = JSON.parse(await readBody(req) || '{}'); } catch {}
        const ok = store.append(collection, row);
        return sendJson(res, ok ? 200 : 400, { ok, collection });
      }
      // Full-collection replace, for callers that need to filter/mutate rows
      // (delete, bulk edit) rather than only append. The client reads current
      // rows via GET, computes the new set locally, and PUTs it back -- the
      // same read-modify-write contract store.rewrite()'s callback expresses
      // locally, translated to something an HTTP body can carry (a function
      // can't cross the wire; a full row array can).
      if (req.method === 'PUT') {
        let rows = [];
        try { rows = JSON.parse(await readBody(req) || '{}').rows; } catch {}
        if (!Array.isArray(rows)) return sendJson(res, 400, { ok: false, error: 'body must be {"rows": [...]}' });
        const removed = store.rewrite(collection, () => rows);
        return sendJson(res, 200, { ok: true, collection, count: rows.length, removed });
      }
    }

    if (pathname === '/vault/bootstrap' && req.method === 'POST') {
      const result = store.bootRepair();
      return sendJson(res, 200, result);
    }

    // On-demand full sync pass (every known collection), independent of the
    // interval timer -- for verifying the loop works, or forcing a refresh
    // without waiting for VAULT_SYNC_INTERVAL_MS to elapse.
    if (pathname === '/onedrive/sync-all' && req.method === 'POST') {
      const result = await syncLoop.runOnce();
      return sendJson(res, 200, result);
    }
    if (pathname === '/onedrive/sync-status' && req.method === 'GET') {
      return sendJson(res, 200, { running: syncLoop.isRunning(), lastResult: syncLoop.getLastResult() });
    }

    // Same shape as /vault/:collection above, for the non-TSV state files
    // (calendar_events.json, rhythm.json, the identity YAMLs) that another
    // engine on a different host needs to read/write through vault rather
    // than keeping its own on-disk copy -- the same host-sharing gap
    // /vault/:collection's own header already fixed for TSV rows, still
    // open for these until now.
    if (pathname.startsWith('/vault-raw/')) {
      const collection = decodeURIComponent(pathname.slice('/vault-raw/'.length));
      if (req.method === 'GET') {
        return sendJson(res, 200, { collection, text: store.rawRead(collection) });
      }
      if (req.method === 'PUT') {
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
        if (typeof body.text !== 'string') return sendJson(res, 400, { ok: false, error: 'body must be {"text": "..."}' });
        try {
          store.rawWrite(collection, body.text, { force: !!body.force });
        } catch (e) {
          return sendJson(res, 409, { ok: false, error: String(e.message || e) });
        }
        return sendJson(res, 200, { ok: true, collection, bytes: body.text.length });
      }
    }

    // Server epoch millis -- what a client's trusted-clock sync (offset +
    // round-trip correction) measures against. No auth-sensitive content,
    // but kept behind the same auth gate as everything else here for
    // consistency (a client already has a session by the time it needs this).
    if (pathname === '/time' && req.method === 'GET') {
      return sendJson(res, 200, { now: Date.now() });
    }

    if (pathname === '/blocks' && req.method === 'GET') {
      const tasks = store.read('scope/tasks.tsv');
      const people = store.read('circle/people.tsv');
      return sendJson(res, 200, blocksModule.plan({ tasks, people }));
    }
    if (pathname === '/blocks' && req.method === 'POST') {
      let patch = {};
      try { patch = JSON.parse(await readBody(req) || '{}'); } catch {}
      try {
        const row = blocksModule.save(patch);
        return sendJson(res, 200, { ok: true, block: row });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
    }

    // Microsoft 365 device-code sign-in: start mints a code + verification
    // URL, poll checks whether the user has completed it yet (Microsoft's
    // own polling contract -- keeps returning "still waiting" until the
    // user visits the URL and enters the code, or the code expires).
    if (pathname === '/msgraph/auth/start' && req.method === 'POST') {
      const data = await graph.startDeviceCodeAuth();
      if (!data?.device_code) return sendJson(res, 502, { ok: false, error: data?.error_description || 'could not start device code sign-in' });
      return sendJson(res, 200, {
        ok: true,
        userCode: data.user_code,
        verificationUri: data.verification_uri || data.verification_uri_complete,
        expiresInSec: data.expires_in,
        deviceCode: data.device_code,   // needed by /msgraph/auth/poll -- not a secret, expires in minutes
        pollIntervalSec: data.interval || 5,
      });
    }
    if (pathname === '/msgraph/auth/poll' && req.method === 'POST') {
      let deviceCode = '';
      try { deviceCode = JSON.parse(await readBody(req) || '{}').deviceCode || ''; } catch {}
      if (!deviceCode) return sendJson(res, 400, { ok: false, error: 'deviceCode required' });
      const r = await graph.pollDeviceCodeAuth(deviceCode);
      if (r.success) return sendJson(res, 200, { ok: true, connected: true });
      // authorization_pending / slow_down are the "keep polling" states, not
      // real failures -- everything else (expired_token, access_denied) is.
      const err = r.data?.error || '';
      if (err === 'authorization_pending' || err === 'slow_down') {
        return sendJson(res, 200, { ok: true, connected: false, waiting: true });
      }
      return sendJson(res, 200, { ok: true, connected: false, waiting: false, error: r.data?.error_description || err });
    }

    // Read-only OneDrive verification: compares the real remote copy of one
    // collection against the local vault, changes nothing on either side.
    // Deliberately GET-only tonight -- see lib/onedrive-sync.js's header for
    // why the write path isn't here yet.
    if (pathname === '/onedrive/check' && req.method === 'GET') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const collection = searchParams.get('collection');
      if (!collection) return sendJson(res, 400, { error: 'collection query param required, e.g. scope/tasks.tsv' });
      const result = onedriveSync.isTSV(collection)
        ? await onedriveSync.checkRemote(graph, collection, store.read(collection))
        : await onedriveSync.checkRemoteRaw(graph, collection, store.rawRead(collection));
      return sendJson(res, result.ok ? 200 : 502, result);
    }

    // Pulls one collection's real OneDrive content into the local vault,
    // replacing whatever's there. Local-disk write only -- never writes
    // back to OneDrive itself (see lib/onedrive-sync.js's header).
    if (pathname === '/onedrive/pull' && req.method === 'POST') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const collection = searchParams.get('collection');
      if (!collection) return sendJson(res, 400, { error: 'collection query param required, e.g. scope/tasks.tsv' });
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      const isTSV = onedriveSync.isTSV(collection);
      const result = isTSV
        ? await onedriveSync.pullToLocal(graph, store, collection, { force: !!body.force })
        : await onedriveSync.pullToLocalRaw(graph, store, collection, { force: !!body.force });
      if (result.ok) auditLog.log('onedrive_pulled', { collection, rows: isTSV ? result.remoteRowCount : undefined, bytes: result.remoteBytes });
      return sendJson(res, result.ok ? 200 : 502, result);
    }

    if (pathname === '/graph/request' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch { body = {}; }
      const { pathAndQuery, method, graphBody, headers } = body;
      if (!pathAndQuery) return sendJson(res, 400, { error: 'pathAndQuery required' });
      const result = await graph.graphRequest(pathAndQuery, { method, body: graphBody, headers });
      return sendJson(res, result.status || 200, result.data);
    }

    return sendJson(res, 404, { error: 'Not Found' });
  });

  return new Promise((resolve) => {
    server.listen(PORT, BIND, () => {
      const actualPort = server.address().port;
      console.log(`  vault listening on ${BIND}:${actualPort}`);
      resolve({ server, store, auth, graph, auditLog, secretStore, syncLoop, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('vault failed to start:', e); process.exit(1); });
}

module.exports = { main };
