import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, conversation, createEvent, editEvent, ensure, fixture, ingest, tombstoneEvent } from './fixtures/channel.js';

const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
const member = (nativeParticipantId: string, kind: 'human' | 'bot' | 'system' = 'human') => ({ nativeParticipantId, kind });

test('DM audience is exactly one fixed counterpart while group membership is a versioned replaceable set', t => {
  const f = fixture(t);
  const alpha = connect(f.domain);
  const direct = ensure(f.domain, alpha.connectionId, conversation('dm-1', 'direct'));
  assert.equal(direct.audienceVersion, 0); assert.equal(direct.audienceStatus, 'pending');
  const directSet = f.domain.updateAudience({ conversationRef: direct.conversationRef, participants: [member('peer-1')], reasonRef: 'synthetic:dm-open', expectedAudienceVersion: 0 });
  assert.equal(directSet.conversation.audienceVersion, 1); assert.equal(directSet.conversation.audienceStatus, 'current');
  assert.deepEqual(directSet.change?.added.length, 1);
  assert.equal(directSet.conversation.participants.length, 1);
  const idempotent = f.domain.updateAudience({ conversationRef: direct.conversationRef, participants: [member('peer-1')], reasonRef: 'synthetic:dm-refresh', expectedAudienceVersion: 1 });
  assert.equal(idempotent.change, undefined); assert.equal(idempotent.conversation.audienceVersion, 1);
  assert.throws(() => f.domain.updateAudience({ conversationRef: direct.conversationRef, participants: [member('peer-2')], reasonRef: 'synthetic:dm-swap', expectedAudienceVersion: 1 }), code('AUDIENCE_MODE_CONFLICT'));
  assert.throws(() => f.domain.updateAudience({ conversationRef: direct.conversationRef, participants: [member('peer-1'), member('peer-2')], reasonRef: 'synthetic:dm-wide', expectedAudienceVersion: 1 }), code('AUDIENCE_MODE_CONFLICT'));
  assert.equal(f.domain.snapshot({}).conversations[0]!.audienceVersion, 1);
  // Group membership is a full versioned set; order is irrelevant but identity is not.
  const group = ensure(f.domain, alpha.connectionId, conversation('short-group-1', 'group'));
  const first = f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1'), member('u2'), member('bot-1', 'bot')], reasonRef: 'synthetic:group-join', expectedAudienceVersion: 0 });
  assert.equal(first.conversation.audienceVersion, 1); assert.equal(first.conversation.participants.length, 3);
  const reordered = f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('bot-1', 'bot'), member('u2'), member('u1')], reasonRef: 'synthetic:group-refresh', expectedAudienceVersion: 1 });
  assert.equal(reordered.change, undefined); assert.equal(reordered.conversation.audienceVersion, 1);
  const shrink = f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1'), member('u2')], reasonRef: 'synthetic:member-left', expectedAudienceVersion: 1 });
  assert.equal(shrink.conversation.audienceVersion, 2); assert.equal(shrink.change?.removed.length, 1);
  assert.equal(shrink.conversation.revokedParticipants.length, 1);
  assert.equal(shrink.change?.invalidationWatermark, 3, 'one invalidation per accepted audience change, including the initial direct set');
  assert.equal(f.domain.watermark().revocationWatermark, 1);
  const revokedRef = shrink.conversation.revokedParticipants[0]!.participantRef;
  assert.throws(() => f.domain.updateAudience({ conversationRef: group.conversationRef,
    participants: [member('u1'), member('u2'), member('bot-1', 'bot')], reasonRef: 'synthetic:re-add', expectedAudienceVersion: 2 }), code('PARTICIPANT_REVOKED'));
  assert.throws(() => f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1')], reasonRef: 'synthetic:stale-cas', expectedAudienceVersion: 1 }), code('VERSION_CONFLICT'));
  assert.throws(() => f.domain.updateAudience({ conversationRef: 'chconv-' + '0'.repeat(32), participants: [member('u1')], reasonRef: 'synthetic:unknown', expectedAudienceVersion: 0 }), code('UNKNOWN_CONVERSATION'));
  const revocations = f.domain.revocationsAfter({});
  assert.equal(revocations.length, 1); assert.equal(revocations[0]!.participantRef, revokedRef);
  assert.equal(revocations[0]!.scope, 'participant'); assert.equal(revocations[0]!.audienceVersion, 2);
  assert.equal(f.domain.watermark().revocationWatermark, 1);
});

