#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { localPath, packageRoot } from '../src/paths.mjs';

const { values } = parseArgs({ options: {
  run: { type: 'boolean', default: false }, cases: { type: 'string', default: 'explicit,followup,revision,group,people,delegate,delegate-dm,delegate-dm-context,restart' },
  report: { type: 'string' }, timeout: { type: 'string', default: '300000' },
} });
const coreUrl = new URL(process.env.DS_GROUP_CORE_URL || 'http://127.0.0.1:20100').origin;
assert.notEqual(new URL(coreUrl).port, '18100', 'Use the isolated delivery verification core');
const financePort = Number(process.env.DS_GROUP_FINANCE_PORT || 20091);
const hrPort = Number(process.env.DS_GROUP_HR_PORT || 20092);
assert.ok(![18091, 18092].includes(financePort) && ![18091, 18092].includes(hrPort));
const setup = JSON.parse(await readFile(process.env.DS_GROUP_MATRIX_SETUP_PATH || localPath('matrix-setup.json'), 'utf8'));
assert.notEqual(new URL(setup.homeserverUrl).port, '18008', 'Use an isolated Matrix server');
const people = Object.fromEntries(setup.participants.map(person => [person.localpart, person]));
const selected = values.cases.split(',');
for (const item of selected) assert.ok(['explicit', 'followup', 'revision', 'group', 'people', 'delegate', 'delegate-dm', 'delegate-dm-context', 'restart'].includes(item), `Unknown case ${item}`);
if (selected.includes('revision')) assert.ok(selected.includes('explicit'), 'revision requires explicit');
const timeout = Number(values.timeout);
assert.ok(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 900000);
const runId = `delivery-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const reportPath = path.resolve(values.report || path.join(packageRoot, 'artifacts', `${runId}.json`));
const directory = localPath('verification', runId);
const tag = randomUUID().slice(0, 8);
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
  level: values.run ? 'real-matrix-dsh-model-delivery-routing' : 'read-only-preflight',
  model: 'opencode-go/deepseek-v4.1-flash', physicalHosts: 1, coreUrl, cases: [], sourceEventIds: [] };
const sentRequests = [];
const meta = event => event.content?.['org.ds_group'] || {};
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function api(route, { user = 'alice', body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(new URL(route, coreUrl), { method,
    headers: { Authorization: `Bearer ${people[user].accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${route} returned ${response.status}: ${data.error || ''}`);
  return data;
}

async function status() { return api('/api/status'); }
async function save() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
async function waitFor(work, label, duration = timeout) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    const result = await work();
    if (result) return result;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function check(name, work) {
  console.log(`Checking ${name}`);
  try {
    const details = await work();
    report.cases.push({ name, status: 'passed', details, checkedAt: new Date().toISOString() });
    console.log(`Passed ${name}`);
    return details;
  } catch (error) {
    report.cases.push({ name, status: 'failed', error: error.message, checkedAt: new Date().toISOString() });
    throw error;
  } finally { await save(); }
}

async function send(user, roomId, text, { mention = true, replyTo, bot = 'finance' } = {}) {
  const body = { body: `${mention ? `<@${people[bot].id}> ` : ''}${text}`, transactionId: `${runId}-${randomUUID()}`,
    mentions: { users: mention ? [people[bot].id] : [], roles: [], everyone: false, here: false },
    ...(replyTo ? { replyTo, replyMention: true } : {}) };
  const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { user, body });
  const duplicate = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { user, body });
  assert.equal(duplicate.event_id, result.event_id, 'A repeated send must retain its event ID');
  sentRequests.push({ user, roomId, body, eventId: result.event_id });
  report.sourceEventIds.push(result.event_id);
  return result.event_id;
}

async function events(user, roomId) {
  return (await api(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=200`, { user })).events;
}
async function taskFor(user, sourceRoom, eventId, bot = 'finance') {
  return (await api(`/api/rooms/${encodeURIComponent(sourceRoom)}/tasks`, { user })).tasks
    .find(task => task.eventId === eventId && task.botId === people[bot].id);
}
async function completedTask(user, sourceRoom, eventId, bot = 'finance') {
  return waitFor(async () => {
    const task = await taskFor(user, sourceRoom, eventId, bot);
    if (task && ['failed', 'cancelled'].includes(task.status)) throw new Error(`Task ${task.status}: ${task.summary}`);
    return task?.status === 'completed' ? task : null;
  }, 'completed file task');
}
async function dmFor(user, bot = 'finance') { return (await api('/api/dm', { user, body: { participantId: people[bot].id } })).roomId; }
async function allVisibleEvents() {
  const found = new Map();
  for (const user of ['alice', 'bob']) {
    const { rooms } = await api('/api/rooms', { user });
    for (const room of rooms) {
      if (found.has(room.roomId)) continue;
      found.set(room.roomId, await events(user, room.roomId));
    }
  }
  return found;
}

