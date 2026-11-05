import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeServer, serverOptions } from '../scripts/server-init.mjs';

const fixture = {
  DS_GROUP_MEDIA_BACKEND: 's3', DS_GROUP_S3_BUCKET: 'synthetic-media',
  DS_GROUP_S3_ENDPOINT: 'http://s3-fixture:8080', DS_GROUP_S3_REGION: 'auto',
  DS_GROUP_S3_ACCESS_KEY_ID: 'synthetic-access', DS_GROUP_S3_SECRET_ACCESS_KEY: 'synthetic-secret',
  DS_GROUP_S3_SESSION_TOKEN: 'synthetic-session', DS_GROUP_S3_PREFIX: 'attachments',
};

test('media backend defaults to local and preserves an explicit S3 destination across initialization', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dscord-storage-config-'));
  const env = { DS_GROUP_DATA_DIR: path.join(directory, 'core'), DS_GROUP_SYNAPSE_DIR: path.join(directory, 'matrix') };
  const options = serverOptions(env);
  const configPath = path.join(options.synapseRoot, 'homeserver.yaml');
  const storagePath = path.join(options.dataRoot, 'media-storage.json');
  try {
    assert.equal((await initializeServer(options, { containerOwnership: false })).mediaBackend, 'local');
    assert.equal(JSON.parse(await readFile(configPath)).media_storage_providers, undefined);
    // Legacy deployments predate the private storage selection file.
    await rm(storagePath);
    await initializeServer(options, { containerOwnership: false });
    assert.deepEqual(JSON.parse(await readFile(storagePath)), { backend: 'local' });
    const result = await initializeServer(serverOptions({ ...env, ...fixture }), { containerOwnership: false });
    const configured = await readFile(configPath, 'utf8');
    const provider = JSON.parse(configured).media_storage_providers[0];
    assert.equal(provider.module, 's3_storage_provider.S3StorageProviderBackend');
    assert.equal(provider.store_synchronous, true);
    assert.equal(provider.store_local, true);
    assert.equal(provider.config.prefix, 'attachments/');
    assert.equal(provider.config.region_name, 'auto');
    for (const secret of [fixture.DS_GROUP_S3_ACCESS_KEY_ID, fixture.DS_GROUP_S3_SECRET_ACCESS_KEY, fixture.DS_GROUP_S3_SESSION_TOKEN]) {
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal((await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8')).includes(secret), false);
    }
    await initializeServer(options, { containerOwnership: false });
    assert.equal(await readFile(configPath, 'utf8'), configured);
    assert.equal((await stat(storagePath)).mode & 0o777, 0o600);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const metadata = await readFile(path.join(options.dataRoot, 'server.json'), 'utf8');
    for (const changes of [{ DS_GROUP_MEDIA_BACKEND: 'local' }, { DS_GROUP_S3_BUCKET: 'another-bucket' }, { DS_GROUP_S3_PREFIX: 'other/' }, { DS_GROUP_S3_ENDPOINT: 'https://elsewhere.example' }]) {
      await assert.rejects(initializeServer(serverOptions({ ...env, ...fixture, ...changes }), { containerOwnership: false }), /explicit migration/);
      assert.equal(await readFile(configPath, 'utf8'), configured);
      assert.equal(await readFile(path.join(options.dataRoot, 'server.json'), 'utf8'), metadata);
    }
    await initializeServer(serverOptions({ ...env, ...fixture, DS_GROUP_S3_SECRET_ACCESS_KEY: 'rotated-synthetic-secret' }), { containerOwnership: false });
    assert.equal(JSON.parse(await readFile(configPath)).media_storage_providers[0].config.secret_access_key, 'rotated-synthetic-secret');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('S3 configuration rejects invalid fields without exposing submitted credentials', () => {
  for (const change of [
    { DS_GROUP_MEDIA_BACKEND: 'drive' }, { DS_GROUP_S3_BUCKET: '' },
    { DS_GROUP_S3_ACCESS_KEY_ID: '' }, { DS_GROUP_S3_SECRET_ACCESS_KEY: '' },
    { DS_GROUP_S3_ENDPOINT: 'https://synthetic-access:synthetic-secret@example.test' },
    { DS_GROUP_S3_ENDPOINT: 'file:///data' }, { DS_GROUP_S3_ENDPOINT: 'https://example.test/path' },
    { DS_GROUP_S3_PREFIX: '../media' }, { DS_GROUP_S3_PREFIX: '/absolute' }, { DS_GROUP_S3_REGION: 'auto\nvalue' },
  ]) {
    assert.throws(() => serverOptions({ ...fixture, ...change }), error => {
      assert.equal(error.message.includes('synthetic-secret'), false);
      assert.equal(error.message.includes('synthetic-access'), false);
      return true;
    });
  }
  assert.equal(serverOptions({ DS_GROUP_MEDIA_BACKEND: 'local', DS_GROUP_S3_SECRET_ACCESS_KEY: 'ignored' }).mediaStorage.backend, 'local');
});

test('invalid persisted media settings fail before rewriting the active configuration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dscord-storage-invalid-'));
  const options = serverOptions({ DS_GROUP_DATA_DIR: path.join(directory, 'core'), DS_GROUP_SYNAPSE_DIR: path.join(directory, 'matrix') });
  try {
    await initializeServer(options, { containerOwnership: false });
    const configPath = path.join(options.synapseRoot, 'homeserver.yaml');
    const before = await readFile(configPath, 'utf8');
    await writeFile(path.join(options.dataRoot, 'media-storage.json'), JSON.stringify({ backend: 's3', bucket: 'missing-credentials' }));
    await assert.rejects(initializeServer(options, { containerOwnership: false }), /required together/);
    assert.equal(await readFile(configPath, 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
