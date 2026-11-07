// Synthetic host checks use the same pinned DSH peers as deployment, never a
// second copy of Session/Agent abstractions installed into the product package.
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRuntimeDependencies } from '../scripts/runtime-dependencies.mjs';
import { registerRuntimeResolution } from '../dsh-plugin/index.mjs';

const root = resolve(import.meta.dirname, '..');
const harness = resolve(process.env.DSH_HARNESS || process.env.DS_GROUP_DSH_RUNTIME || resolve(root, '.cache/harness'));
if (!existsSync(resolve(harness, 'package.json'))) throw new Error('Set DSH_HARNESS to the isolated @deepseek-ai/dsh@0.2.2-rc.1 installation for kernel host tests.');
process.env.DS_GROUP_DSH_RUNTIME = harness;
const anchor = pathToFileURL(resolve(harness, 'package.json')).href;
const prefix = pathToFileURL(root).href + '/';
const owned = !process.env.DS_GROUP_RUNTIME_DEPS_DIR;
const directory = owned ? await mkdtemp(resolve(tmpdir(), 'dscord-kernel-peer-deps-')) : resolve(process.env.DS_GROUP_RUNTIME_DEPS_DIR);
if (owned) process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
await prepareRuntimeDependencies({ directory, plugin: resolve(root, 'dsh-plugin'), runtime: harness });
const { dependencies } = JSON.parse(await readFile(resolve(root, 'dsh-plugin/runtime-dependencies.json'), 'utf8'));
process.env.DS_GROUP_RUNTIME_DEPS_DIR = directory;
registerRuntimeResolution({ project: prefix, anchor, dependencyAnchor: pathToFileURL(resolve(directory, 'package.json')).href, dependencies });
