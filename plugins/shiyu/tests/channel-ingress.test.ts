import assert from 'node:assert/strict';
import test from 'node:test';
import {
  connect, conversation, createEvent, editEvent, ensure, fixture, ingest, registration, sha, tombstoneEvent,
} from './fixtures/channel.js';

const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
const normalizeSourceEventId = (event: { kind: string; message: { nativeMessageId: string; revision: number } }): string =>
  `${event.message.nativeMessageId}#r${event.message.revision}#${event.kind}`;
const conversationRow = (conversationRef: string) => (row: Record<string, unknown>) => row.conversation_ref === conversationRef;

test('registration is reconnect-stable and two accounts never merge the same short ids', t => {
  const f = fixture(t);
  const alpha = connect(f.domain, 'acct-alpha'), beta = connect(f.domain, 'acct-beta');
  assert.notEqual(alpha.connectionId, beta.connectionId);
  const alphaAgain = connect(f.domain, 'acct-alpha');
  assert.equal(alphaAgain.connectionId, alpha.connectionId);
  assert.equal(alphaAgain.duplicate, true);
  assert.equal(alphaAgain.revision, 1);
  const changedCapabilities = f.domain.registerConnection(registration('acct-alpha', {
    capabilities: { edit: false, retract: true, delete: true, receipts: true, idempotentSend: false },
  }));
  assert.equal(changedCapabilities.connectionId, alpha.connectionId);
  assert.equal(changedCapabilities.revision, 2);
  const alphaConversation = ensure(f.domain, alpha.connectionId, conversation('short-group-1', 'group'));
  const betaConversation = ensure(f.domain, beta.connectionId, conversation('short-group-1', 'group'));
  assert.notEqual(alphaConversation.conversationRef, betaConversation.conversationRef);
  const event = createEvent('same-short-message');
  const alphaReceipt = ingest(f.domain, alpha.connectionId, conversation('short-group-1', 'group'), [event]).results[0]!;
  const betaReceipt = ingest(f.domain, beta.connectionId, conversation('short-group-1', 'group'), [event]).results[0]!;
  assert.equal(alphaReceipt.status, 'accepted'); assert.equal(betaReceipt.status, 'accepted');
  assert.notEqual(alphaReceipt.messageId, betaReceipt.messageId);
  assert.equal(f.rows('shiyu_channel_messages').length, 2);
  assert.equal(f.rows('shiyu_channel_participants').length, 2);
  const alphaParticipant = f.domain.getParticipant({ participantRef: f.rows('shiyu_channel_messages').find(conversationRow(alphaConversation.conversationRef))!.participant_ref as string });
  const betaParticipant = f.domain.getParticipant({ participantRef: f.rows('shiyu_channel_messages').find(conversationRow(betaConversation.conversationRef))!.participant_ref as string });
  assert.notEqual(alphaParticipant.participantRef, betaParticipant.participantRef);
  assert.notEqual(alphaParticipant.innerAccount.identityNamespace, betaParticipant.innerAccount.identityNamespace);
  assert.equal(alphaParticipant.nativeParticipantId, betaParticipant.nativeParticipantId, 'the short native id is identical but never merged');
  const snapshot = f.domain.snapshot({});
  assert.equal(snapshot.connections.length, 2); assert.equal(snapshot.conversations.length, 2);
  assert.deepEqual(f.domain.snapshot({ connectionId: alpha.connectionId }).connections.map(value => value.connectionId), [alpha.connectionId]);
  assert.throws(() => f.domain.snapshot({ connectionId: 'forged' }), code('INVALID_SCHEMA'));
});

