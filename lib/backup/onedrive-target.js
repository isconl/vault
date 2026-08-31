'use strict';
/**
 * BI26083004: the real BackupTarget implementation (see backup-target.js
 * for the interface contract) -- OneDrive, one encrypted-DB blob per
 * generation plus a small unencrypted manifest sidecar.
 *
 * Deliberately a NEW, dedicated remote folder, not the existing
 * onedrive-sync.js REMOTE_ROOT (the old per-collection TSV sync tree) --
 * that tree is being retired (BI26083005) and mixing the old per-file
 * layout with this new single-blob-per-generation layout in the same
 * folder would be confusing during the transition.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { uploadVerified, downloadBinary } = require('../graph');
const onedriveBrowse = require('../onedrive-browse');

const BACKUP_FOLDER = 'Sconl/Core/Apex/Vault/vault-backups/vault';

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}
function monthKey(d) { return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; }

/**
 * Pure grandfather-father-son bucket math, factored out of prune() so it's
 * directly unit-testable against a synthetic list() result without needing
 * to mock dozens of Graph calls for a multi-month generation history.
 * `generations` must already be sorted newest-first (list()'s own contract).
 * Returns the Set of refs to KEEP -- prune() removes everything else.
 */
function refsToKeep(generations, { dailyCount = 7, weeklyCount = 4, monthlyCount = 3 } = {}) {
  const keep = new Set();
  generations.slice(0, dailyCount).forEach((g) => keep.add(g.ref));

  const seenWeeks = new Set();
  for (const g of generations) {
    const wk = isoWeekKey(new Date(g.timestampIso));
    if (seenWeeks.has(wk)) continue;
    seenWeeks.add(wk);
    if (seenWeeks.size > weeklyCount) break;
    keep.add(g.ref);
  }

  const seenMonths = new Set();
  for (const g of generations) {
    const mk = monthKey(new Date(g.timestampIso));
    if (seenMonths.has(mk)) continue;
    seenMonths.add(mk);
    if (seenMonths.size > monthlyCount) break;
    keep.add(g.ref);
  }

  return keep;
}

