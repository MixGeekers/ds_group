import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabEngine } from '../src/engine.ts';
import type { LabStore } from '../src/store.ts';
import type { RunDetail } from '../src/types.ts';

const runtimeRoot = fileURLToPath(new URL('../runtime/', import.meta.url));
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const channelId = 'D-SHIYU';
async function setup(t: TestContext) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'test-message-receipt-'));
  const engine = new LabEngine({ runtimeDir: root }); await engine.init();
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const { run } = await engine.createRun({ scenarioId: 'free-chat', target: 'external', evaluationMode: 'outcome', keepOpen: true, noiseCount: 0, maxDurationMs: 600000 });
  // Test-only fault injection into the real persistence boundary, never a replacement receipt implementation.
  const internals = engine as unknown as { store: LabStore; runtimes: Map<string, { run: RunDetail }> };
  const unchanged = () => ({ memory: JSON.stringify(internals.runtimes.get(run.id)!.run),
    files: ['events.jsonl', 'snapshot.json', 'manifest.json'].map(file => readFileSync(path.join(engine.runDir(run.id), file), 'utf8')) });
  return { engine, id: run.id, store: internals.store, unchanged };
}

test('message receipt cold-reads the delivered effect when operation receipt persistence failed', async t => {
  const { engine, id, store, unchanged } = await setup(t);
  const operationId = 'effect-before-receipt', text = '仅用于合成回执验证。';
  const save = store.saveOperation;
  store.saveOperation = () => { throw new Error('synthetic receipt persistence failure'); };
  try { await assert.rejects(engine.act(id, { type: 'message.send', channelId, text }, operationId), /synthetic/); }
  finally { store.saveOperation = save; }
  assert.equal(store.getOperation(id, operationId), undefined);
  const before = unchanged();
  const receipt = engine.messageReceipt(id, { operationId, channelId, bodyHash: digest(text) });
  assert.equal(receipt.status, 'delivered');
  assert.deepEqual(Object.keys(receipt).sort(), ['status', 'runId', 'operationId', 'channelId', 'bodyHash', 'eventId', 'observedAt'].sort());
  const event = engine.eventsSince(id).find(value => value.type === 'message.delivered')!;
  assert.equal(receipt.status === 'delivered' && receipt.eventId, event.id);
  assert.equal(receipt.status === 'delivered' && receipt.observedAt, event.at);
  assert.deepEqual(unchanged(), before);
  assert.equal(store.getOperation(id, operationId), undefined, 'observation must not repair the missing operation receipt');
});

test('wrong body, channel, operation and non-target source never become delivered', async t => {
  const { engine, id, unchanged } = await setup(t);
  const operationId = 'body-bound', text = '核对正文';
  assert.equal((await engine.act(id, { type: 'message.send', channelId, text }, operationId)).ok, true);
  const base = { operationId, channelId, bodyHash: digest(text) }, before = unchanged();
  for (const query of [{ ...base, bodyHash: digest('不同正文') }, { ...base, channelId: 'another-channel' }, { ...base, operationId: 'missing' }]) {
    assert.deepEqual(engine.messageReceipt(id, query), { status: 'not_found', runId: id, ...query });
  }
  assert.deepEqual(unchanged(), before);
  const file = path.join(engine.runDir(id), 'events.jsonl'), original = readFileSync(file, 'utf8');
  try {
    const lines = original.trimEnd().split('\n').map(line => JSON.parse(line));
    lines.find(event => event.type === 'message.delivered').data.source = 'reference';
    writeFileSync(file, `${lines.map(event => JSON.stringify(event)).join('\n')}\n`);
    assert.equal(engine.messageReceipt(id, base).status, 'not_found', 'query must read persisted source, not the still-target memory event');
  } finally { writeFileSync(file, original); }
});

test('multiple deliveries for one operation are ambiguous before body/channel matching', async t => {
  const { engine, id, store, unchanged } = await setup(t);
  const operationId = 'duplicate-effect', text = '首次正文';
  const save = store.saveOperation;
  store.saveOperation = () => { throw new Error('synthetic missing operation receipt'); };
  try {
    for (const body of [text, '第二次不同正文']) await assert.rejects(engine.act(id, { type: 'message.send', channelId, text: body }, operationId), /synthetic/);
  } finally { store.saveOperation = save; }
  const before = unchanged(), query = { operationId, channelId, bodyHash: digest(text) };
  assert.deepEqual(engine.messageReceipt(id, query), { status: 'ambiguous', runId: id, ...query });
  assert.deepEqual(unchanged(), before);
});

test('terminal run receipts remain readable without changing files, events or runtime content', async t => {
  const { engine, id, unchanged } = await setup(t);
  const operationId = 'terminal-read', text = '封存前的正文';
  await engine.act(id, { type: 'message.send', channelId, text }, operationId);
  await engine.controlRun(id, 'stop');
  const before = unchanged();
  assert.equal(engine.messageReceipt(id, { operationId, channelId, bodyHash: digest(text) }).status, 'delivered');
  assert.deepEqual(unchanged(), before);
});

test('partial or truncated persisted evidence is refused without repair', async t => {
  const { engine, id, unchanged } = await setup(t);
  const operationId = 'damaged-ledger', text = '完整送达';
  await engine.act(id, { type: 'message.send', channelId, text }, operationId);
  const file = path.join(engine.runDir(id), 'events.jsonl'), original = readFileSync(file, 'utf8');
  try {
    const lines = original.trimEnd().split('\n');
    for (const content of [original.slice(0, -5), `${lines.slice(0, -1).join('\n')}\n`]) {
      writeFileSync(file, content); const before = unchanged();
      assert.throws(() => engine.messageReceipt(id, { operationId, channelId, bodyHash: digest(text) }), /incomplete|inconsistent/);
      assert.deepEqual(unchanged(), before);
    }
  } finally { writeFileSync(file, original); }
});

test('unpersisted in-memory delivery cannot yield a delivered receipt', async t => {
  const { engine, id, store } = await setup(t);
  const operationId = 'append-failed', text = '没有持久送达事件';
  const append = store.appendEvent;
  store.appendEvent = function (runId, event) {
    if (event.type === 'message.delivered') throw new Error('synthetic event append failure');
    return append.call(this, runId, event);
  };
  try { assert.equal((await engine.act(id, { type: 'message.send', channelId, text }, operationId)).ok, false); }
  finally { store.appendEvent = append; }
  assert.ok(engine.eventsSince(id).some(event => event.type === 'message.delivered'));
  assert.throws(() => engine.messageReceipt(id, { operationId, channelId, bodyHash: digest(text) }), /incomplete|inconsistent/);
});

test('message receipt validates the exact query before reading evidence', async t => {
  const { engine, id, unchanged } = await setup(t), before = unchanged();
  const base = { operationId: 'valid', channelId, bodyHash: digest('正文') };
  for (const query of [{ ...base, bodyHash: 'bad' }, { ...base, bodyHash: 'A'.repeat(64) }, { ...base, operationId: '../escape' }, { ...base, channelId: '' }, { ...base, extra: true }]) {
    assert.throws(() => engine.messageReceipt(id, query), /Invalid message receipt query/);
  }
  assert.deepEqual(unchanged(), before);
});
