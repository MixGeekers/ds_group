import { createHash } from 'node:crypto';
import type { DshAgent, DshContext, DshSession, NativeAssistantRef, SessionEvent } from './sessions.js';
import { nativeMessageHash, type NativeUserMessage } from './native-message.js';

export interface NativeInboxReference { messageId: string; messageHash: string; lane: 'next-turn' | 'next-step'; index: number }

/**
 * Trusted recovery bounds, not an unlimited history and not a host memory limit.
 * A page is the most events one reader call may return; the JSONL backend may
 * still decode the whole log before slicing. Every bound is an explicit failure
 * code, never a silent truncation.
 */
export const NATIVE_HISTORY_LIMITS = Object.freeze({
  pageEvents: 512,
  maxEvents: 32_768,
  maxBytes: 32 * 1024 * 1024,
  maxReads: 256,
  timeoutMs: 10_000,
  maxAppendedEvents: 64,
});

export type NativeHistoryErrorCode = 'NATIVE_HISTORY_SERVICES' | 'NATIVE_HISTORY_HEADER' | 'NATIVE_HISTORY_SEQUENCE'
  | 'NATIVE_HISTORY_LIMIT' | 'NATIVE_HISTORY_CHANGED' | 'NATIVE_HISTORY_PROJECTION' | 'NATIVE_HISTORY_CANCELLED'
  | 'NATIVE_HISTORY_DEADLINE' | 'NATIVE_HISTORY_READ' | 'NATIVE_HISTORY_CLOSE';
const historyErrors: Record<NativeHistoryErrorCode, string> = {
  NATIVE_HISTORY_SERVICES: 'Native history services are unavailable',
  NATIVE_HISTORY_HEADER: 'Native history identity or inherited metadata does not match',
  NATIVE_HISTORY_SEQUENCE: 'Native cold projection has an incomplete or invalid event sequence',
  NATIVE_HISTORY_LIMIT: 'Native cold projection history exceeds the safe read bound',
  NATIVE_HISTORY_CHANGED: 'Native history changed outside the trusted recovery suffix',
  NATIVE_HISTORY_PROJECTION: 'Native inbox projection or its sequence watermark is invalid',
  NATIVE_HISTORY_CANCELLED: 'Native history recovery was cancelled',
  NATIVE_HISTORY_DEADLINE: 'Native history recovery exceeded its deadline',
  NATIVE_HISTORY_READ: 'Native history read failed',
  NATIVE_HISTORY_CLOSE: 'Native history handle release failed',
};
export type NativeHistoryMismatchKind = 'event-count' | 'live-seq-vs-event-count' | 'prefix-digest' | 'header-hash'
  | 'inherited-count' | 'session-id' | 'preset' | 'references' | 'projection' | 'unknown';
/** Controlled, bounded history mismatch facts. Hash prefixes only; no event
 * body, message text, inbox content or filesystem path is ever attached. */
export interface NativeHistoryDiagnostic {
  mismatchKind: NativeHistoryMismatchKind;
  expected: { eventCount: number; inheritedEventCount: number; headerHash: string; historyDigestPrefix: string };
  /** live.eventCount is the live session.seq (the sequence-excluding-header count). */
  live: { eventCount: number; seq: number; inheritedEventCount: number; headerHash: string; historyDigestPrefix: string };
  delta: number;
  /** Bounded field-name/value-category diff for a header mismatch; no string content. */
  headerDiff?: string[];
}
const historyHashPrefix = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{16,}$/i.test(value) ? value.slice(0, 16) : '';
const historyIntegerOr = (value: unknown): number => historyInteger(value) ? Number(value) : -1;
const HEADER_FACT_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const HEADER_FACT_KEYS = 24;
/** Controlled per-field header categories for a field-level diff. Scalar field
 * names are kept; string values are reduced to a short sha prefix (so ids,
 * presets and cwd never appear as text); nested values are category-only. */
export type NativeHeaderFacts = Record<string, string>;
export function nativeHeaderFacts(header: unknown): NativeHeaderFacts | undefined {
  if (!plainRecord(header)) return undefined;
  const facts: NativeHeaderFacts = {};
  const keys = Object.keys(header).filter(key => HEADER_FACT_FIELD.test(key)).sort().slice(0, HEADER_FACT_KEYS);
  for (const key of keys) {
    const value = (header as Record<string, unknown>)[key];
    let fact: string;
    if (typeof value === 'boolean') fact = `boolean:${value}`;
    else if (typeof value === 'number') fact = Number.isFinite(value) && String(value).length <= 20 ? `number:${String(value)}` : 'number:other';
    else if (typeof value === 'string') fact = /^[\x20-\x7e]{0,256}$/.test(value) ? `string-sha:${createHash('sha256').update(value).digest('hex').slice(0, 8)}` : 'string:other';
    else if (value === null) fact = 'null';
    else if (Array.isArray(value)) fact = 'array';
    else if (plainRecord(value)) fact = 'object';
    else fact = 'other';
    facts[key] = fact;
  }
  return facts;
}
/** Bounded field-name/value-category diff. Never includes string content. */
export function nativeHeaderFieldDiff(expected: NativeHeaderFacts | undefined, liveHeader: unknown): string[] {
  const live = nativeHeaderFacts(liveHeader);
  if (!expected || !live) return [];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(live)])].sort();
  const diff: string[] = [];
  for (const key of keys) {
    if (expected[key] === live[key]) continue;
    diff.push(`${key}: ${expected[key] ?? 'absent'}→${live[key] ?? 'absent'}`);
  }
  return diff.slice(0, 12).map(entry => entry.slice(0, 80));
}
/** Shrink/serialize the bounded controlled diagnostic. headerDiff is trimmed
 * first so the whole diagnostic stays <=300 characters. */
