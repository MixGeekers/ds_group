import { prepareSyntheticLocalNote } from './helpers/capability.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { RuntimeService, type SessionDriver } from '../src/runtime.js';
import { defaultModel, sessionBindingKey, type ContextLoadRequest, type ContextLoadResult, type DshContext } from '../src/adapters/dsh/sessions.js';
import { ControlledOmbreAdapter, type NativeMemoryReceipt } from '../src/adapters/ombre/controlled.js';
import type { ManagedOmbreConfig, ManagedOmbreState, ManagedOmbreStatus } from '../src/adapters/ombre/managed.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryCreateCommand } from '../src/contracts/memory.js';
import { OMBRE_HARRIER_PROFILE_FINGERPRINT, OMBRE_HARRIER_PROFILE_ID } from '../src/contracts/semantic-memory.js';
import type { LocalMemorySearchService } from '../src/control/local-memory-search.js';
import type { LocalReplyLoadResult } from '../src/control/local-reply.js';
import type { MemoryIndexEntry } from '../src/adapters/control-store/memory-index-domain.js';

// Real Runtime + Worker + SQLite domains. The synthetic private transport and
// native Session boundary make no process, embedding, generation or network call.
// Semantic route tests explicitly stub service methods, not authorization data.
const BODY = 'Synthetic runtime semantic fixture: the amber notebook belongs on shelf seven.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture operation did not settle within 5 seconds')), 5000); })]); }
  finally { clearTimeout(timer); }
}
type Row = { command: MemoryCreateCommand; body: string; receipt: NativeMemoryReceipt };
type PublicSaved = { duplicate: boolean; entry: { operationId: string; canRead: boolean; status: string; consent: string } };
const searchService = (runtime: RuntimeService): LocalMemorySearchService => (runtime as unknown as { memorySearch: LocalMemorySearchService }).memorySearch;

