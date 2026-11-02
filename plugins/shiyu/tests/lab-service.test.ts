import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ControlStore } from '../src/adapters/control-store/index.js';
import type { LabConnectionDetail, LabReply, LabSendPlan } from '../src/contracts/lab.js';
import type { LabInputEvent, LabRoomView, LabSendRequest } from '../src/adapters/lab/index.js';
import type { LocalReplyInput, LocalReplyOptions, LocalReplyResult, LocalReplySessionDriver } from '../src/control/local-reply.js';
import { LabService, type LabServiceOptions, type LabTargetPort } from '../src/control/lab.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const token = 'A'.repeat(43);
const stamp = '2026-11-02T12:00:00.000Z';
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('bounded fixture condition did not settle'); }

/** A metadata ledger fixture. Real SQLite/Conversation/Effect wiring is covered
 * independently in lab-integration.test.ts. No fixture calls a model or host. */
class Ledger {
  detail?: LabConnectionDetail;
  calls: Array<{ command: string; args: any }> = [];
  replies: LabReply[] = [];
  sends: LabSendPlan[] = [];
  failPause = false;
  get(): LabConnectionDetail { assert.ok(this.detail); this.detail.replies = this.replies; this.detail.sends = this.sends; return clone(this.detail); }
  assertReply(permit: any): LabReply {
    const detail = this.get(), reply = this.replies.find(value => value.replyId === permit.replyId)!;
    const channel = detail.channels.find(value => value.channelId === permit.channelId)!;
    if (detail.status !== 'connected' || detail.epoch !== permit.connectionEpoch || channel.inputVersion !== permit.inputVersion || !reply || !['claimed', 'accounted'].includes(reply.status)) throw Object.assign(new Error('stale'), { code: 'LAB_STALE' });
    return reply;
  }
  async request(command: string, args: any): Promise<any> {
    this.calls.push({ command, args: clone(args) });
    switch (command) {
      case 'lab.connect': {
        if (this.detail?.requestId === args.requestId) return { ...this.get(), duplicate: true };
        this.replies = []; this.sends = [];
        this.detail = { connectionId: 'lab-connection', requestId: args.requestId, runId: args.runId, version: 1, epoch: 1,
          status: 'connected', mandateId: 'grant', budget: args.budget, expiresAt: args.expiresAt,
          channels: args.channels.map((channel: any) => ({ ...channel, conversationId: `conversation-${channel.channelId}`, inputVersion: 0, cursor: 0, pendingInputs: [] })),
          createdAt: stamp, updatedAt: stamp, balance: { limits: args.budget, spent: { tokens: 0, calls: 0, effects: 0 }, held: { tokens: 0, calls: 0, effects: 0 }, available: args.budget }, replies: [], sends: [] };
        return { ...this.get(), duplicate: false };
      }
      case 'lab.get': return this.get();
      case 'lab.snapshot': return this.detail ? [this.get()] : [];
      case 'lab.ingest': {
        assert.equal(this.detail?.status, 'connected');
        for (const event of args.events) {
          const channel = this.detail!.channels.find(value => value.channelId === event.channelId)!;
          if (event.seq <= channel.cursor) continue;
          channel.pendingInputs.push(event); channel.latestInput = event; channel.cursor = event.seq; channel.inputVersion++; this.detail!.version++;
        }
        return this.get();
      }
      case 'lab.claimReply': {
        const channel = this.detail!.channels.find(value => value.channelId === args.channelId)!;
        if (!channel.latestInput || this.replies.some(value => value.anchorEventId === channel.latestInput!.eventId)) return undefined;
        if (channel.pendingInputs.length > 8 || channel.pendingInputs.reduce((sum, ref) => sum + ref.bodyBytes, 0) > 16384) throw Object.assign(new Error('group exceeds bound'), { code: 'LAB_GROUP_TOO_LARGE' });
        const refs = channel.pendingInputs;
        const replyId = `reply-${channel.channelId}-${channel.latestInput.seq}`;
        const reply = { replyId, connectionId: this.detail!.connectionId, channelId: args.channelId, conversationId: channel.conversationId,
          anchorEventId: channel.latestInput.eventId, inputRefs: refs,
          permit: { replyId, connectionId: this.detail!.connectionId, channelId: args.channelId, connectionEpoch: this.detail!.epoch,
            inputVersion: channel.inputVersion, anchorEventId: channel.latestInput.eventId, claimToken: 'PRIVATE_CLAIM', authorization: {}, installationGeneration: 'install', hostEpoch: 'host', leaseExpiresAt: '2026-11-02T12:10:00.000Z' },
          status: 'claimed', reservation: { state: 'reserved', amount: { tokens: 8192, calls: 2, effects: 0 } }, createdAt: stamp } as LabReply;
        this.replies.push(reply); return clone(reply);
      }
      case 'lab.assertReply': return clone(this.assertReply(args.permit));
      case 'lab.recordReplyAccounting': {
        const reply = this.replies.find(value => value.replyId === args.permit.replyId)!;
        reply.status = args.complete ? 'accounted' : 'unknown'; reply.reservation.state = args.complete ? 'settled' : 'unknown';
        if (args.complete) reply.reservation.observed = { tokens: args.tokens, calls: args.calls, effects: 0 };
        return clone(reply);
      }
      case 'lab.markReplyUnknown': {
        const reply = this.replies.find(value => value.replyId === args.permit.replyId)!;
        if (reply.status === 'claimed') { reply.status = 'unknown'; reply.reservation.state = 'unknown'; }
        reply.reasonCode = args.reasonCode; return clone(reply);
      }
      case 'lab.prepareSend': {
        const reply = this.assertReply(args.permit); assert.equal(reply.status, 'accounted');
        const opId = `send-${reply.replyId}`;
        const send = { opId, connectionId: reply.connectionId, channelId: reply.channelId, replyId: reply.replyId, draftOperationId: args.draftOperationId,
          bodyHash: args.bodyHash, bodyBytes: args.bodyBytes, conversationGeneration: reply.permit.inputVersion,
          effect: { effectId: opId, status: 'dispatching', version: 1 }, claim: { effectId: opId, attempt: 1, leaseExpiresAt: '2026-11-02T12:10:00.000Z' },
          reservation: { state: 'reserved', amount: { tokens: 0, calls: 0, effects: 1 } }, canReconcile: false } as LabSendPlan;
        this.sends.push(send); reply.sendId = opId; return clone(send);
      }
      case 'lab.assertSend': {
        const send = this.sends.find(value => value.opId === args.opId)!; assert.equal(send.effect.status, 'dispatching');
        this.assertReply(this.replies.find(value => value.replyId === send.replyId)!.permit); return clone(send);
      }
      case 'lab.markSendUnknown': {
        const send = this.sends.find(value => value.opId === args.opId)!;
        if (send.effect.status !== 'succeeded') { send.effect.status = 'unknown'; send.canReconcile = true; send.reservation.state = 'unknown'; }
        return clone(send);
      }
      case 'lab.reconcileSend': {
        const send = this.sends.find(value => value.opId === args.opId)!;
        assert.equal(args.expectedVersion, this.detail!.version); assert.equal(send.effect.status, 'unknown'); return clone(send);
      }
      case 'lab.recordSendReceipt': {
        const send = this.sends.find(value => value.opId === args.opId)!;
        if (send.effect.status === 'unknown') assert.equal(args.reconciliation, true);
        send.effect.status = 'succeeded'; send.observation = args.observation; send.canReconcile = false; send.reservation.state = 'settled';
        const reply = this.replies.find(value => value.replyId === send.replyId)!; reply.status = 'sent';
        const answered = new Set(reply.inputRefs.map(value => value.eventId));
        this.detail!.channels.find(value => value.channelId === send.channelId)!.pendingInputs = this.detail!.channels.find(value => value.channelId === send.channelId)!.pendingInputs.filter(value => !answered.has(value.eventId));
        this.detail!.version++; return clone(send);
      }
      case 'lab.pause': case 'lab.disconnect': {
        if (this.failPause && command === 'lab.pause') throw new Error('fence failed');
        if (args.expectedVersion !== undefined) assert.equal(args.expectedVersion, this.detail!.version);
        this.detail!.status = command === 'lab.pause' ? 'paused' : 'disconnected'; this.detail!.epoch++; this.detail!.version++;
        for (const reply of this.replies) if (reply.status === 'claimed') { reply.status = 'unknown'; reply.reservation.state = 'unknown'; }
        for (const send of this.sends) if (send.effect.status === 'dispatching') { send.effect.status = 'unknown'; send.canReconcile = true; }
        return this.get();
      }
      default: throw new Error(`unexpected fixture command ${command}`);
    }
  }
}
function fixture(options: { accounting?: boolean; slots?: number; run?: (input: LocalReplyInput, options: LocalReplyOptions) => Promise<void> } = {}) {
  const ledger = new Ledger(), inputs: LabInputEvent[] = [], deliveries = new Map<string, any>(), modelInputs: LocalReplyInput[] = [];
  let runtimeAllowed = true, slots = options.slots ?? 2, used = 0, released = 0, adapterConnects = 0, polls = 0, sends = 0, observes = 0, draftReads = 0, closes = 0;
  let loseResponse = false, failConnect = false, lastReadOnly = false, beforeDispatch: (() => Promise<void>) | undefined, afterBeforeDispatch: (() => void) | undefined, afterSend: (() => Promise<void>) | undefined;
  const room: LabRoomView = { runId: 'run-1', status: 'running', selfActorId: 'SHIYU', actors: [{ actorId: 'SHIYU', name: 'Target' }, { actorId: 'HUMAN', name: 'Human' }],
    channels: ['C1', 'C2', 'C3'].map(channelId => ({ channelId, name: channelId, kind: 'direct', memberIds: ['HUMAN', 'SHIYU'], membersDigest: hash('members') })), membershipHash: hash('room') };
  const adapter: LabTargetPort = {
    async connect(request) { adapterConnects++; lastReadOnly = request.readOnly === true; assert.equal(request.token, token); if (failConnect) throw new Error('fixture connect failed'); return clone(room); },
    async inspect() { return clone(room); },
    async inputs(request) { polls++; const page = inputs.filter(value => value.seq > request.after).slice(0, request.limit); return { status: room.status, inputs: clone(page), nextAfter: page.at(-1)?.seq ?? request.after, hasMore: false }; },
    async send(request: LabSendRequest) {
      await beforeDispatch?.(); await request.beforeDispatch?.(); afterBeforeDispatch?.(); request.assertDispatch?.(); request.signal?.throwIfAborted(); sends++;
      const receipt = { status: 'delivered' as const, ok: true as const, delivered: true as const, runId: room.runId, operationId: request.operationId,
        channelId: request.channelId, eventId: `run-1:e${1000 + sends}`, bodyHash: hash(request.text), observedAt: stamp };
      deliveries.set(request.operationId, receipt); await afterSend?.();
      return loseResponse ? { status: 'unknown', ok: false, runId: room.runId, operationId: request.operationId, channelId: request.channelId, code: 'LAB_SEND_UNCONFIRMED' } : receipt;
    },
    async observeSend(request) { observes++; return deliveries.get(request.operationId) ?? { status: 'not_found', runId: room.runId, operationId: request.operationId, channelId: request.channelId, bodyHash: request.bodyHash }; },
    async disconnect() { return { disconnected: true }; }, close() { closes++; },
  };
  const serviceOptions: LabServiceOptions = { store: ledger as unknown as ControlStore, sessions: {} as LocalReplySessionDriver, adapterFactory: () => ({ ...adapter }),
    now: () => new Date(stamp), pollIntervalMs: 30000, assertRuntimeAllowed: () => { if (!runtimeAllowed) throw Object.assign(new Error('paused'), { code: 'RUNTIME_PAUSED' }); },
    tryAcquireActivity: ({ signal }) => { if (used >= slots) return undefined; used++; let done = false; return { signal, release: () => { assert.equal(done, false); done = true; used--; released++; } }; },
    replyFactory: trusted => ({
      async run(input) {
        assert.equal(trusted.allowEmptyContext, true); assert.equal(trusted.memory, undefined); assert.equal(trusted.maxInputBytes, 32768);
        await trusted.authorize!({ conversationId: input.conversationId, inputId: input.inputId, phase: 'start', signal: input.signal! });
        modelInputs.push(input); await options.run?.(input, trusted);
        await trusted.authorize!({ conversationId: input.conversationId, inputId: input.inputId, phase: 'ready', signal: input.signal! });
        const text = 'Synthetic bounded reply';
        return { duplicate: false, operation: { operationId: `draft-${input.inputId}`, status: 'ready', textSha256: hash(text) },
          reply: { text, usage: { status: 'reported', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            ...(options.accounting === false ? {} : { accounting: { scope: 'observed-primary', complete: true, tokens: 15, calls: 1, evidenceRef: `native:${input.inputId}` } }) } } as unknown as LocalReplyResult;
      },
      async readReadyDraft() { draftReads++; throw new Error('receipt observation must not read native body'); },
      async close() {},
    }) };
  const service = new LabService(serviceOptions);
  const connect = (channelIds = ['C1']) => service.connect({ requestId: 'request-1', runId: 'run-1', targetToken: token, channelIds,
    budget: { tokens: 131072, calls: 20, effects: 20 }, expiresAt: '2026-11-02T13:00:00.000Z' });
  const input = (channelId = 'C1', text = 'PRIVATE_INPUT_BODY') => { const seq = inputs.length + 1; inputs.push({ eventId: `run-1:e${seq}`, seq, runId: 'run-1', type: 'input.message', actorId: 'HUMAN', channelId, text }); };
  return { service, ledger, adapter, connect, input, modelInputs, deliveries,
    counts: () => ({ adapterConnects, polls, sends, observes, draftReads, closes, used, released, lastReadOnly }),
    setRuntime: (allowed: boolean) => { runtimeAllowed = allowed; }, setSlots: (value: number) => { slots = value; },
    loseResponse: () => { loseResponse = true; }, failConnect: () => { failConnect = true; }, setRoomStatus: (status: LabRoomView['status']) => { room.status = status; },
    beforeDispatch: (hook: () => Promise<void>) => { beforeDispatch = hook; }, afterBeforeDispatch: (hook: () => void) => { afterBeforeDispatch = hook; }, afterSend: (hook: () => Promise<void>) => { afterSend = hook; } };
}

test('construction/snapshot are network-free, explicit connect reserves no model, and projection omits secrets', async t => {
  const f = fixture(); t.after(() => f.service.close());
  assert.deepEqual((await f.service.snapshot()).connections, []); assert.equal(f.counts().adapterConnects, 0);
  await f.connect(); await f.service.drain(); const before = f.counts().polls;
  const snapshot = await f.service.snapshot(); assert.equal(f.counts().polls, before); assert.equal(f.modelInputs.length, 0);
  assert.equal(JSON.stringify(snapshot).includes(token), false);
  assert.equal(f.ledger.calls.some(call => JSON.stringify(call.args).includes(token)), false);
});

test('bounded group uses one anchor once, full observed usage settles before one actual delivery', async t => {
  const f = fixture(); t.after(() => f.service.close()); for (let i = 0; i < 8; i++) f.input();
  await f.connect(); await f.service.drain(); await f.service.pollOnce(); await f.service.drain();
  assert.equal(f.modelInputs.length, 1); assert.equal(f.ledger.replies[0]!.inputRefs.length, 8); assert.equal(f.counts().sends, 1);
  assert.match(f.modelInputs[0]!.text, /"actorId":"HUMAN"/); assert.match(f.modelInputs[0]!.text, /"channelId":"C1"/);
  assert.match(f.modelInputs[0]!.text, /"eventId":"run-1:e1"/); assert.match(f.modelInputs[0]!.text, /"type":"input.message"/);
  assert.equal(f.ledger.replies[0]!.status, 'sent'); assert.deepEqual(f.ledger.replies[0]!.reservation.observed, { tokens: 15, calls: 1, effects: 0 });
  const state = await f.service.snapshot(); assert.equal(state.connections[0]!.sends[0]!.status, 'succeeded');
  assert.equal(JSON.stringify(state).includes('PRIVATE_INPUT_BODY'), false); assert.equal(JSON.stringify(state).includes('PRIVATE_CLAIM'), false);
  assert.equal(f.ledger.calls.some(call => JSON.stringify(call.args).includes('PRIVATE_INPUT_BODY')), false);
});

test('token-only usage stays held unknown and polling cannot retry the anchor or send', async t => {
  const f = fixture({ accounting: false }); t.after(() => f.service.close()); f.input();
  await f.connect(); await f.service.drain(); for (let i = 0; i < 3; i++) await f.service.pollOnce(); await f.service.drain();
  assert.equal(f.modelInputs.length, 1); assert.equal(f.counts().sends, 0); assert.equal(f.ledger.replies[0]!.status, 'unknown');
  assert.equal(f.ledger.replies[0]!.reservation.state, 'unknown');
  const usage = f.ledger.calls.find(call => call.command === 'lab.recordReplyAccounting')!.args;
  assert.equal(usage.complete, false); assert.equal(usage.tokens, 15); assert.equal('calls' in usage, false);
});

test('polling accepts newer input while native work waits, commits fence before cancelling, and never releases the old draft', async t => {
  const blocker = deferred(); const f = fixture({ run: async input => { if (input.inputId.endsWith('-1')) await blocker.promise; } });
  t.after(() => f.service.close()); f.input(); await f.connect(); await until(() => f.modelInputs.length === 1);
  f.input('C1', 'second private message'); await f.service.pollOnce();
  assert.equal(f.modelInputs[0]!.signal!.aborted, true); assert.equal(f.ledger.detail!.channels[0]!.inputVersion, 2);
  blocker.resolve(); await f.service.drain();
  assert.equal(f.modelInputs.length, 2); assert.equal(f.counts().sends, 1); assert.equal(f.ledger.replies[0]!.status, 'unknown'); assert.equal(f.ledger.replies[1]!.status, 'sent');
});

test('shared capacity is acquired synchronously before any reply claim; channels remain isolated', async t => {
  const f = fixture({ slots: 0 }); t.after(() => f.service.close()); f.input('C1'); f.input('C2');
  await f.connect(['C1', 'C2']); await f.service.drain(); assert.equal(f.ledger.replies.length, 0);
  f.setSlots(2); await f.service.pollOnce(); await f.service.drain();
  assert.equal(f.modelInputs.length, 2); assert.notEqual(f.modelInputs[0]!.conversationId, f.modelInputs[1]!.conversationId);
  assert.equal(f.counts().used, 0); assert.equal(f.counts().sends, 2);
});

test('pause fence is committed before abort; failed fence does not report paused', async t => {
  const blocker = deferred(); const f = fixture({ run: async () => blocker.promise }); t.after(() => f.service.close());
  f.input(); await f.connect(); await until(() => f.modelInputs.length === 1);
  f.ledger.failPause = true;
  await assert.rejects(f.service.pause({ connectionId: 'lab-connection', expectedVersion: f.ledger.detail!.version }), /fence failed/);
  assert.equal(f.modelInputs[0]!.signal!.aborted, false); f.ledger.failPause = false;
  f.modelInputs[0]!.signal!.addEventListener('abort', () => assert.equal(f.ledger.detail!.status, 'paused'), { once: true });
  const result = await f.service.pause({ connectionId: 'lab-connection', expectedVersion: f.ledger.detail!.version });
  assert.equal(result.connection.status, 'paused'); assert.equal(result.connection.live, true); blocker.resolve(); await f.service.drain(); assert.equal(f.counts().sends, 0);
});

test('lost delivery response is reconciled only through metadata lookup, even after pause, without body/model/send replay', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.loseResponse(); f.input(); await f.connect(); await f.service.drain();
  assert.equal(f.ledger.sends[0]!.effect.status, 'unknown'); assert.equal(f.deliveries.size, 1);
  await f.service.pause({ connectionId: 'lab-connection', expectedVersion: f.ledger.detail!.version }); f.setRuntime(false);
  const result = await f.service.reconcile({ connectionId: 'lab-connection', sendId: f.ledger.sends[0]!.opId, expectedVersion: f.ledger.detail!.version });
  assert.equal(result.connection.sends[0]!.status, 'succeeded'); assert.equal(f.counts().sends, 1); assert.equal(f.counts().observes, 1); assert.equal(f.counts().draftReads, 0); assert.equal(f.modelInputs.length, 1);
});

