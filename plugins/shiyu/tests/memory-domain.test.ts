import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { MemoryDomain, MAX_MEMORY_VIEW_CANDIDATES, type MemoryBackendObservation, type LocalMemoryEntry, type MemoryDomainOptions, type MemoryContextInvalidation } from '../src/adapters/control-store/memory-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { createControlAuthority, MEMORY_DISPATCHER } from '../src/adapters/control-store/authority.js';
import { ConversationStore } from '../src/control/conversations/index.js';
import type { TrustedPolicyActor } from '../src/control/policy/mandates.js';
import { memoryBodyDigest, memoryCommandDigest, canonicalMemoryCommand } from '../src/contracts/memory.js';
import { EffectLedger } from '../src/control/effects/index.js';
import { TaskDomain } from '../src/adapters/control-store/task-domain.js';

const start = '2026-11-02T05:00:00.000Z';
const OWNER: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const body = '合成记忆：这里是明确要求保存的原始片段 🪶';
const identity = { hostEpoch: 'memory-host-a', installationGeneration: 'memory-install-a' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
function observation(entry: LocalMemoryEntry, patch: Partial<MemoryBackendObservation> = {}): MemoryBackendObservation {
  return { command: structuredClone(entry.command), commandDigest: memoryCommandDigest(entry.command), deploymentId: 'deployment-a',
    nativeId: `shiyu_${sha(entry.operation.operationId).slice(0, 32)}`, receiptId: `receipt_${sha(`receipt:${entry.operation.operationId}`)}`,
    componentVersion: `sha256:${sha(`native-markdown:${entry.command.bodyDigest}`)}`, bodyDigest: entry.command.bodyDigest, bodyBytes: entry.command.bodyBytes,
    sourceRefs: structuredClone(entry.command.sourceRefs), observedAt: start, ...patch };
}
async function fixture(t: TestContext, initialOptions: Partial<MemoryDomainOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-memory-domain-')); const filename = join(directory, 'control.sqlite');
  let clock = Date.parse(start); const connections = new Set<DatabaseSync>();
  const open = (patch: Partial<MemoryDomainOptions> = {}) => {
    const db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    const tx = new SqliteTransactions(db), now = () => new Date(clock);
    const conversations = new ConversationStore(db, tx, { ownerIds: ['local-owner'], componentPermissions: {}, authorizeReference: () => false, now });
    const conversation = conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: 'memory-test', kind: 'direct', scope: 'local-owner' });
    const domain = new MemoryDomain(db, tx, { runtimeIdentity: identity, backendId: 'ombre-local', deploymentId: 'deployment-a', getConversation: id => conversations.getConversation(OWNER, id), now, ...patch });
    const authority = createControlAuthority(db, tx, { now }); const effects = new EffectLedger(db, tx, { now }); connections.add(db);
    const prepare = (requestId = 'remember-a', text = body) => { const value = memoryBodyDigest(text); return domain.prepareLocal({ requestId, conversationId: conversation.conversationId, bodyDigest: value.bodyDigest, bytes: value.bodyBytes }); };
    return { db, tx, conversations, conversationId: conversation.conversationId, domain, authority, effects, prepare, close: () => { if (connections.delete(db)) db.close(); } };
  };
  t.after(async () => { for (const db of connections) db.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...open(initialOptions), open, advance: (ms: number) => { clock += ms; } };
}
function apply(domain: MemoryDomain, entry: LocalMemoryEntry): LocalMemoryEntry {
  const operationId = entry.operation.operationId, plan = domain.claim({ operationId })!;
  return domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: false });
}

