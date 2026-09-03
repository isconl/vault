'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSqliteStore } = require('../lib/sqlite-store');
const Database = require('better-sqlite3-multiple-ciphers');

function tmpVault() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sqlite-store-test-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sqlite-store-logs-'));
  return { memoryDir, logsDir };
}

const TEST_SCHEMA = {
  'scope/tasks.tsv': 'ID\tTITLE\tSTATUS',
  'circle/people.tsv': 'ID\tNAME',
};

const PASSPHRASE = 'test-fixture-passphrase-not-real';

function tmpStore(schema = TEST_SCHEMA, passphrase = PASSPHRASE) {
  const { memoryDir, logsDir } = tmpVault();
  const store = createSqliteStore({ memoryDir, logsDir, schema, dbKeyPassphrase: passphrase });
  return { store, memoryDir, logsDir };
}

test('createSqliteStore requires memoryDir and dbKeyPassphrase', () => {
  assert.throws(() => createSqliteStore({ dbKeyPassphrase: 'x' }), /memoryDir/);
  const { memoryDir } = tmpVault();
  assert.throws(() => createSqliteStore({ memoryDir }), /dbKeyPassphrase/);
});

test('append then read round-trips a row with all schema columns', () => {
  const { store } = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  assert.deepEqual(store.read('scope/tasks.tsv'), [{ ID: '1', TITLE: 'Buy milk', STATUS: 'open' }]);
});

test('append fills a column missing from the row with the same "-" default appendTSV uses', () => {
  const { store } = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk' }); // STATUS omitted
  assert.deepEqual(store.read('scope/tasks.tsv'), [{ ID: '1', TITLE: 'Buy milk', STATUS: '-' }]);
});

test('append bootstraps the table on first write, even without a prior ensureVault call', () => {
  const { store } = tmpStore();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  assert.deepEqual(store.read('scope/tasks.tsv'), [{ ID: '1', TITLE: 'Buy milk', STATUS: 'open' }]);
});

test('append to a path outside the schema is a no-op, matching appendTSV\'s unknown-file guard', () => {
  const { store } = tmpStore();
  const ok = store.append('scope/unknown.tsv', { ID: '1' });
  assert.equal(ok, false);
  assert.deepEqual(store.read('scope/unknown.tsv'), []);
});

test('read on a never-touched collection returns [], matching readTSV\'s "missing means empty" contract', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.read('scope/tasks.tsv'), []);
});

test('rewrite replacing rows honors the massacre guard: refuses a >50%-of-populated drop without force', () => {
  const { store } = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'A', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '2', TITLE: 'B', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '3', TITLE: 'C', STATUS: 'open' });
  const lost = store.rewrite('scope/tasks.tsv', () => []); // would drop all 3, >50%
  assert.equal(lost, 0, 'refused massacre reports 0 removed');
  assert.equal(store.read('scope/tasks.tsv').length, 3, 'rows survive the refused rewrite');
});

test('rewrite replacing rows succeeds past the massacre guard with force:true', () => {
  const { store } = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'A', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '2', TITLE: 'B', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '3', TITLE: 'C', STATUS: 'open' });
  const lost = store.rewrite('scope/tasks.tsv', () => [], { force: true });
  assert.equal(lost, 3);
  assert.deepEqual(store.read('scope/tasks.tsv'), []);
});

test('rewrite from empty to populated never trips the massacre guard', () => {
  const { store } = tmpStore();
  store.ensureVault();
  // matches rewriteTSV's own return contract: rows.length - kept.length can
  // go negative when rewrite ADDS rows -- guard only ever refuses removals.
  const lost = store.rewrite('scope/tasks.tsv', () => [
    { ID: '1', TITLE: 'A', STATUS: 'open' },
    { ID: '2', TITLE: 'B', STATUS: 'open' },
  ]);
  assert.equal(lost, -2);
  assert.equal(store.read('scope/tasks.tsv').length, 2);
});

test('rewrite on a collection whose table was never bootstrapped is a no-op, fn never called', () => {
  const { store } = tmpStore();
  let called = false;
  const lost = store.rewrite('scope/tasks.tsv', (rows) => { called = true; return rows; });
  assert.equal(lost, 0);
  assert.equal(called, false);
});

test('rewrite under half loss (no force needed) applies normally and reports the loss', () => {
  const { store } = tmpStore();
  store.ensureVault();
  for (const id of ['1', '2', '3', '4']) store.append('scope/tasks.tsv', { ID: id, TITLE: id, STATUS: 'open' });
  const lost = store.rewrite('scope/tasks.tsv', (rows) => rows.filter((r) => r.ID !== '1')); // drop 1 of 4, 25%
  assert.equal(lost, 1);
  assert.deepEqual(store.read('scope/tasks.tsv').map((r) => r.ID).sort(), ['2', '3', '4']);
});

