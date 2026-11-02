import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { LocalArtifactStore } from '../src/adapters/artifacts/index.js';
import { LocalTaskRunner } from '../src/control/task-runner.js';
import type { TaskWorkerDriver } from '../src/control/task-runner.js';
import type { WorkerRunRequest, WorkerRunResult } from '../src/adapters/dsh/workers.js';

const CONTENT = 'Synthetic Shiyu task: independently verify this exact local artifact.';
class FixtureWorker implements TaskWorkerDriver {
  calls = 0;
  failAfterArtifact = false;
  modelCalls: number | null = 2;
  beforeTool?: () => void;
  async initialize() {}
  async close() {}
  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    this.calls++;
    const binding = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope, sessionId: 'shiyu-worker-synthetic-fixture' };
    const identity = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope,
      hostEpoch: request.permit.hostEpoch, installationGeneration: request.permit.installationGeneration,
      fencingToken: request.permit.fencingToken, leaseExpiresAt: request.permit.leaseExpiresAt };
    await request.onBound(binding);
    this.beforeTool?.();
    await request.tools![0].execute({ content: CONTENT }, { ...binding, permit: identity, signal: request.signal!,
      assertPermit: async () => { await request.permit.check({ ...identity, phase: 'tool', toolName: request.tools![0].name }); },
    });
    if (this.failAfterArtifact) throw new Error('Synthetic model final response unavailable');
    return { ...binding, candidate: { summary: 'Synthetic worker candidate; independently verify it.', evidenceRequests: [`artifact:${request.taskId}`] },
      usage: { status: 'reported', inputTokens: 100, outputTokens: 10, totalTokens: 190, cacheReadTokens: 80, cacheWriteTokens: 0 }, steps: 2, modelCalls: this.modelCalls, nativeObservations: [], verified: false };
  }
}
async function setup(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiyu-task-runner-'));
  const store = await ControlStore.open({ filename: path.join(root, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [], runtimeIdentity: { hostEpoch: 'host-test', installationGeneration: 'installation-test' } });
  const artifacts = await LocalArtifactStore.open(path.join(root, 'workspaces'));
  const worker = new FixtureWorker();
  const runner = new LocalTaskRunner(store, worker, artifacts);
  const created = await store.request('task.createLocal', { requestId: 'synthetic-one', title: 'Synthetic note verification', content: CONTENT });
  t.after(async () => { await artifacts.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, artifacts, worker, runner, taskId: created.task.taskId };
}

test('native-worker orchestration commits a real local artifact, receipt and independent completion', async t => {
  const { runner, store, artifacts, worker, taskId } = await setup(t);
  const phases: string[] = [];
  const task = await runner.run(taskId, { signal: new AbortController().signal, progress: phase => phases.push(phase) });
  assert.equal(task.state, 'succeeded');
  assert.ok(task.verification?.checks.every(check => check.status === 'pass'));
  const detail = await store.request('task.get', { taskId });
  assert.equal(detail.effects.length, 1); assert.equal(detail.effects[0].status, 'succeeded');
  assert.equal((await artifacts.inspect({ taskId }))?.sha256, detail.artifact.expectedSha256);
  assert.equal(worker.calls, 1); assert.ok(phases.length >= 4);
  await assert.rejects(runner.run(taskId, { signal: new AbortController().signal, progress() {} }));
  assert.equal(worker.calls, 1);
  const retry = await store.request('task.createLocal', { requestId: 'synthetic-one', title: 'Synthetic note verification', content: CONTENT });
  assert.equal(retry.task.taskId, taskId); assert.equal(retry.task.state, 'succeeded');
});

test('a completed artifact and a failed worker remain distinct facts and never trigger automatic replay', async t => {
  const { runner, store, artifacts, worker, taskId } = await setup(t);
  worker.failAfterArtifact = true;
  await assert.rejects(runner.run(taskId, { signal: new AbortController().signal, progress() {} }), /Synthetic model final response unavailable/);
  const detail = await store.request('task.get', { taskId });
  assert.equal(detail.task.state, 'unknown'); assert.equal(detail.effects[0].status, 'succeeded');
  assert.ok(await artifacts.inspect({ taskId })); assert.equal(worker.calls, 1);
  await assert.rejects(runner.run(taskId, { signal: new AbortController().signal, progress() {} }));
  assert.equal(worker.calls, 1);
});

test('unknown native call count holds the budget even when the artifact has independently completed', async t => {
  const { runner, store, worker, taskId } = await setup(t);
  worker.modelCalls = null;
  await runner.run(taskId, { signal: new AbortController().signal, progress() {} });
  const detail = await store.request('task.get', { taskId });
  assert.equal(detail.effects[0].status, 'succeeded');
  assert.equal(detail.reservation?.state, 'unknown');
  assert.equal(detail.reservation?.observed.calls, undefined);
  assert.equal(detail.reservation?.observed.tokens, 190);
  assert.equal(worker.calls, 1);
});

test('cancellation before the controlled tool does not create a file or falsely complete a task', async t => {
  const { runner, store, artifacts, worker, taskId } = await setup(t);
  const controller = new AbortController(); worker.beforeTool = () => controller.abort(new Error('Synthetic stop'));
  await assert.rejects(runner.run(taskId, { signal: controller.signal, progress() {} }), /Synthetic stop/);
  assert.equal(await artifacts.inspect({ taskId }), undefined);
  assert.equal((await store.request('task.get', { taskId })).task.state, 'unknown');
});
