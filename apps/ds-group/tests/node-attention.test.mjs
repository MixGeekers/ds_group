import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotNode, createBridge } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';
import { createScriptDecisionProvider } from '../src/decision-provider.mjs';

const roomId = '!living-room:test';
const alice = { id: '@alice:test', name: '小林', kind: 'human' };
const bob = { id: '@bob:test', name: '阿文', kind: 'human' };
const self = { id: '@shiyu:test', localpart: 'shiyu', name: '识雨', kind: 'bot', role: '朋友与协作伙伴', interests: ['摄影', '咖啡'] };
const peer = { id: '@yuhe:test', localpart: 'yuhe', name: '雨禾', kind: 'bot' };
const participants = [alice, bob, self, peer];
const message = (id, body = '周末去海边散步怎么样？', { sender = alice.id, to = [], replyTo, thread, kind, timestamp } = {}) => ({
  type: 'm.room.message', event_id: id, room_id: roomId, sender, ...(timestamp ? { origin_server_ts: timestamp } : {}),
  content: { msgtype: 'm.text', body, 'org.ds_group': { to, ...(replyTo ? { replyTo } : {}), ...(kind ? { kind } : {}) },
    ...(thread ? { 'm.relates_to': { rel_type: 'm.thread', event_id: thread } } : {}) },
});

function fixture(t, options = {}) {
  const store = new NodeStore(options.filename || ':memory:', self.id);
  t.after(() => { try { store.close(); } catch {} });
  const decisions = [], turns = [], sends = [], observed = [], updates = [];
  const provider = createScriptDecisionProvider(async (input, args) => { decisions.push(structuredClone(input)); return options.decide ? options.decide(input, args) : { action: 'SPEAK' }; });
  const node = new BotNode({ participant: structuredClone(self), participants: structuredClone(participants), roomId, store,
    attention: { mode: 'natural', batchMs: 0, coordinationMs: 0, cooldownMs: 0, ...options.attention },
    decisionProvider: options.noProvider ? undefined : provider,
    executionMode: options.executionMode, nativeBinding: options.nativeBinding, work: options.work,
    observe: options.observe || (async input => { observed.push(input); }),
    readAttentionView: options.readAttentionView || (async () => ({ self: { interests: ['摄影'] }, currentClaims: [], runtime: { status: 'idle', source: 'fixture-runtime' } })),
    matrix: { send: async (...args) => { sends.push(args); return { event_id: `$sent-${sends.length}` }; }, ...options.matrix },
    bridge: { turn: async (input, args) => { turns.push(input); return options.turn ? options.turn(input, args) : { status: 'completed', text: '{"text":"好呀，带上相机。"}', sessionId: 'native-session' }; }, ...options.bridge },
    tasks: options.tasks || { update: async input => updates.push(input), control: async () => ({ cancelRequested: false }) },
    heartbeat: async () => {}, onError: () => {},
  });
  return { node, store, provider, decisions, turns, sends, observed, updates };
}

test('all accepted room messages are observed durably without sending them to the main Session', async t => {
  const f = fixture(t);
  const events = [message('$human'), message('$peer', '我今天去了公园。', { sender: peer.id }), message('$self', '天气很好。', { sender: self.id })];
  await f.node.ingestEvents(events, 'matrix-token');
  await f.node.flushObservations();
  assert.equal(f.turns.length, 0);
  assert.equal(f.store.snapshot().pending, 0);
  assert.deepEqual(f.observed.flatMap(batch => batch.events.map(event => event.event_id)), ['$human', '$peer', '$self']);
  assert.equal(f.store.attentionSnapshot().observationSequence, 3);
  await f.node.ingestEvents(events, 'matrix-replay');
  await f.node.flushObservations();
  assert.equal(f.observed.length, 1);
  assert.equal(f.store.cursor(), 'matrix-replay');
});

