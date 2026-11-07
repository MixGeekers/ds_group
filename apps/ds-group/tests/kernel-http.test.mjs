import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';

const ownerId = '@alice:kernel.test';
const botId = '@helper:kernel.test';
const botPath = `/api/bots/${encodeURIComponent(botId)}`;
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

async function fixture(t, config = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-http-'));
  const participants = [
    { id: ownerId, localpart: 'alice', kind: 'human', name: 'Same name', accessToken: 'synthetic-owner-token' },
    { id: '@bob:kernel.test', localpart: 'bob', kind: 'human', name: 'Same name', accessToken: 'synthetic-other-token' },
    { id: botId, localpart: 'helper', kind: 'bot', ownerId, name: 'Helper', accessToken: 'synthetic-bot-token' },
    { id: '@other:kernel.test', localpart: 'other', kind: 'bot', ownerId: '@bob:kernel.test', name: 'Helper', accessToken: 'synthetic-other-bot-token' },
  ];
  const matrix = createServer((request, response) => {
    const person = participants.find(person => request.headers.authorization === `Bearer ${person.accessToken}`);
    response.writeHead(person ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(person ? { user_id: person.id } : { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown account' }));
  });
  await new Promise(resolve => matrix.listen(0, '127.0.0.1', resolve));
  const options = { setup: { serverName: 'kernel.test', homeserverUrl: `http://127.0.0.1:${matrix.address().port}`, publicHomeserverUrl: 'https://matrix.kernel.test', roomId: '!room:kernel.test', participants },
    config: { nodeSecret: 'synthetic-legacy-secret', publicUrl: 'https://core.kernel.test', ...config }, dataRoot, enablePush: false };
  let core;
  let base;
  const tokens = {};
  async function start() {
    core = await createCore(options);
    for (const person of participants.filter(person => person.kind === 'bot')) tokens[person.localpart] = await core.nodeCredentials.issue(person);
    await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${core.server.address().port}`;
  }
  await start();
  t.after(async () => { await core.close(); await new Promise(resolve => matrix.close(resolve)); await rm(dataRoot, { recursive: true, force: true }); });
  async function request(route, { token = 'synthetic-owner-token', method = 'GET', body } = {}) {
    const response = await fetch(base + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const identity = { botId, nodeId: 'helper', runtimeId: 'run-1' };
  const nodeRequest = (route, body, token = tokens.helper) => request(route, { token, method: 'POST', body });
  async function heartbeat(extra = {}, who = identity) {
    return nodeRequest('/internal/nodes/heartbeat', { id: who.nodeId, botId: who.botId, runtimeId: who.runtimeId, status: 'idle', kernelControl: { version: 1 }, ...extra });
  }
  async function poll(who = identity) { return nodeRequest('/internal/kernel/poll', who); }
  async function nextCommand() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const polled = await poll();
      assert.equal(polled.status, 200);
      if (polled.body.commands.length) return polled.body.commands[0];
      await pause();
    }
    throw new Error('No management command was queued');
  }
  return { get core() { return core; }, request, nodeRequest, tokens, identity, heartbeat, poll, nextCommand,
    async restart() { await core.close(); await start(); } };
}

test('Core exposes owner-only kernel and attention endpoints using full account identities', async t => {
  const app = await fixture(t);
  assert.equal((await app.request(botPath + '/kernel', { token: null })).status, 401);
  assert.equal((await app.request(botPath + '/kernel', { token: 'synthetic-other-token' })).status, 403);
  assert.equal((await app.request(botPath + '/kernel', { token: 'synthetic-bot-token' })).status, 403);
  assert.equal((await app.request(botPath + '/kernel', { token: app.tokens.helper })).status, 401);
  assert.equal((await app.request('/api/bots/helper/kernel')).status, 403);
  assert.equal((await app.request('/api/bots/%invalid/kernel')).status, 400);
  assert.equal((await app.request('/api/bots/' + encodeURIComponent('@other:kernel.test') + '/kernel')).status, 403);
  let response = await app.request(botPath + '/kernel');
  assert.equal(response.status, 200);
  assert.equal(response.body.online, false);
  assert.equal(response.body.runtime.version, null);
  assert.equal(response.body.memorySummary.people, null);
  assert.equal(response.body.work.status, 'unknown');
  assert.equal((await app.request(botPath + '/attention', { token: 'synthetic-other-token', method: 'PATCH', body: { mode: 'natural' } })).status, 403);
  assert.equal((await app.request(botPath + '/attention', { method: 'PATCH', body: { mode: 'unbounded' } })).status, 400);
  response = await app.request(botPath + '/attention', { method: 'PATCH', body: { mode: 'natural' } });
  assert.deepEqual(response, { status: 200, body: { mode: 'natural', revision: 1, status: 'pending', applied: false, online: false } });
  await app.restart();
  response = await app.request(botPath + '/kernel');
  assert.deepEqual(response.body.desiredAttention, { mode: 'natural', revision: 1, status: 'pending' });
  assert.equal(response.body.attention.mode, 'natural');
  assert.equal((await app.heartbeat()).status, 200);
  const command = await app.nextCommand();
  assert.equal(command.operation, 'attention-set');
  const receipt = { ...command, status: 'completed', result: { mode: 'natural', revision: 1 } };
  assert.equal((await app.nodeRequest('/internal/kernel/result', receipt, app.tokens.other)).status, 403);
  assert.equal((await app.nodeRequest('/internal/kernel/result', receipt)).status, 200);
  assert.equal((await app.request(botPath + '/kernel')).body.desiredAttention.status, 'applied');
});

test('Core reads actual node memory over HTTP and keeps all kernel details out of public snapshots', async t => {
  const app = await fixture(t);
  const heartbeat = await app.heartbeat({ kernel: {
    runtime: { id: 'dscord', version: '0.4.0', upstreamVersion: '0.3.1', available: true },
    attention: { mode: 'shadow', activity: 'waiting', provider: { configured: true, available: false, model: 'route/model', decisionKey: 'private-provider-key' },
      queue: { pending: 1, waiting: 2, evaluating: 0, errors: 0 } },
    work: { status: 'working', activeTasks: 2, waiting: 1 }, memorySummary: { people: 4, projects: 2, pendingReview: 1 }, raw: 'private',
  } });
  assert.equal(heartbeat.status, 200);
  const kernel = await app.request(botPath + '/kernel');
  assert.equal(kernel.body.runtime.version, '0.4.0');
  assert.equal(kernel.body.attention.provider.configured, true);
  assert.equal(kernel.body.attention.provider.available, false);
  assert.equal(kernel.body.attention.activity, 'waiting');
  assert.equal(kernel.body.memorySummary.people, 4);
  assert.equal(JSON.stringify(kernel.body).includes('private'), false);
  for (const route of ['/api/status', '/api/bootstrap']) {
    const publicSnapshot = await app.request(route, { token: null });
    assert.equal(publicSnapshot.status, 200);
    assert.equal(publicSnapshot.body.nodes[0].kernel, undefined);
    assert.equal(publicSnapshot.body.nodes[0].kernelControl, undefined);
    assert.equal(JSON.stringify(publicSnapshot.body).includes('private'), false);
  }
  const pending = app.request(botPath + '/memory/profile?kind=person');
  let command = await app.nextCommand();
  assert.equal(command.operation, 'memory-profiles');
  const items = [{ id: 'matrix:@alice:kernel.test', name: 'Alice', kind: 'person', currentCount: 1, historyCount: 2, scopes: ['bot:helper'] }];
  assert.equal((await app.nodeRequest('/internal/kernel/result', { ...command, status: 'completed', result: { kind: 'person', items, more: false } })).status, 200);
  assert.deepEqual(await pending, { status: 200, body: { kind: 'person', items, more: false } });
  const id = 'matrix:@alice:kernel.test';
  const profilePending = app.request(botPath + '/memory/profile?kind=person&id=' + encodeURIComponent(id));
  command = await app.nextCommand();
  assert.equal(command.operation, 'memory-profile');
  assert.deepEqual(command.args, { kind: 'person', id });
  assert.equal((await app.nodeRequest('/internal/kernel/result', { ...command, status: 'completed', result: { kind: 'person', id,
    identity: { id, name: 'Alice' }, view: { currentClaims: [{ text: 'User prefers Chinese', source: { eventId: '$observed', authorId: ownerId } }], version: 1 } } })).status, 200);
  const profile = await profilePending;
  assert.equal(profile.status, 200);
  assert.equal(profile.body.id, id);
  assert.equal(profile.body.view.currentClaims[0].source.eventId, '$observed');
});

test('HTTP memory errors distinguish offline, unsupported, unknown evidence, failed runtime and timed out RPC', async t => {
  const app = await fixture(t, { kernelRpcTimeoutMs: 500 });
  let response = await app.request(botPath + '/memory/profile?kind=person');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'BOT_OFFLINE');
  await app.heartbeat({ kernelControl: null });
  response = await app.request(botPath + '/memory/profile?kind=person');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'KERNEL_CONTROL_UNAVAILABLE');
  await app.heartbeat();
  assert.equal((await app.request(botPath + '/memory/profile?kind=person', { token: 'synthetic-other-token' })).status, 403);
  assert.equal((await app.request(botPath + '/memory/profile?kind=invalid')).status, 400);
  assert.equal((await app.request(botPath + '/memory/profile?kind=person&id=')).status, 400);
  let pending = app.request(botPath + '/memory/profile?kind=project&id=project%3Aunknown');
  let command = await app.nextCommand();
  let result = { ...command, status: 'failed', error: { code: 'MEMORY_PROFILE_NOT_KNOWN', message: 'private-internal-detail' } };
  assert.equal((await app.nodeRequest('/internal/kernel/result', { ...result, leaseId: 'forged' })).status, 409);
  assert.equal((await app.nodeRequest('/internal/kernel/result', result)).status, 200);
  response = await pending;
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'MEMORY_PROFILE_NOT_KNOWN');
  assert.equal(JSON.stringify(response.body).includes('private'), false);
  pending = app.request(botPath + '/memory/profile?kind=person');
  command = await app.nextCommand();
  result = { ...command, status: 'error', error: { code: 'MEMORY_SERVICE_FAILED', message: 'private-internal-detail' } };
  assert.equal((await app.nodeRequest('/internal/kernel/result', result)).status, 200);
  response = await pending;
  assert.equal(response.status, 502);
  assert.equal(response.body.code, 'KERNEL_NODE_ERROR');
  assert.equal(response.body.nodeCode, 'MEMORY_SERVICE_FAILED');
  response = await app.request(botPath + '/memory/profile?kind=person');
  assert.equal(response.status, 504);
  assert.equal(response.body.code, 'KERNEL_TIMEOUT');
  assert.equal((await app.nodeRequest('/internal/kernel/result', { ...command, status: 'failed', error: { code: 'LATE' } })).status, 409);
});

test('node polling requires current scoped heartbeat and malformed management requests are rejected', async t => {
  const app = await fixture(t);
  assert.equal((await app.poll()).status, 409);
  assert.equal((await app.heartbeat({ status: 'speaking' })).status, 400);
  assert.equal((await app.heartbeat({ runtimeId: undefined })).status, 400);
  await app.heartbeat();
  assert.equal((await app.nodeRequest('/internal/kernel/poll', app.identity, app.tokens.other)).status, 403);
  assert.equal((await app.poll({ ...app.identity, runtimeId: 'old-runtime' })).body.code, 'KERNEL_RUNTIME_CHANGED');
  for (const route of ['/internal/kernel/poll', '/internal/kernel/result']) {
    for (const body of [null, [], 'invalid']) assert.equal((await app.nodeRequest(route, body)).status, 400);
  }
  const pending = app.request(botPath + '/memory/profile?kind=person');
  const command = await app.nextCommand();
  await app.heartbeat({ status: 'offline' });
  const disconnected = await pending;
  assert.equal(disconnected.status, 503);
  assert.equal(disconnected.body.code, 'BOT_OFFLINE');
  await app.heartbeat({}, { ...app.identity, runtimeId: 'run-2' });
  assert.equal((await app.nodeRequest('/internal/kernel/result', { ...command, status: 'failed', error: { code: 'OLD' } })).body.code, 'KERNEL_RUNTIME_CHANGED');
});

test('owner connection bundle marks a native binding without changing legacy node bundle schema', async t => {
  const app = await fixture(t);
  let response = await app.request(botPath + '/connect', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.equal(response.body.bundle.schemaVersion, 1);
  assert.equal(response.body.bundle.coreConfig.executionMode, undefined);
  assert.equal(response.body.bundle.setup.participants.find(person => person.id === botId).nativeBinding, undefined);
  const binding = { hostId: 'owner-host', nativeBotId: 'original-native', botId };
  app.core.accounts.db.prepare('INSERT INTO native_bot_bindings VALUES (?,?,?,?)').run(ownerId, binding.hostId, binding.nativeBotId, botId);
  response = await app.request(botPath + '/connect', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  const { bundle } = response.body;
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.coreConfig.executionMode, 'native');
  assert.deepEqual(bundle.coreConfig.nativeBinding, binding);
  assert.deepEqual(bundle.setup.participants.find(person => person.id === botId).nativeBinding, binding);
  assert.equal(bundle.setup.participants.filter(person => person.nativeBinding).length, 1);
  assert.equal(bundle.setup.participants.filter(person => person.accessToken).length, 1);
  assert.equal((await app.request(botPath + '/connect', { token: 'synthetic-other-token', method: 'POST', body: {} })).status, 403);
});
