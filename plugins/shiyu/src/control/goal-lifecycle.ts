import { createHash } from 'node:crypto';
import type { LocalArtifactStore } from '../adapters/artifacts/index.js';
import type { TaskDetail } from '../adapters/control-store/task-domain.js';
import { GoalOperationUnknownError, GoalSessionAdapter } from '../adapters/dsh/goals.js';
import type { GoalAdapterOptions, GoalAuthorityContext, GoalAuthorityVerdict, GoalBinding, GoalBindingPort, GoalCompletionProof, GoalCreateRequest, GoalMutationRequest, GoalReadResult, NativeGoalRef } from '../adapters/dsh/goals.js';
import type { DshContext } from '../adapters/dsh/sessions.js';

export interface GoalLifecycleAdapter {
  initialize(): Promise<void>;
  create(request: GoalCreateRequest): Promise<GoalReadResult>;
  pause(request: GoalMutationRequest): Promise<GoalReadResult>;
  resume(request: GoalMutationRequest): Promise<GoalReadResult>;
  complete(request: GoalMutationRequest): Promise<GoalReadResult>;
  close(): Promise<void>;
}
export interface GoalLifecycleOptions {
  ctx: DshContext;
  bindings: GoalBindingPort;
  /** Trusted DB query. No caller-provided TaskDetail or JSON actor is accepted by run(). */
  taskReader(taskId: string): TaskDetail | Promise<TaskDetail>;
  artifacts: Pick<LocalArtifactStore, 'inspect' | 'prepareWorkspace'>;
  isRuntimeOpenAndUnpaused(): boolean;
  /** Trusted composition/test seam, never exposed as a model or UI argument. */
  adapterFactory?: (options: GoalAdapterOptions) => GoalLifecycleAdapter;
}
export interface GoalLifecycleRunOptions { signal: AbortSignal; progress(phase: string): void }
export type GoalLifecycleOperation = 'create' | 'pause' | 'resume' | 'complete';
export interface GoalLifecycleResult {
  verified: true;
  taskId: string;
  goalId: string;
  nativeGoalId: string;
  sessionId: string;
  nativePhase: 'complete';
  /** This service never requests inference; ancillary host activity needs its own log evidence. */
  inferenceRequested: false;
  operations: GoalLifecycleOperation[];
}
export class GoalLifecycleRecoveryRequiredError extends Error {
  readonly code = 'GOAL_LIFECYCLE_REQUIRES_RECOVERY';
  constructor(readonly goalId: string, readonly sessionId: string, readonly receiptStatus: string | undefined, cause?: unknown) {
    super('Goal lifecycle binding already exists or the run stopped; inspect and explicitly recover it without replaying the validation sequence', cause === undefined ? undefined : { cause });
    this.name = 'GoalLifecycleRecoveryRequiredError';
  }
}
export class GoalLifecycleEvidenceError extends Error {
  readonly code = 'GOAL_LIFECYCLE_EVIDENCE_INVALID';
  constructor(message: string) { super(message); this.name = 'GoalLifecycleEvidenceError'; }
}
interface Evidence { criteriaHash: string; identityHash: string; evidenceRefs: string[] }
export interface DelegatedTaskEvidence {
  goalId: string; mandateId: string; resourceRef: string; inputRefs: string[]; now: number;
}
interface RunPermit {
  taskId: string;
  goalId: string;
  signal: AbortSignal;
  evidence: Evidence;
  operation: GoalLifecycleOperation;
  expectedRef?: NativeGoalRef;
  proof?: GoalCompletionProof;
}
const OWNER = 'local-owner';
const VERIFIER = 'shiyu-goal-local-artifact-v1';
const OBJECTIVE = '独立核验已完成的识雨本地产物 Task，并验证原生 Goal 的创建、暂停、恢复和完成生命周期。';
function fail(message: string): never { throw new GoalLifecycleEvidenceError(message); }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const exact = (values: unknown, expected: string[]): boolean => Array.isArray(values) && values.length === expected.length && values.every((value, i) => value === expected[i]);
const sameRef = (left?: NativeGoalRef, right?: NativeGoalRef): boolean => Boolean(left && right && left.id === right.id && left.revision === right.revision);
const timestamp = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) <= Date.now();