test('observation failure keeps a separate replay watermark and never rolls back accepted Matrix events', async t => {
  let fail = true;
  const calls = [];
  const f = fixture(t, { observe: async input => { calls.push(input); if (fail) throw new Error('memory unavailable'); } });
  await f.node.ingestEvents([message('$keep')], 'accepted-sync');
  assert.equal(await f.node.flushObservations(), false);
  assert.equal(f.store.cursor(), 'accepted-sync');
  assert.equal(f.store.attentionSnapshot().observationSequence, 0);
  fail = false; f.node.observationRetryAt = 0;
  assert.equal(await f.node.flushObservations(), true);
  assert.deepEqual(calls.map(batch => batch.events[0].event_id), ['$keep', '$keep']);
  assert.equal(f.store.attentionSnapshot().observationSequence, 1);
});

test('default mention and shadow modes preserve explicit work while ordinary messages never reach a main Session', async t => {
  const mention = fixture(t, { attention: { mode: 'mention' } });
  await mention.node.ingestEvents([message('$chat'), message('$at', '看一下照片好吗？', { to: [self.id] })]);
  await mention.node.processAttentionOnce();
  assert.equal(mention.decisions.length, 0);
  await mention.node.processOne();
  assert.deepEqual(mention.turns.map(turn => turn.event.eventId), ['$at']);
  const shadow = fixture(t, { attention: { mode: 'shadow' } });
  await shadow.node.ingestEvents([message('$shadow')]);
  await shadow.node.processAttentionOnce();
  assert.equal(shadow.decisions.length, 1);
  assert.equal(shadow.store.next(), undefined);
  assert.equal(shadow.node.attentionStatus().lastDecision.outcome, 'shadow');
});

test('natural mode batches recent messages and binds the native input to the same decision watermarks and source evidence', async t => {
  const f = fixture(t);
  const events = [message('$coffee', '这家店的咖啡挺香。'), message('$photo', '识雨，周末一起拍照吧。')];
  await f.node.ingestEvents(events);
  assert.equal(await f.node.processAttentionOnce(), true);
  assert.equal(f.decisions.length, 1);
  const input = f.decisions[0];
  assert.deepEqual(input.currentMessages.map(row => row.eventId), ['$coffee', '$photo']);
  assert.equal(input.self.id, self.id);
  assert.deepEqual(input.self.interests, ['摄影', '咖啡']);
  assert.equal(input.memoryView.runtime.status, 'idle');
  assert.equal(input.workView.runtime.nativeState, 'unknown');
  assert.equal(input.watermark.eventId, '$photo');
  assert.deepEqual(f.store.message('$photo').content['org.ds_group'].to, []);
  await f.node.processOne();
  await f.node.processOne();
  assert.equal(f.turns.length, 1);
  assert.deepEqual(f.turns[0].context.attention.watermark, input.watermark);
  assert.deepEqual(f.turns[0].context.attention.eventIds, input.eventIds);
  assert.deepEqual(f.turns[0].history.map(row => row.eventId), ['$coffee']);
  assert.equal(f.turns[0].event.body, events[1].content.body);
  assert.deepEqual(f.turns[0].event.to, []);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][2].replyTo, '$photo');
  assert.equal(f.updates.length, 0, 'casual participation must not make a task card');
  assert.equal(f.node.attentionStatus().lastDecision.outcome, 'delivered');
  await f.node.ingestEvents(events);
  assert.equal(await f.node.processAttentionOnce(), false);
  assert.equal(f.turns.length, 1);
});

test('LISTEN is successful silence while a provider timeout is a separate error', async t => {
  const listen = fixture(t, { decide: async () => ({ action: 'LISTEN' }) });
  await listen.node.ingestEvents([message('$listen')]);
  await listen.node.processAttentionOnce();
  assert.equal(listen.node.attentionStatus().lastDecision.action, 'LISTEN');
  assert.equal(listen.node.attentionStatus().queue.errors, 0);
  assert.equal(await listen.node.processOne(), false);
  const timeout = fixture(t, { attention: { providerTimeoutMs: 100 }, decide: () => new Promise(() => {}) });
  await timeout.node.ingestEvents([message('$timeout')]);
  await timeout.node.processAttentionOnce();
  const status = timeout.node.attentionStatus();
  assert.equal(status.lastDecision.action, null);
  assert.equal(status.lastDecision.status, 'error');
  assert.equal(status.lastError.code, 'ATTENTION_TIMEOUT');
  assert.equal(status.queue.errors, 1);
  assert.equal(timeout.store.next(), undefined);
});

