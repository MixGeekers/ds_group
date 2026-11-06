import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore, readJsonBody } from '../src/core.mjs';

test('HTTP JSON keeps Chinese characters split across TCP chunks intact', async () => {
  const bytes = Buffer.from(JSON.stringify({ body: '你好' }));
  const boundary = bytes.indexOf(Buffer.from('你')) + 1;
  async function* chunks() { yield bytes.subarray(0, boundary); yield bytes.subarray(boundary); }
  assert.deepEqual(await readJsonBody(chunks()), { body: '你好' });
});

test('core publishes identities, keeps secrets local, and records a unique Bot runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-core-'));
  const setup = { homeserverUrl: 'http://127.0.0.1:1', roomId: '!demo:test', participants: [
    { id: '@alice:test', localpart: 'alice', name: 'Alice', kind: 'human', accessToken: 'synthetic-alice-token' },
    { id: '@finance:test', localpart: 'finance', name: 'Finance', kind: 'bot', accessToken: 'synthetic-bot-token' },
  ] };
  const core = await createCore({ setup, config: { nodeSecret: 'synthetic-node-secret', modelCallLimit: null, maxOutputTokens: 8192 }, dataRoot: directory, enablePush: false });
  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${core.server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-node-secret' };
  try {
    for (const route of ['/internal/model/claim', '/internal/nodes/heartbeat', '/api/login', '/api/register']) {
      for (const body of ['null', '[]', '"invalid"']) {
        assert.equal((await fetch(base + route, { method: 'POST', headers, body })).status, 400);
      }
    }
    const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
    assert.equal(bootstrap.participants.length, 2);
    assert.equal(JSON.stringify(bootstrap).includes('synthetic-alice-token'), false);
    const identity = { id: 'node-a', botId: '@finance:test', runtimeId: 'run-one', status: 'idle' };
    assert.equal((await fetch(base + '/internal/nodes/heartbeat', { method: 'POST', headers, body: JSON.stringify(identity) })).status, 200);
    assert.equal((await fetch(base + '/internal/nodes/heartbeat', { method: 'POST', headers, body: JSON.stringify({ ...identity, id: 'node-b', runtimeId: 'run-two' }) })).status, 409);
    assert.equal((await fetch(base + '/internal/model/claim', { method: 'POST', headers, body: JSON.stringify({ nodeId: 'node-a', requestId: 'm1', model: 'wrong', maxTokens: 10 }) })).status, 400);
    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.nodes[0].status, 'idle');
    assert.equal(status.budget.used, 0);
    for (const model of ['first/team/chat', 'second/model']) {
      const claimResponse = await fetch(base + '/internal/model/claim', { method: 'POST', headers,
        body: JSON.stringify({ nodeId: 'node-a', requestId: model, model, maxTokens: 10 }) });
      assert.equal(claimResponse.status, 200);
      const { claimId } = await claimResponse.json();
      assert.equal((await fetch(base + '/internal/model/complete', { method: 'POST', headers,
        body: JSON.stringify({ claimId, status: 'completed', usage: { outputTokens: 1 } }) })).status, 200);
    }
    const ledger = (await (await fetch(base + '/api/status')).json()).budget;
    assert.deepEqual(ledger.models, ['first/team/chat', 'second/model']);
    assert.equal(ledger.model, null);
    assert.equal(ledger.used, 2);
    assert.ok(ledger.claims.every(claim => claim.status === 'completed'));
    await fetch(base + '/internal/nodes/heartbeat', { method: 'POST', headers, body: JSON.stringify({ ...identity, status: 'offline' }) });
    const replacement = { ...identity, id: 'node-b', runtimeId: 'run-two' };
    assert.equal((await fetch(base + '/internal/nodes/heartbeat', { method: 'POST', headers, body: JSON.stringify(replacement) })).status, 200);
    const replaced = await (await fetch(base + '/api/status')).json();
    assert.equal(replaced.nodes[0].id, 'node-b');
    assert.equal(replaced.nodes[0].status, 'idle');
    assert.equal((await fetch(base + '/internal/nodes/heartbeat', { method: 'POST', headers, body: JSON.stringify({ ...replacement, id: 'node-c', runtimeId: 'run-three' }) })).status, 409);
    assert.equal((await fetch(base + '/api/demo-login?user=finance')).status, 404);
    assert.equal((await fetch(base + '/api/rooms/demo/messages')).status, 401);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
