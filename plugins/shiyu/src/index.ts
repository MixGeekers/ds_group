import { RuntimeService } from './runtime.js';
import { innerLifecycleDiagnosisTool } from './control/inner-lifecycle-probe.js';
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
/**
 * Owner-triggered bounded REAL core business-chain validation tool.
 *
 * WARNING — this is NOT a read-only probe. One invocation creates a real core
 * Goal, a real Task/Effect/budget reservation, a dedicated native core Session
 * and a local artifact, and it issues up to two real model rounds through the
 * trusted core path (worker execution and independent verification included).
 * It requires an idle, unpaused runtime, is single-flight, applies hard
 * 180s / 2-evaluation / frozen-budget stops, never retries a failed or unknown
 * round, and returns an honest bounded receipt. Only the owner command surface
 * can reach it; restricted core/worker/replyer Sessions never receive it.
 */
export function coreGoalValidationV2Tool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_validate_core_goal_v2',
    description: '有界真实 core Goal 验证（v2 新冻结实验，非 v1 重试）：会创建真实 Goal/Task/Effect/budget/原生 Session/本地 artifact，并通过 core 路径发起最多 2 轮真实模型调用（含 worker 执行与独立核验）；使用全新 requestId core-validation-frozen-v2 与固定模板，不接受任何输入/参数覆盖；要求运行时未暂停且空闲，单飞、180 秒/2 次评估/冻结预算硬停止、失败或未知绝不重试；回执仅存 snapshot().diagnostics.coreGoalValidation。v1 已失败并已 reconcile，本工具不是对 v1 的 replay。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-goal-v2' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  } as const;
}

/**
 * Owner-only bounded REAL core business-chain validation for the frozen v3
 * experiment. This is explicitly the third independent attempt after the failed
 * v1/v2 creates (which stay failed, reconciled and never retried): one call
 * creates a real core Goal/Task/Effect/budget/native Session/local artifact and
 * issues up to two real bounded model rounds through the normal core path. It
 * requires an idle, unpaused runtime, is single-flight, applies the existing
 * 180s/2-evaluation/frozen-budget stops, never retries a failed or unknown
 * round, and caches only the honest bounded receipt in snapshot diagnostics.
 */
export function coreGoalValidationV3Tool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_validate_core_goal_v3',
    description: '有界真实 core Goal 验证（v3 全新冻结实验，非 v1/v2 重试；显式 owner 决定的第三次独立尝试）：会创建真实 Goal/Task/Effect/budget/原生 Session/本地 artifact，并通过 core 路径发起最多 2 轮真实模型调用（含 worker 执行与独立核验）；使用全新 requestId core-validation-frozen-v3 与固定模板，不接受任何输入/参数覆盖；v1/v2 已失败并已验证 reconcile（均 cancelled version2），本工具不会重放它们；要求运行时未暂停且空闲，单飞、180 秒/2 次评估/冻结预算硬停止、失败或未知绝不重试；回执仅存 snapshot().diagnostics.coreGoalValidation。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-goal-v3' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  } as const;
}

/**
 * Owner-only ZERO-MODEL diagnostic of the native Session header cut. It creates
 * exactly one bare lifecycle Session (managed core Goal preset/cwd/meta), runs
 * the same flush -> cold observe -> live assertion cut comparison and always
 * cancels/disposes/archives that Session. It creates no Goal/Task/Effect/budget,
 * writes no business store entry and calls no model or embedding; it retries
 * nothing and keeps only the bounded receipt in diagnostics.nativeHeaderCutProbe.
 */
export function nativeHeaderCutProbeTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_diagnose_native_header_cut',
    description: '零模型原生 Session header-cut 诊断（owner-only）：只创建并归档一个裸 lifecycle Session（与 Goal 会话同 preset/cwd/meta；无事件工具、拒绝模型请求、无 inbox），运行 flush→cold observe→live assert 的切割比较并输出 cold/live headerHash 前缀、eventCount/seq/inherited、matched 与字段级 headerDiff（仅字段名+值类别/hash 前缀，≤300 字符，绝无正文/路径）；不创建 Goal/Task/Effect/budget、不写业务库、不调用模型或 embedding、0 重试；回执仅存 snapshot().diagnostics.nativeHeaderCutProbe。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-native-header-cut' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  } as const;
}

