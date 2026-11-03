import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STARTUP_EMBEDDING_QUERY, StartupEmbeddingVerifier, verifyStartupEmbedding,
  type StartupEmbeddingDeps, type StartupEmbeddingSearchResult,
} from '../src/control/startup-embedding-verifier.js';

const readyBackend = () => ({ state: 'ready', bindingVerified: true, semanticReady: false,
  semantic: { embeddingVerified: false, profileCompatible: true, state: 'unverified' } });
function deps(overrides: Partial<StartupEmbeddingDeps> = {}, calls = { search: 0, find: 0, publish: 0 }, backend = readyBackend()) {
  const result: StartupEmbeddingSearchResult = { state: 'ok', embeddingCalls: 1, usageComplete: true, matches: 1 };
  const value: StartupEmbeddingDeps = {
    semanticConfigured: true,
    backendStatus: () => backend,
    async findConversationWithMemory() { calls.find++; return 'conversation-1'; },
    async search(input) { calls.search++; void input; return result; },
    async publishVerified() { calls.publish++; },
    now: () => new Date('2026-11-03T00:00:00.000Z'),
    ...overrides,
  };
  return { deps: value, calls };
}

test('one successful fixed-query embedding verifies and publishes semantic search', async () => {
  const { deps: value, calls } = deps();
  const result = await verifyStartupEmbedding(value);
  assert.equal(result.attempted, true); assert.equal(result.verified, true); assert.equal(result.reason, null);
  assert.equal(result.embeddingCalls, 1); assert.equal(result.usageComplete, true); assert.equal(result.semanticPublished, true);
  assert.equal(calls.search, 1); assert.equal(calls.find, 1); assert.equal(calls.publish, 1);
  assert.equal(result.capturedAt, '2026-11-03T00:00:00.000Z');
});

test('already verified, unconfigured or not-ready backends skip without a backend query', async () => {
  const verified = deps({}, { search: 0, find: 0, publish: 0 }, { state: 'ready', bindingVerified: true, semanticReady: true,
    semantic: { embeddingVerified: true, profileCompatible: true, state: 'ready' } });
  const value = await verifyStartupEmbedding(verified.deps);
  assert.equal(value.attempted, true); assert.equal(value.reason, 'ALREADY_VERIFIED'); assert.equal(value.verified, false);
  assert.equal(verified.calls.search, 0); assert.equal(verified.calls.find, 0);
  const unconfigured = deps({ semanticConfigured: false });
  assert.equal((await verifyStartupEmbedding(unconfigured.deps)).reason, 'SEMANTIC_NOT_CONFIGURED');
  assert.equal(unconfigured.calls.search, 0);
  const notReady = deps({}, { search: 0, find: 0, publish: 0 }, { state: 'failed', bindingVerified: false, semanticReady: false, semantic: { embeddingVerified: false, profileCompatible: false, state: 'unavailable' } });
  assert.equal((await verifyStartupEmbedding(notReady.deps)).reason, 'BACKEND_NOT_READY');
  assert.equal(notReady.calls.search, 0);
});

test('no conversation or no eligible indexed memory stays exact-read-only with a controlled reason', async () => {
  const noConversation = deps({ async findConversationWithMemory() { return undefined; } });
  const first = await verifyStartupEmbedding(noConversation.deps);
  assert.equal(first.reason, 'NO_CONVERSATION'); assert.equal(first.verified, false); assert.equal(noConversation.calls.search, 0);
  let noIndexSearches = 0;
  const noIndex = deps({ async search() { noIndexSearches++; return { state: 'index_required', embeddingCalls: 0, usageComplete: true, matches: 0 }; } });
  const second = await verifyStartupEmbedding(noIndex.deps);
  assert.equal(second.reason, 'NO_ELIGIBLE_MEMORY'); assert.equal(second.verified, false); assert.equal(second.semanticPublished, false);
  assert.equal(noIndex.calls.publish, 0); assert.equal(noIndexSearches, 1); // exactly one probe
});

