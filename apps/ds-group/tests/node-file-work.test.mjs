import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeFiles, selectInputAttachments } from '../src/node-files.mjs';
import { BotNode, createBridge, deliveriesFor } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';
import { prepareWorkFiles } from '../dsh-plugin/work-files.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const people = [{ id: '@alice:server.test', localpart: 'alice', name: 'Alice', kind: 'human' },
  { id: '@finance:server.test', localpart: 'finance', name: '财务', kind: 'bot' },
  { id: '@hr:server.test', localpart: 'hr', name: '人事', kind: 'bot' }];
const finance = people[1];
const roomId = '!group:server.test';
const attachment = (id, bytes, name = '费用.csv') => ({ id, name, size: Buffer.byteLength(bytes),
  sha256: hash(bytes), mimeType: 'text/csv', contentUri: `mxc://server.test/${id}` });
const event = (id, files = []) => ({ event_id: id, type: 'm.room.message', room_id: roomId,
  sender: people[0].id, content: { body: '计算并返回文件', 'org.ds_group': { to: [finance.id], attachments: files } } });

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-file-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('node downloads distinct same-name attachments, extracts text and reuses verified local bytes', async t => {
  const directory = await temporary(t);
  const sources = { first: '部门,费用\n人事,100\n', second: '部门,费用\n财务,200\n' };
  let downloads = 0;
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'synthetic-bot-token', directory,
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-bot-token');
      downloads++;
      return new Response(sources[decodeURIComponent(url.pathname.split('/').at(-1))]);
    } });
  const request = { requestId: 'message-one', event: { attachments: [attachment('first', sources.first, '费用'.repeat(100) + '.csv'), attachment('second', sources.second)] }, history: [] };
  const prepared = await files.prepare(request);
  assert.equal(prepared.files.length, 2);
  assert.notEqual(prepared.files[0].path, prepared.files[1].path);
  assert.equal(await readFile(prepared.files[0].path, 'utf8'), sources.first);
  assert.match(await readFile(prepared.files[1].extraction.textPath, 'utf8'), /200/);
  assert.equal(prepared.files[0].extraction.supported, true);
  assert.ok(prepared.files[0].path.endsWith('.csv'));
  const restored = await files.prepare(request);
  assert.equal(downloads, 2);
  assert.equal(restored.workdir, prepared.workdir);
  const followup = await files.prepare({ ...request, requestId: 'message-two' });
  assert.equal(downloads, 2);
  assert.notEqual(followup.files[0].path, prepared.files[0].path);
  await writeFile(followup.files[0].path, 'edited task copy');
  const next = await files.prepare({ ...request, requestId: 'message-three' });
  assert.equal(await readFile(next.files[0].path, 'utf8'), sources.first);
  assert.equal(downloads, 2);
});

test('node rejects wrong download checksums and removes partial files', async t => {
  const directory = await temporary(t);
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'token', directory,
    fetchImpl: async () => new Response('wrong bytes') });
  await assert.rejects(files.prepare({ requestId: 'bad', history: [], event: { attachments: [attachment('bad', 'expected', '../file.txt')] } }), /checksum/);
  const taskDirectory = path.join(directory, (await readdir(directory))[0], 'inputs');
  assert.deepEqual(await readdir(taskDirectory), []);
});

test('artifact publication verifies contents, confines paths and reuses a stable upload identity', async t => {
  const directory = await temporary(t);
  const workdir = path.join(directory, 'task');
  await mkdir(workdir);
  const filename = path.join(workdir, 'result.csv');
  const bytes = 'department,total\nfinance,300\n';
  await writeFile(filename, bytes);
  const uploadIds = [];
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'token', directory,
    fetchImpl: async (url, options) => {
      assert.equal(url.searchParams.get('filename'), '汇总.csv');
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), bytes);
      uploadIds.push(options.headers['X-Upload-Id']);
      return Response.json({ attachment: attachment('result-id', bytes, '汇总.csv') });
    } });
  const artifact = { path: filename, name: '汇总.csv', mimeType: 'text/csv', size: Buffer.byteLength(bytes), sha256: hash(bytes) };
  const request = { botId: finance.id, requestId: 'task-one', workdir };
  await files.upload(artifact, request);
  await files.upload(artifact, request);
  assert.equal(uploadIds[0], uploadIds[1]);
  await writeFile(filename, 'changed');
  await assert.rejects(files.upload(artifact, request), /changed after verification/);
  const outside = path.join(directory, 'outside.txt');
  await writeFile(outside, 'outside');
  await assert.rejects(files.upload({ path: outside }, request), /outside its working directory/);
});