function boundedHistoryDiagnostic(diagnostic: NativeHistoryDiagnostic): NativeHistoryDiagnostic {
  let value = diagnostic;
  while (JSON.stringify(value).length > 600) {
    const diff = value.headerDiff;
    if (!diff || diff.length === 0) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    value = { ...value, headerDiff: diff.slice(0, -1) };
    if ((value.headerDiff?.length ?? 0) === 0) delete value.headerDiff;
  }
  return value;
}
export function historyDiagnostic(mismatchKind: NativeHistoryMismatchKind, expected: Partial<NativeColdInboxSnapshot> | undefined,
  live: { eventCount?: unknown; seq?: unknown; inheritedEventCount?: unknown; headerHash?: unknown; historyDigest?: unknown } | undefined,
  delta?: number, headerDiff?: string[]): NativeHistoryDiagnostic {
  const expectedCount = historyIntegerOr(expected?.eventCount), liveCount = historyIntegerOr(live?.eventCount ?? live?.seq);
  const diagnostic: NativeHistoryDiagnostic = {
    mismatchKind,
    expected: { eventCount: expectedCount, inheritedEventCount: historyIntegerOr(expected?.inheritedEventCount),
      headerHash: historyHashPrefix(expected?.headerHash), historyDigestPrefix: historyHashPrefix(expected?.historyDigest) },
    live: { eventCount: liveCount, seq: historyIntegerOr(live?.seq ?? live?.eventCount),
      inheritedEventCount: historyIntegerOr(live?.inheritedEventCount), headerHash: historyHashPrefix(live?.headerHash),
      historyDigestPrefix: historyHashPrefix(live?.historyDigest) },
    delta: Number.isSafeInteger(delta) ? Number(delta) : liveCount - expectedCount,
    ...(headerDiff && headerDiff.length ? { headerDiff } : {}),
  };
  return boundedHistoryDiagnostic(diagnostic);
}
/** No native error, event body, or provider text is attached to this public failure. */
export class NativeHistoryError extends Error {
  constructor(readonly code: NativeHistoryErrorCode, readonly historyDiagnostic?: NativeHistoryDiagnostic) {
    super(historyErrors[code]); this.name = 'NativeHistoryError';
  }
}

/** One complete, bounded observation of a native Session log at a logical cut. */
export interface NativeColdInboxSnapshot {
  references: NativeInboxReference[];
  /** Inclusive native event sequence; -1 for an empty log. Not a control-store watermark. */
  asOfSeq: number;
  /** Native event count at this observed cut; equal to the live `session.seq`. */
  eventCount: number;
  sessionId: string;
  preset: string;
  headerHash: string;
  inheritedEventCount: number;
  historyBytes: number;
  /** SHA-256 chain over ordered canonical event hashes; extendable by one verified event. */
  historyDigest: string;
  readPages: number;
  tailEventHash?: string;
  /** Events appended after the supplied expectedPrefix (zero for a fresh full read). */
  appendedCount: number;
  /** Event types of the appended suffix only; never event bodies. */
  appendedTypes: string[];
  /** Number of leading cold events that are Session header records (0 or 1).
   * The live `session.seq` excludes such a record, so a create cut that includes
   * it needs this offset to compare against the live seq. */
  headerEventCount?: number;
  /** Controlled cold header field categories for a field-level header diff. */
  headerFacts?: NativeHeaderFacts;
}

export interface NativeColdHistoryOptions {
  /** Absolute epoch-ms deadline; the fixed recovery timeout still caps it. */
  deadlineAtMs?: number;
  /**
   * Previously observed complete cut. When supplied, the first
   * `expectedPrefix.eventCount` events must hash to the exact prefix digest,
   * the log may only grow, and every appended event must be an accepted
   * recovery suffix event.
   */
  expectedPrefix?: NativeColdInboxSnapshot;
  /** Caller allowance for the appended suffix; overrides the trusted-resume-suffix default. */
  allowAppended?: (event: SessionEvent, index: number) => boolean;
  /** Exact live Session object to bind to this observation. */
  liveSession?: DshSession;
  /** Exact live inbox to compare with the official projection at this cut. */
  liveInbox?: { readonly nextTurn: readonly unknown[]; readonly nextStep?: readonly unknown[] };
  /**
   * How the live `session.seq` maps to the cold cut. `event-count` is the normal
   * semantics; `seq-excluding-header` subtracts a leading Session header record
   * (a candidate create-only alignment, inactive unless the caller opts in).
   */
  liveCut?: 'event-count' | 'seq-excluding-header';
}

