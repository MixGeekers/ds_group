import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotNode, parseBotOutput } from '../src/bot-node.mjs';
import { NodeStore } from '../src/node-store.mjs';
import { TaskService } from '../src/tasks.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';

const people = ['alice', 'bob', 'finance', 'hr'].map((name, index) => ({ id: `@${name}:delivery.test`,
  localpart: name, name, kind: index < 2 ? 'human' : 'bot' }));
const [alice, bob, finance, hr] = people;
const roomId = '!group:delivery.test';
const directRoom = (a, b) => `!dm-${[a, b].sort().join('-')}`;
const file = id => ({ id, name: `${id}.txt`, size: 1, mimeType: 'text/plain', sha256: id,
  contentUri: `mxc://delivery.test/${id}` });
const event = (id, body, options = {}) => ({ event_id: id, type: 'm.room.message', room_id: options.roomId || roomId,
  sender: options.sender || alice.id, content: { body, 'org.ds_group': { to: options.to || [finance.id], ...options.meta } } });
const receipt = (text = '完成', extras = {}) => ({ status: 'completed', text: JSON.stringify({ text }), ...extras });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-node-delivery-'));
  const tasks = new TaskService({ setup: { participants: people, homeserverUrl: 'http://127.0.0.1:1' }, dataRoot: directory });
  const stores = [];
  t.after(async () => { for (const store of stores) { try { store.close(); } catch {} } tasks.close(); await rm(directory, { recursive: true, force: true }); });
  const sent = [];
  const timeline = [];
  function build(participant = finance, options = {}) {
    const store = new NodeStore(options.filename || ':memory:', participant.id);
    stores.push(store);
    const calls = [];
    const matrix = { timeline: async room => timeline.filter(value => value.room_id === room), send: async (room, body, sendOptions) => {
      if (options.send) await options.send(room, body, sendOptions);
      const value = event(`$sent-${sent.length + 1}`, body, { roomId: room, sender: participant.id, meta: sendOptions });
      sent.push(value);
      timeline.push(value);
      return { event_id: value.event_id };
    } };
    const node = new BotNode({ participant, participants: people, roomId, matrix, store, heartbeat: async () => {}, onError: () => {},
      bridge: { turn: async request => { calls.push(request); return options.turn ? options.turn(request) : receipt(); }, ...options.bridge },
      tasks: { update: async value => { if (options.update) await options.update(value); return tasks.update(value); }, control: async id => tasks.control(id) },
      delivery: { direct: async id => { assert.ok(people.some(person => person.id === id)); if (options.direct) await options.direct(id); return directRoom(participant.id, id); } },
      files: { prepare: async request => ({ ...request, files: request.event.attachments || [], workdir: directory }),
        upload: async artifact => file(artifact.name || 'result') } });
    const ingest = async (...events) => { store.ingest(events, undefined, value => node.delivery.register(value)); await node.flushTaskUpdates(); };
    return { node, store, calls, ingest };
  }
  async function drain(node, maximum = 20) { for (let count = 0; count < maximum; count++) if (!await node.processOne()) return; throw new Error('Node did not drain'); }
  return { build, tasks, sent, timeline, drain, directory };
}

test('private results use the original human DM and keep source provenance without a cross-room reply', async t => {
  const f = await fixture(t);
  const n = f.build(finance, { turn: async () => receipt('结果正文', { artifacts: [{ path: '/synthetic/result', name: 'result' }] }) });
  await n.ingest(event('$private', '制作一个报告，完成后私聊发给我'));
  await f.drain(n.node);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].room_id, directRoom(finance.id, alice.id));
  const metadata = f.sent[0].content['org.ds_group'];
  assert.equal(metadata.replyTo, undefined);
  assert.equal(metadata.originEventId, '$private');
  assert.equal(metadata.attachments[0].id, 'result');
  const task = f.tasks.get(n.store.item('$private').request.requestId);
  assert.equal(task.roomId, roomId);
  assert.equal(task.delivery.state, 'sent');
  assert.equal(task.delivery.roomId, f.sent[0].room_id);
  assert.equal(f.tasks.visibleInRoom(task, roomId).artifacts.length, 0);
  assert.equal(f.tasks.visibleInRoom(task, task.delivery.roomId).artifacts.length, 1);
});

