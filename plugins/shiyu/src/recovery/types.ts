/**
 * H5-B1 offline checkpoint / isolated-restore contract types.
 *
 * This module is deliberately not wired into RuntimeService: it is the offline
 * half of the local CheckpointService and RecoveryCoordinator. Host-, memory-
 * and Goal-session-specific facts arrive through injected read-only ports so
 * this slice never claims a live-host or cross-component atomic snapshot.
 *
 * Vocabulary (see 架构与设计/A方案全景/06-预留空间/08-本地检查点/README.md):
 *  - commitSeq / stateVersion / tombstoneWatermark are independent versions and
 *    are never collapsed into one "global version".
 *  - captureTime is the conservative earliest required-component capture time,
 *    never the time publishing finished.
 *  - a BackupBundle records per-component durability evidence; it never claims
 *    a common cross-component section without an independently proven barrier.
 */

export const BUNDLE_SCHEMA_VERSION = 1;
export const RECOVERY_READER_VERSION = 1;
export const COMPONENT_MANIFEST_SCHEMA_VERSION = 1;
export const RECOVERY_LOCK_SCHEMA_VERSION = 1;
export const GENERATION_RECORD_SCHEMA_VERSION = 1;
export const RESTORE_REPORT_SCHEMA_VERSION = 1;
export const STAGING_JOURNAL_SCHEMA_VERSION = 1;
export const DELETION_LEDGER_SCHEMA_VERSION = 1;

export const REQUIRED_COMPONENT_IDS = ['control', 'dsh-goal-sessions', 'memory', 'shared-objects'] as const;
export type ComponentId = (typeof REQUIRED_COMPONENT_IDS)[number];

/** Reader compatibility is per component; there is no single global version. */
export const SUPPORTED_COMPONENT_DATA_SCHEMAS: Readonly<Record<ComponentId, number>> = {
  control: 1,
  'dsh-goal-sessions': 1,
  memory: 1,
  'shared-objects': 1,
};

export type BundleStatus = 'creating' | 'ready' | 'failed' | 'incomplete';
export type BundleComponentStatus = 'complete' | 'failed';
export type NativeGoalPhase = 'active' | 'paused' | 'blocked' | 'complete';
export type GoalActivation = 'armed' | 'disarmed';
export type GoalCommandStatus = 'pending' | 'unknown' | 'confirmed' | 'rejected';
export type InFlightKind = 'goal-command' | 'effect' | 'budget-reservation' | 'memory-operation';

/** Trusted identity of one host/installation generation. Never derived from a database counter. */
export interface GenerationIdentity {
  installationGeneration: string;
  hostEpoch: string;
}

export interface RuntimeComponentVersion {
  componentId: string;
  version: string;
  upstreamCommit: string;
  patchDigest: string;
  dataSchema: number;
  minimumReaderVersion: number;
}

/** Versions/config needed to interpret every component. Secrets are references only. */
export interface RuntimeManifest {
  dshVersion: string;
  dshCommit: string;
  nodeVersion: string;
  nodePlatform: string;
  nodeArch: string;
  sqliteVersion: string;
  components: RuntimeComponentVersion[];
}

export interface GoalRef {
  id: string;
  revision: number;
}

export interface LogTailIdentity {
  /** Offline-verifiable tail encoding. `opaque` means only bytes+sha256 can be checked. */
  kind: 'jsonl-seq-v1' | 'opaque';
  bytes: number;
  sha256: string;
  /** Only present when the persistence API exposes a durable sequence. */
  lastSequence: number | null;
}

export interface FlushEvidence {
  kind: 'host-flush' | 'maintenance-window' | 'quiescent-copy';
  acknowledged: boolean;
  durableTail: LogTailIdentity;
  observedAt: string;
}

export interface ProjectionDefinition {
  projectionId: string;
  schemaVersion: number;
  minimumReaderVersion: number;
  /** sha256 of the projection definition bytes. */
  digest: string;
  /** sha256 of the projection configuration bytes. */
  configSha256: string;
}

export interface GoalSessionBindingRecord {
  ownerId: string;
  scope: string;
  cwdHash: string;
  metadataVersion: number;
  completionCriteriaHash: string;
}