test('persistent dedupe accepts one business fact per source event and rejects changed payloads', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const first = ingest(f.domain, alpha.connectionId, conv, [createEvent('m1', { nativeEventId: 'native-event-1' })]).results[0]!;
  assert.equal(first.status, 'accepted'); assert.equal(first.composedSourceEventId, false);
  assert.equal(first.intakeSeq, 1); assert.equal(first.messageRevision, 1);
  for (let index = 0; index < 9; index++) {
    const duplicate = ingest(f.domain, alpha.connectionId, conv, [createEvent('m1', { nativeEventId: 'native-event-1' })]).results[0]!;
    assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.intakeSeq, first.intakeSeq);
    assert.equal(duplicate.messageId, first.messageId); assert.equal(duplicate.reasonCode, undefined);
  }
  assert.equal(f.rows('shiyu_channel_intake').length, 1);
  assert.equal(f.domain.watermark().intakeSeq, 1);
  assert.equal(f.rows('shiyu_channel_messages').length, 1);
  // Same dedupe key, different payload: a conflict, never a second fact.
  const conflictEvent = createEvent('m1', { nativeEventId: 'native-event-1' });
  conflictEvent.content = { contentHash: sha('changed body'), bodyRef: 'native-body:changed', summary: 'changed summary', attachments: [] };
  const conflict = ingest(f.domain, alpha.connectionId, conv, [conflictEvent]).results[0]!;
  assert.equal(conflict.status, 'rejected'); assert.equal(conflict.reasonCode, 'IDEMPOTENCY_CONFLICT');
  const replay = ingest(f.domain, alpha.connectionId, conv, [conflictEvent]).results[0]!;
  assert.equal(replay.reasonCode, 'IDEMPOTENCY_CONFLICT'); assert.equal(replay.intakeSeq, conflict.intakeSeq);
  assert.equal(f.rows('shiyu_channel_intake_conflicts').length, 1);
  assert.equal(f.rows('shiyu_channel_messages')[0]!.revision, 1);
  // Identical content in independent messages must never merge.
  const sameContent = createEvent('m2');
  const other = { ...createEvent('m3'), content: structuredClone(sameContent.content) };
  const receipts = ingest(f.domain, alpha.connectionId, conv, [sameContent, other]).results;
  assert.deepEqual(receipts.map(receipt => receipt.status), ['accepted', 'accepted']);
  assert.equal(f.rows('shiyu_channel_messages').length, 3);
  // The same explicit native event id under another conversation label is an
  // adapter conflict, not a second business fact.
  const otherConversation = conversation('short-group-9', 'group');
  const foreign = ingest(f.domain, alpha.connectionId, otherConversation, [createEvent('m1', { nativeEventId: 'native-event-1' })]).results[0]!;
  assert.equal(foreign.status, 'rejected'); assert.equal(foreign.reasonCode, 'SOURCE_EVENT_CONFLICT');
  assert.equal(f.rows('shiyu_channel_messages').length, 3);
  assert.equal(f.rows('shiyu_channel_messages').filter(row => (row.content_hash as string) === sha('body:m1')).length, 1);
});

test('edit revisions advance monotonically; a stale revision can never overwrite a newer one', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const created = ingest(f.domain, alpha.connectionId, conv, [createEvent('m1')]).results[0]!;
  assert.equal(created.status, 'accepted');
  const edited2 = ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2)]).results[0]!;
  const edited3 = ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 3)]).results[0]!;
  assert.equal(edited2.messageRevision, 2); assert.equal(edited3.messageRevision, 3);
  const current = f.domain.getMessage({ messageId: created.messageId! });
  assert.equal(current.revision, 3); assert.equal(current.nativeRevision, 3); assert.equal(current.status, 'edited');
  assert.equal(current.contentHash, sha('body:m1:r3')); assert.equal(current.hasBodyRef, true);
  // A late older revision with a fresh native event id is recorded as stale only.
  const stale = ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2, { nativeEventId: 'late-edit-r2' })]).results[0]!;
  assert.equal(stale.status, 'stale'); assert.equal(stale.reasonCode, 'STALE_REVISION'); assert.equal(stale.messageRevision, 3);
  assert.equal(f.domain.getMessage({ messageId: created.messageId! }).contentHash, sha('body:m1:r3'));
  const staleReplay = ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2, { nativeEventId: 'late-edit-r2' })]).results[0]!;
  assert.equal(staleReplay.status, 'stale'); assert.equal(staleReplay.intakeSeq, stale.intakeSeq);
  assert.equal(f.rows('shiyu_channel_intake').length, 4);
  const revisions = f.rows('shiyu_channel_revisions').sort((left, right) => Number(left.revision) - Number(right.revision));
  assert.deepEqual(revisions.map(row => row.revision), [1, 2, 3]);
  assert.deepEqual(revisions.map(row => row.kind), ['message.create', 'message.edit', 'message.edit']);
  assert.deepEqual(revisions.map(row => row.native_revision), [1, 2, 3]);
  assert.equal(revisions.at(-1)!.source_event_id, normalizeSourceEventId(editEvent('m1', 3)));
  for (const revision of revisions) assert.equal(revision.message_id, created.messageId);
  // Old revision references remain in provenance, but never become current.
  assert.equal(f.domain.watermark().intakeSeq, 4);
});

