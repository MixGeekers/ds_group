import assert from 'node:assert/strict';
import test from 'node:test';
import { ShiyuSessionAdapter, REPLYER_PRESET_ID, defaultModel } from '../src/adapters/dsh/sessions.js';
import type {
  ContextLoadRequest, DshAgent, DshAgentContext, DshContext, DshSession, ReplyContextReceipt, ReplyRequest, SessionEvent,
} from '../src/adapters/dsh/sessions.js';
import type { NativeMessageInput, NativeUserMessage } from '../src/adapters/dsh/native-message.js';

// Native world double for the public reader/projector/Session/Agent contracts.
// No installed host, database, network or model is used. The reader and the
// official inbox fold are re-implemented from the fixed SDK contract so the
// product boundary is exercised independently of its own parsing helpers.
type Hook = (...args: any[]) => any;
class Hooks {
  listeners = new Map<string, Hook[]>();
  on(name: string, handler: Hook) { const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list); return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); }; }
  emit(name: string, ...args: any[]) { for (const hook of [...this.listeners.get(name) ?? []]) hook(...args); }
  waterfall(name: string, args: unknown[], terminal: () => any): any {
    const hooks = [...this.listeners.get(name) ?? []]; let index = 0;
    const next = (): any => index < hooks.length ? hooks[index++]!(...args, next) : terminal();
    return next();
  }
}
const pause = () => new Promise<void>(done => setImmediate(done));
const CWD = '/synthetic/history';
interface Rec {
  header: DshSession['header'];
  events: SessionEvent[];
  durable: SessionEvent[];
  inbox: NativeUserMessage[];
  title?: { title: string; source: { kind: string }; messageSeqs: number[]; eventSeq?: number };
  /** Exact decoded fork-inherited prefix length; absent means unseeded 0. */
  inherited?: number;
}
interface HistoryOptions {
  resumeSuffix?: boolean;
  onResume?: (record: Rec, append: (type: string, data: unknown) => SessionEvent) => void;
  pageCap?: number;
  readDelayMs?: number;
}
function replyerHeader(id: string): DshSession['header'] {
  return { version: 4, id, createdAt: 1, isSeeded: false, cwd: CWD, agentPreset: REPLYER_PRESET_ID };
}
/** Events that never touch the inbox; a valid long native history for replay. */
function syntheticHistory(count: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  let turn = 1;
  while (events.length < count) {
    const seq = (): number => events.length;
    events.push({ seq: seq(), type: 'turn/start', data: { turn }, time: seq() + 1 });
    events.push({ seq: seq(), type: 'user/message', data: { id: `seed-user-${seq()}`, role: 'user', content: [{ type: 'text', text: `synthetic seed ${seq()}` }], source: { kind: 'user' } }, surfaceOp: 'append', time: seq() });
    events.push({ seq: seq(), type: 'assistant/message', data: { message: { id: `seed-assistant-${seq()}`, role: 'assistant', content: [{ type: 'text', text: 'synthetic seed reply' }] } }, time: seq() });
    events.push({ seq: seq(), type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, time: seq() });
    turn++;
  }
  return events.slice(0, count);
}
/** The fixed SDK's crash-recovery closers for an open tail turn. */
function interruptedClosers(events: SessionEvent[]): SessionEvent[] {
  let openTurn: number | null = null, openStep: number | null = null;
  for (const event of events) {
    if (event.type === 'turn/start') { openTurn = event.data.turn; openStep = null; }
    else if (event.type === 'turn/end') { openTurn = null; openStep = null; }
    else if (event.type === 'step/start') openStep = event.data.step;
    else if (event.type === 'step/end') openStep = null;
  }
  const last = events.at(-1);
  if (openTurn === null || last === undefined) return [];
  const closers: SessionEvent[] = [];
  if (openStep !== null) closers.push({ seq: last.seq! + 1, type: 'step/end', data: { turn: openTurn, step: openStep }, time: last.time });
  closers.push({ seq: last.seq! + closers.length + 1, type: 'turn/end', data: { turn: openTurn, reason: { kind: 'interrupted' } }, time: last.time });
  return closers;
}
function fixture(options: HistoryOptions = {}) {
  const global = new Hooks(), records = new Map<string, Rec>(), live = new Map<string, DshAgent>(), locals = new Map<string, Hooks>();
  const titles = new Map<string, Rec['title']>(), official = new WeakSet<object>(), bindings: { count: number } = { count: 0 };
  const counts = {
    creates: 0, resumes: 0, followups: 0, streams: 0, opens: 0, closes: 0, flushes: 0, reads: 0, directAppends: 0,
    maintenances: 0, disposes: 0, modelRequests: 0, titleAppends: 0,
  };
  const appendsByFactory = { value: 0 };
  const appendInternal = (id: string, type: string, data: unknown, surfaceOp?: string): SessionEvent => {
    const record = records.get(id)!;
    const event: SessionEvent = { seq: record.events.length, type, data: structuredClone(data), time: 1_000 + record.events.length, ...(surfaceOp ? { surfaceOp } : {}) };
    record.events.push(event);
    const agent = live.get(id);
    if (agent) { locals.get(id)!.emit('session/event', agent.session, event); global.emit('session/event', agent.session, event); }
    return event;
  };
  const appendDurable = (id: string, type: string, data: unknown, surfaceOp?: string): SessionEvent => {
    const event = appendInternal(id, type, data, surfaceOp);
    records.get(id)!.durable = structuredClone(records.get(id)!.events);
    return event;
  };
  const seed = (id: string, events: SessionEvent[]) => {
    records.set(id, { header: replyerHeader(id), events: structuredClone(events), durable: structuredClone(events), inbox: [] });
    return records.get(id)!;
  };
  const projection = (events: SessionEvent[], baseSeq: number) => {
    const lanes: Record<string, NativeUserMessage[]> = { 'next-turn': [], 'next-step': [] };
    events.forEach((event, index) => {
      if (event.seq !== baseSeq + index) throw new Error('session projection cannot restore across missing seq');
      if (event.type !== 'agent/inbox/spliced') return;
      const splice = event.data as { target: string; start: number; removedCount?: number; inserted: NativeUserMessage[] };
      const lane = lanes[splice.target]; if (!lane) throw new Error('invalid inbox target');
      const removed = splice.removedCount ?? 0;
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > lane.length || !Number.isSafeInteger(removed) || removed < 0 || splice.start + removed > lane.length) throw new Error('invalid inbox splice');
      lane.splice(splice.start, removed, ...structuredClone(splice.inserted ?? []));
      const ids = new Set<string>();
      for (const pending of [...lanes['next-turn']!, ...lanes['next-step']!]) { if (ids.has(pending.id)) throw new Error('duplicate pending inbox message'); ids.add(pending.id); }
    });
    return { snapshot: { asOfSeq: events.at(-1)?.seq ?? baseSeq - 1, values: { inbox: lanes } } };
  };
  const make = async (agentOptions: any, resume: boolean) => {
    const id = resume ? agentOptions.resumeSessionId : agentOptions.sessionId;
    if (!resume) records.set(id, { header: replyerHeader(id), events: [], durable: [], inbox: [] });
    const record = records.get(id); assert.ok(record, 'native Session must exist');
    if (resume && options.resumeSuffix !== false) {
      for (const closer of interruptedClosers(record.events)) appendInternal(id, closer.type, closer.data, closer.surfaceOp);
      if (record.events.at(-1)?.type !== 'session/end-seed') appendInternal(id, 'session/end-seed', {});
    }
    if (resume) options.onResume?.(record, (type, data) => appendInternal(id, type, data));
    if (resume) counts.resumes++; else counts.creates++;
    const hooks = new Hooks(); locals.set(id, hooks);
    let idle = Promise.resolve(), cancelled = false, maintenance: AbortController | undefined;
    const session: DshSession = {
      id, header: record.header, inheritedEventCount: record.inherited ?? 0,
      get seq() { return record.events.length; },
      append(type, data, appendOptions) { counts.directAppends++; return appendInternal(id, type, data, appendOptions?.surfaceOp); },
      deriveMessages: () => record.events.flatMap(event => event.type === 'user/message' ? [event.data]
        : event.type === 'assistant/message' ? [event.data.message] : []),
    };
    const agentContext: DshAgentContext = {
      on: (name, handler) => hooks.on(name, handler),
      tools: { presentAs: () => () => {}, schemas: () => [], restrict: () => () => {}, guard: () => () => {} },
      systemPrompt: {
        suppressRuntimeContext: () => () => {}, section: () => () => {},
        assemble: async (...args: any[]) => hooks.waterfall('system-prompt/assemble', [{ tools: [] }, ...args], () => ({ tools: [] })),
      },
    };
    const agent: DshAgent = {
      id, session, ctx: agentContext, status: 'idle',
      inbox: {
        get nextTurn() { return record.inbox; }, get nextStep() { return []; },
        remove(messageId: string) {
          const index = record.inbox.findIndex(item => item.id === messageId); if (index < 0) return false;
          record.inbox.splice(index, 1);
          appendInternal(id, 'agent/inbox/spliced', { target: 'next-turn', start: index, removedCount: 1, inserted: [], outcome: 'canceled' });
          return true;
        },
      },
      followup(message: NativeUserMessage) {
        counts.followups++; cancelled = false; agent.status = 'running'; record.inbox.push(structuredClone(message));
        appendInternal(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] });
        hooks.emit('agent/inbox/inserted', { message });
        idle = (async () => {
          try {
            const claimed = record.inbox.splice(0);
            appendInternal(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: claimed.length, inserted: [] });
            const decision = await hooks.waterfall('agent/pre-step', [{ messages: claimed }], () => ({ kind: 'enter', messages: claimed }));
            if (decision.kind !== 'enter') { appendInternal(id, 'turn/end', { reason: { kind: 'blocked' } }); return; }
            const request = await hooks.waterfall('agent/request', [{}], () => ({}));
            for (const item of claimed) appendInternal(id, 'user/message', item, 'append');
            const main: Record<string, unknown> = {
              ...request, sessionId: id, tools: [], purpose: undefined,
              messages: structuredClone(session.deriveMessages!()),
            };
            official.add(main); counts.modelRequests++;
            for await (const _part of global.waterfall('llm/stream', [main], () => (async function* () { yield { type: 'synthetic-chunk' }; })())) { /* native transport double */ }
            counts.streams++;
            appendInternal(id, 'assistant/message', { message: { id: `assistant-${counts.followups}`, role: 'assistant', content: [{ type: 'text', text: 'synthetic bounded reply' }] }, usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } });
            appendInternal(id, 'turn/end', { reason: { kind: cancelled ? 'cancelled' : 'completed' } });
          } catch { appendInternal(id, 'turn/end', { reason: { kind: 'error' } }); }
          finally { agent.status = 'idle'; }
        })();
      },
      whenIdle: () => idle,
      async runMaintenance<T>(job: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
        if (maintenance) throw new Error('Native Agent already has active work');
        counts.maintenances++; maintenance = new AbortController();
        try { return await job(maintenance.signal); } finally { maintenance = undefined; }
      },
      cancel(_cause, cancelOptions) {
        cancelled = true; maintenance?.abort(new Error('Native maintenance cancelled'));
        if (!cancelOptions?.keepInbox && record.inbox.length) {
          const removed = record.inbox.length; record.inbox.splice(0);
          appendInternal(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: removed, inserted: [], outcome: 'canceled' });
        }
      },
    };
    live.set(id, agent);
    await agentOptions.setup(agentContext, agent);
    global.emit('agent/created', { agent });
    return {
      agent,
      async dispose() { counts.disposes++; agent.cancel({ kind: 'hook', reason: 'disposed' }); await idle; live.delete(id); record.durable = structuredClone(record.events); },
    };
  };
  const ctx: DshContext = {
    on: (name, handler) => global.on(name, handler),
    agents: { create: value => make(value, false), resume: value => make(value, true), list: () => [...live.values()] },
    get(name: string) {
      if (name === 'agentPresets') return { register: async () => () => {} };
      if (name === 'llm') return { resolveCallConfig: async (model: unknown) => model };
      if (name === 'workingDirectory') return { get: () => CWD };
      if (name === 'sessions') return {
        async flush(session: DshSession) { counts.flushes++; const record = records.get(session.id)!; record.durable = structuredClone(record.events); return true; },
        get(id: string) { return live.get(id)?.session; },
      };
      if (name === 'sessionPersistence') return {
        async open(id: string, mode: string, openOptions: { signal?: AbortSignal }) {
          openOptions?.signal?.throwIfAborted();
          assert.equal(mode, 'read'); const record = records.get(id); if (!record) throw new Error('Native Session not found');
          counts.opens++;
          return {
            header: structuredClone(record.header), inheritedEventCount: record.inherited ?? 0,
            async read(offset: number, length: number, readOptions: { signal?: AbortSignal }) {
              readOptions?.signal?.throwIfAborted();
              if (options.readDelayMs !== undefined) {
                const signal = readOptions?.signal;
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, options.readDelayMs);
                  const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
                  signal?.addEventListener('abort', abort, { once: true });
                });
              }
              counts.reads++;
              const capped = Math.min(length, options.pageCap ?? Number.MAX_SAFE_INTEGER);
              return { eventState: 'detached', events: structuredClone(record.durable.slice(offset, offset + capped)) };
            },
            async close() { counts.closes++; },
          };
        },
      };
      if (name === 'sessionProjections') return { async restore(_initial: unknown, events: SessionEvent[], baseSeq: number) { return projection(events, baseSeq); } };
      if (name === 'sessionTitle') return {
        rename(session: DshSession, title: string) {
          counts.titleAppends++;
          const event = appendInternal(session.id, 'session/title', { title, messageSeqs: [], source: { kind: 'user' } });
          const snapshot = { title, source: { kind: 'user' }, messageSeqs: [], eventSeq: event.seq };
          titles.set(session.id, snapshot); return structuredClone(snapshot);
        },
        get(session: DshSession) { const value = titles.get(session.id); return value && structuredClone(value); },
      };
    },
  };
  const messageFactory = (input: NativeMessageInput): NativeUserMessage => ({
    ...structuredClone(input), role: 'user', id: `native-load-${++appendsByFactory.value}`,
  });
  const adapter = () => new ShiyuSessionAdapter({
    ctx, cwd: CWD, createUserMessage: messageFactory,
    isAgentLoopRequest: request => Boolean(request) && typeof request === 'object' && official.has(request as object),
    bindings: { async load() { return []; }, async save() { bindings.count++; } },
  });
  return {
    ctx, records, live, adapter, counts, factory: messageFactory,
    seed, appendInternal, appendDurable,
    recordOf: (id: string) => records.get(id)!,
    setTitle(id: string, title = '识雨 · 受限回复') {
      const record = records.get(id)!;
      const event = appendInternal(id, 'session/title', { title, messageSeqs: [], source: { kind: 'user' } });
      record.durable = structuredClone(record.events);
      titles.set(id, { title, source: { kind: 'user' }, messageSeqs: [], eventSeq: event.seq });
    },
    titleSnapshot: (id: string) => titles.get(id),
  };
}
function loadRequest(sessionId: string | undefined, overrides: Partial<ContextLoadRequest> = {}) {
  const receipted: ReplyContextReceipt[] = [], phases: string[] = [];
  const request: ContextLoadRequest = {
    businessId: 'history-business', scope: 'local-owner', prompt: 'Authorized long history context', deadlineMs: Date.now() + 20_000,
    ...(sessionId === undefined ? {} : { }),
    context: {
      operationId: 'load-long', contextTokenId: 'capture-long', sessionEpoch: 1,
      ...(sessionId === undefined ? {} : { expectedSessionId: sessionId }),
      onBound() {}, authorize(check) { phases.push(check.phase); }, onContextDurable(value) { receipted.push(structuredClone(value)); },
    }, ...overrides,
  };
  return { request, receipted, phases };
}
function replyRequest(sessionId: string | undefined, overrides: Partial<ReplyRequest> = {}) {
  const receipted: ReplyContextReceipt[] = [], phases: string[] = [];
  const request: ReplyRequest = {
    businessId: 'history-reply', scope: 'local-owner', prompt: 'Authorized long history reply', deadlineMs: Date.now() + 20_000,
    context: {
      operationId: 'reply-long', contextTokenId: 'capture-reply', sessionEpoch: 1,
      ...(sessionId === undefined ? {} : { expectedSessionId: sessionId }),
      onBound() {}, authorize(check) { phases.push(check.phase); }, onContextDurable(value) { receipted.push(structuredClone(value)); },
    }, ...overrides,
  };
  return { request, receipted, phases };
}
const suffix = (events: SessionEvent[]) => events.filter(event => ['user/message', 'assistant/message'].includes(event.type) && event.surfaceOp === 'append');

