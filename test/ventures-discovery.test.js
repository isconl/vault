'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { discoverVentures, pushDiscoveredVentures } = require('../lib/ventures-discovery');

// Real `_ace` listing shape (rclone lsf --max-depth 2), confirmed live 8 Sep
// 2026 -- see BN26090610. Never hits the network in this test file: every
// case injects a fake listFn.
const REAL_ACE_LINES = [
  'Practice/', 'Products/', 'Protocols/', '_admin/', '_brands/',
  'acexoft-capital/', 'acexoft-dynamics/', 'acexoft-foundation/', 'collaboration/',
  '_brands/__assets/', '_brands/_acexoft-dynamics/', '_brands/_acexoft-foundation/',
  '_brands/ace-cyber-space/', '_brands/ace-design-studio/', '_brands/ace-quntum-engineering/',
  '_brands/aceplus-hospitals/',
  'acexoft-dynamics/_parent/', 'acexoft-dynamics/cyber-space/', 'acexoft-dynamics/design-studio/',
  'acexoft-dynamics/health-systems/',
  'collaboration/partner-brands/',
  '_admin/__strategy/', '_admin/accounting/', '_admin/legal/',
];

function fakeListFn(lines) {
  return async () => lines;
}

test('discoverVentures surfaces the 3 top-level operating entities, excluding structural/non-venture folders', async () => {
  const result = await discoverVentures(fakeListFn(REAL_ACE_LINES));
  assert.equal(result.ok, true);
  const folders = result.ventures.map((v) => v.folder);
  assert.ok(folders.includes('acexoft-capital'));
  assert.ok(folders.includes('acexoft-dynamics'));
  assert.ok(folders.includes('acexoft-foundation'));
  // never candidates in their own right
  for (const excluded of ['_admin', '_brands', 'Practice', 'Products', 'Protocols', 'collaboration']) {
    assert.ok(!folders.includes(excluded), `${excluded} should never be a candidate`);
  }
});

test('discoverVentures surfaces acexoft-dynamics subsidiaries, excluding _parent (personal documents)', async () => {
  const result = await discoverVentures(fakeListFn(REAL_ACE_LINES));
  const folders = result.ventures.map((v) => v.folder);
  assert.ok(folders.includes('acexoft-dynamics/cyber-space'));
  assert.ok(folders.includes('acexoft-dynamics/design-studio'));
  assert.ok(folders.includes('acexoft-dynamics/health-systems'));
  assert.ok(!folders.includes('acexoft-dynamics/_parent'));
});

test('discoverVentures surfaces _brands identities with no matching operating folder, deduping the ones that do match (incl. an "ace-" prefix)', async () => {
  const result = await discoverVentures(fakeListFn(REAL_ACE_LINES));
  const folders = result.ventures.map((v) => v.folder);
  // ace-cyber-space / ace-design-studio dedupe against their operating-folder
  // counterparts (cyber-space / design-studio) via the ace- prefix strip.
  assert.ok(!folders.some((f) => f.includes('ace-cyber-space')));
  assert.ok(!folders.some((f) => f.includes('ace-design-studio')));
  // _acexoft-dynamics / _acexoft-foundation dedupe against the top-level folders.
  assert.ok(!folders.some((f) => f.includes('_acexoft-dynamics')));
  assert.ok(!folders.some((f) => f.includes('_acexoft-foundation')));
  // __assets is asset storage, never a brand candidate.
  assert.ok(!folders.some((f) => f.includes('__assets')));
  // No operating folder exists for these two -- surfaced as genuinely new candidates.
  assert.ok(folders.includes('_brands/ace-quntum-engineering'));
  assert.ok(folders.includes('_brands/aceplus-hospitals'));
});

test('discoverVentures excludes collaboration/partner-brands (external partner brands, not Sconl\'s own ventures)', async () => {
  const result = await discoverVentures(fakeListFn(REAL_ACE_LINES));
  const folders = result.ventures.map((v) => v.folder);
  assert.ok(!folders.some((f) => f.includes('partner-brands')));
  assert.ok(!folders.some((f) => f.includes('blank-engineering')));
  assert.ok(!folders.some((f) => f.includes('velour-experience')));
});

test('discoverVentures title-cases candidate names from their folder slug', async () => {
  const result = await discoverVentures(fakeListFn(['acexoft-capital/']));
  assert.deepEqual(result.ventures, [{ folder: 'acexoft-capital', name: 'Acexoft Capital' }]);
});

test('discoverVentures ignores files sitting alongside folders in the same listing', async () => {
  const result = await discoverVentures(fakeListFn(['acexoft-capital/', 'readme.txt']));
  assert.equal(result.ventures.length, 1);
});

test('discoverVentures reports ok:false without throwing when the listing function rejects', async () => {
  const result = await discoverVentures(async () => { throw new Error('rclone: remote not found'); });
  assert.equal(result.ok, false);
  assert.match(result.error, /remote not found/);
});

test('discoverVentures returns exactly the 8 real candidates confirmed live 8 Sep 2026 (BN26090610), no more, no fewer', async () => {
  const result = await discoverVentures(fakeListFn(REAL_ACE_LINES));
  const folders = result.ventures.map((v) => v.folder).sort();
  assert.deepEqual(folders, [
    '_brands/ace-quntum-engineering',
    '_brands/aceplus-hospitals',
    'acexoft-capital',
    'acexoft-dynamics',
    'acexoft-dynamics/cyber-space',
    'acexoft-dynamics/design-studio',
    'acexoft-dynamics/health-systems',
    'acexoft-foundation',
  ]);
});

test('pushDiscoveredVentures resolves ok:false without throwing when PULSE_URL is not configured', async () => {
  const result = await pushDiscoveredVentures([{ folder: 'x', name: 'X' }], {});
  assert.equal(result.ok, false);
  assert.match(result.error, /PULSE_URL/);
});

test('pushDiscoveredVentures is a no-op success for an empty candidate list', async () => {
  const result = await pushDiscoveredVentures([], { pulseUrl: 'http://127.0.0.1:1' });
  assert.deepEqual(result, { ok: true, created: [], skipped: [] });
});

test('pushDiscoveredVentures POSTs to /finance/ventures/discover-ingest with a bearer token and returns pulse\'s response', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    received = { method: req.method, url: req.url, auth: req.headers.authorization };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.body = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: [{ id: 'ven-acexoft-capital', folder: 'acexoft-capital' }], skipped: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await pushDiscoveredVentures([{ folder: 'acexoft-capital', name: 'Acexoft Capital' }],
      { pulseUrl: `http://127.0.0.1:${port}`, token: 'tok-123' });
    assert.equal(result.ok, true);
    assert.equal(result.created.length, 1);
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/finance/ventures/discover-ingest');
    assert.equal(received.auth, 'Bearer tok-123');
    assert.equal(received.body.ventures[0].folder, 'acexoft-capital');
  } finally {
    server.close();
  }
});

test('pushDiscoveredVentures resolves ok:false on a non-200 response, without throwing', async () => {
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await pushDiscoveredVentures([{ folder: 'x', name: 'X' }], { pulseUrl: `http://127.0.0.1:${port}` });
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  } finally {
    server.close();
  }
});
