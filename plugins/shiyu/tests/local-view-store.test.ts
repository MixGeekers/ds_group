import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { syntheticLocalNoteBinding, observeSyntheticLocalNote } from './helpers/capability.js';
import { CONVERSATION_BACKGROUND_HANDLER } from '../src/adapters/control-store/conversation-domain.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { createLocalReadView } from '../src/views/local.js';

const code = (...codes: string[]) => (error: unknown) => error instanceof Error && 'code' in error && codes.includes(String(error.code));
async function fixture(t: TestContext, withIdentity = true) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-local-view-store-')), filename = join(directory, 'control.sqlite'), stores: ControlStore[] = [];
  const open = async () => {
    const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [CONVERSATION_BACKGROUND_HANDLER],
      ...(withIdentity ? { runtimeIdentity: { hostEpoch: 'synthetic-host', installationGeneration: 'synthetic-install' }, localNoteBinding: syntheticLocalNoteBinding('synthetic-install') } : {}) });
    stores.push(store);
    if (withIdentity) await observeSyntheticLocalNote(store, { hostEpoch: 'synthetic-host', installationGeneration: 'synthetic-install' });
    return store;
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); });
  return { store: await open(), open, filename };
}
async function associated(store: ControlStore) {
  const { task } = await store.request('task.createLocal', { requestId: 'local-view-task', title: 'Synthetic Task status', content: 'CONFIDENTIAL-ARTIFACT-TEXT' });
  const entry = await store.request('conversation.ensureLocalTask', { taskId: task.taskId }); return { task, entry };
}

test('real Worker initializes one honest manifest and serves Task-only ReadView without ack or writes', async t => {
  const { store, filename } = await fixture(t), initial = await store.request('view.state', {});
  assert.equal(initial!.stateVersion, 3); assert.equal(initial!.manifest.schemaVersion, 4);
  for (const domain of ['relationship', 'emotion', 'cognition', 'personality'] as const) assert.equal(initial!.manifest.domains[domain].status, 'available');
  assert.equal(initial!.manifest.domains.ability.status, 'available'); assert.equal(Object.keys(initial!.manifest.domains).length, 6);
  const { task, entry } = await associated(store), before = await store.request('control.watermark', {});
  const capture = await store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context' });
  const local = createLocalReadView(capture, { validate: captureId => store.request('view.validateCapture', { captureId }) }); t.after(() => local.close());
  const view = await local.read(); await local.assertCurrent(view.viewId);
  assert.equal(view.stateVersion, initial!.stateVersion); assert.equal(view.commitSeq, before.commitSeq);
  assert.deepEqual(view.aggregateVersions, [{ aggregateType: 'task', aggregateId: task.taskId, version: task.version }]);
  assert.deepEqual(view.data.map(value => value.recordId), [task.taskId]); assert.doesNotMatch(JSON.stringify(capture), /CONFIDENTIAL|artifact:|mandate:|reservation/);
  assert.deepEqual(await store.request('control.watermark', {}), before);
  const db = new DatabaseSync(filename, { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_source_cursors').get()!.n, 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shiyu_reply_sessions').get()!.n, 0); }
  finally { db.close(); }
  assert.equal((await store.request('conversation.snapshotLocal', { conversationId: entry.conversationId })).conversations[0].needsSync, true);
});

test('capture/validation commands never accept a caller-selected principal, scope, fields or source versions', async t => {
  const { store } = await fixture(t), { entry } = await associated(store);
  for (const extra of [{ principal: 'owner' }, { scope: 'private' }, { fields: ['artifact'] }, { sourceVersions: [] }]) {
    await assert.rejects(store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context', ...extra } as never), code('INVALID_SCHEMA'));
  }
  const capture = await store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'task_status' });
  await assert.rejects(store.request('view.validateCapture', { captureId: capture.captureId, principal: 'owner' } as never), code('INVALID_SCHEMA'));
  await assert.rejects(store.request('view.validateCapture', { captureId: capture.captureId, phase: 'ignored' } as never), code('INVALID_SCHEMA'));
  await assert.rejects(store.request('view.state', { publish: true } as never), code('INVALID_SCHEMA'));
  await assert.rejects(store.request('view.captureLocal', { conversationId: 'unknown', purpose: 'reply_context' }), code('UNKNOWN_CONVERSATION'));
});

