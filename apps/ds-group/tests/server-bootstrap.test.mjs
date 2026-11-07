import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapOptions, bootstrapServer } from '../scripts/server-bootstrap.mjs';
import { createCore } from '../src/core.mjs';

async function fixture(t, { interruptRegistration = false, registrationError } = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'dscord-bootstrap-'));
  const serverName = 'bootstrap.test';
  const registrationSecret = 'synthetic-bootstrap-secret';
  const users = new Map();
  const calls = { register: [], login: [], whoami: 0, createRoom: 0 };
  let roomId;
  const server = createServer(async (request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const route = decodeURIComponent(request.url);
      if (route === '/_synapse/admin/v1/register' && request.method === 'GET') {
        return reply(200, { nonce: 'synthetic-nonce' });
      }
      if (route === '/_synapse/admin/v1/register' && request.method === 'POST') {
        calls.register.push(input.username);
        if (registrationError) return reply(503, { errcode: registrationError, error: 'Synthetic registration failure' });
        const expectedMac = createHmac('sha1', registrationSecret)
          .update(['synthetic-nonce', input.username, input.password, 'notadmin'].join('\0')).digest('hex');
        assert.equal(input.mac, expectedMac);
        const id = `@${input.username}:${serverName}`;
        if (users.has(id)) return reply(400, { errcode: 'M_USER_IN_USE', error: 'Account already exists' });
        const user = { user_id: id, access_token: `synthetic-token-${input.username}`, password: input.password };
        users.set(id, user);
        if (interruptRegistration) {
          interruptRegistration = false;
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{');
          return;
        }
        return reply(200, { user_id: id, access_token: user.access_token });
      }
      if (route === '/_matrix/client/v3/login') {
        calls.login.push(input.identifier.user);
        const user = users.get(input.identifier.user);
        if (!user || user.password !== input.password) return reply(403, { errcode: 'M_FORBIDDEN', error: 'Invalid login' });
        return reply(200, { user_id: user.user_id, access_token: user.access_token });
      }
      const user = [...users.values()].find(entry => request.headers.authorization === `Bearer ${entry.access_token}`);
      if (!user) return reply(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token' });
      if (route === '/_matrix/client/v3/account/whoami') {
        calls.whoami++;
        return reply(200, { user_id: user.user_id });
      }
      if (request.method === 'PUT' && route.endsWith('/displayname')) return reply(200, {});
      if (route.startsWith('/_matrix/client/v3/directory/room/')) {
        return roomId ? reply(200, { room_id: roomId }) : reply(404, { errcode: 'M_NOT_FOUND', error: 'Room does not exist' });
      }
      if (route === '/_matrix/client/v3/createRoom') {
        calls.createRoom++;
        roomId = `!collaboration:${serverName}`;
        return reply(200, { room_id: roomId });
      }
      if (route === `/_matrix/client/v3/join/${roomId}`) return reply(200, { room_id: roomId });
      reply(404, { errcode: 'M_UNRECOGNIZED', error: `Unexpected route ${route}` });
    } catch (error) {
      reply(500, { errcode: 'FIXTURE_ERROR', error: error.message });
    }
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataRoot, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(dataRoot, 'server.json'), JSON.stringify({ serverName, registrationSecret }));
  const homeserverUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    options: { dataRoot, serverName, homeserverUrl, publicHomeserverUrl: homeserverUrl, demo: true }, calls, users,
    setup: async () => JSON.parse(await readFile(path.join(dataRoot, 'matrix-setup.json'), 'utf8')),
  };
}

test('explicit demo bootstrap registers four members without failed password logins', async t => {
  const context = await fixture(t);
  const result = await bootstrapServer(context.options);
  assert.deepEqual(context.calls.register, ['alice', 'bob', 'finance', 'hr']);
  assert.deepEqual(context.calls.login, []);
  assert.equal(context.users.size, 4);
  assert.equal(context.calls.createRoom, 1);
  const saved = await context.setup();
  assert.equal(saved.roomId, result.roomId);
  assert.ok(saved.participants.every(participant => participant.accessToken));
});

test('fresh server bootstrap is empty and makes no Matrix account or room requests', async t => {
  const context = await fixture(t);
  const result = await bootstrapServer({ ...context.options, demo: false });
  assert.deepEqual(result.participants, []);
  assert.equal(result.roomId, null);
  assert.equal(result.bootstrapMode, 'empty');
  assert.deepEqual(context.calls.register, []);
  assert.equal(context.calls.createRoom, 0);
  const saved = await context.setup();
  assert.deepEqual(saved.participants, []);
  await bootstrapServer(context.options);
  assert.deepEqual(await context.setup(), saved, 'reruns preserve an initialized registry even when demo is later selected');
});

