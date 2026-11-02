import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ContextSnapshot } from '../../control/conversations/index.js';
import type { TaskView } from '../../control/tasks/index.js';
import { LocalReadSafetyStore, LOCAL_TASK_FIELDS, type LocalReadSafety } from '../../state/safety.js';
import { StatePublicationStore, type PublishedState } from '../../state/publication.js';
import type { ComponentSnapshot, TrustedViewActor, ViewAccess } from '../../views/index.js';
import type { CommitWatermark, CommitWatermarkReader } from './commit-watermark.js';
import { SqliteTransactions } from './transaction.js';
import type { MemoryDomain, MemoryViewSnapshot } from './memory-domain.js';
import type { LabReplyPermit } from '../../contracts/lab.js';
import {
  INNER_DOMAINS, INNER_DOMAIN_BACKENDS, validateInnerBodyRead, validateInnerCapture,
  type InnerAuthority, type InnerBodyRead, type InnerCapture, type InnerDomain, type InnerBodyRecord,
} from '../../contracts/inner.js';
import type { ViewInnerAuthority } from '../../views/index.js';

export type { MemoryViewSnapshot, MemoryViewSource } from './memory-domain.js';
export const MEMORY_VIEW_BACKEND = 'native-memory';
export const MEMORY_VIEW_FIELDS = ['text'] as const;
/** Metadata fields exposed by an inner-domain capture; the body is a separate read. */
export const INNER_VIEW_FIELDS = ['recordId', 'revision', 'kind', 'status', 'evidenceState', 'observedAt', 'bodyAvailable'] as const;
export const INNER_VIEW_BODY_FIELDS = ['body'] as const;
/** Trusted same-Worker inner-domain read port; it owns audiences, bodies and deletion barriers. */
export interface InnerDomainReadPort {
  captureForView(input: { conversationId: string; recordIds?: readonly string[] }): InnerCapture;
  validateForView(input: { capture: InnerCapture }): InnerCapture;
  readBodies(input: { capture: InnerCapture; recordIds: readonly string[] }): InnerBodyRead;
}

