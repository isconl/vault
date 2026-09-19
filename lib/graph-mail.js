'use strict';
/**
 * Microsoft Graph mail send -- BI26082419. graph.js already requests
 * Mail.Send in its token scope (`GRAPH_SCOPE`, graph.js:28) but no send
 * function existed anywhere in the fleet; this is that function, same
 * sibling-module pattern gmail.js already uses for Google (a thin wrapper
 * on top of the generic graphRequest(), not folded into graph.js itself).
 */

/** Send mail via POST /me/sendMail. `to` is a single address or an array of addresses; plain text only, no attachments (matching this row's own scope). */
async function sendMail(graph, { to, subject, body, cc } = {}) {
  if (!to) return { ok: false, error: 'to required' };
  const toList = Array.isArray(to) ? to : [to];
  const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : [];
  const message = {
    subject: subject || '(no subject)',
    body: { contentType: 'Text', content: body || '' },
    toRecipients: toList.map(addr => ({ emailAddress: { address: addr } })),
    ...(ccList.length ? { ccRecipients: ccList.map(addr => ({ emailAddress: { address: addr } })) } : {}),
  };
  const res = await graph.graphRequest('/v1.0/me/sendMail', { method: 'POST', body: { message, saveToSentItems: true } });
  // Graph's sendMail returns 202 Accepted with an empty body on success --
  // there is no message id to hand back, unlike gmail.js's sendMessage().
  if (res.status !== 202) return { ok: false, status: res.status, error: res.data?.error?.message || 'send failed' };
  return { ok: true };
}

module.exports = { sendMail };
