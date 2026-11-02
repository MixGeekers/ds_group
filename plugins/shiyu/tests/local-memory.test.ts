import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { MemoryDomain, type MemoryCommands, type MemoryDomainRequest } from '../src/adapters/control-store/memory-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { ControlledOmbreAdapter, type ControlledMemoryTransport, type NativeMemoryReceipt } from '../src/adapters/ombre/controlled.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryCreateCommand } from '../src/contracts/memory.js';
import type { ConversationRecord } from '../src/control/conversations/index.js';
import { LocalMemoryService, LocalMemoryError, type LocalMemoryOptions, type LocalMemoryStore } from '../src/control/local-memory.js';

const BODY = 'Synthetic owner fragment: the blue notebook belongs on shelf seven.';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class BackendFixture implements ControlledMemoryTransport {
  calls: string[] = [];
  records = new Map<string, { command: MemoryCreateCommand; body: string; receipt: NativeMemoryReceipt }>();
  beforeCreate?: () => Promise<void>;
  afterCreate?: () => Promise<void>;
  afterGet?: () => Promise<void>;
  corruptBody = false;
  failCreate = false;
  private status(row: { command: MemoryCreateCommand; receipt: NativeMemoryReceipt }) {
    return { schemaVersion: 1, backendId: 'fixture-ombre', deploymentId: 'fixture-deployment', scope: 'local-owner', operationId: row.command.operationId,
      state: 'applied', command: row.command, commandDigest: memoryCommandDigest(row.command), plannedNativeId: row.receipt.nativeId, nativeId: row.receipt.nativeId, receipt: row.receipt, reason: null };
  }
  async callTool(request: { name: string; arguments: Readonly<Record<string, unknown>> }): Promise<unknown> {
    this.calls.push(request.name); let value: unknown;
    if (request.name === 'shiyu_memory_create') {
      await this.beforeCreate?.(); if (this.failCreate) throw new Error('Synthetic uncertain backend result');
      const command = structuredClone(request.arguments.command) as MemoryCreateCommand, body = String(request.arguments.body);
      const receipt: NativeMemoryReceipt = { schemaVersion: 1, receiptId: `receipt_${sha(command.operationId)}`, operationId: command.operationId,
        backendId: command.backendId, deploymentId: 'fixture-deployment', scope: command.scope, commandDigest: memoryCommandDigest(command), nativeId: `shiyu_${sha(command.operationId).slice(0, 32)}`,
        ...memoryBodyDigest(body), sourceRefs: command.sourceRefs, componentVersion: `sha256:${sha(body)}`, outcome: 'applied', bodyDurable: true, indexState: 'disabled', observedAt: new Date().toISOString(), reconciled: false };
      const row = { command, body, receipt }; this.records.set(command.operationId, row); await this.afterCreate?.(); value = this.status(row);
    } else if (request.name === 'shiyu_memory_operation_status') {
      const row = this.records.get(String(request.arguments.operationId)); assert.ok(row); value = this.status(row);
    } else if (request.name === 'shiyu_memory_get') {
      const row = [...this.records.values()].find(row => row.receipt.nativeId === request.arguments.nativeId); assert.ok(row);
      value = { schemaVersion: 1, backendId: row.command.backendId, deploymentId: 'fixture-deployment', scope: row.command.scope, state: 'found', nativeId: row.receipt.nativeId,
        command: row.command, commandDigest: memoryCommandDigest(row.command), receipt: row.receipt, body: this.corruptBody ? 'unrelated body' : row.body,
        bodyDigest: row.receipt.bodyDigest, componentVersion: row.receipt.componentVersion, reason: null };
      await this.afterGet?.();
    } else throw new Error('Unexpected fixture call');
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
}
function fixture(t: TestContext, options: Pick<LocalMemoryOptions, 'timeoutMs' | 'maxPending' | 'now'> = {}) {
  const db = new DatabaseSync(':memory:'), tx = new SqliteTransactions(db), at = new Date().toISOString();
  const conversation: ConversationRecord = { conversationId: 'local-memory-conversation', key: { connectionId: 'local-synthetic', platformConversationId: 'memory-local', kind: 'direct', scope: 'local-owner' },
    revision: 1, audienceVersion: 1, conversationGeneration: 1, archived: false, createdAt: at, updatedAt: at };
  const domain = new MemoryDomain(db, tx, { runtimeIdentity: { hostEpoch: 'memory-host', installationGeneration: 'memory-install' }, backendId: 'fixture-ombre', deploymentId: 'fixture-deployment',
    getConversation(id) { assert.equal(id, conversation.conversationId); return conversation; }, ...(options.now ? { now: options.now } : {}) });
  const requests: { command: string; args: unknown }[] = [];
  const errors: { command: string; code: unknown; message: string }[] = [];
  const hooks: { after?: (command: string, value: unknown) => Promise<void>; allowed?: () => void | Promise<void> } = {};
  const store: LocalMemoryStore = { async request<K extends keyof MemoryCommands>(command: K, args: MemoryCommands[K]['input']): Promise<MemoryCommands[K]['output']> {
    requests.push({ command, args: structuredClone(args) });
    let value: MemoryCommands[K]['output'];
    try { value = domain.execute({ command, args } as MemoryDomainRequest) as MemoryCommands[K]['output']; }
    catch (error) { errors.push({ command, code: (error as { code?: unknown }).code, message: (error as Error).message }); throw error; }
    await hooks.after?.(command, value); return value;
  } };
  const native = new BackendFixture(), backend = new ControlledOmbreAdapter(native, { backendId: 'fixture-ombre', deploymentId: 'fixture-deployment', scope: 'local-owner' });
  let paused = false;
  const service = new LocalMemoryService({ store, backend, ...options, assertRuntimeAllowed() { if (paused) throw new Error('Runtime paused'); return hooks.allowed?.(); } });
  t.after(async () => { await service.close(); db.close(); });
  const remember = (requestId = 'remember-one', signal?: AbortSignal, text = BODY) => service.remember({ requestId, conversationId: conversation.conversationId, text, signal });
  const latest = () => domain.list({})[0]!;
  return { db, domain, store, native, backend, service, requests, errors, hooks, conversation, remember, latest, pause() { paused = true; } };
}

test('explicit owner text is normalized, created once, independently verified and never stored in control rows', async t => {
  const f = fixture(t); const saved = await f.remember('remember-one', undefined, ` \n${BODY}\n `);
  assert.equal(saved.duplicate, false); assert.equal(saved.entry.operation.status, 'applied'); assert.equal(saved.entry.reservation.observed.effects, 1);
  assert.deepEqual(f.native.calls, ['shiyu_memory_create', 'shiyu_memory_operation_status', 'shiyu_memory_get']);
  assert.equal(saved.entry.command.bodyDigest, sha(BODY));
  assert.equal(JSON.stringify(f.requests).includes(BODY), false);
  for (const table of ['shiyu_local_memory_sources', 'shiyu_local_memory_operations']) assert.equal(JSON.stringify(f.db.prepare(`SELECT record_json FROM ${table}`).all()).includes(BODY), false);
  const duplicate = await f.remember(); assert.equal(duplicate.duplicate, true); assert.equal(f.native.calls.length, 3);
  assert.equal('body' in duplicate, false); assert.equal((await f.service.read({ operationId: saved.entry.operation.operationId })).body, BODY);
  await assert.rejects(f.remember('remember-one', undefined, `${BODY} changed`), /different memory input/);
});

test('a duplicate approved intent is metadata only and cannot resume an undispatched create', async t => {
  const f = fixture(t), body = memoryBodyDigest(BODY);
  const original = f.domain.prepareLocal({ requestId: 'remember-one', conversationId: f.conversation.conversationId, bodyDigest: body.bodyDigest, bytes: body.bodyBytes });
  const duplicate = await f.remember(); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.entry.operation.operationId, original.operation.operationId);
  assert.equal(duplicate.entry.operation.status, 'approved'); assert.equal(f.native.calls.length, 0);
  assert.equal(f.requests.filter(row => row.command === 'memory.claim').length, 0);
});