test('a concurrent routing-only followup changes a running task without another model turn', async t => {
  const f = await fixture(t);
  const started = deferred();
  const finished = deferred();
  const n = f.build(finance, { turn: async () => { started.resolve(); return finished.promise; } });
  await n.ingest(event('$running', '制作一个报告'));
  const running = n.node.processOne();
  await started.promise;
  await n.ingest(event('$route', '完成后私信给我'));
  assert.equal(n.store.route('$running').kind, 'direct');
  const task = f.tasks.get(n.store.item('$running').request.requestId);
  assert.equal(task.delivery.kind, 'direct');
  finished.resolve(receipt('报告正文', { artifacts: [{ path: '/synthetic/result', name: 'result' }] }));
  await running;
  await f.drain(n.node);
  assert.equal(n.calls.length, 1);
  assert.equal(f.sent.find(value => value.content.body === '报告正文').room_id, directRoom(finance.id, alice.id));
  assert.equal(f.sent.filter(value => value.room_id === roomId).every(value => !value.content['org.ds_group'].attachments), true);
});

test('the last source timeline refresh applies an unsynced routing control before final send', async t => {
  const f = await fixture(t);
  const n = f.build();
  await n.ingest(event('$ready', '制作一个报告'));
  await n.node.processOne();
  f.timeline.push(event('$late-route', '请私信给我'));
  await n.node.processOne();
  assert.equal(f.sent[0].room_id, directRoom(finance.id, alice.id));
  assert.equal(n.store.control('$late-route').targetEventId, '$ready');
});

test('an asynchronous DM resolution cannot overwrite a newer group routing correction', async t => {
  const f = await fixture(t);
  let changed = false;
  let n;
  n = f.build(finance, { direct: async () => { if (!changed) { changed = true; await n.ingest(event('$back-to-group', '还是发在群里')); } } });
  await n.ingest(event('$cas', '制作一个报告，私聊发给我'));
  await n.node.processOne();
  await n.node.processOne();
  assert.equal(changed, true);
  assert.equal(f.sent[0].room_id, roomId);
  assert.equal(n.store.route('$cas').kind, 'origin');
});

test('a failed first send freezes every final file part across restart and later corrections', async t => {
  const f = await fixture(t);
  const filename = path.join(f.directory, 'restart.sqlite');
  let fail = true;
  let n = f.build(finance, { filename, turn: async () => receipt('多份文件', { artifacts: Array.from({ length: 11 }, (_, index) => ({ path: `/synthetic/${index}`, name: `output-${index}` })) }),
    send: async () => { if (fail) { fail = false; throw Object.assign(new Error('lost send receipt'), { networkError: true }); } } });
  await n.ingest(event('$batch', '创建多份文件，私聊发给我'));
  await n.node.processOne();
  await assert.rejects(n.node.processOne(), /lost send receipt/);
  const transaction = n.store.pendingDelivery().transaction_id;
  await n.ingest(event('$too-late', '发在群里'));
  assert.equal(n.store.route('$batch').kind, 'direct');
  assert.equal(n.store.control('$too-late').action, 'resend');
  n.store.close();
  n = f.build(finance, { filename, turn: async () => { throw new Error('Must use saved result'); } });
  await n.node.processOne();
  await n.node.processOne();
  assert.equal(n.calls.length, 0);
  assert.equal(f.sent[0].content['org.ds_group'].transactionId, transaction);
  assert.equal(f.sent.slice(0, 2).every(value => value.room_id === directRoom(finance.id, alice.id)), true);
  assert.equal(f.sent.slice(0, 2).flatMap(value => value.content['org.ds_group'].attachments).length, 11);
});