/** Only the explicitly implemented single local-note completion contract is accepted. */
export function inspectTaskEvidence(detail: TaskDetail, taskId: string, delegated?: DelegatedTaskEvidence): Evidence {
  const { task, artifact, execution, reservation } = detail;
  const authorityMatches = (version: number) => delegated ? version >= task.mandateVersion : version === task.mandateVersion;
  const timestamp = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) <= (delegated?.now ?? Date.now());
  if (!task || task.taskId !== taskId || task.state !== 'succeeded' || task.stopRequested || task.uncertainty || task.activeAssignmentId
    || !exact(task.inputRefs, delegated?.inputRefs ?? [`local-input:${taskId}`])
    || delegated && (task.goalId !== delegated.goalId || task.mandateId !== delegated.mandateId)) fail('Only a completed, unambiguous local artifact Task is eligible');
  const artifactRef = `artifact:${taskId}`, result = task.result, verification = task.verification;
  if (!artifact || artifact.artifactRef !== artifactRef || !/^[a-f0-9]{64}$/.test(artifact.expectedSha256) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 || artifact.byteLength > 1024) fail('Task artifact identity or expected content is invalid');
  if (!execution || execution.assignmentId !== task.latestAssignmentId || execution.state !== 'reported'
    || !reservation || reservation.scope !== OWNER || reservation.action !== 'task.local-note.execute'
    || reservation.mandateId !== task.mandateId || !authorityMatches(reservation.mandateVersion) || !exact(reservation.resourceScopes, [delegated?.resourceRef ?? artifactRef])) fail('Task is not bound to the trusted local-owner execution');
  const check = task.completionSpec?.checks?.[0];
  if (task.completionSpec?.version !== 1 || task.completionSpec.checks.length !== 1 || check?.checkId !== 'artifact-sha256'
    || check.type !== 'artifact.sha256' || check.targetRef !== artifactRef || check.expected !== artifact.expectedSha256 || check.evidenceRequired !== true
    || result?.resultHash !== artifact.expectedSha256 || !exact(result.artifactRefs, [artifactRef]) || result.effectRefs.length !== 1) fail('Unsupported or inconsistent Task completion criteria');
  if (!Array.isArray(detail.effects) || detail.effects.some(effect => ['pending', 'dispatching', 'unknown'].includes(effect.status))) fail('The Task still has an unsettled Effect');
  const matchingEffects = detail.effects.filter(effect => effect.effectId === result.effectRefs[0]);
  if (matchingEffects.length !== 1) fail('The bounded artifact Effect must be uniquely identified');
  const effect = matchingEffects[0]!;
  if (effect.schemaVersion !== 1 || effect.effectId !== result.effectRefs[0] || effect.effectId !== reservation.reservationId || effect.status !== 'succeeded'
    || effect.action !== 'artifact.write' || effect.origin.kind !== 'task' || effect.origin.taskId !== taskId || effect.origin.assignmentId !== task.latestAssignmentId
    || !exact(effect.resourceScopes, [artifactRef]) || effect.cancelRequestedAt || !effect.receiptId || !/^[a-f0-9]{64}$/.test(effect.payloadHash)
    || effect.authorization.mandateId !== task.mandateId || effect.authorization.mandateVersion !== reservation.mandateVersion
    || effect.authorization.authEpoch !== reservation.authEpoch || effect.authorization.installationGeneration !== execution.installationGeneration) fail('Artifact Effect identity, authorization or outcome does not match the Task');
  if (!Array.isArray(detail.effectReceipts)) fail('The verified Effect receipt must be available from the trusted ledger');
  const receipts = detail.effectReceipts.filter(receipt => receipt.receiptId === effect.receiptId || receipt.effectId === effect.effectId);
  if (receipts.length !== 1) fail('The verified Effect receipt must be uniquely identified');
  const receipt = receipts[0]!, settled = receipt.verification?.settledEffect;
  if (receipt.receiptId !== effect.receiptId || receipt.effectId !== effect.effectId || receipt.externalOperationId !== effect.effectId
    || receipt.serviceId !== 'shiyu-local-artifact' || receipt.outcome !== 'succeeded' || receipt.payloadHash !== effect.payloadHash
    || !effect.currentClaim || canonical(receipt.claim) !== canonical(effect.currentClaim)
    || receipt.claim.hostEpoch !== execution.hostEpoch || receipt.claim.installationGeneration !== execution.installationGeneration || receipt.claim.fencingToken !== execution.fencingToken
    || !timestamp(receipt.observedAt) || !timestamp(receipt.receivedAt) || receipt.verification?.verified !== true
    || receipt.verification.serviceId !== receipt.serviceId || receipt.verification.externalOperationId !== effect.effectId
    || receipt.verification.installationGeneration !== execution.installationGeneration
    || !['completion', 'reconciliation'].includes(receipt.mode) || (receipt.mode === 'reconciliation' && !receipt.verification.reconciled)
    || settled?.idempotencyKey !== effect.idempotencyKey || settled.payloadHash !== effect.payloadHash || settled.outcome !== 'succeeded') fail('Artifact receipt does not prove this settled Effect');
  const observationRef = `artifact-observation:${receipt.receiptId}`, verificationCheck = verification?.checks?.[0];
  if (!exact(receipt.evidenceRefs, [observationRef, artifactRef])
    || verification?.taskId !== taskId || verification.assignmentId !== execution.assignmentId || verification.completionSpecVersion !== task.completionSpec.version
    || verification.resultHash !== artifact.expectedSha256 || verification.verifierVersion !== 'local-artifact-sha256-v1' || !timestamp(verification.verifiedAt)
    || verification.checks.length !== 1 || verificationCheck?.checkId !== check.checkId || verificationCheck.status !== 'pass'
    || !exact(verificationCheck.evidenceRefs, [observationRef, artifactRef])) fail('Independent Task verification is missing or does not cover the Effect receipt');
  const criteria = { kind: 'shiyu-local-artifact-goal-validation', version: 1, taskId, scope: OWNER, artifact, completionSpec: task.completionSpec };
  return {
    criteriaHash: hash(criteria),
    identityHash: hash({ criteria, taskVersion: task.version, latestAssignmentId: task.latestAssignmentId, result, verification, effect, receipt,
      scope: reservation.scope, mandateId: reservation.mandateId, mandateVersion: reservation.mandateVersion, authEpoch: reservation.authEpoch }),
    evidenceRefs: [artifactRef, observationRef, `effect-receipt:${receipt.receiptId}`],
  };
}

