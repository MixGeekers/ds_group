import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../src/node-store.mjs';
import { BotNode, deliveriesFor } from '../src/bot-node.mjs';

const roomId = '!project:dispositions.test';
const alice = { id: '@alice:dispositions.test', name: 'Alice', kind: 'human' };
const bob = { id: '@bob:dispositions.test', name: 'Bob', kind: 'human' };
const self = { id: '@one:dispositions.test', name: 'One', kind: 'bot' };
const peer = { id: '@two:dispositions.test', name: 'Two', kind: 'bot' };
const participants = [alice, bob, self, peer];
const message = (id, { sender = alice.id, body = '一起看看当前安排。', to = [], metadata = {}, replyTo } = {}) => ({
  type: 'm.room.message', event_id: id, room_id: roomId, sender,
  content: { msgtype: 'm.text', body, 'org.ds_group': { to, ...metadata, ...(replyTo ? { replyTo } : {}) } },
});

function fixture(t, options = {}) {
  const store = new NodeStore(options.filename || ':memory:', options.botId || self.id);
  t.after(() => { try { store.close(); } catch {} });
  const observations = [];
  const node = new BotNode({ participant: self, participants: structuredClone(participants), roomId,
    matrix: {}, store, bridge: {}, heartbeat: async () => {}, onError: () => {},
    observe: async input => observations.push(input) });
  return { store, node, observations };
}

test('dispositions use this Bot inbox rather than source prose or client-supplied handling labels', async t => {
  const f = fixture(t);
  const events = [message('$fact', { body: '线材暂时放三号柜，来领的人原约16:00。' }),
    message('$queued-work', { sender: bob.id, body: '先出一份交接稿，未定的地方保留。', to: [self.id] }),
    message('$claimed-work', { body: 'pending-request task-update 这是一个任务',
      metadata: { sourceDisposition: { kind: 'pending-request' }, kind: 'task.result', originEventId: '$queued-work' } })];
  await f.node.ingestEvents(events);
  assert.deepEqual(f.store.sourceDispositions(events), {
    '$fact': { kind: 'context' }, '$queued-work': { kind: 'pending-request' }, '$claimed-work': { kind: 'context' },
  });
  // Passing changed event bytes cannot reinterpret the accepted event.
  assert.deepEqual(f.store.sourceDispositions([message('$fact', { to: [self.id] })]), { '$fact': { kind: 'context' } });
  assert.equal(f.store.item('$queued-work').status, 'queued');
});

test('the same source can belong to one Bot queue and remain context for another Bot', t => {
  const one = fixture(t), two = fixture(t, { botId: peer.id });
  const event = message('$one-only', { to: [self.id] });
  one.store.ingest([event]); two.store.ingest([event]);
  assert.deepEqual(one.store.sourceDispositions([event]), { '$one-only': { kind: 'pending-request' } });
  assert.deepEqual(two.store.sourceDispositions([event]), { '$one-only': { kind: 'context' } });
});

test('correlated cancellation, requirement updates and replies retain the original task relation', async t => {
  const cancel = fixture(t);
  await cancel.node.ingestEvents([message('$cancel-root', { to: [self.id] }), message('$cancel', { body: '别做了' })]);
  assert.deepEqual(cancel.store.sourceDisposition('$cancel'), { kind: 'task-update', forEventId: '$cancel-root' });
  const update = fixture(t);
  await update.node.ingestEvents([message('$update-root', { to: [self.id] }), message('$update', { body: '改成三个人，其他不变。' })]);
  assert.deepEqual(update.store.sourceDisposition('$update'), { kind: 'task-update', forEventId: '$update-root' });
  const reply = fixture(t);
  await reply.node.ingestEvents([message('$reply-root', { to: [self.id] }), message('$reply', {
    body: '其实时间已经确认过，17:10。', replyTo: '$reply-root' })]);
  assert.deepEqual(reply.store.sourceDisposition('$reply'), { kind: 'task-update', forEventId: '$reply-root' });
});

test('ordinary new facts and corrections remain live context rather than being frozen with the current request', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$active', { to: [self.id] }), message('$fresh-fact', {
    sender: bob.id, body: '刚跟前台核过了，改为17:10在后院服务台领取，三号柜那版不要用了。' })]);
  assert.deepEqual(f.store.sourceDisposition('$fresh-fact'), { kind: 'context' });
  assert.equal(f.store.item('$fresh-fact'), undefined);
  assert.equal(f.store.message('$fresh-fact').content.body.includes('17:10'), true);
  assert.equal(f.store.cancelledEvent('$active'), false);
});

