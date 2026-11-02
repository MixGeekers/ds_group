import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { EffectLedger, EffectError } from '../src/control/effects/index.js';
import { MemoryOperationLedger, MemoryOperationError, memoryResource } from '../src/control/memory/index.js';
import type { MemoryApprover, MemoryBackendReceipt, MemoryClaimRequest, MemoryDispatchAuthorizer, MemoryLedgerOptions, MemoryOperationInput, MemoryReceiptVerifier, MemoryTombstoneInput } from '../src/control/memory/index.js';
import type { TrustedPolicyActor } from '../src/control/policy/mandates.js';

const instant = '2026-11-02T05:00:00.000Z';
const auth = { mandateId: 'mandate-a', mandateVersion: 1, authEpoch: 2, installationGeneration: 'install-a' };
const core: TrustedPolicyActor = { principalId: 'core', kind: 'agent', scopes: ['private-a'] };
const dispatcher: TrustedPolicyActor = { principalId: 'dispatcher', kind: 'component', scopes: ['private-a'] };
const verifier: TrustedPolicyActor = { principalId: 'verifier', kind: 'component', scopes: ['private-a'] };
const owner: TrustedPolicyActor = { principalId: 'owner', kind: 'owner', scopes: ['private-a'] };
const options: MemoryLedgerOptions = { backendIds: ['synthetic-vault-a'], approverIds: ['core'], dispatcherIds: ['dispatcher'], verifierIds: ['verifier'], eraserIds: ['owner'] };
const intent = (id = 'operation-a', patch: Partial<MemoryOperationInput> = {}): MemoryOperationInput => ({
  operationId: id, backendId: 'synthetic-vault-a', proposalId: `proposal-${id}`, kind: 'append', commandRef: `command-${id}`, commandDigest: 'a'.repeat(64),
  scope: 'private-a', targetRef: `target-${id}`, sourceRefs: [{ sourceId: 'source-a', revision: 1 }], dependencyRefs: [], expectedTombstoneWatermark: 0,
  origin: { kind: 'task', taskId: 'task-a', assignmentId: 'assignment-a' }, mandateRef: auth, expiresAt: '2026-11-02T06:00:00.000Z', ...patch,
});
const approved: MemoryApprover = () => ({ allowed: true, authorization: auth, sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: null, atomicVersionCheck: false });
const allowed: MemoryDispatchAuthorizer = () => ({ allowed: true, ...auth, hostEpoch: 'host-a', fencingToken: 1, sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: null, atomicVersionCheck: false });
const request = (operationId = 'operation-a', expectedVersion = 1, patch: Partial<MemoryClaimRequest> = {}): MemoryClaimRequest => ({ operationId, expectedVersion, ownerId: 'dispatcher', hostEpoch: 'host-a', installationGeneration: 'install-a', fencingToken: 1, leaseMs: 1000, ...patch });
const result = (operationId = 'operation-a', patch: Partial<MemoryBackendReceipt> = {}): MemoryBackendReceipt => ({
  receiptId: `receipt-${operationId}`, operationId, backendId: 'synthetic-vault-a', externalOperationId: `external-${operationId}`, commandDigest: 'a'.repeat(64),
  outcome: 'applied', observedAt: instant, nativeId: `native-${operationId}`, componentVersion: null, backendReceiptRef: `backend-receipt-${operationId}`, verificationRef: `verification-${operationId}`, evidenceRefs: [`evidence-${operationId}`], ...patch,
});
const verified: MemoryReceiptVerifier = (operation, receipt) => ({
  verified: true, operationId: operation.operationId, backendId: receipt.backendId, externalOperationId: receipt.externalOperationId,
  commandDigest: operation.commandDigest, outcome: receipt.outcome, installationGeneration: 'install-a', nativeId: receipt.nativeId, componentVersion: receipt.componentVersion,
  sourceRefs: operation.sourceRefs, operationSettled: true, reconciled: true, publicationAllowed: true, atomicCas: null,
});
const deletion = (patch: Partial<MemoryTombstoneInput> = {}): MemoryTombstoneInput => ({ deletionId: 'delete-a', scope: 'private-a', refs: ['source-a'], expectedWatermark: 0, reasonCode: 'USER_ERASURE', ...patch });
const code = (expected: string) => (error: unknown) => (error instanceof MemoryOperationError || error instanceof EffectError) && error.code === expected;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-memory-'));
  const filename = join(directory, 'control.sqlite'); let now = Date.parse(instant); const connections = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const tx = new SqliteTransactions(db); const clock = () => new Date(now);
    const ledger = new MemoryOperationLedger(db, tx, { ...options, now: clock }); const effects = new EffectLedger(db, tx, { now: clock }); connections.add(db);
    return { db, tx, ledger, effects, close: () => { if (connections.delete(db)) db.close(); } };
  };
  t.after(async () => { for (const db of connections) db.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...open(), open, filename, advance: (ms: number) => { now += ms; } };
}

