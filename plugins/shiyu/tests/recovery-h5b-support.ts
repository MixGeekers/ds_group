/**
 * H5b test fixtures: a real temporary ControlStore worker, a real temporary
 * data directory, synthetic native Goal Session files and a synthetic memory
 * export. No live `.local/runtime`, no real `~/.dsh/sessions`, no model.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import type { GoalBinding } from '../src/adapters/dsh/goals.js';
import type {
  ControlSourcePort,
  GoalSessionPort,
  MemoryExportPort,
  MemoryExportResult,
  RecoveryEnvironment,
  SharedObjectPort,
} from '../src/recovery/ports.js';
import type {
  ControlSourceLease,
  GoalSessionCapture,
  GoalSessionSnapshot,
} from '../src/recovery/ports.js';
import {
  createRuntimeCheckpointComposition,
  createHostControlSourcePort,
  createHostGoalSessionPort,
  createHostWorkspaceObjectPort,
  detectSessionPersistenceLogResolver,
} from '../src/recovery/host-ports.js';
import type {
  HostCheckpointCompositionOptions,
  HostGoalSessionResolver,
  HostNativeGoalState,
  HostProjectionExport,
  HostWorkspaceObjectPort,
  RuntimeCheckpointComposition,
} from '../src/recovery/host-ports.js';
import type { GenerationIdentity, RuntimeManifest, RuntimeComponentVersion } from '../src/recovery/types.js';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const canonicalJson = (value: unknown): string => {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sort(v)]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
};
export const hashCanonical = (value: unknown): string => sha256(canonicalJson(value));

export const FIXED_TIME = '2026-11-02T21:00:00.000Z';
export const GENERATION_TEST: GenerationIdentity = { installationGeneration: 'generation-h5b-1', hostEpoch: 'host-epoch-h5b-1' };
export const ROOT_OWNER = 'local-owner';
export const ROOT_SCOPE = 'local-owner';

export interface MutableClock {
  now(): Date;
  advance(ms: number): void;
  current(): string;
}

export const makeClock = (start = FIXED_TIME): MutableClock => {
  let current = Date.parse(start);
  return {
    now: () => { const value = new Date(current); current += 1000; return value; },
    advance: (ms) => { current += ms; },
    current: () => new Date(current).toISOString(),
  };
};

const componentEntry = (id: string, version: string): RuntimeComponentVersion => ({
  componentId: id,
  version,
  upstreamCommit: sha256(`upstream:${id}`).slice(0, 40),
  patchDigest: sha256(`no-patch:${id}`),
  dataSchema: 1,
  minimumReaderVersion: 1,
});

export const runtimeManifestFixture = (): RuntimeManifest => ({
  dshVersion: '0.2.1-rc.5',
  dshCommit: sha256('dsh-fixed').slice(0, 40),
  nodeVersion: 'v24.19.0',
  nodePlatform: 'darwin',
  nodeArch: 'arm64',
  sqliteVersion: '3.53.4',
  components: [
    componentEntry('dsh', '0.2.1-rc.5'),
    componentEntry('shiyu-plugin', '0.1.0'),
    componentEntry('projection', '1'),
    componentEntry('control-store', '1'),
    componentEntry('memory-backend', '1'),
    componentEntry('object-store', '1'),
  ],
});

export interface RealHostWorld {
  root: string;
  dataDir: string;
  stagingRoot: string;
  isolatedRoot: string;
  sessionsRoot: string;
  controlDb: string;
  store: ControlStore;
  clock: MutableClock;
  runtimeManifest: RuntimeManifest;
  generation: GenerationIdentity;
  watermarks: { commitSeq: number; stateVersion: number; tombstoneWatermark: number; deletionBaselineId: string; authorizationEpoch: number };
}

const readHostWatermarks = (controlDb: string): RealHostWorld['watermarks'] => {
  const db = new DatabaseSync(controlDb, { readOnly: true });
  try {
    const watermark = db.prepare('SELECT commit_seq FROM shiyu_commit_watermark WHERE id=1').get() as { commit_seq: number };
    const publication = db.prepare('SELECT state_version FROM shiyu_state_publication_head WHERE id=1').get() as { state_version: number };
    const memory = db.prepare('SELECT tombstone_watermark,baseline_id FROM shiyu_memory_meta WHERE id=1').get() as { tombstone_watermark: number; baseline_id: string };
    const policy = db.prepare('SELECT auth_epoch FROM shiyu_policy_meta WHERE id=1').get() as { auth_epoch: number };
    return {
      commitSeq: watermark.commit_seq,
      stateVersion: publication.state_version,
      tombstoneWatermark: memory.tombstone_watermark,
      deletionBaselineId: memory.baseline_id,
      authorizationEpoch: policy.auth_epoch,
    };
  } finally { db.close(); }
};

/** Open a real ControlStore worker on a temporary data directory. */
export const createRealHostWorld = async (t?: TestContext): Promise<RealHostWorld> => {
  const root = await mkdtemp(path.join(tmpdir(), 'shiyu-h5b-'));
  const dataDir = path.join(root, 'data');
  const stagingRoot = path.join(root, 'staging');
  const isolatedRoot = path.join(root, 'isolated');
  const sessionsRoot = path.join(root, 'sessions');
  for (const directory of [dataDir, stagingRoot, isolatedRoot, sessionsRoot]) await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataDir, 'control'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dataDir, 'workspaces'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dataDir, 'sentinel.txt'), 'live-data-root-sentinel');
  const controlDb = path.join(dataDir, 'control', 'events.sqlite');
  const store = await ControlStore.open({
    filename: controlDb,
    eventTypes: SHIYU_EVENT_TYPES,
    componentHandlers: [],
    runtimeIdentity: { hostEpoch: GENERATION_TEST.hostEpoch, installationGeneration: GENERATION_TEST.installationGeneration },
    // The managed memory deployment is required for the control deletion
    // watermark table; the export port itself stays unavailable in production.
    memoryBackend: { backendId: 'synthetic-h5b-memory', deploymentId: 'deployment-h5b-1' },
  });
  if (t) t.after(async () => {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const clock = makeClock();
  return {
    root, dataDir, stagingRoot, isolatedRoot, sessionsRoot, controlDb, store, clock,
    runtimeManifest: runtimeManifestFixture(), generation: { ...GENERATION_TEST },
    watermarks: readHostWatermarks(controlDb),
  };
};

/** Seed one binding through the existing store command (two CAS steps: pending create -> confirmed). */
export const seedGoalBinding = async (
  store: ControlStore,
  options: { goalId: string; sessionId: string; nativeGoalId: string; ownerId?: string; scope?: string },
): Promise<void> => {
  const ownerId = options.ownerId ?? ROOT_OWNER;
  const scope = options.scope ?? ROOT_SCOPE;
  const base: GoalBinding = {
    goalId: options.goalId,
    sessionId: options.sessionId,
    ownerId,
    scope,
    cwd: '/tmp/synthetic-h5b-workspace',
    completionCriteriaHash: sha256(`criteria:${options.goalId}`),
    metadataVersion: 1,
    receipt: {
      commandId: `command-${options.goalId}`,
      operation: 'create',
      status: 'pending',
      postconditionHash: sha256(`postcondition:${options.goalId}`),
    },
  };
  await store.request('goal.binding.compareAndSet', { expectedMetadataVersion: undefined, binding: base });
  const confirmed: GoalBinding = {
    ...base,
    metadataVersion: 2,
    goalRef: { id: options.nativeGoalId, revision: 1 },
    receipt: {
      ...base.receipt!,
      status: 'confirmed',
      observedRef: { id: options.nativeGoalId, revision: 1 },
    },
  };
  await store.request('goal.binding.compareAndSet', { expectedMetadataVersion: 1, binding: confirmed });
};

const sessionJsonl = (goalId: string, nativeGoalId: string, phase: string, activation: string, revision = 1): Buffer => {
  const records = [
    { seq: 1, type: 'session/header', sessionId: `session-${goalId}` },
    { seq: 2, type: 'goal/state', goal: { id: nativeGoalId, revision, phase, activation } },
    { seq: 3, type: 'goal/round', round: 1 },
    { seq: 4, type: 'goal/state', goal: { id: nativeGoalId, revision, phase, activation } },
  ];
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
};

export interface SyntheticSessionSpec {
  goalId: string;
  sessionId: string;
  nativeGoalId: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  activation: 'armed' | 'disarmed';
  bytes?: Buffer;
  omitLog?: boolean;
  format?: 'jsonl-plain' | 'zstd' | 'unknown';
  flushAcknowledged?: boolean;
  nativeStateMissing?: boolean;
  tamperExpected?: boolean;
}

export interface SyntheticSessionSource {
  resolver: HostGoalSessionResolver;
  nativeState: (sessionId: string) => Promise<HostNativeGoalState | undefined>;
  flushSession: (sessionId: string) => Promise<boolean>;
  projection: HostProjectionExport;
  paths: Map<string, string>;
}

/** Write temporary Session logs and build the injected Goal Session seams. */
export const buildSyntheticSessionSource = async (
  sessionsRoot: string,
  specs: SyntheticSessionSpec[],
): Promise<SyntheticSessionSource> => {
  const paths = new Map<string, string>();
  const bySession = new Map<string, SyntheticSessionSpec>();
  for (const spec of specs) {
    bySession.set(spec.sessionId, spec);
    if (spec.omitLog) continue;
    const filename = path.join(sessionsRoot, `${spec.sessionId}.jsonl`);
    const bytes = spec.bytes ?? sessionJsonl(spec.goalId, spec.nativeGoalId, spec.phase, spec.activation);
    await writeFile(filename, bytes);
    paths.set(spec.sessionId, filename);
  }
  const definition = Buffer.from(`${JSON.stringify({ projectionId: 'shiyu-goal-state', schemaVersion: 1, fields: ['goal'] })}\n`);
  const config = Buffer.from(`${JSON.stringify({ agentPreset: 'shiyu-goal-core', version: 1 })}\n`);
  const projection: HostProjectionExport = {
    projectionId: 'shiyu-goal-state',
    schemaVersion: 1,
    minimumReaderVersion: 1,
    digest: sha256(definition),
    configSha256: sha256(config),
    definition,
    config,
  };
  return {
    paths,
    projection,
    resolver: {
      provenance: 'injected',
      async resolve(sessionId) {
        const spec = bySession.get(sessionId);
        if (!spec || spec.omitLog || !paths.has(sessionId)) return undefined;
        return { path: paths.get(sessionId)!, format: spec.format ?? 'jsonl-plain' };
      },
    },
    async nativeState(sessionId) {
      const spec = bySession.get(sessionId);
      if (!spec || spec.nativeStateMissing) return undefined;
      return { goalRef: { id: spec.nativeGoalId, revision: 1 }, phase: spec.phase, activation: spec.activation };
    },
    async flushSession(sessionId) {
      const spec = bySession.get(sessionId);
      return spec ? spec.flushAcknowledged !== false : false;
    },
  };
};

/** Synthetic memory export writing a tiny archive + record index into the component directory. */
export const syntheticMemoryExport = (watermarks: RealHostWorld['watermarks'], records = [
  { id: 'memory-h5b-1', body: 'synthetic memory one' },
  { id: 'memory-h5b-2', body: 'synthetic memory two' },
]): MemoryExportPort => ({
  async export({ stagingDirectory }): Promise<MemoryExportResult> {
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    const archive = Buffer.from(`${records.map((record) => JSON.stringify({ memoryId: record.id, body: record.body, sha256: sha256(record.body) })).join('\n')}\n`);
    const index = Buffer.from(`${records.map((record) => JSON.stringify({ ref: record.id, kind: 'memory-source', sha256: sha256(record.body) })).join('\n')}\n`);
    await writeFile(path.join(stagingDirectory, 'archive.jsonl'), archive);
    await writeFile(path.join(stagingDirectory, 'index.jsonl'), index);
    return {
      backendId: 'synthetic-h5b-memory',
      deploymentId: 'deployment-h5b-1',
      componentVersion: 'synthetic-1',
      dataSchema: 1,
      minimumReaderVersion: 1,
      capturedAt: FIXED_TIME,
      watermark: { tombstoneWatermark: watermarks.tombstoneWatermark, baselineId: watermarks.deletionBaselineId },
      archive: { file: 'archive.jsonl', bytes: archive.byteLength, sha256: sha256(archive) },
      recordIndex: { file: 'index.jsonl', bytes: index.byteLength, sha256: sha256(index), count: records.length },
      objectRefs: [],
    };
  },
});

export interface CompositionFixture {
  world: RealHostWorld;
  composition: RuntimeCheckpointComposition;
  sessions: SyntheticSessionSource | null;
  workspacePort: HostWorkspaceObjectPort | null;
}

export interface CompositionOptions {
  specs?: SyntheticSessionSpec[];
  goalPort?: GoalSessionPort;
  memory?: MemoryExportPort;
  memoryUnavailable?: boolean;
  omitProjection?: boolean;
  omitResolver?: boolean;
  omitNativeState?: boolean;
  omitFlush?: boolean;
  sharedObjects?: SharedObjectPort;
  stagingRoot?: string;
  allowedStagingRoots?: readonly string[];
  extra?: Partial<HostCheckpointCompositionOptions>;
}

/** Create the H5b composition against the real temporary host world. */
export const createComposition = async (world: RealHostWorld, options: CompositionOptions = {}): Promise<CompositionFixture> => {
  const specs = options.specs ?? [];
  const sessions = specs.length > 0 ? await buildSyntheticSessionSource(world.sessionsRoot, specs) : null;
  const goalInjection = options.goalPort ?? (sessions ? {
    resolver: options.omitResolver ? undefined : sessions.resolver,
    nativeState: options.omitNativeState ? undefined : sessions.nativeState,
    flushSession: options.omitFlush ? undefined : sessions.flushSession,
    projection: options.omitProjection ? undefined : sessions.projection,
  } : undefined);
  const memory = options.memory ?? (options.memoryUnavailable ? undefined : syntheticMemoryExport(world.watermarks));
  const workspacePort = options.sharedObjects ? null : await createHostWorkspaceObjectPort({ dataDir: world.dataDir });
  const composition = await createRuntimeCheckpointComposition({
    dataDir: world.dataDir,
    stagingRoot: options.stagingRoot ?? world.stagingRoot,
    ...(options.allowedStagingRoots ? { allowedStagingRoots: options.allowedStagingRoots } : {}),
    controlStore: world.store,
    generation: world.generation,
    runtimeManifest: world.runtimeManifest,
    clock: world.clock,
    ...(options.sharedObjects ? { sharedObjects: options.sharedObjects } : { sharedObjects: workspacePort! }),
    ...(goalInjection ? { goalSessions: { ...goalInjection } } : {}),
    ...(memory ? { memory } : {}),
    ...(options.extra ?? {}),
  });
  return { world, composition, sessions, workspacePort };
};

export const readDataSentinel = async (world: RealHostWorld): Promise<string> => readFile(path.join(world.dataDir, 'sentinel.txt'), 'utf8');

/** Current ControlStore commit watermark (the world snapshot is captured at creation time). */
export const currentCommitSeq = async (world: RealHostWorld): Promise<number> => {
  const watermark = await world.store.request('control.watermark', {}) as { commitSeq: number };
  return watermark.commitSeq;
};

/** A resolver over the installed JSONL persistence diagnostic shape (non-contract candidate). */
export const fakeJsonlPersistence = (logs: Map<string, string>, compression: 'none' | 'zstd' = 'none') => ({
  compression,
  async resolveCurrentLog(sessionId: string): Promise<string | undefined> { return logs.get(sessionId); },
});

/** List data-dir file names/hashes for "live root untouched" assertions. */
export const snapshotTree = async (root: string): Promise<{ relativePath: string; bytes: number; sha256: string }[]> => {
  const { readdir } = await import('node:fs/promises');
  const result: { relativePath: string; bytes: number; sha256: string }[] = [];
  const walk = async (relative: string): Promise<void> => {
    const directory = relative ? path.join(root, ...relative.split('/')) : root;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(child); continue; }
      if (!entry.isFile()) continue;
      const bytes = await readFile(path.join(root, ...child.split('/')));
      result.push({ relativePath: child, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }
  };
  await walk('');
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};

export const sessionLogBytes = (goalId: string, nativeGoalId: string, phase: string, activation: string): Buffer =>
  sessionJsonl(goalId, nativeGoalId, phase, activation);

export { createHostControlSourcePort, createHostGoalSessionPort, detectSessionPersistenceLogResolver };

export type { RecoveryEnvironment, ControlSourceLease, GoalSessionCapture, GoalSessionSnapshot };
