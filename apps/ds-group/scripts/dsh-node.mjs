#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, symlink, open, readlink, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';
import { runtimeSettings, resolveDsh, providerConfiguration, httpUrl, MODEL } from './runtime-config.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';

const [operation = 'start', nodeId = 'finance'] = process.argv.slice(2);
if (!['start', 'run', 'stop', 'status', 'prepare'].includes(operation)) throw new Error('Use start, run, stop, status or prepare');
const settings = runtimeSettings(nodeId, { root: packageRoot });
if (!process.env.DS_GROUP_CORE_URL) {
  try {
    const imported = JSON.parse(await readFile(settings.coreConfigPath, 'utf8'));
    if (imported.publicUrl) settings.coreUrl = httpUrl(imported.publicUrl, 'Imported core URL');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const { local, home, bridgeUrl, dataRoot } = settings;
const webPort = process.env.DS_GROUP_DSH_WEB_PORT || '0';
if (!/^\d{1,5}$/.test(webPort) || Number(webPort) > 65535) throw new Error('DS_GROUP_DSH_WEB_PORT must be a port from 0 to 65535');
const script = fileURLToPath(import.meta.url);
const pidPath = join(local, 'process.json');
const plugin = join(packageRoot, 'dsh-plugin');
const config = {
  nodeId, port: settings.port, dataDir: join(local, 'runtime'), coreUrl: settings.coreUrl,
  coreConfigPath: settings.coreConfigPath, maxTokens: 4096,
};
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function processRecord() {
  try { return JSON.parse(await readFile(pidPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function ownsProcess(recorded) {
  if (!recorded || recorded.nodeId !== nodeId || !isAlive(recorded.pid)) return false;
  const { stdout } = await execute('ps', ['-p', String(recorded.pid), '-o', 'command=']);
  if (recorded.script) return recorded.script === script && recorded.local === local && stdout.includes(`${script} run ${nodeId}`);
  // Existing 0.1.0 desktop installations recorded the DSH process directly.
  return recorded.cli?.endsWith('/runtime/cli/bin/dsh') && stdout.includes('dsh-desktop-host/lib/cli.js');
}

async function status() {
  try {
    const response = await fetch(`${bridgeUrl}/api/ds-group-node/status`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const current = await response.json();
    return current.nodeId === nodeId ? current : undefined;
  } catch { return undefined; }
}

if (operation === 'status') {
  console.log(JSON.stringify(await status() ?? { nodeId, status: 'offline' }));
  process.exit(0);
}
if (operation === 'stop') {
  const recorded = await processRecord();
  if (!recorded) {
    console.log(JSON.stringify({ nodeId, status: 'stopped' }));
    process.exit(0);
  }
  if (recorded.nodeId !== nodeId || !Number.isInteger(recorded.pid)) throw new Error('Invalid node process record');
  if (isAlive(recorded.pid)) {
    if (!await ownsProcess(recorded)) throw new Error('Recorded PID no longer belongs to this DSH launcher');
    process.kill(recorded.pid, 'SIGTERM');
  }
  const deadline = Date.now() + 40_000;
  while (isAlive(recorded.pid)) {
    if (Date.now() >= deadline) throw new Error('Node has not finished stopping; inspect its private log');
    await delay(200);
  }
  console.log(JSON.stringify({ nodeId, status: 'stopped', pid: recorded.pid }));
  process.exit(0);
}
if (operation === 'start') {
  const recorded = await processRecord();
  const existing = await status();
  if (existing) {
    if (!await ownsProcess(recorded)) throw new Error(`Bridge port ${settings.port} belongs to another running installation`);
    console.log(JSON.stringify({ nodeId, status: 'already-running', url: bridgeUrl }));
    process.exit(0);
  }
  if (recorded && isAlive(recorded.pid)) throw new Error('The recorded DSH process is still starting or stopping; inspect its private log');
  await mkdir(local, { recursive: true, mode: 0o700 });
  const logPath = join(local, 'host.log');
  const log = await open(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [script, 'run', nodeId], {
    cwd: packageRoot, detached: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, DS_GROUP_DATA_DIR: dataRoot },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await writeFile(pidPath, `${JSON.stringify({ nodeId, pid: child.pid, script, local, startedAt: new Date().toISOString(), logPath }, null, 2)}\n`, { mode: 0o600 });
  child.unref();
  await log.close();
  console.log(JSON.stringify({ nodeId, status: 'starting', pid: child.pid, url: bridgeUrl, logPath }));
  process.exit(0);
}

const { cli, runtime } = await resolveDsh();
await mkdir(local, { recursive: true, mode: 0o700 });
const dependencies = join(dataRoot, 'dsh-deps');
const requireDependency = await prepareRuntimeDependencies({ directory: dependencies, plugin, runtime });
const yaml = requireDependency(join(dependencies, 'node_modules', 'yaml', 'dist', 'index.js'));
async function ensureLink(target, link) {
  try { await symlink(target, link, 'dir'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let current;
    try { current = await readlink(link); }
    catch { throw new Error(`Expected a dependency link at ${link}`); }
    if (resolve(link, '..', current) !== resolve(target)) throw new Error(`Dependency link belongs to another data directory: ${link}`);
  }
}
const profile = join(home, 'profiles', 'web');
await mkdir(join(profile, 'node_modules', '@ds-group'), { recursive: true });
await ensureLink(plugin, join(profile, 'node_modules', '@ds-group', 'dsh-node'));
await writeFile(join(profile, 'package.json'), `${JSON.stringify({ name: `ds-group-${nodeId}-profile`, private: true,
  type: 'module', dependencies: { '@ds-group/dsh-node': `link:${plugin}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2)}\n`);
await writeFile(join(profile, 'cordis.yml'), '[]\n');

let sourceProvider;
let sourceCredentials;
if (!process.env.OPENCODE_API_KEY?.trim()) {
  const sourcePatch = join(settings.sourceHome, 'profiles', settings.sourceProfile, 'cordis.patch.yml');
  try {
    const patch = yaml.parse(await readFile(sourcePatch, 'utf8'));
    sourceProvider = patch.find(entry => entry.id === 'llm-pi-ai')?.config?.providers?.['opencode-go'];
    sourceCredentials = yaml.parse(await readFile(join(settings.sourceHome, '.credentials.yaml'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Set OPENCODE_API_KEY or configure DS_GROUP_DSH_SOURCE_HOME and DS_GROUP_DSH_SOURCE_PROFILE');
  }
}
const { provider, credentials } = providerConfiguration({ sourceProvider, sourceCredentials });
const credentialsPath = join(home, '.credentials.yaml');
await writeFile(credentialsPath, yaml.stringify(credentials), { mode: 0o600 });
await chmod(credentialsPath, 0o600);
const patch = yaml.stringify([
  { id: 'llm-pi-ai', config: { providers: { 'opencode-go': provider } } },
  { id: 'agent-default-model', config: { provider: 'opencode-go', model: MODEL, reasoningEffort: 'low' } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
  { insert: [{ id: 'ds-group-node', name: '@ds-group/dsh-node', config }] },
]);
await writeFile(join(profile, 'cordis.patch.yml'), patch, { mode: 0o600 });
await writeFile(join(local, 'node-config.json'), `${JSON.stringify({ ...config, bridgeUrl, home, cli, runtime, model: `opencode-go/${MODEL}` }, null, 2)}\n`, { mode: 0o600 });
if (operation === 'prepare') {
  console.log(JSON.stringify({ nodeId, status: 'prepared', url: bridgeUrl }));
  process.exit(0);
}

const childEnvironment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DS_GROUP_DSH_RUNTIME: runtime,
  DS_GROUP_RUNTIME_DEPS_DIR: dependencies };
delete childEnvironment.OPENCODE_API_KEY;
const child = spawn(cli, ['web', '--host', '127.0.0.1', '--port', webPort, '--no-open'], {
  cwd: local, stdio: 'inherit', env: childEnvironment,
});
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shuttingDown = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = shuttingDown ? 0 : (code ?? 1); });