const HISTORY_SEED = 'shiyu-native-history-v1';
function chainSeed(): string { return createHash('sha256').update(HISTORY_SEED).digest('hex'); }
function foldHistoryDigest(previous: string, eventHash: string): string {
  return createHash('sha256').update(previous).update('\n').update(eventHash).digest('hex');
}
function historyInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function references(value: unknown, lane: NativeInboxReference['lane']): NativeInboxReference[] {
  if (!Array.isArray(value) || value.length > 256) throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION');
  return value.map((message: unknown, index) => {
    if (!plainRecord(message) || typeof message.id !== 'string' || !message.id) throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION');
    return { messageId: message.id, messageHash: nativeMessageHash(message), lane, index };
  });
}
export function nativeInboxReferences(inbox: { nextTurn: unknown; nextStep: unknown } | undefined): NativeInboxReference[] {
  if (!inbox) throw new Error('Native inbox inspection is unavailable');
  return [...references(inbox.nextTurn, 'next-turn'), ...references(inbox.nextStep, 'next-step')];
}
/** Exact lane/order/identity comparison; any differing entry is a failed boundary. */
export function sameNativeInbox(left: readonly NativeInboxReference[], right: readonly NativeInboxReference[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.messageId === other.messageId && item.messageHash === other.messageHash
      && item.lane === other.lane && item.index === other.index;
  });
}
export function nativeContextServices(ctx: DshContext): void {
  if (typeof ctx.get('sessions')?.flush !== 'function' || typeof ctx.get('sessionPersistence')?.open !== 'function'
    || typeof ctx.get('sessionProjections')?.restore !== 'function') throw new Error('Native flush, read-only persistence and cold projection services are required');
}
/** Maintenance is the host's actual exclusive phase; status alone also reports maintenance as idle. */
export function assertNativeMaintenance(agent: DshAgent): void {
  if (typeof agent.runMaintenance !== 'function' || typeof agent.session.append !== 'function') throw new Error('Native exclusive maintenance and typed Session append are required');
  if (agent.status !== 'idle') throw new Error('Native context loading requires an idle Agent');
}
/** Called only inside an already acquired native maintenance phase. Does not enqueue or wake an Agent. */
export function appendNativeContextMessage(session: DshSession, message: NativeUserMessage): SessionEvent {
  if (typeof session.append !== 'function') throw new Error('Native typed Session append is unavailable');
  const event = session.append('user/message', message, { surfaceOp: 'append' });
  if (event?.type !== 'user/message' || event.surfaceOp !== 'append' || !Number.isSafeInteger(event.seq) || event.seq! < 0
    || event.data?.id !== message.id || nativeMessageHash(event.data) !== nativeMessageHash(message)) throw new Error('Native append did not return this exact complete context event');
  return structuredClone(event);
}

/**
 * The native resume/setup suffix that may legitimately appear after a cold cut:
 * interrupted-turn closers, one session/end-seed marker, and a fixed
 * user-pinned Session title. Anything else (user input, assistant output,
 * automatic titles, inbox splices) is foreign to this boundary.
 */
export function trustedNativeRecoverySuffix(event: SessionEvent): boolean {
  if (!plainRecord(event)) return false;
  switch (event.type) {
    case 'session/end-seed':
      return plainRecord(event.data) && (event.data.inherited === undefined || typeof event.data.inherited === 'boolean');
    case 'session/title':
      return plainRecord(event.data) && typeof event.data.title === 'string'
        && plainRecord(event.data.source) && event.data.source.kind === 'user'
        && Array.isArray(event.data.messageSeqs) && event.data.messageSeqs.length === 0;
    case 'tool/result': {
      const message = event.data?.message;
      return event.surfaceOp === 'append' && plainRecord(message) && message.role === 'tool'
        && plainRecord(message.source) && message.source.kind === 'tool' && typeof message.source.callId === 'string'
        && plainRecord(event.data?.error) && (event.data.error.code === 'TOOL_OUTCOME_UNKNOWN' || event.data.error.code === 'TOOL_NOT_STARTED');
    }
    case 'step/end':
      return historyInteger(event.data?.turn) && historyInteger(event.data?.step);
    case 'turn/end':
      return plainRecord(event.data?.reason) && event.data.reason.kind === 'interrupted';
    default:
      return false;
  }
}

interface HistoryObserver {
  readonly readPages: number;
  check(): void;
  metadataUnchanged(): boolean;
  read(offset: number, length: number): Promise<SessionEvent[]>;
}
function historyObserver(handle: any, headerHash: string, inheritedEventCount: number, callerSignal: AbortSignal | undefined,
  timeout: AbortController, deadline: number, readSignal: AbortSignal): HistoryObserver {
  const check = (): void => {
    if (callerSignal?.aborted) throw new NativeHistoryError('NATIVE_HISTORY_CANCELLED');
    if (timeout.signal.aborted || Date.now() >= deadline) throw new NativeHistoryError('NATIVE_HISTORY_DEADLINE');
  };
  let readPages = 0;
  return {
    get readPages() { return readPages; },
    check,
    metadataUnchanged() {
      try { return nativeMessageHash(handle.header) === headerHash && handle.inheritedEventCount === inheritedEventCount; }
      catch { return false; }
    },
    async read(offset: number, length: number) {
      check();
      if (++readPages > NATIVE_HISTORY_LIMITS.maxReads) throw new NativeHistoryError('NATIVE_HISTORY_LIMIT');
      let result: any;
      try { result = await handle.read(offset, length, { signal: readSignal }); }
      catch (error) {
        if (error instanceof NativeHistoryError) throw error;
        check();
        throw new NativeHistoryError('NATIVE_HISTORY_READ');
      }
      check();
      if (!Array.isArray(result?.events)) throw new NativeHistoryError('NATIVE_HISTORY_READ');
      if (result.events.length > length) throw new NativeHistoryError('NATIVE_HISTORY_SEQUENCE');
      if (!this.metadataUnchanged()) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
      return result.events as SessionEvent[];
    },
  };
}