test('generated files survive an upload interruption and node restart without another model turn', async t => {
  const directory = await temporary(t);
  const filename = path.join(directory, 'node.sqlite');
  const result = attachment('output', 'total,300\n');
  let generations = 0;
  let uploads = 0;
  const reports = [];
  const sent = [];
  const files = { prepare: async request => ({ ...request, workdir: directory, files: [] }),
    upload: async () => { uploads++; if (uploads === 1) throw Object.assign(new Error('lost upload receipt'), { networkError: true }); return result; } };
  const bridge = { turn: async () => { generations++; return { status: 'completed', text: '{"text":"汇总已完成"}', sessionId: 'session-files',
    toolCalls: 3, artifacts: [{ path: path.join(directory, 'result.csv'), sha256: result.sha256 }] }; } };
  const tasks = { update: async payload => reports.push(payload), control: async () => ({ cancelRequested: false }) };
  const matrix = { send: async (room, body, options) => { sent.push({ room, body, options }); return { event_id: '$result' }; } };
  let store = new NodeStore(filename, finance.id);
  let node = new BotNode({ participant: finance, participants: people, roomId, store, bridge, files, tasks, matrix, heartbeat: async () => {} });
  store.ingest([event('$input')], 'cursor');
  await assert.rejects(node.processOne(), /lost upload/);
  assert.equal(store.pendingResult().response.sessionId, 'session-files');
  store.close();
  store = new NodeStore(filename, finance.id);
  node = new BotNode({ participant: finance, participants: people, roomId, store, bridge, files, tasks, matrix, heartbeat: async () => {} });
  await node.processOne();
  assert.equal(generations, 1);
  assert.equal(store.snapshot().pendingSends, 1);
  assert.equal(reports.at(-1).stage, 'delivering');
  await node.processOne();
  assert.equal(sent[0].options.attachments[0].id, result.id);
  assert.equal(reports.at(-1).status, 'completed');
  assert.equal(reports.at(-1).artifacts[0].id, result.id);
  assert.equal(generations, 1);
  store.close();
});

test('async bridge polls progress and sends cancellation once without resubmitting generation', async () => {
  const calls = [];
  const updates = [];
  let polls = 0;
  const bridge = createBridge('https://bridge.test', { pollIntervalMs: 1, fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method });
    if (url.pathname.endsWith('/cancel')) return Response.json({ accepted: true });
    if (options.method === 'POST') return Response.json({ status: 'running', stage: 'reading', toolCalls: 1 }, { status: 202 });
    polls++;
    return Response.json(polls === 1 ? { status: 'running', stage: 'tool', toolCalls: 2 } : { status: 'cancelled', toolCalls: 2 });
  } });
  const receipt = await bridge.turn({ requestId: 'job-one' }, { control: async () => ({ cancelRequested: true }), onProgress: update => updates.push(update) });
  assert.equal(receipt.status, 'cancelled');
  assert.equal(calls.filter(call => call.path.endsWith('/turns')).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  assert.equal(updates.length, 2);
});

test('node reconciles a completed interrupted request through GET and publishes its original receipt', async () => {
  const store = new NodeStore(':memory:', finance.id);
  store.ingest([event('$interrupted')], 'cursor');
  store.begin('$interrupted', { requestId: 'existing-job', botId: finance.id, event: { eventId: '$interrupted' }, history: [] });
  store.failed('$interrupted', 'adapter disconnected', 'unknown');
  let statusCalls = 0;
  const node = new BotNode({ participant: finance, participants: people, roomId, store, heartbeat: async () => {}, matrix: {},
    bridge: { status: async id => { statusCalls++; assert.equal(id, 'existing-job'); return { status: 'completed', text: '{"text":"已完成"}', sessionId: 'old-session' }; },
      turn: async () => { throw new Error('Generation must not be resubmitted'); } } });
  await node.processOne();
  assert.equal(statusCalls, 1);
  assert.equal(store.snapshot().unknown, 0);
  assert.equal(store.snapshot().pendingSends, 1);
  assert.equal(store.snapshot().sessionId, 'old-session');
  store.close();
});

