import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ConversationStore } from '../src/control/conversations/index.js';
import { LocalReplyDomain } from '../src/adapters/control-store/local-reply-domain.js';
import { MemoryDomain, type LocalMemoryEntry } from '../src/adapters/control-store/memory-domain.js';
import { MemoryIndexDomain } from '../src/adapters/control-store/memory-index-domain.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { createControlAuthority } from '../src/adapters/control-store/authority.js';
import { LocalReadSafetyStore } from '../src/state/safety.js';
import { StatePublicationStore, createStatePublisher, initialStateManifest } from '../src/state/publication.js';
import { ViewDomain } from '../src/adapters/control-store/view-domain.js';
import { LocalReplyService, type LocalReplySessionDriver } from '../src/control/local-reply.js';
import { LocalMemorySearchService } from '../src/control/local-memory-search.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { canonicalSemanticMemory, memoryIndexCommandDigest, memoryQueryDigest, OMBRE_HARRIER_PROFILE_FINGERPRINT,
  type MemoryIndexCommand, type MemoryIndexObservation, type MemorySearchRequest, type MemorySearchResult, type SemanticBackendStatus } from '../src/contracts/semantic-memory.js';
import type { ContextLoadRequest, ContextLoadResult } from '../src/adapters/dsh/sessions.js';
import { defaultModel, sessionBindingKey } from '../src/adapters/dsh/sessions.js';
import type { TaskView } from '../src/control/tasks/types.js';
import type { ControlStore } from '../src/adapters/control-store/index.js';

const OWNER = { principalId: 'local-owner', kind: 'owner' as const, scopes: ['local-owner'] };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonicalSemanticMemory(value)).digest('hex');
const BINDING = { backendId: 'fixture-memory', deploymentId: 'fixture-deployment', scope: 'local-owner' as const };
const PROFILE = OMBRE_HARRIER_PROFILE_FINGERPRINT;
const BASELINE = `index_${'d'.repeat(32)}`;
const TASK = { taskId: 'synthetic-task', title: 'Synthetic task metadata', state: 'queued', version: 1, updatedAt: '2026-11-03T00:00:00.000Z', stopRequested: false } as TaskView;

