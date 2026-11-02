import { createHash } from 'node:crypto';
import type { ControlStore } from '../adapters/control-store/index.js';
import type { LabTargetAdapter, LabInputEvent, LabRoomView, LabSendResult } from '../adapters/lab/index.js';
import type { Budget } from './policy/mandates.js';
import type { LabConnectionDetail, LabReply, LabReplyPermit, LabSendPlan } from '../contracts/lab.js';
import { LocalReplyService, type LocalReplyOptions, type LocalReplyGateCheck, type LocalReplySessionDriver } from './local-reply.js';

export type LabTargetPort = Pick<LabTargetAdapter, 'connect' | 'inspect' | 'inputs' | 'send' | 'observeSend' | 'disconnect' | 'close'>;
export interface LabActivity {
  signal: AbortSignal;
  update?(phase: string): void;
  release(): void;
}
export interface LabServiceOptions {
  store: ControlStore;
  sessions: LocalReplySessionDriver;
  adapterFactory(): LabTargetPort;
  assertRuntimeAllowed(): void | Promise<void>;
  /** Synchronous shared Runtime admission. Acquire before reserving a reply. */
  tryAcquireActivity(input: { connectionId: string; channelId: string; phase: string; signal: AbortSignal }): LabActivity | undefined;
  now?: () => Date;
  pollIntervalMs?: number;
  /** Trusted fixture seam; production always uses the independent LocalReplyService. */
  replyFactory?(options: LocalReplyOptions): Pick<LocalReplyService, 'run' | 'readReadyDraft' | 'close'>;
}
export interface LabOwnerConnectInput {
  requestId: string; runId: string; targetToken: string; channelIds: string[]; budget: Budget; expiresAt: string;
}
export interface LabOwnerControlInput { connectionId: string; expectedVersion: number }
export interface LabOwnerReconcileInput extends LabOwnerControlInput { sendId: string }
export interface LabPumpState {
  state: 'idle' | 'polling' | 'degraded' | 'stopped'; activeReplies: number;
  lastPollAt?: string; errorCode?: string;
}
export interface LabPublicConnection {
  connectionId: string; requestId: string; runId: string; version: number; epoch: number;
  status: LabConnectionDetail['status']; expiresAt: string; budget: Budget; balance: LabConnectionDetail['balance']; live: boolean;
  channels: Array<Pick<LabConnectionDetail['channels'][number], 'channelId' | 'kind' | 'membersDigest' | 'conversationId' | 'inputVersion' | 'cursor' | 'latestInput'> & { pendingCount: number }>;
  replies: Array<Pick<LabReply, 'replyId' | 'channelId' | 'anchorEventId' | 'status' | 'reasonCode' | 'sendId'> & { reservation: Pick<LabReply['reservation'], 'state' | 'amount' | 'observed'> }>;
  sends: Array<Pick<LabSendPlan, 'channelId' | 'replyId' | 'draftOperationId' | 'bodyHash' | 'bodyBytes' | 'observation'> & { sendId: string; status: LabSendPlan['effect']['status']; canReconcile: boolean }>;
}
interface LiveConnection {
  id: string; epoch: number; adapter: LabTargetPort; room: LabRoomView; controller: AbortController;
  cursor: number; bodies: Map<string, LabInputEvent>; detail: LabConnectionDetail;
}
interface Running {
  live: LiveConnection; reply: LabReply; controller: AbortController; signal: AbortSignal; activity: LabActivity;
}
export class LabServiceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LabServiceError'; }
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,100}$/.test(error.code) ? error.code : 'LAB_OPERATION_UNCONFIRMED';
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
function check(value: unknown, reason: string): asserts value { if (!value) throw new LabServiceError(reason); }
function control(input: LabOwnerControlInput, reconcile = false): void {
  check(input && Object.keys(input).sort().join(',') === (reconcile ? 'connectionId,expectedVersion,sendId' : 'connectionId,expectedVersion')
    && identity(input.connectionId) && Number.isSafeInteger(input.expectedVersion) && input.expectedVersion >= 1, 'LAB_INVALID_INPUT');
}
function publicConnection(detail: LabConnectionDetail, live: boolean, mayObserve: (channelId: string) => boolean = () => live): LabPublicConnection {
  return structuredClone({ connectionId: detail.connectionId, requestId: detail.requestId, runId: detail.runId, version: detail.version, epoch: detail.epoch,
    status: detail.status, expiresAt: detail.expiresAt, budget: detail.budget, balance: detail.balance, live,
    channels: detail.channels.map(({ channelId, kind, membersDigest, conversationId, inputVersion, cursor, latestInput, pendingInputs }) => ({ channelId, kind, membersDigest, conversationId, inputVersion, cursor, latestInput, pendingCount: pendingInputs.length })),
    replies: detail.replies.map(({ replyId, channelId, anchorEventId, status, reasonCode, sendId, reservation }) => ({ replyId, channelId, anchorEventId, status, reasonCode, sendId,
      reservation: { state: reservation.state, amount: reservation.amount, observed: reservation.observed } })),
    sends: detail.sends.map(({ opId, channelId, replyId, draftOperationId, bodyHash, bodyBytes, observation, effect, canReconcile }) => ({ sendId: opId, channelId, replyId, draftOperationId, bodyHash, bodyBytes, observation, status: effect.status, canReconcile: mayObserve(channelId) && canReconcile })) });
}

