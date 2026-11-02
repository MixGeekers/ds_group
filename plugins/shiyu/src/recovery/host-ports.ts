/**
 * H5b Runtime composition ports for the offline checkpoint module.
 *
 * These adapters wire the *existing* host resources into the H5-B1 capture
 * service without changing the live data root:
 *  - control: the real `{dataDir}/control/events.sqlite`, backed up with
 *    `node:sqlite` `backup`; read-only precheck facts come from the existing
 *    ControlStore worker commands, never from a second writer;
 *  - Goal Sessions: control GoalBindings from the ControlStore; the exact
 *    native log path must come from an injected resolver (candidate:
 *    the installed JSONL persistence diagnostic `resolveCurrentLog`, which is
 *    NOT part of the provider-neutral public contract) — paths are never
 *    guessed or joined here;
 *  - memory: the managed Ombre backend has no public export/archive tool in
 *    this deployment, so the production port is explicitly unavailable;
 *  - shared objects: a read-only, bounded inventory/hash of
 *    `{dataDir}/workspaces` (observation only; objects are packed only when
 *    the control/memory components reference them).
 *
 * The composition never triggers on a GET, never retries, never pauses or
 * resumes the runtime by itself and never writes inside the live data root:
 * the caller must supply an explicit staging root outside it.
 */
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, statfs } from 'node:fs/promises';
import path from 'node:path';
import { RecoveryError } from './errors.js';
import {
  assertSafeRelativeRef,
  canonicalJson,
  ensureDir,
  hashPath,
  sha256,
} from './files.js';
import {
  assertValidGenerationIdentity,
  assertValidRuntimeManifest,
} from './schema.js';
import { CheckpointCaptureService } from './capture.js';
import type { CaptureFaultInjection, CaptureResult, CaptureServiceOptions } from './capture.js';
import { deriveSeqChain, readBundleManifest } from './verify.js';
import type {
  CapacityProbe,
  Clock,
  ControlSourceLease,
  ControlSourcePort,
  GoalSessionCapture,
  GoalSessionPort,
  GoalSessionSnapshot,
  MemoryExportPort,
  MemoryExportRequest,
  MemoryExportResult,
  SharedObjectPort,
  SharedObjectRead,
} from './ports.js';
import type {
  BackupBundle,
  GenerationIdentity,
  GoalActivation,
  GoalSessionExclusion,
  LastGoodPointer,
  NativeGoalPhase,
  ProjectionDefinition,
  RuntimeManifest,
  WorkspaceInventory,
  WorkspaceInventoryFile,
} from './types.js';

/* ------------------------------------------------------------------------------------------------
 * Narrow structural seams (kept independent from runtime.ts to avoid cycles)
 * ---------------------------------------------------------------------------------------------- */

/** Subset of the existing ControlStore worker command surface used here. */
export interface ControlStoreRequestPort {
  request(command: string, args?: unknown): Promise<unknown>;
}

export interface HostControlFactsPreview {
  commitSeq: number;
  stateVersion: number;
  observedAt: string;
}

export interface HostControlSourceOptions {
  /** Live data root; only `{dataDir}/control/events.sqlite` is read. */
  dataDir: string;
  /** Existing ControlStore instance used for read-only facts. */
  controlStore: ControlStoreRequestPort;
  generation: GenerationIdentity;
  runtimeManifest: RuntimeManifest;
  quiescenceEvidence: string;
  rootId?: string;
  objectRefs?: readonly string[];
  controlDatabaseRelativePath?: string;
  now?: () => Date;
}