interface World {
  closed: boolean;
  db: DatabaseSync;
  service: LocalReplyService;
  search: LocalMemorySearchService;
  memories: MemoryDomain;
  conversation: { conversationId: string };
  second: { conversationId: string };
  requests: ContextLoadRequest[];
  sessions: Map<string, string[]>;
  bodyByOperation: Map<string, string>;
  searchCalls: number;
  reads: number;
  save(conversationId: string, body: string, requestId?: string): LocalMemoryEntry;
  index(operationId: string, requestId?: string): Promise<void>;
  load(inputId: string, text: string, conversationId?: string): ReturnType<LocalReplyService['load']>;
  withdraw(operationId: string, requestId?: string): void;
  close(): Promise<void>;
}
async function fixture(t: TestContext, options: { filename?: string } = {}): Promise<World & { reopen(): Promise<World> }> {
  const directory = options.filename ? undefined : await mkdtemp(join(tmpdir(), 'shiyu-single-user-chat-'));
  const filename = options.filename ?? join(directory!, 'control.sqlite');
  const bodyByOperation = new Map<string, string>(), sessions = new Map<string, string[]>();
  const worlds: World[] = [];
  const open = (): World => {
    const db = new DatabaseSync(filename), tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx), at = new Date().toISOString();
    const conversations = new ConversationStore(db, tx, { ownerIds: ['local-owner'], componentPermissions: {}, authorizeReference: () => true, now: () => new Date() });
    const conversation = conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: 'single-user-primary', kind: 'direct', scope: 'local-owner' });
    const second = conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: 'single-user-other', kind: 'direct', scope: 'local-owner' });
    const topic = conversations.createTopic(OWNER, { topicId: 'single-user-topic', scope: 'local-owner' });
    conversations.linkTopic(OWNER, { conversationId: conversation.conversationId, topicId: topic.topicId, expectedConversationRevision: conversation.revision, expectedTopicRevision: topic.revision });
    conversations.linkReference(OWNER, { topicId: topic.topicId, expectedRevision: conversations.getTopic(OWNER, topic.topicId).revision, reference: { kind: 'task', id: 'synthetic-task' } });
    const secondTopic = conversations.createTopic(OWNER, { topicId: 'single-user-topic-other', scope: 'local-owner' });
    conversations.linkTopic(OWNER, { conversationId: second.conversationId, topicId: secondTopic.topicId, expectedConversationRevision: second.revision, expectedTopicRevision: secondTopic.revision });
    conversations.linkReference(OWNER, { topicId: secondTopic.topicId, expectedRevision: conversations.getTopic(OWNER, secondTopic.topicId).revision, reference: { kind: 'task', id: 'synthetic-task' } });
    const bindings = new Map<string, { bindingId: string }>();
    for (const current of [conversation, second]) bindings.set(current.conversationId, conversations.ensureReplyBinding(OWNER, { conversationId: current.conversationId }));
    const bindingFor = (conversationId: string) => conversations.getReplyBinding(OWNER, bindings.get(conversationId)!.bindingId);
    const binding = () => bindingFor(conversation.conversationId);
    const replies = new LocalReplyDomain(db, tx, { conversations, bindingFor: conversationId => bindingFor(conversationId), now: () => new Date() });
    const memories = new MemoryDomain(db, tx, { runtimeIdentity: { hostEpoch: 'fixture-host', installationGeneration: 'fixture-install' }, ...BINDING,
      getConversation: id => conversations.getConversation(OWNER, id), now: () => new Date(), onWithdrawSources: input => replies.invalidateMemorySources(input) });
    const indexes = new MemoryIndexDomain(db, tx, { runtimeIdentity: { hostEpoch: 'fixture-host', installationGeneration: 'fixture-install' }, ...BINDING, memory: memories,
      now: () => new Date() });
    const authority = createControlAuthority(db, tx, { now: () => new Date() });
    const safety = new LocalReadSafetyStore(db, tx, { getAuthEpoch: () => authority.health().authEpoch, now: () => new Date() });
    const publication = new StatePublicationStore(db, tx, { publisherIds: ['fixture-state'], now: () => new Date() });
    if (!publication.get()) publication.publish(createStatePublisher('fixture-state'), { requestId: 'initial-unavailable', manifest: initialStateManifest() });
    const baseline = publication.get()!;
    if (!(baseline.manifest.domains.memory.status === 'available')) {
      publication.publish(createStatePublisher('fixture-state'), { requestId: 'memory-capability', expectedBaselineId: baseline.baselineId, expectedStateVersion: baseline.stateVersion,
        manifest: { schemaVersion: 2, domains: { ...initialStateManifest().domains,
          memory: { status: 'available', backendId: BINDING.backendId, deploymentId: BINDING.deploymentId, capabilities: ['exact_read', 'semantic_search'], profileFingerprint: PROFILE } } } });
    }
    let activeConversation = conversation.conversationId;
    const views = new ViewDomain(db, tx, { publication, safety, watermark, memory: memories, now: () => new Date(),
      context: () => { const active = bindingFor(activeConversation); return { ...conversations.contextSnapshot(OWNER, active.bindingId), businessId: active.businessId, ...(active.sessionId ? { sessionId: active.sessionId } : {}) }; },
      getTask: () => TASK });
    replies.setAuthority({ validateCapture: (id, phase) => views.validateReplyCapture(id, { for: phase }), assertMemorySourcesCurrent: sources => memories.validateExposedSources(sources) });
    const store = { async request(command: string, args: never) {
      if (command.startsWith('view.')) return views.execute({ command, args } as never);
      if (command.startsWith('conversation.reply.')) return replies.execute({ command, args } as never);
      if (command.startsWith('memory.index.')) return indexes.execute({ command, args } as never);
      if (command.startsWith('memory.')) return memories.execute({ command, args } as never);
      throw new Error(`Unexpected fixture command ${command}`);
    } } as unknown as ControlStore;
    // Trusted same-Worker index ledger composition: the fake transport never leaves this process.
    const indexesCoverage = indexes.coverage();
    const indexedOps = new Set<string>();
    for (const row of db.prepare('SELECT record_json FROM shiyu_memory_index_operations').all() as { record_json: string }[]) {
      const record = JSON.parse(row.record_json) as { command?: { memoryOperationId?: string }; observation?: { state?: string } };
      if (record.observation?.state === 'applied' && typeof record.command?.memoryOperationId === 'string') indexedOps.add(record.command.memoryOperationId);
    }
    let watermarkValue = indexesCoverage.indexWatermark ?? 1;
    const status = (): SemanticBackendStatus => ({ schemaVersion: 2, ...BINDING, semanticApi: true, profileFingerprint: PROFILE,
      indexBaselineId: indexesCoverage.indexBaselineId ?? BASELINE, indexWatermark: watermarkValue, recordedIndexedCount: indexedOps.size, embeddingConfigured: true,
      limits: { maxEligibleRefs: 128, maxScannedRows: 2048, maxResults: 10, maxEmbeddingCallsPerIndex: 2, maxDeadlineMs: 60000 } });
    const observation = (command: MemoryIndexCommand): MemoryIndexObservation => ({ schemaVersion: 2, ...BINDING, indexOperationId: command.indexOperationId,
      currentIndexBaselineId: command.indexBaselineId, currentIndexWatermark: Math.max(watermarkValue, command.expectedIndexWatermark + 1), state: 'applied',
      command, commandDigest: memoryIndexCommandDigest(command), reason: null, embeddingCalls: 1, usageComplete: true,
      receipt: { schemaVersion: 2, ...BINDING, receiptId: `index_receipt_${hash(command.indexOperationId)}`, indexOperationId: command.indexOperationId,
        memoryOperationId: command.memoryOperationId, bodyReceiptId: command.bodyReceiptId, commandDigest: memoryIndexCommandDigest(command), nativeId: command.nativeId,
        componentVersion: command.componentVersion, bodyDigest: command.bodyDigest, profileFingerprint: command.profileFingerprint, indexBaselineId: command.indexBaselineId,
        indexWatermark: command.expectedIndexWatermark + 1, content: { digest: command.bodyDigest, vectorHash: hash('synthetic-vector'), dimensions: 1024 },
        meaning: { state: 'absent', digest: null, vectorHash: null, dimensions: null }, embeddingCalls: 1, observedAt: at } });
    let searchCalls = 0, reads = 0;
    const backend = {
      binding: BINDING,
      async backendStatus() { return status(); },
      async ensureIndex(command: MemoryIndexCommand) { indexedOps.add(command.memoryOperationId); watermarkValue = Math.max(watermarkValue, command.expectedIndexWatermark + 1); return observation(command); },
      async indexStatus(command: MemoryIndexCommand) { return observation(command); },
      async searchCandidates(request: MemorySearchRequest): Promise<MemorySearchResult> {
        searchCalls++;
        const missing = request.eligibleRefs.filter(ref => !indexedOps.has(ref.memoryOperationId));
        if (missing.length) return { schemaVersion: 2, ...BINDING, state: 'index_required', profileFingerprint: PROFILE, indexBaselineId: request.expectedIndexBaselineId,
          indexWatermark: request.expectedIndexWatermark, queryDigest: memoryQueryDigest(request.query), embeddingCalls: 0, usageComplete: true,
          coverage: { eligibleCount: request.eligibleRefs.length, indexedCount: request.eligibleRefs.length - missing.length, missingCount: missing.length }, matches: [] };
        return { schemaVersion: 2, ...BINDING, state: 'ok', profileFingerprint: PROFILE, indexBaselineId: request.expectedIndexBaselineId,
          indexWatermark: request.expectedIndexWatermark, queryDigest: memoryQueryDigest(request.query), embeddingCalls: 1, usageComplete: true,
          coverage: { eligibleCount: request.eligibleRefs.length, indexedCount: request.eligibleRefs.length, missingCount: 0 },
          matches: request.eligibleRefs.map((ref, index) => ({ memoryOperationId: ref.memoryOperationId, nativeId: ref.nativeId, componentVersion: ref.componentVersion,
            bodyDigest: ref.bodyDigest, indexReceiptId: `index_receipt_${hash(`${ref.memoryOperationId}:${index}`)}`, indexWatermark: request.expectedIndexWatermark, score: 0.9 - index * 0.05 })) };
      },
      async verifyApplied(command: { operationId: string }) {
        reads++;
        const body = bodyByOperation.get(command.operationId);
        if (body === undefined) throw new Error('Synthetic body missing');
        const value = memoryBodyDigest(body);
        const observation: MemoryBackendObservation = { command: command as never, commandDigest: memoryCommandDigest(command as never), deploymentId: BINDING.deploymentId,
          nativeId: `shiyu_${sha(command.operationId).slice(0, 32)}`, receiptId: `receipt_${sha(command.operationId)}`, componentVersion: `sha256:${sha(body)}`,
          bodyDigest: value.bodyDigest, bodyBytes: value.bodyBytes, sourceRefs: (command as unknown as { sourceRefs: never }).sourceRefs, observedAt: at };
        return { body, observation };
      },
    };
    const search = new LocalMemorySearchService({ store: store as never, backend: backend as never, assertRuntimeAllowed() {} });
    const requests: ContextLoadRequest[] = [];
    const native: LocalReplySessionDriver = {
      async generateReply() { throw new Error('No model generation allowed in this fixture'); },
      async loadContextOnly(request): Promise<ContextLoadResult> {
        requests.push(request);
        const sessionId = request.context.expectedSessionId ?? `shiyu-replyer-${sha(request.businessId).slice(0, 24)}`;
        const bound = { operationId: request.context.operationId, contextTokenId: request.context.contextTokenId, sessionEpoch: request.context.sessionEpoch,
          key: sessionBindingKey('replyer', request.businessId, request.scope), businessId: request.businessId, scope: request.scope, sessionId,
          messageId: `message-${request.context.operationId}`, messageHash: sha(request.prompt) };
        await request.context.authorize({ phase: 'admission', ...bound }); await request.context.onBound(bound);
        await request.context.authorize({ phase: 'append', ...bound });
        const history = sessions.get(sessionId) ?? []; history.push(request.prompt); sessions.set(sessionId, history);
        const receipt = { ...bound, userMessageSeq: history.length, confirmedAt: new Date().toISOString(), durability: 'confirmed' as const };
        await request.context.authorize({ phase: 'context_ack', ...bound }); await request.context.onContextDurable(receipt);
        await request.context.authorize({ phase: 'release', ...bound });
        return { mode: 'load-only', inferenceRequested: false, followupRequested: false, contextReceipt: receipt,
          binding: { key: bound.key, role: 'replyer', businessId: request.businessId, scope: request.scope, sessionId, model: defaultModel('replyer'),
            status: 'released', createdAt: receipt.confirmedAt, updatedAt: receipt.confirmedAt, usage: { status: 'unknown' } } };
      },
    };
    const service = new LocalReplyService({ store, sessions: native, now: () => new Date(), assertRuntimeAllowed() {},
      memory: { async select(input) { const result = await search.search({ conversationId: input.conversationId, text: input.text, signal: input.signal });
        return { operationIds: result.operationIds, ...(result.index ? { index: result.index } : {}) }; },
      async read(source) { return search.read(source); } } });
    const save = (conversationId: string, body: string, requestId = `save-${Math.random().toString(36).slice(2)}`): LocalMemoryEntry => {
      const value = memoryBodyDigest(body);
      const prepared = memories.prepareLocal({ requestId: `${requestId}-prepare`, conversationId, bodyDigest: value.bodyDigest, bytes: value.bodyBytes });
      const claim = memories.claim({ operationId: prepared.operation.operationId })!;
      const observation: MemoryBackendObservation = { command: prepared.command, commandDigest: memoryCommandDigest(prepared.command), deploymentId: BINDING.deploymentId,
        nativeId: `shiyu_${sha(prepared.operation.operationId).slice(0, 32)}`, receiptId: `receipt_${sha(prepared.operation.operationId)}`,
        componentVersion: `sha256:${sha(body)}`, ...value, sourceRefs: prepared.command.sourceRefs, observedAt: at };
      const saved = memories.recordVerifiedReceipt({ operationId: prepared.operation.operationId, claim: claim.claim, observation, reconciliation: false });
      bodyByOperation.set(saved.operation.operationId, body);
      return saved;
    };
    const world: World = { closed: false, db, service, search, memories, conversation, second, requests, sessions, bodyByOperation,
      get searchCalls() { return searchCalls; }, get reads() { return reads; }, save,
      async index(operationId, requestId = `index-${Math.random().toString(36).slice(2)}`) { await search.index({ requestId, operationId }); },
      load(inputId, text, conversationId = conversation.conversationId) { activeConversation = conversationId; return service.load({ conversationId, inputId, text }); },
      withdraw(operationId, requestId = `withdraw-${Math.random().toString(36).slice(2)}`) { memories.withdrawLocal({ requestId, operationId }); },
      async close() { if (world.closed) return; world.closed = true; await service.close(); await search.close(); db.close(); } };
    worlds.push(world);
    return world;
  };
  t.after(async () => { for (const world of worlds) await world.close().catch(() => undefined); if (directory) await rm(directory, { recursive: true, force: true }); });
  const first = open();
  return { ...first, get searchCalls() { return first.searchCalls; }, get reads() { return first.reads; }, reopen: async () => open() };
}
const promptOf = (world: World, index: number): string => world.requests[index]!.prompt;
const operationMemoryIds = (result: Awaited<ReturnType<LocalReplyService['load']>>): string[] => result.operation.memorySources?.length ? [result.operation.operationId] : [];

