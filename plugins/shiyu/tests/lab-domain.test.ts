import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { LabDomain, type LabDomainOptions } from '../src/adapters/control-store/lab-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { createControlAuthority } from '../src/adapters/control-store/authority.js';
import type { LabConnectInput, LabReply, LabSendPlan } from '../src/contracts/lab.js';
import type { LocalReplyOperation } from '../src/adapters/control-store/local-reply-domain.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const initial = '2026-11-02T12:00:00.000Z';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'shiyu-lab-domain-')), path = join(dir, 'control.sqlite');
  const dbs: DatabaseSync[] = []; let now = initial, paused = false, failRetire = false, failAdvance = false;
  const drafts = new Map<string, ReturnType<LabDomainOptions['assertDraft']>>();
  function open(hostEpoch = 'host-a') {
    const db = new DatabaseSync(path); dbs.push(db); db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS test_channels(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,retired INTEGER NOT NULL)');
    const tx = new SqliteTransactions(db);
    const key = (x: { connectionId: string; channelId: string }) => `${x.connectionId}:${x.channelId}`;
    const options: LabDomainOptions = {
      runtimeIdentity: { hostEpoch, installationGeneration: 'install-a' }, now: () => new Date(now),
      assertRuntimeAllowed: () => { if (paused) throw new Error('runtime_paused'); },
      ensureChannel: x => { const id = key(x); db.prepare('INSERT OR IGNORE INTO test_channels VALUES(?,1,0)').run(id); return { conversationId: id }; },
      advanceInput: x => { db.prepare('UPDATE test_channels SET generation=generation+1 WHERE id=?').run(key(x)); if (failAdvance) throw new Error('advance_failed'); },
      retireChannel: x => { db.prepare('UPDATE test_channels SET retired=retired+1,generation=generation+1 WHERE id=?').run(key(x)); if (failRetire) throw new Error('retire_failed'); },
      assertDraft: operationId => { const value = drafts.get(operationId); if (!value) throw new Error('draft_missing'); const row = db.prepare('SELECT generation FROM test_channels WHERE id=?').get(value.conversationId); if (row?.generation !== value.token.conversationGeneration) throw new Error('draft_stale'); return structuredClone(value); },
    };
    return { db, tx, options, domain: new LabDomain(db, tx, options) };
  }
  const f = open();
  t.after(() => { for (const db of dbs) if (db.isOpen) db.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = (n = 1): LabConnectInput => ({ requestId: 'request-1', runId: 'run-1', channels: Array.from({ length: n }, (_, i) => ({ channelId: `channel-${i}`, kind: i % 2 ? 'direct' : 'group', membersDigest: hash(`members-${i}`) })), budget: { tokens: 200000, calls: 20, effects: 20 }, expiresAt: '2026-11-02T13:00:00.000Z' });
  function ingest(connectionId: string, seq = 1, channelId = 'channel-0', bytes = 20) { return f.domain.ingest({ connectionId, events: [{ eventId: `event-${seq}`, channelId, actorId: 'HUMAN', type: 'input.message', seq, bodyHash: hash(`body-${seq}`), bodyBytes: bytes }] }); }
  function ready(connectionId: string, seq = 1, channelId = 'channel-0') {
    ingest(connectionId, seq, channelId); const reply = f.domain.claimReply({ connectionId, channelId })!;
    f.domain.recordReplyAccounting({ permit: reply.permit, receiptId: `usage-${reply.replyId}`, complete: true, tokens: 100, calls: 1, evidenceRef: `native:${reply.replyId}` });
    const draftOperationId = `draft-${seq}`, bodyHash = hash(`out-${seq}`);
    const generation = Number(f.db.prepare('SELECT generation FROM test_channels WHERE id=?').get(reply.conversationId)!.generation);
    drafts.set(draftOperationId, { conversationId: reply.conversationId, inputId: reply.replyId, status: 'ready', textSha256: bodyHash, token: { conversationGeneration: generation } });
    return { reply, draftOperationId, bodyHash, bodyBytes: 20 };
  }
  function send(connectionId: string, seq = 1, channelId = 'channel-0') { const r = ready(connectionId, seq, channelId); return { ...r, send: f.domain.prepareSend({ permit: r.reply.permit, draftOperationId: r.draftOperationId, bodyHash: r.bodyHash, bodyBytes: r.bodyBytes }) }; }
  function receipt(send: LabSendPlan, reconciliation = false) { assert.ok(send.claim); return f.domain.recordSendReceipt({ opId: send.opId, claim: send.claim, reconciliation, observation: { opId: send.opId, channelId: send.channelId, eventId: `delivered-${send.opId}`, bodyHash: send.bodyHash, observedAt: now } }); }
  return { ...f, open, input, ingest, ready, send, receipt, drafts, clock: (v: string) => { now = v; }, pause: (v = true) => { paused = v; }, failRetire: (v = true) => { failRetire = v; }, failAdvance: (v = true) => { failAdvance = v; } };
}

test('owner approval creates at most twenty exact channels and one shared budget; duplicates do not grant again', t => {
  const f = fixture(t), input = f.input(20), first = f.domain.connect(input);
  assert.equal(first.channels.length, 20); assert.equal(first.duplicate, false); assert.equal(f.domain.connect(input).duplicate, true);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_mandates').get()!.n, 1);
  assert.throws(() => f.domain.connect({ ...input, budget: { ...input.budget, calls: 21 } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.domain.connect({ ...f.input(21), requestId: 'other' }), { code: 'INVALID_LAB_INPUT' });
  assert.throws(() => f.domain.connect({ ...f.input(), requestId: 'other' }), { code: 'LAB_CONNECTION_ACTIVE' });
  assert.throws(() => f.ingest(first.connectionId, 1, 'unapproved'), { code: 'LAB_CHANNEL_DENIED' });
});

test('Lab capture authority fixes the original deadline and clips an aging permit without extending it', t => {
  const f = fixture(t), connection = f.domain.connect(f.input()); f.ingest(connection.connectionId);
  const reply = f.domain.claimReply({ connectionId: connection.connectionId, channelId: 'channel-0' })!;
  const operation: LocalReplyOperation = { operationId: 'synthetic-operation', conversationId: reply.conversationId, inputId: reply.replyId, inputHash: hash('input'),
    bindingId: 'binding', businessId: 'business', scope: 'local-owner', sessionEpoch: 1, mode: 'reply', status: 'admitted', durability: 'unconfirmed', createdAt: initial, updatedAt: initial,
    token: { bindingId: 'binding', conversationId: reply.conversationId, scope: 'local-owner', audienceVersion: 1, conversationGeneration: 1, routingRevision: 1, sessionEpoch: 1, contextVersion: 1 } };
  const capture = f.domain.authorizeReplyCapture(reply.permit, operation, 'capture');
  assert.equal(capture.expiresAt, '2026-11-02T12:02:00.000Z');
  f.clock('2026-11-02T12:00:31.000Z');
  assert.deepEqual(f.domain.authorizeReplyCapture(reply.permit, { ...operation, status: 'dispatching' }, 'validate'), capture);
  f.clock('2026-11-02T12:02:00.000Z'); assert.throws(() => f.domain.authorizeReplyCapture(reply.permit, operation, 'validate'), { code: 'LAB_EXPIRED' });
  f.clock('2026-11-02T12:09:00.000Z');
  const lateOperation = { ...operation, createdAt: '2026-11-02T12:09:00.000Z' };
  assert.equal(f.domain.authorizeReplyCapture(reply.permit, lateOperation, 'capture').expiresAt, reply.permit.leaseExpiresAt);
  assert.equal(reply.permit.leaseExpiresAt, '2026-11-02T12:10:00.000Z');
  const legacy = { ...lateOperation }; delete legacy.mode;
  assert.throws(() => f.domain.authorizeReplyCapture(reply.permit, legacy, 'capture'), { code: 'LAB_CAPTURE_SCOPE' });
});

test('durable event dedupe validates full hash and sequence and rolls back conversation fences with batch failure', t => {
  const f = fixture(t), c = f.domain.connect(f.input());
  const a = f.ingest(c.connectionId); const version = a.version;
  assert.equal(f.ingest(c.connectionId).version, version);
  assert.throws(() => f.domain.ingest({ connectionId: c.connectionId, events: [{ ...a.channels[0]!.latestInput!, bodyHash: hash('changed') }] }), { code: 'IDEMPOTENCY_CONFLICT' });
  f.failAdvance(); assert.throws(() => f.ingest(c.connectionId, 2), /advance_failed/);
  assert.equal(f.domain.get(c.connectionId).channels[0]!.cursor, 1);
  assert.equal(f.db.prepare('SELECT generation FROM test_channels').get()!.generation, 2);
});

test('reply claims every pending reference in a bounded group exactly once; unknown anchor never calls again', t => {
  const f = fixture(t), c = f.domain.connect(f.input());
  for (let i = 1; i <= 5; i++) f.ingest(c.connectionId, i, 'channel-0', 2000);
  const reply = f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' })!;
  assert.deepEqual(reply.inputRefs.map(x => x.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(reply.reservation.amount, { tokens: 16384, calls: 1, effects: 0 });
  f.domain.markReplyUnknown({ permit: reply.permit, reasonCode: 'native_unconfirmed' });
  assert.equal(f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' }), undefined);
  const held = f.domain.get(c.connectionId).balance.held; assert.deepEqual(held, { tokens: 16384, calls: 1, effects: 0 });
  f.ingest(c.connectionId, 6); assert.ok(f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' }));
});

test('new channel input fences prior reply immediately while other approved channels remain independent', t => {
  const f = fixture(t), c = f.domain.connect(f.input(2));
  f.ingest(c.connectionId, 1); const a = f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' })!;
  f.ingest(c.connectionId, 2, 'channel-1'); assert.equal(f.domain.assertReply({ permit: a.permit }).replyId, a.replyId);
  f.ingest(c.connectionId, 3); assert.throws(() => f.domain.assertReply({ permit: a.permit }), { code: 'STALE_LAB_INPUT' });
  assert.ok(f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-1' }));
});

test('missing native usage is held unknown and cannot prepare message.send', t => {
  const f = fixture(t), c = f.domain.connect(f.input()); f.ingest(c.connectionId);
  const reply = f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' })!;
  const unknown = f.domain.recordReplyAccounting({ permit: reply.permit, receiptId: 'partial', complete: false, tokens: 100, evidenceRef: 'native:partial' });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.reservation.state, 'unknown');
  assert.throws(() => f.domain.prepareSend({ permit: reply.permit, draftOperationId: 'draft', bodyHash: hash('out'), bodyBytes: 3 }), { code: 'LAB_REPLY_UNAVAILABLE' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_effects').get()!.n, 0);
});

test('native draft and settled usage produce a separate dialogue Effect and successful receipt settles one message', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), { send, reply } = f.send(c.connectionId);
  assert.equal(send.effect.origin.kind, 'dialogue'); assert.equal(send.effect.payloadHash, send.bodyHash); assert.equal(send.effect.status, 'dispatching'); assert.equal(send.effect.attempts, 1);
  assert.equal(f.domain.assertSend({ opId: send.opId, claim: send.claim! }).opId, send.opId);
  const complete = f.receipt(send); assert.equal(complete.effect.status, 'succeeded'); assert.equal(complete.reservation.state, 'settled');
  assert.deepEqual(f.domain.get(c.connectionId).balance.spent, { tokens: 100, calls: 1, effects: 1 });
  assert.equal(f.domain.get(c.connectionId).channels[0]!.pendingInputs.length, 0); assert.equal(f.domain.get(c.connectionId).replies[0]!.replyId, reply.replyId);
  assert.equal(f.receipt(send).effect.version, complete.effect.version);
});

test('draft identity and changed input deny send before reserve; last execution gate independently catches newer input', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), ready = f.ready(c.connectionId);
  assert.throws(() => f.domain.prepareSend({ permit: ready.reply.permit, draftOperationId: ready.draftOperationId, bodyHash: hash('wrong'), bodyBytes: 20 }), { code: 'STALE_LAB_DRAFT' });
  const send = f.domain.prepareSend({ permit: ready.reply.permit, draftOperationId: ready.draftOperationId, bodyHash: ready.bodyHash, bodyBytes: 20 });
  f.ingest(c.connectionId, 2); assert.throws(() => f.domain.assertSend({ opId: send.opId, claim: send.claim! }), { code: 'STALE_LAB_INPUT' });
  assert.equal(send.effect.attempts, 1);
});

test('lost receipt stays unknown; explicit pure observation may settle after expiry/new input without a new attempt', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), { send } = f.send(c.connectionId);
  f.domain.markSendUnknown({ opId: send.opId, claim: send.claim!, reasonCode: 'lost_receipt' }); f.ingest(c.connectionId, 2); f.clock('2026-11-02T14:00:00.000Z');
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const observed = f.domain.reconcileSend({ opId: send.opId, claim: send.claim!, expectedVersion: f.domain.get(c.connectionId).version });
  assert.equal(observed.canReconcile, true); assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  const done = f.receipt(send, true); assert.equal(done.effect.status, 'succeeded'); assert.equal(done.effect.attempts, 1);
  assert.deepEqual(f.domain.get(c.connectionId).channels[0]!.pendingInputs.map(x => x.seq), [2]);
  assert.throws(() => f.domain.assertSend({ opId: send.opId, claim: send.claim! }));
});

test('not-found observation does not release hold or create another generation and malformed receipt is rejected', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), { send } = f.send(c.connectionId);
  f.domain.markSendUnknown({ opId: send.opId, claim: send.claim!, reasonCode: 'lost_receipt' });
  const before = f.domain.get(c.connectionId).balance;
  f.domain.reconcileSend({ opId: send.opId, claim: send.claim! }); // caller receives not_found, records no positive fact
  assert.deepEqual(f.domain.get(c.connectionId).balance, before);
  assert.equal(f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' }), undefined);
  assert.throws(() => f.domain.recordSendReceipt({ opId: send.opId, claim: send.claim!, reconciliation: true, observation: { eventId: 'wrong', channelId: 'other', opId: send.opId, bodyHash: send.bodyHash, observedAt: initial } }), { code: 'LAB_RECEIPT_MISMATCH' });
  assert.throws(() => f.domain.reconcileSend({ opId: send.opId, claim: { ...send.claim!, claimToken: 'other' } }), { code: 'STALE_LAB_CLAIM' });
});

test('pause/disconnect fence first, retain uncertain effects, and rollback together with conversation retirement', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), { send } = f.send(c.connectionId); const before = f.domain.get(c.connectionId);
  f.failRetire(); assert.throws(() => f.domain.execute({ command: 'lab.pause', args: { connectionId: c.connectionId, expectedVersion: before.version } }), /retire_failed/);
  assert.equal(f.domain.get(c.connectionId).epoch, before.epoch); assert.equal(f.domain.get(c.connectionId).status, 'connected'); assert.equal(f.db.prepare('SELECT retired FROM test_channels').get()!.retired, 0);
  f.failRetire(false); f.domain.pauseAll(); const after = f.domain.get(c.connectionId);
  assert.equal(after.status, 'paused'); assert.equal(after.epoch, before.epoch + 1); assert.equal(after.sends[0]!.effect.status, 'unknown');
  f.domain.pauseAll(); assert.equal(f.domain.get(c.connectionId).epoch, after.epoch);
  assert.throws(() => f.domain.assertSend({ opId: send.opId, claim: send.claim! }));
  f.pause(); f.domain.execute({ command: 'lab.disconnect', args: { connectionId: c.connectionId, expectedVersion: after.version } }); assert.equal(f.domain.get(c.connectionId).status, 'disconnected');
  assert.equal(f.receipt(send, true).effect.status, 'succeeded');
});

