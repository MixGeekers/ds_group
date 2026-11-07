import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DecisionSettings } from '../dsh-connect/decision-settings.mjs';

test('private decision configuration survives restart without returning the credential', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-decision-setting-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const received = [];
  const providerFactory = ({ apiKey }) => {
    received.push(apiKey);
    return { model: 'gpt-6-luna', health: () => ({ health: 'unknown' }) };
  };
  const settings = await new DecisionSettings({ directory, environment: {}, providerFactory }).initialize();
  assert.equal(settings.publicStatus().configured, false);
  const result = await settings.save({ apiKey: 'synthetic-private-decision-key' });
  assert.equal(result.configured, true);
  assert.equal(result.available, null);
  assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
  assert.equal((await stat(settings.filename)).mode & 0o777, 0o600);
  await settings.save({ apiKey: '', enabled: false });
  const restored = await new DecisionSettings({ directory, environment: {}, providerFactory }).initialize();
  assert.equal(restored.provider, null);
  assert.equal(restored.publicStatus().configured, true);
  await restored.save({ enabled: true });
  assert.equal(received.at(-1), 'synthetic-private-decision-key');
  assert.equal(JSON.parse(await readFile(settings.filename, 'utf8')).enabled, true);
});

test('private Decisions routing overrides its environment and persists without changing credential compatibility', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-decision-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const received = [];
  const providerFactory = options => { received.push(options); return { model: options.model }; };
  const environment = { OPENAI_API_KEY: 'synthetic-generic-key', DSCORD_DECISION_MODEL: 'proxy/decision-v1',
    DSCORD_DECISION_ENDPOINT: 'http://127.0.0.1:9417/v1/decisions' };
  const settings = await new DecisionSettings({ directory, environment, providerFactory }).initialize();
  assert.deepEqual(received[0], { apiKey: 'synthetic-generic-key', model: environment.DSCORD_DECISION_MODEL, endpoint: environment.DSCORD_DECISION_ENDPOINT });
  const status = await settings.save({ model: 'private/decision-v2', endpoint: 'https://decision.example/v2/decisions' });
  assert.equal(status.model, 'private/decision-v2');
  assert.equal(JSON.stringify(status).includes('synthetic-generic-key'), false);
  assert.equal(JSON.stringify(status).includes('decision.example'), false);
  const restored = await new DecisionSettings({ directory, environment, providerFactory }).initialize();
  assert.equal(restored.publicStatus().model, 'private/decision-v2');
  assert.equal(received.at(-1).endpoint, 'https://decision.example/v2/decisions');
  const before = await readFile(settings.filename, 'utf8');
  await assert.rejects(settings.save({ endpoint: 'file:///tmp/decisions' }), { code: 'INVALID_DECISION_ENDPOINT' });
  assert.equal(await readFile(settings.filename, 'utf8'), before);
});
