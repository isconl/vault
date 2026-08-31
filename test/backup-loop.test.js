'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBackupLoop } = require('../lib/backup-loop');

function fakeStore({ memoryDir, snapshotError = null } = {}) {
  const dir = memoryDir || fs.mkdtempSync(path.join(os.tmpdir(), 'backup-loop-store-'));
  const snapshotCalls = [];
  return {
    memoryDir: dir,
    snapshotCalls,
    snapshotToFile: (destPath) => {
      snapshotCalls.push(destPath);
      if (snapshotError) throw snapshotError;
      fs.writeFileSync(destPath, 'fake-encrypted-snapshot-bytes');
    },
  };
}

function fakeBackupTarget({ pushOk = true, pruneOk = true } = {}) {
  const pushCalls = [];
  const pruneCalls = [];
  return {
    pushCalls, pruneCalls,
    push: async (localFilePath, meta) => {
      pushCalls.push({ localFilePath, meta, contents: fs.readFileSync(localFilePath, 'utf8') });
      return pushOk ? { ok: true, ref: 'vault-fake.db' } : { ok: false, error: 'push failed' };
    },
    prune: async (keepPolicy) => {
      pruneCalls.push(keepPolicy);
      return pruneOk ? { ok: true, removed: ['vault-old.db'] } : { ok: false, error: 'prune failed' };
    },
  };
}

test('runOnce snapshots the store, pushes it, prunes, and reports a successful result', async () => {
  const store = fakeStore();
  const backupTarget = fakeBackupTarget();
  const loop = createBackupLoop({ store, backupTarget });

  const result = await loop.runOnce();

  assert.equal(result.ok, true);
  assert.equal(result.ref, 'vault-fake.db');
  assert.deepEqual(result.pruned, ['vault-old.db']);
  assert.equal(store.snapshotCalls.length, 1);
  assert.equal(backupTarget.pushCalls.length, 1);
  assert.equal(backupTarget.pushCalls[0].contents, 'fake-encrypted-snapshot-bytes');
  assert.equal(backupTarget.pruneCalls.length, 1);
});

test('the snapshot temp file is cleaned up after a successful run, win or lose', async () => {
  const store = fakeStore();
  const backupTarget = fakeBackupTarget();
  const loop = createBackupLoop({ store, backupTarget });

  await loop.runOnce();

  const tmpDir = path.join(store.memoryDir, '.backup-tmp');
  const remaining = fs.readdirSync(tmpDir);
  assert.deepEqual(remaining, [], 'no leftover snapshot temp files after a successful pass');
});

test('runOnce reports ok:false and never calls prune if push fails', async () => {
  const store = fakeStore();
  const backupTarget = fakeBackupTarget({ pushOk: false });
  const loop = createBackupLoop({ store, backupTarget });

  const result = await loop.runOnce();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'push');
  assert.equal(backupTarget.pruneCalls.length, 0, 'prune must not run after a failed push');

  const tmpDir = path.join(store.memoryDir, '.backup-tmp');
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'temp file cleaned up even on a failed push');
});

test('runOnce reports ok:false if snapshotToFile itself throws, and never calls push', async () => {
  const store = fakeStore({ snapshotError: new Error('disk full') });
  const backupTarget = fakeBackupTarget();
  const loop = createBackupLoop({ store, backupTarget });

  const result = await loop.runOnce();

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'snapshot');
  assert.match(result.error, /disk full/);
  assert.equal(backupTarget.pushCalls.length, 0, 'push must not run after a failed snapshot');
});

test('a failed prune does not make the whole pass ok:false -- the backup itself succeeded', async () => {
  const store = fakeStore();
  const backupTarget = fakeBackupTarget({ pruneOk: false });
  const loop = createBackupLoop({ store, backupTarget });

  const result = await loop.runOnce();

  assert.equal(result.ok, true, 'the push succeeded -- a real backup exists, prune is best-effort cleanup');
  assert.equal(result.pruneError, 'prune failed');
  assert.deepEqual(result.pruned, []);
});

test('a second runOnce while one is already in flight is skipped, not run concurrently', async () => {
  const store = fakeStore();
  let resolvePush;
  const backupTarget = {
    push: () => new Promise((r) => { resolvePush = r; }),
    prune: async () => ({ ok: true, removed: [] }),
  };
  const loop = createBackupLoop({ store, backupTarget });

  const first = loop.runOnce();
  await new Promise((r) => setImmediate(r)); // let runOnce set running=true
  assert.equal(loop.isRunning(), true);
  const second = await loop.runOnce();
  assert.equal(second.skipped, 'already running');

  resolvePush({ ok: true, ref: 'vault-fake.db' });
  await first;
  assert.equal(loop.isRunning(), false);
});

test('getLastResult reflects the most recent completed pass', async () => {
  const store = fakeStore();
  const backupTarget = fakeBackupTarget();
  const loop = createBackupLoop({ store, backupTarget });

  assert.equal(loop.getLastResult(), null);
  const result = await loop.runOnce();
  assert.deepEqual(loop.getLastResult(), result);
});

test('never pulls anything -- this loop is one-directional, local-to-remote only (no fetch/pull calls exist on the interface it uses)', async () => {
  const store = fakeStore();
  const backupTarget = fakeBackupTarget();
  // Deliberately no `fetch` on this fake target -- if runOnce ever tried to
  // call it, this test would throw "backupTarget.fetch is not a function".
  const loop = createBackupLoop({ store, backupTarget });
  await loop.runOnce();
  assert.equal('fetch' in backupTarget, false);
});
