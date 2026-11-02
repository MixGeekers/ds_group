import assert from 'node:assert/strict';
import test from 'node:test';
import { appendNativeContextMessage, assertNativeMaintenance, coldNativeInbox, verifyNativeEvent } from '../src/adapters/dsh/native-context.js';
import type { DshAgent, DshContext, DshSession, SessionEvent } from '../src/adapters/dsh/sessions.js';
import type { NativeUserMessage } from '../src/adapters/dsh/native-message.js';

const message: NativeUserMessage = { id: 'official-test-id', role: 'user', content: [{ type: 'text', text: 'Authorized synthetic view' }], source: { kind: 'user' } };
function reader(events: SessionEvent[], truncated = false) {
  let closes = 0, projections = 0;
  const ctx = { get(name: string) {
    if (name === 'sessions') return { flush: async () => true };
    if (name === 'sessionPersistence') return { async open(_id: string, mode: string) {
      assert.equal(mode, 'read'); return { header: { agentPreset: 'managed' }, inheritedEventCount: 0,
        async read(offset: number, length: number) { return { eventState: 'detached', events: truncated && offset === 0 ? events.slice(0, 1) : events.slice(offset, offset + length) }; }, async close() { closes++; } };
    } };
    if (name === 'sessionProjections') return { restore() { projections++; return { snapshot: { values: { inbox: { 'next-turn': [], 'next-step': [] } } } }; } };
  } } as unknown as DshContext;
  return { ctx, counts: () => ({ closes, projections }) };
}

test('cold native projection refuses a contiguous but incomplete event tail', async () => {
  const fake = reader([{ seq: 0, type: 'permission/preset', data: {} }, { seq: 1, type: 'agent/inbox/spliced', data: {} }], true);
  await assert.rejects(coldNativeInbox(fake.ctx, 'id', 'managed'), /incomplete event tail/);
  assert.deepEqual(fake.counts(), { closes: 1, projections: 0 });
});

test('cold native projection requires a complete bounded sequence and accepts public detached aliasing state', async () => {
  for (const events of [[{ seq: 1, type: 'other', data: {} }], Array.from({ length: 2049 }, (_, seq) => ({ seq, type: 'other', data: {} }))]) {
    const fake = reader(events);
    await assert.rejects(coldNativeInbox(fake.ctx, 'id', 'managed'), /incomplete event sequence|safe read bound/);
    assert.deepEqual(fake.counts(), { closes: 1, projections: 0 });
  }
  const complete = reader([]); assert.deepEqual(await coldNativeInbox(complete.ctx, 'id', 'managed'), []);
  assert.deepEqual(complete.counts(), { closes: 1, projections: 1 });
});

test('load-only append uses complete official message and takes exact returned surface sequence', () => {
  let calls = 0;
  const session: DshSession = { id: 'id', header: {}, append(type, value, options) {
    calls++; assert.equal(type, 'user/message'); assert.deepEqual(value, message); assert.deepEqual(options, { surfaceOp: 'append' });
    return { type, data: structuredClone(value), seq: 17, surfaceOp: options.surfaceOp };
  } };
  const event = appendNativeContextMessage(session, message); assert.equal(event.seq, 17); assert.equal(calls, 1);
  event.data.content[0].text = 'local copy'; assert.equal(message.content[0].text, 'Authorized synthetic view');
});

test('load-only append rejects a different returned message, missing sequence or absent surface marker', () => {
  const event: SessionEvent = { seq: 1, type: 'user/message', data: message, surfaceOp: 'append' };
  for (const value of [{ ...event, seq: undefined }, { ...event, surfaceOp: undefined }, { ...event, data: { ...message, id: 'other' } }]) {
    const session: DshSession = { id: 'id', header: {}, append: () => value };
    assert.throws(() => appendNativeContextMessage(session, message), /exact complete context event/);
  }
});

test('cold exact event readback verifies the append surface intent as well as message identity', async () => {
  const expected: SessionEvent = { seq: 0, type: 'user/message', data: message, surfaceOp: 'append' };
  const fake = reader([{ ...expected, surfaceOp: 'replace' }]);
  await assert.rejects(verifyNativeEvent(fake.ctx, 'id', expected), /readback/);
  assert.equal(fake.counts().closes, 1);
});

test('maintenance capability checks fail closed for missing public methods and non-idle Agent', () => {
  for (const partial of [{ status: 'idle', session: {} }, { status: 'running', runMaintenance() {}, session: { append() {} } }]) {
    assert.throws(() => assertNativeMaintenance(partial as unknown as DshAgent), /required|idle Agent/);
  }
});
