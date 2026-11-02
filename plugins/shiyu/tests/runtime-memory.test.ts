import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeService, type SessionDriver } from '../src/runtime.js';
import type { DshContext } from '../src/adapters/dsh/sessions.js';
import { ControlledOmbreAdapter, type ControlledMemoryTransport, type NativeMemoryReceipt } from '../src/adapters/ombre/controlled.js';
import type { ManagedOmbreConfig, ManagedOmbreState, ManagedOmbreStatus } from '../src/adapters/ombre/managed.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryCreateCommand } from '../src/contracts/memory.js';

// The real Runtime, worker-thread ControlStore, MemoryDomain and controlled
// adapter run here. Only the owned process boundary and native model roles are
// doubles. This suite neither starts an MCP process nor calls a model.
const BODY = 'Synthetic owner fragment: keep the indigo notebook on shelf nine.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
interface PublicEntry {
  operationId: string; version: number; requestId: string; conversationId: string;
  status: string; blocked: boolean; bodyBytes: number; consent: string;
  canRead: boolean; nativeId?: string; createdAt: string;
}
interface Saved { duplicate: boolean; entry: PublicEntry }
type NativeRow = { command: MemoryCreateCommand; body: string; receipt: NativeMemoryReceipt };

class SyntheticTransport implements ControlledMemoryTransport {
  calls: string[] = [];
  rows = new Map<string, NativeRow>();
  beforeCreate?: () => Promise<void>;
  afterGet?: () => Promise<void>;
  failCreate = false;
  constructor(readonly config: ManagedOmbreConfig) {}
  private observation(row: NativeRow) {
    return { schemaVersion: 1, backendId: this.config.backendId, deploymentId: this.config.deploymentId, scope: this.config.scope,
      operationId: row.command.operationId, state: 'applied', command: row.command, commandDigest: memoryCommandDigest(row.command),
      plannedNativeId: row.receipt.nativeId, nativeId: row.receipt.nativeId, receipt: row.receipt, reason: null };
  }
  async callTool(request: { name: string; arguments: Readonly<Record<string, unknown>> }): Promise<unknown> {
    this.calls.push(request.name); let result: unknown;
    if (request.name === 'shiyu_memory_create') {
      await this.beforeCreate?.();
      if (this.failCreate) throw new Error('Synthetic uncertain native create');
      const command = structuredClone(request.arguments.command) as MemoryCreateCommand, body = String(request.arguments.body);
      const receipt: NativeMemoryReceipt = { schemaVersion: 1, receiptId: `receipt_${sha(command.operationId)}`, operationId: command.operationId,
        backendId: command.backendId, deploymentId: this.config.deploymentId, scope: command.scope, commandDigest: memoryCommandDigest(command),
        nativeId: `shiyu_${sha(command.operationId).slice(0, 32)}`, ...memoryBodyDigest(body), sourceRefs: command.sourceRefs,
        componentVersion: `sha256:${sha(body)}`, outcome: 'applied', bodyDurable: true, indexState: 'disabled', observedAt: new Date().toISOString(), reconciled: false };
      const row = { command, body, receipt }; this.rows.set(command.operationId, row); result = this.observation(row);
    } else if (request.name === 'shiyu_memory_operation_status') {
      const row = this.rows.get(String(request.arguments.operationId)); assert.ok(row); result = this.observation(row);
    } else if (request.name === 'shiyu_memory_get') {
      const row = [...this.rows.values()].find(row => row.receipt.nativeId === request.arguments.nativeId); assert.ok(row);
      result = { schemaVersion: 1, backendId: this.config.backendId, deploymentId: this.config.deploymentId, scope: this.config.scope,
        state: 'found', nativeId: row.receipt.nativeId, command: row.command, commandDigest: memoryCommandDigest(row.command), receipt: row.receipt,
        body: row.body, bodyDigest: row.receipt.bodyDigest, componentVersion: row.receipt.componentVersion, reason: null };
      await this.afterGet?.();
    } else throw new Error('Unexpected synthetic memory tool');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}

class SyntheticManaged {
  readonly transport: SyntheticTransport;
  readonly adapter: ControlledOmbreAdapter;
  state: ManagedOmbreState = 'idle';
  opens = 0; closes = 0;
  beforeOpen?: () => Promise<void>;
  beforeClose?: () => Promise<void>;
  private closing?: Promise<void>;
  constructor(readonly config: ManagedOmbreConfig, readonly failOpen = false) {
    this.transport = new SyntheticTransport(config);
    this.adapter = new ControlledOmbreAdapter(this.transport, config);
  }
  async open() {
    this.opens++; this.state = 'opening'; await this.beforeOpen?.();
    if ((this.state as ManagedOmbreState) !== 'opening') throw new Error('Synthetic opening cancelled');
    if (this.failOpen) { this.state = 'failed'; throw new Error('Synthetic startup failure'); } this.state = 'ready';
  }
  status(): Readonly<ManagedOmbreStatus> {
    return { configured: true, state: this.state, backendId: this.config.backendId, deploymentId: this.config.deploymentId, scope: 'local-owner',
      embedding: 'disabled', semanticReady: false, bindingVerified: this.state === 'ready', toolCount: this.state === 'ready' ? 3 : 0,
      stderrBytes: 0, stderrTruncated: false };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closes++; this.state = 'closing';
    return this.closing = (async () => { await this.beforeClose?.(); this.state = 'closed'; })();
  }
}

async function fixture(t: TestContext, options: { configured?: boolean; descriptor?: (config: ManagedOmbreConfig) => unknown; paused?: boolean; failOpen?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'shiyu-runtime-memory-'));
  const config: ManagedOmbreConfig = { schemaVersion: 1, backendId: 'runtime-memory-fixture', deploymentId: 'runtime-memory-deployment', scope: 'local-owner',
    python: process.execPath, upstream: path.join(directory, 'synthetic-upstream'), root: path.join(directory, 'synthetic-native-root'), embedding: 'disabled' };
  if (options.configured !== false) {
    await mkdir(path.join(directory, 'memory'));
    await writeFile(path.join(directory, 'memory', 'backend.json'), JSON.stringify(options.descriptor ? options.descriptor(config) : config));
  }
  if (options.paused) await writeFile(path.join(directory, 'runtime-state.json'), JSON.stringify({ schemaVersion: 1, paused: true, bindings: [] }));
  const nativeCalls = { sessions: 0, workers: 0, goals: 0 };
  const sessions: SessionDriver = {
    async initialize() {}, async prepareContextSafety() { return { ready: true, messageFactory: 'injected', nativeReadback: true, coldProjection: true }; },
    async probe() { nativeCalls.sessions++; throw new Error('Native Session probe forbidden in this fixture'); },
    async generateReply() { nativeCalls.sessions++; throw new Error('Native model call forbidden in this fixture'); },
    async getStatus() { return []; }, async cancel() {}, async close() {},
  };
  const backends: SyntheticManaged[] = [];
  const runtime = new RuntimeService({} as DshContext, { dataDir: directory }, {
    sessionFactory: () => sessions,
    workerFactory: () => ({ async initialize() {}, async close() {}, async run() { nativeCalls.workers++; throw new Error('Native worker forbidden in this fixture'); } }),
    goalFactory: () => ({ async initialize() {}, async close() {}, async run() { nativeCalls.goals++; throw new Error('Native Goal forbidden in this fixture'); } }),
    memoryFactory(binding) { const managed = new SyntheticManaged(binding, options.failOpen); backends.push(managed); return managed; },
  });
  t.after(async () => { try { await runtime.close(); assert.deepEqual(nativeCalls, { sessions: 0, workers: 0, goals: 0 }); } finally { await rm(directory, { recursive: true, force: true }); } });
  await runtime.init();
  async function conversation() {
    // Direct trusted admission intentionally does not ask the Runtime runner to
    // dispatch this Task. It only supplies a real local Conversation authority.
    const detail = await runtime.store.request('task.createLocal', { requestId: 'memory-fixture-task', title: 'Synthetic memory anchor', content: 'Synthetic non-memory Task input' });
    return runtime.store.request('conversation.ensureLocalTask', { taskId: detail.task.taskId });
  }
  return { runtime, directory, config, backends, nativeCalls, conversation,
    save(conversationId: string, requestId = 'save-one', text = BODY, signal?: AbortSignal) {
      return runtime.command({ action: 'memory.rememberLocal', requestId, conversationId, text }, signal) as Promise<Saved>;
    } };
}

