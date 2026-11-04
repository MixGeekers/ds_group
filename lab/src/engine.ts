import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { Timeline, systemTime, validateTimeConfig, parseStoryInstant } from './time.ts';
import type { Occurrence, TimeSource } from './time.ts';
import { catalog, getScenario, scenarioCompany } from './catalog.ts';
import { decodeInputContent, validateInputPath, validateScenario } from './scenarios.ts';
import { seedWorkspace, executeWork } from './workloads.ts';
import { evaluateRun } from './evaluation.ts';
import { LabStore } from './store.ts';
import { isAcknowledgementOnly } from './outcome.ts';
import type { ActionResult, Artifact, CompanySnapshot, EvaluationMode, HumanMessage, HumanTask, InputAsset, LabEvent, ReviewResult, Role, RunConfig, RunDetail, RunSummary, Scenario, ScenarioAsset, ScheduledInput, ServiceState, TargetAction, TargetInput, TaskRecord, TaskSpec, TaskStatus } from './types.ts';

export const DEFAULT_CONFIG: RunConfig = {
  scenarioId: 'mixed-office', target: 'reference', seed: 42, noiseCount: 40,
  speed: 5, workerConcurrency: 3, taskDelayMs: 150, fault: 'none', maxDurationMs: 60_000,
};

type Runtime = {
  run: RunDetail; start: number; timers: Set<ReturnType<typeof setTimeout>>;
  actorTimers: Set<ReturnType<typeof setTimeout>>; actorCounts: Map<string, number>;
  deadline?: ReturnType<typeof setTimeout>; active: Map<string, AbortController>;
  injectionDone: boolean; drainRequested: boolean; finishing: boolean; faultConsumed: boolean;
  listeners: Set<(event: LabEvent) => void>;
  workPromises: Set<Promise<void>>;
  finalization?: Promise<void>;
  timeline?: Timeline; timeTimer?: ReturnType<typeof setTimeout>; advancing?: boolean;
};

