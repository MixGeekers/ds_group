import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeServer, serverOptions } from '../scripts/server-init.mjs';
import { importNodeBundle, nodeBundle } from '../scripts/server-admin.mjs';

test('server initialization survives retries, keeps identity and rejects an incompatible server name', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ds-group-deploy-'));
  try {
    const options = serverOptions({ DS_GROUP_DATA_DIR: path.join(directory, 'core'), DS_GROUP_SYNAPSE_DIR: path.join(directory, 'matrix'),
      DS_GROUP_SERVER_NAME: 'chat.example.com', DS_GROUP_PUBLIC_URL: 'https://chat.example.com', DS_GROUP_MATRIX_PUBLIC_URL: 'https://chat.example.com' });
    await initializeServer(options, { containerOwnership: false });
    const metadata = await readFile(path.join(options.dataRoot, 'server.json'), 'utf8');
    const core = await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8');
    await initializeServer(options, { containerOwnership: false });
    assert.equal(await readFile(path.join(options.dataRoot, 'server.json'), 'utf8'), metadata);
    assert.equal(await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8'), core);
    assert.equal(JSON.parse(core).demoLogin, false);
    await assert.rejects(initializeServer({ ...options, serverName: 'other.example.com' }, { containerOwnership: false }), /Existing Matrix identity/);
    assert.equal(await readFile(path.join(options.dataRoot, 'server.json'), 'utf8'), metadata);
    await initializeServer({ ...options, publicUrl: 'https://new-ui.example.com' }, { containerOwnership: false });
    const next = JSON.parse(await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8'));
    assert.equal(next.nodeSecret, JSON.parse(core).nodeSecret);
    assert.equal(next.publicUrl, 'https://new-ui.example.com');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('remote node export contains only its own Matrix credential and preserves public identities', () => {
  const setup = { serverName: 'chat.example.com', homeserverUrl: 'http://synapse:8008', publicHomeserverUrl: 'https://chat.example.com', roomId: '!shared:chat.example.com', participants: [
    { localpart: 'alice', id: '@alice:chat.example.com', kind: 'human', name: 'Alice', accessToken: 'human-token', password: 'human-password' },
    { localpart: 'finance', id: '@finance:chat.example.com', kind: 'bot', name: 'Finance', ownerId: '@alice:chat.example.com', accessToken: 'finance-token', password: 'finance-password' },
    { localpart: 'hr', id: '@hr:chat.example.com', kind: 'bot', name: 'HR', accessToken: 'hr-token', password: 'hr-password' },
  ] };
  const bundle = nodeBundle(setup, { publicUrl: 'https://chat.example.com', nodeSecret: 'node-secret', modelCallLimit: null, maxOutputTokens: 8192 }, 'finance');
  assert.equal(bundle.setup.homeserverUrl, 'https://chat.example.com');
  assert.equal(bundle.setup.participants[1].accessToken, 'finance-token');
  assert.equal(bundle.setup.participants[1].ownerId, '@alice:chat.example.com');
  assert.ok(!JSON.stringify(bundle).includes('password'));
  assert.ok(!JSON.stringify(bundle).includes('human-token'));
  assert.ok(!JSON.stringify(bundle).includes('hr-token'));
  assert.equal(bundle.setup.participants.length, 3);
  assert.throws(() => nodeBundle(setup, {}, 'alice'), /registered Bot/);
});

test('deployment settings reject malformed origins and server names before creating files', () => {
  assert.throws(() => serverOptions({ DS_GROUP_SERVER_NAME: 'chat.example.com\nother: yes' }), /hostname/);
  assert.throws(() => serverOptions({ DS_GROUP_PUBLIC_URL: 'https://user:password@example.com' }), /origin/);
  assert.throws(() => serverOptions({ DS_GROUP_MATRIX_URL: 'file:///data' }), /origin/);
  assert.throws(() => serverOptions({ DS_GROUP_PUBLIC_URL: 'https://example.com/path' }), /origin/);
});

test('node import can finish a partially written bundle and rejects a conflicting identity before modifying files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ds-group-node-import-'));
  const bundle = { schemaVersion: 1, nodeId: 'finance', coreUrl: 'https://chat.example.com', setup: { participants: [] }, coreConfig: { nodeSecret: 'test-secret' } };
  try {
    await writeFile(path.join(directory, 'matrix-setup.json'), JSON.stringify(bundle.setup));
    await importNodeBundle(bundle, directory);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'core-config.json'), 'utf8')), bundle.coreConfig);
    await importNodeBundle(bundle, directory);
    await assert.rejects(importNodeBundle({ ...bundle, coreConfig: { nodeSecret: 'another-secret' } }, directory), /another node identity/);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'core-config.json'), 'utf8')), bundle.coreConfig);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
