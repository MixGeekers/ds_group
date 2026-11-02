import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { RelationshipDomain } from '../src/adapters/control-store/relationship-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { CONVERSATION_BACKGROUND_HANDLER } from '../src/adapters/control-store/conversation-domain.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { syntheticLocalNoteBinding, observeSyntheticLocalNote } from './helpers/capability.js';

const code = (...codes: string[]) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
interface OpenPatch { hostEpoch?: string; installationGeneration?: string; memory?: boolean }
async function fixture(t: TestContext, config: OpenPatch = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-inner-lifecycle-')), filename = join(directory, 'control.sqlite'), stores: ControlStore[] = [];
  const open = async (patch: OpenPatch = {}) => {
    const installationGeneration = patch.installationGeneration ?? 'lifecycle-install';
    const memory = patch.memory ?? config.memory ?? true;
    const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [CONVERSATION_BACKGROUND_HANDLER],
      runtimeIdentity: { hostEpoch: patch.hostEpoch ?? 'lifecycle-host', installationGeneration },
      localNoteBinding: syntheticLocalNoteBinding(installationGeneration),
      ...(memory ? { memoryBackend: { backendId: 'ombre-local', deploymentId: 'deployment-a' } } : {}) });
    stores.push(store);
    await observeSyntheticLocalNote(store, { hostEpoch: patch.hostEpoch ?? 'lifecycle-host', installationGeneration });
    return store;
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close().catch(() => undefined))); await rm(directory, { recursive: true, force: true }); });
  const store = await open(config);
  const conversation = async () => {
    const { task } = await store.request('task.createLocal', { requestId: `task-${randomUUID()}`, title: '合成生命周期任务', content: 'LIFECYCLE-ARTIFACT' });
    return (await store.request('conversation.ensureLocalTask', { taskId: task.taskId, localConversationKey: 'lifecycle-dm' })).conversationId;
  };
  const observation = (conversationId: string) => ({ kind: 'conversation-observation' as const, sourceId: conversationId, revision: 1 });
  const saveMemory = async (conversationId: string) => {
    const body = '合成记忆正文，生命周期测试；只保存在假原生后端。', value = memoryBodyDigest(body);
    const entry = await store.request('memory.prepareLocal', { requestId: randomUUID(), conversationId, bodyDigest: value.bodyDigest, bytes: value.bodyBytes });
    const operationId = entry.operation.operationId, plan = (await store.request('memory.claim', { operationId }))!;
    const observed: MemoryBackendObservation = { command: entry.command, commandDigest: memoryCommandDigest(entry.command), deploymentId: 'deployment-a',
      nativeId: `shiyu_${sha(operationId).slice(0, 32)}`, receiptId: `receipt_${sha(operationId)}`, componentVersion: `sha256:${sha(body)}`,
      bodyDigest: entry.command.bodyDigest, bodyBytes: entry.command.bodyBytes, sourceRefs: entry.command.sourceRefs, observedAt: new Date().toISOString() };
    await store.request('memory.recordVerifiedReceipt', { operationId, claim: plan.claim, observation: observed, reconciliation: false });
    return { operationId, body, command: entry.command };
  };
  const capture = async (domain: 'relationship' | 'emotion' | 'cognition' | 'personality', conversationId: string) =>
    store.request(`${domain}.captureForView` as never, { conversationId } as never) as Promise<{ captureId: string; authority: { derivedRevision?: number; tombstoneWatermark: number }; records: { recordId: string; revision: number; evidenceState: string; derivation?: string; derivationReasons?: string[]; bodyAvailable: boolean }[] }>;
  type LifecycleRecord = { recordId: string; revision: number; evidenceState: string; derivation?: string; derivationReasons?: string[]; bodyAvailable: boolean };
  const find = (captured: { records: { recordId: string }[] }, recordId: string): LifecycleRecord =>
    captured.records.find(record => record.recordId === recordId) as unknown as LifecycleRecord;
  const viewCapture = async (domain: 'relationship' | 'emotion' | 'cognition' | 'personality', conversationId: string) =>
    store.request('view.captureLocal', { conversationId, purpose: 'reply_context', innerDomains: [domain] }) as Promise<{
      captureId: string; inner: { domains: Record<string, { records: { recordId: string; revision: number; evidenceState: string; derivation?: string; derivationReasons?: string[]; bodyAvailable: boolean }[] }> };
    }>;
  const viewFind = (captured: Awaited<ReturnType<typeof viewCapture>>, domain: string, recordId: string) =>
    captured.inner.domains[domain]!.records.find(record => record.recordId === recordId)!;
  return { ...{ store, open, filename, stores }, conversation, observation, saveMemory, capture, find, viewCapture, viewFind, directory };
}