test('unconfigured memory remains visible but unavailable and snapshots never instantiate a backend', async t => {
  const f = await fixture(t, { configured: false });
  for (let i = 0; i < 3; i++) {
    const snapshot = await f.runtime.snapshot();
    assert.deepEqual(snapshot.memory, { configured: false, ready: false, entries: [] });
    assert.equal(snapshot.dependencies.find(row => row.id === 'memory')?.status, 'unconfigured');
  }
  await assert.rejects(f.save('synthetic-conversation'), /backend is unavailable/);
  await assert.rejects(f.runtime.command({ action: 'memory.readLocal', operationId: 'missing-operation' }), /backend is unavailable/);
  assert.equal(f.backends.length, 0);
});

test('invalid strict configuration degrades memory only without constructing a backend', async t => {
  for (const descriptor of [(config: ManagedOmbreConfig) => ({ ...config, env: { untrusted: 'not-forwarded' } }), () => ({ schemaVersion: 1 })]) {
    const f = await fixture(t, { descriptor }); const snapshot = await f.runtime.snapshot();
    assert.equal(snapshot.lifecycle, 'degraded'); assert.equal(snapshot.memory.configured, true); assert.equal(snapshot.memory.ready, false);
    assert.equal(snapshot.memory.errorCode, 'MEMORY_CONFIGURATION_INVALID'); assert.equal(f.backends.length, 0);
    await assert.rejects(f.save('synthetic-conversation'), /backend is unavailable/);
    assert.equal((await f.runtime.store.info()).journalMode, 'wal');
  }
});

