/**
 * task-73: writable shared-workspace integration in the TaskRunner path.
 *
 * Real temporary ControlStore, LocalArtifactStore and hard-link shared root;
 * the fake worker only simulates a worker Session creating files in its
 * `<taskId>/shared` mirror. No live host, no model, no real workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import { LocalArtifactStore } from '../src/adapters/artifacts/index.js';
import { LocalTaskRunner, type TaskWorkerDriver } from '../src/control/task-runner.js';
import { TaskWorkspaceCoordinator } from '../src/control/task-workspace.js';
import {
  TASK_WORKSPACE_BUSY,
  TASK_WORKSPACE_CONFLICT_UNKNOWN,
  TASK_WORKSPACE_PATH_INVALID,
  type TaskWorkspaceCoordinatorOptions,
} from '../src/control/task-workspace.js';
import type { TaskExecutionPlan } from '../src/adapters/control-store/task-domain.js';
import type { WorkerRunRequest, WorkerRunResult } from '../src/adapters/dsh/workers.js';
import { syntheticLocalNoteBinding, observeSyntheticLocalNote } from './helpers/capability.js';

const CONTENT = 'Synthetic task-73 artifact: independently verify this exact local-note content.';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const artifactDirectory = path.join(packageRoot, 'artifacts', 'dsh', 'tasks');
const evidenceFile = path.join(artifactDirectory, 'workspace-runtime-integration.json');
const patchFile = path.join(artifactDirectory, 'runtime-task-workspace.diff');

const hasCode = (code: string) => (error: unknown): boolean => {
  const candidate = error as { code?: unknown };
  return typeof candidate?.code === 'string' && candidate.code === code;
};

class WorkspaceWorker implements TaskWorkerDriver {
  calls = 0;
  runRequests: WorkerRunRequest[] = [];
  failBeforeTool = false;
  failAfterTool = false;
  gate?: Promise<void>;
  beforeTool?: (request: WorkerRunRequest) => Promise<void>;
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async run(request: WorkerRunRequest): Promise<WorkerRunResult> {
    this.calls += 1;
    this.runRequests.push(request);
    const binding = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope, sessionId: 'shiyu-worker-workspace-fixture' };
    const identity = { taskId: request.taskId, assignmentId: request.assignmentId, scope: request.scope,
      hostEpoch: request.permit.hostEpoch, installationGeneration: request.permit.installationGeneration,
      fencingToken: request.permit.fencingToken, leaseExpiresAt: request.permit.leaseExpiresAt };
    await request.onBound(binding);
    if (this.gate) await this.gate;
    if (this.beforeTool) await this.beforeTool(request);
    if (this.failBeforeTool) throw new Error('Synthetic worker failed before writing the artifact');
    await request.tools![0].execute({ content: CONTENT }, { ...binding, permit: identity, signal: request.signal!,
      assertPermit: async () => { await request.permit.check({ ...identity, phase: 'tool', toolName: request.tools![0].name }); },
    });
    if (this.failAfterTool) throw new Error('Synthetic worker final response unavailable after artifact write');
    return { ...binding, candidate: { summary: 'Synthetic workspace worker candidate; independently verify it.', evidenceRequests: [`artifact:${request.taskId}`] },
      usage: { status: 'reported', inputTokens: 100, outputTokens: 10, totalTokens: 190, cacheReadTokens: 80, cacheWriteTokens: 0 }, steps: 2, modelCalls: 2,
      nativeObservations: [], verified: false };
  }
}

const writeSharedFile = async (request: WorkerRunRequest, relative: string, content: string): Promise<void> => {
  // The worker cwd is <taskId>/task; its writable shared mirror is a sibling.
  const sharedDir = path.join(path.dirname(request.cwd), 'shared');
  const target = path.join(sharedDir, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

interface Fixture {
  root: string;
  workspacesRoot: string;
  sharedRoot: string;
  store: ControlStore;
  artifacts: LocalArtifactStore;
  worker: WorkspaceWorker;
  coordinatorOptions: Omit<TaskWorkspaceCoordinatorOptions, 'workspacesRoot' | 'sharedRoot'>;
  runner(coordinator?: TaskWorkspaceCoordinator): LocalTaskRunner;
  coordinator(overrides?: Partial<TaskWorkspaceCoordinatorOptions>): TaskWorkspaceCoordinator;
  createTask(requestId?: string): Promise<string>;
}

const setup = async (t: { after(fn: () => Promise<void>): void }): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shiyu-task-workspace-'));
  const workspacesRoot = path.join(root, 'workspaces');
  const sharedRoot = path.join(root, 'shared-workspace');
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  const runtimeIdentity = { hostEpoch: 'host-test-task73', installationGeneration: 'installation-test-task73' };
  const store = await ControlStore.open({
    filename: path.join(root, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [], runtimeIdentity,
    localNoteBinding: syntheticLocalNoteBinding(runtimeIdentity.installationGeneration),
  });
  const artifacts = await LocalArtifactStore.open(workspacesRoot);
  t.after(async () => { await artifacts.close().catch(() => undefined); await store.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  await observeSyntheticLocalNote(store, runtimeIdentity);
  const worker = new WorkspaceWorker();
  const coordinatorOptions: Omit<TaskWorkspaceCoordinatorOptions, 'workspacesRoot' | 'sharedRoot'> = {
    allowedSharedRoots: [sharedRoot],
  };
  const coordinator = (overrides: Partial<TaskWorkspaceCoordinatorOptions> = {}): TaskWorkspaceCoordinator =>
    new TaskWorkspaceCoordinator({ workspacesRoot, sharedRoot, ...coordinatorOptions, ...overrides }, artifacts);
  const runner = (instance?: TaskWorkspaceCoordinator): LocalTaskRunner =>
    new LocalTaskRunner(store, worker, artifacts, instance);
  let sequence = 0;
  const createTask = async (requestId = `workspace-task-${++sequence}`): Promise<string> =>
    (await store.request('task.createLocal', { requestId, title: 'Synthetic shared workspace task', content: CONTENT })).task.taskId;
  return { root, workspacesRoot, sharedRoot, store, artifacts, worker, coordinatorOptions, runner, coordinator, createTask };
};

const manifestPath = (fix: Fixture, taskId: string): string => path.join(fix.workspacesRoot, taskId, '.workspace-manifest.json');
const reportPath = (fix: Fixture, taskId: string): string => path.join(fix.workspacesRoot, taskId, '.workspace-report.json');
const failureMarkerPath = (fix: Fixture, taskId: string): string => path.join(fix.workspacesRoot, taskId, '.workspace-failure.json');
const sharedPath = (fix: Fixture, taskId: string, relative: string): string => path.join(fix.workspacesRoot, taskId, 'shared', ...relative.split('/'));
const canonicalPath = (fix: Fixture, relative: string): string => path.join(fix.sharedRoot, ...relative.split('/'));
const readJson = async (filename: string): Promise<any> => JSON.parse(await readFile(filename, 'utf8')) as any;

test('successful task prepares <taskId>/task, publishes new shared files and keeps artifacts unchanged', async t => {
  const fix = await setup(t);
  await mkdir(path.join(fix.sharedRoot, 'docs'), { recursive: true });
  await writeFile(canonicalPath(fix, 'docs/base.md'), 'base shared file');
  const taskId = await fix.createTask('success-new-file');
  fix.worker.beforeTool = async request => { await writeSharedFile(request, 'docs/created-by-task.md', 'created by the task'); };
  const runner = fix.runner(fix.coordinator());
  const beforeArtifact = await lstat(path.join(fix.workspacesRoot, taskId, 'artifacts')).catch(() => undefined);
  const task = await runner.run(taskId, { signal: new AbortController().signal, progress() {} });
  assert.equal(task.state, 'succeeded');
  const request = fix.worker.runRequests[0]!;
  assert.equal(request.cwd, path.join(await realpath(fix.workspacesRoot), taskId, 'task'));
  assert.deepEqual(await readdir(path.join(fix.workspacesRoot, taskId)).then(entries => entries.sort()), ['.workspace-manifest.json', '.workspace-report.json', 'artifacts', 'task'].sort());
  assert.equal(await readFile(canonicalPath(fix, 'docs/created-by-task.md'), 'utf8'), 'created by the task');
  const report = await readJson(reportPath(fix, taskId));
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change: any) => [change.path, change.kind]), [['docs/created-by-task.md', 'published-new']]);
  assert.equal(report.lockReleased, true);
  assert.equal(report.mirrorRetained, false);
  assert.equal((await lstat(path.join(fix.workspacesRoot, taskId, 'shared')).catch(() => null)), null);
  const index = await readJson(path.join(fix.workspacesRoot, '.shared-workspaces', 'index.json'));
  assert.equal(index.entries.some((entry: any) => entry.path === 'docs/created-by-task.md'), true);
  const manifest = await readJson(manifestPath(fix, taskId));
  assert.equal(manifest.entries.some((entry: any) => entry.path === 'docs/base.md' && /^[a-f0-9]{64}$/.test(entry.sha256)), true);
  assert.equal(await readFile(path.join(fix.workspacesRoot, taskId, 'artifacts', 'note.txt'), 'utf8'), CONTENT);
  if (beforeArtifact) assert.equal((await lstat(path.join(fix.workspacesRoot, taskId, 'artifacts'))).ino, beforeArtifact.ino);
});

test('without a configured shared root the runner keeps the exact legacy path (no-op compatibility)', async t => {
  const fix = await setup(t);
  const taskId = await fix.createTask('no-shared');
  // The coordinator without sharedRoot is constructed separately to avoid the default shared root.
  const noShared = new TaskWorkspaceCoordinator({ workspacesRoot: fix.workspacesRoot }, fix.artifacts);
  const task = await fix.runner(noShared).run(taskId, { signal: new AbortController().signal, progress() {} });
  assert.equal(task.state, 'succeeded');
  assert.equal(fix.worker.runRequests[0]!.cwd, path.join(fix.artifacts.root, taskId));
  assert.equal(await lstat(path.join(fix.workspacesRoot, taskId, 'task')).catch(() => null), null);
  assert.equal(await lstat(path.join(fix.workspacesRoot, taskId, 'shared')).catch(() => null), null);
  assert.equal(await lstat(path.join(fix.workspacesRoot, '.shared-workspaces')).catch(() => null), null);
  assert.equal(await readFile(path.join(fix.workspacesRoot, taskId, 'artifacts', 'note.txt'), 'utf8'), CONTENT);
});

test('a worker failure never publishes task-side shared files and keeps the mirror for reconciliation', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'notes.md'), 'canonical before');
  const taskId = await fix.createTask('worker-failure');
  fix.worker.beforeTool = async request => { await writeSharedFile(request, 'new.md', 'unpublished new file'); };
  fix.worker.failAfterTool = true;
  const runner = fix.runner(fix.coordinator());
  await assert.rejects(runner.run(taskId, { signal: new AbortController().signal, progress() {} }), /final response unavailable/);
  const detail = await fix.store.request('task.get', { taskId });
  assert.equal(detail.task.state, 'unknown');
  assert.equal(await readFile(canonicalPath(fix, 'notes.md'), 'utf8'), 'canonical before', 'nothing was implicitly published');
  await assert.rejects(readFile(canonicalPath(fix, 'new.md')), /ENOENT/);
  assert.equal((await lstat(sharedPath(fix, taskId, 'new.md'))).isFile(), true, 'task mirror is retained');
  await assert.rejects(readFile(reportPath(fix, taskId)), /ENOENT/, 'no publish receipt for an unpublished failure');
  const marker = await readJson(failureMarkerPath(fix, taskId));
  assert.equal(marker.status, 'unknown-or-reconcile');
  assert.equal(marker.mirrorRetained, true);
  assert.equal(marker.published, false);
  const discarded = await fix.coordinator().discard(taskId);
  assert.equal(discarded.mirrorRemoved, true);
  assert.equal(discarded.lockReleased, true);
});

test('an undeclared in-place modification is a publish conflict: task unknown, no index guess, no success', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'notes.md'), 'original shared notes');
  const taskId = await fix.createTask('conflict');
  fix.worker.beforeTool = async request => { await writeSharedFile(request, 'notes.md', 'undeclared edit'); };
  const runner = fix.runner(fix.coordinator());
  await assert.rejects(runner.run(taskId, { signal: new AbortController().signal, progress() {} }),
    (error: unknown) => hasCode(TASK_WORKSPACE_CONFLICT_UNKNOWN)(error) || /unknown/.test((error as Error).message));
  const detail = await fix.store.request('task.get', { taskId });
  assert.equal(detail.task.state, 'unknown');
  assert.equal(await readFile(canonicalPath(fix, 'notes.md'), 'utf8'), 'undeclared edit', 'in-place write propagated (disclosed)');
  const report = await readJson(reportPath(fix, taskId));
  assert.equal(report.status, 'unknown');
  assert.equal(report.conflicts.some((conflict: any) => conflict.path === 'notes.md' && conflict.kind === 'unexpected-modification'), true);
  assert.equal(await readFile(path.join(fix.workspacesRoot, '.shared-workspaces', 'index.json')).catch(() => null), null, 'index must not guess');
  const marker = await readJson(failureMarkerPath(fix, taskId));
  assert.equal(marker.published, false);
  await fix.coordinator().discard(taskId);
});

test('trusted plan expectedChanges enable a declared in-place update and index refresh', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'notes.md'), 'before declared change');
  await writeFile(canonicalPath(fix, 'other.md'), 'other unchanged');
  const taskId = await fix.createTask('expected-change');
  fix.worker.beforeTool = async request => { await writeSharedFile(request, 'notes.md', 'after declared change'); };
  const coordinator = fix.coordinator({ expectedChanges: (_plan: TaskExecutionPlan) => ['notes.md'] });
  const task = await fix.runner(coordinator).run(taskId, { signal: new AbortController().signal, progress() {} });
  assert.equal(task.state, 'succeeded');
  const report = await readJson(reportPath(fix, taskId));
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change: any) => [change.path, change.kind]), [['notes.md', 'in-place-updated']]);
  const index = await readJson(path.join(fix.workspacesRoot, '.shared-workspaces', 'index.json'));
  const notes = index.entries.find((entry: any) => entry.path === 'notes.md');
  assert.equal(notes.sha256, createHash('sha256').update('after declared change').digest('hex'));
  assert.equal(await readFile(path.join(fix.workspacesRoot, taskId, 'artifacts', 'note.txt'), 'utf8'), CONTENT);
});

test('a shared-workspace lock held by another task rejects a second task before it is claimed', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'notes.md'), 'locked');
  const firstTask = await fix.createTask('lock-first');
  const secondTask = await fix.createTask('lock-second');
  let releaseGate!: () => void;
  fix.worker.gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const firstRun = fix.runner(fix.coordinator()).run(firstTask, { signal: new AbortController().signal, progress() {} });
  // Wait until the first task holds the exclusive workspace lock.
  let prepared = false;
  for (let index = 0; index < 50 && !prepared; index++) {
    prepared = (await lstat(manifestPath(fix, firstTask)).catch(() => null)) !== null;
    if (!prepared) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(prepared, true);
  const secondWorkerCallsBefore = fix.worker.calls;
  await assert.rejects(fix.runner(fix.coordinator()).run(secondTask, { signal: new AbortController().signal, progress() {} }),
    (error: unknown) => hasCode(TASK_WORKSPACE_BUSY)(error));
  assert.equal(fix.worker.calls, secondWorkerCallsBefore, 'second worker must not start');
  const secondDetail = await fix.store.request('task.get', { taskId: secondTask });
  assert.equal(secondDetail.task.state, 'queued', 'busy rejection leaves the second task untouched in the queue');
  releaseGate();
  const firstResult = await firstRun;
  assert.equal(firstResult.state, 'succeeded');
});

test('unsafe trusted plan paths and overlapping shared roots fail closed before the worker runs', async t => {
  const fix = await setup(t);
  const taskId = await fix.createTask('path-unsafe');
  fix.worker.beforeTool = async request => { await writeSharedFile(request, 'notes.md', 'should not run'); };
  const unsafe = fix.coordinator({ expectedChanges: () => ['../escape.md'] });
  await assert.rejects(fix.runner(unsafe).run(taskId, { signal: new AbortController().signal, progress() {} }),
    (error: unknown) => hasCode(TASK_WORKSPACE_PATH_INVALID)(error));
  assert.equal(fix.worker.calls, 0, 'worker must not run with an unsafe plan projection');
  const detail = await fix.store.request('task.get', { taskId });
  assert.equal(detail.task.state, 'unknown');
  // No mirror/lock may remain after a pre-worker plan rejection.
  assert.equal(await lstat(manifestPath(fix, taskId)).catch(() => null), null);
  assert.equal(await lstat(path.join(fix.workspacesRoot, taskId, 'shared')).catch(() => null), null);
  // An overlapping shared root is rejected by the adapter before any claim.
  const overlapping = new TaskWorkspaceCoordinator({ workspacesRoot: fix.workspacesRoot,
    sharedRoot: path.join(fix.workspacesRoot, 'inside-shared'), allowedSharedRoots: [path.join(fix.workspacesRoot, 'inside-shared')] }, fix.artifacts);
  await mkdir(path.join(fix.workspacesRoot, 'inside-shared'), { recursive: true, mode: 0o700 });
  const secondTask = await fix.createTask('overlap-root');
  await assert.rejects(fix.runner(overlapping).run(secondTask, { signal: new AbortController().signal, progress() {} }),
    (error: unknown) => hasCode('SHARED_ROOT_OVERLAP')(error));
  assert.equal((await fix.store.request('task.get', { taskId: secondTask })).task.state, 'queued');
  assert.equal(fix.worker.calls, 0);
});

test('a claim failure discards the prepared empty mirror and lock', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'notes.md'), 'base');
  const taskId = await fix.createTask('claim-failure');
  // Claim the assignment manually so the runner's claim must fail.
  await fix.store.request('task.claimAssignment', { taskId, leaseMs: 60000 });
  const runner = fix.runner(fix.coordinator());
  await assert.rejects(runner.run(taskId, { signal: new AbortController().signal, progress() {} }));
  assert.equal(fix.worker.calls, 0);
  assert.equal(await lstat(manifestPath(fix, taskId)).catch(() => null), null);
  assert.equal(await lstat(path.join(fix.workspacesRoot, taskId, 'shared')).catch(() => null), null);
  assert.equal(await readFile(path.join(fix.workspacesRoot, '.shared-workspaces', 'lock.json')).catch(() => null), null);
});

test('deleting a shared file defaults to a task-side unlink; the canonical file is kept', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'keep.md'), 'canonical keep');
  const taskId = await fix.createTask('delete-default');
  fix.worker.beforeTool = async () => { await rm(sharedPath(fix, taskId, 'keep.md')); };
  const task = await fix.runner(fix.coordinator()).run(taskId, { signal: new AbortController().signal, progress() {} });
  assert.equal(task.state, 'succeeded');
  assert.equal(await readFile(canonicalPath(fix, 'keep.md'), 'utf8'), 'canonical keep');
  const report = await readJson(reportPath(fix, taskId));
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change: any) => [change.path, change.kind]), [['keep.md', 'task-link-removed']]);
  assert.equal(await readJson(path.join(fix.workspacesRoot, '.shared-workspaces', 'index.json')).then(index => index.entries.some((entry: any) => entry.path === 'keep.md')), true);
});

test('an explicit trusted ownerDecision can delete the canonical shared file through the runner', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'remove.md'), 'remove under owner decision');
  await writeFile(canonicalPath(fix, 'keep.md'), 'keep');
  const taskId = await fix.createTask('delete-owner-decision');
  fix.worker.beforeTool = async () => { await rm(sharedPath(fix, taskId, 'remove.md')); };
  const coordinator = fix.coordinator({
    ownerDecision: (plan: TaskExecutionPlan) => plan.taskId === taskId
      ? { kind: 'delete-shared', paths: ['remove.md'], decisionId: 'owner-decision-task-73' }
      : undefined,
  });
  const task = await fix.runner(coordinator).run(taskId, { signal: new AbortController().signal, progress() {} });
  assert.equal(task.state, 'succeeded');
  await assert.rejects(readFile(canonicalPath(fix, 'remove.md')), /ENOENT/);
  assert.equal(await readFile(canonicalPath(fix, 'keep.md'), 'utf8'), 'keep');
  const report = await readJson(reportPath(fix, taskId));
  assert.equal(report.status, 'synced');
  assert.deepEqual(report.changes.map((change: any) => [change.path, change.kind]), [['remove.md', 'shared-deleted']]);
  assert.deepEqual(report.ownerDecision, { kind: 'delete-shared', decisionId: 'owner-decision-task-73', paths: ['remove.md'] });
  const index = await readJson(path.join(fix.workspacesRoot, '.shared-workspaces', 'index.json'));
  assert.equal(index.entries.some((entry: any) => entry.path === 'remove.md'), false);
});

test('after a failed task the explicit discard unblocks a later shared-workspace task', async t => {
  const fix = await setup(t);
  await writeFile(canonicalPath(fix, 'notes.md'), 'base');
  const firstTask = await fix.createTask('reconcile-first');
  fix.worker.beforeTool = async request => { await writeSharedFile(request, 'staged.md', 'never published'); };
  fix.worker.failAfterTool = true;
  await assert.rejects(fix.runner(fix.coordinator()).run(firstTask, { signal: new AbortController().signal, progress() {} }));
  assert.equal((await fix.store.request('task.get', { taskId: firstTask })).task.state, 'unknown');
  assert.equal(await lstat(sharedPath(fix, firstTask, 'staged.md')).then(() => true), true);
  const discarded = await fix.coordinator().discard(firstTask);
  assert.equal(discarded.mirrorRemoved, true);
  fix.worker.failAfterTool = false;
  fix.worker.beforeTool = async request => { await writeSharedFile(request, 'reconciled.md', 'published after reconcile'); };
  const secondTask = await fix.createTask('reconcile-second');
  const second = await fix.runner(fix.coordinator()).run(secondTask, { signal: new AbortController().signal, progress() {} });
  assert.equal(second.state, 'succeeded');
  assert.equal(await readFile(canonicalPath(fix, 'reconciled.md'), 'utf8'), 'published after reconcile');
  await assert.rejects(readFile(canonicalPath(fix, 'staged.md')), /ENOENT/);
});

/* ------------------------------------------------------------------------------------------------
 * Evidence generator
 * ---------------------------------------------------------------------------------------------- */

