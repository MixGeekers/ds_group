import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { IngressDomain } from '../src/adapters/control-store/ingress-domain.js';
import { RelationshipDomain } from '../src/adapters/control-store/relationship-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { ConversationStore } from '../src/control/conversations/index.js';
import type { ConversationActor } from '../src/control/conversations/types.js';
import { conversationInvalidationReason, toConversationKey } from '../src/control/ingress/index.js';
import type { ChannelInvalidationSignal } from '../src/contracts/channel.js';
import { conversation, createEvent, ensure, registration, tombstoneEvent } from './fixtures/channel.js';

const OWNER: ConversationActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

/**
 * Integration proof, not a new product path: the H6a ingress ledger shares the
 * same SQLite connection/transaction owner with the existing ConversationStore
 * and the H4 RelationshipDomain. The invalidation sink below is exactly the
 * wiring the Lead can install in `worker.ts` (channelRef -> conversationId
 * mapping plus ConversationStore.invalidateAudience).
 */
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'shiyu-channel-integration-')), filename = join(dir, 'control.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;');
  const tx = new SqliteTransactions(db);
  const conversations = new ConversationStore(db, tx, {
    ownerIds: [OWNER.principalId], componentPermissions: {}, authorizeReference: () => true,
  });
  const relationships = new RelationshipDomain(db, tx, {
    runtimeIdentity: { hostEpoch: 'synthetic-channel-host', installationGeneration: 'synthetic-channel-installation' },
    resolveConversation: () => undefined,
  });
  const mapping = new Map<string, string>();
  const signals: ChannelInvalidationSignal[] = [];
  const control = { failAfterInvalidation: false };
  const ingress = new IngressDomain(db, tx, {
    onInvalidation: signal => {
      signals.push(structuredClone(signal));
      const conversationId = mapping.get(signal.conversationRef);
      if (!conversationId) return;
      const record = conversations.getConversation(OWNER, conversationId);
      conversations.invalidateAudience(OWNER, {
        conversationId, expectedRevision: record.revision, reasonRef: conversationInvalidationReason(signal),
      });
      if (control.failAfterInvalidation) throw new Error('synthetic_after_invalidation_failure');
    },
  });
  t.after(() => { if (db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); });
  /** Ensure a channel conversation and its existing ConversationStore counterpart. */
  const link = (connectionId: string, input = conversation()) => {
    const view = ensure(ingress, connectionId, input);
    const record = conversations.ensureConversation(OWNER, toConversationKey({ connectionId, ...input }, 'local-owner'));
    mapping.set(view.conversationRef, record.conversationId);
    return { view, record, binding: conversations.ensureReplyBinding(OWNER, { conversationId: record.conversationId }) };
  };
  return { db, tx, ingress, conversations, relationships, mapping, signals, control, link, filename };
}

test('the same short ids in two accounts become two distinct relationship subjects with one stable binding each', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const beta = f.ingress.registerConnection(registration('acct-beta'));
  const direct = conversation('dm-short-1', 'direct');
  const alphaConversation = ensure(f.ingress, alpha.connectionId, direct);
  const betaConversation = ensure(f.ingress, beta.connectionId, direct);
  const alphaEvent = createEvent('same-native-message');
  const betaEvent = createEvent('same-native-message');
  const alphaMessage = f.ingress.ingest({ connectionId: alpha.connectionId, conversation: direct, events: [alphaEvent] }).results[0]!;
  const betaMessage = f.ingress.ingest({ connectionId: beta.connectionId, conversation: direct, events: [betaEvent] }).results[0]!;
  const alphaParticipant = f.ingress.getParticipant({ participantRef: f.ingress.getMessage({ messageId: alphaMessage.messageId! }).participantRef });
  const betaParticipant = f.ingress.getParticipant({ participantRef: f.ingress.getMessage({ messageId: betaMessage.messageId! }).participantRef });
  assert.equal(alphaParticipant.nativeParticipantId, betaParticipant.nativeParticipantId);
  assert.notEqual(alphaParticipant.participantRef, betaParticipant.participantRef);
  const alphaSubject = f.relationships.registerSubject({ requestId: 'synthetic-alpha-subject', account: alphaParticipant.innerAccount,
    entityKind: 'person', displayName: 'Alex' });
  const betaSubject = f.relationships.registerSubject({ requestId: 'synthetic-beta-subject', account: betaParticipant.innerAccount,
    entityKind: 'person', displayName: 'Alex' });
  assert.notEqual(alphaSubject.record.entityId, betaSubject.record.entityId, 'the same display name and short id never merge across accounts');
  const again = f.relationships.registerSubject({ requestId: 'synthetic-alpha-subject-2', account: alphaParticipant.innerAccount,
    entityKind: 'person', displayName: 'Alex' });
  assert.equal(again.record.entityId, alphaSubject.record.entityId); assert.equal(again.record.created, false);
  // The two channel conversations map to distinct existing ConversationStore records.
  const alphaRecord = f.conversations.ensureConversation(OWNER, toConversationKey({ connectionId: alpha.connectionId, ...direct }, 'local-owner'));
  const betaRecord = f.conversations.ensureConversation(OWNER, toConversationKey({ connectionId: beta.connectionId, ...direct }, 'local-owner'));
  assert.notEqual(alphaRecord.conversationId, betaRecord.conversationId);
  assert.equal(alphaConversation.conversationRef === betaConversation.conversationRef, false);
});

