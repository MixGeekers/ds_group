import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RELATIONSHIP_ASSESSMENT_LEVELS, RELATIONSHIP_ENTITY_KINDS, RELATIONSHIP_PREDICATES,
  innerAccount, innerDigest, innerFail, innerFields, innerId, innerInstant, innerInteger, innerText,
  validateRelationshipPayload,
  type InnerSourceRef, type RelationshipCommands, type RelationshipDomainRequest, type RelationshipEntityKind,
  type RelationshipPayload, type RelationshipPredicate,
} from '../../contracts/inner.js';
export type { RelationshipDomainRequest } from '../../contracts/inner.js';
import { InnerDomainBase, type InnerDomainBaseOptions, type StoredInnerRecord } from './inner-domain.js';
import type { InnerDerivationReason } from '../../contracts/inner.js';
import { SqliteTransactions } from './transaction.js';

/** Relationship rules version; changing them requires an explicit migration. */
export const RELATIONSHIP_POLICY_VERSION = 1;
const RECORD_KINDS = ['entity', 'identity-binding', 'assertion', 'merge'] as const;
const STATUSES = ['active', 'superseded', 'merged', 'reverted'] as const;
type Options = Omit<InnerDomainBaseOptions, 'domain' | 'policyVersion'>;

/**
 * Stable identity mapping and sourced relationship judgements.
 *
 * A display name or short channel id never merges subjects: bindings are keyed
 * by the full trusted account tuple, merges are explicit and reversible, and
 * closeness labels are labelled assessments with no authority effect. Interaction
 * facts carry the conversation audience they were observed in, so a DM fact is
 * never selected for a group audience.
 */
export class RelationshipDomain extends InnerDomainBase {
  constructor(db: DatabaseSync, tx: SqliteTransactions, options: Options) {
    super(db, tx, { ...options, domain: 'relationship', policyVersion: RELATIONSHIP_POLICY_VERSION });
  }

