import { createHash } from 'node:crypto';

export type LabRunStatus = 'prepared' | 'running' | 'draining' | 'completed' | 'stopped' | 'interrupted' | 'failed';
export interface LabActorView { actorId: string; name: string }
export interface LabChannelView { channelId: string; name: string; kind: 'direct' | 'group' | 'system'; memberIds: string[]; membersDigest: string }
export interface LabRoomView {
  runId: string; status: LabRunStatus; selfActorId: 'SHIYU';
  actors: LabActorView[]; channels: LabChannelView[]; membershipHash: string;
}
export interface LabInputEvent { eventId: string; seq: number; runId: string; type: string; actorId: string; channelId: string; text: string; taskId?: string }
export interface LabInputPage { status: LabRunStatus; inputs: LabInputEvent[]; nextAfter: number; hasMore: boolean }
export interface LabConnectRequest { runId: string; token: string; clientName?: string; readOnly?: boolean; signal?: AbortSignal }
export interface LabInputsRequest { after: number; limit?: number; waitMs?: number; signal?: AbortSignal }
export interface LabSendRequest {
  operationId: string; channelId: string; text: string; toActorId?: string; signal?: AbortSignal;
  /** Trusted controller closure; rechecks authorization after the asynchronous directory read. */
  beforeDispatch?: () => void | Promise<void>;
  /** Final synchronous stop gate. Must return undefined; promises/thenables are rejected. */
  assertDispatch?: () => void;
}
export type LabSendResult =
  | { status: 'delivered'; ok: true; delivered: true; runId: string; operationId: string; channelId: string; eventId: string; bodyHash: string; observedAt: string }
  | { status: 'rejected' | 'unknown'; ok: false; runId: string; operationId: string; channelId: string; code: string };
export interface LabObserveSendRequest { operationId: string; channelId: string; bodyHash: string; signal?: AbortSignal }
export type LabSendObservationResult =
  | { status: 'delivered'; runId: string; operationId: string; channelId: string; bodyHash: string; eventId: string; observedAt: string }
  | { status: 'not_found' | 'ambiguous' | 'unknown'; runId: string; operationId: string; channelId: string; bodyHash: string; code?: string };
export interface LabTargetAdapterOptions {
  ctx?: { get(name: string): unknown };
  /** Trusted composition only. Never an Agent-provided URL or service object. */
  getService?: () => unknown;
  now?: () => Date;
}
export class LabAdapterError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LabAdapterError'; }
}