test('single user: the same native Session is reused across three memory-grounded turns', async t => {
  const world = await fixture(t), fact = 'Synthetic single-user fact: the blue keycard lives in the top drawer.';
  const saved = world.save(world.conversation.conversationId, fact);
  await world.index(saved.operation.operationId);
  const first = await world.load('turn-1', 'Where is the blue keycard?');
  const second = await world.load('turn-2', 'Any reminder about the blue keycard?');
  const third = await world.load('turn-3', 'Thanks, one more time: blue keycard?');
  assert.equal(first.operation.status, 'loaded'); assert.equal(second.operation.status, 'loaded'); assert.equal(third.operation.status, 'loaded');
  const sessionIds = [first.load!.binding.sessionId, second.load!.binding.sessionId, third.load!.binding.sessionId];
  assert.equal(new Set(sessionIds).size, 1);
  assert.equal(world.requests.length, 3);
  for (const turn of [first, second, third]) {
    assert.equal(turn.operation.memorySources?.length, 1);
    assert.equal(turn.operation.memorySources![0]!.operationId, saved.operation.operationId);
  }
  for (const index of [0, 1, 2]) assert.ok(promptOf(world, index).includes(fact));
  assert.equal(world.searchCalls, 3);
  assert.deepEqual(operationMemoryIds(first), [first.operation.operationId]);
});

