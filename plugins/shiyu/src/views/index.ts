import { createHash, randomUUID } from 'node:crypto';
import type { JsonValue } from '../contracts/events.js';

export type ViewPurpose = 'reply_context' | 'task_status' | 'core_decision' | 'health_summary';
export type ViewRole = 'replyer' | 'worker' | 'core' | 'diagnostic';
export type Revision = string | number;
export interface TrustedViewActor { principalId: string; role: ViewRole; scopes: readonly string[] }
/** This is the untrusted request surface. Identity, scope and field grants are never accepted here. */
export interface ViewRequest {
  requestId: string; purpose: ViewPurpose; conversationId?: string; taskId?: string;
  query?: string; sourceFilter?: readonly string[]; maxItems?: number; maxBytes?: number;
}
export interface ViewUse { purpose: ViewPurpose; conversationId?: string; taskId?: string }
/** Structurally matches ConversationStore.version(); no import of its write surface is required. */
export interface ViewConversationVersion {
  bindingId: string; conversationId: string; scope: string; audienceVersion: number;
  conversationGeneration: number; routingRevision: number; sessionEpoch: number; contextVersion: number;
}
export interface SafetyWatermarks { authEpoch: number | null; tombstoneWatermark: number | null }
export interface ComponentGrant { backendId: string; fields: readonly string[]; authority?: 'memory' }
/** Independent memory deletion/installation authority. Never collapse it into the Task watermark. */
export interface ViewMemoryAuthority {
  backendId: string; deploymentId: string; installationGeneration: string; authorizationEpoch: number;
  deletionBaselineId: string; deletionScope: 'local-memory-source'; tombstoneWatermark: number; installedAt: string;
}
/** Baseline identities make scoped zero watermarks distinguishable from unavailable backends. */
export interface ViewAuthorityIdentity {
  publicationBaselineId: string; policyAuthorityId: string; deletionAuthorityId: string;
  deletionScope: 'local-task-source'; indexMode: 'not-used';
  memory?: ViewMemoryAuthority;
}
/** Produced only by the current policy/deletion authority and authenticated conversation adapter. */
export interface ViewAccess {
  principalId: string; purpose: ViewPurpose; scope: string; audienceIds: readonly string[];
  resourceRefs: readonly string[]; components: readonly ComponentGrant[]; expiresAt: string;
  policyVersion: number; authEpoch: number; tombstoneWatermark: number;
  appliedSafety: SafetyWatermarks; commitSeq: number; stateVersion: number; indexWatermark: number;
  conversation?: ViewConversationVersion;
  authority?: ViewAuthorityIdentity;
}
export interface ViewSourceRef {
  sourceId: string; revision: Revision; contentHash?: string; observedAt: string; trustClass: string;
}
export interface SourceVisibility {
  sourceId: string; revision: Revision; contentHash?: string;
  status: 'visible' | 'forbidden' | 'deleted' | 'unavailable';
}
/** Both methods are side-effect-free authority reads. Query text never determines or enlarges a grant. */
export interface ReadViewAuthorityPort {
  resolve(actor: Readonly<TrustedViewActor>, request: Readonly<ViewRequest>): Promise<ViewAccess | null> | ViewAccess | null;
  checkSources(access: Readonly<ViewAccess>, refs: readonly ViewSourceRef[]): Promise<readonly SourceVisibility[]> | readonly SourceVisibility[];
}
export interface ViewFreshness { status: 'current' | 'stale' | 'unavailable'; reason?: string }
export interface AggregateVersion { aggregateType: string; aggregateId: string; version: Revision }
export interface ViewRecord {
  recordId: string; scope: string; audienceIds: readonly string[]; resourceRefs: readonly string[];
  fields: Readonly<Record<string, JsonValue>>; sourceRefs: readonly ViewSourceRef[]; aggregateVersion?: AggregateVersion;
}
export interface ComponentSnapshot {
  capturedAt: string | null; componentRevision?: Revision; verifiedSourceHash?: string; indexVersion?: Revision;
  freshness: ViewFreshness; appliedSafety: SafetyWatermarks | null; records: readonly ViewRecord[];
  expiresAt?: string;
  memoryAuthority?: ViewMemoryAuthority;
}
export interface ComponentReadRequest {
  purpose: ViewPurpose; scope: string; audienceIds: readonly string[]; resourceRefs: readonly string[];
  fields: readonly string[]; conversationId?: string; taskId?: string; query?: string;
  sourceFilter?: readonly string[]; maxItems: number; maxBytes: number;
}
/** No database handle, memory mutation, arbitrary query, or commit method is passed to this service. */
export interface ReadViewComponentPort {
  backendId: string;
  read(request: Readonly<ComponentReadRequest>, signal?: AbortSignal): Promise<ComponentSnapshot> | ComponentSnapshot;
}
export interface ReadViewComponent {
  backendId: string; capturedAt: string | null; componentRevision?: Revision;
  verifiedSourceHash?: string; indexVersion?: Revision; freshness: ViewFreshness;
}
export interface ReadView {
  viewId: string; schemaVersion: 1; scopeHash: string; issuedTo: { principalId: string; role: ViewRole };
  purpose: ViewPurpose; generatedAt: string; expiresAt: string;
  commitSeq: number; stateVersion: number; aggregateVersions: AggregateVersion[];
  components: ReadViewComponent[]; policyVersion: number; authEpoch: number;
  tombstoneWatermark: number; indexWatermark: number; freshness: ViewFreshness;
  sourceRefs: ViewSourceRef[]; data: { backendId: string; recordId: string; fields: Record<string, JsonValue> }[];
  /** Component observations have independent versions/times; this is never a distributed atomic snapshot. */
  consistency: 'component-scoped'; conversation?: ViewConversationVersion;
  authority?: ViewAuthorityIdentity;
  truncated: { items: boolean; bytes: boolean };
}
export interface ReadViewOptions {
  authority: ReadViewAuthorityPort; components: readonly ReadViewComponentPort[];
  now?: () => Date; newId?: () => string; maxOutstandingViews?: number; componentTimeoutMs?: number;
}
export class ReadViewError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ReadViewError'; }
}
type IssuedMetadata = {
  actor: TrustedViewActor; request: ViewRequest; scopeHash: string; securityHash: string;
  sourceRefs: ViewSourceRef[]; expiresAt: string;
};
const purposes: ViewPurpose[] = ['reply_context', 'task_status', 'core_decision', 'health_summary'];
const rolePurposes: Record<ViewRole, readonly ViewPurpose[]> = {
  replyer: ['reply_context', 'task_status', 'health_summary'], worker: ['task_status', 'health_summary'],
  core: purposes, diagnostic: ['health_summary'],
};
function fail(code: string, message: string): never { throw new ReadViewError(code, message); }
const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function name(value: unknown): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 && !/[\u0000-\u001f]/u.test(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function revision(value: unknown): value is Revision { return name(value) || integer(value); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function list(value: unknown, max = 128): value is string[] { return Array.isArray(value) && value.length <= max && value.every(name) && new Set(value).size === value.length; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function sourceKey(ref: Pick<ViewSourceRef, 'sourceId' | 'revision' | 'contentHash'>): string { return JSON.stringify([ref.sourceId, ref.revision, ref.contentHash ?? null]); }
function validSource(ref: ViewSourceRef): boolean { return Boolean(ref && name(ref.sourceId) && revision(ref.revision) && timestamp(ref.observedAt) && name(ref.trustClass) && (ref.contentHash === undefined || name(ref.contentHash))); }
function uniqueSources(refs: readonly ViewSourceRef[]): ViewSourceRef[] { return [...new Map(refs.map(ref => [sourceKey(ref), clone(ref)])).values()]; }
function scopeHash(actor: TrustedViewActor, request: ViewRequest, access: ViewAccess): string {
  return hash({ principalId: actor.principalId, role: actor.role, purpose: request.purpose, scope: access.scope,
    audienceIds: [...access.audienceIds].sort(), resourceRefs: [...access.resourceRefs].sort(),
    components: access.components.map(item => ({ backendId: item.backendId, fields: [...item.fields].sort(), ...(item.authority ? { authority: item.authority } : {}) })).sort((a, b) => a.backendId.localeCompare(b.backendId)),
    conversationId: request.conversationId, taskId: request.taskId });
}
function securityHash(actor: TrustedViewActor, request: ViewRequest, access: ViewAccess): string {
  const conversation = access.conversation;
  return hash({ scopeHash: scopeHash(actor, request, access), expiresAt: access.expiresAt, policyVersion: access.policyVersion,
    authEpoch: access.authEpoch, tombstoneWatermark: access.tombstoneWatermark, appliedSafety: access.appliedSafety, authority: access.authority,
    conversation: conversation && { bindingId: conversation.bindingId, conversationId: conversation.conversationId, scope: conversation.scope,
      audienceVersion: conversation.audienceVersion, conversationGeneration: conversation.conversationGeneration,
      routingRevision: conversation.routingRevision, sessionEpoch: conversation.sessionEpoch } });
}
function safetyMatches(actual: SafetyWatermarks | null | undefined, access: ViewAccess): boolean {
  return actual?.authEpoch === access.authEpoch && actual?.tombstoneWatermark === access.tombstoneWatermark;
}
function memoryAuthority(value: ViewMemoryAuthority | undefined): boolean {
  return Boolean(value && name(value.backendId) && name(value.deploymentId) && name(value.installationGeneration)
    && integer(value.authorizationEpoch) && name(value.deletionBaselineId) && value.deletionScope === 'local-memory-source'
    && integer(value.tombstoneWatermark) && timestamp(value.installedAt));
}
function sameMemoryAuthority(actual: ViewMemoryAuthority | undefined, expected: ViewMemoryAuthority | undefined): boolean {
  return memoryAuthority(actual) && memoryAuthority(expected)
    && (['backendId', 'deploymentId', 'installationGeneration', 'authorizationEpoch', 'deletionBaselineId', 'deletionScope', 'tombstoneWatermark', 'installedAt'] as const)
      .every(key => actual![key] === expected![key]);
}
function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 16) fail('INVALID_COMPONENT', 'Component data is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value as JsonValue;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1));
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_COMPONENT', 'Component data must be plain JSON, never capabilities');
  const entries = Object.entries(value as object);
  if (entries.some(([key]) => ['__proto__', 'constructor', 'prototype'].includes(key))) fail('INVALID_COMPONENT', 'Unsafe component field');
  return Object.fromEntries(entries.map(([key, item]) => [key, jsonValue(item, depth + 1)]));
}
function requestInput(input: ViewRequest): ViewRequest {
  const allowed = ['requestId', 'purpose', 'conversationId', 'taskId', 'query', 'sourceFilter', 'maxItems', 'maxBytes'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))
    || !name(input.requestId) || !purposes.includes(input.purpose)
    || (input.conversationId !== undefined && !name(input.conversationId)) || (input.taskId !== undefined && !name(input.taskId))
    || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 4096))
    || (input.sourceFilter !== undefined && !list(input.sourceFilter, 20))
    || (input.maxItems !== undefined && (!integer(input.maxItems) || input.maxItems < 1 || input.maxItems > 20))
    || (input.maxBytes !== undefined && (!integer(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 65536))) fail('INVALID_SCHEMA', 'Invalid bounded view request');
  return freeze(clone({ ...input, maxItems: input.maxItems ?? 20, maxBytes: input.maxBytes ?? 65536 }));
}

