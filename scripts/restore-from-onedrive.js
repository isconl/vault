#!/usr/bin/env node
'use strict';
/**
 * One-off restore counterpart to lib/backup/onedrive-target.js's push().
 * That module already has list()/fetch() primitives (BI26083004) but no
 * script ever wired them up -- every generation to date has only been
 * written, never read back. This is the first exercise of the restore
 * path, written to provision a fresh machine (BI26090901's Windows port)
 * from the real OneDrive backup instead of starting from an empty schema.
 *
 * Deliberately does NOT touch the live memory/vault.db itself -- fetch()
 * only writes to the --out path. Stopping the engine, staging the swap,
 * and restarting is left to the operator (see the printed instructions),
 * matching CLAUDE.md's copy-verify-then-remove discipline rather than
 * silently replacing a running engine's open DB file out from under it.
 *
 * Usage:
 *   node scripts/restore-from-onedrive.js --list
 *   node scripts/restore-from-onedrive.js --restore latest --out memory/vault.db.restored
 *   node scripts/restore-from-onedrive.js --restore vault-20260908T120000Z.db --out memory/vault.db.restored
 */

const fs = require('fs');
const path = require('path');
const secrets = require('../lib/secrets');
const { createGraphClient } = require('../lib/graph');
const { createOneDriveBackupTarget, BACKUP_FOLDER } = require('../lib/backup/onedrive-target');
const onedriveBrowse = require('../lib/onedrive-browse');

async function main() {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const restoreIdx = args.indexOf('--restore');
  const restoreRef = restoreIdx !== -1 ? args[restoreIdx + 1] : null;
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? args[outIdx + 1] : null;

  if (!list && !restoreRef) {
    console.error('Usage: --list | --restore <ref|latest> --out <path>');
    process.exit(1);
  }
  if (restoreRef && !outPath) {
    console.error('--restore requires --out <path>');
    process.exit(1);
  }

  await secrets.init({ startRefreshLoop: false });

  let graphConfig = {
    clientId: process.env.MSGRAPH_CLIENT_ID || secrets.get('MSGRAPH_CLIENT_ID') || '',
    clientSecret: process.env.MSGRAPH_CLIENT_SECRET || secrets.get('MSGRAPH_CLIENT_SECRET') || '',
    accessToken: process.env.MSGRAPH_ACCESS_TOKEN || '',
    refreshToken: secrets.get('MSGRAPH_REFRESH_TOKEN') || '',
    tenantId: process.env.MSGRAPH_TENANT_ID || secrets.get('MSGRAPH_TENANT_ID') || '',
  };
  const graph = createGraphClient({
    getConfig: () => graphConfig,
    setConfig: (patch) => { graphConfig = { ...graphConfig, ...patch }; },
    onTokenRefreshed: async () => {}, // read-only tool -- deliberately does not persist a rotated token
  });

  const target = createOneDriveBackupTarget({ graph });

  const listRes = await target.list();
  if (!listRes.ok) {
    console.error('list() failed:', listRes.error || JSON.stringify(listRes));
    process.exit(1);
  }
  if (!listRes.generations.length) {
    console.error('No generations found in the backup folder.');
    process.exit(1);
  }

  if (list) {
    for (const g of listRes.generations) {
      console.log(`${g.ref}  ${g.timestampIso}  ${g.sizeBytes} bytes  sha256:${g.sha256.slice(0, 12)}...`);
    }
    process.exit(0);
  }

  const gen = restoreRef === 'latest' ? listRes.generations[0] : listRes.generations.find((g) => g.ref === restoreRef);
  if (!gen) {
    console.error(`No generation matching ref "${restoreRef}". Run --list to see available refs.`);
    process.exit(1);
  }

  console.log(`Fetching ${gen.ref} (${gen.timestampIso}, ${gen.sizeBytes} bytes)...`);
  const dest = path.resolve(outPath);
  const fetchRes = await target.fetch(gen.ref, dest);
  if (!fetchRes.ok) {
    console.error('fetch() failed:', fetchRes.error || JSON.stringify(fetchRes));
    process.exit(1);
  }
  console.log(`OK: verified sha256 and wrote ${fetchRes.path}`);

  // BI26083007: the encryption key is scrypt(dbKeyPassphrase, salt) -- the
  // salt travels in the manifest as saltHex (backup-loop.js), not as a
  // separate file upload. Without it, the restored DB decrypts with the
  // wrong key and better-sqlite3 reports "file is not a database".
  const stem = gen.ref.replace(/\.db$/, '');
  const folderRes = await onedriveBrowse.listFolder(graph, BACKUP_FOLDER);
  const manifestItem = folderRes.ok && folderRes.items.find((i) => i.name === `${stem}.manifest.json`);
  let saltHex = null;
  if (manifestItem) {
    const preview = await onedriveBrowse.getItemPreview(graph, manifestItem.id);
    if (preview.ok && preview.isText) {
      try { saltHex = JSON.parse(preview.textContent).saltHex || null; } catch { /* leave null */ }
    }
  }
  if (saltHex) {
    const saltOutPath = path.join(path.dirname(dest), '.db-salt.restored');
    fs.writeFileSync(saltOutPath, Buffer.from(saltHex, 'hex'));
    console.log(`OK: wrote matching salt to ${saltOutPath} (from manifest saltHex)`);
    console.log('Move BOTH this file (-> .db-salt) and the restored DB into memory/ together --');
    console.log('the DB alone will fail to decrypt (SQLITE_NOTADB) without its matching salt.');
  } else {
    console.log('WARNING: manifest has no saltHex -- this generation predates BI26083007, or the');
    console.log('manifest could not be read. The restored DB will NOT decrypt without the salt');
    console.log('that was in place on the machine that pushed it.');
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
