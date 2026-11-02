import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { LabTargetAdapter } from '../src/adapters/lab/index.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { LabService } from '../src/control/lab.js';
import { deferred, digest, IntegrationSessions, LabProtocolOracle } from './fixtures/lab-integration.js';

async function eventually(check: () => boolean | Promise<boolean>, description: string, timeout = 10000): Promise<void> {
  const until = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= until) assert.fail(`Timed out: ${description}`);
    await delay(5);
  }
}

async function fixture(t: TestContext, options: { channels?: number; expiresAt?: string; accountingComplete?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-lab-integration-')), filename = join(directory, 'control.sqlite');
  const remote = new LabProtocolOracle(options.channels ?? 2), native = new IntegrationSessions();
  native.accountingComplete = options.accountingComplete ?? true;
  let publicService = remote.service(), runtimePaused = false, slots = 0;
  const stores: ControlStore[] = [], services: LabService[] = [];
  const open = async (hostEpoch: string) => {
    const store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'],
      runtimeIdentity: { hostEpoch, installationGeneration: 'synthetic-lab-installation' } });
    stores.push(store); return store;
  };
  const serviceFor = (store: ControlStore) => {
    const service = new LabService({ store, sessions: native, adapterFactory: () => new LabTargetAdapter({ getService: () => publicService }),
      assertRuntimeAllowed() { if (runtimePaused) throw new Error('Synthetic runtime paused'); }, pollIntervalMs: 30000,
      tryAcquireActivity({ signal }) {
        if (slots >= 4) return undefined;
        slots++; let released = false;
        return { signal, release() { if (!released) { released = true; slots--; } } };
      } });
    services.push(service); return service;
  };
  const store = await open('lab-host-one'), service = serviceFor(store);
  t.after(async () => {
    await Promise.allSettled(services.map(value => value.close()));
    await Promise.all(stores.map(value => value.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const connected = await service.connect({ requestId: 'synthetic-lab-connection', runId: remote.runId, targetToken: remote.targetToken,
    channelIds: remote.channels.map(channel => channel.id), budget: { tokens: 1048576, calls: 64, effects: 64 },
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60000).toISOString() });
  const connectionId = connected.connection.connectionId;
  const detail = () => store.request('lab.get', { connectionId });
  const settle = async (expected: (current: Awaited<ReturnType<typeof detail>>) => boolean) => {
    await eventually(async () => {
      await service.pollOnce();
      const current = await detail(), state = await service.snapshot();
      return state.pump.activeReplies === 0 && expected(current);
    }, 'Lab work to reach its externally observable terminal or uncertain state');
  };
  return { remote, native, store, service, filename, connectionId, detail, settle, open, serviceFor,
    replaceService() { publicService = remote.service(); },
    pauseRuntime() { runtimePaused = true; },
  };
}

function allPersistedValues(filename: string): string {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map(row => JSON.stringify(db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all())).join('\n');
  } finally { db.close(); }
}

test('twenty DM/group channels traverse the real Worker, native reply contract and public Lab adapter without cross-talk', async t => {
  const f = await fixture(t, { channels: 20 });
  for (let index = 0; index < 20; index++) f.remote.input(`channel-${index}`, `INPUT_CHANNEL_${index}_PRIVATE_BODY`);
  await f.settle(current => current.sends.length === 20 && current.sends.every(send => send.effect.status === 'succeeded'));
  const current = await f.detail();
  assert.equal(f.remote.delivered.length, 20); assert.equal(f.native.modelCalls.length, 20);
  assert.equal(new Set(current.channels.map(channel => channel.conversationId)).size, 20);
  assert.equal(new Set(f.native.modelCalls.map(call => call.sessionId)).size, 20);
  assert.deepEqual(new Set(current.channels.map(channel => channel.kind)), new Set(['direct', 'group']));
  for (let index = 0; index < 20; index++) {
    const delivered = f.remote.delivered.find(value => value.channelId === `channel-${index}`)!;
    assert.ok(delivered); assert.ok(delivered.text.includes(`INPUT_CHANNEL_${index}_PRIVATE_BODY`));
    for (let other = 0; other < 20; other++) if (other !== index) assert.ok(!delivered.text.includes(`INPUT_CHANNEL_${other}_PRIVATE_BODY`));
    const send = current.sends.find(value => value.channelId === delivered.channelId)!;
    assert.equal(send.observation?.eventId, delivered.eventId); assert.equal(send.bodyHash, digest(delivered.text));
  }
  assert.deepEqual(current.balance.spent, { tokens: 800, calls: 20, effects: 20 });
  assert.deepEqual(current.balance.held, { tokens: 0, calls: 0, effects: 0 });
  f.remote.assertAtMostOnce();
  const persisted = allPersistedValues(f.filename);
  for (const secret of [f.remote.targetToken, 'INPUT_CHANNEL_', 'SYNTHETIC_DRAFT_BODY_']) assert.ok(!persisted.includes(secret), `Control DB leaked ${secret}`);
});

test('input redelivery and repeated polling never regenerate or deliver again; one thousand snapshots stay read-only', async t => {
  const f = await fixture(t);
  const event = f.remote.input('channel-0', 'INPUT_CHANNEL_0_IDEMPOTENT_BODY');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'succeeded');
  const beforeDuplicate = await f.store.request('control.watermark', {});
  await f.store.request('lab.ingest', { connectionId: f.connectionId, events: [{ eventId: event.event.id, channelId: event.event.channelId,
    actorId: event.event.actorId, type: event.event.type, seq: event.seq, bodyHash: digest(event.event.text), bodyBytes: Buffer.byteLength(event.event.text) }] });
  assert.deepEqual(await f.store.request('control.watermark', {}), beforeDuplicate);
  for (let index = 0; index < 5; index++) await f.service.pollOnce();
  assert.equal(f.native.modelCalls.length, 1); assert.equal(f.remote.delivered.length, 1); f.remote.assertAtMostOnce();
  const before = await f.store.request('control.watermark', {}), requests = f.remote.requests.length;
  for (let index = 0; index < 1000; index++) {
    const state = await f.service.snapshot();
    assert.equal(state.connections.length, 1);
  }
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
  assert.equal(f.remote.requests.length, requests); assert.equal(f.native.modelCalls.length, 1);
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_SECOND_TURN');
  await f.settle(current => current.sends.length === 2 && current.sends.every(send => send.effect.status === 'succeeded'));
  assert.equal(f.native.modelCalls.length, 2);
  assert.equal(f.native.modelCalls[1]!.sessionId, f.native.modelCalls[0]!.sessionId, 'A later input reuses the channel native Session');
});

