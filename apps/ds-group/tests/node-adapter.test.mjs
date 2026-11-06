import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotNode, parseBotOutput, deliveriesFor, createBridge, acquireNodeLock } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';

const participants = [
  { id: '@alice:ds-group.local', localpart: 'alice', name: 'Alice', kind: 'human' },
  { id: '@bob:ds-group.local', localpart: 'bob', name: 'Bob', kind: 'human' },
  { id: '@finance:ds-group.local', localpart: 'finance', name: '财务', kind: 'bot' },
  { id: '@hr:ds-group.local', localpart: 'hr', name: '人事', kind: 'bot' },
];
const finance = participants[2];
const hr = participants[3];
const roomId = '!group:ds-group.local';
const event = (id, metadata = {}, extra = {}) => ({ event_id: id, type: 'm.room.message', room_id: roomId,
  sender: participants[0].id, content: { body: '请核算 100 + 200', 'org.ds_group': { to: [finance.id], ...metadata } }, ...extra });

function fixture({ matrix = {}, bridge = {} } = {}) {
  const store = new NodeStore(':memory:', finance.id);
  const node = new BotNode({ participant: finance, participants, roomId, store, matrix, bridge,
    heartbeat: async () => {}, pollTimeout: 0, onError: () => {} });
  return { node, store };
}

test('heartbeat refreshes the model after an independent runtime restart and clears an unavailable model', async () => {
  let model = 'first/chat';
  const bridge = createBridge('http://fixture.invalid', { fetchImpl: async url => {
    assert.equal(url.pathname, '/api/ds-group-node/status');
    if (!model) throw new Error('runtime restarting');
    return Response.json({ model });
  } });
  const { node, store } = fixture({ bridge });
  const sent = [];
  node.sendHeartbeat = async heartbeat => sent.push(heartbeat);
  try {
    await node.heartbeat();
    model = 'second/team/chat';
    await node.heartbeat();
    model = null;
    await node.heartbeat();
    assert.deepEqual(sent.map(heartbeat => heartbeat.model), ['first/chat', 'second/team/chat', null]);
  } finally { store.close(); }
});

test('synthetic response protocol accepts text/JSON and validates explicit delegation', () => {
  assert.deepEqual(parseBotOutput('普通回复', finance.id, participants), { text: '普通回复' });
  assert.deepEqual(parseBotOutput('```json\n{"text":"收到","delegate":{"to":"@hr:ds-group.local","body":"整理名单"}}\n```', finance.id, participants),
    { text: '收到', delegate: { to: hr.id, body: '整理名单' } });
  assert.throws(() => parseBotOutput('{"text":"x","delegate":{"to":"@finance:ds-group.local","body":"x"}}', finance.id, participants), /delegation/);
  assert.throws(() => parseBotOutput('{"text":"x","delegate":{"to":"@alice:ds-group.local","body":"x"}}', finance.id, participants), /delegation/);
  assert.throws(() => parseBotOutput('{"delegate":{"to":"@hr:ds-group.local","body":"x"}}', finance.id, participants), /non-empty text/);
});

test('synthetic delegation produces stable transactions and result routing returns once to the requesting Bot', () => {
  const original = event('$alice', { to: [hr.id] });
  const deliveries = deliveriesFor(original, { text: '财务帮忙核算', delegate: { to: finance.id, body: '100+200' } }, hr.id, participants);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[1].options.to, [finance.id]);
  assert.equal(deliveries[1].options.returnTo, hr.id);
  assert.equal(deliveries[1].options.originSenderId, participants[0].id);
  assert.equal(deliveries[1].options.kind, 'task.request');
  assert.deepEqual(deliveriesFor(original, { text: '财务帮忙核算', delegate: { to: finance.id, body: '100+200' } }, hr.id, participants), deliveries);
  const requested = event('$hr', deliveries[1].options, { sender: hr.id });
  const result = deliveriesFor(requested, { text: '300' }, finance.id, participants)[0];
  assert.deepEqual(result.options.to, [hr.id]);
  assert.equal(result.options.kind, 'task.result');
  const returned = event('$finance', result.options, { sender: finance.id });
  const summary = deliveriesFor(returned, { text: 'Alice，结果是300' }, hr.id, participants)[0];
  assert.deepEqual(summary.options.to, []);
  assert.equal(summary.options.taskId, deliveries[1].options.taskId);
  assert.throws(() => deliveriesFor(event('$loop', { hop: 4 }), { text: '继续', delegate: { to: hr.id, body: '继续' } }, finance.id, participants), /hop limit/);
});

