import test from 'node:test';
import assert from 'node:assert/strict';
import { BotNode, deliveriesFor } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';

const alice = { id: '@alice:thread.test', name: 'Alice', kind: 'human' };
const one = { id: '@one:thread.test', name: 'One', kind: 'bot' };
const two = { id: '@two:thread.test', name: 'Two', kind: 'bot' };
const participants = [alice, one, two];
const group = '!group:thread.test';
const privateRoom = '!private:thread.test';
function event(id, { sender = alice.id, roomId = group, root, replyTo, meta = {} } = {}) {
  return { type: 'm.room.message', event_id: id, room_id: roomId, sender,
    content: { msgtype: 'm.text', body: '一起讨论一下。', 'org.ds_group': { to: [one.id], ...meta },
      ...(root || replyTo ? { 'm.relates_to': { ...(root ? { rel_type: 'm.thread', event_id: root } : {}),
        ...(replyTo ? { 'm.in_reply_to': { event_id: replyTo } } : {}) } } : {}) } };
}
const received = (delivery, id, sender) => event(id, { sender, roomId: delivery.roomId,
  root: delivery.options.threadRootId, replyTo: delivery.options.replyTo, meta: delivery.options });

test('a thread reply preserves its root separately from its quoted message', () => {
  const input = event('$question', { root: '$thread-root', replyTo: '$earlier-comment' });
  const [delivery] = deliveriesFor(input, { text: '一起去吧。' }, one.id, participants);
  assert.equal(delivery.roomId, group);
  assert.equal(delivery.options.replyTo, '$question');
  assert.equal(delivery.options.threadRootId, '$thread-root');
  assert.equal(delivery.options.originThreadRootId, '$thread-root');
});

test('same-room delegation and its final result remain in the original human thread', () => {
  const input = event('$human-task', { root: '$human-thread' });
  const [ack, delegated] = deliveriesFor(input,
    { text: '我们一起看下。', delegate: { to: two.id, body: '帮我核对时间。' } }, one.id, participants, group);
  assert.equal(ack.options.threadRootId, '$human-thread');
  assert.equal(delegated.options.threadRootId, '$human-thread');
  assert.equal(delegated.options.originThreadRootId, '$human-thread');
  const peerInput = received(delegated, '$peer-request', one.id);
  const [peerResult] = deliveriesFor(peerInput, { text: '时间核对完成。' }, two.id, participants, group);
  assert.equal(peerResult.options.kind, 'task.result');
  assert.equal(peerResult.options.replyTo, '$peer-request');
  assert.equal(peerResult.options.threadRootId, '$human-thread');
  const [final] = deliveriesFor(received(peerResult, '$peer-result', two.id), { text: '明天十点出发。' }, one.id, participants, group);
  assert.equal(final.roomId, group);
  assert.equal(final.options.replyTo, '$human-task');
  assert.equal(final.options.threadRootId, '$human-thread');
  assert.deepEqual(final.options.to, []);
});

test('cross-room delegation carries origin metadata without placing a foreign thread in the peer room', () => {
  const input = event('$private-task', { roomId: privateRoom, root: '$private-thread' });
  const [ack, delegated] = deliveriesFor(input,
    { text: '请雨禾帮忙。', delegate: { to: two.id, body: '核对具体时间。' } }, one.id, participants, group);
  assert.equal(ack.roomId, privateRoom);
  assert.equal(ack.options.threadRootId, '$private-thread');
  assert.equal(delegated.roomId, group);
  assert.equal(delegated.options.replyTo, undefined);
  assert.equal(delegated.options.threadRootId, undefined);
  assert.equal(delegated.options.originThreadRootId, '$private-thread');
  const [peerResult] = deliveriesFor(received(delegated, '$cross-peer', one.id), { text: '十点。' }, two.id, participants, group);
  assert.equal(peerResult.roomId, group);
  assert.equal(peerResult.options.threadRootId, undefined);
  assert.equal(peerResult.options.originThreadRootId, '$private-thread');
  const [final] = deliveriesFor(received(peerResult, '$cross-result', two.id), { text: '明天十点。' }, one.id, participants, group);
  assert.equal(final.roomId, privateRoom);
  assert.equal(final.options.replyTo, '$private-task');
  assert.equal(final.options.threadRootId, '$private-thread');
});

