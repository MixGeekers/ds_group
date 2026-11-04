import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../src/node-store.mjs';

const botId = '@finance:ds-group.local';
const event = (id, { sender = '@alice:ds-group.local', roomId = '!group:ds-group.local', to = [botId], body = id } = {}) => ({
  event_id: id, type: 'm.room.message', room_id: roomId, sender,
  content: { msgtype: 'm.text', body, 'org.ds_group': { to } },
});

test('synthetic inbox preserves identities, room history and a durable cursor, deduplicating Matrix replay', () => {
  const store = new NodeStore(':memory:', botId);
  assert.equal(store.ingest([event('a'), event('b', { roomId: '!dm:ds-group.local' }), event('c')], 'cursor-1'), 3);
  assert.equal(store.ingest([event('a'), event('b'), event('c')], 'cursor-2'), 0);
  assert.equal(store.cursor(), 'cursor-2');
  assert.equal(store.next().event.sender, '@alice:ds-group.local');
  assert.deepEqual(store.historyBefore('c').map(row => row.event_id), ['a']);
  assert.equal(store.snapshot().pending, 3);
  store.close();
});

test('synthetic non-targeted messages and self echoes are history without model inbox entries', () => {
  const store = new NodeStore(':memory:', botId);
  store.ingest([event('broadcast', { to: [] }), event('other', { to: ['@hr:ds-group.local'] }), event('self', { sender: botId })], 'cursor');
  assert.equal(store.next(), undefined);
  assert.equal(store.snapshot().pending, 0);
  assert.equal(store.hasEvent('self'), true);
  store.close();
});

test('synthetic generation and outbox are durable before delivery and receipts finish only after all sends', () => {
  const store = new NodeStore(':memory:', botId);
  store.ingest([event('a')], 'cursor');
  const request = { requestId: 'r1', history: [{ body: 'fixed history' }] };
  store.begin('a', request);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT request_json FROM inbox').get().request_json), request);
  store.generated('a', { text: '{"text":"ready"}', sessionId: 'native-1' }, [
    { roomId: '!group:ds-group.local', body: 'ready', options: { transactionId: 'reply' } },
    { roomId: '!group:ds-group.local', body: 'calculate', options: { transactionId: 'delegate' } },
  ]);
  assert.equal(store.pendingDelivery().transaction_id, 'reply');
  store.sent('reply', '$reply');
  assert.equal(store.snapshot().processed, 0);
  assert.equal(store.pendingDelivery().transaction_id, 'delegate');
  store.deliveryFailed('delegate', 'temporary network failure');
  assert.equal(store.pendingDelivery().options.transactionId, 'delegate');
  store.sent('delegate', '$delegate');
  assert.equal(store.snapshot().processed, 1);
  assert.equal(store.snapshot().sessionId, 'native-1');
  assert.equal(store.pendingDelivery(), undefined);
  assert.throws(() => store.sent('delegate', '$changed'), /receipt changed/);
  store.close();
});

test('synthetic restart preserves generated sends and marks interrupted generation unknown without retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-node-store-'));
  const filename = path.join(directory, 'node.sqlite');
  let store = new NodeStore(filename, botId);
  store.ingest([event('ready'), event('interrupted')], 'cursor');
  store.begin('ready', { requestId: 'r1' });
  store.generated('ready', { text: 'ready', sessionId: 'native-1' }, [{ roomId: '!group:ds-group.local', body: 'ready', options: { transactionId: 'reply' } }]);
  store.begin('interrupted', { requestId: 'r2', history: ['original'] });
  store.close();
  store = new NodeStore(filename, botId);
  assert.equal(store.next(), undefined);
  assert.equal(store.snapshot().unknown, 1);
  assert.equal(store.pendingDelivery().transaction_id, 'reply');
  store.sent('reply', '$sent-after-restart');
  assert.equal(store.snapshot().processed, 1);
  assert.equal(store.cursor(), 'cursor');
  store.close();
  assert.throws(() => new NodeStore(filename, '@hr:ds-group.local'), /different Bot/);
  await rm(directory, { recursive: true, force: true });
});

test('synthetic cursor failure rolls back the complete sync batch', () => {
  const store = new NodeStore(':memory:', botId);
  assert.throws(() => store.ingest([event('a')], ''), /cursor/);
  assert.equal(store.hasEvent('a'), false);
  assert.equal(store.next(), undefined);
  store.close();
});
