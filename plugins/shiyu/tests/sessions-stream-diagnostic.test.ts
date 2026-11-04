import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReplyGenerationFailure, ReplyStreamDiagnosticError, replyFailureReasonCode, replyGenerationFacts,
  replyStreamDiagnosticFromGeneration, replyStreamDiagnosticOf, validateReplyStreamDiagnostic,
  type ReplyGenerationFacts, type ReplyStreamDiagnostic,
} from '../src/control/local-reply-stream-diag.js';

const facts = (patch: Partial<ReplyGenerationFacts> = {}): ReplyGenerationFacts =>
  ({ chunks: 0, attemptStreamLengths: [], assistantMessages: 0, firstChunkSeen: false, ...patch });
const diagnostic = (patch: Partial<ReplyStreamDiagnostic> = {}): ReplyStreamDiagnostic => ({
  category: 'empty-provider-stream', code: 'NONE', name: 'Error', chunks: 0, attemptStreamLengths: [], assistantMessages: 0,
  abortedBeforeFirstChunk: false, abortedAfterFirstChunk: false, timedOut: false, label: 'empty-provider-stream',
  elapsedMs: 10, ...patch });
const generation = (error: unknown, patch: Partial<Parameters<typeof replyStreamDiagnosticFromGeneration>[0]> = {}) =>
  replyStreamDiagnosticFromGeneration({ error, facts: facts(), timedOut: false, externallyAborted: false, operationAborted: false, ...patch });

test('an observed empty provider stream is classified as empty-provider-stream with a bounded reason', () => {
  const value = generation(new Error('Context-safe reply cancelled or expired'), { turnError: 'Context-safe reply cancelled or expired', elapsedMs: 25 });
  assert.equal(value.category, 'empty-provider-stream');
  assert.equal(value.chunks, 0); assert.deepEqual(value.attemptStreamLengths, []);
  assert.equal(value.code, 'NONE'); assert.equal(value.name, 'Error');
  assert.equal(value.label, 'empty-provider-stream'); assert.equal(value.elapsedMs, 25);
  assert.equal(replyFailureReasonCode(value), 'REPLY_EMPTY_PROVIDER_STREAM');
  assert.deepEqual(validateReplyStreamDiagnostic(value), value);
});

test('facts are extracted only from bounded native event counters', () => {
  const extracted = replyGenerationFacts([{ type: 'assistant/attempt', data: { streamLength: 0 } },
    { type: 'assistant/attempt', data: { streamLength: 7 } }, { type: 'assistant/message', data: {} },
    { type: 'assistant/attempt', data: { streamLength: -1 } }, { type: 'assistant/attempt', data: { streamLength: 99_999_999 } }]);
  assert.equal(extracted.assistantMessages, 1);
  assert.deepEqual(extracted.attemptStreamLengths, [0, 7, 0]);
});

test('controlled error codes/names map transport, auth, request-shape and timeout without guessing provider internals', () => {
  const transport = generation(Object.assign(new Error('socket closed'), { code: 'ECONNRESET', name: 'Error' }));
  assert.equal(transport.category, 'transport'); assert.equal(transport.code, 'ECONNRESET'); assert.equal(replyFailureReasonCode(transport), 'REPLY_TRANSPORT');
  const auth = generation(Object.assign(new Error('forbidden'), { code: 'HTTP_401' }));
  assert.equal(auth.category, 'auth'); assert.equal(replyFailureReasonCode(auth), 'REPLY_AUTH');
  const shape = generation(Object.assign(new Error('invalid schema'), { code: 'HTTP_422' }));
  assert.equal(shape.category, 'request-shape'); assert.equal(replyFailureReasonCode(shape), 'REPLY_REQUEST_SHAPE');
  const timeout = generation(Object.assign(new Error('deadline exceeded'), { code: 'ETIMEDOUT' }), { timedOut: true });
  assert.equal(timeout.category, 'timeout'); assert.equal(replyFailureReasonCode(timeout), 'REPLY_TIMEOUT');
  const unknown = generation(Object.assign(new Error('mysterious'), { code: 'WEIRD' }), { facts: facts({ chunks: 3, firstChunkSeen: true }) });
  assert.equal(unknown.category, 'unknown'); assert.equal(replyFailureReasonCode(unknown), 'REPLY_FAILED');
});