test('load-only cold recovery crosses the old 2048 cap: 2047/2048/2049 and a far larger history succeed', async () => {
  for (const count of [2047, 2048, 2049, 5000]) {
    // The backend legally returns short pages; only an empty read is EOF.
    const world = fixture({ pageCap: 100 }), adapter = world.adapter();
    const id = `shiyu-replyer-history-${count}`;
    world.seed(id, syntheticHistory(count));
    world.setTitle(id);
    try {
      const loaded = await adapter.loadContextOnly(loadRequest(id).request);
      assert.equal(loaded.mode, 'load-only'); assert.equal(loaded.inferenceRequested, false); assert.equal(loaded.followupRequested, false);
      assert.equal(loaded.binding.sessionId, id);
      const record = world.recordOf(id);
      // The final receipt is the last durable event regardless of resume artifacts.
      assert.equal(loaded.contextReceipt.userMessageSeq, record.durable.length - 1);
      assert.ok(record.durable.length > count, 'the loaded message extends the seeded history');
      const event = record.durable[loaded.contextReceipt.userMessageSeq]!;
      assert.equal(event.type, 'user/message'); assert.equal(event.data.id, loaded.contextReceipt.messageId);
      assert.equal(world.counts.followups, 0); assert.equal(world.counts.modelRequests, 0);
      assert.equal(world.counts.maintenances, 1);
    } finally { await adapter.close(); }
  }
});

