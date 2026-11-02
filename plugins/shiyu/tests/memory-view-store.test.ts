import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { syntheticLocalNoteBinding, observeSyntheticLocalNote } from './helpers/capability.js';
import { CONVERSATION_BACKGROUND_HANDLER } from '../src/adapters/control-store/conversation-domain.js';
import type { LocalReplyNativeBinding } from '../src/adapters/control-store/local-reply-domain.js';
import { sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { OMBRE_HARRIER_PROFILE_FINGERPRINT, type SemanticBackendStatus } from '../src/contracts/semantic-memory.js';
import type { AvailableMemoryDomain, UnavailableDomain } from '../src/state/publication.js';
import { createLocalReadView } from '../src/views/local.js';

const body = 'Worker fixture memory body stays exclusively in the fake native backend.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const code = (...values: string[]) => (error: unknown) => error instanceof Error && 'code' in error && values.includes(String(error.code));
const availability = (semantic = false): AvailableMemoryDomain => ({ status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a',
  capabilities: semantic ? ['exact_read', 'semantic_search'] : ['exact_read'], ...(semantic ? { profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT } : {}) });
const backendStatus = (): SemanticBackendStatus => ({ schemaVersion: 2, backendId: 'ombre-local', deploymentId: 'deployment-a', scope: 'local-owner',
  semanticApi: true, profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT, indexBaselineId: `index_${'a'.repeat(32)}`, indexWatermark: 0,
  recordedIndexedCount: 0, embeddingConfigured: true,
  limits: { maxEligibleRefs: 128, maxScannedRows: 2048, maxResults: 10, maxEmbeddingCallsPerIndex: 2, maxDeadlineMs: 60000 } });
async function fixture(t: TestContext, configured = true) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-memory-view-store-')), filename = join(directory, 'control.sqlite'), stores: ControlStore[] = [];
  const open = async (memory = configured, hostEpoch = 'host-a') => {
    const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [CONVERSATION_BACKGROUND_HANDLER],
      runtimeIdentity: { hostEpoch, installationGeneration: 'install-a' }, localNoteBinding: syntheticLocalNoteBinding('install-a'), ...(memory ? { memoryBackend: { backendId: 'ombre-local', deploymentId: 'deployment-a' } } : {}) });
    stores.push(store);
    await observeSyntheticLocalNote(store, { hostEpoch, installationGeneration: 'install-a' });
    return store;
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
  const store = await open();
  const publish = async (value: UnavailableDomain | AvailableMemoryDomain, requestId = randomUUID()) => {
    const old = (await store.request('view.state', {}))!;
    return store.request('state.publishMemoryAvailability', { requestId, expectedBaselineId: old.baselineId, expectedStateVersion: old.stateVersion, availability: value });
  };
  const associated = async (key = 'primary') => {
    const { task } = await store.request('task.createLocal', { requestId: `task-${key}`, title: 'Synthetic task', content: 'Task fixture artifact.' });
    const entry = await store.request('conversation.ensureLocalTask', { taskId: task.taskId, localConversationKey: key }); return { task, entry };
  };
  const save = async (conversationId: string) => {
    const value = memoryBodyDigest(body), entry = await store.request('memory.prepareLocal', { requestId: randomUUID(), conversationId, bodyDigest: value.bodyDigest, bytes: value.bodyBytes });
    const operationId = entry.operation.operationId, plan = (await store.request('memory.claim', { operationId }))!;
    const observed: MemoryBackendObservation = { command: entry.command, commandDigest: memoryCommandDigest(entry.command), deploymentId: 'deployment-a',
      nativeId: `shiyu_${sha(operationId).slice(0, 32)}`, receiptId: `receipt_${sha(operationId)}`, componentVersion: `sha256:${sha(body)}`,
      bodyDigest: entry.command.bodyDigest, bodyBytes: entry.command.bodyBytes, sourceRefs: entry.command.sourceRefs, observedAt: new Date().toISOString() };
    await store.request('memory.recordVerifiedReceipt', { operationId, claim: plan.claim, observation: observed, reconciliation: false });
    return { operationId, observed };
  };
  const bind = async (conversationId: string, taskId: string, memoryOperationId: string) => {
    const { operation } = await store.request('conversation.reply.admit', { conversationId, inputId: randomUUID(), inputHash: sha('fixture query') });
    const capture = await store.request('view.captureLocal', { conversationId, purpose: 'reply_context', memoryOperationIds: [memoryOperationId] });
    const prepared = await store.request('conversation.reply.prepare', { operationId: operation.operationId, captureId: capture.captureId,
      viewId: randomUUID(), loadedTaskIds: [taskId], loadedMemoryOperationIds: [memoryOperationId] });
    const binding: LocalReplyNativeBinding = { operationId: prepared.operationId, contextTokenId: prepared.contextTokenId!, sessionEpoch: prepared.sessionEpoch,
      key: sessionBindingKey('replyer', prepared.businessId, prepared.scope), businessId: prepared.businessId, scope: prepared.scope,
      sessionId: 'native-fixture-session', messageId: randomUUID(), messageHash: sha('fixture prompt') };
    await store.request('conversation.reply.bind', { binding }); return { prepared, binding, capture };
  };
  return { store, open, filename, publish, associated, save, bind };
}

