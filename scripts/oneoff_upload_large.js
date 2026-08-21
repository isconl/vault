'use strict';
// One-off: upload a large binary file to OneDrive via vault's own Graph
// client + onedrive-browse.uploadLarge (resumable session, for files over
// Graph's 4MB simple-PUT ceiling). Usage:
//   node oneoff_upload_large.js <localFilePath> <folderPath> <fileName>
const fs = require('fs');
const path = require('path');
const secretStore = require('../lib/secrets');
const { createGraphClient } = require('../lib/graph');
const { uploadLarge } = require('../lib/onedrive-browse');

async function main() {
  const [localPath, folderPath, fileName] = process.argv.slice(2);
  if (!localPath || !folderPath || !fileName) {
    console.error('usage: node oneoff_upload_large.js <localFilePath> <folderPath> <fileName>');
    process.exit(1);
  }
  await secretStore.init();
  let graphConfig = {
    clientId: process.env.MSGRAPH_CLIENT_ID || secretStore.get('MSGRAPH_CLIENT_ID') || '',
    clientSecret: process.env.MSGRAPH_CLIENT_SECRET || secretStore.get('MSGRAPH_CLIENT_SECRET') || '',
    refreshToken: process.env.MSGRAPH_REFRESH_TOKEN || secretStore.get('MSGRAPH_REFRESH_TOKEN') || '',
    tenantId: process.env.MSGRAPH_TENANT_ID || secretStore.get('MSGRAPH_TENANT_ID') || '',
  };
  const graph = createGraphClient({
    getConfig: () => graphConfig,
    setConfig: (patch) => { graphConfig = { ...graphConfig, ...patch }; },
    onTokenRefreshed: async (accessToken, refreshToken) => {
      await secretStore.persistSecret('MSGRAPH_REFRESH_TOKEN', refreshToken, 'Rotated by oneoff_upload_large.js on token refresh');
    },
    auditLog: { log: () => {} },
  });
  const buf = fs.readFileSync(path.resolve(localPath));
  console.log(`Uploading ${buf.length} bytes to ${folderPath}/${fileName} ...`);
  const result = await uploadLarge(graph, folderPath, fileName, buf);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
