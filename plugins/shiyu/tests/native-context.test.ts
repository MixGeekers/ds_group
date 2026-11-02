import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_HISTORY_LIMITS, NativeHistoryError, appendNativeContextMessage, assertNativeLiveHistory, assertNativeMaintenance,
  coldNativeInbox, coldNativeInboxSnapshot, extendNativeHistorySnapshot, flushNative, nativeContextServices, nativeInboxReferences,
  observeNativeBaseline, sameNativeInbox, trustedNativeRecoverySuffix, verifyNativeEvent, type NativeColdInboxSnapshot,
} from '../src/adapters/dsh/native-context.js';
import type { DshAgent, DshContext, DshSession, SessionEvent } from '../src/adapters/dsh/sessions.js';
import type { NativeUserMessage } from '../src/adapters/dsh/native-message.js';

// Public SDK contract substitute only: reader (open/read/close), official
// projector shape and the inbox splice fold. No installed host, model or DB.
const PRESET = 'managed-preset', SESSION = 'session-a';
const message: NativeUserMessage = { id: 'official-test-id', role: 'user', content: [{ type: 'text', text: 'Authorized synthetic view' }], source: { kind: 'user' } };
const historyEvent = (seq: number, type = 'other/event', data: Record<string, unknown> = { seq }): SessionEvent => ({ seq, type, data, time: 1_000 + seq });
const canonicalHeader = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 4, id: SESSION, createdAt: 1, isSeeded: false, agentPreset: PRESET, ...overrides,
});
function history(count: number, start = 0): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => historyEvent(start + index));
}

