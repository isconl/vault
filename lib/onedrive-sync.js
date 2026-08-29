'use strict';
/**
 * OneDrive sync.
 *
 * Two real, previously-undiscovered bugs made the legacy monolith's own
 * sync silently useless: (1) its hardcoded remote root
 * (Sconl/Core/Apex/Vault/vault-documents/workspace/isconl-agent/) is stale
 * -- the actual data lives in a sibling folder, confirmed by direct rclone
 * inspection on 2026-08-13, likely moved during a past OneDrive reorg and
 * never updated in code; (2) neither this local vault nor the legacy
 * checkout has ever actually run a sync at all (confirmed: empty audit
 * logs, empty vault-sync-state.json), so the "0 tasks" a fresh local vault
 * shows was never a data-loss symptom, just a vault that had never synced.
 *
 * PULL (remote -> local disk) is here: pullToLocal() writes real OneDrive
 * content into the local vault, verified end to end against real data
 * (2026-08-14). It routes through store.rewrite() rather than touching
 * files directly, so it inherits vault's existing safety guards for free
 * (previous-version backup, the massacre guard against dropping more than
 * half a populated file's rows) instead of a second, parallel write path.
 *
 * PUSH (local -> remote) is pushToRemote() below, added 2026-08-18 (SYNC1):
 * a local edit made outside the pull loop (a session hand-editing a TSV, a
 * one-off script) used to be silently wiped by the next scheduled pull,
 * since pull always treated OneDrive as the sole source of truth. Deliberately
 * the narrow fix, not a general two-way sync: it PUTs the local file's own
 * current bytes up as-is (no merge, no conflict resolution) and is meant to
 * be called right after a local write, not on its own schedule -- store.js
 * wires it in as a fire-and-forget hook fired from rewrite()/append()/
 * rawWrite() so "write locally" and "make it durable" happen together.
 */

const { parseTSVText } = require('./tsv');

/**
 * FI26082702: the periodic pull used to overwrite a local edit made since
 * the last successful pull/push for that collection, with no guard at all --
 * reproduced twice live (26-27 Aug 2026): an edit to learning/courses.tsv
 * and a re-applied scope/inbox.tsv fix were both silently wiped by the next
 * ~10-minute pull tick because neither had been pushed yet when the tick
 * fired. Worse than a merge conflict: nothing errors or warns, the edit
 * just vanishes and the file reverts to whatever OneDrive already had.
 *
 * Minimum viable fix, per that row: track, in memory, the last time each
 * collection was known to be in sync with the remote (a completed pull, or
 * a completed push -- either means "local and remote agree as of now").
 * Before overwriting local with a fresh pull, compare the local file's own
 * mtime against that timestamp; if the file was touched more recently than
 * our last known-good sync point, something wrote to it since we last
 * confirmed a match and skipping (with a loud log entry) is safer than
 * blindly clobbering an edit that may not be on OneDrive yet. `force:true`
 * bypasses this the same way it already bypasses the massacre guard.
 *
 * In-memory only, not persisted -- scoped to this process's lifetime, same
 * as this file's `_client`/`_cache` in lib/secrets.js. A restart re-pulls
 * with no baseline, which is the existing (safe) bootstrap behaviour.
 *
 * Keyed by store instance (WeakMap), not a bare module-level Map keyed by
 * relPath alone -- a real process only ever has one vault store, so this
 * makes no practical difference there, but it keeps every test's own
 * tmpStore() genuinely isolated (each gets its own fresh sync-point map)
 * instead of tests colliding on the same collection name across different
 * temp directories.
 *
 * The sync point recorded for a collection is the file's OWN mtime at the
 * moment we last confirmed it matched remote (via store.statMtimeMs right
 * after the pull/push completes), not a separately-captured Date.now().
 * Comparing mtime-to-mtime keeps both sides of the guard on the same clock
 * and the same (sub-millisecond) precision -- Date.now() truncates to whole
 * milliseconds while fs mtime doesn't, so a write and an independently
 * captured "now" landing in the same millisecond could otherwise compare as
 * "mtime is newer" purely from truncation, even when the write genuinely
 * happened first.
 */
