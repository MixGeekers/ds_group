import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ShiyuSessionAdapter, REPLYER_PRESET_ID, defaultModel, sessionBindingKey,
  type DshAgent, type DshAgentContext, type DshContext, type DshSession,
  type SessionBinding, type SessionBindingPort, type SessionEvent,
  type ReplyRequest, type ReplyContextReceipt, type ReplyContextBinding, type ReplyAuthorizationCheck,
} from '../src/adapters/dsh/sessions.js';
import { nativeMessageHash, type NativeMessageInput, type NativeUserMessage } from '../src/adapters/dsh/native-message.js';

type Hook = (...args: any[]) => any;
class Hooks {
  listeners = new Map<string, Hook[]>();
  on(name: string, hook: Hook) {
    const list = this.listeners.get(name) ?? [];
    list.push(hook); this.listeners.set(name, list);
    return () => { const index = list.indexOf(hook); if (index >= 0) list.splice(index, 1); };
  }
  async emit(name: string, ...args: any[]) { for (const hook of [...this.listeners.get(name) ?? []]) await hook(...args); }
  async waterfall(name: string, args: any[], terminal: () => Promise<any>): Promise<any> {
    const hooks = [...this.listeners.get(name) ?? []];
    let position = 0;
    const next = (): Promise<any> => hooks[position++]?.(...args, next) ?? terminal();
    return next();
  }
}
class BindingStore implements SessionBindingPort {
  rows: SessionBinding[] = [];
  async load() { return structuredClone(this.rows); }
  async save(rows: SessionBinding[]) { this.rows = structuredClone(rows); }
}
interface FakeAgent extends DshAgent { hooks: Hooks; events: SessionEvent[]; cancelled: number; guards: Hook[]; }
function fakeHost() {
  const hooks = new Hooks();
  const persisted = new Map<string, { header: DshSession['header']; events: SessionEvent[] }>();
  const live = new Map<string, FakeAgent>();
  const presets = new Set<string>();
  const archived = new Set<string>(), flushed = new Set<string>();
  const lifecycle: string[] = [];
  const requests: any[] = [];
  const titles = new Map<string, { title: string; source: { kind: string } }>();
  let failTitle = false;
  let titleRequests = 0;
  let createCount = 0, resumeCount = 0, followupCount = 0, disposeCount = 0, presetRegistrations = 0, hookRegistrations = 0, cancellations = 0;
  let slowGeneration = false;
  let createGate: Promise<void> | undefined;
  let archiveGate: Promise<void> | undefined;
  let failModel = false;
  let failArchive = false;
  let factoryCalls = 0;
  const make = async (options: any, resume: boolean) => {
    if (createGate) await createGate;
    options.signal?.throwIfAborted();
    const id = resume ? options.resumeSessionId : options.sessionId;
    const stored: { header: DshSession['header']; events: SessionEvent[] } | undefined = resume ? persisted.get(id) : { header: options.meta, events: [] };
    if (!stored) throw new Error('Session not found');
    const events = stored.events;
    const localHooks = new Hooks();
    const guards: Hook[] = [];
    let idle = Promise.resolve();
    let settleSlow: (() => void) | undefined;
    const session: DshSession = {
      id, header: stored.header,
    };
    let agent: FakeAgent;
    const ctx: DshAgentContext = {
      on: (name, handler) => localHooks.on(name, handler),
      tools: {
        presentAs: () => () => {}, schemas: () => [{ name: 'shell' }, { name: 'run_code' }],
        restrict: () => () => {}, guard: handler => { guards.push(handler); return () => { guards.splice(guards.indexOf(handler), 1); }; },
      },
      systemPrompt: {
        suppressRuntimeContext: () => () => {}, section: () => () => {},
        assemble: async () => localHooks.waterfall('system-prompt/assemble', [{ tools: [{ name: 'shell' }] }, {}], async () => ({ tools: [{ name: 'shell' }] })),
      },
    };
    agent = {
      id, session, ctx, hooks: localHooks, events, guards, status: 'idle', cancelled: 0,
      followup(input) {
        assert.equal((input as NativeUserMessage).role, 'user');
        assert.match((input as NativeUserMessage).id, /^native-fixture-/);
        if (titles.get(id)?.source.kind !== 'user') titleRequests++;
        followupCount++; agent.status = 'running';
        idle = (async () => {
          const decision = await localHooks.waterfall('agent/pre-step', [{}], async () => ({ kind: 'enter' }));
          if (decision.kind === 'reject') { agent.status = 'idle'; return; }
          requests.push(await localHooks.waterfall('agent/request', [{}], async () => ({ maxTokens: 999999 })));
          events.push({ type: 'user/message', data: input });
          if (slowGeneration) await new Promise<void>(resolve => { settleSlow = resolve; });
          if (!agent.cancelled) {
            const event = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `reply:${input.content[0]!.text}` }] }, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } } };
            events.push(event); await localHooks.emit('session/event', session, event);
          }
          const end = { type: 'turn/end', data: { reason: { kind: agent.cancelled ? 'cancelled' : 'completed' } } };
          events.push(end); await localHooks.emit('session/event', session, end);
          agent.status = 'idle';
        })();
      },
      whenIdle: () => idle,
      cancel() { cancellations++; agent.cancelled++; settleSlow?.(); },
    };
    await options.setup(ctx, agent);
    await hooks.emit('agent/created', { agent });
    if (resume) resumeCount++; else createCount++;
    persisted.set(id, stored); live.set(id, agent);
    return { agent, async dispose() { disposeCount++; agent.cancel({ kind: 'hook', reason: 'disposed' }); await idle; live.delete(id); lifecycle.push(`dispose:${id}`); } };
  };
  const host: DshContext = {
    on: (name, handler) => { hookRegistrations++; return hooks.on(name, handler); },
    get(name) {
      if (name === 'agentPresets') return { async register({ id }: { id: string }) { presetRegistrations++; if (presets.has(id)) throw new Error('duplicate preset'); presets.add(id); return () => { presets.delete(id); }; } };
      if (name === 'sessionPersistence') return {};
      if (name === 'sessionTitle') return {
        rename(session: DshSession, title: string) { if (failTitle) throw new Error('Native title unavailable'); assert.equal(live.get(session.id)?.session, session); const value = { title, source: { kind: 'user' } }; titles.set(session.id, value); return structuredClone(value); },
        get(session: DshSession) { return structuredClone(titles.get(session.id)); },
      };
      if (name === 'sessions') return { async flush(session: DshSession) { assert.ok(live.has(session.id)); flushed.add(session.id); lifecycle.push(`flush:${session.id}`); return true; } };
      if (name === 'workspaceRegistry') return { async archiveSession(id: string) {
        if (archiveGate) await archiveGate;
        if (failArchive) throw new Error('Archive unavailable');
        assert.ok(persisted.has(id)); assert.ok(flushed.has(id)); assert.equal(live.has(id), false);
        archived.add(id); lifecycle.push(`archive:${id}`);
      } };
      if (name === 'llm') return { async resolveCallConfig(model: any) { if (failModel) throw new Error('Unsupported model'); return { ...model }; } };
    },
    agents: { create: options => make(options, false), resume: options => make(options, true), list: () => [...live.values()] },
  };
  return {
    factory: (input: NativeMessageInput): NativeUserMessage => ({ ...structuredClone(input), role: 'user', id: `native-fixture-${++factoryCalls}` }),
    host, live, persisted, presets, archived, lifecycle, requests, titles,
    titleRequests: () => titleRequests,
    counts: () => ({ createCount, resumeCount, followupCount, disposeCount, presetRegistrations, hookRegistrations, cancellations }),
    setSlow(value: boolean) { slowGeneration = value; },
    setCreateGate(value: Promise<void>) { createGate = value; },
    setArchiveGate(value: Promise<void>) { archiveGate = value; },
    failModel() { failModel = true; },
    failArchive() { failArchive = true; },
    failTitle() { failTitle = true; },
    async uiResume(id: string) {
      const stored = persisted.get(id)!;
      if (!presets.has(stored.header.agentPreset as string)) throw new Error('Unknown agent preset');
      return make({ resumeSessionId: id, setup: () => {} }, true);
    },
  };
}
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

