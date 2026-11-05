import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeCredentials, requireNodeScope } from '../src/node-auth.mjs';

const legacySecret = 'synthetic-legacy-secret';
const bearer = secret => ({ headers: { authorization: `Bearer ${secret}` } });
const people = [
  { id: '@alice:node.test', localpart: 'alice', kind: 'human' },
  { id: '@finance:node.test', localpart: 'finance', kind: 'bot' },
  { id: '@hr:node.test', localpart: 'hr', kind: 'bot' },
];

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'dscord-node-auth-'));
  const setup = { participants: people.map(person => ({ ...person })) };
  const connections = [];
  t.after(async () => { for (const connection of connections) await connection.close(); await rm(dataRoot, { recursive: true, force: true }); });
  return { dataRoot, setup, async open() {
    const connection = await new NodeCredentials({ dataRoot, setup, legacySecret }).initialize();
    connections.push(connection);
    return connection;
  } };
}

test('independent credential connections see newly issued scopes and converge on stable per-Bot secrets', async t => {
  const f = await fixture(t);
  const first = await f.open();
  const second = await f.open();
  const [finance, repeatedFinance, hr] = await Promise.all([
    first.issue(people[1]), second.issue(people[1]), second.issue(people[2]),
  ]);
  assert.equal(finance === repeatedFinance, true);
  assert.equal(finance !== hr, true);
  assert.deepEqual(second.authorize(bearer(finance)), { botId: people[1].id, nodeId: 'finance' });
  assert.deepEqual(first.authorize(bearer(hr)), { botId: people[2].id, nodeId: 'hr' });
  assert.equal((await stat(path.join(f.dataRoot, 'node-credentials.sqlite'))).mode & 0o777, 0o600);
  await first.close();
  await second.close();
  const restored = await f.open();
  assert.equal(await restored.issue(people[1]) === finance, true);
  assert.equal(await restored.issue(people[2]) === hr, true);
  assert.deepEqual(restored.authorize(bearer(finance)), { botId: people[1].id, nodeId: 'finance' });
});

test('legacy credentials keep their original scope while Bot credentials reject other identities', async t => {
  const f = await fixture(t);
  const service = await f.open();
  assert.equal(service.authorize(bearer(legacySecret)), null);
  requireNodeScope(null, { botId: people[2].id, nodeId: 'hr' });
  const scope = service.authorize(bearer(await service.issue(people[1])));
  requireNodeScope(scope, { botId: people[1].id, nodeId: 'finance' });
  assert.throws(() => requireNodeScope(scope, { botId: people[2].id }), error => error.status === 403);
  assert.throws(() => requireNodeScope(scope, { nodeId: 'hr' }), error => error.status === 403);
  assert.throws(() => service.authorize({ headers: {} }), error => error.status === 401);
  assert.throws(() => service.authorize(bearer('unrecognized-synthetic-secret')), error => error.status === 401);
  await assert.rejects(service.issue(people[0]), error => error.status === 403);
  await assert.rejects(service.issue({ ...people[1], localpart: 'hr' }), error => error.status === 403);
});

test('a removed or rebound Bot cannot continue using its persisted scope', async t => {
  const f = await fixture(t);
  const service = await f.open();
  const secret = await service.issue(people[1]);
  f.setup.participants[1].localpart = 'renamed';
  assert.throws(() => service.authorize(bearer(secret)), error => error.status === 403);
  await assert.rejects(service.issue(f.setup.participants[1]), error => error.status === 403);
  f.setup.participants.splice(1, 1);
  assert.throws(() => service.authorize(bearer(secret)), error => error.status === 403);
});
