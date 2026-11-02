import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaultModel, sessionBindingKey } from '../../src/adapters/dsh/sessions.js';
import type { ReplyDraftReadRequest, ReplyDraftReadResult, ReplyResult, ReplyAccounting } from '../../src/adapters/dsh/sessions.js';
import type { LocalReplySessionDriver } from '../../src/control/local-reply.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

export interface OracleChannel { id: string; name: string; kind: 'direct' | 'group'; memberIds: string[] }
export interface OracleInput {
  seq: number;
  event: { id: string; seq: number; runId: string; at: string; type: 'input.message'; role: 'world'; actorId: string; channelId: string; text: string; data: Record<string, unknown> };
  evaluationMode: 'outcome';
}
export interface OracleDelivery { runId: string; operationId: string; eventId: string; channelId: string; text: string; actionHash: string; at: string }

/**
 * Independent remote-side oracle for the documented Lab public target protocol.
 * It imports no Lab engine and sees no Shiyu control rows. Requests and actual
 * delivered events are separate: a response may disappear after delivery.
 */
export class LabProtocolOracle {
  readonly runId = 'synthetic-lab-integration-run';
  targetToken = 'INTEGRATION_SECRET_TOKEN_' + 'x'.repeat(18);
  readonly channels: OracleChannel[];
  readonly inputs: OracleInput[] = [];
  readonly requests: { action: string; operationId?: string; channelId?: string }[] = [];
  readonly delivered: OracleDelivery[] = [];
  readonly receipts = new Map<string, { hash: string; result: Record<string, unknown> }>();
  status = 'running';
  authorized = true;
  dropNextSend: 'before' | 'after' | 'afterEffect' | undefined;
  beforeSend?: (operationId: string) => void | Promise<void>;
  beforeInspect?: () => void | Promise<void>;
  nextSeq = 0;
  private tokenGeneration = 0;

  constructor(channelCount = 2) {
    this.channels = Array.from({ length: channelCount }, (_, index) => ({
      id: `channel-${index}`, name: `Synthetic channel ${index}`, kind: index % 2 ? 'group' : 'direct',
      // Every channel shares SHIYU and HUMAN. Their presence must not merge the
      // conversations or grant access to the other channels' history.
      memberIds: index % 2 ? ['SHIYU', 'HUMAN', `actor-${index}`] : ['SHIYU', 'HUMAN'],
    }));
  }

  input(channelId: string, text: string, eventId = `${this.runId}:e${this.nextSeq + 1}`, actorId = 'HUMAN'): OracleInput {
    assert.ok(this.channels.some(channel => channel.id === channelId && channel.memberIds.includes(actorId)));
    const seq = ++this.nextSeq;
    const value: OracleInput = { seq, evaluationMode: 'outcome', event: {
      id: eventId, seq, runId: this.runId, at: new Date().toISOString(), type: 'input.message', role: 'world',
      actorId, channelId, text, data: {},
    } };
    this.inputs.push(value);
    return value;
  }

  rotateToken(): void {
    this.targetToken = createHash('sha256').update(`synthetic-rotated-token-${++this.tokenGeneration}`).digest('base64url');
    this.authorized = true;
  }

  private view() {
    return { runId: this.runId, status: this.status, self: { actorId: 'SHIYU' }, evaluationMode: 'outcome',
      actors: [...new Set(this.channels.flatMap(channel => channel.memberIds))].map(id => ({ id, name: id, department: 'Synthetic', title: 'Fixture', color: '#123456' })),
      channels: structuredClone(this.channels), tasks: [], readableFiles: [], protocol: { actions: ['message.send'] },
      instructions: 'Synthetic public protocol fixture; no live host or model.' };
  }

  /** A new object models a replaced public service, while the remote ledger survives. */
  service() {
    const service = { closed: false, collaboration: { externalCall: async (runId: string, token: string, raw: unknown, signal?: AbortSignal): Promise<unknown> => {
      signal?.throwIfAborted();
      if (service.closed || !this.authorized || runId !== this.runId || token !== this.targetToken) throw new Error('Synthetic public target authentication rejected');
      assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
      const request = raw as Record<string, unknown>;
      this.requests.push({ action: String(request.action), ...(typeof request.operationId === 'string' ? { operationId: request.operationId } : {}) });
      if (request.action === 'connect') return { connection: { runId, kind: 'http', status: 'connected', connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }, view: this.view() };
      if (request.action === 'inspect') { await this.beforeInspect?.(); return this.view(); }
      if (request.action === 'disconnect') { this.authorized = false; return { disconnected: true }; }
      if (request.action === 'inputs') {
        const after = Number(request.after ?? 0);
        const available = this.inputs.filter(input => input.seq > after), inputs = available.slice(0, 30);
        return { status: this.status, inputs: structuredClone(inputs), nextAfter: inputs.at(-1)?.seq ?? after, hasMore: available.length > inputs.length };
      }
      if (request.action === 'message.receipt') {
        const matches = this.delivered.filter(event => event.operationId === request.operationId);
        const match = matches[0];
        const status = matches.length === 0 ? 'not_found'
          : matches.length === 1 && match!.channelId === request.channelId && digest(match!.text) === request.bodyHash ? 'delivered' : 'ambiguous';
        return { status, runId, operationId: request.operationId, channelId: request.channelId, bodyHash: request.bodyHash,
          ...(status === 'delivered' ? { eventId: match!.eventId, observedAt: match!.at } : {}) };
      }
      assert.equal(request.action, 'act', 'Only the public target message action is exposed');
      assert.equal(typeof request.operationId, 'string');
      const operationId = request.operationId as string;
      const action = request.operation as Record<string, unknown>;
      assert.equal(action.type, 'message.send');
      assert.equal(typeof action.text, 'string');
      assert.ok(this.channels.some(channel => channel.id === action.channelId));
      const hash = digest(JSON.stringify(action));
      const previous = this.receipts.get(operationId);
      if (previous) {
        if (previous.hash !== hash) throw new Error('Synthetic idempotency content conflict');
        return structuredClone(previous.result);
      }
      if (this.status !== 'running' && this.status !== 'draining') throw new Error('Synthetic sealed run rejects new effects');
      await this.beforeSend?.(operationId);
      signal?.throwIfAborted();
      const drop = this.dropNextSend; this.dropNextSend = undefined;
      if (drop === 'before') throw new Error('Synthetic transport loss before remote execution');
      const eventId = `${this.runId}:e${++this.nextSeq}`;
      this.delivered.push({ runId, operationId, eventId, channelId: action.channelId as string, text: action.text as string, actionHash: hash, at: new Date().toISOString() });
      const result = { ok: true, data: { delivered: true, channelId: action.channelId, eventId, attachments: [] } };
      if (drop === 'afterEffect') throw new Error('Synthetic crash after durable delivery before operation receipt');
      this.receipts.set(operationId, { hash, result });
      if (drop === 'after') throw new Error('Synthetic transport loss after durable remote delivery');
      return structuredClone(result);
    } } };
    return service;
  }

