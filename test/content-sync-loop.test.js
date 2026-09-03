'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContentSyncLoop } = require('../lib/content-sync-loop');

function tmpMemoryDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-sync-loop-'));
  fs.mkdirSync(path.join(dir, 'learning'), { recursive: true });
  return dir;
}

function fakeStore() {
  const raw = new Map();
  return {
    read: () => [],
    append: () => true,
    rewrite: (relPath, fn) => { const kept = fn([]); return -kept.length; },
    rawRead: (relPath) => (raw.get(relPath) || {}).content || '',
    rawWrite: (relPath, contents) => raw.set(relPath, { content: contents, updatedAtMs: Date.now() }),
    statMtimeMs: (relPath) => (raw.get(relPath) || {}).updatedAtMs ?? null,
  };
}

test('runOnce reports ok:true with counts when nothing is queued to sync', async () => {
  const memoryDir = tmpMemoryDir();
  const loop = createContentSyncLoop({ store: fakeStore(), memoryDir, statePath: path.join(memoryDir, 'state.json') });

  const result = await loop.runOnce();

  assert.equal(result.ok, true);
  assert.equal(result.syncedCount, 0);
  assert.equal(result.conflictCount, 0);
  assert.equal(typeof result.totalChecked, 'number');
});

test('start() fires an immediate pass, and stop() prevents any further scheduled pass', async () => {
  const memoryDir = tmpMemoryDir();
  const loop = createContentSyncLoop({ store: fakeStore(), memoryDir, statePath: path.join(memoryDir, 'state.json') });

  loop.start(50);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(loop.getLastResult(), 'the immediate pass on start() should have completed by now');

  loop.stop();
  const afterStop = loop.getLastResult();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(loop.getLastResult(), afterStop, 'no further pass should have run after stop()');
});

test('a broken store surfaces ok:false with the error message, rather than throwing out of runOnce', async () => {
  const memoryDir = tmpMemoryDir();
  const brokenStore = {
    read: () => { throw new Error('boom'); },
    append: () => true, rewrite: () => 0, rawRead: () => '', rawWrite: () => {}, statMtimeMs: () => null,
  };
  fs.writeFileSync(path.join(memoryDir, 'learning', 'courses.tsv'), 'ID\tTITLE\nx\ty\n');
  const loop = createContentSyncLoop({ store: brokenStore, memoryDir, statePath: path.join(memoryDir, 'state.json') });

  const result = await loop.runOnce();

  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
});
