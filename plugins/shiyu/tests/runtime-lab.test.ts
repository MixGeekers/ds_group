import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { RuntimeService, type SessionDriver } from '../src/runtime.js';
import { serveCommand, serveState } from '../src/index.js';
import type { DshContext } from '../src/adapters/dsh/sessions.js';
import { LabTargetAdapter } from '../src/adapters/lab/index.js';
import { LabService } from '../src/control/lab.js';
import { deferred, IntegrationSessions, LabProtocolOracle } from './fixtures/lab-integration.js';

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < deadline, 'Synthetic Runtime work did not settle'); await delay(5); }
}

async function fixture(t: TestContext, channelCount = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-runtime-lab-'));
  const remote = new LabProtocolOracle(channelCount), native = new IntegrationSessions(), remoteService = remote.service();
  const gates: ReturnType<typeof deferred>[] = [];
  let lab!: LabService, probes = 0;
  const sessions: SessionDriver = {
    async initialize() {},
    async prepareContextSafety() { return { ready: true, messageFactory: 'injected', nativeReadback: true, coldProjection: true }; },
    async probe() { probes++; throw new Error('Unexpected native probe'); },
    async generateReply(request) {
      assert.ok(request.context && request.deadlineMs);
      return native.generateReply(request as Parameters<IntegrationSessions['generateReply']>[0]);
    },
    async getStatus() { return []; }, async cancel() {}, async close() {},
    readReplyDraft: request => native.readReplyDraft(request),
  };
  const runtime = new RuntimeService({} as DshContext, { dataDir: directory }, {
    sessionFactory: () => sessions,
    workerFactory: () => ({ async initialize() {}, async close() {}, async run() { throw new Error('Unexpected worker'); } }),
    goalFactory: () => ({ async initialize() {}, async close() {}, async run() { throw new Error('Unexpected Goal'); } }),
    labAdapterFactory: () => new LabTargetAdapter({ getService: () => remoteService }),
    labFactory: options => (lab = new LabService({ ...options, pollIntervalMs: 30000 })),
  });
  await runtime.init();
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    try { await runtime.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const connectInput = { action: 'lab.connect', requestId: 'runtime-lab-connect', runId: remote.runId,
    targetToken: remote.targetToken, channelIds: remote.channels.map(channel => channel.id),
    budget: { tokens: 262144, calls: 16, effects: 16 }, expiresAt: new Date(Date.now() + 600000).toISOString() };
  return { runtime, lab, remote, native, probes: () => probes, connectInput,
    gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test('Runtime Lab GET is metadata-only and public local reply routes cannot bypass Lab authority', async t => {
  const f = await fixture(t);
  assert.equal(f.remote.requests.length, 0);
  await f.runtime.command(f.connectInput); await f.lab.pollOnce();
  const before = await f.runtime.store.request('control.watermark', {}), requests = f.remote.requests.length;
  for (let index = 0; index < 50; index++) {
    const response = await serveState(f.runtime); assert.equal(response.status, 200);
    const body = await response.text();
    for (const forbidden of [f.remote.targetToken, 'claimToken', 'authorization', 'permit']) assert.ok(!body.includes(forbidden));
  }
  assert.deepEqual(await f.runtime.store.request('control.watermark', {}), before);
  assert.equal(f.remote.requests.length, requests); assert.equal(f.native.requests.length, 0); assert.equal(f.probes(), 0);
  const conversationId = (await f.runtime.snapshot()).conversations[0]!.conversationId;
  for (const action of ['conversation.replyLocal', 'conversation.loadContext', 'conversation.verifyContext']) {
    const command = action === 'conversation.verifyContext' ? { action, conversationId } : { action, conversationId, inputId: 'bypass', text: 'Synthetic owner text' };
    await assert.rejects(f.runtime.command(command), /Lab replies|load-only capability/);
  }
  assert.equal(f.native.requests.length, 0);
});

test('Lab work shares two Runtime slots and global pause persists its fence before cancelling Lab work', async t => {
  const f = await fixture(t, 3), nativeGate = f.gate(), dbGate = f.gate(), dbEntered = f.gate();
  let blocked = 0;
  f.native.beforeStep = async () => { blocked++; await nativeGate.promise; };
  for (let index = 0; index < 3; index++) f.remote.input(`channel-${index}`, `INPUT_CHANNEL_${index}_PAUSE_BODY`);
  await f.runtime.command(f.connectInput);
  await eventually(() => blocked === 2);
  assert.equal(f.runtime.operations.size, 2);
  await assert.rejects(f.runtime.command({ action: 'session.probe' }), /capacity/);
  assert.equal(f.probes(), 0);
  const request = f.runtime.store.request.bind(f.runtime.store);
  f.runtime.store.request = (async (command: any, args: any) => {
    if (command === 'task.setPaused' && args.paused) { dbEntered.resolve(); await dbGate.promise; }
    return request(command, args);
  }) as typeof request;
  const pausing = f.runtime.command({ action: 'runtime.pause' });
  await dbEntered.promise;
  assert.ok(f.native.requests.every(value => !value.signal!.aborted));
  await assert.rejects(f.runtime.command({ action: 'session.probe' }), /paused/);
  dbGate.resolve(); await pausing;
  assert.ok(f.native.requests.every(value => value.signal!.aborted));
  assert.equal((await f.runtime.store.request('lab.snapshot', {}))[0]!.status, 'paused');
  nativeGate.resolve(); await f.lab.drain();
  assert.equal(f.native.modelCalls.length, 0); assert.equal(f.remote.delivered.length, 0);
  assert.equal(f.runtime.operations.size, 0);
  await f.runtime.command({ action: 'runtime.resume' }); await f.lab.pollOnce();
  assert.equal((await f.runtime.snapshot()).lab.connections[0]!.status, 'paused');
  assert.equal(f.native.requests.length, 2);
});

test('Lab public command allowlist rejects trusted fields and transport errors do not echo credentials', async t => {
  const f = await fixture(t);
  for (const field of ['adapterFactory', 'permit', 'actor', 'scope']) {
    await assert.rejects(f.runtime.command({ ...f.connectInput, [field]: 'untrusted' }), /LAB_INVALID_INPUT/);
  }
  for (const action of ['lab.ingest', 'lab.claimReply', 'lab.resume', 'lab.recordSendReceipt']) {
    await assert.rejects(f.runtime.command({ action }), /Unknown|Unsupported/);
  }
  assert.equal(f.remote.requests.length, 0);
  f.remote.authorized = false;
  const response = await serveCommand(f.runtime, new Request('http://fixture/api/shiyu/commands', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.connectInput),
  }));
  assert.equal(response.status, 400);
  const body = await response.text(); assert.ok(!body.includes(f.remote.targetToken)); assert.match(body, /LAB_/);
  assert.equal(f.native.requests.length, 0);
});

test('Read-only receipt reconciliation remains reachable through Runtime global pause', async t => {
  const f = await fixture(t);
  f.remote.dropNextSend = 'afterEffect';
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_RECEIPT_BODY');
  await f.runtime.command(f.connectInput);
  await eventually(async () => (await f.runtime.snapshot()).lab.connections[0]?.sends[0]?.status === 'unknown');
  await f.runtime.command({ action: 'runtime.pause' });
  const connection = (await f.runtime.snapshot()).lab.connections[0]!;
  const modelCount = f.native.modelCalls.length;
  const attached: any = await f.runtime.command(f.connectInput);
  assert.equal(attached.duplicate, true);
  assert.equal(attached.connection.status, 'paused');
  assert.equal(attached.connection.live, true);
  assert.equal(f.native.modelCalls.length, modelCount);
  await assert.rejects(f.runtime.command({ ...f.connectInput, requestId: 'new-grant-while-paused' }), /LAB_/);
  const before = f.remote.requests.filter(value => value.action === 'act').length;
  const result: any = await f.runtime.command({ action: 'lab.reconcile', connectionId: connection.connectionId,
    sendId: connection.sends[0]!.sendId, expectedVersion: connection.version });
  assert.equal(result.connection.sends[0].status, 'succeeded');
  assert.equal(result.connection.status, 'paused');
  assert.equal(f.remote.requests.filter(value => value.action === 'act').length, before);
  assert.equal(f.remote.delivered.length, 1); assert.equal(f.native.modelCalls.length, 1);
});
