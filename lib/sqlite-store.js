'use strict';
/**
 * Encrypted SQLite storage engine -- a drop-in replacement for store.js's
 * createVaultStore(), same constructor signature and same returned-method
 * surface, so the swap at the one call site (vault/src/server.js) is
 * mechanical. See BI26083001 in work/dev/Systems/iSconl/_handoff/backlog/build.md
 * for the full design record (schema mapping, key derivation, testing bar).
 *
 * This module ships the engine only -- it is not wired into server.js here
 * (that's BI26083003), and it does not port store.js's self-healing repair
 * machinery (repairColumnShiftedHeaders/repairEmptiedRegistries/
 * reconcileRegistryRows/idsDeletedOnPurpose/syncableFiles/snapshotVault):
 * those defend against corruption classes (column-shift, header-only files,
 * OneDrive pull races) that cannot occur against a SQL table with no live
 * pull path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3-multiple-ciphers');
const defaultSchema = require('./default-schema');

// SQLCipher-current scrypt cost parameter (N=2^17). Node's own crypto docs
// example uses the outdated N=16384 figure -- deliberately not copied here.
// maxmem must be raised too: N=2^17, r=8 needs ~128MiB (128*N*r bytes),
// well past scryptSync's 32MiB default ceiling, which throws otherwise.
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function tableNameFor(relPath) {
  return relPath.replace(/\.tsv$/, '').replace(/\//g, '__');
}

/** Same tab-separated shape readTSV/appendTSV produce, for keepPreviousVersion snapshots. */
function serializeTSV(columns, rows) {
  const header = columns.join('\t');
  const lines = rows.map((r) => columns.map((c) => (r[c] === undefined || r[c] === '' ? '-' : r[c])).join('\t'));
  return [header, ...lines].join('\n') + '\n';
}

/**
 * @param {object} opts
 * @param {string} opts.memoryDir - the vault root (all schema paths are relative to this)
 * @param {string} opts.logsDir - unused by this engine directly, kept for constructor parity with createVaultStore
 * @param {object} [opts.schema] - defaults to the full ported schema; pass a superset to extend
 * @param {{log:Function}} [opts.auditLog]
 * @param {string} opts.dbKeyPassphrase - base64 passphrase (e.g. from Bitwarden's VAULT_DB_KEY_PASSPHRASE); required
 */