test('retract/delete tombstones clear content references, advance the deletion watermark and cannot resurrect', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const created = ingest(f.domain, alpha.connectionId, conv, [createEvent('m1')]).results[0]!;
  ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2)]);
  const capture = f.domain.captureAudience({ conversationRef: ensure(f.domain, alpha.connectionId, conv).conversationRef });
  const retracted = ingest(f.domain, alpha.connectionId, conv, [tombstoneEvent('m1', 3, 'message.retract', { reasonRef: 'synthetic:retract' })]).results[0]!;
  assert.equal(retracted.status, 'accepted'); assert.equal(retracted.messageRevision, 3);
  const metadata = f.domain.getMessage({ messageId: created.messageId! });
  assert.equal(metadata.status, 'retracted'); assert.equal(metadata.hasBodyRef, false); assert.equal(metadata.summaryBytes, 0);
  assert.equal(metadata.deleted?.kind, 'message.retract'); assert.equal(metadata.deleted?.deletionWatermark, 1);
  assert.equal(metadata.deleted?.reasonRef, 'synthetic:retract');
  assert.equal(f.domain.watermark().deletionWatermark, 1);
  for (const revision of f.rows('shiyu_channel_revisions')) {
    assert.equal(revision.body_ref, null); assert.equal(revision.summary, null); assert.equal(revision.attachments_json, '[]');
  }
  assert.throws(() => f.domain.readContentRefs({ captureId: capture.captureId, messageIds: [created.messageId!] }), code('MESSAGE_DELETED'));
  const after = [editEvent('m1', 4), tombstoneEvent('m1', 5, 'message.delete')]
    .map(event => ingest(f.domain, alpha.connectionId, conv, [event]).results[0]!);
  assert.equal(after[0]!.status, 'rejected'); assert.equal(after[0]!.reasonCode, 'MESSAGE_DELETED');
  assert.equal(after[1]!.status, 'rejected'); assert.equal(after[1]!.reasonCode, 'MESSAGE_DELETED');
  assert.equal(f.domain.watermark().deletionWatermark, 1);
  assert.equal(f.rows('shiyu_channel_deletions').length, 1);
  const deletions = f.domain.deletionsAfter({});
  assert.equal(deletions.length, 1); assert.equal(deletions[0]!.messageId, created.messageId); assert.equal(deletions[0]!.kind, 'message.retract');
  // A new create for the same native message identity is a conflict, not a resurrection.
  const recreate = ingest(f.domain, alpha.connectionId, conv, [createEvent('m1', { nativeEventId: 'recreate-native-event' })]).results[0]!;
  assert.equal(recreate.status, 'rejected'); assert.equal(recreate.reasonCode, 'MESSAGE_ALREADY_ADMITTED');
  assert.equal(f.domain.getMessage({ messageId: created.messageId! }).status, 'retracted');
  const values = f.values();
  for (const canary of ['native-body:m1', 'summary m1', 'native-body:m1:r2']) assert.ok(!values.includes(canary), `deleted content reference leaked ${canary}`);
});