test('ordinary new work stays in the group after private work while explicit resends reuse private artifacts', async t => {
  const f = await fixture(t);
  const n = f.build(finance, { turn: async () => ({ ...receipt('产物', { artifacts: [{ path: '/synthetic/result', name: 'result' }] }),
    text: JSON.stringify({ text: '产物', delivery: { kind: 'direct', recipientId: alice.id } }) }) });
  await n.ingest(event('$first', '制作一个报告，私聊发给我'));
  await f.drain(n.node);
  await n.ingest(event('$resend', '重新发一份给我'));
  await f.drain(n.node);
  assert.equal(n.calls.length, 1);
  assert.equal(f.sent[1].room_id, directRoom(finance.id, alice.id));
  assert.equal(f.sent[1].content['org.ds_group'].attachments[0].id, 'result');
  await n.ingest(event('$new', '生成一份另外的报告，完成后把文件发给我'));
  await f.drain(n.node);
  assert.equal(n.calls.length, 2);
  assert.equal(f.sent.at(-1).room_id, roomId);
});

test('private collaboration uses Bot DMs, handles eleven inputs and returns through the originating Bot', async t => {
  const f = await fixture(t);
  let turns = 0;
  const a = f.build(hr, { turn: async () => ++turns === 1
    ? { status: 'completed', text: JSON.stringify({ text: '受理详情', delegate: { to: finance.id, body: '处理这些附件' } }) }
    : receipt('最终成果') });
  const b = f.build(finance, { turn: async () => receipt('子成果', {
    text: JSON.stringify({ text: '子成果', delivery: { kind: 'direct', recipientId: hr.id } }),
    artifacts: [{ path: '/synthetic/child', name: 'child-result' }],
  }) });
  await a.ingest(event('$collaboration', '整理全部附件，私聊发给我', { to: [hr.id], meta: { attachments: Array.from({ length: 11 }, (_, index) => file(`input-${index}`)) } }));
  await f.drain(a.node);
  const requests = f.sent.filter(value => value.content['org.ds_group'].kind === 'task.request');
  assert.equal(requests.length, 2);
  assert.equal(requests.every(value => value.room_id === directRoom(hr.id, finance.id)), true);
  assert.deepEqual(requests[0].content['org.ds_group'].to, []);
  assert.deepEqual(requests[1].content['org.ds_group'].to, [finance.id]);
  assert.equal(a.store.route('$collaboration').frozen, false);
  assert.equal(f.sent.filter(value => value.room_id === roomId).every(value => !value.content['org.ds_group'].attachments), true);
  await b.ingest(...requests);
  await f.drain(b.node);
  const child = f.sent.find(value => value.content['org.ds_group'].kind === 'task.result');
  assert.equal(child.room_id, directRoom(hr.id, finance.id));
  assert.equal(child.content['org.ds_group'].delivery.recipientId, alice.id);
  assert.equal(b.store.item(requests[1].event_id).status, 'completed');
  await a.ingest(child);
  await f.drain(a.node);
  const final = f.sent.at(-1);
  assert.equal(final.room_id, directRoom(hr.id, alice.id));
  assert.equal(final.content['org.ds_group'].attachments[0].id, 'child-result');
  assert.equal(a.store.task('$collaboration').status, 'completed');
  assert.equal(a.store.route('$collaboration').state, 'sent');
});

test('a fixed human delivery route preserves generated artifacts despite an irrelevant invalid model hint', async t => {
  const f = await fixture(t);
  const n = f.build(finance, { turn: async () => receipt('已完成', {
    text: JSON.stringify({ text: '已完成', delivery: { kind: 'direct', recipientId: hr.id } }),
    artifacts: [{ path: '/synthetic/output', name: 'fixed-result' }],
  }) });
  await n.ingest(event('$fixed-human-route', '生成一份报告，私信给我'));
  await f.drain(n.node);
  assert.equal(n.store.item('$fixed-human-route').status, 'completed');
  assert.equal(f.sent[0].room_id, directRoom(finance.id, alice.id));
  assert.equal(f.sent[0].content['org.ds_group'].attachments[0].id, 'fixed-result');
});

