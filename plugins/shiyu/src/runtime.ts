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

export const VERSION = '0.1.0';
const OWN_SCOPE = 'runtime';
const ownTypes = ['runtime.lifecycle.changed', 'runtime.session.probed'];
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
export interface RuntimeOptions {
  sessionFactory?: (ctx: DshContext, state: LocalStateFile, cwd: string) => SessionDriver;
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
  private closed = false;
  private closing?: Promise<void>;
  private controlTail: Promise<void> = Promise.resolve();
  private controlRevision = 0;
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
      await mkdir(path.join(this.dataDir, 'control'), { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.dataDir, 'workspaces'), { recursive: true, mode: 0o700 });
      this.store = await ControlStore.open({ filename: path.join(this.dataDir, 'control', 'events.sqlite'), eventTypes: catalog, componentHandlers: ['runtime.activity'] });
      this.events = new EventService(this.store);
      this.sessions = this.options.sessionFactory?.(this.ctx, this.state, path.join(this.dataDir, 'workspaces')) ?? new ShiyuSessionAdapter({
        ctx: this.ctx, cwd: path.join(this.dataDir, 'workspaces'),
        bindings: { load: async () => structuredClone(this.state.state.bindings), save: bindings => this.state.update(state => { state.bindings = structuredClone(bindings); }) },
      });
      await this.sessions.initialize();
      const existing = await this.events.listSubscriptions(principal);
      if (!existing.some(s => s.id === 'runtime-activity')) await this.events.subscribe(principal, {
        id: 'runtime-activity', types: ownTypes, scope: OWN_SCOPE,
        target: { kind: 'component', handlerRef: 'runtime.activity' }, deliveryMode: 'component', start: { kind: 'from_now' },
      });
      await this.record('runtime.lifecycle.changed', '识雨本体基础已装载', this.pauseRequested ? 'paused' : 'ready');
    } catch (error) {
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
      await this.state.update(state => { state.paused = paused; });
      if (!paused && revision === this.controlRevision && !this.closed) this.pauseRequested = false;
      if (paused) for (const binding of await this.sessions.getStatus()) if (binding.status === 'running') await this.sessions.cancel(binding.key);
      await this.record('runtime.lifecycle.changed', paused ? '已暂停新的模型操作' : '已恢复接纳新的模型操作', paused ? 'paused' : 'ready');
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
    const [info, stats, recent, subscriptions, sessions] = await Promise.all([
      this.store.info(), this.events.stats(principal), this.events.listEvents(principal, { limit: 40 }),
      this.events.listSubscriptions(principal), this.sessions.getStatus(),
    ]);
    const at = new Date().toISOString();
    const probe = this.state.state.lastProbe;
    return {
      schemaVersion: 1, version: VERSION, instanceId: this.instanceId, startedAt: this.startedAt, observedAt: at,
      lifecycle: this.lastFailure ? 'degraded' : 'ready',
      state: this.pauseRequested ? 'paused' : this.operations.size ? 'busy' : 'idle',
      systems: structuredClone(systems),
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
        { id: 'model', name: '生成模型', status: 'unknown', summary: '配置为 opencode-go / deepseek-v4.1-flash；连接检查不代表推理可用。' },
        { id: 'memory', name: '长期记忆与语义检索', status: 'unconfigured', summary: '尚未接入' },
        { id: 'channels', name: '外部频道与设备', status: 'unconfigured', summary: '尚未接入' },
      ],
      // Session-level records are shown above. An incomplete aggregate is unknown,
      // rather than summing only the measured requests and presenting a false zero.
      usage: { calls: null, inputTokens: null, outputTokens: null, cacheReadTokens: null },
      notices: [
        { id: 'scope', level: 'info', message: '当前为本体基础切片，目标执行与内层状态尚未接入。' },
        ...(this.pauseRequested ? [{ id: 'paused', level: 'info', message: '已暂停新的模型操作；已发生效果不会因暂停回滚。' }] : []),
        ...(this.lastFailure ? [{ id: 'operation', level: 'warning', message: this.lastFailure }] : []),
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
    if (action !== 'session.probe' && action !== 'reply.generate') throw new Error('Unsupported runtime command');
    this.ensureCanRun(); signal?.throwIfAborted();
    if (this.operations.size >= 2) throw new Error('Runtime operation capacity reached');
    if (action === 'reply.generate' && (typeof value.businessId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.businessId) || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000)) throw new Error('Invalid reply input');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const op: ActiveOperation = { id: randomUUID(), title: action === 'session.probe' ? '检查原生会话连接' : '生成只读回复草稿', phase: action === 'session.probe' ? '创建并释放受限会话' : '等待模型结果', status: 'running', controller: new AbortController(), done, finish };
    const onAbort = () => op.controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    this.operations.set(op.id, op);
    try {
      if (action === 'session.probe') {
        const result = await this.sessions.probe();
        op.controller.signal.throwIfAborted();
        await this.state.update(state => { state.lastProbe = { at: new Date().toISOString(), ok: true, message: '原生受限会话创建、工具检查、释放与归档通过；未调用模型。', instanceId: this.instanceId }; });
        await this.record('runtime.session.probed', '原生会话连接检查通过，未调用模型', 'succeeded');
        this.lastFailure = undefined; return result;
      }
      const result = await this.sessions.generateReply({ businessId: value.businessId as string, scope: 'local-owner', prompt: value.prompt as string, signal: op.controller.signal });
      if (this.pauseRequested || op.controller.signal.aborted || this.closed) throw new Error('Reply cancelled before release');
      this.lastFailure = undefined;
      return { ...result, status: 'draft', sent: false };
    } catch (error) {
      this.lastFailure = error instanceof Error ? error.message : String(error);
      if (action === 'session.probe') await this.state.update(state => { state.lastProbe = { at: new Date().toISOString(), ok: false, message: this.lastFailure!, instanceId: this.instanceId }; });
      throw error;
    } finally { this.operations.delete(op.id); op.finish(); signal?.removeEventListener('abort', onAbort); }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const op of this.operations.values()) op.controller.abort();
      try {
        await this.controlTail;
        try { await this.sessions?.close(); }
        finally { await Promise.allSettled([...this.operations.values()].map(op => op.done)); }
      }
      finally { try { await this.store?.close(); } finally { await this.state?.close(); } }
    })();
    return this.closing;
  }
}
