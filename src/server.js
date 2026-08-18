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
const { createAuthModule, pinDigest, pinFormatOk } = require('../lib/auth');
const { createVaultStore } = require('../lib/store');
const { createGraphClient } = require('../lib/graph');
const blocksModule = require('../lib/blocks');
const onedriveSync = require('../lib/onedrive-sync');
const onedriveBrowse = require('../lib/onedrive-browse');
const { onThisDay } = require('../lib/onthisday');
const narration = require('../lib/narration');
const { createSyncLoop } = require('../lib/sync-loop');
const manifest = require('../lib/manifest');

const PORT = parseInt(process.env.VAULT_PORT || process.env.PORT || '8081', 10);
const BIND = process.env.VAULT_BIND || '127.0.0.1';
const MEMORY_DIR = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.VAULT_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
const SESSION_FILE = process.env.VAULT_SESSION_FILE || path.join(__dirname, '..', 'runtime', 'sessions.json');

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

  // Write-then-push (SYNC1, 2026-08-18): every local vault write now also
  // pushes that same file up to OneDrive, fire-and-forget, so a local edit
  // outside the pull loop survives the next scheduled pull instead of being
  // silently overwritten by it. Wired here (not at store creation, above)
  // because it needs a live graph client. Safe with sync disabled too --
  // pushToRemote just fails closed (401) the same as any other Graph call
  // when there's no token, and firePush only logs that, never throws.
  store.setPushHook((relPath) => onedriveSync.pushToRemote(graph, store, relPath));

  // -- 5.5. OneDrive sync loop (boot-time pull + interval repeat) -------------
  // Off by default -- the test suite calls main() repeatedly with no real
  // Graph credentials configured, and an enabled-by-default loop would fire
  // ~35 real HTTPS calls per test. Explicit opt-in matches the fail-closed
  // pattern the rest of this file already uses for auth. Falls back to a
  // Bitwarden secret (not just the env var) so this survives a fresh clone
  // on ANY machine/deploy path -- dev-local.sh and docker-compose.yml both
  // set the env var already, but Render's per-service env isn't in this
  // repo at all, and Bitwarden is the one config source every deployment
  // path already depends on (see _handoff/migration-log.md, 2026-08-14).
  const SYNC_INTERVAL_MS = parseInt(process.env.VAULT_SYNC_INTERVAL_MS || secretStore.get('VAULT_SYNC_INTERVAL_MS') || '0', 10);
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

    // Set/reset the quick-PIN. Reachable only with an already-valid session
    // (any of TOTP/PIN/static token, per the auth gate above) -- there is no
    // separate step-up check because getting here already proves you're the
    // owner. Persists straight to Bitwarden (persistSecret), not just the
    // local process cache, so the new PIN survives a restart and reaches
    // every deploy target reading the same PIN_HASH secret (Render, Oracle,
    // another dev box) -- setting it only in memory would silently stop
    // working the moment this process restarts.
    if (pathname === '/auth/set-pin' && req.method === 'POST') {
      let newPin = '';
      try { newPin = JSON.parse(await readBody(req) || '{}').pin || ''; } catch {}
      if (!pinFormatOk(newPin)) {
        return sendJson(res, 400, { ok: false, error: `PIN must be digits only, between the configured min and max length` });
      }
      const result = await secretStore.persistSecret('PIN_HASH', pinDigest(newPin),
        `PIN set via console on ${new Date().toISOString()}`);
      if (!result.ok) return sendJson(res, 502, { ok: false, error: result.error || 'could not write to Bitwarden' });
      auditLog.log('pin_set', { created: result.created });
      return sendJson(res, 200, { ok: true });
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
    // U8: a management-only listing that includes ACTIVE:no rows, so a
    // settings screen can show a deactivated block and turn it back on via
    // POST /blocks (save() already accepts any existing ID -- the missing
    // piece was ever being able to list one). Deliberately separate from
    // GET /blocks above, which stays active-only for placement/scheduling.
    if (pathname === '/blocks/all' && req.method === 'GET') {
      return sendJson(res, 200, { blocks: blocksModule.allBlocks() });
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

    // Manually push one collection's current local content up to OneDrive
    // now, rather than waiting for the next local write to trigger it via
    // store.js's push hook -- for backfilling a file that was edited before
    // this existed (BR1/ID1's blocks.tsv/spaces.tsv renames) or force-pushing
    // after resolving a conflict.
    if (pathname === '/onedrive/push' && req.method === 'POST') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const collection = searchParams.get('collection');
      if (!collection) return sendJson(res, 400, { error: 'collection query param required, e.g. scope/tasks.tsv' });
      const result = await onedriveSync.pushToRemote(graph, store, collection);
      if (result.ok) auditLog.log('onedrive_pushed', { collection, bytes: result.bytes });
      return sendJson(res, result.ok ? 200 : 502, result);
    }

    // Lists the files inside one LOCAL vault folder (not OneDrive) -- for
    // another engine to discover filenames it doesn't know in advance (a
    // course's lesson .md files) before fetching each via /vault-raw/.
    if (pathname.startsWith('/vault-dir/') && req.method === 'GET') {
      const relPath = decodeURIComponent(pathname.slice('/vault-dir/'.length));
      return sendJson(res, 200, { path: relPath, files: store.listDir(relPath) });
    }

    // Pulls every file in one remote OneDrive folder into the local vault --
    // for content whose filenames aren't fixed in advance (a course's lesson
    // .md files), unlike /onedrive/pull's single known collection path.
    if (pathname === '/onedrive/pull-folder' && req.method === 'POST') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const folder = searchParams.get('path');
      if (!folder) return sendJson(res, 400, { error: 'path query param required, e.g. learning/viva' });
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      const result = await onedriveSync.pullFolder(graph, store, folder, { force: !!body.force });
      if (result.ok) auditLog.log('onedrive_folder_pulled', { folder, files: result.files.length });
      return sendJson(res, result.ok ? 200 : 502, result);
    }

    // -- OneDrive file manager: general-purpose browse/CRUD anywhere in the
    // connected drive, distinct from the known-collection sync routes above.
    // See lib/onedrive-browse.js's header for why paths here are unprefixed
    // (relative to the drive root itself, not REMOTE_ROOT).
    if (pathname === '/onedrive/browse' && req.method === 'GET') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const result = await onedriveBrowse.listFolder(graph, searchParams.get('path') || 'root');
      return sendJson(res, result.ok ? 200 : (result.status || 502), result);
    }
    if (pathname === '/onedrive/item' && req.method === 'GET') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = searchParams.get('id');
      if (!id) return sendJson(res, 400, { ok: false, error: 'id query param required' });
      const result = await onedriveBrowse.getItemMeta(graph, id);
      return sendJson(res, result.ok ? 200 : (result.status || 502), result);
    }
    if (pathname === '/onedrive/item-preview' && req.method === 'GET') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const id = searchParams.get('id');
      if (!id) return sendJson(res, 400, { ok: false, error: 'id query param required' });
      const result = await onedriveBrowse.getItemPreview(graph, id);
      return sendJson(res, result.ok ? 200 : (result.status || 502), result);
    }
    if (pathname === '/onedrive/mkdir' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      if (!body.folderName) return sendJson(res, 400, { ok: false, error: 'folderName required' });
      const result = await onedriveBrowse.mkdir(graph, body.parentPath || '', body.folderName);
      if (result.ok) auditLog.log('onedrive_mkdir', { parentPath: body.parentPath, folderName: body.folderName });
      return sendJson(res, result.ok ? 200 : 502, result);
    }
    if (pathname === '/onedrive/upload' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      if (!body.fileName) return sendJson(res, 400, { ok: false, error: 'fileName required' });
      // contentBase64+contentType (binary: docx/pdf) or content (legacy plain
      // text: md/tsv) -- see onedrive-browse.js's upload() header comment.
      const result = await onedriveBrowse.upload(graph, body.folderPath || '', body.fileName, body.content || '', {
        contentBase64: body.contentBase64, contentType: body.contentType,
      });
      const bytes = body.contentBase64 !== undefined
        ? Buffer.byteLength(body.contentBase64, 'base64')
        : Buffer.byteLength(body.content || '', 'utf8');
      if (result.ok) auditLog.log('onedrive_upload', { folderPath: body.folderPath, fileName: body.fileName, bytes });
      return sendJson(res, result.ok ? 200 : 502, result);
    }
    // POST-with-body, not DELETE-with-query -- matches the file manager
    // frontend's fmDeleteItem() contract (webconsole/static/app.js), which
    // predates this backend and was built against the legacy monolith's
    // own route shape.
    if (pathname === '/onedrive/item/delete' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      if (!body.itemId) return sendJson(res, 400, { ok: false, error: 'itemId required' });
      const result = await onedriveBrowse.deleteItem(graph, body.itemId);
      if (result.ok) auditLog.log('onedrive_delete', { id: body.itemId });
      return sendJson(res, result.ok ? 200 : 502, result);
    }
    if (pathname === '/onedrive/move' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      if (!body.itemId) return sendJson(res, 400, { ok: false, error: 'itemId required' });
      const result = await onedriveBrowse.moveOrRename(graph, body.itemId, { newName: body.newName, toPath: body.toPath });
      if (result.ok) auditLog.log('onedrive_move', { itemId: body.itemId, newName: body.newName, toPath: body.toPath });
      return sendJson(res, result.ok ? 200 : 502, result);
    }

    // Today's curated theme-day phrase, if one has been written for this
    // date -- {phrase: string|null}. Client falls back to a computed
    // default when null (see app.js's themePhrase()).
    if (pathname === '/theme-day' && req.method === 'GET') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const row = store.read('scope/theme_days.tsv').find(r => r.DATE === date);
      return sendJson(res, 200, { date, phrase: row ? row.PHRASE : null });
    }

    if (pathname === '/onthisday' && req.method === 'GET') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const date = searchParams.get('date') || null;
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
      return sendJson(res, 200, onThisDay(store.read, date));
    }

    // Narration audio: latest ready version for one module, with a fresh
    // (Graph downloadUrl's are ~1hr pre-signed) playable url resolved on
    // every call rather than cached from generation time.
    if (pathname === '/learning/audio' && req.method === 'GET') {
      const { searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const course = searchParams.get('course');
      const file = searchParams.get('file');
      if (!course || !file) return sendJson(res, 400, { ok: false, error: 'course and file query params required' });
      const rows = store.read('learning/audio_versions.tsv')
        .filter(r => r.COURSE_ID === course && r.LESSON === file && r.STATUS === 'ready')
        .sort((a, b) => Number(b.VERSION) - Number(a.VERSION));
      const latest = rows[0];
      if (!latest) return sendJson(res, 200, { ok: false, generated: false });
      const item = await onedriveBrowse.getItemMeta(graph, latest.ONEDRIVE_ID);
      if (!item.ok) return sendJson(res, 502, { ok: false, error: item.error });
      return sendJson(res, 200, {
        ok: true, version: Number(latest.VERSION), voiceName: latest.VOICE_NAME,
        durationSecs: Number(latest.DURATION_SECS) || null, generatedAt: latest.GENERATED_AT,
        url: item.item.downloadUrl,
      });
    }

    // Generate (or regenerate, if the module's text changed since the last
    // pass) narration audio for one module. Real work -- typically several
    // seconds to a couple of minutes for a long module -- so callers driving
    // a course-wide batch should expect this to take a while per module and
    // not treat a slow response as a failure.
    if (pathname === '/learning/audio/generate' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      const { course, file, force } = body;
      if (!course || !file) return sendJson(res, 400, { ok: false, error: 'course and file required' });

      let mdText;
      try { mdText = store.rawRead(`learning/${course}/${file}`); } catch { mdText = null; }
      if (!mdText) return sendJson(res, 404, { ok: false, error: `module not found: learning/${course}/${file}` });

      const hash = narration.contentHash(mdText);
      const existing = store.read('learning/audio_versions.tsv')
        .filter(r => r.COURSE_ID === course && r.LESSON === file)
        .sort((a, b) => Number(b.VERSION) - Number(a.VERSION));
      const latest = existing[0];
      if (!force && latest && latest.STATUS === 'ready' && latest.CONTENT_HASH === hash) {
        return sendJson(res, 200, { ok: true, skipped: true, reason: 'unchanged since last narration', version: Number(latest.VERSION) });
      }

      const heading = (mdText.match(/^#\s+(.+)$/m) || [, file])[1];
      const courseRow = store.read('learning/courses.tsv').find(r => r.ID === course);
      const script = narration.mdToScript(heading, courseRow ? courseRow.TITLE : '', mdText);

      let audioBuffer;
      try { audioBuffer = await narration.synthesize(script); }
      catch (e) { return sendJson(res, 502, { ok: false, error: String(e.message || e).slice(0, 300) }); }

      const version = latest ? Number(latest.VERSION) + 1 : 1;
      const moduleId = file.replace(/\.md$/i, '');
      const folderPath = `Sconl/Core/Apex/Vault/vault-documents/isconl-vault/learning/${course}/_audio/${moduleId}`;
      const fileName = `v${version}.mp3`;
      const upload = await onedriveBrowse.uploadLarge(graph, folderPath, fileName, audioBuffer);
      if (!upload.ok) return sendJson(res, 502, { ok: false, error: upload.error });

      const row = {
        ID: `AUD-${course}-${moduleId}-v${version}`, COURSE_ID: course, LESSON: file, VERSION: String(version),
        CONTENT_HASH: hash, VOICE_ID: narration.VOICE_ID, VOICE_NAME: narration.VOICE_NAME,
        DURATION_SECS: String(Math.round(audioBuffer.length / 16000)),
        ONEDRIVE_ID: upload.item.id, ONEDRIVE_PATH: `${folderPath}/${fileName}`,
        GENERATED_AT: new Date().toISOString(), STATUS: 'ready',
      };
      store.append('learning/audio_versions.tsv', row);
      // Keep the manifest itself durable on OneDrive too -- same pattern as
      // any other push through the general file-manager upload path (see
      // onedrive-sync.js's header: schema-aware TSV push is deliberately
      // still not built, but a plain file overwrite via the browse/upload
      // capability carries the same risk as a user re-saving the file
      // themselves, and this file only ever grows by one row per call).
      try {
        const full = store.rawRead('learning/audio_versions.tsv');
        await onedriveBrowse.upload(graph, 'Sconl/Core/Apex/Vault/vault-documents/isconl-vault/learning', 'audio_versions.tsv', full);
      } catch (e) { auditLog.log('audio_manifest_push_failed', { error: String(e.message || e).slice(0, 160) }); }

      auditLog.log('narration_generated', { course, file, version, bytes: audioBuffer.length });
      return sendJson(res, 200, { ok: true, version, durationSecs: Number(row.DURATION_SECS) });
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
