'use strict';
/**
 * OneDrive sync -- READ PATH ONLY tonight, deliberately.
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
 * Given that, the write path gets its own careful pass, not a rush
 * alongside everything else tonight (explicit instruction, 2026-08-13).
 * This module only ever reads. checkRemote() proves the correct path,
 * proves real content is there, and reports a diff against the local
 * copy -- it changes nothing, locally or remotely.
 */

const { parseTSVText } = require('./tsv');

// The verified-correct root, confirmed directly against OneDrive via rclone
// (not the legacy monolith's stale WORKSPACE_DRIVE_DIR constant).
const REMOTE_ROOT = 'Sconl/Core/Apex/Vault/vault-documents/isconl-vault';

/**
 * Fetch one collection's raw text content from OneDrive via Graph, without
 * touching local state. Returns { ok, rows, raw, bytes } on success, or
 * { ok: false, status, error } on any failure (missing file, auth, etc) --
 * never throws, so a caller can report a clean status either way.
 */
async function fetchRemoteText(graph, relPath) {
  const drivePath = `${REMOTE_ROOT}/${relPath}`;
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

module.exports = { REMOTE_ROOT, fetchRemoteText, checkRemote };
