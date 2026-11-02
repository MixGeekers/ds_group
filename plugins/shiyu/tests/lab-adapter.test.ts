import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { LabAdapterError, LabTargetAdapter } from '../src/adapters/lab/index.js';

const runId = 'run-fixture-a1b2c3d4', token = 'A'.repeat(43);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const now = () => new Date('2026-11-02T16:00:00.000Z');
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const room = {
    runId, status: 'running', self: { actorId: 'SHIYU' }, evaluationMode: 'outcome',
    actors: [{ id: 'SHIYU', name: '识雨' }, { id: 'HUMAN', name: '测试人' }, { id: 'E01', name: '测试同事' }],
    channels: [
      { id: 'D-SHIYU', name: '私聊', kind: 'direct', memberIds: ['SHIYU', 'HUMAN'] },
      { id: 'G01', name: '群聊', kind: 'group', memberIds: ['SHIYU', 'HUMAN', 'E01'] },
      { id: 'SYS', name: '系统', kind: 'system', memberIds: ['SHIYU'] },
    ],
    tasks: [], readableFiles: [], protocol: { actions: {} }, instructions: 'Public fixture only',
  };
  const calls: Array<{ run: string; token: string; request: any; signal?: AbortSignal }> = [];
  const delivered: Array<{ operationId: string; channelId: string; text: string }> = [];
  const receipts = new Map<string, { body: string; result: unknown }>();
  let inputs: any[] = [], override: ((request: any, signal?: AbortSignal) => unknown | Promise<unknown>) | undefined;
  const service = {
    closed: false,
    get engine(): never { throw new Error('PRIVATE_ENGINE_READ'); },
    get state(): never { throw new Error('PRIVATE_STATE_READ'); },
    collaboration: {
      get management(): never { throw new Error('PRIVATE_MANAGEMENT_READ'); },
      async externalCall(run: string, supplied: string, request: any, signal?: AbortSignal): Promise<unknown> {
        assert.equal(run, runId); assert.equal(supplied, token); calls.push({ run, token: supplied, request: structuredClone(request), signal });
        if (override) return override(request, signal);
        if (request.action === 'connect') return { connection: { runId, kind: 'http', status: 'connected' }, view: structuredClone(room) };
        if (request.action === 'inspect') return structuredClone(room);
        if (request.action === 'disconnect') return { disconnected: true };
        if (request.action === 'inputs') {
          const all = inputs.filter(input => input.seq > request.after), selected = all.slice(0, 30);
          return { status: room.status, inputs: structuredClone(selected), nextAfter: selected.at(-1)?.seq ?? request.after, hasMore: all.length > selected.length };
        }
        if (request.action === 'message.receipt') {
          const matches = delivered.map((item, index) => ({ ...item, eventId: `${runId}:e${101 + index}` })).filter(item => item.operationId === request.operationId);
          const base = { runId, operationId: request.operationId, channelId: request.channelId, bodyHash: request.bodyHash };
          if (matches.length > 1) return { status: 'ambiguous', ...base };
          if (matches.length !== 1 || matches[0].channelId !== request.channelId || sha(matches[0].text) !== request.bodyHash) return { status: 'not_found', ...base };
          return { status: 'delivered', ...base, eventId: matches[0].eventId, observedAt: now().toISOString() };
        }
        assert.equal(request.action, 'act'); assert.equal(request.operation.type, 'message.send');
        const body = JSON.stringify(request.operation), old = receipts.get(request.operationId);
        if (old) return old.body === body ? old.result : { ok: false, error: 'operation mismatch' };
        delivered.push({ operationId: request.operationId, channelId: request.operation.channelId, text: request.operation.text });
        const result = { ok: true, data: { delivered: true, channelId: request.operation.channelId, eventId: `${runId}:e${100 + delivered.length}`, attachments: [] } };
        receipts.set(request.operationId, { body, result }); return result;
      },
    },
  };
  let current: unknown = service;
  const adapter = new LabTargetAdapter({ getService: () => current, now });
  const input = (seq: number, channelId = 'G01', text = `合成输入 ${seq}`) => ({ seq, event: { id: `${runId}:e${seq}`, seq, runId, at: now().toISOString(), elapsedMs: seq, businessMs: seq, type: 'input.message', role: 'world', actorId: 'HUMAN', channelId, text }, evaluationMode: 'outcome' });
  return { room, service, calls, delivered, adapter, input, connect: () => adapter.connect({ runId, token }),
    setInputs: (value: any[]) => { inputs = value; }, setCurrent: (value: unknown) => { current = value; },
    setOverride: (value: typeof override) => { override = value; } };
}
const code = (expected: string) => (error: unknown) => error instanceof LabAdapterError && error.code === expected && error.message === expected;

