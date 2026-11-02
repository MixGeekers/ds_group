/**
 * Independent in-memory native-host behaviour simulator for H1 verification.
 *
 * Modelled from the freeze-verified DSH 0.2.1-rc.5 static contract:
 * - `sessionPersistence.open(id,'read')` captures header + inherited count at open;
 * - `handle.read(offset,length)` treats offset as a logical event seq and length
 *   as a maximum; never observes fewer events than a previous read on the same
 *   handle (a shrunken log rejects); slices carry the producer's eventState;
 * - the backend is not a snapshot lock: a foreign writer may append or rewrite;
 * - `sessionProjections.restore({}, events, 0, header, inherited)` returns
 *   `{snapshot:{asOfSeq,values:{inbox}}, checkpoint}` where asOfSeq is the last
 *   supplied seq (-1 for an empty cut) and a non-contiguous supplied list throws.
 *
 * Everything is synthetic and local; no real SDK, host, model or user data is
 * touched. Fault injection exists only to prove the product refuses malformed
 * backend behaviour and changes it observed between its read passes.
 */
import {
  expectedColdSnapshot, foldNativeInbox, independentHash,
  type ExpectedColdSnapshot, type NativeUserMessage, type SessionHeader, type WorldEvent,
} from './independent.js';

export type ReadFault = (world: NativeWorld, readIndex: number, offset: number, requested: number,
  snapshot: { events: WorldEvent[]; eventState: string }) => void;

export interface NativeWorldOptions {
  sessionId: string;
  preset?: string;
  header?: SessionHeader;
  inheritedEventCount?: number;
  events?: WorldEvent[];
  /** Unmaterialized pending log: reads report `detached` with no events. */
  detached?: boolean;
  /** Conforming backend that returns fewer than the requested maximum while more events remain. */
  pageCap?: number;
  /** Contract-violating backend returning more events than requested. */
  oversizePages?: number;
  /** Deterministic faults keyed by 1-based read index. */
  readThrowAt?: Map<number, unknown>;
  /** Replace the whole read result at a 1-based read index (malformed backend). */
  readReplaceAt?: Map<number, unknown>;
  readDelayMsAt?: Map<number, number>;
  /** Fired synchronously after a slice is observed by the caller's read (races). */
  afterRead?: ReadFault;
  /** Fired on open before the header is captured. */
  beforeOpen?: (world: NativeWorld) => void;
  openThrow?: unknown;
  closeThrowAt?: number;
  restoreThrow?: unknown;
  restoreWrongAsOfSeq?: number;
  restoreMissingInbox?: boolean;
  restoreDelayMs?: number;
  /** Fired while the official projector is invoked (mid-projection race). */
  duringRestore?: (world: NativeWorld) => void;
}

export interface ReadRecord { handle: number; offset: number; requested: number; returned: number; eventState: string; fault?: string }

export class NativeWorld {
  readonly sessionId: string;
  readonly clock = { time: 1_700_000_000_000 };
  header: SessionHeader;
  inheritedEventCount: number;
  events: WorldEvent[];
  readonly options: NativeWorldOptions;
  opens = 0;
  closes = 0;
  openHandles = 0;
  reads: ReadRecord[] = [];
  readIndex = 0;
  restoreCalls: { eventCount: number; baseSeq: number; headerId: unknown; inherited: unknown; asOfSeq: number }[] = [];
  flushCalls = 0;
  readonly handles: FakeHandle[] = [];
  readonly canaries: string[] = [];
  detached: boolean;

  constructor(options: NativeWorldOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.header = structuredClone({
      version: 4, id: options.sessionId, createdAt: 1_700_000_000_000,
      agentPreset: options.preset ?? 'shiyu-runtime-replyer-v1', isSeeded: false, cwd: '/synthetic/verify',
      ...(options.header ?? {}),
    });
    this.inheritedEventCount = options.inheritedEventCount ?? 0;
    this.events = structuredClone(options.events ?? []);
    this.detached = options.detached === true;
  }

