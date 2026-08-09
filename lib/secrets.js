'use strict';
/**
 * Centralized secret resolution for isconl-agent engines.
 *
 * Bitwarden Secrets Manager is the single source of truth. Nothing sensitive is
 * expected to live on disk except one bootstrap credential (BWS_ACCESS_TOKEN),
 * and even that is preferably a user-scoped environment variable rather than a file.
 *
 * Resolution order (first hit wins):
 *   1. process.env            - explicit override, always wins (CI, one-off runs)
 *   2. Bitwarden Secrets Mgr  - the source of truth, refreshed on an interval
 *   3. encrypted offline cache- so the agent still boots on a plane or offline
 *   4. .env file              - legacy fallback; gitignored and excluded from sync
 *
 * The offline cache is encrypted at rest with a key derived from the access token,
 * so a stolen cache file without the token is useless.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CACHE_FILE = path.join(__dirname, '..', 'runtime', 'secrets.cache');
const STATE_FILE = path.join(__dirname, '..', 'runtime', 'bws-state');
const REFRESH_MS = parseInt(process.env.ISCONL_SECRET_REFRESH_MS || String(15 * 60 * 1000));

// Resolved lazily through envOrUser (defined below, hoisted): these are consts
// at module load, and a scheduled-task-launched agent has no shell profile - the
// registry is the only place a setx survives. Bitwarden org region is tenant-
// specific (EU vs US cloud) -- BWS_API_URL/BWS_IDENTITY_URL let a tenant override
// the default without a code change; a mismatch here surfaces as invalid_client
// on every login even with a perfectly valid access token, so don't assume US.
let API_URL, IDENTITY_URL;
function resolveEndpoints() {
  if (!API_URL) {
    API_URL = envOrUser('BWS_API_URL') || 'https://api.bitwarden.com';
    IDENTITY_URL = envOrUser('BWS_IDENTITY_URL') || 'https://identity.bitwarden.com';
  }
}

let _cache = new Map();        // KEY -> value
let _lastSync = 0;
let _client = null;
let _status = { source: 'none', count: 0, lastSync: null, error: null };

// ── bootstrap credential ─────────────────────────────────────────────────────
// Read from the environment first. A DPAPI-protected file is supported as a
// convenience on Windows, but the env var is the recommended location.

/**
 * A user-scoped variable, whether or not this process inherited it.
 *
 * `setx` writes to HKCU\Environment, and only shells started AFTER that see the
 * value. A process launched from an older shell - a scheduled task, an assistant
 * session, anything long-lived - inherits an environment from before the setx and
 * silently lacks the variable. That is exactly how the agent can lose its Bitwarden
 * bootstrap: BWS_ACCESS_TOKEN set user-scoped and present in an interactive shell,
 * absent in the shell that restarted the agent, so no secrets sync and every
 * secret-backed feature reports "not configured" on a machine where nothing about
 * the configuration actually changed.
 *
 * So on Windows, when a bootstrap name is missing from process.env, ask the
 * registry directly. Read-once-per-name: these values change rarely and a restart
 * is already the way every other config change lands. Never throws - a machine
 * without `reg` or without the value just returns ''.
 */
const _userEnv = new Map();
function envOrUser(name) {
  if (process.env[name]) return process.env[name].trim();
  if (process.platform !== 'win32') return '';
  if (_userEnv.has(name)) return _userEnv.get(name);
  let value = '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name],
                             { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m);
    if (m) value = m[1].trim();
  } catch { /* not set at user scope either */ }
  _userEnv.set(name, value);
  return value;
}