test('natural work requested in a known human DM keeps Bot collaboration and final artifacts private', async t => {
  const f = await fixture(t);
  let turns = 0;
  const a = f.build(hr, { turn: async () => ++turns === 1
    ? { status: 'completed', text: JSON.stringify({ text: '开始协作', delegate: { to: finance.id, body: '制作一个文件' } }) }
    : receipt('交付成果') });
  const b = f.build(finance, { turn: async () => receipt('同伴成果', { artifacts: [{ path: '/synthetic/natural', name: 'natural-result' }] }) });
  const humanRoom = directRoom(hr.id, alice.id);
  await a.ingest(event('$natural-dm', '请财务整理一个文件', { roomId: humanRoom, to: [hr.id], meta: { conversationKind: 'direct' } }));
  await f.drain(a.node);
  const delegated = f.sent.find(value => value.content['org.ds_group'].kind === 'task.request');
  assert.equal(delegated.room_id, directRoom(hr.id, finance.id));
  assert.equal(a.calls[0].event.delivery.kind, 'direct');
  assert.equal(a.calls[0].event.conversationKind, 'direct');
  await b.ingest(delegated);
  await f.drain(b.node);
  const child = f.sent.find(value => value.content['org.ds_group'].kind === 'task.result');
  assert.equal(child.room_id, directRoom(hr.id, finance.id));
  await a.ingest(child);
  await f.drain(a.node);
  assert.equal(f.sent.at(-1).room_id, humanRoom);
  assert.equal(f.sent.at(-1).content['org.ds_group'].attachments[0].id, 'natural-result');
  assert.equal(f.sent.some(value => value.room_id === roomId), false);
});

test('a current known DM takes precedence over legacy followup defaults without changing old receipts', async t => {
  const f = await fixture(t);
  const n = f.build();
  const humanRoom = directRoom(finance.id, alice.id);
  await n.ingest(event('$legacy-dm', '制作一份报告', { roomId: humanRoom }));
  await f.drain(n.node);
  const oldRoute = n.store.route('$legacy-dm');
  assert.equal(oldRoute.kind, 'origin');
  const oldOutbox = n.store.db.prepare('SELECT * FROM outbox WHERE source_event_id=?').all('$legacy-dm');
  await n.ingest(event('$known-dm-followup', '继续修改这份报告', { roomId: humanRoom, meta: { conversationKind: 'direct' } }));
  assert.equal(n.store.route('$known-dm-followup').kind, 'direct');
  assert.equal(n.store.route('$known-dm-followup').recipientId, alice.id);
  assert.deepEqual(n.store.route('$legacy-dm'), oldRoute);
  assert.deepEqual(n.store.db.prepare('SELECT * FROM outbox WHERE source_event_id=?').all('$legacy-dm'), oldOutbox);
  await n.ingest(event('$known-dm-explicit', '制作另一份报告，发在这里', { roomId: humanRoom, meta: { conversationKind: 'direct' } }));
  assert.equal(n.store.route('$known-dm-explicit').kind, 'origin');
});

test('a parent delivery change while a delegated Bot works moves the peer result and final result to DMs', async t => {
  const f = await fixture(t);
  let turns = 0;
  const a = f.build(hr, { turn: async () => ++turns === 1
    ? { status: 'completed', text: JSON.stringify({ text: '开始协作', delegate: { to: finance.id, body: '制作一个附件' } }) } : receipt('最终报告') });
  const b = f.build(finance, { turn: async () => receipt('子结果', { artifacts: [{ path: '/synthetic/child', name: 'child' }] }) });
  await a.ingest(event('$late-parent', '整理数据', { to: [hr.id] }));
  await f.drain(a.node);
  const request = f.sent.find(value => value.content['org.ds_group'].kind === 'task.request');
  assert.equal(request.room_id, roomId);
  await b.ingest(request);
  await b.node.processOne();
  await a.ingest(event('$late-parent-control', '私信发给我', { to: [hr.id] }));
  await f.drain(b.node);
  const result = f.sent.find(value => value.content['org.ds_group'].kind === 'task.result');
  assert.equal(result.room_id, directRoom(finance.id, hr.id));
  await a.ingest(result);
  await f.drain(a.node);
  assert.equal(f.sent.at(-1).room_id, directRoom(hr.id, alice.id));
});

