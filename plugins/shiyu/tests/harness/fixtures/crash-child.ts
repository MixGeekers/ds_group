/**
 * Real child-process crash fixture for H0 evidence tests.
 *
 * The child owns a real temporary SQLite control database and an observer
 * ledger in a separate root. It records a dispatch attempt, executes the
 * synthetic effect on the "receiving endpoint" (observer ledger, fsynced),
 * then reaches the named crash checkpoint BEFORE any receipt can be
 * persisted, writes the fault-hit evidence it observed, and terminates
 * abruptly. The parent process then proves:
 * - the child really died at that point (exit code 17, evidence marker),
 * - the durable SQLite attempt row survived the crash,
 * - the observer ledger survived and still counts exactly one execution,
 * - no receipt exists, so the product knowledge must remain `unknown`.
 *
 * This file is imported by tests (type-checked) but only executes its main
 * when run directly through `node --import tsx`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FaultInjector, FaultInjectedError } from '../faults.js';
import { IndependentEffectLedger } from '../observer.js';

export const CRASH_CHILD_CHECKPOINT = 'after-execution-before-receipt';
export const CRASH_CHILD_EXIT_CODE = 17;

export interface CrashChildResult {
  readonly exitCode: number;
  readonly effectId: string;
  readonly requestId: string;
  readonly crashEvidencePath: string;
  readonly productRoot: string;
  readonly observerRoot: string;
}

/** Used by the parent test to derive the roots from one temp directory. */
export function crashChildPaths(root: string): { productRoot: string; observerRoot: string; crashEvidencePath: string } {
  return {
    productRoot: join(root, 'product'),
    observerRoot: join(root, 'observer'),
    crashEvidencePath: join(root, 'crash-evidence.json'),
  };
}

export async function runCrashChild(): Promise<void> {
  const root = process.env.HARNESS_FIXTURE_ROOT;
  if (root === undefined || root.length === 0) throw new Error('HARNESS_FIXTURE_ROOT is required');
  const runId = process.env.HARNESS_RUN_ID ?? 'run-crash-fixture';
  const { productRoot, observerRoot, crashEvidencePath } = crashChildPaths(root);
  await mkdir(productRoot, { recursive: true });
  await mkdir(observerRoot, { recursive: true });

  const effectId = 'effect-crash-1';
  const requestId = 'request-crash-1';
  const database = new DatabaseSync(join(productRoot, 'control.sqlite'));
  database.exec(`
    CREATE TABLE IF NOT EXISTS effect_attempts (
      effect_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      dispatched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS effect_receipts (
      effect_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
  `);
  database
    .prepare('INSERT INTO effect_attempts (effect_id, request_id, operation, dispatched_at) VALUES (?, ?, ?, ?)')
    .run(effectId, requestId, 'message.send', new Date().toISOString());

  const ledger = await IndependentEffectLedger.open({ directory: observerRoot, runId });
  await ledger.recordAttempt({ operation: 'message.send', requestId, endpoint: 'synthetic-endpoint' });
  await ledger.recordExecution({
    effectId,
    operation: 'message.send',
    requestId,
    idempotency: 'non-idempotent',
    payloadDigest: 'a'.repeat(64),
    endpoint: 'synthetic-endpoint',
  });

  const injector = new FaultInjector({ runId, allowProcessExit: true });
  injector.plan([{ name: 'crash-after-execution', checkpoint: CRASH_CHILD_CHECKPOINT, action: 'throw', code: 'CRASH_WINDOW_REACHED' }]);

  try {
    injector.checkpoint('after-attempt-recorded');
    injector.checkpoint(CRASH_CHILD_CHECKPOINT);
  } catch (error) {
    if (!(error instanceof FaultInjectedError)) throw error;
    // Persist proof of the exact hit location, then die without cleanup:
    // no receipt row, no ledger.close(), no database.close().
    await writeFile(
      crashEvidencePath,
      JSON.stringify(
        {
          runId,
          checkpoint: error.checkpoint,
          faultName: error.faultName,
          ordinal: error.ordinal,
          code: error.code,
          effectId,
          requestId,
          hasReceipt: false,
        },
        null,
        2,
      ),
      'utf8',
    );
    process.exit(CRASH_CHILD_EXIT_CODE);
  }
  throw new Error('crash checkpoint did not fire; fixture is not simulating a crash');
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  await runCrashChild();
}