test('load-only recovery accepts a seeded inherited fork prefix and keeps the live inherited count', async () => {
  const world = fixture(), adapter = world.adapter(), id = 'shiyu-replyer-inherited-seed';
  const inherited = syntheticHistory(12);
  const marked: SessionEvent[] = [...inherited, { seq: 12, type: 'session/end-seed', data: { inherited: true }, time: 13 }];
  const record = world.seed(id, marked);
  record.header = { ...record.header, isSeeded: true };
  record.inherited = 12;
  try {
    const loaded = await adapter.loadContextOnly(loadRequest(id).request);
    assert.equal(loaded.binding.sessionId, id);
    assert.equal(world.recordOf(id).durable[loaded.contextReceipt.userMessageSeq]!.type, 'user/message');
  } finally { await adapter.close(); }
});

test('load-only recovery accepts a legitimate native resume suffix (interrupted closers, end-seed, fixed title)', async () => {
  const world = fixture(), adapter = world.adapter();
  const id = 'shiyu-replyer-resume-suffix';
  const history = syntheticHistory(30);
  history.push({ seq: 30, type: 'turn/start', data: { turn: 99 }, time: 31 });
  world.seed(id, history);
  try {
    const loaded = await adapter.loadContextOnly(loadRequest(id).request);
    assert.equal(loaded.binding.sessionId, id);
    const record = world.recordOf(id);
    const appended = record.durable.slice(31).map(event => event.type);
    // interrupted turn/end + end-seed + fixed title pin + the loaded message.
    assert.deepEqual(appended, ['turn/end', 'session/end-seed', 'session/title', 'user/message']);
    assert.equal(loaded.contextReceipt.userMessageSeq, 34);
  } finally { await adapter.close(); }
});