const lastSyncedAtByStore = new WeakMap(); // store -> Map(relPath -> mtimeMs as of last confirmed pull/push)

function syncPoints(store) {
  let m = lastSyncedAtByStore.get(store);
  if (!m) { m = new Map(); lastSyncedAtByStore.set(store, m); }
  return m;
}

/** Record relPath as in sync as of its current on-disk mtime, if the store can report one. */
function markSynced(store, relPath) {
  if (typeof store.statMtimeMs !== 'function') return;
  const mtimeMs = store.statMtimeMs(relPath);
  if (mtimeMs != null) syncPoints(store).set(relPath, mtimeMs);
}

function localEditedSinceLastSync(store, relPath) {
  if (typeof store.statMtimeMs !== 'function') return false; // test doubles without the method: guard is a no-op, not a crash
  const lastSync = syncPoints(store).get(relPath);
  if (lastSync == null) return false; // no known-good baseline yet (first pull, or a store without statMtimeMs) -- proceed as before
  const mtimeMs = store.statMtimeMs(relPath);
  return mtimeMs != null && mtimeMs > lastSync;
}

// The verified-correct root, confirmed directly against OneDrive via rclone
// (not the legacy monolith's stale WORKSPACE_DRIVE_DIR constant).
const REMOTE_ROOT = 'Sconl/Core/Apex/Vault/vault-documents/isconl-vault';

// finance/ deliberately lives on its own OneDrive root, not under
// REMOTE_ROOT -- carried over from the legacy monolith's FINANCE_DRIVE_DIR
// (server.js:1743), confirmed live via a direct Graph /children call
// (2026-08-14): finance/receipts and finance/*.tsv are real there.
const FINANCE_ROOT = 'Sconl/Core/Apex/Vault/vault-documents/finance';

/**
 * A collection's relPath (e.g. "finance/accounts.tsv") is the local vault's
 * naming, which does not always match the remote layout: finance/ collections
 * live directly under FINANCE_ROOT with the "finance/" prefix stripped
 * (FINANCE_ROOT already points at .../vault-documents/finance), everything
 * else lives under REMOTE_ROOT unchanged.
 */
function resolveRemotePath(relPath) {
  if (relPath.startsWith('finance/')) {
    return `${FINANCE_ROOT}/${relPath.slice('finance/'.length)}`;
  }
  return `${REMOTE_ROOT}/${relPath}`;
}

/**
 * Fetch one collection's raw text content from OneDrive via Graph, without
 * touching local state. Returns { ok, rows, raw, bytes } on success, or
 * { ok: false, status, error } on any failure (missing file, auth, etc) --
 * never throws, so a caller can report a clean status either way.
 */
async function fetchRemoteText(graph, relPath) {
  const drivePath = resolveRemotePath(relPath);
  const res = await graph.graphRequest(
    `/v1.0/me/drive/root:/${encodeURIComponent(drivePath).replace(/%2F/g, '/')}:/content`,
  );
  if (res.status !== 200) {
    return { ok: false, status: res.status, error: typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : String(res.data || '').slice(0, 200) };
  }
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  return { ok: true, raw, bytes: Buffer.byteLength(raw, 'utf8') };
}

/**
 * Same fetch as fetchRemoteText, but for non-TSV files (JSON/YAML/markdown)
 * where preserving the remote's own formatting matters (a diff-friendly
 * pretty-printed JSON file, not a re-minified one). graph.graphRequest
 * already JSON.parses any response that parses cleanly (graph.js's
 * httpsRequest) -- fetchRemoteText's plain JSON.stringify(res.data) would
 * lose that formatting for a real JSON file, so this re-pretty-prints
 * objects instead and leaves already-string responses (markdown, YAML,
 * anything that isn't valid JSON) untouched.
 */
async function fetchRemoteRaw(graph, relPath) {
  const drivePath = resolveRemotePath(relPath);
  const res = await graph.graphRequest(
    `/v1.0/me/drive/root:/${encodeURIComponent(drivePath).replace(/%2F/g, '/')}:/content`,
  );
  if (res.status !== 200) {
    return { ok: false, status: res.status, error: typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : String(res.data || '').slice(0, 200) };
  }
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
  return { ok: true, raw, bytes: Buffer.byteLength(raw, 'utf8') };
}

