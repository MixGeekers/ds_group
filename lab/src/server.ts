import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabEngine } from './engine.ts';
import { catalog } from './catalog.ts';
import { buildEvidencePacket } from './evaluation.ts';
import { callJudge, importReview } from './judge.ts';
import { protocol } from './protocol.ts';
import type { RunConfig, TargetAction } from './types.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const activeStates = new Set(['prepared', 'running', 'draining']);
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const bodyObject = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('请求正文必须是对象');
  return v as Record<string, unknown>;
};
function boundedNumber(v: unknown, fallback: number, min: number, max: number, integer = true) {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw invalid(`数值必须在 ${min}–${max} 范围内`);
  return n;
}
function textField(v: unknown, name: string, max = 2000) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw invalid(`${name} 必须是 1–${max} 字符的文本`);
  return v;
}
export function parseConfig(value: unknown): RunConfig {
  const body = bodyObject(value);
  if (!catalog.scenarios.some(s => s.id === body.scenarioId)) throw new Error('请选择有效场景');
  if (body.target !== undefined && body.target !== 'reference' && body.target !== 'external') throw new Error('无效被测对象');
  if (body.fault !== undefined && !['none', 'tool-once', 'lost-receipt'].includes(String(body.fault))) throw new Error('无效故障设置');
  return {
    scenarioId: String(body.scenarioId), target: body.target as RunConfig['target'] ?? 'reference',
    seed: boundedNumber(body.seed, 42, 0, 2147483647), noiseCount: boundedNumber(body.noiseCount, 60, 0, 1000),
    speed: boundedNumber(body.speed, 10, 1, 100, false), workerConcurrency: boundedNumber(body.workerConcurrency, 2, 1, 8),
    taskDelayMs: boundedNumber(body.taskDelayMs, 800, 0, 30000), fault: body.fault as RunConfig['fault'] ?? 'none',
    maxDurationMs: boundedNumber(body.maxDurationMs, 60000, 1000, 600000)
  };
}
function parseAction(value: unknown): TargetAction {
  const a = bodyObject(value);
  const task = () => textField(a.taskId, 'taskId', 100);
  const optionalTask = () => a.taskId === undefined ? undefined : task();
  switch (a.type) {
    case 'file.read': return { type: a.type, path: textField(a.path, 'path', 500) };
    case 'file.write':
      if (typeof a.content !== 'string' || a.content.length > 6_000_000) throw new Error('文件内容超出限制');
      if (a.encoding !== undefined && a.encoding !== 'utf8' && a.encoding !== 'base64') throw new Error('无效文件编码');
      return { type: a.type, taskId: task(), path: textField(a.path, 'path', 500), content: a.content, encoding: a.encoding };
    case 'task.update':
      if (!['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(String(a.status))) throw new Error('无效任务状态');
      return { type: a.type, taskId: task(), status: a.status as any, detail: a.detail === undefined ? undefined : textField(a.detail, 'detail', 4000) };
    case 'message.send': return { type: a.type, channelId: textField(a.channelId, 'channelId', 100), text: textField(a.text, 'text', 20000), taskId: optionalTask(), toActorId: a.toActorId === undefined ? undefined : textField(a.toActorId, 'toActorId', 100) };
    case 'service.inspect': return { type: a.type, taskId: optionalTask() };
    case 'service.configure':
      if (typeof a.maintenance !== 'boolean') throw new Error('maintenance 必须是布尔值');
      return { type: a.type, taskId: task(), maxConnections: boundedNumber(a.maxConnections, 100, 1, 10000), maintenance: a.maintenance };
    case 'state.record':
      if (!['memory', 'relationship', 'cognition', 'emotion', 'personality', 'capability'].includes(String(a.domain))) throw new Error('无效状态域');
      if (!Array.isArray(a.sourceRefs) || a.sourceRefs.length > 100 || !a.sourceRefs.every(x => typeof x === 'string' && x.length <= 200)) throw new Error('sourceRefs 无效');
      if (a.value === undefined || JSON.stringify(a.value).length > 20000) throw new Error('状态内容缺失或过大');
      return { type: a.type, domain: a.domain as any, key: textField(a.key, 'key', 200), value: a.value, sourceRefs: a.sourceRefs as string[] };
    case 'observe':
      if (!['core', 'worker', 'replyer', 'memory'].includes(String(a.role))) throw new Error('被测 Agent 只能上报自身角色');
      return { type: a.type, role: a.role as any, text: textField(a.text, 'text', 10000), taskId: optionalTask(), data: a.data === undefined ? undefined : bodyObject(a.data) };
    default: throw new Error('未知 action.type');
  }
}
export interface ServerOptions { runtimeDir?: string; logger?: boolean; serveWeb?: boolean; judgeUrl?: string; judgeToken?: string; }
export async function buildApp(options: ServerOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 8_000_000, requestTimeout: 30000 });
  const engine = new LabEngine({ runtimeDir: options.runtimeDir ?? path.join(projectRoot, 'runtime') });
  await engine.init();
  const creations = new Map<string, { digest: string; promise: ReturnType<LabEngine['createRun']> }>();
  const pendingReviews = new Set<string>();
  const judgeUrl = options.judgeUrl ?? process.env.LAB_JUDGE_URL;
  const judgeToken = options.judgeToken ?? process.env.LAB_JUDGE_TOKEN;

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/') || req.url.startsWith('/target/')) reply.header('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let origin: URL;
      try { origin = new URL(req.headers.origin); } catch { return reply.code(403).send({ error: '无效请求来源' }); }
      if (origin.host !== req.headers.host && !(['127.0.0.1:4173', 'localhost:4173'].includes(origin.host) && ['127.0.0.1', 'localhost'].includes(origin.hostname))) return reply.code(403).send({ error: '仅接受本机 Lab 页面发起的操作' });
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const status = (error as any).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: error instanceof Error ? error.message : '请求无效' });
    req.log.error(error);
    return reply.code(500).send({ error: 'Lab 操作失败，请查看服务日志或运行状态' });
  });
  app.addHook('onClose', async () => { await engine.close(); });
  const withRun = (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Object.assign(new Error('运行不存在'), { statusCode: 404 });
    try { return engine.getRun(id); } catch { throw Object.assign(new Error('运行不存在'), { statusCode: 404 }); }
  };
  const badRequest = (error: unknown) => Object.assign(new Error(error instanceof Error ? error.message : String(error)), { statusCode: 400 });
  const auth = (id: string, header?: string) => {
    const run = withRun(id);
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (run.config.target !== 'external' || !engine.authorizeTarget(id, token)) throw Object.assign(new Error('被测运行令牌无效'), { statusCode: 401 });
    return run;
  };
  const cursor = (value: unknown) => {
    if (value === undefined) return 0;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw badRequest('after 必须是非负整数');
    return n;
  };

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));
  app.get('/api/config', async () => ({ version: '0.1.0', judgeConfigured: Boolean(judgeUrl) }));
  app.get('/api/protocol', async () => protocol);
  app.get('/api/catalog', async () => catalog);
  app.get('/api/runs', async () => engine.listRuns());
  app.get<{ Params: { id: string } }>('/api/runs/:id', async req => withRun(req.params.id));
  app.post('/api/runs', async (req, reply) => {
    let config: RunConfig; let key: string;
    try {
      const body = bodyObject(req.body);
      config = parseConfig(body.config);
      key = textField(body.idempotencyKey, 'idempotencyKey', 200);
    } catch (e) { throw badRequest(e); }
    const digest = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const prior = creations.get(key);
    if (prior) {
      if (prior.digest !== digest) return reply.code(409).send({ error: '相同请求标识不能用于不同配置' });
      return prior.promise;
    }
    if (engine.listRuns().filter(r => activeStates.has(r.status)).length >= 4) return reply.code(409).send({ error: '最多同时运行 4 个实验，请先结束已有运行' });
    if (creations.size >= 10000) return reply.code(429).send({ error: '本次服务已达到运行创建上限，请重启后继续' });
    const promise = engine.createRun(config);
    creations.set(key, { digest, promise });
    try { return await promise; } catch (e) { creations.delete(key); throw e; }
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/control', async req => {
    withRun(req.params.id);
    const body = bodyObject(req.body);
    if (body.command !== 'drain' && body.command !== 'stop') throw badRequest('command 应为 drain 或 stop');
    return engine.controlRun(req.params.id, body.command);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/runs/:id/events', async (req, reply) => {
    const run = withRun(req.params.id);
    const after = cursor(req.headers['last-event-id'] ?? req.query.after);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let ended = false;
    const send = (event: typeof run.events[number]) => {
      if (ended || event.seq <= after) return;
      if (reply.raw.writableLength > 1_000_000) { reply.raw.end(); return; }
      reply.raw.write(`id: ${event.seq}\nevent: lab\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // No await between replay and subscription: an event cannot disappear in that gap.
    engine.eventsSince(run.id, after).forEach(send);
    const unsubscribe = engine.subscribe(run.id, send);
    const heartbeat = setInterval(() => { if (!ended) reply.raw.write(': keepalive\n\n'); }, 15000);
    const cleanup = () => { if (ended) return; ended = true; clearInterval(heartbeat); unsubscribe(); };
    reply.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  async function artifactPath(id: string, requested: unknown) {
    const run = withRun(id);
    const ref = textField(requested, 'path', 500);
    const item = run.artifacts.find(a => a.path === ref);
    if (!item) throw Object.assign(new Error('产物不存在'), { statusCode: 404 });
    const workspace = await realpath(path.join(engine.runDir(id), 'workspace'));
    const resolved = await realpath(path.resolve(workspace, ref));
    if (!resolved.startsWith(workspace + path.sep)) throw Object.assign(new Error('产物路径无效'), { statusCode: 403 });
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 20_000_000) throw badRequest('产物超出可读大小');
    return { item, resolved };
  }
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/runs/:id/artifacts', async (req, reply) => {
    const { item, resolved } = await artifactPath(req.params.id, req.query.path);
    const bytes = await readFile(resolved);
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) return reply.code(409).send({ error: '产物内容与封存摘要不一致' });
    return reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`).type(item.mime).send(bytes);
  });
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/runs/:id/preview', async (req, reply) => {
    const { item, resolved } = await artifactPath(req.params.id, req.query.path);
    if (!/\.(json|csv|txt|md|log|html)$/i.test(item.path)) return reply.code(415).send({ error: '此格式请下载后查看' });
    const buffer = await readFile(resolved);
    if (createHash('sha256').update(buffer).digest('hex') !== item.sha256) return reply.code(409).send({ error: '产物摘要不一致' });
    return { path: item.path, content: buffer.toString('utf8').slice(0, 100000), truncated: buffer.length > 100000 };
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/evidence', async req => {
    const run = withRun(req.params.id);
    if (activeStates.has(run.status) || !run.factReport) throw Object.assign(new Error('运行结束并完成事实验收后才能导出评分证据'), { statusCode: 409 });
    return buildEvidencePacket(run, engine.runDir(run.id));
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/reviews', async (req, reply) => {
    const run = withRun(req.params.id);
    if (activeStates.has(run.status) || !run.factReport) return reply.code(409).send({ error: '请等待运行和事实验收结束' });
    if (!judgeUrl) return reply.code(409).send({ error: '未配置评分 Agent。设置 LAB_JUDGE_URL，或导入独立 Agent 的评审 JSON。' });
    if (pendingReviews.has(run.id)) return reply.code(409).send({ error: '该运行已有评分在进行' });
    pendingReviews.add(run.id);
    try {
      const packet = await buildEvidencePacket(run, engine.runDir(run.id));
      const review = await callJudge(packet, { url: judgeUrl, token: judgeToken, timeoutMs: 60000 });
      await engine.saveReview(run.id, review);
      return review;
    } finally { pendingReviews.delete(run.id); }
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/reviews/import', async req => {
    const run = withRun(req.params.id);
    if (activeStates.has(run.status) || !run.factReport) throw Object.assign(new Error('请等待运行和事实验收结束'), { statusCode: 409 });
    const body = bodyObject(req.body);
    const packet = await buildEvidencePacket(run, engine.runDir(run.id));
    const review = importReview(packet, body.review);
    await engine.saveReview(run.id, review);
    return review;
  });

  app.get<{ Params: { id: string } }>('/target/runs/:id', async req => {
    const run = auth(req.params.id, req.headers.authorization);
    return { id: run.id, status: run.status, targetLabel: run.targetLabel, actors: catalog.actors, channels: catalog.channels, tasks: run.tasks.filter(t => t.introduced), protocolVersion: 1 };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/target/runs/:id/inputs', async req => {
    const run = auth(req.params.id, req.headers.authorization);
    return { status: run.status, inputs: engine.targetInputs(run.id, cursor(req.query.after)) };
  });
  app.post<{ Params: { id: string } }>('/target/runs/:id/actions', async req => {
    auth(req.params.id, req.headers.authorization);
    let action: TargetAction; let operationId: string;
    try { const body = bodyObject(req.body); action = parseAction(body.action); operationId = textField(body.operationId, 'operationId', 200); }
    catch (e) { throw badRequest(e); }
    return engine.act(req.params.id, action, operationId);
  });

  const dist = path.join(projectRoot, 'dist');
  if (options.serveWeb !== false && existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/target/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: '接口不存在' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send('<h1>识雨 Lab</h1><p>API 已启动。请运行 npm run build，然后重启；开发界面可运行 npm run web:dev。</p>'));
  }
  return { app, engine };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.LAB_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LAB_PORT 应为 1024–65535 的端口');
  const { app } = await buildApp({ logger: true, runtimeDir: process.env.LAB_RUNTIME_DIR });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  await app.listen({ host: '127.0.0.1', port });
  console.log(`识雨 Lab → http://127.0.0.1:${port}`);
}
