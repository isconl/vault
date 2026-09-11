#!/usr/bin/env node
'use strict';
/**
 * One-way sync: pulls the LIVE course catalog from the real production
 * hub (https://isconl.acexoft.com by default) and writes it directly into
 * THIS machine's local vault.db -- courses.tsv rows + every lesson's raw
 * markdown, live always wins. Built per Sconl's explicit direction
 * (PI26091101, 11 Sep 2026 PLAN session): "onedrive is more like an s3
 * bucket archive, I would prefer the OCI db to be the one pulled instead
 * of onedrive" -- goes through the same authenticated public API the
 * deploy pipeline itself trusts (HUB_TOKEN), not the OneDrive backup
 * archive and not SSH.
 *
 * Scoped to learning/* -- courses, lesson content, AND Sconl's own
 * progress/resume/activity state (progress.tsv, resume.tsv) -- but not
 * modules_meta.tsv (per-module editorial metadata, not interaction state,
 * out of scope so far). Originally shipped courses+lessons only; extended
 * same day after Sconl flagged the "Learning Activity" contribution graph
 * itself disagreeing between localhost and live (41 contributions/14
 * active days live vs 3/1 local, different "Continue Learning" lesson) --
 * that view reads progress.tsv/resume.tsv, which the first version
 * deliberately hadn't touched on the theory that it was personal
 * dev-session state worth preserving. Wrong call: Sconl's own real
 * activity IS the thing he wants mirrored, not a hypothetical local
 * testing session's. Confirmed this machine is dev/testing only, never
 * where content is authored -- a full one-way overwrite of course
 * content AND activity state is safe here.
 *
 * Staleness-aware by default: a course whose live UPDATED_AT/LESSON_COUNT
 * already matches local's is skipped entirely (no lesson fetches) -- this
 * is what makes it cheap enough to run on every fleet launch (decision,
 * same PLAN session: automatic staleness check on every launch, not
 * on-request-only). Pass --force to re-fetch every lesson regardless.
 *
 * Usage:
 *   node scripts/sync-learning-from-live.js [--url https://isconl.acexoft.com] [--only <courseId>] [--force]
 */

const path = require('path');
const https = require('https');
const secrets = require('../lib/secrets');
const { createSqliteStore } = require('../lib/sqlite-store');

function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${url} -> HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

const SCHEMA_COLS = ['ID', 'TITLE', 'GOAL', 'STATUS', 'LESSON_COUNT', 'CREATED_AT', 'UPDATED_AT', 'NOTE', 'CLASSROOM', 'LEVEL', 'SUBTITLE', 'GROUP_ID'];

