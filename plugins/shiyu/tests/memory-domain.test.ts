import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { MemoryDomain, type MemoryBackendObservation, type LocalMemoryEntry, type MemoryDomainOptions } from '../src/adapters/control-store/memory-domain.js';
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
async function fixture(t: TestContext) {
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
  return { ...open(), open, advance: (ms: number) => { clock += ms; } };
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