test('load-only refuses a foreign user/message appended during the append authorization await without deleting it', async () => {
  const world = fixture(), adapter = world.adapter();
  const id = 'shiyu-replyer-foreign-race';
  world.seed(id, syntheticHistory(12)); world.setTitle(id);
  const foreign: SessionEvent = { seq: 13, type: 'user/message', surfaceOp: 'append', time: 9, data: { id: 'foreign-direct-input', role: 'user', content: [{ type: 'text', text: 'foreign synthetic body' }], source: { kind: 'user' } } };
  const fixtureLoad = loadRequest(id);
  fixtureLoad.request.context.authorize = check => {
    fixtureLoad.phases.push(check.phase);
    if (check.phase === 'append') world.appendDurable(id, 'user/message', foreign.data, 'append');
  };
  try {
    await assert.rejects(adapter.loadContextOnly(fixtureLoad.request), /history|Native history|changed/i);
    assert.equal(fixtureLoad.receipted.length, 0);
    assert.equal(world.counts.followups, 0); assert.equal(world.counts.modelRequests, 0);
    const record = world.recordOf(id);
    assert.ok(record.events.some(event => event.type === 'user/message' && event.data?.id === 'foreign-direct-input'), 'foreign history is preserved, never deleted');
  } finally { await adapter.close(); }
});

