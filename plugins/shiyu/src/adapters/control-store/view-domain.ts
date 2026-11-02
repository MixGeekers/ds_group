import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ContextSnapshot } from '../../control/conversations/index.js';
import type { TaskView } from '../../control/tasks/index.js';
import { LocalReadSafetyStore, LOCAL_TASK_FIELDS, type LocalReadSafety } from '../../state/safety.js';
import { StatePublicationStore, type PublishedState } from '../../state/publication.js';
import type { ComponentSnapshot, TrustedViewActor, ViewAccess } from '../../views/index.js';
import type { CommitWatermark, CommitWatermarkReader } from './commit-watermark.js';
import { SqliteTransactions } from './transaction.js';

export type LocalViewPurpose = 'reply_context' | 'task_status';
export type LocalViewPhase = 'prepare' | 'ack' | 'ready';
export type LocalTaskProjection = Pick<TaskView, 'taskId' | 'title' | 'state' | 'version' | 'updatedAt' | 'stopRequested'>;
export interface LocalViewCapture {
  schemaVersion: 1; captureId: string; capturedAt: string; expiresAt: string;
  actor: TrustedViewActor; access: ViewAccess; publication: PublishedState; control: CommitWatermark;
  safety: LocalReadSafety; index: { mode: 'not-used'; watermark: 0 };
  context: ContextSnapshot & { businessId: string; sessionId?: string };
  tasks: LocalTaskProjection[]; component: ComponentSnapshot;
}
export interface ViewCommands {
  'view.captureLocal': { input: { conversationId: string; purpose: LocalViewPurpose }; output: LocalViewCapture };
  'view.validateCapture': { input: { captureId: string; phase?: LocalViewPhase }; output: LocalViewCapture };
  'view.state': { input: Record<string, never>; output: PublishedState | undefined };
}
export type ViewDomainRequest = { [K in keyof ViewCommands]: { command: K; args: ViewCommands[K]['input'] } }[keyof ViewCommands];
interface Options {
  publication: StatePublicationStore; safety: LocalReadSafetyStore; watermark: CommitWatermarkReader;
  /** Same Worker/connection synchronous reads; no network, session, model, or other external I/O. */
  context(conversationId: string): LocalViewCapture['context'];
  getTask(taskId: string): TaskView;
  now?: () => Date; ttlMs?: number; maxCaptures?: number;
}
export class LocalViewError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'LocalViewError'; }
}
const fail = (code: string, message: string): never => { throw new LocalViewError(code, message); };
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
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
  private prune(): void { const now = this.now().getTime(); for (const [key, value] of this.captures) if (Date.parse(value.expiresAt) <= now) this.captures.delete(key); }
  captureLocal(input: ViewCommands['view.captureLocal']['input']): LocalViewCapture {
    fields(input, ['conversationId', 'purpose']);
    if (!id(input.conversationId) || !['reply_context', 'task_status'].includes(input.purpose)) fail('INVALID_SCHEMA', 'Invalid local conversation view');
    // Never let a caller export a capture whose enclosing transaction may roll back.
    if (this.tx.depth !== 0) fail('TRANSACTION_BOUNDARY', 'Capture must start at the Worker read boundary');
    this.prune(); if (this.captures.size >= this.bound) fail('VIEW_CAPACITY', 'Too many live captures');
    const capture = this.tx.atomic(() => {
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
      const now = this.now(), capturedAt = now.toISOString(), expiresAt = new Date(now.getTime() + this.ttl).toISOString();
      const control = this.options.watermark.read();
      const actor: TrustedViewActor = { principalId: 'local-replyer', role: 'replyer', scopes: ['local-owner'] };
      const appliedSafety = { authEpoch: safety.authEpoch, tombstoneWatermark: safety.tombstoneWatermark };
      const access: ViewAccess = { principalId: actor.principalId, purpose: input.purpose, scope: 'local-owner', audienceIds: ['local-owner'],
        resourceRefs: [`conversation:${input.conversationId}`, ...tasks.map(task => `task:${task.taskId}`)],
        components: [{ backendId: 'control-task', fields: [...LOCAL_TASK_FIELDS] }], expiresAt,
        policyVersion: safety.policyVersion, authEpoch: safety.authEpoch, tombstoneWatermark: safety.tombstoneWatermark, appliedSafety,
        commitSeq: control.commitSeq, stateVersion: publication.stateVersion, indexWatermark: 0, conversation: clone(context.token),
        authority: { publicationBaselineId: publication.baselineId, policyAuthorityId: safety.policyAuthorityId,
          deletionAuthorityId: safety.deletionAuthorityId, deletionScope: 'local-task-source', indexMode: 'not-used' } };
      const component: ComponentSnapshot = { capturedAt, verifiedSourceHash: hash(tasks), freshness: { status: 'current' }, appliedSafety, expiresAt,
        records: tasks.map(task => ({ recordId: task.taskId, scope: 'local-owner', audienceIds: ['local-owner'], resourceRefs: [`task:${task.taskId}`], fields: { ...task },
          sourceRefs: [{ sourceId: `task:${task.taskId}`, revision: task.version, observedAt: capturedAt, trustClass: 'trusted-control-ledger' }],
          aggregateVersion: { aggregateType: 'task', aggregateId: task.taskId, version: task.version } })) };
      return { schemaVersion: 1 as const, captureId: randomUUID(), capturedAt, expiresAt, actor, access, publication, control, safety,
        index: { mode: 'not-used' as const, watermark: 0 as const }, context, tasks, component };
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
      const safety = this.options.safety.snapshot();
      if (safetyKeys.some(key => safety[key] !== capture.safety[key]) || !safety.enabled) fail('VIEW_INVALIDATED', 'Local read authority changed');
      const publication = this.options.publication.get();
      if (!publication || publication.baselineId !== capture.publication.baselineId || publication.stateVersion !== capture.publication.stateVersion) fail('VIEW_INVALIDATED', 'Published inner availability manifest changed');
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
  execute(request: ViewDomainRequest): unknown {
    switch (request.command) {
      case 'view.captureLocal': return this.captureLocal(request.args);
      case 'view.validateCapture': fields(request.args, ['captureId', 'phase'], ['captureId']); return this.validateReplyCapture(request.args.captureId, { for: request.args.phase ?? 'ready' });
      case 'view.state': fields(request.args, []); return this.options.publication.get();
    }
  }
}
