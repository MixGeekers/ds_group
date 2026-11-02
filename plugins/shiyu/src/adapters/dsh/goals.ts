import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { defaultModel } from './sessions.js';
import { pinOwnedSessionTitle } from './session-title.js';
import type { DshAgent, DshAgentContext, DshAgentHandle, DshContext } from './sessions.js';
import type { NativeMessageFactory } from './native-message.js';
import { coldNativeInboxSnapshot, extendNativeHistorySnapshot, nativeInboxReferences, observeNativeBaseline, assertNativeLiveHistory, type NativeColdInboxSnapshot } from './native-context.js';
import { CoreDecisionRun, validateCoreDecisionRequest, type CoreDecisionRequest, type CoreDecisionResult, type CoreDecisionPhase } from './core-decision.js';
export type { CoreDecisionRequest, CoreDecisionResult, CoreDecisionBinding, CoreDecisionAccounting, CoreDecisionMessageRef, CoreDecisionPhase } from './core-decision.js';

type Disposer = () => void | Promise<void>;
export interface NativeGoalRef { id: string; revision: number }
export interface NativeGoalView extends NativeGoalRef {
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  maxGoalRounds: number;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  activation: 'armed' | 'disarmed';
  blockedReason?: { code: string; message: string };
}
export type GoalWriteOperation = 'create' | 'update' | 'pause' | 'resume' | 'complete';
export interface GoalCommandReceipt {
  commandId: string;
  operation: GoalWriteOperation;
  status: 'pending' | 'unknown' | 'confirmed' | 'rejected';
  expectedRef?: NativeGoalRef;
  /** Hash of an intended native postcondition; this is not a stored Goal phase. */
  postconditionHash: string;
  observedRef?: NativeGoalRef;
  evidenceRefs?: string[];
  /** Evidence identity received from the trusted authority before native complete. */
  completionProof?: GoalCompletionProof;
  reason?: string;
}
/** References and cross-store command facts only. The native Session owns Goal state. */
export interface GoalBinding {
  goalId: string;
  sessionId: string;
  ownerId: string;
  scope: string;
  cwd: string;
  completionCriteriaHash: string;
  metadataVersion: number;
  goalRef?: NativeGoalRef;
  receipt?: GoalCommandReceipt;
}
export interface GoalBindingPort {
  load(goalId: string): Promise<GoalBinding | undefined>;
  loadCommand(goalId: string, commandId: string): Promise<GoalCommandReceipt | undefined>;
  /**
   * Durable atomic binding CAS plus receipt history. undefined requires no
   * binding. Existing command identity must never change; only its receipt
   * status/observedRef/reason may advance. Ownership and Session identity stay
   * fixed. A historical command cannot become a new current command.
   */
  compareAndSet(expectedMetadataVersion: number | undefined, binding: GoalBinding): Promise<void>;
}
export interface GoalCompletionProof {
  goalRef: NativeGoalRef;
  completionCriteriaHash: string;
  evidenceRefs: string[];
  verifierId: string;
  verifiedAt: string;
}
export interface GoalAuthorityContext {
  operation: GoalWriteOperation | 'read' | 'recover' | 'decision';
  goalId: string;
  ownerId: string;
  scope: string;
  completionCriteriaHash: string;
  expectedRef?: NativeGoalRef;
  changes?: { objective?: string; maxGoalRounds?: number };
  /** Trusted decision admission identity; never populated from generated text. */
  roundId?: string;
  phase?: CoreDecisionPhase;
}
export type GoalAuthorityVerdict = { allowed: false; reason?: string } | {
  allowed: true;
  kind: 'owner' | 'mandate';
  ownerId: string;
  scope: string;
  expiresAt: string;
  mandateId?: string;
  mandateVersion?: number;
  authEpoch?: number;
  /** Produced by an independent trusted verifier, never accepted from model text. */
  completion?: GoalCompletionProof;
};
export interface GoalAuthority {
  /** Authenticate the opaque capability and current policy; a JSON 'trusted' flag is not a capability. */
  authorize(capability: object, context: Readonly<GoalAuthorityContext>): GoalAuthorityVerdict | Promise<GoalAuthorityVerdict>;
}
export interface GoalCreateRequest {
  goalId: string;
  ownerId: string;
  scope: string;
  cwd: string;
  completionCriteriaHash: string;
  objective: string;
  maxGoalRounds?: number;
  commandId: string;
  capability: object;
  signal?: AbortSignal;
}
export interface GoalMutationRequest { goalId: string; expectedRef: NativeGoalRef; commandId: string; capability: object; signal?: AbortSignal }
export interface GoalReadResult { binding: GoalBinding; native: NativeGoalView | undefined }
export interface GoalRecoveryResult extends GoalReadResult { reconciliation: 'consistent' | 'confirmed' | 'not_observed' | 'conflict' }
export class GoalOperationUnknownError extends Error {
  readonly code = 'GOAL_OPERATION_UNKNOWN';
  constructor(readonly binding: GoalBinding, cause: unknown) { super('Native Goal outcome requires reconciliation; the command was not replayed', { cause }); this.name = 'GoalOperationUnknownError'; }
}
interface NativeGoals {
  get(agent: DshAgent): NativeGoalView | undefined;
  create(agent: DshAgent, request: { objective: string; maxGoalRounds: number }): NativeGoalView;
  edit(agent: DshAgent, ref: NativeGoalRef, changes: { objective?: string; maxGoalRounds?: number }): NativeGoalView;
  pause(agent: DshAgent, ref: NativeGoalRef): NativeGoalView;
  resume(agent: DshAgent, ref: NativeGoalRef): NativeGoalView;
  complete(agent: DshAgent, ref: NativeGoalRef): NativeGoalView;
  disarm(agent: DshAgent): NativeGoalView | undefined;
}
interface SessionOwner { creation?: Promise<DshAgentHandle>; handle?: DshAgentHandle; disposers: Disposer[]; release?: Promise<void>; decision?: CoreDecisionRun }
export interface GoalAdapterOptions {
  ctx: DshContext; bindings: GoalBindingPort; authority: GoalAuthority; now?: () => number;
  /** Trusted composition only. Core lifecycle and decisions must share this one adapter instance. */
  namespace?: 'lifecycle' | 'core';
  createUserMessage?: NativeMessageFactory;
  /** Trusted test injection; production loads the host's public WeakSet-backed predicate. */
  isAgentLoopRequest?: (request: unknown) => boolean;
}
export const GOAL_PRESET_ID = 'shiyu-runtime-goal-v1';
export const CORE_GOAL_PRESET_ID = 'shiyu-runtime-core-goal-v1';
const PREFIX = 'shiyu-goal-';
const CORE_PREFIX = 'shiyu-core-goal-';

