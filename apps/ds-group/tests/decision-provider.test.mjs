import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIDecisionProvider, createScriptDecisionProvider, validateDecision, attentionQuestion } from '../src/decision-provider.mjs';
import { ATTENTION_DEFAULTS, normalizeAttentionConfig, participationDelay } from '../src/attention.mjs';

const body = (action = 'SPEAK') => ({ model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'participation', choice: action,
  probabilities: ['LISTEN', 'WAIT', 'SPEAK'].map(value => ({ value, probability: value === action ? 1 : 0 })), confidence: 1 }],
  usage: { input_tokens: 42, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });

test('attention configuration has explicit modes, bounded timers and no unknown credential fields', () => {
  assert.equal(normalizeAttentionConfig().mode, 'mention');
  assert.equal(normalizeAttentionConfig({ mode: 'natural', batchMs: 0 }).batchMs, 0);
  for (const patch of [{ mode: 'always' }, { apiKey: 'secret' }, { waitMs: 0 }, { providerTimeoutMs: 60_001 }, { historyLimit: 101 }, { maxBotTurns: 7 }]) {
    assert.throws(() => normalizeAttentionConfig(patch));
  }
  assert.deepEqual(normalizeAttentionConfig({ mode: 'shadow' }, ATTENTION_DEFAULTS), { ...ATTENTION_DEFAULTS, mode: 'shadow' });
});

test('OpenAI adapter sends the tested dedicated Decisions contract without a main chat call or retries', async () => {
  const calls = [];
  const provider = createOpenAIDecisionProvider({ apiKey: 'synthetic-private-key', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json(body());
  } });
  const input = { self: { id: '@one:test', interests: ['摄影'] }, watermark: { sequence: 9 }, currentMessages: [{ body: '今天下班去拍照吗？' }] };
  const result = await provider.decide(input);
  assert.equal(result.action, 'SPEAK');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(calls[0].options.redirect, 'error');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(payload.input), input);
  assert.deepEqual(payload.questions, [attentionQuestion]);
  assert.equal(payload.questions[0].choices.length, 3);
  assert.deepEqual(payload.prompt_cache_options, { mode: 'explicit' });
  assert.equal(result.usage.input_tokens, 42);
  assert.equal(provider.health().health, 'ok');
  assert.equal(JSON.stringify(provider.health()).includes('synthetic-private-key'), false);
});

test('Decisions protocol routes use the configured endpoint and model instead of a fixed service', async () => {
  const calls = [];
  const model = 'company/participation-v2';
  const provider = createOpenAIDecisionProvider({ apiKey: 'synthetic-private-key', model,
    endpoint: 'http://127.0.0.1:9417/team/decisions?api-version=2', fetchImpl: async (url, options) => {
      calls.push({ url, options }); return Response.json({ ...body('LISTEN'), model });
    } });
  assert.equal(provider.model, model);
  assert.equal((await provider.decide({ roomId: '!custom:test' })).action, 'LISTEN');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:9417/team/decisions?api-version=2');
  assert.equal(JSON.parse(calls[0].options.body).model, model);
});

test('invalid Decisions endpoints and model identifiers fail before any request', () => {
  for (const endpoint of ['file:///tmp/decision', 'https://user:private@example.test/v1/decisions', 'https://example.test/decisions#fragment', null]) {
    assert.throws(() => createOpenAIDecisionProvider({ endpoint }), { code: 'INVALID_DECISION_ENDPOINT' });
  }
  for (const model of ['', 'invalid model', null, 1]) {
    assert.throws(() => createOpenAIDecisionProvider({ model }), { code: 'INVALID_DECISION_MODEL' });
  }
});

test('HTTP errors, refusal, model mismatch and malformed distributions remain system errors without leaking service text', async t => {
  const invalid = [
    { status: 429, data: { error: { message: 'synthetic-private-key' } }, code: 'ATTENTION_HTTP_429' },
    { data: { model: 'gpt-6-luna', answers: [{ name: 'participation', type: 'refusal' }] }, code: 'ATTENTION_REFUSAL' },
    { data: { ...body(), model: 'another-model' }, code: 'ATTENTION_INVALID_RESPONSE' },
    { data: { ...body(), answers: [{ ...body().answers[0], choice: 'observe' }] }, code: 'ATTENTION_INVALID_RESPONSE' },
    { data: { ...body(), answers: [{ ...body().answers[0], probabilities: [{ value: 'LISTEN', probability: 0.9 }, { value: 'WAIT', probability: 0.1 }, { value: 'WAIT', probability: 0 }] }] }, code: 'ATTENTION_INVALID_RESPONSE' },
  ];
  for (const [index, item] of invalid.entries()) await t.test(String(index), async () => {
    let calls = 0;
    const provider = createOpenAIDecisionProvider({ apiKey: 'synthetic-private-key', fetchImpl: async () => {
      calls++; return Response.json(item.data, { status: item.status || 200 });
    } });
    await assert.rejects(provider.decide({}), error => error.code === item.code && !error.message.includes('synthetic-private-key'));
    assert.equal(calls, 1);
    assert.equal(provider.health().health, 'error');
  });
  await assert.rejects(createOpenAIDecisionProvider().decide({}), { code: 'ATTENTION_PROVIDER_UNCONFIGURED' });
});

test('network error text is never forwarded as a decision or provider status', async () => {
  const provider = createOpenAIDecisionProvider({ apiKey: 'synthetic-private-key', fetchImpl: async () => { throw new Error('proxy echoed synthetic-private-key'); } });
  await assert.rejects(provider.decide({}), error => error.code === 'ATTENTION_PROVIDER_ERROR' && !error.message.includes('private'));
  assert.equal(JSON.stringify(provider.health()).includes('private'), false);
});

test('script providers are explicitly fixtures and validate the same three actions', async () => {
  const provider = createScriptDecisionProvider(async () => ({ action: 'WAIT', waitMs: 1000 }));
  assert.equal(provider.model, 'fixture');
  assert.deepEqual(await provider.decide({}), { action: 'WAIT', waitMs: 1000 });
  for (const value of [{ action: 'UNCERTAIN' }, { action: 'SPEAK', probabilities: { LISTEN: 0, WAIT: 0, SPEAK: 0.8 } }]) {
    assert.throws(() => validateDecision(value), { code: 'ATTENTION_INVALID_RESPONSE' });
  }
});

test('coordination slots depend on stable IDs and recent participation, not array order', () => {
  const participants = ['a', 'b', 'c'].map(name => ({ id: `@${name}:test`, kind: 'bot' }));
  const delay = botId => participationDelay({ botId, eventId: '$shared', participants, recentMessages: [], coordinationMs: 100 });
  assert.deepEqual(participants.map(person => delay(person.id)).sort((a, b) => a - b), [0, 100, 200]);
  assert.equal(participationDelay({ botId: participants[0].id, eventId: '$shared', participants: [...participants].reverse(), recentMessages: [], coordinationMs: 100 }), delay(participants[0].id));
  assert.equal(participationDelay({ botId: participants[0].id, eventId: '$shared', participants,
    recentMessages: [{ senderId: participants[0].id }], coordinationMs: 100 }), 200);
});