/** Read the complete logical history from seq 0 through an explicit EOF, one bounded pass. */
async function readHistoryPass(observer: HistoryObserver, limit: number): Promise<{ events: SessionEvent[]; hashes: string[]; bytes: number }> {
  const events: SessionEvent[] = [], hashes: string[] = [];
  let bytes = 0;
  for (;;) {
    const length = Math.min(NATIVE_HISTORY_LIMITS.pageEvents, limit - events.length + 1);
    const page = await observer.read(events.length, length);
    if (page.length === 0) break; // A short page is not EOF; only an empty read proves the end.
    for (const event of page) {
      observer.check();
      if (events.length >= NATIVE_HISTORY_LIMITS.maxEvents) throw new NativeHistoryError('NATIVE_HISTORY_LIMIT');
      if (!plainRecord(event) || typeof event.type !== 'string' || !event.type
        || !Number.isSafeInteger(event.seq) || Object.is(event.seq, -0) || event.seq !== events.length) {
        throw new NativeHistoryError('NATIVE_HISTORY_SEQUENCE');
      }
      let eventHash: string;
      try { eventHash = nativeMessageHash(event); }
      catch { throw new NativeHistoryError('NATIVE_HISTORY_SEQUENCE'); }
      let encoded: string;
      try { encoded = JSON.stringify(event); }
      catch { throw new NativeHistoryError('NATIVE_HISTORY_SEQUENCE'); }
      bytes += Buffer.byteLength(encoded, 'utf8');
      if (bytes > NATIVE_HISTORY_LIMITS.maxBytes) throw new NativeHistoryError('NATIVE_HISTORY_LIMIT');
      events.push(structuredClone(event));
      hashes.push(eventHash);
    }
  }
  return { events, hashes, bytes };
}

function historyDeadline(startedAt: number, options: NativeColdHistoryOptions): number {
  if (options.deadlineAtMs !== undefined && (!Number.isSafeInteger(options.deadlineAtMs) || Object.is(options.deadlineAtMs, -0))) {
    throw new NativeHistoryError('NATIVE_HISTORY_DEADLINE');
  }
  const fixed = startedAt + NATIVE_HISTORY_LIMITS.timeoutMs;
  const deadline = options.deadlineAtMs === undefined ? fixed : Math.min(fixed, options.deadlineAtMs);
  if (deadline <= startedAt) throw new NativeHistoryError('NATIVE_HISTORY_DEADLINE');
  return deadline;
}

function historyHeader(handle: any, sessionId: string, preset: string): { headerHash: string; inheritedEventCount: number } {
  const header = handle?.header;
  if (!plainRecord(header) || header.version !== 4 || header.id !== sessionId || header.agentPreset !== preset
    || typeof header.isSeeded !== 'boolean') throw new NativeHistoryError('NATIVE_HISTORY_HEADER');
  const inheritedEventCount = handle.inheritedEventCount;
  if (!historyInteger(inheritedEventCount)) throw new NativeHistoryError('NATIVE_HISTORY_HEADER');
  if (header.isSeeded === false && inheritedEventCount !== 0) throw new NativeHistoryError('NATIVE_HISTORY_HEADER');
  let headerHash: string;
  try { headerHash = nativeMessageHash(header); }
  catch { throw new NativeHistoryError('NATIVE_HISTORY_HEADER'); }
  return { headerHash, inheritedEventCount };
}

/** A seeded header's inherited cut carries the SDK's own marker (or covers the whole log). */
function validateInheritedCut(header: Record<string, unknown>, inheritedEventCount: number, count: number, events: SessionEvent[]): void {
  if (inheritedEventCount > count) throw new NativeHistoryError('NATIVE_HISTORY_HEADER');
  if (header.isSeeded !== true) return;
  if (inheritedEventCount === count) return;
  const marker = events[inheritedEventCount];
  if (marker?.type !== 'session/end-seed' || !plainRecord(marker.data) || marker.data.inherited !== true) {
    throw new NativeHistoryError('NATIVE_HISTORY_HEADER');
  }
}

function projectionReferences(restored: any, eventCount: number): NativeInboxReference[] {
  if (!plainRecord(restored) || !plainRecord(restored.snapshot)) throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION');
  const asOfSeq = restored.snapshot.asOfSeq;
  // inclusive last projected seq: N events => N-1, empty => -1. This is
  // never an event count and never a live watermark by itself.
  if (!Number.isSafeInteger(asOfSeq) || Object.is(asOfSeq, -0) || asOfSeq !== eventCount - 1) throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION');
  const values = restored.snapshot.values;
  if (!plainRecord(values) || !plainRecord(values.inbox)) throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION');
  let combined: NativeInboxReference[];
  try {
    combined = [...references(values.inbox['next-turn'], 'next-turn'), ...references(values.inbox['next-step'], 'next-step')];
  } catch (error) {
    if (error instanceof NativeHistoryError) throw error;
    throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION');
  }
  // The official inbox fold already rejects duplicate pending ids; recheck the
  // wire view so a substituted projector cannot smuggle ambiguity through.
  if (new Set(combined.map(reference => reference.messageId)).size !== combined.length) throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION');
  return combined;
}

/**
 * One official projection over the complete bounded cut. The projection is
 * authoritative for pending native inbox input; it does not prove durability,
 * billing or absence of later appends.
 */
