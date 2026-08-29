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
  // Local-only for now: this collection is new (2026-08-16) and has no
  // remote counterpart on OneDrive yet. Pulling a file that doesn't exist
  // remotely fails every tick with itemNotFound, which correctly (but
  // uselessly) trips the "sync is failing" banner. Push now exists
  // (onedrive-sync.js's pushToRemote(), wired 2026-08-18 via store.js's
  // write-then-push hook -- SYNC1), so the first real local write to this
  // file will create it remotely on its own. Un-exclude once that's
  // confirmed to have happened.
  'scope/theme_days.tsv',
  // Same as above: new local-only narration audio version registry
  // (2026-08-17). Created on upload by the narration engine -- that write
  // now pushes it to OneDrive automatically the first time it happens.
  // Un-exclude once confirmed.
  'learning/audio_versions.tsv',
  // FI26082704: same class, found live 28 Aug 2026 -- header-only, zero
  // data rows yet (unlike scope/planning_insights.tsv, scope/user_groups.tsv,
  // scope/active_subjects.tsv, and scope/status_briefs.tsv, which DID have
  // real rows and got a one-time manual push instead, same session). Genuinely
  // not yet in use, so excluded rather than pushed -- the write-then-push
  // hook (SYNC1) means the first real row written creates it remotely on
  // its own. Un-exclude once confirmed to have happened.
  'scope/deal_flow_parties.tsv',
  // BX26082801: new collection. Excluded until first write creates it remotely.
  'scope/pending_jira_writes.tsv',
  'teams/teams.tsv',
  'teams/members.tsv',
  'teams/work.tsv',
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
 * @param {object} [opts.corporateDiscovery] - the corporate-discovery module (or a test double); omit to skip the discovery pass entirely
 * @param {string} [opts.circleUrl] - base URL for circle, needed to push discovered orgs; discovery pass is skipped (not failed) when absent
 * @param {string} [opts.circleToken] - bearer token for circle's /career/orgs/discover
 */
function createSyncLoop({ onedriveSync, graph, store, auditLog = { log: () => {} }, delayMs = 250, corporateDiscovery = null, circleUrl = '', circleToken = '' }) {
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
      //
      // Found live 28 Aug 2026 (FI26082702 follow-up): learning/courses.tsv
      // was corrupted with an extra leading tab-separated field, which
      // shifted every row's real columns out from under the schema's names
      // and left `ID` reading the literal placeholder "-" for every one of
      // its 27 rows. Before this filter, that meant 27 identical
      // `pullFolder(graph, store, 'learning/-')` calls per sync pass, each
      // one a guaranteed itemNotFound failure padding out the "N
      // collection(s) failed" count with noise unrelated to any real
      // problem. `.filter(Boolean)` alone didn't catch it, since "-" is
      // truthy -- this both excludes the "-" placeholder specifically and
      // de-dupes, so a genuinely bad courses.tsv degrades to at most one
      // failure entry instead of one per corrupted row. The underlying file
      // corruption itself is a separate, real problem -- see FI26082801 in
      // fix.md -- deliberately not auto-repaired here, since guessing at a
      // column realignment risks making bad data worse.
      let courseIds = [];
      try {
        const rawIds = store.read('learning/courses.tsv').map((c) => c.ID).filter(Boolean);
        courseIds = [...new Set(rawIds.filter((id) => id !== '-'))];
      } catch {}
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

      // Corporate engagement org discovery (BC26082006) -- not a "collection"
      // pull like everything above (nothing local is being read back), so it
      // reports into results.ok/failed under its own label rather than a
      // relPath. Skipped silently (not a failure) when either half of the
      // wiring (corporateDiscovery module, CIRCLE_URL) isn't configured --
      // same fail-soft posture as scope's own getCareerContext.
      if (corporateDiscovery && circleUrl) {
        try {
          const found = await corporateDiscovery.discoverOrgs(graph);
          if (found.ok) {
            const pushed = await corporateDiscovery.pushDiscoveredOrgs(found.orgs, { circleUrl, token: circleToken });
            const entry = { collection: 'corporate-discovery', ok: pushed.ok, orgsSeen: found.orgs.length, created: pushed.created, error: pushed.error };
            (pushed.ok ? results.ok : results.failed).push(entry);
          } else {
            results.failed.push({ collection: 'corporate-discovery', ok: false, error: found.error });
          }
        } catch (e) {
          results.failed.push({ collection: 'corporate-discovery', ok: false, error: String(e.message || e).slice(0, 200) });
        }
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
