/**
 * H5-B1 synthetic fixtures for the offline checkpoint / isolated-restore tests.
 *
 * Everything here is synthetic and local: a real temporary SQLite control
 * database in WAL mode, real temp files for Goal Session logs and memory
 * export, an in-memory shared-object map and deterministic clock/capacity
 * probes. No live data root, live Session or model is touched.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { CheckpointCaptureService } from '../src/recovery/capture.js';
import type { CaptureRequest, CaptureResult } from '../src/recovery/capture.js';
import { IsolatedRestoreService, sealDeletionLedger } from '../src/recovery/restore.js';
import type { RestoreRequest, RestoreResult } from '../src/recovery/restore.js';
import { readControlFacts } from '../src/recovery/control-facts.js';
import { readBundleManifest, verifyBundleDirectory } from '../src/recovery/verify.js';
import type {
  CaptureFailureStatus,
  ControlWatermarks,
  DeletionLedger,
  RecoveryBarrierEvidence,
  RuntimeComponentVersion,
  RuntimeManifest,
} from '../src/recovery/types.js';
import type {
  CapacityProbe,
  Clock,
  ControlSourceLease,
  GoalSessionCapture,
  GoalSessionSnapshot,
  MemoryExportResult,
  RecoveryEnvironment,
  SharedObjectRead,
} from '../src/recovery/ports.js';

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

const encoder = new TextEncoder();

export const FIXED_BASE = '2026-11-02T18:00:00.000Z';
export const FIXED_ROOT_ID = sha256('synthetic-root:1');
export const FIXED_DELETION_BASELINE = 'deletion-baseline-1';
export const FIXED_MANIFEST_HASH = sha256('published-state-manifest');

export interface MutableClock extends Clock {
  advance(ms: number): void;
  current(): string;
}

export const makeClock = (startIso = FIXED_BASE): MutableClock => {
  let current = Date.parse(startIso);
  return {
    now: () => { const value = new Date(current); current += 1000; return value; },
    advance: (ms: number) => { current += ms; },
    current: () => new Date(current).toISOString(),
  };
};

export const runtimeManifestFixture = (overrides: { minimumReaderVersion?: number; omit?: string[]; dataSchema?: number } = {}): RuntimeManifest => {
  const minimumReaderVersion = overrides.minimumReaderVersion ?? 1;
  const dataSchema = overrides.dataSchema ?? 1;
  const entries: RuntimeComponentVersion[] = [
    ['dsh', '0.2.1-rc.5'],
    ['shiyu-plugin', '0.1.0-test'],
    ['projection', '1'],
    ['control-store', '1'],
    ['memory-backend', '1'],
    ['object-store', '1'],
  ]
    .filter(([id]) => !(overrides.omit ?? []).includes(id!))
    .map(([id, version]) => ({
      componentId: id!,
      version: version!,
      upstreamCommit: sha256(`upstream:${id}`).slice(0, 40),
      patchDigest: sha256(`no-patch:${id}`),
      dataSchema,
      minimumReaderVersion,
    }));
  return {
    dshVersion: '0.2.1-rc.5',
    dshCommit: sha256('dsh-fixed-commit').slice(0, 40),
    nodeVersion: 'v24.19.0',
    nodePlatform: 'darwin',
    nodeArch: 'arm64',
    sqliteVersion: '3.53.4',
    components: entries,
  };
};

/** Lease generation ids: bounded identity pattern, not a host-verified generation. */
export const GENERATION = { installationGeneration: 'generation-test-1', hostEpoch: 'host-epoch-test-1' } as const;

export interface GoalBindingFixture {
  goalId: string;
  sessionId: string;
  goalRef: { id: string; revision: number } | null;
  ownerId: string;
  scope: string;
  cwd: string;
  completionCriteriaHash: string;
  metadataVersion: number;
  receiptStatus?: 'none' | 'pending' | 'unknown' | 'confirmed' | 'rejected';
  receiptOperation?: string;
}