  protected validatePayload(kind: string, payload: unknown): Record<string, unknown> {
    const body = validateRelationshipPayload(payload);
    if (body.kind !== kind) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Relationship record kind disagrees with its payload');
    return body as unknown as Record<string, unknown>;
  }
  protected checkRecord(record: StoredInnerRecord): void {
    if (!RECORD_KINDS.includes(record.kind as (typeof RECORD_KINDS)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown relationship record kind');
    if (!STATUSES.includes(record.status as (typeof STATUSES)[number])) innerFail('CORRUPT_INNER_DOMAIN', 'Unknown relationship record status');
    const ownerScoped = record.kind === 'entity' || record.kind === 'identity-binding' || record.kind === 'merge';
    if (ownerScoped !== (record.audience.kind === 'owner')) innerFail('CORRUPT_INNER_DOMAIN', 'Relationship record audience disagrees with its kind');
    if (!record.identity.startsWith(record.kind === 'identity-binding' ? 'binding:' : `${record.kind}:`)) innerFail('CORRUPT_INNER_DOMAIN', 'Relationship record identity disagrees with its kind');
    if (record.kind === 'identity-binding' && record.status !== 'active') innerFail('CORRUPT_INNER_DOMAIN', 'A binding keeps its original active revision');
  }

  /** Merge/split and corrections move record status; dependants must re-review. */
  protected sourceCurrent(record: StoredInnerRecord): { current: boolean; reason?: InnerDerivationReason } {
    if (record.kind === 'entity') return record.status === 'active'
      ? { current: true } : { current: false, reason: record.status === 'merged' ? 'source_merged' : 'source_not_current' };
    if (record.kind === 'assertion') return record.status === 'active' ? { current: true } : { current: false, reason: 'source_not_current' };
    if (record.kind === 'identity-binding') return record.status === 'active' ? { current: true } : { current: false, reason: 'source_not_current' };
    if (record.kind === 'merge') return record.status === 'active' ? { current: true } : { current: false, reason: 'source_not_current' };
    return { current: false, reason: 'source_not_current' };
  }
  private entity(entityId: string): StoredInnerRecord {
    const record = this.latest(`entity:${innerId(entityId, 'entityId')}`);
    if (!record || record.kind !== 'entity') innerFail('UNKNOWN_INNER_RECORD', 'No known relationship entity has this identity');
    return record;
  }
  private entityPayload(record: StoredInnerRecord): Extract<RelationshipPayload, { kind: 'entity' }> {
    return this.payload(record) as unknown as Extract<RelationshipPayload, { kind: 'entity' }>;
  }
  private activeMergeFor(entityId: string): { record: StoredInnerRecord; payload: Extract<RelationshipPayload, { kind: 'merge' }> } | undefined {
    for (const record of this.latestRecords()) {
      if (record.kind !== 'merge' || record.status !== 'active') continue;
      const payload = this.payload(record) as unknown as Extract<RelationshipPayload, { kind: 'merge' }>;
      if (payload.fromEntityId === entityId) return { record, payload };
    }
    return undefined;
  }
  /** Explicit merge chain only; never inferred from names. Cycles are rejected locally. */
  canonical(entityId: string): { canonicalEntityId: string; mergeIds: string[] } {
    this.entity(entityId);
    let current = entityId;
    const mergeIds: string[] = [];
    const seen = new Set<string>([current]);
    for (let depth = 0; depth < 16; depth++) {
      const merge = this.activeMergeFor(current);
      if (!merge) break;
      if (seen.has(merge.payload.intoEntityId)) innerFail('INNER_ENTITY_CYCLE', 'Explicit subject merges contain a cycle');
      seen.add(merge.payload.intoEntityId);
      mergeIds.push(merge.payload.mergeId);
      current = merge.payload.intoEntityId;
    }
    return { canonicalEntityId: current, mergeIds };
  }
  private requireEntityId(value: unknown, label: string): string {
    const entityId = innerId(value, label);
    this.entity(entityId);
    return entityId;
  }

  registerSubject(input: RelationshipCommands['relationship.registerSubject']['input']): RelationshipCommands['relationship.registerSubject']['output'] {
    innerFields(input, ['requestId', 'account', 'entityKind', 'displayName']);
    const requestId = innerId(input.requestId, 'requestId');
    if (!RELATIONSHIP_ENTITY_KINDS.includes(input.entityKind as RelationshipEntityKind)) innerFail('INVALID_INNER_INPUT', 'Invalid entity kind');
    const account = innerAccount(input.account);
    const entityKind = input.entityKind as RelationshipEntityKind;
    const displayName = innerText(input.displayName, 'displayName', 120);
    const accountKey = innerDigest(account);
    return this.tx.atomic(() => this.command(requestId, 'register-subject', { account, entityKind, displayName }, () => {
      const identity = `binding:${accountKey}`;
      const existing = this.latest(identity);
      if (existing) {
        const binding = this.payload(existing) as unknown as Extract<RelationshipPayload, { kind: 'identity-binding' }>;
        return { requestId, changed: false, record: { entityId: binding.entityId, bindingId: accountKey,
          canonicalEntityId: this.canonical(binding.entityId).canonicalEntityId, created: false } };
      }
      const entityId = randomUUID();
      const audience = this.ownedAudience();
      const sourceRefs = [this.ownerCommand(requestId)];
      this.persist({ recordId: `entity:${entityId}:r1`, identity: `entity:${entityId}`, kind: 'entity', status: 'active',
        audience, sourceRefs, payload: { kind: 'entity', entityKind, displayName } });
      this.persist({ recordId: `binding:${accountKey}:r1`, identity, kind: 'identity-binding', status: 'active',
        audience, sourceRefs, payload: { kind: 'identity-binding', entityId, account, assurance: 'trusted-channel-metadata' } });
      return { requestId, changed: true, record: { entityId, bindingId: accountKey, canonicalEntityId: entityId, created: true } };
    }));
  }

  private assertionPayload(input: {
    assertionId: string; subjectId: string; predicate: RelationshipPredicate; objectId?: string;
    value?: string; saidBy?: string;
  }): Extract<RelationshipPayload, { kind: 'assertion' }> {
    if (!RELATIONSHIP_PREDICATES.includes(input.predicate)) innerFail('INVALID_INNER_INPUT', 'Unknown relationship predicate');
    const saidBy = input.saidBy === undefined ? undefined : this.requireEntityId(input.saidBy, 'saidBy');
    const subjectId = this.requireEntityId(input.subjectId, 'subjectId');
    const objectId = input.objectId === undefined ? undefined : this.requireEntityId(input.objectId, 'objectId');
    const epistemicStatus = input.predicate === 'owner-assessment' ? 'assessed'
      : saidBy !== undefined && saidBy !== subjectId ? 'reported'
        : 'observed';
    return validateRelationshipPayload({
      kind: 'assertion', assertionId: input.assertionId, subjectId, predicate: input.predicate,
      ...(objectId === undefined ? {} : { objectId }), ...(input.value === undefined ? {} : { value: input.value }),
      ...(saidBy === undefined ? {} : { saidBy }), epistemicStatus,
    }) as unknown as Extract<RelationshipPayload, { kind: 'assertion' }>;
  }

  assert(input: RelationshipCommands['relationship.assert']['input']): RelationshipCommands['relationship.assert']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'subjectId', 'predicate', 'objectId', 'value', 'saidBy', 'validFrom', 'validUntil', 'sourceRefs'],
      ['requestId', 'conversationId', 'subjectId', 'predicate', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    const predicate = input.predicate as RelationshipPredicate;
    const validFrom = input.validFrom === undefined ? undefined : innerInstant(input.validFrom, 'validFrom');
    const validUntil = input.validUntil === undefined ? undefined : innerInstant(input.validUntil, 'validUntil');
    if (validFrom !== undefined && validUntil !== undefined && Date.parse(validFrom) >= Date.parse(validUntil)) innerFail('INVALID_INNER_INPUT', 'Validity interval is empty');
    return this.tx.atomic(() => this.command(requestId, 'assert', {
      conversationId, subjectId: input.subjectId, predicate, objectId: input.objectId, value: input.value, saidBy: input.saidBy,
      validFrom, validUntil, sourceRefs: input.sourceRefs,
    }, () => {
      const facts = this.activeConversation(conversationId);
      const assertionId = randomUUID();
      const payload = this.assertionPayload({ assertionId, subjectId: innerId(input.subjectId, 'subjectId'), predicate,
        ...(input.objectId === undefined ? {} : { objectId: input.objectId }), ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.saidBy === undefined ? {} : { saidBy: input.saidBy }) });
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      this.persist({ recordId: `assertion:${assertionId}:r1`, identity: `assertion:${assertionId}`, kind: 'assertion',
        status: 'active', audience: facts.audience, sourceRefs: evidence.refs, ...(validFrom === undefined ? {} : { validFrom }),
        ...(validUntil === undefined ? {} : { validUntil }), payload });
      return { requestId, changed: true, record: { assertionId, recordId: `assertion:${assertionId}:r1`, revision: 1, status: 'active' } };
    }));
  }

