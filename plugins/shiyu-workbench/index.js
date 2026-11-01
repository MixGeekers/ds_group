import { ShiyuWorkbench, toolDefinition, serveRequest } from './core.js';
export const inject = ['fs', 'storage', 'connection', 'tools'];
export async function apply(ctx, config) {
  const kv = ctx.storage.backend.get('json').kv;
  if (!kv) throw new Error('识雨工作台需要 JSON KV storage。');
  const unit = await kv.open({ name: 'shiyu_workbench_v1', version: 1, tables: [], hasGlobal: true, layout: 'single' });
  const service = new ShiyuWorkbench(ctx.fs, unit, { initialWorkspace: config.initialWorkspace });
  ctx.effect(() => () => service.close());
  await service.initialize();
  ctx.provide('shiyuWorkbench', service);
  ctx.effect(() => ctx.tools.register(toolDefinition(service)));
  // Exact Connection routes inherit owner authentication and Host/Origin checks.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/shiyu-workbench', methods: ['POST'], requestBody: 'buffered',
    fetch: request => serveRequest(service, request),
  }));
}