test('rewrite keeps the previous version in .trash when rows are actually lost', () => {
  const { store, memoryDir } = tmpStore();
  store.ensureVault();
  for (const id of ['1', '2', '3', '4']) store.append('scope/tasks.tsv', { ID: id, TITLE: id, STATUS: 'open' });
  store.rewrite('scope/tasks.tsv', (rows) => rows.filter((r) => r.ID !== '1'));
  assert.ok(fs.existsSync(path.join(memoryDir, '.trash')), 'previous version was kept in .trash');
});

test('rawRead/rawWrite round-trip a non-TSV path', () => {
  const { store } = tmpStore();
  assert.equal(store.rawRead('learning/course/00-intro.md'), '', 'missing path reads as empty, not throwing');
  store.rawWrite('learning/course/00-intro.md', '# Intro');
  assert.equal(store.rawRead('learning/course/00-intro.md'), '# Intro');
  store.rawWrite('learning/course/00-intro.md', '# Intro, revised');
  assert.equal(store.rawRead('learning/course/00-intro.md'), '# Intro, revised');
});

test('rawWrite refuses to blank a path that already had real content, without force', () => {
  const { store } = tmpStore();
  store.rawWrite('scope/state.json', '{"a":1}');
  assert.throws(() => store.rawWrite('scope/state.json', ''));
  assert.equal(store.rawRead('scope/state.json'), '{"a":1}', 'blocked write left the value untouched');
  store.rawWrite('scope/state.json', '', { force: true });
  assert.equal(store.rawRead('scope/state.json'), '', 'force overrides the guard');
});

test('listDir returns only direct children, not nested paths', () => {
  const { store } = tmpStore();
  store.rawWrite('learning/viva/00-intro.md', '# Intro');
  store.rawWrite('learning/viva/01-deep-dive.md', '# Deep dive');
  store.rawWrite('learning/viva/sub/nested.md', '# Nested, must not appear');
  store.rawWrite('learning/other-course/00-intro.md', '# Different course, must not appear');

  const files = store.listDir('learning/viva');
  assert.deepEqual(files.map((f) => f.name).sort(), ['00-intro.md', '01-deep-dive.md']);
  assert.ok(files.every((f) => typeof f.mtimeIso === 'string'));
});

test('listDir returns [] for a path with no raw entries', () => {
  const { store } = tmpStore();
  assert.deepEqual(store.listDir('learning/nonexistent-course'), []);
});

test('ensureVault is idempotent: running it twice creates nothing the second time', () => {
  const { store } = tmpStore();
  const first = store.ensureVault();
  assert.deepEqual(first.sort(), ['circle/people.tsv', 'scope/tasks.tsv']);
  const second = store.ensureVault();
  assert.deepEqual(second, []);
});

test('ensureVault never touches a collection that already has rows', () => {
  const { store } = tmpStore();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  store.ensureVault();
  assert.equal(store.read('scope/tasks.tsv').length, 1);
});

test('ensureVaultColumns adds a newly-added schema column to an existing table without touching existing row values', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store1 = createSqliteStore({ memoryDir, logsDir, schema: { 'scope/tasks.tsv': 'ID\tTITLE' }, dbKeyPassphrase: PASSPHRASE });
  store1.ensureVault();
  store1.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk' });
  store1.append('scope/tasks.tsv', { ID: '2', TITLE: 'Walk dog' });

  const store2 = createSqliteStore({ memoryDir, logsDir, schema: { 'scope/tasks.tsv': 'ID\tTITLE\tSTATUS' }, dbKeyPassphrase: PASSPHRASE });
  const upgraded = store2.ensureVaultColumns();
  assert.equal(upgraded, 1);
  assert.deepEqual(store2.read('scope/tasks.tsv'), [
    { ID: '1', TITLE: 'Buy milk', STATUS: '-' },
    { ID: '2', TITLE: 'Walk dog', STATUS: '-' },
  ]);
});

test('ensureVaultColumns is a no-op for a table not yet bootstrapped', () => {
  const { store } = tmpStore();
  assert.equal(store.ensureVaultColumns(), 0);
});

test('bootRepair runs bootstrap + column upgrade and reports {created, columnsUpgraded}', () => {
  const { store } = tmpStore();
  const result = store.bootRepair();
  assert.deepEqual(Object.keys(result).sort(), ['columnsUpgraded', 'created']);
  assert.deepEqual(result.created.sort(), ['circle/people.tsv', 'scope/tasks.tsv']);
  assert.equal(result.columnsUpgraded, 0);
});

test('a column named after a SQL reserved word (GROUP) round-trips correctly', () => {
  const { store } = tmpStore({ 'circle/people.tsv': 'ID\tNAME\tGROUP' });
  store.ensureVault();
  store.append('circle/people.tsv', { ID: '1', NAME: 'A', GROUP: 'friends' });
  assert.deepEqual(store.read('circle/people.tsv'), [{ ID: '1', NAME: 'A', GROUP: 'friends' }]);
});

