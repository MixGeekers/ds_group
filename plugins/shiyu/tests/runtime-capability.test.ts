import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeService, type SessionDriver } from '../src/runtime.js';
import type { DshContext } from '../src/adapters/dsh/sessions.js';
import type { WorkerRunRequest, WorkerRunResult } from '../src/adapters/dsh/workers.js';
import { prepareSyntheticLocalNote } from './helpers/capability.js';

const CONTENT = 'Synthetic capability task, verified independently.';
class Worker {
  calls = 0; observations = 0; ready = true;
  beforeTool?: (request: WorkerRunRequest) => Promise<void>;
  async initialize() {}
  async close() {}
  async prepareLocalNote() {
    this.observations++;
    if (!this.ready) throw new Error('Synthetic missing native dependency');
    return prepareSyntheticLocalNote();
  }
  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    this.calls++;
    const binding = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope,
      sessionId: `shiyu-worker-synthetic-${request.assignmentId}` };
    const identity = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope,
      hostEpoch: request.permit.hostEpoch, installationGeneration: request.permit.installationGeneration,
      fencingToken: request.permit.fencingToken, leaseExpiresAt: request.permit.leaseExpiresAt };
    await request.onBound(binding);
    await this.beforeTool?.(request);
    request.signal?.throwIfAborted();
    await request.tools![0]!.execute({ content: CONTENT }, { ...binding, permit: identity, signal: request.signal!,
      assertPermit: async () => {
        const verdict = await request.permit.check({ ...identity, phase: 'tool', toolName: 'shiyu_worker_write_note' });
        if (!verdict.allowed) throw new Error('Synthetic worker permit refused');
      } });
    return { ...binding, candidate: { summary: 'Synthetic candidate only.', evidenceRequests: [`artifact:${request.taskId}`] },
      usage: { status: 'reported', inputTokens: 100, outputTokens: 10, totalTokens: 110 }, steps: 2, modelCalls: 2,
      nativeObservations: [], verified: false };
  }
}
const sessions = (): SessionDriver => ({
  async initialize() {}, async prepareContextSafety() { return { ready: true, messageFactory: 'injected', nativeReadback: true, coldProjection: true }; },
  async probe() { throw new Error('No Session probe permitted'); },
  async generateReply() { throw new Error('No reply generation permitted'); },
  async getStatus() { return []; }, async cancel() {}, async close() {},
});
async function fixture(t: any, ready = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiyu-runtime-capability-'));
  const worker = new Worker(); worker.ready = ready;
  const runtimes: RuntimeService[] = [];
  const create = async () => {
    const runtime = new RuntimeService({} as DshContext, { dataDir: directory }, { sessionFactory: sessions,
      workerFactory: () => worker, goalFactory: () => ({ async initialize() {}, async close() {}, async run() { throw new Error('No Goal diagnostic permitted'); } }),
    });
    runtimes.push(runtime); await runtime.init(); return runtime;
  };
  t.after(async () => { for (const runtime of runtimes) await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime: await create(), worker, create };
}
async function settled(runtime: RuntimeService, taskId: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const detail = await runtime.store.request('task.get', { taskId });
    if (['succeeded', 'unknown', 'cancelled'].includes(detail.task.state) && !runtime.operations.has(taskId)) return detail;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic Task did not settle');
}

test('Runtime first approved task starts with unknown proof, records ledger proof, and preserves it across a new host without replay', async t => {
  const { runtime, worker, create } = await fixture(t);
  const initial = await runtime.store.request('ability.snapshot', {});
  assert.equal(initial.availability, 'available'); assert.equal(initial.verification, 'unknown');
  assert.equal(initial.usableForAuthorizedTask, true); assert.equal(worker.calls, 0); assert.equal(worker.observations, 1);
  const admitted = await runtime.command({ action: 'task.createLocal', requestId: 'first-business-note', title: 'Synthetic first ordinary task', content: CONTENT }) as any;
  const result = await settled(runtime, admitted.task.taskId);
  assert.equal(result.task.state, 'succeeded'); assert.equal(worker.calls, 1);
  const proof = await runtime.store.request('ability.snapshot', {});
  assert.equal(proof.verification, 'verified'); assert.equal(proof.safetyRevision, initial.safetyRevision);
  assert.equal(proof.lastSuccess?.taskId, admitted.task.taskId);
  assert.equal(proof.lastSuccess?.receiptId, result.effectReceipts[0]?.receiptId);
  assert.equal((await runtime.artifacts.inspect({ taskId: admitted.task.taskId }))?.sha256, result.artifact.expectedSha256);
  const state = await runtime.store.request('view.state', {});
  assert.equal(state?.manifest.schemaVersion, 4); assert.equal(state?.manifest.domains.ability.status, 'available');
  for (const domain of ['relationship', 'emotion', 'cognition', 'personality'] as const) assert.equal(state?.manifest.domains[domain].status, 'available');
  await runtime.close();
  const reopened = await create();
  const current = await reopened.store.request('ability.snapshot', {});
  assert.equal(current.verification, 'verified'); assert.equal(current.availability, 'available');
  assert.deepEqual(current.lastSuccess, proof.lastSuccess); assert.deepEqual(current.binding, proof.binding);
  assert.ok(current.safetyRevision > proof.safetyRevision); assert.equal(worker.calls, 1); assert.equal(worker.observations, 2);
  assert.equal((await reopened.store.request('task.list', {})).length, 1);
});

test('1000 Runtime snapshots perform no capability observations, model dispatches or control/publication writes', async t => {
  const { runtime, worker } = await fixture(t);
  const before = await runtime.store.request('control.watermark', {});
  const publication = await runtime.store.request('view.state', {});
  const ability = await runtime.store.request('ability.snapshot', {});
  for (let index = 0; index < 1000; index++) {
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.ability.ready, true);
    assert.equal(snapshot.ability.snapshot?.verification, 'unknown');
  }
  assert.deepEqual(await runtime.store.request('control.watermark', {}), before);
  assert.deepEqual(await runtime.store.request('view.state', {}), publication);
  assert.deepEqual(await runtime.store.request('ability.snapshot', {}), ability);
  assert.equal(worker.calls, 0); assert.equal(worker.observations, 1);
  assert.deepEqual(await runtime.store.request('task.list', {}), []);
});