export interface GoalSessionRecord {
  goalId: string;
  sessionId: string;
  goalRef: GoalRef;
  phase: NativeGoalPhase;
  /** Activation as observed at capture. Restore never re-arms from this value. */
  activation: GoalActivation;
  binding: GoalSessionBindingRecord;
  logFile: string;
  logBytes: number;
  logSha256: string;
  logTail: LogTailIdentity;
  logFormat: 'jsonl-seq-v1' | 'opaque';
  projection: ProjectionDefinition;
  projectionDefinitionFile: string;
  projectionConfigFile: string;
  plugin: { dshVersion: string; shiyuVersion: string };
  flush: FlushEvidence;
  capturedAt: string;
}

export interface SharedObjectRecord {
  objectId: string;
  file: string;
  bytes: number;
  sha256: string;
}

export interface InFlightRecord {
  kind: InFlightKind;
  id: string;
  /** This is the captured component state, never a reconciled final business result. */
  status: string;
  component: 'control' | 'memory' | 'device';
}

export interface ControlGoalBindingRecord {
  goalId: string;
  sessionId: string;
  goalRef: GoalRef | null;
  metadataVersion: number;
  ownerId: string;
  scope: string;
  cwdHash: string;
  completionCriteriaHash: string;
  commandStatus: 'none' | GoalCommandStatus;
  commandOperation: string | null;
}

/** Actual watermarks read from the completed control snapshot (never from live memory). */
export interface ControlWatermarks {
  commitSeq: number;
  stateVersion: number;
  tombstoneWatermark: number;
  deletionBaselineId: string;
  authorizationEpoch: number;
}

export interface ControlComponentManifest {
  schemaVersion: number;
  componentId: 'control';
  databaseFile: string;
  databaseBytes: number;
  databaseSha256: string;
  /** Both checks are run against the staged snapshot before the bundle can be ready. */
  integrity: { quickCheck: 'ok'; foreignKeyCheck: 'ok' };
  watermarks: ControlWatermarks;
  goalBindings: ControlGoalBindingRecord[];
  inFlight: InFlightRecord[];
  objectRefs: string[];
  capturedAt: string;
}

export interface GoalSessionsComponentManifest {
  schemaVersion: number;
  componentId: 'dsh-goal-sessions';
  sessions: GoalSessionRecord[];
  /** Projection/plugin version facts needed to interpret the logs. */
  versions: RuntimeComponentVersion[];
  capturedAt: string;
}

export interface MemoryRecordRef {
  ref: string;
  kind: 'memory-source' | 'media' | 'source-file';
  sha256: string | null;
}

export interface MemoryComponentManifest {
  schemaVersion: number;
  componentId: 'memory';
  backend: { backendId: string; deploymentId: string };
  componentVersion: string;
  /**
   * The memory export's own watermark. It can lag the control deletion ledger
   * when deletion propagation is still pending; capture records the relation
   * and restore requires the latest ledger before opening a read view.
   */
  watermark: { tombstoneWatermark: number; baselineId: string };
  archiveFile: string;
  archiveBytes: number;
  archiveSha256: string;
  recordIndexFile: string;
  recordIndexBytes: number;
  recordIndexSha256: string;
  recordCount: number;
  objectRefs: string[];
  capturedAt: string;
}

export interface SharedObjectsComponentManifest {
  schemaVersion: number;
  componentId: 'shared-objects';
  objects: SharedObjectRecord[];
  /** Every object referenced by the other components must be present here. */
  referencedBy: { componentId: 'control' | 'memory'; objectIds: string[] }[];
  capturedAt: string;
}

export type ComponentManifest =
  | ControlComponentManifest
  | GoalSessionsComponentManifest
  | MemoryComponentManifest
  | SharedObjectsComponentManifest;

/** One entry in the top-level bundle component vector. */
export interface BundleComponent {
  componentId: ComponentId;
  status: BundleComponentStatus;
  upstreamCommit: string;
  patchDigest: string;
  dataSchema: number;
  minimumReaderVersion: number;
  snapshotRef: string;
  manifestRef: string;
  manifestSha256: string;
  /** Component's own actual revision when it exposes one; null means "use actualRevision". */
  watermark: number | null;
  /** Verifiable local revision/evidence when there is no numeric component watermark. */
  actualRevision: string | null;
  capturedAt: string;
  quiescenceEvidence: string;
  failureCodes: string[];
}

