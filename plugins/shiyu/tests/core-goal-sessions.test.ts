import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalSessionAdapter, CORE_GOAL_PRESET_ID, GOAL_PRESET_ID, goalCommandIdentity,
  type GoalAuthorityContext, type GoalAuthorityVerdict, type GoalBinding, type GoalBindingPort,
  type GoalCommandReceipt, type GoalCreateRequest, type NativeGoalRef, type NativeGoalView } from '../src/adapters/dsh/goals.js';
import type { DshAgent, DshAgentContext, DshContext, DshSession, SessionEvent } from '../src/adapters/dsh/sessions.js';
import { nativeMessageHash, type NativeMessageInput, type NativeUserMessage } from '../src/adapters/dsh/native-message.js';

// Native lifecycle/protocol double only: no installed DSH, network or model call.
// The ordering intentionally matches native claim -> pre-step -> request ->
// user/message -> global llm/stream -> assistant/message -> turn/end.
type Hook = (...args: any[]) => any;
class Hooks {
  listeners = new Map<string, Hook[]>();
  on(name: string, handler: Hook) {
    const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list);
    return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
  }
  emit(name: string, ...args: any[]) { for (const hook of [...this.listeners.get(name) ?? []]) hook(...args); }
  waterfall(name: string, args: unknown[], terminal: () => any): any {
    const hooks = [...this.listeners.get(name) ?? []]; let index = 0;
    const next = (): any => index < hooks.length ? hooks[index++]!(...args, next) : terminal();
    return next();
  }
}
const tick = () => new Promise<void>(done => setImmediate(done));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type DecisionRequest = Parameters<GoalSessionAdapter['decisionRound']>[0];
type Accounting = Parameters<DecisionRequest['onAccounting']>[0];
interface Stored {
  header: DshSession['header']; events: SessionEvent[]; durable: SessionEvent[];
  native?: Omit<NativeGoalView, 'activation'>; title?: { title: string; source: { kind: string } };
  inbox: NativeUserMessage[];
}
interface FakeAgent extends DshAgent { hooks: Hooks; guards: Hook[]; activation: 'armed' | 'disarmed'; cancelled: boolean }
function fixture() {
  const global = new Hooks(), stored = new Map<string, Stored>(), live = new Map<string, FakeAgent>(), presets = new Set<string>();
  const bindings = new Map<string, GoalBinding>(), commands = new Map<string, GoalCommandReceipt>();
  const capability = Object.freeze({}), checks: GoalAuthorityContext[] = [], accounting: Accounting[] = [], trace: string[] = [];
  const admittedStreams: Record<string, unknown>[] = [];
  const nativeRequests = new WeakSet<object>();
  let allowed = true, expiredGrant = false, createGate: Promise<void> | undefined, streamGate: Promise<void> | undefined;
  let failDispose = false, failFlush = false, readFault: 'throw' | 'user-hash' | 'assistant-seq' | undefined;
  let beforeAuthorize: ((context: GoalAuthorityContext) => void) | undefined;
  let mode: 'normal' | 'retry' | 'compaction' | 'title' | 'anonymous' | 'history' | 'history-update' | 'changed-prestep' | 'mutated-user' | 'extra-user' = 'normal', output = '{"proposal":"inspect the synthetic evidence"}';
  let messageNumber = 0, creates = 0, resumes = 0, followups = 0, disposals = 0, streams = 0, autoRounds = 0, opens = 0, closes = 0;
  let lastAgent: FakeAgent | undefined;
  const exact = (agent: DshAgent) => { assert.equal(live.get(agent.id), agent); return stored.get(agent.id)!; };
  const append = (agent: FakeAgent, type: string, data: unknown, surfaceOp?: string) => {
    const record = exact(agent), event: SessionEvent = { seq: record.events.length, type, data: structuredClone(data), time: Date.now(), ...(surfaceOp ? { surfaceOp } : {}) };
    record.events.push(event); agent.hooks.emit('session/event', agent.session, event); global.emit('session/event', agent.session, event); return event;
  };
  const native = (agent: DshAgent): NativeGoalView | undefined => {
    const value = exact(agent).native; return value && structuredClone({ ...value, activation: (agent as FakeAgent).activation });
  };
  const schedule = (agent: FakeAgent) => { void Promise.resolve().then(() => { if (agent.activation === 'armed') autoRounds++; }); };
  const mutate = (name: string, agent: FakeAgent, ref: NativeGoalRef, changes: Record<string, unknown>) => {
    const record = exact(agent), prior = record.native!;
    if (!prior || prior.id !== ref.id || prior.revision !== ref.revision) throw new Error('Native Goal revision conflict');
    record.native = { ...prior, ...changes, revision: prior.revision + 1, updatedAt: Date.now() };
    if (name === 'resume') agent.activation = 'armed';
    append(agent, 'goal/change', { goal: record.native }); schedule(agent); return native(agent);
  };
  const goals = {
    get: native,
    disarm(agent: FakeAgent) { exact(agent); agent.activation = 'disarmed'; trace.push('disarm'); return native(agent); },
    create(agent: FakeAgent, input: { objective: string; maxGoalRounds: number }) {
      const record = exact(agent); assert.equal(record.native, undefined);
      record.native = { id: `native-goal-${creates}`, revision: 1, objective: input.objective, phase: 'active', roundsStarted: 0,
        maxGoalRounds: input.maxGoalRounds, createdAt: Date.now(), updatedAt: Date.now() };
      agent.activation = 'armed'; append(agent, 'goal/change', { goal: record.native }); schedule(agent); return native(agent);
    },
    edit: (agent: FakeAgent, ref: NativeGoalRef, changes: Record<string, unknown>) => mutate('edit', agent, ref, changes),
    pause: (agent: FakeAgent, ref: NativeGoalRef) => mutate('pause', agent, ref, { phase: 'paused' }),
    resume: (agent: FakeAgent, ref: NativeGoalRef) => mutate('resume', agent, ref, { phase: 'active' }),
    complete: (agent: FakeAgent, ref: NativeGoalRef) => mutate('complete', agent, ref, { phase: 'complete' }),
  };
  function stream(options: Record<string, unknown>): AsyncIterable<unknown> {
    return global.waterfall('llm/stream', [options], () => {
      admittedStreams.push(Object.fromEntries(['sessionId', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'purpose', 'tools'].filter(key => options[key] !== undefined).map(key => [key, options[key]])));
      streams++; trace.push(`stream:${String(options.purpose ?? 'main')}`);
      return (async function* () { if (streamGate) await streamGate; yield { type: 'synthetic' }; })();
    });
  }
  const make = async (options: any, resume: boolean) => {
    if (createGate) await createGate; // Deliberately ignores AbortSignal to test late ownership.
    const id = resume ? options.resumeSessionId : options.sessionId;
    if (resume) { if (!stored.has(id)) throw new Error('Native Session not found'); resumes++; }
    else { assert.equal(stored.has(id), false); stored.set(id, { header: structuredClone(options.meta), events: [], durable: [], inbox: [] }); creates++; }
    const record = stored.get(id)!, hooks = new Hooks(), guards: Hook[] = [];
    const session: DshSession = { id, header: record.header };
    let idle = Promise.resolve(), agent: FakeAgent;
    const local: DshAgentContext = {
      on: (name, handler) => hooks.on(name, handler),
      tools: { schemas: () => [{ name: 'shell' }, { name: 'run_code' }, { name: 'create_goal' }], presentAs: () => () => {}, restrict: () => () => {},
        guard(handler) { guards.push(handler); return () => { guards.splice(guards.indexOf(handler), 1); }; } },
      systemPrompt: { suppressRuntimeContext: () => () => {}, section: () => () => {},
        assemble: async () => hooks.waterfall('system-prompt/assemble', [{ tools: [{ name: 'shell' }] }, {}], () => ({ tools: [{ name: 'shell' }] })) },
    };
    agent = { id, session, ctx: local, hooks, guards, status: 'idle', activation: 'disarmed', cancelled: false,
      inbox: { get nextTurn() { return record.inbox; }, get nextStep() { return []; }, remove(messageId: string) {
        const index = record.inbox.findIndex(message => message.id === messageId); if (index < 0) return false;
        record.inbox.splice(index, 1); append(agent, 'agent/inbox/spliced', { target: 'next-turn', start: index, removedCount: 1, inserted: [], outcome: 'canceled' }); return true;
      } },
      followup(message) {
        followups++; trace.push('followup'); record.inbox.push(structuredClone(message));
        append(agent, 'agent/inbox/spliced', { target: 'next-turn', start: record.inbox.length - 1, removedCount: 0, inserted: [message] });
        hooks.emit('agent/inbox/inserted', { message }); agent.status = 'running';
        idle = (async () => {
          try {
            const claimed = structuredClone(record.inbox); record.inbox.length = 0;
            append(agent, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: claimed.length, inserted: [], outcome: 'consumed' });
            const step = await hooks.waterfall('agent/pre-step', [{ messages: claimed }], () => ({ kind: 'enter', messages: mode === 'changed-prestep' ? [] : claimed }));
            if (step.kind === 'reject') { append(agent, 'turn/end', { reason: { kind: 'blocked' } }); return; }
            const assembly = await local.systemPrompt.assemble({ scope: agent }); assert.deepEqual(assembly.tools, []);
            const request = await hooks.waterfall('agent/request', [{}], () => ({ ...options.agentOptions, maxTokens: 99999 }));
            const appended = structuredClone(message);
            if (mode === 'mutated-user') appended.content[0]!.text = 'Outer native hook replaced the approved input';
            append(agent, 'user/message', appended, 'append');
            if (mode === 'extra-user') append(agent, 'user/message', { ...structuredClone(message), id: 'unregistered-outer-notice' }, 'append');
            const main = { ...request, sessionId: id, messages: claimed }; nativeRequests.add(main);
            if (mode === 'compaction' || mode === 'title') {
              const purpose = mode === 'title' ? 'session-title' : 'compaction';
              append(agent, mode === 'title' ? 'session/title-llm-request' : 'compaction/start', {});
              for await (const _item of stream({ ...main, purpose })) { /* no provider should be reached */ }
            }
            if (mode === 'anonymous') for await (const _item of stream({ ...main })) { /* absent purpose is not official provenance */ }
            if (mode === 'history') main.toolHistory = { tools: [{ name: 'shell' }], updates: [] };
            if (mode === 'history-update') main.toolHistory = { tools: [], updates: [{ additions: [{ name: 'shell' }] }] };
            for await (const _item of stream(main)) { /* native provider stream double */ }
            if (mode === 'retry') {
              append(agent, 'assistant/attempt', { usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 }, reason: 'retry' });
              for await (const _item of stream(main)) { /* second next() must be blocked */ }
            }
            if (!agent.cancelled) append(agent, 'assistant/message', { message: { id: `assistant-${message.id}`, role: 'assistant', content: [{ type: 'text', text: output }] }, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } });
            append(agent, 'turn/end', { reason: { kind: agent.cancelled ? 'cancelled' : 'completed' } });
          } catch (error) { append(agent, 'turn/end', { reason: { kind: 'error' }, error: error instanceof Error ? error.message : String(error) }); }
          finally { agent.status = 'idle'; }
        })();
      },
      whenIdle: () => idle,
      cancel(_cause, options) { agent.cancelled = true; trace.push('cancel'); if (!options?.keepInbox) record.inbox.length = 0; },
    };
    lastAgent = agent; live.set(id, agent); await options.setup(local, agent); global.emit('agent/created', { agent });
    return { agent, async dispose() { disposals++; trace.push('dispose'); if (failDispose) throw new Error('Native disposal failed'); await idle; record.inbox.length = 0; live.delete(id); } };
  };
  const ctx: DshContext = {
    on: (name, handler) => global.on(name, handler), agents: { create: options => make(options, false), resume: options => make(options, true), list: () => [...live.values()] },
    get(name) {
      if (name === 'goals') return goals;
      if (name === 'llm') return { resolveCallConfig: async (value: unknown) => structuredClone(value), stream };
      if (name === 'agentPresets') return { register(value: { id: string }) { assert.equal(presets.has(value.id), false); presets.add(value.id); return () => { presets.delete(value.id); }; } };
      if (name === 'sessions') return { async flush(session: DshSession) { trace.push('flush'); if (failFlush) throw new Error('Native flush failed'); const record = stored.get(session.id)!; record.durable = structuredClone(record.events); return true; } };
      if (name === 'sessionTitle') return { get: (session: DshSession) => stored.get(session.id)?.title,
        rename(session: DshSession, title: string) { const result = { title, source: { kind: 'user' } }; stored.get(session.id)!.title = result; return result; } };
      if (name === 'sessionPersistence') return { async open(sessionId: string, mode: string) {
        assert.equal(mode, 'read'); const record = stored.get(sessionId); if (!record) throw new Error('Native Session not found'); opens++;
        return { header: structuredClone(record.header), inheritedEventCount: 0, async read(offset: number, count: number) {
          if (readFault === 'throw') throw new Error('Native read failed');
          const events = structuredClone(record.durable.slice(offset, offset + count));
          if (count === 1 && events[0]?.type === 'user/message' && readFault === 'user-hash') events[0].data.content[0].text = 'changed durable body';
          if (count === 1 && events[0]?.type === 'assistant/message' && readFault === 'assistant-seq') events[0].seq = events[0].seq! + 1;
          return { events, eventState: 'detached' };
        }, async close() { closes++; } };
      } };
      if (name === 'sessionProjections') return { async restore(_context: unknown, events: SessionEvent[]) {
        const inbox: NativeUserMessage[] = [];
        for (const event of events) if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn') inbox.splice(event.data.start, event.data.removedCount, ...event.data.inserted);
        return { snapshot: { values: { inbox: { 'next-turn': inbox, 'next-step': [] } } } };
      } };
    },
  };
  const port: GoalBindingPort = {
    async load(goalId) { const value = bindings.get(goalId); return value && structuredClone(value); },
    async loadCommand(goalId, commandId) { const value = commands.get(JSON.stringify([goalId, commandId])); return value && structuredClone(value); },
    async compareAndSet(expected, binding) {
      assert.equal(bindings.get(binding.goalId)?.metadataVersion, expected);
      const receipt = binding.receipt, key = receipt && JSON.stringify([binding.goalId, receipt.commandId]), prior = key && commands.get(key);
      if (prior && receipt) assert.equal(goalCommandIdentity(prior), goalCommandIdentity(receipt));
      bindings.set(binding.goalId, structuredClone(binding)); if (key && receipt) commands.set(key, structuredClone(receipt));
    },
  };
  const authority = { async authorize(given: object, context: GoalAuthorityContext): Promise<GoalAuthorityVerdict> {
    checks.push(structuredClone(context)); beforeAuthorize?.(context);
    if (!allowed || given !== capability) return { allowed: false };
    return { allowed: true, kind: 'owner', ownerId: 'owner-1', scope: 'local-owner', expiresAt: new Date(Date.now() + (expiredGrant ? -1 : 60000)).toISOString() };
  } };
  const adapter = (namespace: 'core' | 'lifecycle' = 'core') => new GoalSessionAdapter({ ctx, bindings: port, authority, namespace,
    isAgentLoopRequest: (request: unknown) => request !== null && typeof request === 'object' && nativeRequests.has(request),
    createUserMessage: (input: NativeMessageInput) => ({ ...structuredClone(input), role: 'user', id: `core-user-${++messageNumber}` }) });
  const create: GoalCreateRequest = { goalId: 'core-goal-a', ownerId: 'owner-1', scope: 'local-owner', cwd: '/synthetic/shiyu/core',
    completionCriteriaHash: 'a'.repeat(64), objective: 'Plan using approved synthetic evidence', commandId: 'create-a', capability };
  const decision = (ref: NativeGoalRef, patch: Partial<DecisionRequest> = {}): DecisionRequest => ({ goalId: create.goalId, expectedRef: ref,
    roundId: `decision-${accounting.length + 1}`, capability, prompt: 'Only propose the next check for the synthetic goal.', deadlineAtMs: Date.now() + 30000, maxTokens: 512,
    async onDispatch() { trace.push('dispatch-receipt'); }, async onContextDurable() { trace.push('context-receipt'); },
    async onAccounting(value) { accounting.push(structuredClone(value)); }, ...patch });
  return { ctx, stored, live, presets, bindings, checks, accounting, trace, capability, create, decision, adapter, stream, admittedStreams,
    counts: () => ({ creates, resumes, followups, disposals, streams, autoRounds, opens, closes }), agent: () => lastAgent!,
    setAllowed(value: boolean) { allowed = value; }, setExpired(value: boolean) { expiredGrant = value; }, setMode(value: typeof mode) { mode = value; },
    setOutput(value: string) { output = value; }, setReadFault(value: typeof readFault) { readFault = value; }, setFlushFault(value: boolean) { failFlush = value; },
    setDisposeFault(value: boolean) { failDispose = value; }, setCreateGate(value: Promise<void> | undefined) { createGate = value; }, setStreamGate(value: Promise<void>) { streamGate = value; },
    beforeAuthorize(value: typeof beforeAuthorize) { beforeAuthorize = value; },
    insertForeign(sessionId: string, durable = true) {
      const record = stored.get(sessionId)!, message: NativeUserMessage = { id: 'foreign-message', role: 'user', content: [{ type: 'text', text: 'Unregistered input' }], source: { kind: 'user' } };
      record.inbox.push(message); const event: SessionEvent = { type: 'agent/inbox/spliced', seq: record.events.length, data: { target: 'next-turn', start: record.inbox.length - 1, removedCount: 0, inserted: [message] } };
      record.events.push(event); if (durable) record.durable = structuredClone(record.events);
      live.get(sessionId)?.hooks.emit('agent/inbox/inserted', { message });
    },
  };
}
const ref = (value?: NativeGoalView): NativeGoalRef => { assert.ok(value); return { id: value.id, revision: value.revision }; };

