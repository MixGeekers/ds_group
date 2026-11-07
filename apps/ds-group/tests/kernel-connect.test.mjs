import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConnectController } from '../dsh-connect/controller.mjs';

async function fixture(t, { loseFirstCreate = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-connect-'));
  const bots = [];
  const receipts = new Map();
  let lost = false;
  const native = {
    list: async () => bots,
    bot: async id => { const bot = bots.find(bot => bot.id === id); if (!bot) throw new Error('Unknown Bot'); return bot; },
    models: async () => ({ available: true, providers: [{ id: 'fixture', models: [{ model: 'fixture/model', needsKey: false }] }] }),
    call: async (endpoint, input) => {
      assert.equal(endpoint, 'create-bot');
      if (!receipts.has(input.requestId)) {
        const bot = { id: `native-${bots.length}`, name: input.name, role: input.role, model: input.model,
          owner: input.owner, creationSource: input.source };
        bots.push(bot);
        receipts.set(input.requestId, bot);
      }
      if (loseFirstCreate && !lost) { lost = true; throw new Error('Created but response was lost'); }
      return receipts.get(input.requestId);
    },
  };
  const processes = { available: async () => ({ available: true }), stop: async () => {} };
  const controller = await new ConnectController({ directory, native, processes, models: {} }).initialize();
  await controller.restoring;
  t.after(async () => { await controller.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { controller, bots, receipts };
}

test('creating a Bot preserves its request across a lost result and refuses changed retry content', async t => {
  const { controller, bots } = await fixture(t, { loseFirstCreate: true });
  const request = { action: 'create-native', requestId: 'stable-create', name: '识雨', role: '生活和工作伙伴', model: 'fixture/model' };
  await assert.rejects(controller.handle(request), /response was lost/);
  assert.equal(bots.length, 1);
  const result = await controller.handle(request);
  assert.equal(result.nativeBots.length, 1);
  assert.equal(bots.length, 1);
  await controller.handle(request);
  assert.equal(bots.length, 1);
  await assert.rejects(controller.handle({ ...request, role: 'Another role' }), /内容已经变化/);
});

test('a signed-in local connector publishes only owned and explicitly claimable Bots', async t => {
  const { controller, bots } = await fixture(t);
  controller.state.user = { id: '@alice:home.test', name: 'Same name' };
  bots.push({ id: 'mine', owner: { id: '@alice:home.test' } },
    { id: 'other', owner: { id: '@bob:home.test' } }, { id: 'legacy' });
  assert.deepEqual((await controller.ownedNativeBots()).map(bot => bot.id), ['mine', 'legacy']);
  await assert.rejects(controller.ownedNativeBot('other'), { code: 'BOT_OWNER_CONFLICT' });
});

test('roster synchronization retries a failed desired node and continues restoring its peers', async t => {
  const { controller } = await fixture(t);
  controller.state.accessToken = 'synthetic';
  const bots = ['one', 'two', 'stopped'].map(id => ({ id, nativeBinding: { hostId: controller.state.hostId, nativeBotId: id } }));
  controller.state.nodes = Object.fromEntries(bots.map(bot => [bot.id, { ...bot, desired: bot.id !== 'stopped' }]));
  controller.running.set('one', { status: 'error', lastError: 'Startup connection was lost' });
  controller.publishNative = async () => {};
  controller.remote = async () => ({ bots });
  const attempts = [];
  let fail = true;
  controller.connect = async id => {
    attempts.push(id);
    if (id === 'one' && fail) throw new Error('Core is still starting');
    controller.running.set(id, { status: 'online' });
  };
  await controller.synchronizeNative();
  assert.deepEqual(attempts, ['one', 'two']);
  fail = false;
  await controller.synchronizeNative();
  await controller.synchronizeNative();
  assert.deepEqual(attempts, ['one', 'two', 'one']);
  assert.equal(controller.running.get('one').status, 'online');
  assert.equal(controller.state.nodes.stopped.desired, false);
});
