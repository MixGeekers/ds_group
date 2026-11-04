import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog, freeChatScenario, getScenario, scenarioCompany } from './catalog.ts';
import type { Actor, Channel, EvaluationMode, Scenario, ScenarioAsset, ScheduledInput, TaskSpec } from './types.ts';
import { MAX_STORY_MS } from './time.ts';

const MAX_JSON = 2 * 1024 * 1024;
const safeID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const fixtureDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixturePaths = new Set(readdirSync(fixtureDir).filter(name => name.endsWith('.json')).map(name => `inputs/${name}`));
const builtinIds = new Set([...catalog.scenarios.map(scenario => scenario.id), freeChatScenario.id]);
const subjects = new Set([...catalog.subjects.map(subject => subject.id), 'generic']);
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, label: string): Record<string, unknown> { ensure(value && typeof value === 'object' && !Array.isArray(value), `${label}必须是对象`); return value as Record<string, unknown>; }
function text(value: unknown, label: string, max: number, empty = false): string { ensure(typeof value === 'string' && value.length <= max && (empty || value.trim().length), `${label}为空或超长`); return value; }
function id(value: unknown, label: string): string { const result = text(value, label, 80); ensure(safeID.test(result), `${label}只能包含安全字母数字、短横线和下划线`); return result; }
function number(value: unknown, label: string, min: number, max: number): number { ensure(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `${label}必须为 ${min}–${max} 的有限数字`); return value; }
function array(value: unknown, label: string, max: number): unknown[] { ensure(Array.isArray(value) && value.length <= max, `${label}必须是最多 ${max} 项的数组`); return value; }
function unique(values: string[], label: string): void { ensure(new Set(values).size === values.length, `${label}存在重复标识`); }
function strings(value: unknown, label: string, maxItems: number, maxLength: number): string[] { return array(value, label, maxItems).map(item => text(item, label, maxLength)); }

export function validateInputPath(value: unknown): string {
  const result = text(value, '输入路径', 512);
  ensure(result.startsWith('inputs/') && !path.isAbsolute(result) && !/[\\\u0000-\u001f]/.test(result), '输入路径必须位于 inputs/ 内');
  ensure(result.split('/').every(part => part.length > 0 && part.length <= 160 && !part.startsWith('.')), '输入路径不能包含跳转、隐藏目录或空段');
  return result;
}
export function decodeInputContent(asset: Pick<ScenarioAsset, 'content' | 'encoding'>): Buffer {
  ensure(typeof asset.content === 'string' && asset.content.length <= 8 * 1024 * 1024, '文件内容无效或过大');
  ensure(asset.encoding === undefined || asset.encoding === 'utf8' || asset.encoding === 'base64', '文件编码无效');
  if (asset.encoding === 'base64') ensure(/^[A-Za-z0-9+/]*={0,2}$/.test(asset.content) && asset.content.length % 4 === 0, '文件 Base64 无效');
  const bytes = Buffer.from(asset.content, asset.encoding === 'base64' ? 'base64' : 'utf8');
  ensure(bytes.length <= 4 * 1024 * 1024, '文件超过 4 MiB 上限');
  return bytes;
}

