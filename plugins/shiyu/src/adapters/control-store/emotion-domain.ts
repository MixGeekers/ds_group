import type { DatabaseSync } from 'node:sqlite';
import {
  EMOTION_GUIDANCE, EMOTION_LABELS, EMOTION_POLICY_V1, EMOTION_REVIEW_CONCLUSIONS,
  innerFail, innerFields, innerId, innerInstant, innerInteger, innerBps,
  validateEmotionPayload,
  type EmotionCommands, type EmotionDomainRequest, type EmotionGuidance, type EmotionLabel,
  type EmotionPayload, type EmotionState, type EmotionContext, type EmotionContextEvent, type InnerDerivation,
} from '../../contracts/inner.js';
export type { EmotionDomainRequest } from '../../contracts/inner.js';
import { InnerDomainBase, type InnerDomainBaseOptions, type StoredInnerRecord } from './inner-domain.js';
import type { InnerDerivationReason } from '../../contracts/inner.js';
import { SqliteTransactions } from './transaction.js';

/** Explicit review/decay rule version; changing it needs a migration, never a silent rollout. */
export const EMOTION_POLICY_VERSION = EMOTION_POLICY_V1.policyVersion;
const RECORD_KINDS = ['experience', 'review', 'regulation'] as const;
const STATUSES = ['active', 'digested'] as const;
type Options = Omit<InnerDomainBaseOptions, 'domain' | 'policyVersion'>;

/**
 * Explainable system-state emotion: sourced observations + a fixed, versioned
 * decay/review rule + expression guidance.
 *
 * The domain never asserts a human feeling, never grants authority, and never
 * rewrites objective facts. Its state is a deterministic integer projection of
 * currently valid observations at a given clock, so identical inputs and clock
 * reproduce identical bytes. Bodies (observation values, reviews, regulations)
 * are only readable from an exact metadata capture for the same audience.
 */
