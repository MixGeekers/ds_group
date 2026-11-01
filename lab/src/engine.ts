import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { catalog, getScenario } from './catalog.ts';
import { seedWorkspace, executeWork } from './workloads.ts';
import { evaluateRun } from './evaluation.ts';
import { LabStore } from './store.ts';
import type { ActionResult, Artifact, LabEvent, ReviewResult, Role, RunConfig, RunDetail, RunSummary, ScheduledInput, ServiceState, TargetAction, TargetInput, TaskRecord, TaskSpec, TaskStatus } from './types.ts';

export const DEFAULT_CONFIG: RunConfig = {
  scenarioId: 'mixed-office', target: 'reference', seed: 42, noiseCount: 40,
  speed: 5, workerConcurrency: 3, taskDelayMs: 150, fault: 'none', maxDurationMs: 60_000,
};

type Runtime = {
  run: RunDetail; start: number; timers: Set<ReturnType<typeof setTimeout>>;
  actorTimers: Set<ReturnType<typeof setTimeout>>; actorCounts: Map<string, number>;
  deadline?: ReturnType<typeof setTimeout>; active: Map<string, AbortController>;
  injectionDone: boolean; finishing: boolean; faultConsumed: boolean;
  listeners: Set<(event: LabEvent) => void>;
  workPromises: Set<Promise<void>>;
  finalization?: Promise<void>;
};

type EventFields = Partial<Pick<LabEvent, 'actorId' | 'channelId' | 'taskId' | 'data' | 'causeId'>>;
const terminalStatuses = new Set(['completed', 'stopped', 'interrupted', 'failed']);
const terminalTasks = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const taskStates = new Set<TaskStatus>(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
const roles = new Set<Role>(['core', 'worker', 'replyer', 'world', 'lab', 'memory']);
const memoryDomains = new Set(['memory', 'relationship', 'cognition', 'emotion', 'personality', 'capability']);
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function configFor(input: Partial<RunConfig>): RunConfig {
  const config = { ...DEFAULT_CONFIG, ...input };
  getScenario(config.scenarioId);
  if (!['reference', 'external'].includes(config.target)) throw new Error('未知被测对象');
  if (!['none', 'tool-once', 'lost-receipt'].includes(config.fault)) throw new Error('未知故障配置');
  const limits: Array<[keyof RunConfig, number, number, boolean]> = [
    ['seed', 0, 0xffff_ffff, true], ['noiseCount', 0, 5000, true], ['speed', 0.1, 1000, false],
    ['workerConcurrency', 1, 8, true], ['taskDelayMs', 0, 30000, true], ['maxDurationMs', 100, 600000, true],
  ];
  for (const [key, min, max, integer] of limits) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`无效运行参数：${key} (${min}–${max})`);
  }
  return config;
}

/** Stable input schedule: the producer never awaits the target or a worker. */
export function generateNoise(seed: number, count: number, durationMs: number): ScheduledInput[] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const messages = ['午餐有人一起吗？', '会议室里的转接头找到了。', '这张窗外的照片很好看。', '咖啡机旁边有新茶包。', '收到，谢谢大家。', '今天下午茶改到三点。', '我晚五分钟到会议室。', '这周推荐的书已放在共享区。', '楼下新开的店味道还不错。', '刚看到消息，稍后回复。'];
  const channels = catalog.channels.filter(c => c.kind === 'group' && c.memberIds.length);
  if (!channels.length) return [];
  return Array.from({ length: count }, (_, index) => {
    const channel = channels[Math.floor(random() * channels.length)];
    const actorId = channel.memberIds[Math.floor(random() * channel.memberIds.length)];
    return { id: `noise-${seed}-${index + 1}`, atMs: Math.floor(random() * Math.max(1, durationMs - 1)), actorId, channelId: channel.id, kind: 'message' as const, text: messages[Math.floor(random() * messages.length)] };
  });
}

export class LabEngine {
  readonly catalog = catalog;
  private readonly store: LabStore;
  private readonly runtimes = new Map<string, Runtime>();
  private closed = false;
  private creating = 0;

  constructor(options: { runtimeDir: string }) { this.store = new LabStore(resolve(options.runtimeDir)); }

