#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { MatrixClient } from '../src/matrix-client.mjs';
import { packageRoot, localPath } from '../src/paths.mjs';

const setup = JSON.parse(await readFile(localPath('matrix-setup.json'), 'utf8'));
const members = Object.fromEntries(setup.participants.map(person => [person.localpart, person]));
const clients = Object.fromEntries(setup.participants.map(person => [person.localpart, new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: person.accessToken })]));
const runId = `first-flow-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const evidence = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), evidenceLevel: 'real-matrix-and-ds-bot-model-local-multiprocess',
  physicalHosts: 1, botHosts: ['finance', 'hr'], model: 'opencode-go/deepseek-v4.1-flash', checks: [], eventIds: [], failures: [], status: 'running' };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const meta = event => event.content?.['org.ds_group'] || {};

async function save() {
  await mkdir(path.join(packageRoot, 'artifacts'), { recursive: true });
  await writeFile(path.join(packageRoot, 'artifacts', `${runId}.json`), JSON.stringify(evidence, null, 2) + '\n');
}
async function check(name, work) {
  console.log(`Checking ${name}`);
  try {
    const details = await work();
    evidence.checks.push({ name, status: 'passed', details, checkedAt: new Date().toISOString() });
    console.log(`Passed ${name}`);
  } catch (error) {
    evidence.checks.push({ name, status: 'failed', error: error.message, checkedAt: new Date().toISOString() });
    evidence.failures.push({ name, error: error.message });
    throw error;
  } finally { await save(); }
}
async function waitFor(work, description, timeout = 180000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await work();
    if (last) return last;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function status() { return (await fetch('http://127.0.0.1:18100/api/status')).json(); }
async function nodeVersions() {
  return Promise.all([18091, 18092].map(async port => (await fetch(`http://127.0.0.1:${port}/api/ds-group-node/status`)).json()));
}
async function bridgeState(name) { return JSON.parse(await readFile(localPath(`dsh-${name}`, 'runtime', 'node-state.json'), 'utf8')); }
async function runScript(file, args) {
  const child = spawn(process.execPath, [path.join(packageRoot, file), ...args], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  if (exitCode !== 0) throw new Error(`${file} failed with ${exitCode}: ${output.slice(-1500)}`);
}
async function send(name, roomId, body, to = [], extra = {}) {
  const options = { transactionId: `${runId}-${randomUUID()}`, to, ...extra };
  const receipt = await clients[name].send(roomId, body, options);
  evidence.eventIds.push({ eventId: receipt.event_id, senderId: members[name].id, roomId });
  return { ...receipt, options, body };
}
async function reply(roomId, eventId, bot) {
  return waitFor(async () => (await clients.alice.timeline(roomId, 200)).find(event => event.sender === members[bot].id && meta(event).replyTo === eventId), `${bot} reply to ${eventId}`);
}
async function requestFor(name, eventId) {
  const data = await bridgeState(name);
  return Object.values(data.requests).find(request => request.eventId === eventId && request.status === 'completed');
}
function confirmSent(name, sourceEventId, sentEventId) {
  const db = new DatabaseSync(localPath('nodes', name, 'node.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT transaction_id, status FROM outbox WHERE source_event_id=? AND sent_event_id=?').all(sourceEventId, sentEventId);
    assert.equal(rows.length, 1, 'Each emitted event must have one durable source operation');
    assert.equal(rows[0].status, 'sent');
    return rows[0].transaction_id;
  } finally { db.close(); }
}
async function idle() { return waitFor(async () => (await status()).nodes.every(node => node.status === 'idle'), 'two idle Bot nodes'); }

try {
  evidence.initialGenerationCalls = (await status()).budget.used;
  evidence.initialNodeVersions = await nodeVersions();
  const expectedRuntimeHash = createHash('sha256').update(await readFile(path.join(packageRoot, 'dsh-plugin/runtime.mjs'))).digest('hex');
  assert.ok(evidence.initialNodeVersions.every(node => node.loadedRuntimeSha256 === expectedRuntimeHash), 'Both nodes must load the frozen runtime source before verification');
  await idle();
  await check('two human identities in a shared room', async () => {
    const first = await send('alice', setup.roomId, `Alice 已加入本次框架验证。${runId}`);
    const second = await send('bob', setup.roomId, 'Bob 已加入，可以开始协作。', [], { replyTo: first.event_id });
    const events = await clients.alice.timeline(setup.roomId, 200);
    assert.equal(events.find(e => e.event_id === first.event_id)?.sender, members.alice.id);
    assert.equal(events.find(e => e.event_id === second.event_id)?.sender, members.bob.id);
    return { aliceEventId: first.event_id, bobEventId: second.event_id, roomId: setup.roomId };
  });

  await check('human to HR to finance and back to the human', async () => {
    const taskId = `${runId}-onboarding`;
    const start = await send('alice', setup.roomId,
      '请为三位新同事安排培训费用核算，每人培训费320元。请委派财务小雨计算总额，拿到结果后由你向我汇总。这个任务需要真实调用delegate交给财务，当前先不要自行给出总额。',
      [members.hr.id], { taskId });
    const events = await waitFor(async () => {
      const list = (await clients.alice.timeline(setup.roomId, 200)).filter(event => meta(event).taskId === taskId);
      const delegated = list.find(event => event.sender === members.hr.id && meta(event).kind === 'task.request' && meta(event).to?.includes(members.finance.id));
      const result = list.find(event => event.sender === members.finance.id && meta(event).kind === 'task.result');
      const final = list.find(event => event.sender === members.hr.id && meta(event).kind === 'reply' && /960/.test(event.content.body));
      return delegated && result && final ? { delegated, result, final } : null;
    }, 'cross-node delegation and final 960 answer');
    assert.match(events.result.content.body, /960/);
    assert.equal(meta(events.final).originSenderId, members.alice.id);
    assert.ok(events.final.origin_server_ts >= events.result.origin_server_ts);
    assert.equal(meta(events.result).replyTo, events.delegated.event_id);
    assert.ok(meta(events.result).to.includes(members.hr.id));
    assert.equal(meta(events.final).replyTo, start.event_id);
    const financeRequest = await requestFor('finance', events.delegated.event_id);
    const finalRequest = await requestFor('hr', events.result.event_id);
    assert.ok(financeRequest?.claimId && finalRequest?.claimId);
    assert.equal(events.final.content.body, JSON.parse(finalRequest.text).text);
    const deliveryTransactions = [confirmSent('hr', start.event_id, events.delegated.event_id),
      confirmSent('finance', events.delegated.event_id, events.result.event_id), confirmSent('hr', events.result.event_id, events.final.event_id)];
    return { sourceEventId: start.event_id, taskId, delegatedEventId: events.delegated.event_id, resultEventId: events.result.event_id, finalEventId: events.final.event_id,
      resultText: events.result.content.body, finalText: events.final.content.body, deliveryTransactions };
  });

  let directRoom;
  const marker = `星舟-${randomUUID().slice(0, 8)}`;
  let memoryEvent;
  let originalSession;
  await check('private conversation uses the same independent HR identity', async () => {
    const response = await fetch('http://127.0.0.1:18100/api/dm', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${members.alice.accessToken}` },
      body: JSON.stringify({ participantId: members.hr.id }) });
    assert.equal(response.status, 200);
    directRoom = (await response.json()).roomId;
    memoryEvent = await send('alice', directRoom, `请记住，我的这次内部项目代号是“${marker}”。这轮只回答“已记住”，以后我会再问你。`, [members.hr.id]);
    const answer = await reply(directRoom, memoryEvent.event_id, 'hr');
    originalSession = (await requestFor('hr', memoryEvent.event_id)).sessionId;
    const sharedRequest = Object.values((await bridgeState('hr')).requests).find(request => request.status === 'completed' && request.eventId !== memoryEvent.event_id);
    assert.equal(sharedRequest.sessionId, originalSession);
    return { roomId: directRoom, eventId: memoryEvent.event_id, answer: answer.content.body, sessionId: originalSession, marker };
  });

  await check('private task delegation returns from the shared room to the original private chat', async () => {
    const taskId = `${runId}-private-cost`;
    const source = await send('alice', directRoom,
      '请帮我为两位新同事核算材料费，每人75元。请用delegate委派财务小雨计算，收到结果以后在我们的私聊里汇总给我。请先委派，不要直接给出总额。',
      [members.hr.id], { taskId });
    const completed = await waitFor(async () => {
      const shared = (await clients.alice.timeline(setup.roomId, 200)).filter(event => meta(event).taskId === taskId);
      const delegated = shared.find(event => meta(event).kind === 'task.request' && event.sender === members.hr.id);
      const result = shared.find(event => meta(event).kind === 'task.result' && event.sender === members.finance.id);
      const final = (await clients.alice.timeline(directRoom, 100)).find(event => event.sender === members.hr.id && meta(event).taskId === taskId && /150/.test(event.content.body));
      return delegated && result && final ? { delegated, result, final } : null;
    }, 'private delegation return');
    assert.equal(meta(completed.final).replyTo, source.event_id);
    assert.equal(meta(completed.final).originRoomId, directRoom);
    assert.match(completed.result.content.body, /150/);
    assert.equal(meta(completed.result).replyTo, completed.delegated.event_id);
    assert.ok(meta(completed.result).to.includes(members.hr.id));
    const deliveryTransactions = [confirmSent('hr', source.event_id, completed.delegated.event_id),
      confirmSent('finance', completed.delegated.event_id, completed.result.event_id), confirmSent('hr', completed.result.event_id, completed.final.event_id)];
    return { taskId, originRoomId: directRoom, collaborationRoomId: setup.roomId, sourceEventId: source.event_id,
      delegatedEventId: completed.delegated.event_id, resultEventId: completed.result.event_id, finalEventId: completed.final.event_id, finalText: completed.final.content.body, deliveryTransactions };
  });

  await check('HR process and DSH restart preserve native Session and context', async () => {
    await idle();
    await runScript('scripts/service.mjs', ['down', 'hr']);
    await runScript('scripts/dsh-node.mjs', ['stop', 'hr']);
    await waitFor(async () => { try { await fetch('http://127.0.0.1:18092/health', { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } }, 'HR DSH shutdown', 60000);
    await runScript('scripts/service.mjs', ['up', 'hr']);
    await idle();
    const beforeRecall = await bridgeState('hr');
    assert.ok(beforeRecall.bots[members.hr.id].seenEventIds.includes(memoryEvent.event_id));
    const query = await send('alice', directRoom, '我刚才告诉你的内部项目代号是什么？请只回答代号。', [members.hr.id]);
    const answer = await reply(directRoom, query.event_id, 'hr');
    assert.ok(answer.content.body.includes(marker), `Expected original marker, got ${answer.content.body}`);
    const restored = await requestFor('hr', query.event_id);
    assert.equal(restored.sessionId, originalSession);
    assert.ok(restored.inputEvidence);
    assert.equal(restored.inputEvidence.inputText.includes(marker), false);
    assert.equal(restored.inputEvidence.historyEventIds.includes(memoryEvent.event_id), false);
    const state = await bridgeState('hr');
    assert.ok(state.bots[members.hr.id].seenEventIds.includes(memoryEvent.event_id));
    return { sessionId: originalSession, queryEventId: query.event_id, responseEventId: answer.event_id, recalledText: answer.content.body,
      recallPromptContainsMarker: restored.inputEvidence.inputText.includes(marker), recallPromptSha256: restored.inputEvidence.messageSha256,
      injectedHistoryEventIds: restored.inputEvidence.historyEventIds, rememberedEventPreviouslySeen: true };
  });

  await check('both Bot identities can generate concurrently', async () => {
    await idle();
    const request = await send('bob', setup.roomId, '请各自用一句话介绍自己的职责，只回答当前这句。', [members.finance.id, members.hr.id]);
    const [finance, hr] = await Promise.all([reply(setup.roomId, request.event_id, 'finance'), reply(setup.roomId, request.event_id, 'hr')]);
    const a = await requestFor('finance', request.event_id);
    const b = await requestFor('hr', request.event_id);
    assert.ok(Date.parse(a.startedAt) < Date.parse(b.finishedAt) && Date.parse(b.startedAt) < Date.parse(a.finishedAt), 'Expected overlapping independent Bot turns');
    const ledger = (await status()).budget.claims;
    const modelA = ledger.find(claim => claim.claimId === a.claimId);
    const modelB = ledger.find(claim => claim.claimId === b.claimId);
    assert.ok(modelA && modelB && Date.parse(modelA.claimedAt) < Date.parse(modelB.completedAt) && Date.parse(modelB.claimedAt) < Date.parse(modelA.completedAt), 'Expected overlapping provider streams');
    return { sourceEventId: request.event_id, financeEventId: finance.event_id, hrEventId: hr.event_id,
      finance: { startedAt: a.startedAt, finishedAt: a.finishedAt, claimId: a.claimId }, hr: { startedAt: b.startedAt, finishedAt: b.finishedAt, claimId: b.claimId }, providerStreamsOverlap: true };
  });

  await check('one Bot serializes messages from two humans', async () => {
    await idle();
    const first = await send('alice', setup.roomId, '本轮只回答“串行甲”。', [members.finance.id]);
    const second = await send('bob', setup.roomId, '本轮只回答“串行乙”。', [members.finance.id]);
    const answers = await Promise.all([reply(setup.roomId, first.event_id, 'finance'), reply(setup.roomId, second.event_id, 'finance')]);
    assert.match(answers[0].content.body, /串行甲/);
    assert.match(answers[1].content.body, /串行乙/);
    const a = await requestFor('finance', first.event_id);
    const b = await requestFor('finance', second.event_id);
    assert.ok(Date.parse(b.startedAt) >= Date.parse(a.finishedAt), 'Same Bot turns overlapped');
    return { firstEventId: first.event_id, secondEventId: second.event_id, firstFinished: a.finishedAt, secondStarted: b.startedAt };
  });

  await check('offline Bot catches up once after reconnect', async () => {
    await idle();
    await runScript('scripts/service.mjs', ['down', 'finance']);
    const queued = await send('bob', setup.roomId, '这是一条离线补收测试，请只回答“离线补收完成”。', [members.finance.id]);
    await send('alice', setup.roomId, '财务离线时，人类聊天仍然可以继续。');
    await runScript('scripts/service.mjs', ['up', 'finance']);
    const answer = await reply(setup.roomId, queued.event_id, 'finance');
    assert.match(answer.content.body, /离线补收完成/);
    const calls = (await status()).budget.used;
    const repeated = await clients.bob.send(setup.roomId, queued.body, queued.options);
    assert.equal(repeated.event_id, queued.event_id);
    await delay(1500);
    assert.equal((await status()).budget.used, calls);
    const replies = (await clients.alice.timeline(setup.roomId, 200)).filter(event => event.sender === members.finance.id && meta(event).replyTo === queued.event_id);
    assert.equal(replies.length, 1);
    return { sourceEventId: queued.event_id, responseEventId: answer.event_id, replyCount: replies.length, duplicateSendPreservedEventId: true };
  });
  await idle();
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.finalState = await status().catch(() => null);
  evidence.finalNodeVersions = await nodeVersions().catch(() => null);
  evidence.sourceHashes = {};
  for (const file of ['src/core.mjs', 'src/bot-node.mjs', 'src/node-store.mjs', 'src/matrix-client.mjs', 'dsh-plugin/runtime.mjs', 'scripts/verify.mjs']) {
    evidence.sourceHashes[file] = createHash('sha256').update(await readFile(path.join(packageRoot, file))).digest('hex');
  }
  evidence.limits = ['One physical Mac with separate processes and DSH homes', 'Automatic long-term memory review and general local tools are disabled in this first slice', 'Native Session history recall is measured separately from long-term memory', 'In-flight uncertain model requests remain unknown and are not automatically replayed'];
  await save();
  console.log(JSON.stringify({ runId, status: evidence.status, passed: evidence.checks.filter(check => check.status === 'passed').length, failed: evidence.failures.length, evidence: `artifacts/${runId}.json` }));
}
