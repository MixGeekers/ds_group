import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCore } from '../src/core.mjs';
import { ALLOWED_MODEL } from '../src/budget.mjs';

const legacySecret = 'synthetic-legacy-node-secret';
const financeId = '@finance:test';
const hrId = '@hr:test';
const identity = { requestId: 'finance-task', botId: financeId, roomId: '!room:test', eventId: '$event' };

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-node-scope-'));
  const setup = { homeserverUrl: 'http://127.0.0.1:1', serverName: 'test', roomId: '!room:test', participants: [
    { id: '@alice:test', localpart: 'alice', name: 'Alice', kind: 'human' },
    { id: financeId, localpart: 'finance', name: 'Finance', kind: 'bot', ownerId: '@alice:test' },
    { id: hrId, localpart: 'hr', name: 'HR', kind: 'bot', ownerId: '@alice:test' },
  ] };
  const core = await createCore({ setup, config: { nodeSecret: legacySecret, modelCallLimit: null, maxOutputTokens: 1024 }, dataRoot: directory, enablePush: false });
  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  const tokens = {};
  for (const bot of setup.participants.filter(person => person.kind === 'bot')) tokens[bot.localpart] = await core.nodeCredentials.issue(bot);
  const base = `http://127.0.0.1:${core.server.address().port}`;
  async function request(route, token, input) {
    const response = await fetch(base + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { core, tokens, request };
}

test('scoped node credentials restrict task creation, updates and controls to their Bot', async t => {
  const { core, tokens, request } = await fixture(t);
  const update = (token, input) => request('/internal/tasks/update', token, input);
  const control = (token, requestId = identity.requestId) => request(`/internal/tasks/${requestId}/control`, token);
  const queued = { ...identity, status: 'queued' };
  assert.equal((await update(tokens.hr, queued)).status, 403);
  assert.equal(core.tasks.get(identity.requestId), undefined);
  assert.equal((await update(tokens.finance, queued)).status, 200);
  const before = core.tasks.get(identity.requestId);
  assert.equal((await update(tokens.hr, { ...queued, botId: hrId, status: 'completed' })).status, 403);
  assert.equal((await update(tokens.hr, { ...queued, status: 'failed' })).status, 403);
  assert.equal((await control(tokens.hr)).status, 403);
  assert.deepEqual(core.tasks.get(identity.requestId), before);
  assert.equal((await control(tokens.finance)).status, 200);
  assert.equal((await control(tokens.finance, 'unknown-task')).status, 200);
  const completed = await update(tokens.finance, { ...queued, status: 'completed' });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.task.status, 'completed');
  assert.equal((await update(tokens.hr, { ...queued, botId: hrId, status: 'completed' })).status, 403);
  assert.equal((await control(tokens.hr)).status, 403);
  assert.equal((await update(tokens.finance, { ...queued, status: 'failed' })).body.task.status, 'completed');
  assert.equal((await control(legacySecret)).status, 200);
  const legacy = await update(legacySecret, { ...queued, requestId: 'legacy-hr-task', botId: hrId });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.task.botId, hrId);
  assert.equal((await control('invalid-secret')).status, 401);
});

test('malformed task identities return 400 before SQLite lookup through legacy and scoped routes', async t => {
  const { core, tokens, request } = await fixture(t);
  const valid = { ...identity, status: 'queued' };
  const malformed = [null, [], 'task', {},
    ...[undefined, null, {}, [], 1, '', 'invalid/id'].map(requestId => ({ ...valid, requestId })),
    { ...valid, botId: undefined },
  ];
  for (const token of [legacySecret, tokens.finance]) {
    for (const input of malformed) {
      const response = await request('/internal/tasks/update', token, input);
      assert.equal(response.status, 400, JSON.stringify(input));
    }
  }
  for (const input of malformed) assert.throws(() => core.tasks.update(input), error => error.status === 400);
  assert.equal(core.tasks.db.prepare('SELECT COUNT(*) AS count FROM file_tasks').get().count, 0);
});

test('scoped model completion checks the stored Bot before both first and duplicate receipts', async t => {
  const { core, tokens, request } = await fixture(t);
  const input = { nodeId: 'finance', requestId: 'generation-one', model: ALLOWED_MODEL, maxTokens: 64 };
  assert.equal((await request('/internal/model/claim', tokens.hr, input)).status, 403);
  assert.equal(core.budget.snapshot().used, 0);
  const claim = await request('/internal/model/claim', tokens.finance, input);
  assert.equal(claim.status, 200);
  const completion = { claimId: claim.body.claimId, status: 'completed', usage: { totalTokens: 15 } };
  const before = core.budget.snapshot();
  assert.equal((await request('/internal/model/complete', tokens.hr, completion)).status, 403);
  assert.deepEqual(core.budget.snapshot(), before);
  assert.deepEqual(await request('/internal/model/complete', tokens.finance, completion), { status: 200, body: { recorded: true, duplicate: false } });
  const after = core.budget.snapshot();
  assert.equal((await request('/internal/model/complete', tokens.hr, completion)).status, 403);
  assert.deepEqual(core.budget.snapshot(), after);
  assert.deepEqual(await request('/internal/model/complete', tokens.finance, completion), { status: 200, body: { recorded: true, duplicate: true } });
  assert.deepEqual(await request('/internal/model/complete', legacySecret, completion), { status: 200, body: { recorded: true, duplicate: true } });
  assert.deepEqual(core.budget.snapshot(), after);
});

test('scoped heartbeat binds both node and Bot identity and rejects malformed internal bodies', async t => {
  const { tokens, request } = await fixture(t);
  const heartbeat = { id: 'finance', botId: financeId, runtimeId: 'runtime-one', status: 'idle' };
  assert.equal((await request('/internal/nodes/heartbeat', tokens.finance, heartbeat)).status, 200);
  assert.equal((await request('/internal/nodes/heartbeat', tokens.finance, { ...heartbeat, botId: hrId })).status, 403);
  assert.equal((await request('/internal/nodes/heartbeat', tokens.finance, { ...heartbeat, id: 'hr' })).status, 403);
  for (const route of ['/internal/model/claim', '/internal/model/complete', '/internal/nodes/heartbeat']) {
    for (const body of [null, [], 'invalid']) assert.equal((await request(route, tokens.finance, body)).status, 400);
  }
});