test('explicit owner preparation records only bounded source metadata and one atomic grant/reservation/Effect', async t => {
  const { domain, prepare, db, effects, authority, tx } = await fixture(t);
  assert.equal(domain.list().length, 0); const entry = prepare();
  assert.equal(entry.duplicate, false); assert.equal(entry.operation.status, 'approved'); assert.equal(entry.canPublish, false);
  assert.equal(entry.source.consent.kind, 'explicit-owner-save'); assert.equal(entry.source.consent.state, 'active');
  assert.equal(entry.reservation.principalId, MEMORY_DISPATCHER.principalId); assert.deepEqual(entry.reservation.amount, { tokens: 0, calls: 0, effects: 1 });
  assert.equal(entry.operation.commandDigest, memoryCommandDigest(entry.command));
  assert.equal(entry.operation.kind, 'append'); assert.equal(entry.operation.scope, 'local-owner'); assert.equal(entry.reference, undefined);
  assert.equal(createControlAuthority(db, tx), authority); assert.equal(effects.list().length, 1);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const table of tables) {
    const content = JSON.stringify(db.prepare(`SELECT * FROM ${table.name}`).all());
    assert.equal(content.includes(body), false, `${table.name} must not contain a second authoritative body`);
    assert.equal(content.includes('明确要求保存的原始片段'), false);
  }
});