test('delegation carries stable file references and the final reply delivers returned files to the origin', () => {
  const file = attachment('file-one', 'amount\n300\n');
  const origin = event('$input', [file]);
  const delegated = deliveriesFor(origin, { text: '请人事整理', delegate: { to: people[2].id, body: '整理附件' } }, finance.id, people)[1];
  assert.equal(delegated.options.attachments[0].id, file.id);
  const returned = { ...event('$result', [file]), sender: people[2].id,
    content: { body: '已整理', 'org.ds_group': { ...delegated.options, kind: 'task.result', originRoomId: '!private:test', originEventId: '$private', originSenderId: people[0].id } } };
  const final = deliveriesFor(returned, { text: '已完成' }, finance.id, people)[0];
  assert.equal(final.roomId, '!private:test');
  assert.equal(final.options.attachments[0].id, file.id);
  assert.deepEqual(final.options.mMentions.user_ids, [people[0].id]);
  assert.equal(JSON.stringify(final.options.attachments).includes('path'), false);
});

test('cancelling a waiting collaboration suppresses a late child result and preserves task identity', async () => {
  const store = new NodeStore(':memory:', finance.id);
  let cancelled = false;
  let generations = 0;
  const sent = [];
  const reports = [];
  const node = new BotNode({ participant: finance, participants: people, roomId, store, heartbeat: async () => {},
    tasks: { update: async payload => reports.push(payload), control: async () => ({ cancelRequested: cancelled }) },
    matrix: { send: async (room, body, options) => { sent.push({ room, body, options }); return { event_id: `$sent-${sent.length}` }; } },
    bridge: { turn: async () => { generations++; return { status: 'completed', text: JSON.stringify({ text: '委派人事处理', delegate: { to: people[2].id, body: '整理附件' } }) }; } } });
  store.ingest([event('$origin')], 'one');
  await node.processOne();
  await node.processOne();
  await node.processOne();
  const waiting = store.task('$origin');
  assert.equal(waiting.stage, 'waiting_for_bot');
  assert.equal(waiting.taskId, sent[1].options.taskId);
  cancelled = true;
  await node.checkWaitingTasks();
  assert.equal(store.task('$origin').status, 'cancelled');
  const child = { ...event('$child'), sender: people[2].id,
    content: { body: '已完成', 'org.ds_group': { ...sent[1].options, to: [finance.id], kind: 'task.result' } } };
  store.ingest([child], 'two');
  await node.processOne();
  assert.equal(generations, 1);
  assert.equal(sent.length, 2);
  assert.equal(store.task('$origin').status, 'cancelled');
  assert.equal(reports.at(-1).status, 'cancelled');
  store.close();
});

test('cancellation after generation suppresses pending delivery without changing the saved output', async () => {
  const store = new NodeStore(':memory:', finance.id);
  let cancelled = false;
  let deliveries = 0;
  const node = new BotNode({ participant: finance, participants: people, roomId, store, heartbeat: async () => {},
    tasks: { update: async () => {}, control: async () => ({ cancelRequested: cancelled }) },
    matrix: { send: async () => { deliveries++; return { event_id: '$sent' }; } },
    bridge: { turn: async () => ({ status: 'completed', text: '{"text":"结果已生成"}' }) } });
  store.ingest([event('$cancel-before-send')], 'one');
  await node.processOne();
  assert.equal(store.snapshot().pendingSends, 1);
  cancelled = true;
  await node.processOne();
  assert.equal(deliveries, 0);
  assert.equal(store.snapshot().pendingSends, 0);
  assert.equal(store.item('$cancel-before-send').status, 'cancelled');
  assert.equal(store.item('$cancel-before-send').response.text, '{"text":"结果已生成"}');
  store.close();
});