async function projectInbox(ctx: DshContext, events: SessionEvent[], baseSeq: number, header: unknown, inheritedEventCount: number, eventCount: number): Promise<NativeInboxReference[]> {
  const projections = ctx.get('sessionProjections');
  if (typeof projections?.restore !== 'function') throw new NativeHistoryError('NATIVE_HISTORY_SERVICES');
  let restored: any;
  try { restored = await projections.restore({}, events, baseSeq, header, inheritedEventCount); }
  catch { throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION'); }
  return projectionReferences(restored, eventCount);
}

/**
 * Cold-read one complete native Session log through the official reader and
 * projector. Two full sequential passes detect growth and any observable
 * mutation between passes; the second pass retains only per-event hashes.
 *
 * With `expectedPrefix`, the observation is a continuity proof: the complete
 * old cut must still hash to the same chain digest, the log may only grow, and
 * every appended event must be accepted by the caller policy (default: the
 * trusted native resume/setup/title suffix). This is stable append-only
 * observation, not an atomic snapshot under an arbitrary external writer.
 */
export async function coldNativeInboxSnapshot(ctx: DshContext, sessionId: string, preset: string, signal?: AbortSignal,
  options: NativeColdHistoryOptions = {}): Promise<NativeColdInboxSnapshot> {
  const startedAt = Date.now();
  const deadline = historyDeadline(startedAt, options);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(0, deadline - Date.now()));
  timer.unref?.();
  const readSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const expected = options.expectedPrefix;
  if (expected !== undefined) {
    if (!plainRecord(expected) || typeof expected.sessionId !== 'string' || typeof expected.preset !== 'string'
      || !historyInteger(expected.eventCount) || !historyInteger(expected.inheritedEventCount)
      || typeof expected.historyDigest !== 'string' || typeof expected.headerHash !== 'string'
      || !Array.isArray(expected.references)) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    if (expected.sessionId !== sessionId || expected.preset !== preset) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
  }
  const maxAppended = Math.min(NATIVE_HISTORY_LIMITS.maxAppendedEvents, Math.max(0, expected === undefined ? 0 : NATIVE_HISTORY_LIMITS.maxAppendedEvents));
  const allowAppended = expected === undefined ? undefined : (options.allowAppended ?? trustedNativeRecoverySuffix);

  let handle: any;
  let closeFailed = false;
  let failure: NativeHistoryError | undefined;
  let result: NativeColdInboxSnapshot | undefined;
  try {
    try { nativeContextServices(ctx); } catch { throw new NativeHistoryError('NATIVE_HISTORY_SERVICES'); }
    if (signal?.aborted) throw new NativeHistoryError('NATIVE_HISTORY_CANCELLED');
    if (timeout.signal.aborted || Date.now() >= deadline) throw new NativeHistoryError('NATIVE_HISTORY_DEADLINE');
    try { handle = await ctx.get('sessionPersistence').open(sessionId, 'read', { signal: readSignal }); }
    catch (error) {
      if (signal?.aborted) throw new NativeHistoryError('NATIVE_HISTORY_CANCELLED');
      if (timeout.signal.aborted || Date.now() >= deadline) throw new NativeHistoryError('NATIVE_HISTORY_DEADLINE');
      throw new NativeHistoryError('NATIVE_HISTORY_READ');
    }
    if (!handle || typeof handle.read !== 'function' || typeof handle.close !== 'function') throw new NativeHistoryError('NATIVE_HISTORY_SERVICES');
    const { headerHash, inheritedEventCount } = historyHeader(handle, sessionId, preset);
    const headerFacts = nativeHeaderFacts(handle.header);
    if (expected !== undefined) {
      if (expected.headerHash !== headerHash || expected.inheritedEventCount !== inheritedEventCount) {
        throw new NativeHistoryError('NATIVE_HISTORY_CHANGED', historyDiagnostic(expected.headerHash !== headerHash ? 'header-hash' : 'inherited-count',
          expected, { eventCount: -1, seq: -1, inheritedEventCount, headerHash }));
      }
    }
    const observer = historyObserver(handle, headerHash, inheritedEventCount, signal, timeout, deadline, readSignal);

    // First pass: retain the complete bounded cut for the single official projection.
    const first = await readHistoryPass(observer, NATIVE_HISTORY_LIMITS.maxEvents);
    const total = first.events.length;
    const headerEventCount = first.events[0]?.type === 'session' ? 1 : 0;
    validateInheritedCut(handle.header, inheritedEventCount, total, first.events);
    let appendedCount = 0, prefixDigest: string | undefined;
    const appendedTypes: string[] = [];
    let chain = chainSeed();
    if (expected !== undefined) {
      if (total < expected.eventCount) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED',
        historyDiagnostic('event-count', expected, { eventCount: total, seq: total, inheritedEventCount, headerHash }));
      if (expected.eventCount === 0) prefixDigest = chain;
      for (let index = 0; index < total; index++) {
        chain = foldHistoryDigest(chain, first.hashes[index]!);
        if (index + 1 === expected.eventCount) prefixDigest = chain;
        if (index >= expected.eventCount) {
          if (appendedCount >= maxAppended) throw new NativeHistoryError('NATIVE_HISTORY_LIMIT');
          if (!allowAppended || !allowAppended(first.events[index]!, appendedCount)) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
          appendedTypes.push(first.events[index]!.type);
          appendedCount++;
        }
      }
      if (prefixDigest === undefined || prefixDigest !== expected.historyDigest) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED',
        historyDiagnostic('prefix-digest', expected, { eventCount: total, seq: total, inheritedEventCount, headerHash, historyDigest: prefixDigest }));
    } else {
      for (const eventHash of first.hashes) chain = foldHistoryDigest(chain, eventHash);
    }
    observer.check();

    // One official projection over exactly this cut, before the verifying pass.
    const inboxReferences = await projectInbox(ctx, first.events, 0, handle.header, inheritedEventCount, total);
    observer.check();
    if (!observer.metadataUnchanged()) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');

    // Second pass: the same complete cut, comparing per-event hashes and the
    // explicit EOF without retaining a second full history.
    let verified = 0, verifiedChain = chainSeed();
    for (;;) {
      const length = Math.min(NATIVE_HISTORY_LIMITS.pageEvents, total - verified + 1);
      const page = await observer.read(verified, length);
      if (page.length === 0) {
        if (verified !== total) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
        break;
      }
      for (const event of page) {
        observer.check();
        if (verified >= total) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
        if (!plainRecord(event) || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)
          || Object.is(event.seq, -0) || event.seq !== verified) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
        let eventHash: string;
        try { eventHash = nativeMessageHash(event); }
        catch { throw new NativeHistoryError('NATIVE_HISTORY_CHANGED'); }
        if (eventHash !== first.hashes[verified]) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
        verifiedChain = foldHistoryDigest(verifiedChain, eventHash);
        verified++;
      }
    }
    if (verifiedChain !== chain) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    const tailEventHash = first.hashes.at(-1);
    if (total > 0) {
      const anchor = await observer.read(total - 1, 1);
      if (anchor.length !== 1 || anchor[0]?.seq !== total - 1) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
      let anchorHash: string;
      try { anchorHash = nativeMessageHash(anchor[0]); }
      catch { throw new NativeHistoryError('NATIVE_HISTORY_CHANGED'); }
      if (anchorHash !== tailEventHash) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    }
    if ((await observer.read(total, 1)).length !== 0) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    observer.check();

    result = {
      headerEventCount,
      ...(headerFacts ? { headerFacts } : {}),
      references: inboxReferences,
      asOfSeq: total - 1,
      eventCount: total,
      sessionId,
      preset,
      headerHash,
      inheritedEventCount,
      historyBytes: first.bytes,
      historyDigest: chain,
      readPages: observer.readPages,
      ...(tailEventHash === undefined ? {} : { tailEventHash }),
      appendedCount,
      appendedTypes,
    };
    if (options.liveSession !== undefined || options.liveInbox !== undefined) {
      assertNativeLiveHistory(ctx, options.liveSession!, result, options.liveInbox, { ...(options.liveCut ? { liveCut: options.liveCut } : {}) });
    }
  } catch (error) {
    failure = error instanceof NativeHistoryError ? error : new NativeHistoryError('NATIVE_HISTORY_READ');
  } finally {
    if (handle && typeof handle.close === 'function') {
      try { await handle.close(); } catch { closeFailed = true; }
    }
    clearTimeout(timer);
  }
  // A close failure can never be reported as a successful observation. When the
  // operation already failed, that diagnostic is preserved (no success escapes).
  if (failure !== undefined) throw failure;
  if (closeFailed) throw new NativeHistoryError('NATIVE_HISTORY_CLOSE');
  return result!;
}