test('a missing provider or failed read view cannot masquerade as LISTEN or prevent reliable mentions', async t => {
  const f = fixture(t, { noProvider: true });
  await f.node.ingestEvents([message('$ordinary'), message('$reliable', '请看看。', { to: [self.id] })]);
  await f.node.processAttentionOnce();
  assert.equal(f.node.attentionStatus().lastError.code, 'ATTENTION_PROVIDER_UNCONFIGURED');
  await f.node.processOne();
  assert.equal(f.turns[0].event.eventId, '$reliable');
  const broken = fixture(t, { readAttentionView: async () => { throw new Error('private endpoint failed'); } });
  await broken.node.ingestEvents([message('$view-error')]);
  await broken.node.processAttentionOnce();
  assert.equal(broken.decisions.length, 0);
  assert.equal(broken.node.attentionStatus().lastError.code, 'ATTENTION_CONTEXT_UNAVAILABLE');
});

test('WAIT has timer, related-message and task-event reevaluation, then a bounded expiry', async t => {
  const f = fixture(t, { decide: async input => ({ action: input.currentMessages.some(row => row.eventId === '$ready') ? 'SPEAK' : 'WAIT' }) });
  await f.node.ingestEvents([message('$wait', '等下，我把照片发完再一起看。')]);
  await f.node.processAttentionOnce();
  assert.equal(f.node.attentionStatus().activity, 'waiting');
  assert.equal(await f.node.processAttentionOnce(), false);
  assert.equal(f.node.wakeAttention('task_completed', { roomId, threadRootId: null }), 1);
  await f.node.processAttentionOnce();
  assert.equal(f.decisions.length, 2);
  assert.equal(f.decisions[1].trigger.reason, 'task_completed');
  f.store.db.prepare("UPDATE attention_events SET available_at=? WHERE status='waiting'").run(Date.now() - 1);
  await f.node.processAttentionOnce();
  assert.equal(f.decisions.length, 3);
  await f.node.ingestEvents([message('$ready', '好了，大家看看这些照片。')]);
  await f.node.processAttentionOnce();
  assert.equal(f.decisions[3].trigger.reason, 'new_message');
  assert.deepEqual(f.decisions[3].eventIds, ['$wait', '$ready']);
  assert.equal(f.store.next().event_id, '$ready');
  const expired = fixture(t, { decide: async () => ({ action: 'WAIT' }) });
  await expired.node.ingestEvents([message('$expired')]);
  await expired.node.processAttentionOnce();
  expired.store.db.prepare("UPDATE attention_events SET expires_at=? WHERE status='waiting'").run(Date.now() - 1);
  assert.equal(expired.node.wakeAttention('dependency_ready', { roomId }), 0);
  assert.equal(await expired.node.processAttentionOnce(), false);
  assert.equal(expired.decisions.length, 1);
});

test('new messages and other Bot replies suppress an outdated proposal before generation', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { decide: async () => pending });
  await f.node.ingestEvents([message('$question')]);
  const deciding = f.node.processAttentionOnce();
  while (!f.decisions.length) await new Promise(resolve => setTimeout(resolve, 0));
  await f.node.ingestEvents([message('$answered', '我知道一个好地方。', { sender: peer.id, replyTo: '$question' })]);
  release({ action: 'SPEAK' });
  await deciding;
  assert.equal(f.store.next(), undefined);
  assert.equal(f.node.attentionStatus().lastDecision.outcome, 'peer_responded');
  assert.equal(f.turns.length, 0);
});

test('a final timeline refresh suppresses stale casual output while unrelated conversation does not cancel it', async t => {
  const stale = fixture(t, { matrix: { timeline: async () => [message('$peer-final', '我来回答这个问题。', { sender: peer.id, replyTo: '$source' })] } });
  await stale.node.ingestEvents([message('$source')]);
  await stale.node.processAttentionOnce();
  await stale.node.processOne();
  await stale.node.processOne();
  assert.equal(stale.turns.length, 1);
  assert.equal(stale.sends.length, 0);
  assert.equal(stale.store.item('$source').status, 'cancelled');
  const f = fixture(t);
  await f.node.ingestEvents([message('$unrelated-source')]);
  await f.node.processAttentionOnce();
  await f.node.processOne();
  await f.node.ingestEvents([message('$other-topic', '我去接小孩了。', { sender: bob.id })]);
  await f.node.processOne();
  assert.equal(f.sends.length, 1);
});