test('multi-member removals keep one audience version but one revocation watermark per participant', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), group = ensure(f.domain, alpha.connectionId, conversation('short-group-2', 'group'));
  f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1'), member('u2'), member('u3')], reasonRef: 'synthetic:join', expectedAudienceVersion: 0 });
  const removed = f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u3')], reasonRef: 'synthetic:two-left', expectedAudienceVersion: 1 });
  assert.equal(removed.conversation.audienceVersion, 2);
  assert.equal(removed.change?.removed.length, 2);
  assert.deepEqual(removed.change?.removed, [...removed.change!.removed].sort());
  const revocations = f.domain.revocationsAfter({});
  assert.equal(revocations.length, 2);
  assert.deepEqual(revocations.map(value => value.watermark), [1, 2]);
  assert.deepEqual(new Set(revocations.map(value => value.participantRef)), new Set(removed.change!.removed));
  assert.deepEqual(f.domain.revocationsAfter({ afterWatermark: 1 }).map(value => value.watermark), [2]);
  assert.deepEqual(f.domain.revocationsAfter({ afterWatermark: 2 }), []);
  assert.equal(f.domain.watermark().revocationWatermark, 2);
});

test('explicit revocation fences participant and whole-conversation access and blocks new intake', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), group = ensure(f.domain, alpha.connectionId, conversation('short-group-3', 'group'));
  f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1'), member('u2')], reasonRef: 'synthetic:join', expectedAudienceVersion: 0 });
  const capture = f.domain.captureAudience({ conversationRef: group.conversationRef });
  const message = ingest(f.domain, alpha.connectionId, conversation('short-group-3', 'group'), [createEvent('m1')]).results[0]!;
  const participantRef = f.domain.getMessage({ messageId: message.messageId! }).participantRef;
  const revokedParticipant = f.domain.revokeAccess({ conversationRef: group.conversationRef, scope: 'participant',
    participantRef, reasonRef: 'synthetic:removed-by-owner', expectedAudienceVersion: 1 });
  assert.equal(revokedParticipant.conversation.audienceVersion, 2);
  assert.equal(revokedParticipant.revocation.scope, 'participant'); assert.equal(revokedParticipant.revocation.watermark, 1);
  assert.equal(revokedParticipant.conversation.revokedParticipants.length, 1);
  assert.throws(() => f.domain.readContentRefs({ captureId: capture.captureId, messageIds: [message.messageId!] }), code('STALE_AUDIENCE'));
  assert.throws(() => f.domain.revokeAccess({ conversationRef: group.conversationRef, scope: 'participant', participantRef,
    reasonRef: 'synthetic:again', expectedAudienceVersion: 2 }), code('PARTICIPANT_NOT_IN_AUDIENCE'));
  assert.throws(() => f.domain.revokeAccess({ conversationRef: group.conversationRef, scope: 'participant', participantRef,
    reasonRef: 'synthetic:stale', expectedAudienceVersion: 1 }), code('VERSION_CONFLICT'));
  assert.throws(() => f.domain.revokeAccess({ conversationRef: group.conversationRef, scope: 'conversation', participantRef,
    reasonRef: 'synthetic:bad-scope', expectedAudienceVersion: 2 }), code('INVALID_SCHEMA'));
  const revokedConversation = f.domain.revokeAccess({ conversationRef: group.conversationRef, scope: 'conversation',
    reasonRef: 'synthetic:channel-revoked', expectedAudienceVersion: 2 });
  assert.equal(revokedConversation.conversation.audienceVersion, 3);
  assert.equal(revokedConversation.conversation.audienceStatus, 'revoked');
  assert.equal(revokedConversation.revocation.scope, 'conversation'); assert.equal(revokedConversation.revocation.watermark, 2);
  assert.throws(() => f.domain.captureAudience({ conversationRef: group.conversationRef }), code('CONVERSATION_REVOKED'));
  const late = ingest(f.domain, alpha.connectionId, conversation('short-group-3', 'group'), [createEvent('m2')]).results[0]!;
  assert.equal(late.status, 'rejected'); assert.equal(late.reasonCode, 'CONVERSATION_REVOKED');
  assert.equal(f.rows('shiyu_channel_messages').length, 1);
  assert.throws(() => f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u9')],
    reasonRef: 'synthetic:too-late', expectedAudienceVersion: 3 }), code('CONVERSATION_REVOKED'));
  const invalidations = f.domain.invalidationsAfter({});
  assert.deepEqual(invalidations.map(value => value.type), ['audience_changed', 'participant_revoked', 'conversation_access_revoked']);
  assert.deepEqual(invalidations.map(value => value.watermark), [1, 2, 3]);
  assert.equal(invalidations[1]!.participantRef, participantRef);
  assert.equal(invalidations[2]!.conversationRef, group.conversationRef);
  assert.equal(f.domain.watermark().invalidationWatermark, 3);
});