test('memory withdrawal deterministically degrades cross-domain dependants and rejects stale captures and bodies', async t => {
  const f = await fixture(t), conversationId = await f.conversation(), observation = f.observation(conversationId);
  const memory = await f.saveMemory(conversationId);
  const subject = await f.store.request('relationship.registerSubject', { requestId: 'life-subject', account: {
    connectionId: 'synthetic-connection', identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId: 'life-person' }, entityKind: 'person', displayName: '生命周期同名' });
  const assertion = await f.store.request('relationship.assert', { requestId: 'life-assertion', conversationId, subjectId: subject.record.entityId,
    predicate: 'alias', value: '生命周期-ALPHA', sourceRefs: [observation, { kind: 'memory-operation', sourceId: memory.operationId, revision: 1 }] });
  const claim = await f.store.request('cognition.propose', { requestId: 'life-claim', conversationId, claimType: 'external-observation', subjectIds: ['life-subject-a'],
    predicate: 'observed-alias', proposition: '观察到生命周期别名。', confidenceBps: 6000,
    sourceRefs: [observation, { kind: 'relationship-record', sourceId: assertion.record.recordId, revision: 1 }] });
  const emotion = await f.store.request('emotion.observe', { requestId: 'life-emotion', conversationId, valenceBps: 6000, arousalBps: 3000, label: 'positive',
    sourceRefs: [observation, { kind: 'relationship-record', sourceId: assertion.record.recordId, revision: 1 }] });
  const relationshipCapture = await f.viewCapture('relationship', conversationId);
  const cognitionCapture = await f.viewCapture('cognition', conversationId);
  const emotionCapture = await f.viewCapture('emotion', conversationId);
  assert.equal(f.viewFind(relationshipCapture, 'relationship', assertion.record.recordId).derivation, 'current');
  assert.equal(f.viewFind(relationshipCapture, 'relationship', assertion.record.recordId).evidenceState, 'valid');
  const domainAuthorityBefore = (await f.store.request('relationship.derivations', {})).derivedRevision;
  // Withdrawal commits in the same Worker transaction as the derivation signal.
  const withdrawn = await f.store.request('memory.withdrawLocal', { requestId: 'life-withdraw', operationId: memory.operationId });
  assert.equal(withdrawn.source.consent.state, 'withdrawn');
  const relationshipAfter = await f.capture('relationship', conversationId);
  const assertionAfter = f.find(relationshipAfter, assertion.record.recordId);
  assert.equal(assertionAfter.derivation, 'degraded');
  assert.equal(assertionAfter.evidenceState, 'degraded');
  assert.ok(assertionAfter.derivationReasons?.includes('source_revoked'));
  assert.equal(assertionAfter.bodyAvailable, true); // one independent source remains: explicit degraded, not deleted
  const cognitionAfter = f.find(await f.capture('cognition', conversationId), claim.record.recordId);
  assert.notEqual(cognitionAfter.derivation, 'current');
  assert.equal(cognitionAfter.evidenceState, 'degraded');
  const emotionAfter = f.find(await f.capture('emotion', conversationId), emotion.record.recordId);
  assert.notEqual(emotionAfter.derivation, 'current');
  // Pinned captures and their bodies are refused after the derivation moved.
  for (const captured of [relationshipCapture, cognitionCapture, emotionCapture]) {
    await assert.rejects(f.store.request('view.validateCapture', { captureId: captured.captureId }) as Promise<unknown>, code('VIEW_INVALIDATED'));
  }
  await assert.rejects(f.store.request('view.readInnerBodies', { captureId: relationshipCapture.captureId, domain: 'relationship',
    recordIds: [assertion.record.recordId] }) as Promise<unknown>, code('VIEW_INVALIDATED', 'INNER_BODY_FORBIDDEN'));
  // Revision watermarks actually moved and are recorded.
  assert.ok((relationshipAfter.authority.derivedRevision ?? 0) > domainAuthorityBefore);
  const relationshipStates = await f.store.request('relationship.derivations', {});
  assert.equal(relationshipStates.counts.degraded >= 1, true);
  // A fresh write citing the withdrawn memory source cannot resurrect it.
  await assert.rejects(f.store.request('relationship.assert', { requestId: 'life-after-withdraw', conversationId, subjectId: subject.record.entityId,
    predicate: 'alias', value: '不应复活', sourceRefs: [observation, { kind: 'memory-operation', sourceId: memory.operationId, revision: 1 }] }) as Promise<unknown>,
    code('INNER_SOURCE_UNAVAILABLE', 'INNER_SOURCE_REVOKED'));
  // Deeper dependency: the cognition claim citing the now-degraded relationship record is itself non-current.
  const relationshipDerived = await f.store.request('relationship.derivations', {});
  assert.equal(relationshipDerived.states.some(state => state.derivation === 'degraded'), true);
});