  async init(): Promise<void> {
    this.store.init();
    for (const run of this.store.loadRuns()) {
      if (!terminalStatuses.has(run.status)) {
        run.status = 'interrupted'; run.finishedAt = new Date().toISOString();
        run.error = 'Lab 进程退出，运行未完成；原始轨迹保留，没有自动重放任务。';
        run.factReport = undefined;
      }
      const rt = this.runtime(run);
      this.runtimes.set(run.id, rt);
      if (run.status === 'interrupted' && !run.factReport) {
        run.finishedAt ??= new Date().toISOString();
        const recovery = run.manifest.evidenceRecovery as { status?: string } | undefined;
        if (recovery?.status === 'incomplete') {
          const tasksTotal = run.tasks.filter(task => task.introduced).length;
          run.factReport = {
            id: `facts-${randomUUID()}`, at: new Date().toISOString(), scope: run.config.target === 'reference' ? 'lab_self_test' : 'target_evaluation',
            assertions: [{ id: 'evidence-recovery', name: '恢复证据完整性', status: 'inconclusive', detail: run.error ?? '恢复材料不完整，不能沿用旧通过结果。', evidenceRefs: [] }],
            tasksPassed: 0, tasksTotal, completionRate: 0, summary: '运行证据恢复不完整，当前结果不可判定。', limitations: ['原始损坏轨迹已保留；未重放业务操作，也未将缺证据算为通过。'],
          };
        } else {
          try { run.factReport = await evaluateRun(clone(run), this.store.runDir(run.id)); }
          catch (error) { run.error = `${run.error ?? ''}\n恢复后部分验收失败：${String(error)}`; }
        }
        if (run.factReport) writeFileSync(join(this.store.runDir(run.id), 'facts.json'), JSON.stringify(run.factReport, null, 2));
      }
      this.refreshMetrics(rt);
      this.store.saveRun(run);
    }
  }

  private runtime(run: RunDetail): Runtime {
    return { run, start: performance.now() - run.metrics.elapsedMs, timers: new Set(), actorTimers: new Set(), actorCounts: new Map(), active: new Map(), injectionDone: terminalStatuses.has(run.status), finishing: false, faultConsumed: false, listeners: new Set(), workPromises: new Set() };
  }

  private find(id: string): Runtime {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error('运行不存在');
    return rt;
  }

  runDir(id: string): string { this.find(id); return this.store.runDir(id); }