function text(value: unknown, name: string, limit = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${name}`); return value;
}
function integer(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`); return value;
}
function ref(value: NativeGoalRef): NativeGoalRef { return { id: text(value?.id, 'native Goal id'), revision: integer(value?.revision, 'native Goal revision') }; }
function sameRef(a?: NativeGoalRef, b?: NativeGoalRef): boolean { return a?.id === b?.id && a?.revision === b?.revision; }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function sessionId(binding: Pick<GoalBinding, 'goalId' | 'ownerId' | 'scope'>, prefix = PREFIX): string { return prefix + digest([binding.goalId, binding.ownerId, binding.scope]); }
function postcondition(value: Pick<NativeGoalView, 'objective' | 'maxGoalRounds' | 'phase' | 'revision'>): string { return digest([value.objective, value.maxGoalRounds, value.phase, value.revision]); }
/** Stable command identity for the durable port; excludes reconciliation status. */
export function goalCommandIdentity(receipt: GoalCommandReceipt): string {
  const expected = receipt.expectedRef;
  return digest([receipt.commandId, receipt.operation, expected ? [expected.id, expected.revision] : null, receipt.postconditionHash,
    receipt.evidenceRefs ?? null, receipt.completionProof ? proofIdentity(receipt.completionProof) : null]);
}
function proofMatches(proof: GoalCompletionProof | undefined, binding: GoalBinding, expectedRef: NativeGoalRef | undefined, now: number): proof is GoalCompletionProof {
  return Boolean(proof && expectedRef && sameRef(proof.goalRef, expectedRef) && proof.completionCriteriaHash === binding.completionCriteriaHash
    && Array.isArray(proof.evidenceRefs) && proof.evidenceRefs.length > 0 && proof.evidenceRefs.length <= 64
    && proof.evidenceRefs.every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048)
    && typeof proof.verifierId === 'string' && proof.verifierId.trim().length > 0 && proof.verifierId.length <= 2048
    && Number.isFinite(Date.parse(proof.verifiedAt)) && Date.parse(proof.verifiedAt) <= now);
}
function proofIdentity(proof: GoalCompletionProof): string { return digest([proof.goalRef.id, proof.goalRef.revision, proof.completionCriteriaHash, proof.evidenceRefs, proof.verifierId, proof.verifiedAt]); }
function snapshot(value: NativeGoalView | undefined): NativeGoalView | undefined {
  if (value === undefined) return undefined;
  ref(value); text(value.objective, 'native Goal objective', 64000); integer(value.maxGoalRounds, 'native round limit');
  if (!['active', 'paused', 'blocked', 'complete'].includes(value.phase) || !['armed', 'disarmed'].includes(value.activation)) throw new Error('Unsupported native Goal view');
  return structuredClone(value);
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }

