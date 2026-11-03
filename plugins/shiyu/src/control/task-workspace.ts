/**
 * TaskRunner integration for the writable shared workspace (task-73).
 *
 * Trusted composition only:
 *  - `sharedRoot` comes from RuntimeConfig/owner configuration, never from task
 *    text or model output;
 *  - `expectedChanges` is a trusted projection of the accepted task plan /
 *    already-admitted parameters, never a worker/model argument;
 *  - an owner deletion decision is likewise an explicit trusted input.
 *
 * Lifecycle: begin (acquire lock + prepare mirror before the assignment claim)
 * -> worker runs with `cwd = <taskId>/task` -> on success publish (new files and
 * declared in-place changes, index update) -> task report/verification.
 * On worker/verification failure the task is marked unknown and the mirror is
 * retained for explicit reconciliation; nothing is published implicitly.
 * Without a configured shared root this coordinator is a strict no-op, keeping
 * the historical artifact-only task behavior byte-for-byte.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  SharedWorkspaceError,
  discardTaskWorkspace,
  prepareTaskWorkspace,
  publishTaskWorkspace,
  readTaskWorkspaceManifest,
  readTaskWorkspaceReport,
  taskWorkspaceLayout,
  type SharedWorkspaceManagerOptions,
  type TaskWorkspaceManifest,
  type TaskWorkspaceSession,
  type WorkspacePublishReport,
} from '../adapters/artifacts/shared-workspace.js';
import type { LocalArtifactStore } from '../adapters/artifacts/index.js';
import type { TaskExecutionPlan } from '../adapters/control-store/task-domain.js';

export const TASK_WORKSPACE_SCHEMA_VERSION = 1;

export const TASK_WORKSPACE_BUSY = 'TASK_WORKSPACE_BUSY' as const;
export const TASK_WORKSPACE_INTEGRATION_FAILED = 'TASK_WORKSPACE_INTEGRATION_FAILED' as const;
export const TASK_WORKSPACE_CONFLICT_UNKNOWN = 'TASK_WORKSPACE_CONFLICT_UNKNOWN' as const;
export const TASK_WORKSPACE_PATH_INVALID = 'TASK_WORKSPACE_PATH_INVALID' as const;

export class TaskWorkspaceBusyError extends Error {
  readonly code = TASK_WORKSPACE_BUSY;
  constructor(readonly taskId: string) {
    super(`Shared workspace is busy; task ${taskId} was not started and is not queued for automatic retry`);
    this.name = 'TaskWorkspaceBusyError';
  }
}

export class TaskWorkspaceIntegrationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TaskWorkspaceIntegrationError';
  }
}

export class TaskWorkspacePublishError extends Error {
  constructor(readonly code: string, readonly report: WorkspacePublishReport | null, message: string) {
    super(message);
    this.name = 'TaskWorkspacePublishError';
  }
}

/** Trusted plan projection of accepted workspace changes; never a model argument. */
export type TaskWorkspaceExpectedChanges = (plan: TaskExecutionPlan) => readonly string[];
/** Trusted explicit owner decision for canonical shared-file deletion. */
export type TaskWorkspaceOwnerDecision = (plan: TaskExecutionPlan) => {
  kind: 'delete-shared';
  paths: readonly string[];
  decisionId: string;
  decidedAt?: string;
} | undefined;

export interface TaskWorkspaceCoordinatorOptions {
  /** Runtime private workspaces root (`{dataDir}/workspaces`). */
  workspacesRoot: string;
  /** Configured writable shared workspace root; omitted = legacy no-shared behavior. */
  sharedRoot?: string;
  allowedSharedRoots?: readonly string[];
  snapshot?: boolean;
  expectedChanges?: TaskWorkspaceExpectedChanges;
  ownerDecision?: TaskWorkspaceOwnerDecision;
  now?: () => Date;
  maxFiles?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  lockLeaseMs?: number;
}

const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^?*<>|\u0000]{1,400}$/u;

const assertSafeChanges = (paths: readonly string[], label: string): string[] => {
  const result: string[] = [];
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !SAFE_RELATIVE.test(candidate)
      || candidate.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_PATH_INVALID, `${label} contains an unsafe relative path`);
    }
    result.push(candidate);
  }
  return result;
};