test('receipt not_found retains unknown and never authorizes another act', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.loseResponse(); f.input(); await f.connect(); await f.service.drain(); f.deliveries.clear();
  const result = await f.service.reconcile({ connectionId: 'lab-connection', sendId: f.ledger.sends[0]!.opId, expectedVersion: f.ledger.detail!.version });
  assert.equal(result.connection.sends[0]!.status, 'unknown'); assert.equal(f.counts().sends, 1); assert.equal(f.counts().observes, 1);
});

test('new input during adapter pre-inspect is denied by the final durable send gate', async t => {
  const f = fixture(); t.after(() => f.service.close());
  f.beforeDispatch(async () => { await f.ledger.request('lab.ingest', { connectionId: 'lab-connection', events: [{ eventId: 'run-1:e99', channelId: 'C1', actorId: 'HUMAN', type: 'input.message', seq: 99, bodyHash: hash('later'), bodyBytes: 5 }] }); });
  f.input(); await f.connect(); await f.service.drain();
  assert.equal(f.counts().sends, 0); assert.equal(f.ledger.sends[0]!.effect.status, 'unknown');
});

test('a confirmed late delivery remains succeeded after pause converted the dispatch to unknown', async t => {
  const response = deferred(); const f = fixture(); t.after(() => f.service.close()); f.afterSend(() => response.promise);
  f.input(); await f.connect(); await until(() => f.counts().sends === 1);
  await f.service.pause({ connectionId: 'lab-connection', expectedVersion: f.ledger.detail!.version }); assert.equal(f.ledger.sends[0]!.effect.status, 'unknown');
  response.resolve(); await f.service.drain(); assert.equal(f.ledger.sends[0]!.effect.status, 'succeeded'); assert.equal(f.ledger.replies[0]!.status, 'sent');
});