function accessToken() {
  const fromEnv = envOrUser('BWS_ACCESS_TOKEN');
  if (fromEnv) return fromEnv;
  const tokenFile = process.env.BWS_ACCESS_TOKEN_FILE
    || path.join(os.homedir(), '.isconl', 'bws-access-token');
  try {
    if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch { /* fall through */ }
  return '';
}

function organizationId() {
  return envOrUser('BWS_ORGANIZATION_ID');
}

// ── offline cache (encrypted at rest) ────────────────────────────────────────
function cacheKey(token) {
  return crypto.createHash('sha256').update('isconl-secrets-cache|' + token).digest();
}

function writeCache(map, token) {
  if (!token) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', cacheKey(token), iv);
    const body = Buffer.concat([c.update(JSON.stringify([...map]), 'utf8'), c.final()]);
    fs.writeFileSync(CACHE_FILE, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
  } catch (e) { /* cache is best-effort, never fatal */ }
}

function readCache(token) {
  if (!token || !fs.existsSync(CACHE_FILE)) return null;
  try {
    const raw = fs.readFileSync(CACHE_FILE);
    const d = crypto.createDecipheriv('aes-256-gcm', cacheKey(token), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    return new Map(JSON.parse(json));
  } catch { return null; }   // wrong token or tampered file -> treat as absent
}

// ── Bitwarden ────────────────────────────────────────────────────────────────
async function getClient(token) {
  if (_client) return _client;
  resolveEndpoints();
  const { BitwardenClient, DeviceType } = require('@bitwarden/sdk-napi');
  const client = new BitwardenClient({
    apiUrl: API_URL,
    identityUrl: IDENTITY_URL,
    userAgent: 'isconl-vault',
    deviceType: DeviceType.SDK,
  });
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  await client.auth().loginAccessToken(token, STATE_FILE);
  _client = client;
  return client;
}

/**
 * Pull every secret the machine account can see into the in-memory map.
 * Secret KEYS become the env-var names the rest of the agent reads.
 */
async function syncFromBitwarden({ force = false } = {}) {
  const token = accessToken();
  if (!token) {
    _status = { ..._status, source: _cache.size ? _status.source : 'none',
                error: 'BWS_ACCESS_TOKEN not set' };
    return false;
  }
  if (!force && Date.now() - _lastSync < REFRESH_MS) return true;

  const orgId = organizationId();
  if (!orgId) {
    _status = { ..._status, error: 'BWS_ORGANIZATION_ID not set' };
    return false;
  }

  try {
    const client = await getClient(token);
    const listed = await client.secrets().list(orgId);
    const ids = (listed?.data || []).map(s => s.id);
    if (!ids.length) {
      _status = { source: 'bitwarden', count: 0, lastSync: new Date().toISOString(), error: null };
      _lastSync = Date.now();
      return true;
    }
    const full = await client.secrets().getByIds(ids);
    const next = new Map();
    for (const s of (full?.data || [])) {
      if (s?.key) next.set(String(s.key).trim(), s.value ?? '');
    }
    _cache = next;
    _lastSync = Date.now();
    writeCache(next, token);
    _status = { source: 'bitwarden', count: next.size, lastSync: new Date().toISOString(), error: null };
    return true;
  } catch (e) {
    // Offline or unreachable - fall back to the encrypted cache rather than dying.
    const cached = readCache(token);
    if (cached && cached.size) {
      _cache = cached;
      _status = { source: 'offline-cache', count: cached.size,
                  lastSync: _status.lastSync, error: String(e.message || e).split('\n')[0] };
      return true;
    }
    _status = { ..._status, error: String(e.message || e).split('\n')[0] };
    return false;
  }
}

/**
 * Read the VAULT's value, ignoring process.env entirely.
 *
 * get() lets an explicit env var win, which is right almost everywhere - an
 * operator override should beat the store. But when the override is malformed
 * the caller may need the authoritative copy to fall back to: an invalid TOTP
 * seed in the environment can lock an operator out of a deploy target while a
 * perfectly good seed sits in Bitwarden, unreachable through get().
 */
function fromVault(name) {
  if (_cache.has(name)) return _cache.get(name);
  const prefixed = SECRET_PREFIX + name;
  if (_cache.has(prefixed)) return _cache.get(prefixed);
  return '';
}

/** Resolve one secret by name, honouring the app prefix. Never throws. */
function get(name, fallback = '') {
  if (process.env[name]) return process.env[name];      // explicit override wins
  if (_cache.has(name)) return _cache.get(name);
  const prefixed = SECRET_PREFIX + name;                // GEMINI_API_KEY -> ISCONL_GEMINI_API_KEY
  if (_cache.has(prefixed)) return _cache.get(prefixed);
  if (process.env[prefixed]) return process.env[prefixed];
  return fallback;
}

// Secrets may be namespaced per app in a shared vault, e.g. ISCONL_GEMINI_API_KEY
// alongside KEYVANOS_JWT_SECRET. The app reads the plain name (GEMINI_API_KEY),
// so a secret carrying this app's prefix is also exposed under its bare name.
// An explicitly-set bare secret always wins over a prefixed alias.
const SECRET_PREFIX = (process.env.ISCONL_SECRET_PREFIX || 'ISCONL_').toUpperCase();

// Names that are genuinely the agent's own, not prefixed copies of something else.
const PREFIX_EXEMPT = new Set(['ISCONL_TOKEN', 'ISCONL_PORT', 'ISCONL_BIND',
  'ISCONL_ALLOWED_ORIGINS', 'ISCONL_SECRET_REFRESH_MS', 'ISCONL_SECRET_PREFIX']);

function aliasFor(name) {
  if (!SECRET_PREFIX || PREFIX_EXEMPT.has(name)) return null;
  if (!name.startsWith(SECRET_PREFIX)) return null;
  const bare = name.slice(SECRET_PREFIX.length);
  return bare.length > 1 ? bare : null;
}

/** Apply resolved secrets onto process.env without clobbering explicit overrides. */
function applyToEnv() {
  let applied = 0;
  // Bare names first, so they take precedence over any prefixed alias.
  for (const [k, v] of _cache) {
    if (!aliasFor(k) && !process.env[k] && v) { process.env[k] = v; applied++; }
  }
  for (const [k, v] of _cache) {
    const bare = aliasFor(k);
    if (!bare || !v) continue;
    if (!process.env[k]) { process.env[k] = v; applied++; }
    if (!process.env[bare] && !_cache.has(bare)) { process.env[bare] = v; applied++; }
  }
  return applied;
}

/**
 * Create or update a secret in Bitwarden so it survives beyond this machine.
 * Used for credentials the agent itself obtains at runtime (OAuth refresh
 * tokens), which would otherwise only ever live in a local .env.
 *
 * Requires the machine account to have WRITE on the project - a read-only
 * account returns a permission error, which we surface rather than swallow.
 */
async function persistSecret(name, value, note = 'Written by isconl-vault') {
  if (!value) return { ok: false, error: 'no value to store' };
  const token = accessToken();
  const orgId = organizationId();
  const projectId = envOrUser('BWS_PROJECT_ID');
  if (!token || !orgId) return { ok: false, error: 'Bitwarden not configured' };
  if (!projectId) return { ok: false, error: 'BWS_PROJECT_ID not set' };

  try {
    const client = await getClient(token);
    // Update in place if it already exists, otherwise create.
    let existingId = null;
    const listed = await client.secrets().list(orgId);
    const ids = (listed?.data || []).map(s => s.id);
    if (ids.length) {
      const full = await client.secrets().getByIds(ids);
      const hit = (full?.data || []).find(s => s.key === name);
      if (hit) existingId = hit.id;
    }

    if (existingId) {
      // SDK signature is (organizationId, id, ...) -- pass in that order, or
      // every update 404s with the org id being read as the secret id.
      await client.secrets().update(orgId, existingId, name, value, note, [projectId]);
    } else {
      await client.secrets().create(orgId, name, value, note, [projectId]);
    }
    _cache.set(name, value);
    writeCache(_cache, token);
    return { ok: true, created: !existingId };
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0] };
  }
}

/** Non-sensitive status for the dashboard. Never returns values. */
function status() {
  return {
    ..._status,
    configured: !!accessToken() && !!organizationId(),
    refreshMs: REFRESH_MS,
    keys: [..._cache.keys()].sort(),      // names only, never values
  };
}

/** Boot: pull once, apply, then keep refreshing so secrets stay current. */
async function init({ startRefreshLoop = true } = {}) {
  await syncFromBitwarden({ force: true });
  const applied = applyToEnv();
  if (startRefreshLoop && accessToken() && organizationId()) {
    const t = setInterval(async () => {
      if (await syncFromBitwarden({ force: true })) applyToEnv();
    }, REFRESH_MS);
    if (t.unref) t.unref();   // never hold the process open
  }
  return { applied, ...status() };
}

module.exports = { init, get, fromVault, status, persistSecret, syncFromBitwarden, applyToEnv, accessToken, organizationId };
