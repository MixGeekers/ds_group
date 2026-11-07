import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';

const participants = [
  { id: '@alice:delivery.test', localpart: 'alice', name: 'Alice', kind: 'human', accessToken: 'test-alice' },
  { id: '@bob:delivery.test', localpart: 'bob', name: 'Bob', kind: 'human', accessToken: 'test-bob' },
  { id: '@finance:delivery.test', localpart: 'finance', name: 'Finance', kind: 'bot', accessToken: 'test-finance' },
  { id: '@hr:delivery.test', localpart: 'hr', name: 'HR', kind: 'bot', accessToken: 'test-hr' },
];

async function fixture(t, { lostCreateResponse = false, failedRecoveryLookups = 0, existingRoomMembers } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-direct-'));
  const rooms = new Map();
  const aliases = new Map();
  const calls = [];
  const sent = [];
  const events = new Map();
  let created = 0;
  if (existingRoomMembers) {
    const pair = [participants[0].id, participants[2].id].sort();
    const db = new DatabaseSync(path.join(directory, 'chat.sqlite'));
    db.exec('CREATE TABLE direct_rooms (pair_key TEXT PRIMARY KEY,room_id TEXT NOT NULL,participants_json TEXT NOT NULL)');
    db.prepare('INSERT INTO direct_rooms VALUES (?,?,?)').run(JSON.stringify(pair), '!existing:delivery.test', JSON.stringify(pair));
    db.close();
    rooms.set('!existing:delivery.test', { members: new Set(existingRoomMembers), invited: new Set() });
  }
  const matrix = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      const actor = participants.find(person => request.headers.authorization === `Bearer ${person.accessToken}`);
      if (!actor) return send(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown test account' });
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      const pathname = new URL(request.url, 'http://fixture').pathname;
      calls.push({ method: request.method, pathname, actor: actor.id });
      if (pathname.endsWith('/account/whoami')) return send(200, { user_id: actor.id });
      const directoryRoute = pathname.match(/^\/_matrix\/client\/v3\/directory\/room\/(.+)$/);
      if (directoryRoute) {
        if (created && failedRecoveryLookups > 0) {
          failedRecoveryLookups--;
          return send(503, { errcode: 'M_UNKNOWN', error: 'Directory temporarily unavailable' });
        }
        const roomId = aliases.get(decodeURIComponent(directoryRoute[1]));
        return roomId ? send(200, { room_id: roomId }) : send(404, { errcode: 'M_NOT_FOUND', error: 'Alias is unused' });
      }
      if (pathname.endsWith('/createRoom')) {
        const alias = `#${body.room_alias_name}:delivery.test`;
        if (aliases.has(alias)) return send(409, { errcode: 'M_ROOM_IN_USE', error: 'Alias already exists' });
        const roomId = `!created-${++created}:delivery.test`;
        aliases.set(alias, roomId);
        rooms.set(roomId, { members: new Set([actor.id]), invited: new Set(body.invite || []) });
        if (lostCreateResponse) { lostCreateResponse = false; response.destroy(); return; }
        return send(200, { room_id: roomId });
      }
      const join = pathname.match(/^\/_matrix\/client\/v3\/join\/(.+)$/);
      if (join) {
        const roomId = decodeURIComponent(join[1]);
        const room = rooms.get(roomId);
        if (!room || (!room.members.has(actor.id) && !room.invited.has(actor.id))) return send(403, { errcode: 'M_FORBIDDEN', error: 'No invitation' });
        room.members.add(actor.id);
        room.invited.delete(actor.id);
        return send(200, { room_id: roomId });
      }
      const members = pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/);
      if (members) {
        const room = rooms.get(decodeURIComponent(members[1]));
        if (!room?.members.has(actor.id)) return send(403, { errcode: 'M_FORBIDDEN', error: 'Not a member' });
        return send(200, { joined: Object.fromEntries([...room.members].map(id => [id, {}])) });
      }
      const reference = pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/event\/(.+)$/);
      if (reference) {
        const roomId = decodeURIComponent(reference[1]);
        if (!rooms.get(roomId)?.members.has(actor.id)) return send(403, { errcode: 'M_FORBIDDEN', error: 'Not a member' });
        const event = events.get(decodeURIComponent(reference[2]));
        return event ? send(200, event) : send(404, { errcode: 'M_NOT_FOUND', error: 'Unknown event' });
      }
      const message = pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m.room.message\/(.+)$/);
      if (message) {
        const roomId = decodeURIComponent(message[1]);
        if (!rooms.get(roomId)?.members.has(actor.id)) return send(403, { errcode: 'M_FORBIDDEN', error: 'Not a member' });
        sent.push({ roomId, content: body });
        const eventId = `$message-${sent.length}`;
        events.set(eventId, { event_id: eventId, room_id: roomId, type: 'm.room.message', sender: actor.id, content: body });
        return send(200, { event_id: eventId });
      }
      return send(404, { errcode: 'M_UNRECOGNIZED', error: 'Unsupported fixture endpoint' });
    } catch (error) { send(500, { errcode: 'M_UNKNOWN', error: error.message }); }
  });
  await new Promise(resolve => matrix.listen(0, '127.0.0.1', resolve));
  const options = { setup: { serverName: 'delivery.test', homeserverUrl: `http://127.0.0.1:${matrix.address().port}`, roomId: '!shared:delivery.test', participants },
    config: { nodeSecret: 'test-node-secret' }, dataRoot: directory, enablePush: false };
  let core;
  let url;
  async function start() {
    core = await createCore(options);
    await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${core.server.address().port}`;
  }
  await start();
  t.after(async () => { await core.close(); await new Promise(resolve => matrix.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return {
    rooms, calls, sent, events, created: () => created,
    async message(actor, roomId, body) {
      const response = await fetch(`${url}/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: 'POST',
        headers: { Authorization: `Bearer test-${actor}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    async direct(actor, target) {
      const response = await fetch(`${url}/api/dm`, { method: 'POST', headers: { Authorization: `Bearer test-${actor}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId: participants.find(person => person.localpart === target).id }) });
      return { status: response.status, body: await response.json() };
    },
    async restart() { await core.close(); await start(); },
  };
}