test('reliable task corrections and cancellation bypass the decision provider without modifying source metadata', async t => {
  const f = fixture(t, { decide: async () => { throw new Error('provider must not decide controls'); } });
  await f.node.ingestEvents([message('$work', '帮我整理一下明天的行程。', { to: [self.id] })]);
  await f.node.ingestEvents([message('$change', '改成三个人一起去，其他不变。')]);
  assert.equal(f.store.item('$change').attention.reason, 'active_task_control');
  assert.equal(f.store.cancelledEvent('$work'), true);
  assert.deepEqual(f.store.message('$change').content['org.ds_group'].to, []);
  await f.node.processOne();
  assert.equal(f.turns.length, 0);
  await f.node.processOne();
  assert.equal(f.turns[0].event.eventId, '$change');
  await f.node.ingestEvents([message('$cancel', '别做了')]);
  assert.equal(f.store.item('$cancel').attention.cancel, true);
  const requestId = f.store.item('$change').request.requestId;
  assert.equal((await f.node.control(requestId)).cancelRequested, true);
  assert.equal(f.decisions.length, 0);
});

test('an ambiguous task change is not routed to a different task or another human', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$one', '任务一', { to: [self.id] }), message('$two', '任务二', { to: [self.id] })]);
  await f.node.ingestEvents([message('$ambiguous', '改成三人'), message('$other-human', '别做了', { sender: bob.id })]);
  assert.equal(f.store.item('$ambiguous'), undefined);
  assert.equal(f.store.item('$other-human'), undefined);
  assert.equal(f.store.cancelledEvent('$one'), false);
});

test('reply relationships and native Matrix mentions are reliable but an explicit different target wins', async t => {
  const f = fixture(t);
  const nativeMention = message('$matrix'); nativeMention.content['m.mentions'] = { user_ids: [self.id] };
  await f.node.ingestEvents([message('$own', '下次想试试夜景摄影。', { sender: self.id }), nativeMention,
    message('$reply', '那就周六吧。', { replyTo: '$own' }), message('$other-target', '请你看看。', { replyTo: '$own', to: [peer.id] })]);
  assert.equal(f.store.item('$matrix').attention.reason, 'matrix_mention');
  assert.equal(f.store.item('$reply').attention.reason, 'reply_to_conversation');
  assert.equal(f.store.item('$other-target'), undefined);
});

test('consecutive Bot chatter is bounded without suppressing real directed delegation and result chains', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$bot-one', '谢谢。', { sender: peer.id }), message('$bot-two', '不客气。', { sender: peer.id })]);
  await f.node.processAttentionOnce();
  assert.equal(f.node.attentionStatus().lastDecision.outcome, 'bot_turn_limit');
  assert.equal(f.store.next(), undefined);
  await f.node.ingestEvents([message('$real-work', '请核对这个实际结果。', { sender: peer.id, to: [self.id], kind: 'task.request' })]);
  assert.equal(f.store.next().event_id, '$real-work');
  await f.node.processOne();
  assert.equal(f.turns.length, 1);
});

test('real tools and delegation establish tasks while ordinary participation has no task card', async t => {
  const f = fixture(t, { turn: async () => ({ status: 'completed', text: JSON.stringify({ text: '雨禾帮我核对一下。', delegate: { to: peer.id, body: '请核对明天的出发时间。' } }), sessionId: 'native-session' }) });
  await f.node.ingestEvents([message('$delegate-source', '一起把明天的计划定一下吧。')]);
  await f.node.processAttentionOnce();
  await f.node.processOne();
  await f.node.processOne();
  await f.node.processOne();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1][2].kind, 'task.request');
  assert.deepEqual(f.sends[1][2].to, [peer.id]);
  assert.equal(f.store.task('$delegate-source').stage, 'waiting_for_bot');
});

