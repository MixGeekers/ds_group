import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AccountService } from '../src/accounts.mjs';

const serverName = 'accounts.test';
const aliceId = `@alice:${serverName}`;
const roomId = `!lobby:${serverName}`;
const upstreamError = (status, errcode) => Object.assign(new Error(errcode), { status, errcode });

function matrixFixture() {
  const users = new Map([[aliceId, { password: 'alice-password', name: 'Alice' }]]);
  const tokens = new Map([['alice-server-token', { user_id: aliceId, device_id: 'legacy-alice' }]]);
  const joined = new Map([[aliceId, new Set([roomId])]]);
  const calls = [];
  let serial = 0;
  let lostRegistration = false;
  let failedJoin = false;
  const session = (userId, deviceId) => {
    for (const [token, old] of tokens) if (old.user_id === userId && old.device_id === deviceId) tokens.delete(token);
    const result = { user_id: userId, device_id: deviceId, access_token: `synthetic-token-${++serial}` };
    tokens.set(result.access_token, result);
    return result;
  };
  const clientFactory = token => {
    const identity = () => {
      const result = tokens.get(token);
      if (!result) throw upstreamError(401, 'M_UNKNOWN_TOKEN');
      return result;
    };
    return {
      async whoami() { return identity(); },
      async join(id) {
        const { user_id: userId } = identity();
        if (failedJoin) { failedJoin = false; throw upstreamError(503, 'M_UNAVAILABLE'); }
        if (!joined.has(userId)) joined.set(userId, new Set());
        joined.get(userId).add(id);
        return { room_id: id };
      },
      async request(method, route, body, options) {
        calls.push({ method, route, body, token, options });
        if (route === '/_synapse/admin/v1/register' && method === 'GET') return { nonce: `nonce-${serial}` };
        if (route === '/_synapse/admin/v1/register') {
          const userId = `@${body.username}:${serverName}`;
          if (users.has(userId)) throw upstreamError(400, 'M_USER_IN_USE');
          users.set(userId, { password: body.password, name: body.displayname });
          const result = session(userId, `registration-${serial}`);
          if (lostRegistration) { lostRegistration = false; throw new Error('Synthetic lost registration response'); }
          return result;
        }
        if (route === '/_matrix/client/v3/login') {
          const userId = body.identifier.user;
          if (users.get(userId)?.password !== body.password) throw upstreamError(403, 'M_FORBIDDEN');
          return session(userId, body.device_id);
        }
        const { user_id: userId } = identity();
        if (route === '/_matrix/client/v3/logout') { tokens.delete(token); return {}; }
        if (route === '/_matrix/client/v3/joined_rooms') return { joined_rooms: [...(joined.get(userId) || [])] };
        if (route.endsWith('/invite')) return {};
        if (route.includes('/profile/')) {
          if (method === 'PUT') users.get(userId).name = body.displayname;
          return { displayname: users.get(userId).name };
        }
        throw new Error(`Unhandled fixture route ${route}`);
      },
    };
  };
  return { users, tokens, joined, calls, clientFactory,
    loseNextRegistration() { lostRegistration = true; }, failNextJoin() { failedJoin = true; } };
}

async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'dscord-accounts-'));
  const matrix = matrixFixture();
  const setup = { serverName, homeserverUrl: 'https://matrix.accounts.test', roomId, participants: [
    { id: aliceId, localpart: 'alice', name: 'Alice', kind: 'human', accessToken: 'alice-server-token', password: 'legacy-password' },
  ] };
  const service = await new AccountService({ setup, dataRoot, registrationSecret: 'synthetic-registration-secret', clientFactory: matrix.clientFactory, ...options }).initialize();
  const services = [service];
  t.after(async () => { for (const value of services) value.close(); await rm(dataRoot, { recursive: true, force: true }); });
  return { service, dataRoot, matrix, setup, async restore() {
    service.close();
    const restoredSetup = { ...setup, participants: [{ id: aliceId, localpart: 'alice', name: 'Alice', kind: 'human', accessToken: 'alice-server-token' }] };
    const restored = await new AccountService({ setup: restoredSetup, dataRoot, registrationSecret: 'synthetic-registration-secret', clientFactory: matrix.clientFactory, ...options }).initialize();
    services.push(restored);
    return restored;
  } };
}

