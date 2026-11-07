#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from '../scripts/runtime-config.mjs';

// Actual DSH processes and the product HTTP bridge; only the provider is scripted.
const installation = await resolveDsh();
const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-native-node-'));
const reportPath = path.resolve(process.env.DSCORD_NATIVE_NODE_REPORT || path.join(packageRoot, '.local/runtime-native-host.json'));
const report = { level: 'real-dsh-standalone-native-scripted-provider', checkedAt: new Date().toISOString(),
  dsh: installation.runtime, remoteModelCalls: 0, checks: [], status: 'failed' };
report.sourceHashes = {};
for (const filename of ['dsh-plugin/runtime.mjs', 'dsh-connect/native-team.mjs', 'dsh-connect/native-bridge.mjs',
  'memory/native.mjs', 'tests/runtime-native.host.mjs']) {
  report.sourceHashes[filename] = createHash('sha256').update(await readFile(path.join(packageRoot, filename))).digest('hex');
}
const providerCalls = [], ledgerCalls = [];
const provider = createServer(async (request, response) => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (request.url.startsWith('/internal/model/')) { ledgerCalls.push(request.url); throw new Error('Native requests must not use legacy task claims'); }
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(input.model, 'chat');
    const memory = JSON.stringify(input.messages).includes('Maintain this Bot\u0027s durable source-aware memories');
    providerCalls.push({ kind: memory ? 'memory' : 'generation', tools: input.tools?.map(tool => tool.function.name) || [] });
    if (!memory) for (const tool of ['create_bot', 'message_bot', 'remember', 'recall']) {
      assert.ok(providerCalls.at(-1).tools.includes(tool), `Native tool ${tool} was filtered out`);
    }
    const text = memory ? '{"changes":[]}' : 'Native response from the owned kernel.';
    const chunk = delta => ({ id: `scripted-${providerCalls.length}`, object: 'chat.completion.chunk', created: 1, model: input.model,
      choices: [{ index: 0, delta, finish_reason: null }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: text }))}\n\n`);
    const finish = chunk({}); finish.choices[0].finish_reason = 'stop';
    finish.usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
    response.end(`data: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
  } catch (error) { report.providerError = error.message; response.writeHead(500); response.end('{}'); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const origin = `http://127.0.0.1:${provider.address().port}`;
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const sourceHome = path.join(directory, 'source'), sourceProfile = path.join(sourceHome, 'profiles/desktop');
await mkdir(sourceProfile, { recursive: true });
await writeFile(path.join(sourceProfile, 'package.json'), JSON.stringify({ name: 'standalone-synthetic', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
await writeFile(path.join(sourceProfile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'llm-pi-ai', config: { providers: { 'standalone-fixture': { api: 'openai-completions', baseURL: `${origin}/v1`,
    models: [{ id: 'chat' }], apiKeyEnv: 'SYNTHETIC_KEY' } } } },
  { id: 'agent-default-model', config: { provider: 'standalone-fixture', model: 'chat' } },
]));
await writeFile(path.join(sourceHome, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { SYNTHETIC_KEY: 'synthetic-never-remote' }, records: {} }), { mode: 0o600 });
const coreConfigPath = path.join(directory, 'core-config.json');
await writeFile(coreConfigPath, JSON.stringify({ nodeSecret: 'synthetic-node', publicUrl: origin }), { mode: 0o600 });
const log = await open(path.join(directory, 'host.log'), 'a', 0o600);
const env = { ...process.env, DS_GROUP_DSH_CLI: installation.cli, DS_GROUP_DSH_RUNTIME: installation.runtime,
  DS_GROUP_DATA_DIR: directory, DS_GROUP_CORE_CONFIG_PATH: coreConfigPath, DS_GROUP_CORE_URL: origin,
  DS_GROUP_BRIDGE_PORT: String(port), DS_GROUP_MODEL: 'standalone-fixture/chat',
  DS_GROUP_DSH_SOURCE_HOME: sourceHome, DS_GROUP_DSH_SOURCE_PROFILE: 'desktop' };
delete env.OPENCODE_API_KEY;
let child, exited;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, input) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ds-group-node${route}`, {
    method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10000),
  });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function start() {
  child = spawn(process.execPath, [path.join(packageRoot, 'scripts/dsh-node.mjs'), 'run', 'finance'], {
    cwd: packageRoot, env, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null) throw new Error(`DSH exited ${child.exitCode}`);
    try { return await api('/status'); } catch { await sleep(500); }
  }
  throw new Error('Standalone native DSH did not become ready');
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM'); let timer;
  const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); })]);
  clearTimeout(timer);
  if (!result) { process.kill(-child.pid, 'SIGKILL'); await exited; throw new Error('DSH did not stop gracefully'); }
  assert.equal(result.code, 0);
}
const create = botId => api('/bots', { botId, name: 'Same display name', role: 'Assistant', mode: 'native',
  ownerId: '@owner:local.test', instructions: 'Answer the current person and retain exact source identities.' });
const turnInput = (botId, requestId) => ({ botId, requestId, async: true,
  event: { eventId: `$${requestId}`, roomId: '!native:local.test', senderId: '@alice:local.test', senderName: 'Alice', senderKind: 'human', body: 'Reply briefly.' } });
async function finish(input) {
  let receipt = await api('/turns', input);
  for (let n = 0; n < 120 && ['queued', 'running'].includes(receipt.status); n++) { await sleep(250); receipt = await api(`/turns/${input.requestId}`); }
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt)); return receipt;
}
try {
  const initial = await start(); assert.equal(initial.runtime.id, 'dscord-kernel'); assert.equal(initial.runtime.apiVersion, 1);
  const one = await create('@one:local.test'), two = await create('@two:local.test');
  assert.notEqual(one.dsBotId, two.dsBotId); assert.notEqual(one.sessionId, two.sessionId);
  assert.ok(one.tools.includes('remember') && two.tools.includes('message_bot'));
  report.checks.push('nativeMembersRetainSeparateIdentitiesAndCompleteTools');
  const observation = { botId: one.botId, events: [{ event_id: '$background', room_id: '!native:local.test', sender: '@alice:local.test',
    origin_server_ts: Date.now(), content: { body: 'This is a room observation.' } }],
    participants: [{ id: '@alice:local.test', name: 'Alice', kind: 'human' }], rooms: { '!native:local.test': { name: 'Native room' } },
    watermark: { sequence: 1, eventId: '$background', roomId: '!native:local.test' } };
  await api('/observe', observation);
  const view = await api('/attention/view', { botId: one.botId, roomId: '!native:local.test', recentMessages: [], watermark: observation.watermark });
  assert.equal(view.self.nativeBotId, one.dsBotId); assert.equal(view.self.ownerId, '@owner:local.test');
  await api('/memory/profiles', { botId: one.botId }); await api('/memory/profile', { botId: one.botId, kind: 'person', id: '@alice:local.test' });
  assert.equal(providerCalls.filter(call => call.kind === 'generation').length, 0);
  report.checks.push('backgroundObservationAndViewsDoNotSendAUserTurn');
  const input = turnInput(one.botId, 'native-once'), receipt = await finish(input);
  assert.equal(receipt.text, 'Native response from the owned kernel.'); assert.equal(receipt.mode, 'native');
  assert.equal(receipt.usage.complete, false); assert.equal(ledgerCalls.length, 0);
  report.checks.push('nativeRequestRunsWithOriginalToolsAndIndependentUsage');
  for (let n = 0; n < 80 && !providerCalls.some(call => call.kind === 'memory'); n++) await sleep(100);
  assert.ok(providerCalls.some(call => call.kind === 'memory'), 'Native automatic memory review did not reach its provider');
  const nodeStatus = await api('/status');
  assert.ok(nodeStatus.nativeUsage.observedCalls >= 2); assert.equal(nodeStatus.nativeUsage.complete, false);
  report.checks.push('nativeAutomaticMemoryReviewRetainsItsOwnObservedStream');
  const generated = providerCalls.filter(call => call.kind === 'generation').length;
  assert.equal((await api('/turns', input)).duplicate, true);
  await finish(turnInput(two.botId, 'native-two'));
  assert.equal(providerCalls.filter(call => call.kind === 'generation').length, generated + 1);
  await stop(); await start();
  const restored = await create(one.botId); assert.equal(restored.dsBotId, one.dsBotId); assert.equal(restored.sessionId, one.sessionId);
  assert.equal((await api('/turns', input)).duplicate, true);
  assert.equal(providerCalls.filter(call => call.kind === 'generation').length, generated + 1);
  report.checks.push('restartKeepsNativeIdentityAndDoesNotReplayCompletedWork');
  report.status = 'passed';
} catch (error) { report.error = error.message; report.diagnosticDirectory = directory; process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { report.stopError = error.message; report.status = 'failed'; process.exitCode = 1; }
  await log.close(); await new Promise(resolve => provider.close(resolve));
  report.providerCalls = providerCalls; report.legacyClaimCalls = ledgerCalls.length;
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error, report: reportPath, scriptedProviderCalls: providerCalls.length, remoteModelCalls: 0 }));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
