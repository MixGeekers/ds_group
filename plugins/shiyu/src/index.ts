import { RuntimeService } from './runtime.js';
import type { RuntimeConfig } from './runtime.js';

export const inject = ['connection', 'tools', 'agents', 'agentPresets', 'systemPrompt', 'sessions', 'sessionPersistence', 'sessionProjections', 'workspaceRegistry', 'workingDirectory'];
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const errorResponse = (error: unknown, status = 400) => Response.json({ error: { message: error instanceof Error ? error.message : String(error) } }, { status, headers });

export async function readCommand(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new Error('Expected application/json');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing command body');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.length;
      if (total > 64 * 1024) { await reader.cancel(); throw new Error('Command exceeds 64 KiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function serveState(service: RuntimeService): Promise<Response> {
  try { return Response.json(await service.snapshot(), { headers }); }
  catch (error) { return errorResponse(error, 503); }
}
/**
 * Owner command route. Owner-only commands (including runtime.checkpoint.probe)
 * travel through here from the trusted control surface; they are never exposed
 * as model tools or GET endpoints.
 */
export async function serveCommand(service: RuntimeService, request: Request): Promise<Response> {
  try { return Response.json(await service.command(await readCommand(request), request.signal), { headers }); }
  catch (error) { return errorResponse(error); }
}
/** Read-only status tool definition; exported so its contract can be unit tested without a host. */
export function statusTool(service: { snapshot(): Promise<unknown> }) {
  return {
    name: 'shiyu_status', description: '读取识雨本体当前状态、事件与会话概况；不执行任务或调用模型。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    execute: async () => service.snapshot(),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
/**
 * Zero-model worker-tool diagnosis: creates and immediately releases one
 * restricted worker Session to verify the mounted tool surface, then caches the
 * receipt in status diagnostics. It does not run a task, request a model, send
 * anything, or write business state.
 */
export function coreToolDiagnosisTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_diagnose_core_event_tools',
    description: '零模型诊断：创建并立即释放一个受限 core 决策会话，核验事件工具挂载与无模型活动；不执行 Goal/Task、不发送、不写业务库。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-event-tools' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
/**
 * Owner-triggered bounded real-model probe of the restricted core event tool
 * surface. It runs exactly one synthetic probe turn (fixed prompt, at most one
 * read-only tool round and two main requests), records only provider-reported
 * usage, releases and archives the disposable Session, and returns an honest
 * failed/unknown/cancelled receipt instead of retrying. It never creates a
 * Goal/Task/Effect or writes business state. Only the owner-facing runtime
 * command surface can reach the underlying operation.
 */
export function coreModelToolProbeTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_diagnose_core_model_tools',
    description: '有界真实模型单轮事件工具探针：专用受限 core 会话发送固定不可变提示，要求先调用一次 shiyu_core_event_types 再返回单行 JSON；最多 1 次工具往返、≤2 次主请求，usage 仅按 provider 实际报告（缺失为 unknown），会话释放并归档；不创建 Goal/Task/Effect、不写业务库、不重试。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-model-tools' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
/** Zero-model isolated time-source diagnostic tool (no parameters). */
export function timeSourceDiagnosisTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_diagnose_time_source',
    description: '零模型诊断：在独立 in-memory 控制库中验证时间源触发身份/重复幂等/暂停门控/零副作用，并立即释放；不写 live 业务库、不调模型。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-time-source' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
/** Zero-model read-only checkpoint availability diagnostic tool (no parameters). */
export function checkpointAvailabilityTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_diagnose_checkpoint_availability',
    description: '零模型只读诊断：枚举检查点所需组件与阻断原因（staging/Goal Session 导出/记忆导出/工作区），不 capture、不写文件、不调 resolver、不调模型。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.checkpoint.probe' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
/** Owner-only zero-model LIVE time-trigger diagnosis. It appends exactly one
 * real time.occurred control event that cannot be deleted; the receipt declares it. */
export function timeTriggerDiagnosisTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_diagnose_time_trigger',
    description: '零模型 live 时间触发诊断：向 live 规则文件写入唯一 one-shot 规则并等待 live 时间源 tick，要求 live 控制库恰好出现一个 time.occurred 事件；该事件 append-only 不可删除（回执明确声明副作用），规则条目随后清理；不执行 Task、不发送、不调用模型。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-time-trigger' }),
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
  };
}
export function workerToolDiagnosisTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_diagnose_worker_tools',
    description: '零模型诊断：创建并立即释放一个受限 worker 会话，核验事件工具挂载、工具 schema 无授权字段且无模型活动；不执行任务、不发送、不写业务库。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-event-tools' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
export async function apply(ctx: any, config: RuntimeConfig = {}): Promise<void> {
  const service = new RuntimeService(ctx, config);
  await service.init();
  ctx.effect(() => () => service.close());
  ctx.provide('shiyuRuntime', service);
  for (const [route, methods, handler] of [
    ['/api/shiyu/state', ['GET'], () => serveState(service)],
    ['/api/shiyu/commands', ['POST'], (request: Request) => serveCommand(service, request)],
  ] as const) ctx.effect(() => ctx.connection.fetch.register({ path: route, methods: [...methods], requestBody: 'buffered', fetch: handler }));
  // A read-only tool: refresh/status cannot start inference or create a Session.
  ctx.effect(() => ctx.tools.register(statusTool(service)));
  // Explicit zero-model diagnosis of the restricted worker tool surface; the
  // product never calls a model here and the probe Session is released at once.
  ctx.effect(() => ctx.tools.register(workerToolDiagnosisTool(service)));
  ctx.effect(() => ctx.tools.register(coreToolDiagnosisTool(service)));
  ctx.effect(() => ctx.tools.register(coreModelToolProbeTool(service)));
  ctx.effect(() => ctx.tools.register(timeSourceDiagnosisTool(service)));
  ctx.effect(() => ctx.tools.register(checkpointAvailabilityTool(service)));
  ctx.effect(() => ctx.tools.register(timeTriggerDiagnosisTool(service)));
}
