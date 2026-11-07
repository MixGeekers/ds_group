import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startNativeTeam } from '../dsh-connect/native-team.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';
import { claimKernelHome, KERNEL_API } from '../dsh-connect/kernel-runtime.mjs';
import { kernelContext } from './fixtures/kernel-context.mjs';

const seed = () => ({ version: 1, bots: { original: { id: 'original', sessionId: 'current', name: '识雨', role: 'Research', createdAt: 1 } }, mainBotIds: ['original'], rooms: {} });
async function boot(t, { state, home, configure } = {}) {
  home ??= await mkdtemp(path.join(os.tmpdir(), 'dscord-native-'));
  if (state) await writeFile(path.join(home, 'state.json'), JSON.stringify(state));
  const ctx = kernelContext(); configure?.(ctx);
  const rt = await startNativeTeam(ctx, { home, workspace: path.join(home, 'workspace'), memoryReview: false });
  const native = new NativeBots(ctx);
  const stop = () => ctx.dispose();
  t.after(async () => { await stop(); await rm(home, { recursive: true, force: true }); });
  return { ctx, rt, native, home, stop };
}

test('owned kernel starts with source-aware memory; reads do not create a Chief or call a model', async t => {
  const f = await boot(t);
  assert.equal(f.rt.runtimeInfo().status, 'running'); assert.equal(f.rt.runtimeInfo().upstreamVersion, '0.3.1');
  assert.equal(f.rt.memoryBackend, 'source-aware-v1');
  const catalog = f.rt.catalog; f.rt.catalog = async () => { throw new Error('Provider discovery must not block a state read during loader startup'); };
  for (let n = 0; n < 2; n++) assert.deepEqual((await f.native.state()).bots, []);
  f.rt.catalog = catalog;
  assert.equal(f.ctx.agents.size, 0); assert.equal(f.ctx.modelCalls(), 0);
  assert.ok(f.ctx.routes.has(KERNEL_API)); assert.ok(f.ctx.routes.has(`${KERNEL_API}/feed`)); assert.equal(f.ctx.routes.has('/api/bot'), false);
  const bot = await f.native.call('create-bot', { name: '识雨', role: '协作', greet: false,
    owner: { id: '@owner:example.test', name: 'Owner', kind: 'human' }, source: { transport: 'matrix', eventId: '$create' } });
  const state = await f.native.state(); assert.equal(state.bots.length, 1); assert.deepEqual(state.mainBotIds, [bot.id]);
  assert.equal(bot.owner.id, '@owner:example.test'); assert.equal(bot.creationSource.eventId, '$create');
  assert.equal(f.ctx.agents.get(bot.id).received.length, 0); assert.equal(f.ctx.modelCalls(), 0);
  assert.equal(f.ctx.agents.get(bot.id).restricted.length, 0);
  for (const name of ['create_goal', 'subagent', 'spawn_teammate', 'schedule_create']) {
    assert.ok(f.ctx.tools.schemas(f.ctx.agents.get(bot.id)).some(tool => tool.name === name));
    assert.ok(f.ctx.guards.every(guard => guard({ name, arguments: { target: 'new_session' }, agent: f.ctx.agents.get(bot.id) }) === undefined));
  }
});

test('structured native inputs preserve equal-name accounts across rooms and inject background without waking a turn', async t => {
  const f = await boot(t, { state: seed() });
  for (const [requestId, id, roomId] of [['one', '@lin:a.test', '!north:test'], ['two', '@lin:b.test', '!south:test']]) {
    await f.rt.sendUser({ sessionId: 'original', requestId, content: [{ type: 'text', text: 'same display name' }],
      source: { sender: { id, name: '林青', kind: 'human' }, roomId, eventId: `$${requestId}` } });
  }
  for (const kind of ['bot', 'tool', 'background']) await f.rt.sendUser({ sessionId: 'current', requestId: kind,
    content: [{ type: 'text', text: kind }], source: { sender: { id: `${kind}:id`, kind } } });
  const received = f.ctx.agents.get('current').received;
  assert.deepEqual(received.map(row => row.mode), ['followup', 'followup', 'followup', 'inject', 'inject']);
  assert.deepEqual(received.slice(0, 2).map(row => row.message.source.sender.id), ['@lin:a.test', '@lin:b.test']);
  assert.deepEqual(received.slice(0, 2).map(row => row.message.source.roomId), ['!north:test', '!south:test']);
  assert.equal(received[2].message.source.kind, 'bot'); assert.equal(f.ctx.agents.size, 1); assert.equal(f.ctx.modelCalls(), 0);
});

