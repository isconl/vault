'use strict';
/**
 * Live wiring for content-diff-sync.js -- runs the file-to-DB catch-up
 * automatically on an interval instead of requiring a manual
 * `node scripts/diff-sync-content-to-db.js` pass after every content edit.
 * Same public shape as backup-loop.js (runOnce, start, stop, getLastResult,
 * isRunning) for the same reason: server.js wires both the same way.
 */

const { runContentDiffSync } = require('./content-diff-sync');

/**
 * @param {object} opts
 * @param {object} opts.store - a sqlite-engine store
 * @param {string} opts.memoryDir
 * @param {string} opts.statePath
 * @param {{log:Function}} [opts.auditLog]
 */
function createContentSyncLoop({ store, memoryDir, statePath, auditLog = { log: () => {} } }) {
  let timer = null;
  let running = false;
  let lastResult = null;

  async function runOnce() {
    if (running) return { skipped: 'already running', lastResult };
    running = true;
    const startedAt = new Date().toISOString();
    let result;
    try {
      const { totalChecked, changed, conflicts } = runContentDiffSync({ store, memoryDir, statePath, dryRun: false });
      for (const c of conflicts) {
        auditLog.log('vault_content_sync_conflict', { kind: c.kind, relPath: c.relPath, key: c.key });
      }
      result = { ok: true, startedAt, finishedAt: new Date().toISOString(), totalChecked, syncedCount: changed.length, conflictCount: conflicts.length };
    } catch (e) {
      result = { ok: false, startedAt, finishedAt: new Date().toISOString(), error: String(e.message || e).slice(0, 200) };
    } finally {
      running = false;
    }
    lastResult = result;
    auditLog.log('vault_content_sync_pass', { ok: result.ok, syncedCount: result.syncedCount, conflictCount: result.conflictCount, error: result.error });
    return result;
  }

  /** Fires an immediate pass, then repeats every intervalMs. Never blocks the caller. */
  function start(intervalMs) {
    if (timer) return;
    runOnce().catch((e) => auditLog.log('vault_content_sync_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    timer = setInterval(() => {
      runOnce().catch((e) => auditLog.log('vault_content_sync_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, getLastResult: () => lastResult, isRunning: () => running };
}

module.exports = { createContentSyncLoop };
