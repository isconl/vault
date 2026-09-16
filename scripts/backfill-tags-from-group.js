#!/usr/bin/env node
'use strict';
/**
 * BM26091204 Step 2 -- one-time backfill: for every circle/people.tsv row
 * whose TAGS is still empty/'-' (the default ensureVaultColumns() gives a
 * newly-added column) but GROUP is a real value, set TAGS to that value
 * as a single-item tag list. GROUP itself is never touched or cleared --
 * this is additive, per the row's staged migration order (GROUP stays
 * authoritative and populated until Step 6).
 *
 * Idempotent and safe to re-run: only ever writes a row whose TAGS is
 * still at its default, so running it twice (or against a vault that's
 * had some contacts' TAGS already set manually/by the future tag-UI)
 * changes nothing the second time.
 *
 * Usage:
 *   node vault/scripts/backfill-tags-from-group.js [--dry-run]
 */

const path = require('path');
const { createSqliteStore } = require('../lib/sqlite-store');
const defaultSchema = require('../lib/default-schema');
const secretStore = require('../lib/secrets');

const DRY_RUN = process.argv.includes('--dry-run');
const MEMORY_DIR = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.VAULT_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');

/** Pure-ish core, factored out so it's testable against a tmpStore without touching real secrets/fs paths. */
function runBackfill(store, { dryRun = false, log = console.log } = {}) {
  store.bootRepair();
  const rows = store.read('circle/people.tsv');
  const toBackfill = rows.filter(r => (!r.TAGS || r.TAGS === '-') && r.GROUP && r.GROUP !== '-');

  log(`${rows.length} contact(s) total, ${toBackfill.length} need TAGS backfilled from GROUP.`);
  if (!toBackfill.length) { log('Nothing to do.'); return { total: rows.length, backfilled: 0 }; }
  for (const r of toBackfill) log(`  ${r.ID}: TAGS <- "${r.GROUP}"`);
  if (dryRun) { log('\nDRY RUN -- no changes written.'); return { total: rows.length, backfilled: 0 }; }

  const ids = new Set(toBackfill.map(r => r.ID));
  store.rewrite('circle/people.tsv', all => all.map(r => ids.has(r.ID) ? { ...r, TAGS: r.GROUP } : r), { force: true });
  log(`\nDone. ${toBackfill.length} row(s) backfilled.`);
  return { total: rows.length, backfilled: toBackfill.length };
}

module.exports = { runBackfill };

async function main() {
  const engine = process.env.VAULT_STORE_ENGINE || 'tsv';
  if (engine !== 'sqlite') {
    console.error(`backfill-tags-from-group.js only applies to VAULT_STORE_ENGINE=sqlite (got ${JSON.stringify(engine)}).`);
    process.exit(1);
  }

  await secretStore.init({ startRefreshLoop: false });
  const dbKeyPassphrase = process.env.VAULT_DB_KEY_PASSPHRASE_TEST || secretStore.get('VAULT_DB_KEY_PASSPHRASE');
  if (!dbKeyPassphrase) { console.error('VAULT_DB_KEY_PASSPHRASE not resolvable.'); process.exit(1); }

  const store = createSqliteStore({ memoryDir: MEMORY_DIR, logsDir: LOGS_DIR, schema: defaultSchema, dbKeyPassphrase });
  runBackfill(store, { dryRun: DRY_RUN });
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