  reviseAssertion(input: RelationshipCommands['relationship.reviseAssertion']['input']): RelationshipCommands['relationship.reviseAssertion']['output'] {
    innerFields(input, ['requestId', 'conversationId', 'assertionId', 'expectedRevision', 'predicate', 'objectId', 'value', 'saidBy', 'validFrom', 'validUntil', 'sourceRefs'],
      ['requestId', 'conversationId', 'assertionId', 'expectedRevision', 'predicate', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const conversationId = innerId(input.conversationId, 'conversationId');
    const assertionId = innerId(input.assertionId, 'assertionId');
    const expectedRevision = innerInteger(input.expectedRevision, 'expectedRevision');
    const predicate = input.predicate as RelationshipPredicate;
    const validFrom = input.validFrom === undefined ? undefined : innerInstant(input.validFrom, 'validFrom');
    const validUntil = input.validUntil === undefined ? undefined : innerInstant(input.validUntil, 'validUntil');
    if (validFrom !== undefined && validUntil !== undefined && Date.parse(validFrom) >= Date.parse(validUntil)) innerFail('INVALID_INNER_INPUT', 'Validity interval is empty');
    return this.tx.atomic(() => this.command(requestId, 'revise-assertion', {
      conversationId, assertionId, expectedRevision, predicate, objectId: input.objectId, value: input.value, saidBy: input.saidBy,
      validFrom, validUntil, sourceRefs: input.sourceRefs,
    }, () => {
      const facts = this.activeConversation(conversationId);
      const current = this.latestOrFail(`assertion:${assertionId}`);
      if (current.kind !== 'assertion') innerFail('UNKNOWN_INNER_RECORD', 'This identity is not a relationship assertion');
      if (current.audience.audienceId !== conversationId) innerFail('INNER_AUDIENCE_FORBIDDEN', 'A correction must come from the audience that observed it');
      if (current.revision !== expectedRevision) innerFail('INNER_RECORD_CONFLICT', 'Relationship assertion changed; refresh before correcting it');
      const nextRevision = current.revision + 1;
      const payload = this.assertionPayload({ assertionId, subjectId: (this.payload(current) as unknown as Extract<RelationshipPayload, { kind: 'assertion' }>).subjectId,
        predicate, ...(input.objectId === undefined ? {} : { objectId: input.objectId }), ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.saidBy === undefined ? {} : { saidBy: input.saidBy }) });
      const evidence = this.assertWriteEvidence(input.sourceRefs, facts.audience, requestId);
      const recordId = `assertion:${assertionId}:r${nextRevision}`;
      const prior = this.record(current.recordId)!;
      this.setStatus(prior, 'superseded');
      this.persist({ recordId, identity: `assertion:${assertionId}`, kind: 'assertion', status: 'active', audience: current.audience,
        sourceRefs: evidence.refs, supersedes: prior.recordId, ...(validFrom === undefined ? {} : { validFrom }),
        ...(validUntil === undefined ? {} : { validUntil }), payload });
      return { requestId, changed: true, record: { assertionId, recordId, revision: nextRevision, status: 'active' } };
    }));
  }

  mergeSubjects(input: RelationshipCommands['relationship.mergeSubjects']['input']): RelationshipCommands['relationship.mergeSubjects']['output'] {
    innerFields(input, ['requestId', 'fromEntityId', 'intoEntityId', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const fromEntityId = innerId(input.fromEntityId, 'fromEntityId');
    const intoEntityId = innerId(input.intoEntityId, 'intoEntityId');
    return this.tx.atomic(() => this.command(requestId, 'merge-subjects', { fromEntityId, intoEntityId, sourceRefs: input.sourceRefs }, () => {
      if (fromEntityId === intoEntityId) innerFail('INVALID_INNER_INPUT', 'A subject cannot merge into itself');
      this.entity(fromEntityId); this.entity(intoEntityId);
      if (this.activeMergeFor(fromEntityId)) innerFail('INNER_RECORD_CONFLICT', 'This subject is already explicitly merged');
      const target = this.canonical(intoEntityId);
      if (target.canonicalEntityId === fromEntityId) innerFail('INNER_ENTITY_CYCLE', 'Explicit subject merges would create a cycle');
      const evidence = this.assertWriteEvidence(input.sourceRefs, this.ownedAudience(), requestId);
      const mergeId = randomUUID();
      this.persist({ recordId: `merge:${mergeId}:r1`, identity: `merge:${mergeId}`, kind: 'merge', status: 'active',
        audience: this.ownedAudience(), sourceRefs: evidence.refs,
        payload: { kind: 'merge', mergeId, fromEntityId, intoEntityId, active: true } });
      const entity = this.entity(fromEntityId);
      this.setStatus({ ...entity }, 'merged');
      return { requestId, changed: true, record: { mergeId, canonicalEntityId: this.canonical(intoEntityId).canonicalEntityId } };
    }));
  }

  splitSubjects(input: RelationshipCommands['relationship.splitSubjects']['input']): RelationshipCommands['relationship.splitSubjects']['output'] {
    innerFields(input, ['requestId', 'mergeId', 'expectedRevision', 'sourceRefs']);
    const requestId = innerId(input.requestId, 'requestId');
    const mergeId = innerId(input.mergeId, 'mergeId');
    const expectedRevision = innerInteger(input.expectedRevision, 'expectedRevision');
    return this.tx.atomic(() => this.command(requestId, 'split-subjects', { mergeId, expectedRevision, sourceRefs: input.sourceRefs }, () => {
      const current = this.latestOrFail(`merge:${mergeId}`);
      const payload = this.payload(current) as unknown as Extract<RelationshipPayload, { kind: 'merge' }>;
      if (payload.kind !== 'merge') innerFail('UNKNOWN_INNER_RECORD', 'This identity is not an explicit subject merge');
      if (payload.active === false || current.status !== 'active') innerFail('INNER_RECORD_CONFLICT', 'This subject merge is already reverted');
      if (current.revision !== expectedRevision) innerFail('INNER_RECORD_CONFLICT', 'Subject merge changed; refresh before splitting');
      const evidence = this.assertWriteEvidence(input.sourceRefs, this.ownedAudience(), requestId);
      const nextRevision = current.revision + 1;
      this.setStatus({ ...current }, 'reverted');
      this.persist({ recordId: `merge:${mergeId}:r${nextRevision}`, identity: `merge:${mergeId}`, kind: 'merge', status: 'reverted',
        audience: this.ownedAudience(), sourceRefs: evidence.refs, supersedes: current.recordId,
        payload: { kind: 'merge', mergeId, fromEntityId: payload.fromEntityId, intoEntityId: payload.intoEntityId, active: false } });
      const from = this.entity(payload.fromEntityId);
      if (from.status === 'merged') this.setStatus({ ...from }, 'active');
      return { requestId, changed: true, record: { mergeId, canonicalEntityId: payload.fromEntityId } };
    }));
  }

  resolveSubject(input: RelationshipCommands['relationship.resolveSubject']['input']): RelationshipCommands['relationship.resolveSubject']['output'] {
    innerFields(input, ['entityId']);
    const entityId = innerId(input.entityId, 'entityId');
    return this.tx.atomic(() => {
      this.entity(entityId);
      const resolved = this.canonical(entityId);
      return { entityId, canonicalEntityId: resolved.canonicalEntityId, mergeIds: resolved.mergeIds };
    });
  }

  withdraw(input: RelationshipCommands['relationship.withdraw']['input']): RelationshipCommands['relationship.withdraw']['output'] {
    return super.withdraw(input);
  }
  captureForView(input: RelationshipCommands['relationship.captureForView']['input']): RelationshipCommands['relationship.captureForView']['output'] {
    return super.captureForView(input);
  }
  validateForView(input: RelationshipCommands['relationship.validateForView']['input']): RelationshipCommands['relationship.validateForView']['output'] {
    return super.validateForView(input);
  }
  readBodies(input: RelationshipCommands['relationship.readBodies']['input']): RelationshipCommands['relationship.readBodies']['output'] {
    return super.readBodies(input);
  }

  execute(request: RelationshipDomainRequest): unknown {
    innerFields(request, ['command', 'args']);
    switch (request.command) {
      case 'relationship.registerSubject': return this.registerSubject(request.args);
      case 'relationship.assert': return this.assert(request.args);
      case 'relationship.reviseAssertion': return this.reviseAssertion(request.args);
      case 'relationship.mergeSubjects': return this.mergeSubjects(request.args);
      case 'relationship.splitSubjects': return this.splitSubjects(request.args);
      case 'relationship.resolveSubject': return this.resolveSubject(request.args);
      case 'relationship.withdraw': return this.withdraw(request.args);
      case 'relationship.captureForView': return this.captureForView(request.args);
      case 'relationship.validateForView': return this.validateForView(request.args);
      case 'relationship.readBodies': return this.readBodies(request.args);
      case 'relationship.recompute': return this.recompute(request.args);
      case 'relationship.derivations': innerFields(request.args, []); return this.derivations();
      default: return innerFail('INVALID_INNER_INPUT', 'Unknown relationship command');
    }
  }
}
