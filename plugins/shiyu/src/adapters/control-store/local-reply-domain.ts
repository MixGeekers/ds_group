import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction } from 'node:util/types';
import { ConversationError, ConversationStore, type ContextSnapshot, type ContextToken, type ReplyBinding, type SourceVersion } from '../../control/conversations/index.js';
import type { TrustedPolicyActor } from '../../control/policy/mandates.js';
import { SqliteTransactions } from './transaction.js';

const OWNER: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const fail = (code: string, message: string): never => { throw new ConversationError(code, message); };
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/u.test(value);
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fields(value: unknown, allowed: string[], required = allowed): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_SCHEMA', 'Unknown or missing local reply fields');
}
export interface LocalReplyCapture {
  captureId: string; expiresAt: string;
  context: ContextSnapshot & { businessId: string; sessionId?: string };
}
/** Installed by the trusted Worker; captures are never supplied by public callers. */
export interface LocalReplyAuthority {
  validateCapture(captureId: string, phase: 'prepare' | 'ack' | 'ready'): LocalReplyCapture;
}
export interface LocalReplyNativeBinding {
  operationId: string; contextTokenId: string; sessionEpoch: number;
  key: string; businessId: string; scope: string; sessionId: string; messageId: string; messageHash: string;
}
export interface LocalReplyContextReceipt extends LocalReplyNativeBinding {
  userMessageSeq: number; confirmedAt: string; durability: 'confirmed';
}
export interface LocalReplyAssistantRef { sessionId: string; eventSeq: number; messageId: string }
export interface LocalReplyOperation {
  operationId: string; conversationId: string; inputId: string; inputHash: string;
  bindingId: string; businessId: string; scope: 'local-owner'; sessionEpoch: number;
  status: 'admitted' | 'prepared' | 'dispatching' | 'ready' | 'failed' | 'cancelled' | 'unknown';
  durability: 'unconfirmed' | 'confirmed';
  token: ContextToken; createdAt: string; updatedAt: string;
  expectedSessionId?: string; captureId?: string; viewId?: string; contextTokenId?: string; expiresAt?: string;
  sources?: SourceVersion[]; draftId?: string; nativeBinding?: LocalReplyNativeBinding;
  contextReceipt?: LocalReplyContextReceipt; assistantRef?: LocalReplyAssistantRef; draftRef?: string; reasonCode?: string;
}
export interface LocalReplyCommands {
  'conversation.reply.admit': { input: { conversationId: string; inputId: string; inputHash: string }; output: { duplicate: boolean; operation: LocalReplyOperation } };
  'conversation.reply.prepare': { input: { operationId: string; captureId: string; viewId: string; loadedTaskIds: string[] }; output: LocalReplyOperation };
  'conversation.reply.bind': { input: { binding: LocalReplyNativeBinding }; output: LocalReplyOperation };
  'conversation.reply.authorize': { input: { operationId: string; phase: 'dispatch' | 'ack' | 'ready' }; output: LocalReplyOperation };
  'conversation.reply.contextDurable': { input: { receipt: LocalReplyContextReceipt }; output: LocalReplyOperation };
  'conversation.reply.ready': { input: { operationId: string; assistantRef: LocalReplyAssistantRef }; output: LocalReplyOperation };
  'conversation.reply.fail': { input: { operationId: string; status: 'failed' | 'cancelled' | 'unknown'; reasonCode: string }; output: LocalReplyOperation };
  'conversation.reply.get': { input: { operationId: string }; output: LocalReplyOperation };
}
export type LocalReplyDomainRequest = { [K in keyof LocalReplyCommands]: { command: K; args: LocalReplyCommands[K]['input'] } }[keyof LocalReplyCommands];
interface Options {
  conversations: ConversationStore;
  bindingFor(conversationId: string): ReplyBinding;
  now?: () => Date;
}

