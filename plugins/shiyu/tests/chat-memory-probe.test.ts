import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CHAT_MEMORY_PROBE_MAX_TOKENS, CHAT_MEMORY_PROBE_TOOL, ChatMemoryProbeError,
  runChatMemoryRecallPhase, runChatMemoryWritePhase, validateChatMemoryProbeReceipt,
  type ChatMemoryProbeReply, type ChatMemoryRecallPorts, type ChatMemoryWritePorts,
} from '../src/control/chat-memory-probe.js';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const errorCode = (expected: string) => (error: unknown) => error instanceof ChatMemoryProbeError && error.code === expected;
const reply = (patch: Partial<ChatMemoryProbeReply> = {}): ChatMemoryProbeReply => ({
  operationId: 'reply-op-1', conversationId: 'conversation-1', status: 'ready', text: '已记住',
  sessionId: 'session-1', expectedSessionId: 'session-0', contextConfirmed: true, memoryOperationIds: [], duplicate: false, ...patch,
});
function writePorts(overrides: Partial<ChatMemoryWritePorts> = {}, state: { remembered?: { operationId: string; requestId: string; text: string }; replies?: number } = {}) {
  const calls = { remember: 0, index: 0, reply: 0 };
  const ports: ChatMemoryWritePorts = {
    now: () => '2026-11-03T00:00:00.000Z',
    async findConversation() { return { conversationId: 'conversation-1' }; },
    async remember(input) { calls.remember++; state.remembered = { operationId: 'memory-op-1', requestId: input.requestId, text: input.text }; return { operationId: 'memory-op-1', requestId: input.requestId }; },
    async index() { calls.index++; return { indexReceiptId: `index_receipt_${'a'.repeat(64)}`, effectStatus: 'succeeded', embeddingCalls: 1, usageComplete: true }; },
    async reply(input) { calls.reply++; state.replies = (state.replies ?? 0) + 1; return reply({ conversationId: input.conversationId }); },
    ...overrides,
  };
  return { ports, calls, state };
}
function recallPorts(overrides: Partial<ChatMemoryRecallPorts> = {}, options: { body?: string; reply?: ChatMemoryProbeReply; sources?: string[] } = {}) {
  const body = options.body ?? 'chat-memory-probe-write-1 SHIYU_CHAT_MEMORY_abcdef0123456789：合成事实';
  const memoryReply = options.reply ?? reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789' });
  const calls = { find: 0, read: 0, reply: 0, background: 0, withdraw: 0 };
  const ports: ChatMemoryRecallPorts = {
    now: () => '2026-11-03T00:01:00.000Z',
    async findProbeFact() { calls.find++; return { operationId: 'memory-op-1', requestId: 'chat-memory-probe-write-1', conversationId: 'conversation-1' }; },
    async readMemory() { calls.read++; return { body }; },
    async reply(input) { calls.reply++; void input; return memoryReply; },
    async withdraw() { calls.withdraw++; return { withdrawn: true }; },
    ...overrides,
  };
  return { ports, calls };
}

test('write phase writes, indexes and confirms one bounded reply in the same conversation', async () => {
  const state: { remembered?: { operationId: string; requestId: string; text: string }; replies?: number } = {};
  const { ports, calls } = writePorts({}, state);
  const receipt = await runChatMemoryWritePhase(ports);
  assert.equal(receipt.pass, true); assert.equal(receipt.phase, 'write');
  assert.equal(receipt.conversationId, 'conversation-1');
  assert.match(receipt.marker, /^SHIYU_CHAT_MEMORY_[a-f0-9]{16}$/);
  assert.equal(receipt.markerSha256, sha(receipt.marker));
  assert.equal(receipt.memory?.operationId, 'memory-op-1');
  assert.equal(receipt.index?.embeddingCalls, 1); assert.equal(receipt.index?.usageComplete, true);
  assert.equal(receipt.reply?.sameConversation, true); assert.equal(receipt.reply?.contextConfirmed, true);
  assert.equal(receipt.reply?.sha256, sha('已记住')); assert.equal(receipt.reply?.bytes, Buffer.byteLength('已记住'));
  assert.equal(receipt.sideEffects.generationModelCalls, 1); assert.equal(receipt.sideEffects.syntheticMemory, 'retained-until-recall');
  assert.equal(calls.remember, 1); assert.equal(calls.index, 1); assert.equal(calls.reply, 1);
  assert.equal(state.remembered!.text.includes(receipt.marker), true);
  assert.deepEqual(validateChatMemoryProbeReceipt(receipt), []);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt), 'utf8') <= 32768);
});

