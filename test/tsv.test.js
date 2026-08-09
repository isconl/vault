'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTSV, appendTSV, rewriteTSV, stripBOM, tsvEscapeText, tsvUnescapeText } = require('../lib/tsv');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tsv-test-')); }

test('stripBOM removes a leading BOM and leaves normal text untouched', () => {
  assert.equal(stripBOM('﻿ID\tNAME'), 'ID\tNAME');
  assert.equal(stripBOM('ID\tNAME'), 'ID\tNAME');
});

test('readTSV returns [] for a missing file, parses rows by header otherwise', () => {
  const dir = tmpDir();
  assert.deepEqual(readTSV(dir, 'tasks.tsv'), []);
  fs.writeFileSync(path.join(dir, 'tasks.tsv'), 'ID\tTITLE\n1\tBuy milk\n2\tWalk dog\n');
  const rows = readTSV(dir, 'tasks.tsv');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { ID: '1', TITLE: 'Buy milk' });
});

test('readTSV strips a BOM before parsing so the header is never poisoned', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.tsv'), '﻿ID\tTITLE\n1\tBuy milk\n');
  const rows = readTSV(dir, 'tasks.tsv');
  assert.deepEqual(rows[0], { ID: '1', TITLE: 'Buy milk' });
});

test('appendTSV creates the file with the given header when missing, then appends', () => {
  const dir = tmpDir();
  const ok1 = appendTSV(dir, 'tasks.tsv', { ID: '1', TITLE: 'Buy milk' }, { headerIfMissing: 'ID\tTITLE' });
  assert.equal(ok1, true);
  appendTSV(dir, 'tasks.tsv', { ID: '2', TITLE: 'Walk dog' }, { headerIfMissing: 'ID\tTITLE' });
  assert.deepEqual(readTSV(dir, 'tasks.tsv'), [{ ID: '1', TITLE: 'Buy milk' }, { ID: '2', TITLE: 'Walk dog' }]);
});

test('appendTSV without headerIfMissing on a nonexistent file is a no-op, not a silent data loss', () => {
  const dir = tmpDir();
  const logged = [];
  const ok = appendTSV(dir, 'unknown.tsv', { ID: '1' }, { auditLog: { log: (a, m) => logged.push([a, m]) } });
  assert.equal(ok, false);
  assert.equal(logged[0][0], 'append_to_unknown_vault_file');
});

test('rewriteTSV applies fn(rows) and writes the filtered result', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.tsv'), 'ID\tSTATUS\n1\topen\n2\tdone\n3\topen\n');
  const lost = rewriteTSV(dir, 'tasks.tsv', (rows) => rows.filter(r => r.STATUS !== 'done'));
  assert.equal(lost, 1);
  assert.deepEqual(readTSV(dir, 'tasks.tsv').map(r => r.ID), ['1', '3']);
});

test('rewriteTSV refuses to empty a populated file without force -- the massacre guard', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.tsv'), 'ID\tSTATUS\n1\topen\n2\topen\n3\topen\n');
  const logged = [];
  const lost = rewriteTSV(dir, 'tasks.tsv', () => [], { auditLog: { log: (a, m) => logged.push([a, m]) } });
  assert.equal(lost, 0, 'nothing should have been removed -- the write was refused');
  assert.deepEqual(readTSV(dir, 'tasks.tsv').map(r => r.ID), ['1', '2', '3'], 'file must be untouched');
  assert.equal(logged.some(([a]) => a === 'vault_bulk_delete_refused'), true);
});

test('rewriteTSV refuses to drop more than half the rows without force', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.tsv'), 'ID\n1\n2\n3\n4\n5\n');
  const lost = rewriteTSV(dir, 'tasks.tsv', (rows) => rows.slice(0, 1)); // would drop 4 of 5
  assert.equal(lost, 0);
  assert.equal(readTSV(dir, 'tasks.tsv').length, 5);
});

test('rewriteTSV allows a legitimate bulk delete with force:true, and keeps the previous version', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'tasks.tsv'), 'ID\n1\n2\n3\n4\n5\n');
  let kept = null;
  const lost = rewriteTSV(dir, 'tasks.tsv', () => [], {
    force: true,
    keepPreviousVersion: (relPath, contents, why) => { kept = { relPath, contents, why }; },
  });
  assert.equal(lost, 5);
  assert.equal(readTSV(dir, 'tasks.tsv').length, 0);
  assert.ok(kept && kept.contents.includes('1\n2\n3\n4\n5'));
});

test('tsvEscapeText/tsvUnescapeText round-trip tabs and newlines through a TSV cell', () => {
  const original = 'Line one\twith a tab\nLine two';
  const escaped = tsvEscapeText(original);
  assert.equal(escaped.includes('\t'), false);
  assert.equal(escaped.includes('\n'), false);
  assert.equal(tsvUnescapeText(escaped), 'Line one  with a tab\nLine two'); // tab became 2 spaces, irreversible by design
});