test('failed managed startup is reported and cleaned up without a retry on snapshot or resume', async t => {
  const f = await fixture(t, { failOpen: true }), managed = f.backends[0]!;
  assert.equal(managed.opens, 1); assert.equal(managed.closes, 1);
  const snapshot = await f.runtime.snapshot(); assert.equal(snapshot.memory.ready, false); assert.equal(snapshot.memory.errorCode, 'MEMORY_BACKEND_UNAVAILABLE');
  await f.runtime.command({ action: 'runtime.pause' }); await f.runtime.command({ action: 'runtime.resume' });
  await f.runtime.snapshot(); assert.equal(managed.opens, 1);
  await assert.rejects(f.save('synthetic-conversation'), /backend is unavailable/);
});

test('persisted pause constructs no process and one explicit resume opens the configured backend once', async t => {
  const f = await fixture(t, { paused: true }), managed = f.backends[0]!;
  assert.equal(managed.opens, 0); assert.equal(managed.state, 'idle');
  assert.equal((await f.runtime.snapshot()).state, 'paused'); assert.equal((await f.runtime.snapshot()).memory.ready, false);
  await assert.rejects(f.save('synthetic-conversation'), /paused/); assert.deepEqual(managed.transport.calls, []);
  await f.runtime.command({ action: 'runtime.resume' }); await f.runtime.command({ action: 'runtime.resume' });
  assert.equal(managed.opens, 1); assert.equal((await f.runtime.snapshot()).memory.ready, true);
  const linked = await f.conversation(), result = await f.save(linked.conversationId);
  assert.equal(result.entry.status, 'applied');
});

test('close cancels a backend opening during resume instead of waiting for its startup timeout', async t => {
  const f = await fixture(t, { paused: true }), managed = f.backends[0]!, entered = deferred(), release = deferred(), cancelling = deferred();
  managed.beforeOpen = async () => { entered.resolve(); await release.promise; };
  managed.beforeClose = async () => { cancelling.resolve(); release.resolve(); };
  const resuming = f.runtime.command({ action: 'runtime.resume' });
  const settledResume = resuming.catch(() => undefined); await entered.promise;
  const closing = f.runtime.close();
  let started = false;
  try {
    await Promise.race([cancelling.promise.then(() => { started = true; }), new Promise<void>(resolve => setTimeout(resolve, 100))]);
  } finally { release.resolve(); await settledResume; await closing; }
  assert.equal(started, true, 'Runtime must cancel opening before awaiting the pending resume');
  assert.equal(managed.opens, 1); assert.equal(managed.closes, 1); assert.equal(managed.state, 'closed');
});