test('synthetic private-chat delegation goes through the shared room and returns to the original private message', () => {
  const dmRoom = '!alice-hr:ds-group.local';
  const original = event('$private-request', { to: [hr.id] }, { room_id: dmRoom });
  const deliveries = deliveriesFor(original, { text: '请财务核算', delegate: { to: finance.id, body: '100+200' } }, hr.id, participants, roomId);
  assert.equal(deliveries[0].roomId, dmRoom);
  assert.equal(deliveries[0].options.replyTo, '$private-request');
  const delegation = deliveries[1];
  assert.equal(delegation.roomId, roomId);
  assert.equal(delegation.options.replyTo, undefined);
  assert.equal(delegation.options.originRoomId, dmRoom);
  assert.equal(delegation.options.originEventId, '$private-request');
  const requested = event('$hr-delegate', delegation.options, { sender: hr.id });
  const result = deliveriesFor(requested, { text: '300' }, finance.id, participants, roomId)[0];
  assert.equal(result.roomId, roomId);
  assert.equal(result.options.replyTo, '$hr-delegate');
  assert.deepEqual(result.options.to, [hr.id]);
  const summary = deliveriesFor(event('$finance-result', result.options, { sender: finance.id }), { text: 'Alice，合计300' }, hr.id, participants, roomId)[0];
  assert.equal(summary.roomId, dmRoom);
  assert.equal(summary.options.replyTo, '$private-request');
  assert.deepEqual(summary.options.to, []);
});

test('synthetic adapter persists generation once and retries only pending Matrix sends with identical transaction', async () => {
  let calls = 0;
  const sent = [];
  const { node, store } = fixture({
    bridge: { async turn(input) { calls++; assert.equal(input.event.senderId, participants[0].id); return { status: 'completed', text: '{"text":"300"}', sessionId: 'native-1' }; } },
    matrix: { async send(room, body, options) { sent.push({ room, body, options }); if (sent.length === 1) throw new Error('lost receipt'); return { event_id: '$answer' }; } },
  });
  store.ingest([event('$a')], 's1');
  await node.processOne();
  assert.equal(calls, 1);
  assert.equal(store.snapshot().pendingSends, 1);
  await assert.rejects(node.processOne(), /lost receipt/);
  await node.processOne();
  assert.equal(calls, 1);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(store.snapshot().processed, 1);
  assert.equal(await node.processOne(), false);
  store.close();
});

test('synthetic transport failure ends the inbox as unknown without a second model call', async () => {
  let calls = 0;
  const { node, store } = fixture({ bridge: { async turn() { calls++; throw Object.assign(new Error('connection interrupted'), { networkError: true }); } } });
  store.ingest([event('$a')], 's1');
  await node.processOne();
  await node.processOne();
  assert.equal(calls, 1);
  assert.equal(store.snapshot().unknown, 1);
  store.close();
});

test('synthetic permanent send rejection ends that operation and allows the next conversation to proceed', async () => {
  const requests = [];
  const { node, store } = fixture({
    bridge: { async turn(input) { requests.push(input); return { status: 'completed', text: '{"text":"回答"}', sessionId: 'native-1' }; } },
    matrix: { async send() { throw Object.assign(new Error('not a room member'), { status: 403 }); } },
  });
  store.ingest([event('$first'), event('$second')], 's1');
  await node.processOne();
  await node.processOne();
  assert.equal(store.pendingDelivery(), undefined);
  assert.equal(store.snapshot().failed, 1);
  await node.processOne();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].event.eventId, '$second');
  store.close();
});

test('synthetic sync continues during a blocked generation and keeps the same Bot queue ordered', async () => {
  let release;
  const generated = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { node, store } = fixture({ bridge: { async turn(input) { calls.push(input.event.eventId); await generated; return { status: 'completed', text: '{"text":"完成"}', sessionId: 'native-1' }; } },
    matrix: { async sync() { return { next_batch: 's2', rooms: { join: { [roomId]: { timeline: { events: [event('$b')] } } } } }; } },
  });
  store.ingest([event('$a')], 's1');
  const running = node.processOne();
  await node.syncOnce();
  assert.equal(store.cursor(), 's2');
  assert.equal(store.snapshot().pending, 2);
  assert.deepEqual(calls, ['$a']);
  release();
  await running;
  assert.equal(store.next().event_id, '$b');
  store.close();
});

