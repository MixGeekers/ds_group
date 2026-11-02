import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { CONVERSATION_BACKGROUND_HANDLER } from '../src/adapters/control-store/conversation-domain.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { syntheticLocalNoteBinding, observeSyntheticLocalNote } from './helpers/capability.js';
import { createLocalReadView } from '../src/views/local.js';
import type { InnerBodyReadOutput } from '../src/adapters/control-store/view-domain.js';

const code = (...codes: string[]) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
interface OpenPatch { identity?: boolean; binding?: boolean; memory?: boolean; hostEpoch?: string; installationGeneration?: string }
async function fixture(t: TestContext, config: OpenPatch = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-inner-view-')), filename = join(directory, 'control.sqlite'), stores: ControlStore[] = [];
  const open = async (patch: OpenPatch = {}) => {
    const installationGeneration = patch.installationGeneration ?? 'inner-install';
    const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [CONVERSATION_BACKGROUND_HANDLER],
      ...(patch.identity === false ? {} : { runtimeIdentity: { hostEpoch: patch.hostEpoch ?? 'inner-host', installationGeneration } }),
      ...(patch.binding === false ? {} : { localNoteBinding: syntheticLocalNoteBinding(installationGeneration) }),
      ...(patch.memory ? { memoryBackend: { backendId: 'ombre-local', deploymentId: 'deployment-a' } } : {}) });
    stores.push(store);
    if (patch.binding !== false) await observeSyntheticLocalNote(store, { hostEpoch: patch.hostEpoch ?? 'inner-host', installationGeneration });
    return store;
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close().catch(() => undefined))); await rm(directory, { recursive: true, force: true }); });
  const store = await open(config);
  const dm = async () => {
    const { task } = await store.request('task.createLocal', { requestId: `task-${randomUUID()}`, title: '合成内层任务', content: 'SYNTHETIC-INNER-ARTIFACT' });
    return { task, entry: await store.request('conversation.ensureLocalTask', { taskId: task.taskId, localConversationKey: 'dm' }) };
  };
  const group = async () => store.request('conversation.ensureLabChannel', { connectionId: 'synthetic-lab', runId: 'run-inner', channelId: 'group-inner',
    kind: 'group', membersDigest: 'b'.repeat(64) });
  const observation = (conversationId: string) => ({ kind: 'conversation-observation' as const, sourceId: conversationId, revision: 1 });
  const saveMemory = async (conversationId: string) => {
    const body = '合成记忆正文，只保存在假原生后端。', value = memoryBodyDigest(body);
    const entry = await store.request('memory.prepareLocal', { requestId: randomUUID(), conversationId, bodyDigest: value.bodyDigest, bytes: value.bodyBytes });
    const operationId = entry.operation.operationId, plan = (await store.request('memory.claim', { operationId }))!;
    const observed: MemoryBackendObservation = { command: entry.command, commandDigest: memoryCommandDigest(entry.command), deploymentId: 'deployment-a',
      nativeId: `shiyu_${sha(operationId).slice(0, 32)}`, receiptId: `receipt_${sha(operationId)}`, componentVersion: `sha256:${sha(body)}`,
      bodyDigest: entry.command.bodyDigest, bodyBytes: entry.command.bodyBytes, sourceRefs: entry.command.sourceRefs, observedAt: new Date().toISOString() };
    await store.request('memory.recordVerifiedReceipt', { operationId, claim: plan.claim, observation: observed, reconciliation: false });
    return { operationId, body, entry };
  };
  return { ...{ store, open, filename, stores }, dm, group, observation, saveMemory, directory };
}

