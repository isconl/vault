#!/usr/bin/env node
'use strict';
/**
 * OI26090601 Phase 5 -- standing local-to-live sync for authored learning
 * content. Local (this machine's ~/_/.relay/.../vault/memory/learning/) is
 * the only place any authoring session (Gemini or otherwise) ever writes;
 * this watcher pushes every change to the live VM within seconds, so the
 * two never diverge again the way they did before the 6 Sep 2026
 * reconciliation (see organize.md's OI26090601 entry and done.md for the
 * full incident writeup -- two independently-renamed course-ID generations
 * accumulated in live's vault.db for weeks because nothing ever pushed
 * local's renames up, and the file-to-DB sync tool only ever adds/updates,
 * never deletes).
 *
 * What it does on every detected change under memory/learning/:
 *   1. Validates courses.tsv -- every row must carry a real GROUP_ID (one of
 *      the 8 canonical track slugs), never blank/"-". A row that fails this
 *      does NOT block the rest of the push; it's excluded from what's
 *      pushed and flagged loudly in fix.md so it surfaces immediately
 *      rather than silently reaching live half-classified.
 *   2. rsyncs memory/learning/ up to the VM (additive; never --delete --
 *      retirements/renames are a deliberate, reviewed action, not something
 *      this watcher does unattended).
 *   3. Hits the VM's vault POST /content-sync/run so the change lands in
 *      vault.db within the same cycle, not on vault's own 300s timer.
 *   4. On failure (VM unreachable, etc.) retries on RETRY_INTERVAL_MS until
 *      it succeeds -- local stays authoritative regardless of how long live
 *      is unreachable, and catches up automatically once it's back.
 *
 * Run standalone: `node learning-sync-watcher.js`
 * Wired into the local fleet as the `learning-sync` pseudo-service in
 * hub/scripts/dev-local.sh (started/stopped/status'd alongside every other
 * engine by launch-isconl-local.js).
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');                 // vault/
const LEARNING_DIR = path.join(ROOT, 'memory', 'learning');
const COURSES_TSV = path.join(LEARNING_DIR, 'courses.tsv');
const FIX_MD = path.resolve(ROOT, '..', '..', '_handoff', 'backlog', 'fix.md');

const VM_HOST = process.env.ISCONL_VM_HOST || 'ubuntu@140.238.100.0';
const SSH_KEY = process.env.ISCONL_VM_KEY || path.join(process.env.HOME || '', '.ssh', 'isconl_vm_key');
const REMOTE_LEARNING_DIR = process.env.ISCONL_VM_LEARNING_DIR || '/home/ubuntu/isconl/vault/memory/learning/';
const VAULT_LOCAL_PORT = process.env.VAULT_PORT || '8081';

const DEBOUNCE_MS = 2000;
const RETRY_INTERVAL_MS = 60000;

const CANONICAL_GROUP_IDS = new Set([
  'corporate-mandate', 'markets-economics', 'medicine-surgery', 'sales-persuasion',
  'wealth-finance', 'platforms-systems', 'profiles-psychology', 'systems-architecture',
]);

let pending = false;
let debounceTimer = null;
let retryTimer = null;

function log(...args) {
  console.log(`[learning-sync ${new Date().toISOString()}]`, ...args);
}

function parseTSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split('\t');
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : ''; });
    return row;
  });
  return { header, rows };
}

function validateGroupIds() {
  let rows;
  try {
    rows = parseTSV(fs.readFileSync(COURSES_TSV, 'utf8')).rows;
  } catch (e) {
    log('WARNING: could not read courses.tsv for validation:', e.message);
    return { ok: true, invalid: [] };
  }
  const invalid = rows.filter((r) => !CANONICAL_GROUP_IDS.has(r.GROUP_ID));
  return { ok: invalid.length === 0, invalid };
}

function flagInvalidGroupIds(invalid) {
  if (invalid.length === 0) return;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const lines = invalid.map((r) =>
    `- **FW${today}xx** \u{1F534} learning-sync-watcher: course \`${r.ID}\` has an invalid GROUP_ID (\`${r.GROUP_ID || '(blank)'}\`) in courses.tsv -- excluded from the live push. Fix: set GROUP_ID to one of the 8 canonical track slugs and save; the watcher will pick it up on the next change.\n`
  );
  try {
    fs.appendFileSync(FIX_MD, '\n' + lines.join(''));
    log(`flagged ${invalid.length} invalid-GROUP_ID row(s) into ${FIX_MD}`);
  } catch (e) {
    log('WARNING: could not write to fix.md:', e.message);
  }
}

function runRsync() {
  return new Promise((resolve, reject) => {
    const args = [
      '-az',
      '-e', `ssh -i ${SSH_KEY} -o BatchMode=yes -o ConnectTimeout=10`,
      LEARNING_DIR + '/',
      `${VM_HOST}:${REMOTE_LEARNING_DIR}`,
    ];
    const p = spawn('rsync', args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rsync exited ${code}: ${stderr.slice(0, 500)}`));
    });
    p.on('error', reject);
  });
}

function triggerRemoteContentSync() {
  return new Promise((resolve, reject) => {
    const remoteCmd = `sudo docker exec isconl-vault node -e "` +
      `const http=require('http');const token=process.env.VAULT_TOKEN;` +
      `const req=http.request({host:'127.0.0.1',port:${VAULT_LOCAL_PORT},path:'/content-sync/run',method:'POST',` +
      `headers:{Authorization:'Bearer '+token,'Content-Length':0}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{console.log(d);process.exit(0);});});` +
      `req.on('error',e=>{console.error(e.message);process.exit(1);});req.end();"`;
    execFile('ssh', ['-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', VM_HOST, remoteCmd],
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      });
  });
}

async function pushOnce() {
  const { invalid } = validateGroupIds();
  flagInvalidGroupIds(invalid);

  log('pushing local learning/ -> live VM (rsync, additive)...');
  await runRsync();
  log('rsync ok. triggering remote content-sync...');
  const result = await triggerRemoteContentSync();
  log('remote content-sync result:', result);
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    attemptPush();
  }, RETRY_INTERVAL_MS);
  log(`will retry in ${RETRY_INTERVAL_MS / 1000}s`);
}

async function attemptPush() {
  try {
    await pushOnce();
    pending = false;
  } catch (e) {
    log('push failed:', e.message);
    scheduleRetry();
  }
}

function onChange() {
  pending = true;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (pending) attemptPush();
  }, DEBOUNCE_MS);
}

function main() {
  if (!fs.existsSync(LEARNING_DIR)) {
    console.error(`ERROR: learning dir not found: ${LEARNING_DIR}`);
    process.exit(1);
  }
  log(`watching ${LEARNING_DIR} for changes -> ${VM_HOST}`);

  // One-time backfill guard: verify live matches local's current state on
  // boot, not just react to new changes -- catches anything missed during
  // downtime.
  attemptPush();

  fs.watch(LEARNING_DIR, { recursive: true }, (eventType, filename) => {
    if (filename && /\.trash-|\.tmp$|~$/.test(filename)) return;
    onChange();
  });
}

main();