test('separate human private requests cannot reuse another human recipient', async t => {
  const f = await fixture(t);
  const n = f.build();
  await n.ingest(event('$alice', '生成文件，私聊发给我'));
  await f.drain(n.node);
  await n.ingest(event('$bob', '生成文件，私聊发给我', { sender: bob.id }));
  await f.drain(n.node);
  assert.equal(f.sent[0].room_id, directRoom(finance.id, alice.id));
  assert.equal(f.sent[1].room_id, directRoom(finance.id, bob.id));
  assert.throws(() => parseBotOutput(JSON.stringify({ text: '报告', delivery: { kind: 'direct', roomId: '!untrusted' } }), finance.id, people), /room identifiers/);
});

test('concurrent task publication cannot restore an older delivery route after a newer control', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  let count = 0;
  const n = f.build(finance, { update: async () => { if (++count === 1) { entered.resolve(); await release.promise; } } });
  await n.ingest(event('$publication', '制作一份报告'));
  const item = n.store.item('$publication');
  const request = n.node.requestFor(item);
  n.store.begin(item.event_id, request);
  n.node.taskUpdate(n.store.item(item.event_id), { status: 'running' });
  const older = n.node.flushTaskUpdates();
  await entered.promise;
  const newer = n.ingest(event('$newer-publication', '私信给我'));
  release.resolve();
  await Promise.all([older, newer]);
  assert.equal(f.tasks.control(request.requestId).delivery.kind, 'direct');
  assert.equal(n.store.pendingTaskUpdates().length, 0);
});

test('the first network send starts synchronously with the durable destination freeze', async t => {
  const f = await fixture(t);
  let sawSending = false;
  let sendStarted = false;
  const n = f.build(finance, { send: async () => {
    sendStarted = true;
    assert.equal(n.store.route('$send-boundary').frozen, true);
    assert.equal(sawSending, false);
  }, update: async value => {
    if (value.delivery?.state === 'sending') { sawSending = true; assert.equal(sendStarted, true); }
  } });
  await n.ingest(event('$send-boundary', '制作一份报告'));
  await f.drain(n.node);
  assert.equal(sendStarted, true);
});

test('an invalid explicit reply anchor never falls back to another task', async t => {
  const f = await fixture(t);
  const n = f.build();
  await n.ingest(event('$own-work', '制作一份报告'));
  await f.drain(n.node);
  await n.ingest(event('$unrelated-work', '另一个人的报告', { sender: bob.id }));
  await f.drain(n.node);
  await n.ingest(event('$invalid-anchor', '私信给我', { meta: { replyTo: '$unrelated-work' } }));
  assert.equal(n.store.control('$invalid-anchor').targetEventId, undefined);
  assert.equal(n.store.route('$own-work').kind, 'origin');
  await n.ingest(event('$unknown-resend', '重新发给我', { meta: { replyTo: '$missing' } }));
  assert.equal(n.node.delivery.controlResult(n.store.item('$unknown-resend')).controlOnly, true);
});

test('failed, cancelled and uncertain work is never executed again by a routing-only request', async t => {
  const f = await fixture(t);
  for (const status of ['failed', 'cancelled', 'unknown']) {
    const n = f.build();
    await n.ingest(event(`$${status}`, '制作一份报告'));
    n.store.failed(`$${status}`, status, status);
    await n.ingest(event(`$${status}-route`, '私信给我'));
    await f.drain(n.node);
    assert.equal(n.calls.length, 0);
    assert.equal(n.store.item(`$${status}`).status, status);
    assert.equal(f.sent.at(-1).content['org.ds_group'].attachments, undefined);
  }
});

test('native Matrix content preserves origin delivery authority and omits local routing fields', async () => {
  const matrix = new MatrixClient({ baseUrl: 'https://matrix.invalid', accessToken: 'synthetic' });
  let content;
  matrix.request = async (method, url, body) => { content = body; return { event_id: '$receipt' }; };
  const delivery = { kind: 'direct', recipientId: alice.id, originBotId: hr.id, sourceEventId: '$instruction' };
  await matrix.send('!bot-dm', '交接', { delivery, deliveryRole: 'peer', originEventId: '$group-source' });
  assert.deepEqual(content['org.ds_group'].delivery, delivery);
  assert.equal(content['org.ds_group'].originEventId, '$group-source');
  assert.equal(content['org.ds_group'].deliveryRole, undefined);
  assert.equal(content['m.relates_to'], undefined);
});