// -- write-then-push hook (interface parity with store.js) -----------------

test('append fires the push hook with the written collection after a successful write', async () => {
  const { store } = tmpStore();
  store.ensureVault();
  const pushed = [];
  store.setPushHook((relPath) => { pushed.push(relPath); return { ok: true }; });
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pushed, ['scope/tasks.tsv']);
});

test('rewrite fires the push hook after writing', async () => {
  const { store } = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  const pushed = [];
  store.setPushHook((relPath) => { pushed.push(relPath); return { ok: true }; });
  store.rewrite('scope/tasks.tsv', (rows) => rows.map((r) => ({ ...r, STATUS: 'done' })));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pushed, ['scope/tasks.tsv']);
});

test('rawWrite fires the push hook after writing', async () => {
  const { store } = tmpStore();
  const pushed = [];
  store.setPushHook((relPath) => { pushed.push(relPath); return { ok: true }; });
  store.rawWrite('scope/state.json', '{"a":1}');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pushed, ['scope/state.json']);
});

test('with no push hook set, writes behave exactly as before (no error, nothing called)', () => {
  const { store } = tmpStore();
  store.ensureVault();
  assert.doesNotThrow(() => store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' }));
  assert.equal(store.read('scope/tasks.tsv').length, 1);
});

// -- encryption: the whole point --------------------------------------------

test('the on-disk .db file is not readable as plaintext SQLite by a driver given no key', () => {
  const { store, memoryDir } = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'a very findable secret title', STATUS: 'open' });

  const dbPath = path.join(memoryDir, 'vault.db');
  const raw = fs.readFileSync(dbPath);
  assert.ok(!raw.slice(0, 16).toString('utf8').includes('SQLite format'), 'file must not carry the plaintext SQLite magic header');
  assert.ok(!raw.includes('a very findable secret title'), 'plaintext content must not appear anywhere in the raw file bytes');

  assert.throws(() => {
    const rawDb = new Database(dbPath); // no key set at all
    rawDb.prepare('SELECT * FROM sqlite_master').all();
  }, 'opening the encrypted file with no key must fail');
});

test('opening the .db file with the WRONG key fails, not silently returns garbage or empty', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store = createSqliteStore({ memoryDir, logsDir, schema: TEST_SCHEMA, dbKeyPassphrase: PASSPHRASE });
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });

  assert.throws(() => {
    const wrong = createSqliteStore({ memoryDir, logsDir, schema: TEST_SCHEMA, dbKeyPassphrase: 'definitely-the-wrong-passphrase' });
    wrong.read('scope/tasks.tsv');
  }, 'a wrong passphrase must fail to read, never silently return wrong/empty data');
});

test('the same passphrase re-opens the same store and reads back prior writes (salt persisted correctly)', () => {
  const { memoryDir, logsDir } = tmpVault();
  const store1 = createSqliteStore({ memoryDir, logsDir, schema: TEST_SCHEMA, dbKeyPassphrase: PASSPHRASE });
  store1.ensureVault();
  store1.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });

  const store2 = createSqliteStore({ memoryDir, logsDir, schema: TEST_SCHEMA, dbKeyPassphrase: PASSPHRASE });
  assert.deepEqual(store2.read('scope/tasks.tsv'), [{ ID: '1', TITLE: 'Buy milk', STATUS: 'open' }]);
});

test('snapshotToFile produces an atomic, still-encrypted copy readable with the same key', () => {
  const { store, memoryDir } = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });

  const destPath = path.join(memoryDir, 'snapshot.db');
  store.snapshotToFile(destPath);
  assert.ok(fs.existsSync(destPath));

  const raw = fs.readFileSync(destPath);
  assert.ok(!raw.slice(0, 16).toString('utf8').includes('SQLite format'), 'snapshot must be encrypted too, not a plaintext copy');

  const derivedKeyHex = require('crypto').scryptSync(PASSPHRASE, fs.readFileSync(path.join(memoryDir, '.db-salt')), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex');
  const snap = new Database(destPath);
  snap.exec(`PRAGMA key = "x'${derivedKeyHex}'"`);
  assert.deepEqual(snap.prepare('SELECT ID, TITLE, STATUS FROM scope__tasks').all(), [{ ID: '1', TITLE: 'Buy milk', STATUS: 'open' }]);
});

test('table name mapping: schema key with / and .tsv stripped, e.g. scope/tasks.tsv -> scope__tasks', () => {
  const { store, memoryDir } = tmpStore();
  store.ensureVault();
  const derivedKeyHex = require('crypto').scryptSync(PASSPHRASE, fs.readFileSync(path.join(memoryDir, '.db-salt')), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex');
  const raw = new Database(path.join(memoryDir, 'vault.db'));
  raw.exec(`PRAGMA key = "x'${derivedKeyHex}'"`);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).sort();
  assert.deepEqual(tables, ['circle__people', 'raw_blobs', 'scope__tasks']);
});
