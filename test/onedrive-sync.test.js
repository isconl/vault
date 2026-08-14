'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkRemote, fetchRemoteText, pullToLocal, REMOTE_ROOT } = require('../lib/onedrive-sync');
const { createVaultStore } = require('../lib/store');

function fakeGraph(response) {
  const calls = [];
  return {
    calls,
    graphRequest: async (pathAndQuery) => { calls.push(pathAndQuery); return response; },
  };
}

function tmpStore() {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-onedrive-test-'));
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-onedrive-logs-'));
  return createVaultStore({ memoryDir, logsDir, schema: { 'scope/tasks.tsv': 'ID\tTITLE\tSTATUS' } });
}

test('REMOTE_ROOT is the verified-correct path, not the legacy monolith\'s stale one', () => {
  assert.equal(REMOTE_ROOT, 'Sconl/Core/Apex/Vault/vault-documents/isconl-vault');
});

test('fetchRemoteText builds the request against REMOTE_ROOT/relPath and returns raw text on 200', async () => {
  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\n1\tBuy milk\n' });
  const result = await fetchRemoteText(graph, 'scope/tasks.tsv');
  assert.equal(result.ok, true);
  assert.equal(result.raw, 'ID\tTITLE\n1\tBuy milk\n');
  assert.equal(graph.calls.length, 1);
  assert.ok(graph.calls[0].includes('Architect'), 'request path includes the remote root');
  assert.ok(graph.calls[0].includes('scope'), 'request path includes the collection');
});

test('fetchRemoteText reports failure cleanly on a non-200, never throws', async () => {
  const graph = fakeGraph({ status: 404, data: { error: { code: 'itemNotFound' } } });
  const result = await fetchRemoteText(graph, 'scope/missing.tsv');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('checkRemote reports a row-count mismatch between remote and local without changing either', async () => {
  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\n1\tA\n2\tB\n3\tC\n' });
  const local = [{ ID: '1', TITLE: 'A' }];   // local only has 1 row; remote has 3
  const result = await checkRemote(graph, 'scope/tasks.tsv', local);
  assert.equal(result.ok, true);
  assert.equal(result.remoteRowCount, 3);
  assert.equal(result.localRowCount, 1);
  assert.equal(result.matches, false);
});

test('checkRemote reports a match when row counts agree', async () => {
  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\n1\tA\n' });
  const local = [{ ID: '1', TITLE: 'A' }];
  const result = await checkRemote(graph, 'scope/tasks.tsv', local);
  assert.equal(result.matches, true);
});

test('checkRemote surfaces auth/network failure as ok:false rather than throwing', async () => {
  const graph = fakeGraph({ status: 401, data: { error: { message: 'Microsoft 365 not connected.' } } });
  const result = await checkRemote(graph, 'scope/tasks.tsv', []);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('pullToLocal writes real remote content into an empty local file', async () => {
  const store = tmpStore();
  store.ensureVault();   // bootstraps scope/tasks.tsv with just its header, same as a fresh vault
  assert.equal(store.read('scope/tasks.tsv').length, 0);

  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\tSTATUS\n1\tBuy milk\topen\n2\tCall Taylor\topen\n' });
  const result = await pullToLocal(graph, store, 'scope/tasks.tsv');

  assert.equal(result.ok, true);
  assert.equal(result.localRowCountBefore, 0);
  assert.equal(result.localRowCountAfter, 2);
  const after = store.read('scope/tasks.tsv');
  assert.equal(after.length, 2);
  assert.equal(after[0].TITLE, 'Buy milk');
});

test('pullToLocal never touches the local file on a fetch failure', async () => {
  const store = tmpStore();
  store.ensureVault();
  const graph = fakeGraph({ status: 401, data: { error: 'no' } });
  const result = await pullToLocal(graph, store, 'scope/tasks.tsv');
  assert.equal(result.ok, false);
  assert.equal(store.read('scope/tasks.tsv').length, 0);
});

test('pullToLocal respects the massacre guard on an already-populated file, without force', async () => {
  const store = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Existing', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '2', TITLE: 'Existing 2', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '3', TITLE: 'Existing 3', STATUS: 'open' });
  assert.equal(store.read('scope/tasks.tsv').length, 3);

  // Remote has only 1 row -- pulling it in would drop 2 of 3 local rows,
  // which the guard refuses without force.
  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\tSTATUS\n9\tRemote only\topen\n' });
  const result = await pullToLocal(graph, store, 'scope/tasks.tsv');
  assert.equal(result.ok, true);   // the fetch succeeded; the guard is what stood down the write
  assert.equal(store.read('scope/tasks.tsv').length, 3, 'guard refused the bulk drop -- local rows untouched');
});