test('managed replies pin a native title before every turn and fail closed without its receipt', async () => {
  const fake = fakeHost();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  const request = { businessId: 'title-suppression', scope: 'test', prompt: 'synthetic input' };
  const first = await adapter.generateReply(request);
  assert.equal(fake.titleRequests(), 0);
  assert.equal(fake.titles.get(first.binding.sessionId)?.source.kind, 'user');
  // A native refresh between turns cannot silently re-enable auto-title.
  fake.titles.set(first.binding.sessionId, { title: 'Changed', source: { kind: 'llm' } });
  await adapter.generateReply(request);
  assert.equal(fake.titleRequests(), 0);
  fake.failTitle();
  fake.titles.set(first.binding.sessionId, { title: 'Changed again', source: { kind: 'llm' } });
  await assert.rejects(adapter.generateReply(request), /Native title unavailable/);
  assert.equal(fake.counts().followupCount, 2);
  assert.equal(fake.live.size, 0);
  await adapter.close();
});

test('a per-turn token cap cannot exceed the configured ceiling and resets for later turns', async () => {
  const fake = fakeHost(), bindings = new BindingStore();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings, cwd: '/tmp' });
  await assert.rejects(adapter.generateReply({ businessId: 'caps', scope: 'test', prompt: 'hello', maxTokens: 4097 }), /maxTokens/);
  assert.equal(fake.counts().createCount, 0);
  await adapter.generateReply({ businessId: 'caps', scope: 'test', prompt: 'one', maxTokens: 1024 });
  await adapter.generateReply({ businessId: 'caps', scope: 'test', prompt: 'two' });
  assert.equal(fake.requests[0].maxTokens, 1024); assert.equal(fake.requests[1].maxTokens, 4096);
  await adapter.close();
});

