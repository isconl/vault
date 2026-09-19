'use strict';
/**
 * BL26082601: iSpark Library selection + sync.
 *
 * The Library is a SEPARATE vault+spark instance (its own memory dir, own
 * ports, seeded/authored independently -- never the same store as any
 * tenant or the main personal fleet, per Sconl's explicit 9 Sep 2026 call
 * to keep a commercial multi-creator product off his personal data store).
 * A tenant (iScroll first) selects a subset of the Library's catalog;
 * selected courses are pulled INTO the tenant's own memory dir so the app
 * stays offline-first against local content, same as every other tenant
 * read.
 *
 * Same-machine implementation, flagged not hidden: pullCourse() copies the
 * course folder directly on disk (libraryMemoryDir -> tenantMemoryDir),
 * since today every instance runs on this one machine. A tenant on
 * separate infrastructure would need an HTTP-based variant of pullCourse
 * with the same signature -- the catalog/selection shape above it doesn't
 * change either way.
 */

const fs = require('fs');
const path = require('path');
const { readTSV } = require('./tsv');

const COURSE_ID_RE = /^[\w-]+$/;
const SELECTION_HEADER = 'LIBRARY_COURSE_ID\tENABLED_AT';
const TENANT_COURSE_COLUMNS = [
  'ID', 'TITLE', 'GOAL', 'STATUS', 'LESSON_COUNT', 'CREATED_AT',
  'UPDATED_AT', 'NOTE', 'CLASSROOM', 'LEVEL', 'SUBTITLE', 'GROUP_ID',
];

function createLibrarySync({
  libraryMemoryDir,
  tenantMemoryDir,
  readTSV: readTenantTSV,
  appendTSV: appendTenantTSV,
  rewriteTSV: rewriteTenantTSV,
  auditLog = { log: () => {} },
}) {
  if (!tenantMemoryDir) throw new Error('createLibrarySync requires tenantMemoryDir');
  if (!readTenantTSV || !appendTenantTSV || !rewriteTenantTSV) {
    throw new Error('createLibrarySync requires readTSV/appendTSV/rewriteTSV');
  }

  function configured() {
    return !!libraryMemoryDir;
  }

  /** Published catalog: courses.tsv joined with library_meta.tsv (courses with no meta row default to published, grandfathering in content seeded before library_meta.tsv existed). */
  function listCatalog() {
    if (!configured()) {
      return { ok: false, error: 'LIBRARY_MEMORY_DIR is not configured on this instance', groups: [], courses: [] };
    }
    const courses = readTSV(libraryMemoryDir, 'learning/courses.tsv');
    const meta = readTSV(libraryMemoryDir, 'learning/library_meta.tsv');
    const metaById = new Map(meta.map((m) => [m.COURSE_ID, m]));
    const published = courses
      .map((c) => {
        const m = metaById.get(c.ID);
        return {
          ...c,
          CREATOR_ID: m ? m.CREATOR_ID : '',
          PUBLISH_STATUS: m ? m.PUBLISH_STATUS : 'published',
        };
      })
      .filter((c) => String(c.PUBLISH_STATUS || 'published').toLowerCase() === 'published');
    const groups = readTSV(libraryMemoryDir, 'learning/groups.tsv');
    return { ok: true, groups, courses: published };
  }

  function getSelection() {
    const rows = readTenantTSV('learning/library_selection.tsv');
    return rows.map((r) => r.LIBRARY_COURSE_ID);
  }

  /** Copies a course folder (markdown + _assets) from the Library into this tenant's memory dir, byte for byte, overwriting any prior copy. */
  function pullCourse(courseId) {
    if (!COURSE_ID_RE.test(courseId)) throw new Error('bad course id');
    if (!configured()) throw new Error('LIBRARY_MEMORY_DIR is not configured on this instance');
    const src = path.join(libraryMemoryDir, 'learning', courseId);
    if (!fs.existsSync(src)) throw new Error(`course "${courseId}" not found in the Library`);
    const dest = path.join(tenantMemoryDir, 'learning', courseId);
    fs.cpSync(src, dest, { recursive: true });
    auditLog.log('library_course_pulled', { courseId });
    return { ok: true, courseId };
  }

  /** Merges (or reactivates) a course's row into this tenant's own courses.tsv, stripping Library-only columns. */
  function mergeCourseRow(libraryCourseRow) {
    const clean = {};
    for (const col of TENANT_COURSE_COLUMNS) clean[col] = libraryCourseRow[col] ?? '';
    let found = false;
    rewriteTenantTSV('learning/courses.tsv', (rows) => rows.map((r) => {
      if (r.ID === clean.ID) { found = true; return { ...clean, STATUS: 'active' }; }
      return r;
    }));
    if (!found) appendTenantTSV('learning/courses.tsv', { ...clean, STATUS: 'active' });
  }

  /** Sets STATUS=disabled on a tenant course row without touching its pulled content -- reuses spark's existing active/archived/disabled filtering, so a disabled course just stops appearing. */
  function disableCourseRow(courseId) {
    rewriteTenantTSV('learning/courses.tsv', (rows) => rows.map((r) => (
      r.ID === courseId ? { ...r, STATUS: 'disabled' } : r
    )));
  }

  /** Replaces the full selection with `courseIds` (Library course IDs). Newly-selected courses are pulled and merged in; deselected ones are disabled locally (content and courses.tsv row kept, never deleted -- least-destructive default). */
  function setSelection(courseIds) {
    if (!Array.isArray(courseIds)) throw new Error('courseIds must be an array');
    const catalog = listCatalog();
    if (!catalog.ok) return catalog;
    const catalogById = new Map(catalog.courses.map((c) => [c.ID, c]));
    const requested = [...new Set(courseIds)].filter((id) => catalogById.has(id));
    const invalid = courseIds.filter((id) => !catalogById.has(id));

    const before = new Set(getSelection());
    const added = requested.filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !requested.includes(id));

    const now = new Date().toISOString();
    const kept = readTenantTSV('learning/library_selection.tsv')
      .filter((r) => requested.includes(r.LIBRARY_COURSE_ID));
    const keptIds = new Set(kept.map((r) => r.LIBRARY_COURSE_ID));
    const newRows = added.filter((id) => !keptIds.has(id)).map((id) => ({ LIBRARY_COURSE_ID: id, ENABLED_AT: now }));
    // rewriteTSV is a no-op on a file that doesn't exist yet (its own
    // bulk-delete guard treats "missing" the same as "nothing to rewrite")
    // -- ensure the header exists first so the very first selection ever
    // made on a fresh tenant actually persists.
    const selectionPath = path.join(tenantMemoryDir, 'learning', 'library_selection.tsv');
    if (!fs.existsSync(selectionPath)) {
      fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
      fs.writeFileSync(selectionPath, SELECTION_HEADER + '\n');
    }
    rewriteTenantTSV('learning/library_selection.tsv', () => [...kept, ...newRows]);

    const pulled = [];
    const failed = [];
    for (const id of added) {
      try {
        pullCourse(id);
        mergeCourseRow(catalogById.get(id));
        pulled.push(id);
      } catch (e) {
        failed.push({ id, error: String(e.message || e) });
      }
    }
    for (const id of removed) disableCourseRow(id);

    auditLog.log('library_selection_set', { added: pulled, removed, invalid, failed: failed.map((f) => f.id) });
    return { ok: true, selection: requested, pulled, disabled: removed, invalid, failed };
  }

  return { configured, listCatalog, getSelection, setSelection, pullCourse, mergeCourseRow, disableCourseRow };
}

module.exports = { createLibrarySync };