/** True for the TSV collections the schema knows how to parse as rows; false for JSON/YAML/markdown state files pulled/checked as raw text instead. */
function isTSV(relPath) {
  return /\.tsv$/i.test(relPath);
}

/**
 * List one remote folder's direct children (files only, non-recursive --
 * every known use of this so far, the learning classroom's per-course
 * folders, is a flat list of .md files with no subfolders). Never throws;
 * { ok: false } on any failure, same contract as fetchRemoteRaw.
 */
async function listRemoteFolder(graph, relPath) {
  const drivePath = resolveRemotePath(relPath);
  const res = await graph.graphRequest(
    `/v1.0/me/drive/root:/${encodeURIComponent(drivePath).replace(/%2F/g, '/')}:/children`,
  );
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.value)) {
    return { ok: false, status: res.status, error: typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : String(res.data || '').slice(0, 200) };
  }
  const files = res.data.value.filter((i) => i.file).map((i) => i.name);
  return { ok: true, files };
}

/**
 * List one remote folder's direct SUBFOLDERS (not files) at an ABSOLUTE
 * drive path -- deliberately bypasses resolveRemotePath's REMOTE_ROOT/
 * FINANCE_ROOT prefixing, since the caller (corporate-discovery.js) scans
 * `Sconl/Core/Axial/Visionary/Corporate/`, a tree outside both of those
 * roots. Same never-throws contract as listRemoteFolder.
 */
async function listRemoteFoldersAbsolute(graph, absolutePath) {
  const res = await graph.graphRequest(
    `/v1.0/me/drive/root:/${encodeURIComponent(absolutePath).replace(/%2F/g, '/')}:/children`,
  );
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.value)) {
    return { ok: false, status: res.status, error: typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : String(res.data || '').slice(0, 200) };
  }
  const folders = res.data.value.filter((i) => i.folder).map((i) => ({ name: i.name, createdDateTime: i.createdDateTime || null }));
  return { ok: true, folders };
}

/**
 * Pull every file directly inside one remote folder into the local vault,
 * one raw pull per file (each gets its own previous-version-kept safety
 * net via pullToLocalRaw/store.rawWrite -- no separate guard here). Built
 * for the learning classroom's per-course lesson folders
 * (learning/<courseId>/*.md), where the filenames aren't known in advance
 * the way a fixed TSV/JSON collection's path is.
 *
 * `delayMs` (added FI26082201, 24 Aug 2026): a small pause between each
 * file's Graph GET. sync-loop.js already pauses between top-level
 * collections for exactly this reason ("kind to Graph's throttling"), but
 * this inner per-file loop had no equivalent -- a folder with 20-30 files
 * (viva-tasks, viva-portals, etc) fired that many GETs back-to-back with
 * zero pacing, which was enough to trip Graph's rate limiting; the *next*
 * folder's listing call (a fresh `:children` request) would then come back
 * itemNotFound-shaped rather than a clean throttling error, making it look
 * like the folder didn't exist when it actually did (confirmed: a lone,
 * unhurried call to the same path always succeeded). The delay alone cut
 * failures from 8/12 folders to 2-3/12 in testing, not zero -- Graph's
 * throttling window outlasts one folder's worth of pacing under a big
 * sync-all run, so the listing call below also gets one retry after a
 * short backoff before it's reported as a real failure.
 */
async function pullFolder(graph, store, relPath, { force = false, delayMs = 150 } = {}) {
  let listing = await listRemoteFolder(graph, relPath);
  if (!listing.ok) {
    await new Promise((res) => setTimeout(res, 1000));
    listing = await listRemoteFolder(graph, relPath);
  }
  if (!listing.ok) return { folder: relPath, ok: false, status: listing.status, error: listing.error };
  const results = { folder: relPath, ok: true, files: [] };
  for (const name of listing.files) {
    const filePath = `${relPath}/${name}`;
    const r = await pullToLocalRaw(graph, store, filePath, { force });
    results.files.push({ file: name, ...r });
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  }
  return results;
}

/**
 * Read-only remote-vs-local check for a non-TSV collection -- byte/line
 * comparison only, since there's no row model to compare by count the way
 * checkRemote does for TSVs.
 */