/**
 * Verify one exact event appended after a complete cut and extend the baseline
 * by that single event. Used for legitimate writes we performed ourselves
 * (fixed title, exact load-only message, known obsolete removal receipts) so a
 * synchronous append is never assumed to leave the watermark unchanged.
 */
export interface NativeAppendedEventExpectation {
  /** Must equal baseline.eventCount. */
  seq: number;
  /** Structural + identity validation of the exact appended event. */
  validate(event: SessionEvent): boolean;
}
export async function extendNativeHistorySnapshot(ctx: DshContext, baseline: NativeColdInboxSnapshot,
  expectation: NativeAppendedEventExpectation, preset: string, options: { signal?: AbortSignal; deadlineAtMs?: number } = {}): Promise<NativeColdInboxSnapshot> {
  if (!plainRecord(baseline) || typeof baseline.sessionId !== 'string' || typeof baseline.preset !== 'string'
    || !historyInteger(baseline.eventCount) || !historyInteger(baseline.inheritedEventCount)
    || typeof baseline.historyDigest !== 'string' || typeof baseline.headerHash !== 'string' || !Array.isArray(baseline.references)
    || preset !== baseline.preset || expectation.seq !== baseline.eventCount) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
  const { signal } = options;
  const startedAt = Date.now();
  const deadline = historyDeadline(startedAt, options);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.max(0, deadline - Date.now()));
  timer.unref?.();
  const readSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let handle: any;
  let closeFailed = false;
  let failure: NativeHistoryError | undefined;
  let result: NativeColdInboxSnapshot | undefined;
  try {
    try { nativeContextServices(ctx); } catch { throw new NativeHistoryError('NATIVE_HISTORY_SERVICES'); }
    if (signal?.aborted) throw new NativeHistoryError('NATIVE_HISTORY_CANCELLED');
    try { handle = await ctx.get('sessionPersistence').open(baseline.sessionId, 'read', { signal: readSignal }); }
    catch { throw new NativeHistoryError('NATIVE_HISTORY_READ'); }
    const { headerHash, inheritedEventCount } = historyHeader(handle, baseline.sessionId, preset);
    if (headerHash !== baseline.headerHash || inheritedEventCount !== baseline.inheritedEventCount) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    const observer = historyObserver(handle, headerHash, inheritedEventCount, signal, timeout, deadline, readSignal);
    const page = await observer.read(expectation.seq, 1);
    const event = page[0];
    if (page.length !== 1 || !plainRecord(event) || event.seq !== expectation.seq || event.type?.startsWith('agent/inbox/spliced')) {
      throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    }
    let accepted = false;
    try { accepted = expectation.validate(event); } catch { accepted = false; }
    if (!accepted) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    let eventHash: string;
    try { eventHash = nativeMessageHash(event); }
    catch { throw new NativeHistoryError('NATIVE_HISTORY_CHANGED'); }
    if ((await observer.read(expectation.seq + 1, 1)).length !== 0) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    const anchor = await observer.read(expectation.seq, 1);
    if (anchor.length !== 1 || nativeMessageHash(anchor[0]) !== eventHash) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED');
    observer.check();
    const eventCount = expectation.seq + 1;
    result = {
      references: baseline.references,
      ...(baseline.headerEventCount === undefined ? {} : { headerEventCount: baseline.headerEventCount }),
      ...(baseline.headerFacts === undefined ? {} : { headerFacts: baseline.headerFacts }),
      asOfSeq: expectation.seq,
      eventCount,
      sessionId: baseline.sessionId,
      preset,
      headerHash,
      inheritedEventCount,
      historyBytes: baseline.historyBytes + Buffer.byteLength(JSON.stringify(event), 'utf8'),
      historyDigest: foldHistoryDigest(baseline.historyDigest, eventHash),
      readPages: observer.readPages,
      tailEventHash: eventHash,
      appendedCount: 0,
      appendedTypes: [],
    };
  } catch (error) {
    failure = error instanceof NativeHistoryError ? error : new NativeHistoryError('NATIVE_HISTORY_READ');
  } finally {
    if (handle && typeof handle.close === 'function') {
      try { await handle.close(); } catch { closeFailed = true; }
    }
    clearTimeout(timer);
  }
  if (failure !== undefined) throw failure;
  if (closeFailed) throw new NativeHistoryError('NATIVE_HISTORY_CLOSE');
  return result!;
}

