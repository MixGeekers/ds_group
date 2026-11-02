import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { ChannelRuntimeBridge } from '../src/control/channels/bridge.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { conversation, createEvent, registration, tombstoneEvent } from './fixtures/channel.js';

const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

/** Independent lossless-JSON check for the projection a Runtime tool will return. */
function assertLossless(value: unknown, path = '$'): void {
  if (value === undefined) assert.fail(`${path} must not be undefined`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value) && !Object.is(value, -0), `${path} must be finite, non-negative-zero`); return; }
  assert.equal(typeof value, 'object', `${path} must be a JSON value`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) { assert.ok(index in value, `${path}[${index}] must not be sparse`); assertLossless(value[index], `${path}[${index}]`); }
    return;
  }
  const objectValue = value as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(objectValue), Object.prototype, `${path} must be a plain object`);
  for (const key of Reflect.ownKeys(objectValue)) {
    assert.equal(typeof key, 'string', `${path} must not have symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key)!;
    assert.ok(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, `${path}.${String(key)} must be a plain enumerable value`);
    assert.notEqual(descriptor.value, undefined, `${path}.${String(key)} must not be an explicit undefined`);
    assertLossless(descriptor.value, `${path}.${String(key)}`);
  }
}

async function fixture(t: TestContext, options: { runtimeIdentity?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-channel-bridge-worker-')), filename = join(directory, 'control.sqlite');
  const stores: ControlStore[] = [];
  const open = async () => {
    const store = await ControlStore.open({
      filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'],
      ...(options.runtimeIdentity === false ? {} : { runtimeIdentity: { hostEpoch: 'synthetic-h6b-worker', installationGeneration: 'synthetic-h6b-installation' } }),
    });
    stores.push(store); return store;
  };
  t.after(async () => {
    await Promise.allSettled(stores.map(store => store.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const store = await open();
  return { directory, filename, store, open, stores, bridge: new ChannelRuntimeBridge(store) };
}

test('real Worker IPC persists an idempotent channel binding and applies invalidation watermarks once', async t => {
  const f = await fixture(t);
  const alpha = await f.store.request('channel.registerConnection', registration('acct-alpha'));
  const group = conversation('worker-bridge-group', 'group');
  const channel = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: group, reasonRef: 'synthetic:worker' });
  const message = createEvent('worker-bridge-message');
  for (let index = 0; index < 3; index++) {
    const receipt = await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: group, events: [message] });
    assert.equal(receipt.results[0]!.status, index === 0 ? 'accepted' : 'duplicate');
  }
  const first = await f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner' });
  assert.equal(first.duplicate, false); assert.equal(first.version, 1);
  // A concurrent duplicate bind still produces exactly one durable binding fact.
  const concurrent = await Promise.all([f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner' }),
    f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner' })]);
  assert.equal(concurrent.filter(value => value.duplicate === false).length, 0);
  assert.equal(new Set(concurrent.map(value => value.conversationId)).size, 1);
  assert.equal(first.conversation.audienceVersion, 1);
  const duplicate = await f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.conversationId, first.conversationId);
  assert.equal((await f.store.request('conversation.channelBindings', {})).length, 1);
  await f.store.request('channel.updateAudience', { conversationRef: channel.conversationRef,
    participants: [{ nativeParticipantId: 'u1', kind: 'human' }], reasonRef: 'synthetic:worker-members', expectedAudienceVersion: 0 });
  const applied = await f.bridge.invalidate({ channelRef: channel.conversationRef, reasonRef: 'synthetic:worker-invalidate', sourceWatermark: 1 });
  assert.equal(applied.applied, true); assert.equal(applied.binding.appliedInvalidationWatermark, 1);
  assert.equal(applied.binding.conversation.audienceVersion, 2);
  const replay = await f.bridge.invalidate({ channelRef: channel.conversationRef, reasonRef: 'synthetic:worker-replay', sourceWatermark: 1 });
  assert.equal(replay.applied, false); assert.equal(replay.binding.conversation.audienceVersion, 2);
  await assert.rejects(() => f.bridge.invalidate({ channelRef: channel.conversationRef, reasonRef: 'synthetic:stale-audience', sourceWatermark: 2,
    expectedConversationAudienceVersion: 1 }), code('VERSION_CONFLICT'));
  assert.deepEqual((await f.store.request('conversation.channelBindings', {})).map(binding => binding.channelRef), [channel.conversationRef]);
  assert.equal((await f.store.request('conversation.channelBindings', { channelRef: 'chconv-' + '0'.repeat(32) })).length, 0);
  await assert.rejects(() => f.bridge.bind({ channelRef: 'chconv-' + '0'.repeat(32), scope: 'local-owner' }), code('UNKNOWN_CHANNEL_CONVERSATION'));
  await assert.rejects(() => f.bridge.bind({ channelRef: channel.conversationRef, scope: 'other-scope' }), code('UNAUTHORIZED_BINDING'));
  await assert.rejects(() => f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner', conversationId: 'conversation-that-does-not-exist' }), code('INVALID_CONVERSATION'));
  await assert.rejects(() => f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner', conversationId: first.conversationId, expectedBindingVersion: 0 }), code('VERSION_CONFLICT'));
});

test('the host bridge applies pending invalidations after a restart without duplicate conversation changes', async t => {
  const f = await fixture(t);
  const alpha = await f.store.request('channel.registerConnection', registration('acct-alpha'));
  const group = conversation('worker-pending-group', 'group');
  const channel = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: group, reasonRef: 'synthetic:pending' });
  const binding = await f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner' });
  await f.store.request('channel.updateAudience', { conversationRef: channel.conversationRef,
    participants: [{ nativeParticipantId: 'u1', kind: 'human' }], reasonRef: 'synthetic:pending-join', expectedAudienceVersion: 0 });
  await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: group, events: [createEvent('pending-message')] });
  const deletion = await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: group, events: [tombstoneEvent('pending-message', 2, 'message.retract')] });
  assert.equal(deletion.results[0]!.status, 'accepted');
  // The Worker does not yet have the sink wired (Lead integration): the pull
  // bridge sees two pending invalidations and applies both exactly once.
  const pendingBefore = await f.bridge.bindings();
  assert.equal(pendingBefore[0]!.appliedInvalidationWatermark, 0);
  const snapshotBefore = await f.bridge.snapshot();
  assert.equal(snapshotBefore.pending.unapplied, 2);
  assert.equal(snapshotBefore.pending.unbound, 0);
  const applied = await f.bridge.bridgePending();
  assert.deepEqual([applied.scanned, applied.applied, applied.skippedUnbound], [2, 2, 0]);
  const after = (await f.bridge.bindings())[0]!;
  assert.equal(after.appliedInvalidationWatermark, 2);
  assert.equal(after.conversation.audienceVersion, 3, 'one audience change plus one deletion invalidation');
  assert.equal((await f.bridge.snapshot()).pending.unapplied, 0);
  const noop = await f.bridge.bridgePending();
  assert.equal(noop.applied, 0);
  // Restart: binding identity/version/watermark and conversation audience persist.
  await f.store.close();
  const store = await f.open();
  const bridge = new ChannelRuntimeBridge(store);
  const reopened = await bridge.bindings();
  assert.equal(reopened.length, 1); assert.equal(reopened[0]!.conversationId, binding.conversationId);
  assert.equal(reopened[0]!.version, 1); assert.equal(reopened[0]!.appliedInvalidationWatermark, 2);
  assert.equal(reopened[0]!.conversation.audienceVersion, 3);
  assert.equal((await bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner' })).duplicate, true);
  assert.equal((await bridge.bridgePending()).applied, 0);
  assert.equal((await bridge.snapshot()).pending.unapplied, 0);
});

test('the projection is bounded, lossless JSON and strictly read-only across the real Worker', async t => {
  const f = await fixture(t);
  const alpha = await f.store.request('channel.registerConnection', registration('acct-alpha'));
  const groupA = conversation('projection-group-a', 'group');
  const groupB = conversation('projection-group-b', 'group');
  const a = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: groupA, reasonRef: 'synthetic:projection' });
  const b = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: groupB, reasonRef: 'synthetic:projection' });
  await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: groupA, events: [createEvent('projection-message-a')] });
  await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: groupB, events: [createEvent('projection-message-b')] });
  await f.bridge.bind({ channelRef: a.conversationRef, scope: 'local-owner' });
  await f.store.request('channel.updateAudience', { conversationRef: b.conversationRef,
    participants: [{ nativeParticipantId: 'u1', kind: 'human' }], reasonRef: 'synthetic:projection-unbound', expectedAudienceVersion: 0 });
  const projection = await f.bridge.snapshot();
  assertLossless(projection);
  assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection as never);
  assert.equal(projection.status.ready, true); assert.deepEqual(projection.degraded, []);
  assert.equal(projection.bindings.length, 1); assert.equal(projection.bindings[0]!.channelRef, a.conversationRef);
  assert.equal(projection.bindings[0]!.conversationAudienceVersion, 1);
  assert.equal(projection.connections.length, 1); assert.equal(projection.conversations.length, 2);
  assert.equal(projection.pending.unapplied, 1); assert.equal(projection.pending.unbound, 1);
  assert.equal(projection.watermark.invalidationWatermark, 1);
  const serialized = JSON.stringify(projection);
  for (const canary of ['native-body:projection-message-a', 'native-body:projection-message-b', 'summary projection-message']) {
    assert.ok(!serialized.includes(canary), `projection leaked ${canary}`);
  }
  const before = await f.store.request('control.watermark', {});
  for (let index = 0; index < 100; index++) await f.bridge.snapshot();
  assert.equal((await f.store.request('control.watermark', {})).commitSeq, before.commitSeq);
  await assert.rejects(() => f.bridge.snapshot({ connectionLimit: 0 }), code('INVALID_SCHEMA'));
  await assert.rejects(() => f.bridge.snapshot({ conversationLimit: 201 }), code('INVALID_SCHEMA'));
});

test('a store without the conversation domain still yields an honest degraded projection', async t => {
  const eventOnly = await fixture(t, { runtimeIdentity: false });
  await eventOnly.store.request('channel.registerConnection', registration('acct-event-only'));
  const projection = await new ChannelRuntimeBridge(eventOnly.store).snapshot();
  assertLossless(projection);
  assert.equal(projection.status.ready, true);
  assert.ok(projection.degraded.includes('conversation_domain_unavailable'));
  assert.deepEqual(projection.bindings, []);
  assert.equal(projection.pending.appliedThrough, 0);
});

test('identity mapping through the real Worker yields distinct subjects for two accounts and one idempotent subject per tuple', async t => {
  const f = await fixture(t);
  const alpha = await f.store.request('channel.registerConnection', registration('acct-alpha'));
  const beta = await f.store.request('channel.registerConnection', registration('acct-beta'));
  const group = conversation('identity-short-group', 'group');
  const alphaChannel = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: group, reasonRef: 'synthetic:identity' });
  const betaChannel = await f.store.request('channel.ensureConversation', { connectionId: beta.connectionId, conversation: group, reasonRef: 'synthetic:identity' });
  const alphaMessage = (await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: group, events: [createEvent('shared-native-message')] })).results[0]!;
  const betaMessage = (await f.store.request('channel.ingest', { connectionId: beta.connectionId, conversation: group, events: [createEvent('shared-native-message')] })).results[0]!;
  assert.notEqual(alphaChannel.conversationRef, betaChannel.conversationRef);
  const alphaParticipant = await f.store.request('channel.getMessage', { messageId: alphaMessage.messageId! });
  const betaParticipant = await f.store.request('channel.getMessage', { messageId: betaMessage.messageId! });
  const alphaSubject = await f.bridge.registerParticipantSubject(alphaParticipant.participantRef,
    { requestId: 'synthetic-worker-alpha', entityKind: 'person', displayName: 'Alex' });
  const betaSubject = await f.bridge.registerParticipantSubject(betaParticipant.participantRef,
    { requestId: 'synthetic-worker-beta', entityKind: 'person', displayName: 'Alex' });
  assert.notEqual(alphaSubject.record.entityId, betaSubject.record.entityId, 'the same short id/display name in two accounts never merges');
  assert.notEqual(alphaSubject.account.identityNamespace, betaSubject.account.identityNamespace);
  const again = await f.bridge.registerParticipantSubject(alphaParticipant.participantRef,
    { requestId: 'synthetic-worker-alpha-2', entityKind: 'person', displayName: 'Alex' });
  assert.equal(again.record.entityId, alphaSubject.record.entityId); assert.equal(again.record.created, false);
});

test('two-phase content and cross-audience refusal hold through the Worker after binding', async t => {
  const f = await fixture(t);
  const alpha = await f.store.request('channel.registerConnection', registration('acct-alpha'));
  const groupA = conversation('worker-content-a', 'group');
  const groupB = conversation('worker-content-b', 'group');
  const a = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: groupA, reasonRef: 'synthetic:content' });
  const b = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: groupB, reasonRef: 'synthetic:content' });
  await f.bridge.bind({ channelRef: a.conversationRef, scope: 'local-owner' });
  const aMessage = (await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: groupA, events: [createEvent('worker-content-message-a')] })).results[0]!;
  const bMessage = (await f.store.request('channel.ingest', { connectionId: alpha.connectionId, conversation: groupB, events: [createEvent('worker-content-message-b')] })).results[0]!;
  const capture = await f.store.request('channel.captureAudience', { conversationRef: a.conversationRef });
  const content = await f.store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [aMessage.messageId!] });
  assert.equal(content.content[0]!.bodyRef, 'native-body:worker-content-message-a');
  await assert.rejects(f.store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [bMessage.messageId!] }), code('CROSS_AUDIENCE'));
  await f.store.request('channel.updateAudience', { conversationRef: a.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:content-members', expectedAudienceVersion: 0 });
  await assert.rejects(f.store.request('channel.readContentRefs', { captureId: capture.captureId, messageIds: [aMessage.messageId!] }), code('STALE_AUDIENCE'));
  const pending = await f.bridge.bridgePending();
  assert.equal(pending.applied, 1);
  const binding = (await f.bridge.bindings())[0]!;
  assert.equal(binding.appliedInvalidationWatermark, 1);
  assert.equal(binding.conversation.audienceVersion, 2);
});

test('rejected bridge operations leave the real durable state untouched', async t => {
  const f = await fixture(t);
  const alpha = await f.store.request('channel.registerConnection', registration('acct-alpha'));
  const group = conversation('worker-negative-group', 'group');
  const channel = await f.store.request('channel.ensureConversation', { connectionId: alpha.connectionId, conversation: group, reasonRef: 'synthetic:negative' });
  const before = await f.store.request('control.watermark', {});
  for (const attempt of [
    () => f.bridge.bind({ channelRef: 'chconv-' + '0'.repeat(32), scope: 'local-owner' }),
    () => f.bridge.bind({ channelRef: 'not-a-channel-ref', scope: 'local-owner' }),
    () => f.bridge.bind({ channelRef: channel.conversationRef, scope: 'other-scope' }),
    () => f.bridge.bind({ channelRef: channel.conversationRef, scope: 'local-owner', conversationId: 'conversation-that-does-not-exist' }),
    () => f.bridge.invalidate({ channelRef: channel.conversationRef, reasonRef: 'synthetic:none', sourceWatermark: 1 }),
    () => f.store.request('conversation.channelInvalidate', { channelRef: channel.conversationRef, reasonRef: 'synthetic:none', sourceWatermark: 0 }),
  ]) {
    await assert.rejects(attempt as () => Promise<unknown>);
  }
  assert.equal((await f.store.request('control.watermark', {})).commitSeq, before.commitSeq);
  assert.deepEqual(await f.bridge.bindings(), []);
  assert.deepEqual(await f.store.request('conversation.channelBindings', {}), []);
});
