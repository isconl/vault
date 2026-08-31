'use strict';
/**
 * BI26083005: extracted from sync-loop.js (retired along with the
 * pull-based OneDrive sync it drove) -- these two lists are permanent
 * config data (which collections exist outside default-schema.js's
 * declared set), not sync machinery, and vault/scripts/migrate-tsv-to-sqlite.js
 * still needs them to know the FULL set of collections to migrate.
 */

// finance/*.tsv collections default-schema.js doesn't declare -- the
// "unowned" set from the original migration brief's section 7, confirmed
// 2026-08-14.
const EXTRA_FINANCE_TSV = [
  'finance/moves.tsv', 'finance/budget_items.tsv', 'finance/vendors.tsv',
  'finance/vendor_map.tsv', 'finance/places.tsv', 'finance/prices.tsv',
  'finance/wishlist.tsv',
];

// Non-TSV state files (JSON/YAML) that aren't schema-declared TSVs either.
const RAW_COLLECTIONS = [
  'scope/calendar_events.json', 'scope/task_briefs.json', 'scope/task_drafts.json',
  'circle/reachouts.json', 'personal/rhythm.json',
  'scope/identity.yaml', 'identity/identity.yaml',
];

module.exports = { EXTRA_FINANCE_TSV, RAW_COLLECTIONS };