export class EmotionDomain extends InnerDomainBase {
  constructor(db: DatabaseSync, tx: SqliteTransactions, options: Options) {
    super(db, tx, { ...options, domain: 'emotion', policyVersion: EMOTION_POLICY_VERSION });
  }
  protected validatePayload(kind: string, payload: unknown): Record<string, unknown> {
    const body = validateEmotionPayload(payload);
    if (body.kind !== kind) innerFail('INVALID_EMOTION_PAYLOAD', 'Emotion record kind disagrees with its payload');
    return body as unknown as Record<string, unknown>;
  }
  protected checkRecord(record: StoredInnerRecord): void {
    if (!RECORD_KINDS.includes(record.kind as (typeof RECORD_KINDS)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown emotion record kind');
    if (!STATUSES.includes(record.status as (typeof STATUSES)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown emotion record status');
    if (record.audience.kind === 'owner') innerFail('CORRUPT_INNER_DOMAIN', 'Emotion observations are conversation-scoped');
    if (!record.identity.startsWith(`${record.kind}:`)) innerFail('CORRUPT_INNER_DOMAIN', 'Emotion record identity disagrees with its kind');
    if (record.kind !== 'experience' && record.status !== 'active') innerFail('CORRUPT_INNER_DOMAIN', 'Only experiences can be digested');
  }

  /** Digested observations remain historical, not current evidence for dependants. */
  protected sourceCurrent(record: StoredInnerRecord): { current: boolean; reason?: InnerDerivationReason } {
    if (record.kind === 'experience') return record.status === 'active' ? { current: true } : { current: false, reason: 'source_not_current' };
    if (record.kind === 'review' || record.kind === 'regulation') return { current: true };
    return { current: false, reason: 'source_not_current' };
  }
  observe(input: EmotionCommands['emotion.observe']['input']): EmotionCommands['emotion.observe']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'valenceBps', 'arousalBps', 'label', 'observedAt', 'sourceRefs'],
      ['requestId', 'conversationId', 'valenceBps', 'arousalBps', 'label', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    if (!EMOTION_LABELS.includes(input.label as EmotionLabel)) innerFail('INVALID_INNER_INPUT', 'Invalid emotion label');
    const label = input.label as EmotionLabel;
    const valenceBps = innerBps(input.valenceBps, 'valenceBps');
    const arousalBps = innerBps(input.arousalBps, 'arousalBps');
    const observedAt = input.observedAt === undefined ? undefined : innerInstant(input.observedAt, 'observedAt');
    return this.tx.atomic(() => this.command(requestId, 'observe', { conversationId, valenceBps, arousalBps, label, observedAt, sourceRefs: input.sourceRefs }, () => {
      const facts = this.activeConversation(conversationId);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const recordId = `experience:${conversationId}:${requestId}`;
      const payload = validateEmotionPayload({ kind: 'experience', valenceBps, arousalBps, label });
      this.persist({ recordId, identity: recordId, kind: 'experience', status: 'active', audience: facts.audience,
        sourceRefs: evidence.refs, ...(observedAt === undefined ? {} : { observedAt }), payload });
      return { requestId, changed: true, record: { recordId, revision: 1, status: 'active' } };
    }));
  }

  review(input: EmotionCommands['emotion.review']['input']): EmotionCommands['emotion.review']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'recordIds', 'conclusion', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    if (!Array.isArray(input.recordIds) || !input.recordIds.length || input.recordIds.length > 20) innerFail('INVALID_INNER_INPUT', 'A review needs bounded experience identities');
    const recordIds = [...new Set(input.recordIds.map(item => innerId(item, 'recordId')))];
    if (!EMOTION_REVIEW_CONCLUSIONS.includes(input.conclusion as never)) innerFail('INVALID_INNER_INPUT', 'Invalid review conclusion');
    const conclusion = input.conclusion as (typeof EMOTION_REVIEW_CONCLUSIONS)[number];
    return this.tx.atomic(() => this.command(requestId, 'review', { conversationId, recordIds, conclusion, sourceRefs: input.sourceRefs }, () => {
      const facts = this.activeConversation(conversationId);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const reviewed: StoredInnerRecord[] = [];
      const payloads: Record<string, EmotionPayload> = {};
      for (const recordId of recordIds) {
        const record = this.record(recordId);
        if (!record || record.kind !== 'experience') innerFail('UNKNOWN_INNER_RECORD', 'A reviewed experience does not exist');
        if (record.audience.audienceId !== conversationId || record.audience.kind !== facts.audience.kind) innerFail('INNER_AUDIENCE_FORBIDDEN', 'A review must come from the audience that observed it');
        if (this.evidenceState(record) === 'revoked') innerFail('INNER_SOURCE_REVOKED', 'A withdrawn experience cannot be reviewed as current');
        reviewed.push(record);
        payloads[recordId] = this.payload(record) as unknown as EmotionPayload;
      }
      const reviewRecordId = `review:${requestId}`;
      this.persist({ recordId: reviewRecordId, identity: reviewRecordId, kind: 'review', status: 'active', audience: facts.audience,
        sourceRefs: evidence.refs, payload: validateEmotionPayload({ kind: 'review', reviewedRecordIds: recordIds, conclusion }) });
      if (conclusion === 'no-longer-affects') {
        for (const record of reviewed) this.setStatus({ ...record }, 'digested');
      }
      return { requestId, changed: true, record: { reviewRecordId, reviewedRecordIds: recordIds } };
    }));
  }

  regulate(input: EmotionCommands['emotion.regulate']['input']): EmotionCommands['emotion.regulate']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'guidance', 'expiresAt', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    if (!EMOTION_GUIDANCE.includes(input.guidance as EmotionGuidance)) innerFail('INVALID_INNER_INPUT', 'Invalid expression guidance');
    const guidance = input.guidance as EmotionGuidance;
    const expiresAt = input.expiresAt === undefined ? undefined : innerInstant(input.expiresAt, 'expiresAt');
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(this.now())) innerFail('INVALID_INNER_INPUT', 'Expression regulation must expire in the future');
    return this.tx.atomic(() => this.command(requestId, 'regulate', { conversationId, guidance, expiresAt, sourceRefs: input.sourceRefs }, () => {
      const facts = this.activeConversation(conversationId);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const recordId = `regulation:${conversationId}:${requestId}`;
      this.persist({ recordId, identity: recordId, kind: 'regulation', status: 'active', audience: facts.audience,
        sourceRefs: evidence.refs, payload: validateEmotionPayload({ kind: 'regulation', guidance, ...(expiresAt === undefined ? {} : { expiresAt }) }) });
      return { requestId, changed: true, record: { recordId, revision: 1 } };
    }));
  }