type EventFields = Partial<Pick<LabEvent, 'actorId' | 'channelId' | 'taskId' | 'data' | 'causeId'>>;
export interface MessageReceiptQuery { operationId: string; channelId: string; bodyHash: string; }
export type MessageReceipt = MessageReceiptQuery & { runId: string } & (
  | { status: 'delivered'; eventId: string; observedAt: string }
  | { status: 'not_found' | 'ambiguous' }
);
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
  const config = { ...DEFAULT_CONFIG, ...input, evaluationMode: input.evaluationMode ?? 'protocol', keepOpen: input.keepOpen ?? false };
  if (input.keepOpen !== undefined && typeof input.keepOpen !== 'boolean') throw new Error('keepOpen 必须为布尔值');
  if (input.time !== undefined) config.time = validateTimeConfig(input.time);
  if (!['protocol', 'outcome'].includes(config.evaluationMode)) throw new Error('未知验收模式');
  if (!['reference', 'external'].includes(config.target)) throw new Error('未知被测对象');
  if (config.evaluationMode === 'outcome' && config.target === 'reference') throw new Error('业务成果模式仅支持 external；参考执行器只用于 protocol 自检');
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
export function generateNoise(seed: number, count: number, durationMs: number, company: CompanySnapshot = catalog): ScheduledInput[] {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const messages = ['午餐有人一起吗？', '会议室里的转接头找到了。', '这张窗外的照片很好看。', '咖啡机旁边有新茶包。', '收到，谢谢大家。', '今天下午茶改到三点。', '我晚五分钟到会议室。', '这周推荐的书已放在共享区。', '楼下新开的店味道还不错。', '刚看到消息，稍后回复。'];
  const channels = company.channels.filter(c => c.kind === 'group').map(c => ({ ...c, memberIds: c.memberIds.filter(id => id !== 'HUMAN' && id !== 'SHIYU') })).filter(c => c.memberIds.length);
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

  private readonly scenarioResolver: (id: string, mode: EvaluationMode) => Scenario;
  private readonly clock: TimeSource;
  constructor(options: { runtimeDir: string; scenarioResolver?: (id: string, mode: EvaluationMode) => Scenario; clock?: TimeSource }) {
    this.store = new LabStore(resolve(options.runtimeDir));
    this.scenarioResolver = options.scenarioResolver ?? getScenario;
    this.clock = options.clock ?? systemTime;
  }

  async init(): Promise<void> {
    this.store.init();
    for (const run of this.store.loadRuns()) {
      if (!terminalStatuses.has(run.status)) {
        if (run.time) run.manifest.timeRecovery = { status: 'unclean_exit', elapsed: 'lower_bound', reason: '缺少正常关闭水位，真实耗时和外部在途状态尚未核对。' };
        run.status = 'interrupted'; run.finishedAt = this.wallISO();
        run.error = 'Lab 进程退出，运行未完成；原始轨迹保留，没有自动重放任务。';
        run.factReport = undefined;
      }
      const rt = this.runtime(run);
      this.runtimes.set(run.id, rt);
      if (run.status === 'interrupted' && !run.factReport) {
        run.finishedAt ??= this.wallISO();
        const recovery = run.manifest.evidenceRecovery as { status?: string } | undefined;
        if (recovery?.status === 'incomplete') {
          const tasksTotal = run.tasks.filter(task => task.introduced).length;
          run.factReport = {
            id: `facts-${randomUUID()}`, at: this.wallISO(), scope: run.config.target === 'reference' ? 'lab_self_test' : 'target_evaluation',
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
    const timeline = run.time ? new Timeline(run.id, run.time, run.config.speed, this.clock) : undefined;
    if (timeline && terminalStatuses.has(run.status)) timeline.state.paused = true;
    const actorCounts = new Map<string, number>();
    for (const rule of timeline?.state.rules ?? []) {
      if (rule.source !== 'actor') continue;
      const input = rule.payload.input as ScheduledInput;
      const key = `${input.taskId}:${input.data?.branch === 'known_assets' ? 'assets' : 'delivery'}`;
      actorCounts.set(key, (actorCounts.get(key) ?? 0) + 1);
    }
    return { run, timeline, start: this.clock.monotonicNow() - run.metrics.elapsedMs, timers: new Set(), actorTimers: new Set(), actorCounts, active: new Map(), injectionDone: terminalStatuses.has(run.status), drainRequested: false, finishing: false, faultConsumed: false, listeners: new Set(), workPromises: new Set() };
  }

  private businessNow(rt: Runtime): number { return rt.timeline?.now() ?? Math.max(0, this.clock.monotonicNow() - rt.start) * rt.run.config.speed; }
  private wallISO(): string { return new Date(this.clock.wallNow()).toISOString(); }

  /** Target-safe clock view excludes the future world agenda. */
  timeView(id: string) {
    const rt = this.find(id);
    if (!rt.timeline) return undefined;
    return { ...rt.timeline.view(), realAt: this.wallISO(), elapsedMs: rt.run.metrics.elapsedMs,
      schedules: clone(rt.timeline.state.rules.filter(rule => rule.source === 'target')) };
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

  /** Authentication metadata for read-only target operations; does not refresh runtime metrics. */
  targetAccess(id: string): { target: RunConfig['target']; status: RunDetail['status'] } {
    const run = this.find(id).run;
    return { target: run.config.target, status: run.status };
  }

  runCompany(id: string): CompanySnapshot { return clone(this.find(id).run.company ?? scenarioCompany({})); }

  readableFiles(id: string): string[] {
    const run = this.find(id).run;
    const shared = run.events.filter(event => event.role === 'world' && event.type.startsWith('input.') && Array.isArray(event.data?.attachments)).flatMap(event => (event.data!.attachments as unknown[]).filter((file): file is string => typeof file === 'string'));
    return [...new Set([...run.tasks.filter(task => task.introduced).flatMap(task => task.inputs), ...shared, ...run.artifacts.map(artifact => artifact.path)])];
  }

  rotateTargetToken(id: string): string {
    const rt = this.find(id);
    if (this.closed || rt.finishing || terminalStatuses.has(rt.run.status) || rt.run.config.target !== 'external') throw new Error('只有活动 external 运行可以重新生成接入令牌');
    const token = randomBytes(32).toString('base64url');
    this.store.saveToken(id, hash(token));
    this.emit(rt, 'target.token_rotated', 'lab', '已重新生成本次运行的接入令牌；旧令牌立即失效。');
    return token;
  }

  private registeredFile(rt: Runtime, relative: string, outputOnly = false): { path: string; bytes: number; sha256: string } {
    if (typeof relative !== 'string' || relative.length > 512) throw new Error('附件路径无效');
    const inputs = Array.isArray(rt.run.manifest.inputAssets) ? rt.run.manifest.inputAssets as InputAsset[] : [];
    const sources = inputs.filter(asset => asset.path === relative);
    const artifacts = rt.run.artifacts.filter(artifact => artifact.path === relative);
    if (artifacts.length + (outputOnly ? 0 : sources.length) !== 1) throw new Error('附件必须是本运行实际登记的输入或成果文件');
    const record = artifacts[0] ?? sources[0];
    if (outputOnly && !artifacts.length) throw new Error('目标附件只能引用本运行已登记成果');
    const bytes = readFileSync(this.safePath(rt.run.id, relative, false));
    if (bytes.length > 4 * 1024 * 1024 || record.bytes !== bytes.length || record.sha256 !== hash(bytes)) throw new Error('附件与登记的字节数或摘要不符');
    if (artifacts.length) {
      const artifact = artifacts[0];
      const write = rt.run.events.filter(event => event.role === 'world' && event.type === 'file.written' && event.data?.path === relative).at(-1);
      if (!artifact.taskId || !relative.startsWith(`outputs/${artifact.taskId}/`) || !rt.run.tasks.some(task => task.id === artifact.taskId && task.introduced) || !write || write.taskId !== artifact.taskId || write.data?.bytes !== record.bytes || write.data?.sha256 !== record.sha256) throw new Error('成果附件缺少所属任务或真实写入证据');
    } else validateInputPath(relative);
    return { path: relative, bytes: record.bytes, sha256: record.sha256 };
  }

  private attachments(rt: Runtime, value: unknown, outputOnly = false): Array<{ path: string; bytes: number; sha256: string }> {
    const files = value ?? [];
    if (!Array.isArray(files) || files.length > 32 || new Set(files).size !== files.length || files.some(file => typeof file !== 'string')) throw new Error('附件必须为最多32项的不重复路径数组');
    return files.map(file => this.registeredFile(rt, file, outputOnly));
  }

  private humanOperation(id: string, type: string, payload: unknown, operationId: string, apply: (rt: Runtime, meta: Record<string, unknown>) => ActionResult): ActionResult {
    const rt = this.find(id);
    if (this.closed) return { ok: false, error: 'Lab 已关闭' };
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(operationId)) return { ok: false, error: '无效 operationId' };
    const key = `human/${operationId}`, requestHash = hash(stable({ type, payload }));
    const old = this.store.getOperation(id, key);
    if (old) return old.requestHash === requestHash ? clone(old.result) : { ok: false, error: '同一 operationId 的内容不可改变' };
    const occurred = rt.run.events.find(event => event.data?.humanOperationKey === key);
    if (occurred) {
      if (occurred.data?.requestHash !== requestHash || occurred.data?.operationType !== type) return { ok: false, error: '同一 operationId 的内容不可改变' };
      const result: ActionResult = type === 'human.message' ? { ok: true, data: { event: clone(occurred) } } : type === 'human.task' ? { ok: true, data: { task: clone(occurred.data?.taskSnapshot), event: clone(occurred) } } : { ok: true, data: { path: occurred.data?.path, bytes: occurred.data?.bytes, sha256: occurred.data?.sha256 } };
      this.store.saveOperation(id, key, requestHash, result);
      return result;
    }
    if (terminalStatuses.has(rt.run.status) || rt.finishing) return { ok: false, error: '运行已封存，不再接收新的真人操作' };
    if (rt.drainRequested) return { ok: false, error: '运行已进入用户请求的排空阶段，不再接收新输入' };
    let result: ActionResult;
    try { result = apply(rt, { source: 'human', operationId, humanOperationKey: key, operationType: type, requestHash }); }
    catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    this.store.saveOperation(id, key, requestHash, result);
    this.refreshMetrics(rt); this.store.saveRun(rt.run); this.maybeFinish(rt);
    return clone(result);
  }

  async postMessage(id: string, input: HumanMessage, operationId: string): Promise<ActionResult> {
    return this.humanOperation(id, 'human.message', input, operationId, (rt, meta) => {
      if (!input || typeof input !== 'object') throw new Error('消息无效');
      const channel = this.runCompany(id).channels.find(channel => channel.id === input.channelId);
      if (!channel?.memberIds.includes('HUMAN')) throw new Error('HUMAN 不是该会话成员；职员私聊仅可观察');
      if (typeof input.text !== 'string' || input.text.length > 10000) throw new Error('消息正文无效或超过10000字符');
      const attachments = this.attachments(rt, input.attachments);
      if (!input.text.trim() && !attachments.length) throw new Error('消息与附件不能同时为空');
      if (rt.run.events.filter(event => event.type.startsWith('input.') && event.data?.source === 'human').length >= 2048) throw new Error('本运行真人输入已达到2048条上限');
      rt.run.metrics.scheduledInputs++; rt.run.metrics.injectedInputs++;
      const event = this.emit(rt, 'input.message', 'world', input.text.trim() || `分享了 ${attachments.length} 份资料。`, { actorId: 'HUMAN', channelId: input.channelId, data: { ...meta, attachments: attachments.map(asset => asset.path), attachmentAssets: attachments } });
      return { ok: true, data: { event } };
    });
  }

  async publishTask(id: string, input: HumanTask, operationId: string): Promise<ActionResult> {
    return this.humanOperation(id, 'human.task', input, operationId, (rt, meta) => {
      if (rt.run.config.evaluationMode !== 'outcome' || rt.run.config.target !== 'external') throw new Error('手动发布任务只用于 external/outcome 运行');
      if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || typeof input.instructions !== 'string' || !input.instructions.trim() || input.instructions.length > 12000) throw new Error('任务名称或要求无效');
      if (!this.runCompany(id).channels.find(channel => channel.id === input.channelId)?.memberIds.includes('HUMAN')) throw new Error('HUMAN 不是任务会话成员');
      if (rt.run.tasks.filter(task => task.ownerId === 'HUMAN' && task.id.startsWith('U')).length >= 32 || rt.run.tasks.length >= 128) throw new Error('手动任务数达到上限');
      const files = this.attachments(rt, input.inputs);
      const dueAtMs = input.dueAtMs ?? Math.round(this.businessNow(rt)) + 60000;
      if (typeof dueAtMs !== 'number' || !Number.isFinite(dueAtMs) || dueAtMs < 0 || dueAtMs > Number.MAX_SAFE_INTEGER) throw new Error('任务截止时间无效');
      const task: TaskRecord = { id: `U${randomUUID().replaceAll('-', '')}`, subjectId: 'generic', title: input.title.trim(), ownerId: 'HUMAN', channelId: input.channelId, instructions: input.instructions.trim(), inputs: files.map(file => file.path), deliverables: [], dependencies: [], workMs: 0, dueAtMs, evaluationMode: 'outcome', businessRequirements: [input.instructions.trim()], deliveryPolicy: { allowText: true, minFiles: 0 }, status: 'queued', introduced: true, artifactPaths: [] };
      this.scheduleDeadline(rt, task); rt.run.tasks.push(task); rt.run.metrics.scheduledInputs++; rt.run.metrics.injectedInputs++;
      const event = this.emit(rt, 'input.request', 'world', `${task.title}\n${task.instructions}`, { actorId: 'HUMAN', channelId: task.channelId, taskId: task.id, data: { ...meta, attachments: files.map(file => file.path), attachmentAssets: files, taskSnapshot: clone(task) } });
      return { ok: true, data: { task: clone(task), event } };
    });
  }

  async addInputFile(id: string, input: ScenarioAsset, operationId: string): Promise<ActionResult> {
    return this.humanOperation(id, 'human.input', input, operationId, (rt, meta) => {
      if (!input || typeof input !== 'object') throw new Error('输入文件无效');
      const relative = validateInputPath(input.path);
      if (!relative.startsWith('inputs/user/')) throw new Error('用户上传文件只能位于 inputs/user/');
      const bytes = decodeInputContent(input);
      const assets = (rt.run.manifest.inputAssets ?? []) as InputAsset[];
      const uploaded = assets.filter(asset => asset.source === 'user');
      if (uploaded.length >= 64 || uploaded.reduce((sum, asset) => sum + asset.bytes, 0) + bytes.length > 16 * 1024 * 1024) throw new Error('用户上传超过64份或16 MiB总量上限');
      if (assets.some(asset => asset.path === relative) || rt.run.artifacts.some(artifact => artifact.path === relative)) throw new Error('输入文件已登记，不允许覆盖');
      const filename = this.safePath(id, relative, true);
      if (existsSync(filename)) throw new Error('输入文件已经存在，不允许覆盖');
      writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
      const asset: InputAsset = { path: relative, bytes: bytes.length, sha256: hash(bytes), source: 'user' };
      rt.run.manifest.inputAssets = [...assets, asset];
      this.emit(rt, 'workspace.input_added', 'world', `已添加输入文件 ${relative}；尚未通过消息或任务分享给被测对象。`, { actorId: 'HUMAN', data: { ...meta, ...asset, source: 'human' } });
      return { ok: true, data: { path: asset.path, bytes: asset.bytes, sha256: asset.sha256 } };
    });
  }

  async createRun(input: Partial<RunConfig>): Promise<{ run: RunDetail; targetToken?: string }> {
    if (this.closed) throw new Error('Lab 已关闭');
    if (this.creating + [...this.runtimes.values()].filter(rt => !terminalStatuses.has(rt.run.status)).length >= 4) throw Object.assign(new Error('最多同时运行 4 个实验'), { statusCode: 409 });
    const config = configFor(input);
    const scenario = validateScenario(this.scenarioResolver(config.scenarioId, config.evaluationMode!), config.evaluationMode);
    if (scenario.id !== config.scenarioId) throw new Error('剧本 resolver 返回了不同场景，已拒绝启动');
    const company = scenarioCompany(scenario);
    this.creating++;
    try {
    const id = `run-${this.clock.wallNow().toString(36)}-${randomBytes(4).toString('hex')}`;
    const runDir = this.store.runDir(id);
    mkdirSync(runDir, { recursive: true });
    const inputAssets = await seedWorkspace(runDir, scenario);
    writeFileSync(join(runDir, 'scenario.json'), JSON.stringify(scenario, null, 2), { flag: 'wx', mode: 0o600 });
    const servicePath = join(runDir, 'workspace', 'service.json');
    const defaultService: ServiceState = { name: '蓝桥订单服务', config: { maxConnections: 8, requiredConnections: 32, maintenance: false }, healthy: false, revision: 1, logs: ['connection pool exhausted: required=32 configured=8'] };
    const service: ServiceState = existsSync(servicePath) ? JSON.parse(readFileSync(servicePath, 'utf8')) : defaultService;
    const schedule = [...scenario.inputs, ...generateNoise(config.seed, config.noiseCount, scenario.durationMs, company)].sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
    const run: RunDetail = {
      id, name: scenario.name, status: 'prepared', createdAt: this.wallISO(), config,
      targetLabel: config.target === 'reference' ? '参考执行器 · Lab 自检' : '外部 Agent · 待测对象',
      metrics: { scheduledInputs: schedule.length, injectedInputs: 0, replies: 0, toolCalls: 0, completedTasks: 0, failedTasks: 0, pendingTasks: 0, maxInjectionLagMs: 0, elapsedMs: 0 },
      tasks: scenario.tasks.map(task => ({ ...clone(task), status: 'queued', introduced: false, artifactPaths: [] })),
      events: [], artifacts: [], reviews: [], service, memory: {}, company: clone(company),
      ...(config.time ? { time: { version: 1 as const, config: clone(config.time), businessMs: 0, paused: config.time.mode === 'story', stopped: false, rules: [] } } : {}),
      manifest: {
        schemaVersion: 1, scenarioId: scenario.id, scenarioDigest: hash(stable(scenario)), scheduleDigest: hash(stable(schedule)),
        createdAt: this.wallISO(), seed: config.seed, config: clone(config), evaluationMode: config.evaluationMode,
        inputAssets: clone(inputAssets),
        scenarioSnapshot: { path: 'scenario.json', sha256: hash(JSON.stringify(scenario, null, 2)) },
        scope: config.target === 'reference' ? 'lab_self_test' : 'target_evaluation',
        components: { inputDriver: 'real', world: 'stateful_test_double', worker: config.target === 'reference' ? 'deterministic_reference' : 'external', core: config.target === 'reference' ? 'scripted_reference' : 'external', memory: 'target_reported_observation', evaluator: 'independent_files_and_effects' },
        clock: { business: config.time?.mode ?? 'legacy-scaled-scenario-time', performance: 'monotonic', audit: 'real-calendar', speed: config.speed, ...(config.time ?? {}) },
        limitations: ['本机 DEV 环境；不是同用户文件系统盲测隔离。', '参考执行器验证 Lab，不证明识雨模型或六域能力。', '业务服务是可复位的有状态替身。'],
      },
    };
    const rt = this.runtime(run);
    if (rt.timeline) {
      for (const inputEvent of schedule) rt.timeline.add({ id: `external:${inputEvent.id}`, revision: 1, source: 'external', kind: 'input', nextAtMs: inputEvent.atMs, missed: 'each', payload: { input: clone(inputEvent) } });
      rt.timeline.add({ id: 'scenario:end', revision: 1, source: 'end', kind: 'end', nextAtMs: scenario.durationMs, missed: 'each', payload: {} });
    }
    this.runtimes.set(id, rt);
    const token = randomBytes(32).toString('base64url');
    this.store.saveToken(id, hash(token));
    this.store.saveRun(run);
    writeFileSync(join(runDir, 'schedule.json'), JSON.stringify(schedule, null, 2));
    writeFileSync(servicePath, JSON.stringify(service, null, 2));
    run.status = 'running';
    this.emit(rt, 'run.started', 'lab', config.target === 'reference' ? '参考执行器开始 Lab 自检；不计为识雨能力验证。' : '外部 Agent 实验开始，等待客户端读取已发生输入。');
    if (rt.timeline) {
      this.store.saveRun(run);
      this.armTimeline(rt);
    } else {
      for (const inputEvent of schedule) {
        this.schedule(rt, inputEvent.atMs / config.speed, () => this.inject(rt, inputEvent));
      }
      this.schedule(rt, scenario.durationMs / config.speed, () => {
        rt.injectionDone = true;
        if (!run.config.keepOpen || rt.drainRequested) {
          if (run.status === 'running') run.status = 'draining';
          this.emit(rt, 'run.draining', 'lab', '外生输入已结束，等待已接纳工作结束。');
        } else this.emit(rt, 'run.inputs_finished', 'lab', '剧本输入已结束；聊天室仍开放，可继续发言、分享资料和发布任务。');
        this.pump(rt);
        this.maybeFinish(rt);
      });
    }
    this.armDeadline(rt);
    return { run: this.getRun(id), ...(config.target === 'external' ? { targetToken: token } : {}) };
    } finally { this.creating--; }
  }

  private armDeadline(rt: Runtime): void {
    const run = rt.run;
    rt.deadline = setTimeout(() => {
      if (rt.finishing || terminalStatuses.has(run.status)) return;
      const delivered = run.config.keepOpen && rt.injectionDone && !rt.active.size && !rt.workPromises.size && !rt.actorTimers.size
        && (!rt.timeline || rt.timeline.nextTime() === undefined)
        && run.tasks.filter(task => task.introduced).every(task => task.status === 'completed' && this.hasDelivery(rt, task));
      if (delivered) {
        this.emit(rt, 'run.deadline_reached', 'lab', '房间时限已到；已引入任务均有实际交付（或没有任务），正常封存。运行结束不代表业务质量已通过，仍以独立验收与评分为准。', { data: { reason: 'time_budget_after_delivery' } });
        void this.finish(rt, 'completed');
        return;
      }
      run.error = '达到运行时限；仍有未结束输入、待交付任务或引擎工作，运行标为中断。已经交付的成果和独立验收记录仍保留，不受此状态覆盖。';
      void this.finish(rt, 'interrupted');
    }, Math.max(0, run.config.maxDurationMs - run.metrics.elapsedMs));
  }

  private schedule(rt: Runtime, delayMs: number, callback: () => void): void {
    const timer = setTimeout(() => {
      rt.timers.delete(timer);
      if (terminalStatuses.has(rt.run.status) || rt.finishing) return;
      try { callback(); } catch (error) { rt.run.error = String(error); void this.finish(rt, 'failed'); }
    }, Math.max(0, delayMs - (this.clock.monotonicNow() - rt.start)));
    rt.timers.add(timer);
  }

  private scheduleDeadline(rt: Runtime, task: TaskRecord): void {
    if (!rt.timeline) return;
    rt.timeline.add({ id: `deadline:${task.id}`, revision: 1, source: 'deadline', kind: 'deadline',
      nextAtMs: Math.max(rt.timeline.now(), task.dueAtMs), missed: 'each', payload: { taskId: task.id, dueAtMs: task.dueAtMs } });
    this.armTimeline(rt);
  }

  private armTimeline(rt: Runtime): void {
    if (rt.timeTimer) clearTimeout(rt.timeTimer);
    rt.timeTimer = undefined;
    const timeline = rt.timeline;
    if (!timeline || timeline.state.config.mode !== 'load' || timeline.state.paused || timeline.state.stopped || terminalStatuses.has(rt.run.status) || rt.finishing) return;
    const next = timeline.nextTime();
    if (next === undefined) return;
    rt.timeTimer = setTimeout(() => {
      rt.timeTimer = undefined;
      try { this.advanceTimeline(rt, timeline.now()); }
      catch (error) { rt.run.error = String(error); void this.finish(rt, 'interrupted'); }
      this.armTimeline(rt);
    }, Math.min(2_147_483_647, Math.max(0, (next - timeline.now()) / rt.run.config.speed)));
  }

  private advanceTimeline(rt: Runtime, horizon: number): void {
    const timeline = rt.timeline!;
    if (rt.advancing) throw new Error('时间推进正在执行');
    rt.advancing = true;
    try {
      timeline.state.businessMs = Math.max(timeline.state.businessMs, horizon);
      // Bound each turn. Remaining each-policy occurrences keep their cursor.
      for (let count = 0; count < 256; count++) {
        if (terminalStatuses.has(rt.run.status) || rt.finishing || timeline.state.stopped) break;
        const occurrence = timeline.next(horizon);
        if (!occurrence) break;
        timeline.claim(occurrence);
        this.store.saveRun(rt.run);
        if (occurrence.deliveredCount) this.dispatchOccurrence(rt, occurrence);
        timeline.settle();
        this.emit(rt, 'time.occurrence', 'lab', occurrence.deliveredCount ? '计划发生项已处理。' : '按策略记录错过项。', { data: { ...occurrence, payload: undefined,
          scheduledAt: new Date(Date.parse(timeline.state.config.startAt) + occurrence.scheduledAtMs).toISOString(),
          omittedCount: occurrence.count - occurrence.deliveredCount } });
      }
      this.store.saveRun(rt.run);
      this.maybeFinish(rt);
    } finally { rt.advancing = false; }
  }

  private dispatchOccurrence(rt: Runtime, occurrence: Occurrence): void {
    const data = { occurrenceId: occurrence.id, scheduleId: occurrence.ruleId, revision: occurrence.revision,
      scheduledAtMs: occurrence.scheduledAtMs, firstAtMs: occurrence.firstAtMs, count: occurrence.count, missed: occurrence.missed };
    if (occurrence.kind === 'input') {
      const input = clone(occurrence.payload.input) as ScheduledInput;
      input.data = { ...input.data, ...data };
      this.inject(rt, input, occurrence.source === 'actor');
    } else if (occurrence.source === 'target') {
      this.emit(rt, `input.${occurrence.kind}`, 'lab', String(occurrence.payload.text), { data: { ...data, source: 'target_schedule' } });
    } else if (occurrence.kind === 'deadline') {
      const task = rt.run.tasks.find(task => task.id === occurrence.payload.taskId);
      this.emit(rt, 'task.deadline', 'world', '到达任务业务期限，保留当时状态及实际交付事实。', { taskId: task?.id,
        data: { ...data, dueAtMs: occurrence.payload.dueAtMs, status: task?.status, delivered: task ? this.hasDelivery(rt, task) : false } });
    } else if (occurrence.kind === 'end') {
      rt.injectionDone = true;
      if (!rt.run.config.keepOpen || rt.drainRequested) rt.run.status = 'draining';
      this.emit(rt, 'run.inputs_finished', 'lab', '预定剧情输入已结束。');
      this.pump(rt); this.maybeFinish(rt);
    }
  }

  /** An explicit controller barrier. A stale watermark cannot advance twice. */
  controlTime(id: string, command: 'pause' | 'resume' | 'step' | 'recover', expectedSeq: number): RunDetail {
    if (this.closed) throw new Error('Lab 已关闭');
    const rt = this.find(id), timeline = rt.timeline;
    if (!timeline) throw new Error('此房间使用历史时钟，需新建启用 time 的房间');
    if (!['pause', 'resume', 'step', 'recover'].includes(command)) throw new Error('未知时间控制动作');
    if (!Number.isSafeInteger(expectedSeq) || expectedSeq !== rt.run.events.at(-1)?.seq) throw new Error('时间控制水位已变化，请重新读取运行');
    if (rt.advancing || rt.finishing) throw new Error('运行仍在推进或封存');
    if (command === 'recover') {
      if (rt.run.status !== 'interrupted' || rt.run.config.target !== 'external' || timeline.state.stopped || timeline.state.pending
        || rt.run.manifest.timeRecovery
        || (rt.run.manifest.evidenceRecovery as { status?: string } | undefined)?.status === 'incomplete') throw new Error('当前运行不具备可核对的时间恢复条件');
      if (rt.run.metrics.elapsedMs >= rt.run.config.maxDurationMs) throw new Error('真实运行预算已用尽');
      if (rt.run.reviews.length) throw new Error('已有独立评分的封存运行不能续写');
      for (const event of rt.run.events.filter(event => event.type === 'tool.call')) {
        const result = rt.run.events.findLast(item => item.type === 'tool.result' && item.data?.operationId === event.data?.operationId);
        if (!result || result.data?.unknown) throw new Error('存在未核对的目标操作，保持中断');
      }
      const resumptions = rt.run.manifest.timeResumptions as unknown[] | undefined;
      rt.run.manifest.timeResumptions = [...(resumptions ?? []), { at: this.wallISO(), expectedSeq,
        priorStatus: rt.run.status, priorError: rt.run.error, priorFinishedAt: rt.run.finishedAt,
        priorFactReport: clone(rt.run.factReport), elapsedMs: rt.run.metrics.elapsedMs }];
      rt.run.status = 'running'; delete rt.run.finishedAt; delete rt.run.factReport;
      rt.start = this.clock.monotonicNow() - rt.run.metrics.elapsedMs;
      rt.finalization = undefined; rt.injectionDone = rt.run.events.some(event => event.type === 'run.inputs_finished');
      timeline.pause(); this.armDeadline(rt);
    } else {
      if (terminalStatuses.has(rt.run.status) || timeline.state.stopped) throw new Error('运行已封存');
      if (command === 'pause') timeline.pause();
      if (command === 'resume') timeline.resume();
      if (command === 'step') {
        if (rt.active.size || rt.workPromises.size || rt.actorTimers.size) throw new Error('引擎仍有在途工作，尚未达到步进屏障');
        timeline.pause();
        const next = timeline.nextTime();
        if (next !== undefined) this.advanceTimeline(rt, next);
      }
    }
    this.emit(rt, 'time.control', 'lab', `故事时间控制 ${command}`, { data: { command, expectedSeq, businessMs: timeline.state.businessMs } });
    this.armTimeline(rt);
    return this.getRun(id);
  }

  private inject(rt: Runtime, input: ScheduledInput, reactive = false): void {
    if ((!reactive && rt.injectionDone) || terminalStatuses.has(rt.run.status) || rt.finishing) return;
    const elapsed = this.clock.monotonicNow() - rt.start;
    const lag = rt.timeline ? Math.max(0, this.businessNow(rt) - input.atMs) / rt.run.config.speed : Math.max(0, elapsed - input.atMs / rt.run.config.speed);
    rt.run.metrics.injectedInputs++;
    rt.run.metrics.maxInjectionLagMs = Math.max(rt.run.metrics.maxInjectionLagMs, lag);
    const task = input.taskId ? rt.run.tasks.find(t => t.id === input.taskId) : undefined;
    if (input.kind === 'request' && task) { task.introduced = true; this.scheduleDeadline(rt, task); }
    const event = this.emit(rt, `input.${input.kind}`, 'world', input.text, {
      actorId: input.actorId, channelId: input.channelId, taskId: input.taskId,
      data: { ...clone(input.data ?? {}), source: reactive ? 'scripted_actor' : 'scenario', inputId: input.id, scheduledAtMs: input.atMs, injectionLagMs: Math.round(lag * 100) / 100 },
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
        task.status = 'failed'; task.detail = '上游任务没有成功完成，依赖无法满足。'; task.finishedAt = this.wallISO();
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

  private hasDelivery(rt: Runtime, task: TaskRecord): boolean {
    // Reuse the real delivery handshake for automatic completion and expiry;
    // a completed status alone cannot turn a budget interruption into success.
    if (rt.run.config.evaluationMode === 'outcome') {
      const submitted = rt.run.events.find(event => event.type === 'task.delivered' && event.role === 'world' && event.taskId === task.id);
      return Boolean(submitted && rt.run.events.some(event => event.type === 'message.delivered' && event.role === 'world' && event.taskId === task.id && event.causeId === submitted.id && event.seq > submitted.seq && event.channelId === task.channelId && event.data?.toActorId === task.ownerId));
    }
    if (!task.deliverables.length || !task.deliverables.every(path => rt.run.artifacts.some(artifact => artifact.taskId === task.id && artifact.path === path))) return false;
    const writes = rt.run.events.filter(event => event.type === 'file.written' && event.role === 'world' && event.taskId === task.id && task.deliverables.includes(String(event.data?.path)));
    const latestWrite = Math.max(0, ...writes.map(event => event.seq));
    return task.deliverables.every(path => writes.some(event => event.data?.path === path))
      && rt.run.events.some(event => event.type === 'message.delivered' && event.role === 'world' && event.taskId === task.id && event.channelId === task.channelId && event.seq > latestWrite && (!event.data?.toActorId || event.data.toActorId === task.ownerId));
  }

  private maybeFinish(rt: Runtime): void {
    if (rt.run.config.keepOpen && !rt.drainRequested) return;
    if (rt.finishing || terminalStatuses.has(rt.run.status) || !rt.injectionDone || rt.active.size || rt.actorTimers.size) return;
    if (rt.timeline && !rt.timeline.state.stopped && rt.timeline.nextTime() !== undefined) return;
    if (rt.run.tasks.some(task => task.introduced && !terminalTasks.has(task.status))) return;
    if (rt.run.config.target === 'external' && rt.run.tasks.some(task => task.introduced && task.status === 'completed' && !this.hasDelivery(rt, task))) return;
    void this.finish(rt, 'completed');
  }

  async controlRun(id: string, command: 'drain' | 'stop'): Promise<RunDetail> {
    const rt = this.find(id);
    if (!['drain', 'stop'].includes(command)) throw new Error('未知控制命令');
    if (terminalStatuses.has(rt.run.status)) return this.getRun(id);
    if (command === 'stop') await this.finish(rt, 'stopped');
    else {
      this.clearInjection(rt); rt.timeline?.stop(); rt.injectionDone = true; rt.drainRequested = true; rt.run.status = 'draining';
      this.emit(rt, 'run.draining', 'lab', '已停止新增输入，继续处理已接纳的工作。');
      this.pump(rt); this.maybeFinish(rt);
    }
    return this.getRun(id);
  }

  private clearInjection(rt: Runtime): void { if (rt.timeTimer) clearTimeout(rt.timeTimer); rt.timeTimer = undefined; for (const timer of rt.timers) clearTimeout(timer); rt.timers.clear(); }

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
    this.refreshMetrics(rt);
    if (rt.timeline) { rt.timeline.pause(); if (status !== 'interrupted') rt.timeline.stop(); }
    rt.run.status = status; rt.run.finishedAt = this.wallISO();
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

  /** A missing observation is not proof of no effect. This never replays an action. */
  messageReceipt(id: string, query: MessageReceiptQuery): MessageReceipt {
    const run = this.find(id).run;
    if (!query || typeof query !== 'object' || Array.isArray(query)
      || Object.keys(query).some(key => !['operationId', 'channelId', 'bodyHash'].includes(key))
      || typeof query.operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(query.operationId)
      || typeof query.channelId !== 'string' || !query.channelId || query.channelId.length > 100 || /[\u0000-\u001f]/.test(query.channelId)
      || typeof query.bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(query.bodyHash)) throw new Error('Invalid message receipt query');
    if ((run.manifest.evidenceRecovery as { status?: string } | undefined)?.status === 'incomplete') throw new Error('Persisted event evidence is incomplete or inconsistent');
    const base = { runId: id, operationId: query.operationId, channelId: query.channelId, bodyHash: query.bodyHash };
    const events = this.store.readPersistedEvents(id, run.events.length)
      .filter(event => event.type === 'message.delivered' && event.data?.operationId === query.operationId);
    // Count by operation before matching the body/channel: one matching duplicate is still ambiguous.
    if (events.length > 1) return { status: 'ambiguous', ...base };
    const event = events[0];
    if (!event || event.data?.source !== 'target' || event.actorId !== 'SHIYU' || event.role !== 'world'
      || event.channelId !== query.channelId || hash(event.text) !== query.bodyHash) return { status: 'not_found', ...base };
    if (event.id !== `${id}:e${event.seq}` || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Persisted message evidence metadata is invalid');
    return { status: 'delivered', ...base, eventId: event.id, observedAt: event.at };
  }

  targetInputs(id: string, after = 0): TargetInput[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('无效输入游标');
    const run = this.find(id).run;
    return clone(run.events.filter(event => (event.type.startsWith('input.') || event.type === 'task.deadline') && event.seq > after).map(event => {
      const record = event.taskId ? run.tasks.find(task => task.id === event.taskId && task.introduced) : undefined;
      const task: TaskSpec | undefined = record ? { id: record.id, subjectId: record.subjectId, title: record.title, ownerId: record.ownerId, channelId: record.channelId, instructions: record.instructions, inputs: [...record.inputs], deliverables: [...record.deliverables], dependencies: [...record.dependencies], workMs: record.workMs, dueAtMs: record.dueAtMs,
        ...(record.evaluationMode ? { evaluationMode: record.evaluationMode, businessRequirements: record.businessRequirements, deliveryPolicy: record.deliveryPolicy } : {}),
      } : undefined;
      return { seq: event.seq, event, evaluationMode: run.config.evaluationMode ?? 'protocol', ...(task ? { task } : {}) };
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
    const canFault = action.type === 'file.write' || action.type === 'service.configure' || action.type === 'task.deliver';
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
      // Submission is already durable even when its reply is lost. Do not leave
      // the final outcome waiting for another, unrelated action to seal the run.
      if (action.type === 'task.deliver') this.maybeFinish(rt);
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
      case 'time.schedule': {
        if (!rt.timeline || rt.drainRequested) throw new Error('此房间当前不接受故事调度');
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(action.scheduleId) || !['reminder', 'check'].includes(action.kind)) throw new Error('目标调度身份或种类无效');
        if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 4000) throw new Error('调度正文无效');
        const offset = (value: string) => {
          return parseStoryInstant(value) - Date.parse(rt.timeline!.state.config.startAt);
        };
        rt.timeline.add({ id: `target:${action.scheduleId}`, revision: action.revision, source: 'target', kind: action.kind,
          nextAtMs: offset(action.dueAt), everyMs: action.everyMs, untilMs: action.until === undefined ? undefined : offset(action.until),
          missed: action.missed ?? 'each', payload: { text: action.text } });
        this.emit(rt, 'time.scheduled', 'lab', '登记目标自己的业务提醒或检查。', { data: { operationId, scheduleId: action.scheduleId, revision: action.revision } });
        this.armTimeline(rt);
        return { ok: true, data: { scheduleId: action.scheduleId, revision: action.revision } };
      }
      case 'time.cancel': {
        if (!rt.timeline || typeof action.scheduleId !== 'string') throw new Error('此房间没有故事调度');
        rt.timeline.cancel(`target:${action.scheduleId}`, action.revision);
        this.emit(rt, 'time.cancelled', 'lab', '已取消目标调度的后续发生项。', { data: { operationId, scheduleId: action.scheduleId, revision: action.revision } });
        this.armTimeline(rt);
        return { ok: true };
      }
      case 'task.deliver': {
        if (run.config.evaluationMode !== 'outcome') throw new Error('task.deliver 仅用于 outcome；protocol 保持原交付协议');
        if (!task || terminalTasks.has(task.status)) throw new Error('任务尚未接纳或已结束，不能重复提交');
        if (!Array.isArray(action.paths) || action.paths.length > 32 || new Set(action.paths).size !== action.paths.length || action.paths.some(path => typeof path !== 'string')) throw new Error('paths 必须为不重复的文件路径数组，最多 32 项');
        if (typeof action.text !== 'string' || action.text.length > 10000) throw new Error('提交正文必须为至多 10000 字符的文本');
        const policy = task.deliveryPolicy;
        if (!policy || action.paths.length < policy.minFiles) throw new Error('此任务要求实际成果文件，不能仅提交正文或完成通知');
        if (!action.paths.length && (!policy.allowText || isAcknowledgementOnly(action.text))) throw new Error('正文交付须包含实际业务成果，不能仅有接单确认或完成自述');
        const artifacts = action.paths.map(path => {
          if (!path.startsWith(`outputs/${task.id}/`)) throw new Error('交付引用必须属于当前任务 outputs/<taskId>/');
          const registered = run.artifacts.filter(artifact => artifact.path === path && artifact.taskId === task.id);
          if (registered.length !== 1) throw new Error(`交付文件尚未注册或不属于当前任务：${path}`);
          const artifact = registered[0];
          const bytes = readFileSync(this.safePath(run.id, path, false));
          if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error(`交付文件为空或超过 4 MiB 验收上限：${path}`);
          const sha256 = hash(bytes);
          const write = run.events.filter(event => event.type === 'file.written' && event.role === 'world' && event.data?.path === path).at(-1);
          if (artifact.bytes !== bytes.length || artifact.sha256 !== sha256 || !write || write.taskId !== task.id || write.data?.sha256 !== sha256 || write.data?.bytes !== bytes.length) throw new Error(`交付文件损坏或与实际写入记录不符：${path}`);
          return { path, bytes: bytes.length, sha256 };
        });
        if (!this.runCompany(run.id).channels.find(channel => channel.id === task.channelId)?.memberIds.includes(task.ownerId)) throw new Error('任务交付对象不在任务会话中');
        const text = [action.text.trim(), ...(action.paths.length ? [`交付产物：${action.paths.join('、')}`] : [])].filter(Boolean).join('\n');
        const data = { operationId, source: 'explicit_submission', toActorId: task.ownerId, paths: [...action.paths], text: action.text, artifacts };
        task.status = 'completed'; task.finishedAt = this.wallISO(); task.detail = '实际成果已显式提交，业务质量等待独立验收与 Judge。';
        const submitted = this.emit(rt, 'task.delivered', 'world', text, { actorId: 'SHIYU', taskId: task.id, channelId: task.channelId, data });
        run.metrics.replies++;
        const delivered = this.emit(rt, 'message.delivered', 'world', text, { actorId: 'SHIYU', taskId: task.id, channelId: task.channelId, causeId: submitted.id, data: { ...data, source: run.config.target === 'reference' ? 'reference' : 'target', attachments: [...action.paths], deliveryEventId: submitted.id } });
        task.delivery = { operationId, eventId: submitted.id, messageEventId: delivered.id, submittedAt: submitted.at, paths: [...action.paths], text: action.text };
        return { ok: true, data: { submitted: true, status: task.status, ...task.delivery, channelId: task.channelId, toActorId: task.ownerId, needsJudge: true } };
      }
      case 'task.update': {
        if (!task || !taskStates.has(action.status)) throw new Error('无效任务状态');
        if (run.config.evaluationMode === 'outcome' && action.status === 'completed') throw new Error('outcome 模式请用 task.deliver 提交实际成果；完成自述不算交付');
        if (terminalTasks.has(task.status) && task.status !== action.status) throw new Error('已结束任务不能用旧操作重新打开');
        task.status = action.status; task.detail = typeof action.detail === 'string' ? action.detail.slice(0, 4000) : undefined;
        if (action.status === 'running') task.startedAt ??= this.wallISO();
        if (terminalTasks.has(action.status)) task.finishedAt ??= this.wallISO();
        this.emit(rt, 'task.updated', 'worker', `${task.title}：${action.status}${task.detail ? ` · ${task.detail}` : ''}`, { taskId: task.id, data: { status: action.status, source: 'target_reported' } });
        return { ok: true, data: { status: task.status } };
      }
      case 'file.read': {
        const available = this.readableFiles(run.id).includes(action.path);
        if (!available) throw new Error('文件不在当前已接纳任务的可读资产中');
        const file = this.safePath(run.id, action.path, false);
        const bytes = readFileSync(file);
        if (bytes.length > 5 * 1024 * 1024) throw new Error('文件超过单次读取上限');
        if (run.config.evaluationMode === 'outcome' || Array.isArray(run.manifest.inputAssets)) {
          const source = (run.manifest.inputAssets as Array<{ path: string; bytes: number; sha256: string }> | undefined)?.find(asset => asset.path === action.path);
          const artifact = run.artifacts.find(artifact => artifact.path === action.path);
          const expected = source ?? artifact;
          if (!expected || expected.bytes !== bytes.length || expected.sha256 !== hash(bytes)) throw new Error('工作文件与独立记录摘要不符');
        }
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
        const channel = this.runCompany(run.id).channels.find(channel => channel.id === action.channelId);
        if (!channel?.memberIds.includes('SHIYU')) throw new Error('SHIYU 不是此会话成员');
        if (typeof action.text !== 'string' || action.text.length > 10000) throw new Error('消息正文无效或过长');
        const attachments = this.attachments(rt, action.attachments, true);
        if (!action.text.trim() && !attachments.length) throw new Error('消息与附件不能同时为空');
        if (action.toActorId && !channel.memberIds.includes(action.toActorId)) throw new Error('接收人不在该会话内');
        run.metrics.replies++;
        const event = this.emit(rt, 'message.delivered', 'world', action.text.trim() || `发送了 ${attachments.length} 份成果。`, { actorId: 'SHIYU', channelId: action.channelId, taskId: action.taskId, data: { operationId, source: run.config.target === 'reference' ? 'reference' : 'target', attachments: attachments.map(asset => asset.path), attachmentAssets: attachments, ...(action.toActorId ? { toActorId: action.toActorId } : {}) } });
        this.actorResponse(rt, action, operationId);
        return { ok: true, data: { delivered: true, channelId: action.channelId, eventId: event.id, attachments: attachments.map(asset => asset.path) } };
      }
      case 'service.inspect': {
        if (run.config.evaluationMode === 'outcome' && (task ? !['inspection', 'maintenance'].includes(task.subjectId) : !run.tasks.some(item => item.introduced && ['inspection', 'maintenance'].includes(item.subjectId)))) throw new Error('服务资产尚未由相关任务引入');
        this.emit(rt, 'service.inspected', 'world', `${run.service.name}：${run.service.healthy ? '健康' : '异常'}`, { taskId: action.taskId, data: { service: clone(run.service), operationId } });
        return { ok: true, data: clone(run.service) };
      }
      case 'service.configure': {
        if (!task || task.subjectId !== 'maintenance') throw new Error('当前任务不包含测试服务维护');
        if (terminalTasks.has(task.status)) throw new Error('已结束任务不可继续修改服务');
        if (!Number.isInteger(action.maxConnections) || action.maxConnections < 1 || action.maxConnections > 1024 || typeof action.maintenance !== 'boolean') throw new Error('无效服务配置');
        if (run.config.evaluationMode === 'outcome') {
          const guide = JSON.parse(readFileSync(this.safePath(run.id, 'inputs/service-guide.json', false), 'utf8')) as { maxAllowedConnections: number };
          if (action.maxConnections > guide.maxAllowedConnections || action.maintenance) throw new Error('超出本任务公开的维护授权范围');
        }
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
        const record = { value: clone(action.value), sourceRefs: [...action.sourceRefs], observedAt: this.wallISO(), source: 'target_reported' };
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
    const channel = this.runCompany(rt.run.id).channels.find(item => item.id === action.channelId);
    const actorId = action.toActorId ?? task.ownerId;
    if (actorId === 'HUMAN' || actorId === 'SHIYU') return;
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
      id: `actor-${operationId}`, atMs: this.businessNow(rt) + 150 * rt.run.config.speed,
      actorId, channelId: action.channelId, kind: 'message', taskId: task.id, text,
      data: { interaction: 'bounded_script', branch: asksAssets ? 'known_assets' : 'delivery_received', respondsTo: operationId },
    };
    rt.run.metrics.scheduledInputs++;
    if (rt.timeline) {
      rt.timeline.add({ id: `actor:${operationId}`, revision: 1, source: 'actor', kind: 'input', nextAtMs: input.atMs, missed: 'each', payload: { input } });
      this.store.saveRun(rt.run); this.armTimeline(rt);
      return;
    }
    const timer = setTimeout(() => {
      rt.actorTimers.delete(timer);
      this.inject(rt, input, true);
      this.maybeFinish(rt);
    }, 150);
    rt.actorTimers.add(timer);
  }

  private safePath(runId: string, relative: string, writing: boolean): string {
    if (typeof relative !== 'string' || relative.length > 512 || isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('无效工作文件路径');
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
    const elapsedMs = Math.max(0, Math.round(this.clock.monotonicNow() - rt.start));
    const businessMs = rt.timeline ? Math.round(rt.timeline.now()) : Math.round(elapsedMs * rt.run.config.speed);
    const seq = (rt.run.events.at(-1)?.seq ?? 0) + 1;
    const event: LabEvent = { id: `${rt.run.id}:e${seq}`, seq, runId: rt.run.id, at: this.wallISO(), elapsedMs, businessMs,
      ...(rt.timeline ? { storyAt: new Date(Date.parse(rt.timeline.state.config.startAt) + businessMs).toISOString() } : {}), type, role, text, ...fields };
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
    if (!rt.run.finishedAt) rt.run.metrics.elapsedMs = Math.max(0, Math.round(this.clock.monotonicNow() - rt.start));
    if (rt.timeline) rt.run.metrics.storySpanMs = Math.round(rt.timeline.now());
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
