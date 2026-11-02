/**
 * Independent verification oracle for H1 native long-history cold recovery.
 *
 * This module is written ONLY from the freeze-verified DSH 0.2.1-rc.5 static
 * contract (journal: 架构与设计/DSH交接/03 §3) and DSH交接 02/03 behaviour
 * targets. It deliberately does not import the product implementation, the
 * product's message-hash helper, or the product's parser/comparator. The
 * inbox fold below is an independent reimplementation of the public
 * `agent/inbox/spliced` projection contract; the cold-history expectations
 * (asOfSeq = last seq / -1 for empty, eventCount = length, inherited rules)
 * come from the frozen SDK source.
 */
import { createHash } from 'node:crypto';

export interface NativeUserMessage {
  id: string;
  role: 'user';
  content: { type: 'text'; text: string }[];
  source: { kind: 'user' };
}

export interface WorldEvent {
  type: string;
  seq: number;
  time: number;
  data: any;
  surfaceOp?: any;
  ignorable?: boolean;
}

export interface SessionHeader {
  id?: string;
  agentPreset?: string;
  cwd?: string;
  isSeeded?: boolean;
  [key: string]: unknown;
}

export const hex64 = /^[a-f0-9]{64}$/;

/** Own canonical form: sorted object keys, arrays preserved, no replacer tricks. */
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

/** Independent content hash; used only as an identity-sensitive test fingerprint. */
export function independentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

export interface ExpectedInboxReference {
  messageId: string;
  lane: 'next-turn' | 'next-step';
  index: number;
  /** Independent fingerprint of the complete message. */
  fingerprint: string;
}

/** Independent reimplementation of the registered native inbox projection. */
export function foldNativeInbox(events: readonly WorldEvent[]): { nextTurn: NativeUserMessage[]; nextStep: NativeUserMessage[] } {
  let nextTurn: NativeUserMessage[] = [];
  let nextStep: NativeUserMessage[] = [];
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object') throw new Error(`oracle: event ${index} is not an object`);
    if (event.seq !== index) throw new Error(`oracle: event ${index} has seq ${String(event.seq)} (non-contiguous)`);
    if (event.type !== 'agent/inbox/spliced') continue;
    const splice = event.data;
    if (!splice || (splice.target !== 'next-turn' && splice.target !== 'next-step')) throw new Error(`oracle: event ${index} has invalid inbox splice target`);
    const laneInbox = splice.target === 'next-turn' ? nextTurn : nextStep;
    const removedCount = splice.removedCount ?? 0;
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > laneInbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0 || splice.start + removedCount > laneInbox.length) {
      throw new Error(`oracle: event ${index} has an invalid inbox splice range`);
    }
    if (!Array.isArray(splice.inserted)) throw new Error(`oracle: event ${index} has non-array inserted`);
    const inserted = splice.inserted.map((message: any, offset: number) => {
      if (!message || typeof message !== 'object' || typeof message.id !== 'string' || !message.id) throw new Error(`oracle: event ${index} inserted[${offset}] has no identity`);
      return message as NativeUserMessage;
    });
    if (inserted.length) for (const message of inserted) insertedSanity(message, index);
    const next = laneInbox.slice();
    next.splice(splice.start, removedCount, ...inserted);
    const combined = splice.target === 'next-turn' ? [...next, ...nextStep] : [...nextTurn, ...next];
    const ids = new Set<string>();
    for (const message of combined) {
      if (ids.has(message.id)) throw new Error(`oracle: event ${index} leaves duplicate pending message "${message.id}"`);
      ids.add(message.id);
    }
    if (splice.target === 'next-turn') nextTurn = next; else nextStep = next;
  }
  return { nextTurn, nextStep };
}

function insertedSanity(message: NativeUserMessage, index: number): void {
  if (typeof message.id !== 'string' || !message.id) throw new Error(`oracle: event ${index} pending message has no id`);
  if (message.role !== 'user') throw new Error(`oracle: event ${index} pending message is not a user message`);
}

export function inboxReferences(inbox: { nextTurn: NativeUserMessage[]; nextStep: NativeUserMessage[] }): ExpectedInboxReference[] {
  const lane = (messages: NativeUserMessage[], name: ExpectedInboxReference['lane']) =>
    messages.map((message, index) => ({ messageId: message.id, lane: name, index, fingerprint: independentHash(message) }));
  return [...lane(inbox.nextTurn, 'next-turn'), ...lane(inbox.nextStep, 'next-step')];
}