async function checkRemoteRaw(graph, relPath, localText) {
  const remote = await fetchRemoteRaw(graph, relPath);
  if (!remote.ok) {
    return { collection: relPath, ok: false, status: remote.status, error: remote.error };
  }
  return {
    collection: relPath,
    ok: true,
    remoteBytes: remote.bytes,
    localBytes: Buffer.byteLength(localText || '', 'utf8'),
    matches: remote.raw === localText,
  };
}

/**
 * Pull a non-TSV collection's real OneDrive content into the local vault via
 * store.rawWrite() -- same previous-version-kept safety net as pullToLocal,
 * with the massacre guard judged by byte count (blocks emptying a file that
 * had real content) rather than row count.
 */
async function pullToLocalRaw(graph, store, relPath, { force = false } = {}) {
  if (!force && localEditedSinceLastSync(store, relPath)) {
    // ok:true, not a failure -- this is the guard correctly declining to
    // overwrite, not a broken sync. Reporting it as failed would trip the
    // same "sync is failing" banner FI26082704 is about, for a benign,
    // working-as-designed skip. `skipped` still makes it visible to
    // whoever reads a sync pass's results, just not alarm-shaped.
    return { collection: relPath, ok: true, skipped: 'local-newer', note: 'local file edited since last known-good sync; pull skipped to avoid overwriting an unpushed local edit (FI26082702) -- pass force:true to override' };
  }
  const remote = await fetchRemoteRaw(graph, relPath);
  if (!remote.ok) {
    return { collection: relPath, ok: false, status: remote.status, error: remote.error };
  }
  const before = store.rawRead(relPath);
  store.rawWrite(relPath, remote.raw, { force });
  // Same INC-002 spirit as pullToLocal above: re-read actual local state
  // rather than assuming remote.raw landed byte-for-byte. Note rawWrite's
  // own guard (store.js) is narrower than rewriteTSV's and behaves
  // differently on refusal -- it only blocks emptying a non-empty file down
  // to nothing (not a proportional "more than half" drop), and it THROWS
  // rather than silently no-op'ing, so a real refusal here propagates as an
  // exception (caught by this function's own caller, e.g. sync-loop.js's
  // per-collection try/catch) instead of reaching this return at all. This
  // re-read still matters for any other reason "after" could differ from
  // what was attempted (a concurrent write landing in between, etc).
  const after = store.rawRead(relPath);
  markSynced(store, relPath);
  return {
    collection: relPath, ok: true,
    remoteBytes: remote.bytes,
    localBytesBefore: before.length, localBytesAfter: after.length,
  };
}

/**
 * Compare one collection's real OneDrive content against the local vault
 * copy. Read-only on both sides -- reports, never writes.
 */
async function checkRemote(graph, relPath, localRows) {
  const remote = await fetchRemoteText(graph, relPath);
  if (!remote.ok) {
    return { collection: relPath, ok: false, status: remote.status, error: remote.error };
  }
  const remoteRows = parseTSVText(remote.raw);
  return {
    collection: relPath,
    ok: true,
    remoteBytes: remote.bytes,
    remoteRowCount: remoteRows.length,
    localRowCount: localRows.length,
    matches: remoteRows.length === localRows.length,
    // First/last row IDs, as a cheap eyeball check without dumping full content.
    remoteSample: remoteRows.slice(0, 1).map(r => r.ID || r.NAME || Object.values(r)[0]),
  };
}

/**
 * Pull one collection's real OneDrive content down into the local vault,
 * replacing whatever's there now. Uses store.rewrite() -- previous local
 * content is kept as a backup version (keepPreviousVersion, already wired
 * into rewrite), and the massacre guard still applies (a pull that would
 * DROP more than half of an already-populated local file needs force:true,
 * same as any other rewrite -- growing from empty is never blocked).
 */