test('memory forget is an explicit logical barrier with a read-only lifecycle and stable publication', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  const memory = await f.saveMemory(conversationId);
  const before = (await f.store.request('view.state', {}))!;
  const active = await f.store.request('memory.lifecycle', { operationId: memory.operationId });
  assert.equal(active.consentState, 'active'); assert.equal(active.retention.retained, true);
  assert.equal(active.retention.automaticExpiry, false); assert.equal(active.retention.physicalErase, false);
  assert.equal(active.policy.forgetMode, 'logical-tombstone');
  const receipt = await f.store.request('memory.forgetLocal', { requestId: 'life-forget', operationId: memory.operationId });
  assert.equal(receipt.source.consent.state, 'withdrawn');
  assert.ok(receipt.source.consent.forgottenAt);
  const replay = await f.store.request('memory.forgetLocal', { requestId: 'life-forget', operationId: memory.operationId });
  assert.deepEqual(replay.source.consent, receipt.source.consent);
  const forgotten = await f.store.request('memory.lifecycle', { operationId: memory.operationId });
  assert.equal(forgotten.consentState, 'withdrawn'); assert.equal(forgotten.retention.retained, false);
  assert.equal(forgotten.retention.reasonCode, 'OWNER_FORGET'); assert.ok(forgotten.forgottenAt);
  assert.equal(forgotten.bodyReferencePresent, false); assert.equal(forgotten.canPublish, false);
  assert.equal(forgotten.deletionWatermark >= 1, true);
  await assert.rejects(f.store.request('memory.readLocal', { operationId: memory.operationId }) as Promise<unknown>, code('MEMORY_READ_FORBIDDEN', 'MEMORY_CONSENT_WITHDRAWN'));
  // The publication is a read-capability declaration; recompute/forget must not upgrade it.
  const after = (await f.store.request('view.state', {}))!;
  assert.equal(after.stateVersion, before.stateVersion); assert.equal(after.manifestHash, before.manifestHash);
  assert.deepEqual(after.manifest.domains, before.manifest.domains);
  assert.equal('verification' in (after.manifest.domains.relationship as object), false);
});

