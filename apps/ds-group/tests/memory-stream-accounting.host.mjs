import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installNativeMemory } from '../memory/native.mjs';
import { RETIRED_SNAPSHOT_KIND } from '../memory/snapshot-context.mjs';
import { kernelContext } from './fixtures/kernel-context.mjs';

test('snapshot rewrites precede existing admission and later native observers on the official event bus', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dscord-stream-accounting-'));
  const events = new Context();
  const counts = { admission: 0, lateNative: 0, provider: 0 };
  const sent = [], observedUsage = [];
  const observe = name => (_options, next) => (async function* () {
    counts[name]++;
    for await (const chunk of next()) {
      if (chunk.type === 'usage') observedUsage.push({ name, chunk });
      yield chunk;
    }
  })();
  events.on('llm/stream', observe('admission'));
  const host = kernelContext();
  host.llm.stream = options => events.waterfall(host.llm, 'llm/stream', options, async function* () {
    counts.provider++; sent.push(options);
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
  });
  await events.plugin({ name: 'source-memory', apply(scope) {
    // Use Cordis itself for ordering, including the child plugin scope. Other
    // services are inert boundaries; no Agent or provider runs in this check.
    const ctx = { ...host, on: scope.on.bind(scope) };
    installNativeMemory({ ctx, home, config: { memoryReview: false }, teamTools: [],
      isBotSession: id => id === 'native-bot', botOf: id => id === 'native-bot' ? { id } : undefined,
      selfOf: id => id === 'native-bot' ? id : undefined, chatOf: id => id, state: { bots: {}, rooms: {} }, warn() {} });
  } });
  events.on('llm/stream', observe('lateNative'));
  t.after(async () => { await host.dispose(); await events.fiber.dispose(); await rm(home, { recursive: true, force: true }); });
  const human = createUserMessage({ content: [{ type: 'text', text: 'Original human input' }], source: { kind: 'user' } });
  const retired = createUserMessage({ content: [], source: { kind: RETIRED_SNAPSHOT_KIND, input: 'context' } });
  const current = createUserMessage({ content: [{ type: 'text', text: 'Current source facts' }], source: { kind: 'knowledge-context' } });
  const messages = Object.freeze([human, retired, current]);
  const request = Object.freeze({ provider: 'scripted', model: 'chat', sessionId: 'native-bot', messages, maxTokens: 100 });
  // Calling the same request twice is two real dispatches, not one deduped receipt.
  for (let n = 0; n < 2; n++) for await (const _chunk of host.llm.stream(request)) {}
  assert.deepEqual(counts, { admission: 2, lateNative: 2, provider: 2 });
  assert.deepEqual(sent.map(item => item.messages.map(message => message.id)), [[human.id, current.id], [human.id, current.id]]);
  assert.equal(request.messages, messages); assert.equal(messages.length, 3);
  for (let n = 0; n < observedUsage.length; n += 2) assert.equal(observedUsage[n].chunk, observedUsage[n + 1].chunk);
});