test('revision and provider hot updates supersede pending decisions without interrupting a main Bot turn', async t => {
  let release;
  const f = fixture(t, { decide: () => new Promise(resolve => { release = resolve; }) });
  await f.node.ingestEvents([message('$hot')]);
  const decision = f.node.processAttentionOnce();
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const status = f.node.setDecisionProvider(createScriptDecisionProvider(() => ({ action: 'LISTEN' })));
  assert.equal(status.mode, 'natural');
  release({ action: 'SPEAK' }); await decision;
  assert.equal(f.node.attentionStatus().lastDecision.outcome, 'configuration_changed');
  assert.equal(f.store.next(), undefined);
  assert.equal(f.node.configureAttention({ mode: 'shadow', revision: 2 }).revision, 2);
  assert.equal(f.node.configureAttention({ mode: 'natural', revision: 1 }).mode, 'shadow');
  assert.equal(f.node.configureAttention({ mode: 'shadow', revision: 2 }).mode, 'shadow');
  assert.throws(() => f.node.configureAttention({ mode: 'natural', revision: 2 }), /revision/);
  assert.throws(() => f.node.configureAttention({ revision: -1 }), /revision/);
});

test('mode changes and restarts never replay missed ordinary conversation, while reliable work remains queued', async t => {
  const f = fixture(t, { attention: { mode: 'mention' } });
  await f.node.ingestEvents([message('$old-chat')]);
  f.node.configureAttention({ mode: 'natural' });
  assert.equal(await f.node.processAttentionOnce(), false);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-attention-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'node.sqlite');
  const before = fixture(t, { filename });
  await before.node.ingestEvents([message('$unsent-chat')]);
  await before.node.processAttentionOnce();
  await before.node.ingestEvents([message('$old-queued'), message('$explicit', '请继续。', { to: [self.id] })]);
  before.store.close();
  const after = new NodeStore(filename, self.id); t.after(() => after.close());
  assert.equal(after.item('$unsent-chat').status, 'cancelled');
  assert.equal(after.next().event_id, '$explicit');
  assert.equal(after.nextAttentionBatch({ batchMs: 0 }), undefined);
});

test('redaction is observed and suppresses a pending casual response without entering chat history', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$withdrawn')]);
  await f.node.processAttentionOnce();
  await f.node.ingestEvents([{ event_id: '$redaction', type: 'm.room.redaction', room_id: roomId, sender: alice.id, redacts: '$withdrawn', content: {} }]);
  await f.node.flushObservations();
  assert.equal(f.observed.at(-1).events[0].type, 'm.room.redaction');
  assert.deepEqual(f.store.messagesThrough(roomId, 999).map(event => event.event_id), ['$withdrawn']);
  await f.node.processOne();
  assert.equal(f.turns.length, 0);
  assert.equal(f.node.attentionStatus().lastDecision.outcome, 'source_withdrawn');
});

test('a Matrix send with an uncertain receipt retains its idempotent transaction across new messages', async t => {
  let attempt = 0;
  const calls = [];
  const f = fixture(t, { matrix: { send: async (room, body, options) => {
    calls.push({ room, body, options }); if (++attempt === 1) throw new Error('receipt lost'); return { event_id: '$receipt' };
  } } });
  await f.node.ingestEvents([message('$retry')]);
  await f.node.processAttentionOnce(); await f.node.processOne();
  await assert.rejects(f.node.processOne(), /receipt lost/);
  await f.node.ingestEvents([message('$later', '我们先走了。')]);
  await f.node.processOne();
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(f.turns.length, 1);
  assert.equal(f.store.item('$retry').status, 'completed');
});

test('leaving a room expires ordinary proposals and status publishes only bounded source metadata', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$leave-source', 'private-chat-marker')]);
  await f.node.processAttentionOnce();
  f.store.noteRoomMembership(roomId, 'leave');
  await f.node.processOne();
  assert.equal(f.turns.length, 0);
  const status = f.node.attentionStatus();
  assert.equal(status.lastDecision.outcome, 'room_left');
  assert.equal(JSON.stringify(status).includes('private-chat-marker'), false);
  assert.deepEqual(status.lastDecision.eventIds, ['$leave-source']);
});