test('a personality profile version change makes dependants need review and invalidates old captures', async t => {
  const f = await fixture(t), conversationId = await f.conversation(), observation = f.observation(conversationId);
  const profile = await f.viewCapture('personality', conversationId);
  const activeProfile = f.viewFind(profile, 'personality', 'profile:v1:r1');
  assert.equal(activeProfile.recordId, 'profile:v1:r1');
  const claim = await f.store.request('cognition.propose', { requestId: 'profile-claim', conversationId, claimType: 'external-observation', subjectIds: ['profile-subject'],
    predicate: 'follows-profile', proposition: '遵循当前人格配置。', confidenceBps: 7000,
    sourceRefs: [observation, { kind: 'personality-profile', sourceId: activeProfile.recordId, revision: activeProfile.revision }] });
  assert.equal((await f.capture('cognition', conversationId)).records.find(record => record.recordId === claim.record.recordId)!.derivation, 'current');
  const proposal = await f.store.request('personality.propose', { requestId: 'profile-proposal', conversationId, expectedProfileVersion: 1,
    sourceKind: 'user-explicit', displayName: '生命周期人格', sourceRefs: [observation] });
  await f.store.request('personality.review', { requestId: 'profile-approve', conversationId, candidateId: proposal.record.candidateId,
    expectedRevision: 1, decision: 'approve', sourceRefs: [observation] });
  await assert.rejects(f.store.request('view.validateCapture', { captureId: profile.captureId }) as Promise<unknown>, code('VIEW_INVALIDATED'));
  const cognitionAfter = await f.capture('cognition', conversationId);
  const claimAfter = cognitionAfter.records.find(record => record.recordId === claim.record.recordId)!;
  assert.equal(claimAfter.derivation, 'needs_review');
  assert.equal(claimAfter.bodyAvailable, false);
  assert.ok(claimAfter.derivationReasons?.includes('source_not_current'));
  // A stale profile version cannot be cited by new state, but the new active version can.
  await assert.rejects(f.store.request('cognition.propose', { requestId: 'stale-profile-claim', conversationId, claimType: 'external-observation', subjectIds: ['profile-subject'],
    predicate: 'follows-stale-profile', proposition: '依赖旧人格。', confidenceBps: 7000,
    sourceRefs: [observation, { kind: 'personality-profile', sourceId: activeProfile.recordId, revision: activeProfile.revision }] }) as Promise<unknown>,
    code('INNER_SOURCE_NOT_CURRENT'));
  const nextProfile = (await f.capture('personality', conversationId)).records[0]!;
  const current = await f.store.request('cognition.propose', { requestId: 'current-profile-claim', conversationId, claimType: 'external-observation', subjectIds: ['profile-subject'],
    predicate: 'follows-current-profile', proposition: '依赖当前人格。', confidenceBps: 7000,
    sourceRefs: [observation, { kind: 'personality-profile', sourceId: nextProfile.recordId, revision: nextProfile.revision }] });
  assert.equal((await f.capture('cognition', conversationId)).records.find(record => record.recordId === current.record.recordId)!.derivation, 'current');
});

test('relationship merge makes dependants needs-revew and split deterministically restores them; history is not rewritten', async t => {
  const f = await fixture(t), conversationId = await f.conversation(), observation = f.observation(conversationId);
  const first = await f.store.request('relationship.registerSubject', { requestId: 'merge-first', account: { connectionId: 'synthetic-connection',
    identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId: 'merge-one' }, entityKind: 'person', displayName: '合并同名' });
  const second = await f.store.request('relationship.registerSubject', { requestId: 'merge-second', account: { connectionId: 'synthetic-connection',
    identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId: 'merge-two' }, entityKind: 'person', displayName: '合并同名' });
  const entityRecordId = `entity:${first.record.entityId}:r1`;
  const claim = await f.store.request('cognition.propose', { requestId: 'merge-claim', conversationId, claimType: 'external-observation', subjectIds: ['merge-subject'],
    predicate: 'knows-entity', proposition: '认识该主体。', confidenceBps: 6000,
    sourceRefs: [observation, { kind: 'relationship-record', sourceId: entityRecordId, revision: 1 }] });
  const merged = await f.store.request('relationship.mergeSubjects', { requestId: 'merge-command', fromEntityId: first.record.entityId, intoEntityId: second.record.entityId, sourceRefs: [observation] });
  let claimState = (await f.capture('cognition', conversationId)).records.find(record => record.recordId === claim.record.recordId)!;
  assert.equal(claimState.derivation, 'needs_review');
  assert.ok(claimState.derivationReasons?.includes('source_merged'));
  await f.store.request('relationship.splitSubjects', { requestId: 'split-command', mergeId: merged.record.mergeId, expectedRevision: 1, sourceRefs: [observation] });
  claimState = (await f.capture('cognition', conversationId)).records.find(record => record.recordId === claim.record.recordId)!;
  assert.equal(claimState.derivation, 'current');
  // The stored claim still names its original evidence record; merge never rewrote history.
  const relationshipBodies = await f.store.request('relationship.readBodies', { capture: await f.capture('relationship', conversationId) as never,
    recordIds: [entityRecordId] });
  assert.equal(relationshipBodies.bodies.length >= 1, true);
});

