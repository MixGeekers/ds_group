import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(packageRoot, 'bin', 'dscord.mjs');

async function workspace(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dscord-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, cwd, env = {}, executable = cli) {
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DS_GROUP_')));
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd, env: { ...cleanEnvironment, ...env }, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

test('CLI information and invalid commands create no data and report the installed package', async t => {
  const cwd = await workspace(t);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  for (const args of [[], ['help'], ['--help']]) {
    const result = run(args, cwd);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: dscord/);
  }
  assert.equal(run(['--version'], cwd).stdout.trim(), manifest.version);
  assert.equal(run(['path'], cwd).stdout.trim(), path.resolve(packageRoot));
  const invalid = run(['unknown'], cwd);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown command/);
  for (const args of [['service', 'up'], ['service', 'down'], ['service', 'restart'], ['dsh'], ['dsh', 'start']]) {
    assert.equal(run(args, cwd).status, 1);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test('CLI init creates real server state outside the installed package with host defaults', async t => {
  const cwd = await workspace(t);
  const result = run(['init'], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reused, false);
  const data = path.join(cwd, '.dscord');
  const metadata = JSON.parse(await readFile(path.join(data, 'server.json'), 'utf8'));
  assert.equal(metadata.homeserverUrl, 'http://127.0.0.1:18008');
  assert.equal((await stat(path.join(data, 'core-config.json'))).isFile(), true);
  assert.equal((await stat(path.join(data, 'synapse', 'homeserver.yaml'))).isFile(), true);
  assert.equal(JSON.parse(run(['init'], cwd).stdout).reused, true);
});

test('CLI init preserves configured URLs and resolves relative data paths from the caller', async t => {
  const cwd = await workspace(t);
  const result = run(['init'], cwd, {
    DS_GROUP_DATA_DIR: 'state with spaces', DS_GROUP_SYNAPSE_DIR: 'matrix with spaces',
    DS_GROUP_MATRIX_URL: 'https://matrix.example', DS_GROUP_SERVER_NAME: 'chat.example',
    DS_GROUP_PUBLIC_URL: 'https://chat.example', DS_GROUP_MATRIX_PUBLIC_URL: 'https://matrix.example',
  });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(await readFile(path.join(cwd, 'state with spaces', 'server.json'), 'utf8'));
  assert.equal(metadata.homeserverUrl, 'https://matrix.example');
  assert.equal(metadata.publicUrl, 'https://chat.example');
  assert.equal((await stat(path.join(cwd, 'matrix with spaces', 'homeserver.yaml'))).isFile(), true);
  assert.deepEqual((await readdir(cwd)).sort(), ['matrix with spaces', 'state with spaces']);
});

test('CLI passes stable absolute paths through a child cwd change and preserves node URL fallback', async t => {
  const cwd = await workspace(t);
  const installed = path.join(cwd, 'node_modules', 'dscord');
  await mkdir(path.join(installed, 'bin'), { recursive: true });
  await mkdir(path.join(installed, 'src'), { recursive: true });
  await copyFile(cli, path.join(installed, 'bin', 'dscord.mjs'));
  await copyFile(path.join(packageRoot, 'src', 'paths.mjs'), path.join(installed, 'src', 'paths.mjs'));
  await writeFile(path.join(installed, 'src', 'bot-node.mjs'), `
    import { fileURLToPath } from 'node:url';
    const caller = process.cwd();
    process.chdir(fileURLToPath(new URL('../', import.meta.url)));
    const { localRoot } = await import('./paths.mjs');
    console.log(JSON.stringify({ caller, localRoot, synapse: process.env.DS_GROUP_SYNAPSE_DIR,
      report: process.env.DS_GROUP_MATRIX_REPORT, matrixUrl: process.env.DS_GROUP_MATRIX_URL,
      paths: { core: process.env.DS_GROUP_CORE_CONFIG_PATH, setup: process.env.DS_GROUP_MATRIX_SETUP_PATH,
        web: process.env.DS_GROUP_WEB_DIR, source: process.env.DS_GROUP_DSH_SOURCE_HOME,
        runtime: process.env.DS_GROUP_DSH_RUNTIME, cli: process.env.DS_GROUP_DSH_CLI,
        dependencies: process.env.DS_GROUP_RUNTIME_DEPS_DIR },
      args: process.argv.slice(2) }));
  `);
  const executable = path.join(installed, 'bin', 'dscord.mjs');
  const result = run(['node', '--bot', 'finance'], cwd, { DS_GROUP_DATA_DIR: 'private data' }, executable);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    caller: cwd, localRoot: path.join(cwd, 'private data'),
    synapse: path.join(cwd, 'private data', 'synapse'), report: path.join(cwd, 'private data', 'matrix-smoke.json'),
    paths: {}, args: ['--bot', 'finance'],
  });
  const configured = run(['node'], cwd, {
    DS_GROUP_MATRIX_URL: 'https://remote.example', DS_GROUP_CORE_CONFIG_PATH: 'config/core.json',
    DS_GROUP_MATRIX_SETUP_PATH: 'config/setup.json', DS_GROUP_WEB_DIR: 'public',
    DS_GROUP_DSH_SOURCE_HOME: 'source-home', DS_GROUP_DSH_RUNTIME: 'runtime',
    DS_GROUP_DSH_CLI: './runtime/bin/dsh', DS_GROUP_RUNTIME_DEPS_DIR: 'dependencies',
  }, executable);
  const configuration = JSON.parse(configured.stdout);
  assert.equal(configuration.matrixUrl, 'https://remote.example');
  assert.deepEqual(configuration.paths, {
    core: path.join(cwd, 'config/core.json'), setup: path.join(cwd, 'config/setup.json'), web: path.join(cwd, 'public'),
    source: path.join(cwd, 'source-home'), runtime: path.join(cwd, 'runtime'), cli: path.join(cwd, 'runtime/bin/dsh'),
    dependencies: path.join(cwd, 'dependencies'),
  });
  const commandName = run(['node'], cwd, { DS_GROUP_DSH_CLI: 'dsh' }, executable);
  assert.equal(JSON.parse(commandName.stdout).paths.cli, 'dsh');
});

test('CLI preserves child exit codes and forwards termination to its child', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  const cwd = await workspace(t);
  await mkdir(path.join(cwd, 'bin'));
  await mkdir(path.join(cwd, 'src'));
  const executable = path.join(cwd, 'bin', 'dscord.mjs');
  const server = path.join(cwd, 'src', 'core.mjs');
  await copyFile(cli, executable);
  await writeFile(server, 'process.exitCode = 23;\n');
  assert.equal(run(['server'], cwd, {}, executable).status, 23);

  await writeFile(server, "setInterval(() => {}, 1000); process.stdout.write('ready\\n');\n");
  const child = spawn(process.execPath, [executable, 'server'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [null, 'SIGTERM']);
});
