import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installNativeMemory } from '../memory/native.mjs';

test('the actual SDK identified claimed messages produce the first-step snapshot before their user/message event', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-claimed-sdk-')), cleanups = [], handlers = new Map();
  const rt = { home, config: { memoryReview: false }, teamTools: [], groupOwners: new Map(), selfOf: () => 'a', botOf: id => id === 'a' ? { id } : null,
    ctx: { on(name, callback) { handlers.set(name, callback); }, systemPrompt: { section: () => () => {} },
      effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') cleanups.push(cleanup); } } };
  const agent = { id: 'session' };
  try {
    installNativeMemory(rt);
    for (const [index, senderId, roomId] of [[1, '@alice:test', '!first:test'], [2, '@bob:test', '!second:test']]) {
      const text = `message ${index}`, eventId = `$event-${index}`;
      const original = { event: { eventId, senderId, roomId, body: text, timestamp: index }, context: { source: { transport: 'matrix', eventId, roomId,
        sender: { id: senderId, name: senderId, kind: 'human' }, timestamp: index } } };
      rt.memoryIngress(agent.id, `routing ${index}`, original);
      const message = createUserMessage({ source: { kind: 'user', eventId, roomId, sender: original.context.source.sender }, content: [{ type: 'text', text: `routing ${index}` }] });
      const decision = await handlers.get('agent/pre-step')({ agent, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }));
      const snapshot = JSON.parse(decision.messages.at(-1).content[0].text.split('\n').slice(1).join('\n'));
      assert.equal(snapshot.authorId, `matrix:${senderId}`); assert.equal(snapshot.roomId, roomId);
      assert.equal(snapshot.recentSources.find(source => source.eventId === eventId).body, text);
      const before = rt.knowledge.store.observations('a').length;
      handlers.get('session/event')({ id: agent.id }, { type: 'user/message', data: message, seq: 99 + index, time: 999 });
      assert.equal(rt.knowledge.store.observations('a').length, before);
      assert.deepEqual(rt.knowledge.current('a', agent.id).sourceRefs, snapshot.sourceRefs);
    }
    const current = rt.knowledge.current('a', agent.id);
    const rejected = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'rejected' }] });
    await handlers.get('agent/pre-step')({ agent }, async () => ({ kind: 'reject', messages: [rejected] }));
    assert.deepEqual(rt.knowledge.current('a', agent.id), current);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(home, { recursive: true }); }
});