  private metadata(): { header: SessionHeader; inheritedEventCount: number } {
    return { header: structuredClone(this.header), inheritedEventCount: this.inheritedEventCount };
  }

  nextSeq(): number { return this.events.length; }

  makeEvent(type: string, data: unknown, surfaceOp?: unknown): WorldEvent {
    return { type, seq: this.events.length, time: this.clock.time++, data: structuredClone(data), ...(surfaceOp === undefined ? {} : { surfaceOp }) };
  }

  appendEvent(event: WorldEvent): WorldEvent {
    if (!event || event.seq !== this.events.length) throw new Error(`world append seq mismatch: expected ${this.events.length}, got ${String(event?.seq)}`);
    this.events.push(structuredClone(event));
    return this.events[this.events.length - 1]!;
  }

  append(type: string, data: unknown, surfaceOp?: unknown): WorldEvent {
    return this.appendEvent(this.makeEvent(type, data, surfaceOp));
  }

  appendUserMessage(text: string, id: string): WorldEvent {
    const message = userMessage(text, id);
    return this.append('user/message', message, 'append');
  }

  /** Insert a pending-inbox message through the durable splice projection. */
  insertInboxMessage(message: NativeUserMessage, lane: 'next-turn' | 'next-step' = 'next-turn'): WorldEvent {
    const laneLength = this.projectedInbox(lane).length;
    this.canaries.push(message.content?.[0]?.text ?? message.id);
    return this.append('agent/inbox/spliced', { target: lane, start: laneLength, removedCount: 0, inserted: [structuredClone(message)] });
  }

  projectedInbox(lane: 'next-turn' | 'next-step'): NativeUserMessage[] {
    try {
      const folded = foldNativeInbox(this.events);
      return lane === 'next-turn' ? folded.nextTurn : folded.nextStep;
    } catch { return []; }
  }

  /** Same-length early rewrite; the handle's monotonic guard cannot see it. */
  rewriteEvent(index: number, data: unknown): void {
    const event = this.events[index];
    if (!event) throw new Error(`world rewrite out of range: ${index}`);
    this.events[index] = structuredClone({ ...event, data });
  }

  /** Remove tail events (the observer may or may not notice depending on what it already read). */
  truncate(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.events.length) throw new Error('world truncate out of range');
    this.events = this.events.slice(0, length);
  }

  setHeader(patch: SessionHeader): void { this.header = { ...this.header, ...structuredClone(patch) }; }

  setInherited(value: number): void { this.inheritedEventCount = value; }

  get handleStats(): { opens: number; closes: number; openHandles: number } {
    return { opens: this.opens, closes: this.closes, openHandles: this.openHandles };
  }

  currentEvents(): WorldEvent[] { return structuredClone(this.events); }

  openAttempts = 0;

  async open(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<FakeHandle> {
    options?.signal?.throwIfAborted();
    this.openAttempts++;
    if (this.options.openThrow !== undefined) throw this.options.openThrow;
    if (id !== this.sessionId) throw Object.assign(new Error(`session "${id}" not found`), { name: 'SessionPersistenceNotFoundError' });
    this.options.beforeOpen?.(this);
    const handle = new FakeHandle(this, this.opens + 1, access, () => this.metadata());
    this.opens++;
    this.handles.push(handle);
    this.openHandles++;
    return handle;
  }

  /** Local stand-in for ctx.get('sessionProjections').restore(...). */
  restore = async (checkpoint: unknown, events: WorldEvent[], baseSeq: number, header: SessionHeader, inherited: number): Promise<any> => {
    if (this.options.restoreDelayMs) await cooperativeDelay(this.options.restoreDelayMs, undefined);
    const duringRestore = this.options.duringRestore;
    this.options.duringRestore = undefined;
    if (duringRestore) duringRestore(this);
    this.restoreCalls.push({ eventCount: events.length, baseSeq, headerId: header?.id, inherited, asOfSeq: events.at(-1)?.seq ?? baseSeq - 1 });
    if (this.options.restoreThrow !== undefined) throw this.options.restoreThrow;
    const endSeq = events.at(-1)?.seq ?? baseSeq - 1;
    for (const [index, event] of events.entries()) {
      const expectedSeq = baseSeq + index;
      if (!event || event.seq !== expectedSeq) throw new Error(`session projection cannot restore across missing seq ${expectedSeq}`);
    }
    let inbox: ReturnType<typeof foldNativeInbox>;
    try { inbox = foldNativeInbox(events); } catch (error) { throw new Error(`session projection invalid inbox splice: ${(error as Error).message}`, { cause: error }); }
    if (this.options.restoreMissingInbox) return { snapshot: { asOfSeq: endSeq, values: {} }, checkpoint: {} };
    const wire = { 'next-turn': structuredClone(inbox.nextTurn), 'next-step': structuredClone(inbox.nextStep) };
    return {
      snapshot: { asOfSeq: this.options.restoreWrongAsOfSeq ?? endSeq, values: { inbox: wire } },
      checkpoint: { inbox: { ver: 1, seq: endSeq, val: wire } },
    };
  };
}

