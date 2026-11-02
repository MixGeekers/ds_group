/**
 * Injected ports for the H5-B1 offline module.
 *
 * The future Runtime integration point is exactly here: the runtime owns the
 * trusted control data root, the native Goal Session service, the memory export
 * adapter and the object store; this module only receives read-only facts and
 * writes into a caller-provided staging root. No port may return a promise of
 * mutual exclusion that the runtime has not actually proven.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { WorkspaceInventory } from './types.js';
import type {
  ControlWatermarks,
  DeletionLedger,
  FlushEvidence,
  GenerationIdentity,
  GoalActivation,
  GoalRef,
  LogTailIdentity,
  NativeGoalPhase,
  ProjectionDefinition,
  RecoveryBarrierEvidence,
  RuntimeManifest,
} from './types.js';

export interface Clock {
  now(): Date;
}

export interface CapacityProbe {
  freeBytes(targetPath: string): Promise<number>;
}

export interface ControlSourceLease {
  /** Exact live control database path. The module opens it read-only itself. */
  databasePath: string;
  rootId: string;
  generation: GenerationIdentity;
  runtimeManifest: RuntimeManifest;
  /** Bounded description of how target writers were frozen for this capture. */
  quiescenceEvidence: string;
  /**
   * Read-only facts observed through the live control authority before the
   * backup. The captured snapshot must be at least this advanced; this is a
   * monotonic precheck, never a claim that writers were paused.
   */
  liveFacts?: { commitSeq: number; stateVersion: number; observedAt: string };
  /**
   * Object ids referenced by control-side rows that are not derivable from the
   * database schema in this slice (for example an object_refs table owned by a
   * later integration). The module still verifies every object's hash/size.
   */
  objectRefs: readonly string[];
  release(): Promise<void>;
}

/**
 * The runtime must already have frozen writers or entered a maintenance window
 * before `acquire()` resolves. Returning a lease does not itself prove silence.
 */
export interface ControlSourcePort {
  acquire(): Promise<ControlSourceLease>;
}

export interface GoalSessionSnapshot {
  goalId: string;
  sessionId: string;
  goalRef: GoalRef;
  phase: NativeGoalPhase;
  activation: GoalActivation;
  binding: { ownerId: string; scope: string; cwd: string; metadataVersion: number; completionCriteriaHash: string };
  /** Exact native Session log path, used only for evidence and identity, never decoded into prompts. */
  logPath: string;
  /** Exact durable bytes at the capture cut, read through a read-only handle. */
  bytes: Uint8Array;
  /** Independent expectations recorded by the port at the same read. */
  expected: { bytes: number; sha256: string };
  logFormat: 'jsonl-seq-v1' | 'opaque';
  durableTail: LogTailIdentity;
  flush: FlushEvidence;
  projection: ProjectionDefinition;
  projectionDefinition: Uint8Array;
  projectionConfig: Uint8Array;
  plugin: { dshVersion: string; shiyuVersion: string };
}

export interface GoalSessionCapture {
  quiescenceEvidence: string;
  capturedAt: string;
  sessions: GoalSessionSnapshot[];
  /**
   * Control bindings deliberately excluded from this capture (no native
   * GoalRef, no Session materialized, ...). Missing session without an
   * exclusion is a hard incomplete.
   */
  excluded?: import('./types.js').GoalSessionExclusion[];
}

/**
 * Called with the goal ids read from the completed control snapshot. A missing
 * id means the authoritative Goal Session log cannot be captured; a Bundle
 * containing such a gap must never become ready.
 */
export interface GoalSessionPort {
  prepareCapture(goalIds: readonly string[]): Promise<GoalSessionCapture>;
}

export interface MemoryExportRequest {
  stagingDirectory: string;
}

export interface MemoryExportResult {
  backendId: string;
  deploymentId: string;
  componentVersion: string;
  dataSchema: number;
  minimumReaderVersion: number;
  /** Conservative time when the memory export snapshot was taken. */
  capturedAt: string;
  watermark: { tombstoneWatermark: number; baselineId: string };
  archive: { file: string; bytes: number; sha256: string };
  recordIndex: { file: string; bytes: number; sha256: string; count: number };
  objectRefs: readonly string[];
}

/** A synthetic adapter writes its archive into stagingDirectory; a real Ombre adapter reuses build_export_archive_file. */
export interface MemoryExportPort {
  export(request: MemoryExportRequest): Promise<MemoryExportResult>;
}

export interface SharedObjectRead {
  objectId: string;
  bytes: Uint8Array;
  /** Optional independent expectation; when present a mismatch fails the capture. */
  expected?: { bytes: number; sha256: string };
}

export interface SharedObjectPort {
  read(objectId: string): Promise<SharedObjectRead | undefined>;
  /** Optional read-only observation of the host workspace root at capture time. */
  inventory?(): Promise<WorkspaceInventory>;
}

export interface BarrierReadRequest {
  bundleWatermark: number;
  bundleDeletionBaselineId: string;
  bundleAuthorizationEpoch: number;
}

/**
 * Reads the trusted host-external barrier (latest deletion ledger head,
 * authorization epoch, desired state). Returning undefined is "unavailable",
 * which must keep the recovery lock closed.
 */
export interface RecoveryBarrierPort {
  readLatest(request: BarrierReadRequest): Promise<RecoveryBarrierEvidence | undefined>;
}

/** Optional latest ledger reader; without a contiguous ledger a stale bundle stays locked. */
export interface DeletionLedgerPort {
  readSince(fromWatermark: number, toWatermark: number, baselineId: string): Promise<DeletionLedger | undefined>;
}

export interface ControlSnapshotInspection {
  watermarks: ControlWatermarks;
  integrity: { quickCheck: 'ok'; foreignKeyCheck: 'ok' };
}

/** Test-only handle for asserting no replay happened; product code has no dispatch port. */
export interface ReplayObserver {
  dispatches(): number;
}

export interface RecoveryEnvironment {
  clock: Clock;
  capacity: CapacityProbe;
  control: ControlSourcePort;
  goalSessions: GoalSessionPort;
  memory: MemoryExportPort;
  sharedObjects: SharedObjectPort;
  /** Used by restore; capture never reads it. */
  barrier?: RecoveryBarrierPort;
  /** Used by restore to bridge stale snapshots; capture never reads it. */
  deletionLedger?: DeletionLedgerPort;
}

/** Low-level database accessor kept out of the public port surface on purpose. */
export type ReadOnlyDatabaseFactory = (filename: string) => DatabaseSync;
