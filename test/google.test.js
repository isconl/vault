'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleClient, googleTokenExpired } = require('../lib/google');

test('googleTokenExpired: true for missing token, false when tokenExpiresAt is well in the future, true once past it minus the margin', () => {
  assert.equal(googleTokenExpired({}), true);
  assert.equal(googleTokenExpired({ accessToken: 'x', tokenExpiresAt: Date.now() + 3600000 }), false);
  assert.equal(googleTokenExpired({ accessToken: 'x', tokenExpiresAt: Date.now() + 60000 }, 120), true, '60s left with a 120s margin should read as expired');
});

function makeClient({ httpsRequestFn, onTokenRefreshed } = {}) {
  let config = { clientId: 'cid', clientSecret: 'csecret', accessToken: '', refreshToken: '', tokenExpiresAt: 0 };
  const calls = [];
  const client = createGoogleClient({
    getConfig: () => config,
    setConfig: (patch) => { config = { ...config, ...patch }; },
    minGapMs: 0,
    httpsRequestFn: async (options, body) => {
      calls.push({ options, body });
      return (httpsRequestFn || (async () => ({ status: 200, data: {} })))(options, body, calls.length);
    },
    ...(onTokenRefreshed ? { onTokenRefreshed } : {}),
  });
  return { client, calls, getConfig: () => config };
}

test('getValidToken() reuses a valid cached access token without calling out at all', async () => {
  const { client, calls, getConfig } = makeClient();
  getConfig().accessToken = 'tok';
  getConfig().tokenExpiresAt = Date.now() + 3600000;
  const token = await client.getValidToken();
  assert.equal(token, 'tok');
  assert.equal(calls.length, 0);
});

test('getValidToken() refreshes via oauth2.googleapis.com/token, client_secret included (Google requires it, unlike MS)', async () => {
  const { client, calls, getConfig } = makeClient({
    httpsRequestFn: async () => ({ status: 200, data: { access_token: 'new-tok', refresh_token: 'new-refresh', expires_in: 3600 } }),
  });
  getConfig().refreshToken = 'old-refresh';
  const token = await client.getValidToken();
  assert.equal(token, 'new-tok');
  assert.equal(calls[0].options.hostname, 'oauth2.googleapis.com');
  assert.equal(calls[0].options.path, '/token');
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get('client_secret'), 'csecret');
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(getConfig().refreshToken, 'new-refresh');
  assert.ok(getConfig().tokenExpiresAt > Date.now());
});

test('getValidToken() keeps the existing refresh token when Google does not rotate it', async () => {
  const { client, getConfig } = makeClient({
    httpsRequestFn: async () => ({ status: 200, data: { access_token: 'new-tok', expires_in: 3600 } }), // no refresh_token in response
  });
  getConfig().refreshToken = 'stays-the-same';
  await client.getValidToken();
  assert.equal(getConfig().refreshToken, 'stays-the-same');
});

test('getValidToken() returns null and clears the dead access token when refresh fails with no error thrown', async () => {
  const { client, getConfig } = makeClient({
    httpsRequestFn: async () => ({ status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }),
  });
  getConfig().accessToken = 'stale';
  getConfig().tokenExpiresAt = Date.now() - 1000;
  getConfig().refreshToken = 'dead-refresh';
  const token = await client.getValidToken();
  assert.equal(token, null);
  assert.equal(getConfig().accessToken, '');
});

test('googleRequest() sends a bearer token and reaches the given host/path', async () => {
  const { client, calls, getConfig } = makeClient({
    httpsRequestFn: async (options) => {
      if (options.path === '/token') return { status: 200, data: { access_token: 'tok', expires_in: 3600 } };
      return { status: 200, data: { messages: [] } };
    },
  });
  getConfig().refreshToken = 'r';
  const res = await client.googleRequest('gmail.googleapis.com', '/gmail/v1/users/me/messages');
  assert.equal(res.status, 200);
  const apiCall = calls.find(c => c.options.hostname === 'gmail.googleapis.com');
  assert.equal(apiCall.options.path, '/gmail/v1/users/me/messages');
  assert.equal(apiCall.options.headers.Authorization, 'Bearer tok');
});

