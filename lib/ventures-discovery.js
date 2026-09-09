'use strict';
/**
 * Ace venture discovery -- BN26090610.
 *
 * Sconl's real venture/brand structure lives in `onedrive-acexoft:_ace` --
 * a DIFFERENT OneDrive account (admin@acexoft.com) than the one vault's own
 * Graph client (lib/graph.js) is authenticated against (see CLAUDE.md §3),
 * so this can't reuse vault's usual Graph path the way
 * corporate-discovery.js does. It's reached the same way any interactive
 * session reaches it: rclone, against the portable config already set up
 * for this remote (`_kit/cache/clis/rclone.conf`) -- hence the
 * execFile('rclone', ...) default listing function below, rather than a
 * Graph call.
 *
 * Same split as corporate-discovery.js (this module's direct template):
 * this file only DISCOVERS (list + shape candidates, pure and testable via
 * an injected listFn) -- persisting is pulse's job, via
 * pushDiscoveredVentures POSTing to pulse's own
 * /finance/ventures/discover-ingest (mirrors pushDiscoveredOrgs POSTing to
 * circle's /career/orgs/discover).
 *
 * Three sources of venture candidates, confirmed against the real `_ace`
 * structure 8 Sep 2026 (see BN26090610's backlog row for the full
 * exploration) -- deliberately NOT collapsed into a fixed, guessed count:
 *
 *  1. Top-level operating entities (acexoft-capital, acexoft-dynamics,
 *     acexoft-foundation) -- everything at depth 1 except the known
 *     non-venture structural folders: `_admin` (internal admin, not a
 *     venture), `_brands` (brand-identity assets, folded in separately
 *     below), `Practice`/`Products`/`Protocols` (confirmed empty --
 *     future placeholders, not real ventures yet), and `collaboration`
 *     (holds `partner-brands/` -- other people's brands Sconl collaborates
 *     with, not his own ventures).
 *  2. acexoft-dynamics's own operating subsidiaries (depth-2 folders under
 *     it) -- except `_parent`, which holds personal documents (CVs, consent
 *     forms, reference letters with real people's names). Per this row's
 *     own explicit instruction, that folder's CONTENTS are never read here
 *     -- only its NAME is used, to exclude it, never to include it.
 *  3. Brand-identity folders under `_brands/` whose slug (leading
 *     underscore and a leading "ace-" prefix both stripped for matching)
 *     doesn't already match a folder found in (1) or (2) -- these are
 *     brand identities for something that doesn't (yet) have its own
 *     operating folder. As of 8 Sep 2026 that's `ace-quntum-engineering`
 *     and `aceplus-hospitals` -- surfaced as their own candidates rather
 *     than silently dropped or force-mapped onto an existing one, per this
 *     row's explicit "do not force a fabricated mapping" instruction.
 *     `__assets` (asset storage, not a brand) is excluded.
 *
 * The exact venture count/mapping is genuinely ambiguous from folder
 * structure alone (is acexoft-dynamics itself a venture, or only a holding
 * umbrella over its three subsidiaries?) -- this module does not resolve
 * that ambiguity. It surfaces every distinct venture-like folder as its
 * own candidate row; Sconl merges/renames/discards through the editable
 * ventures UI (pulse's finance.js + hub's webconsole), not by a session
 * guessing definitively here.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACE_ROOT = '_ace';
const ACE_RCLONE_REMOTE = process.env.ACE_RCLONE_REMOTE || 'onedrive-acexoft';

/** RCLONE_CONFIG_PATH, if set, wins. Otherwise fall back to the standing
 *  relay-drive location (CLAUDE.md §3/§7's `_kit/cache/clis/rclone.conf`,
 *  five levels up from vault/lib/ -- .../iSconl/vault/lib -> .../.relay/
 *  _kit/cache/clis/rclone.conf) if it actually exists there; '' (rclone's
 *  own default config location) otherwise. A wrong guess here just means
 *  the listing fails with a clear rclone error, not a silent bad path. */
function defaultRcloneConfigPath() {
  if (process.env.RCLONE_CONFIG_PATH) return process.env.RCLONE_CONFIG_PATH;
  const guess = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', '_kit', 'cache', 'clis', 'rclone.conf');
  try { return fs.existsSync(guess) ? guess : ''; } catch { return ''; }
}

