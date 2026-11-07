import path from 'node:path';
import { homedir } from 'node:os';
import { ConnectController } from './controller.mjs';
import { DshModels } from './models.mjs';
import { NativeBots } from './native-bots.mjs';
import { NativeConnections } from './native-connections.mjs';
import { startNativeTeam } from './native-team.mjs';

export const name = 'dscord-connect';
export const inject = ['connection', 'profileContext', 'llm', 'settings', 'credentials', 'sessionController', 'sessions', 'tools', 'systemPrompt', 'sessionTitle', 'workspaceRegistry'];

export async function apply(ctx, config = {}) {
  const sourceHome = path.resolve(process.env.DSH_HOME || path.join(homedir(), '.dsh'));
  const sourceProfile = ctx.profileContext?.name || 'desktop';
  const directory = path.resolve(config.dataDirectory || path.join(sourceHome, 'dscord', sourceProfile));
  const native = new NativeBots(ctx, { ensureTeam: () => startNativeTeam(ctx, { home: config.kernelHome }) });
  const models = new DshModels(ctx);
  const processes = new NativeConnections({ ctx, native });
  const controller = new ConnectController({ directory, sourceHome, sourceProfile, models, native, processes });
  const ready = controller.initialize();
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dscord', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let result;
      try {
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式无效');
        await ready;
        result = { ok: true, value: await controller.handle(body) };
      } catch (error) {
        result = { ok: false, error: { code: error.code || 'dscord/error', message: error.message, details: error.details || {} } };
      }
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    },
  }), 'dscord: connection API');
  ctx.effect(() => () => controller.dispose(), 'dscord: owned Bot processes');
  await ready;
  const timer = setInterval(() => void controller.synchronizeNative().catch(() => {}), 10000);
  ctx.effect(() => () => clearInterval(timer), 'dscord: native roster discovery');
}