type RecordValue = Record<string, unknown>;
type PublicService = { closed?: boolean; collaboration: { externalCall(runId: string, token: string, request: unknown, signal?: AbortSignal): unknown } };
type Binding = { service: PublicService; collaboration: PublicService['collaboration']; call: PublicService['collaboration']['externalCall']; runId: string; token: string; readOnly: boolean; abort: AbortController; room?: LabRoomView };
const statuses = new Set<LabRunStatus>(['prepared', 'running', 'draining', 'completed', 'stopped', 'interrupted', 'failed']);
const terminal = new Set<LabRunStatus>(['completed', 'stopped', 'interrupted', 'failed']);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function fail(code: string): never { throw new LabAdapterError(code); }
function check(value: unknown, code = 'LAB_PROTOCOL_INVALID'): asserts value { if (!value) fail(code); }
function record(value: unknown): RecordValue { check(value && typeof value === 'object' && !Array.isArray(value)); return value as RecordValue; }
function string(value: unknown, max: number, empty = false): string {
  check(typeof value === 'string' && value.length <= max && !/[\uD800-\uDFFF]/u.test(value) && !value.includes('\0') && (empty || value.trim().length > 0));
  return value;
}
function entityId(value: unknown): string { const id = string(value, 80); check(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id)); return id; }
function runId(value: unknown): string { const id = string(value, 160); check(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)); return id; }
function eventId(value: unknown, run: string, seq?: number): string {
  const id = string(value, 190), prefix = `${run}:e`;
  check(id.startsWith(prefix) && /^[1-9][0-9]*$/.test(id.slice(prefix.length)));
  const number = Number(id.slice(prefix.length)); check(Number.isSafeInteger(number) && (seq === undefined || number === seq));
  return id;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { check(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max); return value; }
function array(value: unknown, max: number): unknown[] { check(Array.isArray(value) && value.length <= max); return value; }
function unique(values: string[]): void { check(new Set(values).size === values.length); }
function status(value: unknown): LabRunStatus { check(typeof value === 'string' && statuses.has(value as LabRunStatus)); return value as LabRunStatus; }
function roomView(value: unknown, run: string): LabRoomView {
  const raw = record(value); check(raw.runId === run && record(raw.self).actorId === 'SHIYU');
  const actors = array(raw.actors, 66).map(value => { const actor = record(value); return { actorId: entityId(actor.id), name: string(actor.name, 120) }; });
  unique(actors.map(actor => actor.actorId)); const actorIds = new Set(actors.map(actor => actor.actorId)); check(actorIds.has('SHIYU'));
  const channels: LabChannelView[] = array(raw.channels, 65).map(value => {
    const channel = record(value), channelId = entityId(channel.id), kind = channel.kind;
    check(kind === 'direct' || kind === 'group' || kind === 'system');
    const memberIds = array(channel.memberIds, 66).map(entityId); unique(memberIds); check(memberIds.every(id => actorIds.has(id)));
    const sorted = [...memberIds].sort();
    return { channelId, name: string(channel.name, 120), kind: kind as LabChannelView['kind'], memberIds: sorted, membersDigest: hash(JSON.stringify(sorted)) };
  });
  unique(channels.map(channel => channel.channelId));
  const membershipHash = hash(JSON.stringify({ actors: [...actorIds].sort(), channels: channels.map(({ channelId, kind, membersDigest }) => ({ channelId, kind, membersDigest })).sort((a, b) => a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0) }));
  return { runId: run, status: status(raw.status), selfActorId: 'SHIYU', actors, channels, membershipHash };
}
function inputPage(value: unknown, binding: Binding, after: number, limit: number): LabInputPage {
  const raw = record(value); check(typeof raw.hasMore === 'boolean');
  let previous = after;
  const inputs = array(raw.inputs, 30).map(value => {
    const row = record(value), event = record(row.event), seq = integer(row.seq, 1);
    check(seq > previous && event.seq === seq && event.runId === binding.runId); previous = seq;
    const id = eventId(event.id, binding.runId, seq), actorId = entityId(event.actorId), channelId = entityId(event.channelId);
    const channel = binding.room!.channels.find(item => item.channelId === channelId);
    check(actorId !== 'SHIYU' && channel && channel.memberIds.includes(actorId) && channel.memberIds.includes('SHIYU'));
    check(typeof event.type === 'string' && /^input\.(message|request|query|correction|cancel|memory)$/.test(event.type));
    // A public human task prepends a <=200-character title to <=12000 instructions.
    const result: LabInputEvent = { eventId: id, seq, runId: binding.runId, type: event.type, actorId, channelId, text: string(event.text, 16_384) };
    if (event.taskId !== undefined) result.taskId = entityId(event.taskId);
    return result;
  });
  unique(inputs.map(input => input.eventId));
  check(integer(raw.nextAfter, 0) === (inputs.at(-1)?.seq ?? after));
  check(inputs.length > 0 || !raw.hasMore);
  const selected = inputs.slice(0, limit);
  return { status: status(raw.status), inputs: selected, nextAfter: selected.at(-1)?.seq ?? after, hasMore: raw.hasMore || selected.length < inputs.length };
}

/** A narrow same-process client for the Lab public target protocol. No Lab imports. */
export class LabTargetAdapter {
  #getService: () => unknown;
  #now: () => Date;
  #binding?: Binding;
  #closed = false;
  #connecting = false;
  #polling = false;
  #sending = false;
  #dispatched = new Set<string>();
  constructor(options: LabTargetAdapterOptions) {
    check(Boolean(options.getService) !== Boolean(options.ctx), 'LAB_ADAPTER_CONFIGURATION');
    this.#getService = options.getService ?? (() => options.ctx!.get('shiyuGym'));
    this.#now = options.now ?? (() => new Date());
  }
  #service(): PublicService {
    try {
      const value = record(this.#getService());
      check(value.closed !== true, 'LAB_SERVICE_CLOSED');
      check(typeof record(value.collaboration).externalCall === 'function', 'LAB_SERVICE_UNAVAILABLE');
      return value as unknown as PublicService;
    } catch (error) { if (error instanceof LabAdapterError && error.code === 'LAB_SERVICE_CLOSED') throw error; fail('LAB_SERVICE_UNAVAILABLE'); }
  }
  #assert(binding: Binding, signal?: AbortSignal): void {
    check(!this.#closed && this.#binding === binding && !binding.abort.signal.aborted, 'LAB_CONNECTION_CLOSED');
    check(!signal?.aborted, 'LAB_CANCELLED');
    const current = this.#service();
    check(current === binding.service && current.collaboration === binding.collaboration && current.collaboration.externalCall === binding.call, 'LAB_SERVICE_REPLACED');
  }
  #current(signal?: AbortSignal): Binding { const binding = this.#binding; check(binding && binding.room, 'LAB_NOT_CONNECTED'); this.#assert(binding, signal); return binding; }
  #signal(binding: Binding, signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([binding.abort.signal, signal]) : binding.abort.signal; }
  #safe<T>(value: T, binding: Binding): T { check(!JSON.stringify(value).includes(binding.token), 'LAB_PROTOCOL_SECRET_REFLECTION'); return value; }
  #discard(binding: Binding): void { binding.abort.abort(new LabAdapterError('LAB_CONNECTION_CLOSED')); binding.token = ''; if (this.#binding === binding) this.#binding = undefined; }
  async #read(binding: Binding, request: unknown, signal?: AbortSignal): Promise<unknown> {
    this.#assert(binding, signal);
    let value: unknown;
    try { value = await binding.call.call(binding.collaboration, binding.runId, binding.token, request, this.#signal(binding, signal)); }
    catch { this.#assert(binding, signal); fail('LAB_READ_UNCONFIRMED'); }
    this.#assert(binding, signal); return value;
  }
  async #inspect(binding: Binding, signal?: AbortSignal): Promise<LabRoomView> {
    try {
      const view = this.#safe(roomView(await this.#read(binding, { action: 'inspect' }, signal), binding.runId), binding);
      check(!binding.room || view.membershipHash === binding.room.membershipHash, 'LAB_MEMBERSHIP_CHANGED');
      return view;
    } catch (error) { if (error instanceof LabAdapterError) throw error; fail('LAB_INSPECT_UNCONFIRMED'); }
  }
  async connect(request: LabConnectRequest): Promise<LabRoomView> {
    check(!this.#closed && !this.#binding && !this.#connecting, 'LAB_CONNECT_CONFLICT');
    check(!request.signal?.aborted, 'LAB_CANCELLED');
    check(request.readOnly === undefined || typeof request.readOnly === 'boolean', 'LAB_CONNECT_INVALID');
    const run = runId(request.runId), token = string(request.token, 200), clientName = string(request.clientName ?? '识雨', 80);
    check(/^[A-Za-z0-9_-]{43}$/.test(token), 'LAB_TOKEN_INVALID');
    const service = this.#service();
    const binding: Binding = { service, collaboration: service.collaboration, call: service.collaboration.externalCall, runId: run, token, readOnly: request.readOnly === true, abort: new AbortController() };
    this.#connecting = true; this.#binding = binding;
    try {
      const raw = record(await this.#read(binding, binding.readOnly ? { action: 'inspect' } : { action: 'connect', clientName }, request.signal));
      if (!binding.readOnly) {
        const connection = record(raw.connection);
        check(connection.runId === run && connection.kind === 'http' && connection.status === 'connected');
      }
      const view = this.#safe(roomView(binding.readOnly ? raw : raw.view, run), binding);
      check(binding.readOnly || !terminal.has(view.status), 'LAB_ROOM_ENDED');
      binding.room = structuredClone(view); return view;
    } catch (error) { this.#discard(binding); if (error instanceof LabAdapterError) throw error; fail('LAB_CONNECT_UNCONFIRMED'); }
    finally { this.#connecting = false; }
  }
  async inspect(signal?: AbortSignal): Promise<LabRoomView> { return this.#inspect(this.#current(signal), signal); }
  async inputs(request: LabInputsRequest): Promise<LabInputPage> {
    const binding = this.#current(request.signal); check(!binding.readOnly, 'LAB_READ_ONLY');
    const after = integer(request.after, 0), limit = integer(request.limit ?? 30, 1, 30), waitMs = integer(request.waitMs ?? 0, 0, 20_000);
    check(!this.#polling, 'LAB_INPUTS_BUSY'); this.#polling = true;
    try {
      await this.#inspect(binding, request.signal);
      const page = inputPage(await this.#read(binding, { action: 'inputs', after, waitMs }, request.signal), binding, after, limit);
      // The directory can change while a long poll waits. Do not admit stale recipients.
      await this.#inspect(binding, request.signal);
      return this.#safe(page, binding);
    } catch (error) { if (error instanceof LabAdapterError) throw error; fail('LAB_INPUTS_UNCONFIRMED'); }
    finally { this.#polling = false; }
  }
  async send(request: LabSendRequest): Promise<LabSendResult> {
    const binding = this.#current(request.signal); check(!binding.readOnly, 'LAB_READ_ONLY');
    const channelId = entityId(request.channelId), operationId = string(request.operationId, 160), text = string(request.text, 10_000);
    check(/^[A-Za-z0-9_.:-]{1,160}$/.test(operationId) && text === text.trim(), 'LAB_SEND_INVALID');
    const dispatchKey = `${binding.runId}\0${operationId}`;
    check(!this.#dispatched.has(dispatchKey), 'LAB_SEND_ALREADY_DISPATCHED');
    const toActorId = request.toActorId === undefined ? undefined : entityId(request.toActorId);
    check(!this.#sending, 'LAB_SEND_BUSY'); this.#sending = true;
    const base = { runId: binding.runId, operationId, channelId };
    let dispatched = false;
    try {
      const view = await this.#inspect(binding, request.signal);
      check(!terminal.has(view.status), 'LAB_ROOM_ENDED');
      const channel = view.channels.find(item => item.channelId === channelId);
      check(channel && channel.kind !== 'system' && channel.memberIds.includes('SHIYU') && (!toActorId || channel.memberIds.includes(toActorId)), 'LAB_RECIPIENT_REJECTED');
      try { await request.beforeDispatch?.(); } catch { fail('LAB_SEND_NOT_DISPATCHED'); }
      let dispatchVerdict: unknown;
      try { dispatchVerdict = request.assertDispatch?.(); } catch { fail('LAB_SEND_NOT_DISPATCHED'); }
      if (dispatchVerdict !== undefined) {
        // Contain an invalid rejected Promise without awaiting it or admitting dispatch.
        void Promise.resolve(dispatchVerdict).catch(() => {});
        fail('LAB_SEND_SYNC_GATE_INVALID');
      }
      // No await between the controller's final stop gate and the native invocation.
      this.#assert(binding, request.signal);
      const operation = { type: 'message.send', channelId, text, ...(toActorId ? { toActorId } : {}) };
      const signal = this.#signal(binding, request.signal), token = binding.token;
      this.#dispatched.add(dispatchKey);
      dispatched = true;
      const raw = record(await binding.call.call(binding.collaboration, binding.runId, token, { action: 'act', operationId, operation }, signal));
      // A confirmed remote effect remains a fact after local cancellation/disconnect.
      if (raw.ok === true) {
        const data = record(raw.data); check(data.delivered === true && data.channelId === channelId);
        check(array(data.attachments, 32).length === 0);
        const id = eventId(data.eventId, binding.runId);
        const observedAt = this.#now().toISOString();
        return { status: 'delivered', ok: true, delivered: true, ...base, eventId: id, bodyHash: hash(text), observedAt };
      }
      check(raw.ok === false);
      // Lab failures may occur after an effect; only unknown is conservative without an independent receipt.
      return { status: 'unknown', ok: false, ...base, code: 'LAB_SEND_UNCONFIRMED' };
    } catch (error) {
      if (dispatched) return { status: 'unknown', ok: false, ...base, code: 'LAB_SEND_UNCONFIRMED' };
      if (error instanceof LabAdapterError) throw error;
      fail('LAB_SEND_NOT_DISPATCHED');
    } finally { this.#sending = false; }
  }
  /** Observe persisted delivery metadata. Never reissues an act, including on not_found. */
  async observeSend(request: LabObserveSendRequest): Promise<LabSendObservationResult> {
    const binding = this.#current(request.signal), operationId = string(request.operationId, 160), channelId = entityId(request.channelId), bodyHash = string(request.bodyHash, 64);
    check(/^[A-Za-z0-9_.:-]{1,160}$/.test(operationId) && /^[a-f0-9]{64}$/.test(bodyHash), 'LAB_RECEIPT_INVALID');
    const base = { runId: binding.runId, operationId, channelId, bodyHash };
    try {
      const raw = record(await this.#read(binding, { action: 'message.receipt', operationId, channelId, bodyHash }, request.signal));
      check(raw.runId === binding.runId && raw.operationId === operationId && raw.channelId === channelId && raw.bodyHash === bodyHash);
      if (raw.status === 'not_found' || raw.status === 'ambiguous') return { status: raw.status, ...base };
      check(raw.status === 'delivered');
      const id = eventId(raw.eventId, binding.runId), observedAt = string(raw.observedAt, 30);
      check(new Date(observedAt).toISOString() === observedAt);
      return { status: 'delivered', ...base, eventId: id, observedAt };
    } catch { return { status: 'unknown', ...base, code: 'LAB_RECEIPT_UNCONFIRMED' }; }
  }
  async disconnect(signal?: AbortSignal): Promise<{ disconnected: true }> {
    const binding = this.#current(signal), token = binding.token;
    this.#assert(binding, signal);
    // Invalidate pending input/inspect admission immediately; disconnect has its own signal.
    this.#discard(binding);
    try {
      const result = record(await binding.call.call(binding.collaboration, binding.runId, token, { action: 'disconnect' }, signal));
      check(result.disconnected === true); return { disconnected: true };
    } catch { fail('LAB_DISCONNECT_UNCONFIRMED'); }
  }
  close(): void { this.#closed = true; if (this.#binding) this.#discard(this.#binding); }
}
