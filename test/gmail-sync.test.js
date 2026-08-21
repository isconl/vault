'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncGmailAccount, findPersonByEmail, createGmailSyncLoop } = require('../lib/gmail-sync');

function fakeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    read: (rel) => (data[rel] || []).slice(),
    rewrite: (rel, fn) => { data[rel] = fn((data[rel] || []).slice()); },
  };
}

test('findPersonByEmail matches case-insensitively and returns null for no match or empty input', () => {
  const people = [{ ID: 'alex', EMAIL: 'Alex@Example.com' }];
  assert.equal(findPersonByEmail(people, 'alex@example.com').ID, 'alex');
  assert.equal(findPersonByEmail(people, 'nobody@example.com'), null);
  assert.equal(findPersonByEmail(people, ''), null);
});

function fakeGmail({ ids = [], messages = {} } = {}) {
  return {
    listMessages: async () => ({ ok: true, ids }),
    getMessage: async (google, id) => messages[id] || { ok: false, error: 'not found' },
  };
}

test('syncGmailAccount writes a new inbox.tsv row per message, matched by EMAIL', async () => {
  const store = fakeStore({ 'circle/people.tsv': [{ ID: 'alex', NAME: 'Alex Rivera', EMAIL: 'alex@example.com' }] });
  const gmail = fakeGmail({
    ids: ['m1'],
    messages: { m1: { ok: true, id: 'm1', threadId: 't1', from: { name: 'Alex Rivera', email: 'alex@example.com' }, subject: 'Re: proposal', date: '2026-08-21', body: 'sounds good' } },
  });
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'default' });
  assert.equal(r.ok, true);
  assert.equal(r.newMessages, 1);
  const row = store.data['scope/inbox.tsv'][0];
  assert.equal(row.PERSON_ID, 'alex');
  assert.equal(row.DIRECTION, 'in');
  assert.equal(row.CHANNEL, 'gmail');
  assert.equal(row.SOURCE, 'gmail:default:m1');
  assert.equal(row.SENDER, 'Alex Rivera <alex@example.com>', 'SENDER carries the real address parseable back out, not just the display name');
});

test('syncGmailAccount stores a bare email in SENDER when the message has no distinct display name', async () => {
  const store = fakeStore({ 'circle/people.tsv': [] });
  const gmail = fakeGmail({
    ids: ['m1'],
    messages: { m1: { ok: true, id: 'm1', threadId: 't1', from: { name: 'stranger@example.com', email: 'stranger@example.com' }, subject: 'hi', date: '2026-08-21', body: 'hi' } },
  });
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'default' });
  assert.equal(store.data['scope/inbox.tsv'][0].SENDER, 'stranger@example.com');
});

test('syncGmailAccount still files an unmatched sender rather than dropping the message', async () => {
  const store = fakeStore({ 'circle/people.tsv': [] });
  const gmail = fakeGmail({
    ids: ['m1'],
    messages: { m1: { ok: true, id: 'm1', threadId: 't1', from: { name: 'Stranger', email: 'stranger@example.com' }, subject: 'hi', date: '2026-08-21', body: 'hi' } },
  });
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'default' });
  assert.equal(r.newMessages, 1);
  assert.equal(store.data['scope/inbox.tsv'][0].PERSON_ID, '-');
});

test('syncGmailAccount does not re-write an already-pulled message (dedup by SOURCE)', async () => {
  const store = fakeStore({
    'circle/people.tsv': [],
    'scope/inbox.tsv': [{ ID: 'I001', SOURCE: 'gmail:default:m1' }],
  });
  const gmail = fakeGmail({ ids: ['m1'] }); // getMessage would throw/error if called -- listMessages alone should short-circuit dedup before any getMessage call
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'default' });
  assert.equal(r.newMessages, 0);
  assert.equal(store.data['scope/inbox.tsv'].length, 1);
});

test('syncGmailAccount is a clean no-op when there are no matching messages', async () => {
  const store = fakeStore();
  const gmail = fakeGmail({ ids: [] });
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'default' });
  assert.equal(r.ok, true);
  assert.equal(r.newMessages, 0);
  assert.equal(store.data['scope/inbox.tsv'], undefined);
});

test('syncGmailAccount reports ok:false without throwing when the list call fails', async () => {
  const store = fakeStore();
  const gmail = { listMessages: async () => ({ ok: false, error: 'not connected' }) };
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'default' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not connected');
});

test('syncGmailAccount skips (not fails) a single message whose getMessage call errors, and still writes the rest', async () => {
  const store = fakeStore({ 'circle/people.tsv': [] });
  const gmail = fakeGmail({
    ids: ['bad', 'good'],
    messages: { good: { ok: true, id: 'good', threadId: 't1', from: { name: 'X', email: 'x@example.com' }, subject: 's', date: '2026-08-21', body: 'b' } },
  });
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'default' });
  assert.equal(r.newMessages, 1);
  assert.equal(store.data['scope/inbox.tsv'][0].SOURCE, 'gmail:default:good');
});

test('SOURCE is keyed per account label, so the same message id from two connected accounts never collides', async () => {
  const store = fakeStore({ 'circle/people.tsv': [], 'scope/inbox.tsv': [{ ID: 'I001', SOURCE: 'gmail:work:m1' }] });
  const gmail = fakeGmail({
    ids: ['m1'],
    messages: { m1: { ok: true, id: 'm1', threadId: 't1', from: { name: 'X', email: 'x@example.com' }, subject: 's', date: '2026-08-21', body: 'b' } },
  });
  const r = await syncGmailAccount({ google: {}, gmail, store, accountLabel: 'personal' });
  assert.equal(r.newMessages, 1);
  assert.equal(store.data['scope/inbox.tsv'].length, 2);
});

test('createGmailSyncLoop.runOnce syncs every connected account and does not let one failing account block another', async () => {
  const store = fakeStore({ 'circle/people.tsv': [] });
  const gmail = {
    listMessages: async (google) => (google.label === 'bad' ? { ok: false, error: 'boom' } : { ok: true, ids: [] }),
    getMessage: async () => ({ ok: false, error: 'unused' }),
  };
  const googleClients = new Map([
    ['good1', { label: 'good1' }],
    ['bad', { label: 'bad' }],
    ['good2', { label: 'good2' }],
  ]);
  const loop = createGmailSyncLoop({ googleClients, gmail, store });
  const results = await loop.runOnce();
  assert.equal(results.length, 3);
  assert.ok(results.find(r => r.account === 'good1' && r.ok));
  assert.ok(results.find(r => r.account === 'bad' && r.ok === false));
  assert.ok(results.find(r => r.account === 'good2' && r.ok));
});

test('createGmailSyncLoop.runOnce skips (not queues) a second call while one is already in flight', async () => {
  let resolveFirst;
  const gmail = { listMessages: () => new Promise((r) => { resolveFirst = r; }), getMessage: async () => ({ ok: false }) };
  const loop = createGmailSyncLoop({ googleClients: new Map([['a', {}]]), gmail, store: fakeStore() });
  const p1 = loop.runOnce();
  const p2 = loop.runOnce();
  const r2 = await p2;
  assert.deepEqual(r2, { skipped: 'already running' });
  resolveFirst({ ok: true, ids: [] });
  await p1;
});