test('binding keys include role, business and scope; effort defaults are supported', () => {
  assert.notEqual(sessionBindingKey('replyer', 'same', 'a'), sessionBindingKey('replyer', 'same', 'b'));
  assert.notEqual(sessionBindingKey('core', 'same', 'a'), sessionBindingKey('replyer', 'same', 'a'));
  assert.equal(defaultModel('replyer').reasoningEffort, 'low');
  assert.equal(defaultModel('worker').reasoningEffort, 'high');
  assert.throws(() => new ShiyuSessionAdapter({ ctx: fakeHost().host, bindings: new BindingStore(), cwd: '/tmp', model: { ...defaultModel('replyer'), reasoningEffort: 'medium' as any } }), /low\/high\/max/);
});

test('status reads never initialize, register hooks or cancel native Agents', async () => {
  const fake = fakeHost();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  const untouched = fake.counts();
  await assert.rejects(adapter.getStatus(), /not initialized/);
  assert.deepEqual(fake.counts(), untouched);
  await adapter.initialize();
  const initialized = fake.counts();
  assert.equal(initialized.presetRegistrations, 1);
  assert.deepEqual(await adapter.getStatus(), []); assert.deepEqual(await adapter.getStatus(), []);
  assert.deepEqual(fake.counts(), initialized);
  await adapter.close();
});

test('probe creates, flushes, releases and archives only its own native Session without inference', async () => {
  const fake = fakeHost(), store = new BindingStore();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  const result = await adapter.probe();
  assert.equal(result.noModelCalled, true); assert.deepEqual(result.tools, []);
  assert.equal(result.archived, true); assert.deepEqual([...fake.archived], [result.sessionId]);
  assert.deepEqual(fake.lifecycle, [`flush:${result.sessionId}`, `dispose:${result.sessionId}`, `archive:${result.sessionId}`]);
  assert.equal(fake.counts().followupCount, 0); assert.equal(fake.live.size, 0);
  assert.equal(store.rows[0]?.usage.status, 'unknown');
  assert.equal(store.rows[0]?.status, 'archived');
  assert.equal(fake.persisted.get(result.sessionId)?.header.agentPreset, REPLYER_PRESET_ID);
  await assert.rejects(fake.uiResume(result.sessionId), /must be resumed through/);
  await adapter.close();
  await assert.rejects(fake.uiResume(result.sessionId), /Unknown agent preset/);
});

test('repeated probes retain one binding while creating new identities and never resuming archived history', async () => {
  const fake = fakeHost(), store = new BindingStore();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  const first = await adapter.probe(), second = await adapter.probe();
  assert.notEqual(first.sessionId, second.sessionId); assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]?.sessionId, second.sessionId);
  await adapter.close();
  const next = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  await next.initialize();
  assert.equal((await next.getStatus())[0]?.status, 'archived');
  const third = await next.probe();
  assert.notEqual(second.sessionId, third.sessionId); assert.equal(store.rows.length, 1);
  assert.equal(fake.archived.size, 3); assert.equal(fake.counts().resumeCount, 0);
  assert.equal(fake.counts().followupCount, 0);
  await next.close();
});