async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const baseUrl = (urlIdx !== -1 ? args[urlIdx + 1] : 'https://isconl.acexoft.com').replace(/\/$/, '');
  const onlyIdx = args.indexOf('--only');
  const onlyId = onlyIdx !== -1 ? args[onlyIdx + 1] : null;
  const force = args.includes('--force');

  await secrets.init({ startRefreshLoop: false });
  const token = process.env.HUB_TOKEN || process.env.ISCONL_TOKEN || secrets.get('HUB_TOKEN') || secrets.get('ISCONL_TOKEN');
  if (!token) { console.error('ERROR: HUB_TOKEN/ISCONL_TOKEN not available (env or Bitwarden).'); process.exit(1); }

  const dbKeyPassphrase = process.env.VAULT_DB_KEY_PASSPHRASE || secrets.get('VAULT_DB_KEY_PASSPHRASE');
  if (!dbKeyPassphrase) { console.error('ERROR: VAULT_DB_KEY_PASSPHRASE not available.'); process.exit(1); }

  const memoryDir = process.env.VAULT_MEMORY_DIR || path.join(__dirname, '..', 'memory');
  const store = createSqliteStore({ memoryDir, logsDir: path.join(memoryDir, '..', 'logs'), dbKeyPassphrase });

  console.log(`Fetching live course catalog from ${baseUrl} ...`);
  const live = await fetchJson(`${baseUrl}/api/learning`, token);
  const liveCourses = onlyId ? live.courses.filter((c) => c.ID === onlyId) : live.courses;

  const localRows = store.read('learning/courses.tsv');
  const localById = new Map(localRows.map((r) => [r.ID, r]));

  const staleCourses = liveCourses.filter((c) => {
    if (force) return true;
    const local = localById.get(c.ID);
    if (!local) return true; // new course, not seen locally at all
    return String(local.UPDATED_AT || '') !== String(c.UPDATED_AT || '') ||
           String(local.LESSON_COUNT || '') !== String(c.LESSON_COUNT || '');
  });

  console.log(`  ${liveCourses.length} course(s) live, ${staleCourses.length} stale/new (${liveCourses.length - staleCourses.length} already current, skipped).`);

  let coursesWritten = 0;
  let lessonsWritten = 0;
  let lessonErrors = 0;

  if (staleCourses.length) {
    // courses.tsv: upsert only the rows actually being (re)synced -- any
    // other local-only rows (shouldn't exist on a dev/testing machine, but
    // don't assume) are left untouched rather than wiped.
    store.rewrite('learning/courses.tsv', (rows) => {
      const byId = new Map(rows.map((r) => [r.ID, r]));
      for (const c of staleCourses) {
        const row = {};
        for (const col of SCHEMA_COLS) row[col] = c[col] !== undefined && c[col] !== null ? String(c[col]) : '-';
        byId.set(c.ID, row);
        coursesWritten++;
      }
      return Array.from(byId.values());
    }, { force: true });

    for (const c of staleCourses) {
      for (const lesson of c.lessons || []) {
        try {
          const lessonUrl = `${baseUrl}/api/learning/lesson?course=${encodeURIComponent(c.ID)}&file=${encodeURIComponent(lesson.file)}`;
          const result = await fetchJson(lessonUrl, token);
          if (typeof result.content !== 'string') throw new Error('no content in response');
          store.rawWrite(`learning/${c.ID}/${lesson.file}`, result.content, { force: true });
          lessonsWritten++;
        } catch (e) {
          lessonErrors++;
          console.error(`  lesson fetch failed: ${c.ID}/${lesson.file}: ${e.message}`);
        }
      }
    }
  }

  // progress.tsv + resume.tsv: Sconl's own real activity -- the "Learning
  // Activity" contribution graph and "Continue Learning" resume position
  // read these. Always compared against every live course (not gated
  // behind the course-content staleness filter above), since a lesson can
  // be freshly completed without its course's own UPDATED_AT/LESSON_COUNT
  // changing at all -- these are cheap (no extra HTTP calls, the data's
  // already in `live`), so the only cost worth avoiding is an unnecessary
  // DB write when nothing actually changed.
  const PROGRESS_COLS = ['COURSE_ID', 'LESSON', 'STATUS', 'UPDATED_AT'];
  const progressRows = [];
  for (const c of liveCourses) {
    for (const lesson of c.lessons || []) {
      if (!lesson.status || lesson.status === 'new') continue; // no real progress row for an untouched lesson
      progressRows.push({ COURSE_ID: c.ID, LESSON: lesson.file, STATUS: lesson.status, UPDATED_AT: lesson.touchedAt || '-' });
    }
  }
  const RESUME_COLS = ['COURSE_ID', 'LESSON', 'SCROLL_PCT', 'UPDATED_AT'];
  const resumeRows = (live.resume || []).map((r) => {
    const row = {};
    for (const col of RESUME_COLS) row[col] = r[col] !== undefined && r[col] !== null ? String(r[col]) : '-';
    return row;
  });

  const rowsEqual = (a, b, cols) => a.length === b.length && a.every((r, i) => cols.every((c) => String(r[c] || '') === String(b[i][c] || '')));
  const localProgress = store.read('learning/progress.tsv');
  const localResume = store.read('learning/resume.tsv');
  let progressChanged = false, resumeChanged = false;
  if (!rowsEqual(localProgress, progressRows, PROGRESS_COLS)) {
    store.rewrite('learning/progress.tsv', () => progressRows, { force: true });
    progressChanged = true;
  }
  if (!rowsEqual(localResume, resumeRows, RESUME_COLS)) {
    store.rewrite('learning/resume.tsv', () => resumeRows, { force: true });
    resumeChanged = true;
  }

  if (!staleCourses.length && !progressChanged && !resumeChanged) {
    console.log('Nothing to do -- local already matches live (courses, progress, and resume).');
    return;
  }

  console.log(`Done. ${coursesWritten} course row(s) written, ${lessonsWritten} lesson file(s) synced, ` +
    `progress ${progressChanged ? `updated (${progressRows.length} row(s))` : 'unchanged'}, ` +
    `resume ${resumeChanged ? `updated (${resumeRows.length} row(s))` : 'unchanged'}, ${lessonErrors} lesson error(s).`);
  if (lessonErrors > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