/**
 * Synchronous identity boundary for an already observed baseline:
 * exact live Session object, id, header hash/preset, inherited prefix length and
 * `session.seq === eventCount`; optionally the exact live inbox must equal the
 * official projection at that cut. It establishes a point-in-time match, not an
 * absence of future writers.
 */
export function assertNativeLiveHistory(ctx: DshContext, session: DshSession, baseline: NativeColdInboxSnapshot,
  liveInbox?: { readonly nextTurn: readonly unknown[]; readonly nextStep?: readonly unknown[] },
  options: { liveCut?: 'event-count' | 'seq-excluding-header' } = {}): void {
  if (!plainRecord(baseline) || typeof baseline.sessionId !== 'string' || typeof baseline.preset !== 'string'
    || !historyInteger(baseline.eventCount) || !historyInteger(baseline.inheritedEventCount)
    || typeof baseline.headerHash !== 'string' || !Array.isArray(baseline.references)) {
    throw new NativeHistoryError('NATIVE_HISTORY_CHANGED', historyDiagnostic('unknown', baseline, undefined));
  }
  if (!plainRecord(session) || typeof session.id !== 'string' || !plainRecord(session.header)) {
    throw new NativeHistoryError('NATIVE_HISTORY_HEADER', historyDiagnostic('header-hash', baseline, undefined));
  }
  const sessions = ctx.get('sessions');
  if (typeof sessions?.get !== 'function') throw new NativeHistoryError('NATIVE_HISTORY_SERVICES');
  let live: unknown;
  try { live = sessions.get(session.id); }
  catch { throw new NativeHistoryError('NATIVE_HISTORY_SERVICES'); }
  const liveFacts = { eventCount: session.seq, seq: session.seq, inheritedEventCount: session.inheritedEventCount,
    headerHash: safeHeaderHash(session.header) };
  if (live !== session) throw new NativeHistoryError('NATIVE_HISTORY_CHANGED', historyDiagnostic('session-id', baseline, liveFacts));
  if (session.id !== baseline.sessionId) {
    throw new NativeHistoryError('NATIVE_HISTORY_HEADER', historyDiagnostic('session-id', baseline, liveFacts));
  }
  if (session.header.id !== session.id || session.header.agentPreset !== baseline.preset) {
    throw new NativeHistoryError('NATIVE_HISTORY_HEADER', historyDiagnostic(session.header.agentPreset !== baseline.preset ? 'preset' : 'session-id',
      baseline, liveFacts, undefined, nativeHeaderFieldDiff(baseline.headerFacts, session.header)));
  }
  if (session.header.version !== 4 || typeof session.header.isSeeded !== 'boolean') {
    throw new NativeHistoryError('NATIVE_HISTORY_HEADER', historyDiagnostic('header-hash', baseline, liveFacts));
  }
  let liveHeaderHash: string;
  try { liveHeaderHash = nativeMessageHash(session.header); }
  catch { throw new NativeHistoryError('NATIVE_HISTORY_HEADER', historyDiagnostic('header-hash', baseline, liveFacts)); }
  if (liveHeaderHash !== baseline.headerHash) {
    throw new NativeHistoryError('NATIVE_HISTORY_CHANGED', historyDiagnostic('header-hash', baseline,
      { ...liveFacts, headerHash: liveHeaderHash }, undefined, nativeHeaderFieldDiff(baseline.headerFacts, session.header)));
  }
  if (!historyInteger(session.inheritedEventCount) || session.inheritedEventCount !== baseline.inheritedEventCount) {
    throw new NativeHistoryError('NATIVE_HISTORY_HEADER', historyDiagnostic('inherited-count', baseline, liveFacts));
  }
  const headerOffset = options.liveCut === 'seq-excluding-header' ? (baseline.headerEventCount ?? 0) : 0;
  const expectedLiveSeq = baseline.eventCount - headerOffset;
  if (!historyInteger(session.seq) || session.seq !== expectedLiveSeq) {
    // A cold cut that includes a leading Session header record but compares to a
    // live seq that excludes it is a cut-semantics mismatch, distinct from a real
    // append. `liveCut: 'seq-excluding-header'` is the candidate create-only fix.
    const headerCutMismatch = (baseline.headerEventCount ?? 0) > 0 && Number(session.seq) === baseline.eventCount - (baseline.headerEventCount ?? 0);
    throw new NativeHistoryError('NATIVE_HISTORY_CHANGED', historyDiagnostic(headerCutMismatch ? 'live-seq-vs-event-count' : 'event-count',
      baseline, liveFacts, (Number(session.seq) || 0) - expectedLiveSeq));
  }
  if (liveInbox !== undefined) {
    let refs: NativeInboxReference[];
    try { refs = nativeInboxReferences(liveInbox as { nextTurn: readonly unknown[]; nextStep: readonly unknown[] }); }
    catch { throw new NativeHistoryError('NATIVE_HISTORY_PROJECTION', historyDiagnostic('projection', baseline, liveFacts)); }
    if (!sameNativeInbox(refs, baseline.references)) {
      throw new NativeHistoryError('NATIVE_HISTORY_CHANGED', historyDiagnostic('references', baseline, liveFacts));
    }
  }
}
function safeHeaderHash(header: unknown): string | undefined {
  try { return typeof header === 'object' && header !== null ? nativeMessageHash(header) : undefined; } catch { return undefined; }
}
export interface NativeHistoryObservationOptions extends Omit<NativeColdHistoryOptions, 'liveSession' | 'liveInbox'> {
  /** Caller cancellation fused with the native maintenance signal. */
  signal?: AbortSignal;
}
/**
 * Host-exclusive observation used right after a native create/resume or before
 * a related write: flush durability, then cold-read with an optional expected
 * prefix and bind the exact live Session/inbox. The host's maintenance phase
 * excludes its own turn work; it is not a general write lock for other plugins.
 */