  /**
   * Pure, deterministic projection. Same stored rows + same clock => same bytes.
   * Runs no write, model, session or backend I/O.
   */
  state(input: EmotionCommands['emotion.state']['input']): EmotionState {
    innerFields(input, ['conversationId']);
    const conversationId = innerId(input.conversationId, 'conversationId');
    return this.tx.atomic(() => {
      const facts = this.activeConversation(conversationId);
      const now = this.now();
      const at = Date.parse(now);
      const visible = this.visibleLatest(conversationId);
      const revokedEvidence: string[] = [];
      let degraded = false;
      const observations: { record: StoredInnerRecord; payload: Extract<EmotionPayload, { kind: 'experience' }>; weightBps: number }[] = [];
      const reviewDue: string[] = [];
      const regulations: { recordId: string; guidance: EmotionGuidance; expiresAt?: string }[] = [];
      for (const record of visible) {
        const evidenceState = this.evidenceState(record);
        if (evidenceState === 'revoked') { revokedEvidence.push(record.recordId); continue; }
        if (evidenceState === 'degraded') degraded = true;
        if (record.kind === 'experience') {
          if (record.status !== 'active') continue;
          const payload = this.payload(record) as unknown as Extract<EmotionPayload, { kind: 'experience' }>;
          const age = Math.max(0, at - Date.parse(record.observedAt));
          const weightBps = Math.floor((10_000 * EMOTION_POLICY_V1.halfLifeMs) / (EMOTION_POLICY_V1.halfLifeMs + age));
          if (weightBps === 0) continue;
          observations.push({ record, payload, weightBps });
          if (age > EMOTION_POLICY_V1.reviewAfterMs) reviewDue.push(record.recordId);
        } else if (record.kind === 'review') {
          continue;
        } else if (record.kind === 'regulation') {
          const payload = this.payload(record) as unknown as Extract<EmotionPayload, { kind: 'regulation' }>;
          if (payload.expiresAt !== undefined && Date.parse(payload.expiresAt) <= at) continue;
          regulations.push({ recordId: record.recordId, guidance: payload.guidance, ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }) });
        }
      }
      observations.sort((a, b) => a.record.recordId.localeCompare(b.record.recordId));
      const derivationCounts = { current: 0, degraded: 0, revoked: 0 } as Record<'current' | 'degraded' | 'revoked', number>;
      const derivationReasons: InnerDerivationReason[] = [];
      for (const record of visible) {
        const derived = this.derivation(record);
        if (derived.evidenceState === 'valid') derivationCounts.current++;
        else if (derived.evidenceState === 'degraded') derivationCounts.degraded++;
        else derivationCounts.revoked++;
        for (const reason of derived.reasons) if (derivationReasons.length < 4 && !derivationReasons.includes(reason)) derivationReasons.push(reason);
      }
      const derivation: InnerDerivation = derivationCounts.degraded === 0 && derivationCounts.revoked === 0 ? 'current'
        : derivationCounts.current > 0 || derivationCounts.degraded > 0 ? 'degraded' : 'source_invalid';
      regulations.sort((a, b) => a.recordId.localeCompare(b.recordId));
      let denominator = 0, valence = 0, arousal = 0;
      for (const item of observations) {
        denominator += item.weightBps;
        valence += innerBps(item.payload.valenceBps, 'valenceBps') * item.weightBps;
        arousal += innerBps(item.payload.arousalBps, 'arousalBps') * item.weightBps;
      }
      const valenceBps = denominator ? Math.round(valence / denominator) : 5000;
      const arousalBps = denominator ? Math.round(arousal / denominator) : 5000;
      const label: EmotionState['label'] = valenceBps >= 6000 ? (arousalBps >= 5000 ? 'positive-energized' : 'positive')
        : valenceBps <= 4000 && arousalBps >= 6000 ? 'alert' : 'neutral';
      const state: EmotionState = {
        schemaVersion: 1, conversationId, computedAt: now, policy: structuredClone(EMOTION_POLICY_V1),
        subject: 'system-state', humanFeeling: false, authorityEffect: 'none',
        valenceBps, arousalBps, label,
        contributions: observations.map(item => ({ recordId: item.record.recordId, weightBps: item.weightBps,
          observedAt: item.record.observedAt, label: item.payload.label })),
        reviewDue: reviewDue.sort(), regulations, degraded, revokedEvidence: revokedEvidence.sort(),
        derivation, derivationReasons,
      };
      return state;
    });
  }

  /**
   * Read-only conversation-scoped context for chat background / memory
   * interaction: current deterministic state plus the latest bounded events
   * with their source references and timestamps. It never exposes bodies to a
   * different audience, never treats an Ombre pulse as emotion and never writes
   * memory or backend metadata.
   */
  context(input: EmotionCommands['emotion.context']['input']): EmotionContext {
    innerFields(input, ['conversationId', 'windowMs'], ['conversationId']);
    const conversationId = innerId(input.conversationId, 'conversationId');
    const windowMs = input.windowMs === undefined ? EMOTION_POLICY_V1.reviewAfterMs : innerInteger(input.windowMs, 'windowMs', 1, 7 * 24 * 3_600_000);
    return this.tx.atomic(() => {
      const facts = this.activeConversation(conversationId);
      const state = this.state({ conversationId });
      const cutoff = Date.parse(state.computedAt) - windowMs;
      const recent: EmotionContextEvent[] = [];
      for (const record of this.visibleLatest(conversationId)) {
        if (record.kind === 'experience' && record.status !== 'active') continue;
        if (Date.parse(record.observedAt) < cutoff) continue;
        const derived = this.derivation(record);
        const payload = this.payload(record) as EmotionPayload;
        recent.push({ recordId: record.recordId, revision: record.revision, kind: record.kind as EmotionContextEvent['kind'],
          ...(payload.kind === 'experience' ? { label: payload.label, valenceBps: payload.valenceBps, arousalBps: payload.arousalBps } : {}),
          ...(payload.kind === 'review' ? { conclusion: payload.conclusion } : {}),
          ...(payload.kind === 'regulation' ? { guidance: payload.guidance } : {}),
          observedAt: record.observedAt, derivation: derived.derivation, derivationReasons: derived.reasons,
          sourceRefs: structuredClone(record.sourceRefs), bodyAvailable: derived.bodyAvailable });
      }
      recent.sort((left, right) => right.observedAt.localeCompare(left.observedAt) || right.recordId.localeCompare(left.recordId));
      return { schemaVersion: 1, conversationId, computedAt: state.computedAt, audience: facts.audience, policy: structuredClone(EMOTION_POLICY_V1),
        subject: 'system-state', humanFeeling: false, authorityEffect: 'none',
        memoryDimension: { valenceBps: state.valenceBps, arousalBps: state.arousalBps, label: state.label, sourceDomain: 'emotion',
          readOnly: true, ombreMetadataWritten: false, note: 'candidate retrieval dimension from the local system-state projection; not a memory fact and never written by this domain' },
        state: { valenceBps: state.valenceBps, arousalBps: state.arousalBps, label: state.label, degraded: state.degraded,
          revokedEvidence: state.revokedEvidence, reviewDue: state.reviewDue, regulations: state.regulations,
          derivation: state.derivation ?? 'current', derivationReasons: state.derivationReasons ?? [] },
        recent: recent.slice(0, 8), windowMs,
        disclosure: { subjectiveExperience: false, longTermPersonality: false, modelSelfReportAuthority: 'none', ombrePulseTreatedAsEmotion: false } };
    });
  }
  /** Narrow read-only projection for controlled memory-interaction consumers. */
  memoryDimension(input: EmotionCommands['emotion.memoryDimension']['input']): EmotionContext['memoryDimension'] {
    innerFields(input, ['conversationId']);
    return this.context({ conversationId: innerId(input.conversationId, 'conversationId') }).memoryDimension;
  }
  withdraw(input: EmotionCommands['emotion.withdraw']['input']): EmotionCommands['emotion.withdraw']['output'] {
    return super.withdraw(input);
  }
  captureForView(input: EmotionCommands['emotion.captureForView']['input']): EmotionCommands['emotion.captureForView']['output'] {
    return super.captureForView(input);
  }
  validateForView(input: EmotionCommands['emotion.validateForView']['input']): EmotionCommands['emotion.validateForView']['output'] {
    return super.validateForView(input);
  }
  readBodies(input: EmotionCommands['emotion.readBodies']['input']): EmotionCommands['emotion.readBodies']['output'] {
    return super.readBodies(input);
  }

  execute(request: EmotionDomainRequest): unknown {
    innerFields(request, ['command', 'args']);
    switch (request.command) {
      case 'emotion.observe': return this.observe(request.args);
      case 'emotion.review': return this.review(request.args);
      case 'emotion.regulate': return this.regulate(request.args);
      case 'emotion.state': return this.state(request.args);
      case 'emotion.context': return this.context(request.args);
      case 'emotion.memoryDimension': return this.memoryDimension(request.args);
      case 'emotion.withdraw': return this.withdraw(request.args);
      case 'emotion.captureForView': return this.captureForView(request.args);
      case 'emotion.validateForView': return this.validateForView(request.args);
      case 'emotion.readBodies': return this.readBodies(request.args);
      case 'emotion.recompute': return this.recompute(request.args);
      case 'emotion.derivations': innerFields(request.args, []); return this.derivations();
      default: return innerFail('INVALID_INNER_INPUT', 'Unknown emotion command');
    }
  }
}