export class FakeHandle {
  readonly world: NativeWorld;
  readonly index: number;
  readonly access: 'read' | 'write';
  private metadata: () => { header: SessionHeader; inheritedEventCount: number };
  header: SessionHeader;
  inheritedEventCount: unknown;
  observedLength = 0;
  closed = false;
  closeAttempts = 0;
  writes: WorldEvent[][] = [];

  constructor(world: NativeWorld, index: number, access: 'read' | 'write', metadata: () => { header: SessionHeader; inheritedEventCount: number }) {
    this.world = world;
    this.index = index;
    this.access = access;
    this.metadata = metadata;
    const captured = metadata();
    this.header = captured.header;
    this.inheritedEventCount = captured.inheritedEventCount;
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw Object.assign(new Error(`session "${this.world.sessionId}": ${operation} on a closed handle`), { name: 'SessionHandleClosedError' });
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: { signal?: AbortSignal }): Promise<{ eventState: string; events: WorldEvent[] }> {
    const world = this.world;
    this.assertOpen('read');
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || Object.is(offset, -0)) throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`);
    if (!Number.isSafeInteger(length) || (length as number) < 0 || Object.is(length, -0)) throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`);
    options?.signal?.throwIfAborted();
    world.readIndex++;
    const readIndex = world.readIndex;
    const failure = world.options.readThrowAt?.get(readIndex);
    const delay = world.options.readDelayMsAt?.get(readIndex);
    if (delay) await cooperativeDelay(delay, options?.signal);
    options?.signal?.throwIfAborted();
    let eventState: string;
    let all: WorldEvent[];
    if (world.detached) {
      eventState = 'detached';
      all = [];
    } else {
      eventState = 'shared-frozen';
      all = structuredClone(world.events);
    }
    if (!world.detached && all.length < this.observedLength) {
      throw new Error(`session "${world.sessionId}": stored log shrank below a previously observed prefix (${all.length} < ${this.observedLength})`);
    }
    this.observedLength = all.length;
    const remaining = Math.max(0, all.length - offset);
    const maximum = world.options.oversizePages !== undefined
      ? Math.min(remaining, (length as number) + world.options.oversizePages)
      : Math.min(remaining, length as number, world.options.pageCap ?? Number.MAX_SAFE_INTEGER);
    const returned = all.slice(offset, offset + maximum);
    const snapshot = { events: structuredClone(returned), eventState };
    world.reads.push({ handle: this.index, offset: offset as number, requested: length as number, returned: returned.length, eventState });
    if (failure !== undefined) {
      world.reads[world.reads.length - 1]!.fault = 'read-throw';
      throw failure;
    }
    // A foreign write happens AFTER this slice was observed and BEFORE the caller can read again.
    world.options.afterRead?.(world, readIndex, offset as number, length as number, snapshot);
    const replacement = world.options.readReplaceAt?.get(readIndex);
    if (replacement !== undefined) {
      world.reads[world.reads.length - 1]!.fault = 'read-replace';
      return replacement as any;
    }
    return snapshot;
  }

  async append(batch: WorldEvent[], options?: { signal?: AbortSignal }): Promise<WorldEvent[]> {
    this.assertOpen('append');
    options?.signal?.throwIfAborted();
    if (this.access !== 'write') throw Object.assign(new Error(`session "${this.world.sessionId}": append is not available on a read handle`), { name: 'SessionReadOnlyError' });
    const accepted: WorldEvent[] = [];
    for (const event of batch) {
      if (event.seq !== this.world.events.length) throw new Error(`append seq mismatch: expected ${this.world.events.length}, got ${event.seq}`);
      accepted.push(this.world.appendEvent(event));
    }
    this.writes.push(accepted);
    this.observedLength = this.world.events.length;
    return accepted;
  }

  async flush(): Promise<void> {
    this.assertOpen('flush');
    this.world.flushCalls++;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closeAttempts++;
    const world = this.world;
    const failure = world.options.closeThrowAt !== undefined && this.closeAttempts === world.options.closeThrowAt ? new Error(`synthetic handle close failure #${this.closeAttempts}`) : undefined;
    if (failure) throw failure;
    this.closed = true;
    world.closes++;
    world.openHandles = Math.max(0, world.openHandles - 1);
  }
}

