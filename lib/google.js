'use strict';
/**
 * Google OAuth (Gmail + Calendar) client -- BI26082005.
 *
 * Mirrors graph.js's shape deliberately (pace/token-lifecycle/device-code
 * sign-in), since that module is the one proven, live-verified pattern for
 * exactly this kind of headless OAuth in this fleet -- graph.js's own
 * header explains why (no browser-redirect callback server, Docker-less
 * script-driven environment). Two real differences from Microsoft's flow,
 * both Google's own contract, not a design choice here:
 *
 *  - Google's device flow requires client_secret on EVERY token request
 *    (device-code exchange, refresh) -- Microsoft's public-client flow
 *    doesn't. clientSecretOf() below is never optional the way graph.js's
 *    cfg.clientSecret is.
 *  - Google's access_token is opaque (not a decodable JWT), so expiry
 *    can't be read back out of the token itself the way
 *    msGraphTokenExpired() does. tokenExpiresAt is tracked explicitly
 *    (Date.now() + expires_in*1000) whenever a token is obtained.
 *
 * ONE INSTANCE = ONE ACCOUNT. Multi-account support (the row's own
 * requirement -- "schema supports multiple named Google accounts from day
 * one") lives at the wiring layer: vault/src/server.js holds one
 * createGoogleClient() instance per connected account label, keyed the
 * same way secrets are (see server.js). This module itself stays as
 * single-account-simple as graph.js is, on purpose.
 *
 * BUILT THIS PASS: auth flow + token lifecycle + a generic authenticated
 * request helper (points 1-3 of BI26082005's scope). NOT built this pass,
 * deliberately left for the row's remaining build work: the actual Gmail-
 * message/Calendar-event wrapper calls, hub proxy wiring, and pulse's
 * calendar merge (points 4-5) -- those have no real consumer yet
 * (BM26082011, the Email pane, is what will call them) and shipping untested
 * wrapper code with nothing exercising it risks guessing at a shape that
 * doesn't match what the actual UI needs. See build.md.
 *
 * LIVE VERIFICATION BLOCKED (not this module's fault): no Google Cloud
 * OAuth client (client_id/client_secret) exists yet -- confirmed 20 Aug via
 * `bws secret list`, zero GOOGLE_* keys in the Bitwarden project. Needs
 * Sconl to register an OAuth client in Google Cloud Console (Gmail API +
 * Calendar API enabled, a TV-and-limited-input-device / device-flow OAuth
 * client) and store GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in Bitwarden --
 * same one-time setup graph.js's MSGRAPH_CLIENT_ID/SECRET already needed.
 * Everything below is unit-tested against a mocked transport (same pattern
 * graph.test.js already uses), same as graph.js was before its own first
 * live sign-in.
 */

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

  // -- sign-in: device code flow (Google's own contract) -----------------------
  async function startDeviceCodeAuth() {
    const params = new URLSearchParams();
    params.append('client_id', clientIdOf());
    params.append('scope', GOOGLE_SCOPES);
    const r = await httpsRequestFn({
      hostname: 'oauth2.googleapis.com', path: '/device/code', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, params.toString());
    return r.data;
  }

  async function pollDeviceCodeAuth(deviceCode) {
    const params = new URLSearchParams();
    params.append('client_id', clientIdOf());
    params.append('client_secret', clientSecretOf());
    params.append('device_code', deviceCode);
    params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    const r = await httpsRequestFn({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, params.toString());

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
    startDeviceCodeAuth, pollDeviceCodeAuth,
  };
}

module.exports = { createGoogleClient, googleTokenExpired, GOOGLE_SCOPES };
