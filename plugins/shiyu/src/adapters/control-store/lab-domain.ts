import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import type { LabCommands, LabDomainRequest, LabConnection, LabConnectionDetail, LabChannel, LabConnectInput, LabInputRef, LabReply, LabReplyPermit, LabSendPlan, LabSendObservation } from '../../contracts/lab.js';
import { EffectLedger, type EffectClaim, type DispatchVerdict } from '../../control/effects/index.js';
import type { MandateStore, PermitRequest, TrustedPolicyActor } from '../../control/policy/mandates.js';
import { createControlAuthority, LAB_DISPATCHER, LAB_VERIFIER } from './authority.js';
import type { SqliteTransactions } from './transaction.js';
import type { LocalReplyOperation } from './local-reply-domain.js';
import type { LabReplyCaptureAuthority } from './view-domain.js';
export type { LabCommands, LabDomainRequest } from '../../contracts/lab.js';
export interface LabDomainOptions {
  runtimeIdentity: { installationGeneration: string; hostEpoch: string };
  ensureChannel(input: { connectionId: string; runId: string; channelId: string; kind: 'direct' | 'group'; membersDigest: string }): { conversationId: string };
  advanceInput(input: { connectionId: string; runId: string; channelId: string; eventId: string }): unknown;
  retireChannel(input: { connectionId: string; runId: string; channelId: string; reasonRef: string }): unknown;
  assertDraft(operationId: string): { conversationId: string; inputId: string; status: string; textSha256?: string; token: { conversationGeneration: number } };
  /** Trusted synchronous runtime pause/drain fence, never public metadata. */
  assertRuntimeAllowed(): void;
  now?: () => Date;
}
interface Connection extends LabConnection { hostEpoch: string; installationGeneration: string }
interface Send { opId: string; connectionId: string; channelId: string; replyId: string; draftOperationId: string; bodyHash: string; bodyBytes: number; conversationGeneration: number; authorization: PermitRequest; observation?: LabSendObservation }
const OWNER: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const clone = <T>(v: T): T => structuredClone(v);
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : x);
const digest = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
export class LabDomainError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'LabDomainError'; } }
const fail = (code: string, message: string): never => { throw new LabDomainError(code, message); };
function fields(v: unknown, keys: string[], required = keys): void {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail('INVALID_LAB_INPUT', 'Expected plain Lab command');
  const entries = Object.getOwnPropertyDescriptors(v);
  if (Object.keys(entries).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(entries, k)) || Object.values(entries).some(x => !Object.hasOwn(x, 'value'))) fail('INVALID_LAB_INPUT', 'Unknown, missing or accessor Lab fields');
}
function id(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(v)) fail('INVALID_LAB_INPUT', 'Invalid Lab identity'); return v as string; }
function sha(v: unknown): string { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('INVALID_LAB_INPUT', 'Invalid Lab digest'); return v as string; }
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail('INVALID_LAB_INPUT', 'Invalid Lab integer'); return Number(v); }
function utc(v: unknown): string { if (typeof v !== 'string' || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('INVALID_LAB_INPUT', 'Expected canonical UTC'); return v as string; }
function sync<T>(callback: () => T): T {
  const result = callback();
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => undefined);
    fail('ASYNC_LAB_AUTHORITY', 'Lab transaction callbacks must be synchronous');
  }
  return result;
}
/** Control references only. No Lab RPC, Session access, body text or token storage. */
export class LabDomain {
  private readonly authority: MandateStore;
  private readonly effects: EffectLedger;
  private readonly identity: LabDomainOptions['runtimeIdentity'];
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: LabDomainOptions) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Lab domain requires shared SQLite');
    for (const key of ['ensureChannel', 'advanceInput', 'retireChannel', 'assertDraft', 'assertRuntimeAllowed'] as const) if (typeof options[key] !== 'function' || isAsyncFunction(options[key])) fail('INVALID_LAB_CONFIGURATION', 'Lab callbacks must be synchronous');
    this.identity = { installationGeneration: id(options.runtimeIdentity.installationGeneration), hostEpoch: id(options.runtimeIdentity.hostEpoch) };
    this.authority = createControlAuthority(db, tx, { now: () => new Date(this.now()) });
    this.effects = new EffectLedger(db, tx, { now: () => new Date(this.now()) });
    tx.atomic(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_lab_connections(connection_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,intent_hash TEXT NOT NULL,record_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_lab_inputs(connection_id TEXT NOT NULL,event_id TEXT NOT NULL,channel_id TEXT NOT NULL,seq INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(connection_id,event_id),UNIQUE(connection_id,seq));
        CREATE TABLE IF NOT EXISTS shiyu_lab_replies(reply_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,channel_id TEXT NOT NULL,anchor_event_id TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(connection_id,channel_id,anchor_event_id));
        CREATE TABLE IF NOT EXISTS shiyu_lab_sends(op_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,reply_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL);`);
      // Tokens are never recovered. Reassembly fences current native bindings.
      for (const row of db.prepare('SELECT record_json FROM shiyu_lab_connections').all()) {
        const c = JSON.parse(String(row.record_json)) as Connection;
        if (c.hostEpoch === this.identity.hostEpoch && c.installationGeneration === this.identity.installationGeneration) continue;
        if (c.status === 'connected' || c.status === 'paused') { c.status = 'needs_reconnect'; c.epoch++; this.saveConnection(c); for (const channel of c.channels) this.retire(c, channel, 'host_changed'); }
        for (const reply of this.replies(c.connectionId)) if (reply.status === 'claimed' || reply.status === 'accounted') this.unknownReply(reply, 'host_changed');
        for (const send of this.sends(c.connectionId)) { const effect = this.effects.get(send.opId)!; if (effect.status === 'dispatching' && effect.currentClaim) this.unknownSend(send, effect.currentClaim, 'host_changed'); else if (effect.status === 'pending') this.cancelPending(send, 'host_changed'); }
      }
    });
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private row(table: string, column: string, value: string): Record<string, unknown> | undefined { this.tx.assertUsable(); return this.db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).get(value); }
  private connection(connectionId: string): Connection { const row = this.row('shiyu_lab_connections', 'connection_id', id(connectionId)); if (!row) fail('UNKNOWN_LAB_CONNECTION', 'Lab connection unavailable'); return JSON.parse(String(row!.record_json)) as Connection; }
  private reply(replyId: string): LabReply { const row = this.row('shiyu_lab_replies', 'reply_id', id(replyId)); if (!row) fail('UNKNOWN_LAB_REPLY', 'Lab reply unavailable'); const v = JSON.parse(String(row!.record_json)) as LabReply; v.reservation = this.authority.getReservation(OWNER, v.permit.authorization.reservationId); return v; }
  private send(opId: string): Send { const row = this.row('shiyu_lab_sends', 'op_id', id(opId)); if (!row) fail('UNKNOWN_LAB_SEND', 'Lab send unavailable'); return JSON.parse(String(row!.record_json)) as Send; }
  private replies(connectionId: string): LabReply[] { return this.db.prepare('SELECT reply_id FROM shiyu_lab_replies WHERE connection_id=? ORDER BY rowid').all(connectionId).map(row => this.reply(String(row.reply_id))); }
  private sends(connectionId: string): Send[] { return this.db.prepare('SELECT record_json FROM shiyu_lab_sends WHERE connection_id=? ORDER BY rowid').all(connectionId).map(row => JSON.parse(String(row.record_json)) as Send); }
  private channel(c: LabConnection, channelId: string): LabChannel { const channel = c.channels.find(v => v.channelId === id(channelId)); if (!channel) fail('LAB_CHANNEL_DENIED', 'Channel not approved'); return channel!; }
  private saveConnection(v: Connection): void { v.version++; v.updatedAt = this.now(); this.db.prepare('UPDATE shiyu_lab_connections SET record_json=? WHERE connection_id=?').run(JSON.stringify(v), v.connectionId); }
  private saveReply(v: LabReply): void { this.db.prepare('UPDATE shiyu_lab_replies SET record_json=? WHERE reply_id=?').run(JSON.stringify(v), v.replyId); }
  private saveSend(v: Send): void { this.db.prepare('UPDATE shiyu_lab_sends SET record_json=? WHERE op_id=?').run(JSON.stringify(v), v.opId); }
  private resource(runId: string, channelId: string): string { return `lab-channel:${digest([runId, channelId])}`; }
  private runConnections(runId: string): string[] { return this.db.prepare("SELECT connection_id FROM shiyu_lab_connections WHERE json_extract(record_json,'$.runId')=?").all(runId).map(row => String(row.connection_id)); }
  private runSends(runId: string): Send[] { return this.runConnections(runId).flatMap(connectionId => this.sends(connectionId)); }
  private retire(c: Connection, ch: LabChannel, reason: string): void { sync(() => this.options.retireChannel({ connectionId: c.connectionId, runId: c.runId, channelId: ch.channelId, reasonRef: `lab-fence:${c.epoch}:${reason}` })); }
  private active(c: Connection): void {
    sync(() => this.options.assertRuntimeAllowed());
    if (c.status !== 'connected' || c.hostEpoch !== this.identity.hostEpoch || c.installationGeneration !== this.identity.installationGeneration) fail('LAB_NOT_CONNECTED', 'Lab needs explicit reconnect');
    if (c.expiresAt <= this.now()) fail('LAB_EXPIRED', 'Lab authority expired');
  }
  private samePermit(p: LabReplyPermit): LabReply { const r = this.reply(p.replyId); if (canonical(p) !== canonical(r.permit)) fail('STALE_LAB_PERMIT', 'Lab claim changed'); return r; }
  private current(r: LabReply, allowSettled: boolean, allowSent = false): Connection {
    const c = this.connection(r.connectionId); this.active(c); const ch = this.channel(c, r.channelId), p = r.permit;
    if (p.connectionEpoch !== c.epoch || p.hostEpoch !== this.identity.hostEpoch || p.installationGeneration !== this.identity.installationGeneration || ch.inputVersion !== p.inputVersion || ch.latestInput?.eventId !== p.anchorEventId || p.leaseExpiresAt <= this.now()) fail('STALE_LAB_INPUT', 'Lab input or connection fence changed');
    if (r.status === 'unknown' || (r.status === 'sent' && !allowSent)) fail('LAB_REPLY_UNAVAILABLE', 'Anchor cannot run again');
    if (allowSettled && r.reservation.state === 'settled' && !r.reservation.overrun) this.originalAuthority(p.authorization, p.leaseExpiresAt); else this.authority.assertPermit(LAB_DISPATCHER, p.authorization);
    return c;
  }
  /** After native accounting, final result gates still require the original live mandate. */
  private originalAuthority(auth: PermitRequest, leaseExpiresAt: string): void {
    const m = this.authority.get(OWNER, auth.mandateId), health = this.authority.health();
    if (health.frozen || m.state !== 'active' || m.version !== auth.mandateVersion || m.authEpoch !== auth.authEpoch || m.expiresAt <= this.now() || leaseExpiresAt <= this.now() || !m.allowedActions.includes(auth.action) || !m.subjectIds.includes(LAB_DISPATCHER.principalId) || auth.resourceScopes.some(x => !m.allowedResources.includes(x))) fail('STALE_LAB_AUTHORITY', 'Original Lab authority is no longer valid');
  }
  connect(input: LabConnectInput): LabConnectionDetail & { duplicate: boolean } {
    fields(input, ['requestId', 'runId', 'channels', 'budget', 'expiresAt']); id(input.requestId); id(input.runId); utc(input.expiresAt); fields(input.budget, ['tokens', 'calls', 'effects']); for (const v of Object.values(input.budget)) integer(v);
    if (input.budget.tokens < 16384 || input.budget.calls < 1 || input.budget.effects < 1) fail('INVALID_LAB_INPUT', 'Insufficient Lab budget or deadline');
    if (!Array.isArray(input.channels) || input.channels.length < 1 || input.channels.length > 20) fail('INVALID_LAB_INPUT', 'Approve one to twenty channels');
    const ids = new Set<string>();
    for (const ch of input.channels) { fields(ch, ['channelId', 'kind', 'membersDigest']); id(ch.channelId); sha(ch.membersDigest); if (!['direct', 'group'].includes(ch.kind) || ids.has(ch.channelId)) fail('INVALID_LAB_INPUT', 'Invalid or repeated channel'); ids.add(ch.channelId); }
    return this.tx.atomic(() => {
      const old = this.db.prepare('SELECT connection_id,intent_hash FROM shiyu_lab_connections WHERE request_id=?').get(input.requestId);
      if (old) { if (old.intent_hash !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 'Connection request changed'); return { ...this.get(String(old.connection_id)), duplicate: true }; }
      if (input.expiresAt <= this.now()) fail('LAB_EXPIRED', 'A fresh Lab grant requires a future deadline');
      sync(() => this.options.assertRuntimeAllowed());
      const previousConnections = this.db.prepare('SELECT record_json FROM shiyu_lab_connections').all().map(row => JSON.parse(String(row.record_json)) as Connection);
      if (previousConnections.some(previous => previous.status === 'connected')) fail('LAB_CONNECTION_ACTIVE', 'Pause the previous Lab connection before replacement');
      // Explicit owner approval may replace a paused transport. Revocation and
      // the new grant commit together; unknown reservations remain with history.
      for (const previous of previousConnections) if (previous.status === 'paused') this.control({ connectionId: previous.connectionId, expectedVersion: previous.version }, 'disconnected');
      const connectionId = `lab-${digest(input.requestId).slice(0, 40)}`, mandateId = `lab-mandate:${connectionId}`;
      const channels = input.channels.map(ch => ({ ...clone(ch), conversationId: sync(() => this.options.ensureChannel({ ...ch, connectionId, runId: input.runId })).conversationId, cursor: 0, inputVersion: 0, pendingInputs: [] }));
      this.authority.grant(OWNER, { id: mandateId, scope: 'local-owner', subjectIds: [LAB_DISPATCHER.principalId], allowedActions: ['lab.reply', 'lab.message.send'], allowedResources: channels.map(ch => this.resource(input.runId, ch.channelId)), limits: clone(input.budget), basisRef: `owner-lab-connect:${input.requestId}`, expiresAt: input.expiresAt });
      const c: Connection = { connectionId, requestId: input.requestId, runId: input.runId, version: 1, epoch: 1, status: 'connected', mandateId, channels, budget: clone(input.budget), expiresAt: input.expiresAt, createdAt: this.now(), updatedAt: this.now(), ...this.identity };
      this.db.prepare('INSERT INTO shiyu_lab_connections VALUES(?,?,?,?)').run(connectionId, input.requestId, digest(input), JSON.stringify(c)); return { ...this.get(connectionId), duplicate: false };
    });
  }
  ingest(input: LabCommands['lab.ingest']['input']): LabConnectionDetail {
    fields(input, ['connectionId', 'events']); if (!Array.isArray(input.events) || input.events.length > 100) fail('INVALID_LAB_INPUT', 'Input batch exceeds bound');
    return this.tx.atomic(() => {
      const c = this.connection(input.connectionId); this.active(c); let changed = false;
      for (const e of input.events) {
        fields(e, ['eventId', 'channelId', 'actorId', 'type', 'seq', 'bodyHash', 'bodyBytes']); id(e.eventId); id(e.actorId); if (e.actorId.length > 80 || e.actorId === 'SHIYU' || typeof e.type !== 'string' || !/^input\.(message|request|query|correction|cancel|memory)$/.test(e.type)) fail('INVALID_LAB_INPUT', 'Invalid Lab sender or input type'); sha(e.bodyHash); integer(e.seq, 1); integer(e.bodyBytes, 1, 16384); const ch = this.channel(c, e.channelId);
        const old = this.db.prepare('SELECT record_json FROM shiyu_lab_inputs WHERE connection_id=? AND event_id=?').get(c.connectionId, e.eventId);
        if (old) { if (canonical(JSON.parse(String(old.record_json))) !== canonical(e)) fail('IDEMPOTENCY_CONFLICT', 'Event identity changed'); continue; }
        const known = this.db.prepare(`SELECT inputs.record_json FROM shiyu_lab_inputs inputs JOIN shiyu_lab_connections connections USING(connection_id)
          WHERE json_extract(connections.record_json,'$.runId')=? AND (inputs.event_id=? OR inputs.seq=?) LIMIT 1`).get(c.runId, e.eventId, e.seq);
        if (known) {
          if (canonical(JSON.parse(String(known.record_json))) !== canonical(e)) fail('IDEMPOTENCY_CONFLICT', 'Run event identity changed across connections');
          this.db.prepare('INSERT INTO shiyu_lab_inputs VALUES(?,?,?,?,?)').run(c.connectionId, e.eventId, e.channelId, e.seq, JSON.stringify(e));
          if (e.seq > ch.cursor) { ch.cursor = e.seq; changed = true; }
          continue; // Historical metadata is never a new pending input or generation.
        }
        if (e.seq <= ch.cursor) fail('STALE_LAB_EVENT', 'Unknown event precedes durable cursor');
        if (this.db.prepare('SELECT 1 FROM shiyu_lab_inputs WHERE connection_id=? AND seq=?').get(c.connectionId, e.seq)) fail('IDEMPOTENCY_CONFLICT', 'Sequence belongs to another event');
        ch.cursor = e.seq; ch.inputVersion++; ch.latestInput = clone(e); ch.pendingInputs.push(clone(e));
        // Backpressure rolls the whole page and Conversation fences back. No
        // unread reference may silently disappear from the pending group.
        if (ch.pendingInputs.length > 200) fail('LAB_INPUT_BACKPRESSURE', 'Pending Lab input needs explicit owner handling');
        this.db.prepare('INSERT INTO shiyu_lab_inputs VALUES(?,?,?,?,?)').run(c.connectionId, e.eventId, e.channelId, e.seq, JSON.stringify(e));
        sync(() => this.options.advanceInput({ connectionId: c.connectionId, runId: c.runId, channelId: ch.channelId, eventId: e.eventId })); changed = true;
      }
      if (changed) this.saveConnection(c); return this.get(c.connectionId);
    });
  }
  claimReply(input: LabCommands['lab.claimReply']['input']): LabReply | undefined {
    fields(input, ['connectionId', 'channelId']); if (this.tx.depth) fail('NESTED_DISPATCH', 'Claim must commit before dispatch');
    return this.tx.atomic(() => {
      const c = this.connection(input.connectionId); this.active(c); const ch = this.channel(c, input.channelId); if (!ch.latestInput) return undefined;
      // Keep accepting metadata while uncertain delivery blocks this channel.
      // Do not consume a new anchor or model budget that could not be sent.
      if (this.runSends(c.runId).some(send => send.channelId === ch.channelId && ['pending', 'dispatching', 'unknown'].includes(this.effects.get(send.opId)!.status))) return undefined;
      if (this.db.prepare(`SELECT 1 FROM shiyu_lab_replies replies JOIN shiyu_lab_connections connections USING(connection_id)
        WHERE json_extract(connections.record_json,'$.runId')=? AND replies.channel_id=? AND replies.anchor_event_id=? LIMIT 1`).get(c.runId, ch.channelId, ch.latestInput.eventId)) return undefined;
      const replyId = `lab-reply-${digest([c.connectionId, ch.channelId, ch.latestInput.eventId]).slice(0, 40)}`; if (this.row('shiyu_lab_replies', 'reply_id', replyId)) return undefined;
      if (ch.pendingInputs.length > 8 || ch.pendingInputs.reduce((sum, event) => sum + event.bodyBytes, 0) > 16384) fail('LAB_GROUP_TOO_LARGE', 'The complete pending Lab group exceeds its bound; explicit owner handling is required');
      const inputRefs: LabInputRef[] = clone(ch.pendingInputs);
      if (!inputRefs.length || inputRefs.at(-1)!.eventId !== ch.latestInput.eventId) fail('LAB_INPUT_UNAVAILABLE', 'Bounded group must include latest input');
      const m = this.authority.get(OWNER, c.mandateId);
      const authorization: PermitRequest = { reservationId: `lab-generation:${replyId}`, mandateId: m.mandateId, mandateVersion: m.version, authEpoch: m.authEpoch, scope: 'local-owner', action: 'lab.reply', resourceScopes: [this.resource(c.runId, ch.channelId)] };
      const reservation = this.authority.reserve(LAB_DISPATCHER, { ...authorization, amount: { tokens: 16384, calls: 1, effects: 0 }, leaseMs: 600000 });
      const permit: LabReplyPermit = { replyId, connectionId: c.connectionId, connectionEpoch: c.epoch, channelId: ch.channelId, inputVersion: ch.inputVersion, anchorEventId: ch.latestInput.eventId, claimToken: randomUUID(), ...this.identity, authorization, leaseExpiresAt: reservation.leaseExpiresAt };
      const r: LabReply = { replyId, connectionId: c.connectionId, channelId: ch.channelId, conversationId: ch.conversationId, anchorEventId: ch.latestInput.eventId, inputRefs, permit, status: 'claimed', reservation, createdAt: this.now() };
      this.db.prepare('INSERT INTO shiyu_lab_replies VALUES(?,?,?,?,?)').run(replyId, c.connectionId, ch.channelId, r.anchorEventId, JSON.stringify(r)); ch.lastReplyId = replyId; this.saveConnection(c); return clone(r);
    });
  }
  assertReply(input: LabCommands['lab.assertReply']['input']): LabReply { fields(input, ['permit']); return this.tx.atomic(() => { const r = this.samePermit(input.permit); this.current(r, true); return r; }); }
  /** Same-Worker read authority only; absent from LabCommands and public routes.
   * Validation of an already issued capture is not permission to generate again. */
  authorizeReplyCapture(permit: LabReplyPermit, operation: LocalReplyOperation, phase: 'capture' | 'validate'): LabReplyCaptureAuthority {
    return this.tx.atomic(() => {
      const reply = this.samePermit(permit), connection = this.current(reply, true, phase === 'validate');
      if (operation.inputId !== reply.replyId || operation.conversationId !== reply.conversationId || operation.scope !== 'local-owner'
        || operation.mode !== 'reply' || !['admitted', 'prepared', 'dispatching', 'ready'].includes(operation.status)
        || (phase === 'capture' && (operation.status !== 'admitted' || reply.status !== 'claimed' || reply.reservation.state !== 'reserved'))) {
        fail('LAB_CAPTURE_SCOPE', 'Only the original admitted Lab generation can obtain this capture');
      }
      const mandate = this.authority.get(OWNER, permit.authorization.mandateId);
      const expires = Math.min(Date.parse(operation.createdAt) + 120000, Date.parse(connection.expiresAt),
        Date.parse(permit.leaseExpiresAt), Date.parse(mandate.expiresAt));
      if (!Number.isFinite(expires) || expires <= Date.parse(this.now())) fail('LAB_EXPIRED', 'The fixed Lab reply execution deadline expired');
      return { conversationId: reply.conversationId, expiresAt: new Date(expires).toISOString(),
        binding: { kind: 'lab-reply-v1', operationId: operation.operationId, replyId: reply.replyId, connectionId: reply.connectionId } };
    });
  }
  recordReplyAccounting(input: LabCommands['lab.recordReplyAccounting']['input']): LabReply {
    fields(input, ['permit', 'receiptId', 'complete', 'tokens', 'calls', 'evidenceRef'], ['permit', 'receiptId', 'complete', 'evidenceRef']);
    return this.tx.atomic(() => {
      const r = this.samePermit(input.permit); id(input.receiptId); id(input.evidenceRef); if (typeof input.complete !== 'boolean') fail('INVALID_LAB_INPUT', 'Accounting completeness must be boolean');
      const usage = { ...(input.tokens === undefined ? {} : { tokens: integer(input.tokens) }), ...(input.calls === undefined ? {} : { calls: integer(input.calls) }), effects: 0 };
      if (input.complete && (usage.tokens === undefined || usage.calls === undefined || usage.calls < 1)) fail('INCOMPLETE_USAGE', 'Native usage requires complete tokens and calls');
      if (r.reservation.state === 'settled') { if (!input.complete || canonical(r.reservation.observed) !== canonical(usage)) fail('LAB_USAGE_CONFLICT', 'Native usage changed'); return r; }
      r.reservation = this.authority.reconcile(LAB_VERIFIER, { receiptId: input.receiptId, reservationId: r.reservation.reservationId, expectedVersion: r.reservation.version, complete: input.complete, usage, evidenceRef: input.evidenceRef });
      if (r.status !== 'sent') r.status = input.complete && !r.reservation.overrun && r.status !== 'unknown' ? 'accounted' : 'unknown'; this.saveReply(r); return r;
    });
  }
  private unknownReply(r: LabReply, reasonCode: string): LabReply {
    if (r.status === 'sent') return r; r.status = 'unknown'; r.reasonCode = id(reasonCode);
    if (r.reservation.state === 'reserved') r.reservation = this.authority.reconcile(LAB_VERIFIER, { receiptId: `lab-generation-unknown:${r.replyId}`, reservationId: r.reservation.reservationId, expectedVersion: r.reservation.version, complete: false, usage: { effects: 0 }, evidenceRef: `lab-reply:${r.replyId}` });
    this.saveReply(r); return r;
  }
  markReplyUnknown(input: LabCommands['lab.markReplyUnknown']['input']): LabReply { fields(input, ['permit', 'reasonCode']); return this.tx.atomic(() => this.unknownReply(this.samePermit(input.permit), input.reasonCode)); }
  private draft(r: LabReply, s: Pick<Send, 'draftOperationId' | 'bodyHash' | 'conversationGeneration'>): void {
    const draft = sync(() => this.options.assertDraft(s.draftOperationId));
    if (draft.status !== 'ready' || draft.conversationId !== r.conversationId || draft.inputId !== r.replyId || draft.textSha256 !== s.bodyHash || draft.token.conversationGeneration !== s.conversationGeneration) fail('STALE_LAB_DRAFT', 'Native draft does not match this reply');
  }
  prepareSend(input: LabCommands['lab.prepareSend']['input']): LabSendPlan {
    fields(input, ['permit', 'draftOperationId', 'bodyHash', 'bodyBytes']); id(input.draftOperationId); sha(input.bodyHash); integer(input.bodyBytes, 1, 10000); if (this.tx.depth) fail('NESTED_DISPATCH', 'Send claim must commit before RPC');
    const s = this.tx.atomic(() => {
      const r = this.samePermit(input.permit), c = this.current(r, true);
      if (r.reservation.state !== 'settled' || r.reservation.overrun || r.status !== 'accounted') fail('LAB_USAGE_UNKNOWN', 'Generation usage must settle before sending');
      const opId = `lab-send-${digest(r.replyId).slice(0, 40)}`, existing = this.row('shiyu_lab_sends', 'op_id', opId);
      if (existing) { const prior = this.send(opId); if (prior.bodyHash !== input.bodyHash || prior.bodyBytes !== input.bodyBytes || prior.draftOperationId !== input.draftOperationId) fail('IDEMPOTENCY_CONFLICT', 'Send identity changed'); return prior; }
      const draft = sync(() => this.options.assertDraft(input.draftOperationId));
      const s: Send = { opId, connectionId: r.connectionId, channelId: r.channelId, replyId: r.replyId, draftOperationId: input.draftOperationId, bodyHash: input.bodyHash, bodyBytes: input.bodyBytes, conversationGeneration: integer(draft.token.conversationGeneration, 1), authorization: { ...r.permit.authorization, reservationId: `lab-send-budget:${opId}`, action: 'lab.message.send' } };
      this.draft(r, s); this.authority.reserve(LAB_DISPATCHER, { ...s.authorization, amount: { tokens: 0, calls: 0, effects: 1 }, leaseMs: 300000 });
      this.effects.enqueue({ effectId: opId, idempotencyKey: opId, origin: { kind: 'dialogue', conversationId: r.conversationId, turnId: r.replyId, conversationGeneration: s.conversationGeneration }, action: 'lab.message.send', resourceScopes: s.authorization.resourceScopes, payloadRef: `native-draft:${input.draftOperationId}`, payloadHash: input.bodyHash, replayClass: 'reconcilable', authorization: { mandateId: s.authorization.mandateId, mandateVersion: s.authorization.mandateVersion, authEpoch: s.authorization.authEpoch, installationGeneration: this.identity.installationGeneration }, expiresAt: c.expiresAt, maxAttempts: 1 });
      this.db.prepare('INSERT INTO shiyu_lab_sends VALUES(?,?,?,?)').run(opId, r.connectionId, r.replyId, JSON.stringify(s)); r.sendId = opId; this.saveReply(r); return s;
    });
    const effect = this.effects.get(s.opId)!;
    if (effect.status === 'pending') this.effects.claim({ effectId: s.opId, ownerId: LAB_DISPATCHER.principalId, ...this.identity, fencingToken: this.reply(s.replyId).permit.inputVersion, leaseMs: 300000 }, () => this.authorizeSend(s));
    return this.plan(s);
  }
  private authorizeSend(s: Send): Extract<DispatchVerdict, { allowed: true }> {
    const r = this.reply(s.replyId); this.current(r, true); this.draft(r, s);
    this.authority.assertPermit(LAB_DISPATCHER, s.authorization);
    return { allowed: true, mandateId: s.authorization.mandateId, mandateVersion: s.authorization.mandateVersion, authEpoch: s.authorization.authEpoch, installationGeneration: this.identity.installationGeneration, hostEpoch: this.identity.hostEpoch, fencingToken: r.permit.inputVersion, conversationGeneration: s.conversationGeneration };
  }
  private match(s: Send, claim: EffectClaim): void { if (canonical(this.effects.get(s.opId)?.currentClaim) !== canonical(claim) || claim.effectId !== s.opId) fail('STALE_LAB_CLAIM', 'Send claim differs from original dispatch'); }
  assertSend(input: LabCommands['lab.assertSend']['input']): LabSendPlan { fields(input, ['opId', 'claim']); const s = this.send(input.opId); this.match(s, input.claim); this.effects.assertDispatch(input.claim, () => this.authorizeSend(s)); return this.plan(s); }
  reconcileSend(input: LabCommands['lab.reconcileSend']['input']): LabSendPlan {
    fields(input, ['opId', 'claim', 'expectedVersion'], ['opId', 'claim']); return this.tx.atomic(() => { const s = this.send(input.opId); this.match(s, input.claim); if (input.expectedVersion !== undefined && this.connection(s.connectionId).version !== integer(input.expectedVersion, 1)) fail('VERSION_CONFLICT', 'Connection changed'); if (this.effects.get(s.opId)!.status !== 'unknown') fail('LAB_RECONCILE_DENIED', 'Only an uncertain send may be observed'); return this.plan(s); });
  }
  private cancelPending(s: Send, reasonCode: string): void {
    const effect = this.effects.get(s.opId)!;
    if (effect.status !== 'pending' || effect.attempts !== 0) fail('LAB_SEND_UNCERTAIN', 'Only a never-claimed send can be cancelled as not executed');
    this.effects.cancel(effect.effectId, effect.version, reasonCode);
    const reservation = this.authority.getReservation(OWNER, s.authorization.reservationId);
    if (reservation.state !== 'settled') this.authority.reconcile(LAB_VERIFIER, { receiptId: `lab-send-cancelled:${s.opId}`, reservationId: reservation.reservationId, expectedVersion: reservation.version, complete: true, usage: { tokens: 0, calls: 0, effects: 0 }, evidenceRef: `lab-never-claimed:${s.opId}` });
  }
  private unknownSend(s: Send, claim: EffectClaim, reasonCode: string): void {
    this.match(s, claim); const effect = this.effects.get(s.opId)!; if (effect.status === 'dispatching') this.effects.markUnknown(claim, id(reasonCode)); else if (effect.status !== 'unknown') fail('LAB_SEND_FINAL', 'Final send cannot become unknown');
    const reservation = this.authority.getReservation(OWNER, s.authorization.reservationId);
    if (reservation.state === 'reserved') this.authority.reconcile(LAB_VERIFIER, { receiptId: `lab-send-unknown:${s.opId}`, reservationId: reservation.reservationId, expectedVersion: reservation.version, complete: false, usage: { tokens: 0, calls: 0 }, evidenceRef: `lab-send:${s.opId}` });
  }
  markSendUnknown(input: LabCommands['lab.markSendUnknown']['input']): LabSendPlan { fields(input, ['opId', 'claim', 'reasonCode']); return this.tx.atomic(() => { const s = this.send(input.opId); this.unknownSend(s, input.claim, input.reasonCode); return this.plan(s); }); }
  recordSendReceipt(input: LabCommands['lab.recordSendReceipt']['input']): LabSendPlan {
    fields(input, ['opId', 'claim', 'observation', 'reconciliation']);
    return this.tx.atomic(() => {
      const s = this.send(input.opId); this.match(s, input.claim); const o = input.observation; fields(o, ['eventId', 'channelId', 'opId', 'bodyHash', 'observedAt']); id(o.eventId); utc(o.observedAt);
      if (typeof input.reconciliation !== 'boolean' || o.channelId !== s.channelId || o.opId !== s.opId || o.bodyHash !== s.bodyHash || o.observedAt > this.now()) fail('LAB_RECEIPT_MISMATCH', 'Receipt must identify the exact operation');
      if (s.observation) { const { observedAt: _previousTime, ...previous } = s.observation; const { observedAt: _newTime, ...next } = o; if (canonical(previous) !== canonical(next)) fail('IDEMPOTENCY_CONFLICT', 'Receipt changed'); return this.plan(s); }
      let effect = this.effects.get(s.opId)!;
      if (effect.status === 'dispatching' && input.claim.leaseExpiresAt <= this.now()) effect = this.effects.markUnknown(input.claim, 'late_receipt');
      const reconciliation = effect.status === 'unknown';
      const receipt = { receiptId: `lab-receipt:${digest([s.opId, o.eventId])}`, serviceId: 'shiyu-lab', externalOperationId: s.opId, observedAt: o.observedAt, outcome: 'succeeded' as const, payloadHash: s.bodyHash, evidenceRefs: [`lab-event:${o.eventId}`, `lab-observation:${digest(o)}`] };
      const verify = () => ({ verified: true as const, installationGeneration: input.claim.installationGeneration, serviceId: 'shiyu-lab', externalOperationId: s.opId, reconciled: reconciliation, settledEffect: { idempotencyKey: s.opId, payloadHash: s.bodyHash, outcome: 'succeeded' as const } });
      if (reconciliation) this.effects.reconcile(input.claim, receipt, verify); else this.effects.complete(input.claim, receipt, verify);
      const reservation = this.authority.getReservation(OWNER, s.authorization.reservationId);
      this.authority.reconcile(LAB_VERIFIER, { receiptId: `lab-send-usage:${receipt.receiptId}`, reservationId: reservation.reservationId, expectedVersion: reservation.version, complete: true, usage: { tokens: 0, calls: 0, effects: 1 }, evidenceRef: receipt.evidenceRefs[1]! });
      s.observation = clone(o); this.saveSend(s); const r = this.reply(s.replyId); r.status = 'sent'; this.saveReply(r);
      const c = this.connection(s.connectionId), ch = this.channel(c, s.channelId), answered = new Set(r.inputRefs.map(x => x.eventId)); ch.pendingInputs = ch.pendingInputs.filter(x => !answered.has(x.eventId)); this.saveConnection(c); return this.plan(s);
    });
  }
  private plan(s: Send): LabSendPlan {
    const effect = this.effects.get(s.opId)!; let canReconcile = false;
    // This is receipt-observation eligibility, not permission to write. The
    // coordinator must separately prove current transport identity before RPC.
    canReconcile = effect.status === 'unknown' && effect.currentClaim !== undefined;
    return { opId: s.opId, connectionId: s.connectionId, channelId: s.channelId, replyId: s.replyId, draftOperationId: s.draftOperationId, bodyHash: s.bodyHash, bodyBytes: s.bodyBytes, conversationGeneration: s.conversationGeneration, effect, ...(effect.currentClaim ? { claim: effect.currentClaim } : {}), reservation: this.authority.getReservation(OWNER, s.authorization.reservationId), ...(s.observation ? { observation: clone(s.observation) } : {}), canReconcile };
  }
  get(connectionId: string): LabConnectionDetail { const { hostEpoch: _host, installationGeneration: _install, ...c } = this.connection(connectionId); return { ...c, balance: this.authority.balance(OWNER, c.mandateId), replies: this.replies(connectionId), sends: this.sends(connectionId).map(s => this.plan(s)) }; }
  private control(input: LabCommands['lab.pause']['input'], status: 'paused' | 'connected' | 'disconnected'): LabConnectionDetail {
    fields(input, ['connectionId', 'expectedVersion'], ['connectionId']); return this.tx.atomic(() => {
      const c = this.connection(input.connectionId); if (input.expectedVersion !== undefined && c.version !== integer(input.expectedVersion, 1)) fail('VERSION_CONFLICT', 'Lab connection changed'); if (c.status === status) return this.get(c.connectionId);
      const m = this.authority.get(OWNER, c.mandateId);
      if (status === 'connected') { sync(() => this.options.assertRuntimeAllowed()); if (c.status !== 'paused' || c.hostEpoch !== this.identity.hostEpoch || c.installationGeneration !== this.identity.installationGeneration) fail('LAB_RECONNECT_REQUIRED', 'Only a live-token paused connection may resume'); this.authority.resume(OWNER, { mandateId: m.mandateId, expectedVersion: m.version }); }
      else if (status === 'paused') { if (c.status !== 'connected') fail('LAB_NOT_CONNECTED', 'Only a connected Lab can pause'); this.authority.pause(OWNER, { mandateId: m.mandateId, expectedVersion: m.version }); }
      else if (m.state !== 'revoked') this.authority.revoke(OWNER, { mandateId: m.mandateId, expectedVersion: m.version });
      c.status = status; c.epoch++; this.saveConnection(c);
      if (status !== 'connected') {
        for (const ch of c.channels) this.retire(c, ch, status);
        for (const r of this.replies(c.connectionId)) if (r.status === 'claimed') this.unknownReply(r, `lab_${status}`);
        for (const s of this.sends(c.connectionId)) { const effect = this.effects.get(s.opId)!; if (effect.status === 'dispatching' && effect.currentClaim) this.unknownSend(s, effect.currentClaim, `lab_${status}`); else if (effect.status === 'pending') this.cancelPending(s, `lab_${status}`); }
      }
      return this.get(c.connectionId);
    });
  }
  /** Same Worker transaction as the global pause fence; no external cancellation I/O. */
  pauseAll(): void {
    this.tx.atomic(() => {
      for (const row of this.db.prepare('SELECT connection_id,record_json FROM shiyu_lab_connections').all()) {
        const connection = JSON.parse(String(row.record_json)) as Connection;
        if (connection.status === 'connected') this.control({ connectionId: connection.connectionId }, 'paused');
      }
    });
  }
  execute(request: LabDomainRequest): unknown {
    switch (request.command) {
      case 'lab.connect': return this.connect(request.args);
      case 'lab.get': fields(request.args, ['connectionId']); return this.get(request.args.connectionId);
      case 'lab.snapshot': fields(request.args, []); this.tx.assertUsable(); return this.db.prepare('SELECT connection_id FROM shiyu_lab_connections ORDER BY rowid').all().map(row => this.get(String(row.connection_id)));
      case 'lab.ingest': return this.ingest(request.args);
      case 'lab.claimReply': return this.claimReply(request.args);
      case 'lab.assertReply': return this.assertReply(request.args);
      case 'lab.recordReplyAccounting': return this.recordReplyAccounting(request.args);
      case 'lab.markReplyUnknown': return this.markReplyUnknown(request.args);
      case 'lab.prepareSend': return this.prepareSend(request.args);
      case 'lab.assertSend': return this.assertSend(request.args);
      case 'lab.reconcileSend': return this.reconcileSend(request.args);
      case 'lab.recordSendReceipt': return this.recordSendReceipt(request.args);
      case 'lab.markSendUnknown': return this.markSendUnknown(request.args);
      case 'lab.pause': return this.control(request.args, 'paused');
      case 'lab.resume': return this.control(request.args, 'connected');
      case 'lab.disconnect': return this.control(request.args, 'disconnected');
      default: return fail('INVALID_LAB_COMMAND', 'Unknown Lab command');
    }
  }
}
