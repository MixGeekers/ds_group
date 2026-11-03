/**
 * P0 round-18: two-phase, owner-only single-user chat-memory verification.
 *
 * phase=write: writes one synthetic `chat-memory-probe-*` fact to an existing
 * local conversation, indexes it with the real local embedding backend and
 * issues exactly one local reply turn (<=256 tokens). phase=recall (normally
 * after an ordered reload): finds the most recent synthetic probe fact, reads
 * its body, issues exactly one second local reply turn asking the model to repeat
 * that fact, and requires BOTH the marker text AND a controlled memory-source
 * receipt for the same operation. A model reply that merely repeats the marker
 * from native session history is deliberately not accepted as memory recall.
 *
 * The module performs no I/O itself: every operation comes from trusted ports
 * supplied by the runtime patch. It never retries and never starts extra model
 * calls; the recall phase may perform one zero-generation background-load read
 * only if the reply itself did not expose memory sources.
 */
import { createHash, randomUUID } from 'node:crypto';
export const CHAT_MEMORY_PROBE_SCHEMA_VERSION = 1;
export const CHAT_MEMORY_PROBE_TOOL = 'shiyu_verify_single_user_chat_memory';
export const CHAT_MEMORY_PROBE_ACTION = 'runtime.probe-single-user-chat-memory';
export const CHAT_MEMORY_PROBE_PREFIX = 'chat-memory-probe-';
export const CHAT_MEMORY_MARKER_PREFIX = 'SHIYU_CHAT_MEMORY_';
export const CHAT_MEMORY_PROBE_MAX_TOKENS = 256;
export const CHAT_MEMORY_PROBE_MAX_BYTES = 32768;
const MARKER = /^SHIYU_CHAT_MEMORY_[a-f0-9]{16}$/;
const REQUEST_PREFIX = 'chat-memory-probe-write-';
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const bounded = (value: unknown, max = 300): string => String(value).replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
const clone = <T>(value: T): T => structuredClone(value);
export type ChatMemoryProbePhase = 'write' | 'recall';
export type ChatMemoryProbeReason =
  | 'NO_CONVERSATION' | 'REMEMBER_FAILED' | 'INDEX_FAILED' | 'INDEX_UNCONFIRMED'
  | 'REPLY_FAILED' | 'REPLY_CONVERSATION_MISMATCH' | 'REPLY_UNCONFIRMED'
  | 'NO_PROBE_FACT' | 'FACT_NOT_READABLE' | 'REPLY_MARKER_MISSING'
  | 'REPLY_WITHOUT_CONTROLLED_MEMORY_SOURCE' | 'SESSION_EVIDENCE_MISSING' | 'SESSION_MISMATCH'
  | 'TIMEOUT' | 'ABORTED' | 'INVALID_OPTIONS' | null;
