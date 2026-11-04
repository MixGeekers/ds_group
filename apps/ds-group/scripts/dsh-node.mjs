#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, symlink, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [operation = 'start', nodeId = 'finance'] = process.argv.slice(2);
if (!['finance', 'hr'].includes(nodeId)) throw new Error('Node must be finance or hr');
if (!['start', 'stop', 'status', 'prepare'].includes(operation)) throw new Error('Use start, stop, status or prepare');
const port = nodeId === 'finance' ? 18091 : 18092;
const local = join(root, '.local', `dsh-${nodeId}`);
const home = join(local, 'home');
const pidPath = join(local, 'process.json');
const bridgeUrl = `http://127.0.0.1:${port}`;
const cli = process.env.DS_GROUP_DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const plugin = join(root, 'dsh-plugin');
const config = {
  nodeId, port, dataDir: join(local, 'runtime'), coreUrl: process.env.DS_GROUP_CORE_URL ?? 'http://127.0.0.1:18100',
  coreConfigPath: join(root, '.local', 'core-config.json'), maxTokens: 4096,
};

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function processRecord() {
  try { return JSON.parse(await readFile(pidPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
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
    const { stdout } = await promisify(execFile)('ps', ['-p', String(recorded.pid), '-o', 'command=']);
    if (!stdout.includes('dsh-desktop-host/lib/cli.js')) throw new Error('Recorded PID no longer belongs to the isolated DSH launcher');
    process.kill(recorded.pid, 'SIGTERM');
  }
  const deadline = Date.now() + 20_000;
  while (isAlive(recorded.pid) || await status()) {
    if (Date.now() >= deadline) throw new Error('Node has not finished stopping; inspect its private log');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  console.log(JSON.stringify({ nodeId, status: 'stopped', pid: recorded.pid }));
  process.exit(0);
}
const existing = await status();
if (existing && operation === 'start') {
  console.log(JSON.stringify({ nodeId, status: 'already-running', url: bridgeUrl }));
  process.exit(0);
}
if (operation === 'start') {
  const recorded = await processRecord();
  if (recorded?.nodeId === nodeId && Number.isInteger(recorded.pid) && isAlive(recorded.pid)) {
    throw new Error('The recorded DSH process is still running without a ready bridge; stop it before starting again');
  }
}

await mkdir(local, { recursive: true });
await writeFile(join(local, '.gitignore'), '*\n!.gitignore\n');
const dependencies = join(root, '.local', 'dsh-deps');
await mkdir(dependencies, { recursive: true });
await writeFile(join(dependencies, '.gitignore'), '*\n!.gitignore\n');
const dependencyManifest = await readFile(join(plugin, 'runtime-dependencies.json'), 'utf8');
const dependencyLock = await readFile(join(plugin, 'runtime-dependencies-lock.json'), 'utf8');
let installedLock;
try { installedLock = await readFile(join(dependencies, 'package-lock.json'), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(join(dependencies, 'package.json'), dependencyManifest);
await writeFile(join(dependencies, 'package-lock.json'), dependencyLock);
const requireDependency = createRequire(join(dependencies, 'package.json'));
try {
  if (installedLock !== dependencyLock) throw new Error('Runtime dependency lock changed');
  requireDependency.resolve('deep-view/core');
  requireDependency.resolve('yaml');
}
catch {
  await promisify(execFile)('npm', ['ci', '--prefix', dependencies, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']);
}
const yaml = requireDependency(join(dependencies, 'node_modules', 'yaml', 'dist', 'index.js'));
for (const directory of [join(root, 'vendor', 'ds-bot'), plugin]) {
  try { await symlink(join(dependencies, 'node_modules'), join(directory, 'node_modules'), 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const profile = join(home, 'profiles', 'web');
await mkdir(join(profile, 'node_modules', '@ds-group'), { recursive: true });
try { await symlink(plugin, join(profile, 'node_modules', '@ds-group', 'dsh-node'), 'dir'); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
await writeFile(join(profile, 'package.json'), `${JSON.stringify({ name: `ds-group-${nodeId}-profile`, private: true,
  type: 'module', dependencies: { '@ds-group/dsh-node': `link:${plugin}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2)}\n`);
await writeFile(join(profile, 'cordis.yml'), '[]\n');

// Copy only the existing provider definition into this private isolated home.
// Credentials never appear in stdout, source control or the public node config.
const livePatch = yaml.parse(await readFile(join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'));
const provider = livePatch.find(entry => entry.id === 'llm-pi-ai')?.config?.providers?.['opencode-go'];
if (!provider) throw new Error('Existing opencode-go provider definition was not found');
const credentialName = provider.apiKeyEnv;
const credentials = yaml.parse(await readFile(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8'));
if (typeof credentialName !== 'string' || typeof credentials.refs?.[credentialName] !== 'string') throw new Error('Existing model credential reference is unavailable');
await writeFile(join(home, '.credentials.yaml'), yaml.stringify({ version: 1, records: {}, refs: { [credentialName]: credentials.refs[credentialName] } }), { mode: 0o600 });
const patch = yaml.stringify([
  { id: 'llm-pi-ai', config: { providers: { 'opencode-go': { ...provider, retryPolicy: { mode: 'normal', maxRetries: 0 } } } } },
  { id: 'agent-default-model', config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
  { insert: [{ id: 'ds-group-node', name: '@ds-group/dsh-node', config }] },
]);
await writeFile(join(profile, 'cordis.patch.yml'), patch, { mode: 0o600 });
await writeFile(join(local, 'node-config.json'), `${JSON.stringify({ ...config, bridgeUrl, home, model: 'opencode-go/deepseek-v4.1-flash' }, null, 2)}\n`);
if (operation === 'prepare') {
  console.log(JSON.stringify({ nodeId, status: 'prepared', url: bridgeUrl }));
  process.exit(0);
}
const logPath = join(local, 'host.log');
const log = await open(logPath, 'a', 0o600);
const child = spawn(cli, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: local, detached: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
});
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
await writeFile(pidPath, `${JSON.stringify({ nodeId, pid: child.pid, startedAt: new Date().toISOString(), cli, logPath }, null, 2)}\n`);
child.unref();
await log.close();
console.log(JSON.stringify({ nodeId, status: 'starting', pid: child.pid, url: bridgeUrl, logPath }));