async function verifyFile(user, sourceRoom, eventId, destinationRoom, expected, filename, { bot = 'finance' } = {}) {
  const sourceTask = await completedTask(user, sourceRoom, eventId, bot);
  const task = destinationRoom === sourceRoom ? sourceTask
    : await waitFor(() => taskFor(user, destinationRoom, eventId, bot), 'task visible to its recipient in the destination DM');
  if (destinationRoom !== sourceRoom) assert.equal(sourceTask.artifacts.length, 0, 'Direct artifacts must be absent from the source-room task view');
  assert.ok(task.artifacts.length, 'Task must record delivered artifacts');
  const ids = new Set(task.artifacts.map(artifact => artifact.id));
  const observed = await allVisibleEvents();
  for (const [roomId, messages] of observed) {
    const misplaced = messages.find(event => event.sender === people[bot].id
      && (meta(event).originEventId === eventId || meta(event).replyTo === eventId)
      && meta(event).attachments?.some(artifact => ids.has(artifact.id)));
    if (misplaced) assert.equal(roomId, destinationRoom, 'The completed task delivered its artifact to another conversation');
  }
  const message = await waitFor(async () => (await events(user, destinationRoom)).reverse().find(event => event.sender === people[bot].id
    && (meta(event).originEventId === eventId || meta(event).replyTo === eventId)
    && meta(event).attachments?.some(artifact => ids.has(artifact.id))), 'artifact in requested destination');
  const attachment = meta(message).attachments.find(artifact => artifact.name === filename && ids.has(artifact.id));
  assert.ok(attachment, `Expected ${filename}`);
  const response = await fetch(new URL(`/api/attachments/${encodeURIComponent(attachment.id)}?download=1`, coreUrl), {
    headers: { Authorization: `Bearer ${people[user].accessToken}` }, signal: AbortSignal.timeout(20_000),
  });
  assert.ok(response.ok, 'Destination user must be able to download the delivered file');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes), attachment.sha256);
  assert.equal(bytes.length, attachment.size);
  assert.equal(bytes.toString('utf8').trim(), expected.trim(), 'Delivered contents must match the task’s own synthetic data');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${attachment.id}-${filename}`), bytes);
  const visible = await allVisibleEvents();
  const deliveries = [];
  for (const [roomId, messages] of visible) {
    for (const event of messages) {
      if (event.sender !== people[bot].id || (meta(event).originEventId !== eventId && meta(event).replyTo !== eventId)
        || !meta(event).attachments?.some(artifact => artifact.id === attachment.id)) continue;
      deliveries.push({ roomId, eventId: event.event_id });
    }
  }
  assert.equal(deliveries.length, 1, 'The artifact must have exactly one public delivery');
  assert.equal(deliveries[0].roomId, destinationRoom);
  if (destinationRoom !== sourceRoom) {
    const sourceMessages = visible.get(sourceRoom) || [];
    assert.equal(sourceMessages.some(event => event.sender === people[bot].id
      && (meta(event).originEventId === eventId || meta(event).replyTo === eventId)
      && meta(event).attachments?.length), false, 'The source group must contain no artifact reply for this direct-delivery request');
    assert.notEqual(message.content?.['m.relates_to']?.['m.in_reply_to']?.event_id, eventId, 'A DM must not reply to a foreign room event');
    assert.equal(task.delivery?.kind, 'direct', 'The persisted task intent must record direct delivery');
    assert.equal(task.delivery.recipientId, people[user].id);
    assert.equal(task.delivery.roomId, destinationRoom);
    assert.equal(task.delivery.state, 'sent');
  }
  return { requestId: task.requestId, sourceEventId: eventId, sourceRoomId: sourceRoom, destinationRoomId: destinationRoom,
    replyEventId: message.event_id, ownerId: people[user].id, attachment: { id: attachment.id, name: attachment.name, sha256: attachment.sha256, size: attachment.size },
    toolCalls: task.toolCalls, delivery: task.delivery, deliveries };
}

async function verifyDelegation(sourceRoom, destinationRoom, sourceEventId, expected, filename) {
  const final = await verifyFile('alice', sourceRoom, sourceEventId, destinationRoom, expected, filename, { bot: 'hr' });
  const botRooms = (await api('/api/rooms', { user: 'hr' })).rooms.filter(room => room.kind === 'direct'
    && room.participantIds.includes(people.hr.id) && room.participantIds.includes(people.finance.id));
  let request;
  let result;
  let collaborationRoom;
  for (const room of botRooms) {
    const timeline = await events('hr', room.roomId);
    const candidate = timeline.find(event => event.sender === people.hr.id && meta(event).kind === 'task.request' && meta(event).originEventId === sourceEventId);
    if (!candidate) continue;
    request = candidate;
    result = timeline.find(event => event.sender === people.finance.id && meta(event).kind === 'task.result' && meta(event).originEventId === sourceEventId);
    collaborationRoom = room.roomId;
    break;
  }
  assert.ok(request && result, 'The delegation and its result must be visible in a real Bot-to-Bot DM');
  assert.notEqual(collaborationRoom, setup.roomId);
  assert.equal(meta(request).originSenderId, people.alice.id);
  assert.equal(meta(result).originSenderId, people.alice.id);
  assert.ok(meta(result).attachments?.some(artifact => artifact.sha256 === final.attachment.sha256), 'The final artifact must match Finance’s delivered bytes');
  const financeRequestId = `matrix-${digest(`${people.finance.id}\0${request.event_id}`)}`;
  const nativeResponse = await fetch(`http://127.0.0.1:${financePort}/api/ds-group-node/turns/${encodeURIComponent(financeRequestId)}`, { signal: AbortSignal.timeout(5000) });
  assert.ok(nativeResponse.ok, 'Finance must have a native execution receipt for the delegated event');
  const native = await nativeResponse.json();
  assert.equal(native.status, 'completed');
  assert.ok(native.toolCalls > 0, 'The delegated Bot must execute actual tools');
  const groupEvents = await events('alice', setup.roomId);
  assert.equal(groupEvents.some(event => meta(event).originEventId === sourceEventId && meta(event).attachments?.length), false, 'The public group must contain no file from this direct-delivery task');
  return { ...final, collaborationRoomId: collaborationRoom, delegatedEventId: request.event_id, financeResultEventId: result.event_id,
    financeRequestId, financeToolCalls: native.toolCalls };
}