export interface ChatMemoryProbeReply {
  operationId: string; conversationId: string; status: string;
  text: string; sessionId: string; expectedSessionId?: string;
  contextConfirmed: boolean; memoryOperationIds: string[]; duplicate: boolean;
}
export interface ChatMemoryProbeIndexReceipt {
  indexReceiptId?: string;
  effectStatus?: string;
  embeddingCalls?: number | null;
  usageComplete?: boolean;
}
export interface ChatMemoryWritePorts {
  now(): string;
  findConversation(): Promise<{ conversationId: string } | undefined>;
  remember(input: { requestId: string; conversationId: string; text: string }): Promise<{ operationId: string; requestId: string; canRead?: boolean }>;
  index(input: { requestId: string; operationId: string }): Promise<ChatMemoryProbeIndexReceipt>;
  reply(input: { conversationId: string; inputId: string; text: string; maxTokens: number }): Promise<ChatMemoryProbeReply>;
}
export interface ChatMemoryRecallPorts {
  now(): string;
  findProbeFact(): Promise<{ operationId: string; requestId: string; conversationId: string } | undefined>;
  readMemory(input: { operationId: string }): Promise<{ body: string }>;
  reply(input: { conversationId: string; inputId: string; text: string; maxTokens: number }): Promise<ChatMemoryProbeReply>;
  /** Zero-generation controlled load used only when a reply exposes no memory sources. */
  backgroundMemoryEvidence?(input: { conversationId: string; text: string }): Promise<{ memoryOperationIds: string[] } | undefined>;
  withdraw(input: { requestId: string; operationId: string }): Promise<unknown>;
}
export interface ChatMemoryProbeStep { step: string; status: 'passed' | 'failed' | 'skipped'; detail?: string }
export interface ChatMemoryProbeCheck { check: string; status: 'passed' | 'failed'; expected: string; observed: string }
interface ReceiptBase {
  schemaVersion: 1; toolName: typeof CHAT_MEMORY_PROBE_TOOL; phase: ChatMemoryProbePhase;
  pass: boolean; reasonCode: ChatMemoryProbeReason; capturedAt: string;
  marker: string; markerSha256: string;
  checks: ChatMemoryProbeCheck[]; steps: ChatMemoryProbeStep[];
  sideEffects: { generationModelCalls: number; syntheticMemory: 'retained-until-recall' | 'withdrawn'; withdrawAttempted: boolean };
}
export interface ChatMemoryWriteReceipt extends ReceiptBase {
  phase: 'write'; conversationId: string | null;
  memory: { operationId: string | null; requestId: string | null } | null;
  index: ChatMemoryProbeIndexReceipt | null;
  reply: { operationId: string | null; sha256: string | null; bytes: number | null; status: string | null; sessionId: string | null;
    sameConversation: boolean; contextConfirmed: boolean } | null;
}
export interface ChatMemoryRecallReceipt extends ReceiptBase {
  phase: 'recall'; conversationId: string | null;
  memory: { operationId: string | null; requestId: string | null; bodyMatched: boolean; withdrawn: boolean; withdrawalCode?: string } | null;
  reply: { operationId: string | null; sha256: string | null; bytes: number | null; status: string | null; sessionId: string | null;
    containsMarker: boolean; contextConfirmed: boolean } | null;
  memoryEvidence: { controlled: boolean; source: 'reply-memory-sources' | 'background-load' | 'none'; operationIds: string[] };
  session: { expectedSessionId: string | null; recallSessionId: string | null; sameSession: boolean | null;
    evidence: 'explicit-expected-session' | 'none' };
}
export type ChatMemoryProbeReceipt = ChatMemoryWriteReceipt | ChatMemoryRecallReceipt;
export type ChatMemoryProbeErrorCode =
  | 'CHAT_MEMORY_PROBE_INPUT' | 'CHAT_MEMORY_PROBE_BUSY' | 'CHAT_MEMORY_PROBE_PAUSED' | 'CHAT_MEMORY_PROBE_CLOSED'
  | 'CHAT_MEMORY_PROBE_FAILED' | 'CHAT_MEMORY_PROBE_INVALID';