test('human and Bot reverse requests share one durable direct room', async t => {
  const app = await fixture(t);
  const [human, bot] = await Promise.all([app.direct('alice', 'finance'), app.direct('finance', 'alice')]);
  assert.equal(human.status, 200);
  assert.equal(bot.status, 200);
  assert.equal(human.body.roomId, bot.body.roomId);
  assert.equal(human.body.name, 'Finance');
  assert.equal(bot.body.name, 'Alice');
  assert.equal(app.created(), 1);
  assert.deepEqual([...app.rooms.get(bot.body.roomId).members].sort(), [participants[0].id, participants[2].id].sort());
  await app.restart();
  const restored = await app.direct('finance', 'alice');
  assert.equal(restored.body.roomId, bot.body.roomId);
  assert.equal(app.created(), 1);
  const peer = await app.direct('finance', 'hr');
  assert.equal(peer.status, 200);
  assert.notEqual(peer.body.roomId, bot.body.roomId);
  assert.equal(app.created(), 2);
});

test('Core determines conversation kind from its direct mapping and exact membership', async t => {
  const app = await fixture(t);
  const direct = await app.direct('alice', 'finance');
  assert.equal((await app.message('alice', direct.body.roomId, { transactionId: 'natural-dm', body: '请同伴整理文件', conversationKind: 'group' })).status, 200);
  assert.equal(app.sent[0].content['org.ds_group'].conversationKind, 'direct');
  assert.deepEqual(app.sent[0].content['org.ds_group'].to, [participants[2].id]);
  const group = '!group:delivery.test';
  app.rooms.set(group, { members: new Set([participants[0].id, participants[2].id]), invited: new Set() });
  assert.equal((await app.message('alice', group, { transactionId: 'ordinary-group', body: '请整理文件', to: [participants[2].id], conversationKind: 'direct' })).status, 200);
  assert.equal(app.sent[1].content['org.ds_group'].conversationKind, 'group');
  app.rooms.get(direct.body.roomId).members.add(participants[1].id);
  assert.equal((await app.message('alice', direct.body.roomId, { transactionId: 'expanded-dm', body: '请整理文件', conversationKind: 'direct' })).status, 200);
  assert.equal(app.sent[2].content['org.ds_group'].conversationKind, 'group');
});

test('a lost Matrix create receipt is recovered by alias without a second room', async t => {
  const app = await fixture(t, { lostCreateResponse: true });
  const result = await app.direct('finance', 'alice');
  assert.equal(result.status, 200);
  assert.equal(app.created(), 1);
  assert.equal(app.calls.filter(call => call.pathname.endsWith('/createRoom')).length, 1);
});

test('a pending direct creation recovers after core restart and reverse participant retry', async t => {
  const app = await fixture(t, { lostCreateResponse: true, failedRecoveryLookups: 1 });
  const first = await app.direct('finance', 'alice');
  assert.equal(first.status, 503);
  assert.equal(app.created(), 1);
  await app.restart();
  const retried = await app.direct('alice', 'finance');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.roomId, '!created-1:delivery.test');
  assert.equal(app.created(), 1);
});

test('existing direct mappings survive the alias upgrade and extra members are rejected', async t => {
  const pair = [participants[0].id, participants[2].id];
  const existing = await fixture(t, { existingRoomMembers: pair });
  const result = await existing.direct('finance', 'alice');
  assert.equal(result.status, 200);
  assert.equal(result.body.roomId, '!existing:delivery.test');
  assert.equal(existing.created(), 0);
  assert.equal(existing.calls.some(call => call.pathname.includes('/directory/')), false);
  const expanded = await fixture(t, { existingRoomMembers: [...pair, participants[1].id] });
  assert.equal((await expanded.direct('finance', 'alice')).status, 409);
  assert.equal(expanded.created(), 0);
});