export interface ObjectManifestRef {
  ref: string;
  sha256: string;
  bytes: number;
  objectCount: number;
}

export interface BundleFailure {
  code: string;
  componentId: ComponentId | null;
  message: string;
}

/** Per-component durability evidence; never a cross-component atomicity claim. */
export interface BundleDurability {
  /** Literal false: this module never proves a common cross-component section. */
  crossComponentCommonSection: false;
  perComponent: { componentId: ComponentId; evidence: string }[];
}

export interface BackupBundle {
  schemaVersion: number;
  bundleSchemaVersion: number;
  minimumReaderVersion: number;
  snapshotId: string;
  rootId: string;
  captureTime: string;
  completedAt: string;
  status: BundleStatus;
  /** Always true until a host-verified cross-component barrier exists. */
  reconcileRequired: boolean;
  /** Null only for failed/incomplete bundles that never reached the fact. */
  generation: GenerationIdentity | null;
  runtimeManifest: RuntimeManifest | null;
  control: ControlWatermarks | null;
  components: BundleComponent[];
  objectManifest: ObjectManifestRef | null;
  durability: BundleDurability;
  failure: BundleFailure | null;
}

/** Capture journal inside a *.partial staging directory. */
export interface StagingJournal {
  schemaVersion: number;
  snapshotId: string;
  phase:
    | 'started'
    | 'capacity-checked'
    | 'control-snapshot'
    | 'goal-sessions'
    | 'memory-export'
    | 'shared-objects'
    | 'manifest-built'
    | 'publishing'
    | 'published'
    | 'interrupted';
  startedAt: string;
  updatedAt: string;
  estimatedBytes: number;
  freeBytes: number | null;
  attempts: number;
  lastErrorCode: string | null;
}

export interface LastGoodPointer {
  schemaVersion: number;
  snapshotId: string;
  manifestSha256: string;
  captureTime: string;
  updatedAt: string;
}

export interface RecoveryLockRecord {
  schemaVersion: number;
  lockId: string;
  snapshotId: string;
  targetRootHash: string;
  mode: 'maintenance';
  phase: 'restoring' | 'verified' | 'locked' | 'failed';
  dispatch: 'blocked';
  readView: 'closed' | 'read-only';
  acquiredAt: string;
  releasedAt: string | null;
  holder: 'recovery-module';
  /** This is an offline module record; it does not prove native host behavior. */
  hostProvenance: 'offline-module';
  reasonCode: string | null;
}

export type GenerationReason = 'capture' | 'restore' | 'fresh-install' | 'migration';

export interface GenerationTransition {
  schemaVersion: number;
  installationGeneration: string;
  hostEpoch: string;
  previous: GenerationIdentity | null;
  reason: GenerationReason;
  sourceSnapshotId: string | null;
  createdAt: string;
  /** False: a new generation record written offline is not host-verified activity. */
  verifiedByHost: false;
}

export interface RecoveryActivationRecord {
  schemaVersion: number;
  state: 'not-activated';
  maintenance: true;
  dispatch: 'blocked';
  readView: 'closed' | 'read-only';
  reasonCode: string;
  activeDataRootChanged: false;
  recordedAt: string;
}

/** Host-external barrier read by the recovery entry. Missing fields fail closed. */
export interface RecoveryBarrierEvidence {
  source: 'host-external-control-record' | 'synthetic-test';
  capturedAt: string;
  completeness: 'complete' | 'partial' | 'unavailable';
  deletion: { baselineId: string; tombstoneWatermark: number } | null;
  authorization: { authEpoch: number } | null;
  desiredState: { state: 'running' | 'paused' | 'stopped'; intentSeq: number } | null;
  unavailableReasons: string[];
}

/** Latest deletion ledger used to bridge a bundle snapshot to a newer watermark. */
export interface DeletionLedger {
  schemaVersion: number;
  baselineId: string;
  fromWatermark: number;
  toWatermark: number;
  entries: { watermark: number; refs: string[]; reasonCode: string; recordedAt: string }[];
  ledgerSha256: string;
}

