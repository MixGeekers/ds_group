import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nodeIdentifier, runtimeSettings, providerConfiguration, resolveDsh, MODEL } from '../scripts/runtime-config.mjs';

const root = path.resolve('runtime-config-fixture');

test('new Bot accounts use independent state and explicit bridge ports', () => {
  const bot = 'bot-f07de111-577b-4f77-b428-a636400f68ce';
  const settings = runtimeSettings(bot, { root, env: { DS_GROUP_BRIDGE_PORT: '23100' } });
  assert.equal(settings.nodeId, bot);
  assert.equal(settings.local, path.join(root, '.local', `dsh-${bot}`));
  assert.equal(settings.port, 23100);
  assert.throws(() => runtimeSettings(bot, { root, env: {} }), /DS_GROUP_BRIDGE_PORT/);
  for (const invalid of ['all', 'core', '../finance', 'BOT', '', undefined]) {
    assert.throws(() => nodeIdentifier(invalid), /local Bot account name/);
  }
});

test('remote node settings consistently place private state beneath a custom data directory', () => {
  const data = path.join(root, 'data');
  const settings = runtimeSettings('finance', { root, env: {
    DS_GROUP_DATA_DIR: data, DS_GROUP_CORE_URL: 'https://group.example/',
    DS_GROUP_FINANCE_PORT: '19091', DS_GROUP_CORE_CONFIG_PATH: path.join(root, 'imported.json'),
    DS_GROUP_DSH_SOURCE_HOME: path.join(root, 'source'), DS_GROUP_DSH_SOURCE_PROFILE: 'web',
  } });
  assert.equal(settings.local, path.join(data, 'dsh-finance'));
  assert.equal(settings.home, path.join(data, 'dsh-finance', 'home'));
  assert.equal(settings.coreUrl, 'https://group.example');
  assert.equal(settings.bridgeUrl, 'http://127.0.0.1:19091');
  assert.equal(settings.coreConfigPath, path.join(root, 'imported.json'));
  assert.equal(settings.sourceProfile, 'web');
});

test('single-node port override and custom local core port are respected', () => {
  const settings = runtimeSettings('hr', { root, env: { DS_GROUP_BRIDGE_PORT: '29092', DS_GROUP_PORT: '28100' } });
  assert.equal(settings.port, 29092);
  assert.equal(settings.coreUrl, 'http://127.0.0.1:28100');
  assert.throws(() => runtimeSettings('hr', { root, env: { DS_GROUP_HR_PORT: '70000' } }), /port between/);
  assert.throws(() => runtimeSettings('hr', { root, env: { DS_GROUP_DSH_SOURCE_PROFILE: '../desktop' } }), /profile name/);
  assert.throws(() => runtimeSettings('hr', { root, env: { DS_GROUP_CORE_URL: 'https://user:secret@example.org/' } }), /without credentials/);
  assert.throws(() => runtimeSettings('hr', { root, env: { DS_GROUP_CORE_URL: 'https://example.org/core' } }), /without a path prefix/);
});

test('explicit opencode key needs no desktop provider and exposes only the allowed model', () => {
  const config = providerConfiguration({ env: { OPENCODE_API_KEY: 'synthetic-key' } });
  assert.equal(config.provider.apiKeyEnv, 'DS_GROUP_OPENCODE_API_KEY');
  assert.deepEqual(config.provider.models, [{ id: MODEL }]);
  assert.equal(config.credentials.refs.DS_GROUP_OPENCODE_API_KEY, 'synthetic-key');
  assert.deepEqual(config.provider.retryPolicy, { mode: 'normal', maxRetries: 0 });
  assert.equal(JSON.stringify(config.provider).includes('synthetic-key'), false);
});

test('desktop provider import narrows model catalog and preserves declared protocol', () => {
  const config = providerConfiguration({ env: {}, sourceProvider: {
    apiKeyEnv: 'EXISTING_KEY', api: 'openai-completions', models: [{ id: 'other' }, { id: MODEL, contextWindow: 1048576 }],
    modelOverrides: { other: {} }, retryPolicy: { maxRetries: 5 },
  }, sourceCredentials: { refs: { EXISTING_KEY: 'synthetic-secret', UNRELATED: 'ignored' } } });
  assert.deepEqual(config.provider.models, [{ id: MODEL, contextWindow: 1048576 }]);
  assert.equal(config.provider.api, 'openai-completions');
  assert.equal(config.provider.modelOverrides, undefined);
  assert.deepEqual(config.credentials.refs, { EXISTING_KEY: 'synthetic-secret' });
});

test('missing or unusable opencode credentials fail before host startup', () => {
  assert.throws(() => providerConfiguration({ env: {} }), /Set OPENCODE_API_KEY/);
  assert.throws(() => providerConfiguration({ env: {}, sourceProvider: { apiKeyEnv: 'MISSING' } }), /reference is unavailable/);
  assert.throws(() => providerConfiguration({ env: { OPENCODE_API_KEY: 'synthetic', DS_GROUP_OPENCODE_BASE_URL: 'file:///tmp/model' } }), /HTTP\(S\)/);
});

test('npm DSH CLI is discovered through PATH and SDK resolves from its real package root', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-cli-'));
  try {
    const installation = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh');
    const bins = path.join(directory, 'node_modules', '.bin');
    await mkdir(path.join(installation, 'lib'), { recursive: true });
    await mkdir(bins, { recursive: true });
    await writeFile(path.join(installation, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
    const cli = path.join(installation, 'lib', 'bin.js');
    await writeFile(cli, '#!/usr/bin/env node\n');
    await chmod(cli, 0o755);
    await symlink(cli, path.join(bins, 'dsh'));
    assert.deepEqual(await resolveDsh({ env: { PATH: bins }, platform: 'linux' }), { cli: await realpath(cli), runtime: await realpath(installation) });
    assert.deepEqual(await resolveDsh({ env: { PATH: '', DS_GROUP_DSH_RUNTIME: directory }, platform: 'linux' }), { cli: await realpath(cli), runtime: directory });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uninstalled DSH and unsupported native Windows lifecycle fail with deployment guidance', async () => {
  await assert.rejects(resolveDsh({ env: { PATH: '' }, platform: 'linux' }), /Install @deepseek-ai\/dsh@0.2.1-rc.5/);
  await assert.rejects(resolveDsh({ env: {}, platform: 'win32' }), /Linux containers or WSL2/);
});
