import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  COGNITION_CLAIM_STATUSES, COGNITION_CLAIM_TYPES, COGNITION_REVIEW_CONCLUSIONS,
  cognitionClaimKind, innerFail, innerFields, innerId, innerInstant, innerInteger, innerBps,
  validateCognitionPayload,
  type CognitionClaimType, type CognitionCommands, type CognitionDomainRequest, type CognitionPayload,
} from '../../contracts/inner.js';
export type { CognitionDomainRequest } from '../../contracts/inner.js';
import { InnerDomainBase, type InnerDomainBaseOptions, type StoredInnerRecord } from './inner-domain.js';
import { SqliteTransactions } from './transaction.js';

/** Cognition evidence/status rules version; changes require an explicit migration. */
export const COGNITION_POLICY_VERSION = 1;
const RECORD_KINDS = ['claim', 'conflict', 'review'] as const;
const CLAIM_STATUSES = ['supported', 'reported', 'hypothesis', 'contested', 'superseded'] as const;
const CONFLICT_STATUSES = ['open', 'resolved'] as const;
type Options = Omit<InnerDomainBaseOptions, 'domain' | 'policyVersion'>;
type ClaimPayload = Extract<CognitionPayload, { kind: 'claim' }>;
type ConflictPayload = Extract<CognitionPayload, { kind: 'conflict' }>;

/**
 * Sourced claims, explicit conflicts, review conclusions and revisable action
 * experience.
 *
 * Facts and interpretations are separate claim kinds; an interpretation can never
 * be promoted to a fact through this API, and tool/world-fact predicates are
 * reserved for verified control authorities. Claim bodies are bounded
 * propositions, never copies of memory text. Withdrawing a source degrades or
 * revokes dependent claims at read time instead of silently keeping them.
 */