test('load-only refuses a foreign user/message appended while its own append is being flushed', async () => {
  const world = fixture(), adapter = world.adapter();
  const id = 'shiyu-replyer-flush-race';
  world.seed(id, syntheticHistory(16)); world.setTitle(id);
  let injected = false;
  const originalFlush = (world.ctx.get as any).bind(world.ctx);
  // Wrap the sessions/flush service to append an external user message after
  // our exact message has entered the log but before the ack.
  const flushService = { async flush(session: DshSession) {
    world.counts.flushes++;
    const record = world.recordOf(session.id);
    if (!injected && record.events.some(event => event.type === 'user/message' && String(event.data?.id).startsWith('native-load-'))) {
      injected = true; world.appendDurable(session.id, 'user/message', { id: 'foreign-during-flush', role: 'user', content: [{ type: 'text', text: 'foreign body' }], source: { kind: 'user' } }, 'append');
    }
    record.durable = structuredClone(record.events); return true;
  } };
  const originalGet = (world.ctx as unknown as { get(name: string): unknown }).get;
  (world.ctx as unknown as { get(name: string): unknown }).get = (name: string) => name === 'sessions' ? { ...flushService, get: (sessionId: string) => world.live.get(sessionId)?.session } : originalGet(name);
  try {
    const fixtureLoad = loadRequest(id);
    await assert.rejects(adapter.loadContextOnly(fixtureLoad.request), /history|Native history|changed/i);
    assert.equal(fixtureLoad.receipted.length, 0);
    assert.ok(injected, 'the foreign append window was exercised');
    assert.ok(world.recordOf(id).events.some(event => event.data?.id === 'foreign-during-flush'));
  } finally { (world.ctx as unknown as { get(name: string): unknown }).get = originalGet; await adapter.close(); }
});

