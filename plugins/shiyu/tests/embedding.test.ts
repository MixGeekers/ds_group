import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HARRIER_PROFILE, LocalHarrierEmbedder, normalizeEmbedding, validateLocalEmbeddingEndpoint, verifyHarrierArtifact } from '../src/adapters/embedding/index.js';

const endpoint = 'http://127.0.0.1:18333/v1/embeddings';
const vector = (first = 3, second = 4): number[] => [first, second, ...new Array(1022).fill(0)];
const reply = (data: unknown, extra: Record<string, unknown> = {}) => Response.json({ model: HARRIER_PROFILE.model, data, ...extra });
const clientFor = (response: () => Response) => new LocalHarrierEmbedder({ endpoint, fetch: async () => response() });

test('embedding endpoint is an explicit loopback address, with no redirects or credential-bearing URL', () => {
  for (const good of [endpoint, 'http://[::1]:18333/v1/embeddings']) assert.ok(validateLocalEmbeddingEndpoint(good));
  for (const bad of ['https://example.com/v1/embeddings', 'http://192.168.1.2:123/v1/embeddings', 'http://localhost:123/v1/embeddings', 'file:///tmp/model', 'http://127.0.0.1/v1/embeddings', 'http://u:p@127.0.0.1:123/v1/embeddings', endpoint + '?target=remote', endpoint + '#fragment', 'http://127.0.0.1:123/other']) {
    assert.throws(() => validateLocalEmbeddingEndpoint(bad), /loopback/);
  }
});

test('query prefix is pinned, documents stay unchanged, and indexed results are normalized and ordered', async () => {
  const requests: { input: string[]; model: string; encoding_format: string }[] = [];
  const client = new LocalHarrierEmbedder({ endpoint, fetch: async (url, init) => {
    assert.equal(String(url), endpoint); assert.equal(init?.redirect, 'manual');
    assert.equal(init?.method, 'POST');
    requests.push(JSON.parse(String(init?.body)));
    return reply([{ index: 1, embedding: vector(0, 2) }, { index: 0, embedding: vector() }]);
  } });
  const docs = await client.embedDocuments(['雨喜欢乌龙茶。', 'Alice prefers trains.']);
  const queries = await client.embedQueries(['雨喜欢喝什么？', 'What transport does Alice prefer?']);
  assert.deepEqual(requests[0]?.input, ['雨喜欢乌龙茶。', 'Alice prefers trains.']);
  assert.equal(requests[1]?.input[0], HARRIER_PROFILE.queryPrefix + '雨喜欢喝什么？');
  assert.equal(requests[1]?.input[1], HARRIER_PROFILE.queryPrefix + 'What transport does Alice prefer?');
  assert.equal(requests[0]?.model, HARRIER_PROFILE.model); assert.equal(requests[0]?.encoding_format, 'float');
  assert.deepEqual(docs.vectors[0]?.slice(0, 2), [0.6, 0.8]);
  assert.deepEqual(docs.vectors[1]?.slice(0, 2), [0, 1]);
  assert.equal(queries.profileId, HARRIER_PROFILE.id); assert.equal(queries.dimensions, 1024);
});

test('vector validation rejects wrong dimensions, non-numbers, nonfinite and zero norm without truncating', () => {
  for (const value of [[], new Array(512).fill(1), new Array(2048).fill(1), new Array(1024).fill(0), ['1', ...new Array(1023).fill(0)], [Infinity, ...new Array(1023).fill(0)], [NaN, ...new Array(1023).fill(0)]]) {
    assert.throws(() => normalizeEmbedding(value), /Embedding/);
  }
  const normalized = normalizeEmbedding(new Array(1024).fill(Number.MAX_VALUE));
  assert.ok(normalized.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-12);
});

test('response index coverage and model identity must match the complete request', async () => {
  for (const make of [
    () => reply([{ index: 0, embedding: vector() }]),
    () => reply([{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }]),
    () => reply([{ index: 0, embedding: vector() }, { index: 2, embedding: vector() }]),
    () => reply([{ index: 0, embedding: vector() }, { index: 0.5, embedding: vector() }]),
    () => reply([{ index: 0, embedding: vector() }, { index: 1, embedding: vector() }], { model: 'another-model' }),
    () => Response.json(null),
  ]) await assert.rejects(clientFor(make).embedDocuments(['a', 'b']), /Embedding response/);
});

test('invalid or unbounded requests never reach transport', async () => {
  let requests = 0;
  const client = new LocalHarrierEmbedder({ endpoint, fetch: async () => { requests++; throw new Error('unexpected'); } });
  for (const texts of [[], [''], ['   '], new Array(33).fill('a'), ['中'.repeat(6000)], new Array(32).fill('a'.repeat(10000))]) {
    await assert.rejects(client.embedDocuments(texts), /Embedding/);
  }
  assert.equal(requests, 0);
  assert.throws(() => new LocalHarrierEmbedder({ endpoint, timeoutMs: Infinity }), /timeout/);
});

test('HTTP failures, redirects and malformed or oversized responses fail without exposing body text', async () => {
  for (const make of [
    () => new Response('sensitive server text', { status: 500 }),
    () => new Response(null, { status: 302, headers: { location: 'https://remote.example/embeddings' } }),
    () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
    () => new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999999' } }),
    () => new Response(' '.repeat(2097153), { headers: { 'content-type': 'application/json' } }),
  ]) await assert.rejects(clientFor(make).embedDocuments(['a']), error => error instanceof Error && !error.message.includes('sensitive server text'));
});

test('caller cancellation prevents requests and timeout/cancellation propagate to transport', async () => {
  let requests = 0;
  const controller = new AbortController(); controller.abort();
  const client = new LocalHarrierEmbedder({ endpoint, timeoutMs: 10, fetch: async (_url, init) => {
    requests++;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
  } });
  await assert.rejects(client.embedQueries(['q'], { signal: controller.signal }), /abort/i);
  assert.equal(requests, 0);
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(client.embedQueries(['q']), /timeout/i); }
  finally { clearTimeout(keepAlive); }
  assert.equal(requests, 1);
});

test('artifact validation fails before hashing an unrelated file', async () => {
  await assert.rejects(verifyHarrierArtifact(fileURLToPath(import.meta.url)), /artifact size/);
  assert.equal(Object.isFrozen(HARRIER_PROFILE), true);
});