test('invalid Unicode, over-limit bodies and public receipt fields are refused before admission', async t => {
  const f = fixture(t);
  for (const text of ['', '\ud800', '\u202eambiguous', '中'.repeat(6000)]) assert.throws(() => f.service.remember({ requestId: 'bad', conversationId: f.conversation.conversationId, text }));
  assert.throws(() => f.service.remember({ requestId: 'bad', conversationId: f.conversation.conversationId, text: BODY, observation: {} } as never));
  assert.deepEqual(f.requests, []); assert.deepEqual(f.native.calls, []);
});

test('failed independent body verification retains unknown and a duplicate never calls the backend again', async t => {
  const f = fixture(t); f.native.corruptBody = true;
  await assert.rejects(f.remember()); assert.equal(f.latest().operation.status, 'unknown');
  const calls = f.native.calls.length; assert.equal((await f.remember()).duplicate, true); assert.equal(f.native.calls.length, calls);
  await assert.rejects(f.service.read({ operationId: f.latest().operation.operationId })); assert.equal(f.native.calls.length, calls);
});

test('pause after backend success records the independently verified fact but releases no success', async t => {
  const f = fixture(t); f.native.afterCreate = async () => { f.pause(); };
  await assert.rejects(f.remember()); assert.equal(f.latest().operation.status, 'applied'); assert.equal(f.latest().reservation.observed.effects, 1);
  assert.deepEqual(f.native.calls, ['shiyu_memory_create', 'shiyu_memory_operation_status', 'shiyu_memory_get']);
});