test('load-only refuses a same-length early rewrite that lands between the pre-resume cut and the resumed live Session', async () => {
  const world = fixture({ onResume(record) {
    if (record.events.length > 4) {
      const changed = { ...record.events[3]!, data: { changed: true } };
      record.events[3] = changed; record.durable[3] = structuredClone(changed);
    }
  } });
  const adapter = world.adapter(), id = 'shiyu-replyer-rewrite';
  world.seed(id, syntheticHistory(20)); world.setTitle(id);
  const fixtureLoad = loadRequest(id);
  try {
    await assert.rejects(adapter.loadContextOnly(fixtureLoad.request), /history|Native history|changed/i);
    assert.equal(fixtureLoad.receipted.length, 0); assert.equal(world.counts.followups, 0);
  } finally { await adapter.close(); }
});

test('load-only refuses a persisted prefix that shrinks before the paused Session resumes', async () => {
  const world = fixture({ onResume(record) { record.events = record.events.slice(0, 10); record.durable = structuredClone(record.events); } });
  const adapter = world.adapter(), id = 'shiyu-replyer-shrink';
  world.seed(id, syntheticHistory(20)); world.setTitle(id);
  const fixtureLoad = loadRequest(id);
  try {
    await assert.rejects(adapter.loadContextOnly(fixtureLoad.request), /history|Native history|changed/i);
    assert.equal(fixtureLoad.receipted.length, 0);
  } finally { await adapter.close(); }
});

