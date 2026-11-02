import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ShiyuSessionAdapter } from '../src/adapters/dsh/sessions.js';
import type { DshAgent, DshAgentContext, DshContext, DshSession, ReplyContextReceipt, ReplyRequest, SessionBinding, SessionEvent } from '../src/adapters/dsh/sessions.js';
import type { NativeMessageInput, NativeUserMessage } from '../src/adapters/dsh/native-message.js';

// Public native hook/persistence boundary doubles only. No host, provider or model.
type Hook = (...args: any[]) => any;
class Hooks {
  handlers = new Map<string, Hook[]>();
  on(name: string, handler: Hook) {
    const list = this.handlers.get(name) ?? []; list.push(handler); this.handlers.set(name, list);
    return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
  }
  emit(name: string, ...args: any[]) { for (const hook of [...this.handlers.get(name) ?? []]) hook(...args); }
  waterfall(name: string, args: unknown[], terminal: () => any): any {
    const hooks = [...this.handlers.get(name) ?? []]; let index = 0;
    const next = (): any => index < hooks.length ? hooks[index++]!(...args, next) : terminal();
    return next();
  }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
interface RecordState { header: DshSession['header']; events: SessionEvent[]; durable: SessionEvent[]; inbox: NativeUserMessage[] }
type Mode = 'normal' | 'no-stream' | 'retry' | 'second-request' | 'anonymous' | 'title' | 'compaction' | 'wrong-model' | 'tools' | 'tool-history' | 'wrong-session'
  | 'changed-input' | 'extra-before' | 'extra-after' | 'missing-input' | 'duplicate-input' | 'committed-extra-before' | 'committed-extra-after'
  | 'cwd' | 'changed-cwd-context' | 'late-cwd';
function fixture() {
  const global = new Hooks(), records = new Map<string, RecordState>(), live = new Map<string, DshAgent>(), locals = new Map<string, Hooks>();
  const official = new WeakSet<object>(), bindings: SessionBinding[] = [], titles = new Map<string, unknown>(), receipts: ReplyContextReceipt[] = [];
  let mode: Mode = 'normal', usage: Record<string, unknown> = { inputTokens: 7, outputTokens: 4, totalTokens: 11 };
  let diagnostic: string | undefined, corruptAssistantRead = false, failDispose = false, streamFailure = false;
  let currentCwd = '/synthetic/replyer', corruptContextRead = false;
  let streamGate: Promise<void> | undefined, entered: (() => void) | undefined, cancelled = false;
  const counts = { creates: 0, resumes: 0, followups: 0, providerEntries: 0, requests: 0, flushes: 0, opens: 0, closes: 0, disposes: 0, contextReads: 0 };
  const preparedRequests: { sessionId: string; messages: unknown[] }[] = [];
  const cwdMessage = (cwd = '/synthetic/replyer') => {
    const text = `Current working directory: ${JSON.stringify(cwd)}.`;
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${text}` }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text }] } };
  };
  const extraInput = () => ({ id: 'unexpected-input', role: 'user', content: [{ type: 'text', text: 'unexpected body' }], source: { kind: 'user' } });
  const append = (id: string, type: string, data: unknown, surfaceOp?: string): SessionEvent => {
    const row = records.get(id)!, event: SessionEvent = { seq: row.events.length, type, data: structuredClone(data), ...(surfaceOp ? { surfaceOp } : {}) };
    row.events.push(event); global.emit('session/event', live.get(id)?.session, event);
    if (live.has(id)) locals.get(id)!.emit('session/event', live.get(id)!.session, event);
    return event;
  };
  const stream = (request: object): AsyncIterable<unknown> => global.waterfall('llm/stream', [request], () => (async function* () {
    const prepared = request as { sessionId: string; messages: unknown[] };
    preparedRequests.push({ sessionId: prepared.sessionId, messages: structuredClone(prepared.messages) });
    counts.providerEntries++; entered?.(); if (streamGate) await streamGate;
    if (streamFailure) throw new Error('synthetic primary stream failed');
    yield { type: 'synthetic-chunk' };
  })());
  const make = async (options: any, resume: boolean) => {
    const id = resume ? options.resumeSessionId : options.sessionId;
    if (!resume) records.set(id, { header: { version: 4, id, createdAt: 1, isSeeded: false, cwd: options.meta?.cwd, agentPreset: options.meta?.agentPreset }, events: [], durable: [], inbox: [] });
    const row = records.get(id); assert.ok(row);
    const hooks = new Hooks(); locals.set(id, hooks);
    const session: DshSession = {
      id, header: row.header, inheritedEventCount: 0, get seq() { return row.events.length; },
      append(type, data, appendOptions) { return append(id, type, data, appendOptions?.surfaceOp); },
      deriveMessages: () => row.events.flatMap(event => event.type === 'user/message'
        ? [event.data] : event.type === 'assistant/message' ? [event.data.message] : []),
    };
    const ctx: DshAgentContext = { on: (name, callback) => hooks.on(name, callback),
      tools: { presentAs: () => () => {}, schemas: () => [], restrict: () => () => {}, guard: () => () => {} },
      systemPrompt: { suppressRuntimeContext: () => () => {}, section: () => () => {}, assemble: async () => ({ tools: [] }) } };
    let idle = Promise.resolve();
    const agent: DshAgent = { id, session, ctx, status: 'idle', inbox: {
      get nextTurn() { return row.inbox; }, nextStep: [], remove(messageId) {
        const index = row.inbox.findIndex(message => message.id === messageId); if (index < 0) return false;
        row.inbox.splice(index, 1); append(id, 'agent/inbox/spliced', { target: 'next-turn', start: index, removedCount: 1, inserted: [] }); return true;
      },
    }, followup(message) {
      cancelled = false; counts.followups++; agent.status = 'running'; row.inbox.push(structuredClone(message));
      append(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] });
      hooks.emit('agent/inbox/inserted', { message });
      idle = (async () => {
        try {
          const claimed = row.inbox.splice(0); append(id, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: claimed.length, inserted: [] });
          const decision = await hooks.waterfall('agent/pre-step', [{ messages: claimed }], () => ({ kind: 'enter', messages: claimed }));
          if (decision.kind !== 'enter') throw new Error('synthetic native step denied');
          const request = await hooks.waterfall('agent/request', [{}], () => { counts.requests++; return {}; });
          if (mode === 'second-request') await hooks.waterfall('agent/request', [{}], () => { counts.requests++; return {}; });
          if (mode === 'committed-extra-before') append(id, 'user/message', extraInput(), 'append');
          for (const item of claimed) append(id, 'user/message', item, 'append');
          if (mode === 'committed-extra-after') append(id, 'user/message', extraInput(), 'append');
          if (mode === 'cwd' || mode === 'changed-cwd-context') append(id, 'user/message', cwdMessage(mode === 'cwd' ? '/synthetic/replyer' : '/other'), 'append');
          const main: Record<string, any> = { ...request, sessionId: id, tools: [], messages: structuredClone(session.deriveMessages!()) };
          if (mode === 'changed-input') main.messages.at(-1).content[0].text += ' changed';
          if (mode === 'extra-before') main.messages.unshift(extraInput());
          if (mode === 'extra-after') main.messages.push(extraInput());
          if (mode === 'missing-input') main.messages.pop();
          if (mode === 'duplicate-input') main.messages.push(structuredClone(main.messages.at(-1)));
          if (mode !== 'anonymous') official.add(main);
          if (mode === 'title' || mode === 'compaction') main.purpose = mode === 'title' ? 'session-title' : 'compaction';
          if (mode === 'wrong-model') main.model = 'unapproved-model';
          if (mode === 'tools') main.tools = [{ name: 'shell' }];
          if (mode === 'tool-history') main.toolHistory = { tools: [], updates: [{ additions: [{ name: 'shell' }] }] };
          if (mode === 'wrong-session') main.sessionId = 'shiyu-replyer-unowned';
          if (mode !== 'no-stream') for await (const _part of stream(main)) { /* substitute transport only */ }
          if (mode === 'retry') for await (const _part of stream(main)) { /* second next() must remain unreachable */ }
          if (diagnostic) append(id, diagnostic, { usage: { totalTokens: 99 } });
          if (!cancelled) append(id, 'assistant/message', { message: { id: `synthetic-assistant-${counts.followups}`, role: 'assistant',
            content: [{ type: 'text', text: 'synthetic bounded reply' }] }, usage });
          if (mode === 'late-cwd') append(id, 'user/message', cwdMessage(), 'append');
          append(id, 'turn/end', { reason: { kind: cancelled ? 'cancelled' : 'completed' } });
        } catch { append(id, 'turn/end', { reason: { kind: 'error' } }); }
        finally { agent.status = 'idle'; }
      })();
    }, whenIdle: () => idle,
      async runMaintenance<T>(job: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
        if (agent.status !== 'idle') throw new Error('Native Agent already has active work');
        return job(new AbortController().signal);
      },
      cancel() { cancelled = true; } };
    live.set(id, agent); await options.setup(ctx, agent); global.emit('agent/created', { agent });
    if (resume) counts.resumes++; else counts.creates++;
    return { agent, async dispose() { counts.disposes++; if (failDispose) throw new Error('synthetic dispose failed'); await idle; live.delete(id); } };
  };
  const ctx: DshContext = { on: (name, callback) => global.on(name, callback), agents: { create: options => make(options, false), resume: options => make(options, true), list: () => [...live.values()] },
    get(name) {
      if (name === 'agentPresets') return { register: async () => () => {} };
      if (name === 'llm') return { resolveCallConfig: async (model: unknown) => model };
      if (name === 'workingDirectory') return { get: () => currentCwd };
      if (name === 'sessionTitle') return {
        rename(session: DshSession, title: string) { const value = { title, source: { kind: 'user' }, messageSeqs: [] }; titles.set(session.id, value); return value; },
        get: (session: DshSession) => titles.get(session.id),
      };
      if (name === 'sessions') return {
        async flush(session: DshSession) { counts.flushes++; const row = records.get(session.id)!; row.durable = structuredClone(row.events); return true; },
        get(id: string) { return live.get(id)?.session; },
      };
      if (name === 'sessionPersistence') return { async open(id: string, mode: string) {
        assert.equal(mode, 'read'); const row = records.get(id); assert.ok(row); counts.opens++;
        return { header: structuredClone(row.header), inheritedEventCount: 0, async read(offset: number, count: number) {
          const events = structuredClone(row.durable.slice(offset, offset + count));
          if (corruptAssistantRead && count === 1 && events[0]?.type === 'assistant/message') events[0].data.usage.totalTokens++;
          if (count === 1 && events[0]?.type === 'user/message' && events[0].data?.source?.kind === 'runtime-context') {
            counts.contextReads++; if (corruptContextRead) events[0].data.content[0].text += ' changed';
          }
          return { events, eventState: 'detached' };
        }, async close() { counts.closes++; } };
      } };
      if (name === 'sessionProjections') return { restore(_initial: unknown, events: SessionEvent[], baseSeq: number) {
        const lanes: Record<string, NativeUserMessage[]> = { 'next-turn': [], 'next-step': [] };
        events.forEach((event, index) => {
          if (event.seq !== baseSeq + index) throw new Error('Native projection cannot restore across a missing seq');
          if (event.type === 'agent/inbox/spliced') lanes[event.data.target].splice(event.data.start, event.data.removedCount, ...structuredClone(event.data.inserted));
        });
        return { snapshot: { asOfSeq: events.at(-1)?.seq ?? baseSeq - 1, values: { inbox: lanes } } };
      } };
    } };
  let messages = 0;
  const createAdapter = () => new ShiyuSessionAdapter({ ctx, cwd: '/synthetic/replyer', bindings: { async load() { return structuredClone(bindings); }, async save(value) { bindings.splice(0, bindings.length, ...structuredClone(value)); } },
    createUserMessage: (input: NativeMessageInput): NativeUserMessage => ({ ...structuredClone(input), id: `synthetic-input-${++messages}`, role: 'user' }),
    isAgentLoopRequest: request => !!request && typeof request === 'object' && official.has(request) });
  const adapter = createAdapter();
  const request = (overrides: Partial<ReplyRequest> = {}): ReplyRequest => ({ businessId: 'synthetic-accounting', scope: 'local-owner', prompt: 'Synthetic authorized context', deadlineMs: Date.now() + 5000,
    context: { operationId: `operation-${messages + 1}`, contextTokenId: `token-${messages + 1}`, sessionEpoch: 1, onBound() {}, authorize() {}, onContextDurable(value) { receipts.push(value); } }, ...overrides });
  return { adapter, createAdapter, request, counts, preparedRequests, bindings, receipts, records, global, stream, official,
    setMode(value: Mode) { mode = value; }, setUsage(value: Record<string, unknown>) { usage = value; }, setDiagnostic(value: string) { diagnostic = value; },
    setCorruptAssistantRead() { corruptAssistantRead = true; }, setStreamFailure() { streamFailure = true; }, setDisposeFailure() { failDispose = true; },
    setCwd(value: string) { currentCwd = value; }, setCorruptContextRead() { corruptContextRead = true; },
    holdStream(gate: Promise<void>, onEntered: () => void) { streamGate = gate; entered = onEntered; } };
}

test('one actually entered primary stream and a cold-confirmed reported total produce scoped complete accounting', async () => {
  const f = fixture();
  try {
    const first = await f.adapter.generateReply(f.request());
    assert.deepEqual({ ...first.accounting, evidenceRef: undefined }, { scope: 'observed-primary', complete: true, tokens: 11, calls: 1, evidenceRef: undefined });
    assert.match(first.accounting!.evidenceRef!, /^shiyu-reply-primary:[a-f0-9]{64}$/);
    assert.equal(f.counts.providerEntries, 1); assert.equal(f.counts.opens, f.counts.closes);
    const second = await f.adapter.generateReply(f.request());
    assert.equal(second.binding.sessionId, first.binding.sessionId); assert.equal(f.counts.creates, 1);
    assert.equal(second.accounting?.complete, true); assert.equal(second.accounting?.calls, 1); assert.equal(f.counts.providerEntries, 2);
    assert.notEqual(second.accounting?.evidenceRef, first.accounting?.evidenceRef);
  } finally { await f.adapter.close(); }
});

test('prepared primary requests retain exact same-Session history across turns and reopen without cross-Session inputs', async () => {
  const f = fixture();
  let reopened: ShiyuSessionAdapter | undefined;
  const firstPrompt = 'The sample cabinet is labeled amber.';
  const secondPrompt = 'What label did I provide in my previous message?';
  assert.equal(secondPrompt.includes('amber'), false);
  try {
    const first = await f.adapter.generateReply(f.request({ prompt: firstPrompt }));
    const firstRecord = f.records.get(first.binding.sessionId)!;
    const firstUser = structuredClone(firstRecord.durable[first.contextReceipt!.userMessageSeq]!.data);
    const firstAssistant = structuredClone(firstRecord.durable[first.assistantRef!.eventSeq]!.data.message);
    const other = await f.adapter.generateReply(f.request({ businessId: 'separate-conversation', scope: 'other-owner', prompt: 'The other sample uses the violet label.' }));
    const otherUser = f.records.get(other.binding.sessionId)!.durable[other.contextReceipt!.userMessageSeq]!.data;
    assert.notEqual(other.binding.sessionId, first.binding.sessionId);
    assert.deepEqual(f.preparedRequests[0]!.messages, [firstUser]);
    assert.deepEqual(f.preparedRequests[1]!.messages, [otherUser]);

    const second = await f.adapter.generateReply(f.request({ prompt: secondPrompt }));
    const secondUser = structuredClone(firstRecord.durable[second.contextReceipt!.userMessageSeq]!.data);
    const secondAssistant = structuredClone(firstRecord.durable[second.assistantRef!.eventSeq]!.data.message);
    assert.equal(second.binding.sessionId, first.binding.sessionId);
    assert.equal(f.preparedRequests[2]!.sessionId, first.binding.sessionId);
    // Assert the transport surface, not a fake model's ability to recall an answer.
    // The previous assistant is retained even though no channel delivery occurred.
    assert.deepEqual(f.preparedRequests[2]!.messages, [firstUser, firstAssistant, secondUser]);

    await f.adapter.close();
    reopened = f.createAdapter();
    const third = await reopened.generateReply(f.request({ prompt: 'Continue using this conversation without repeating my earlier inputs.' }));
    const thirdUser = firstRecord.durable[third.contextReceipt!.userMessageSeq]!.data;
    assert.equal(third.binding.sessionId, first.binding.sessionId);
    assert.equal(f.preparedRequests[3]!.sessionId, first.binding.sessionId);
    assert.deepEqual(f.preparedRequests[3]!.messages, [firstUser, firstAssistant, secondUser, secondAssistant, thirdUser]);
    assert.equal(f.counts.creates, 2); assert.equal(f.counts.resumes, 1);
  } finally { await reopened?.close(); await f.adapter.close(); }
});

test('an assistant event and exact reference without stream observation never fabricate a call', async () => {
  const f = fixture(); f.setMode('no-stream');
  try {
    const result = await f.adapter.generateReply(f.request()); assert.ok(result.assistantRef);
    assert.deepEqual(result.accounting, { scope: 'observed-primary', complete: false, tokens: 11 }); assert.equal(f.counts.providerEntries, 0);
  } finally { await f.adapter.close(); }
});

test('missing or invalid aggregate usage keeps accounting incomplete without summing partial components', async () => {
  for (const usage of [{}, { inputTokens: 7, outputTokens: 4 }, { totalTokens: -1 }, { totalTokens: 1.5 }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = fixture(); f.setUsage(usage);
    try {
      const result = await f.adapter.generateReply(f.request());
      assert.deepEqual(result.accounting, { scope: 'observed-primary', complete: false, calls: 1 }); assert.equal(f.counts.providerEntries, 1);
    } finally { await f.adapter.close(); }
  }
});

test('nonprimary, unmarked, changed-model and tool-bearing native streams are denied before transport', async () => {
  for (const mode of ['anonymous', 'title', 'compaction', 'wrong-model', 'tools', 'tool-history', 'wrong-session'] as const) {
    const f = fixture(); f.setMode(mode);
    try { await assert.rejects(f.adapter.generateReply(f.request())); assert.equal(f.counts.providerEntries, 0, mode); }
    finally { await f.adapter.close(); }
  }
});

test('the final primary surface rejects changed, missing, duplicated or inserted current user input before transport', async () => {
  for (const mode of ['changed-input', 'extra-before', 'extra-after', 'missing-input', 'duplicate-input', 'committed-extra-before', 'committed-extra-after', 'changed-cwd-context'] as const) {
    const f = fixture(); f.setMode(mode);
    try {
      await assert.rejects(f.adapter.generateReply(f.request()));
      assert.equal(f.counts.providerEntries, 0, mode); assert.equal(f.receipts.length, 0, mode);
    } finally { await f.adapter.close(); }
  }
});

test('only the fixed native cwd snapshot is accepted and cold-read, retaining prior users across reused turns', async () => {
  const f = fixture(); f.setMode('cwd');
  try {
    const first = await f.adapter.generateReply(f.request()), second = await f.adapter.generateReply(f.request());
    assert.equal(first.binding.sessionId, second.binding.sessionId);
    assert.equal(first.accounting?.complete, true); assert.equal(second.accounting?.complete, true);
    assert.equal(f.counts.contextReads, 2); assert.equal(f.counts.providerEntries, 2);
    const contexts = f.records.get(first.binding.sessionId)!.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context');
    assert.equal(contexts.length, 2); assert.notEqual(contexts[0]!.data.id, contexts[1]!.data.id);
    f.setMode('normal'); const third = await f.adapter.generateReply(f.request());
    assert.equal(third.accounting?.complete, true); assert.equal(third.binding.sessionId, first.binding.sessionId);
    assert.equal(f.counts.creates, 1); assert.equal(f.counts.contextReads, 2);
  } finally { await f.adapter.close(); }
});

test('changed native cwd before or during the primary stream prevents a successful acknowledgement', async () => {
  const f = fixture(); f.setCwd('/changed');
  try { await assert.rejects(f.adapter.generateReply(f.request())); assert.equal(f.counts.providerEntries, 0); assert.equal(f.receipts.length, 0); }
  finally { await f.adapter.close(); }
  const during = fixture(), entered = deferred(), release = deferred();
  during.holdStream(release.promise, entered.resolve);
  try {
    const result = during.adapter.generateReply(during.request()), rejected = assert.rejects(result);
    await entered.promise; during.setCwd('/changed'); release.resolve(); await rejected;
    assert.equal(during.counts.providerEntries, 1); assert.equal(during.receipts.length, 0);
  } finally { release.resolve(); await during.adapter.close(); }
});

test('runtime context must persist exactly and the assistant must follow every current user event', async () => {
  const corrupt = fixture(); corrupt.setMode('cwd'); corrupt.setCorruptContextRead();
  try {
    await assert.rejects(corrupt.adapter.generateReply(corrupt.request())); assert.equal(corrupt.counts.contextReads, 1); assert.equal(corrupt.receipts.length, 0);
  } finally { await corrupt.adapter.close(); }
  const late = fixture(); late.setMode('late-cwd');
  try {
    await assert.rejects(late.adapter.generateReply(late.request()), /No exact completed native assistant/);
    assert.equal(late.counts.contextReads, 1); assert.equal(late.counts.providerEntries, 1);
  } finally { await late.adapter.close(); }
});

test('a second native stream or request is refused without dispatching another primary call', async () => {
  for (const mode of ['retry', 'second-request'] as const) {
    const f = fixture(); f.setMode(mode);
    try {
      await assert.rejects(f.adapter.generateReply(f.request()));
      assert.equal(f.counts.providerEntries, mode === 'retry' ? 1 : 0); assert.equal(f.counts.requests, 1);
    } finally { await f.adapter.close(); }
  }
});

test('attempt, compaction or title evidence defeats complete coverage even when one draft returns', async () => {
  for (const diagnostic of ['assistant/attempt', 'compaction/summary', 'compaction/start', 'session/title-llm-request']) {
    const f = fixture(); f.setDiagnostic(diagnostic);
    try {
      const result = await f.adapter.generateReply(f.request()); assert.equal(result.accounting?.complete, false);
      assert.equal(result.accounting?.calls, 1); assert.equal(result.accounting?.evidenceRef, undefined); assert.equal(f.counts.providerEntries, 1);
    } finally { await f.adapter.close(); }
  }
});

test('cancelled and failed primary streams cannot return a successful accounting receipt', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), controller = new AbortController();
  f.holdStream(release.promise, entered.resolve);
  const result = f.adapter.generateReply(f.request({ signal: controller.signal })), rejected = assert.rejects(result, /synthetic cancelled/);
  await entered.promise; controller.abort(new Error('synthetic cancelled')); await rejected; release.resolve();
  await f.adapter.close(); assert.equal(f.counts.providerEntries, 1); assert.equal(f.receipts.length, 0);
  const failed = fixture(); failed.setStreamFailure();
  try {
    await assert.rejects(failed.adapter.generateReply(failed.request())); assert.equal(failed.counts.providerEntries, 1);
    assert.equal(failed.receipts.length, 1, 'a model failure does not erase independently confirmed durable input');
  }
  finally { await failed.adapter.close(); }
});

test('reported output overflow or changed durable usage cannot produce a complete result', async () => {
  for (const fault of ['overflow', 'readback'] as const) {
    const f = fixture();
    if (fault === 'overflow') f.setUsage({ totalTokens: 10001, outputTokens: 10000 }); else f.setCorruptAssistantRead();
    try { await assert.rejects(f.adapter.generateReply(f.request())); assert.equal(f.counts.providerEntries, 1); }
    finally { await f.adapter.close(); }
  }
});

test('managed direct inference is denied between turns and its global guard survives failed disposal', async () => {
  const f = fixture(), result = await f.adapter.generateReply(f.request());
  const late = { sessionId: result.binding.sessionId }; f.official.add(late);
  await assert.rejects(async () => { for await (const _part of f.stream(late)) { /* denied */ } });
  assert.equal(f.counts.providerEntries, 1);
  f.setDisposeFailure(); await assert.rejects(f.adapter.close(), /cleanup failed/);
  assert.equal(f.global.handlers.get('llm/stream')?.length, 1);
  await assert.rejects(async () => { for await (const _part of f.stream(late)) { /* retained deny guard */ } });
  assert.equal(f.counts.providerEntries, 1);
});

test('ordinary legacy replies stay usable but never claim cold-confirmed accounting completeness', async () => {
  const f = fixture();
  try {
    const result = await f.adapter.generateReply(f.request({ context: undefined }));
    assert.equal(result.text, 'synthetic bounded reply');
    assert.deepEqual(result.accounting, { scope: 'observed-primary', complete: false, calls: 1 });
    assert.equal(f.counts.providerEntries, 1);
  } finally { await f.adapter.close(); }
});