test('registration persists dynamic members, joins the lobby and isolates browser sessions from the server', async t => {
  const changed = [];
  const f = await fixture(t, { onParticipant: person => changed.push(person) });
  const originalArray = f.setup.participants;
  const session = await f.service.register({ username: 'charlie', password: 'human-password', displayName: 'Charlie' });
  const person = f.service.person(session.user_id);
  assert.equal(originalArray, f.setup.participants);
  assert.equal(person.name, 'Charlie');
  assert.notEqual(person.accessToken, session.access_token);
  assert.equal(f.matrix.joined.get(person.id).has(roomId), true);
  assert.equal(changed.length, 1);
  assert.deepEqual(await f.service.me(session.access_token), { user: { id: person.id, name: 'Charlie', kind: 'human', localpart: 'charlie' }, ownedBots: [] });
  const publicJson = JSON.stringify(f.service.publicParticipants());
  assert.equal(publicJson.includes('accessToken'), false);
  assert.equal(publicJson.includes('password'), false);
  assert.equal((await stat(path.join(f.dataRoot, 'accounts.sqlite'))).mode & 0o777, 0o600);
  const restored = await f.restore();
  assert.equal(restored.person(person.id).accessToken, person.accessToken);
  assert.equal(restored.ownerId, aliceId);
  assert.equal((await readFile(path.join(f.dataRoot, 'accounts.sqlite'))).includes(Buffer.from('human-password')), false);
});

test('each login has its own device and logout preserves other clients and the Core service token', async t => {
  const f = await fixture(t);
  const first = await f.service.login({ user: 'alice', password: 'alice-password' });
  const second = await f.service.login({ user: aliceId, password: 'alice-password' });
  assert.notEqual(first.device_id, second.device_id);
  assert.notEqual(first.access_token, second.access_token);
  assert.deepEqual(await f.service.logout(first.access_token), { loggedOut: true });
  await assert.rejects(f.service.me(first.access_token), error => error.status === 401);
  assert.equal((await f.service.me(second.access_token)).user.id, aliceId);
  assert.equal(f.matrix.tokens.has('alice-server-token'), true);
  assert.deepEqual(await f.service.logout('alice-server-token'), { loggedOut: true, localOnly: true });
  assert.equal(f.matrix.tokens.has('alice-server-token'), true);
  assert.equal((await f.service.me('alice-server-token')).user.id, aliceId);
  assert.equal(f.matrix.calls.some(call => call.route === '/_matrix/client/v3/logout' && call.token === 'alice-server-token'), false);
});

test('registration and service-session recovery retain the request client address for Matrix login limits', async t => {
  const f = await fixture(t);
  const clientIp = '192.0.2.10';
  const session = await f.service.register({ username: 'charlie', password: 'password' }, { clientIp });
  const registrationCalls = f.matrix.calls.filter(call => call.route === '/_synapse/admin/v1/register' || call.route === '/_matrix/client/v3/login');
  assert.equal(registrationCalls.length, 3);
  assert.equal(registrationCalls.every(call => call.options.clientIp === clientIp), true);
  f.matrix.tokens.delete(f.service.person(session.user_id).accessToken);
  f.matrix.calls.length = 0;
  const nextIp = '2001:db8::7';
  await f.service.login({ user: 'charlie', password: 'password' }, { clientIp: nextIp });
  const logins = f.matrix.calls.filter(call => call.route === '/_matrix/client/v3/login');
  assert.equal(logins.length, 2);
  assert.equal(logins.every(call => call.options.clientIp === nextIp), true);
  assert.equal(logins.some(call => call.body.device_id.startsWith('DSCORD_CORE_')), true);
});

test('registration recovery sends its current client address when an upstream response was lost', async t => {
  const f = await fixture(t);
  const input = { username: 'charlie', password: 'password' };
  f.matrix.loseNextRegistration();
  await assert.rejects(f.service.register(input, { clientIp: '192.0.2.10' }), /lost registration/);
  f.matrix.calls.length = 0;
  await f.service.register(input, { clientIp: '192.0.2.11' });
  const logins = f.matrix.calls.filter(call => call.route === '/_matrix/client/v3/login');
  assert.equal(logins.length, 2);
  assert.equal(logins.every(call => call.options.clientIp === '192.0.2.11'), true);
});