test('different actors in one channel retain per-input provenance and cannot rewrite an accepted event identity', async t => {
  const f = await fixture(t);
  const a = f.remote.input('channel-1', 'INPUT_CHANNEL_1_FROM_OWNER');
  const b = f.remote.input('channel-1', 'INPUT_CHANNEL_1_FROM_COLLEAGUE', undefined, 'actor-1');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'succeeded');
  assert.equal(f.native.modelCalls.length, 1); assert.equal(f.remote.delivered.length, 1);
  const promptLines = f.native.modelCalls[0]!.prompt.split('\n');
  for (const input of [a, b]) {
    const provenance = promptLines.find(line => line.includes(JSON.stringify(input.event.id)));
    assert.ok(provenance, 'Every grouped input has its own provenance record');
    for (const value of [input.event.actorId, input.event.channelId, input.event.type]) assert.ok(provenance.includes(JSON.stringify(value)));
  }
  assert.ok(f.remote.delivered[0]!.text.includes('INPUT_CHANNEL_1_FROM_OWNER'));
  assert.ok(f.remote.delivered[0]!.text.includes('INPUT_CHANNEL_1_FROM_COLLEAGUE'));
  const original = { eventId: a.event.id, channelId: a.event.channelId, actorId: a.event.actorId, type: a.event.type,
    seq: a.seq, bodyHash: digest(a.event.text), bodyBytes: Buffer.byteLength(a.event.text) };
  const before = await f.store.request('control.watermark', {});
  for (const replacement of [{ actorId: 'actor-1' }, { type: 'input.correction' }]) {
    await assert.rejects(f.store.request('lab.ingest', { connectionId: f.connectionId, events: [{ ...original, ...replacement }] }),
      error => error instanceof Error && 'code' in error && error.code === 'IDEMPOTENCY_CONFLICT');
  }
  assert.deepEqual(await f.store.request('control.watermark', {}), before);
  assert.equal(f.native.modelCalls.length, 1); assert.equal(f.remote.delivered.length, 1); f.remote.assertAtMostOnce();
});

