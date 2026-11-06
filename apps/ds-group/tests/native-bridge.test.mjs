import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NativeBridge } from '../dsh-connect/native-bridge.mjs';
import { NativeBots } from '../dsh-connect/native-bots.mjs';

async function fixture(t, { idle = Promise.resolve(), send } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-bridge-'));
  const handlers = new Map(); let cancelled = 0; let turn = 0;
  const ctx = { on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
  const native = new NativeBots(ctx);
  native.bot = async () => ({ id: 'native-one', name: 'Original', role: 'Research', sessionId: 'native-one', model: 'dsh/model' });
  native.agent = async () => ({ whenIdle: () => idle, cancel: () => cancelled++, ctx: { tools: { schemas: () => ['create_bot','remember','bash'].map(name => ({ name })) } } });
  const calls = [];
  const event = async (type, data, sessionId = 'native-one') => handlers.get('session/event')?.({ id: sessionId }, { type, data });
  native.call = async (_endpoint, payload) => {
    calls.push(JSON.parse(payload.text.split('\n').at(-1))); turn++;
    await event('turn/start', { turn });
    await event('user/message', { content: [{ type: 'text', text: payload.text }], source: { kind: 'user' } });
    if (send) return send({ event, turn, payload });
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: calls.at(-1).currentMessage.body }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
  };
  const node = { id: '@native:home.test', nativeBotId: 'native-one', directory };
  const bridge = await new NativeBridge({ ctx, native, node, timeoutMs: 2000 }).initialize();
  t.after(async () => { await bridge.detach(); await rm(directory, { recursive: true, force: true }); });
  const request = (id, room = '!a:home.test') => ({ requestId: id, botId: node.id,
    event: { roomId: room, eventId: `$${id}`, senderId: '@same:home.test', senderName: 'Same', senderKind: 'human', body: `Reply for ${room}` } });
  return { bridge, native, node, calls, event, handlers, request, cancelled: () => cancelled };
}

test('native inputs keep original tools, distinguish interleaved rooms and persist retries without generation', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.bridge.createBot({ botId: f.node.id })).tools, ['create_bot','remember','bash']);
  const a = f.request('one'); const b = f.request('two', '!b:other.test');
  const [first, second] = await Promise.all([f.bridge.turn(a), f.bridge.turn(b)]);
  assert.equal(first.text, 'Reply for !a:home.test'); assert.equal(second.text, 'Reply for !b:other.test');
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(f.calls[0].context.key, f.calls[1].context.key);
  assert.equal(f.calls[1].replyRoute.eventId, '$two');
  await f.bridge.turn(a); assert.equal(f.calls.length, 2);
  await f.bridge.detach();
  const restarted = await new NativeBridge({ ctx: { on: () => () => {} }, native: f.native, node: f.node }).initialize();
  assert.equal((await restarted.turn(a)).text, first.text);
  await assert.rejects(restarted.turn({ ...a, event: { ...a.event, body: 'changed' } }), { code: 'REQUEST_ID_CONFLICT' });
  await restarted.detach();
});

test('disconnect while original Bot is busy returns promptly and never cancels its native work', async t => {
  const f = await fixture(t, { idle: new Promise(() => {}) });
  const pending = f.bridge.turn(f.request('waiting'));
  while (!f.bridge.waiting) await new Promise(resolve => setTimeout(resolve, 1));
  await f.bridge.detach();
  assert.equal((await pending).status, 'unknown');
  assert.equal(f.cancelled(), 0); assert.equal(f.calls.length, 0);
});

test('native handoff follows its exchange and ignores an unrelated local conversation', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    await event('user/message', { source: { kind: 'bot', role: 'request', senderSessionId: 'native-one', exchangeId: 'work-1' } }, 'native-peer');
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: '[HANDOFF_WAIT]' }] } });
    await event('turn/end', { turn, reason: { kind: 'completed' } });
    await event('turn/start', { turn: 99 });
    await event('user/message', { content: [{ type: 'text', text: 'Local user request' }], source: { kind: 'user' } });
    await event('user/message', { source: { kind: 'bot', role: 'request', senderSessionId: 'native-one', exchangeId: 'unrelated-work' } }, 'native-peer');
    await event('assistant/message', { turn: 99, message: { content: [{ type: 'text', text: 'Local-only answer' }] } });
    await event('turn/end', { turn: 99, reason: { kind: 'completed' } });
    await event('turn/start', { turn: 101 });
    await event('user/message', { source: { kind: 'bot', role: 'reply', replyTo: 'unrelated-work' } });
    await event('assistant/message', { turn: 101, message: { content: [{ type: 'text', text: 'Unrelated delegated answer' }] } });
    await event('turn/end', { turn: 101, reason: { kind: 'completed' } });
    await event('turn/start', { turn: 100 });
    await event('user/message', { source: { kind: 'bot', role: 'reply', replyTo: 'work-1' } });
    await event('assistant/message', { turn: 100, message: { content: [{ type: 'text', text: 'Delegated result' }] } });
    await event('turn/end', { turn: 100, reason: { kind: 'completed' } });
  } });
  const result = await f.bridge.turn(f.request('handoff'));
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Delegated result');
});

test('usage observation cannot fail or restrict a native model stream', async t => {
  const f = await fixture(t);
  f.bridge.run = { seen: true, record: { sessionId: 'native-one', calls: [] } };
  const save = f.bridge.save; f.bridge.save = async () => { throw new Error('synthetic persistence outage'); };
  const chunks = [];
  for await (const chunk of f.bridge.observeUsage({ sessionId: 'native-one', provider: 'native', model: 'model' }, async function* () { yield { type: 'text', text: 'unchanged' }; })) chunks.push(chunk);
  assert.deepEqual(chunks, [{ type: 'text', text: 'unchanged' }]);
  f.bridge.save = save; f.bridge.run = null;
});

test('a native context-part handoff keeps the request and does not publish its acknowledgement', async t => {
  const f = await fixture(t, { send: async ({ event, turn }) => {
    await event('assistant/message', { turn, message: { content: [{ type: 'text', text: 'Still working' }] } });
    await event('turn/end', { turn, reason: { kind: 'blocked' } });
    f.native.bot = async () => ({ id: 'native-one', sessionId: 'native-next', model: 'dsh/model' });
    await event('turn/start', { turn: 2 }, 'native-next');
    await event('user/message', { source: { kind: 'bot', handoff: true, resume: true } }, 'native-next');
    await event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'Noted. I have my handoff note and carry on from here.' }] } }, 'native-next');
    await event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'Final result after native context handoff' }] } }, 'native-next');
    await event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 'native-next');
  } });
  const result = await f.bridge.turn(f.request('part-switch'));
  assert.equal(result.status, 'completed'); assert.equal(result.sessionId, 'native-next');
  assert.equal(result.text, 'Final result after native context handoff');
});
