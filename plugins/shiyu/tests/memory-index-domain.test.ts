import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { MemoryDomain, type LocalMemoryEntry } from '../src/adapters/control-store/memory-domain.js';
import { MemoryIndexDomain, type MemoryIndexEntry } from '../src/adapters/control-store/memory-index-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { createControlAuthority } from '../src/adapters/control-store/authority.js';
import { memoryBodyDigest, memoryCommandDigest } from '../src/contracts/memory.js';
import { memoryIndexCommandDigest, OMBRE_HARRIER_PROFILE_FINGERPRINT, type MemoryIndexObservation, type SemanticBackendStatus } from '../src/contracts/semantic-memory.js';
import type { ConversationRecord } from '../src/control/conversations/index.js';
import type { TrustedPolicyActor } from '../src/control/policy/mandates.js';

const initial = '2026-11-02T12:00:00.000Z';
const identity = { hostEpoch: 'index-host-a', installationGeneration: 'index-installation-a' };
const owner: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const body = 'Synthetic explicitly saved memory for indexing, without a real embedding call.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
const backendStatus: SemanticBackendStatus = { schemaVersion: 2, backendId: 'index-backend', deploymentId: 'index-deployment', scope: 'local-owner', semanticApi: true,
  profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT, indexBaselineId: `index_${'a'.repeat(32)}`, indexWatermark: 0, recordedIndexedCount: 0, embeddingConfigured: true,
  limits: { maxEligibleRefs: 128, maxScannedRows: 2048, maxResults: 10, maxEmbeddingCallsPerIndex: 2, maxDeadlineMs: 60000 } };
function bodyObservation(entry: LocalMemoryEntry) {
  return { command: entry.command, commandDigest: memoryCommandDigest(entry.command), deploymentId: backendStatus.deploymentId,
    nativeId: `shiyu_${sha(entry.operation.operationId).slice(0, 32)}`, receiptId: `receipt_${sha(entry.operation.operationId)}`, componentVersion: `sha256:${sha(`file:${entry.command.bodyDigest}`)}`,
    bodyDigest: entry.command.bodyDigest, bodyBytes: entry.command.bodyBytes, sourceRefs: entry.command.sourceRefs, observedAt: initial };
}
function observation(entry: MemoryIndexEntry, calls = 2): MemoryIndexObservation {
  const command = entry.command;
  return { schemaVersion: 2, backendId: command.backendId, deploymentId: command.deploymentId, scope: command.scope, indexOperationId: command.indexOperationId, state: 'applied',
    command, commandDigest: memoryIndexCommandDigest(command), reason: null, currentIndexBaselineId: command.indexBaselineId, currentIndexWatermark: command.expectedIndexWatermark + 1, embeddingCalls: calls, usageComplete: true,
    receipt: { schemaVersion: 2, backendId: command.backendId, deploymentId: command.deploymentId, scope: command.scope,
      receiptId: `index_receipt_${sha(command.indexOperationId)}`, indexOperationId: command.indexOperationId, memoryOperationId: command.memoryOperationId, bodyReceiptId: command.bodyReceiptId,
      commandDigest: memoryIndexCommandDigest(command), nativeId: command.nativeId, componentVersion: command.componentVersion, bodyDigest: command.bodyDigest,
      profileFingerprint: command.profileFingerprint, indexBaselineId: command.indexBaselineId, indexWatermark: command.expectedIndexWatermark + 1,
      content: { digest: command.bodyDigest, vectorHash: sha('content-vector'), dimensions: 1024 }, meaning: { state: 'indexed', digest: sha('meaning'), vectorHash: sha('meaning-vector'), dimensions: 1024 }, embeddingCalls: calls, observedAt: initial } };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-index-domain-')), filename = join(directory, 'control.sqlite');
  const connections = new Set<DatabaseSync>(); let clock = Date.parse(initial);
  const conversation: ConversationRecord = { conversationId: 'index-conversation', key: { connectionId: 'local-synthetic', platformConversationId: 'index-local', kind: 'direct', scope: 'local-owner' },
    revision: 1, audienceVersion: 1, conversationGeneration: 1, archived: false, createdAt: initial, updatedAt: initial };
  const open = (runtimeIdentity = identity) => {
    const db = new DatabaseSync(filename); connections.add(db);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx), now = () => new Date(clock);
    const memory = new MemoryDomain(db, tx, { runtimeIdentity, backendId: backendStatus.backendId, deploymentId: backendStatus.deploymentId, now, getConversation: () => conversation });
    const domain = new MemoryIndexDomain(db, tx, { runtimeIdentity, backendId: backendStatus.backendId, deploymentId: backendStatus.deploymentId, memory, now });
    const authority = createControlAuthority(db, tx, { now });
    const saveBody = (requestId = 'save-for-index') => {
      const digest = memoryBodyDigest(body), prepared = memory.prepareLocal({ requestId, conversationId: conversation.conversationId, bodyDigest: digest.bodyDigest, bytes: digest.bodyBytes });
      if (prepared.duplicate) return memory.get(prepared.operation.operationId);
      const plan = memory.claim({ operationId: prepared.operation.operationId })!;
      return memory.recordVerifiedReceipt({ operationId: prepared.operation.operationId, claim: plan.claim, observation: bodyObservation(prepared), reconciliation: false });
    };
    const prepare = (entry: LocalMemoryEntry, requestId = 'index-one') => domain.prepare({ requestId, operationId: entry.operation.operationId, backendStatus, deadlineAtMs: clock + 60000 });
    return { db, tx, watermark, memory, domain, authority, saveBody, prepare, close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, conversation, nowMs: () => clock, advance(ms: number) { clock += ms; } };
}

