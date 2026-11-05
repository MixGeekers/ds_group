import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { AccountService } from '../src/accounts.mjs';
import { NodeCredentials } from '../src/node-auth.mjs';
import { packageRoot } from '../src/paths.mjs';

const execute = promisify(execFile);
const serverName = 'admin.test';
const ownerId = `@alice:${serverName}`;
const legacySecret = 'synthetic-admin-legacy-secret';

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'dscord-server-admin-'));
  const setup = { serverName, homeserverUrl: 'http://matrix.invalid', publicHomeserverUrl: 'https://matrix.admin.test',
    roomId: `!initial:${serverName}`, participants: [
      { id: ownerId, localpart: 'alice', name: 'Alice', kind: 'human', password: 'synthetic-legacy-password', accessToken: 'synthetic-human-token' },
    ] };
  const config = { nodeSecret: legacySecret, publicUrl: 'https://core.admin.test', modelCallLimit: null, maxOutputTokens: 8192 };
  await writeFile(path.join(dataRoot, 'matrix-setup.json'), JSON.stringify(setup));
  await writeFile(path.join(dataRoot, 'core-config.json'), JSON.stringify(config));
  const accounts = await new AccountService({ setup, config, dataRoot, registrationSecret: 'synthetic-registration-secret',
    clientFactory: () => ({ async request(method, route, input) {
      if (route === '/_synapse/admin/v1/register' && method === 'GET') return { nonce: 'nonce' };
      if (route === '/_synapse/admin/v1/register') return { user_id: `@${input.username}:${serverName}`, access_token: `synthetic-token-${input.username}` };
      if (route.includes('/profile/')) return {};
      throw new Error(`Unexpected Matrix fixture request ${route}`);
    } }),
  }).initialize();
  const credentials = await new NodeCredentials({ dataRoot, setup, legacySecret }).initialize();
  t.after(async () => { await credentials.close(); accounts.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const env = { ...process.env, DS_GROUP_DATA_DIR: dataRoot };
  delete env.DS_GROUP_MATRIX_SETUP_PATH;
  delete env.DS_GROUP_CORE_CONFIG_PATH;
  return { dataRoot, setup, accounts, credentials, env, async run(...args) {
    const result = await execute(process.execPath, [path.join(packageRoot, 'scripts/server-admin.mjs'), ...args], {
      cwd: dataRoot, env, timeout: 15_000,
    });
    return JSON.parse(result.stdout);
  } };
}

test('CLI exports dynamic Bot accounts with immediately visible scoped credentials across processes', async t => {
  const f = await fixture(t);
  const bot = await f.accounts.createBot(ownerId, { name: 'New helper', requestId: 'helper' });
  const other = await f.accounts.createBot(ownerId, { name: 'Other helper', requestId: 'other' });
  const savedSetup = JSON.parse(await readFile(path.join(f.dataRoot, 'matrix-setup.json'), 'utf8'));
  assert.equal(savedSetup.participants.some(person => person.id === bot.id), false);
  const [bundle, repeated, otherBundle] = await Promise.all([
    f.run('export-node', bot.localpart), f.run('export-node', bot.localpart), f.run('export-node', other.localpart),
  ]);
  assert.equal(bundle.coreConfig.nodeSecret === legacySecret, false);
  assert.equal(bundle.coreConfig.nodeSecret === repeated.coreConfig.nodeSecret, true);
  assert.equal(bundle.coreConfig.nodeSecret === otherBundle.coreConfig.nodeSecret, false);
  assert.equal(bundle.nodeId, bot.localpart);
  assert.equal(bundle.setup.participants.find(person => person.id === bot.id).ownerId, ownerId);
  assert.equal(bundle.setup.participants.filter(person => person.accessToken).length, 1);
  assert.equal(bundle.setup.participants.find(person => person.accessToken).id, bot.id);
  assert.equal(JSON.stringify(bundle).includes('synthetic-human-token'), false);
  assert.equal(JSON.stringify(bundle).includes('synthetic-legacy-password'), false);
  assert.deepEqual(f.credentials.authorize({ headers: { authorization: `Bearer ${bundle.coreConfig.nodeSecret}` } }),
    { botId: bot.id, nodeId: bot.localpart });
  assert.deepEqual(f.credentials.authorize({ headers: { authorization: `Bearer ${otherBundle.coreConfig.nodeSecret}` } }),
    { botId: other.id, nodeId: other.localpart });
  const reopened = await f.run('export-node', bot.localpart);
  assert.equal(reopened.coreConfig.nodeSecret === bundle.coreConfig.nodeSecret, true);
});

test('the credentials CLI retains the historical synthetic human password lookup', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run('credentials', 'alice'), { user: ownerId, password: 'synthetic-legacy-password' });
});

test('node export honors the same external JSON configuration paths as Core', async t => {
  const f = await fixture(t);
  const bot = await f.accounts.createBot(ownerId, { name: 'External config helper', requestId: 'external-config' });
  for (const [key, name] of [['DS_GROUP_MATRIX_SETUP_PATH', 'matrix-setup.json'], ['DS_GROUP_CORE_CONFIG_PATH', 'core-config.json']]) {
    f.env[key] = path.join(f.dataRoot, `mounted-${name}`);
    await writeFile(f.env[key], await readFile(path.join(f.dataRoot, name)));
    await rm(path.join(f.dataRoot, name));
  }
  const bundle = await f.run('export-node', bot.localpart);
  assert.equal(bundle.nodeId, bot.localpart);
  assert.deepEqual(f.credentials.authorize({ headers: { authorization: `Bearer ${bundle.coreConfig.nodeSecret}` } }),
    { botId: bot.id, nodeId: bot.localpart });
});