test('single user: a semantic recall hit is a controlled memory source, not model natural language', async t => {
  const world = await fixture(t), fact = 'Synthetic semantic fact: the red folder belongs in cabinet twelve.';
  const saved = world.save(world.conversation.conversationId, fact);
  await world.index(saved.operation.operationId);
  const recalled = await world.load('semantic-turn-1', 'Which cabinet has the red folder?');
  assert.equal(recalled.operation.memorySources?.length, 1);
  assert.ok(promptOf(world, 0).includes(fact));
  assert.equal(world.searchCalls, 1);
  // A native-history sentence that *sounds* like memory is not a memory source.
  const noMemoryWorld = await fixture(t);
  const plain = await noMemoryWorld.load('plain-turn-1', 'Which cabinet has the red folder?');
  assert.equal(plain.operation.memorySources?.length ?? 0, 0);
  assert.ok(!promptOf(noMemoryWorld, 0).includes(fact));
});

test('single user: an unindexed fact is an explicit missing index, never fake semantic recall', async t => {
  const world = await fixture(t), fact = 'Synthetic unindexed fact: the spare battery is in pouch six.';
  world.save(world.conversation.conversationId, fact);
  const before = await world.load('unindexed-turn-1', 'Where is the spare battery?');
  assert.equal(before.operation.memorySources?.length ?? 0, 0);
  assert.ok(!promptOf(world, 0).includes(fact));
  assert.equal(world.searchCalls, 1); // one index_required probe; zero embedding recall
  const saved = world.memories.list({ conversationId: world.conversation.conversationId })[0]!;
  await world.index(saved.operation.operationId);
  const after = await world.load('unindexed-turn-2', 'Where is the spare battery?');
  assert.equal(after.operation.memorySources?.length, 1);
  assert.ok(promptOf(world, 1).includes(fact));
});