test('approval stores only bounded control references and atomically admits one Effect', async t => {
  const { ledger, effects, db } = await fixture(t); const operation = ledger.approve(core, intent(), approved);
  assert.equal(operation.status, 'approved'); assert.equal(operation.version, 1); assert.equal(operation.nativeId, undefined);
  const effect = effects.get(operation.effectId)!;
  assert.equal(effect.action, 'memory.write'); assert.equal(effect.replayClass, 'reconcilable'); assert.equal(effect.maxAttempts, 1);
  assert.deepEqual(effect.resourceScopes, [memoryResource('private-a', 'synthetic-vault-a', 'target-operation-a')]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM shiyu_memory_operations').get()!.n, 1);
  assert.throws(() => ledger.approve(core, { ...intent('raw'), body: 'must not enter this ledger' } as any, approved), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.approve(core, intent('empty', { sourceRefs: [] }), approved), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.approve(core, intent('invalid', { commandDigest: 'not-a-digest' }), approved), code('INVALID_SCHEMA'));
  assert.throws(() => ledger.approve(core, intent('foreign', { backendId: 'unregistered-vault' }), approved), code('FORBIDDEN_BACKEND'));
  assert.throws(() => ledger.approve(core, intent('origin', { origin: { kind: 'memory' } as any }), approved), code('INVALID_SCHEMA'));
  assert.equal(effects.list().length, 1);
});

test('same operation identity survives restart; changing payload, scope, source revision or authority is rejected', async t => {
  const first = await fixture(t); const original = first.ledger.approve(core, intent(), approved); first.close(); const second = first.open();
  assert.deepEqual(second.ledger.approve(core, intent(), approved), original);
  for (const patch of [{ commandDigest: 'b'.repeat(64) }, { commandRef: 'different' }, { sourceRefs: [{ sourceId: 'source-a', revision: 2 }] }, { mandateRef: { ...auth, authEpoch: 3 } }, { dependencyRefs: ['other'] }]) {
    assert.throws(() => second.ledger.approve(core, intent('operation-a', patch), approved), code('IDEMPOTENCY_CONFLICT'));
  }
  assert.equal(second.effects.list().length, 1);
});

test('trusted roles, exact scopes and current authority are enforced at approval, claim, execution and receipts', async t => {
  const { ledger } = await fixture(t);
  assert.throws(() => ledger.approve({ ...core, principalId: 'model-says-owner' }, intent(), approved), code('FORBIDDEN'));
  assert.throws(() => ledger.approve({ ...core, scopes: ['private-a/child'] }, intent(), approved), code('FORBIDDEN'));
  assert.throws(() => ledger.approve(core, intent(), () => ({ allowed: false, reasonCode: 'no-consent' })), code('FORBIDDEN'));
  assert.throws(() => ledger.approve(core, intent(), () => ({ ...approved(intent(), core), authorization: { ...auth, authEpoch: 3 } }) as any), code('STALE_AUTHORIZATION'));
  ledger.approve(core, intent(), approved);
  assert.throws(() => ledger.claim(core, request(), allowed), code('FORBIDDEN'));
  assert.throws(() => ledger.claim(dispatcher, request(), () => ({ ...allowed(ledger.get('operation-a')!, dispatcher), sourcesVerified: false }) as any), code('UNVERIFIED_SOURCES'));
  const claim = ledger.claim(dispatcher, request(), allowed)!;
  assert.throws(() => ledger.assertDispatch(dispatcher, 'operation-a', claim, () => ({ allowed: false, reasonCode: 'paused' })), code('FORBIDDEN'));
  assert.throws(() => ledger.assertDispatch(dispatcher, 'operation-a', claim, () => ({ ...allowed(ledger.get('operation-a')!, dispatcher), authEpoch: 9 }) as any), code('STALE_AUTHORIZATION'));
  assert.throws(() => ledger.complete(dispatcher, 'operation-a', 2, claim, result(), verified), code('FORBIDDEN'));
  assert.throws(() => ledger.tombstone(core, deletion()), code('FORBIDDEN'));
  assert.equal(ledger.get('operation-a')!.status, 'dispatching');
});

test('native async hooks never run and foreign thenables are not assimilated', async t => {
  const { ledger } = await fixture(t); let calls = 0; const thenable = { then() { calls++; } };
  assert.throws(() => ledger.approve(core, intent(), (async () => { calls++; return approved(intent(), core); }) as any), code('ASYNC_POLICY'));
  assert.throws(() => ledger.approve(core, intent(), (() => thenable) as any), code('ASYNC_POLICY'));
  assert.throws(() => ledger.approve(core, intent(), (() => Promise.reject(new Error('synthetic rejected promise'))) as any), code('ASYNC_POLICY'));
  ledger.approve(core, intent(), approved);
  assert.throws(() => ledger.claim(dispatcher, request(), (async () => { calls++; return allowed(ledger.get('operation-a')!, dispatcher); }) as any), code('ASYNC_POLICY'));
  const claim = ledger.claim(dispatcher, request(), allowed)!;
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), (() => thenable) as any), code('ASYNC_POLICY'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0); assert.equal(ledger.receipts('operation-a').length, 0);
});