test('two-phase capture exposes content references only after re-validating audience and snapshot', t => {
  const f = fixture(t);
  const alpha = connect(f.domain);
  const a = ensure(f.domain, alpha.connectionId, conversation('conversation-a', 'group'));
  const b = ensure(f.domain, alpha.connectionId, conversation('conversation-b', 'group'));
  const aMessage = ingest(f.domain, alpha.connectionId, conversation('conversation-a', 'group'), [createEvent('a-message')]).results[0]!;
  const bMessage = ingest(f.domain, alpha.connectionId, conversation('conversation-b', 'group'), [createEvent('b-message')]).results[0]!;
  const captureA = f.domain.captureAudience({ conversationRef: a.conversationRef });
  const serialized = JSON.stringify(captureA);
  for (const canary of ['native-body:a-message', 'summary a-message', 'native-body:b-message', 'summary b-message']) {
    assert.ok(!serialized.includes(canary), `metadata capture leaked ${canary}`);
  }
  assert.equal(captureA.messages.length, 1); assert.equal(captureA.messages[0]!.messageId, aMessage.messageId);
  assert.ok(!('bodyRef' in captureA.messages[0]!) && !('summary' in captureA.messages[0]!));
  assert.equal(captureA.messages[0]!.hasBodyRef, true);
  const metadata = f.domain.getMessage({ messageId: aMessage.messageId! });
  assert.ok(!('bodyRef' in metadata) && !('summary' in metadata));
  const contentA = f.domain.readContentRefs({ captureId: captureA.captureId, messageIds: [aMessage.messageId!] });
  assert.equal(contentA.conversationRef, a.conversationRef);
  assert.equal(contentA.content[0]!.bodyRef, 'native-body:a-message');
  assert.equal(contentA.content[0]!.summary, 'summary a-message');
  assert.ok(!JSON.stringify(contentA).includes('b-message'));
  assert.throws(() => f.domain.readContentRefs({ captureId: captureA.captureId, messageIds: [bMessage.messageId!] }), code('CROSS_AUDIENCE'));
  assert.throws(() => f.domain.readContentRefs({ captureId: captureA.captureId, messageIds: ['chmsg-' + '0'.repeat(40)] }), code('CROSS_AUDIENCE'));
  // A content edit after capture cannot be served under the old snapshot token.
  ingest(f.domain, alpha.connectionId, conversation('conversation-a', 'group'), [editEvent('a-message', 2)]);
  assert.throws(() => f.domain.readContentRefs({ captureId: captureA.captureId, messageIds: [aMessage.messageId!] }), code('STALE_CAPTURE'));
  const captureA2 = f.domain.captureAudience({ conversationRef: a.conversationRef });
  assert.equal(f.domain.readContentRefs({ captureId: captureA2.captureId, messageIds: [aMessage.messageId!] }).content[0]!.revision, 2);
  // A later message is outside an older capture even in the same conversation.
  const later = ingest(f.domain, alpha.connectionId, conversation('conversation-a', 'group'), [createEvent('a-later')]).results[0]!;
  assert.throws(() => f.domain.readContentRefs({ captureId: captureA2.captureId, messageIds: [later.messageId!] }), code('CROSS_AUDIENCE'));
  // An audience change invalidates every outstanding capture of that conversation.
  f.domain.updateAudience({ conversationRef: a.conversationRef, participants: [member('u1'), member('u2')], reasonRef: 'synthetic:join-a', expectedAudienceVersion: 0 });
  assert.throws(() => f.domain.readContentRefs({ captureId: captureA2.captureId, messageIds: [aMessage.messageId!] }), code('STALE_AUDIENCE'));
  assert.throws(() => f.domain.captureAudience({ conversationRef: a.conversationRef, expectedAudienceVersion: 0 }), code('STALE_AUDIENCE'));
  assert.equal(f.domain.captureAudience({ conversationRef: a.conversationRef, expectedAudienceVersion: 1 }).audienceVersion, 1);
  assert.equal(bMessage.status, 'accepted');
  const captureB = f.domain.captureAudience({ conversationRef: b.conversationRef });
  assert.equal(f.domain.readContentRefs({ captureId: captureB.captureId, messageIds: [bMessage.messageId!] }).content[0]!.bodyRef, 'native-body:b-message');
});

