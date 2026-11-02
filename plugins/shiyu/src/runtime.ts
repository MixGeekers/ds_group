import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from './adapters/control-store/index.js';
import { EventService } from './control/events/index.js';
import { SHIYU_EVENT_TYPES } from './contracts/events.js';
import type { EventPrincipal, EventTypeDefinition } from './contracts/events.js';
import { ShiyuSessionAdapter } from './adapters/dsh/sessions.js';
import type { DshContext, SessionStatus, ProbeResult, ReplyRequest, ReplyResult, ContextLoadRequest, ContextLoadResult } from './adapters/dsh/sessions.js';
import { LocalStateFile } from './recovery/local-state.js';
import { systems } from './health/systems.js';
import { WorkerSessionDriver } from './adapters/dsh/workers.js';
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

export const VERSION = '0.1.0';
const OWN_SCOPE = 'runtime';
const ownTypes = ['runtime.lifecycle.changed', 'runtime.session.probed', 'runtime.model.verified', 'runtime.goal.verified', 'runtime.context.verified'];
const catalog: EventTypeDefinition[] = [...SHIYU_EVENT_TYPES, ...ownTypes.map(type => ({
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
  getStatus(): Promise<SessionStatus[]>;
  cancel(key: string): Promise<void>;
  close(): Promise<void>;
}
export interface RuntimeConfig { dataDir?: string }
export interface GoalLifecycleDriver {
  initialize(): Promise<void>;
  run(taskId: string, options: GoalLifecycleRunOptions): Promise<GoalLifecycleResult>;
  close(): Promise<void>;
}
export interface RuntimeOptions {
  sessionFactory?: (ctx: DshContext, state: LocalStateFile, cwd: string) => SessionDriver;
  workerFactory?: (ctx: DshContext) => TaskWorkerDriver;
  goalFactory?: (options: GoalLifecycleOptions) => GoalLifecycleDriver;
  /** Trusted fixture/composition only; never accepted from command JSON. */
  memoryFactory?: (config: ManagedOmbreConfig) => Pick<ManagedOmbreBackend, 'adapter' | 'open' | 'status' | 'close'>;
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
interface ActiveOperation { id: string; title: string; phase: string; status: string; controller: AbortController; done: Promise<void>; finish: () => void }

export class RuntimeService {
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly operations = new Map<string, ActiveOperation>();
  readonly dataDir: string;
  state!: LocalStateFile;
  store!: ControlStore;
  events!: EventService;
  sessions!: SessionDriver;
  workers!: TaskWorkerDriver;
  artifacts!: LocalArtifactStore;
  tasks!: LocalTaskRunner;
  goals!: GoalLifecycleDriver;
  background!: BackgroundPump;
  localReplies!: LocalReplyService;
  private localMemories?: LocalMemoryService;
  private memorySearch?: LocalMemorySearchService;
  private memoryBackend?: Pick<ManagedOmbreBackend, 'adapter' | 'open' | 'status' | 'close'>;
  private memoryConfig?: Readonly<ManagedOmbreConfig>;
  private memoryFailure?: string;
  private semanticFailure?: string;
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
  constructor(private readonly ctx: DshContext, config: RuntimeConfig = {}, private readonly options: RuntimeOptions = {}) {
    const defaultDirectory = fileURLToPath(new URL('../.local/runtime/', import.meta.url));
    if (config.dataDir !== undefined && (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir))) throw new Error('dataDir must be an absolute path');
    this.dataDir = path.resolve(config.dataDir ?? defaultDirectory);
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
      this.store = await ControlStore.open({ filename: path.join(this.dataDir, 'control', 'events.sqlite'), eventTypes: catalog, componentHandlers: ['runtime.activity', 'conversation.background'], runtimeIdentity: { hostEpoch: this.instanceId, installationGeneration: this.state.state.installationGeneration! },
        ...(this.memoryConfig ? { memoryBackend: { backendId: this.memoryConfig.backendId, deploymentId: this.memoryConfig.deploymentId } } : {}) });
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
          } catch { this.memoryFailure = 'MEMORY_BACKEND_UNAVAILABLE'; await this.memoryBackend?.close().catch(() => undefined); }
        }
      }
      this.events = new EventService(this.store);
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
      this.workers = this.options.workerFactory?.(this.ctx) ?? new WorkerSessionDriver({ ctx: this.ctx });
      await this.workers.initialize();
      this.artifacts = await LocalArtifactStore.open(path.join(this.dataDir, 'workspaces'));
      this.tasks = new LocalTaskRunner(this.store, this.workers, this.artifacts);
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
      const existing = await this.events.listSubscriptions(principal);
      const activitySubscription = existing.find(s => s.id === 'runtime-activity');
      if (!activitySubscription) await this.events.subscribe(principal, {
        id: 'runtime-activity', types: ownTypes, scope: OWN_SCOPE,
        target: { kind: 'component', handlerRef: 'runtime.activity' }, deliveryMode: 'component', start: { kind: 'from_now' },
      });
      else if (JSON.stringify(activitySubscription.types) !== JSON.stringify(ownTypes)) await this.events.update(principal, activitySubscription.id, activitySubscription.revision, { types: ownTypes });
      await this.record('runtime.lifecycle.changed', '识雨本体基础已装载', this.pauseRequested ? 'paused' : 'ready');
      this.background = new BackgroundPump({ batchSize: 20, consume: async limit => {
        const result = await this.store.request('conversation.consumeBackground', { limit });
        return { claimed: result.claimed, processed: result.acknowledged, failed: result.failed };
      } });
      await this.background.start();
    } catch (error) {
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
  /** Trusted lifecycle publication. Dashboard reads never publish or probe a backend. */
  private async publishMemoryAvailability(): Promise<void> {
    const current = await this.store.request('view.state', {});
    if (!current) throw new Error('Inner state publication is unavailable');
    const backend = this.memoryBackend?.status();
    let availability: UnavailableDomain | AvailableMemoryDomain = { status: 'unavailable',
      reason: this.memoryConfig ? 'source_unavailable' : this.memoryFailure ? 'incompatible_version' : 'not_connected' };
    if (this.localMemories && backend?.state === 'ready' && backend.bindingVerified && !this.memoryFailure) {
      const semantic = Boolean(this.memorySearch && backend.semantic?.profileCompatible);
      availability = { status: 'available', backendId: backend.backendId, deploymentId: backend.deploymentId,
        capabilities: semantic ? ['exact_read', 'semantic_search'] : ['exact_read'],
        ...(semantic ? { profileFingerprint: backend.semantic!.profileFingerprint! } : {}) };
    }
    // No receipt churn for a lifecycle reconciliation whose state is already published.
    if (JSON.stringify(current.manifest.domains.memory) === JSON.stringify(availability)) return;
    await this.store.request('state.publishMemoryAvailability', { requestId: `memory-availability-${this.instanceId}-${randomUUID()}`,
      expectedBaselineId: current.baselineId, expectedStateVersion: current.stateVersion, availability });
  }
  private setPaused(paused: boolean): Promise<unknown> {
    const revision = ++this.controlRevision;
    // A later pause fences work immediately, even while an earlier resume is
    // waiting for its durable write. Only the latest successful resume opens it.
    if (paused) {
      this.pauseRequested = true;
      for (const op of this.operations.values()) op.controller.abort();
    }
    const command = this.controlTail.then(async () => {
      if (paused) {
        await this.state.update(state => { state.paused = true; });
        await this.store.request('task.setPaused', { paused: true });
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
      if (paused) for (const binding of await this.sessions.getStatus()) if (binding.status === 'running') await this.sessions.cancel(binding.key);
      await this.record('runtime.lifecycle.changed', paused ? '已暂停新的模型操作' : '已恢复接纳新的模型操作', paused ? 'paused' : 'ready');
      if (!paused) await this.scheduleQueuedTasks();
      return { accepted: true, paused };
    });
    this.controlTail = command.then(() => undefined, error => { this.lastFailure = error instanceof Error ? error.message : String(error); });
    return command;
  }
  private async record(type: string, message: string, status: string): Promise<void> {
    await this.events.publish(principal, { type, scope: OWN_SCOPE, payload: { message, status }, idempotencyKey: randomUUID(), correlationId: this.instanceId });
    // This component's only effect is a readable event-backed activity projection.
    // A crash before acknowledgement is safe to retry; no external effect occurs.
    for (const delivery of await this.events.claim(principal, { consumerId: 'runtime.activity', deliveryMode: 'component', subscriptionId: 'runtime-activity', limit: 50, leaseMs: 30000 })) {
      await this.events.ack(principal, { deliveryId: delivery.deliveryId, claimToken: delivery.claimToken });
    }
  }
  async snapshot() {
    this.ensureOpen();
    const [info, stats, recent, subscriptions, sessions, tasks, conversations, innerProjection] = await Promise.all([
      this.store.info(), this.events.stats(principal), this.events.listEvents(principal, { limit: 40 }),
      this.events.listSubscriptions(principal), this.sessions.getStatus(),
      this.store.request('task.list', {}),
      this.store.request('conversation.snapshotLocal', {}),
      this.store.request('view.state', {}),
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
      lifecycle: this.lastFailure || memoryError || this.semanticFailure || memoryBackend?.state === 'failed' || backgroundState.state === 'degraded' || conversations.background.failed > 0 ? 'degraded' : 'ready',
      state: this.pauseRequested ? 'paused' : this.operations.size ? 'busy' : 'idle',
      systems: structuredClone(systems),
      tasks,
      conversations: conversations.conversations,
      innerProjection: innerProjection ?? null,
      memory: { configured: Boolean(this.memoryConfig) || Boolean(this.memoryFailure), ready: memoryReady,
        semanticConfigured: Boolean(this.memorySearch),
        ...(this.semanticFailure ? { semanticErrorCode: this.semanticFailure } : {}),
        ...(this.lastSemanticOperation ? { lastSemanticOperation: structuredClone(this.lastSemanticOperation) } : {}),
        ...(memoryError ? { errorCode: memoryError } : {}), ...(memoryBackend ? { backend: memoryBackend } : {}), entries: memoryEntries },
      diagnostics: { contextVerification: this.state.state.lastContextVerification ? structuredClone(this.state.state.lastContextVerification) : null,
        contextSafety: structuredClone(this.contextSafety) },
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
        { id: 'native-session', name: 'DSH 原生会话', status: probe?.instanceId === this.instanceId ? (probe.ok ? 'available' : 'unavailable') : 'unknown', summary: probe ? `${probe.instanceId === this.instanceId ? '' : '上次运行的检查记录，本次尚未检查：'}${probe.message}` : '尚未执行会话连接检查', checkedAt: probe?.at },
        { id: 'model', name: '生成模型', status: verification?.instanceId === this.instanceId ? (verification.ok ? 'available' : 'unavailable') : 'unknown', summary: verification ? `${verification.instanceId === this.instanceId ? '' : '上次运行的验证记录：'}${verification.message}` : '配置为 opencode-go / deepseek-v4.1-flash；连接检查不代表推理可用。', checkedAt: verification?.at },
        { id: 'native-goal', name: 'DSH 原生 Goal', status: goalVerification?.instanceId === this.instanceId ? (goalVerification.ok ? 'available' : 'unavailable') : 'unknown', summary: goalVerification ? `${goalVerification.instanceId === this.instanceId ? '' : '上次运行的验证记录：'}${goalVerification.message}` : '尚未验证原生 Goal 生命周期；查看页面不会创建或恢复目标会话。', checkedAt: goalVerification?.at },
        { id: 'native-context', name: '原生上下文接线', status: this.contextSafety.ready ? 'available' : 'unavailable', summary: this.contextSafety.ready ? '消息工厂与原生持久化接口已加载；不代表上下文已实际加载或模型已验证。' : this.contextSafety.error ?? '上下文接线尚未准备', checkedAt: this.startedAt },
        { id: 'memory', name: '长期记忆', status: memoryReady ? 'available' : this.memoryConfig || memoryError ? 'unavailable' : 'unconfigured',
          summary: memoryReady ? this.memorySearch ? '受控存取、独立索引与同会话语义读取已接线；embedding 实测及索引覆盖按实际回执显示。' : '受控原生存取与精确读取已连接；语义检索未配置。' : memoryError ?? (this.memoryConfig ? '受控记忆等待启动或连接核对' : '尚未配置受控记忆服务') },
        { id: 'channels', name: '外部频道与设备', status: 'unconfigured', summary: '尚未接入' },
      ],
      // Session-level records are shown above. An incomplete aggregate is unknown,
      // rather than summing only the measured requests and presenting a false zero.
      usage: { calls: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
      notices: [
        { id: 'scope', level: 'info', message: '已接入原生会话、事件、受限本地任务与记忆读取链路；持续规划、其余内层状态及外部渠道仍待接入。' },
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
    const action = value.action;
    if (action === 'memory.rememberLocal' || action === 'memory.readLocal' || action === 'memory.withdrawLocal') return this.commandLocalMemory(value, signal);
    if (action === 'memory.indexLocal' || action === 'memory.searchLocal') return this.commandSemanticMemory(value, signal);
    if (action === 'runtime.pause') return this.setPaused(true);
    if (action === 'runtime.resume') return this.setPaused(false);
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
      return 'body' in result ? { entry: memoryEntry(result.entry), body: result.body } : { duplicate: result.duplicate, entry: memoryEntry(result.entry) };
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', abort); }
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
        return { duplicate: result.duplicate, entry: memoryIndexEntry(result.entry) };
      }
      const result = await this.memorySearch.search({ conversationId: value.conversationId as string, text: value.query as string, signal: op.controller.signal });
      this.lastSemanticOperation = { kind, status: 'completed', at: new Date().toISOString(), embeddingUsage: result.embeddingUsage };
      this.ensureCanRun(); op.controller.signal.throwIfAborted();
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
        void this.scheduleQueuedTasks().catch(error => { this.lastFailure = error instanceof Error ? error.message : String(error); });
      });
  }
  private async scheduleQueuedTasks(): Promise<void> {
    if (this.closed || this.closing || this.pauseRequested) return;
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
    const backgroundClosing = this.background?.close();
    const replyClosing = this.localReplies?.close();
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
        await backgroundClosing;
        try {
          const results = await Promise.allSettled([this.sessions?.close(), this.workers?.close(), this.goals?.close()]);
          const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
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
