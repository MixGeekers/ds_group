import { createHash, randomUUID } from 'node:crypto';
import type { MemoryViewSnapshot, MemoryViewSource } from './memory-domain.js';
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
  replyExecution?: { kind: 'lab-reply-v1'; operationId: string; replyId: string; connectionId: string };
  context: ContextSnapshot & { businessId: string; sessionId?: string };
  memory?: MemoryViewSnapshot;
}
/** Installed by the trusted Worker; captures are never supplied by public callers. */
export interface LocalReplyAuthority {
  validateCapture(captureId: string, phase: 'prepare' | 'ack' | 'ready'): LocalReplyCapture;
  /** Fresh rights for every source previously exposed to this native epoch,
   * including when the new round selects no memories. No external I/O. */
  assertMemorySourcesCurrent?(sources: readonly MemoryViewSource[]): void;
}
export interface LocalMemoryContextInvalidation {
  conversationIds: string[];
  retiredSessions: { bindingId: string; sessionEpoch: number; businessId: string; sessionId?: string }[];
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
  status: 'admitted' | 'prepared' | 'dispatching' | 'loaded' | 'ready' | 'failed' | 'cancelled' | 'unknown';
  durability: 'unconfirmed' | 'confirmed';
  token: ContextToken; createdAt: string; updatedAt: string;
  /** Legacy records predate mode; new records explicitly distinguish load-only. */
  mode?: 'reply' | 'load';
  expectedSessionId?: string; captureId?: string; viewId?: string; contextTokenId?: string; expiresAt?: string;
  sources?: SourceVersion[]; draftId?: string; nativeBinding?: LocalReplyNativeBinding;
  memorySources?: MemoryViewSource[];
  contextReceipt?: LocalReplyContextReceipt; assistantRef?: LocalReplyAssistantRef; draftRef?: string; reasonCode?: string;
  /** Hash of the exact transient native assistant text; no body is stored here. */
  textSha256?: string;
}
export interface LocalReplyCommands {
  'conversation.reply.admit': { input: { conversationId: string; inputId: string; inputHash: string; mode?: 'reply' | 'load' }; output: { duplicate: boolean; operation: LocalReplyOperation } };
  'conversation.reply.prepare': { input: { operationId: string; captureId: string; viewId: string; loadedTaskIds: string[]; loadedMemoryOperationIds?: string[] }; output: LocalReplyOperation };
  'conversation.reply.bind': { input: { binding: LocalReplyNativeBinding }; output: LocalReplyOperation };
  'conversation.reply.authorize': { input: { operationId: string; phase: 'dispatch' | 'ack' | 'ready' }; output: LocalReplyOperation };
  'conversation.reply.contextDurable': { input: { receipt: LocalReplyContextReceipt }; output: LocalReplyOperation };
  'conversation.reply.ready': { input: { operationId: string; assistantRef: LocalReplyAssistantRef; textSha256?: string }; output: LocalReplyOperation };
  'conversation.reply.loaded': { input: { operationId: string }; output: LocalReplyOperation };
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
      record_json TEXT NOT NULL,UNIQUE(conversation_id,input_id));
      CREATE TABLE IF NOT EXISTS shiyu_local_reply_memory_exposures(
        operation_id TEXT NOT NULL,source_id TEXT NOT NULL,binding_id TEXT NOT NULL,session_epoch INTEGER NOT NULL,
        session_id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(operation_id,source_id));
      CREATE INDEX IF NOT EXISTS shiyu_reply_exposure_source ON shiyu_local_reply_memory_exposures(source_id,binding_id,session_epoch);
      CREATE INDEX IF NOT EXISTS shiyu_reply_exposure_binding ON shiyu_local_reply_memory_exposures(binding_id,session_epoch);
      CREATE TABLE IF NOT EXISTS shiyu_local_reply_memory_withdrawals(withdrawal_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,record_json TEXT NOT NULL)`));
  }
  setAuthority(authority: LocalReplyAuthority): void {
    if (this.authority || typeof authority?.validateCapture !== 'function' || isAsyncFunction(authority.validateCapture)
      || (authority.assertMemorySourcesCurrent !== undefined && (typeof authority.assertMemorySourcesCurrent !== 'function' || isAsyncFunction(authority.assertMemorySourcesCurrent)))) fail('INVALID_AUTHORITY', 'Local reply authority must be installed once');
    this.authority = { validateCapture: authority.validateCapture.bind(authority),
      ...(authority.assertMemorySourcesCurrent ? { assertMemorySourcesCurrent: authority.assertMemorySourcesCurrent.bind(authority) } : {}) };
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
  private assertEpochSources(binding: ReplyBinding): void {
    const rows = this.db.prepare('SELECT record_json FROM shiyu_local_reply_memory_exposures WHERE binding_id=? AND session_epoch=?').all(binding.bindingId, binding.sessionEpoch);
    if (!rows.length) return;
    if (!this.authority?.assertMemorySourcesCurrent) fail('MEMORY_AUTHORITY_UNAVAILABLE', 'An exposed native context requires current memory authority');
    const sources = new Map<string, MemoryViewSource>();
    for (const row of rows) {
      const exposure = JSON.parse(String(row.record_json)) as { source: MemoryViewSource };
      // Keep distinct versions: a later load cannot erase an older exposure.
      const source = exposure.source;
      sources.set(digest([source.sourceId, source.sourceRevision, source.conversationId, source.nativeId, source.componentVersion,
        source.commandDigest, source.readToken.audienceVersion, source.readToken.installationGeneration, source.readToken.deploymentId]), source);
    }
    const result: unknown = this.authority!.assertMemorySourcesCurrent!([...sources.values()]);
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) fail('INVALID_AUTHORITY', 'Native context authority cannot perform asynchronous I/O');
  }
  private current(operation: LocalReplyOperation, phase: 'prepare' | 'ack' | 'ready'): LocalReplyCapture {
    if (!this.authority || !operation.captureId || !operation.expiresAt) fail('REPLY_NOT_PREPARED', 'A trusted context capture is required');
    if (Date.parse(operation.expiresAt!) <= Date.parse(this.now())) fail('EXPIRED', 'Reply context expired');
    const capture = this.authority!.validateCapture(operation.captureId!, phase);
    const binding = this.options.bindingFor(operation.conversationId);
    this.assertEpochSources(binding);
    const token = this.options.conversations.version(OWNER, binding.bindingId);
    if (capture.captureId !== operation.captureId || capture.expiresAt !== operation.expiresAt || !this.sameToken(operation.token, capture.context.token)
      || !this.sameToken(operation.token, token) || binding.businessId !== operation.businessId || binding.sessionEpoch !== operation.sessionEpoch) fail('STALE_CONTEXT', 'Reply context or binding changed');
    if (operation.nativeBinding && binding.sessionId !== operation.nativeBinding.sessionId) fail('SESSION_BINDING_CONFLICT', 'Native reply binding changed');
    return capture;
  }
  admit(input: LocalReplyCommands['conversation.reply.admit']['input']): LocalReplyCommands['conversation.reply.admit']['output'] {
    fields(input, ['conversationId', 'inputId', 'inputHash', 'mode'], ['conversationId', 'inputId', 'inputHash']);
    if (!id(input.conversationId) || !id(input.inputId) || !sha(input.inputHash)) fail('INVALID_SCHEMA', 'Invalid reply input reference');
    if (input.mode !== undefined && !['reply', 'load'].includes(input.mode)) fail('INVALID_SCHEMA', 'Invalid local reply mode');
    return this.tx.atomic(() => {
      const binding = this.options.bindingFor(input.conversationId);
      this.options.conversations.version(OWNER, binding.bindingId); // Active audience/binding before admitting any input.
      const previous = this.db.prepare('SELECT input_hash,record_json FROM shiyu_local_reply_inputs WHERE conversation_id=? AND input_id=?').get(input.conversationId, input.inputId);
      if (previous) {
        if (previous.input_hash !== input.inputHash) fail('IDEMPOTENCY_CONFLICT', 'Reply input identity already names different text');
        const operation = JSON.parse(String(previous.record_json)) as LocalReplyOperation;
        // Legacy outcomes remain immutable duplicate facts. Their absent mode
        // never grants a new dispatch or the longer Lab execution profile.
        if (operation.mode !== undefined && operation.mode !== (input.mode ?? 'reply')) fail('IDEMPOTENCY_CONFLICT', 'Reply input identity already names a different mode');
        return { duplicate: true, operation };
      }
      this.assertEpochSources(binding);
      if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_reply_inputs').get()!.n) >= 4096) fail('REPLY_CAPACITY', 'Local reply control capacity reached');
      const conversation = this.options.conversations.getConversation(OWNER, input.conversationId);
      const operationId = randomUUID();
      this.options.conversations.advanceGeneration(OWNER, { conversationId: input.conversationId, expectedRevision: conversation.revision, eventId: `reply-input:${operationId}`, reason: 'input' });
      const operation: LocalReplyOperation = { ...input, mode: input.mode ?? 'reply', operationId, bindingId: binding.bindingId, businessId: binding.businessId, scope: 'local-owner', sessionEpoch: binding.sessionEpoch,
        status: 'admitted', durability: 'unconfirmed', token: this.options.conversations.version(OWNER, binding.bindingId), createdAt: this.now(), updatedAt: this.now(),
        ...(binding.sessionId ? { expectedSessionId: binding.sessionId } : {}) };
      this.db.prepare('INSERT INTO shiyu_local_reply_inputs VALUES(?,?,?,?,?)').run(operationId, input.conversationId, input.inputId, input.inputHash, JSON.stringify(operation));
      return { duplicate: false, operation };
    });
  }
  prepare(input: LocalReplyCommands['conversation.reply.prepare']['input']): LocalReplyOperation {
    fields(input, ['operationId', 'captureId', 'viewId', 'loadedTaskIds', 'loadedMemoryOperationIds'], ['operationId', 'captureId', 'viewId', 'loadedTaskIds']);
    const memoryIds = input.loadedMemoryOperationIds ?? [];
    if (!id(input.captureId) || !opaque(input.viewId) || !Array.isArray(input.loadedTaskIds) || input.loadedTaskIds.length > 20
      || input.loadedTaskIds.some(value => !id(value)) || new Set(input.loadedTaskIds).size !== input.loadedTaskIds.length
      || !Array.isArray(memoryIds) || memoryIds.length > 20 || memoryIds.some(value => !opaque(value)) || new Set(memoryIds).size !== memoryIds.length) fail('INVALID_SCHEMA', 'Invalid bounded context preparation');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: input.operationId });
      if (operation.status !== 'admitted') fail('REPLY_ALREADY_PREPARED', 'Reply input cannot be dispatched again');
      if (!this.authority) fail('AUTHORITY_UNAVAILABLE', 'Reply context authority is unavailable');
      const capture = this.authority!.validateCapture(input.captureId, 'prepare');
      if (capture.replyExecution && (capture.replyExecution.kind !== 'lab-reply-v1' || operation.mode === 'load'
        || capture.replyExecution.operationId !== operation.operationId || capture.replyExecution.replyId !== operation.inputId)) fail('LAB_CAPTURE_SCOPE', 'Lab capture belongs to another generation operation');
      if (!this.sameToken(operation.token, capture.context.token) || capture.context.businessId !== operation.businessId
        || (operation.expectedSessionId && capture.context.sessionId !== operation.expectedSessionId)) fail('STALE_CONTEXT', 'Capture does not match the admitted input');
      const loaded = new Set(input.loadedTaskIds);
      const sources = capture.context.sources.filter(source => source.reference.kind === 'task' && loaded.has(source.reference.id));
      if (sources.length !== loaded.size) fail('FORBIDDEN_REFERENCE', 'Loaded references are not captured conversation sources');
      const memorySources = (capture.memory?.sources ?? []).filter(source => memoryIds.includes(source.operationId));
      if (memorySources.length !== memoryIds.length || new Set(memorySources.map(source => source.sourceId)).size !== memorySources.length
        || memorySources.some(source => source.conversationId !== operation.conversationId)) fail('FORBIDDEN_REFERENCE', 'Loaded memory references do not match this conversation capture');
      const draftId = randomUUID();
      const draft = this.options.conversations.beginReply(OWNER, { draftId, bindingId: operation.bindingId, dependencies: sources.map(source => source.reference) });
      if (!this.sameToken(draft.token, capture.context.token) || sources.some(source => !draft.dependencies.some(value => value.reference.kind === source.reference.kind && value.reference.id === source.reference.id && value.sourceVersion === source.sourceVersion))) fail('STALE_CONTEXT', 'Captured reply dependencies changed');
      Object.assign(operation, { status: 'prepared', captureId: input.captureId, viewId: input.viewId, expiresAt: capture.expiresAt, sources, draftId,
        ...(memorySources.length ? { memorySources: structuredClone(memorySources) } : {}),
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
      const exposedOperations = new Set(this.db.prepare('SELECT DISTINCT record_json FROM shiyu_local_reply_memory_exposures WHERE binding_id=? AND session_epoch=?')
        .all(binding.bindingId, binding.sessionEpoch).map(row => (JSON.parse(String(row.record_json)) as { source: MemoryViewSource }).source.operationId));
      for (const source of operation.memorySources ?? []) exposedOperations.add(source.operationId);
      if (exposedOperations.size > 200) fail('MEMORY_CONTEXT_CAPACITY', 'This native context has reached its explicit memory exposure capacity');
      this.options.conversations.bindSession(OWNER, { bindingId: binding.bindingId, expectedRevision: binding.revision, sessionEpoch: operation.sessionEpoch, sessionId: value.sessionId });
      for (const source of operation.memorySources ?? []) {
        // Durable before followup: even a lost acknowledgement or failed model
        // can leave this body in native history. It remains a possible exposure.
        this.db.prepare('INSERT INTO shiyu_local_reply_memory_exposures VALUES(?,?,?,?,?,?)').run(operation.operationId, source.sourceId,
          operation.bindingId, operation.sessionEpoch, value.sessionId, JSON.stringify({ source, native: value, registeredAt: this.now() }));
      }
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
    fields(input, ['operationId', 'assistantRef', 'textSha256'], ['operationId', 'assistantRef']); const ref = input.assistantRef;
    if (input.textSha256 !== undefined && !sha(input.textSha256)) fail('INVALID_SCHEMA', 'Invalid native assistant text hash');
    fields(ref, ['sessionId', 'eventSeq', 'messageId']);
    if (!opaque(ref.sessionId) || !opaque(ref.messageId) || !Number.isSafeInteger(ref.eventSeq) || ref.eventSeq < 1) fail('INVALID_SCHEMA', 'Invalid native assistant reference');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: input.operationId });
      if (operation.status === 'ready') {
        if (canonical(operation.assistantRef) !== canonical(ref) || input.textSha256 !== operation.textSha256) fail('IDEMPOTENCY_CONFLICT', 'Completed draft already names another native message');
        return operation;
      }
      if (operation.status !== 'dispatching' || operation.durability !== 'confirmed' || !operation.contextReceipt || ref.sessionId !== operation.contextReceipt.sessionId || ref.eventSeq <= operation.contextReceipt.userMessageSeq) fail('REPLY_NOT_READY', 'A durable input and later native assistant event are required');
      this.current(operation, 'ready');
      const draftRef = `native-session:${ref.sessionId}:event:${ref.eventSeq}:message:${ref.messageId}`;
      this.options.conversations.completeReply(OWNER, { draftId: operation.draftId!, draftRef });
      this.options.conversations.assertDraftCurrent(OWNER, operation.draftId!);
      operation.status = 'ready'; operation.assistantRef = structuredClone(ref); operation.draftRef = draftRef;
      if (input.textSha256 !== undefined) operation.textSha256 = input.textSha256;
      return this.save(operation);
    });
  }
  /** Trusted synchronous publication gate, composable in a send claim transaction.
   * Historical ready records are not authority: expiry, sources and the current
   * audience/generation must still pass. Legacy records without a text hash fail. */
  assertReadyDraft(operationId: string): LocalReplyOperation {
    return this.tx.atomic(() => {
      const operation = this.get({ operationId });
      const receipt = operation.contextReceipt, ref = operation.assistantRef;
      if (operation.status !== 'ready' || operation.durability !== 'confirmed' || !receipt || receipt.durability !== 'confirmed'
        || !operation.nativeBinding || !ref || !operation.draftId || !sha(operation.textSha256)
        || !Number.isSafeInteger(receipt.userMessageSeq) || receipt.userMessageSeq < 1
        || !Number.isSafeInteger(ref.eventSeq) || ref.eventSeq <= receipt.userMessageSeq || ref.sessionId !== receipt.sessionId
        || operation.draftRef !== `native-session:${ref.sessionId}:event:${ref.eventSeq}:message:${ref.messageId}`) fail('REPLY_NOT_READY', 'A precise durable native draft is required');
      const verifiedReceipt = receipt!;
      const { userMessageSeq: _seq, confirmedAt: _at, durability: _durability, ...native } = verifiedReceipt;
      if (canonical(native) !== canonical(operation.nativeBinding) || verifiedReceipt.operationId !== operation.operationId
        || verifiedReceipt.contextTokenId !== operation.contextTokenId || verifiedReceipt.sessionEpoch !== operation.sessionEpoch
        || verifiedReceipt.businessId !== operation.businessId || verifiedReceipt.scope !== operation.scope) fail('REPLY_NOT_READY', 'Native context receipt does not match the persisted draft');
      this.current(operation, 'ready');
      const draft = this.options.conversations.assertDraftCurrent(OWNER, operation.draftId!);
      if (draft.draftRef !== operation.draftRef || canonical(draft.token) !== canonical(operation.token)
        || canonical(draft.dependencies) !== canonical(operation.sources ?? [])) fail('STALE_DRAFT', 'Current draft evidence changed');
      return operation;
    });
  }
  loaded(input: LocalReplyCommands['conversation.reply.loaded']['input']): LocalReplyOperation {
    fields(input, ['operationId']);
    return this.tx.atomic(() => {
      const operation = this.get(input);
      if (operation.status === 'loaded') return operation;
      if (operation.status !== 'dispatching' || operation.durability !== 'confirmed' || !operation.contextReceipt) fail('REPLY_NOT_LOADED', 'A confirmed native context receipt is required');
      this.current(operation, 'ready');
      if (operation.draftId) this.options.conversations.abandonReply(OWNER, operation.draftId);
      operation.status = 'loaded'; return this.save(operation);
    });
  }
  /** Trusted MemoryDomain callback in the same synchronous outer transaction.
   * No native history is changed or copied. Retiring an epoch also fences all
   * assistant/compaction derivatives of any possibly exposed withdrawn source. */
  invalidateMemorySources(input: { withdrawalId: string; sourceIds: readonly string[] }): LocalMemoryContextInvalidation {
    fields(input, ['withdrawalId', 'sourceIds']);
    if (!opaque(input.withdrawalId) || !Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 20
      || input.sourceIds.some(source => !opaque(source)) || new Set(input.sourceIds).size !== input.sourceIds.length) fail('INVALID_SCHEMA', 'Invalid bounded memory withdrawal');
    return this.tx.atomic(() => {
      const previous = this.db.prepare('SELECT input_hash,record_json FROM shiyu_local_reply_memory_withdrawals WHERE withdrawal_id=?').get(input.withdrawalId);
      if (previous) {
        if (previous.input_hash !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 'Memory withdrawal identity changed');
        return JSON.parse(String(previous.record_json)) as LocalMemoryContextInvalidation;
      }
      const affected = new Map<string, ReplyBinding>();
      for (const sourceId of input.sourceIds) for (const row of this.db.prepare('SELECT DISTINCT binding_id,session_epoch,session_id FROM shiyu_local_reply_memory_exposures WHERE source_id=?').all(sourceId)) {
        const binding = this.options.conversations.getReplyBinding(OWNER, String(row.binding_id));
        if (binding.sessionEpoch === row.session_epoch) {
          if (binding.sessionId !== row.session_id) fail('SESSION_BINDING_CONFLICT', 'Native exposure no longer matches its current epoch');
          affected.set(binding.bindingId, binding);
        }
      }
      const retiredSessions: LocalMemoryContextInvalidation['retiredSessions'] = [];
      for (const binding of affected.values()) {
        retiredSessions.push({ bindingId: binding.bindingId, sessionEpoch: binding.sessionEpoch, businessId: binding.businessId,
          ...(binding.sessionId ? { sessionId: binding.sessionId } : {}) });
        this.options.conversations.resetNativeSession(OWNER, { bindingId: binding.bindingId, expectedSessionEpoch: binding.sessionEpoch, reasonRef: input.withdrawalId });
      }
      const result = { conversationIds: [...new Set([...affected.values()].map(binding => binding.conversationId))], retiredSessions };
      this.db.prepare('INSERT INTO shiyu_local_reply_memory_withdrawals VALUES(?,?,?)').run(input.withdrawalId, digest(input), JSON.stringify(result));
      return result;
    });
  }
  fail(input: LocalReplyCommands['conversation.reply.fail']['input']): LocalReplyOperation {
    fields(input, ['operationId', 'status', 'reasonCode']);
    if (!['failed', 'cancelled', 'unknown'].includes(input.status) || !/^[A-Z_]{1,80}$/.test(input.reasonCode)) fail('INVALID_SCHEMA', 'Invalid bounded reply failure');
    return this.tx.atomic(() => {
      const operation = this.get({ operationId: input.operationId });
      if (operation.status === 'ready' || operation.status === 'loaded') return operation; // A late caller failure cannot undo a committed native fact.
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
      case 'conversation.reply.loaded': return this.loaded(request.args);
      case 'conversation.reply.fail': return this.fail(request.args);
      case 'conversation.reply.get': return this.get(request.args);
    }
  }
}