test('index preparation commits one exact command, own effect budget and distinct unknown embedding usage without storing a body', t => {
  const f = fixture(t), source = f.saveBody(), before = f.watermark.read(), result = f.prepare(source), entry = result.entry;
  assert.equal(result.duplicate, false); assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
  assert.equal(entry.command.bodyReceiptId, f.memory.readLocal({ operationId: source.operation.operationId }).bodyReceiptId);
  assert.equal(entry.command.profileFingerprint, OMBRE_HARRIER_PROFILE_FINGERPRINT); assert.equal(entry.command.maxEmbeddingCalls, 2);
  assert.equal(entry.effect.action, 'memory.index'); assert.equal(entry.effect.replayClass, 'reconcilable'); assert.equal(entry.effect.maxAttempts, 1);
  assert.deepEqual(entry.reservation.amount, { tokens: 0, calls: 0, effects: 1 }); assert.deepEqual(entry.embeddingUsage, { maxEmbeddingCalls: 2, calls: null, complete: false });
  assert.equal(entry.publishable, false); assert.deepEqual(f.authority.get(owner, entry.reservation.mandateId).allowedActions, ['memory.index']);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM shiyu_memory_index_operations').all()).includes(body), false);
});

test('duplicate request preserves the first command and never makes another effect even after status/deadline change or restart', t => {
  const f = fixture(t), source = f.saveBody(), first = f.prepare(source).entry, before = f.watermark.read();
  const duplicate = f.domain.prepare({ requestId: 'index-one', operationId: source.operation.operationId, backendStatus: { ...backendStatus, indexWatermark: 20 }, deadlineAtMs: f.nowMs() + 50000 });
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.entry.command, first.command); assert.deepEqual(f.watermark.read(), before);
  assert.throws(() => f.domain.prepare({ requestId: 'index-one', operationId: 'another-memory', backendStatus, deadlineAtMs: f.nowMs() + 60000 }), code('IDEMPOTENCY_CONFLICT'));
  f.close(); const next = f.open(); assert.equal(next.prepare(source).duplicate, true); assert.deepEqual(next.watermark.read(), before);
});

test('only a currently readable verified body and bounded trusted backend status can prepare indexing', t => {
  const f = fixture(t), source = f.saveBody(), before = f.watermark.read();
  for (const patch of [{ actor: owner }, { deadlineAtMs: f.nowMs() }, { deadlineAtMs: f.nowMs() + 60001 }, { backendStatus: { ...backendStatus, deploymentId: 'wrong' } },
    { backendStatus: { ...backendStatus, profileFingerprint: sha('different-profile') } }]) {
    assert.throws(() => f.domain.prepare({ requestId: 'bad-index', operationId: source.operation.operationId, backendStatus, deadlineAtMs: f.nowMs() + 60000, ...patch } as never));
  }
  assert.deepEqual(f.watermark.read(), before);
  f.memory.withdrawLocal({ requestId: 'withdraw-before-index', operationId: source.operation.operationId });
  assert.throws(() => f.prepare(source), code('MEMORY_READ_FORBIDDEN'));
});

