// Test maintenance reads durable observations; it does not ask a model to finish
// reviewing the entire source backlog before a checkpoint or host restart.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const key = ref => `${ref.id}:${ref.revision}`;
const digest = text => createHash('sha256').update(text).digest('hex');
export const naturalMaintenancePolicy = Object.freeze({
  version: 2, id: 'native-checkpoint-durable-observations', forcedMemoryReview: false,
  checkpoint: { settleMemory: false }, restart: { verifyObservedSources: true, verifyPendingReview: true },
  final: { recordPendingReview: true, forcedMemoryReview: false },
  meaning: 'Persisted observation and pending review are distinct from completed model review',
});

// Shared visible-host callers keep their previous default. Only an explicit
// false bypasses the historical pre-checkpoint memory review.
export async function compactMemoryHost(rt, native, input = {}) {
  const bot = (await native.state()).bots[input.index || 0];
  if (input.settleMemory !== false) await rt.memoryFlush(bot.id);
  return { compacted: await rt.checkpointBot(bot.id), bot: await native.bot(bot.id) };
}

export function persistedNaturalMemoryEvidence(store, bots, at = new Date().toISOString()) {
  assert.ok(Array.isArray(bots) && bots.length > 0, 'Persisted observation evidence requires native Bot identities');
  for (const name of ['observations', 'watermarks', 'source', 'getMeta']) assert.equal(typeof store[name], 'function', `Persisted observation store lacks ${name}`);
  return { schemaVersion: 1, at, readOnly: true, interpretation: naturalMaintenancePolicy.meaning,
    bots: bots.map(bot => {
      const observed = store.observations(bot.id), rawPending = store.getMeta(`unreviewed:${bot.id}`) || [];
      const refs = new Map(observed.map(ref => [key(ref), { ...ref }]));
      for (const ref of rawPending) if (!refs.has(key(ref))) refs.set(key(ref), { id: ref.id, revision: ref.revision });
      const sourceRefs = [...refs.values()].map(ref => {
        const source = store.source(ref.id, ref.revision), head = store.source(ref.id);
        return { ...ref, present: Boolean(source), digest: source?.digest ?? null,
          digestVerified: Boolean(source && typeof source.body === 'string' && digest(source.body) === source.digest),
          authorId: source?.authorId ?? null, roomId: source?.roomId ?? null, eventId: source?.eventId ?? null,
          reviewed: store.getMeta(`reviewed:${bot.id}:${ref.id}:${ref.revision}`) === true,
          headRevision: head?.revision ?? null, headWithdrawn: Boolean(head?.withdrawn) };
      });
      const byRef = new Map(sourceRefs.map(ref => [key(ref), ref]));
      const pendingReviewRefs = rawPending.filter(ref => {
        const source = byRef.get(key(ref));
        return source?.present && source.headRevision === ref.revision && !source.headWithdrawn && !source.reviewed;
      }).map(({ id, revision }) => ({ id, revision }));
      const watermarks = store.watermarks(bot.id);
      return { id: bot.id, sessionId: bot.sessionId, watermarks, sourceRefs,
        observedSourceCount: observed.length, rawPendingRefs: rawPending.map(({ id, revision }) => ({ id, revision })),
        pendingReviewRefs, pendingReviewCount: pendingReviewRefs.length,
        pendingCountMatchesWatermark: pendingReviewRefs.length === watermarks.pendingReviewCount,
        sourceIntegrityPassed: sourceRefs.every(ref => ref.present && ref.digestVerified
          && Number.isSafeInteger(ref.headRevision) && ref.headRevision >= ref.revision) };
    }) };
}

export function verifyNaturalMemoryPersistence(before, after) {
  const next = new Map(after.bots.map(bot => [bot.id, bot]));
  const identitiesPreserved = before.bots.length > 0 && before.bots.length === after.bots.length && before.bots.every(bot => next.has(bot.id));
  const sessionsPreserved = identitiesPreserved && before.bots.every(bot => next.get(bot.id).sessionId === bot.sessionId);
  const perBot = before.bots.map(bot => {
    const current = next.get(bot.id), refs = new Map((current?.sourceRefs || []).map(ref => [key(ref), ref]));
    const missingOrChangedSources = bot.sourceRefs.filter(ref => {
      const actual = refs.get(key(ref));
      return !actual || ['digest', 'authorId', 'roomId', 'eventId'].some(field => ref[field] !== actual[field])
        || ref.sequence !== undefined && ref.sequence !== actual.sequence;
    }).map(({ id, revision }) => ({ id, revision }));
    const pending = new Set((current?.pendingReviewRefs || []).map(key));
    const pendingTransitions = bot.pendingReviewRefs.map(ref => {
      const actual = refs.get(key(ref));
      const state = pending.has(key(ref)) ? 'still-pending' : actual?.reviewed ? 'reviewed'
        : actual?.present && (actual.headWithdrawn || Number.isSafeInteger(actual.headRevision) && actual.headRevision > ref.revision) ? 'invalidated' : 'missing-unreviewed';
      return { ...ref, state };
    });
    return { id: bot.id, sourceCountBefore: bot.observedSourceCount, sourceCountAfter: current?.observedSourceCount ?? null,
      receivedThroughBefore: bot.watermarks.receivedThrough, receivedThroughAfter: current?.watermarks.receivedThrough ?? null,
      receivedWatermarkPreserved: Boolean(current && current.watermarks.receivedThrough >= bot.watermarks.receivedThrough),
      pendingBefore: bot.pendingReviewCount, pendingAfter: current?.pendingReviewCount ?? null,
      missingOrChangedSources, pendingTransitions,
      sourceIntegrityPassed: Boolean(bot.sourceIntegrityPassed && current?.sourceIntegrityPassed && bot.pendingCountMatchesWatermark && current?.pendingCountMatchesWatermark) };
  });
  const observedSourceRefsPreserved = perBot.every(bot => bot.receivedWatermarkPreserved && !bot.missingOrChangedSources.length);
  const pendingReviewWorkPreserved = perBot.every(bot => bot.pendingTransitions.every(ref => ref.state !== 'missing-unreviewed'));
  const sourceIntegrityPassed = perBot.every(bot => bot.sourceIntegrityPassed);
  return { passed: Boolean(before.readOnly && after.readOnly && identitiesPreserved && sessionsPreserved
      && observedSourceRefsPreserved && pendingReviewWorkPreserved && sourceIntegrityPassed),
    identitiesPreserved, sessionsPreserved, observedSourceRefsPreserved, pendingReviewWorkPreserved, sourceIntegrityPassed, perBot,
    interpretation: 'A still-pending reference is retained work, never evidence that the model reviewed it' };
}