export interface ExpectedColdSnapshot {
  sessionId: string;
  preset: string;
  asOfSeq: number;
  eventCount: number;
  inheritedEventCount: number;
  headerIsSeeded: boolean;
  references: ExpectedInboxReference[];
  /** Independent whole-history fingerprint, used only for change detection, never for product equality. */
  historyFingerprint: string;
}

export interface ColdExpectationInput {
  sessionId: string;
  header: SessionHeader;
  inheritedEventCount: number;
  events: readonly WorldEvent[];
}

/** Validate legal metadata the way the frozen SDK brands/rules require, then derive the expected cut. */
export function expectedColdSnapshot(input: ColdExpectationInput): ExpectedColdSnapshot {
  const { sessionId, header, inheritedEventCount, events } = input;
  if (!header || typeof header !== 'object') throw new Error('oracle: header missing');
  if (header.id !== sessionId) throw new Error(`oracle: header identity ${String(header.id)} does not match requested ${sessionId}`);
  if (typeof header.agentPreset !== 'string' || !header.agentPreset) throw new Error('oracle: header preset missing');
  // SDK SessionLogOffset: non-negative safe integer, -0 rejected.
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || Object.is(inheritedEventCount, -0)) throw new Error('oracle: inherited count is not a branded offset');
  const seeded = header.isSeeded === true;
  if (!seeded && inheritedEventCount !== 0) throw new Error('oracle: unseeded header must have inherited count 0');
  if (inheritedEventCount > events.length) throw new Error('oracle: inherited count exceeds the event log');
  const inbox = foldNativeInbox(events);
  return {
    sessionId,
    preset: header.agentPreset,
    asOfSeq: events.length - 1,
    eventCount: events.length,
    inheritedEventCount,
    headerIsSeeded: seeded,
    references: inboxReferences(inbox),
    historyFingerprint: independentHash(events),
  };
}

export interface NormalizedColdResult {
  /** Raw returned value for evidence only. */
  raw: unknown;
  references?: { messageId: string; lane?: string; index?: number; messageHash?: string }[];
  asOfSeq?: unknown;
  eventCount?: unknown;
  sessionId?: unknown;
  preset?: unknown;
  inheritedEventCount?: unknown;
  headerHash?: unknown;
  historyBytes?: unknown;
  historyDigest?: unknown;
  readPages?: unknown;
  tailEventHash?: unknown;
  /** Fields the seam shape did not expose (recorded as unobservable, never silently passed). */
  missing: string[];
}

function asArrayReferences(value: unknown): NormalizedColdResult['references'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item: any) => item && typeof item === 'object'
    ? { messageId: item.messageId, ...(item.lane === undefined ? {} : { lane: item.lane }), ...(item.index === undefined ? {} : { index: item.index }), ...(item.messageHash === undefined ? {} : { messageHash: item.messageHash }) }
    : { messageId: String(item) });
}

/**
 * Accept the known behaviour-target result shapes without depending on one
 * interface name: an inbox-reference array (compatibility helper) or a
 * snapshot object exposing references plus the SDK watermarks.
 */
export function normalizeColdResult(raw: unknown): NormalizedColdResult {
  const missing: string[] = [];
  const array = asArrayReferences(raw);
  if (array) {
    return { raw, references: array, missing: ['asOfSeq', 'eventCount', 'sessionId', 'preset', 'inheritedEventCount', 'headerHash', 'historyDigest', 'readPages', 'tailEventHash'] };
  }
  if (!raw || typeof raw !== 'object') throw new Error('oracle: cold result is neither an inbox array nor a snapshot object');
  const source = raw as Record<string, any>;
  const refsRaw = source.references ?? source.inboxReferences ?? source.inbox ?? source.contextReferences;
  const references = asArrayReferences(refsRaw);
  if (!references) throw new Error('oracle: snapshot result has no recognisable inbox reference array');
  const pick = (names: string[]): unknown => {
    for (const name of names) if (source[name] !== undefined) return source[name];
    return undefined;
  };
  const result: NormalizedColdResult = { raw, references, missing };
  const mapped: [keyof NormalizedColdResult, string[]][] = [
    ['asOfSeq', ['asOfSeq', 'snapshotAsOfSeq']],
    ['eventCount', ['eventCount', 'nativeEventCount', 'historyEventCount']],
    ['sessionId', ['sessionId']],
    ['preset', ['preset', 'agentPreset']],
    ['inheritedEventCount', ['inheritedEventCount', 'inherited']],
    ['headerHash', ['headerHash', 'headerDigest']],
    ['historyBytes', ['historyBytes', 'bytes']],
    ['historyDigest', ['historyDigest', 'digest']],
    ['readPages', ['readPages', 'reads']],
    ['tailEventHash', ['tailEventHash', 'tailHash']],
  ];
  for (const [field, names] of mapped) {
    const value = pick(names);
    if (value === undefined) missing.push(field); else (result as any)[field] = value;
  }
  return result;
}

