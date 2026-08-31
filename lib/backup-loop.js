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
 * @param {object} opts
 * @param {object} opts.store - a sqlite-engine store (must expose snapshotToFile)
 * @param {import('./backup/backup-target').BackupTarget} opts.backupTarget
 * @param {{log:Function}} [opts.auditLog]
 * @param {object} [opts.keepPolicy] - passed through to backupTarget.prune()
 */
function createBackupLoop({ store, backupTarget, auditLog = { log: () => {} }, keepPolicy = {} }) {
  let timer = null;
  let running = false;
  let lastResult = null;

  async function runOnce() {
    if (running) return { skipped: 'already running', lastResult };
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

module.exports = { createBackupLoop };