export function cooperativeDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export interface WorldContextOptions {
  flushResult?: boolean | (() => Promise<boolean> | boolean);
  missingServices?: ('sessions' | 'sessionPersistence' | 'sessionProjections')[];
  /** Exact live Session objects returned by sessions.get(id === object). */
  liveSessions?: Map<string, unknown>;
}

/** Minimal DshContext for the cold-history seam: only the services the frozen contract requires. */
export function worldContext(world: NativeWorld, options: WorldContextOptions = {}) {
  const registry = new Map<string, any>();
  if (!options.missingServices?.includes('sessions')) {
    const liveSessions = options.liveSessions;
    registry.set('sessions', {
      async flush(session: unknown) {
        if (session !== undefined) world.flushCalls++;
        const result = options.flushResult ?? true;
        return typeof result === 'function' ? await result() : result;
      },
      get(id: string) { return liveSessions?.get(id); },
    });
  }
  if (!options.missingServices?.includes('sessionPersistence')) {
    registry.set('sessionPersistence', {
      open: (id: string, access: 'read' | 'write', openOptions?: { signal?: AbortSignal }) => world.open(id, access, openOptions),
    });
  }
  if (!options.missingServices?.includes('sessionProjections')) {
    registry.set('sessionProjections', { restore: world.restore });
  }
  const listeners = new Map<string, ((...args: any[]) => any)[]>();
  return {
    get(name: string) { return registry.get(name); },
    on(name: string, listener: (...args: any[]) => any) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => { const current = listeners.get(name) ?? []; const index = current.indexOf(listener); if (index >= 0) current.splice(index, 1); };
    },
    listeners,
  };
}