test('large file batches deliver every artifact and trigger a delegated Bot once', () => {
  const files = Array.from({ length: 16 }, (_, index) => attachment(`file-${index}`, String(index)));
  const output = { text: '请人事处理这些文件', sourceAttachments: files, delegate: { to: people[2].id, body: '整理文件' } };
  const messages = deliveriesFor(event('$many'), output, finance.id, people);
  const delegated = messages.filter(message => message.options.kind === 'task.request');
  assert.deepEqual(delegated.map(message => message.options.attachments.length), [10, 6]);
  assert.equal(delegated.filter(message => message.options.to.includes(people[2].id)).length, 1);
  assert.deepEqual(delegated.at(-1).options.to, [people[2].id]);
  assert.equal(new Set(delegated.map(message => message.options.transactionId)).size, 2);
  assert.deepEqual(messages, deliveriesFor(event('$many'), output, finance.id, people));
});

test('unreadable text and corrupt PDF retain raw files accepted by the runtime work-file contract', async t => {
  const directory = await temporary(t);
  const sources = { text: Buffer.from([0xc3, 0x28]), pdf: Buffer.from('%PDF-1.7\nnot a readable document') };
  const descriptors = [attachment('text', sources.text, 'legacy.txt'), { ...attachment('pdf', sources.pdf, 'broken.pdf'), mimeType: 'application/pdf' }];
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'token', directory,
    fetchImpl: async url => new Response(sources[url.pathname.split('/').at(-1)]) });
  const prepared = await files.prepare({ requestId: 'raw-fallback', history: [], event: { attachments: descriptors } });
  assert.ok(prepared.files.every(file => file.extraction.type && file.extraction.supported === false));
  assert.ok(prepared.files.every(file => file.extraction.warnings.length));
  const accepted = await prepareWorkFiles(prepared);
  assert.equal(accepted.files.length, 2);
  assert.deepEqual(await readFile(accepted.files[0].path), sources.text);
  assert.deepEqual(await readFile(accepted.files[1].path), sources.pdf);
});

test('receipt and final task state commit atomically across a failure at the completion boundary', async t => {
  const directory = await temporary(t);
  const filename = path.join(directory, 'node.sqlite');
  const sent = [];
  let generations = 0;
  const bridge = { turn: async () => { generations++; return { status: 'completed', text: '{"text":"已完成"}' }; } };
  const matrix = { send: async (room, body, options) => { sent.push({ room, body, options }); return { event_id: '$same-receipt' }; } };
  let store = new NodeStore(filename, finance.id);
  let node = new BotNode({ participant: finance, participants: people, roomId, store, bridge, matrix, heartbeat: async () => {} });
  store.ingest([event('$atomic')], 'one');
  await node.processOne();
  const finalize = node.finishDeliveryState.bind(node);
  node.finishDeliveryState = delivery => { finalize(delivery); throw new Error('simulated crash after task write before transaction commit'); };
  await assert.rejects(node.processOne(), /simulated crash/);
  assert.equal(store.item('$atomic').status, 'generated');
  assert.equal(store.task('$atomic').stage, 'delivering');
  assert.equal(store.pendingDelivery().sent_event_id, null);
  store.close();
  store = new NodeStore(filename, finance.id);
  node = new BotNode({ participant: finance, participants: people, roomId, store, bridge, matrix, heartbeat: async () => {} });
  await node.processOne();
  assert.equal(store.item('$atomic').status, 'completed');
  assert.equal(store.task('$atomic').status, 'completed');
  assert.equal(store.pendingTaskUpdates().at(-1).payload.status, 'completed');
  assert.equal(generations, 1);
  assert.deepEqual(sent[0], sent[1]);
  store.close();
});

