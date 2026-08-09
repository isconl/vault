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
  console.log(`  vault: ${repairResult.created.length} file(s) bootstrapped, ` +
    `${repairResult.columnsUpgraded} column migration(s), ` +
    `${repairResult.emptyFilesRepaired} empty-file repair(s), ` +
    `${repairResult.rowsRestored} row(s) reconciled`);

  // -- 4. Auth ------------------------------------------------------------------
  const auth = createAuthModule({
    getAuthToken: () => process.env.VAULT_TOKEN || process.env.ISCONL_TOKEN || '',
    getTotpSecret: () => secretStore.get('TOTP_SECRET') || secretStore.get('ISCONL_TOTP_SECRET') || '',
    getPinDigest: () => process.env.VAULT_PIN_HASH || '',
    sessionFile: SESSION_FILE,
    trustProxy: /^(1|true|yes)$/i.test(process.env.VAULT_TRUST_PROXY || ''),
    auditLog,
  });

  // -- 5. Microsoft Graph client --------------------------------------------
  let graphConfig = {
    clientId: process.env.MSGRAPH_CLIENT_ID || '',
    clientSecret: process.env.MSGRAPH_CLIENT_SECRET || '',
    accessToken: process.env.MSGRAPH_ACCESS_TOKEN || '',
    refreshToken: secretStore.get('MSGRAPH_REFRESH_TOKEN') || '',
  };
  const graph = createGraphClient({
    getConfig: () => graphConfig,
    setConfig: (patch) => { graphConfig = { ...graphConfig, ...patch }; },
    onTokenRefreshed: async (accessToken, refreshToken) => {
      await secretStore.persistSecret('MSGRAPH_REFRESH_TOKEN', refreshToken, 'Rotated by vault on token refresh');
    },
    auditLog,
  });

  // -- 6. FAIL CLOSED bind guard (same rule as the monolith this was extracted from) --
  const authConfigured = !!(process.env.VAULT_TOKEN || process.env.ISCONL_TOKEN
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
    }

    if (pathname === '/vault/bootstrap' && req.method === 'POST') {
      const result = store.bootRepair();
      return sendJson(res, 200, result);
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
      resolve({ server, store, auth, graph, auditLog, secretStore, port: actualPort });
    });
  });
}

if (require.main === module) {
  main().catch(e => { console.error('vault failed to start:', e); process.exit(1); });
}

module.exports = { main };
