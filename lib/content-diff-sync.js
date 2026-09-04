'use strict';
/**
 * BI26090301's file-to-DB catch-up/diff-sync, extracted from
 * scripts/diff-sync-content-to-db.js into a reusable module so the same
 * logic can run both as a one-off CLI pass and as a live in-process loop
 * (content-sync-loop.js) -- the 31 Aug SQLite cutover left no ongoing sync
 * from file-based content authoring (course lesson .md files, courses.tsv,
 * and other content-authoring TSVs edited by hand or by Gemini) back into
 * vault.db; this is what actually closes that gap, however it's invoked.
 *
 * Conflict rule (both sides changed since the last recorded sync point for
 * a key): the file wins, but a warning is logged naming the key and both
 * timestamps -- never a silent overwrite in either direction.
 *
 * Only meaningful under VAULT_STORE_ENGINE=sqlite (the tsv engine has no
 * separate DB to drift from the files -- it IS the files).
 */

const fs = require('fs');
const path = require('path');
const { parseTSVText } = require('./tsv');

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
// turn up; course-standards.md is the first found needing it.
const EXTRA_RAW_FILES = [
  'learning/_standards/course-standards.md',
];

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(statePath, state, { dryRun }) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
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

function syncTsvCollection(store, memoryDir, relPath, keyCol, state, results, { dryRun }) {
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
      if (!dryRun) store.append(relPath, fileRow);
      results.push({ kind: 'tsv-insert', relPath, key });
      state[stateKey] = { fileSnapshot: fileRow, dbSnapshot: fileRow };
      continue;
    }

    // A snapshot recorded before `cols` grew (a schema column added since
    // this row was last synced, e.g. GROUP_ID) doesn't cover every current
    // column -- treat that exactly like "no baseline yet" for this row,
    // not like an established one. Without this, a freshly-migrated column
    // (ALTER TABLE ... DEFAULT '-') reads as "DB changed since last sync"
    // purely because the old snapshot has no key for it at all, and falls
    // into the dbChanged-only branch below, which *keeps* the wrong
    // default forever instead of backfilling from the file (FI26090302 --
    // confirmed live: every course's GROUP_ID stuck at '-' this way).
    const hasFullBaseline = last && cols.every((c) => c in last.fileSnapshot && c in last.dbSnapshot);

    if (!hasFullBaseline) {
      // First time this key has been seen by this tool (or seen under a
      // narrower column set) -- no sync history to detect a genuine
      // double-edit against, so this is NOT a conflict, just an
      // unestablished baseline. If file and DB already agree, record it
      // and move on silently. If they don't, the file is the authoring
      // source of truth (courses.tsv is hand/Gemini-edited; the DB row was
      // last written whenever this collection was migrated or last
      // touched live) -- sync it in without a conflict warning, but flag
      // it distinctly from a real cross-run conflict so a first run's
      // output isn't misread as urgent double-edits.
      if (rowContentEqual(fileRow, dbRow, cols)) {
        results.push({ kind: 'tsv-baseline-match', relPath, key });
      } else {
        if (!dryRun) upsertTsvRow(store, relPath, keyCol, key, fileRow);
        results.push({ kind: 'tsv-bootstrap-from-file', relPath, key });
      }
      state[stateKey] = { fileSnapshot: fileRow, dbSnapshot: fileRow };
      continue;
    }

    const fileChanged = !rowContentEqual(fileRow, last.fileSnapshot, cols);
    const dbChanged = !rowContentEqual(dbRow, last.dbSnapshot, cols);

    if (fileChanged && dbChanged) {
      results.push({ kind: 'tsv-conflict-file-wins', relPath, key, conflict: { fileSnapshot: last.fileSnapshot, dbSnapshotBefore: last.dbSnapshot, fileNow: fileRow, dbNow: dbRow } });
      if (!dryRun) upsertTsvRow(store, relPath, keyCol, key, fileRow);
      state[stateKey] = { fileSnapshot: fileRow, dbSnapshot: fileRow };
    } else if (fileChanged) {
      if (!dryRun) upsertTsvRow(store, relPath, keyCol, key, fileRow);
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

  // FI26090302: the loop above only ever visits keys present in the file --
  // a DB row whose key no longer exists in the file (renamed away, or a
  // pre-existing duplicate from before an ID scheme changed) was never
  // reached by any branch above, so it survived forever no matter how many
  // syncs ran, each reporting a clean 0-conflict pass while the DB stayed
  // visibly wrong. These TSVs are fully file-authored (see CONTENT_TSVS'
  // own comment) -- the file is the complete, authoritative row set, so any
  // DB key missing from it is stale and gets pruned here, not left for a
  // human to notice via a row count mismatch.
  const staleKeys = [...dbByKey.keys()].filter((k) => !fileByKey.has(k));
  if (staleKeys.length > 0) {
    const staleSet = new Set(staleKeys);
    if (!dryRun) {
      store.rewrite(relPath, (rows) => rows.filter((r) => !staleSet.has(r[keyCol])), { force: true, why: 'diff-sync prune: row removed from file' });
    }
    for (const key of staleKeys) {
      results.push({ kind: 'tsv-pruned-stale-db-row', relPath, key });
      delete state[`tsv:${relPath}#${key}`];
    }
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
function syncLessonFile(store, memoryDir, relPath, state, results, { dryRun }) {
  const filePath = path.join(memoryDir, relPath);
  const fileMtimeMs = fs.statSync(filePath).mtimeMs;
  const fileContent = fs.readFileSync(filePath, 'utf8');
  const dbContent = store.rawRead(relPath);
  const dbUpdatedAtMs = store.statMtimeMs(relPath);

  const stateKey = `raw:${relPath}`;
  const last = state[stateKey];

  if (!dbContent) {
    // never synced into the DB at all -- no conflict possible.
    if (!dryRun) store.rawWrite(relPath, fileContent, { force: true });
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
    if (!dryRun) store.rawWrite(relPath, fileContent, { force: true });
    results.push({ kind: 'raw-bootstrap-from-file', relPath });
    state[stateKey] = { fileContent, dbContent: fileContent, fileMtimeMs, dbUpdatedAtMs: Date.now() };
    return;
  }

  const fileChanged = fileContent !== last.fileContent;
  const dbChanged = dbContent !== last.dbContent;

  if (fileChanged && dbChanged) {
    results.push({ kind: 'raw-conflict-file-wins', relPath, conflict: { fileMtimeMs, lastFileMtimeMs: last.fileMtimeMs, dbUpdatedAtMs, lastDbUpdatedAtMs: last.dbUpdatedAtMs } });
    if (!dryRun) store.rawWrite(relPath, fileContent, { force: true });
    state[stateKey] = { fileContent, dbContent: fileContent, fileMtimeMs, dbUpdatedAtMs: Date.now() };
  } else if (fileChanged) {
    if (!dryRun) store.rawWrite(relPath, fileContent, { force: true });
    results.push({ kind: 'raw-update-from-file', relPath });
    state[stateKey] = { fileContent, dbContent: fileContent, fileMtimeMs, dbUpdatedAtMs: Date.now() };
  } else if (dbChanged) {
    results.push({ kind: 'raw-db-ahead-left-alone', relPath });
    state[stateKey] = { fileContent: last.fileContent, dbContent, fileMtimeMs: last.fileMtimeMs, dbUpdatedAtMs };
  }
}

/**
 * @param {object} opts
 * @param {object} opts.store - a sqlite-engine store (must expose read/append/rewrite/rawRead/rawWrite/statMtimeMs)
 * @param {string} opts.memoryDir
 * @param {string} opts.statePath
 * @param {boolean} [opts.dryRun]
 * @returns {{results: object[], totalChecked: number, changed: object[], conflicts: object[]}}
 */
function runContentDiffSync({ store, memoryDir, statePath, dryRun = false }) {
  const state = loadState(statePath);
  const results = [];
  let totalChecked = 0;

  for (const { relPath, key } of CONTENT_TSVS) {
    const filePath = path.join(memoryDir, relPath);
    if (fs.existsSync(filePath)) totalChecked += parseTSVText(fs.readFileSync(filePath, 'utf8')).length;
    syncTsvCollection(store, memoryDir, relPath, key, state, results, { dryRun });
  }

  const lessonFiles = [...discoverLessonFiles(memoryDir), ...EXTRA_RAW_FILES.filter((f) => fs.existsSync(path.join(memoryDir, f)))];
  totalChecked += lessonFiles.length;
  for (const relPath of lessonFiles) {
    syncLessonFile(store, memoryDir, relPath, state, results, { dryRun });
  }

  saveState(statePath, state, { dryRun });

  const NOISY = new Set(['tsv-db-ahead-left-alone', 'raw-db-ahead-left-alone', 'tsv-baseline-match']);
  const changed = results.filter((r) => !NOISY.has(r.kind));
  const conflicts = results.filter((r) => r.kind.includes('conflict'));
  return { results, totalChecked, changed, conflicts };
}

module.exports = { runContentDiffSync, discoverLessonFiles, CONTENT_TSVS, EXTRA_RAW_FILES };
