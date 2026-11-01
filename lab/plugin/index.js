import { GymService } from './service.js';
import { managementTool } from './tools.js';

export const inject = ['connection', 'tools', 'agents', 'systemPrompt'];
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const failure = (error, status = 400) => Response.json({ error: error.message ?? String(error), message: error.message ?? String(error) }, { status, headers });

export async function readJSON(request, maxBytes = 2 * 1024 * 1024) {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new Error('需要 application/json');
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error('请求超过 2 MiB');
  return JSON.parse(text);
}
export async function serveRequest(service, request) {
  try { return Response.json(await service.dispatch(await readJSON(request), request.signal), { headers }); }
  catch (error) { return failure(error); }
}
export async function serveTarget(service, request) {
  try {
    const body = await readJSON(request);
    if (!service.engine.authorizeTarget(body.runId, body.targetToken)) return failure(new Error('无效运行令牌'), 403);
    return Response.json(await service.targetCall(body.runId, body.request, request.signal), { headers });
  } catch (error) { return failure(error); }
}
export async function serveDownload(service, request, kind) {
  try {
    const query = new URL(request.url).searchParams, runId = query.get('runId');
    if (kind === 'evidence') return new Response(JSON.stringify(await service.packet(runId), null, 2), { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(runId)}-evidence.json"` } });
    const { bytes, name } = await service.artifact(runId, query.get('path'));
    return new Response(bytes, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } });
  } catch (error) { return failure(error, 404); }
}
export async function apply(ctx, config = {}) {
  const service = new GymService(ctx, config);
  await service.init();
  ctx.effect(() => () => service.close());
  ctx.provide('shiyuGym', service);
  ctx.on('agent/created', ({ agent }) => service.driver.protectResumed(agent));
  // Reapply fail-closed policy to history Sessions already live during plugin reload.
  for (const agent of ctx.agents.list()) service.driver.protectResumed(agent);
  ctx.effect(() => ctx.tools.register(managementTool(service)));
  // Exact Connection routes inherit the existing DSH authentication and Host/Origin admission.
  for (const [url, methods, handler] of [
    ['/api/shiyu-gym', ['POST'], request => serveRequest(service, request)],
    ['/api/shiyu-gym/target', ['POST'], request => serveTarget(service, request)],
    ['/api/shiyu-gym/artifact', ['GET'], request => serveDownload(service, request, 'artifact')],
    ['/api/shiyu-gym/evidence', ['GET'], request => serveDownload(service, request, 'evidence')],
  ]) ctx.effect(() => ctx.connection.fetch.register({ path: url, methods, ...(methods.includes('POST') ? { requestBody: 'buffered' } : {}), fetch: handler }));
}
