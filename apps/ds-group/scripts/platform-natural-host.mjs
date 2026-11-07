import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from './runtime-config.mjs';
import { naturalInstructions } from './platform-natural-corpus.mjs';

// This changes only this run's generated harness, never the older experiments.
export function naturalHarness({ root, runtime, dependencies, directory, workspace }) {
  return `import {registerHooks} from 'node:module';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root=${JSON.stringify(root)},project=pathToFileURL(root).href+'/',anchor=pathToFileURL(${JSON.stringify(path.join(runtime, 'package.json'))}).href;
const dependencyAnchor=pathToFileURL(${JSON.stringify(path.join(dependencies, 'package.json'))}).href;
const dependencies=JSON.parse(await readFile(root+'/dsh-plugin/runtime-dependencies.json','utf8')).dependencies;
const entry=await import(pathToFileURL(root+'/dsh-plugin/index.mjs').href);
if(typeof entry.registerRuntimeResolution==='function')entry.registerRuntimeResolution({project,anchor,dependencyAnchor,dependencies});
else registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.startsWith(project)&&specifier.startsWith('@deepseek-ai/'))return next(specifier,{...context,parentURL:anchor});
 if(context.parentURL?.startsWith(project)&&Object.keys(dependencies).some(name=>specifier===name||specifier.startsWith(name+'/')))return next(specifier,{...context,parentURL:dependencyAnchor});
 return next(specifier,context);
}});
export const inject=['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','connection'];
export async function apply(ctx){const plugin=await import(pathToFileURL(root+'/scripts/memory-visible-host-plugin.mjs').href);return plugin.apply(ctx,{directory:${JSON.stringify(directory)},workspace:${JSON.stringify(workspace)}});}
`;
}

export async function prepareNaturalHost(directory, { corpusHash, profile, resume = false, configure } = {}) {
  const { MemoryTestHost } = await import('./memory-host.mjs');
  const host = new MemoryTestHost(directory), marker = path.join(directory, 'natural-home.json');
  await mkdir(directory, { recursive: true });
  let previous;
  try { previous = JSON.parse(await readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && (!resume || previous.corpusHash !== corpusHash || previous.profile !== profile)) throw new Error('NATURAL_HOME_IS_NOT_FRESH: use a new directory for every diagnostic/full run, or explicitly resume the identical corpus');
  if (!previous) {
    if ((await readdir(directory)).some(name => name === 'home' || name === 'workspace.json')) throw new Error('NATURAL_HOME_NOT_OWNED: refusing to reuse an existing experimental home');
    await host.prepare();
    await writeFile(marker, JSON.stringify({ corpusHash, profile, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } else {
    host.workspace = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8')).path;
    host.installation = await resolveDsh();
    host.boot = Math.max(0, ...(await readdir(directory)).map(name => Number(/^host-(\d+)\.log$/.exec(name)?.[1] || 0)));
    await host.configureModel();
  }
  await writeFile(path.join(directory, 'scenario-profile.json'), JSON.stringify({ instructions: naturalInstructions }, null, 2), { mode: 0o600 });
  await writeFile(path.join(directory, 'harness.mjs'), naturalHarness({ root: packageRoot, runtime: host.installation.runtime,
    dependencies: path.join(directory, 'dependencies'), directory, workspace: host.workspace }), { mode: 0o600 });
  if (configure) await configure(host);
  return host;
}