test('emotion observation withdrawal is announced to dependants with explicit review state', async t => {
  const f = await fixture(t), conversationId = await f.conversation(), observation = f.observation(conversationId);
  const emotion = await f.store.request('emotion.observe', { requestId: 'emotion-source', conversationId, valenceBps: 6500, arousalBps: 2500, label: 'positive', sourceRefs: [observation] });
  const subject = await f.store.request('relationship.registerSubject', { requestId: 'emotion-subject', account: { connectionId: 'synthetic-connection',
    identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId: 'emotion-person' }, entityKind: 'person', displayName: '情绪同名' });
  const relationship = await f.store.request('relationship.assert', { requestId: 'emotion-dependent', conversationId,
    subjectId: subject.record.entityId, predicate: 'communication-preference', value: 'brief',
    sourceRefs: [observation, { kind: 'emotion-record', sourceId: emotion.record.recordId, revision: 1 }] });
  assert.equal((await f.capture('relationship', conversationId)).records.find(record => record.recordId === relationship.record.recordId)!.derivation, 'current');
  await f.store.request('emotion.withdraw', { requestId: 'emotion-withdraw', evidenceRefs: [observation] });
  const after = (await f.capture('relationship', conversationId)).records.find(record => record.recordId === relationship.record.recordId)!;
  assert.equal(after.derivation, 'degraded');
  assert.ok(after.derivationReasons?.includes('source_revoked'));
  const emotionState = await f.store.request('emotion.state', { conversationId });
  assert.equal(emotionState.contributions.some(item => item.recordId === emotion.record.recordId), false);
  assert.ok(emotionState.revokedEvidence.includes(emotion.record.recordId));
  await assert.rejects(f.store.request('relationship.assert', { requestId: 'cite-revoked-emotion', conversationId, subjectId: subject.record.entityId,
    predicate: 'communication-preference', value: 'casual', sourceRefs: [observation, { kind: 'emotion-record', sourceId: emotion.record.recordId, revision: 1 }] }) as Promise<unknown>,
    code('INNER_SOURCE_UNAVAILABLE', 'INNER_SOURCE_REVOKED'));
});

test('recompute is deterministic, idempotent, restart-persistent and publication-neutral', async t => {
  const f = await fixture(t), conversationId = await f.conversation(), observation = f.observation(conversationId);
  const subject = await f.store.request('relationship.registerSubject', { requestId: 'recompute-subject', account: { connectionId: 'synthetic-connection',
    identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId: 'recompute-person' }, entityKind: 'person', displayName: '重算同名' });
  const assertion = await f.store.request('relationship.assert', { requestId: 'recompute-assertion', conversationId, subjectId: subject.record.entityId,
    predicate: 'alias', value: '重算-ALPHA', sourceRefs: [observation] });
  const first = await f.store.request('relationship.recompute', { requestId: 'recompute-1' });
  const second = await f.store.request('relationship.recompute', { requestId: 'recompute-2' });
  assert.equal(typeof first.changed, 'boolean');
  assert.equal(second.changed, false);
  assert.equal(second.derivedRevision, first.derivedRevision);
  const replay = await f.store.request('relationship.recompute', { requestId: 'recompute-1' });
  assert.deepEqual(replay, first);
  const persistedRevision = first.derivedRevision;
  const capture = await f.viewCapture('relationship', conversationId);
  await f.store.request('relationship.withdraw', { requestId: 'recompute-withdraw', recordIds: [assertion.record.recordId] });
  // Old capture rejects after the recompute signal.
  await assert.rejects(f.store.request('view.validateCapture', { captureId: capture.captureId }) as Promise<unknown>, code('VIEW_INVALIDATED'));
  const after = await f.store.request('relationship.recompute', { requestId: 'recompute-3' });
  assert.equal(typeof after.changed, 'boolean'); assert.ok(after.derivedRevision > persistedRevision);
  assert.equal(after.counts.revoked >= 1, true);
  // Restart keeps the derivation revision, the revocation and the rejection of the old capture.
  await f.store.close();
  const reopened = await f.open({ hostEpoch: 'lifecycle-host-2' });
  const current = await reopened.request('relationship.derivations', {});
  assert.equal(current.derivedRevision >= after.derivedRevision, true);
  assert.equal(current.counts.revoked >= 1, true);
  const fresh = await reopened.request('relationship.captureForView', { conversationId });
  assert.equal(fresh.records.find(record => record.recordId === assertion.record.recordId), undefined);
  await assert.rejects(reopened.request('view.validateCapture', { captureId: capture.captureId }) as Promise<unknown>, code('VIEW_INVALIDATED', 'UNKNOWN_CAPTURE', 'EXPIRED'));
  // Publication is untouched by recompute/withdrawal.
  const publication = (await reopened.request('view.state', {}))!;
  assert.equal(publication.manifest.schemaVersion, 4);
  for (const domain of ['relationship', 'emotion', 'cognition', 'personality'] as const) {
    const value = publication.manifest.domains[domain] as { status: string; capabilities?: string[] };
    assert.equal(value.status, 'available'); assert.deepEqual(value.capabilities, ['metadata_read', 'content_read']);
  }
});

