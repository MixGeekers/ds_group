import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { CognitionDomain } from '../src/adapters/control-store/cognition-domain.js';
import type { InnerConversationFacts, InnerEvidenceFacts, InnerSourceRef } from '../src/contracts/inner.js';

const start = '2026-11-02T12:00:00.000Z';
const dm = 'conversation-dm', group = 'conversation-group';
const code = (...codes: string[]) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-inner-cognition-'));
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
    const domain = new CognitionDomain(db, tx, {
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
  const memory = (sourceId = 'memory-one'): InnerSourceRef => ({ kind: 'memory-operation', sourceId, revision: 1 });
  const propose = (requestId: string, patch: Record<string, unknown> = {}) => f.domain.propose({ requestId, conversationId: dm,
    claimType: 'owner-statement', subjectIds: ['entity-subject'], predicate: 'prefers-tea', proposition: '合成主体偏好茶。',
    confidenceBps: 8000, sourceRefs: [observation()], ...patch });
  const declareMemory = (sourceId = 'memory-one', valid = true) => evidence.set(`memory-operation:${sourceId}@1`,
    { valid, audience: { scope: 'local-owner', kind: 'direct', audienceId: dm }, revision: 1 });
  return { ...f, open, conversations, evidence, observation, ownerCommand, memory, propose, declareMemory,
    pure<T>(read: () => T): { value: T; changes: number } { const before = Number(f.db.prepare('SELECT total_changes() AS n').get()!.n); const value = read(); return { value, changes: Number(f.db.prepare('SELECT total_changes() AS n').get()!.n) - before }; } };
}

test('facts and interpretations stay separate and are captured as metadata before any body read', t => {
  const f = fixture(t);
  const fact = f.propose('fact-one');
  const interpretation = f.propose('interpretation-one', { claimType: 'model-inference', predicate: 'seems-to-prefer-tea', proposition: '可能偏好茶。' });
  assert.equal(fact.record.status, 'supported'); assert.equal(interpretation.record.status, 'hypothesis');
  const capture = f.domain.captureForView({ conversationId: dm });
  assert.equal(capture.records.find(record => record.recordId === fact.record.recordId)!.status, 'supported');
  assert.equal(capture.records.find(record => record.recordId === interpretation.record.recordId)!.status, 'hypothesis');
  assert.equal(JSON.stringify(capture).includes('偏好茶'), false);
  const bodies = f.domain.readBodies({ capture, recordIds: [fact.record.recordId, interpretation.record.recordId] });
  const byId = new Map(bodies.bodies.map(body => [body.recordId, body.payload as Record<string, unknown>]));
  assert.equal(byId.get(fact.record.recordId)!.claimKind, 'fact');
  assert.equal(byId.get(interpretation.record.recordId)!.claimKind, 'interpretation');
  assert.equal(byId.get(interpretation.record.recordId)!.claimType, 'model-inference');
  const reported = f.propose('reported-one', { claimType: 'external-statement', predicate: 'said-about-tea' });
  assert.equal(reported.record.status, 'reported');
  const procedure = f.propose('procedure-one', { claimType: 'procedure-hypothesis', predicate: 'try-brief-answer', proposition: '简短回答更有效。' });
  assert.equal(procedure.record.status, 'hypothesis');
});

test('a self statement cannot mint a fact or a reserved tool/world predicate', t => {
  const f = fixture(t);
  assert.throws(() => f.propose('reserved', { predicate: 'tool-success' }), code('INVALID_COGNITION_PAYLOAD'));
  assert.throws(() => f.propose('world', { predicate: 'world-fact', claimType: 'external-observation' }), code('INVALID_COGNITION_PAYLOAD'));
  assert.throws(() => f.propose('bad-type', { claimType: 'model-tool-report' }), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.propose('kind-smuggle', { claimKind: 'fact', claimType: 'model-inference' }), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.propose('owner-only', { sourceRefs: [f.ownerCommand('owner-only')] }), code('INNER_SOURCE_REQUIRED'));
  assert.throws(() => f.propose('no-source', { sourceRefs: [] }), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.propose('unknown-source', { sourceRefs: [{ kind: 'memory-operation', sourceId: 'memory-missing', revision: 1 }] }), code('INNER_SOURCE_UNAVAILABLE'));
  assert.throws(() => f.domain.propose({ requestId: 'cross-audience', conversationId: group, claimType: 'owner-statement',
    subjectIds: ['entity-subject'], predicate: 'prefers-tea', proposition: '合成主体偏好茶。', confidenceBps: 8000, sourceRefs: [f.observation(dm)] }), code('INNER_SOURCE_UNAVAILABLE'));
  for (const extra of [{ actor: 'owner' }, { permission: 'tool.execute' }, { confidence: 1 }]) {
    assert.throws(() => f.propose('smuggled', extra), code('INVALID_INNER_INPUT'));
  }
});

test('conflicting supported facts become an explicit contested conflict set and resolve with sources', t => {
  const f = fixture(t);
  const first = f.propose('first-fact');
  const second = f.propose('second-fact', { proposition: '合成主体不偏好茶。' });
  assert.equal(second.record.status, 'contested');
  assert.ok(second.record.conflictId);
  const capture = f.domain.captureForView({ conversationId: dm });
  const conflict = capture.records.find(record => record.kind === 'conflict')!;
  assert.equal(conflict.status, 'open');
  assert.equal(capture.records.find(record => record.recordId === first.record.recordId)!.status, 'contested');
  const resolved = f.domain.resolveConflict({ requestId: 'resolve-one', conversationId: dm, conflictId: second.record.conflictId!,
    expectedRevision: 1, winnerRecordId: second.record.recordId, sourceRefs: [f.observation()] });
  assert.equal(resolved.record.winnerRecordId, second.record.recordId);
  const after = f.domain.captureForView({ conversationId: dm });
  assert.equal(after.records.find(record => record.recordId === second.record.recordId)!.status, 'supported');
  assert.equal(after.records.some(record => record.recordId === first.record.recordId), false);
  assert.throws(() => f.domain.resolveConflict({ requestId: 'resolve-stale', conversationId: dm, conflictId: second.record.conflictId!,
    expectedRevision: 1, winnerRecordId: second.record.recordId, sourceRefs: [f.observation()] }), code('INNER_RECORD_CONFLICT'));
  assert.throws(() => f.domain.resolveConflict({ requestId: 'resolve-outsider', conversationId: dm, conflictId: second.record.conflictId!,
    expectedRevision: 2, winnerRecordId: first.record.recordId, sourceRefs: [f.observation()] }), code('INNER_RECORD_CONFLICT'));
});

test('claims are revised with CAS, keep a supersede chain and invalidate pinned captures', t => {
  const f = fixture(t);
  const first = f.propose('revision-target');
  const capture = f.domain.captureForView({ conversationId: dm });
  const revised = f.domain.revise({ requestId: 'revision-one', conversationId: dm, claimId: first.record.claimId, expectedRevision: 1,
    proposition: '合成主体偏好乌龙茶。', confidenceBps: 9000, sourceRefs: [f.observation()] });
  assert.equal(revised.record.revision, 2);
  assert.throws(() => f.domain.revise({ requestId: 'revision-stale', conversationId: dm, claimId: first.record.claimId, expectedRevision: 1,
    proposition: '另一结论。', confidenceBps: 7000, sourceRefs: [f.observation()] }), code('INNER_RECORD_CONFLICT'));
  assert.throws(() => f.domain.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
  const current = f.domain.captureForView({ conversationId: dm });
  assert.equal(current.records.some(record => record.recordId === first.record.recordId), false);
  const body = f.domain.readBodies({ capture: current, recordIds: [revised.record.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  assert.equal(body.proposition, '合成主体偏好乌龙茶。'); assert.equal(body.confidenceBps, 9000);
  const procedure = f.propose('action-experience', { claimType: 'procedure-hypothesis', predicate: 'try-acknowledge-first', proposition: '先确认再回答。' });
  const revisedProcedure = f.domain.revise({ requestId: 'procedure-revision', conversationId: dm, claimId: procedure.record.claimId, expectedRevision: 1,
    proposition: '先确认，再给出一步。', confidenceBps: 6000, sourceRefs: [f.observation()] });
  assert.equal(revisedProcedure.record.revision, 2);
  assert.throws(() => f.domain.revise({ requestId: 'wrong-audience', conversationId: group, claimId: first.record.claimId, expectedRevision: 2,
    proposition: '跨群修改。', confidenceBps: 5000, sourceRefs: [f.observation(group)] }), code('INNER_AUDIENCE_FORBIDDEN'));
});

test('review conclusions are sourced records over visible claims and reject unknown identities', t => {
  const f = fixture(t);
  const claim = f.propose('reviewed-claim');
  const review = f.domain.review({ requestId: 'review-one', conversationId: dm, claimIds: [claim.record.claimId],
    conclusion: 'supports', sourceRefs: [f.observation()] });
  const capture = f.domain.captureForView({ conversationId: dm });
  const record = capture.records.find(item => item.recordId === review.record.recordId)!;
  assert.equal(record.kind, 'review');
  const body = f.domain.readBodies({ capture, recordIds: [review.record.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  assert.deepEqual(body.claimIds, [claim.record.claimId]); assert.equal(body.conclusion, 'supports');
  assert.throws(() => f.domain.review({ requestId: 'review-missing', conversationId: dm, claimIds: ['missing-claim'],
    conclusion: 'supports', sourceRefs: [f.observation()] }), code('UNKNOWN_INNER_RECORD'));
});

test('vanished evidence degrades then revokes dependent claims at read time without rewriting them', t => {
  const f = fixture(t);
  f.declareMemory();
  const claim = f.propose('memory-claim', { sourceRefs: [f.observation(), f.memory()] });
  f.declareMemory('memory-one', false);
  let capture = f.domain.captureForView({ conversationId: dm });
  assert.equal(capture.records.find(record => record.recordId === claim.record.recordId)!.evidenceState, 'degraded');
  assert.equal(capture.records.find(record => record.recordId === claim.record.recordId)!.bodyAvailable, true);
  f.domain.withdraw({ requestId: 'withdraw-conversation-source', evidenceRefs: [f.observation()] });
  capture = f.domain.captureForView({ conversationId: dm });
  const metadata = capture.records.find(record => record.recordId === claim.record.recordId)!;
  assert.equal(metadata.evidenceState, 'revoked'); assert.equal(metadata.bodyAvailable, false);
  assert.throws(() => f.domain.readBodies({ capture, recordIds: [claim.record.recordId] }), code('INNER_BODY_FORBIDDEN'));
  assert.throws(() => f.propose('revoked-source', { sourceRefs: [f.observation()] }), code('INNER_SOURCE_UNAVAILABLE'));
});

test('cognition records are audience-scoped and capture purity holds', t => {
  const f = fixture(t);
  const claim = f.propose('dm-claim');
  const groupCapture = f.domain.captureForView({ conversationId: group });
  assert.equal(groupCapture.records.some(record => record.recordId === claim.record.recordId), false);
  assert.throws(() => f.domain.captureForView({ conversationId: group, recordIds: [claim.record.recordId] }), code('INNER_VIEW_FORBIDDEN'));
  const before = f.pure(() => {
    for (let i = 0; i < 20; i++) {
      const capture = f.domain.captureForView({ conversationId: dm });
      f.domain.validateForView({ capture });
      f.domain.readBodies({ capture, recordIds: capture.records.map(record => record.recordId) });
    }
    return true;
  });
  assert.equal(before.changes, 0);
});

test('cognition state survives restart and a new installation invalidates old captures', t => {
  const f = fixture(t);
  const claim = f.propose('restart-claim');
  const capture = f.domain.captureForView({ conversationId: dm });
  f.close(); const restored = f.open();
  const reopened = restored.domain.captureForView({ conversationId: dm });
  assert.deepEqual(reopened.records.map(record => [record.recordId, record.status]), capture.records.map(record => [record.recordId, record.status]));
  assert.deepEqual(restored.domain.validateForView({ capture }), capture);
  const other = new CognitionDomain(restored.db, restored.tx, { runtimeIdentity: { hostEpoch: 'other-host', installationGeneration: 'other-install' },
    now: () => new Date(start), resolveConversation: id => f.conversations.get(id), resolveEvidence: ref => f.evidence.get(`${ref.kind}:${ref.sourceId}@${ref.revision}`) });
  assert.throws(() => other.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
  restored.db.exec('DELETE FROM shiyu_cognition_meta');
  assert.throws(() => restored.domain.captureForView({ conversationId: dm }), code('CORRUPT_INNER_DOMAIN'));
  assert.throws(() => new CognitionDomain(restored.db, restored.tx, { runtimeIdentity: { hostEpoch: 'h', installationGeneration: 'i' },
    now: () => new Date(start), resolveConversation: id => f.conversations.get(id) }), code('CORRUPT_INNER_DOMAIN'));
});