export function validateScenario(input: unknown, mode: EvaluationMode = 'outcome'): Scenario {
  ensure(mode === 'protocol' || mode === 'outcome', '未知验收模式');
  ensure(Buffer.byteLength(JSON.stringify(input) ?? '') <= MAX_JSON, '剧本 JSON 超过 2 MiB');
  const raw = object(input, '剧本');
  const scenarioId = id(raw.id, '剧本 ID');
  const durationMs = number(raw.durationMs, '剧本时长', 1, MAX_STORY_MS);
  // Normalized snapshots also include the two reserved participants. Keep
  // validation idempotent at the authored-role limit when reading saved scripts.
  const actorValues = raw.actors === undefined ? catalog.actors : array(raw.actors, '角色', 66);
  const actors: Actor[] = actorValues.map(value => {
    const actor = object(value, '角色');
    const color = text(actor.color ?? '#627ad9', '角色颜色', 7);
    ensure(/^#[A-Fa-f\d]{6}$/.test(color), '角色颜色必须是六位十六进制色值');
    return { id: id(actor.id, '角色 ID'), name: text(actor.name, '角色名称', 120), department: text(actor.department ?? '自定义角色', '部门', 120), title: text(actor.title ?? '剧本角色', '角色称谓', 120), color };
  });
  unique(actors.map(actor => actor.id), '角色');
  ensure(actors.filter(actor => !['HUMAN', 'SHIYU'].includes(actor.id)).length <= 64, '自定义角色最多64项');
  const actorIds = new Set([...actors.map(actor => actor.id), 'HUMAN', 'SHIYU']);
  const channelValues = raw.channels === undefined ? catalog.channels : array(raw.channels, '会话', 65);
  const channels: Channel[] = channelValues.map(value => {
    const channel = object(value, '会话');
    ensure(['group', 'direct', 'system'].includes(String(channel.kind)), '会话类型无效');
    const members = strings(channel.memberIds, '会话成员', 66, 80); unique(members, '会话成员');
    ensure(members.every(member => actorIds.has(member)), '会话引用了不存在的成员');
    const channelId = id(channel.id, '会话 ID');
    if (channel.kind === 'direct' && channelId !== 'D-SHIYU') ensure(!members.includes('HUMAN') && members.filter(member => member !== 'SHIYU').length === 1, '职员私聊只能包含 SHIYU 与一名职员，HUMAN 仅可观察');
    if (channelId === 'D-SHIYU') ensure(channel.kind === 'direct' && members.every(member => member === 'HUMAN' || member === 'SHIYU'), 'D-SHIYU 只能是 HUMAN 与 SHIYU 的直接会话');
    return { id: channelId, name: text(channel.name, '会话名称', 120), kind: channel.kind as Channel['kind'], memberIds: members };
  });
  unique(channels.map(channel => channel.id), '会话');
  ensure(channels.filter(channel => channel.id !== 'D-SHIYU').length <= 64, '自定义会话最多64项');
  const company = scenarioCompany({ actors, channels });
  const roomById = new Map(company.channels.map(channel => [channel.id, channel]));
  const assets: ScenarioAsset[] = array(raw.assets ?? [], '剧本资料', 32).map(value => {
    const asset = object(value, '剧本资料');
    const file = validateInputPath(asset.path);
    ensure(!fixturePaths.has(file), `剧本资料不能覆盖内置 fixture：${file}`);
    const content = text(asset.content, '资料内容', 8 * 1024 * 1024, true);
    const encoding = asset.encoding === undefined ? 'utf8' : asset.encoding;
    ensure(encoding === 'utf8' || encoding === 'base64', '资料编码无效');
    decodeInputContent({ content, encoding });
    return { path: file, content, encoding };
  });
  unique(assets.map(asset => asset.path), '剧本资料路径');
  const availableInputs = new Set([...fixturePaths, ...assets.map(asset => asset.path)]);
  const tasks: TaskSpec[] = array(raw.tasks ?? [], '剧本任务', 128).map(value => {
    const task = object(value, '剧本任务');
    const taskId = id(task.id, '任务 ID');
    const ownerId = id(task.ownerId ?? 'HUMAN', '任务负责人');
    const channelId = id(task.channelId ?? 'D-SHIYU', '任务会话');
    ensure(ownerId !== 'SHIYU' && actorIds.has(ownerId), '任务负责人无效');
    ensure(roomById.get(channelId)?.memberIds.includes(ownerId), '任务负责人不在指定会话中');
    const subjectId = id(task.subjectId ?? 'generic', '任务科目');
    ensure(subjects.has(subjectId), '未知任务科目；自定义任务应使用 generic');
    const inputs = strings(task.inputs ?? [], '任务输入', 32, 512);
    unique(inputs, '任务输入');
    const dependencies = strings(task.dependencies ?? [], '任务依赖', 32, 80); unique(dependencies, '任务依赖');
    const instructions = text(task.instructions, '任务要求', 12000);
    const deliverables = mode === 'outcome' ? [] : strings(task.deliverables ?? [], '协议交付', 32, 512);
    for (const file of deliverables) ensure(file.startsWith(`outputs/${taskId}/`) && file.split('/').every(part => part && !part.startsWith('.')) && !/[\\\u0000-\u001f]/.test(file), '协议交付路径越界');
    let deliveryPolicy: TaskSpec['deliveryPolicy'];
    if (mode === 'outcome') {
      const policy = object(task.deliveryPolicy ?? { allowText: true, minFiles: subjectId === 'report' ? 1 : 0 }, '交付规则');
      ensure(typeof policy.allowText === 'boolean', '交付规则 allowText 必须为布尔值');
      const minFiles = number(policy.minFiles, '最少文件数', 0, 32); ensure(Number.isInteger(minFiles), '最少文件数必须为整数');
      ensure(policy.allowText || minFiles > 0, '交付规则至少允许正文或要求文件');
      deliveryPolicy = { allowText: policy.allowText, minFiles };
    }
    return { id: taskId, subjectId, title: text(task.title, '任务名称', 200), ownerId, channelId, instructions, inputs, deliverables, dependencies, workMs: number(task.workMs ?? 0, '任务延迟', 0, 600000), dueAtMs: number(task.dueAtMs ?? durationMs, '任务截止时间', 0, MAX_STORY_MS), ...(mode === 'outcome' ? { evaluationMode: 'outcome' as const, businessRequirements: strings(task.businessRequirements ?? [instructions], '业务要求', 32, 12000), deliveryPolicy } : {}) };
  });
  unique(tasks.map(task => task.id), '任务');
  const taskById = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    ensure(task.dependencies.every(dependency => dependency !== task.id && taskById.has(dependency)), '任务依赖引用无效');
    for (const file of task.inputs) {
      if (file.startsWith('inputs/')) { validateInputPath(file); ensure(availableInputs.has(file), `任务引用了不存在的输入：${file}`); }
      else {
        ensure(mode === 'protocol' && task.dependencies.some(dependency => taskById.get(dependency)?.deliverables.includes(file)), '任务输入必须是已知资料或明确依赖的协议成果');
      }
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (taskId: string) => {
    ensure(!visiting.has(taskId), '任务依赖存在循环');
    if (visited.has(taskId)) return;
    visiting.add(taskId); for (const dependency of taskById.get(taskId)!.dependencies) visit(dependency); visiting.delete(taskId); visited.add(taskId);
  };
  tasks.forEach(task => visit(task.id));
  const inputs: ScheduledInput[] = array(raw.inputs ?? [], '剧本事件', 4096).map(value => {
    const event = object(value, '剧本事件');
    ensure(['message', 'request', 'query', 'correction', 'cancel', 'memory'].includes(String(event.kind)), '剧本事件类型无效');
    const actorId = id(event.actorId, '事件角色'), channelId = id(event.channelId, '事件会话');
    ensure(actorId !== 'SHIYU' && actorIds.has(actorId), '剧本不能冒充被测 SHIYU 发言');
    ensure(roomById.get(channelId)?.memberIds.includes(actorId), '事件角色不是该会话成员');
    const taskId = event.taskId === undefined ? undefined : id(event.taskId, '事件任务引用');
    ensure(taskId === undefined || taskById.has(taskId), '事件引用了不存在的任务');
    if (event.kind === 'request') {
      const task = taskId ? taskById.get(taskId) : undefined;
      ensure(task && task.ownerId === actorId && task.channelId === channelId, '任务请求必须匹配任务负责人和会话');
    }
    const data = event.data === undefined ? undefined : structuredClone(object(event.data, '事件数据'));
    if (data?.attachments !== undefined) {
      const files = strings(data.attachments, '事件附件', 32, 512); unique(files, '事件附件');
      ensure(files.every(file => availableInputs.has(validateInputPath(file))), '事件附件引用不存在的资料');
    }
    return { id: id(event.id, '事件 ID'), kind: event.kind as ScheduledInput['kind'], atMs: number(event.atMs, '事件到达时间', 0, durationMs), actorId, channelId, text: text(event.text, '事件正文', 12000), ...(taskId ? { taskId } : {}), ...(data ? { data } : {}) };
  });
  unique(inputs.map(event => event.id), '事件');
  for (const task of tasks) ensure(inputs.filter(event => event.kind === 'request' && event.taskId === task.id).length === 1, `任务 ${task.id} 必须有且仅有一条匹配的 input.request`);
  const scenario: Scenario = { id: scenarioId, name: text(raw.name, '剧本名称', 120), description: text(raw.description ?? '', '剧本说明', 12000, true), durationMs, focus: strings(raw.focus ?? [], '练习重点', 32, 200), tasks, inputs, actors: company.actors, channels: company.channels, ...(assets.length ? { assets } : {}) };
  ensure(Buffer.byteLength(JSON.stringify(scenario)) <= MAX_JSON, '规范化后的剧本 JSON 超过 2 MiB');
  return scenario;
}

export interface ScenarioRecord { scenario: Scenario; revision: number; updatedAt: string | null; builtin: boolean; }
export interface ScenarioSummary { id: string; name: string; description: string; durationMs: number; focus: string[]; revision: number; updatedAt: string | null; builtin: boolean; taskCount: number; eventCount: number; assetCount: number; }

export class ScenarioLibrary {
  readonly directory: string;
  private canonicalRoot?: string;
  constructor(runtimeDir: string) { this.directory = path.resolve(runtimeDir, 'scenarios'); }
  init(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    ensure(!lstatSync(this.directory).isSymbolicLink() && realpathSync(this.directory) === this.directory, '剧本目录不能包含符号链接');
    this.canonicalRoot = realpathSync(this.directory);
  }
  private ready(): void { ensure(this.canonicalRoot && !lstatSync(this.directory).isSymbolicLink() && realpathSync(this.directory) === this.canonicalRoot, '剧本库尚未初始化或目录已改变'); }
  private file(scenarioId: string): string { this.ready(); ensure(/^user-[A-Za-z0-9_-]{1,74}$/.test(scenarioId) && safeID.test(scenarioId), '自定义剧本 ID 无效'); return path.join(this.directory, `${scenarioId}.json`); }
  private read(scenarioId: string): ScenarioRecord {
    const filename = this.file(scenarioId);
    ensure(existsSync(filename), `未知场景：${scenarioId}`);
    const info = lstatSync(filename); ensure(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_JSON + 4096, '剧本文件无效或超过上限');
    const value = object(JSON.parse(readFileSync(filename, 'utf8')), '剧本记录');
    ensure(value.builtin === false && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && typeof value.updatedAt === 'string', '剧本记录元数据无效');
    const scenario = validateScenario(value.scenario, 'outcome'); ensure(scenario.id === scenarioId, '剧本文件身份不符');
    return { scenario, revision: Number(value.revision), updatedAt: value.updatedAt as string, builtin: false };
  }
  get(scenarioId: string, mode: EvaluationMode = 'outcome'): ScenarioRecord {
    this.ready(); ensure(mode === 'protocol' || mode === 'outcome', '未知验收模式');
    if (builtinIds.has(scenarioId)) return { scenario: validateScenario(getScenario(scenarioId, mode), mode), revision: 1, updatedAt: null, builtin: true };
    ensure(mode === 'outcome', '自定义剧本只支持 outcome 业务成果模式');
    return this.read(scenarioId);
  }
  list(mode: EvaluationMode = 'outcome'): ScenarioSummary[] {
    this.ready();
    const records = [...builtinIds].map(scenarioId => this.get(scenarioId, mode));
    if (mode === 'outcome') for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (/^user-[A-Za-z0-9_-]+\.json$/.test(entry.name)) { ensure(entry.isFile() && !entry.isSymbolicLink(), '剧本记录不能是链接或目录'); records.push(this.read(entry.name.slice(0, -5))); }
    }
    return records.map(record => ({ id: record.scenario.id, name: record.scenario.name, description: record.scenario.description, durationMs: record.scenario.durationMs, focus: [...record.scenario.focus], revision: record.revision, updatedAt: record.updatedAt, builtin: record.builtin, taskCount: record.scenario.tasks.length, eventCount: record.scenario.inputs.length, assetCount: record.scenario.assets?.length ?? 0 }));
  }
  save(input: { scenario: unknown; expectedRevision?: number }): ScenarioRecord {
    this.ready();
    ensure(input && typeof input === 'object', '保存请求无效');
    const raw = object(input.scenario, '剧本');
    const incomingId = raw.id === undefined || raw.id === '' ? undefined : id(raw.id, '剧本 ID');
    const updating = Boolean(incomingId?.startsWith('user-') && existsSync(this.file(incomingId)));
    if (!updating && incomingId?.startsWith('user-') && input.expectedRevision !== undefined) throw new Error('要修改的剧本不存在，不能悄悄新建');
    const scenarioId = updating ? incomingId! : `user-${randomUUID()}`;
    const scenario = validateScenario({ ...raw, id: scenarioId }, 'outcome');
    const lock = path.join(this.directory, '.write-lock');
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch (error) { throw new Error('剧本库正在写入或存在未清理的写入锁，请核查后重试', { cause: error }); }
    try {
      const current = updating ? this.read(scenarioId) : undefined;
      if (current) ensure(input.expectedRevision === current.revision, '剧本 revision 冲突，请重新读取后再保存');
      else ensure(input.expectedRevision === undefined || (incomingId !== undefined && builtinIds.has(incomingId) && input.expectedRevision === 1), '新剧本不能指定已有 revision');
      const record: ScenarioRecord = { scenario, revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), builtin: false };
      const filename = this.file(scenarioId);
      if (existsSync(filename)) ensure(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink(), '剧本记录不是普通文件');
      const temporary = path.join(this.directory, `.save-${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); renameSync(temporary, filename);
      return structuredClone(record);
    } finally { closeSync(fd); unlinkSync(lock); }
  }
}