test('public-only connect/inspect/send/disconnect normalize N channels and pin service identity', async () => {
  const f = fixture(), room = await f.connect();
  assert.equal(room.selfActorId, 'SHIYU'); assert.equal(room.channels.length, 3);
  assert.equal(room.channels[0].membersDigest, sha(JSON.stringify(['HUMAN', 'SHIYU'])));
  assert.equal(room.membershipHash, (await f.adapter.inspect()).membershipHash);
  // Neither returned objects nor hidden host getters grant access to mutable internals.
  room.channels[0].memberIds.push('E01');
  const result = await f.adapter.send({ operationId: 'send-1', channelId: 'D-SHIYU', text: '合成回复' });
  assert.deepEqual(result, { status: 'delivered', ok: true, delivered: true, runId, operationId: 'send-1', channelId: 'D-SHIYU', eventId: `${runId}:e101`, bodyHash: sha('合成回复'), observedAt: now().toISOString() });
  assert.deepEqual(f.delivered, [{ operationId: 'send-1', channelId: 'D-SHIYU', text: '合成回复' }]);
  assert.deepEqual(await f.adapter.disconnect(), { disconnected: true });
  await assert.rejects(f.adapter.inspect(), code('LAB_NOT_CONNECTED'));
  assert.equal(JSON.stringify(f.adapter), '{}'); assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(f.calls.map(call => call.request.action), ['connect', 'inspect', 'inspect', 'act', 'disconnect']);
  assert.deepEqual(f.calls.find(call => call.request.action === 'act')!.request, { action: 'act', operationId: 'send-1', operation: { type: 'message.send', channelId: 'D-SHIYU', text: '合成回复' } });
});

test('dynamic ctx.get uses exact shiyuGym name; no service fails safely', async () => {
  const f = fixture(), names: string[] = [];
  const adapter = new LabTargetAdapter({ ctx: { get(name) { names.push(name); return f.service; } } });
  await adapter.connect({ runId, token }); await adapter.inspect();
  assert.ok(names.every(name => name === 'shiyuGym')); adapter.close();
  await assert.rejects(new LabTargetAdapter({ getService: () => undefined }).connect({ runId, token }), code('LAB_SERVICE_UNAVAILABLE'));
});

test('inputs enforce native 30 maximum and smaller caller pagination without dropping events', async () => {
  const f = fixture(); await f.connect(); f.setInputs(Array.from({ length: 34 }, (_, i) => f.input(i + 1)));
  const page = await f.adapter.inputs({ after: 0, limit: 2, waitMs: 20_000 });
  assert.deepEqual(page.inputs.map(input => input.seq), [1, 2]); assert.equal(page.nextAfter, 2); assert.equal(page.hasMore, true);
  const next = await f.adapter.inputs({ after: page.nextAfter }); assert.deepEqual(next.inputs.map(input => input.seq), Array.from({ length: 30 }, (_, i) => i + 3));
  const last = await f.adapter.inputs({ after: next.nextAfter }); assert.deepEqual(last.inputs.map(input => input.seq), [33, 34]); assert.equal(last.hasMore, false);
  const empty = await f.adapter.inputs({ after: 34 }); assert.equal(empty.nextAfter, 34); assert.equal(empty.inputs.length, 0);
  const count = f.calls.length;
  await assert.rejects(f.adapter.inputs({ after: 0, limit: 31 }), code('LAB_PROTOCOL_INVALID'));
  await assert.rejects(f.adapter.inputs({ after: 0, waitMs: 20_001 }), code('LAB_PROTOCOL_INVALID'));
  await assert.rejects(f.adapter.inputs({ after: -1 }), code('LAB_PROTOCOL_INVALID')); assert.equal(f.calls.length, count);
});

