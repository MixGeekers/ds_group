import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from './adapters/control-store/index.js';
import { EventService } from './control/events/index.js';
import { EventRuleStore } from './control/events/rules.js';
import { RuleStoreSubscriptionReader, SubscriptionLifecycleService } from './control/events/subscriptions.js';
import { H2B_EVENT_TYPES, RuleBasedSchedulePort, TimeSourcePump, TimeSourceService, type ReadonlyObservationPort } from './control/events/time-source.js';
import { NotificationRouter, type NotificationEffectPort } from './control/events/notifications.js';
import { SHIYU_EVENT_TYPES } from './contracts/events.js';
import type { EventPrincipal, EventTypeDefinition } from './contracts/events.js';
import { ShiyuSessionAdapter } from './adapters/dsh/sessions.js';
import type { DshContext, SessionStatus, ProbeResult, ReplyRequest, ReplyResult, ReplyDraftReadRequest, ReplyDraftReadResult, ContextLoadRequest, ContextLoadResult } from './adapters/dsh/sessions.js';
import { LocalStateFile } from './recovery/local-state.js';
import { systems } from './health/systems.js';
import { WorkerSessionDriver, type WorkerEventToolProbeResult } from './adapters/dsh/workers.js';
import { createCoreEventTools, createWorkerEventToolSource } from './adapters/dsh/event-tools.js';
import type { CoreDecisionEventToolFactory, CoreDecisionEventToolProbeResult, CoreEventToolModelProbeResult } from './adapters/dsh/goals.js';
import { ChannelRuntimeBridge } from './control/channels/index.js';
import { probeLiveTimeTrigger, probeTimeSource, TIME_TRIGGER_PROBE_SCOPE, type LiveTimeTriggerProbeResult, type TimeSourceProbeResult } from './control/events/probe.js';
import { EventDeliveryCoordinator } from './control/events/index.js';
import { LocalArtifactStore } from './adapters/artifacts/index.js';
import { LocalTaskRunner } from './control/task-runner.js';
import type { TaskWorkerDriver } from './control/task-runner.js';
import { LocalGoalLifecycleService } from './control/goal-lifecycle.js';
import type { GoalLifecycleOptions, GoalLifecycleResult, GoalLifecycleRunOptions } from './control/goal-lifecycle.js';
import { BackgroundPump } from './control/background-pump.js';
import { LocalReplyService } from './control/local-reply.js';
import { LocalMemoryService } from './control/local-memory.js';
import { LocalMemorySearchService } from './control/local-memory-search.js';
import { ManagedOmbreBackend, loadManagedOmbreConfig, type ManagedOmbreConfig } from './adapters/ombre/managed.js';
import type { LocalMemoryEntry } from './adapters/control-store/memory-domain.js';
import type { MemoryIndexEntry } from './adapters/control-store/memory-index-domain.js';
import type { AvailableMemoryDomain, UnavailableDomain } from './state/publication.js';
import { CorePump, type CoreEvaluationResult } from './control/core-pump.js';
import { reconcileCoreValidationGoal, runBoundedCoreValidation, type CoreValidationReceipt, type CoreValidationReconcileReceipt, type CoreValidationStore } from './control/core-validation.js';
import { LocalCoreService, type LocalCoreOptions } from './control/local-core.js';
import type { CoreGoal, CorePrepareInput } from './contracts/core.js';
import type { CapabilityBinding, CapabilityCommandReceipt } from './contracts/capability.js';
import { localNoteDefinitionDigest, localNoteEnvironmentFingerprint, UNAVAILABLE_WORKER_DEPENDENCY } from './adapters/capability-identity.js';
import { LabTargetAdapter } from './adapters/lab/index.js';
import { LabService, type LabServiceOptions, type LabOwnerConnectInput, type LabOwnerControlInput, type LabOwnerReconcileInput, type LabActivity } from './control/lab.js';
import {
  createRuntimeCheckpointComposition,
  detectSessionPersistenceLogResolver,
  type RuntimeCheckpointComposition,
} from './recovery/host-ports.js';
import { RuntimeCheckpointCommand, RuntimeCheckpointProbeCommand, type RuntimeCheckpointCommandResult } from './recovery/runtime-command.js';
import { probeCheckpointAvailability } from './recovery/checkpoint-probe.js';
import { TaskWorkspaceCoordinator, type TaskExecutionPlan } from './control/task-workspace.js';
import { computeMemoryReadiness, type MemoryReadiness } from './adapters/ombre/readiness.js';
import { INNER_LIFECYCLE_PROBE_ACTION, RuntimeInnerLifecycleProbeCommand, type InnerLifecycleProbeReceipt } from './control/inner-lifecycle-probe.js';
import { CHAT_MEMORY_PROBE_ACTION, runChatMemoryRecallPhase, runChatMemoryWritePhase, type ChatMemoryProbeReceipt } from './control/chat-memory-probe.js';
import { StartupEmbeddingVerifier, type StartupEmbeddingResult } from './control/startup-embedding-verifier.js';
import { EMOTION_PROBE_ACTION, RuntimeEmotionContinuationProbeCommand, type EmotionProbeReceipt } from './adapters/control-store/emotion-continuation-probe.js';
import { CORE_VALIDATION_EXPERIMENT, CORE_VALIDATION_EXPERIMENT_V3, CORE_VALIDATION_EXPERIMENT_V4, CORE_VALIDATION_EXPERIMENT_V5, CORE_VALIDATION_EXPERIMENT_V6, CORE_VALIDATION_EXPERIMENT_V7 } from './control/core-validation.js';
import { probeNativeHeaderCut, assertNativeHeaderCutAdmission, type NativeHeaderCutProbeReceipt } from './control/native-header-cut-probe.js';
import { CORE_GOAL_PRESET_ID } from './adapters/dsh/goals.js';
import type { CheckpointProbeResult, RuntimeManifest } from './recovery/types.js';

export const VERSION = '0.1.0';
const OWN_SCOPE = 'runtime';
const ownTypes = ['runtime.lifecycle.changed', 'runtime.session.probed', 'runtime.model.verified', 'runtime.goal.verified', 'runtime.context.verified'];
const catalog: EventTypeDefinition[] = [...SHIYU_EVENT_TYPES, ...H2B_EVENT_TYPES, ...ownTypes.map(type => ({
  type, schemaVersion: 1, description: 'Shiyu runtime lifecycle evidence.',
  publisherKinds: ['component' as const], publisherIds: ['shiyu-runtime'],
  payloadSchema: { properties: { message: 'string' as const, status: 'string' as const }, required: ['message', 'status'], additionalProperties: false as const },
  filterableFields: ['status'],
}))];
const principal: EventPrincipal = {
  principalId: 'shiyu-runtime', kind: 'component', scopes: [OWN_SCOPE],
  publishTypes: ownTypes, subscribeTypes: ownTypes, targetRefs: ['runtime.activity'],
};
export interface SessionDriver {
  initialize(): Promise<void>;
  prepareContextSafety?(): Promise<{ ready: true; messageFactory: 'official' | 'injected'; nativeReadback: true; coldProjection: true }>;
  probe(): Promise<ProbeResult>;
  generateReply(request: ReplyRequest): Promise<ReplyResult>;
  loadContextOnly?(request: ContextLoadRequest): Promise<ContextLoadResult>;
  readReplyDraft?(request: ReplyDraftReadRequest): Promise<ReplyDraftReadResult>;
  getStatus(): Promise<SessionStatus[]>;
  cancel(key: string): Promise<void>;
  close(): Promise<void>;
}
export interface RuntimeConfig {
  dataDir?: string;
  /** Owner-configured writable shared workspace root; trusted composition only. */
  sharedWorkspaceRoot?: string;
}
export interface GoalLifecycleDriver {
  initialize(): Promise<void>;
  run(taskId: string, options: GoalLifecycleRunOptions): Promise<GoalLifecycleResult>;
  close(): Promise<void>;
}
export interface CoreDriver {
  create(input: CorePrepareInput, signal?: AbortSignal): Promise<CoreGoal>;
  control(kind: 'pause' | 'cancel' | 'resume', input: { goalId: string; expectedVersion: number }, signal?: AbortSignal): Promise<CoreGoal>;
  evaluatePending(input?: { signal?: AbortSignal }): Promise<CoreEvaluationResult>;
  cancelGoal(goalId: string, reason?: unknown): void;
  cancelAll(reason?: unknown): void;
  /** H2c trusted zero-model core event-tool mount diagnostic; absent = unsupported. */
  probeCoreEventTools?(options: { signal?: AbortSignal; cwd?: string; scope?: string }): Promise<CoreDecisionEventToolProbeResult>;
  /** H2c bounded real-model single-round core event-tool probe; absent = unsupported. */
  probeCoreEventToolModelRound?(options: { signal?: AbortSignal; cwd?: string; scope?: string; timeoutMs?: number; maxTokens?: number }): Promise<CoreEventToolModelProbeResult>;
  close(): Promise<void>;
}
export interface RuntimeOptions {
  sessionFactory?: (ctx: DshContext, state: LocalStateFile, cwd: string) => SessionDriver;
  workerFactory?: (ctx: DshContext) => TaskWorkerDriver;
  goalFactory?: (options: GoalLifecycleOptions) => GoalLifecycleDriver;
  /** Trusted composition only; public commands cannot supply a planner or authority. */
  coreFactory?: (options: LocalCoreOptions) => CoreDriver;
  /** Trusted composition seam; never accept an adapter or token reader from command JSON. */
  labFactory?: (options: LabServiceOptions) => LabService;
  labAdapterFactory?: LabServiceOptions['adapterFactory'];
  /** Trusted fixture/composition only; never accepted from command JSON. */
  memoryFactory?: (config: ManagedOmbreConfig) => Pick<ManagedOmbreBackend, 'adapter' | 'open' | 'status' | 'close'>;
  /** Trusted composition only: in-place shared changes accepted in the task plan. */
  workspaceExpectedChanges?: (plan: TaskExecutionPlan) => readonly string[];
  /** Trusted composition only: explicit owner decision to delete canonical shared files. */
  workspaceOwnerDecision?: (plan: TaskExecutionPlan) => { kind: 'delete-shared'; paths: readonly string[]; decisionId: string; decidedAt?: string } | undefined;
  /**
   * H5b trusted composition only: explicit checkpoint staging root outside the
   * live data root. Public commands, model output and GET traffic can never set
   * or widen it. Absent means the owner-only checkpoint command stays
   * unavailable (CHECKPOINT_STAGING_UNCONFIGURED), never a temp fallback.
   */
  checkpointStagingRoot?: string;
  /**
   * H5b trusted fixed host identity (DSH version/commit, Node, plugin and
   * component schema versions). The composition must never guess a host
   * version from a request; absent keeps the checkpoint command unavailable.
   */
  checkpointRuntimeManifest?: RuntimeManifest;
  /** H2b trusted composition only: read-only external observation for time/condition rules. */
  timeObservationPort?: ReadonlyObservationPort;
  /** H2b trusted composition only: notification Effect adapter; absent keeps notifications disabled. */
  notificationEffectPort?: NotificationEffectPort;
}
function memoryEntry(entry: LocalMemoryEntry) {
  return { operationId: entry.operation.operationId, version: entry.operation.version, requestId: entry.requestId,
    conversationId: entry.conversationId, status: entry.operation.status, blocked: entry.operation.blocked,
    bodyBytes: entry.source.bodyBytes, consent: entry.source.consent.state, canRead: Boolean(entry.reference),
    ...(entry.reference ? { nativeId: entry.reference.nativeId } : {}), createdAt: entry.operation.createdAt };
}
function memoryIndexEntry(entry: MemoryIndexEntry) {
  return { indexOperationId: entry.indexOperationId, memoryOperationId: entry.command.memoryOperationId,
    status: entry.effect.status, publishable: entry.publishable, embeddingUsage: structuredClone(entry.embeddingUsage) };
}
function publicCoreGoal(goal: CoreGoal) {
  const { deliverables, ...metadata } = goal;
  return { ...metadata, deliverables: deliverables.map(({ content, ...item }) => ({ ...item, bodyBytes: Buffer.byteLength(content, 'utf8') })) };
}
interface ActiveOperation { id: string; title: string; phase: string; status: string; controller: AbortController; done: Promise<void>; finish: () => void }