export function userMessage(text: string, id?: string): NativeUserMessage {
  return { id: id ?? `verify-user-message-${independentHash(text).slice(0, 24)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

export interface HistoryPlan {
  /** Total logical event count of the returned list (including a seeded cut marker). */
  length: number;
  /** For seeded histories: inherited prefix length; the cut marker occupies seq = inheritedPrefix. */
  inheritedPrefix?: number;
  seeded?: boolean;
  /** Pending inbox insertions, placed at the given final seq position (one splice event per item-group). */
  inbox?: { text: string; lane?: 'next-turn' | 'next-step'; at?: number }[];
  /** Include user/assistant/tool/turn events (default true). */
  conversation?: boolean;
}

export interface BuiltHistory { events: WorldEvent[]; canaries: string[]; messages: NativeUserMessage[] }

/**
 * Build a legal synthetic native history. Event types mirror the surface
 * vocabulary (user/message, assistant/message, turn/start, turn/end,
 * agent/inbox/spliced, session/end-seed); the judge does not depend on which
 * types appear, only on the resulting native projection.
 */
export function buildHistory(plan: HistoryPlan): BuiltHistory {
  const length = plan.length;
  const seeded = plan.seeded === true;
  const inherited = seeded ? (plan.inheritedPrefix ?? 0) : 0;
  const canaries: string[] = [];
  const messages: NativeUserMessage[] = [];
  const inboxAt = new Map<number, { text: string; lane: 'next-turn' | 'next-step' }[]>();
  for (const item of plan.inbox ?? []) {
    const at = item.at ?? Math.max(0, length - 3);
    const lane = item.lane ?? 'next-turn';
    const list = inboxAt.get(at) ?? [];
    if (list.some(entry => entry.lane !== lane)) throw new Error('oracle: one history position cannot carry two inbox lanes');
    list.push({ text: item.text, lane });
    inboxAt.set(at, list);
  }
  const events: WorldEvent[] = [];
  const laneLength: { 'next-turn': number; 'next-step': number } = { 'next-turn': 0, 'next-step': 0 };
  const push = (type: string, data: unknown, surfaceOp?: unknown) => {
    events.push({ type, seq: events.length, time: 1_700_000_000_000 + events.length, data: structuredClone(data), ...(surfaceOp === undefined ? {} : { surfaceOp }) });
  };
  for (let index = 0; index < length; index++) {
    if (seeded && index === inherited) { push('session/end-seed', { inherited: true }); continue; }
    const pending = inboxAt.get(index);
    if (pending?.length) {
      const lane = pending[0]!.lane;
      const start = laneLength[lane];
      const inserted = pending.map((item, offset) => {
        canaries.push(item.text);
        const message = userMessage(item.text, `pending-${index}-${offset}`);
        messages.push(message);
        return message;
      });
      laneLength[lane] += inserted.length;
      push('agent/inbox/spliced', { target: lane, start, removedCount: 0, inserted });
      continue;
    }
    // Position after the seeded cut marker is child-owned. Use a stable mixed vocabulary.
    const slot = plan.conversation === false ? index : index - (seeded && index > inherited ? 1 : 0);
    switch (slot % 6) {
      case 0: {
        const text = `turn ${slot} user message`;
        canaries.push(text);
        push('user/message', { id: `user-${slot}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, 'append');
        break;
      }
      case 1: push('assistant/message', { message: { id: `assistant-${slot}`, role: 'assistant', content: [{ type: 'text', text: `assistant reply ${slot}` }] }, usage: { totalTokens: 10 + (slot % 7) } }, 'append'); break;
      case 2: push('turn/start', { turn: slot }); break;
      case 3: push('turn/end', { turn: slot, reason: { kind: 'completed' } }); break;
      case 4: {
        const text = `context note ${slot}`;
        canaries.push(text);
        push('user/message', { id: `context-${slot}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text }] } }, 'append');
        break;
      }
      default: {
        const text = `tool payload ${slot}`;
        canaries.push(text);
        push('tool/result', { callId: `call-${slot}`, outcome: { status: 'completed', content: [{ type: 'text', text }] } });
        break;
      }
    }
  }
  if (seeded) {
    const marker = events[inherited];
    if (!marker || marker.type !== 'session/end-seed' || marker.data?.inherited !== true) throw new Error('oracle: seeded history marker missing');
  }
  return { events, canaries, messages };
}

export function expectedFor(world: NativeWorld): ExpectedColdSnapshot {
  return expectedColdSnapshot({ sessionId: world.sessionId, header: world.header, inheritedEventCount: world.inheritedEventCount, events: world.currentEvents() });
}