test('save/read use verified native data, duplicates do not dispatch and control snapshots contain metadata only', async t => {
  const f = await fixture(t), linked = await f.conversation(), managed = f.backends[0]!;
  const saved = await f.save(linked.conversationId, 'save-one', ` \n${BODY}\n `);
  assert.equal(saved.duplicate, false); assert.equal(saved.entry.status, 'applied'); assert.equal(saved.entry.canRead, true);
  assert.equal(saved.entry.bodyBytes, Buffer.byteLength(BODY)); assert.equal('body' in saved, false);
  assert.deepEqual(managed.transport.calls, ['shiyu_memory_create', 'shiyu_memory_operation_status', 'shiyu_memory_get']);
  const duplicate = await f.save(linked.conversationId); assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.entry, saved.entry);
  assert.equal(managed.transport.calls.length, 3);
  const read = await f.runtime.command({ action: 'memory.readLocal', operationId: saved.entry.operationId }) as { entry: PublicEntry; body: string };
  assert.equal(read.body, BODY); assert.equal(read.entry.operationId, saved.entry.operationId);
  assert.deepEqual(managed.transport.calls.slice(3), ['shiyu_memory_operation_status', 'shiyu_memory_get']);
  for (let i = 0; i < 3; i++) {
    const snapshot = await f.runtime.snapshot(); assert.equal(snapshot.memory.entries.length, 1);
    assert.equal(snapshot.memory.entries[0]!.canRead, true); assert.equal(JSON.stringify(snapshot).includes(BODY), false);
    assert.equal('command' in snapshot.memory.entries[0]!, false); assert.equal('receipt' in snapshot.memory.entries[0]!, false);
  }
  assert.equal(managed.transport.calls.length, 5);
  assert.equal(JSON.stringify(await f.runtime.store.request('memory.list', {})).includes(BODY), false);
  await assert.rejects(f.save(linked.conversationId, 'save-one', `${BODY} changed`), /different memory input/);
  assert.equal(managed.transport.calls.length, 5);
  await f.runtime.close();
  for (const file of ['runtime-state.json', 'control/events.sqlite']) assert.equal((await readFile(path.join(f.directory, file))).includes(Buffer.from(BODY)), false);
  assert.equal(managed.closes, 1);
});

test('unknown native create stays unknown and a repeated public save never replays it', async t => {
  const f = await fixture(t), linked = await f.conversation(), managed = f.backends[0]!;
  managed.transport.failCreate = true; await assert.rejects(f.save(linked.conversationId));
  const snapshot = await f.runtime.snapshot(); assert.equal(snapshot.memory.entries[0]!.status, 'unknown'); assert.equal(snapshot.memory.entries[0]!.canRead, false);
  const duplicate = await f.save(linked.conversationId); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.entry.status, 'unknown');
  await assert.rejects(f.runtime.command({ action: 'memory.readLocal', operationId: duplicate.entry.operationId }));
  assert.deepEqual(managed.transport.calls, ['shiyu_memory_create']);
});

test('pause blocks reads and saves but withdrawal remains available even when the backend is down', async t => {
  const f = await fixture(t), linked = await f.conversation(), managed = f.backends[0]!, saved = await f.save(linked.conversationId);
  await f.runtime.command({ action: 'runtime.pause' }); managed.state = 'failed';
  const withdrawn = await f.runtime.command({ action: 'memory.withdrawLocal', requestId: 'withdraw-one', operationId: saved.entry.operationId }) as PublicEntry;
  assert.equal(withdrawn.operationId, saved.entry.operationId); assert.equal(withdrawn.blocked, true); assert.equal(withdrawn.canRead, false); assert.equal(withdrawn.consent, 'withdrawn');
  assert.equal('entry' in withdrawn, false); assert.equal('body' in withdrawn, false);
  await assert.rejects(f.save(linked.conversationId, 'save-after-pause'), /paused/);
  await assert.rejects(f.runtime.command({ action: 'memory.readLocal', operationId: saved.entry.operationId }), /paused/);
  const snapshot = await f.runtime.snapshot(); assert.equal(snapshot.memory.entries[0]!.canRead, false); assert.equal(snapshot.memory.entries[0]!.blocked, true);
  assert.equal(managed.transport.calls.length, 3);
  // Withdrawal is a local barrier, not a claim that the native body was deleted.
  assert.equal(managed.transport.rows.size, 1);
});