test('withdrawal after backend success reconciles the original claim and never republishes the memory', async t => {
  const f = fixture(t); f.native.afterCreate = async () => { await f.store.request('memory.withdrawLocal', { requestId: 'withdraw-save', operationId: f.latest().operation.operationId }); };
  await assert.rejects(f.remember()); const entry = f.latest();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.native.calls, ['shiyu_memory_create', 'shiyu_memory_operation_status', 'shiyu_memory_get']);
  assert.equal(entry.operation.status, 'unknown'); assert.equal(entry.operation.backendOutcome, 'applied'); assert.equal(entry.operation.effectState, 'succeeded');
  assert.equal(entry.operation.blocked, true); assert.equal(entry.reference, undefined); assert.equal(entry.reservation.observed.effects, 1);
  assert.equal((f.requests.find(row => row.command === 'memory.recordVerifiedReceipt')!.args as { reconciliation: boolean }).reconciliation, true);
  assert.equal(f.native.calls.filter(name => name === 'shiyu_memory_create').length, 1);
});

test('caller cancellation after an observed applied result does not prevent fact settlement', async t => {
  const f = fixture(t), controller = new AbortController(), original = f.backend.create.bind(f.backend);
  f.backend.create = async (...args) => { const value = await original(...args); controller.abort(); return value; };
  await assert.rejects(f.remember('remember-one', controller.signal)); await f.service.drain();
  assert.equal(f.latest().operation.status, 'applied'); assert.equal(f.latest().reservation.observed.effects, 1);
  assert.equal(f.native.calls.filter(name => name === 'shiyu_memory_create').length, 1);
});

test('cancellation after prepare and before claim withdraws the unused intent without backend I/O', async t => {
  const f = fixture(t), controller = new AbortController();
  f.hooks.after = async command => { if (command === 'memory.prepareLocal') controller.abort(); };
  await assert.rejects(f.remember('remember-one', controller.signal)); await f.service.drain();
  assert.equal(f.native.calls.length, 0); assert.equal(f.latest().source.consent.state, 'withdrawn'); assert.equal(f.latest().reservation.observed.effects, 0);
});

test('withdrawal during the final asynchronous lifecycle gate is rejected by dispatch authorization before any create', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t); let holdNextGate = false;
  f.hooks.after = async command => { if (command === 'memory.claim') holdNextGate = true; };
  f.hooks.allowed = async () => {
    if (!holdNextGate) return;
    holdNextGate = false; entered.resolve(); await release.promise;
  };
  const failed = assert.rejects(f.remember('withdraw-during-final-gate'));
  await entered.promise;
  assert.equal(f.requests.some(row => row.command === 'memory.assertDispatch'), false);
  const operationId = f.latest().operation.operationId;
  await f.store.request('memory.withdrawLocal', { requestId: 'withdraw-before-final-dispatch', operationId });
  assert.equal(f.latest().operation.blocked, true);
  release.resolve(); await failed; await f.service.drain();
  assert.ok(f.errors.some(row => row.command === 'memory.assertDispatch'));
  assert.equal(f.native.calls.filter(name => name === 'shiyu_memory_create').length, 0);
  assert.equal(f.latest().source.consent.state, 'withdrawn'); assert.equal(f.latest().reference, undefined);
});