interface FixtureState {
  events: SessionEvent[];
  reads: number;
  readOffsets: number[];
  opens: number;
  closes: number;
  restores: number;
  projectionEvents: number;
}
interface FixtureOptions {
  sessionId?: string;
  preset?: string;
  header?: Record<string, unknown>;
  inheritedEventCount?: number;
  /** Backend may legitimately return fewer events than requested. */
  pageCap?: number;
  /** Faulty backend returns one event more than the requested maximum. */
  overlong?: boolean;
  readFault?: (state: FixtureState, offset: number, length: number, readIndex: number) => void | { events: SessionEvent[] };
  restoreFault?: (events: SessionEvent[]) => void;
  projectionOverride?: (events: SessionEvent[], baseSeq: number) => unknown;
  closeFault?: boolean;
  readDelayMs?: number;
}
function fixture(events: SessionEvent[], options: FixtureOptions = {}) {
  const sessionId = options.sessionId ?? SESSION, preset = options.preset ?? PRESET;
  const header = options.header ?? canonicalHeader({ id: sessionId, agentPreset: preset });
  const state: FixtureState = { events: structuredClone(events), reads: 0, readOffsets: [], opens: 0, closes: 0, restores: 0, projectionEvents: 0 };
  const stateAccess = {
    get events() { return state.events; },
    append(next: SessionEvent[]) { state.events.push(...next); },
    mutate(index: number, change: (event: SessionEvent) => void) { change(state.events[index]!); },
    shrink(count: number) { state.events = state.events.slice(0, Math.max(0, state.events.length - count)); },
  };
  const inheritedEventCount = options.inheritedEventCount ?? 0;
  const sessionsLive = new Map<string, DshSession>();
  const restore = (checkpoint: unknown, supplied: SessionEvent[], baseSeq: number) => {
    state.restores++; state.projectionEvents = supplied.length;
    options.restoreFault?.(supplied);
    if (baseSeq !== 0) throw new Error('fixture only supports a full log projection');
    const lanes: Record<string, NativeUserMessage[]> = { 'next-turn': [], 'next-step': [] };
    supplied.forEach((event, index) => {
      if (event.seq !== index) throw new Error('session projection cannot restore across missing seq');
      if (event.type !== 'agent/inbox/spliced') return;
      const splice = event.data as { target: 'next-turn' | 'next-step'; start: number; removedCount?: number; inserted: NativeUserMessage[] };
      const lane = lanes[splice.target];
      if (!lane) throw new Error('invalid persisted inbox target');
      const removed = splice.removedCount ?? 0;
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > lane.length
        || !Number.isSafeInteger(removed) || removed < 0 || splice.start + removed > lane.length) throw new Error('invalid inbox splice');
      lane.splice(splice.start, removed, ...structuredClone(splice.inserted ?? []));
      const ids = new Set<string>();
      for (const pending of [...lanes['next-turn']!, ...lanes['next-step']!]) {
        if (ids.has(pending.id)) throw new Error('duplicate pending inbox message');
        ids.add(pending.id);
      }
    });
    if (options.projectionOverride) return options.projectionOverride(supplied, baseSeq);
    return { snapshot: { asOfSeq: supplied.at(-1)?.seq ?? baseSeq - 1, values: { inbox: lanes } }, checkpoint: {} };
  };
  const ctx = {
    on: () => () => {},
    get(name: string) {
      if (name === 'sessions') return { async flush() { return true; }, get: (id: string) => sessionsLive.get(id) };
      if (name === 'sessionPersistence') return {
        async open(id: string, mode: string, openOptions: { signal?: AbortSignal }) {
          openOptions?.signal?.throwIfAborted();
          assert.equal(mode, 'read'); assert.equal(id, sessionId);
          state.opens++;
          return {
            header: structuredClone(header),
            inheritedEventCount,
            async read(offset: number, length: number, readOptions: { signal?: AbortSignal }) {
              readOptions?.signal?.throwIfAborted();
              state.reads++; state.readOffsets.push(offset);
              const readIndex = state.reads;
              if (options.readDelayMs !== undefined) {
                const signal = readOptions?.signal;
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, options.readDelayMs);
                  const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')); };
                  signal?.addEventListener('abort', abort, { once: true });
                });
              }
              const fault = options.readFault?.(state, offset, length, readIndex);
              if (fault !== undefined) {
                const resolved = await fault;
                if (resolved !== undefined) return { eventState: 'detached', events: resolved.events };
              }
              readOptions?.signal?.throwIfAborted();
              const capped = Math.min(length, options.pageCap ?? Number.MAX_SAFE_INTEGER);
              const take = options.overlong ? capped + 1 : capped;
              return { eventState: 'detached', events: structuredClone(state.events.slice(offset, offset + take)) };
            },
            async close() { state.closes++; if (options.closeFault) throw new Error('sdk raw close failure with canary body'); },
          };
        },
      };
      if (name === 'sessionProjections') return { restore };
    },
    agents: { create: async () => { throw new Error('fixture never creates agents'); }, resume: async () => { throw new Error('fixture never resumes agents'); }, list: () => [] },
  } as unknown as DshContext;
  const session: DshSession = {
    id: sessionId, header,
    get seq() { return state.events.length; },
    inheritedEventCount,
    append(type, data, appendOptions) {
      const event: SessionEvent = { seq: state.events.length, type, data: structuredClone(data), ...(appendOptions ?? {}) };
      state.events.push(event); return event;
    },
  };
  sessionsLive.set(sessionId, session);
  const inbox = {
    nextTurn: [] as NativeUserMessage[], nextStep: [] as NativeUserMessage[],
    remove(messageId: string) { const index = inbox.nextTurn.findIndex(value => value.id === messageId); if (index < 0) return false; inbox.nextTurn.splice(index, 1); return true; },
  };
  let maintenanceSync = false;
  const agent: DshAgent = {
    id: sessionId, status: 'idle', session, ctx: null as unknown as DshAgent['ctx'], followup() {}, whenIdle: async () => {}, cancel() {}, inbox,
    async runMaintenance<T>(job: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
      if (maintenanceSync) throw new Error('native agent already has active work');
      maintenanceSync = true;
      try { return await job(new AbortController().signal); } finally { maintenanceSync = false; }
    },
  };
  return { ctx, state, stateAccess, session, agent, inbox, sessionId, preset, header, inheritedEventCount, options };
}
const errorCode = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof NativeHistoryError, `expected NativeHistoryError, got ${String(error)}`);
  assert.equal(error.code, expected); return true;
};
const readOffsets = (state: FixtureState) => state.readOffsets;
const hasTwoFullPasses = (snapshot: NativeColdInboxSnapshot, total: number, pageCap: number = NATIVE_HISTORY_LIMITS.pageEvents) =>
  snapshot.readPages >= 2 * Math.ceil(Math.max(1, total) / Math.min(pageCap, NATIVE_HISTORY_LIMITS.pageEvents));

test('empty history projects as asOfSeq -1 with no pending inbox and explicit EOF', async () => {
  const f = fixture([]);
  const snapshot = await coldNativeInboxSnapshot(f.ctx, SESSION, PRESET);
  assert.deepEqual(snapshot.references, []);
  assert.equal(snapshot.asOfSeq, -1); assert.equal(snapshot.eventCount, 0); assert.equal(snapshot.appendedCount, 0);
  assert.equal(snapshot.historyDigest.length, 64); assert.equal(snapshot.inheritedEventCount, 0);
  assert.equal(f.state.restores, 1); assert.equal(f.state.opens, 1); assert.equal(f.state.closes, 1);
  assert.deepEqual(await coldNativeInbox(f.ctx, SESSION, PRESET), []);
  assert.equal(f.state.closes, 2);
});