export class CognitionDomain extends InnerDomainBase {
  constructor(db: DatabaseSync, tx: SqliteTransactions, options: Options) {
    super(db, tx, { ...options, domain: 'cognition', policyVersion: COGNITION_POLICY_VERSION });
  }
  protected validatePayload(kind: string, payload: unknown): Record<string, unknown> {
    const body = validateCognitionPayload(payload);
    if (body.kind !== kind) innerFail('INVALID_COGNITION_PAYLOAD', 'Cognition record kind disagrees with its payload');
    return body as unknown as Record<string, unknown>;
  }
  protected checkRecord(record: StoredInnerRecord): void {
    if (!RECORD_KINDS.includes(record.kind as (typeof RECORD_KINDS)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown cognition record kind');
    if (record.kind === 'claim' && !CLAIM_STATUSES.includes(record.status as (typeof CLAIM_STATUSES)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown claim status');
    if (record.kind === 'conflict' && !CONFLICT_STATUSES.includes(record.status as (typeof CONFLICT_STATUSES)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown conflict status');
    if (record.kind === 'review' && record.status !== 'recorded') innerFail('CORRUPT_INNER_DOMAIN', 'Reviews keep a recorded status');
    if (!record.identity.startsWith(`${record.kind}:`)) innerFail('CORRUPT_INNER_DOMAIN', 'Cognition record identity disagrees with its kind');
    if (record.audience.kind === 'owner') innerFail('CORRUPT_INNER_DOMAIN', 'Cognition judgements are conversation-scoped');
  }
  protected captureEligible(record: StoredInnerRecord): boolean {
    // Superseded claims stay durable for reconciliation but are not current facts.
    return record.kind !== 'claim' || record.status !== 'superseded';
  }

  private claimPayload(record: StoredInnerRecord): ClaimPayload {
    if (record.kind !== 'claim') innerFail('UNKNOWN_INNER_RECORD', 'This identity is not a cognition claim');
    return this.payload(record) as unknown as ClaimPayload;
  }
  private conflictPayload(record: StoredInnerRecord): ConflictPayload {
    if (record.kind !== 'conflict') innerFail('UNKNOWN_INNER_RECORD', 'This identity is not a conflict set');
    return this.payload(record) as unknown as ConflictPayload;
  }
  private initialStatus(claimType: CognitionClaimType): string {
    if (claimType === 'owner-statement' || claimType === 'external-observation') return 'supported';
    if (claimType === 'external-statement') return 'reported';
    return 'hypothesis';
  }
  private overlap(a: StoredInnerRecord, b: { validFrom?: string; validUntil?: string }): boolean {
    const aFrom = a.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(a.validFrom);
    const aUntil = a.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.validUntil);
    const bFrom = b.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(b.validFrom);
    const bUntil = b.validUntil === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.validUntil);
    return aFrom < bUntil && bFrom < aUntil;
  }
  /** Only same-subject/same-predicate fact claims in one audience may conflict in this slice. */
  private conflictsFor(payload: ClaimPayload, basis: { validFrom?: string; validUntil?: string; recordId: string }, conversationId: string): StoredInnerRecord[] {
    if (payload.claimKind !== 'fact') return [];
    const seen = new Set<string>();
    const found: StoredInnerRecord[] = [];
    for (const record of this.visibleLatest(conversationId)) {
      if (record.kind !== 'claim' || record.recordId === basis.recordId || record.status !== 'supported') continue;
      const other = this.claimPayload(record);
      if (other.claimKind !== 'fact') continue;
      if (other.predicate !== payload.predicate) continue;
      if (JSON.stringify(other.subjectIds) !== JSON.stringify(payload.subjectIds)) continue;
      if (other.proposition === payload.proposition) continue;
      if (!this.overlap(record, basis)) continue;
      const claimId = other.claimId;
      if (seen.has(claimId)) continue;
      seen.add(claimId);
      found.push(record);
    }
    return found.sort((a, b) => a.recordId.localeCompare(b.recordId));
  }
  propose(input: CognitionCommands['cognition.propose']['input']): CognitionCommands['cognition.propose']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'claimType', 'subjectIds', 'predicate', 'proposition', 'confidenceBps', 'validFrom', 'validUntil', 'sourceRefs'],
      ['requestId', 'conversationId', 'claimType', 'subjectIds', 'predicate', 'proposition', 'confidenceBps', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    if (!COGNITION_CLAIM_TYPES.includes(input.claimType as CognitionClaimType)) innerFail('INVALID_INNER_INPUT', 'Unknown cognition claim type');
    const claimType = input.claimType as CognitionClaimType;
    const validFrom = input.validFrom === undefined ? undefined : innerInstant(input.validFrom, 'validFrom');
    const validUntil = input.validUntil === undefined ? undefined : innerInstant(input.validUntil, 'validUntil');
    if (validFrom !== undefined && validUntil !== undefined && Date.parse(validFrom) >= Date.parse(validUntil)) innerFail('INVALID_INNER_INPUT', 'Validity interval is empty');
    return this.tx.atomic(() => this.command(requestId, 'propose', {
      conversationId, claimType, subjectIds: input.subjectIds, predicate: input.predicate, proposition: input.proposition,
      confidenceBps: input.confidenceBps, validFrom, validUntil, sourceRefs: input.sourceRefs,
    }, () => {
      const facts = this.activeConversation(conversationId);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const claimId = randomUUID();
      const payload = validateCognitionPayload({ kind: 'claim', claimId, claimKind: cognitionClaimKind(claimType), claimType,
        subjectIds: input.subjectIds, predicate: input.predicate, proposition: input.proposition, confidenceBps: input.confidenceBps }) as ClaimPayload;
      const recordId = `claim:${claimId}:r1`;
      const conflictTargets = this.conflictsFor(payload, { ...(validFrom === undefined ? {} : { validFrom }), ...(validUntil === undefined ? {} : { validUntil }), recordId }, conversationId);
      const status = conflictTargets.length ? 'contested' : this.initialStatus(claimType);
      const claim = this.persist({ recordId, identity: `claim:${claimId}`, kind: 'claim', status: this.initialStatus(claimType),
        audience: facts.audience, sourceRefs: evidence.refs, ...(validFrom === undefined ? {} : { validFrom }),
        ...(validUntil === undefined ? {} : { validUntil }), payload });
      const conflictIds: string[] = [];
      if (conflictTargets.length) {
        this.setStatus({ ...claim }, 'contested');
        for (const target of conflictTargets) {
          this.setStatus({ ...target }, 'contested');
          const conflictId = randomUUID();
          this.persist({ recordId: `conflict:${conflictId}:r1`, identity: `conflict:${conflictId}`, kind: 'conflict', status: 'open',
            audience: facts.audience, sourceRefs: evidence.refs,
            payload: validateCognitionPayload({ kind: 'conflict', conflictId, claimRecordIds: [target.recordId, recordId], status: 'open' }) });
          conflictIds.push(conflictId);
        }
      }
      return { requestId, changed: true, record: { claimId, recordId, revision: 1,
        status: conflictIds.length ? 'contested' : status, ...(conflictIds.length ? { conflictId: conflictIds[0] } : {}) } };
    }));
  }

  revise(input: CognitionCommands['cognition.revise']['input']): CognitionCommands['cognition.revise']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'claimId', 'expectedRevision', 'proposition', 'confidenceBps', 'validFrom', 'validUntil', 'sourceRefs'],
      ['requestId', 'conversationId', 'claimId', 'expectedRevision', 'proposition', 'confidenceBps', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    const claimId = innerId(input.claimId, 'claimId');
    const expectedRevision = innerInteger(input.expectedRevision, 'expectedRevision');
    const validFrom = input.validFrom === undefined ? undefined : innerInstant(input.validFrom, 'validFrom');
    const validUntil = input.validUntil === undefined ? undefined : innerInstant(input.validUntil, 'validUntil');
    if (validFrom !== undefined && validUntil !== undefined && Date.parse(validFrom) >= Date.parse(validUntil)) innerFail('INVALID_INNER_INPUT', 'Validity interval is empty');
    return this.tx.atomic(() => this.command(requestId, 'revise', {
      conversationId, claimId, expectedRevision, proposition: input.proposition, confidenceBps: input.confidenceBps,
      validFrom, validUntil, sourceRefs: input.sourceRefs,
    }, () => {
      const facts = this.activeConversation(conversationId);
      const current = this.latestOrFail(`claim:${claimId}`);
      if (current.kind !== 'claim') innerFail('UNKNOWN_INNER_RECORD', 'This identity is not a cognition claim');
      if (current.audience.audienceId !== conversationId) innerFail('INNER_AUDIENCE_FORBIDDEN', 'A revision must come from the audience that formed the claim');
      if (current.revision !== expectedRevision) innerFail('INNER_RECORD_CONFLICT', 'Claim changed; refresh before revising it');
      const payload = this.claimPayload(current);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const nextRevision = current.revision + 1;
      const revisedFrom = validFrom === undefined ? current.validFrom : validFrom;
      const revisedUntil = validUntil === undefined ? current.validUntil : validUntil;
      if (revisedFrom !== undefined && revisedUntil !== undefined && Date.parse(revisedFrom) >= Date.parse(revisedUntil)) innerFail('INVALID_INNER_INPUT', 'Validity interval is empty');
      this.setStatus({ ...current }, 'superseded');
      const recordId = `claim:${claimId}:r${nextRevision}`;
      const nextPayload = validateCognitionPayload({ kind: 'claim', claimId, claimKind: payload.claimKind, claimType: payload.claimType,
        subjectIds: payload.subjectIds, predicate: payload.predicate, proposition: input.proposition, confidenceBps: input.confidenceBps });
      this.persist({ recordId, identity: `claim:${claimId}`, kind: 'claim', status: this.initialStatus(payload.claimType),
        audience: current.audience, sourceRefs: evidence.refs, supersedes: current.recordId,
        ...(revisedFrom === undefined ? {} : { validFrom: revisedFrom }), ...(revisedUntil === undefined ? {} : { validUntil: revisedUntil }),
        payload: nextPayload });
      return { requestId, changed: true, record: { claimId, recordId, revision: nextRevision, status: this.initialStatus(payload.claimType) } };
    }));
  }

  review(input: CognitionCommands['cognition.review']['input']): CognitionCommands['cognition.review']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'claimIds', 'conclusion', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    if (!Array.isArray(input.claimIds) || !input.claimIds.length || input.claimIds.length > 20) innerFail('INVALID_INNER_INPUT', 'A review needs bounded claim identities');
    const claimIds = [...new Set(input.claimIds.map(item => innerId(item, 'claimId')))];
    if (!COGNITION_REVIEW_CONCLUSIONS.includes(input.conclusion as never)) innerFail('INVALID_INNER_INPUT', 'Invalid review conclusion');
    const conclusion = input.conclusion as (typeof COGNITION_REVIEW_CONCLUSIONS)[number];
    return this.tx.atomic(() => this.command(requestId, 'review', { conversationId, claimIds, conclusion, sourceRefs: input.sourceRefs }, () => {
      const facts = this.activeConversation(conversationId);
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      for (const claimId of claimIds) {
        const record = this.latest(`claim:${claimId}`);
        if (!record) innerFail('UNKNOWN_INNER_RECORD', 'A reviewed claim does not exist');
        if (record.audience.audienceId !== conversationId) innerFail('INNER_AUDIENCE_FORBIDDEN', 'A review must come from the audience that formed the claim');
        if (this.evidenceState(record) === 'revoked') innerFail('INNER_SOURCE_REVOKED', 'A withdrawn claim cannot be reviewed as current');
      }
      const reviewId = randomUUID();
      const recordId = `review:${reviewId}:r1`;
      this.persist({ recordId, identity: `review:${reviewId}`, kind: 'review', status: 'recorded', audience: facts.audience,
        sourceRefs: evidence.refs,
        payload: validateCognitionPayload({ kind: 'review', reviewId, claimIds, conclusion }) });
      return { requestId, changed: true, record: { reviewId, recordId, revision: 1 } };
    }));
  }

  resolveConflict(input: CognitionCommands['cognition.resolveConflict']['input']): CognitionCommands['cognition.resolveConflict']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'conflictId', 'expectedRevision', 'winnerRecordId', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    const conflictId = innerId(input.conflictId, 'conflictId');
    const expectedRevision = innerInteger(input.expectedRevision, 'expectedRevision');
    const winnerRecordId = innerId(input.winnerRecordId, 'winnerRecordId');
    return this.tx.atomic(() => this.command(requestId, 'resolve-conflict', { conversationId, conflictId, expectedRevision, winnerRecordId, sourceRefs: input.sourceRefs }, () => {
      const facts = this.activeConversation(conversationId);
      const current = this.latestOrFail(`conflict:${conflictId}`);
      const payload = this.conflictPayload(current);
      if (payload.status !== 'open' || current.status !== 'open') innerFail('INNER_RECORD_CONFLICT', 'This conflict set is already resolved');
      if (current.revision !== expectedRevision) innerFail('INNER_RECORD_CONFLICT', 'Conflict set changed; refresh before resolving');
      if (current.audience.audienceId !== conversationId) innerFail('INNER_AUDIENCE_FORBIDDEN', 'A conflict must be resolved in the audience that formed it');
      const claimIds = new Set<string>();
      for (const recordId of payload.claimRecordIds) {
        const record = this.record(recordId) ?? innerFail('CORRUPT_INNER_DOMAIN', 'A conflicted claim disappeared');
        claimIds.add(this.claimPayload(record).claimId);
      }
      const winner = this.record(winnerRecordId) ?? innerFail('UNKNOWN_INNER_RECORD', 'The proposed conflict winner does not exist');
      const winnerPayload = this.claimPayload(winner);
      if (!claimIds.has(winnerPayload.claimId)) innerFail('INVALID_INNER_INPUT', 'The winner must belong to this conflict set');
      const latestWinner = this.latestOrFail(`claim:${winnerPayload.claimId}`);
      if (latestWinner.recordId !== winnerRecordId) innerFail('INNER_RECORD_CONFLICT', 'The winner is not the current claim revision');
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      for (const claimId of claimIds) {
        const record = this.latestOrFail(`claim:${claimId}`);
        const status = claimId === winnerPayload.claimId ? 'supported' : 'superseded';
        if (record.status !== status) this.setStatus({ ...record }, status);
      }
      const nextRevision = current.revision + 1;
      this.setStatus({ ...current }, 'resolved');
      const recordId = `conflict:${conflictId}:r${nextRevision}`;
      this.persist({ recordId, identity: `conflict:${conflictId}`, kind: 'conflict', status: 'resolved',
        audience: current.audience, sourceRefs: evidence.refs, supersedes: current.recordId,
        payload: validateCognitionPayload({ kind: 'conflict', conflictId, claimRecordIds: payload.claimRecordIds, status: 'resolved', winnerRecordId }) });
      return { requestId, changed: true, record: { conflictId, recordId, revision: nextRevision, winnerRecordId } };
    }));
  }

