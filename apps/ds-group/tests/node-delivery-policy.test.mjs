import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeStore } from '../src/node-store.mjs';
import { NodeDelivery } from '../src/node-delivery.mjs';

const alice = { id: '@alice:delivery-policy.test', kind: 'human' };
const bob = { id: '@bob:delivery-policy.test', kind: 'human' };
const finance = { id: '@finance:delivery-policy.test', kind: 'bot' };
const hr = { id: '@hr:delivery-policy.test', kind: 'bot' };
const participants = [alice, bob, finance, hr];
const roomId = '!group:delivery-policy.test';
const directRoomId = '!alice-finance:delivery-policy.test';
const artifact = id => ({ id, name: `${id}.csv`, size: 12, mimeType: 'text/csv', contentUri: `mxc://delivery-policy.test/${id}` });

function event(id, body, { sender = alice.id, to = [finance.id], metadata = {}, replyTo } = {}) {
  return { event_id: id, type: 'm.room.message', room_id: roomId, sender,
    content: { msgtype: 'm.text', body, 'org.ds_group': { to, ...metadata },
      ...(replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {}) } };
}

function fixture(t) {
  const store = new NodeStore(':memory:', finance.id);
  t.after(() => store.close());
  const resolvedRecipients = [];
  const delivery = new NodeDelivery({ store, participant: finance, participants, matrix: {},
    client: { direct: async recipientId => { resolvedRecipients.push(recipientId); return directRoomId; } },
    updateTask() {}, flushTasks: async () => {},
    ingest: events => store.ingest(events, undefined, value => delivery.register(value)) });
  const accept = (value, register = true) => {
    store.ingest([value], undefined, register ? accepted => delivery.register(accepted) : undefined);
    return store.item(value.event_id);
  };
  const generate = (value, response, attachments) => {
    const transactionId = `delivery-${value.event_id}`;
    store.begin(value.event_id, { requestId: `request-${value.event_id}` });
    store.generated(value.event_id, { ...response, deliveredArtifacts: attachments }, [{ roomId, body: '合成成果',
      options: { transactionId, deliveryRole: 'final', replyTo: value.event_id, attachments } }]);
    return transactionId;
  };
  const complete = async (value, attachments, { legacy = false } = {}) => {
    accept(value, !legacy);
    const transactionId = generate(value, { text: JSON.stringify({ text: '合成任务已完成。' }) }, attachments);
    if (legacy) store.db.prepare('UPDATE outbox SET routing_frozen=1 WHERE transaction_id=?').run(transactionId);
    else await delivery.prepare(store.delivery(transactionId));
    store.sent(transactionId, `$sent-${value.event_id}`);
    if (!legacy) delivery.sent(store.item(value.event_id));
    return store.item(value.event_id);
  };
  return { store, delivery, accept, generate, complete, resolvedRecipients };
}

test('current private wording permits a model delivery proposal for the requesting human', t => {
  const { store, delivery, accept } = fixture(t);
  const item = accept(event('$colloquial-private', '把核对结果丢进我的小窗。'));
  assert.equal(store.route(item.event_id).explicit, false);
  const output = { text: '合成答复', delivery: { kind: 'direct', recipientId: alice.id } };
  delivery.applyOutput(item, output);
  assert.equal(store.route(item.event_id).kind, 'direct');
  assert.equal(store.route(item.event_id).recipientId, alice.id);
  assert.equal(output.delivery.originBotId, finance.id);

  const other = accept(event('$wrong-recipient', '把整理结果扔到我的小窗。'));
  assert.throws(() => delivery.applyOutput(other, { delivery: { kind: 'direct', recipientId: bob.id } }), /original human requester/);
});

test('an ordinary new task stays in its origin conversation despite a model direct proposal', async t => {
  const { store, delivery, accept, complete } = fixture(t);
  await complete(event('$prior-private', '生成核对清单，并且私信给我。'), [artifact('prior-private')]);
  const item = accept(event('$new-period', '计算这个月的费用并生成汇总文件。'));
  const output = { text: '合成新任务结果', delivery: { kind: 'direct', recipientId: alice.id } };
  delivery.applyOutput(item, output);
  assert.equal(store.route(item.event_id).kind, 'origin');
  assert.equal(output.delivery.kind, 'origin');
  assert.equal(store.control(item.event_id), undefined);
  assert.equal(delivery.controlResult(item), undefined);
});