test('a delegated execution failure returns to the original conversation and finishes its waiting parent', async () => {
  const parentStore = new NodeStore(':memory:', finance.id);
  const childStore = new NodeStore(':memory:', people[2].id);
  const messages = [];
  const matrix = { send: async (room, body, options) => {
    const receipt = { event_id: `$sent-${messages.length}`, type: 'm.room.message', room_id: room, content: { body, 'org.ds_group': options } };
    messages.push(receipt);
    return { event_id: receipt.event_id };
  } };
  let parentGenerations = 0;
  const parent = new BotNode({ participant: finance, participants: people, roomId, store: parentStore, matrix, heartbeat: async () => {},
    bridge: { turn: async () => { parentGenerations++; return { status: 'completed', text: JSON.stringify({ text: '请人事处理', delegate: { to: people[2].id, body: '处理文件' } }) }; } } });
  const child = new BotNode({ participant: people[2], participants: people, roomId, store: childStore, matrix, heartbeat: async () => {},
    bridge: { turn: async () => ({ status: 'failed', errorCode: 'TASK_TIMEOUT', toolCalls: 2 }) } });
  const original = { ...event('$original'), room_id: '!private:test' };
  parentStore.ingest([original], 'one');
  await parent.processOne();
  await parent.processOne();
  await parent.processOne();
  assert.equal(parentStore.task('$original').stage, 'waiting_for_bot');
  childStore.ingest([{ ...messages[1], sender: finance.id }], 'one');
  await child.processOne();
  await child.processOne();
  assert.equal(messages[2].content['org.ds_group'].kind, 'task.failure');
  assert.equal(childStore.task(messages[1].event_id).status, 'failed');
  parentStore.ingest([{ ...messages[2], sender: people[2].id }], 'two');
  await parent.processOne();
  await parent.processOne();
  assert.equal(messages.at(-1).room_id, '!private:test');
  assert.match(messages.at(-1).content.body, /TASK_TIMEOUT/);
  assert.equal(parentStore.task('$original').status, 'failed');
  assert.equal(parentGenerations, 1);
  parentStore.close();
  childStore.close();
});

test('download failures retry within a bound and finish as a known delegated failure before model submission', async () => {
  const store = new NodeStore(':memory:', finance.id);
  let attempts = 0;
  let generations = 0;
  const node = new BotNode({ participant: finance, participants: people, roomId, store, matrix: {}, heartbeat: async () => {},
    transferRetryDelayMs: 1, onError: () => {},
    files: { prepare: async () => { attempts++; throw Object.assign(new Error('temporary download failure'), { networkError: true }); } },
    bridge: { turn: async () => { generations++; throw new Error('Unexpected generation'); } } });
  const delegated = { ...event('$download-failure'), sender: people[2].id,
    content: { body: '读取文件', 'org.ds_group': { to: [finance.id], kind: 'task.request', returnTo: people[2].id,
      originSenderId: people[0].id, originRoomId: '!original:test', originEventId: '$origin', taskId: 'family-one' } } };
  store.ingest([delegated], 'cursor');
  await node.processOne();
  assert.equal(attempts, 3);
  assert.equal(generations, 0);
  assert.equal(store.snapshot().unknown, 0);
  assert.equal(store.task('$download-failure').status, 'failed');
  assert.equal(store.pendingDelivery().options.kind, 'task.failure');
  assert.equal(store.pendingDelivery().options.taskId, 'family-one');
  store.close();
});

test('task cancellation aborts an active attachment download and never submits a model turn', async t => {
  const directory = await temporary(t);
  const store = new NodeStore(':memory:', finance.id);
  let started = false;
  let aborted = false;
  let generations = 0;
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'token', directory,
    fetchImpl: async (_url, { signal }) => {
      started = true;
      return new Promise((resolve, reject) => {
        const abort = () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    } });
  const node = new BotNode({ participant: finance, participants: people, roomId, store, files, matrix: {}, heartbeat: async () => {},
    controlIntervalMs: 1, onError: () => {},
    tasks: { update: async () => {}, control: async () => ({ cancelRequested: started }) },
    bridge: { turn: async () => { generations++; return { status: 'completed', text: '{"text":"unexpected"}' }; } } });
  store.ingest([event('$cancel-download', [attachment('input', 'some file')])], 'cursor');
  await node.processOne();
  assert.equal(aborted, true);
  assert.equal(generations, 0);
  assert.equal(store.item('$cancel-download').status, 'cancelled');
  assert.equal(store.task('$cancel-download').status, 'cancelled');
  assert.equal(store.snapshot().unknown, 0);
  assert.equal(node.lastError, null);
  assert.equal(store.snapshot().lastError, null);
  store.close();
});