  listRuns(): RunSummary[] {
    return [...this.runtimes.values()].map(rt => {
      this.refreshMetrics(rt);
      const { id, name, status, createdAt, finishedAt, config, metrics, factReport, targetLabel, error } = rt.run;
      return clone({ id, name, status, createdAt, finishedAt, config, metrics, factReport, targetLabel, error });
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string): RunDetail { const rt = this.find(id); this.refreshMetrics(rt); return clone(rt.run); }

  async createRun(input: Partial<RunConfig>): Promise<{ run: RunDetail; targetToken?: string }> {
    if (this.closed) throw new Error('Lab 已关闭');
    if (this.creating + [...this.runtimes.values()].filter(rt => !terminalStatuses.has(rt.run.status)).length >= 4) throw Object.assign(new Error('最多同时运行 4 个实验'), { statusCode: 409 });
    const config = configFor(input);
    const scenario = getScenario(config.scenarioId);
    this.creating++;
    try {
    const id = `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const runDir = this.store.runDir(id);
    mkdirSync(runDir, { recursive: true });
    await seedWorkspace(runDir, scenario);
    const servicePath = join(runDir, 'workspace', 'service.json');
    const defaultService: ServiceState = { name: '蓝桥订单服务', config: { maxConnections: 8, requiredConnections: 32, maintenance: false }, healthy: false, revision: 1, logs: ['connection pool exhausted: required=32 configured=8'] };
    const service: ServiceState = existsSync(servicePath) ? JSON.parse(readFileSync(servicePath, 'utf8')) : defaultService;
    const schedule = [...scenario.inputs, ...generateNoise(config.seed, config.noiseCount, scenario.durationMs)].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
    const run: RunDetail = {
      id, name: scenario.name, status: 'prepared', createdAt: new Date().toISOString(), config,
      targetLabel: config.target === 'reference' ? '参考执行器 · Lab 自检' : '外部 Agent · 待测对象',
      metrics: { scheduledInputs: schedule.length, injectedInputs: 0, replies: 0, toolCalls: 0, completedTasks: 0, failedTasks: 0, pendingTasks: 0, maxInjectionLagMs: 0, elapsedMs: 0 },
      tasks: scenario.tasks.map(task => ({ ...clone(task), status: 'queued', introduced: false, artifactPaths: [] })),
      events: [], artifacts: [], reviews: [], service, memory: {},
      manifest: {
        schemaVersion: 1, scenarioId: scenario.id, scenarioDigest: hash(stable(scenario)), scheduleDigest: hash(stable(schedule)),
        createdAt: new Date().toISOString(), seed: config.seed, config: clone(config),
        scope: config.target === 'reference' ? 'lab_self_test' : 'target_evaluation',
        components: { inputDriver: 'real', world: 'stateful_test_double', worker: config.target === 'reference' ? 'deterministic_reference' : 'external', core: config.target === 'reference' ? 'scripted_reference' : 'external', memory: 'target_reported_observation', evaluator: 'independent_files_and_effects' },
        clock: { business: 'scaled-scenario-time', performance: 'monotonic-wall-time', speed: config.speed },
        limitations: ['本机 DEV 环境；不是同用户文件系统盲测隔离。', '参考执行器验证 Lab，不证明识雨模型或六域能力。', '业务服务是可复位的有状态替身。'],
      },
    };
    const rt = this.runtime(run);
    this.runtimes.set(id, rt);
    const token = randomBytes(32).toString('base64url');
    this.store.saveToken(id, hash(token));
    this.store.saveRun(run);
    writeFileSync(join(runDir, 'schedule.json'), JSON.stringify(schedule, null, 2));
    writeFileSync(servicePath, JSON.stringify(service, null, 2));
    run.status = 'running';
    this.emit(rt, 'run.started', 'lab', config.target === 'reference' ? '参考执行器开始 Lab 自检；不计为识雨能力验证。' : '外部 Agent 实验开始，等待客户端读取已发生输入。');
    for (const inputEvent of schedule) {
      this.schedule(rt, inputEvent.atMs / config.speed, () => this.inject(rt, inputEvent));
    }
    this.schedule(rt, scenario.durationMs / config.speed, () => {
      rt.injectionDone = true;
      if (run.status === 'running') run.status = 'draining';
      this.emit(rt, 'run.draining', 'lab', '外生输入已结束，等待已接纳工作结束。');
      this.pump(rt);
      this.maybeFinish(rt);
    });
    rt.deadline = setTimeout(() => {
      if (terminalStatuses.has(run.status)) return;
      run.error = '达到运行时限；未完成工作保留为未完成，未声明取消外部已发生效果。';
      void this.finish(rt, 'interrupted');
    }, config.maxDurationMs);
    return { run: this.getRun(id), ...(config.target === 'external' ? { targetToken: token } : {}) };
    } finally { this.creating--; }
  }

  private schedule(rt: Runtime, delayMs: number, callback: () => void): void {
    const timer = setTimeout(() => {
      rt.timers.delete(timer);
      if (terminalStatuses.has(rt.run.status) || rt.finishing) return;
      try { callback(); } catch (error) { rt.run.error = String(error); void this.finish(rt, 'failed'); }
    }, Math.max(0, delayMs - (performance.now() - rt.start)));
    rt.timers.add(timer);
  }

  private inject(rt: Runtime, input: ScheduledInput, reactive = false): void {
    if ((!reactive && rt.injectionDone) || terminalStatuses.has(rt.run.status) || rt.finishing) return;
    const elapsed = performance.now() - rt.start;
    const lag = Math.max(0, elapsed - input.atMs / rt.run.config.speed);
    rt.run.metrics.injectedInputs++;
    rt.run.metrics.maxInjectionLagMs = Math.max(rt.run.metrics.maxInjectionLagMs, lag);
    const task = input.taskId ? rt.run.tasks.find(t => t.id === input.taskId) : undefined;
    if (input.kind === 'request' && task) task.introduced = true;
    const event = this.emit(rt, `input.${input.kind}`, 'world', input.text, {
      actorId: input.actorId, channelId: input.channelId, taskId: input.taskId,
      data: { ...clone(input.data ?? {}), inputId: input.id, scheduledAtMs: input.atMs, injectionLagMs: Math.round(lag * 100) / 100 },
    });
    if (rt.run.config.target !== 'reference') return;
    if (input.kind === 'request' && task) {
      this.emit(rt, 'core.routed', 'core', `接纳「${task.title}」，根据依赖与空闲 worker 安排执行。`, { taskId: task.id, channelId: task.channelId, causeId: event.id });
      this.referenceAction(rt, { type: 'message.send', taskId: task.id, channelId: task.channelId, text: `收到，${task.title}已进入工作队列；结果会在这里交付。` }, `ack-${input.id}`);
      this.pump(rt);
    } else if (input.kind === 'query') {
      const related = task ?? rt.run.tasks.find(t => t.introduced && !terminalTasks.has(t.status));
      const status = related ? `「${related.title}」目前${{ queued: '等待执行', running: '正在处理', waiting: '等待补充信息', completed: '已完成并生成产物', failed: '执行失败，需要查看原因', cancelled: '已停止' }[related.status]}。` : '目前没有正在执行的工作。';
      this.emit(rt, 'replyer.responding', 'replyer', '只读查询任务进度，未抢占 worker。', { taskId: related?.id, channelId: input.channelId, causeId: event.id });
      this.referenceAction(rt, { type: 'message.send', channelId: input.channelId, taskId: related?.id, text: status }, `query-${input.id}`);
    } else if (input.kind === 'cancel' && task && task.introduced) {
      rt.active.get(task.id)?.abort();
      this.referenceAction(rt, { type: 'task.update', taskId: task.id, status: 'cancelled', detail: '收到场景中的停止指令。' }, `cancel-${input.id}`);
    } else if (input.kind === 'memory') {
      const key = typeof input.data?.key === 'string' ? input.data.key : `note-${input.actorId}`;
      const value = input.data?.value ?? input.text;
      this.referenceAction(rt, { type: 'state.record', domain: 'memory', key, value, sourceRefs: [event.id] }, `memory-${input.id}`);
    } else if (input.kind === 'correction') {
      this.emit(rt, 'core.reconsidered', 'core', '收到相关更正，记录当前来源供后续处理。参考执行器不代表真实语义理解。', { taskId: input.taskId, channelId: input.channelId, causeId: event.id });
      if (typeof input.data?.key === 'string') this.referenceAction(rt, { type: 'state.record', domain: 'memory', key: input.data.key, value: input.data.value ?? input.text, sourceRefs: [event.id] }, `correction-${input.id}`);
    }
  }

  private referenceAction(rt: Runtime, action: TargetAction, operationId: string): void {
    void this.act(rt.run.id, action, operationId).catch(error => { rt.run.error = String(error); });
  }

  private pump(rt: Runtime): void {
    if (rt.run.config.target !== 'reference' || terminalStatuses.has(rt.run.status) || rt.finishing) return;
    for (const task of rt.run.tasks) {
      if (rt.active.size >= rt.run.config.workerConcurrency) break;
      if (!task.introduced || task.status !== 'queued' || rt.active.has(task.id)) continue;
      const dependencies = task.dependencies.map(id => rt.run.tasks.find(t => t.id === id));
      if (dependencies.some(dep => !dep || ['failed', 'cancelled'].includes(dep.status))) {
        task.status = 'failed'; task.detail = '上游任务没有成功完成，依赖无法满足。'; task.finishedAt = new Date().toISOString();
        this.emit(rt, 'task.dependency_failed', 'lab', task.detail, { taskId: task.id });
        continue;
      }
      if (dependencies.some(dep => dep?.status !== 'completed')) continue;
      const controller = new AbortController();
      rt.active.set(task.id, controller);
      const promise = this.performWork(rt, task, controller).finally(() => {
        rt.active.delete(task.id); rt.workPromises.delete(promise);
        this.pump(rt); this.maybeFinish(rt);
      });
      rt.workPromises.add(promise);
    }
    this.maybeFinish(rt);
  }

  private async performWork(rt: Runtime, task: TaskRecord, controller: AbortController): Promise<void> {
    const id = rt.run.id;
    await this.act(id, { type: 'task.update', taskId: task.id, status: 'running', detail: '参考 worker 已取得执行槽。' }, `start-${task.id}`);
    try {
      const delay = rt.run.config.taskDelayMs + task.workMs / rt.run.config.speed;
      await new Promise<void>((resolveDelay, reject) => {
        if (controller.signal.aborted) { reject(new Error('工作已取消')); return; }
        const onAbort = () => { clearTimeout(timer); reject(new Error('工作已取消')); };
        const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolveDelay(); }, delay);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      if (controller.signal.aborted) return;
      await executeWork({ runDir: this.store.runDir(id), task: clone(task), signal: controller.signal, action: (action, operationId) => this.act(id, action, operationId) });
      if (controller.signal.aborted || terminalStatuses.has(rt.run.status)) return;
      const completion = await this.act(id, { type: 'task.update', taskId: task.id, status: 'completed', detail: '参考 worker 已生成交付物；独立验收将在运行结束后执行。' }, `complete-${task.id}`);
      if (!completion.ok) throw new Error(completion.error);
      await this.act(id, { type: 'message.send', taskId: task.id, channelId: task.channelId, text: `「${task.title}」已生成 ${task.artifactPaths.length} 份成果，可在 Lab 成果页检查。` }, `delivery-${task.id}`);
    } catch (error) {
      if (terminalStatuses.has(rt.run.status) || rt.finishing) return;
      await this.act(id, { type: 'task.update', taskId: task.id, status: controller.signal.aborted ? 'cancelled' : 'failed', detail: String(error) }, `failure-${task.id}`);
    }
  }

  private maybeFinish(rt: Runtime): void {
    if (rt.finishing || terminalStatuses.has(rt.run.status) || !rt.injectionDone || rt.active.size || rt.actorTimers.size) return;
    if (rt.run.tasks.some(task => task.introduced && !terminalTasks.has(task.status))) return;
    if (rt.run.config.target === 'external') {
      // A completion claim is not the final delivery handshake. Wait for the
      // current deliverables and an actual message after their latest write.
      for (const task of rt.run.tasks.filter(item => item.introduced && item.status === 'completed')) {
        if (!task.deliverables.every(path => rt.run.artifacts.some(artifact => artifact.taskId === task.id && artifact.path === path))) return;
        const writes = rt.run.events.filter(event => event.type === 'file.written' && event.taskId === task.id && task.deliverables.includes(String(event.data?.path)));
        const latestWrite = Math.max(0, ...writes.map(event => event.seq));
        if (!rt.run.events.some(event => event.type === 'message.delivered' && event.taskId === task.id && event.channelId === task.channelId && event.seq > latestWrite)) return;
      }
    }
    void this.finish(rt, 'completed');
  }

  async controlRun(id: string, command: 'drain' | 'stop'): Promise<RunDetail> {
    const rt = this.find(id);
    if (!['drain', 'stop'].includes(command)) throw new Error('未知控制命令');
    if (terminalStatuses.has(rt.run.status)) return this.getRun(id);
    if (command === 'stop') await this.finish(rt, 'stopped');
    else {
      this.clearInjection(rt); rt.injectionDone = true; rt.run.status = 'draining';
      this.emit(rt, 'run.draining', 'lab', '已停止新增输入，继续处理已接纳的工作。');
      this.pump(rt); this.maybeFinish(rt);
    }
    return this.getRun(id);
  }

  private clearInjection(rt: Runtime): void { for (const timer of rt.timers) clearTimeout(timer); rt.timers.clear(); }

  private finish(rt: Runtime, status: 'completed' | 'stopped' | 'interrupted' | 'failed'): Promise<void> {
    if (rt.finalization) return rt.finalization;
    if (terminalStatuses.has(rt.run.status)) return Promise.resolve();
    rt.finalization = this.finalize(rt, status);
    return rt.finalization;
  }

  private async finalize(rt: Runtime, status: 'completed' | 'stopped' | 'interrupted' | 'failed'): Promise<void> {
    if (rt.finishing || terminalStatuses.has(rt.run.status)) return;
    rt.finishing = true; this.clearInjection(rt); rt.injectionDone = true;
    for (const timer of rt.actorTimers) clearTimeout(timer); rt.actorTimers.clear();
    if (rt.deadline) clearTimeout(rt.deadline);
    rt.run.status = status; rt.run.finishedAt = new Date().toISOString();
    for (const controller of rt.active.values()) controller.abort();
    if (status === 'stopped') for (const task of rt.run.tasks) {
      if (task.introduced && !terminalTasks.has(task.status)) { task.status = 'cancelled'; task.detail = '实验已停止；已发生外部效果仍保留。'; task.finishedAt = rt.run.finishedAt; }
    }
    this.emit(rt, 'run.finished', 'lab', { completed: '输入与已接纳工作均已结束，正在独立验收。', stopped: '实验已停止，已发生效果与未完成任务均保留。', interrupted: rt.run.error ?? '运行中断。', failed: rt.run.error ?? '运行失败。' }[status]);
    try {
      rt.run.factReport = await evaluateRun(clone(rt.run), this.store.runDir(rt.run.id));
      writeFileSync(join(this.store.runDir(rt.run.id), 'facts.json'), JSON.stringify(rt.run.factReport, null, 2));
      this.emit(rt, 'evaluation.completed', 'lab', rt.run.factReport.summary);
    } catch (error) {
      rt.run.error = `${rt.run.error ? `${rt.run.error}\n` : ''}独立验收失败：${String(error)}`;
      this.emit(rt, 'evaluation.error', 'lab', rt.run.error);
    }
    this.refreshMetrics(rt); this.store.saveRun(rt.run); rt.finishing = false;
  }

  eventsSince(id: string, after = 0): LabEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('无效事件游标');
    return clone(this.find(id).run.events.filter(event => event.seq > after));
  }

  targetInputs(id: string, after = 0): TargetInput[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('无效输入游标');
    const run = this.find(id).run;
    return clone(run.events.filter(event => event.type.startsWith('input.') && event.seq > after).map(event => {
      const record = event.taskId ? run.tasks.find(task => task.id === event.taskId && task.introduced) : undefined;
      const task: TaskSpec | undefined = record ? { id: record.id, subjectId: record.subjectId, title: record.title, ownerId: record.ownerId, channelId: record.channelId, instructions: record.instructions, inputs: [...record.inputs], deliverables: [...record.deliverables], dependencies: [...record.dependencies], workMs: record.workMs, dueAtMs: record.dueAtMs } : undefined;
      return { seq: event.seq, event, ...(task ? { task } : {}) };
    }));
  }

  authorizeTarget(id: string, token: string): boolean {
    if (!this.runtimes.has(id) || typeof token !== 'string' || token.length > 200) return false;
    const expected = this.store.getTokenHash(id);
    if (!expected) return false;
    const actual = hash(token);
    return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }

  subscribe(id: string, listener: (event: LabEvent) => void): () => void {
    const rt = this.find(id); rt.listeners.add(listener);
    return () => rt.listeners.delete(listener);
  }

  async saveReview(id: string, review: ReviewResult): Promise<void> {
    const rt = this.find(id);
    if (!terminalStatuses.has(rt.run.status) || rt.finishing) throw new Error('运行尚未封存');
    if (rt.run.reviews.some(existing => existing.id === review.id)) throw new Error('评审 ID 已存在');
    if (!/^[a-zA-Z0-9_-]+$/.test(review.id)) throw new Error('无效评审 ID');
    rt.run.reviews.push(clone(review));
    const directory = join(this.store.runDir(id), 'reviews'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${review.id}.json`), JSON.stringify(review, null, 2));
    this.store.saveRun(rt.run);
  }

  async act(id: string, action: TargetAction, operationId: string = randomUUID()): Promise<ActionResult> {
    const rt = this.find(id);
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(operationId)) return { ok: false, error: '无效 operationId' };
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return { ok: false, error: '无效动作' };
    const requestHash = hash(stable(action));
    const previous = this.store.getOperation(id, operationId);
    if (previous) {
      if (previous.requestHash !== requestHash) return { ok: false, error: '同一 operationId 的内容不可改变' };
      if (!terminalStatuses.has(rt.run.status)) this.emit(rt, 'tool.replayed', 'world', '返回已知操作结果，没有重复产生效果。', { taskId: 'taskId' in action ? action.taskId : undefined, data: { operationId, actionType: action.type } });
      return clone(previous.result);
    }
    const readOnly = action.type === 'file.read' || action.type === 'service.inspect';
    if (terminalStatuses.has(rt.run.status) || rt.finishing) return { ok: false, error: '运行已封存，Agent 动作已停止' };
    const taskId = 'taskId' in action ? action.taskId : undefined;
    if (taskId && !rt.run.tasks.some(task => task.id === taskId && task.introduced)) return { ok: false, error: '任务尚未接纳或不存在' };
    this.emit(rt, 'tool.call', action.type === 'message.send' ? 'replyer' : 'worker', `请求 ${action.type}`, { taskId, data: { operationId, actionType: action.type, ...('path' in action ? { path: action.path } : {}) } });
    rt.run.metrics.toolCalls++;
    const canFault = action.type === 'file.write' || action.type === 'service.configure';
    if (canFault && !rt.faultConsumed && rt.run.config.fault === 'tool-once') {
      rt.faultConsumed = true;
      const result: ActionResult = { ok: false, error: 'Lab 注入一次工具不可用；没有产生效果。', retryable: true };
      this.emit(rt, 'tool.result', 'world', result.error!, { taskId, data: { operationId, actionType: action.type, ...result } });
      return result;
    }
    let result: ActionResult;
    try { result = this.applyAction(rt, action, operationId); }
    catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    this.store.saveOperation(id, operationId, requestHash, result);
    if (canFault && result.ok && !rt.faultConsumed && rt.run.config.fault === 'lost-receipt') {
      rt.faultConsumed = true;
      const unknown: ActionResult = { ok: false, error: 'Lab 注入回执丢失；实际效果需要按同一 operationId 核对。', unknown: true };
      this.emit(rt, 'tool.result', 'world', unknown.error!, { taskId, data: { operationId, actionType: action.type, ...unknown } });
      return unknown;
    }
    this.emit(rt, 'tool.result', 'world', result.ok ? `${action.type} 已完成。` : result.error ?? '操作失败。', { taskId, data: { operationId, actionType: action.type, ok: result.ok, ...(result.error ? { error: result.error } : {}) } });
    this.refreshMetrics(rt); this.store.saveRun(rt.run);
    if (action.type === 'task.update') this.pump(rt);
    this.maybeFinish(rt);
    return clone(result);
  }