test('probe refuses a missing archive interface before creating a native Session', async () => {
  const fake = fakeHost(), get = fake.host.get;
  fake.host.get = name => name === 'workspaceRegistry' ? undefined : get(name);
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /archiveSession are required/);
  assert.equal(fake.counts().createCount, 0); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('a failed native archive makes the probe fail after releasing its Agent', async () => {
  const fake = fakeHost(), store = new BindingStore(); fake.failArchive();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /Archive unavailable/);
  assert.equal(fake.live.size, 0); assert.equal(fake.archived.size, 0);
  assert.equal(store.rows[0]?.status, 'error'); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('probe requires a participating native durability listener', async () => {
  const fake = fakeHost(), store = new BindingStore(), get = fake.host.get;
  fake.host.get = name => name === 'sessions' ? { async flush() { return false; } } : get(name);
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /durability listener/);
  assert.equal(fake.live.size, 0); assert.equal(fake.archived.size, 0);
  assert.equal(store.rows[0]?.status, 'error'); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('unload waits for probe archival even after its native Agent has been released', async () => {
  const fake = fakeHost();
  let finishArchive!: () => void;
  fake.setArchiveGate(new Promise<void>(resolve => { finishArchive = resolve; }));
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  const pending = adapter.probe();
  while (!fake.counts().disposeCount) await pause();
  let closed = false;
  const closing = adapter.close().then(() => { closed = true; });
  await pause(); assert.equal(closed, false);
  finishArchive();
  const result = await pending; await closing;
  assert.equal(result.archived, true); assert.ok(fake.archived.has(result.sessionId));
  assert.equal(fake.counts().followupCount, 0);
});

test('same binding reuses history, stable identity and unknown missing cache metrics', async () => {
  const fake = fakeHost(), store = new BindingStore();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  const first = await adapter.generateReply({ businessId: 'chat-1', scope: 'alice', prompt: 'one' });
  const second = await adapter.generateReply({ businessId: 'chat-1', scope: 'alice', prompt: 'two' });
  assert.equal(first.binding.sessionId, second.binding.sessionId);
  assert.equal(fake.counts().createCount, 1); assert.equal(fake.counts().followupCount, 2);
  assert.equal(second.text, 'reply:two'); assert.equal(second.usage.totalTokens, 15);
  assert.equal(second.usage.cacheReadTokens, undefined);
  const agent = fake.live.get(first.binding.sessionId)!;
  assert.equal(agent.events.filter(event => event.type === 'user/message').length, 2);
  assert.ok(agent.guards.every(guard => typeof guard({ name: 'new-tool' }) === 'string'));
  const actualRequest = await agent.hooks.waterfall('agent/request', [{}], async () => ({ provider: 'wrong', model: 'wrong', reasoningEffort: 'max', maxTokens: 999999 }));
  assert.deepEqual(actualRequest, { ...defaultModel('replyer'), maxTokens: 4096 });
  assert.equal((await agent.hooks.waterfall('agent/pre-step', [{}], async () => ({ kind: 'enter' }))).kind, 'reject');
  await adapter.close();
  const resumed = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  const third = await resumed.generateReply({ businessId: 'chat-1', scope: 'alice', prompt: 'three' });
  assert.equal(third.binding.sessionId, first.binding.sessionId);
  assert.equal(fake.counts().resumeCount, 1);
  assert.equal(fake.persisted.get(first.binding.sessionId)?.events.filter(event => event.type === 'user/message').length, 3);
  await resumed.close();
  assert.equal(fake.archived.size, 0);
});

test('concurrent same-binding calls serialize; different scopes never share Session', async () => {
  const fake = fakeHost();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  const [a, b, c] = await Promise.all([
    adapter.generateReply({ businessId: 'chat', scope: 'a', prompt: 'a1' }),
    adapter.generateReply({ businessId: 'chat', scope: 'a', prompt: 'a2' }),
    adapter.generateReply({ businessId: 'chat', scope: 'b', prompt: 'b1' }),
  ]);
  assert.equal(a.binding.sessionId, b.binding.sessionId); assert.notEqual(a.binding.sessionId, c.binding.sessionId);
  assert.equal(fake.counts().createCount, 2);
  await adapter.close();
});

test('cancel stops a live generation and returns no partial successful reply', async () => {
  const fake = fakeHost(); fake.setSlow(true);
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  const pending = adapter.generateReply({ businessId: 'chat', scope: 'a', prompt: 'long' });
  const rejected = assert.rejects(pending, /cancelled/);
  while (!fake.counts().followupCount) await pause();
  await adapter.cancel(sessionBindingKey('replyer', 'chat', 'a'));
  await rejected;
  assert.equal(fake.live.size, 0);
  await adapter.close();
});

test('unload during native creation disposes the late handle and never infers', async () => {
  const fake = fakeHost();
  let release!: () => void;
  fake.setCreateGate(new Promise<void>(resolve => { release = resolve; }));
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  const pending = adapter.probe();
  const rejected = assert.rejects(pending, /closed/);
  await pause();
  const closing = adapter.close(); release();
  await Promise.all([closing, rejected]);
  assert.equal(fake.live.size, 0); assert.equal(fake.counts().followupCount, 0);
  assert.equal(fake.presets.size, 0);
});

test('cancel during native creation releases the late handle before any followup', async () => {
  const fake = fakeHost();
  let release!: () => void;
  fake.setCreateGate(new Promise<void>(resolve => { release = resolve; }));
  const store = new BindingStore();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: store, cwd: '/tmp' });
  const pending = adapter.generateReply({ businessId: 'chat', scope: 'a', prompt: 'never infer' });
  const rejected = assert.rejects(pending, /cancelled/);
  await pause();
  const cancelling = adapter.cancel(sessionBindingKey('replyer', 'chat', 'a')); release();
  await Promise.all([cancelling, rejected]);
  assert.equal(fake.live.size, 0); assert.equal(fake.counts().followupCount, 0);
  assert.equal(store.rows[0]?.status, 'cancelled');
  await adapter.close();
});

test('an already-aborted caller cannot initialize or call the native Agent', async () => {
  const fake = fakeHost();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.generateReply({ businessId: 'chat', scope: 'a', prompt: 'never infer', signal: AbortSignal.abort(new Error('caller stopped')) }), /caller stopped/);
  assert.equal(fake.counts().createCount, 0); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('failed host model validation creates no Session and no inference', async () => {
  const fake = fakeHost(); fake.failModel();
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /Unsupported model/);
  assert.equal(fake.counts().createCount, 0); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('missing durable preset service refuses unsafe host fallback', async () => {
  const fake = fakeHost(), get = fake.host.get;
  fake.host.get = name => name === 'agentPresets' ? undefined : get(name);
  const adapter = new ShiyuSessionAdapter({ createUserMessage: fake.factory, ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /presets, persistence/);
  assert.equal(fake.counts().createCount, 0);
  await adapter.close();
});

/** Public SDK contract substitute only; no native host or provider is used by these context tests. */
function contextHost() {
  type NativeRecord = { header: DshSession['header']; events: SessionEvent[]; durable: SessionEvent[]; inbox: NativeUserMessage[] };
  const records = new Map<string, NativeRecord>(), live = new Map<string, DshAgent>(), hooks = new Hooks();
  const localHooks = new Map<string, Hooks>(), titles = new Set<string>();
  const counts = { creates: 0, resumes: 0, followups: 0, requests: 0, disposes: 0, reads: 0, closes: 0, factories: 0, flushes: 0, removes: 0 };
  let flushFalse = false, skipFlush = false, corruptRead = false, failGeneration = false, foreignClaim = false;
  let slow = false, createGate: Promise<void> | undefined, beforeFlush: (() => void) | undefined;
  const waiters = new Map<string, () => void>();
  const append = (id: string, type: string, data: unknown) => {
    const record = records.get(id)!; const event = { type, data: structuredClone(data), seq: record.events.length, time: Date.now() };
    record.events.push(event); const agent = live.get(id);
    if (agent) void localHooks.get(id)!.emit('session/event', agent.session, event);
    return event;
  };
  const inject = (id: string, input: NativeUserMessage, durable = false, notify = true) => {
    const record = records.get(id)!; const start = record.inbox.length; record.inbox.push(structuredClone(input));
    append(id, 'agent/inbox/spliced', { target: 'next-turn', start, removedCount: 0, inserted: [input] });
    if (notify && localHooks.has(id)) void localHooks.get(id)!.emit('agent/inbox/inserted', { message: input });
    if (durable) record.durable = structuredClone(record.events);
  };
  const factory = (input: NativeMessageInput): NativeUserMessage => { counts.factories++; return { ...structuredClone(input), id: `native-input-${counts.factories}`, role: 'user' }; };
  const seed = (id: string, messages: NativeUserMessage[] = []) => {
    records.set(id, { header: { agentPreset: REPLYER_PRESET_ID }, events: [], durable: [], inbox: [] });
    for (const input of messages) inject(id, input, true, false);
  };
  const make = async (options: any, resume: boolean) => {
    if (createGate) await createGate;
    // Intentionally permit late creation: the adapter still owns and cleans up a late native handle.
    const id = resume ? options.resumeSessionId : options.sessionId;
    if (!resume) seed(id); if (!records.has(id)) throw new Error('Expected native Session is missing');
    const record = records.get(id)!, local = new Hooks(); localHooks.set(id, local);
    let idle = Promise.resolve(), cancelled = false;
    const session = { id, header: record.header };
    const ctx: DshAgentContext = {
      on: (name, fn) => local.on(name, fn),
      tools: { presentAs: () => () => {}, schemas: () => [], restrict: () => () => {}, guard: () => () => {} },
      systemPrompt: { suppressRuntimeContext: () => () => {}, section: () => () => {}, assemble: async () => ({ tools: [] }) },
    };
    const agent: DshAgent = {
      id, session, ctx, status: 'idle',
      inbox: { get nextTurn() { return record.inbox; }, nextStep: [], remove(messageId) {
        const index = record.inbox.findIndex(value => value.id === messageId); if (index < 0) return false;
        record.inbox.splice(index, 1); counts.removes++;
        append(id, 'agent/inbox/spliced', { target: 'next-turn', start: index, removedCount: 1, inserted: [], outcome: 'canceled' }); return true;
      } },
      followup(value) {
        counts.followups++; cancelled = false; agent.status = 'running'; inject(id, value as NativeUserMessage);
        idle = (async () => {
          const messages = record.inbox.splice(0); append(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: messages.length, inserted: [], outcome: 'consumed' });
          for (const message of messages) append(id, 'user/message', message);
          const claimed = foreignClaim ? [{ ...messages[0], id: 'unknown-claimed-input' }] : messages;
          const decision = await local.waterfall('agent/pre-step', [{ messages: claimed }], async () => ({ kind: 'enter' }));
          if (decision.kind === 'reject') { append(id, 'turn/end', { reason: { kind: 'rejected' } }); agent.status = 'idle'; return; }
          await local.waterfall('agent/request', [{}], async () => ({})); counts.requests++;
          if (slow) await new Promise<void>(resolve => waiters.set(id, resolve));
          if (failGeneration) { append(id, 'turn/end', { reason: { kind: 'error' } }); agent.status = 'idle'; return; }
          if (!cancelled) append(id, 'assistant/message', { message: { id: `native-assistant-${counts.requests}`, role: 'assistant', content: [{ type: 'text', text: `scoped:${messages[0].content[0].text}` }] }, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
          append(id, 'turn/end', { reason: { kind: cancelled ? 'cancelled' : 'completed' } }); agent.status = 'idle';
        })();
      },
      whenIdle: () => idle,
      cancel(_cause, options) {
        cancelled = true;
        if (!options?.keepInbox && record.inbox.length) { const removedCount = record.inbox.length; record.inbox.splice(0); append(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount, inserted: [], outcome: 'canceled' }); }
        waiters.get(id)?.(); waiters.delete(id);
      },
    };
    live.set(id, agent); await options.setup(ctx, agent); await hooks.emit('agent/created', { agent });
    if (resume) counts.resumes++; else counts.creates++;
    return { agent, async dispose() { counts.disposes++; agent.cancel({ kind: 'hook', reason: 'disposed' }); await idle; live.delete(id); record.durable = structuredClone(record.events); } };
  };
  const host: DshContext = {
    on: (name, fn) => hooks.on(name, fn),
    get(name) {
      if (name === 'agentPresets') return { register: async () => () => {} };
      if (name === 'llm') return { resolveCallConfig: async (model: unknown) => model };
      if (name === 'sessionTitle') return { rename(session: DshSession) { titles.add(session.id); return { title: '识雨 · 受限回复', source: { kind: 'user' } }; }, get(session: DshSession) { return titles.has(session.id) ? { title: '识雨 · 受限回复', source: { kind: 'user' } } : undefined; } };
      if (name === 'sessions') return { async flush(session: DshSession) { counts.flushes++; beforeFlush?.(); if (flushFalse && records.get(session.id)!.events.some(event => event.type === 'user/message')) return false; if (!skipFlush) records.get(session.id)!.durable = structuredClone(records.get(session.id)!.events); return true; } };
      if (name === 'sessionPersistence') return { async open(id: string, mode: string, options: { signal?: AbortSignal }) {
        options.signal?.throwIfAborted(); assert.equal(mode, 'read'); const record = records.get(id); if (!record) throw new Error('Expected native Session is missing');
        return { header: record.header, inheritedEventCount: 0, async read(offset: number, length: number) {
          counts.reads++; let events = structuredClone(record.durable.slice(offset, offset + length));
          if (corruptRead && length === 1 && events[0]?.type === 'user/message') events = [{ ...events[0], data: { ...events[0].data, id: 'wrong-message' } }];
          return { eventState: { count: record.durable.length }, events };
        }, async close() { counts.closes++; } };
      } };
      if (name === 'sessionProjections') return { restore(_initial: unknown, events: SessionEvent[]) {
        const lanes: Record<string, NativeUserMessage[]> = { 'next-turn': [], 'next-step': [] };
        for (const event of events) if (event.type === 'agent/inbox/spliced') lanes[event.data.target].splice(event.data.start, event.data.removedCount, ...structuredClone(event.data.inserted));
        return { snapshot: { values: { inbox: lanes } } };
      } };
    },
    agents: { create: options => make(options, false), resume: options => make(options, true), list: () => [...live.values()] },
  };
  return { host, counts, factory, records, live, seed, inject,
    setFlushFalse() { flushFalse = true; }, setSkipFlush() { skipFlush = true; }, setCorruptRead() { corruptRead = true; },
    setFailure() { failGeneration = true; }, setForeignClaim() { foreignClaim = true; }, setSlow() { slow = true; },
    setCreateGate(gate: Promise<void>) { createGate = gate; }, setBeforeFlush(fn: () => void) { beforeFlush = fn; },
  };
}
function contextRequest(overrides: Partial<ReplyRequest> = {}) {
  const bound: ReplyContextBinding[] = [], receipts: ReplyContextReceipt[] = [], phases: ReplyAuthorizationCheck['phase'][] = [];
  const request: ReplyRequest = {
    businessId: 'conversation-business-epoch-1', scope: 'local-owner', prompt: 'A scoped Task state view', deadlineMs: Date.now() + 5000,
    context: { operationId: 'operation-1', contextTokenId: 'capture-hash-1', sessionEpoch: 1,
      onBound(value) { bound.push(structuredClone(value)); }, authorize(value) { phases.push(value.phase); }, onContextDurable(value) { receipts.push(structuredClone(value)); } },
    ...overrides,
  };
  return { request, bound, receipts, phases };
}

test('context readiness resolves capabilities without constructing a message, Session or inference', async () => {
  const fake = contextHost(), adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  assert.deepEqual(await adapter.prepareContextSafety(), { ready: true, messageFactory: 'injected', nativeReadback: true, coldProjection: true });
  assert.equal(fake.counts.factories, 0); assert.equal(fake.counts.creates, 0); assert.equal(fake.counts.requests, 0);
  await adapter.close();
});

test('context-safe replies persist binding before followup and confirm exact native input and draft references', async () => {
  const fake = contextHost(), bindings = new BindingStore(), adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings, cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest();
  const onBound = fixture.request.context!.onBound;
  fixture.request.context!.onBound = binding => { assert.equal(fake.counts.followups, 0); assert.equal(bindings.rows[0].sessionId, binding.sessionId); return onBound(binding); };
  const result = await adapter.generateReply(fixture.request);
  assert.equal(fake.counts.factories, 1); assert.equal(fake.counts.followups, 1); assert.equal(fake.counts.requests, 1);
  assert.equal(fixture.bound[0].messageId, fixture.receipts[0].messageId); assert.equal(fixture.receipts.length, 1);
  assert.deepEqual(result.contextReceipt, fixture.receipts[0]);
  const stored = fake.records.get(result.binding.sessionId)!;
  assert.equal(stored.durable[result.contextReceipt!.userMessageSeq].type, 'user/message');
  assert.equal(nativeMessageHash(stored.durable[result.contextReceipt!.userMessageSeq].data), result.contextReceipt!.messageHash);
  assert.equal(stored.durable[result.assistantRef!.eventSeq].data.message.id, result.assistantRef!.messageId);
  assert.ok(fixture.phases.includes('admission')); assert.ok(fixture.phases.includes('pre_step')); assert.ok(fixture.phases.includes('context_ack')); assert.ok(fixture.phases.includes('release'));
  assert.equal(fake.counts.reads, fake.counts.closes); await adapter.close();
});

test('generation changes reuse native Session identity and reopening resumes the expected ID', async () => {
  const fake = contextHost(), bindings = new BindingStore();
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings, cwd: '/tmp', createUserMessage: fake.factory });
  const first = await adapter.generateReply(contextRequest().request), secondInput = contextRequest();
  secondInput.request.context!.operationId = 'operation-2'; secondInput.request.context!.contextTokenId = 'capture-new-generation'; secondInput.request.context!.expectedSessionId = first.binding.sessionId;
  const second = await adapter.generateReply(secondInput.request); assert.equal(second.binding.sessionId, first.binding.sessionId);
  assert.notEqual(second.contextReceipt!.messageId, first.contextReceipt!.messageId); assert.equal(fake.counts.creates, 1);
  await adapter.close();
  const reopened = new ShiyuSessionAdapter({ ctx: fake.host, bindings, cwd: '/tmp', createUserMessage: fake.factory });
  const third = await reopened.generateReply(secondInput.request); assert.equal(third.binding.sessionId, first.binding.sessionId); assert.equal(fake.counts.resumes, 1);
  await reopened.close();
});

test('expected native identity conflicts reject before followup and missing native Sessions are never replaced', async () => {
  const fake = contextHost(), bindings = new BindingStore(), adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings, cwd: '/tmp', createUserMessage: fake.factory });
  await adapter.generateReply(contextRequest().request); const wrong = contextRequest(); wrong.request.context!.expectedSessionId = 'shiyu-replyer-different';
  await assert.rejects(adapter.generateReply(wrong.request), /Expected native Session identity/);
  assert.equal(fake.counts.followups, 1); assert.equal(fake.counts.creates, 1); await adapter.close();
  const missing = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  await assert.rejects(missing.generateReply(wrong.request), /native Session is missing/); assert.equal(fake.counts.creates, 1); await missing.close();
});