test('missing native prerequisite keeps capability readable but rejects ordinary task admission and private observation forgery', async t => {
  const { runtime, worker } = await fixture(t, false);
  const ability = await runtime.store.request('ability.snapshot', {});
  assert.equal(ability.availability, 'unavailable'); assert.equal(ability.usableForAuthorizedTask, false);
  await assert.rejects(runtime.command({ action: 'task.createLocal', requestId: 'unavailable-note', title: 'Synthetic unavailable task', content: CONTENT }), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(runtime.command({ action: 'ability.observeLocalNote', status: 'available' }), /Unsupported/);
  await assert.rejects(runtime.command({ action: 'ability.setEnabled', requestId: 'forged-policy', expectedRevision: ability.revision,
    enabled: true, verificationPolicy: 'bypass' }), /Invalid capability/);
  assert.equal(worker.calls, 0); assert.equal(worker.observations, 1);
  assert.deepEqual(await runtime.store.request('task.list', {}), []);
});

test('owner capability CAS and idempotent receipts remain independent of runtime pause and never reapply historical disable', async t => {
  const { runtime, worker } = await fixture(t);
  await runtime.command({ action: 'runtime.pause' });
  const current = await runtime.store.request('ability.snapshot', {});
  const disable = { action: 'ability.setEnabled', requestId: 'disable-one', expectedRevision: current.revision, enabled: false };
  const disabled = await runtime.command(disable) as any;
  const enabled = await runtime.command({ action: 'ability.setEnabled', requestId: 'enable-one', expectedRevision: disabled.snapshot.revision, enabled: true }) as any;
  const before = await runtime.store.request('control.watermark', {});
  assert.deepEqual(await runtime.command(disable), disabled);
  assert.equal((await runtime.store.request('ability.snapshot', {})).revision, enabled.snapshot.revision);
  assert.equal((await runtime.store.request('ability.snapshot', {})).enabled, true);
  assert.deepEqual(await runtime.store.request('control.watermark', {}), before);
  await assert.rejects(runtime.command({ ...disable, requestId: 'stale-command' }), { code: 'CAPABILITY_CONFLICT' });
  assert.equal((await runtime.snapshot()).state, 'paused'); assert.equal(worker.calls, 0);
});

test('persistent disable cancels only the active local-note worker before publication and preserves unknown accounting', async t => {
  const { runtime, worker } = await fixture(t);
  let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  worker.beforeTool = request => new Promise((_resolve, reject) => {
    const abort = () => reject(new Error('Synthetic worker cancelled after durable disable'));
    request.signal!.addEventListener('abort', abort, { once: true }); entered();
    if (request.signal!.aborted) abort();
  });
  const admitted = await runtime.command({ action: 'task.createLocal', requestId: 'cancel-active', title: 'Synthetic disabled worker', content: CONTENT }) as any;
  await began;
  const current = await runtime.store.request('ability.snapshot', {});
  await runtime.command({ action: 'ability.setEnabled', requestId: 'disable-active', expectedRevision: current.revision, enabled: false });
  const detail = await settled(runtime, admitted.task.taskId);
  assert.equal(detail.task.state, 'unknown'); assert.equal(detail.reservation?.state, 'unknown');
  assert.equal(detail.effects.length, 0); assert.equal(await runtime.artifacts.inspect({ taskId: admitted.task.taskId }), undefined);
  assert.equal((await runtime.store.request('ability.snapshot', {})).verification, 'unknown');
  assert.equal(worker.calls, 1);
});
