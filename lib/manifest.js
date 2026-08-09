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
    { name: 'vault.bootstrap', method: 'POST', path: '/vault/bootstrap', description: 'Run the full boot-repair sequence (ensure files, migrate columns, self-repair).' },
    { name: 'graph.request', method: 'POST', path: '/graph/request', description: 'Proxy an arbitrary Microsoft Graph API call, paced/retried/token-refreshed.' },
    { name: 'secrets.status', method: 'GET', path: '/secrets/status', description: 'Non-sensitive secrets-sync status (names only, never values).' },
  ],
};