test('restart requires fresh transport and retains unknown model/send holds without replay', t => {
  const f = fixture(t), c = f.domain.connect(f.input(2)), { send } = f.send(c.connectionId);
  f.ingest(c.connectionId, 2, 'channel-1'); const generation = f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-1' })!;
  f.db.close(); const reopened = f.open('host-b'), detail = reopened.domain.get(c.connectionId);
  assert.equal(detail.status, 'needs_reconnect'); assert.equal(detail.sends[0]!.effect.status, 'unknown'); assert.equal(detail.sends[0]!.effect.attempts, 1);
  assert.equal(detail.replies.find(r => r.replyId === generation.replyId)!.reservation.state, 'unknown');
  assert.throws(() => reopened.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-1' }), { code: 'LAB_NOT_CONNECTED' });
  assert.equal(reopened.domain.reconcileSend({ opId: send.opId, claim: send.claim! }).canReconcile, true);
});

test('GET while runtime paused remains read-only and SQLite stores no body/token field', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), { send } = f.send(c.connectionId);
  f.domain.markSendUnknown({ opId: send.opId, claim: send.claim!, reasonCode: 'lost_receipt' }); f.pause();
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  for (let i = 0; i < 100; i++) { f.domain.get(c.connectionId); f.domain.execute({ command: 'lab.snapshot', args: {} }); }
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  for (const table of ['shiyu_lab_connections', 'shiyu_lab_inputs', 'shiyu_lab_replies', 'shiyu_lab_sends']) {
    const records = f.db.prepare(`SELECT record_json FROM ${table}`).all();
    for (const row of records) { assert.doesNotMatch(String(row.record_json), /"(?:text|body|token|targetToken|draftText)"\s*:/); assert.doesNotMatch(String(row.record_json), /out-1|body-1/); }
  }
});

