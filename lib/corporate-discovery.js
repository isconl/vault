'use strict';
/**
 * Corporate engagement org discovery -- BC26082006.
 *
 * Scans `Sconl/Core/Axial/Visionary/Corporate/` (a tree outside both
 * REMOTE_ROOT and FINANCE_ROOT, hence listRemoteFoldersAbsolute rather
 * than onedrive-sync's usual relPath-based helpers) for engagement folders
 * (existing pattern: `YYYY-org-slug`, e.g. `2026-viva-valentia`) and turns
 * each newly-seen one into a stub the career vault didn't have before.
 *
 * This module only DISCOVERS (Graph access is vault's job). Persisting the
 * stub is circle's job (circle/lib/career.js owns career/** entirely --
 * vault has no write path into circle's memory dir) -- see
 * pushDiscoveredOrgs, which POSTs to circle's /career/orgs/discover the
 * same way scope's corporate.js already reaches circle over HTTP to READ.
 */

const http = require('http');
const https = require('https');

const CORPORATE_ROOT = 'Sconl/Core/Axial/Visionary/Corporate';
const FOLDER_PATTERN = /^(\d{4})-(.+)$/;

function titleCase(slug) {
  return slug.split(/[-_]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * List engagement folders and shape them into discovery candidates.
 * Never throws -- { ok: false } on any listing failure, same contract as
 * every onedrive-sync function.
 */
async function discoverOrgs(graph, { corporateRoot = CORPORATE_ROOT, onedriveSync = require('./onedrive-sync') } = {}) {
  const listing = await onedriveSync.listRemoteFoldersAbsolute(graph, corporateRoot);
  if (!listing.ok) return { ok: false, status: listing.status, error: listing.error };

  const orgs = listing.folders.map((f) => {
    const m = FOLDER_PATTERN.exec(f.name);
    const slug = m ? m[2] : f.name;
    return {
      folder: f.name,
      id: slug,
      name: titleCase(slug),
      discoveryDate: (f.createdDateTime || new Date().toISOString()).slice(0, 10),
    };
  });
  return { ok: true, orgs };
}

/**
 * POST newly-discovered orgs to circle's /career/orgs/discover. circle
 * itself decides which are actually new (idempotent -- a re-run posting an
 * already-known id is a no-op there, not an error here). Fails soft: no
 * CIRCLE_URL configured, or the request itself failing, both resolve to
 * { ok: false } rather than throwing -- this runs inside sync-loop's
 * per-pass try/catch same as every other collection, but degrading
 * gracefully here means one missing env var doesn't spam the audit log
 * every tick.
 */
async function pushDiscoveredOrgs(orgs, { circleUrl, token } = {}) {
  if (!circleUrl) return { ok: false, error: 'CIRCLE_URL not configured' };
  if (!orgs || !orgs.length) return { ok: true, created: [], skipped: [] };

  const url = new URL('/career/orgs/discover', circleUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ orgs });

  return new Promise((resolve) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token || ''}` },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode, error: raw.slice(0, 200) });
        try { resolve({ ok: true, ...JSON.parse(raw) }); }
        catch { resolve({ ok: false, error: 'invalid JSON from circle' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e).slice(0, 200) }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

module.exports = { discoverOrgs, pushDiscoveredOrgs, CORPORATE_ROOT, FOLDER_PATTERN };
