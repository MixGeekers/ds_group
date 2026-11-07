import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WORK_TOOLS } from '../dsh-plugin/runtime-rules.mjs';

const teams = new Map();
globalThis.__dscordStandaloneTeams = teams;
after(() => { delete globalThis.__dscordStandaloneTeams; });
const runtimeUrl = new URL('../dsh-plugin/runtime.mjs', import.meta.url).href;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === runtimeUrl && specifier === '../dsh-connect/native-team.mjs') return {
    url: `data:text/javascript,${encodeURIComponent('export const startNativeTeam = async (_ctx, config) => { const rt = globalThis.__dscordStandaloneTeams.get(config.home); rt.config = config; await rt.load(); return rt; };')}`,
    shortCircuit: true,
  };
  if (context.parentURL === runtimeUrl && specifier === '@deepseek-ai/dsh-llm') return {
    url: `data:text/javascript,${encodeURIComponent('export const createUserMessage = input => input;')}`, shortCircuit: true,
  };
  if (context.parentURL === runtimeUrl && specifier === '@deepseek-ai/dsh-tool-executor-native') return {
    url: `data:text/javascript,${encodeURIComponent('export class NativeToolExecutor { describe(tools) { return { schemas: tools }; } }')}`, shortCircuit: true,
  };
  return next(specifier, context);
} });
let apply;
try { ({ apply } = await import(runtimeUrl)); } finally { hook.deregister(); }

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-standalone-native-'));
  const events = new Map(), bots = new Map(), agents = new Map(), disposers = [], calls = [], coreCalls = [];
  let sequence = 0, turn = 0;
  const toolNames = ['read', 'write', 'bash', 'create_bot', 'message_bot', 'remember', 'recall', 'contacts', 'present', 'native_future_tool'];
  const runtime = { id: 'dscord-kernel', version: '0.4.0', upstreamVersion: '0.3.1', apiVersion: 1,
    api: '/api/dscord/kernel', home: path.join(directory, 'ds-bot'), instanceId: 'synthetic-kernel', status: 'running' };
  const emit = async (name, ...args) => { for (const handler of [...(events.get(name) || [])]) await handler(...args); };
  async function stream(options) {
    let next = async function* () { yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 5 } }; yield { type: 'text-delta', text: 'actual synthetic stream' }; };
    for (const handler of [...(events.get('llm/stream') || [])].reverse()) { const previous = next; next = () => handler(options, previous); }
    const chunks = []; for await (const chunk of next()) chunks.push(chunk); return chunks;
  }
  async function generate(agent, message, native = false) {
    const current = ++turn;
    await emit('session/event', agent.session, { type: 'turn/start', data: { turn: current } });
    await emit('session/event', agent.session, { type: 'user/message', data: message });
    try {
      const request = agent.hooks.get('agent/request');
      if (request) {
        const config = await request({}, async () => ({ provider: 'test', model: 'fixture' }));
        assert.equal(Object.hasOwn(config, 'tools'), false, 'DSH call config cannot carry tool declarations');
        assert.equal(Object.values(config).some(value => value === undefined), false, 'DSH request headers require lossless JSON');
      }
      const chunks = await stream({ sessionId: agent.session.id, provider: 'test', model: native ? 'native' : 'fixture', maxTokens: 4096 });
      assert.equal(chunks.length, 2);
      await emit('session/event', agent.session, { type: 'assistant/message', data: { turn: current, message: {
        content: [{ type: 'text', text: native ? 'Native result' : '{"text":"Legacy result"}' }],
      } } });
      await emit('session/event', agent.session, { type: 'turn/end', data: { turn: current, reason: { kind: 'completed' } } });
    } catch (error) {
      await emit('session/event', agent.session, { type: 'turn/end', data: { turn: current, reason: { kind: 'error', error: { code: error.code, message: error.message } } } });
    }
  }
  function agentFor(sessionId, parentSession) {
    if (!agents.has(sessionId)) {
      const hooks = new Map(), guards = [];
      const agent = { id: sessionId, session: { id: sessionId, header: { ...(parentSession ? { parentSession } : {}) } },
        model: { select(selection) { agent.selection = selection; } },
        whenIdle: async () => {}, cancel() {},
        followup(message) { queueMicrotask(() => { void generate(agent, message); }); },
        ctx: { on(name, handler) { hooks.set(name, handler); }, tools: { setExecutor(executor) { agent.executor = executor; }, guard: fn => guards.push(fn),
          schemas: () => toolNames.map(name => ({ name })) } }, hooks, guards };
      agents.set(sessionId, agent);
    }
    return agents.get(sessionId);
  }
  const rt = { load: async () => {}, save: async () => {}, runtimeInfo: () => runtime,
    selfOf: id => bots.has(id) ? id : undefined, botOf: id => bots.get(id), chatOf: id => bots.get(id)?.sessionId || id,
    findBot: name => [...bots.values()].find(bot => bot.name === name),
    async createBot(options) { const id = `native-${++sequence}`; const bot = { id, sessionId: id, ...options }; bots.set(id, bot); agentFor(id); return bot; },
    async createSession() { const id = `scoped-${++sequence}`; agentFor(id); return id; },
    resolveAgent: async id => { if (!agents.has(id)) throw new Error('Unknown synthetic Session'); return agents.get(id); },
    updateBot: async (id, changes) => Object.assign(bots.get(id), changes), setPermission: async () => {},
  };
  teams.set(path.join(directory, 'ds-bot'), rt);
  const ctx = { on(name, handler) {
    const list = events.get(name) || []; list.push(handler); events.set(name, list);
    return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); };
  }, effect(effect) { const dispose = effect(); if (dispose) disposers.push(dispose); },
    llm: { listProviders: () => [{ id: 'test' }], listModels: async () => [{ id: 'fixture' }, { id: 'native' }] },
    get: name => name === 'workingDirectory' ? { set: async () => {}, get: () => directory } : undefined,
    systemPrompt: { section: () => () => {} },
    sessionController: { resolveAgent: async id => ({ agent: await rt.resolveAgent(id) }) },
    sessions: { flush: async () => {} },
    connection: { browserPeer: {}, createSharedFetchHandler: () => ({ fetch: async request => {
      assert.equal(new URL(request.url).pathname, '/api/dscord/kernel');
      const { endpoint, payload } = await request.json(); calls.push({ endpoint, payload });
      let value;
      if (endpoint === 'kernel-info') value = { runtime };
      else if (endpoint === 'state') value = { bots: [...bots.values()], models: [], mainBotIds: [...bots.keys()].slice(0, 1), defaultModel: 'test/native', runtime };
      else if (endpoint === 'send') { const agent = await rt.resolveAgent(payload.sessionId); await generate(agent,
        { content: [{ type: 'text', text: payload.text }], source: payload.source || { kind: 'user' } }, true); value = true; }
      else if (endpoint === 'observe') value = { accepted: true, count: payload.inputs?.length || 0, watermark: payload.options?.watermark };
      else if (endpoint === 'attention-view') value = { botId: payload.botId, source: { sender: { id: '@alice:one.test' } }, watermark: payload.options?.watermark };
      else if (endpoint === 'memory-profiles') value = { botId: payload.botId, people: [{ id: '@alice:one.test' }] };
      else if (endpoint === 'memory-profile') value = { botId: payload.botId, id: payload.id };
      else throw new Error(`Unexpected native API ${endpoint}`);
      return Response.json({ ok: true, value });
    } }) },
  };
  const core = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text); coreCalls.push({ path: request.url, input });
    let value = {};
    if (request.url === '/internal/model/claim') value = { claimId: `claim-${coreCalls.length}` };
    if (request.url === '/internal/bot-work/check') value = { work: f.work };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  });
  await new Promise(resolve => core.listen(0, '127.0.0.1', resolve));
  const coreUrl = `http://127.0.0.1:${core.address().port}`;
  const { writeFile } = await import('node:fs/promises');
  const coreConfigPath = path.join(directory, 'core.json'); await writeFile(coreConfigPath, JSON.stringify({ nodeSecret: 'synthetic-secret' }));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await apply(ctx, { nodeId: 'synthetic-node', dataDir: directory, port, model: 'test/fixture', coreUrl, coreConfigPath });
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); await new Promise(resolve => core.close(resolve)); teams.delete(path.join(directory, 'ds-bot')); await rm(directory, { recursive: true, force: true }); });
  const f = { rt, bots, agents, calls, coreCalls, directory, stream, agentFor,
    state: async () => JSON.parse(await readFile(path.join(directory, 'node-state.json'), 'utf8')),
    async request(route, input) {
      const response = await fetch(`http://127.0.0.1:${port}/api/ds-group-node/${route}`, { method: input === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, body: await response.json() };
    },
    create: (botId, extra = {}) => f.request('bots', { botId, name: 'Synthetic', role: 'Assistant', ...extra }),
    input: (botId, requestId, extra = {}) => ({ botId, requestId, event: { eventId: `$${requestId}`, roomId: '!room:test', senderId: '@alice:one.test', senderName: 'Alice', senderKind: 'human', body: 'Reply to this message.' }, ...extra }),
  };
  return f;
}

