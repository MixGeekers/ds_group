import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const alice = '@alice:http.test';
const bob = '@bob:http.test';
const bot = '@finance:http.test';
const roomId = '!group:http.test';

test('core HTTP routes connect mention picker, roles, actual message routing, inbox and read preferences', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-mention-http-'));
  const events = [];
  const matrix = http.createServer(async (request, response) => {
    const userId = request.headers.authorization?.slice('Bearer '.length);
    const url = new URL(request.url, 'http://localhost');
    let value;
    if (url.pathname.endsWith('/whoami')) value = { user_id: userId };
    else if (url.pathname.endsWith('/joined_rooms')) value = { joined_rooms: [roomId] };
    else if (url.pathname.endsWith('/joined_members')) value = { joined: { [alice]: {}, [bob]: {}, [bot]: {} } };
    else if (url.pathname.endsWith('/m.room.name/')) value = { name: 'HTTP mentions' };
    else if (url.pathname.endsWith('/messages')) value = { chunk: [...events].reverse() };
    else if (url.pathname.includes('/send/m.room.message/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const content = JSON.parse(Buffer.concat(chunks).toString());
      const event = { event_id: `$event-${events.length}`, type: 'm.room.message', room_id: roomId,
        sender: userId, origin_server_ts: 1000 + events.length, content };
      events.push(event);
      value = { event_id: event.event_id };
    } else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  const homeserverUrl = await listen(matrix);
  const setup = { homeserverUrl, roomId, participants: [
    { id: alice, localpart: 'alice', name: 'Alice', kind: 'human', accessToken: alice },
    { id: bob, localpart: 'bob', name: 'Bob', kind: 'human', accessToken: bob },
    { id: bot, localpart: 'finance', name: 'Finance', kind: 'bot', accessToken: bot },
  ] };
  const core = await createCore({ setup, dataRoot: directory, config: { nodeSecret: 'synthetic-mention-secret' }, enablePush: false });
  const base = await listen(core.server);
  async function call(route, userId = alice, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${userId}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  const roomPath = `/api/rooms/${encodeURIComponent(roomId)}`;
  try {
    const created = await call('/api/roles', alice, { name: '审阅组', color: '#aabbcc', memberIds: [bob], mentionable: false });
    assert.equal(created.status, 201);
    const roleId = created.value.role.id;
    assert.equal((await call('/api/roles', bob)).value.canManage, false);
    assert.equal((await call('/api/roles', bob, { name: 'forbidden', memberIds: [] })).status, 403);
    await call('/api/presence', bob, { status: 'online' });
    const picker = (await call(roomPath + '/mentionables')).value;
    assert.equal(picker.members.find(person => person.id === bob).status, 'online');
    assert.equal(picker.roles[0].id, roleId);
    assert.equal(picker.roles[0].canMention, true);
    assert.equal((await call(roomPath + '/mentionables', bob)).value.roles[0].canMention, false);
    assert.equal(picker.canMentionEveryone, true);
    const first = await call(roomPath + '/messages', alice, { body: `<@${bot}> read this`, transactionId: 'mention-bot', to: [], mentions: { users: [bot] } });
    assert.equal(first.status, 200);
    assert.deepEqual(events[0].content['org.ds_group'].to, [bot]);
    assert.deepEqual(events[0].content['m.mentions'].user_ids, [bot]);
    const second = await call(roomPath + '/messages', alice, { body: `@here <@&${roleId}> review`, transactionId: 'mention-role', mentions: { roles: [roleId], here: true } });
    assert.equal(second.status, 200);
    assert.deepEqual(events[1].content['org.ds_group'].mentions.hereUsers, [bob]);
    assert.equal((await call(roomPath + '/messages', bob, { body: '@everyone', transactionId: 'forbidden-ping' })).status, 403);
    assert.equal((await call(roomPath + '/messages', alice, { body: 'hello', transactionId: 'invalid-metadata', mentions: null })).status, 400);
    await call(roomPath + '/messages', bob);
    const inbox = (await call('/api/inbox', bob)).value;
    assert.equal(inbox.events.length, 1);
    assert.equal(inbox.events[0].event_id, events[1].event_id);
    assert.deepEqual(inbox.events[0].mentionKinds, ['role', 'here']);
    assert.equal((await call('/api/rooms', bob)).value.rooms[0].unreadCount, 2);
    assert.equal((await call(roomPath + '/read', bob, { eventId: events[1].event_id })).value.unreadCount, 0);
    const preferences = await call(roomPath + '/notifications', bob, { mode: 'mentions', suppressRoles: true }, 'PUT');
    assert.equal(preferences.value.mode, 'mentions');
    assert.equal((await call(roomPath + '/notifications', bob)).value.suppressRoles, true);
    assert.equal((await call('/api/roles/' + roleId, alice, undefined, 'DELETE')).value.deleted, true);
  } finally {
    await core.close();
    await new Promise(resolve => matrix.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
