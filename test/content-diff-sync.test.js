'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runContentDiffSync } = require('../lib/content-diff-sync');

function tmpMemoryDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-diff-sync-'));
  fs.mkdirSync(path.join(dir, 'learning'), { recursive: true });
  return dir;
}

/** In-memory fake of the sqlite store's relevant surface -- TSV collections keyed by relPath, raw blobs keyed by relPath. */
function fakeStore() {
  const tsv = new Map(); // relPath -> rows[]
  const raw = new Map(); // relPath -> { content, updatedAtMs }
  return {
    read: (relPath) => tsv.get(relPath) || [],
    append: (relPath, row) => {
      const rows = tsv.get(relPath) || [];
      rows.push(row);
      tsv.set(relPath, rows);
      return true;
    },
    rewrite: (relPath, fn) => {
      const rows = tsv.get(relPath) || [];
      const kept = fn(rows);
      tsv.set(relPath, kept);
      return rows.length - kept.length;
    },
    rawRead: (relPath) => (raw.get(relPath) || {}).content || '',
    rawWrite: (relPath, contents) => {
      raw.set(relPath, { content: contents, updatedAtMs: Date.now() });
    },
    statMtimeMs: (relPath) => (raw.get(relPath) || {}).updatedAtMs ?? null,
  };
}

function writeCourse(memoryDir, courseId, moduleFile, content) {
  const dir = path.join(memoryDir, 'learning', courseId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, moduleFile), content);
}

function statePath(memoryDir) {
  return path.join(memoryDir, 'diff-sync-state.json');
}

test('a brand new lesson file with nothing in the DB yet syncs in as raw-insert, no conflict', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  writeCourse(memoryDir, 'demo-course-one', '00-orientation.md', '# Orientation\n\nHello.');

  const { changed, conflicts, totalChecked } = runContentDiffSync({ store, memoryDir, statePath: statePath(memoryDir) });

  assert.equal(conflicts.length, 0);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].kind, 'raw-insert');
  assert.equal(store.rawRead('learning/demo-course-one/00-orientation.md'), '# Orientation\n\nHello.');
  assert.equal(totalChecked, 1);
});

test('an unchanged file on a second pass is a no-op, not re-synced', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  writeCourse(memoryDir, 'demo-course-two', '00-a.md', 'content v1');
  const sp = statePath(memoryDir);

  runContentDiffSync({ store, memoryDir, statePath: sp });
  const second = runContentDiffSync({ store, memoryDir, statePath: sp });

  assert.equal(second.changed.length, 0);
  assert.equal(second.conflicts.length, 0);
});

test('editing the file after a baseline sync updates the DB (raw-update-from-file), db left alone in between', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  const filePath = path.join(memoryDir, 'learning', 'demo-course-three', '00-a.md');
  writeCourse(memoryDir, 'demo-course-three', '00-a.md', 'content v1');
  const sp = statePath(memoryDir);

  runContentDiffSync({ store, memoryDir, statePath: sp }); // baseline

  fs.writeFileSync(filePath, 'content v2 -- edited');
  const result = runContentDiffSync({ store, memoryDir, statePath: sp });

  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].kind, 'raw-update-from-file');
  assert.equal(store.rawRead('learning/demo-course-three/00-a.md'), 'content v2 -- edited');
});

test('when both the file and the DB change since the last sync, the file wins and it is flagged as a conflict', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  const filePath = path.join(memoryDir, 'learning', 'demo-course-four', '00-a.md');
  writeCourse(memoryDir, 'demo-course-four', '00-a.md', 'content v1');
  const sp = statePath(memoryDir);

  runContentDiffSync({ store, memoryDir, statePath: sp }); // baseline

  // Simulate a live app write straight to the DB (bypassing the file).
  store.rawWrite('learning/demo-course-four/00-a.md', 'live app edit');
  // ...and, independently, a fresh edit to the authoring file.
  fs.writeFileSync(filePath, 'gemini rewrite');

  const result = runContentDiffSync({ store, memoryDir, statePath: sp });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, 'raw-conflict-file-wins');
  assert.equal(store.rawRead('learning/demo-course-four/00-a.md'), 'gemini rewrite');
});

test('a DB-only edit (no file change) is left alone -- app-driven writes are never clobbered by a stale file', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  writeCourse(memoryDir, 'demo-course-five', '00-a.md', 'content v1');
  const sp = statePath(memoryDir);

  runContentDiffSync({ store, memoryDir, statePath: sp }); // baseline
  store.rawWrite('learning/demo-course-five/00-a.md', 'live app edit, no file change');

  const result = runContentDiffSync({ store, memoryDir, statePath: sp });

  assert.equal(result.changed.length, 0);
  assert.equal(result.conflicts.length, 0);
  assert.equal(store.rawRead('learning/demo-course-five/00-a.md'), 'live app edit, no file change');
});

