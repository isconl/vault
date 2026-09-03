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

// -- write-then-push hook (SYNC1) -----------------------------------------

test('append fires the push hook with the written collection after a successful write', async () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  store.ensureVault();
  const pushed = [];
  store.setPushHook((relPath) => { pushed.push(relPath); return { ok: true }; });
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  await new Promise((r) => setImmediate(r));   // firePush is fire-and-forget
  assert.deepEqual(pushed, ['scope/tasks.tsv']);
});

test('append does not fire the push hook when the write itself was a no-op (unknown file, no header)', async () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: {} });   // no schema entry -> no headerIfMissing
  const pushed = [];
  store.setPushHook((relPath) => { pushed.push(relPath); return { ok: true }; });
  store.append('scope/unknown.tsv', { ID: '1' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pushed, []);
});

test('rewrite fires the push hook after writing', async () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  const pushed = [];
  store.setPushHook((relPath) => { pushed.push(relPath); return { ok: true }; });
  store.rewrite('scope/tasks.tsv', (rows) => rows.map((r) => ({ ...r, STATUS: 'done' })));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pushed, ['scope/tasks.tsv']);
});

test('rawWrite fires the push hook after writing', async () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  const pushed = [];
  store.setPushHook((relPath) => { pushed.push(relPath); return { ok: true }; });
  store.rawWrite('scope/state.json', '{"a":1}');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pushed, ['scope/state.json']);
});

test('a push hook rejection is caught and logged, never thrown back at the caller', async () => {
  const { memoryDir, logsDir } = tmpVault();
  const logs = [];
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA, auditLog: { log: (e, d) => logs.push([e, d]) } });
  store.ensureVault();
  store.setPushHook(() => Promise.reject(new Error('network down')));
  assert.doesNotThrow(() => store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' }));
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some(([e]) => e === 'vault_push_after_write_failed'));
});

test('with no push hook set, writes behave exactly as before (no error, nothing called)', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createVaultStore({ memoryDir, logsDir, schema: TEST_SCHEMA });
  store.ensureVault();
  assert.doesNotThrow(() => store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' }));
  assert.equal(store.read('scope/tasks.tsv').length, 1);
});