test('same request returns duplicate across restart without another reservation; changed params conflict', async t => {
  const first = await fixture(t); const original = first.prepare(); assert.equal(first.prepare().duplicate, true);
  const counts = ['shiyu_local_memory_sources', 'shiyu_local_memory_operations', 'shiyu_mandates', 'shiyu_budget_reservations', 'shiyu_effects'].map(table => Number(first.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
  assert.deepEqual(counts, [1, 1, 1, 1, 1]);
  first.close(); const second = first.open(); const duplicate = second.prepare();
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.operation.operationId, original.operation.operationId);
  assert.throws(() => second.prepare('remember-a', '另一段显式内容'), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => second.domain.prepareLocal({ requestId: 'remember-a', conversationId: second.conversationId, bodyDigest: original.command.bodyDigest, bytes: original.command.bodyBytes, sourceId: original.source.sourceId }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(second.effects.list().length, 1);
});

test('caller cannot supply actor/scope/body and an absent, foreign or archived conversation grants no save consent', async t => {
  const { domain, db, conversations, conversationId } = await fixture(t); const data = memoryBodyDigest(body);
  const input = { requestId: 'request-a', conversationId, bodyDigest: data.bodyDigest, bytes: data.bodyBytes };
  for (const patch of [{ actor: OWNER }, { scope: 'other' }, { body }, { consent: true }]) assert.throws(() => domain.prepareLocal({ ...input, ...patch } as any), code('INVALID_MEMORY_INPUT'));
  assert.throws(() => domain.prepareLocal({ ...input, conversationId: 'absent' }), code('NOT_FOUND'));
  const foreignOwner = { ...OWNER, scopes: ['other-scope'] };
  const foreign = conversations.ensureConversation(foreignOwner, { connectionId: 'local-synthetic', platformConversationId: 'foreign', kind: 'direct', scope: 'other-scope' });
  assert.throws(() => domain.prepareLocal({ ...input, conversationId: foreign.conversationId }), code('FORBIDDEN'));
  const conversation = conversations.getConversation(OWNER, conversationId);
  conversations.setArchived(OWNER, { conversationId, expectedRevision: conversation.revision, archived: true });
  assert.throws(() => domain.prepareLocal(input), code('MEMORY_CONVERSATION_FORBIDDEN'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM shiyu_local_memory_sources').get()!.n, 0);
});

test('failed local admission rolls back source, grant, reserve, operation and Effect together', async t => {
  const { db, prepare, effects } = await fixture(t);
  db.exec("CREATE TRIGGER fail_local_memory BEFORE INSERT ON shiyu_local_memory_operations BEGIN SELECT RAISE(ABORT,'synthetic admission failure'); END");
  assert.throws(() => prepare(), /synthetic admission failure/);
  for (const table of ['shiyu_local_memory_sources', 'shiyu_memory_operations', 'shiyu_mandates', 'shiyu_budget_reservations']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
  assert.equal(effects.list().length, 0);
});

test('claim returns committed qualification once, and expiry/revocation/current generation are checked at execution', async t => {
  const f = await fixture(t); const entry = f.prepare(); const operationId = entry.operation.operationId;
  assert.throws(() => f.tx.atomic(() => f.domain.claim({ operationId })), code('NESTED_DISPATCH'));
  const plan = f.domain.claim({ operationId })!; assert.equal(f.db.isTransaction, false); assert.equal(plan.operation.status, 'dispatching');
  assert.equal(f.domain.claim({ operationId }), undefined); assert.equal(f.effects.attempts(plan.claim.effectId).length, 1);
  assert.equal(f.domain.assertDispatch({ operationId, claim: plan.claim }).commandDigest, entry.operation.commandDigest);
  const grant = f.authority.get(OWNER, entry.operation.mandateRef.mandateId);
  f.authority.pause(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
  assert.throws(() => f.domain.assertDispatch({ operationId, claim: plan.claim }));
  const second = f.prepare('other'); const secondPlan = f.domain.claim({ operationId: second.operation.operationId })!;
  const conversation = f.conversations.getConversation(OWNER, f.conversationId);
  f.conversations.advanceGeneration(OWNER, { conversationId: f.conversationId, expectedRevision: conversation.revision, eventId: 'new-input', reason: 'input' });
  assert.throws(() => f.domain.assertDispatch({ operationId: second.operation.operationId, claim: secondPlan.claim }), code('MEMORY_CONSENT_WITHDRAWN'));
  const third = f.prepare('expired'); f.advance(600001);
  assert.throws(() => f.domain.claim({ operationId: third.operation.operationId }));
});

test('verified exact create/readback publishes a reference and settles only one external effect', async t => {
  const { domain, prepare, effects } = await fixture(t); const entry = prepare(), operationId = entry.operation.operationId;
  const plan = domain.claim({ operationId })!, observed = observation(entry);
  const applied = domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observed, reconciliation: false });
  assert.equal(applied.operation.status, 'applied'); assert.equal(applied.reference!.nativeId, observed.nativeId);
  assert.equal(applied.reservation.state, 'settled'); assert.deepEqual(applied.reservation.observed, { tokens: 0, calls: 0, effects: 1 });
  assert.equal(effects.receipts(plan.claim.effectId).length, 1);
  assert.deepEqual(domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observed, reconciliation: false }), applied);
  assert.deepEqual(domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observed, reconciliation: true }), applied);
  assert.equal(domain.prepareLocal({ requestId: entry.requestId, conversationId: entry.conversationId, bodyDigest: entry.command.bodyDigest, bytes: entry.command.bodyBytes }).duplicate, true);
});

test('strict observation rejects changed command/body/bytes/deployment/provenance/fingerprint and wrong claims', async t => {
  const { domain, prepare, effects } = await fixture(t); const entry = prepare(), operationId = entry.operation.operationId, plan = domain.claim({ operationId })!;
  for (const patch of [{ bodyDigest: 'b'.repeat(64) }, { bodyBytes: 100 }, { deploymentId: 'other-deployment' }, { commandDigest: 'c'.repeat(64) }, { sourceRefs: [{ sourceId: entry.source.sourceId, revision: 2 }] }, { componentVersion: 'version-1' }, { nativeId: 'unverified-id' }, { receiptId: 'unverified-receipt' }, { command: { ...entry.command, targetRef: 'wrong-target' } }]) {
    assert.throws(() => domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry, patch), reconciliation: false }), code('MEMORY_OBSERVATION_MISMATCH'));
  }
  assert.throws(() => domain.recordVerifiedReceipt({ operationId, claim: { ...plan.claim, claimToken: 'wrong' }, observation: observation(entry), reconciliation: false }), code('STALE_FENCE'));
  assert.throws(() => domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: { ...observation(entry), modelText: body } as any, reconciliation: false }), code('INVALID_MEMORY_INPUT'));
  assert.equal(domain.get(operationId).operation.status, 'dispatching'); assert.equal(effects.receipts(plan.claim.effectId).length, 0);
});

test('receipt plus budget settlement rolls back on storage failure instead of claiming applied', async t => {
  const { domain, prepare, db, effects } = await fixture(t); const entry = prepare(), operationId = entry.operation.operationId, plan = domain.claim({ operationId })!;
  db.exec("CREATE TRIGGER fail_memory_usage BEFORE INSERT ON shiyu_budget_receipts BEGIN SELECT RAISE(ABORT,'synthetic budget receipt failure'); END");
  assert.throws(() => domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: false }), /synthetic budget receipt failure/);
  assert.equal(domain.get(operationId).operation.status, 'dispatching'); assert.equal(effects.receipts(plan.claim.effectId).length, 0); assert.equal(domain.get(operationId).reservation.state, 'reserved');
});