/**
 * Read-only composition, not an authority store, history service, cache of business
 * text, or an authorization token for actions. Ports are trusted adapters whose
 * read methods must themselves be side-effect free. No port is returned to callers.
 */
export class ReadViewService {
  private readonly reads = new Map<string, ReadViewComponentPort['read']>();
  private readonly issued = new Map<string, IssuedMetadata>();
  private readonly authority: ReadViewAuthorityPort;
  private readonly maxOutstanding: number;
  private readonly componentTimeout: number;
  private readonly pending = new Set<AbortController>();
  private closed = false;
  constructor(private readonly options: ReadViewOptions) {
    this.authority = { resolve: options.authority.resolve.bind(options.authority), checkSources: options.authority.checkSources.bind(options.authority) };
    this.maxOutstanding = options.maxOutstandingViews ?? 256;
    if (!integer(this.maxOutstanding) || this.maxOutstanding < 1 || this.maxOutstanding > 4096) fail('INVALID_SCHEMA', 'Invalid view metadata bound');
    this.componentTimeout = options.componentTimeoutMs ?? 5000;
    if (!integer(this.componentTimeout) || this.componentTimeout < 1 || this.componentTimeout > 30000) fail('INVALID_SCHEMA', 'Invalid component read timeout');
    for (const port of options.components) {
      if (!name(port.backendId) || port.backendId === 'conversation' || this.reads.has(port.backendId) || typeof port.read !== 'function') fail('INVALID_SCHEMA', 'Invalid or duplicate component read port');
      this.reads.set(port.backendId, port.read.bind(port));
    }
  }
  private now(): Date {
    const now = this.options.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) fail('INVALID_CLOCK', 'A valid clock is required');
    return now;
  }
  private prune(): void { const now = this.now().getTime(); for (const [id, value] of this.issued) if (Date.parse(value.expiresAt) <= now) this.issued.delete(id); }
  private actor(input: TrustedViewActor, purpose: ViewPurpose): TrustedViewActor {
    if (this.closed) fail('DISPOSED', 'View service is disposed');
    if (!input || !name(input.principalId) || !list(input.scopes) || !Object.hasOwn(rolePurposes, input.role) || !rolePurposes[input.role].includes(purpose)) fail('FORBIDDEN', 'View access is not permitted');
    return freeze(clone(input));
  }
  private async access(actor: TrustedViewActor, request: ViewRequest): Promise<ViewAccess> {
    let raw: ViewAccess | null;
    const { query: _query, ...authorityRequest } = request;
    try { raw = await this.authority.resolve(actor, freeze(authorityRequest)); } catch { fail('DEPENDENCY_UNAVAILABLE', 'Current view authority is unavailable'); }
    if (!raw || raw.principalId !== actor.principalId || raw.purpose !== request.purpose || !name(raw.scope) || !actor.scopes.includes(raw.scope)) fail('FORBIDDEN', 'View access is not permitted');
    const access = clone(raw!);
    if (!list(access.audienceIds) || !access.audienceIds.length || !list(access.resourceRefs)
      || !Array.isArray(access.components) || access.components.length > 16
      || new Set(access.components.map(item => item.backendId)).size !== access.components.length
      || access.components.some(item => !name(item.backendId) || item.backendId === 'conversation' || (item.authority !== undefined && item.authority !== 'memory')
        || !list(item.fields, 64) || item.fields.some((field: string) => ['__proto__', 'constructor', 'prototype'].includes(field)))
      || !timestamp(access.expiresAt) || ![access.policyVersion, access.authEpoch, access.tombstoneWatermark, access.commitSeq, access.stateVersion, access.indexWatermark].every(integer)) fail('DEPENDENCY_UNAVAILABLE', 'Current view authority is incomplete');
    if (access.authority && (!name(access.authority.publicationBaselineId) || !name(access.authority.policyAuthorityId)
      || !name(access.authority.deletionAuthorityId) || access.authority.deletionScope !== 'local-task-source' || access.authority.indexMode !== 'not-used')) fail('DEPENDENCY_UNAVAILABLE', 'View authority baseline is incomplete');
    if ((access.authority?.memory && (!memoryAuthority(access.authority.memory) || access.authority.memory.authorizationEpoch !== access.authEpoch))
      || access.components.some(item => item.authority === 'memory' && !access.authority?.memory)) fail('DEPENDENCY_UNAVAILABLE', 'Memory view authority is incomplete');
    if (Date.parse(access.expiresAt) <= this.now().getTime()) fail('EXPIRED', 'View authority has expired');
    if (request.taskId && !access.resourceRefs.includes(`task:${request.taskId}`)) fail('FORBIDDEN', 'View access is not permitted');
    if (request.conversationId) {
      const c = access.conversation;
      if (!c || c.conversationId !== request.conversationId || c.scope !== access.scope || !access.resourceRefs.includes(`conversation:${request.conversationId}`)
        || !name(c.bindingId) || ![c.audienceVersion, c.conversationGeneration, c.routingRevision, c.sessionEpoch, c.contextVersion].every(integer)) fail('FORBIDDEN', 'View access is not permitted');
    } else if (access.conversation) fail('FORBIDDEN', 'Unexpected conversation binding');
    return freeze(access);
  }
  private async sourceVisibility(access: ViewAccess, refs: readonly ViewSourceRef[]): Promise<Map<string, SourceVisibility['status']>> {
    if (!refs.length) return new Map();
    let rows: readonly SourceVisibility[];
    try { rows = await this.authority.checkSources(access, freeze(clone(refs))); } catch { fail('DEPENDENCY_UNAVAILABLE', 'Current source visibility is unavailable'); }
    if (!Array.isArray(rows) || rows.length > refs.length || rows.some(row => !row || !name(row.sourceId) || !revision(row.revision)
      || !['visible', 'forbidden', 'deleted', 'unavailable'].includes(row.status)) || new Set(rows.map(sourceKey)).size !== rows.length) fail('DEPENDENCY_UNAVAILABLE', 'Source visibility is incomplete');
    const checked = new Map(rows.map(row => [sourceKey(row), row.status]));
    return new Map(refs.map(ref => [sourceKey(ref), checked.get(sourceKey(ref)) ?? 'unavailable']));
  }
  private async readComponent(read: ReadViewComponentPort['read'], request: ComponentReadRequest, remainingMs: number): Promise<ComponentSnapshot> {
    const controller = new AbortController(); this.pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      return await new Promise<ComponentSnapshot>((resolve, reject) => {
        aborted = () => reject(new ReadViewError(this.closed ? 'DISPOSED' : 'COMPONENT_TIMEOUT', 'Component read did not complete'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => controller.abort(), Math.min(this.componentTimeout, remainingMs));
        Promise.resolve().then(() => read(freeze(request), controller.signal)).then(resolve, reject);
      });
    } finally {
      if (timer) clearTimeout(timer); if (aborted) controller.signal.removeEventListener('abort', aborted);
      this.pending.delete(controller);
    }
  }
  async read(inputActor: TrustedViewActor, input: ViewRequest): Promise<ReadView> {
    this.prune();
    const request = requestInput(input), actor = this.actor(inputActor, request.purpose);
    const access = await this.access(actor, request);
    const initialSecurity = securityHash(actor, request, access);
    if (!safetyMatches(access.appliedSafety, access)) fail('SECURITY_STATE_UNAVAILABLE', 'Authorization and deletion barriers are not current');
    const generated = this.now(), expiresAt = new Date(Math.min(generated.getTime() + 30000, Date.parse(access.expiresAt))).toISOString();
    const view: ReadView = {
      viewId: this.options.newId?.() ?? randomUUID(), schemaVersion: 1, scopeHash: scopeHash(actor, request, access),
      issuedTo: { principalId: actor.principalId, role: actor.role }, purpose: request.purpose,
      generatedAt: generated.toISOString(), expiresAt, commitSeq: access.commitSeq, stateVersion: access.stateVersion,
      policyVersion: access.policyVersion, authEpoch: access.authEpoch, tombstoneWatermark: access.tombstoneWatermark,
      indexWatermark: access.indexWatermark, aggregateVersions: [], components: [], freshness: { status: 'current' },
      sourceRefs: [], data: [], consistency: 'component-scoped', ...(access.conversation ? { conversation: clone(access.conversation) } : {}),
      ...(access.authority ? { authority: clone(access.authority) } : {}),
      truncated: { items: false, bytes: false },
    };
    if (!name(view.viewId) || this.issued.has(view.viewId)) fail('INVALID_VIEW_ID', 'A fresh view identity is required');
    const candidates: { backendId: string; record: ViewRecord; fields: Record<string, JsonValue> }[] = [];
    for (const grant of access.components) {
      const remainingMs = Date.parse(view.expiresAt) - this.now().getTime();
      if (remainingMs <= 0) fail('EXPIRED', 'View expired while reading');
      const read = this.reads.get(grant.backendId);
      const unavailable = (reason: string) => view.components.push({ backendId: grant.backendId, capturedAt: null, freshness: { status: 'unavailable', reason } });
      if (!read) { unavailable('not_connected'); continue; }
      let snapshot: ComponentSnapshot;
      try {
        snapshot = await this.readComponent(read, { purpose: request.purpose, scope: access.scope, audienceIds: clone(access.audienceIds), resourceRefs: clone(access.resourceRefs), fields: clone(grant.fields),
          ...(request.conversationId ? { conversationId: request.conversationId } : {}), ...(request.taskId ? { taskId: request.taskId } : {}),
          ...(request.query !== undefined ? { query: request.query } : {}), ...(request.sourceFilter ? { sourceFilter: clone(request.sourceFilter) } : {}), maxItems: request.maxItems!, maxBytes: request.maxBytes! }, remainingMs);
      } catch (error) {
        if (this.closed) fail('DISPOSED', 'View service is disposed');
        unavailable(error instanceof ReadViewError && error.code === 'COMPONENT_TIMEOUT' ? 'read_timeout' : 'read_failed'); continue;
      }
      if (!snapshot || !snapshot.freshness || !['current', 'stale', 'unavailable'].includes(snapshot.freshness.status)
        || !Array.isArray(snapshot.records) || snapshot.records.length > 200) { unavailable('invalid_component'); continue; }
      if (snapshot.freshness.status === 'unavailable') { unavailable('source_unavailable'); continue; }
      if (!timestamp(snapshot.capturedAt) || (!revision(snapshot.componentRevision) && !name(snapshot.verifiedSourceHash))) { unavailable('version_unknown'); continue; }
      if (!safetyMatches(snapshot.appliedSafety, access)) fail('SECURITY_STATE_UNAVAILABLE', 'A component has not applied current authorization and deletion barriers');
      if (grant.authority === 'memory' && !sameMemoryAuthority(snapshot.memoryAuthority, access.authority?.memory)) fail('SECURITY_STATE_UNAVAILABLE', 'The memory component has not applied its independent authority vector');
      // Adapter diagnostics are not a second, unredacted path into the view.
      const freshness: ViewFreshness = snapshot.freshness.status === 'stale'
        ? { status: 'stale', reason: 'source_reported_stale' } : { status: 'current' };
      if (Date.parse(snapshot.capturedAt) > this.now().getTime()) { unavailable('capture_time_unknown'); continue; }
      if (snapshot.expiresAt && (!timestamp(snapshot.expiresAt) || Date.parse(snapshot.expiresAt) <= this.now().getTime())) { freshness.status = 'stale'; freshness.reason = 'component_expired'; }
      else if (snapshot.expiresAt && freshness.status === 'current' && Date.parse(snapshot.expiresAt) < Date.parse(view.expiresAt)) view.expiresAt = new Date(snapshot.expiresAt).toISOString();
      view.components.push({ backendId: grant.backendId, capturedAt: snapshot.capturedAt,
        ...(revision(snapshot.componentRevision) ? { componentRevision: snapshot.componentRevision } : {}),
        ...(name(snapshot.verifiedSourceHash) ? { verifiedSourceHash: snapshot.verifiedSourceHash } : {}),
        ...(revision(snapshot.indexVersion) ? { indexVersion: snapshot.indexVersion } : {}), freshness });
      for (const record of snapshot.records) {
        if (!record || !name(record.recordId) || record.scope !== access.scope || !list(record.audienceIds) || !access.audienceIds.every(id => record.audienceIds.includes(id))
          || !list(record.resourceRefs) || !record.resourceRefs.length || !record.resourceRefs.every((ref: string) => access.resourceRefs.includes(ref))) continue;
        const fields: Record<string, JsonValue> = {};
        for (const field of grant.fields) if (record.fields && Object.hasOwn(record.fields, field)) fields[field] = jsonValue(record.fields[field]);
        if (!Object.keys(fields).length) continue;
        if (!Array.isArray(record.sourceRefs) || !record.sourceRefs.length || record.sourceRefs.length > 64 || !record.sourceRefs.every(validSource)) {
          view.components.find(item => item.backendId === grant.backendId)!.freshness = { status: 'unavailable', reason: 'source_unverified' }; continue;
        }
        if (request.sourceFilter && !record.sourceRefs.some((ref: ViewSourceRef) => request.sourceFilter!.includes(ref.sourceId))) continue;
        candidates.push({ backendId: grant.backendId, record: {
          recordId: record.recordId, scope: record.scope, audienceIds: [], resourceRefs: [], fields: {}, sourceRefs: clone(record.sourceRefs),
          ...(record.aggregateVersion ? { aggregateVersion: clone(record.aggregateVersion) } : {}),
        }, fields });
      }
    }
    if (access.conversation) view.components.push({ backendId: 'conversation', componentRevision: access.conversation.contextVersion, capturedAt: generated.toISOString(), freshness: { status: 'current' } });
    const visibility = await this.sourceVisibility(access, uniqueSources(candidates.flatMap(item => item.record.sourceRefs)));
    const eligible = candidates.filter(item => {
      const statuses = item.record.sourceRefs.map(ref => visibility.get(sourceKey(ref)) ?? 'unavailable');
      if (statuses.includes('unavailable')) view.components.find(component => component.backendId === item.backendId)!.freshness = { status: 'unavailable', reason: 'source_unverified' };
      return statuses.every(status => status === 'visible');
    });
    const overall = view.components.map(item => item.freshness.status);
    view.freshness = overall.includes('unavailable') ? { status: 'unavailable', reason: 'component_unavailable' }
      : overall.includes('stale') ? { status: 'stale', reason: 'component_stale' } : { status: 'current' };
    for (const item of eligible) {
      if (view.data.length >= request.maxItems!) { view.truncated.items = true; break; }
      const refs = uniqueSources([...view.sourceRefs, ...item.record.sourceRefs]);
      const aggregate = item.record.aggregateVersion;
      const aggregates = [...view.aggregateVersions];
      if (aggregate && name(aggregate.aggregateType) && name(aggregate.aggregateId) && revision(aggregate.version)
        && !aggregates.some(value => value.aggregateType === aggregate.aggregateType && value.aggregateId === aggregate.aggregateId)) aggregates.push(clone(aggregate));
      const data = [...view.data, { backendId: item.backendId, recordId: item.record.recordId, fields: item.fields }];
      if (Buffer.byteLength(JSON.stringify({ ...view, data, sourceRefs: refs, aggregateVersions: aggregates }), 'utf8') > request.maxBytes!) { view.truncated.bytes = true; break; }
      view.data = data; view.sourceRefs = refs; view.aggregateVersions = aggregates;
    }
    if (Buffer.byteLength(JSON.stringify(view), 'utf8') > request.maxBytes!) fail('VIEW_TOO_LARGE', 'View metadata exceeds the requested byte limit');
    const finalAccess = await this.access(actor, request);
    if (initialSecurity !== securityHash(actor, request, finalAccess) || !safetyMatches(finalAccess.appliedSafety, finalAccess)) fail('VIEW_INVALIDATED', 'View authority changed while reading');
    if (this.now().getTime() >= Date.parse(view.expiresAt)) fail('EXPIRED', 'View expired while reading');
    if (this.closed) fail('DISPOSED', 'View service is disposed');
    // Retain only bounded validation metadata, never fields, prompts or business text.
    while (this.issued.size >= this.maxOutstanding) this.issued.delete(this.issued.keys().next().value!);
    const { query: _query, ...validationRequest } = request;
    this.issued.set(view.viewId, freeze({ actor: clone(actor), request: clone(validationRequest), scopeHash: view.scopeHash, securityHash: initialSecurity, sourceRefs: clone(view.sourceRefs), expiresAt: view.expiresAt }));
    return freeze(view);
  }
  /** Authorization recheck only. Sending still needs Conversation/Effect admission in its own transaction. */
  async assertCurrent(inputActor: TrustedViewActor, viewId: string, use: ViewUse): Promise<void> {
    this.prune();
    const metadata = this.issued.get(viewId);
    if (!metadata || !use || metadata.request.purpose !== use.purpose || metadata.request.conversationId !== use.conversationId || metadata.request.taskId !== use.taskId) fail('FORBIDDEN', 'View access is not permitted');
    const actor = this.actor(inputActor, use.purpose);
    if (actor.principalId !== metadata.actor.principalId || actor.role !== metadata.actor.role) fail('FORBIDDEN', 'View access is not permitted');
    const access = await this.access(actor, metadata.request);
    if (!safetyMatches(access.appliedSafety, access) || securityHash(actor, metadata.request, access) !== metadata.securityHash) fail('VIEW_INVALIDATED', 'View authority changed');
    const visibility = await this.sourceVisibility(access, metadata.sourceRefs);
    if (metadata.sourceRefs.some(ref => visibility.get(sourceKey(ref)) !== 'visible')) fail('VIEW_INVALIDATED', 'View sources are no longer available to this audience');
    const finalAccess = await this.access(actor, metadata.request);
    if (securityHash(actor, metadata.request, finalAccess) !== metadata.securityHash) fail('VIEW_INVALIDATED', 'View authority changed while checking');
    if (this.now().getTime() >= Date.parse(metadata.expiresAt)) { this.issued.delete(viewId); fail('EXPIRED', 'View has expired'); }
    if (this.closed) fail('DISPOSED', 'View service is disposed');
  }
  release(viewId: string): void { this.issued.delete(viewId); }
  dispose(): void { this.closed = true; for (const controller of this.pending) controller.abort(); this.pending.clear(); this.issued.clear(); this.reads.clear(); }
}