test('a new resend recovers legacy private intent through consecutive completed resends without changing old outbox rows', async t => {
  const { store, delivery, accept, generate, complete, resolvedRecipients } = fixture(t);
  const files = [artifact('legacy-result')];
  const previous = [
    event('$legacy-work', '汇总附件中的数值。'),
    event('$legacy-private', '完成以后，把成果私信发给我。'),
    event('$legacy-resend-one', '请重发一份。'),
    event('$legacy-resend-two', '把刚才那份结果重新发给我。'),
  ];
  for (const value of previous) await complete(value, files, { legacy: true });
  for (const value of previous) assert.equal(store.route(value.event_id), undefined);
  const oldOutbox = store.db.prepare('SELECT * FROM outbox ORDER BY transaction_id').all();

  const current = event('$resend-after-upgrade', '请再给我发一份。');
  const item = accept(current);
  assert.equal(store.route(item.event_id).kind, 'direct');
  assert.equal(store.route(item.event_id).recipientId, alice.id);
  const result = delivery.controlResult(item);
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(result.reusedAttachments, files);
  const transactionId = generate(current, result, result.reusedAttachments);
  const prepared = await delivery.prepare(store.delivery(transactionId));
  assert.equal(prepared.room_id, directRoomId);
  assert.equal(prepared.options.replyTo, undefined);
  assert.deepEqual(prepared.options.attachments, files);
  assert.equal(prepared.routing_frozen, 1);
  assert.deepEqual(await delivery.prepare(store.delivery(transactionId)), prepared);
  assert.deepEqual(resolvedRecipients, [alice.id]);
  assert.deepEqual(store.db.prepare('SELECT * FROM outbox WHERE transaction_id<>? ORDER BY transaction_id').all(transactionId), oldOutbox);
});

test('another human interrupting an unreferenced resend prevents zero-model artifact reuse', async t => {
  for (const legacy of [false, true]) {
    await t.test(legacy ? 'legacy history' : 'registered route', async t => {
      const { store, delivery, accept, complete } = fixture(t);
      await complete(event('$older-work', '生成核对清单，并且私信给我。'), [artifact('older-work')], { legacy });
      await complete(event('$other-human', '请生成另一份人员清单。', { sender: bob.id }), [artifact('other-human')], { legacy });
      const item = accept(event('$ambiguous-resend', '请重发一份。'));
      assert.equal(delivery.controlResult(item), undefined);
      assert.notEqual(store.control(item.event_id)?.action, 'resend');
      assert.equal(store.route(item.event_id).kind, 'origin');
    });
  }
});

test('an explicit reply resends the referenced older task rather than the latest task', async t => {
  for (const replyTo of ['$older-task', '$sent-$older-task']) {
    await t.test(replyTo.startsWith('$sent-') ? 'Bot receipt reference' : 'human request reference', async t => {
      const { store, delivery, accept, complete } = fixture(t);
      const olderFiles = [artifact('older')];
      await complete(event('$older-task', '生成第一张核对清单。'), olderFiles);
      await complete(event('$latest-task', '生成第二张清单，并且私信给我。'), [artifact('latest')]);
      accept(event('$other-human', '补充下一轮议题。', { sender: bob.id, to: [] }));
      const item = accept(event('$reply-to-older', '请重发一份。', { replyTo }));
      assert.equal(store.control(item.event_id)?.targetEventId, '$older-task');
      assert.equal(store.route(item.event_id).kind, 'origin');
      assert.deepEqual(delivery.controlResult(item).reusedAttachments, olderFiles);
    });
  }
});

test('a local root for a shared human event preserves an incoming task origin Bot and delivery', t => {
  const { store, delivery, accept } = fixture(t);
  const root = event('$shared-request', '请分别制作核对清单。', { to: [finance.id, hr.id] });
  accept(root);
  const localRoute = store.route(root.event_id);
  assert.equal(localRoute.originBotId, finance.id);
  assert.equal(localRoute.kind, 'origin');
  for (const kind of ['task.request', 'task.result']) {
    const incoming = event(`$incoming-${kind}`, '合成协作内容', { sender: hr.id,
      metadata: { kind, originEventId: root.event_id, originSenderId: alice.id, returnTo: hr.id,
        delivery: { kind: 'direct', recipientId: alice.id, originBotId: hr.id, sourceEventId: '$hr-delivery' } } });
    const item = accept(incoming);
    assert.equal(delivery.routeEventId(item), incoming.event_id);
    const route = delivery.publicRoute(item);
    assert.equal(route.kind, 'direct');
    assert.equal(route.recipientId, alice.id);
    assert.equal(route.originBotId, hr.id);
    assert.equal(route.authoritative, false);
    assert.deepEqual(store.route(root.event_id), localRoute);
  }
});
