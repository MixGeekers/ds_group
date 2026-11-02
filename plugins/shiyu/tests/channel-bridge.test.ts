import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ConversationDomain, type ConversationEventPort } from '../src/adapters/control-store/conversation-domain.js';
import { IngressDomain } from '../src/adapters/control-store/ingress-domain.js';
import { RelationshipDomain } from '../src/adapters/control-store/relationship-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { ConversationStore } from '../src/control/conversations/index.js';
import type { ConversationActor, ConversationRecord } from '../src/control/conversations/index.js';
import { channelBridgeReason, channelConversationKey, channelParticipantAccount, normalizeBridgeScope } from '../src/control/channels/bridge.js';
import { toConversationKey } from '../src/control/ingress/index.js';
import { conversation, createEvent, ensure, ingest, registration, tombstoneEvent } from './fixtures/channel.js';

const OWNER: ConversationActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
const HOST = { hostEpoch: 'synthetic-h6b-host', installationGeneration: 'synthetic-h6b-installation' };

/**
 * Direct same-connection H6b bridge fixture: real temporary SQLite, real
 * IngressDomain + ConversationDomain (and therefore real ConversationStore) +
 * H4 RelationshipDomain. This is the same transaction ownership the Worker
 * uses; the Worker IPC path is exercised separately in the worker test.
 */
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-channel-bridge-')), filename = join(directory, 'control.sqlite');
  const databases: DatabaseSync[] = [];
  let now = new Date('2026-11-02T12:00:00.000Z');
  const sink = { fail: false, calls: [] as { channelRef: string; watermark: number }[] };
  const eventsPort = new Proxy({}, { get: () => () => { throw new Error('synthetic events port must not be used by the bridge fixture'); } }) as unknown as ConversationEventPort;
  const open = () => {
    const db = new DatabaseSync(filename);
    databases.push(db);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;');
    const tx = new SqliteTransactions(db);
    const ingress = new IngressDomain(db, tx, { now: () => now });
    const conversations = new ConversationDomain(db, tx, { events: eventsPort, getTask: () => { throw new Error('synthetic task port must not be used'); } });
    const relationships = new RelationshipDomain(db, tx, { runtimeIdentity: HOST, resolveConversation: () => undefined });
    // A second ConversationStore view on the same connection is used only to
    // create/inspect reply drafts; ConversationDomain owns the bridge writes.
    const drafts = new ConversationStore(db, tx, { ownerIds: [OWNER.principalId], componentPermissions: {}, authorizeReference: () => true });
    ingress.setInvalidationSink(signal => {
      const outcome = conversations.bridgeChannelInvalidation({
        channelRef: signal.conversationRef, reasonRef: channelBridgeReason(signal), sourceWatermark: signal.watermark,
      });
      // Unbound channel conversations are a no-op, not an error.
      if (!outcome) return;
      sink.calls.push({ channelRef: signal.conversationRef, watermark: signal.watermark });
      if (sink.fail) throw new Error('synthetic_bridge_sink_failure');
    });
    return { db, tx, ingress, conversations, relationships, drafts };
  };
  let opened = open();
  let draftSequence = 0;
  t.after(() => {
    for (const db of databases) if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const draftFor = (conversationId: string) => {
    const binding = opened.drafts.ensureReplyBinding(OWNER, { conversationId });
    const draft = opened.drafts.beginReply(OWNER, { draftId: `synthetic-draft-${++draftSequence}`, bindingId: binding.bindingId, dependencies: [] });
    return { binding, draftId: draft.draftId };
  };
  const bind = (channelRef: string, input: { scope?: string; conversationId?: string; expectedBindingVersion?: number } = {}) =>
    opened.conversations.channelBind({ channelRef, scope: input.scope ?? 'local-owner',
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.expectedBindingVersion === undefined ? {} : { expectedBindingVersion: input.expectedBindingVersion }) });
  return {
    get db() { return opened.db; }, get tx() { return opened.tx; }, get ingress() { return opened.ingress; }, get conversations() { return opened.conversations; },
    get relationships() { return opened.relationships; }, get drafts() { return opened.drafts; },
    filename, sink, draftFor, bind,
    clock(iso: string) { now = new Date(iso); },
    reopen() { opened.db.close(); opened = open(); },
    bindingRowCount() { return Number((opened.db.prepare('SELECT COUNT(*) AS n FROM shiyu_channel_conversation_bindings').get() as { n: number }).n); },
    conversationCount() { return Number((opened.db.prepare('SELECT COUNT(*) AS n FROM shiyu_conversations').get() as { n: number }).n); },
    audienceVersion(conversationId: string): number { return opened.drafts.getConversation(OWNER, conversationId).audienceVersion; },
    conversationRecord(conversationId: string): ConversationRecord { return opened.drafts.getConversation(OWNER, conversationId); },
    staleDraft: (draftId: string) => assert.throws(() => opened.drafts.assertDraftCurrent(OWNER, draftId), code('STALE_CONTEXT')),
  };
}

