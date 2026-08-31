'use strict';
/**
 * BI26083004: the BackupTarget interface -- documentation only (no
 * TypeScript in this codebase, no runtime enforcement; a plain JSDoc
 * contract every real implementation must satisfy). `onedrive-target.js`
 * is the one real implementation today; the shape exists as its own file
 * so a future non-OneDrive target (a second cloud, local disk mirror,
 * whatever) has something concrete to match without reverse-engineering
 * onedrive-target.js's internals.
 *
 * @typedef {object} BackupGeneration
 * @property {string} ref - the target's own identifier for this generation (e.g. a filename)
 * @property {string} timestampIso
 * @property {number} sizeBytes
 * @property {string} sha256
 *
 * @typedef {object} BackupTarget
 * @property {(localFilePath: string, meta: object) => Promise<{ok: boolean, ref?: string, error?: string}>} push
 *   Upload the file at localFilePath as a new generation. Never mutates localFilePath.
 * @property {() => Promise<{ok: boolean, generations?: BackupGeneration[], error?: string}>} list
 *   Every generation currently retained, newest first.
 * @property {(ref: string, destPath: string) => Promise<{ok: boolean, path?: string, error?: string}>} fetch
 *   Download one generation to destPath, verified against its own manifest checksum before the caller can trust destPath.
 * @property {(keepPolicy: object) => Promise<{ok: boolean, removed?: string[], error?: string}>} prune
 *   Delete generations outside the retention policy. Returns the refs actually removed.
 */

module.exports = {};