test('unknown account and effect cannot consume more than shared connection allowance', t => {
  const f = fixture(t), input = f.input(2); input.budget = { tokens: 16384, calls: 1, effects: 1 }; const c = f.domain.connect(input);
  f.ingest(c.connectionId); const reply = f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' })!;
  f.domain.markReplyUnknown({ permit: reply.permit, reasonCode: 'aborted' }); f.ingest(c.connectionId, 2, 'channel-1');
  assert.throws(() => f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-1' }), { code: 'BUDGET_EXCEEDED' });
  const policy = createControlAuthority(f.db, f.tx); assert.equal(policy.health().frozen, false);
});

test('callbacks reject async construction and arbitrary thenables roll back without invoking then', t => {
  const f = fixture(t); assert.throws(() => new LabDomain(f.db, f.tx, { ...f.options, advanceInput: async () => undefined }), { code: 'INVALID_LAB_CONFIGURATION' });
  let invoked = false; const domain = new LabDomain(f.db, f.tx, { ...f.options, advanceInput: () => ({ then() { invoked = true; } }) }); const c = domain.connect(f.input());
  assert.throws(() => domain.ingest({ connectionId: c.connectionId, events: [{ eventId: 'event', channelId: 'channel-0', actorId: 'HUMAN', type: 'input.message', seq: 1, bodyHash: hash('secret'), bodyBytes: 6 }] }), { code: 'ASYNC_LAB_AUTHORITY' });
  assert.equal(invoked, false); assert.equal(domain.get(c.connectionId).channels[0]!.cursor, 0);
});

test('unknown delivery blocks only its channel before any new anchor or budget is consumed', t => {
  const f = fixture(t), c = f.domain.connect(f.input(2)), { send } = f.send(c.connectionId);
  f.domain.markSendUnknown({ opId: send.opId, claim: send.claim!, reasonCode: 'receipt_lost' }); f.ingest(c.connectionId, 2);
  const before = f.domain.get(c.connectionId).balance;
  assert.equal(f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' }), undefined);
  assert.deepEqual(f.domain.get(c.connectionId).balance, before);
  f.ingest(c.connectionId, 3, 'channel-1'); assert.ok(f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-1' }));
  f.receipt(send, true); const next = f.domain.claimReply({ connectionId: c.connectionId, channelId: 'channel-0' }); assert.equal(next?.anchorEventId, 'event-2');
});

test('pause and lease expiry between adapter delivery and record select factual reconciliation atomically', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), { send } = f.send(c.connectionId);
  f.domain.pauseAll(); const first = f.receipt(send, false); // caller had seen dispatching before pause
  assert.equal(first.effect.status, 'succeeded'); assert.equal(first.effect.attempts, 1);
  f.clock('2026-11-02T12:01:00.000Z'); const second = f.receipt(send, false);
  assert.equal(second.effect.version, first.effect.version); assert.equal(second.observation?.observedAt, initial);
});

test('explicit reconnect never replays a known run event and unknown delivery blocks same run/channel across connections', t => {
  const f = fixture(t), first = f.domain.connect(f.input()), { send } = f.send(first.connectionId);
  f.domain.execute({ command: 'lab.disconnect', args: { connectionId: first.connectionId } });
  const second = f.domain.connect({ ...f.input(), requestId: 'reconnect-2' });
  f.ingest(second.connectionId, 1); const historical = f.domain.get(second.connectionId).channels[0]!;
  assert.equal(historical.cursor, 1); assert.equal(historical.pendingInputs.length, 0); assert.equal(historical.latestInput, undefined);
  assert.equal(f.domain.claimReply({ connectionId: second.connectionId, channelId: 'channel-0' }), undefined);
  assert.throws(() => f.domain.ingest({ connectionId: second.connectionId, events: [{ eventId: 'renamed-event', seq: 1, channelId: 'channel-0', actorId: 'HUMAN', type: 'input.message', bodyHash: hash('body-1'), bodyBytes: 20 }] }), { code: 'IDEMPOTENCY_CONFLICT' });
  f.ingest(second.connectionId, 2);
  assert.equal(f.domain.claimReply({ connectionId: second.connectionId, channelId: 'channel-0' }), undefined);
  assert.deepEqual(f.domain.get(second.connectionId).balance.held, { tokens: 0, calls: 0, effects: 0 });
  f.receipt(send, true); const fresh = f.domain.claimReply({ connectionId: second.connectionId, channelId: 'channel-0' });
  assert.equal(fresh?.anchorEventId, 'event-2'); assert.deepEqual(fresh?.inputRefs.map(x => x.eventId), ['event-2']);
  assert.deepEqual(f.domain.get(first.connectionId).balance.spent, { tokens: 100, calls: 1, effects: 1 });
  assert.deepEqual(f.domain.get(second.connectionId).balance.spent, { tokens: 0, calls: 0, effects: 0 });
});

test('restart unknown generation remains under old grant and the same run anchor is not recreated by reconnect', t => {
  const f = fixture(t), first = f.domain.connect(f.input()); f.ingest(first.connectionId);
  const reply = f.domain.claimReply({ connectionId: first.connectionId, channelId: 'channel-0' })!;
  f.db.close(); const reopened = f.open('host-b'), second = reopened.domain.connect({ ...f.input(), requestId: 'after-restart' });
  const event = reopened.domain.get(first.connectionId).channels[0]!.latestInput!;
  reopened.domain.ingest({ connectionId: second.connectionId, events: [event] });
  assert.equal(reopened.domain.claimReply({ connectionId: second.connectionId, channelId: 'channel-0' }), undefined);
  assert.equal(reopened.domain.get(first.connectionId).replies.find(x => x.replyId === reply.replyId)!.status, 'unknown');
  assert.deepEqual(reopened.domain.get(first.connectionId).balance.held, { tokens: 16384, calls: 1, effects: 0 });
  assert.deepEqual(reopened.domain.get(second.connectionId).balance.held, { tokens: 0, calls: 0, effects: 0 });
});

test('crash after enqueue but before committed Effect claim cancels only that provably undispatched send', t => {
  const f = fixture(t), c = f.domain.connect(f.input()), ready = f.ready(c.connectionId);
  const effects = (f.domain as unknown as { effects: { claim: (...args: unknown[]) => unknown } }).effects;
  effects.claim = () => { throw new Error('simulated_before_claim'); };
  assert.throws(() => f.domain.prepareSend({ permit: ready.reply.permit, draftOperationId: ready.draftOperationId, bodyHash: ready.bodyHash, bodyBytes: ready.bodyBytes }), /simulated_before_claim/);
  const pending = f.domain.get(c.connectionId).sends[0]!; assert.equal(pending.effect.status, 'pending'); assert.equal(pending.claim, undefined);
  f.db.close(); const reopened = f.open('host-b'), final = reopened.domain.get(c.connectionId).sends[0]!;
  assert.equal(final.effect.status, 'cancelled'); assert.equal(final.effect.attempts, 0); assert.equal(final.reservation.state, 'settled');
  assert.deepEqual(final.reservation.observed, { tokens: 0, calls: 0, effects: 0 });
  assert.deepEqual(reopened.domain.get(c.connectionId).balance.spent, { tokens: 100, calls: 1, effects: 0 });
});

test('same-request expired duplicate returns the original reference without granting or reviving execution', t => {
  const f = fixture(t), input = f.input(), original = f.domain.connect(input); f.clock('2026-11-02T14:00:00.000Z'); f.pause();
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const duplicate = f.domain.connect(input); assert.equal(duplicate.connectionId, original.connectionId); assert.equal(duplicate.duplicate, true);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.throws(() => f.domain.claimReply({ connectionId: original.connectionId, channelId: 'channel-0' }), /runtime_paused/);
  assert.throws(() => f.domain.connect({ ...input, requestId: 'new-expired' }), { code: 'LAB_EXPIRED' });
});

test('explicit owner connect atomically replaces a paused connection while its uncertain budget remains historical', t => {
  const f = fixture(t), input = f.input(), old = f.domain.connect(input), { send } = f.send(old.connectionId);
  f.domain.pauseAll(); const held = f.domain.get(old.connectionId).balance.held;
  const next = f.domain.connect({ ...input, requestId: 'replace-paused' });
  assert.equal(next.status, 'connected'); assert.notEqual(next.connectionId, old.connectionId);
  assert.equal(f.domain.get(old.connectionId).status, 'disconnected'); assert.equal(f.domain.get(old.connectionId).sends[0]!.effect.status, 'unknown');
  assert.deepEqual(f.domain.get(old.connectionId).balance.held, held); assert.deepEqual(next.balance.held, { tokens: 0, calls: 0, effects: 0 });
  const owner = { principalId: 'local-owner', kind: 'owner' as const, scopes: ['local-owner'] };
  assert.equal(createControlAuthority(f.db, f.tx).get(owner, old.mandateId).state, 'revoked');
  f.ingest(next.connectionId, 2); assert.equal(f.domain.claimReply({ connectionId: next.connectionId, channelId: 'channel-0' }), undefined);
  f.receipt(send, true); assert.ok(f.domain.claimReply({ connectionId: next.connectionId, channelId: 'channel-0' }));
});

test('paused replacement failure rolls back old revocation, retirement and new connection as one transaction', t => {
  const f = fixture(t), old = f.domain.connect(f.input()); f.domain.pauseAll(); const before = f.domain.get(old.connectionId);
  f.failRetire(); assert.throws(() => f.domain.connect({ ...f.input(), requestId: 'failed-replacement' }), /retire_failed/);
  assert.equal(f.domain.get(old.connectionId).status, 'paused'); assert.equal(f.domain.get(old.connectionId).epoch, before.epoch);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_lab_connections').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_mandates').get()!.n, 1);
});

