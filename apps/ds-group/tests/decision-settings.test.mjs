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
