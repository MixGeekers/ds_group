import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readModelProfile } from '../dsh-plugin/model-profile.mjs';

const runtime = process.env.DSH_HARNESS;
assert.ok(runtime, 'Set DSH_HARNESS to an installed official DSH 0.2.2-rc.1 package or npm prefix');

test('official SDK profile import retains only selected native auth refs without discovery or generation', async t => {
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), 'dscord-native-auth-profile-'));
  t.after(() => rm(sourceHome, { recursive: true, force: true }));
  const directory = path.join(sourceHome, 'profiles/web');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  await writeFile(path.join(directory, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { openai: {}, anthropic: {} } } },
    { id: 'agent-default-model', config: { provider: 'openai', model: 'gpt-6-sol' } },
  ]));
  const credentialsPath = path.join(sourceHome, '.credentials.yaml');
  const original = JSON.stringify({ version: 1, records: {}, refs: {
    OPENAI_API_KEY: 'synthetic-selected-key', ANTHROPIC_API_KEY: 'synthetic-unrelated-key', UNRELATED_SECRET: 'synthetic-unrelated-secret',
  } });
  await writeFile(credentialsPath, original, { mode: 0o600 });
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Network is disabled for this SDK profile import'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const imported = await readModelProfile({ runtime, sourceHome, sourceProfile: 'web', env: { OPENAI_API_KEY: 'synthetic-ambient-key' } });
  assert.equal(imported.providerId, 'openai');
  assert.deepEqual(imported.credentials.refs, { OPENAI_API_KEY: 'synthetic-selected-key' });
  assert.equal(await readFile(credentialsPath, 'utf8'), original);

  await writeFile(credentialsPath, '');
  const ambient = await readModelProfile({ runtime, sourceHome, sourceProfile: 'web', env: { OPENAI_API_KEY: 'synthetic-ambient-key' } });
  assert.deepEqual(ambient.credentials.refs, { OPENAI_API_KEY: 'synthetic-ambient-key' });
  const other = await readModelProfile({ runtime, sourceHome, sourceProfile: 'web', env: {
    DS_GROUP_MODEL: 'anthropic/configured-model', OPENAI_API_KEY: 'synthetic-unrelated-key', ANTHROPIC_API_KEY: 'synthetic-other-selected-key',
  } });
  assert.deepEqual(other.credentials.refs, { ANTHROPIC_API_KEY: 'synthetic-other-selected-key' });
  assert.equal(requests, 0);
});
