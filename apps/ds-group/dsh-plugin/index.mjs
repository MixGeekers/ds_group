import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'ds-group-node';
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection'];

export function registerRuntimeResolution({ project, anchor, dependencyAnchor, dependencies }) {
  const names = new Set(Object.keys(dependencies));
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(project)) {
        return nextResolve(specifier, { ...context, parentURL: anchor });
      }
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (dependencyAnchor && context.parentURL?.startsWith(project) && names.has(name)) {
        return nextResolve(specifier, { ...context, parentURL: dependencyAnchor });
      }
      return nextResolve(specifier, context);
    },
  });
}

export async function apply(ctx, config) {
  const project = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..')).href + '/';
  const installation = process.env.DS_GROUP_DSH_RUNTIME;
  const anchor = installation
    ? pathToFileURL(resolve(installation, 'package.json')).href
    : pathToFileURL(process.argv[1]).href;
  const dependencyAnchor = process.env.DS_GROUP_RUNTIME_DEPS_DIR
    ? pathToFileURL(resolve(process.env.DS_GROUP_RUNTIME_DEPS_DIR, 'package.json')).href : undefined;
  const { dependencies } = JSON.parse(await readFile(new URL('./runtime-dependencies.json', import.meta.url), 'utf8'));
  const hook = registerRuntimeResolution({ project, anchor, dependencyAnchor, dependencies });
  ctx.effect(() => () => hook.deregister());
  const runtime = await import('./runtime.mjs');
  return runtime.apply(ctx, config);
}
