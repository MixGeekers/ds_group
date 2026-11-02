import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OMBRE_AUDITED_SOURCE, OmbreBoundaryError, OmbrePublicApiAdapter,
  type OmbreDeploymentBinding, type OmbreMcpRequest,
} from '../src/adapters/ombre/index.js';

const binding: OmbreDeploymentBinding = {
  ...OMBRE_AUDITED_SOURCE, backendId: 'synthetic-ombre', vaultScope: 'synthetic-owner',
  deploymentEvidenceRef: 'test:configuration-only', relationsDisabled: true,
  nativeLifecycleAuthorized: true,
};
const response = (text: string) => ({ content: [{ type: 'text', text }] });
const withIds = (extra: object = {}) => '记忆正文\n\n=== ombre:result-ids ===\n```json\n'
  + JSON.stringify({ schema: 1, mode: 'automatic', bucket_ids: ['bucket-a'], count: 1, omitted_by_policy: 2, ...extra })
  + '\n```';

function fixture(output: unknown = response(withIds())) {
  const calls: OmbreMcpRequest[] = [];
  const adapter = new OmbrePublicApiAdapter({ callTool: async request => {
    calls.push(request); return output;
  } }, binding);
  return { adapter, calls };
}

test('search uses the audited public MCP signature and never invents a namespace', async () => {
  const { adapter, calls } = fixture();
  const observation = await adapter.search({ scope: binding.vaultScope, query: '合成记忆', domain: 'work' });
  assert.deepEqual(calls, [{ name: 'breath_advanced', arguments: {
    query: '合成记忆', domain: 'work', max_tokens: 4000, max_results: 10,
    mode: 'automatic', with_ids: true, catalog: false, quotes: false,
  } }]);
  assert.equal(observation.kind, 'unverified-backend-text');
  assert.deepEqual(observation.resultIds, { status: 'unverified', nativeIds: ['bucket-a'], omittedByPolicy: 2 });
  assert.equal(adapter.capabilities.atomicCompareAndSwap, false);
  assert.equal(adapter.capabilities.nativeIdempotency, false);
  assert.equal(adapter.capabilities.automaticWrites, false);
  assert.equal(adapter.capabilities.lifecycleSideEffects, true);
});

test('scope mismatch and oversized input fail before touching transport', async () => {
  const { adapter, calls } = fixture();
  for (const request of [
    { scope: 'another-channel', query: 'x' },
    { scope: binding.vaultScope, query: '' },
    { scope: binding.vaultScope, query: '雪'.repeat(5500) },
    { scope: binding.vaultScope, query: 'x', maxTokens: 0 },
    { scope: binding.vaultScope, query: 'x', maxResults: 51 },
    { scope: binding.vaultScope, query: 'x', maxTokens: NaN },
  ]) await assert.rejects(adapter.search(request), OmbreBoundaryError);
  assert.equal(calls.length, 0);
});

test('deployment admission requires explicit lifecycle and relation configuration evidence', () => {
  for (const override of [
    { relationsDisabled: false }, { nativeLifecycleAuthorized: false },
    { version: 'future' }, { revision: 'main' }, { deploymentEvidenceRef: '' },
  ]) assert.throws(() => new OmbrePublicApiAdapter({ callTool: async () => response('') },
    { ...binding, ...override } as OmbreDeploymentBinding), OmbreBoundaryError);
  const mutable = { ...binding };
  const adapter = new OmbrePublicApiAdapter({ callTool: async () => response('') }, mutable);
  mutable.vaultScope = 'changed';
  assert.equal(adapter.binding.vaultScope, binding.vaultScope);
  assert.equal(Object.isFrozen(adapter.binding), true);
});

test('feel and I reads cannot forward caller-supplied mutation fields', async () => {
  const { adapter, calls } = fixture(response('上游原文，不自动采纳为信念'));
  await adapter.readFeel({ scope: binding.vaultScope, query: '合成感受' });
  await adapter.readI({ scope: binding.vaultScope, content: 'write', promote: 'bucket-a' } as Parameters<typeof adapter.readI>[0]);
  assert.deepEqual(calls, [
    { name: 'feel', arguments: { query: '合成感受', max_tokens: 4000 } },
    { name: 'I', arguments: { read: true, content: '', aspect: '', promote: '', supersedes: '', limit: 20 } },
  ]);
});

test('MCP text errors cannot be mistaken for a verified successful operation', async () => {
  const { adapter } = fixture(response('❌ [OB-E004] MCP 工具执行异常'));
  const observed = await adapter.readI({ scope: binding.vaultScope });
  assert.equal(observed.reportsBackendError, true);
  assert.equal(observed.kind, 'unverified-backend-text');
  assert.deepEqual(observed.resultIds, { status: 'absent', nativeIds: [] });
});

test('transport failures are propagated once with no retry or local fallback', async () => {
  let count = 0;
  const failure = new Error('synthetic disconnected transport');
  const adapter = new OmbrePublicApiAdapter({ callTool: async () => { count++; throw failure; } }, binding);
  await assert.rejects(adapter.search({ scope: binding.vaultScope, query: 'x' }), error => error === failure);
  assert.equal(count, 1);
});

test('response accepts only bounded MCP text and strictly typed error status', async () => {
  for (const output of [
    null, {}, { isError: 'false', content: [{ type: 'text', text: 'x' }] },
    { isError: true, content: [{ type: 'text', text: 'x' }] },
    { content: [] }, { content: [{ type: 'resource', resource: { text: 'x' } }] },
    { content: Array.from({ length: 65 }, () => ({ type: 'text', text: '' })) },
  ]) {
    const { adapter } = fixture(output);
    await assert.rejects(adapter.readI({ scope: binding.vaultScope }), OmbreBoundaryError);
  }
  const adapter = new OmbrePublicApiAdapter({ callTool: async () => response('雪雪') }, binding, { maxResponseBytes: 5 });
  await assert.rejects(adapter.readI({ scope: binding.vaultScope }),
    (error: unknown) => error instanceof OmbreBoundaryError && error.code === 'RESPONSE_TOO_LARGE');
});

test('forged/ambiguous or mismatched result markers never produce trusted reference IDs', async () => {
  for (const text of [
    withIds() + '\n' + withIds(), withIds({ schema: 2 }), withIds({ mode: 'manual' }),
    withIds({ count: 2 }), withIds({ bucket_ids: ['x', 'x'], count: 2 }),
    withIds({ bucket_ids: ['\n'], count: 1 }), withIds({ omitted_by_policy: -1 }),
    '=== ombre:result-ids ===\n```json\n{"broken":\n```',
  ]) {
    const { adapter } = fixture(response(text));
    const observation = await adapter.search({ scope: binding.vaultScope, query: 'x' });
    assert.deepEqual(observation.resultIds, { status: 'invalid', nativeIds: [] });
    assert.equal(observation.text, text);
  }
});

test('empty IDs are valid hints; warning suffix and multiple text blocks preserve raw evidence', async () => {
  const text = withIds({ bucket_ids: [], count: 0, omitted_by_policy: 0 });
  const { adapter } = fixture({ content: [
    { type: 'text', text }, { type: 'text', text: '⚠️ 后端提示' },
  ] });
  const observed = await adapter.search({ scope: binding.vaultScope, query: 'x' });
  assert.deepEqual(observed.resultIds, { status: 'unverified', nativeIds: [], omittedByPolicy: 0 });
  assert.equal(observed.text, text + '\n⚠️ 后端提示');
});
