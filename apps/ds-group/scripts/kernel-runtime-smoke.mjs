#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';
import { DSH_VERSION, resolveDsh } from './runtime-config.mjs';

// A real, isolated DSH host. The only configured provider refuses every request.
const installation = await resolveDsh();
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-smoke-')));
const home = path.join(directory, 'home');
const botHome = path.join(home, 'bot');
const profile = path.join(home, 'profiles/web');
const dependencies = path.join(directory, 'dependencies');
const reportPath = path.resolve(process.env.DS_GROUP_KERNEL_SMOKE_REPORT || path.join(packageRoot, '.local/kernel-runtime-smoke.json'));
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  node: process.version, expectedDshVersion: DSH_VERSION, level: 'real-native-dsh-owned-kernel-zero-model',
  status: 'failed', checks: [], modelCalls: 0, sourceHashes: {} };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const calls = [];
const provider = createServer((request, response) => {
  calls.push({ method: request.method, path: request.url });
  request.resume();
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end('{"error":"This zero-model host cannot generate."}');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
let child, exited, log, cookie, base;

const env = {
  PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
  DS_GROUP_DSH_RUNTIME: installation.runtime, DS_GROUP_RUNTIME_DEPS_DIR: dependencies,
};

async function api(endpoint, payload = {}, route = '/api/dscord/kernel') {
  if (!cookie) {
    const output = await readFile(path.join(directory, 'host.log'), 'utf8');
    const url = output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
    if (!url) throw new Error('Waiting for DSH launch authentication');
    const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    cookie = exchange.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'DSH did not issue an authenticated browser session');
    base = new URL(url).origin;
  }
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${route} is unavailable`);
  const result = await response.json();
  assert.equal(result.ok, true, result.error?.message);
  return result.value;
}

async function start() {
  cookie = undefined;
  log = await open(path.join(directory, 'host.log'), 'w', 0o600);
  child = spawn(installation.cli, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: directory, detached: true, stdio: ['ignore', log.fd, log.fd], env,
  });
  exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated DSH exited before kernel readiness (${child.exitCode ?? child.signalCode})`);
    try { return await api('kernel-info'); } catch { await sleep(500); }
  }
  throw new Error('The owned kernel did not become ready in the isolated DSH host');
}

async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 40_000); })]);
  clearTimeout(timer);
  if (!result) { process.kill(-child.pid, 'SIGKILL'); await exited; throw new Error('Isolated DSH did not stop gracefully'); }
  await log.close();
  child = undefined;
  const lifecycle = JSON.parse(await readFile(path.join(botHome, 'dscord-kernel.json'), 'utf8'));
  assert.equal(lifecycle.status, 'stopped', 'The owned kernel must release its lifecycle before DSH exits');
  return lifecycle;
}

function kernelInfo(value) {
  const runtime = value.runtime;
  assert.equal(runtime.id, 'dscord-kernel');
  assert.equal(runtime.version, '0.4.0');
  assert.equal(runtime.upstreamVersion, '0.3.1');
  assert.equal(runtime.apiVersion, 1);
  assert.equal(runtime.api, '/api/dscord/kernel');
  assert.equal(runtime.status, 'running');
  assert.equal(runtime.hostCompatibility.minimum, DSH_VERSION);
  assert.equal(path.resolve(runtime.home), path.resolve(botHome));
  assert.match(runtime.memoryBackend, /^source-aware(?:-|$)/);
  assert.ok(runtime.instanceId);
  return runtime;
}

