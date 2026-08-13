'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkRemote, fetchRemoteText, REMOTE_ROOT } = require('../lib/onedrive-sync');

function fakeGraph(response) {
  const calls = [];
  return {
    calls,
    graphRequest: async (pathAndQuery) => { calls.push(pathAndQuery); return response; },
  };
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
  assert.ok(graph.calls[0].includes('Sconl'), 'request path includes the remote root');
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
