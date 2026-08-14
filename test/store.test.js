'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVaultStore } = require('../lib/store');

function tmpVault() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-store-test-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-store-logs-'));
  return { memoryDir, logsDir };
}

const TEST_SCHEMA = {
  'scope/tasks.tsv': 'ID\tTITLE\tSTATUS',
  'circle/people.tsv': 'ID\tNAME',
};

test('ensureVault creates every schema file with its header, and never touches an existing one', () => {
  const { memoryDir, logsDir } = tmpVault();
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'), 'ID\tTITLE\tSTATUS\n1\tBuy milk\topen\n');
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const created = store.ensureVault();
  assert.deepEqual(created.sort(), ['circle/people.tsv']); // tasks.tsv already existed, must not be reported as created
  assert.equal(store.read('scope/tasks.tsv').length, 1, 'existing file with data must be untouched');
  assert.equal(fs.existsSync(path.join(memoryDir, 'circle', 'people.tsv')), true);
});

test('ensureVaultColumns adds a new schema column to an existing file without dropping data', () => {
  const { memoryDir, logsDir } = tmpVault();
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'), 'ID\tTITLE\n1\tBuy milk\n2\tWalk dog\n');
  const schemaWithNewColumn = { 'scope/tasks.tsv': 'ID\tTITLE\tSTATUS' }; // STATUS is new
  const store = createVaultStore({ memoryDir, logsDir, schema: schemaWithNewColumn });
  const upgraded = store.ensureVaultColumns();
  assert.equal(upgraded, 1);
  const rows = store.read('scope/tasks.tsv');
  assert.deepEqual(rows, [{ ID: '1', TITLE: 'Buy milk', STATUS: '-' }, { ID: '2', TITLE: 'Walk dog', STATUS: '-' }]);
});

test('repairEmptiedRegistries restores a file that lost everything, from the newest snapshot that still has rows', () => {
  const { memoryDir, logsDir } = tmpVault();
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  // A populated snapshot from "yesterday".
  const snapDir = path.join(memoryDir, '.snapshots', '20260101', 'scope');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'tasks.tsv'), 'ID\tTITLE\tSTATUS\n1\tBuy milk\topen\n2\tWalk dog\topen\n');
  // The live file is header-only -- simulates the exact incident this guards against.
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'), 'ID\tTITLE\tSTATUS\n');
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const repaired = store.repairEmptiedRegistries();
  assert.equal(repaired, 1);
  assert.equal(store.read('scope/tasks.tsv').length, 2);
});

test('repairEmptiedRegistries does nothing to a file that already has content', () => {
  const { memoryDir, logsDir } = tmpVault();
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'), 'ID\tTITLE\tSTATUS\n1\tBuy milk\topen\n');
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const repaired = store.repairEmptiedRegistries();
  assert.equal(repaired, 0);
  assert.equal(store.read('scope/tasks.tsv').length, 1);
});

test('reconcileRegistryRows restores a row missing from live but present in a snapshot, without touching live-only rows', () => {
  const { memoryDir, logsDir } = tmpVault();
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  const snapDir = path.join(memoryDir, '.snapshots', '20260101', 'scope');
  fs.mkdirSync(snapDir, { recursive: true });
  // Snapshot had T1 and T2.
  fs.writeFileSync(path.join(snapDir, 'tasks.tsv'), 'ID\tTITLE\tSTATUS\nT1\tBuy milk\topen\nT2\tWalk dog\topen\n');
  // Live lost T2, but gained T3 since the snapshot -- T3 must survive reconciliation.
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'), 'ID\tTITLE\tSTATUS\nT1\tBuy milk\topen\nT3\tPay rent\topen\n');
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const restored = store.reconcileRegistryRows();
  assert.equal(restored, 1);
  const ids = store.read('scope/tasks.tsv').map(r => r.ID).sort();
  assert.deepEqual(ids, ['T1', 'T2', 'T3']);
});

