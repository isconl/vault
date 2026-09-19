'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readTSV, appendTSV, rewriteTSV } = require('../lib/tsv');
const { createLibrarySync } = require('../lib/library-sync');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTSV(baseDir, relPath, header, rows) {
  const p = path.join(baseDir, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines = [header, ...rows.map((r) => header.split('\t').map((c) => r[c] ?? '').join('\t'))];
  fs.writeFileSync(p, lines.join('\n') + '\n');
}

function makeLibrary() {
  const libDir = mkTmp('ispark-library-');
  writeTSV(libDir, 'learning/courses.tsv',
    'ID\tTITLE\tGOAL\tSTATUS\tLESSON_COUNT\tCREATED_AT\tUPDATED_AT\tNOTE\tCLASSROOM\tLEVEL\tSUBTITLE\tGROUP_ID',
    [
      { ID: 'model-pressure-test', TITLE: 'Pressure Test', GOAL: 'g', STATUS: 'active', LESSON_COUNT: '10', GROUP_ID: 'markets-economics' },
      { ID: 'draft-course', TITLE: 'Draft', GOAL: 'g', STATUS: 'active', LESSON_COUNT: '3', GROUP_ID: 'markets-economics' },
    ]);
  writeTSV(libDir, 'learning/library_meta.tsv',
    'COURSE_ID\tCREATOR_ID\tPUBLISH_STATUS\tUPDATED_AT',
    [{ COURSE_ID: 'draft-course', CREATOR_ID: 'sconl', PUBLISH_STATUS: 'draft', UPDATED_AT: '2026-09-09' }]);
  fs.mkdirSync(path.join(libDir, 'learning', 'model-pressure-test', '_assets'), { recursive: true });
  fs.writeFileSync(path.join(libDir, 'learning', 'model-pressure-test', '00_orientation.md'), '# Orientation\n');
  fs.writeFileSync(path.join(libDir, 'learning', 'model-pressure-test', '_assets', 'diagram.svg'), '<svg/>');
  fs.mkdirSync(path.join(libDir, 'learning', 'draft-course'), { recursive: true });
  fs.writeFileSync(path.join(libDir, 'learning', 'draft-course', '00_intro.md'), '# Draft\n');
  return libDir;
}

function makeTenant() {
  const tenantDir = mkTmp('ispark-tenant-');
  writeTSV(tenantDir, 'learning/courses.tsv',
    'ID\tTITLE\tGOAL\tSTATUS\tLESSON_COUNT\tCREATED_AT\tUPDATED_AT\tNOTE\tCLASSROOM\tLEVEL\tSUBTITLE\tGROUP_ID', []);
  const deps = {
    readTSV: (relPath) => readTSV(tenantDir, relPath),
    appendTSV: (relPath, row) => appendTSV(tenantDir, relPath, row, { headerIfMissing: relPath === 'learning/library_selection.tsv' ? 'LIBRARY_COURSE_ID\tENABLED_AT' : 'ID\tTITLE\tGOAL\tSTATUS\tLESSON_COUNT\tCREATED_AT\tUPDATED_AT\tNOTE\tCLASSROOM\tLEVEL\tSUBTITLE\tGROUP_ID' }),
    rewriteTSV: (relPath, fn) => rewriteTSV(tenantDir, relPath, fn, { force: true }),
  };
  return { tenantDir, deps };
}

test('listCatalog returns published courses only, dropping Library-only columns from the tenant view path', () => {
  const libDir = makeLibrary();
  const { deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: '/unused', ...deps });
  const catalog = ls.listCatalog();
  assert.equal(catalog.ok, true);
  const ids = catalog.courses.map((c) => c.ID);
  assert.ok(ids.includes('model-pressure-test'));
  assert.ok(!ids.includes('draft-course'), 'draft-status course must not appear in the published catalog');
});

test('listCatalog without LIBRARY_MEMORY_DIR configured returns ok:false, not a throw', () => {
  const { deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: '', tenantMemoryDir: '/unused', ...deps });
  const catalog = ls.listCatalog();
  assert.equal(catalog.ok, false);
  assert.deepEqual(catalog.courses, []);
});

