import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { EffectError, EffectLedger } from '../src/control/effects/index.js';
import type { ClaimRequest, DispatchAuthorizer, DispatchVerdict, EffectClaim, EffectInput, EffectReceiptInput, ReceiptVerifier } from '../src/control/effects/index.js';

const initial = '2026-11-02T05:00:00.000Z';
const payloadHash = 'a'.repeat(64);
const auth = { mandateId: 'mandate-a', mandateVersion: 1, authEpoch: 2, installationGeneration: 'install-a' };
const input = (key = 'effect-a', patch: Partial<EffectInput> = {}): EffectInput => ({
  effectId: key, idempotencyKey: `key-${key}`, origin: { kind: 'task', taskId: 'task-a', assignmentId: 'assignment-a' },
  action: 'synthetic.write', resourceScopes: ['synthetic-resource-a'], payloadRef: 'object-synthetic-a', payloadHash,
  replayClass: 'non_replayable', authorization: auth, expiresAt: '2026-11-02T06:00:00.000Z', ...patch,
});
const request = (effectId = 'effect-a', patch: Partial<ClaimRequest> = {}): ClaimRequest => ({ effectId, ownerId: 'dispatcher-a', hostEpoch: 'host-a', installationGeneration: 'install-a', fencingToken: 1, leaseMs: 1000, ...patch });
const allowed = (patch: Partial<DispatchVerdict & { allowed: true }> = {}): DispatchAuthorizer => () => ({ allowed: true, ...auth, hostEpoch: 'host-a', fencingToken: 1, ...patch });
const receipt = (receiptId = 'receipt-a', patch: Partial<EffectReceiptInput> = {}): EffectReceiptInput => ({ receiptId, serviceId: 'synthetic-device-a', externalOperationId: 'external-operation-a', observedAt: initial, outcome: 'succeeded', payloadHash, evidenceRefs: ['evidence-synthetic-a'], ...patch });
const verified: ReceiptVerifier = (effect, result) => ({ verified: true, installationGeneration: 'install-a', serviceId: result.serviceId, externalOperationId: result.externalOperationId, reconciled: true, settledEffect: { idempotencyKey: effect.idempotencyKey, payloadHash: effect.payloadHash, outcome: result.outcome } });
const code = (expected: string) => (error: unknown) => error instanceof EffectError && error.code === expected;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-effects-'));
  const filename = join(directory, 'effects.sqlite');
  let clock = Date.parse(initial);
  const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const tx = new SqliteTransactions(db);
    const ledger = new EffectLedger(db, tx, { now: () => new Date(clock) });
    connections.add(db);
    return { db, tx, ledger, close: () => { if (connections.delete(db)) db.close(); } };
  };
  t.after(async () => { for (const db of connections) db.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...open(), open, filename, advance: (ms: number) => { clock += ms; } };
}

test('Effect schema requires exactly one complete origin and bounded explicit intent', async t => {
  const { ledger } = await fixture(t);
  assert.throws(() => ledger.enqueue(input('bad', { origin: { kind: 'task', taskId: 'x' } as any })), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.enqueue(input('bad', { origin: { kind: 'task', taskId: 'x', assignmentId: 'y', conversationId: 'z' } as any })), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.enqueue(input('bad', { origin: { kind: 'dialogue', conversationId: 'x', turnId: 'y', conversationGeneration: -1 } })), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.enqueue(input('bad', { resourceScopes: [] })), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.enqueue(input('bad', { resourceScopes: ['x', 'x'] })), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.enqueue(input('bad', { payloadHash: 'unverified' })), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.enqueue(input('bad', { maxAttempts: 21 })), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.enqueue(input('bad', { expiresAt: initial })), code('EXPIRED'));
  assert.equal(ledger.list().length, 0);
  const dialogue = ledger.enqueue(input('dialogue', { origin: { kind: 'dialogue', conversationId: 'conversation-a', turnId: 'turn-a', conversationGeneration: 4 } }));
  assert.equal(dialogue.origin.kind, 'dialogue');
});

