import { createHash } from 'node:crypto';

/**
 * H4 inner-domain contracts: relationship / emotion / cognition / personality.
 *
 * These domains are explainable local-control state, not a second authoritative
 * memory-body store. Records carry provenance and audience; bodies are bounded
 * judgements (or small profile/rule values), never conversation history or
 * memory text. Every capture is metadata-only and every body read revalidates
 * the captured identity before returning content.
 */
export const INNER_DOMAINS = ['relationship', 'emotion', 'cognition', 'personality'] as const;
export type InnerDomain = (typeof INNER_DOMAINS)[number];
/** Fixed read backends; these are not tool registries or execution authorities. */
export const INNER_DOMAIN_BACKENDS: Readonly<Record<InnerDomain, string>> = Object.freeze({
  relationship: 'control-relationship',
  emotion: 'control-emotion',
  cognition: 'control-cognition',
  personality: 'control-personality',
});
/** Only metadata and exact content reads are declared, and only after publication. */
export const INNER_DOMAIN_CAPABILITIES = ['metadata_read', 'content_read'] as const;
export type InnerDomainCapability = (typeof INNER_DOMAIN_CAPABILITIES)[number];

export const INNER_AUDIENCE_KINDS = ['owner', 'direct', 'group', 'channel'] as const;
export type InnerAudienceKind = (typeof INNER_AUDIENCE_KINDS)[number];
/** Owner-private records are visible to every local-owner audience; others only in their own audience. */
export interface InnerAudience {
  scope: string;
  kind: InnerAudienceKind;
  audienceId: string;
}
export const INNER_SOURCE_KINDS = ['owner-command', 'conversation-observation', 'memory-operation', 'task-receipt'] as const;
export type InnerSourceKind = (typeof INNER_SOURCE_KINDS)[number];
/** A durable, resolvable provenance reference; never a bearer permission. */
export interface InnerSourceRef { kind: InnerSourceKind; sourceId: string; revision: number }

/** Trusted same-Worker resolution result for one non-conversation source. */
export interface InnerEvidenceFacts {
  valid: boolean;
  audience: InnerAudience;
  revision: number;
  observedAt?: string;
}
/** Trusted same-Worker conversation/audience read. */
export interface InnerConversationFacts {
  audience: InnerAudience;
  revision: number;
  audienceVersion: number;
  active: boolean;
}

export const INNER_EVIDENCE_STATES = ['valid', 'degraded', 'revoked'] as const;
export type InnerEvidenceState = (typeof INNER_EVIDENCE_STATES)[number];

/** Invalidation-relevant domain authority; deliberately excludes max(version) bookkeeping. */
export interface InnerAuthority {
  domain: InnerDomain;
  authorityId: string;
  installationGeneration: string;
  policyVersion: number;
  tombstoneWatermark: number;
  baselineId: string;
}

/** Metadata-only capture. Never contains a body, payload digest or memory text. */
export interface InnerRecordMetadata {
  recordId: string;
  revision: number;
  kind: string;
  status: string;
  evidenceState: InnerEvidenceState;
  audience: InnerAudience;
  sourceRefs: InnerSourceRef[];
  observedAt: string;
  validUntil?: string;
  recordDigest: string;
  bodyAvailable: boolean;
}
export interface InnerCapture {
  schemaVersion: 1;
  domain: InnerDomain;
  conversationId: string;
  capturedAt: string;
  audience: InnerAudience;
  authority: InnerAuthority;
  records: InnerRecordMetadata[];
  truncated: boolean;
  snapshotHash: string;
}
export interface InnerBodyRecord {
  recordId: string;
  revision: number;
  kind: string;
  evidenceState: InnerEvidenceState;
  payload: Record<string, unknown>;
}
export interface InnerBodyRead {
  schemaVersion: 1;
  domain: InnerDomain;
  authority: InnerAuthority;
  capturedAt: string;
  bodies: InnerBodyRecord[];
}
export interface InnerCaptureInput { conversationId: string; recordIds?: readonly string[] }
export interface InnerBodyReadInput { capture: InnerCapture; recordIds: readonly string[] }
export type InnerViewDomains = Partial<Record<InnerDomain, InnerCapture>>;

export const MAX_INNER_VIEW_RECORDS = 200;
export const MAX_INNER_SOURCE_REFS = 8;
export const MAX_INNER_PAYLOAD_BYTES = 4096;