test('close aborts and drains only this reply service before returning, without requiring shared Session close', async () => {
  const blocker = deferred(); const f = fixture({ run: async () => blocker.promise }); f.input(); await f.connect(); await until(() => f.modelInputs.length === 1);
  let ended = false; const closing = f.service.close().then(() => { ended = true; });
  await until(() => f.modelInputs[0]!.signal!.aborted === true); assert.equal(f.ledger.detail!.status, 'disconnected'); assert.equal(ended, false);
  blocker.resolve(); await closing; assert.equal(ended, true); assert.equal(f.counts().used, 0); assert.equal(f.counts().sends, 0);
  assert.equal((await f.service.snapshot()).pump.state, 'stopped');
});

test('strict connect inputs reject extra authority fields before adapter I/O', async t => {
  const f = fixture(); t.after(() => f.service.close());
  await assert.rejects(f.service.connect({ requestId: 'r', runId: 'run-1', targetToken: token, channelIds: ['C1'], budget: { tokens: 10, calls: 2, effects: 1 }, expiresAt: '2026-11-02T13:00:00.000Z', actor: 'owner' } as any), /LAB_INVALID_INPUT/);
  assert.equal(f.counts().adapterConnects, 0);
});

test('committed global pause notification stops polls, keeps receipt transport, and never auto-resumes on Runtime resume', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.connect(); await f.service.drain();
  await f.ledger.request('lab.pause', { connectionId: 'lab-connection' }); f.service.onRuntimePaused();
  const count = f.counts().polls; f.input(); f.setRuntime(true); await f.service.pollOnce(); await f.service.drain();
  assert.equal(f.counts().polls, count); assert.equal(f.modelInputs.length, 0); assert.equal((await f.service.snapshot()).connections[0]!.live, true);
});