test('approval plus its Effect roll back with the caller transaction, and a different DB connection is refused', async t => {
  const { ledger, effects, tx } = await fixture(t);
  assert.throws(() => tx.atomic(() => { ledger.approve(core, intent(), approved); throw new Error('synthetic caller abort'); }), /synthetic caller abort/);
  assert.equal(ledger.get('operation-a'), undefined); assert.equal(effects.list().length, 0);
  const wrong = new DatabaseSync(':memory:');
  try { assert.throws(() => new MemoryOperationLedger(wrong, tx, options), code('TRANSACTION_MISMATCH')); } finally { wrong.close(); }
  ledger.approve(core, intent(), approved);
  assert.throws(() => tx.atomic(() => ledger.claim(dispatcher, request(), allowed)), code('NESTED_DISPATCH'));
  assert.equal(ledger.get('operation-a')!.status, 'approved');
});

test('backend CAS requires a real capability, current revision and atomic-write receipt proof', async t => {
  const { ledger } = await fixture(t);
  assert.throws(() => ledger.approve(core, intent('missing', { kind: 'update' }), approved), code('CAS_REQUIRED'));
  const update = intent('update', { kind: 'update', expectedComponentVersion: 'revision-7' });
  assert.throws(() => ledger.approve(core, update, approved), code('BACKEND_CAS_UNSUPPORTED'));
  const capable: MemoryApprover = () => ({ allowed: true, authorization: auth, sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: 'revision-7', atomicVersionCheck: true });
  ledger.approve(core, update, capable);
  assert.throws(() => ledger.claim(dispatcher, request('update'), () => ({ ...allowed(ledger.get('update')!, dispatcher), atomicVersionCheck: true, observedComponentVersion: 'revision-8' }) as any), code('COMPONENT_CONFLICT'));
  const dispatch: MemoryDispatchAuthorizer = () => ({ allowed: true, ...auth, hostEpoch: 'host-a', fencingToken: 1, sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: 'revision-7', atomicVersionCheck: true });
  const claim = ledger.claim(dispatcher, request('update'), dispatch)!;
  const proof = result('update', { componentVersion: 'revision-8' });
  assert.throws(() => ledger.complete(verifier, 'update', 2, claim, proof, verified), code('UNVERIFIED_CAS'));
  const applied = ledger.complete(verifier, 'update', 2, claim, proof, (op, receipt) => ({ ...verified(op, receipt), atomicCas: { expectedVersion: 'revision-7', resultVersion: 'revision-8' } }) as any);
  assert.equal(applied.status, 'applied'); assert.equal(applied.componentVersion, 'revision-8');
});

