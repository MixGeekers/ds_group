/**
 * Structured per-case evidence recorder for the independent H1 verification run.
 *
 * Each case writes exactly one JSONL record with its own spec reference,
 * expectation, observed facts and verdict. The aggregator merges these records
 * with the node:test TAP outcome, so a green TAP line without a recorded case
 * is reported as unreported (never silently counted as a pass) and a blocked /
 * unobservable case is never counted as a pass.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

export type Verdict = 'pass' | 'fail' | 'blocked' | 'unobservable';

export interface CaseRecord {
  id: string;
  title: string;
  spec: string[];
  expectation: string;
  verdict: Verdict;
  actual: string;
  refs?: Record<string, unknown>;
  notes?: string[];
  startedAt: string;
  durationMs: number;
  runId: string;
  pid: number;
}

function runDirectory(): string {
  return process.env.VERIFY_RUN_DIR ?? join(process.cwd(), 'artifacts', 'dsh', 'verify', 'raw');
}

function evidenceFile(): string {
  const directory = runDirectory();
  mkdirSync(directory, { recursive: true });
  const testFile = process.env.NODE_TEST_CONTEXT ? (process.argv[1] ?? 'unknown') : (process.argv[1] ?? 'unknown');
  const name = basename(testFile).replace(/[^A-Za-z0-9_.-]/g, '_') || `pid-${process.pid}`;
  return join(directory, `${name}.jsonl`);
}

const runId = process.env.VERIFY_RUN_ID ?? `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`;

export interface CaseHandle {
  readonly id: string;
  readonly startedAt: number;
  pass(actual: string, refs?: Record<string, unknown>, notes?: string[]): void;
  fail(actual: string, refs?: Record<string, unknown>, notes?: string[]): void;
  blocked(actual: string, refs?: Record<string, unknown>, notes?: string[]): void;
  unobservable(actual: string, refs?: Record<string, unknown>, notes?: string[]): void;
}

export function verifyCase(input: { id: string; title: string; spec: string[]; expectation: string }): CaseHandle {
  const started = Date.now();
  let recorded = false;
  const write = (verdict: Verdict, actual: string, refs?: Record<string, unknown>, notes?: string[]) => {
    if (recorded) return;
    recorded = true;
    const record: CaseRecord = {
      id: input.id, title: input.title, spec: input.spec, expectation: input.expectation,
      verdict, actual, ...(refs ? { refs } : {}), ...(notes?.length ? { notes } : {}),
      startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, runId, pid: process.pid,
    };
    try { appendFileSync(evidenceFile(), `${JSON.stringify(record)}\n`, 'utf8'); } catch { /* evidence must never mask the test */ }
  };
  return {
    id: input.id,
    startedAt: started,
    pass: (actual, refs, notes) => write('pass', actual, refs, notes),
    fail: (actual, refs, notes) => write('fail', actual, refs, notes),
    blocked: (actual, refs, notes) => write('blocked', actual, refs, notes),
    unobservable: (actual, refs, notes) => write('unobservable', actual, refs, notes),
  };
}

/** One-line JSON summary used in test diagnostics so TAP output carries the same facts. */
export function summarize(verdict: Verdict, actual: Record<string, unknown>): string {
  return `[${verdict}] ${JSON.stringify(actual)}`;
}

export const newRunId = (): string => `${process.env.VERIFY_RUN_ID ?? randomUUID()}`;
