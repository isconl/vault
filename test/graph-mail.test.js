'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendMail } = require('../lib/graph-mail');

function fakeGraph(handler) {
  const calls = [];
  return { calls, graphRequest: async (path, opts) => { calls.push({ path, opts }); return handler(path, opts); } };
}

test('sendMail requires to', async () => {
  const graph = fakeGraph(() => ({ status: 202, data: {} }));
  const r = await sendMail(graph, { subject: 'x', body: 'y' });
  assert.equal(r.ok, false);
});

test('sendMail posts to /v1.0/me/sendMail with a single recipient, plain text body, saveToSentItems', async () => {
  const graph = fakeGraph((path, opts) => {
    assert.equal(path, '/v1.0/me/sendMail');
    assert.equal(opts.method, 'POST');
    assert.deepEqual(opts.body.message.toRecipients, [{ emailAddress: { address: 'alex@example.com' } }]);
    assert.equal(opts.body.message.subject, 'Status update');
    assert.equal(opts.body.message.body.contentType, 'Text');
    assert.equal(opts.body.message.body.content, 'hello');
    assert.equal(opts.body.saveToSentItems, true);
    assert.equal(opts.body.message.ccRecipients, undefined);
    return { status: 202, data: {} };
  });
  const r = await sendMail(graph, { to: 'alex@example.com', subject: 'Status update', body: 'hello' });
  assert.equal(r.ok, true);
});

test('sendMail accepts an array of to/cc addresses', async () => {
  const graph = fakeGraph((path, opts) => {
    assert.equal(opts.body.message.toRecipients.length, 2);
    assert.equal(opts.body.message.ccRecipients.length, 1);
    return { status: 202, data: {} };
  });
  const r = await sendMail(graph, { to: ['a@example.com', 'b@example.com'], cc: 'c@example.com', subject: 'x', body: 'y' });
  assert.equal(r.ok, true);
});

test('sendMail surfaces a non-202 as ok:false without throwing', async () => {
  const graph = fakeGraph(() => ({ status: 403, data: { error: { message: 'insufficient privileges' } } }));
  const r = await sendMail(graph, { to: 'alex@example.com', subject: 'x', body: 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.error, 'insufficient privileges');
});
