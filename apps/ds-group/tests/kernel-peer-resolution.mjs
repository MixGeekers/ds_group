// Synthetic host checks use the same pinned DSH peers as deployment, never a
// second copy of Session/Agent abstractions installed into the product package.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const harness = resolve(process.env.DSH_HARNESS || process.env.DS_GROUP_DSH_RUNTIME || resolve(root, '.cache/harness'));
if (!existsSync(resolve(harness, 'package.json'))) throw new Error('Set DSH_HARNESS to the isolated @deepseek-ai/dsh@0.2.2-rc.1 installation for kernel host tests.');
process.env.DS_GROUP_DSH_RUNTIME = harness;
const anchor = pathToFileURL(resolve(harness, 'package.json')).href;
const prefix = pathToFileURL(root).href + '/';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.startsWith(prefix)) return next(specifier, { ...context, parentURL: anchor });
  return next(specifier, context);
} });