test('terminal room stops generation but preserves the original transport for a lost delivery receipt', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.loseResponse(); f.input(); await f.connect(); await f.service.drain();
  f.setRoomStatus('completed'); await f.service.pollOnce();
  assert.equal(f.ledger.detail!.status, 'paused'); assert.equal((await f.service.snapshot()).connections[0]!.sends[0]!.canReconcile, true);
  await f.service.reconcile({ connectionId: 'lab-connection', sendId: f.ledger.sends[0]!.opId, expectedVersion: f.ledger.detail!.version });
  assert.equal(f.counts().sends, 1); assert.equal(f.ledger.sends[0]!.effect.status, 'succeeded');
});

test('exact duplicate attach is read-only and does not poll or resume an existing anchor', async t => {
  const f = fixture(); t.after(() => f.service.close()); await f.connect(); await f.service.drain();
  await f.service.pause({ connectionId: 'lab-connection', expectedVersion: f.ledger.detail!.version });
  const polls = f.counts().polls; f.setRoomStatus('completed');
  const result = await f.connect(); await f.service.drain();
  assert.equal(result.duplicate, true); assert.equal(f.counts().lastReadOnly, true); assert.equal(f.counts().polls, polls); assert.equal(f.modelInputs.length, 0);
});

test('failed replacement preserves the prior paused observation transport and does not revoke its metadata', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.loseResponse(); f.input(); await f.connect(); await f.service.drain();
  await f.service.pause({ connectionId: 'lab-connection', expectedVersion: f.ledger.detail!.version }); f.failConnect();
  await assert.rejects(f.service.connect({ requestId: 'new-request', runId: 'run-1', targetToken: token, channelIds: ['C1'], budget: { tokens: 131072, calls: 20, effects: 20 }, expiresAt: '2026-11-02T13:00:00.000Z' }), /fixture connect failed/);
  assert.equal(f.ledger.detail!.status, 'paused'); assert.equal((await f.service.snapshot()).connections[0]!.sends[0]!.canReconcile, true);
  await f.service.reconcile({ connectionId: 'lab-connection', sendId: f.ledger.sends[0]!.opId, expectedVersion: f.ledger.detail!.version });
  assert.equal(f.counts().sends, 1); assert.equal(f.ledger.sends[0]!.effect.status, 'succeeded');
});