test('load-only refuses an unknown pending inbox entry before resuming or acknowledging', async () => {
  const world = fixture(), adapter = world.adapter(), id = 'shiyu-replyer-pending';
  world.seed(id, syntheticHistory(8)); world.setTitle(id);
  const pending: NativeUserMessage = { id: 'pending-foreign', role: 'user', content: [{ type: 'text', text: 'pending foreign' }], source: { kind: 'user' } };
  world.recordOf(id).inbox.push(structuredClone(pending));
  world.appendDurable(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [pending] });
  const fixtureLoad = loadRequest(id);
  try {
    await assert.rejects(adapter.loadContextOnly(fixtureLoad.request), /Pending native inbox|Unknown native inbox/);
    assert.equal(world.counts.resumes, 0); assert.equal(fixtureLoad.receipted.length, 0);
    assert.equal(world.recordOf(id).inbox[0]!.id, 'pending-foreign');
  } finally { await adapter.close(); }
});

test('replyer cold recovery crosses the old 2048 cap and confirms exact message, flush and receipt', async () => {
  for (const count of [2048, 2049]) {
    const world = fixture(), adapter = world.adapter(), id = `shiyu-replyer-generate-${count}`;
    world.seed(id, syntheticHistory(count)); world.setTitle(id);
    const fixtureReply = replyRequest(id);
    try {
      const result = await adapter.generateReply(fixtureReply.request);
      assert.equal(result.binding.sessionId, id); assert.equal(result.text, 'synthetic bounded reply');
      assert.equal(fixtureReply.receipted.length, 1); assert.equal(result.contextReceipt?.durability, 'confirmed');
      assert.equal(world.counts.modelRequests, 1); assert.equal(world.counts.followups, 1);
      assert.ok(result.assistantRef!.eventSeq > result.contextReceipt!.userMessageSeq);
      assert.equal(world.counts.opens, world.counts.closes);
      const record = world.recordOf(id);
      assert.equal(record.durable[result.contextReceipt!.userMessageSeq]!.type, 'user/message');
      assert.equal(record.durable[result.contextReceipt!.userMessageSeq]!.data.id, result.contextReceipt!.messageId);
      assert.equal(record.durable[result.assistantRef!.eventSeq]!.data.message.id, result.assistantRef!.messageId);
    } finally { await adapter.close(); }
  }
});

