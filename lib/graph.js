'use strict';
/**
 * Microsoft Graph (OneDrive/M365) client: token lifecycle, paced/retrying
 * requests, and the device-code sign-in flow.
 *
 * Ported from isconl-agent's server.js (the "MICROSOFT GRAPH / M365
 * END-TO-END AUTOMATION ENGINE" section, ~12377-12600, plus GRAPH PACING
 * at ~1051-1071). This was the single largest piece of undifferentiated
 * technical debt found in the discovery pass -- an unexported closure that
 * at least 4 of the 5 proposed engines (scope, circle, pulse, and the core
 * vault sync itself) reach into directly. Extracting it as a real,
 * importable client is the reason `vault` has to ship before anything else.
 *
 * KNOWN LIMITATION, carried over unchanged from the original (flagging,
 * not silently fixing, per "refactor not rebuild"): httpsRequest() below
 * only returns { status, data } -- response headers are discarded. The
 * throttle-retry logic reads `res.headers?.['retry-after']`, which is
 * therefore always undefined and always falls through to exponential
 * backoff. This was true in server.js too. Worth fixing later (it would
 * make throttle recovery faster and more accurate), but that's a behavior
 * change, so it's out of scope for a straight port.
 */

const https = require('https');

const GRAPH_SCOPE = 'User.Read Files.ReadWrite Calendars.ReadWrite Mail.Read Mail.Send offline_access';

function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * A JWT's middle segment carries `exp` as a unix second. Returns true if
 * expired (or unreadable in a way that can't be disproven -- an opaque
 * token returns false, i.e. "assume valid," and lets a 401 handle it).
 */
function msGraphTokenExpired(token, marginSeconds = 120) {
  if (!token) return true;
  try {
    const seg = String(token).split('.')[1];
    if (!seg) return false;   // opaque token: cannot tell, let the 401 path handle it
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    if (!exp) return false;
    return (exp - marginSeconds) * 1000 <= Date.now();
  } catch { return false; }
}

/**
 * @param {object} opts
 * @param {() => {clientId?:string, clientSecret?:string, accessToken?:string, refreshToken?:string}} opts.getConfig
 * @param {(patch: object) => void} opts.setConfig - merge new token values into wherever config actually lives
 * @param {(newAccessToken:string, newRefreshToken:string) => Promise<void>} [opts.onTokenRefreshed] -
 *   called after a successful refresh, BEFORE returning the token, so the caller can persist it
 *   (e.g. to Bitwarden via lib/secrets.js's persistSecret) -- the original hardcoded this to
 *   Bitwarden + a local .env file; here it's the caller's choice entirely.
 * @param {{log:Function}} [opts.auditLog]
 * @param {number} [opts.minGapMs=120] - minimum spacing between Graph calls (ISCONL_GRAPH_GAP_MS in the original)
 */