test('Worker availability publishing is private, deployment bound, CAS protected and separate from reads', async t => {
  const f = await fixture(t), initial = (await f.store.request('view.state', {}))!, before = await f.store.request('control.watermark', {});
  assert.equal(initial.manifest.schemaVersion, 4); assert.equal(initial.stateVersion, 3);
  assert.equal(initial.manifest.domains.ability.status, 'available');
  assert.deepEqual(await f.store.request('memory.status', {}), { configured: true, ready: true });
  assert.deepEqual(await f.store.request('memory.index.status', {}), { configured: true, ready: true });
  for (let i = 0; i < 3; i++) await f.store.request('view.state', {});
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
  const command = { requestId: 'startup', expectedBaselineId: initial.baselineId, expectedStateVersion: initial.stateVersion, availability: availability() };
  for (const patch of [{ publisher: { principalId: 'shiyu-state-service' } }, { manifest: {} }, { actor: 'owner' }]) {
    await assert.rejects(f.store.request('state.publishMemoryAvailability', { ...command, ...patch } as never), code('INVALID_SCHEMA'));
  }
  await assert.rejects(f.publish({ ...availability(), deploymentId: 'foreign' }), code('MEMORY_DEPLOYMENT_MISMATCH'));
  const published = await f.store.request('state.publishMemoryAvailability', command);
  assert.equal(published.publication.stateVersion, initial.stateVersion + 1); assert.equal(published.publication.manifest.schemaVersion, 4);
  assert.deepEqual(published.publication.manifest.domains.ability, initial.manifest.domains.ability);
  // The four inner domains were published by the Worker itself; memory/ability updates must not downgrade them.
  for (const domain of ['relationship', 'emotion', 'cognition', 'personality'] as const) assert.equal(published.publication.manifest.domains[domain].status, 'available');
  assert.deepEqual(await f.store.request('state.publishMemoryAvailability', command), published);
  await assert.rejects(f.store.request('state.publishMemoryAvailability', { ...command, requestId: 'stale' }), code('VERSION_CONFLICT'));
  const semantic = await f.publish(availability(true)); assert.equal(semantic.publication.stateVersion, initial.stateVersion + 2);
  const stopped = await f.publish({ status: 'unavailable', reason: 'source_unavailable' }); assert.equal(stopped.publication.stateVersion, initial.stateVersion + 3);
  assert.deepEqual(await f.store.request('state.publishMemoryAvailability', command), published);
  const unconfigured = await fixture(t, false);
  await assert.rejects(unconfigured.publish(availability()), code('MEMORY_UNCONFIGURED'));
  await assert.rejects(unconfigured.store.request('memory.index.get', { indexOperationId: 'guessed' }), code('MEMORY_INDEX_UNCONFIGURED'));
});

