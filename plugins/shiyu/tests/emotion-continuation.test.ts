import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { CONVERSATION_BACKGROUND_HANDLER } from '../src/adapters/control-store/conversation-domain.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { EMOTION_POLICY_V1, type EmotionContext, type EmotionLabel, type EmotionState, type InnerCapture } from '../src/contracts/inner.js';
import {
  probeEmotionContinuation, validateEmotionProbeReceipt, RuntimeEmotionContinuationProbeCommand, emotionContinuationDiagnosisTool,
  EMOTION_PROBE_ACTION, EMOTION_PROBE_TOOL,
} from '../src/adapters/control-store/emotion-continuation-probe.js';

const code = (...codes: string[]) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code));
async function fixture(t: TestContext) {
  const store = await ControlStore.open({ filename: ':memory:', eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [CONVERSATION_BACKGROUND_HANDLER],
    runtimeIdentity: { hostEpoch: 'emotion-continuation-host', installationGeneration: 'emotion-continuation-install' } });
  t.after(() => store.close());
  const conversation = async (channelId = 'emotion-primary') => (await store.request('conversation.ensureLabChannel', { connectionId: 'emotion-fixture',
    runId: 'emotion-run', channelId, kind: 'direct', membersDigest: 'a'.repeat(64) })).conversationId;
  const observation = (conversationId: string) => ({ kind: 'conversation-observation' as const, sourceId: conversationId, revision: 1 });
  const observe = async (conversationId: string, input: { valenceBps?: number; arousalBps?: number; label?: EmotionLabel; observedAt?: string }) =>
    store.request('emotion.observe', { requestId: `observe-${randomUUID()}`, conversationId, valenceBps: input.valenceBps ?? 7000,
      arousalBps: input.arousalBps ?? 4000, label: input.label ?? 'positive', ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      sourceRefs: [observation(conversationId)] });
  const context = (conversationId: string, windowMs?: number) => store.request('emotion.context', { conversationId, ...(windowMs === undefined ? {} : { windowMs }) });
  return { store, conversation, observation, observe, context };
}
const stateOf = (context: EmotionContext): EmotionContext['state'] => context.state;

test('emotion context is a sourced, timestamped, explicitly non-subjective system state', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  const first = await f.observe(conversationId, { valenceBps: 7200, arousalBps: 4200, label: 'positive' });
  const second = await f.observe(conversationId, { valenceBps: 2800, arousalBps: 7300, label: 'alert' });
  const context = await f.context(conversationId);
  assert.equal(context.subject, 'system-state'); assert.equal(context.humanFeeling, false); assert.equal(context.authorityEffect, 'none');
  assert.equal(context.disclosure.subjectiveExperience, false); assert.equal(context.disclosure.longTermPersonality, false);
  assert.equal(context.disclosure.modelSelfReportAuthority, 'none'); assert.equal(context.disclosure.ombrePulseTreatedAsEmotion, false);
  assert.equal(context.memoryDimension.readOnly, true); assert.equal(context.memoryDimension.ombreMetadataWritten, false);
  assert.match(context.memoryDimension.note, /candidate retrieval dimension/);
  assert.equal(context.recent.length, 2);
  assert.deepEqual(new Set(context.recent.map(event => event.recordId)), new Set([first.record.recordId, second.record.recordId]));
  for (const event of context.recent) {
    assert.equal(event.sourceRefs.length, 1); assert.equal(event.sourceRefs[0]!.kind, 'conversation-observation');
    assert.ok(Number.isFinite(Date.parse(event.observedAt))); assert.equal(event.sourceRefs[0]!.revision, 1);
    assert.ok(['current', 'needs_review', 'degraded', 'source_invalid', 'revoked'].includes(event.derivation));
  }
  // Newest first among the bounded recent events.
  assert.ok(context.recent[0]!.observedAt >= context.recent[1]!.observedAt);
  assert.equal(stateOf(context).derivation, 'current');
  const state = await f.store.request('emotion.state', { conversationId });
  assert.equal(state.subject, 'system-state'); assert.equal(state.humanFeeling, false);
  assert.equal(state.derivation, 'current'); assert.deepEqual(state.derivationReasons, []);
});

