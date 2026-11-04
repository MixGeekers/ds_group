import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertModelTransportAdmission, assertModelTransportDiagnosticReceipt, classifyModelTransport, diagnoseModelTransport,
  ModelTransportDiagnosticError, MODEL_TRANSPORT_MODEL, MODEL_TRANSPORT_PROMPT_SHA256,
  type ModelTransportObservation, type ModelTransportRequest,
} from '../src/control/model-transport-diagnostic.js';

const fake = (observation: Partial<ModelTransportObservation> & Record<string, unknown> = {}) => {
  let calls = 0; const requests: ModelTransportRequest[] = [];
  return { get calls() { return calls; }, requests,
    transport: { async run(request: ModelTransportRequest) { calls++; requests.push(request);
      return { chunks: 1, textBytes: 2, textSha256: 'a'.repeat(64), usage: { status: 'unknown' as const },
        abortedBeforeFirstChunk: false, abortedAfterFirstChunk: false, timedOut: false, toolCount: 0, messageCount: 1,
        ...observation } as ModelTransportObservation; } } };
};
const options = (observation: Partial<ModelTransportObservation> & Record<string, unknown> = {}) => {
  const f = fake(observation); return { f, value: { transport: f.transport } };
};

test('an ok transport records text sha/bytes/chunks/usage but never the prompt or response text', async () => {
  const { f, value } = options({ chunks: 3, textBytes: 2, textSha256: 'b'.repeat(64), usage: { status: 'reported', tokens: 7 } });
  const receipt = await diagnoseModelTransport(value);
  assert.equal(receipt.status, 'ok'); assert.equal(receipt.ok, true); assert.equal(receipt.realModelCall, true);
  assert.equal(receipt.automaticRetry, false); assert.equal(receipt.businessPass, false); assert.equal(receipt.chatPass, false);
  assert.equal(receipt.result.chunks, 3); assert.equal(receipt.result.textBytes, 2); assert.equal(receipt.result.textSha256, 'b'.repeat(64));
  assert.deepEqual(receipt.result.usage, { status: 'reported', tokens: 7 });
  assert.equal(receipt.request.promptSha256, MODEL_TRANSPORT_PROMPT_SHA256);
  assert.equal(receipt.request.provider, MODEL_TRANSPORT_MODEL.provider); assert.equal(receipt.request.maxTokens, 8);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('Reply with the single word OK.'), false);
  assert.equal(serialized.includes('b'.repeat(64)), true);
  assert.equal(f.calls, 1, 'exactly one model call and no retry');
  assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('an empty provider stream is classified as empty-provider-stream and never as ok', async () => {
  const { value } = options({ chunks: 0, textBytes: 0, textSha256: undefined });
  const receipt = await diagnoseModelTransport(value);
  assert.equal(receipt.status, 'empty-provider-stream'); assert.equal(receipt.ok, false);
  assert.equal(receipt.result.chunks, 0); assert.equal(receipt.result.textBytes, 0);
  assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('a transport error with a controlled code is classified as transport without leaking path/body', async () => {
  const { value } = options({ chunks: 0, textBytes: 0, textSha256: undefined,
    error: Object.assign(new Error('socket reset /synthetic/hidden.pem TOP_SECRET_RESPONSE'), { code: 'ECONNRESET' }) });
  const receipt = await diagnoseModelTransport(value);
  assert.equal(receipt.status, 'transport'); assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, 'ECONNRESET'); assert.equal(receipt.error?.category, 'transport');
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('/synthetic'), false); assert.equal(serialized.includes('TOP_SECRET'), false);
  assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('an error without a code stays unknown and redacts its raw text', async () => {
  const { value } = options({ chunks: 0, textBytes: 0, textSha256: undefined,
    error: new Error('mystery provider failure TOP_SECRET_PROMPT /synthetic/core/hidden.txt') });
  const receipt = await diagnoseModelTransport(value);
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, 'NONE');
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('/synthetic'), false); assert.equal(serialized.includes('TOP_SECRET'), false);
  assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('auth and request-shape classifications are derived only from controlled codes', async () => {
  const auth = await diagnoseModelTransport(options({ chunks: 0, textBytes: 0, textSha256: undefined,
    error: Object.assign(new Error('forbidden'), { code: '401' }) }).value);
  assert.equal(auth.status, 'auth');
  const shape = await diagnoseModelTransport(options({ chunks: 0, textBytes: 0, textSha256: undefined,
    error: Object.assign(new Error('invalid request'), { code: '422' }) }).value);
  assert.equal(shape.status, 'request-shape');
  for (const receipt of [auth, shape]) assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('abort before/after the first chunk and timeout keep distinct classifications', async () => {
  const before = await diagnoseModelTransport(options({ chunks: 0, textBytes: 0, textSha256: undefined,
    abortedBeforeFirstChunk: true }).value);
  assert.equal(before.status, 'aborted'); assert.equal(before.checks.includes('aborted-before-first-chunk'), true);
  const after = await diagnoseModelTransport(options({ chunks: 2, textBytes: 2, textSha256: 'c'.repeat(64),
    abortedAfterFirstChunk: true, abortedBeforeFirstChunk: false }).value);
  assert.equal(after.status, 'aborted'); assert.equal(after.checks.includes('aborted-after-first-chunk'), true);
  const timeout = await diagnoseModelTransport(options({ chunks: 0, textBytes: 0, textSha256: undefined, timedOut: true }).value);
  assert.equal(timeout.status, 'timeout'); assert.equal(timeout.checks.includes('deadline-expired'), true);
  for (const receipt of [before, after, timeout]) assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('missing usage is recorded as unknown and never zero-padded', async () => {
  const { value } = options({ chunks: 1, textBytes: 2, textSha256: 'd'.repeat(64), usage: { status: 'unknown' } });
  const receipt = await diagnoseModelTransport(value);
  assert.deepEqual(receipt.result.usage, { status: 'unknown' });
  assert.equal((receipt.result.usage as { tokens?: number }).tokens, undefined);
  assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('the receipt validator rejects unbounded, leaked-text and inconsistent mutations', async () => {
  const { value } = options({ chunks: 2, textBytes: 2, textSha256: 'e'.repeat(64), usage: { status: 'reported', tokens: 3 } });
  const receipt = await diagnoseModelTransport(value);
  const mutations: ((copy: Record<string, unknown>) => void)[] = [
    copy => { copy.status = 'invented'; },
    copy => { copy.ok = false; },
    copy => { (copy.result as Record<string, unknown>).textBytes = 10; delete (copy.result as Record<string, unknown>).textSha256; },
    copy => { (copy.result as Record<string, unknown>).textSha256 = 'prompt/body/leak'; },
    copy => { (copy.request as Record<string, unknown>).maxTokens = 9; },
    copy => { copy.error = { category: 'transport', code: 'ECONNRESET', name: 'Error', label: 'a/b' }; },
    copy => { copy.realModelCall = false; },
    copy => { copy.checks = ['x'.repeat(400)]; },
  ];
  for (const mutate of mutations) {
    const copy = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
    mutate(copy);
    assert.throws(() => assertModelTransportDiagnosticReceipt(copy));
  }
  assert.doesNotThrow(() => assertModelTransportDiagnosticReceipt(receipt));
});

test('the owner-command admission helper enforces pause, single slot and capacity', () => {
  assert.doesNotThrow(() => assertModelTransportAdmission({ paused: false, operations: 0, capacity: 1, sameActionRunning: false }));
  assert.throws(() => assertModelTransportAdmission({ paused: true, operations: 0, capacity: 1, sameActionRunning: false }),
    (error: unknown) => error instanceof ModelTransportDiagnosticError && error.code === 'MODEL_TRANSPORT_PAUSED');
  assert.throws(() => assertModelTransportAdmission({ paused: false, operations: 0, capacity: 1, sameActionRunning: true }),
    (error: unknown) => error instanceof ModelTransportDiagnosticError && error.code === 'MODEL_TRANSPORT_BUSY');
  assert.throws(() => assertModelTransportAdmission({ paused: false, operations: 1, capacity: 1, sameActionRunning: false }),
    (error: unknown) => error instanceof ModelTransportDiagnosticError && error.code === 'MODEL_TRANSPORT_CAPACITY');
});

test('classification is a pure controlled function and only ok requires non-empty assistant text', () => {
  const base = { usage: { status: 'unknown' as const }, abortedBeforeFirstChunk: false, abortedAfterFirstChunk: false,
    timedOut: false, toolCount: 0, messageCount: 1 };
  assert.equal(classifyModelTransport({ ...base, chunks: 0, textBytes: 0 }), 'empty-provider-stream');
  assert.equal(classifyModelTransport({ ...base, chunks: 2, textBytes: 3, textSha256: 'f'.repeat(64) }), 'ok');
  assert.equal(classifyModelTransport({ ...base, chunks: 2, textBytes: 0 }), 'unknown');
  assert.equal(classifyModelTransport({ ...base, chunks: 1, textBytes: 2, textSha256: 'f'.repeat(64),
    error: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }), 'transport');
  assert.equal(classifyModelTransport({ ...base, chunks: 1, textBytes: 2, textSha256: 'f'.repeat(64),
    error: Object.assign(new Error('bad'), { code: '401' }) }), 'auth');
});