test('unknown and crash recovery hold budget and cannot create another attempt', async t => {
  const first = await fixture(t); const entry = first.prepare(), operationId = entry.operation.operationId, plan = first.domain.claim({ operationId })!;
  first.close(); const second = first.open({ runtimeIdentity: { ...identity, hostEpoch: 'memory-host-b' } });
  const recovered = second.domain.get(operationId); assert.equal(recovered.operation.status, 'unknown'); assert.equal(recovered.reservation.state, 'unknown');
  assert.equal(second.domain.claim({ operationId }), undefined); assert.equal(second.prepare().duplicate, true); assert.equal(second.effects.attempts(plan.claim.effectId).length, 1);
  assert.throws(() => second.domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: false }), code('RESULT_UNKNOWN'));
  assert.equal(second.domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: true }).operation.status, 'applied');
});

test('pending withdrawal tombstones before returning, releases unused effect budget and cannot be revived', async t => {
  const { domain, prepare, effects } = await fixture(t); const entry = prepare(), operationId = entry.operation.operationId;
  const withdrawn = domain.withdrawLocal({ requestId: 'withdraw-a', operationId });
  assert.equal(withdrawn.source.consent.state, 'withdrawn'); assert.equal(withdrawn.source.revision, 2); assert.equal(withdrawn.operation.blocked, true);
  assert.equal(withdrawn.operation.status, 'rejected'); assert.equal(withdrawn.reservation.state, 'settled'); assert.equal(withdrawn.reservation.observed.effects, 0);
  assert.deepEqual(domain.withdrawLocal({ requestId: 'withdraw-a', operationId }), withdrawn);
  assert.equal(prepare().duplicate, true); assert.equal(domain.claim({ operationId }), undefined); assert.equal(effects.attempts(entry.operation.effectId).length, 0);
  assert.throws(() => domain.prepareLocal({ requestId: 'reuse-source', conversationId: entry.conversationId, bodyDigest: entry.command.bodyDigest, bytes: entry.command.bodyBytes, sourceId: entry.source.sourceId }), code('SOURCE_ALREADY_REGISTERED'));
  assert.throws(() => domain.readLocal({ operationId }), code('MEMORY_READ_FORBIDDEN'));
});

test('withdrawal while in flight keeps late backend success as fact without restoring read authority', async t => {
  const { domain, prepare, effects } = await fixture(t); const entry = prepare(), operationId = entry.operation.operationId, plan = domain.claim({ operationId })!;
  const withdrawn = domain.withdrawLocal({ requestId: 'withdraw-running', operationId });
  assert.equal(withdrawn.operation.status, 'unknown'); assert.equal(withdrawn.reservation.state, 'unknown');
  assert.throws(() => domain.assertDispatch({ operationId, claim: plan.claim }));
  const late = domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: true });
  assert.equal(effects.get(plan.claim.effectId)!.status, 'succeeded'); assert.equal(late.operation.backendOutcome, 'applied');
  assert.equal(late.operation.status, 'unknown'); assert.equal(late.operation.blocked, true); assert.equal(late.reference, undefined); assert.equal(late.reservation.observed.effects, 1);
  assert.throws(() => domain.publishLocal({ operationId, expectedVersion: late.operation.version, receiptId: observation(entry).receiptId }), code('TOMBSTONED'));
});

test('archived or removed conversations do not prevent withdrawing a previously owned source', async t => {
  const f = await fixture(t); const entry = f.prepare(), operationId = entry.operation.operationId, plan = f.domain.claim({ operationId })!;
  f.domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: false });
  const conversation = f.conversations.getConversation(OWNER, f.conversationId);
  const archived = f.conversations.setArchived(OWNER, { conversationId: f.conversationId, expectedRevision: conversation.revision, archived: true });
  assert.equal(f.domain.withdrawLocal({ requestId: 'archived-withdraw', operationId }).source.consent.state, 'withdrawn');
  f.conversations.setArchived(OWNER, { conversationId: f.conversationId, expectedRevision: archived.revision, archived: false });
  assert.throws(() => f.domain.readLocal({ operationId }), code('MEMORY_READ_FORBIDDEN'));
  const next = f.prepare('remove-conversation');
  f.db.prepare('DELETE FROM shiyu_conversations WHERE id=?').run(f.conversationId);
  assert.equal(f.domain.withdrawLocal({ requestId: 'removed-withdraw', operationId: next.operation.operationId }).operation.blocked, true);
});

