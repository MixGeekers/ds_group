import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { EmotionDomain } from '../src/adapters/control-store/emotion-domain.js';
import { RelationshipDomain } from '../src/adapters/control-store/relationship-domain.js';
import type { InnerConversationFacts, InnerEvidenceFacts, InnerSourceRef } from '../src/contracts/inner.js';

const start = '2026-11-02T12:00:00.000Z';
const dm = 'conversation-dm', group = 'conversation-group';
const code = (...codes: string[]) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-inner-emotion-'));
  const filename = join(directory, 'control.sqlite');
  const connections = new Set<DatabaseSync>();
  let clock = Date.parse(start);
  const conversations = new Map<string, InnerConversationFacts>([
    [dm, { audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1, audienceVersion: 1, active: true }],
    [group, { audience: { scope: 'local-owner', kind: 'group', audienceId: group }, revision: 1, audienceVersion: 1, active: true }],
  ]);
  const evidence = new Map<string, InnerEvidenceFacts>();
  const open = () => {
    const db = new DatabaseSync(filename); connections.add(db);
    db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000');
    const tx = new SqliteTransactions(db);
    const domain = new EmotionDomain(db, tx, {
      runtimeIdentity: { hostEpoch: 'inner-host', installationGeneration: 'inner-install' }, now: () => new Date(clock),
      resolveConversation: id => conversations.get(id),
      resolveEvidence: ref => evidence.get(`${ref.kind}:${ref.sourceId}@${ref.revision}`),
    });
    return { db, tx, domain, close() { if (connections.delete(db)) db.close(); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const f = open();
  const observation = (id = dm): InnerSourceRef => ({ kind: 'conversation-observation', sourceId: id, revision: 1 });
  const ownerCommand = (requestId: string): InnerSourceRef => ({ kind: 'owner-command', sourceId: `owner-command:${requestId}`, revision: 1 });
  const observe = (requestId: string, patch: Record<string, unknown> = {}) => f.domain.observe({ requestId, conversationId: dm,
    valenceBps: 7000, arousalBps: 4000, label: 'positive', sourceRefs: [observation()], ...patch });
  return { ...f, open, conversations, evidence, observation, ownerCommand, observe,
    advance(ms: number) { clock += ms; }, now: () => clock,
    pure<T>(read: () => T): { value: T; changes: number } { const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n); const value = read(); return { value, changes: Number(f.db.prepare('SELECT total_changes() AS n').get()!.n) - before }; } };
}

test('current state is a deterministic, explainable projection of sourced observations at a fixed clock', t => {
  const f = fixture(t);
  f.observe('one', { valenceBps: 8000, arousalBps: 2000, label: 'positive' });
  f.advance(21_600_000);
  f.observe('two', { valenceBps: 4000, arousalBps: 8000, label: 'low' });
  const first = f.domain.state({ conversationId: dm }), second = f.domain.state({ conversationId: dm });
  assert.deepEqual(first, second);
  assert.equal(first.computedAt, new Date(f.now()).toISOString());
  assert.equal(first.subject, 'system-state'); assert.equal(first.humanFeeling, false); assert.equal(first.authorityEffect, 'none');
  assert.deepEqual(first.policy.halfLifeMs, 21_600_000); assert.equal(first.policy.policyVersion, 1);
  assert.equal(first.contributions.length, 2);
  assert.deepEqual(first.contributions.map(item => item.weightBps), [5000, 10000]);
  assert.equal(first.valenceBps, 5333); assert.equal(first.arousalBps, 6000); assert.equal(first.label, 'neutral');
  assert.equal(JSON.stringify(first).includes('permission'), false);
  assert.equal(JSON.stringify(first).includes('allowed'), false);
  f.close(); const reopened = f.open();
  assert.deepEqual(reopened.domain.state({ conversationId: dm }), first);
});

test('time decay and the review rule are explicit, versioned and reproducible from clock alone', t => {
  const f = fixture(t);
  f.observe('decay', { valenceBps: 9000, arousalBps: 1000, label: 'positive' });
  const fresh = f.domain.state({ conversationId: dm });
  f.advance(21_600_000);
  const halved = f.domain.state({ conversationId: dm });
  assert.equal(halved.contributions[0]!.weightBps, 5000);
  assert.equal(fresh.valenceBps, 9000); assert.equal(halved.valenceBps, 9000);
  assert.deepEqual(halved.reviewDue, []);
  f.advance(86_400_000);
  const aged = f.domain.state({ conversationId: dm });
  assert.equal(aged.contributions[0]!.weightBps, Math.floor(10_000 * 21_600_000 / (21_600_000 + 108_000_000)));
  assert.deepEqual(aged.reviewDue, [fresh.contributions[0]!.recordId]);
  const again = f.domain.state({ conversationId: dm });
  assert.deepEqual(again, aged);
});

test('reviews digest an observation out of the current state while keeping its provenance', t => {
  const f = fixture(t);
  const observed = f.observe('review-target'), other = f.observe('kept', { valenceBps: 2000, label: 'low' });
  const review = f.domain.review({ requestId: 'review-one', conversationId: dm, recordIds: [observed.record.recordId],
    conclusion: 'no-longer-affects', sourceRefs: [f.observation()] });
  assert.deepEqual(review.record.reviewedRecordIds, [observed.record.recordId]);
  const state = f.domain.state({ conversationId: dm });
  assert.deepEqual(state.contributions.map(item => item.recordId), [other.record.recordId]);
  assert.equal(state.valenceBps, 2000);
  const capture = f.domain.captureForView({ conversationId: dm });
  assert.ok(capture.records.some(record => record.recordId === observed.record.recordId && record.status === 'digested'));
  assert.throws(() => f.domain.review({ requestId: 'review-missing', conversationId: dm, recordIds: ['experience:missing:1'],
    conclusion: 'still-relevant', sourceRefs: [f.observation()] }), code('UNKNOWN_INNER_RECORD'));
});

test('expression regulation is bounded, expiring and explicitly non-authoritative', t => {
  const f = fixture(t);
  const regulation = f.domain.regulate({ requestId: 'regulation-one', conversationId: dm, guidance: 'acknowledge',
    expiresAt: new Date(f.now() + 60_000).toISOString(), sourceRefs: [f.observation()] });
  let state = f.domain.state({ conversationId: dm });
  assert.deepEqual(state.regulations, [{ recordId: regulation.record.recordId, guidance: 'acknowledge',
    expiresAt: new Date(f.now() + 60_000).toISOString() }]);
  assert.equal(JSON.stringify(state).includes('authorized'), false);
  f.advance(60_001);
  state = f.domain.state({ conversationId: dm });
  assert.deepEqual(state.regulations, []);
  assert.throws(() => f.domain.regulate({ requestId: 'past-regulation', conversationId: dm, guidance: 'warm',
    expiresAt: new Date(f.now() - 1).toISOString(), sourceRefs: [f.observation()] }), code('INVALID_INNER_INPUT'));
  for (const extra of [{ subject: 'user' }, { humanFeeling: true }, { permission: 'tool.execute' }, { authorized: true }]) {
    assert.throws(() => f.domain.observe({ requestId: 'smuggled', conversationId: dm, valenceBps: 5000, arousalBps: 5000,
      label: 'neutral', sourceRefs: [f.observation()], ...extra } as never), code('INVALID_INNER_INPUT'));
  }
  for (const patch of [{ valenceBps: 10_001 }, { arousalBps: -1 }, { label: 'human-joy' }]) {
    assert.throws(() => f.domain.observe({ requestId: 'invalid', conversationId: dm, valenceBps: 5000, arousalBps: 5000,
      label: 'neutral', sourceRefs: [f.observation()], ...patch } as never), code('INVALID_INNER_INPUT'));
  }
});

test('emotion records are audience-scoped: a direct-message experience never enters a group state or capture', t => {
  const f = fixture(t);
  f.domain.observe({ requestId: 'dm-experience', conversationId: dm, valenceBps: 9000, arousalBps: 9000, label: 'alert', sourceRefs: [f.observation()] });
  const groupState = f.domain.state({ conversationId: group });
  assert.deepEqual(groupState.contributions, []); assert.equal(groupState.valenceBps, 5000);
  const dmCapture = f.domain.captureForView({ conversationId: dm }), groupCapture = f.domain.captureForView({ conversationId: group });
  assert.equal(dmCapture.records.length, 1); assert.equal(groupCapture.records.length, 0);
  assert.throws(() => f.domain.captureForView({ conversationId: group, recordIds: [dmCapture.records[0]!.recordId] }), code('INNER_VIEW_FORBIDDEN'));
});

test('withdrawing a source removes its influence and marks the dependent state as degraded, not empty success', t => {
  const f = fixture(t);
  const first = f.observe('withdraw-first');
  const second = f.observe('withdraw-second', { valenceBps: 2000, label: 'low' });
  const capture = f.domain.captureForView({ conversationId: dm });
  const receipt = f.domain.withdraw({ requestId: 'withdraw-experience', recordIds: [first.record.recordId] });
  assert.equal(receipt.tombstoneWatermark, 1);
  assert.throws(() => f.domain.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
  const state = f.domain.state({ conversationId: dm });
  assert.deepEqual(state.contributions.map(item => item.recordId), [second.record.recordId]);
  assert.deepEqual(state.revokedEvidence, []);
  const after = f.domain.captureForView({ conversationId: dm });
  assert.equal(after.records.some(record => record.recordId === first.record.recordId), false);
  assert.throws(() => f.domain.readBodies({ capture: after, recordIds: [first.record.recordId] }), code('INNER_BODY_FORBIDDEN'));
  // A missing external source is handled at read time: one vanished source degrades, all
  // vanished sources revoke, and no stored record is silently rewritten.
  const memoryRef: InnerSourceRef = { kind: 'memory-operation', sourceId: 'memory-one', revision: 1 };
  f.evidence.set('memory-operation:memory-one@1', { valid: true, audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1 });
  const third = f.domain.observe({ requestId: 'memory-backed', conversationId: dm, valenceBps: 9000, arousalBps: 4000, label: 'positive', sourceRefs: [f.observation(), memoryRef] });
  const evidenceReceipt = f.domain.withdraw({ requestId: 'withdraw-evidence', evidenceRefs: [memoryRef] });
  assert.equal(evidenceReceipt.tombstoneWatermark, 2);
  const degraded = f.domain.state({ conversationId: dm });
  assert.equal(degraded.degraded, true);
  assert.deepEqual(degraded.revokedEvidence, []);
  const degradedCapture = f.domain.captureForView({ conversationId: dm });
  assert.equal(degradedCapture.records.find(record => record.recordId === third.record.recordId)!.evidenceState, 'degraded');
  f.domain.withdraw({ requestId: 'withdraw-conversation-evidence', evidenceRefs: [f.observation()] });
  const revoked = f.domain.state({ conversationId: dm });
  assert.deepEqual(revoked.contributions, []);
  assert.deepEqual(revoked.revokedEvidence, [second.record.recordId, third.record.recordId].sort());
});

test('emotion writes require independently observable provenance and known audiences', t => {
  const f = fixture(t);
  assert.throws(() => f.observe('no-source', { sourceRefs: [] }), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.observe('owner-only', { sourceRefs: [f.ownerCommand('owner-only')] }), code('INNER_SOURCE_REQUIRED'));
  assert.throws(() => f.domain.observe({ requestId: 'unknown-conversation', conversationId: 'conversation-missing', valenceBps: 5000,
    arousalBps: 5000, label: 'neutral', sourceRefs: [f.observation()] }), code('UNKNOWN_INNER_CONVERSATION'));
  const facts = f.conversations.get(dm)!;
  f.conversations.set(dm, { ...facts, active: false });
  assert.throws(() => f.observe('inactive-audience'), code('INNER_CONVERSATION_INACTIVE'));
  f.conversations.set(dm, facts);
  assert.throws(() => f.observe('wrong-owner', { sourceRefs: [f.ownerCommand('another')] }), code('INNER_SOURCE_INVALID'));
});

test('emotion reads are pure and a new installation generation invalidates old captures', t => {
  const f = fixture(t);
  const observed = f.observe('purity');
  const capture = f.domain.captureForView({ conversationId: dm });
  const reads = f.pure(() => {
    for (let i = 0; i < 20; i++) {
      f.domain.state({ conversationId: dm });
      const current = f.domain.captureForView({ conversationId: dm });
      f.domain.validateForView({ capture: current });
      f.domain.readBodies({ capture: current, recordIds: [observed.record.recordId] });
    }
    return true;
  });
  assert.equal(reads.changes, 0);
  f.close(); const restored = f.open();
  assert.deepEqual(restored.domain.validateForView({ capture }), capture);
  const other = new EmotionDomain(restored.db, restored.tx, { runtimeIdentity: { hostEpoch: 'other-host', installationGeneration: 'other-install' },
    now: () => new Date(start), resolveConversation: id => f.conversations.get(id), resolveEvidence: ref => f.evidence.get(`${ref.kind}:${ref.sourceId}@${ref.revision}`) });
  assert.throws(() => other.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
});

test('missing authority metadata fails closed for the emotion domain as well', t => {
  const f = fixture(t);
  f.observe('authority');
  f.db.exec('DELETE FROM shiyu_emotion_meta');
  assert.throws(() => f.domain.state({ conversationId: dm }), code('CORRUPT_INNER_DOMAIN'));
  assert.throws(() => new EmotionDomain(f.db, f.tx, { runtimeIdentity: { hostEpoch: 'h', installationGeneration: 'i' }, now: () => new Date(start),
    resolveConversation: id => f.conversations.get(id) }), code('CORRUPT_INNER_DOMAIN'));
});

test('an emotion withdrawal does not erase another domain objective fact that shared the source', t => {
  const f = fixture(t);
  const relationship = new RelationshipDomain(f.db, f.tx, { runtimeIdentity: { hostEpoch: 'inner-host', installationGeneration: 'inner-install' },
    now: () => new Date(start), resolveConversation: id => f.conversations.get(id),
    resolveEvidence: ref => f.evidence.get(`${ref.kind}:${ref.sourceId}@${ref.revision}`) });
  const memory: InnerSourceRef = { kind: 'memory-operation', sourceId: 'shared-memory', revision: 1 };
  f.evidence.set('memory-operation:shared-memory@1', { valid: true, audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1 });
  const entity = relationship.registerSubject({ requestId: 'evidence-entity', account: { connectionId: 'synthetic-connection', identityNamespace: 'synthetic-lab',
    identityType: 'member', externalSubjectId: 'shared-person' }, entityKind: 'person', displayName: '共享证据' });
  const fact = relationship.assert({ requestId: 'shared-fact', conversationId: dm, subjectId: entity.record.entityId, predicate: 'interaction',
    value: 'meeting', sourceRefs: [memory] });
  const observation = f.domain.observe({ requestId: 'shared-emotion', conversationId: dm, valenceBps: 7000, arousalBps: 5000, label: 'positive', sourceRefs: [memory] });
  const relationshipCapture = relationship.captureForView({ conversationId: dm });
  f.domain.withdraw({ requestId: 'withdraw-shared-emotion-evidence', evidenceRefs: [memory] });
  const emotionState = f.domain.state({ conversationId: dm });
  assert.deepEqual(emotionState.contributions, []);
  assert.deepEqual(emotionState.revokedEvidence, [observation.record.recordId]);
  // The relationship domain has its own deletion barrier and keeps its still-sourced objective fact.
  assert.deepEqual(relationship.validateForView({ capture: relationshipCapture }), relationshipCapture);
  const relationshipBody = relationship.readBodies({ capture: relationshipCapture, recordIds: [fact.record.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  assert.equal(relationshipBody.value, 'meeting');
});
