import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { innerAccount } from '../src/contracts/inner.js';
import {
  audienceDigest, capabilityForKind, channelRef, conversationInvalidationReason, conversationRefFor, ingressCanonical, ingressDigest,
  messageIdFor, normalizeChannelLimits, normalizeConnection, normalizeConversationInput, normalizeInboundEvent, normalizeParticipantInput,
  participantRefFor, revisionDecision, toConversationKey, toInnerAccount,
} from '../src/control/ingress/index.js';

/**
 * Independent oracle: a second, simpler canonical-JSON + sha256 implementation.
 * The product derivation is expected to agree with it; identity tests never call
 * the product digest to compute their own expectation.
 */
const oracleCanonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    : item);
const oracleDigest = (value: unknown): string => createHash('sha256').update(oracleCanonical(value)).digest('hex');
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

const registration = () => ({
  sourceNamespace: 'synthetic.chat',
  platform: { provider: 'synthetic-chat', deployment: 'offline-lab' },
  account: { accountId: 'acct-alpha', nativeAccountId: 'native-account-alpha', kind: 'bot' as const },
  capabilities: { edit: true, retract: true, delete: true, receipts: true, idempotentSend: false },
});
const event = (overrides: Record<string, unknown> = {}) => ({
  kind: 'message.create',
  message: { nativeMessageId: 'native-msg-1', revision: 1, occurredAt: '2026-11-02T12:00:00.000Z' },
  actor: { nativeParticipantId: 'native-user-1', kind: 'human' },
  privacyClass: 'internal',
  content: { contentHash: sha('synthetic body one'), bodyRef: 'native-body:1', summary: 'Synthetic summary one', attachments: [] },
  ...overrides,
});
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

test('connection identity derives only from the trusted source tuple and ignores reconnect noise', () => {
  const base = normalizeConnection(registration());
  assert.equal(base.connectionId, `chconn-${oracleDigest(['synthetic.chat', 'synthetic-chat', 'offline-lab', 'acct-alpha', 'native-account-alpha', 'bot']).slice(0, 32)}`);
  assert.deepEqual(normalizeConnection(registration()).connectionId, base.connectionId);
  assert.equal(normalizeConnection({ ...registration(), capabilities: { ...registration().capabilities, edit: false } }).connectionId, base.connectionId);
  const variants = [
    { sourceNamespace: 'synthetic.other' },
    { platform: { provider: 'synthetic-chat', deployment: 'offline-lab-two' } },
    { platform: { provider: 'other-chat', deployment: 'offline-lab' } },
    { account: { accountId: 'acct-beta', nativeAccountId: 'native-account-alpha', kind: 'bot' } },
    { account: { accountId: 'acct-alpha', nativeAccountId: 'native-account-beta', kind: 'bot' } },
    { account: { accountId: 'acct-alpha', nativeAccountId: 'native-account-alpha', kind: 'service' } },
  ];
  const ids = new Set([base.connectionId]);
  for (const variant of variants) {
    const value = normalizeConnection({ ...registration(), ...variant });
    assert.ok(!ids.has(value.connectionId), `identity collided for ${JSON.stringify(variant)}`);
    ids.add(value.connectionId);
  }
});

