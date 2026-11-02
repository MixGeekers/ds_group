/**
 * Offline capture half of the local CheckpointService.
 *
 * One `capture()` call:
 *  1. freezes nothing by itself — it asks the injected control port for a
 *     lease whose owner (the future Runtime integration) has already frozen
 *     target writers or entered a maintenance window;
 *  2. copies the control SQLite database with `node:sqlite` `backup` and reads
 *     every published watermark from the *completed staged copy*;
 *  3. copies the exact durable Goal Session logs through the injected
 *     read-only port, verifying byte counts, hashes, tails, GoalRef and
 *     projection files;
 *  4. asks the injected memory export port for a component export, then
 *     verifies its archive, record index and references;
 *  5. copies and hashes every shared object referenced by control or memory;
 *  6. writes the two-level manifest (bundle + component manifests) and
 *     self-verifies it from real bytes before publishing.
 *
 * Failure discipline: a partial staging directory is never renamed to a
 * ready bundle; a failed/incomplete manifest is published only for evidence;
 * `last-good.json` is only updated by a bundle that passed every check and
 * the bundle self-verification. Per-component durability evidence is never
 * reported as a cross-component common snapshot.
 */
import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { RecoveryError, type RecoveryErrorCode } from './errors.js';
import {
  assertSafeRelativeRef,
  canonicalJson,
  ensureDir,
  fileEvidence,
  fileExists,
  hashCanonical,
  readJsonLines,
  resolveInside,
  sha256,
  sqliteIntegrity,
  writeBytesExclusive,
  writeJsonAtomic,
} from './files.js';
import { readControlFacts, type ControlFacts } from './control-facts.js';
import {
  assertValidGenerationIdentity,
  assertValidRuntimeManifest,
  validateBackupBundle,
  validateControlComponentManifest,
  validateGoalSessionsComponentManifest,
  validateLastGoodPointer,
  validateMemoryComponentManifest,
  validateSharedObjectsComponentManifest,
  validateStagingJournal,
} from './schema.js';
import { deriveSeqChain, verifyBundleDirectory } from './verify.js';
import {
  BUNDLE_SCHEMA_VERSION,
  COMPONENT_MANIFEST_SCHEMA_VERSION,
  RECOVERY_READER_VERSION,
  STAGING_JOURNAL_SCHEMA_VERSION,
  SUPPORTED_COMPONENT_DATA_SCHEMAS,
  type BackupBundle,
  type BundleComponent,
  type BundleFailure,
  type ComponentId,
  type ControlComponentManifest,
  type ControlWatermarks,
  type GenerationIdentity,
  type GoalSessionExclusion,
  type GoalSessionRecord,
  type GoalSessionsComponentManifest,
  type LastGoodPointer,
  type MemoryComponentManifest,
  type ObjectManifestRef,
  type RuntimeManifest,
  type SharedObjectRecord,
  type SharedObjectsComponentManifest,
  type WorkspaceInventory,
  type StagingJournal,
} from './types.js';
import type {
  CaptureResult,
  CaptureFailureStatus,
} from './types.js';
import type { ControlSourceLease, RecoveryEnvironment } from './ports.js';

export type CaptureStage =
  | 'after-control-snapshot'
  | 'after-goal-sessions'
  | 'after-memory-export'
  | 'after-shared-objects'
  | 'before-publish';

export interface CaptureFaultInjection {
  at: CaptureStage;
  /** fail = durably record a failed bundle; interrupt = simulate process death before publishing. */
  mode: 'fail' | 'interrupt';
}

export interface CaptureRequest {
  snapshotId: string;
  /** Root identity of the data root this capture belongs to; must match the lease. */
  rootId: string;
  /** Estimated bytes required by this capture; checked against free space before work starts. */
  estimatedBytes: number;
  faults?: CaptureFaultInjection;
}

export interface CaptureServiceOptions {
  environment: RecoveryEnvironment;
  /** Caller-owned staging root; must never be the live data root. */
  stagingRoot: string;
  /** Free bytes that must remain untouched after the capture. */
  reserveBytes?: number;
  /** Optional live data root guard: the staging root may not overlap it. */
  liveDataRoot?: string;
  /** Optional allow-list of absolute staging parents; when present the staging root must be inside one. */
  allowedStagingRoots?: readonly string[];
}

const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const COMPONENT_RUNTIME_IDS: Readonly<Record<ComponentId, string>> = {
  control: 'control-store',
  'dsh-goal-sessions': 'projection',
  memory: 'memory-backend',
  'shared-objects': 'object-store',
};

const INCOMPLETE_CODES: ReadonlySet<RecoveryErrorCode> = new Set<RecoveryErrorCode>([
  'REQUIRED_COMPONENT_MISSING',
  'MISSING_WATERMARK',
  'MISSING_GOAL_SESSION',
  'UNDECLARED_GOAL_SESSION',
  'MISSING_PROJECTION',
  'MISSING_LOG_TAIL',
  'GOAL_REF_MISMATCH',
  'OBJECT_CLOSURE_INCOMPLETE',
  'DELETION_BASELINE_MISMATCH',
  'DELETION_WATERMARK_STALE',
  'GOAL_SESSION_EXPORT_UNAVAILABLE',
  'PROJECTION_EXPORT_UNAVAILABLE',
  'MEMORY_EXPORT_UNAVAILABLE',
  'CONTROL_FACTS_UNAVAILABLE',
  'WORKSPACE_INVENTORY_UNAVAILABLE',
  'LOG_FORMAT_NOT_OFFLINE_VERIFIABLE',
]);

const encoder = new TextEncoder();

/**
 * Validate the read-only workspace inventory supplied by a host port. The
 * inventory is evidence-only (it is not copied into the bundle), but every
 * listed path/hash must still be bounded and self-consistent.
 */
