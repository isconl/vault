'use strict';
/**
 * The vault engine: schema bootstrap, column migration, and the disaster-
 * recovery machinery (boot-time self-repair, row-level reconciliation,
 * snapshotting, the trash/keep-previous-version safety net).
 *
 * Ported from isconl-agent's server.js. Each mechanism here exists because
 * of a real, documented incident (noted inline) -- this is not defensive
 * programming for its own sake.
 *
 * Restructured from server.js's require-time auto-run (readTSV etc. ran as
 * side effects of loading the file) into an explicit factory + methods the
 * caller invokes on its own schedule -- important for testability, and
 * because in the split architecture this may run inside a service whose
 * boot sequence needs to control ordering (secrets before vault repair,
 * etc.) rather than have it happen implicitly at require() time.
 */

const fs = require('fs');
const path = require('path');
const { stripBOM, readTSV, appendTSV, rewriteTSV } = require('./tsv');
const defaultSchema = require('./default-schema');

/**
 * @param {object} opts
 * @param {string} opts.memoryDir - the vault root (all schema paths are relative to this)
 * @param {string} opts.logsDir - where actions.jsonl (for taskIdsDeletedOnPurpose) lives
 * @param {object} [opts.schema] - defaults to the full ported schema; pass a superset to extend
 * @param {{log:Function}} [opts.auditLog]
 */
