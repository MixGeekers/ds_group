import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ShiyuSessionAdapter, REPLYER_PRESET_ID, defaultModel, sessionBindingKey,
  type DshAgent, type DshAgentContext, type DshContext, type DshSession,
  type SessionBinding, type SessionBindingPort, type SessionEvent,
} from '../src/adapters/dsh/sessions.js';

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
  let createCount = 0, resumeCount = 0, followupCount = 0, disposeCount = 0, presetRegistrations = 0, hookRegistrations = 0, cancellations = 0;
  let slowGeneration = false;
  let createGate: Promise<void> | undefined;
  let archiveGate: Promise<void> | undefined;
  let failModel = false;
  let failArchive = false;
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
        followupCount++; agent.status = 'running';
        idle = (async () => {
          const decision = await localHooks.waterfall('agent/pre-step', [{}], async () => ({ kind: 'enter' }));
          if (decision.kind === 'reject') { agent.status = 'idle'; return; }
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
    host, live, persisted, presets, archived, lifecycle,
    counts: () => ({ createCount, resumeCount, followupCount, disposeCount, presetRegistrations, hookRegistrations, cancellations }),
    setSlow(value: boolean) { slowGeneration = value; },
    setCreateGate(value: Promise<void>) { createGate = value; },
    setArchiveGate(value: Promise<void>) { archiveGate = value; },
    failModel() { failModel = true; },
    failArchive() { failArchive = true; },
    async uiResume(id: string) {
      const stored = persisted.get(id)!;
      if (!presets.has(stored.header.agentPreset as string)) throw new Error('Unknown agent preset');
      return make({ resumeSessionId: id, setup: () => {} }, true);
    },
  };
}
const pause = () => new Promise<void>(resolve => setImmediate(resolve));

test('binding keys include role, business and scope; effort defaults are supported', () => {
  assert.notEqual(sessionBindingKey('replyer', 'same', 'a'), sessionBindingKey('replyer', 'same', 'b'));
  assert.notEqual(sessionBindingKey('core', 'same', 'a'), sessionBindingKey('replyer', 'same', 'a'));
  assert.equal(defaultModel('replyer').reasoningEffort, 'low');
  assert.equal(defaultModel('worker').reasoningEffort, 'high');
  assert.throws(() => new ShiyuSessionAdapter({ ctx: fakeHost().host, bindings: new BindingStore(), cwd: '/tmp', model: { ...defaultModel('replyer'), reasoningEffort: 'medium' as any } }), /low\/high\/max/);
});

test('status reads never initialize, register hooks or cancel native Agents', async () => {
  const fake = fakeHost();
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
  const first = await adapter.probe(), second = await adapter.probe();
  assert.notEqual(first.sessionId, second.sessionId); assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]?.sessionId, second.sessionId);
  await adapter.close();
  const next = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /archiveSession are required/);
  assert.equal(fake.counts().createCount, 0); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('a failed native archive makes the probe fail after releasing its Agent', async () => {
  const fake = fakeHost(), store = new BindingStore(); fake.failArchive();
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /Archive unavailable/);
  assert.equal(fake.live.size, 0); assert.equal(fake.archived.size, 0);
  assert.equal(store.rows[0]?.status, 'error'); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('probe requires a participating native durability listener', async () => {
  const fake = fakeHost(), store = new BindingStore(), get = fake.host.get;
  fake.host.get = name => name === 'sessions' ? { async flush() { return false; } } : get(name);
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /durability listener/);
  assert.equal(fake.live.size, 0); assert.equal(fake.archived.size, 0);
  assert.equal(store.rows[0]?.status, 'error'); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('unload waits for probe archival even after its native Agent has been released', async () => {
  const fake = fakeHost();
  let finishArchive!: () => void;
  fake.setArchiveGate(new Promise<void>(resolve => { finishArchive = resolve; }));
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
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
  const resumed = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
  const third = await resumed.generateReply({ businessId: 'chat-1', scope: 'alice', prompt: 'three' });
  assert.equal(third.binding.sessionId, first.binding.sessionId);
  assert.equal(fake.counts().resumeCount, 1);
  assert.equal(fake.persisted.get(first.binding.sessionId)?.events.filter(event => event.type === 'user/message').length, 3);
  await resumed.close();
  assert.equal(fake.archived.size, 0);
});

test('concurrent same-binding calls serialize; different scopes never share Session', async () => {
  const fake = fakeHost();
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: store, cwd: '/tmp' });
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
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.generateReply({ businessId: 'chat', scope: 'a', prompt: 'never infer', signal: AbortSignal.abort(new Error('caller stopped')) }), /caller stopped/);
  assert.equal(fake.counts().createCount, 0); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('failed host model validation creates no Session and no inference', async () => {
  const fake = fakeHost(); fake.failModel();
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /Unsupported model/);
  assert.equal(fake.counts().createCount, 0); assert.equal(fake.counts().followupCount, 0);
  await adapter.close();
});

test('missing durable preset service refuses unsafe host fallback', async () => {
  const fake = fakeHost(), get = fake.host.get;
  fake.host.get = name => name === 'agentPresets' ? undefined : get(name);
  const adapter = new ShiyuSessionAdapter({ ctx: fake.host, bindings: new BindingStore(), cwd: '/tmp' });
  await assert.rejects(adapter.probe(), /presets, persistence/);
  assert.equal(fake.counts().createCount, 0);
  await adapter.close();
});