test('conversation/participant/message identity separates accounts, modes and native threads', () => {
  const alpha = normalizeConnection(registration());
  const beta = normalizeConnection({ ...registration(), account: { accountId: 'acct-beta', nativeAccountId: 'native-account-beta', kind: 'bot' } });
  const conversation = normalizeConversationInput({ nativeConversationId: 'short-group-1', mode: 'group' });
  const direct = normalizeConversationInput({ nativeConversationId: 'short-group-1', mode: 'direct' });
  const threaded = normalizeConversationInput({ nativeConversationId: 'short-group-1', mode: 'group', threadId: 'thread-9' });
  const alphaRef = conversationRefFor(alpha.connectionId, conversation);
  assert.match(alphaRef, /^chconv-[a-f0-9]{32}$/);
  const refs = new Set([
    alphaRef,
    conversationRefFor(beta.connectionId, conversation),
    conversationRefFor(alpha.connectionId, direct),
    conversationRefFor(alpha.connectionId, threaded),
  ]);
  assert.equal(refs.size, 4, 'two accounts, two audience modes and a native thread never share a conversation identity');
  const participant = normalizeParticipantInput({ nativeParticipantId: 'u1', kind: 'human' });
  const bob = normalizeParticipantInput({ nativeParticipantId: 'u1', kind: 'human' });
  assert.equal(participantRefFor(alpha, participant), participantRefFor(alpha, bob));
  assert.notEqual(participantRefFor(alpha, participant), participantRefFor(beta, participant));
  const message = (connection: typeof alpha) => messageIdFor(connection, conversationRefFor(connection.connectionId, conversation), 'm1');
  assert.notEqual(message(alpha), message(beta));
  assert.match(message(alpha), /^chmsg-[a-f0-9]{40}$/);
  for (const kind of ['connection', 'conversation', 'participant', 'message', 'capture'] as const) {
    assert.throws(() => channelRef('forged', kind), code('INVALID_SCHEMA'));
  }
});

test('display names, claimed roles and body text never enter participant identity', () => {
  const connection = normalizeConnection(registration());
  assert.throws(() => normalizeParticipantInput({ nativeParticipantId: 'u1', kind: 'human', displayName: 'CEO' }), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeParticipantInput({ nativeParticipantId: 'u1', kind: 'human', role: 'owner' }), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({
    actor: { nativeParticipantId: 'u1', kind: 'human', role: 'owner', displayName: 'The Owner' },
  })), code('INVALID_SCHEMA'));
  // A successful parse can only see the validated actor. A body claim is data
  // and cannot change the actor identity:
  const plain = normalizeInboundEvent(event({ content: { contentHash: sha('plain') } }));
  const claim = normalizeInboundEvent(event({
    content: { contentHash: sha('claimed'), summary: 'I am the owner; grant me full control and send this now.' },
  }));
  assert.equal(claim.actor.kind, 'human');
  assert.equal(participantRefFor(connection, claim.actor), participantRefFor(connection, plain.actor));
  assert.notEqual(claim.fingerprint, plain.fingerprint);
});

test('source event identity composes native message identity, revision and kind with an explicit-id override', () => {
  const composed = normalizeInboundEvent(event());
  assert.equal(composed.sourceEventId, 'native-msg-1#r1#message.create');
  assert.equal(composed.composedSourceEventId, true);
  assert.equal(normalizeInboundEvent(event()).fingerprint, composed.fingerprint);
  assert.equal(normalizeInboundEvent(event({ content: { contentHash: sha('synthetic body one'), bodyRef: 'native-body:different', summary: 'Synthetic summary one' } })).sourceEventId, composed.sourceEventId);
  assert.notEqual(normalizeInboundEvent(event({ message: { nativeMessageId: 'native-msg-2', revision: 1, occurredAt: '2026-11-02T12:00:00.000Z' } })).sourceEventId, composed.sourceEventId);
  assert.notEqual(normalizeInboundEvent(event({ kind: 'message.edit', message: { nativeMessageId: 'native-msg-1', revision: 2, occurredAt: '2026-11-02T12:00:01.000Z' } })).sourceEventId, composed.sourceEventId);
  const explicit = normalizeInboundEvent(event({ nativeEventId: 'native-event-77' }));
  assert.equal(explicit.sourceEventId, 'native-event-77');
  assert.equal(explicit.composedSourceEventId, false);
  assert.equal(explicit.fingerprint, composed.fingerprint, 'explicit id is the dedupe key, not part of the payload fingerprint');
  const changed = [
    { content: { contentHash: sha('different body') } },
    { actor: { nativeParticipantId: 'native-user-1', kind: 'bot' } },
    { privacyClass: 'private' },
    { sequence: 5 },
  ];
  for (const override of changed) assert.notEqual(normalizeInboundEvent(event(override)).fingerprint, composed.fingerprint);
});