test('binding creates the exact ConversationStore conversation and repeated delivery/binding stays idempotent', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-1', 'group');
  const channel = ensure(f.ingress, alpha.connectionId, group);
  const message = createEvent('m1');
  for (let index = 0; index < 5; index++) ingest(f.ingress, alpha.connectionId, group, [message]);
  const first = f.bind(channel.conversationRef);
  assert.equal(first.duplicate, false); assert.equal(first.version, 1); assert.equal(first.scope, 'local-owner');
  assert.equal(first.appliedInvalidationWatermark, 0);
  assert.equal(first.conversation.audienceVersion, 1, 'the ConversationStore record starts at audience version 1');
  assert.equal(first.conversation.replySessionEpoch, 0);
  const second = f.bind(channel.conversationRef);
  assert.equal(second.duplicate, true); assert.equal(second.version, 1); assert.equal(second.conversationId, first.conversationId);
  assert.equal(f.bindingRowCount(), 1);
  assert.equal(f.conversationCount(), 1, 'repeated channel delivery and repeated binding never create a second conversation');
  // The persisted binding is the same key the pure `toConversationKey` mapping produces.
  const expectedKey = toConversationKey({ connectionId: channel.connectionId, nativeConversationId: group.nativeConversationId, mode: group.mode }, 'local-owner');
  assert.equal(f.drafts.ensureConversation(OWNER, expectedKey).conversationId, first.conversationId);
  assert.deepEqual(channelConversationKey({
    channelRef: channel.conversationRef, connectionId: channel.connectionId, sourceNamespace: 'synthetic.chat', accountId: 'acct-alpha',
    nativeConversationId: group.nativeConversationId, mode: group.mode, audienceVersion: 0, audienceStatus: 'pending', participantCount: 0,
  }, 'local-owner'), expectedKey);
  const listed = f.conversations.channelBindings({});
  assert.equal(listed.length, 1); assert.equal(listed[0]!.conversationId, first.conversationId);
  assert.deepEqual(f.conversations.channelBindings({ channelRef: channel.conversationRef }).map(value => value.channelRef), [channel.conversationRef]);
  assert.deepEqual(f.conversations.channelBindings({ conversationId: first.conversationId }).map(value => value.channelRef), [channel.conversationRef]);
  assert.deepEqual(f.conversations.channelBindings({ channelRef: 'chconv-' + '0'.repeat(32) }), []);
});