test('a newer channel input invalidates an older in-flight draft but does not disturb another channel', async t => {
  const f = await fixture(t), release = deferred(); let oldReached = false;
  t.after(() => release.resolve());
  f.native.afterModel = async request => {
    if (request.prompt.includes('INPUT_CHANNEL_0_OLD_BODY')) { oldReached = true; await release.promise; }
  };
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_OLD_BODY');
  await eventually(async () => { await f.service.pollOnce(); return oldReached; }, 'first draft to reach controlled delay');
  const supersededDraft = f.native.modelCalls[0]!.text;
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_NEW_BODY');
  f.remote.input('channel-1', 'INPUT_CHANNEL_1_UNRELATED_BODY');
  await f.service.pollOnce(); release.resolve();
  await f.settle(current => current.sends.length === 2 && current.sends.every(send => send.effect.status === 'succeeded'));
  assert.equal(f.remote.delivered.length, 2);
  // A fresh grouped reply may include both inputs. It must not deliver the
  // already-generated old draft or treat its old inputVersion as current.
  assert.ok(f.remote.delivered.every(event => event.text !== supersededDraft));
  assert.ok(f.remote.delivered.some(event => event.text.includes('INPUT_CHANNEL_0_NEW_BODY')));
  assert.ok(f.remote.delivered.some(event => event.text.includes('INPUT_CHANNEL_1_UNRELATED_BODY')));
  assert.equal(f.native.modelCalls.length, 3); f.remote.assertAtMostOnce();
});

for (const boundary of ['pause', 'disconnect', 'service-replaced'] as const) {
  test(`${boundary} during model work prevents any public Lab send`, async t => {
    const f = await fixture(t), release = deferred(); let reached = false;
    t.after(() => release.resolve());
    f.native.afterModel = async () => { reached = true; await release.promise; };
    f.remote.input('channel-0', 'INPUT_CHANNEL_0_MUST_NOT_SEND');
    await eventually(async () => { await f.service.pollOnce(); return reached; }, 'draft delay');
    const detail = await f.detail();
    if (boundary === 'pause') await f.service.pause({ connectionId: f.connectionId, expectedVersion: detail.version });
    else if (boundary === 'disconnect') await f.service.disconnect({ connectionId: f.connectionId, expectedVersion: detail.version });
    else { f.replaceService(); await f.service.pollOnce(); }
    release.resolve();
    await eventually(async () => (await f.service.snapshot()).pump.activeReplies === 0, 'cancelled model to drain');
    assert.equal(f.remote.requests.filter(request => request.action === 'act').length, 0);
    assert.equal(f.remote.delivered.length, 0); assert.equal(f.native.modelCalls.length, 1);
    const after = await f.detail(); assert.notEqual(after.status, 'connected');
    assert.ok(after.replies.every(reply => reply.status === 'unknown'));
  });
}

test('missing primary-call accounting preserves the reservation and refuses message delivery', async t => {
  const f = await fixture(t, { accountingComplete: false });
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_UNKNOWN_ACCOUNTING');
  await f.settle(current => current.replies.length === 1 && current.replies[0]!.status === 'unknown');
  const current = await f.detail();
  assert.equal(f.native.modelCalls.length, 1); assert.equal(f.remote.delivered.length, 0); assert.equal(current.sends.length, 0);
  assert.equal(current.replies[0]!.reservation.state, 'unknown'); assert.ok(current.balance.held.calls > 0);
});

