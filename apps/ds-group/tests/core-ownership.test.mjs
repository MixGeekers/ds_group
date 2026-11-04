import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';

const ids = {
  alice: '@alice:ds-group.test',
  bob: '@bob:ds-group.test',
  finance: '@finance:ds-group.test',
  hr: '@hr:ds-group.test',
};
const sharedRoomId = '!shared:ds-group.test';

async function fixture(t, { sharedMembers = Object.values(ids), extraRooms = [], failJoinsFor = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-ownership-'));
  const participants = Object.entries(ids).map(([localpart, id]) => ({
    id, localpart, name: localpart, kind: ['alice', 'bob'].includes(localpart) ? 'human' : 'bot',
    accessToken: `synthetic-${localpart}-token`,
  }));
  const rooms = new Map([
    [sharedRoomId, { name: '共同群 · Matrix 实际名称', members: new Set(sharedMembers), invited: new Set() }],
    ...extraRooms.map(room => [room.roomId, { name: room.name, members: new Set(room.members), invited: new Set(room.invited || []) }]),
  ]);
  const calls = [];
  const joinFailures = new Map(failJoinsFor.map(id => [id, 1]));
  let createdRooms = 0;
  const matrix = createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const actor = participants.find(person => request.headers.authorization === `Bearer ${person.accessToken}`)?.id;
      const pathname = new URL(request.url, 'http://fixture').pathname;
      calls.push({ method: request.method, pathname, actor, body });
      if (!actor) return send(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown synthetic member' });
      if (request.method === 'GET' && pathname === '/_matrix/client/v3/account/whoami') return send(200, { user_id: actor });
      if (request.method === 'GET' && pathname === '/_matrix/client/v3/joined_rooms') {
        return send(200, { joined_rooms: [...rooms].filter(([, room]) => room.members.has(actor)).map(([roomId]) => roomId) });
      }
      if (request.method === 'POST' && pathname === '/_matrix/client/v3/createRoom') {
        const roomId = `!created-${++createdRooms}:ds-group.test`;
        rooms.set(roomId, { name: body.name, members: new Set([actor]), invited: new Set(body.invite || []) });
        return send(200, { room_id: roomId });
      }
      const join = pathname.match(/^\/_matrix\/client\/v3\/join\/([^/]+)$/);
      if (request.method === 'POST' && join) {
        const roomId = decodeURIComponent(join[1]);
        const room = rooms.get(roomId);
        if (!room || (!room.members.has(actor) && !room.invited.has(actor))) return send(403, { errcode: 'M_FORBIDDEN', error: 'Member is not invited' });
        if (joinFailures.get(actor) > 0) {
          joinFailures.set(actor, joinFailures.get(actor) - 1);
          return send(503, { errcode: 'M_UNKNOWN', error: 'Synthetic temporary join failure' });
        }
        room.invited.delete(actor);
        room.members.add(actor);
        return send(200, { room_id: roomId });
      }
      const roomRoute = pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(.+)$/);
      if (roomRoute) {
        const room = rooms.get(decodeURIComponent(roomRoute[1]));
        if (!room || !room.members.has(actor)) return send(403, { errcode: 'M_FORBIDDEN', error: 'Caller is not a room member' });
        if (request.method === 'GET' && roomRoute[2] === 'joined_members') {
          return send(200, { joined: Object.fromEntries([...room.members].map(id => [id, { display_name: id }])) });
        }
        if (request.method === 'GET' && /^state\/m\.room\.name\/?$/.test(roomRoute[2])) return send(200, { name: room.name });
        const memberState = roomRoute[2].match(/^state\/m\.room\.member\/(.+)$/);
        if (request.method === 'GET' && memberState) {
          const target = decodeURIComponent(memberState[1]);
          return send(200, { membership: room.members.has(target) ? 'join' : room.invited.has(target) ? 'invite' : 'leave' });
        }
        if (request.method === 'POST' && roomRoute[2] === 'invite') {
          if (room.members.has(body.user_id)) return send(403, { errcode: 'M_FORBIDDEN', error: 'User already in room' });
          room.invited.add(body.user_id);
          return send(200, {});
        }
      }
      send(404, { errcode: 'M_UNRECOGNIZED', error: `Unimplemented fixture route ${pathname}` });
    } catch (error) { send(500, { errcode: 'M_UNKNOWN', error: error.message }); }
  });
  await new Promise(resolve => matrix.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${matrix.address().port}`;
  const coreOptions = {
    setup: { homeserverUrl: baseUrl, roomId: sharedRoomId, participants },
    config: { nodeSecret: 'synthetic-node-secret', modelCallLimit: null, maxOutputTokens: 8192 },
    enablePush: false,
    dataRoot: directory,
  };
  let core;
  let coreUrl;
  async function startCore() {
    core = await createCore(coreOptions);
    await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
    coreUrl = `http://127.0.0.1:${core.server.address().port}`;
  }
  await startCore();
  t.after(async () => {
    await core.close();
    await new Promise(resolve => matrix.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(actor, method, pathname, body) {
    const response = await fetch(coreUrl + pathname, {
      method,
      headers: { Authorization: `Bearer synthetic-${actor}-token`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function restartFixtureCore() {
    await core.close();
    await startCore();
  }
  return { request, rooms, calls, participants, restartFixtureCore };
}

test('synthetic ownership lists two Bots for Alice and none for Bob', async t => {
  const app = await fixture(t);
  const alice = await app.request('alice', 'GET', '/api/bots');
  const bob = await app.request('bob', 'GET', '/api/bots');
  assert.equal(alice.status, 200);
  assert.deepEqual(alice.body.bots.map(bot => bot.id).sort(), [ids.finance, ids.hr].sort());
  assert.ok(alice.body.bots.every(bot => bot.ownerId === ids.alice));
  assert.equal(bob.status, 200);
  assert.deepEqual(bob.body.bots, []);
});

test('synthetic owner creates a group with her Bot and another human using their distinct Matrix accounts', async t => {
  const app = await fixture(t);
  const response = await app.request('alice', 'POST', '/api/rooms', {
    name: '  预算项目  ', inviteIds: [ids.alice, ids.finance, ids.finance, ids.bob],
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.name, '预算项目');
  assert.deepEqual([...app.rooms.get(response.body.roomId).members].sort(), [ids.alice, ids.finance, ids.bob].sort());
  const creates = app.calls.filter(call => call.pathname.endsWith('/createRoom'));
  assert.equal(creates.length, 1);
  assert.equal(creates[0].actor, ids.alice);
  assert.deepEqual(creates[0].body.invite, [ids.finance, ids.bob]);
  const joins = app.calls.filter(call => call.pathname.includes('/join/'));
  assert.deepEqual(joins.map(call => call.actor).sort(), [ids.finance, ids.bob].sort());
  const listed = await app.request('alice', 'GET', '/api/rooms');
  const room = listed.body.rooms.find(item => item.roomId === response.body.roomId);
  assert.equal(room.name, '预算项目');
  assert.deepEqual(room.participantIds.sort(), [ids.alice, ids.finance, ids.bob].sort());
});

test('synthetic owner invites her Bot into an existing group and repeated invitation stays successful', async t => {
  const roomId = '!project:ds-group.test';
  const app = await fixture(t, { extraRooms: [{ roomId, name: '项目讨论', members: [ids.alice, ids.bob] }] });
  const pathname = `/api/rooms/${encodeURIComponent(roomId)}/invite`;
  const first = await app.request('alice', 'POST', pathname, { participantId: ids.finance });
  const repeated = await app.request('alice', 'POST', pathname, { participantId: ids.finance });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'joined');
  assert.equal(repeated.status, 200, 'Inviting an already joined owned Bot should return its current joined state');
  assert.equal(repeated.body.status, 'joined');
  assert.equal(app.rooms.get(roomId).members.size, 3);
  assert.ok(app.rooms.get(roomId).members.has(ids.finance));
});

test('synthetic group request identity survives fixture restart, avoids duplicate creation and rejects conflicting input', async t => {
  const app = await fixture(t);
  const input = { requestId: 'stable-group-request', name: '预算协作', inviteIds: [ids.finance, ids.bob] };
  const first = await app.request('alice', 'POST', '/api/rooms', input);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'joined');
  assert.equal(first.body.requestId, input.requestId);

  const repeated = await app.request('alice', 'POST', '/api/rooms', input);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.roomId, first.body.roomId);
  await app.restartFixtureCore();
  const recovered = await app.request('alice', 'POST', '/api/rooms', input);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.roomId, first.body.roomId);
  assert.equal(app.calls.filter(call => call.pathname.endsWith('/createRoom')).length, 1);

  const changedName = await app.request('alice', 'POST', '/api/rooms', { ...input, name: '不同项目' });
  const changedMembers = await app.request('alice', 'POST', '/api/rooms', { ...input, inviteIds: [ids.hr] });
  assert.equal(changedName.status, 409);
  assert.equal(changedMembers.status, 409);
  assert.equal(app.calls.filter(call => call.pathname.endsWith('/createRoom')).length, 1);
  assert.equal(app.rooms.size, 2);
});

test('synthetic partial member join retains the created room and retries that room after fixture restart', async t => {
  const app = await fixture(t, { failJoinsFor: [ids.finance] });
  const input = { requestId: 'partial-group-request', name: '待财务加入的项目', inviteIds: [ids.finance, ids.bob] };
  const first = await app.request('alice', 'POST', '/api/rooms', input);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'partially_joined');
  assert.equal(first.body.requestId, input.requestId);
  assert.ok(first.body.roomId);
  assert.deepEqual(first.body.joinResults.find(result => result.participantId === ids.finance), {
    participantId: ids.finance, status: 'pending', reason: 'M_UNKNOWN',
  });
  assert.equal(first.body.joinResults.find(result => result.participantId === ids.bob).status, 'joined');
  assert.deepEqual(first.body.participantIds.sort(), [ids.alice, ids.bob].sort());
  assert.equal(app.rooms.get(first.body.roomId).members.has(ids.finance), false);

  await app.restartFixtureCore();
  const retried = await app.request('alice', 'POST', '/api/rooms', input);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.roomId, first.body.roomId);
  assert.equal(retried.body.status, 'joined');
  assert.ok(retried.body.joinResults.every(result => result.status === 'joined'));
  assert.deepEqual(retried.body.participantIds.sort(), [ids.alice, ids.finance, ids.bob].sort());
  assert.equal(app.calls.filter(call => call.pathname.endsWith('/createRoom')).length, 1);
  assert.equal(app.rooms.size, 2);
});

test('synthetic non-owner cannot create a group with or invite somebody else’s Bot', async t => {
  const roomId = '!project:ds-group.test';
  const app = await fixture(t, { extraRooms: [{ roomId, name: '项目讨论', members: [ids.alice, ids.bob] }] });
  const created = await app.request('bob', 'POST', '/api/rooms', { name: 'Bob 的项目', inviteIds: [ids.finance] });
  const invited = await app.request('bob', 'POST', `/api/rooms/${encodeURIComponent(roomId)}/invite`, { participantId: ids.hr });
  assert.equal(created.status, 403);
  assert.equal(invited.status, 403);
  assert.equal(app.calls.filter(call => call.pathname.endsWith('/createRoom') || call.pathname.endsWith('/invite') || call.pathname.includes('/join/')).length, 0);
  assert.equal(app.rooms.size, 2);
});

test('synthetic room listing uses actual Matrix membership for the initial room and newly joined groups', async t => {
  const projectRoom = '!project:ds-group.test';
  const otherRoom = '!bob-only:ds-group.test';
  const externalHuman = '@colleague:elsewhere.test';
  const app = await fixture(t, {
    sharedMembers: [ids.alice, ids.bob],
    extraRooms: [
      { roomId: projectRoom, name: '实际项目名', members: [ids.alice, ids.hr, externalHuman] },
      { roomId: otherRoom, name: 'Bob 独立房间', members: [ids.bob] },
    ],
  });
  const response = await app.request('alice', 'GET', '/api/rooms');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rooms.map(room => room.roomId).sort(), [sharedRoomId, projectRoom].sort());
  const shared = response.body.rooms.find(room => room.roomId === sharedRoomId);
  const project = response.body.rooms.find(room => room.roomId === projectRoom);
  assert.deepEqual(shared.participantIds.sort(), [ids.alice, ids.bob].sort(), 'The initial room must not substitute the full setup roster for its actual membership');
  assert.equal(project.name, '实际项目名');
  assert.deepEqual(project.participantIds.sort(), [ids.alice, ids.hr, externalHuman].sort());
  assert.ok(app.calls.some(call => call.pathname === `/_matrix/client/v3/rooms/${encodeURIComponent(sharedRoomId)}/joined_members`));
});