test('an audience change invalidates the real ConversationStore audience and stale draft in the same transaction', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-1', 'group');
  const pending = ensure(f.ingress, alpha.connectionId, group);
  f.ingress.updateAudience({ conversationRef: pending.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:initial-members', expectedAudienceVersion: 0 });
  const { view, record, binding } = f.link(alpha.connectionId, group);
  assert.equal(view.audienceVersion, 1);
  const untouched = f.link(alpha.connectionId, conversation('short-group-2', 'group'));
  const draft = f.conversations.beginReply(OWNER, { draftId: 'synthetic-draft-a', bindingId: binding.bindingId, dependencies: [] });
  assert.equal(draft.token.audienceVersion, 1);
  const signalsBefore = f.signals.length;
  const changed = f.ingress.updateAudience({ conversationRef: view.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }, { nativeParticipantId: 'u2', kind: 'human' }],
    reasonRef: 'synthetic:new-member', expectedAudienceVersion: 1 });
  assert.equal(changed.conversation.audienceVersion, 2);
  assert.equal(f.signals.length, signalsBefore + 1);
  assert.equal(f.signals.at(-1)!.type, 'audience_changed');
  const updated = f.conversations.getConversation(OWNER, record.conversationId);
  assert.equal(updated.audienceVersion, 2);
  assert.ok(updated.revision > record.revision);
  const updatedBinding = f.conversations.getReplyBinding(OWNER, binding.bindingId);
  assert.equal(updatedBinding.sessionEpoch, 2, 'an audience change forces a new native context epoch');
  assert.equal(updatedBinding.routingRevision, 2);
  assert.throws(() => f.conversations.assertDraftCurrent(OWNER, 'synthetic-draft-a'), code('STALE_CONTEXT'));
  const untouchedRecord = f.conversations.getConversation(OWNER, untouched.record.conversationId);
  assert.equal(untouchedRecord.audienceVersion, untouched.record.audienceVersion);
  assert.equal(untouchedRecord.revision, untouched.record.revision);
  assert.equal(updated.lastAudienceChange?.reasonRef.startsWith('channel-audience:'), true);
});

test('a message deletion also emits a trusted invalidation that retires the current draft', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-3', 'group');
  const ensured = ensure(f.ingress, alpha.connectionId, group);
  f.ingress.updateAudience({ conversationRef: ensured.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:members', expectedAudienceVersion: 0 });
  const { binding } = f.link(alpha.connectionId, group);
  f.conversations.beginReply(OWNER, { draftId: 'synthetic-draft-b', bindingId: binding.bindingId, dependencies: [] });
  f.ingress.ingest({ connectionId: alpha.connectionId, conversation: group, events: [createEvent('m1')] });
  const signalsBefore = f.signals.length;
  const deleted = f.ingress.ingest({ connectionId: alpha.connectionId, conversation: group, events: [tombstoneEvent('m1', 2, 'message.retract')] });
  assert.equal(deleted.results[0]!.status, 'accepted');
  assert.equal(f.signals.length, signalsBefore + 1);
  assert.equal(f.signals.at(-1)!.type, 'message_deleted');
  assert.equal(f.signals.at(-1)!.messageId, deleted.results[0]!.messageId);
  const updatedBinding = f.conversations.getReplyBinding(OWNER, binding.bindingId);
  assert.equal(updatedBinding.sessionEpoch, 2);
  assert.throws(() => f.conversations.assertDraftCurrent(OWNER, 'synthetic-draft-b'), code('STALE_CONTEXT'));
});

test('a downstream invalidation failure rolls both the channel audience and the ConversationStore write back', t => {
  const f = fixture(t);
  const alpha = f.ingress.registerConnection(registration('acct-alpha'));
  const group = conversation('short-group-4', 'group');
  const ensured = ensure(f.ingress, alpha.connectionId, group);
  f.ingress.updateAudience({ conversationRef: ensured.conversationRef, participants: [{ nativeParticipantId: 'u1', kind: 'human' }],
    reasonRef: 'synthetic:members', expectedAudienceVersion: 0 });
  const { record } = f.link(alpha.connectionId, group);
  const beforeRecord = f.conversations.getConversation(OWNER, record.conversationId);
  f.control.failAfterInvalidation = true;
  assert.throws(() => f.ingress.updateAudience({ conversationRef: ensured.conversationRef,
    participants: [{ nativeParticipantId: 'u1', kind: 'human' }, { nativeParticipantId: 'u2', kind: 'human' }],
    reasonRef: 'synthetic:rollback', expectedAudienceVersion: 1 }), /synthetic_after_invalidation_failure/);
  const channel = f.ingress.snapshot({}).conversations.find(value => value.conversationRef === ensured.conversationRef)!;
  assert.equal(channel.audienceVersion, 1);
  assert.equal(channel.participants.length, 1);
  const afterRecord = f.conversations.getConversation(OWNER, record.conversationId);
  assert.equal(afterRecord.audienceVersion, beforeRecord.audienceVersion);
  assert.equal(afterRecord.revision, beforeRecord.revision);
  assert.equal(f.conversations.getReplyBinding(OWNER, f.conversations.ensureReplyBinding(OWNER, { conversationId: record.conversationId }).bindingId).sessionEpoch, 1);
  assert.equal(Number((f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_channel_invalidations').get() as { n: number }).n), 1);
  f.control.failAfterInvalidation = false;
  const accepted = f.ingress.updateAudience({ conversationRef: ensured.conversationRef,
    participants: [{ nativeParticipantId: 'u1', kind: 'human' }, { nativeParticipantId: 'u2', kind: 'human' }],
    reasonRef: 'synthetic:rollback-retry', expectedAudienceVersion: 1 });
  assert.equal(accepted.conversation.audienceVersion, 2);
  assert.equal(f.conversations.getConversation(OWNER, record.conversationId).audienceVersion, 2);
});
