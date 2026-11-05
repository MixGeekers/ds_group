import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeDependencies, runtimeDependencyInstaller } from '../scripts/runtime-dependencies.mjs';

const plugin = fileURLToPath(new URL('../dsh-plugin', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-runtime-deps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function installedFixture(directory) {
  for (const [name, version, exports] of [['deep-view', '0.1.0', { './core': './index.js' }], ['yaml', '2.9.1', './index.js']]) {
    const target = path.join(directory, 'node_modules', name);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name, version, exports }));
    await writeFile(path.join(target, 'index.js'), 'module.exports = {};');
  }
}

test('desktop runtime uses its bundled Node and pnpm without a PATH dependency', async t => {
  const root = await fixture(t);
  const runtime = path.join(root, 'Resources', 'app.asar', 'dsh');
  const dependencies = path.join(root, 'Resources', 'runtime', 'primary-runtime', 'dependencies');
  const node = path.join(dependencies, 'node', 'bin', 'node');
  const pnpm = path.join(dependencies, 'pnpm', 'bin', 'pnpm.cjs');
  for (const filename of [node, pnpm]) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'fixture');
  }
  await chmod(node, 0o755);
  const installer = await runtimeDependencyInstaller(runtime);
  assert.equal(installer.command, node);
  assert.equal(installer.args[0], pnpm);
  for (const argument of ['--frozen-lockfile', '--ignore-scripts', '--ignore-workspace', '--config.auto-install-peers=false', '--config.confirm-modules-purge=false']) {
    assert.ok(installer.args.includes(argument));
  }
});

test('CLI installations retain the locked npm ci path', async t => {
  const root = await fixture(t);
  assert.deepEqual(await runtimeDependencyInstaller(path.join(root, 'node_modules', '@deepseek-ai', 'dsh')), {
    command: 'npm', args: ['ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'],
  });
});

test('runtime preparation records completion after verification and reuses an intact installation', async t => {
  const directory = await fixture(t);
  let runs = 0;
  const options = { directory, plugin, runtime: directory, run: async () => { runs++; await installedFixture(directory); } };
  const required = await prepareRuntimeDependencies(options);
  assert.match(required.resolve('deep-view/core'), /deep-view/);
  await prepareRuntimeDependencies(options);
  assert.equal(runs, 1);
  const filename = path.join(directory, 'node_modules', 'yaml', 'package.json');
  await writeFile(filename, JSON.stringify({ name: 'yaml', version: '0.0.0', exports: './index.js' }));
  await prepareRuntimeDependencies(options);
  assert.equal(runs, 2);
});

test('a failed dependency install remains retryable and cannot mark stale modules as ready', async t => {
  const directory = await fixture(t);
  const options = { directory, plugin, runtime: directory };
  await assert.rejects(prepareRuntimeDependencies({ ...options, run: async () => { throw new Error('fixture install failure'); } }), /fixture install failure/);
  await assert.rejects(readFile(path.join(directory, '.runtime-lock.sha256')), { code: 'ENOENT' });
  await prepareRuntimeDependencies({ ...options, run: () => installedFixture(directory) });
  assert.match(await readFile(path.join(directory, '.runtime-lock.sha256'), 'utf8'), /^[a-f0-9]{64}$/);
});

test('npm and pnpm runtime locks retain the same package versions and archive integrity', async () => {
  const npm = JSON.parse(await readFile(path.join(plugin, 'runtime-dependencies-lock.json'), 'utf8'));
  const pnpm = await readFile(path.join(plugin, 'runtime-dependencies-pnpm-lock.yaml'), 'utf8');
  assert.match(pnpm, /autoInstallPeers: false/);
  for (const [location, value] of Object.entries(npm.packages)) {
    if (!location) continue;
    const name = location.replace('node_modules/', '');
    assert.ok(pnpm.includes(`${name}@${value.version}:`));
    assert.ok(pnpm.includes(`integrity: ${value.integrity}`));
  }
  assert.equal((pnpm.match(/resolution:/g) || []).length, Object.keys(npm.packages).length - 1);
});