test('failed index admission rolls back grant, reservation, effect and command in one real write transaction', t => {
  const f = fixture(t), source = f.saveBody(), before = f.watermark.read();
  const counts = () => ['shiyu_mandates', 'shiyu_budget_reservations', 'shiyu_effects', 'shiyu_memory_index_operations'].map(name => f.db.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n);
  const originalCounts = counts(), original = f.db.prepare;
  f.db.prepare = function(sql: string) { if (/INSERT INTO shiyu_memory_index_operations/.test(sql)) throw new Error('synthetic index admission failure'); return original.call(this, sql); };
  try { assert.throws(() => f.prepare(source), /synthetic index admission failure/); } finally { f.db.prepare = original; }
  assert.deepEqual(counts(), originalCounts); assert.deepEqual(f.watermark.read(), before);
});

test('claim commits once and final dispatch checks the exact fence, lease and live mandate', t => {
  const f = fixture(t), entry = f.prepare(f.saveBody()).entry;
  assert.throws(() => f.tx.atomic(() => f.domain.claim({ indexOperationId: entry.indexOperationId })), code('NESTED_DISPATCH'));
  const plan = f.domain.claim({ indexOperationId: entry.indexOperationId, leaseMs: 1000 })!;
  assert.equal(f.tx.depth, 0); assert.equal(plan.entry.effect.status, 'dispatching'); assert.equal(f.domain.claim({ indexOperationId: entry.indexOperationId }), undefined);
  assert.equal(f.domain.assertDispatch({ indexOperationId: entry.indexOperationId, claim: plan.claim }).command.indexOperationId, entry.indexOperationId);
  assert.throws(() => f.domain.assertDispatch({ indexOperationId: entry.indexOperationId, claim: { ...plan.claim, fencingToken: plan.claim.fencingToken + 1 } }), code('STALE_FENCE'));
  f.advance(1000); assert.throws(() => f.domain.assertDispatch({ indexOperationId: entry.indexOperationId, claim: plan.claim }), code('STALE_FENCE'));
});

test('withdrawal, audience change and index mandate revoke deny dispatch independently', t => {
  for (const mode of ['withdraw', 'audience', 'revoke'] as const) {
    const f = fixture(t), source = f.saveBody(), entry = f.prepare(source).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!;
    if (mode === 'withdraw') f.memory.withdrawLocal({ requestId: 'withdraw-index-source', operationId: source.operation.operationId });
    if (mode === 'audience') f.conversation.audienceVersion++;
    if (mode === 'revoke') f.authority.revoke(owner, { mandateId: entry.reservation.mandateId, expectedVersion: entry.reservation.mandateVersion });
    assert.throws(() => f.domain.assertDispatch({ indexOperationId: entry.indexOperationId, claim: plan.claim }));
  }
});

test('independent full index proof atomically settles one effect and its separate observed embedding calls', t => {
  const f = fixture(t), entry = f.prepare(f.saveBody()).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!, observed = observation(entry), before = f.watermark.read();
  const result = f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: observed });
  assert.equal(result.effect.status, 'succeeded'); assert.equal(result.publishable, true); assert.deepEqual(result.embeddingUsage, { maxEmbeddingCalls: 2, calls: 2, complete: true });
  assert.deepEqual(result.reservation.observed, { tokens: 0, calls: 0, effects: 1 }); assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
  const committed = f.watermark.read();
  assert.deepEqual(f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: { ...observed, currentIndexWatermark: 99 } }), result);
  assert.deepEqual(f.watermark.read(), committed);
});