test('single user: memory and index survive a service restart and are recalled without re-saving', async t => {
  const world = await fixture(t), fact = 'Synthetic restart fact: the spare passport is in the safe pocket.';
  const saved = world.save(world.conversation.conversationId, fact);
  await world.index(saved.operation.operationId);
  const first = await world.load('restart-turn-1', 'Where is the passport?');
  assert.ok(promptOf(world, 0).includes(fact));
  await world.close();
  const reopened = await world.reopen();
  const second = await reopened.load('restart-turn-2', 'Remind me where the passport is.');
  assert.equal(second.operation.status, 'loaded');
  assert.equal(second.operation.memorySources?.length, 1);
  assert.equal(second.operation.memorySources![0]!.operationId, saved.operation.operationId);
  assert.ok(promptOf(reopened, 0).includes(fact));
  assert.ok(!first.load!.binding || second.load!.binding.businessId === first.load!.binding.businessId);
});

test('single user: a withdrawn fact is refused by the controlled read path even if a model could claim it', async t => {
  const world = await fixture(t), fact = 'Synthetic withdrawn fact: the old gate code was 4411.';
  const saved = world.save(world.conversation.conversationId, fact);
  await world.index(saved.operation.operationId);
  await world.load('withdraw-turn-1', 'What was the old gate code?');
  assert.ok(promptOf(world, 0).includes(fact));
  world.withdraw(saved.operation.operationId);
  const after = await world.load('withdraw-turn-2', 'What was the old gate code again?');
  assert.equal(after.operation.memorySources?.length ?? 0, 0);
  assert.ok(!promptOf(world, 1).includes(fact));
  assert.throws(() => world.memories.readLocal({ operationId: saved.operation.operationId }), (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && String(error.code) === 'MEMORY_READ_FORBIDDEN'));
});

