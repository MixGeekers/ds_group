/**
 * Independent observer / effect ledger tests (H0.OBSERVER).
 *
 * Includes a REAL child process that owns a real temporary SQLite database
 * and an observer ledger in a separate root, executes one synthetic effect,
 * then dies at a named crash checkpoint before any receipt. The parent proves
 * durability, the "executed once but receipt lost still counts one effect"
 * rule, and that product knowledge must stay unknown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  AppendOnlyLedger,
  IndependentEffectLedger,
  alignObserverWithProduct,
  checkLedgerIntegrity,
  readLedgerFile,
} from './harness/observer.js';
import { canonicalJsonString } from './harness/json.js';
import { sha256Hex } from './harness/invariant.js';
import {
  CRASH_CHILD_EXIT_CODE,
  crashChildPaths,
} from './harness/fixtures/crash-child.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function withTempDirectory<T>(prefix: string, body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runCrashChild(root: string): Promise<{ code: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null }> {
  const entry = join(pluginRoot, 'tests/harness/fixtures/crash-child.ts');
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: pluginRoot,
      env: { ...process.env, HARNESS_FIXTURE_ROOT: root, HARNESS_RUN_ID: 'run-crash-parent' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
    }, 30_000);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolvePromise({ code, stdout, stderr, signal });
    });
  });
}

test('observer:ledger-append-read-roundtrip', async () => {
  await withTempDirectory('shiyu-harness-ledger-', async directory => {
    const file = join(directory, 'observer.jsonl');
    const ledger = await AppendOnlyLedger.open({ file, runId: 'run-roundtrip', actor: 'independent-observer' });
    try {
      const first = await ledger.append({ kind: 'effect.attempt', payload: { operation: 'message.send' }, identity: { requestId: 'req-1' }, causalKey: 'msg-1' });
      const second = await ledger.append({ kind: 'effect.execution', payload: { operation: 'message.send', attempt: 1 }, identity: { effectId: 'eff-1' }, causalKey: 'msg-1' });
      const third = await ledger.append({ kind: 'effect.receipt-lost', payload: { reason: 'socket closed' }, identity: { effectId: 'eff-1' }, causalKey: 'msg-1' });
      assert.equal(first.seq, 1);
      assert.equal(third.prevHash, second.hash);
    } finally {
      await ledger.close();
    }
    const read = await readLedgerFile(file, { expectedRunId: 'run-roundtrip' });
    assert.equal(read.ok, true, JSON.stringify(read.issues));
    assert.equal(read.records.length, 3);
    assert.equal(read.stats.truncatedTailBytes, 0);
    // Independent hash-chain recomputation (second implementation, not the writer's helper).
    let previous = 'GENESIS';
    for (const record of read.records) {
      const body: Record<string, unknown> = {
        schemaVersion: record.schemaVersion,
        runId: record.runId,
        seq: record.seq,
        at: record.at,
        actor: record.actor,
        kind: record.kind,
        payload: record.payload,
        prevHash: record.prevHash,
      };
      if (record.identity !== undefined) body.identity = record.identity;
      if (record.causalKey !== undefined) body.causalKey = record.causalKey;
      const recomputed = sha256Hex(`${previous}\n${canonicalJsonString(body)}`);
      assert.equal(record.hash, recomputed, `hash chain must verify for seq ${record.seq}`);
      previous = record.hash;
    }
    // A partial trailing record must be reported, never silently skipped.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, '{"schemaVersion":1,"runId":"run-roundtrip"');
    const broken = await readLedgerFile(file, { expectedRunId: 'run-roundtrip' });
    assert.equal(broken.ok, false);
    assert.ok(broken.issues.some(issue => issue.code === 'truncated_tail'));
    assert.equal(checkLedgerIntegrity(broken).ok, false);
  });
});

test('observer:ledger-real-sqlite-child-crash-survives', async () => {
  await withTempDirectory('shiyu-harness-crash-', async directory => {
    const result = await runCrashChild(directory);
    assert.equal(result.signal, null, `child should exit, not be killed: stderr=${result.stderr}`);
    assert.equal(result.code, CRASH_CHILD_EXIT_CODE, `child must die at the crash checkpoint; stderr=${result.stderr}`);
    const { productRoot, observerRoot, crashEvidencePath } = crashChildPaths(directory);
    const evidence = JSON.parse(await readFile(crashEvidencePath, 'utf8')) as {
      checkpoint: string;
      faultName: string;
      ordinal: number;
      effectId: string;
      requestId: string;
      hasReceipt: boolean;
    };
    assert.equal(evidence.checkpoint, 'after-execution-before-receipt');
    assert.equal(evidence.faultName, 'crash-after-execution');
    assert.equal(evidence.ordinal, 1);
    assert.equal(evidence.hasReceipt, false);
    // 1) Durable SQLite rows survived the abrupt process exit.
    const database = new DatabaseSync(join(productRoot, 'control.sqlite'));
    try {
      const attempts = database.prepare('SELECT COUNT(*) AS count FROM effect_attempts').get() as { count: number };
      const receipts = database.prepare('SELECT COUNT(*) AS count FROM effect_receipts').get() as { count: number };
      assert.equal(attempts.count, 1, 'dispatched attempt persisted before the crash');
      assert.equal(receipts.count, 0, 'no receipt may exist when the crash window is before receipt persistence');
      const row = database.prepare('SELECT effect_id, request_id FROM effect_attempts').get() as { effect_id: string; request_id: string };
      assert.equal(row.effect_id, evidence.effectId);
      assert.equal(row.request_id, evidence.requestId);
    } finally {
      database.close();
    }
    // 2) Observer ledger in a separate root survived, is integrity-valid, and
    //    still counts exactly one execution with zero receipts.
    const read = await readLedgerFile(join(observerRoot, IndependentEffectLedger.FILE_NAME), { expectedRunId: 'run-crash-parent' });
    assert.equal(read.ok, true, JSON.stringify(read.issues));
    const ledger = await IndependentEffectLedger.open({ directory: observerRoot, runId: 'run-crash-parent' });
    try {
      const summary = await ledger.summary(evidence.effectId);
      assert.equal(summary.executions, 1, 'executed-once must stay exactly one effect after the crash');
      assert.equal(summary.receipts, 0);
      assert.equal(summary.receiptsLost, 0);
      const unknown = await ledger.check({ effectId: evidence.effectId, productKnowledge: 'unknown', idempotent: false });
      assert.equal(unknown.ok, true, `unknown with one observed execution is the correct knowledge state: ${JSON.stringify(unknown.violations)}`);
      const success = await ledger.check({ effectId: evidence.effectId, productKnowledge: 'succeeded', idempotent: false });
      assert.equal(success.ok, false, 'success without a persistent receipt must be rejected');
      assert.ok(success.violations.some(item => item.code === 'success_without_independent_receipt'));
      const duplicate = await ledger.recordExecution({
        effectId: evidence.effectId,
        operation: 'message.send',
        requestId: evidence.requestId,
        idempotency: 'non-idempotent',
        payloadDigest: 'a'.repeat(64),
      });
      assert.equal(duplicate.duplicateSuppressed, true, 'retry with the same requestId must be suppressed, not re-executed');
      assert.equal((await ledger.summary(evidence.effectId)).executions, 1);
    } finally {
      await ledger.close();
    }
  });
});

test('observer:effect-ledger-lost-receipt', async () => {
  await withTempDirectory('shiyu-harness-effect-', async directory => {
    const ledger = await IndependentEffectLedger.open({ directory, runId: 'run-effect' });
    try {
      await ledger.recordAttempt({ operation: 'note.write', requestId: 'req-7' });
      const execution = await ledger.recordExecution({
        effectId: 'eff-7',
        operation: 'note.write',
        requestId: 'req-7',
        idempotency: 'idempotent',
        payloadDigest: sha256Hex('note-content'),
      });
      assert.equal(execution.recorded, true);
      const before = await ledger.check({ effectId: 'eff-7', productKnowledge: 'unknown', idempotent: true });
      assert.equal(before.ok, true);
      await ledger.recordReceipt({ effectId: 'eff-7', receiptId: 'receipt-7', status: 'delivered', evidenceRef: 'endpoint-log-7' });
      const after = await ledger.check({ effectId: 'eff-7', productKnowledge: 'succeeded', idempotent: true });
      assert.equal(after.ok, true, 'with an independent receipt, success is allowed');
      const summary = await ledger.summary('eff-7');
      assert.deepEqual({ attempts: summary.attempts, executions: summary.executions, receipts: summary.receipts }, { attempts: 1, executions: 1, receipts: 1 });
    } finally {
      await ledger.close();
    }
  });
});

test('observer:observer-independence-and-alignment', async () => {
  await withTempDirectory('shiyu-harness-align-', async directory => {
    const productRoot = join(directory, 'product');
    const observerDirectory = join(directory, 'observer');
    const ledger = await IndependentEffectLedger.open({ directory: observerDirectory, runId: 'run-align' });
    try {
      const separate = ledger.checkIndependence({ productRoot });
      assert.equal(separate.ok, true, JSON.stringify(separate.violations));
      await ledger.recordExecution({
        effectId: 'eff-align',
        operation: 'message.send',
        requestId: 'req-align',
        idempotency: 'non-idempotent',
        payloadDigest: 'b'.repeat(64),
      });
      await ledger.recordReceipt({ effectId: 'eff-align', receiptId: 'rcp-align', status: 'accepted' });
      const read = await ledger.read();
      const aligned = alignObserverWithProduct({
        records: read.records.filter(record => record.identity?.effectId === 'eff-align' && record.kind === 'effect.execution'),
        expectedRunId: 'run-align',
        productFacts: [{ kind: 'effect', id: 'eff-align', causalKey: 'eff-align', status: 'success' }],
      });
      assert.equal(aligned.ok, true, JSON.stringify(aligned.violations));
      const unpaired = alignObserverWithProduct({
        records: read.records,
        expectedRunId: 'run-align',
        productFacts: [],
      });
      assert.equal(unpaired.ok, false);
      assert.ok(unpaired.violations.some(item => item.code === 'unpaired_observer_fact'));
    } finally {
      await ledger.close();
    }
    const inside = join(productRoot, 'observer');
    const insideLedger = await IndependentEffectLedger.open({ directory: inside, runId: 'run-inside' });
    try {
      const check = insideLedger.checkIndependence({ productRoot });
      assert.equal(check.ok, false, 'observer ledger inside the product root must be rejected');
      assert.ok(check.violations.some(item => item.code === 'observer_file_inside_product_root'));
    } finally {
      await insideLedger.close();
    }
  });
});

test('observer:ledger-tamper-evidence', async () => {
  await withTempDirectory('shiyu-harness-tamper2-', async directory => {
    const file = join(directory, 'observer.jsonl');
    const ledger = await AppendOnlyLedger.open({ file, runId: 'run-tamper2', actor: 'observer' });
    try {
      await ledger.append({ kind: 'effect.attempt', payload: { operation: 'message.send', requestId: 'r1' } });
      await ledger.append({ kind: 'effect.execution', payload: { operation: 'message.send', requestId: 'r1' } });
    } finally {
      await ledger.close();
    }
    const text = await readFile(file, 'utf8');
    await import('node:fs/promises').then(async fs => fs.writeFile(file, text.replace('"requestId":"r1"', '"requestId":"r2"')));
    const read = await readLedgerFile(file, { expectedRunId: 'run-tamper2' });
    const check = checkLedgerIntegrity(read);
    assert.equal(check.ok, false);
    assert.ok(check.violations.some(item => item.code === 'hash_mismatch'));
  });
});
