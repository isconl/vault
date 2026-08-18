'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVaultStore } = require('../lib/store');
const { createAuditLog } = require('../lib/audit');
const blocksModule = require('../lib/blocks');

function tmpVault() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-blocks-test-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-blocks-logs-'));
  const auditLog = createAuditLog({ logsDir });
  const store = createVaultStore({ memoryDir, logsDir, auditLog, schema: {
    'scope/blocks.tsv': 'ID\tNAME\tSTART\tEND\tAXIS\tMATCH\tCAPACITY\tACTIVE\tNOTE\tTHIRD',
    'scope/tasks.tsv': 'ID\tTITLE\tSTATUS\tPRIORITY\tDUE_DATE\tTAG\tASSIGNEE\tASSIGNED_BY\tJIRA_KEY\tDELIVERABLE',
    'circle/people.tsv': 'ID\tNAME',
  } });
  blocksModule.init({
    readTSV: store.read,
    appendTSV: store.append,
    rewriteTSV: store.rewrite,
    auditLog: (event, data) => auditLog.log(event, data),
  });
  return { store };
}

test('blocks() seeds the four default blocks on first read and is idempotent after', () => {
  const { store } = tmpVault();
  const first = blocksModule.blocks();
  assert.equal(first.length, 4);
  assert.deepEqual(first.map(b => b.id), ['BLK-LEARN', 'BLK-INN', 'BLK-LEAD', 'BLK-CRE']);
  // Second read must not reseed / duplicate.
  const second = blocksModule.blocks();
  assert.equal(second.length, 4);
  assert.equal(store.read('scope/blocks.tsv').length, 4);
});

test('now() finds the current block by clock time, including a wrapping block', () => {
  tmpVault();
  const inInnovator = blocksModule.now(new Date('2026-08-13T08:30:00'));
  assert.equal(inInnovator.current?.id, 'BLK-INN');
  assert.ok(inInnovator.current.leftMins > 0);

  const betweenBlocks = blocksModule.now(new Date('2026-08-13T10:30:00'));
  assert.equal(betweenBlocks.current, null);
  assert.equal(betweenBlocks.gap, true);
});

test('classify() scores a task toward the block whose match words it contains', () => {
  tmpVault();
  const task = { TITLE: 'Build the ingestion pipeline', TAG: '' };
  const result = blocksModule.classify(task);
  assert.equal(result.blockId, 'BLK-INN');
  assert.ok(result.score > 0);
  assert.match(result.why, /build|pipeline/);
});

test('classify() returns null blockId when nothing in the title matches', () => {
  tmpVault();
  const result = blocksModule.classify({ TITLE: 'xyzzy quux', TAG: '' });
  assert.equal(result.blockId, null);
  assert.equal(result.score, 0);
});

test('plan() places open tasks into their classified block and reports overflow/unplaced', () => {
  tmpVault();
  const tasks = [
    { ID: 'T1', TITLE: 'Build the deploy script', STATUS: 'open', PRIORITY: 'high', DUE_DATE: '-', TAG: '' },
    { ID: 'T2', TITLE: 'Nothing matches this one', STATUS: 'open', PRIORITY: 'low', DUE_DATE: '-', TAG: '' },
    { ID: 'T3', TITLE: 'Done already', STATUS: 'done', PRIORITY: 'low', DUE_DATE: '-', TAG: '' },
  ];
  const result = blocksModule.plan({ tasks, people: [], date: new Date('2026-08-13T09:00:00') });
  assert.equal(result.counts.open, 2, 'done task excluded from open count');
  const innovator = result.blocks.find(b => b.id === 'BLK-INN');
  assert.ok(innovator.tasks.some(t => t.id === 'T1'));
  assert.ok(result.unplaced.some(t => t.id === 'T2'));
});

test('save() edits a block and rejects an unparseable time', () => {
  tmpVault();
  blocksModule.blocks(); // force seed
  const saved = blocksModule.save({ id: 'BLK-LEARN', name: 'Learning Hour' });
  assert.equal(saved.NAME, 'Learning Hour');
  assert.throws(() => blocksModule.save({ id: 'BLK-LEARN', start: 'not-a-time' }), /HH:MM/);
  assert.throws(() => blocksModule.save({ id: 'NOPE' }), /no block called/);
});

// -- U8: block reactivation -------------------------------------------------

test('blocks() hides a deactivated block; allBlocks() still lists it', () => {
  tmpVault();
  blocksModule.blocks(); // force seed
  blocksModule.save({ id: 'BLK-LEARN', active: false });
  assert.ok(!blocksModule.blocks().some(b => b.id === 'BLK-LEARN'), 'inactive block must not affect placement/scheduling');
  const all = blocksModule.allBlocks();
  const learn = all.find(b => b.id === 'BLK-LEARN');
  assert.ok(learn, 'allBlocks() must still list it so a settings UI can find it to turn back on');
  assert.equal(learn.active, false);
  assert.equal(all.length, 4, 'no rows lost, only excluded from the active view');
});

test('save() can flip a deactivated block back on -- the actual U8 gap, not just visibility', () => {
  tmpVault();
  blocksModule.blocks(); // force seed
  blocksModule.save({ id: 'BLK-LEARN', active: false });
  assert.ok(!blocksModule.blocks().some(b => b.id === 'BLK-LEARN'));
  blocksModule.save({ id: 'BLK-LEARN', active: true });
  assert.ok(blocksModule.blocks().some(b => b.id === 'BLK-LEARN'), 'reactivated block must be back in the placement/scheduling view');
});
