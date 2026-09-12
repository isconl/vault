'use strict';
/**
 * BI26083005: replaces sync-loop.js's pull-based OneDrive sync entirely.
 * One-directional, local-to-remote, full stop -- no pull, ever, inside this
 * loop. Same public shape as the createSyncLoop it replaces (runOnce,
 * start, stop, getLastResult, isRunning) so the call sites in server.js
 * barely change.
 */

const fs = require('fs');
const path = require('path');

/**
 * BI26091201: the emptiness-guard threshold, counted in ROWS across the key
 * content collections + raw blobs (see sqlite-store.js's contentStats()), not
 * in bytes. A freshly-bootstrapped vault scores 0 -- ensureVault() creates all
 * 47 schema tables empty, seeding no rows -- while a real vault scores in the
 * thousands, so anything in between is a database that has no business
 * overwriting backup history. 25 is deliberately nearer the empty end: the job
 * here is to catch "nothing restored", not to judge how full a vault is.
 */
const DEFAULT_MIN_CONTENT_ROWS = 25;

/**
 * @param {object} opts
 * @param {object} opts.store - a sqlite-engine store (must expose snapshotToFile)
 * @param {import('./backup/backup-target').BackupTarget} opts.backupTarget
 * @param {{log:Function}} [opts.auditLog]
 * @param {object} [opts.keepPolicy] - passed through to backupTarget.prune()
 * @param {number} [opts.minContentRows] - emptiness guard threshold, see below
 */
function createBackupLoop({
  store, backupTarget, auditLog = { log: () => {} }, keepPolicy = {},
  minContentRows = DEFAULT_MIN_CONTENT_ROWS,
}) {
  let timer = null;
  let running = false;
  let lastResult = null;

  /**
   * BI26091201: refuse to push a database with no real content in it.
   *
   * Why this exists on top of backups being opt-in (server.js's
   * VAULT_BACKUP_INTERVAL_MS now defaults OFF): opt-in stops a dev machine
   * pushing at all, but it does nothing about the worse case -- the
   * designated pusher (the OCI VM) coming up on a failed or half-finished
   * restore and pushing that near-empty DB straight over good history,
   * generation after generation, until retention has eaten every real one.
   * Defense in depth, per Sconl's explicit call, 12 Sep 2026.
   *
   * Returns a skip result, or null to proceed.
   */
  function emptinessSkip() {
    if (typeof store.contentStats !== 'function') return null; // tsv engine / test doubles
    let stats;
    try { stats = store.contentStats(); } catch { return null; } // never let the guard itself break backups
    if (stats.totalRows >= minContentRows) return null;
    return {
      skipped: 'empty database',
      totalRows: stats.totalRows,
      minContentRows,
      counts: stats.counts,
      checkedAt: new Date().toISOString(),
    };
  }

  async function runOnce() {
    if (running) return { skipped: 'already running', lastResult };
    const empty = emptinessSkip();
    if (empty) {
      lastResult = empty;
      auditLog.log('vault_backup_skipped_empty', { totalRows: empty.totalRows, minContentRows });
      return empty;
    }
    running = true;
    const startedAt = new Date().toISOString();
    const tmpDir = path.join(store.memoryDir, '.backup-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `vault-snapshot-${Date.now()}.db`);
    let result;
    try {
      store.snapshotToFile(tmp);
      // BI26083007: the salt is not secret, but losing it makes every
      // backup generation permanently unreadable (the passphrase alone
      // can't re-derive the encryption key without it) -- carrying it in
      // the manifest closes the drive-loss single-point-of-failure
      // RESTORE.md's disaster-recovery section otherwise still has.
      let saltHex;
      try { saltHex = fs.readFileSync(path.join(store.memoryDir, '.db-salt')).toString('hex'); } catch { /* engine without a salt file (e.g. tsv) -- fine, omit */ }
      const pushResult = await backupTarget.push(tmp, { source: 'backup-loop', ...(saltHex ? { saltHex } : {}) });
      if (!pushResult.ok) {
        result = { ok: false, startedAt, finishedAt: new Date().toISOString(), error: pushResult.error, stage: 'push' };
      } else {
        // BI26091201: prune() stays automatic, deliberately -- considered and
        // kept, not overlooked. PI26091001 worried about cross-machine
        // interleaving (machine A's retention pass deleting machine B's
        // generations), but that risk only existed because every machine
        // pushed. Now that backups are opt-in and only the designated pusher
        // (the OCI VM) has them enabled, exactly one machine ever prunes, so
        // the backup history has a single writer and needs no
        // machine-namespacing to stay coherent.
        const pruneResult = await backupTarget.prune(keepPolicy);
        result = {
          ok: true, startedAt, finishedAt: new Date().toISOString(),
          ref: pushResult.ref,
          pruned: pruneResult.ok ? pruneResult.removed : [],
          pruneError: pruneResult.ok ? undefined : pruneResult.error,
        };
      }
    } catch (e) {
      result = { ok: false, startedAt, finishedAt: new Date().toISOString(), error: String(e.message || e).slice(0, 200), stage: 'snapshot' };
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      running = false;
    }
    lastResult = result;
    auditLog.log('vault_backup_pass', { ok: result.ok, ref: result.ref, error: result.error, prunedCount: (result.pruned || []).length });
    return result;
  }

  /** Fires an immediate pass, then repeats every intervalMs. Never blocks the caller. */
  function start(intervalMs) {
    if (timer) return;
    runOnce().catch((e) => auditLog.log('vault_backup_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    timer = setInterval(() => {
      runOnce().catch((e) => auditLog.log('vault_backup_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, getLastResult: () => lastResult, isRunning: () => running };
}

module.exports = { createBackupLoop, DEFAULT_MIN_CONTENT_ROWS };