test('operation CAS is checked across connections, while an unrelated Effect revision cannot affect it', async t => {
  const first = await fixture(t); const second = first.open(); first.ledger.approve(core, intent(), approved);
  assert.throws(() => second.ledger.claim(dispatcher, request('operation-a', 9), allowed), code('VERSION_CONFLICT'));
  const claim = first.ledger.claim(dispatcher, request(), allowed)!;
  assert.equal(second.ledger.get('operation-a')!.version, 2);
  assert.throws(() => second.ledger.markUnknown(dispatcher, 'operation-a', 1, claim, 'TIMEOUT'), code('VERSION_CONFLICT'));
  second.ledger.markUnknown(dispatcher, 'operation-a', 2, claim, 'TIMEOUT');
  assert.equal(first.ledger.get('operation-a')!.status, 'unknown');
  first.ledger.approve(core, intent('unrelated', { sourceRefs: [{ sourceId: 'source-b', revision: 1 }] }), approved);
  assert.equal(first.ledger.get('operation-a')!.version, 3);
});

test('known pending and uncertain target dependencies block dispatch through source and dependency edges', async t => {
  const { ledger } = await fixture(t); ledger.approve(core, intent(), approved);
  ledger.approve(core, intent('dependent', { sourceRefs: [{ sourceId: 'independent-source', revision: 1 }], dependencyRefs: ['target-operation-a'] }), approved);
  ledger.approve(core, intent('source-edge', { sourceRefs: [{ sourceId: 'target-operation-a', revision: 1 }] }), approved);
  assert.throws(() => ledger.claim(dispatcher, request('dependent'), allowed), code('DEPENDENCY_NOT_APPLIED'));
  const first = ledger.claim(dispatcher, request(), allowed)!;
  ledger.markUnknown(dispatcher, 'operation-a', 2, first, 'TIMEOUT');
  assert.throws(() => ledger.claim(dispatcher, request('dependent'), allowed), code('DEPENDENCY_NOT_APPLIED'));
  assert.throws(() => ledger.claim(dispatcher, request('source-edge'), allowed), code('DEPENDENCY_NOT_APPLIED'));
  ledger.reconcile(verifier, 'operation-a', 3, first, result(), verified);
  const child = ledger.claim(dispatcher, request('dependent'), allowed)!;
  assert.ok(child);
  ledger.approve(core, intent('pending-update', { targetRef: 'target-operation-a', sourceRefs: [{ sourceId: 'new-source', revision: 1 }] }), approved);
  assert.throws(() => ledger.assertDispatch(dispatcher, 'dependent', child, allowed), code('DEPENDENCY_NOT_APPLIED'));
  const late = ledger.complete(verifier, 'dependent', 2, child, result('dependent'), verified);
  assert.equal(late.backendOutcome, 'applied'); assert.equal(late.status, 'unknown'); assert.equal(late.reasonCode, 'DEPENDENCY_NOT_APPLIED'); assert.equal(late.nativeId, undefined);
  assert.throws(() => ledger.approve(core, intent('external-dependency', { dependencyRefs: ['external-reference'] }), () => ({ ...approved(intent(), core), dependenciesVerified: false }) as any), code('UNVERIFIED_DEPENDENCIES'));
});