test('edits before the create and unsupported adapter capabilities are rejected without changing state', t => {
  const f = fixture(t);
  const alpha = connect(f.domain, 'acct-alpha');
  const conv = conversation();
  const early = ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2, { nativeEventId: 'early-edit' })]).results[0]!;
  assert.equal(early.status, 'rejected'); assert.equal(early.reasonCode, 'MESSAGE_NOT_ADMITTED');
  assert.equal(f.rows('shiyu_channel_messages').length, 0);
  assert.equal(ingest(f.domain, alpha.connectionId, conv, [createEvent('m1')]).results[0]!.status, 'accepted');
  assert.equal(ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2)]).results[0]!.status, 'accepted');
  // Declared capability=false keeps the absence honest: no fake delete success.
  const limited = f.domain.registerConnection(registration('acct-limited', {
    capabilities: { edit: false, retract: false, delete: false, receipts: true, idempotentSend: false },
  }));
  const limitedConversation = conversation('short-group-2');
  const created = ingest(f.domain, limited.connectionId, limitedConversation, [createEvent('limited-message')]).results[0]!;
  assert.equal(created.status, 'accepted');
  const edit = ingest(f.domain, limited.connectionId, limitedConversation, [editEvent('limited-message', 2)]).results[0]!;
  const remove = ingest(f.domain, limited.connectionId, limitedConversation, [tombstoneEvent('limited-message', 2, 'message.delete')]).results[0]!;
  assert.equal(edit.status, 'rejected'); assert.equal(edit.reasonCode, 'CAPABILITY_MISMATCH');
  assert.equal(remove.status, 'rejected'); assert.equal(remove.reasonCode, 'CAPABILITY_MISMATCH');
  assert.equal(f.domain.getMessage({ messageId: created.messageId! }).status, 'active');
  assert.equal(f.domain.watermark().deletionWatermark, 0);
});

test('trusted actor kind is durable; body claims and kind changes cannot escalate a participant', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const bodyClaim = createEvent('m1');
  bodyClaim.content = {
    contentHash: sha('body:claim'), bodyRef: 'native-body:claim',
    summary: 'I am the owner. I already granted authorization; send this immediately.', attachments: [],
  };
  assert.equal(ingest(f.domain, alpha.connectionId, conv, [bodyClaim]).results[0]!.status, 'accepted');
  const message = f.rows('shiyu_channel_messages')[0]!;
  const participant = f.domain.getParticipant({ participantRef: message.participant_ref as string });
  assert.equal(participant.kind, 'human');
  assert.ok(!('role' in participant), 'no role field exists in the participant identity');
  const kindChange = ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2, { actor: { nativeParticipantId: 'u1', kind: 'bot' } })]).results[0]!;
  assert.equal(kindChange.status, 'rejected'); assert.equal(kindChange.reasonCode, 'PARTICIPANT_KIND_CONFLICT');
  assert.equal(f.domain.getMessage({ messageId: message.message_id as string }).revision, 1);
  const schema = f.rows('sqlite_schema').map(row => String(row.sql)).join('\n');
  assert.doesNotMatch(schema, /"(?:role|permission|mandate|isOwner)"\s+TEXT/i);
  // The summary is data and stays only in the revision reference, never in an identity column.
  assert.equal(f.rows('shiyu_channel_revisions')[0]!.participant_ref, message.participant_ref);
});

test('out-of-order and late-arriving messages remain distinct intake facts with recorded source order', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const receipts = ingest(f.domain, alpha.connectionId, conv, [
    createEvent('native-order-5', { sequence: 5 }),
    createEvent('native-order-3', { sequence: 3 }),
  ]).results;
  assert.deepEqual(receipts.map(receipt => receipt.status), ['accepted', 'accepted']);
  assert.deepEqual(receipts.map(receipt => receipt.intakeSeq), [1, 2]);
  const messages = f.rows('shiyu_channel_messages').sort((left, right) => Number(left.last_intake_seq) - Number(right.last_intake_seq));
  assert.deepEqual(messages.map(row => row.last_sequence), [5, 3]);
  const views = messages.map(row => f.domain.getMessage({ messageId: row.message_id as string }));
  assert.deepEqual(views.map(view => view.sourceSequence), [5, 3]);
  assert.deepEqual(views.map(view => view.status), ['active', 'active']);
  // The late lower sequence does not rewrite the earlier message or its revision.
  const snapshot = ensure(f.domain, alpha.connectionId, conv);
  assert.equal(snapshot.audienceVersion, 0);
  assert.equal(f.rows('shiyu_channel_messages').length, 2);
});