async function bridgeRequestFor(eventId) {
  const state = JSON.parse(await readFile(localPath('dsh-finance', 'runtime', 'node-state.json'), 'utf8'));
  return Object.values(state.requests).find(request => request.eventId === eventId);
}

async function adapterRestart() {
  const environment = { ...process.env, DS_GROUP_DATA_DIR: localPath(), DS_GROUP_CORE_URL: coreUrl,
    DS_GROUP_PORT: String(new URL(coreUrl).port || 20100), DS_GROUP_FINANCE_PORT: String(financePort), DS_GROUP_HR_PORT: String(hrPort) };
  for (const operation of ['down', 'up']) {
    const child = spawn(process.execPath, [path.join(packageRoot, 'scripts/service.mjs'), operation, 'finance'], {
      cwd: packageRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(result, 0, `Isolated adapter ${operation} failed: ${output.slice(-500)}`);
  }
}

let initial;
try {
  assert.equal((await api('/readyz')).status, 'ready');
  initial = await status();
  assert.equal(initial.budget.model, report.model);
  for (const bot of ['finance', 'hr']) assert.equal(initial.nodes.find(node => node.id === bot)?.status, 'idle');
  report.initialCalls = initial.budget.used;
  report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim();
  report.sourceHashes = {};
  for (const file of ['scripts/verify-delivery.mjs', 'src/core.mjs', 'src/bot-node.mjs', 'src/node-delivery.mjs', 'src/node-store.mjs', 'src/tasks.mjs', 'src/matrix-client.mjs', 'src/delivery-policy.mjs', 'dsh-plugin/runtime.mjs', 'dsh-plugin/runtime-rules.mjs']) {
    report.sourceHashes[file] = digest(await readFile(path.join(packageRoot, file)));
  }
  assert.equal(initial.core.loadedCoreSha256, report.sourceHashes['src/core.mjs']);
  report.loadedRuntimes = {};
  for (const [bot, port] of [['finance', financePort], ['hr', hrPort]]) {
    const runtime = await (await fetch(`http://127.0.0.1:${port}/api/ds-group-node/status`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(runtime.model, report.model, `${bot} must use the authorized model`);
    assert.equal(runtime.loadedRuntimeSha256, report.sourceHashes['dsh-plugin/runtime.mjs'], `${bot} must load the current runtime`);
    report.loadedRuntimes[bot] = runtime.loadedRuntimeSha256;
  }
  if (values.run) {
    const aliceDm = await dmFor('alice');
    const bobDm = await dmFor('bob');
    assert.notEqual(aliceDm, bobDm);
    const group = setup.roomId;
    let explicit;
    if (selected.includes('explicit')) explicit = await check('group request explicitly delivers its artifact to the requester DM', async () => {
      const contents = `RUN=${tag}\nOWNER=Alice\nVALUE=17`;
      const source = await send('alice', group, `请用工具创建 alice-result.txt，内容精确为下面三行。做好后私聊发给我。\n${contents}`);
      return verifyFile('alice', group, source, aliceDm, contents, 'alice-result.txt');
    });
    if (selected.includes('followup')) await check('an in-flight follow-up changes delivery and survives adapter restart', async () => {
      const contents = `RUN=${tag}\nOWNER=Alice\nVALUE=followup`;
      const source = await send('alice', group, `请用bash等待20秒，然后创建 followup-result.txt，内容精确为下面三行。完成后交付文件。\n${contents}`);
      await waitFor(async () => {
        const task = await taskFor('alice', group, source);
        if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error(`Task finished before follow-up: ${task.status}`);
        return task?.status === 'running' && task.toolCalls > 0;
      }, 'original task tool start');
      const correction = await send('alice', group, '做好后私聊发给我。');
      await waitFor(async () => {
        const database = new DatabaseSync(localPath('nodes', 'finance', 'node.sqlite'), { readOnly: true });
        try { return Boolean(database.prepare('SELECT 1 FROM messages WHERE event_id=?').get(correction)); }
        finally { database.close(); }
      }, 'follow-up persisted by adapter');
      await waitFor(async () => {
        const task = await taskFor('alice', group, source);
        return task?.delivery?.kind === 'direct' && task.delivery.recipientId === people.alice.id;
      }, 'updated direct-delivery intent persisted');
      const before = await bridgeRequestFor(source);
      await adapterRestart();
      const result = await verifyFile('alice', group, source, aliceDm, contents, 'followup-result.txt');
      const after = await bridgeRequestFor(source);
      assert.equal(after.requestId, before.requestId);
      assert.equal(after.sessionId, before.sessionId);
      return { ...result, correctionEventId: correction, sameRequestAfterRestart: true, sameSessionAfterRestart: true };
    });
    if (selected.includes('revision')) await check('a DM follow-up revises and sends the previous artifact within that DM', async () => {
      const contents = `RUN=${tag}\nOWNER=Alice\nVALUE=29`;
      const source = await send('alice', aliceDm, '请实际读取刚才的 alice-result.txt，将 VALUE=17 改为 VALUE=29，其他内容保持原样，另存 alice-result-v2.txt。改好发给我。', { mention: false, replyTo: explicit.replyEventId });
      const result = await verifyFile('alice', aliceDm, source, aliceDm, contents, 'alice-result-v2.txt');
      const beforeResend = await status();
      const resendSource = await send('alice', aliceDm, '请再发一次。', { mention: false });
      const resend = await verifyFile('alice', aliceDm, resendSource, aliceDm, contents, 'alice-result-v2.txt');
      assert.equal(resend.attachment.sha256, result.attachment.sha256);
      assert.equal((await status()).budget.used, beforeResend.budget.used, 'Natural resend should reuse the completed artifact');
      return { ...result, resend: { ...resend, extraModelCalls: 0 } };
    });
    if (selected.includes('group')) await check('an ordinary group file request keeps its delivery in the group', async () => {
      const contents = `RUN=${tag}\nOWNER=group\nVALUE=31`;
      const source = await send('alice', group, `请创建 group-result.txt，内容精确为下面三行，完成后把文件发给我。\n${contents}`);
      return verifyFile('alice', group, source, group, contents, 'group-result.txt');
    });
    if (selected.includes('people')) await check('Alice and Bob retain separate DM delivery targets for overlapping requests', async () => {
      const aliceContents = `RUN=${tag}\nOWNER=Alice\nVALUE=43`;
      const bobContents = `RUN=${tag}\nOWNER=Bob\nVALUE=59`;
      const [aliceSource, bobSource] = await Promise.all([
        send('alice', group, `这是一个新任务，请创建 owner-alice.txt，内容精确为下面三行，做好后私聊发给我。\n${aliceContents}`),
        send('bob', group, `这是一个新任务，请创建 owner-bob.txt，内容精确为下面三行，做好后私聊发给我。\n${bobContents}`),
      ]);
      const [alice, bob] = await Promise.all([
        verifyFile('alice', group, aliceSource, aliceDm, aliceContents, 'owner-alice.txt'),
        verifyFile('bob', group, bobSource, bobDm, bobContents, 'owner-bob.txt'),
      ]);
      assert.notEqual(alice.destinationRoomId, bob.destinationRoomId);
      assert.notEqual(alice.attachment.sha256, bob.attachment.sha256);
      return { alice, bob };
    });
    if (selected.includes('delegate')) await check('a group delegation uses Bot-to-Bot DM and delivers the final file to the original human DM', async () => {
      const hrDm = await dmFor('alice', 'hr');
      const contents = `RUN=${tag}\nOWNER=Alice\nVALUE=delegated-group`;
      const source = await send('alice', group, `请用delegate委派财务小雨实际用工具创建 delegated-result.txt，内容精确为下面三行。收到财务成果后，由你把这份成品私聊发给我。请先委派。\n${contents}`, { bot: 'hr' });
      return verifyDelegation(group, hrDm, source, contents, 'delegated-result.txt');
    });
    if (selected.includes('delegate-dm')) await check('a human DM delegation keeps collaboration private and returns the file to that DM', async () => {
      const hrDm = await dmFor('alice', 'hr');
      const contents = `RUN=${tag}\nOWNER=Alice\nVALUE=delegated-dm`;
      const source = await send('alice', hrDm, `请用delegate委派财务小雨实际用工具创建 delegated-dm-result.txt，内容精确为下面三行。收到财务成果后在我们私聊里发给我。请先委派。\n${contents}`, { bot: 'hr', mention: false });
      return verifyDelegation(hrDm, hrDm, source, contents, 'delegated-dm-result.txt');
    });
    if (selected.includes('delegate-dm-context')) await check('a natural DM request inherits private delivery without destination words', async () => {
      const hrDm = await dmFor('alice', 'hr');
      const contents = `RUN=${tag}\nOWNER=Alice\nVALUE=peer-context`;
      const instruction = `请用delegate委派财务小雨实际用工具创建 peer-context-result.txt，内容精确为下面三行。收到财务成果后把文件和简短说明返回给我。请先委派。\n${contents}`;
      assert.equal(/私聊|私信|\bdm\b|direct message|private message/i.test(instruction), false, 'This scenario must rely on conversation context');
      const source = await send('alice', hrDm, instruction, { bot: 'hr', mention: false });
      const sourceMessage = (await events('alice', hrDm)).find(event => event.event_id === source);
      assert.ok(sourceMessage, 'The submitted human event must be present in the source timeline');
      assert.equal(meta(sourceMessage).conversationKind, 'direct', 'Core must record canonical direct conversation context');
      const initialTask = await waitFor(() => taskFor('alice', hrDm, source, 'hr'), 'default delivery on a natural DM task');
      assert.equal(initialTask.delivery?.kind, 'direct', 'A human DM task must default to direct delivery without destination words');
      assert.equal(initialTask.delivery.recipientId, people.alice.id);
      const result = await verifyDelegation(hrDm, hrDm, source, contents, 'peer-context-result.txt');
      assert.equal(result.delivery.kind, 'direct');
      assert.equal(result.delivery.recipientId, people.alice.id);
      assert.equal(result.delivery.roomId, hrDm);
      assert.equal(result.delivery.state, 'sent');
      return { ...result, destinationWordsInRequest: false, sourceConversationKind: meta(sourceMessage).conversationKind, initialDelivery: initialTask.delivery };
    });
    if (selected.includes('restart')) await check('completed event retries after adapter restart keep one delivery and add no model calls', async () => {
      assert.ok(sentRequests.length, 'Run a delivery case before restart');
      await waitFor(async () => (await status()).nodes.every(node => node.status === 'idle'), 'idle Bot nodes');
      const before = await status();
      const visibleBefore = await allVisibleEvents();
      const botIds = new Set([people.finance.id, people.hr.id]);
      const idsBefore = [...visibleBefore.values()].flat().filter(event => botIds.has(event.sender)).map(event => event.event_id).sort();
      await adapterRestart();
      for (const previous of sentRequests) {
        const duplicate = await api(`/api/rooms/${encodeURIComponent(previous.roomId)}/messages`, { user: previous.user, body: previous.body });
        assert.equal(duplicate.event_id, previous.eventId);
      }
      await delay(3000);
      const after = await status();
      assert.equal(after.budget.used, before.budget.used);
      const visibleAfter = await allVisibleEvents();
      const idsAfter = [...visibleAfter.values()].flat().filter(event => botIds.has(event.sender)).map(event => event.event_id).sort();
      assert.deepEqual(idsAfter, idsBefore);
      return { replayedInputs: sentRequests.length, callsBefore: before.budget.used, callsAfter: after.budget.used,
        botMessagesBefore: idsBefore.length, botMessagesAfter: idsAfter.length };
    });
  }
  const checkedSources = {};
  for (const [file, hash] of Object.entries(report.sourceHashes)) {
    checkedSources[file] = digest(await readFile(path.join(packageRoot, file))) === hash;
    assert.ok(checkedSources[file], `Source changed during verification: ${file}`);
  }
  const checkedStatus = await status();
  assert.equal(checkedStatus.core.loadedCoreSha256, report.sourceHashes['src/core.mjs']);
  const checkedRuntimes = {};
  for (const [bot, port] of [['finance', financePort], ['hr', hrPort]]) {
    const runtime = await (await fetch(`http://127.0.0.1:${port}/api/ds-group-node/status`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(runtime.model, report.model, `${bot} must use the authorized model`);
    assert.equal(runtime.loadedRuntimeSha256, report.sourceHashes['dsh-plugin/runtime.mjs']);
    assert.equal(runtime.activeTurns, 0, `${bot} must be idle after verification`);
    checkedRuntimes[bot] = { loadedRuntimeSha256: runtime.loadedRuntimeSha256, activeTurns: runtime.activeTurns };
  }
  report.postRunChecks = { sourcesMatch: checkedSources, loadedCoreSha256: checkedStatus.core.loadedCoreSha256, runtimes: checkedRuntimes };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (initial) {
    const final = await status().catch(() => null);
    if (final) {
      const initialIds = new Set(initial.budget.claims.map(claim => claim.claimId));
      report.claims = final.budget.claims.filter(claim => !initialIds.has(claim.claimId));
      report.modelCalls = final.budget.used - initial.budget.used;
      report.finalCalls = final.budget.used;
      if (report.claims.some(claim => claim.model !== report.model)) { report.status = 'failed'; report.error = 'Observed a model outside the authorized route'; process.exitCode = 1; }
      report.finalNodes = final.nodes.map(node => ({ id: node.id, status: node.status, pending: node.pending, lastError: node.lastError }));
    }
  }
  report.completedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: report.status, checks: report.cases.length, modelCalls: report.modelCalls ?? 0, report: reportPath, ...(report.error ? { error: report.error } : {}) }));
}
