'use strict';
/**
 * Google OAuth (Gmail + Calendar) client -- BI26082005.
 *
 * Mirrors graph.js's shape (pace/token-lifecycle/generic authenticated
 * request helper), but NOT its sign-in flow. That was the original plan --
 * device-code, same as graph.js -- until live verification (24 Aug) hit a
 * hard Google restriction: the device authorization grant only supports a
 * small allowlisted set of scopes (openid/email/profile, drive.appdata,
 * drive.file, youtube[.readonly]) and rejects everything else outright
 * with "Invalid device flow scope" -- Gmail and Calendar scopes are not on
 * that list and never will be (confirmed against Google's own OAuth2
 * device-flow docs, not a config mistake on this fleet's side). Microsoft's
 * device flow has no such scope restriction, which is why graph.js's
 * pattern worked there but can't be reused here as-is.
 *
 * Sign-in here is instead the OAuth2 Authorization Code flow with PKCE
 * (the "native app" flow Google's docs point to for scopes device-flow
 * can't reach), using a loopback redirect (http://127.0.0.1:<vault's own
 * port>/google/auth/callback) that vault/src/server.js hosts directly --
 * no separate callback server needed since vault already listens on an
 * HTTP port. This requires a SEPARATE OAuth client of type "Desktop app"
 * in Cloud Console (the TV/Limited-Input client from the device-flow
 * attempt has no redirect_uris and structurally cannot do this flow --
 * left registered but unused, or delete it, Architect's call).
 *
 * Two other real differences from Microsoft's flow, both Google's own
 * contract, not a design choice here:
 *
 *  - Google's access_token is opaque (not a decodable JWT), so expiry
 *    can't be read back out of the token itself the way
 *    msGraphTokenExpired() does. tokenExpiresAt is tracked explicitly
 *    (Date.now() + expires_in*1000) whenever a token is obtained.
 *  - Google requires client_secret on every token request (auth-code
 *    exchange, refresh) even for this "installed app" flow -- Microsoft's
 *    public-client flow doesn't. clientSecretOf() below is never optional
 *    the way graph.js's cfg.clientSecret is.
 *
 * ONE INSTANCE = ONE ACCOUNT. Multi-account support (the row's own
 * requirement -- "schema supports multiple named Google accounts from day
 * one") lives at the wiring layer: vault/src/server.js holds one
 * createGoogleClient() instance per connected account label, keyed the
 * same way secrets are (see server.js). This module itself stays as
 * single-account-simple as graph.js is, on purpose. The in-flight PKCE
 * state (codeVerifier + state nonce) for a sign-in in progress lives on
 * that same per-label config object between buildAuthUrl() and
 * exchangeCode(), same as accessToken/refreshToken do.
 */

const crypto = require('crypto');
const { httpsRequest } = require('./graph');

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

function googleTokenExpired(cfg, marginSeconds = 120) {
  if (!cfg || !cfg.accessToken || !cfg.tokenExpiresAt) return true;
  return Date.now() >= cfg.tokenExpiresAt - marginSeconds * 1000;
}