async function pullToLocal(graph, store, relPath, { force = false } = {}) {
  if (!force && localEditedSinceLastSync(store, relPath)) {
    // ok:true, not a failure -- this is the guard correctly declining to
    // overwrite, not a broken sync. Reporting it as failed would trip the
    // same "sync is failing" banner FI26082704 is about, for a benign,
    // working-as-designed skip. `skipped` still makes it visible to
    // whoever reads a sync pass's results, just not alarm-shaped.
    return { collection: relPath, ok: true, skipped: 'local-newer', note: 'local file edited since last known-good sync; pull skipped to avoid overwriting an unpushed local edit (FI26082702) -- pass force:true to override' };
  }
  const remote = await fetchRemoteText(graph, relPath);
  if (!remote.ok) {
    return { collection: relPath, ok: false, status: remote.status, error: remote.error };
  }
  // FI26082901: reject the pull if the remote header starts with a tab.
  // A leading-tab column shift is a known corruption pattern: every column
  // is read one place to the right of its actual schema position, producing
  // rows where ID='-', TITLE='-' etc. while real data lands in wrong fields.
  // The remote file is the source of truth only if it isn't corrupted --
  // a corrupted pull would OVERWRITE a clean local file and then be pushed
  // back to OneDrive on the next write-then-push hook, perpetuating the
  // damage on every sync tick. Refuse rather than silently propagate.
  if (isTSV(relPath) && remote.raw && remote.raw.startsWith('\t')) {
    return {
      collection: relPath, ok: false,
      error: 'FI26082901: remote header starts with a leading tab (column-shift corruption) -- pull refused to protect local copy; push the clean local version to OneDrive to resolve',
    };
  }
  const remoteRows = parseTSVText(remote.raw);
  const before = store.read(relPath).length;
  store.rewrite(relPath, () => remoteRows, { force });
  // Re-read what's actually on disk now (INC-002 fix, 18 Aug 2026) -- rewrite()
  // can silently refuse via the massacre guard (rewriteTSV's own
  // vault_bulk_delete_refused path), in which case local is untouched even
  // though this function attempted to write remoteRows. Reporting
  // remoteRows.length unconditionally here made a correctly-refused pull
  // look identical to a successful one in every caller's eyes (sync-status
  // logs, /onedrive/check) -- this is what made INC-002 look like the guard
  // had failed when it had actually done its job correctly every time.
  const after = store.read(relPath).length;
  markSynced(store, relPath);
  return {
    collection: relPath, ok: true,
    remoteBytes: remote.bytes, remoteRowCount: remoteRows.length,
    localRowCountBefore: before, localRowCountAfter: after,
    refused: after === before && before !== remoteRows.length,
  };
}

/**
 * PUT one local vault file's current raw bytes up to OneDrive, overwriting
 * whatever is there now. Read-then-PUT of whatever's already on disk --
 * not the parsed-row model pullToLocal uses on the way down, since the
 * local file is already the byte-correct source of truth here and doesn't
 * need re-serializing. Refuses to push an empty/missing local file (that's
 * always a bug upstream, never an intentional "delete everything" -- a real
 * delete belongs in a dedicated path with its own confirmation, not this one).
 */
async function pushToRemote(graph, store, relPath) {
  const local = store.rawRead(relPath);
  if (!local) return { collection: relPath, ok: false, error: 'local file empty or missing, refusing to push nothing' };
  const drivePath = resolveRemotePath(relPath);
  const res = await graph.graphRequest(
    `/v1.0/me/drive/root:/${encodeURIComponent(drivePath).replace(/%2F/g, '/')}:/content`,
    { method: 'PUT', body: local, headers: { 'Content-Type': 'text/plain' } },
  );
  if (res.status !== 200 && res.status !== 201) {
    return { collection: relPath, ok: false, status: res.status, error: typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : String(res.data || '').slice(0, 200) };
  }
  // Local and remote are confirmed to agree as of now -- a push is as much
  // a "known-good sync point" as a pull is, so the next pull tick shouldn't
  // treat this same edit as unsynced and needlessly skip itself.
  markSynced(store, relPath);
  return { collection: relPath, ok: true, bytes: Buffer.byteLength(local, 'utf8') };
}

module.exports = {
  REMOTE_ROOT, FINANCE_ROOT, isTSV,
  fetchRemoteText, checkRemote, pullToLocal,
  fetchRemoteRaw, checkRemoteRaw, pullToLocalRaw,
  listRemoteFolder, listRemoteFoldersAbsolute, pullFolder,
  pushToRemote,
};
