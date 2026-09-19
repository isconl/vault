'use strict';
/**
 * Pure TSV/JSON I/O primitives -- schema-agnostic, no knowledge of what any
 * particular collection means. Ported from isconl-agent's server.js.
 */

const fs = require('fs');
const path = require('path');

// A UTF-8 BOM at the head of a TSV is invisible and catastrophic: the first
// header parses as "?ID", every row's ID reads back empty, and the first
// ID-keyed rewrite matches every row and clones one row across the whole
// file (this happened for real -- PowerShell's `Set-Content -Encoding utf8`
// writes a BOM). Strip it at every entry point so no writer can poison a file.
const stripBOM = (s) => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

// Free text inside a TSV cell: tabs become two spaces, newlines a literal
// \n. Reversed on read.
function tsvEscapeText(s) { return String(s || '').replace(/\t/g, '  ').replace(/\r?\n/g, '\\n'); }
function tsvUnescapeText(s) { return String(s || '').replace(/\\n/g, '\n'); }

/**
 * Parse raw TSV text (header row + data rows) into row objects. Extracted
 * from readTSV so a caller with text that didn't come from a local file --
 * an OneDrive download, for one -- can use the identical parsing rules
 * rather than a second, driftable implementation.
 */
function parseTSVText(text) {
  const lines = stripBOM(text).trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  // FI26082901: a leading tab on the header row shifts every column one place
  // to the right, mapping column N's data into column N+1's name. This makes
  // every row read as ID='-', TITLE='-', with real data landing in the wrong
  // field. Happened when the OneDrive sync pulled a file that had been
  // corrupted with a leading \t and pushed it back, propagating the corruption
  // on every sync tick until manually repaired. Strip it at the canonical
  // parse entry point so no downstream code ever sees the shifted layout.
  // Equally strip a leading tab from every data line (same corruption pattern
  // can appear on data rows, shifting all values right by one column there too).
  const headerRaw = lines[0].startsWith('\t') ? lines[0].slice(1) : lines[0];
  const headers = headerRaw.split('\t');
  return lines.slice(1)
    .filter(line => line.trim())          // skip blank rows -- they used to produce empty records
    .map(line => {
      const cleaned = line.startsWith('\t') ? line.slice(1) : line;
      const vals = cleaned.split('\t');
      const row = {};
      headers.forEach((h, i) => row[h] = vals[i] || '');
      return row;
    });
}

function readTSV(baseDir, relPath) {
  const fp = path.join(baseDir, relPath);
  if (!fs.existsSync(fp)) return [];
  return parseTSVText(fs.readFileSync(fp, 'utf8'));
}

/**
 * @param {string} baseDir
 * @param {string} relPath
 * @param {object} row
 * @param {object} [opts]
 * @param {string} [opts.headerIfMissing] - header line to create the file with if it doesn't exist yet.
 *   Without this, a write to a nonexistent file is a silent no-op -- exactly how a fresh deploy
 *   once accepted a new record and lost it without a word. Pass the collection's schema header.
 * @param {{log:Function}} [opts.auditLog]
 */
function appendTSV(baseDir, relPath, row, opts = {}) {
  const { headerIfMissing, auditLog = { log: () => {} } } = opts;
  const fp = path.join(baseDir, relPath);
  if (!fs.existsSync(fp)) {
    if (!headerIfMissing) {
      auditLog.log('append_to_unknown_vault_file', { file: relPath });
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, headerIfMissing + '\n');
      auditLog.log('vault_file_created_on_write', { file: relPath });
    } catch (e) {
      auditLog.log('vault_write_failed', { file: relPath, error: String(e.message || e).slice(0, 120) });
      return false;
    }
  }
  const raw = stripBOM(fs.readFileSync(fp, 'utf8'));
  const headers = raw.split(/\r?\n/)[0].split('\t');
  const line = headers.map(h => row[h] || '-').join('\t');
  fs.appendFileSync(fp, (raw.endsWith('\n') ? '' : '\n') + line + '\n');
  return true;
}

/**
 * Rewrite a TSV keeping the header, with `fn(rows) -> rows`. Returns rows removed.
 *
 * DATA LOSS PREVENTION -- every path that can remove rows goes through this,
 * enforcing two rules rather than trusting each caller:
 *   1. Refuse a massacre: dropping more than half the rows, or emptying a
 *      populated file entirely, is refused outright and audited (pass
 *      { force: true } for a legitimate bulk delete).
 *   2. Keep the previous version (via opts.keepPreviousVersion, injected)
 *      whenever anything is actually removed.
 *
 * @param {string} baseDir
 * @param {string} relPath
 * @param {(rows: object[]) => object[]} fn
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 * @param {string} [opts.why]
 * @param {(relPath:string, contents:string, why:string) => void} [opts.keepPreviousVersion]
 * @param {{log:Function}} [opts.auditLog]
 */
function rewriteTSV(baseDir, relPath, fn, opts = {}) {
  const { auditLog = { log: () => {} }, keepPreviousVersion = () => {} } = opts;
  const fp = path.join(baseDir, relPath);
  if (!fs.existsSync(fp)) return 0;
  const raw = stripBOM(fs.readFileSync(fp, 'utf8'));   // rewriting is exactly where a poisoned header does its damage
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return 0;
  // FI26082901: strip a leading tab from the header (same guard as parseTSVText).
  // rewriteTSV writes the header back verbatim (lines[0]) -- if the on-disk header
  // is corrupted with a leading \t, every rewrite perpetuates that corruption into
  // the new file. Cleaning it here means a rewrite also self-heals the header.
  const headerRaw = lines[0].startsWith('\t') ? lines[0].slice(1) : lines[0];
  const headers = headerRaw.split('\t');
  const rows = lines.slice(1).map(line => {
    const cleaned = line.startsWith('\t') ? line.slice(1) : line;
    const vals = cleaned.split('\t');
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] || '');
    return row;
  });
  const kept = fn(rows);
  const lost = rows.length - kept.length;


  if (!opts.force && rows.length > 1 && (kept.length === 0 || lost > rows.length / 2)) {
    keepPreviousVersion(relPath, raw, 'refused-bulk-delete');
    auditLog.log('vault_bulk_delete_refused', { file: relPath, had: rows.length, wouldKeep: kept.length, lost });
    return 0;   // nothing written; the file stands
  }

  if (lost > 0) keepPreviousVersion(relPath, raw, opts.why || 'rows removed');

  const out = [headerRaw, ...kept.map(r => headers.map(h => r[h] || '-').join('\t'))].join('\n') + '\n';
  fs.writeFileSync(fp, out);
  return lost;
}

module.exports = { stripBOM, tsvEscapeText, tsvUnescapeText, parseTSVText, readTSV, appendTSV, rewriteTSV };
