import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';
import { heldIngressKey, nativeMemoryInput, prepareClaimedSources } from '../memory/ingress.mjs';

const message = (id, roomId, sender, text = 'same text') => ({ id: `message-${id}`, source: {
  kind: 'user', eventId: id, roomId, sender: { id: sender, name: sender, kind: 'human' }, transport: 'matrix', timestamp: 100 },
content: [{ type: 'text', text }] });
const input = msg => ({ event: { eventId: msg.source.eventId, roomId: msg.source.roomId, senderId: msg.source.sender.id, body: msg.content[0].text, timestamp: 100 },
  context: { source: msg.source } });
async function withMemory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-claimed-')), memory = new MemoryService({ directory });
  try { await run(memory); } finally { await memory.close(); await rm(directory, { recursive: true }); }
}

test('claimed source preparation switches authors and rooms before append without admitting held inbox messages', async () => withMemory(async memory => {
  const first = message('$first', '!first:test', '@alice:test'), second = message('$second', '!second:test', '@bob:test');
  for (const msg of [first, second]) {
    memory.store.setMeta(heldIngressKey('session', msg.source), input(msg));
    memory.observe('a', input(msg), { sourceDispositions: { [msg.source.eventId]: { kind: 'pending-request' } } });
  }
  assert.equal(memory.current('a', 'session'), undefined);
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'session', messages: [first], home: '/synthetic' });
  const firstView = memory.contextSnapshot('a', 'session');
  assert.equal(firstView.authorId, 'matrix:@alice:test'); assert.equal(firstView.roomId, '!first:test');
  assert.ok(firstView.recentSources.some(source => source.eventId === '$first'));
  assert.equal(memory.pendingRequests('a').length, 1);
  assert.equal(memory.pendingRequests('a')[0].eventId, '$second');
  // A runtime snapshot and an empty tool step do not claim the next inbox item.
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'session', messages: [{ ...second, source: { kind: 'runtime-context' } }], home: '/synthetic' });
  assert.equal(memory.current('a').authorId, 'matrix:@alice:test');
  // Formal append of the held original confirms the same source revision.
  memory.ingest('a', input(first), { sessionId: 'session' });
  assert.equal(memory.store.observations('a').length, 2);
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'session', messages: [second], home: '/synthetic' });
  const secondView = memory.contextSnapshot('a', 'session');
  assert.equal(secondView.authorId, 'matrix:@bob:test'); assert.equal(secondView.roomId, '!second:test');
  assert.deepEqual(secondView.sourceRefs, memory.current('a', 'session').sourceRefs);
  assert.equal(memory.pendingRequests('a').length, 0);
}));

test('equal routing text and event IDs in separate rooms or Sessions do not collide', async () => withMemory(async memory => {
  const first = message('$same', '!first:test', '@alice:test'), second = message('$same', '!second:test', '@bob:test');
  const firstInput = input(first), secondInput = input(second);
  firstInput.event.body = 'Original first-room evidence'; secondInput.event.body = 'Original second-room evidence';
  memory.store.setMeta(heldIngressKey('session', first.source), firstInput);
  memory.store.setMeta(heldIngressKey('session', second.source), secondInput);
  assert.notEqual(heldIngressKey('session', first.source), heldIngressKey('other-session', first.source));
  for (const [msg, expected] of [[first, firstInput], [second, secondInput]]) {
    prepareClaimedSources({ memory, botId: 'a', sessionId: 'session', messages: [msg], home: '/synthetic' });
    const ref = memory.current('a').sourceRefs[0];
    assert.equal(memory.store.source(ref.id, ref.revision).body, expected.event.body);
  }
}));

test('a held original follows its receiving Bot across native parts without becoming routing-envelope bytes', async () => withMemory(async memory => {
  const msg = message('$transfer', '!project:test', '@alice:test', 'routing JSON envelope');
  const original = input(msg); original.event.body = 'Exact original Matrix body';
  const key = heldIngressKey('a', msg.source);
  memory.store.setMeta(key, original);
  assert.notEqual(key, heldIngressKey('b', msg.source));
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'old-part', messages: [msg], home: '/synthetic' });
  const oldRef = memory.current('a').sourceRefs[0];
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'new-part', messages: [msg], home: '/synthetic' });
  assert.deepEqual(memory.current('a', 'new-part').sourceRefs, [oldRef]);
  assert.equal(memory.store.source(oldRef.id).body, original.event.body);
  assert.equal(memory.store.observations('a').length, 1);
}));

test('a stable SDK message ID or request ID is usable before a log sequence exists', async () => withMemory(async memory => {
  const plain = { id: 'sdk-stable', source: { kind: 'user' }, content: [{ type: 'text', text: 'native chat' }] };
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'session', messages: [plain], home: '/synthetic', clock: () => 42 });
  const first = memory.current('a');
  assert.equal(memory.store.source(first.sourceRefs[0].id).eventId, 'session:message:sdk-stable');
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'session', messages: [plain], home: '/synthetic', clock: () => 999 });
  assert.deepEqual(memory.current('a').sourceRefs, first.sourceRefs);
  assert.equal(memory.store.source(first.sourceRefs[0].id).timestamp, 42);
  const requested = nativeMemoryInput({ source: { kind: 'user', requestId: 'rpc-stable' }, text: 'hello', home: '/synthetic', sessionId: 'session', stableOnly: true });
  assert.equal(requested.event.eventId, 'session:request:rpc-stable');
  assert.equal(nativeMemoryInput({ source: { kind: 'user' }, text: 'hello', home: '/synthetic', sessionId: 'session', stableOnly: true }), undefined);
}));

test('an unidentified claimed message exposes an unknown current context instead of the prior speaker or room', async () => withMemory(async memory => {
  memory.ingest('a', input(message('$old', '!old:test', '@alice:test', 'private old source')), { sessionId: 'session' });
  const count = memory.store.sources().length;
  prepareClaimedSources({ memory, botId: 'a', sessionId: 'session', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'unidentified' }] }], home: '/synthetic' });
  const view = memory.contextSnapshot('a', 'session');
  assert.equal(view.sourceStatus, 'unavailable'); assert.equal(view.authorId, null); assert.equal(view.roomId, null);
  assert.deepEqual(view.recentSources, []); assert.deepEqual(view.sourceRefs, []);
  assert.equal(JSON.stringify(view).includes('private old source'), false);
  assert.equal(memory.store.sources().length, count);
}));
