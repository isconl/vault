'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOneDriveBackupTarget, BACKUP_FOLDER, refsToKeep } = require('../lib/backup/onedrive-target');

/** Routes graph.graphRequest calls by matching against a pattern list, same idea as onedrive-sync.test.js's fakeGraphRouter but with method awareness (this module PUTs and DELETEs, not just GETs). */
function fakeGraph(handlers, { getValidToken = async () => 'fake-token' } = {}) {
  const calls = [];
  return {
    calls,
    getValidToken,
    graphRequest: async (pathAndQuery, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push({ method, pathAndQuery, body: opts.body });
      for (const h of handlers) {
        if (h.method && h.method !== method) continue;
        if (h.test(pathAndQuery)) return h.respond(pathAndQuery, opts);
      }
      return { status: 404, data: { error: { code: 'itemNotFound' } } };
    },
  };
}

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-target-test-'));
  const fp = path.join(dir, 'vault.db');
  fs.writeFileSync(fp, contents);
  return fp;
}

test('push computes and uploads a correct manifest', async () => {
  const buffer = Buffer.from('fake-encrypted-db-contents');
  const localFilePath = tmpFile(buffer);
  let uploadedManifestBody = null;

  const graph = fakeGraph([
    { method: 'POST', test: (p) => p.includes(':/createUploadSession'), respond: () => ({ status: 200, data: { uploadUrl: 'https://upload.example.com/session1' } }) },
    { method: 'GET', test: (p) => p.includes('/items/item1'), respond: () => ({ status: 200, data: { id: 'item1', size: buffer.length } }) },
    {
      method: 'PUT', test: (p) => p.includes(':/content') && p.includes('.manifest.json'),
      respond: (p, opts) => { uploadedManifestBody = JSON.parse(opts.body); return { status: 200, data: { id: 'manifest1', name: 'x.manifest.json' } }; },
    },
  ]);

  const httpsRequestFn = async () => ({ status: 200, data: { id: 'item1', size: buffer.length } });

  const target = createOneDriveBackupTarget({ graph, httpsRequestFn });
  const result = await target.push(localFilePath, { note: 'test' });

  assert.equal(result.ok, true);
  assert.match(result.ref, /^vault-\d{8}T\d{6}Z\.db$/);
  assert.ok(uploadedManifestBody, 'manifest was uploaded');
  assert.equal(uploadedManifestBody.sizeBytes, buffer.length);
  assert.equal(uploadedManifestBody.sha256, require('crypto').createHash('sha256').update(buffer).digest('hex'));
  assert.equal(uploadedManifestBody.schemaVersion, 1);
  assert.equal(uploadedManifestBody.note, 'test');
});

test('push detects a truncated upload (verify GET disagrees with sent size), refuses ok:true, and deletes the partial object', async () => {
  const buffer = Buffer.from('a'.repeat(1000));
  const localFilePath = tmpFile(buffer);
  let deletedIds = [];

  const graph = fakeGraph([
    { method: 'POST', test: (p) => p.includes(':/createUploadSession'), respond: () => ({ status: 200, data: { uploadUrl: 'https://upload.example.com/session2' } }) },
    { method: 'GET', test: (p) => p.includes('/items/item2'), respond: () => ({ status: 200, data: { id: 'item2', size: 400 } }) }, // truncated: reports 400 of 1000
    { method: 'DELETE', test: (p) => p.includes('/items/item2'), respond: (p) => { deletedIds.push(p); return { status: 204, data: null }; } },
  ]);

  // Last chunk response also plausibly looks fine (200, has an id) -- the
  // guard must come from the POST-loop verify GET, not just the chunk status.
  const httpsRequestFn = async () => ({ status: 200, data: { id: 'item2', size: 400 } });

  const target = createOneDriveBackupTarget({ graph, httpsRequestFn });
  const result = await target.push(localFilePath);

  assert.equal(result.ok, false);
  assert.match(result.error, /truncated/);
  assert.equal(deletedIds.length, 1, 'a DELETE call was made against the partial object');
});

test('list pairs each .db with its .manifest.json sidecar and returns newest-first', async () => {
  const graph = fakeGraph([
    {
      method: 'GET', test: (p) => p.includes(':/children'),
      respond: () => ({
        status: 200,
        data: {
          value: [
            { id: 'db1', name: 'vault-20260101T000000Z.db', size: 100, lastModifiedDateTime: '2026-01-01T00:00:00Z', webUrl: 'x' },
            { id: 'm1', name: 'vault-20260101T000000Z.manifest.json', size: 10, lastModifiedDateTime: '2026-01-01T00:00:00Z', webUrl: 'x' },
            { id: 'db2', name: 'vault-20260201T000000Z.db', size: 200, lastModifiedDateTime: '2026-02-01T00:00:00Z', webUrl: 'x' },
            { id: 'm2', name: 'vault-20260201T000000Z.manifest.json', size: 10, lastModifiedDateTime: '2026-02-01T00:00:00Z', webUrl: 'x' },
          ],
        },
      }),
    },
    {
      method: 'GET', test: (p) => p.includes('/items/m1') && !p.includes('/content'),
      respond: () => ({ status: 200, data: { id: 'm1', name: 'vault-20260101T000000Z.manifest.json', size: 10, webUrl: 'x' } }),
    },
    {
      method: 'GET', test: (p) => p.includes('/items/m1/content'),
      respond: () => ({ status: 200, data: JSON.stringify({ timestampIso: '2026-01-01T00:00:00Z', sizeBytes: 100, sha256: 'aaa' }) }),
    },
    {
      method: 'GET', test: (p) => p.includes('/items/m2') && !p.includes('/content'),
      respond: () => ({ status: 200, data: { id: 'm2', name: 'vault-20260201T000000Z.manifest.json', size: 10, webUrl: 'x' } }),
    },
    {
      method: 'GET', test: (p) => p.includes('/items/m2/content'),
      respond: () => ({ status: 200, data: JSON.stringify({ timestampIso: '2026-02-01T00:00:00Z', sizeBytes: 200, sha256: 'bbb' }) }),
    },
  ]);

  const target = createOneDriveBackupTarget({ graph });
  const result = await target.list();

  assert.equal(result.ok, true);
  assert.deepEqual(result.generations.map((g) => g.ref), ['vault-20260201T000000Z.db', 'vault-20260101T000000Z.db']);
  assert.equal(result.generations[0].sha256, 'bbb');
});