test('synthetic Bot processing is serial per identity while two independent nodes overlap', async () => {
  let release;
  const firstRound = new Promise(resolve => { release = resolve; });
  const active = new Map();
  const maximum = new Map();
  let total = 0;
  let maxTotal = 0;
  const bridge = { async turn(input) {
    const current = (active.get(input.botId) || 0) + 1;
    active.set(input.botId, current);
    maximum.set(input.botId, Math.max(maximum.get(input.botId) || 0, current));
    maxTotal = Math.max(maxTotal, ++total);
    await firstRound;
    active.set(input.botId, current - 1);
    total--;
    return { status: 'completed', text: '{"text":"完成"}', sessionId: `native-${input.botId}` };
  } };
  const matrix = { async send(room, body, options) { return { event_id: `$${options.transactionId}` }; } };
  const first = fixture({ bridge, matrix });
  const secondStore = new NodeStore(':memory:', hr.id);
  const second = new BotNode({ participant: hr, participants, roomId, matrix, bridge, store: secondStore, heartbeat: async () => {}, onError: () => {} });
  first.store.ingest([event('$finance-a'), event('$finance-b')], 's1');
  secondStore.ingest([event('$hr-a', { to: [hr.id] })], 's1');
  const work = [first.node.processLoop(), second.processLoop()];
  assert.equal(total, 2);
  assert.equal(first.store.next().event_id, '$finance-b');
  release();
  for (let attempt = 0; attempt < 100 && first.store.snapshot().processed < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(first.store.snapshot().processed, 2);
  assert.equal(secondStore.snapshot().processed, 1);
  assert.equal(maxTotal, 2);
  assert.equal(maximum.get(finance.id), 1);
  assert.equal(maximum.get(hr.id), 1);
  first.node.controller.abort();
  second.controller.abort();
  await Promise.all(work);
  first.store.close();
  secondStore.close();
});

test('synthetic sync fills limited history and includes direct-message rooms before advancing cursor', async () => {
  const dm = '!dm:ds-group.local';
  const { node, store } = fixture({ matrix: {
    async sync() { return { next_batch: 's2', rooms: { join: {
      [roomId]: { timeline: { limited: true, prev_batch: 'back', events: [event('$c')] } },
      [dm]: { timeline: { events: [event('$dm', {}, { room_id: undefined })] } },
    } } }; },
    async request(method, url) { assert.equal(method, 'GET'); assert.match(url, /from=back/); return { chunk: [event('$b'), event('$a')], end: 'previous' }; },
  } });
  store.ingest([event('$a', { to: [] })], 's1');
  await node.syncOnce();
  assert.equal(store.cursor(), 's2');
  assert.equal(store.hasEvent('$b'), true);
  assert.equal(store.next().event_id, '$b');
  const dmEvent = JSON.parse(store.db.prepare('SELECT event_json FROM messages WHERE event_id=?').get('$dm').event_json);
  assert.equal(dmEvent.room_id, dm);
  assert.deepEqual(store.historyBefore('$dm'), []);
  store.close();
});

test('synthetic history pagination failure preserves the old cursor and does not partially ingest', async () => {
  const { node, store } = fixture({ matrix: {
    async sync() { return { next_batch: 'new', rooms: { join: { [roomId]: { timeline: { limited: true, prev_batch: 'back', events: [event('$new')] } } } } }; },
    async request() { throw new Error('history unavailable'); },
  } });
  store.ingest([], 'old');
  await assert.rejects(node.syncOnce(), /history unavailable/);
  assert.equal(store.cursor(), 'old');
  assert.equal(store.hasEvent('$new'), false);
  store.close();
});

test('synthetic bridge reports unreadable and server-error receipts as uncertain', async () => {
  const unreadable = createBridge('http://fixture.invalid', { fetchImpl: async () => new Response('bad', { status: 200 }) });
  await assert.rejects(unreadable.turn({ requestId: 'r1' }), error => error.networkError === true);
  const serverError = createBridge('http://fixture.invalid', { fetchImpl: async () => Response.json({ error: 'server failure' }, { status: 500 }) });
  await assert.rejects(serverError.turn({ requestId: 'r1' }), error => error.networkError === true);
});

test('local process ownership prevents concurrent writers for the same Bot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-node-lock-'));
  const filename = path.join(directory, 'process.lock');
  const release = await acquireNodeLock(filename);
  await assert.rejects(acquireNodeLock(filename), /already has a local process/);
  await release();
  const releaseAgain = await acquireNodeLock(filename);
  await releaseAgain();
  await rm(directory, { recursive: true, force: true });
});
