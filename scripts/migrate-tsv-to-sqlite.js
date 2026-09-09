#!/usr/bin/env node
'use strict';
/**
 * BI26083003: one-time (safely re-runnable) migration from the TSV vault
 * engine to the encrypted SQLite engine (BI26083001), against the SAME
 * memoryDir/logsDir -- reads through the old store, writes through the new
 * one, never touches a TSV file directly.
 *
 * Safe to re-run: a collection whose new-engine table already has rows is
 * left alone (not re-appended), so running this twice against the same
 * memoryDir does not duplicate data.
 *
 * ROLLBACK NOTE (read before flipping VAULT_STORE_ENGINE back to 'tsv'
 * after real use under 'sqlite'): once 'sqlite' is live, memory/*.tsv stops
 * being the source of truth and starts going stale. A same-day rollback is
 * safe (nothing important lost yet). A rollback after real use requires
 * re-running this script in --reverse mode (reads sqlite, appends into the
 * TSV engine) -- do NOT assume the stale TSVs are still current.
 *
 * Usage:
 *   node vault/scripts/migrate-tsv-to-sqlite.js --dry-run
 *   node vault/scripts/migrate-tsv-to-sqlite.js
 *   node vault/scripts/migrate-tsv-to-sqlite.js --reverse
 */

const fs = require('fs');
const path = require('path');
const { createVaultStore } = require('../lib/store');
const { createSqliteStore } = require('../lib/sqlite-store');
const defaultSchema = require('../lib/default-schema');
const { EXTRA_FINANCE_TSV, RAW_COLLECTIONS } = require('../lib/collection-registry');
const secretStore = require('../lib/secrets');

const DRY_RUN = process.argv.includes('--dry-run');
const REVERSE = process.argv.includes('--reverse');

const MEMORY_DIR = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.VAULT_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');

/** EXTRA_FINANCE_TSV collections aren't in defaultSchema -- derive their column header from whatever's actually on disk, so the sqlite engine knows what columns to create. Skipped (no table needed yet) if the TSV doesn't exist. */
function buildFullSchema() {
  const schema = { ...defaultSchema };
  for (const rel of EXTRA_FINANCE_TSV) {
    const fp = path.join(MEMORY_DIR, rel);
    if (!fs.existsSync(fp)) continue;
    const first = fs.readFileSync(fp, 'utf8').split(/\r?\n/)[0];
    if (first) schema[rel] = first.startsWith('\t') ? first.slice(1) : first;
  }
  return schema;
}

/** Every .md/.yaml/.yml/.json file under memoryDir not already covered by a schema-declared TSV path or RAW_COLLECTIONS -- course lesson markdown, circle/dia/**, career/**, etc. Mirrors store.js's listDir exclusions (dotfiles, backup/conflict artifacts) plus skips .trash/.snapshots/vault.db/.db-salt. */
function discoverRawFiles(schema) {
  const known = new Set(RAW_COLLECTIONS);
  const out = [];
  const walk = (dir, rel = '') => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
      if (/\.backup|\.bak$|~$|\.conflict[-.\d]|\.incoming[-.\d]/.test(e.name)) continue;
      if (!/\.(md|yaml|yml|json)$/i.test(e.name)) continue;
      out.push(r);
    }
  };
  walk(MEMORY_DIR);
  return [...new Set([...known, ...out])];
}

function migrateTsv({ old, next, relPath, results }) {
  const oldRows = old.read(relPath);
  const newRowsBefore = next.read(relPath);

  if (DRY_RUN) {
    if (newRowsBefore.length === 0) {
      results.push({ collection: relPath, kind: 'tsv', status: 'would-migrate', old: oldRows.length, new: 0 });
    } else if (newRowsBefore.length === oldRows.length) {
      results.push({ collection: relPath, kind: 'tsv', status: 'already-migrated', old: oldRows.length, new: newRowsBefore.length });
    } else {
      results.push({ collection: relPath, kind: 'tsv', status: 'MISMATCH', old: oldRows.length, new: newRowsBefore.length });
    }
    return;
  }

  if (newRowsBefore.length > 0) {
    // Already migrated -- re-runnable, don't duplicate.
    const status = newRowsBefore.length === oldRows.length ? 'already-migrated' : 'MISMATCH';
    results.push({ collection: relPath, kind: 'tsv', status, old: oldRows.length, new: newRowsBefore.length });
    return;
  }

  next.ensureVault(); // idempotent; makes sure this collection's table exists
  for (const row of oldRows) next.append(relPath, row);
  const newRowsAfter = next.read(relPath);
  results.push({
    collection: relPath, kind: 'tsv',
    status: newRowsAfter.length === oldRows.length ? 'migrated' : 'MISMATCH',
    old: oldRows.length, new: newRowsAfter.length,
  });
}

