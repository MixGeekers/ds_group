import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'ds-group-node';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection'];

export async function apply(ctx, config) {
  const project = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..')).href + '/';
  const installation = process.env.DS_GROUP_DSH_RUNTIME ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
  const anchor = pathToFileURL(`${installation}/package.json`).href;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(project)) {
        return nextResolve(specifier, { ...context, parentURL: anchor });
      }
      return nextResolve(specifier, context);
    },
  });
  ctx.effect(() => () => hook.deregister());
  const runtime = await import('./runtime.mjs');
  return runtime.apply(ctx, config);
}