test('task cancellation aborts an artifact upload and suppresses its chat delivery', async t => {
  const directory = await temporary(t);
  const store = new NodeStore(':memory:', finance.id);
  let uploading = false;
  let aborted = false;
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'token', directory,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST');
      uploading = true;
      return new Promise((resolve, reject) => {
        const abort = () => { aborted = true; options.body.destroy(); reject(new DOMException('Aborted', 'AbortError')); };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    } });
  const node = new BotNode({ participant: finance, participants: people, roomId, store, files, matrix: {}, heartbeat: async () => {},
    controlIntervalMs: 1, onError: () => {},
    tasks: { update: async () => {}, control: async () => ({ cancelRequested: uploading }) },
    bridge: { turn: async request => {
      const filename = path.join(request.workdir, 'outputs', 'result.txt');
      await writeFile(filename, 'done');
      return { status: 'completed', text: '{"text":"已完成"}', toolCalls: 1,
        artifacts: [{ path: filename, name: 'result.txt', sha256: hash('done'), size: 4 }] };
    } } });
  store.ingest([event('$cancel-upload')], 'cursor');
  await node.processOne();
  assert.equal(aborted, true);
  assert.equal(store.item('$cancel-upload').status, 'cancelled');
  assert.equal(store.task('$cancel-upload').status, 'cancelled');
  assert.equal(store.snapshot().pendingSends, 0);
  assert.equal(store.snapshot().unknown, 0);
  assert.equal(store.snapshot().lastError, null);
  store.close();
});

test('large history is bounded before and after file preparation while a replied older file is retained', async () => {
  const store = new NodeStore(':memory:', finance.id);
  const input = attachment('old-file', 'amount,100');
  const previous = Array.from({ length: 42 }, (_, index) => ({ ...event(`$history-${index}`, index === 0 ? [input] : []),
    content: { body: '中'.repeat(16000), 'org.ds_group': { to: [], attachments: index === 0 ? [input] : [] } } }));
  const latest = event('$large-history');
  latest.content['org.ds_group'].replyTo = '$history-0';
  store.ingest([...previous, latest], 'cursor');
  let preparedHistory;
  let submitted;
  const node = new BotNode({ participant: finance, participants: people, roomId, store, matrix: {}, heartbeat: async () => {},
    files: { prepare: async request => {
      preparedHistory = request.history.length;
      assert.ok(Buffer.byteLength(JSON.stringify({ ...request, async: true })) <= 500000);
      assert.equal(request.event.attachments[0].id, input.id);
      return { ...request, workdir: '/synthetic-task', files: [{ ...input, path: '/synthetic-task/input.csv',
        extraction: { type: 'csv', supported: true, warnings: ['详'.repeat(20000)] } }] };
    } },
    bridge: { turn: async request => { submitted = request; return { status: 'completed', text: '{"text":"已处理"}' }; } } });
  await node.processOne();
  assert.ok(submitted.history.length < preparedHistory);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...submitted, async: true })) <= 500000);
  assert.ok(submitted.historyWarnings.length >= 2);
  assert.equal(submitted.files[0].id, input.id);
  assert.equal(submitted.event.eventId, '$large-history');
  assert.equal(store.item('$large-history').request.history.length, submitted.history.length);
  store.close();
});

test('a connection lost during download retries from verified bytes before one model submission', async t => {
  const directory = await temporary(t);
  const store = new NodeStore(':memory:', finance.id);
  const bytes = 'department,total\nfinance,100\n';
  let downloads = 0;
  let generations = 0;
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'token', directory,
    fetchImpl: async () => {
      downloads++;
      if (downloads > 1) return new Response(bytes);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from('partial'));
        controller.error(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
      } }));
    } });
  const node = new BotNode({ participant: finance, participants: people, roomId, store, files, matrix: {}, heartbeat: async () => {},
    transferRetryDelayMs: 1, onError: () => {}, bridge: { turn: async request => {
      generations++;
      assert.equal(await readFile(request.files[0].path, 'utf8'), bytes);
      return { status: 'completed', text: '{"text":"已读取"}' };
    } } });
  store.ingest([event('$retry-stream', [attachment('stream', bytes, 'input.csv')])], 'cursor');
  await node.processOne();
  assert.equal(downloads, 2);
  assert.equal(generations, 1);
  assert.equal(store.snapshot().unknown, 0);
  assert.equal(store.snapshot().pendingSends, 1);
  store.close();
});