test('pause cancels an in-flight read and a concurrent withdrawal prevents body release', async t => {
  const f = await fixture(t), linked = await f.conversation(), managed = f.backends[0]!, saved = await f.save(linked.conversationId);
  const entered = deferred(), release = deferred();
  managed.transport.afterGet = async () => { entered.resolve(); await release.promise; };
  const reading = assert.rejects(f.runtime.command({ action: 'memory.readLocal', operationId: saved.entry.operationId }));
  try {
    await entered.promise; assert.equal((await f.runtime.snapshot()).activeWork.length, 1);
    await f.runtime.command({ action: 'runtime.pause' });
    const withdrawn = await f.runtime.command({ action: 'memory.withdrawLocal', requestId: 'withdraw-during-read', operationId: saved.entry.operationId }) as PublicEntry;
    assert.equal(withdrawn.canRead, false);
  } finally { release.resolve(); }
  await reading;
  assert.equal((await f.runtime.snapshot()).activeWork.length, 0);
  assert.equal(managed.transport.calls.filter(name => name === 'shiyu_memory_create').length, 1);
});

test('close drains late backend I/O and records uncertainty before closing the owned backend and control store', async t => {
  const f = await fixture(t), linked = await f.conversation(), managed = f.backends[0]!, entered = deferred(), release = deferred();
  managed.transport.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const saving = assert.rejects(f.save(linked.conversationId)); await entered.promise;
  let observedStatus: string | undefined;
  managed.beforeClose = async () => { observedStatus = (await f.runtime.store.request('memory.list', {}))[0]!.operation.status; };
  let closed = false; const closing = f.runtime.close().then(() => { closed = true; });
  try { await saving; await tick(); assert.equal(closed, false); assert.equal(managed.closes, 0); }
  finally { release.resolve(); await closing; }
  assert.equal(observedStatus, 'unknown'); assert.equal(managed.closes, 1); assert.equal(managed.transport.rows.size, 1);
  await assert.rejects(f.runtime.store.info(), /closed/);
  await assert.rejects(f.save(linked.conversationId, 'after-close'), /stopping/);
  assert.deepEqual(managed.transport.calls, ['shiyu_memory_create']);
});

test('public memory commands reject extra authority/receipt fields and malformed identities before backend or ledger changes', async t => {
  const f = await fixture(t), linked = await f.conversation(), managed = f.backends[0]!;
  const save = { action: 'memory.rememberLocal', requestId: 'strict-save', conversationId: linked.conversationId, text: BODY };
  const read = { action: 'memory.readLocal', operationId: 'synthetic-operation' };
  const withdraw = { action: 'memory.withdrawLocal', requestId: 'strict-withdraw', operationId: 'synthetic-operation' };
  for (const base of [save, read, withdraw]) for (const field of ['actor', 'scope', 'claim', 'observation', 'backendId', 'signal']) {
    await assert.rejects(f.runtime.command({ ...base, [field]: 'untrusted' }), /Invalid local memory input/);
  }
  for (const input of [{ ...save, requestId: '../invalid' }, { ...save, conversationId: '' }, { ...save, text: 3 }, { ...read, operationId: '' }, { ...withdraw, requestId: '' }]) {
    await assert.rejects(f.runtime.command(input), /Invalid local memory input/);
  }
  const accessor = { ...save }; Object.defineProperty(accessor, 'text', { get() { throw new Error('Untrusted accessor ran'); }, enumerable: true });
  await assert.rejects(f.runtime.command(accessor), /Invalid local memory input/);
  await assert.rejects(f.runtime.command(Object.assign(Object.create({ inherited: true }), save)), /Invalid local memory input/);
  assert.deepEqual(managed.transport.calls, []); assert.deepEqual(await f.runtime.store.request('memory.list', {}), []);
});
