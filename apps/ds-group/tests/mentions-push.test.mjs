import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatFeatures } from '../src/mentions.mjs';
import { PushService } from '../src/push.mjs';

const alice = '@alice:mentions.test';
const bob = '@bob:mentions.test';
const roomId = '!group:mentions.test';
const setup = { homeserverUrl: 'https://matrix.example', roomId, participants: [
  { id: alice, name: 'Alice', kind: 'human', accessToken: 'alice-token' },
  { id: bob, name: 'Bob', kind: 'human', accessToken: 'bob-token' },
] };

test('Push applies mention preferences while indexing muted messages for unread history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-mention-push-'));
  const chat = new ChatFeatures({ setup, dataRoot: directory, now: () => 1000 });
  const sent = [];
  const service = new PushService({ setup, dataRoot: directory, now: () => 1000,
    onEvent: (userId, event) => chat.recordEvents(userId, [event]),
    shouldNotify: (userId, event) => chat.shouldNotify(userId, event),
    transport: async (_subscription, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; } });
  try {
    await service.subscribe(bob, { subscription: { endpoint: 'https://push.example/mentions', keys: {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    } } });
    chat.savePreferences(bob, roomId, { mode: 'mentions', suppressEveryone: true });
    const message = (id, body, mentions) => ({ type: 'm.room.message', event_id: id, room_id: roomId,
      sender: alice, origin_server_ts: 2000, content: { body, 'org.ds_group': { mentions } } });
    await service.notifyMessage(message('$ordinary', 'hello', {}), [alice, bob]);
    await service.notifyMessage(message('$broad', '@everyone', { everyoneUsers: [alice, bob] }), [alice, bob]);
    await service.notifyMessage(message('$direct', `<@${bob}> review`, { users: [bob] }), [alice, bob]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /@Bob review/);
    assert.equal(chat.unreadFor(bob, roomId).unreadCount, 3);
    chat.savePreferences(bob, roomId, { muted: true });
    await service.notifyMessage(message('$muted', `<@${bob}> later`, { users: [bob] }), [alice, bob]);
    assert.equal(sent.length, 1);
    assert.equal(chat.inbox(bob, [roomId], { filter: 'unread' }).events.length, 4);
  } finally {
    await service.close();
    chat.close();
    await rm(directory, { recursive: true, force: true });
  }
});