const INSIDE = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${path.sep}`);

/** Opaque root identity: a hash of the resolved data root, never the raw path. */
export const computeDataRootId = (dataDir: string): string => sha256(`shiyu-data-root:v1:${path.resolve(dataDir)}`);

/** Opaque workspace root identity for the read-only inventory. */
export const computeWorkspaceRootId = (workspaceRoot: string): string => sha256(`shiyu-workspaces:v1:${path.resolve(workspaceRoot)}`);

const nowIso = (now?: () => Date): string => (now?.() ?? new Date()).toISOString();

/** Canonicalize a path that may not exist yet by resolving its nearest existing ancestor. */
const canonicalPendingPath = async (target: string): Promise<string> => {
  const resolved = path.resolve(target);
  let current = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
};

const assertAbsoluteExistingDirectory = async (target: string, label: string): Promise<string> => {
  if (!path.isAbsolute(target)) throw new RecoveryError('INVALID_SCHEMA', `${label} must be an absolute path`);
  const info = await lstat(target).catch(() => undefined);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', `${label} is not a regular directory`);
  }
  return realpath(target);
};

const assertRegularFileInside = async (root: string, filename: string, label: string): Promise<string> => {
  const resolvedRoot = await realpath(root);
  const info = await lstat(filename).catch(() => undefined);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', `${label} is not a regular file`);
  const resolved = await realpath(filename);
  if (!INSIDE(resolved, resolvedRoot) || resolved === resolvedRoot) {
    throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', `${label} escapes the live data root through a symlink or mount point`);
  }
  return resolved;
};

/** Read-only facts from the existing ControlStore, never from a new DB handle in the host thread. */
const readLiveControlFacts = async (store: ControlStoreRequestPort, now: () => Date): Promise<HostControlFactsPreview> => {
  let watermark: unknown;
  let published: unknown;
  try {
    watermark = await store.request('control.watermark', {});
    published = await store.request('view.state', {});
  } catch (error) {
    throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', `ControlStore read-only facts are unavailable: ${(error as Error).message}`, 'control');
  }
  const commitSeq = (watermark as { commitSeq?: unknown } | undefined)?.commitSeq;
  if (typeof commitSeq !== 'number' || !Number.isSafeInteger(commitSeq) || commitSeq < 0) {
    throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', 'ControlStore returned an invalid commit watermark', 'control');
  }
  const stateVersion = (published as { stateVersion?: unknown } | null | undefined)?.stateVersion;
  if (typeof stateVersion !== 'number' || !Number.isSafeInteger(stateVersion) || stateVersion < 1) {
    throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', 'ControlStore returned no published state version', 'control');
  }
  return { commitSeq, stateVersion, observedAt: nowIso(now) };
};

/**
 * Production control source. The lease exposes the live DB path plus a
 * monotonic precheck of facts read through the existing ControlStore API.
 * `release()` has nothing to undo: capture only opened read-only handles.
 */
export const createHostControlSourcePort = (options: HostControlSourceOptions): ControlSourcePort => {
  const dataDir = path.resolve(options.dataDir);
  const rootId = options.rootId ?? computeDataRootId(dataDir);
  const generation = assertValidGenerationIdentity(options.generation);
  const runtimeManifest = assertValidRuntimeManifest(options.runtimeManifest);
  if (typeof options.quiescenceEvidence !== 'string' || !options.quiescenceEvidence.trim()) {
    throw new RecoveryError('INVALID_SCHEMA', 'Host control source requires bounded quiescence evidence');
  }
  if (typeof rootId !== 'string' || !/^[a-f0-9]{64}$/.test(rootId)) throw new RecoveryError('INVALID_SCHEMA', 'Host root identity must be a sha256 hash');
  const relative = options.controlDatabaseRelativePath ?? 'control/events.sqlite';
  assertSafeRelativeRef(relative, 'control database path');
  const now = options.now;
  return {
    async acquire(): Promise<ControlSourceLease> {
      const resolvedRoot = await assertAbsoluteExistingDirectory(dataDir, 'Live data root');
      const databasePath = await assertRegularFileInside(resolvedRoot, path.join(resolvedRoot, ...relative.split('/')), 'Control database');
      const liveFacts = await readLiveControlFacts(options.controlStore, now ?? (() => new Date()));
      return {
        databasePath,
        rootId,
        generation,
        runtimeManifest,
        quiescenceEvidence: options.quiescenceEvidence,
        liveFacts,
        objectRefs: [...(options.objectRefs ?? [])],
        release: async () => undefined,
      };
    },
  };
};

/* ------------------------------------------------------------------------------------------------
 * Goal Session host adapter
 * ---------------------------------------------------------------------------------------------- */

/**
 * Result of resolving the exact native Session log for one session. The
 * resolver is the only authority for the path; this module never derives it
 * from cwd, session id or the persistence root.
 */
export interface HostGoalSessionLog {
  /** Exact absolute path reported by the host API. */
  path: string;
  format: 'jsonl-plain' | 'zstd' | 'unknown';
}

export interface HostGoalSessionResolver {
  /** `jsonl-internal-diagnostic` is a candidate, non-contract source (see README). */
  provenance: 'injected' | 'jsonl-internal-diagnostic';
  resolve(sessionId: string, signal?: AbortSignal): Promise<HostGoalSessionLog | undefined>;
}

export interface HostNativeGoalState {
  goalRef: { id: string; revision: number };
  phase: NativeGoalPhase;
  activation: GoalActivation;
}

export interface HostProjectionExport extends ProjectionDefinition {
  definition: Uint8Array;
  config: Uint8Array;
}

export interface HostGoalSessionSourceOptions {
  controlStore: ControlStoreRequestPort;
  runtimeManifest: RuntimeManifest;
  ownerId?: string;
  scope?: string;
  resolver?: HostGoalSessionResolver;
  nativeState?: (sessionId: string) => Promise<HostNativeGoalState | undefined>;
  flushSession?: (sessionId: string) => Promise<boolean>;
  projection?: HostProjectionExport;
  plugin?: { dshVersion: string; shiyuVersion: string };
  quiescenceEvidence?: string;
  now?: () => Date;
  maxLogBytes?: number;
  readFile?: (absolutePath: string) => Promise<Buffer>;
}

/** Required host capabilities for a ready Goal Session component (reported when unavailable). */
export const HOST_GOAL_SESSION_REQUIRED_SCOPE: readonly string[] = Object.freeze([
  'public read-only API that returns the exact durable log path for a native Session (the installed JSONL backend resolveCurrentLog is an internal diagnostic, not a provider-neutral contract)',
  'public read-only native Goal state (GoalRef revision, phase, activation/armed) without creating or resuming an Agent',
  'host durability barrier for the exact session (sessions.flush or an equivalent acknowledged flush)',
  'exportable projection definition + configuration digest for the log format, or an approved offline projection/export adapter',
  'a host-supported offline-decodable log format: plain JSONL, or a public read/decompress API (default zstd frames are not independently verifiable offline)',
]);

/**
 * Candidate resolver over the installed JSONL persistence backend's
 * diagnostic `resolveCurrentLog`. This method exists on the concrete backend
 * class but not in the provider-neutral session-persistence contract, so its
 * provenance is recorded as `jsonl-internal-diagnostic` and callers must treat
 * it as a candidate awaiting a public API.
 */
export const detectSessionPersistenceLogResolver = (
  persistence: unknown,
  options: { format?: 'jsonl-plain' | 'zstd' | 'unknown' } = {},
): HostGoalSessionResolver | null => {
  if (!persistence || typeof persistence !== 'object') return null;
  const candidate = persistence as { resolveCurrentLog?: unknown; compression?: unknown; root?: unknown };
  if (typeof candidate.resolveCurrentLog !== 'function') return null;
  const format = options.format ?? (candidate.compression === 'none' ? 'jsonl-plain' : 'zstd');
  return {
    provenance: 'jsonl-internal-diagnostic',
    async resolve(sessionId: string, signal?: AbortSignal): Promise<HostGoalSessionLog | undefined> {
      const resolved = await (candidate.resolveCurrentLog as (id: string, signal?: AbortSignal) => Promise<unknown>)(sessionId, signal);
      if (resolved === undefined || resolved === null) return undefined;
      if (typeof resolved !== 'string' || !path.isAbsolute(resolved)) {
        throw new RecoveryError('INVALID_SCHEMA', 'Session persistence resolver returned an invalid log path', 'dsh-goal-sessions');
      }
      return { path: resolved, format };
    },
  };
};

const buildGoalSessionSnapshot = async (
  options: {
    binding: { goalId: string; sessionId: string; ownerId: string; scope: string; cwd: string; metadataVersion: number; completionCriteriaHash: string; goalRef: { id: string; revision: number } | null };
    resolver: HostGoalSessionResolver;
    nativeState: NonNullable<HostGoalSessionSourceOptions['nativeState']>;
    flushSession: NonNullable<HostGoalSessionSourceOptions['flushSession']>;
    projection: HostProjectionExport;
    plugin: { dshVersion: string; shiyuVersion: string };
    now: () => Date;
    readFile: (absolutePath: string) => Promise<Buffer>;
    maxLogBytes: number;
    signal?: AbortSignal;
  },
): Promise<GoalSessionSnapshot> => {
  const { binding } = options;
  if (!binding.goalRef) throw new RecoveryError('GOAL_SESSION_EXPORT_UNAVAILABLE', `Goal binding ${binding.goalId} has no native GoalRef`, 'dsh-goal-sessions');
  const native = await options.nativeState(binding.sessionId);
  if (!native) {
    throw new RecoveryError('GOAL_SESSION_EXPORT_UNAVAILABLE',
      `Native Goal state for session ${binding.sessionId} is not available through a public read-only API`, 'dsh-goal-sessions');
  }
  if (native.goalRef.id !== binding.goalRef.id || native.goalRef.revision !== binding.goalRef.revision) {
    throw new RecoveryError('GOAL_REF_MISMATCH', `Native GoalRef for ${binding.goalId} does not match the control binding`, 'dsh-goal-sessions');
  }
  const resolved = await options.resolver.resolve(binding.sessionId, options.signal);
  if (!resolved) {
    throw new RecoveryError('MISSING_GOAL_SESSION', `No authoritative Session log is available for session ${binding.sessionId}`, 'dsh-goal-sessions');
  }
  if (resolved.format !== 'jsonl-plain') {
    throw new RecoveryError('LOG_FORMAT_NOT_OFFLINE_VERIFIABLE',
      `Session log for ${binding.sessionId} is ${resolved.format}; the H5b slice cannot independently verify this format offline`, 'dsh-goal-sessions');
  }
  if (!path.isAbsolute(resolved.path) || resolved.path.includes('\0')) {
    throw new RecoveryError('INVALID_SCHEMA', 'Goal Session resolver must return an absolute log path', 'dsh-goal-sessions');
  }
  const info = await lstat(resolved.path).catch(() => undefined);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new RecoveryError('MISSING_GOAL_SESSION', `Resolved Session log is not a regular file for ${binding.sessionId}`, 'dsh-goal-sessions');
  }
  if (info.size < 1 || info.size > options.maxLogBytes) {
    throw new RecoveryError('MISSING_LOG_TAIL', `Session log size is outside the bounded capture range for ${binding.sessionId}`, 'dsh-goal-sessions');
  }
  const bytes = await options.readFile(resolved.path);
  if (bytes.byteLength !== info.size) throw new RecoveryError('BYTES_MISMATCH', 'Session log changed size while being read', 'dsh-goal-sessions');
  const digest = sha256(bytes);
  const derived = deriveSeqChain(bytes);
  if (derived.goalState === null
    || derived.goalState.id !== native.goalRef.id || derived.goalState.revision !== native.goalRef.revision
    || derived.goalState.phase !== native.phase || derived.goalState.activation !== native.activation) {
    throw new RecoveryError('GOAL_REF_MISMATCH', `Session log tail does not match the native Goal state for ${binding.sessionId}`, 'dsh-goal-sessions');
  }
  const flushed = await options.flushSession(binding.sessionId);
  if (flushed !== true) {
    throw new RecoveryError('MISSING_LOG_TAIL', `Host flush did not acknowledge durability for ${binding.sessionId}`, 'dsh-goal-sessions');
  }
  const observedAt = nowIso(options.now);
  const tail = { kind: 'jsonl-seq-v1' as const, bytes: bytes.byteLength, sha256: digest, lastSequence: derived.lastSequence };
  return {
    goalId: binding.goalId,
    sessionId: binding.sessionId,
    goalRef: { id: native.goalRef.id, revision: native.goalRef.revision },
    phase: native.phase,
    activation: native.activation,
    binding: {
      ownerId: binding.ownerId,
      scope: binding.scope,
      cwd: binding.cwd,
      metadataVersion: binding.metadataVersion,
      completionCriteriaHash: binding.completionCriteriaHash,
    },
    logPath: resolved.path,
    bytes,
    expected: { bytes: bytes.byteLength, sha256: digest },
    logFormat: 'jsonl-seq-v1',
    durableTail: tail,
    flush: { kind: 'host-flush', acknowledged: true, durableTail: tail, observedAt },
    projection: {
      projectionId: options.projection.projectionId,
      schemaVersion: options.projection.schemaVersion,
      minimumReaderVersion: options.projection.minimumReaderVersion,
      digest: options.projection.digest,
      configSha256: options.projection.configSha256,
    },
    projectionDefinition: options.projection.definition,
    projectionConfig: options.projection.config,
    plugin: options.plugin,
  };
};

const asGoalBindings = (value: unknown): {
  goalId: string; sessionId: string; ownerId: string; scope: string; cwd: string; completionCriteriaHash: string;
  metadataVersion: number; goalRef: { id: string; revision: number } | null; receiptStatus: string | null;
}[] => {
  if (!Array.isArray(value)) throw new RecoveryError('GOAL_SESSION_EXPORT_UNAVAILABLE', 'ControlStore goal binding response is not an array', 'dsh-goal-sessions');
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RecoveryError('INVALID_SCHEMA', 'ControlStore returned an invalid GoalBinding', 'dsh-goal-sessions');
    const binding = item as Record<string, unknown>;
    if (typeof binding.goalId !== 'string' || typeof binding.sessionId !== 'string' || typeof binding.ownerId !== 'string'
      || typeof binding.scope !== 'string' || typeof binding.cwd !== 'string' || typeof binding.completionCriteriaHash !== 'string'
      || typeof binding.metadataVersion !== 'number') {
      throw new RecoveryError('INVALID_SCHEMA', 'ControlStore returned an incomplete GoalBinding', 'dsh-goal-sessions');
    }
    const goalRef = binding.goalRef === undefined || binding.goalRef === null ? null
      : (() => {
        const ref = binding.goalRef as Record<string, unknown>;
        if (typeof ref.id !== 'string' || typeof ref.revision !== 'number') throw new RecoveryError('INVALID_SCHEMA', 'ControlStore returned an invalid GoalRef', 'dsh-goal-sessions');
        return { id: ref.id, revision: ref.revision };
      })();
    const receipt = binding.receipt && typeof binding.receipt === 'object' && !Array.isArray(binding.receipt)
      ? (binding.receipt as Record<string, unknown>).status
      : undefined;
    result.push({
      goalId: binding.goalId, sessionId: binding.sessionId, ownerId: binding.ownerId, scope: binding.scope,
      cwd: binding.cwd, completionCriteriaHash: binding.completionCriteriaHash, metadataVersion: binding.metadataVersion,
      goalRef, receiptStatus: typeof receipt === 'string' ? receipt : null,
    });
  }
  return result;
};

/**
 * Goal Session source built from control GoalBindings plus explicitly injected
 * native state / path resolver / flush / projection seams. Bindings without a
 * native GoalRef are recorded as explicit exclusions; every other binding is
 * either captured with verified bytes/tail or the whole component fails closed.
 */
export const createHostGoalSessionPort = (options: HostGoalSessionSourceOptions): GoalSessionPort => {
  const ownerId = options.ownerId ?? 'local-owner';
  const scope = options.scope ?? 'local-owner';
  const now = options.now ?? (() => new Date());
  const read = options.readFile ?? ((absolutePath: string) => readFile(absolutePath));
  const maxLogBytes = options.maxLogBytes ?? 64 * 1024 * 1024;
  const plugin = options.plugin ?? { dshVersion: options.runtimeManifest.dshVersion, shiyuVersion: '0.1.0' };
  return {
    async prepareCapture(goalIds: readonly string[]): Promise<GoalSessionCapture> {
      const requested = new Set(goalIds);
      const bindings = asGoalBindings(await options.controlStore.request('goal.binding.list', { ownerId, scope }));
      const relevant = bindings.filter((binding) => requested.has(binding.goalId));
      for (const goalId of goalIds) {
        if (!relevant.some((binding) => binding.goalId === goalId)) {
          throw new RecoveryError('MISSING_GOAL_SESSION', `ControlStore did not return the GoalBinding ${goalId}`, 'dsh-goal-sessions');
        }
      }
      const excluded: GoalSessionExclusion[] = relevant
        .filter((binding) => binding.goalRef === null)
        .map((binding) => ({
          goalId: binding.goalId,
          sessionId: binding.sessionId,
          reasonCode: 'NO_NATIVE_GOAL_REF',
          detail: 'Goal binding has no native GoalRef yet; there is no authoritative Goal Session log to capture',
        }));
      const active = relevant.filter((binding) => binding.goalRef !== null);
      if (active.length > 0) {
        const missing: string[] = [];
        if (!options.resolver) missing.push('exact Session log path resolver');
        if (!options.nativeState) missing.push('read-only native Goal state (phase/activation)');
        if (!options.flushSession) missing.push('acknowledged Session flush');
        const projectionMissing = !options.projection;
        if (missing.length > 0) {
          throw new RecoveryError('GOAL_SESSION_EXPORT_UNAVAILABLE',
            `Required host capabilities are unavailable: ${missing.join('; ')}`, 'dsh-goal-sessions');
        }
        if (projectionMissing) {
          throw new RecoveryError('PROJECTION_EXPORT_UNAVAILABLE',
            'No exportable projection definition/configuration is available for the native Goal Session log', 'dsh-goal-sessions');
        }
      }
      const sessions: GoalSessionSnapshot[] = [];
      for (const binding of active) {
        sessions.push(await buildGoalSessionSnapshot({
          binding: { ...binding, goalRef: binding.goalRef! },
          resolver: options.resolver!,
          nativeState: options.nativeState!,
          flushSession: options.flushSession!,
          projection: options.projection!,
          plugin,
          now,
          readFile: read,
          maxLogBytes,
        }));
      }
      sessions.sort((a, b) => a.goalId.localeCompare(b.goalId));
      return {
        quiescenceEvidence: options.quiescenceEvidence ?? 'host: goal writers flushed through sessions.flush; no pause claim',
        capturedAt: nowIso(now),
        sessions,
        excluded,
      };
    },
  };
};

/* ------------------------------------------------------------------------------------------------
 * Memory host adapter (explicitly unavailable in this deployment)
 * ---------------------------------------------------------------------------------------------- */

export const HOST_MEMORY_REQUIRED_SCOPE: readonly string[] = Object.freeze([
  'an approved public export/archive API for the managed Ombre memory backend that returns a component manifest, reference closure and deletion state',
  'or an approved offline export adapter with the same manifest/hash/closure semantics, without writing the live managed vault',
]);

export interface HostMemoryExportOptions {
  /** Test/composition seam: a full MemoryExportPort implementation. Production leaves this unset. */
  exportImpl?: MemoryExportPort['export'];
  reasonCode?: string;
  detail?: string;
}

/** Production memory port: fails closed with the precise missing capability. */
export const createHostMemoryExportPort = (options: HostMemoryExportOptions = {}): MemoryExportPort => ({
  async export(request: MemoryExportRequest): Promise<MemoryExportResult> {
    if (options.exportImpl) return options.exportImpl(request);
    throw new RecoveryError('MEMORY_EXPORT_UNAVAILABLE',
      options.detail ?? 'The managed Ombre backend exposes no public export/archive tool in this pinned deployment; a Bundle cannot be ready until an approved export adapter exists',
      'memory');
  },
});

/* ------------------------------------------------------------------------------------------------
 * Shared object / workspace inventory host adapter
 * ---------------------------------------------------------------------------------------------- */

export interface HostWorkspaceObjectOptions {
  dataDir: string;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
  readFile?: (absolutePath: string) => Promise<Buffer>;
}

export interface HostWorkspaceObjectPort extends SharedObjectPort {
  inventory(): Promise<WorkspaceInventory>;
}

const objectIdFor = (relativePath: string): string => `ws-${sha256(relativePath).slice(0, 40)}`;

/**
 * Read-only observation over `{dataDir}/workspaces`. The inventory is bounded,
 * rejects symlinks and path escapes, and is recorded as evidence only; object
 * bytes are read lazily and are packed only when the control/memory components
 * reference an object id.
 */
export const createHostWorkspaceObjectPort = async (options: HostWorkspaceObjectOptions): Promise<HostWorkspaceObjectPort> => {
  const dataDir = path.resolve(options.dataDir);
  const workspaceRoot = path.join(dataDir, 'workspaces');
  const resolvedRoot = await assertAbsoluteExistingDirectory(workspaceRoot, 'Workspace root');
  const maxFiles = options.maxFiles ?? 2000;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  const reader = options.readFile ?? ((absolutePath: string) => readFile(absolutePath));
  const files: WorkspaceInventoryFile[] = [];
  const byId = new Map<string, string>();
  let excludedCount = 0;
  let total = 0;
  let truncated = false;
  const walk = async (relative: string): Promise<void> => {
    if (truncated) return;
    const directory = relative ? path.join(resolvedRoot, ...relative.split('/')) : resolvedRoot;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { excludedCount += 1; continue; }
      if (entry.isDirectory()) { await walk(childRelative); continue; }
      if (!entry.isFile()) { excludedCount += 1; continue; }
      if (files.length >= maxFiles) { truncated = true; return; }
      const absolute = path.join(resolvedRoot, ...childRelative.split('/'));
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile() || info.size > maxFileBytes) { excludedCount += 1; continue; }
      if (total + info.size > maxTotalBytes) { truncated = true; return; }
      const bytes = await reader(absolute);
      if (bytes.byteLength !== info.size) throw new RecoveryError('WORKSPACE_INVENTORY_UNAVAILABLE', `Workspace file changed while being observed: ${childRelative}`, 'shared-objects');
      total += bytes.byteLength;
      files.push({ relativePath: childRelative, bytes: bytes.byteLength, sha256: sha256(bytes) });
      byId.set(objectIdFor(childRelative), childRelative);
      assertSafeRelativeRef(childRelative, 'workspace inventory path');
    }
  };
  await walk('');
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const inventory: WorkspaceInventory = {
    rootId: computeWorkspaceRootId(resolvedRoot),
    files,
    totalBytes: total,
    aggregateSha256: sha256(canonicalJson(files)),
    truncated,
    excludedCount,
  };
  return {
    async read(objectId: string): Promise<SharedObjectRead | undefined> {
      if (typeof objectId !== 'string' || !/^ws-[a-f0-9]{40}$/.test(objectId)) return undefined;
      const relative = byId.get(objectId);
      if (!relative) return undefined;
      const absolute = path.join(resolvedRoot, ...relative.split('/'));
      const info = await lstat(absolute).catch(() => undefined);
      if (!info || !info.isFile() || info.isSymbolicLink()) return undefined;
      const bytes = await reader(absolute);
      const entry = files.find((file) => file.relativePath === relative)!;
      return { objectId, bytes, expected: { bytes: entry.bytes, sha256: entry.sha256 } };
    },
    async inventory(): Promise<WorkspaceInventory> { return structuredClone(inventory); },
  };
};

/* ------------------------------------------------------------------------------------------------
 * Composition entry
 * ---------------------------------------------------------------------------------------------- */

export interface HostComponentAvailability {
  componentId: 'control' | 'dsh-goal-sessions' | 'memory' | 'shared-objects';
  status: 'available' | 'unavailable';
  source: 'host' | 'injected';
  code: string | null;
  detail: string;
  requiredScope: string[];
}

export interface HostCheckpointAvailability {
  stagingRootHash: string;
  dataRootHash: string;
  components: HostComponentAvailability[];
  expectedReady: boolean;
  blockers: { componentId: HostComponentAvailability['componentId']; code: string; requiredScope: string[] }[];
}

export interface HostCheckpointCompositionOptions {
  /** Live data root; only read (control DB, workspaces inventory). */
  dataDir: string;
  /** Explicit staging root outside the live data root; the only write location. */
  stagingRoot: string;
  allowedStagingRoots?: readonly string[];
  controlStore: ControlStoreRequestPort;
  generation: GenerationIdentity;
  runtimeManifest: RuntimeManifest;
  clock?: Clock;
  capacity?: CapacityProbe;
  reserveBytes?: number;
  control?: Partial<Omit<HostControlSourceOptions, 'dataDir' | 'controlStore' | 'generation' | 'runtimeManifest' | 'now'>>;
  /** Full Goal Session port (tests) or the host source dependencies. */
  goalSessions?: GoalSessionPort | Omit<HostGoalSessionSourceOptions, 'controlStore' | 'runtimeManifest' | 'now'>;
  memory?: MemoryExportPort | HostMemoryExportOptions;
  sharedObjects?: SharedObjectPort;
  now?: () => Date;
  estimateBytes?: () => Promise<number>;
}

export interface RuntimeCheckpointComposition {
  readonly dataRootHash: string;
  readonly stagingRootHash: string;
  readonly dataDir: string;
  readonly stagingRoot: string;
  readonly generation: GenerationIdentity;
  capture(snapshotId: string, options?: { faults?: CaptureFaultInjection }): Promise<CaptureResult>;
  availability(): HostCheckpointAvailability;
  lastGood(): Promise<LastGoodPointer | undefined>;
}

const defaultCapacityProbe: CapacityProbe = {
  async freeBytes(targetPath: string): Promise<number> {
    try {
      const info = await statfs(targetPath, { bigint: false });
      return info.bavail * info.bsize;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return (await defaultCapacityProbe.freeBytes(path.dirname(targetPath)));
      }
      throw error;
    }
  },
};

const defaultClock: Clock = { now: () => new Date() };

const defaultEstimateBytes = async (dataDir: string): Promise<number> => {
  const database = await lstat(path.join(dataDir, 'control', 'events.sqlite')).catch(() => undefined);
  const wal = await lstat(path.join(dataDir, 'control', 'events.sqlite-wal')).catch(() => undefined);
  return Math.max(8 * 1024 * 1024, (database?.size ?? 0) * 2 + (wal?.size ?? 0) + 4 * 1024 * 1024);
};

/** Wire the existing host resources into one checkpoint composition. */
export const createRuntimeCheckpointComposition = async (options: HostCheckpointCompositionOptions): Promise<RuntimeCheckpointComposition> => {
  if (!path.isAbsolute(options.stagingRoot)) throw new RecoveryError('INVALID_SCHEMA', 'stagingRoot must be an absolute path');
  const dataDir = path.resolve(options.dataDir);
  const stagingRoot = path.resolve(options.stagingRoot);
  const resolvedDataDir = await realpath(dataDir).catch(() => {
    throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', 'Live data root does not exist or is not readable');
  });
  // Compare both the caller-visible path and its canonical parent so a symlinked
  // temp root (/var -> /private/var on macOS) cannot hide an overlap.
  const canonicalStaging = await canonicalPendingPath(stagingRoot);
  if (INSIDE(stagingRoot, dataDir) || INSIDE(dataDir, stagingRoot)
    || INSIDE(canonicalStaging, resolvedDataDir) || INSIDE(resolvedDataDir, canonicalStaging)) {
    throw new RecoveryError('LIVE_ROOT_PROTECTED', 'Checkpoint staging root must not overlap the live data root');
  }
  if (options.allowedStagingRoots !== undefined) {
    const allowed = options.allowedStagingRoots.some((root) => path.isAbsolute(root)
      && (stagingRoot === path.resolve(root) || stagingRoot.startsWith(`${path.resolve(root)}${path.sep}`)));
    if (!allowed) throw new RecoveryError('TARGET_NOT_ISOLATED', 'Checkpoint staging root is outside the approved roots');
  }
  const clock = options.clock ?? defaultClock;
  const now = options.now;
  const generation = assertValidGenerationIdentity(options.generation);
  const runtimeManifest = assertValidRuntimeManifest(options.runtimeManifest);
  const dataRootHash = computeDataRootId(resolvedDataDir);
  const controlPort = createHostControlSourcePort({
    ...(options.control ?? {}),
    dataDir: resolvedDataDir,
    controlStore: options.controlStore,
    generation,
    runtimeManifest,
    quiescenceEvidence: options.control?.quiescenceEvidence
      ?? 'host: node:sqlite online backup while the runtime keeps its existing writers; no global writer-silence claim, reconcileRequired stays true',
    now: now ?? (() => clock.now()),
  });
  const goalPort: GoalSessionPort = (() => {
    if (options.goalSessions && typeof (options.goalSessions as GoalSessionPort).prepareCapture === 'function') {
      return options.goalSessions as GoalSessionPort;
    }
    return createHostGoalSessionPort({
      ...((options.goalSessions as Omit<HostGoalSessionSourceOptions, 'controlStore' | 'runtimeManifest' | 'now'> | undefined) ?? {}),
      controlStore: options.controlStore,
      runtimeManifest,
      now: now ?? (() => clock.now()),
    });
  })();
  const memoryPort: MemoryExportPort = (() => {
    if (options.memory && typeof (options.memory as MemoryExportPort).export === 'function') return options.memory as MemoryExportPort;
    return createHostMemoryExportPort((options.memory as HostMemoryExportOptions | undefined) ?? {});
  })();
  const objectPort: SharedObjectPort = options.sharedObjects
    ?? await createHostWorkspaceObjectPort({ dataDir: resolvedDataDir });
  await ensureDir(stagingRoot);
  const environment = {
    clock,
    capacity: options.capacity ?? defaultCapacityProbe,
    control: controlPort,
    goalSessions: goalPort,
    memory: memoryPort,
    sharedObjects: objectPort,
  };
  const captureOptions: CaptureServiceOptions = {
    environment,
    stagingRoot,
    ...(options.reserveBytes === undefined ? {} : { reserveBytes: options.reserveBytes }),
    liveDataRoot: resolvedDataDir,
    ...(options.allowedStagingRoots === undefined ? {} : { allowedStagingRoots: options.allowedStagingRoots }),
  };
  const captureService = new CheckpointCaptureService(captureOptions);

  const availability = (): HostCheckpointAvailability => {
    const goalSourceInjected = Boolean(options.goalSessions && typeof (options.goalSessions as GoalSessionPort).prepareCapture === 'function');
    const goalOptions = goalSourceInjected ? null : (options.goalSessions as Omit<HostGoalSessionSourceOptions, 'controlStore' | 'runtimeManifest' | 'now'> | undefined);
    const memoryInjected = Boolean(options.memory && typeof (options.memory as MemoryExportPort).export === 'function');
    const components: HostComponentAvailability[] = [
      { componentId: 'control', status: 'available', source: 'host', code: null, detail: 'existing ControlStore facts + node:sqlite backup from the live control DB', requiredScope: [] },
      goalSourceInjected
        ? { componentId: 'dsh-goal-sessions', status: 'available', source: 'injected', code: null, detail: 'injected Goal Session port', requiredScope: [] }
        : (() => {
          const missing: string[] = [];
          if (!goalOptions?.resolver) missing.push('exact Session log path resolver');
          if (!goalOptions?.nativeState) missing.push('read-only native Goal state');
          if (!goalOptions?.flushSession) missing.push('acknowledged Session flush');
          if (!goalOptions?.projection) missing.push('projection export');
          return missing.length === 0
            ? { componentId: 'dsh-goal-sessions' as const, status: 'available' as const, source: 'host' as const, code: null, detail: 'host Goal Session source is fully injected', requiredScope: [] }
            : { componentId: 'dsh-goal-sessions' as const, status: 'unavailable' as const, source: 'host' as const, code: 'GOAL_SESSION_EXPORT_UNAVAILABLE', detail: `Missing host capabilities: ${missing.join('; ')}`, requiredScope: [...HOST_GOAL_SESSION_REQUIRED_SCOPE] };
        })(),
      memoryInjected
        ? { componentId: 'memory', status: 'available', source: 'injected', code: null, detail: 'injected memory export port', requiredScope: [] }
        : { componentId: 'memory', status: 'unavailable', source: 'host', code: 'MEMORY_EXPORT_UNAVAILABLE', detail: 'Managed Ombre backend has no public export/archive API in this pinned deployment', requiredScope: [...HOST_MEMORY_REQUIRED_SCOPE] },
      { componentId: 'shared-objects', status: 'available', source: options.sharedObjects ? 'injected' : 'host', code: null, detail: 'read-only bounded workspaces inventory; object bytes are packed only for referenced ids', requiredScope: [] },
    ];
    const blockers = components
      .filter((component) => component.status === 'unavailable')
      .map((component) => ({ componentId: component.componentId, code: component.code ?? 'COMPONENT_UNAVAILABLE', requiredScope: [...component.requiredScope] }));
    return {
      stagingRootHash: hashPath(stagingRoot),
      dataRootHash,
      components,
      expectedReady: blockers.length === 0,
      blockers,
    };
  };

  return {
    dataRootHash,
    stagingRootHash: hashPath(stagingRoot),
    dataDir: resolvedDataDir,
    stagingRoot,
    generation,
    async capture(snapshotId: string, captureOverrides: { faults?: CaptureFaultInjection } = {}): Promise<CaptureResult> {
      const estimatedBytes = options.estimateBytes ? await options.estimateBytes() : await defaultEstimateBytes(resolvedDataDir);
      return captureService.capture({
        snapshotId,
        rootId: dataRootHash,
        estimatedBytes,
        ...(captureOverrides.faults ? { faults: captureOverrides.faults } : {}),
      });
    },
    availability,
    async lastGood(): Promise<LastGoodPointer | undefined> { return captureService.readLastGood(); },
  };
};

/** Compose a bundle summary for the owner-only command without trusting paths in error text. */
export const summarizeCaptureResult = async (result: CaptureResult): Promise<{
  bundleStatus: BackupBundle['status'] | null;
  manifestSha256: string | null;
  captureTime: string | null;
  componentStates: { componentId: string; status: string; failureCodes: string[] }[];
}> => {
  const directory = result.status === 'ready' ? result.bundleDirectory : result.bundleDirectory;
  if (!directory) return { bundleStatus: null, manifestSha256: null, captureTime: null, componentStates: [] };
  try {
    const loaded = await readBundleManifest(directory);
    return {
      bundleStatus: loaded.bundle.status,
      manifestSha256: loaded.sha256,
      captureTime: loaded.bundle.captureTime,
      componentStates: loaded.bundle.components.map((component) => ({
        componentId: component.componentId, status: component.status, failureCodes: [...component.failureCodes],
      })),
    };
  } catch {
    return { bundleStatus: null, manifestSha256: null, captureTime: null, componentStates: [] };
  }
};

/** Diagnostic source used by the runtime integration diff; no host behaviour is faked. */
export const HOST_PORT_PROVENANCE = Object.freeze({
  control: 'live control SQLite backup + existing ControlStore read-only facts',
  goalSessions: 'control GoalBindings + injected resolver/native-state/flush/projection; no path guessing',
  memory: 'explicitly unavailable: managed Ombre has no public export tool in this deployment',
  sharedObjects: 'read-only bounded {dataDir}/workspaces inventory; referenced objects only are packed',
  envIdentity: 'generation from the runtime local state; hostEpoch from the runtime instance id',
});

/** Fresh bounded snapshot id for the owner command; deterministic tests inject their own. */
export const newCheckpointSnapshotId = (now: () => Date = () => new Date()): string =>
  `checkpoint-${now().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