test('strict directory validation rejects bad self, duplicate channels/members, foreign actors and kind', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.room.self.actorId = 'OTHER'; },
    (f: ReturnType<typeof fixture>) => { f.room.channels.push(f.room.channels[0]); },
    (f: ReturnType<typeof fixture>) => { f.room.channels[0].memberIds.push('HUMAN'); },
    (f: ReturnType<typeof fixture>) => { f.room.channels[0].memberIds.push('OUTSIDE'); },
    (f: ReturnType<typeof fixture>) => { f.room.channels[0].kind = 'private'; },
    (f: ReturnType<typeof fixture>) => { f.room.actors[0].id = '../SHIYU'; },
    (f: ReturnType<typeof fixture>) => { f.room.runId = 'wrong-run'; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(f.connect(), code('LAB_PROTOCOL_INVALID')); assert.equal(f.delivered.length, 0); }
});

test('input page rejects forged run/event/seq/actor/channel/text/cursor before controller admission', async () => {
  for (const mutate of [
    (row: any) => { row.event.runId = 'other-run'; }, (row: any) => { row.event.id = `${runId}:e999`; },
    (row: any) => { row.event.seq = 2; }, (row: any) => { row.event.actorId = 'OUTSIDE'; },
    (row: any) => { row.event.channelId = 'MISSING'; }, (row: any) => { row.event.text = 'x'.repeat(16_385); },
    (row: any) => { row.event.type = 'message.delivered'; }, (row: any) => { row.event.text = '\uD800'; },
  ]) { const f = fixture(); await f.connect(); const row = f.input(1); mutate(row); f.setInputs([row]); await assert.rejects(f.adapter.inputs({ after: 0 }), code('LAB_PROTOCOL_INVALID')); }
  const f = fixture(); await f.connect(); f.setInputs([f.input(1), f.input(1)]); await assert.rejects(f.adapter.inputs({ after: 0 }), code('LAB_PROTOCOL_INVALID'));
});

test('membership changes reject send and long-poll completion before any act/admission', async () => {
  const f = fixture(); await f.connect(); f.room.channels[1].memberIds = ['HUMAN', 'SHIYU'];
  await assert.rejects(f.adapter.send({ operationId: 'send-1', channelId: 'G01', text: 'hello' }), code('LAB_MEMBERSHIP_CHANGED'));
  assert.equal(f.calls.some(call => call.request.action === 'act'), false);
  const g = fixture(); await g.connect(); const waiting = deferred<unknown>();
  g.setOverride(request => request.action === 'inspect' ? structuredClone(g.room) : waiting.promise);
  const poll = g.adapter.inputs({ after: 0, waitMs: 20_000 });
  await new Promise(resolve => setImmediate(resolve)); g.room.channels[1].memberIds = ['HUMAN', 'SHIYU'];
  waiting.resolve({ status: 'running', inputs: [g.input(1)], nextAfter: 1, hasMore: false });
  await assert.rejects(poll, code('LAB_MEMBERSHIP_CHANGED'));
});

test('service replacement, closed service and replaced public method reject dispatch', async () => {
  for (const mode of ['replace', 'close', 'method'] as const) {
    const f = fixture(); await f.connect(); const before = f.calls.length;
    if (mode === 'replace') f.setCurrent(fixture().service);
    if (mode === 'close') f.service.closed = true;
    if (mode === 'method') f.service.collaboration.externalCall = async () => { throw new Error('should not run'); };
    await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello' }), code(mode === 'close' ? 'LAB_SERVICE_CLOSED' : 'LAB_SERVICE_REPLACED'));
    assert.equal(f.calls.length, before);
  }
});