test('independent SQLite Workers race for one committed memory dispatch', async t => {
  const { ledger, filename, effects } = await fixture(t); ledger.approve(core, intent(), approved);
  const source = `const {parentPort,workerData}=require('node:worker_threads'); (async()=>{
    const {tsImport}=await import('tsx/esm/api'); const {DatabaseSync}=await import('node:sqlite');
    const {MemoryOperationLedger}=await tsImport(workerData.memoryUrl,workerData.baseUrl);
    const {SqliteTransactions}=await tsImport(workerData.txUrl,workerData.baseUrl);
    const db=new DatabaseSync(workerData.filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    const ledger=new MemoryOperationLedger(db,new SqliteTransactions(db),{...workerData.options,now:()=>new Date(workerData.instant)});
    const claim=ledger.claim(workerData.actor,workerData.request,()=>workerData.verdict);
    db.close();parentPort.postMessage(claim?.claimToken??null);
  })().catch(error=>{parentPort.postMessage({error:String(error)});process.exitCode=1})`;
  const workers = Array.from({ length: 4 }, () => new Worker(source, { eval: true, workerData: {
    filename, options, instant, actor: dispatcher, request: request(), verdict: allowed(ledger.get('operation-a')!, dispatcher),
    memoryUrl: new URL('../src/control/memory/index.ts', import.meta.url).href, txUrl: new URL('../src/adapters/control-store/transaction.ts', import.meta.url).href, baseUrl: import.meta.url,
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const claims = await Promise.all(workers.map(worker => new Promise<string | null>((resolve, reject) => { worker.once('error', reject); worker.once('message', result => result?.error ? reject(new Error(result.error)) : resolve(result)); })));
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(effects.attempts('memory-effect:operation-a').length, 1);
});

test('restart classifies uncertainty and cannot replay the original operation or release its resource', async t => {
  const first = await fixture(t); first.ledger.approve(core, intent(), approved); const claim = first.ledger.claim(dispatcher, request(), allowed)!;
  first.close(); const second = first.open();
  assert.equal(second.ledger.recover(dispatcher, { installationGeneration: 'install-a', hostEpoch: 'host-new' })[0].status, 'unknown');
  assert.equal(second.ledger.claim(dispatcher, request(), allowed), undefined);
  const effect = second.effects.get(claim.effectId)!;
  assert.throws(() => second.effects.retry(effect.effectId, effect.version, 'try again', () => ({ allowed: true, ...auth, hostEpoch: 'host-new', fencingToken: 2 })), code('REPLAY_FORBIDDEN'));
  second.ledger.approve(core, intent('another', { targetRef: 'target-operation-a' }), approved);
  assert.throws(() => second.ledger.claim(dispatcher, request('another'), allowed), code('RESOURCE_BUSY'));
  assert.equal(second.effects.attempts(claim.effectId).length, 1);
});

test('unverified MCP acceptance, wrong provenance and attempt-local failures never make memory applied', async t => {
  const { ledger, effects } = await fixture(t); ledger.approve(core, intent(), approved); const claim = ledger.claim(dispatcher, request(), allowed)!;
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), () => ({ verified: false, reasonCode: 'MCP_ACCEPTED_ONLY' })), code('UNVERIFIED_RECEIPT'));
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), (op, value) => ({ ...verified(op, value), sourceRefs: [{ sourceId: 'source-a', revision: 2 }] }) as any), code('UNVERIFIED_SOURCES'));
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), (op, value) => ({ ...verified(op, value), operationSettled: false }) as any), code('RESULT_UNKNOWN'));
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), (op, value) => ({ ...verified(op, value), rawBody: 'not control metadata' }) as any), code('INVALID_SCHEMA'));
  assert.equal(ledger.get('operation-a')!.status, 'dispatching'); assert.equal(effects.receipts(claim.effectId).length, 0);
});

test('verified completion atomically records backend and Effect receipts and is idempotent', async t => {
  const { ledger, effects } = await fixture(t); ledger.approve(core, intent(), approved); const claim = ledger.claim(dispatcher, request(), allowed)!;
  const applied = ledger.complete(verifier, 'operation-a', 2, claim, result(), verified);
  assert.equal(applied.status, 'applied'); assert.equal(applied.nativeId, 'native-operation-a'); assert.equal(applied.version, 4);
  assert.deepEqual(ledger.complete(verifier, 'operation-a', 2, claim, result(), verified), applied);
  assert.equal(ledger.receipts('operation-a').length, 1); assert.equal(effects.receipts(claim.effectId).length, 1);
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result('operation-a', { nativeId: 'different' }), verified), code('IDEMPOTENCY_CONFLICT'));
});

test('a verified backend write after authorization withdrawal is retained without local publication', async t => {
  const { ledger, effects } = await fixture(t); ledger.approve(core, intent(), approved); const claim = ledger.claim(dispatcher, request(), allowed)!;
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), (op, value) => ({ ...verified(op, value), publicationAllowed: 'false' }) as any), code('UNVERIFIED_RECEIPT'));
  const operation = ledger.complete(verifier, 'operation-a', 2, claim, result(), (op, value) => ({ ...verified(op, value), publicationAllowed: false }) as any);
  assert.equal(operation.status, 'unknown'); assert.equal(operation.nativeId, undefined); assert.equal(operation.reasonCode, 'PUBLICATION_NOT_AUTHORIZED');
  assert.equal(operation.backendOutcome, 'applied'); assert.equal(effects.get(claim.effectId)!.status, 'succeeded');
  assert.equal(ledger.receipts('operation-a')[0].published, false);
  assert.equal(ledger.complete(verifier, 'operation-a', 2, claim, result(), verified).nativeId, undefined);
});