test('reconcileRegistryRows never resurrects a row that was deliberately deleted (per the audit log)', () => {
  const { memoryDir, logsDir } = tmpVault();
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  const snapDir = path.join(memoryDir, '.snapshots', '20260101', 'scope');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'tasks.tsv'), 'ID\tTITLE\tSTATUS\nT1\tBuy milk\topen\nT2\tWalk dog\topen\n');
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'), 'ID\tTITLE\tSTATUS\nT1\tBuy milk\topen\n');
  // T2's deletion is on record in the audit log.
  fs.writeFileSync(path.join(logsDir, 'actions.jsonl'), '{"action":"task_deleted","taskId":"T2"}\n');
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const restored = store.reconcileRegistryRows();
  assert.equal(restored, 0, 'a deliberately deleted row must never come back');
  assert.deepEqual(store.read('scope/tasks.tsv').map(r => r.ID), ['T1']);
});

test('snapshotVault copies syncable files into today\'s snapshot dir and prunes to 7 days', () => {
  const { memoryDir, logsDir } = tmpVault();
  fs.mkdirSync(path.join(memoryDir, 'scope'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'scope', 'tasks.tsv'), 'ID\tTITLE\n1\tBuy milk\n');
  // 8 old snapshot days already present -- pruning should bring it to 7 total (8 old + 1 new - 2 pruned = 7).
  const snapRoot = path.join(memoryDir, '.snapshots');
  for (let i = 1; i <= 8; i++) fs.mkdirSync(path.join(snapRoot, `2026010${i}`), { recursive: true });
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const day = store.snapshotVault();
  assert.ok(day, 'should return the snapshot day it wrote');
  const remainingDays = fs.readdirSync(snapRoot).filter(d => /^\d{8}$/.test(d));
  assert.equal(remainingDays.length, 7);
  assert.equal(fs.existsSync(path.join(snapRoot, day, 'scope', 'tasks.tsv')), true);
});

test('bootRepair runs the full sequence in order and reports counts from each stage', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const result = store.bootRepair();
  assert.deepEqual(result.created.sort(), ['circle/people.tsv', 'scope/tasks.tsv']);
  assert.equal(result.columnsUpgraded, 0);
  assert.equal(result.emptyFilesRepaired, 0);
  assert.equal(result.rowsRestored, 0);
});

test('rawRead/rawWrite round-trip a non-TSV file, and rawWrite keeps the previous version', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });

  assert.equal(store.rawRead('scope/calendar_events.json'), '', 'missing file reads as empty, not throwing');

  store.rawWrite('scope/calendar_events.json', '[{"title":"A"}]');
  assert.equal(store.rawRead('scope/calendar_events.json'), '[{"title":"A"}]');

  store.rawWrite('scope/calendar_events.json', '[{"title":"A"},{"title":"B"}]');
  assert.equal(store.rawRead('scope/calendar_events.json'), '[{"title":"A"},{"title":"B"}]');
  const trashDir = path.join(memoryDir, '.trash');
  assert.ok(fs.existsSync(trashDir), 'previous version was kept in .trash');
});

test('rawWrite refuses to blank a file that already had real content, without force', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  store.rawWrite('scope/calendar_events.json', '[{"title":"Real event"}]');

  assert.throws(() => store.rawWrite('scope/calendar_events.json', ''));
  assert.equal(store.rawRead('scope/calendar_events.json'), '[{"title":"Real event"}]', 'blocked write left the file untouched');

  store.rawWrite('scope/calendar_events.json', '', { force: true });
  assert.equal(store.rawRead('scope/calendar_events.json'), '', 'force overrides the guard');
});

test('listDir lists only files directly inside a folder, skipping dotfiles and backup artifacts', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const dir = path.join(memoryDir, 'learning', 'viva');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '00-intro.md'), '# Intro');
  fs.writeFileSync(path.join(dir, '01-deep-dive.md'), '# Deep dive');
  fs.writeFileSync(path.join(dir, '00-intro.md.backup'), 'old');
  fs.writeFileSync(path.join(dir, '.DS_Store'), '');
  fs.mkdirSync(path.join(dir, '_notes'));

  const files = store.listDir('learning/viva');
  assert.deepEqual(files.map((f) => f.name).sort(), ['00-intro.md', '01-deep-dive.md']);
  assert.ok(files.every((f) => typeof f.mtimeIso === 'string'));
});

test('listDir returns [] for a directory that does not exist, not throwing', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  assert.deepEqual(store.listDir('learning/nonexistent-course'), []);
});