test('real Worker supplies authorized memory capture and transient exact body without control writes', async t => {
  const f = await fixture(t), { entry } = await f.associated(), saved = await f.save(entry.conversationId); await f.publish(availability());
  const before = await f.store.request('control.watermark', {}), pool = await f.store.request('memory.listEligibleForView', { conversationId: entry.conversationId });
  const capture = await f.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', memoryOperationIds: [saved.operationId] });
  assert.deepEqual(capture.memory!.sources, pool.sources); assert.equal(JSON.stringify(capture).includes(body), false);
  assert.deepEqual(await f.store.request('memory.validateForView', { snapshot: capture.memory! }), capture.memory);
  assert.deepEqual(await f.store.request('memory.validateExposedSources', { sources: capture.memory!.sources }), { valid: true });
  const local = createLocalReadView(capture, { validate: captureId => f.store.request('view.validateCapture', { captureId }), memoryRead: async () => ({ body, observation: saved.observed }) });
  t.after(() => local.close()); const view = await local.read(); await local.assertCurrent(view.viewId);
  assert.equal(view.freshness.status, 'current'); assert.equal(view.data.find(item => item.backendId === 'native-memory')!.fields.text, body);
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
  const db = new DatabaseSync(f.filename, { readOnly: true });
  try { for (const table of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table.name}`).all()).includes(body), false); }
  finally { db.close(); }
});

test('real Worker withdrawal retires a possibly exposed native epoch atomically before any acknowledgement', async t => {
  const f = await fixture(t), { task, entry } = await f.associated(), saved = await f.save(entry.conversationId); await f.publish(availability());
  const { prepared, binding, capture } = await f.bind(entry.conversationId, task.taskId, saved.operationId);
  const withdrawn = await f.store.request('memory.withdrawLocal', { requestId: 'withdraw-exposed', operationId: saved.operationId });
  assert.equal(withdrawn.source.consent.state, 'withdrawn');
  assert.deepEqual(withdrawn.contextInvalidation!.conversationIds, [entry.conversationId]);
  assert.deepEqual(withdrawn.contextInvalidation!.retiredSessions, [{ bindingId: entry.bindingId, sessionEpoch: prepared.sessionEpoch, businessId: prepared.businessId, sessionId: binding.sessionId }]);
  const after = (await f.store.request('conversation.snapshotLocal', { conversationId: entry.conversationId })).conversations[0];
  assert.equal(after.sessionEpoch, prepared.sessionEpoch + 1);
  await assert.rejects(f.store.request('view.validateCapture', { captureId: capture.captureId, phase: 'ack' }), code('VIEW_INVALIDATED', 'STALE_CONTEXT'));
  await assert.rejects(f.store.request('conversation.reply.contextDurable', { receipt: { ...binding, userMessageSeq: 4, confirmedAt: new Date().toISOString(), durability: 'confirmed' } }), code('STALE_CONTEXT', 'VIEW_INVALIDATED'));
  const next = await f.store.request('conversation.reply.admit', { conversationId: entry.conversationId, inputId: 'after-withdrawal', inputHash: sha('new input') });
  assert.equal(next.operation.expectedSessionId, undefined); assert.notEqual(next.operation.businessId, prepared.businessId);
  assert.equal((await f.store.request('conversation.reply.get', { operationId: prepared.operationId })).durability, 'unconfirmed');
});

test('out-of-band trigger changes quarantine the Worker before withdrawal can alter the native epoch', async t => {
  const f = await fixture(t), { task, entry } = await f.associated(), saved = await f.save(entry.conversationId); await f.publish(availability());
  const { prepared } = await f.bind(entry.conversationId, task.taskId, saved.operationId);
  const before = await f.store.request('memory.readLocal', { operationId: saved.operationId }), watermark = await f.store.request('control.watermark', {});
  const db = new DatabaseSync(f.filename);
  try { db.exec("CREATE TRIGGER deny_retirement BEFORE INSERT ON shiyu_local_reply_memory_withdrawals BEGIN SELECT RAISE(ABORT,'synthetic retirement failure'); END"); }
  finally { db.close(); }
  await assert.rejects(f.store.request('memory.withdrawLocal', { requestId: 'withdraw-fails', operationId: saved.operationId }), code('STORE_ISOLATED'));
  await assert.rejects(f.store.request('memory.readLocal', { operationId: saved.operationId }), code('STORE_ISOLATED'));
  await f.store.close(); const repair = new DatabaseSync(f.filename);
  try {
    repair.exec('DROP TRIGGER deny_retirement');
    const persisted = repair.prepare('SELECT commit_seq,baseline_id FROM shiyu_commit_watermark').get()!;
    assert.equal(persisted.commit_seq, watermark.commitSeq); assert.equal(persisted.baseline_id, watermark.baselineId);
  } finally { repair.close(); }
  const reopened = await f.open();
  assert.deepEqual(await reopened.request('memory.readLocal', { operationId: saved.operationId }), before);
  assert.equal((await reopened.request('conversation.snapshotLocal', { conversationId: entry.conversationId })).conversations[0].sessionEpoch, prepared.sessionEpoch);
});

test('historical exposed memory is revalidated even for a later Task-only round after Worker restart', async t => {
  const f = await fixture(t), { task, entry } = await f.associated(), saved = await f.save(entry.conversationId); await f.publish(availability());
  const { prepared, binding } = await f.bind(entry.conversationId, task.taskId, saved.operationId);
  await f.store.request('conversation.reply.contextDurable', { receipt: { ...binding, userMessageSeq: 4, confirmedAt: new Date().toISOString(), durability: 'confirmed' } });
  await f.store.request('conversation.reply.ready', { operationId: prepared.operationId, assistantRef: { sessionId: binding.sessionId, eventSeq: 5, messageId: 'assistant-fixture' } });
  await f.store.close(); const noMemory = await f.open(false, 'host-b');
  await assert.rejects(noMemory.request('conversation.reply.admit', { conversationId: entry.conversationId, inputId: 'task-only-next', inputHash: sha('new question') }), code('MEMORY_UNCONFIGURED'));
  await noMemory.close(); const restored = await f.open(true, 'host-c');
  const next = await restored.request('conversation.reply.admit', { conversationId: entry.conversationId, inputId: 'restored-next', inputHash: sha('new question') });
  assert.equal(next.operation.expectedSessionId, binding.sessionId); assert.equal(next.operation.sessionEpoch, prepared.sessionEpoch);
});

test('real Worker routes controlled index commands and never replays an unknown index effect across restart', async t => {
  const f = await fixture(t), { entry } = await f.associated(), saved = await f.save(entry.conversationId);
  const prepared = await f.store.request('memory.index.prepare', { requestId: 'index-a', operationId: saved.operationId, backendStatus: backendStatus(), deadlineAtMs: Date.now() + 60000 });
  const indexOperationId = prepared.entry.indexOperationId, plan = (await f.store.request('memory.index.claim', { indexOperationId }))!;
  assert.equal(plan.entry.effect.status, 'dispatching');
  assert.equal((await f.store.request('memory.index.assertDispatch', { indexOperationId, claim: plan.claim })).command.memoryOperationId, saved.operationId);
  const unknown = await f.store.request('memory.index.markUnknown', { indexOperationId, claim: plan.claim, reasonCode: 'SYNTHETIC_DISCONNECT' });
  assert.equal(unknown.effect.status, 'unknown'); assert.equal(unknown.reservation.state, 'unknown'); assert.equal(unknown.embeddingUsage.complete, false);
  assert.equal(await f.store.request('memory.index.claim', { indexOperationId }), undefined);
  await f.store.close(); const reopened = await f.open(true, 'host-b');
  assert.equal((await reopened.request('memory.index.get', { indexOperationId })).effect.status, 'unknown');
  assert.equal(await reopened.request('memory.index.claim', { indexOperationId }), undefined);
  const db = new DatabaseSync(f.filename, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shiyu_effect_attempts WHERE effect_id=?').get(plan.claim.effectId)!.n, 1); }
  finally { db.close(); }
});
