#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { packageRoot, localPath } from '../src/paths.mjs';
import { httpUrl, portNumber, runtimeSettings } from './runtime-config.mjs';

const [command = 'status', component = 'all'] = process.argv.slice(2);
if (!['up', 'down', 'status', 'restart'].includes(command)) throw new Error('Use up, down, restart or status');
if (!['all', 'core', 'finance', 'hr'].includes(component)) throw new Error('Component must be all, core, finance or hr');
if (process.platform === 'win32' && command !== 'status') throw new Error('Use Docker Compose or WSL2 for service lifecycle on Windows');
if (component === 'all' && process.env.DS_GROUP_BRIDGE_PORT) throw new Error('Use DS_GROUP_FINANCE_PORT and DS_GROUP_HR_PORT when starting both Bots');
const corePort = portNumber(process.env.DS_GROUP_PORT, 18100, 'DS_GROUP_PORT');
const coreHost = process.env.DS_GROUP_HOST || '127.0.0.1';
const connectHost = ['0.0.0.0', '::'].includes(coreHost) ? '127.0.0.1' : coreHost;
const localCoreUrl = `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${corePort}`;
let coreUrl = httpUrl(process.env.DS_GROUP_CORE_URL || localCoreUrl, 'DS_GROUP_CORE_URL');
if (!process.env.DS_GROUP_CORE_URL) {
  try {
    const imported = JSON.parse(await readFile(process.env.DS_GROUP_CORE_CONFIG_PATH || localPath('core-config.json'), 'utf8'));
    if (imported.publicUrl) coreUrl = httpUrl(imported.publicUrl, 'Imported core URL');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const paths = name => ({ record: localPath('processes', `${name}.json`), log: localPath('logs', `${name}.log`) });

async function readRecord(name) {
  try { return JSON.parse(await readFile(paths(name).record, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function isAlive(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid < 1) return false;
  try {
    process.kill(record.pid, 0);
    const commandLine = execFileSync('ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' });
    return commandLine.includes(record.script) && record.script.startsWith(packageRoot + path.sep);
  } catch { return false; }
}
async function start(name, file, args = []) {
  if (isAlive(await readRecord(name))) return;
  await mkdir(localPath('processes'), { recursive: true });
  await mkdir(localPath('logs'), { recursive: true });
  const script = path.join(packageRoot, file);
  const log = await open(paths(name).log, 'a', 0o600);
  const child = spawn(process.execPath, [script, ...args], { cwd: packageRoot, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await writeFile(paths(name).record, JSON.stringify({ name, pid: child.pid, script, startedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  child.unref();
  await log.close();
}
async function stop(name) {
  const record = await readRecord(name);
  if (isAlive(record)) {
    process.kill(record.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 160 && isAlive(record); attempt++) await sleep(250);
    if (isAlive(record)) throw new Error(`${name} has not drained yet; see ${paths(name).log}`);
  }
  await unlink(paths(name).record).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function run(file, args) {
  const child = spawn(process.execPath, [path.join(packageRoot, file), ...args], { cwd: packageRoot, stdio: 'inherit' });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (exit !== 0) throw new Error(`${file} exited ${exit}`);
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 360; attempt++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error(`Service did not become ready at ${url}`);
}
async function down() {
  if (component === 'all' || component === 'finance') await stop('finance');
  if (component === 'all' || component === 'hr') await stop('hr');
  if (component === 'all') {
    await run('scripts/dsh-node.mjs', ['stop', 'finance']);
    await run('scripts/dsh-node.mjs', ['stop', 'hr']);
  }
  if (component === 'all' || component === 'core') await stop('core');
  if (component === 'all') await run('scripts/matrix.mjs', ['down']);
}
async function up() {
  if (component === 'all') await run('scripts/matrix.mjs', ['up']);
  if (component === 'all' || component === 'core') {
    await start('core', 'src/core.mjs');
    await waitFor(`${localCoreUrl}/api/bootstrap`);
  }
  for (const name of ['finance', 'hr']) {
    if (component !== 'all' && component !== name) continue;
    await run('scripts/dsh-node.mjs', ['start', name]);
    await waitFor(`${runtimeSettings(name, { root: packageRoot }).bridgeUrl}/api/ds-group-node/status`);
    await start(name, 'src/bot-node.mjs', ['--bot', name]);
  }
}
if (command === 'down' || command === 'restart') await down();
if (command === 'up' || command === 'restart') await up();
if (command !== 'down') {
  await sleep(500);
  try {
    const response = await fetch(`${coreUrl}/api/status`, { signal: AbortSignal.timeout(2000) });
    const { nodes, budget } = await response.json();
    console.log(JSON.stringify({ url: coreUrl, nodes, generationCalls: budget.used }, null, 2));
  } catch { console.log(JSON.stringify({ core: 'offline' })); }
}