test('emotion context is audience-trimmed and cannot cite another conversation source', async t => {
  const f = await fixture(t), primary = await f.conversation('emotion-primary'), other = await f.conversation('emotion-other');
  await f.observe(primary, { valenceBps: 7000, arousalBps: 4000 });
  const otherContext = await f.context(other);
  assert.equal(otherContext.recent.length, 0);
  assert.equal(otherContext.state.valenceBps, 5000); assert.equal(otherContext.state.arousalBps, 5000);
  assert.equal(otherContext.audience.audienceId, other);
  await assert.rejects(f.store.request('emotion.observe', { requestId: `cross-${randomUUID()}`, conversationId: primary, valenceBps: 7000, arousalBps: 4000,
    label: 'positive', sourceRefs: [{ kind: 'conversation-observation', sourceId: other, revision: 1 }] }), code('INNER_SOURCE_UNAVAILABLE', 'INNER_AUDIENCE_FORBIDDEN'));
  const primaryCapture = await f.store.request('emotion.captureForView', { conversationId: primary });
  const otherCapture = await f.store.request('emotion.captureForView', { conversationId: other });
  assert.equal(primaryCapture.records.length, 1); assert.equal(otherCapture.records.length, 0);
  assert.equal(primaryCapture.audience.audienceId, primary);
});

test('withdrawing an observed experience removes it from context and rejects the old capture', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  const first = await f.observe(conversationId, { valenceBps: 7200, arousalBps: 4200, label: 'positive' });
  const second = await f.observe(conversationId, { valenceBps: 2800, arousalBps: 7300, label: 'alert' });
  const capture = await f.store.request('emotion.captureForView', { conversationId }) as InnerCapture;
  await f.store.request('emotion.withdraw', { requestId: `withdraw-${randomUUID()}`, recordIds: [first.record.recordId] });
  const context = await f.context(conversationId);
  assert.equal(context.recent.length, 1); assert.equal(context.recent[0]!.recordId, second.record.recordId);
  assert.ok(!context.recent.some(event => event.recordId === first.record.recordId));
  await assert.rejects(f.store.request('emotion.validateForView', { capture }), code('INNER_CAPTURE_INVALIDATED'));
  await assert.rejects(f.store.request('emotion.observe', { requestId: `revive-${randomUUID()}`, conversationId, valenceBps: 9000, arousalBps: 1000,
    label: 'positive', sourceRefs: [f.observation(conversationId), { kind: 'emotion-record', sourceId: first.record.recordId, revision: 1 }] }),
    code('INNER_SOURCE_UNAVAILABLE', 'INNER_SOURCE_REVOKED'));
});

test('withdrawing the source evidence degrades state explicitly instead of silently keeping it current', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  const first = await f.observe(conversationId, { valenceBps: 7000, arousalBps: 4000 });
  await f.store.request('emotion.withdraw', { requestId: `evidence-${randomUUID()}`, evidenceRefs: [f.observation(conversationId)] });
  const context = await f.context(conversationId);
  assert.equal(context.recent.length, 1);
  assert.equal(context.recent[0]!.recordId, first.record.recordId);
  assert.notEqual(context.recent[0]!.derivation, 'current');
  assert.equal(context.recent[0]!.bodyAvailable, false);
  assert.ok(context.state.revokedEvidence.includes(first.record.recordId));
  assert.notEqual(context.state.derivation, 'current');
  assert.equal(context.state.degraded, false); // explicit derivation source_invalid carries the truth
});

test('versioned review digests an experience and changes the deterministic projection', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  const first = await f.observe(conversationId, { valenceBps: 7200, arousalBps: 4200, label: 'positive' });
  const second = await f.observe(conversationId, { valenceBps: 2800, arousalBps: 7300, label: 'alert' });
  const before = await f.context(conversationId);
  const review = await f.store.request('emotion.review', { requestId: `review-${randomUUID()}`, conversationId, recordIds: [first.record.recordId],
    conclusion: 'no-longer-affects', sourceRefs: [f.observation(conversationId)] });
  assert.equal(review.record.reviewRecordId.startsWith('review:'), true);
  const after = await f.context(conversationId);
  assert.ok(!before.recent.some(event => event.recordId === review.record.reviewRecordId));
  assert.ok(after.recent.some(event => event.recordId === review.record.reviewRecordId && event.kind === 'review' && event.conclusion === 'no-longer-affects'));
  assert.ok(!after.recent.some(event => event.recordId === first.record.recordId));
  assert.ok(after.recent.some(event => event.recordId === second.record.recordId));
  assert.notDeepEqual({ valence: before.state.valenceBps, arousal: before.state.arousalBps }, { valence: after.state.valenceBps, arousal: after.state.arousalBps });
  // The review changed the durable derivation revision; an old capture cannot stay current.
  const states = await f.store.request('emotion.derivations', {});
  assert.ok(states.derivedRevision >= 1);
});

