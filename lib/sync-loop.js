'use strict';
/**
 * Boot-time + interval OneDrive pull for every known collection -- the
 * migration brief's `vaultSyncKick()` equivalent (section 3, "what's NOT
 * done yet" in the 2026-08-14 session log). Before this, every collection
 * needed a manual `POST /onedrive/pull` per file; this runs that same pull
 * across the whole known collection list on its own schedule.
 *
 * Growth over safety, deliberately: every collection pulls independently
 * inside its own try/catch, so one bad collection (a 404, a massacre-guard
 * trip) never blocks the rest of the pass. Results are logged per-pass to
 * the audit trail (ok/failed counts + which collections failed), not just
 * swallowed.
 *
 * Deliberately NOT the full brief inventory (section 5) yet -- covers
 * exactly what a manual session already pulled and verified working
 * end-to-end against the live fleet on 2026-08-14 (see
 * _handoff/migration-log.md): every TSV in the vault schema, the "unowned"
 * finance TSVs the schema doesn't declare, the JSON/YAML state files, and
 * -- after the TSV pass above has run, since the course list comes from
 * the pulled learning/courses.tsv, not a hardcoded array -- every course's
 * lesson folder (learning/<courseId>/*.md), via onedriveSync.pullFolder().
 * Still not here, on purpose: the rest of the markdown estate
 * (circle/dia/**, per-person profiles), the career/copilot YAML registers,
 * chat-archives/*.zip, and history/onthisday.tsv (9.4MB -- the brief
 * itself warns against re-pulling something that size on every tick; it
 * would need its own change-detection, not a blind pull, before joining
 * this list).
 */

const defaultSchema = require('./default-schema');

// finance/*.tsv collections default-schema.js doesn't declare -- the
// "unowned" set from the brief's section 7, pulled by hand and verified
// 2026-08-14.
const EXTRA_FINANCE_TSV = [
  'finance/moves.tsv', 'finance/budget_items.tsv', 'finance/vendors.tsv',
  'finance/vendor_map.tsv', 'finance/places.tsv', 'finance/prices.tsv',
  'finance/wishlist.tsv',
];

// Non-TSV state files, pulled by hand and verified 2026-08-14 -- the two
// that actually feed a hub panel (calendar_events.json, rhythm.json) plus
// the rest of the brief's "state files that are not TSVs" list that were
// already confirmed real and non-empty on OneDrive this session.
const RAW_COLLECTIONS = [
  'scope/calendar_events.json', 'scope/task_briefs.json', 'scope/task_drafts.json',
  'circle/reachouts.json', 'personal/rhythm.json',
  'scope/identity.yaml', 'identity/identity.yaml',
];

// Registered in default-schema.js (so bootRepair creates it and rewriteTSV
// can write into it) but deliberately excluded here.
const SCHEMA_EXCLUDE_FROM_SYNC = [
  // 9.4MB, doesn't change day to day, and the brief itself warns against
  // re-pulling something that size on every interval tick. Refresh manually.
  'history/onthisday.tsv',
  // Local-only for now: this collection is new (2026-08-16), has no
  // remote counterpart on OneDrive yet, and vault has no PUSH capability
  // (onedrive-sync.js's own header: "PUSH... deliberately still not
  // here"). Pulling a file that doesn't exist remotely fails every tick
  // with itemNotFound, which correctly (but uselessly) trips the "sync is
  // failing" banner. Un-exclude once something has actually created
  // scope/theme_days.tsv on OneDrive.
  'scope/theme_days.tsv',
];

function allCollections() {
  return {
    tsv: [...Object.keys(defaultSchema), ...EXTRA_FINANCE_TSV].filter(c => !SCHEMA_EXCLUDE_FROM_SYNC.includes(c)),
    raw: RAW_COLLECTIONS,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.onedriveSync - the module (or a test double) exposing pullToLocal/pullToLocalRaw
 * @param {object} opts.graph
 * @param {object} opts.store
 * @param {{log:Function}} [opts.auditLog]
 * @param {number} [opts.delayMs] - pause between collections, kind to Graph's throttling
 */
function createSyncLoop({ onedriveSync, graph, store, auditLog = { log: () => {} }, delayMs = 250 }) {
  let timer = null;
  let running = false;
  let lastResult = null;

  async function runOnce() {
    if (running) return { skipped: 'already running', lastResult };
    running = true;
    const { tsv, raw } = allCollections();
    const results = { ok: [], failed: [], startedAt: new Date().toISOString() };
    try {
      for (const rel of tsv) {
        try {
          const r = await onedriveSync.pullToLocal(graph, store, rel);
          (r.ok ? results.ok : results.failed).push({ collection: rel, ...r });
        } catch (e) {
          results.failed.push({ collection: rel, ok: false, error: String(e.message || e).slice(0, 200) });
        }
        if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      }
      for (const rel of raw) {
        try {
          const r = await onedriveSync.pullToLocalRaw(graph, store, rel);
          (r.ok ? results.ok : results.failed).push({ collection: rel, ...r });
        } catch (e) {
          results.failed.push({ collection: rel, ok: false, error: String(e.message || e).slice(0, 200) });
        }
        if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      }

      // Course lesson folders -- filenames aren't fixed in advance the way
      // the collections above are, so the course IDs come from the TSV pull
      // that just ran (learning/courses.tsv), not a hardcoded list.
      let courseIds = [];
      try { courseIds = store.read('learning/courses.tsv').map((c) => c.ID).filter(Boolean); } catch {}
      for (const courseId of courseIds) {
        const folder = `learning/${courseId}`;
        try {
          const r = await onedriveSync.pullFolder(graph, store, folder);
          const entry = { collection: folder, ok: r.ok, files: r.ok ? r.files.length : undefined, error: r.error };
          (r.ok ? results.ok : results.failed).push(entry);
        } catch (e) {
          results.failed.push({ collection: folder, ok: false, error: String(e.message || e).slice(0, 200) });
        }
        if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      }
    } finally {
      running = false;
    }
    results.finishedAt = new Date().toISOString();
    lastResult = results;
    auditLog.log('onedrive_sync_pass', {
      ok: results.ok.length,
      failed: results.failed.length,
      failedCollections: results.failed.map((f) => f.collection).join(','),
    });
    return results;
  }

  /** Fires an immediate pass, then repeats every intervalMs. Never blocks the caller -- boot-time pass is fire-and-forget so ~35 sequential Graph calls don't delay the server binding. */
  function start(intervalMs) {
    if (timer) return;
    runOnce().catch((e) => auditLog.log('onedrive_sync_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    timer = setInterval(() => {
      runOnce().catch((e) => auditLog.log('onedrive_sync_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    }, intervalMs);
    if (timer.unref) timer.unref(); // never keeps the process alive on its own
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, getLastResult: () => lastResult, isRunning: () => running };
}

module.exports = { createSyncLoop, allCollections, EXTRA_FINANCE_TSV, RAW_COLLECTIONS };
