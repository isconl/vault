'use strict';
/**
 * BI26083005: extracted from onedrive-sync.js (retired -- its own
 * vault-collection pull/push machinery is superseded by backup-loop.js/
 * onedrive-target.js) because corporate-discovery.js's discoverOrgs()
 * needs this one generic, fully self-contained utility and nothing else
 * from that module -- it doesn't touch vault's store, sync state, or any
 * of the pull/push machinery being deleted.
 */

/** List the direct child FOLDERS of an absolute OneDrive path (not relative to REMOTE_ROOT/FINANCE_ROOT the way onedrive-sync's own helpers were -- corporate-discovery scans a tree outside both). Never throws -- { ok: false } on any listing failure. */
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

module.exports = { listRemoteFoldersAbsolute };