export class InnerContractError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'InnerContractError'; }
}
export function innerFail(code: string, message: string): never { throw new InnerContractError(code, message); }
/** Strict plain-object check: no accessors, no unknown keys, no symbols. */
export function innerFields(value: unknown, keys: readonly string[], required: readonly string[] = keys): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    innerFail('INVALID_INNER_INPUT', 'Expected bounded plain inner-domain metadata');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value') || !field.enumerable)) {
    innerFail('INVALID_INNER_INPUT', 'Unknown, accessor or missing inner-domain fields');
  }
}
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;
const accountPartPattern = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,199}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[a-z][a-z0-9-]{0,39}$/;
export function innerKind(value: unknown, code: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    innerFail(code, 'Expected a plain inner payload');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || typeof descriptor.value !== 'string' || !tokenPattern.test(descriptor.value)) {
    innerFail(code, 'Invalid inner payload kind');
  }
  return descriptor.value as string;
}
export function innerId(value: unknown, label = 'identity', max = 200): string {
  if (typeof value !== 'string' || value.length > max || !identityPattern.test(value)) innerFail('INVALID_INNER_INPUT', `Invalid ${label}`);
  return value;
}
export function innerToken(value: unknown, label = 'token'): string {
  if (typeof value !== 'string' || !tokenPattern.test(value)) innerFail('INVALID_INNER_INPUT', `Invalid ${label}`);
  return value;
}
export function innerAccountPart(value: unknown, label = 'account field'): string {
  if (typeof value !== 'string' || !accountPartPattern.test(value)) innerFail('INVALID_INNER_INPUT', `Invalid ${label}`);
  return value;
}
export function innerInteger(value: unknown, label = 'integer', min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) innerFail('INVALID_INNER_INPUT', `Invalid ${label}`);
  return Number(value);
}
export function innerBps(value: unknown, label = 'basis points'): number {
  return innerInteger(value, label, 0, 10000);
}
export function innerHash(value: unknown, label = 'digest'): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) innerFail('INVALID_INNER_INPUT', `Invalid ${label}`);
  return value as string;
}
export function innerInstant(value: unknown, label = 'timestamp'): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    innerFail('INVALID_INNER_INPUT', `Invalid canonical ${label}`);
  }
  return value as string;
}
/** Bounded human-readable text used in judgements only; never a memory body copy. */
export function innerText(value: unknown, label = 'text', max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max
    || /[\u0000-\u001f\u007f]/u.test(value) || /\p{Surrogate}/u.test(value)) innerFail('INVALID_INNER_INPUT', `Invalid ${label}`);
  return value as string;
}
export function innerAccount(value: unknown): InnerAccount {
  innerFields(value, ['connectionId', 'identityNamespace', 'identityType', 'externalSubjectId']);
  return Object.freeze({
    connectionId: innerAccountPart(value.connectionId, 'connectionId'),
    identityNamespace: innerAccountPart(value.identityNamespace, 'identityNamespace'),
    identityType: innerAccountPart(value.identityType, 'identityType'),
    externalSubjectId: innerAccountPart(value.externalSubjectId, 'externalSubjectId'),
  });
}
export interface InnerAccount { connectionId: string; identityNamespace: string; identityType: string; externalSubjectId: string }
export function innerAudience(value: unknown): InnerAudience {
  innerFields(value, ['scope', 'kind', 'audienceId']);
  if (!INNER_AUDIENCE_KINDS.includes(value.kind as InnerAudienceKind)) innerFail('INVALID_INNER_INPUT', 'Invalid audience kind');
  return { scope: innerId(value.scope, 'audience scope'), kind: value.kind as InnerAudienceKind, audienceId: innerId(value.audienceId, 'audience identity') };
}
export function innerSourceKind(value: unknown): InnerSourceKind {
  if (!INNER_SOURCE_KINDS.includes(value as InnerSourceKind)) innerFail('INVALID_INNER_INPUT', 'Invalid evidence source kind');
  return value as InnerSourceKind;
}
export function innerSourceRef(value: unknown): InnerSourceRef {
  innerFields(value, ['kind', 'sourceId', 'revision']);
  return { kind: innerSourceKind(value.kind), sourceId: innerId(value.sourceId, 'source identity'), revision: innerInteger(value.revision, 'source revision') };
}
export function innerSourceRefs(value: unknown, minimum = 1): InnerSourceRef[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_INNER_SOURCE_REFS) innerFail('INVALID_INNER_INPUT', 'Bounded provenance references are required');
  const refs = value.map(item => innerSourceRef(item));
  const keys = refs.map(ref => innerSourceKey(ref));
  if (new Set(keys).size !== keys.length) innerFail('INVALID_INNER_INPUT', 'Duplicate provenance reference');
  return refs.sort((a, b) => innerSourceKey(a).localeCompare(innerSourceKey(b)));
}
export function innerSourceKey(ref: Pick<InnerSourceRef, 'kind' | 'sourceId' | 'revision'>): string {
  return `${ref.kind}:${ref.sourceId}@${ref.revision}`;
}
export function innerOwnerCommandRef(requestId: string): InnerSourceRef {
  return { kind: 'owner-command', sourceId: `owner-command:${innerId(requestId, 'requestId')}`, revision: 1 };
}
/** Decode the enclosing trusted command identity from an owner-command reference. */
export function innerOwnerCommandRequest(ref: InnerSourceRef): string | undefined {
  return ref.kind === 'owner-command' && ref.sourceId.startsWith('owner-command:') ? ref.sourceId.slice('owner-command:'.length) : undefined;
}
export function innerAuthority(value: unknown): InnerAuthority {
  innerFields(value, ['domain', 'authorityId', 'installationGeneration', 'policyVersion', 'tombstoneWatermark', 'baselineId']);
  if (!INNER_DOMAINS.includes(value.domain as InnerDomain)) innerFail('INVALID_INNER_INPUT', 'Invalid inner domain');
  return {
    domain: value.domain as InnerDomain,
    authorityId: innerId(value.authorityId, 'authorityId'),
    installationGeneration: innerId(value.installationGeneration, 'installationGeneration'),
    policyVersion: innerInteger(value.policyVersion, 'policyVersion'),
    tombstoneWatermark: innerInteger(value.tombstoneWatermark, 'tombstoneWatermark', 0),
    baselineId: innerId(value.baselineId, 'baselineId'),
  };
}
export function innerRecordMetadata(value: unknown): InnerRecordMetadata {
  innerFields(value, ['recordId', 'revision', 'kind', 'status', 'evidenceState', 'audience', 'sourceRefs', 'observedAt', 'validUntil', 'recordDigest', 'bodyAvailable'],
    ['recordId', 'revision', 'kind', 'status', 'evidenceState', 'audience', 'sourceRefs', 'observedAt', 'recordDigest', 'bodyAvailable']);
  if (!INNER_EVIDENCE_STATES.includes(value.evidenceState as InnerEvidenceState)) innerFail('INVALID_INNER_INPUT', 'Invalid evidence state');
  if (typeof value.bodyAvailable !== 'boolean') innerFail('INVALID_INNER_INPUT', 'bodyAvailable must be boolean');
  return {
    recordId: innerId(value.recordId, 'recordId'),
    revision: innerInteger(value.revision, 'revision'),
    kind: innerToken(value.kind, 'record kind'),
    status: innerToken(value.status, 'record status'),
    evidenceState: value.evidenceState as InnerEvidenceState,
    audience: innerAudience(value.audience),
    sourceRefs: innerSourceRefs(value.sourceRefs),
    observedAt: innerInstant(value.observedAt, 'observedAt'),
    ...(value.validUntil === undefined ? {} : { validUntil: innerInstant(value.validUntil, 'validUntil') }),
    recordDigest: innerHash(value.recordDigest, 'recordDigest'),
    bodyAvailable: value.bodyAvailable,
  };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function innerCanonical(value: unknown): string { return canonicalJson(value); }
export function innerDigest(value: unknown): string { return createHash('sha256').update(innerCanonical(value)).digest('hex'); }
function captureHash(value: Pick<InnerCapture, 'domain' | 'conversationId' | 'capturedAt' | 'audience' | 'authority' | 'records' | 'truncated'>): string {
  return innerDigest({ schemaVersion: 1, domain: value.domain, conversationId: value.conversationId, capturedAt: value.capturedAt,
    audience: value.audience, authority: value.authority, records: value.records, truncated: value.truncated });
}
export function innerRecordDigest(value: {
  recordId: string; revision: number; kind: string; status: string; audience: InnerAudience;
  sourceRefs: readonly InnerSourceRef[]; observedAt: string; validFrom?: string; validUntil?: string;
  payloadDigest: string;
}): string {
  return innerDigest({ schemaVersion: 1, recordId: value.recordId, revision: value.revision, kind: value.kind, status: value.status,
    audience: value.audience, sourceRefs: value.sourceRefs, observedAt: value.observedAt,
    validFrom: value.validFrom ?? null, validUntil: value.validUntil ?? null, payloadDigest: value.payloadDigest });
}
export function validateInnerCapture(value: unknown): InnerCapture {
  innerFields(value, ['schemaVersion', 'domain', 'conversationId', 'capturedAt', 'audience', 'authority', 'records', 'truncated', 'snapshotHash']);
  if (value.schemaVersion !== 1 || !INNER_DOMAINS.includes(value.domain as InnerDomain) || typeof value.truncated !== 'boolean') {
    innerFail('INVALID_INNER_INPUT', 'Invalid inner capture header');
  }
  if (!Array.isArray(value.records) || value.records.length > MAX_INNER_VIEW_RECORDS) innerFail('INVALID_INNER_INPUT', 'Invalid bounded inner capture records');
  const records = value.records.map(item => innerRecordMetadata(item));
  if (new Set(records.map(item => item.recordId)).size !== records.length) innerFail('INVALID_INNER_INPUT', 'Duplicate captured record identity');
  const capture: InnerCapture = {
    schemaVersion: 1, domain: value.domain as InnerDomain, conversationId: innerId(value.conversationId, 'conversationId'),
    capturedAt: innerInstant(value.capturedAt, 'capturedAt'), audience: innerAudience(value.audience),
    authority: innerAuthority(value.authority), records, truncated: value.truncated,
    snapshotHash: innerHash(value.snapshotHash, 'snapshotHash'),
  };
  if (capture.authority.domain !== capture.domain) innerFail('INVALID_INNER_INPUT', 'Capture authority belongs to another domain');
  if (captureHash(capture) !== capture.snapshotHash) innerFail('INNER_CAPTURE_TAMPERED', 'Inner capture identity changed');
  return capture;
}
export function innerCaptureHash(capture: Pick<InnerCapture, 'domain' | 'conversationId' | 'capturedAt' | 'audience' | 'authority' | 'records' | 'truncated'>): string {
  return captureHash(capture);
}
export function innerJsonObject(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8) innerFail('INVALID_INNER_INPUT', 'Inner payload is too deeply nested');
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    innerFail('INVALID_INNER_INPUT', 'Inner payload must be a plain object');
  }
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) innerFail('INVALID_INNER_INPUT', 'Unsafe inner payload field');
    if (typeof item === 'string') {
      if (item.length > 2048 || /\p{Surrogate}/u.test(item)) innerFail('INVALID_INNER_INPUT', 'Invalid inner payload text');
    } else if (item !== null && typeof item === 'object') innerJsonValue(item, depth + 1);
    else if (typeof item === 'number' && !Number.isFinite(item)) innerFail('INVALID_INNER_INPUT', 'Inner payload numbers must be finite');
    else if (!['boolean', 'number'].includes(typeof item)) innerFail('INVALID_INNER_INPUT', 'Invalid inner payload value');
  }
  if (Buffer.byteLength(innerCanonical(value), 'utf8') > MAX_INNER_PAYLOAD_BYTES) innerFail('INVALID_INNER_INPUT', 'Inner payload exceeds its bound');
  return value as Record<string, unknown>;
}
function innerJsonValue(value: unknown, depth: number): void {
  if (depth > 8) innerFail('INVALID_INNER_INPUT', 'Inner payload is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && (value.length > 2048 || /\p{Surrogate}/u.test(value))) innerFail('INVALID_INNER_INPUT', 'Invalid inner payload text');
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) innerJsonValue(item, depth + 1); return; }
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) innerFail('INVALID_INNER_INPUT', 'Unsafe inner payload field');
      innerJsonValue(item, depth + 1);
    }
    return;
  }
  innerFail('INVALID_INNER_INPUT', 'Invalid inner payload value');
}
export function innerPayload(value: unknown): Record<string, unknown> {
  return structuredClone(innerJsonObject(value));
}
export function validateInnerBodyRead(value: unknown): InnerBodyRead {
  innerFields(value, ['schemaVersion', 'domain', 'authority', 'capturedAt', 'bodies']);
  if (value.schemaVersion !== 1 || !INNER_DOMAINS.includes(value.domain as InnerDomain)) innerFail('INVALID_INNER_INPUT', 'Invalid inner body read header');
  if (!Array.isArray(value.bodies) || !value.bodies.length || value.bodies.length > MAX_INNER_VIEW_RECORDS) innerFail('INVALID_INNER_INPUT', 'Invalid bounded inner bodies');
  const bodies = value.bodies.map(item => {
    innerFields(item, ['recordId', 'revision', 'kind', 'evidenceState', 'payload']);
    if (!INNER_EVIDENCE_STATES.includes(item.evidenceState as InnerEvidenceState)) innerFail('INVALID_INNER_INPUT', 'Invalid body evidence state');
    return {
      recordId: innerId(item.recordId, 'recordId'), revision: innerInteger(item.revision, 'revision'),
      kind: innerToken(item.kind, 'record kind'), evidenceState: item.evidenceState as InnerEvidenceState,
      payload: innerPayload(item.payload) as Record<string, unknown>,
    };
  });
  if (new Set(bodies.map(item => item.recordId)).size !== bodies.length) innerFail('INVALID_INNER_INPUT', 'Duplicate body record identity');
  const result: InnerBodyRead = { schemaVersion: 1, domain: value.domain as InnerDomain, authority: innerAuthority(value.authority),
    capturedAt: innerInstant(value.capturedAt, 'capturedAt'), bodies };
  if (result.authority.domain !== result.domain) innerFail('INVALID_INNER_INPUT', 'Body authority belongs to another domain');
  return result;
}
/** Default-deny audience visibility. Owner-private records never carry conversation material. */
export function innerAudienceVisible(record: InnerAudience, capture: InnerAudience): boolean {
  if (record.scope !== capture.scope) return false;
  return record.kind === 'owner' || record.audienceId === capture.audienceId;
}
/** An evidence source must be visible inside the audience it supports. Owner scope is the superset. */
export function innerEvidenceVisible(source: InnerAudience, record: InnerAudience): boolean {
  if (source.scope !== record.scope) return false;
  if (record.kind === 'owner') return true;
  return source.kind === 'owner' || source.audienceId === record.audienceId;
}