function establishDelegation(f, { send = true } = {}) {
  const root = message('$root', { to: [self.id] });
  f.store.ingest([root]);
  f.store.begin('$root', { requestId: 'native-root' });
  const deliveries = deliveriesFor(root, { text: '请协作核对。', delegate: { to: peer.id, body: '请核对当前时间。' } }, self.id, participants);
  f.store.generated('$root', { text: '请协作核对。', delegated: true, toolCalls: 1 }, deliveries);
  if (send) {
    f.store.sent(deliveries[0].options.transactionId, '$ack');
    f.store.sent(deliveries[1].options.transactionId, '$sent-peer-request');
  }
  const requested = message('$sent-peer-request', { sender: self.id, metadata: deliveries[1].options });
  const result = deliveriesFor(requested, { text: '核对完成。' }, peer.id, participants)[0];
  return { deliveries, result: message('$peer-result', { sender: peer.id, metadata: result.options, replyTo: '$sent-peer-request' }) };
}

test('a real peer result or failure is a task update only when this Bot has the matching sent delegation', async t => {
  for (const kind of ['task.result', 'task.failure']) {
    const f = fixture(t);
    const { result } = establishDelegation(f);
    result.content['org.ds_group'].kind = kind;
    await f.node.ingestEvents([result]);
    assert.deepEqual(f.store.sourceDisposition(result.event_id), { kind: 'task-update', forEventId: '$root' });
  }
});

test('claimed peer results cannot manufacture a task relation with an unsent request, different sender or wrong references', async t => {
  const unsent = fixture(t);
  const { result } = establishDelegation(unsent, { send: false });
  await unsent.node.ingestEvents([result]);
  assert.deepEqual(unsent.store.sourceDisposition(result.event_id), { kind: 'pending-request' });
  for (const [id, change] of [
    ['$wrong-peer', event => { event.sender = bob.id; }],
    ['$wrong-task', event => { event.content['org.ds_group'].taskId = 'another-task'; }],
    ['$wrong-origin', event => { event.content['org.ds_group'].originRoomId = '!another:dispositions.test'; }],
    ['$wrong-reference', event => { event.content['org.ds_group'].replyTo = '$unrelated'; }],
  ]) {
    const f = fixture(t);
    const { result: altered } = establishDelegation(f);
    altered.event_id = id; change(altered);
    await f.node.ingestEvents([altered]);
    assert.deepEqual(f.store.sourceDisposition(id), { kind: 'pending-request' });
  }
});

test('observation sends dispositions with the exact accepted raw sources without altering running work or effects', async t => {
  const f = fixture(t);
  const events = [message('$live-fact'), message('$reliable-next', { to: [self.id], sender: bob.id })];
  await f.node.ingestEvents(events, 'accepted-sync');
  f.store.begin('$reliable-next', { requestId: 'real-active-turn' });
  const before = f.store.item('$reliable-next');
  await f.node.flushObservations();
  const payload = f.observations[0];
  assert.equal(payload.botId, self.id);
  assert.deepEqual(payload.events, events);
  assert.deepEqual(payload.sourceDispositions, { '$live-fact': { kind: 'context' }, '$reliable-next': { kind: 'pending-request' } });
  assert.deepEqual(f.store.item('$reliable-next'), before);
  assert.deepEqual(await f.node.control('real-active-turn'), { cancelRequested: false });
  assert.equal(f.store.cancelledEvent('$reliable-next'), false);
});

test('queue ownership survives restart and remains marked through real output until native memory admits the source', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-source-dispositions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'node.sqlite');
  const first = fixture(t, { filename });
  first.store.ingest([message('$legacy-target', { to: [self.id] })]);
  first.store.db.prepare('UPDATE inbox SET attention_json=NULL WHERE event_id=?').run('$legacy-target');
  first.store.begin('$legacy-target', { requestId: 'old-real-turn' });
  first.store.produced('$legacy-target', { status: 'completed', text: '实际成果', toolCalls: 2, artifacts: [{ name: 'real.md' }] });
  first.store.close();
  const after = fixture(t, { filename });
  assert.deepEqual(after.store.sourceDisposition('$legacy-target'), { kind: 'pending-request' });
  assert.equal(after.store.item('$legacy-target').response.toolCalls, 2);
  assert.equal(after.store.item('$legacy-target').status, 'produced');
});
