'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAuditLog, auditRedact } = require('../lib/audit');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-audit-test-'));
}

test('log() writes a hash-chained entry and verifyChain() confirms it', () => {
  const dir = tmpDir();
  const audit = createAuditLog({ logsDir: dir });
  audit.log('task_created', { id: 'T1' });
  audit.log('task_completed', { id: 'T1' });
  const result = audit.verifyChain();
  assert.equal(result.ok, true);
  assert.equal(result.brokenAt, null);
});

test('verifyChain() detects a tampered entry', () => {
  const dir = tmpDir();
  const audit = createAuditLog({ logsDir: dir });
  audit.log('task_created', { id: 'T1' });
  audit.log('task_completed', { id: 'T1' });
  // Tamper: flip a character in the middle of the file.
  const raw = fs.readFileSync(audit.auditFile, 'utf8');
  const tampered = raw.replace('"task_completed"', '"task_deleted!!"');
  fs.writeFileSync(audit.auditFile, tampered);
  const result = audit.verifyChain();
  assert.equal(result.ok, false);
});

test('a fresh boot continues the chain from the file tail, not genesis', () => {
  const dir = tmpDir();
  const first = createAuditLog({ logsDir: dir });
  const entry1 = first.log('a', {});
  // Simulate a restart: new createAuditLog call over the same directory.
  const second = createAuditLog({ logsDir: dir });
  const entry2 = second.log('b', {});
  assert.equal(entry2.prev_hash, entry1.hash);
  assert.equal(second.verifyChain().ok, true);
});

test('auditRedact() strips secret-shaped values and secret-named fields', () => {
  const redacted = auditRedact({
    note: 'token sk-ant-abcdefghijklmnopqrstuvwxyz1234 was used',
    apiKey: 'short-but-named-like-a-secret',
    nested: { password: 'hunter2', ok: 'fine' },
  });
  assert.match(redacted.note, /\[redacted-secret\]/);
  assert.equal(redacted.apiKey, '[redacted-secret]');
  assert.equal(redacted.nested.password, '[redacted-secret]');
  assert.equal(redacted.nested.ok, 'fine');
});