test('standalone native members keep the complete original tool surface and durable native receipts', async t => {
  const f = await fixture(t);
  const setup = (await f.create('@native:test', { mode: 'native' })).body;
  assert.ok(setup.tools.includes('create_bot') && setup.tools.includes('remember') && setup.tools.includes('native_future_tool'));
  assert.equal(f.agents.get(setup.sessionId).guards.length, 0);
  const input = f.input(setup.botId, 'native-once');
  const first = await f.request('turns', input);
  assert.equal(first.body.status, 'completed'); assert.equal(first.body.text, 'Native result');
  assert.deepEqual(first.body.usage, { accounting: 'native-ds-bot', complete: false, observedCalls: 1 });
  assert.equal((await f.request('turns', input)).body.duplicate, true);
  assert.equal(f.calls.filter(call => call.endpoint === 'send').length, 1);
  assert.equal(f.coreCalls.length, 0);
  const status = (await f.request('status')).body;
  assert.deepEqual(status.runtime, f.rt.runtimeInfo()); assert.equal(status.engineVersion, '0.3.1');
  assert.equal(status.nativeUsage.observedCalls, 1); assert.equal(status.nativeUsage.complete, false);
});

test('native background memory, parts and delegated child streams bypass legacy task admission and retain actual observations', async t => {
  const f = await fixture(t);
  const native = (await f.create('@native:test', { mode: 'native' })).body;
  const legacy = (await f.create('@legacy:test')).body;
  assert.equal(f.rt.config.memoryReviewForBot(native.dsBotId), true);
  assert.equal(f.rt.config.memoryReviewForBot(legacy.dsBotId), false);
  const partner = await f.rt.createBot({ name: 'Native partner' });
  assert.equal(f.rt.config.memoryReviewForBot(partner.id), true);
  f.agentFor('native-subagent', native.sessionId);
  for (const sessionId of [native.sessionId, partner.id, 'native-subagent']) await f.stream({ sessionId, provider: 'other', model: 'native-model', purpose: 'memory', maxTokens: 32768 });
  assert.equal(f.coreCalls.length, 0);
  const state = await f.state();
  assert.deepEqual(state.nativeUsage.map(call => call.nativeBotId), [native.dsBotId, partner.id, native.dsBotId]);
  assert.ok(state.nativeUsage.every(call => call.status === 'completed' && call.usage.outputTokens === 5));
  await assert.rejects(f.stream({ sessionId: legacy.sessionId, provider: 'test', model: 'fixture', maxTokens: 4096 }), { code: 'UNSCHEDULED_MODEL_REQUEST' });
});