test('oversized pending groups are visibly blocked without cropping input history or starving another channel', async t => {
  const f = fixture(); t.after(() => f.service.close()); for (let i = 0; i < 9; i++) f.input('C1'); f.input('C2');
  await f.connect(['C1', 'C2']); await f.service.drain();
  assert.equal(f.modelInputs.length, 1); assert.equal(f.modelInputs[0]!.conversationId, 'conversation-C2');
  assert.equal(f.ledger.detail!.channels[0]!.pendingInputs.length, 9); assert.equal(f.counts().sends, 1);
  const snapshot = await f.service.snapshot(); assert.equal(snapshot.errorCode, 'LAB_GROUP_TOO_LARGE'); assert.equal(snapshot.connections[0]!.channels[0]!.pendingCount, 9);
});

test('Runtime stop requested while the final DB permit returns prevents the external act before cancellation arrives', async t => {
  const f = fixture(); t.after(() => f.service.close()); const request = f.ledger.request.bind(f.ledger); let assertions = 0;
  f.ledger.request = async (command, args) => { const result = await request(command, args); if (command === 'lab.assertSend' && ++assertions === 2) f.setRuntime(false); return result; };
  f.input(); await f.connect(); await f.service.drain();
  assert.equal(assertions, 2); assert.equal(f.modelInputs[0]!.signal!.aborted, false);
  assert.equal(f.counts().sends, 0); assert.equal(f.ledger.sends[0]!.effect.status, 'unknown');
});

