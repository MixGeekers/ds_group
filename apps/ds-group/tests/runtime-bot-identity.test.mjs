import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { botInstructions } from '../dsh-plugin/runtime-rules.mjs';

// Exercise the production HTTP handler with an isolated, zero-model DS-Bot runtime.
const runtimes = new Map();
globalThis.__dsGroupIdentityRuntimes = runtimes;
after(() => { delete globalThis.__dsGroupIdentityRuntimes; });
const runtimeUrl = new URL('../dsh-plugin/runtime.mjs', import.meta.url).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === runtimeUrl) {
      if (specifier === '../vendor/ds-bot/index.js') return {
        url: `data:text/javascript,${encodeURIComponent('export const createRuntime = (_ctx, config) => globalThis.__dsGroupIdentityRuntimes.get(config.home);')}`,
        shortCircuit: true,
      };
      if (specifier === '@deepseek-ai/dsh-llm') return {
        url: `data:text/javascript,${encodeURIComponent('export const createUserMessage = () => { throw new Error("Unexpected model task in identity test"); };')}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
let apply;
try { ({ apply } = await import(runtimeUrl)); }
finally { hook.deregister(); }

const internalName = botId => `ds-group-${createHash('sha256').update(botId).digest('hex').slice(0, 31)}`;
const marker = botId => `\n\nDS_GROUP_MATRIX_BOT_ID=${JSON.stringify(botId)}`;
const inputFor = (botId, extra = {}) => ({ botId, name: '同名助手', role: '通用助手', instructions: 'synthetic instructions', ...extra });

async function fixture(t, { nodeState, bots = [], beforeCreate, updateFailures = 0 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-runtime-identity-'));
  const statePath = path.join(directory, 'node-state.json');
  if (nodeState) await writeFile(statePath, JSON.stringify(nodeState));
  const nativeBots = new Map(bots.map(bot => [bot.id, structuredClone(bot)]));
  const agents = new Map();
  const heldNames = new Set();
  const calls = { creates: [], lookups: [], updates: [], notifications: [] };
  const rt = {
    load: async () => {},
    save: async () => {},
    botOf: id => nativeBots.get(id),
    chatOf: id => nativeBots.get(id)?.sessionId ?? id,
    findBot(name) {
      calls.lookups.push(name);
      return [...nativeBots.values()].find(bot => bot.name === name);
    },
    async createBot(options) {
      calls.creates.push(structuredClone(options));
      const id = `native-${calls.creates.length}`;
      assert.equal(options.pickModel, true);
      assert.ok(options.name.length <= 40);
      if (heldNames.has(options.name) || [...nativeBots.values()].some(bot => bot.name === options.name)) {
        throw new Error('Duplicate native Bot name');
      }
      heldNames.add(options.name);
      try {
        await beforeCreate?.(options);
        const bot = { id, ...options, kickoff: { text: 'synthetic kickoff' } };
        nativeBots.set(id, bot);
        return bot;
      } finally { heldNames.delete(options.name); }
    },
    async resolveAgent(sessionId) {
      if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, ctx: {
        on() {}, tools: { presentAs() {}, guard() {}, schemas: () => [{ name: 'read_file' }] },
      } });
      return agents.get(sessionId);
    },
    async updateBot(id, changes, actorId, fromSessionId) {
      calls.updates.push({ id, ...structuredClone(changes), actorId, fromSessionId });
      if (updateFailures > 0) {
        updateFailures--;
        throw new Error('Synthetic setup interruption');
      }
      const bot = nativeBots.get(id);
      const changedInstructions = bot.instructions !== changes.instructions;
      Object.assign(bot, changes);
      // Mirror the vendored roster's unsolicited profile notification behavior.
      if (changedInstructions && bot.kickoff === undefined && !(actorId === id && fromSessionId === rt.chatOf(id))) {
        calls.notifications.push({ id, changes });
      }
    },
  };
  runtimes.set(path.join(directory, 'ds-bot'), rt);
  const disposers = [];
  const ctx = { on() {}, effect: effect => { disposers.push(effect()); } };
  let baseUrl;
  async function stop() {
    for (const dispose of disposers.splice(0)) await dispose();
  }
  async function start() {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    await apply(ctx, { nodeId: 'synthetic-node', dataDir: directory, port });
    baseUrl = `http://127.0.0.1:${port}`;
  }
  t.after(async () => {
    await stop();
    runtimes.delete(path.join(directory, 'ds-bot'));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(calls.notifications, [], 'setup must suppress unsolicited native profile turns');
  });
  await start();
  return {
    calls, nativeBots,
    state: async () => JSON.parse(await readFile(statePath, 'utf8')),
    restart: async () => { await stop(); await start(); },
    nextCreateArrival() {
      const requests = channel('http.server.request.start');
      return new Promise(resolve => {
        const listener = ({ request, socket }) => {
          if (socket.localPort !== Number(new URL(baseUrl).port) || request.url !== '/api/ds-group-node/bots') return;
          requests.unsubscribe(listener);
          // Let the production body reader resume before releasing the first setup.
          request.once('end', () => setImmediate(resolve));
        };
        requests.subscribe(listener);
        t.after(() => requests.unsubscribe(listener));
      });
    },
    async create(input) {
      const response = await fetch(`${baseUrl}/api/ds-group-node/bots`, { method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('different Matrix identities with the same display name get independent native Bots and Sessions', async t => {
  const f = await fixture(t, { bots: [{ id: 'unrelated', name: '同名助手', instructions: botInstructions('legacy Bot') }] });
  const first = await f.create(inputFor('@assistant:one.test'));
  const second = await f.create(inputFor('@assistant:two.test'));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.body.dsBotId, second.body.dsBotId);
  assert.notEqual(first.body.sessionId, second.body.sessionId);
  assert.equal(first.body.name, '同名助手');
  assert.equal(second.body.name, '同名助手');
  assert.deepEqual(f.calls.lookups, [internalName(first.body.botId), internalName(second.body.botId)]);
  assert.equal(f.calls.creates.length, 2);
  for (const result of [first, second]) {
    const bot = f.nativeBots.get(result.body.dsBotId);
    assert.ok(bot.instructions.endsWith(marker(result.body.botId)));
    assert.equal(bot.kickoff, undefined);
  }
});

test('public Bot names accept 80 characters while internal native names stay within 40', async t => {
  const f = await fixture(t);
  const name = '助'.repeat(80);
  const accepted = await f.create(inputFor('@long:identity.test', { name }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.name, name);
  assert.ok(f.calls.creates[0].name.length <= 40);
  const rejected = await f.create(inputFor('@too-long:identity.test', { name: `${name}助` }));
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.errorCode, 'INVALID_INPUT');
  assert.equal(f.calls.creates.length, 1);
});

for (const schemaVersion of [1, 2]) {
  test(`schema ${schemaVersion} Finance and HR mappings retain their native identity, current Session and history`, async t => {
    const records = Object.fromEntries(['finance', 'hr'].map(id => [`@${id}:legacy.test`, {
      botId: `@${id}:legacy.test`, dsBotId: `native-${id}`, name: id, role: id,
      seenEventIds: [`$${id}-earlier`], setupStatus: 'ready', createdAt: '2026-01-01T00:00:00.000Z',
    }]));
    const nativeBots = ['finance', 'hr'].map(id => ({ id: `native-${id}`, name: id,
      sessionId: `${id}-current-session`, instructions: botInstructions('legacy'), memory: [`${id} history`] }));
    const f = await fixture(t, { nodeState: { schemaVersion, nodeId: 'synthetic-node', bots: records, requests: {} }, bots: nativeBots });
    for (const id of ['finance', 'hr']) {
      const botId = `@${id}:legacy.test`;
      const result = await f.create(inputFor(botId, { name: `${id} renamed`, role: `${id} updated role` }));
      assert.equal(result.status, 200);
      assert.equal(result.body.dsBotId, `native-${id}`);
      assert.equal(result.body.sessionId, `${id}-current-session`);
      const saved = (await f.state()).bots[botId];
      assert.deepEqual(saved.seenEventIds, records[botId].seenEventIds);
      assert.equal(saved.createdAt, records[botId].createdAt);
      assert.equal(saved.name, `${id} renamed`);
      assert.equal(saved.role, `${id} updated role`);
      assert.deepEqual(f.nativeBots.get(saved.dsBotId).memory, [`${id} history`]);
      assert.equal(f.calls.updates.at(-1).actorId, `native-${id}`);
      assert.equal(f.calls.updates.at(-1).fromSessionId, `${id}-current-session`);
    }
    assert.equal((await f.state()).schemaVersion, 2);
    assert.deepEqual(f.calls.creates, []);
    assert.deepEqual(f.calls.lookups, []);
  });
}

test('an interrupted first create recovers only the deterministic name with its exact Matrix identity', async t => {
  const botId = '@recover:identity.test';
  const orphan = { id: 'native-orphan', name: internalName(botId), sessionId: 'orphan-session',
    instructions: `${botInstructions('original setup')}${marker(botId)}`, kickoff: {} };
  const f = await fixture(t, { bots: [orphan] });
  const result = await f.create(inputFor(botId));
  assert.equal(result.status, 200);
  assert.equal(result.body.dsBotId, orphan.id);
  assert.equal(result.body.sessionId, orphan.sessionId);
  assert.equal(f.calls.creates.length, 0);
  await f.restart();
  const renamed = await f.create(inputFor(botId, { name: '新显示名', instructions: 'updated instructions' }));
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.dsBotId, orphan.id);
  assert.equal(renamed.body.sessionId, orphan.sessionId);
  assert.equal(renamed.body.name, '新显示名');
  assert.ok(f.nativeBots.get(orphan.id).instructions.endsWith(marker(botId)));
});

test('a deterministic name collision with another full Matrix ID fails closed', async t => {
  const botId = '@new:identity.test';
  const f = await fixture(t, { bots: [{ id: 'native-collision', name: internalName(botId),
    instructions: `${botInstructions('same protocol')}${marker('@other:identity.test')}` }] });
  const result = await f.create(inputFor(botId));
  assert.equal(result.status, 400);
  assert.equal(result.body.errorCode, 'BOT_BINDING_CONFLICT');
  assert.deepEqual((await f.state()).bots, {});
  assert.equal(f.calls.creates.length, 0);
});

test('an orphan candidate already mapped to another Matrix identity is rejected', async t => {
  const botId = '@new:identity.test';
  const f = await fixture(t, {
    nodeState: { schemaVersion: 2, nodeId: 'synthetic-node', requests: {}, bots: {
      '@existing:identity.test': { botId: '@existing:identity.test', dsBotId: 'native-bound', name: 'Existing', role: 'Assistant' },
    } },
    bots: [{ id: 'native-bound', name: internalName(botId), instructions: `${botInstructions('setup')}${marker(botId)}` }],
  });
  assert.equal((await f.create(inputFor(botId))).body.errorCode, 'BOT_BINDING_CONFLICT');
  assert.equal((await f.state()).bots[botId], undefined);
});

test('legacy aliases sharing one native Bot fail closed without splitting or resetting their Session', async t => {
  const records = Object.fromEntries(['finance', 'hr'].map(id => [`@${id}:legacy.test`, {
    botId: `@${id}:legacy.test`, dsBotId: 'native-shared', name: 'Shared', role: id, seenEventIds: [`$${id}`],
  }]));
  const shared = { id: 'native-shared', name: 'Shared', sessionId: 'shared-history-session', instructions: botInstructions('legacy') };
  const f = await fixture(t, { nodeState: { schemaVersion: 1, nodeId: 'synthetic-node', bots: records, requests: {} }, bots: [shared] });
  for (const botId of Object.keys(records)) {
    const result = await f.create(inputFor(botId));
    assert.equal(result.status, 400);
    assert.equal(result.body.errorCode, 'BOT_BINDING_CONFLICT');
  }
  assert.deepEqual((await f.state()).bots, records);
  assert.deepEqual(f.nativeBots.get(shared.id), shared);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.updates, []);
});

test('a missing saved native Bot reports a repairable binding error without replacing its Session', async t => {
  const botId = '@finance:legacy.test';
  const record = { botId, dsBotId: 'native-missing', name: 'Finance', role: 'Finance', seenEventIds: ['$prior'] };
  const f = await fixture(t, { nodeState: { schemaVersion: 1, nodeId: 'synthetic-node', bots: { [botId]: record }, requests: {} } });
  const result = await f.create(inputFor(botId));
  assert.equal(result.status, 400);
  assert.equal(result.body.errorCode, 'BOT_BINDING_MISSING');
  assert.deepEqual((await f.state()).bots[botId], record);
  assert.deepEqual(f.calls.creates, []);
  assert.deepEqual(f.calls.lookups, []);
});

test('concurrent setup calls for one Matrix identity create one native Bot and serialize display updates', async t => {
  let entered;
  let release;
  const creating = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeCreate: async () => { entered(); await gate; } });
  const botId = '@concurrent:identity.test';
  const first = f.create(inputFor(botId));
  await creating;
  const arrived = f.nextCreateArrival();
  const second = f.create(inputFor(botId, { name: 'Renamed', instructions: 'second setup' }));
  await arrived;
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(results[0].body.dsBotId, results[1].body.dsBotId);
  assert.equal(results[0].body.sessionId, results[1].body.sessionId);
  assert.equal(f.calls.creates.length, 1);
  assert.equal((await f.state()).bots[botId].name, 'Renamed');
  assert.ok(f.nativeBots.get(results[0].body.dsBotId).instructions.startsWith('second setup'));
});

test('partial setup failure can retry the saved native binding in process and after restart', async t => {
  const f = await fixture(t, { updateFailures: 2 });
  const input = inputFor('@retry:identity.test');
  assert.equal((await f.create(input)).status, 400);
  const saved = (await f.state()).bots[input.botId];
  assert.equal(saved.setupStatus, 'creating');
  assert.equal((await f.create(input)).status, 400);
  await f.restart();
  const result = await f.create(input);
  assert.equal(result.status, 200);
  assert.equal(result.body.dsBotId, saved.dsBotId);
  assert.equal(result.body.sessionId, saved.dsBotId);
  assert.equal((await f.state()).bots[input.botId].setupStatus, 'ready');
  assert.equal(f.calls.creates.length, 1);
});