/* -------------------------------------------------------------------------- */
/* Relationship                                                               */
/* -------------------------------------------------------------------------- */
export const RELATIONSHIP_ENTITY_KINDS = ['person', 'org', 'project', 'device', 'other'] as const;
export type RelationshipEntityKind = (typeof RELATIONSHIP_ENTITY_KINDS)[number];
export const RELATIONSHIP_PREDICATES = ['alias', 'member-of', 'participates-in', 'communication-preference', 'relationship-label', 'interaction', 'owner-assessment'] as const;
export type RelationshipPredicate = (typeof RELATIONSHIP_PREDICATES)[number];
export const RELATIONSHIP_COMMUNICATION_PREFERENCES = ['brief', 'detailed', 'formal', 'casual'] as const;
export const RELATIONSHIP_LABELS = ['colleague', 'friend', 'family', 'client', 'partner', 'other'] as const;
export const RELATIONSHIP_INTERACTIONS = ['message-exchange', 'call', 'meeting'] as const;
export const RELATIONSHIP_ASSESSMENT_LEVELS = ['new', 'familiar', 'socially-close'] as const;
export const RELATIONSHIP_EPISTEMIC_STATUSES = ['stated', 'observed', 'reported', 'assessed'] as const;
export type RelationshipPayload =
  | { kind: 'entity'; entityKind: RelationshipEntityKind; displayName: string }
  | { kind: 'identity-binding'; entityId: string; account: InnerAccount; assurance: 'trusted-channel-metadata' | 'user-confirmed'; }
  | { kind: 'assertion'; assertionId: string; subjectId: string; predicate: RelationshipPredicate; objectId?: string; value?: string; saidBy?: string; epistemicStatus: (typeof RELATIONSHIP_EPISTEMIC_STATUSES)[number]; }
  | { kind: 'merge'; mergeId: string; fromEntityId: string; intoEntityId: string; active: boolean };