async function generateEvidence(): Promise<void> {
  const cases: { caseId: string; injectionPoint: string; expected: string; observed: string; pass: boolean; evidence?: Record<string, unknown> }[] = [];
  const record = async (caseId: string, injectionPoint: string, expected: string, body: () => Promise<{ observed: string; evidence?: Record<string, unknown> }>): Promise<void> => {
    try { const result = await body(); cases.push({ caseId, injectionPoint, expected, ...result, pass: true }); }
    catch (error) { cases.push({ caseId, injectionPoint, expected, observed: `failed: ${(error as Error).message}`, pass: false }); }
  };
  const withFixture = async <T>(body: (fix: Fixture) => Promise<T>): Promise<T> => {
    const holder: { after(fn: () => Promise<void>): void } = { after() {} };
    const fix = await setup(holder);
    try { return await body(fix); } finally {
      await fix.artifacts.close().catch(() => undefined);
      await fix.store.close().catch(() => undefined);
      await rm(fix.root, { recursive: true, force: true });
    }
  };
  const successTask = async (fix: Fixture): Promise<{ taskId: string; manifestBefore: any; report: any; canonical: string; index: any }> => {
    await mkdir(path.join(fix.sharedRoot, 'docs'), { recursive: true });
    await writeFile(canonicalPath(fix, 'docs/base.md'), 'base');
    const taskId = await fix.createTask('evidence-success');
    fix.worker.beforeTool = async request => {
      await writeSharedFile(request, 'docs/created.md', 'created during evidence task');
      await writeSharedFile(request, 'docs/base.md', 'updated in place via mirror');
    };
    const coordinator = fix.coordinator({ expectedChanges: (plan: TaskExecutionPlan) => plan.taskId === taskId ? ['docs/base.md'] : [] });
    const task = await fix.runner(coordinator).run(taskId, { signal: new AbortController().signal, progress() {} });
    if (task.state !== 'succeeded') throw new Error(`task state ${task.state}`);
    return {
      taskId,
      manifestBefore: await readJson(manifestPath(fix, taskId)),
      report: await readJson(reportPath(fix, taskId)),
      canonical: await readFile(canonicalPath(fix, 'docs/created.md'), 'utf8'),
      index: await readJson(path.join(fix.workspacesRoot, '.shared-workspaces', 'index.json')),
    };
  };
  await record('success-prepare-publish', '配置 sharedRoot；fake worker 在 <taskId>/shared 新建/原地写文件，任务成功', 'cwd=<taskId>/task；canonical 新文件发布；index 更新；task succeeded', async () => {
    return withFixture(async fix => {
      const result = await successTask(fix);
      return {
        observed: `cwd task; published ${result.report.changes.length} changes; index entries=${result.index.entries.length}; task=succeeded`,
        evidence: { taskId: result.taskId, changes: result.report.changes.map((change: any) => [change.path, change.kind]), canonical: result.canonical, manifestEntries: result.manifestBefore.entries.length },
      };
    });
  });
  await record('no-shared-noop', '未配置 sharedRoot', 'cwd=<workspaces>/<taskId>；无 .shared-workspaces/manifest；任务照旧成功', async () => {
    return withFixture(async fix => {
      const taskId = await fix.createTask('evidence-no-shared');
      const noShared = new TaskWorkspaceCoordinator({ workspacesRoot: fix.workspacesRoot }, fix.artifacts);
      const task = await fix.runner(noShared).run(taskId, { signal: new AbortController().signal, progress() {} });
      return { observed: `task=${task.state}; cwd=${fix.worker.runRequests[0]!.cwd}`, evidence: { cwd: fix.worker.runRequests[0]!.cwd } };
    });
  });
  await record('worker-failure-no-publish', 'fake worker 写入 shared 后失败', 'canonical 不变；无 publish receipt；task unknown；mirror 保留', async () => {
    return withFixture(async fix => {
      await writeFile(canonicalPath(fix, 'notes.md'), 'canonical');
      const taskId = await fix.createTask('evidence-worker-failure');
      fix.worker.beforeTool = async request => { await writeSharedFile(request, 'notes.md', 'unpublished'); };
      fix.worker.failAfterTool = true;
      await assert.rejects(fix.runner(fix.coordinator()).run(taskId, { signal: new AbortController().signal, progress() {} }));
      return { observed: `task=${(await fix.store.request('task.get', { taskId })).task.state}; canonical=${await readFile(canonicalPath(fix, 'notes.md'), 'utf8')}`, evidence: { failureMarker: await readJson(failureMarkerPath(fix, taskId)) } };
    });
  });
  await record('conflict-unknown', '原地修改未在 trusted expectedChanges 声明', 'task unknown；index 不猜；conflict 保留', async () => {
    return withFixture(async fix => {
      await writeFile(canonicalPath(fix, 'notes.md'), 'before');
      const taskId = await fix.createTask('evidence-conflict');
      fix.worker.beforeTool = async request => { await writeSharedFile(request, 'notes.md', 'undeclared'); };
      await assert.rejects(fix.runner(fix.coordinator()).run(taskId, { signal: new AbortController().signal, progress() {} }));
      const report = await readJson(reportPath(fix, taskId));
      return { observed: `task=${(await fix.store.request('task.get', { taskId })).task.state}; report=${report.status}`, evidence: { conflicts: report.conflicts } };
    });
  });
  await record('lock-busy', '第一个任务持锁时第二个任务 run', '第二任务在 claim 前 TASK_WORKSPACE_BUSY；状态保持 queued；worker 不启动', async () => {
    return withFixture(async fix => {
      await writeFile(canonicalPath(fix, 'notes.md'), 'x');
      const firstTask = await fix.createTask('evidence-lock-a');
      const secondTask = await fix.createTask('evidence-lock-b');
      let release!: () => void;
      fix.worker.gate = new Promise<void>(resolve => { release = resolve; });
      const firstRun = fix.runner(fix.coordinator()).run(firstTask, { signal: new AbortController().signal, progress() {} });
      for (let i = 0; i < 50; i++) { if (await lstat(manifestPath(fix, firstTask)).catch(() => null)) break; await new Promise(resolve => setTimeout(resolve, 20)); }
      let busyCode = '';
      try { await fix.runner(fix.coordinator()).run(secondTask, { signal: new AbortController().signal, progress() {} }); } catch (error) { busyCode = (error as { code?: string }).code ?? ''; }
      const secondState = (await fix.store.request('task.get', { taskId: secondTask })).task.state;
      release();
      await firstRun;
      return { observed: `busy=${busyCode}; second=${secondState}`, evidence: { busyCode, secondState } };
    });
  });
  await record('path-safety', 'trusted expectedChanges 返回 ../escape.md', 'TASK_WORKSPACE_PATH_INVALID；worker 不运行；task unknown；无 mirror 残留', async () => {
    return withFixture(async fix => {
      const taskId = await fix.createTask('evidence-path');
      await assert.rejects(fix.runner(fix.coordinator({ expectedChanges: () => ['../escape.md'] })).run(taskId, { signal: new AbortController().signal, progress() {} }));
      return { observed: `workerCalls=${fix.worker.calls}; task=${(await fix.store.request('task.get', { taskId })).task.state}`, evidence: { workerCalls: fix.worker.calls } };
    });
  });
  await record('audit-manifest-receipt', '成功任务后读取 manifest/seceipt/index', 'manifest 含 pre 状态；receipt synced；index 含新文件；artifact 路径未变', async () => {
    return withFixture(async fix => {
      const result = await successTask(fix);
      return {
        observed: `manifestEntries=${result.manifestBefore.entries.length}; report=${result.report.status}; index=${result.index.entries.length}`,
        evidence: {
          beforeManifest: result.manifestBefore,
          publishReceipt: result.report,
          index: result.index,
          artifact: await readFile(path.join(fix.workspacesRoot, result.taskId, 'artifacts', 'note.txt'), 'utf8'),
        },
      };
    });
  });
  await record('delete-default-integration', 'worker 删除 shared/ 中链接（无 ownerDecision）', 'canonical 保留；receipt=task-link-removed；task succeeded', async () => {
    return withFixture(async fix => {
      await writeFile(canonicalPath(fix, 'keep.md'), 'keep');
      const taskId = await fix.createTask('evidence-delete-default');
      fix.worker.beforeTool = async () => { await rm(sharedPath(fix, taskId, 'keep.md')); };
      const task = await fix.runner(fix.coordinator()).run(taskId, { signal: new AbortController().signal, progress() {} });
      const report = await readJson(reportPath(fix, taskId));
      return { observed: `task=${task.state}; change=${report.changes[0]?.kind}; canonical=${await readFile(canonicalPath(fix, 'keep.md'), 'utf8')}`, evidence: { change: report.changes[0] } };
    });
  });
  await record('delete-owner-decision-integration', 'worker 删除链接 + trusted ownerDecision delete-shared', 'canonical 受控删除；receipt shared-deleted + decision；task succeeded', async () => {
    return withFixture(async fix => {
      await writeFile(canonicalPath(fix, 'remove.md'), 'remove');
      const taskId = await fix.createTask('evidence-delete-decision');
      fix.worker.beforeTool = async () => { await rm(sharedPath(fix, taskId, 'remove.md')); };
      const coordinator = fix.coordinator({ ownerDecision: () => ({ kind: 'delete-shared', paths: ['remove.md'], decisionId: 'evidence-owner-decision' }) });
      const task = await fix.runner(coordinator).run(taskId, { signal: new AbortController().signal, progress() {} });
      const report = await readJson(reportPath(fix, taskId));
      return { observed: `task=${task.state}; change=${report.changes[0]?.kind}`, evidence: { ownerDecision: report.ownerDecision } };
    });
  });
  await record('failure-reconcile-unblock', 'worker 失败保留 mirror；显式 discard 后新任务成功', '失败任务 unknown、staged 文件未发布；discard 后第二任务成功', async () => {
    return withFixture(async fix => {
      await writeFile(canonicalPath(fix, 'notes.md'), 'base');
      const firstTask = await fix.createTask('evidence-reconcile-first');
      fix.worker.beforeTool = async request => { await writeSharedFile(request, 'staged.md', 'never'); };
      fix.worker.failAfterTool = true;
      await assert.rejects(fix.runner(fix.coordinator()).run(firstTask, { signal: new AbortController().signal, progress() {} }));
      await fix.coordinator().discard(firstTask);
      fix.worker.failAfterTool = false;
      fix.worker.beforeTool = async request => { await writeSharedFile(request, 'reconciled.md', 'after'); };
      const secondTask = await fix.createTask('evidence-reconcile-second');
      const second = await fix.runner(fix.coordinator()).run(secondTask, { signal: new AbortController().signal, progress() {} });
      return { observed: `first=unknown; discard ok; second=${second.state}`, evidence: { secondTask, canonical: await readFile(canonicalPath(fix, 'reconciled.md'), 'utf8') } };
    });
  });
  const patchText = await readFile(patchFile, 'utf8');
  let patchApplies = false;
  try { execFileSync('git', ['apply', '--check', patchFile], { cwd: repoRoot, stdio: 'pipe' }); patchApplies = true; } catch { patchApplies = false; }
  const sourceFiles = ['src/control/task-workspace.ts', 'src/control/task-runner.ts', 'src/adapters/artifacts/shared-workspace.ts', 'src/adapters/artifacts/index.ts', 'src/adapters/artifacts/SHARED_WORKSPACE.md'];
  const fileHash = async (relative: string): Promise<{ path: string; sha256: string }> => ({ path: relative, sha256: createHash('sha256').update(await readFile(path.join(packageRoot, relative))).digest('hex') });
  let git: Record<string, unknown> = { head: null };
  try { git = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() }; } catch { /* non-git */ }
  const evidence = {
    schemaVersion: 1,
    slice: 'task-73',
    title: '可写共享工作区接入 Runtime/TaskRunner：prepare/publish/失败语义/锁/路径安全/审计',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'G1 offline integration (real temporary ControlStore/LocalArtifactStore/hard links; fake worker; no live host/model)',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    fingerprints: {
      source: { git, moduleFiles: await Promise.all(sourceFiles.map(fileHash)) },
      build: {
        buildCommand: 'npm run check (tsc --noEmit + node --import tsx --test tests/*.test.ts + tsc -p tsconfig.build.json + node --check client/index.js)',
        tsconfigBuildSha256: await fileHash('tsconfig.build.json').then(item => item.sha256),
        packageJsonSha256: await fileHash('package.json').then(item => item.sha256),
      },
      tests: { files: [{ path: 'tests/task-workspace-runtime.test.ts', sha256: await fileHash('tests/task-workspace-runtime.test.ts').then(item => item.sha256) }] },
    },
    integration: {
      patchPath: 'artifacts/dsh/tasks/runtime-task-workspace.diff',
      patchSha256: createHash('sha256').update(patchText).digest('hex'),
      patchApplies,
      runtime: 'RuntimeConfig.sharedWorkspaceRoot (trusted owner config) + RuntimeOptions.workspaceExpectedChanges/workspaceOwnerDecision (trusted plan projections) -> TaskWorkspaceCoordinator -> LocalTaskRunner 4th argument',
      indexTsChange: 'none required: RuntimeConfig/apply() already flow through the plugin entry; no client or model tool change',
    },
    hostKit: {
      description: 'Configure a temporary sharedRoot, run one synthetic TaskRunner task with the fake worker, inspect before/after manifest and publish receipt. No live host task is executed.',
      command: 'node --import tsx --test tests/task-workspace-runtime.test.ts',
      beforeManifestCase: 'audit-manifest-receipt',
      publishReceiptCase: 'success-prepare-publish',
    },
    boundaries: {
      liveHost: false, modelCalls: 0, realWorkspaceTouched: false, runtimeTsEdited: false,
      clientChanged: false, gitCommitMade: false, dependenciesInstalled: false,
      workerSharedFileTools: 'the fake worker writes the shared mirror directly; a real worker tool surface for shared-file writes is outside this slice',
    },
    summary: { total: cases.length, passed: cases.filter(item => item.pass).length, failed: cases.filter(item => !item.pass).length },
    cases,
    regeneration: { command: 'SHIYU_WRITE_EVIDENCE=1 node --import tsx --test tests/task-workspace-runtime.test.ts' },
  };
  let exists = true;
  try { await readFile(evidenceFile); } catch { exists = false; }
  if (process.env.SHIYU_WRITE_EVIDENCE === '1' || !exists) {
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  const persisted = JSON.parse(await readFile(evidenceFile, 'utf8')) as { summary: { total: number; failed: number }; integration: { patchApplies: boolean }; cases: { pass: boolean }[] };
  assert.equal(persisted.summary.failed, 0);
  assert.equal(persisted.summary.total, cases.length);
  assert.equal(persisted.cases.every(item => item.pass), true);
  assert.equal(persisted.integration.patchApplies, true);
}

test('evidence generator: runtime integration matrix and runtime patch are reproducible', async () => {
  await generateEvidence();
  assert.equal(await lstat(patchFile).then(() => true), true);
  const text = await readFile(evidenceFile, 'utf8');
  assert.ok(!text.includes('/tmp/'), 'evidence must not leak temporary paths');
  const persisted = JSON.parse(text) as { cases: { caseId: string }[]; boundaries: { liveHost: boolean } };
  for (const required of ['success-prepare-publish', 'no-shared-noop', 'worker-failure-no-publish', 'conflict-unknown', 'lock-busy', 'path-safety', 'audit-manifest-receipt']) {
    assert.ok(persisted.cases.some(item => item.caseId === required), `missing evidence case ${required}`);
  }
  assert.equal(persisted.boundaries.liveHost, false);
});