for (const loss of ['after', 'afterEffect'] as const) {
  test(`read-only receipt reconciliation resolves ${loss} loss without another act or delivery`, async t => {
    const f = await fixture(t); f.remote.dropNextSend = loss;
    f.remote.input('channel-0', `INPUT_CHANNEL_0_${loss.toUpperCase()}_LOSS`);
    await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
    const uncertain = await f.detail(), send = uncertain.sends[0]!;
    assert.equal(f.remote.delivered.length, 1);
    assert.equal(f.remote.receipts.size, loss === 'afterEffect' ? 0 : 1, 'The fixture distinguishes a persisted effect from an operation receipt');
    const acts = f.remote.requests.filter(request => request.action === 'act').length, calls = f.native.modelCalls.length;
    await f.service.reconcile({ connectionId: f.connectionId, expectedVersion: uncertain.version, sendId: send.opId });
    const reconciled = await f.detail();
    assert.equal(reconciled.sends[0]!.effect.status, 'succeeded');
    assert.equal(reconciled.sends[0]!.observation?.eventId, f.remote.delivered[0]!.eventId);
    assert.equal(f.remote.requests.filter(request => request.action === 'act').length, acts);
    assert.equal(f.remote.requests.filter(request => request.action === 'message.receipt').length, 1);
    assert.equal(f.remote.delivered.length, 1); assert.equal(f.native.modelCalls.length, calls); f.remote.assertAtMostOnce();
    assert.equal(reconciled.balance.held.effects, 0); assert.equal(reconciled.balance.spent.effects, 1);
  });
}

test('a receipt query that finds no delivery leaves unknown held and never executes the missing effect', async t => {
  const f = await fixture(t); f.remote.dropNextSend = 'before';
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_NOT_DELIVERED');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
  const uncertain = await f.detail(), acts = f.remote.requests.filter(request => request.action === 'act').length;
  await f.service.reconcile({ connectionId: f.connectionId, expectedVersion: uncertain.version, sendId: uncertain.sends[0]!.opId });
  const after = await f.detail();
  assert.equal(after.sends[0]!.effect.status, 'unknown'); assert.equal(after.balance.held.effects, 1);
  assert.equal(f.remote.delivered.length, 0); assert.equal(f.remote.requests.filter(request => request.action === 'act').length, acts);
});

test('ambiguous remote delivery evidence never becomes local success or releases the effect hold', async t => {
  const f = await fixture(t); f.remote.dropNextSend = 'afterEffect';
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_AMBIGUOUS_RECEIPT');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
  const original = f.remote.delivered[0]!;
  // Deliberately model a violated remote invariant. The client must report this
  // evidence as ambiguous rather than choosing the first matching event.
  f.remote.delivered.push({ ...original, eventId: `${f.remote.runId}:e${++f.remote.nextSeq}` });
  const before = await f.detail(), acts = f.remote.requests.filter(request => request.action === 'act').length;
  await f.service.reconcile({ connectionId: f.connectionId, expectedVersion: before.version, sendId: before.sends[0]!.opId });
  const after = await f.detail();
  assert.equal(after.sends[0]!.effect.status, 'unknown'); assert.equal(after.balance.held.effects, 1);
  assert.equal(f.remote.delivered.length, 2); assert.equal(f.remote.requests.filter(request => request.action === 'act').length, acts);
});

