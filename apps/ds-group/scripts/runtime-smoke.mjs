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
async function createBot(instructions = '等待明确请求。') {
  const response = await fetch(`${base}/api/ds-group-node/bots`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botId: '@finance:runtime-ci.local', name: 'Runtime CI', role: '财务', instructions }),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.ok(result.sessionId);
  return result;
}
const sourceHashes = {};
for (const file of ['src/model-config.mjs', 'dsh-plugin/model-profile.mjs', 'scripts/dsh-node.mjs', 'scripts/runtime-config.mjs', 'scripts/runtime-smoke.mjs', 'dsh-plugin/index.mjs', 'dsh-plugin/runtime.mjs']) {
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
  const bridgeStatePath = path.join(config.dataDir, 'node-state.json');
  const bridgeState = JSON.parse(await readFile(bridgeStatePath, 'utf8'));
  bridgeState.schemaVersion = 1;
  bridgeState.requests['legacy-running'] = { requestId: 'legacy-running', botId: first.botId,
    inputHash: 'synthetic-interrupted-request', status: 'running' };
  await writeFile(bridgeStatePath, JSON.stringify(bridgeState));
  const botStatePath = path.join(config.dataDir, 'ds-bot', 'state.json');
  const botState = JSON.parse(await readFile(botStatePath, 'utf8'));
  botState.bots[first.dsBotId].instructions = 'LEGACY_NO_TOOLS_SYNTHETIC_MIGRATION';
  await writeFile(botStatePath, JSON.stringify(botState));
  await start();
  const restored = await createBot('UPDATED_NATIVE_FILE_WORK_INSTRUCTIONS');
  assert.equal(restored.sessionId, first.sessionId);
  assert.equal(restored.dsBotId, first.dsBotId);
  report.checks.sessionIdentityAfterRestart = true;
  const updated = JSON.parse(await readFile(botStatePath, 'utf8')).bots[first.dsBotId];
  assert.ok(updated.instructions.includes('UPDATED_NATIVE_FILE_WORK_INSTRUCTIONS'));
  assert.equal(updated.instructions.includes('LEGACY_NO_TOOLS_SYNTHETIC_MIGRATION'), false);
  assert.ok(restored.tools.includes('read') && restored.tools.includes('bash'));
  assert.equal(JSON.parse(await readFile(bridgeStatePath, 'utf8')).schemaVersion, 2);
  report.checks.legacyIdentityAndInstructionsMigrated = true;
  const interrupted = await (await fetch(`${base}/api/ds-group-node/turns/legacy-running`)).json();
  assert.equal(interrupted.status, 'unknown');
  assert.equal(interrupted.errorCode, 'NODE_RESTARTED_DURING_REQUEST');
  report.checks.interruptedRequestIsNotReplayed = true;
  await stop();
  const sourceHome = path.join(directory, 'source');
  const sourceProfile = path.join(sourceHome, 'profiles', 'desktop');
  await mkdir(sourceProfile, { recursive: true });
  const sourceFiles = {
    'profiles/desktop/package.json': JSON.stringify({ name: 'synthetic-source', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    'profiles/desktop/cordis.patch.yml': JSON.stringify([
      { id: 'llm-pi-ai', config: { providers: {
        'sample-route': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'SYNTHETIC_MODEL_KEY',
          models: [{ id: 'team/chat' }, { id: 'second' }], retryPolicy: { mode: 'normal', maxRetries: 2 }, headers: { 'X-Test': 'keep' } },
        'opencode-go': { apiKeyEnv: 'SYNTHETIC_MODEL_KEY', modelOverrides: { [MODEL]: { contextWindow: 131072 } } },
      } } },
      { id: 'agent-default-model', config: { provider: 'sample-route', model: 'second' } },
    ]),
    '.credentials.yaml': JSON.stringify({ version: 1, refs: { SYNTHETIC_MODEL_KEY: 'synthetic-zero-model', UNRELATED_SECRET: 'do-not-copy' }, records: {} }),
  };
  for (const [name, content] of Object.entries(sourceFiles)) await writeFile(path.join(sourceHome, name), content, { mode: 0o600 });
  delete env.OPENCODE_API_KEY;
  env.DS_GROUP_DSH_SOURCE_HOME = sourceHome;
  env.DS_GROUP_MODEL = 'sample-route/team/chat';
  const alternate = await start();
  assert.equal(alternate.model, env.DS_GROUP_MODEL);
  const changed = await createBot();
  assert.equal(changed.sessionId, first.sessionId);
  assert.equal(changed.dsBotId, first.dsBotId);
  assert.equal(changed.model, env.DS_GROUP_MODEL);
  await stop();
  report.checks.customProviderAndNamespacedModelReuseNativeIdentity = true;
  const preparedPath = path.join(config.home, 'profiles/web/cordis.patch.yml');
  let prepared = await readFile(preparedPath, 'utf8');
  assert.match(prepared, /maxRetries: 2/);
  assert.match(prepared, /X-Test: keep/);
  assert.match(prepared, /id: second/);
  assert.equal((await readFile(path.join(config.home, '.credentials.yaml'), 'utf8')).includes('UNRELATED_SECRET'), false);
  report.checks.sourceProviderSettingsPreservedAndCredentialScoped = true;
  delete env.DS_GROUP_MODEL;
  assert.equal((await start()).model, 'sample-route/team/chat', 'the saved node choice wins over a changed source default');
  await stop();
  report.checks.savedModelSurvivesSourceDefaultChange = true;
  env.DS_GROUP_MODEL = `opencode-go/${MODEL}`;
  assert.equal((await start()).model, env.DS_GROUP_MODEL);
  assert.equal((await createBot()).sessionId, first.sessionId);
  await stop();
  prepared = await readFile(preparedPath, 'utf8');
  assert.match(prepared, /modelOverrides:/);
  assert.match(prepared, /contextWindow: 131072/);
  report.checks.nativeModelOverridesPreserved = true;
  const previousConfig = await readFile(path.join(directory, 'dsh-finance/node-config.json'), 'utf8');
  async function rejectedPrepare() {
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(packageRoot, 'scripts/dsh-node.mjs'), 'prepare', 'finance'],
      { env, timeout: 30_000 }));
    assert.equal(await readFile(preparedPath, 'utf8'), prepared);
    assert.equal(await readFile(path.join(directory, 'dsh-finance/node-config.json'), 'utf8'), previousConfig);
  }
  env.DS_GROUP_MODEL = 'sample-route/absent';
  await rejectedPrepare();
  report.checks.invalidConfiguredModelRejectedWithoutProfileWrite = true;
  env.DS_GROUP_MODEL = 'sample-route/second';
  await writeFile(path.join(sourceHome, '.credentials.yaml'), JSON.stringify({ version: 1, refs: {}, records: {} }));
  await rejectedPrepare();
  await writeFile(path.join(sourceHome, '.credentials.yaml'), sourceFiles['.credentials.yaml']);
  report.checks.missingCredentialRejectedWithoutProfileWrite = true;
  for (const [name, content] of Object.entries(sourceFiles)) assert.equal(await readFile(path.join(sourceHome, name), 'utf8'), content);
  report.checks.sourceProfileAndCredentialsUnmodified = true;
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