test('the real Worker publishes schema4 only for domains it actually instantiated', async t => {
  const f = await fixture(t), state = (await f.store.request('view.state', {}))!;
  assert.equal(state.manifest.schemaVersion, 4);
  assert.equal(state.stateVersion, 3); // initial schema1 + ability schema3 + inner-domain schema4
  for (const [domain, backendId] of [['relationship', 'control-relationship'], ['emotion', 'control-emotion'], ['cognition', 'control-cognition'], ['personality', 'control-personality']] as const) {
    const value = state.manifest.domains[domain] as { status: string; backendId?: string; capabilities?: readonly string[]; authorityId?: string };
    assert.equal(value.status, 'available');
    if (value.status === 'available') { assert.equal(value.backendId, backendId); assert.deepEqual(value.capabilities, ['metadata_read', 'content_read']); assert.match(value.authorityId ?? "", /^[a-f0-9-]{36}$/); }
    assert.deepEqual(await f.store.request(`${domain}.status` as never, {} as never), { configured: true, ready: true });
  }
  assert.equal(state.manifest.domains.ability.status, 'available');
  assert.deepEqual(state.manifest.domains.memory, { status: 'unavailable', reason: 'not_connected' });
});

test('real Worker captures inner metadata, validates freshly and reads bodies only on a second call', async t => {
  const f = await fixture(t), { entry } = await f.dm();
  const entity = await f.store.request('relationship.registerSubject', { requestId: 'worker-subject', account: {
    connectionId: 'synthetic-lab', identityNamespace: 'lab', identityType: 'member', externalSubjectId: 'worker-person' }, entityKind: 'person', displayName: '工作同名' });
  const assertion = await f.store.request('relationship.assert', { requestId: 'worker-assertion', conversationId: entry.conversationId,
    subjectId: entity.record.entityId, predicate: 'interaction', value: 'message-exchange', sourceRefs: [f.observation(entry.conversationId)] });
  const before = await f.store.request('control.watermark', {});
  const capture = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  assert.ok(capture.inner?.domains.relationship);
  assert.equal(JSON.stringify(capture).includes('message-exchange'), false);
  assert.deepEqual(capture.access.authority!.inner!.relationship!.authorityId, capture.inner!.domains.relationship!.authority.authorityId);
  assert.deepEqual(capture.access.components.map(component => component.backendId), ['control-task', 'control-relationship']);
  const recordIds = capture.inner!.domains.relationship!.records.map(record => record.recordId);
  assert.ok(recordIds.includes(assertion.record.recordId));
  await assert.rejects(f.store.request('view.readInnerBodies', { captureId: capture.captureId, domain: 'relationship', recordIds: ['forged:record'] }), code('INNER_BODY_FORBIDDEN'));
  const bodies = await f.store.request('view.readInnerBodies', { captureId: capture.captureId, domain: 'relationship', recordIds: [assertion.record.recordId] });
  assert.equal((bodies.bodies[0]!.payload as Record<string, unknown>).value, 'message-exchange');
  assert.deepEqual(await f.store.request('view.validateCapture', { captureId: capture.captureId }), capture);
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
  // A real correction invalidates the pinned metadata; the body command fails explicitly.
  const revised = await f.store.request('relationship.reviseAssertion', { requestId: 'worker-correction', conversationId: entry.conversationId,
    assertionId: assertion.record.assertionId, expectedRevision: 1, predicate: 'interaction', value: 'call', sourceRefs: [f.observation(entry.conversationId)] });
  assert.equal(revised.record.revision, 2);
  await assert.rejects(f.store.request('view.validateCapture', { captureId: capture.captureId }), code('VIEW_INVALIDATED'));
  await assert.rejects(f.store.request('view.readInnerBodies', { captureId: capture.captureId, domain: 'relationship', recordIds: [assertion.record.recordId] }), code('VIEW_INVALIDATED'));
  const next = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  const nextBodies = await f.store.request('view.readInnerBodies', { captureId: next.captureId, domain: 'relationship', recordIds: [revised.record.recordId] });
  assert.equal((nextBodies.bodies[0]!.payload as Record<string, unknown>).value, 'call');
});