test('cancellation/close refuses late input and cancellation before send causes no act', async () => {
  const f = fixture(); await f.connect(); const controller = new AbortController(); controller.abort(new Error(token));
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello', signal: controller.signal }), code('LAB_CANCELLED'));
  const waiting = deferred<unknown>(); f.setOverride(request => request.action === 'inspect' ? structuredClone(f.room) : waiting.promise);
  const poll = f.adapter.inputs({ after: 0 }); await new Promise(resolve => setImmediate(resolve)); f.adapter.close();
  waiting.resolve({ status: 'running', inputs: [f.input(1)], nextAfter: 1, hasMore: false });
  await assert.rejects(poll, code('LAB_CONNECTION_CLOSED')); assert.equal(f.delivered.length, 0);
  await assert.rejects(f.connect(), code('LAB_CONNECT_CONFLICT'));
});

test('disconnect invalidates late input even when public host ignores its cancellation', async () => {
  const f = fixture(); await f.connect(); const waiting = deferred<unknown>();
  f.setOverride(request => request.action === 'inspect' ? structuredClone(f.room) : request.action === 'disconnect' ? { disconnected: true } : waiting.promise);
  const poll = f.adapter.inputs({ after: 0 }); await new Promise(resolve => setImmediate(resolve));
  await f.adapter.disconnect(); waiting.resolve({ status: 'running', inputs: [f.input(1)], nextAfter: 1, hasMore: false });
  await assert.rejects(poll, code('LAB_CONNECTION_CLOSED'));
});

test('lost/malformed/false send response remains unknown with one dispatch and no error secret', async () => {
  for (const response of ['throw', 'malformed', 'false'] as const) {
    const f = fixture(); await f.connect();
    f.setOverride(request => {
      if (request.action === 'inspect') return structuredClone(f.room);
      assert.equal(request.action, 'act'); f.delivered.push({ operationId: request.operationId, channelId: request.operation.channelId, text: request.operation.text });
      if (response === 'throw') throw new Error(`transport:${token}`);
      if (response === 'malformed') return { ok: true, data: { delivered: true, channelId: 'WRONG', eventId: `${runId}:e100`, attachments: [] } };
      return { ok: false, error: token, unknown: true };
    });
    const result = await f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello' });
    assert.equal(result.status, 'unknown'); assert.equal(f.delivered.length, 1); assert.equal(f.calls.filter(call => call.request.action === 'act').length, 1);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test('delivered fact arriving after cancellation and close is retained for effect accounting', async () => {
  const f = fixture(); await f.connect(); const waiting = deferred<unknown>(), controller = new AbortController();
  f.setOverride(request => request.action === 'inspect' ? structuredClone(f.room) : waiting.promise);
  const send = f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(new Error(token)); f.adapter.close();
  waiting.resolve({ ok: true, data: { delivered: true, channelId: 'G01', eventId: `${runId}:e100`, attachments: [] } });
  const result = await send; assert.equal(result.status, 'delivered'); assert.equal(JSON.stringify(result).includes(token), false);
});

test('send never reissues a dispatched operation; explicit observation uses only message.receipt', async () => {
  const f = fixture(); await f.connect();
  const first = await f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello' });
  assert.equal(first.status, 'delivered');
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello' }), code('LAB_SEND_ALREADY_DISPATCHED'));
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'changed' }), code('LAB_SEND_ALREADY_DISPATCHED'));
  const before = f.calls.length;
  const observed = await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') });
  assert.deepEqual(observed, { status: 'delivered', runId, operationId: 'op', channelId: 'G01', bodyHash: sha('hello'), eventId: `${runId}:e101`, observedAt: now().toISOString() });
  assert.deepEqual(f.calls.slice(before).map(call => call.request.action), ['message.receipt']);
  assert.equal(f.delivered.length, 1);
});

