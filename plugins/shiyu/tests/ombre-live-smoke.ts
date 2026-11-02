/** Explicit only: node --import tsx tests/ombre-live-smoke.ts. See service/ombre/LIVE_VALIDATION.md. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { ManagedOmbreBackend, loadManagedOmbreConfig, type ManagedOmbreConfig, type ManagedOmbreTransport } from '../src/adapters/ombre/managed.js';
import { PrivateStdioMcpClient } from '../src/adapters/mcp/index.js';
import { LocalMemoryService } from '../src/control/local-memory.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BODY = 'Synthetic Shiyu ordinary memory: the cobalt notebook stays on shelf seven. Marker SHIYU_3E_ORDINARY_61F0A7.';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const configBase = {
  schemaVersion: 1 as const, scope: 'local-owner' as const, embedding: 'disabled' as const,
  python: join(packageRoot, '.local/ombre/.venv/bin/python'),
  upstream: join(packageRoot, '.local/ombre/upstream/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935'),
};
const sourceFiles = [
  'tests/ombre-live-smoke.ts', 'service/ombre/LIVE_VALIDATION.md', 'service/ombre/service.py', 'service/ombre/controlled_store.py', 'service/ombre/protocol.py', 'service/ombre/SOURCE.json',
  'src/adapters/ombre/managed.ts', 'src/adapters/ombre/controlled.ts', 'src/adapters/mcp/index.ts', 'src/control/local-memory.ts',
  'src/adapters/control-store/index.ts', 'src/adapters/control-store/worker.ts', 'src/adapters/control-store/protocol.ts', 'src/adapters/control-store/memory-domain.ts',
  'src/adapters/control-store/authority.ts', 'src/adapters/control-store/conversation-domain.ts', 'src/adapters/control-store/task-domain.ts', 'src/adapters/control-store/transaction.ts',
  'src/adapters/control-store/commit-watermark.ts', 'src/control/memory/index.ts', 'src/control/memory/contracts.ts', 'src/control/effects/index.ts',
  'src/control/policy/mandates.ts', 'src/contracts/memory.ts',
];
async function fingerprints() { return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(join(packageRoot, file)))]))); }
async function exists(file: string) { try { await access(file); return true; } catch { return false; } }
async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Smoke evidence tree must not contain symlinks');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path)); else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
function processGone(pid: number | null) {
  if (!pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as { code?: string }).code === 'ESRCH'; }
}
async function bodyIsolation(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true }); const tables: { name: string; rows: number }[] = [];
  try {
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const row of names) {
      const name = String(row.name); const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
      for (const value of rows) for (const field of Object.values(value)) {
        const bytes = typeof field === 'string' ? Buffer.from(field) : field instanceof Uint8Array ? Buffer.from(field) : Buffer.from(String(field));
        assert.ok(!bytes.includes(Buffer.from(BODY)), 'Synthetic body appeared in metadata database');
      }
      tables.push({ name, rows: rows.length });
    }
  } finally { db.close(); }
  const fileChecks: { suffix: string; bytes: number; sha256: string; bodyPresent: false }[] = [];
  for (const suffix of ['', '-wal', '-shm']) if (await exists(filename + suffix)) {
    const content = await readFile(filename + suffix); assert.ok(!content.includes(Buffer.from(BODY)), 'Synthetic body appeared in SQLite bytes');
    fileChecks.push({ suffix: suffix || 'main', bytes: content.byteLength, sha256: sha(content), bodyPresent: false });
  }
  return { tables, fileChecks, bodyPresent: false };
}

await access(configBase.python); await access(configBase.upstream); // Refuse missing dependencies; never install them.
await mkdir(join(packageRoot, '.local'), { recursive: true });
const runRoot = await mkdtemp(join(packageRoot, '.local/phase3e-memory-'));
const controlFile = join(runRoot, 'control.sqlite'); const installationGeneration = `smoke-install-${randomUUID()}`;
const config: ManagedOmbreConfig = { ...configBase, backendId: `smoke-ombre-${randomUUID()}`, deploymentId: `smoke-deploy-${randomUUID()}`, root: join(runRoot, 'vault') };
await mkdir(join(runRoot, 'memory')); await writeFile(join(runRoot, 'memory/backend.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
const trace: Record<string, unknown>[] = [], processes: { phase: string; pid: number | null; closeObserved: boolean; state?: string }[] = [];
const startedAt = new Date().toISOString(), startedMs = Date.now();
const sourceBefore = await fingerprints();
const overall = new AbortController(); const deadline = setTimeout(() => overall.abort(new Error('Live smoke exceeded its 120 second bound')), 120000);
let phase = 'initial-open'; let store: ControlStore | undefined, managed: ManagedOmbreBackend | undefined, service: LocalMemoryService | undefined;
const report: Record<string, unknown> = { schemaVersion: 1, evidenceLevel: 'current-run-real-controlled-Ombre-MCP-ControlStore-local-memory-service', startedAt,
  runDirectory: `.local/${basename(runRoot)}`, plan: 'service/ombre/LIVE_VALIDATION.md', syntheticOnly: true, sourceSha256Before: sourceBefore,
  binding: { backendId: config.backendId, deploymentId: config.deploymentId, scope: config.scope, installationGeneration },
  node: process.version, platform: process.platform, embedding: 'disabled', semanticReady: false,
  limits: { managedStarts: 2, memoryCreateCalls: 1, perBusinessOperationMs: 30000, overallMs: 120000, automaticWriteRetries: 0 },
  body: { sha256: sha(BODY), bytes: Buffer.byteLength(BODY), provenance: 'fixed synthetic ordinary memory; no user/business body' },
};
async function openPhase(hostEpoch: string) {
  const loaded = await loadManagedOmbreConfig(runRoot); assert.ok(loaded); assert.equal(loaded.embedding, 'disabled');
  store = await ControlStore.open({ filename: controlFile, eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ['conversation.background'],
    runtimeIdentity: { installationGeneration, hostEpoch }, memoryBackend: { backendId: config.backendId, deploymentId: config.deploymentId } });
  assert.equal((await store.request('memory.status', {})).ready, true);
  managed = new ManagedOmbreBackend(loaded, { transportFactory(options): ManagedOmbreTransport {
    assert.equal(options.command, '/usr/bin/env'); assert.equal(options.args?.[0], '-i'); assert.equal(options.args?.at(-1), '--without-embedding');
    const client = new PrivateStdioMcpClient(options), record = { phase, pid: null as number | null, closeObserved: false, state: 'idle' };
    processes.push(record);
    return {
      async connect(callOptions) { await client.connect(callOptions); record.pid = client.status().pid; record.state = client.status().state; },
      listTools: () => client.listTools(), status: () => client.status(),
      async callTool(request, callOptions) {
        overall.signal.throwIfAborted();
        const entry: Record<string, unknown> = { phase, tool: request.name, at: new Date().toISOString() }; trace.push(entry);
        if (request.name === 'shiyu_memory_create') assert.ok(trace.filter(row => row.tool === 'shiyu_memory_create').length <= 1, 'Single-create smoke budget exhausted');
        const value = await client.callTool(request, callOptions);
        const block = value.content[0]; if (block?.type === 'text') {
          const parsed = JSON.parse(block.text); entry.state = parsed.state;
          if (parsed.receipt?.indexState) entry.indexState = parsed.receipt.indexState;
          if (parsed.receipt?.receiptId) entry.receiptId = parsed.receipt.receiptId;
        }
        return value;
      },
      async close() { await client.close(); record.state = client.status().state; record.closeObserved = processGone(record.pid); assert.ok(record.closeObserved, 'Owned child exit was not confirmed'); },
    };
  } });
  await managed.open({ signal: overall.signal, timeoutMs: 15000 }); assert.equal(managed.status().state, 'ready');
  service = new LocalMemoryService({ store, backend: managed.adapter, timeoutMs: 30000, assertRuntimeAllowed() {
    overall.signal.throwIfAborted(); if (managed!.status().state !== 'ready') throw new Error('Private backend is unavailable');
  } });
}
async function closePhase() {
  await service?.close(); service = undefined;
  await managed?.close(); managed = undefined;
  await store?.close(); store = undefined;
}
let failure: unknown;
try {
  await openPhase(`smoke-host-a-${randomUUID()}`);
  const task = (await store!.request('task.createLocal', { requestId: 'smoke-metadata-task', title: 'Synthetic memory context metadata', content: 'No worker dispatch is part of this smoke.' })).task;
  const conversation = await store!.request('conversation.ensureLocalTask', { taskId: task.taskId });
  report.task = { taskId: task.taskId, state: task.state, workerDispatched: false }; report.conversationId = conversation.conversationId;
  phase = 'save';
  const saved = await service!.remember({ requestId: 'smoke-save-one', conversationId: conversation.conversationId, text: BODY, signal: overall.signal });
  assert.equal(saved.duplicate, false); assert.equal(saved.entry.operation.status, 'applied'); assert.equal(saved.entry.operation.effectState, 'succeeded');
  assert.equal(saved.entry.reservation.state, 'settled'); assert.deepEqual(saved.entry.reservation.observed, { tokens: 0, calls: 0, effects: 1 }); assert.ok(saved.entry.reference);
  const operationId = saved.entry.operation.operationId, nativeId = saved.entry.reference.nativeId, receiptRef = saved.entry.operation.backendReceiptRef;
  report.saved = { operationId, nativeId, receiptRef, componentVersion: saved.entry.reference.componentVersion,
    status: saved.entry.operation.status, effectState: saved.entry.operation.effectState, reservation: { state: saved.entry.reservation.state, observed: saved.entry.reservation.observed },
    sourceRevision: saved.entry.source.revision, indexState: trace.find(row => row.tool === 'shiyu_memory_create')?.indexState };
  assert.equal((report.saved as { indexState: string }).indexState, 'disabled');
  phase = 'read'; const read = await service!.read({ operationId, signal: overall.signal }); assert.ok(read.body === BODY, 'Exact body read mismatch');
  const beforeDuplicate = await store!.request('control.watermark', {}), rpcBeforeDuplicate = trace.length;
  phase = 'duplicate'; const duplicate = await service!.remember({ requestId: 'smoke-save-one', conversationId: conversation.conversationId, text: BODY, signal: overall.signal });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.entry.operation.operationId, operationId); assert.equal(duplicate.entry.reference!.nativeId, nativeId);
  assert.equal(trace.length, rpcBeforeDuplicate); const afterDuplicate = await store!.request('control.watermark', {}); assert.deepEqual(afterDuplicate, beforeDuplicate);
  report.duplicate = { duplicate: true, sameOperationAndNativeId: true, rpcBefore: rpcBeforeDuplicate, rpcAfter: trace.length, commitSeqBefore: beforeDuplicate.commitSeq, commitSeqAfter: afterDuplicate.commitSeq, baselineId: beforeDuplicate.baselineId };
  const markdowns = (await filesUnder(join(config.root, 'buckets/dynamic'))).filter(file => file.endsWith('.md'));
  assert.equal(markdowns.length, 1); const nativeFile = markdowns[0]!, nativeBytes = await readFile(nativeFile), nativeText = nativeBytes.toString('utf8');
  assert.ok(nativeText.includes(BODY), 'Body absent from native Markdown'); assert.match(nativeText, /^type: dynamic\r?$/m); assert.match(nativeText, /^source_tool: shiyu_strict_create\r?$/m);
  assert.ok(!/^provenance:/m.test(nativeText), 'Ordinary memory unexpectedly has test provenance');
  const originalNativeSha = sha(nativeBytes);
  report.native = { count: 1, relativePath: relative(config.root, nativeFile), bytes: nativeBytes.byteLength, sha256: originalNativeSha, type: 'dynamic', sourceTool: 'shiyu_strict_create', testProvenance: false };
  phase = 'first-close'; await closePhase();
  report.firstControlIsolation = await bodyIsolation(controlFile);
  phase = 'reopen'; await openPhase(`smoke-host-b-${randomUUID()}`);
  const reloaded = await service!.read({ operationId, signal: overall.signal }); assert.ok(reloaded.body === BODY, 'Reopened body read mismatch');
  assert.equal(reloaded.entry.reference!.nativeId, nativeId); assert.equal(reloaded.entry.operation.backendReceiptRef, receiptRef);
  assert.equal(reloaded.entry.operation.status, 'applied'); assert.equal(trace.filter(row => row.tool === 'shiyu_memory_create').length, 1);
  report.reopen = { sameInstallationAndDeployment: true, changedHostEpoch: true, sameNativeIdAndReceipt: true, bodySha256: sha(reloaded.body), status: reloaded.entry.operation.status };
  phase = 'withdraw'; const callsBeforeWithdraw = trace.length;
  const withdrawn = await store!.request('memory.withdrawLocal', { requestId: 'smoke-withdraw-one', operationId });
  assert.equal(withdrawn.source.consent.state, 'withdrawn'); assert.equal(withdrawn.operation.blocked, true); assert.equal(withdrawn.reference, undefined); assert.equal(withdrawn.canPublish, false);
  assert.equal(withdrawn.reservation.observed.effects, 1);
  let deniedCode = '';
  try { await service!.read({ operationId, signal: overall.signal }); throw new Error('Withdrawn memory was readable'); }
  catch (error) { deniedCode = String((error as { code?: string }).code ?? ''); assert.equal(deniedCode, 'MEMORY_READ_FORBIDDEN'); }
  assert.equal(trace.length, callsBeforeWithdraw); assert.equal(sha(await readFile(nativeFile)), originalNativeSha);
  report.withdrawal = { consent: withdrawn.source.consent.state, sourceRevision: withdrawn.source.revision, blocked: withdrawn.operation.blocked,
    historicalStatus: withdrawn.operation.status, historicalEffectState: withdrawn.operation.effectState, effectsStillAccounted: withdrawn.reservation.observed.effects,
    readDeniedCode: deniedCode, backendCallsAdded: trace.length - callsBeforeWithdraw, nativeFileUnchanged: true, physicalPurge: false };
  phase = 'final-close'; await closePhase();
  report.finalControlIsolation = await bodyIsolation(controlFile);
  report.backendJournalIsolation = await bodyIsolation(join(config.root, '.shiyu/operations.sqlite3'));
  const journal = new DatabaseSync(join(config.root, '.shiyu/operations.sqlite3'), { readOnly: true });
  try { const row = journal.prepare('SELECT COUNT(*) AS n FROM operations').get()!; assert.equal(row.n, 1); report.backendJournalOperations = row.n; }
  finally { journal.close(); }
  const sourceAfter = await fingerprints(); assert.deepEqual(sourceAfter, sourceBefore, 'Validated implementation changed while live smoke was running');
  report.sourceSha256After = sourceAfter; report.result = 'passed';
} catch (error) {
  failure = error; report.result = 'failed'; report.failure = { phase, name: error instanceof Error ? error.name : 'UnknownError', code: String((error as { code?: string })?.code ?? 'UNCLASSIFIED') };
} finally {
  clearTimeout(deadline);
  try { await closePhase(); } catch (error) { report.cleanupFailure = { name: error instanceof Error ? error.name : 'UnknownError' }; failure ??= error; report.result = 'failed'; }
  report.finishedAt = new Date().toISOString(); report.durationMs = Date.now() - startedMs; report.processes = processes;
  report.mcp = { calls: trace.length, byTool: Object.fromEntries(['shiyu_memory_create', 'shiyu_memory_get', 'shiyu_memory_operation_status'].map(name => [name, trace.filter(row => row.tool === name).length])), trace };
  report.noModelOrEmbeddingEvidence = { agentOrSessionConstructed: false, nativeWorkerTaskDispatched: false, configuredEmbedding: 'disabled', launchFlag: '--without-embedding',
    observedReceiptIndexStates: [...new Set(trace.flatMap(row => typeof row.indexState === 'string' ? [row.indexState] : []))], observedScope: 'only this harness and its two owned controlled service children; not machine-wide traffic' };
  report.limitations = ['No DSH UI/Runtime activation was exercised.', 'Orderly close/reopen only; no crash or power-loss test.', 'Local consent withdrawal is not native physical deletion.', 'No embedding, semantic retrieval, or six-component inner publication was tested.'];
  await writeFile(join(runRoot, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const artifact = join(packageRoot, 'artifacts/phase3e-memory-validation.json');
  const previous = await exists(artifact) ? JSON.parse(await readFile(artifact, 'utf8')) : { schemaVersion: 1, attempts: [] };
  assert.ok(Array.isArray(previous.attempts), 'Existing artifact shape is unsupported; refusing to overwrite');
  previous.attempts.push(report); previous.latestResult = report.result;
  await writeFile(artifact, `${JSON.stringify(previous, null, 2)}\n`);
}
console.log(JSON.stringify({ result: report.result, runDirectory: report.runDirectory, durationMs: report.durationMs, calls: report.mcp, processes, artifact: 'artifacts/phase3e-memory-validation.json' }));
if (failure) process.exitCode = 1;