export function validateRelationshipPayload(value: unknown): RelationshipPayload {
  const kind = innerKind(value, 'INVALID_RELATIONSHIP_PAYLOAD');
  if (kind === 'entity') {
    innerFields(value, ['kind', 'entityKind', 'displayName']);
    if (!RELATIONSHIP_ENTITY_KINDS.includes(value.entityKind as RelationshipEntityKind)) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Invalid entity kind');
    return { kind: 'entity', entityKind: value.entityKind as RelationshipEntityKind, displayName: innerText(value.displayName, 'displayName', 120) };
  }
  if (kind === 'identity-binding') {
    innerFields(value, ['kind', 'entityId', 'account', 'assurance']);
    if (!['trusted-channel-metadata', 'user-confirmed'].includes(String(value.assurance))) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Invalid binding assurance');
    return { kind: 'identity-binding', entityId: innerId(value.entityId, 'entityId'), account: innerAccount(value.account),
      assurance: value.assurance as 'trusted-channel-metadata' | 'user-confirmed' };
  }
  if (kind === 'assertion') {
    innerFields(value, ['kind', 'assertionId', 'subjectId', 'predicate', 'objectId', 'value', 'saidBy', 'epistemicStatus'],
      ['kind', 'assertionId', 'subjectId', 'predicate', 'epistemicStatus']);
    if (!RELATIONSHIP_PREDICATES.includes(value.predicate as RelationshipPredicate)) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Unknown relationship predicate');
    if (!RELATIONSHIP_EPISTEMIC_STATUSES.includes(value.epistemicStatus as never)) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Unknown epistemic status');
    const objectId = value.objectId === undefined ? undefined : innerId(value.objectId, 'objectId');
    const saidBy = value.saidBy === undefined ? undefined : innerId(value.saidBy, 'saidBy');
    const normalized: RelationshipPayload = { kind: 'assertion', assertionId: innerId(value.assertionId, 'assertionId'),
      subjectId: innerId(value.subjectId, 'subjectId'), predicate: value.predicate as RelationshipPredicate,
      epistemicStatus: value.epistemicStatus as (typeof RELATIONSHIP_EPISTEMIC_STATUSES)[number] };
    if (objectId !== undefined) normalized.objectId = objectId;
    if (saidBy !== undefined) normalized.saidBy = saidBy;
    if (value.value !== undefined) normalized.value = innerText(value.value, 'relationship value', 120);
    relationshipValueShape(normalized);
    return normalized;
  }
  if (kind === 'merge') {
    innerFields(value, ['kind', 'mergeId', 'fromEntityId', 'intoEntityId', 'active']);
    if (typeof value.active !== 'boolean') innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Merge active must be boolean');
    return { kind: 'merge', mergeId: innerId(value.mergeId, 'mergeId'), fromEntityId: innerId(value.fromEntityId, 'fromEntityId'),
      intoEntityId: innerId(value.intoEntityId, 'intoEntityId'), active: value.active };
  }
  return innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Unknown relationship record kind');
}
function relationshipValueShape(payload: Extract<RelationshipPayload, { kind: 'assertion' }>): void {
  const hasObject = payload.objectId !== undefined, hasValue = payload.value !== undefined;
  switch (payload.predicate) {
    case 'member-of': case 'participates-in':
      if (!hasObject || hasValue) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Membership predicates require exactly one object identity');
      if (payload.epistemicStatus === 'assessed') innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Membership is not an assessment');
      return;
    case 'communication-preference': {
      const value = payload.value;
      if (hasObject || value === undefined || !RELATIONSHIP_COMMUNICATION_PREFERENCES.includes(value as never)) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Invalid communication preference');
      return; }
      return;
    case 'relationship-label': {
      const value = payload.value;
      if (hasObject || value === undefined || !RELATIONSHIP_LABELS.includes(value as never)) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Invalid relationship label');
      return; }
    case 'interaction': {
      const value = payload.value;
      if (hasObject || value === undefined || !RELATIONSHIP_INTERACTIONS.includes(value as never)) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Invalid interaction kind');
      return; }
    case 'owner-assessment': {
      const value = payload.value;
      if (hasObject || value === undefined || !RELATIONSHIP_ASSESSMENT_LEVELS.includes(value as never) || payload.epistemicStatus !== 'assessed') innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Assessments are labelled, sourced and unprivileged');
      return; }
    case 'alias': {
      const value = payload.value;
      if (hasObject || value === undefined || value.length > 100) innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Aliases require one bounded display text');
      return; }
    default: return innerFail('INVALID_RELATIONSHIP_PAYLOAD', 'Unknown relationship predicate');
  }
}

