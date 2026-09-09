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

  // -- write-then-push hook (SYNC1, 2026-08-18; serialized per collection, INC-002 fix, 2026-08-18) ---
  // store.js stays graph-agnostic by design (testable without a real Graph
  // client) -- the caller (server.js, once it has a live graph client) wires
  // in the actual push function via setPushHook. Fire-and-forget from the
  // CALLER's perspective: a write must never block on network, so append()/
  // rewrite() never await this. But pushes for the SAME collection are now
  // serialized (one in flight at a time, via pushQueues) rather than each
  // firing its own independent request -- INC-002 (see _handoff/INCIDENTS.md):
  // a burst of rapid writes to one collection each fired a concurrent push,
  // which raced each other for OneDrive's eTag and caused a 409
  // resourceModified, silently dropping rows since the caller never saw the
  // failure. Serializing means each push in the chain reads the file fresh
  // (pushToRemote's store.rawRead is called at execution time, not queued
  // time) via graph.graphRequest, so a later queued push already includes
  // everything an earlier append wrote to disk -- no data is lost, and only
  // one PUT to OneDrive for this collection is ever in flight.
  let pushHook = null;
  function setPushHook(fn) { pushHook = fn; }
  const pushQueues = new Map(); // relPath -> Promise (tail of that collection's push chain)
  function firePush(relPath) {
    if (!pushHook) return;
    const prev = pushQueues.get(relPath) || Promise.resolve();
    const next = prev.then(() => Promise.resolve(pushHook(relPath))).then((r) => {
      if (r && r.ok === false) auditLog.log('vault_push_after_write_failed', { file: relPath, error: r.error });
      return r;
    }).catch((e) => {
      auditLog.log('vault_push_after_write_failed', { file: relPath, error: String(e.message || e).slice(0, 160) });
    });
    pushQueues.set(relPath, next);
  }

  // -- bound convenience wrappers around the pure tsv.js primitives -------------
  const read = (relPath) => readTSV(memoryDir, relPath);
  const append = (relPath, row) => {
    const ok = appendTSV(memoryDir, relPath, row, { headerIfMissing: schema[relPath], auditLog });
    if (ok) firePush(relPath);
    return ok;
  };
  const rewrite = (relPath, fn, opts = {}) => {
    const lost = rewriteTSV(memoryDir, relPath, fn, { ...opts, auditLog, keepPreviousVersion });
    firePush(relPath);
    return lost;
  };

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
   * Local file's own last-modified time, in ms since epoch -- works for TSV
   * and raw collections alike, since both live at the same
   * path.join(memoryDir, relPath) convention. Returns null for a missing
   * file. Added for FI26082702: onedrive-sync.js's pull guard needs this to
   * tell "local edited since our last known-good sync" from "remote just
   * has different content," without caring whether relPath is TSV or raw.
   */
  function statMtimeMs(relPath) {
    try { return fs.statSync(path.join(memoryDir, relPath)).mtimeMs; } catch { return null; }
  }

  /**
   * List the files directly inside one local vault folder (non-recursive) --
   * for content whose filenames aren't fixed in advance the way a TSV/JSON
   * collection's path is (a course's lesson .md files). Skips dotfiles,
   * `.trash`/`.snapshots`, and the same backup/conflict-artifact patterns
   * syncableFiles() already excludes. Returns [] for a missing directory,
   * matching read()'s "missing means empty" contract.
   */
  function listDir(relPath) {
    const dir = path.join(memoryDir, relPath);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && !/\.backup|\.bak$|~$|\.conflict[-.\d]|\.incoming[-.\d]/.test(e.name))
      .map((e) => {
        const fp = path.join(dir, e.name);
        let mtimeIso = null;
        try { mtimeIso = fs.statSync(fp).mtime.toISOString(); } catch {}
        return { name: e.name, mtimeIso };
      });
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
    firePush(relPath);
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

  /** Run the full boot sequence: bootstrap missing files and migrate columns.
   * (BI26083006, 2026-09-03: TSV-era self-healing repair machinery removed —
   * repairColumnShiftedHeaders/repairEmptiedRegistries/reconcileRegistryRows/
   * idsDeletedOnPurpose/syncableFiles/snapshotVault all deleted. SQLite tables
   * cannot exhibit the corruption classes those functions defended against.
   * Engine has been running on sqlite since 2026-08-31; Sconl confirmed go-ahead.)
   */
  function bootRepair(opts = {}) {
    const created = ensureVault(opts);
    const columnsUpgraded = ensureVaultColumns();
    return { created, columnsUpgraded };
  }

  return {
    schema, memoryDir,
    read, append, rewrite, rawRead, rawWrite, statMtimeMs, listDir, keepPreviousVersion,
    ensureVault, ensureVaultColumns, bootRepair,
    setPushHook,
  };
}

module.exports = { createVaultStore, defaultSchema };
