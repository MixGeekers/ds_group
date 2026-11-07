import test from 'node:test';
import assert from 'node:assert/strict';
import { BotNode, deliveriesFor } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';
import { createScriptDecisionProvider } from '../src/decision-provider.mjs';

const roomId = '!work:recheck.test';
const human = { id: '@human:recheck.test', name: 'Human', kind: 'human' };
const self = { id: '@one:recheck.test', name: 'One', kind: 'bot' };
const peer = { id: '@two:recheck.test', name: 'Two', kind: 'bot' };
const participants = [human, self, peer];
const file = { id: 'artifact-v1', name: 'current.json', sha256: 'a'.repeat(64), size: 100,
  mimeType: 'application/json', contentUri: 'mxc://recheck.test/v1' };
const message = (id, { sender = human.id, to = [], thread, body = '这是一个普通建议。' } = {}) => ({
  type: 'm.room.message', event_id: id, room_id: roomId, sender,
  content: { body, 'org.ds_group': { to }, ...(thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: thread } } : {}) },
});
function fixture(t, decide = () => ({ action: 'SPEAK' })) {
  const store = new NodeStore(':memory:', self.id); t.after(() => store.close());
  const decisions = [], turns = [], sends = [];
  const node = new BotNode({ participant: self, participants, roomId, store,
    attention: { mode: 'natural', batchMs: 0, cooldownMs: 0, coordinationMs: 0 },
    decisionProvider: createScriptDecisionProvider(input => { decisions.push(input); return decide(input); }),
    matrix: { send: async (...args) => { sends.push(args); return { event_id: `$chat-${sends.length}` }; } },
    bridge: { turn: async input => { turns.push(input); return { status: 'completed', text: '{"text":"这里有一个新的补充。"}', toolCalls: 0 }; } },
    heartbeat: async () => {}, onError: () => {},
  });
  return { node, store, decisions, turns, sends };
}
async function beginHumanWork(f, { thread } = {}) {
  const source = message('$human-request', { to: [self.id], thread, body: '请生成当前数据文件。' });
  await f.node.ingestEvents([source]);
  f.store.begin(source.event_id, { requestId: 'human-work', event: { eventId: source.event_id, roomId } });
  f.store.updateTask(source.event_id, { requestId: 'human-work', status: 'running', stage: 'working', summary: '正在生成' });
  f.node.state = 'thinking';
  return source;
}
function completeHumanWork(f, source, { deliver = true } = {}) {
  const response = { status: 'completed', text: '{"text":"当前数据文件已完成。"}', toolCalls: 2,
    artifacts: [{ ...file, path: '/synthetic/current.json' }], deliveredArtifacts: [file] };
  const deliveries = deliveriesFor(source, { text: '当前数据文件已完成。', attachments: [file] }, self.id, participants);
  f.store.generated(source.event_id, response, deliveries);
  if (deliver) {
    f.store.sent(deliveries[0].options.transactionId, '$human-result');
    f.node.finishDeliveryState(f.store.delivery(deliveries[0].options.transactionId));
    f.node.state = 'idle';
  }
  return deliveries[0];
}

test('a proposal made during work is decided again after that work delivers, with the new receipt and self message', async t => {
  const f = fixture(t, input => ({ action: input.workView.recentReceipts.some(receipt => receipt.deliveries.some(send => send.status === 'sent')) ? 'LISTEN' : 'SPEAK' }));
  const source = await beginHumanWork(f);
  await f.node.ingestEvents([message('$bot-advice', { sender: peer.id })]);
  await f.node.processAttentionOnce();
  const first = f.store.item('$bot-advice').attention;
  assert.equal(f.decisions[0].workView.tasks[0].status, 'running');
  completeHumanWork(f, source);
  await f.node.ingestEvents([message('$human-result', { sender: self.id, body: '当前数据文件已经送达。' })]);
  await f.node.processOne();
  assert.equal(f.turns.length, 0, 'old proposal must never start a native turn');
  assert.equal(f.store.attentionDecision(first.decisionId).outcome, 'work_state_changed');
  assert.equal(f.store.item('$bot-advice').status, 'cancelled');
  await f.node.processAttentionOnce();
  assert.equal(f.decisions.length, 2);
  const latest = f.decisions[1];
  assert.notEqual(latest.workView.stateVersion, first.workStateVersion);
  assert.equal(latest.trigger.reason, 'work_state_changed');
  assert(latest.recentMessages.some(row => row.eventId === '$human-result'));
  const receipt = latest.workView.recentReceipts.find(row => row.eventId === source.event_id);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.toolCalls, 2);
  assert.equal(receipt.artifacts[0].sha256, file.sha256);
  assert.equal(receipt.deliveries[0].eventId, '$human-result');
  assert.equal(JSON.stringify(receipt).includes('/synthetic/'), false);
  assert.equal(await f.node.processOne(), false);
  assert.equal(f.store.item(source.event_id).response.artifacts[0].sha256, file.sha256);
});

test('a fresh SPEAK decision can still contribute once after a work change without reusing the stale context', async t => {
  const f = fixture(t);
  const source = await beginHumanWork(f);
  await f.node.ingestEvents([message('$valuable-advice', { sender: peer.id })]);
  await f.node.processAttentionOnce();
  const old = f.store.item('$valuable-advice').attention;
  completeHumanWork(f, source);
  await f.node.processOne(); await f.node.processAttentionOnce();
  const fresh = f.store.item('$valuable-advice').attention;
  assert.notEqual(fresh.decisionId, old.decisionId);
  assert.notEqual(fresh.workStateVersion, old.workStateVersion);
  assert.equal(f.store.item('$valuable-advice').status, 'queued');
  await f.node.processOne(); await f.node.processOne();
  assert.equal(f.turns.length, 1);
  assert.equal(f.turns[0].context.attention.decisionId, fresh.decisionId);
  assert.equal(f.turns[0].context.attention.workView.recentReceipts[0].status, 'completed');
  assert.equal(f.sends.length, 1);
});