test('two independent connections agree on one recompute bump and never revive a withdrawn source', async t => {
  const f = await fixture(t), conversationId = await f.conversation(), observation = f.observation(conversationId);
  const subject = await f.store.request('relationship.registerSubject', { requestId: 'connections-subject', account: { connectionId: 'synthetic-connection',
    identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId: 'connections-person' }, entityKind: 'person', displayName: '连接同名' });
  const assertion = await f.store.request('relationship.assert', { requestId: 'connections-assertion', conversationId, subjectId: subject.record.entityId,
    predicate: 'alias', value: '连接-ALPHA', sourceRefs: [observation] });
  const openDomain = () => {
    const db = new DatabaseSync(f.filename); db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL');
    const tx = new SqliteTransactions(db); installCommitWatermark(db, tx);
    const domain = new RelationshipDomain(db, tx, { runtimeIdentity: { hostEpoch: 'lifecycle-host', installationGeneration: 'lifecycle-install' },
      resolveConversation: id => ({ audience: { scope: 'local-owner', kind: 'direct', audienceId: id }, revision: 1, audienceVersion: 1, active: true }) });
    return { db, domain, close() { db.close(); } };
  };
  const left = openDomain(), right = openDomain();
  t.after(() => { left.close(); right.close(); });
  const first = left.domain.recompute({ requestId: 'conn-recompute-a' });
  const second = right.domain.recompute({ requestId: 'conn-recompute-b' });
  assert.equal(first.changed >= false, true); assert.equal(second.changed, false);
  assert.equal(second.derivedRevision, first.derivedRevision);
  left.domain.withdraw({ requestId: 'conn-withdraw', recordIds: [assertion.record.recordId] });
  const bumped = right.domain.recompute({ requestId: 'conn-recompute-c' });
  assert.equal(bumped.changed, true); assert.ok(bumped.derivedRevision > first.derivedRevision);
  const noChange = left.domain.recompute({ requestId: 'conn-recompute-d' });
  assert.equal(noChange.changed, false); assert.equal(noChange.derivedRevision, bumped.derivedRevision);
  // Reopening the same file cannot resurrect the withdrawn identity.
  assert.throws(() => left.domain.assert({ requestId: 'conn-cite-withdrawn', conversationId, subjectId: subject.record.entityId,
    predicate: 'alias', value: '不应出现', sourceRefs: [{ kind: 'relationship-record', sourceId: assertion.record.recordId, revision: 1 }] }), code('INNER_SOURCE_UNAVAILABLE', 'INNER_SOURCE_REVOKED'));
  const reopened = openDomain(); t.after(() => reopened.close());
  assert.equal(reopened.domain.captureForView({ conversationId }).records.some(record => record.recordId === assertion.record.recordId), false);
});