test('single user: another conversation cannot read the first conversation memory selection', async t => {
  const world = await fixture(t), fact = 'Synthetic audience fact: the office plant needs water on Friday.';
  const saved = world.save(world.conversation.conversationId, fact);
  await world.index(saved.operation.operationId);
  const other = await world.load('other-turn-1', 'When does the plant need water?', world.second.conversationId);
  assert.equal(other.operation.memorySources?.length ?? 0, 0);
  assert.ok(!promptOf(world, 0).includes(fact));
  const own = await world.load('own-turn-1', 'When does the plant need water?');
  assert.equal(own.operation.memorySources?.length, 1);
  assert.ok(promptOf(world, 1).includes(fact));
});

test('single user: a self-observed semantic index cannot supply a withdrawn body read', async t => {
  const world = await fixture(t), fact = 'Synthetic consistency fact: the archive key is under the mat.';
  const saved = world.save(world.conversation.conversationId, fact);
  await world.index(saved.operation.operationId);
  const source = world.memories.captureForView({ conversationId: world.conversation.conversationId, operationIds: [saved.operation.operationId] }).sources[0]!;
  world.withdraw(saved.operation.operationId);
  await assert.rejects(world.search.read(source), (error: unknown) => /stale read|No currently readable verified local memory reference/i.test(String(error)));
  const after = await world.load('consistency-turn-1', 'Where is the archive key?');
  assert.equal(after.operation.memorySources?.length ?? 0, 0);
  assert.ok(!promptOf(world, 0).includes(fact));
});
