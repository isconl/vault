'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncLoop, allCollections } = require('../lib/sync-loop');
const defaultSchema = require('../lib/default-schema');

function fakeOnedriveSync({ failCollections = [] } = {}) {
  const tsvCalls = [];
  const rawCalls = [];
  return {
    tsvCalls, rawCalls,
    pullToLocal: async (graph, store, relPath) => {
      tsvCalls.push(relPath);
      if (failCollections.includes(relPath)) return { collection: relPath, ok: false, status: 404, error: 'not found' };
      return { collection: relPath, ok: true, remoteRowCount: 1, localRowCountBefore: 0, localRowCountAfter: 1 };
    },
    pullToLocalRaw: async (graph, store, relPath) => {
      rawCalls.push(relPath);
      if (failCollections.includes(relPath)) return { collection: relPath, ok: false, status: 404, error: 'not found' };
      return { collection: relPath, ok: true, remoteBytes: 10, localBytesBefore: 0, localBytesAfter: 10 };
    },
  };
}

function fakeAuditLog() {
  const events = [];
  return { events, log: (event, data) => events.push({ event, data }) };
}

test('allCollections includes every schema TSV, the extra finance TSVs, and the raw state files', () => {
  const { tsv, raw } = allCollections();
  for (const rel of Object.keys(defaultSchema)) assert.ok(tsv.includes(rel), `missing schema collection ${rel}`);
  assert.ok(tsv.includes('finance/moves.tsv'));
  assert.ok(tsv.includes('finance/wishlist.tsv'));
  assert.ok(raw.includes('scope/calendar_events.json'));
  assert.ok(raw.includes('personal/rhythm.json'));
});

test('runOnce pulls every TSV and raw collection exactly once, in one pass', async () => {
  const onedriveSync = fakeOnedriveSync();
  const loop = createSyncLoop({ onedriveSync, graph: {}, store: {}, delayMs: 0 });
  const result = await loop.runOnce();

  const { tsv, raw } = allCollections();
  assert.equal(onedriveSync.tsvCalls.length, tsv.length);
  assert.equal(onedriveSync.rawCalls.length, raw.length);
  assert.equal(result.ok.length, tsv.length + raw.length);
  assert.equal(result.failed.length, 0);
});

test('one failing collection does not block the rest of the pass', async () => {
  const onedriveSync = fakeOnedriveSync({ failCollections: ['scope/tasks.tsv', 'personal/rhythm.json'] });
  const loop = createSyncLoop({ onedriveSync, graph: {}, store: {}, delayMs: 0 });
  const result = await loop.runOnce();

  const { tsv, raw } = allCollections();
  assert.equal(onedriveSync.tsvCalls.length, tsv.length, 'every TSV collection was still attempted');
  assert.equal(onedriveSync.rawCalls.length, raw.length, 'every raw collection was still attempted');
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.some(f => f.collection === 'scope/tasks.tsv'));
  assert.ok(result.failed.some(f => f.collection === 'personal/rhythm.json'));
});

test('a collection whose pull throws is recorded as failed, not left uncaught', async () => {
  const onedriveSync = {
    pullToLocal: async (g, s, rel) => { if (rel === 'scope/tasks.tsv') throw new Error('massacre guard tripped'); return { collection: rel, ok: true }; },
    pullToLocalRaw: async (g, s, rel) => ({ collection: rel, ok: true }),
  };
  const loop = createSyncLoop({ onedriveSync, graph: {}, store: {}, delayMs: 0 });
  const result = await loop.runOnce();
  const failure = result.failed.find(f => f.collection === 'scope/tasks.tsv');
  assert.ok(failure, 'thrown error was caught and recorded');
  assert.ok(failure.error.includes('massacre guard tripped'));
});

test('runOnce logs a summary to the audit log', async () => {
  const onedriveSync = fakeOnedriveSync({ failCollections: ['scope/tasks.tsv'] });
  const auditLog = fakeAuditLog();
  const loop = createSyncLoop({ onedriveSync, graph: {}, store: {}, auditLog, delayMs: 0 });
  await loop.runOnce();

  const summary = auditLog.events.find(e => e.event === 'onedrive_sync_pass');
  assert.ok(summary);
  assert.equal(summary.data.failed, 1);
  assert.ok(summary.data.failedCollections.includes('scope/tasks.tsv'));
});

test('a second runOnce while one is already in flight is skipped, not run concurrently', async () => {
  let resolveFirst;
  const onedriveSync = {
    pullToLocal: async (g, s, rel) => {
      if (rel === Object.keys(defaultSchema)[0]) await new Promise((res) => { resolveFirst = res; });
      return { collection: rel, ok: true };
    },
    pullToLocalRaw: async (g, s, rel) => ({ collection: rel, ok: true }),
  };
  const loop = createSyncLoop({ onedriveSync, graph: {}, store: {}, delayMs: 0 });

  const first = loop.runOnce();
  await new Promise((res) => setTimeout(res, 10)); // let it enter the in-flight state
  const second = await loop.runOnce();
  assert.equal(second.skipped, 'already running');

  resolveFirst();
  await first;
});

test('getLastResult reflects the most recent completed pass', async () => {
  const onedriveSync = fakeOnedriveSync();
  const loop = createSyncLoop({ onedriveSync, graph: {}, store: {}, delayMs: 0 });
  assert.equal(loop.getLastResult(), null);
  await loop.runOnce();
  assert.ok(loop.getLastResult());
  assert.equal(loop.getLastResult().failed.length, 0);
});