test('receipt validation rejects mismatched identity, command, vector proof shape, usage and claim without partial settlement', t => {
  const f = fixture(t), entry = f.prepare(f.saveBody()).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!, good = observation(entry), before = f.watermark.read();
  const invalid: MemoryIndexObservation[] = [
    { ...good, deploymentId: 'foreign' }, { ...good, commandDigest: sha('wrong') }, { ...good, command: { ...good.command!, nativeId: `shiyu_${'b'.repeat(32)}` } },
    { ...good, receipt: { ...good.receipt!, bodyReceiptId: `receipt_${'b'.repeat(64)}` } },
    { ...good, receipt: { ...good.receipt!, content: { ...good.receipt!.content, dimensions: 1 } } } as never,
    { ...good, receipt: { ...good.receipt!, indexWatermark: entry.command.expectedIndexWatermark } },
    { ...good, embeddingCalls: 3 }, { ...good, usageComplete: false },
  ];
  for (const observation of invalid) assert.throws(() => f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation }));
  assert.throws(() => f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: { ...plan.claim, claimToken: 'forged' }, observation: good }));
  assert.deepEqual(f.watermark.read(), before); assert.equal(f.domain.get(entry.indexOperationId).reservation.state, 'reserved');
  f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: good });
  assert.throws(() => f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: { ...good, receipt: { ...good.receipt!, meaning: { ...good.receipt!.meaning, vectorHash: sha('different') } } } as MemoryIndexObservation }), code('IDEMPOTENCY_CONFLICT'));
});

test('receipt storage failure rolls back effect success and budget settlement together', t => {
  const f = fixture(t), entry = f.prepare(f.saveBody()).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!, before = f.watermark.read(), original = f.db.prepare;
  f.db.prepare = function(sql: string) { if (/INSERT INTO shiyu_memory_index_receipts/.test(sql)) throw new Error('synthetic index proof failure'); return original.call(this, sql); };
  try { assert.throws(() => f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: observation(entry) }), /synthetic index proof failure/); }
  finally { f.db.prepare = original; }
  const result = f.domain.get(entry.indexOperationId); assert.equal(result.effect.status, 'dispatching'); assert.equal(result.reservation.state, 'reserved'); assert.equal(result.observation, undefined); assert.deepEqual(f.watermark.read(), before);
});

test('unknown index retains its effect budget and partial embedding observation without automatic replay', t => {
  const f = fixture(t), entry = f.prepare(f.saveBody()).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!;
  const unknown: MemoryIndexObservation = { ...observation(entry), state: 'unknown', receipt: null, reason: 'EMBEDDING_UNCERTAIN', embeddingCalls: 1, usageComplete: false };
  const result = f.domain.markUnknown({ indexOperationId: entry.indexOperationId, claim: plan.claim, reasonCode: 'EMBEDDING_UNCERTAIN', observation: unknown });
  assert.equal(result.effect.status, 'unknown'); assert.equal(result.reservation.state, 'unknown'); assert.equal(result.reservation.observed.effects, undefined);
  assert.deepEqual(result.embeddingUsage, { maxEmbeddingCalls: 2, calls: 1, complete: false }); assert.equal(f.domain.claim({ indexOperationId: entry.indexOperationId }), undefined);
  assert.throws(() => f.domain.markUnknown({ indexOperationId: entry.indexOperationId, claim: plan.claim, reasonCode: 'REGRESSION', observation: { ...unknown, embeddingCalls: 0 } }), code('INDEX_USAGE_REGRESSION'));
  assert.throws(() => f.domain.markUnknown({ indexOperationId: entry.indexOperationId, claim: plan.claim, reasonCode: 'UNKNOWN_USAGE', observation: { ...unknown, embeddingCalls: null, usageComplete: true } }), code('INVALID_SEMANTIC_RESPONSE'));
});

test('late withdrawal preserves verified backend indexing and usage as fact without publishing the source', t => {
  const f = fixture(t), source = f.saveBody(), entry = f.prepare(source).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!;
  f.memory.withdrawLocal({ requestId: 'withdraw-after-index-start', operationId: source.operation.operationId });
  const result = f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: observation(entry) });
  assert.equal(result.effect.status, 'succeeded'); assert.equal(result.publishable, false); assert.equal(result.reservation.observed.effects, 1); assert.equal(result.embeddingUsage.calls, 2);
});