function createVaultStore({ memoryDir, logsDir, schema = defaultSchema, auditLog = { log: () => {} } }) {
  if (!memoryDir) throw new Error('createVaultStore requires memoryDir');
  const TRASH_DIR = path.join(memoryDir, '.trash');
  const SNAPSHOT_ROOT = path.join(memoryDir, '.snapshots');

  function keepPreviousVersion(relPath, contents, why) {
    try {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      const dest = path.join(TRASH_DIR, day, `${relPath.replace(/[\\/]/g, '__')}.${stamp}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, contents);
      auditLog.log('vault_previous_version_kept', { file: relPath, why: why || 'rewrite', kept: path.basename(dest) });
      return dest;
    } catch (e) {
      auditLog.log('vault_keep_previous_failed', { file: relPath, error: String(e.message || e).slice(0, 100) });
      return null;
    }
  }

  // -- bound convenience wrappers around the pure tsv.js primitives -------------
  const read = (relPath) => readTSV(memoryDir, relPath);
  const append = (relPath, row) => appendTSV(memoryDir, relPath, row, { headerIfMissing: schema[relPath], auditLog });
  const rewrite = (relPath, fn, opts = {}) => rewriteTSV(memoryDir, relPath, fn, { ...opts, auditLog, keepPreviousVersion });

  /**
   * Generic (non-TSV) file read -- for the JSON/YAML/markdown state that
   * syncableFiles() already declares syncable but that readTSV/rewriteTSV
   * can't parse (they're TSV-shaped, these aren't). Returns '' for a
   * missing file so a caller can treat "never synced" and "empty" the same
   * way readTSV does.
   */
  function rawRead(relPath) {
    const fp = path.join(memoryDir, relPath);
    try { return stripBOM(fs.readFileSync(fp, 'utf8')); } catch { return ''; }
  }

  /**
   * Generic (non-TSV) file write, mirroring rewriteTSV's safety shape: the
   * previous version is always kept (same trash mechanism), and a write
   * that would blank out a file that had real content is blocked unless
   * force:true -- the same massacre-guard spirit as rewriteTSV, just judged
   * by byte count instead of row count since these files have no rows.
   */
  function rawWrite(relPath, contents, { force = false } = {}) {
    const fp = path.join(memoryDir, relPath);
    const before = rawRead(relPath);
    if (before.trim().length > 0 && contents.trim().length === 0 && !force) {
      throw new Error(`rawWrite blocked: would empty ${relPath} (${before.length} bytes -> 0); pass force:true to override`);
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (before) keepPreviousVersion(relPath, before, 'rawWrite');
    fs.writeFileSync(fp, contents);
    auditLog.log('vault_raw_written', { file: relPath, bytesBefore: before.length, bytesAfter: contents.length });
  }

  /** Create any missing vault file, with its header, so a new host works on first boot. Never touches an existing file. */
  function ensureVault({ spacesTemplatePath } = {}) {
    const created = [];
    for (const [rel, header] of Object.entries(schema)) {
      const fp = path.join(memoryDir, rel);
      if (fs.existsSync(fp)) continue;
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        if (rel === 'space/spaces.tsv' && spacesTemplatePath && fs.existsSync(spacesTemplatePath)) {
          fs.copyFileSync(spacesTemplatePath, fp);
          created.push(rel + ' (from template)');
        } else {
          fs.writeFileSync(fp, header + '\n');
          created.push(rel);
        }
      } catch (e) {
        auditLog.log('vault_ensure_failed', { file: rel, error: String(e.message || e).slice(0, 120) });
      }
    }
    if (created.length) auditLog.log('vault_bootstrapped', { created: created.join(',') });
    return created;
  }

  /**
   * Schema upgrade for vault files that already exist on disk. appendTSV
   * writes by the FILE's header, so adding a column to the schema alone
   * would silently drop the new field on every existing vault. Walks each
   * known file and appends any schema columns the on-disk header is
   * missing, padding old rows with '-'. Columns are only ever ADDED, never
   * reordered or removed -- an unknown extra column in the file stays put.
   */
  function ensureVaultColumns() {
    let upgraded = 0;
    for (const [relPath, schemaHeader] of Object.entries(schema)) {
      const fp = path.join(memoryDir, relPath);
      if (!fs.existsSync(fp)) continue;
      try {
        const raw = stripBOM(fs.readFileSync(fp, 'utf8'));
        const lines = raw.split(/\r?\n/);
        const have = lines[0].split('\t');
        const missing = schemaHeader.split('\t').filter(h => !have.includes(h));
        if (!missing.length) continue;
        const pad = '\t' + missing.map(() => '-').join('\t');
        const out = [have.concat(missing).join('\t'),
          ...lines.slice(1).map(l => l.trim() ? l + pad : l)].join('\n');
        fs.writeFileSync(fp, out);
        auditLog.log('vault_columns_added', { file: relPath, columns: missing.join(',') });
        upgraded++;
      } catch (e) {
        auditLog.log('vault_column_upgrade_failed', { file: relPath, error: String(e.message || e).slice(0, 120) });
      }
    }
    return upgraded;
  }

  /**
   * BOOT-TIME SELF-REPAIR. A vault TSV that is header-only while a snapshot
   * of it holds rows has lost its contents, whatever the cause (a
   * header-only file pulled over a populated one, a rewrite that dropped
   * everything, a race between two processes). This covers the OUTCOME: on
   * every boot, any registry that's empty while its most recent snapshot
   * isn't gets restored. No theory about how the loss happened is needed.
   */
  function repairEmptiedRegistries() {
    const bodyRows = (t) => t.trim().split(/\r?\n/).filter(l => l.trim()).length - 1;
    let repaired = 0;
    try {
      if (!fs.existsSync(SNAPSHOT_ROOT)) return 0;
      const days = fs.readdirSync(SNAPSHOT_ROOT).filter(d => /^\d{8}$/.test(d)).sort().reverse(); // newest first
      for (const rel of Object.keys(schema)) {
        const fp = path.join(memoryDir, rel);
        if (!fs.existsSync(fp)) continue;
        const now = bodyRows(fs.readFileSync(fp, 'utf8'));
        if (now > 0) continue;
        for (const day of days) {
          const sp = path.join(SNAPSHOT_ROOT, day, rel);
          if (!fs.existsSync(sp)) continue;
          const snap = fs.readFileSync(sp, 'utf8');
          if (bodyRows(snap) <= 0) continue;
          keepPreviousVersion(rel, fs.readFileSync(fp, 'utf8'), 'empty-before-repair');
          fs.writeFileSync(fp, snap);
          auditLog.log('vault_emptied_file_repaired', { file: rel, from: day, rows: bodyRows(snap) });
          repaired++;
          break;
        }
      }
    } catch (e) {
      auditLog.log('vault_repair_failed', { error: String(e.message || e).slice(0, 120) });
    }
    if (repaired) auditLog.log('vault_repair_pass', { repaired });
    return repaired;
  }

  /** IDs deliberately deleted through the UI, per the audit log -- these must never be resurrected by reconciliation. */
  function idsDeletedOnPurpose() {
    const ids = new Set();
    try {
      const raw = fs.readFileSync(path.join(logsDir, 'actions.jsonl'), 'utf8');
      for (const m of raw.matchAll(/"action":"task_deleted","taskId":"([^"]+)"/g)) ids.add(m[1]);
    } catch { /* no log yet -- nothing was deliberately deleted */ }
    return ids;
  }

  /**
   * ROW-LEVEL SELF-REPAIR. The pass above only catches a file that lost
   * EVERYTHING -- this reconciles by ROW. For every registry with an ID
   * column, any id that exists in a snapshot or a `.conflict-*`/`.incoming-*`
   * side copy but not in the live file is restored. Rules that make this
   * safe to run unattended: only ever ADDS rows (a genuine UI delete is
   * audited and therefore skipped, never resurrected); the live row always
   * wins on content; restored rows are padded to the live header.
   */
  function reconcileRegistryRows() {
    const parse = (text) => {
      const lines = stripBOM(String(text)).split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return null;
      const head = lines[0].split('\t');
      if (head[0] !== 'ID') return null;
      return { head, rows: lines.slice(1).map(l => {
        const c = l.split('\t');
        return Object.fromEntries(head.map((h, i) => [h, c[i] ?? '-']));
      }) };
    };

    const deleted = idsDeletedOnPurpose();
    let restoredTotal = 0;

    for (const rel of Object.keys(schema)) {
      const fp = path.join(memoryDir, rel);
      if (!fs.existsSync(fp)) continue;
      let live;
      try { live = parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!live) continue;

      const sources = [];
      try {
        for (const day of fs.readdirSync(SNAPSHOT_ROOT).filter(d => /^\d{8}$/.test(d)).sort().reverse()) {
          const sp = path.join(SNAPSHOT_ROOT, day, rel);
          if (fs.existsSync(sp)) sources.push({ from: `snapshot ${day}`, file: sp });
        }
      } catch {}
      try {
        const dir = path.dirname(fp);
        const stem = path.basename(rel).replace(/\.[^.]+$/, '');
        const ext = path.extname(rel);
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${stem}.conflict-`) || f.startsWith(`${stem}.incoming-`)) {
            if (f.endsWith(ext)) sources.push({ from: f, file: path.join(dir, f) });
          }
        }
      } catch {}
      if (!sources.length) continue;

      const have = new Set(live.rows.map(r => r.ID));
      const add = [];
      const seenNew = new Set();
      for (const src of sources) {
        let side;
        try { side = parse(fs.readFileSync(src.file, 'utf8')); } catch { continue; }
        if (!side) continue;
        for (const r of side.rows) {
          const id = r.ID;
          if (!id || id === '-' || have.has(id) || seenNew.has(id) || deleted.has(id)) continue;
          seenNew.add(id);
          const row = {};
          for (const h of live.head) row[h] = (r[h] === undefined || r[h] === '') ? '-' : r[h];
          add.push({ row, from: src.from });
        }
      }
      if (!add.length) continue;

      keepPreviousVersion(rel, fs.readFileSync(fp, 'utf8'), 'before-row-reconcile');
      const out = [live.head.join('\t'),
        ...[...live.rows, ...add.map(a => a.row)]
          .map(r => live.head.map(h => String(r[h] ?? '-').replace(/[\t\r\n]+/g, ' ') || '-').join('\t'))
      ].join('\n') + '\n';
      fs.writeFileSync(fp, out);
      auditLog.log('vault_rows_restored', { file: rel, count: add.length,
        ids: add.map(a => a.row.ID).join(','), from: add.map(a => a.from).join(' | ').slice(0, 160) });
      restoredTotal += add.length;
    }
    if (restoredTotal) auditLog.log('vault_row_reconcile_pass', { restored: restoredTotal });
    return restoredTotal;
  }

  /** Which vault files travel to cloud sync. Backups stay local (recovery points for THIS working copy); everything else goes home. */
  function syncableFiles() {
    const out = [];
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
        // Sync artifacts are never themselves synced -- a pushed .conflict copy
        // gets pulled back down forever otherwise.
        if (/\.backup|\.bak$|^~|\.conflict[-.\d]|\.incoming[-.\d]/.test(e.name)) continue;
        if (r.startsWith('finance/')) continue;   // finance has its own remote home already
        if (!/\.(tsv|json|yaml|yml|md)$/i.test(e.name)) continue;
        out.push(r);
      }
    };
    walk(memoryDir);
    return out;
  }

  /** Daily local snapshot of every syncable vault file into memory/.snapshots/YYYYMMDD/. Keeps the last 7 days. */
  function snapshotVault() {
    try {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const dest = path.join(SNAPSHOT_ROOT, day);
      if (fs.existsSync(dest)) return null;
      for (const rel of syncableFiles()) {
        const from = path.join(memoryDir, rel);
        const to = path.join(dest, rel);
        try {
          const head = fs.readFileSync(from, 'utf8').slice(0, 100);
          if (/^\s*(<!DOCTYPE|<html)/i.test(head)) continue;   // never snapshot corruption
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        } catch {}
      }
      const days = fs.readdirSync(SNAPSHOT_ROOT).filter(d => /^\d{8}$/.test(d)).sort();
      days.slice(0, Math.max(0, days.length - 7)).forEach(d => {
        try { fs.rmSync(path.join(SNAPSHOT_ROOT, d), { recursive: true, force: true }); } catch {}
      });
      auditLog.log('vault_snapshot', { day, kept: Math.min(days.length, 7) });
      return day;
    } catch {
      return null;   // tomorrow's pass retries
    }
  }

  /** Run the full boot sequence: bootstrap missing files, migrate columns, then the two self-repair passes, in that order. */
  function bootRepair(opts = {}) {
    const created = ensureVault(opts);
    const columnsUpgraded = ensureVaultColumns();
    const emptyFilesRepaired = repairEmptiedRegistries();
    const rowsRestored = reconcileRegistryRows();
    return { created, columnsUpgraded, emptyFilesRepaired, rowsRestored };
  }

  return {
    schema,
    read, append, rewrite, rawRead, rawWrite, keepPreviousVersion,
    ensureVault, ensureVaultColumns, repairEmptiedRegistries, reconcileRegistryRows,
    idsDeletedOnPurpose, syncableFiles, snapshotVault, bootRepair,
  };
}

module.exports = { createVaultStore, defaultSchema };
