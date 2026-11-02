import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EffectLedger, type EffectClaim, type EffectRecord, type EffectReceipt, type DispatchVerdict } from '../../control/effects/index.js';
import { MandateStore, type BudgetReservation, type TrustedPolicyActor } from '../../control/policy/mandates.js';
import { TaskFacade, TaskError, type CancellationProof, type RecoveryProof, type TaskView, type Ticket, type Assignment, type VerificationContext } from '../../control/tasks/index.js';
import { key } from '../../control/tasks/upstream/ids.js';
import { SQLiteTaskRepositories } from './task-repositories.js';
import { SqliteTransactions } from './transaction.js';
import { createControlAuthority } from './authority.js';
import type { CoreTaskDelegation } from '../../contracts/core.js';

export interface TaskRuntimeIdentity { hostEpoch: string; installationGeneration: string }
/** Opaque trusted runtime capability. Never accepted from public UI/model arguments. */
export interface TaskExecutionPermit extends TaskRuntimeIdentity {
  taskId: string;
  assignmentId: string;
  scope: 'local-owner';
  fencingToken: number;
  leaseExpiresAt: string;
  claimToken: string;
  reservationId: string;
  mandateId: string;
  mandateVersion: number;
  authEpoch: number;
}
export interface TaskExecutionPlan {
  taskId: string;
  assignmentId: string;
  scope: 'local-owner';
  title: string;
  content: string;
  artifactRef: string;
  expectedSha256: string;
  permit: TaskExecutionPermit;
  sessionId?: string;
  budget: { maxSteps: 2; maxTokens: 1024; timeoutMs: 120000 };
}
export interface TaskArtifactPayload { artifactRef: string; content: string; sha256: string; byteLength: number }
export interface TaskArtifactEffect { effect: EffectRecord; payload: TaskArtifactPayload }
export interface TaskExecutionSummary {
  assignmentId: string;
  state: 'pending' | 'claimed' | 'bound' | 'running' | 'reported' | 'unknown' | 'stopped';
  sessionId?: string;
  hostEpoch: string;
  installationGeneration: string;
  fencingToken?: number;
  leaseExpiresAt?: string;
}
export interface TaskDetail {
  task: TaskView;
  artifact: { artifactRef: string; expectedSha256: string; byteLength: number };
  execution?: TaskExecutionSummary;
  effects: EffectRecord[];
  effectReceipts: EffectReceipt[];
  reservation?: BudgetReservation;
}
export interface TaskArtifactObservation {
  claim: EffectClaim;
  observedSha256: string;
  observedBytes: number;
  receiptId: string;
  observedAt: string;
}
export interface TaskUsageObservation {
  permit: TaskExecutionPermit;
  /** Trusted native DSH/pi observations only; input excludes both cache categories. */
  usage: { status: 'reported' | 'unknown'; inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  /** null means native model calls were not completely observable; steps are not calls. */
  calls: number | null;
  /** Bounded native accounting evidence, never prompts, model text or tool payloads. */
  nativeObservations?: TaskNativeModelObservation[];
}
export interface TaskNativeModelObservation {
  type: string;
  seq?: number;
  usage?: Omit<TaskUsageObservation['usage'], 'status'>;
}
export interface TaskUsageReconciliation {
  taskId: string; assignmentId: string; receiptId: string; oldExecutionStopped: true; evidenceRef: string;
  usage: TaskUsageObservation['usage']; calls: number | null;
}
export interface TaskCommands {
  'task.createLocal': { input: { requestId: string; title: string; content: string }; output: TaskDetail };
  'task.list': { input: Record<string, never>; output: TaskView[] };
  'task.get': { input: { taskId: string }; output: TaskDetail };
  'task.claimAssignment': { input: { taskId: string; leaseMs?: number }; output: TaskExecutionPlan };
  'task.bindAssignment': { input: { permit: TaskExecutionPermit; sessionId: string }; output: TaskView };
  'task.assignmentStarted': { input: { permit: TaskExecutionPermit }; output: TaskView };
  'task.checkPermit': { input: { permit: TaskExecutionPermit }; output: { allowed: true } & TaskExecutionPermit };
  'task.enqueueArtifact': { input: { permit: TaskExecutionPermit; content: string }; output: TaskArtifactEffect };
  'task.claimEffect': { input: { permit: TaskExecutionPermit; effectId: string; leaseMs?: number }; output: EffectClaim | undefined };
  'task.assertEffect': { input: { permit: TaskExecutionPermit; claim: EffectClaim }; output: TaskArtifactEffect };
  'task.recordArtifactReceipt': { input: TaskArtifactObservation & { permit: TaskExecutionPermit }; output: EffectRecord };
  'task.reconcileArtifactReceipt': { input: TaskArtifactObservation & { taskId: string; oldExecutionStopped: true }; output: EffectRecord };
  'task.report': { input: { permit: TaskExecutionPermit; state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed'; summary: string }; output: TaskView };
  'task.verify': { input: { taskId: string }; output: TaskView };
  'task.settleUsage': { input: TaskUsageObservation; output: BudgetReservation };
  'task.reconcileUsage': { input: TaskUsageReconciliation; output: BudgetReservation };
  'task.cancel': { input: { taskId: string; reason: string }; output: TaskView };
  'task.confirmCancelled': { input: { taskId: string; proof: CancellationProof }; output: TaskView };
  'task.markUnknown': { input: { taskId: string; reason: string }; output: TaskView };
  'task.recover': { input: { taskId: string; proof?: RecoveryProof }; output: TaskView };
  'task.setPaused': { input: { paused: boolean }; output: { paused: boolean } };
}

export type TaskDomainRequest = { [K in keyof TaskCommands]: { command: K; args: TaskCommands[K]['input'] } }[keyof TaskCommands];
interface LocalInput {
  taskId: string; requestId: string; title: string; content: string; expectedSha256: string;
  byteLength: number; artifactRef: string; mandateId: string; createdAt: string;
  delegation?: { goalId: string; deliverableId: string; resourceRef: string; subjectId: string };
}
interface Execution extends TaskExecutionSummary { taskId: string; reservationId: string; permit?: TaskExecutionPermit }
interface DomainOptions {
  runtimeIdentity: TaskRuntimeIdentity;
  now?: () => Date;
  onSucceeded?: (taskId: string) => void;
}
const OWNER: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const DISPATCHER: TrustedPolicyActor = { principalId: 'shiyu-task-dispatcher', kind: 'component', scopes: ['local-owner'] };
const VERIFIER: TrustedPolicyActor = { principalId: 'shiyu-artifact-verifier', kind: 'component', scopes: ['local-owner'] };
const BUDGET = { tokens: 16384, calls: 2, effects: 1 };
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = (value: unknown): string => sha256(JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item));
const clone = <T>(value: T): T => structuredClone(value);
function text(value: unknown, field: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail('INVALID_TASK_INPUT', `Invalid ${field}`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) return fail('INVALID_TASK_INPUT', `Invalid ${field}`);
  return Number(value);
}
function object(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_TASK_INPUT', 'Expected a task command object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(field => !allowed.includes(field)) || required.some(field => !Object.hasOwn(input, field))) return fail('INVALID_TASK_INPUT', 'Unknown or missing task command fields');
  return input;
}

interface TokenAccounting {
  basis: 'host_total' | 'pi_disjoint_components' | 'unknown';
  tokens?: number;
  reason?: 'incomplete_observation' | 'missing_component';
}
function validateNativeObservations(observations: TaskNativeModelObservation[] | undefined): void {
  if (observations === undefined) return;
  if (!Array.isArray(observations) || observations.length > 100) fail('INVALID_TASK_INPUT', 'Native accounting observations must contain at most 100 records');
  for (const observation of observations) {
    object(observation, ['type', 'seq', 'usage'], ['type']);
    text(observation.type, 'native observation type', 100);
    if (!['assistant/message', 'assistant/attempt', 'session/title-llm-request'].includes(observation.type)
      && !/^compaction\/[a-z][a-z0-9._/-]{0,79}$/.test(observation.type)) fail('INVALID_TASK_INPUT', 'Unsupported native accounting event type');
    if (observation.seq !== undefined) integer(observation.seq, 'native observation sequence', 0, Number.MAX_SAFE_INTEGER);
    if (observation.usage !== undefined) {
      object(observation.usage, ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'], []);
      for (const [axis, value] of Object.entries(observation.usage)) integer(value, axis, 0, 1000000000);
    }
  }
}
/**
 * This trusted boundary consumes the native DSH/pi mapping: input, output,
 * cache read and cache write are disjoint. DSH may omit zero cache fields, so
 * an absent field is not evidence of zero. A reported host total is authoritative;
 * component counters are retained as telemetry, never added to it or forced to
 * equal input + output. Unknown aggregate coverage cannot settle a reservation.
 */
function tokenAccounting(usage: TaskUsageObservation['usage']): TokenAccounting {
  object(usage, ['status', 'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'], ['status']);
  if (!['reported', 'unknown'].includes(usage.status)) fail('INVALID_USAGE', 'Unknown usage observation status');
  for (const [axis, value] of Object.entries(usage)) if (axis !== 'status' && value !== undefined) integer(value, axis, 0, 1000000000);
  if (usage.status !== 'reported') return { basis: 'unknown', reason: 'incomplete_observation' };
  if (usage.totalTokens !== undefined) return { basis: 'host_total', tokens: usage.totalTokens };
  const components = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
  if (!components.every(value => value !== undefined)) return { basis: 'unknown', reason: 'missing_component' };
  return { basis: 'pi_disjoint_components', tokens: components.reduce((sum, value) => sum + value, 0) };
}

/**
 * The DB-side owner for the first bounded, local artifact Task. All methods are
 * synchronous. Its ports only persist intents; filesystem, native Agent and
 * provider work belongs to the trusted host runner outside this Worker.
 */
export class TaskDomain {
  readonly repositories: SQLiteTaskRepositories;
  readonly effects: EffectLedger;
  readonly mandates: MandateStore;
  readonly facade: TaskFacade;
  private ownerOperation = false;
  private coreAuthority?: (goalId: string, deliverableId: string) => CoreTaskDelegation;
  private delegatedAdmission?: CoreTaskDelegation;
  private corePauseObserver?: () => void;

  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: DomainOptions) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Task domain and transaction owner must share one connection');
    text(options.runtimeIdentity.hostEpoch, 'hostEpoch'); text(options.runtimeIdentity.installationGeneration, 'installationGeneration');
    this.repositories = new SQLiteTaskRepositories(db, tx);
    this.effects = new EffectLedger(db, tx, { now: () => this.date() });
    this.mandates = createControlAuthority(db, tx, { now: () => this.date() });
    tx.atomic(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_task_domain_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,fence INTEGER NOT NULL,paused INTEGER NOT NULL);
        INSERT OR IGNORE INTO shiyu_task_domain_meta VALUES(1,1,0,0);`);
      if (db.prepare('SELECT version FROM shiyu_task_domain_meta WHERE id=1').get()!.version !== 1) fail('INCOMPATIBLE_VERSION', 'Task domain schema needs an explicit migration');
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_task_local_inputs(task_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE IF NOT EXISTS shiyu_task_runs(assignment_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE INDEX IF NOT EXISTS shiyu_task_runs_task ON shiyu_task_runs(task_id);
        CREATE TABLE IF NOT EXISTS shiyu_task_aux_intents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE IF NOT EXISTS shiyu_task_artifact_payloads(effect_id TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE IF NOT EXISTS shiyu_task_artifact_observations(receipt_id TEXT PRIMARY KEY,effect_id TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE IF NOT EXISTS shiyu_task_usage_observations(reservation_id TEXT PRIMARY KEY,observation_hash TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));
        CREATE TABLE IF NOT EXISTS shiyu_task_usage_reconciliations(receipt_id TEXT PRIMARY KEY,observation_hash TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)));`);
    });
    this.facade = new TaskFacade({
      repo: this.repositories, records: this.repositories.records, effects: this.effects, clock: () => this.now(),
      policy: () => ({ version: 'local-owner-artifact-v1', paused: this.paused(), evalTimeoutMs: 60000,
        gate: trigger => trigger.source === 'shiyu-owner' && trigger.actor.id === OWNER.principalId
          ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', sender: OWNER.principalId } }
          : trigger.source === 'shiyu-core' && !trigger.human && this.delegatedAdmission
            && trigger.actor.source === 'shiyu-core' && trigger.actor.id === `core:${this.delegatedAdmission.goalId}`
            && trigger.meta.delegatedGoalId === this.delegatedAdmission.goalId
            ? { admissible: true, strength: 'explicit', basis: { via: 'listed', authority: this.delegatedAdmission.mandateId, sender: trigger.actor.id, rules: ['owner-delegated-local-note'] } }
          : { admissible: false, reason: 'local_owner_required' },
        revalidate: mandate => mandate.scope === 'local-owner' && (mandate.actor.id === OWNER.principalId
          || this.ownerOperation && mandate.actor.source === 'shiyu-core' && mandate.basis.via === 'listed' && !!mandate.basis.authority
            && this.mandates.get(OWNER, mandate.basis.authority).state === 'active'),
        admitsInferred: () => false,
      }),
      scope: { scope: input => input.source === 'shiyu-owner' || input.source === 'shiyu-core' && !!this.delegatedAdmission
        ? { listened: true, observed: false } : { listened: false, reason: 'unsupported_source' } },
      assessor: {
        request: candidate => this.intent(`assessment:${candidate.evalId}`, 'assessment', candidate),
        release: evalId => { this.db.prepare("UPDATE shiyu_task_aux_intents SET status='settled' WHERE id=?").run(`assessment:${evalId}`); },
      },
      executor: {
        start: (ticket, assignment) => this.queueAssignment(ticket, assignment),
        deliver: (ticket, assignment) => this.intent(`deliver:${assignment.id}:${sha256(JSON.stringify(ticket.undelivered))}`, 'deliver', { taskId: ticket.id, assignmentId: assignment.id, inputIds: ticket.undelivered }),
        stop: (ticket, assignment, reason) => this.intent(`stop:${assignment.id}:${reason}`, 'stop', { taskId: ticket.id, assignmentId: assignment.id, reason }),
      },
      outbox: {
        send: message => this.intent(`outbox:${message.id}`, 'outbox', message),
        status: id => {
          const row = this.db.prepare('SELECT status FROM shiyu_task_aux_intents WHERE id=?').get(`outbox:${id}`);
          return row ? row.status === 'cancelled' ? 'dropped' : 'pending' : undefined;
        },
        withdraw: id => { this.db.prepare("UPDATE shiyu_task_aux_intents SET status='cancelled' WHERE id=?").run(`outbox:${id}`); },
      },
      verifier: { verify: context => this.verifyEvidence(context) },
    });
    this.recoverOnOpen();
  }
  private date(): Date { return this.options.now?.() ?? new Date(); }
  private now(): string { return this.date().toISOString(); }
  private paused(): boolean { this.tx.assertUsable(); return this.db.prepare('SELECT paused FROM shiyu_task_domain_meta WHERE id=1').get()!.paused === 1; }
  /** Same-Worker read-only pause gate shared with delegated Core admission. */
  isPaused(): boolean { return this.paused(); }
  /** Same-Worker notification; joins the durable global pause transaction. */
  setCorePauseObserver(observer: () => void): void {
    if (this.corePauseObserver) fail('CORE_AUTHORITY_INSTALLED', 'Core pause observer is immutable');
    this.corePauseObserver = observer;
  }
  private assertRunning(): void { if (this.paused()) fail('TASK_PAUSED', 'Task dispatch is paused'); }
  private worker(taskId: string): TrustedPolicyActor { return { principalId: `worker:${taskId}`, kind: 'agent', scopes: ['local-owner'] }; }
  private taskSubject(local: LocalInput): TrustedPolicyActor {
    return local.delegation ? { principalId: local.delegation.subjectId, kind: 'agent', scopes: ['local-owner'] } : this.worker(local.taskId);
  }
  private authorizationResource(local: LocalInput): string { return local.delegation?.resourceRef ?? local.artifactRef; }
  /** Installed only by the same-Worker Core domain. A model cannot supply a delegation object. */
  setCoreAuthority(authority: (goalId: string, deliverableId: string) => CoreTaskDelegation): void {
    if (this.coreAuthority) fail('CORE_AUTHORITY_INSTALLED', 'Core Task admission authority is immutable');
    this.coreAuthority = authority;
  }
  /** Reuses the TaskFacade and shared Goal allowance; it never issues a new grant. */
  admitCoreIntent(input: { goalId: string; deliverableId: string; proposalId: string }): TaskDetail {
    object(input, ['goalId', 'deliverableId', 'proposalId']);
    return this.tx.atomic(() => {
      const delegation = this.coreAuthority?.(input.goalId, input.deliverableId) ?? fail('CORE_AUTHORITY_REQUIRED', 'Core admission needs current trusted scope validation');
      this.assertRunning();
      const requestId = `core:${sha256(JSON.stringify([input.goalId, input.deliverableId]))}`;
      const requestHash = digest(delegation);
      const old = this.db.prepare('SELECT task_id,request_hash FROM shiyu_task_local_inputs WHERE request_id=?').get(requestId);
      if (old) {
        // Authority may receive a newer version, but an already-owned deliverable is never minted again.
        const local = this.local(String(old.task_id));
        if (local.title !== delegation.title || local.content !== delegation.content || local.mandateId !== delegation.mandateId
          || local.delegation?.resourceRef !== delegation.resourceRef) fail('IDEMPOTENCY_CONFLICT', 'Core deliverable identity changed');
        return this.get(local.taskId);
      }
      const grant = this.mandates.get(OWNER, delegation.mandateId);
      if (grant.state !== 'active' || grant.version !== delegation.mandateVersion || grant.authEpoch !== delegation.authEpoch
        || !grant.subjectIds.includes(delegation.subjectId) || !grant.allowedResources.includes(delegation.resourceRef)
        || !['task.local-note.execute', 'artifact.write'].every(action => grant.allowedActions.includes(action))) fail('STALE_AUTHORITY', 'Core delegation no longer matches its shared mandate');
      const at = this.now(), triggerId = `local:${sha256(requestId)}`;
      if (this.delegatedAdmission) fail('CORE_REENTRANT', 'Delegated Task admission is not reentrant');
      this.delegatedAdmission = delegation;
      try {
      this.facade.receive({ id: triggerId, source: 'shiyu-core', threads: [{ source: 'shiyu-core', id: requestId }],
        actor: { source: 'shiyu-core', id: `core:${delegation.goalId}` }, human: false, addressed: 'direct', at, text: delegation.title,
        meta: { requestScope: 'local-owner', contentHash: sha256(delegation.content), delegatedGoalId: input.goalId, proposalId: input.proposalId,
          ownerBasisRef: grant.basisRef, sourceRefs: delegation.sourceRefs } });
      this.facade.evaluateDue();
      const candidate = this.facade.candidate(triggerId) ?? fail('MISSING_CANDIDATE', 'Delegated Task did not enter evaluation');
      const taskId = key('ticket', candidate.evalId), artifactRef = `artifact:${taskId}`;
      const local: LocalInput = { taskId, requestId, title: delegation.title, content: delegation.content,
        expectedSha256: sha256(delegation.content), byteLength: Buffer.byteLength(delegation.content), artifactRef,
        mandateId: grant.mandateId, createdAt: at, delegation: { goalId: input.goalId, deliverableId: input.deliverableId,
          resourceRef: delegation.resourceRef, subjectId: delegation.subjectId } };
      this.db.prepare('INSERT INTO shiyu_task_local_inputs VALUES(?,?,?,?)').run(taskId, requestId, requestHash, JSON.stringify(local));
      this.ownerOperation = true;
      try {
        const decision = this.facade.decide(triggerId, { kind: 'accept', title: local.title, scope: 'local-owner', reason: 'owner_delegated_core_intent', evalId: candidate.evalId }, {
          goalId: input.goalId, mandateId: grant.mandateId, mandateVersion: grant.version, requestScope: 'local-owner', requestId, payloadHash: requestHash,
          completionSpec: { version: 1, checks: [{ checkId: 'artifact-sha256', type: 'artifact.sha256', targetRef: artifactRef, expected: local.expectedSha256, evidenceRequired: true }] }, inputRefs: [`local-input:${taskId}`, ...delegation.sourceRefs],
        });
        if (decision.ticketId !== taskId) fail('TASK_ID_MISMATCH', 'Delegated Task identity changed');
      } finally { this.ownerOperation = false; }
      return this.get(taskId);
      } finally { this.delegatedAdmission = undefined; }
    });
  }
  /** Owner Goal resume only: never-launched Tasks may exchange an unused hold for the current authority. */
  resumeCorePending(goalId: string): string[] {
    return this.tx.atomic(() => {
      const resumed: string[] = [];
      for (const task of this.facade.list()) {
        const local = this.local(task.taskId);
        if (local.delegation?.goalId !== goalId || !task.latestAssignmentId || task.state !== 'queued') continue;
        const run = this.run(task.latestAssignmentId);
        // A native binding, claim, or Effect defeats the proof of zero dispatch.
        if (run.state !== 'pending' || run.permit || run.sessionId || this.effectsForTask(task.taskId).length) fail('RECONCILIATION_REQUIRED', 'Delegated work may already have dispatched');
        const grant = this.mandates.get(OWNER, local.mandateId), old = this.mandates.getReservation(OWNER, run.reservationId);
        if (grant.state !== 'active') fail('STALE_AUTHORITY', 'Goal resume needs an active shared grant');
        if (old.mandateVersion === grant.version && old.authEpoch === grant.authEpoch) continue;
        if (old.state !== 'reserved') fail('RECONCILIATION_REQUIRED', 'Only a provably unused reservation can be exchanged');
        this.mandates.reconcile(VERIFIER, { receiptId: `core-unused:${old.reservationId}`, reservationId: old.reservationId,
          expectedVersion: old.version, complete: true, usage: { tokens: 0, calls: 0, effects: 0 }, evidenceRef: `never-claimed-assignment:${run.assignmentId}` });
        const reservationId = `reservation:${task.taskId}:${run.assignmentId}:authority:${grant.version}`;
        this.mandates.reserve(this.taskSubject(local), { reservationId, mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch,
          scope: 'local-owner', action: 'task.local-note.execute', resourceScopes: [this.authorizationResource(local)], amount: BUDGET, leaseMs: 600000 });
        this.saveRun({ ...run, reservationId });
        this.db.prepare("UPDATE shiyu_task_aux_intents SET value=? WHERE id=? AND status='pending'").run(JSON.stringify({ taskId: task.taskId, assignmentId: run.assignmentId, reservationId }), `start:${run.assignmentId}`);
        resumed.push(task.taskId);
      }
      return resumed;
    });
  }
  private local(taskId: string): LocalInput {
    this.tx.assertUsable(); text(taskId, 'taskId');
    const row = this.db.prepare('SELECT value FROM shiyu_task_local_inputs WHERE task_id=?').get(taskId);
    return row ? JSON.parse(String(row.value)) as LocalInput : fail('UNKNOWN_TASK', 'No local-owner artifact task has this identity');
  }
  private run(assignmentId: string): Execution {
    this.tx.assertUsable(); text(assignmentId, 'assignmentId');
    const row = this.db.prepare('SELECT value FROM shiyu_task_runs WHERE assignment_id=?').get(assignmentId);
    return row ? JSON.parse(String(row.value)) as Execution : fail('UNKNOWN_ASSIGNMENT', 'Assignment execution binding is absent');
  }
  private saveRun(run: Execution): void {
    this.tx.assertUsable();
    this.db.prepare('INSERT INTO shiyu_task_runs(assignment_id,task_id,value) VALUES(?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET value=excluded.value').run(run.assignmentId, run.taskId, JSON.stringify(run));
  }
  private intent(id: string, kind: string, value: unknown): void {
    this.tx.assertUsable();
    this.db.prepare("INSERT INTO shiyu_task_aux_intents(id,kind,status,value) VALUES(?,?,'pending',?) ON CONFLICT(id) DO NOTHING").run(id, kind, JSON.stringify(value));
  }
  private effectsForTask(taskId: string): EffectRecord[] {
    this.tx.assertUsable();
    return this.db.prepare("SELECT effect_id FROM shiyu_effects WHERE json_extract(record_json,'$.origin.kind')='task' AND json_extract(record_json,'$.origin.taskId')=? ORDER BY seq").all(taskId)
      .map(row => this.effects.get(String(row.effect_id))!);
  }
  private queueAssignment(ticket: Ticket, assignment: Assignment): void {
    if (!this.ownerOperation) fail('OWNER_REQUIRED', 'New execution reservations require an explicit trusted owner command');
    const local = this.local(ticket.id);
    const mandate = this.mandates.get(OWNER, local.mandateId);
    const reservationId = `reservation:${ticket.id}:${assignment.id}`;
    this.mandates.reserve(this.taskSubject(local), { reservationId, mandateId: mandate.mandateId, mandateVersion: mandate.version, authEpoch: mandate.authEpoch,
      scope: 'local-owner', action: 'task.local-note.execute', resourceScopes: [this.authorizationResource(local)], amount: BUDGET, leaseMs: 600000 });
    this.saveRun({ taskId: ticket.id, assignmentId: assignment.id, reservationId, state: 'pending', ...this.options.runtimeIdentity });
    this.intent(`start:${assignment.id}`, 'start', { taskId: ticket.id, assignmentId: assignment.id, reservationId });
  }
  private permitRequest(permit: TaskExecutionPermit) {
    return { reservationId: permit.reservationId, mandateId: permit.mandateId, mandateVersion: permit.mandateVersion, authEpoch: permit.authEpoch,
      scope: 'local-owner', action: 'task.local-note.execute', resourceScopes: [this.authorizationResource(this.local(permit.taskId))] };
  }
  private matchPermit(permit: TaskExecutionPermit): Execution {
    const fields = ['taskId', 'assignmentId', 'scope', 'hostEpoch', 'installationGeneration', 'fencingToken', 'leaseExpiresAt', 'claimToken', 'reservationId', 'mandateId', 'mandateVersion', 'authEpoch'];
    object(permit, fields);
    const run = this.run(permit.assignmentId);
    if (!run.permit || fields.some(field => run.permit![field as keyof TaskExecutionPermit] !== permit[field as keyof TaskExecutionPermit])
      || permit.hostEpoch !== this.options.runtimeIdentity.hostEpoch || permit.installationGeneration !== this.options.runtimeIdentity.installationGeneration) fail('STALE_FENCE', 'Assignment permit does not match the current host and execution binding');
    return run;
  }
  /** Result facts may use a settled reservation; they never regain dispatch authority. */
  private checked(permit: TaskExecutionPermit, dispatch = true): Execution {
    this.assertRunning();
    const run = this.matchPermit(permit), task = this.facade.get(permit.taskId);
    if (permit.leaseExpiresAt <= this.now() || ['unknown', 'stopped', 'reported'].includes(run.state)
      || task.latestAssignmentId !== permit.assignmentId || task.stopRequested || ['unknown', 'succeeded', 'failed', 'cancelled'].includes(task.state)) fail('STALE_FENCE', 'Assignment is expired, stopped or awaiting reconciliation');
    if (dispatch) this.mandates.assertPermit(DISPATCHER, this.permitRequest(permit));
    else {
      const grant = this.mandates.get(OWNER, permit.mandateId);
      if (grant.state !== 'active' || grant.version !== permit.mandateVersion || grant.authEpoch !== permit.authEpoch) fail('STALE_AUTHORITY', 'Result callback no longer has current task authority');
    }
    return run;
  }
  private authorize(permit: TaskExecutionPermit, effect: Readonly<EffectRecord>): DispatchVerdict {
    this.checked(permit);
    const local = this.local(permit.taskId);
    const mandate = this.mandates.get(OWNER, permit.mandateId);
    if (effect.origin.kind !== 'task' || effect.origin.taskId !== permit.taskId || effect.origin.assignmentId !== permit.assignmentId
      || effect.effectId !== permit.reservationId || effect.action !== 'artifact.write' || !mandate.allowedActions.includes('artifact.write')
      || !mandate.allowedResources.includes(this.authorizationResource(local))
      || effect.resourceScopes.length !== 1 || effect.resourceScopes[0] !== local.artifactRef) return { allowed: false, reasonCode: 'wrong_task_effect' };
    return { allowed: true, hostEpoch: permit.hostEpoch, installationGeneration: permit.installationGeneration, fencingToken: permit.fencingToken,
      mandateId: permit.mandateId, mandateVersion: permit.mandateVersion, authEpoch: permit.authEpoch };
  }
  private payload(effectId: string): TaskArtifactPayload {
    const row = this.db.prepare('SELECT value FROM shiyu_task_artifact_payloads WHERE effect_id=?').get(effectId);
    return row ? JSON.parse(String(row.value)) as TaskArtifactPayload : fail('MISSING_PAYLOAD', 'Artifact effect payload is absent');
  }
  private createLocal(input: TaskCommands['task.createLocal']['input']): TaskDetail {
    object(input, ['requestId', 'title', 'content']); text(input.requestId, 'requestId', 100); text(input.title, 'title', 160);
    if (typeof input.content !== 'string' || !input.content.length || Buffer.byteLength(input.content, 'utf8') > 1024) fail('INVALID_TASK_INPUT', 'Local artifact content must contain 1–1024 UTF-8 bytes');
    const requestHash = sha256(JSON.stringify([input.title, input.content]));
    return this.tx.atomic(() => {
      const old = this.db.prepare('SELECT task_id,request_hash FROM shiyu_task_local_inputs WHERE request_id=?').get(input.requestId);
      if (old) {
        if (old.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'Request ID already names different local artifact content');
        return this.get(String(old.task_id));
      }
      this.assertRunning();
      const at = this.now(), triggerId = `local:${sha256(input.requestId)}`;
      this.facade.receive({ id: triggerId, source: 'shiyu-owner', threads: [{ source: 'shiyu-owner', id: input.requestId }],
        actor: { source: 'shiyu-owner', id: OWNER.principalId }, human: true, addressed: 'direct', at,
        text: input.title, meta: { requestScope: 'local-owner', contentHash: sha256(input.content) } });
      this.facade.evaluateDue();
      const candidate = this.facade.candidate(triggerId) ?? fail('MISSING_CANDIDATE', 'Local Task did not enter evaluation');
      const taskId = key('ticket', candidate.evalId), artifactRef = `artifact:${taskId}`, mandateId = `mandate:${taskId}`;
      const local: LocalInput = { taskId, requestId: input.requestId, title: input.title, content: input.content, expectedSha256: sha256(input.content), byteLength: Buffer.byteLength(input.content, 'utf8'), artifactRef, mandateId, createdAt: at };
      this.db.prepare('INSERT INTO shiyu_task_local_inputs(task_id,request_id,request_hash,value) VALUES(?,?,?,?)').run(taskId, input.requestId, requestHash, JSON.stringify(local));
      const grant = this.mandates.grant(OWNER, { id: mandateId, scope: 'local-owner', subjectIds: [this.worker(taskId).principalId], allowedActions: ['task.local-note.execute', 'artifact.write'], allowedResources: [artifactRef],
        limits: BUDGET, basisRef: triggerId, expiresAt: new Date(this.date().getTime() + 3600000).toISOString() });
      this.ownerOperation = true;
      try {
        const decision = this.facade.decide(triggerId, { kind: 'accept', title: input.title, scope: 'local-owner', reason: 'explicit_local_artifact_request', evalId: candidate.evalId }, {
          mandateId, mandateVersion: grant.version, requestScope: 'local-owner', requestId: input.requestId, payloadHash: requestHash,
          completionSpec: { version: 1, checks: [{ checkId: 'artifact-sha256', type: 'artifact.sha256', targetRef: artifactRef, expected: local.expectedSha256, evidenceRequired: true }] },
          inputRefs: [`local-input:${taskId}`],
        });
        if (decision.ticketId !== taskId) fail('TASK_ID_MISMATCH', 'Core Task identity changed during admission');
      } finally { this.ownerOperation = false; }
      return this.get(taskId);
    });
  }
  get(taskId: string): TaskDetail {
    const local = this.local(taskId), task = this.facade.get(taskId);
    const effects = this.effectsForTask(taskId);
    const execution = task.latestAssignmentId ? this.run(task.latestAssignmentId) : undefined;
    const summary = execution ? (({ taskId: _task, reservationId: _reservation, permit: _permit, ...value }) => value)(execution) : undefined;
    return { task, artifact: { artifactRef: local.artifactRef, expectedSha256: local.expectedSha256, byteLength: local.byteLength },
      ...(summary ? { execution: summary } : {}), effects, effectReceipts: effects.flatMap(effect => this.effects.receipts(effect.effectId)),
      ...(execution ? { reservation: this.mandates.getReservation(OWNER, execution.reservationId) } : {}) };
  }
  private claimAssignment(input: TaskCommands['task.claimAssignment']['input']): TaskExecutionPlan {
    object(input, ['taskId', 'leaseMs'], ['taskId']);
    return this.tx.atomic(() => {
      this.assertRunning(); const detail = this.get(input.taskId), local = this.local(input.taskId);
      if (detail.task.state !== 'queued' || !detail.task.activeAssignmentId) fail('TASK_NOT_DISPATCHABLE', 'Only a fresh queued assignment may be claimed');
      const run = this.run(detail.task.activeAssignmentId!);
      if (run.state !== 'pending') fail('ASSIGNMENT_CLAIMED', 'Assignment already has an execution claim; it cannot be automatically retried');
      const reservation = this.mandates.getReservation(OWNER, run.reservationId);
      const grant = this.mandates.get(OWNER, local.mandateId);
      this.mandates.assertPermit(DISPATCHER, { reservationId: run.reservationId, mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, scope: 'local-owner', action: 'task.local-note.execute', resourceScopes: [this.authorizationResource(local)] });
      const currentFence = Number(this.db.prepare('SELECT fence FROM shiyu_task_domain_meta WHERE id=1').get()!.fence);
      integer(currentFence, 'stored fence', 0, Number.MAX_SAFE_INTEGER - 1);
      const fencingToken = currentFence + 1; this.db.prepare('UPDATE shiyu_task_domain_meta SET fence=? WHERE id=1').run(fencingToken);
      const leaseMs = integer(input.leaseMs ?? 180000, 'leaseMs', 1, 300000);
      const permit: TaskExecutionPermit = { taskId: local.taskId, assignmentId: run.assignmentId, scope: 'local-owner', ...this.options.runtimeIdentity,
        fencingToken, leaseExpiresAt: new Date(Math.min(this.date().getTime() + leaseMs, Date.parse(reservation.leaseExpiresAt))).toISOString(), claimToken: randomUUID(),
        reservationId: run.reservationId, mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch };
      this.saveRun({ ...run, state: 'claimed', ...this.options.runtimeIdentity, fencingToken, leaseExpiresAt: permit.leaseExpiresAt, permit });
      return { taskId: local.taskId, assignmentId: run.assignmentId, scope: 'local-owner', title: local.title, content: local.content, artifactRef: local.artifactRef,
        expectedSha256: local.expectedSha256, permit, budget: { maxSteps: 2, maxTokens: 1024, timeoutMs: 120000 } };
    });
  }
  private enqueueArtifact(input: TaskCommands['task.enqueueArtifact']['input']): TaskArtifactEffect {
    object(input, ['permit', 'content']);
    return this.tx.atomic(() => {
      const run = this.checked(input.permit), local = this.local(input.permit.taskId);
      if (run.state !== 'running') fail('TASK_NOT_RUNNING', 'Artifact actions require the current running assignment');
      if (typeof input.content !== 'string' || input.content !== local.content) fail('ARTIFACT_CONTENT_MISMATCH', 'The bounded artifact content differs from its owner-approved input');
      const payload: TaskArtifactPayload = { artifactRef: local.artifactRef, content: local.content, sha256: local.expectedSha256, byteLength: local.byteLength };
      const effect = this.effects.enqueue({ effectId: input.permit.reservationId, idempotencyKey: `artifact:${local.taskId}:${run.assignmentId}`,
        origin: { kind: 'task', taskId: local.taskId, assignmentId: run.assignmentId }, action: 'artifact.write', resourceScopes: [local.artifactRef],
        payloadRef: `artifact-payload:${local.taskId}:${run.assignmentId}`, payloadHash: sha256(JSON.stringify(payload)), replayClass: 'idempotent', maxAttempts: 1,
        authorization: { mandateId: input.permit.mandateId, mandateVersion: input.permit.mandateVersion, authEpoch: input.permit.authEpoch, installationGeneration: input.permit.installationGeneration }, expiresAt: input.permit.leaseExpiresAt });
      this.db.prepare('INSERT INTO shiyu_task_artifact_payloads(effect_id,value) VALUES(?,?) ON CONFLICT(effect_id) DO NOTHING').run(effect.effectId, JSON.stringify(payload));
      return { effect, payload };
    });
  }
  private observation(input: TaskArtifactObservation, taskId: string, reconciliation: boolean): EffectRecord {
    const local = this.local(taskId), effect = this.effects.get(input.claim.effectId) ?? fail('UNKNOWN_EFFECT', 'Effect does not exist');
    if (effect.origin.kind !== 'task' || effect.origin.taskId !== taskId || effect.action !== 'artifact.write' || effect.resourceScopes[0] !== local.artifactRef) fail('WRONG_EFFECT', 'Artifact observation does not belong to this task');
    if (typeof input.observedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.observedSha256)) fail('INVALID_OBSERVATION', 'Artifact observation requires an SHA-256');
    integer(input.observedBytes, 'observedBytes', 0, 1024 * 1024); text(input.receiptId, 'receiptId');
    if (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt)) || new Date(input.observedAt).toISOString() !== input.observedAt) fail('INVALID_OBSERVATION', 'Artifact observation time must be canonical UTC');
    if (input.observedAt < input.claim.claimedAt || Date.parse(input.observedAt) > this.date().getTime() + 60000) fail('INVALID_OBSERVATION', 'Artifact observation is outside the execution interval');
    const payload = this.payload(effect.effectId);
    if (sha256(JSON.stringify(payload)) !== effect.payloadHash) fail('CORRUPT_PAYLOAD', 'Artifact payload no longer matches its intent');
    const matched = input.observedSha256 === local.expectedSha256 && input.observedBytes === local.byteLength;
    const receipt = { receiptId: input.receiptId, serviceId: 'shiyu-local-artifact', externalOperationId: effect.effectId,
      observedAt: input.observedAt, outcome: matched ? 'succeeded' as const : 'failed' as const, payloadHash: effect.payloadHash,
      evidenceRefs: [`artifact-observation:${input.receiptId}`, local.artifactRef] };
    return this.tx.atomic(() => {
      const verify = () => ({ verified: true as const, serviceId: receipt.serviceId, externalOperationId: effect.effectId, installationGeneration: effect.authorization.installationGeneration, reconciled: reconciliation,
        settledEffect: { idempotencyKey: effect.idempotencyKey, payloadHash: effect.payloadHash, outcome: receipt.outcome } });
      const result = reconciliation ? this.effects.reconcile(input.claim, receipt, verify) : this.effects.complete(input.claim, receipt, verify);
      const value = JSON.stringify({ ...input, taskId, matched, artifactRef: local.artifactRef });
      const old = this.db.prepare('SELECT value FROM shiyu_task_artifact_observations WHERE receipt_id=?').get(input.receiptId);
      if (old && old.value !== value) fail('IDEMPOTENCY_CONFLICT', 'Artifact receipt ID has different independent observations');
      this.db.prepare('INSERT OR IGNORE INTO shiyu_task_artifact_observations(receipt_id,effect_id,value) VALUES(?,?,?)').run(input.receiptId, effect.effectId, value);
      return result;
    });
  }
  private verifyEvidence(context: VerificationContext) {
    const local = this.local(context.taskId), effect = this.effectsForTask(context.taskId).find(value => value.origin.kind === 'task' && value.origin.assignmentId === context.assignmentId);
    const row = effect?.receiptId ? this.db.prepare('SELECT value FROM shiyu_task_artifact_observations WHERE receipt_id=? AND effect_id=?').get(effect.receiptId, effect.effectId) : undefined;
    const observed = row ? JSON.parse(String(row.value)) as TaskArtifactObservation & { matched: boolean; artifactRef: string } : undefined;
    const validSpec = context.completionSpec.checks.length === 1 && context.completionSpec.checks[0].targetRef === local.artifactRef
      && context.completionSpec.checks[0].expected === local.expectedSha256 && context.result.resultHash === local.expectedSha256
      && context.result.artifactRefs.length === 1 && context.result.artifactRefs[0] === local.artifactRef
      && context.result.effectRefs.length === 1 && context.result.effectRefs[0] === effect?.effectId;
    const passed = validSpec && effect?.status === 'succeeded' && observed?.matched === true && observed.observedSha256 === local.expectedSha256 && observed.observedBytes === local.byteLength;
    return { taskId: context.taskId, assignmentId: context.assignmentId, completionSpecVersion: context.completionSpec.version, resultHash: context.result.resultHash,
      verifierVersion: 'local-artifact-sha256-v1', verifiedAt: this.now(), checks: context.completionSpec.checks.map(check => ({ checkId: check.checkId,
        status: passed ? 'pass' as const : 'inconclusive' as const, evidenceRefs: passed ? [`artifact-observation:${effect!.receiptId}`, local.artifactRef] : [] })) };
  }
  private report(input: TaskCommands['task.report']['input']): TaskView {
    object(input, ['permit', 'state', 'summary']); text(input.summary, 'summary', 12000);
    if (!['progress', 'waiting', 'ready', 'blocked', 'failed'].includes(input.state)) fail('INVALID_REPORT', 'Unsupported worker report state');
    return this.tx.atomic(() => {
      const run = this.checked(input.permit, false), local = this.local(input.permit.taskId);
      const effect = this.effects.get(input.permit.reservationId);
      if (input.state === 'ready' && (effect?.status !== 'succeeded' || !effect.receiptId
        || !this.db.prepare('SELECT receipt_id FROM shiyu_task_artifact_observations WHERE receipt_id=? AND effect_id=?').get(effect.receiptId, effect.effectId))) fail('EVIDENCE_REQUIRED', 'A candidate summary cannot complete a Task without independent artifact evidence');
      const view = this.facade.report(run.taskId, run.assignmentId, { state: input.state, summary: input.summary,
        ...(input.state === 'ready' ? { result: { resultHash: local.expectedSha256, artifactRefs: [local.artifactRef], effectRefs: [effect!.effectId] } } : {}) });
      if (input.state === 'ready' || input.state === 'failed') {
        this.saveRun({ ...run, state: 'reported' });
        this.db.prepare("UPDATE shiyu_task_aux_intents SET status='settled' WHERE id=?").run(`start:${run.assignmentId}`);
      }
      return view;
    });
  }
  private settleUsage(input: TaskUsageObservation): BudgetReservation {
    object(input, ['permit', 'usage', 'calls', 'nativeObservations'], ['permit', 'usage', 'calls']);
    const run = this.matchPermit(input.permit);
    if (input.calls !== null) integer(input.calls, 'calls', 0, 100);
    validateNativeObservations(input.nativeObservations);
    const accounting = tokenAccounting(input.usage), tokens = accounting.tokens;
    const effect = this.effects.get(run.reservationId);
    const effects = !effect || effect.status === 'cancelled' ? 0 : ['succeeded', 'failed'].includes(effect.status) ? 1 : undefined;
    const observation = { usage: clone(input.usage), calls: input.calls, ...(effects !== undefined ? { effects } : {}),
      ...(input.nativeObservations !== undefined ? { nativeObservations: clone(input.nativeObservations) } : {}) };
    const observationHash = digest(observation);
    return this.tx.atomic(() => {
      const previous = this.db.prepare('SELECT observation_hash,value FROM shiyu_task_usage_observations WHERE reservation_id=?').get(run.reservationId);
      if (previous) {
        if (previous.observation_hash !== observationHash) fail('IDEMPOTENCY_CONFLICT', 'Invocation usage was already recorded with different observations');
        const saved = JSON.parse(String(previous.value)) as BudgetReservation | { reservation: BudgetReservation };
        return 'reservation' in saved ? saved.reservation : saved;
      }
      const reservation = this.mandates.getReservation(OWNER, run.reservationId);
      const settled = this.mandates.reconcile(VERIFIER, { receiptId: `usage:${run.assignmentId}`, reservationId: run.reservationId, expectedVersion: reservation.version,
        complete: tokens !== undefined && input.calls !== null && effects !== undefined,
        usage: { ...(tokens !== undefined ? { tokens } : {}), ...(input.calls !== null ? { calls: input.calls } : {}), ...(effects !== undefined ? { effects } : {}) }, evidenceRef: `native-worker-usage:${run.assignmentId}` });
      // Keep raw telemetry and the chosen accounting basis for independent reconciliation.
      this.db.prepare('INSERT INTO shiyu_task_usage_observations(reservation_id,observation_hash,value) VALUES(?,?,?)').run(run.reservationId, observationHash,
        JSON.stringify({ reservation: settled, accounting, observation }));
      return settled;
    });
  }
  private reconcileUsage(input: TaskUsageReconciliation): BudgetReservation {
    object(input, ['taskId', 'assignmentId', 'receiptId', 'oldExecutionStopped', 'evidenceRef', 'usage', 'calls']);
    this.local(input.taskId);
    const run = this.run(input.assignmentId);
    if (run.taskId !== input.taskId || input.oldExecutionStopped !== true) fail('RECONCILIATION_REQUIRED', 'Usage reconciliation requires a matching stopped old execution');
    text(input.receiptId, 'receiptId'); text(input.evidenceRef, 'evidenceRef');
    if (input.calls !== null) integer(input.calls, 'calls', 0, 100);
    const accounting = tokenAccounting(input.usage), tokens = accounting.tokens;
    const effect = this.effects.get(run.reservationId);
    const effects = !effect || effect.status === 'cancelled' ? 0 : ['succeeded', 'failed'].includes(effect.status) ? 1 : undefined;
    return this.tx.atomic(() => {
      const observationHash = digest(input);
      const old = this.db.prepare('SELECT observation_hash,value FROM shiyu_task_usage_reconciliations WHERE receipt_id=?').get(input.receiptId);
      if (old) {
        if (old.observation_hash !== observationHash) fail('IDEMPOTENCY_CONFLICT', 'Usage reconciliation receipt already names different observations');
        return (JSON.parse(String(old.value)) as { reservation: BudgetReservation }).reservation;
      }
      const reservation = this.mandates.getReservation(OWNER, run.reservationId);
      const reconciled = this.mandates.reconcile(VERIFIER, { receiptId: input.receiptId, reservationId: run.reservationId, expectedVersion: reservation.version,
        complete: tokens !== undefined && input.calls !== null && effects !== undefined,
        usage: { ...(tokens !== undefined ? { tokens } : {}), ...(input.calls !== null ? { calls: input.calls } : {}), ...(effects !== undefined ? { effects } : {}) }, evidenceRef: input.evidenceRef });
      this.db.prepare('INSERT INTO shiyu_task_usage_reconciliations(receipt_id,observation_hash,value) VALUES(?,?,?)').run(input.receiptId, observationHash,
        JSON.stringify({ reservation: reconciled, accounting, observation: clone(input) }));
      return reconciled;
    });
  }
  private markUnknown(taskId: string, reason: string): TaskView {
    text(reason, 'reason', 500);
    return this.tx.atomic(() => {
      const detail = this.get(taskId);
      for (const effect of detail.effects) if (effect.status === 'dispatching' && effect.currentClaim) this.effects.markUnknown(effect.currentClaim, 'task_execution_unknown');
      if (detail.task.latestAssignmentId) {
        const run = this.run(detail.task.latestAssignmentId); this.saveRun({ ...run, state: 'unknown' });
        const reservation = this.mandates.getReservation(OWNER, run.reservationId);
        if (reservation.state === 'reserved') this.mandates.reconcile(VERIFIER, { receiptId: `unknown:${run.assignmentId}`, reservationId: run.reservationId,
          expectedVersion: reservation.version, complete: false, usage: {}, evidenceRef: `task-interruption:${run.assignmentId}` });
      }
      return this.facade.markUnknown(taskId, reason, detail.effects.filter(effect => ['dispatching', 'unknown'].includes(effect.status)).map(effect => effect.effectId));
    });
  }
  private recoverOnOpen(): void {
    this.tx.atomic(() => {
      this.effects.recover(this.options.runtimeIdentity);
      for (const task of this.facade.list()) {
        if (['succeeded', 'failed', 'cancelled'].includes(task.state)) continue;
        // Opening a DB Worker is not proof that its old native execution stopped.
        this.markUnknown(task.taskId, 'runtime_reopened_requires_reconciliation');
      }
    });
  }
  private cancel(taskId: string, reason: string): TaskView {
    text(reason, 'reason', 500);
    return this.tx.atomic(() => {
      const detail = this.get(taskId);
      for (const effect of detail.effects) this.effects.cancel(effect.effectId, effect.version, 'task_cancel_requested');
      this.db.prepare("UPDATE shiyu_task_aux_intents SET status='cancelled' WHERE kind IN ('start','deliver') AND json_extract(value,'$.taskId')=? AND status='pending'").run(taskId);
      return this.facade.requestCancel(taskId, reason);
    });
  }
  private knownEffects(taskId: string): void {
    if (this.effectsForTask(taskId).some(effect => ['pending', 'dispatching', 'unknown'].includes(effect.status))) fail('RECONCILIATION_REQUIRED', 'Pending or uncertain effects must be reconciled first');
  }
  execute(request: TaskDomainRequest): unknown {
    this.tx.assertUsable();
    switch (request.command) {
      case 'task.createLocal': return this.createLocal(request.args);
      case 'task.list': return this.facade.list();
      case 'task.get': return this.get(request.args.taskId);
      case 'task.claimAssignment': return this.claimAssignment(request.args);
      case 'task.checkPermit': return { allowed: true, ...clone((this.checked(request.args.permit), request.args.permit)) };
      case 'task.bindAssignment': return this.tx.atomic(() => {
        const run = this.checked(request.args.permit); text(request.args.sessionId, 'sessionId', 200);
        if (run.sessionId && run.sessionId !== request.args.sessionId) fail('SESSION_BINDING_CONFLICT', 'An Assignment cannot switch native Session identity');
        if (!['claimed', 'bound'].includes(run.state)) fail('INVALID_ASSIGNMENT_STATE', 'Only a claimed Assignment can bind its Session');
        this.saveRun({ ...run, state: 'bound', sessionId: request.args.sessionId }); return this.facade.get(run.taskId);
      });
      case 'task.assignmentStarted': return this.tx.atomic(() => {
        const run = this.checked(request.args.permit);
        if (run.state !== 'bound' || !run.sessionId) fail('SESSION_NOT_BOUND', 'Persist the native Session binding before starting work');
        const task = this.facade.assignmentStarted(run.taskId, run.assignmentId); this.saveRun({ ...run, state: 'running' }); return task;
      });
      case 'task.enqueueArtifact': return this.enqueueArtifact(request.args);
      case 'task.claimEffect': {
        const { permit, effectId, leaseMs = 120000 } = request.args;
        this.checked(permit);
        return this.effects.claim({ effectId, ownerId: DISPATCHER.principalId, hostEpoch: permit.hostEpoch, installationGeneration: permit.installationGeneration,
          fencingToken: permit.fencingToken, leaseMs: Math.min(integer(leaseMs, 'leaseMs', 1, 300000), Math.max(1, Date.parse(permit.leaseExpiresAt) - this.date().getTime())) }, effect => this.authorize(permit, effect));
      }
      case 'task.assertEffect': {
        const effect = this.effects.assertDispatch(request.args.claim, value => this.authorize(request.args.permit, value));
        return { effect, payload: this.payload(effect.effectId) };
      }
      case 'task.recordArtifactReceipt': {
        this.checked(request.args.permit, false);
        if (request.args.claim.effectId !== request.args.permit.reservationId) fail('WRONG_EFFECT', 'Receipt is not for this invocation');
        const { permit, ...observation } = request.args;
        return this.observation(observation, permit.taskId, false);
      }
      case 'task.reconcileArtifactReceipt': {
        const { taskId, oldExecutionStopped, ...observation } = request.args;
        if (oldExecutionStopped !== true) fail('RECONCILIATION_REQUIRED', 'Artifact reconciliation requires evidence the old execution has stopped');
        return this.observation(observation, taskId, true);
      }
      case 'task.report': return this.report(request.args);
      case 'task.verify': return this.tx.atomic(() => {
        const before = this.facade.get(request.args.taskId);
        if (before.state === 'succeeded') return before;
        const after = this.facade.verifyCompletion(request.args.taskId);
        if (after.state === 'succeeded') this.options.onSucceeded?.(after.taskId);
        return after;
      });
      case 'task.settleUsage': return this.settleUsage(request.args);
      case 'task.reconcileUsage': return this.reconcileUsage(request.args);
      case 'task.cancel': return this.cancel(request.args.taskId, request.args.reason);
      case 'task.confirmCancelled': return this.tx.atomic(() => {
        this.local(request.args.taskId); this.knownEffects(request.args.taskId);
        const pending = this.db.prepare("SELECT id FROM shiyu_task_aux_intents WHERE kind IN ('start','deliver') AND status='pending' AND json_extract(value,'$.taskId')=? LIMIT 1").get(request.args.taskId);
        if (pending) fail('RECONCILIATION_REQUIRED', 'Execution intents are still eligible');
        const view = this.facade.confirmCancelled(request.args.taskId, request.args.proof);
        const run = this.run(request.args.proof.assignmentId); this.saveRun({ ...run, state: 'stopped' }); return view;
      });
      case 'task.markUnknown': return this.markUnknown(request.args.taskId, request.args.reason);
      case 'task.recover': return this.tx.atomic(() => {
        const detail = this.get(request.args.taskId), assignmentId = detail.task.latestAssignmentId ?? fail('UNKNOWN_ASSIGNMENT', 'Task has no assignment');
        if (!request.args.proof) return this.markUnknown(request.args.taskId, 'explicit_recovery_needs_evidence');
        this.assertRunning(); this.knownEffects(request.args.taskId);
        // Recovery may reserve only after independently settled old usage. No automatic fresh grant.
        if (detail.reservation?.state !== 'settled') fail('RECONCILIATION_REQUIRED', 'Old invocation budget must be independently settled before recovery');
        this.ownerOperation = true;
        try { return this.facade.recover(request.args.taskId, assignmentId, request.args.proof); }
        finally { this.ownerOperation = false; }
      });
      case 'task.setPaused': return this.tx.atomic(() => {
        if (typeof request.args.paused !== 'boolean') fail('INVALID_TASK_INPUT', 'paused must be boolean');
        this.db.prepare('UPDATE shiyu_task_domain_meta SET paused=? WHERE id=1').run(request.args.paused ? 1 : 0);
        if (request.args.paused) for (const task of this.facade.list()) {
          if (!task.latestAssignmentId || ['succeeded', 'failed', 'cancelled'].includes(task.state)) continue;
          const run = this.run(task.latestAssignmentId);
          if (['claimed', 'bound', 'running'].includes(run.state)) this.markUnknown(task.taskId, 'paused_execution_requires_reconciliation');
        }
        if (request.args.paused) this.corePauseObserver?.();
        return { paused: request.args.paused };
      });
    }
  }
}