/** A native Goal lifecycle seam. It never schedules rounds or stores a second Goal state. */
export class GoalSessionAdapter {
  private initialized?: Promise<void>;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly owners = new Set<SessionOwner>();
  private readonly composed = new WeakSet<DshAgent>();
  private readonly cleanupFailures: unknown[] = [];
  private presetDispose?: Disposer;
  private createdDispose?: Disposer;
  private streamDispose?: Disposer;
  private readonly decisionRuns = new Map<string, CoreDecisionRun>();
  private readonly decisionIds = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly shutdown = new AbortController();
  constructor(private readonly options: GoalAdapterOptions) {
    if (options.namespace !== undefined && !['lifecycle', 'core'].includes(options.namespace)) throw new Error('Unsupported Goal namespace');
  }
  private get core(): boolean { return this.options.namespace === 'core'; }
  private get prefix(): string { return this.core ? CORE_PREFIX : PREFIX; }
  private get preset(): string { return this.core ? CORE_GOAL_PRESET_ID : GOAL_PRESET_ID; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private assertOpen(): void { if (this.closed) throw new Error('Goal adapter is closed'); }
  private goals(): NativeGoals { return this.options.ctx.get('goals'); }
  async initialize(): Promise<void> {
    this.assertOpen();
    return this.initialized ??= (async () => {
      const { ctx } = this.options, goals = this.goals(), presets = ctx.get('agentPresets');
      if (!goals || ['get', 'create', 'edit', 'pause', 'resume', 'complete', 'disarm'].some(name => typeof (goals as any)[name] !== 'function') || !ctx.get('sessionProjections') || !ctx.get('sessionPersistence') || typeof ctx.get('sessions')?.flush !== 'function' || typeof presets?.register !== 'function') throw new Error('Required native Goal, projection, persistence, flush and preset services are unavailable');
      this.presetDispose = await presets.register({ id: this.preset, name: this.core ? '识雨受限目标规划' : '识雨目标权威会话', description: 'Shiyu owns lifecycle and all execution admission; default deny.', plugins: [] });
      this.assertOpen();
      if (this.core) this.streamDispose = ctx.on('llm/stream', (request, next) => {
        if (typeof request?.sessionId !== 'string' || !request.sessionId.startsWith(this.prefix)) return next();
        const run = this.decisionRuns.get(request.sessionId);
        if (!run) throw new Error('Core Goal Session has no admitted model call');
        return run.stream(request, next);
      });
      this.createdDispose = ctx.on('agent/created', ({ agent }: { agent: DshAgent }) => this.protectResumed(agent));
      for (const agent of ctx.agents.list()) this.protectResumed(agent);
    })();
  }
  private protectResumed(agent: DshAgent): void {
    if (this.composed.has(agent) || (!agent.id.startsWith(this.prefix) && agent.session.header.agentPreset !== this.preset)) return;
    agent.ctx.tools.guard(() => 'Managed Goal Session cannot execute directly.');
    agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }));
    agent.cancel({ kind: 'hook', reason: 'Managed Goal activation rejected' }, this.core ? { keepInbox: true } : undefined);
    throw new Error('Managed Goal Session must be recovered by Shiyu');
  }
  private serial<T>(goalId: string, work: () => Promise<T>, settleAfterClose = false): Promise<T> {
    text(goalId, 'goalId'); this.assertOpen();
    const pending = (this.locks.get(goalId) ?? Promise.resolve()).catch(() => {}).then(() => { if (!settleAfterClose) this.assertOpen(); return work(); });
    this.locks.set(goalId, pending);
    void pending.finally(() => { if (this.locks.get(goalId) === pending) this.locks.delete(goalId); }).catch(() => {});
    return pending;
  }
  private async load(goalId: string): Promise<GoalBinding> {
    const value = await this.options.bindings.load(goalId);
    if (!value) throw new Error('Goal binding not found');
    if (value.goalId !== goalId || value.sessionId !== sessionId(value, this.prefix) || !isAbsolute(value.cwd) || value.cwd !== resolve(value.cwd) || !/^[a-f0-9]{64}$/.test(value.completionCriteriaHash)) throw new Error('Invalid Goal binding');
    integer(value.metadataVersion, 'binding version'); text(value.ownerId, 'ownerId'); text(value.scope, 'scope'); if (value.goalRef) ref(value.goalRef);
    return structuredClone(value);
  }
  private async save(binding: GoalBinding, patch: Partial<GoalBinding>): Promise<GoalBinding> {
    const next = { ...binding, ...structuredClone(patch), metadataVersion: binding.metadataVersion + 1 };
    await this.options.bindings.compareAndSet(binding.metadataVersion, next); return next;
  }
  private async authorize(binding: GoalBinding, capability: object, operation: GoalAuthorityContext['operation'], expectedRef?: NativeGoalRef, changes?: GoalAuthorityContext['changes'], decision?: { roundId: string; phase: CoreDecisionPhase }): Promise<Extract<GoalAuthorityVerdict, { allowed: true }>> {
    this.assertOpen();
    if (!capability || typeof capability !== 'object') throw new Error('Trusted Goal capability is required');
    const context = Object.freeze({ operation, goalId: binding.goalId, ownerId: binding.ownerId, scope: binding.scope, completionCriteriaHash: binding.completionCriteriaHash, ...(expectedRef ? { expectedRef: Object.freeze(ref(expectedRef)) } : {}), ...(changes ? { changes: Object.freeze({ ...changes }) } : {}), ...decision });
    const verdict = await this.options.authority.authorize(capability, context); this.assertOpen();
    if (!verdict || verdict.allowed !== true || verdict.ownerId !== binding.ownerId || verdict.scope !== binding.scope || !['owner', 'mandate'].includes(verdict.kind) || !Number.isFinite(Date.parse(verdict.expiresAt)) || Date.parse(verdict.expiresAt) <= this.now()) throw new Error('Goal capability denied or expired');
    if (verdict.kind === 'mandate') { text(verdict.mandateId, 'mandateId'); integer(verdict.mandateVersion, 'mandateVersion'); integer(verdict.authEpoch, 'authEpoch'); }
    if (operation === 'resume' && verdict.kind !== 'owner') throw new Error('Only the trusted owner may resume a stopped Goal');
    if (operation === 'complete') {
      const proof = verdict.completion;
      if (!proofMatches(proof, binding, expectedRef, this.now())) throw new Error('Independent Goal completion evidence is required');
    }
    return structuredClone(verdict);
  }
  private compose(owner: SessionOwner, binding: GoalBinding, ctx: DshAgentContext, agent: DshAgent): void {
    if (agent.id !== binding.sessionId || agent.session.header.agentPreset !== this.preset || agent.session.header.cwd !== binding.cwd) throw new Error('Native Goal Session binding mismatch');
    this.composed.add(agent);
    owner.disposers.push(ctx.tools.presentAs('native'));
    const denied = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name !== 'run_code');
    if (denied.length) owner.disposers.push(ctx.tools.restrict({ deny: denied }));
    owner.disposers.push(ctx.tools.guard(() => 'Goal lifecycle Sessions have no model tools.'));
    if (owner.decision) owner.decision.compose(ctx, agent, owner.disposers);
    else {
      owner.disposers.push(ctx.on('agent/pre-step', async () => ({ kind: 'reject' })));
      owner.disposers.push(ctx.on('agent/request', async () => { throw new Error('Goal lifecycle Session cannot issue model requests'); }));
    }
    owner.disposers.push(ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), tools: [] })));
  }
  /**
   * Core recovery keeps the exact pre-resume cut, re-observes the resumed live
   * Session inside the host's maintenance phase, binds the fixed title append,
   * and rechecks that baseline before handing control to the caller. Lifecycle
   * (no-inference) operations keep their previous semantics.
   */
  private async withNative<T>(binding: GoalBinding, create: boolean, run: (agent: DshAgent, baseline: NativeColdInboxSnapshot | undefined) => Promise<T>, signal?: AbortSignal, decision?: CoreDecisionRun): Promise<T> {
    const nativeSignal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    nativeSignal.throwIfAborted();
    await this.initialize();
    if (this.core && this.cleanupFailures.length) throw new Error('Core native cleanup is unresolved; another Session activation is forbidden');
    let baseline: NativeColdInboxSnapshot | undefined;
    if (this.core && !create) {
      baseline = await coldNativeInboxSnapshot(this.options.ctx, binding.sessionId, this.preset, nativeSignal,
        decision ? { deadlineAtMs: decision.deadlineAtMs } : {});
      if (baseline.references.length) throw new Error('Unknown native inbox blocks Core Goal recovery');
    }
    const owner: SessionOwner = { disposers: [], decision }; this.owners.add(owner);
    try {
      const shared = { agentOptions: { ...defaultModel('core'), maxTokens: decision?.maxTokens ?? 1 }, signal: nativeSignal, setup: (ctx: DshAgentContext, agent: DshAgent) => this.compose(owner, binding, ctx, agent) };
      owner.creation = create ? this.options.ctx.agents.create({ ...shared, sessionId: binding.sessionId, meta: { cwd: binding.cwd, agentPreset: this.preset } }) : this.options.ctx.agents.resume({ ...shared, resumeSessionId: binding.sessionId });
      owner.handle = await owner.creation; this.assertOpen(); nativeSignal.throwIfAborted();
      // Native recovery is disarmed; explicitly fence this exact owner as well.
      this.goals().disarm(owner.handle.agent);
      if (this.core && nativeInboxReferences(owner.handle.agent.inbox).length) throw new Error('Unknown native inbox blocks Core Goal activation');
      if (this.core) {
        const agent = owner.handle.agent;
        baseline = await observeNativeBaseline(this.options.ctx, agent, this.preset, {
          ...(baseline === undefined ? {} : { expectedPrefix: baseline }),
          ...(decision === undefined ? {} : { deadlineAtMs: decision.deadlineAtMs }),
          signal: nativeSignal,
        });
        if (baseline.references.length) throw new Error('Unknown native inbox blocks Core Goal activation');
        assertNativeLiveHistory(this.options.ctx, agent.session, baseline, agent.inbox);
      }
      await pinOwnedSessionTitle(this.options.ctx, owner.handle.agent.session, this.core ? '识雨 · 受限目标规划' : '识雨目标权威会话');
      this.assertOpen(); nativeSignal.throwIfAborted();
      if (this.core) baseline = await this.bindCoreTitleAppend(owner.handle.agent, baseline!, nativeSignal);
      return await run(owner.handle.agent, baseline);
    } finally { await this.release(owner); }
  }
  /** A fixed title is a legitimate write; it must extend the observed cut by exactly its event. */
  private async bindCoreTitleAppend(agent: DshAgent, baseline: NativeColdInboxSnapshot, signal: AbortSignal): Promise<NativeColdInboxSnapshot> {
    const title = '识雨 · 受限目标规划';
    const snapshot = this.options.ctx.get('sessionTitle').get(agent.session);
    if (!snapshot || snapshot.title !== title || snapshot.source?.kind !== 'user'
      || !Array.isArray(snapshot.messageSeqs) || snapshot.messageSeqs.length) throw new Error('Native Goal Session title pin could not be read back after its fixed append');
    if (Number.isSafeInteger(snapshot.eventSeq) && snapshot.eventSeq! >= baseline.eventCount) {
      if (snapshot.eventSeq !== baseline.eventCount) throw new Error('Native Goal fixed title did not extend the observed history by exactly one event');
      const next = await extendNativeHistorySnapshot(this.options.ctx, baseline, {
        seq: snapshot.eventSeq as number,
        validate: event => event.type === 'session/title' && event.data?.title === title
          && event.data?.source?.kind === 'user' && Array.isArray(event.data?.messageSeqs) && event.data.messageSeqs.length === 0,
      }, this.preset, { signal });
      assertNativeLiveHistory(this.options.ctx, agent.session, next, agent.inbox);
      return next;
    }
    // No title append: the observed cut and the live watermark must still agree.
    assertNativeLiveHistory(this.options.ctx, agent.session, baseline, agent.inbox);
    return baseline;
  }
  private async release(owner: SessionOwner): Promise<void> {
    return owner.release ??= (async () => {
      const handle = owner.handle ?? await owner.creation?.catch(() => undefined);
      const failures: unknown[] = []; let disposed = !handle;
      if (handle) {
        try { this.goals().disarm(handle.agent); } catch (error) { failures.push(error); }
        try {
          if (this.core && (owner.decision?.unknownInbox || nativeInboxReferences(handle.agent.inbox).length)) throw new Error('Unknown Core Goal inbox must be preserved');
          handle.agent.cancel({ kind: 'hook', reason: 'Goal operation released' }, this.core ? { keepInbox: true } : undefined);
          if (this.core && (owner.decision?.unknownInbox || nativeInboxReferences(handle.agent.inbox).length)) throw new Error('Core Goal inbox changed during cancellation');
          owner.decision?.releasing(); await handle.dispose(); disposed = true;
        } catch (error) { failures.push(error); }
      }
      if (disposed) {
        for (const dispose of owner.disposers.splice(0).reverse()) { try { await dispose(); } catch (error) { failures.push(error); } }
        this.owners.delete(owner);
      }
      if (failures.length) throw new AggregateError(failures, 'Native Goal Session release failed');
    })().catch(error => { this.cleanupFailures.push(error); throw error; });
  }
  private async flushRead(agent: DshAgent): Promise<NativeGoalView | undefined> {
    if (await this.options.ctx.get('sessions').flush(agent.session) !== true) throw new Error('Native Goal durability listener is absent');
    this.assertOpen(); return snapshot(this.goals().get(agent));
  }
  private async unknown(binding: GoalBinding, cause: unknown): Promise<never> {
    const receipt = binding.receipt!;
    try { binding = await this.save(binding, { receipt: { ...receipt, status: 'unknown', reason: errorText(cause) } }); } catch { /* The pending durable receipt remains the recovery fence. */ }
    throw new GoalOperationUnknownError(structuredClone(binding), cause);
  }
  async create(request: GoalCreateRequest): Promise<GoalReadResult> {
    return this.serial(request.goalId, async () => {
      request.signal?.throwIfAborted();
      const objective = text(request.objective, 'objective', 64000).trim(), maxGoalRounds = integer(request.maxGoalRounds ?? 32, 'maxGoalRounds', 256);
      if (!isAbsolute(request.cwd) || !/^[a-f0-9]{64}$/.test(request.completionCriteriaHash)) throw new Error('Invalid Goal cwd or completion criteria hash');
      let binding: GoalBinding = { goalId: text(request.goalId, 'goalId'), sessionId: '', ownerId: text(request.ownerId, 'ownerId'), scope: text(request.scope, 'scope'), cwd: resolve(request.cwd), completionCriteriaHash: request.completionCriteriaHash, metadataVersion: 1,
        receipt: { commandId: text(request.commandId, 'commandId'), operation: 'create', status: 'pending', postconditionHash: postcondition({ objective, maxGoalRounds, phase: 'active', revision: 1 }) } };
      binding.sessionId = sessionId(binding, this.prefix);
      await this.authorize(binding, request.capability, 'create', undefined, { objective, maxGoalRounds });
      if (await this.options.bindings.load(binding.goalId)) throw new Error('Goal binding already exists; recover instead of replaying create');
      if (await this.options.bindings.loadCommand(binding.goalId, request.commandId)) throw new Error('Goal commandId was already accepted; read or recover instead of replaying');
      await this.options.bindings.compareAndSet(undefined, structuredClone(binding));
      try {
        return await this.withNative(binding, true, async agent => {
          await this.authorize(binding, request.capability, 'create', undefined, { objective, maxGoalRounds });
          request.signal?.throwIfAborted();
          // Keep these synchronous: create arms, disarm must precede the driver's awaited checkpoint.
          try { this.goals().create(agent, { objective, maxGoalRounds }); }
          finally { this.goals().disarm(agent); }
          const native = await this.flushRead(agent);
          request.signal?.throwIfAborted();
          if (!native || postcondition(native) !== binding.receipt!.postconditionHash || native.activation !== 'disarmed') throw new Error('Native Goal create read-back mismatch');
          binding = await this.save(binding, { goalRef: ref(native), receipt: { ...binding.receipt!, status: 'confirmed', observedRef: ref(native) } });
          return { binding, native };
        }, request.signal);
      } catch (error) { return this.unknown(binding, error); }
    });
  }
  async read(goalId: string, capability: object): Promise<GoalReadResult> {
    return this.serial(goalId, async () => {
      const binding = await this.load(goalId); await this.authorize(binding, capability, 'read');
      // Opening an exact restricted native Agent is necessary: cold wire projection hides replay failures.
      return this.withNative(binding, false, async agent => { await this.authorize(binding, capability, 'read'); return { binding, native: snapshot(this.goals().get(agent)) }; });
    });
  }
  async update(request: GoalMutationRequest & { objective?: string; maxGoalRounds?: number }): Promise<GoalReadResult> {
    const changes = { ...(request.objective === undefined ? {} : { objective: text(request.objective, 'objective', 64000).trim() }), ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: integer(request.maxGoalRounds, 'maxGoalRounds', 256) }) };
    if (!Object.keys(changes).length) throw new Error('Goal update requires a replacement field');
    return this.mutate('update', request, changes);
  }
  async pause(request: GoalMutationRequest): Promise<GoalReadResult> { return this.mutate('pause', request); }
  async resume(request: GoalMutationRequest): Promise<GoalReadResult> { return this.mutate('resume', request); }
  async complete(request: GoalMutationRequest): Promise<GoalReadResult> { return this.mutate('complete', request); }
  private mutate(operation: Exclude<GoalWriteOperation, 'create'>, request: GoalMutationRequest, changes?: GoalAuthorityContext['changes']): Promise<GoalReadResult> {
    return this.serial(request.goalId, async () => {
      request.signal?.throwIfAborted();
      let binding = await this.load(request.goalId); const expectedRef = ref(request.expectedRef); text(request.commandId, 'commandId');
      if (binding.receipt && ['pending', 'unknown'].includes(binding.receipt.status)) throw new Error('Unresolved Goal command requires recovery');
      const entryGrant = await this.authorize(binding, request.capability, operation, expectedRef, changes);
      if (await this.options.bindings.loadCommand(binding.goalId, request.commandId)) throw new Error('Goal commandId was already accepted; read or recover instead of replaying');
      let invoked = false;
      try { return await this.withNative(binding, false, async agent => {
        const before = snapshot(this.goals().get(agent));
        if (!before || !sameRef(before, expectedRef) || !sameRef(binding.goalRef, expectedRef)) throw new Error('Stale Goal revision; read and reconcile before writing');
        const phase = operation === 'update' ? before.phase : operation === 'pause' ? 'paused' : operation === 'resume' ? 'active' : 'complete';
        const intended = { ...before, ...changes, phase, revision: before.revision + 1 };
        binding = await this.save(binding, { receipt: { commandId: request.commandId, operation, status: 'pending', expectedRef, postconditionHash: postcondition(intended), ...(entryGrant.completion ? { evidenceRefs: entryGrant.completion.evidenceRefs, completionProof: entryGrant.completion } : {}) } });
        try {
          const grant = await this.authorize(binding, request.capability, operation, expectedRef, changes);
          request.signal?.throwIfAborted();
          if (operation === 'complete' && proofIdentity(grant.completion!) !== proofIdentity(binding.receipt!.completionProof!)) throw new Error('Completion evidence changed after the pending receipt');
          invoked = true;
          try {
            if (operation === 'update') this.goals().edit(agent, expectedRef, changes!); else this.goals()[operation](agent, expectedRef);
          } finally { this.goals().disarm(agent); }
          const native = await this.flushRead(agent);
          request.signal?.throwIfAborted();
          if (!native || native.id !== expectedRef.id || postcondition(native) !== binding.receipt!.postconditionHash || native.activation !== 'disarmed') throw new Error('Native Goal mutation read-back mismatch');
          binding = await this.save(binding, { goalRef: ref(native), receipt: { ...binding.receipt!, status: 'confirmed', observedRef: ref(native) } });
          return { binding, native };
        } catch (error) {
          // This public native error is raised before commit. Confirm the exact
          // prior snapshot before classifying a rejected transition as known.
          if (invoked && (error as { code?: unknown })?.code === 'GOAL_INVALID_TRANSITION') {
            const current = snapshot(this.goals().get(agent));
            if (current && sameRef(current, before) && postcondition(current) === postcondition(before)) {
              binding = await this.save(binding, { receipt: { ...binding.receipt!, status: 'rejected', reason: errorText(error) } });
              invoked = false; throw error;
            }
          }
          if (invoked) return this.unknown(binding, error);
          binding = await this.save(binding, { receipt: { ...binding.receipt!, status: 'rejected', reason: errorText(error) } }); throw error;
        }
      }, request.signal); } catch (error) {
        // A failure while releasing a successfully mutated native Session must
        // not escape with a confirmed local command and an apparent clean return.
        if (invoked && !(error instanceof GoalOperationUnknownError)) return this.unknown(binding, error);
        throw error;
      }
    });
  }
  async recover(goalId: string, capability: object): Promise<GoalRecoveryResult> {
    return this.serial(goalId, async () => {
      let binding = await this.load(goalId); await this.authorize(binding, capability, 'recover');
      const reconciling = binding.receipt && ['pending', 'unknown'].includes(binding.receipt.status);
      try { return await this.withNative(binding, false, async agent => {
        await this.authorize(binding, capability, 'recover');
        // No resume/create transition and no dispatch grant: get rejects native replay corruption.
        const native = await this.flushRead(agent), receipt = binding.receipt;
        if (!receipt || !['pending', 'unknown'].includes(receipt.status)) {
          return { binding, native, reconciliation: sameRef(binding.goalRef, native) ? 'consistent' : 'conflict' };
        }
        const completionProven = receipt.operation !== 'complete' || (proofMatches(receipt.completionProof, binding, receipt.expectedRef, this.now()) && digest(receipt.evidenceRefs) === digest(receipt.completionProof.evidenceRefs));
        const matching = native && (receipt.expectedRef === undefined || native.id === receipt.expectedRef.id) && postcondition(native) === receipt.postconditionHash && completionProven;
        await this.authorize(binding, capability, 'recover');
        if (matching) {
          binding = await this.save(binding, { goalRef: ref(native), receipt: { ...receipt, status: 'confirmed', observedRef: ref(native) } });
          return { binding, native, reconciliation: 'confirmed' };
        }
        const reconciliation = !native || sameRef(native, receipt.expectedRef) ? 'not_observed' : 'conflict';
        binding = await this.save(binding, { receipt: { ...receipt, status: 'unknown', ...(native ? { observedRef: ref(native) } : {}), reason: `Recovery ${reconciliation}; no command was replayed` } });
        return { binding, native, reconciliation };
      }); } catch (error) {
        if (reconciling) return this.unknown(binding, error);
        throw error;
      }
    });
  }
  async decisionRound(input: CoreDecisionRequest): Promise<CoreDecisionResult> {
    this.assertOpen();
    if (!this.core) throw new Error('Decisions require the dedicated Core Goal namespace');
    const request = validateCoreDecisionRequest(input, this.now());
    const identity = JSON.stringify([request.goalId, request.roundId]);
    if (this.decisionIds.has(identity)) throw new Error('Core round was already admitted; reconcile instead of replaying');
    this.decisionIds.add(identity);
    const run = new CoreDecisionRun({ ctx: this.options.ctx, request, now: () => this.now(), shutdown: this.shutdown.signal,
      createUserMessage: this.options.createUserMessage,
      isAgentLoopRequest: this.options.isAgentLoopRequest,
      authorize: (binding, phase) => this.authorize(binding, request.capability, 'decision', request.expectedRef, undefined, { roundId: request.roundId, phase }),
      readGoal: agent => snapshot(this.goals().get(agent)) });
    try { return await this.serial(request.goalId, async () => {
      let session: string | undefined, candidate: CoreDecisionResult | undefined, failure: unknown;
      try {
        const binding = await this.load(request.goalId); session = binding.sessionId;
        await run.prepare(binding); await this.initialize();
        this.decisionRuns.set(binding.sessionId, run);
        candidate = await this.withNative(binding, false, (agent, baseline) => run.execute(agent, baseline), run.signal, run);
        await run.gate('result');
      } catch (error) { failure = error; }
      try { await run.account(candidate !== undefined && failure === undefined); }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Core decision and accounting failed'); }
      finally { if (session && this.decisionRuns.get(session) === run) this.decisionRuns.delete(session); }
      if (failure !== undefined) throw failure;
      // Accounting may await durable storage; it does not extend the authority deadline.
      await run.gate('result');
      return candidate!;
    }, true); } finally { run.close(); }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.shutdown.abort(new Error('Goal adapter is closed'));
    this.closing = (async () => {
      for (const owner of this.owners) owner.handle?.agent.cancel({ kind: 'hook', reason: 'Goal adapter closed' }, this.core ? { keepInbox: true } : undefined);
      await Promise.allSettled([...this.locks.values()]); await this.initialized?.catch(() => {});
      const failures = [...this.cleanupFailures];
      // Failed native disposal retains all deny guards, including the scoped stream gate.
      if (!this.owners.size) for (const dispose of [this.createdDispose, this.streamDispose, this.presetDispose]) { try { await dispose?.(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Goal adapter cleanup failed');
    })(); return this.closing;
  }
}
