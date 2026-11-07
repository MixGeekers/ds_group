#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../src/paths.mjs';
import { prepareRuntimeDependencies } from '../scripts/runtime-dependencies.mjs';
import { DSH_VERSION, resolveDsh } from '../scripts/runtime-config.mjs';

// Only the provider is scripted. The Session, persistence, loop, compaction,
// native tools, API, lifecycle and restore run in a real isolated DSH process.
const installation = await resolveDsh();
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dscord-memory-surface-')));
const home = path.join(directory, 'home'), profile = path.join(home, 'profiles/web');
const workspace = path.join(directory, 'workspace'), dependencies = path.join(directory, 'dependencies');
const reportPath = path.resolve(process.env.DSCORD_SNAPSHOT_REPORT ?? path.join(packageRoot, '.local/memory-snapshot-host.json'));
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), level: 'real-dsh-local-scripted-provider',
  dshVersion: DSH_VERSION, status: 'failed', remoteModelCalls: 0, checks: [], sourceHashes: {}, limitations: [
    'A continuing external CLI may retain previously submitted text in its own private history; this verifies native derived requests and fresh CLI replay.',
    'Scripted provider output proves request composition and lifecycle, not remote model reasoning quality.',
  ] };
const calls = [], requests = [];
const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
let toolUsed = false;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const bytes of request) body += bytes;
    const input = JSON.parse(body); assert.equal(input.model, 'chat'); requests.push(input);
    const text = input.messages.map(textOf).join('\n');
    assert.equal(text.includes('obsolete-derived-view-'), false, 'A historical/attention view reached the provider');
    const snapshots = input.messages.map(textOf).filter(value => value.startsWith('Current memory source context (') || value.startsWith('Seed snapshot '));
    const checkpoint = text.includes('You are now writing a checkpoint of this conversation.');
    const steward = text.includes("You are the context steward of an AI assistant's long-running conversation.");
    const useTool = !checkpoint && !toolUsed && text.includes('human-two-tool');
    if (useTool) toolUsed = true;
    calls.push({ index: calls.length + 1, checkpoint, steward, snapshots, messageCount: input.messages.length,
      toolResults: input.messages.filter(message => message.role === 'tool').map(textOf),
      hasHumanOne: text.includes('human-one-history'), hasPeer: text.includes('peer-relay-history'), hasHumanTwo: text.includes('human-two-tool'),
      toolNames: input.tools?.map(tool => tool.function.name) ?? [] });
    const chunk = delta => ({ id: `snapshot-${calls.length}`, object: 'chat.completion.chunk', created: 1, model: 'chat', choices: [{ index: 0, delta, finish_reason: null }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'snapshot-file-read', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ file_path: path.join(workspace, 'evidence.txt') }) } }] }
      : { role: 'assistant', content: steward ? '{"action":"compact","reason":"The synthetic work continues."}'
        : checkpoint ? 'Synthetic checkpoint: human-one-history, peer-relay-history, human-two-tool; actual tool evidence retained.' : 'Acknowledged current request.' };
    response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    const finish = chunk({}); finish.choices[0].finish_reason = useTool ? 'tool_calls' : 'stop';
    finish.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    response.end(`data: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
  } catch (error) { report.providerError = error.stack; response.writeHead(500); response.end('{}'); }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const env = { PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DS_GROUP_DSH_RUNTIME: installation.runtime, DS_GROUP_RUNTIME_DEPS_DIR: dependencies };
let child, exited, log, cookie, base, boot = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(action, input = {}) {
  if (!cookie) {
    const output = await readFile(path.join(directory, `host-${boot}.log`), 'utf8');
    const url = output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
    if (!url) throw new Error('Waiting for DSH launch authentication');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); base = new URL(url).origin;
  }
  const response = await fetch(`${base}/api/memory-snapshot-test`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...input }), signal: AbortSignal.timeout(45000) });
  const result = await response.json(); assert.equal(result.ok, true, result.error); return result.value;
}
async function start() {
  cookie = undefined; boot++;
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  log = await open(path.join(directory, `host-${boot}.log`), 'w', 0o600);
  child = spawn(installation.cli, ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: directory, env, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Isolated DSH stopped before readiness');
    try { return await api('init'); } catch (error) {
      const output = await readFile(path.join(directory, `host-${boot}.log`), 'utf8');
      if (/ERR_MODULE_NOT_FOUND|JsonSchemaError/.test(output)) throw new Error(`Host could not load snapshot helper: ${error.message}`);
      await sleep(500);
    }
  }
  throw new Error('Isolated DSH did not become ready');
}
async function stop() {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timer;
  const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 30000); })]); clearTimeout(timer);
  if (!result) { process.kill(-child.pid, 'SIGKILL'); await exited; throw new Error('Isolated DSH did not stop gracefully'); }
  assert.equal(result.code, 0); await log.close(); child = undefined;
  assert.equal(JSON.parse(await readFile(path.join(home, 'bot/dscord-kernel.json'), 'utf8')).status, 'stopped');
}
const oneFrame = value => assert.equal(value.activeSnapshots.length, 1);
const sourceOf = value => JSON.parse(value.activeSnapshots[0].text.split('\n').slice(1).join('\n'));
try {
  for (const file of ['memory/native.mjs', 'memory/snapshot-context.mjs', 'src/native-request.mjs', 'src/message-context.mjs', 'dsh-connect/native-team.mjs', 'vendor/ds-bot/src/host/parts.js',
    'dsh-plugin/runtime-dependencies.json', 'tests/fixtures/memory-snapshot-host.mjs', 'tests/memory-snapshot.runtime.mjs']) {
    report.sourceHashes[file] = createHash('sha256').update(await readFile(path.join(packageRoot, file))).digest('hex');
  }
  await prepareRuntimeDependencies({ directory: dependencies, plugin: path.join(packageRoot, 'dsh-plugin'), runtime: installation.runtime });
  await mkdir(profile, { recursive: true }); await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'evidence.txt'), 'tool-file-history-proof\n');
  const probe = path.join(directory, 'snapshot-loader.mjs');
  await writeFile(probe, `import {readFileSync} from 'node:fs';
import {registerRuntimeResolution} from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dsh-plugin/index.mjs')).href)};
registerRuntimeResolution({project:${JSON.stringify(pathToFileURL(packageRoot).href + '/')},anchor:${JSON.stringify(pathToFileURL(path.join(installation.runtime, 'package.json')).href)},dependencyAnchor:${JSON.stringify(pathToFileURL(path.join(dependencies, 'package.json')).href)},dependencies:JSON.parse(readFileSync(${JSON.stringify(path.join(packageRoot, 'dsh-plugin/runtime-dependencies.json'))},'utf8')).dependencies});
const plugin=await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'tests/fixtures/memory-snapshot-host.mjs')).href)});
export const inject=plugin.inject; export const apply=plugin.apply;
`);
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'memory-snapshot-synthetic', private: true, type: 'module',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
  await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { 'snapshot-fixture': { api: 'openai-completions', baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
      apiKeyEnv: 'SNAPSHOT_SYNTHETIC_KEY', models: [{ id: 'chat', contextWindow: 100000 }] } } } },
    { id: 'agent-default-model', config: { provider: 'snapshot-fixture', model: 'chat' } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: false } },
    { insert: [{ id: 'memory-snapshot-probe', name: probe, config: { botHome: path.join(home, 'bot'), workspace } }] },
  ]));
  await writeFile(path.join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { SNAPSHOT_SYNTHETIC_KEY: 'synthetic-localhost-only' }, records: {} }), { mode: 0o600 });
  const { bot, peer } = await start(); report.botId = bot.id;
  const turn = async (requestId, text, senderId = '@alice:snapshot.local', roomId = '!north:snapshot.local') => {
    const before = calls.length, state = await api('turn', { botId: bot.id, requestId, text, senderId, roomId });
    for (const call of calls.slice(before).filter(call => !call.steward && !call.checkpoint)) {
      assert.equal(call.snapshots.length, 1);
      const snapshot = JSON.parse(call.snapshots[0].split('\n').slice(1).join('\n'));
      assert.equal(snapshot.authorId, `matrix:${senderId}`); assert.equal(snapshot.roomId, roomId);
    }
    return state;
  };
  let state = await turn('human-one', 'human-one-history'); oneFrame(state); const sessionId = state.sessionId;
  state = await api('legacy-request', { botId: bot.id });
  const rawLegacy = state.rawRequests.find(row => row.requestId === 'legacy-view-request'); assert.ok(rawLegacy);
  await stop(); await start();
  state = await api('relay', { botId: bot.id, peerId: peer.id, text: 'peer-relay-history' }); oneFrame(state);
  const legacy = state.requestEnvelopes.find(row => row.requestId === 'legacy-view-request');
  assert.ok(legacy); assert.equal(Object.hasOwn(legacy, 'memoryView'), false); assert.equal(Object.hasOwn(legacy.context.attention, 'memoryView'), false);
  assert.equal(legacy.currentMessage.body, 'legacy-human-history-proof');
  assert.deepEqual(state.rawRequests.find(row => row.requestId === rawLegacy.requestId), rawLegacy);
  assert.ok(state.historyReplays.every(text => !text.includes('obsolete-derived-view-')));
  report.checks.push('restoredLegacyRequestViewsProjectWithoutChangingOriginalEventsOrReplayHistory');
  state = await turn('human-two', 'human-two-tool', '@bob:snapshot.local', '!south:snapshot.local'); oneFrame(state);
  assert.ok(state.toolResults.some(result => result.text.includes('tool-file-history-proof')));
  assert.equal(state.humanMessages.length, 3); assert.equal(state.botMessages.length, 1);
  state = await turn('human-three', 'human-three-history'); oneFrame(state);
  const beforeRestart = state.rawSnapshots;
  report.checks.push('oneActiveSnapshotAcrossHumanBotAndToolSteps', 'firstRequestUsesItsActualClaimedAuthorAndRoom', 'realReadToolPairAndOriginalSpeakersRetained');
  await stop(); await start();
  state = await api('inspect', { botId: bot.id }); oneFrame(state); assert.equal(state.sessionId, sessionId);
  assert.deepEqual(state.rawSnapshots, beforeRestart);
  report.checks.push('sameNativeSessionColdRestoreWithUnchangedRawSnapshotEvents');
  // Simulate an upgraded home containing the previously observed 53-frame bloat.
  state = await api('seed', { botId: bot.id, count: 53, chars: 9000 }); assert.equal(state.activeSnapshots.length, 54);
  state = await api('legacy-request', { botId: bot.id, requestId: 'legacy-before-checkpoint', body: 'Original history before explicit checkpoint.' });
  const rawBeforeCheckpoint = state.rawRequests.find(row => row.requestId === 'legacy-before-checkpoint');
  const seeded = state.rawSnapshots, maintenanceStart = calls.length;
  report.contextEstimates = { beforeManualCheckpoint: state.contextTokens };
  state = await api('checkpoint', { botId: bot.id }); assert.equal(state.checkpointed, true);
  report.contextEstimates.afterManualCheckpoint = state.contextTokens;
  assert.ok(state.contextTokens < report.contextEstimates.beforeManualCheckpoint / 2);
  assert.equal(state.sessionId, sessionId);
  assert.ok(calls.length > maintenanceStart, 'Explicit checkpoint did not reach the real native summarizer');
  for (const call of calls.slice(maintenanceStart)) {
    assert.ok(call.snapshots.length <= 1, 'Manual checkpoint received obsolete knowledge snapshots');
    assert.ok(!call.snapshots.some(text => /^Seed snapshot (?:[0-9]|[1-4][0-9]|5[01]):/.test(text)));
  }
  assert.deepEqual(state.rawSnapshots.slice(0, seeded.length), seeded);
  assert.deepEqual(state.rawRequests.find(row => row.requestId === rawLegacy.requestId), rawLegacy);
  assert.deepEqual(state.rawRequests.find(row => row.requestId === rawBeforeCheckpoint.requestId), rawBeforeCheckpoint);
  assert.ok(state.historyReplays.every(text => !text.includes('obsolete-derived-view-')));
  report.checks.push('manualCheckpointPrunesOldHomeSnapshotsBeforeItsFirstNewTurn');
  state = await turn('human-four', 'human-four-after-checkpoint', '@bob:snapshot.local', '!south:snapshot.local'); oneFrame(state);
  assert.equal(state.sessionId, sessionId); assert.deepEqual(state.rawSnapshots.slice(0, seeded.length), seeded);
  const active = sourceOf(state); report.finalSnapshotSource = { roomId: active.roomId, authorId: active.authorId, speaker: active.speaker };
  const prior = state.rawSnapshots;
  await stop(); await start(); state = await api('inspect', { botId: bot.id }); oneFrame(state);
  assert.equal(state.sessionId, sessionId); assert.deepEqual(state.rawSnapshots, prior);
  assert.ok(state.humanMessages.some(message => message.text === 'human-one-history'));
  assert.ok(state.toolResults.some(result => result.text.includes('tool-file-history-proof')));
  assert.ok(state.botMessages.some(message => message.text.includes('peer-relay-history')));
  assert.ok(state.retired.length >= 53);
  report.checks.push('checkpointRestoreRetainsOriginalHumanToolAndDelegationEvents');
  for (const call of calls.filter(call => !call.checkpoint && !call.steward)) assert.equal(call.snapshots.length, 1, `Request ${call.index} has ${call.snapshots.length} snapshots`);
  report.rawSnapshotCount = state.rawSnapshots.length; report.retirementCount = state.retired.length;
  report.nativeSessionId = sessionId;
  const pressure = await api('pressure', { botId: bot.id }), autoStart = calls.length;
  report.contextEstimates.beforeAutomaticCheckpoint = pressure.contextTokens;
  assert.ok(pressure.contextTokens > 100000, 'Synthetic pressure did not reach the configured native window');
  state = await turn('human-five', 'Continue the same source work after automatic compaction.', '@bob:snapshot.local', '!south:snapshot.local');
  oneFrame(state); assert.equal(state.sessionId, sessionId);
  report.contextEstimates.afterAutomaticCheckpoint = state.contextTokens;
  assert.ok(calls.slice(autoStart).some(call => call.steward), 'The native pressure steward did not run');
  assert.ok(calls.slice(autoStart).some(call => call.checkpoint), 'The native automatic checkpoint did not run');
  report.checks.push('nativeAutomaticPressureCompactionRetainsOneCurrentFrameAndTheSameSession');
  state = await api('held-part', { botId: bot.id }); oneFrame(state);
  assert.notEqual(state.sessionId, sessionId); assert.equal(state.previousSessionId, sessionId);
  const transferred = sourceOf(state);
  assert.equal(transferred.authorId, 'matrix:@bob:snapshot.local'); assert.equal(transferred.roomId, '!south:snapshot.local');
  assert.equal(transferred.recentSources.find(source => source.eventId === '$held-across-parts').body, 'Exact original Matrix body held across native parts.');
  report.transferredSessionId = state.sessionId;
  await stop(); await start(); state = await api('inspect', { botId: bot.id }); oneFrame(state);
  assert.equal(state.sessionId, report.transferredSessionId);
  assert.equal(sourceOf(state).recentSources.find(source => source.eventId === '$held-across-parts').body, 'Exact original Matrix body held across native parts.');
  report.checks.push('explicitPartTransferAndColdRestoreKeepHeldOriginalBodyAuthorAndRoom');
  state = await api('bridge-turn', { botId: bot.id }); oneFrame(state);
  const bridgeEnvelope = state.requestEnvelopes.find(row => row.requestId === 'normal-bridge-request');
  assert.equal(Object.hasOwn(bridgeEnvelope, 'memoryView'), false); assert.equal(Object.hasOwn(bridgeEnvelope.context.attention, 'memoryView'), false);
  assert.equal(bridgeEnvelope.currentMessage.body, 'Keep the human literal "memoryView": {"keep":true}.');
  assert.equal(state.receipt.status, 'completed');
  report.checks.push('normalNativeBridgePublishesOnlyTheRuntimeFrameAndPreservesLiteralHumanText');
  report.status = 'passed';
} catch (error) { report.error = error.stack; report.diagnosticDirectory = directory; process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { report.stopError = error.stack; report.status = 'failed'; process.exitCode = 1; }
  await new Promise(resolve => provider.close(resolve));
  report.calls = calls.map(({ snapshots, ...call }) => ({ ...call, snapshots: snapshots.map(text => ({
    chars: text.length, sha256: createHash('sha256').update(text).digest('hex'),
    ...(text.startsWith('Seed snapshot ') ? { seed: Number(text.match(/^Seed snapshot (\d+):/)[1]) } : {}),
    ...(text.startsWith('Current memory source context (') ? (() => {
      const snapshot = JSON.parse(text.split('\n').slice(1).join('\n'));
      return { authorId: snapshot.authorId, roomId: snapshot.roomId, sourceRefs: snapshot.sourceRefs };
    })() : {}),
  })) })); report.scriptedProviderCalls = calls.length;
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (report.status === 'failed') await writeFile(path.join(directory, 'provider-requests.json'), JSON.stringify(requests, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error, report: reportPath, scriptedProviderCalls: calls.length, remoteModelCalls: 0 }));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
