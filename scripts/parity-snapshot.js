#!/usr/bin/env node
'use strict';
/**
 * parity-snapshot -- take the TWO clones canon §7b's write-path parity needs.
 *
 *   node scripts/parity-snapshot.js --out <dirA> <dirB>
 *
 * Why this lives in `vault` and not in the parity harness: the live database
 * is encrypted with SQLCipher (`better-sqlite3-multiple-ciphers`), and the
 * harness's own SQLite is plain bundled `rusqlite` with no cipher. **The
 * harness cannot open the database it is cloning.** This engine already can,
 * and already exposes `snapshotToFile()` -- `VACUUM INTO`, atomic and
 * transactionally consistent -- built for the backup path (BI26083004).
 *
 * TWO clones, not one. Canon §7b: a clone per ENGINE. One shared clone leaves
 * the second engine writing against a database the first already changed, and
 * a match then means nothing.
 *
 * WHAT THIS PRODUCES IS THE ENTIRE LIVE DATABASE -- journal entries, finances,
 * every named individual in the people graph. It is a more sensitive artefact
 * than the parity records canon §12.5 already protects. Each output directory
 * therefore gets a self-ignoring `.gitignore` before anything else is written
 * to it, and the caller is expected to destroy both clones after the run,
 * whether it passed or failed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createSqliteStore } = require('../lib/sqlite-store');

const MEMORY_DIR = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.VAULT_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
const ENGINE = process.env.VAULT_STORE_ENGINE || 'tsv';

/** Written into each clone so the harness can prove the directory is one.
 *  Shape must match `tools/parity/src/guard.rs`'s CloneMarker. */
function writeMarker(dir, { source, takenAt, runId, engine }) {
  fs.writeFileSync(
    path.join(dir, '.parity-clone'),
    JSON.stringify({ source, taken_at: takenAt, run_id: runId, engine }, null, 2)
  );
}

/** Written FIRST, before any data lands in the directory. The ordering is the
 *  point: a crash between creating the directory and copying the database
 *  should still leave something git will never track. */
function writeSelfIgnore(dir) {
  fs.writeFileSync(
    path.join(dir, '.gitignore'),
    '# Written by vault/scripts/parity-snapshot.js. This directory holds a\n' +
      '# COMPLETE COPY of the live vault -- journal, finances, the people graph.\n' +
      '# Canon §12.5. Never commit it, anywhere, in any repo. Destroy it after\n' +
      '# the parity run, whether the run passed or failed.\n' +
      '*\n'
  );
}

function stamp() {
  return String(Math.floor(Date.now() / 1000)).padStart(20, '0');
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const dirs = outIdx === -1 ? [] : process.argv.slice(outIdx + 1, outIdx + 3);
  if (dirs.length !== 2) {
    console.error('usage: parity-snapshot.js --out <dirA> <dirB>');
    console.error('two directories, one per engine -- canon §7b');
    process.exit(2);
  }

  const [a, b] = dirs.map(d => path.resolve(d));
  if (a === b) {
    console.error('refusing: both clones would be the same directory. A clone per ENGINE.');
    process.exit(2);
  }
  for (const d of [a, b]) {
    if (path.resolve(d) === path.resolve(MEMORY_DIR)) {
      console.error(`refusing: ${d} IS the live store. That would not be a clone.`);
      process.exit(2);
    }
    if (fs.existsSync(d) && fs.readdirSync(d).length) {
      // A pre-existing clone is real data from a previous run. Overwriting it
      // silently is how a stale clone survives; refusing makes the operator
      // destroy it deliberately.
      console.error(`refusing: ${d} exists and is not empty. Destroy the previous clone first.`);
      process.exit(2);
    }
  }

  const runId = crypto.randomBytes(6).toString('hex');
  const takenAt = stamp();

  for (const [i, d] of [a, b].entries()) {
    fs.mkdirSync(d, { recursive: true });
    writeSelfIgnore(d);
    writeMarker(d, {
      source: MEMORY_DIR,
      takenAt,
      runId,
      engine: i === 0 ? 'node' : 'rust',
    });
  }

  if (ENGINE === 'sqlite') {
    await secretStore.init();
    const dbKeyPassphrase = secretStore.get('VAULT_DB_KEY_PASSPHRASE');
    // Presence check only -- never print it, never include it in an error.
    // CLAUDE.md §17.
    if (!dbKeyPassphrase) {
      console.error('VAULT_DB_KEY_PASSPHRASE is not resolvable; cannot open the live database');
      process.exit(2);
    }
    const auditLog = createAuditLog({ logsDir: LOGS_DIR });
    const store = createSqliteStore({ memoryDir: MEMORY_DIR, logsDir: LOGS_DIR, auditLog, dbKeyPassphrase });
    // VACUUM INTO twice, from the SAME live database. Each is atomic and
    // transactionally consistent on its own; taken back to back they are as
    // close to the same instant as this mechanism allows.
    store.snapshotToFile(path.join(a, 'vault.db'));
    store.snapshotToFile(path.join(b, 'vault.db'));
  } else if (ENGINE === 'tsv') {
    // No VACUUM INTO outside SQLite. A directory copy is NOT atomic under
    // concurrent writes, so a clone taken from a live TSV engine can be
    // internally inconsistent -- and the resulting parity differences would
    // be artefacts of the copy rather than of the Rust engine. Stated loudly
    // rather than handled silently, because the deployed engine value is
    // still an open question on this project's record.
    console.warn('WARNING: VAULT_STORE_ENGINE=tsv. This copy is NOT atomic.');
    console.warn('  Quiesce the engine first, or clone from a backup generation instead.');
    for (const d of [a, b]) {
      fs.cpSync(MEMORY_DIR, d, {
        recursive: true,
        filter: src => !path.basename(src).startsWith('.parity-clone'),
      });
      // cpSync may have overwritten them; both are cheap to rewrite.
      writeSelfIgnore(d);
    }
    writeMarker(a, { source: MEMORY_DIR, takenAt, runId, engine: 'node' });
    writeMarker(b, { source: MEMORY_DIR, takenAt, runId, engine: 'rust' });
  } else {
    console.error(`unknown VAULT_STORE_ENGINE=${ENGINE}`);
    process.exit(2);
  }

  // Paths only. Never the passphrase, never a row, never a count that could
  // narrow what the data is.
  console.log(JSON.stringify({ ok: true, runId, clones: [a, b], engine: ENGINE }, null, 2));
  console.log('\nDestroy both directories when the parity run finishes, pass or fail.');
}

main().catch(e => {
  console.error(String(e && e.message ? e.message : e).slice(0, 200));
  process.exit(1);
});