export class RuntimeService {
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly operations = new Map<string, ActiveOperation>();
  readonly dataDir: string;
  /** Owner-configured writable shared workspace root; undefined = legacy no-shared behavior. */
  private readonly sharedWorkspaceRoot?: string;
  state!: LocalStateFile;
  store!: ControlStore;
  events!: EventService;
  /** H2a: durable delivery coordination for trusted Agent/component targets. */
  eventDeliveries?: EventDeliveryCoordinator;
  /** H6b: channel bindings, invalidation bridge and read-only projection. */
  channels!: ChannelRuntimeBridge;
  /** H2b: declarative event rules, subscription lifecycle, time source and notification routing. */
  eventRules!: EventRuleStore;
  subscriptions!: SubscriptionLifecycleService;
  subscriptionReader!: RuleStoreSubscriptionReader;
  timeSource!: TimeSourceService;
  timePump?: TimeSourcePump;
  notificationRouter?: NotificationRouter;
  sessions!: SessionDriver;
  workers!: TaskWorkerDriver;
  artifacts!: LocalArtifactStore;
  tasks!: LocalTaskRunner;
  goals!: GoalLifecycleDriver;
  background!: BackgroundPump;
  private lastEventToolProbe?: WorkerEventToolProbeResult;
  private lastCoreEventToolProbe?: CoreDecisionEventToolProbeResult;
  private lastCoreModelToolProbe?: CoreEventToolModelProbeResult;
  private lastCoreGoalValidation?: CoreValidationReceipt;
  private lastNativeHeaderCutProbe: NativeHeaderCutProbeReceipt | null = null;
  private lastCoreValidationReconcile?: CoreValidationReconcileReceipt;
  private lastTimeSourceProbe?: TimeSourceProbeResult;
  private lastTimeTriggerProbe?: LiveTimeTriggerProbeResult;
  private core?: CoreDriver;
  private corePump?: CorePump;
  private coreFailure?: string;
  private lab?: LabService;
  private labFailure?: string;
  localReplies!: LocalReplyService;
  private localMemories?: LocalMemoryService;
  private memorySearch?: LocalMemorySearchService;
  private memoryBackend?: Pick<ManagedOmbreBackend, 'adapter' | 'open' | 'status' | 'close'>;
  private memoryConfig?: Readonly<ManagedOmbreConfig>;
  private memoryFailure?: string;
  private semanticFailure?: string;
  /** P0: last trusted index coverage reconciliation (read-only; refreshed by memory commands). */
  private memoryCoverage?: Partial<import('./adapters/ombre/readiness.js').MemoryIndexCoverage>;
  /** Pure in-memory readiness projection; never queried by GET/snapshot. */
  private memoryReadiness?: MemoryReadiness;
  /** P0 round-18 startup verification: one attempt per process; no generation. */
  private readonly startupEmbeddingVerifier = new StartupEmbeddingVerifier();
  private startupEmbeddingReceipt?: StartupEmbeddingResult;
  /** Last bounded two-phase single-user chat-memory probe receipt (diagnostics only). */
  private chatMemoryProbeReceipt?: ChatMemoryProbeReceipt;
  private lastSemanticOperation?: { kind: 'index' | 'search'; status: 'completed' | 'failed' | 'existing'; at: string;
    outcome?: MemoryIndexEntry['effect']['status'];
    embeddingUsage: { calls: number | null; complete: boolean } };
  private closed = false;
  private closing?: Promise<void>;
  private controlTail: Promise<void> = Promise.resolve();
  private controlRevision = 0;
  private pendingAdmissions = 0;
  private readonly admissions = new Set<Promise<void>>();
  private readonly attemptedTasks = new Set<string>();
  private pauseRequested = false;
  private lastFailure?: string;
  private contextSafety: { ready: boolean; messageFactory?: 'official' | 'injected'; error?: string } = { ready: false };
  /** H5b owner-only checkpoint command; created during init without any I/O below the command path. */
  private checkpointCommand?: RuntimeCheckpointCommand;
  /** Lazily created by the first explicit owner command; never by a GET/snapshot read. */
  private checkpoint?: RuntimeCheckpointComposition;
  /** Last explicit checkpoint diagnostic code; used for degrade visibility, never for auto retry. */
  private checkpointFailure?: string;
  /** H5b-probe owner-only read-only availability command. */
  private checkpointProbeCommand?: RuntimeCheckpointProbeCommand;
  /** Last validated probe receipt; the only place it is stored (snapshot diagnostics). */
  private checkpointProbeReceipt?: CheckpointProbeResult;
  /** H4e-probe: owner-only zero-model isolated lifecycle command + last validated receipt. */
  private innerLifecycleProbeCommand?: RuntimeInnerLifecycleProbeCommand;
  private innerLifecycleProbeReceipt?: InnerLifecycleProbeReceipt;
  /** H4f: owner-only read-only emotion-context probe + last validated receipt. */
  private emotionProbeCommand?: RuntimeEmotionContinuationProbeCommand;
  private emotionProbeReceipt?: EmotionProbeReceipt;
  constructor(private readonly ctx: DshContext, config: RuntimeConfig = {}, private readonly options: RuntimeOptions = {}) {
    const defaultDirectory = fileURLToPath(new URL('../.local/runtime/', import.meta.url));
    if (config.dataDir !== undefined && (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir))) throw new Error('dataDir must be an absolute path');
    if (config.sharedWorkspaceRoot !== undefined && (typeof config.sharedWorkspaceRoot !== 'string' || !path.isAbsolute(config.sharedWorkspaceRoot))) throw new Error('sharedWorkspaceRoot must be an absolute path');
    this.dataDir = path.resolve(config.dataDir ?? defaultDirectory);
    this.sharedWorkspaceRoot = config.sharedWorkspaceRoot;
  }
  async init(): Promise<void> {
    this.state = await LocalStateFile.open(this.dataDir);
    this.state.onFault(error => {
      this.pauseRequested = true;
      this.lastFailure = error.message;
      for (const op of this.operations.values()) op.controller.abort(error);
    });
    this.pauseRequested = this.state.state.paused;
    try {
      if (!this.state.state.installationGeneration) await this.state.update(state => { state.installationGeneration = randomUUID(); });
      try { this.memoryConfig = await loadManagedOmbreConfig(this.dataDir); }
      catch { this.memoryFailure = 'MEMORY_CONFIGURATION_INVALID'; }
      await mkdir(path.join(this.dataDir, 'control'), { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.dataDir, 'workspaces'), { recursive: true, mode: 0o700 });
      this.workers = this.options.workerFactory?.(this.ctx) ?? new WorkerSessionDriver({ ctx: this.ctx });
      await this.workers.initialize();
      this.artifacts = await LocalArtifactStore.open(path.join(this.dataDir, 'workspaces'));
      let dependencyFingerprint = UNAVAILABLE_WORKER_DEPENDENCY;
      let abilityAvailable = false;
      try {
        if (!this.workers.prepareLocalNote) throw new Error('Worker prerequisite observation is unavailable');
        const prerequisites = await this.workers.prepareLocalNote();
        await this.artifacts.inspectRoot();
        // Validate the observation before accepting availability, including injected fixtures.
        localNoteEnvironmentFingerprint(prerequisites.dependencyFingerprint);
        dependencyFingerprint = prerequisites.dependencyFingerprint;
        abilityAvailable = true;
      } catch { /* The domain remains readable; missing prerequisites never become an implicit usable capability. */ }
      const localNoteBinding: CapabilityBinding = { definitionDigest: localNoteDefinitionDigest(),
        installationGeneration: this.state.state.installationGeneration!, environmentFingerprint: localNoteEnvironmentFingerprint(dependencyFingerprint) };
      this.store = await ControlStore.open({ filename: path.join(this.dataDir, 'control', 'events.sqlite'), eventTypes: catalog, componentHandlers: ['runtime.activity', 'conversation.background'], runtimeIdentity: { hostEpoch: this.instanceId, installationGeneration: this.state.state.installationGeneration! },
        localNoteBinding,
        ...(this.memoryConfig ? { memoryBackend: { backendId: this.memoryConfig.backendId, deploymentId: this.memoryConfig.deploymentId } } : {}) });
      this.channels = new ChannelRuntimeBridge(this.store);
      try {
        const initialAbility = await this.store.request('ability.snapshot', {});
        await this.store.request('ability.observeLocalNote', { requestId: `ability-startup-${this.instanceId}`, expectedRevision: initialAbility.revision,
          hostEpoch: this.instanceId, binding: localNoteBinding, status: abilityAvailable ? 'available' : 'unavailable',
          reasonCode: abilityAvailable ? 'LOCAL_NOTE_PREREQUISITES_READY' : 'LOCAL_NOTE_PREREQUISITES_UNAVAILABLE' });
      } catch { /* A corrupt capability authority stays closed while unrelated read paths remain available. */ }
      if (this.memoryConfig) {
        const domain = await this.store.request('memory.status', {});
        if (!domain.ready) this.memoryFailure = domain.errorCode ?? 'MEMORY_DOMAIN_UNAVAILABLE';
        else {
          try {
            this.memoryBackend = this.options.memoryFactory?.(this.memoryConfig) ?? new ManagedOmbreBackend(this.memoryConfig);
            if (!this.pauseRequested) await this.memoryBackend.open();
            this.localMemories = new LocalMemoryService({ store: this.store, backend: this.memoryBackend.adapter, assertRuntimeAllowed: () => this.ensureCanRun() });
            if (this.memoryConfig.schemaVersion === 2) {
              const indexDomain = await this.store.request('memory.index.status', {});
              if (indexDomain.ready) this.memorySearch = new LocalMemorySearchService({ store: this.store, backend: this.memoryBackend.adapter, assertRuntimeAllowed: () => this.ensureCanRun() });
              else this.semanticFailure = indexDomain.errorCode ?? 'MEMORY_INDEX_UNAVAILABLE';
            }
            await this.refreshMemoryCoverage();
          } catch { this.memoryFailure = 'MEMORY_BACKEND_UNAVAILABLE'; await this.memoryBackend?.close().catch(() => undefined); }
        }
      }
      this.events = new EventService(this.store);
      // H2b: declarative rules/lifecycle/time source. The pump is a zero-model
      // cooperative tick with its own timer; it never occupies an operation slot
      // and never calls a model. Rules are only read; the control DB stays the
      // sole subscription/delivery/ack authority.
      this.eventRules = new EventRuleStore({ filename: path.join(this.dataDir, 'control', 'event-rules.json') });
      this.subscriptions = new SubscriptionLifecycleService({ events: this.events, rules: this.eventRules });
      this.subscriptionReader = new RuleStoreSubscriptionReader(this.eventRules, this.events);
      this.timeSource = new TimeSourceService({ events: this.events, rules: this.eventRules,
        schedule: new RuleBasedSchedulePort(this.eventRules),
        principal: { principalId: 'shiyu-time-source', kind: 'component', scopes: ['local-owner', TIME_TRIGGER_PROBE_SCOPE],
          publishTypes: ['time.occurred', 'observation.changed'], subscribeTypes: [], targetRefs: [] },
        readSubscription: id => this.subscriptionReader.read(id),
        triggerEventType: 'time.occurred', observationEventType: 'observation.changed',
        ...(this.options.timeObservationPort ? { observation: this.options.timeObservationPort } : {}) });
      this.timePump = new TimeSourcePump({ source: this.timeSource,
        allowed: () => !this.pauseRequested && !this.closed && !this.closing,
        onFailure: error => { this.lastFailure = error instanceof Error ? error.message : String(error); } });
      this.timePump.start();
      if (this.options.notificationEffectPort) this.notificationRouter = new NotificationRouter({ events: this.events,
        rules: this.eventRules, effect: this.options.notificationEffectPort });
      // H2a: per-Assignment restricted event tools. The grant callback is trusted
      // composition; the model never selects, attaches or reconfigures this surface.
      try {
        this.workers.attachEventTools?.(createWorkerEventToolSource({
          service: this.events,
          grant: ({ binding }) => ({ principalId: `worker:${binding.assignmentId}`, scope: binding.scope,
            publishTypes: ['agent.observation.reported', 'worker.result.reported'] }),
          onPublished: () => { void this.background?.wake(); },
        }));
      } catch (error) { this.lastFailure = error instanceof Error ? error.message : String(error); }
      // H2c: trusted per-Goal core event tools. Absent factory keeps the historical
      // single-request zero-tool core decision path unchanged.
      const coreEventTools: CoreDecisionEventToolFactory = binding => createCoreEventTools({
        service: this.events,
        reportTypes: ['agent.observation.reported'],
        principal: { principalId: `core:${binding.goalId}`, kind: 'agent', scopes: [binding.scope],
          publishTypes: ['agent.observation.reported'],
          subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs: [] },
        onPublished: () => { void this.background?.wake(); },
      });
      this.sessions = this.options.sessionFactory?.(this.ctx, this.state, path.join(this.dataDir, 'workspaces')) ?? new ShiyuSessionAdapter({
        ctx: this.ctx, cwd: path.join(this.dataDir, 'workspaces'),
        bindings: { load: async () => structuredClone(this.state.state.bindings), save: bindings => this.state.update(state => { state.bindings = structuredClone(bindings); }) },
      });
      await this.sessions.initialize();
      try {
        if (!this.sessions.prepareContextSafety) throw new Error('Session driver has no native context safety preparation');
        this.contextSafety = await this.sessions.prepareContextSafety();
      } catch (error) { this.contextSafety = { ready: false, error: error instanceof Error ? error.message : String(error) }; }
      this.localReplies = new LocalReplyService({ store: this.store, sessions: this.sessions, assertRuntimeAllowed: () => this.ensureCanRun(),
        ...(this.memorySearch ? { memory: this.memorySearch } : {}) });
      await this.publishMemoryAvailability();
      // P0 round-18: one bounded local-embedding verification after availability
      // publication. It never calls a generation model and never retries.
      await this.runStartupEmbeddingVerification();
      const taskWorkspaceCoordinator = new TaskWorkspaceCoordinator({
        workspacesRoot: path.join(this.dataDir, 'workspaces'),
        ...(this.sharedWorkspaceRoot ? { sharedRoot: this.sharedWorkspaceRoot } : {}),
        ...(this.options.workspaceExpectedChanges ? { expectedChanges: this.options.workspaceExpectedChanges } : {}),
        ...(this.options.workspaceOwnerDecision ? { ownerDecision: this.options.workspaceOwnerDecision } : {}),
      }, this.artifacts);
      this.tasks = new LocalTaskRunner(this.store, this.workers, this.artifacts, taskWorkspaceCoordinator);
      const goalOptions: GoalLifecycleOptions = {
        ctx: this.ctx,
        bindings: {
          load: goalId => this.store.request('goal.binding.load', { goalId }),
          loadCommand: (goalId, commandId) => this.store.request('goal.binding.loadCommand', { goalId, commandId }),
          compareAndSet: (expectedMetadataVersion, binding) => this.store.request('goal.binding.compareAndSet', { expectedMetadataVersion, binding }),
        },
        taskReader: taskId => this.store.request('task.get', { taskId }),
        artifacts: this.artifacts,
        isRuntimeOpenAndUnpaused: () => {
          try { this.ensureCanRun(); return true; } catch { return false; }
        },
      };
      this.goals = this.options.goalFactory?.(goalOptions) ?? new LocalGoalLifecycleService(goalOptions);
      await this.goals.initialize();
      await this.store.request('task.setPaused', { paused: this.pauseRequested });
      // H5b: owner-only local checkpoint command. Nothing is captured here and no
      // staging directory is written; the composition is created lazily only by
      // an explicit `runtime.checkpoint.capture` command, so GET/status reads can
      // never trigger a checkpoint. A failed attempt is surfaced in the command
      // result and this diagnostic field; it is never retried automatically.
      this.checkpointCommand = new RuntimeCheckpointCommand({
        composition: () => this.checkpointComposition(),
        isOpen: () => !this.closed && !this.closing,
        isPaused: () => this.pauseRequested,
        onDiagnostic: entry => { this.checkpointFailure = entry.code ?? undefined; },
      });
      // H5b-probe: read-only availability probe. The closure only runs inside the
      // explicit owner command; it never captures, writes files, calls a resolver
      // or changes pause state. The validated receipt is kept for diagnostics.
      this.checkpointProbeCommand = new RuntimeCheckpointProbeCommand({
        probe: () => probeCheckpointAvailability({
          stagingRoot: this.options.checkpointStagingRoot,
          dataDir: this.dataDir,
          paused: this.pauseRequested,
          controlStore: this.store,
          ownerId: 'local-owner',
          scope: 'local-owner',
          sessionLogResolver: typeof this.ctx.get('sessionPersistence')?.resolveCurrentLog === 'function'
            ? { candidate: 'jsonl-internal-diagnostic' }
            : undefined,
          goalSeams: {
            nativeState: false,
            flush: typeof this.ctx.get('sessions')?.flush === 'function',
            projection: false,
          },
          workspaceRoot: path.join(this.dataDir, 'workspaces'),
        }),
        isOpen: () => !this.closed && !this.closing,
        isPaused: () => this.pauseRequested,
        onReceipt: receipt => { this.checkpointProbeReceipt = receipt; },
      });
      // H4e-probe: the probe owns its own :memory: ControlStore. This command is
      // never reached by GET/snapshot; the live store and dataDir are not inputs.
      this.innerLifecycleProbeCommand = new RuntimeInnerLifecycleProbeCommand({
        isOpen: () => !this.closed && !this.closing,
        isPaused: () => this.pauseRequested,
        onReceipt: receipt => { this.innerLifecycleProbeReceipt = structuredClone(receipt); },
      });
      // H4f: private :memory: store only; the live data root is never an input.
      this.emotionProbeCommand = new RuntimeEmotionContinuationProbeCommand({
        isOpen: () => !this.closed && !this.closing,
        isPaused: () => this.pauseRequested,
        onReceipt: receipt => { this.emotionProbeReceipt = structuredClone(receipt); },
      });
      const labStatus = await this.store.request('lab.status', {});
      if (labStatus.ready) {
        try {
          const labOptions: LabServiceOptions = { store: this.store, sessions: this.sessions,
            adapterFactory: this.options.labAdapterFactory ?? (() => new LabTargetAdapter({ ctx: this.ctx })),
            assertRuntimeAllowed: () => {
              this.ensureCanRun();
              if (!this.contextSafety.ready) throw new Error('Native context safety is unavailable');
            },
            tryAcquireActivity: input => this.acquireLabActivity(input),
          };
          this.lab = this.options.labFactory?.(labOptions) ?? new LabService(labOptions);
        } catch { this.labFailure = 'LAB_INITIALIZATION_FAILED'; }
      } else this.labFailure = labStatus.errorCode ?? 'LAB_UNAVAILABLE';
      const coreStatus = await this.store.request('core.status', {});
      if (coreStatus.ready) {
        try {
          const coreOptions: LocalCoreOptions = { ctx: this.ctx, store: this.store, bindings: goalOptions.bindings, artifacts: this.artifacts,
            assertRuntimeAllowed: () => this.ensureCanRun(), hasCapacity: () => this.operations.size + this.pendingAdmissions <= 2,
            eventTools: coreEventTools,
            onGoalStopped: goal => {
              for (const { taskId } of goal.taskRefs) this.operations.get(taskId)?.controller.abort(new Error('Owner stopped the task Goal'));
            } };
          this.core = this.options.coreFactory?.(coreOptions) ?? new LocalCoreService(coreOptions);
          this.corePump = new CorePump({
            pending: async () => {
              if (this.closed || this.closing || this.pauseRequested || this.operations.size + this.pendingAdmissions >= 2) return false;
              return (await this.store.request('core.pending', { limit: 1 })).goalIds.length > 0;
            },
            evaluatePending: input => this.evaluateCore(input.signal),
          });
        } catch {
          await this.core?.close().catch(() => undefined); this.core = undefined; this.corePump = undefined;
          this.coreFailure = 'CORE_INITIALIZATION_FAILED';
        }
      } else this.coreFailure = coreStatus.errorCode ?? 'CORE_UNAVAILABLE';
      const existing = await this.events.listSubscriptions(principal);
      const activitySubscription = existing.find(s => s.id === 'runtime-activity');
      if (!activitySubscription) await this.events.subscribe(principal, {
        id: 'runtime-activity', types: ownTypes, scope: OWN_SCOPE,
        target: { kind: 'component', handlerRef: 'runtime.activity' }, deliveryMode: 'component', start: { kind: 'from_now' },
      });
      else if (JSON.stringify(activitySubscription.types) !== JSON.stringify(ownTypes)) await this.events.update(principal, activitySubscription.id, activitySubscription.revision, { types: ownTypes });
      await this.record('runtime.lifecycle.changed', '识雨本体基础已装载', this.pauseRequested ? 'paused' : 'ready');
      this.eventDeliveries = new EventDeliveryCoordinator({
        events: this.events,
        principal: { principalId: 'shiyu-runtime-delivery', kind: 'component', scopes: ['local-owner'],
          publishTypes: [], subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs: [] },
        handlers: [],
        agentTargets: [],
        consumerId: 'shiyu-runtime-delivery',
      });
      // One scan, two durable consumers: the existing conversation projection plus
      // agent-target deliveries. scan() keeps processed+failed===claimed for the pump.
      this.background = new BackgroundPump({ batchSize: 20, consume: async limit => {
        const projection = await this.store.request('conversation.consumeBackground', { limit });
        const agent = await this.eventDeliveries!.scan(limit);
        return { claimed: projection.claimed + agent.claimed,
          processed: projection.acknowledged + agent.processed, failed: projection.failed + agent.failed };
      } });
      await this.background.start();
      // Existing authorized work may need a native request on startup. Keep the
      // dashboard and pause controls available while the pump owns that work;
      // close() still aborts and drains its in-flight evaluation before the DB.
      void this.corePump?.start().catch(error => {
        this.lastFailure = error instanceof Error ? error.message : String(error);
      });
    } catch (error) {
      await this.lab?.close().catch(() => undefined);
      await this.corePump?.close().catch(() => undefined);
      await this.core?.close().catch(() => undefined);
      await this.memorySearch?.close().catch(() => undefined);
      await this.localMemories?.close().catch(() => undefined);
      await this.memoryBackend?.close().catch(() => undefined);
      await this.background?.close().catch(() => undefined);
      await this.localReplies?.close().catch(() => undefined);
      await this.goals?.close().catch(() => undefined);
      await this.workers?.close().catch(() => undefined);
      await this.artifacts?.close().catch(() => undefined);
      await this.sessions?.close().catch(() => undefined);
      await this.store?.close().catch(() => undefined);
      await this.state.close(); throw error;
    }
  }
  private ensureOpen(): void {
    if (this.closed || this.closing) throw new Error('Runtime is stopping');
    this.state.assertHealthy();
  }
  private ensureCanRun(): void { this.ensureOpen(); if (this.pauseRequested) throw new Error('Runtime is paused'); }
  /** Reserve a shared slot synchronously, before the Lab coordinator can await a claim. */
  private acquireLabActivity(input: { connectionId: string; channelId: string; phase: string; signal: AbortSignal }): LabActivity | undefined {
    this.ensureCanRun(); input.signal.throwIfAborted();
    if (!this.contextSafety.ready || this.operations.size + this.pendingAdmissions >= 2) return undefined;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: `lab-${randomUUID()}`, title: `Lab · ${input.channelId}`, phase: input.phase,
      status: 'running', controller: new AbortController(), done, finish };
    this.operations.set(op.id, op);
    let released = false;
    return { signal: AbortSignal.any([input.signal, op.controller.signal]), update: phase => { if (!released) op.phase = phase; }, release: () => {
      if (released) return; released = true; this.operations.delete(op.id); op.finish();
      if (!this.closed && !this.closing) {
        void this.corePump?.wake();
        void this.scheduleQueuedTasks().catch(() => { this.lastFailure = 'TASK_SCHEDULING_FAILED'; });
      }
    } };
  }
  /** Trusted lifecycle publication. Dashboard reads never publish or probe a backend. */
  private async publishMemoryAvailability(): Promise<void> {
    const current = await this.store.request('view.state', {});
    if (!current) throw new Error('Inner state publication is unavailable');
    const backend = this.memoryBackend?.status();
    let availability: UnavailableDomain | AvailableMemoryDomain = { status: 'unavailable',
      reason: this.memoryConfig ? 'source_unavailable' : this.memoryFailure ? 'incompatible_version' : 'not_connected' };
    if (this.localMemories && backend?.state === 'ready' && backend.bindingVerified && !this.memoryFailure) {
      // P0: an available profile is not a verified embedding. Advertise semantic
      // search only after a fresh query embedding succeeded in this process and
      // the index ledger is not empty/unsettled; otherwise exact read only.
      this.memoryReadiness = computeMemoryReadiness({ backend, coverage: this.memoryCoverage, semanticConfigured: Boolean(this.memorySearch) });
      availability = { status: 'available', backendId: backend.backendId, deploymentId: backend.deploymentId,
        capabilities: this.memoryReadiness.capabilities as ['exact_read'] | ['exact_read', 'semantic_search'],
        ...(this.memoryReadiness.semanticReady && backend.semantic?.profileFingerprint ? { profileFingerprint: backend.semantic.profileFingerprint } : {}) };
    } else this.memoryReadiness = undefined;
    // No receipt churn for a lifecycle reconciliation whose state is already published.
    if (JSON.stringify(current.manifest.domains.memory) === JSON.stringify(availability)) return;
    await this.store.request('state.publishMemoryAvailability', { requestId: `memory-availability-${this.instanceId}-${randomUUID()}`,
      expectedBaselineId: current.baselineId, expectedStateVersion: current.stateVersion, availability });
  }
  /** Bounded, read-only index coverage reconciliation; never spawns a backend. */
  private async refreshMemoryCoverage(): Promise<void> {
    if (!this.memorySearch) return;
    try { this.memoryCoverage = await this.store.request('memory.index.coverage', {}) as Partial<import('./adapters/ombre/readiness.js').MemoryIndexCoverage>; }
    catch { this.semanticFailure = 'MEMORY_INDEX_COVERAGE_UNAVAILABLE'; }
  }
  private setPaused(paused: boolean): Promise<unknown> {
    const revision = ++this.controlRevision;
    // A later pause fences work immediately, even while an earlier resume is
    // waiting for its durable write. Only the latest successful resume opens it.
    if (paused) {
      this.pauseRequested = true;
      this.corePump?.cancelEvaluation(new Error('Runtime paused'));
      this.core?.cancelAll(new Error('Runtime paused'));
      // Lab cancellation follows its durable shared pause fence. Its dispatch
      // gates already see pauseRequested immediately while that write is pending.
      for (const op of this.operations.values()) if (!op.id.startsWith('lab-')) op.controller.abort();
    }
    const command = this.controlTail.then(async () => {
      if (paused) {
        await this.state.update(state => { state.paused = true; });
        await this.store.request('task.setPaused', { paused: true });
        this.lab?.onRuntimePaused();
        for (const op of this.operations.values()) if (op.id.startsWith('lab-')) op.controller.abort();
      } else {
        // Keep the durable stop until the domain accepted the resume. A failed
        // database update must not silently become a resume on the next boot.
        await this.store.request('task.setPaused', { paused: false });
        await this.state.update(state => { state.paused = false; });
      }
      if (!paused && revision === this.controlRevision && !this.closed) this.pauseRequested = false;
      if (!paused && revision === this.controlRevision && !this.closed && this.memoryBackend?.status().state === 'idle') {
        try { await this.memoryBackend.open(); }
        catch { this.memoryFailure = 'MEMORY_BACKEND_UNAVAILABLE'; await this.memoryBackend.close().catch(() => undefined); }
      }
      if (!this.closed) await this.publishMemoryAvailability();
      if (!this.closed && !this.startupEmbeddingVerifier.attempted) await this.runStartupEmbeddingVerification();
      if (paused) for (const binding of await this.sessions.getStatus()) if (binding.status === 'running') await this.sessions.cancel(binding.key);
      await this.record('runtime.lifecycle.changed', paused ? '已暂停新的模型操作' : '已恢复接纳新的模型操作', paused ? 'paused' : 'ready');
      if (!paused) { await this.scheduleQueuedTasks(); void this.corePump?.wake(); }
      return { accepted: true, paused };
    });
    this.controlTail = command.then(() => undefined, error => { this.lastFailure = error instanceof Error ? error.message : String(error); });
    return command;
  }
  /** Zero-model, read-only worker event-tool mount diagnostic (same admission
   * semantics as session.probe: unavailable while globally paused). */
  private async commandEventToolProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid event tool probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '检查 worker 事件工具受限挂载', phase: '零模型装配与释放',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      type WorkerEventToolProbe = (options: { signal?: AbortSignal }) => Promise<WorkerEventToolProbeResult>;
      const probe = (this.workers as { probeEventTools?: WorkerEventToolProbe }).probeEventTools;
      if (typeof probe !== 'function') throw new Error('WORKER_EVENT_TOOL_PROBE_UNAVAILABLE');
      const result = await probe.call(this.workers, { signal: op.controller.signal });
      this.ensureCanRun(); op.controller.signal.throwIfAborted();
      this.lastEventToolProbe = structuredClone(result);
      this.lastFailure = undefined;
      return { ...result, zeroModel: true, readOnly: true, sent: false };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /** Zero-model, read-only core event-tool mount diagnostic (same admission
   * semantics as session.probe: unavailable while globally paused). */
  private async commandCoreEventToolProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid core event tool probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '检查 core 事件工具受限挂载', phase: '零模型装配与释放',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      if (typeof this.core?.probeCoreEventTools !== 'function') throw new Error('CORE_EVENT_TOOL_PROBE_UNAVAILABLE');
      const core = this.core;
      const result = await core.probeCoreEventTools!({ signal: op.controller.signal,
        cwd: path.join(this.dataDir, 'workspaces'), scope: 'local-owner' });
      this.ensureCanRun(); op.controller.signal.throwIfAborted();
      this.lastCoreEventToolProbe = structuredClone(result);
      this.lastFailure = undefined;
      return { ...result, zeroModel: true, readOnly: true, sent: false };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /**
   * Owner-only bounded real-model single-round core event-tool probe. It uses
   * the same paused admission, one-slot capacity and abortable operation
   * semantics as session.probe; a probe turn is issued once and never retried.
   * The honest receipt (including failed/unknown/cancelled outcomes) is cached
   * only in snapshot diagnostics; no business state or event is written.
   */
  private async commandCoreModelToolProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid core model tool probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (typeof this.core?.probeCoreEventToolModelRound !== 'function') throw new Error('CORE_MODEL_TOOL_PROBE_UNAVAILABLE');
    if ([...this.operations.values()].some(op => op.phase === 'single-round core model tool probe')) throw new Error('Core model tool probe is already running');
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '有界真实模型单轮事件工具探针', phase: 'single-round core model tool probe',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      const core = this.core;
      const result = await core.probeCoreEventToolModelRound!({ signal: op.controller.signal, cwd: path.join(this.dataDir, 'workspaces'),
        scope: 'local-owner', timeoutMs: 60000, maxTokens: 256 });
      this.lastCoreModelToolProbe = structuredClone(result);
      if (result.status === 'passed') this.lastFailure = undefined;
      return { ...result, sent: false, productionStateWrites: 0 };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /** Zero-model, read-only isolated time-source diagnostic (same admission
   * semantics as session.probe: unavailable while globally paused). */
  private async commandTimeSourceProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid time source probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '检查时间源零模型触发', phase: '隔离内存探针',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      const result = await probeTimeSource({ signal: op.controller.signal });
      this.ensureCanRun(); op.controller.signal.throwIfAborted();
      this.lastTimeSourceProbe = structuredClone(result);
      this.lastFailure = undefined;
      return { ...result, zeroModel: true, readOnly: true, sent: false };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /** Owner-only zero-model LIVE time-trigger diagnostic: appends ONE real
   * time.occurred event to the live control ledger (cannot be deleted). */
  private async commandTimeTriggerProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid time trigger probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '检查 live 时间规则触发', phase: '零模型 live 规则探针',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      const result = await probeLiveTimeTrigger({ events: this.events, rules: this.eventRules, timeSource: this.timeSource,
        pump: this.timePump, allowed: () => !this.pauseRequested && !this.closed && !this.closing, signal: op.controller.signal });
      this.ensureCanRun(); op.controller.signal.throwIfAborted();
      this.lastTimeTriggerProbe = structuredClone(result);
      this.lastFailure = undefined;
      return { ...result, zeroModel: true, readOnly: false, sent: false };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /**
   * Owner-only bounded REAL core business-chain validation. This is NOT a
   * read-only probe: one invocation creates a real core Goal, a real
   * Task/Effect/budget reservation, a dedicated native core Session and a local
   * artifact, and it issues up to two real bounded model rounds through the
   * normal core path (including worker execution and independent verification).
   * It requires an idle, unpaused runtime, is single-flight, applies hard
   * 180s/2-evaluation/budget stops, never retries, and caches the honest bounded
   * receipt only in snapshot diagnostics. The caller must explicitly accept the
   * declared side effects.
   */
  private async commandCoreGoalValidation(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.commandCoreGoalValidationRun(value, signal, undefined);
  }

  /** v2 is a new frozen experiment for an explicit owner decision; it is NOT a
   * retry of the failed v1 create and never accepts input selection. */
  private async commandCoreGoalValidationV2(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.commandCoreGoalValidationRun(value, signal, CORE_VALIDATION_EXPERIMENT);
  }

  /** v3 is the third independent frozen experiment for an explicit owner
   * decision (cold-header cut fix prepared); it is NOT a retry of the failed
   * v1/v2 creates and never accepts input selection. The same single-slot,
   * paused/idle, bounded no-retry runner is used; only the frozen experiment
   * constant differs. */
  private async commandCoreGoalValidationV3(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.commandCoreGoalValidationRun(value, signal, CORE_VALIDATION_EXPERIMENT_V3);
  }

  /** v4 is the fourth independent frozen experiment for an explicit owner
   * decision (create-only delegationDepth trusted-field canonicalization
   * prepared). It is NOT a retry of the failed v1/v2/v3 creates and never
   * accepts input selection; it reuses the same single-slot, paused/idle,
   * bounded, no-retry runner and only changes the frozen experiment constant. */
  private async commandCoreGoalValidationV4(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.commandCoreGoalValidationRun(value, signal, CORE_VALIDATION_EXPERIMENT_V4);
  }

  /** v5 is the fifth independent frozen experiment for an explicit owner
   * decision (decision pre-step claim fix + first evaluation reason preservation
   * prepared). It is NOT a retry of the failed v1-v4 creates and never accepts
   * input selection; it reuses the same single-slot, paused/idle, bounded,
   * no-retry runner and only changes the frozen experiment constant. */
  private async commandCoreGoalValidationV5(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.commandCoreGoalValidationRun(value, signal, CORE_VALIDATION_EXPERIMENT_V5);
  }

  /** v6 is the sixth independent frozen experiment for an explicit owner
   * decision (host runtime-context projection binding alignment + field-level
   * context diagnostic prepared). It is NOT a retry of the failed v1-v5 creates
   * and never accepts input selection; it reuses the same single-slot,
   * paused/idle, bounded, no-retry runner and only changes the frozen
   * experiment constant. */
  private async commandCoreGoalValidationV6(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.commandCoreGoalValidationRun(value, signal, CORE_VALIDATION_EXPERIMENT_V6);
  }

  /** v7 is a new frozen experiment for an explicit owner decision; it is NOT a
   * retry of v1-v6 and its stream diagnostics never trigger automatic retries. */
  private async commandCoreGoalValidationV7(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.commandCoreGoalValidationRun(value, signal, CORE_VALIDATION_EXPERIMENT_V7);
  }

  private async commandCoreGoalValidationRun(value: Record<string, unknown>, signal: AbortSignal | undefined, experiment: typeof CORE_VALIDATION_EXPERIMENT | undefined): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid bounded core Goal validation input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (!this.core) throw new Error('CORE_GOAL_VALIDATION_UNAVAILABLE');
    if ([...this.operations.values()].some(op => op.phase === 'bounded core goal validation')) throw new Error('Bounded core Goal validation is already running');
    if (this.operations.size + this.pendingAdmissions !== 0) {
      throw new Error('Bounded core Goal validation requires an idle runtime with no other active operation');
    }
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '有界真实 core Goal 业务链验证', phase: 'bounded core goal validation',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      const core = this.core;
      const receipt = await runBoundedCoreValidation({
        core,
        store: this.store as unknown as CoreValidationStore,
        // The probe owns the single exclusive runtime slot; each bounded model
        // round goes through the core service under the same paused admission.
        // Queued worker Tasks are scheduled through the normal runtime scanner
        // after each round (never by a second operation slot of this command).
        evaluate: async input => {
          const result = await core.evaluatePending({ signal: input.signal });
          await this.scheduleQueuedTasks();
          return result;
        },
        signal: op.controller.signal,
        progress: phase => { op.phase = phase.slice(0, 120); },
        ...(experiment === undefined ? {} : { experiment }),
      });
      this.lastCoreGoalValidation = structuredClone(receipt);
      return { ...receipt, sent: false, readOnlyProbe: false,
        declaredSideEffects: { goal: true, task: true, effect: true, budget: true, session: true, artifact: true, realModelCalls: true } };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /**
   * Owner-only, read-only classification of the one fixed core-validation Goal,
   * with at most one explicit `core.control('cancel')` for an inert unauthorized
   * partial Goal. It never creates/resumes a Goal, never calls a model, never
   * retries and never writes around the trusted core service. The receipt is
   * cached only in snapshot diagnostics. Paused runtimes are rejected.
   */
  /**
   * Owner-only ZERO-MODEL native Session header-cut diagnostic. It creates
   * exactly one bare lifecycle Session with the managed core Goal preset/cwd/meta,
   * compares the persisted cold header with the live header field by field, then
   * cancels/disposes/archives that Session. It creates no Goal/Task/Effect/budget,
   * writes no business store entry, calls no model or embedding, retries nothing
   * and caches only the bounded receipt in snapshot diagnostics. Paused runtimes
   * and non-idle slots are rejected before any native Session is created.
   */
  private async commandNativeHeaderCutProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid native header-cut probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('NATIVE_HEADER_CUT_UNAVAILABLE');
    if ([...this.operations.values()].some(op => op.phase === 'native header-cut probe')) {
      throw new Error('Native header-cut probe is already running');
    }
    assertNativeHeaderCutAdmission({ paused: this.pauseRequested, operations: this.operations.size,
      capacity: 1, sameActionRunning: false });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '原生 Session header-cut 零模型诊断', phase: 'native header-cut probe',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      const cwd = await artifacts.prepareWorkspace(`native-header-cut-probe-${randomUUID().slice(0, 24)}`);
      signal?.throwIfAborted();
      const receipt = await probeNativeHeaderCut({ ctx: this.ctx, cwd, preset: CORE_GOAL_PRESET_ID, signal: op.controller.signal });
      this.lastNativeHeaderCutProbe = structuredClone(receipt);
      return receipt;
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  private async commandCoreValidationReconcile(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid core-validation reconcile input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (!this.core) throw new Error('CORE_VALIDATION_RECONCILE_UNAVAILABLE');
    if ([...this.operations.values()].some(op => op.phase === 'core-validation goal reconcile')) throw new Error('Core-validation Goal reconciliation is already running');
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '核对有界 core 验证 Goal', phase: 'core-validation goal reconcile',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      const receipt = await reconcileCoreValidationGoal({ core: this.core, store: this.store as unknown as CoreValidationStore,
        signal: op.controller.signal, progress: phase => { op.phase = phase.slice(0, 120); } });
      this.lastCoreValidationReconcile = structuredClone(receipt);
      return { ...receipt, readOnly: true, createsGoal: false, modelCalls: 0, retries: 0 };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  private async record(type: string, message: string, status: string): Promise<void> {
    await this.events.publish(principal, { type, scope: OWN_SCOPE, payload: { message, status }, idempotencyKey: randomUUID(), correlationId: this.instanceId });
    // This component's only effect is a readable event-backed activity projection.
    // A crash before acknowledgement is safe to retry; no external effect occurs.
    for (const delivery of await this.events.claim(principal, { consumerId: 'runtime.activity', deliveryMode: 'component', subscriptionId: 'runtime-activity', limit: 50, leaseMs: 30000 })) {
      await this.events.ack(principal, { deliveryId: delivery.deliveryId, claimToken: delivery.claimToken });
    }
  }
  private async coreSnapshot() {
    if (!this.core) return { ready: false, errorCode: this.coreFailure ?? 'CORE_UNAVAILABLE', goals: [] };
    try {
      const goals = await this.store.request('core.snapshot', {});
      const entries = await Promise.all(goals.map(async goal => {
        const [evaluations, balance, binding] = await Promise.all([
          this.store.request('core.evaluations', { goalId: goal.goalId }), this.store.request('core.balance', { goalId: goal.goalId }),
          this.store.request('goal.binding.load', { goalId: goal.goalId }),
        ]);
        return { ...publicCoreGoal(goal), ...(balance ? { balance } : {}),
          ...(binding?.receipt ? { nativeCommand: { commandId: binding.receipt.commandId, operation: binding.receipt.operation, status: binding.receipt.status } } : {}),
          evaluationsLog: evaluations.map(item => ({
          evaluationId: item.evaluationId, status: item.status, triggerRefs: item.triggerRefs,
          ...(item.candidate ? { candidate: item.candidate } : {}), ...(item.receipt ? { receipt: item.receipt } : {}),
          ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}), ...(item.dispatch ? { sessionId: item.dispatch.sessionId } : {}),
          usage: { complete: item.reservation.state === 'settled', tokens: item.reservation.observed.tokens ?? null, calls: item.reservation.observed.calls ?? null },
        })) };
      }));
      return { ready: true, unresolved: entries.filter(goal => goal.nativeCommand?.status === 'unknown' || goal.nativeCommand?.status === 'pending'
        || goal.evaluationsLog.some(item => item.status === 'unknown')).length,
        ...(this.corePump ? { pump: this.corePump.snapshot() } : {}), goals: entries };
    } catch { return { ready: false, errorCode: 'CORE_SNAPSHOT_UNAVAILABLE', goals: [] }; }
  }
  private async labSnapshot() {
    if (!this.lab) return { ready: false, errorCode: this.labFailure ?? 'LAB_UNAVAILABLE', connections: [] };
    try { return await this.lab.snapshot(); }
    catch { return { ready: false, errorCode: 'LAB_SNAPSHOT_UNAVAILABLE', connections: [] }; }
  }
  private async abilitySnapshot() {
    try { return { ready: true as const, snapshot: await this.store.request('ability.snapshot', {}) }; }
    catch { return { ready: false as const, errorCode: 'CAPABILITY_STATE_UNAVAILABLE' }; }
  }
  private commandAbility(value: Record<string, unknown>, signal?: AbortSignal): Promise<CapabilityCommandReceipt> {
    if (Object.keys(value).some(key => !['action', 'requestId', 'expectedRevision', 'enabled'].includes(key))
      || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId)
      || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1 || typeof value.enabled !== 'boolean') {
      throw new Error('Invalid capability control command');
    }
    signal?.throwIfAborted();
    const command = this.controlTail.then(async () => {
      this.ensureOpen(); signal?.throwIfAborted();
      const receipt = await this.store.request('ability.setEnabled', { requestId: value.requestId as string,
        expectedRevision: value.expectedRevision as number, enabled: value.enabled as boolean });
      // An idempotent receipt may describe an older revision. Never apply its old
      // state to the current runtime; only the current committed barrier controls dispatch.
      const current = await this.store.request('ability.snapshot', {});
      if (!current.enabled) {
        const tasks = await this.store.request('task.list', {});
        for (const task of tasks) this.operations.get(task.taskId)?.controller.abort(new Error('Local-note capability disabled'));
      } else if (receipt.changed && receipt.snapshot.revision === current.revision && !this.pauseRequested) {
        // A fresh owner enable may release never-dispatched queued tasks. Unknown
        // or completed work is excluded and remains under the recovery protocol.
        for (const task of await this.store.request('task.list', {})) if (task.state === 'queued') this.attemptedTasks.delete(task.taskId);
        await this.scheduleQueuedTasks();
        void this.corePump?.wake();
      }
      return receipt;
    });
    this.controlTail = command.then(() => undefined, () => undefined);
    return command;
  }
  async snapshot() {
    this.ensureOpen();
    const [info, stats, recent, subscriptions, sessions, tasks, conversations, innerProjection, core, lab, ability, channelProjection] = await Promise.all([
      this.store.info(), this.events.stats(principal), this.events.listEvents(principal, { limit: 40 }),
      this.events.listSubscriptions(principal), this.sessions.getStatus(),
      this.store.request('task.list', {}),
      this.store.request('conversation.snapshotLocal', {}),
      this.store.request('view.state', {}),
      this.coreSnapshot(),
      this.labSnapshot(),
      this.abilitySnapshot(),
      this.channels.snapshot(),
    ]);
    const at = new Date().toISOString();
    const probe = this.state.state.lastProbe;
    const verification = this.state.state.lastModelVerification;
    const goalVerification = this.state.state.lastGoalVerification;
    const backgroundState = this.background.snapshot();
    const memoryBackend = this.memoryBackend?.status();
    let memoryError = this.memoryFailure;
    let memoryEntries: ReturnType<typeof memoryEntry>[] = [];
    if (this.memoryConfig) {
      try { memoryEntries = (await this.store.request('memory.list', {})).map(memoryEntry); }
      catch { memoryError ??= 'MEMORY_DOMAIN_UNAVAILABLE'; }
    }
    const memoryReady = Boolean(this.localMemories && memoryBackend?.state === 'ready' && !memoryError);
    return {
      schemaVersion: 1, version: VERSION, instanceId: this.instanceId, startedAt: this.startedAt, observedAt: at,
      lifecycle: this.lastFailure || memoryError || this.semanticFailure || !core.ready || !lab.ready || ('unresolved' in core && core.unresolved) || ('pump' in core && core.pump?.state === 'degraded') || ('pump' in lab && lab.pump?.state === 'degraded') || memoryBackend?.state === 'failed' || backgroundState.state === 'degraded' || conversations.background.failed > 0 ? 'degraded' : 'ready',
      state: this.pauseRequested ? 'paused' : this.operations.size ? 'busy' : 'idle',
      systems: structuredClone(systems),
      tasks,
      core,
      lab,
      ability,
      channels: channelProjection,
      conversations: conversations.conversations,
      innerProjection: innerProjection ?? null,
      memory: { configured: Boolean(this.memoryConfig) || Boolean(this.memoryFailure), ready: memoryReady,
        semanticConfigured: Boolean(this.memorySearch),
        ...(this.semanticFailure ? { semanticErrorCode: this.semanticFailure } : {}),
        ...(this.lastSemanticOperation ? { lastSemanticOperation: structuredClone(this.lastSemanticOperation) } : {}),
        ...(memoryError ? { errorCode: memoryError } : {}), ...(memoryBackend ? { backend: memoryBackend } : {}),
        ...(memoryBackend ? { readiness: this.memoryReadiness ?? computeMemoryReadiness({ backend: memoryBackend, coverage: this.memoryCoverage, semanticConfigured: Boolean(this.memorySearch) }) } : {}),
        ...(this.memoryCoverage ? { indexCoverage: structuredClone(this.memoryCoverage) } : {}), entries: memoryEntries },
      diagnostics: { contextVerification: this.state.state.lastContextVerification ? structuredClone(this.state.state.lastContextVerification) : null,
        contextSafety: structuredClone(this.contextSafety),
        eventToolProbe: this.lastEventToolProbe ? structuredClone(this.lastEventToolProbe) : null,
        coreEventToolProbe: this.lastCoreEventToolProbe ? structuredClone(this.lastCoreEventToolProbe) : null,
        coreModelToolProbe: this.lastCoreModelToolProbe ? structuredClone(this.lastCoreModelToolProbe) : null,
        coreGoalValidation: this.lastCoreGoalValidation ? structuredClone(this.lastCoreGoalValidation) : null,
        nativeHeaderCutProbe: this.lastNativeHeaderCutProbe ? structuredClone(this.lastNativeHeaderCutProbe) : null,
        coreValidationReconcile: this.lastCoreValidationReconcile ? structuredClone(this.lastCoreValidationReconcile) : null,
        timeSource: this.timePump ? this.timePump.snapshot() : null,
        timeSourceProbe: this.lastTimeSourceProbe ? structuredClone(this.lastTimeSourceProbe) : null,
        timeTriggerProbe: this.lastTimeTriggerProbe ? structuredClone(this.lastTimeTriggerProbe) : null,
        notifications: this.notificationRouter ? { enabled: true } : { enabled: false },
        checkpointProbe: this.checkpointProbeReceipt ? structuredClone(this.checkpointProbeReceipt) : null,
        // Diagnostics-only projection; never a publication, authorization or completion fact.
        innerLifecycleProbe: this.innerLifecycleProbeReceipt ? structuredClone(this.innerLifecycleProbeReceipt) : null,
        startupEmbeddingVerification: this.startupEmbeddingReceipt ? structuredClone(this.startupEmbeddingReceipt) : null,
        singleUserChatMemoryProbe: this.chatMemoryProbeReceipt ? structuredClone(this.chatMemoryProbeReceipt) : null,
        emotionContinuationProbe: this.emotionProbeReceipt ? structuredClone(this.emotionProbeReceipt) : null },
      background: { ...conversations.background, ...backgroundState },
      activeWork: [...this.operations.values()].map(({ controller: _controller, done: _done, finish: _finish, ...op }) => op),
      activities: recent.slice().sort((a, b) => b.sequence - a.sequence).map(event => ({ id: event.eventId, at: event.receivedAt, kind: event.type, title: String(event.payload.message ?? event.type), status: String(event.payload.status ?? 'accepted') })),
      sessions: sessions.map(s => ({ id: s.sessionId, role: s.role, businessId: s.businessId, status: s.status, hostStatus: s.hostStatus,
        provider: s.model.provider, model: s.model.model, effort: s.model.reasoningEffort, lastActivityAt: s.updatedAt,
        usage: { inputTokens: s.usage.inputTokens ?? null, outputTokens: s.usage.outputTokens ?? null, cacheReadTokens: s.usage.cacheReadTokens ?? null } })),
      events: { published: stats.events, pending: stats.pending + stats.claimed, failed: stats.failed,
        subscriptions: subscriptions.map(s => ({ id: s.id, type: s.types.join(', '), status: s.status, target: s.target.kind === 'component' ? s.target.handlerRef : s.target.bindingId })),
        recent: recent.slice().sort((a, b) => b.sequence - a.sequence).map(e => ({ id: e.eventId, type: e.type, at: e.receivedAt, status: 'accepted' })) },
      dependencies: [
        { id: 'control-store', name: '控制账本', status: 'available', summary: `SQLite ${info.sqliteVersion} · ${info.journalMode} · 独立线程`, checkedAt: at },
        { id: 'native-session', name: 'DSH 原生会话', status: probe?.instanceId === this.instanceId ? (probe.ok ? 'available' : 'unavailable') : 'unknown', summary: probe ? `${probe.instanceId === this.instanceId ? '' : '上次运行的检查记录，本次尚未检查：'}${probe.message}` : '尚未执行会话连接检查', ...(probe?.at ? { checkedAt: probe.at } : {}) },
        { id: 'model', name: '生成模型', status: verification?.instanceId === this.instanceId ? (verification.ok ? 'available' : 'unavailable') : 'unknown', summary: verification ? `${verification.instanceId === this.instanceId ? '' : '上次运行的验证记录：'}${verification.message}` : '配置为 opencode-go / deepseek-v4.1-flash；连接检查不代表推理可用。', ...(verification?.at ? { checkedAt: verification.at } : {}) },
        { id: 'native-goal', name: 'DSH 原生 Goal', status: goalVerification?.instanceId === this.instanceId ? (goalVerification.ok ? 'available' : 'unavailable') : 'unknown', summary: goalVerification ? `${goalVerification.instanceId === this.instanceId ? '' : '上次运行的验证记录：'}${goalVerification.message}` : '尚未验证原生 Goal 生命周期；查看页面不会创建或恢复目标会话。', ...(goalVerification?.at ? { checkedAt: goalVerification.at } : {}) },
        { id: 'native-context', name: '原生上下文接线', status: this.contextSafety.ready ? 'available' : 'unavailable', summary: this.contextSafety.ready ? '消息工厂与原生持久化接口已加载；不代表上下文已实际加载或模型已验证。' : this.contextSafety.error ?? '上下文接线尚未准备', checkedAt: this.startedAt },
        { id: 'memory', name: '长期记忆', status: memoryReady ? 'available' : this.memoryConfig || memoryError ? 'unavailable' : 'unconfigured',
          summary: memoryReady ? this.memorySearch ? '受控存取、独立索引与同会话语义读取已接线；embedding 实测及索引覆盖按实际回执显示。' : '受控原生存取与精确读取已连接；语义检索未配置。' : memoryError ?? (this.memoryConfig ? '受控记忆等待启动或连接核对' : '尚未配置受控记忆服务') },
        { id: 'channels', name: 'Lab 频道', status: lab.connections.some(connection => connection.live && connection.status === 'connected') ? 'available' : lab.ready ? 'unconfigured' : 'unavailable',
          summary: lab.ready ? '支持显式连接获准 Lab 群聊与私聊；刷新不访问房间、创建会话或发送消息。' : lab.errorCode ?? 'Lab 接线不可用' },
      ],
      // Session-level records are shown above. An incomplete aggregate is unknown,
      // rather than summing only the measured requests and presenting a false zero.
      usage: { calls: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
      notices: [
        { id: 'scope', level: 'info', message: '已接入原生会话、事件、本地任务、记忆读取与受控 Lab 对话；core 仅在显式目标范围和共享预算内选择已授权事项，开放式规划、其余内层状态及真实外部渠道仍待接入。' },
        ...(this.pauseRequested ? [{ id: 'paused', level: 'info', message: '已暂停新的模型操作；已发生效果不会因暂停回滚。' }] : []),
        ...(this.lastFailure ? [{ id: 'operation', level: 'warning', message: this.lastFailure }] : []),
        ...(backgroundState.lastFailure ? [{ id: 'background', level: 'warning', message: `对话背景处理待核对：${backgroundState.lastFailure}` }] : []),
        ...(conversations.background.failed > 0 ? [{ id: 'background-failed', level: 'warning', message: `${conversations.background.failed} 条背景事件投递已停止重试，需要核对；空闲扫描不会清除失败记录。` }] : []),
      ],
    };
  }
  async command(input: unknown, signal?: AbortSignal): Promise<unknown> {
    this.ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected command object');
    const value = input as Record<string, unknown>;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) throw new Error('Expected command data fields');
    const action = fields.action?.value;
    if (action === 'ability.setEnabled') return this.commandAbility(value, signal);
    if (action === 'lab.connect' || action === 'lab.pause' || action === 'lab.disconnect' || action === 'lab.reconcile') return this.commandLab(value, signal);
    if (action === 'core.create' || action === 'core.pause' || action === 'core.resume' || action === 'core.cancel') return this.commandCore(value, signal);
    if (action === 'memory.rememberLocal' || action === 'memory.readLocal' || action === 'memory.withdrawLocal') return this.commandLocalMemory(value, signal);
    if (action === 'memory.indexLocal' || action === 'memory.searchLocal') return this.commandSemanticMemory(value, signal);
    if (action === 'runtime.probe-event-tools') return this.commandEventToolProbe(value, signal);
    if (action === 'runtime.probe-core-event-tools') return this.commandCoreEventToolProbe(value, signal);
    if (action === 'runtime.probe-core-model-tools') return this.commandCoreModelToolProbe(value, signal);
    if (action === 'runtime.probe-core-goal') return this.commandCoreGoalValidation(value, signal);
    if (action === 'runtime.probe-core-goal-v2') return this.commandCoreGoalValidationV2(value, signal);
    if (action === 'runtime.probe-core-goal-v3') return this.commandCoreGoalValidationV3(value, signal);
    if (action === 'runtime.probe-core-goal-v4') return this.commandCoreGoalValidationV4(value, signal);
    if (action === 'runtime.probe-core-goal-v5') return this.commandCoreGoalValidationV5(value, signal);
    if (action === 'runtime.probe-core-goal-v6') return this.commandCoreGoalValidationV6(value, signal);
    if (action === 'runtime.probe-core-goal-v7') return this.commandCoreGoalValidationV7(value, signal);
    if (action === 'runtime.probe-native-header-cut') return this.commandNativeHeaderCutProbe(value, signal);
    if (action === 'runtime.probe-memory-embedding') return this.commandMemoryEmbeddingProbe(value, signal);
    if (action === CHAT_MEMORY_PROBE_ACTION) return this.commandChatMemoryProbe(value, signal);
    if (action === 'runtime.reconcile-core-validation-goal') return this.commandCoreValidationReconcile(value, signal);
    if (action === 'runtime.probe-time-source') return this.commandTimeSourceProbe(value, signal);
    if (action === 'runtime.probe-time-trigger') return this.commandTimeTriggerProbe(value, signal);
    if (action === 'runtime.pause') return this.setPaused(true);
    if (action === 'runtime.resume') return this.setPaused(false);
    // H5b: owner-only local checkpoint. Dispatched before ensureCanRun() so a
    // paused runtime can still snapshot local state (no model/dispatch side
    // effects); the handler validates the exact fields, is single-flight and
    // performs at most one capture attempt per explicit command.
    if (action === 'runtime.checkpoint.capture') return this.commandCheckpoint(value, signal);
    // H5b-probe: read-only availability receipt, dispatched before ensureCanRun()
    // so a paused runtime can still be diagnosed without model/dispatch effects.
    if (action === 'runtime.checkpoint.probe') return this.commandCheckpointProbe(value, signal);
    if (action === INNER_LIFECYCLE_PROBE_ACTION) return this.commandInnerLifecycleProbe(value, signal);
    if (action === EMOTION_PROBE_ACTION) return this.commandEmotionProbe(value, signal);
    if (action === 'conversation.linkLocalTask') {
      this.ensureCanRun(); signal?.throwIfAborted();
      if (Object.keys(value).some(key => !['action', 'taskId', 'localConversationKey'].includes(key))
        || typeof value.taskId !== 'string' || !/^[a-f0-9]{32}$/.test(value.taskId)
        || (value.localConversationKey !== undefined && (typeof value.localConversationKey !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.localConversationKey)))) throw new Error('Invalid local conversation input');
      if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
      this.pendingAdmissions++;
      let finishAdmission!: () => void;
      const admission = new Promise<void>(resolve => { finishAdmission = resolve; });
      this.admissions.add(admission);
      try {
        const entry = await this.store.request('conversation.ensureLocalTask', { taskId: value.taskId, ...(value.localConversationKey === undefined ? {} : { localConversationKey: value.localConversationKey as string }) });
        // Once committed, the association belongs to the runtime, not this HTTP
        // request. Its pending Event delivery survives pause, close and restart.
        if (!this.closed && !this.closing) void this.background.wake();
        return { accepted: true, taskId: value.taskId, conversationId: entry.conversationId, bindingId: entry.bindingId };
      } finally { this.pendingAdmissions--; this.admissions.delete(admission); finishAdmission(); }
    }
    if (action === 'task.createLocal') {
      this.ensureCanRun(); signal?.throwIfAborted();
      if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
      if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.requestId) || typeof value.title !== 'string' || typeof value.content !== 'string') throw new Error('Invalid local task input');
      this.pendingAdmissions++;
      let finishAdmission!: () => void;
      const admission = new Promise<void>(resolve => { finishAdmission = resolve; });
      this.admissions.add(admission);
      try {
        const detail = await this.store.request('task.createLocal', { requestId: value.requestId, title: value.title, content: value.content });
        // A durable receipt remains accepted if pause/unload arrived while the
        // transaction was in flight. Only dispatch is deferred.
        if (!this.closed && !this.closing && !this.pauseRequested && detail.task.state === 'queued' && !this.operations.has(detail.task.taskId)) this.startTask(detail.task.taskId, detail.task.title);
        return { accepted: true, task: detail.task };
      } finally { this.pendingAdmissions--; this.admissions.delete(admission); finishAdmission(); }
    }
    if (action === 'task.cancel') {
      if (typeof value.taskId !== 'string') throw new Error('Invalid task identity');
      const task = await this.store.request('task.cancel', { taskId: value.taskId, reason: 'Owner requested cancellation' });
      this.operations.get(value.taskId)?.controller.abort();
      return { accepted: true, task };
    }
    if (action === 'conversation.replyLocal' || action === 'conversation.verifyContext' || action === 'conversation.loadContext') return this.commandLocalReply(value, signal);
    if (action !== 'session.probe' && action !== 'reply.generate' && action !== 'session.verify-model' && action !== 'goal.verify-lifecycle') throw new Error('Unsupported runtime command');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    if (action === 'reply.generate' && (typeof value.businessId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.businessId) || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000)) throw new Error('Invalid reply input');
    if (action === 'goal.verify-lifecycle' && (typeof value.taskId !== 'string' || !/^[a-f0-9]{32}$/.test(value.taskId) || Object.keys(value).some(key => !['action', 'taskId'].includes(key)))) throw new Error('Invalid Goal validation input');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    if (action === 'session.verify-model' && [...this.operations.values()].some(op => op.phase.startsWith('模型验证'))) throw new Error('Model verification is already running');
    if (action === 'goal.verify-lifecycle' && [...this.operations.values()].some(op => op.phase.startsWith('目标验证'))) throw new Error('Goal verification is already running');
    const op: ActiveOperation = { id: randomUUID(), title: action === 'goal.verify-lifecycle' ? '检查原生目标生命周期' : action === 'session.probe' ? '检查原生会话连接' : action === 'session.verify-model' ? '验证生成模型与原生会话复用' : '生成只读回复草稿', phase: action === 'goal.verify-lifecycle' ? '目标验证：核对已完成任务' : action === 'session.probe' ? '创建并释放受限会话' : action === 'session.verify-model' ? '模型验证 0/2' : '等待模型结果', status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    const verificationUsage: ReplyResult['usage'][] = [];
    let verificationCalls = 0;
    try {
      if (action === 'goal.verify-lifecycle') {
        const result = await this.goals.run(value.taskId as string, { signal: op.controller.signal, progress: phase => { op.phase = `目标验证：${phase}`; } });
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        await this.state.update(state => { state.lastGoalVerification = { at: new Date().toISOString(), ok: true, instanceId: this.instanceId, goalId: result.goalId, sessionId: result.sessionId, message: '原生 Goal 创建、暂停、恢复及独立证据完成通过；未请求模型推理。' }; });
        await this.record('runtime.goal.verified', '原生目标生命周期与独立完成证据验证通过', 'succeeded');
        this.lastFailure = undefined; return result;
      }
      if (action === 'session.probe') {
        const result = await this.sessions.probe();
        op.controller.signal.throwIfAborted();
        await this.state.update(state => { state.lastProbe = { at: new Date().toISOString(), ok: true, message: '原生受限会话创建、工具检查、释放与归档通过；未调用模型。', instanceId: this.instanceId }; });
        await this.record('runtime.session.probed', '原生会话连接检查通过，未调用模型', 'succeeded');
        this.lastFailure = undefined; return result;
      }
      if (action === 'session.verify-model') {
        const marker = `SHIYU_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        const shared = { businessId: 'model-verification', scope: 'synthetic-model-verification', signal: op.controller.signal, maxTokens: 1024 };
        op.phase = '模型验证 1/2'; verificationCalls++;
        const first = await this.sessions.generateReply({ ...shared, prompt: `这是合成会话接入验证。请在本会话中记住校验代号 ${marker}。本轮只回复“已记住”，下一轮若问代号，只输出代号。` });
        verificationUsage.push(first.usage);
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        op.phase = '模型验证 2/2'; verificationCalls++;
        const second = await this.sessions.generateReply({ ...shared, prompt: '上一轮的校验代号是什么？只输出代号，不加解释。' });
        verificationUsage.push(second.usage);
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        if (first.binding.sessionId !== second.binding.sessionId || second.text.trim() !== marker) throw new Error('Model verification did not confirm the expected native Session history');
        await this.state.update(state => { state.lastModelVerification = { at: new Date().toISOString(), ok: true, instanceId: this.instanceId, calls: verificationCalls, sessionId: second.binding.sessionId, usage: verificationUsage, message: '两轮合成输入验证通过；同一原生 Session 保留代号，opencode-go / deepseek-v4.1-flash / low。缓存数据仅按宿主实际报告显示。' }; });
        await this.record('runtime.model.verified', '生成模型与两轮原生会话复用验证通过', 'succeeded');
        this.lastFailure = undefined;
        return { verified: true, calls: verificationCalls, sameSession: true, sessionId: second.binding.sessionId, model: second.binding.model, usage: verificationUsage, sent: false };
      }
      const result = await this.sessions.generateReply({ businessId: value.businessId as string, scope: 'local-owner', prompt: value.prompt as string, signal: op.controller.signal });
      if (this.pauseRequested || op.controller.signal.aborted || this.closed) throw new Error('Reply cancelled before release');
      this.lastFailure = undefined;
      return { ...result, status: 'draft', sent: false };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      if (action === 'session.probe') await this.state.update(state => { state.lastProbe = { at: new Date().toISOString(), ok: false, message: this.lastFailure!, instanceId: this.instanceId }; });
      if (action === 'session.verify-model') await this.state.update(state => { state.lastModelVerification = { at: new Date().toISOString(), ok: false, message: this.lastFailure!, instanceId: this.instanceId, calls: verificationCalls, usage: verificationUsage }; });
      if (action === 'goal.verify-lifecycle') await this.state.update(state => { state.lastGoalVerification = { at: new Date().toISOString(), ok: false, message: this.lastFailure!, instanceId: this.instanceId }; });
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /** Lazily create the H5b composition on the first explicit owner command only. */
  private async checkpointComposition(): Promise<RuntimeCheckpointComposition | undefined> {
    if (this.checkpoint) return this.checkpoint;
    const stagingRoot = this.options.checkpointStagingRoot;
    const runtimeManifest = this.options.checkpointRuntimeManifest;
    // Absent trusted composition inputs keep the command explicitly unavailable;
    // never fall back to a temp directory or guess a host version.
    if (!stagingRoot || !runtimeManifest) return undefined;
    if (!this.state.state.installationGeneration) throw new Error('CHECKPOINT_GENERATION_UNAVAILABLE');
    try {
      const persistence = this.ctx.get('sessionPersistence');
      // Candidate, non-contract resolver: the installed JSONL backend exposes a
      // diagnostic resolveCurrentLog; the provider-neutral contract does not.
      const resolver = detectSessionPersistenceLogResolver(persistence);
      this.checkpoint = await createRuntimeCheckpointComposition({
        dataDir: this.dataDir,
        stagingRoot,
        controlStore: this.store,
        generation: { installationGeneration: this.state.state.installationGeneration, hostEpoch: this.instanceId },
        runtimeManifest,
        goalSessions: {
          ...(resolver ? { resolver } : {}),
          // Public sessions service: exact session object + acknowledged flush.
          flushSession: async (sessionId: string) => {
            const sessions = this.ctx.get('sessions');
            if (typeof sessions?.get !== 'function' || typeof sessions?.flush !== 'function') return false;
            let session: unknown;
            try { session = sessions.get(sessionId); } catch { return false; }
            if (!session) return false;
            return (await sessions.flush(session)) === true;
          },
        },
      });
      this.checkpointFailure = undefined;
      return this.checkpoint;
    } catch (error) {
      this.checkpointFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Owner-only checkpoint command. Never called by a GET/snapshot path. */
  private async commandCheckpoint(value: Record<string, unknown>, signal?: AbortSignal): Promise<RuntimeCheckpointCommandResult> {
    this.ensureOpen();
    if (!this.checkpointCommand) throw new Error('CHECKPOINT_UNAVAILABLE');
    return this.checkpointCommand.handle(value, signal);
  }

  /** Owner-only read-only checkpoint availability command. */
  private async commandCheckpointProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<CheckpointProbeResult> {
    this.ensureOpen();
    if (!this.checkpointProbeCommand) throw new Error('CHECKPOINT_UNAVAILABLE');
    return this.checkpointProbeCommand.handle(value, signal);
  }

  /** Owner-only zero-model isolated lifecycle probe (same admission as
   * session.probe: open and unpaused, single slot, abortable, no automatic retry).
   * It validates the exact command shape, never receives a live path, and stores
   * only the validated receipt in snapshot diagnostics. */
  private async commandInnerLifecycleProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<InnerLifecycleProbeReceipt> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid inner lifecycle probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (!this.innerLifecycleProbeCommand) throw new Error('INNER_LIFECYCLE_PROBE_UNAVAILABLE');
    const receipt = await this.innerLifecycleProbeCommand.handle(value, signal);
    this.lastFailure = undefined;
    return receipt;
  }

  /** Owner-only zero-model emotion-continuation probe: same admission as session.probe. */
  private async commandEmotionProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<EmotionProbeReceipt> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid emotion probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (!this.emotionProbeCommand) throw new Error('EMOTION_PROBE_UNAVAILABLE');
    const receipt = await this.emotionProbeCommand.handle(value, signal);
    this.lastFailure = undefined;
    return receipt;
  }

  private async commandLab(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.lab) throw new Error('LAB_UNAVAILABLE');
    const action = value.action;
    const keys = action === 'lab.connect' ? ['action', 'requestId', 'runId', 'targetToken', 'channelIds', 'budget', 'expiresAt']
      : action === 'lab.reconcile' ? ['action', 'connectionId', 'sendId', 'expectedVersion'] : ['action', 'connectionId', 'expectedVersion'];
    if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new Error('LAB_INVALID_INPUT');
    const { action: _action, ...args } = value;
    try {
      if (action === 'lab.connect') {
        // The coordinator distinguishes a fresh model grant from an exact
        // historical intent used only to attach a receipt-reading transport.
        // The latter must remain reachable during pause and context failure.
        signal?.throwIfAborted();
        return await this.lab.connect(args as unknown as LabOwnerConnectInput, signal);
      }
      // Stops and read-only observations remain available while globally paused.
      if (action === 'lab.pause') return await this.lab.pause(args as unknown as LabOwnerControlInput);
      if (action === 'lab.disconnect') return await this.lab.disconnect(args as unknown as LabOwnerControlInput);
      return await this.lab.reconcile(args as unknown as LabOwnerReconcileInput, signal);
    } catch (error) {
      // Transport/native errors must never echo the private target token or text.
      const safeCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'LAB_OPERATION_UNCONFIRMED';
      throw new Error(safeCode);
    }
  }
  private async commandCore(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.core) throw new Error('Core control is unavailable');
    signal?.throwIfAborted();
    const create = value.action === 'core.create';
    const kind = create ? undefined : String(value.action).slice('core.'.length) as 'pause' | 'cancel' | 'resume';
    const keys = create ? ['action', 'requestId', 'objective', 'deliverables', 'budget', 'expiresAt', 'maxEvaluations'] : ['action', 'goalId', 'expectedVersion'];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(descriptors).some(key => !keys.includes(key))
      || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value'))
      || (!create && (typeof value.goalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,149}$/.test(value.goalId)
        || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1))) throw new Error('Invalid core owner command');
    const stop = kind === 'pause' || kind === 'cancel';
    if (!stop) {
      this.ensureCanRun();
      if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    } else if (this.operations.size >= 32) throw new Error('Runtime control capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: create ? '建立有范围的持续目标' : kind === 'resume' ? '恢复目标授权' : kind === 'cancel' ? '停止目标' : '暂停目标',
      phase: create ? '登记范围并核对原生 Goal' : '更新停止屏障并核对原生状态', status: 'running', controller: new AbortController(), done, finish };
    const abort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); this.operations.set(op.id, op);
    try {
      let goal: CoreGoal;
      if (create) {
        const { action: _action, ...input } = value;
        goal = await this.core.create(structuredClone(input) as unknown as CorePrepareInput, op.controller.signal);
      } else goal = await this.core.control(kind!, { goalId: value.goalId as string, expectedVersion: value.expectedVersion as number }, op.controller.signal);
      return { goal: publicCoreGoal(goal) };
    } finally {
      this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', abort);
      if (!this.closed && !this.closing && !this.pauseRequested) {
        void this.corePump?.wake();
        void this.scheduleQueuedTasks().catch(error => { this.lastFailure = error instanceof Error ? error.message : String(error); });
      }
    }
  }
  private async evaluateCore(signal: AbortSignal): Promise<CoreEvaluationResult> {
    if (!this.core || this.closed || this.closing || this.pauseRequested || this.operations.size + this.pendingAdmissions >= 2) return { status: 'idle' };
    this.ensureCanRun(); signal.throwIfAborted();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: `core-${randomUUID()}`, title: '判断目标的下一步', phase: '复核目标、触发与共享预算', status: 'running',
      controller: new AbortController(), done, finish };
    const abort = () => op.controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true }); this.operations.set(op.id, op);
    try { return await this.core.evaluatePending({ signal: op.controller.signal }); }
    finally {
      this.operations.delete(op.id); op.finish(); signal.removeEventListener('abort', abort);
      if (!this.closed && !this.closing) await this.scheduleQueuedTasks();
    }
  }
  private async commandLocalMemory(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const save = value.action === 'memory.rememberLocal', withdraw = value.action === 'memory.withdrawLocal';
    const keys = save ? ['action', 'requestId', 'conversationId', 'text'] : withdraw ? ['action', 'requestId', 'operationId'] : ['action', 'operationId'];
    const fields = Object.getOwnPropertyDescriptors(value);
    const identity = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,149}$/.test(item);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(fields).some(key => !keys.includes(key))
      || keys.some(key => !Object.hasOwn(fields, key)) || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))
      || ((save || withdraw) && !identity(value.requestId)) || (save ? !identity(value.conversationId) || typeof value.text !== 'string' : !identity(value.operationId))) throw new Error('Invalid local memory input');
    signal?.throwIfAborted();
    if (withdraw) {
      // Withdrawal must remain available while paused or while a backend read is in flight.
      if (this.pendingAdmissions >= 32) throw new Error('Runtime admission capacity reached');
      this.pendingAdmissions++;
      let finish!: () => void;
      const admission = new Promise<void>(resolve => { finish = resolve; });
      this.admissions.add(admission);
      try {
        const entry = await this.store.request('memory.withdrawLocal', { requestId: value.requestId as string, operationId: value.operationId as string });
        await this.refreshMemoryCoverage(); await this.publishMemoryAvailability();
        // The same-transaction epoch fence is authoritative, even if this process
        // dies before cancelling an already running native attempt.
        if (entry.contextInvalidation?.conversationIds.length) await this.localReplies.cancelConversations(entry.contextInvalidation.conversationIds);
        return { ...memoryEntry(entry), ...(entry.contextInvalidation ? { contextInvalidation: entry.contextInvalidation } : {}) };
      }
      finally { this.pendingAdmissions--; this.admissions.delete(admission); finish(); }
    }
    this.ensureCanRun();
    if (!this.localMemories || this.memoryBackend?.status().state !== 'ready') throw new Error('Controlled memory backend is unavailable');
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: save ? '保存显式记忆' : '读取已保存记忆',
      phase: save ? '核对授权与原生保存回执' : '核对当前读取资格与原生正文', status: 'running', controller: new AbortController(), done, finish };
    const abort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.operations.set(op.id, op);
    try {
      const result = save
        ? await this.localMemories.remember({ requestId: value.requestId as string, conversationId: value.conversationId as string, text: value.text as string, signal: op.controller.signal })
        : await this.localMemories.read({ operationId: value.operationId as string, signal: op.controller.signal });
      this.ensureCanRun(); op.controller.signal.throwIfAborted();
      await this.refreshMemoryCoverage(); await this.publishMemoryAvailability();
      return 'body' in result ? { entry: memoryEntry(result.entry), body: result.body } : { duplicate: result.duplicate, entry: memoryEntry(result.entry) };
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', abort); }
  }
  /** Owner-only P0 round-trip probe: writes one synthetic memory fact, indexes
   * it with the real local embedding backend, performs one semantic search and
   * one exact read, then withdraws it and verifies the post-withdraw rejection.
   * It uses no generation model, performs no retry, and leaves exactly one
   * withdrawn synthetic memory operation as its disclosed side effect. */
  private async commandMemoryEmbeddingProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (Object.keys(value).some(key => key !== 'action')) throw new Error('Invalid memory embedding probe input');
    this.ensureCanRun(); signal?.throwIfAborted();
    if ([...this.operations.values()].some(op => op.phase === 'memory embedding readiness probe')) throw new Error('Memory embedding probe is already running');
    if (this.operations.size + this.pendingAdmissions !== 0) throw new Error('Memory embedding probe requires an idle runtime');
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '记忆 embedding 往返验证', phase: 'memory embedding readiness probe',
      status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true }); this.operations.set(op.id, op);
    const marker = `SHIYU_MEMORY_PROBE_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const steps: Array<{ step: string; status: string; detail?: string }> = [];
    const attempt = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
      try { const result = await run(); steps.push({ step: name, status: 'passed' }); return result; }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code : 'MEMORY_PROBE_STEP_FAILED';
        steps.push({ step: name, status: 'failed', detail: code }); return undefined;
      }
    };
    try {
      const snap = await this.store.request('conversation.snapshotLocal', {}) as { conversations?: Array<{ conversationId?: string; source?: { kind?: string } }> };
      const conversations = Array.isArray(snap?.conversations) ? snap.conversations : [];
      const target = conversations.find(item => item?.source?.kind === 'local') ?? conversations[0];
      if (!target?.conversationId) return { ok: false, reasonCode: 'MEMORY_PROBE_NO_CONVERSATION', embeddingCalls: 0, generationModelCalls: 0, readiness: this.memoryReadiness ?? null, steps };
      const conversationId = target.conversationId;
      const remember = await attempt('remember-synthetic-fact', () => this.commandLocalMemory({ action: 'memory.rememberLocal',
        requestId: `memory-probe-${randomUUID()}`, conversationId, text: `${marker} 有界记忆验证事实` }, op.controller.signal));
      const operationId = (remember as any)?.entry?.operationId;
      if (!operationId) return { ok: false, reasonCode: 'MEMORY_PROBE_REMEMBER_FAILED', conversationId, embeddingCalls: 0, generationModelCalls: 0, readiness: this.memoryReadiness ?? null, steps };
      const indexed = await attempt('index-fact', () => this.commandSemanticMemory({ action: 'memory.indexLocal',
        requestId: `memory-probe-index-${randomUUID()}`, operationId }, op.controller.signal));
      const search = await attempt('semantic-search', () => this.commandSemanticMemory({ action: 'memory.searchLocal',
        conversationId, query: marker }, op.controller.signal));
      const read = await attempt('exact-read', () => this.commandLocalMemory({ action: 'memory.readLocal', operationId }, op.controller.signal));
      const withdrawn = await attempt('withdraw-fact', () => this.commandLocalMemory({ action: 'memory.withdrawLocal',
        requestId: `memory-probe-withdraw-${randomUUID()}`, operationId }, op.controller.signal));
      let postWithdrawRejected = false; let postWithdrawCode: string | undefined;
      if (withdrawn !== undefined) {
        try { await this.commandLocalMemory({ action: 'memory.readLocal', operationId }, op.controller.signal); }
        catch (error) {
          postWithdrawRejected = true;
          postWithdrawCode = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code : 'MEMORY_PROBE_REJECTED';
        }
      }
      try { await this.refreshMemoryCoverage(); await this.publishMemoryAvailability(); } catch { /* readiness stays honest */ }
      this.ensureCanRun();
      const matches = Array.isArray((search as any)?.matches) ? (search as any).matches.length : 0;
      const semanticHit = matches > 0;
      const stepPassed = (name: string) => steps.some(item => item.step === name && item.status === 'passed');
      const effectStatus = (indexed as any)?.entry?.effect?.status;
      const ok = stepPassed('remember-synthetic-fact') && stepPassed('index-fact') && stepPassed('semantic-search')
        && stepPassed('exact-read') && stepPassed('withdraw-fact') && postWithdrawRejected && semanticHit
        && effectStatus !== 'unknown' && effectStatus !== 'failed'
        && (indexed as any)?.entry?.embeddingUsage?.complete === true;
      return { ok, ...(ok ? {} : { reasonCode: 'MEMORY_PROBE_ROUNDTRIP_INCOMPLETE' }), conversationId, markerSha256: createHash('sha256').update(marker).digest('hex'),
        steps, embeddingCalls: (indexed as any)?.entry?.embeddingUsage?.calls ?? null,
        searchEmbeddingCalls: (search as any)?.embeddingCalls ?? null, usageComplete: (indexed as any)?.entry?.embeddingUsage?.complete === true && (search as any)?.usageComplete === true,
        searchState: (search as any)?.state, matches, semanticHit, exactReadBodyMatched: typeof (read as any)?.body === 'string' && (read as any).body.includes(marker),
        postWithdrawRejected, ...(postWithdrawCode ? { postWithdrawCode } : {}),
        readiness: this.memoryReadiness ?? null, coverage: this.memoryCoverage ?? null, semanticModel: 'local-embedding-only', generationModelCalls: 0 };
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  /**
   * One bounded startup embedding verification. It reuses only the local
   * conversation that already has readable memory; success publishes
   * semantic_search, failure/skip keeps exact-read-only with a controlled
   * reason. Guarded to one attempt per process by StartupEmbeddingVerifier.
   */
  private async runStartupEmbeddingVerification(): Promise<void> {
    const runtime = this;
    if (this.startupEmbeddingVerifier.attempted) return;
    if (this.pauseRequested || this.closed || this.closing) return; // not an attempt while paused
    if (!this.memoryBackend || this.memoryBackend.status().state !== 'ready') return;
    const backendStatus = (): ReturnType<NonNullable<typeof this.memoryBackend>['status']> => runtime.memoryBackend!.status();
    const result = await this.startupEmbeddingVerifier.verify({
      semanticConfigured: Boolean(this.memorySearch),
      backendStatus,
      async findConversationWithMemory() {
        const entries = await runtime.store.request('memory.list', {}) as Array<{ conversationId?: string; reference?: unknown }>;
        const seen = new Set<string>();
        for (const entry of entries) {
          if (!entry?.reference || typeof entry.conversationId !== 'string' || seen.has(entry.conversationId)) continue;
          seen.add(entry.conversationId);
          return entry.conversationId;
        }
        return undefined;
      },
      async search({ conversationId, query, signal }) {
        const search = await runtime.memorySearch!.search({ conversationId, text: query, signal });
        return { state: search.state, embeddingCalls: search.embeddingUsage.calls, usageComplete: search.embeddingUsage.complete, matches: search.matches.length };
      },
      async publishVerified() { await runtime.refreshMemoryCoverage(); await runtime.publishMemoryAvailability(); },
    }, { timeoutMs: 20000 });
    this.startupEmbeddingReceipt = structuredClone(result);
    try { await runtime.refreshMemoryCoverage(); await runtime.publishMemoryAvailability(); } catch { /* readiness stays honest */ }
  }
  /** Owner-only two-phase single-user chat-memory probe (write / recall). */
  private async commandChatMemoryProbe(value: Record<string, unknown>, signal?: AbortSignal): Promise<ChatMemoryProbeReceipt> {
    const runtime = this;
    if (Object.keys(value).some(key => !['action', 'phase', 'expectedSessionId', 'conversationId'].includes(key))
      || (value.phase !== 'write' && value.phase !== 'recall')
      || (value.expectedSessionId !== undefined && (typeof value.expectedSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,149}$/.test(value.expectedSessionId)))
      || (value.conversationId !== undefined && (typeof value.conversationId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.conversationId)))) throw new Error('Invalid chat memory probe input');
    runtime.ensureCanRun(); signal?.throwIfAborted();
    if (!this.contextSafety.ready) throw new Error('Native context safety is unavailable; no model request was admitted');
    if (this.operations.size + this.pendingAdmissions !== 0) throw new Error('Chat memory probe requires an idle runtime');
    if ([...this.operations.values()].some(op => op.phase === 'single-user chat memory probe')) throw new Error('Chat memory probe is already running');
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: '单用户聊天记忆往返探针', phase: 'single-user chat memory probe', status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true }); this.operations.set(op.id, op);
    try {
      const phase = value.phase as 'write' | 'recall';
      const conversationId = typeof value.conversationId === 'string' ? value.conversationId : undefined;
      const expectedSessionId = typeof value.expectedSessionId === 'string' ? value.expectedSessionId : undefined;
      const replyPort = async (input: { conversationId: string; inputId: string; text: string; maxTokens: number }) => {
        const result = await runtime.localReplies.run({ conversationId: input.conversationId, inputId: input.inputId, text: input.text, signal: op.controller.signal, maxTokens: input.maxTokens });
        runtime.ensureCanRun(); op.controller.signal.throwIfAborted();
        const reply = result.reply;
        return { operationId: result.operation.operationId, conversationId: result.operation.conversationId, status: result.operation.status,
          text: reply?.text ?? '', sessionId: reply?.binding.sessionId ?? result.operation.nativeBinding?.sessionId ?? '',
          ...(result.operation.expectedSessionId ? { expectedSessionId: result.operation.expectedSessionId } : {}),
          contextConfirmed: reply?.contextReceipt?.durability === 'confirmed',
          memoryOperationIds: (result.operation.memorySources ?? []).map((source: { operationId: string }) => source.operationId), duplicate: result.duplicate };
      };
      const receipt = phase === 'write'
        ? await runChatMemoryWritePhase({
          now: () => new Date().toISOString(),
          async findConversation() {
            const snapshot = await runtime.store.request('conversation.snapshotLocal', {}) as { conversations?: Array<{ conversationId?: string; source?: { kind?: string } }> };
            const conversations = Array.isArray(snapshot?.conversations) ? snapshot.conversations : [];
            const selected = conversationId ? conversations.find(item => item.conversationId === conversationId)
              : conversations.find(item => item?.source?.kind === 'local') ?? conversations[0];
            return selected?.conversationId ? { conversationId: selected.conversationId } : undefined;
          },
          async remember(input) {
            const saved = await runtime.localMemories!.remember({ requestId: input.requestId, conversationId: input.conversationId, text: input.text, signal: op.controller.signal });
            runtime.ensureCanRun(); op.controller.signal.throwIfAborted();
            return { operationId: saved.entry.operation.operationId, requestId: saved.entry.requestId, canRead: saved.entry.canPublish };
          },
          async index(input) {
            const indexed = await runtime.memorySearch!.index({ requestId: input.requestId, operationId: input.operationId, signal: op.controller.signal });
            runtime.ensureCanRun(); op.controller.signal.throwIfAborted();
            return { ...(indexed.entry.observation?.receipt?.receiptId ? { indexReceiptId: indexed.entry.observation.receipt.receiptId } : {}),
              effectStatus: indexed.entry.effect.status, embeddingCalls: indexed.entry.embeddingUsage.calls, usageComplete: indexed.entry.embeddingUsage.complete };
          },
          reply: replyPort,
        }, { signal: op.controller.signal, ...(conversationId ? { conversationId } : {}) })
        : await runChatMemoryRecallPhase({
          now: () => new Date().toISOString(),
          async findProbeFact() {
            const entries = await runtime.store.request('memory.list', {}) as Array<{ requestId?: string; conversationId?: string; reference?: unknown; canRead?: boolean; operation?: { operationId?: string } }>;
            const candidates = entries.filter(entry => typeof entry?.requestId === 'string' && entry.requestId.startsWith('chat-memory-probe-write-')
              && entry.reference !== undefined && entry.canRead !== false && typeof entry.operation?.operationId === 'string'
              && (conversationId === undefined || entry.conversationId === conversationId));
            const latest = candidates[candidates.length - 1];
            return latest && latest.operation?.operationId && latest.requestId && latest.conversationId
              ? { operationId: latest.operation.operationId, requestId: latest.requestId, conversationId: latest.conversationId } : undefined;
          },
          async readMemory(input) {
            const read = await runtime.localMemories!.read({ operationId: input.operationId, signal: op.controller.signal });
            return { body: read.body };
          },
          reply: replyPort,
          async backgroundMemoryEvidence(input) {
            const loaded = await runtime.localReplies.load({ conversationId: input.conversationId, inputId: `chat-memory-probe-bg-${randomUUID()}`, text: input.text, signal: op.controller.signal });
            runtime.ensureCanRun(); op.controller.signal.throwIfAborted();
            return { memoryOperationIds: (loaded.operation.memorySources ?? []).map((source: { operationId: string }) => source.operationId) };
          },
          async withdraw(input) { return runtime.commandLocalMemory({ action: 'memory.withdrawLocal', requestId: input.requestId, operationId: input.operationId }, op.controller.signal); },
        }, { signal: op.controller.signal, ...(conversationId ? { conversationId } : {}), ...(expectedSessionId ? { expectedSessionId } : {}) });
      runtime.ensureCanRun(); op.controller.signal.throwIfAborted();
      this.chatMemoryProbeReceipt = structuredClone(receipt);
      this.lastFailure = undefined;
      return receipt;
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  private async commandSemanticMemory(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.ensureCanRun(); signal?.throwIfAborted();
    const index = value.action === 'memory.indexLocal';
    const keys = index ? ['action', 'requestId', 'operationId'] : ['action', 'conversationId', 'query'];
    const fields = Object.getOwnPropertyDescriptors(value);
    const identity = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,149}$/.test(item);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(fields).some(key => !keys.includes(key))
      || keys.some(key => !Object.hasOwn(fields, key)) || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))
      || (index ? !identity(value.requestId) || !identity(value.operationId) : !identity(value.conversationId)
        || typeof value.query !== 'string' || !value.query.trim() || Buffer.byteLength(value.query, 'utf8') > 8192)) throw new Error('Invalid semantic memory input');
    if (!this.memorySearch || this.memoryBackend?.status().state !== 'ready') throw new Error('Semantic memory backend is unavailable');
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: index ? '构建单条记忆索引' : '检索当前对话记忆',
      phase: index ? '核对授权与独立索引回执' : '核对可读集合与语义结果', status: 'running', controller: new AbortController(), done, finish };
    const abort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); this.operations.set(op.id, op);
    const kind = index ? 'index' as const : 'search' as const;
    try {
      if (index) {
        const result = await this.memorySearch.index({ requestId: value.requestId as string, operationId: value.operationId as string, signal: op.controller.signal });
        this.lastSemanticOperation = { kind, status: result.duplicate ? 'existing' : 'completed', outcome: result.entry.effect.status,
          at: new Date().toISOString(), embeddingUsage: result.entry.embeddingUsage };
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        await this.refreshMemoryCoverage(); await this.publishMemoryAvailability();
        return { duplicate: result.duplicate, entry: memoryIndexEntry(result.entry) };
      }
      const result = await this.memorySearch.search({ conversationId: value.conversationId as string, text: value.query as string, signal: op.controller.signal });
      this.lastSemanticOperation = { kind, status: 'completed', at: new Date().toISOString(), embeddingUsage: result.embeddingUsage };
      this.ensureCanRun(); op.controller.signal.throwIfAborted();
      await this.refreshMemoryCoverage(); await this.publishMemoryAvailability();
      return { state: result.state, matches: result.matches, coverage: result.coverage, index: result.index,
        embeddingCalls: result.embeddingUsage.calls, usageComplete: result.embeddingUsage.complete };
    } catch (error) {
      const usage = error && typeof error === 'object' && 'embeddingUsage' in error ? error.embeddingUsage : undefined;
      this.lastSemanticOperation = { kind, status: 'failed', at: new Date().toISOString(),
        embeddingUsage: usage && typeof usage === 'object' && 'calls' in usage && 'complete' in usage
          && (usage.calls === null || Number.isSafeInteger(usage.calls)) && typeof usage.complete === 'boolean'
          ? { calls: usage.calls as number | null, complete: usage.complete } : { calls: null, complete: false } };
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', abort); }
  }
  private async commandLocalReply(value: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.ensureCanRun(); signal?.throwIfAborted();
    if (!this.contextSafety.ready) throw new Error('Native context safety is unavailable; no model request was admitted');
    const diagnostic = value.action === 'conversation.verifyContext';
    const loadOnly = value.action === 'conversation.loadContext';
    if (loadOnly && !this.sessions.loadContextOnly) throw new Error('Native load-only capability is unavailable');
    const allowed = diagnostic ? ['action', 'conversationId'] : ['action', 'conversationId', 'inputId', 'text'];
    if (Object.keys(value).some(key => !allowed.includes(key))
      || typeof value.conversationId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.conversationId)
      || (!diagnostic && (typeof value.inputId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.inputId)
        || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16000))) throw new Error('Invalid local reply input');
    if (this.operations.size + this.pendingAdmissions >= 2) throw new Error('Runtime operation capacity reached');
    if (diagnostic && [...this.operations.values()].some(op => op.phase.startsWith('上下文验证'))) throw new Error('Context verification is already running');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: diagnostic ? '检查背景加载与原生会话复用' : loadOnly ? '加载背景，不请求回复' : '生成本地业务只读草稿',
      phase: diagnostic ? '上下文验证：检查本地任务来源' : '取得只读业务视图', status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    let requestedRounds = 0;
    try {
      const source = (await this.store.request('conversation.snapshotLocal', { conversationId: value.conversationId as string })).conversations[0]?.source;
      if (source?.kind === 'lab') throw new Error('Lab replies require the connection coordinator and its current authority');
      if (loadOnly) {
        const result = await this.localReplies.load({ conversationId: value.conversationId as string, inputId: value.inputId as string, text: value.text as string, signal: op.controller.signal });
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        this.lastFailure = undefined;
        return { ...result, status: result.duplicate ? 'existing' : 'loaded', inferenceRequested: false, followupRequested: false, sent: false };
      }
      if (!diagnostic) {
        const result = await this.localReplies.run({ conversationId: value.conversationId, inputId: value.inputId as string, text: value.text as string, signal: op.controller.signal, maxTokens: 512 });
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        this.lastFailure = undefined;
        return { ...result, status: result.duplicate ? 'existing' : 'draft', sent: false };
      }
      const snapshot = await this.store.request('conversation.snapshotLocal', { conversationId: value.conversationId });
      const conversation = snapshot.conversations[0];
      const task = conversation?.taskRefs[0];
      if (!task) throw new Error('Context verification requires an associated local Task');
      const marker = `SHIYU_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const responses: Awaited<ReturnType<LocalReplyService['run']>>[] = [];
      const prompts = [
        `这是本地只读上下文验证。请记住合成代号 ${marker}，并根据本次业务快照读取任务 ${task.taskId} 的实际状态。只输出 JSON，且仅有 taskId、state、marker 三个字段；marker 填该合成代号，state 填快照中的原始英文状态值。`,
        `再次根据本次业务快照读取任务 ${task.taskId} 的实际状态，并回忆上一轮的合成代号。只输出 JSON，且仅有 taskId、state、marker 三个字段；不得从任务状态猜测代号。`,
      ];
      for (let index = 0; index < prompts.length; index++) {
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        op.phase = `上下文验证 ${index + 1}/2：读取业务视图并确认原生加载`;
        requestedRounds++;
        const result = await this.localReplies.run({ conversationId: conversation.conversationId, inputId: `context-check-${op.id}-${index + 1}`, text: prompts[index]!, signal: op.controller.signal, maxTokens: 512 });
        this.ensureCanRun(); op.controller.signal.throwIfAborted();
        const reply = result.reply;
        if (result.duplicate || !reply || !result.view || result.view.conversation?.bindingId !== conversation.bindingId
          || reply.contextReceipt?.durability !== 'confirmed' || reply.contextReceipt.sessionId !== reply.binding.sessionId
          || !reply.assistantRef || reply.assistantRef.sessionId !== reply.binding.sessionId) throw new Error('Native context and draft receipts were not confirmed');
        const text = reply.text.trim().replace(/^```json\s*\n?([\s\S]*?)\n?```$/u, '$1');
        let answer: Record<string, unknown>;
        try { answer = JSON.parse(text); } catch { throw new Error('Context verification reply was not the requested JSON'); }
        if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).sort().join(',') !== 'marker,state,taskId'
          || answer.taskId !== task.taskId || answer.state !== task.state || answer.marker !== marker) throw new Error('Context verification did not confirm the Task state and native Session history');
        responses.push(result);
      }
      const first = responses[0]!, second = responses[1]!;
      if (first.reply!.binding.sessionId !== second.reply!.binding.sessionId
        || first.view!.conversation!.sessionEpoch !== second.view!.conversation!.sessionEpoch) throw new Error('Context verification did not reuse the same native Session binding');
      const sessionId = second.reply!.binding.sessionId;
      await this.state.update(state => { state.lastContextVerification = { at: new Date().toISOString(), ok: true, instanceId: this.instanceId,
        calls: requestedRounds, conversationId: conversation.conversationId, sessionId,
        message: '两轮本地任务状态与合成代号核对通过；同一原生 Session，背景加载耐久回执及逐轮草稿放行检查通过。未发送消息。' }; });
      await this.record('runtime.context.verified', '本地背景加载与原生会话复用验证通过', 'succeeded');
      this.lastFailure = undefined;
      return { verified: true, conversationId: conversation.conversationId, bindingId: conversation.bindingId, sameSession: true, sessionId,
        calls: requestedRounds, contextDurable: true, draftsValidated: true, sent: false, model: second.reply!.binding.model,
        usage: responses.map(result => result.reply!.usage),
        rounds: responses.map(result => ({ viewId: result.view!.viewId, conversationGeneration: result.view!.conversation!.conversationGeneration,
          contextReceipt: result.reply!.contextReceipt, assistantRef: result.reply!.assistantRef })) };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      if (diagnostic) await this.state.update(state => { state.lastContextVerification = { at: new Date().toISOString(), ok: false,
        instanceId: this.instanceId, calls: requestedRounds, conversationId: value.conversationId as string, message: this.lastFailure! }; });
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  private startTask(taskId: string, title: string): void {
    this.ensureCanRun();
    this.attemptedTasks.add(taskId);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: taskId, title, phase: '已受理，等待受限执行实例', status: 'running', controller: new AbortController(), done, finish };
    this.operations.set(taskId, op);
    // Accepted tasks belong to the runtime, not the lifetime of the UI request.
    void this.tasks.run(taskId, { signal: op.controller.signal, progress: phase => { op.phase = phase; } })
      .catch(error => { this.lastFailure = error instanceof Error ? error.message : String(error); })
      .finally(() => {
        this.operations.delete(taskId); op.finish();
        if (!this.closed && !this.closing) void this.background.wake();
        if (!this.closed && !this.closing) void this.corePump?.wake();
        void this.scheduleQueuedTasks().catch(error => { this.lastFailure = error instanceof Error ? error.message : String(error); });
      });
  }
  private async scheduleQueuedTasks(): Promise<void> {
    if (this.closed || this.closing || this.pauseRequested) return;
    const ability = await this.abilitySnapshot();
    if (!ability.ready || !ability.snapshot.usableForAuthorizedTask) return;
    const queued = (await this.store.request('task.list', {})).filter(task => task.state === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const task of queued) {
      if (this.closed || this.closing || this.pauseRequested || this.operations.size + this.pendingAdmissions >= 2) return;
      // Never turn a failed claim into a retry loop. Recovery/retry is explicit.
      if (!this.operations.has(task.taskId) && !this.attemptedTasks.has(task.taskId)) this.startTask(task.taskId, task.title);
    }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const timeClosing = this.timePump?.close();
    const corePumpClosing = this.corePump?.close();
    const coreClosing = this.core?.close();
    void coreClosing?.catch(() => undefined);
    const backgroundClosing = this.background?.close();
    const replyClosing = this.localReplies?.close();
    const labClosing = this.lab?.close();
    void labClosing?.catch(() => undefined);
    const memoryClosing = this.localMemories?.close();
    const searchClosing = this.memorySearch?.close();
    // Resume may be waiting for open on controlTail. Cancel that owned startup
    // now; waiting for controlTail before closing it would invert the dependency.
    // An already-ready backend stays alive until pending fact verification drains.
    const openingMemoryClose = this.memoryBackend?.status().state === 'opening' ? this.memoryBackend.close() : undefined;
    void openingMemoryClose?.catch(() => undefined);
    this.closing = (async () => {
      for (const op of this.operations.values()) op.controller.abort();
      try {
        await this.controlTail;
        await Promise.allSettled([...this.admissions]);
        // A failed native close does not prove a concurrent evaluation stopped.
        // Drain every owner before closing the store used by late fact records.
        const stopped = await Promise.allSettled([backgroundClosing, corePumpClosing, coreClosing, labClosing, timeClosing]);
        const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        try {
          const results = await Promise.allSettled([this.sessions?.close(), this.workers?.close(), this.goals?.close()]);
          failures.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
          if (failures.length) throw new AggregateError(failures, 'Native Session cleanup failed');
        }
        finally { await Promise.allSettled([...this.operations.values()].map(op => op.done)); await replyClosing; }
      }
      finally {
        try { await Promise.all([memoryClosing, searchClosing]); }
        finally { try { await (openingMemoryClose ?? this.memoryBackend?.close()); }
          finally { try { await this.artifacts?.close(); } finally { try { await this.store?.close(); } finally { await this.state?.close(); } } } }
      }
    })();
    return this.closing;
  }
}
