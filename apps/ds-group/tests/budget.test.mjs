import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelBudget, ALLOWED_MODEL } from '../src/budget.mjs';

const request = { nodeId: 'finance', requestId: 'message-1', model: ALLOWED_MODEL, maxTokens: 1024 };

test('records all model attempts and enforces the selected provider', () => {
  const ledger = new ModelBudget(':memory:');
  try {
    assert.throws(() => ledger.claim({ ...request, model: 'some-other-model' }), /Only opencode/);
    const receipt = ledger.claim(request);
    assert.equal(ledger.snapshot().used, 1);
    assert.deepEqual(ledger.complete({ claimId: receipt.claimId, status: 'failed', errorCode: 'EMPTY_STREAM' }),
      { recorded: true, duplicate: false });
    assert.equal(ledger.snapshot().remaining, null);
    assert.equal(ledger.snapshot().claims[0].result.errorCode, 'EMPTY_STREAM');
    assert.equal(ledger.complete({ claimId: receipt.claimId, status: 'completed' }).duplicate, true);
    assert.equal(ledger.snapshot().claims[0].status, 'failed');
  } finally { ledger.close(); }
});

test('a configured finite limit includes failed and incomplete attempts', () => {
  const ledger = new ModelBudget(':memory:', { limit: 2, maxTokens: 1024 });
  try {
    ledger.claim(request);
    ledger.claim({ ...request, requestId: 'message-2' });
    assert.throws(() => ledger.claim({ ...request, requestId: 'message-3' }), /exhausted/);
    assert.equal(ledger.snapshot().used, 2);
    assert.equal(ledger.snapshot().remaining, 0);
  } finally { ledger.close(); }
});

test('output bounds are checked before reserving a call', () => {
  const ledger = new ModelBudget(':memory:', { limit: null, maxTokens: 4096 });
  try {
    assert.throws(() => ledger.claim({ ...request, maxTokens: 8192 }), /limit exceeded/);
    assert.equal(ledger.snapshot().used, 0);
    assert.throws(() => ledger.complete({ claimId: 'missing', status: 'completed' }), /Unknown/);
  } finally { ledger.close(); }
});

test('malformed model claims return 400 without reserving calls', () => {
  const ledger = new ModelBudget(':memory:');
  try {
    const malformed = [undefined, null, true, 1, 'claim', [], {}];
    for (const field of ['nodeId', 'requestId', 'model']) {
      for (const value of [undefined, null, '', ' ', true, 1, {}, []]) {
        malformed.push({ ...request, [field]: value });
      }
    }
    for (const maxTokens of [undefined, null, 0, -1, 1.5, true, '1024', {}, [], NaN, Infinity]) {
      malformed.push({ ...request, maxTokens });
    }
    for (const kind of [true, 1, {}, []]) malformed.push({ ...request, kind });
    for (const input of malformed) {
      assert.throws(() => ledger.claim(input), { status: 400 });
      assert.equal(ledger.snapshot().used, 0);
    }
    ledger.claim(request);
    ledger.claim({ ...request, requestId: 'message-2', kind: null });
    ledger.claim({ ...request, requestId: 'message-3', kind: 'tool-followup' });
    assert.deepEqual(ledger.snapshot().claims.map(claim => claim.kind), ['generation', 'generation', 'tool-followup']);
  } finally { ledger.close(); }
});

test('malformed completions return 400 without changing a claim', () => {
  const ledger = new ModelBudget(':memory:');
  try {
    const { claimId } = ledger.claim(request);
    const initial = ledger.snapshot();
    const malformed = [undefined, null, true, 1, 'completion', [], {}];
    for (const value of [undefined, null, '', ' ', true, 1, {}, []]) {
      malformed.push({ claimId: value, status: 'completed' });
    }
    for (const status of [undefined, null, '', true, 1, {}, [], 'claimed']) {
      malformed.push({ claimId, status });
    }
    for (const input of malformed) {
      assert.throws(() => ledger.complete(input), { status: 400 });
      assert.deepEqual(ledger.snapshot(), initial);
    }
    assert.deepEqual(ledger.complete({ claimId, status: 'completed' }), { recorded: true, duplicate: false });
  } finally { ledger.close(); }
});

for (const status of ['completed', 'failed', 'cancelled', 'unknown']) {
  test(`scoped completion preserves ownership before and after ${status}`, () => {
    const ledger = new ModelBudget(':memory:');
    try {
      const { claimId } = ledger.claim(request);
      const initial = ledger.snapshot();
      const input = { claimId, nodeId: request.nodeId, status, usage: { inputTokens: 12, outputTokens: 3 }, textBytes: 8 };
      assert.throws(() => ledger.complete(input, { nodeId: 'hr' }), { status: 403 });
      assert.deepEqual(ledger.snapshot(), initial);

      assert.deepEqual(ledger.complete(input, { nodeId: request.nodeId }), { recorded: true, duplicate: false });
      const completed = ledger.snapshot();
      assert.equal(completed.claims[0].status, status);
      assert.deepEqual(completed.claims[0].result, { usage: input.usage, textBytes: 8, errorCode: null });
      assert.throws(() => ledger.complete({ claimId, status: 'failed', errorCode: 'REPLACEMENT' }, { nodeId: 'hr' }), { status: 403 });
      assert.deepEqual(ledger.snapshot(), completed);

      assert.deepEqual(ledger.complete({ claimId }, { nodeId: request.nodeId }), { recorded: true, duplicate: true });
      assert.deepEqual(ledger.complete({ claimId, status: 'failed' }), { recorded: true, duplicate: true });
      assert.deepEqual(ledger.snapshot(), completed);
    } finally { ledger.close(); }
  });
}
