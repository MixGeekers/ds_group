import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerRuntimeResolution } from '../dsh-plugin/index.mjs';

test('vendored imports resolve SDK and every locked dependency from their separate installation roots', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dscord-resolution-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  const sdk = path.join(directory, 'sdk');
  const dependencies = path.join(directory, 'dependencies');
  const manifest = JSON.parse(await readFile(new URL('../dsh-plugin/runtime-dependencies.json', import.meta.url), 'utf8'));
  const modules = { '@deepseek-ai/dsh-llm': sdk,
    ...Object.fromEntries(Object.keys(manifest.dependencies).map(name => [name, dependencies])) };
  for (const [name, root] of Object.entries(modules)) {
    const target = path.join(root, 'node_modules', name);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name, type: 'module', exports: { '.': './index.mjs', './probe': './index.mjs' } }));
    await writeFile(path.join(target, 'index.mjs'), `export default ${JSON.stringify(name)};`);
  }
  await mkdir(path.join(project, 'vendor'), { recursive: true });
  const names = Object.keys(modules);
  const probe = path.join(project, 'vendor', 'probe.mjs');
  await writeFile(probe, names.map((name, index) => `import value${index} from '${name}/probe';`).join('\n')
    + `\nexport default [${names.map((_, index) => `value${index}`).join(',')}];`);
  const hook = registerRuntimeResolution({ project: pathToFileURL(project).href + '/', anchor: pathToFileURL(path.join(sdk, 'package.json')).href,
    dependencyAnchor: pathToFileURL(path.join(dependencies, 'package.json')).href, dependencies: manifest.dependencies });
  try {
    assert.deepEqual((await import(pathToFileURL(probe))).default, names);
    const outside = path.join(directory, 'outside.mjs');
    await writeFile(outside, 'import "imapflow";');
    await assert.rejects(import(pathToFileURL(outside)), { code: 'ERR_MODULE_NOT_FOUND' });
  } finally { hook.deregister(); }
});