export const defaultGoalBinding = (): GoalBindingFixture => ({
  goalId: 'goal-alpha',
  sessionId: 'shiyu-goal-alpha',
  goalRef: { id: 'native-goal-alpha', revision: 3 },
  ownerId: 'local-owner',
  scope: 'shiyu-goals',
  cwd: '/tmp/synthetic-goal-cwd',
  completionCriteriaHash: sha256('criteria:alpha'),
  metadataVersion: 2,
  receiptStatus: 'confirmed',
  receiptOperation: 'update',
});

export interface ControlFixtureOptions {
  commitSeq?: number;
  stateVersion?: number;
  authorizationEpoch?: number;
  tombstoneWatermark?: number;
  deletionBaselineId?: string;
  missing?: { commit?: boolean; publication?: boolean; policy?: boolean; deletion?: boolean; tombstones?: boolean };
  goalBindings?: GoalBindingFixture[];
  effects?: { effectId: string; status: 'pending' | 'dispatching' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' }[];
  goalCommands?: { goalId: string; commandId: string; status: 'pending' | 'unknown' | 'confirmed' | 'rejected' }[];
  reservations?: { id: string; state: 'reserved' | 'unknown' | 'settled' }[];
  memoryOperations?: { operationId: string; effectState: 'pending' | 'dispatching' | 'succeeded' | 'failed' | 'unknown'; status: string }[];
  tombstones?: { ref: string; watermark: number }[];
}

export interface ControlFixture {
  filename: string;
  watermarks: ControlWatermarks;
  goalBindings: GoalBindingFixture[];
  objects: string[];
}

const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS shiyu_commit_watermark(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,commit_seq INTEGER NOT NULL CHECK(commit_seq>=0),baseline_id TEXT NOT NULL,started_at TEXT NOT NULL,schema_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shiyu_state_publication_head(id INTEGER PRIMARY KEY CHECK(id=1),state_version INTEGER NOT NULL CHECK(state_version>=1),record_json TEXT NOT NULL CHECK(json_valid(record_json)));
CREATE TABLE IF NOT EXISTS shiyu_policy_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, frozen INTEGER NOT NULL, reason TEXT);
CREATE TABLE IF NOT EXISTS shiyu_memory_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, policy_hash TEXT NOT NULL, tombstone_watermark INTEGER NOT NULL,
  baseline_id TEXT NOT NULL,installed_at TEXT NOT NULL,history_hash TEXT NOT NULL,barrier_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shiyu_memory_tombstones (scope TEXT NOT NULL, ref TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(scope,ref));
CREATE TABLE IF NOT EXISTS shiyu_goal_bindings(goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, metadata_version INTEGER NOT NULL CHECK(metadata_version>=1),
  value TEXT NOT NULL CHECK(json_valid(value)));
CREATE TABLE IF NOT EXISTS shiyu_goal_commands(goal_id TEXT NOT NULL REFERENCES shiyu_goal_bindings(goal_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL, identity_hash TEXT NOT NULL, first_metadata_version INTEGER NOT NULL CHECK(first_metadata_version>=1),
  last_metadata_version INTEGER NOT NULL CHECK(last_metadata_version>=first_metadata_version),
  value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(goal_id,command_id));
CREATE TABLE IF NOT EXISTS shiyu_effects (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, effect_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE, intent_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','dispatching','succeeded','failed','unknown','cancelled')), version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
CREATE TABLE IF NOT EXISTS shiyu_budget_reservations (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, intent_hash TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
CREATE TABLE IF NOT EXISTS shiyu_memory_operations (operation_id TEXT PRIMARY KEY, effect_id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, intent_hash TEXT NOT NULL, local_version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
`;

/**
 * Build a real WAL control database that matches the tables read by the
 * offline module. Missing required tables simulate an unprovable watermark.
 */
export const createControlFixture = async (filename: string, options: ControlFixtureOptions = {}): Promise<ControlFixture> => {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;');
  db.exec(CONTROL_SCHEMA);
  const commitSeq = options.commitSeq ?? 42;
  const stateVersion = options.stateVersion ?? 7;
  const authorizationEpoch = options.authorizationEpoch ?? 5;
  const tombstoneWatermark = options.tombstoneWatermark ?? 3;
  const deletionBaselineId = options.deletionBaselineId ?? FIXED_DELETION_BASELINE;
  if (!options.missing?.commit) {
    db.prepare('INSERT INTO shiyu_commit_watermark VALUES(1,1,?,?,?,?)')
      .run(commitSeq, '7f1c1f6e-3c85-4a4e-8b3a-5a1e2f3c4d5e', FIXED_BASE, sha256('control-schema'));
  }
  if (!options.missing?.publication) {
    db.prepare('INSERT INTO shiyu_state_publication_head VALUES(1,?,?)').run(stateVersion, JSON.stringify({
      schemaVersion: 1,
      manifestHash: FIXED_MANIFEST_HASH,
      publishedAt: FIXED_BASE,
      publisherId: 'synthetic-publisher',
    }));
  }
  if (!options.missing?.policy) {
    db.prepare('INSERT INTO shiyu_policy_meta VALUES(1,1,?,0,NULL)').run(authorizationEpoch);
  }
  if (!options.missing?.deletion) {
    db.prepare('INSERT INTO shiyu_memory_meta VALUES(1,2,?,?,?,?,?,?)').run(
      sha256('memory-policy'), tombstoneWatermark, deletionBaselineId, FIXED_BASE, sha256('history'), sha256('barrier'));
  }
  if (!options.missing?.tombstones) {
    for (const tombstone of options.tombstones ?? []) {
      db.prepare('INSERT INTO shiyu_memory_tombstones VALUES(?,?,?)').run('local-memory-source', tombstone.ref, tombstone.watermark);
    }
  }
  const goalBindings = options.goalBindings ?? [defaultGoalBinding()];
  for (const binding of goalBindings) {
    const value = {
      goalId: binding.goalId,
      sessionId: binding.sessionId,
      ownerId: binding.ownerId,
      scope: binding.scope,
      cwd: binding.cwd,
      completionCriteriaHash: binding.completionCriteriaHash,
      metadataVersion: binding.metadataVersion,
      ...(binding.goalRef ? { goalRef: binding.goalRef } : {}),
      ...(binding.receiptStatus && binding.receiptStatus !== 'none' ? {
        receipt: {
          commandId: `command-${binding.goalId}`,
          operation: binding.receiptOperation ?? 'update',
          status: binding.receiptStatus,
          postconditionHash: sha256(`postcondition:${binding.goalId}`),
          ...(binding.goalRef ? { observedRef: binding.goalRef } : {}),
        },
      } : {}),
    };
    db.prepare('INSERT INTO shiyu_goal_bindings VALUES(?,?,?,?)').run(binding.goalId, binding.sessionId, binding.metadataVersion, JSON.stringify(value));
  }
  for (const command of options.goalCommands ?? []) {
    const binding = goalBindings.find((item) => item.goalId === command.goalId);
    if (!binding) continue;
    db.prepare('INSERT INTO shiyu_goal_commands VALUES(?,?,?,?,?,?)').run(
      command.goalId, command.commandId, sha256(`identity:${command.commandId}`), 1, binding.metadataVersion,
      JSON.stringify({
        commandId: command.commandId,
        operation: 'update',
        status: command.status,
        expectedRef: { id: `native-${command.goalId}`, revision: 1 },
        postconditionHash: sha256(`postcondition:${command.commandId}`),
      }));
  }
  for (const effect of options.effects ?? []) {
    db.prepare('INSERT INTO shiyu_effects(effect_id,idempotency_key,intent_hash,status,version,record_json) VALUES(?,?,?,?,1,?)').run(
      effect.effectId, `idem-${effect.effectId}`, sha256(`intent:${effect.effectId}`), effect.status,
      JSON.stringify({ effectId: effect.effectId, status: effect.status, version: 1 }));
  }
  for (const reservation of options.reservations ?? []) {
    db.prepare('INSERT INTO shiyu_budget_reservations VALUES(?,?,?,?,?)').run(
      reservation.id, 'mandate-1', sha256(`reservation-intent:${reservation.id}`), 1,
      JSON.stringify({ id: reservation.id, state: reservation.state, version: 1, amount: { calls: 1 }, observed: {}, overrun: false }));
  }
  for (const operation of options.memoryOperations ?? []) {
    db.prepare('INSERT INTO shiyu_memory_operations VALUES(?,?,?,?,?,?)').run(
      operation.operationId, `effect-${operation.operationId}`, 'local-memory-source', sha256(`memory-intent:${operation.operationId}`), 1,
      JSON.stringify({ operationId: operation.operationId, status: operation.status, effectState: operation.effectState }));
  }
  const watermarks: ControlWatermarks = { commitSeq, stateVersion, tombstoneWatermark, deletionBaselineId, authorizationEpoch };
  db.close();
  return { filename, watermarks, goalBindings, objects: [] };
};

export interface GoalSessionsOptions {
  omitGoalId?: string;
  extraGoalId?: string;
  phase?: 'active' | 'paused' | 'blocked' | 'complete';
  activation?: 'armed' | 'disarmed';
  captureActivationOverrideFor?: string;
  failActivation?: 'armed' | 'disarmed';
  tamperBytes?: boolean;
  tamperProjection?: boolean;
  projectionMinimumReaderVersion?: number;
  capturedAt?: string;
  quiescenceEvidence?: string;
  extraSequence?: number;
  opaque?: boolean;
}

export interface SyntheticSession {
  snapshot: GoalSessionSnapshot;
}

const projectionDefinitionFixture = (): { definition: Uint8Array; config: Uint8Array; digest: string; configSha256: string } => {
  const definition = encoder.encode(`${JSON.stringify({ projectionId: 'shiyu-goal-state', schemaVersion: 1, fields: ['goal'] })}\n`);
  const config = encoder.encode(`${JSON.stringify({ agentPreset: 'shiyu-goal-core', version: 1 })}\n`);
  return { definition, config, digest: sha256(definition), configSha256: sha256(config) };
};

const sessionLogFixture = (
  binding: GoalBindingFixture,
  phase: 'active' | 'paused' | 'blocked' | 'complete',
  activation: 'armed' | 'disarmed',
  extraSequence = 0,
): Buffer => {
  const goalRef = binding.goalRef ?? { id: `native-${binding.goalId}`, revision: 1 };
  const records: unknown[] = [
    { seq: 1, type: 'session/header', sessionId: binding.sessionId },
    { seq: 2, type: 'session/title', title: '识雨 · 受限目标规划' },
  ];
  for (let index = 0; index < extraSequence; index++) {
    records.push({ seq: 3 + index, type: 'goal/context', note: `synthetic-${index}` });
  }
  records.push({
    seq: 3 + extraSequence,
    type: 'goal/state',
    goal: { id: goalRef.id, revision: goalRef.revision, phase, activation },
  });
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
};

export const buildGoalSessions = (
  bindings: GoalBindingFixture[],
  clock: MutableClock,
  options: GoalSessionsOptions = {},
): { snapshots: GoalSessionSnapshot[]; quiescenceEvidence: string; capturedAt: string } => {
  const snapshots: GoalSessionSnapshot[] = [];
  const projection = projectionDefinitionFixture();
  for (const binding of bindings) {
    if (options.omitGoalId === binding.goalId) continue;
    const phase = options.phase ?? 'active';
    const activation = binding.goalId === options.captureActivationOverrideFor
      ? (options.failActivation ?? 'armed')
      : options.activation ?? 'disarmed';
    const bytes = sessionLogFixture(binding, phase, activation, options.extraSequence ?? 0);
    const actualHash = sha256(bytes);
    const lastSequence = options.extraSequence !== undefined && options.extraSequence > 0 ? 3 + options.extraSequence : 3;
    const tail = options.opaque
      ? { kind: 'opaque' as const, bytes: bytes.byteLength, sha256: actualHash, lastSequence: null }
      : { kind: 'jsonl-seq-v1' as const, bytes: bytes.byteLength, sha256: actualHash, lastSequence };
    const tamper = options.tamperBytes === true;
    snapshots.push({
      goalId: binding.goalId,
      sessionId: binding.sessionId,
      goalRef: binding.goalRef ?? { id: `native-${binding.goalId}`, revision: 1 },
      phase,
      activation,
      binding: {
        ownerId: binding.ownerId,
        scope: binding.scope,
        cwd: binding.cwd,
        metadataVersion: binding.metadataVersion,
        completionCriteriaHash: binding.completionCriteriaHash,
      },
      logPath: `/synthetic/sessions/${binding.sessionId}.jsonl`,
      bytes: tamper ? Buffer.concat([bytes, Buffer.from('tampered\n')]) : bytes,
      expected: { bytes: bytes.byteLength, sha256: actualHash },
      logFormat: options.opaque ? 'opaque' : 'jsonl-seq-v1',
      durableTail: tail,
      flush: {
        kind: 'host-flush',
        acknowledged: true,
        durableTail: tail,
        observedAt: options.capturedAt ?? clock.current(),
      },
      projection: {
        projectionId: 'shiyu-goal-state',
        schemaVersion: 1,
        minimumReaderVersion: options.projectionMinimumReaderVersion ?? 1,
        digest: options.tamperProjection ? sha256('tampered-projection') : projection.digest,
        configSha256: projection.configSha256,
      },
      projectionDefinition: projection.definition,
      projectionConfig: projection.config,
      plugin: { dshVersion: '0.2.1-rc.5', shiyuVersion: '0.1.0-test' },
    });
  }
  return {
    snapshots,
    quiescenceEvidence: options.quiescenceEvidence ?? 'synthetic: goal writers frozen by fixture barrier',
    capturedAt: options.capturedAt ?? clock.current(),
  };
};

export interface MemoryFixtureOptions {
  records?: { id: string; body: string }[];
  tombstoneWatermark?: number;
  baselineId?: string;
  capturedAt?: string;
  objectRefs?: string[];
  tamperArchive?: boolean;
  tamperManifestHash?: boolean;
  exportThrows?: boolean;
}

export const defaultMemoryRecords = (): { id: string; body: string }[] => [
  { id: 'memory-visible-1', body: 'synthetic visible memory one' },
  { id: 'memory-visible-2', body: 'synthetic visible memory two' },
  { id: 'memory-deleted-if-tombstoned', body: 'synthetic memory that a deletion ledger can remove' },
];

export interface MemoryExportFixtureResult {
  result: MemoryExportResult;
}

export const buildMemoryExport = async (
  stagingDirectory: string,
  clock: MutableClock,
  control: ControlWatermarks,
  options: MemoryFixtureOptions = {},
): Promise<MemoryExportResult> => {
  const records = options.records ?? defaultMemoryRecords();
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  const archiveLines = records.map((record) => JSON.stringify({ memoryId: record.id, body: record.body, sha256: sha256(record.body) }));
  const archiveBytes = Buffer.from(`${archiveLines.join('\n')}\n`);
  const indexLines = records.map((record) => JSON.stringify({ ref: record.id, kind: 'memory-source', sha256: sha256(record.body) }));
  const indexBytes = Buffer.from(`${indexLines.join('\n')}\n`);
  const archiveFile = 'archive.jsonl';
  const indexFile = 'index.jsonl';
  await writeFile(path.join(stagingDirectory, archiveFile), archiveBytes);
  await writeFile(path.join(stagingDirectory, indexFile), indexBytes);
  return {
    backendId: 'synthetic-memory',
    deploymentId: 'deployment-test-1',
    componentVersion: 'synthetic-1',
    dataSchema: 1,
    minimumReaderVersion: 1,
    capturedAt: options.capturedAt ?? clock.current(),
    watermark: {
      tombstoneWatermark: options.tombstoneWatermark ?? control.tombstoneWatermark,
      baselineId: options.baselineId ?? control.deletionBaselineId,
    },
    archive: {
      file: archiveFile,
      bytes: archiveBytes.byteLength,
      sha256: options.tamperArchive ? sha256('tampered archive') : sha256(archiveBytes),
    },
    recordIndex: { file: indexFile, bytes: indexBytes.byteLength, sha256: sha256(indexBytes), count: records.length },
    objectRefs: options.objectRefs ?? [],
  };
};

export interface WorldOptions {
  snapshotId?: string;
  rootId?: string;
  estimatedBytes?: number;
  reserveBytes?: number;
  control?: ControlFixtureOptions;
  goals?: GoalSessionsOptions;
  memory?: MemoryFixtureOptions;
  objects?: Map<string, Buffer>;
  missingObjectIds?: string[];
  capacity?: number[] | ((call: number) => number);
  acquireFails?: boolean;
  barrier?: Partial<RecoveryBarrierEvidence>;
  clock?: MutableClock;
  controlObjectRefs?: string[];
  runtimeManifest?: RuntimeManifest;
  /** Runs inside ControlSourcePort.acquire(), before the snapshot starts. */
  controlAcquireHook?: () => Promise<void> | void;
}

export interface World {
  root: string;
  stagingRoot: string;
  isolatedRoot: string;
  liveRoot: string;
  controlPath: string;
  control: ControlFixture;
  goalSessions: () => GoalSessionsOptions;
  clock: MutableClock;
  runtimeManifest: RuntimeManifest;
  rootId: string;
  environment: RecoveryEnvironment;
  captureService: CheckpointCaptureService;
  restoreService: IsolatedRestoreService;
  objectStore: Map<string, Buffer>;
  writes: { count: number };
  barrier: () => RecoveryBarrierEvidence;
  bundleDirectory: (snapshotId: string) => string;
  lastGoodFile: string;
  optionsCapacity: number[] | ((call: number) => number) | undefined;
  acquireFails: boolean;
  controlObjectRefs: string[];
  memoryFixture: MemoryFixtureOptions;
  missingObjectIds: string[];
  acquireHook: (() => Promise<void> | void) | undefined;
}

const baseEnvironment = async (world: World): Promise<RecoveryEnvironment> => {
  const capacityCalls: number[] = [];
  const capacityProbe: CapacityProbe = {
    freeBytes: async () => {
      const call = capacityCalls.length;
      capacityCalls.push(call);
      const plan = world.optionsCapacity ?? (() => 4 * 1024 * 1024 * 1024);
      const value = Array.isArray(plan) ? plan[Math.min(call, plan.length - 1)] : plan(call);
      return value ?? 0;
    },
  };
  void capacityCalls;
  const lease: ControlSourceLease = {
    databasePath: world.controlPath,
    rootId: world.rootId,
    generation: GENERATION,
    runtimeManifest: world.runtimeManifest,
    quiescenceEvidence: 'synthetic: target writers frozen by fixture control port',
    objectRefs: world.controlObjectRefs,
    release: async () => { world.writes.count += 1; },
  };
  const env: RecoveryEnvironment = {
    clock: world.clock,
    capacity: capacityProbe,
    control: {
      acquire: async () => {
        if (world.acquireFails) throw new Error('synthetic control unavailable');
        if (world.acquireHook) await world.acquireHook();
        return lease;
      },
    },
    goalSessions: {
      prepareCapture: async (goalIds: readonly string[]): Promise<GoalSessionCapture> => {
        const options = world.goalSessions();
        const extra = options.extraGoalId && !world.control.goalBindings.some((item) => item.goalId === options.extraGoalId)
          ? [{
              goalId: options.extraGoalId,
              sessionId: `shiyu-goal-${options.extraGoalId}`,
              goalRef: { id: `native-${options.extraGoalId}`, revision: 1 },
              ownerId: 'local-owner',
              scope: 'shiyu-goals',
              cwd: '/tmp/synthetic-goal-cwd',
              completionCriteriaHash: sha256(`criteria:${options.extraGoalId}`),
              metadataVersion: 1,
            } as GoalBindingFixture]
          : [];
        const fixture = buildGoalSessions([...world.control.goalBindings, ...extra], world.clock, options);
        const filtered = fixture.snapshots.filter((item) => goalIds.includes(item.goalId));
        return { quiescenceEvidence: fixture.quiescenceEvidence, capturedAt: fixture.capturedAt, sessions: filtered };
      },
    },
    memory: {
      export: async ({ stagingDirectory }): Promise<MemoryExportResult> => {
        const memory = world.memoryFixture;
        if (memory.exportThrows) throw new Error('synthetic memory export failed');
        return buildMemoryExport(stagingDirectory, world.clock, world.control.watermarks, memory);
      },
    },
    sharedObjects: {
      read: async (objectId: string): Promise<SharedObjectRead | undefined> => {
        if (world.missingObjectIds.includes(objectId)) return undefined;
        const bytes = world.objectStore.get(objectId);
        if (!bytes) return undefined;
        return { objectId, bytes, expected: { bytes: bytes.byteLength, sha256: sha256(bytes) } };
      },
    },
  };
  return env;
};

/** Build a fully synthetic world in a fresh temporary root. */
export const createWorld = async (t: TestContext | undefined, options: WorldOptions = {}): Promise<World> => {
  const root = await mkdtemp(path.join(tmpdir(), 'shiyu-recovery-'));
  const stagingRoot = path.join(root, 'staging');
  const isolatedRoot = path.join(root, 'isolated');
  const liveRoot = path.join(root, 'live');
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await mkdir(isolatedRoot, { recursive: true, mode: 0o700 });
  await mkdir(liveRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(liveRoot, 'sentinel.txt'), 'live-root-sentinel');
  const clock = options.clock ?? makeClock();
  const controlPath = path.join(root, 'control.sqlite');
  const control = await createControlFixture(controlPath, options.control);
  const runtimeManifest = options.runtimeManifest ?? runtimeManifestFixture();
  const rootId = options.rootId ?? FIXED_ROOT_ID;
  const goalSessionsOptions = options.goals ?? {};
  const memoryFixture = options.memory ?? {};
  const objectStore = options.objects ?? new Map<string, Buffer>();
  const missingObjectIds = options.missingObjectIds ?? [];
  const acquireFails = options.acquireFails ?? false;
  const acquireHook = options.controlAcquireHook;
  const controlObjectRefs = options.controlObjectRefs ?? [];
  const internal: World = {
    root,
    stagingRoot,
    isolatedRoot,
    liveRoot,
    controlPath,
    control,
    goalSessions: () => goalSessionsOptions,
    clock,
    runtimeManifest,
    rootId,
    environment: undefined as unknown as RecoveryEnvironment,
    captureService: undefined as unknown as CheckpointCaptureService,
    restoreService: undefined as unknown as IsolatedRestoreService,
    objectStore,
    writes: { count: 0 },
    optionsCapacity: options.capacity,
    acquireFails,
    controlObjectRefs,
    memoryFixture,
    missingObjectIds,
    acquireHook,
    barrier: (): RecoveryBarrierEvidence => ({
      source: 'synthetic-test',
      capturedAt: clock.current(),
      completeness: 'complete',
      deletion: {
        baselineId: control.watermarks.deletionBaselineId,
        tombstoneWatermark: control.watermarks.tombstoneWatermark,
      },
      authorization: { authEpoch: control.watermarks.authorizationEpoch },
      desiredState: { state: 'running', intentSeq: 1 },
      unavailableReasons: [],
      ...options.barrier,
    }),
    bundleDirectory: (snapshotId: string) => path.join(stagingRoot, 'bundles', snapshotId),
    lastGoodFile: path.join(stagingRoot, 'last-good.json'),
  };
  internal.environment = await baseEnvironment(internal);
  internal.captureService = new CheckpointCaptureService({
    environment: internal.environment,
    stagingRoot,
    reserveBytes: options.reserveBytes ?? 0,
  });
  internal.restoreService = new IsolatedRestoreService({ clock });
  if (t) t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return internal;
};

export const cleanupWorld = async (world: World): Promise<void> => {
  await rm(world.root, { recursive: true, force: true });
};

export const captureWorld = async (world: World, overrides: Partial<CaptureRequest> = {}): Promise<CaptureResult> => {
  const snapshotId = overrides.snapshotId ?? ('snapshot-' + world.clock.current().replace(/[^0-9]/g, '').slice(0, 14));
  return world.captureService.capture({
    snapshotId,
    rootId: overrides.rootId ?? world.rootId,
    estimatedBytes: overrides.estimatedBytes ?? 64 * 1024,
    faults: overrides.faults,
  });
};

/** Require a ready capture (test helper that makes later assertions readable). */
export const captureReady = async (world: World, overrides: Partial<CaptureRequest> = {}): Promise<{ snapshotId: string; bundleDirectory: string; manifestSha256: string }> => {
  const result = await captureWorld(world, overrides);
  if (result.status !== 'ready') {
    throw new Error(`expected ready capture, got ${result.status} ${JSON.stringify(result.failure)}`);
  }
  return { snapshotId: result.snapshotId, bundleDirectory: result.bundleDirectory, manifestSha256: result.manifestSha256 };
};

export const restoreWorld = async (
  world: World,
  bundleDirectory: string,
  overrides: Partial<RestoreRequest> & { targetName?: string } = {},
): Promise<RestoreResult> => {
  const targetRoot = overrides.targetRoot ?? path.join(world.isolatedRoot, overrides.targetName ?? `restore-${world.clock.current().replace(/[^0-9]/g, '').slice(0, 14)}`);
  return world.restoreService.restore({
    bundleDirectory,
    targetRoot,
    isolatedRoot: world.isolatedRoot,
    liveDataRoot: overrides.liveDataRoot ?? world.liveRoot,
    expectedRootId: overrides.expectedRootId ?? world.rootId,
    barrier: 'barrier' in overrides ? overrides.barrier : world.barrier(),
    deletionLedger: overrides.deletionLedger,
  });
};

/** Build a sealed deletion ledger for "deletions happened after the snapshot". */
export const ledgerFixture = (from: number, to: number, refs: string[], baselineId = FIXED_DELETION_BASELINE): DeletionLedger => {
  const entries = [];
  for (let watermark = from + 1; watermark <= to; watermark++) {
    entries.push({
      watermark,
      refs: watermark === to ? refs : [refs[Math.min(watermark - from - 1, refs.length - 1)] ?? 'unrelated-ref'],
      reasonCode: 'OWNER_DELETION',
      recordedAt: FIXED_BASE,
    });
  }
  return sealDeletionLedger({ baselineId, fromWatermark: from, toWatermark: to, entries });
};

export interface RejectedBundleCase {
  caseId: string;
  expectedViolation: string;
  violations: string[];
  rejected: boolean;
}

/** Read a captured bundle manifest and return a structured view for assertions. */
export const readManifest = async (bundleDirectory: string) => (await readBundleManifest(bundleDirectory)).bundle;

export const readControlFixtureFacts = (world: World) => readControlFacts(world.controlPath);

export const verifyDirectory = async (directory: string, requireReady = true) => verifyBundleDirectory(directory, { requireReady });

export const readSentinel = async (world: World): Promise<string> => readFile(path.join(world.liveRoot, 'sentinel.txt'), 'utf8');

export const captureFailureCode = (result: CaptureResult): string => {
  if (result.status === 'ready') return 'READY';
  return result.failure.code;
};

export const captureFailureStatus = (result: CaptureResult): CaptureFailureStatus => {
  if (result.status === 'ready') throw new Error('ready capture has no failure status');
  return result.status;
};

export const makeObject = (id: string, content: string): { id: string; bytes: Buffer; sha256: string } => {
  const bytes = Buffer.from(content);
  return { id, bytes, sha256: sha256(bytes) };
};
