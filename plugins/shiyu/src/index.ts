import { RuntimeService } from './runtime.js';
import type { RuntimeConfig } from './runtime.js';

export const inject = ['connection', 'tools', 'agents', 'agentPresets', 'systemPrompt', 'sessions', 'sessionPersistence', 'workspaceRegistry'];
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
export async function serveCommand(service: RuntimeService, request: Request): Promise<Response> {
  try { return Response.json(await service.command(await readCommand(request), request.signal), { headers }); }
  catch (error) { return errorResponse(error); }
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
  ctx.effect(() => ctx.tools.register({
    name: 'shiyu_status', description: '读取识雨本体当前状态、事件与会话概况；不执行任务或调用模型。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    execute: async () => service.snapshot(),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  }));
}
