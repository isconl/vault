'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listMessages, getMessage, sendMessage, parseFrom, extractBody } = require('../lib/gmail');

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeGoogle(handler) {
  const calls = [];
  return { calls, googleRequest: async (hostname, path, opts) => { calls.push({ hostname, path, opts }); return handler(hostname, path, opts); } };
}

test('parseFrom splits "Display Name <email>" and lowercases the address', () => {
  assert.deepEqual(parseFrom('Alex Rivera <Alex@Example.com>'), { name: 'Alex Rivera', email: 'alex@example.com' });
});

test('parseFrom handles a bare address with no display name', () => {
  assert.deepEqual(parseFrom('bare@example.com'), { name: 'bare@example.com', email: 'bare@example.com' });
});

test('extractBody finds text/plain nested inside multipart/alternative', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [{
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('hello plain') } },
        { mimeType: 'text/html', body: { data: b64url('<p>hello html</p>') } },
      ],
    }],
  };
  assert.equal(extractBody(payload), 'hello plain');
});

test('extractBody falls back to a stripped text/html part when no text/plain exists', () => {
  const payload = { mimeType: 'text/html', body: { data: b64url('<p>only html</p>') } };
  assert.equal(extractBody(payload), 'only html');
});

test('extractBody reads a single-part message body directly', () => {
  const payload = { body: { data: b64url('just the body') } };
  assert.equal(extractBody(payload), 'just the body');
});

test('listMessages returns message ids on success', async () => {
  const google = fakeGoogle(() => ({ status: 200, data: { messages: [{ id: 'm1' }, { id: 'm2' }] } }));
  const r = await listMessages(google, { query: 'in:inbox is:unread' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids, ['m1', 'm2']);
  assert.match(google.calls[0].path, /q=in%3Ainbox/);
});

test('listMessages reports ok:false on a non-200 without throwing', async () => {
  const google = fakeGoogle(() => ({ status: 401, data: { error: { message: 'not connected' } } }));
  const r = await listMessages(google);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not connected');
});

test('getMessage parses headers, from, and the plain-text body', async () => {
  const google = fakeGoogle(() => ({
    status: 200,
    data: {
      id: 'm1', threadId: 't1', snippet: 'snippet text',
      payload: {
        headers: [
          { name: 'From', value: 'Alex Rivera <alex@example.com>' },
          { name: 'Subject', value: 'Re: proposal' },
          { name: 'Date', value: 'Thu, 20 Aug 2026 10:00:00 +0300' },
        ],
        mimeType: 'text/plain',
        body: { data: b64url('the real body') },
      },
    },
  }));
  const msg = await getMessage(google, 'm1');
  assert.equal(msg.ok, true);
  assert.equal(msg.from.email, 'alex@example.com');
  assert.equal(msg.subject, 'Re: proposal');
  assert.equal(msg.body, 'the real body');
});

test('getMessage falls back to the snippet when the body cannot be extracted', async () => {
  const google = fakeGoogle(() => ({ status: 200, data: { id: 'm1', threadId: 't1', snippet: 'snippet only', payload: { headers: [] } } }));
  const msg = await getMessage(google, 'm1');
  assert.equal(msg.body, 'snippet only');
});

test('sendMessage builds a base64url RFC822 message and posts it to the send endpoint', async () => {
  const google = fakeGoogle((hostname, path) => (path.endsWith('/send') ? { status: 200, data: { id: 'sent1', threadId: 't1' } } : { status: 404, data: {} }));
  const r = await sendMessage(google, { to: 'alex@example.com', subject: 'Re: proposal', body: 'sounds good', threadId: 't1', inReplyTo: '<abc@mail.gmail.com>' });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'sent1');
  const call = google.calls[0];
  assert.equal(call.path, '/gmail/v1/users/me/messages/send');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.body.threadId, 't1');
  const decoded = Buffer.from(call.opts.body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(decoded, /To: alex@example\.com/);
  assert.match(decoded, /In-Reply-To: <abc@mail\.gmail\.com>/);
  assert.match(decoded, /sounds good/);
});

test('sendMessage refuses to send with no recipient', async () => {
  const google = fakeGoogle(() => ({ status: 200, data: {} }));
  const r = await sendMessage(google, { subject: 'x', body: 'y' });
  assert.equal(r.ok, false);
  assert.equal(google.calls.length, 0);
});
