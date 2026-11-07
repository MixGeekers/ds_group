import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { prepareRuntimeDependencies, runtimeDependencyInstaller, verifyRuntimeDependencyManifests } from '../scripts/runtime-dependencies.mjs';

const plugin = fileURLToPath(new URL('../dsh-plugin', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-runtime-deps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function installedFixture(directory) {
  const { dependencies } = JSON.parse(await readFile(path.join(plugin, 'runtime-dependencies.json'), 'utf8'));
  for (const [name, version] of Object.entries(dependencies)) {
    const target = path.join(directory, 'node_modules', name);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name, version, exports: name === 'deep-view' ? { './core': './index.js' } : './index.js' }));
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

test('a missing new dependency entrypoint is repaired even when its installed version matches', async t => {
  const directory = await fixture(t);
  let runs = 0;
  const options = { directory, plugin, runtime: directory, run: async () => { runs++; await installedFixture(directory); } };
  await prepareRuntimeDependencies(options);
  await rm(path.join(directory, 'node_modules', '@modelcontextprotocol', 'client', 'index.js'));
  await prepareRuntimeDependencies(options);
  assert.equal(runs, 2);
});

test('release validation rejects missing npm or private runtime dependencies before packing', async t => {
  const root = await fixture(t);
  const dependencies = { imapflow: '2.9.1' };
  await mkdir(path.join(root, 'vendor/ds-bot'), { recursive: true });
  await mkdir(path.join(root, 'dsh-plugin'), { recursive: true });
  await writeFile(path.join(root, 'vendor/ds-bot/package.json'), JSON.stringify({ dependencies }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies }));
  await writeFile(path.join(root, 'dsh-plugin/runtime-dependencies.json'), JSON.stringify({ dependencies }));
  await writeFile(path.join(root, 'dsh-plugin/runtime-dependencies-lock.json'), JSON.stringify({ packages: { '': { dependencies }, 'node_modules/imapflow': { version: '2.9.1' } } }));
  await writeFile(path.join(root, 'dsh-plugin/runtime-dependencies-pnpm-lock.yaml'), 'lockfileVersion: 9.0');
  assert.deepEqual(await verifyRuntimeDependencyManifests(root), dependencies);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  await assert.rejects(verifyRuntimeDependencyManifests(root), /npm runtime dependency.*imapflow/);
  await writeFile(path.join(root, 'dsh-plugin/runtime-dependencies.json'), JSON.stringify({ dependencies: {} }));
  await assert.rejects(verifyRuntimeDependencyManifests(root), /vendored DS-Bot.*imapflow/);
});

test('npm and pnpm runtime locks retain the same package versions and archive integrity', async () => {
  const npm = JSON.parse(await readFile(path.join(plugin, 'runtime-dependencies-lock.json'), 'utf8'));
  const pnpm = parseYaml(await readFile(path.join(plugin, 'runtime-dependencies-pnpm-lock.yaml'), 'utf8'));
  assert.equal(pnpm.settings.autoInstallPeers, false);
  const packages = new Set();
  for (const [location, value] of Object.entries(npm.packages)) {
    if (!location) continue;
    const name = location.split('node_modules/').at(-1);
    const key = `${name}@${value.version}`;
    packages.add(key);
    assert.equal(pnpm.packages[key]?.resolution?.integrity, value.integrity, key);
  }
  assert.equal(Object.keys(pnpm.packages).length, packages.size);
});