test('replyer ignores no foreign input: a direct user/message appended during onBound blocks the receipt and dispatch', async () => {
  const world = fixture(), adapter = world.adapter(), id = 'shiyu-replyer-onbound-race';
  world.seed(id, syntheticHistory(24)); world.setTitle(id);
  const fixtureReply = replyRequest(id);
  fixtureReply.request.context!.onBound = binding => {
    world.appendDurable(binding.sessionId, 'user/message', { id: 'foreign-onbound', role: 'user', content: [{ type: 'text', text: 'foreign body' }], source: { kind: 'user' } }, 'append');
  };
  try {
    await assert.rejects(adapter.generateReply(fixtureReply.request), /history|Native history|changed/i);
    assert.equal(fixtureReply.receipted.length, 0); assert.equal(world.counts.modelRequests, 0); assert.equal(world.counts.followups, 0);
    assert.ok(world.recordOf(id).events.some(event => event.data?.id === 'foreign-onbound'));
  } finally { await adapter.close(); }
});

test('replyer recovery refuses a foreign user/message mixed into the legitimate resume suffix', async () => {
  const world = fixture({ onResume(_record, append) { append('user/message', { id: 'foreign-mixed-suffix', role: 'user', content: [{ type: 'text', text: 'foreign suffix body' }], source: { kind: 'user' } }); } });
  const adapter = world.adapter(), id = 'shiyu-replyer-mixed-suffix';
  world.seed(id, syntheticHistory(20)); world.setTitle(id);
  const fixtureReply = replyRequest(id);
  try {
    await assert.rejects(adapter.generateReply(fixtureReply.request), /history|Native history|changed/i);
    assert.equal(fixtureReply.receipted.length, 0); assert.equal(world.counts.modelRequests, 0);
  } finally { await adapter.close(); }
});

test('load-only succeeds on an empty history and preserves the same native identity', async () => {
  const world = fixture(), adapter = world.adapter();
  const fixtureLoad = loadRequest(undefined);
  try {
    const loaded = await adapter.loadContextOnly(fixtureLoad.request);
    assert.match(loaded.binding.sessionId, /^shiyu-replyer-/); assert.equal(world.counts.creates, 1);
    assert.equal(loaded.contextReceipt.userMessageSeq, 1); // empty log -> fixed title at 0 -> message at 1
    assert.equal(world.recordOf(loaded.binding.sessionId).durable[0]!.type, 'session/title');
    assert.equal(world.recordOf(loaded.binding.sessionId).durable[1]!.type, 'user/message');
  } finally { await adapter.close(); }
});

test('load-only resumes the same business Session after an adapter restart and keeps the explicit cut', async () => {
  const world = fixture();
  const first = world.adapter(), id = 'shiyu-replyer-restart';
  world.seed(id, syntheticHistory(10)); world.setTitle(id);
  try { await first.loadContextOnly(loadRequest(id).request); } finally { await first.close(); }
  const second = world.adapter();
  try {
    const loaded = await second.loadContextOnly(loadRequest(id).request);
    assert.equal(loaded.binding.sessionId, id); assert.equal(world.counts.resumes >= 1, true);
    assert.equal(world.counts.creates, 0);
  } finally { await second.close(); }
});

test('cancellation during a bounded long-history cold read never returns a load receipt', async () => {
  const world = fixture({ pageCap: 100, readDelayMs: 4 }), adapter = world.adapter(), id = 'shiyu-replyer-cancel-long';
  world.seed(id, syntheticHistory(900)); world.setTitle(id);
  const controller = new AbortController(), fixtureLoad = loadRequest(id, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('owner stopped long recovery')), 20);
  try {
    await assert.rejects(adapter.loadContextOnly(fixtureLoad.request), /owner stopped long recovery|cancelled/);
    assert.equal(fixtureLoad.receipted.length, 0); assert.equal(world.counts.followups, 0);
    assert.equal(world.counts.opens >= world.counts.closes, true);
  } finally { await adapter.close(); }
});