test('an empty server accepts its first normal human registration without seeded accounts', async t => {
  const context = await fixture(t);
  await bootstrapServer({ ...context.options, demo: false });
  const core = await createCore({ setup: await context.setup(), dataRoot: context.options.dataRoot,
    config: { nodeSecret: 'synthetic-bootstrap-core', demoLogin: false }, enablePush: false });
  t.after(() => core.close());
  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${core.server.address().port}`;
  const initial = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.deepEqual(initial.participants, []);
  assert.equal(initial.demoLogin, false);
  const response = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'first-owner', displayName: 'First Owner', password: 'synthetic-user-chosen-password' }) });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const result = await response.json();
  assert.equal(result.user_id, '@first-owner:bootstrap.test');
  assert.deepEqual(context.calls.register, ['first-owner']);
  const after = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.deepEqual(after.participants.map(person => person.id), ['@first-owner:bootstrap.test']);
});

test('custom bootstrap profiles use chosen members and owners with private generated passwords', async t => {
  const context = await fixture(t);
  const profilesPath = path.join(context.options.dataRoot, 'initial-members.json');
  await writeFile(profilesPath, JSON.stringify([
    { localpart: 'editor', kind: 'bot', name: 'Editor', ownerId: '@lee:bootstrap.test' },
    { localpart: 'lee', kind: 'human', name: 'Lee' },
  ]));
  const result = await bootstrapServer({ ...context.options, demo: false, profilesPath });
  assert.equal(result.bootstrapMode, 'custom');
  assert.deepEqual(context.calls.register, ['editor', 'lee']);
  assert.equal(context.calls.createRoom, 1);
  const saved = await context.setup();
  assert.equal(saved.participants[0].ownerId, '@lee:bootstrap.test');
  assert.ok(saved.participants.every(person => person.password.length >= 32));
  assert.equal(new Set(saved.participants.map(person => person.password)).size, 2);
  assert.equal(JSON.stringify(result).includes(saved.participants[0].password), false);
});

test('invalid or ambiguous bootstrap inputs fail before registration', async t => {
  const context = await fixture(t);
  await assert.rejects(bootstrapServer({ ...context.options, demo: false,
    profiles: [{ localpart: 'editor', kind: 'bot', name: 'Editor', ownerId: '@missing:bootstrap.test' }] }), /owner/);
  await assert.rejects(bootstrapServer({ ...context.options, profiles: [] }), /demo or custom/);
  assert.deepEqual(context.calls.register, []);
  assert.equal(bootstrapOptions({}).demo, false);
  assert.equal(bootstrapOptions({ DS_GROUP_BOOTSTRAP_DEMO: 'true' }).demo, true);
  assert.throws(() => bootstrapOptions({ DS_GROUP_BOOTSTRAP_DEMO: 'yes' }), /true or false/);
});

test('bootstrap rerun preserves identities and reuses valid tokens without registration or login', async t => {
  const context = await fixture(t);
  await bootstrapServer(context.options);
  const original = await context.setup();
  context.calls.register.length = 0;
  await bootstrapServer(context.options);
  assert.deepEqual(await context.setup(), original);
  assert.deepEqual(context.calls.register, []);
  assert.deepEqual(context.calls.login, []);
  assert.equal(context.calls.whoami, 4);
  assert.equal(context.calls.createRoom, 1);
});

test('bootstrap recovers a registered account whose token was not persisted with one fallback login', async t => {
  const context = await fixture(t, { interruptRegistration: true });
  await assert.rejects(bootstrapServer(context.options), { errcode: 'M_INVALID_RESPONSE' });
  const interrupted = await context.setup();
  assert.equal(context.users.size, 1);
  assert.equal(interrupted.participants[0].accessToken, null);
  assert.deepEqual(context.calls.login, []);

  await bootstrapServer(context.options);
  assert.deepEqual(context.calls.register, ['alice', 'alice', 'bob', 'finance', 'hr']);
  assert.deepEqual(context.calls.login, ['@alice:bootstrap.test']);
  assert.equal(context.users.size, 4);
  const recovered = await context.setup();
  assert.deepEqual(recovered.participants.map(({ id, password }) => ({ id, password })),
    interrupted.participants.map(({ id, password }) => ({ id, password })));
  assert.ok(recovered.participants.every(participant => participant.accessToken));
});

test('unexpected registration failure stops bootstrap without attempting password login', async t => {
  const context = await fixture(t, { registrationError: 'M_UNAVAILABLE' });
  await assert.rejects(bootstrapServer(context.options), { status: 503, errcode: 'M_UNAVAILABLE' });
  assert.deepEqual(context.calls.register, ['alice']);
  assert.deepEqual(context.calls.login, []);
  assert.equal(context.users.size, 0);
  assert.equal(context.calls.createRoom, 0);
  assert.ok((await context.setup()).participants.every(participant => participant.accessToken === null));
});