test('legacy tasks retain their existing tool scope and admitted model ledger', async t => {
  const f = await fixture(t);
  const setup = (await f.create('@legacy:test')).body;
  assert.deepEqual(setup.tools, ['read', 'write', 'bash']);
  assert.equal(f.agents.get(setup.sessionId).guards.length, 1);
  const reply = await f.request('turns', f.input(setup.botId, 'legacy-one'));
  assert.equal(reply.body.status, 'completed'); assert.equal(reply.body.claims.length, 1);
  assert.deepEqual(f.coreCalls.map(call => call.path), ['/internal/model/claim', '/internal/model/complete']);
  assert.equal((await f.state()).nativeUsage.length, 0);
  const agent = f.agents.get(setup.sessionId);
  const assembled = agent.executor.describe([{ name: 'read' }, { name: 'create_bot' }]);
  assert.deepEqual(assembled.schemas.map(tool => tool.name), ['read']);
  assert.deepEqual(agent.selection, { provider: 'test', model: 'fixture' });
  assert.equal(WORK_TOOLS.has('create_bot'), false);
});

test('an explicit native binding uses the actual existing Bot and refuses a missing identity', async t => {
  const f = await fixture(t);
  const original = await f.rt.createBot({ name: 'Original', model: 'test/native', instructions: 'Keep my native profile', private: true });
  const setup = await f.create('@bound:test', { mode: 'native', nativeBinding: { botId: '@bound:test', nativeBotId: original.id } });
  assert.equal(setup.body.dsBotId, original.id); assert.equal(setup.body.model, 'test/native');
  assert.equal(original.instructions, 'Keep my native profile'); assert.equal(original.private, true);
  const missing = await f.create('@missing:test', { mode: 'native', nativeBinding: { nativeBotId: 'not-here' } });
  assert.equal(missing.body.errorCode, 'BOT_BINDING_MISSING'); assert.equal(f.bots.size, 1);
});

