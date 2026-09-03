#!/usr/bin/env node
'use strict';
/**
 * BI26090301: file-to-DB catch-up/diff-sync -- the 31 Aug SQLite cutover
 * left no ongoing sync from file-based content authoring (course lesson
 * .md files, courses.tsv, and other content-authoring TSVs edited by hand
 * or by Gemini) back into vault.db. This walks those sources, compares
 * each key's current file state against vault.db and against the last
 * synced snapshot recorded in diff-sync-state.json, and upserts whichever
 * side changed since that snapshot into the DB.
 *
 * Conflict rule (both sides changed since the last recorded sync point for
 * a key): the file wins, but a warning is logged naming the key and both
 * timestamps -- never a silent overwrite in either direction.
 *
 * Run manually at the end of a content-authoring session, or on a schedule
 * (see NEXT.md for wiring a cron/systemd timer once this has run clean a
 * few times by hand).
 *
 * Usage:
 *   node vault/scripts/diff-sync-content-to-db.js [--dry-run]
 *
 * Only meaningful under VAULT_STORE_ENGINE=sqlite (the tsv engine has no
 * separate DB to drift from the files -- it IS the files) -- refuses to
 * run otherwise.
 */

const fs = require('fs');
const path = require('path');
const { createSqliteStore } = require('../lib/sqlite-store');
const defaultSchema = require('../lib/default-schema');
const { parseTSVText } = require('../lib/tsv');
const secretStore = require('../lib/secrets');

const DRY_RUN = process.argv.includes('--dry-run');

const MEMORY_DIR = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
const LOGS_DIR = process.env.VAULT_LOGS_DIR || path.join(__dirname, '..', 'runtime', 'logs');
const STATE_PATH = process.env.VAULT_DIFF_SYNC_STATE || path.join(__dirname, '..', 'runtime', 'diff-sync-state.json');

// Content-authoring TSVs this tool reconciles. courses.tsv is the "at
// minimum" case the row names explicitly -- extend this list as other
// file-authored collections need the same catch-up (e.g. a future
// hand-edited campus.tsv), not by writing a second script.
const CONTENT_TSVS = [
  { relPath: 'learning/courses.tsv', key: 'ID' },
];

// Standing content-authoring docs outside any course folder (so
// discoverLessonFiles' underscore-prefixed-folder skip never sees them) --
// synced the same raw-file way as a lesson .md. Extend as more of these
// turn up; course-standards.md is the first found needing it (edited
// directly on 3 Sep 2026, same session this tool shipped in).
const EXTRA_RAW_FILES = [
  'learning/_standards/course-standards.md',
];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function rowContentEqual(a, b, cols) {
  if (!a || !b) return a === b;
  return cols.every((c) => (a[c] || '') === (b[c] || ''));
}

function upsertTsvRow(store, relPath, keyCol, key, row) {
  const existing = store.read(relPath);
  const has = existing.some((r) => r[keyCol] === key);
  if (!has) {
    store.append(relPath, row);
    return;
  }
  store.rewrite(relPath, (rows) => rows.map((r) => (r[keyCol] === key ? row : r)), { force: true, why: 'diff-sync upsert' });
}

