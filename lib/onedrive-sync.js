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
 * PUSH (local -> remote, writing to OneDrive itself) is deliberately still
 * not here -- that's real risk (a bug overwrites something irreplaceable)
 * and gets its own careful pass, not a rush alongside everything else.
 */

const { parseTSVText } = require('./tsv');

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
  const remote = await fetchRemoteText(graph, relPath);
  if (!remote.ok) {
    return { collection: relPath, ok: false, status: remote.status, error: remote.error };
  }
  const remoteRows = parseTSVText(remote.raw);
  const before = store.read(relPath).length;
  store.rewrite(relPath, () => remoteRows, { force });
  return {
    collection: relPath, ok: true,
    remoteBytes: remote.bytes, remoteRowCount: remoteRows.length,
    localRowCountBefore: before, localRowCountAfter: remoteRows.length,
  };
}

module.exports = { REMOTE_ROOT, FINANCE_ROOT, fetchRemoteText, checkRemote, pullToLocal };
