import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createSessionContext } from './fixtures/sdk-session-context.mjs';
import { installNativeMemory } from '../memory/native.mjs';
import { legacyNativeRequest } from './fixtures/legacy-native-request.mjs';

test('the actual SDK identified claimed messages produce the first-step snapshot before their user/message event', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-claimed-sdk-')), cleanups = [], handlers = new Map();
  const ctx = await createSessionContext();
  const rt = { home, config: { memoryReview: false }, teamTools: [], groupOwners: new Map(), selfOf: () => 'a', botOf: id => id === 'a' ? { id } : null,
    ctx: { get: name => ctx.get(name), on(name, callback) { handlers.set(name, callback); }, systemPrompt: { section: () => () => {} },
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); } } };
  const agent = { id: 'session', session: ctx.sessions.create(SessionId('session')) };
  try {
    installNativeMemory(rt);
    for (const [index, senderId, roomId] of [[1, '@alice:test', '!first:test'], [2, '@bob:test', '!second:test']]) {
      const text = `message ${index}`, eventId = `$event-${index}`;
      const original = { event: { eventId, senderId, roomId, body: text, timestamp: index }, context: { source: { transport: 'matrix', eventId, roomId,
        sender: { id: senderId, name: senderId, kind: 'human' }, timestamp: index } } };
      rt.memoryIngress(agent.id, `routing ${index}`, original);
      // The receiving Bot stays the same when parts moves a pending claim.
      if (index === 2) {
        agent.id = 'new-native-part';
        agent.session = ctx.sessions.create(SessionId(agent.id));
      }
      const message = createUserMessage({ source: { kind: 'user', eventId, roomId, sender: original.context.source.sender }, content: [{ type: 'text', text: `routing ${index}` }] });
      const decision = await handlers.get('agent/pre-step')({ agent, turn: index, step: 1, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }));
      const snapshot = JSON.parse(decision.messages.at(-1).content[0].text.split('\n').slice(1).join('\n'));
      assert.equal(snapshot.authorId, `matrix:${senderId}`); assert.equal(snapshot.roomId, roomId);
      assert.equal(snapshot.recentSources.find(source => source.eventId === eventId).body, text);
      const before = rt.knowledge.store.observations('a').length;
      const event = agent.session.append('user/message', message, { surfaceOp: 'append' });
      handlers.get('session/event')(agent.session, event);
      assert.equal(rt.knowledge.store.observations('a').length, before);
      assert.deepEqual(rt.knowledge.current('a', agent.id).sourceRefs, snapshot.sourceRefs);
      agent.session.append('user/message', decision.messages.at(-1), { surfaceOp: 'append' });
      assert.equal(agent.session.deriveMessages().filter(message => message.source?.kind === 'knowledge-context').length, 1);
    }
    const current = rt.knowledge.current('a', agent.id);
    const rejected = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'rejected' }] });
    await handlers.get('agent/pre-step')({ agent }, async () => ({ kind: 'reject', messages: [rejected] }));
    assert.deepEqual(rt.knowledge.current('a', agent.id), current);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); await ctx.fiber.dispose(); await rm(home, { recursive: true }); }
});

test('projecting a historical request never re-ingests its source or replaces the current speaker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-request-projection-')), cleanups = [], ctx = await createSessionContext();
  const rt = { home, config: { memoryReview: false }, teamTools: [], groupOwners: new Map(), selfOf: () => 'a', botOf: id => id === 'a' ? { id } : null,
    ctx: { get: name => ctx.get(name), on: (...args) => ctx.on(...args), systemPrompt: { section: () => () => {} },
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); } } };
  try {
    installNativeMemory(rt);
    const session = ctx.sessions.create(SessionId('historical'));
    const legacy = legacyNativeRequest(), origin = { event: { eventId: legacy.source.eventId, roomId: legacy.source.roomId,
      senderId: legacy.source.sender.id, body: 'Original human wording.' }, context: { source: legacy.source } };
    rt.memoryIngress(session.id, legacy.content[0].text, origin);
    session.append('user/message', legacy, { surfaceOp: 'append' });
    rt.knowledge.ingest('a', { event: { eventId: '$current-bob', roomId: '!different:test', senderId: '@bob:test', body: 'Current work.' },
      context: { source: { transport: 'matrix', sender: { id: '@bob:test', kind: 'human' }, roomId: '!different:test' } } }, { sessionId: session.id });
    const current = rt.knowledge.current('a', session.id), observations = rt.knowledge.store.observations('a');
    const source = rt.knowledge.store.source(observations[0].id), bytes = JSON.stringify(source);
    await rt.memoryRetireSnapshots(session, { keepLatest: true });
    assert.deepEqual(rt.knowledge.current('a', session.id), current);
    assert.deepEqual(rt.knowledge.store.observations('a'), observations);
    assert.equal(JSON.stringify(rt.knowledge.store.source(source.id)), bytes);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); await ctx.fiber.dispose(); await rm(home, { recursive: true }); }
});
