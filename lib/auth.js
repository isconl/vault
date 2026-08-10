'use strict';
/**
 * Authentication: static token, TOTP (RFC 6238, Ente Auth-compatible), PIN,
 * and session issuance/validation.
 *
 * Ported from isconl-agent's server.js, where this lived as module-level
 * globals resolved after the secret store loaded. Restructured into a
 * factory (createAuthModule) so config is injected explicitly -- important
 * now that this runs as its own service other engines call into, rather
 * than sharing one process's globals with everything else.
 *
 * Every security property from the original is preserved verbatim:
 * fail-closed with no credential configured, timing-safe comparisons
 * throughout, three SEPARATE lockout buckets (data-route / TOTP-login /
 * PIN-login) so a PIN guesser can never freeze the TOTP door, an escalating
 * PIN lockout, and proxy-aware IP resolution that only trusts
 * X-Forwarded-For when explicitly told to.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_DRIFT_STEPS = 1;   // one step either side: phone/server clocks are rarely identical
const PIN_SALT = 'isconl-pin-v1:';
const PIN_MIN_DIGITS = 4;
const PIN_MAX_DIGITS = 12;
const MAX_FAILURES = 8;
const LOCKOUT_MS = 5 * 60 * 1000;
const PIN_MAX_FAILURES = 5;
const PIN_LOCKOUT_BASE_MS = 15 * 60 * 1000;
const PIN_LOCKOUT_MAX_MS = 60 * 60 * 1000;

// Timing-safe comparison so a credential cannot be recovered byte-by-byte.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);   // still burn a comparison to keep timing flat
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function totpSeedUsable(raw) {
  const clean = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (clean.length < 16) return false;
  return !/[^A-Z2-7=]/.test(clean);
}

function base32Decode(input) {
  const clean = String(input).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('TOTP secret is not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
            | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function pinDigest(pin) {
  return crypto.createHash('sha256').update(PIN_SALT + String(pin)).digest('hex');
}

/**
 * @param {object} opts
 * @param {() => string} [opts.getAuthToken] - resolve the current static bearer token
 * @param {() => string} [opts.getTotpSecret] - resolve the current base32 TOTP seed
 * @param {() => string} [opts.getPinDigest] - resolve the current PIN's sha256 digest ('' = PIN login disabled)
 * @param {string} opts.sessionFile - where sessions persist across restarts (gitignored, local-only)
 * @param {number} [opts.sessionTtlMs=12h]
 * @param {number} [opts.pinSessionTtlMs=8h] - a weaker credential buys a shorter session
 * @param {boolean} [opts.trustProxy=false] - honour X-Forwarded-For (only when a real proxy sits in front)
 * @param {{log: Function}} [opts.auditLog] - optional; auth events are logged if provided
 */