test('concurrent identical registrations share provisioning while conflicting credentials cannot take its reservation', async t => {
  const f = await fixture(t);
  const input = { username: 'charlie', password: 'secret', displayName: 'Charlie' };
  const first = f.service.register(input);
  const second = f.service.register(input);
  await assert.rejects(f.service.register({ ...input, password: 'other-password' }), error => error.status === 409);
  const sessions = await Promise.all([first, second]);
  assert.equal(sessions[0].user_id, sessions[1].user_id);
  assert.notEqual(sessions[0].access_token, sessions[1].access_token);
  assert.equal(f.matrix.calls.filter(call => call.method === 'POST' && call.route === '/_synapse/admin/v1/register').length, 1);
  assert.equal(f.service.publicParticipants().filter(person => person.localpart === 'charlie').length, 1);
});

test('lost registration responses recover after restart using the reserved identity and password', async t => {
  const f = await fixture(t);
  const input = { username: 'charlie', password: 'secret', displayName: 'Charlie' };
  f.matrix.loseNextRegistration();
  await assert.rejects(f.service.register(input), /lost registration/);
  assert.equal(f.service.person(`@charlie:${serverName}`), undefined);
  const restored = await f.restore();
  await assert.rejects(restored.register({ ...input, displayName: 'Someone else' }), error => error.status === 409);
  const session = await restored.register(input);
  assert.equal(restored.person(session.user_id).name, 'Charlie');
  assert.equal(f.matrix.users.size, 2);
});

test('an upstream existing account is left intact by registration and can be adopted by authenticated login', async t => {
  const f = await fixture(t);
  const id = `@existing:${serverName}`;
  f.matrix.users.set(id, { password: 'existing-password', name: 'Existing member' });
  const input = { username: 'existing', password: 'existing-password', displayName: 'Replacement name' };
  await assert.rejects(f.service.register(input), error => error.status === 409);
  await assert.rejects(f.service.register(input), error => error.status === 409);
  assert.equal(f.matrix.users.get(id).name, 'Existing member');
  const session = await f.service.login({ user: 'existing', password: 'existing-password' });
  assert.equal(session.user_id, id);
  assert.equal(f.service.person(id).kind, 'human');
  assert.equal(f.service.person(id).name, 'Existing member');
  assert.equal(f.matrix.users.get(id).name, 'Existing member');
});

test('a partial lobby join preserves credentials and succeeds on retry without creating a second account', async t => {
  const f = await fixture(t);
  f.matrix.failNextJoin();
  const input = { username: 'charlie', password: 'secret' };
  await assert.rejects(f.service.register(input), error => error.status === 503);
  const token = f.service.row(`@charlie:${serverName}`).service_token;
  const session = await f.service.register(input);
  assert.equal(f.service.person(session.user_id).accessToken, token);
  assert.equal(f.matrix.calls.filter(call => call.method === 'POST' && call.route === '/_synapse/admin/v1/register').length, 1);
});

test('owned Bot creation is idempotent, keeps duplicate display names independent and persists ownership', async t => {
  const f = await fixture(t);
  const first = f.service.createBot(aliceId, { name: 'Helper', requestId: 'one' });
  const again = f.service.createBot(aliceId, { name: 'Helper', requestId: 'one' });
  const [bot, duplicate] = await Promise.all([first, again]);
  assert.deepEqual(bot, duplicate);
  assert.match(bot.localpart, /^bot-[a-f0-9-]+$/);
  assert.equal(bot.ownerId, aliceId);
  assert.equal('accessToken' in bot, false);
  assert.equal(f.matrix.joined.has(bot.id), false);
  const other = await f.service.createBot(aliceId, { name: 'Helper', requestId: 'two' });
  assert.notEqual(bot.id, other.id);
  await assert.rejects(f.service.createBot(aliceId, { name: 'Different', requestId: 'one' }), error => error.status === 409);
  await assert.rejects(f.service.createBot(bot.id, { name: 'Invalid owner' }), error => error.status === 403);
  await assert.rejects(f.service.login({ user: bot.id, password: 'anything' }), error => error.status === 403);
  const restored = await f.restore();
  assert.deepEqual(restored.ownedBots(aliceId).map(value => value.id).sort(), [bot.id, other.id].sort());
  assert.equal((await restored.createBot(aliceId, { name: 'Helper', requestId: 'one' })).id, bot.id);
});