test('Core threads keep an independent quoted reply and durable retry identity across restart', async t => {
  const app = await fixture(t);
  const roomId = '!threaded:delivery.test';
  app.rooms.set(roomId, { members: new Set(participants.map(person => person.id)), invited: new Set() });
  const root = await app.message('alice', roomId, { transactionId: 'root', body: '线程主题' });
  assert.equal(root.status, 200);
  const quote = await app.message('bob', roomId, { transactionId: 'quote', body: '引用内容' });
  const input = { transactionId: 'thread-reply', body: '在线程内引用', threadRootId: root.body.event_id, replyTo: quote.body.event_id,
    originThreadRootId: '$original-task-thread', to: [participants[2].id] };
  const result = await app.message('alice', roomId, input);
  assert.equal(result.status, 200);
  assert.deepEqual(app.sent[2].content['m.relates_to'], { rel_type: 'm.thread', event_id: root.body.event_id,
    'm.in_reply_to': { event_id: quote.body.event_id }, is_falling_back: false });
  assert.deepEqual(app.sent[2].content['m.mentions'].user_ids, [participants[1].id]);
  assert.deepEqual(app.sent[2].content['org.ds_group'].to, [participants[2].id]);
  await app.restart();
  assert.deepEqual(await app.message('alice', roomId, input), result);
  assert.equal(app.sent.length, 3);
  assert.equal((await app.message('alice', roomId, { ...input, threadRootId: quote.body.event_id })).status, 409);
  assert.equal((await app.message('alice', roomId, { ...input, threadRootId: undefined })).status, 409);
  assert.equal((await app.message('alice', roomId, { ...input, originThreadRootId: '$different-original-thread' })).status, 409);
  assert.equal(app.sent.length, 3);
});

test('Core accepts a root-only continuation and quiet same-room cross-thread quotation without inventing a reply ping', async t => {
  const app = await fixture(t);
  const roomId = '!quoted-thread:delivery.test';
  app.rooms.set(roomId, { members: new Set(participants.map(person => person.id)), invited: new Set() });
  const root = await app.message('alice', roomId, { transactionId: 'root', body: '当前主题' });
  const otherRoot = await app.message('bob', roomId, { transactionId: 'other-root', body: '另一个主题' });
  const quoted = await app.message('bob', roomId, { transactionId: 'other-thread-child', body: '别的线程里的原话', threadRootId: otherRoot.body.event_id });
  assert.equal(quoted.status, 200);
  assert.deepEqual(app.sent[2].content['m.relates_to'], { rel_type: 'm.thread', event_id: otherRoot.body.event_id,
    'm.in_reply_to': { event_id: otherRoot.body.event_id }, is_falling_back: true });
  assert.deepEqual(app.sent[2].content['m.mentions'].user_ids, []);
  const result = await app.message('alice', roomId, { transactionId: 'quote-without-ping', body: '引用别的线程，但继续当前主题',
    threadRootId: root.body.event_id, replyTo: quoted.body.event_id, replyMention: false });
  assert.equal(result.status, 200);
  assert.equal(app.sent[3].content['m.relates_to'].event_id, root.body.event_id);
  assert.equal(app.sent[3].content['m.relates_to']['m.in_reply_to'].event_id, quoted.body.event_id);
  assert.equal(app.sent[3].content['m.relates_to'].is_falling_back, false);
  assert.deepEqual(app.sent[3].content['m.mentions'].user_ids, []);
});

test('Core rejects foreign-room or unavailable references and using a thread child as a new thread root', async t => {
  const app = await fixture(t);
  const roomId = '!source:delivery.test';
  const otherRoom = '!destination:delivery.test';
  for (const id of [roomId, otherRoom]) app.rooms.set(id, { members: new Set(participants.map(person => person.id)), invited: new Set() });
  const root = await app.message('alice', roomId, { transactionId: 'root', body: '只在源房间' });
  const child = await app.message('alice', roomId, { transactionId: 'child', body: '线程内', threadRootId: root.body.event_id });
  assert.equal(child.status, 200);
  for (const [index, references] of [{ threadRootId: root.body.event_id }, { replyTo: root.body.event_id, replyMention: false }].entries()) {
    const result = await app.message('alice', otherRoom, { transactionId: `foreign-${index}`, body: '不可跨房间关联', ...references });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'INVALID_MESSAGE_REFERENCE');
  }
  const nested = await app.message('alice', roomId, { transactionId: 'nested', body: '不可嵌套线程', threadRootId: child.body.event_id });
  assert.equal(nested.status, 400);
  assert.equal(nested.body.code, 'INVALID_THREAD_ROOT');
  const unavailable = await app.message('alice', roomId, { transactionId: 'missing-root', body: '缺失根', threadRootId: '$unavailable' });
  assert.equal(unavailable.status, 400);
  assert.equal(unavailable.body.code, 'MESSAGE_REFERENCE_UNAVAILABLE');
  for (const [index, references] of [{ threadRootId: '' }, { threadRootId: 7 }, { replyTo: [] }, { originThreadRootId: false }].entries()) {
    assert.equal((await app.message('alice', roomId, { transactionId: `invalid-reference-${index}`, body: '无效引用', ...references })).status, 400);
  }
  assert.equal(app.sent.length, 2);
});
