import test from 'node:test';
import assert from 'node:assert/strict';
import {isModelQuotaFailure} from '../src/model-failure.mjs';
test('exhausted quota stops work while ordinary transient rate limits remain retryable',()=>{
  assert.equal(isModelQuotaFailure({code:'QUOTA'}),true);
  assert.equal(isModelQuotaFailure({errorCode:'MODEL_QUOTA_EXCEEDED'}),true);
  assert.equal(isModelQuotaFailure(new Error('MEMORY_MODEL_error: QUOTA 429: {"type":"GoUsageLimitError"}')),true);
  assert.equal(isModelQuotaFailure({code:'RATE_LIMIT',message:'429 Too many concurrent requests'}),false);
  assert.equal(isModelQuotaFailure(undefined),false);
});
