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
    { name: 'onedrive.check', method: 'GET', path: '/onedrive/check', description: 'Read-only: compares one collection\'s real OneDrive copy against the local vault. Changes nothing. Write path not yet implemented.' },
    { name: 'msgraph.auth.start', method: 'POST', path: '/msgraph/auth/start', description: 'Start a Microsoft 365 device-code sign-in: returns a user code and verification URL.' },
    { name: 'msgraph.auth.poll', method: 'POST', path: '/msgraph/auth/poll', description: 'Poll whether a device-code sign-in has been completed yet.' },
  ],
};