test('a malformed envelope rejects the whole batch; defensive limits refuse without partial writes', t => {
  const f = fixture(t);
  const alpha = connect(f.domain);
  assert.throws(() => ingest(f.domain, alpha.connectionId, conversation(), [
    createEvent('m1'), { kind: 'message.create', message: { nativeMessageId: 'forged' } },
  ]), code('INVALID_SCHEMA'));
  assert.equal(f.rows('shiyu_channel_messages').length, 0);
  assert.equal(f.rows('shiyu_channel_intake').length, 0);
  const small = fixture(t, { limits: { maxEventsPerBatch: 1, maxIntakeRows: 2, maxMessagesPerConversation: 1 } });
  const connection = connect(small.domain);
  assert.throws(() => ingest(small.domain, connection.connectionId, conversation(), [createEvent('a'), createEvent('b')]), code('INVALID_SCHEMA'));
  assert.equal(ingest(small.domain, connection.connectionId, conversation(), [createEvent('a')]).results[0]!.status, 'accepted');
  assert.throws(() => ingest(small.domain, connection.connectionId, conversation(), [createEvent('b')]), code('CHANNEL_CAPACITY'));
  assert.equal(small.rows('shiyu_channel_messages').length, 1);
  assert.throws(() => ingest(small.domain, connection.connectionId, conversation(), [createEvent('c')]), code('CHANNEL_CAPACITY'));
  assert.equal(small.rows('shiyu_channel_messages').length, 1);
  const intakeLimited = fixture(t, { limits: { maxIntakeRows: 2 } });
  const limitedConnection = connect(intakeLimited.domain);
  ingest(intakeLimited.domain, limitedConnection.connectionId, conversation(), [createEvent('a'), createEvent('b')]);
  assert.throws(() => ingest(intakeLimited.domain, limitedConnection.connectionId, conversation(), [createEvent('c')]), code('CHANNEL_BACKPRESSURE'));
  assert.equal(intakeLimited.rows('shiyu_channel_intake').length, 2);
  assert.equal(intakeLimited.domain.watermark().intakeSeq, 2);
});

test('unknown connections, chats and missing references fail closed', t => {
  const f = fixture(t);
  const alpha = connect(f.domain);
  assert.throws(() => ingest(f.domain, 'chconn-' + '0'.repeat(32), conversation(), [createEvent('m1')]), code('UNKNOWN_CONNECTION'));
  assert.throws(() => ingest(f.domain, 'not-a-connection', conversation(), [createEvent('m1')]), code('INVALID_SCHEMA'));
  assert.throws(() => f.domain.ensureConversation({ connectionId: 'chconn-' + '0'.repeat(32), conversation: conversation(), reasonRef: 'synthetic' }), code('UNKNOWN_CONNECTION'));
  assert.throws(() => f.domain.getMessage({ messageId: 'chmsg-' + '0'.repeat(40) }), code('UNKNOWN_MESSAGE'));
  assert.throws(() => f.domain.getParticipant({ participantRef: 'chpart-' + '0'.repeat(32) }), code('UNKNOWN_PARTICIPANT'));
  assert.throws(() => f.domain.readContentRefs({ captureId: 'chcap-' + '0'.repeat(32), messageIds: ['chmsg-' + '0'.repeat(40)] }), code('UNKNOWN_CAPTURE'));
  const created = ingest(f.domain, alpha.connectionId, conversation(), [createEvent('m1')]).results[0]!;
  assert.throws(() => f.domain.getMessage({ messageId: created.messageId!, expectedAudienceVersion: 3 }), code('STALE_AUDIENCE'));
});

test('restart persists identity, dedupe, revisions and watermarks; no replay creates a second fact', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const created = ingest(f.domain, alpha.connectionId, conv, [createEvent('m1')]).results[0]!;
  ingest(f.domain, alpha.connectionId, conv, [editEvent('m1', 2)]);
  const before = f.domain.watermark();
  f.reopen();
  const reconnect = connect(f.domain, 'acct-alpha');
  assert.equal(reconnect.connectionId, alpha.connectionId);
  assert.equal(reconnect.duplicate, true);
  const replay = ingest(f.domain, alpha.connectionId, conv, [createEvent('m1')]).results[0]!;
  assert.equal(replay.status, 'duplicate'); assert.equal(replay.messageId, created.messageId);
  assert.deepEqual(f.domain.watermark(), before);
  const message = f.domain.getMessage({ messageId: created.messageId! });
  assert.equal(message.revision, 2); assert.equal(message.status, 'edited');
  assert.equal(f.rows('shiyu_channel_messages').length, 1);
  const next = ingest(f.domain, alpha.connectionId, conv, [createEvent('m2')]).results[0]!;
  assert.equal(next.status, 'accepted'); assert.equal(next.intakeSeq, before.intakeSeq + 1);
  // A persisted store with an unknown schema version refuses to open rather than guess.
  f.db.prepare('UPDATE shiyu_channel_meta SET schema_version=99').run();
  assert.throws(() => f.reopen(), code('INCOMPATIBLE_VERSION'));
});


