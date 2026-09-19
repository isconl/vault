#!/usr/bin/env node
'use strict';
/**
 * BI26090301: file-to-DB catch-up/diff-sync -- one-off CLI pass over
 * lib/content-diff-sync.js's shared logic. Now also runs automatically as
 * a live loop inside vault's own server process (see server.js's
 * VAULT_CONTENT_SYNC_INTERVAL_MS wiring, lib/content-sync-loop.js) -- this
 * script remains for a manual/offline pass (a machine not currently
 * running the server, a --dry-run check, or CI) rather than being the only
 * way content reaches vault.db.
 *
 * Usage:
 *   node vault/scripts/diff-sync-content-to-db.js [--dry-run]
 *
 * Only meaningful under VAULT_STORE_ENGINE=sqlite (the tsv engine has no
 * separate DB to drift from the files -- it IS the files) -- refuses to
 * run otherwise.
 */

const path = require('path');
const { createSqliteStore } = require('../lib/sqlite-store');
const defaultSchema = require('../lib/default-schema');
const secretStore = require('../lib/secrets');
const { runContentDiffSync } = require('../lib/content-diff-sync');

const DRY_RUN = process.argv.includes('--dry-run');

const MEMORY_DIR = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.VAULT_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
const STATE_PATH = process.env.VAULT_DIFF_SYNC_STATE || path.join(__dirname, '..', 'runtime', 'diff-sync-state.json');

async function main() {
  const engine = process.env.VAULT_STORE_ENGINE || 'tsv';
  if (engine !== 'sqlite') {
    console.error(`diff-sync-content-to-db.js only applies to VAULT_STORE_ENGINE=sqlite (got ${JSON.stringify(engine)}) -- the tsv engine has no separate DB to drift from the files.`);
    process.exit(1);
  }

  await secretStore.init({ startRefreshLoop: false });
  const dbKeyPassphrase = process.env.VAULT_DB_KEY_PASSPHRASE_TEST || secretStore.get('VAULT_DB_KEY_PASSPHRASE');
  if (!dbKeyPassphrase) {
    console.error('VAULT_DB_KEY_PASSPHRASE not resolvable.');
    process.exit(1);
  }

  const store = createSqliteStore({ memoryDir: MEMORY_DIR, logsDir: LOGS_DIR, schema: defaultSchema, dbKeyPassphrase });
  // bootRepair (table create + column migration), not just ensureVault --
  // a table that already existed before a schema column was added (e.g.
  // GROUP_ID, learning/courses.tsv) otherwise keeps its old columns
  // forever on this script's path, even though server.js's own boot
  // sequence (src/server.js:97) already calls bootRepair for exactly this
  // reason. Confirmed live 4 Sep 2026: this script failed with "no such
  // column: GROUP_ID" against a real vault.db until fixed to match.
  if (!DRY_RUN) store.bootRepair();

  const { totalChecked, changed, conflicts } = runContentDiffSync({ store, memoryDir: MEMORY_DIR, statePath: STATE_PATH, dryRun: DRY_RUN });

  for (const c of conflicts) {
    const label = c.relPath + (c.key ? `#${c.key}` : '');
    console.warn(`[diff-sync] CONFLICT ${label}: both file and vault.db changed since last sync -- file wins.`, c.conflict);
  }

  console.log(`\n${DRY_RUN ? 'DRY RUN -- ' : ''}diff-sync, memoryDir=${MEMORY_DIR}\n`);
  if (!changed.length) {
    console.log('Nothing to sync -- files and vault.db already match.');
  } else {
    for (const r of changed) console.log(r.kind.padEnd(28), r.relPath, r.key || '');
  }
  console.log(`\n${totalChecked} keys checked, ${changed.length} synced, ${conflicts.length} conflict(s).`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