test('HTTP bridges expose observation and pure kernel reads without using the turn endpoint', async () => {
  const calls = [];
  const bridge = createBridge('http://bridge.invalid', { token: 'synthetic-token', fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, input: JSON.parse(options.body), signal: options.signal }); return Response.json({ ok: true });
  } });
  const input = { botId: self.id, roomId, watermark: { sequence: 5 } };
  await bridge.observe(input); await bridge.readAttentionView(input); await bridge.kernelState(input);
  await bridge.memoryProfiles(input); await bridge.memoryProfile({ ...input, subjectId: alice.id });
  assert.deepEqual(calls.map(call => call.path), ['/api/ds-group-node/observe', '/api/ds-group-node/attention/view',
    '/api/ds-group-node/kernel/state', '/api/ds-group-node/memory/profiles', '/api/ds-group-node/memory/profile']);
  assert.deepEqual(calls[0].input, input);
  assert(calls.every(call => call.signal instanceof AbortSignal));
});

test('explicit native bindings reach creation and turns with the original native identity', async t => {
  const creates = [];
  const binding = { hostId: 'original-host', nativeBotId: 'original-native-id', botId: self.id };
  const f = fixture(t, { executionMode: 'native', nativeBinding: binding,
    bridge: { createBot: async input => { creates.push(input); return { model: 'synthetic/native' }; } } });
  f.node.processLoop = f.node.syncLoop = f.node.heartbeatLoop = f.node.attentionLoop = async () => {};
  await f.node.start();
  assert.equal(creates[0].mode, 'native');
  assert.deepEqual(creates[0].nativeBinding, binding);
  await f.node.ingestEvents([message('$native', '继续聊吧。', { to: [self.id] })]);
  await f.node.processOne();
  assert.equal(f.turns[0].mode, 'native');
  assert.equal(f.turns[0].executionMode, 'native');
  f.node.controller.abort();
});

test('an edit of an active request is a reliable correction even with explicit target metadata', async t => {
  const f = fixture(t);
  await f.node.ingestEvents([message('$editable', '周六一起去。', { to: [self.id] })]);
  const edited = message('$edit', '* 周日一起去。', { to: [self.id] });
  edited.content['m.new_content'] = { body: '周日一起去。' };
  edited.content['m.relates_to'] = { rel_type: 'm.replace', event_id: '$editable' };
  await f.node.ingestEvents([edited]);
  assert.equal(f.store.item('$edit').attention.reason, 'active_task_control');
  assert.equal(f.store.cancelledEvent('$editable'), true);
  await f.node.processOne(); await f.node.processOne();
  assert.equal(f.turns[0].event.body, '周日一起去。');
});

test('a reliable in-flight cancellation retains the real receipt and prevents later uploads or messages', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(t, { turn: async () => pending });
  await f.node.ingestEvents([message('$inflight', '帮我整理相册。', { to: [self.id] })]);
  const running = f.node.processOne();
  while (!f.turns.length) await new Promise(resolve => setTimeout(resolve, 0));
  await f.node.ingestEvents([message('$cancel-inflight', '别做了')]);
  finish({ status: 'completed', text: '{"text":"整理完了。"}', sessionId: 'native-session', toolCalls: 1,
    artifacts: [{ path: '/synthetic/album.txt', name: 'album.txt' }] });
  await running;
  assert.equal(f.store.item('$inflight').status, 'cancelled');
  assert.equal(f.store.item('$inflight').response.toolCalls, 1);
  assert.equal(f.store.pendingDelivery(), undefined);
  assert.equal(f.sends.length, 0);
});

test('an overloaded batch keeps recent conversation instead of replying to the oldest missed chat', async t => {
  const f = fixture(t, { attention: { historyLimit: 3 } });
  await f.node.ingestEvents(Array.from({ length: 8 }, (_, index) => message(`$overload-${index}`, `聊天 ${index}`)));
  await f.node.processAttentionOnce();
  assert.deepEqual(f.decisions[0].eventIds, ['$overload-5', '$overload-6', '$overload-7']);
  assert.equal(f.store.next().event_id, '$overload-7');
  assert.equal(await f.node.processAttentionOnce(), false);
});
