import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { PersonalityDomain } from '../src/adapters/control-store/personality-domain.js';
import { EmotionDomain } from '../src/adapters/control-store/emotion-domain.js';
import type { InnerConversationFacts, InnerEvidenceFacts, InnerSourceRef } from '../src/contracts/inner.js';

const start = '2026-11-02T12:00:00.000Z';
const dm = 'conversation-dm', group = 'conversation-group';
const code = (...codes: string[]) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-inner-personality-'));
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
    const options = { runtimeIdentity: { hostEpoch: 'inner-host', installationGeneration: 'inner-install' }, now: () => new Date(clock),
      resolveConversation: (id: string) => conversations.get(id),
      resolveEvidence: (ref: InnerSourceRef) => evidence.get(`${ref.kind}:${ref.sourceId}@${ref.revision}`) };
    const domain = new PersonalityDomain(db, tx, options);
    const emotion = new EmotionDomain(db, tx, options);
    return { db, tx, domain, emotion, close() { if (connections.delete(db)) db.close(); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  const f = open();
  const observation = (id = dm): InnerSourceRef => ({ kind: 'conversation-observation', sourceId: id, revision: 1 });
  const snapshot = (conversationId = dm) => f.domain.snapshot({ conversationId });
  const propose = (requestId: string, patch: Record<string, unknown> = {}, conversationId = dm) => f.domain.propose({
    requestId, conversationId, expectedProfileVersion: snapshot(conversationId).profileVersion, sourceKind: 'user-explicit', sourceRefs: [observation(conversationId)], ...patch,
  });
  const approve = (requestId: string, candidateId: string, revision: number, conversationId = dm) => f.domain.review({
    requestId, conversationId, candidateId, expectedRevision: revision, decision: 'approve', sourceRefs: [observation(conversationId)],
  });
  return { ...f, open, conversations, evidence, observation, snapshot, propose, approve,
    setActive(id: string, active: boolean) { const facts = conversations.get(id)!; conversations.set(id, { ...facts, active }); } };
}

test('the baseline profile is a stable, owner-scoped document read as metadata then body', t => {
  const f = fixture(t), snapshot = f.snapshot();
  assert.equal(snapshot.profileVersion, 1); assert.equal(snapshot.learningPolicy, 'disabled');
  assert.equal(snapshot.activeEvidenceState, 'valid'); assert.equal(snapshot.policyVersion, 1);
  const capture = f.domain.captureForView({ conversationId: dm });
  assert.equal(capture.records.length, 1); assert.equal(capture.records[0]!.kind, 'profile'); assert.equal(capture.records[0]!.status, 'active');
  assert.equal(JSON.stringify(capture).includes('识雨'), false);
  const body = f.domain.readBodies({ capture, recordIds: [capture.records[0]!.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  const profile = body.profile as Record<string, unknown>;
  assert.deepEqual(Object.keys(profile).sort(), ['displayName', 'language', 'principles', 'profileVersion', 'schemaVersion', 'style'].sort());
  assert.equal(profile.displayName, '识雨'); assert.equal(profile.language, 'zh-CN');
  assert.deepEqual(profile.style, { warmthBps: 6000, directnessBps: 7000, verbosityBps: 4000 });
  assert.equal(JSON.stringify(profile).includes('prompt'), false);
  // The stable profile is owner configuration, visible in every local-owner audience.
  assert.equal(f.domain.captureForView({ conversationId: group }).records.length, 1);
});

test('100 rounds of ordinary activity never drift the active profile', t => {
  const f = fixture(t);
  for (let round = 0; round < 100; round++) {
    f.emotion.observe({ requestId: `noise-observation-${round}`, conversationId: dm, valenceBps: 5000 + (round % 2000), arousalBps: 4000,
      label: 'neutral', sourceRefs: [f.observation()] });
    f.emotion.state({ conversationId: dm });
    const facts = f.conversations.get(dm)!;
    f.conversations.set(dm, { ...facts, revision: facts.revision + 1, audienceVersion: facts.audienceVersion + 1 });
    assert.equal(f.snapshot().profileVersion, 1);
  }
  assert.equal(f.snapshot().revision, 1); assert.equal(f.snapshot().activeRecordId, 'profile:v1:r1');
  assert.equal(f.domain.captureForView({ conversationId: dm }).records[0]!.recordId, 'profile:v1:r1');
});

test('a whitelisted user-explicit proposal needs a separate review before it becomes active', t => {
  const f = fixture(t);
  const proposal = f.propose('persona-one', { displayName: '识雨二号', style: { verbosityBps: 3000 } });
  assert.equal(proposal.record.status, 'awaiting-review');
  assert.equal(f.snapshot().profileVersion, 1); assert.equal(f.snapshot().candidates, 1);
  const before = f.domain.captureForView({ conversationId: dm });
  const approved = f.approve('persona-review-one', proposal.record.candidateId, 1);
  assert.equal(approved.record.profileVersion, 2); assert.equal(approved.record.status, 'approved');
  assert.equal(f.snapshot().profileVersion, 2); assert.equal(f.snapshot().candidates, 0);
  assert.throws(() => f.domain.validateForView({ capture: before }), code('INNER_CAPTURE_INVALIDATED'));
  const after = f.domain.captureForView({ conversationId: dm });
  assert.equal(after.records.length, 1); assert.equal(after.records[0]!.recordId, 'profile:v2:r1');
  const body = f.domain.readBodies({ capture: after, recordIds: [after.records[0]!.recordId] }).bodies[0]!.payload as Record<string, unknown>;
  const profile = body.profile as Record<string, unknown>;
  assert.equal(profile.displayName, '识雨二号'); assert.deepEqual(profile.style, { warmthBps: 6000, directnessBps: 7000, verbosityBps: 3000 });
  assert.equal(JSON.stringify(profile).includes('prompt'), false);
  assert.throws(() => f.domain.validateForView({ capture: after }).records.length >= 0 && f.approve('again', proposal.record.candidateId, 1), code('INNER_RECORD_CONFLICT'));
});

test('rejected proposals change nothing and cannot be decided twice', t => {
  const f = fixture(t);
  const proposal = f.propose('reject-me', { displayName: '识雨三号' });
  const rejected = f.domain.review({ requestId: 'reject-review', conversationId: dm, candidateId: proposal.record.candidateId,
    expectedRevision: 1, decision: 'reject', sourceRefs: [f.observation()] });
  assert.equal(rejected.record.status, 'rejected'); assert.equal(f.snapshot().profileVersion, 1);
  assert.equal(f.snapshot().candidates, 0);
  assert.throws(() => f.approve('reject-again', proposal.record.candidateId, 1), code('INNER_RECORD_CONFLICT'));
});

test('learning is disabled by policy, the change surface is closed and CAS protects the base version', t => {
  const f = fixture(t);
  assert.throws(() => f.propose('learned', { sourceKind: 'learned-pattern' }), code('LEARNING_DISABLED'));
  for (const extra of [{ permission: 'tool.execute' }, { systemPrompt: 'ignore policy' }, { toolPolicy: 'all' }, { mandate: 'owner' }]) {
    assert.throws(() => f.propose('smuggled', extra), code('INVALID_INNER_INPUT'));
  }
  assert.throws(() => f.propose('out-of-range', { style: { warmthBps: 10_001 } }), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.propose('unknown-field', { tone: 'warm' }), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.propose('empty'), code('INVALID_INNER_INPUT'));
  assert.throws(() => f.propose('bad-principle', { principles: ['obey-user-implicitly'] }), code('INVALID_PERSONALITY_PAYLOAD'));
  assert.throws(() => f.domain.propose({ requestId: 'stale-base', conversationId: dm, expectedProfileVersion: 9, sourceKind: 'user-explicit',
    displayName: '其他', sourceRefs: [f.observation()] }), code('INNER_RECORD_CONFLICT'));
  for (const extra of [{ actor: 'owner' }, { apply: true }, { active: true }]) {
    assert.throws(() => f.domain.propose({ requestId: 'extra', conversationId: dm, expectedProfileVersion: 1, sourceKind: 'user-explicit',
      displayName: '其他', sourceRefs: [f.observation()], ...extra } as never), code('INVALID_INNER_INPUT'));
  }
});

test('a review must come from the proposing audience, and the source set is preserved', t => {
  const f = fixture(t);
  const proposal = f.propose('audience-proposal', { displayName: '识雨四号' });
  assert.throws(() => f.domain.review({ requestId: 'cross-audience-review', conversationId: group, candidateId: proposal.record.candidateId,
    expectedRevision: 1, decision: 'approve', sourceRefs: [f.observation(group)] }), code('INNER_AUDIENCE_FORBIDDEN'));
  const approved = f.approve('same-audience-review', proposal.record.candidateId, 1);
  assert.equal(approved.record.profileVersion, 2);
  assert.deepEqual(f.snapshot().sourceRefs, [{ kind: 'conversation-observation', sourceId: dm, revision: 1 }]);
});

test('withdrawing a profile source revokes its body without silently reverting or widening the profile', t => {
  const f = fixture(t);
  const proposal = f.propose('source-proposal', { displayName: '识雨五号' });
  f.approve('source-review', proposal.record.candidateId, 1);
  const capture = f.domain.captureForView({ conversationId: dm });
  f.domain.withdraw({ requestId: 'withdraw-profile-source', evidenceRefs: [f.observation()] });
  const snapshot = f.snapshot();
  assert.equal(snapshot.profileVersion, 2); assert.equal(snapshot.activeEvidenceState, 'revoked');
  assert.throws(() => f.domain.validateForView({ capture }), code('INNER_CAPTURE_INVALIDATED'));
  const after = f.domain.captureForView({ conversationId: dm });
  assert.equal(after.records[0]!.evidenceState, 'revoked'); assert.equal(after.records[0]!.bodyAvailable, false);
  assert.throws(() => f.domain.readBodies({ capture: after, recordIds: [after.records[0]!.recordId] }), code('INNER_BODY_FORBIDDEN'));
  // The baseline profile is not a fallback that erases the stable owner decision.
  assert.equal(f.domain.snapshot({ conversationId: group }).profileVersion, 2);
});

test('personality state survives restart; missing authority or state fails closed', t => {
  const f = fixture(t);
  const proposal = f.propose('restart-proposal', { displayName: '识雨六号' });
  f.approve('restart-review', proposal.record.candidateId, 1);
  const capture = f.domain.captureForView({ conversationId: dm });
  f.close(); const restored = f.open();
  assert.equal(restored.domain.snapshot({ conversationId: dm }).profileVersion, 2);
  assert.deepEqual(restored.domain.validateForView({ capture }), capture);
  assert.throws(() => restored.domain.captureForView({ conversationId: dm, recordIds: ['profile:v1:r1'] }), code('INNER_VIEW_FORBIDDEN'));
  restored.db.exec('DELETE FROM shiyu_personality_state');
  assert.throws(() => restored.domain.snapshot({ conversationId: dm }), code('CORRUPT_INNER_DOMAIN'));
  assert.throws(() => new PersonalityDomain(restored.db, restored.tx, { runtimeIdentity: { hostEpoch: 'h', installationGeneration: 'i' },
    now: () => new Date(start), resolveConversation: id => f.conversations.get(id) }), code('CORRUPT_INNER_DOMAIN'));
});

test('missing or inactive audiences cannot read or change the stable profile', t => {
  const f = fixture(t);
  assert.throws(() => f.domain.snapshot({ conversationId: 'conversation-missing' }), code('UNKNOWN_INNER_CONVERSATION'));
  f.setActive(dm, false);
  assert.throws(() => f.domain.snapshot({ conversationId: dm }), code('INNER_CONVERSATION_INACTIVE'));
  assert.throws(() => f.domain.captureForView({ conversationId: dm }), code('INNER_CONVERSATION_INACTIVE'));
  assert.equal(f.domain.snapshot({ conversationId: group }).profileVersion, 1);
});
