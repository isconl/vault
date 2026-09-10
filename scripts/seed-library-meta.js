#!/usr/bin/env node
'use strict';
/**
 * BL26082601: seed learning/library_meta.tsv with a CREATOR_ID/PUBLISH_STATUS
 * row for every course in learning/courses.tsv that doesn't already have
 * one -- library-sync.js's listCatalog() already defaults an unmet course
 * to published (grandfathering content seeded before this file existed),
 * so this script is about real attribution, not catalog visibility.
 *
 * Idempotent: existing library_meta.tsv rows are left untouched, only
 * missing courses get a new row appended.
 *
 * Usage: LIBRARY_MEMORY_DIR=<path> CREATOR_ID=sconl node seed-library-meta.js
 */
const { readTSV, appendTSV } = require('../lib/tsv');

const memoryDir = process.env.LIBRARY_MEMORY_DIR;
const creatorId = process.env.CREATOR_ID || 'sconl';
if (!memoryDir) {
  console.error('LIBRARY_MEMORY_DIR is required');
  process.exit(1);
}

const courses = readTSV(memoryDir, 'learning/courses.tsv');
const meta = readTSV(memoryDir, 'learning/library_meta.tsv');
const known = new Set(meta.map((m) => m.COURSE_ID));

let added = 0;
const now = new Date().toISOString();
for (const c of courses) {
  if (known.has(c.ID)) continue;
  appendTSV(memoryDir, 'learning/library_meta.tsv',
    { COURSE_ID: c.ID, CREATOR_ID: creatorId, PUBLISH_STATUS: 'published', UPDATED_AT: now },
    { headerIfMissing: 'COURSE_ID\tCREATOR_ID\tPUBLISH_STATUS\tUPDATED_AT' });
  added++;
}
console.log(`seeded ${added} of ${courses.length} course(s), creator=${creatorId}`);
