import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { KernelControl } from '../src/kernel-control.mjs';
import { KernelNodeClient } from '../src/kernel-node-client.mjs';

async function fixture(t, { loseFirstReceipt = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-client-'));
  const identity = { botId: '@bot:home.test', nodeId: 'bot', runtimeId: 'run-1' };
  const node = { ...identity, id: 'bot', status: 'idle', heartbeatAt: Date.now(), kernelControl: { version: 1 } };
  const control = await new KernelControl({ dataRoot: directory,
    accounts: { person: id => id === identity.botId ? { id, kind: 'bot', localpart: 'bot' } : null },
    node: id => id === identity.botId ? node : null }).initialize();
  const scope = { botId: identity.botId, nodeId: identity.nodeId };
  const applied = [];
  const profiles = { kind: 'person', items: [{ id: 'matrix:@alice:home.test', name: 'Alice', kind: 'person',
    currentCount: 1, historyCount: 1, scopes: ['own'] }], more: false };
  let lost = false;
  const client = new KernelNodeClient({ coreUrl: 'https://core.invalid', nodeSecret: 'synthetic-node-secret', ...identity,
    operations: {
      configureAttention: setting => { applied.push(setting); return setting; },
      memoryProfiles: async args => { assert.equal(args.kind, 'person'); return profiles; },
    },
    fetchImpl: async (url, options) => {
      const input = JSON.parse(options.body);
      assert.equal(options.headers.authorization, 'Bearer synthetic-node-secret');
      const result = url.pathname === '/internal/kernel/poll' ? control.poll(input, scope) : control.result(input, scope);
      if (url.pathname === '/internal/kernel/result' && loseFirstReceipt && !lost) {
        lost = true;
        throw new TypeError('synthetic response lost after durable receipt');
      }
      return Response.json(result);
    } });
  t.after(async () => { await client.stop(); control.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, control, identity, applied, profiles };
}

test('node settings recover a lost acknowledgement without repeating the application', async t => {
  const { client, control, identity, applied } = await fixture(t, { loseFirstReceipt: true });
  control.setAttention(identity.botId, { mode: 'natural' });
  await assert.rejects(client.tick(), /response lost/);
  assert.equal(applied.length, 1);
  assert.equal(client.pendingResults.size, 1);
  await client.tick();
  assert.equal(applied.length, 1);
  assert.equal(client.pendingResults.size, 0);
  assert.equal(control.desired(identity.botId).status, 'applied');
});

test('node memory RPC preserves the requested Bot and actual profile results', async t => {
  const { client, control, identity, profiles } = await fixture(t);
  const pending = control.readMemory(identity.botId, { kind: 'person' });
  await client.tick();
  assert.deepEqual(await pending, profiles);
});

test('a command for another Bot cannot invoke local operations', async t => {
  const { client, applied } = await fixture(t);
  const result = await client.execute({ commandId: 'wrong', leaseId: 'lease',
    botId: '@another:home.test', nodeId: 'bot', runtimeId: 'run-1', expiresAt: Date.now() + 10000,
    operation: 'attention-set', args: { mode: 'natural' }, revision: 1 });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'KERNEL_COMMAND_STALE');
  assert.equal(applied.length, 0);
});