/** Every course lesson .md file discovered under memory/learning/<courseId>/, keyed by its relPath. Skips _standards/, _assets/, _profiles/ and any other underscore-prefixed folder (meta, not a course). */
function discoverLessonFiles(memoryDir) {
  const learningDir = path.join(memoryDir, 'learning');
  const out = [];
  let courseDirs;
  try {
    courseDirs = fs.readdirSync(learningDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of courseDirs) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const courseDir = path.join(learningDir, d.name);
    let files;
    try {
      files = fs.readdirSync(courseDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.md')) continue;
      out.push(`learning/${d.name}/${f.name}`);
    }
  }
  return out;
}

function syncTsvCollection(store, memoryDir, relPath, keyCol, state, results) {
  const filePath = path.join(memoryDir, relPath);
  if (!fs.existsSync(filePath)) return;
  const fileText = fs.readFileSync(filePath, 'utf8');
  const fileRows = parseTSVText(fileText);
  const cols = fileText.split(/\r?\n/)[0].split('\t');
  const dbRows = store.read(relPath);
  const dbByKey = new Map(dbRows.map((r) => [r[keyCol], r]));
  const fileByKey = new Map(fileRows.map((r) => [r[keyCol], r]));

  for (const [key, fileRow] of fileByKey) {
    const stateKey = `tsv:${relPath}#${key}`;
    const last = state[stateKey];
    const dbRow = dbByKey.get(key) || null;

    if (!dbRow) {
      // brand new row -- no conflict possible, insert.
      if (!DRY_RUN) store.append(relPath, fileRow);
      results.push({ kind: 'tsv-insert', relPath, key });
      state[stateKey] = { fileSnapshot: fileRow, dbSnapshot: fileRow };
      continue;
    }

    if (!last) {
      // First time this key has been seen by this tool -- no sync history
      // to detect a genuine double-edit against, so this is NOT a
      // conflict, just an unestablished baseline. If file and DB already
      // agree, record it and move on silently. If they don't, the file is
      // the authoring source of truth (courses.tsv is hand/Gemini-edited;
      // the DB row was last written whenever this collection was migrated
      // or last touched live) -- sync it in without a conflict warning,
      // but flag it distinctly from a real cross-run conflict so a first
      // run's output isn't misread as 31 urgent double-edits.
      if (rowContentEqual(fileRow, dbRow, cols)) {
        results.push({ kind: 'tsv-baseline-match', relPath, key });
      } else {
        if (!DRY_RUN) upsertTsvRow(store, relPath, keyCol, key, fileRow);
        results.push({ kind: 'tsv-bootstrap-from-file', relPath, key });
      }
      state[stateKey] = { fileSnapshot: fileRow, dbSnapshot: fileRow };
      continue;
    }

    const fileChanged = !rowContentEqual(fileRow, last.fileSnapshot, cols);
    const dbChanged = !rowContentEqual(dbRow, last.dbSnapshot, cols);

    if (fileChanged && dbChanged) {
      console.warn(`[diff-sync] CONFLICT ${relPath}#${key}: both file and vault.db changed since last sync -- file wins.`, {
        fileSnapshot: last.fileSnapshot, dbSnapshotBefore: last.dbSnapshot, fileNow: fileRow, dbNow: dbRow,
      });
      if (!DRY_RUN) upsertTsvRow(store, relPath, keyCol, key, fileRow);
      results.push({ kind: 'tsv-conflict-file-wins', relPath, key });
      state[stateKey] = { fileSnapshot: fileRow, dbSnapshot: fileRow };
    } else if (fileChanged) {
      if (!DRY_RUN) upsertTsvRow(store, relPath, keyCol, key, fileRow);
      results.push({ kind: 'tsv-update-from-file', relPath, key });
      state[stateKey] = { fileSnapshot: fileRow, dbSnapshot: fileRow };
    } else if (dbChanged) {
      // DB edited live (app/webconsole) since last sync -- leave it alone,
      // just move the DB-side baseline forward so this isn't re-flagged.
      results.push({ kind: 'tsv-db-ahead-left-alone', relPath, key });
      state[stateKey] = { fileSnapshot: last.fileSnapshot, dbSnapshot: dbRow };
    }
    // neither changed -> no-op, state untouched.
  }
}

/**
 * Content-hash based, not mtime based: a git checkout/pull resets file
 * mtimes to checkout time regardless of when the content was actually last
 * edited, which makes raw fs mtime comparison unreliable as a "did this
 * change" signal on this repo. Content compared against the last synced
 * snapshot (recorded in diff-sync-state.json) is the real signal; fs mtime
 * is carried along only for the CONFLICT log line's diagnostic value.
 */
function syncLessonFile(store, memoryDir, relPath, state, results) {
  const filePath = path.join(memoryDir, relPath);
  const fileMtimeMs = fs.statSync(filePath).mtimeMs;
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const dbContent = store.rawRead(relPath);
  const dbUpdatedAtMs = store.statMtimeMs(relPath);

  const stateKey = `raw:${relPath}`;
  const last = state[stateKey];

  if (!dbContent) {
    // never synced into the DB at all -- no conflict possible.
    if (!DRY_RUN) store.rawWrite(relPath, fileContent, { force: true });
    results.push({ kind: 'raw-insert', relPath });
    state[stateKey] = { fileContent, dbContent: fileContent, fileMtimeMs, dbUpdatedAtMs: Date.now() };
    return;
  }

  if (fileContent === dbContent) {
    state[stateKey] = { fileContent, dbContent, fileMtimeMs, dbUpdatedAtMs };
    return;
  }

  if (!last) {
    // First time this file has been seen by this tool -- no sync history
    // to detect a genuine double-edit against. The file is the authoring
    // source of truth (this is course lesson content, edited by hand or
    // by Gemini); sync it in without a conflict warning, flagged
    // distinctly from a real cross-run conflict.
    if (!DRY_RUN) store.rawWrite(relPath, fileContent, { force: true });
    results.push({ kind: 'raw-bootstrap-from-file', relPath });
    state[stateKey] = { fileContent, dbContent: fileContent, fileMtimeMs, dbUpdatedAtMs: Date.now() };
    return;
  }

  const fileChanged = fileContent !== last.fileContent;
  const dbChanged = dbContent !== last.dbContent;

  if (fileChanged && dbChanged) {
    console.warn(`[diff-sync] CONFLICT ${relPath}: both file and vault.db changed since last sync -- file (mtime) wins.`, {
      fileMtimeMs, lastFileMtimeMs: last.fileMtimeMs, dbUpdatedAtMs, lastDbUpdatedAtMs: last.dbUpdatedAtMs,
    });
    if (!DRY_RUN) store.rawWrite(relPath, fileContent, { force: true });
    results.push({ kind: 'raw-conflict-file-wins', relPath });
    state[stateKey] = { fileContent, dbContent: fileContent, fileMtimeMs, dbUpdatedAtMs: Date.now() };
  } else if (fileChanged) {
    if (!DRY_RUN) store.rawWrite(relPath, fileContent, { force: true });
    results.push({ kind: 'raw-update-from-file', relPath });
    state[stateKey] = { fileContent, dbContent: fileContent, fileMtimeMs, dbUpdatedAtMs: Date.now() };
  } else if (dbChanged) {
    results.push({ kind: 'raw-db-ahead-left-alone', relPath });
    state[stateKey] = { fileContent: last.fileContent, dbContent, fileMtimeMs: last.fileMtimeMs, dbUpdatedAtMs };
  }
}

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
  if (!DRY_RUN) store.ensureVault();

  const state = loadState();
  const results = [];
  let totalChecked = 0;

  for (const { relPath, key } of CONTENT_TSVS) {
    const filePath = path.join(MEMORY_DIR, relPath);
    if (fs.existsSync(filePath)) totalChecked += parseTSVText(fs.readFileSync(filePath, 'utf8')).length;
    syncTsvCollection(store, MEMORY_DIR, relPath, key, state, results);
  }

  const lessonFiles = [...discoverLessonFiles(MEMORY_DIR), ...EXTRA_RAW_FILES.filter((f) => fs.existsSync(path.join(MEMORY_DIR, f)))];
  totalChecked += lessonFiles.length;
  for (const relPath of lessonFiles) {
    syncLessonFile(store, MEMORY_DIR, relPath, state, results);
  }

  saveState(state);

  console.log(`\n${DRY_RUN ? 'DRY RUN -- ' : ''}diff-sync, memoryDir=${MEMORY_DIR}\n`);
  const NOISY = new Set(['tsv-db-ahead-left-alone', 'raw-db-ahead-left-alone', 'tsv-baseline-match']);
  const changed = results.filter((r) => !NOISY.has(r.kind));
  if (!changed.length) {
    console.log('Nothing to sync -- files and vault.db already match.');
  } else {
    for (const r of changed) console.log(r.kind.padEnd(28), r.relPath, r.key || '');
  }
  const conflicts = results.filter((r) => r.kind.includes('conflict'));
  console.log(`\n${totalChecked} keys checked, ${changed.length} synced, ${conflicts.length} conflict(s).`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
