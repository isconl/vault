'use strict';
/**
 * Library entry point -- for engines that want to import vault's pieces
 * directly (in-process) rather than calling the HTTP service. Both modes
 * are supported deliberately: early in the split, other engines may still
 * run in the same process as vault; later, they call over HTTP via the
 * manifest's capabilities. Neither mode should require different code at
 * the call site beyond how the client is constructed.
 */
const secretStore = require('../lib/secrets');
const { createAuditLog } = require('../lib/audit');
const { createAuthModule } = require('../lib/auth');
const { createVaultStore, defaultSchema } = require('../lib/store');
const { readTSV, appendTSV, rewriteTSV } = require('../lib/tsv');
const { createGraphClient, msGraphTokenExpired } = require('../lib/graph');
const manifest = require('../lib/manifest');

module.exports = {
  secretStore,
  createAuditLog,
  createAuthModule,
  createVaultStore, defaultSchema,
  readTSV, appendTSV, rewriteTSV,
  createGraphClient, msGraphTokenExpired,
  manifest,
};