/**
 * Owner-only bounded REAL core business-chain validation for the frozen v4
 * experiment. This is explicitly the fourth independent attempt after the
 * failed v1/v2/v3 creates (which stay failed, reconciled and never retried):
 * one call creates a real core Goal/Task/Effect/budget/native Session/local
 * artifact and issues up to two real bounded model rounds through the normal
 * core path. It requires an idle, unpaused runtime, is single-flight, applies
 * the existing 180s/2-evaluation/frozen-budget stops, never retries a failed or
 * unknown round, and caches only the honest bounded receipt in snapshot
 * diagnostics.
 */
export function coreGoalValidationV4Tool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_validate_core_goal_v4',
    description: '有界真实 core Goal 验证（v4 全新冻结实验，非 v1/v2/v3 重试；显式 owner 决定的第四次独立尝试）：会创建真实 Goal/Task/Effect/budget/原生 Session/本地 artifact，并通过 core 路径发起最多 2 轮真实模型调用（含 worker 执行与独立核验）；使用全新 requestId core-validation-frozen-v4 与固定模板，不接受任何输入/参数覆盖；v1/v2/v3 已失败并已验证 reconcile（均保持不重试），本工具不会重放它们；要求运行时未暂停且空闲，单飞、180 秒/2 次评估/冻结预算硬停止、失败或未知绝不重试；回执仅存 snapshot().diagnostics.coreGoalValidation。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-goal-v4' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  } as const;
}

/**
 * Owner-only bounded REAL core business-chain validation for the frozen v5
 * experiment. This is explicitly the fifth independent attempt after the failed
 * v1-v4 creates (which stay failed, reconciled and never retried): one call
 * creates a real core Goal/Task/Effect/budget/native Session/local artifact and
 * issues up to two real bounded model rounds through the normal core path. It
 * requires an idle, unpaused runtime, is single-flight, applies the existing
 * 180s/2-evaluation/frozen-budget stops, never retries a failed or unknown
 * round, and caches only the honest bounded receipt in snapshot diagnostics.
 */
export function coreGoalValidationV5Tool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_validate_core_goal_v5',
    description: '有界真实 core Goal 验证（v5 全新冻结实验，非 v1-v4 重试；显式 owner 决定的第五次独立尝试）：会创建真实 Goal/Task/Effect/budget/原生 Session/本地 artifact，并通过 core 路径发起最多 2 轮真实模型调用（含 worker 执行与独立核验）；使用全新 requestId core-validation-frozen-v5 与固定模板，不接受任何输入/参数覆盖；v1-v4 已失败并已验证 reconcile（均保持不重试），本工具不会重放它们；要求运行时未暂停且空闲，单飞、180 秒/2 次评估/冻结预算硬停止、失败或未知绝不重试；回执仅存 snapshot().diagnostics.coreGoalValidation。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-goal-v5' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  } as const;
}

/**
 * Owner-only bounded REAL core business-chain validation for the frozen v6
 * experiment. This is explicitly the sixth independent attempt after the failed
 * v1-v5 creates (which stay failed, reconciled and never retried): one call
 * creates a real core Goal/Task/Effect/budget/native Session/local artifact and
 * issues up to two real bounded model rounds through the normal core path. It
 * requires an idle, unpaused runtime, is single-flight, applies the existing
 * 180s/2-evaluation/frozen-budget stops, never retries a failed or unknown
 * round, and caches only the honest bounded receipt in snapshot diagnostics.
 */
export function coreGoalValidationV6Tool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_validate_core_goal_v6',
    description: '有界真实 core Goal 验证（v6 全新冻结实验，非 v1-v5 重试；显式 owner 决定的第六次独立尝试）：会创建真实 Goal/Task/Effect/budget/原生 Session/本地 artifact，并通过 core 路径发起最多 2 轮真实模型调用（含 worker 执行与独立核验）；使用全新 requestId core-validation-frozen-v6 与固定模板，不接受任何输入/参数覆盖；v1-v5 已失败并已验证 reconcile（均保持不重试），本工具不会重放它们；要求运行时未暂停且空闲，单飞、180 秒/2 次评估/冻结预算硬停止、失败或未知绝不重试；回执仅存 snapshot().diagnostics.coreGoalValidation。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-goal-v6' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  } as const;
}

export function memoryEmbeddingProbeTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_verify_memory_embedding',
    description: '零生成模型、单次真实本地记忆往返验证（owner-only）：在现有本地会话写入一条合成事实→真实 Harrier embedding 建索引→语义检索→精确读取→撤回并验证撤回后拒绝；不调用生成模型、0 重试；成功后 runtime 才允许声明 semantic_search，失败如实降级 exact_read；副作用=留下恰好一条已撤回的合成记忆操作（回执披露）；回执含 steps/embeddingCalls/matches/readiness/coverage。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-memory-embedding' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
export function coreGoalValidationTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_validate_core_goal',
    description: '有界真实 core Goal 业务链验证（非只读探针）：一次调用会创建真实 Goal/Task/Effect/budget/原生 Session/本地 artifact，并通过 core 路径发起最多 2 轮真实模型调用（含 worker 执行与独立核验）；要求运行时未暂停且空闲，单飞、180 秒/2 次评估/冻结预算硬停止、失败或未知绝不重试；回执仅存 snapshot().diagnostics.coreGoalValidation。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.probe-core-goal' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}
/**
 * Owner-only reconcile tool for the fixed core-validation Goal.
 *
 * This is READ-ONLY except for at most one explicit cancel of an inert
 * unauthorized partial Goal left behind by a failed create. It never creates or
 * resumes a Goal, never calls a model, never retries, and never writes around the
 * trusted core service. Paused runtimes are rejected; the receipt is cached only
 * in snapshot().diagnostics.coreValidationReconcile.
 */
export function coreValidationReconcileTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: 'shiyu_reconcile_core_validation_goal',
    description: '只读核对固定 requestId 数组（core-validation-frozen-v1 与 core-validation-frozen-v2，代码常量，调用方不可选择/覆盖）的 core-validation Goal 并分别分类（absent/inert-unauthorized/paused-authorized/cancelled/unknown）；仅每个 inert unauthorized 残留 Goal 尝试一次显式 cancel（每个目标 0 重试），v1 主字段保持兼容并在 targets[] 返回两个固定目标；不创建/重启 Goal、不调模型、不写业务库；要求运行时未暂停；回执仅存 snapshot().diagnostics.coreValidationReconcile。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: 'runtime.reconcile-core-validation-goal' }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
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
  // Bounded REAL business-chain validation: creates Goal/Task/Effect/budget/
  // Session/artifact and makes real model calls. Owner-only; never mounted into
  // restricted core/worker/replyer Sessions.
  ctx.effect(() => ctx.tools.register(coreGoalValidationTool(service)));
  ctx.effect(() => ctx.tools.register(coreGoalValidationV2Tool(service)));
  ctx.effect(() => ctx.tools.register(coreGoalValidationV3Tool(service)));
  ctx.effect(() => ctx.tools.register(coreGoalValidationV4Tool(service)));
  ctx.effect(() => ctx.tools.register(coreGoalValidationV5Tool(service)));
  ctx.effect(() => ctx.tools.register(coreGoalValidationV6Tool(service)));
  // Owner-only one-shot embedding verification; no generation model, no retry.
  ctx.effect(() => ctx.tools.register(memoryEmbeddingProbeTool(service)));
  // Zero-model native Session header-cut diagnostic: one bare lifecycle Session only.
  ctx.effect(() => ctx.tools.register(nativeHeaderCutProbeTool(service)));
  // Owner-only reconcile of the fixed core-validation Goal: read-only + at most
  // one cancel for an inert partial Goal; no Goal creation and no model call.
  ctx.effect(() => ctx.tools.register(coreValidationReconcileTool(service)));
  ctx.effect(() => ctx.tools.register(timeSourceDiagnosisTool(service)));
  ctx.effect(() => ctx.tools.register(checkpointAvailabilityTool(service)));
  // Zero-model isolated inner-lifecycle diagnosis. It constructs a private
  // :memory: store, never opens the live control database and never calls a model.
  ctx.effect(() => ctx.tools.register(innerLifecycleDiagnosisTool(service)));
  ctx.effect(() => ctx.tools.register(timeTriggerDiagnosisTool(service)));
}