test('receipt observation preserves not_found/ambiguous and never sends or needs a live draft', async () => {
  const f = fixture(); await f.connect(); f.room.status = 'completed';
  assert.equal((await f.adapter.observeSend({ operationId: 'absent', channelId: 'G01', bodyHash: sha('hello') })).status, 'not_found');
  f.delivered.push({ operationId: 'op', channelId: 'G01', text: 'hello' });
  assert.equal((await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('wrong') })).status, 'not_found');
  assert.equal((await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') })).status, 'delivered');
  f.delivered.push({ operationId: 'op', channelId: 'D-SHIYU', text: 'different' });
  assert.equal((await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') })).status, 'ambiguous');
  assert.equal(f.calls.some(call => call.request.action === 'act'), false);
});

test('effect-before-operation-receipt window is observed without reissuing act', async () => {
  const f = fixture(); await f.connect();
  f.setOverride(request => {
    if (request.action === 'inspect') return structuredClone(f.room);
    assert.equal(request.action, 'act');
    f.delivered.push({ operationId: request.operationId, channelId: request.operation.channelId, text: request.operation.text });
    throw new Error(`lost before operation store: ${token}`);
  });
  const result = await f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello' }); assert.equal(result.status, 'unknown');
  f.setOverride(undefined);
  assert.equal((await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') })).status, 'delivered');
  assert.equal(f.calls.filter(call => call.request.action === 'act').length, 1); assert.equal(f.delivered.length, 1);
});

test('receipt rejects wrong identity/hash/event metadata and sanitizes errors as unknown', async () => {
  const f = fixture(); await f.connect();
  for (const change of [{ runId: 'other-run' }, { operationId: 'other-op' }, { channelId: 'D-SHIYU' }, { bodyHash: sha('other') }, { eventId: 'other-run:e1' }, { observedAt: 'invalid' }]) {
    f.setOverride(() => ({ status: 'delivered', runId, operationId: 'op', channelId: 'G01', bodyHash: sha('hello'), eventId: `${runId}:e100`, observedAt: now().toISOString(), ...change }));
    assert.equal((await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') })).status, 'unknown');
  }
  f.setOverride(() => { throw new Error(token); });
  const result = await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') });
  assert.equal(result.status, 'unknown'); assert.equal(JSON.stringify(result).includes(token), false);
});

test('trusted authorization callback runs after inspect and before dispatch, then signal/service rechecked', async () => {
  const f = fixture(); await f.connect(); let callsAtGate = 0;
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello', beforeDispatch() { callsAtGate = f.calls.length; throw new Error(token); } }), code('LAB_SEND_NOT_DISPATCHED'));
  assert.equal(f.calls[callsAtGate - 1].request.action, 'inspect'); assert.equal(f.delivered.length, 0);
  const controller = new AbortController();
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello', signal: controller.signal, beforeDispatch() { controller.abort(); } }), code('LAB_CANCELLED'));
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello', beforeDispatch() { f.setCurrent(fixture().service); } }), code('LAB_SERVICE_REPLACED'));
  assert.equal(f.calls.some(call => call.request.action === 'act'), false);
});

test('secrets reflected in normalized fields or exceptions never leave the adapter', async () => {
  const f = fixture(); f.room.actors[0].name = token;
  await assert.rejects(f.connect(), code('LAB_PROTOCOL_SECRET_REFLECTION'));
  const g = fixture(); await g.connect(); g.setOverride(() => { throw new Error(`invalid token ${token}`); });
  await assert.rejects(g.adapter.inspect(), code('LAB_READ_UNCONFIRMED'));
});

test('send rejects unapproved recipient/system channel/noncanonical body before act', async () => {
  const f = fixture(); await f.connect();
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'D-SHIYU', toActorId: 'E01', text: 'hello' }), code('LAB_RECIPIENT_REJECTED'));
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'SYS', text: 'hello' }), code('LAB_RECIPIENT_REJECTED'));
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: ' hello ' }), code('LAB_SEND_INVALID'));
  assert.equal(f.calls.some(call => call.request.action === 'act'), false);
});

