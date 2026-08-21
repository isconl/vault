'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { discoverOrgs, pushDiscoveredOrgs, CORPORATE_ROOT } = require('../lib/corporate-discovery');

function fakeGraph(response) {
  const calls = [];
  return {
    calls,
    graphRequest: async (pathAndQuery) => { calls.push(pathAndQuery); return response; },
  };
}

test('discoverOrgs lists folders under the Corporate root and parses YYYY-org-slug names', async () => {
  const graph = fakeGraph({
    status: 200,
    data: {
      value: [
        { name: '2026-viva-valentia', folder: {}, createdDateTime: '2026-07-01T00:00:00Z' },
        { name: '2026-acme', folder: {}, createdDateTime: '2026-08-05T00:00:00Z' },
        { name: 'notes.txt', file: {} }, // a real file sitting alongside the folders -- must be excluded
      ],
    },
  });
  const result = await discoverOrgs(graph);
  assert.equal(result.ok, true);
  assert.equal(result.orgs.length, 2);
  assert.deepEqual(result.orgs[0], { folder: '2026-viva-valentia', id: 'viva-valentia', name: 'Viva Valentia', discoveryDate: '2026-07-01' });
  assert.equal(result.orgs[1].id, 'acme');
  assert.ok(graph.calls[0].includes(encodeURIComponent(CORPORATE_ROOT).replace(/%2F/g, '/')));
});

test('discoverOrgs handles a folder name that does not match the YYYY-slug pattern by using the whole name as the id', async () => {
  const graph = fakeGraph({ status: 200, data: { value: [{ name: 'freelance-misc', folder: {} }] } });
  const result = await discoverOrgs(graph);
  assert.equal(result.orgs[0].id, 'freelance-misc');
  assert.equal(result.orgs[0].name, 'Freelance Misc');
});

test('discoverOrgs reports ok:false on a listing failure without throwing', async () => {
  const graph = fakeGraph({ status: 404, data: { error: { code: 'itemNotFound' } } });
  const result = await discoverOrgs(graph);
  assert.equal(result.ok, false);
});

test('pushDiscoveredOrgs resolves ok:false without throwing when CIRCLE_URL is not configured', async () => {
  const result = await pushDiscoveredOrgs([{ id: 'x' }], {});
  assert.equal(result.ok, false);
  assert.match(result.error, /CIRCLE_URL/);
});

test('pushDiscoveredOrgs is a no-op success for an empty org list', async () => {
  const result = await pushDiscoveredOrgs([], { circleUrl: 'http://127.0.0.1:1' });
  assert.deepEqual(result, { ok: true, created: [], skipped: [] });
});

test('pushDiscoveredOrgs POSTs to /career/orgs/discover with a bearer token and returns circle\'s response', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received = { url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: ['viva-valentia'], skipped: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const result = await pushDiscoveredOrgs(
    [{ id: 'viva-valentia', name: 'Viva Valentia', discoveryDate: '2026-08-20' }],
    { circleUrl: `http://127.0.0.1:${port}`, token: 'tok-123' },
  );

  server.close();
  assert.equal(result.ok, true);
  assert.deepEqual(result.created, ['viva-valentia']);
  assert.equal(received.url, '/career/orgs/discover');
  assert.equal(received.method, 'POST');
  assert.equal(received.auth, 'Bearer tok-123');
  assert.equal(received.body.orgs[0].id, 'viva-valentia');
});

test('pushDiscoveredOrgs resolves ok:false (never throws) when the request errors', async () => {
  const result = await pushDiscoveredOrgs([{ id: 'x' }], { circleUrl: 'http://127.0.0.1:1', token: 't' });
  assert.equal(result.ok, false);
});