test('write phase fails honestly without generation when there is no conversation or the index is not settled', async () => {
  const none = writePorts({ async findConversation() { return undefined; } });
  await assert.rejects(runChatMemoryWritePhase(none.ports), (error: unknown) => {
    const value = error as ChatMemoryProbeError;
    return value.code === 'CHAT_MEMORY_PROBE_FAILED' && value.receipt?.reasonCode === 'NO_CONVERSATION' && value.receipt.sideEffects.generationModelCalls === 0;
  });
  assert.equal(none.calls.reply, 0);
  for (const effectStatus of ['unknown', 'failed']) {
    const fixture = writePorts({ async index() { return { effectStatus, embeddingCalls: effectStatus === 'unknown' ? null : 1, usageComplete: false }; } });
    await assert.rejects(runChatMemoryWritePhase(fixture.ports), (error: unknown) => {
      const value = error as ChatMemoryProbeError;
      return value.receipt?.reasonCode === (effectStatus === 'unknown' ? 'INDEX_UNCONFIRMED' : 'INDEX_FAILED') && value.receipt.sideEffects.generationModelCalls === 0;
    });
    assert.equal(fixture.calls.reply, 0); // no model call when indexing did not settle
  }
});

test('write phase rejects a reply from another conversation or without a confirmed native context', async () => {
  const mismatch = writePorts({ async reply(input) { return reply({ conversationId: 'conversation-2', text: '已记住' }); } });
  await assert.rejects(runChatMemoryWritePhase(mismatch.ports), (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'REPLY_CONVERSATION_MISMATCH');
  let unconfirmedReplies = 0;
  const unconfirmed = writePorts({ async reply() { unconfirmedReplies++; return reply({ contextConfirmed: false }); } });
  await assert.rejects(runChatMemoryWritePhase(unconfirmed.ports), (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'REPLY_UNCONFIRMED');
  assert.equal(unconfirmedReplies, 1);
});

test('recall phase accepts only marker + controlled memory source + same native Session, then withdraws the synthetic fact', async () => {
  const { ports, calls } = recallPorts({}, { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', sessionId: 'session-0', memoryOperationIds: ['memory-op-1'] }) });
  const receipt = await runChatMemoryRecallPhase(ports, { expectedSessionId: 'session-0' });
  assert.equal(receipt.pass, true); assert.equal(receipt.phase, 'recall');
  assert.equal(receipt.memory?.operationId, 'memory-op-1'); assert.equal(receipt.memory?.bodyMatched, true);
  assert.equal(receipt.memory?.withdrawn, true);
  assert.equal(receipt.reply?.containsMarker, true);
  assert.equal(receipt.memoryEvidence.controlled, true); assert.equal(receipt.memoryEvidence.source, 'reply-memory-sources');
  assert.equal(receipt.session.sameSession, true); assert.equal(receipt.session.evidence, 'explicit-expected-session');
  assert.equal(receipt.sideEffects.generationModelCalls, 1); assert.equal(receipt.sideEffects.syntheticMemory, 'withdrawn');
  assert.equal(calls.reply, 1); assert.equal(calls.withdraw, 1);
  assert.deepEqual(validateChatMemoryProbeReceipt(receipt), []);
});

test('recall phase distinguishes a model echo from controlled memory recall', async () => {
  // Model text contains the marker but no controlled memory source and no fallback.
  const echo = recallPorts({}, { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', sessionId: 'session-0', memoryOperationIds: [] }) });
  await assert.rejects(runChatMemoryRecallPhase(echo.ports, { expectedSessionId: 'session-0' }), (error: unknown) => {
    const value = error as ChatMemoryProbeError;
    return value.receipt?.reasonCode === 'REPLY_WITHOUT_CONTROLLED_MEMORY_SOURCE' && (value.receipt as { memoryEvidence?: { controlled?: boolean } }).memoryEvidence?.controlled === false;
  });
  assert.equal(echo.calls.withdraw, 0);
  // Controlled background load can supply the missing proof without another generation.
  const background = recallPorts({ async backgroundMemoryEvidence() { return { memoryOperationIds: ['memory-op-1'] }; } },
    { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', sessionId: 'session-0', memoryOperationIds: [] }) });
  const receipt = await runChatMemoryRecallPhase(background.ports, { expectedSessionId: 'session-0' });
  assert.equal(receipt.pass, true); assert.equal(receipt.memoryEvidence.source, 'background-load');
  assert.equal(receipt.memoryEvidence.operationIds.includes('memory-op-1'), true);
  assert.equal(background.calls.withdraw, 1);
});

test('recall phase fails honestly on marker miss, session mismatch, missing session evidence and no probe fact', async () => {
  const markerMiss = recallPorts({}, { reply: reply({ text: '我不知道', sessionId: 'session-0' }) });
  await assert.rejects(runChatMemoryRecallPhase(markerMiss.ports, { expectedSessionId: 'session-0' }),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'REPLY_MARKER_MISSING');
  const sessionMismatch = recallPorts({}, { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', sessionId: 'session-9', memoryOperationIds: ['memory-op-1'] }) });
  await assert.rejects(runChatMemoryRecallPhase(sessionMismatch.ports, { expectedSessionId: 'session-0' }),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'SESSION_MISMATCH');
  assert.equal(sessionMismatch.calls.withdraw, 0);
  const noSession = recallPorts({}, { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', memoryOperationIds: ['memory-op-1'] }) });
  await assert.rejects(runChatMemoryRecallPhase(noSession.ports),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'SESSION_EVIDENCE_MISSING');
  const noFact = recallPorts({ async findProbeFact() { return undefined; } });
  await assert.rejects(runChatMemoryRecallPhase(noFact.ports, { expectedSessionId: 'session-0' }),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'NO_PROBE_FACT');
  assert.equal(noFact.calls.reply, 0); // no generation when nothing was written
});

test('recall never crosses conversation boundaries even if a port offers another fact', async () => {
  const { ports, calls } = recallPorts({}, { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', sessionId: 'session-0', memoryOperationIds: ['memory-op-1'] }) });
  await assert.rejects(runChatMemoryRecallPhase(ports, { expectedSessionId: 'session-0', conversationId: 'conversation-other' }),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'NO_PROBE_FACT');
  assert.equal(calls.read, 0); assert.equal(calls.reply, 0);
});

test('recall phase reports an unreadable body without inventing a memory hit', async () => {
  const { ports, calls } = recallPorts({}, { body: 'chat-memory-probe-write-1 已无 marker 正文' });
  await assert.rejects(runChatMemoryRecallPhase(ports, { expectedSessionId: 'session-0' }),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'FACT_NOT_READABLE');
  assert.equal(calls.reply, 0); assert.equal(calls.withdraw, 0);
});

test('receipts are bounded, lossless and reject tampering or reply-body leakage', async () => {
  const { ports } = recallPorts({}, { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', sessionId: 'session-0', memoryOperationIds: ['memory-op-1'] }) });
  const receipt = await runChatMemoryRecallPhase(ports, { expectedSessionId: 'session-0' });
  const serialized = JSON.stringify(receipt);
  assert.deepEqual(JSON.parse(serialized), receipt);
  const replyValue = receipt.reply as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(replyValue).sort(), ['bytes', 'containsMarker', 'contextConfirmed', 'operationId', 'sessionId', 'sha256', 'status']);
  assert.equal(typeof replyValue.text, 'undefined');
  assert.deepEqual(validateChatMemoryProbeReceipt(receipt), []);
  const tampered = structuredClone(receipt) as unknown as Record<string, unknown>; tampered.marker = 'SHIYU_CHAT_MEMORY_0000000000000000';
  assert.equal(validateChatMemoryProbeReceipt(tampered).some(item => item.startsWith('markerSha256')), true);
  const failedCheck = structuredClone(receipt); (failedCheck.checks[0] as { status: string }).status = 'failed';
  assert.equal(validateChatMemoryProbeReceipt(failedCheck).some(item => item.startsWith('checks')), true);
  assert.equal(validateChatMemoryProbeReceipt(structuredClone(receipt), 64).some(item => item.includes('exceeds')), true);
});

test('write and recall phases enforce the 256-token cap and never issue more than one generation each', async () => {
  const write = writePorts();
  await assert.rejects(runChatMemoryWritePhase(write.ports, { maxTokens: CHAT_MEMORY_PROBE_MAX_TOKENS + 1 }),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'INVALID_OPTIONS');
  assert.equal(write.calls.reply, 0);
  const { ports } = recallPorts({}, { reply: reply({ text: 'SHIYU_CHAT_MEMORY_abcdef0123456789', sessionId: 'session-0', memoryOperationIds: ['memory-op-1'] }) });
  await assert.rejects(runChatMemoryRecallPhase(ports, { expectedSessionId: 'session-0', maxTokens: 300 }),
    (error: unknown) => (error as ChatMemoryProbeError).receipt?.reasonCode === 'INVALID_OPTIONS');
});

test('abort/deadline are explicit and do not retry', async () => {
  const write = writePorts();
  await assert.rejects(runChatMemoryWritePhase(write.ports, { signal: AbortSignal.abort() }), (error: unknown) => Boolean(error));
  assert.equal(write.calls.reply, 0);
  const deadline = writePorts();
  let tick = 0;
  const now = () => new Date(Date.parse('2026-11-03T00:00:00.000Z') + (tick++) * 5000);
  await assert.rejects(runChatMemoryWritePhase(deadline.ports, { deadlineMs: 1, now }), (error: unknown) => Boolean(error));
  assert.equal(deadline.calls.reply, 0);
});
