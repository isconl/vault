'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSqliteStore } = require('../lib/sqlite-store');
const defaultSchema = require('../lib/default-schema');
const { runBackfill } = require('../scripts/backfill-tags-from-group');

const PASSPHRASE = 'test-fixture-passphrase-not-real';

function tmpStore() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-backfill-tags-test-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-backfill-tags-logs-'));
  return createSqliteStore({ memoryDir, logsDir, schema: defaultSchema, dbKeyPassphrase: PASSPHRASE });
}

test('backfills TAGS from GROUP for rows that have a real GROUP and no TAGS yet', () => {
  const store = tmpStore();
  store.ensureVault();
  store.append('circle/people.tsv', { ID: 'p1', NAME: 'Alice', GROUP: 'Viva' });
  store.append('circle/people.tsv', { ID: 'p2', NAME: 'Bob', GROUP: '-' });        // no GROUP -- nothing to backfill
  store.append('circle/people.tsv', { ID: 'p3', NAME: 'Cara', GROUP: 'Pre.IPO', TAGS: 'already-set' }); // already has TAGS -- untouched

  const result = runBackfill(store, { log: () => {} });
  assert.equal(result.backfilled, 1);

  const rows = Object.fromEntries(store.read('circle/people.tsv').map(r => [r.ID, r]));
  assert.equal(rows.p1.TAGS, 'Viva');
  assert.equal(rows.p1.GROUP, 'Viva');   // GROUP untouched, per the additive migration order
  assert.equal(rows.p2.TAGS, '-');
  assert.equal(rows.p3.TAGS, 'already-set'); // not overwritten
});

test('--dry-run leaves every row unchanged', () => {
  const store = tmpStore();
  store.ensureVault();
  store.append('circle/people.tsv', { ID: 'p1', NAME: 'Alice', GROUP: 'Viva' });

  const result = runBackfill(store, { dryRun: true, log: () => {} });
  assert.equal(result.backfilled, 0);
  assert.equal(store.read('circle/people.tsv')[0].TAGS, '-');
});

test('is idempotent -- running it twice changes nothing the second time', () => {
  const store = tmpStore();
  store.ensureVault();
  store.append('circle/people.tsv', { ID: 'p1', NAME: 'Alice', GROUP: 'Viva' });

  runBackfill(store, { log: () => {} });
  const second = runBackfill(store, { log: () => {} });
  assert.equal(second.backfilled, 0);
});

test('a pre-existing table (created before TAGS existed in the schema) gets the column added and backfilled', () => {
  // Simulates the real upgrade path: an OLD schema without TAGS creates
  // the table and a row, then a NEW store (the real default schema, with
  // TAGS) opens the same DB -- bootRepair()/ensureVaultColumns() must add
  // the column before runBackfill can read/write it.
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-backfill-tags-legacy-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-backfill-tags-legacy-logs-'));
  const OLD_SCHEMA = { 'circle/people.tsv': 'ID\tNAME\tCIRCLE\tGROUP\tROLE\tMET\tCHANNEL\tLAST_TOUCH\tCADENCE_DAYS\tSTATUS\tFOLDER\tNOTE\tREMEMBER\tEMAIL\tIS_SELF' };
  const oldStore = createSqliteStore({ memoryDir, logsDir, schema: OLD_SCHEMA, dbKeyPassphrase: PASSPHRASE });
  oldStore.ensureVault();
  oldStore.append('circle/people.tsv', { ID: 'p1', NAME: 'Alice', GROUP: 'Viva' });

  const newStore = createSqliteStore({ memoryDir, logsDir, schema: defaultSchema, dbKeyPassphrase: PASSPHRASE });
  const result = runBackfill(newStore, { log: () => {} }); // calls bootRepair() internally
  assert.equal(result.backfilled, 1);
  assert.equal(newStore.read('circle/people.tsv')[0].TAGS, 'Viva');
});