/* -------------------------------------------------------------------------- */
/* Emotion                                                                    */
/* -------------------------------------------------------------------------- */
export const EMOTION_LABELS = ['positive', 'neutral', 'low', 'alert', 'mixed'] as const;
export type EmotionLabel = (typeof EMOTION_LABELS)[number];
export const EMOTION_REVIEW_CONCLUSIONS = ['no-longer-affects', 'still-relevant'] as const;
export const EMOTION_GUIDANCE = ['neutral', 'brief', 'acknowledge', 'warm'] as const;
export type EmotionGuidance = (typeof EMOTION_GUIDANCE)[number];
/** Explicit, versioned review/decay rule; not an inferred human-psychology model. */
export const EMOTION_POLICY_V1 = Object.freeze({
  schemaVersion: 1 as const,
  policyVersion: 1 as const,
  halfLifeMs: 21_600_000 as const,
  reviewAfterMs: 86_400_000 as const,
  maxActiveObservations: 200 as const,
  subject: 'system-state' as const,
  humanFeeling: false as const,
  authorityEffect: 'none' as const,
});
export type EmotionPayload =
  | { kind: 'experience'; valenceBps: number; arousalBps: number; label: EmotionLabel }
  | { kind: 'review'; reviewedRecordIds: string[]; conclusion: (typeof EMOTION_REVIEW_CONCLUSIONS)[number] }
  | { kind: 'regulation'; guidance: EmotionGuidance; expiresAt?: string };
export function validateEmotionPayload(value: unknown): EmotionPayload {
  const kind = innerKind(value, 'INVALID_EMOTION_PAYLOAD');
  if (kind === 'experience') {
    innerFields(value, ['kind', 'valenceBps', 'arousalBps', 'label']);
    if (!EMOTION_LABELS.includes(value.label as EmotionLabel)) innerFail('INVALID_EMOTION_PAYLOAD', 'Invalid emotion label');
    return { kind: 'experience', valenceBps: innerBps(value.valenceBps, 'valenceBps'), arousalBps: innerBps(value.arousalBps, 'arousalBps'), label: value.label as EmotionLabel };
  }
  if (kind === 'review') {
    innerFields(value, ['kind', 'reviewedRecordIds', 'conclusion']);
    if (!Array.isArray(value.reviewedRecordIds) || !value.reviewedRecordIds.length || value.reviewedRecordIds.length > 20
      || new Set(value.reviewedRecordIds.map(item => innerId(item, 'reviewedRecordId'))).size !== value.reviewedRecordIds.length) innerFail('INVALID_EMOTION_PAYLOAD', 'Bounded reviewed record identities are required');
    if (!EMOTION_REVIEW_CONCLUSIONS.includes(value.conclusion as never)) innerFail('INVALID_EMOTION_PAYLOAD', 'Invalid review conclusion');
    return { kind: 'review', reviewedRecordIds: value.reviewedRecordIds.map(item => innerId(item, 'reviewedRecordId')), conclusion: value.conclusion as (typeof EMOTION_REVIEW_CONCLUSIONS)[number] };
  }
  if (kind === 'regulation') {
    innerFields(value, ['kind', 'guidance', 'expiresAt'], ['kind', 'guidance']);
    if (!EMOTION_GUIDANCE.includes(value.guidance as EmotionGuidance)) innerFail('INVALID_EMOTION_PAYLOAD', 'Invalid expression guidance');
    return { kind: 'regulation', guidance: value.guidance as EmotionGuidance, ...(value.expiresAt === undefined ? {} : { expiresAt: innerInstant(value.expiresAt, 'expiresAt') }) };
  }
  return innerFail('INVALID_EMOTION_PAYLOAD', 'Unknown emotion record kind');
}
export interface EmotionContribution { recordId: string; weightBps: number; observedAt: string; label: EmotionLabel }
/** Deterministic, explainable projection of recorded observations; never a claim of human feeling. */
export interface EmotionState {
  schemaVersion: 1;
  conversationId: string;
  computedAt: string;
  policy: typeof EMOTION_POLICY_V1;
  subject: 'system-state';
  humanFeeling: false;
  authorityEffect: 'none';
  valenceBps: number;
  arousalBps: number;
  label: 'positive-energized' | 'positive' | 'alert' | 'neutral';
  contributions: EmotionContribution[];
  reviewDue: string[];
  regulations: { recordId: string; guidance: EmotionGuidance; expiresAt?: string }[];
  degraded: boolean;
  revokedEvidence: string[];
}

/* -------------------------------------------------------------------------- */
/* Cognition                                                                  */
/* -------------------------------------------------------------------------- */
export const COGNITION_CLAIM_TYPES = ['owner-statement', 'external-observation', 'external-statement', 'model-inference', 'procedure-hypothesis'] as const;
export type CognitionClaimType = (typeof COGNITION_CLAIM_TYPES)[number];
export const COGNITION_CLAIM_KINDS = ['fact', 'interpretation', 'procedure'] as const;
export type CognitionClaimKind = (typeof COGNITION_CLAIM_KINDS)[number];
export const COGNITION_CLAIM_STATUSES = ['supported', 'reported', 'hypothesis', 'contested', 'superseded'] as const;
export const COGNITION_REVIEW_CONCLUSIONS = ['supports', 'revises', 'insufficient-evidence'] as const;
/** Predicates reserved for verified world/tool facts; a model statement cannot mint them. */
export const COGNITION_RESERVED_PREDICATES = ['tool-success', 'tool-failure', 'tool-result', 'world-fact', 'permission', 'authorization', 'mandate', 'grant'] as const;
export type CognitionPayload =
  | { kind: 'claim'; claimId: string; claimKind: CognitionClaimKind; claimType: CognitionClaimType; subjectIds: string[]; predicate: string; proposition: string; confidenceBps: number }
  | { kind: 'conflict'; conflictId: string; claimRecordIds: string[]; status: 'open' | 'resolved'; winnerRecordId?: string }
  | { kind: 'review'; reviewId: string; claimIds: string[]; conclusion: (typeof COGNITION_REVIEW_CONCLUSIONS)[number] };
