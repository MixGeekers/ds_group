import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelReference, modelSelection, checkModel } from '../src/model-config.mjs';
import { ModelBudget } from '../src/budget.mjs';
import { DshModels } from '../dsh-connect/models.mjs';

test('model references preserve native namespaced model IDs and reject malformed identities', () => {
  assert.deepEqual(modelReference('provider/team/model:latest'), { provider: 'provider', model: 'team/model:latest' });
  for (const value of ['', null, 5, '/one', 'one/', 'one', 'p/a\nb', 'p/a b', 'p/'.padEnd(513, 'a')]) {
    assert.throws(() => modelReference(value), { code: 'INVALID_MODEL', status: 400 });
  }
  assert.deepEqual(modelSelection({ model: 'p/a' }), { model: 'p/a', maxTokens: 4096 });
  for (const maxTokens of [0, -1, 0.5, '1024', Infinity]) assert.throws(() => modelSelection({ model: 'p/a', maxTokens }), { code: 'INVALID_OUTPUT_LIMIT' });
});

test('core policy is optional and accounting preserves each exact model across policy changes and restarts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-model-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'budget.sqlite');
  let ledger = new ModelBudget(filename, { limit: 4 });
  const request = { nodeId: 'one', requestId: 'old', maxTokens: 100, model: 'opencode-go/deepseek-v4.1-flash' };
  const legacy = ledger.claim(request);
  ledger.complete({ claimId: legacy.claimId, status: 'unknown' });
  ledger.close();
  ledger = new ModelBudget(filename, { allowedModels: ['custom/team/model', 'other/two'] });
  try {
    assert.throws(() => ledger.claim(request), { status: 403 });
    for (const model of ['custom/team/model', 'other/two']) ledger.claim({ ...request, model, requestId: model });
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.used, 3);
    assert.equal(snapshot.remaining, 1);
    assert.equal(snapshot.model, null);
    assert.deepEqual(snapshot.models, [request.model, 'custom/team/model', 'other/two']);
    assert.equal(snapshot.claims[0].status, 'unknown');
  } finally { ledger.close(); }
  ledger = new ModelBudget(filename);
  try {
    assert.equal(ledger.snapshot().allowedModels, null);
    ledger.claim({ ...request, model: 'third/three' });
    assert.throws(() => ledger.claim(request), { status: 429 });
  } finally { ledger.close(); }
});

function host() {
  const profiles = {
    local: { api: 'openai-completions', baseURL: 'http://localhost:9991/v1', models: [{ id: 'team/chat' }, { id: 'other' }],
      apiKeyEnv: 'LOCAL_KEY', headers: { 'X-Route': 'synthetic' }, retryPolicy: { mode: 'normal', maxRetries: 3 } },
    missing: { apiKeyEnv: 'MISSING', models: [{ id: 'chat' }] },
  };
  const refs = { LOCAL_KEY: 'synthetic-secret', UNRELATED: 'private-unrelated' };
  const services = {
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] },
    credentials: {
      describe: async ref => ({ configured: Boolean(refs[ref]), writable: true }),
      resolve: async ref => refs[ref] ? { value: refs[ref] } : undefined,
      readRecord: async () => undefined,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'local', model: 'team/chat', reasoningEffort: 'high' }) },
  };
  const llm = {
    listProviders: () => Object.keys(profiles).map(id => ({ id })),
    listModels: async id => profiles[id].models,
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
    listConfigurableProviders: () => Object.keys(profiles).map(provider => ({ provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] })),
  };
  return { profiles, refs, llm, models: new DshModels({ llm, get: key => services[key] }) };
}

test('DSH model selection uses native catalog, native thinking levels and reports safe credential status', async () => {
  const { models, profiles } = host();
  const view = await models.view();
  assert.equal(view.providers[0].credential, 'configured');
  assert.equal(view.providers[1].credential, 'missing');
  assert.equal(JSON.stringify(view).includes('synthetic-secret'), false);
  assert.equal(JSON.stringify(view).includes('LOCAL_KEY'), false);
  const exported = await models.export();
  assert.deepEqual(exported.selection, { model: 'local/team/chat', reasoningEffort: 'high', maxTokens: 4096 });
  assert.deepEqual(exported.providers, { local: profiles.local });
  assert.deepEqual(exported.credentials.refs, { LOCAL_KEY: 'synthetic-secret' });
  await assert.rejects(models.export({ model: 'missing/chat' }), { code: 'MISSING_CREDENTIAL' });
  await assert.rejects(models.export({ model: 'local/missing' }), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(models.export({ model: 'local/team/chat', reasoningEffort: 'low' }), { code: 'INVALID_REASONING_EFFORT' });
});

test('unavailable native catalogs fail closed before a ledger claim or stream', async () => {
  const { llm } = host();
  await assert.rejects(checkModel(llm, { model: 'unconfigured/chat' }), { code: 'MODEL_PROVIDER_UNAVAILABLE' });
  await assert.rejects(checkModel({ ...llm, listModels: async () => [] }, { model: 'local/team/chat' }), { code: 'MODEL_UNAVAILABLE' });
});