test('deterministic decay and time window are explicit rather than hidden inference', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  const old = new Date(Date.now() - 8 * EMOTION_POLICY_V1.halfLifeMs).toISOString();
  const observed = await f.observe(conversationId, { valenceBps: 9000, arousalBps: 1000, label: 'positive', observedAt: old });
  const defaultContext = await f.context(conversationId);
  assert.equal(defaultContext.recent.length, 0); // older than the default 24h window
  assert.equal(defaultContext.policy.halfLifeMs, EMOTION_POLICY_V1.halfLifeMs);
  assert.equal(defaultContext.policy.policyVersion, EMOTION_POLICY_V1.policyVersion);
  const wide = await f.context(conversationId, 7 * 24 * 3_600_000);
  assert.equal(wide.recent.length, 1); assert.equal(wide.recent[0]!.recordId, observed.record.recordId);
  const state = await f.store.request('emotion.state', { conversationId });
  const contribution = state.contributions.find(item => item.recordId === observed.record.recordId);
  assert.ok(contribution); assert.ok(contribution!.weightBps < 10_000 && contribution!.weightBps > 0);
  assert.ok(contribution!.weightBps <= 2000); // >= 8 half-lives => <= 1/9 weight
  assert.ok(state.reviewDue.includes(observed.record.recordId));
  assert.equal(defaultContext.windowMs, EMOTION_POLICY_V1.reviewAfterMs);
});

test('regulation guidance and unknown conversations stay bounded and authoritative', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  const regulation = await f.store.request('emotion.regulate', { requestId: `regulate-${randomUUID()}`, conversationId, guidance: 'brief',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), sourceRefs: [f.observation(conversationId)] });
  const context = await f.context(conversationId);
  const event = context.recent.find(item => item.recordId === regulation.record.recordId)!;
  assert.equal(event.kind, 'regulation'); assert.equal(event.guidance, 'brief');
  assert.deepEqual(context.state.regulations.map(item => item.guidance), ['brief']);
  await assert.rejects(f.context('conversation-that-does-not-exist'), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error));
  const dimension = await f.store.request('emotion.memoryDimension', { conversationId });
  assert.deepEqual(dimension, context.memoryDimension);
});

test('no set_emotion/pulse authority exists and the projection cannot become a memory write', async t => {
  const f = await fixture(t), conversationId = await f.conversation();
  await f.observe(conversationId, { valenceBps: 6500, arousalBps: 5500, label: 'positive' });
  for (const command of ['emotion.set_emotion', 'emotion.pulse', 'emotion.pulse_signal']) {
    await assert.rejects(f.store.request(command as never, { conversationId, valenceBps: 9000 } as never), (error: unknown) =>
      Boolean(error && typeof error === 'object' && 'code' in error));
  }
  const context = await f.context(conversationId);
  assert.equal(context.memoryDimension.ombreMetadataWritten, false);
  assert.equal(context.disclosure.ombrePulseTreatedAsEmotion, false);
  assert.equal(context.memoryDimension.sourceDomain, 'emotion');
  const state: EmotionState = await f.store.request('emotion.state', { conversationId });
  assert.equal(state.subject, 'system-state'); assert.equal(state.humanFeeling, false); assert.equal(state.authorityEffect, 'none');
});

