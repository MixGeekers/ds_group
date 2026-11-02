import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readWorkspaceEvidence } from '../dist/gym/core/evaluation.js';
import { catalog } from '../dist/gym/core/catalog.js';

const ended = status => ['completed', 'stopped', 'interrupted', 'failed'].includes(status);
const active = binding => ['starting', 'running'].includes(binding.status);
const attached = connection => connection && ['connected', 'sealed'].includes(connection.status);
const clone = value => structuredClone(value);
const stable = value => Array.isArray(value) ? `[${value.map(stable)}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`)}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const range = (value, fallback, min, max) => { value ??= fallback; if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`参数须为 ${min}–${max} 的整数`); return value; };
const targetActions = new Set(['target_connect', 'target_inputs', 'target_action', 'target_disconnect']);
export const collaborationActions = new Set(['chat', 'send_message', 'publish_task', 'workspace', 'workspace_read', 'workspace_upload', 'scenarios', 'scenario_get', 'scenario_save', 'attach_target', 'connection', ...targetActions]);

export class GymCollaboration {
  constructor(service) { this.service = service; this.pending = new Map(); this.connectionReplies = new Map(); this.attaching = new Set(); this.watchers = new Map(); }
  get engine() { return this.service.engine; }
  initialize() {
    this.service.state.connections ??= {};
    for (const connection of Object.values(this.service.state.connections)) if (attached(connection)) Object.assign(connection, { status: 'disconnected', phase: 'interrupted', disconnectedAt: new Date().toISOString() });
  }
  company(run) { return run.company ?? { actors: catalog.actors, channels: catalog.channels }; }
  liveRun(runId) { const run = this.engine.getRun(runId); if (ended(run.status)) throw new Error('房间已结束，请创建新的房间'); return run; }
  assertCaller(args, caller) {
    if (!caller?.id) return;
    const binding = Object.values(this.service.state.connections).find(item => item.sessionId === caller.id && attached(item));
    if (binding && (!targetActions.has(args.action) || (args.runId && args.runId !== binding.runId))) throw new Error('已接入的被测会话只能使用本房间的目标接口；请先断开后再管理房间');
  }
  participants(runId) {
    const run = this.engine.getRun(runId), company = this.company(run);
    const native = this.service.bindings(runId).findLast(item => item.role === 'target');
    const external = this.service.state.connections[runId];
    const connected = !ended(run.status) && external?.status === 'connected';
    return company.actors.map(actor => {
      if (actor.id === 'HUMAN') return { id: actor.id, name: actor.name, kind: 'human', status: ended(run.status) ? 'read_only' : 'present' };
      if (actor.id !== 'SHIYU') return { id: actor.id, name: actor.name, kind: 'script', status: 'scripted' };
      if (run.config.target === 'reference') return { id: actor.id, name: '参考执行器', kind: 'reference', status: ended(run.status) ? 'completed' : 'running' };
      if (native && active(native)) return { id: actor.id, name: 'DSH 测试 Agent', kind: 'dsh', status: native.status, phase: native.phase ?? 'waiting_input', lastAction: native.lastAction, sessionId: native.sessionId };
      if (connected) return { id: actor.id, name: external.clientName, kind: 'external', status: 'connected', phase: 'connected', lastSeenAt: external.lastSeenAt, sessionId: external.sessionId, identityVerified: false };
      if (ended(run.status) && external?.status === 'sealed') return { id: actor.id, name: external.clientName, kind: 'external', status: 'read_only', phase: 'read_only', lastSeenAt: external.lastSeenAt, sessionId: external.sessionId, identityVerified: false };
      return { id: actor.id, name: native ? 'DSH 测试 Agent' : '识雨', kind: native ? 'dsh' : 'external', status: ended(run.status) ? 'disconnected' : (native?.status ?? 'awaiting_connection'), ...(native?.error ? { error: native.error } : {}) };
    });
  }
  chat(runId, channelId, after = 0, limit = 100) {
    const run = this.engine.getRun(runId), company = this.company(run);
    const channel = company.channels.find(item => item.id === channelId);
    if (!channel) throw new Error('会话不存在');
    after = range(after, 0, 0, Number.MAX_SAFE_INTEGER); limit = range(limit, 100, 1, 200);
    const all = run.events.filter(event => event.seq > after && event.channelId === channelId && (event.type.startsWith('input.') || event.type === 'message.delivered'));
    const selected = all.slice(0, limit), participants = this.participants(runId);
    const messages = selected.map(event => {
      const incoming = event.type.startsWith('input.'), actorId = event.actorId ?? (incoming ? '' : 'SHIYU');
      const actorName = participants.find(actor => actor.id === actorId)?.name ?? company.actors.find(actor => actor.id === actorId)?.name ?? actorId;
      const paths = Array.isArray(event.data?.attachments) ? event.data.attachments : Array.isArray(event.data?.paths) ? event.data.paths : [];
      return { id: event.id, seq: event.seq, at: event.at, actorId, actorName, channelId, text: event.text,
        source: actorId === 'HUMAN' ? 'human' : incoming ? 'script' : run.config.target === 'reference' ? 'reference' : 'target',
        kind: event.type === 'input.request' ? 'request' : typeof event.data?.deliveryEventId === 'string' || event.data?.source === 'explicit_submission' ? 'delivery' : 'message',
        ...(event.taskId ? { taskId: event.taskId, task: run.tasks.find(task => task.id === event.taskId) } : {}),
        attachments: paths.filter(value => typeof value === 'string').map(file => ({ path: file, name: path.basename(file) })),
      };
    });
    return { channel, messages, nextAfter: all.length > selected.length ? selected.at(-1)?.seq ?? after : Math.max(after, run.events.at(-1)?.seq ?? 0), hasMore: all.length > selected.length, canSend: !ended(run.status) && channel.memberIds.includes('HUMAN'), participants };
  }
  workspace(runId) {
    const run = this.engine.getRun(runId), root = path.join(this.engine.runDir(runId), 'workspace');
    if (lstatSync(root).isSymbolicLink()) throw new Error('工作区不能是符号链接');
    const shared = new Set(run.tasks.filter(task => task.introduced).flatMap(task => task.inputs));
    for (const event of run.events) if (event.type.startsWith('input.') && Array.isArray(event.data?.attachments)) for (const file of event.data.attachments) shared.add(file);
    const files = [], warnings = [];
    const visit = (relative, depth) => {
      if (depth > 8 || files.length >= 256) { warnings.push('目录列表达到显示上限'); return; }
      const absolute = path.join(root, relative), info = lstatSync(absolute);
      if (info.isSymbolicLink()) { warnings.push(`已略过符号链接：${relative}`); return; }
      if (info.isDirectory()) {
        for (const child of readdirSync(absolute).sort()) if (!child.startsWith('.')) visit(relative ? `${relative}/${child}` : child, depth + 1);
        return;
      }
      if (!info.isFile()) return;
      const artifact = run.artifacts.find(item => item.path === relative);
      files.push({ path: relative, name: path.basename(relative), kind: relative.startsWith('inputs/') ? 'input' : relative.startsWith('outputs/') ? 'output' : 'service', bytes: info.size, ...(artifact?.taskId ? { taskId: artifact.taskId } : {}), shared: shared.has(relative) || Boolean(artifact), registered: Boolean(artifact) });
    };
    for (const entry of readdirSync(root).sort()) if (['inputs', 'outputs', 'service.json'].includes(entry)) visit(entry, 0);
    return { root, files, warnings, limits: { maxUploadBytes: 1048576, maxFiles: 256 }, readOnly: ended(run.status) };
  }
  async workspaceRead(runId, relative, offset = 0) {
    const { bytes } = await this.workspaceFile(runId, relative);
    return this.service.formatPreview(relative, bytes, offset);
  }
  async workspaceFile(runId, relative) {
    if (!this.workspace(runId).files.some(file => file.path === relative)) throw new Error('文件不在本房间工作区清单中');
    const bytes = await readWorkspaceEvidence(this.engine.runDir(runId), relative);
    return { bytes, name: path.basename(relative) };
  }
  async mutate(action, key, request, operation, secret = false, preflight) {
    if (typeof key !== 'string' || !/^[\w-]{1,100}$/.test(key)) throw new Error('写操作需要稳定的 idempotencyKey');
    const id = `room:${action}:${key}`, hash = digest(stable(request)), previous = this.service.state.requests[id];
    if (previous) {
      if (previous.hash !== hash) throw new Error('同一请求标识不能改变内容');
      if (this.pending.has(id)) return this.pending.get(id);
      if (secret && this.connectionReplies.has(id)) return clone(this.connectionReplies.get(id));
      if (previous.status === 'done' && previous.result) return clone(previous.result);
      if (secret && previous.status === 'done') throw new Error('接入口令没有持久保存；请使用新请求标识重新生成');
      throw new Error(previous.error ?? '先前操作结果未确认，请先核对房间记录');
    }
    // A rejected prerequisite has produced no effect and may be retried with
    // the same identity once corrected. Failures after execution stay durable.
    preflight?.();
    if (Object.keys(this.service.state.requests).length >= 10000) throw new Error('操作账本达到上限，请使用新的运行目录');
    this.service.state.requests[id] = { hash, status: 'pending' }; this.service.persist();
    const promise = (async () => {
      try {
        const result = JSON.parse(JSON.stringify(await operation(`${action}:${key}`)));
        this.service.state.requests[id] = { hash, status: 'done', ...(secret ? {} : { result }) };
        if (secret) this.connectionReplies.set(id, result);
        this.service.persist(); return result;
      } catch (error) {
        this.service.state.requests[id] = { hash, status: 'error', error: String(error.message ?? error).slice(0, 1000) };
        this.service.persist(); throw error;
      } finally { this.pending.delete(id); }
    })();
    this.pending.set(id, promise); return promise;
  }
  result(result) { if (!result.ok) throw new Error(result.error ?? '操作未完成'); return result.data ?? {}; }
  assertConnectionAvailable(runId) {
    const run = this.liveRun(runId);
    if (run.config.target !== 'external') throw new Error('参考自检不能接入外部识雨');
    if (this.service.bindings(runId).some(binding => binding.role === 'target' && active(binding))) throw new Error('请先断开本房间的 DSH 测试 Agent');
    if (this.service.state.connections[runId]?.status === 'connected') throw new Error('请先断开现有外部参与者，再生成新口令');
  }
  connection(runId) {
    this.assertConnectionAvailable(runId);
    const targetToken = this.engine.rotateTargetToken(runId);
    return { runId, targetToken, endpoint: '/api/shiyu-gym/target', instructions: `在需要加入的 DSH 会话中调用 shiyu_gym：\n${JSON.stringify({ action: 'target_connect', runId, targetToken, clientName: '识雨' })}\n接入后用 target_inputs 读取输入，target_action 调用 message.send 发言；target_disconnect 断开。此口令在会话接入后立即失效。外部HTTP客户端还需要DSH本身的认证。` };
  }
  assertTargetAvailable(runId, driver) {
    const run = this.liveRun(runId);
    if (driver !== 'dsh' || run.config.target !== 'external' || run.config.evaluationMode !== 'outcome') throw new Error('只可将 DSH 测试 Agent 接入活动的业务成果房间');
    if (!this.service.capabilities().dshAgent) throw new Error('宿主尚未配置可用模型');
    if (this.attaching.has(runId) || this.service.bindings(runId).some(item => item.role === 'target' && active(item)) || this.service.state.connections[runId]?.status === 'connected') throw new Error('此房间已有目标或正在接入');
  }
  targetConnection(runId, caller) {
    const value = this.service.state.connections[runId];
    if (!caller?.id || !attached(value) || value.sessionId !== caller.id) throw new Error('此会话尚未接入该房间');
    return value;
  }
  watch(runId) {
    if (this.watchers.has(runId)) return;
    const off = this.engine.subscribe(runId, event => {
      if (event.type !== 'run.finished') return;
      const connection = this.service.state.connections[runId];
      // Completion can precede the final tool reply. Retain only this process's
      // original identity so a lost receipt can be queried without replaying work.
      if (connection?.status === 'connected') Object.assign(connection, { status: 'sealed', phase: 'read_only', sealedAt: new Date().toISOString() });
      this.watchers.get(runId)?.(); this.watchers.delete(runId); this.service.persist();
    });
    this.watchers.set(runId, off);
  }
  connect(runId, token, clientName, caller) {
    const run = this.liveRun(runId);
    if (!caller?.id) throw new Error('请从待接入的 DSH Agent 会话调用 target_connect；HTTP客户端使用专用target入口');
    if (run.config.target !== 'external' || !this.engine.authorizeTarget(runId, token)) throw new Error('接入口令无效或已使用');
    if (this.service.bindings(runId).some(binding => binding.role === 'target' && active(binding))) throw new Error('房间已有 DSH 测试 Agent');
    const previous = this.service.state.connections[runId];
    if (previous?.status === 'connected' && previous.sessionId !== caller.id) throw new Error('已有其他目标会话连接');
    if (typeof clientName !== 'string' || !clientName.trim() || clientName.length > 80) throw new Error('参与者名称须为1–80字');
    const now = new Date().toISOString();
    const connection = { runId, sessionId: caller.id, clientName: clientName.trim(), status: 'connected', kind: 'session', connectedAt: now, lastSeenAt: now };
    this.engine.rotateTargetToken(runId);
    this.service.state.connections[runId] = connection; this.watch(runId); this.service.persist();
    return { connection: clone(connection), view: this.service.targetView(runId), nextAction: 'target_inputs', tokenConsumed: true };
  }
  async externalCall(runId, token, request, signal) {
    signal?.throwIfAborted();
    if (this.service.closed) throw new Error('健身房正在关闭');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效目标请求');
    const run = this.engine.getRun(runId);
    if (run.config.target !== 'external' || !this.engine.authorizeTarget(runId, token)) throw new Error('无效运行令牌');
    if (this.service.bindings(runId).some(binding => binding.role === 'target' && active(binding))) throw new Error('房间已有 DSH 测试 Agent');
    const old = this.service.state.connections[runId];
    if (old?.kind === 'session' && attached(old)) throw new Error('房间已由 DSH 目标会话接入');
    if (ended(run.status)) {
      if (old?.kind !== 'http' || old.status !== 'sealed') throw new Error('房间已结束，原接入身份已断开或失效');
      if (request.action === 'disconnect') return this.disconnect(runId);
      return this.connectedCall(runId, request, signal);
    }
    if (request.action === 'disconnect') return this.disconnect(runId);
    const now = new Date().toISOString();
    this.service.state.connections[runId] = { runId, clientName: String(request?.clientName ?? old?.clientName ?? '外部识雨').slice(0, 80), status: 'connected', kind: 'http', connectedAt: old?.connectedAt ?? now, lastSeenAt: now };
    this.watch(runId); this.service.persist();
    if (request?.action === 'connect') return { connection: this.service.state.connections[runId], view: this.service.targetView(runId) };
    return this.connectedCall(runId, request, signal);
  }
  connectedCall(runId, request, signal) {
    if (ended(this.engine.getRun(runId).status) && !['inspect', 'inputs', 'act'].includes(request?.action)) throw new Error('房间已封存，仅可读取状态、输入或查询已有操作回执');
    // LabEngine.act checks the persisted operation identity before its sealed
    // guard: known identical requests return receipts, new effects are rejected.
    return this.service.targetCall(runId, request, signal);
  }
  disconnect(runId, caller) {
    const value = caller?.id ? this.targetConnection(runId, caller) : this.service.state.connections[runId];
    if (value) { value.status = 'disconnected'; value.disconnectedAt = new Date().toISOString(); this.service.persist(); }
    this.watchers.get(runId)?.(); this.watchers.delete(runId);
    const run = this.engine.getRun(runId);
    if (run.config.target === 'external' && !ended(run.status)) this.engine.rotateTargetToken(runId);
    return { disconnected: true };
  }
  async dispatch(args, signal, caller) {
    const runId = args.runId;
    switch (args.action) {
      case 'chat': return this.chat(runId, args.channelId, args.after, args.limit);
      case 'workspace': return this.workspace(runId);
      case 'workspace_read': return this.workspaceRead(runId, args.path, args.offset);
      case 'scenarios': return { items: this.service.library.list() };
      case 'scenario_get': return this.service.library.get(args.scenarioId, 'outcome');
      case 'scenario_save': return this.mutate(args.action, args.idempotencyKey, { scenario: args.scenario, expectedRevision: args.expectedRevision }, () => this.service.library.save({ scenario: args.scenario, expectedRevision: args.expectedRevision }));
      case 'send_message': return this.mutate(args.action, args.idempotencyKey, { runId, channelId: args.channelId, text: args.text, attachments: args.attachments ?? [] }, async operationId => ({ ok: true, ...this.result(await this.engine.postMessage(runId, { channelId: args.channelId, text: args.text, attachments: args.attachments ?? [] }, operationId)) }));
      case 'publish_task': return this.mutate(args.action, args.idempotencyKey, { runId, channelId: args.channelId, title: args.title, text: args.text, paths: args.paths ?? [] }, async operationId => this.result(await this.engine.publishTask(runId, { channelId: args.channelId, title: args.title, instructions: args.text, inputs: args.paths ?? [] }, operationId)));
      case 'workspace_upload': return this.mutate(args.action, args.idempotencyKey, { runId, path: args.path, contentHash: typeof args.content === 'string' ? digest(args.content) : '', encoding: args.encoding }, async operationId => {
        if (typeof args.content !== 'string' || !['utf8', 'base64'].includes(args.encoding)) throw new Error('无效文件内容或编码');
        if (Buffer.from(args.content, args.encoding).length > 1048576) throw new Error('界面上传限1 MiB');
        const file = this.result(await this.engine.addInputFile(runId, { path: args.path, content: args.content, encoding: args.encoding }, operationId)); return { file };
      });
      case 'attach_target': return this.mutate(args.action, args.idempotencyKey, { runId, driver: args.driver }, async () => {
        this.assertTargetAvailable(runId, args.driver);
        this.attaching.add(runId);
        try { return { binding: await this.service.driver.startTarget(runId) }; } finally { this.attaching.delete(runId); }
      }, false, () => this.assertTargetAvailable(runId, args.driver));
      case 'connection': return this.mutate(args.action, args.idempotencyKey, { runId }, () => this.connection(runId), true, () => this.assertConnectionAvailable(runId));
      case 'target_connect': return this.connect(runId, args.targetToken, args.clientName ?? '识雨', caller);
      case 'target_inputs': {
        const value = this.targetConnection(runId, caller); value.lastSeenAt = new Date().toISOString(); this.service.persist();
        return this.connectedCall(runId, { action: 'inputs', after: args.after, waitMs: args.waitMs }, signal);
      }
      case 'target_action': {
        const value = this.targetConnection(runId, caller); value.lastSeenAt = new Date().toISOString(); this.service.persist();
        return this.connectedCall(runId, args.request ?? { action: 'act', operation: args.operation, operationId: args.idempotencyKey }, signal);
      }
      case 'target_disconnect': return this.disconnect(runId, caller);
      default: throw new Error('未知房间操作');
    }
  }
  async close() {
    await Promise.allSettled([...this.pending.values()]);
    for (const value of Object.values(this.service.state.connections)) if (attached(value)) this.disconnect(value.runId);
    for (const off of this.watchers.values()) off();
    this.watchers.clear(); this.connectionReplies.clear();
  }
}