/** Local authorization and reference ledger only. Lab owns inputs and delivered
 * messages; DSH owns native history. No token or message body crosses the DB port. */
export class LabService {
  private readonly replies: Pick<LocalReplyService, 'run' | 'readReadyDraft' | 'close'>;
  private readonly active = new Map<string, Running>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private live?: LiveConnection;
  private connecting?: AbortController;
  private poll?: Promise<void>;
  private scheduling?: Promise<void>;
  private sendTail: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private closing?: Promise<void>;
  private state: LabPumpState = { state: 'idle', activeReplies: 0 };
  private readonly interval: number;
  constructor(private readonly options: LabServiceOptions) {
    this.interval = options.pollIntervalMs ?? 1000;
    check(Number.isSafeInteger(this.interval) && this.interval >= 10 && this.interval <= 30000, 'LAB_INVALID_CONFIGURATION');
    this.replies = (options.replyFactory ?? (value => new LocalReplyService(value)))({ store: options.store, sessions: options.sessions,
      assertRuntimeAllowed: options.assertRuntimeAllowed, now: options.now, allowEmptyContext: true, maxInputBytes: 32768,
      authorize: check => this.authorize(check) });
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private canObserve(detail: LabConnectionDetail, channelId?: string): boolean {
    return Boolean(this.live && this.live.detail.runId === detail.runId && (channelId === undefined || this.live.detail.channels.some(channel => channel.channelId === channelId)));
  }
  private project(detail: LabConnectionDetail): LabPublicConnection { return publicConnection(detail, this.canObserve(detail), channelId => this.canObserve(detail, channelId)); }
  private open(signal?: AbortSignal): void { check(!this.closed, 'LAB_CLOSED'); signal?.throwIfAborted(); }
  private async allowed(signal?: AbortSignal): Promise<void> { this.open(signal); await this.options.assertRuntimeAllowed(); this.open(signal); }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {}); return work;
  }
  private async authorize(gate: Readonly<LocalReplyGateCheck>): Promise<void> {
    const running = this.active.get(gate.inputId);
    check(running && running.reply.conversationId === gate.conversationId && this.live === running.live, 'LAB_REPLY_NOT_CURRENT');
    running.signal.throwIfAborted(); await this.allowed(gate.signal);
    await this.options.store.request('lab.assertReply', { permit: running.reply.permit });
    running.signal.throwIfAborted(); await this.allowed(gate.signal); running.activity.update?.(`lab.${gate.phase}`);
  }
  connect(input: LabOwnerConnectInput, signal?: AbortSignal): Promise<{ connection: LabPublicConnection; duplicate: boolean }> {
    return this.track(this.connectInner(input, signal));
  }
  private async connectInner(input: LabOwnerConnectInput, signal?: AbortSignal): Promise<{ connection: LabPublicConnection; duplicate: boolean }> {
    check(input && Object.keys(input).sort().join(',') === 'budget,channelIds,expiresAt,requestId,runId,targetToken'
      && identity(input.requestId) && identity(input.runId) && typeof input.targetToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.targetToken)
      && Array.isArray(input.channelIds) && input.channelIds.length > 0 && input.channelIds.length <= 20
      && input.channelIds.every(identity) && new Set(input.channelIds).size === input.channelIds.length
      && input.budget && Object.keys(input.budget).sort().join(',') === 'calls,effects,tokens'
      && Object.values(input.budget).every(value => Number.isSafeInteger(value) && value > 0)
      && typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt)), 'LAB_INVALID_INPUT');
    this.open(signal);
    if (this.live?.detail.status === 'connected' && this.live.detail.requestId === input.requestId) {
      await this.allowed(signal);
      const current = await this.options.store.request('lab.get', { connectionId: this.live.id });
      check(current.runId === input.runId && current.expiresAt === input.expiresAt && (['tokens', 'calls', 'effects'] as const).every(key => current.budget[key] === input.budget[key])
        && JSON.stringify(current.channels.map(channel => channel.channelId)) === JSON.stringify(input.channelIds), 'LAB_IDEMPOTENCY_CONFLICT');
      return { connection: this.project(current), duplicate: true };
    }
    check(!this.connecting && this.live?.detail.status !== 'connected', 'LAB_CONNECTION_ACTIVE');
    const previous = this.live;
    const controller = new AbortController(); this.connecting = controller;
    const combined = AbortSignal.any([controller.signal, this.shutdown.signal, ...(signal ? [signal] : [])]);
    let adapter: LabTargetPort | undefined; let connected: (LabConnectionDetail & { duplicate: boolean }) | undefined;
    try {
      const existing = (await this.options.store.request('lab.snapshot', {})).find(value => value.requestId === input.requestId);
      if (existing) this.open(combined); else await this.allowed(combined);
      adapter = this.options.adapterFactory(); check(adapter !== previous?.adapter, 'LAB_ADAPTER_REUSE');
      const room = await adapter.connect({ runId: input.runId, token: input.targetToken, signal: combined, ...(existing ? { readOnly: true } : {}) });
      if (existing) this.open(combined); else await this.allowed(combined);
      check(existing || ['prepared', 'running', 'draining'].includes(room.status), 'LAB_ROOM_ENDED');
      const channels = input.channelIds.map(channelId => {
        const channel = room.channels.find(value => value.channelId === channelId);
        check(channel && channel.kind !== 'system' && channel.memberIds.includes('SHIYU'), 'LAB_CHANNEL_NOT_AUTHORIZED');
        return { channelId, kind: channel.kind, membersDigest: channel.membersDigest };
      });
      connected = await this.options.store.request('lab.connect', { requestId: input.requestId, runId: input.runId, channels, budget: input.budget, expiresAt: input.expiresAt });
      if (connected.duplicate) this.open(combined); else await this.allowed(combined);
      // close() may run after the async gate resolves but before this continuation.
      this.open(combined);
      if (previous) { this.detach(previous); previous.adapter.close(); }
      this.live = { id: connected.connectionId, epoch: connected.epoch, adapter, room, controller: new AbortController(), cursor: 0, bodies: new Map(), detail: connected };
      this.state = { state: 'idle', activeReplies: this.active.size };
      // A duplicate after restart binds only an owner-supplied observation
      // transport. It never resumes the persisted connection's model authority.
      if (!connected.duplicate && connected.status === 'connected') {
        this.timer = setInterval(() => { void this.pollOnce(); }, this.interval); this.timer.unref(); void this.pollOnce();
      } else this.live.controller.abort(new LabServiceError('LAB_OBSERVATION_ONLY'));
      return { connection: this.project(connected), duplicate: connected.duplicate };
    } catch (error) {
      if (connected && !connected.duplicate) await this.options.store.request('lab.disconnect', { connectionId: connected.connectionId }).catch(() => {});
      adapter?.close(); throw error;
    } finally { if (this.connecting === controller) this.connecting = undefined; }
  }
  /** Waits for one bounded page, never for its model work. */
  pollOnce(): Promise<void> {
    if (this.closed || !this.live || this.live.detail.status !== 'connected') return Promise.resolve();
    if (this.poll) return this.poll;
    const work = Promise.resolve().then(() => this.pollInner()); this.poll = work;
    void work.finally(() => { if (this.poll === work) this.poll = undefined; }).catch(() => {});
    return this.track(work);
  }
  private async pollInner(): Promise<void> {
    const live = this.live; if (!live) return;
    const signal = AbortSignal.any([live.controller.signal, this.shutdown.signal]);
    this.state.state = 'polling';
    try {
      await this.allowed(signal);
      const page = await live.adapter.inputs({ after: live.cursor, limit: 30, waitMs: 0, signal });
      await this.allowed(signal); check(this.live === live, 'LAB_CONNECTION_CHANGED');
      if (!['prepared', 'running', 'draining'].includes(page.status)) { await this.stopLive(live, 'LAB_ROOM_ENDED'); return; }
      const accepted = page.inputs.filter(event => live.detail.channels.some(channel => channel.channelId === event.channelId));
      for (const event of accepted) check(event.runId === live.detail.runId && Buffer.from(event.text, 'utf8').toString('utf8') === event.text && !event.text.includes('\0')
        && Buffer.byteLength(event.text, 'utf8') <= 16384, 'LAB_INPUT_TOO_LARGE');
      const detail = await this.options.store.request('lab.ingest', { connectionId: live.id, events: accepted.map(event => ({ eventId: event.eventId,
        channelId: event.channelId, actorId: event.actorId, type: event.type, seq: event.seq, bodyHash: hash(event.text), bodyBytes: Buffer.byteLength(event.text, 'utf8') })) });
      // The persisted input/version fence precedes cancellation and the transient update.
      for (const running of this.active.values()) if (running.live === live && detail.channels.find(channel => channel.channelId === running.reply.channelId)?.inputVersion !== running.reply.permit.inputVersion) running.controller.abort(new LabServiceError('LAB_INPUT_SUPERSEDED'));
      for (const event of accepted) live.bodies.set(event.eventId, event);
      live.detail = detail; live.cursor = page.nextAfter;
      const retained = new Set(detail.channels.flatMap(channel => channel.pendingInputs.map(event => event.eventId)));
      for (const eventId of live.bodies.keys()) if (!retained.has(eventId)) live.bodies.delete(eventId);
      this.state = { state: 'idle', activeReplies: this.active.size, lastPollAt: this.now().toISOString() };
      await this.schedule(live);
    } catch (error) {
      this.state = { ...this.state, state: this.closed ? 'stopped' : 'degraded', errorCode: code(error), activeReplies: this.active.size };
      if (['LAB_MEMBERSHIP_CHANGED', 'LAB_SERVICE_REPLACED', 'LAB_SERVICE_CLOSED', 'LAB_ROOM_ENDED', 'LAB_INPUT_TOO_LARGE'].includes(code(error))) await this.stopLive(live, code(error));
    }
  }
  private schedule(live: LiveConnection): Promise<void> {
    if (this.scheduling) return this.scheduling;
    const work = this.scheduleInner(live); this.scheduling = work;
    void work.finally(() => { if (this.scheduling === work) this.scheduling = undefined; }).catch(() => {}); return this.track(work);
  }
  private async scheduleInner(live: LiveConnection): Promise<void> {
    for (const channel of live.detail.channels) {
      if (this.closed || this.live !== live || live.detail.status !== 'connected' || live.controller.signal.aborted) return;
      if (!channel.pendingInputs.length || [...this.active.values()].some(value => value.live === live && value.reply.channelId === channel.channelId)) continue;
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, live.controller.signal, this.shutdown.signal]);
      await this.allowed(signal);
      const activity = this.options.tryAcquireActivity({ connectionId: live.id, channelId: channel.channelId, phase: 'lab.claim', signal });
      if (!activity) continue;
      let owned = false;
      try {
        activity.signal.throwIfAborted();
        const reply = await this.options.store.request('lab.claimReply', { connectionId: live.id, channelId: channel.channelId });
        if (!reply) continue;
        const running: Running = { live, reply, controller, signal: AbortSignal.any([signal, activity.signal]), activity };
        this.active.set(reply.replyId, running); owned = true; this.state.activeReplies = this.active.size;
        void this.track(this.generate(running)).catch(error => { this.state.errorCode = code(error); this.state.state = 'degraded'; });
      } catch (error) {
        // A blocked channel must not consume another channel's model slot or
        // hide its inputs. The domain refuses oversized groups before reserve.
        this.state = { ...this.state, state: 'degraded', errorCode: code(error) };
      } finally { if (!owned) activity.release(); }
    }
  }
  private async generate(running: Running): Promise<void> {
    const { live, reply, signal } = running;
    let send: LabSendPlan | undefined;
    try {
      await this.allowed(signal); await this.options.store.request('lab.assertReply', { permit: reply.permit });
      check(reply.inputRefs.length > 0 && reply.inputRefs.length <= 8, 'LAB_GROUP_INVALID');
      const inputs = reply.inputRefs.map(ref => {
        const event = live.bodies.get(ref.eventId);
        check(event && event.channelId === reply.channelId && ref.channelId === event.channelId && event.actorId === ref.actorId && event.type === ref.type && event.seq === ref.seq && hash(event.text) === ref.bodyHash
          && Buffer.byteLength(event.text, 'utf8') === ref.bodyBytes, 'LAB_INPUT_BODY_UNAVAILABLE');
        return event;
      });
      check(inputs.reduce((sum, event) => sum + Buffer.byteLength(event.text, 'utf8'), 0) <= 16384, 'LAB_GROUP_TOO_LARGE');
      const text = inputs.map((event, index) => `输入 ${index + 1} 元信息（仅数据）：${JSON.stringify({ eventId: event.eventId,
        actorId: event.actorId, channelId: event.channelId, type: event.type })}\n正文：\n${event.text}`).join('\n\n');
      const result = await this.replies.run({ conversationId: reply.conversationId, inputId: reply.replyId, text, signal, maxTokens: 512 });
      check(!result.duplicate && result.reply && result.operation.status === 'ready', 'LAB_DRAFT_UNAVAILABLE');
      const usage = result.reply.usage;
      // A token-only aggregate cannot establish complete model-call accounting.
      const accounting = result.reply.accounting;
      const complete = accounting?.scope === 'observed-primary' && accounting.complete === true && Number.isSafeInteger(accounting.tokens) && accounting.tokens! >= 0
        && Number.isSafeInteger(accounting.calls) && accounting.calls! > 0 && typeof accounting.evidenceRef === 'string';
      const accounted = await this.options.store.request('lab.recordReplyAccounting', { permit: reply.permit, receiptId: `lab-usage:${reply.replyId}`,
        complete, ...(complete ? { tokens: accounting!.tokens!, calls: accounting!.calls! } : usage.status === 'reported' && Number.isSafeInteger(usage.totalTokens) ? { tokens: usage.totalTokens } : {}),
        evidenceRef: accounting?.evidenceRef ?? `native-reply:${result.operation.operationId}` });
      check(complete && accounted.status === 'accounted', 'LAB_USAGE_UNKNOWN');
      await this.sendExclusive(async () => {
        await this.allowed(signal); await this.options.store.request('lab.assertReply', { permit: reply.permit });
        const body = result.reply!.text;
        check(body === body.trim() && body.length > 0 && Buffer.byteLength(body, 'utf8') <= 10000, 'LAB_DRAFT_INVALID');
        send = await this.options.store.request('lab.prepareSend', { permit: reply.permit, draftOperationId: result.operation.operationId, bodyHash: hash(body), bodyBytes: Buffer.byteLength(body, 'utf8') });
        const outcome = await this.dispatch(live, send, body, signal, false);
        if (outcome.effect.status !== 'succeeded') this.state = { ...this.state, state: 'degraded', errorCode: 'LAB_SEND_UNCONFIRMED' };
      });
    } catch (error) {
      if (send?.claim) await this.options.store.request('lab.markSendUnknown', { opId: send.opId, claim: send.claim, reasonCode: code(error) }).catch(() => {});
      else await this.options.store.request('lab.markReplyUnknown', { permit: reply.permit, reasonCode: code(error) }).catch(() => {});
      this.state = { ...this.state, state: 'degraded', errorCode: code(error) };
    } finally {
      this.active.delete(reply.replyId); running.activity.release(); this.state.activeReplies = this.active.size;
      // Only unclaimed anchors can win again. Unknown/claimed anchors never replay.
      if (this.live === live && !this.closed) void this.schedule(live).catch(error => { this.state.errorCode = code(error); });
    }
  }
  private sendExclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.sendTail.catch(() => {}).then(work); this.sendTail = result; return result;
  }
  private async dispatch(live: LiveConnection, send: LabSendPlan, body: string, signal: AbortSignal, reconciliation: boolean): Promise<LabSendPlan> {
    await this.allowed(signal); check(this.live === live && send.connectionId === live.id && hash(body) === send.bodyHash && send.claim, 'LAB_SEND_NOT_CURRENT');
    const claim = send.claim;
    await this.options.store.request('lab.assertSend', { opId: send.opId, claim });
    await this.allowed(signal);
    const outcome: LabSendResult = await live.adapter.send({ operationId: send.opId, channelId: send.channelId, text: body, signal,
      beforeDispatch: async () => {
        await this.allowed(signal); check(this.live === live, 'LAB_SEND_NOT_CURRENT');
        await this.options.store.request('lab.assertSend', { opId: send.opId, claim });
        // A Runtime pause may become visible while the Worker is returning its
        // permit, before the durable fence's cancellation notification arrives.
        await this.allowed(signal);
      },
      assertDispatch: () => {
        this.open(signal); check(this.live === live, 'LAB_SEND_NOT_CURRENT');
        // No await is permitted between this final Runtime stop check and the
        // adapter's synchronous identity check / external act invocation.
        const verdict: unknown = this.options.assertRuntimeAllowed();
        if (verdict && (typeof verdict === 'object' || typeof verdict === 'function') && 'then' in verdict) {
          void Promise.resolve(verdict).catch(() => {}); throw new LabServiceError('LAB_ASYNC_DISPATCH_GATE');
        }
        this.open(signal); check(this.live === live, 'LAB_SEND_NOT_CURRENT');
      } });
    if (outcome.status !== 'delivered') return this.options.store.request('lab.markSendUnknown', { opId: send.opId, claim, reasonCode: outcome.code });
    check(outcome.runId === live.detail.runId && outcome.operationId === send.opId && outcome.channelId === send.channelId && outcome.bodyHash === send.bodyHash, 'LAB_RECEIPT_MISMATCH');
    // Delivered is a fact even when a pause/cancel landed during the external call.
    return this.recordDelivery(live, send, outcome, reconciliation);
  }
  private async recordDelivery(live: LiveConnection, send: LabSendPlan, outcome: Extract<LabSendResult, { status: 'delivered' }> | {
    status: 'delivered'; eventId: string; channelId: string; operationId: string; bodyHash: string; observedAt: string;
  }, reconciliation: boolean): Promise<LabSendPlan> {
    check(send.claim, 'LAB_CLAIM_MISSING');
    const detail = await this.options.store.request('lab.get', { connectionId: send.connectionId });
    const current = detail.sends.find(value => value.opId === send.opId); check(current, 'LAB_SEND_MISSING');
    if (current.effect.status === 'succeeded' && current.observation) {
      check(current.observation.eventId === outcome.eventId && current.bodyHash === outcome.bodyHash, 'LAB_RECEIPT_MISMATCH'); return current;
    }
    if (current.effect.status === 'dispatching' && Date.parse(send.claim.leaseExpiresAt) <= this.now().getTime()) {
      await this.options.store.request('lab.markSendUnknown', { opId: send.opId, claim: send.claim, reasonCode: 'LAB_LEASE_EXPIRED' }); reconciliation = true;
    }
    return this.options.store.request('lab.recordSendReceipt', { opId: send.opId, claim: send.claim, observation: { eventId: outcome.eventId,
      channelId: outcome.channelId, opId: outcome.operationId, bodyHash: outcome.bodyHash, observedAt: outcome.observedAt },
      reconciliation: reconciliation || current.effect.status === 'unknown' });
  }
  pause(input: LabOwnerControlInput): Promise<{ connection: LabPublicConnection }> { return this.track(this.control('pause', input)); }
  disconnect(input: LabOwnerControlInput): Promise<{ connection: LabPublicConnection }> { return this.track(this.control('disconnect', input)); }
  private async control(kind: 'pause' | 'disconnect', input: LabOwnerControlInput): Promise<{ connection: LabPublicConnection }> {
    control(input); this.open();
    const detail = await this.options.store.request(kind === 'pause' ? 'lab.pause' : 'lab.disconnect', input);
    const live = this.live?.id === input.connectionId ? this.live : undefined;
    if (live) {
      live.detail = detail; this.abortLive(live);
      if (kind === 'disconnect') { this.detach(live); await live.adapter.disconnect().catch(() => {}); live.adapter.close(); }
    }
    return { connection: this.project(detail) };
  }
  private abortLive(live: LiveConnection): void {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    live.controller.abort(new LabServiceError('LAB_CONNECTION_FENCED')); live.bodies.clear();
    for (const running of this.active.values()) if (running.live === live) running.controller.abort(new LabServiceError('LAB_CONNECTION_FENCED'));
  }
  private detach(live: LiveConnection): void { if (this.live === live) this.live = undefined; this.abortLive(live); }
  private async stopLive(live: LiveConnection, reason: string): Promise<void> {
    if (this.live !== live) return;
    live.detail = await this.options.store.request('lab.pause', { connectionId: live.id });
    if (reason === 'LAB_ROOM_ENDED') this.abortLive(live);
    else { this.detach(live); live.adapter.close(); }
    this.state = { ...this.state, state: 'degraded', errorCode: reason };
  }
  reconcile(input: LabOwnerReconcileInput, signal?: AbortSignal): Promise<{ connection: LabPublicConnection }> {
    control(input, true); check(identity(input.sendId), 'LAB_INVALID_INPUT');
    return this.track(this.reconcileInner(input, signal));
  }
  private async reconcileInner(input: LabOwnerReconcileInput, caller?: AbortSignal): Promise<{ connection: LabPublicConnection }> {
    // Receipt observation cannot generate a message. Runtime pause, draft expiry,
    // or later inputs do not erase a previously delivered effect.
    this.open(caller); const live = this.live; check(live, 'LAB_RECONNECT_REQUIRED');
    const detail = await this.options.store.request('lab.get', { connectionId: input.connectionId });
    check(detail.version === input.expectedVersion, 'LAB_VERSION_CONFLICT');
    const send = detail.sends.find(value => value.opId === input.sendId);
    check(send && send.canReconcile && send.claim && this.canObserve(detail, send.channelId), 'LAB_RECONCILIATION_DENIED');
    const claim = send.claim;
    const signal = AbortSignal.any([this.shutdown.signal, ...(caller ? [caller] : [])]);
    try {
      await this.sendExclusive(async () => {
        this.open(signal); check(this.live === live, 'LAB_RECONNECT_REQUIRED');
        const plan = await this.options.store.request('lab.reconcileSend', { opId: send.opId, claim, expectedVersion: input.expectedVersion });
        const outcome = await live.adapter.observeSend({ operationId: plan.opId, channelId: plan.channelId, bodyHash: plan.bodyHash, signal });
        if (outcome.status === 'delivered') {
          check(outcome.runId === live.detail.runId && outcome.operationId === plan.opId && outcome.channelId === plan.channelId && outcome.bodyHash === plan.bodyHash, 'LAB_RECEIPT_MISMATCH');
          await this.recordDelivery(live, plan, outcome, true);
        } else await this.options.store.request('lab.markSendUnknown', { opId: plan.opId, claim, reasonCode: 'LAB_RECEIPT_UNCONFIRMED' });
      });
      return { connection: this.project(await this.options.store.request('lab.get', { connectionId: input.connectionId })) };
    } catch (error) {
      await this.options.store.request('lab.markSendUnknown', { opId: send.opId, claim, reasonCode: code(error) }).catch(() => {}); throw error;
    }
  }
  /** Drains already admitted work without polling, claiming, or model dispatch. */
  async drain(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  /** Called only after Runtime's shared pause transaction committed. No second
   * fence and no automatic reconnect/resume; receipt transport stays available. */
  onRuntimePaused(): void {
    this.connecting?.abort(new LabServiceError('LAB_RUNTIME_PAUSED'));
    if (this.live) { this.live.detail.status = 'paused'; this.abortLive(this.live); }
    this.state = { ...this.state, state: 'idle', activeReplies: this.active.size };
  }
  async snapshot(): Promise<{ ready: boolean; errorCode?: string; pump: LabPumpState; connections: LabPublicConnection[] }> {
    const connections = await this.options.store.request('lab.snapshot', {});
    return { ready: !this.closed, ...(this.state.errorCode ? { errorCode: this.state.errorCode } : {}), pump: structuredClone(this.state),
      connections: connections.map(detail => this.project(detail)) };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.closing = (async () => {
      const errors: unknown[] = [], live = this.live;
      if (live) { try { await this.options.store.request('lab.disconnect', { connectionId: live.id }); } catch (error) { errors.push(error); } this.detach(live); live.adapter.close(); }
      this.connecting?.abort(new LabServiceError('LAB_CLOSED')); this.shutdown.abort(new LabServiceError('LAB_CLOSED'));
      await this.replies.close(); await Promise.allSettled([...this.pending]);
      this.state = { ...this.state, state: 'stopped', activeReplies: 0 };
      if (errors.length) throw new AggregateError(errors, 'Lab close fence could not be confirmed');
    })(); return this.closing;
  }
}