function migrateRaw({ old, next, relPath, results }) {
  const oldContent = old.rawRead(relPath);
  const newContentBefore = next.rawRead(relPath);

  if (DRY_RUN) {
    if (!oldContent) {
      results.push({ collection: relPath, kind: 'raw', status: 'skip-empty', old: 0, new: newContentBefore.length });
    } else if (!newContentBefore) {
      results.push({ collection: relPath, kind: 'raw', status: 'would-migrate', old: oldContent.length, new: 0 });
    } else if (newContentBefore.length === oldContent.length) {
      results.push({ collection: relPath, kind: 'raw', status: 'already-migrated', old: oldContent.length, new: newContentBefore.length });
    } else {
      results.push({ collection: relPath, kind: 'raw', status: 'MISMATCH', old: oldContent.length, new: newContentBefore.length });
    }
    return;
  }

  if (!oldContent) {
    results.push({ collection: relPath, kind: 'raw', status: 'skip-empty', old: 0, new: newContentBefore.length });
    return;
  }
  if (newContentBefore) {
    const status = newContentBefore.length === oldContent.length ? 'already-migrated' : 'MISMATCH';
    results.push({ collection: relPath, kind: 'raw', status, old: oldContent.length, new: newContentBefore.length });
    return;
  }

  next.rawWrite(relPath, oldContent);
  const after = next.rawRead(relPath);
  results.push({
    collection: relPath, kind: 'raw',
    status: after.length === oldContent.length ? 'migrated' : 'MISMATCH',
    old: oldContent.length, new: after.length,
  });
}

async function main() {
  // IMPORTANT: dry-run against the real memoryDir must use the SAME real
  // passphrase the eventual real run will use, not a throwaway one --
  // createSqliteStore() creates/opens vault.db as a side effect of
  // construction even under --dry-run (it never writes row data, but the
  // file and its key derivation already exist the moment this runs). A
  // fake passphrase here would create vault.db encrypted with the WRONG
  // key, permanently locking out the real migration run that follows.
  // VAULT_DB_KEY_PASSPHRASE_TEST is for a scratch/throwaway memoryDir only
  // (e.g. this script's own tests), never for a dry-run against the real one.
  await secretStore.init({ startRefreshLoop: false });
  const dbKeyPassphrase = process.env.VAULT_DB_KEY_PASSPHRASE_TEST || secretStore.get('VAULT_DB_KEY_PASSPHRASE');
  if (!dbKeyPassphrase) {
    console.error('VAULT_DB_KEY_PASSPHRASE not resolvable -- run BI26083002 first.');
    process.exit(1);
  }

  const schema = buildFullSchema();
  const tsvStore = createVaultStore({ memoryDir: MEMORY_DIR, logsDir: LOGS_DIR, schema });
  const sqliteStore = createSqliteStore({ memoryDir: MEMORY_DIR, logsDir: LOGS_DIR, schema, dbKeyPassphrase });

  const old = REVERSE ? sqliteStore : tsvStore;
  const next = REVERSE ? tsvStore : sqliteStore;

  if (!DRY_RUN) next.ensureVault();

  const results = [];
  for (const relPath of Object.keys(schema)) {
    migrateTsv({ old, next, relPath, results });
  }
  for (const relPath of discoverRawFiles(schema)) {
    migrateRaw({ old, next, relPath, results });
  }

  console.log(`\n${DRY_RUN ? 'DRY RUN -- ' : ''}${REVERSE ? 'sqlite -> tsv' : 'tsv -> sqlite'} migration, memoryDir=${MEMORY_DIR}\n`);
  console.log('collection'.padEnd(48), 'kind'.padEnd(6), 'status'.padEnd(18), 'old'.padEnd(8), 'new');
  let mismatches = 0;
  for (const r of results) {
    if (r.status === 'MISMATCH') mismatches++;
    console.log(String(r.collection).padEnd(48), r.kind.padEnd(6), r.status.padEnd(18), String(r.old).padEnd(8), String(r.new));
  }
  console.log(`\n${results.length} collections checked, ${mismatches} mismatch(es).`);
  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
