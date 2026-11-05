import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AccountService } from '../src/accounts.mjs';
import { IdentityService, validateIdentityOptions } from '../src/identity.mjs';
import { readOptionalJson, savePrivateJson } from './server-init.mjs';

/** Select this deployment as a default home without replacing its Matrix identity. */
export async function initializeCentralIdentity({ dataRoot, coreUrl, matrixUrl, clientOrigins = [] }) {
  const identity = validateIdentityOptions({ mode: 'central', coreUrl, matrixUrl, clientOrigins });
  if (!identity.coreUrl || !identity.matrixUrl) throw new Error('Central identity requires explicit Core and Matrix public URLs');
  const metadata = await readOptionalJson(path.join(dataRoot, 'server.json'));
  if (!metadata?.serverName || !metadata.homeserverUrl) throw new Error('Run server-init with the permanent Matrix server name first');
  const corePath = path.join(dataRoot, 'core-config.json');
  const core = await readOptionalJson(corePath);
  if (!core?.nodeSecret) throw new Error('Run server-init before central-init');
  const setupPath = path.join(dataRoot, 'matrix-setup.json');
  const existing = await readOptionalJson(setupPath);
  if (existing && existing.serverName !== metadata.serverName) throw new Error('Existing account registry belongs to another Matrix home');
  const setup = existing || { serverName: metadata.serverName, homeserverUrl: metadata.homeserverUrl,
    publicHomeserverUrl: identity.matrixUrl, deploymentMode: 'server', roomId: null, participants: [] };
  const config = { ...core, publicUrl: identity.coreUrl, identity, demoLogin: false };
  const accounts = await new AccountService({ setup, config, dataRoot }).initialize();
  try {
    const service = await new IdentityService({ accounts, setup, config, dataRoot }).initialize();
    if (!existing) await savePrivateJson(setupPath, setup);
    await savePrivateJson(corePath, config);
    return { ...service.discovery(), reusedMatrixRegistry: Boolean(existing), registeredAccounts: accounts.publicParticipants().length };
  } finally { accounts.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { values } = parseArgs({ options: {
    'data-dir': { type: 'string', default: process.env.DS_GROUP_DATA_DIR || '.local/server' },
    'core-url': { type: 'string' }, 'matrix-url': { type: 'string' }, 'client-origin': { type: 'string', multiple: true, default: [] },
  } });
  console.log(JSON.stringify(await initializeCentralIdentity({ dataRoot: path.resolve(values['data-dir']), coreUrl: values['core-url'],
    matrixUrl: values['matrix-url'], clientOrigins: values['client-origin'] }), null, 2));
}
