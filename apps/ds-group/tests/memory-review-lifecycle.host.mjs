import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { installNativeMemory } from '../memory/native.mjs';
import { MemoryService } from '../memory/service.mjs';
import { install as installLearning } from '../vendor/ds-bot/src/host/learning.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function deadline(promise, ms = 2000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LIFECYCLE_TEST_TIMEOUT')), ms); })]).finally(() => clearTimeout(timer));
}
const input = id => ({ event: { eventId: `$${id}`, senderId: '@alice:test', roomId: '!room:test', body: `Original ${id}`, timestamp: 100 },
  context: { source: { transport: 'matrix', sender: { id: '@alice:test', name: 'Alice', kind: 'human' } } } });

async function fixture({ home, mode = 'hang', idle, learning = false } = {}) {
  const owned = !home; home ||= await mkdtemp(join(tmpdir(), 'memory-review-stop-'));
  const ctx = new Context(); await ctx.plugin(LlmRuntime);
  const state = { mode, calls: 0, started: deferred(), answerStarted: deferred(), cleanupStarted: deferred(), cleanupGate: deferred(), aborted: [], warnings: [], closed: false, writesAfterClose: 0 };
  class Local extends LlmAdapter {
    providerInfo(id) { return { id, name: 'Local lifecycle fixture' }; }
    async *stream(options) {
      state.calls++; state.signal = options.signal; state.started.resolve();
      let input; try { input = JSON.parse(options.messages[0].content[0].text); } catch {}
      const answer = input?.question !== undefined && input?.memories !== undefined;
      if (answer) state.answerStarted.resolve();
      const mode = state.mode.startsWith('panel-') ? answer ? state.mode.slice(6) : 'complete' : state.mode;
      if (mode === 'network-error') throw new LlmError('Local transient failure', 'NETWORK');
      if (['hang', 'late-finish', 'cleanup-late'].includes(mode)) {
        await new Promise(resolve => {
          const aborted = () => { state.aborted.push(options.signal.reason); resolve(); };
          if (options.signal.aborted) aborted(); else options.signal.addEventListener('abort', aborted, { once: true });
        });
        if (mode === 'cleanup-late') { state.cleanupStarted.resolve(); await state.cleanupGate.promise; }
        if (mode === 'hang' || mode === 'cleanup-late') throw options.signal.reason;
      }
      const source = input?.sources?.[0];
      const changes = ['late-finish', 'proposal'].includes(mode) && source ? [{ op: 'add', text: 'Late result must not publish',
        subjectId: source.authorId, predicate: 'late-result', kind: 'stated', sourceIds: [source.id], scope: `room:${source.roomId}` }] : [];
      yield { type: 'text-delta', text: answer ? 'Local panel answer.' : JSON.stringify({ changes }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['local-lifecycle'], new Local());
  const bots = new Set(['a', 'b']); let scope;
  const rt = { home, config: { memoryReview: true, memoryReviewDelayMs: 0, memoryObservationReviewDelayMs: 0, memoryRetryDelaysMs: [60000] },
    teamTools: [], groupOwners: new Map(), state: { bots: {}, rooms: {} }, selfOf: id => id, chatOf: id => id,
    botOf: id => bots.has(id) ? { id } : undefined, isBotSession: id => bots.has(id),
    desiredModel: async () => 'local-lifecycle/model', defaultModel: async () => 'local-lifecycle/model',
    load: async () => {},
    resolveAgent: async id => ({ whenIdle: () => idle ? idle(id) : Promise.resolve() }), warn: (...args) => state.warnings.push(args) };
  if (learning) {
    rt.config.agentsMd = false;
    rt.partLines = async function* () { yield { seq: 1, text: 'User: A completed local task taught a reusable check.', who: 'user', time: 100 }; };
    await mkdir(join(home, 'learning'), { recursive: true });
    await writeFile(join(home, 'learning/state.json'), JSON.stringify({ pending: { a: ['a'] } }));
  }
  await ctx.plugin({ name: 'memory-review-stop', apply(child) {
    scope = child;
    installNativeMemory(Object.assign(rt, { ctx: { llm: ctx.llm, get: child.get.bind(child), on: child.on.bind(child),
      effect: child.effect.bind(child), systemPrompt: { section: () => () => {} } } }));
    if (learning) installLearning(rt);
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

test('the actual review_memory tool forwards caller cancellation and refuses a cleanly ending late proposal', async () => {
  const f = await fixture({ mode: 'late-finish' }), abort = new AbortController();
  try {
    const ref = f.rt.knowledge.ingest('a', input('on-demand'), { sessionId: 'a' }).sourceRefs[0];
    const tool = f.rt.teamTools.find(tool => tool.name === 'review_memory');
    const work = tool.execute({ kind: 'person', id: 'matrix:@alice:test', query: 'Original' }, { agent: { id: 'a' }, signal: abort.signal })
      .then(value => ({ value }), error => ({ error }));
    await deadline(f.state.started.promise);
    const reason = Object.assign(new Error('Caller canceled the tool'), { code: 'CALLER_CANCELED' }); abort.abort(reason);
    assert.equal((await deadline(work)).error, reason);
    assert.equal(f.state.signal.aborted, true); assert.equal(f.state.calls, 1);
    assert.equal(f.rt.knowledge.store.list({ botId: 'a' }).length, 0);
    assert.deepEqual(f.rt.knowledge.store.getMeta('unreviewed:a'), [ref]);
    assert.equal(f.rt.knowledge.readSource('a', ref).body, 'Original on-demand');
    assert.equal(f.rt.knowledge.errors.length, 0);
  } finally { abort.abort(); await f.close(); }
});

test('runtime disposal aborts a legacy direct botShot and waits for provider cleanup before closing its store', async () => {
  const f = await fixture({ mode: 'cleanup-late' }); let stopped = false;
  try {
    const work = f.rt.botShot({ id: 'a' }, 'Legacy learning prompt', 'Local work', { sessionId: 'a', kind: 'memory' }).catch(error => error);
    await deadline(f.state.started.promise); assert.ok(f.rt.memoryReviews() > 0);
    const stopping = f.stop().then(() => { stopped = true; });
    await deadline(f.state.cleanupStarted.promise);
    assert.equal(f.state.signal.aborted, true); assert.equal(stopped, false); assert.equal(f.state.closed, false);
    f.state.cleanupGate.resolve(); await deadline(stopping);
    assert.equal((await work).code, 'MEMORY_REVIEW_STOPPED');
    assert.equal(f.state.closed, true); assert.equal(f.state.calls, 1); assert.equal(f.rt.memoryReviews(), 0);
    assert.equal(f.state.writesAfterClose, 0);
  } finally { f.state.cleanupGate.resolve(); await f.close(); }
});

test('runtime disposal releases a signal-free legacy shot waiting for model selection without starting a provider', async () => {
  const f = await fixture(), entered = deferred(), model = deferred();
  try {
    f.rt.desiredModel = () => { entered.resolve(); return model.promise; };
    const work = f.rt.botShot({ id: 'a' }, 'Legacy lookup', 'Local work').catch(error => error);
    await deadline(entered.promise); await deadline(f.stop());
    assert.equal((await deadline(work)).code, 'MEMORY_REVIEW_STOPPED');
    model.resolve('local-lifecycle/model'); await delay(5);
    assert.equal(f.state.calls, 0); assert.equal(f.state.writesAfterClose, 0); assert.equal(f.rt.memoryReviews(), 0);
  } finally { model.resolve('local-lifecycle/model'); await f.close(); }
});

test('a caller can cancel a legacy shot during its existing retry delay without another model attempt', async () => {
  const f = await fixture({ mode: 'network-error' }), abort = new AbortController();
  try {
    const work = f.rt.botShot({ id: 'a' }, 'Legacy retry', 'Local work', { signal: abort.signal }).catch(error => error);
    await deadline((async () => { while (!f.rt.knowledge.errors.length) await delay(1); })());
    const reason = Object.assign(new Error('Canceled retry'), { code: 'RETRY_CANCELED' }); abort.abort(reason);
    assert.equal((await deadline(work)).cause, reason);
    assert.equal(f.state.calls, 1);
  } finally { abort.abort(); await f.close(); }
});

test('the actual memory-ask panel cancels its own review stream with the request signal', async () => {
  const f = await fixture(), abort = new AbortController();
  try {
    const work = f.rt.memoryEndpoint('memory-ask', { botId: 'a', text: 'Remember the local panel question.' }, { signal: abort.signal })
      .then(value => ({ value }), error => ({ error }));
    await deadline(f.state.started.promise);
    const reason = Object.assign(new Error('Panel request canceled'), { code: 'PANEL_CANCELED' }); abort.abort(reason);
    assert.equal((await deadline(work)).error, reason);
    assert.equal(f.state.signal.aborted, true); assert.equal(f.state.calls, 1);
    assert.equal(f.rt.knowledge.store.list({ botId: 'a' }).length, 0);
  } finally { abort.abort(); await f.close(); }
});

test('runtime disposal joins the actual panel answer stream and suppresses its late response', async () => {
  const f = await fixture({ mode: 'panel-late-finish' });
  try {
    const work = f.rt.memoryEndpoint('memory-ask', { botId: 'a', text: 'Answer from current records.' }).catch(error => error);
    await deadline(f.state.answerStarted.promise); await deadline(f.stop());
    assert.equal((await work).code, 'MEMORY_REVIEW_STOPPED');
    assert.equal(f.state.calls, 2); assert.equal(f.state.signal.aborted, true);
    assert.equal(f.state.closed, true); assert.equal(f.state.writesAfterClose, 0);
  } finally { await f.close(); }
});

test('an actual learning pass aborts its native botShot on disposal and settles before the state can be reused', async () => {
  const f = await fixture({ learning: true }); let settled = false;
  try {
    const bytes = await readFile(join(f.home, 'learning/state.json'), 'utf8');
    const work = f.rt.learningRun().finally(() => { settled = true; });
    await deadline(f.state.started.promise); await deadline(f.stop());
    assert.equal(settled, true); await work;
    assert.equal(f.state.signal.aborted, true); assert.equal(f.state.calls, 1);
    assert.deepEqual(f.rt.learningView(), {});
    assert.equal(await readFile(join(f.home, 'learning/state.json'), 'utf8'), bytes);
    assert.equal(f.state.writesAfterClose, 0);
  } finally { await f.close(); }
});

test('caller cancellation during retrospective backend staging prevents late fact publication', async () => {
  const f = await fixture({ mode: 'proposal' }), abort = new AbortController(), staged = deferred(), release = deferred();
  try {
    let reviewSignal;
    const applyReview = f.rt.knowledge.applyReview.bind(f.rt.knowledge);
    f.rt.knowledge.applyReview = (...args) => { reviewSignal = args[3]?.signal; return applyReview(...args); };
    f.rt.knowledge.ingest('a', input('staging'), { sessionId: 'a' });
    f.rt.knowledge.backend = { async save(row) { staged.resolve(); await release.promise; return { bodyDigest: row.bodyDigest, bodyDurable: true }; }, async index() {}, async close() {} };
    const tool = f.rt.teamTools.find(tool => tool.name === 'review_memory');
    const work = tool.execute({ kind: 'person', id: 'matrix:@alice:test', query: 'Original' }, { agent: { id: 'a' }, signal: abort.signal })
      .then(value => ({ value }), error => ({ error }));
    await deadline(staged.promise);
    const reason = Object.assign(new Error('Canceled during staging'), { code: 'STAGING_CANCELED' }); abort.abort(reason);
    assert.equal(f.state.calls, 1); assert.equal(reviewSignal?.reason, reason);
    const stopping = f.stop(); await delay(10); assert.equal(f.state.closed, false);
    release.resolve(); assert.equal((await deadline(work)).error, reason); await deadline(stopping);
    const reopened = new MemoryService({ directory: join(f.home, 'knowledge') });
    try { assert.equal(reopened.store.list({ botId: 'a' }).filter(row => row.status === 'active').length, 0); }
    finally { await reopened.close(); }
    assert.equal(f.state.calls, 1); assert.equal(f.state.writesAfterClose, 0);
  } finally { release.resolve(); abort.abort(); await f.close(); }
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