  withdraw(input: CognitionCommands['cognition.withdraw']['input']): CognitionCommands['cognition.withdraw']['output'] {
    return super.withdraw(input);
  }
  captureForView(input: CognitionCommands['cognition.captureForView']['input']): CognitionCommands['cognition.captureForView']['output'] {
    return super.captureForView(input);
  }
  validateForView(input: CognitionCommands['cognition.validateForView']['input']): CognitionCommands['cognition.validateForView']['output'] {
    return super.validateForView(input);
  }
  readBodies(input: CognitionCommands['cognition.readBodies']['input']): CognitionCommands['cognition.readBodies']['output'] {
    return super.readBodies(input);
  }

  execute(request: CognitionDomainRequest): unknown {
    innerFields(request, ['command', 'args']);
    switch (request.command) {
      case 'cognition.propose': return this.propose(request.args);
      case 'cognition.revise': return this.revise(request.args);
      case 'cognition.review': return this.review(request.args);
      case 'cognition.resolveConflict': return this.resolveConflict(request.args);
      case 'cognition.withdraw': return this.withdraw(request.args);
      case 'cognition.captureForView': return this.captureForView(request.args);
      case 'cognition.validateForView': return this.validateForView(request.args);
      case 'cognition.readBodies': return this.readBodies(request.args);
      case 'cognition.recompute': return this.recompute(request.args);
      case 'cognition.derivations': innerFields(request.args, []); return this.derivations();
      default: return innerFail('INVALID_INNER_INPUT', 'Unknown cognition command');
    }
  }
}