test('local receipt write failure rolls back the Effect conclusion and leaves dispatch uncertainty intact', async t => {
  const { ledger, db, effects } = await fixture(t); ledger.approve(core, intent(), approved); const claim = ledger.claim(dispatcher, request(), allowed)!;
  db.exec("CREATE TRIGGER fail_memory_receipt BEFORE INSERT ON shiyu_memory_receipts BEGIN SELECT RAISE(ABORT,'synthetic memory receipt failure'); END");
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), verified), /synthetic memory receipt failure/);
  assert.equal(ledger.get('operation-a')!.status, 'dispatching'); assert.equal(ledger.get('operation-a')!.version, 2); assert.equal(effects.receipts(claim.effectId).length, 0);
  db.exec('DROP TRIGGER fail_memory_receipt');
  assert.equal(ledger.complete(verifier, 'operation-a', 2, claim, result(), verified).status, 'applied');
});

test('late receipts need the original claim plus independent reconciliation, including strict boolean evidence', async t => {
  const { ledger, advance } = await fixture(t); ledger.approve(core, intent(), approved); const claim = ledger.claim(dispatcher, request(), allowed)!; advance(1001);
  assert.throws(() => ledger.complete(verifier, 'operation-a', 2, claim, result(), verified), code('RESULT_UNKNOWN'));
  ledger.recover(dispatcher, { installationGeneration: 'install-a', hostEpoch: 'host-a' });
  assert.throws(() => ledger.reconcile(verifier, 'operation-a', 3, { ...claim, claimToken: 'wrong-claim' }, result(), verified), code('STALE_FENCE'));
  assert.throws(() => ledger.reconcile(verifier, 'operation-a', 3, claim, result(), (op, value) => ({ ...verified(op, value), reconciled: 'false' }) as any), code('RESULT_UNKNOWN'));
  assert.throws(() => ledger.reconcile(verifier, 'operation-a', 3, claim, result(), (op, value) => ({ ...verified(op, value), installationGeneration: 'old-install' }) as any), code('STALE_FENCE'));
  assert.equal(ledger.reconcile(verifier, 'operation-a', 3, claim, result(), verified).status, 'applied');
});

test('pending rejection is definite but an in-flight operation cannot be declared rejected locally', async t => {
  const { ledger } = await fixture(t); ledger.approve(core, intent(), approved);
  assert.equal(ledger.reject(core, 'operation-a', 1, 'WITHDRAWN').status, 'rejected');
  ledger.approve(core, intent('inflight'), approved); const claim = ledger.claim(dispatcher, request('inflight'), allowed)!;
  assert.throws(() => ledger.reject(core, 'inflight', 2, 'WITHDRAWN'), code('INVALID_STATE'));
  const rejected = result('inflight', { outcome: 'rejected', nativeId: null });
  assert.equal(ledger.complete(verifier, 'inflight', 2, claim, rejected, verified).status, 'rejected');
});

test('tombstones reject stale/new proposals, cancel pending Effects, persist across restart and never clear on duplicates', async t => {
  const first = await fixture(t); first.ledger.approve(core, intent(), approved); const deleted = first.ledger.tombstone(owner, deletion());
  assert.equal(deleted.watermark, 1); assert.equal(first.ledger.get('operation-a')!.status, 'rejected'); assert.equal(first.ledger.get('operation-a')!.blocked, true);
  assert.deepEqual(first.ledger.tombstone(owner, deletion()), deleted);
  assert.throws(() => first.ledger.tombstone(owner, deletion({ refs: ['different'] })), code('IDEMPOTENCY_CONFLICT'));
  first.close(); const next = first.open();
  assert.equal(next.ledger.watermark(), 1); assert.equal(next.ledger.approve(core, intent(), approved).blocked, true);
  assert.throws(() => next.ledger.approve(core, intent('stale', { sourceRefs: [{ sourceId: 'unrelated', revision: 1 }] }), approved), code('STALE_WATERMARK'));
  assert.throws(() => next.ledger.approve(core, intent('deleted', { expectedTombstoneWatermark: 1 }), approved), code('TOMBSTONED'));
  assert.throws(() => next.ledger.approve(core, intent('reused-target', { expectedTombstoneWatermark: 1, sourceRefs: [{ sourceId: 'unrelated', revision: 1 }], targetRef: 'target-operation-a' }), approved), code('TOMBSTONED'));
  assert.equal(next.ledger.approve(core, intent('fresh', { expectedTombstoneWatermark: 1, sourceRefs: [{ sourceId: 'unrelated', revision: 1 }] }), approved).status, 'approved');
});

