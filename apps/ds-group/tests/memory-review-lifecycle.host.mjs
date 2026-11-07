import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { installNativeMemory } from '../memory/native.mjs';
import { MemoryService } from '../memory/service.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function deadline(promise, ms = 2000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LIFECYCLE_TEST_TIMEOUT')), ms); })]).finally(() => clearTimeout(timer));
}
const input = id => ({ event: { eventId: `$${id}`, senderId: '@alice:test', roomId: '!room:test', body: `Original ${id}`, timestamp: 100 },
  context: { source: { transport: 'matrix', sender: { id: '@alice:test', name: 'Alice', kind: 'human' } } } });

async function fixture({ home, mode = 'hang', idle } = {}) {
  const owned = !home; home ||= await mkdtemp(join(tmpdir(), 'memory-review-stop-'));
  const ctx = new Context(); await ctx.plugin(LlmRuntime);
  const state = { mode, calls: 0, started: deferred(), aborted: [], warnings: [], closed: false, writesAfterClose: 0 };
  class Local extends LlmAdapter {
    providerInfo(id) { return { id, name: 'Local lifecycle fixture' }; }
    async *stream(options) {
      state.calls++; state.signal = options.signal; state.started.resolve();
      if (state.mode === 'network-error') throw new LlmError('Local transient failure', 'NETWORK');
      if (state.mode === 'hang' || state.mode === 'late-finish') {
        await new Promise(resolve => {
          const aborted = () => { state.aborted.push(options.signal.reason); resolve(); };
          if (options.signal.aborted) aborted(); else options.signal.addEventListener('abort', aborted, { once: true });
        });
        if (state.mode === 'hang') throw options.signal.reason;
      }
      const source = JSON.parse(options.messages[0].content[0].text).sources[0];
      const changes = state.mode === 'late-finish' ? [{ op: 'add', text: 'Late result must not publish',
        subjectId: source.authorId, predicate: 'late-result', kind: 'stated', sourceIds: [source.id], scope: `room:${source.roomId}` }] : [];
      yield { type: 'text-delta', text: JSON.stringify({ changes }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['local-lifecycle'], new Local());
  const bots = new Set(['a', 'b']); let scope;
  const rt = { home, config: { memoryReview: true, memoryReviewDelayMs: 0, memoryObservationReviewDelayMs: 0, memoryRetryDelaysMs: [60000] },
    teamTools: [], groupOwners: new Map(), state: { bots: {}, rooms: {} }, selfOf: id => id, chatOf: id => id,
    botOf: id => bots.has(id) ? { id } : undefined, isBotSession: id => bots.has(id),
    desiredModel: async () => 'local-lifecycle/model', defaultModel: async () => 'local-lifecycle/model',
    resolveAgent: async id => ({ whenIdle: () => idle ? idle(id) : Promise.resolve() }), warn: (...args) => state.warnings.push(args) };
  await ctx.plugin({ name: 'memory-review-stop', apply(child) {
    scope = child;
    installNativeMemory(Object.assign(rt, { ctx: { llm: ctx.llm, get: child.get.bind(child), on: child.on.bind(child),
      effect: child.effect.bind(child), systemPrompt: { section: () => () => {} } } }));
  } });
  const store = rt.knowledge.store, close = store.close.bind(store);
  for (const method of ['prepare', 'exec']) {
    const original = store.db[method].bind(store.db);
    store.db[method] = (...args) => { if (state.closed) state.writesAfterClose++; return original(...args); };
  }
  store.close = () => { state.closed = true; close(); };
  return { home, rt, state, stop: () => scope.fiber.dispose(), async close() {
    await ctx.fiber.dispose(); if (owned) await rm(home, { recursive: true, force: true });
  } };
}

test('the real SDK aborts a hanging background stream promptly and restart resumes unchanged persistent sources', async () => {
  const f = await fixture(), works = []; let resumed;
  try {
    const refs = new Map();
    for (const bot of ['a', 'b']) {
      refs.set(bot, f.rt.knowledge.ingest(bot, input(bot), { sessionId: `${bot}-session` }).sourceRefs[0]);
      works.push(f.rt.memoryFlush(bot, { automatic: true }).then(() => ({ ok: true }), error => ({ error })));
    }
    await deadline(f.state.started.promise);
    assert.equal(f.state.signal.aborted, false);
    const started = performance.now(); await deadline(f.stop(), 1000);
    assert.ok(performance.now() - started < 1000);
    assert.equal(f.state.signal.aborted, true); assert.equal(f.state.aborted.length, 1);
    assert.equal(f.state.aborted[0].code, 'MEMORY_REVIEW_STOPPED');
    assert.equal(f.state.calls, 1); assert.equal(f.rt.memoryReviews(), 0);
    assert.ok((await Promise.all(works)).some(result => result.error));
    assert.equal(f.state.closed, true); assert.equal(f.state.writesAfterClose, 0);
    assert.throws(() => f.rt.memoryObserve('a', input('after-stop')), error => error.code === 'MEMORY_DISPOSED');
    await assert.rejects(f.rt.memoryFlush('a'), error => error.code === 'MEMORY_DISPOSED');
    resumed = await fixture({ home: f.home, mode: 'complete' });
    for (const bot of ['a', 'b']) {
      const ref = refs.get(bot);
      assert.equal(resumed.rt.knowledge.readSource(bot, ref).body, `Original ${bot}`);
      assert.equal(resumed.rt.knowledge.current(bot, `${bot}-session`).authorId, 'matrix:@alice:test');
      assert.equal(resumed.rt.knowledge.current(bot, `${bot}-session`).roomId, '!room:test');
      assert.deepEqual(resumed.rt.knowledge.current(bot, `${bot}-session`).sourceRefs, [ref]);
      assert.deepEqual(resumed.rt.knowledge.store.getMeta(`unreviewed:${bot}`), [ref]);
      assert.equal(resumed.rt.knowledge.store.getMeta(`reviewed:${bot}:${ref.id}:1`), undefined);
      await resumed.rt.memoryFlush(bot);
      assert.deepEqual(resumed.rt.knowledge.store.getMeta(`unreviewed:${bot}`), []);
      assert.equal(resumed.rt.knowledge.store.getMeta(`reviewed:${bot}:${ref.id}:1`), true);
    }
    assert.equal(resumed.state.calls, 2);
  } finally { if (resumed) await resumed.close(); await f.close(); }
});

test('a cleanly ending late stream cannot publish its proposal or acknowledge the source after stop', async () => {
  const f = await fixture({ mode: 'late-finish' });
  try {
    const ref = f.rt.knowledge.ingest('a', input('late'), { sessionId: 'a-session' }).sourceRefs[0];
    const work = f.rt.memoryFlush('a').catch(error => error);
    await deadline(f.state.started.promise); await deadline(f.stop(), 1000); await work;
    const reopened = new MemoryService({ directory: join(f.home, 'knowledge') });
    try {
      assert.equal(reopened.store.list({ botId: 'a' }).length, 0);
      assert.deepEqual(reopened.store.getMeta('unreviewed:a'), [ref]);
      assert.equal(reopened.store.getMeta(`reviewed:a:${ref.id}:1`), undefined);
      assert.equal(reopened.readSource('a', ref).body, 'Original late');
    } finally { await reopened.close(); }
    assert.equal(f.state.writesAfterClose, 0);
  } finally { await f.close(); }
});

test('stop interrupts a 60-second retry delay and the automatic scheduler does not retry or warn after disposal', async () => {
  const f = await fixture({ mode: 'network-error' });
  try {
    const ref = f.rt.memoryObserve('a', input('retry')).sourceRefs[0];
    await deadline(f.state.started.promise);
    await deadline((async () => { while (!f.rt.knowledge.errors.length) await delay(1); })());
    await deadline(f.stop(), 1000); await delay(30);
    assert.equal(f.state.calls, 1); assert.equal(f.state.warnings.length, 0); assert.equal(f.rt.memoryReviews(), 0);
    assert.equal(f.state.writesAfterClose, 0);
    const reopened = new MemoryService({ directory: join(f.home, 'knowledge') });
    try { assert.deepEqual(reopened.store.getMeta('unreviewed:a'), [ref]); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});

test('stop releases a background idle wait without starting a provider or writing after its late resolution', async () => {
  const entered = deferred(), idle = deferred(), f = await fixture({ idle: () => { entered.resolve(); return idle.promise; } });
  try {
    f.rt.knowledge.ingest('a', input('idle'), { sessionId: 'a-session' });
    const work = f.rt.memoryFlush('a').catch(error => error);
    await deadline(entered.promise); await deadline(f.stop(), 1000); await work;
    idle.resolve(); await delay(20);
    assert.equal(f.state.calls, 0); assert.equal(f.state.writesAfterClose, 0); assert.equal(f.rt.memoryReviews(), 0);
  } finally { idle.resolve(); await f.close(); }
});