function createAuthModule(opts) {
  const {
    getAuthToken = () => '',
    getTotpSecret = () => '',
    getPinDigest = () => '',
    sessionFile,
    sessionTtlMs = 12 * 60 * 60 * 1000,
    pinSessionTtlMs = 8 * 60 * 60 * 1000,
    trustProxy = false,
    auditLog = { log: () => {} },
  } = opts;
  if (!sessionFile) throw new Error('createAuthModule requires sessionFile');

  // -- TOTP: replay protection --------------------------------------------------
  const usedTotpSteps = new Map(); // step -> expiry ms
  function pruneUsedSteps() {
    const now = Date.now();
    for (const [s, exp] of usedTotpSteps) if (exp < now) usedTotpSteps.delete(s);
  }

  function verifyTotp(code) {
    const TOTP_SECRET = getTotpSecret();
    if (!TOTP_SECRET) return { ok: false, reason: 'TOTP not configured' };
    const clean = String(code || '').replace(/\D/g, '');
    if (clean.length !== TOTP_DIGITS) return { ok: false, reason: `code must be ${TOTP_DIGITS} digits` };

    let secretBuf;
    try { secretBuf = base32Decode(TOTP_SECRET); }
    catch (e) { return { ok: false, reason: e.message }; }

    pruneUsedSteps();
    const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    let matchedStep = null;
    for (let d = -TOTP_DRIFT_STEPS; d <= TOTP_DRIFT_STEPS; d++) {
      const candidate = totpAt(secretBuf, step + d);
      if (safeEqual(candidate, clean) && matchedStep === null) matchedStep = step + d;
    }
    if (matchedStep === null) return { ok: false, reason: 'invalid code' };
    if (usedTotpSteps.has(matchedStep)) return { ok: false, reason: 'code already used' };

    usedTotpSteps.set(matchedStep, Date.now() + (TOTP_STEP_SECONDS * (TOTP_DRIFT_STEPS + 2) * 1000));
    return { ok: true, step: matchedStep };
  }

  function verifyPin(pin) {
    const PIN_DIGEST = getPinDigest();
    if (!PIN_DIGEST) return { ok: false, reason: 'PIN not configured' };
    const clean = String(pin || '').replace(/\D/g, '');
    if (clean.length < PIN_MIN_DIGITS || clean.length > PIN_MAX_DIGITS) {
      return { ok: false, reason: 'wrong length' };
    }
    if (!safeEqual(pinDigest(clean), PIN_DIGEST)) return { ok: false, reason: 'invalid pin' };
    return { ok: true };
  }

  /** Which login methods are actually configured right now, for the pre-login
   *  client to ask before it has any credential to offer. Mirrors the same
   *  checks verifyTotp/verifyPin already gate on, not a separate capability list
   *  that could drift from what actually works. */
  function methods() {
    return { totp: !!getTotpSecret(), pin: !!getPinDigest() };
  }

  // -- Sessions ------------------------------------------------------------------
  let sessions = new Map(); // token -> expiry ms

  function loadSessions() {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      const now = Date.now();
      sessions = new Map(Object.entries(raw).filter(([, exp]) => exp > now));
    } catch { sessions = new Map(); }
  }
  loadSessions();

  function saveSessions() {
    try {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    } catch (e) { /* a lost session is an inconvenience, not a failure */ }
  }

  function pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [t, exp] of sessions) if (exp < now) { sessions.delete(t); changed = true; }
    if (changed) saveSessions();
  }

  function issueSession(ttlMs = sessionTtlMs) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + Math.max(60 * 1000, Number(ttlMs) || sessionTtlMs);
    sessions.set(token, expiresAt);
    saveSessions();
    return { token, expiresAt };
  }

  function validSession(token) {
    if (!token) return false;
    pruneSessions();
    // Timing-safe scan: compare against every live session rather than Map.has,
    // so presence is not distinguishable by response time.
    let hit = false;
    for (const [t, exp] of sessions) if (safeEqual(t, token) && exp > Date.now()) hit = true;
    return hit;
  }

  // -- Lockout buckets: deliberately THREE separate ones -------------------------
  // A dashboard tab polling with a dead token must never share a bucket with the
  // login route (or it locks out the legitimate user for most of every hour --
  // this happened for real, see server.js history); a PIN guesser must never be
  // able to freeze the TOTP door either. So: data-route failures, TOTP-submission
  // failures, and PIN-submission failures each get their own independent bucket.
  const authFailures = new Map();   // ip -> { count, until } -- data-route failures (authenticate())
  const loginFailures = new Map();  // ip -> { count, until } -- failed TOTP code submissions only
  const pinFailures = new Map();    // ip -> { count, until } -- failed PIN submissions only

  function clientIp(req) {
    const direct = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!trustProxy) return direct;
    const xff = req.headers['x-forwarded-for'];
    if (!xff) return direct;
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : direct;
  }

  /**
   * Pure decision function: does this request carry a valid credential?
   * No HTTP side effects -- callers (checkAuth below, or a remote hub) decide
   * what to do with the result.
   */
  function authenticate(req) {
    const ip = clientIp(req);
    const rec = authFailures.get(ip);
    const AUTH_TOKEN = getAuthToken();
    const TOTP_SECRET = getTotpSecret();
    const PIN_DIGEST = getPinDigest();

    // FAIL CLOSED. No credential configured at all -> no way to authenticate,
    // ever, even on loopback. An unprotected vault is never an acceptable default.
    if (!AUTH_TOKEN && !TOTP_SECRET && !PIN_DIGEST) {
      auditLog.log('auth_refused_no_token_configured', { ip, path: req.url });
      return { ok: false, ip, reason: 'not_configured' };
    }

    const header = req.headers['authorization'] || '';
    const presented = header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : (req.headers['x-isconl-token'] || req.headers['x-vault-token'] || '').trim();

    // A VALID credential is honoured even mid-lockout: both are long random
    // strings, so evaluating during lockout gives a brute-forcer nothing, but a
    // stale tab hammering the API can never block a session just minted at login.
    if (presented && AUTH_TOKEN && safeEqual(presented, AUTH_TOKEN)) {
      authFailures.delete(ip);
      return { ok: true, ip, via: 'static_token' };
    }
    if (presented && validSession(presented)) {
      authFailures.delete(ip);
      return { ok: true, ip, via: 'session' };
    }

    if (rec && rec.until > Date.now()) return { ok: false, ip, reason: 'locked_out' };

    const count = (rec?.count || 0) + 1;
    authFailures.set(ip, {
      count,
      until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0,
    });
    auditLog.log('auth_failed', { ip, path: req.url, attempt: count });
    return { ok: false, ip, reason: 'invalid_credential' };
  }

  // -- TOTP login-route lockout (separate from authenticate()'s data-route bucket) --
  // Flat, not escalating: same MAX_FAILURES/LOCKOUT_MS as authFailures, but its
  // own Map so stale-session polling on data routes can never lock the login
  // screen itself (this exact failure mode locked the sole legitimate user out
  // for 5 of every 6 minutes before the buckets were split).
  function checkLoginLockout(ip) {
    const rec = loginFailures.get(ip);
    if (rec && rec.until > Date.now()) return { locked: true, retryAfterMs: rec.until - Date.now() };
    return { locked: false, retryAfterMs: 0 };
  }
  function recordLoginFailure(ip) {
    const rec = loginFailures.get(ip);
    const count = (rec?.count || 0) + 1;
    loginFailures.set(ip, { count, until: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 });
    return count;
  }
  /** A real TOTP login clears both buckets: proven identity outweighs residual stale-tab noise on data routes. */
  function clearLoginFailures(ip) { loginFailures.delete(ip); authFailures.delete(ip); }

  // -- PIN login-route lockout: its own bucket, escalating freeze ----------------
  // Freezes only once a WHOLE budget (PIN_MAX_FAILURES tries) is spent, and each
  // round the freeze is longer: round 1 = 15min, round 2 = 30min, round 3 = 45min,
  // round 4+ capped at 60min. Between rounds (e.g. attempts 6-9 after the first
  // freeze already lifted) the PREVIOUS until value carries forward rather than
  // resetting -- exact port of the original count/PIN_MAX_FAILURES modulo logic.
  function checkPinLockout(ip) {
    const rec = pinFailures.get(ip);
    if (rec && rec.until > Date.now()) return { locked: true, retryAfterMs: rec.until - Date.now() };
    return { locked: false, retryAfterMs: 0 };
  }
  function recordPinFailure(ip) {
    const rec = pinFailures.get(ip);
    const count = (rec?.count || 0) + 1;
    const rounds = Math.floor(count / PIN_MAX_FAILURES);
    const until = (count % PIN_MAX_FAILURES === 0)
      ? Date.now() + Math.min(PIN_LOCKOUT_BASE_MS * rounds, PIN_LOCKOUT_MAX_MS)
      : (rec?.until || 0);
    pinFailures.set(ip, { count, until });
    return { count, attemptsLeft: Math.max(0, PIN_MAX_FAILURES - (count % PIN_MAX_FAILURES || PIN_MAX_FAILURES)) };
  }
  /** A PIN login clears only its own bucket -- not proof enough to forgive API-route failures too. */
  function clearPinFailures(ip) { pinFailures.delete(ip); }

  /** HTTP-shaped convenience wrapper matching the original server.js call site: writes a silent 404 on failure. */
  function checkAuth(req, res) {
    const result = authenticate(req);
    if (result.ok) return true;
    // Silent 404, never 401 -- an unauthenticated caller learns nothing about
    // whether this service exists or what it is.
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return false;
  }

  function isAllowedOrigin(origin, allowedOriginsEnv = process.env.ISCONL_ALLOWED_ORIGINS || '') {
    const allow = allowedOriginsEnv.split(',').map(s => s.trim()).filter(Boolean);
    if (allow.includes(origin)) return true;
    try {
      const h = new URL(origin).hostname;
      return ['127.0.0.1', 'localhost', '::1'].includes(h);
    } catch { return false; }
  }

  return {
    // credential checks
    verifyTotp, verifyPin, totpSeedUsable, pinDigest, methods,
    // sessions
    issueSession, validSession,
    // request-level
    authenticate, checkAuth, clientIp, isAllowedOrigin, safeEqual,
    // TOTP-submission lockout (separate from the general authenticate() bucket)
    checkLoginLockout, recordLoginFailure, clearLoginFailures,
    // PIN-submission lockout (separate from both of the above)
    checkPinLockout, recordPinFailure, clearPinFailures,
    constants: { PIN_MIN_DIGITS, PIN_MAX_DIGITS, TOTP_DIGITS, MAX_FAILURES, LOCKOUT_MS, PIN_MAX_FAILURES },
  };
}

module.exports = { createAuthModule, safeEqual, totpSeedUsable, pinDigest };
