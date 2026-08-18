'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkRemote, fetchRemoteText, pullToLocal, listRemoteFolder, pullFolder, pushToRemote, REMOTE_ROOT } = require('../lib/onedrive-sync');
const { createVaultStore } = require('../lib/store');

function fakeGraph(response) {
  const calls = [];
  return {
    calls,
    graphRequest: async (pathAndQuery) => { calls.push(pathAndQuery); return response; },
  };
}

/** A graph fake that routes by whether the request is a :/children listing or a :/content fetch, since folder pulls make both kinds of call in one pass. */
function fakeGraphRouter({ children, contentByFile }) {
  const calls = [];
  return {
    calls,
    graphRequest: async (pathAndQuery) => {
      calls.push(pathAndQuery);
      if (pathAndQuery.endsWith(':/children')) return children;
      for (const [name, response] of Object.entries(contentByFile)) {
        if (pathAndQuery.includes(encodeURIComponent(name))) return response;
      }
      return { status: 404, data: { error: { code: 'itemNotFound' } } };
    },
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

test('pullToLocal writes real remote content into an empty local file', async () => {
  const store = tmpStore();
  store.ensureVault();   // bootstraps scope/tasks.tsv with just its header, same as a fresh vault
  assert.equal(store.read('scope/tasks.tsv').length, 0);

  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\tSTATUS\n1\tBuy milk\topen\n2\tCall Fred\topen\n' });
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

// INC-002 (2026-08-18, see _handoff/INCIDENTS.md): pullToLocal used to
// report localRowCountAfter as remoteRows.length unconditionally, even when
// the massacre guard silently refused the write -- making a correctly
// refused pull look identical to a successful one in every caller's eyes
// (sync-status logs, /onedrive/check), which is what made a guard that had
// worked correctly on every single pass look like it had failed.
test('pullToLocal reports the REAL local row count after a guard-refused write, not the attempted remote count', async () => {
  const store = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Existing', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '2', TITLE: 'Existing 2', STATUS: 'open' });
  store.append('scope/tasks.tsv', { ID: '3', TITLE: 'Existing 3', STATUS: 'open' });

  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\tSTATUS\n9\tRemote only\topen\n' });
  const result = await pullToLocal(graph, store, 'scope/tasks.tsv');
  assert.equal(result.remoteRowCount, 1, 'remote genuinely only had 1 row');
  assert.equal(result.localRowCountAfter, 3, 'but nothing was actually written -- must not equal remoteRowCount');
  assert.equal(result.localRowCountBefore, result.localRowCountAfter, 'before/after must match on a refused write');
  assert.equal(result.refused, true);
});

test('pullToLocal reports refused:false on a normal successful pull', async () => {
  const store = tmpStore();
  store.ensureVault();
  const graph = fakeGraph({ status: 200, data: 'ID\tTITLE\tSTATUS\n1\tBuy milk\topen\n2\tCall Fred\topen\n' });
  const result = await pullToLocal(graph, store, 'scope/tasks.tsv');
  assert.equal(result.localRowCountAfter, 2);
  assert.equal(result.refused, false);
});

test('listRemoteFolder lists file children only, skipping subfolders', async () => {
  const graph = fakeGraphRouter({
    children: { status: 200, data: { value: [
      { name: '00-intro.md', file: {} },
      { name: '01-deep-dive.md', file: {} },
      { name: '_notes', folder: {} },
    ] } },
    contentByFile: {},
  });
  const result = await listRemoteFolder(graph, 'learning/viva');
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ['00-intro.md', '01-deep-dive.md']);
});

test('listRemoteFolder reports failure cleanly on a non-200, never throws', async () => {
  const graph = fakeGraphRouter({ children: { status: 404, data: { error: { code: 'itemNotFound' } } }, contentByFile: {} });
  const result = await listRemoteFolder(graph, 'learning/missing-course');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('pullFolder pulls every file the listing reports into the local vault', async () => {
  const store = tmpStore();
  const graph = fakeGraphRouter({
    children: { status: 200, data: { value: [
      { name: '00-intro.md', file: {} },
      { name: '01-deep-dive.md', file: {} },
    ] } },
    contentByFile: {
      '00-intro.md': { status: 200, data: '# Intro' },
      '01-deep-dive.md': { status: 200, data: '# Deep dive' },
    },
  });
  const result = await pullFolder(graph, store, 'learning/viva');
  assert.equal(result.ok, true);
  assert.equal(result.files.length, 2);
  assert.ok(result.files.every((f) => f.ok));
  assert.equal(store.rawRead('learning/viva/00-intro.md'), '# Intro');
  assert.equal(store.rawRead('learning/viva/01-deep-dive.md'), '# Deep dive');
});

test('pullFolder reports the listing failure directly when the folder itself 404s', async () => {
  const store = tmpStore();
  const graph = fakeGraphRouter({ children: { status: 404, data: { error: { code: 'itemNotFound' } } }, contentByFile: {} });
  const result = await pullFolder(graph, store, 'learning/missing-course');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('pullFolder records a per-file failure without losing the files that did succeed', async () => {
  const store = tmpStore();
  const graph = fakeGraphRouter({
    children: { status: 200, data: { value: [
      { name: '00-intro.md', file: {} },
      { name: '01-broken.md', file: {} },
    ] } },
    contentByFile: {
      '00-intro.md': { status: 200, data: '# Intro' },
      // 01-broken.md deliberately has no content entry -> the router's default 404
    },
  });
  const result = await pullFolder(graph, store, 'learning/viva');
  assert.equal(result.ok, true);   // the folder listing itself succeeded
  const broken = result.files.find((f) => f.file === '01-broken.md');
  const intro = result.files.find((f) => f.file === '00-intro.md');
  assert.equal(broken.ok, false);
  assert.equal(intro.ok, true);
  assert.equal(store.rawRead('learning/viva/00-intro.md'), '# Intro');
});

test('pushToRemote PUTs the local file\'s current bytes to REMOTE_ROOT/relPath', async () => {
  const store = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  const local = store.rawRead('scope/tasks.tsv');

  const graph = fakeGraph({ status: 200, data: {} });
  const result = await pushToRemote(graph, store, 'scope/tasks.tsv');

  assert.equal(result.ok, true);
  assert.equal(result.bytes, Buffer.byteLength(local, 'utf8'));
  assert.equal(graph.calls.length, 1);
  assert.ok(graph.calls[0].includes('scope'), 'request path includes the collection');
});

test('pushToRemote refuses to push an empty/missing local file rather than blanking the remote', async () => {
  const store = tmpStore();
  const graph = fakeGraph({ status: 200, data: {} });
  const result = await pushToRemote(graph, store, 'scope/tasks.tsv');
  assert.equal(result.ok, false);
  assert.equal(graph.calls.length, 0, 'never called Graph at all -- refused before the request');
});

test('pushToRemote reports a non-2xx Graph response as ok:false, never throws', async () => {
  const store = tmpStore();
  store.ensureVault();
  store.append('scope/tasks.tsv', { ID: '1', TITLE: 'Buy milk', STATUS: 'open' });
  const graph = fakeGraph({ status: 401, data: { error: { message: 'Microsoft 365 not connected.' } } });
  const result = await pushToRemote(graph, store, 'scope/tasks.tsv');
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});