test('a failed or malformed embedding result degrades to exact-read and is never retried', async () => {
  let failingSearches = 0;
  const failing = deps({ async search() { failingSearches++; throw Object.assign(new Error('embedding provider failed'), { code: 'EMBEDDING_HTTP_500' }); } });
  const result = await verifyStartupEmbedding(failing.deps);
  assert.equal(result.reason, 'EMBEDDING_FAILED'); assert.equal(result.verified, false); assert.equal(result.errorCode, 'EMBEDDING_HTTP_500');
  assert.equal(failingSearches, 1); assert.equal(failing.calls.publish, 0);
  const malformed = deps({ async search() { return { state: 'ok', embeddingCalls: 2, usageComplete: true, matches: 1 } as never; } });
  const second = await verifyStartupEmbedding(malformed.deps);
  assert.equal(second.reason, 'EMBEDDING_FAILED'); assert.equal(second.errorCode, 'UNBOUNDED_EMBEDDING_USAGE');
  const incomplete = deps({ async search() { return { state: 'ok', embeddingCalls: 1, usageComplete: false, matches: 1 }; } });
  assert.equal((await verifyStartupEmbedding(incomplete.deps)).reason, 'EMBEDDING_FAILED');
});

test('timeout and abort are explicit and never publish a semantic capability', async () => {
  const hanging = deps({ search: input => new Promise((_resolve, reject) => { input.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); }) });
  const result = await verifyStartupEmbedding(hanging.deps, { timeoutMs: 5 });
  assert.equal(result.reason, 'TIMEOUT'); assert.equal(result.verified, false); assert.equal(hanging.calls.publish, 0);
  const aborted = deps();
  const controller = new AbortController(); controller.abort();
  assert.equal((await verifyStartupEmbedding(aborted.deps, { signal: controller.signal, timeoutMs: 1000 })).reason, 'ABORTED');
  assert.equal(aborted.calls.search, 0);
});

test('the per-process verifier performs exactly one attempt and a new process verifier can recover after reload', async () => {
  const { deps: value, calls } = deps();
  const verifier = new StartupEmbeddingVerifier();
  const first = await verifier.verify(value);
  assert.equal(first.verified, true); assert.equal(first.attempted, true);
  const second = await verifier.verify(value);
  assert.equal(second.reason, 'ALREADY_ATTEMPTED'); assert.equal(second.attempted, false); assert.equal(second.verified, true);
  assert.equal(calls.search, 1); assert.equal(calls.publish, 1);
  assert.equal(verifier.attempted, true); assert.deepEqual(verifier.last(), first);
  // A reload is a new process: a fresh verifier performs its own one attempt.
  const reloadCalls = { search: 0, find: 0, publish: 0 };
  const reloadBackend = () => ({ state: 'ready', bindingVerified: true, semanticReady: false, semantic: { embeddingVerified: false, profileCompatible: true, state: 'unverified' } });
  const reloadDeps = deps({}, reloadCalls, reloadBackend());
  const reloaded = await new StartupEmbeddingVerifier().verify(reloadDeps.deps);
  assert.equal(reloaded.verified, true); assert.equal(reloadCalls.search, 1); assert.equal(reloadCalls.publish, 1);
});

test('the verifier uses the fixed query, one conversation and no generation surface', async () => {
  const seen: { query?: string; conversationId?: string } = {};
  const { deps: value } = deps({ async search(input) { seen.query = input.query; seen.conversationId = input.conversationId;
    return { state: 'ok', embeddingCalls: 1, usageComplete: true, matches: 1 }; } });
  assert.equal('generateReply' in value, false);
  assert.equal('reply' in value, false);
  const result = await verifyStartupEmbedding(value);
  assert.equal(result.verified, true);
  assert.equal(seen.query, STARTUP_EMBEDDING_QUERY); assert.equal(seen.conversationId, 'conversation-1');
});