test('host recovery holds the original attempt and independent late status can reconcile without replay', t => {
  const f = fixture(t), entry = f.prepare(f.saveBody()).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!;
  f.close(); const next = f.open({ ...identity, hostEpoch: 'index-host-b' });
  assert.equal(next.domain.get(entry.indexOperationId).effect.status, 'unknown'); assert.equal(next.domain.get(entry.indexOperationId).reservation.state, 'unknown');
  assert.equal(next.domain.claim({ indexOperationId: entry.indexOperationId }), undefined);
  assert.throws(() => next.domain.assertDispatch({ indexOperationId: entry.indexOperationId, claim: plan.claim }));
  const reconciled = next.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: observation(entry) });
  assert.equal(reconciled.effect.status, 'succeeded'); assert.equal(reconciled.publishable, true); assert.equal(reconciled.effect.attempts, 1);
});

test('cancellation releases only a never-claimed budget; a claimed operation stays uncertain and late proof cannot publish', t => {
  const f = fixture(t), source = f.saveBody(), pending = f.prepare(source).entry;
  const cancelled = f.domain.cancel({ indexOperationId: pending.indexOperationId, reasonCode: 'OWNER_CANCELLED' });
  assert.equal(cancelled.effect.status, 'cancelled'); assert.deepEqual(cancelled.reservation.observed, { tokens: 0, calls: 0, effects: 0 }); assert.equal(cancelled.embeddingUsage.calls, 0);
  assert.equal(f.domain.claim({ indexOperationId: pending.indexOperationId }), undefined);
  const second = f.prepare(source, 'index-two').entry, plan = f.domain.claim({ indexOperationId: second.indexOperationId })!;
  const unknown = f.domain.cancel({ indexOperationId: second.indexOperationId, reasonCode: 'OWNER_CANCELLED' });
  assert.equal(unknown.effect.status, 'unknown'); assert.equal(unknown.reservation.state, 'unknown'); assert.equal(unknown.embeddingUsage.calls, null);
  const late = f.domain.recordVerified({ indexOperationId: second.indexOperationId, claim: plan.claim, observation: observation(second) });
  assert.equal(late.effect.status, 'succeeded'); assert.equal(late.publishable, false); assert.equal(late.reservation.observed.effects, 1);
});

test('unrelated authorization and deletion changes do not permanently invalidate the exact current source', t => {
  const f = fixture(t), source = f.saveBody(), entry = f.prepare(source).entry, unrelated = f.saveBody('another-source');
  f.memory.withdrawLocal({ requestId: 'withdraw-other-source', operationId: unrelated.operation.operationId });
  const plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!;
  const result = f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: observation(entry) });
  assert.equal(result.publishable, true);
});

test('a missing persisted full index proof fails closed on read and reopen instead of recreating verified history', t => {
  const f = fixture(t), entry = f.prepare(f.saveBody()).entry, plan = f.domain.claim({ indexOperationId: entry.indexOperationId })!;
  f.domain.recordVerified({ indexOperationId: entry.indexOperationId, claim: plan.claim, observation: observation(entry) });
  f.tx.atomic(() => f.db.prepare('DELETE FROM shiyu_memory_index_receipts').run());
  assert.throws(() => f.domain.get(entry.indexOperationId), code('CORRUPT_INDEX_DOMAIN'));
  f.close(); assert.throws(() => f.open(), code('CORRUPT_INDEX_DOMAIN'));
});

test('a missing index metadata row is not reseeded and a changed stored command cannot inherit another effect proof', t => {
  const first = fixture(t), entry = first.prepare(first.saveBody()).entry;
  first.tx.atomic(() => {
    const row = first.db.prepare('SELECT record_json FROM shiyu_memory_index_operations WHERE index_operation_id=?').get(entry.indexOperationId)!;
    const record = JSON.parse(String(row.record_json)); record.command.expectedIndexWatermark++;
    first.db.prepare('UPDATE shiyu_memory_index_operations SET record_json=? WHERE index_operation_id=?').run(JSON.stringify(record), entry.indexOperationId);
  });
  assert.throws(() => first.domain.get(entry.indexOperationId), code('CORRUPT_INDEX_DOMAIN'));
  const second = fixture(t); second.tx.atomic(() => second.db.prepare('DELETE FROM shiyu_memory_index_meta').run()); second.close();
  assert.throws(() => second.open(), code('CORRUPT_INDEX_DOMAIN'));
});
