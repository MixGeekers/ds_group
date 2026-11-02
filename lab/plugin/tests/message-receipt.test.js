import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GymService } from '../service.js';
import { serveTarget } from '../index.js';

const root = fileURLToPath(new URL('../../runtime/', import.meta.url));
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
async function setup(t) {
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'test-gym-message-receipt-'));
  const service = new GymService({ get: () => undefined }, { runtimeDir: dir }); await service.init();
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const created = await service.dispatch({ action: 'create', idempotencyKey: randomUUID(), driver: 'external', config: { scenarioId: 'free-chat', evaluationMode: 'outcome', keepOpen: true, noiseCount: 0, maxDurationMs: 600000 } });
  const { run, targetToken } = created;
  const invoke = (request, token = targetToken) => serveTarget(service, new Request('http://localhost/api/shiyu-gym/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: run.id, targetToken: token, request }) }));
  const snapshot = () => ({ state: JSON.stringify(service.state), run: JSON.stringify(service.engine.runtimes.get(run.id).run),
    files: ['gym-state.json', 'index.sqlite', 'index.sqlite-wal', `runs/${run.id}/events.jsonl`, `runs/${run.id}/snapshot.json`, `runs/${run.id}/manifest.json`]
      .map(name => { const file = path.join(dir, name); return existsSync(file) ? readFileSync(file).toString('base64') : null; }) });
  return { service, runId: run.id, invoke, snapshot };
}

test('public receipt query permits original sealed identity, returns metadata and never creates another effect', async t => {
  const { service, runId, invoke, snapshot } = await setup(t);
  const queryWithoutConnection = { action: 'message.receipt', operationId: 'not-connected', channelId: 'D-SHIYU', bodyHash: digest('不存在') };
  const disconnectedBefore = snapshot();
  assert.equal((await invoke(queryWithoutConnection)).status, 400);
  assert.deepEqual(snapshot(), disconnectedBefore, 'receipt query must not create a connection');
  assert.equal((await invoke({ action: 'connect' })).status, 200);
  const operationId = 'public-message', channelId = 'D-SHIYU', text = '公开协议合成回执';
  const sent = await invoke({ action: 'act', operationId, operation: { type: 'message.send', channelId, text } });
  assert.equal((await sent.json()).ok, true);
  const query = { action: 'message.receipt', operationId, channelId, bodyHash: digest(text) };
  const activeBefore = snapshot();
  assert.equal((await (await invoke(query)).json()).status, 'delivered');
  assert.deepEqual(snapshot(), activeBefore, 'active query must not refresh metrics, connection timestamps or persist any state');
  await service.dispatch({ action: 'control', runId, command: 'drain', idempotencyKey: randomUUID() });
  const files = () => ['events.jsonl', 'snapshot.json', 'manifest.json'].map(name => readFileSync(path.join(service.engine.runDir(runId), name), 'utf8'));
  const before = files(), terminalBefore = snapshot();
  const response = await invoke(query), receipt = await response.json();
  assert.equal(response.status, 200); assert.equal(receipt.status, 'delivered');
  assert.deepEqual(Object.keys(receipt).sort(), ['status', 'runId', 'operationId', 'channelId', 'bodyHash', 'eventId', 'observedAt'].sort());
  assert.deepEqual(files(), before);
  assert.deepEqual(snapshot(), terminalBefore);
  assert.equal((await (await invoke({ ...query, bodyHash: digest('错正文') })).json()).status, 'not_found');
  assert.deepEqual(files(), before);
  const invalid = await invoke({ ...query, operation: { type: 'message.send' } });
  assert.equal(invalid.status, 400); assert.deepEqual(files(), before);
  await invoke({ action: 'disconnect' });
  const afterDisconnect = snapshot();
  assert.equal((await invoke(query)).status, 400);
  assert.deepEqual(snapshot(), afterDisconnect);
});

test('receipt queries retain token, native occupancy and HTTP identity admission without state changes', async t => {
  const { service, runId, invoke, snapshot } = await setup(t);
  await invoke({ action: 'connect' });
  const query = { action: 'message.receipt', operationId: 'not-observed', channelId: 'D-SHIYU', bodyHash: digest('合成查询') };
  let before = snapshot();
  assert.equal((await invoke(query, 'invalid-synthetic-token')).status, 403);
  assert.deepEqual(snapshot(), before);
  service.state.bindings.push({ runId, role: 'target', sessionId: 'synthetic-native-occupancy', status: 'running' });
  before = snapshot();
  assert.equal((await invoke(query)).status, 400);
  assert.deepEqual(snapshot(), before);
  service.state.bindings.pop();
  const connection = service.state.connections[runId];
  connection.kind = 'session'; before = snapshot();
  assert.equal((await invoke(query)).status, 400);
  assert.deepEqual(snapshot(), before);
  connection.kind = 'http';
  await invoke({ action: 'disconnect' }); before = snapshot();
  assert.equal((await invoke(query)).status, 403, 'disconnect rotates the active-room token');
  assert.deepEqual(snapshot(), before);
});