test('the isolated fixed-host emotion probe is zero-model, cleaned up and never touches live data', async t => {
  const receipt = await probeEmotionContinuation();
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.toolName, EMOTION_PROBE_TOOL);
  assert.equal(receipt.zeroModel, true); assert.equal(receipt.zeroEmbedding, true); assert.equal(receipt.zeroTaskOrEffect, true);
  assert.equal(receipt.store, 'in-memory'); assert.equal(receipt.liveDataTouched, false);
  assert.equal(receipt.released, true); assert.equal(receipt.disposed, true);
  assert.deepEqual(validateEmotionProbeReceipt(receipt), []);
  assert.equal(Buffer.byteLength(JSON.stringify(receipt), 'utf8') <= 24 * 1024, true);
  assert.equal(receipt.checks.every(check => check.status === 'passed'), true);
  assert.equal(receipt.steps.every(step => step.status === 'passed'), true);
  assert.equal(receipt.diagnostics.staleCaptureRejected, true);
  assert.equal(receipt.diagnostics.recentCountBefore, 2); assert.equal(receipt.diagnostics.recentCountAfterWithdrawal, 1);
  assert.equal(receipt.diagnostics.memoryDimension.readOnly, true); assert.equal(receipt.diagnostics.memoryDimension.ombreMetadataWritten, false);
  for (const check of ['system-state-not-human-feeling', 'no-pulse-as-emotion', 'state-degradation-explicit', 'withdrawn-source-cannot-revive', 'stale-capture-rejected']) {
    assert.ok(receipt.checks.some(item => item.check === check && item.status === 'passed'), `missing check ${check}`);
  }
  assert.equal(receipt.diagnostics.cleanup.storeClosed, true); assert.equal(receipt.diagnostics.cleanup.workerTerminated, true);
  assert.deepEqual(receipt.diagnostics.zeroActivity, { modelCalls: 0, embeddingCalls: 0, tasks: 0, effects: 0, sends: 0 });
});

test('the emotion probe command is single-slot, exact-input, non-retrying and abort-aware', async t => {
  const receipt = await probeEmotionContinuation();
  let open = true, paused = false, calls = 0;
  const simple = new RuntimeEmotionContinuationProbeCommand({ isOpen: () => open, isPaused: () => paused, probe: async () => { calls++; return structuredClone(receipt); } });
  await assert.rejects(simple.handle({ action: EMOTION_PROBE_ACTION, extra: true }), code('EMOTION_PROBE_INPUT'));
  await assert.rejects(simple.handle({ action: 'runtime.other' }), code('EMOTION_PROBE_INPUT'));
  paused = true;
  await assert.rejects(simple.handle({ action: EMOTION_PROBE_ACTION }), code('EMOTION_PROBE_PAUSED'));
  paused = false; open = false;
  await assert.rejects(simple.handle({ action: EMOTION_PROBE_ACTION }), code('EMOTION_PROBE_CLOSED'));
  open = true;
  assert.deepEqual(await simple.handle({ action: EMOTION_PROBE_ACTION }), receipt);
  assert.equal(calls, 1);
  assert.deepEqual(simple.receipt(), receipt);
  // One-shot failure is not retried by the same call.
  let attempts = 0;
  const failing = new RuntimeEmotionContinuationProbeCommand({ isOpen: () => true, isPaused: () => false,
    probe: async () => { attempts++; throw new Error('synthetic emotion probe failure'); } });
  await assert.rejects(failing.handle({ action: EMOTION_PROBE_ACTION }), /synthetic emotion probe failure/);
  assert.equal(attempts, 1);
  assert.equal(failing.receipt(), undefined);
  // Tool is zero-parameter and routes only the owner action.
  const actions: unknown[] = [];
  const tool = emotionContinuationDiagnosisTool({ command: async input => { actions.push(input); return receipt; } });
  assert.equal(tool.name, EMOTION_PROBE_TOOL);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  await tool.execute();
  assert.deepEqual(actions, [{ action: EMOTION_PROBE_ACTION }]);
  // Abort/deadline surface as explicit codes with a cleanup receipt.
  await assert.rejects(probeEmotionContinuation({ signal: AbortSignal.abort() }), code('EMOTION_PROBE_ABORTED'));
  await assert.rejects(probeEmotionContinuation({ deadlineMs: 1, now: () => new Date(Date.now() + 60_000) }), code('EMOTION_PROBE_DEADLINE', 'EMOTION_PROBE_ABORTED'));
});