function isoBasic(d = new Date()) {
  // e.g. vault-20260830T140512Z.db -- ISO 8601 basic form, filesystem/URL-safe.
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function extractError(res) {
  return typeof res.data === 'object' ? JSON.stringify(res.data).slice(0, 200) : String(res.data || '').slice(0, 200);
}

/**
 * @param {object} opts
 * @param {object} opts.graph - a createGraphClient() instance
 * @param {Function} [opts.httpsRequestFn] - passed through to graph.js's uploadVerified(); injectable for testing without a live network call
 * @param {Function} [opts.binaryGetFn] - passed through to graph.js's downloadBinary(); injectable for testing
 * @returns {import('./backup-target').BackupTarget}
 */
function createOneDriveBackupTarget({ graph, httpsRequestFn, binaryGetFn }) {
  async function push(localFilePath, meta = {}) {
    const sizeBytes = fs.statSync(localFilePath).size;
    const sha256 = await sha256File(localFilePath);
    const timestamp = isoBasic();
    const ref = `vault-${timestamp}.db`;

    const sessionRes = await graph.graphRequest(
      `/v1.0/me/drive/root:/${encodeURIComponent(`${BACKUP_FOLDER}/${ref}`).replace(/%2F/g, '/')}:/createUploadSession`,
      { method: 'POST', body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) },
    );
    if (sessionRes.status !== 200 || !sessionRes.data?.uploadUrl) {
      return { ok: false, error: extractError(sessionRes) };
    }

    const buffer = fs.readFileSync(localFilePath);
    const uploadResult = httpsRequestFn
      ? await uploadVerified(graph, sessionRes.data.uploadUrl, buffer, undefined, httpsRequestFn)
      : await uploadVerified(graph, sessionRes.data.uploadUrl, buffer);
    if (!uploadResult.ok) return uploadResult;

    const manifest = { timestampIso: new Date().toISOString(), sizeBytes, sha256, schemaVersion: 1, ...meta };
    const manifestRes = await onedriveBrowse.upload(graph, BACKUP_FOLDER, `vault-${timestamp}.manifest.json`, JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
    if (!manifestRes.ok) return { ok: false, error: `db uploaded but manifest failed: ${manifestRes.error}` };

    return { ok: true, ref };
  }

  async function list() {
    const res = await onedriveBrowse.listFolder(graph, BACKUP_FOLDER);
    if (!res.ok) return res;

    const dbFiles = res.items.filter((i) => i.name.endsWith('.db'));
    const manifestByStem = new Map();
    for (const item of res.items) {
      if (!item.name.endsWith('.manifest.json')) continue;
      manifestByStem.set(item.name.replace(/\.manifest\.json$/, ''), item);
    }

    const generations = [];
    for (const db of dbFiles) {
      const stem = db.name.replace(/\.db$/, '');
      const manifestItem = manifestByStem.get(stem);
      if (!manifestItem) continue; // orphaned .db with no manifest -- not a listable generation
      const preview = await onedriveBrowse.getItemPreview(graph, manifestItem.id);
      if (!preview.ok || !preview.isText) continue;
      let manifest;
      try { manifest = JSON.parse(preview.textContent); } catch { continue; }
      generations.push({ ref: db.name, timestampIso: manifest.timestampIso, sizeBytes: manifest.sizeBytes, sha256: manifest.sha256 });
    }
    generations.sort((a, b) => (a.timestampIso < b.timestampIso ? 1 : -1)); // newest first
    return { ok: true, generations };
  }

  async function fetch(ref, destPath) {
    const listRes = await list();
    if (!listRes.ok) return listRes;
    const gen = listRes.generations.find((g) => g.ref === ref);
    if (!gen) return { ok: false, error: `no generation found for ref ${ref}` };

    const drivePath = `${BACKUP_FOLDER}/${ref}`;
    const dl = binaryGetFn ? await downloadBinary(graph, drivePath, binaryGetFn) : await downloadBinary(graph, drivePath);
    if (!dl.ok) return dl;

    const actualSha256 = crypto.createHash('sha256').update(dl.buffer).digest('hex');
    if (actualSha256 !== gen.sha256) {
      return { ok: false, error: `checksum mismatch: manifest says ${gen.sha256}, downloaded content hashes to ${actualSha256}` };
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, dl.buffer);
    return { ok: true, path: destPath };
  }

  /**
   * Fixed grandfather-father-son retention (v1, not user-configurable):
   * 7 most recent daily generations, plus the most recent generation from
   * each of the last 4 distinct calendar weeks, plus the most recent
   * generation from each of the last 3 distinct calendar months. A
   * generation satisfying more than one bucket is kept once, not deleted
   * as a false "extra."
   */
  async function prune(keepPolicy = {}) {
    const listRes = await list();
    if (!listRes.ok) return listRes;
    const generations = listRes.generations; // already newest-first

    const keep = refsToKeep(generations, keepPolicy);
    const toRemove = generations.filter((g) => !keep.has(g.ref));
    if (!toRemove.length) return { ok: true, removed: [] };

    const folderRes = await onedriveBrowse.listFolder(graph, BACKUP_FOLDER);
    if (!folderRes.ok) return folderRes;
    const removed = [];
    for (const g of toRemove) {
      const dbItem = folderRes.items.find((i) => i.name === g.ref);
      const manifestItem = folderRes.items.find((i) => i.name === g.ref.replace(/\.db$/, '.manifest.json'));
      if (dbItem) await onedriveBrowse.deleteItem(graph, dbItem.id);
      if (manifestItem) await onedriveBrowse.deleteItem(graph, manifestItem.id);
      removed.push(g.ref);
    }
    return { ok: true, removed };
  }

  return { push, list, fetch, prune };
}

module.exports = { createOneDriveBackupTarget, BACKUP_FOLDER, refsToKeep };