test('googleRequest() with no token at all returns 401 without any network call', async () => {
  const { client, calls } = makeClient();
  const res = await client.googleRequest('gmail.googleapis.com', '/gmail/v1/users/me/messages');
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('googleRequest() retries once on a 401 by forcing a fresh token', async () => {
  let apiCallCount = 0;
  const { client, getConfig } = makeClient({
    httpsRequestFn: async (options) => {
      if (options.path === '/token') return { status: 200, data: { access_token: `tok-${Date.now()}-${Math.random()}`, expires_in: 3600 } };
      apiCallCount++;
      return apiCallCount === 1 ? { status: 401, data: { error: 'invalid_token' } } : { status: 200, data: { ok: true } };
    },
  });
  getConfig().accessToken = 'stale-but-not-marked-expired';
  getConfig().tokenExpiresAt = Date.now() + 3600000; // looks fresh, so the FIRST call skips refresh and hits the API directly
  getConfig().refreshToken = 'r';
  const res = await client.googleRequest('gmail.googleapis.com', '/gmail/v1/users/me/messages');
  assert.equal(res.status, 200);
  assert.equal(apiCallCount, 2);
});

test('buildAuthUrl() returns a Google auth URL carrying PKCE challenge + the full Gmail+Calendar scope string, and stashes the verifier/state on config', () => {
  const { client, getConfig } = makeClient();
  const { url, state } = client.buildAuthUrl({ redirectUri: 'http://127.0.0.1:8081/google/auth/callback' });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'accounts.google.com');
  assert.match(parsed.searchParams.get('scope'), /gmail\.readonly/);
  assert.match(parsed.searchParams.get('scope'), /gmail\.send/);
  assert.match(parsed.searchParams.get('scope'), /calendar\.readonly/);
  assert.match(parsed.searchParams.get('scope'), /calendar\.events/);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('state'), state);
  assert.equal(getConfig().pendingAuth.state, state);
  assert.ok(getConfig().pendingAuth.codeVerifier);
});

test('exchangeCode() persists the token and reports success once Google returns an access_token', async () => {
  const { client, getConfig } = makeClient({
    httpsRequestFn: async () => ({ status: 200, data: { access_token: 'tok', refresh_token: 'refresh', expires_in: 3600 } }),
  });
  const { state } = client.buildAuthUrl({ redirectUri: 'http://127.0.0.1:8081/google/auth/callback' });
  const r = await client.exchangeCode({ code: 'auth-code-123', state });
  assert.equal(r.success, true);
  assert.equal(getConfig().accessToken, 'tok');
  assert.equal(getConfig().refreshToken, 'refresh');
  assert.equal(getConfig().pendingAuth, null);
});

test('exchangeCode() rejects a state that does not match the in-flight sign-in, without making a network call', async () => {
  const { client, calls } = makeClient({
    httpsRequestFn: async () => ({ status: 200, data: { access_token: 'tok', refresh_token: 'refresh', expires_in: 3600 } }),
  });
  client.buildAuthUrl({ redirectUri: 'http://127.0.0.1:8081/google/auth/callback' });
  const r = await client.exchangeCode({ code: 'auth-code-123', state: 'not-the-real-state' });
  assert.equal(r.success, false);
  assert.equal(r.data.error, 'state_mismatch');
  assert.equal(calls.length, 0);
});

test('onTokenRefreshed is awaited and a persistence failure does not throw out of exchangeCode', async () => {
  const { client } = makeClient({
    httpsRequestFn: async () => ({ status: 200, data: { access_token: 'tok', refresh_token: 'refresh', expires_in: 3600 } }),
    onTokenRefreshed: async () => { throw new Error('bitwarden write failed'); },
  });
  const { state } = client.buildAuthUrl({ redirectUri: 'http://127.0.0.1:8081/google/auth/callback' });
  const r = await client.exchangeCode({ code: 'auth-code-123', state });
  assert.equal(r.success, true);
});