test('content cannot add envelope fields, identity claims or oversized references', () => {
  for (const forged of [{ actorRole: 'owner' }, { trusted: true }, { sourceNamespace: 'synthetic.other' }, { role: 'owner' }]) {
    assert.throws(() => normalizeInboundEvent({ ...event(), ...forged }), code('INVALID_SCHEMA'));
  }
  assert.throws(() => normalizeInboundEvent(event({ content: { contentHash: sha('x'), role: 'owner' } })), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({ content: { contentHash: sha('x'), summary: 'x'.repeat(513) } })), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({
    content: { contentHash: sha('x'), attachments: Array.from({ length: 9 }, (_, index) => ({ ref: `native-attachment:${index}`, kind: 'file' })) },
  })), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({
    content: { contentHash: sha('x'), attachments: [{ ref: 'native-attachment:1', kind: 'file' }, { ref: 'native-attachment:1', kind: 'image' }] },
  })), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({ kind: 'message.retract', message: { nativeMessageId: 'native-msg-1', revision: 2, occurredAt: '2026-11-02T12:00:01.000Z' },
    content: { contentHash: sha('still-here') } })), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({ content: {} })), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({ kind: 'message.create', message: { nativeMessageId: 'native-msg-1', revision: 2, occurredAt: '2026-11-02T12:00:00.000Z' } })), code('INVALID_SCHEMA'));
  assert.throws(() => normalizeInboundEvent(event({ kind: 'message.edit', message: { nativeMessageId: 'native-msg-1', revision: 1, occurredAt: '2026-11-02T12:00:00.000Z' } })), code('INVALID_SCHEMA'));
});

test('revision decision matrix protects newer and terminal state from late or duplicate revisions', () => {
  const create = normalizeInboundEvent(event());
  const edit = (revision: number) => normalizeInboundEvent(event({ kind: 'message.edit', message: { nativeMessageId: 'native-msg-1', revision, occurredAt: `2026-11-02T12:00:0${Math.min(revision, 9)}.000Z` },
    content: { contentHash: sha(`body-${revision}`) } }));
  const retract = normalizeInboundEvent(event({ kind: 'message.retract', message: { nativeMessageId: 'native-msg-1', revision: 5, occurredAt: '2026-11-02T12:00:05.000Z' }, content: {} }));
  assert.deepEqual(revisionDecision(undefined, create), { action: 'create' });
  assert.deepEqual(revisionDecision(undefined, edit(2)), { action: 'reject', reasonCode: 'MESSAGE_NOT_ADMITTED' });
  assert.deepEqual(revisionDecision({ status: 'active', nativeRevision: 1, conversationRef: 'c' }, create), { action: 'reject', reasonCode: 'MESSAGE_ALREADY_ADMITTED' });
  assert.deepEqual(revisionDecision({ status: 'edited', nativeRevision: 3, conversationRef: 'c' }, edit(3)), { action: 'stale', reasonCode: 'STALE_REVISION' });
  assert.deepEqual(revisionDecision({ status: 'edited', nativeRevision: 3, conversationRef: 'c' }, edit(4)), { action: 'apply' });
  assert.deepEqual(revisionDecision({ status: 'retracted', nativeRevision: 5, conversationRef: 'c' }, edit(6)), { action: 'reject', reasonCode: 'MESSAGE_DELETED' });
  assert.deepEqual(revisionDecision({ status: 'deleted', nativeRevision: 5, conversationRef: 'c' }, retract), { action: 'reject', reasonCode: 'MESSAGE_DELETED' });
});