export interface Violation { field: string; expected: unknown; actual: unknown; detail: string }

export interface ColdJudgement {
  violations: Violation[];
  unobservable: string[];
  notes: string[];
}

const isBrandedOffset = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);

/** Judge a successful cold-read result against the independent expectation. */
export function judgeColdSuccess(result: NormalizedColdResult, expected: ExpectedColdSnapshot): ColdJudgement {
  const violations: Violation[] = [];
  const unobservable: string[] = [];
  const notes: string[] = [];
  const check = (field: string, actual: unknown, ok: boolean, detail: string) => {
    if (!ok) violations.push({ field, expected: field === 'references' ? `${expected.references.length} refs` : (expected as any)[field], actual, detail });
  };
  const brandedNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0);
  if (result.asOfSeq === undefined) unobservable.push('asOfSeq');
  else check('asOfSeq', result.asOfSeq, brandedNumber(result.asOfSeq) && (result.asOfSeq as number) >= -1 && result.asOfSeq === expected.asOfSeq, 'inclusive native watermark must be eventCount-1 (empty log -1, branded non-negative-inclusive integer, -0 rejected)');
  if (result.eventCount === undefined) unobservable.push('eventCount');
  else check('eventCount', result.eventCount, brandedNumber(result.eventCount) && result.eventCount === expected.eventCount, 'native event count at the observed cut');
  if (result.sessionId === undefined) unobservable.push('sessionId');
  else check('sessionId', result.sessionId, result.sessionId === expected.sessionId, 'native Session identity must be preserved');
  if (result.preset === undefined) unobservable.push('preset');
  else check('preset', result.preset, result.preset === expected.preset, 'managed preset binding must match the header');
  if (result.inheritedEventCount === undefined) unobservable.push('inheritedEventCount');
  else check('inheritedEventCount', result.inheritedEventCount, brandedNumber(result.inheritedEventCount) && result.inheritedEventCount === expected.inheritedEventCount, 'exact inherited prefix length from open-captured storage metadata (-0 rejected)');
  if (result.headerHash === undefined) unobservable.push('headerHash');
  else check('headerHash', result.headerHash, typeof result.headerHash === 'string' && result.headerHash.length > 0, 'header fingerprint must be a non-empty string');
  if (result.historyBytes === undefined) unobservable.push('historyBytes');
  else check('historyBytes', result.historyBytes, isBrandedOffset(result.historyBytes), 'history byte accounting must be a non-negative safe integer');
  if (result.historyDigest === undefined) unobservable.push('historyDigest');
  else check('historyDigest', result.historyDigest, typeof result.historyDigest === 'string' && hex64.test(result.historyDigest), 'whole-history digest must be a 64-hex fingerprint');
  if (result.readPages === undefined) unobservable.push('readPages');
  else check('readPages', result.readPages, typeof result.readPages === 'number' && Number.isSafeInteger(result.readPages) && result.readPages > 0, 'bounded read accounting must be a positive integer');
  if (result.tailEventHash === undefined) {
    if (expected.eventCount > 0) unobservable.push('tailEventHash');
  } else check('tailEventHash', result.tailEventHash, typeof result.tailEventHash === 'string' && result.tailEventHash.length > 0, 'tail fingerprint must be absent for an empty log and non-empty otherwise');

  const actualRefs = result.references ?? [];
  if (actualRefs.length !== expected.references.length) {
    violations.push({ field: 'references', expected: `${expected.references.length} refs`, actual: `${actualRefs.length} refs`, detail: 'exact native projected inbox must be recovered, not the last page only' });
  } else {
    for (const [index, reference] of expected.references.entries()) {
      const actual = actualRefs[index] as any;
      if (actual.messageId !== reference.messageId) violations.push({ field: `references[${index}].messageId`, expected: reference.messageId, actual: actual.messageId, detail: 'exact pending message identity' });
      if (actual.lane !== undefined && actual.lane !== reference.lane) violations.push({ field: `references[${index}].lane`, expected: reference.lane, actual: actual.lane, detail: 'inbox lane' });
      if (actual.index !== undefined && actual.index !== reference.index) violations.push({ field: `references[${index}].index`, expected: reference.index, actual: actual.index, detail: 'position inside the lane' });
      if (actual.messageHash !== undefined && !(typeof actual.messageHash === 'string' && actual.messageHash.length > 0)) {
        violations.push({ field: `references[${index}].messageHash`, expected: 'non-empty fingerprint', actual: actual.messageHash, detail: 'boundary must identify the complete message' });
      }
    }
  }
  const fingerprints = (result.references ?? []).map((reference: any) => reference.messageHash);
  if (fingerprints.length > 1) {
    const unique = new Set(fingerprints.map((value: any) => String(value)));
    if (unique.size !== fingerprints.length && expected.references.every((ref, index) => ref.fingerprint !== expected.references[index - 1]?.fingerprint)) {
      notes.push('distinct pending messages share the same reported fingerprint; investigate only if the seam claims a complete-message hash');
    }
  }
  return { violations, unobservable, notes };
}

