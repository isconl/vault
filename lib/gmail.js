'use strict';
/**
 * Gmail wrapper calls on top of google.js's googleRequest -- BM26082011's
 * points 4-5 (deliberately deferred out of BI26082005 since this row is
 * the first real consumer). Three functions: list message ids matching a
 * query, fetch+parse one message, send a reply. No pagination beyond one
 * page (maxResults) -- this is a 5-minute poll job (gmail-sync.js), not a
 * one-time full-mailbox import, so a page per tick is the right shape.
 */

const GMAIL_HOST = 'gmail.googleapis.com';

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** First matching header value, case-insensitive name match (RFC822 headers are case-insensitive). */
function header(headers, name) {
  const h = (headers || []).find(x => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** From: "Display Name <email@x.com>" or bare "email@x.com" -> { name, email }. */
function parseFrom(fromHeader) {
  const m = /^(.*?)<([^>]+)>\s*$/.exec(fromHeader || '');
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '') || m[2].trim(), email: m[2].trim().toLowerCase() };
  const bare = (fromHeader || '').trim();
  return { name: bare, email: bare.toLowerCase() };
}

/** Depth-first search for the first text/plain part; falls back to text/html (tags stripped) if no plain part exists. */
function extractBody(payload) {
  if (!payload) return '';
  const walk = (part, wantType) => {
    if (!part) return null;
    if (part.mimeType === wantType && part.body?.data) return b64urlDecode(part.body.data);
    for (const p of part.parts || []) {
      const found = walk(p, wantType);
      if (found != null) return found;
    }
    return null;
  };
  const plain = walk(payload, 'text/plain');
  if (plain != null) return plain;
  const html = walk(payload, 'text/html');
  if (html != null) return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (payload.body?.data) return b64urlDecode(payload.body.data); // single-part message, no explicit mimeType match needed
  return '';
}

/** List message ids matching a query (default: unread inbox mail only, the normal poll case). */
async function listMessages(google, { query = 'in:inbox', maxResults = 25 } = {}) {
  const res = await google.googleRequest(GMAIL_HOST, `/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
  if (res.status !== 200) return { ok: false, status: res.status, error: res.data?.error?.message || 'list failed' };
  return { ok: true, ids: (res.data.messages || []).map(m => m.id) };
}

/** Fetch and parse one message into the shape gmail-sync.js needs. */
async function getMessage(google, id) {
  const res = await google.googleRequest(GMAIL_HOST, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
  if (res.status !== 200) return { ok: false, status: res.status, error: res.data?.error?.message || 'get failed' };
  const d = res.data;
  const from = parseFrom(header(d.payload?.headers, 'From'));
  return {
    ok: true,
    id: d.id,
    threadId: d.threadId,
    from,
    subject: header(d.payload?.headers, 'Subject') || '(no subject)',
    date: header(d.payload?.headers, 'Date'),
    body: extractBody(d.payload) || d.snippet || '',
  };
}

/** Send a reply (or a fresh message if threadId/inReplyTo are omitted). Builds a minimal RFC822 message -- no attachments, plain text only, matching this row's own scope. */
async function sendMessage(google, { to, subject, body, threadId, inReplyTo } = {}) {
  if (!to) return { ok: false, error: 'to required' };
  const lines = [
    `To: ${to}`,
    `Subject: ${subject || '(no subject)'}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (inReplyTo) { lines.push(`In-Reply-To: ${inReplyTo}`); lines.push(`References: ${inReplyTo}`); }
  lines.push('', body || '');
  const raw = b64urlEncode(lines.join('\r\n'));
  const res = await google.googleRequest(GMAIL_HOST, '/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: { raw, ...(threadId ? { threadId } : {}) },
  });
  if (res.status !== 200) return { ok: false, status: res.status, error: res.data?.error?.message || 'send failed' };
  return { ok: true, id: res.data.id, threadId: res.data.threadId };
}

module.exports = { listMessages, getMessage, sendMessage, parseFrom, extractBody };
