import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlStore } from './adapters/control-store/index.js';
import { EventService } from './control/events/index.js';
import { SHIYU_EVENT_TYPES } from './contracts/events.js';
import type { EventPrincipal, EventTypeDefinition } from './contracts/events.js';
import { ShiyuSessionAdapter } from './adapters/dsh/sessions.js';
import type { DshContext, SessionStatus, ProbeResult, ReplyRequest, ReplyResult } from './adapters/dsh/sessions.js';
import { LocalStateFile } from './recovery/local-state.js';
import { systems } from './health/systems.js';
import { WorkerSessionDriver } from './adapters/dsh/workers.js';
import { LocalArtifactStore } from './adapters/artifacts/index.js';
import { LocalTaskRunner } from './control/task-runner.js';
import type { TaskWorkerDriver } from './control/task-runner.js';
import { LocalGoalLifecycleService } from './control/goal-lifecycle.js';
import type { GoalLifecycleOptions, GoalLifecycleResult, GoalLifecycleRunOptions } from './control/goal-lifecycle.js';
import { BackgroundPump } from './control/background-pump.js';

export const VERSION = '0.1.0';
const OWN_SCOPE = 'runtime';
const ownTypes = ['runtime.lifecycle.changed', 'runtime.session.probed', 'runtime.model.verified', 'runtime.goal.verified'];
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
  probe(): Promise<ProbeResult>;
  generateReply(request: ReplyRequest): Promise<ReplyResult>;
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
  private closed = false;
  private closing?: Promise<void>;
  private controlTail: Promise<void> = Promise.resolve();
  private controlRevision = 0;
  private pendingAdmissions = 0;
  private readonly admissions = new Set<Promise<void>>();
  private readonly attemptedTasks = new Set<string>();
  private pauseRequested = false;
  private lastFailure?: string;
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
      await mkdir(path.join(this.dataDir, 'control'), { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.dataDir, 'workspaces'), { recursive: true, mode: 0o700 });
      this.store = await ControlStore.open({ filename: path.join(this.dataDir, 'control', 'events.sqlite'), eventTypes: catalog, componentHandlers: ['runtime.activity', 'conversation.background'], runtimeIdentity: { hostEpoch: this.instanceId, installationGeneration: this.state.state.installationGeneration! } });
      this.events = new EventService(this.store);
      this.sessions = this.options.sessionFactory?.(this.ctx, this.state, path.join(this.dataDir, 'workspaces')) ?? new ShiyuSessionAdapter({
        ctx: this.ctx, cwd: path.join(this.dataDir, 'workspaces'),
        bindings: { load: async () => structuredClone(this.state.state.bindings), save: bindings => this.state.update(state => { state.bindings = structuredClone(bindings); }) },
      });
      await this.sessions.initialize();
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
      await this.background?.close().catch(() => undefined);
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
    const [info, stats, recent, subscriptions, sessions, tasks, conversations] = await Promise.all([
      this.store.info(), this.events.stats(principal), this.events.listEvents(principal, { limit: 40 }),
      this.events.listSubscriptions(principal), this.sessions.getStatus(),
      this.store.request('task.list', {}),
      this.store.request('conversation.snapshotLocal', {}),
    ]);
    const at = new Date().toISOString();
    const probe = this.state.state.lastProbe;
    const verification = this.state.state.lastModelVerification;
    const goalVerification = this.state.state.lastGoalVerification;
    const backgroundState = this.background.snapshot();
    return {
      schemaVersion: 1, version: VERSION, instanceId: this.instanceId, startedAt: this.startedAt, observedAt: at,
      lifecycle: this.lastFailure || backgroundState.state === 'degraded' || conversations.background.failed > 0 ? 'degraded' : 'ready',
      state: this.pauseRequested ? 'paused' : this.operations.size ? 'busy' : 'idle',
      systems: structuredClone(systems),
      tasks,
      conversations: conversations.conversations,
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
        { id: 'memory', name: '长期记忆与语义检索', status: 'unconfigured', summary: '尚未接入' },
        { id: 'channels', name: '外部频道与设备', status: 'unconfigured', summary: '尚未接入' },
      ],
      // Session-level records are shown above. An incomplete aggregate is unknown,
      // rather than summing only the measured requests and presenting a false zero.
      usage: { calls: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
      notices: [
        { id: 'scope', level: 'info', message: '已接入原生会话、事件、受限本地任务和对话背景标记；持续规划、内层状态及外部渠道仍待接入。' },
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
        finally { await Promise.allSettled([...this.operations.values()].map(op => op.done)); }
      }
      finally { try { await this.artifacts?.close(); } finally { try { await this.store?.close(); } finally { await this.state?.close(); } } }
    })();
    return this.closing;
  }
}