test('capture expiry and defensive capture capacity prune only expired snapshots', t => {
  const f = fixture(t, { limits: { captureTtlMs: 1_000, maxCaptures: 1 } });
  const alpha = connect(f.domain), group = ensure(f.domain, alpha.connectionId, conversation('short-group-4', 'group'));
  ingest(f.domain, alpha.connectionId, conversation('short-group-4', 'group'), [createEvent('m1')]);
  const capture = f.domain.captureAudience({ conversationRef: group.conversationRef });
  assert.throws(() => f.domain.captureAudience({ conversationRef: group.conversationRef }), code('CHANNEL_CAPACITY'));
  f.clock('2026-11-02T12:00:02.000Z');
  assert.throws(() => f.domain.readContentRefs({ captureId: capture.captureId, messageIds: [capture.messages[0]!.messageId] }), code('EXPIRED'));
  const fresh = f.domain.captureAudience({ conversationRef: group.conversationRef });
  assert.equal(f.rows('shiyu_channel_captures').length, 1);
  assert.equal(f.domain.readContentRefs({ captureId: fresh.captureId, messageIds: [fresh.messages[0]!.messageId] }).content.length, 1);
});

test('invalidation/deletion/revocation queries are monotonic, ordered and bounded', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), group = ensure(f.domain, alpha.connectionId, conversation('short-group-5', 'group'));
  assert.deepEqual(f.domain.watermark(), { intakeSeq: 0, invalidationWatermark: 0, deletionWatermark: 0, revocationWatermark: 0 });
  f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1'), member('u2')], reasonRef: 'synthetic:join', expectedAudienceVersion: 0 });
  const created = ingest(f.domain, alpha.connectionId, conversation('short-group-5', 'group'), [createEvent('m1')]).results[0]!;
  ingest(f.domain, alpha.connectionId, conversation('short-group-5', 'group'), [tombstoneEvent('m1', 2, 'message.delete')]);
  f.domain.revokeAccess({ conversationRef: group.conversationRef, scope: 'participant',
    participantRef: f.domain.getMessage({ messageId: created.messageId! }).participantRef, reasonRef: 'synthetic:revoke', expectedAudienceVersion: 1 });
  const watermark = f.domain.watermark();
  assert.equal(watermark.intakeSeq, 2);
  assert.equal(watermark.invalidationWatermark, 3);
  assert.equal(watermark.deletionWatermark, 1);
  assert.equal(watermark.revocationWatermark, 1);
  const invalidations = f.domain.invalidationsAfter({});
  assert.deepEqual(invalidations.map(value => value.type), ['audience_changed', 'message_deleted', 'participant_revoked']);
  assert.deepEqual(invalidations.map(value => value.watermark), [1, 2, 3]);
  assert.equal(invalidations[1]!.messageId, created.messageId);
  assert.deepEqual(f.domain.invalidationsAfter({ afterWatermark: 1, limit: 1 }).map(value => value.watermark), [2]);
  assert.deepEqual(f.domain.invalidationsAfter({ afterWatermark: 3 }), []);
  assert.equal(f.domain.deletionsAfter({}).length, 1);
  assert.equal(f.domain.revocationsAfter({}).length, 1, 'explicit participant revocation after the membership update');
  assert.throws(() => f.domain.invalidationsAfter({ limit: 0 }), code('INVALID_SCHEMA'));
  assert.throws(() => f.domain.deletionsAfter({ afterWatermark: -1 }), code('INVALID_SCHEMA'));
  assert.throws(() => f.domain.revocationsAfter({ limit: 201 }), code('INVALID_SCHEMA'));
});