/** Control references and hashes only. Session history, inbox and all message text remain native. */
export class LocalReplyDomain {
  private authority?: LocalReplyAuthority;
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: Options) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Reply control requires the shared transaction owner');
    tx.atomic(() => db.exec(`CREATE TABLE IF NOT EXISTS shiyu_local_reply_inputs(
      operation_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,input_id TEXT NOT NULL,input_hash TEXT NOT NULL,
      record_json TEXT NOT NULL,UNIQUE(conversation_id,input_id))`));
  }
  setAuthority(authority: LocalReplyAuthority): void {
    if (this.authority || typeof authority?.validateCapture !== 'function' || isAsyncFunction(authority.validateCapture)) fail('INVALID_AUTHORITY', 'Local reply authority must be installed once');
    this.authority = { validateCapture: authority.validateCapture.bind(authority) };
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private save(operation: LocalReplyOperation): LocalReplyOperation {
    operation.updatedAt = this.now();
    this.db.prepare('UPDATE shiyu_local_reply_inputs SET record_json=? WHERE operation_id=?').run(JSON.stringify(operation), operation.operationId);
    return structuredClone(operation);
  }
  get(input: { operationId: string }): LocalReplyOperation {
    fields(input, ['operationId']); if (!id(input.operationId)) fail('INVALID_SCHEMA', 'Invalid reply operation identity');
    this.tx.assertUsable();
    const row = this.db.prepare('SELECT record_json FROM shiyu_local_reply_inputs WHERE operation_id=?').get(input.operationId);
    if (!row) fail('UNKNOWN_REPLY', 'Reply operation is unavailable');
    return JSON.parse(String(row!.record_json)) as LocalReplyOperation;
  }
  latest(conversationId: string): LocalReplyOperation | undefined {
    this.tx.assertUsable();
    const row = this.db.prepare('SELECT record_json FROM shiyu_local_reply_inputs WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(conversationId);
    return row ? JSON.parse(String(row.record_json)) as LocalReplyOperation : undefined;
  }
  private sameToken(a: ContextToken, b: ContextToken): boolean {
    return (['bindingId', 'conversationId', 'scope', 'audienceVersion', 'conversationGeneration', 'routingRevision', 'sessionEpoch'] as const).every(key => a[key] === b[key]);
  }
  private current(operation: LocalReplyOperation, phase: 'prepare' | 'ack' | 'ready'): LocalReplyCapture {
    if (!this.authority || !operation.captureId || !operation.expiresAt) fail('REPLY_NOT_PREPARED', 'A trusted context capture is required');
    if (Date.parse(operation.expiresAt!) <= Date.parse(this.now())) fail('EXPIRED', 'Reply context expired');
    const capture = this.authority!.validateCapture(operation.captureId!, phase);
    const binding = this.options.bindingFor(operation.conversationId);
    const token = this.options.conversations.version(OWNER, binding.bindingId);
    if (capture.captureId !== operation.captureId || capture.expiresAt !== operation.expiresAt || !this.sameToken(operation.token, capture.context.token)
      || !this.sameToken(operation.token, token) || binding.businessId !== operation.businessId || binding.sessionEpoch !== operation.sessionEpoch) fail('STALE_CONTEXT', 'Reply context or binding changed');
    if (operation.nativeBinding && binding.sessionId !== operation.nativeBinding.sessionId) fail('SESSION_BINDING_CONFLICT', 'Native reply binding changed');
    return capture;
  }
  admit(input: LocalReplyCommands['conversation.reply.admit']['input']): LocalReplyCommands['conversation.reply.admit']['output'] {
    fields(input, ['conversationId', 'inputId', 'inputHash']);
    if (!id(input.conversationId) || !id(input.inputId) || !sha(input.inputHash)) fail('INVALID_SCHEMA', 'Invalid reply input reference');
    return this.tx.atomic(() => {
      const binding = this.options.bindingFor(input.conversationId);
      this.options.conversations.version(OWNER, binding.bindingId); // Active audience/binding before admitting any input.
      const previous = this.db.prepare('SELECT input_hash,record_json FROM shiyu_local_reply_inputs WHERE conversation_id=? AND input_id=?').get(input.conversationId, input.inputId);
      if (previous) {
        if (previous.input_hash !== input.inputHash) fail('IDEMPOTENCY_CONFLICT', 'Reply input identity already names different text');
        return { duplicate: true, operation: JSON.parse(String(previous.record_json)) as LocalReplyOperation };
      }
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_reply_inputs').get()!.n) >= 4096) fail('REPLY_CAPACITY', 'Local reply control capacity reached');
      const conversation = this.options.conversations.getConversation(OWNER, input.conversationId);
      const operationId = randomUUID();
      this.options.conversations.advanceGeneration(OWNER, { conversationId: input.conversationId, expectedRevision: conversation.revision, eventId: `reply-input:${operationId}`, reason: 'input' });
      const operation: LocalReplyOperation = { ...input, operationId, bindingId: binding.bindingId, businessId: binding.businessId, scope: 'local-owner', sessionEpoch: binding.sessionEpoch,
        status: 'admitted', durability: 'unconfirmed', token: this.options.conversations.version(OWNER, binding.bindingId), createdAt: this.now(), updatedAt: this.now(),
        ...(binding.sessionId ? { expectedSessionId: binding.sessionId } : {}) };
      this.db.prepare('INSERT INTO shiyu_local_reply_inputs VALUES(?,?,?,?,?)').run(operationId, input.conversationId, input.inputId, input.inputHash, JSON.stringify(operation));
      return { duplicate: false, operation };
    });
  }
  prepare(input: LocalReplyCommands['conversation.reply.prepare']['input']): LocalReplyOperation {
    fields(input, ['operationId', 'captureId', 'viewId', 'loadedTaskIds']);
    if (!id(input.captureId) || !opaque(input.viewId) || !Array.isArray(input.loadedTaskIds) || input.loadedTaskIds.length > 20
      || input.loadedTaskIds.some(value => !id(value)) || new Set(input.loadedTaskIds).size !== input.loadedTaskIds.length) fail('INVALID_SCHEMA', 'Invalid bounded context preparation');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: input.operationId });
      if (operation.status !== 'admitted') fail('REPLY_ALREADY_PREPARED', 'Reply input cannot be dispatched again');
      if (!this.authority) fail('AUTHORITY_UNAVAILABLE', 'Reply context authority is unavailable');
      const capture = this.authority!.validateCapture(input.captureId, 'prepare');
      if (!this.sameToken(operation.token, capture.context.token) || capture.context.businessId !== operation.businessId
        || (operation.expectedSessionId && capture.context.sessionId !== operation.expectedSessionId)) fail('STALE_CONTEXT', 'Capture does not match the admitted input');
      const loaded = new Set(input.loadedTaskIds);
      const sources = capture.context.sources.filter(source => source.reference.kind === 'task' && loaded.has(source.reference.id));
      if (sources.length !== loaded.size) fail('FORBIDDEN_REFERENCE', 'Loaded references are not captured conversation sources');
      const draftId = randomUUID();
      const draft = this.options.conversations.beginReply(OWNER, { draftId, bindingId: operation.bindingId, dependencies: sources.map(source => source.reference) });
      if (!this.sameToken(draft.token, capture.context.token) || sources.some(source => !draft.dependencies.some(value => value.reference.kind === source.reference.kind && value.reference.id === source.reference.id && value.sourceVersion === source.sourceVersion))) fail('STALE_CONTEXT', 'Captured reply dependencies changed');
      Object.assign(operation, { status: 'prepared', captureId: input.captureId, viewId: input.viewId, expiresAt: capture.expiresAt, sources, draftId,
        token: structuredClone(capture.context.token), contextTokenId: digest([input.captureId, input.viewId, capture.context.token]) });
      this.current(operation, 'prepare'); return this.save(operation);
    });
  }
  private validateNative(binding: LocalReplyNativeBinding): void {
    fields(binding, ['operationId', 'contextTokenId', 'sessionEpoch', 'key', 'businessId', 'scope', 'sessionId', 'messageId', 'messageHash']);
    if (!id(binding.operationId) || !sha(binding.contextTokenId) || !Number.isSafeInteger(binding.sessionEpoch) || binding.sessionEpoch < 1
      || !opaque(binding.key) || !opaque(binding.businessId) || binding.scope !== 'local-owner' || !opaque(binding.sessionId) || !opaque(binding.messageId) || !sha(binding.messageHash)) fail('INVALID_SCHEMA', 'Invalid native reply binding');
  }
  bind(input: LocalReplyCommands['conversation.reply.bind']['input']): LocalReplyOperation {
    fields(input, ['binding']); this.validateNative(input.binding);
    return this.tx.atomic(() => {
      const value = input.binding, operation = this.get({ operationId: value.operationId });
      if (operation.status !== 'prepared') fail('REPLY_ALREADY_DISPATCHED', 'Reply dispatch intent is already recorded');
      this.current(operation, 'prepare');
      if (value.key !== digest(['replyer', operation.businessId, operation.scope]) || value.contextTokenId !== operation.contextTokenId || value.sessionEpoch !== operation.sessionEpoch || value.businessId !== operation.businessId || value.scope !== operation.scope
        || (operation.expectedSessionId && value.sessionId !== operation.expectedSessionId)) fail('SESSION_BINDING_CONFLICT', 'Native Session does not match the prepared business binding');
      const binding = this.options.bindingFor(operation.conversationId);
      this.options.conversations.bindSession(OWNER, { bindingId: binding.bindingId, expectedRevision: binding.revision, sessionEpoch: operation.sessionEpoch, sessionId: value.sessionId });
      operation.nativeBinding = structuredClone(value); operation.status = 'dispatching'; return this.save(operation);
    });
  }
  authorize(input: LocalReplyCommands['conversation.reply.authorize']['input']): LocalReplyOperation {
    fields(input, ['operationId', 'phase']); if (!['dispatch', 'ack', 'ready'].includes(input.phase)) fail('INVALID_SCHEMA', 'Unknown reply authorization phase');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: input.operationId });
      if (!['prepared', 'dispatching'].includes(operation.status)) fail('REPLY_NOT_ACTIVE', 'Reply is no longer eligible to run');
      this.current(operation, input.phase === 'dispatch' ? 'prepare' : input.phase); return operation;
    });
  }
  contextDurable(input: LocalReplyCommands['conversation.reply.contextDurable']['input']): LocalReplyOperation {
    fields(input, ['receipt']); const receipt = input.receipt;
    fields(receipt, ['operationId', 'contextTokenId', 'sessionEpoch', 'key', 'businessId', 'scope', 'sessionId', 'messageId', 'messageHash', 'userMessageSeq', 'confirmedAt', 'durability']);
    const { userMessageSeq, confirmedAt, durability, ...native } = receipt; this.validateNative(native);
    if (!Number.isSafeInteger(userMessageSeq) || userMessageSeq < 1 || typeof confirmedAt !== 'string' || !Number.isFinite(Date.parse(confirmedAt)) || durability !== 'confirmed') fail('INVALID_SCHEMA', 'Invalid native context durability receipt');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: receipt.operationId });
      if (operation.contextReceipt) {
        if (canonical(operation.contextReceipt) !== canonical(receipt)) fail('IDEMPOTENCY_CONFLICT', 'Context receipt already names different evidence');
        return operation;
      }
      if (operation.status !== 'dispatching' || !operation.nativeBinding || canonical(operation.nativeBinding) !== canonical(native)) fail('REPLY_NOT_ACTIVE', 'Context receipt does not match the dispatched message');
      this.current(operation, 'ack');
      this.options.conversations.ackContext(OWNER, { token: operation.token, sources: operation.sources! });
      operation.contextReceipt = structuredClone(receipt); operation.durability = 'confirmed'; return this.save(operation);
    });
  }
  ready(input: LocalReplyCommands['conversation.reply.ready']['input']): LocalReplyOperation {
    fields(input, ['operationId', 'assistantRef']); const ref = input.assistantRef;
    fields(ref, ['sessionId', 'eventSeq', 'messageId']);
    if (!opaque(ref.sessionId) || !opaque(ref.messageId) || !Number.isSafeInteger(ref.eventSeq) || ref.eventSeq < 1) fail('INVALID_SCHEMA', 'Invalid native assistant reference');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: input.operationId });
      if (operation.status === 'ready') {
        if (canonical(operation.assistantRef) !== canonical(ref)) fail('IDEMPOTENCY_CONFLICT', 'Completed draft already names another native message');
        return operation;
      }
      if (operation.status !== 'dispatching' || operation.durability !== 'confirmed' || !operation.contextReceipt || ref.sessionId !== operation.contextReceipt.sessionId || ref.eventSeq <= operation.contextReceipt.userMessageSeq) fail('REPLY_NOT_READY', 'A durable input and later native assistant event are required');
      this.current(operation, 'ready');
      const draftRef = `native-session:${ref.sessionId}:event:${ref.eventSeq}:message:${ref.messageId}`;
      this.options.conversations.completeReply(OWNER, { draftId: operation.draftId!, draftRef });
      this.options.conversations.assertDraftCurrent(OWNER, operation.draftId!);
      operation.status = 'ready'; operation.assistantRef = structuredClone(ref); operation.draftRef = draftRef; return this.save(operation);
    });
  }
  fail(input: LocalReplyCommands['conversation.reply.fail']['input']): LocalReplyOperation {
    fields(input, ['operationId', 'status', 'reasonCode']);
    if (!['failed', 'cancelled', 'unknown'].includes(input.status) || !/^[A-Z_]{1,80}$/.test(input.reasonCode)) fail('INVALID_SCHEMA', 'Invalid bounded reply failure');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: input.operationId });
      if (operation.status === 'ready') return operation; // A late caller failure cannot undo an already committed draft.
      if (['failed', 'cancelled', 'unknown'].includes(operation.status)) return operation;
      if (operation.draftId) this.options.conversations.abandonReply(OWNER, operation.draftId);
      operation.status = input.status; operation.reasonCode = input.reasonCode; return this.save(operation);
    });
  }
  execute(request: LocalReplyDomainRequest): unknown {
    switch (request.command) {
      case 'conversation.reply.admit': return this.admit(request.args);
      case 'conversation.reply.prepare': return this.prepare(request.args);
      case 'conversation.reply.bind': return this.bind(request.args);
      case 'conversation.reply.authorize': return this.authorize(request.args);
      case 'conversation.reply.contextDurable': return this.contextDurable(request.args);
      case 'conversation.reply.ready': return this.ready(request.args);
      case 'conversation.reply.fail': return this.fail(request.args);
      case 'conversation.reply.get': return this.get(request.args);
    }
  }
}