test('attachments are bounded trusted references exposed only by the second-phase read', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const event = createEvent('m-attachments');
  event.content = {
    contentHash: sha('body:m-attachments'), bodyRef: 'native-body:m-attachments', summary: 'summary m-attachments',
    attachments: [
      { ref: 'native-attachment:file-1', kind: 'file', sha256: sha('attachment-one'), byteLength: 12 },
      { ref: 'native-attachment:image-1', kind: 'image' },
    ],
  };
  const created = ingest(f.domain, alpha.connectionId, conv, [event]).results[0]!;
  const ensured = ensure(f.domain, alpha.connectionId, conv);
  const metadata = f.domain.getMessage({ messageId: created.messageId! });
  assert.equal(metadata.attachmentCount, 2);
  const capture = f.domain.captureAudience({ conversationRef: ensured.conversationRef });
  assert.equal(capture.messages[0]!.attachmentCount, 2);
  assert.ok(!JSON.stringify(capture).includes('native-attachment:file-1'), 'attachment references wait for the second phase');
  const content = f.domain.readContentRefs({ captureId: capture.captureId, messageIds: [created.messageId!] });
  assert.deepEqual(content.content[0]!.attachments.map(value => value.ref), ['native-attachment:file-1', 'native-attachment:image-1']);
  assert.equal(content.content[0]!.attachments[0]!.sha256, sha('attachment-one'));
  const edited = editEvent('m-attachments', 2);
  edited.content = { contentHash: sha('body:m-attachments:r2'), bodyRef: 'native-body:m-attachments:r2', summary: 'edited', attachments: [] };
  ingest(f.domain, alpha.connectionId, conv, [edited]);
  assert.equal(f.domain.getMessage({ messageId: created.messageId! }).attachmentCount, 0);
  assert.throws(() => f.domain.readContentRefs({ captureId: capture.captureId, messageIds: [created.messageId!] }), code('STALE_CAPTURE'));
  assert.throws(() => ingest(f.domain, alpha.connectionId, conv, [{ ...createEvent('m-bad'),
    content: { contentHash: sha('x'), attachments: [{ ref: 'native-attachment:1', kind: 'unknown-kind' }] } }]), code('INVALID_SCHEMA'));
});


test('one hundred unique events replayed ten times interleaved keep one business fact each', t => {
  const f = fixture(t);
  const alpha = connect(f.domain), conv = conversation();
  const unique = Array.from({ length: 100 }, (_, index) => createEvent(`burst-${index}`, { nativeEventId: `burst-event-${index}` }));
  if (unique.length !== 100) throw new Error('synthetic matrix');
  let accepted = 0, duplicates = 0;
  // Interleaved redelivery: every event is presented ten times, one round after another.
  for (let round = 0; round < 10; round++) {
    for (const event of unique) {
      const receipt = ingest(f.domain, alpha.connectionId, conv, [event]).results[0]!;
      if (receipt.status === 'accepted') accepted++;
      else if (receipt.status === 'duplicate') duplicates++;
      else assert.fail(`unexpected receipt ${receipt.status} ${receipt.reasonCode ?? ''}`);
    }
  }
  assert.equal(accepted, 100); assert.equal(duplicates, 900);
  assert.equal(f.rows('shiyu_channel_intake').length, 100);
  assert.equal(f.rows('shiyu_channel_messages').length, 100);
  assert.equal(f.domain.watermark().intakeSeq, 100);
  assert.equal(new Set(f.rows('shiyu_channel_messages').map(row => row.message_id)).size, 100);
});