test('expiry blocks fresh work but still permits a strictly read-only observation of an already delivered effect', async t => {
  const expiresAt = new Date(Date.now() + 3000).toISOString();
  const f = await fixture(t, { expiresAt }); f.remote.dropNextSend = 'afterEffect';
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_EXPIRED_RECEIPT');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
  await delay(Math.max(0, Date.parse(expiresAt) - Date.now() + 10));
  const calls = f.native.modelCalls.length, acts = f.remote.requests.filter(request => request.action === 'act').length;
  f.remote.input('channel-1', 'INPUT_CHANNEL_1_TOO_LATE'); await f.service.pollOnce();
  const before = await f.detail();
  await f.service.reconcile({ connectionId: f.connectionId, expectedVersion: before.version, sendId: before.sends[0]!.opId });
  const after = await f.detail();
  assert.equal(after.sends[0]!.effect.status, 'succeeded'); assert.equal(after.balance.held.effects, 0);
  assert.equal(f.remote.requests.filter(request => request.action === 'act').length, acts);
  assert.equal(f.native.modelCalls.length, calls); assert.equal(f.remote.delivered.length, 1);
});

test('a completed Lab room retains read-only receipt access while refusing all further generation', async t => {
  const f = await fixture(t); f.remote.dropNextSend = 'afterEffect';
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_TERMINAL_RECEIPT');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
  const calls = f.native.modelCalls.length, acts = f.remote.requests.filter(request => request.action === 'act').length;
  f.remote.status = 'completed'; await f.service.pollOnce();
  const before = await f.detail();
  assert.notEqual(before.status, 'connected');
  await f.service.reconcile({ connectionId: f.connectionId, expectedVersion: before.version, sendId: before.sends[0]!.opId });
  const after = await f.detail();
  assert.equal(after.sends[0]!.effect.status, 'succeeded'); assert.equal(after.balance.held.effects, 0);
  assert.equal(f.native.modelCalls.length, calls); assert.equal(f.remote.requests.filter(request => request.action === 'act').length, acts);
  assert.equal(f.remote.delivered.length, 1);
});