export type LocalViewPurpose = 'reply_context' | 'task_status';
export type LocalViewPhase = 'prepare' | 'ack' | 'ready';
export type LocalTaskProjection = Pick<TaskView, 'taskId' | 'title' | 'state' | 'version' | 'updatedAt' | 'stopRequested'>;
export interface LabReplyExecutionBinding { kind: 'lab-reply-v1'; operationId: string; replyId: string; connectionId: string }
export interface LabReplyCaptureRequest { operationId: string; permit: LabReplyPermit; memoryOperationIds?: string[] }
export interface LabReplyCaptureAuthority {
  conversationId: string; expiresAt: string; binding: LabReplyExecutionBinding;
}
export interface LocalViewCapture {
  schemaVersion: 1; captureId: string; capturedAt: string; expiresAt: string;
  actor: TrustedViewActor; access: ViewAccess; publication: PublishedState; control: CommitWatermark;
  safety: LocalReadSafety; index: { mode: 'not-used'; watermark: 0 };
  context: ContextSnapshot & { businessId: string; sessionId?: string };
  tasks: LocalTaskProjection[]; component: ComponentSnapshot;
  /** Selected, freshly authorized references only; never native memory bodies. */
  memory?: MemoryViewSnapshot;
  /** Metadata-only inner-domain captures; bodies require a separate, revalidated read. */
  inner?: { domains: Partial<Record<InnerDomain, InnerCapture>> };
  /** Metadata only. Its exact permit remains private in this Worker. */
  replyExecution?: LabReplyExecutionBinding;
}
export interface InnerBodyReadOutput {
  domain: InnerDomain; authority: InnerAuthority; capturedAt: string; bodies: InnerBodyRecord[];
}
export interface ViewCommands {
  'view.captureLocal': { input: { conversationId: string; purpose: LocalViewPurpose; memoryOperationIds?: string[]; innerDomains?: InnerDomain[] }; output: LocalViewCapture };
  'view.captureLabReply': { input: LabReplyCaptureRequest; output: LocalViewCapture };
  'view.validateCapture': { input: { captureId: string; phase?: LocalViewPhase }; output: LocalViewCapture };
  /** Exact content read for a previously captured, audience-trimmed inner-domain selection. */
  'view.readInnerBodies': { input: { captureId: string; domain: InnerDomain; recordIds: string[] }; output: InnerBodyReadOutput };
  'view.state': { input: Record<string, never>; output: PublishedState | undefined };
}
export type ViewDomainRequest = { [K in keyof ViewCommands]: { command: K; args: ViewCommands[K]['input'] } }[keyof ViewCommands];
interface Options {
  publication: StatePublicationStore; safety: LocalReadSafetyStore; watermark: CommitWatermarkReader;
  /** Same Worker/connection synchronous reads; no network, session, model, or other external I/O. */
  context(conversationId: string): LocalViewCapture['context'];
  getTask(taskId: string): TaskView;
  memory?: Pick<MemoryDomain, 'captureForView' | 'validateForView'>;
  inner?: Partial<Record<InnerDomain, InnerDomainReadPort>>;
  /** Exact same-Worker Lab permit + local operation check, never a caller profile. */
  authorizeLabReply?(request: LabReplyCaptureRequest, phase: 'capture' | 'validate'): LabReplyCaptureAuthority;
  now?: () => Date; ttlMs?: number; maxCaptures?: number;
}
export class LocalViewError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'LocalViewError'; }
}
function fail(code: string, message: string): never { throw new LocalViewError(code, message); }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const innerRecordId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(value);
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fields(value: unknown, allowed: string[], required = allowed): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_SCHEMA', 'Unknown or missing local view fields');
}
const strongKeys = ['bindingId', 'conversationId', 'scope', 'audienceVersion', 'conversationGeneration', 'routingRevision', 'sessionEpoch'] as const;
const safetyKeys = ['policyAuthorityId', 'policyVersion', 'enabled', 'authEpoch', 'deletionAuthorityId', 'deletionScope', 'tombstoneWatermark', 'baseline', 'installedAt'] as const;
function sourceVersions(context: ContextSnapshot): string {
  return JSON.stringify(context.sources.map(value => [value.reference.kind, value.reference.id, value.sourceVersion]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
}

/**
 * Captures are bounded, short-lived IPC read data, not a second state/history
 * store or a bearer permission. The shared synchronous transaction captures
 * publication, safety, Conversation and Task versions from one DB snapshot.
 * Subsequent validation always reads current sources. No GET publishes or acks.
 */
export class ViewDomain {
  private readonly captures = new Map<string, LocalViewCapture>();
  private readonly labPermits = new Map<string, LabReplyCaptureRequest>();
  private readonly issuedLabOperations = new Set<string>();
  private readonly ttl: number;
  private readonly bound: number;
  constructor(db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: Options) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'View authority requires the shared transaction connection');
    this.ttl = options.ttlMs ?? 30000; this.bound = options.maxCaptures ?? 256;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 30000 || !Number.isSafeInteger(this.bound) || this.bound < 1 || this.bound > 256) fail('INVALID_CONFIG', 'Invalid local capture bounds');
  }
  private now(): Date {
    const value = this.options.now?.() ?? new Date(); if (!Number.isFinite(value.getTime())) fail('INVALID_CLOCK', 'Invalid capture clock'); return value;
  }
  private prune(): void { const now = this.now().getTime(); for (const [key, value] of this.captures) if (Date.parse(value.expiresAt) <= now) { this.captures.delete(key); this.labPermits.delete(key); } }
  captureLocal(input: ViewCommands['view.captureLocal']['input']): LocalViewCapture {
    return this.capture(input);
  }
  captureLabReply(request: LabReplyCaptureRequest): LocalViewCapture {
    fields(request, ['operationId', 'permit', 'memoryOperationIds'], ['operationId', 'permit']);
    if (!id(request.operationId) || !this.options.authorizeLabReply) fail('LAB_CAPTURE_UNAVAILABLE', 'A trusted Lab reply authority is required');
    if (this.issuedLabOperations.has(request.operationId)) fail('LAB_CAPTURE_ALREADY_ISSUED', 'The original reply capture cannot be renewed');
    if (this.issuedLabOperations.size >= 4096) fail('VIEW_CAPACITY', 'Too many issued Lab reply captures');
    const saved = clone(request);
    const capture = this.capture(undefined, saved);
    this.labPermits.set(capture.captureId, saved); this.issuedLabOperations.add(request.operationId);
    return capture;
  }
  private capture(localInput?: ViewCommands['view.captureLocal']['input'], labRequest?: LabReplyCaptureRequest): LocalViewCapture {
    // The callback is re-run inside the same transaction as the source capture.
    const input = localInput ?? { conversationId: '', purpose: 'reply_context' as const, ...(labRequest?.memoryOperationIds ? { memoryOperationIds: labRequest.memoryOperationIds } : {}) };
    fields(input, ['conversationId', 'purpose', 'memoryOperationIds', 'innerDomains'], ['conversationId', 'purpose']);
    if ((!labRequest && !id(input.conversationId)) || !['reply_context', 'task_status'].includes(input.purpose)) fail('INVALID_SCHEMA', 'Invalid local conversation view');
    if (input.innerDomains !== undefined) {
      if (input.purpose !== 'reply_context' || !Array.isArray(input.innerDomains) || !input.innerDomains.length || input.innerDomains.length > INNER_DOMAINS.length
        || input.innerDomains.some(domain => !(INNER_DOMAINS as readonly string[]).includes(domain))
        || new Set(input.innerDomains).size !== input.innerDomains.length) fail('INVALID_SCHEMA', 'Inner-domain reads require a bounded reply-context selection');
    }
    if (input.memoryOperationIds !== undefined && (input.purpose !== 'reply_context' || !Array.isArray(input.memoryOperationIds)
      || input.memoryOperationIds.length > 20 || input.memoryOperationIds.some(value => !id(value))
      || new Set(input.memoryOperationIds).size !== input.memoryOperationIds.length)) fail('INVALID_SCHEMA', 'Invalid bounded memory selection');
    // Never let a caller export a capture whose enclosing transaction may roll back.
    if (this.tx.depth !== 0) fail('TRANSACTION_BOUNDARY', 'Capture must start at the Worker read boundary');
    this.prune(); if (this.captures.size >= this.bound) fail('VIEW_CAPACITY', 'Too many live captures');
    const capture = this.tx.atomic(() => {
      const execution = labRequest ? this.options.authorizeLabReply!(clone(labRequest), 'capture') : undefined;
      if (execution) input.conversationId = execution.conversationId;
      const publication = this.options.publication.get() ?? fail('STATE_UNPUBLISHED', 'Inner availability manifest has not been explicitly published');
      const safety = this.options.safety.snapshot();
      if (!safety.enabled) fail('FORBIDDEN', 'Local Task reads are disabled by their owner');
      const context = this.options.context(input.conversationId);
      if (context.token.conversationId !== input.conversationId || context.token.scope !== 'local-owner') fail('FORBIDDEN', 'Only the authenticated local conversation can be captured');
      if (context.sources.length > 20 || context.sources.some(source => source.reference.kind !== 'task')) fail('SOURCE_UNAVAILABLE', 'This slice supports at most twenty associated Task sources');
      const taskIds = context.sources.map(source => source.reference.id);
      if (new Set(taskIds).size !== taskIds.length) fail('SOURCE_UNAVAILABLE', 'Duplicate associated Task source');
      const tasks = taskIds.sort().map(taskId => {
        if (this.options.safety.isWithdrawn(taskId)) fail('SOURCE_WITHDRAWN', 'An associated local Task source was withdrawn');
        const task = this.options.getTask(taskId);
        if (task.taskId !== taskId || !Number.isSafeInteger(task.version) || task.version < 1) fail('SOURCE_UNAVAILABLE', 'Task aggregate version is unavailable');
        return { taskId: task.taskId, title: task.title, state: task.state, version: task.version, updatedAt: task.updatedAt, stopRequested: task.stopRequested };
      });
      let memory: MemoryViewSnapshot | undefined;
      if (input.memoryOperationIds !== undefined) {
        const published = publication.manifest.domains.memory;
        if (published.status !== 'available' || !this.options.memory) fail('MEMORY_UNAVAILABLE', 'Memory has no published read capability');
        memory = this.options.memory.captureForView({ conversationId: input.conversationId, operationIds: input.memoryOperationIds });
        if (memory.truncated || memory.conversationId !== input.conversationId || memory.sources.length !== input.memoryOperationIds.length
          || memory.sources.some(source => !input.memoryOperationIds!.includes(source.operationId))
          || memory.authority.authorizationEpoch !== safety.authEpoch
          || memory.authority.backendId !== published.backendId || memory.authority.deploymentId !== published.deploymentId) fail('MEMORY_UNAVAILABLE', 'Selected memory provenance is incomplete or belongs to another published backend');
      }
      let inner: LocalViewCapture['inner'];
      const innerAuthority: Partial<Record<InnerDomain, ViewInnerAuthority>> = {};
      const innerComponents: { backendId: string; fields: readonly string[]; bodyFields: readonly string[]; authority: InnerDomain }[] = [];
      const innerResources: string[] = [];
      if (input.innerDomains !== undefined) {
        const domains: Partial<Record<InnerDomain, InnerCapture>> = {};
        for (const domain of [...input.innerDomains].sort()) {
          const published = publication.manifest.domains[domain];
          const port = this.options.inner?.[domain];
          if (!published || published.status !== 'available' || !port) fail('INNER_DOMAIN_UNAVAILABLE', `${domain} has no published read capability`);
          let captured: InnerCapture;
          try { captured = validateInnerCapture(port.captureForView({ conversationId: input.conversationId })); }
          catch (error) {
            if (error && typeof error === 'object' && 'code' in error && ['UNKNOWN_INNER_CONVERSATION', 'INNER_CONVERSATION_INACTIVE', 'INNER_AUDIENCE_FORBIDDEN'].includes(String(error.code))) fail('FORBIDDEN', 'This conversation audience is not authorized for inner-domain reads');
            throw error;
          }
          if (captured.domain !== domain || captured.conversationId !== input.conversationId) fail('INNER_DOMAIN_UNAVAILABLE', 'An inner-domain capture belongs to another conversation');
          if (captured.authority.authorityId !== published.authorityId) fail('INNER_DOMAIN_UNAVAILABLE', 'The published inner-domain read authority does not match its live instance');
          domains[domain] = captured;
          innerAuthority[domain] = { domain, authorityId: captured.authority.authorityId, installationGeneration: captured.authority.installationGeneration,
            policyVersion: captured.authority.policyVersion, tombstoneWatermark: captured.authority.tombstoneWatermark, baselineId: captured.authority.baselineId };
          innerComponents.push({ backendId: INNER_DOMAIN_BACKENDS[domain], fields: [...INNER_VIEW_FIELDS], bodyFields: [...INNER_VIEW_BODY_FIELDS], authority: domain });
          for (const record of captured.records) innerResources.push(`inner:${domain}:${record.recordId}`);
        }
        inner = { domains };
      }
      const now = this.now(), capturedAt = now.toISOString();
      const expires = execution ? Date.parse(execution.expiresAt) : now.getTime() + this.ttl;
      if (!Number.isFinite(expires) || expires <= now.getTime() || (execution && (expires > now.getTime() + 120000
        || execution.binding.kind !== 'lab-reply-v1' || execution.binding.operationId !== labRequest!.operationId
        || execution.binding.replyId !== labRequest!.permit.replyId || execution.binding.connectionId !== labRequest!.permit.connectionId))) fail('INVALID_LAB_CAPTURE', 'Invalid fixed Lab reply deadline or binding');
      const expiresAt = new Date(expires).toISOString();
      const control = this.options.watermark.read();
      const actor: TrustedViewActor = { principalId: 'local-replyer', role: 'replyer', scopes: ['local-owner'] };
      const appliedSafety = { authEpoch: safety.authEpoch, tombstoneWatermark: safety.tombstoneWatermark };
      const access: ViewAccess = { principalId: actor.principalId, purpose: input.purpose, scope: 'local-owner', audienceIds: ['local-owner'],
        resourceRefs: [`conversation:${input.conversationId}`, ...tasks.map(task => `task:${task.taskId}`),
          ...(memory?.sources.map(source => `memory:${source.operationId}`) ?? []), ...innerResources],
        components: [{ backendId: 'control-task', fields: [...LOCAL_TASK_FIELDS] },
          ...(memory ? [{ backendId: MEMORY_VIEW_BACKEND, fields: [...MEMORY_VIEW_FIELDS], authority: 'memory' as const }] : []), ...innerComponents], expiresAt,
        policyVersion: safety.policyVersion, authEpoch: safety.authEpoch, tombstoneWatermark: safety.tombstoneWatermark, appliedSafety,
        commitSeq: control.commitSeq, stateVersion: publication.stateVersion, indexWatermark: 0, conversation: clone(context.token),
        authority: { publicationBaselineId: publication.baselineId, policyAuthorityId: safety.policyAuthorityId,
          deletionAuthorityId: safety.deletionAuthorityId, deletionScope: 'local-task-source', indexMode: 'not-used',
          ...(memory ? { memory: clone(memory.authority) } : {}),
          ...(Object.keys(innerAuthority).length ? { inner: clone(innerAuthority) } : {}) } };
      const component: ComponentSnapshot = { capturedAt, verifiedSourceHash: hash(tasks), freshness: { status: 'current' }, appliedSafety, expiresAt,
        records: tasks.map(task => ({ recordId: task.taskId, scope: 'local-owner', audienceIds: ['local-owner'], resourceRefs: [`task:${task.taskId}`], fields: { ...task },
          sourceRefs: [{ sourceId: `task:${task.taskId}`, revision: task.version, observedAt: capturedAt, trustClass: 'trusted-control-ledger' }],
          aggregateVersion: { aggregateType: 'task', aggregateId: task.taskId, version: task.version } })) };
      return { schemaVersion: 1 as const, captureId: randomUUID(), capturedAt, expiresAt, actor, access, publication, control, safety,
        index: { mode: 'not-used' as const, watermark: 0 as const }, context, tasks, component, ...(memory ? { memory: clone(memory) } : {}),
        ...(inner ? { inner: clone(inner) } : {}), ...(execution ? { replyExecution: clone(execution.binding) } : {}) };
    });
    this.captures.set(capture.captureId, clone(capture)); return clone(capture);
  }
  /** ack validates security only, so background arriving during a durable load remains pending. */
  validateReplyCapture(captureId: string, input: { for: LocalViewPhase }): LocalViewCapture {
    if (!id(captureId) || !input || !['prepare', 'ack', 'ready'].includes(input.for)) fail('INVALID_SCHEMA', 'Invalid capture validation');
    this.prune(); const capture = this.captures.get(captureId) ?? fail('UNKNOWN_CAPTURE', 'Capture expired or belongs to a previous Worker');
    return this.tx.atomic(() => {
      // BEGIN can wait on another managed connection. Admission before that wait
      // is not proof that the fixed lease is still live inside the transaction.
      if (this.now().getTime() >= Date.parse(capture.expiresAt)) fail('EXPIRED', 'Capture expired while acquiring the read transaction');
      if (capture.replyExecution) {
        const permit = this.labPermits.get(captureId);
        if (!permit || !this.options.authorizeLabReply) fail('LAB_CAPTURE_UNAVAILABLE', 'Original Lab capture authority is unavailable');
        const checked = this.options.authorizeLabReply(clone(permit), 'validate');
        if (checked.conversationId !== capture.context.token.conversationId || checked.expiresAt !== capture.expiresAt
          || hash(checked.binding) !== hash(capture.replyExecution)) fail('VIEW_INVALIDATED', 'Original Lab reply execution authority changed');
      }
      const safety = this.options.safety.snapshot();
      if (safetyKeys.some(key => safety[key] !== capture.safety[key]) || !safety.enabled) fail('VIEW_INVALIDATED', 'Local read authority changed');
      const publication = this.options.publication.get();
      if (!publication || publication.baselineId !== capture.publication.baselineId || publication.stateVersion !== capture.publication.stateVersion) fail('VIEW_INVALIDATED', 'Published inner availability manifest changed');
      if (capture.memory) {
        if (!this.options.memory) fail('MEMORY_UNAVAILABLE', 'Memory authority is no longer connected');
        const checked = this.options.memory.validateForView(capture.memory);
        if (hash(checked) !== hash(capture.memory)) fail('VIEW_INVALIDATED', 'Memory authorization snapshot changed');
      }
      if (capture.inner) {
        for (const [domain, stored] of Object.entries(capture.inner.domains)) {
          const port = this.options.inner?.[domain as InnerDomain];
          if (!port) fail('INNER_DOMAIN_UNAVAILABLE', 'Inner-domain read authority is no longer connected');
          let checked: InnerCapture;
          try { checked = port!.validateForView({ capture: stored! }); }
          catch (error) {
            if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('INNER_')) {
              fail('VIEW_INVALIDATED', 'Inner-domain capture authority, audience or provenance changed');
            }
            throw error;
          }
          if (hash(checked) !== hash(stored)) fail('VIEW_INVALIDATED', 'Inner-domain capture authority changed');
          const published = publication.manifest.domains[domain as InnerDomain];
          if (!published || published.status !== 'available' || published.authorityId !== checked.authority.authorityId) fail('VIEW_INVALIDATED', 'Published inner-domain read capability changed');
        }
      }
      const current = this.options.context(capture.context.token.conversationId);
      if (strongKeys.some(key => current.token[key] !== capture.context.token[key]) || current.businessId !== capture.context.businessId
        || (capture.context.sessionId !== undefined && current.sessionId !== capture.context.sessionId)) fail('STALE_CONTEXT', 'Conversation audience, generation, routing or Session binding changed');
      if (input.for !== 'ack') {
        if (sourceVersions(current) !== sourceVersions(capture.context)) fail('STALE_SOURCE', 'Associated Conversation sources changed');
        for (const task of capture.tasks) {
          if (this.options.safety.isWithdrawn(task.taskId) || this.options.getTask(task.taskId).version !== task.version) fail('STALE_SOURCE', 'Captured Task aggregate changed');
        }
      }
      // Return pinned bytes/deadline, never silently refresh to a newer snapshot.
      if (this.now().getTime() >= Date.parse(capture.expiresAt)) fail('EXPIRED', 'Capture expired during current-source validation');
      return clone(capture);
    });
  }
  /**
   * Exact content read behind a previously captured metadata selection. The
   * caller cannot name records that were not captured for this audience, and
   * the domain revalidates authority, audience and provenance before returning
   * any body. No write, ack or publication happens here.
   */
  readInnerBodies(input: ViewCommands['view.readInnerBodies']['input']): InnerBodyReadOutput {
    fields(input, ['captureId', 'domain', 'recordIds']);
    if (!id(input.captureId) || !(INNER_DOMAINS as readonly string[]).includes(input.domain)
      || !Array.isArray(input.recordIds) || !input.recordIds.length || input.recordIds.length > 200
      || input.recordIds.some(recordId => !innerRecordId(recordId)) || new Set(input.recordIds).size !== input.recordIds.length) {
      fail('INVALID_SCHEMA', 'Invalid bounded inner-domain body read');
    }
    const domain = input.domain;
    const capture = this.validateReplyCapture(input.captureId, { for: 'ready' });
    const stored = capture.inner?.domains[domain];
    const port = this.options.inner?.[domain];
    if (!stored || !port) fail('INNER_DOMAIN_UNAVAILABLE', 'This capture has no inner-domain metadata for that domain');
    const readable = new Set(stored.records.filter(record => record.bodyAvailable).map(record => record.recordId));
    for (const recordId of input.recordIds) if (!readable.has(recordId)) fail('INNER_BODY_FORBIDDEN', 'A requested body was not captured as readable for this audience');
    let result: InnerBodyRead;
    try { result = validateInnerBodyRead(port.readBodies({ capture: stored, recordIds: [...input.recordIds] })); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('INNER_')) {
        fail('VIEW_INVALIDATED', 'The captured inner-domain selection is no longer readable');
      }
      throw error;
    }
    if (result.domain !== domain || hash(result.authority) !== hash(stored.authority) || result.capturedAt !== stored.capturedAt
      || result.bodies.length !== input.recordIds.length || new Set(result.bodies.map(body => body.recordId)).size !== input.recordIds.length) {
      fail('VIEW_INVALIDATED', 'Inner-domain authority or selection changed before the body read');
    }
    return { domain: result.domain, authority: clone(result.authority), capturedAt: result.capturedAt, bodies: clone(result.bodies) };
  }
  execute(request: ViewDomainRequest): unknown {
    switch (request.command) {
      case 'view.captureLocal': return this.captureLocal(request.args);
      case 'view.captureLabReply': return this.captureLabReply(request.args);
      case 'view.validateCapture': fields(request.args, ['captureId', 'phase'], ['captureId']); return this.validateReplyCapture(request.args.captureId, { for: request.args.phase ?? 'ready' });
      case 'view.readInnerBodies': return this.readInnerBodies(request.args);
      case 'view.state': fields(request.args, []); return this.options.publication.get();
    }
  }
}
