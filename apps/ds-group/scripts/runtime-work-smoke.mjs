#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, open, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from './runtime-config.mjs';

// Real DSH and native local tools, with scripted localhost model responses.
// This test never calls a remote model or uses a real provider credential.
const installation = await resolveDsh();
const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-work-smoke-'));
const workdir = path.join(directory, 'task');
await mkdir(workdir);
const inputFile = path.join(workdir, 'costs.csv');
const outputFile = path.join(workdir, 'result.csv');
const backgroundProcessFile = path.join(workdir, 'background-pid.txt');
await writeFile(inputFile, 'name,amount\nAlice,120\nBob,230\n');
const ledger = [];
const requests = [];
const heldResponses = new Set();
const sourceHashes = {};
for (const filename of ['dsh-plugin/runtime.mjs', 'dsh-plugin/runtime-rules.mjs', 'dsh-plugin/work-files.mjs', 'scripts/runtime-work-smoke.mjs']) {
  sourceHashes[filename] = createHash('sha256').update(await readFile(path.join(packageRoot, filename))).digest('hex');
}
const report = { checkedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version,
  level: 'real-dsh-native-tools-scripted-local-provider', modelCalls: 0, scriptedProviderCalls: 0, sourceHashes, checks: [], status: 'failed' };
const model = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url.startsWith('/internal/model/')) {
      ledger.push({ route: request.url, body: input });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url.endsWith('/claim') ? { claimId: `local-claim-${ledger.length}` } : { recorded: true }));
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(input.model, 'deepseek-v4.1-flash');
    requests.push(input);
    const step = requests.length;
    if (step === 6) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': waiting for task cancellation\n\n');
      heldResponses.add(response);
      response.on('close', () => heldResponses.delete(response));
      return;
    }
    const expected = [
      { name: 'read', arguments: { file_path: inputFile } },
      { name: 'bash', arguments: { description: 'Calculate and save the CSV total', command: "node -e 'const fs=require(\"node:fs\");const n=fs.readFileSync(\"costs.csv\",\"utf8\").trim().split(\"\\n\").slice(1).reduce((s,r)=>s+Number(r.split(\",\")[1]),0);fs.writeFileSync(\"result.csv\",\"total\\n\"+n+\"\\n\");console.log(n)'" } },
      { name: 'read', arguments: { file_path: outputFile } },
      undefined,
      { name: 'bash', arguments: { description: 'Run a cancellable background file operation', run_in_background: true,
        command: "node -e 'const fs=require(\"node:fs\");fs.writeFileSync(\"background-pid.txt\",String(process.pid));setTimeout(()=>fs.writeFileSync(\"late-output.txt\",\"unexpected\"),30000)'" } },
    ][step - 1];
    const chunk = delta => ({ id: `completion-${step}`, object: 'chat.completion.chunk', created: 1, model: input.model,
      choices: [{ index: 0, delta, finish_reason: null }] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', reasoning_content: 'Use the real file tools.' }))}\n\n`);
    if (expected) {
      assert.ok(input.tools.some(tool => tool.function.name === expected.name), `Missing native ${expected.name} tool`);
      response.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: `tool-${step}`, type: 'function', function: { name: expected.name, arguments: JSON.stringify(expected.arguments) } }] }))}\n\n`);
    } else {
      assert.equal(step, 4, 'Unexpected extra generation');
      response.write(`data: ${JSON.stringify(chunk({ content: JSON.stringify({ text: '费用合计350，结果见附件。', artifacts: [{ path: outputFile, name: '费用汇总.csv' }] }) }))}\n\n`);
    }
    const finish = chunk({});
    finish.choices[0].finish_reason = expected ? 'tool_calls' : 'stop';
    finish.usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
    response.write(`data: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);
    response.end();
  } catch (error) {
    report.providerError = error.message;
    response.writeHead(500); response.end('{}');
  }
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const origin = `http://127.0.0.1:${model.address().port}`;
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const bridgePort = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
await writeFile(path.join(directory, 'core-config.json'), JSON.stringify({ nodeSecret: 'local-scripted-smoke', publicUrl: origin }));
const log = await open(path.join(directory, 'host.log'), 'a', 0o600);
const child = spawn(process.execPath, [path.join(packageRoot, 'scripts/dsh-node.mjs'), 'run', 'finance'], {
  cwd: packageRoot, detached: true, stdio: ['ignore', log.fd, log.fd], env: {
    ...process.env, DS_GROUP_DSH_CLI: installation.cli, DS_GROUP_DSH_RUNTIME: installation.runtime,
    DS_GROUP_DATA_DIR: directory, DS_GROUP_CORE_CONFIG_PATH: path.join(directory, 'core-config.json'), DS_GROUP_CORE_URL: origin,
    DS_GROUP_BRIDGE_PORT: String(bridgePort), OPENCODE_API_KEY: 'local-scripted-smoke-no-remote-key', DS_GROUP_OPENCODE_BASE_URL: `${origin}/v1`,
  },
});
const exited = new Promise(resolve => child.once('close', resolve));
const base = `http://127.0.0.1:${bridgePort}/api/ds-group-node`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, input) {
  const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST',
    headers: input === undefined ? {} : { 'content-type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}
try {
  let ready;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}`);
    try { ready = await api('/status'); break; } catch { await sleep(500); }
  }
  assert.ok(ready);
  const bot = await api('/bots', { botId: '@finance:local-smoke.test', name: 'File work smoke', role: '财务', instructions: 'Use the actual file tools to complete tasks.' });
  assert.ok(bot.tools.includes('bash') && bot.tools.includes('read') && bot.tools.includes('write'));
  const request = { async: true, requestId: 'file-work-native-smoke', botId: bot.botId, workdir,
    event: { eventId: '$work', roomId: '!test:local', senderId: '@alice:local', body: '请读取CSV，实际计算费用合计，生成结果CSV并读取核对后交付。' },
    files: [{ id: 'input-costs', name: 'costs.csv', path: inputFile, mimeType: 'text/csv', size: (await readFile(inputFile)).length,
      sha256: createHash('sha256').update(await readFile(inputFile)).digest('hex') }] };
  let result = await api('/turns', request);
  assert.ok(['queued', 'running'].includes(result.status));
  const duplicate = await api('/turns', request);
  assert.equal(duplicate.duplicate, true);
  report.checks.push('asynchronousAdmissionAndDuplicate');
  for (let attempt = 0; attempt < 180 && ['queued', 'running'].includes(result.status); attempt++) {
    await sleep(500);
    result = await api('/turns/file-work-native-smoke');
  }
  report.receipt = result;
  assert.equal(result.status, 'completed', result.errorCode);
  assert.equal(await readFile(outputFile, 'utf8'), 'total\n350\n');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].sha256, createHash('sha256').update(await readFile(outputFile)).digest('hex'));
  report.checks.push('realReadComputeWriteReadAndValidatedArtifact');
  assert.equal(result.toolCalls, 3);
  assert.ok(result.toolReceipts.every(item => item.status === 'completed'));
  assert.equal(result.claims.length, 4);
  assert.ok(result.claims.every(item => item.recorded && item.status === 'completed'));
  assert.equal(ledger.filter(item => item.route.endsWith('/claim')).length, 4);
  assert.equal(ledger.filter(item => item.route.endsWith('/complete')).length, 4);
  report.checks.push('nativeToolReceiptsAndEveryGenerationLedger');
  assert.equal((await api('/turns', { ...request, async: false })).duplicate, true);
  assert.equal((await api('/turns/file-work-native-smoke/cancel', {})).status, 'completed');
  assert.equal(requests.length, 4);
  report.checks.push('completedReplayAndCancellationDoNotExecuteAgain');
  const runningId = 'work-cancel-running';
  const queuedId = 'work-cancel-queued';
  await api('/turns', { ...request, requestId: runningId, event: { ...request.event, eventId: '$cancel-running' } });
  for (let attempt = 0; attempt < 120 && requests.length < 6; attempt++) await sleep(100);
  assert.equal(requests.length, 6);
  let backgroundPid;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { backgroundPid = Number(await readFile(backgroundProcessFile, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(100); }
  }
  assert.ok(Number.isInteger(backgroundPid) && backgroundPid > 0);
  process.kill(backgroundPid, 0);
  await api('/turns', { ...request, requestId: queuedId, event: { ...request.event, eventId: '$cancel-queued' } });
  assert.equal((await api(`/turns/${queuedId}/cancel`, {})).status, 'cancelled');
  await api(`/turns/${runningId}/cancel`, {});
  let cancelled;
  for (let attempt = 0; attempt < 120; attempt++) {
    cancelled = await api(`/turns/${runningId}`);
    if (cancelled.status === 'cancelled') break;
    await sleep(100);
  }
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await api(`/turns/${queuedId}`)).status, 'cancelled');
  assert.equal(requests.length, 6, 'cancelled queued request must not reach the provider');
  let processStopped = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(backgroundPid, 0); }
    catch (error) { if (error.code === 'ESRCH') { processStopped = true; break; } throw error; }
    await sleep(100);
  }
  assert.ok(processStopped, 'cancelled task must stop its native background process');
  await assert.rejects(readFile(path.join(workdir, 'late-output.txt')), { code: 'ENOENT' });
  report.cancellation = { runningStatus: cancelled.status, queuedStatus: 'cancelled', backgroundProcessStopped: processStopped };
  report.checks.push('runningAndQueuedCancellationStopsBackgroundProcess');
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  report.diagnosticDirectory = directory;
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 40_000); })]);
  clearTimeout(timer);
  if (!stopped) { process.kill(-child.pid, 'SIGKILL'); await exited; report.stopForced = true; process.exitCode = 1; }
  await log.close();
  for (const response of heldResponses) response.destroy();
  await new Promise(resolve => model.close(resolve));
  report.scriptedProviderCalls = requests.length;
  report.completedAt = new Date().toISOString();
  const reportPath = path.resolve(process.env.DS_GROUP_WORK_SMOKE_REPORT || path.join(packageRoot, '.local/runtime-work-smoke.json'));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error, report: reportPath, modelCalls: 0, scriptedProviderCalls: requests.length }));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