test('Bot creation resumes its durable password and identity after a lost upstream response', async t => {
  const f = await fixture(t);
  f.matrix.loseNextRegistration();
  await assert.rejects(f.service.createBot(aliceId, { name: 'Helper', requestId: 'resume' }), /lost registration/);
  const id = [...f.matrix.users.keys()].find(value => value !== aliceId);
  const restored = await f.restore();
  const bot = await restored.createBot(aliceId, { name: 'Helper', requestId: 'resume' });
  assert.equal(bot.id, id);
  assert.equal(f.matrix.users.size, 2);
});

test('closed or unconfigured registration rejects new humans while existing accounts can still sign in', async t => {
  const f = await fixture(t, { config: { registrationMode: 'closed' } });
  assert.deepEqual(f.service.registration(), { enabled: false, mode: 'closed' });
  await assert.rejects(f.service.register({ username: 'charlie', password: 'secret' }), /closed/);
  assert.equal((await f.service.login({ user: 'alice', password: 'alice-password' })).user_id, aliceId);
  const missing = await fixture(t, { registrationSecret: undefined });
  assert.deepEqual(missing.service.registration(), { enabled: false, mode: 'open' });
  await assert.rejects(missing.service.register({ username: 'charlie', password: 'secret' }), /registration configuration/);
});

test('malformed account bodies and foreign identities fail before contacting Matrix', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.register(null), error => error.status === 400);
  await assert.rejects(f.service.login([]), error => error.status === 400);
  await assert.rejects(f.service.createBot(aliceId, null), error => error.status === 400);
  await assert.rejects(f.service.login({ user: '@alice:elsewhere.test', password: 'password' }), error => error.status === 400);
  await assert.rejects(f.service.register({ username: 'other', password: 'secret', displayName: 'bad\nname' }), error => error.status === 400);
  assert.equal(f.matrix.calls.length, 0);
});

test('an empty unconfigured directory starts with registration disabled and never infers identity from its URL', async t => {
  const setup = { homeserverUrl: 'http://127.0.0.1:1', roomId, participants: [] };
  const f = await fixture(t, { setup, registrationSecret: undefined });
  assert.equal(f.service.serverName, undefined);
  assert.equal(setup.serverName, undefined);
  assert.deepEqual(f.service.publicParticipants(), []);
  assert.deepEqual(f.service.registration(), { enabled: false, mode: 'open' });
  await assert.rejects(f.service.login({ user: 'alice', password: 'password' }), error => error.status === 503);
  await assert.rejects(f.service.register({ username: 'alice', password: 'password' }), error => error.status === 403);
  assert.equal(f.matrix.calls.length, 0);
});

test('an empty directory reads Matrix identity from server metadata and retains it across restart', async t => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'dscord-empty-accounts-'));
  const setup = { homeserverUrl: 'http://127.0.0.1:1', participants: [] };
  await writeFile(path.join(dataRoot, 'server.json'), JSON.stringify({ serverName, registrationSecret: 'synthetic-secret' }));
  const service = await new AccountService({ setup, dataRoot }).initialize();
  t.after(async () => { service.close(); await rm(dataRoot, { recursive: true, force: true }); });
  assert.equal(service.serverName, serverName);
  assert.equal(setup.serverName, serverName);
  assert.deepEqual(service.registration(), { enabled: true, mode: 'open' });
  service.close();
  await rm(path.join(dataRoot, 'server.json'));
  const restored = await new AccountService({ setup: { homeserverUrl: setup.homeserverUrl, participants: [] }, dataRoot }).initialize();
  try {
    assert.equal(restored.serverName, serverName);
    assert.deepEqual(restored.registration(), { enabled: false, mode: 'open' });
  } finally { restored.close(); }
});