test('concurrent IPC reads share coherent captures, while an actual Task change stales only its old captures', async t => {
  const { store } = await fixture(t), { task, entry } = await associated(store), before = await store.request('control.watermark', {});
  const captures = await Promise.all(Array.from({ length: 50 }, () => store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context' })));
  assert.equal(new Set(captures.map(capture => capture.captureId)).size, 50);
  for (const capture of captures) {
    assert.equal(capture.control.commitSeq, before.commitSeq); assert.equal(capture.tasks[0].version, task.version);
    assert.equal(capture.component.records[0].aggregateVersion!.version, capture.tasks[0].version);
    assert.equal(capture.access.authEpoch, capture.safety.authEpoch); assert.equal(capture.access.stateVersion, capture.publication.stateVersion);
  }
  assert.deepEqual(await store.request('control.watermark', {}), before);
  const changed = await store.request('task.cancel', { taskId: task.taskId, reason: 'synthetic cancellation' });
  assert.ok(changed.version > task.version); assert.equal((await store.request('view.state', {}))!.stateVersion, captures[0].publication.stateVersion);
  await assert.rejects(store.request('view.validateCapture', { captureId: captures[0].captureId }), code('STALE_SOURCE'));
  assert.equal((await store.request('view.validateCapture', { captureId: captures[0].captureId, phase: 'ack' })).tasks[0].version, task.version);
  const next = await store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'task_status' }); assert.equal(next.tasks[0].version, changed.version);
});

test('unrelated event commit preserves the fixed capture and publication across validation', async t => {
  const { store } = await fixture(t), { entry } = await associated(store);
  const capture = await store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context' });
  await store.request('publish', { principal: { principalId: 'synthetic-observer', kind: 'component', scopes: ['local-owner'], publishTypes: ['component.observation.reported'], subscribeTypes: [], targetRefs: [] },
    input: { type: 'component.observation.reported', scope: 'local-owner', idempotencyKey: 'unrelated-view-event', payload: { message: 'unrelated synthetic observation' } } });
  assert.ok((await store.request('control.watermark', {})).commitSeq > capture.control.commitSeq);
  assert.deepEqual(await store.request('view.validateCapture', { captureId: capture.captureId }), capture);
});

test('reopen preserves publication/safety baselines but never revives an old capture', async t => {
  const h = await fixture(t), { entry } = await associated(h.store);
  const capture = await h.store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context' }); await h.store.close();
  const store = await h.open(); assert.deepEqual(await store.request('view.state', {}), capture.publication);
  await assert.rejects(store.request('view.validateCapture', { captureId: capture.captureId, phase: 'ack' }), code('UNKNOWN_CAPTURE'));
  const next = await store.request('view.captureLocal', { conversationId: entry.conversationId, purpose: 'reply_context' });
  assert.equal(next.safety.policyAuthorityId, capture.safety.policyAuthorityId); assert.equal(next.safety.deletionAuthorityId, capture.safety.deletionAuthorityId);
  assert.equal(next.publication.stateVersion, capture.publication.stateVersion); assert.ok(next.tasks[0].version >= capture.tasks[0].version);
});

test('event-only stores expose no local read authority or implicit publication', async t => {
  const { store } = await fixture(t, false);
  await assert.rejects(store.request('view.state', {}), code('VIEWS_UNAVAILABLE'));
  await assert.rejects(store.request('view.captureLocal', { conversationId: 'guessed', purpose: 'task_status' }), code('VIEWS_UNAVAILABLE'));
});