test('a scoped external task keeps its separate Session and effective file tools even for a native Bot', async t => {
  const f = await fixture(t);
  const setup = (await f.create('@native:test', { mode: 'native' })).body;
  const input = f.input(setup.botId, 'scoped-one', { authorization: { domainId: 'a'.repeat(64), proofHash: 'proof-one' } });
  f.work = { kind: 'scoped', requestId: input.requestId, botId: input.botId, eventId: input.event.eventId,
    roomId: input.event.roomId, requesterId: input.event.senderId, domainId: input.authorization.domainId,
    proofHash: input.authorization.proofHash, tools: ['read'], ownerId: '@owner:test', authority: 'remote.test' };
  const result = await f.request('turns', input);
  assert.equal(result.body.status, 'completed'); assert.notEqual(result.body.sessionId, setup.sessionId);
  assert.equal(result.body.contextDomainId, input.authorization.domainId);
  const scoped = f.agents.get(result.body.sessionId);
  const schemas = scoped.executor.describe([{ name: 'read' }, { name: 'bash' }, { name: 'remember' }]);
  // A closed collaboration Session continues to expose no tools after its task ends.
  assert.deepEqual(schemas.schemas, []);
  assert.match(scoped.guards[0]({ name: 'read' }), /no active authorized task/);
  assert.equal(f.agents.get(setup.sessionId).guards.length, 0);
  assert.equal(f.calls.some(call => call.endpoint === 'send'), false);
  assert.ok(f.coreCalls.some(call => call.path === '/internal/model/claim'));
});

test('source observation, attention and profile HTTP operations use native identities without sending a user turn', async t => {
  const f = await fixture(t);
  const setup = (await f.create('@native:test', { mode: 'native' })).body;
  const shared = { botId: setup.botId, watermark: { sequence: 4, eventId: '$four', roomId: '!room:test' } };
  const observation = await f.request('observe', { ...shared, events: [{ event_id: '$four', room_id: '!room:test', sender: '@alice:one.test', content: { body: 'A source fact' } }] });
  assert.equal(observation.status, 200);
  assert.equal((await f.request('attention/view', { ...shared, roomId: '!room:test' })).status, 200);
  assert.equal((await f.request('kernel/state', shared)).status, 200);
  assert.equal((await f.request('memory/profiles', shared)).status, 200);
  assert.equal((await f.request('memory/profile', { ...shared, id: '@alice:one.test', kind: 'person' })).status, 200);
  const operations = f.calls.filter(call => ['observe', 'attention-view', 'memory-profiles', 'memory-profile'].includes(call.endpoint));
  assert.equal(operations.length, 4);
  assert.ok(operations.every(call => call.payload.botId === setup.dsBotId));
  assert.equal(f.calls.some(call => call.endpoint === 'send'), false); assert.equal(f.coreCalls.length, 0);
  assert.equal((await f.request('attention/view', { botId: '@missing:test' })).body.errorCode, 'BOT_NOT_FOUND');
});