test('failure to save the native binding prevents followup and any context acknowledgement', async () => {
  const fake = contextHost(), adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest(); fixture.request.context!.onBound = () => { throw new Error('Binding save rejected'); };
  await assert.rejects(adapter.generateReply(fixture.request), /Binding save rejected/);
  assert.equal(fake.counts.followups, 0); assert.equal(fixture.receipts.length, 0); assert.equal(fake.live.size, 0); await adapter.close();
});

test('a generation error does not erase independently confirmed native context loading', async () => {
  const fake = contextHost(); fake.setFailure();
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest(); await assert.rejects(adapter.generateReply(fixture.request), /Model turn ended: error/);
  assert.equal(fixture.receipts.length, 1); assert.equal(fixture.receipts[0].durability, 'confirmed'); assert.equal(fake.live.size, 0); await adapter.close();
});

test('flush participation and matching public readback are both required before context acknowledgement', async () => {
  for (const failure of ['listener', 'writer', 'readback'] as const) {
    const fake = contextHost(); if (failure === 'listener') fake.setFlushFalse(); if (failure === 'writer') fake.setSkipFlush(); if (failure === 'readback') fake.setCorruptRead();
    const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
    const fixture = contextRequest(); await assert.rejects(adapter.generateReply(fixture.request), /durability listener|readback/);
    assert.equal(fixture.receipts.length, 0); assert.equal(fake.counts.reads, fake.counts.closes); await adapter.close();
  }
});