test('new explicit files exclude prior room files from downloads and delegation while distinct identical uploads stay distinct', async t => {
  const directory = await temporary(t);
  const old = attachment('old', 'amount\n1\n');
  const bytes = 'amount\n200\n';
  const first = attachment('new-first', bytes);
  const second = attachment('new-second', bytes);
  const downloaded = [];
  const files = new NodeFiles({ coreUrl: 'https://core.test', accessToken: 'token', directory,
    fetchImpl: async url => {
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      downloaded.push(id);
      assert.notEqual(id, old.id);
      return new Response(bytes);
    } });
  const request = { requestId: 'new-input', botId: finance.id,
    event: { senderId: people[0].id, senderKind: 'human', attachments: [first, second] },
    history: [{ eventId: '$old', senderId: people[0].id, attachments: [old] }] };
  const prepared = await files.prepare(request);
  assert.deepEqual(prepared.files.map(file => file.id), [first.id, second.id]);
  assert.notEqual(prepared.files[0].path, prepared.files[1].path);
  assert.deepEqual(downloaded, [first.id]);
  const messages = deliveriesFor(event('$fresh', [first, second]), { text: '请处理本次附件', sourceAttachments: prepared.files,
    delegate: { to: people[2].id, body: '整理本次费用' } }, finance.id, people);
  assert.deepEqual(messages.at(-1).options.attachments.map(file => file.id), [first.id, second.id]);
});

test('an unqualified followup selects the latest own artifact and excludes other people and Bots', () => {
  const ownInput = attachment('own-input', '1');
  const ownResult = attachment('own-result', '2');
  const otherHuman = attachment('other-human', '3');
  const otherBot = attachment('other-bot', '4');
  const otherRecipient = attachment('other-recipient', '5');
  const history = [
    { eventId: '1', senderId: people[0].id, attachments: [ownInput] },
    { eventId: '2', senderId: finance.id, originSenderId: people[0].id, kind: 'reply', attachments: [ownResult] },
    { eventId: '3', senderId: '@bob:server.test', attachments: [otherHuman] },
    { eventId: '4', senderId: people[2].id, originSenderId: people[0].id, kind: 'reply', attachments: [otherBot] },
    { eventId: '5', senderId: finance.id, originSenderId: '@bob:server.test', kind: 'reply', attachments: [otherRecipient] },
  ];
  const request = { botId: finance.id, event: { senderId: people[0].id, senderKind: 'human', body: '修改上一版', attachments: [] }, history };
  assert.deepEqual(selectInputAttachments(request).map(file => file.id), [ownResult.id]);
  const latestInput = attachment('new-own-input', '6');
  assert.deepEqual(selectInputAttachments({ ...request, history: [...history, { eventId: '6', senderId: people[0].id, attachments: [latestInput] }] }).map(file => file.id), [latestInput.id]);
  assert.deepEqual(selectInputAttachments({ ...request, event: { ...request.event, replyTo: '$text-only-reply' } }), []);
});

test('task file selection retains only its own batch, sender and task identity', () => {
  for (const kind of ['task.request', 'task.result']) {
    const source = people[2].id;
    const first = attachment(`${kind}-first`, 'first');
    const last = attachment(`${kind}-last`, 'last');
    const unrelated = attachment(`${kind}-unrelated`, 'unrelated');
    const part = { eventId: 'first', kind, senderId: source, taskId: 'family-one', fileBatch: { id: 'batch-current', index: 1, total: 2 }, attachments: [first] };
    const request = { botId: finance.id, event: { ...part, eventId: 'last', attachments: [last], fileBatch: { id: 'batch-current', index: 2, total: 2 } },
      history: [{ ...part, eventId: 'old-version', attachments: [unrelated], fileBatch: { id: 'old-batch', index: 1, total: 1 } },
        { ...part, eventId: 'other-task', taskId: 'family-two', attachments: [unrelated] },
        { ...part, eventId: 'other-sender', senderId: '@other:server.test', attachments: [unrelated] }, part] };
    assert.deepEqual(selectInputAttachments(request).map(file => file.id), [first.id, last.id]);
  }
});