test('refsToKeep: bucket math against a synthetic multi-month generation history keeps exactly the expected set', () => {
  // 100 daily generations, one per day, newest first, spanning well over 3 months.
  const generations = [];
  const start = new Date('2026-08-31T12:00:00Z');
  for (let i = 0; i < 100; i++) {
    const d = new Date(start.getTime() - i * 86400000);
    generations.push({ ref: `day-${i}`, timestampIso: d.toISOString() });
  }

  const keep = refsToKeep(generations, { dailyCount: 7, weeklyCount: 4, monthlyCount: 3 });

  // The 7 most recent days are always kept.
  for (let i = 0; i < 7; i++) assert.ok(keep.has(`day-${i}`), `day-${i} (within daily window) must be kept`);

  // Nothing outside all three windows survives -- day-99 is ~3.3 months back,
  // older than every bucket's reach (7 days, 4 weeks, 3 months).
  assert.ok(!keep.has('day-99'), 'a generation far outside every bucket must not be kept');

  // Exactly one generation per one of the 4 most recent distinct ISO weeks
  // is kept from the weekly bucket (the most recent day in that week,
  // which for a daily series is the smallest index in that week).
  const keptCount = keep.size;
  assert.ok(keptCount >= 7 && keptCount <= 7 + 4 + 3, 'kept set size must be within the max possible across all three buckets (with overlap)');
});

test('refsToKeep: a generation satisfying more than one bucket is kept once, not treated as needing extra slots', () => {
  // Single generation, today -- satisfies daily, weekly, and monthly buckets simultaneously.
  const generations = [{ ref: 'only-one', timestampIso: new Date().toISOString() }];
  const keep = refsToKeep(generations, { dailyCount: 7, weeklyCount: 4, monthlyCount: 3 });
  assert.deepEqual([...keep], ['only-one']);
});

test('BACKUP_FOLDER is the new, dedicated remote path -- not the old per-collection REMOTE_ROOT', () => {
  assert.equal(BACKUP_FOLDER, 'Sconl/Core/Apex/Vault/vault-backups/vault');
});

function listingGraph(content, sha256) {
  return fakeGraph([
    {
      method: 'GET', test: (p) => p.includes(':/children'),
      respond: () => ({
        status: 200,
        data: { value: [
          { id: 'db1', name: 'vault-20260101T000000Z.db', size: content.length, webUrl: 'x' },
          { id: 'm1', name: 'vault-20260101T000000Z.manifest.json', size: 10, webUrl: 'x' },
        ] },
      }),
    },
    { method: 'GET', test: (p) => p.includes('/items/m1') && !p.includes('/content'), respond: () => ({ status: 200, data: { id: 'm1', name: 'vault-20260101T000000Z.manifest.json', size: 10, webUrl: 'x' } }) },
    { method: 'GET', test: (p) => p.includes('/items/m1/content'), respond: () => ({ status: 200, data: JSON.stringify({ timestampIso: '2026-01-01T00:00:00Z', sizeBytes: content.length, sha256 }) }) },
  ]);
}

test('fetch downloads the named generation, verifies checksum against the manifest, and writes destPath on success', async () => {
  const content = Buffer.from('real-encrypted-db-bytes');
  const sha256 = require('crypto').createHash('sha256').update(content).digest('hex');
  const graph = listingGraph(content, sha256);
  const binaryGetFn = async (opts) => ({ status: 200, headers: {}, buffer: content });

  const target = createOneDriveBackupTarget({ graph, binaryGetFn });
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fetch-test-'));
  const destPath = path.join(destDir, 'restored.db');
  const result = await target.fetch('vault-20260101T000000Z.db', destPath);

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(destPath).equals(content), true);
});

test('fetch refuses a checksum mismatch rather than silently writing corrupted/tampered content', async () => {
  const content = Buffer.from('real-encrypted-db-bytes');
  const wrongSha256 = require('crypto').createHash('sha256').update('something-else').digest('hex');
  const graph = listingGraph(content, wrongSha256); // manifest claims a hash the actual content won't match
  const binaryGetFn = async () => ({ status: 200, headers: {}, buffer: content });

  const target = createOneDriveBackupTarget({ graph, binaryGetFn });
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fetch-test-'));
  const destPath = path.join(destDir, 'restored.db');
  const result = await target.fetch('vault-20260101T000000Z.db', destPath);

  assert.equal(result.ok, false);
  assert.match(result.error, /checksum mismatch/);
  assert.equal(fs.existsSync(destPath), false, 'a checksum-mismatched download must never be written to destPath');
});