test('pullCourse copies the course folder (lessons + _assets) byte for byte into the tenant memory dir', () => {
  const libDir = makeLibrary();
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: tenantDir, ...deps });
  ls.pullCourse('model-pressure-test');
  const md = fs.readFileSync(path.join(tenantDir, 'learning', 'model-pressure-test', '00_orientation.md'), 'utf8');
  assert.equal(md, '# Orientation\n');
  const svg = fs.readFileSync(path.join(tenantDir, 'learning', 'model-pressure-test', '_assets', 'diagram.svg'), 'utf8');
  assert.equal(svg, '<svg/>');
});

test('pullCourse rejects a course id outside the safe filename pattern (no path traversal)', () => {
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: '/tmp', tenantMemoryDir: tenantDir, ...deps });
  assert.throws(() => ls.pullCourse('../../etc'), /bad course id/);
});

test('pullCourse throws a clear error for a course not present in the library', () => {
  const libDir = makeLibrary();
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: tenantDir, ...deps });
  assert.throws(() => ls.pullCourse('nonexistent-course'), /not found in the Library/);
});

test('setSelection pulls newly-selected courses and merges a real courses.tsv row (STATUS=active, Library-only columns stripped)', () => {
  const libDir = makeLibrary();
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: tenantDir, ...deps });
  const result = ls.setSelection(['model-pressure-test']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pulled, ['model-pressure-test']);
  const rows = readTSV(tenantDir, 'learning/courses.tsv');
  const row = rows.find((r) => r.ID === 'model-pressure-test');
  assert.ok(row, 'course row should be merged into the tenant courses.tsv');
  assert.equal(row.STATUS, 'active');
  assert.equal(row.CREATOR_ID, undefined, 'Library-only columns must not leak into the tenant courses.tsv row');
  assert.ok(fs.existsSync(path.join(tenantDir, 'learning', 'model-pressure-test', '00_orientation.md')));
});

test('setSelection silently drops a requested id not in the published catalog (invalid, reported not applied)', () => {
  const libDir = makeLibrary();
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: tenantDir, ...deps });
  const result = ls.setSelection(['model-pressure-test', 'draft-course', 'made-up-id']);
  assert.deepEqual(result.selection.sort(), ['model-pressure-test']);
  assert.deepEqual(result.invalid.sort(), ['draft-course', 'made-up-id']);
});

test('setSelection on a later call disables (not deletes) a course removed from the selection', () => {
  const libDir = makeLibrary();
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: tenantDir, ...deps });
  ls.setSelection(['model-pressure-test']);
  const result = ls.setSelection([]);
  assert.deepEqual(result.disabled, ['model-pressure-test']);
  const row = readTSV(tenantDir, 'learning/courses.tsv').find((r) => r.ID === 'model-pressure-test');
  assert.equal(row.STATUS, 'disabled', 'deselecting must disable the row, not remove it');
  assert.ok(fs.existsSync(path.join(tenantDir, 'learning', 'model-pressure-test', '00_orientation.md')),
    'deselecting must never delete already-pulled content');
});

test('setSelection is idempotent -- calling it twice with the same id does not duplicate the courses.tsv row or re-pull', () => {
  const libDir = makeLibrary();
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: tenantDir, ...deps });
  ls.setSelection(['model-pressure-test']);
  const second = ls.setSelection(['model-pressure-test']);
  assert.deepEqual(second.pulled, [], 'a course already selected should not be re-pulled');
  const rows = readTSV(tenantDir, 'learning/courses.tsv').filter((r) => r.ID === 'model-pressure-test');
  assert.equal(rows.length, 1);
});

test('getSelection reflects the current selection.tsv contents', () => {
  const libDir = makeLibrary();
  const { tenantDir, deps } = makeTenant();
  const ls = createLibrarySync({ libraryMemoryDir: libDir, tenantMemoryDir: tenantDir, ...deps });
  assert.deepEqual(ls.getSelection(), []);
  ls.setSelection(['model-pressure-test']);
  assert.deepEqual(ls.getSelection(), ['model-pressure-test']);
});
