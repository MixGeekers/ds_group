import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';
import { validateIdentityOptions } from '../src/identity.mjs';
import { initializeServer } from '../scripts/server-init.mjs';
import { initializeCentralIdentity } from '../scripts/central-init.mjs';
import { HomeSession, discoverHome, parseHomeDiscovery } from './helpers/home-session.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const stop = server => new Promise(resolve => server.close(resolve));

async function fixture(t, { extraParticipants = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dscord-identity-'));
  const calls = [];
  const matrix = http.createServer((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization === 'Bearer alice-client' || req.headers.authorization === 'Bearer alice-service') return res.end(JSON.stringify({ user_id: '@alice:home.test' }));
    const extra = extraParticipants.find(person => req.headers.authorization === `Bearer ${person.accessToken}`);
    if (extra) return res.end(JSON.stringify({ user_id: extra.id }));
    res.writeHead(401); res.end(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'Expired or revoked' }));
  });
  const matrixUrl = await listen(matrix);
  const setup = { serverName: 'home.test', homeserverUrl: matrixUrl, publicHomeserverUrl: matrixUrl,
    roomId: null, participants: [{ id: '@alice:home.test', kind: 'human', localpart: 'alice', name: 'Alice', accessToken: 'alice-service' }, ...extraParticipants] };
  const config = { nodeSecret: 'private-node-secret', demoLogin: false, identity: { mode: 'central', coreUrl: 'https://core.test', matrixUrl, clientOrigins: ['https://client.test'] } };
  const core = await createCore({ dataRoot: root, setup, config, enablePush: false });
  const base = await listen(core.server);
  t.after(async () => { await core.close(); await stop(matrix); await rm(root, { recursive: true, force: true }); });
  return { core, base, root, matrixUrl, calls };
}