test('native ingress coalesces retries, rejects changed bodies and keeps a receipt across restart', async t => {
  const f = await boot(t, { state: seed() });
  const input = { sessionId: 'original', requestId: 'stable', content: [{ type: 'text', text: 'write the file' }], source: { sender: { id: '@alice:test', kind: 'human' } } };
  await Promise.all([f.rt.sendUser(input), f.rt.sendUser(input)]);
  assert.equal(f.ctx.agents.get('current').received.length, 1);
  await assert.rejects(f.rt.sendUser({ ...input, content: [{ type: 'text', text: 'different' }] }), { code: 'bot/request-conflict' });
  await f.stop();
  const again = await boot(t, { home: f.home });
  await again.rt.sendUser(input); assert.equal(again.ctx.agents.get('current')?.received.length ?? 0, 0);
  assert.equal(again.rt.state.bots.original.id, 'original'); assert.equal(again.rt.chatOf('original'), 'current');
});

test('legacy inflight is retained once, never replayed at adoption or later restart', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dscord-inflight-'));
  await writeFile(path.join(home, 'inflight.json'), JSON.stringify({ turns: { current: { botId: 'original', since: 1 } }, queued: {} }));
  const f = await boot(t, { home, state: seed() });
  assert.equal(f.rt.migrationWorkView().turns.length, 1); assert.equal(f.ctx.modelCalls(), 0);
  await f.stop();
  const again = await boot(t, { home });
  assert.equal(again.rt.migrationWorkView().turns.length, 1);
  const data = JSON.parse(await readFile(path.join(home, 'inflight.json'), 'utf8'));
  assert.deepEqual(data.turns, {}); assert.equal(data.migrationHeld.turns.current.botId, 'original');
  assert.equal(again.ctx.modelCalls(), 0);
});

test('an explicit legacy owner claim persists once and cannot be overwritten by another account', async t => {
  const f = await boot(t, { state: seed() }), owner = { id: '@alice:test', kind: 'human' };
  await Promise.all([f.native.call('claim-bot', { id: 'original', owner }), f.native.call('claim-bot', { id: 'original', owner })]);
  assert.deepEqual((await f.native.list())[0].owner, owner);
  await assert.rejects(f.native.call('claim-bot', { id: 'original', owner: { id: '@bob:test', kind: 'human' } }), { code: 'bot/owner-conflict' });
  await f.stop(); const again = await boot(t, { home: f.home });
  assert.deepEqual((await again.native.list())[0].owner, owner);
});

test('Bot creation request retries survive a lost receipt and restart without a duplicate Session', async t => {
  const f = await boot(t), request = { name: '识雨', role: 'Research', greet: false, requestId: 'create-once', owner: { id: '@alice:test', kind: 'human' }, source: { transport: 'matrix' } };
  const [one, two] = await Promise.all([f.native.call('create-bot', request), f.native.call('create-bot', request)]);
  assert.equal(one.id, two.id); assert.equal(one.sessionId, one.id); assert.equal(f.ctx.agents.size, 1);
  assert.equal(f.rt.state.bots[one.id].creationSource.requestId, 'create-once');
  await assert.rejects(f.native.call('create-bot', { ...request, role: 'Different' }), { code: 'bot/request-conflict' });
  await f.stop(); const again = await boot(t, { home: f.home });
  assert.equal((await again.native.call('create-bot', request)).id, one.id);
  assert.equal((await again.native.list()).length, 1); assert.equal(again.ctx.agents.size, 0);
});

test('a legacy owner route refuses startup before listeners, files or work are installed', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dscord-conflict-')); t.after(() => rm(home, { recursive: true, force: true }));
  const ctx = kernelContext(); ctx.routes.set('/api/bot', { fetch: () => Response.json({ ok: false, error: { code: 'bot/not-found' } }) });
  await assert.rejects(startNativeTeam(ctx, { home }), error => error.code === 'DSCORD_KERNEL_CONFLICT' && error.details.action === 'stop-legacy-and-reload');
  assert.equal(ctx.listeners.size, 0); await assert.rejects(readFile(path.join(home, 'dscord-kernel.json')), { code: 'ENOENT' });
});

test('the home lease outlives parallel native module cleanup', async t => {
  const f = await boot(t, { state: seed(), configure(ctx) {
    ctx.plugin = plugin => {
      const effects = [], scope = Object.create(ctx);
      scope.effect = execute => { const dispose = execute(); if (typeof dispose === 'function') effects.push(dispose); };
      const loaded = Promise.resolve().then(() => plugin.apply(scope)); let stopping;
      const child = { then(resolve, reject) { return loaded.then(() => ({})).then(resolve, reject); },
        dispose() { return stopping ??= loaded.then(() => Promise.all(effects.splice(0).reverse().map(dispose => dispose()))); } };
      ctx.effect(() => () => child.dispose()); return child;
    };
  } });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; }); f.rt.ctx.effect(() => () => pending);
  const stopping = f.stop(); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => claimKernelHome(f.home), { code: 'DSCORD_KERNEL_CONFLICT' });
  finish(); await stopping;
  const next = claimKernelHome(f.home); next.release();
});