function createSqliteStore({ memoryDir, logsDir, schema = defaultSchema, auditLog = { log: () => {} }, dbKeyPassphrase }) {
  if (!memoryDir) throw new Error('createSqliteStore requires memoryDir');
  if (!dbKeyPassphrase) throw new Error('createSqliteStore requires dbKeyPassphrase');

  fs.mkdirSync(memoryDir, { recursive: true });
  const TRASH_DIR = path.join(memoryDir, '.trash');

  // -- key derivation -------------------------------------------------------
  // salt is NOT secret (its job is uniqueness, not secrecy) -- it travels
  // with the vault data and must be backed up alongside the DB (BI26083004).
  const saltPath = path.join(memoryDir, '.db-salt');
  let salt;
  if (fs.existsSync(saltPath)) {
    salt = fs.readFileSync(saltPath);
  } else {
    salt = crypto.randomBytes(16);
    fs.writeFileSync(saltPath, salt);
  }
  const derivedKeyHex = crypto.scryptSync(dbKeyPassphrase, salt, 32, SCRYPT_PARAMS).toString('hex');

  const dbPath = path.join(memoryDir, 'vault.db');
  const db = new Database(dbPath);
  // Raw key mode (not passphrase mode) -- the driver must not apply a
  // second, different internal KDF on top of the key already derived above.
  db.exec(`PRAGMA key = "x'${derivedKeyHex}'"`);
  db.pragma('journal_mode = WAL');

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

  // -- write-then-push hook (same shape as store.js's SYNC1 mechanism, for
  // interface parity at the swap site -- vault/src/server.js) -------------
  let pushHook = null;
  function setPushHook(fn) { pushHook = fn; }
  const pushQueues = new Map();
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

  function isSchemaPath(relPath) { return Object.prototype.hasOwnProperty.call(schema, relPath); }
  function schemaCols(relPath) { return schema[relPath].split('\t'); }

  function tableExists(table) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  }

  function ensureTableFor(relPath) {
    const table = tableNameFor(relPath);
    if (tableExists(table)) return false;
    const cols = schemaCols(relPath);
    const colDefs = cols.map((c) => `"${c}" TEXT`).join(', ');
    db.exec(`CREATE TABLE "${table}" (${colDefs}, updated_at_ms INTEGER)`);
    return true;
  }

  db.exec('CREATE TABLE IF NOT EXISTS raw_blobs (rel_path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)');

  // -- schema-mapped (TSV-shaped) collections --------------------------------

  function read(relPath) {
    if (!isSchemaPath(relPath)) return [];
    const table = tableNameFor(relPath);
    if (!tableExists(table)) return [];
    const cols = schemaCols(relPath);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const rows = db.prepare(`SELECT ${colList} FROM "${table}" ORDER BY rowid`).all();
    // better-sqlite3 already returns plain objects keyed by column name --
    // still normalize null -> '' to match readTSV's "missing cell -> ''" contract.
    return rows.map((r) => {
      const out = {};
      for (const c of cols) out[c] = r[c] === null || r[c] === undefined ? '' : r[c];
      return out;
    });
  }

  function append(relPath, row) {
    if (!isSchemaPath(relPath)) {
      auditLog.log('append_to_unknown_vault_file', { file: relPath });
      return false;
    }
    ensureTableFor(relPath);
    const table = tableNameFor(relPath);
    const cols = schemaCols(relPath);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const vals = cols.map((c) => row[c] || '-');
    db.prepare(`INSERT INTO "${table}" (${colList}, updated_at_ms) VALUES (${placeholders}, ?)`).run(...vals, Date.now());
    firePush(relPath);
    return true;
  }

  function rewrite(relPath, fn, opts = {}) {
    if (!isSchemaPath(relPath)) return 0;
    const table = tableNameFor(relPath);
    // Matches rewriteTSV: a collection that was never bootstrapped (no
    // table yet, same as "file doesn't exist") is a no-op -- fn is not
    // even called. A bootstrapped-but-empty table (0 rows) DOES call fn,
    // e.g. to seed rows via rewrite -- only the massacre guard treats it
    // specially (currentRows.length > 1 is false, so it never fires).
    if (!tableExists(table)) return 0;
    const cols = schemaCols(relPath);
    const currentRows = read(relPath);
    const kept = fn(currentRows);
    const lost = currentRows.length - kept.length;

    if (!opts.force && currentRows.length > 1 && (kept.length === 0 || lost > currentRows.length / 2)) {
      keepPreviousVersion(relPath, serializeTSV(cols, currentRows), 'refused-bulk-delete');
      auditLog.log('vault_bulk_delete_refused', { file: relPath, had: currentRows.length, wouldKeep: kept.length, lost });
      return 0;
    }

    if (lost > 0) keepPreviousVersion(relPath, serializeTSV(cols, currentRows), opts.why || 'rows removed');

    const del = db.prepare(`DELETE FROM "${table}"`);
    const insert = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}, updated_at_ms) VALUES (${cols.map(() => '?').join(', ')}, ?)`);
    const now = Date.now();
    db.transaction(() => {
      del.run();
      for (const r of kept) insert.run(...cols.map((c) => r[c] || '-'), now);
    })();
    firePush(relPath);
    return lost;
  }

  // -- non-schema (raw) content: markdown, YAML, JSON at dynamically-discovered paths --

  function rawRead(relPath) {
    const row = db.prepare('SELECT content FROM raw_blobs WHERE rel_path = ?').get(relPath);
    return row ? row.content : '';
  }

  function rawWrite(relPath, contents, { force = false } = {}) {
    const before = rawRead(relPath);
    if (before.trim().length > 0 && contents.trim().length === 0 && !force) {
      throw new Error(`rawWrite blocked: would empty ${relPath} (${before.length} bytes -> 0); pass force:true to override`);
    }
    if (before) keepPreviousVersion(relPath, before, 'rawWrite');
    db.prepare(
      'INSERT INTO raw_blobs (rel_path, content, updated_at_ms) VALUES (?, ?, ?) ' +
      'ON CONFLICT(rel_path) DO UPDATE SET content = excluded.content, updated_at_ms = excluded.updated_at_ms'
    ).run(relPath, contents, Date.now());
    auditLog.log('vault_raw_written', { file: relPath, bytesBefore: before.length, bytesAfter: contents.length });
    firePush(relPath);
  }

  function statMtimeMs(relPath) {
    if (isSchemaPath(relPath)) {
      const table = tableNameFor(relPath);
      if (!tableExists(table)) return null;
      const row = db.prepare(`SELECT MAX(updated_at_ms) as m FROM "${table}"`).get();
      return row && row.m != null ? row.m : null;
    }
    const row = db.prepare('SELECT updated_at_ms FROM raw_blobs WHERE rel_path = ?').get(relPath);
    return row ? row.updated_at_ms : null;
  }

  function listDir(relPath) {
    const rows = db.prepare('SELECT rel_path, updated_at_ms FROM raw_blobs WHERE rel_path LIKE ? AND rel_path NOT LIKE ?')
      .all(`${relPath}/%`, `${relPath}/%/%`);
    return rows.map((r) => ({
      name: r.rel_path.slice(relPath.length + 1),
      mtimeIso: new Date(r.updated_at_ms).toISOString(),
    }));
  }

  // -- boot sequence ----------------------------------------------------------

  function ensureVault() {
    const created = [];
    for (const relPath of Object.keys(schema)) {
      if (ensureTableFor(relPath)) created.push(relPath);
    }
    if (created.length) auditLog.log('vault_bootstrapped', { created: created.join(',') });
    return created;
  }

  function ensureVaultColumns() {
    let upgraded = 0;
    for (const relPath of Object.keys(schema)) {
      const table = tableNameFor(relPath);
      if (!tableExists(table)) continue;
      const have = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
      const missing = schemaCols(relPath).filter((c) => !have.has(c));
      if (!missing.length) continue;
      for (const col of missing) {
        db.exec(`ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT DEFAULT '-'`);
      }
      auditLog.log('vault_columns_added', { file: relPath, columns: missing.join(',') });
      upgraded++;
    }
    return upgraded;
  }

  /**
   * Reduced from store.js's 5-stage bootRepair to just table/column
   * bootstrap -- the three self-repair passes it also ran
   * (repairColumnShiftedHeaders/repairEmptiedRegistries/reconcileRegistryRows)
   * defend against corruption classes a SQL table can't exhibit. Response
   * shape is deliberately smaller than store.js's bootRepair() ({created,
   * columnsUpgraded} vs. its four fields) -- confirmed by grepping hub,
   * circle, scope, spark, and pulse for any consumer of
   * columnShiftsRepaired/emptyFilesRepaired/rowsRestored by name: none
   * exists, so there is nothing to preserve for compatibility.
   */
  function bootRepair() {
    const created = ensureVault();
    const columnsUpgraded = ensureVaultColumns();
    return { created, columnsUpgraded };
  }

  /** VACUUM INTO produces an atomic, transactionally-consistent point-in-time copy -- already encrypted, since the live DB is. Used by BI26083004's snapshot/backup path. */
  function snapshotToFile(destPath) {
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  }

  return {
    schema,
    read, append, rewrite, rawRead, rawWrite, statMtimeMs, listDir, keepPreviousVersion,
    ensureVault, ensureVaultColumns, bootRepair, snapshotToFile,
    setPushHook,
  };
}

module.exports = { createSqliteStore };