test('the final synchronous dispatch gate rejects a stop after the async callback has fully resolved', async t => {
  const f = fixture(); t.after(() => f.service.close()); f.afterBeforeDispatch(() => f.setRuntime(false));
  f.input(); await f.connect(); await f.service.drain();
  assert.equal(f.counts().sends, 0); assert.equal(f.ledger.sends[0]!.effect.status, 'unknown');
});

test('close between connect async admission and continuation cannot install a live binding or timer', async () => {
  const f = fixture(); const internal = f.service as unknown as { allowed(signal?: AbortSignal): Promise<void>; live?: unknown; timer?: unknown };
  const original = internal.allowed.bind(f.service); let closing: Promise<void> | undefined;
  internal.allowed = async signal => { await original(signal); if (f.ledger.detail && !closing) queueMicrotask(() => { closing ??= f.service.close(); }); };
  await assert.rejects(f.connect(), /LAB_CLOSED/); await closing;
  assert.equal(internal.live, undefined); assert.equal(internal.timer, undefined); assert.ok(f.counts().closes > 0); assert.equal(f.ledger.detail!.status, 'disconnected');
});

test('a body with mismatched actor metadata cannot enter the model prompt even when its text hash matches', async t => {
  const f = fixture(); t.after(() => f.service.close()); const request = f.ledger.request.bind(f.ledger);
  f.ledger.request = async (command, args) => { const result = await request(command, args); if (command === 'lab.claimReply' && result) result.inputRefs[0].actorId = 'OTHER'; return result; };
  f.input(); await f.connect(); await f.service.drain();
  assert.equal(f.modelInputs.length, 0); assert.equal(f.counts().sends, 0); assert.equal(f.ledger.replies[0]!.reasonCode, 'LAB_INPUT_BODY_UNAVAILABLE');
});
