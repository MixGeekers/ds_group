/**
 * Preparation: node --import tsx scripts/phase3f-memory-semantic-smoke.ts --plan
 * Explicit execution only after the coordinating agent's approval:
 * node --import tsx scripts/phase3f-memory-semantic-smoke.ts --execute-approved
 * No live DSH API, current runtime DB, generation model, external service, retry,
 * global configuration, or artifact publication. Each execution owns a NEW root.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { CONVERSATION_BACKGROUND_HANDLER } from '../src/adapters/control-store/conversation-domain.js';
import type { LocalMemoryEntry, PreparedLocalMemory } from '../src/adapters/control-store/memory-domain.js';
import type { CommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import type { TaskDetail } from '../src/adapters/control-store/task-domain.js';
import { ManagedHarrier } from '../src/adapters/embedding/managed.js';
import { HARRIER_RUNTIME_FINGERPRINT } from '../src/adapters/embedding/runtime-manifest.js';
import { PrivateStdioMcpClient, type PrivateMcpRequest } from '../src/adapters/mcp/index.js';
import { ManagedOmbreBackend, type ManagedOmbreConfigV2 } from '../src/adapters/ombre/managed.js';
import type { MemoryOperationObservation } from '../src/adapters/ombre/controlled.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { memoryBodyDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { OMBRE_HARRIER_PROFILE_ID, OMBRE_HARRIER_PROFILE_FINGERPRINT } from '../src/contracts/semantic-memory.js';
import { LocalMemorySearchService, type LocalMemorySearchResult, type LocalMemoryIndexResult } from '../src/control/local-memory-search.js';
import { createLocalReadView } from '../src/views/local.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpusFile = join(packageRoot, 'scripts/phase3f-memory-semantic-corpus.json');
interface Corpus {
  schemaVersion: 1;
  documents: { id: string; conversation: 'primary' | 'foreign'; body: string }[];
  oracles: { id: string; text: string; expectedDocumentId: string }[];
  filterQuery: string; withdrawQuery: string; withdrawDocumentId: string;
  passCriteria: { recallAt3Minimum: number };
}
const corpusBytes = await readFile(corpusFile), corpus = JSON.parse(corpusBytes.toString('utf8')) as Corpus;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
assert.equal(corpus.schemaVersion, 1);
assert.equal(corpus.documents.length, 10); assert.equal(corpus.oracles.length, 8);
assert.equal(new Set(corpus.documents.map(doc => doc.id)).size, 10);
assert.equal(corpus.documents.filter(doc => doc.conversation === 'primary').length, 8);
assert.ok(corpus.oracles.every(query => corpus.documents.some(doc => doc.id === query.expectedDocumentId && doc.conversation === 'primary')));
const paths = Object.freeze({
  // Existing user-evaluated paths confirmed by the managed-launcher reviewer;
  // same pinned artifacts as embedding-smoke.ts, not a new download or guess.
  serverBinary: '/Users/caja/Documents/DFY/embed-eval/tools/llama.cpp/build/bin/llama-server',
  modelArtifact: '/Users/caja/Documents/DFY/embed-eval/models/harrier-0.6b-q8_0.gguf',
  python: join(packageRoot, '.local/ombre/.venv/bin/python'),
  upstream: join(packageRoot, '.local/ombre/upstream/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935'),
});
const plan = Object.freeze({
  schemaVersion: 1, mode: 'isolated-real-local-embedding', corpusSha256: sha(corpusBytes),
  ordinaryMemories: 10, primaryMemories: 8, foreignMemories: 2, placeholderTasksNeverDispatched: 2,
  maxIndexEmbeddingCalls: 20, maxQueryEmbeddingCalls: 10, maxTotalEmbeddingCalls: 30,
  indexAttempts: 10, duplicateIndexRequestChecks: 1, oracleQueries: 8, filterQueries: 1, withdrawalQueries: 1,
  emptyPoolChecks: 1, unindexedPoolChecks: 1, exactNativeReadViews: 8,
  generationModelRequests: 0, nativeSessionRequests: 0, automaticRetries: 0, timeoutSeconds: 240,
  profileId: OMBRE_HARRIER_PROFILE_ID, profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
  runtimeFingerprint: HARRIER_RUNTIME_FINGERPRINT,
  passCriteria: { recallAt3Minimum: corpus.passCriteria.recallAt3Minimum, noCrossConversationCandidates: true,
    emptyAndUnindexedEmbeddingCalls: 0, duplicateIndexRedispatches: 0, exactNativeProofs: 10,
    withdrawnCandidateAbsent: true, withdrawalPreservesNativeFile: true, readOnlyCommitSeqUnchanged: true,
    controlContainsNoCorpusBodiesOrQueryText: true, ownedProcessesExitConfirmed: true },
  limitations: ['Small frozen synthetic oracle, not the DFY benchmark or a production quality claim.',
    'Embedding counts come from validated service receipts; they are not account-wide transport telemetry.',
    'Local withdrawal removes eligibility; native Markdown is retained, not physically erased.',
    'ReadViews prove authorized exact source loading, not model understanding or reply generation.'],
});
if (process.argv.length !== 3 || !['--plan', '--execute-approved'].includes(process.argv[2]!)) throw new Error('Use --plan or the explicitly authorized --execute-approved mode');
if (process.argv[2] === '--plan') { console.log(JSON.stringify({ status: 'prepared-not-executed', plan, paths }, null, 2)); }
else await run();

async function fileHash(file: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected symbolic source/data entry');
    if (entry.isDirectory()) { if (entry.name !== '__pycache__') files.push(...await filesUnder(join(root, entry.name))); }
    else if (entry.isFile()) files.push(join(root, entry.name));
  }
  return files.sort();
}
async function freezeHashes() {
  const names = ['package.json', 'package-lock.json', 'scripts/phase3f-memory-semantic-smoke.ts', 'scripts/phase3f-memory-semantic-corpus.json'];
  for (const root of ['src', 'dist', 'service/ombre']) {
    for (const file of await filesUnder(join(packageRoot, root))) {
      if (/\.(?:ts|js|json|py|txt)$/u.test(file) || file.endsWith('/LICENSE')) names.push(relative(packageRoot, file));
    }
  }
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, await fileHash(join(packageRoot, name))])));
}
function observation(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };
  if (value.structuredContent && typeof value.structuredContent === 'object') return value.structuredContent;
  try { return JSON.parse(value.content?.[0]?.text ?? '{}') as Record<string, unknown>; } catch { return {}; }
}
function safeError(error: unknown) { return { name: error instanceof Error ? error.name : 'UnknownError',
  code: error && typeof error === 'object' && 'code' in error ? String(error.code).slice(0, 100) : 'ASSERTION_OR_RUNTIME_FAILURE' }; }

async function run() {
  const base = join(packageRoot, '.local/phase3f-semantic-smoke'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'run-')), artifactFile = join(directory, 'result.json');
  const filename = join(directory, 'control.sqlite'), vault = join(directory, 'ordinary-vault');
  const binding = { backendId: 'ombre-local', deploymentId: `smoke-semantic-${randomUUID()}`, scope: 'local-owner' as const };
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Explicit smoke interruption'));
  const timer = setTimeout(() => controller.abort(new Error('Isolated smoke deadline exceeded')), plan.timeoutSeconds * 1000);
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let stage = 'prepare', store: ControlStore | undefined, backend: ManagedOmbreBackend | undefined, search: LocalMemorySearchService | undefined;
  let client: PrivateStdioMcpClient | undefined, child: ChildProcess | undefined, providerExit: { code: number | null; signal: string | null } | undefined;
  let pythonPid: number | null = null, indexCalls = 0, queryCalls = 0;
  const dispatchCounts = { create: 0, index: 0, search: 0 };
  const rpc: { name: string; state?: unknown; embeddingCalls?: unknown; usageComplete?: unknown; at: string }[] = [];
  const evidence: Record<string, any> = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), plan,
    evidenceLevel: 'pending-current-isolated-run', directory: relative(packageRoot, directory), binding,
    environment: { node: process.version, platform: process.platform, arch: process.arch, implementation: 'TS source imported via tsx; build hashes independently recorded' }, steps: [], cleanup: null };
  const checkpoint = async () => { evidence.stage = stage; evidence.accounting = { indexEmbeddingCalls: indexCalls, queryEmbeddingCalls: queryCalls,
    totalKnownEmbeddingCalls: indexCalls + queryCalls, complete: evidence.status === 'passed', dispatchCounts,
    unknownOnFailureNotZero: evidence.status !== 'passed', basis: 'Unique successful index receipts plus each search response; repeated status/duplicate receipts not counted again' };
    await writeFile(artifactFile, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); };
  try {
    evidence.freeze = await freezeHashes(); await checkpoint();
    controller.signal.throwIfAborted();
    store = await ControlStore.open({ filename, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [CONVERSATION_BACKGROUND_HANDLER],
      runtimeIdentity: { hostEpoch: `smoke-host-${randomUUID()}`, installationGeneration: `smoke-install-${randomUUID()}` },
      memoryBackend: { backendId: binding.backendId, deploymentId: binding.deploymentId } });
    const config: ManagedOmbreConfigV2 = { schemaVersion: 2, ...binding, python: paths.python, upstream: paths.upstream, root: vault,
      embedding: { mode: 'managed-harrier', profileId: OMBRE_HARRIER_PROFILE_ID, serverBinary: paths.serverBinary, modelArtifact: paths.modelArtifact } };
    backend = new ManagedOmbreBackend(config, {
      harrierFactory: config => new ManagedHarrier(config, { spawn: (command, args, options) => {
        assert.equal(child, undefined, 'Only one owned provider spawn is permitted');
        child = spawn(command, [...args], options);
        child.once('close', (code, signal) => { providerExit = { code, signal }; }); return child;
      } }),
      transportFactory: options => {
        assert.equal(client, undefined, 'Only one owned MCP service spawn is permitted');
        client = new PrivateStdioMcpClient(options); const actual = client;
        return { connect: opts => actual.connect(opts), listTools: () => actual.listTools(), status: () => actual.status(), close: () => actual.close(),
          callTool: async (request: PrivateMcpRequest, opts) => {
            controller.signal.throwIfAborted();
            if (request.name === 'shiyu_memory_create') assert.ok(++dispatchCounts.create <= 10, 'Create cap exceeded');
            if (request.name === 'shiyu_memory_index_ensure') assert.ok(++dispatchCounts.index <= 10, 'Index cap exceeded');
            if (request.name === 'shiyu_memory_search_candidates') assert.ok(++dispatchCounts.search <= 11, 'Query dispatch cap exceeded');
            assert.ok(['shiyu_memory_create', 'shiyu_memory_get', 'shiyu_memory_operation_status', 'shiyu_memory_backend_status',
              'shiyu_memory_index_ensure', 'shiyu_memory_index_status', 'shiyu_memory_search_candidates'].includes(request.name));
            const raw = await actual.callTool(request, opts), observed = observation(raw);
            rpc.push({ name: request.name, state: observed.state, embeddingCalls: observed.embeddingCalls, usageComplete: observed.usageComplete, at: new Date().toISOString() });
            return raw;
          } };
      },
    });
    stage = 'open-real-owned-dependencies'; await backend.open({ signal: controller.signal, timeoutMs: 60000 });
    pythonPid = client!.status().pid; evidence.initialBackend = backend.status();
    assert.equal(backend.status().storageReady, true); assert.equal(backend.status().semanticReady, false);
    assert.equal(backend.status().semantic?.recordedIndexedCount, 0);
    search = new LocalMemorySearchService({ store, backend: backend.adapter, assertRuntimeAllowed() { controller.signal.throwIfAborted(); }, timeoutMs: 30000 });
    const conversations: Record<string, string> = {};
    for (const name of ['primary', 'foreign']) {
      const { task } = await store.request('task.createLocal', { requestId: `smoke-task-${name}`, title: `隔离语义验收 ${name}`, content: '仅建立合成对话关联，不派发任务。' });
      const value = await store.request('conversation.ensureLocalTask', { taskId: task.taskId, localConversationKey: `semantic-smoke-${name}` });
      conversations[name] = value.conversationId;
    }
    evidence.conversations = conversations;
    stage = 'empty-pool-zero-request';
    const rpcBeforeEmpty = rpc.length, empty = await search.search({ conversationId: conversations.primary!, text: corpus.oracles[0]!.text, signal: controller.signal });
    assert.deepEqual(empty.embeddingUsage, { calls: 0, complete: true }); assert.deepEqual(empty.operationIds, []); assert.equal(rpc.length, rpcBeforeEmpty);
    evidence.steps.push({ stage, passed: true, backendRpcDelta: 0, embeddingCalls: 0 }); await checkpoint();

    const entries = new Map<string, LocalMemoryEntry>(), nativeFiles = new Map<string, { relativePath: string; sha256: string; bytes: number }>();
    async function nativeFile(entry: LocalMemoryEntry) {
      assert.ok(entry.reference); const id = entry.reference.nativeId;
      const candidates = (await filesUnder(join(vault, 'buckets/dynamic'))).filter(file => file.endsWith(`${id}.md`));
      assert.equal(candidates.length, 1, 'Exact native file must be uniquely identifiable'); const file = candidates[0]!;
      const before = await lstat(file); assert.ok(before.isFile() && !before.isSymbolicLink());
      const digest = await fileHash(file), after = await lstat(file); assert.equal(before.size, after.size); assert.equal(before.mtimeMs, after.mtimeMs);
      assert.equal(`sha256:${digest}`, entry.reference.componentVersion);
      return { relativePath: relative(directory, file), sha256: digest, bytes: after.size };
    }
    stage = 'strict-ordinary-memory-create'; evidence.created = [];
    for (const doc of corpus.documents) {
      controller.signal.throwIfAborted(); const body = memoryBodyDigest(doc.body);
      const prepared: PreparedLocalMemory = await store.request('memory.prepareLocal', { requestId: `smoke-save-${doc.id}`, conversationId: conversations[doc.conversation]!, bodyDigest: body.bodyDigest, bytes: body.bodyBytes });
      assert.equal(prepared.duplicate, false); const operationId = prepared.operation.operationId;
      const claim = await store.request('memory.claim', { operationId }); assert.ok(claim);
      try {
        const admitted = await store.request('memory.assertDispatch', { operationId, claim: claim.claim });
        controller.signal.throwIfAborted();
        const created: MemoryOperationObservation = await backend.adapter.create(admitted.command, doc.body, { signal: controller.signal }); assert.equal(created.state, 'applied');
        const verified: { body: string; observation: MemoryBackendObservation } = await backend.adapter.verifyApplied(admitted.command, { signal: controller.signal });
        assert.equal(verified.body, doc.body); assert.equal(verified.observation.bodyDigest, body.bodyDigest);
        const applied: LocalMemoryEntry = await store.request('memory.recordVerifiedReceipt', { operationId, claim: claim.claim, observation: verified.observation, reconciliation: false });
        assert.equal(applied.operation.status, 'applied'); assert.equal(applied.reservation.state, 'settled'); assert.ok(applied.canPublish);
        assert.deepEqual(applied.reservation.observed, { tokens: 0, calls: 0, effects: 1 });
        entries.set(doc.id, applied); const file = await nativeFile(applied); nativeFiles.set(doc.id, file);
        evidence.created.push({ documentId: doc.id, conversation: doc.conversation, operationId, commandDigest: verified.observation.commandDigest,
          nativeId: verified.observation.nativeId, receiptId: verified.observation.receiptId, bodyDigest: body.bodyDigest, bodyBytes: body.bodyBytes,
          componentVersion: verified.observation.componentVersion, file, status: applied.operation.status, budget: applied.reservation.observed });
      } catch (error) {
        try { await store.request('memory.markUnknown', { operationId, claim: claim.claim, reasonCode: 'SMOKE_STOP_AFTER_UNCONFIRMED_CREATE' }); }
        catch { /* Preserve the original failure; never redispatch an uncertain create. */ }
        throw error;
      }
      await checkpoint();
    }
    stage = 'index-required-zero-embedding';
    const unindexed = await search.search({ conversationId: conversations.primary!, text: corpus.oracles[0]!.text, signal: controller.signal });
    assert.equal(unindexed.state, 'index_required'); assert.deepEqual(unindexed.embeddingUsage, { calls: 0, complete: true });
    assert.deepEqual(unindexed.coverage, { eligibleCount: 8, indexedCount: 0, missingCount: 8 });
    evidence.steps.push({ stage, passed: true, coverage: unindexed.coverage, embeddingCalls: 0 });
    stage = 'index-explicit-once'; evidence.indexing = [];
    for (const doc of corpus.documents) {
      const entry = entries.get(doc.id)!;
      const indexed: LocalMemoryIndexResult = await search.index({ requestId: `smoke-index-${doc.id}`, operationId: entry.operation.operationId, signal: controller.signal });
      assert.equal(indexed.duplicate, false); assert.equal(indexed.entry.effect.status, 'succeeded'); assert.equal(indexed.entry.reservation.state, 'settled');
      assert.equal(indexed.entry.embeddingUsage.complete, true); assert.notEqual(indexed.entry.embeddingUsage.calls, null);
      indexCalls += indexed.entry.embeddingUsage.calls!; assert.ok(indexCalls <= plan.maxIndexEmbeddingCalls);
      const proof = indexed.entry.observation?.receipt; assert.ok(proof); assert.equal(proof.bodyDigest, entry.command.bodyDigest); assert.equal(proof.nativeId, entry.reference!.nativeId);
      assert.equal(proof.content.dimensions, 1024); assert.equal(proof.meaning.state, 'absent');
      evidence.indexing.push({ documentId: doc.id, indexOperationId: indexed.entry.indexOperationId, effectStatus: indexed.entry.effect.status,
        embeddingUsage: indexed.entry.embeddingUsage, receipt: proof });
      if (doc.id === corpus.documents[0]!.id) {
        const before = dispatchCounts.index; const watermark: CommitWatermark = await store.request('control.watermark', {});
        const repeated: LocalMemoryIndexResult = await search.index({ requestId: `smoke-index-${doc.id}`, operationId: entry.operation.operationId, signal: controller.signal });
        assert.equal(repeated.duplicate, true); assert.equal(repeated.entry.indexOperationId, indexed.entry.indexOperationId); assert.equal(dispatchCounts.index, before);
        assert.deepEqual(await store.request('control.watermark', {}), watermark);
        evidence.steps.push({ stage: 'duplicate-index-no-redispatch', passed: true, backendIndexDispatchDelta: 0, commitSeqUnchanged: true, historicalUsageNotCountedTwice: true });
      }
      await checkpoint();
    }
    const state = await store.request('view.state', {}); assert.ok(state);
    await store.request('state.publishMemoryAvailability', { requestId: 'smoke-explicit-semantic-capability', expectedBaselineId: state.baselineId,
      expectedStateVersion: state.stateVersion, availability: { status: 'available', backendId: binding.backendId, deploymentId: binding.deploymentId,
        capabilities: ['exact_read', 'semantic_search'], profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT } });
    const primaryIds = new Set(corpus.documents.filter(doc => doc.conversation === 'primary').map(doc => entries.get(doc.id)!.operation.operationId));
    async function query(text: string): Promise<LocalMemorySearchResult> {
      const result = await search!.search({ conversationId: conversations.primary!, text, signal: controller.signal });
      assert.equal(result.state, 'ok'); assert.equal(result.embeddingUsage.complete, true); assert.notEqual(result.embeddingUsage.calls, null);
      queryCalls += result.embeddingUsage.calls!; assert.ok(queryCalls <= plan.maxQueryEmbeddingCalls);
      assert.ok(result.operationIds.every(id => primaryIds.has(id)), 'Cross-conversation candidate leaked'); return result;
    }
    stage = 'oracle-search-and-exact-readviews'; evidence.queries = [];
    const readOnlyBefore = await store.request('control.watermark', {});
    for (const oracle of corpus.oracles) {
      const result = await query(oracle.text), expected = entries.get(oracle.expectedDocumentId)!.operation.operationId;
      const rank = result.operationIds.indexOf(expected) + 1;
      const capture = await store.request('view.captureLocal', { conversationId: conversations.primary!, purpose: 'reply_context', memoryOperationIds: result.operationIds });
      for (const doc of corpus.documents) assert.ok(!JSON.stringify(capture).includes(doc.body), 'Capture contains native body');
      const local = createLocalReadView(capture, { validate: captureId => store!.request('view.validateCapture', { captureId, phase: 'ready' }),
        memoryRead: (source, signal) => search!.read(source, signal), memoryIndex: result.index });
      try {
        const view = await local.read(); await local.assertCurrent(view.viewId); assert.equal(view.freshness.status, 'current');
        const memories = view.data.filter(item => item.backendId === 'native-memory');
        assert.deepEqual(memories.map(item => item.recordId).sort(), [...result.operationIds].sort());
        const checked = memories.map(item => {
          const doc = corpus.documents.find(doc => entries.get(doc.id)!.operation.operationId === item.recordId)!;
          assert.equal(item.fields.text, doc.body); const body = memoryBodyDigest(String(item.fields.text));
          assert.equal(body.bodyDigest, entries.get(doc.id)!.command.bodyDigest);
          return { documentId: doc.id, operationId: item.recordId, bodyDigest: body.bodyDigest, bodyBytes: body.bodyBytes };
        });
        evidence.queries.push({ oracleId: oracle.id, queryDigest: sha(oracle.text), expectedDocumentId: oracle.expectedDocumentId,
          rank: rank || null, matches: result.matches, coverage: result.coverage, embeddingUsage: result.embeddingUsage,
          view: { viewId: view.viewId, stateVersion: view.stateVersion, memoryIndex: result.index, checked, expiresAt: view.expiresAt } });
      } finally { local.close(); }
    }
    stage = 'same-conversation-filter';
    const filtered = await query(corpus.filterQuery);
    assert.deepEqual(filtered.coverage, { eligibleCount: 8, indexedCount: 8, missingCount: 0 });
    evidence.steps.push({ stage, passed: true, queryDigest: sha(corpus.filterQuery), candidateIds: filtered.operationIds, coverage: filtered.coverage, embeddingUsage: filtered.embeddingUsage });
    await store.request('conversation.snapshotLocal', {}); await store.request('memory.list', {}); await store.request('view.state', {});
    const readOnlyAfter = await store.request('control.watermark', {}); assert.deepEqual(readOnlyAfter, readOnlyBefore);
    evidence.readOnly = { before: readOnlyBefore, after: readOnlyAfter, unchanged: true, includes: ['oracle search', 'same-conversation search', 'exact public status/get', 'ReadView capture/read/validation', 'conversation/memory/publication GET'] };
    const recalls = Object.fromEntries([1, 3, 5].map(k => [`recallAt${k}`, evidence.queries.filter((item: { rank: number | null }) => item.rank !== null && item.rank <= k).length / corpus.oracles.length]));
    evidence.quality = { queryCount: corpus.oracles.length, ...recalls, thresholdAt3: corpus.passCriteria.recallAt3Minimum };
    assert.ok(recalls.recallAt3! >= corpus.passCriteria.recallAt3Minimum, 'Frozen Recall@3 threshold not met');
    stage = 'withdraw-and-requery';
    const withdrawnEntry = entries.get(corpus.withdrawDocumentId)!, operationId = withdrawnEntry.operation.operationId;
    const withdrawn = await store.request('memory.withdrawLocal', { requestId: 'smoke-withdraw-one', operationId });
    assert.equal(withdrawn.source.consent.state, 'withdrawn'); assert.equal(withdrawn.operation.blocked, true);
    await assert.rejects(store.request('memory.readLocal', { operationId }));
    const afterWithdrawal = await query(corpus.withdrawQuery); assert.ok(!afterWithdrawal.operationIds.includes(operationId));
    assert.equal(afterWithdrawal.coverage.eligibleCount, 7);
    const nativeAfterWithdrawal = await nativeFile(withdrawnEntry); assert.deepEqual(nativeAfterWithdrawal, nativeFiles.get(corpus.withdrawDocumentId));
    evidence.withdrawal = { operationId, consent: withdrawn.source.consent.state, version: withdrawn.operation.version, blocked: withdrawn.operation.blocked,
      candidates: afterWithdrawal.operationIds, coverage: afterWithdrawal.coverage, embeddingUsage: afterWithdrawal.embeddingUsage,
      nativeFileUnchanged: true, nativeFile: nativeAfterWithdrawal, physicallyDeleted: false };
    evidence.finalBackend = backend.status(); evidence.tasks = [];
    for (const task of await store.request('task.list', {})) {
      const detail: TaskDetail = await store.request('task.get', { taskId: task.taskId });
      assert.equal(task.state, 'queued'); assert.equal(detail.execution?.state, 'pending');
      assert.equal(detail.execution?.sessionId, undefined); assert.deepEqual(detail.effects, []);
      evidence.tasks.push({ taskId: task.taskId, state: task.state, executionState: detail.execution?.state, sessionId: null, effects: 0 });
    }
    assert.equal(dispatchCounts.create, 10); assert.equal(dispatchCounts.index, 10); assert.equal(dispatchCounts.search, 11);
    assert.deepEqual(await freezeHashes(), evidence.freeze, 'Source or build changed during the validation window');
    evidence.status = 'passed'; evidence.evidenceLevel = 'current-run-isolated-real-local-embedding';
  } catch (error) {
    evidence.status = 'failed'; evidence.failure = { stage, ...safeError(error), automaticRetry: false,
      ...(error && typeof error === 'object' && 'embeddingUsage' in error ? { unaggregatedEmbeddingUsage: error.embeddingUsage } : {}),
      ...(error && typeof error === 'object' && 'indexOperationId' in error ? { unsettledIndexOperationId: error.indexOperationId } : {}) }; process.exitCode = 1;
    console.error(JSON.stringify({ stage, ...safeError(error) }));
  } finally {
    stage = 'close-owned-resources'; const errors: unknown[] = [];
    for (const close of [() => search?.close(), () => backend?.close(), () => store?.close()]) {
      try { await close(); } catch (error) { errors.push(safeError(error)); }
    }
    evidence.cleanup = { searchClosed: !!search && errors.length === 0, backendState: backend?.status().state ?? 'not-created',
      pythonPid, pythonTransportState: client?.status().state ?? 'not-created', providerPid: child?.pid ?? null, providerExit: providerExit ?? null,
      controlWorkerClosed: !!store && errors.length === 0, errors, persistentServiceInstalled: false };
    if (errors.length || (client && client.status().state !== 'closed') || (child && !providerExit)) { evidence.status = 'failed'; process.exitCode = 1; }
    try {
      if (store) {
        const db = new DatabaseSync(filename, { readOnly: true });
        try {
          db.exec('PRAGMA query_only=ON'); const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
          let rows = 0, bytes = 0;
          for (const table of tables) {
            assert.match(String(table.name), /^[A-Za-z_][A-Za-z0-9_]*$/u);
            const values = db.prepare(`SELECT * FROM "${table.name}"`).all(), serialized = JSON.stringify(values); rows += values.length; bytes += Buffer.byteLength(serialized);
            assert.ok(bytes <= 16 * 1024 * 1024, 'Control audit unexpectedly large');
            for (const text of [...corpus.documents.map(doc => doc.body), ...corpus.oracles.map(query => query.text), corpus.filterQuery, corpus.withdrawQuery]) {
              assert.ok(!serialized.includes(text), 'Corpus body or query leaked into control ledger');
            }
          }
          evidence.controlBodyAudit = { readOnly: true, tables: tables.length, rows, serializedBytes: bytes, corpusBodiesFound: 0, queryTextsFound: 0 };
        } finally { db.close(); }
      }
    } catch (error) { evidence.status = 'failed'; evidence.controlBodyAudit = { ...safeError(error), failed: true }; process.exitCode = 1; }
    evidence.rpc = rpc; evidence.finishedAt = new Date().toISOString();
    clearTimeout(timer); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await checkpoint();
    console.log(JSON.stringify({ status: evidence.status, artifact: relative(packageRoot, artifactFile), accounting: evidence.accounting, cleanup: evidence.cleanup }));
  }
}