test('cancellation during native flush never acknowledges the context or releases a successful draft', async () => {
  const fake = contextHost(), controller = new AbortController(); fake.setBeforeFlush(() => {
    if ([...fake.records.values()].some(record => record.events.some(event => event.type === 'user/message'))) controller.abort(new Error('Owner cancelled during flush'));
  });
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest({ signal: controller.signal });
  await assert.rejects(adapter.generateReply(fixture.request), /Owner cancelled during flush/);
  assert.equal(fixture.receipts.length, 0); await adapter.close(); assert.equal(fake.live.size, 0);
});

test('related source changes can reject a draft after loading without denying the captured loading receipt', async () => {
  const fake = contextHost(), adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest();
  fixture.request.context!.authorize = value => { if (value.phase === 'release') throw new Error('Task source version changed'); };
  await assert.rejects(adapter.generateReply(fixture.request), /Task source version changed/); assert.equal(fixture.receipts.length, 1); await adapter.close();
});

test('unknown durable inbox blocks resume before any native handle can dispose its pending data', async () => {
  const fake = contextHost(), id = 'shiyu-replyer-with-unknown';
  const unknown = fake.factory({ content: [{ type: 'text', text: 'Foreign pending input' }], source: { kind: 'user' } }); fake.seed(id, [unknown]);
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest(); fixture.request.context!.expectedSessionId = id;
  await assert.rejects(adapter.generateReply(fixture.request), /Unknown native inbox/);
  assert.equal(fake.counts.resumes, 0); assert.equal(fake.counts.disposes, 0); assert.equal(fake.records.get(id)!.inbox[0].id, unknown.id);
  assert.equal(fixture.receipts.length, 0); await adapter.close();
});