test('enqueuing a natural proposal does not invalidate itself or create a decision loop', async t => {
  const f = fixture(t);
  const initial = f.store.attentionWorkView(roomId).stateVersion;
  await f.node.ingestEvents([message('$proposal', { sender: peer.id })]);
  await f.node.processAttentionOnce();
  assert.equal(f.store.attentionWorkView(roomId).stateVersion, initial);
  await f.node.processOne(); await f.node.processOne();
  assert.equal(f.decisions.length, 1);
  assert.equal(f.turns.length, 1);
  assert.equal(f.store.item('$proposal').status, 'completed');
});

test('generation completion, task completion and Matrix receipts each change the work facts', async t => {
  const f = fixture(t);
  const source = await beginHumanWork(f);
  const running = f.store.attentionWorkView(roomId).stateVersion;
  f.store.produced(source.event_id, { status: 'completed', text: '已生成', toolCalls: 1 });
  const produced = f.store.attentionWorkView(roomId).stateVersion;
  assert.notEqual(produced, running);
  const delivery = completeHumanWork(f, source, { deliver: false });
  const generated = f.store.attentionWorkView(roomId).stateVersion;
  assert.notEqual(generated, produced);
  f.store.sent(delivery.options.transactionId, '$actual-send');
  const sent = f.store.attentionWorkView(roomId).stateVersion;
  assert.notEqual(sent, generated);
  f.node.finishDeliveryState(f.store.delivery(delivery.options.transactionId));
  assert.notEqual(f.store.attentionWorkView(roomId).stateVersion, sent);
  assert.equal(f.store.attentionWorkView(roomId).recentReceipts[0].deliveries[0].eventId, '$actual-send');
});

test('work in another thread does not invalidate this thread participation', async t => {
  const f = fixture(t);
  const source = await beginHumanWork(f, { thread: '$other-thread' });
  await f.node.ingestEvents([message('$separate-advice', { sender: peer.id, thread: '$this-thread' })]);
  await f.node.processAttentionOnce();
  assert.equal(f.decisions[0].threadRootId, '$this-thread');
  assert.deepEqual(f.decisions[0].workView.tasks, []);
  completeHumanWork(f, source);
  await f.node.processOne();
  assert.equal(f.decisions.length, 1);
  assert.equal(f.turns.length, 1);
});

test('progress timestamps and rechecked unstarted proposals do not manufacture work changes', async t => {
  const f = fixture(t);
  const source = await beginHumanWork(f);
  const original = f.store.attentionWorkView(roomId).stateVersion;
  f.store.updateTask(source.event_id, { requestId: 'human-work', status: 'running', stage: 'working', summary: '状态仍在运行', updatedAt: 'later' });
  assert.equal(f.store.attentionWorkView(roomId).stateVersion, original);
  await f.node.ingestEvents([message('$queued', { sender: peer.id })]);
  await f.node.processAttentionOnce();
  f.store.recheckQueuedAttention('$queued');
  assert.equal(f.store.attentionWorkView(roomId).stateVersion, original);
});

test('reevaluation keeps the original expiry and does not revive missed casual suggestions', async t => {
  const f = fixture(t);
  const source = await beginHumanWork(f);
  await f.node.ingestEvents([message('$time-limited', { sender: peer.id })]);
  await f.node.processAttentionOnce();
  const expiry = f.store.item('$time-limited').attention.expiresAt;
  completeHumanWork(f, source);
  await f.node.processOne();
  const row = f.store.db.prepare('SELECT expires_at,status FROM attention_events WHERE event_id=?').get('$time-limited');
  assert.equal(row.expires_at, expiry);
  assert.equal(row.status, 'queued');
  f.store.db.prepare('UPDATE attention_events SET expires_at=? WHERE event_id=?').run(Date.now() - 1, '$time-limited');
  assert.equal(await f.node.processAttentionOnce(), false);
  assert.equal(f.decisions.length, 1);
  assert.equal(f.turns.length, 0);
});

test('work changes cannot reset a natural request which has already started or has a real generation receipt', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$already-started', { sender: peer.id })]);
  await f.node.processAttentionOnce();
  const request = f.node.requestFor(f.store.item('$already-started'));
  f.store.begin('$already-started', request);
  assert.equal(f.store.recheckQueuedAttention('$already-started'), false);
  assert.deepEqual(f.store.item('$already-started').request, request);
  f.store.produced('$already-started', { status: 'completed', text: '实际工具已完成', toolCalls: 2, artifacts: [{ name: 'actual.txt' }] });
  assert.equal(f.store.recheckQueuedAttention('$already-started'), false);
  assert.equal(f.store.item('$already-started').response.toolCalls, 2);
  assert.equal(f.store.item('$already-started').status, 'produced');
});

test('many queued natural proposals cannot crowd actual work out of its state snapshot', async t => {
  const f = fixture(t);
  const source = await beginHumanWork(f);
  for (let i = 0; i < 45; i++) {
    await f.node.ingestEvents([message(`$advice-${i}`)]);
    await f.node.processAttentionOnce();
  }
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE status='queued' AND json_extract(attention_json,'$.kind')='natural'").get().count, 45);
  assert(f.store.attentionWorkView(roomId).tasks.some(task => task.eventId === source.event_id));
  const before = f.store.attentionWorkView(roomId).stateVersion;
  completeHumanWork(f, source);
  assert.notEqual(f.store.attentionWorkView(roomId).stateVersion, before);
});