test('successful dispatch has no asynchronous lifecycle gate between the final authorization and backend create', async t => {
  const f = fixture(t), order: string[] = [];
  f.hooks.allowed = async () => { order.push('lifecycle-gate'); await Promise.resolve(); };
  f.hooks.after = async command => { if (command === 'memory.assertDispatch') order.push('dispatch-authorized'); };
  f.native.beforeCreate = async () => { order.push('backend-create'); };
  const saved = await f.remember('final-dispatch-order');
  assert.equal(saved.entry.operation.status, 'applied');
  const createIndex = order.indexOf('backend-create'), authorizationIndex = order.lastIndexOf('dispatch-authorized', createIndex);
  assert.ok(authorizationIndex >= 0); assert.ok(createIndex > authorizationIndex);
  assert.deepEqual(order.slice(authorizationIndex, createIndex + 1), ['dispatch-authorized', 'backend-create']);
  assert.equal(f.native.calls.filter(name => name === 'shiyu_memory_create').length, 1);
});

test('read rechecks owner consent, audience and source/deletion state after independent native reads', async t => {
  for (const mode of ['withdraw', 'audience']) {
    const f = fixture(t), saved = await f.remember();
    f.native.afterGet = async () => {
      if (mode === 'withdraw') f.domain.withdrawLocal({ requestId: 'withdraw-read', operationId: saved.entry.operation.operationId });
      else f.conversation.audienceVersion++;
    };
    await assert.rejects(f.service.read({ operationId: saved.entry.operation.operationId }));
  }
});

test('read refuses an authorization epoch change even if the original source remains readable', async t => {
  const f = fixture(t), saved = await f.remember();
  f.native.afterGet = async () => {
    const second = memoryBodyDigest('Another explicit synthetic source');
    f.domain.prepareLocal({ requestId: 'unrelated-authority-change', conversationId: f.conversation.conversationId, bodyDigest: second.bodyDigest, bytes: second.bodyBytes });
  };
  await assert.rejects(f.service.read({ operationId: saved.entry.operation.operationId }), error => error instanceof LocalMemoryError && error.code === 'STALE_READ');
});

test('the bounded serial queue uses admission deadlines and close retains ownership until late I/O settles', async t => {
  const f = fixture(t, { timeoutMs: 100, maxPending: 2 }), entered = deferred(), release = deferred();
  f.native.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const first = assert.rejects(f.remember('first')); await entered.promise;
  const second = assert.rejects(f.remember('second'));
  await assert.rejects(f.remember('third'), error => error instanceof LocalMemoryError && error.code === 'CAPACITY');
  await Promise.all([first, second]); let closed = false;
  const closing = f.service.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  release.resolve(); await closing;
  assert.equal(f.native.calls.filter(name => name === 'shiyu_memory_create').length, 1);
  assert.equal(f.domain.list({}).length, 1); assert.equal(f.latest().operation.status, 'unknown');
  await assert.rejects(f.remember('closed'), error => error instanceof LocalMemoryError && error.code === 'CLOSED');
});

test('a committed verified receipt survives an IPC response failure without being downgraded or replayed', async t => {
  const f = fixture(t); let failed = false;
  f.hooks.after = async command => { if (command === 'memory.recordVerifiedReceipt' && !failed) { failed = true; throw new Error('Synthetic lost IPC response'); } };
  await assert.rejects(f.remember()); assert.equal(f.latest().operation.status, 'applied');
  const calls = f.native.calls.length; assert.equal((await f.remember()).duplicate, true); assert.equal(f.native.calls.length, calls);
});

test('withdrawal after the verified receipt commits prevents release of its stale readable snapshot', async t => {
  const f = fixture(t);
  f.hooks.after = async command => {
    if (command === 'memory.recordVerifiedReceipt') f.domain.withdrawLocal({ requestId: 'withdraw-after-receipt', operationId: f.latest().operation.operationId });
  };
  await assert.rejects(f.remember());
  const entry = f.latest(); assert.equal(entry.operation.backendOutcome, 'applied'); assert.equal(entry.operation.blocked, true); assert.equal(entry.reference, undefined);
  assert.equal(f.native.calls.filter(name => name === 'shiyu_memory_create').length, 1);
});

test('queued reads retain the validated operation identity when the caller mutates its input object', async t => {
  const f = fixture(t), a = await f.remember('memory-a'), b = await f.remember('memory-b', undefined, 'A distinct synthetic owner fragment');
  const input = { operationId: a.entry.operation.operationId };
  const reading = f.service.read(input); input.operationId = b.entry.operation.operationId;
  const result = await reading; assert.equal(result.entry.operation.operationId, a.entry.operation.operationId); assert.equal(result.body, BODY);
});