test('exactly 2048, 2049 and a far larger history all recover with a complete second pass', async () => {
  for (const count of [2048, 2049, 5000]) {
    const f = fixture(history(count));
    const snapshot = await coldNativeInboxSnapshot(f.ctx, SESSION, PRESET);
    assert.equal(snapshot.eventCount, count); assert.equal(snapshot.asOfSeq, count - 1);
    assert.ok(hasTwoFullPasses(snapshot, count));
    assert.ok(readOffsets(f.state).filter(offset => offset === 0).length >= 2, 'the whole history is reread from seq 0');
    assert.ok(readOffsets(f.state).some(offset => offset === count), 'an explicit EOF read occurs at the observed length');
    assert.equal(f.state.restores, 1); assert.equal(f.state.closes, 1);
  }
});

test('a legitimate short page is not EOF: the reader continues until an empty read', async () => {
  const f = fixture(history(1300), { pageCap: 100 });
  const snapshot = await coldNativeInboxSnapshot(f.ctx, SESSION, PRESET);
  assert.equal(snapshot.eventCount, 1300); assert.ok(hasTwoFullPasses(snapshot, 1300, 100));
  assert.equal(f.state.closes, 1);
});

test('a page longer than the requested maximum is refused instead of silently accepted', async () => {
  const f = fixture(history(600), { overlong: true });
  await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_SEQUENCE'));
  assert.equal(f.state.closes, 1);
});

test('missing, duplicate, out-of-order and negative-zero sequences are rejected', async () => {
  for (const events of [
    [historyEvent(0), historyEvent(2)],
    [{ ...historyEvent(0) }, { ...historyEvent(0) }],
    [historyEvent(1), historyEvent(0)],
    [{ ...historyEvent(0), seq: -0 }, historyEvent(1)],
  ]) {
    const f = fixture(events);
    await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_SEQUENCE'));
    assert.equal(f.state.closes, 1);
  }
});

test('header id, version, preset, isSeeded and inherited metadata are validated exactly', async () => {
  const failures: Array<[FixtureOptions, string]> = [
    [{ header: canonicalHeader({ id: 'other-session' }) }, 'NATIVE_HISTORY_HEADER'],
    [{ header: canonicalHeader({ version: 3 }) }, 'NATIVE_HISTORY_HEADER'],
    [{ header: canonicalHeader({ agentPreset: 'other-preset' }) }, 'NATIVE_HISTORY_HEADER'],
    [{ header: { ...canonicalHeader(), isSeeded: undefined } }, 'NATIVE_HISTORY_HEADER'],
    [{ inheritedEventCount: -0 }, 'NATIVE_HISTORY_HEADER'],
    [{ inheritedEventCount: -1 }, 'NATIVE_HISTORY_HEADER'],
    [{ inheritedEventCount: 1.5 }, 'NATIVE_HISTORY_HEADER'],
    [{ inheritedEventCount: 2, header: canonicalHeader({ isSeeded: false }) }, 'NATIVE_HISTORY_HEADER'],
    [{ inheritedEventCount: 2 }, 'NATIVE_HISTORY_HEADER'],
    [{ inheritedEventCount: 3 }, 'NATIVE_HISTORY_HEADER'],
  ];
  for (const [options, code] of failures) {
    const f = fixture(history(2), options);
    await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET), errorCode(code));
    assert.equal(f.state.closes, 1);
  }
  // An unseeded Session with inherited 0 and a seeded Session covering the whole log are valid.
  const unseeded = fixture(history(3));
  assert.equal((await coldNativeInboxSnapshot(unseeded.ctx, SESSION, PRESET)).eventCount, 3);
  const wholeLogSeeded = fixture(history(3), { inheritedEventCount: 3, header: canonicalHeader({ isSeeded: true }) });
  assert.equal((await coldNativeInboxSnapshot(wholeLogSeeded.ctx, SESSION, PRESET)).inheritedEventCount, 3);
});