test('complete pending groups over count or bytes refuse claims without spending or silently dropping unread refs', t => {
  const f = fixture(t), c = f.domain.connect(f.input(2));
  for (let seq = 1; seq <= 9; seq++) f.ingest(c.connectionId, seq);
  f.ingest(c.connectionId, 10, 'channel-1', 10000); f.ingest(c.connectionId, 11, 'channel-1', 10000);
  const before = f.domain.get(c.connectionId);
  for (const channelId of ['channel-0', 'channel-1']) assert.throws(() => f.domain.claimReply({ connectionId: c.connectionId, channelId }), { code: 'LAB_GROUP_TOO_LARGE' });
  const after = f.domain.get(c.connectionId); assert.deepEqual(after.channels, before.channels); assert.deepEqual(after.balance, before.balance); assert.equal(after.replies.length, 0);
  assert.deepEqual(after.channels[0]!.pendingInputs.map(x => x.seq), [1,2,3,4,5,6,7,8,9]);
});

test('pending input backpressure rolls back a whole batch at 200 without losing refs or advancing Conversation', t => {
  const f = fixture(t), c = f.domain.connect(f.input());
  const event = (seq: number) => ({ eventId: `event-${seq}`, channelId: 'channel-0', actorId: 'HUMAN', type: 'input.message', seq, bodyHash: hash(`body-${seq}`), bodyBytes: 20 });
  f.domain.ingest({ connectionId: c.connectionId, events: Array.from({ length: 100 }, (_, i) => event(i + 1)) });
  f.domain.ingest({ connectionId: c.connectionId, events: Array.from({ length: 99 }, (_, i) => event(i + 101)) });
  const before = f.domain.get(c.connectionId), generation = f.db.prepare('SELECT generation FROM test_channels').get()!.generation;
  assert.throws(() => f.domain.ingest({ connectionId: c.connectionId, events: [event(200), event(201)] }), { code: 'LAB_INPUT_BACKPRESSURE' });
  assert.deepEqual(f.domain.get(c.connectionId), before); assert.equal(f.db.prepare('SELECT generation FROM test_channels').get()!.generation, generation);
  f.domain.ingest({ connectionId: c.connectionId, events: [event(200)] });
  assert.equal(f.domain.get(c.connectionId).channels[0]!.pendingInputs.length, 200);
});

test('sender and input type are durable identity facts; same event may not change actor/type', t => {
  const f = fixture(t), c = f.domain.connect(f.input()); const first = f.ingest(c.connectionId).channels[0]!.latestInput!;
  for (const change of [{ actorId: 'OTHER' }, { type: 'input.request' }]) assert.throws(() => f.domain.ingest({ connectionId: c.connectionId, events: [{ ...first, ...change }] }), { code: 'IDEMPOTENCY_CONFLICT' });
  for (const change of [{ actorId: 'SHIYU' }, { actorId: 'A'.repeat(81) }, { type: 'message.delivered' }]) assert.throws(() => f.domain.ingest({ connectionId: c.connectionId, events: [{ ...first, ...change }] }), { code: 'INVALID_LAB_INPUT' });
  assert.equal(f.domain.get(c.connectionId).channels[0]!.pendingInputs[0]!.actorId, 'HUMAN');
});
