'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createGraphClient, msGraphTokenExpired, httpsRequest } = require('../lib/graph');

function fakeJwt(expiresInSeconds) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url({ alg: 'none' });
  const payload = b64url({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds });
  return `${header}.${payload}.sig`;
}

test('msGraphTokenExpired: true for missing token, false for a fresh JWT, true for an expired one', () => {
  assert.equal(msGraphTokenExpired(''), true);
  assert.equal(msGraphTokenExpired(fakeJwt(3600)), false);
  assert.equal(msGraphTokenExpired(fakeJwt(-10)), true);
});

test('msGraphTokenExpired treats an opaque (non-JWT) token as not-expired, deferring to a 401', () => {
  assert.equal(msGraphTokenExpired('opaque-token-no-dots'), false);
});

test('msGraphTokenExpired respects the safety margin', () => {
  assert.equal(msGraphTokenExpired(fakeJwt(60), 120), true, '60s left with a 120s margin should read as expired');
  assert.equal(msGraphTokenExpired(fakeJwt(200), 120), false);
});

function makeClient(overrides = {}) {
  let config = { clientId: '', clientSecret: '', accessToken: '', refreshToken: '' };
  const calls = [];
  const client = createGraphClient({
    getConfig: () => config,
    setConfig: (patch) => { config = { ...config, ...patch }; },
    minGapMs: 0,   // no need to actually wait in tests
    httpsRequestFn: async (options, body) => {
      calls.push({ options, body });
      return (overrides.httpsRequestFn || (async () => ({ status: 200, data: {} })))(options, body, calls.length);
    },
    ...overrides,
  });
  return { client, calls, getConfig: () => config };
}

test('getValidToken() reuses a valid cached access token without calling out at all', async () => {
  const { client, calls, getConfig } = makeClient();
  getConfig().accessToken = fakeJwt(3600);
  getConfig().refreshToken = 'irrelevant';
  const token = await client.getValidToken();
  assert.equal(token, getConfig().accessToken);
  assert.equal(calls.length, 0, 'a valid cached token must not trigger any network call');
});

test('getValidToken() refreshes when the cached token is expired, and rotates the refresh token', async () => {
  const { client, getConfig } = makeClient({
    httpsRequestFn: async () => ({ status: 200, data: { access_token: 'new-access', refresh_token: 'new-refresh' } }),
  });
  getConfig().accessToken = fakeJwt(-10);
  getConfig().refreshToken = 'old-refresh';
  const token = await client.getValidToken();
  assert.equal(token, 'new-access');
  assert.equal(getConfig().refreshToken, 'new-refresh', 'the rotated refresh token must be persisted into config');
});

test('a failed refresh (no access_token in the response) drops the dead token rather than pretending it still works', async () => {
  const { client, getConfig } = makeClient({
    httpsRequestFn: async () => ({ status: 400, data: { error: 'invalid_grant' } }),
  });
  getConfig().accessToken = fakeJwt(-10);
  getConfig().refreshToken = 'revoked-refresh';
  const token = await client.getValidToken();
  assert.equal(token, null);
  assert.equal(getConfig().accessToken, '', 'a dead token must be cleared so status reporting is honest');
});

test('onTokenRefreshed is called with the new tokens so the caller can persist them (e.g. to Bitwarden)', async () => {
  const persisted = [];
  const { client, getConfig } = makeClient({
    httpsRequestFn: async () => ({ status: 200, data: { access_token: 'A', refresh_token: 'R' } }),
    onTokenRefreshed: async (access, refresh) => { persisted.push({ access, refresh }); },
  });
  getConfig().accessToken = fakeJwt(-10);
  getConfig().refreshToken = 'old';
  await client.getValidToken();
  assert.deepEqual(persisted, [{ access: 'A', refresh: 'R' }]);
});

test('graphRequest retries once on a 401 by forcing a token refresh, then succeeds', async () => {
  let call = 0;
  const { client, getConfig } = makeClient({
    httpsRequestFn: async (options) => {
      call++;
      if (options.hostname === 'login.microsoftonline.com') return { status: 200, data: { access_token: 'fresh', refresh_token: 'fresh-r' } };
      // Graph calls: first one 401s, the retry (with the refreshed token) succeeds.
      if (options.headers.Authorization === 'Bearer stale') return { status: 401, data: { error: { message: 'token expired' } } };
      return { status: 200, data: { value: ['ok'] } };
    },
  });
  getConfig().accessToken = 'stale';   // opaque, so msGraphTokenExpired() alone won't catch it -- the 401 path must
  getConfig().refreshToken = 'r';
  const res = await client.graphRequest('/v1.0/me/drive');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { value: ['ok'] });
});

test('graphRequest with no token at all short-circuits to a clear 401 without any network call', async () => {
  const { client, calls } = makeClient();
  const res = await client.graphRequest('/v1.0/me/drive');
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('graphRequest retries on 429 up to the attempt cap and eventually gives up rather than looping forever', async () => {
  let graphCalls = 0;
  const { client, getConfig } = makeClient({
    httpsRequestFn: async (options) => {
      if (options.hostname === 'graph.microsoft.com') { graphCalls++; return { status: 429, data: {} }; }
      return { status: 200, data: {} };
    },
  });
  getConfig().accessToken = fakeJwt(3600);
  const res = await client.graphRequest('/v1.0/me/drive');
  assert.equal(res.status, 429);
  // 1 initial call + 4 retry attempts = 5 total, then it gives up (not infinite).
  assert.equal(graphCalls, 5);
});

// Found live 17 Aug: a sync pass failed a whole collection with "read
// ECONNRESET" and no retry at all -- graphRequest's own retry loop above
// only fires on an HTTP status it actually got back (429/503/509); a
// connection reset before any response exists never reaches that loop.
// httpsRequest() (the low-level transport, not graphRequest) now retries
// transient socket errors itself. No mock here on purpose -- this is the
// real network path, exercised against a local port nothing is listening
// on, which reliably raises a real ECONNREFUSED (one of the same
// transient codes ECONNRESET belongs to) without depending on an actual
// flaky connection to reproduce.
test('httpsRequest retries a transient connection error (ECONNREFUSED/ECONNRESET-class) before giving up', async () => {
  const start = Date.now();
  await assert.rejects(
    () => httpsRequest({ hostname: '127.0.0.1', port: 1, path: '/', method: 'GET', timeout: 500 }),
    (e) => e.code === 'ECONNREFUSED',
  );
  // 3 attempts with 400ms/800ms backoff between them = at least ~1200ms
  // elapsed if the retry actually happened, not just one immediate failure.
  assert.ok(Date.now() - start >= 1100, 'expected at least two retry waits to have elapsed');
});