test('trusted invalidation signals fire in the same transaction and a sink failure rolls the change back', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), group = ensure(f.domain, alpha.connectionId, conversation('short-group-6', 'group'));
  f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1'), member('u2')], reasonRef: 'synthetic:join', expectedAudienceVersion: 0 });
  assert.equal(f.sink.calls.length, 1);
  assert.equal(f.sink.calls[0]!.type, 'audience_changed'); assert.equal(f.sink.calls[0]!.connectionId, alpha.connectionId);
  assert.deepEqual(f.sink.calls[0]!.removedParticipants, []);
  const created = ingest(f.domain, alpha.connectionId, conversation('short-group-6', 'group'), [createEvent('m1')]).results[0]!;
  f.sink.calls.length = 0;
  f.sink.fail = true;
  assert.throws(() => f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1')],
    reasonRef: 'synthetic:removal-fails', expectedAudienceVersion: 1 }), /synthetic_sink_failure/);
  assert.equal(f.domain.snapshot({}).conversations[0]!.audienceVersion, 1);
  assert.equal(f.rows('shiyu_channel_invalidations').length, 1);
  assert.equal(f.rows('shiyu_channel_revocations').length, 0);
  assert.throws(() => ingest(f.domain, alpha.connectionId, conversation('short-group-6', 'group'), [tombstoneEvent('m1', 2, 'message.delete')]), /synthetic_sink_failure/);
  assert.equal(f.domain.getMessage({ messageId: created.messageId! }).status, 'active');
  assert.equal(f.domain.watermark().deletionWatermark, 0);
  assert.equal(f.rows('shiyu_channel_deletions').length, 0);
  f.sink.fail = false;
  f.domain.updateAudience({ conversationRef: group.conversationRef, participants: [member('u1')], reasonRef: 'synthetic:removal', expectedAudienceVersion: 1 });
  ingest(f.domain, alpha.connectionId, conversation('short-group-6', 'group'), [tombstoneEvent('m1', 2, 'message.delete')]);
  assert.deepEqual(f.sink.calls.map(value => value.type), ['audience_changed', 'message_deleted']);
  assert.ok(f.sink.calls.every(value => Number.isSafeInteger(value.watermark) && value.watermark > 0));
});

test('read-only channel queries never write', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), group = ensure(f.domain, alpha.connectionId, conversation('short-group-7', 'group'));
  const created = ingest(f.domain, alpha.connectionId, conversation('short-group-7', 'group'), [createEvent('m1')]).results[0]!;
  const capture = f.domain.captureAudience({ conversationRef: group.conversationRef });
  const before = f.totalChanges();
  for (let index = 0; index < 100; index++) {
    f.domain.getMessage({ messageId: created.messageId! });
    f.domain.getParticipant({ participantRef: f.domain.getMessage({ messageId: created.messageId! }).participantRef });
    f.domain.watermark();
    f.domain.invalidationsAfter({});
    f.domain.deletionsAfter({});
    f.domain.revocationsAfter({});
    f.domain.snapshot({});
    f.domain.readContentRefs({ captureId: capture.captureId, messageIds: [created.messageId!] });
  }
  assert.equal(f.totalChanges(), before);
  assert.equal((f.domain.execute({ command: 'channel.status', args: {} }) as { ready: boolean }).ready, true);
});
