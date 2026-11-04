#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh, DSH_VERSION, MODEL } from './runtime-config.mjs';

const installation = await resolveDsh();
const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-runtime-smoke-'));
const reportPath = path.resolve(process.env.DS_GROUP_RUNTIME_SMOKE_REPORT || path.join(packageRoot, '.local', 'runtime-smoke.json'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = createNetServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const calls = [];
const core = createServer((request, response) => {
  calls.push({ method: request.method, path: request.url });
  request.resume();
  response.writeHead(403, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'Model generation is disabled in runtime smoke' }));
});
core.listen(0, '127.0.0.1');
await once(core, 'listening');
const coreUrl = `http://127.0.0.1:${core.address().port}`;
const base = `http://127.0.0.1:${port}`;
await writeFile(path.join(directory, 'core-config.json'), JSON.stringify({ nodeSecret: 'synthetic-runtime-smoke', publicUrl: coreUrl }), { mode: 0o600 });
const logPath = path.join(directory, 'host.log');
const log = await open(logPath, 'a', 0o600);
let child;
let childExit;
const env = {
  ...process.env, DS_GROUP_DATA_DIR: directory, DS_GROUP_DSH_CLI: installation.cli,
  DS_GROUP_DSH_RUNTIME: installation.runtime, DS_GROUP_BRIDGE_PORT: String(port),
  DS_GROUP_CORE_CONFIG_PATH: path.join(directory, 'core-config.json'),
  DS_GROUP_DSH_SOURCE_HOME: path.join(directory, 'no-desktop-profile'),
  OPENCODE_API_KEY: 'synthetic-runtime-smoke-never-generate',
};
delete env.DS_GROUP_CORE_URL;
delete env.DS_GROUP_OPENCODE_BASE_URL;

async function start() {
  child = spawn(process.execPath, [path.join(packageRoot, 'scripts', 'dsh-node.mjs'), 'run', 'finance'], {
    cwd: packageRoot, env, stdio: ['ignore', log.fd, log.fd], detached: true,
  });
  childExit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  for (let attempt = 0; attempt < 360; attempt++) {
    if (child.exitCode !== null) throw new Error(`DSH launcher exited ${child.exitCode}; inspect ${logPath}`);
    try {
      const response = await fetch(`${base}/api/ds-group-node/status`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
    } catch {}
    await sleep(500);
  }
  throw new Error(`DSH runtime did not become ready; inspect ${logPath}`);
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([childExit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 40_000); })]);
  clearTimeout(timer);
  if (!result) {
    process.kill(-child.pid, 'SIGKILL');
    await childExit;
    throw new Error(`DSH runtime did not stop gracefully; inspect ${logPath}`);
  }
  assert.equal(result.code, 0, 'foreground launcher should exit successfully after SIGTERM');
  await assert.rejects(fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }));
}
async function createBot() {
  const response = await fetch(`${base}/api/ds-group-node/bots`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: '@finance:runtime-ci.local', name: 'Runtime CI', role: '财务', instructions: '等待明确请求。' }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(result.sessionId);
  return result;
}
const sourceHashes = {};
for (const file of ['scripts/dsh-node.mjs', 'scripts/runtime-config.mjs', 'scripts/runtime-smoke.mjs', 'dsh-plugin/index.mjs', 'dsh-plugin/runtime.mjs']) {
  sourceHashes[file] = createHash('sha256').update(await readFile(path.join(packageRoot, file))).digest('hex');
}
const report = { checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
  expectedDshVersion: DSH_VERSION, installationKind: installation.runtime.includes('app.asar') ? 'desktop-bundled-cli' : 'npm-cli',
  model: `opencode-go/${MODEL}`, level: 'real-native-dsh-zero-model', sourceHashes, checks: {}, status: 'failed' };
try {
  const version = await promisify(execFile)(installation.cli, ['--version'], { env: { ...env, DSH_HOME: path.join(directory, 'version-home') }, timeout: 30_000 });
  report.dshVersion = version.stdout.trim();
  assert.match(report.dshVersion, /^0\.2\.1-rc\.5$/);
  report.checks.pinnedRuntimeVersion = true;
  const initial = await start();
  assert.equal(initial.engineVersion, '0.2.7');
  assert.equal(initial.model, `opencode-go/${MODEL}`);
  report.checks.pluginLoaded = true;
  const catalog = await (await fetch(`${base}/api/ds-group-node/models`)).json();
  assert.deepEqual(catalog.providers.find(provider => provider.id === 'opencode-go')?.models, [MODEL]);
  report.checks.allowedModelCatalog = true;
  const first = await createBot();
  report.checks.nativeSessionCreated = true;
  const config = JSON.parse(await readFile(path.join(directory, 'dsh-finance', 'node-config.json'), 'utf8'));
  assert.equal(config.coreUrl, coreUrl);
  assert.ok(config.dataDir.startsWith(directory + path.sep));
  report.checks.importedRemoteCoreAndPrivateData = true;
  await stop();
  await start();
  const restored = await createBot();
  assert.equal(restored.sessionId, first.sessionId);
  assert.equal(restored.dsBotId, first.dsBotId);
  report.checks.sessionIdentityAfterRestart = true;
  await stop();
  report.checks.gracefulStop = true;
  assert.deepEqual(calls, []);
  report.checks.zeroModelClaims = true;
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  report.diagnosticDirectory = directory;
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { report.cleanupError = error.message; process.exitCode = 1; report.status = 'failed'; }
  await log.close();
  await new Promise(resolve => core.close(resolve));
  report.modelCalls = calls.length;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
