import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { packageRoot } from '../src/paths.mjs';

/** Start the complete bundled DS-Bot only when no native team is installed.
 * Its default home is DSH_HOME/bot, so normal mode and its saved team remain native. */
export async function startNativeTeam(ctx) {
  const root = pathToFileURL(packageRoot).href + '/';
  const anchor = process.env.DS_GROUP_DSH_RUNTIME
    ? pathToFileURL(path.join(process.env.DS_GROUP_DSH_RUNTIME, 'package.json')).href
    : pathToFileURL(process.argv[1]).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(root)) return next(specifier, { ...context, parentURL: anchor });
    return next(specifier, context);
  } });
  ctx.effect(() => () => hooks.deregister(), 'dscord: native dependency resolution');
  const { createRuntime } = await import('../vendor/ds-bot/index.js');
  const { installNativeMemory } = await import('../memory/native.mjs');
  const { apply: applySearch } = await import('../vendor/ds-bot/web-search.js');
  ctx.inject(['web'], scope => {
    if (!scope.web.searchProviders.has('auto')) applySearch(scope);
  });
  return createRuntime(ctx, { memoryBackend: installNativeMemory });
}