export function cognitionClaimKind(claimType: CognitionClaimType): CognitionClaimKind {
  if (claimType === 'owner-statement' || claimType === 'external-observation') return 'fact';
  if (claimType === 'procedure-hypothesis') return 'procedure';
  return 'interpretation';
}
export function validateCognitionPayload(value: unknown): CognitionPayload {
  const kind = innerKind(value, 'INVALID_COGNITION_PAYLOAD');
  if (kind === 'claim') {
    innerFields(value, ['kind', 'claimId', 'claimKind', 'claimType', 'subjectIds', 'predicate', 'proposition', 'confidenceBps']);
    if (!COGNITION_CLAIM_KINDS.includes(value.claimKind as CognitionClaimKind)) innerFail('INVALID_COGNITION_PAYLOAD', 'Invalid claim kind');
    if (!COGNITION_CLAIM_TYPES.includes(value.claimType as CognitionClaimType)) innerFail('INVALID_COGNITION_PAYLOAD', 'Invalid claim type');
    if (cognitionClaimKind(value.claimType as CognitionClaimType) !== value.claimKind) innerFail('INVALID_COGNITION_PAYLOAD', 'Claim type and kind disagree');
    if (!Array.isArray(value.subjectIds) || !value.subjectIds.length || value.subjectIds.length > 8) innerFail('INVALID_COGNITION_PAYLOAD', 'Bounded subject identities are required');
    const subjectIds = value.subjectIds.map(item => innerId(item, 'subjectId'));
    if (new Set(subjectIds).size !== subjectIds.length) innerFail('INVALID_COGNITION_PAYLOAD', 'Duplicate claim subject');
    const predicate = innerToken(value.predicate, 'claim predicate');
    if (COGNITION_RESERVED_PREDICATES.includes(predicate as (typeof COGNITION_RESERVED_PREDICATES)[number])) innerFail('INVALID_COGNITION_PAYLOAD', 'Reserved predicates require a verified control authority');
    return { kind: 'claim', claimId: innerId(value.claimId, 'claimId'), claimKind: value.claimKind as CognitionClaimKind,
      claimType: value.claimType as CognitionClaimType, subjectIds: subjectIds.sort(), predicate,
      proposition: innerText(value.proposition, 'proposition'), confidenceBps: innerBps(value.confidenceBps, 'confidenceBps') };
  }
  if (kind === 'conflict') {
    innerFields(value, ['kind', 'conflictId', 'claimRecordIds', 'status', 'winnerRecordId'], ['kind', 'conflictId', 'claimRecordIds', 'status']);
    if (value.status !== 'open' && value.status !== 'resolved') innerFail('INVALID_COGNITION_PAYLOAD', 'Invalid conflict status');
    if (!Array.isArray(value.claimRecordIds) || value.claimRecordIds.length !== 2) innerFail('INVALID_COGNITION_PAYLOAD', 'Conflicts reference exactly two claims');
    const claimRecordIds = value.claimRecordIds.map(item => innerId(item, 'claimRecordId'));
    if (new Set(claimRecordIds).size !== 2) innerFail('INVALID_COGNITION_PAYLOAD', 'Duplicate conflicting claim');
    if (value.status === 'resolved' && value.winnerRecordId === undefined) innerFail('INVALID_COGNITION_PAYLOAD', 'Resolved conflicts name their winner');
    return { kind: 'conflict', conflictId: innerId(value.conflictId, 'conflictId'), claimRecordIds,
      status: value.status, ...(value.winnerRecordId === undefined ? {} : { winnerRecordId: innerId(value.winnerRecordId, 'winnerRecordId') }) };
  }
  if (kind === 'review') {
    innerFields(value, ['kind', 'reviewId', 'claimIds', 'conclusion']);
    if (!Array.isArray(value.claimIds) || !value.claimIds.length || value.claimIds.length > 20
      || new Set(value.claimIds.map(item => innerId(item, 'claimId'))).size !== value.claimIds.length) innerFail('INVALID_COGNITION_PAYLOAD', 'Bounded reviewed claims are required');
    if (!COGNITION_REVIEW_CONCLUSIONS.includes(value.conclusion as never)) innerFail('INVALID_COGNITION_PAYLOAD', 'Invalid review conclusion');
    return { kind: 'review', reviewId: innerId(value.reviewId, 'reviewId'), claimIds: value.claimIds.map(item => innerId(item, 'claimId')),
      conclusion: value.conclusion as (typeof COGNITION_REVIEW_CONCLUSIONS)[number] };
  }
  return innerFail('INVALID_COGNITION_PAYLOAD', 'Unknown cognition record kind');
}

/* -------------------------------------------------------------------------- */
/* Personality                                                                */
/* -------------------------------------------------------------------------- */
export const PERSONALITY_PRINCIPLES = ['state-grounds', 'admit-unknown', 'respect-pause', 'no-authority-claim'] as const;
export const PERSONALITY_LANGUAGES = ['zh-CN', 'en-US'] as const;
export const PERSONALITY_SOURCE_KINDS = ['user-explicit', 'learned-pattern'] as const;
export const PERSONALITY_LEARNING_POLICIES = ['disabled'] as const;
export interface PersonaStyle { warmthBps: number; directnessBps: number; verbosityBps: number }
export interface PersonaProfile {
  schemaVersion: 1;
  profileVersion: number;
  displayName: string;
  language: (typeof PERSONALITY_LANGUAGES)[number];
  style: PersonaStyle;
  principles: (typeof PERSONALITY_PRINCIPLES)[number][];
}
/** Whitelisted change surface. Permission, tool, mandate and prompt fields are absent by construction. */
export interface PersonaDiff {
  displayName?: string;
  language?: (typeof PERSONALITY_LANGUAGES)[number];
  style?: Partial<PersonaStyle>;
  principles?: (typeof PERSONALITY_PRINCIPLES)[number][];
}
export type PersonalityPayload =
  | { kind: 'profile'; profileVersion: number; profile: PersonaProfile }
  | { kind: 'candidate'; candidateId: string; baseProfileVersion: number; sourceKind: (typeof PERSONALITY_SOURCE_KINDS)[number]; diff: PersonaDiff }
  | { kind: 'review'; candidateId: string; decision: 'approve' | 'reject' };
