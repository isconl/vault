'use strict';
/**
 * Pull job: unread inbox mail -> scope/inbox.tsv, per account -- BM26082011.
 * Same PERSON_ID/DIRECTION model BM26081807 established for WhatsApp
 * (circle/lib/chat-import.js), so renderInbox()'s per-person thread view
 * picks these rows up for free. Runs from vault (not circle/scope) because
 * vault already holds the live google.js client instances and every TSV
 * this needs (circle/people.tsv, scope/inbox.tsv) is vault-managed
 * regardless of which engine's server.js declares the route.
 *
 * Person matching is by EMAIL (circle/people.tsv's new column), not
 * WhatsApp's fuzzy display-name match -- a real address is a reliable key
 * an approximate name isn't, and Gmail always hands back a real From
 * address. A sender with no matching person is still filed (PERSON_ID '-'),
 * never dropped -- same "log it, don't lose it" posture as chat-import's
 * own unmatched list.
 */

function findPersonByEmail(people, email) {
  if (!email) return null;
  const needle = email.toLowerCase();
  return people.find(p => (p.EMAIL || '').toLowerCase() === needle) || null;
}

/**
 * @param {object} opts
 * @param {object} opts.google - one google.js client instance (already resolved for the account)
 * @param {object} opts.gmail - the gmail.js module (or a test double)
 * @param {object} opts.store - vault's store (read/rewrite)
 * @param {string} opts.accountLabel - which connected account this is, stamped into SOURCE for dedup across accounts
 * @param {{log:Function}} [opts.auditLog]
 */
async function syncGmailAccount({ google, gmail, store, accountLabel, auditLog = { log: () => {} }, peopleFile = 'circle/people.tsv', inboxFile = 'scope/inbox.tsv', query = 'in:inbox is:unread' }) {
  const listed = await gmail.listMessages(google, { query });
  if (!listed.ok) {
    auditLog.log('gmail_sync_list_failed', { account: accountLabel, error: listed.error });
    return { ok: false, account: accountLabel, error: listed.error };
  }
  if (!listed.ids.length) return { ok: true, account: accountLabel, newMessages: 0 };

  const people = store.read(peopleFile);
  const existingInbox = store.read(inboxFile);
  const seenSources = new Set(existingInbox.map(r => r.SOURCE));
  let nextIdNum = existingInbox.reduce((n, r) => Math.max(n, parseInt(String(r.ID).replace(/\D/g, ''), 10) || 0), 0);

  const newRows = [];
  for (const id of listed.ids) {
    const source = `gmail:${accountLabel}:${id}`;
    if (seenSources.has(source)) continue; // already pulled a prior tick
    const msg = await gmail.getMessage(google, id);
    if (!msg.ok) { auditLog.log('gmail_sync_get_failed', { account: accountLabel, id, error: msg.error }); continue; }

    const person = findPersonByEmail(people, msg.from.email);
    nextIdNum += 1;
    seenSources.add(source);
    newRows.push({
      ID: `I${String(nextIdNum).padStart(3, '0')}`,
      TITLE: msg.subject,
      BODY: msg.body || '-',
      STATUS: 'new',
      SOURCE: source,
      CAPTURED_AT: new Date().toISOString().slice(0, 10),
      CHANNEL: 'gmail',
      // "Name <email>" when a display name exists (parseable back out by
      // gmail.js's own parseFrom -- inboxSendGmailReply in app.js does
      // exactly that to recover a real address to reply to), bare email
      // otherwise. Never just the display name alone: that would make an
      // inline reply impossible to address without a second Gmail lookup.
      SENDER: msg.from.name && msg.from.name !== msg.from.email ? `${msg.from.name} <${msg.from.email}>` : msg.from.email,
      SUBJECT: msg.subject,
      RECEIVED_AT: msg.date || '-',
      TAG: '-', COMMENT: '-',
      PERSON_ID: person ? person.ID : '-',
      DIRECTION: 'in',
    });
  }

  if (newRows.length) {
    store.rewrite(inboxFile, (rows) => [...rows, ...newRows]);
  }
  auditLog.log('gmail_sync_pass', { account: accountLabel, newMessages: newRows.length, unmatched: newRows.filter(r => r.PERSON_ID === '-').length });
  return { ok: true, account: accountLabel, newMessages: newRows.length };
}

/**
 * Interval loop over every connected Google account -- same start/stop/
 * runOnce shape as backup-loop.js's createBackupLoop (was sync-loop.js's
 * createSyncLoop before BI26083005 retired it), kept as its own small
 * loop rather than folded into that one since this polls a completely
 * different set of accounts/APIs on its own cadence (EMAIL_SYNC_INTERVAL_MS,
 * independent of VAULT_BACKUP_INTERVAL_MS).
 *
 * @param {Map<string,object>} opts.googleClients - account label -> google.js client instance
 * @param {object} opts.gmail - the gmail.js module (or a test double)
 * @param {object} opts.store
 * @param {{log:Function}} [opts.auditLog]
 */
function createGmailSyncLoop({ googleClients, gmail, store, auditLog = { log: () => {} } }) {
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) return { skipped: 'already running' };
    running = true;
    const results = [];
    try {
      for (const [accountLabel, google] of googleClients.entries()) {
        try {
          results.push(await syncGmailAccount({ google, gmail, store, accountLabel, auditLog }));
        } catch (e) {
          results.push({ ok: false, account: accountLabel, error: String(e.message || e).slice(0, 200) });
        }
      }
    } finally {
      running = false;
    }
    return results;
  }

  function start(intervalMs) {
    if (timer) return;
    runOnce().catch((e) => auditLog.log('gmail_sync_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    timer = setInterval(() => {
      runOnce().catch((e) => auditLog.log('gmail_sync_pass_failed', { error: String(e.message || e).slice(0, 200) }));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, isRunning: () => running };
}

module.exports = { syncGmailAccount, findPersonByEmail, createGmailSyncLoop };
