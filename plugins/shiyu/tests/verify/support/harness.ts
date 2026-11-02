/**
 * Shared judging routines for the independent H1 verification cases.
 *
 * Judgements are recorded through support/evidence.ts and then asserted, so a
 * failing expectation always shows expected vs observed facts. Interface
 * limitations are recorded as `unobservable`/`blocked`, never as passes.
 */
import assert from 'node:assert/strict';
import {
  judgeColdError, judgeColdSuccess, normalizeColdResult,
  type ColdJudgement, type ExpectedColdSnapshot, type NormalizedColdResult,
} from './independent.js';
import { expectedFor, type NativeWorld } from './world.js';
import { callCold, coldContext, type CallOptions, type ColdSeam, type SeamOutcome } from './seam.js';
import type { CaseHandle } from './evidence.js';

export interface JudgeOptions {
  leakCanaries?: readonly string[];
  allowUnclosed?: number;
  /** Skip the two-pass read-discipline assertion (e.g. deliberately malformed backends). */
  skipReadDiscipline?: boolean;
  /** Extra violation reporter. */
  extra?: (context: { world: NativeWorld; normalized?: NormalizedColdResult }) => string[];
}

function handleViolations(world: NativeWorld, allowUnclosed = 0): string[] {
  const stats = world.handleStats;
  const violations: string[] = [];
  if (stats.openHandles > allowUnclosed) violations.push(`open handles after the call: ${stats.openHandles}`);
  if (stats.closes !== stats.opens - allowUnclosed) violations.push(`handle close count mismatch: closes=${stats.closes} opens=${stats.opens}`);
  return violations;
}

function readDisciplineViolations(world: NativeWorld, expected: ExpectedColdSnapshot): string[] {
  const violations: string[] = [];
  if (expected.eventCount < 8) return violations;
  const sumReturned = world.reads.reduce((sum, read) => sum + read.returned, 0);
  const offsetZeroReads = world.reads.filter(read => read.offset === 0).length;
  const firstEof = world.reads.findIndex(read => read.returned === 0);
  const readAfterEof = firstEof >= 0 && world.reads.slice(firstEof + 1).length > 0;
  if (!(sumReturned >= expected.eventCount * 1.5 || offsetZeroReads >= 2 || readAfterEof)) {
    violations.push(`only one complete history pass observed (returned=${sumReturned}, events=${expected.eventCount}); 03 §4.1 requires a second complete comparison pass`);
  }
  return violations;
}

function failCase(c: CaseHandle, title: string, detail: Record<string, unknown>): never {
  const message = `${title}: ${JSON.stringify(detail)}`;
  c.fail(message, detail);
  assert.fail(message);
}

export interface LegalResult {
  normalized?: NormalizedColdResult;
  judgement?: ColdJudgement;
  blockedReason?: string;
  unobservable: string[];
}

export interface LegalEvaluation {
  normalized?: NormalizedColdResult;
  expected: ExpectedColdSnapshot;
  violations: string[];
  unobservable: string[];
}

/**
 * Mechanically evaluate a legal-history outcome without recording/asserting, so
 * the verification harness can be mutation-tested end-to-end (C00f) against
 * hand-built correct/buggy readers.
 */
export function evaluateLegal(world: NativeWorld, outcome: SeamOutcome, options: JudgeOptions = {}): LegalEvaluation {
  const expected = expectedFor(world);
  const unobservable: string[] = [];
  if (outcome.error !== undefined) {
    const judged = judgeColdError(outcome.error, options.leakCanaries ?? [], world.handleStats, { allowUnclosed: options.allowUnclosed });
    return { expected, violations: [`rejected a legal history: ${String((outcome.error as Error)?.message ?? outcome.error)}`, ...judged.violations.map(v => `${v.field}: ${v.detail}`)], unobservable };
  }
  let normalized: NormalizedColdResult;
  try { normalized = outcome.normalized ?? normalizeColdResult(outcome.result); }
  catch (error) { return { expected, violations: [`unrecognisable result shape: ${String(error)}`], unobservable }; }
  const judgement = judgeColdSuccess(normalized, expected);
  unobservable.push(...judgement.unobservable);
  const violations = judgement.violations.map(v => `${v.field}: expected ${JSON.stringify(v.expected)} got ${JSON.stringify(v.actual)} (${v.detail})`);
  violations.push(...handleViolations(world, options.allowUnclosed));
  if (!options.skipReadDiscipline) violations.push(...readDisciplineViolations(world, expected));
  if (options.extra) violations.push(...options.extra({ world, normalized }));
  return { normalized, expected, violations, unobservable };
}