  assertAtMostOnce(): void {
    assert.equal(new Set(this.delivered.map(event => event.operationId)).size, this.delivered.length, 'Remote ledger contains a repeated actual delivery');
  }
}

type NativeRequest = Parameters<LocalReplySessionDriver['generateReply']>[0];
/** The native fixture owns its own message bodies; the control DB must not. */
export class IntegrationSessions implements LocalReplySessionDriver {
  readonly requests: NativeRequest[] = [];
  readonly modelCalls: { sessionId: string; prompt: string; text: string }[] = [];
  readonly drafts = new Map<string, ReplyDraftReadResult>();
  readonly draftReads: ReplyDraftReadRequest[] = [];
  beforeStep?: (request: NativeRequest) => void | Promise<void>;
  afterModel?: (request: NativeRequest) => void | Promise<void>;
  beforeDraftRead?: (request: ReplyDraftReadRequest) => void | Promise<void>;
  accountingComplete = true;

  async generateReply(request: NativeRequest): Promise<ReplyResult & { accounting: ReplyAccounting }> {
    this.requests.push(request);
    const call = this.requests.length;
    const sessionId = request.context.expectedSessionId ?? `shiyu-replyer-integration-${digest(request.businessId).slice(0, 24)}`;
    const native = {
      operationId: request.context.operationId, contextTokenId: request.context.contextTokenId, sessionEpoch: request.context.sessionEpoch,
      key: sessionBindingKey('replyer', request.businessId, request.scope), businessId: request.businessId, scope: request.scope,
      sessionId, messageId: `native-input-${call}`, messageHash: digest(request.prompt),
    };
    await request.context.authorize({ phase: 'admission', ...native });
    await request.context.onBound(native);
    await this.beforeStep?.(request);
    request.signal?.throwIfAborted();
    await request.context.authorize({ phase: 'pre_step', ...native });
    const markers = [...new Set(request.prompt.match(/INPUT_CHANNEL_[0-9]+_[A-Z0-9_]+/g) ?? [])];
    const text = `SYNTHETIC_DRAFT_BODY_${call}: ${markers.join(' ') || 'current authorized question'}`;
    this.modelCalls.push({ sessionId, prompt: request.prompt, text });
    const confirmedAt = new Date().toISOString();
    const contextReceipt = { ...native, userMessageSeq: call * 10 + 1, confirmedAt, durability: 'confirmed' as const };
    await request.context.authorize({ phase: 'context_ack', ...native });
    await request.context.onContextDurable(contextReceipt);
    const assistantRef = { sessionId, eventSeq: call * 10 + 2, messageId: `native-assistant-${call}` };
    const usage = this.accountingComplete
      ? { status: 'reported' as const, inputTokens: 30, outputTokens: 10, totalTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }
      : { status: 'unknown' as const };
    const binding = { key: native.key, role: 'replyer' as const, businessId: request.businessId, scope: request.scope, sessionId,
      model: defaultModel('replyer'), status: 'idle' as const, createdAt: confirmedAt, updatedAt: confirmedAt, usage };
    this.drafts.set(assistantRef.messageId, { text, binding, assistantRef });
    await this.afterModel?.(request);
    request.signal?.throwIfAborted();
    await request.context.authorize({ phase: 'release', ...native });
    const evidenceRef = `shiyu-reply-primary:${digest(assistantRef.messageId)}`;
    const accounting: ReplyAccounting = this.accountingComplete
      ? { complete: true, tokens: 40, calls: 1, evidenceRef, scope: 'observed-primary' }
      : { complete: false, evidenceRef, scope: 'observed-primary' };
    return { text, binding, usage, contextReceipt, assistantRef, accounting };
  }

  async readReplyDraft(request: ReplyDraftReadRequest): Promise<ReplyDraftReadResult> {
    this.draftReads.push(request);
    request.signal?.throwIfAborted();
    await this.beforeDraftRead?.(request);
    const saved = this.drafts.get(request.assistantRef.messageId);
    assert.ok(saved, 'Only an exact previously persisted native draft may be read');
    assert.deepEqual(saved.assistantRef, request.assistantRef);
    assert.equal(saved.binding.businessId, request.businessId);
    assert.equal(saved.binding.scope, request.scope);
    assert.equal(digest(saved.text), request.textSha256);
    request.signal?.throwIfAborted();
    return structuredClone(saved);
  }
}