test('read token survives normal dialogue/write expiry but detects auth changes and rejects audience/deletion changes', async t => {
  const f = await fixture(t); const entry = f.prepare(), operationId = entry.operation.operationId, plan = f.domain.claim({ operationId })!;
  f.domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: false });
  const before = f.domain.readLocal({ operationId }).readToken;
  const conversation = f.conversations.getConversation(OWNER, f.conversationId);
  f.conversations.advanceGeneration(OWNER, { conversationId: f.conversationId, expectedRevision: conversation.revision, eventId: 'later-message', reason: 'input' });
  assert.deepEqual(f.domain.readLocal({ operationId }).readToken, before);
  f.advance(600001); assert.deepEqual(f.domain.readLocal({ operationId }).readToken, before);
  const grant = f.authority.get(OWNER, entry.operation.mandateRef.mandateId);
  f.authority.revoke(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
  const changed = f.domain.readLocal({ operationId }).readToken; assert.notEqual(changed.authorizationEpoch, before.authorizationEpoch); assert.notEqual(changed.saveMandateVersion, before.saveMandateVersion);
  const current = f.conversations.getConversation(OWNER, f.conversationId);
  f.conversations.invalidateAudience(OWNER, { conversationId: f.conversationId, expectedRevision: current.revision, reasonRef: 'owner-audience-changed' });
  assert.throws(() => f.domain.readLocal({ operationId }), code('MEMORY_READ_FORBIDDEN'));
});

test('a new installation generation does not expose previously published backend references', async t => {
  const first = await fixture(t); const entry = first.prepare(), operationId = entry.operation.operationId, plan = first.domain.claim({ operationId })!;
  first.domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: false });
  first.close(); const restored = first.open({ runtimeIdentity: { installationGeneration: 'new-installation', hostEpoch: 'new-host' } });
  assert.equal(restored.domain.get(operationId).operation.status, 'applied');
  assert.equal(restored.domain.get(operationId).reference, undefined); assert.equal(restored.domain.get(operationId).canPublish, false);
  assert.throws(() => restored.domain.readLocal({ operationId }), code('MEMORY_READ_FORBIDDEN'));
});