export class ChatMemoryProbeError extends Error {
  constructor(readonly code: ChatMemoryProbeErrorCode, message: string, readonly receipt?: ChatMemoryProbeReceipt) { super(message); this.name = 'ChatMemoryProbeError'; }
}
export interface ChatMemoryProbeOptions {
  signal?: AbortSignal; deadlineMs?: number; now?: () => Date; maxTokens?: number;
  expectedSessionId?: string; conversationId?: string;
}
const validMarker = (value: string): boolean => MARKER.test(value);
const extractMarker = (text: string): string | undefined => (text.match(/SHIYU_CHAT_MEMORY_[a-f0-9]{16}/) ?? [undefined])[0];
const check = (checks: ChatMemoryProbeCheck[], name: string, condition: boolean, expected: string, observed: unknown): boolean => {
  checks.push({ check: name, status: condition ? 'passed' : 'failed', expected: bounded(expected), observed: bounded(observed) });
  return condition;
};
const alive = (options: ChatMemoryProbeOptions, deadline: number): void => {
  options.signal?.throwIfAborted();
  if (Date.parse((options.now?.() ?? new Date()).toISOString()) > deadline) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', 'Chat memory probe deadline exceeded');
};
const receiptBytes = (receipt: ChatMemoryProbeReceipt): number => bytes(JSON.stringify(receipt));
export function validateChatMemoryProbeReceipt(receipt: unknown, maxBytes = CHAT_MEMORY_PROBE_MAX_BYTES): string[] {
  const violations: string[] = [];
  const fail = (path: string, message: string): void => { violations.push(`${path}: ${message}`); };
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['$: expected plain object'];
  let serialized: string;
  try { serialized = JSON.stringify(receipt); } catch { return ['$: not lossless JSON']; }
  if (JSON.stringify(JSON.parse(serialized)) !== serialized) fail('$', 'not lossless JSON');
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) fail('$', `receipt exceeds ${maxBytes} bytes`);
  const value = receipt as Record<string, unknown>;
  if (value.schemaVersion !== CHAT_MEMORY_PROBE_SCHEMA_VERSION) fail('schemaVersion', 'unsupported schema');
  if (value.toolName !== CHAT_MEMORY_PROBE_TOOL) fail('toolName', 'unexpected tool');
  if (value.phase !== 'write' && value.phase !== 'recall') fail('phase', 'invalid phase');
  if (typeof value.pass !== 'boolean') fail('pass', 'must be boolean');
  if (typeof value.marker !== 'string' || !validMarker(value.marker)) fail('marker', 'invalid synthetic marker');
  if (value.markerSha256 !== sha(String(value.marker))) fail('markerSha256', 'marker hash mismatch');
  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 24) fail('checks', 'bounded non-empty checks required');
  if (!Array.isArray(value.steps) || value.steps.length > 24) fail('steps', 'bounded steps required');
  if (value.pass === true && (value.checks as { status: string }[]).some(item => item.status !== 'passed')) fail('checks', 'passing receipt has a failed check');
  const sideEffects = value.sideEffects as Record<string, unknown> | undefined;
  if (!sideEffects || typeof sideEffects.generationModelCalls !== 'number' || !Number.isSafeInteger(sideEffects.generationModelCalls)
    || sideEffects.generationModelCalls < 0 || sideEffects.generationModelCalls > 1) fail('sideEffects.generationModelCalls', '0..1 per phase');
  if (receiptBytes(receipt as ChatMemoryProbeReceipt) > maxBytes) fail('$', 'receipt exceeds bound');
  return violations;
}
export function singleUserChatMemoryProbeTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: CHAT_MEMORY_PROBE_TOOL,
    description: '两阶段 owner-only 单用户聊天记忆探针（真实本地回复，每次 ≤256 tokens、0 重试）：write 在现有本地 conversation 写入合成 marker 事实并索引后发起 1 次回复确认（保留合成记忆待 recall）；recall（通常由宿主在 write→有序 reload 后执行）查找最近 chat-memory-probe-* 事实、读正文并发起第 2 次回复要求只复述该事实；严格 oracle 同时要求回复含 marker、受控 memorySources（或零生成背景加载）含该 operationId、same native SessionId 复用；失败如实返回 reason；recall 成功后撤回合成记忆并披露。owner-only 命令参数 phase=write|recall，可选 expectedSessionId（write receipt 给出）与 conversationId；不调用其他模型/embedding 额外操作。',
    parameters: { type: 'object', properties: { phase: { type: 'string', enum: ['write', 'recall'] },
      expectedSessionId: { type: 'string' }, conversationId: { type: 'string' } }, required: ['phase'], additionalProperties: false },
    isConcurrencySafe: false,
    execute: async (args: { phase?: unknown; expectedSessionId?: unknown; conversationId?: unknown }) => service.command({ action: CHAT_MEMORY_PROBE_ACTION,
      ...(args && typeof args === 'object' ? { phase: args.phase, ...(args.expectedSessionId === undefined ? {} : { expectedSessionId: args.expectedSessionId }),
        ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }) } : {}) }),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
  };
}
/* ------------------------------------------------------------------ write */
export async function runChatMemoryWritePhase(ports: ChatMemoryWritePorts, options: ChatMemoryProbeOptions = {}): Promise<ChatMemoryWriteReceipt> {
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const deadline = Date.parse(startedAt) + (options.deadlineMs ?? 60000);
  const marker = `${CHAT_MEMORY_MARKER_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const requestId = `${REQUEST_PREFIX}${randomUUID()}`;
  const checks: ChatMemoryProbeCheck[] = [], steps: ChatMemoryProbeStep[] = [];
  const make = (patch: Partial<ChatMemoryWriteReceipt>): ChatMemoryWriteReceipt => ({
    schemaVersion: 1, toolName: CHAT_MEMORY_PROBE_TOOL, phase: 'write', pass: false, reasonCode: null, capturedAt: (options.now?.() ?? new Date()).toISOString(),
    marker, markerSha256: sha(marker), checks, steps, conversationId: null, memory: null, index: null, reply: null,
    sideEffects: { generationModelCalls: 0, syntheticMemory: 'retained-until-recall', withdrawAttempted: false }, ...patch });
  try {
    alive(options, deadline);
    const conversation = await ports.findConversation();
    if (!conversation) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', 'No local conversation is available', make({ reasonCode: 'NO_CONVERSATION' }));
    alive(options, deadline);
    const remembered = await ports.remember({ requestId, conversationId: conversation.conversationId, text: `${requestId} ${marker}：单用户聊天记忆探针合成事实，仅用于受控往返验证。` });
    steps.push({ step: 'remember-synthetic-fact', status: 'passed' });
    check(checks, 'fact-remembered', Boolean(remembered.operationId), 'memory operation exists', remembered.operationId);
    const indexed = await ports.index({ requestId: `chat-memory-probe-index-${randomUUID()}`, operationId: remembered.operationId });
    steps.push({ step: 'index-fact', status: 'passed' });
    const indexOk = indexed.effectStatus !== 'unknown' && indexed.effectStatus !== 'failed' && indexed.usageComplete === true
      && typeof indexed.embeddingCalls === 'number' && indexed.embeddingCalls >= 1 && indexed.embeddingCalls <= 2;
    check(checks, 'fact-indexed', indexOk, 'applied/publishable index with 1-2 embedding calls', JSON.stringify(indexed));
    if (!indexOk) {
      const reason: ChatMemoryProbeReason = indexed.effectStatus === 'unknown' ? 'INDEX_UNCONFIRMED' : 'INDEX_FAILED';
      throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', `Write phase failed: ${reason}`,
        make({ conversationId: conversation.conversationId, memory: { operationId: remembered.operationId, requestId: remembered.requestId }, index: clone(indexed), reasonCode: reason }));
    }
    const maxTokens = options.maxTokens ?? CHAT_MEMORY_PROBE_MAX_TOKENS;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > CHAT_MEMORY_PROBE_MAX_TOKENS) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', 'Invalid write maxTokens', make({ conversationId: conversation.conversationId, reasonCode: 'INVALID_OPTIONS' }));
    const reply = await ports.reply({ conversationId: conversation.conversationId, inputId: `chat-memory-probe-write-${randomUUID()}`,
      text: `请确认你已记住下面的合成事实，只回复“已记住”，不要解释。合成事实：${marker}`, maxTokens });
    steps.push({ step: 'reply-turn', status: 'passed' });
    const sameConversation = reply.conversationId === conversation.conversationId;
    check(checks, 'reply-same-conversation', sameConversation, conversation.conversationId, reply.conversationId);
    check(checks, 'reply-confirmed', reply.contextConfirmed === true && typeof reply.text === 'string' && reply.text.trim().length > 0,
      'confirmed native context and non-empty reply text', `${reply.contextConfirmed}/${reply.text.trim().length}`);
    check(checks, 'reply-no-error', reply.status !== 'failed' && reply.status !== 'cancelled' && reply.status !== 'unknown', 'no failed/cancelled/unknown reply', reply.status);
    const reason: ChatMemoryProbeReason = !sameConversation ? 'REPLY_CONVERSATION_MISMATCH'
      : reply.contextConfirmed !== true ? 'REPLY_UNCONFIRMED' : null;
    if (reason) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', `Write phase failed: ${reason}`, make({ reasonCode: reason }));
    const receipt = make({ pass: true, conversationId: conversation.conversationId,
      memory: { operationId: remembered.operationId, requestId: remembered.requestId },
      index: clone(indexed), reply: { operationId: reply.operationId, sha256: sha(reply.text), bytes: bytes(reply.text), status: reply.status,
        sessionId: reply.sessionId, sameConversation, contextConfirmed: reply.contextConfirmed },
      sideEffects: { generationModelCalls: 1, syntheticMemory: 'retained-until-recall', withdrawAttempted: false } });
    const violations = validateChatMemoryProbeReceipt(receipt);
    if (violations.length) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_INVALID', `Receipt invalid: ${violations[0]}`, receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ChatMemoryProbeError) throw error;
    throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', bounded(error instanceof Error ? error.message : String(error)), make({ reasonCode: 'REPLY_FAILED' }));
  }
}
/* ----------------------------------------------------------------- recall */
export async function runChatMemoryRecallPhase(ports: ChatMemoryRecallPorts, options: ChatMemoryProbeOptions = {}): Promise<ChatMemoryRecallReceipt> {
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const deadline = Date.parse(startedAt) + (options.deadlineMs ?? 60000);
  const checks: ChatMemoryProbeCheck[] = [], steps: ChatMemoryProbeStep[] = [];
  const make = (patch: Partial<ChatMemoryRecallReceipt>): ChatMemoryRecallReceipt => ({
    schemaVersion: 1, toolName: CHAT_MEMORY_PROBE_TOOL, phase: 'recall', pass: false, reasonCode: null, capturedAt: (options.now?.() ?? new Date()).toISOString(),
    marker: '', markerSha256: '', checks, steps, conversationId: null, memory: null, reply: null,
    memoryEvidence: { controlled: false, source: 'none', operationIds: [] },
    session: { expectedSessionId: options.expectedSessionId ?? null, recallSessionId: null, sameSession: null,
      evidence: options.expectedSessionId ? 'explicit-expected-session' : 'none' },
    sideEffects: { generationModelCalls: 0, syntheticMemory: 'retained-until-recall', withdrawAttempted: false }, ...patch });
  try {
    alive(options, deadline);
    const fact = await ports.findProbeFact();
    if (!fact || !fact.requestId.startsWith('chat-memory-probe-') || (options.conversationId !== undefined && fact.conversationId !== options.conversationId)) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', 'No chat-memory-probe fact is available', make({ reasonCode: 'NO_PROBE_FACT' }));
    const conversationId = options.conversationId ?? fact.conversationId;
    const read = await ports.readMemory({ operationId: fact.operationId });
    steps.push({ step: 'read-probe-fact', status: 'passed' });
    const marker = extractMarker(read.body);
    if (!marker) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', 'Probe fact has no readable synthetic marker',
      make({ conversationId, memory: { operationId: fact.operationId, requestId: fact.requestId, bodyMatched: false, withdrawn: false }, reasonCode: 'FACT_NOT_READABLE' }));
    const markerSha = sha(marker);
    alive(options, deadline);
    const maxTokens = options.maxTokens ?? CHAT_MEMORY_PROBE_MAX_TOKENS;
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > CHAT_MEMORY_PROBE_MAX_TOKENS) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', 'Invalid recall maxTokens', make({ conversationId, marker, markerSha256: markerSha, reasonCode: 'INVALID_OPTIONS' }));
    // The prompt intentionally does not contain the marker: a correct answer must
    // come from the same native Session and/or controlled memory, not a prompt echo.
    const reply = await ports.reply({ conversationId, inputId: `chat-memory-probe-recall-${randomUUID()}`,
      text: '请只复述你记住的那条合成事实，只输出事实本身，不要解释，也不要编造。', maxTokens });
    steps.push({ step: 'reply-turn', status: 'passed' });
    const containsMarker = reply.text.includes(marker);
    check(checks, 'reply-contains-marker', containsMarker, `reply contains ${marker}`, containsMarker ? 'present' : 'missing');
    check(checks, 'reply-confirmed', reply.contextConfirmed === true && reply.text.trim().length > 0, 'confirmed native context and non-empty reply', `${reply.contextConfirmed}/${reply.text.trim().length}`);
    let controlled = reply.memoryOperationIds.includes(fact.operationId);
    let source: ChatMemoryRecallReceipt['memoryEvidence']['source'] = controlled ? 'reply-memory-sources' : 'none';
    let operationIds = [...reply.memoryOperationIds];
    if (!controlled && ports.backgroundMemoryEvidence) {
      const background = await ports.backgroundMemoryEvidence({ conversationId, text: 'chat-memory-probe recall context' }).catch(() => undefined);
      if (background) {
        operationIds = [...background.memoryOperationIds];
        controlled = background.memoryOperationIds.includes(fact.operationId);
        source = 'background-load';
        steps.push({ step: 'background-load-evidence', status: controlled ? 'passed' : 'failed' });
      }
    }
    check(checks, 'controlled-memory-source', controlled, `memory sources include ${fact.operationId} (reply or background load)`, operationIds.join(','));
    const expected = options.expectedSessionId ?? null;
    const sameSession = expected === null ? null : reply.sessionId === expected;
    if (expected !== null) check(checks, 'same-native-session', sameSession === true, expected, reply.sessionId);
    else check(checks, 'session-evidence-provided', false, 'expectedSessionId from write phase (or persisted binding)', 'not provided');
    const reason: ChatMemoryProbeReason = !marker ? 'FACT_NOT_READABLE'
      : !containsMarker ? 'REPLY_MARKER_MISSING'
        : expected === null ? 'SESSION_EVIDENCE_MISSING'
          : sameSession !== true ? 'SESSION_MISMATCH'
            : !controlled ? 'REPLY_WITHOUT_CONTROLLED_MEMORY_SOURCE' : null;
    let withdrawn = false, withdrawalCode: string | undefined;
    if (reason === null) {
      try { await ports.withdraw({ requestId: `chat-memory-probe-withdraw-${randomUUID()}`, operationId: fact.operationId }); withdrawn = true; }
      catch (error) { withdrawalCode = error && typeof error === 'object' && 'code' in error ? bounded((error as { code: unknown }).code) : 'WITHDRAW_FAILED'; }
    }
    const receipt = make({ pass: reason === null, conversationId, marker, markerSha256: markerSha,
      reasonCode: reason, memory: { operationId: fact.operationId, requestId: fact.requestId, bodyMatched: true, withdrawn, ...(withdrawalCode ? { withdrawalCode } : {}) },
      reply: { operationId: reply.operationId, sha256: sha(reply.text), bytes: bytes(reply.text), status: reply.status, sessionId: reply.sessionId,
        containsMarker, contextConfirmed: reply.contextConfirmed },
      memoryEvidence: { controlled, source, operationIds },
      session: { expectedSessionId: expected, recallSessionId: reply.sessionId, sameSession, evidence: expected === null ? 'none' : 'explicit-expected-session' },
      sideEffects: { generationModelCalls: 1, syntheticMemory: withdrawn ? 'withdrawn' : 'retained-until-recall', withdrawAttempted: reason === null } });
    const violations = validateChatMemoryProbeReceipt(receipt);
    if (violations.length) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_INVALID', `Receipt invalid: ${violations[0]}`, receipt);
    if (!receipt.pass) throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', `Recall phase failed: ${reason}`, receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ChatMemoryProbeError) throw error;
    throw new ChatMemoryProbeError('CHAT_MEMORY_PROBE_FAILED', bounded(error instanceof Error ? error.message : String(error)), make({ reasonCode: 'REPLY_FAILED' }));
  }
}