test('idempotent admission preserves the whole intent across restart and rejects changed payload or authority', async t => {
  const first = await fixture(t);
  const stored = first.ledger.enqueue(input());
  first.close(); const second = first.open();
  assert.deepEqual(second.ledger.enqueue(input()), stored);
  for (const patch of [{ payloadHash: 'b'.repeat(64) }, { action: 'different' }, { authorization: { ...auth, authEpoch: 3 } }, { effectId: 'different' }]) {
    assert.throws(() => second.ledger.enqueue(input('effect-a', patch)), code('IDEMPOTENCY_CONFLICT'));
  }
  assert.throws(() => second.ledger.enqueue(input('effect-a', { idempotencyKey: 'another-key' })), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(second.ledger.list().length, 1);
});

test('domain writes and Effect admission roll back together on the same SQLite transaction', async t => {
  const { db, tx, ledger } = await fixture(t);
  db.exec('CREATE TABLE synthetic_task(id TEXT PRIMARY KEY)');
  assert.throws(() => tx.atomic(() => {
    db.prepare('INSERT INTO synthetic_task(id) VALUES(?)').run('task-a');
    ledger.enqueue(input());
    throw new Error('synthetic domain failure');
  }), /synthetic domain failure/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic_task').get()!.n, 0);
  assert.equal(ledger.get('effect-a'), undefined);
  const wrong = new DatabaseSync(':memory:');
  try { assert.throws(() => new EffectLedger(wrong, tx), code('TRANSACTION_MISMATCH')); } finally { wrong.close(); }
});

test('claim and execution-point checks reject revoked authorization, changed fences and stale dialogue generations', async t => {
  const { ledger } = await fixture(t);
  ledger.enqueue(input());
  assert.throws(() => ledger.claim(request(), () => ({ allowed: false, reasonCode: 'paused' })), code('FORBIDDEN'));
  assert.throws(() => ledger.claim(request(), allowed({ authEpoch: 3 })), code('STALE_AUTHORIZATION'));
  assert.throws(() => ledger.claim(request(), allowed({ hostEpoch: 'other-host' })), code('STALE_FENCE'));
  assert.throws(() => ledger.claim(request(), (async () => allowed()(ledger.get('effect-a')!)) as any), code('ASYNC_POLICY'));
  assert.equal(ledger.attempts('effect-a').length, 0);
  const claim = ledger.claim(request(), allowed())!;
  assert.equal(ledger.assertDispatch(claim, allowed()).status, 'dispatching');
  assert.throws(() => ledger.assertDispatch(claim, allowed({ authEpoch: 3 })), code('STALE_AUTHORIZATION'));
  assert.throws(() => ledger.assertDispatch(claim, allowed({ fencingToken: 2 })), code('STALE_FENCE'));
  ledger.enqueue(input('dialogue', { resourceScopes: ['another-resource'], origin: { kind: 'dialogue', conversationId: 'c-a', turnId: 't-a', conversationGeneration: 4 } }));
  assert.throws(() => ledger.claim(request('dialogue'), allowed({ conversationGeneration: 3 })), code('STALE_CONVERSATION'));
  const dialogue = ledger.claim(request('dialogue'), allowed({ conversationGeneration: 4 }))!;
  assert.throws(() => ledger.assertDispatch(dialogue, allowed({ conversationGeneration: 5 })), code('STALE_CONVERSATION'));
});

test('async hooks are rejected before invocation and arbitrary thenables never run after rollback', async t => {
  const { ledger } = await fixture(t); ledger.enqueue(input());
  let calls = 0;
  const asynchronous = async () => { calls++; return allowed()(ledger.get('effect-a')!); };
  assert.throws(() => ledger.claim(request(), asynchronous as any), code('ASYNC_POLICY'));
  const thenable = { then() { calls++; } };
  assert.throws(() => ledger.claim(request(), (() => thenable) as any), code('ASYNC_POLICY'));
  assert.throws(() => ledger.claim(request(), (() => Promise.reject(new Error('already-created rejected Promise'))) as any), code('ASYNC_POLICY'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(ledger.attempts('effect-a').length, 0);
  const claim = ledger.claim(request(), allowed())!;
  assert.throws(() => ledger.complete(claim, receipt(), (async () => { calls++; return verified(ledger.get('effect-a')!, receipt()); }) as any), code('ASYNC_POLICY'));
  assert.throws(() => ledger.complete(claim, receipt(), (() => thenable) as any), code('ASYNC_POLICY'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(ledger.receipts('effect-a').length, 0);
});

test('50 claims from independent SQLite Workers produce one durable winner', async t => {
  const { ledger, filename } = await fixture(t); ledger.enqueue(input());
  const workers: Worker[] = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const source = `
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {tsImport}=await import('tsx/esm/api');
      const {DatabaseSync}=await import('node:sqlite');
      const {EffectLedger}=await tsImport(workerData.ledgerUrl, workerData.baseUrl);
      const {SqliteTransactions}=await tsImport(workerData.txUrl, workerData.baseUrl);
      const db=new DatabaseSync(workerData.filename); db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
      try {
        const ledger=new EffectLedger(db,new SqliteTransactions(db),{now:()=>new Date(workerData.now)});
        let winners=0;
        for(let i=0;i<5;i++) if(ledger.claim(workerData.request,()=>workerData.verdict)) winners++;
        parentPort.postMessage({winners});
      } finally {db.close();}
    })().catch(e=>{parentPort.postMessage({error:e.message});process.exitCode=1;});
  `;
  const counts = await Promise.all(Array.from({ length: 10 }, (_, index) => new Promise<number>((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: {
      filename, ledgerUrl: new URL('../src/control/effects/index.ts', import.meta.url).href,
      txUrl: new URL('../src/adapters/control-store/transaction.ts', import.meta.url).href,
      baseUrl: import.meta.url, now: initial, request: request('effect-a', { ownerId: `dispatcher-${index}` }),
      verdict: { allowed: true, ...auth, hostEpoch: 'host-a', fencingToken: 1 },
    } });
    workers.push(worker); worker.once('error', reject);
    worker.once('message', result => result.error ? reject(new Error(result.error)) : resolve(result.winners));
    worker.once('exit', exit => { if (exit !== 0) reject(new Error(`Synthetic worker exited ${exit}`)); });
  })));
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
  assert.equal(ledger.get('effect-a')!.attempts, 1);
  assert.equal(ledger.attempts('effect-a').length, 1);
});

test('lease expiry and a restarted host preserve non-replayable uncertainty rather than dispatch again', async t => {
  const first = await fixture(t); first.ledger.enqueue(input());
  const claim = first.ledger.claim(request(), allowed())!;
  first.advance(1001);
  assert.throws(() => first.ledger.assertDispatch(claim, allowed()), code('STALE_FENCE'));
  const [unknown] = first.ledger.recover({ installationGeneration: 'install-a', hostEpoch: 'host-a' });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.reasonCode, 'lease_expired');
  assert.deepEqual(first.ledger.recover({ installationGeneration: 'install-a', hostEpoch: 'host-a' }), []);
  first.close(); const second = first.open();
  assert.equal(second.ledger.get('effect-a')!.status, 'unknown');
  assert.equal(second.ledger.claim(request('effect-a', { hostEpoch: 'host-b', fencingToken: 2 }), allowed({ hostEpoch: 'host-b', fencingToken: 2 })), undefined);
  assert.throws(() => second.ledger.retry('effect-a', unknown.version, 'manual_retry', allowed()), code('REPLAY_FORBIDDEN'));
  assert.equal(second.ledger.attempts('effect-a')[0].status, 'unknown');
});

test('host recovery fences a still-leased old attempt; a prior installation cannot accept receipts', async t => {
  const { ledger } = await fixture(t); ledger.enqueue(input());
  const claim = ledger.claim(request(), allowed())!;
  const [unknown] = ledger.recover({ installationGeneration: 'install-a', hostEpoch: 'host-b' });
  assert.equal(unknown.reasonCode, 'host_changed');
  assert.throws(() => ledger.complete(claim, receipt(), verified), code('RESULT_UNKNOWN'));
  const previousInstall: ReceiptVerifier = (effect, value) => ({ ...verified(effect, value), verified: true, installationGeneration: 'install-b', serviceId: value.serviceId, externalOperationId: value.externalOperationId, reconciled: true, settledEffect: { idempotencyKey: effect.idempotencyKey, payloadHash: effect.payloadHash, outcome: value.outcome } });
  assert.throws(() => ledger.reconcile(claim, receipt(), previousInstall), code('STALE_FENCE'));
  assert.equal(ledger.reconcile(claim, receipt(), verified).status, 'succeeded');
});

test('verified receipts are durable facts, idempotent on replay, and cannot be forged by stale claims', async t => {
  const { ledger } = await fixture(t); ledger.enqueue(input());
  const claim = ledger.claim(request(), allowed())!;
  assert.throws(() => ledger.complete({ ...claim, claimToken: 'wrong' }, receipt(), verified), code('STALE_FENCE'));
  assert.throws(() => ledger.complete({ ...claim, fencingToken: 2 }, receipt(), verified), code('STALE_FENCE'));
  assert.throws(() => ledger.complete(claim, receipt('bad', { payloadHash: 'b'.repeat(64) }), verified), code('RECEIPT_MISMATCH'));
  assert.throws(() => ledger.complete(claim, receipt(), () => ({ verified: false, reasonCode: 'untrusted' })), code('UNVERIFIED_RECEIPT'));
  assert.throws(() => ledger.complete(claim, receipt(), () => ({ verified: true, installationGeneration: 'install-a', serviceId: 'different', externalOperationId: 'external-operation-a', reconciled: true, settledEffect: null })), code('UNVERIFIED_RECEIPT'));
  assert.throws(() => ledger.complete(claim, receipt(), (async () => { throw new Error('async verifier rejected'); }) as any), code('ASYNC_POLICY'));
  assert.equal(ledger.receipts('effect-a').length, 0);
  const done = ledger.complete(claim, receipt(), verified);
  assert.equal(done.status, 'succeeded'); assert.equal(ledger.attempts('effect-a')[0].status, 'succeeded');
  assert.deepEqual(ledger.complete(claim, receipt(), verified), done);
  const reordered = Object.fromEntries(Object.entries(claim).reverse()) as unknown as EffectClaim;
  assert.deepEqual(ledger.complete(reordered, receipt(), verified), done);
  assert.throws(() => ledger.complete(claim, receipt('receipt-a', { outcome: 'failed' }), verified), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(ledger.receipts('effect-a').length, 1);
  assert.equal(ledger.list().length, 1);
});

test('late receipt requires uncertainty classification and independent same-operation reconciliation', async t => {
  const { ledger, advance } = await fixture(t); ledger.enqueue(input());
  const claim = ledger.claim(request(), allowed())!;
  advance(1001);
  assert.throws(() => ledger.complete(claim, receipt(), verified), code('RESULT_UNKNOWN'));
  assert.throws(() => ledger.reconcile(claim, receipt(), verified), code('INVALID_STATE'));
  const unknown = ledger.markUnknown(claim, 'transport_timeout');
  assert.deepEqual(ledger.markUnknown(claim, 'transport_timeout'), unknown);
  assert.throws(() => ledger.reconcile(claim, receipt(), (effect, result) => ({ ...verified(effect, result), reconciled: false } as any)), code('UNVERIFIED_RECEIPT'));
  assert.throws(() => ledger.reconcile(claim, receipt(), (effect, result) => ({ ...verified(effect, result), reconciled: 'false' } as any)), code('UNVERIFIED_RECEIPT'));
  assert.equal(ledger.reconcile(claim, receipt(), verified).status, 'succeeded');
  assert.equal(ledger.receipts('effect-a')[0].mode, 'reconciliation');
});

test('explicit idempotent retry requires a new fence, retains attempts and rejects old receipts', async t => {
  const { ledger } = await fixture(t); ledger.enqueue(input('effect-a', { replayClass: 'idempotent', maxAttempts: 2 }));
  const old = ledger.claim(request(), allowed())!;
  assert.equal(ledger.hasUncertaintyForTask('task-a'), false);
  const unknown = ledger.markUnknown(old, 'transport_timeout');
  assert.equal(ledger.hasUncertaintyForTask('task-a'), true);
  const pending = ledger.retry('effect-a', unknown.version, 'explicit_idempotent_retry', allowed());
  assert.equal(pending.status, 'pending');
  assert.throws(() => ledger.claim(request(), allowed()), code('STALE_FENCE'));
  const current = ledger.claim(request('effect-a', { fencingToken: 2 }), allowed({ fencingToken: 2 }))!;
  assert.equal(ledger.hasUncertaintyForTask('task-a'), true);
  assert.notEqual(current.claimToken, old.claimToken);
  assert.throws(() => ledger.reconcile(old, receipt(), verified), code('STALE_FENCE'));
  assert.throws(() => ledger.complete(current, receipt('attempt-failed', { outcome: 'failed' }), (effect, result) => ({ ...verified(effect, result), settledEffect: null } as any)), code('RESULT_UNKNOWN'));
  assert.equal(ledger.hasUncertaintyForTask('task-a'), true);
  assert.equal(ledger.get('effect-a')!.status, 'dispatching');
  assert.throws(() => ledger.complete(current, receipt('wrong-effect-proof', { outcome: 'failed' }), (effect, result) => ({ ...verified(effect, result), settledEffect: { idempotencyKey: 'different-key', payloadHash, outcome: result.outcome } } as any)), code('UNVERIFIED_RECEIPT'));
  const done = ledger.complete(current, receipt('second-result', { outcome: 'failed' }), verified);
  assert.equal(ledger.hasUncertaintyForTask('task-a'), false);
  assert.throws(() => ledger.retry('effect-a', done.version, 'try_again', allowed({ fencingToken: 2 })), code('ATTEMPTS_EXHAUSTED'));
  assert.deepEqual(ledger.attempts('effect-a').map(attempt => attempt.status), ['unknown', 'failed']);
});

test('pending cancellation prevents work; in-flight cancellation is only a request and cannot erase a result', async t => {
  const { ledger } = await fixture(t);
  const pending = ledger.enqueue(input('pending'));
  const cancelled = ledger.cancel('pending', pending.version, 'user_stop');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(ledger.claim(request('pending'), allowed()), undefined);
  ledger.enqueue(input()); const claim = ledger.claim(request(), allowed())!;
  const version = ledger.get('effect-a')!.version;
  assert.throws(() => ledger.cancel('effect-a', version - 1, 'user_stop'), code('VERSION_CONFLICT'));
  const requested = ledger.cancel('effect-a', version, 'user_stop');
  assert.equal(requested.status, 'dispatching'); assert.ok(requested.cancelRequestedAt);
  assert.throws(() => ledger.assertDispatch(claim, allowed()), code('CANCEL_REQUESTED'));
  const done = ledger.complete(claim, receipt(), verified);
  assert.equal(done.status, 'succeeded'); assert.equal(done.cancelRequestedAt, initial);
});

test('unknown and dispatching Effects lock matching resource identities until a verified outcome exists', async t => {
  const { ledger } = await fixture(t);
  ledger.enqueue(input()); ledger.enqueue(input('same-resource')); ledger.enqueue(input('independent', { resourceScopes: ['resource-b'] }));
  const claim = ledger.claim(request(), allowed())!;
  assert.throws(() => ledger.claim(request('same-resource'), allowed()), code('RESOURCE_BUSY'));
  assert.ok(ledger.claim(request('independent'), allowed()));
  ledger.markUnknown(claim, 'result_lost');
  assert.throws(() => ledger.claim(request('same-resource'), allowed()), code('RESOURCE_BUSY'));
  ledger.reconcile(claim, receipt('proof-of-failure', { outcome: 'failed' }), verified);
  assert.ok(ledger.claim(request('same-resource'), allowed()));
});

test('preparing an idempotent retry does not release the resource lock of its unknown original attempt', async t => {
  const { ledger } = await fixture(t);
  ledger.enqueue(input('effect-a', { replayClass: 'idempotent', maxAttempts: 2 })); ledger.enqueue(input('competing'));
  const old = ledger.claim(request(), allowed())!;
  const unknown = ledger.markUnknown(old, 'result_lost');
  ledger.retry('effect-a', unknown.version, 'explicit_idempotent_retry', allowed());
  assert.equal(ledger.hasUncertainty('effect-a'), true);
  assert.throws(() => ledger.claim(request('competing'), allowed()), code('RESOURCE_BUSY'));
  const next = ledger.claim(request('effect-a', { fencingToken: 2 }), allowed({ fencingToken: 2 }))!;
  ledger.complete(next, receipt(), verified);
  assert.equal(ledger.hasUncertainty('effect-a'), false);
  assert.ok(ledger.claim(request('competing'), allowed()));
});

test('cancelling a queued retry preserves original uncertainty and a late original receipt can settle it', async t => {
  const { ledger } = await fixture(t);
  ledger.enqueue(input('effect-a', { replayClass: 'idempotent', maxAttempts: 2 })); ledger.enqueue(input('competing'));
  const old = ledger.claim(request(), allowed())!;
  const unknown = ledger.markUnknown(old, 'result_lost');
  const pending = ledger.retry('effect-a', unknown.version, 'explicit_retry', allowed());
  const cancelled = ledger.cancel('effect-a', pending.version, 'user_stop');
  assert.equal(cancelled.status, 'unknown'); assert.equal(ledger.hasUncertainty('effect-a'), true);
  assert.throws(() => ledger.claim(request('competing'), allowed()), code('RESOURCE_BUSY'));
  assert.equal(ledger.reconcile(old, receipt(), verified).status, 'succeeded');
  assert.ok(ledger.claim(request('competing'), allowed()));
});

test('reconciliation before a queued retry is claimed settles the original operation without another attempt', async t => {
  const { ledger } = await fixture(t);
  ledger.enqueue(input('effect-a', { replayClass: 'idempotent', maxAttempts: 2 }));
  const old = ledger.claim(request(), allowed())!;
  const unknown = ledger.markUnknown(old, 'result_lost');
  ledger.retry('effect-a', unknown.version, 'explicit_retry', allowed());
  assert.equal(ledger.reconcile(old, receipt(), verified).status, 'succeeded');
  assert.equal(ledger.claim(request('effect-a', { fencingToken: 2 }), allowed({ fencingToken: 2 })), undefined);
  assert.equal(ledger.attempts('effect-a').length, 1);
});

test('claim cannot escape an uncommitted outer transaction and status reads do not mutate facts', async t => {
  const { ledger, tx } = await fixture(t); const initialEffect = ledger.enqueue(input());
  assert.throws(() => tx.atomic(() => ledger.claim(request(), allowed())), code('NESTED_DISPATCH'));
  for (let i = 0; i < 50; i++) { ledger.get('effect-a'); ledger.list(); ledger.attempts('effect-a'); ledger.receipts('effect-a'); }
  assert.deepEqual(ledger.get('effect-a'), initialEffect);
  const claim = ledger.claim(request(), allowed())!;
  assert.throws(() => tx.atomic(() => ledger.assertDispatch(claim, allowed())), code('NESTED_DISPATCH'));
});

test('a failed receipt write rolls back the receipt and Effect transition together', async t => {
  const { ledger, db } = await fixture(t); ledger.enqueue(input()); const claim = ledger.claim(request(), allowed())!;
  db.exec("CREATE TRIGGER synthetic_receipt_failure BEFORE UPDATE ON shiyu_effects WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(() => ledger.complete(claim, receipt(), verified), /synthetic failure/);
  assert.equal(ledger.get('effect-a')!.status, 'dispatching');
  assert.equal(ledger.attempts('effect-a')[0].status, 'dispatching');
  assert.equal(ledger.receipts('effect-a').length, 0);
});

test('retry cannot bypass cancellation, current authorization or the original expiry', async t => {
  const { ledger, advance } = await fixture(t); ledger.enqueue(input('effect-a', { replayClass: 'idempotent', maxAttempts: 3 }));
  const claim = ledger.claim(request(), allowed())!;
  const unknown = ledger.markUnknown(claim, 'transport_timeout');
  assert.throws(() => ledger.retry('effect-a', unknown.version, 'try_again', allowed({ authEpoch: 9 })), code('STALE_AUTHORIZATION'));
  const cancelled = ledger.cancel('effect-a', unknown.version, 'user_stop');
  assert.equal(cancelled.status, 'unknown');
  assert.throws(() => ledger.retry('effect-a', cancelled.version, 'try_again', allowed()), code('CANCEL_REQUESTED'));
  ledger.enqueue(input('expire', { resourceScopes: ['other-resource'], replayClass: 'idempotent', maxAttempts: 2 }));
  const other = ledger.claim(request('expire'), allowed())!; const otherUnknown = ledger.markUnknown(other, 'transport_timeout');
  advance(3600001);
  assert.throws(() => ledger.retry('expire', otherUnknown.version, 'try_again', allowed()), code('EXPIRED'));
});