test('inner-domain views are read-only: neither captures nor body reads advance the control watermark', async t => {
  const f = await fixture(t), { entry } = await f.dm();
  await f.store.request('emotion.observe', { requestId: 'purity-emotion', conversationId: entry.conversationId, valenceBps: 6000, arousalBps: 3000,
    label: 'positive', sourceRefs: [f.observation(entry.conversationId)] });
  const before = await f.store.request('control.watermark', {});
  for (let round = 0; round < 10; round++) {
    const capture = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['emotion'] });
    await f.store.request('view.validateCapture', { captureId: capture.captureId });
    const records = capture.inner!.domains.emotion!.records;
    await f.store.request('view.readInnerBodies', { captureId: capture.captureId, domain: 'emotion', recordIds: records.map(record => record.recordId) });
    await f.store.request('view.state', {});
    await f.store.request('emotion.state', { conversationId: entry.conversationId });
  }
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
  const db = new DatabaseSync(f.filename, { readOnly: true });
  try {
    const relationshipMeta = Number(db.prepare('SELECT count(*) AS n FROM shiyu_relationship_meta').get()!.n);
    const emotionMeta = Number(db.prepare('SELECT count(*) AS n FROM shiyu_emotion_meta').get()!.n);
    assert.equal(relationshipMeta + emotionMeta, 2);
  }
  finally { db.close(); }
});

test('inner-domain capture selection is bounded, reply-context-only and never accepts caller authority', async t => {
  const f = await fixture(t), { entry } = await f.dm();
  await assert.rejects(f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'task_status', innerDomains: ['relationship'] } as never), code('INVALID_SCHEMA'));
  for (const innerDomains of [[], ['relationship', 'relationship'], ['relationship', 'unknown'], ['relationship', 'emotion', 'cognition', 'personality', 'relationship']]) {
    await assert.rejects(f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains } as never), code('INVALID_SCHEMA'));
  }
  for (const extra of [{ principal: 'owner' }, { actor: { principalId: 'owner' } }, { scope: 'private' }, { authority: {} }, { recordIds: [] }]) {
    await assert.rejects(f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'], ...extra } as never), code('INVALID_SCHEMA'));
  }
});