test('an explicitly registered obsolete inbox message is removed by exact identity before new followup', async () => {
  const fake = contextHost(), id = 'shiyu-replyer-with-known';
  const old = fake.factory({ content: [{ type: 'text', text: 'Obsolete registered input' }], source: { kind: 'user' } }); fake.seed(id, [old]);
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest(); fixture.request.context!.expectedSessionId = id; fixture.request.context!.staleInbox = [{ messageId: old.id, messageHash: nativeMessageHash(old) }];
  const result = await adapter.generateReply(fixture.request); assert.equal(result.binding.sessionId, id); assert.equal(fake.counts.removes, 1);
  assert.equal(fake.records.get(id)!.events.filter(event => event.type === 'user/message' && event.data.id === old.id).length, 0);
  assert.equal(fixture.receipts.length, 1); await adapter.close();
});

test('an unknown input racing after onBound is fenced and never silently disposed or acknowledged', async () => {
  const fake = contextHost(), adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest(); let foreignId = '', nativeId = '';
  fixture.request.context!.onBound = binding => { nativeId = binding.sessionId; const foreign = fake.factory({ content: [{ type: 'text', text: 'Racing native UI input' }], source: { kind: 'user' } }); foreignId = foreign.id; fake.inject(nativeId, foreign, true); };
  await assert.rejects(adapter.generateReply(fixture.request), /Unknown native input|cleanup could not be confirmed/);
  assert.equal(fake.counts.requests, 0); assert.equal(fixture.receipts.length, 0);
  await assert.rejects(adapter.close(), /cleanup failed/);
  assert.equal(fake.counts.disposes, 0); assert.equal(fake.records.get(nativeId)!.inbox[0].id, foreignId);
});