test('missing local consent metadata cannot be rebuilt as an empty memory installation', async t => {
  const f = await fixture(t); f.prepare();
  f.db.exec('DROP TABLE shiyu_local_memory_withdrawals; DROP TABLE shiyu_local_memory_operations; DROP TABLE shiyu_local_memory_sources; DROP TABLE shiyu_local_memory_meta;');
  assert.throws(() => new MemoryDomain(f.db, f.tx, { runtimeIdentity: identity, backendId: 'ombre-local', deploymentId: 'deployment-a', getConversation: id => f.conversations.getConversation(OWNER, id), now: () => new Date(start) }), code('CORRUPT_MEMORY_DOMAIN'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name LIKE 'shiyu_local_memory_%'").get()!.n, 0);
});

test('publication recheck uses the verifier role and never executes or charges the backend again', async t => {
  const { domain, prepare, effects } = await fixture(t); const entry = prepare(), operationId = entry.operation.operationId, plan = domain.claim({ operationId })!;
  const applied = domain.recordVerifiedReceipt({ operationId, claim: plan.claim, observation: observation(entry), reconciliation: false });
  const after = domain.publishLocal({ operationId, expectedVersion: applied.operation.version, receiptId: observation(entry).receiptId });
  assert.equal(after.operation.status, 'applied'); assert.equal(effects.attempts(plan.claim.effectId).length, 1); assert.deepEqual(after.reservation, applied.reservation);
});

test('Task and Memory share one authority without changing Task permissions or granting backend reads/erasure', async t => {
  const { db, tx, authority, prepare } = await fixture(t);
  new TaskDomain(db, tx, { runtimeIdentity: identity, now: () => new Date(start) });
  const entry = prepare(); const grant = authority.get(OWNER, entry.operation.mandateRef.mandateId);
  assert.deepEqual(grant.allowedActions, ['memory.write']); assert.equal(createControlAuthority(db, tx), authority);
});

test('the command digest uses the shared strict schema and the frozen cross-language vector', () => {
  const data = memoryBodyDigest('合成记忆 🪶');
  const command = { schemaVersion: 1, kind: 'create', operationId: 'op-1', backendId: 'ombre-local', scope: 'local-owner', targetRef: 'target-1', ...data, sourceRefs: [{ sourceId: 'source-1', revision: 1 }] } as const;
  assert.equal(memoryCommandDigest({ ...command, sourceRefs: [...command.sourceRefs] }), 'e69a2de3b025b7256112be410c09b0868328b035aef723e072f2a78903583ede');
  assert.equal(canonicalMemoryCommand({ ...command, sourceRefs: [...command.sourceRefs] }).includes('合成记忆'), false);
});

test('memory view candidates are exact-conversation metadata, never a similarity or caller-scope permission', async t => {
  const f = await fixture(t); const accepted = apply(f.domain, f.prepare()); const pending = f.prepare('pending');
  const foreign = f.conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: 'another-private', kind: 'direct', scope: 'local-owner' });
  const text = memoryBodyDigest('另一私聊的合成记忆');
  const another = apply(f.domain, f.domain.prepareLocal({ requestId: 'another-save', conversationId: foreign.conversationId, bodyDigest: text.bodyDigest, bytes: text.bodyBytes }));
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const snapshot = f.domain.listEligibleForView({ conversationId: f.conversationId });
  assert.equal(snapshot.sources.length, 1); assert.equal(snapshot.sources[0].operationId, accepted.operation.operationId);
  assert.equal(snapshot.sources[0].sourceId, accepted.source.sourceId); assert.equal(snapshot.authority.deletionScope, 'local-memory-source');
  assert.equal(snapshot.sources[0].commandDigest, accepted.operation.commandDigest); assert.equal(JSON.stringify(snapshot).includes(body), false);
  assert.deepEqual(f.domain.validateForView(snapshot), snapshot); assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.throws(() => f.domain.captureForView({ conversationId: f.conversationId, operationIds: [pending.operation.operationId] }), code('MEMORY_READ_FORBIDDEN'));
  assert.throws(() => f.domain.captureForView({ conversationId: f.conversationId, operationIds: [another.operation.operationId] }), code('MEMORY_VIEW_FORBIDDEN'));
  for (const extra of [{ scope: 'other' }, { similarity: 1 }, { query: 'grant permission' }]) assert.throws(() => f.domain.captureForView({ conversationId: f.conversationId, ...extra } as any), code('INVALID_MEMORY_INPUT'));
  assert.equal(f.domain.readLocal({ operationId: accepted.operation.operationId }).bodyReceiptId, observation(accepted).receiptId);
});