function createGoogleClient(opts) {
  const {
    getConfig,
    setConfig,
    onTokenRefreshed = async () => {},
    auditLog = { log: () => {} },
    minGapMs = 120,
    httpsRequestFn = httpsRequest,   // injectable for testing without a live network call, same as graph.js
  } = opts;
  if (!getConfig || !setConfig) throw new Error('createGoogleClient requires getConfig and setConfig');

  const clientIdOf = () => getConfig().clientId || '';
  const clientSecretOf = () => getConfig().clientSecret || '';

  let lastCallAt = 0;
  let throttledUntil = 0;
  async function pace() {
    const now = Date.now();
    if (throttledUntil > now) await new Promise(r => setTimeout(r, throttledUntil - now));
    const since = Date.now() - lastCallAt;
    if (since < minGapMs) await new Promise(r => setTimeout(r, minGapMs - since));
    lastCallAt = Date.now();
  }

  function applyTokenResponse(data) {
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token || getConfig().refreshToken;
    const tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    setConfig({ accessToken, refreshToken, tokenExpiresAt });
    return { accessToken, refreshToken, tokenExpiresAt };
  }

  async function refreshToken() {
    const cfg = getConfig();
    if (!cfg.refreshToken) return null;
    const params = new URLSearchParams();
    params.append('client_id', clientIdOf());
    params.append('client_secret', clientSecretOf());
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', cfg.refreshToken);

    try {
      const res = await httpsRequestFn({
        hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, params.toString());

      if (!res.data?.access_token) {
        auditLog.log('google_refresh_failed', {
          status: res.status || 0,
          error: res.data?.error || 'no access_token',
          description: String(res.data?.error_description || '').slice(0, 200),
        });
        return null;
      }

      const { accessToken, refreshToken: newRefreshToken } = applyTokenResponse(res.data);
      try {
        await onTokenRefreshed(accessToken, newRefreshToken);
        auditLog.log('google_token_refreshed', { clientId: clientIdOf(), persisted: true });
      } catch (e) {
        auditLog.log('google_token_refreshed', { clientId: clientIdOf(), persisted: false, persistError: String(e.message || e).slice(0, 160) });
      }
      return accessToken;
    } catch (e) {
      auditLog.log('google_refresh_error', { reason: String(e.message || e).slice(0, 160) });
      return null;
    }
  }

  async function getValidToken({ force = false } = {}) {
    const cfg = getConfig();
    if (!force && cfg.accessToken && !googleTokenExpired(cfg)) return cfg.accessToken;
    if (cfg.refreshToken) {
      const fresh = await refreshToken();
      if (fresh) return fresh;
    }
    if (googleTokenExpired(cfg)) setConfig({ accessToken: '', tokenExpiresAt: 0 });
    return getConfig().accessToken || null;
  }

  /**
   * Call a Google API host (Gmail: gmail.googleapis.com, Calendar:
   * www.googleapis.com/calendar/v3/...), refreshing once on a 401. No
   * redirect-follow/throttle-retry ladder like graphRequest -- neither
   * Gmail nor Calendar's REST APIs hand back a signed-redirect content URL
   * the way OneDrive does, and this module has no live sync-loop caller
   * yet to have hit real throttling against; add if BM26082011's build
   * finds it's actually needed.
   */
  async function googleRequest(hostname, pathAndQuery, { method = 'GET', body = null, headers = {} } = {}) {
    let token = await getValidToken();
    if (!token) return { status: 401, data: { error: { message: 'Google account not connected.' } } };

    const sendBody = (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) ? JSON.stringify(body) : body;
    const send = (tok) => httpsRequestFn({
      hostname, path: pathAndQuery, method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...headers },
    }, sendBody);

    await pace();
    let res = await send(token);
    if (res.status === 401) {
      auditLog.log('google_401_retry', { path: pathAndQuery.slice(0, 80) });
      token = await getValidToken({ force: true });
      if (token) res = await send(token);
    }
    return res;
  }

  // -- sign-in: Authorization Code + PKCE (device flow can't reach Gmail/
  // Calendar scopes -- see module header) ---------------------------------
  function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function buildAuthUrl({ redirectUri }) {
    const codeVerifier = base64url(crypto.randomBytes(32));
    const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
    const state = base64url(crypto.randomBytes(16));
    setConfig({ pendingAuth: { codeVerifier, state, redirectUri } });

    const params = new URLSearchParams();
    params.append('client_id', clientIdOf());
    params.append('redirect_uri', redirectUri);
    params.append('response_type', 'code');
    params.append('scope', GOOGLE_SCOPES);
    params.append('access_type', 'offline');   // required to get a refresh_token back
    params.append('prompt', 'consent');        // forces refresh_token even on a repeat sign-in
    params.append('code_challenge', codeChallenge);
    params.append('code_challenge_method', 'S256');
    params.append('state', state);
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state };
  }

  async function exchangeCode({ code, state }) {
    const cfg = getConfig();
    const pending = cfg.pendingAuth;
    if (!pending || pending.state !== state) {
      return { success: false, data: { error: 'state_mismatch', error_description: 'No matching sign-in in progress for this state.' } };
    }
    const params = new URLSearchParams();
    params.append('client_id', clientIdOf());
    params.append('client_secret', clientSecretOf());
    params.append('code', code);
    params.append('redirect_uri', pending.redirectUri);
    params.append('code_verifier', pending.codeVerifier);
    params.append('grant_type', 'authorization_code');
    const r = await httpsRequestFn({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, params.toString());

    setConfig({ pendingAuth: null });
    if (r.data?.access_token) {
      const { accessToken, refreshToken: refreshTok } = applyTokenResponse(r.data);
      try {
        await onTokenRefreshed(accessToken, refreshTok);
        auditLog.log('google_login_success', { clientId: clientIdOf(), persisted: true });
      } catch (e) {
        auditLog.log('google_login_success', { clientId: clientIdOf(), persisted: false, persistError: String(e.message || e).slice(0, 160) });
      }
      return { success: true, data: r.data };
    }
    return { success: false, data: r.data };
  }

  return {
    googleRequest, getValidToken, refreshToken,
    buildAuthUrl, exchangeCode,
  };
}

module.exports = { createGoogleClient, googleTokenExpired, GOOGLE_SCOPES };