const validateWorkspaceInventory = (value: WorkspaceInventory): WorkspaceInventory => {
  const fail = (message: string): never => { throw new RecoveryError('WORKSPACE_INVENTORY_UNAVAILABLE', message, 'shared-objects'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Workspace inventory is not an object');
  if (typeof value.rootId !== 'string' || !/^[a-f0-9]{64}$/.test(value.rootId)) fail('Workspace inventory rootId is invalid');
  if (!Array.isArray(value.files) || value.files.length > 5000) fail('Workspace inventory file list is missing or too large');
  if (typeof value.truncated !== 'boolean') fail('Workspace inventory truncated flag is invalid');
  if (!Number.isSafeInteger(value.excludedCount) || value.excludedCount < 0) fail('Workspace inventory exclusion count is invalid');
  let total = 0;
  const seen = new Set<string>();
  const files = value.files.map((file) => {
    if (!file || typeof file !== 'object') fail('Workspace inventory entry is not an object');
    assertSafeRelativeRef(file.relativePath, 'workspace inventory path');
    if (seen.has(file.relativePath)) fail('Workspace inventory contains a duplicate path');
    seen.add(file.relativePath);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('Workspace inventory entry size is invalid');
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('Workspace inventory entry hash is invalid');
    total += file.bytes;
    return { relativePath: file.relativePath, bytes: file.bytes, sha256: file.sha256 };
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (typeof value.aggregateSha256 !== 'string' || sha256(canonicalJson(files)) !== value.aggregateSha256) {
    fail('Workspace inventory aggregate hash does not match its file list');
  }
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0) fail('Workspace inventory total is invalid');
  if (!value.truncated && total !== value.totalBytes) fail('Workspace inventory total does not match its file list');
  return { rootId: value.rootId, files, totalBytes: value.totalBytes, aggregateSha256: value.aggregateSha256, truncated: value.truncated, excludedCount: value.excludedCount };
};

/** Filesystem-safe deterministic stem for an externally supplied identifier. */
const fileStem = (id: string): string => `${id.replace(/[^A-Za-z0-9._-]/g, '_')}-${sha256(id).slice(0, 12)}`;

const isDirectory = async (target: string): Promise<boolean> => {
  try { return (await stat(target)).isDirectory(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const toCaptureFailure = (error: unknown): CaptureFailureStatus => error instanceof RecoveryError && INCOMPLETE_CODES.has(error.code)
  ? 'incomplete'
  : 'failed';

const describeFailure = (error: unknown): { code: string; componentId: ComponentId | null; message: string } => {
  if (error instanceof RecoveryError) {
    const componentId = error.componentId && ['control', 'dsh-goal-sessions', 'memory', 'shared-objects'].includes(error.componentId)
      ? error.componentId as ComponentId
      : null;
    return { code: error.code, componentId, message: error.message.slice(0, 300) };
  }
  const message = error instanceof Error ? error.message.slice(0, 300) : 'unknown capture failure';
  return { code: 'COMPONENT_FAILED', componentId: null, message };
};

interface AttemptContext {
  environment: RecoveryEnvironment;
  stagingRoot: string;
  bundlesRoot: string;
  lastGoodFile: string;
  reserveBytes: number;
  request: CaptureRequest;
  partialDir: string;
  finalDir: string;
}

class CaptureAttempt {
  private readonly env: RecoveryEnvironment;
  private readonly clock: { now(): Date };
  private readonly journal: StagingJournal;
  private lease: ControlSourceLease | undefined;
  private generation: GenerationIdentity | null = null;
  private runtimeManifest: RuntimeManifest | null = null;
  private watermarks: ControlWatermarks | null = null;
  private controlFacts: ControlFacts | null = null;
  private controlObjectRefs: string[] = [];
  private memoryObjectRefs: string[] = [];
  private components: BundleComponent[] = [];
  private objectManifest: ObjectManifestRef | null = null;
  private manifestSha256: string | null = null;

  constructor(private readonly ctx: AttemptContext) {
    this.env = ctx.environment;
    this.clock = ctx.environment.clock;
    this.journal = {
      schemaVersion: STAGING_JOURNAL_SCHEMA_VERSION,
      snapshotId: ctx.request.snapshotId,
      phase: 'started',
      startedAt: this.now(),
      updatedAt: this.now(),
      estimatedBytes: ctx.request.estimatedBytes,
      freeBytes: null,
      attempts: 1,
      lastErrorCode: null,
    };
  }

  private now(): string { return this.clock.now().toISOString(); }

  private async writeJournal(phase: StagingJournal['phase']): Promise<void> {
    this.journal.phase = phase;
    this.journal.updatedAt = this.now();
    const validation = validateStagingJournal(this.journal);
    if (!validation.ok) throw new RecoveryError('INVALID_SCHEMA', `Invalid staging journal: ${validation.violations[0]?.message ?? 'unknown'}`);
    await writeJsonAtomic(path.join(this.ctx.partialDir, 'capture-journal.json'), this.journal);
  }

  private async checkCapacity(initial: boolean): Promise<void> {
    const free = await this.env.capacity.freeBytes(this.ctx.stagingRoot);
    this.journal.freeBytes = free;
    if (initial) await this.writeJournal('capacity-checked');
    else await this.writeJournal(this.journal.phase);
    if (free < this.ctx.reserveBytes) {
      throw new RecoveryError('CAPACITY_INSUFFICIENT',
        `Only ${free} bytes free; reserve of ${this.ctx.reserveBytes} bytes must remain`);
    }
    if (initial && free < this.ctx.request.estimatedBytes + this.ctx.reserveBytes) {
      throw new RecoveryError('CAPACITY_INSUFFICIENT',
        `Capture needs ${this.ctx.request.estimatedBytes} bytes plus a ${this.ctx.reserveBytes} byte reserve; only ${free} bytes are free`);
    }
  }

  private runtimeEntry(id: ComponentId) {
    if (!this.runtimeManifest) throw new RecoveryError('CONTROL_UNAVAILABLE', 'Runtime manifest is unavailable');
    const runtimeId = COMPONENT_RUNTIME_IDS[id];
    const entry = this.runtimeManifest.components.find((item) => item.componentId === runtimeId);
    if (!entry) throw new RecoveryError('MISSING_WATERMARK', `Runtime manifest has no version entry for ${runtimeId}`, id);
    if (entry.dataSchema !== SUPPORTED_COMPONENT_DATA_SCHEMAS[id]) {
      throw new RecoveryError('INCOMPATIBLE_VERSION', `Unsupported ${id} data schema ${entry.dataSchema}`, id);
    }
    if (entry.minimumReaderVersion > RECOVERY_READER_VERSION) {
      throw new RecoveryError('INCOMPATIBLE_VERSION', `${id} requires a newer recovery reader`, id);
    }
    return entry;
  }

  private componentEntry(
    componentId: ComponentId,
    manifestRef: string,
    manifestSha256: string,
    snapshotRef: string,
    capturedAt: string,
    quiescenceEvidence: string,
    watermark: number | null,
    actualRevision: string | null,
  ): BundleComponent {
    const version = this.runtimeEntry(componentId);
    return {
      componentId,
      status: 'complete',
      upstreamCommit: version.upstreamCommit,
      patchDigest: version.patchDigest,
      dataSchema: SUPPORTED_COMPONENT_DATA_SCHEMAS[componentId],
      minimumReaderVersion: version.minimumReaderVersion,
      snapshotRef,
      manifestRef,
      manifestSha256,
      watermark,
      actualRevision,
      capturedAt,
      quiescenceEvidence,
      failureCodes: [],
    };
  }

  private async writeComponentManifest(
    filename: string,
    manifest: unknown,
    validate: (value: unknown) => { ok: boolean; violations: { message: string }[] },
  ): Promise<{ bytes: number; sha256: string }> {
    const validation = validate(manifest);
    if (!validation.ok) {
      throw new RecoveryError('INVALID_SCHEMA', `Invalid component manifest ${filename}: ${validation.violations[0]?.message ?? 'unknown'}`);
    }
    const bytes = encoder.encode(`${canonicalJson(manifest)}\n`);
    await writeBytesExclusive(filename, bytes);
    return { bytes: bytes.byteLength, sha256: sha256(bytes) };
  }

  private async inject(stage: CaptureStage): Promise<void> {
    const fault = this.ctx.request.faults;
    if (!fault || fault.at !== stage) return;
    if (fault.mode === 'interrupt') {
      this.journal.lastErrorCode = 'STAGING_INTERRUPTED';
      await this.writeJournal(phaseForStage(stage));
      throw new RecoveryError('STAGING_INTERRUPTED', `Capture interrupted before publish at ${stage}`);
    }
    throw new RecoveryError('INJECTED_FAILURE', `Injected capture failure at ${stage}`, componentForStage(stage) ?? undefined);
  }

  private async captureControl(): Promise<void> {
    const lease = await this.env.control.acquire();
    this.lease = lease;
    if (lease.rootId !== this.ctx.request.rootId) {
      throw new RecoveryError('ROOT_MISMATCH', 'Control lease root identity does not match the capture request');
    }
    this.generation = assertValidGenerationIdentity(lease.generation);
    this.runtimeManifest = assertValidRuntimeManifest(lease.runtimeManifest);
    for (const id of ['control', 'dsh-goal-sessions', 'memory', 'shared-objects'] as const) this.runtimeEntry(id);
    if (typeof lease.quiescenceEvidence !== 'string' || !lease.quiescenceEvidence.trim()) {
      throw new RecoveryError('MISSING_WATERMARK', 'Control lease carries no writer-quiescence evidence', 'control');
    }
    const directory = path.join(this.ctx.partialDir, 'components', 'control');
    await ensureDir(directory);
    const databasePath = path.join(directory, 'control.sqlite');
    const source = new DatabaseSync(lease.databasePath, { readOnly: true });
    try {
      await backup(source, databasePath);
    } finally {
      source.close();
    }
    if (!await fileExists(databasePath)) throw new RecoveryError('COMPONENT_FAILED', 'SQLite online backup did not produce a control snapshot', 'control');
    const database = await fileEvidence(databasePath);
    const integrity = await sqliteIntegrity(databasePath);
    const facts = readControlFacts(databasePath);
    const liveFacts = this.lease.liveFacts;
    let livePrecheck: ControlComponentManifest['livePrecheck'];
    if (liveFacts !== undefined) {
      if (!Number.isSafeInteger(liveFacts.commitSeq) || liveFacts.commitSeq < 0
        || !Number.isSafeInteger(liveFacts.stateVersion) || liveFacts.stateVersion < 1
        || typeof liveFacts.observedAt !== 'string' || !Number.isFinite(Date.parse(liveFacts.observedAt))) {
        throw new RecoveryError('CONTROL_FACTS_UNAVAILABLE', 'Control lease live facts are malformed', 'control');
      }
      if (facts.watermarks.commitSeq < liveFacts.commitSeq || facts.watermarks.stateVersion < liveFacts.stateVersion) {
        throw new RecoveryError('COMPONENT_FAILED',
          'Completed control snapshot is older than the live precheck facts; the backup cannot be the requested capture', 'control');
      }
      livePrecheck = { commitSeq: liveFacts.commitSeq, stateVersion: liveFacts.stateVersion, observedAt: liveFacts.observedAt };
    }
    this.controlFacts = facts;
    this.watermarks = facts.watermarks;
    const capturedAt = this.now();
    const manifest: ControlComponentManifest = {
      schemaVersion: COMPONENT_MANIFEST_SCHEMA_VERSION,
      componentId: 'control',
      databaseFile: 'components/control/control.sqlite',
      databaseBytes: database.bytes,
      databaseSha256: database.sha256,
      integrity,
      watermarks: facts.watermarks,
      goalBindings: facts.goalBindings,
      inFlight: facts.inFlight,
      objectRefs: [...new Set(lease.objectRefs)].sort(),
      ...(livePrecheck ? { livePrecheck } : {}),
      capturedAt,
    };
    const written = await this.writeComponentManifest(path.join(directory, 'manifest.json'), manifest, validateControlComponentManifest);
    this.components.push(this.componentEntry('control', 'components/control/manifest.json', written.sha256,
      'components/control', capturedAt, `${lease.quiescenceEvidence};sqlite-online-backup`, facts.watermarks.commitSeq, null));
    this.controlObjectRefs = [...new Set(lease.objectRefs)].sort();
    await this.writeJournal('control-snapshot');
  }

  private async captureGoalSessions(): Promise<void> {
    const facts = this.controlFacts;
    if (!facts) throw new RecoveryError('COMPONENT_FAILED', 'Goal sessions cannot be captured before control facts', 'dsh-goal-sessions');
    const goalIds = facts.goalBindings.map((binding) => binding.goalId).sort();
    const batch = await this.env.goalSessions.prepareCapture(goalIds);
    const now = this.now();
    if (typeof batch.capturedAt !== 'string' || !Number.isFinite(Date.parse(batch.capturedAt)) || new Date(batch.capturedAt).toISOString() !== batch.capturedAt) {
      throw new RecoveryError('INVALID_SCHEMA', 'Goal Session capture time is not canonical UTC', 'dsh-goal-sessions');
    }
    if (Date.parse(batch.capturedAt) > this.clock.now().getTime() + 5 * 60_000) {
      throw new RecoveryError('INVALID_SCHEMA', 'Goal Session capture time is in the future', 'dsh-goal-sessions');
    }
    if (typeof batch.quiescenceEvidence !== 'string' || !batch.quiescenceEvidence.trim()) {
      throw new RecoveryError('MISSING_LOG_TAIL', 'Goal Session capture carries no durability/quiescence evidence', 'dsh-goal-sessions');
    }
    const byGoal = new Map(batch.sessions.map((item) => [item.goalId, item]));
    const expected = new Set(goalIds);
    const exclusions: GoalSessionExclusion[] = [];
    for (const exclusion of batch.excluded ?? []) {
      const binding = facts.goalBindings.find((item) => item.goalId === exclusion.goalId);
      if (!binding) throw new RecoveryError('UNDECLARED_GOAL_SESSION', `Excluded goal ${exclusion.goalId} is not a captured GoalBinding`, 'dsh-goal-sessions');
      if (exclusion.sessionId !== binding.sessionId) {
        throw new RecoveryError('GOAL_REF_MISMATCH', `Excluded goal ${exclusion.goalId} Session identity does not match the control binding`, 'dsh-goal-sessions');
      }
      if (typeof exclusion.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(exclusion.reasonCode)
        || typeof exclusion.detail !== 'string' || !exclusion.detail.trim() || exclusion.detail.length > 300) {
        throw new RecoveryError('INVALID_SCHEMA', 'Goal Session exclusion reason is malformed', 'dsh-goal-sessions');
      }
      if (byGoal.has(exclusion.goalId)) throw new RecoveryError('INVALID_SCHEMA', 'A goal cannot be both captured and excluded', 'dsh-goal-sessions');
      if (exclusions.some((item) => item.goalId === exclusion.goalId)) throw new RecoveryError('INVALID_SCHEMA', 'Duplicate Goal Session exclusion', 'dsh-goal-sessions');
      exclusions.push({ goalId: exclusion.goalId, sessionId: exclusion.sessionId, reasonCode: exclusion.reasonCode, detail: exclusion.detail });
    }
    for (const goalId of goalIds) {
      if (!byGoal.has(goalId) && !exclusions.some((item) => item.goalId === goalId)) {
        throw new RecoveryError('MISSING_GOAL_SESSION', `GoalBinding ${goalId} has no authoritative Session log in the capture`, 'dsh-goal-sessions');
      }
    }
    for (const item of batch.sessions) {
      if (!expected.has(item.goalId)) {
        throw new RecoveryError('UNDECLARED_GOAL_SESSION', `Goal Session ${item.sessionId} is not declared by the captured GoalBindings`, 'dsh-goal-sessions');
      }
    }
    exclusions.sort((a, b) => a.goalId.localeCompare(b.goalId));
    const directory = path.join(this.ctx.partialDir, 'components', 'dsh-goal-sessions');
    const sessionsDir = path.join(directory, 'sessions');
    await ensureDir(sessionsDir);
    const records: GoalSessionRecord[] = [];
    for (const session of batch.sessions) {
      const binding = facts.goalBindings.find((item) => item.goalId === session.goalId)!;
      if (session.sessionId !== binding.sessionId) {
        throw new RecoveryError('GOAL_REF_MISMATCH', `Goal Session identity mismatch for ${session.goalId}`, 'dsh-goal-sessions');
      }
      if (binding.goalRef !== null
        && (session.goalRef.id !== binding.goalRef.id || session.goalRef.revision !== binding.goalRef.revision)) {
        throw new RecoveryError('GOAL_REF_MISMATCH', `GoalRef revision mismatch for ${session.goalId}`, 'dsh-goal-sessions');
      }
      if (!SAFE_ID.test(session.sessionId) || !SAFE_ID.test(session.goalId)) {
        throw new RecoveryError('INVALID_SCHEMA', 'Goal Session identifiers are not bounded identities', 'dsh-goal-sessions');
      }
      if (typeof session.logPath !== 'string' || !path.isAbsolute(session.logPath) || session.logPath.includes('\0')) {
        throw new RecoveryError('INVALID_SCHEMA', 'Goal Session port must return the exact absolute log path', 'dsh-goal-sessions');
      }
      const cwdHash = sha256(session.binding.cwd);
      if (cwdHash !== binding.cwdHash || session.binding.ownerId !== binding.ownerId
        || session.binding.scope !== binding.scope || session.binding.metadataVersion !== binding.metadataVersion
        || session.binding.completionCriteriaHash !== binding.completionCriteriaHash) {
        throw new RecoveryError('GOAL_REF_MISMATCH', `Goal Session binding does not match the control GoalBinding for ${session.goalId}`, 'dsh-goal-sessions');
      }
      const bytes = session.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        throw new RecoveryError('MISSING_LOG_TAIL', `Goal Session log for ${session.sessionId} is empty`, 'dsh-goal-sessions');
      }
      if (bytes.byteLength !== session.expected.bytes || sha256(bytes) !== session.expected.sha256) {
        throw new RecoveryError('HASH_MISMATCH', `Goal Session log for ${session.sessionId} does not match the port's independent expectation`, 'dsh-goal-sessions');
      }
      if (session.durableTail.bytes !== bytes.byteLength || session.durableTail.sha256 !== sha256(bytes)) {
        throw new RecoveryError('MISSING_LOG_TAIL', `Goal Session durable tail does not describe the captured bytes for ${session.sessionId}`, 'dsh-goal-sessions');
      }
      if (session.flush.acknowledged !== true
        || session.flush.durableTail.kind !== session.durableTail.kind
        || session.flush.durableTail.bytes !== session.durableTail.bytes
        || session.flush.durableTail.sha256 !== session.durableTail.sha256
        || session.flush.durableTail.lastSequence !== session.durableTail.lastSequence) {
        throw new RecoveryError('MISSING_LOG_TAIL', `Goal Session flush evidence is missing or inconsistent for ${session.sessionId}`, 'dsh-goal-sessions');
      }
      if (session.logFormat !== session.durableTail.kind) {
        throw new RecoveryError('MISSING_LOG_TAIL', `Goal Session log format and tail kind disagree for ${session.sessionId}`, 'dsh-goal-sessions');
      }
      if (session.logFormat === 'jsonl-seq-v1') {
        const derived = deriveSeqChain(Buffer.from(bytes));
        if (derived.lastSequence !== session.durableTail.lastSequence) {
          throw new RecoveryError('MISSING_LOG_TAIL', `Goal Session tail sequence mismatch for ${session.sessionId}`, 'dsh-goal-sessions');
        }
        if (derived.goalState === null
          || derived.goalState.id !== session.goalRef.id || derived.goalState.revision !== session.goalRef.revision
          || derived.goalState.phase !== session.phase || derived.goalState.activation !== session.activation) {
          throw new RecoveryError('GOAL_REF_MISMATCH', `Goal Session log state does not match the captured GoalRef/phase for ${session.sessionId}`, 'dsh-goal-sessions');
        }
      } else if (session.durableTail.lastSequence !== null) {
        throw new RecoveryError('MISSING_LOG_TAIL', `Opaque Goal Session tail must not invent a sequence for ${session.sessionId}`, 'dsh-goal-sessions');
      }
      if (session.projection.digest !== sha256(session.projectionDefinition)
        || session.projection.configSha256 !== sha256(session.projectionConfig)) {
        throw new RecoveryError('MISSING_PROJECTION', `Projection definition or configuration digest mismatch for ${session.sessionId}`, 'dsh-goal-sessions');
      }
      if (session.projection.minimumReaderVersion > RECOVERY_READER_VERSION) {
        throw new RecoveryError('INCOMPATIBLE_VERSION', `Projection requires a newer recovery reader for ${session.sessionId}`, 'dsh-goal-sessions');
      }
      const stem = fileStem(session.sessionId);
      const logName = `sessions/${stem}.jsonl`;
      const projectionName = `sessions/${stem}.projection.json`;
      const configName = `sessions/${stem}.config.json`;
      await writeBytesExclusive(path.join(sessionsDir, `${stem}.jsonl`), bytes);
      await writeBytesExclusive(path.join(sessionsDir, `${stem}.projection.json`), session.projectionDefinition);
      await writeBytesExclusive(path.join(sessionsDir, `${stem}.config.json`), session.projectionConfig);
      const written = await fileEvidence(path.join(sessionsDir, `${stem}.jsonl`));
      if (written.bytes !== bytes.byteLength || written.sha256 !== session.expected.sha256) {
        throw new RecoveryError('HASH_MISMATCH', `Staged Goal Session log bytes changed for ${session.sessionId}`, 'dsh-goal-sessions');
      }
      records.push({
        goalId: session.goalId,
        sessionId: session.sessionId,
        goalRef: session.goalRef,
        phase: session.phase,
        activation: session.activation,
        binding: {
          ownerId: session.binding.ownerId,
          scope: session.binding.scope,
          cwdHash,
          metadataVersion: session.binding.metadataVersion,
          completionCriteriaHash: session.binding.completionCriteriaHash,
        },
        logFile: `components/dsh-goal-sessions/${logName}`,
        logBytes: bytes.byteLength,
        logSha256: session.expected.sha256,
        logTail: session.durableTail,
        logFormat: session.logFormat,
        projection: session.projection,
        projectionDefinitionFile: `components/dsh-goal-sessions/${projectionName}`,
        projectionConfigFile: `components/dsh-goal-sessions/${configName}`,
        plugin: { dshVersion: session.plugin.dshVersion, shiyuVersion: session.plugin.shiyuVersion },
        flush: session.flush,
        capturedAt: batch.capturedAt,
      });
    }
    records.sort((a, b) => a.goalId.localeCompare(b.goalId));
    const manifest: GoalSessionsComponentManifest = {
      schemaVersion: COMPONENT_MANIFEST_SCHEMA_VERSION,
      componentId: 'dsh-goal-sessions',
      sessions: records,
      excludedBindings: exclusions,
      versions: [this.runtimeEntry('dsh-goal-sessions')],
      capturedAt: batch.capturedAt,
    };
    const written = await this.writeComponentManifest(path.join(directory, 'manifest.json'), manifest, validateGoalSessionsComponentManifest);
    const revision = hashCanonical(records.map((item) => ({ goalId: item.goalId, sessionId: item.sessionId, sha256: item.logSha256, bytes: item.logBytes })));
    const numeric = records.length === 0 ? null : records.reduce((max, item) => Math.max(max, item.logTail.lastSequence ?? 0), 0);
    this.components.push(this.componentEntry('dsh-goal-sessions', 'components/dsh-goal-sessions/manifest.json', written.sha256,
      'components/dsh-goal-sessions', batch.capturedAt, batch.quiescenceEvidence, numeric, `goal-sessions:${revision}`));
    await this.writeJournal('goal-sessions');
  }

  private async captureMemory(): Promise<void> {
    const control = this.watermarks;
    if (!control) throw new RecoveryError('COMPONENT_FAILED', 'Memory cannot be captured before control watermarks', 'memory');
    const directory = path.join(this.ctx.partialDir, 'components', 'memory');
    await ensureDir(directory);
    const result = await this.env.memory.export({ stagingDirectory: directory });
    if (result.dataSchema !== SUPPORTED_COMPONENT_DATA_SCHEMAS.memory) {
      throw new RecoveryError('INCOMPATIBLE_VERSION', `Unsupported memory data schema ${result.dataSchema}`, 'memory');
    }
    if (result.minimumReaderVersion > RECOVERY_READER_VERSION) {
      throw new RecoveryError('INCOMPATIBLE_VERSION', 'Memory component requires a newer recovery reader', 'memory');
    }
    if (!Number.isFinite(Date.parse(result.capturedAt)) || new Date(result.capturedAt).toISOString() !== result.capturedAt) {
      throw new RecoveryError('INVALID_SCHEMA', 'Memory capture time is not canonical UTC', 'memory');
    }
    const archiveRef = assertSafeRelativeRef(result.archive.file, 'memory archive');
    const indexRef = assertSafeRelativeRef(result.recordIndex.file, 'memory record index');
    const archiveEvidence = await fileEvidence(resolveInside(directory, archiveRef));
    if (archiveEvidence.bytes !== result.archive.bytes || archiveEvidence.sha256 !== result.archive.sha256) {
      throw new RecoveryError('HASH_MISMATCH', 'Memory export archive does not match the export manifest', 'memory');
    }
    const indexEvidence = await fileEvidence(resolveInside(directory, indexRef));
    if (indexEvidence.bytes !== result.recordIndex.bytes || indexEvidence.sha256 !== result.recordIndex.sha256) {
      throw new RecoveryError('HASH_MISMATCH', 'Memory record index does not match the export manifest', 'memory');
    }
    const indexEntries = await readJsonLines(resolveInside(directory, indexRef), { maxBytes: 64 * 1024 * 1024, maxLines: 500000 });
    if (indexEntries.length !== result.recordIndex.count) {
      throw new RecoveryError('COMPONENT_FAILED', 'Memory record index count does not match the export manifest', 'memory');
    }
    const refs = new Set<string>();
    for (const entry of indexEntries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new RecoveryError('COMPONENT_FAILED', 'Memory record index contains a non-object entry', 'memory');
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.ref !== 'string' || !SAFE_ID.test(record.ref) || refs.has(record.ref)) {
        throw new RecoveryError('COMPONENT_FAILED', 'Memory record index contains an invalid or duplicate ref', 'memory');
      }
      if (record.kind !== 'memory-source' && record.kind !== 'media' && record.kind !== 'source-file') {
        throw new RecoveryError('COMPONENT_FAILED', 'Memory record index contains an unknown record kind', 'memory');
      }
      if (record.sha256 !== null && (typeof record.sha256 !== 'string' || !HASH.test(record.sha256))) {
        throw new RecoveryError('COMPONENT_FAILED', 'Memory record index contains an invalid content hash', 'memory');
      }
      refs.add(record.ref);
    }
    if (result.watermark.baselineId !== control.deletionBaselineId) {
      throw new RecoveryError('DELETION_BASELINE_MISMATCH',
        'Memory export deletion baseline does not match the control deletion ledger', 'memory');
    }
    if (result.watermark.tombstoneWatermark > control.tombstoneWatermark) {
      throw new RecoveryError('DELETION_WATERMARK_STALE',
        'Memory export deletion watermark is ahead of the control deletion ledger', 'memory');
    }
    const propagationPending = result.watermark.tombstoneWatermark < control.tombstoneWatermark;
    const manifest: MemoryComponentManifest = {
      schemaVersion: COMPONENT_MANIFEST_SCHEMA_VERSION,
      componentId: 'memory',
      backend: { backendId: result.backendId, deploymentId: result.deploymentId },
      componentVersion: result.componentVersion,
      watermark: { tombstoneWatermark: result.watermark.tombstoneWatermark, baselineId: result.watermark.baselineId },
      archiveFile: `components/memory/${archiveRef}`,
      archiveBytes: result.archive.bytes,
      archiveSha256: result.archive.sha256,
      recordIndexFile: `components/memory/${indexRef}`,
      recordIndexBytes: result.recordIndex.bytes,
      recordIndexSha256: result.recordIndex.sha256,
      recordCount: result.recordIndex.count,
      objectRefs: [...new Set(result.objectRefs)].sort(),
      capturedAt: result.capturedAt,
    };
    const written = await this.writeComponentManifest(path.join(directory, 'manifest.json'), manifest, validateMemoryComponentManifest);
    this.components.push(this.componentEntry('memory', 'components/memory/manifest.json', written.sha256, 'components/memory',
      result.capturedAt, propagationPending ? 'memory-export;deletion-propagation-pending' : 'memory-export;deletion-propagated',
      result.watermark.tombstoneWatermark, `memory:${result.backendId}:${result.componentVersion}`));
    this.memoryObjectRefs = [...new Set(result.objectRefs)].sort();
    await this.writeJournal('memory-export');
  }

  private async captureSharedObjects(): Promise<void> {
    const memoryComponent = this.components.find((item) => item.componentId === 'memory');
    if (!memoryComponent) throw new RecoveryError('COMPONENT_FAILED', 'Shared objects require a completed memory component', 'shared-objects');
    const controlManifest = this.components.find((item) => item.componentId === 'control');
    if (!controlManifest) throw new RecoveryError('COMPONENT_FAILED', 'Shared objects require a completed control component', 'shared-objects');
    const controlObjectRefs = this.controlObjectRefs;
    const memoryObjectRefs = this.memoryObjectRefs;
    const ids = [...new Set([...controlObjectRefs, ...memoryObjectRefs])].sort();
    const directory = path.join(this.ctx.partialDir, 'components', 'shared-objects');
    const objectsDirectory = path.join(directory, 'objects');
    await ensureDir(objectsDirectory);
    const records: SharedObjectRecord[] = [];
    for (const objectId of ids) {
      if (!SAFE_ID.test(objectId)) throw new RecoveryError('INVALID_SCHEMA', 'Shared object id is not a bounded identity', 'shared-objects');
      const read = await this.env.sharedObjects.read(objectId);
      if (!read) {
        throw new RecoveryError('OBJECT_CLOSURE_INCOMPLETE', `Referenced shared object ${objectId} is unavailable`, 'shared-objects');
      }
      if (read.objectId !== objectId) throw new RecoveryError('OBJECT_CONFLICT', 'Shared object port returned a different object id', 'shared-objects');
      const bytes = read.bytes;
      const digest = sha256(bytes);
      if (read.expected && (read.expected.bytes !== bytes.byteLength || read.expected.sha256 !== digest)) {
        throw new RecoveryError('HASH_MISMATCH', `Shared object ${objectId} does not match the port's independent expectation`, 'shared-objects');
      }
      const file = `components/shared-objects/objects/${fileStem(objectId)}.bin`;
      await writeBytesExclusive(resolveInside(this.ctx.partialDir, file), bytes);
      const written = await fileEvidence(resolveInside(this.ctx.partialDir, file));
      if (written.bytes !== bytes.byteLength || written.sha256 !== digest) {
        throw new RecoveryError('HASH_MISMATCH', `Staged shared object bytes changed for ${objectId}`, 'shared-objects');
      }
      records.push({ objectId, file, bytes: bytes.byteLength, sha256: digest });
    }
    let workspaceInventory: WorkspaceInventory | undefined;
    if (this.env.sharedObjects.inventory) {
      try {
        workspaceInventory = validateWorkspaceInventory(await this.env.sharedObjects.inventory());
      } catch (error) {
        if (error instanceof RecoveryError) throw error;
        throw new RecoveryError('WORKSPACE_INVENTORY_UNAVAILABLE', `Workspace inventory failed: ${(error as Error).message}`, 'shared-objects');
      }
    }
    const manifest: SharedObjectsComponentManifest = {
      schemaVersion: COMPONENT_MANIFEST_SCHEMA_VERSION,
      componentId: 'shared-objects',
      objects: records,
      referencedBy: [
        { componentId: 'control', objectIds: [...new Set(controlObjectRefs)].sort() },
        { componentId: 'memory', objectIds: [...new Set(memoryObjectRefs)].sort() },
      ],
      ...(workspaceInventory ? { workspaceInventory } : {}),
      capturedAt: this.now(),
    };
    const written = await this.writeComponentManifest(path.join(directory, 'manifest.json'), manifest, validateSharedObjectsComponentManifest);
    this.components.push(this.componentEntry('shared-objects', 'components/shared-objects/manifest.json', written.sha256,
      'components/shared-objects', manifest.capturedAt, 'immutable-object-copy', records.length, `objects:${written.sha256}`));
    this.objectManifest = {
      ref: 'components/shared-objects/manifest.json',
      sha256: written.sha256,
      bytes: written.bytes,
      objectCount: records.length,
    };
    await this.writeJournal('shared-objects');
  }

  private earliestCapture(): string {
    if (this.components.length === 0) return this.journal.startedAt;
    return [...this.components.map((item) => item.capturedAt)].sort()[0]!;
  }

  private baseManifest(status: BackupBundle['status'], failure: BundleFailure | null): BackupBundle {
    return {
      schemaVersion: 1,
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      minimumReaderVersion: RECOVERY_READER_VERSION,
      snapshotId: this.ctx.request.snapshotId,
      rootId: this.ctx.request.rootId,
      captureTime: this.earliestCapture(),
      completedAt: this.now(),
      status,
      reconcileRequired: true,
      generation: this.generation,
      runtimeManifest: this.runtimeManifest,
      control: this.watermarks,
      components: [...this.components],
      objectManifest: this.objectManifest,
      durability: {
        crossComponentCommonSection: false,
        perComponent: this.components.map((item) => ({ componentId: item.componentId, evidence: item.quiescenceEvidence })),
      },
      failure,
    };
  }

  private async writeBundleManifest(manifest: BackupBundle): Promise<{ bytes: number; sha256: string }> {
    const validation = validateBackupBundle(manifest, { requireReady: manifest.status === 'ready' });
    if (!validation.ok) {
      const first = validation.violations[0];
      throw new RecoveryError('INVALID_SCHEMA', `Bundle manifest failed validation at ${first?.path ?? '$'}: ${first?.message ?? 'unknown'}`);
    }
    const encoded = encoder.encode(`${canonicalJson(manifest)}\n`);
    await writeJsonAtomic(path.join(this.ctx.partialDir, 'bundle.json'), manifest);
    this.manifestSha256 = sha256(encoded);
    return { bytes: encoded.byteLength, sha256: this.manifestSha256 };
  }

  private async publish(ready: boolean): Promise<string> {
    await this.writeJournal(ready ? 'published' : 'interrupted');
    try {
      await rename(this.ctx.partialDir, this.ctx.finalDir);
    } catch (error) {
      throw new RecoveryError('PUBLISH_CONFLICT', `Bundle directory could not be published atomically: ${(error as Error).message}`);
    }
    if (ready) {
      if (!this.manifestSha256) throw new RecoveryError('PUBLISH_CONFLICT', 'Bundle manifest hash is unknown at publish time');
      const pointer: LastGoodPointer = {
        schemaVersion: 1,
        snapshotId: this.ctx.request.snapshotId,
        manifestSha256: this.manifestSha256,
        captureTime: this.baseManifest('ready', null).captureTime,
        updatedAt: this.now(),
      };
      const validation = validateLastGoodPointer(pointer);
      if (!validation.ok) throw new RecoveryError('INVALID_SCHEMA', 'Generated last-good pointer is invalid');
      await writeJsonAtomic(this.ctx.lastGoodFile, pointer);
    }
    return this.ctx.finalDir;
  }

  private async finishFailure(error: unknown): Promise<CaptureResult> {
    const failure = describeFailure(error);
    this.journal.lastErrorCode = failure.code;
    this.journal.updatedAt = this.now();
    if (failure.code === 'STAGING_INTERRUPTED') {
      // The injecting stage already wrote its last durable phase; keep it so
      // the retained journal tells a later reader where the attempt stopped.
      try { await this.writeJournal(this.journal.phase); } catch { /* keep original staging evidence */ }
      return {
        status: 'incomplete',
        snapshotId: this.ctx.request.snapshotId,
        failure: { ...failure, componentId: failure.componentId ?? null },
        bundleDirectory: null,
        partialDirectory: this.ctx.partialDir,
        lastGoodUpdated: false,
      };
    }
    const status = toCaptureFailure(error);
    const manifest = this.baseManifest(status, failure);
    try {
      await this.writeBundleManifest(manifest);
      await this.publish(false);
      return {
        status,
        snapshotId: this.ctx.request.snapshotId,
        failure,
        bundleDirectory: this.ctx.finalDir,
        partialDirectory: null,
        lastGoodUpdated: false,
      };
    } catch {
      try { await this.writeJournal('interrupted'); } catch { /* preserve original evidence */ }
      // A failure record that cannot itself be validated/published must never
      // claim a bundle; the partial staging directory stays for inspection.
      try { await rename(path.join(this.ctx.partialDir, 'bundle.json'), path.join(this.ctx.partialDir, 'bundle.invalid.json')); } catch { /* nothing to quarantine */ }
      return {
        status,
        snapshotId: this.ctx.request.snapshotId,
        failure,
        bundleDirectory: null,
        partialDirectory: this.ctx.partialDir,
        lastGoodUpdated: false,
      };
    }
  }

  async run(): Promise<CaptureResult> {
    try {
      await this.writeJournal('started');
      await this.checkCapacity(true);
      await this.captureControl();
      await this.inject('after-control-snapshot');
      await this.captureGoalSessions();
      await this.inject('after-goal-sessions');
      await this.checkCapacity(false);
      await this.captureMemory();
      await this.inject('after-memory-export');
      await this.captureSharedObjects();
      await this.inject('after-shared-objects');
      await this.checkCapacity(false);
      if (!this.components.every((item) => item.status === 'complete')) {
        throw new RecoveryError('REQUIRED_COMPONENT_MISSING', 'Not every required component completed before publish');
      }
      const manifest = this.baseManifest('ready', null);
      const written = await this.writeBundleManifest(manifest);
      await this.inject('before-publish');
      const verification = await verifyBundleDirectory(this.ctx.partialDir, { requireReady: true });
      if (!verification.ok) {
        const first = verification.violations[0];
        throw new RecoveryError('SELF_CHECK_FAILED',
          `Bundle self-verification failed at ${first?.path ?? '$'}: ${first?.message ?? 'unknown'}`);
      }
      const directory = await this.publish(true);
      const lastGood = await this.readLastGoodValue();
      return {
        status: 'ready',
        snapshotId: this.ctx.request.snapshotId,
        bundleDirectory: directory,
        manifest,
        manifestSha256: written.sha256,
        lastGoodUpdated: lastGood?.snapshotId === this.ctx.request.snapshotId,
      };
    } catch (error) {
      return this.finishFailure(error);
    } finally {
      const lease = this.lease;
      this.lease = undefined;
      if (lease) await lease.release().catch(() => undefined);
    }
  }

  private async readLastGoodValue(): Promise<LastGoodPointer | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.ctx.lastGoodFile, 'utf8')) as unknown;
      return validateLastGoodPointer(parsed).ok ? parsed as LastGoodPointer : undefined;
    } catch {
      return undefined;
    }
  }
}