class SyntheticManaged {
  readonly adapter: ControlledOmbreAdapter;
  readonly calls: string[] = [];
  state: ManagedOmbreState = 'idle';
  opens = 0; closes = 0;
  beforeOpen?: () => Promise<void>;
  beforeClose?: () => Promise<void>;
  private closing?: Promise<void>;
  constructor(readonly config: ManagedOmbreConfig, readonly rows: Map<string, Row>) {
    this.adapter = new ControlledOmbreAdapter({ callTool: async request => {
      this.calls.push(request.name); assert.equal(this.state, 'ready');
      let result: unknown;
      const envelope = (row: Row) => ({ schemaVersion: 1, backendId: config.backendId, deploymentId: config.deploymentId, scope: config.scope,
        operationId: row.command.operationId, state: 'applied', command: row.command, commandDigest: memoryCommandDigest(row.command),
        plannedNativeId: row.receipt.nativeId, nativeId: row.receipt.nativeId, receipt: row.receipt, reason: null });
      if (request.name === 'shiyu_memory_create') {
        const command = structuredClone(request.arguments.command) as MemoryCreateCommand, body = String(request.arguments.body);
        const receipt: NativeMemoryReceipt = { schemaVersion: 1, receiptId: `receipt_${sha(command.operationId)}`, operationId: command.operationId,
          backendId: config.backendId, deploymentId: config.deploymentId, scope: config.scope, commandDigest: memoryCommandDigest(command),
          nativeId: `shiyu_${sha(command.operationId).slice(0, 32)}`, ...memoryBodyDigest(body), sourceRefs: command.sourceRefs,
          componentVersion: `sha256:${sha(body)}`, outcome: 'applied', bodyDurable: true, indexState: 'disabled', observedAt: new Date().toISOString(), reconciled: false };
        const row = { command, body, receipt }; rows.set(command.operationId, row); result = envelope(row);
      } else if (request.name === 'shiyu_memory_operation_status') {
        const row = rows.get(String(request.arguments.operationId)); assert.ok(row); result = envelope(row);
      } else if (request.name === 'shiyu_memory_get') {
        const row = [...rows.values()].find(value => value.receipt.nativeId === request.arguments.nativeId); assert.ok(row);
        result = { schemaVersion: 1, backendId: config.backendId, deploymentId: config.deploymentId, scope: config.scope,
          state: 'found', nativeId: row.receipt.nativeId, command: row.command, commandDigest: memoryCommandDigest(row.command),
          receipt: row.receipt, body: row.body, bodyDigest: row.command.bodyDigest, componentVersion: row.receipt.componentVersion, reason: null };
      } else throw new Error(`Unexpected synthetic tool: ${request.name}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } }, config, { semanticApi: true });
  }
  async open() {
    this.opens++; this.state = 'opening'; await this.beforeOpen?.();
    if ((this.state as ManagedOmbreState) !== 'opening') throw new Error('Synthetic startup cancelled');
    this.state = 'ready';
  }
  status(): ManagedOmbreStatus {
    return { configured: true, state: this.state, backendId: this.config.backendId, deploymentId: this.config.deploymentId, scope: 'local-owner',
      embedding: 'managed-harrier', semanticReady: false, bindingVerified: this.state === 'ready', storageReady: this.state === 'ready', protocolVersion: 2,
      semantic: { state: 'unverified', profileCompatible: true, embeddingVerified: false, profileId: OMBRE_HARRIER_PROFILE_ID,
        profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT, indexBaselineId: `index_${'a'.repeat(32)}`, indexWatermark: 0,
        recordedIndexedCount: 0, observedAt: null, lastEmbeddingSuccessAt: null }, toolCount: this.state === 'ready' ? 7 : 0, stderrBytes: 0, stderrTruncated: false };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closes++; this.state = 'closing';
    return this.closing = (async () => { await this.beforeClose?.(); this.state = 'closed'; })();
  }
}

async function fixture(t: TestContext, options: { paused?: boolean; loadOnly?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-runtime-semantic-'));
  const config: ManagedOmbreConfig = { schemaVersion: 2, backendId: 'runtime-semantic-fixture', deploymentId: 'runtime-semantic-deployment', scope: 'local-owner',
    python: process.execPath, upstream: join(directory, 'synthetic-upstream'), root: join(directory, 'synthetic-native-root'),
    embedding: { mode: 'managed-harrier', profileId: OMBRE_HARRIER_PROFILE_ID, serverBinary: join(directory, 'synthetic-bin'), modelArtifact: join(directory, 'synthetic-model') } };
  await mkdir(join(directory, 'memory')); await writeFile(join(directory, 'memory/backend.json'), JSON.stringify(config));
  if (options.paused) await writeFile(join(directory, 'runtime-state.json'), JSON.stringify({ schemaVersion: 1, paused: true, bindings: [] }));
  const rows = new Map<string, Row>(), runtimes: RuntimeService[] = [], backends: SyntheticManaged[] = [];
  const nativeCalls = { generation: 0, worker: 0, goal: 0 }, loads: ContextLoadRequest[] = [];
  const sessions: SessionDriver = {
    async initialize() {}, async prepareContextSafety() { return { ready: true, messageFactory: 'injected', nativeReadback: true, coldProjection: true }; },
    async probe() { throw new Error('Native probe forbidden'); },
    async generateReply() { nativeCalls.generation++; throw new Error('Generation forbidden'); },
    async getStatus() { return []; }, async cancel() {}, async close() {},
    ...(options.loadOnly === false ? {} : { async loadContextOnly(request: ContextLoadRequest): Promise<ContextLoadResult> {
      loads.push(request); const sessionId = request.context.expectedSessionId ?? `fixture-${sha(request.businessId).slice(0, 24)}`;
      const binding = { operationId: request.context.operationId, contextTokenId: request.context.contextTokenId, sessionEpoch: request.context.sessionEpoch,
        key: sessionBindingKey('replyer', request.businessId, request.scope), businessId: request.businessId, scope: request.scope, sessionId,
        messageId: `message-${request.context.operationId}`, messageHash: sha(request.prompt) };
      await request.context.authorize({ phase: 'admission', ...binding }); await request.context.onBound(binding);
      await request.context.authorize({ phase: 'append', ...binding });
      const receipt = { ...binding, userMessageSeq: loads.length, confirmedAt: new Date().toISOString(), durability: 'confirmed' as const };
      await request.context.authorize({ phase: 'context_ack', ...binding }); await request.context.onContextDurable(receipt);
      await request.context.authorize({ phase: 'release', ...binding });
      return { mode: 'load-only', inferenceRequested: false, followupRequested: false, contextReceipt: receipt,
        binding: { key: binding.key, role: 'replyer', businessId: request.businessId, scope: request.scope, sessionId, model: defaultModel('replyer'),
          status: 'released', createdAt: receipt.confirmedAt, updatedAt: receipt.confirmedAt, usage: { status: 'unknown' } } };
    } }),
  };
  const open = async () => {
    const runtime = new RuntimeService({} as DshContext, { dataDir: directory }, {
      sessionFactory: () => sessions,
      workerFactory: () => ({ prepareLocalNote: prepareSyntheticLocalNote, async initialize() {}, async close() {}, async run() { nativeCalls.worker++; throw new Error('Worker generation forbidden'); } }),
      goalFactory: () => ({ async initialize() {}, async close() {}, async run() { nativeCalls.goal++; throw new Error('Goal forbidden'); } }),
      memoryFactory(binding) { const backend = new SyntheticManaged(binding, rows); backends.push(backend); return backend; },
    });
    runtimes.push(runtime); await runtime.init(); return runtime;
  };
  t.after(async () => { try { for (const runtime of runtimes) await runtime.close(); assert.deepEqual(nativeCalls, { generation: 0, worker: 0, goal: 0 }); }
    finally { await rm(directory, { recursive: true, force: true }); } });
  const runtime = await open(), backend = backends[0]!;
  const conversation = async () => {
    // Trusted fixture admission never dispatches the synthetic Task.
    const { task } = await runtime.store.request('task.createLocal', { requestId: 'anchor-task', title: 'Synthetic anchor', content: 'Task context fixture' });
    return runtime.store.request('conversation.ensureLocalTask', { taskId: task.taskId });
  };
  const save = (conversationId: string) => runtime.command({ action: 'memory.rememberLocal', requestId: 'save-one', conversationId, text: BODY }) as Promise<PublicSaved>;
  return { runtime, backend, backends, directory, open, nativeCalls, loads, conversation, save };
}

test('schema2 compatible but unverified embedding permits explicit index/search without claiming verified inference', async t => {
  const f = await fixture(t), service = searchService(f.runtime), routes: string[] = [];
  const before = await f.runtime.snapshot();
  assert.equal(before.memory.semanticConfigured, true); assert.equal(before.memory.backend!.semanticReady, false);
  assert.equal(before.memory.backend!.semantic!.embeddingVerified, false);
  assert.deepEqual(before.innerProjection!.manifest.domains.memory, { status: 'available', backendId: f.backend.config.backendId,
    deploymentId: f.backend.config.deploymentId, capabilities: ['exact_read', 'semantic_search'], profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT });
  service.index = async input => {
    routes.push('index'); assert.equal(input.operationId, 'memory-one'); assert.ok(input.signal); assert.equal(input.signal.aborted, false);
    return { duplicate: false, entry: { indexOperationId: 'index-one', command: { memoryOperationId: input.operationId },
      effect: { status: 'succeeded' }, publishable: true, embeddingUsage: { calls: 1, complete: true } } as MemoryIndexEntry };
  };
  service.search = async input => {
    routes.push('search'); assert.equal(input.text, 'notebook'); assert.ok(input.signal);
    return { state: 'ok', operationIds: ['memory-one'], matches: [{ operationId: 'memory-one', score: 0.8, indexReceiptId: 'synthetic-index-receipt', indexWatermark: 1 }],
      coverage: { eligibleCount: 1, indexedCount: 1, missingCount: 0 }, embeddingUsage: { calls: 1, complete: true } };
  };
  assert.deepEqual(await f.runtime.command({ action: 'memory.indexLocal', requestId: 'index-request', operationId: 'memory-one' }),
    { duplicate: false, entry: { indexOperationId: 'index-one', memoryOperationId: 'memory-one', status: 'succeeded', publishable: true, embeddingUsage: { calls: 1, complete: true } } });
  const result = await f.runtime.command({ action: 'memory.searchLocal', conversationId: 'conversation-one', query: 'notebook' }) as { embeddingCalls: number; usageComplete: boolean };
  assert.equal(result.embeddingCalls, 1); assert.equal(result.usageComplete, true); assert.deepEqual(routes, ['index', 'search']);
  const after = await f.runtime.snapshot(); assert.equal(after.memory.backend!.semantic!.embeddingVerified, false);
  assert.deepEqual(after.memory.lastSemanticOperation?.embeddingUsage, { calls: 1, complete: true });
  assert.deepEqual(after.usage, { calls: null, inputTokens: null, outputTokens: null, cacheReadTokens: null }); assert.deepEqual(f.backend.calls, []);
});

test('dashboard snapshot/refresh only reads: no backend query, index, service startup or availability publication', async t => {
  const f = await fixture(t), requests: string[] = [], initial = (await f.runtime.store.request('view.state', {}))!;
  const request = f.runtime.store.request.bind(f.runtime.store);
  f.runtime.store.request = ((command: Parameters<typeof request>[0], args: never) => { requests.push(command); return request(command, args); }) as typeof request;
  const service = searchService(f.runtime);
  service.index = async () => { throw new Error('Read triggered index'); }; service.search = async () => { throw new Error('Read triggered search'); };
  for (let count = 0; count < 3; count++) {
    const snapshot = await f.runtime.snapshot(); assert.deepEqual(snapshot.innerProjection, initial);
  }
  assert.equal(requests.includes('state.publishMemoryAvailability'), false); assert.deepEqual(f.backend.calls, []);
  assert.equal(f.backend.opens, 1); assert.equal(f.backend.closes, 0);
});

test('duplicate unknown index reports existing uncertainty and preserves original cumulative usage', async t => {
  const f = await fixture(t);
  searchService(f.runtime).index = async () => ({ duplicate: true, entry: { indexOperationId: 'unknown-index', command: { memoryOperationId: 'memory-one' },
    effect: { status: 'unknown' }, publishable: false, embeddingUsage: { calls: null, complete: false } } as MemoryIndexEntry });
  const result = await f.runtime.command({ action: 'memory.indexLocal', requestId: 'existing-index', operationId: 'memory-one' }) as
    { duplicate: boolean; entry: { status: string; publishable: boolean } };
  assert.equal(result.duplicate, true); assert.equal(result.entry.status, 'unknown'); assert.equal(result.entry.publishable, false);
  const snapshot = await f.runtime.snapshot();
  assert.equal(snapshot.memory.lastSemanticOperation?.status, 'existing'); assert.equal(snapshot.memory.lastSemanticOperation?.outcome, 'unknown');
  assert.deepEqual(snapshot.memory.lastSemanticOperation?.embeddingUsage, { calls: null, complete: false }); assert.deepEqual(f.backend.calls, []);
});

test('real Worker loadContext uses durable native load only; duplicate returns no invented load receipt', async t => {
  const f = await fixture(t), conversation = await f.conversation(), saved = await f.save(conversation.conversationId);
  searchService(f.runtime).select = async () => ({ operationIds: [saved.entry.operationId], embeddingUsage: { calls: 0, complete: true } });
  let runs = 0; f.runtime.localReplies.run = async () => { runs++; throw new Error('loadContext routed to reply run'); };
  const input = { action: 'conversation.loadContext', conversationId: conversation.conversationId, inputId: 'load-one', text: 'Load notebook context.' };
  const loaded = await f.runtime.command(input) as LocalReplyLoadResult & { status: string; inferenceRequested: boolean; followupRequested: boolean; sent: boolean };
  assert.equal(loaded.status, 'loaded'); assert.equal(loaded.inferenceRequested, false); assert.equal(loaded.followupRequested, false); assert.equal(loaded.sent, false);
  assert.equal(loaded.operation.status, 'loaded'); assert.ok(loaded.load?.contextReceipt); assert.equal(f.loads.length, 1); assert.equal(runs, 0);
  assert.ok(f.loads[0]!.prompt.includes(BODY));
  const persisted = await f.runtime.store.request('conversation.reply.get', { operationId: loaded.operation.operationId });
  assert.deepEqual(persisted.contextReceipt, loaded.load!.contextReceipt);
  const beforeCalls = [...f.backend.calls];
  const duplicate = await f.runtime.command(input) as LocalReplyLoadResult & { status: string };
  assert.equal(duplicate.status, 'existing'); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.load, undefined); assert.equal(duplicate.view, undefined);
  assert.deepEqual(duplicate.operation.contextReceipt, loaded.load!.contextReceipt); assert.equal(f.loads.length, 1); assert.equal(runs, 0);
  assert.deepEqual(f.backend.calls, beforeCalls); assert.equal(JSON.stringify(await f.runtime.snapshot()).includes(BODY), false);
});

test('real Worker withdrawal while paused and backend down retires exposed context and notifies cancellation', async t => {
  const f = await fixture(t), conversation = await f.conversation(), saved = await f.save(conversation.conversationId);
  searchService(f.runtime).select = async () => ({ operationIds: [saved.entry.operationId], embeddingUsage: { calls: 0, complete: true } });
  await f.runtime.command({ action: 'conversation.loadContext', conversationId: conversation.conversationId, inputId: 'load-before-withdraw', text: 'Load authorized memory.' });
  const previous = await f.runtime.store.request('conversation.snapshotLocal', { conversationId: conversation.conversationId });
  await f.runtime.command({ action: 'runtime.pause' }); f.backend.state = 'failed';
  const cancelled: string[][] = [], original = f.runtime.localReplies.cancelConversations.bind(f.runtime.localReplies);
  f.runtime.localReplies.cancelConversations = ids => { cancelled.push([...ids]); original(ids); };
  const beforeCalls = [...f.backend.calls];
  const withdrawn = await f.runtime.command({ action: 'memory.withdrawLocal', requestId: 'withdraw-one', operationId: saved.entry.operationId }) as
    { consent: string; canRead: boolean; contextInvalidation: { conversationIds: string[]; retiredSessions: { businessId: string }[] } };
  assert.equal(withdrawn.consent, 'withdrawn'); assert.equal(withdrawn.canRead, false);
  assert.deepEqual(cancelled, [[conversation.conversationId]]); assert.deepEqual(withdrawn.contextInvalidation.conversationIds, [conversation.conversationId]);
  const current = await f.runtime.store.request('conversation.snapshotLocal', { conversationId: conversation.conversationId });
  assert.ok(current.conversations[0]!.sessionEpoch > previous.conversations[0]!.sessionEpoch);
  assert.ok(current.conversations[0]!.routingRevision > previous.conversations[0]!.routingRevision);
  assert.equal(withdrawn.contextInvalidation.retiredSessions[0]!.businessId, f.loads[0]!.businessId);
  await assert.rejects(f.runtime.store.request('memory.readLocal', { operationId: saved.entry.operationId }), /unavailable|forbidden|read/i);
  await f.runtime.command({ action: 'memory.withdrawLocal', requestId: 'withdraw-again', operationId: saved.entry.operationId });
  assert.equal(cancelled.length, 1); assert.deepEqual(f.backend.calls, beforeCalls);
});

test('public commands cannot enter private availability/index protocol or inject semantic authority', async t => {
  const f = await fixture(t), before = await f.runtime.store.request('view.state', {});
  for (const action of ['state.publishMemoryAvailability', 'memory.index.prepare', 'memory.validateForView', 'memory.unrecognized']) {
    await assert.rejects(f.runtime.command({ action }), /Unsupported runtime command/);
  }
  for (const patch of [{ actor: 'local-owner' }, { scope: 'local-owner' }, { profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT }, { eligibleRefs: [] }]) {
    await assert.rejects(f.runtime.command({ action: 'memory.searchLocal', conversationId: 'conversation-one', query: 'notebook', ...patch }), /Invalid semantic memory input/);
  }
  assert.deepEqual(await f.runtime.store.request('view.state', {}), before); assert.deepEqual(f.backend.calls, []);
});

test('loadContext fails before admission when native load-only is missing instead of falling back to generation', async t => {
  const f = await fixture(t, { loadOnly: false }), conversation = await f.conversation();
  const before = await f.runtime.store.request('control.watermark', {});
  await assert.rejects(f.runtime.command({ action: 'conversation.loadContext', conversationId: conversation.conversationId, inputId: 'no-native-load', text: 'Load only.' }), /load-only capability is unavailable/);
  assert.deepEqual(await f.runtime.store.request('control.watermark', {}), before); assert.deepEqual(f.backend.calls, []);
});

test('close aborts semantic operations and drains both local services before backend and store', async t => {
  const f = await fixture(t), entered = deferred(), searchDrain = deferred(), replyDrain = deferred(), order: string[] = [];
  const service = searchService(f.runtime); let signal!: AbortSignal;
  service.index = input => { signal = input.signal!; entered.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Synthetic index cancelled')), { once: true })); };
  service.close = async () => { order.push('search-close'); await searchDrain.promise; order.push('search-drained'); };
  const replyClose = f.runtime.localReplies.close.bind(f.runtime.localReplies);
  f.runtime.localReplies.close = async () => { order.push('reply-close'); await replyClose(); await replyDrain.promise; order.push('reply-drained'); };
  f.backend.beforeClose = async () => { order.push('backend-close'); };
  const storeClose = f.runtime.store.close.bind(f.runtime.store);
  f.runtime.store.close = async () => { order.push('store-close'); await storeClose(); };
  const running = f.runtime.command({ action: 'memory.indexLocal', requestId: 'slow-index', operationId: 'memory-one' });
  const cancelled = assert.rejects(running, /cancelled/);
  try {
    await within(entered.promise);
    let finished = false; const closing = f.runtime.close().then(() => { finished = true; });
    await within(cancelled); await tick(); assert.equal(signal.aborted, true); assert.equal(finished, false); assert.equal(f.backend.closes, 0);
    assert.equal((await f.runtime.store.info()).journalMode, 'wal'); assert.ok(order.includes('search-close')); assert.ok(order.includes('reply-close'));
    replyDrain.resolve(); await tick(); assert.equal(f.backend.closes, 0);
    searchDrain.resolve(); await within(closing);
    assert.ok(order.indexOf('backend-close') > order.indexOf('search-drained')); assert.ok(order.indexOf('backend-close') > order.indexOf('reply-drained'));
    assert.ok(order.indexOf('store-close') > order.indexOf('backend-close')); assert.equal(f.backend.closes, 1);
  } finally { searchDrain.resolve(); replyDrain.resolve(); await within(f.runtime.close()); }
});

test('close cancels an owned semantic backend startup before waiting for resume', async t => {
  const f = await fixture(t, { paused: true }), entered = deferred(), opening = deferred();
  f.backend.beforeOpen = async () => { entered.resolve(); await opening.promise; };
  f.backend.beforeClose = async () => { opening.resolve(); };
  const resume = f.runtime.command({ action: 'runtime.resume' });
  const resumed = resume.catch(() => undefined);
  try {
    await within(entered.promise); await within(f.runtime.close()); await within(resumed);
    assert.equal(f.backend.opens, 1); assert.equal(f.backend.closes, 1); assert.equal(f.backend.state, 'closed'); assert.deepEqual(f.backend.calls, []);
  } finally { opening.resolve(); await within(f.runtime.close()); await within(resumed); }
});

test('real Worker restart with corrupt index metadata degrades semantic only and retains exact memory reads', async t => {
  const f = await fixture(t), conversation = await f.conversation(), saved = await f.save(conversation.conversationId);
  await f.runtime.close();
  // Closed temporary DB only: use its owned transaction/watermark, so the test
  // isolates index corruption instead of triggering unrelated schema quarantine.
  const db = new DatabaseSync(join(f.directory, 'control/events.sqlite'));
  try {
    const tx = new SqliteTransactions(db); installCommitWatermark(db, tx);
    tx.atomic(() => db.prepare('DELETE FROM shiyu_memory_index_meta').run());
  } finally { db.close(); }
  const reopened = await f.open(), snapshot = await reopened.snapshot();
  assert.equal(snapshot.lifecycle, 'degraded'); assert.equal(snapshot.memory.ready, true); assert.equal(snapshot.memory.semanticConfigured, false);
  assert.equal(snapshot.memory.semanticErrorCode, 'CORRUPT_INDEX_DOMAIN'); assert.equal(snapshot.memory.errorCode, undefined);
  assert.deepEqual(snapshot.innerProjection!.manifest.domains.memory, { status: 'available', backendId: f.backend.config.backendId,
    deploymentId: f.backend.config.deploymentId, capabilities: ['exact_read'] });
  assert.equal(snapshot.memory.entries.find(entry => entry.operationId === saved.entry.operationId)?.canRead, true);
  const read = await reopened.command({ action: 'memory.readLocal', operationId: saved.entry.operationId }) as { body: string }; assert.equal(read.body, BODY);
  await assert.rejects(reopened.command({ action: 'memory.searchLocal', conversationId: conversation.conversationId, query: 'notebook' }), /Semantic memory backend is unavailable/);
  await assert.rejects(reopened.command({ action: 'memory.indexLocal', requestId: 'blocked-index', operationId: saved.entry.operationId }), /Semantic memory backend is unavailable/);
  assert.ok(f.backends[1]!.calls.every(call => ['shiyu_memory_operation_status', 'shiyu_memory_get'].includes(call)));
});