export interface ErrorJudgement {
  violations: Violation[];
  notes: string[];
  observed: { name?: string; code?: unknown; message: string } | undefined;
}

/**
 * Judge a rejected cold read: clearly diagnosed, no body leak, no accepted
 * receipt, and the native read handle released.
 */
export function judgeColdError(error: unknown, leakCanaries: readonly string[], handle: { opens: number; closes: number; openHandles: number },
  options: { allowUnclosed?: number } = {}): ErrorJudgement {
  const violations: Violation[] = [];
  const notes: string[] = [];
  if (error === undefined || error === null) {
    return { violations: [{ field: 'error', expected: 'rejection', actual: String(error), detail: 'a failed history read must reject, not resolve' }], notes, observed: undefined };
  }
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const name = error instanceof Error ? error.name : undefined;
  const code = (error as any)?.code;
  if (error instanceof Error && !error.message.trim()) violations.push({ field: 'error.message', expected: 'diagnosable message', actual: error.message, detail: 'empty error message is not diagnosable' });
  for (const canary of leakCanaries) {
    if (text.includes(canary)) violations.push({ field: 'error.leak', expected: 'no event/provider body', actual: text.slice(0, 200), detail: `error text leaked canary ${canary}` });
  }
  if (code !== undefined && (typeof code !== 'string' || !code.trim())) violations.push({ field: 'error.code', expected: 'structured code string', actual: code, detail: 'structured failure code must be a non-empty string when exposed' });
  const allowedOpen = options.allowUnclosed ?? 0;
  if (handle.openHandles > allowedOpen) violations.push({ field: 'handle', expected: `${allowedOpen} open handles`, actual: handle.openHandles, detail: 'failed read must release the native persistence handle' });
  if (handle.closes !== handle.opens - allowedOpen) violations.push({ field: 'handle', expected: `closed === opened - ${allowedOpen}`, actual: `${handle.closes}/${handle.opens}`, detail: 'every opened native handle must be closed exactly once (except a deliberately simulated close failure)' });
  return { violations, notes, observed: { name, code, message: text.slice(0, 500) } };
}

/** A race that changed the log may be rejected or re-read; success must match the final coherent cut. */
export function judgeRaceOutcome(outcome: { result?: NormalizedColdResult; error?: unknown }, expectedFinal: ExpectedColdSnapshot,
  leakCanaries: readonly string[], handle: { opens: number; closes: number; openHandles: number }): ColdJudgement & { mode: 'rejected' | 'accepted'; errorJudgement?: ErrorJudgement } {
  if (outcome.error !== undefined || outcome.result === undefined) {
    const judged = judgeColdError(outcome.error, leakCanaries, handle);
    return { violations: judged.violations, notes: judged.notes, unobservable: [], mode: 'rejected', errorJudgement: judged };
  }
  return { ...judgeColdSuccess(outcome.result, expectedFinal), unobservable: [], notes: [] , mode: 'accepted' };
}
