import path from 'node:path';
import { homedir } from 'node:os';
import { ConnectController } from './controller.mjs';

export const name = 'dscord-connect';
export const inject = ['connection', 'profileContext'];

export async function apply(ctx, config = {}) {
  const sourceHome = path.resolve(process.env.DSH_HOME || path.join(homedir(), '.dsh'));
  const sourceProfile = ctx.profileContext?.name || 'desktop';
  const directory = path.resolve(config.dataDirectory || path.join(sourceHome, 'dscord', sourceProfile));
  const controller = new ConnectController({ directory, sourceHome, sourceProfile });
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
        result = { ok: false, error: { code: error.code || 'dscord/error', message: error.message, details: {} } };
      }
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    },
  }), 'dscord: connection API');
  ctx.effect(() => () => controller.dispose(), 'dscord: owned Bot processes');
  await ready;
}
