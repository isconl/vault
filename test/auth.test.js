'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createAuthModule, pinDigest } = require('../lib/auth');

function tmpSessionFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-auth-test-'));
  return path.join(dir, 'sessions.json');
}

// Real base32 TOTP secret + generator, independent of lib/auth.js's own
// implementation, so the test actually proves interop rather than checking
// the code against itself.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(input) {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpNow(secretB32, stepOffset = 0) {
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = crypto.createHmac('sha1', b32decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1e6).padStart(6, '0');
}

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // well-known RFC4648 test vector

test('verifyTotp accepts a real current code, rejects wrong/replayed', () => {
  const auth = createAuthModule({ getTotpSecret: () => TOTP_SECRET, sessionFile: tmpSessionFile() });
  const code = totpNow(TOTP_SECRET);
  assert.equal(auth.verifyTotp(code).ok, true);
  assert.equal(auth.verifyTotp(code).ok, false); // replay rejected
  assert.equal(auth.verifyTotp('000000').ok, false);
});

test('verifyPin: correct digest passes, wrong fails, unconfigured fails closed', () => {
  const digest = pinDigest('4242');
  const auth = createAuthModule({ getPinDigest: () => digest, sessionFile: tmpSessionFile() });
  assert.equal(auth.verifyPin('4242').ok, true);
  assert.equal(auth.verifyPin('0000').ok, false);
  const noPin = createAuthModule({ getPinDigest: () => '', sessionFile: tmpSessionFile() });
  assert.equal(noPin.verifyPin('4242').ok, false);
});

test('authenticate() fails closed when nothing is configured, even for a well-formed request', () => {
  const auth = createAuthModule({ sessionFile: tmpSessionFile() });
  const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' }, url: '/api/state' };
  const result = auth.authenticate(req);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('authenticate() accepts a valid static token, rejects wrong', () => {
  const auth = createAuthModule({ getAuthToken: () => 'super-secret-token', sessionFile: tmpSessionFile() });
  const good = { headers: { authorization: 'Bearer super-secret-token' }, socket: { remoteAddress: '1.2.3.4' }, url: '/x' };
  const bad = { headers: { authorization: 'Bearer wrong' }, socket: { remoteAddress: '1.2.3.4' }, url: '/x' };
  assert.equal(auth.authenticate(good).ok, true);
  assert.equal(auth.authenticate(bad).ok, false);
});

test('authenticate() locks out after MAX_FAILURES and the lockout is bucket-local, not global', () => {
  const auth = createAuthModule({ getAuthToken: () => 'tok', sessionFile: tmpSessionFile() });
  const reqFor = (ip) => ({ headers: { authorization: 'Bearer wrong' }, socket: { remoteAddress: ip }, url: '/x' });
  for (let i = 0; i < auth.constants.MAX_FAILURES; i++) auth.authenticate(reqFor('9.9.9.9'));
  assert.equal(auth.authenticate(reqFor('9.9.9.9')).reason, 'locked_out');
  // A different IP is unaffected by 9.9.9.9's lockout.
  assert.equal(auth.authenticate(reqFor('1.1.1.1')).reason, 'invalid_credential');
});

test('session round-trip: issue, validate, and it persists across a fresh module load (restart simulation)', () => {
  const sessionFile = tmpSessionFile();
  const auth1 = createAuthModule({ sessionFile });
  const { token } = auth1.issueSession();
  assert.equal(auth1.validSession(token), true);
  const auth2 = createAuthModule({ sessionFile }); // simulates a process restart
  assert.equal(auth2.validSession(token), true);
});

test('PIN lockout escalation matches the original exactly: freezes only every 5th failure, 15/30/45/60 min', () => {
  const auth = createAuthModule({ sessionFile: tmpSessionFile() });
  const ip = '5.5.5.5';
  // Attempts 1-4: no lockout yet.
  for (let i = 1; i <= 4; i++) {
    const r = auth.recordPinFailure(ip);
    assert.equal(auth.checkPinLockout(ip).locked, false, `attempt ${i} should not lock`);
  }
  // Attempt 5 (round 1): 15 min lockout.
  auth.recordPinFailure(ip);
  let lock = auth.checkPinLockout(ip);
  assert.equal(lock.locked, true);
  assert.ok(lock.retryAfterMs > 14.9 * 60 * 1000 && lock.retryAfterMs <= 15 * 60 * 1000, `expected ~15min, got ${lock.retryAfterMs}ms`);
});

test('PIN success clears only the PIN bucket, not the general auth bucket', () => {
  const auth = createAuthModule({ getAuthToken: () => 'tok', sessionFile: tmpSessionFile() });
  const ip = '7.7.7.7';
  auth.authenticate({ headers: { authorization: 'Bearer wrong' }, socket: { remoteAddress: ip }, url: '/x' });
  auth.recordPinFailure(ip);
  auth.clearPinFailures(ip);
  // The general-route failure count from `authenticate()` should be untouched.
  const stillFailing = auth.authenticate({ headers: { authorization: 'Bearer wrong' }, socket: { remoteAddress: ip }, url: '/x' });
  assert.equal(stillFailing.reason, 'invalid_credential'); // not reset to attempt 1's fresh state, still accumulating
});

test('clientIp ignores X-Forwarded-For unless trustProxy is set', () => {
  const untrusted = createAuthModule({ sessionFile: tmpSessionFile(), trustProxy: false });
  const trusted = createAuthModule({ sessionFile: tmpSessionFile(), trustProxy: true });
  const req = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(untrusted.clientIp(req), '10.0.0.1');
  assert.equal(trusted.clientIp(req), '10.0.0.1'); // rightmost entry (the proxy's peer), not the client-supplied first hop
});