test('a seeded inherited cut must be marked by the SDK end-seed marker', async () => {
  const marked = [historyEvent(0, 'user/message', {}), { seq: 1, type: 'session/end-seed', data: { inherited: true }, time: 2 }, historyEvent(2)];
  const seeded = fixture(marked, { inheritedEventCount: 1, header: canonicalHeader({ isSeeded: true }) });
  const snapshot = await coldNativeInboxSnapshot(seeded.ctx, SESSION, PRESET);
  assert.equal(snapshot.inheritedEventCount, 1); assert.equal(snapshot.eventCount, 3);
  const unmarked = fixture(history(3), { inheritedEventCount: 1, header: canonicalHeader({ isSeeded: true }) });
  await assert.rejects(coldNativeInboxSnapshot(unmarked.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_HEADER'));
});

test('the official projection watermark must be exactly eventCount-1 and carry an inbox', async () => {
  const cases: Array<(events: SessionEvent[]) => unknown> = [
    events => ({ snapshot: { asOfSeq: events.length, values: { inbox: { 'next-turn': [], 'next-step': [] } } } }),
    events => ({ snapshot: { asOfSeq: (events.at(-1)?.seq ?? 0) - 1, values: { inbox: { 'next-turn': [], 'next-step': [] } } } }),
    events => ({ snapshot: { values: { inbox: { 'next-turn': [], 'next-step': [] } } } }),
    () => ({ snapshot: { asOfSeq: -2, values: { inbox: { 'next-turn': [], 'next-step': [] } } } }),
    () => undefined,
  ];
  for (const projectionOverride of cases) {
    const f = fixture(history(3), { projectionOverride });
    await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_PROJECTION'));
    assert.equal(f.state.closes, 1);
  }
  const unidentifiable = fixture(history(3), { projectionOverride: () => ({ snapshot: { asOfSeq: 2, values: { inbox: { 'next-turn': [{ content: [] }], 'next-step': [] } } } }) });
  await assert.rejects(coldNativeInboxSnapshot(unidentifiable.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_PROJECTION'));
  const duplicate = fixture(history(3), { projectionOverride: () => ({ snapshot: { asOfSeq: 2, values: { inbox: { 'next-turn': [{ id: 'same' }], 'next-step': [{ id: 'same' }] } } } }) });
  await assert.rejects(coldNativeInboxSnapshot(duplicate.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_PROJECTION'));
});

test('inbox references come from the registered projection and a bad splice is a projection failure', async () => {
  const pending: NativeUserMessage = { id: 'pending-1', role: 'user', content: [{ type: 'text', text: 'synthetic pending' }], source: { kind: 'user' } };
  const events = [historyEvent(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [pending] })];
  const f = fixture(events);
  const snapshot = await coldNativeInboxSnapshot(f.ctx, SESSION, PRESET);
  assert.equal(snapshot.references.length, 1); assert.equal(snapshot.references[0]!.messageId, pending.id);
  assert.equal(snapshot.references[0]!.lane, 'next-turn');
  assert.equal(snapshot.references[0]!.messageHash, (await import('../src/adapters/dsh/native-message.js')).nativeMessageHash(pending));
  const bad = fixture([historyEvent(0, 'agent/inbox/spliced', { target: 'next-turn', start: 4, removedCount: 0, inserted: [] })]);
  await assert.rejects(coldNativeInboxSnapshot(bad.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_PROJECTION'));
});

test('maxEvents, maxBytes and maxReads each fail explicitly at their boundary', async () => {
  const oversized = fixture(history(NATIVE_HISTORY_LIMITS.maxEvents + 1));
  await assert.rejects(coldNativeInboxSnapshot(oversized.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_LIMIT'));
  assert.equal(oversized.state.closes, 1);
  const exact = fixture(history(NATIVE_HISTORY_LIMITS.maxEvents));
  assert.equal((await coldNativeInboxSnapshot(exact.ctx, SESSION, PRESET)).eventCount, NATIVE_HISTORY_LIMITS.maxEvents);
  // A backend that returns only a few events per read forces more than maxReads reads.
  const manyReads = fixture(history(30_000), { pageCap: 100 });
  await assert.rejects(coldNativeInboxSnapshot(manyReads.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_LIMIT'));
  assert.equal(manyReads.state.closes, 1);
  const payload = 'x'.repeat(1024 * 1024);
  const heavy = fixture(Array.from({ length: 33 }, (_, index) => historyEvent(index, 'other/event', { payload })));
  await assert.rejects(coldNativeInboxSnapshot(heavy.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_LIMIT'));
});

test('a fresh complete second pass detects append, same-length rewrite and shrink', async () => {
  const mutations = [
    (state: FixtureState) => { state.events.push(historyEvent(state.events.length)); },
    (state: FixtureState) => { state.events[0]!.data = { changed: true }; },
    (state: FixtureState) => { state.events = state.events.slice(0, 1); },
  ];
  for (const mutate of mutations) {
    let triggered = false;
    const f = fixture(history(700), {
      readFault: (state, _offset, _length, readIndex) => {
        // The first pass ends after 3 reads (2 data pages + EOF for 700 events);
        // mutate between the passes so the verifying read must detect it.
        if (!triggered && readIndex === 4) { triggered = true; mutate(state); }
      },
    });
    await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_CHANGED'));
    assert.equal(f.state.closes, 1);
  }
});

test('an append during the official projection is detected by the verifying pass', async () => {
  const f = fixture(history(300), { restoreFault: supplied => { if (supplied.length) throw new Error('projection raw canary'); } });
  await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_PROJECTION'));
  let appended = false;
  const second = fixture(history(300), { projectionOverride: () => { return { snapshot: { asOfSeq: 299, values: { inbox: { 'next-turn': [], 'next-step': [] } } } }; } });
  second.options.restoreFault = () => { if (!appended) { appended = true; second.state.events.push(historyEvent(300)); } };
  // The projection hook appends before the fold result is validated; the
  // second full pass then sees one more event than the first cut.
  await assert.rejects(coldNativeInboxSnapshot(second.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_CHANGED'));
});

test('caller cancellation, absolute deadline, read, projection and close failures have distinct codes', async () => {
  const controller = new AbortController();
  controller.abort(new Error('caller raw canary'));
  const cancelled = fixture(history(4));
  await assert.rejects(coldNativeInboxSnapshot(cancelled.ctx, SESSION, PRESET, controller.signal), errorCode('NATIVE_HISTORY_CANCELLED'));
  assert.equal(cancelled.state.opens, 0);
  const expired = fixture(history(4));
  await assert.rejects(coldNativeInboxSnapshot(expired.ctx, SESSION, PRESET, undefined, { deadlineAtMs: Date.now() - 1 }), errorCode('NATIVE_HISTORY_DEADLINE'));
  assert.equal(expired.state.opens, 0);
  const badDeadline = fixture(history(4));
  await assert.rejects(coldNativeInboxSnapshot(badDeadline.ctx, SESSION, PRESET, undefined, { deadlineAtMs: -0 }), errorCode('NATIVE_HISTORY_DEADLINE'));
  const slow = fixture(history(4), { readDelayMs: 5_000 });
  // The delayed read only completes when the absolute deadline aborts it.
  await assert.rejects(coldNativeInboxSnapshot(slow.ctx, SESSION, PRESET, undefined, { deadlineAtMs: Date.now() + 40 }), errorCode('NATIVE_HISTORY_DEADLINE'));
  assert.equal(slow.state.closes, 1);
  const midCancel = fixture(history(4), { readDelayMs: 5_000 }), midController = new AbortController();
  setTimeout(() => midController.abort(new Error('raw cancel canary')), 30);
  await assert.rejects(coldNativeInboxSnapshot(midCancel.ctx, SESSION, PRESET, midController.signal), errorCode('NATIVE_HISTORY_CANCELLED'));
  assert.equal(midCancel.state.closes, 1);
  const reading = fixture(history(4), { readFault: () => { throw new Error('read raw canary'); } });
  await assert.rejects(coldNativeInboxSnapshot(reading.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_READ'));
  assert.equal(reading.state.closes, 1);
  const closing = fixture(history(4), { closeFault: true });
  await assert.rejects(coldNativeInboxSnapshot(closing.ctx, SESSION, PRESET), errorCode('NATIVE_HISTORY_CLOSE'));
});

test('a cached typed Session shape can never be produced by a raw SDK error message', async () => {
  for (const fault of [{ readFault: () => { throw new Error('SECRET-CANARY-BODY'); } }, { restoreFault: () => { throw new Error('SECRET-CANARY-BODY'); } }, { closeFault: true }]) {
    const f = fixture(history(2), fault);
    await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET), (error: unknown) => {
      assert.ok(error instanceof NativeHistoryError);
      assert.equal(error.message.includes('SECRET-CANARY-BODY'), false);
      return true;
    });
  }
});

test('expectedPrefix proves the exact pre-resume prefix and accepts only the trusted native suffix', async () => {
  const base = fixture(history(900));
  const before = await coldNativeInboxSnapshot(base.ctx, SESSION, PRESET);
  const fixedTitle = { seq: 900, type: 'session/title', data: { title: '识雨 · 受限回复', messageSeqs: [], source: { kind: 'user' } } } as SessionEvent;
  const endSeed = { seq: 901, type: 'session/end-seed', data: {} } as SessionEvent;
  const closer = { seq: 902, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } } as SessionEvent;
  base.state.events.push(fixedTitle, endSeed, closer);
  const resumed = await coldNativeInboxSnapshot(base.ctx, SESSION, PRESET, undefined, { expectedPrefix: before });
  assert.equal(resumed.eventCount, 903); assert.equal(resumed.appendedCount, 3);
  assert.deepEqual(resumed.appendedTypes, ['session/title', 'session/end-seed', 'turn/end']);
  assert.equal(resumed.asOfSeq, 902); assert.equal(resumed.historyDigest.length, 64);
  assert.ok(readOffsets(base.state).filter(offset => offset === 0).length >= 4, 'both the initial cut and the resumed cut are fully reread');
  assert.equal(trustedNativeRecoverySuffix({ seq: 0, type: 'tool/result', surfaceOp: 'append', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'c1' } }, error: { code: 'TOOL_OUTCOME_UNKNOWN' } } }), true);
  assert.equal(trustedNativeRecoverySuffix({ seq: 0, type: 'step/end', data: { turn: 1, step: 1 } }), true);
  assert.equal(trustedNativeRecoverySuffix({ seq: 0, type: 'session/title', data: { title: 'x', messageSeqs: [], source: { kind: 'user' } } }), true);
  assert.equal(trustedNativeRecoverySuffix({ seq: 0, type: 'session/title', data: { title: 'x', messageSeqs: [1], source: { kind: 'llm' } } }), false);
  assert.equal(trustedNativeRecoverySuffix({ seq: 0, type: 'user/message', data: { id: 'x', role: 'user' } }), false);
  assert.equal(trustedNativeRecoverySuffix({ seq: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } }), false);
});

test('expectedPrefix refuses foreign user input, assistant output, inbox splices and automatic titles', async () => {
  const base = fixture(history(300));
  const before = await coldNativeInboxSnapshot(base.ctx, SESSION, PRESET);
  for (const append of [
    { seq: 300, type: 'user/message', data: { id: 'foreign-user', role: 'user' }, surfaceOp: 'append' },
    { seq: 300, type: 'assistant/message', data: { message: { id: 'foreign-assistant', role: 'assistant', content: [] } } },
    { seq: 300, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [] } },
    { seq: 300, type: 'session/title', data: { title: 'auto', messageSeqs: [], source: { kind: 'llm' } } },
  ] as SessionEvent[]) {
    const f = fixture(history(300));
    const baseline = await coldNativeInboxSnapshot(f.ctx, SESSION, PRESET);
    f.state.events.push(structuredClone(append));
    await assert.rejects(coldNativeInboxSnapshot(f.ctx, SESSION, PRESET, undefined, { expectedPrefix: baseline }), errorCode('NATIVE_HISTORY_CHANGED'));
  }
  // The caller may admit exactly its own operation-owned message.
  const owned = fixture(history(300));
  const ownedBaseline = await coldNativeInboxSnapshot(owned.ctx, SESSION, PRESET);
  owned.state.events.push({ seq: 300, type: 'user/message', data: message, surfaceOp: 'append' } as SessionEvent);
  const observed = await coldNativeInboxSnapshot(owned.ctx, SESSION, PRESET, undefined, {
    expectedPrefix: ownedBaseline,
    allowAppended: (event, index) => index === 0 && event.type === 'user/message' && event.data?.id === message.id,
  });
  assert.equal(observed.appendedCount, 1); assert.equal(observed.eventCount, 301);
});

test('expectedPrefix rejects a shrink, a same-length early rewrite, a header change and an over-long suffix', async () => {
  const shrink = fixture(history(300));
  const shrinkBase = await coldNativeInboxSnapshot(shrink.ctx, SESSION, PRESET);
  shrink.state.events = shrink.state.events.slice(0, 250);
  await assert.rejects(coldNativeInboxSnapshot(shrink.ctx, SESSION, PRESET, undefined, { expectedPrefix: shrinkBase }), errorCode('NATIVE_HISTORY_CHANGED'));
  const rewrite = fixture(history(300));
  const rewriteBase = await coldNativeInboxSnapshot(rewrite.ctx, SESSION, PRESET);
  rewrite.state.events[10]!.data = { changed: true };
  await assert.rejects(coldNativeInboxSnapshot(rewrite.ctx, SESSION, PRESET, undefined, { expectedPrefix: rewriteBase }), errorCode('NATIVE_HISTORY_CHANGED'));
  const headerChange = fixture(history(10));
  const headerBase = await coldNativeInboxSnapshot(headerChange.ctx, SESSION, PRESET);
  (headerChange.header as Record<string, unknown>).cwd = '/synthetic/changed';
  await assert.rejects(coldNativeInboxSnapshot(headerChange.ctx, SESSION, PRESET, undefined, { expectedPrefix: headerBase }), errorCode('NATIVE_HISTORY_CHANGED'));
  const bounded = fixture(history(10));
  const boundedBase = await coldNativeInboxSnapshot(bounded.ctx, SESSION, PRESET);
  bounded.state.events.push(...Array.from({ length: NATIVE_HISTORY_LIMITS.maxAppendedEvents + 1 }, (_, index) => ({
    seq: 10 + index, type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } }, time: 50 + index,
  } as SessionEvent)));
  await assert.rejects(coldNativeInboxSnapshot(bounded.ctx, SESSION, PRESET, undefined, { expectedPrefix: boundedBase }), errorCode('NATIVE_HISTORY_LIMIT'));
});

test('extendNativeHistorySnapshot binds one exact append, then rejects a mismatched or non-EOF readback', async () => {
  const f = fixture(history(4));
  const base = await coldNativeInboxSnapshot(f.ctx, SESSION, PRESET);
  const appended = { seq: 4, type: 'user/message', data: message, surfaceOp: 'append' } as SessionEvent;
  f.state.events.push(appended);
  const next = await extendNativeHistorySnapshot(f.ctx, base, { seq: 4, validate: event => event.data?.id === message.id }, PRESET);
  assert.equal(next.eventCount, 5); assert.equal(next.asOfSeq, 4); assert.equal(next.references.length, 0);
  assert.equal(next.readPages, 3); assert.equal(next.historyDigest.length, 64);
  await assert.rejects(extendNativeHistorySnapshot(f.ctx, base, { seq: 4, validate: () => false }, PRESET), errorCode('NATIVE_HISTORY_CHANGED'));
  await assert.rejects(extendNativeHistorySnapshot(f.ctx, base, { seq: 3, validate: () => true }, PRESET), errorCode('NATIVE_HISTORY_CHANGED'));
  const spliced = fixture(history(4));
  const splicedBase = await coldNativeInboxSnapshot(spliced.ctx, SESSION, PRESET);
  spliced.state.events.push({ seq: 4, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [] } } as SessionEvent);
  await assert.rejects(extendNativeHistorySnapshot(spliced.ctx, splicedBase, { seq: 4, validate: () => true }, PRESET), errorCode('NATIVE_HISTORY_CHANGED'));
  const trailing = fixture(history(4));
  const trailingBase = await coldNativeInboxSnapshot(trailing.ctx, SESSION, PRESET);
  trailing.state.events.push({ seq: 4, type: 'other/event', data: {} } as SessionEvent, { seq: 5, type: 'other/event', data: {} } as SessionEvent);
  await assert.rejects(extendNativeHistorySnapshot(trailing.ctx, trailingBase, { seq: 4, validate: () => true }, PRESET), errorCode('NATIVE_HISTORY_CHANGED'));
  const closing = fixture(history(4), { closeFault: true });
  const closingBase = await coldNativeInboxSnapshot(closing.ctx, SESSION, PRESET).catch(() => undefined);
  // A close failure during the initial observation already prevents a baseline.
  assert.equal(closingBase, undefined);
});

test('assertNativeLiveHistory binds the exact live object, header, inherited prefix, seq and inbox', async () => {
  const f = fixture(history(6));
  const baseline = await coldNativeInboxSnapshot(f.ctx, SESSION, PRESET);
  assertNativeLiveHistory(f.ctx, f.session, baseline);
  assertNativeLiveHistory(f.ctx, f.session, baseline, f.inbox);
  const sameIdOtherObject = { ...f.session };
  assert.throws(() => assertNativeLiveHistory(f.ctx, sameIdOtherObject, baseline, f.inbox), errorCode('NATIVE_HISTORY_CHANGED'));
  const changedHeader = fixture(history(6), { header: canonicalHeader({ cwd: '/synthetic/cwd' }) });
  const changedBase = await coldNativeInboxSnapshot(changedHeader.ctx, SESSION, PRESET);
  assert.throws(() => assertNativeLiveHistory(f.ctx, f.session, changedBase), errorCode('NATIVE_HISTORY_CHANGED'));
  const storeOf = (session: DshSession): DshContext => ({
    ...(f.ctx as unknown as Record<string, unknown>),
    get: (name: string) => name === 'sessions'
      ? { flush: async () => true, get: (id: string) => id === SESSION ? session : undefined }
      : (f.ctx as unknown as { get(name: string): unknown }).get(name),
  } as unknown as DshContext);
  const movedSeq = { ...f.session, seq: 5, header: f.session.header, inheritedEventCount: 0 };
  assert.throws(() => assertNativeLiveHistory(storeOf(movedSeq), movedSeq, baseline), errorCode('NATIVE_HISTORY_CHANGED'));
  const negativeZeroSeq = { ...f.session, seq: -0, header: f.session.header, inheritedEventCount: 0 };
  assert.throws(() => assertNativeLiveHistory(storeOf(negativeZeroSeq), negativeZeroSeq, baseline), errorCode('NATIVE_HISTORY_CHANGED'));
  const wrongInherited = { ...f.session, seq: 6, inheritedEventCount: 2, header: f.session.header };
  assert.throws(() => assertNativeLiveHistory(storeOf(wrongInherited), wrongInherited, baseline), errorCode('NATIVE_HISTORY_HEADER'));
  const missingStore = { ...(f.ctx as unknown as Record<string, unknown>), get: (name: string) => name === 'sessions' ? { flush: async () => true } : (f.ctx as any).get(name) };
  assert.throws(() => assertNativeLiveHistory(missingStore as unknown as DshContext, f.session, baseline), errorCode('NATIVE_HISTORY_SERVICES'));
});

test('observeNativeBaseline runs inside native maintenance, flushes and verifies the exact live inbox', async () => {
  const f = fixture(history(3));
  let flushes = 0, jobs = 0;
  const ctx = {
    on: (...args: unknown[]) => (f.ctx as any).on(...args),
    agents: (f.ctx as any).agents,
    get(name: string) {
      if (name === 'sessions') return { async flush() { flushes++; return true; }, get: (id: string) => id === SESSION ? f.session : undefined };
      return (f.ctx as any).get(name);
    },
  } as DshContext;
  const originalRun = f.agent.runMaintenance!.bind(f.agent);
  f.agent.runMaintenance = async job => { jobs++; return originalRun(job); };
  const snapshot = await observeNativeBaseline(ctx, f.agent, PRESET);
  assert.equal(jobs, 1); assert.equal(flushes, 1); assert.equal(snapshot.eventCount, 3);
  assertNativeLiveHistory(ctx, f.session, snapshot, f.inbox);
  delete (f.agent as { runMaintenance?: unknown }).runMaintenance;
  await assert.rejects(observeNativeBaseline(f.ctx, f.agent, PRESET), errorCode('NATIVE_HISTORY_SERVICES'));
});

test('flush participation, exact event readback and inbox helpers keep their previous semantics', async () => {
  const f = fixture([]);
  await flushNative(f.ctx, f.session);
  const rejecting = { ...(f.ctx as object), get: (name: string) => name === 'sessions' ? { flush: async () => false } : (f.ctx as any).get(name) } as DshContext;
  await assert.rejects(flushNative(rejecting, f.session), /durability listener/);
  const expected: SessionEvent = { seq: 0, type: 'user/message', data: message, surfaceOp: 'append' };
  const readback = fixture([{ ...expected, surfaceOp: 'replace' }]);
  await assert.rejects(verifyNativeEvent(readback.ctx, SESSION, expected), /readback/);
  assert.equal(readback.state.closes, 1);
  assert.equal(nativeContextServices(f.ctx), undefined);
  assert.throws(() => nativeContextServices({ ...f.ctx, get: () => undefined } as unknown as DshContext), /services are required/);
  assert.equal(sameNativeInbox([], []), true);
  assert.equal(sameNativeInbox([{ messageId: 'a', messageHash: 'h', lane: 'next-turn', index: 0 }], []), false);
  assert.throws(() => nativeInboxReferences(undefined), /unavailable/);
});

test('load-only append and maintenance checks still fail closed for incomplete surfaces', () => {
  let calls = 0;
  const session: DshSession = {
    id: 'id', header: {},
    append(type, value, options) {
      calls++; assert.equal(type, 'user/message'); assert.deepEqual(value, message); assert.deepEqual(options, { surfaceOp: 'append' });
      return { type, data: structuredClone(value), seq: 17, surfaceOp: options.surfaceOp };
    },
  };
  const event = appendNativeContextMessage(session, message); assert.equal(event.seq, 17); assert.equal(calls, 1);
  event.data.content[0]!.text = 'local copy'; assert.equal(message.content[0]!.text, 'Authorized synthetic view');
  for (const value of [
    { seq: undefined, type: 'user/message', data: message, surfaceOp: 'append' },
    { seq: 1, type: 'user/message', data: message },
    { seq: 1, type: 'user/message', data: { ...message, id: 'other' }, surfaceOp: 'append' },
  ] as SessionEvent[]) {
    assert.throws(() => appendNativeContextMessage({ id: 'id', header: {}, append: () => value }, message), /exact complete context event/);
  }
  for (const partial of [{ status: 'idle', session: {} }, { status: 'running', runMaintenance() {}, session: { append() {} } }]) {
    assert.throws(() => assertNativeMaintenance(partial as unknown as DshAgent), /required|idle Agent/);
  }
});
