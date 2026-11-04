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
    ledger.complete({ claimId: receipt.claimId, status: 'failed', errorCode: 'EMPTY_STREAM' });
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