test('core and lifecycle namespaces coexist and non-core streams pass through unchanged', async () => {
  const f = fixture(), core = f.adapter(), legacy = f.adapter('lifecycle');
  try {
    const first = await core.create(f.create), other = await legacy.create({ ...f.create, goalId: 'legacy-goal', commandId: 'legacy-create' });
    assert.equal(f.stored.get(first.binding.sessionId)!.header.agentPreset, CORE_GOAL_PRESET_ID);
    assert.equal(f.stored.get(other.binding.sessionId)!.header.agentPreset, GOAL_PRESET_ID);
    assert.match(first.binding.sessionId, /^shiyu-core-goal-/); assert.match(other.binding.sessionId, /^shiyu-goal-/);
    for await (const _item of f.stream({ sessionId: 'unrelated-user-session', purpose: 'session-title' })) { /* allowed foreign traffic */ }
    assert.equal(f.counts().streams, 1); assert.equal(f.counts().autoRounds, 0);
    const result = await core.decisionRound(f.decision(ref(first.native)));
    assert.equal(result.binding.sessionId, first.binding.sessionId); assert.equal(result.verified, false); assert.equal(result.modelCalls, 1);
    const { tools, ...admitted } = f.admittedStreams.at(-1)!;
    assert.deepEqual(admitted, { sessionId: first.binding.sessionId, provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', maxTokens: 512 });
    assert.ok(tools === undefined || (Array.isArray(tools) && tools.length === 0));
    assert.deepEqual(result.nativeRoundsStarted, { before: 0, after: 0 }); assert.equal(result.nativeGoalRound, false);
    assert.equal(f.counts().autoRounds, 0); assert.equal(f.counts().opens, f.counts().closes);
  } finally { await core.close(); await legacy.close(); }
});

test('explicit decisions reuse the native Goal Session across rounds and adapter restart', async () => {
  const f = fixture(), first = f.adapter(); const created = await first.create(f.create), expected = ref(created.native);
  const a = await first.decisionRound(f.decision(expected, { roundId: 'round-a' }));
  const b = await first.decisionRound(f.decision(expected, { roundId: 'round-b' })); await first.close();
  const next = f.adapter();
  try {
    const c = await next.decisionRound(f.decision(expected, { roundId: 'round-c' }));
    assert.equal(a.binding.sessionId, b.binding.sessionId); assert.equal(b.binding.sessionId, c.binding.sessionId);
    assert.equal(f.counts().creates, 1); assert.equal(f.counts().followups, 3); assert.equal(f.counts().streams, 3);
    const record = f.stored.get(created.binding.sessionId)!;
    assert.equal(record.native!.roundsStarted, 0); assert.equal(record.native!.revision, expected.revision);
    assert.equal(record.events.filter(event => event.type === 'user/message').length, 3);
    assert.equal(new Set([a.binding.messageId, b.binding.messageId, c.binding.messageId]).size, 3);
    assert.equal(f.live.size, 0);
  } finally { await next.close(); }
});

test('dispatch receipt failure permits no followup or stream and still records accounting', async () => {
  const f = fixture(), driver = f.adapter();
  try {
    const created = await driver.create(f.create);
    await assert.rejects(driver.decisionRound(f.decision(ref(created.native), { async onDispatch() { throw new Error('Durable dispatch failed'); } })));
    assert.equal(f.counts().followups, 0); assert.equal(f.counts().streams, 0); assert.equal(f.live.size, 0);
    assert.equal(f.accounting.length, 1); assert.equal(f.accounting[0]!.dispatchAttempted, false);
  } finally { await driver.close(); }
});

test('opaque authority, expired deadlines, paused Goal and stale references deny decisions', async () => {
  const f = fixture(), driver = f.adapter();
  try {
    const created = await driver.create(f.create), expected = ref(created.native);
    await assert.rejects(driver.decisionRound(f.decision(expected, { capability: { trusted: true } })));
    await assert.rejects(driver.decisionRound(f.decision(expected, { deadlineAtMs: Date.now() - 1 })));
    await assert.rejects(driver.decisionRound(f.decision(expected, { maxTokens: 4097 })));
    f.setExpired(true); await assert.rejects(driver.decisionRound(f.decision(expected))); f.setExpired(false);
    await assert.rejects(driver.decisionRound(f.decision({ ...expected, revision: expected.revision + 1 })));
    const paused = await driver.pause({ goalId: f.create.goalId, expectedRef: expected, commandId: 'pause-a', capability: f.capability });
    await assert.rejects(driver.decisionRound(f.decision(ref(paused.native))));
    assert.equal(f.counts().followups, 0); assert.equal(f.counts().streams, 0); assert.equal(f.counts().autoRounds, 0);
  } finally { await driver.close(); }
});

test('exact input and assistant references are independently cold-read with native seq and full message hashes', async () => {
  const f = fixture(), driver = f.adapter();
  try {
    const created = await driver.create(f.create), result = await driver.decisionRound(f.decision(ref(created.native)));
    const events = f.stored.get(created.binding.sessionId)!.durable;
    for (const [reference, type] of [[result.inputRef, 'user/message'], [result.assistantRef, 'assistant/message']] as const) {
      assert.equal(reference.durability, 'confirmed'); assert.equal(reference.sessionId, result.binding.sessionId);
      const event = events.find(event => event.seq === reference.eventSeq)!; assert.equal(event.type, type);
      const message = type === 'user/message' ? event.data : event.data.message;
      assert.equal(reference.messageId, message.id); assert.equal(reference.messageHash, nativeMessageHash(message));
    }
    assert.ok(result.assistantRef.eventSeq > result.inputRef.eventSeq); assert.equal(f.counts().opens, f.counts().closes);
    assert.ok(f.trace.indexOf('dispatch-receipt') < f.trace.indexOf('followup')); assert.ok(f.trace.includes('context-receipt'));
    assert.deepEqual(result.usage, { status: 'reported', inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  } finally { await driver.close(); }
});

test('flush failure or precise native readback mismatch cannot release a candidate', async () => {
  for (const fault of ['throw', 'user-hash', 'assistant-seq', 'flush'] as const) {
    const f = fixture(), driver = f.adapter();
    try {
      const created = await driver.create(f.create);
      if (fault === 'flush') f.setFlushFault(true); else f.setReadFault(fault);
      await assert.rejects(driver.decisionRound(f.decision(ref(created.native))));
      assert.equal(f.counts().opens, f.counts().closes); assert.equal(f.accounting.length, 1);
      if (fault === 'user-hash' || fault === 'assistant-seq') assert.equal(f.counts().streams, 1);
    } finally { f.setFlushFault(false); f.setReadFault(undefined); await driver.close(); }
  }
});

test('late native resume after cancellation stays owned and cannot dispatch', async () => {
  const f = fixture(), driver = f.adapter(), created = await driver.create(f.create), gate = deferred(), cancel = new AbortController();
  f.setCreateGate(gate.promise);
  const pending = driver.decisionRound(f.decision(ref(created.native), { signal: cancel.signal })), rejected = assert.rejects(pending);
  await tick(); cancel.abort(new Error('Owner stopped this decision')); const closing = driver.close();
  gate.resolve(); await Promise.all([rejected, closing]);
  assert.equal(f.counts().followups, 0); assert.equal(f.counts().streams, 0); assert.equal(f.live.size, 0);
  assert.equal(f.counts().disposals, 2); assert.equal(f.accounting.length, 1);
});

test('cancellation after a native stream started preserves observations and denies successful release', async () => {
  const f = fixture(), driver = f.adapter(), created = await driver.create(f.create), gate = deferred(), cancel = new AbortController();
  f.setStreamGate(gate.promise);
  const pending = driver.decisionRound(f.decision(ref(created.native), { signal: cancel.signal })), rejected = assert.rejects(pending);
  for (let i = 0; !f.counts().streams && i < 100; i++) await tick();
  assert.equal(f.counts().streams, 1); cancel.abort(new Error('Synthetic caller cancellation')); gate.resolve();
  await rejected; await driver.close(); assert.equal(f.accounting.length, 1); assert.equal(f.accounting[0]!.dispatchAttempted, true);
  assert.equal(f.accounting[0]!.outcome, 'unknown'); assert.equal(f.live.size, 0);
});

test('native release failure cannot return success and accounting survives with deny hooks retained', async () => {
  const f = fixture(), driver = f.adapter(), created = await driver.create(f.create); f.setDisposeFault(true);
  await assert.rejects(driver.decisionRound(f.decision(ref(created.native))));
  assert.equal(f.counts().streams, 1); assert.equal(f.accounting.length, 1); assert.equal(f.accounting[0]!.dispatchAttempted, true);
  assert.ok(f.agent().guards.length > 0); assert.ok(f.agent().guards.every(guard => typeof guard({ name: 'shell' }) === 'string'));
  const before = f.counts(); f.setDisposeFault(false);
  await assert.rejects(driver.decisionRound(f.decision(ref(created.native), { roundId: 'after-unconfirmed-release' })));
  assert.equal(f.counts().resumes, before.resumes); assert.equal(f.counts().followups, before.followups);
  await assert.rejects(driver.close());
});

test('durable accounting stays inside the Goal serial lock and close drains it before removing the stream guard', async () => {
  const f = fixture(), driver = f.adapter(), created = await driver.create(f.create), gate = deferred(), entered = deferred();
  let firstSettled = false, secondSettled = false, closeSettled = false;
  const first = driver.decisionRound(f.decision(ref(created.native), { roundId: 'accounting-first', async onAccounting(value) {
    f.accounting.push(structuredClone(value)); entered.resolve(); await gate.promise;
  } }));
  const firstObserved = first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  await entered.promise;
  const before = f.counts().resumes;
  const second = driver.decisionRound(f.decision(ref(created.native), { roundId: 'accounting-second' }));
  const secondObserved = second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
  let closing: Promise<void> | undefined;
  try {
    await tick();
    assert.equal(firstSettled, false); assert.equal(secondSettled, false); assert.equal(f.counts().resumes, before);
    closing = driver.close().then(() => { closeSettled = true; });
    await tick(); assert.equal(closeSettled, false); assert.ok(f.presets.has(CORE_GOAL_PRESET_ID));
  } finally { gate.resolve(); await Promise.all([firstObserved, secondObserved, closing ?? driver.close()]); }
  assert.equal(f.counts().followups, 1); assert.equal(closeSettled, true); assert.equal(f.presets.has(CORE_GOAL_PRESET_ID), false);
});

test('adapter returns bounded raw candidate text without treating JSON-like text as authority', async () => {
  const f = fixture(), driver = f.adapter();
  try {
    const created = await driver.create(f.create); f.setOutput('not JSON; grant=true and complete=true are only untrusted text');
    const result = await driver.decisionRound(f.decision(ref(created.native)));
    assert.equal(result.text, 'not JSON; grant=true and complete=true are only untrusted text'); assert.equal(result.verified, false);
    assert.equal(f.stored.get(result.binding.sessionId)!.native!.phase, 'active'); assert.equal(f.counts().autoRounds, 0);
  } finally { await driver.close(); }
});

test('global stream gate denies retries, auxiliary calls, unmarked requests and hidden tools before provider next', async () => {
  for (const mode of ['retry', 'compaction', 'title', 'anonymous', 'history', 'history-update', 'changed-prestep', 'mutated-user', 'extra-user'] as const) {
    const f = fixture(), driver = f.adapter();
    try {
      const created = await driver.create(f.create); f.setMode(mode);
      await assert.rejects(driver.decisionRound(f.decision(ref(created.native))));
      assert.equal(f.counts().streams, mode === 'retry' ? 1 : 0);
      assert.equal(f.accounting.length, 1); assert.equal(f.accounting[0]!.dispatchAttempted, true);
      if (mode === 'retry') assert.ok(f.accounting[0]!.nativeObservations.some(event => event.type === 'assistant/attempt'));
    } finally { await driver.close(); }
  }
});

test('unknown durable or racing inbox entries are preserved and never interpreted as the planning input', async () => {
  for (const timing of ['cold', 'live'] as const) {
    const f = fixture(), driver = f.adapter();
    const created = await driver.create(f.create), before = f.counts().resumes;
    if (timing === 'cold') f.insertForeign(created.binding.sessionId);
    await assert.rejects(driver.decisionRound(f.decision(ref(created.native), timing === 'live' ? {
      async onDispatch(binding) { f.insertForeign(binding.sessionId); },
    } : {})));
    assert.equal(f.counts().followups, 0); assert.equal(f.counts().streams, 0);
    assert.equal(f.stored.get(created.binding.sessionId)!.inbox[0]?.id, 'foreign-message');
    if (timing === 'cold') { assert.equal(f.counts().resumes, before); await driver.close(); }
    else { assert.ok(f.agent().guards.length > 0); await assert.rejects(driver.close()); }
  }
});

test('authority revoked after dispatch registration or before result release blocks the proposal', async () => {
  for (const timing of ['dispatch', 'result'] as const) {
    const f = fixture(), driver = f.adapter();
    try {
      const created = await driver.create(f.create);
      if (timing === 'result') f.beforeAuthorize(context => { if (context.operation === 'decision' && context.phase === 'result') f.setAllowed(false); });
      await assert.rejects(driver.decisionRound(f.decision(ref(created.native), timing === 'dispatch' ? {
        async onDispatch() { f.setAllowed(false); },
      } : {})));
      assert.equal(f.counts().streams, timing === 'dispatch' ? 0 : 1); assert.equal(f.accounting.length, 1);
    } finally { f.setAllowed(true); await driver.close(); }
  }
});