/** Legal history must be recovered exactly and the native handle released. */
export function judgeLegal(c: CaseHandle, seam: ColdSeam, world: NativeWorld, outcome: SeamOutcome, options: JudgeOptions = {}): LegalResult {
  if (outcome.error !== undefined) {
    const judged = judgeColdError(outcome.error, options.leakCanaries ?? [], world.handleStats, { allowUnclosed: options.allowUnclosed });
    failCase(c, 'legal history was rejected', {
      expected: 'a correct cold projection over all events',
      observedError: judged.observed,
      violations: judged.violations,
      reads: world.reads,
      events: world.currentEvents().length,
    });
  }
  const evaluation = evaluateLegal(world, outcome, options);
  if (evaluation.violations.length) {
    failCase(c, 'legal history projection mismatch', {
      expectation: `${evaluation.expected.eventCount} events, asOfSeq=${evaluation.expected.asOfSeq}, inherited=${evaluation.expected.inheritedEventCount}, inbox=${JSON.stringify(evaluation.expected.references.map(r => `${r.lane}:${r.messageId}`))}`,
      violations: evaluation.violations,
      observed: evaluation.normalized?.raw === undefined ? undefined : {
        asOfSeq: evaluation.normalized.asOfSeq, eventCount: evaluation.normalized.eventCount, sessionId: evaluation.normalized.sessionId, preset: evaluation.normalized.preset,
        inheritedEventCount: evaluation.normalized.inheritedEventCount, references: evaluation.normalized.references,
      },
      unobservable: evaluation.unobservable,
      reads: world.reads,
    });
  }
  const normalized = evaluation.normalized!;
  const actual = `asOfSeq=${String(normalized.asOfSeq)} eventCount=${String(normalized.eventCount)} refs=${normalized.references?.length ?? 'n/a'} inherited=${String(normalized.inheritedEventCount)} reads=${world.reads.length} opens=${world.opens} closes=${world.closes}`;
  const critical = ['asOfSeq', 'eventCount'].filter(field => evaluation.unobservable.includes(field));
  if (critical.length) {
    c.unobservable(actual, { unobservable: evaluation.unobservable, seam: seam.functionName, exports: seam.exportNames });
    return { normalized, unobservable: evaluation.unobservable, blockedReason: `public seam ${seam.functionName} does not expose ${critical.join('/')}` };
  }
  c.pass(actual, {
    asOfSeq: normalized.asOfSeq, eventCount: normalized.eventCount, sessionId: normalized.sessionId, preset: normalized.preset,
    inheritedEventCount: normalized.inheritedEventCount, references: normalized.references, unobservable: evaluation.unobservable,
    reads: world.reads.length, opens: world.opens, closes: world.closes,
  });
  return { normalized, unobservable: evaluation.unobservable };
}

/** Invalid history/backend behaviour must reject with a diagnosable error and release the handle. */
export function judgeRejection(c: CaseHandle, world: NativeWorld, outcome: SeamOutcome, options: JudgeOptions & { note?: string } = {}): void {
  if (outcome.error === undefined) {
    failCase(c, 'invalid history was accepted', {
      note: options.note,
      expected: 'rejection with no accepted projection',
      observed: {
        result: JSON.stringify(outcome.result)?.slice(0, 800),
        normalized: outcome.normalized ? {
          asOfSeq: outcome.normalized.asOfSeq, eventCount: outcome.normalized.eventCount, references: outcome.normalized.references,
        } : undefined,
      },
      reads: world.reads,
    });
  }
  const judged = judgeColdError(outcome.error, options.leakCanaries ?? [], world.handleStats, { allowUnclosed: options.allowUnclosed });
  let violations = judged.violations;
  if (options.extra) violations = [...violations, ...(options.extra({ world }) as any)];
  if (violations.length) {
    failCase(c, 'rejection was not safe/diagnosable', {
      observedError: judged.observed,
      violations,
      expected: 'diagnosable structured rejection without body leakage and with the handle released',
    });
  }
  c.pass(`rejected with ${judged.observed?.name ?? 'error'}${judged.observed?.code ? ` code=${String(judged.observed.code)}` : ''}: ${judged.observed?.message?.slice(0, 240)}`, {
    errorName: judged.observed?.name, errorCode: judged.observed?.code, notes: options.note,
    reads: world.reads.length, opens: world.opens, closes: world.closes,
  });
}

/**
 * Race outcome: either reject, or succeed only with the final coherent cut
 * (a documented re-read). A stale/mixed accepted cut fails.
 */
export function judgeRace(c: CaseHandle, seam: ColdSeam, world: NativeWorld, outcome: SeamOutcome, options: JudgeOptions = {}): void {
  if (outcome.error !== undefined) {
    const judged = judgeColdError(outcome.error, options.leakCanaries ?? [], world.handleStats, { allowUnclosed: options.allowUnclosed });
    if (judged.violations.length) {
      failCase(c, 'race rejection was not safe/diagnosable', { observedError: judged.observed, violations: judged.violations });
    }
    c.pass(`rejected observed change with ${judged.observed?.name ?? 'error'}: ${judged.observed?.message?.slice(0, 240)}`, {
      mode: 'rejected', errorName: judged.observed?.name, errorCode: judged.observed?.code, reads: world.reads,
    });
    return;
  }
  let normalized: NormalizedColdResult;
  try { normalized = outcome.normalized ?? normalizeColdResult(outcome.result); }
  catch (error) { failCase(c, 'race result shape is not recognisable', { error: String(error) }); }
  const expectedFinal = expectedFor(world);
  const judgement = judgeColdSuccess(normalized, expectedFinal);
  const violations = [...judgement.violations.map(v => `${v.field}: expected ${JSON.stringify(v.expected)} got ${JSON.stringify(v.actual)} (${v.detail})`), ...handleViolations(world, options.allowUnclosed)];
  if (violations.length) {
    failCase(c, 'accepted result does not match the final coherent cut', {
      expectation: `reject, or re-read to asOfSeq=${expectedFinal.asOfSeq} eventCount=${expectedFinal.eventCount}`,
      violations,
      observed: { asOfSeq: normalized.asOfSeq, eventCount: normalized.eventCount, references: normalized.references },
      reads: world.reads,
    });
  }
  c.pass(`accepted only after re-reading the final cut: asOfSeq=${String(normalized.asOfSeq)} eventCount=${String(normalized.eventCount)} refs=${normalized.references?.length ?? 'n/a'}`, {
    mode: 'accepted-after-refetch', asOfSeq: normalized.asOfSeq, eventCount: normalized.eventCount,
    references: normalized.references, reads: world.reads.length,
  });
}

/** Run one cold call against a fresh world/context. */
export async function cold(seam: ColdSeam, world: NativeWorld, options: CallOptions = {}): Promise<SeamOutcome> {
  return callCold(seam, world, options);
}

export { coldContext };

export function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`verification guard timeout after ${ms}ms`)), ms));
}
