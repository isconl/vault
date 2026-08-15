'use strict';
/**
 * General-purpose OneDrive browsing -- list/preview/create/upload/rename/
 * move/delete anywhere in the connected OneDrive, not just the known vault
 * collections onedrive-sync.js manages. Paths here are relative to the
 * OneDrive root itself (unprefixed), unlike onedrive-sync.js's
 * resolveRemotePath() which prepends REMOTE_ROOT -- this is the file
 * manager's own path space, the one shown in its breadcrumb trail.
 *
 * Backs hub's /api/onedrive/* routes (webconsole/static/app.js's file
 * manager, built full-featured against a backend that never existed --
 * every route here 501'd until now). Item operations address by Graph's
 * own `id` wherever Graph supports it (rename/move/delete/content), which
 * survives a rename/move mid-session; only list/mkdir/upload are
 * necessarily path-addressed, matching what Graph itself requires.
 */

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdown', 'mkd', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'xml', 'sh', 'log', 'ini', 'conf', 'env',
]);

function encodePathSegments(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Graph's own way to address "this folder" -- root itself, or root:/a/b/c: for a path. */
function driveRootRef(path) {
  const clean = (path || '').replace(/^\/+|\/+$/g, '');
  if (!clean || clean.toLowerCase() === 'root') return '/v1.0/me/drive/root';
  return `/v1.0/me/drive/root:/${encodePathSegments(clean)}:`;
}

function extractError(res) {
  return typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : String(res.data || '').slice(0, 200);
}

/** The one shape every route below returns an item in -- Graph's raw driveItem
 *  trimmed to what the file-manager UI actually reads (app.js's fmGridCard/
 *  fmListRow/fmPreviewItem), plus downloadUrl promoted out of Graph's
 *  `@microsoft.graph.downloadUrl` (a pre-signed, ~1hr-lived direct link) so
 *  the frontend can hand it straight to <img>/<iframe> without a second
 *  round trip through us for every image/PDF in a folder. */
function shapeItem(i) {
  return {
    id: i.id,
    name: i.name,
    size: i.size,
    lastModifiedDateTime: i.lastModifiedDateTime,
    webUrl: i.webUrl,
    downloadUrl: i['@microsoft.graph.downloadUrl'] || null,
    folder: i.folder ? { childCount: i.folder.childCount || 0 } : undefined,
  };
}

async function listFolder(graph, path) {
  const res = await graph.graphRequest(`${driveRootRef(path)}/children?$top=999`);
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.value)) {
    return { ok: false, status: res.status, error: extractError(res) };
  }
  return { ok: true, items: res.data.value.map(shapeItem) };
}

async function getItemMeta(graph, id) {
  const res = await graph.graphRequest(`/v1.0/me/drive/items/${encodeURIComponent(id)}`);
  if (res.status !== 200) return { ok: false, status: res.status, error: extractError(res) };
  return { ok: true, item: shapeItem(res.data) };
}

/** Metadata + text body for previewable types. Binary/Office files still
 *  return metadata (name/size/webUrl/downloadUrl) with isText:false -- the
 *  frontend already handles that by offering Download / Open in OneDrive
 *  rather than expecting inline content. */
async function getItemPreview(graph, id) {
  const metaR = await getItemMeta(graph, id);
  if (!metaR.ok) return metaR;
  const ext = (metaR.item.name.split('.').pop() || '').toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext);
  let textContent = null;
  if (isText) {
    const contentRes = await graph.graphRequest(`/v1.0/me/drive/items/${encodeURIComponent(id)}/content`);
    if (contentRes.status === 200) {
      textContent = typeof contentRes.data === 'string' ? contentRes.data : JSON.stringify(contentRes.data, null, 2);
    }
  }
  return { ok: true, ...metaR.item, isText: isText && textContent !== null, textContent };
}

async function mkdir(graph, parentPath, folderName) {
  const res = await graph.graphRequest(`${driveRootRef(parentPath)}/children`, {
    method: 'POST',
    body: JSON.stringify({ name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
  });
  if (res.status !== 200 && res.status !== 201) return { ok: false, error: extractError(res) };
  return { ok: true, item: shapeItem(res.data) };
}

/** Simple (non-resumable) upload -- fine up to Graph's 4MB simple-upload
 *  ceiling, which covers everything the file manager's <input type=file>
 *  reads as text today (fmUploadFile calls file.text(), so this only ever
 *  receives text content, never a large binary). A resumable-upload session
 *  for large binaries is real future work, not silently pretended here. */
async function upload(graph, folderPath, fileName, content) {
  const clean = (folderPath || '').replace(/^\/+|\/+$/g, '');
  const target = clean ? `${clean}/${fileName}` : fileName;
  const res = await graph.graphRequest(`/v1.0/me/drive/root:/${encodePathSegments(target)}:/content`, {
    method: 'PUT',
    body: content,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (res.status !== 200 && res.status !== 201) return { ok: false, error: extractError(res) };
  return { ok: true, item: shapeItem(res.data) };
}

/** Graph DELETE on a driveItem moves it to the OneDrive recycle bin
 *  (recoverable 30 days), never a hard delete -- matches what app.js's
 *  confirm dialog already promises the user. */
async function deleteItem(graph, id) {
  const res = await graph.graphRequest(`/v1.0/me/drive/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.status !== 204 && res.status !== 200) return { ok: false, error: extractError(res) };
  return { ok: true };
}

/** Rename and move are the same Graph operation (PATCH parentReference/name),
 *  which is why app.js's fmRenameItem and fmMoveItem both call this route. */
async function moveOrRename(graph, id, { newName, toPath } = {}) {
  const body = {};
  if (newName) body.name = newName;
  if (toPath !== undefined) {
    const clean = (toPath || '').replace(/^\/+|\/+$/g, '');
    body.parentReference = { path: clean ? `/drive/root:/${encodePathSegments(clean)}` : '/drive/root:' };
  }
  const res = await graph.graphRequest(`/v1.0/me/drive/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (res.status !== 200) return { ok: false, error: extractError(res) };
  return { ok: true, item: shapeItem(res.data) };
}

module.exports = { listFolder, getItemMeta, getItemPreview, mkdir, upload, deleteItem, moveOrRename };