test('replying to an older file batch preserves that complete batch beyond recent history', () => {
  const store = new NodeStore(':memory:', finance.id);
  const first = attachment('old-batch-first', 'first');
  const last = attachment('old-batch-last', 'last');
  const batch = [first, last].map((file, index) => ({ ...event(`$batch-${index}`, [file]), sender: finance.id,
    content: { body: '成果文件', 'org.ds_group': { to: [], attachments: [file], kind: 'reply', taskId: 'old-task',
      originSenderId: people[0].id, fileBatch: { id: 'old-result-batch', index: index + 1, total: 2 } } } }));
  const filler = Array.from({ length: 42 }, (_, index) => ({ ...event(`$filler-${index}`), content: { body: '其他消息', 'org.ds_group': { to: [] } } }));
  const latest = event('$reply-old-batch');
  latest.content['org.ds_group'].replyTo = '$batch-1';
  store.ingest([...batch, ...filler, latest], 'cursor');
  const node = new BotNode({ participant: finance, participants: people, roomId, store, heartbeat: async () => {}, bridge: {}, matrix: {} });
  const request = node.requestFor(store.next());
  assert.equal(request.history.some(previous => previous.eventId.startsWith('$batch-')), false);
  assert.deepEqual(selectInputAttachments(request).map(file => file.id), [first.id, last.id]);
  store.close();
});

test('Matrix messages retain explicit batch identity and omit it for ordinary messages', async () => {
  const matrix = new MatrixClient({ baseUrl: 'https://matrix.test', accessToken: 'token' });
  const sent = [];
  matrix.request = async (method, route, body) => { sent.push(body); return { event_id: `$${sent.length}` }; };
  const batch = { id: 'reply-files', index: 1, total: 2 };
  await matrix.send(roomId, '附件', { attachments: [attachment('output', 'data')], fileBatch: batch });
  await matrix.send(roomId, '普通消息');
  assert.deepEqual(sent[0]['org.ds_group'].fileBatch, batch);
  assert.equal(Object.hasOwn(sent[1]['org.ds_group'], 'fileBatch'), false);
  assert.throws(() => matrix.send(roomId, 'bad', { fileBatch: { id: 'bad', index: 3, total: 2 } }), /Invalid attachment batch/);
});

test('delegation excludes unchanged derived copies while preserving every original input and changed artifact', () => {
  const first = attachment('original-one', 'amount\n100\n', 'expenses.csv');
  const second = attachment('original-two', 'amount\n100\n', 'expenses.csv');
  const unchangedCopy = attachment('derived-copy', 'amount\n100\n', 'expenses.csv');
  const changed = attachment('derived-changed', 'amount\n200\n', 'expenses.csv');
  const renamed = attachment('derived-renamed', 'amount\n100\n', 'reviewed-expenses.csv');
  const output = { text: '请人事继续处理', sourceAttachments: [first, second], attachments: [unchangedCopy, changed, renamed],
    delegate: { to: people[2].id, body: '处理这两份输入和更新后的文件' } };
  const messages = deliveriesFor(event('$derived', [first, second]), output, finance.id, people);
  assert.deepEqual(messages[0].options.attachments.map(file => file.id), [changed.id, renamed.id]);
  assert.deepEqual(messages[1].options.attachments.map(file => file.id), [first.id, second.id, changed.id, renamed.id]);
  const onlyUnchanged = deliveriesFor(event('$only-copy', [first, second]), { ...output, attachments: [unchangedCopy] }, finance.id, people);
  assert.equal(onlyUnchanged[0].options.attachments, undefined);
  assert.deepEqual(onlyUnchanged[1].options.attachments.map(file => file.id), [first.id, second.id]);
  const ordinaryReply = deliveriesFor(event('$ordinary', [first, second]), { text: '这是成果', attachments: [unchangedCopy] }, finance.id, people);
  assert.deepEqual(ordinaryReply[0].options.attachments.map(file => file.id), [unchangedCopy.id]);
});