  private applyAction(rt: Runtime, action: TargetAction, operationId: string): ActionResult {
    const run = rt.run;
    const task = 'taskId' in action && action.taskId ? run.tasks.find(item => item.id === action.taskId && item.introduced) : undefined;
    switch (action.type) {
      case 'task.update': {
        if (!task || !taskStates.has(action.status)) throw new Error('无效任务状态');
        if (terminalTasks.has(task.status) && task.status !== action.status) throw new Error('已结束任务不能用旧操作重新打开');
        task.status = action.status; task.detail = typeof action.detail === 'string' ? action.detail.slice(0, 4000) : undefined;
        if (action.status === 'running') task.startedAt ??= new Date().toISOString();
        if (terminalTasks.has(action.status)) task.finishedAt ??= new Date().toISOString();
        this.emit(rt, 'task.updated', 'worker', `${task.title}：${action.status}${task.detail ? ` · ${task.detail}` : ''}`, { taskId: task.id, data: { status: action.status, source: 'target_reported' } });
        return { ok: true, data: { status: task.status } };
      }
      case 'file.read': {
        const available = run.tasks.filter(item => item.introduced).some(item => item.inputs.includes(action.path)) || run.artifacts.some(artifact => artifact.path === action.path);
        if (!available) throw new Error('文件不在当前已接纳任务的可读资产中');
        const file = this.safePath(run.id, action.path, false);
        const bytes = readFileSync(file);
        if (bytes.length > 5 * 1024 * 1024) throw new Error('文件超过单次读取上限');
        const binary = ['.xlsx', '.docx', '.png', '.pdf', '.zip'].includes(extname(file).toLowerCase());
        return { ok: true, data: { path: action.path, content: bytes.toString(binary ? 'base64' : 'utf8'), encoding: binary ? 'base64' : 'utf8' } };
      }
      case 'file.write': {
        if (!task || !action.path.startsWith(`outputs/${task.id}/`)) throw new Error('成果必须写入当前任务的 outputs/<taskId>/ 目录');
        if (terminalTasks.has(task.status)) throw new Error('已结束任务不可继续改写成果');
        if (typeof action.content !== 'string' || action.content.length > 8 * 1024 * 1024) throw new Error('无效文件内容或超过写入上限');
        if (action.encoding && !['utf8', 'base64'].includes(action.encoding)) throw new Error('无效文件编码');
        if (action.encoding === 'base64' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(action.content) || action.content.length % 4 !== 0)) throw new Error('无效 Base64');
        const file = this.safePath(run.id, action.path, true);
        const bytes = Buffer.from(action.content, action.encoding === 'base64' ? 'base64' : 'utf8');
        const temporary = `${file}.lab-${randomBytes(4).toString('hex')}.tmp`;
        writeFileSync(temporary, bytes, { flag: 'wx' }); renameSync(temporary, file);
        const artifact: Artifact = { path: action.path, name: basename(file), bytes: bytes.length, sha256: hash(bytes), mime: mimeFor(file), taskId: task.id };
        const existing = run.artifacts.findIndex(item => item.path === action.path);
        if (existing >= 0) run.artifacts[existing] = artifact; else run.artifacts.push(artifact);
        if (!task.artifactPaths.includes(action.path)) task.artifactPaths.push(action.path);
        this.emit(rt, 'file.written', 'world', `已写入 ${action.path}（${bytes.length} 字节）。`, { taskId: task.id, data: { ...artifact, operationId } });
        return { ok: true, data: artifact };
      }
      case 'message.send': {
        if (!catalog.channels.some(channel => channel.id === action.channelId)) throw new Error('未知会话');
        if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 10000) throw new Error('消息为空或过长');
        if (action.toActorId && !catalog.channels.find(channel => channel.id === action.channelId)?.memberIds.includes(action.toActorId)) throw new Error('接收人不在该会话内');
        run.metrics.replies++;
        this.emit(rt, 'message.delivered', 'world', action.text, { channelId: action.channelId, taskId: action.taskId, data: { operationId, ...(action.toActorId ? { toActorId: action.toActorId } : {}) } });
        this.actorResponse(rt, action, operationId);
        return { ok: true, data: { delivered: true, channelId: action.channelId } };
      }
      case 'service.inspect': {
        this.emit(rt, 'service.inspected', 'world', `${run.service.name}：${run.service.healthy ? '健康' : '异常'}`, { taskId: action.taskId, data: { service: clone(run.service), operationId } });
        return { ok: true, data: clone(run.service) };
      }
      case 'service.configure': {
        if (!task || task.subjectId !== 'maintenance') throw new Error('当前任务不包含测试服务维护');
        if (terminalTasks.has(task.status)) throw new Error('已结束任务不可继续修改服务');
        if (!Number.isInteger(action.maxConnections) || action.maxConnections < 1 || action.maxConnections > 1024 || typeof action.maintenance !== 'boolean') throw new Error('无效服务配置');
        run.service.config.maxConnections = action.maxConnections; run.service.config.maintenance = action.maintenance;
        run.service.healthy = action.maxConnections >= run.service.config.requiredConnections && !action.maintenance;
        run.service.revision++;
        run.service.logs.push(`revision=${run.service.revision} maxConnections=${action.maxConnections} maintenance=${action.maintenance} healthy=${run.service.healthy}`);
        writeFileSync(join(this.store.runDir(run.id), 'workspace', 'service.json'), JSON.stringify(run.service, null, 2));
        this.emit(rt, 'service.configured', 'world', `测试服务配置已改变，当前${run.service.healthy ? '健康' : '异常'}。`, { taskId: task.id, data: { service: clone(run.service), operationId } });
        return { ok: true, data: clone(run.service) };
      }
      case 'state.record': {
        if (!memoryDomains.has(action.domain) || typeof action.key !== 'string' || !action.key || action.key.length > 200) throw new Error('无效内层观察');
        if (stable(action.value).length > 10000 || !Array.isArray(action.sourceRefs) || action.sourceRefs.length > 100 || action.sourceRefs.some(ref => !run.events.some(event => event.id === ref))) throw new Error('观察来源不存在或内容过大');
        const record = { value: clone(action.value), sourceRefs: [...action.sourceRefs], observedAt: new Date().toISOString(), source: 'target_reported' };
        run.memory[`${action.domain}.${action.key}`] = record;
        this.emit(rt, 'state.observed', 'memory', `收到 ${action.domain} / ${action.key} 的被测侧状态观察。`, { data: { domain: action.domain, key: action.key, ...record } });
        return { ok: true, data: { recorded: true, source: 'target_reported' } };
      }
      case 'observe': {
        if (!roles.has(action.role) || typeof action.text !== 'string' || action.text.length > 10000 || stable(action.data).length > 20000) throw new Error('无效观察');
        this.emit(rt, 'target.observation', action.role, action.text, { taskId: action.taskId, data: { ...clone(action.data ?? {}), source: 'target_reported' } });
        return { ok: true };
      }
      default: throw new Error('未知动作类型');
    }
  }

  private actorResponse(rt: Runtime, action: Extract<TargetAction, { type: 'message.send' }>, operationId: string): void {
    if (!action.taskId || terminalStatuses.has(rt.run.status) || rt.finishing) return;
    const task = rt.run.tasks.find(item => item.id === action.taskId && item.introduced);
    if (!task) return;
    const channel = catalog.channels.find(item => item.id === action.channelId);
    const actorId = action.toActorId ?? task.ownerId;
    if (actorId !== task.ownerId || !channel?.memberIds.includes(actorId)) return;
    const asks = /[？?]|请.*(?:提供|补充|确认|告知)/.test(action.text);
    const asksAssets = asks && /资料|材料|文件|附件|输入|数据.*(?:哪里|提供|位置)/.test(action.text);
    const delivered = !asks && /已(?:经)?(?:完成|交付|生成)|成果.*(?:完成|交付|生成)/.test(action.text);
    if (!asks && !delivered) return;
    if (asks && !asksAssets) {
      this.emit(rt, 'lab.unsupported', 'lab', '演员尚未覆盖此提问的业务语义；保留原消息，不能把它算为被测 Agent 失败。', { taskId: task.id, channelId: action.channelId, data: { operationId, actorId, source: 'actor_adapter' } });
      return;
    }
    const counterKey = `${task.id}:${asksAssets ? 'assets' : 'delivery'}`;
    const count = rt.actorCounts.get(counterKey) ?? 0;
    if (count >= (asksAssets ? 3 : 1)) return;
    rt.actorCounts.set(counterKey, count + 1);
    const text = asksAssets
      ? `关于「${task.title}」，我提供的材料在 ${task.inputs.join('、')}。请按任务说明继续；未提供的新事实我暂时无法补充。`
      : task.artifactPaths.length
        ? `已收到「${task.title}」的 ${task.artifactPaths.length} 份成果，我会按任务要求核对。`
        : `我看到了完成通知，但还没有找到「${task.title}」的成果文件，请补充交付物。`;
    const input: ScheduledInput = {
      id: `actor-${operationId}`, atMs: (performance.now() - rt.start + 150) * rt.run.config.speed,
      actorId, channelId: action.channelId, kind: 'message', taskId: task.id, text,
      data: { interaction: 'bounded_script', branch: asksAssets ? 'known_assets' : 'delivery_received', respondsTo: operationId },
    };
    rt.run.metrics.scheduledInputs++;
    const timer = setTimeout(() => {
      rt.actorTimers.delete(timer);
      this.inject(rt, input, true);
      this.maybeFinish(rt);
    }, 150);
    rt.actorTimers.add(timer);
  }

  private safePath(runId: string, relative: string, writing: boolean): string {
    if (typeof relative !== 'string' || relative.length > 300 || isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('无效工作文件路径');
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..') || !['inputs', 'outputs'].includes(parts[0])) throw new Error('文件路径不在工作区');
    const root = join(this.store.runDir(runId), 'workspace');
    const file = resolve(root, relative);
    if (!file.startsWith(`${resolve(root)}${sep}`)) throw new Error('文件路径越界');
    let current = root;
    if (lstatSync(current).isSymbolicLink()) throw new Error('工作区不能是符号链接');
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (info.isSymbolicLink()) throw new Error('不允许符号链接');
        if (index < parts.length - 1 && !info.isDirectory()) throw new Error('路径组件不是目录');
        if (index === parts.length - 1 && !info.isFile()) throw new Error('目标不是普通文件');
      } else if (index < parts.length - 1) {
        if (!writing) throw new Error('文件不存在');
        mkdirSync(current);
      } else if (!writing) throw new Error('文件不存在');
    }
    return file;
  }

  private emit(rt: Runtime, type: string, role: Role, text: string, fields: EventFields = {}): LabEvent {
    const elapsedMs = Math.max(0, Math.round(performance.now() - rt.start));
    const seq = (rt.run.events.at(-1)?.seq ?? 0) + 1;
    const event: LabEvent = { id: `${rt.run.id}:e${seq}`, seq, runId: rt.run.id, at: new Date().toISOString(), elapsedMs, businessMs: Math.round(elapsedMs * rt.run.config.speed), type, role, text, ...fields };
    rt.run.events.push(event); this.store.appendEvent(rt.run.id, event);
    this.refreshMetrics(rt); this.store.saveRun(rt.run);
    for (const listener of rt.listeners) { try { listener(clone(event)); } catch { /* A disconnected viewer cannot fail a run. */ } }
    return event;
  }

  private refreshMetrics(rt: Runtime): void {
    const tasks = rt.run.tasks.filter(task => task.introduced);
    rt.run.metrics.completedTasks = tasks.filter(task => task.status === 'completed').length;
    rt.run.metrics.failedTasks = tasks.filter(task => task.status === 'failed').length;
    rt.run.metrics.pendingTasks = tasks.filter(task => !terminalTasks.has(task.status)).length;
    rt.run.metrics.elapsedMs = rt.run.finishedAt ? Math.max(0, Date.parse(rt.run.finishedAt) - Date.parse(rt.run.createdAt)) : Math.max(0, Math.round(performance.now() - rt.start));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const rt of this.runtimes.values()) {
      if (!terminalStatuses.has(rt.run.status)) { rt.run.error = 'Lab 正常关闭，活动运行标为中断；下次启动保留轨迹。'; await this.finish(rt, 'interrupted'); }
      if (rt.finalization) await rt.finalization;
      this.clearInjection(rt); if (rt.deadline) clearTimeout(rt.deadline);
      await Promise.allSettled([...rt.workPromises]); rt.listeners.clear();
    }
    this.store.close();
  }
}

export function mimeFor(path: string): string {
  return ({ '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png': 'image/png', '.pdf': 'application/pdf' } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