test('courses.tsv rows sync the same way: insert, then update-from-file on a later edit', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  const tsvPath = path.join(memoryDir, 'learning', 'courses.tsv');
  const header = 'ID\tTITLE\tSTATUS';
  fs.writeFileSync(tsvPath, `${header}\ndemo-course-six\tDemo: A Fresh Test Course\tactive\n`);
  const sp = statePath(memoryDir);

  const first = runContentDiffSync({ store, memoryDir, statePath: sp });
  assert.equal(first.changed.some((r) => r.kind === 'tsv-insert' && r.key === 'demo-course-six'), true);

  fs.writeFileSync(tsvPath, `${header}\ndemo-course-six\tDemo: A Retitled Test Course\tactive\n`);
  const second = runContentDiffSync({ store, memoryDir, statePath: sp });
  assert.equal(second.changed.some((r) => r.kind === 'tsv-update-from-file' && r.key === 'demo-course-six'), true);
  assert.equal(store.read('learning/courses.tsv').find((r) => r.ID === 'demo-course-six').TITLE, 'Demo: A Retitled Test Course');
});

test('FI26090302: a schema column added after a row was last synced gets backfilled from the file, not stuck at its migration default', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  const tsvPath = path.join(memoryDir, 'learning', 'courses.tsv');
  const sp = statePath(memoryDir);

  // Baseline sync under the OLD (narrower) column set -- no GROUP_ID yet.
  fs.writeFileSync(tsvPath, 'ID\tTITLE\ndemo-course-nine\tDemo: Nine\n');
  runContentDiffSync({ store, memoryDir, statePath: sp });
  assert.equal(store.read('learning/courses.tsv').find((r) => r.ID === 'demo-course-nine').GROUP_ID, undefined);

  // The file gains GROUP_ID (a real authored value) AND, separately, the DB
  // row picks up the new column via its own migration default ('-') --
  // simulating sqlite-store's `ALTER TABLE ... ADD COLUMN "GROUP_ID" TEXT
  // DEFAULT '-'` running between this sync and the next one.
  fs.writeFileSync(tsvPath, 'ID\tTITLE\tGROUP_ID\ndemo-course-nine\tDemo: Nine\tcorporate-mandate\n');
  const rows = store.read('learning/courses.tsv');
  rows.find((r) => r.ID === 'demo-course-nine').GROUP_ID = '-';
  store.rewrite('learning/courses.tsv', () => rows);

  const result = runContentDiffSync({ store, memoryDir, statePath: sp });

  assert.equal(result.conflicts.length, 0, 'a migration default must never be reported as a live-edit conflict');
  assert.notEqual(result.changed.some((r) => r.kind === 'tsv-db-ahead-left-alone' && r.key === 'demo-course-nine'), true, 'must not be misread as a live DB edit worth preserving');
  assert.equal(store.read('learning/courses.tsv').find((r) => r.ID === 'demo-course-nine').GROUP_ID, 'corporate-mandate');
});

test('FI26090302: a DB row whose key no longer exists in courses.tsv is pruned as stale, not left forever', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  const tsvPath = path.join(memoryDir, 'learning', 'courses.tsv');
  const header = 'ID\tTITLE\tSTATUS';
  fs.writeFileSync(tsvPath, `${header}\ndemo-course-eight\tDemo: Eight\tactive\n`);
  const sp = statePath(memoryDir);

  runContentDiffSync({ store, memoryDir, statePath: sp }); // baseline: DB gets demo-course-eight

  // Simulate a pre-existing stale/duplicate row under an old ID scheme,
  // written straight to the store (bypassing the file), the way FI26090302
  // found 25 old-short-ID course rows still sitting in vault.db.
  store.append('learning/courses.tsv', { ID: 'old-short-id', TITLE: 'Stale Duplicate', STATUS: 'active' });
  assert.equal(store.read('learning/courses.tsv').length, 2);

  const result = runContentDiffSync({ store, memoryDir, statePath: sp });

  assert.equal(result.changed.some((r) => r.kind === 'tsv-pruned-stale-db-row' && r.key === 'old-short-id'), true);
  const rows = store.read('learning/courses.tsv');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ID, 'demo-course-eight');
});

test('dryRun leaves both the file and the DB untouched, but still reports what it would have done', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  writeCourse(memoryDir, 'demo-course-seven', '00-a.md', 'content v1');
  const sp = statePath(memoryDir);

  const result = runContentDiffSync({ store, memoryDir, statePath: sp, dryRun: true });

  assert.equal(result.changed.length, 1);
  assert.equal(store.rawRead('learning/demo-course-seven/00-a.md'), '', 'dry run must not write to the store');
  assert.equal(fs.existsSync(sp), false, 'dry run must not persist state either');
});

test('an underscore-prefixed folder (e.g. _standards, _assets) is never treated as a course', () => {
  const memoryDir = tmpMemoryDir();
  const store = fakeStore();
  fs.mkdirSync(path.join(memoryDir, 'learning', '_standards'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'learning', '_standards', 'not-a-course.md'), 'should be skipped');
  const sp = statePath(memoryDir);

  const result = runContentDiffSync({ store, memoryDir, statePath: sp });

  assert.equal(result.changed.length, 0);
});
