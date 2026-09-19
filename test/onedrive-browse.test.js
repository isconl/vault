'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getItemPreview } = require('../lib/onedrive-browse');

function fakeGraph(handlers) {
  return {
    graphRequest: async (path, opts = {}) => {
      const h = handlers.find(h => h.match(path, opts));
      if (!h) throw new Error(`unhandled graphRequest: ${opts.method || 'GET'} ${path}`);
      return h.respond(path, opts);
    },
  };
}

test('getItemPreview fetches an officePreviewUrl for a .docx via Graph\'s POST /preview action, with a JSON-serialized body', async () => {
  let previewCallOpts = null;
  const graph = fakeGraph([
    { match: (p) => /\/items\/id1$/.test(p), respond: () => ({ status: 200, data: { id: 'id1', name: 'doc.docx', size: 10, webUrl: 'https://x', '@microsoft.graph.downloadUrl': 'https://dl' } }) },
    { match: (p) => /\/preview$/.test(p), respond: (p, opts) => { previewCallOpts = opts; return { status: 200, data: { getUrl: 'https://embed.example/preview' } }; } },
  ]);
  const r = await getItemPreview(graph, 'id1');
  assert.equal(r.ok, true);
  assert.equal(r.officePreviewUrl, 'https://embed.example/preview');
  // BUG found live 20 Aug: passing body as a plain object crashed the whole
  // vault process (graph.js's http write only accepts string/Buffer) --
  // regression-guard that the body is always JSON-serialized before send.
  assert.equal(typeof previewCallOpts.body, 'string');
  assert.deepEqual(JSON.parse(previewCallOpts.body), {});
});

test('getItemPreview does not call /preview for a non-Office file', async () => {
  let previewCalled = false;
  const graph = fakeGraph([
    { match: (p) => /\/items\/id2$/.test(p), respond: () => ({ status: 200, data: { id: 'id2', name: 'photo.png', size: 10 } }) },
    { match: (p) => /\/preview$/.test(p), respond: () => { previewCalled = true; return { status: 200, data: {} }; } },
  ]);
  const r = await getItemPreview(graph, 'id2');
  assert.equal(r.officePreviewUrl, null);
  assert.equal(previewCalled, false);
});

test('getItemPreview leaves officePreviewUrl null when Graph\'s /preview call fails, rather than throwing', async () => {
  const graph = fakeGraph([
    { match: (p) => /\/items\/id3$/.test(p), respond: () => ({ status: 200, data: { id: 'id3', name: 'sheet.xlsx', size: 10 } }) },
    { match: (p) => /\/preview$/.test(p), respond: () => ({ status: 403, data: { error: 'forbidden' } }) },
  ]);
  const r = await getItemPreview(graph, 'id3');
  assert.equal(r.ok, true);
  assert.equal(r.officePreviewUrl, null);
});