export interface MemoryDeletionApplication {
  ledgerApplied: boolean;
  appliedEntries: number;
  removedRefs: number;
  visibleRefs: number;
  /** A verified restore must report false; a failed restore may record detection. */
  resurrectionDetected: boolean;
}

export type RestoreStatus = 'verified' | 'locked' | 'failed';
export type CheckStatus = 'pass' | 'fail' | 'unknown';

export interface RestoreCheck {
  checkId: string;
  status: CheckStatus;
  componentId: ComponentId | null;
}

export interface RestoreComponentCheck {
  componentId: ComponentId;
  manifestValid: boolean;
  hashVerified: boolean;
  integrity: 'ok' | 'failed' | 'not-checked';
}

export interface RestoredGoalCheck {
  goalId: string;
  sessionId: string;
  logHashVerified: boolean;
  tailVerified: boolean;
  restoredActivation: GoalActivation;
  /** Old armed state never survives a restore. */
  effectiveActivation: 'disarmed';
  dispatch: 'blocked';
}

export interface RestoreBarrierCheck {
  completeness: RecoveryBarrierEvidence['completeness'];
  deletion: {
    baselineId: string;
    bundleWatermark: number;
    latestWatermark: number | null;
    relation: 'equal' | 'advanced-replayed' | 'advanced-unreplayed' | 'unavailable' | 'stale' | 'baseline-mismatch';
  };
  authorization: { bundleEpoch: number; latestEpoch: number | null; relation: 'current' | 'advanced' | 'stale' | 'unavailable' };
  desiredState: 'running' | 'paused' | 'stopped' | 'unavailable';
}

export interface RestoreReport {
  schemaVersion: number;
  reportId: string;
  snapshotId: string;
  bundleManifestSha256: string;
  mode: 'maintenance';
  dispatch: 'blocked';
  activate: 'not-activated';
  status: RestoreStatus;
  readView: 'closed' | 'read-only';
  reconcileRequired: boolean;
  /** Hash of the canonical target path. Reports never contain raw data-root paths. */
  targetRootHash: string;
  startedAt: string;
  endedAt: string;
  checks: RestoreCheck[];
  components: RestoreComponentCheck[];
  barrier: RestoreBarrierCheck;
  deletion: MemoryDeletionApplication;
  goals: RestoredGoalCheck[];
  unknown: { preserved: InFlightRecord[]; replayed: 0 };
  generation: GenerationTransition;
  activation: RecoveryActivationRecord;
  oldRoot: 'untouched';
  liveActivation: 'not-changed';
  failures: { code: string; componentId: ComponentId | null }[];
}

export type CaptureFailureStatus = 'failed' | 'incomplete';

export interface CaptureFailure {
  code: string;
  componentId: ComponentId | null;
  message: string;
}

export type CaptureResult =
  | {
      status: 'ready';
      snapshotId: string;
      bundleDirectory: string;
      manifest: BackupBundle;
      manifestSha256: string;
      lastGoodUpdated: boolean;
    }
  | {
      status: CaptureFailureStatus;
      snapshotId: string;
      failure: CaptureFailure;
      /** Present when a failed/incomplete manifest was durably recorded. */
      bundleDirectory: string | null;
      /** Present when a staging directory was left behind after an interruption. */
      partialDirectory: string | null;
      lastGoodUpdated: false;
    };

/** Offline verification surface over a restored, isolated root. Read-only. */
export interface RestoredInstanceState {
  snapshotId: string;
  rootId: string;
  generation: GenerationTransition;
  readView: 'closed' | 'read-only';
  control: {
    commitSeq: number;
    stateVersion: number;
    tombstoneWatermark: number;
    authorizationEpoch: number;
    integrity: 'ok' | 'failed';
  };
  goals: {
    goalId: string;
    sessionId: string;
    phase: NativeGoalPhase;
    activation: GoalActivation;
    effectiveActivation: 'disarmed';
    dispatch: 'blocked';
  }[];
  unknown: { preserved: InFlightRecord[]; replayed: 0 };
  memory: {
    visibleRecords: MemoryRecordRef[];
    removedRecordCount: number;
    tombstoneWatermark: number;
  };
}