const phaseForStage = (stage: CaptureStage): StagingJournal['phase'] => {
  switch (stage) {
    case 'after-control-snapshot': return 'control-snapshot';
    case 'after-goal-sessions': return 'goal-sessions';
    case 'after-memory-export': return 'memory-export';
    case 'after-shared-objects': return 'shared-objects';
    case 'before-publish': return 'publishing';
  }
};

const componentForStage = (stage: CaptureStage): ComponentId | null => {
  switch (stage) {
    case 'after-control-snapshot': return 'control';
    case 'after-goal-sessions': return 'dsh-goal-sessions';
    case 'after-memory-export': return 'memory';
    case 'after-shared-objects': return 'shared-objects';
    case 'before-publish': return null;
  }
};

export type { CaptureResult };

/** Public offline capture service. */
export class CheckpointCaptureService {
  private readonly stagingRoot: string;
  private readonly bundlesRoot: string;
  private readonly lastGoodFile: string;
  private readonly reserveBytes: number;

  constructor(private readonly options: CaptureServiceOptions) {
    if (!path.isAbsolute(options.stagingRoot)) throw new RecoveryError('INVALID_SCHEMA', 'Staging root must be an absolute path');
    this.stagingRoot = path.resolve(options.stagingRoot);
    if (options.liveDataRoot !== undefined) {
      if (!path.isAbsolute(options.liveDataRoot)) throw new RecoveryError('INVALID_SCHEMA', 'liveDataRoot must be an absolute path');
      const live = path.resolve(options.liveDataRoot);
      const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${path.sep}`);
      if (inside(this.stagingRoot, live) || inside(live, this.stagingRoot)) {
        throw new RecoveryError('LIVE_ROOT_PROTECTED', 'Staging root must not overlap the live data root');
      }
    }
    if (options.allowedStagingRoots !== undefined) {
      if (!Array.isArray(options.allowedStagingRoots) || options.allowedStagingRoots.length === 0) {
        throw new RecoveryError('TARGET_NOT_ISOLATED', 'allowedStagingRoots must contain at least one absolute parent');
      }
      const allowed = options.allowedStagingRoots.every((root) => typeof root === 'string' && path.isAbsolute(root)
        && (this.stagingRoot === path.resolve(root) || this.stagingRoot.startsWith(`${path.resolve(root)}${path.sep}`)));
      if (!allowed) throw new RecoveryError('TARGET_NOT_ISOLATED', 'Staging root is outside the caller-approved staging roots');
    }
    this.bundlesRoot = path.join(this.stagingRoot, 'bundles');
    this.lastGoodFile = path.join(this.stagingRoot, 'last-good.json');
    this.reserveBytes = options.reserveBytes ?? 0;
    if (!Number.isSafeInteger(this.reserveBytes) || this.reserveBytes < 0) {
      throw new RecoveryError('INVALID_SCHEMA', 'reserveBytes must be a non-negative safe integer');
    }
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    if (typeof request.snapshotId !== 'string' || !SNAPSHOT_ID.test(request.snapshotId)) {
      throw new RecoveryError('INVALID_SCHEMA', 'snapshotId must match the bounded snapshot identity format');
    }
    if (typeof request.rootId !== 'string' || !HASH.test(request.rootId)) {
      throw new RecoveryError('INVALID_SCHEMA', 'rootId must be a sha256 root identity');
    }
    if (!Number.isSafeInteger(request.estimatedBytes) || request.estimatedBytes < 0) {
      throw new RecoveryError('INVALID_SCHEMA', 'estimatedBytes must be a non-negative safe integer');
    }
    await ensureDir(this.bundlesRoot);
    const finalDir = path.join(this.bundlesRoot, request.snapshotId);
    const partialDir = path.join(this.bundlesRoot, `${request.snapshotId}.partial`);
    if (await fileExists(path.join(finalDir, 'bundle.json'))) {
      return this.existingResult(finalDir, request.snapshotId);
    }
    if (await isDirectory(finalDir)) {
      return {
        status: 'incomplete',
        snapshotId: request.snapshotId,
        failure: { code: 'STAGING_INTERRUPTED', componentId: null, message: 'Published directory exists without a bundle manifest' },
        bundleDirectory: null,
        partialDirectory: finalDir,
        lastGoodUpdated: false,
      };
    }
    if (await isDirectory(partialDir)) {
      return {
        status: 'incomplete',
        snapshotId: request.snapshotId,
        failure: { code: 'STAGING_INTERRUPTED', componentId: null, message: 'A previous staging attempt never completed; partial evidence was retained' },
        bundleDirectory: null,
        partialDirectory: partialDir,
        lastGoodUpdated: false,
      };
    }
    await ensureDir(partialDir);
    const attempt = new CaptureAttempt({
      environment: this.options.environment,
      stagingRoot: this.stagingRoot,
      bundlesRoot: this.bundlesRoot,
      lastGoodFile: this.lastGoodFile,
      reserveBytes: this.reserveBytes,
      request,
      partialDir,
      finalDir,
    });
    return attempt.run();
  }

  /** Read the published last-good pointer, validating it instead of trusting JSON shape. */
  async readLastGood(): Promise<LastGoodPointer | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.lastGoodFile, 'utf8')) as unknown;
      return validateLastGoodPointer(parsed).ok ? parsed as LastGoodPointer : undefined;
    } catch {
      return undefined;
    }
  }

  /** Inspect a staging/published directory for tests and diagnostics. */
  async inspectStaging(snapshotId: string): Promise<{
    partialDirectory: string | null;
    journal: StagingJournal | null;
    publishedDirectory: string | null;
  }> {
    if (typeof snapshotId !== 'string' || !SNAPSHOT_ID.test(snapshotId)) throw new RecoveryError('INVALID_SCHEMA', 'Invalid snapshotId');
    const partialDir = path.join(this.bundlesRoot, `${snapshotId}.partial`);
    if (await isDirectory(partialDir)) {
      let journal: StagingJournal | null = null;
      try {
        const parsed = JSON.parse(await readFile(path.join(partialDir, 'capture-journal.json'), 'utf8')) as unknown;
        journal = validateStagingJournal(parsed).ok ? parsed as StagingJournal : null;
      } catch { journal = null; }
      return { partialDirectory: partialDir, journal, publishedDirectory: null };
    }
    const finalDir = path.join(this.bundlesRoot, snapshotId);
    if (await isDirectory(finalDir)) return { partialDirectory: null, journal: null, publishedDirectory: finalDir };
    return { partialDirectory: null, journal: null, publishedDirectory: null };
  }

  private async existingResult(directory: string, snapshotId: string): Promise<CaptureResult> {
    const verification = await verifyBundleDirectory(directory, { requireReady: false });
    if (!verification.manifest) {
      return {
        status: 'incomplete',
        snapshotId,
        failure: { code: 'STAGING_INTERRUPTED', componentId: null, message: 'Existing published directory has no readable bundle manifest' },
        bundleDirectory: null,
        partialDirectory: directory,
        lastGoodUpdated: false,
      };
    }
    const manifest = verification.manifest;
    if (manifest.status === 'ready' && verification.ok && verification.manifestSha256) {
      const lastGood = await this.readLastGood();
      return {
        status: 'ready',
        snapshotId,
        bundleDirectory: directory,
        manifest,
        manifestSha256: verification.manifestSha256,
        lastGoodUpdated: lastGood?.snapshotId === snapshotId,
      };
    }
    return {
      status: manifest.status === 'incomplete' ? 'incomplete' : 'failed',
      snapshotId,
      failure: manifest.failure ?? { code: 'COMPONENT_FAILED', componentId: null, message: 'Previously published bundle is not ready' },
      bundleDirectory: directory,
      partialDirectory: null,
      lastGoodUpdated: false,
    };
  }
}