function createGraphClient(opts) {
  const {
    getConfig,
    setConfig,
    onTokenRefreshed = async () => {},
    auditLog = { log: () => {} },
    minGapMs = 120,
    httpsRequestFn = httpsRequest,   // injectable for testing without a live network call
  } = opts;
  if (!getConfig || !setConfig) throw new Error('createGraphClient requires getConfig and setConfig');

  // No hardcoded fallback: an MS Graph app registration's client_id is
  // tenant-specific (this was a real app registration belonging to one
  // person), so a missing config here must fail loudly via Graph's own
  // "invalid client_id" error, not silently succeed against someone else's
  // registration -- config-first genericization (Decision 002's pattern).
  const clientIdOf = () => getConfig().clientId || '';

  // -- pacing: one shared gate in front of every Graph call --------------------
  // Requests are spaced so a sync pass doesn't arrive as a burst, and once
  // Graph has said 429 the gate holds everything until the retry window has
  // passed -- retry logic alone just spreads the storm out, it doesn't stop it.
  let lastCallAt = 0;
  let throttledUntil = 0;
  async function pace() {
    const now = Date.now();
    if (throttledUntil > now) await new Promise(r => setTimeout(r, throttledUntil - now));
    const since = Date.now() - lastCallAt;
    if (since < minGapMs) await new Promise(r => setTimeout(r, minGapMs - since));
    lastCallAt = Date.now();
  }

  async function refreshToken() {
    const cfg = getConfig();
    if (!cfg.refreshToken) return null;
    const clientId = clientIdOf();
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', cfg.refreshToken);
    params.append('scope', GRAPH_SCOPE);
    if (cfg.clientSecret) params.append('client_secret', cfg.clientSecret);

    try {
      const res = await httpsRequestFn({
        hostname: 'login.microsoftonline.com', path: '/common/oauth2/v2.0/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, params.toString());

      if (!res.data?.access_token) {
        // Surface the real reason -- swallowing it is why this failure was
        // opaque for so long; a revoked grant needs a new sign-in, not a retry.
        auditLog.log('msgraph_refresh_failed', {
          status: res.status || 0,
          error: res.data?.error || 'no access_token',
          description: String(res.data?.error_description || '').slice(0, 200),
        });
        return null;
      }

      const accessToken = res.data.access_token;
      // Microsoft rotates the refresh token on use -- losing the new one means
      // the NEXT refresh fails with the old one already invalidated.
      const newRefreshToken = res.data.refresh_token || cfg.refreshToken;
      setConfig({ accessToken, refreshToken: newRefreshToken });

      try {
        await onTokenRefreshed(accessToken, newRefreshToken);
        auditLog.log('msgraph_token_refreshed', { clientId, persisted: true });
      } catch (e) {
        auditLog.log('msgraph_token_refreshed', { clientId, persisted: false, persistError: String(e.message || e).slice(0, 160) });
      }
      return accessToken;
    } catch (e) {
      auditLog.log('msgraph_refresh_error', { reason: String(e.message || e).slice(0, 160) });
      return null;
    }
  }

  async function getValidToken({ force = false } = {}) {
    const cfg = getConfig();
    if (!force && cfg.accessToken && !msGraphTokenExpired(cfg.accessToken)) {
      return cfg.accessToken;
    }
    if (cfg.refreshToken) {
      const fresh = await refreshToken();
      if (fresh) return fresh;
    }
    // Refresh failed or was impossible -- drop the dead token so status
    // reporting stops claiming M365 is connected when nothing can be fetched.
    if (msGraphTokenExpired(cfg.accessToken)) setConfig({ accessToken: '' });
    return getConfig().accessToken || null;
  }

  /**
   * Call Graph, refreshing once on a 401, retrying on throttle. See the
   * module-level KNOWN LIMITATION note re: Retry-After not actually being read.
   */
  async function graphRequest(pathAndQuery, { method = 'GET', body = null, headers = {} } = {}) {
    let token = await getValidToken();
    if (!token) return { status: 401, data: { error: { message: 'Microsoft 365 not connected.' } } };

    const send = (tok) => httpsRequestFn({
      hostname: 'graph.microsoft.com', path: pathAndQuery, method,
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json', ...headers },
    }, body);

    // Stay under the limit rather than discovering it -- Graph throttles on
    // request RATE and a sync pass can fire ~200 calls as fast as the event
    // loop allows.
    await pace();

    let res = await send(token);
    const expiredish = res.status === 401
      || /token is expired|lifetime validation failed|InvalidAuthenticationToken/i.test(JSON.stringify(res.data || ''));
    if (expiredish) {
      auditLog.log('msgraph_401_retry', { path: pathAndQuery.slice(0, 80) });
      token = await getValidToken({ force: true });
      if (token) res = await send(token);
    }

    for (let attempt = 1; attempt <= 4 && (res.status === 429 || res.status === 503 || res.status === 509); attempt++) {
      const retryAfter = parseInt(res.headers?.['retry-after'] || res.headers?.['Retry-After'] || '', 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60000)
        : Math.min(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 400), 30000);
      throttledUntil = Date.now() + waitMs;
      auditLog.log('msgraph_throttled', { path: pathAndQuery.slice(0, 60), status: res.status, attempt, waitMs });
      await new Promise(r => setTimeout(r, waitMs));
      res = await send(token);
    }
    if (res.status === 429 || res.status === 503) {
      auditLog.log('msgraph_throttle_gave_up', { path: pathAndQuery.slice(0, 60), status: res.status });
    }
    return res;
  }

  // -- sign-in: device code flow -------------------------------------------------
  async function startDeviceCodeAuth() {
    const params = new URLSearchParams();
    params.append('client_id', clientIdOf());
    params.append('scope', GRAPH_SCOPE);
    const r = await httpsRequestFn({
      hostname: 'login.microsoftonline.com', path: '/common/oauth2/v2.0/devicecode', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, params.toString());
    return r.data;
  }

  async function pollDeviceCodeAuth(deviceCode) {
    const params = new URLSearchParams();
    params.append('client_id', clientIdOf());
    params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    params.append('device_code', deviceCode);
    const r = await httpsRequestFn({
      hostname: 'login.microsoftonline.com', path: '/common/oauth2/v2.0/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, params.toString());

    if (r.data?.access_token) {
      const accessToken = r.data.access_token;
      const refreshTok = r.data.refresh_token || '';
      setConfig({ accessToken, refreshToken: refreshTok });
      try {
        await onTokenRefreshed(accessToken, refreshTok);
        auditLog.log('msgraph_login_success', { clientId: clientIdOf(), persisted: true });
      } catch (e) {
        auditLog.log('msgraph_login_success', { clientId: clientIdOf(), persisted: false, persistError: String(e.message || e).slice(0, 160) });
      }
      return { success: true, data: r.data };
    }
    return { success: false, data: r.data };
  }

  return {
    graphRequest, getValidToken, msGraphTokenExpired, refreshToken,
    startDeviceCodeAuth, pollDeviceCodeAuth,
    httpsRequest,   // exported: generic enough that other engines' non-Graph external calls can reuse it too
  };
}

module.exports = { createGraphClient, msGraphTokenExpired, httpsRequest };