test('the native pre-step validates actually claimed IDs even if an inserted event was not observable', async () => {
  const fake = contextHost(); fake.setForeignClaim();
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest(); await assert.rejects(adapter.generateReply(fixture.request), /cleanup could not be confirmed/);
  assert.equal(fake.counts.requests, 0); assert.equal(fixture.receipts.length, 0);
  await assert.rejects(adapter.close(), /cleanup failed/); assert.equal(fake.counts.disposes, 0);
});

test('deadline covers initialization waits and late initialization never starts a Session', async () => {
  const fake = contextHost(); let finishLoad!: () => void;
  const load = new Promise<void>(resolve => { finishLoad = resolve; });
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: { async load() { await load; return []; }, async save() {} }, cwd: '/tmp', createUserMessage: fake.factory });
  const fixture = contextRequest({ deadlineMs: Date.now() + 15 });
  await assert.rejects(adapter.generateReply(fixture.request), /deadline expired/);
  assert.equal(fake.counts.creates, 0); finishLoad(); await adapter.close(); assert.equal(fake.counts.followups, 0);
});

test('deadline rejects queued requests without starting them and waits for late native cleanup on close', async () => {
  const fake = contextHost(); let finishCreate!: () => void;
  fake.setCreateGate(new Promise<void>(resolve => { finishCreate = resolve; }));
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp', createUserMessage: fake.factory });
  const first = contextRequest({ deadlineMs: Date.now() + 30 }), second = contextRequest({ deadlineMs: Date.now() + 10 });
  const a = assert.rejects(adapter.generateReply(first.request), /deadline expired/), b = assert.rejects(adapter.generateReply(second.request), /deadline expired/);
  await Promise.all([a, b]); assert.equal(fake.counts.followups, 0);
  let closed = false; const closing = adapter.close().then(() => { closed = true; }); await pause(); assert.equal(closed, false);
  finishCreate(); await closing; assert.equal(fake.counts.creates, 1); assert.equal(fake.counts.disposes, 1); assert.equal(fake.live.size, 0);
});