export async function observeNativeBaseline(ctx: DshContext, agent: DshAgent, preset: string,
  options: NativeHistoryObservationOptions = {}): Promise<NativeColdInboxSnapshot> {
  try { nativeContextServices(ctx); } catch { throw new NativeHistoryError('NATIVE_HISTORY_SERVICES'); }
  try { assertNativeMaintenance(agent); } catch { throw new NativeHistoryError('NATIVE_HISTORY_SERVICES'); }
  return agent.runMaintenance!(async nativeSignal => {
    const signal = options.signal ? AbortSignal.any([options.signal, nativeSignal]) : nativeSignal;
    await flushNative(ctx, agent.session, signal);
    return coldNativeInboxSnapshot(ctx, agent.session.id, preset, signal, {
      ...(options.deadlineAtMs === undefined ? {} : { deadlineAtMs: options.deadlineAtMs }),
      ...(options.expectedPrefix === undefined ? {} : { expectedPrefix: options.expectedPrefix }),
      ...(options.allowAppended === undefined ? {} : { allowAppended: options.allowAppended }),
      ...(options.liveCut === undefined ? {} : { liveCut: options.liveCut }),
      liveSession: agent.session,
      ...(agent.inbox === undefined ? {} : { liveInbox: agent.inbox }),
    });
  });
}

/** Compatibility helper for checks that only consume the projected inbox. */
export async function coldNativeInbox(ctx: DshContext, sessionId: string, preset: string, signal?: AbortSignal,
  options?: NativeColdHistoryOptions): Promise<NativeInboxReference[]> {
  return (await coldNativeInboxSnapshot(ctx, sessionId, preset, signal, options)).references;
}
export async function flushNative(ctx: DshContext, session: DshSession, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (await ctx.get('sessions').flush(session) !== true) throw new Error('Native Session durability listener did not handle the flush');
  signal?.throwIfAborted();
}
export async function verifyNativeEvent(ctx: DshContext, sessionId: string, expected: SessionEvent, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(expected.seq) || expected.seq! < 0) throw new Error('Native event has no exact sequence reference');
  signal?.throwIfAborted();
  const handle = await ctx.get('sessionPersistence').open(sessionId, 'read', { signal });
  try {
    const result = await handle.read(expected.seq, 1, { signal });
    const actual = result?.events?.[0];
    if (!Array.isArray(result?.events) || result.events.length !== 1 || actual.seq !== expected.seq || actual.type !== expected.type
      || (expected.surfaceOp !== undefined && actual.surfaceOp !== expected.surfaceOp)
      || nativeMessageHash(actual.data) !== nativeMessageHash(expected.data)) throw new Error('Native durable event readback did not match this operation');
    signal?.throwIfAborted();
  } finally { await handle.close(); }
}
/** Exact durable assistant lookup only; never attach, flush, project or infer. */
export async function readNativeAssistantEvent(ctx: DshContext, reference: NativeAssistantRef, preset: string, signal?: AbortSignal): Promise<SessionEvent> {
  if (!reference || typeof reference.sessionId !== 'string' || !reference.sessionId
    || !Number.isSafeInteger(reference.eventSeq) || reference.eventSeq < 0
    || typeof reference.messageId !== 'string' || !reference.messageId) throw new Error('Invalid native assistant reference');
  signal?.throwIfAborted();
  const persistence = ctx.get('sessionPersistence');
  if (typeof persistence?.open !== 'function') throw new Error('Native read-only persistence is required');
  const handle = await persistence.open(reference.sessionId, 'read', { signal });
  let event: SessionEvent;
  try {
    signal?.throwIfAborted();
    if (handle.header?.agentPreset !== preset) throw new Error('Native Session preset does not match the managed binding');
    const result = await handle.read(reference.eventSeq, 1, { signal });
    const actual = result?.events?.[0];
    if (!Array.isArray(result?.events) || result.events.length !== 1 || actual?.seq !== reference.eventSeq
      || actual.type !== 'assistant/message' || actual.data?.interrupted
      || actual.data?.message?.role !== 'assistant' || actual.data.message.id !== reference.messageId) {
      throw new Error('Native durable assistant event does not match the exact draft reference');
    }
    signal?.throwIfAborted();
    event = structuredClone(actual);
  } finally { await handle.close(); }
  signal?.throwIfAborted();
  return event;
}
