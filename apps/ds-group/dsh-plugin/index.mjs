import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'ds-group-node';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection'];

export async function apply(ctx, config) {
  const project = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..')).href + '/';
  const installation = process.env.DS_GROUP_DSH_RUNTIME;
  const anchor = installation
    ? pathToFileURL(resolve(installation, 'package.json')).href
    : pathToFileURL(process.argv[1]).href;
  const dependencyAnchor = process.env.DS_GROUP_RUNTIME_DEPS_DIR
    ? pathToFileURL(resolve(process.env.DS_GROUP_RUNTIME_DEPS_DIR, 'package.json')).href : undefined;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(project)) {
        return nextResolve(specifier, { ...context, parentURL: anchor });
      }
      if (dependencyAnchor && context.parentURL?.startsWith(project)
        && (specifier === 'yaml' || specifier === 'deep-view' || specifier.startsWith('deep-view/'))) {
        return nextResolve(specifier, { ...context, parentURL: dependencyAnchor });
      }
      return nextResolve(specifier, context);
    },
  });
  ctx.effect(() => () => hook.deregister());
  const runtime = await import('./runtime.mjs');
  return runtime.apply(ctx, config);
}