test('the last asynchronous Lab preflight cannot bypass a newly persisted runtime pause', async t => {
  const f = await fixture(t); let pausedDuringPreflight = false;
  f.remote.beforeInspect = async () => {
    if (pausedDuringPreflight || !(await f.detail()).sends.some(send => send.effect.status === 'dispatching')) return;
    pausedDuringPreflight = true;
    // The service's transient signal has not been cancelled. The final trusted
    // Worker authorization must observe this committed pause before public act.
    await f.store.request('task.setPaused', { paused: true });
  };
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_LAST_GATE');
  await f.settle(current => pausedDuringPreflight && current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
  assert.equal(f.remote.requests.filter(request => request.action === 'act').length, 0);
  assert.equal(f.remote.delivered.length, 0); assert.equal(f.native.modelCalls.length, 1);
});

test('reopening the real Worker fences the old connection and preserves unknown effects without live replay', async t => {
  const f = await fixture(t); f.remote.dropNextSend = 'afterEffect';
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_RESTART_UNKNOWN');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
  const before = await f.detail(), requests = f.remote.requests.length, calls = f.native.modelCalls.length;
  // End the durable owner first, rather than invoking the graceful disconnect path.
  await f.store.close(); await f.service.close().catch(() => {});
  const store = await f.open('lab-host-two'), service = f.serviceFor(store);
  const after = await store.request('lab.get', { connectionId: f.connectionId });
  assert.equal(after.status, 'needs_reconnect'); assert.ok(after.epoch > before.epoch);
  assert.equal(after.sends[0]!.effect.status, 'unknown'); assert.equal(after.sends[0]!.effect.effectId, before.sends[0]!.effect.effectId);
  assert.equal(after.balance.held.effects, 1);
  await service.pollOnce(); const snapshot = await service.snapshot();
  assert.equal(snapshot.connections[0]!.live, false); assert.equal(snapshot.pump.activeReplies, 0);
  assert.equal(f.remote.requests.length, requests); assert.equal(f.native.modelCalls.length, calls); assert.equal(f.remote.delivered.length, 1);
});

test('explicit same-run reconnect observes the old unknown without replay, then fresh input continues the same native Session', async t => {
  const f = await fixture(t); f.remote.dropNextSend = 'afterEffect';
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_BEFORE_RESTART');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'unknown');
  const before = await f.detail(), oldSession = f.native.modelCalls[0]!.sessionId;
  await f.store.close(); await f.service.close().catch(() => {});
  const store = await f.open('lab-reconnected-host'), service = f.serviceFor(store);
  const connected = await service.connect({ requestId: 'synthetic-reconnected-owner', runId: f.remote.runId, targetToken: f.remote.targetToken,
    channelIds: ['channel-0', 'channel-1'], budget: { tokens: 131072, calls: 8, effects: 4 }, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const nextId = connected.connection.connectionId;
  assert.notEqual(nextId, f.connectionId);
  for (let index = 0; index < 3; index++) { await service.pollOnce(); await service.drain(); }
  assert.equal(f.native.modelCalls.length, 1, 'Old public input must not become a new model request under a new connection');
  assert.equal(f.remote.delivered.length, 1);
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_AFTER_RESTART');
  await service.pollOnce(); await service.drain();
  assert.equal(f.native.modelCalls.length, 1, 'A run/channel uncertainty lock blocks fresh sends until the old effect is observed');
  const old = await store.request('lab.get', { connectionId: f.connectionId });
  const acts = f.remote.requests.filter(request => request.action === 'act').length;
  await service.reconcile({ connectionId: f.connectionId, expectedVersion: old.version, sendId: before.sends[0]!.opId });
  assert.equal(f.remote.requests.filter(request => request.action === 'act').length, acts);
  assert.equal((await store.request('lab.get', { connectionId: f.connectionId })).sends[0]!.effect.status, 'succeeded');
  await eventually(async () => {
    await service.pollOnce(); await service.drain();
    return (await store.request('lab.get', { connectionId: nextId })).sends.some(send => send.effect.status === 'succeeded');
  }, 'fresh input after read-only reconciliation');
  assert.equal(f.native.modelCalls.length, 2); assert.equal(f.native.modelCalls[1]!.sessionId, oldSession);
  assert.equal(f.remote.delivered.length, 2); f.remote.assertAtMostOnce();
  const after = await store.request('lab.get', { connectionId: nextId });
  assert.equal(after.channels[0]!.conversationId, before.channels[0]!.conversationId);
});

test('ordinary pause and explicit reconnect preserve same-audience Session identity and do not replay old inputs', async t => {
  const f = await fixture(t);
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_BEFORE_PAUSE');
  await f.settle(current => current.sends.length === 1 && current.sends[0]!.effect.status === 'succeeded');
  const before = await f.detail(), sessionId = f.native.modelCalls[0]!.sessionId;
  await f.service.pause({ connectionId: f.connectionId, expectedVersion: before.version });
  const paused = await f.detail();
  await f.service.disconnect({ connectionId: f.connectionId, expectedVersion: paused.version });
  f.remote.rotateToken();
  const connected = await f.service.connect({ requestId: 'synthetic-after-pause', runId: f.remote.runId, targetToken: f.remote.targetToken,
    channelIds: ['channel-0', 'channel-1'], budget: { tokens: 131072, calls: 8, effects: 4 }, expiresAt: new Date(Date.now() + 60000).toISOString() });
  for (let index = 0; index < 2; index++) { await f.service.pollOnce(); await f.service.drain(); }
  assert.equal(f.native.modelCalls.length, 1); assert.equal(f.remote.delivered.length, 1);
  f.remote.input('channel-0', 'INPUT_CHANNEL_0_AFTER_PAUSE');
  await eventually(async () => {
    await f.service.pollOnce(); await f.service.drain();
    return (await f.store.request('lab.get', { connectionId: connected.connection.connectionId })).sends.some(send => send.effect.status === 'succeeded');
  }, 'same-audience fresh reply after explicit reconnect');
  assert.equal(f.native.modelCalls.length, 2); assert.equal(f.native.modelCalls[1]!.sessionId, sessionId);
  const after = await f.store.request('lab.get', { connectionId: connected.connection.connectionId });
  assert.equal(after.channels[0]!.conversationId, before.channels[0]!.conversationId);
  assert.equal(f.remote.delivered.length, 2); f.remote.assertAtMostOnce();
});
