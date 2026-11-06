import test from 'node:test';
import assert from 'node:assert/strict';
import { isContextOverflow } from '../vendor/ds-bot/src/host/context-failure.js';

test('the real provider 400 with an oversized input triggers native overflow recovery', () => {
  const failure = { code: 'INVALID_REQUEST', message: '400: {"type":"invalid_request_error","code":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] Input too long: model limit 1048576 tokens, requested 1258377 tokens"}' };
  assert.equal(isContextOverflow(failure), true);
  assert.equal(isContextOverflow({ code: 'CONTEXT_WINDOW_EXCEEDED' }), true);
  assert.equal(isContextOverflow({ code: 'INVALID_REQUEST', message: 'Input too long: model limit 1,048,576 tokens, requested 1,258,377 tokens' }), true);
});

test('ordinary invalid requests and ambiguous size errors do not discard the active part', () => {
  for (const failure of [
    undefined,
    { code: 'INVALID_REQUEST', message: 'Invalid tool result id' },
    { code: 'INVALID_REQUEST', message: 'Input too long' },
    { code: 'AUTHENTICATION_ERROR', message: 'Input too long: model limit 10 tokens, requested 20 tokens' },
    { code: 'INVALID_REQUEST', message: 'Input too long: model limit 0 tokens, requested 20 tokens' },
    { code: 'INVALID_REQUEST', message: 'Input too long: model limit 10 tokens, requested 10 tokens' },
  ]) assert.equal(isContextOverflow(failure), false);
});