test('deletion before backend completion blocks late success without denying the external effect fact', async t => {
  const { ledger, effects } = await fixture(t); ledger.approve(core, intent(), approved); const claim = ledger.claim(dispatcher, request(), allowed)!;
  ledger.tombstone(owner, deletion()); const blocked = ledger.get('operation-a')!;
  assert.equal(blocked.status, 'unknown'); assert.equal(blocked.blocked, true);
  assert.throws(() => ledger.assertDispatch(dispatcher, 'operation-a', claim, allowed), code('STALE_FENCE'));
  const settled = ledger.reconcile(verifier, 'operation-a', blocked.version, claim, result(), verified);
  assert.equal(settled.backendOutcome, 'applied'); assert.equal(effects.get(claim.effectId)!.status, 'succeeded');
  assert.equal(settled.status, 'unknown'); assert.equal(settled.blocked, true); assert.equal(settled.nativeId, undefined);
  assert.equal(ledger.receipts('operation-a')[0].published, false);
  assert.equal(ledger.claim(dispatcher, request(), allowed), undefined);
});

test('deleting an applied memory hides its reference permanently and traverses declared dependent targets', async t => {
  const { ledger } = await fixture(t); ledger.approve(core, intent(), approved); const claim = ledger.claim(dispatcher, request(), allowed)!;
  ledger.complete(verifier, 'operation-a', 2, claim, result(), verified);
  ledger.approve(core, intent('derived', { sourceRefs: [{ sourceId: 'source-b', revision: 1 }], dependencyRefs: ['target-operation-a'] }), approved);
  ledger.approve(core, intent('third', { sourceRefs: [{ sourceId: 'source-c', revision: 1 }], dependencyRefs: ['target-derived'] }), approved);
  ledger.approve(core, intent('separate', { sourceRefs: [{ sourceId: 'source-d', revision: 1 }] }), approved);
  ledger.tombstone(owner, deletion());
  assert.equal(ledger.get('operation-a')!.status, 'applied'); assert.equal(ledger.get('operation-a')!.nativeId, undefined);
  assert.equal(ledger.get('derived')!.status, 'rejected'); assert.equal(ledger.get('third')!.blocked, true); assert.equal(ledger.get('separate')!.blocked, false);
  assert.equal(ledger.complete(verifier, 'operation-a', 2, claim, result(), verified).nativeId, undefined);
});

test('a failing deletion rolls back watermark, barriers and Effect cancellation as one transaction', async t => {
  const { ledger, db, effects } = await fixture(t); const operation = ledger.approve(core, intent(), approved);
  db.exec("CREATE TRIGGER fail_memory_barrier BEFORE UPDATE ON shiyu_memory_operations BEGIN SELECT RAISE(ABORT,'synthetic deletion failure'); END");
  assert.throws(() => ledger.tombstone(owner, deletion()), /synthetic deletion failure/);
  assert.equal(ledger.watermark(), 0); assert.equal(ledger.get('operation-a')!.blocked, false); assert.equal(effects.get(operation.effectId)!.status, 'pending');
  assert.equal(db.prepare('SELECT count(*) AS n FROM shiyu_memory_tombstones').get()!.n, 0);
});

test('read projections do not mutate state; changed trusted backend/role configuration fails closed', async t => {
  const { ledger, db, tx } = await fixture(t); ledger.approve(core, intent(), approved);
  const before = db.prepare('SELECT total_changes() AS n').get()!.n;
  ledger.get('operation-a'); ledger.watermark(); ledger.receipts('operation-a');
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.throws(() => new MemoryOperationLedger(db, tx, { ...options, verifierIds: ['model-selected-verifier'] }), code('INCOMPATIBLE_POLICY'));
});