/** Runs a bounded native lifecycle check. No model prompt, followup or model loop exists here. */
export class LocalGoalLifecycleService {
  private readonly adapter: GoalLifecycleAdapter;
  private readonly capabilities = new WeakMap<object, RunPermit>();
  private readonly active = new Map<string, Promise<GoalLifecycleResult>>();
  private readonly shutdown = new AbortController();
  private initialized?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly options: GoalLifecycleOptions) {
    this.adapter = (options.adapterFactory ?? (value => new GoalSessionAdapter(value)))({ ctx: options.ctx, bindings: options.bindings,
      authority: { authorize: (capability, context) => this.authorize(capability, context) } });
  }
  private gate(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.closed) throw new Error('Goal lifecycle service is closed');
    if (this.options.isRuntimeOpenAndUnpaused() !== true) throw new Error('Goal lifecycle requires an open, unpaused runtime');
  }
  async initialize(): Promise<void> {
    if (this.closed) throw new Error('Goal lifecycle service is closed');
    return this.initialized ??= this.adapter.initialize();
  }
  private async evidence(taskId: string, signal: AbortSignal, expected?: Evidence): Promise<Evidence> {
    this.gate(signal);
    const detail = structuredClone(await this.options.taskReader(taskId)); this.gate(signal);
    const before = inspectTaskEvidence(detail, taskId);
    if (expected && (before.criteriaHash !== expected.criteriaHash || before.identityHash !== expected.identityHash)) fail('Task completion evidence changed during Goal validation');
    const observed = await this.options.artifacts.inspect({ taskId, expectedSha256: detail.artifact.expectedSha256 }); this.gate(signal);
    if (!observed || observed.artifactRef !== detail.artifact.artifactRef || observed.sha256 !== detail.artifact.expectedSha256 || observed.byteLength !== detail.artifact.byteLength || !timestamp(observed.observedAt)) fail('Actual local artifact does not match its completed Task and receipt');
    const after = inspectTaskEvidence(structuredClone(await this.options.taskReader(taskId)), taskId); this.gate(signal);
    if (after.identityHash !== before.identityHash) fail('Task or Effect evidence changed while reading the actual artifact');
    return after;
  }
  private async authorize(capability: object, context: Readonly<GoalAuthorityContext>): Promise<GoalAuthorityVerdict> {
    const run = this.capabilities.get(capability);
    if (!run || context.goalId !== run.goalId || context.ownerId !== OWNER || context.scope !== OWNER || context.completionCriteriaHash !== run.evidence.criteriaHash
      || context.operation !== run.operation || (run.operation !== 'create' && !sameRef(context.expectedRef, run.expectedRef))) return { allowed: false };
    this.gate(run.signal);
    const evidence = await this.evidence(run.taskId, run.signal, run.evidence); this.gate(run.signal);
    if (run.operation === 'complete') {
      // Both native-adapter authorization checks independently read the file,
      // while the proof identity (including its first observation time) stays
      // fixed for the durable pending receipt.
      run.proof ??= { goalRef: { ...run.expectedRef! }, completionCriteriaHash: evidence.criteriaHash, evidenceRefs: evidence.evidenceRefs, verifierId: VERIFIER, verifiedAt: new Date().toISOString() };
    }
    return { allowed: true, kind: 'owner', ownerId: OWNER, scope: OWNER, expiresAt: new Date(Date.now() + 60000).toISOString(), ...(run.proof ? { completion: structuredClone(run.proof) } : {}) };
  }
  async run(taskId: string, options: GoalLifecycleRunOptions): Promise<GoalLifecycleResult> {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) fail('Invalid local Task identity');
    if (!(options?.signal instanceof AbortSignal) || typeof options.progress !== 'function') throw new Error('Goal lifecycle needs cancellation and progress ports');
    const signal = AbortSignal.any([options.signal, this.shutdown.signal, AbortSignal.timeout(120000)]); this.gate(signal);
    if (this.active.has(taskId)) throw new Error('Goal lifecycle validation is already running for this Task');
    const work = this.execute(taskId, signal, options.progress); this.active.set(taskId, work);
    try { return await work; } finally { if (this.active.get(taskId) === work) this.active.delete(taskId); }
  }
  private accepted(value: GoalReadResult, run: RunPermit, previous?: GoalReadResult): GoalReadResult {
    this.gate(run.signal);
    const native = value.native, binding = value.binding;
    const phase = run.operation === 'pause' ? 'paused' : run.operation === 'complete' ? 'complete' : 'active';
    if (!native || native.phase !== phase || native.activation !== 'disarmed' || !Number.isSafeInteger(native.revision) || native.revision < 1
      || binding.goalId !== run.goalId || binding.ownerId !== OWNER || binding.scope !== OWNER || binding.completionCriteriaHash !== run.evidence.criteriaHash
      || !binding.sessionId || !native.id || !sameRef(binding.goalRef, native) || binding.receipt?.status !== 'confirmed'
      || binding.receipt.operation !== run.operation || binding.receipt.commandId !== `${run.goalId}:${run.operation}:v1` || !sameRef(binding.receipt.observedRef, native)
      || (!previous && native.revision !== 1)
      || (previous && (binding.sessionId !== previous.binding.sessionId || native.id !== previous.native!.id || native.revision !== previous.native!.revision + 1))) fail('Native Goal lifecycle result was not independently confirmed');
    return value;
  }
  private async execute(taskId: string, signal: AbortSignal, progress: GoalLifecycleRunOptions['progress']): Promise<GoalLifecycleResult> {
    const goalId = `artifact-validation:${taskId}`, capability = Object.freeze({});
    let knownBinding: GoalBinding | undefined;
    try {
      const existing = await this.options.bindings.load(goalId); this.gate(signal);
      if (existing) throw new GoalLifecycleRecoveryRequiredError(goalId, existing.sessionId, existing.receipt?.status);
      progress('独立核对已完成任务、产物与效果回执');
      const evidence = await this.evidence(taskId, signal);
      const cwd = await this.options.artifacts.prepareWorkspace(taskId); this.gate(signal);
      await this.initialize(); this.gate(signal);
      const run: RunPermit = { taskId, goalId, signal, evidence, operation: 'create' }; this.capabilities.set(capability, run);
      const operations: GoalLifecycleOperation[] = [];
      progress('创建受限原生 Goal'); this.gate(signal);
      let result = this.accepted(await this.adapter.create({ goalId, ownerId: OWNER, scope: OWNER, cwd, completionCriteriaHash: evidence.criteriaHash,
        objective: OBJECTIVE, maxGoalRounds: 1, commandId: `${goalId}:create:v1`, capability, signal }), run);
      knownBinding = result.binding; operations.push('create');
      for (const operation of ['pause', 'resume', 'complete'] as const) {
        run.operation = operation; run.expectedRef = { id: result.native!.id, revision: result.native!.revision };
        progress(operation === 'pause' ? '暂停原生 Goal' : operation === 'resume' ? '恢复原生 Goal 并保持停止执行' : '重新读取产物并提交独立完成证明'); this.gate(signal);
        result = this.accepted(await this.adapter[operation]({ goalId, expectedRef: run.expectedRef, commandId: `${goalId}:${operation}:v1`, capability, signal }), run, result);
        knownBinding = result.binding; operations.push(operation);
      }
      await this.evidence(taskId, signal, evidence); this.gate(signal);
      progress('原生 Goal 生命周期与本地产物完成证明均已核对'); this.gate(signal);
      return { verified: true, taskId, goalId, nativeGoalId: result.native!.id, sessionId: result.binding.sessionId, nativePhase: 'complete', inferenceRequested: false, operations };
    } catch (error) {
      if (error instanceof GoalOperationUnknownError || error instanceof GoalLifecycleRecoveryRequiredError) throw error;
      // No compensating lifecycle writes: an interrupted check is not permission
      // to clear, replay, complete or roll back a native Goal.
      try { knownBinding = await this.options.bindings.load(goalId) ?? knownBinding; } catch { /* Preserve the original failure and any already observed binding. */ }
      if (knownBinding) throw new GoalLifecycleRecoveryRequiredError(goalId, knownBinding.sessionId, knownBinding.receipt?.status, error);
      throw error;
    } finally { this.capabilities.delete(capability); }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.shutdown.abort(new Error('Goal lifecycle service is closed'));
    this.closing = (async () => {
      // Native close fences late creation before waiting for active operations.
      const closing = this.adapter.close();
      const results = await Promise.allSettled([closing, ...this.active.values()]);
      const nativeClose = results[0]; if (nativeClose?.status === 'rejected') throw nativeClose.reason;
    })(); return this.closing;
  }
}
