/** Explicitly isolated cross-language coverage. Uses installed pinned Python/Ombre,
 * the existing Python HTTP vector fixture, and no model, DSH DB, or real vault. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HARRIER_PROFILE } from '../src/adapters/embedding/index.js';
import { PrivateStdioMcpClient } from '../src/adapters/mcp/index.js';
import { ManagedOmbreBackend, type ManagedOmbreConfigV2, type ManagedOmbreHarrier } from '../src/adapters/ombre/managed.js';
import { memoryBodyDigest, type MemoryCreateCommand } from '../src/contracts/memory.js';
import { OMBRE_HARRIER_PROFILE_ID, OMBRE_HARRIER_PROFILE_FINGERPRINT, type MemoryIndexCommand, type MemorySearchRequest } from '../src/contracts/semantic-memory.js';

const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = join(product, '.local/ombre/.venv/bin/python');
const upstream = join(product, '.local/ombre/upstream/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935');
const tests = join(product, 'service/ombre/tests');
const temporaryRoot = join(product, '.local/semantic-stdio-tests');
const body = 'Synthetic v2 protocol memory: cobalt notebook on shelf seven.';
const expectedTools = ['shiyu_memory_backend_status', 'shiyu_memory_create', 'shiyu_memory_get', 'shiyu_memory_index_ensure',
  'shiyu_memory_index_status', 'shiyu_memory_operation_status', 'shiyu_memory_search_candidates'];
type FixtureStats = { calls: number; documentCalls: number; queryCalls: number; authorizationMatches: boolean; pathsMatch: boolean };

// Reuse the exact existing Python vector endpoint. This wrapper only reports
// counters over stdin/stdout; it does not implement an embedding protocol.
const fixtureProgram = `import json,sys
sys.path.insert(0,sys.argv[1])
from test_harrier_profile import Fixture,HARRIER_PROFILE
fixture=Fixture()
try:
 print(json.dumps({"endpoint":fixture.endpoint}),flush=True)
 for line in sys.stdin:
  if line.strip()!="stats": raise RuntimeError("unsupported fixture command")
  calls=fixture.calls
  queries=sum(call["body"]["input"][0].startswith(HARRIER_PROFILE["query_prefix"]) for call in calls)
  print(json.dumps({"calls":len(calls),"documentCalls":len(calls)-queries,"queryCalls":queries,
   "authorizationMatches":all(call["authorization"]=="Bearer synthetic-key" for call in calls),
   "pathsMatch":all(call["path"]=="/v1/embeddings" for call in calls)}),flush=True)
finally:
 fixture.close()
`;
async function bounded<T>(work: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Synthetic fixture deadline exceeded')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
class PythonVectorFixture implements ManagedOmbreHarrier {
  private state: ReturnType<ManagedOmbreHarrier['status']>['state'] = 'idle';
  private child?: ChildProcessWithoutNullStreams;
  private lines?: AsyncIterator<string>;
  private exited?: Promise<void>;
  private hasExited = false;
  private closing?: Promise<void>;
  pid?: number; stderrBytes = 0;
  constructor(private readonly directory: string) {}
  status(): ReturnType<ManagedOmbreHarrier['status']> { return { state: this.state, verified: this.state === 'ready', profileId: HARRIER_PROFILE.id,
    runtimeFingerprint: '0'.repeat(64), childGeneration: this.child ? 1 : 0, readinessProbe: this.state === 'ready' ? 'passed' : 'not-run', embeddingVerified: false }; }
  private async read(): Promise<Record<string, unknown>> {
    const result = await bounded(this.lines!.next());
    assert.equal(result.done, false, 'Vector fixture exited without a counter response');
    return JSON.parse(result.value!) as Record<string, unknown>;
  }
  async open(options: Parameters<ManagedOmbreHarrier['open']>[0] = {}) {
    assert.equal(this.state, 'idle'); options.signal?.throwIfAborted(); this.state = 'opening';
    const keyFile = join(this.directory, 'fixture.key'); await writeFile(keyFile, 'synthetic-key\n', { mode: 0o600 });
    const child = this.child = spawn('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE=1', python, '-I', '-B', '-u', '-c', fixtureProgram, tests],
      { cwd: product, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pid = child.pid;
    this.exited = new Promise<void>(resolve => { child.once('error', () => { this.state = 'failed'; }); child.once('close', () => { this.hasExited = true; resolve(); }); });
    child.stderr.on('data', (chunk: Buffer) => { this.stderrBytes += chunk.length; });
    this.lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const ready = await this.read(); options.signal?.throwIfAborted();
    assert.equal(typeof ready.endpoint, 'string'); this.state = 'ready';
    return { endpoint: ready.endpoint as string, keyFile };
  }
  async stats(): Promise<FixtureStats> { assert.equal(this.state, 'ready'); this.child!.stdin.write('stats\n'); return await this.read() as unknown as FixtureStats; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'closing';
    return this.closing = (async () => {
      if (this.child && this.exited && !this.hasExited) {
        this.child.stdin.end(); await Promise.race([this.exited, delay(3000, undefined, { ref: false })]);
        if (!this.hasExited) { this.child.kill('SIGTERM'); await Promise.race([this.exited, delay(1000, undefined, { ref: false })]); }
        if (!this.hasExited) { this.child.kill('SIGKILL'); await bounded(this.exited); }
      }
      assert.ok(!this.child || this.hasExited, 'Owned vector fixture exit unconfirmed'); this.state = 'closed';
    })();
  }
}

test('real private SDK and Python v2 agree on seven tools, isolated indexing, receipts and authorized candidates without a model', { timeout: 30000 }, async t => {
  try { await access(python); await access(join(upstream, 'src/embedding_engine.py')); }
  catch { t.skip('Pinned local Python/Ombre dependency is absent; this test never installs it'); return; }
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'case-'));
  const modelArtifact = join(directory, 'fixture-artifact'); await writeFile(modelArtifact, 'synthetic; no model weights');
  const config: ManagedOmbreConfigV2 = { schemaVersion: 2, backendId: 'stdio-v2-fixture', deploymentId: 'stdio-v2-isolated-deployment', scope: 'local-owner',
    python, upstream, root: join(directory, 'vault'), embedding: { mode: 'managed-harrier', profileId: OMBRE_HARRIER_PROFILE_ID, serverBinary: process.execPath, modelArtifact } };
  const provider = new PythonVectorFixture(directory); let client: PrivateStdioMcpClient | undefined;
  const calls: string[] = [];
  const managed = new ManagedOmbreBackend(config, { harrierFactory: () => provider, transportFactory: options => {
    const transport = client = new PrivateStdioMcpClient(options);
    return { connect: options => transport.connect(options), status: () => transport.status(), listTools: () => transport.listTools(), close: () => transport.close(),
      callTool: (request, options) => { calls.push(request.name); return transport.callTool(request, options); } };
  } });
  t.after(async () => { try { await managed.close(); } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); } });
  await managed.open({ timeoutMs: 20000 });
  const servicePid = client!.status().pid; assert.ok(servicePid); assert.ok(provider.pid);
  assert.deepEqual(client!.listTools().map(tool => tool.name).sort(), expectedTools);
  assert.equal(managed.status().storageReady, true); assert.equal(managed.status().semantic!.state, 'unverified');
  const before = await managed.adapter.backendStatus();
  assert.equal(before.profileFingerprint, OMBRE_HARRIER_PROFILE_FINGERPRINT); assert.equal(before.indexWatermark, 0);
  assert.equal((await provider.stats()).calls, 0);
  const command: MemoryCreateCommand = { schemaVersion: 1, kind: 'create', operationId: 'stdio-memory-one', backendId: config.backendId, scope: config.scope,
    targetRef: 'stdio-target', ...memoryBodyDigest(body), sourceRefs: [{ sourceId: 'stdio-source', revision: 1 }] };
  const saved = await managed.adapter.create(command, body); assert.equal(saved.state, 'applied'); assert.ok(saved.receipt); assert.ok(saved.nativeId);
  assert.equal(saved.receipt.indexState, 'unknown'); assert.equal((await provider.stats()).calls, 0, 'v2 body creation must not dispatch embedding');
  const ref = { memoryOperationId: command.operationId, bodyReceiptId: saved.receipt.receiptId, nativeId: saved.nativeId,
    componentVersion: saved.receipt.componentVersion, bodyDigest: command.bodyDigest };
  const query: MemorySearchRequest = { scope: config.scope, query: 'synthetic shelf question', limit: 1, eligibleRefs: [ref],
    profileFingerprint: before.profileFingerprint, expectedIndexBaselineId: before.indexBaselineId, expectedIndexWatermark: 0, deadlineAtMs: Date.now() + 20000 };
  const missing = await managed.adapter.searchCandidates(query);
  assert.equal(missing.state, 'index_required'); assert.deepEqual(missing.matches, []); assert.equal(missing.embeddingCalls, 0); assert.equal((await provider.stats()).calls, 0);
  const indexCommand: MemoryIndexCommand = { schemaVersion: 1, kind: 'ensure-index', indexOperationId: 'stdio-index-one', backendId: config.backendId,
    deploymentId: config.deploymentId, scope: config.scope, ...ref, profileFingerprint: before.profileFingerprint, indexBaselineId: before.indexBaselineId,
    expectedIndexWatermark: 0, deadlineAtMs: Date.now() + 20000, maxEmbeddingCalls: 2 };
  const indexed = await managed.adapter.ensureIndex(indexCommand); assert.equal(indexed.state, 'applied'); assert.ok(indexed.receipt);
  assert.equal(indexed.embeddingCalls, 1); assert.equal(indexed.receipt.meaning.state, 'absent');
  assert.deepEqual((await managed.adapter.indexStatus(indexCommand)).receipt, indexed.receipt);
  const afterIndex = await provider.stats(); assert.equal(afterIndex.calls, 1); assert.equal(afterIndex.documentCalls, 1); assert.equal(afterIndex.queryCalls, 0);
  const duplicate = await managed.adapter.ensureIndex(indexCommand); assert.deepEqual(duplicate.receipt, indexed.receipt);
  assert.equal((await provider.stats()).calls, 1, 'Duplicate index intent must not replay embedding');
  const readback = await managed.adapter.verifyApplied(command); assert.equal(readback.body, body);
  assert.equal(readback.observation.componentVersion, saved.receipt.componentVersion); assert.equal(managed.status().semantic!.embeddingVerified, false);
  query.expectedIndexWatermark = indexed.receipt.indexWatermark;
  const empty = await managed.adapter.searchCandidates({ ...query, eligibleRefs: [] });
  assert.deepEqual(empty.matches, []); assert.equal(empty.embeddingCalls, 0); assert.equal((await provider.stats()).calls, 1);
  const found = await managed.adapter.searchCandidates(query);
  assert.equal(found.state, 'ok'); assert.equal(found.embeddingCalls, 1); assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0]!.nativeId, saved.nativeId); assert.equal(found.matches[0]!.score, 0); assert.ok(!JSON.stringify(found).includes(body));
  assert.equal(managed.status().semantic!.embeddingVerified, true);
  const cached = await managed.adapter.searchCandidates(query); assert.equal(cached.embeddingCalls, 0); assert.deepEqual(cached.matches, found.matches);
  const finalCounters = await provider.stats(); assert.deepEqual(finalCounters, { calls: 2, documentCalls: 1, queryCalls: 1, authorizationMatches: true, pathsMatch: true });
  const finalStatus = await managed.adapter.backendStatus(); assert.equal(finalStatus.indexWatermark, 1); assert.equal(finalStatus.recordedIndexedCount, 1);
  await managed.close();
  assert.throws(() => process.kill(servicePid!, 0), { code: 'ESRCH' }); assert.throws(() => process.kill(provider.pid!, 0), { code: 'ESRCH' });
  assert.equal(managed.status().state, 'closed'); assert.equal(provider.status().state, 'closed');
  t.diagnostic(JSON.stringify({ evidence: 'real-private-sdk-python-v2-with-existing-http-vector-fixture', tools: expectedTools.length,
    bodyCreates: calls.filter(name => name === 'shiyu_memory_create').length, indexDispatches: calls.filter(name => name === 'shiyu_memory_index_ensure').length,
    httpFixture: finalCounters, realModelLoads: 0, dshTouched: false, bothOwnedChildrenExited: true, vault: 'temporary-and-removed' }));
});