export function personaDiff(value: unknown): PersonaDiff {
  innerFields(value, ['displayName', 'language', 'style', 'principles'], []);
  const diff: PersonaDiff = {};
  if (value.displayName !== undefined) diff.displayName = innerText(value.displayName, 'displayName', 80);
  if (value.language !== undefined) {
    if (!PERSONALITY_LANGUAGES.includes(value.language as never)) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Invalid language default');
    diff.language = value.language as PersonaDiff['language'];
  }
  if (value.style !== undefined) {
    innerFields(value.style, ['warmthBps', 'directnessBps', 'verbosityBps'], []);
    const style: Partial<PersonaStyle> = {};
    for (const key of ['warmthBps', 'directnessBps', 'verbosityBps'] as const) {
      if ((value.style as Record<string, unknown>)[key] !== undefined) style[key] = innerBps((value.style as Record<string, unknown>)[key], key);
    }
    if (!Object.keys(style).length) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Empty style change');
    diff.style = style;
  }
  if (value.principles !== undefined) {
    if (!Array.isArray(value.principles) || !value.principles.length || value.principles.length > PERSONALITY_PRINCIPLES.length
      || value.principles.some(item => !PERSONALITY_PRINCIPLES.includes(item as never))
      || new Set(value.principles).size !== value.principles.length) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Invalid expression principles');
    diff.principles = [...value.principles] as PersonaDiff['principles'];
  }
  if (!Object.keys(diff).length) innerFail('INVALID_PERSONALITY_PAYLOAD', 'A persona change needs at least one whitelisted field');
  return diff;
}
export function personaDiffFields(diff: PersonaDiff): string[] { return Object.keys(diff).sort(); }
export function personaProfile(value: unknown): PersonaProfile {
  innerFields(value, ['schemaVersion', 'profileVersion', 'displayName', 'language', 'style', 'principles']);
  if (value.schemaVersion !== 1) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Unsupported persona profile schema');
  innerFields(value.style, ['warmthBps', 'directnessBps', 'verbosityBps']);
  if (!PERSONALITY_LANGUAGES.includes(value.language as never)) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Invalid language default');
  if (!Array.isArray(value.principles) || !value.principles.length || value.principles.length > PERSONALITY_PRINCIPLES.length
    || value.principles.some(item => !PERSONALITY_PRINCIPLES.includes(item as never))
    || new Set(value.principles).size !== value.principles.length) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Invalid expression principles');
  return {
    schemaVersion: 1,
    profileVersion: innerInteger(value.profileVersion, 'profileVersion'),
    displayName: innerText(value.displayName, 'displayName', 80),
    language: value.language as PersonaProfile['language'],
    style: { warmthBps: innerBps(value.style.warmthBps, 'warmthBps'), directnessBps: innerBps(value.style.directnessBps, 'directnessBps'), verbosityBps: innerBps(value.style.verbosityBps, 'verbosityBps') },
    principles: [...value.principles] as PersonaProfile['principles'],
  };
}
export const PERSONA_BASELINE: PersonaProfile = Object.freeze({
  schemaVersion: 1 as const, profileVersion: 1, displayName: '识雨', language: 'zh-CN' as const,
  style: Object.freeze({ warmthBps: 6000, directnessBps: 7000, verbosityBps: 4000 }),
  principles: Object.freeze([...PERSONALITY_PRINCIPLES]) as unknown as PersonaProfile['principles'],
});
export function validatePersonalityPayload(value: unknown): PersonalityPayload {
  const kind = innerKind(value, 'INVALID_PERSONALITY_PAYLOAD');
  if (kind === 'profile') {
    innerFields(value, ['kind', 'profileVersion', 'profile']);
    const profile = personaProfile(value.profile);
    if (profile.profileVersion !== value.profileVersion) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Profile version disagrees with its record');
    return { kind: 'profile', profileVersion: innerInteger(value.profileVersion, 'profileVersion'), profile };
  }
  if (kind === 'candidate') {
    innerFields(value, ['kind', 'candidateId', 'baseProfileVersion', 'sourceKind', 'diff']);
    if (!PERSONALITY_SOURCE_KINDS.includes(value.sourceKind as never)) innerFail('INVALID_PERSONALITY_PAYLOAD', 'Invalid persona source kind');
    return { kind: 'candidate', candidateId: innerId(value.candidateId, 'candidateId'),
      baseProfileVersion: innerInteger(value.baseProfileVersion, 'baseProfileVersion'),
      sourceKind: value.sourceKind as (typeof PERSONALITY_SOURCE_KINDS)[number], diff: personaDiff(value.diff) };
  }
  if (kind === 'review') {
    innerFields(value, ['kind', 'candidateId', 'decision']);
    if (value.decision !== 'approve' && value.decision !== 'reject') innerFail('INVALID_PERSONALITY_PAYLOAD', 'Invalid persona review decision');
    return { kind: 'review', candidateId: innerId(value.candidateId, 'candidateId'), decision: value.decision };
  }
  return innerFail('INVALID_PERSONALITY_PAYLOAD', 'Unknown personality record kind');
}

/* -------------------------------------------------------------------------- */
/* Command surfaces                                                           */
/* -------------------------------------------------------------------------- */
export interface InnerDomainStatus { configured: boolean; ready: boolean; errorCode?: string }
export interface InnerWithdrawReceipt {
  requestId: string;
  withdrawnRecordIds: string[];
  withdrawnEvidenceRefs: InnerSourceRef[];
  tombstoneWatermark: number;
}
export interface InnerWriteReceipt<T extends Record<string, unknown> = Record<string, never>> {
  requestId: string;
  changed: boolean;
  record: T;
}