test('peer threads can differ from the origin while final success and failure use the original thread', () => {
  for (const kind of ['task.result', 'task.failure']) {
    const input = event(`$${kind}`, { sender: two.id, root: '$peer-thread', meta: { kind,
      originRoomId: privateRoom, originEventId: '$original-question', originSenderId: alice.id, originThreadRootId: '$original-thread' } });
    const [delivery] = deliveriesFor(input, { text: '这是最终进展。', failure: kind === 'task.failure' }, one.id, participants);
    assert.equal(delivery.roomId, privateRoom);
    assert.equal(delivery.options.threadRootId, '$original-thread');
    assert.equal(delivery.options.replyTo, '$original-question');
  }
});

test('every attachment part preserves current and origin threads through a full delegation round trip', () => {
  const attachments = Array.from({ length: 21 }, (_, i) => ({ id: `file-${i}`, name: `file-${i}.txt`, mimeType: 'text/plain',
    size: 1, sha256: String(i).padStart(64, '0'), contentUri: `mxc://thread.test/file-${i}` }));
  const input = event('$many-files', { root: '$files-thread' });
  const deliveries = deliveriesFor(input, { text: '附件都在这里。', attachments,
    delegate: { to: two.id, body: '请逐份核对。' } }, one.id, participants);
  assert.equal(deliveries.length, 6);
  for (const delivery of deliveries) {
    assert.equal(delivery.options.threadRootId, '$files-thread');
    assert.equal(delivery.options.originThreadRootId, '$files-thread');
  }
  const delegated = deliveries.filter(delivery => delivery.options.kind === 'task.request');
  assert.deepEqual(delegated.map(delivery => delivery.options.to), [[], [], [two.id]]);
  const [peerResult] = deliveriesFor(received(delegated.at(-1), '$many-files-peer', one.id),
    { text: '核对完成。', attachments }, two.id, participants);
  const returned = received(peerResult, '$many-files-result', two.id);
  const finalParts = deliveriesFor(returned, { text: '核对结果。', attachments }, one.id, participants);
  assert.equal(finalParts.length, 3);
  assert(finalParts.every(delivery => delivery.options.threadRootId === '$files-thread' && delivery.options.replyTo === '$many-files'));
});

test('reply quotes and claimed human metadata never invent a thread for unthreaded chat', () => {
  const input = event('$plain', { replyTo: '$quoted', meta: { originThreadRootId: '$claimed-thread' } });
  const [delivery] = deliveriesFor(input, { text: '普通回复。' }, one.id, participants);
  assert.equal(delivery.options.threadRootId, undefined);
  assert.equal(delivery.options.originThreadRootId, undefined);
  assert.equal(delivery.options.replyTo, '$plain');
});

test('native request fields preserve the actual thread and the separately attributed task origin', t => {
  const store = new NodeStore(':memory:', one.id); t.after(() => store.close());
  const node = new BotNode({ participant: one, participants, roomId: group, store, matrix: {}, bridge: {}, heartbeat: async () => {} });
  const human = event('$request-human', { root: '$actual-root', meta: { originThreadRootId: '$spoof-root' } });
  const peer = event('$request-peer', { sender: two.id, root: '$peer-root', meta: { kind: 'task.result',
    originRoomId: privateRoom, originEventId: '$human-origin', originThreadRootId: '$human-root', originSenderId: alice.id } });
  store.ingest([human, peer]);
  const humanRequest = node.requestFor(store.item('$request-human'));
  assert.equal(humanRequest.event.threadRootId, '$actual-root');
  assert.equal(humanRequest.event.originThreadRootId, '$actual-root');
  assert.equal(humanRequest.context.source.threadRootId, '$actual-root');
  const peerRequest = node.requestFor(store.item('$request-peer'));
  assert.equal(peerRequest.event.threadRootId, '$peer-root');
  assert.equal(peerRequest.event.originThreadRootId, '$human-root');
  assert.equal(peerRequest.context.source.threadRootId, '$peer-root');
});