test('audience change, member removal and message deletion each retire old drafts through the same-transaction sink', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-2', 'group');
  const channel = ensure(f.ingress, alpha.connectionId, group);
  const binding = f.bind(channel.conversationRef);
  assert.equal(binding.conversation.replySessionEpoch, 0);
  const draftA = f.draftFor(binding.conversationId);
  f.ingress.updateAudience({ conversationRef: channel.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:join', expectedAudienceVersion: 0 });
  assert.equal(f.sink.calls.length, 1);
  f.staleDraft(draftA.draftId);
  const afterJoin = f.conversations.channelBindings({ channelRef: channel.conversationRef })[0]!;
  assert.equal(afterJoin.appliedInvalidationWatermark, 1);
  assert.equal(afterJoin.conversation.audienceVersion, 2);
  assert.equal(afterJoin.conversation.replySessionEpoch, 2, 'invalidateAudience retired the previous native context epoch');
  assert.equal(afterJoin.lastInvalidationReason, 'channel-bridge:audience_changed:1');
  const draftB = f.draftFor(binding.conversationId);
  f.ingress.updateAudience({ conversationRef: channel.conversationRef,
    participants: [{ nativeParticipantId: 'u1', kind: 'human' }, { nativeParticipantId: 'u2', kind: 'human' }],
    reasonRef: 'synthetic:second-member', expectedAudienceVersion: 1 });
  f.staleDraft(draftB.draftId);
  const afterMember = f.conversations.channelBindings({ channelRef: channel.conversationRef })[0]!;
  assert.equal(afterMember.appliedInvalidationWatermark, 2);
  assert.equal(afterMember.conversation.replySessionEpoch, 3);
  const draftC = f.draftFor(binding.conversationId);
  ingest(f.ingress, alpha.connectionId, group, [createEvent('m1')]);
  ingest(f.ingress, alpha.connectionId, group, [tombstoneEvent('m1', 2, 'message.delete')]);
  f.staleDraft(draftC.draftId);
  const afterDeletion = f.conversations.channelBindings({ channelRef: channel.conversationRef })[0]!;
  assert.equal(afterDeletion.appliedInvalidationWatermark, 3);
  assert.equal(afterDeletion.conversation.replySessionEpoch, 4);
  assert.equal(afterDeletion.lastInvalidationReason, 'channel-bridge:message_deleted:3');
  // A repeated application of the same watermark is a no-op.
  const replay = f.conversations.channelInvalidate({ channelRef: channel.conversationRef, reasonRef: 'synthetic:replay', sourceWatermark: 3 });
  assert.equal(replay.applied, false);
  assert.equal(replay.binding.conversation.audienceVersion, afterDeletion.conversation.audienceVersion);
});

test('a sink failure rolls the channel audience change and the ConversationStore write back together', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-3', 'group');
  const channel = ensure(f.ingress, alpha.connectionId, group);
  const binding = f.bind(channel.conversationRef);
  const before = f.conversationRecord(binding.conversationId);
  f.sink.fail = true;
  assert.throws(() => f.ingress.updateAudience({ conversationRef: channel.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:failed', expectedAudienceVersion: 0 }), /synthetic_bridge_sink_failure/);
  assert.equal(f.conversations.channelBindings({ channelRef: channel.conversationRef })[0]!.appliedInvalidationWatermark, 0);
  assert.equal(f.ingress.snapshot({}).conversations[0]!.audienceVersion, 0);
  assert.equal(f.conversationRecord(binding.conversationId).audienceVersion, before.audienceVersion);
  assert.equal(f.conversationRecord(binding.conversationId).revision, before.revision);
  assert.equal(Number((f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_channel_invalidations').get() as { n: number }).n), 0);
  f.sink.fail = false;
  f.ingress.updateAudience({ conversationRef: channel.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:retry', expectedAudienceVersion: 0 });
  assert.equal(f.conversations.channelBindings({ channelRef: channel.conversationRef })[0]!.appliedInvalidationWatermark, 1);
  assert.equal(f.conversationRecord(binding.conversationId).audienceVersion, before.audienceVersion + 1);
});

test('unbound channel invalidations stay in the channel ledger and a later binding catches up explicitly', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-4', 'group');
  const channel = ensure(f.ingress, alpha.connectionId, group);
  f.ingress.updateAudience({ conversationRef: channel.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:unbound', expectedAudienceVersion: 0 });
  assert.equal(f.sink.calls.length, 0, 'an unbound channel conversation is not bridged');
  assert.equal(Number((f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_channel_invalidations').get() as { n: number }).n), 1);
  const binding = f.bind(channel.conversationRef);
  assert.equal(binding.appliedInvalidationWatermark, 0);
  const applied = f.conversations.channelInvalidate({ channelRef: channel.conversationRef, reasonRef: 'synthetic:catch-up', sourceWatermark: 1 });
  assert.equal(applied.applied, true);
  assert.equal(applied.binding.appliedInvalidationWatermark, 1);
  assert.equal(applied.binding.conversation.audienceVersion, 2);
  assert.equal(f.conversations.channelInvalidate({ channelRef: channel.conversationRef, reasonRef: 'synthetic:catch-up-again', sourceWatermark: 1 }).applied, false);
  assert.throws(() => f.conversations.channelInvalidate({ channelRef: 'chconv-' + '0'.repeat(32), reasonRef: 'synthetic:none', sourceWatermark: 1 }),
    code('UNKNOWN_CHANNEL_BINDING'));
});

test('explicit rebind is CAS-versioned; invalid targets and stale readers never overwrite a newer binding', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-5', 'group');
  const channel = ensure(f.ingress, alpha.connectionId, group);
  const binding = f.bind(channel.conversationRef);
  const otherKey = toConversationKey({ connectionId: 'synthetic-other-connection', nativeConversationId: 'synthetic-other-conversation', mode: 'group' }, 'local-owner');
  const other = f.drafts.ensureConversation(OWNER, otherKey);
  assert.throws(() => f.bind(channel.conversationRef, { conversationId: other.conversationId }), code('BINDING_VERSION_REQUIRED'));
  assert.throws(() => f.bind(channel.conversationRef, { conversationId: other.conversationId, expectedBindingVersion: 0 }), code('VERSION_CONFLICT'));
  assert.throws(() => f.bind(channel.conversationRef, { conversationId: 'conversation-that-does-not-exist' }), code('INVALID_CONVERSATION'));
  assert.throws(() => f.bind(channel.conversationRef, { scope: 'not-my-scope' }), code('UNAUTHORIZED_BINDING'));
  assert.throws(() => f.bind('chconv-' + '0'.repeat(32)), code('UNKNOWN_CHANNEL_CONVERSATION'));
  assert.throws(() => f.bind('not-a-channel-ref'), code('INVALID_SCHEMA'));
  const rebound = f.bind(channel.conversationRef, { conversationId: other.conversationId, expectedBindingVersion: 1 });
  assert.equal(rebound.duplicate, false); assert.equal(rebound.version, 2); assert.equal(rebound.conversationId, other.conversationId);
  assert.throws(() => f.bind(channel.conversationRef, { conversationId: binding.conversationId, expectedBindingVersion: 1 }), code('VERSION_CONFLICT'));
  // The old conversation cannot be bound to a second channel conversation either.
  const secondChannel = ensure(f.ingress, alpha.connectionId, conversation('short-group-6', 'group'));
  assert.throws(() => f.bind(secondChannel.conversationRef, { conversationId: other.conversationId, expectedBindingVersion: 1 }), code('BINDING_CONFLICT'));
  const archived = f.drafts.ensureConversation(OWNER, toConversationKey({ connectionId: 'synthetic-archived', nativeConversationId: 'archived-conversation', mode: 'direct' }, 'local-owner'));
  f.drafts.setArchived(OWNER, { conversationId: archived.conversationId, expectedRevision: archived.revision, archived: true });
  assert.throws(() => f.bind(secondChannel.conversationRef, { conversationId: archived.conversationId }), code('INACTIVE_CONVERSATION'));
});

test('cross-scope conversations and revoked channel audiences are refused', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-7', 'group');
  const channel = ensure(f.ingress, alpha.connectionId, group);
  // A conversation created under another audience scope by another owner: the
  // runtime owner cannot read or bind it, so the bridge refuses it as cross-scope.
  const vendorStore = new ConversationStore(f.db, f.tx, { ownerIds: ['vendor-owner'], componentPermissions: {}, authorizeReference: () => true });
  const vendorActor: ConversationActor = { principalId: 'vendor-owner', kind: 'owner', scopes: ['vendor-scope'] };
  const foreign = vendorStore.ensureConversation(vendorActor, { connectionId: 'vendor-connection', platformConversationId: 'vendor-conversation', kind: 'group', scope: 'vendor-scope' });
  assert.throws(() => f.bind(channel.conversationRef, { conversationId: foreign.conversationId }), code('CROSS_SCOPE_BINDING'));
  assert.throws(() => f.bind(channel.conversationRef, { scope: 'vendor-scope' }), code('UNAUTHORIZED_BINDING'));
  const revoked = ensure(f.ingress, alpha.connectionId, conversation('short-group-8', 'group'));
  f.ingress.updateAudience({ conversationRef: revoked.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:join', expectedAudienceVersion: 0 });
  f.ingress.revokeAccess({ conversationRef: revoked.conversationRef, scope: 'conversation', reasonRef: 'synthetic:revoked', expectedAudienceVersion: 1 });
  assert.throws(() => f.bind(revoked.conversationRef), code('CHANNEL_AUDIENCE_REVOKED'));
  assert.equal(channel.mode, 'group');
  assert.equal(normalizeBridgeScope('local-owner'), 'local-owner');
  assert.throws(() => normalizeBridgeScope('bad scope with spaces'), code('INVALID_SCHEMA'));
});

test('two accounts with identical short ids map to distinct conversation bindings and distinct relationship subjects', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const beta = f.ingress.registerConnection(registration('acct-beta'));
  const group = conversation('shared-short-group', 'group');
  const alphaChannel = ensure(f.ingress, alpha.connectionId, group);
  const betaChannel = ensure(f.ingress, beta.connectionId, group);
  assert.notEqual(alphaChannel.conversationRef, betaChannel.conversationRef);
  const alphaMessage = ingest(f.ingress, alpha.connectionId, group, [createEvent('same-native-message')]).results[0]!;
  const betaMessage = ingest(f.ingress, beta.connectionId, group, [createEvent('same-native-message')]).results[0]!;
  const alphaBinding = f.bind(alphaChannel.conversationRef);
  const betaBinding = f.bind(betaChannel.conversationRef);
  assert.notEqual(alphaBinding.conversationId, betaBinding.conversationId);
  const alphaParticipant = f.ingress.getParticipant({ participantRef: f.ingress.getMessage({ messageId: alphaMessage.messageId! }).participantRef });
  const betaParticipant = f.ingress.getParticipant({ participantRef: f.ingress.getMessage({ messageId: betaMessage.messageId! }).participantRef });
  assert.equal(alphaParticipant.nativeParticipantId, betaParticipant.nativeParticipantId);
  const alphaAccount = channelParticipantAccount(alphaParticipant), betaAccount = channelParticipantAccount(betaParticipant);
  assert.deepEqual(alphaAccount, alphaParticipant.innerAccount);
  assert.notEqual(alphaAccount.identityNamespace, betaAccount.identityNamespace);
  const alphaSubject = f.relationships.registerSubject({ requestId: 'synthetic-alpha-subject', account: alphaAccount, entityKind: 'person', displayName: 'Alex' });
  const betaSubject = f.relationships.registerSubject({ requestId: 'synthetic-beta-subject', account: betaAccount, entityKind: 'person', displayName: 'Alex' });
  assert.notEqual(alphaSubject.record.entityId, betaSubject.record.entityId, 'the same short id/display name in two accounts never merges');
  const again = f.relationships.registerSubject({ requestId: 'synthetic-alpha-subject-2', account: alphaAccount, entityKind: 'person', displayName: 'Alex' });
  assert.equal(again.record.entityId, alphaSubject.record.entityId); assert.equal(again.record.created, false);
});

test('restart preserves bindings, applied watermarks and lets the next invalidation retire an old draft', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-9', 'group');
  const channel = ensure(f.ingress, alpha.connectionId, group);
  const binding = f.bind(channel.conversationRef);
  f.ingress.updateAudience({ conversationRef: channel.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:before-restart', expectedAudienceVersion: 0 });
  const before = f.conversations.channelBindings({})[0]!;
  assert.equal(before.appliedInvalidationWatermark, 1);
  f.reopen();
  const reconnect = f.ingress.registerConnection(registration('acct-alpha'));
  const replayed = f.bind(channel.conversationRef);
  assert.equal(replayed.duplicate, true); assert.equal(replayed.version, 1);
  assert.equal(replayed.conversationId, binding.conversationId);
  assert.equal(replayed.appliedInvalidationWatermark, 1, 'the applied invalidation watermark persisted');
  assert.equal(f.bindingRowCount(), 1);
  const freshDraft = f.draftFor(binding.conversationId);
  f.ingress.updateAudience({ conversationRef: channel.conversationRef,
    participants: [{ nativeParticipantId: 'u1', kind: 'human' }, { nativeParticipantId: 'u2', kind: 'human' }],
    reasonRef: 'synthetic:after-restart', expectedAudienceVersion: 1 });
  f.staleDraft(freshDraft.draftId);
  const after = f.conversations.channelBindings({})[0]!;
  assert.equal(after.appliedInvalidationWatermark, 2);
  assert.equal(after.conversation.replySessionEpoch, 2); // the pre-restart invalidation retired epoch 1
  assert.equal(reconnect.connectionId, alpha.connectionId);
});

test('two-phase content capture remains scoped after binding; cross-audience ids are refused', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const a = conversation('bridge-conversation-a', 'group');
  const b = conversation('bridge-conversation-b', 'group');
  const aChannel = ensure(f.ingress, alpha.connectionId, a);
  ensure(f.ingress, alpha.connectionId, b);
  const binding = f.bind(aChannel.conversationRef);
  const aMessage = ingest(f.ingress, alpha.connectionId, a, [createEvent('bridge-message-a')]).results[0]!;
  const bMessage = ingest(f.ingress, alpha.connectionId, b, [createEvent('bridge-message-b')]).results[0]!;
  const capture = f.ingress.captureAudience({ conversationRef: aChannel.conversationRef });
  const captureText = JSON.stringify(capture);
  assert.ok(!captureText.includes('native-body:bridge-message-a'));
  assert.ok(!captureText.includes('summary bridge-message-a'));
  const content = f.ingress.readContentRefs({ captureId: capture.captureId, messageIds: [aMessage.messageId!] });
  assert.equal(content.content[0]!.bodyRef, 'native-body:bridge-message-a');
  assert.throws(() => f.ingress.readContentRefs({ captureId: capture.captureId, messageIds: [bMessage.messageId!] }), code('CROSS_AUDIENCE'));
  f.ingress.updateAudience({ conversationRef: aChannel.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:audience-change', expectedAudienceVersion: 0 });
  assert.throws(() => f.ingress.readContentRefs({ captureId: capture.captureId, messageIds: [aMessage.messageId!] }), code('STALE_AUDIENCE'));
  assert.equal(f.conversations.channelBindings({ channelRef: aChannel.conversationRef })[0]!.appliedInvalidationWatermark, 1);
  assert.equal(f.conversationRecord(binding.conversationId).audienceVersion, 2);
});