try {
  for (const filename of ['package.json', 'vendor/ds-bot/UPSTREAM.json', 'dsh-connect/index.mjs', 'dsh-connect/native-team.mjs',
    'dsh-connect/kernel-runtime.mjs', 'dsh-plugin/index.mjs', 'dsh-plugin/runtime-dependencies.json', 'scripts/kernel-runtime-smoke.mjs']) {
    report.sourceHashes[filename] = hash(await readFile(path.join(packageRoot, filename)));
  }
  const version = await promisify(execFile)(installation.cli, ['--version'], { env, timeout: 30_000 });
  report.dshVersion = version.stdout.trim();
  assert.equal(report.dshVersion, DSH_VERSION);
  await prepareRuntimeDependencies({ directory: dependencies, plugin: path.join(packageRoot, 'dsh-plugin'), runtime: installation.runtime });
  report.checks.push('pinnedHostAndLockedPrivateDependencies');
  await mkdir(profile, { recursive: true });
  const probe = path.join(directory, 'conflict-probe.mjs');
  await writeFile(probe, `import { startNativeTeam } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dsh-connect/native-team.mjs')).href)};
export { inject } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dsh-connect/index.mjs')).href)};
export async function apply(ctx) {
 ctx.effect(() => ctx.connection.fetch.register({ path:'/api/dscord-kernel-ci', methods:['POST'], requestBody:'buffered', async fetch(request) {
  await request.json();
  try { await startNativeTeam(ctx); return Response.json({ok:true,value:{started:true}}); }
  catch(error) { return Response.json({ok:true,value:{started:false,code:error.code}}); }
 }}));
}`);
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dscord-kernel-zero-model', private: true, type: 'module',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
  await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { 'kernel-zero-model': { api: 'openai-completions', baseURL: providerUrl,
      apiKeyEnv: 'SYNTHETIC_KERNEL_KEY', models: [{ id: 'blocked' }] } } } },
    { id: 'agent-default-model', config: { provider: 'kernel-zero-model', model: 'blocked' } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: false } },
    { insert: [
      { id: 'dscord-connect', name: path.join(packageRoot, 'dsh-connect/index.mjs'), config: { dataDirectory: path.join(directory, 'connection') } },
      { id: 'dscord-kernel-ci', name: probe },
    ] },
  ]));
  await writeFile(path.join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { SYNTHETIC_KERNEL_KEY: 'synthetic-never-generate' }, records: {} }), { mode: 0o600 });
  const first = kernelInfo(await start());
  report.runtime = { id: first.id, version: first.version, upstreamVersion: first.upstreamVersion, apiVersion: first.apiVersion };
  const firstState = await api('state');
  assert.deepEqual(firstState.bots, []);
  assert.deepEqual(firstState.mainBotIds, []);
  assert.equal(kernelInfo(firstState).instanceId, first.instanceId);
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(kernelInfo(await api('kernel-info')).instanceId, first.instanceId);
  report.checks.push('ownedVersionedApi', 'pureHealthAndStateDoNotBootstrapBots');
  const conflict = await api('claim', {}, '/api/dscord-kernel-ci');
  assert.deepEqual(conflict, { started: false, code: 'DSCORD_KERNEL_CONFLICT' });
  assert.equal(kernelInfo(await api('kernel-info')).instanceId, first.instanceId);
  report.checks.push('duplicateSameHomeRuntimeRejectedAndFirstOwnerRetained');
  const lifecycle = await stop();
  assert.equal(lifecycle.instanceId, first.instanceId);
  const second = kernelInfo(await start());
  assert.notEqual(second.instanceId, first.instanceId);
  assert.equal(second.home, first.home);
  assert.deepEqual(second.adoption, first.adoption);
  assert.deepEqual((await api('state')).bots, []);
  await stop();
  report.checks.push('gracefulOwnerReleaseAndSameHomeRestart', 'healthDoesNotCreateBotsAfterRestart');
  assert.deepEqual(calls, []);
  for (const [filename, sha256] of Object.entries(report.sourceHashes)) assert.equal(hash(await readFile(path.join(packageRoot, filename))), sha256);
  report.checks.push('zeroProviderRequests', 'sourceFilesUnmodified');
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  report.diagnosticDirectory = directory;
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { report.cleanupError = error.message; report.status = 'failed'; process.exitCode = 1; }
  await new Promise(resolve => provider.close(resolve));
  report.modelCalls = calls.length;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