// Depth-1 folders that are structural, never a venture themselves.
const NON_VENTURE_TOP = new Set(['_admin', '_brands', 'Practice', 'Products', 'Protocols', 'collaboration']);
// Depth-2 folders under acexoft-dynamics that are never a venture -- see
// header comment: `_parent` holds personal documents, names only, never read.
const NON_VENTURE_DYNAMICS_SUB = new Set(['_parent']);
// Depth-2 folders under _brands that are never a brand identity.
const NON_VENTURE_BRAND_SUB = new Set(['__assets']);

function titleCase(slug) {
  return String(slug).replace(/^_+/, '').split(/[-_]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Default listFn: `rclone lsf <remote>:_ace --max-depth 2`, one folder/file
 * per line, folders suffixed with `/`. Never exercised in tests --
 * discoverVentures always takes an injected listFn there, so no test needs
 * live network or a real rclone binary (per this row's own testing
 * instruction).
 */
function defaultListFn({ rcloneConfig = defaultRcloneConfigPath(), remote = ACE_RCLONE_REMOTE, root = ACE_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (rcloneConfig) args.push('--config', rcloneConfig);
    args.push('lsf', `${remote}:${root}`, '--max-depth', '2');
    execFile('rclone', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
}

/**
 * Turn a flat `rclone lsf --max-depth 2` listing of `_ace` into candidate
 * venture rows: `{ folder, name }[]`. Never throws -- `{ ok: false }` on any
 * listing failure, same fail-soft contract as corporate-discovery's
 * discoverOrgs.
 *
 * @param {(opts?:object) => Promise<string[]>} [listFn] - defaults to a
 *   real rclone call; tests inject a fake returning canned lines.
 */
async function discoverVentures(listFn = defaultListFn, opts = {}) {
  let lines;
  try { lines = await listFn(opts); }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200) }; }

  const topDirs = new Set();
  const dynamicsSubDirs = new Set();
  const brandDirs = new Set();

  for (const line of lines) {
    if (!line.endsWith('/')) continue; // a file sitting alongside the folders, not a folder itself
    const parts = line.slice(0, -1).split('/');
    if (parts.length === 1) topDirs.add(parts[0]);
    else if (parts.length === 2 && parts[0] === 'acexoft-dynamics') dynamicsSubDirs.add(parts[1]);
    else if (parts.length === 2 && parts[0] === '_brands') brandDirs.add(parts[1]);
  }

  const candidates = [];
  const seenSlugs = new Set();
  const addCandidate = (folder, name) => {
    const slug = slugify(name);
    if (seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    candidates.push({ folder, name: titleCase(name) });
  };

  for (const d of topDirs) {
    if (NON_VENTURE_TOP.has(d)) continue;
    addCandidate(d, d);
  }
  for (const d of dynamicsSubDirs) {
    if (NON_VENTURE_DYNAMICS_SUB.has(d)) continue;
    addCandidate(`acexoft-dynamics/${d}`, d);
  }
  for (const d of brandDirs) {
    if (NON_VENTURE_BRAND_SUB.has(d)) continue;
    const stripped = d.replace(/^_/, '');
    const strippedSlug = slugify(stripped);
    const withoutAcePrefix = strippedSlug.replace(/^ace-/, '');
    if (seenSlugs.has(strippedSlug) || seenSlugs.has(withoutAcePrefix)) continue; // already covered by an operating folder found above
    addCandidate(`_brands/${d}`, stripped);
  }

  return { ok: true, ventures: candidates };
}

/**
 * POST newly-discovered ventures to pulse's own
 * /finance/ventures/discover-ingest. pulse decides which are actually new
 * (additive upsert, matched by FOLDER -- never overwrites a row Sconl has
 * already populated). Fails soft: no PULSE_URL configured, or the request
 * itself failing, both resolve to { ok: false } rather than throwing --
 * same contract as corporate-discovery's pushDiscoveredOrgs.
 */
async function pushDiscoveredVentures(ventures, { pulseUrl, token } = {}) {
  if (!pulseUrl) return { ok: false, error: 'PULSE_URL not configured' };
  if (!ventures || !ventures.length) return { ok: true, created: [], skipped: [] };

  const http = require('http');
  const https = require('https');
  const url = new URL('/finance/ventures/discover-ingest', pulseUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ ventures });

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
        catch { resolve({ ok: false, error: 'invalid JSON from pulse' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e).slice(0, 200) }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

module.exports = {
  discoverVentures, pushDiscoveredVentures, defaultListFn,
  ACE_ROOT, ACE_RCLONE_REMOTE, NON_VENTURE_TOP, NON_VENTURE_DYNAMICS_SUB, NON_VENTURE_BRAND_SUB,
};