test('a direct-message inner fact never enters a group capture and cannot be body-read through it', async t => {
  const f = await fixture(t), dm = await f.dm(), group = await f.group();
  assert.notEqual(dm.entry.conversationId, group.conversationId);
  const entity = await f.store.request('relationship.registerSubject', { requestId: 'audience-subject', account: {
    connectionId: 'synthetic-lab', identityNamespace: 'lab', identityType: 'member', externalSubjectId: 'audience-person' }, entityKind: 'person', displayName: '受众同名' });
  const dmFact = await f.store.request('relationship.assert', { requestId: 'dm-fact', conversationId: dm.entry.conversationId, subjectId: entity.record.entityId,
    predicate: 'interaction', value: 'message-exchange', sourceRefs: [f.observation(dm.entry.conversationId)] });
  const groupCapture = await f.store.request('view.captureLocal', { conversationId: group.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  const groupRecords = groupCapture.inner!.domains.relationship!.records.map(record => record.recordId);
  assert.equal(groupRecords.includes(dmFact.record.recordId), false);
  await assert.rejects(f.store.request('view.readInnerBodies', { captureId: groupCapture.captureId, domain: 'relationship', recordIds: [dmFact.record.recordId] }), code('INNER_BODY_FORBIDDEN'));
  const dmCapture = await f.store.request('view.captureLocal', { conversationId: dm.entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  assert.ok(dmCapture.inner!.domains.relationship!.records.some(record => record.recordId === dmFact.record.recordId));
});

test('withdrawing a memory source that supported an inner fact degrades the view instead of silently keeping it', async t => {
  const f = await fixture(t, { memory: true }), dm = await f.dm();
  const memory = await f.saveMemory(dm.entry.conversationId);
  const entity = await f.store.request('relationship.registerSubject', { requestId: 'memory-backed-subject', account: {
    connectionId: 'synthetic-lab', identityNamespace: 'lab', identityType: 'member', externalSubjectId: 'memory-backed-person' }, entityKind: 'person', displayName: '记忆同名' });
  const assertion = await f.store.request('relationship.assert', { requestId: 'memory-backed-fact', conversationId: dm.entry.conversationId,
    subjectId: entity.record.entityId, predicate: 'interaction', value: 'call',
    sourceRefs: [f.observation(dm.entry.conversationId), { kind: 'memory-operation', sourceId: memory.operationId, revision: 1 }] });
  const capture = await f.store.request('view.captureLocal', { conversationId: dm.entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  assert.equal(capture.inner!.domains.relationship!.records.find(record => record.recordId === assertion.record.recordId)!.evidenceState, 'valid');
  await f.store.request('memory.withdrawLocal', { requestId: 'withdraw-memory-source', operationId: memory.operationId });
  await assert.rejects(f.store.request('view.validateCapture', { captureId: capture.captureId }), code('VIEW_INVALIDATED'));
  const after = await f.store.request('view.captureLocal', { conversationId: dm.entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  assert.equal(after.inner!.domains.relationship!.records.find(record => record.recordId === assertion.record.recordId)!.evidenceState, 'degraded');
  const degradedBodies = await f.store.request('view.readInnerBodies', { captureId: after.captureId, domain: 'relationship', recordIds: [assertion.record.recordId] });
  assert.equal((degradedBodies.bodies[0]!.payload as Record<string, unknown>).value, 'call');
  await f.store.request('relationship.withdraw', { requestId: 'withdraw-remaining-source', evidenceRefs: [f.observation(dm.entry.conversationId), { kind: 'memory-operation', sourceId: memory.operationId, revision: 1 }] });
  const revoked = await f.store.request('view.captureLocal', { conversationId: dm.entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  assert.equal(revoked.inner!.domains.relationship!.records.find(record => record.recordId === assertion.record.recordId)!.evidenceState, 'revoked');
  await assert.rejects(f.store.request('view.readInnerBodies', { captureId: revoked.captureId, domain: 'relationship', recordIds: [assertion.record.recordId] }), code('INNER_BODY_FORBIDDEN'));
});

test('a failed domain initialization is published as unavailable and its commands fail explicitly', async t => {
  const first = await fixture(t);
  await first.store.close();
  const db = new DatabaseSync(first.filename);
  try {
    const tx = new SqliteTransactions(db);
    installCommitWatermark(db, tx);
    tx.atomic(() => { db.exec('DELETE FROM shiyu_personality_meta'); });
  } finally { db.close(); }
  const reopened = await first.open();
  const state = (await reopened.request('view.state', {}))!;
  assert.equal(state.manifest.schemaVersion, 4);
  assert.equal(state.manifest.domains.personality.status, 'unavailable');
  assert.deepEqual(state.manifest.domains.relationship.status, 'available');
  const status = await reopened.request('personality.status', {});
  assert.deepEqual(status, { configured: true, ready: false, errorCode: 'CORRUPT_INNER_DOMAIN' });
  const dm = await reopened.request('task.createLocal', { requestId: 'unavailable-task', title: '合成任务', content: 'ARTIFACT' })
    .then(async task => reopened.request('conversation.ensureLocalTask', { taskId: task.task.taskId, localConversationKey: 'unavailable-dm' }));
  await assert.rejects(reopened.request('view.captureLocal', { conversationId: dm.conversationId, purpose: 'reply_context', innerDomains: ['personality'] }), code('INNER_DOMAIN_UNAVAILABLE'));
  await assert.rejects(reopened.request('personality.snapshot', { conversationId: dm.conversationId }), code('CORRUPT_INNER_DOMAIN'));
});

test('an event-only store exposes no inner-domain read capability at all', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-inner-event-only-')), filename = join(directory, 'control.sqlite');
  const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [CONVERSATION_BACKGROUND_HANDLER] });
  t.after(async () => { await store.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await store.request('relationship.status', {}), { configured: false, ready: false });
  await assert.rejects(store.request('relationship.captureForView', { conversationId: 'guessed' }), code('RELATIONSHIP_UNAVAILABLE'));
  await assert.rejects(store.request('view.state', {}), code('VIEWS_UNAVAILABLE'));
});

test('restart keeps domain reads and publication but never revives a Worker capture', async t => {
  const f = await fixture(t), dm = await f.dm();
  const entity = await f.store.request('relationship.registerSubject', { requestId: 'restart-subject', account: {
    connectionId: 'synthetic-lab', identityNamespace: 'lab', identityType: 'member', externalSubjectId: 'restart-person' }, entityKind: 'person', displayName: '重启同名' });
  const assertion = await f.store.request('relationship.assert', { requestId: 'restart-fact', conversationId: dm.entry.conversationId, subjectId: entity.record.entityId,
    predicate: 'interaction', value: 'meeting', sourceRefs: [f.observation(dm.entry.conversationId)] });
  const capture = await f.store.request('view.captureLocal', { conversationId: dm.entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  const publication = capture.publication;
  await f.store.close(); const reopened = await f.open();
  assert.deepEqual(await reopened.request('view.state', {}), publication);
  await assert.rejects(reopened.request('view.validateCapture', { captureId: capture.captureId }), code('UNKNOWN_CAPTURE'));
  const next = await reopened.request('view.captureLocal', { conversationId: dm.entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  assert.ok(next.inner!.domains.relationship!.records.some(record => record.recordId === assertion.record.recordId));
  const bodies = await reopened.request('view.readInnerBodies', { captureId: next.captureId, domain: 'relationship', recordIds: [assertion.record.recordId] });
  assert.equal((bodies.bodies[0]!.payload as Record<string, unknown>).value, 'meeting');
  const stale = JSON.stringify(capture.inner);
  assert.equal(stale.includes('meeting'), false);
});

test('the replyer local read view composes captured inner domains and reads bodies only after trimming', async t => {
  const f = await fixture(t), { entry } = await f.dm();
  const entity = await f.store.request('relationship.registerSubject', { requestId: 'readview-subject', account: {
    connectionId: 'synthetic-lab', identityNamespace: 'lab', identityType: 'member', externalSubjectId: 'readview-person' }, entityKind: 'person', displayName: '读取同名' });
  const assertion = await f.store.request('relationship.assert', { requestId: 'readview-fact', conversationId: entry.conversationId,
    subjectId: entity.record.entityId, predicate: 'interaction', value: 'meeting', sourceRefs: [f.observation(entry.conversationId)] });
  const capture = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  const watermarkBefore = await f.store.request('control.watermark', {});
  const requested: string[][] = [];
  const local = createLocalReadView(capture, { validate: captureId => f.store.request('view.validateCapture', { captureId }),
    innerRead: async (domain, captured, recordIds): Promise<InnerBodyReadOutput> => {
      requested.push([domain, ...recordIds]);
      assert.equal(JSON.stringify(captured).includes('"body"'), false);
      return f.store.request('view.readInnerBodies', { captureId: capture.captureId, domain, recordIds: [...recordIds] });
    } });
  t.after(() => local.close());
  const view = await local.read();
  assert.equal(view.freshness.status, 'current');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]![0], 'relationship');
  const capturedIds = capture.inner!.domains.relationship!.records.map(record => record.recordId);
  assert.deepEqual([...requested[0]!.slice(1)].sort(), [...capturedIds].sort());
  const rows = view.data.filter(row => row.backendId === 'control-relationship');
  assert.equal(rows.length, capturedIds.length);
  const assertionRow = rows.find(row => row.recordId === assertion.record.recordId)!;
  assert.equal((assertionRow.fields.body as Record<string, unknown>).value, 'meeting');
  assert.equal(assertionRow.fields.kind, 'assertion');
  assert.equal(view.authority!.inner!.relationship!.authorityId, capture.inner!.domains.relationship!.authority.authorityId);
  assert.equal(view.components.find(component => component.backendId === 'control-relationship')!.freshness.status, 'current');
  await local.assertCurrent(view.viewId);
  // GET-style reads (metadata capture, body read, re-authorization) never write.
  assert.deepEqual(await f.store.request('control.watermark', {}), watermarkBefore);
});

test('an inner-domain capture without an exact body reader is an explicit unavailable component', async t => {
  const f = await fixture(t), { entry } = await f.dm();
  await f.store.request('emotion.observe', { requestId: 'unavailable-emotion', conversationId: entry.conversationId, valenceBps: 6000,
    arousalBps: 3000, label: 'positive', sourceRefs: [f.observation(entry.conversationId)] });
  const capture = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['emotion'] });
  const local = createLocalReadView(capture, { validate: captureId => f.store.request('view.validateCapture', { captureId }) });
  t.after(() => local.close());
  const view = await local.read();
  assert.equal(view.freshness.status, 'unavailable');
  assert.deepEqual(view.data.filter(row => row.backendId === 'control-emotion'), []);
  assert.equal(view.components.find(component => component.backendId === 'control-emotion')!.freshness.reason, 'body_not_connected');
});

test('a tampered or authority-less inner capture is refused before any body read', async t => {
  const f = await fixture(t), { entry } = await f.dm();
  await f.store.request('cognition.propose', { requestId: 'tamper-claim', conversationId: entry.conversationId, claimType: 'owner-statement',
    subjectIds: ['entity-a'], predicate: 'prefers-tea', proposition: '合成偏好。', confidenceBps: 7000, sourceRefs: [f.observation(entry.conversationId)] });
  const capture = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['cognition'] });
  const noAuthority = structuredClone(capture); delete noAuthority.access.authority!.inner;
  assert.throws(() => createLocalReadView(noAuthority, { validate: captureId => f.store.request('view.validateCapture', { captureId }) }), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'INVALID_INNER_CAPTURE');
  const noGrant = structuredClone(capture); noGrant.access.components = noGrant.access.components.filter(component => component.backendId !== 'control-cognition');
  assert.throws(() => createLocalReadView(noGrant, { validate: captureId => f.store.request('view.validateCapture', { captureId }) }), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'INVALID_INNER_CAPTURE');
});

test('a corrected inner record invalidates a pinned local view instead of returning the old body', async t => {
  const f = await fixture(t), { entry } = await f.dm();
  const claim = await f.store.request('cognition.propose', { requestId: 'stale-claim', conversationId: entry.conversationId, claimType: 'owner-statement',
    subjectIds: ['entity-a'], predicate: 'prefers-tea', proposition: '旧结论。', confidenceBps: 7000, sourceRefs: [f.observation(entry.conversationId)] });
  const capture = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['cognition'] });
  const local = createLocalReadView(capture, { validate: captureId => f.store.request('view.validateCapture', { captureId }),
    innerRead: (domain, _captured, recordIds) => f.store.request('view.readInnerBodies', { captureId: capture.captureId, domain, recordIds: [...recordIds] }) });
  t.after(() => local.close());
  await f.store.request('cognition.revise', { requestId: 'stale-revise', conversationId: entry.conversationId, claimId: claim.record.claimId,
    expectedRevision: 1, proposition: '新结论。', confidenceBps: 8000, sourceRefs: [f.observation(entry.conversationId)] });
  // Re-authorization fails before returning either the stale view or a happy-path
  // empty result: the caller can only see an explicit dependency/invalidated error.
  await assert.rejects(local.read(), code('DEPENDENCY_UNAVAILABLE', 'VIEW_INVALIDATED'));
  const fresh = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', innerDomains: ['cognition'] });
  assert.notEqual(JSON.stringify(fresh.inner).includes('旧结论。'), true);
});

test('a group local view never reveals a direct-message inner fact through the composed reader', async t => {
  const f = await fixture(t), dm = await f.dm(), group = await f.group();
  const entity = await f.store.request('relationship.registerSubject', { requestId: 'compose-subject', account: {
    connectionId: 'synthetic-lab', identityNamespace: 'lab', identityType: 'member', externalSubjectId: 'compose-person' }, entityKind: 'person', displayName: '组合同名' });
  const dmFact = await f.store.request('relationship.assert', { requestId: 'compose-dm-fact', conversationId: dm.entry.conversationId, subjectId: entity.record.entityId,
    predicate: 'interaction', value: 'message-exchange', sourceRefs: [f.observation(dm.entry.conversationId)] });
  const groupCapture = await f.store.request('view.captureLocal', { conversationId: group.conversationId, purpose: 'reply_context', innerDomains: ['relationship'] });
  const local = createLocalReadView(groupCapture, { validate: captureId => f.store.request('view.validateCapture', { captureId }),
    innerRead: (domain, _captured, recordIds) => f.store.request('view.readInnerBodies', { captureId: groupCapture.captureId, domain, recordIds: [...recordIds] }) });
  t.after(() => local.close());
  const view = await local.read();
  assert.equal(view.freshness.status, 'current');
  assert.equal(view.data.some(row => row.recordId === dmFact.record.recordId), false);
  assert.doesNotMatch(JSON.stringify(view), /message-exchange/);
});
