import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, unlinkSync, realpathSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph } from 'docx';
import { LabEngine } from '../dist/gym/core/engine.js';
import { ScenarioLibrary } from '../dist/gym/core/scenarios.js';
import { GymCollaboration, collaborationActions } from './collaboration.js';
import { buildEvidencePacket, readEvidenceFile } from '../dist/gym/core/evaluation.js';
import { importReview } from '../dist/gym/core/judge.js';
import { catalog, outcomeCatalog } from '../dist/gym/core/catalog.js';
import { protocol } from '../dist/gym/core/protocol.js';
import { GymAgentDriver } from './agent-driver.js';
import { GymSettings } from './settings.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const terminal = status => ['completed', 'stopped', 'interrupted', 'failed'].includes(status);
const activeBinding = b => ['starting', 'running'].includes(b.status);
const clone = value => structuredClone(value);
const stable = value => Array.isArray(value) ? `[${value.map(stable)}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`)}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function integer(value, fallback, min, max) { value ??= fallback; if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`整数参数须为 ${min}–${max}`); return value; }
function ensurePlainFile(file) { if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error('拒绝非普通状态文件'); }
function atomicJSON(file, value) { ensurePlainFile(file); const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }

export class GymService {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.runtimeDir = path.resolve(root, config.runtimeDir ?? 'runtime/gym');
    if (!this.runtimeDir.startsWith(path.join(root, 'runtime') + path.sep)) throw new Error('健身房运行目录必须在 lab/runtime/ 内');
    this.library = new ScenarioLibrary(this.runtimeDir);
    this.engine = new LabEngine({ runtimeDir: this.runtimeDir, scenarioResolver: (id, mode) => this.library.get(id, mode).scenario });
    this.collaboration = new GymCollaboration(this);
    this.settings = new GymSettings(this);
    this.driver = new GymAgentDriver(ctx, this, {
      maxTargetSteps: integer(config.maxTargetSteps, 80, 1, 200),
      maxJudgeSteps: integer(config.maxJudgeSteps, 24, 1, 80),
      judgeTimeoutMs: integer(config.judgeTimeoutMs, 180000, 1000, 600000),
    });
    this.state = { version: 1, bindings: [], requests: {} };
    this.pending = new Map(); this.office = new Map(); this.judgeStarts = new Set(); this.closed = false;
  }
  async init() {
    mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    if (realpathSync(this.runtimeDir) !== this.runtimeDir) throw new Error('运行目录不能通过符号链接指向其他位置');
    this.lockPath = path.join(this.runtimeDir, '.gym-lock.json');
    if (existsSync(this.lockPath)) {
      ensurePlainFile(this.lockPath);
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('锁文件损坏，需要人工核查');
      let alive = true;
      try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('此健身房数据目录已由另一个活动实例持有');
      // Only the exact owned lock beneath the verified canonical run root is removed.
      unlinkSync(this.lockPath);
    }
    this.instanceId = randomUUID();
    const fd = openSync(this.lockPath, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, instanceId: this.instanceId })); } finally { closeSync(fd); }
    this.stateFile = path.join(this.runtimeDir, 'gym-state.json');
    try {
      ensurePlainFile(this.stateFile);
      if (existsSync(this.stateFile)) {
        const value = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        if (value.version !== 1 || !Array.isArray(value.bindings) || !object(value.requests)) throw new Error('健身房状态格式无效');
        this.state = value;
      }
      for (const binding of this.state.bindings.filter(activeBinding)) Object.assign(binding, { status: 'interrupted', finishedAt: new Date().toISOString(), error: '宿主退出，未自动恢复模型调用或重放业务效果。' });
      this.library.init(); this.settings.initialize(); this.collaboration.initialize();
      await this.engine.init(); this.persist();
    } catch (error) { await this.engine.close(); this.releaseLock(); throw error; }
  }
  persist() { if (this.stateFile) atomicJSON(this.stateFile, this.state); }
  releaseLock() {
    if (!this.lockPath || !existsSync(this.lockPath)) return;
    ensurePlainFile(this.lockPath);
    if (JSON.parse(readFileSync(this.lockPath, 'utf8')).instanceId === this.instanceId) unlinkSync(this.lockPath);
  }
  bindings(runId) { return this.state.bindings.filter(b => !runId || b.runId === runId).map(clone); }
  updateBinding(binding, values) { Object.assign(binding, values); this.persist(); }
  model(role = 'target') { return this.settings.selection(role); }
  resolveModel(role = 'target', signal) { return this.settings.resolve(role, signal); }
  capabilities() { const agents = Boolean(this.ctx.get('agents')); return { dshAgent: agents && this.settings.available('target'), judge: agents && this.settings.available('judge'), model: this.model('target') ?? null, judgeModel: this.model('judge') ?? null, noAutomaticModelCalls: true, isolation: 'tool-scoped; not an operating-system sandbox' }; }
  snapshot() {
    const runs = this.engine.listRuns();
    const scenarios = this.library.list();
    return { version: '0.3.0', runtimeDir: this.runtimeDir, catalog: { ...catalog, scenarios }, outcomeCatalog: { ...outcomeCatalog, scenarios }, scenarios, runs: runs.slice(0, 100), totalRuns: runs.length, truncated: runs.length > 100, capabilities: this.capabilities(), bindings: this.bindings().slice(-100), limitations: ['DSH 测试 Agent 不是已经实现的识雨内核。', '工具隔离不等于操作系统盲测。'] };
  }
  get(runId, after = 0, limit = 50) {
    const run = this.engine.getRun(runId);
    after = integer(after, 0, 0, Number.MAX_SAFE_INTEGER); limit = integer(limit, 50, 1, 200);
    const pending = run.events.filter(e => e.seq > after); const events = pending.slice(0, limit);
    const binding = this.bindings(runId).findLast(b => b.role === 'target');
    return { run: { ...run, company: this.collaboration.company(run), events: run.events.slice(-100) }, eventPage: { events, nextAfter: events.at(-1)?.seq ?? after, hasMore: pending.length > events.length }, participants: this.collaboration.participants(runId), ...(binding ? { binding } : {}) };
  }
  async once(action, key, request, fn, preflight) {
    if (typeof key !== 'string' || !/^[\w-]{1,100}$/.test(key)) throw new Error('create/judge 需要有效的 idempotencyKey');
    const id = `${action}:${key}`, digest = hash(stable(request));
    const old = this.state.requests[id];
    if (old) {
      if (old.hash !== digest) throw new Error('同一请求标识不能用于不同参数');
      if (this.pending.has(id)) return this.pending.get(id);
      if (old.status === 'done') {
        if (action === 'create') return { ...this.get(old.runId), replayed: true, tokenNotice: '令牌不持久保存；首次响应丢失时请停止此运行并新建。' };
        return { binding: this.bindings(old.runId).find(b => b.sessionId === old.sessionId), replayed: true };
      }
      throw new Error(old.error ?? '先前请求结果未知，未重复执行；请核查已有运行');
    }
    if (Object.keys(this.state.requests).length >= 10000) throw new Error('请求账本达到原型上限，请封存运行目录后配置新的目录');
    // A rejected prerequisite has not started an operation. Let the same button
    // retry after configuration changes, while retaining receipts once work begins.
    preflight?.();
    this.state.requests[id] = { hash: digest, status: 'pending' }; this.persist();
    const promise = (async () => {
      try {
        const value = await fn();
        this.state.requests[id] = { hash: digest, status: 'done', runId: value.run?.id ?? request.runId, ...(value.binding ? { sessionId: value.binding.sessionId } : {}) }; this.persist();
        return value;
      } catch (error) { this.state.requests[id] = { hash: digest, status: 'error', error: String(error.message ?? error).slice(0, 1000) }; this.persist(); throw error; }
      finally { this.pending.delete(id); }
    })();
    this.pending.set(id, promise); return promise;
  }
  async dispatch(args, signal, caller) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('健身房正在关闭');
    if (!object(args)) throw new Error('请求必须是对象');
    this.collaboration.assertCaller(args, caller);
    if (collaborationActions.has(args.action)) return this.collaboration.dispatch(args, signal, caller);
    switch (args.action) {
      case 'snapshot': return this.snapshot();
      case 'settings_get': return this.settings.snapshot();
      case 'settings_save': return this.settings.save(args, signal);
      case 'get': return this.get(args.runId, args.after, args.limit);
      case 'create': return this.once('create', args.idempotencyKey, { driver: args.driver ?? 'reference', config: args.config ?? {} }, async () => {
        const driver = args.driver ?? 'reference';
        if (!['reference', 'dsh', 'external'].includes(driver)) throw new Error('未知执行对象');
        if (args.config !== undefined && !object(args.config)) throw new Error('config 必须是对象');
        const allowed = ['scenarioId', 'evaluationMode', 'seed', 'noiseCount', 'speed', 'workerConcurrency', 'taskDelayMs', 'fault', 'maxDurationMs', 'keepOpen'];
        if (Object.keys(args.config ?? {}).some(k => !allowed.includes(k))) throw new Error('config 包含不支持的参数');
        const config = { ...(driver === 'dsh' ? { speed: 1, maxDurationMs: 300000, noiseCount: 20, evaluationMode: 'outcome' } : {}), ...args.config, target: driver === 'reference' ? 'reference' : 'external' };
        if (driver === 'dsh' && config.evaluationMode !== 'outcome') throw new Error('DSH 训练使用业务成果模式；协议自检请选择参考执行器');
        const created = await this.engine.createRun(config);
        let binding;
        try { if (driver === 'dsh') binding = await this.driver.startTarget(created.run.id); }
        catch (error) { await this.engine.controlRun(created.run.id, 'stop'); throw error; }
        return { run: this.get(created.run.id).run, ...(binding ? { binding } : {}), ...(driver === 'external' ? { targetToken: created.targetToken, endpoint: '/api/shiyu-gym/target', connectionNote: '需 DSH 已认证连接；正文携带 targetToken。' } : {}) };
      }, () => { if (args.driver === 'dsh' && !this.capabilities().dshAgent) throw new Error('宿主尚未配置可用模型'); });
      case 'control': {
        if (!['drain', 'stop'].includes(args.command)) throw new Error('未知控制动作');
        if (args.command === 'stop') { await this.driver.cancel(args.runId, 'target'); this.collaboration.disconnect(args.runId); }
        await this.engine.controlRun(args.runId, args.command); return { run: this.get(args.runId).run };
      }
      case 'judge': return this.once('judge', args.idempotencyKey, { runId: args.runId }, async () => {
        this.judgeStarts.add(args.runId);
        try { await this.packet(args.runId); return { binding: await this.driver.startJudge(args.runId) }; }
        finally { this.judgeStarts.delete(args.runId); }
      }, () => {
        if (!this.capabilities().judge) throw new Error('宿主尚未配置可用模型');
        if (this.judgeStarts.has(args.runId) || this.bindings(args.runId).some(b => b.role === 'judge' && activeBinding(b))) throw new Error('此实验已有正在运行的评分');
        const run = this.engine.getRun(args.runId);
        if (!terminal(run.status) || !run.factReport) throw new Error('运行尚未完成封存与独立验收');
      });
      case 'cancel_agent': {
        if (!['target', 'judge'].includes(args.role)) throw new Error('未知角色');
        await this.driver.cancel(args.runId, args.role);
        if (args.role === 'target') {
          this.collaboration.disconnect(args.runId);
        }
        return { bindings: this.bindings(args.runId), participants: this.collaboration.participants(args.runId) };
      }
      case 'preview': return this.preview(args.runId, args.path, 0, false);
      case 'evidence': { const packet = await this.packet(args.runId); return { runId: args.runId, facts: packet.facts, tasks: packet.tasks, files: packet.fileIndex ?? packet.artifacts, instructions: packet.instructions, downloadPath: `api/shiyu-gym/evidence?runId=${encodeURIComponent(args.runId)}` }; }
      case 'import_review': { const review = importReview(await this.packet(args.runId), args.review); await this.engine.saveReview(args.runId, review); return { review }; }
      case 'probe_host': return this.driver.probe();
      default: throw new Error('未知健身房操作');
    }
  }
  async packet(runId) {
    const run = this.engine.getRun(runId);
    if (!terminal(run.status) || !run.factReport) throw new Error('运行尚未完成封存与独立验收');
    return buildEvidencePacket(run, this.engine.runDir(runId));
  }
  targetView(runId) {
    const run = this.engine.getRun(runId);
    const company = this.collaboration.company(run);
    const shared = run.events.filter(event => event.type.startsWith('input.') && Array.isArray(event.data?.attachments)).flatMap(event => event.data.attachments);
    return { runId, status: run.status, self: { actorId: 'SHIYU' }, evaluationMode: run.config.evaluationMode ?? 'protocol', actors: company.actors, channels: company.channels, tasks: run.tasks.filter(t => t.introduced), readableFiles: [...new Set([...run.tasks.filter(t => t.introduced).flatMap(t => t.inputs), ...run.artifacts.map(a => a.path), ...shared])], protocol: { actions: protocol.actions }, instructions: '通过 message.send 在原会话中实际发言，附件引用已登记成果；普通最终回复不会自动投递到模拟聊天室。' };
  }
  async targetCall(runId, args, signal) {
    signal?.throwIfAborted();
    if (!object(args)) throw new Error('无效目标请求');
    if (args.action === 'inspect') return this.targetView(runId);
    if (args.action === 'preview') return this.preview(runId, args.path, args.offset, true);
    if (args.action === 'inputs') {
      const after = integer(args.after, 0, 0, Number.MAX_SAFE_INTEGER), wait = integer(args.waitMs, 0, 0, 20000);
      if (wait && !this.engine.targetInputs(runId, after).length && !terminal(this.engine.getRun(runId).status)) {
        await new Promise((resolve, reject) => {
          let off = () => {}; const finish = () => { clearTimeout(timer); off(); signal?.removeEventListener('abort', aborted); resolve(); };
          const aborted = () => { finish(); reject(signal.reason ?? new Error('已取消')); };
          const timer = setTimeout(finish, wait);
          off = this.engine.subscribe(runId, event => { if (event.type.startsWith('input.') || event.type === 'run.finished') finish(); });
          signal?.addEventListener('abort', aborted, { once: true });
          if (signal?.aborted) aborted();
        });
      }
      signal?.throwIfAborted();
      const all = this.engine.targetInputs(runId, after), inputs = all.slice(0, 30);
      return { status: this.engine.getRun(runId).status, inputs, nextAfter: inputs.at(-1)?.seq ?? after, hasMore: all.length > inputs.length };
    }
    if (typeof args.operationId !== 'string' || !/^[\w.:-]{1,160}$/.test(args.operationId)) throw new Error('业务动作需要稳定的 operationId');
    if (args.action === 'act') {
      const offset = args.operation?.type === 'file.read' ? integer(args.operation.offset, 0, 0, 8000000) : 0;
      const result = await this.engine.act(runId, args.operation, args.operationId);
      if (result.ok && args.operation?.type === 'file.read' && typeof result.data?.content === 'string') {
        const { content, ...meta } = result.data;
        if (meta.encoding === 'base64') return { ...result, data: { ...meta, contentOmitted: true, reason: '二进制内容未塞入模型上下文；使用 preview 查看支持格式的实际内容。' } };
        return { ...result, data: { ...meta, content: content.slice(offset, offset + 24000), offset, nextOffset: Math.min(offset + 24000, content.length), totalCharacters: content.length, truncated: offset + 24000 < content.length } };
      }
      return result;
    }
    if (!['write_spreadsheet', 'write_document'].includes(args.action)) throw new Error('未知目标操作');
    if (terminal(this.engine.getRun(runId).status)) throw new Error('实验已封存');
    if (Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024) throw new Error('Office 输入超过 1 MiB');
    const key = `${runId}:${args.operationId}`, digest = hash(stable(args));
    const old = this.office.get(key);
    if (old && old.hash !== digest) throw new Error('同一 operationId 的内容不可改变');
    if (!old) {
      if (this.office.size >= 256) throw new Error('Office 生成操作达到原型上限');
      const entry = { hash: digest };
      this.office.set(key, entry);
      entry.ready = (async () => {
      let bytes;
      if (args.action === 'write_spreadsheet') {
        if (!String(args.path).endsWith('.xlsx') || !Array.isArray(args.rows) || !args.rows.length || args.rows.length > 1000 || args.rows.some(row => !Array.isArray(row) || row.length > 50 || row.some(c => c !== null && !['string', 'number', 'boolean'].includes(typeof c)))) throw new Error('无效表格数据');
        const workbook = new ExcelJS.Workbook(); workbook.creator = 'Shiyu Gym target'; workbook.created = new Date(0); workbook.modified = new Date(0);
        const sheet = workbook.addWorksheet('成果'); sheet.addRows(args.rows); sheet.getRow(1).font = { bold: true }; sheet.columns.forEach(c => { c.width = 22; });
        bytes = Buffer.from(await workbook.xlsx.writeBuffer());
      } else {
        if (!String(args.path).endsWith('.docx') || !Array.isArray(args.paragraphs) || !args.paragraphs.length || args.paragraphs.length > 200 || args.paragraphs.some(p => typeof p !== 'string')) throw new Error('无效文档段落');
        bytes = await Packer.toBuffer(new Document({ creator: 'Shiyu Gym target', sections: [{ children: args.paragraphs.map(p => new Paragraph(p)) }] }));
      }
      entry.operation = { type: 'file.write', taskId: args.taskId, path: args.path, encoding: 'base64', content: bytes.toString('base64') };
      })();
    }
    await this.office.get(key).ready;
    return this.engine.act(runId, this.office.get(key).operation, args.operationId);
  }
  async artifact(runId, relative, allowInputs = false) {
    const run = this.engine.getRun(runId);
    if (!allowInputs && !run.artifacts.some(a => a.path === relative)) throw new Error('不是本实验登记的成果');
    const bytes = await readEvidenceFile(run, this.engine.runDir(runId), relative);
    return { bytes, name: path.basename(relative) };
  }
  async preview(runId, relative, offset = 0, allowInputs = false) {
    const { bytes } = await this.artifact(runId, relative, allowInputs);
    return this.formatPreview(relative, bytes, offset);
  }
  async formatPreview(relative, bytes, offset = 0) {
    offset = integer(offset, 0, 0, 4000000);
    let content, binary = false;
    if (/\.(json|csv|md|txt|log)$/i.test(relative)) content = bytes.toString('utf8');
    else if (/\.xlsx$/i.test(relative)) {
      boundedOffice(bytes);
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
      const sheets = [];
      workbook.eachSheet(sheet => {
        const rows = []; sheet.eachRow((row, i) => { if (i <= 1000) rows.push({ row: i, values: row.values.slice(1, 51) }); });
        sheets.push({ name: sheet.name, rows, omittedRows: Math.max(0, sheet.rowCount - 1000) });
      });
      content = JSON.stringify({ sheets }, null, 2);
    } else if (/\.docx$/i.test(relative)) {
      const entries = boundedOffice(bytes);
      const xml = entries.get('word/document.xml');
      if (!xml) throw new Error('DOCX 缺少正文');
      content = xml.toString('utf8').replace(/<\/w:p>/g, '\n').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    } else { binary = true; content = `未支持内容解析：${relative}，${bytes.length} bytes。只能验证文件完整性，不能据此评价内容质量。`; }
    return { path: relative, content: content.slice(offset, offset + 24000), offset, nextOffset: Math.min(offset + 24000, content.length), totalCharacters: content.length, truncated: offset + 24000 < content.length, binary, sha256: hash(bytes) };
  }
  async close() {
    if (this.closed) return; this.closed = true;
    try { await this.driver.close(); await this.settings.close(); await this.collaboration.close(); await Promise.allSettled([...this.pending.values()]); await this.engine.close(); this.persist(); }
    finally { this.releaseLock(); }
  }
}

// Bound decompression before any Office parser; no archive extraction or HTML rendering.
export function boundedOffice(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Office ZIP 目录无效');
  const count = buffer.readUInt16LE(end + 10); let at = buffer.readUInt32LE(end + 16), total = 0;
  if (!count || count > 300) throw new Error('Office 条目数量超限');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('Office 目录损坏');
    const flags = buffer.readUInt16LE(at + 8), method = buffer.readUInt16LE(at + 10), compressed = buffer.readUInt32LE(at + 20), size = buffer.readUInt32LE(at + 24);
    const nl = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nl).toString('utf8'); total += size;
    if (flags & 1 || ![0, 8].includes(method) || size > 4 * 1024 * 1024 || total > 12 * 1024 * 1024 || offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('Office 压缩格式或展开大小不支持');
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    if (start + compressed > buffer.length || entries.has(name)) throw new Error('Office 条目截断或重复');
    const raw = buffer.subarray(start, start + compressed), data = method === 8 ? inflateRawSync(raw, { maxOutputLength: 4 * 1024 * 1024 }) : raw;
    if (data.length !== size) throw new Error('Office 条目大小不符');
    entries.set(name, data); at += 46 + nl + extra + comment;
  }
  return entries;
}