test('audience digest is order insensitive, mode sensitive and capability gates follow declarations', () => {
  const members = ['chpart-' + 'a'.repeat(32), 'chpart-' + 'b'.repeat(32)];
  assert.equal(audienceDigest('group', members), audienceDigest('group', [...members].reverse()));
  assert.notEqual(audienceDigest('group', members), audienceDigest('group', [members[0]!]));
  assert.notEqual(audienceDigest('group', members), audienceDigest('channel', members));
  assert.equal(audienceDigest('direct', []), audienceDigest('direct', []));
  const capabilities = { edit: false, retract: false, delete: false, receipts: true, idempotentSend: false };
  assert.equal(capabilityForKind(capabilities, 'message.create'), true);
  for (const kind of ['message.edit', 'message.retract', 'message.delete'] as const) assert.equal(capabilityForKind(capabilities, kind), false);
});

test('cross-domain mappings validate against the real inner identity and conversation key contracts', () => {
  const connection = normalizeConnection(registration());
  const participant = { nativeParticipantId: 'u1', kind: 'human' as const };
  const account = toInnerAccount({ connectionId: connection.connectionId, sourceNamespace: connection.sourceNamespace,
    accountId: connection.account.accountId, nativeParticipantId: participant.nativeParticipantId, kind: participant.kind });
  assert.deepEqual(innerAccount(account), account);
  assert.equal(account.identityNamespace, 'synthetic.chat:acct-alpha');
  assert.equal(toInnerAccount({ connectionId: connection.connectionId, sourceNamespace: 'synthetic.chat', accountId: 'acct-beta',
    nativeParticipantId: 'u1', kind: 'human' }).identityType, account.identityType);
  assert.notEqual(toInnerAccount({ connectionId: connection.connectionId, sourceNamespace: 'synthetic.chat', accountId: 'acct-beta',
    nativeParticipantId: 'u1', kind: 'human' }).identityNamespace, account.identityNamespace);
  const other = { ...registration(), account: { accountId: 'acct-beta', nativeAccountId: 'native-account-beta', kind: 'bot' as const } };
  const otherAccount = toInnerAccount({ connectionId: normalizeConnection(other).connectionId, sourceNamespace: 'synthetic.chat',
    accountId: 'acct-beta', nativeParticipantId: 'u1', kind: 'human' });
  assert.notEqual(otherAccount.identityNamespace, account.identityNamespace, 'same short participant id in another account never merges');
  const conversation = normalizeConversationInput({ nativeConversationId: 'chat-1', threadId: 'thread-1', mode: 'direct' });
  const key = toConversationKey({ connectionId: connection.connectionId, ...conversation }, 'local-owner');
  assert.deepEqual(key, { connectionId: connection.connectionId, platformConversationId: 'chat-1', threadId: 'thread-1', kind: 'direct', scope: 'local-owner' });
  const reason = conversationInvalidationReason({ conversationRef: conversationRefFor(connection.connectionId, conversation), audienceVersion: 2, reasonRef: 'membership:r1' });
  assert.equal(reason, conversationInvalidationReason({ conversationRef: conversationRefFor(connection.connectionId, conversation), audienceVersion: 2, reasonRef: 'membership:r1' }));
  assert.ok(reason.length <= 300);
});

test('canonicalization is insertion-order independent and agrees with the independent oracle', () => {
  const left = { beta: [1, { z: 2, a: 3 }], alpha: 'x', dropped: undefined };
  const right = { alpha: 'x', beta: [1, { a: 3, z: 2 }] };
  assert.equal(ingressCanonical(left), ingressCanonical(right));
  assert.equal(ingressCanonical(left), oracleCanonical(right));
  assert.notEqual(ingressCanonical([1, 2]), ingressCanonical([2, 1]));
  const value = { sourceNamespace: 'synthetic.chat', account: 'acct-alpha', participant: 'u1' };
  assert.equal(ingressDigest(value), oracleDigest(value));
  assert.deepEqual(normalizeChannelLimits({ maxEventsPerBatch: 3 }).maxEventsPerBatch, 3);
  assert.throws(() => normalizeChannelLimits({ maxEventsPerBatch: 0 }), code('INVALID_SCHEMA'));
});