test('discovery is public, explicit, credential-free and independent of Host headers', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/.well-known/dscord/client', { headers: { Origin: 'https://untrusted.test', Host: 'untrusted.test' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const value = await response.json();
  assert.equal(value.home.coreUrl, 'https://core.test');
  assert.equal(value.home.matrixUrl, f.matrixUrl);
  assert.equal(value.credentials.remoteCore, 'forbidden');
  assert.equal(JSON.stringify(value).includes('private-node-secret'), false);
  assert.equal(JSON.stringify(value).includes('alice-service'), false);
  assert.deepEqual(await (await fetch(f.base + '/api/client-config')).json(), value);
  assert.equal((await (await fetch(f.base + '/.well-known/matrix/client')).json())['m.homeserver'].base_url, f.matrixUrl);
  assert.equal((await fetch(f.base + '/api/bootstrap', { headers: { Authorization: 'Bearer alice-client' } })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('explicit client origins permit preflight and authenticated calls; unknown origins fail before Matrix', async t => {
  const f = await fixture(t);
  const preflight = await fetch(f.base + '/api/login', { method: 'OPTIONS', headers: { Origin: 'https://client.test',
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization, x-upload-id' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://client.test');
  assert.equal(preflight.headers.has('access-control-allow-credentials'), false);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Upload-Id/);
  for (const origin of ['https://evil.test', 'null', 'https://client.test/']) {
    const denied = await fetch(f.base + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"user":"alice","password":"secret"}' });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'CLIENT_ORIGIN_DENIED');
  }
  assert.equal(f.calls.length, 0);
  const me = await fetch(f.base + '/api/me', { headers: { Origin: 'https://client.test', Authorization: 'Bearer alice-client' } });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('access-control-allow-origin'), 'https://client.test');
  assert.equal((await me.json()).identity.matrixUserId, '@alice:home.test');
});

test('a separate allowed client can PATCH owned Bot participation while owner and origin checks still apply', async t => {
  const botId = '@owned:home.test';
  const f = await fixture(t, { extraParticipants: [
    { id: botId, localpart: 'owned', kind: 'bot', name: 'Owned', ownerId: '@alice:home.test' },
    { id: '@bob:home.test', localpart: 'bob', kind: 'human', name: 'Bob', accessToken: 'bob-client' },
  ] });
  const route = `/api/bots/${encodeURIComponent(botId)}/attention`;
  const preflight = origin => fetch(f.base + route, { method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type, authorization' } });
  const allowed = await preflight('https://client.test');
  assert.equal(allowed.status, 204);
  assert.match(allowed.headers.get('access-control-allow-methods'), /(?:^|, )PATCH(?:,|$)/);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://client.test');
  assert.equal((await preflight('https://evil.test')).status, 403);
  assert.equal(f.calls.length, 0, 'Browser preflights do not authenticate or mutate settings');
  const patch = (token, mode) => fetch(f.base + route, { method: 'PATCH', headers: { Origin: 'https://client.test',
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
  const saved = await patch('alice-client', 'natural');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).mode, 'natural');
  const denied = await patch('bob-client', 'mention');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'BOT_OWNER_REQUIRED');
  assert.equal(f.core.kernelControl.desired(botId).mode, 'natural');
});

test('the shared Core guard rejects disabled and expired accounts before every protected route', async t => {
  const f = await fixture(t);
  f.core.accounts.db.prepare("UPDATE accounts SET status='disabled' WHERE user_id=?").run('@alice:home.test');
  for (const route of ['/api/me', '/api/attachments/unknown/metadata', '/api/rooms/unknown/messages', '/api/spaces', '/api/bots', '/api/tasks/unknown', '/api/push/subscriptions']) {
    const response = await fetch(f.base + route, { headers: { Authorization: 'Bearer alice-client' } });
    assert.equal(response.status, 403, route);
    assert.match((await response.json()).error, /not active/);
  }
  assert.equal((await fetch(f.base + '/api/me', { headers: { Authorization: 'Bearer expired-client' } })).status, 401);
});

test('central initialization is repeatable, preserves a permanent home and validates before publishing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dscord-central-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { dataRoot: path.join(root, 'core'), synapseRoot: path.join(root, 'matrix'), serverName: 'home.test',
    homeserverUrl: 'http://synapse:8008', publicUrl: 'https://core.test', publicHomeserverUrl: 'https://matrix.test' };
  await initializeServer(options, { containerOwnership: false });
  const params = { dataRoot: options.dataRoot, coreUrl: options.publicUrl, matrixUrl: options.publicHomeserverUrl, clientOrigins: ['https://client.test'] };
  const first = await initializeCentralIdentity(params);
  const state = await readFile(path.join(options.dataRoot, 'identity-config.json'), 'utf8');
  const second = await initializeCentralIdentity(params);
  assert.equal(second.authorityId, first.authorityId);
  assert.equal(await readFile(path.join(options.dataRoot, 'identity-config.json'), 'utf8'), state);
  assert.equal(second.registeredAccounts, 0);
  const config = JSON.parse(await readFile(path.join(options.dataRoot, 'core-config.json'), 'utf8'));
  assert.equal(config.demoLogin, false);
  await assert.rejects(initializeCentralIdentity({ ...params, coreUrl: 'https://evil.test/path' }), /origin/);
  assert.equal(await readFile(path.join(options.dataRoot, 'identity-config.json'), 'utf8'), state);
  await assert.rejects(initializeServer({ ...options, serverName: 'replacement.test' }, { containerOwnership: false }), /Existing Matrix identity/);
  for (const identity of [{ mode: 'oidc' }, { clientOrigins: ['*'] }, { clientOrigins: ['http://public.test'] }, { mode: 'central', matrixUrl: 'http://synapse:8008' }]) {
    assert.throws(() => validateIdentityOptions(identity));
  }
});

test('home transport pins sessions and refuses remote/admin/redirect credential targets', async t => {
  const f = await fixture(t);
  const discovery = await discoverHome(f.base);
  discovery.home.coreUrl = f.base;
  discovery.credentials.coreOrigin = f.base;
  const client = new HomeSession(discovery, f.base);
  const session = { access_token: 'alice-client', user_id: '@alice:home.test', identity: f.core.accounts.identity('@alice:home.test'), home: client.home };
  client.restore(session);
  assert.throws(() => client.restore({ ...session, home: { ...client.home, coreUrl: 'https://evil.test' } }), /another home/);
  assert.throws(() => client.restore({ ...session, expiresAt: Date.now() - 1 }), error => error.code === 'SESSION_EXPIRED');
  for (const target of ['https://evil.test/api/me', '//evil.test/api/me', '/api/../_synapse/admin/v1/users', '/internal/nodes/heartbeat', '/api/../../evil', '/api/\\evil']) {
    await assert.rejects(client.request(target), error => error.code === 'CREDENTIAL_TARGET_DENIED');
  }
  await assert.rejects(client.matrixRequest('/_synapse/admin/v1/users'), error => error.code === 'CREDENTIAL_TARGET_DENIED');
  const mutated = structuredClone(discovery); mutated.credentials.matrixOrigin = 'https://evil.test';
  assert.throws(() => parseHomeDiscovery(mutated, f.base), /Inconsistent/);
  assert.equal(client.home.coreUrl, f.base);
  assert.equal((await client.me()).user.id, '@alice:home.test');
  assert.equal((await client.matrixRequest('/_matrix/client/v3/account/whoami')).status, 200);
});

test('password, token and media requests never follow even same-origin credential redirects', async t => {
  const received = [];
  let sameOriginReceived = 0;
  const receiver = http.createServer((req, res) => { received.push(req.url); req.resume(); res.end('{}'); });
  const receiverUrl = await listen(receiver);
  const redirector = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/capture') { sameOriginReceived++; res.end('{}'); return; }
    res.writeHead(307, { Location: req.url === '/same-origin-start' ? '/capture' : receiverUrl + '/capture' }); res.end();
  });
  const redirectUrl = await listen(redirector);
  t.after(async () => { await stop(redirector); await stop(receiver); });
  const matrix = new MatrixClient({ baseUrl: redirectUrl, accessToken: 'private-token' });
  await assert.rejects(matrix.request('POST', '/_matrix/client/v3/login', { password: 'private-password' }));
  await assert.rejects(matrix.request('POST', '/same-origin-start', { password: 'private-password' }));
  await assert.rejects(matrix.whoami());
  await assert.rejects(matrix.downloadMedia('mxc://remote.test/one'));
  await assert.rejects(matrix.uploadMedia(Buffer.from('private-file'), { filename: 'file.txt', size: 12 }));
  assert.deepEqual(received, []);
  assert.equal(sameOriginReceived, 0);
});

test('standalone discovery keeps null Core fallback and session restore resolves only its trusted source', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dscord-legacy-'));
  const core = await createCore({ dataRoot: root, enablePush: false,
    setup: { serverName: 'legacy.test', homeserverUrl: 'http://127.0.0.1:1', participants: [] },
    config: { nodeSecret: 'legacy-private-secret', demoLogin: false } });
  const base = await listen(core.server);
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const discovery = await discoverHome(base);
  assert.equal(discovery.mode, 'standalone'); assert.equal(discovery.home.coreUrl, null);
  const client = new HomeSession(discovery, base);
  const session = { user_id: '@old:legacy.test', access_token: 'synthetic-old-token', home: discovery.home,
    identity: { authorityId: discovery.authorityId, subjectId: 'old-subject', matrixUserId: '@old:legacy.test', kind: 'human' } };
  assert.equal(client.restore(session).home.coreUrl, base);
  assert.equal(client.restore(client.export()).home.coreUrl, base);
  // A same-origin reverse proxy preserves Host even though its upstream listener is HTTP.
  const proxy = await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/login', { method: 'POST', headers: { Host: 'legacy.test', Origin: 'https://legacy.test', 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.once('end', () => resolve({ status: response.statusCode, origin: response.headers['access-control-allow-origin'] }));
    });
    request.once('error', reject); request.end('null');
  });
  assert.equal(proxy.status, 400); assert.equal(proxy.origin, 'https://legacy.test');
  const unrelated = await fetch(base + '/api/login', { method: 'POST', headers: { Host: 'legacy.test', Origin: 'https://other.test', 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(unrelated.status, 403);
});

test('existing HTTP private-network single-server deployments retain their configured origin', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dscord-private-home-'));
  const core = await createCore({ dataRoot: root, enablePush: false,
    setup: { serverName: 'private.test', homeserverUrl: 'http://192.168.20.3:8008', participants: [] },
    config: { nodeSecret: 'private-network-secret', demoLogin: false, publicUrl: 'http://192.168.20.3:18100' } });
  const base = await listen(core.server);
  t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
  const discovery = await (await fetch(base + '/api/client-config')).json();
  assert.equal(discovery.home.coreUrl, 'http://192.168.20.3:18100');
  assert.equal(discovery.home.matrixUrl, 'http://192.168.20.3:8008');
  const response = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: 'http://192.168.20.3:18100', 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(response.status, 400);
});
