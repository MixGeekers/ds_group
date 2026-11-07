import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { packageRoot } from '../src/paths.mjs';
import { claimKernelHome, detectLegacyRuntime, kernelConflict, KERNEL_API } from './kernel-runtime.mjs';

/** DSCord owns its runtime. Existing Bot homes are adopted under one lease. */
export async function startNativeTeam(ctx, config = {}) {
  const dependencies = new Set(Object.keys(JSON.parse(readFileSync(new URL('../dsh-plugin/runtime-dependencies.json', import.meta.url), 'utf8')).dependencies));
  const legacy = await detectLegacyRuntime(ctx);
  if (legacy) throw kernelConflict('The previous DS-Bot API is active. Stop it before adopting this Bot home.', { legacy });
  const home = path.resolve(config.home ?? path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'bot'));
  const lease = claimKernelHome(home, { owner: ctx });
  const root = pathToFileURL(packageRoot).href + '/';
  const anchor = process.env.DS_GROUP_DSH_RUNTIME
    ? pathToFileURL(path.join(process.env.DS_GROUP_DSH_RUNTIME, 'package.json')).href
    : pathToFileURL(process.argv[1]).href;
  const dependencyAnchor = process.env.DS_GROUP_RUNTIME_DEPS_DIR
    ? pathToFileURL(path.join(process.env.DS_GROUP_RUNTIME_DEPS_DIR, 'package.json')).href : undefined;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(root)) return next(specifier, { ...context, parentURL: anchor });
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (dependencyAnchor && dependencies.has(name) && context.parentURL?.startsWith(root)) return next(specifier, { ...context, parentURL: dependencyAnchor });
    return next(specifier, context);
  } });
  let child;
  const release = () => { lease.release(); hooks.deregister(); };
  try {
    const { createRuntime, inject } = await import('../vendor/ds-bot/index.js');
    const { installNativeMemory } = await import('../memory/native.mjs');
    const { apply: applySearch } = await import('../vendor/ds-bot/web-search.js');
    let runtime;
    const install = async scope => {
      scope.inject(['web'], search => { if (!search.web.searchProviders.has('auto')) applySearch(search); });
      runtime = createRuntime(scope, { ...config, home: lease.home, homeLock: lease.lock, releaseHomeLock: false, apiRoute: KERNEL_API,
        autoBootstrap: false, structuredSources: true, preserveNativeTools: true, memoryBackend: installNativeMemory, updateCheck: false,
        runtimeInfo: lease.info, resumeInterrupted: !lease.adopted });
      await runtime.load();
      if (runtime.readOnly()) throw kernelConflict(runtime.readOnly(), { home: lease.home });
      if (lease.adopted) await runtime.prepareMigration();
      lease.ready(runtime);
    };
    // Cordis rolls back every installed listener/effect if startup fails.
    if (typeof ctx.plugin === 'function') {
      child = ctx.plugin({ name: 'dscord-kernel', inject, apply: install });
      // Cordis unloads a fiber's separate effects in parallel. The home lease is
      // outside the child fiber and joins its entire shutdown, including memory
      // reviews, inbox notes and state writes, before admitting a replacement.
      ctx.effect(() => async () => { try { await child.dispose(); } finally { release(); } }, 'dscord: kernel lifecycle');
      await child;
    } else {
      // Minimal synthetic hosts dispose effects in registration order reversed.
      ctx.effect(() => release, 'dscord: kernel lifecycle');
      await install(ctx);
    }
    return runtime;
  } catch (error) {
    try { await child?.dispose(); } finally { release(); }
    throw error;
  }
}
