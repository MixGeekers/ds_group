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

test('legacy explicit opencode environment remains usable for existing deployments', () => {
  const config = providerConfiguration({ env: { OPENCODE_API_KEY: 'synthetic-key' } });
  assert.equal(config.selection.model, `opencode-go/${MODEL}`);
  assert.deepEqual(config.provider.models, [{ id: MODEL }]);
  assert.equal(config.credentials.refs.DSCORD_NODE_MODEL_API_KEY, 'synthetic-key');
  assert.equal(JSON.stringify(config.provider).includes('synthetic-key'), false);
});

test('imports native model catalogs, overrides and provider options without mutating the source', () => {
  const provider = { apiKeyEnv: 'EXISTING_KEY', api: 'openai-completions', modelOverrides: { 'team-chat': { contextWindow: 65536 } },
    retryPolicy: { mode: 'normal', maxRetries: 5 }, headers: { 'X-Route': 'team' }, transport: 'sse' };
  const original = structuredClone(provider);
  const config = providerConfiguration({ env: {}, sourceProviders: { openai: provider },
    sourceSelection: { model: 'openai/team-chat', reasoningEffort: 'high', maxTokens: 5000 },
    sourceCredentials: { refs: { EXISTING_KEY: 'synthetic-secret', UNRELATED: 'ignored' } } });
  assert.deepEqual(config.provider, provider);
  assert.deepEqual(provider, original);
  assert.deepEqual(config.credentials.refs, { EXISTING_KEY: 'synthetic-secret' });
  assert.deepEqual(config.selection, { model: 'openai/team-chat', maxTokens: 5000, reasoningEffort: 'high' });
});

test('explicit model wins over a saved node and a saved node wins over a changed profile default', () => {
  const options = { sourceProviders: { first: {}, second: {} },
    previousSelection: { model: 'first/old', reasoningEffort: 'low', maxTokens: 1024 }, sourceSelection: { model: 'second/new' } };
  assert.deepEqual(providerConfiguration({ ...options, env: {} }).selection, options.previousSelection);
  assert.deepEqual(providerConfiguration({ ...options, env: { DS_GROUP_MODEL: 'second/new' } }).selection,
    { model: 'second/new', maxTokens: 4096 });
});

test('custom endpoints and model IDs containing slashes use the selected protocol and scoped key', () => {
  const config = providerConfiguration({ env: { DS_GROUP_MODEL: 'my-provider/team/model-v2', DS_GROUP_MAX_OUTPUT_TOKENS: '16000' },
    sourceProviders: { 'my-provider': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9901/v1',
      models: [{ id: 'team/model-v2' }], apiKeyEnv: 'SOURCE_KEY' } }, sourceCredentials: { refs: { SOURCE_KEY: 'synthetic' } } });
  assert.equal(config.providerId, 'my-provider');
  assert.deepEqual(config.provider.models, [{ id: 'team/model-v2' }]);
  assert.equal(config.provider.baseURL, 'http://127.0.0.1:9901/v1');
  assert.equal(config.selection.maxTokens, 16000);
  assert.equal(config.provider.api, 'openai-completions');
});

test('selected native auth records and explicitly named ambient references are copied privately', () => {
  const record = { kind: 'grant', payload: { type: 'oauth', refresh: 'synthetic' } };
  const config = providerConfiguration({ env: {}, sourceProviders: { native: {} }, sourceSelection: { model: 'native/one' },
    sourceCredentials: { records: { 'llm-pi-ai/native': record, 'llm-pi-ai/other': record }, refs: { NATIVE_ENV: 'one', OTHER: 'two' } },
    sourceCredentialRefs: ['NATIVE_ENV'] });
  assert.deepEqual(config.credentials.records, { 'llm-pi-ai/native': record });
  assert.deepEqual(config.credentials.refs, { NATIVE_ENV: 'one' });
});

test('environment references and unauthenticated custom providers are supported', () => {
  const options = { sourceProviders: { local: { api: 'openai-completions', baseURL: 'http://127.0.0.1:9901/v1', models: [{ id: 'one' }] } },
    sourceSelection: { model: 'local/one' } };
  assert.deepEqual(providerConfiguration({ ...options, env: {} }).credentials.refs, {});
  options.sourceProviders.local.apiKeyEnv = 'LOCAL_KEY';
  assert.equal(providerConfiguration({ ...options, env: { LOCAL_KEY: 'synthetic' } }).credentials.refs.LOCAL_KEY, 'synthetic');
});

test('missing credentials and unconfigured models fail before changing profiles', () => {
  assert.throws(() => providerConfiguration({ env: {} }), { code: 'INVALID_MODEL' });
  assert.throws(() => providerConfiguration({ env: { DS_GROUP_MODEL: 'unknown/one' } }), { code: 'MODEL_PROVIDER_UNAVAILABLE' });
  const options = { env: {}, sourceProviders: { configured: { apiKeyEnv: 'MISSING', models: [{ id: 'one' }] } }, sourceSelection: { model: 'configured/one' } };
  assert.throws(() => providerConfiguration(options), { code: 'MISSING_CREDENTIAL' });
  assert.throws(() => providerConfiguration({ ...options, env: { DS_GROUP_MODEL: 'configured/missing' } }), { code: 'MODEL_UNAVAILABLE' });
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