test('explicit read-only attach inspects sealed room and hard-denies input polling or sending', async () => {
  const f = fixture(); f.room.status = 'completed';
  const room = await f.adapter.connect({ runId, token, readOnly: true }); assert.equal(room.status, 'completed');
  assert.deepEqual(f.calls.map(call => call.request.action), ['inspect']);
  const before = f.calls.length; let gated = false;
  await assert.rejects(f.adapter.inputs({ after: 0 }), code('LAB_READ_ONLY'));
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello', beforeDispatch() { gated = true; } }), code('LAB_READ_ONLY'));
  assert.equal(gated, false); assert.equal(f.calls.length, before);
  assert.equal((await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') })).status, 'not_found');
  room.status = 'running'; f.room.status = 'running'; await f.adapter.inspect();
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello' }), code('LAB_READ_ONLY'));
  await assert.rejects(f.adapter.connect({ runId, token }), code('LAB_CONNECT_CONFLICT'));
  assert.deepEqual(await f.adapter.disconnect(), { disconnected: true });
  assert.equal(f.calls.some(call => call.request.action === 'connect' || call.request.action === 'act' || call.request.action === 'inputs'), false);
});

test('read-only attach cannot bypass Lab refusal of disconnected sealed identity', async () => {
  const f = fixture(); f.room.status = 'completed';
  f.setOverride(request => { assert.equal(request.action, 'inspect'); throw new Error(`sealed identity disconnected: ${token}`); });
  await assert.rejects(f.adapter.connect({ runId, token, readOnly: true }), code('LAB_READ_UNCONFIRMED'));
  await assert.rejects(f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') }), code('LAB_NOT_CONNECTED'));
  assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(f.adapter).includes(token), false);
});

test('existing writable binding refuses new send after native room becomes terminal', async () => {
  const f = fixture(); await f.connect(); f.room.status = 'stopped';
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello' }), code('LAB_ROOM_ENDED'));
  assert.equal(f.calls.some(call => call.request.action === 'act'), false);
  assert.equal((await f.adapter.observeSend({ operationId: 'op', channelId: 'G01', bodyHash: sha('hello') })).status, 'not_found');
});

test('final synchronous stop gate closes the post-authority microtask window and rejects thenables', async () => {
  const f = fixture(); await f.connect(); let stopped = false, checked = false;
  await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello',
    beforeDispatch: async () => { queueMicrotask(() => { stopped = true; }); },
    assertDispatch: () => { checked = true; if (stopped) throw new Error(token); },
  }), code('LAB_SEND_NOT_DISPATCHED'));
  assert.equal(checked, true); assert.equal(f.calls.some(call => call.request.action === 'act'), false);
  for (const verdict of [Promise.resolve(), Promise.reject(new Error('synthetic rejection')), { then(resolve: (value: unknown) => void) { resolve(undefined); } }]) {
    await assert.rejects(f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello', assertDispatch: () => verdict }), code('LAB_SEND_SYNC_GATE_INVALID'));
  }
  assert.equal(f.calls.some(call => call.request.action === 'act'), false);
  const order: string[] = [];
  const result = await f.adapter.send({ operationId: 'op', channelId: 'G01', text: 'hello',
    beforeDispatch: async () => { order.push('async'); },
    assertDispatch: () => { order.push('sync'); queueMicrotask(() => { order.push(f.calls.at(-1)?.request.action === 'act' ? 'after-act' : 'before-act'); }); },
  });
  assert.equal(result.status, 'delivered'); assert.deepEqual(order, ['async', 'sync', 'after-act']);
  assert.equal(f.calls.filter(call => call.request.action === 'act').length, 1);
});
