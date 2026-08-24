'use strict';
/**
 * vault's capability manifest -- what this engine can do, for hub (or any
 * orchestrator) to discover without hardcoding knowledge of vault's routes.
 *
 * This is the lightweight stand-in for Decision 003's MCP-server direction:
 * each entry here maps cleanly to what an MCP tool definition would look
 * like (name, description, input shape) without committing to the full
 * MCP wire protocol yet. If/when that migration happens, this is the file
 * that becomes the tool list.
 */
module.exports = {
  engine: 'vault',
  version: require('../package.json').version,
  description: 'Foundation engine: auth/session, TSV vault store, Microsoft Graph client, secrets, AI-provider routing.',
  capabilities: [
    { name: 'auth.totp', method: 'POST', path: '/auth/totp', description: 'Exchange a TOTP code for a session token.' },
    { name: 'auth.pin', method: 'POST', path: '/auth/pin', description: 'Exchange a PIN for a (shorter-lived) session token.' },
    { name: 'auth.verify', method: 'POST', path: '/auth/verify', description: 'Check whether a bearer token/session is currently valid.' },
    { name: 'vault.read', method: 'GET', path: '/vault/:collection', description: 'Read all rows of a TSV collection (e.g. scope/tasks.tsv).' },
    { name: 'vault.append', method: 'POST', path: '/vault/:collection', description: 'Append one row to a TSV collection, bootstrapping the file if needed.' },
    { name: 'vault.rewrite', method: 'PUT', path: '/vault/:collection', description: 'Replace a TSV collection\'s full row set (read-modify-write, for delete/bulk-edit). Refuses to write if the caller drops more than half the rows.' },
    { name: 'vault.bootstrap', method: 'POST', path: '/vault/bootstrap', description: 'Run the full boot-repair sequence (ensure files, migrate columns, self-repair).' },
    { name: 'graph.request', method: 'POST', path: '/graph/request', description: 'Proxy an arbitrary Microsoft Graph API call, paced/retried/token-refreshed.' },
    { name: 'secrets.status', method: 'GET', path: '/secrets/status', description: 'Non-sensitive secrets-sync status (names only, never values).' },
    { name: 'time.now', method: 'GET', path: '/time', description: 'Server epoch milliseconds, for a client to sync a trusted clock against.' },
    { name: 'blocks.plan', method: 'GET', path: '/blocks', description: 'The day-scheduling model: named hour-blocks, the current one, and open tasks classified into them.' },
    { name: 'blocks.save', method: 'POST', path: '/blocks', description: 'Edit one day-block (name/hours/match words/capacity/active).' },
    { name: 'blocks.all', method: 'GET', path: '/blocks/all', description: 'Every day-block on record, active AND inactive -- for a management UI to find a deactivated block and turn it back on. Not for placement/scheduling, which stays active-only via blocks.plan.' },
    { name: 'onedrive.check', method: 'GET', path: '/onedrive/check', description: 'Read-only: compares one collection\'s real OneDrive copy against the local vault. Changes nothing.' },
    { name: 'onedrive.pull', method: 'POST', path: '/onedrive/pull', description: 'Pulls one collection\'s real OneDrive content into the local vault, replacing what\'s there. Local-disk write only -- never writes back to OneDrive.' },
    { name: 'onedrive.push', method: 'POST', path: '/onedrive/push', description: 'Pushes one collection\'s current local content up to OneDrive now, overwriting what\'s there. Every local vault write already does this automatically (SYNC1) -- this is the manual/backfill path.' },
    { name: 'onedrive.sync.status', method: 'GET', path: '/onedrive/sync-status', description: 'Whether the boot-time/interval OneDrive sync loop is running and the result of its last pass (per-collection ok/failed, byte/row counts, timing).' },
    { name: 'onedrive.sync.all', method: 'POST', path: '/onedrive/sync-all', description: 'Force an on-demand full sync pass across every known collection, independent of the interval timer.' },
    { name: 'msgraph.auth.start', method: 'POST', path: '/msgraph/auth/start', description: 'Start a Microsoft 365 device-code sign-in: returns a user code and verification URL.' },
    { name: 'msgraph.auth.poll', method: 'POST', path: '/msgraph/auth/poll', description: 'Poll whether a device-code sign-in has been completed yet.' },
    { name: 'google.auth.start', method: 'POST', path: '/google/auth/start', description: 'Start a Google sign-in (Authorization Code + PKCE -- Google\'s device-code flow does not support Gmail/Calendar scopes) for one account label (body: {account}, defaults to \'default\'): returns a URL to open in a browser and approve.' },
    { name: 'google.auth.callback', method: 'GET', path: '/google/auth/callback', description: 'Public redirect target Google sends the browser back to after consent; resolves which account label the sign-in belongs to and completes the token exchange. Not called directly -- reached only via the authUrl from google.auth.start.' },
    { name: 'google.send', method: 'POST', path: '/google/send', description: 'Send a Gmail message/reply (body: {account, to, subject, body, threadId, inReplyTo, personId}). Plain text only, no attachments. Files the sent copy into scope/inbox.tsv as an outbound row (personId, if given, tags it to that Circle person).' },
    { name: 'google.sync.all', method: 'POST', path: '/google/sync-all', description: 'Force an on-demand Gmail sync pass across every connected account, independent of the interval timer.' },
    { name: 'onedrive.browse.list', method: 'GET', path: '/onedrive/browse', description: 'List one folder anywhere in the connected OneDrive (not just known vault collections) -- the file manager\'s own path space, relative to the drive root.' },
    { name: 'onedrive.browse.item', method: 'GET', path: '/onedrive/item', description: 'One driveItem\'s metadata by id (name, size, lastModifiedDateTime, webUrl, downloadUrl, folder).' },
    { name: 'onedrive.browse.preview', method: 'GET', path: '/onedrive/item-preview', description: 'Item metadata plus text content for previewable file types; metadata only (isText:false) for binary/Office files.' },
    { name: 'onedrive.browse.mkdir', method: 'POST', path: '/onedrive/mkdir', description: 'Create a folder anywhere in the connected OneDrive.' },
    { name: 'onedrive.browse.upload', method: 'POST', path: '/onedrive/upload', description: 'Upload a text file (simple upload, <4MB) to a folder anywhere in the connected OneDrive.' },
    { name: 'onedrive.browse.delete', method: 'POST', path: '/onedrive/item/delete', description: 'Delete an item by id (body: {itemId}) -- moves to the OneDrive recycle bin, recoverable for 30 days.' },
    { name: 'onedrive.browse.move', method: 'POST', path: '/onedrive/move', description: 'Rename and/or move an item by id (same Graph operation, either or both fields).' },
    { name: 'theme.day', method: 'GET', path: '/theme-day', description: 'Today\'s curated theme-day phrase from scope/theme_days.tsv, or {phrase:null} if none written yet for this date -- the client computes a fallback in that case.' },
    { name: 'onthisday', method: 'GET', path: '/onthisday', description: 'What happened on this date, personal record first (dates.tsv/decisions/interactions/tasks/journal/learning/events), falling back to the world-history corpus (history/onthisday.tsv) only when nothing personal is recorded. Optional ?date=YYYY-MM-DD, defaults to today.' },
    { name: 'learning.audio.get', method: 'GET', path: '/learning/audio', description: 'Latest ready narration for one module (?course=&file=): version, voice, duration, a playable url. {ok:false} if none generated yet.' },
    { name: 'learning.audio.generate', method: 'POST', path: '/learning/audio/generate', description: 'Generate (or regenerate, if the module text changed) ElevenLabs narration for one module (body: {course, file}), upload it to OneDrive, and record a new version row. Skips and returns the existing version if the module text is unchanged since the last generation.' },
  ],
};