test('empty and nonempty captures carry independent deletion authority even when the write grant was already revoked', async t => {
  const f = await fixture(t); const entry = apply(f.domain, f.prepare()), operationId = entry.operation.operationId;
  const grant = f.authority.get(OWNER, entry.operation.mandateRef.mandateId); f.authority.revoke(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
  const empty = f.domain.captureForView({ conversationId: f.conversationId, operationIds: [] });
  const selected = f.domain.captureForView({ conversationId: f.conversationId, operationIds: [operationId] });
  assert.equal(empty.sources.length, 0); assert.deepEqual(empty.authority, selected.authority);
  const epoch = f.authority.health().authEpoch;
  f.domain.withdrawLocal({ requestId: 'already-revoked-withdrawal', operationId });
  assert.equal(f.authority.health().authEpoch, epoch);
  const after = f.domain.captureForView({ conversationId: f.conversationId, operationIds: [] });
  assert.equal(after.authority.deletionBaselineId, empty.authority.deletionBaselineId);
  assert.equal(after.authority.tombstoneWatermark, empty.authority.tombstoneWatermark + 1);
  assert.throws(() => f.domain.validateForView(empty), code('MEMORY_VIEW_INVALIDATED'));
  assert.throws(() => f.domain.validateForView(selected), code('MEMORY_VIEW_INVALIDATED'));
});

test('fixed selected sources do not change when a different admitted memory is later published', async t => {
  const f = await fixture(t); const first = apply(f.domain, f.prepare()), second = f.prepare('second-save');
  // Both grants already exist: this changes the eligible pool, not authority.
  const selected = f.domain.captureForView({ conversationId: f.conversationId, operationIds: [first.operation.operationId] });
  const empty = f.domain.captureForView({ conversationId: f.conversationId, operationIds: [] });
  apply(f.domain, second);
  const pool = f.domain.listEligibleForView({ conversationId: f.conversationId });
  assert.equal(pool.sources.length, 2); assert.notEqual(pool.collectionHash, selected.collectionHash);
  assert.deepEqual(f.domain.validateForView(selected), selected); assert.deepEqual(f.domain.validateForView(empty), empty);
  const selectedNow = f.domain.captureForView({ conversationId: f.conversationId, operationIds: [first.operation.operationId] });
  assert.equal(selectedNow.snapshotHash, selected.snapshotHash); assert.notEqual(selectedNow.collectionHash, selected.collectionHash);
});

test('capture identity and selected source versions cannot be refreshed or forged into authority', async t => {
  const f = await fixture(t); const entry = apply(f.domain, f.prepare()), snapshot = f.domain.captureForView({ conversationId: f.conversationId, operationIds: [entry.operation.operationId] });
  const tampered = structuredClone(snapshot); tampered.sources[0].readToken.sourceRevision++;
  assert.throws(() => f.domain.validateForView(tampered), code('MEMORY_VIEW_INVALIDATED'));
  const conversation = f.conversations.getConversation(OWNER, f.conversationId);
  f.conversations.invalidateAudience(OWNER, { conversationId: f.conversationId, expectedRevision: conversation.revision, reasonRef: 'view-audience-changed' });
  assert.throws(() => f.domain.validateForView(snapshot), code('MEMORY_READ_FORBIDDEN'));
  assert.throws(() => f.domain.captureForView({ conversationId: f.conversationId, operationIds: ['duplicate', 'duplicate'] }), code('INVALID_MEMORY_INPUT'));
  assert.throws(() => f.domain.captureForView({ conversationId: f.conversationId, operationIds: Array.from({ length: MAX_MEMORY_VIEW_CANDIDATES + 1 }, (_, i) => `source-${i}`) }), code('INVALID_MEMORY_INPUT'));
});

test('native exposure reuse checks fresh individual permission without pinning unrelated global counters forever', async t => {
  const f = await fixture(t); const entry = apply(f.domain, f.prepare()), snapshot = f.domain.captureForView({ conversationId: f.conversationId });
  f.domain.validateExposedSources(snapshot.sources);
  const other = apply(f.domain, f.prepare('unrelated'));
  assert.throws(() => f.domain.validateForView(snapshot), code('MEMORY_VIEW_INVALIDATED')); // short capture epoch is strong
  f.domain.validateExposedSources(snapshot.sources);
  f.domain.withdrawLocal({ requestId: 'withdraw-unrelated', operationId: other.operation.operationId });
  f.domain.validateExposedSources(snapshot.sources);
  const grant = f.authority.get(OWNER, entry.operation.mandateRef.mandateId); f.authority.revoke(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
  f.domain.validateExposedSources(snapshot.sources); // save grant is not ongoing read consent
  const changed = structuredClone(snapshot.sources); changed[0].nativeId = `shiyu_${'f'.repeat(32)}`;
  assert.throws(() => f.domain.validateExposedSources(changed), code('MEMORY_VIEW_INVALIDATED'));
  f.domain.withdrawLocal({ requestId: 'withdraw-exposed', operationId: entry.operation.operationId });
  assert.throws(() => f.domain.validateExposedSources(snapshot.sources), code('MEMORY_READ_FORBIDDEN'));
});

test('withdrawal and same-Worker context fences commit atomically, while duplicate withdrawal never resets again', async t => {
  let db: DatabaseSync; let count = 0; let shouldFail = true;
  const notification: MemoryContextInvalidation = { conversationIds: [], retiredSessions: [{ bindingId: 'binding-a', sessionEpoch: 1, sessionId: 'native-old', businessId: 'business-old' }] };
  const f = await fixture(t, { onWithdrawSources: input => {
    assert.equal(db.isTransaction, true); assert.equal(Object.isFrozen(input.sourceIds), true); assert.equal(input.sourceIds.length, 1);
    count++; db.prepare('INSERT INTO synthetic_context_retirements VALUES(?,?)').run(input.withdrawalId, input.sourceIds[0]);
    if (shouldFail) throw new Error('synthetic context reset failure');
    return notification;
  } }); db = f.db;
  db.exec('CREATE TABLE synthetic_context_retirements(withdrawal_id TEXT PRIMARY KEY,source_id TEXT NOT NULL)');
  const entry = apply(f.domain, f.prepare()); notification.conversationIds.push(f.conversationId);
  const snapshot = f.domain.captureForView({ conversationId: f.conversationId }); const epoch = f.authority.health().authEpoch;
  assert.throws(() => f.domain.withdrawLocal({ requestId: 'atomic-withdrawal', operationId: entry.operation.operationId }), /synthetic context reset failure/);
  assert.equal(f.authority.health().authEpoch, epoch); assert.equal(f.domain.get(entry.operation.operationId).source.consent.state, 'active');
  assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic_context_retirements').get()!.n, 0); assert.deepEqual(f.domain.validateForView(snapshot), snapshot);
  shouldFail = false;
  const withdrawn = f.domain.withdrawLocal({ requestId: 'atomic-withdrawal', operationId: entry.operation.operationId });
  assert.deepEqual(withdrawn.contextInvalidation, notification); assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic_context_retirements').get()!.n, 1);
  assert.equal(f.domain.get(entry.operation.operationId).source.consent.state, 'withdrawn'); assert.throws(() => f.domain.validateForView(snapshot), code('MEMORY_VIEW_INVALIDATED'));
  const duplicate = f.domain.withdrawLocal({ requestId: 'atomic-withdrawal', operationId: entry.operation.operationId });
  assert.equal(duplicate.contextInvalidation, undefined); assert.equal(count, 2);
});

test('async/thenable retirement hooks fail before context authority can escape its transaction', async t => {
  let thenCalls = 0; let result: unknown = { then() { thenCalls++; } };
  const f = await fixture(t, { onWithdrawSources: (() => result) as any }); const entry = apply(f.domain, f.prepare());
  let asyncCalls = 0;
  assert.throws(() => new MemoryDomain(f.db, f.tx, { runtimeIdentity: identity, backendId: 'ombre-local', deploymentId: 'deployment-a', getConversation: (id: string) => f.conversations.getConversation(OWNER, id), onWithdrawSources: async () => { asyncCalls++; } } as any), code('INVALID_MEMORY_CONFIGURATION'));
  assert.throws(() => f.domain.withdrawLocal({ requestId: 'thenable-reset', operationId: entry.operation.operationId }), code('ASYNC_MEMORY_INVALIDATION'));
  result = Promise.reject(new Error('synthetic promised reset failure'));
  assert.throws(() => f.domain.withdrawLocal({ requestId: 'promised-reset', operationId: entry.operation.operationId }), code('ASYNC_MEMORY_INVALIDATION'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asyncCalls, 0); assert.equal(thenCalls, 0); assert.equal(f.domain.get(entry.operation.operationId).source.consent.state, 'active');
});

test('candidate pool returns at most 200 authorized metadata records and reports truncation', async t => {
  const f = await fixture(t);
  for (let i = 0; i <= MAX_MEMORY_VIEW_CANDIDATES; i++) apply(f.domain, f.prepare(`bounded-${i}`));
  const pool = f.domain.listEligibleForView({ conversationId: f.conversationId });
  assert.equal(pool.sources.length, MAX_MEMORY_VIEW_CANDIDATES); assert.equal(pool.truncated, true);
  assert.equal(new Set(pool.sources.map(source => source.operationId)).size, MAX_MEMORY_VIEW_CANDIDATES);
});