const assertRelativeSafe = (candidate: unknown, label: string): string => {
  if (typeof candidate !== 'string' || !SAFE_RELATIVE.test(candidate)
    || candidate.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_PATH_INVALID, `${label} must be a bounded POSIX relative path`);
  }
  return candidate;
};

const writeJsonExclusive = async (filename: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const text = JSON.stringify(value);
    await handle.writeFile(`${text}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, filename);
};

export interface TaskWorkspaceExecution {
  readonly taskId: string;
  /** True only when a shared root is configured and a mirror was prepared. */
  readonly shared: boolean;
  /** Worker cwd for shared tasks (`<taskId>/task`); null in the no-shared no-op. */
  readonly cwd: string | null;
  /**
   * Validate trusted plan-derived expected changes/owner decision before the
   * worker runs. Throws TASK_WORKSPACE_PATH_INVALID for unsafe paths.
   */
  validatePlan(plan: TaskExecutionPlan): void;
  /**
   * Publish after successful worker execution. Returns null in no-shared mode;
   * throws TaskWorkspacePublishError for unknown/blocked outcomes.
   */
  publish(plan: TaskExecutionPlan): Promise<WorkspacePublishReport | null>;
  /**
   * Write a failure marker. Before publish the mirror+lock are retained for
   * explicit reconciliation; after a published workspace the marker records
   * that no further mirror cleanup is pending.
   */
  fail(reason: string, evidence?: { published: boolean; report?: WorkspacePublishReport | null }): Promise<void>;
  /** Discard a prepared-but-not-executed workspace (mirror, lock, manifest). */
  abortBeforeWorker(reason: string): Promise<void>;
  /** Last publish/rollback receipt on disk, if any. */
  receipt(): Promise<WorkspacePublishReport | undefined>;
  /** Pre-task manifest on disk, if any. */
  manifest(): Promise<TaskWorkspaceManifest | undefined>;
}

class NoSharedExecution implements TaskWorkspaceExecution {
  constructor(readonly taskId: string) {}
  readonly shared = false;
  readonly cwd = null;
  validatePlan(): void { /* no workspace expectations apply */ }
  async publish(): Promise<null> { return null; }
  async fail(): Promise<void> { /* legacy behavior: nothing to retain */ }
  async abortBeforeWorker(): Promise<void> { /* nothing prepared */ }
  async receipt(): Promise<undefined> { return undefined; }
  async manifest(): Promise<undefined> { return undefined; }
}

class SharedExecution implements TaskWorkspaceExecution {
  readonly shared = true;
  private validated?: { expectedChanges: string[]; ownerDecision: ReturnType<TaskWorkspaceOwnerDecision> };
  constructor(
    readonly taskId: string,
    readonly cwd: string,
    private readonly session: TaskWorkspaceSession,
    private readonly options: TaskWorkspaceCoordinatorOptions,
    private readonly workspacesRoot: string,
    private readonly artifacts: LocalArtifactStore,
  ) {}

  private trustedPlanProjection(plan: TaskExecutionPlan): { expectedChanges: string[]; ownerDecision: ReturnType<TaskWorkspaceOwnerDecision> } {
    if (plan.taskId !== this.taskId) throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_INTEGRATION_FAILED, 'Plan task identity does not match the prepared workspace');
    const expectedChanges = assertSafeChanges(this.options.expectedChanges?.(plan) ?? [], 'expectedChanges');
    const decision = this.options.ownerDecision?.(plan);
    let ownerDecision: ReturnType<TaskWorkspaceOwnerDecision>;
    if (decision !== undefined) {
      if (decision.kind !== 'delete-shared' || typeof decision.decisionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(decision.decisionId)) {
        throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_PATH_INVALID, 'ownerDecision must be an explicit delete-shared decision with a bounded decisionId');
      }
      ownerDecision = { kind: 'delete-shared', decisionId: decision.decisionId, paths: assertSafeChanges(decision.paths, 'ownerDecision.paths'), ...(decision.decidedAt ? { decidedAt: decision.decidedAt } : {}) };
    }
    return { expectedChanges, ownerDecision };
  }

  validatePlan(plan: TaskExecutionPlan): void { this.validated = this.trustedPlanProjection(plan); }

  async publish(plan: TaskExecutionPlan): Promise<WorkspacePublishReport> {
    const projection = this.validated ?? this.trustedPlanProjection(plan);
    this.validated = projection;
    if (!this.artifacts.root) throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_INTEGRATION_FAILED, 'Artifact store is unavailable');
    let report: WorkspacePublishReport;
    try {
      report = await publishTaskWorkspace({
        workspacesRoot: this.workspacesRoot,
        sharedRoot: this.options.sharedRoot,
        ...(this.options.allowedSharedRoots ? { allowedSharedRoots: this.options.allowedSharedRoots } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
        taskId: this.taskId,
        expectedChanges: projection.expectedChanges,
        ...(projection.ownerDecision ? { ownerDecision: projection.ownerDecision } : {}),
      });
    } catch (error) {
      if (error instanceof SharedWorkspaceError) {
        throw new TaskWorkspacePublishError(error.code, null, `Shared workspace publish failed: ${error.message}`);
      }
      throw error;
    }
    if (report.status === 'unknown' || report.status === 'blocked') {
      throw new TaskWorkspacePublishError(report.code ?? TASK_WORKSPACE_CONFLICT_UNKNOWN, report,
        `Shared workspace publish is ${report.status}; task must remain unknown until the owner reconciles the conflicts`);
    }
    return report;
  }

  async fail(reason: string, evidence?: { published: boolean; report?: WorkspacePublishReport | null }): Promise<void> {
    const layout = taskWorkspaceLayout(this.workspacesRoot, this.taskId);
    const published = evidence?.published === true;
    const report = evidence?.report ?? null;
    const mirrorRetained = published ? false : (report?.mirrorRetained ?? true);
    const lockRetained = published ? false : !(report?.lockReleased ?? false);
    await writeJsonExclusive(path.join(layout.taskRoot, '.workspace-failure.json'), {
      schemaVersion: TASK_WORKSPACE_SCHEMA_VERSION,
      taskId: this.taskId,
      at: (this.options.now?.() ?? new Date()).toISOString(),
      status: 'unknown-or-reconcile',
      reason: String(reason).slice(0, 500),
      mirrorRetained,
      lockRetained,
      published,
      ...(report ? { publishStatus: report.status, conflictCodes: report.conflicts.map((conflict) => conflict.kind) } : {}),
      note: published
        ? 'Workspace changes were published before a later task failure; the task remains unknown and its publish receipt is retained.'
        : 'Worker/verification did not complete; the task mirror is retained for explicit reconciliation and nothing was published.',
    }).catch(() => undefined);
  }

  async abortBeforeWorker(reason: string): Promise<void> {
    try {
      await discardTaskWorkspace({
        workspacesRoot: this.workspacesRoot,
        ...(this.options.sharedRoot ? { sharedRoot: this.options.sharedRoot } : {}),
        ...(this.options.allowedSharedRoots ? { allowedSharedRoots: this.options.allowedSharedRoots } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
        taskId: this.taskId,
      });
    } catch { /* Best effort; the task was not executed and no canonical change was made. */ }
    void reason;
  }

  async receipt(): Promise<WorkspacePublishReport | undefined> { return readTaskWorkspaceReport(this.workspacesRoot, this.taskId); }
  async manifest(): Promise<TaskWorkspaceManifest | undefined> { return readTaskWorkspaceManifest(this.workspacesRoot, this.taskId); }
}

/**
 * Trusted coordinator used by LocalTaskRunner. Construction creates/reads
 * nothing: the shared root is validated and the mirror prepared only when a
 * task actually starts.
 */
export class TaskWorkspaceCoordinator {
  private readonly workspacesRoot: string;
  private readonly options: TaskWorkspaceCoordinatorOptions;
  constructor(options: TaskWorkspaceCoordinatorOptions, private readonly artifacts: LocalArtifactStore) {
    if (!options || typeof options !== 'object') throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_INTEGRATION_FAILED, 'Task workspace options are required');
    if (typeof options.workspacesRoot !== 'string' || !path.isAbsolute(options.workspacesRoot)) {
      throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_INTEGRATION_FAILED, 'Task workspaces root must be an absolute path');
    }
    if (options.sharedRoot !== undefined && (typeof options.sharedRoot !== 'string' || !path.isAbsolute(options.sharedRoot))) {
      throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_INTEGRATION_FAILED, 'Configured shared workspace root must be an absolute path');
    }
    if (options.expectedChanges !== undefined && typeof options.expectedChanges !== 'function') {
      throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_INTEGRATION_FAILED, 'expectedChanges must be a trusted plan projection function');
    }
    if (options.ownerDecision !== undefined && typeof options.ownerDecision !== 'function') {
      throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_INTEGRATION_FAILED, 'ownerDecision must be a trusted plan projection function');
    }
    this.workspacesRoot = path.resolve(options.workspacesRoot);
    this.options = {
      ...options,
      ...(options.allowedSharedRoots ? { allowedSharedRoots: [...options.allowedSharedRoots] } : {}),
    };
  }

  get configured(): boolean { return this.options.sharedRoot !== undefined; }

  /**
   * Prepare before the assignment claim. Lock-busy is a typed, non-retryable
   * error: the task stays untouched in the queue instead of being silently
   * queued behind another task.
   */
  async begin(taskId: string): Promise<TaskWorkspaceExecution> {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(taskId)) {
      throw new TaskWorkspaceIntegrationError(TASK_WORKSPACE_PATH_INVALID, 'taskId must be a bounded identifier');
    }
    if (this.options.sharedRoot === undefined) return new NoSharedExecution(taskId);
    try {
      const session = await prepareTaskWorkspace({
        workspacesRoot: this.workspacesRoot,
        sharedRoot: this.options.sharedRoot,
        ...(this.options.allowedSharedRoots ? { allowedSharedRoots: this.options.allowedSharedRoots } : {}),
        ...(this.options.snapshot !== undefined ? { snapshot: this.options.snapshot } : {}),
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.maxFiles !== undefined ? { maxFiles: this.options.maxFiles } : {}),
        ...(this.options.maxDepth !== undefined ? { maxDepth: this.options.maxDepth } : {}),
        ...(this.options.maxFileBytes !== undefined ? { maxFileBytes: this.options.maxFileBytes } : {}),
        ...(this.options.lockLeaseMs !== undefined ? { lockLeaseMs: this.options.lockLeaseMs } : {}),
        taskId,
      });
      if (!session.sharedDir) return new NoSharedExecution(taskId);
      return new SharedExecution(taskId, session.taskDir, session, this.options, this.workspacesRoot, this.artifacts);
    } catch (error) {
      if (error instanceof SharedWorkspaceError) {
        if (error.code === 'WORKSPACE_LOCKED') throw new TaskWorkspaceBusyError(taskId);
        throw new TaskWorkspaceIntegrationError(error.code, `Shared workspace preparation failed: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  /** Explicit reconciliation: remove only task-side mirror links/lock; canonical files stay. */
  async discard(taskId: string): Promise<{ mirrorRemoved: boolean; lockReleased: boolean }> {
    if (this.options.sharedRoot === undefined) return { mirrorRemoved: false, lockReleased: false };
    return discardTaskWorkspace({
      workspacesRoot: this.workspacesRoot,
      sharedRoot: this.options.sharedRoot,
      ...(this.options.allowedSharedRoots ? { allowedSharedRoots: this.options.allowedSharedRoots } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      taskId,
    });
  }

  async receipt(taskId: string): Promise<WorkspacePublishReport | undefined> {
    return readTaskWorkspaceReport(this.workspacesRoot, taskId);
  }

  async manifest(taskId: string): Promise<TaskWorkspaceManifest | undefined> {
    return readTaskWorkspaceManifest(this.workspacesRoot, taskId);
  }

  async failedMarker(taskId: string): Promise<{ status: string; reason: string; mirrorRetained: boolean } | undefined> {
    try {
      const layout = taskWorkspaceLayout(this.workspacesRoot, taskId);
      const raw = JSON.parse(await readFile(path.join(layout.taskRoot, '.workspace-failure.json'), 'utf8')) as unknown;
      if (raw && typeof raw === 'object') {
        const value = raw as Record<string, unknown>;
        if (typeof value.status === 'string' && typeof value.reason === 'string') return { status: value.status, reason: value.reason, mirrorRetained: value.mirrorRetained === true };
      }
      return undefined;
    } catch { return undefined; }
  }
}

/** Test/composition helper: does this directory look like a managed task workspace root? */
export const isTaskWorkspacePrepared = async (workspacesRoot: string, taskId: string): Promise<boolean> => {
  const layout = taskWorkspaceLayout(workspacesRoot, taskId);
  try { return (await lstat(layout.manifestFile)).isFile(); } catch { return false; }
};

export type { TaskExecutionPlan, TaskWorkspaceManifest, WorkspacePublishReport };