test('abort before and after the first chunk are distinct; timeout wins over abort', () => {
  const before = generation(new Error('aborted'), { facts: facts(), operationAborted: true });
  assert.equal(before.category, 'aborted-before-first-chunk'); assert.equal(before.abortedBeforeFirstChunk, true); assert.equal(before.abortedAfterFirstChunk, false);
  assert.equal(replyFailureReasonCode(before), 'REPLY_ABORTED_BEFORE_FIRST_CHUNK');
  const after = generation(new Error('aborted'), { facts: facts({ chunks: 2, firstChunkSeen: true }), externallyAborted: true });
  assert.equal(after.category, 'aborted-after-first-chunk'); assert.equal(after.abortedBeforeFirstChunk, false); assert.equal(after.abortedAfterFirstChunk, true);
  assert.equal(replyFailureReasonCode(after), 'REPLY_ABORTED_AFTER_FIRST_CHUNK');
  const timeout = generation(new Error('deadline'), { facts: facts({ chunks: 2, firstChunkSeen: true }), operationAborted: true, timedOut: true });
  assert.equal(timeout.category, 'timeout'); assert.equal(timeout.abortedAfterFirstChunk, true);
});

test('diagnostics never retain provider messages, prompts, paths, keys or tool arguments', () => {
  const secretMessage = 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz /Users/caja/prompt.txt tool_call={"secret":"x"} MODEL_BODY_LEAK';
  const value = generation(Object.assign(new Error(secretMessage), { code: 'ECONNRESET' }), { turnError: secretMessage });
  assert.equal(value.category, 'auth');
  const serialized = JSON.stringify(value);
  for (const secret of ['Bearer', 'sk-abcdefghijklmnopqrstuvwxyz', '/Users/caja', 'prompt.txt', 'secret', 'MODEL_BODY_LEAK']) {
    assert.equal(serialized.includes(secret), false, `diagnostic leaked ${secret}`);
  }
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 400);
  assert.equal(value.label, 'auth:ECONNRESET');
});

test('the validator rejects mutations, oversized fields, unknown keys and path/secret echoes', () => {
  const good = diagnostic();
  assert.deepEqual(validateReplyStreamDiagnostic(good), good);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.category = 'bogus'; },
    (value: Record<string, unknown>) => { value.extra = true; },
    (value: Record<string, unknown>) => { value.chunks = -1; },
    (value: Record<string, unknown>) => { value.attemptStreamLengths = Array(9).fill(0); },
    (value: Record<string, unknown>) => { value.label = '/Users/caja/secret'; },
    (value: Record<string, unknown>) => { value.assistantMessages = 1001; },
  ]) {
    const tampered = structuredClone(good) as unknown as Record<string, unknown>; mutate(tampered);
    assert.throws(() => validateReplyStreamDiagnostic(tampered), ReplyStreamDiagnosticError);
  }
  assert.throws(() => validateReplyStreamDiagnostic({ ...good, extra: true }), /Unknown diagnostic field/);
});

test('replyStreamDiagnosticOf only trusts a valid embedded diagnostic and never invents one', () => {
  const value = diagnostic();
  const failure = new ReplyGenerationFailure('generation failed', value, { cause: new Error('provider body') });
  assert.deepEqual(replyStreamDiagnosticOf(failure), value);
  assert.equal(replyStreamDiagnosticOf(new Error('plain')), undefined);
  const tampered = new ReplyGenerationFailure('bad', { ...value, category: 'bogus' } as unknown as ReplyStreamDiagnostic);
  assert.equal(replyStreamDiagnosticOf(tampered), undefined);
});