export interface RelationshipCommands {
  'relationship.status': { input: Record<string, never>; output: InnerDomainStatus };
  'relationship.registerSubject': { input: { requestId: string; account: InnerAccount; entityKind: RelationshipEntityKind; displayName: string }; output: InnerWriteReceipt<{ entityId: string; bindingId: string; canonicalEntityId: string; created: boolean }> };
  'relationship.assert': { input: { requestId: string; conversationId: string; subjectId: string; predicate: RelationshipPredicate; objectId?: string; value?: string; saidBy?: string; validFrom?: string; validUntil?: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ assertionId: string; recordId: string; revision: number; status: string }> };
  'relationship.reviseAssertion': { input: { requestId: string; conversationId: string; assertionId: string; expectedRevision: number; predicate: RelationshipPredicate; objectId?: string; value?: string; saidBy?: string; validFrom?: string; validUntil?: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ assertionId: string; recordId: string; revision: number; status: string }> };
  'relationship.mergeSubjects': { input: { requestId: string; fromEntityId: string; intoEntityId: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ mergeId: string; canonicalEntityId: string }> };
  'relationship.splitSubjects': { input: { requestId: string; mergeId: string; expectedRevision: number; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ mergeId: string; canonicalEntityId: string }> };
  'relationship.resolveSubject': { input: { entityId: string }; output: { entityId: string; canonicalEntityId: string; mergeIds: string[] } };
  'relationship.withdraw': { input: { requestId: string; recordIds?: string[]; evidenceRefs?: InnerSourceRef[] }; output: InnerWithdrawReceipt };
  'relationship.captureForView': { input: InnerCaptureInput; output: InnerCapture };
  'relationship.validateForView': { input: { capture: InnerCapture }; output: InnerCapture };
  'relationship.readBodies': { input: InnerBodyReadInput; output: InnerBodyRead };
}
export type RelationshipDomainRequest = { [K in keyof RelationshipCommands]: { command: K; args: RelationshipCommands[K]['input'] } }[keyof RelationshipCommands];

export interface EmotionCommands {
  'emotion.status': { input: Record<string, never>; output: InnerDomainStatus };
  'emotion.observe': { input: { requestId: string; conversationId: string; valenceBps: number; arousalBps: number; label: EmotionLabel; observedAt?: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ recordId: string; revision: number; status: string }> };
  'emotion.review': { input: { requestId: string; conversationId: string; recordIds: string[]; conclusion: (typeof EMOTION_REVIEW_CONCLUSIONS)[number]; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ reviewRecordId: string; reviewedRecordIds: string[] }> };
  'emotion.regulate': { input: { requestId: string; conversationId: string; guidance: EmotionGuidance; expiresAt?: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ recordId: string; revision: number }> };
  'emotion.state': { input: { conversationId: string }; output: EmotionState };
  'emotion.withdraw': { input: { requestId: string; recordIds?: string[]; evidenceRefs?: InnerSourceRef[] }; output: InnerWithdrawReceipt };
  'emotion.captureForView': { input: InnerCaptureInput; output: InnerCapture };
  'emotion.validateForView': { input: { capture: InnerCapture }; output: InnerCapture };
  'emotion.readBodies': { input: InnerBodyReadInput; output: InnerBodyRead };
}
export type EmotionDomainRequest = { [K in keyof EmotionCommands]: { command: K; args: EmotionCommands[K]['input'] } }[keyof EmotionCommands];

export interface CognitionCommands {
  'cognition.status': { input: Record<string, never>; output: InnerDomainStatus };
  'cognition.propose': { input: { requestId: string; conversationId: string; claimType: CognitionClaimType; subjectIds: string[]; predicate: string; proposition: string; confidenceBps: number; validFrom?: string; validUntil?: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ claimId: string; recordId: string; revision: number; status: string; conflictId?: string }> };
  'cognition.revise': { input: { requestId: string; conversationId: string; claimId: string; expectedRevision: number; proposition: string; confidenceBps: number; validFrom?: string; validUntil?: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ claimId: string; recordId: string; revision: number; status: string }> };
  'cognition.review': { input: { requestId: string; conversationId: string; claimIds: string[]; conclusion: (typeof COGNITION_REVIEW_CONCLUSIONS)[number]; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ reviewId: string; recordId: string; revision: number }> };
  'cognition.resolveConflict': { input: { requestId: string; conversationId: string; conflictId: string; expectedRevision: number; winnerRecordId: string; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ conflictId: string; recordId: string; revision: number; winnerRecordId: string }> };
  'cognition.withdraw': { input: { requestId: string; recordIds?: string[]; evidenceRefs?: InnerSourceRef[] }; output: InnerWithdrawReceipt };
  'cognition.captureForView': { input: InnerCaptureInput; output: InnerCapture };
  'cognition.validateForView': { input: { capture: InnerCapture }; output: InnerCapture };
  'cognition.readBodies': { input: InnerBodyReadInput; output: InnerBodyRead };
}
export type CognitionDomainRequest = { [K in keyof CognitionCommands]: { command: K; args: CognitionCommands[K]['input'] } }[keyof CognitionCommands];

export interface PersonalitySnapshot {
  schemaVersion: 1;
  profileVersion: number;
  revision: number;
  learningPolicy: (typeof PERSONALITY_LEARNING_POLICIES)[number];
  policyVersion: number;
  candidates: number;
  activeRecordId: string;
  activeEvidenceState: InnerEvidenceState;
  sourceRefs: InnerSourceRef[];
}
export interface PersonalityCommands {
  'personality.status': { input: Record<string, never>; output: InnerDomainStatus };
  'personality.snapshot': { input: { conversationId: string }; output: PersonalitySnapshot };
  'personality.propose': { input: { requestId: string; conversationId: string; expectedProfileVersion: number; sourceKind: (typeof PERSONALITY_SOURCE_KINDS)[number]; displayName?: string; language?: (typeof PERSONALITY_LANGUAGES)[number]; style?: Partial<PersonaStyle>; principles?: (typeof PERSONALITY_PRINCIPLES)[number][]; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ candidateId: string; recordId: string; revision: number; status: string }> };
  'personality.review': { input: { requestId: string; conversationId: string; candidateId: string; expectedRevision: number; decision: 'approve' | 'reject'; sourceRefs: InnerSourceRef[] }; output: InnerWriteReceipt<{ candidateId: string; recordId: string; profileVersion: number; status: string }> };
  'personality.withdraw': { input: { requestId: string; recordIds?: string[]; evidenceRefs?: InnerSourceRef[] }; output: InnerWithdrawReceipt };
  'personality.captureForView': { input: InnerCaptureInput; output: InnerCapture };
  'personality.validateForView': { input: { capture: InnerCapture }; output: InnerCapture };
  'personality.readBodies': { input: InnerBodyReadInput; output: InnerBodyRead };
}
export type PersonalityDomainRequest = { [K in keyof PersonalityCommands]: { command: K; args: PersonalityCommands[K]['input'] } }[keyof PersonalityCommands];
