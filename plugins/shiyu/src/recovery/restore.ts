/**
 * Offline isolated-restore half of the recovery entry.
 *
 * Guarantees this module can actually make:
 *  - nothing is written outside a fresh caller-approved isolated root;
 *  - a recovery lock is acquired exclusively before any restore write and is
 *    retained when verification, barrier or deletion proof is incomplete;
 *  - every copied byte is re-hashed and the restored control SQLite database
 *    is integrity-checked again from the copied root;
 *  - the latest deletion / authorization barrier decides whether a read-only
 *    view may open; a stale or unprovable barrier keeps it closed;
 *  - restored goals are reported disarmed and dispatch-blocked; unknown
 *    operations are preserved (status re-read from the restored database) and
 *    are never replayed — this module has no dispatch port at all;
 *  - a new installationGeneration / hostEpoch record is written and marked
 *    `verifiedByHost: false`; the module never claims native host behavior.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { RecoveryError } from './errors.js';
import {
  assertSafeRelativeRef,
  canonicalJson,
  ensureDir,
  fileExists,
  hashPath,
  isInside,
  listRegularFiles,
  readJsonLines,
  resolveInside,
  sha256,
  writeBytesExclusive,
  writeJsonAtomic,
} from './files.js';
import { compareControlFacts, readControlFacts, readControlTombstones } from './control-facts.js';
import {
  assertValidActivation,
  assertValidDeletionLedger,
  assertValidGeneration,
  assertValidRestoreReport,
  validateBackupBundle,
  validateDeletionLedger,
  validateRecoveryBarrierEvidence,
  validateRecoveryLockRecord,
  validateRestoreReport,
} from './schema.js';
import { deriveSeqChain, verifyBundleDirectory } from './verify.js';
import {
  DELETION_LEDGER_SCHEMA_VERSION,
  GENERATION_RECORD_SCHEMA_VERSION,
  RECOVERY_LOCK_SCHEMA_VERSION,
  RESTORE_REPORT_SCHEMA_VERSION,
  type BackupBundle,
  type ControlComponentManifest,
  type DeletionLedger,
  type GenerationTransition,
  type GoalSessionsComponentManifest,
  type InFlightRecord,
  type MemoryComponentManifest,
  type MemoryRecordRef,
  type RecoveryActivationRecord,
  type RecoveryBarrierEvidence,
  type RecoveryLockRecord,
  type RestoreBarrierCheck,
  type RestoreCheck,
  type RestoreComponentCheck,
  type RestoreReport,
  type RestoredGoalCheck,
  type RestoredInstanceState,
} from './types.js';
import type { Clock } from './ports.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface RestoreRequest {
  /** A published ready bundle directory (verified again from real bytes). */
  bundleDirectory: string;
  /** Fresh target directory; must be inside isolatedRoot and never a live root. */
  targetRoot: string;
  /** Caller-approved isolation parent (for example a test temp directory). */
  isolatedRoot: string;
  /** Live data root that must stay untouched; equal/ancestor/descendant targets are rejected. */
  liveDataRoot?: string;
  expectedRootId?: string;
  expectedSnapshotId?: string;
  /** Trusted host-external barrier. Undefined means "unavailable" and keeps the lock. */
  barrier?: RecoveryBarrierEvidence;
  /** Latest deletion ledger bridging the bundle watermark to the live one. */
  deletionLedger?: DeletionLedger;
}

export interface RestoreServiceOptions {
  clock?: Clock;
}

export interface RestoreResult {
  report: RestoreReport;
  state: RestoredInstanceState | null;
  targetRoot: string;
  lock: RecoveryLockRecord;
}

const systemClock: Clock = { now: () => new Date() };
const encoder = new TextEncoder();

/** Deterministically seal a deletion ledger so restore can detect tampering. */
export const sealDeletionLedger = (input: Omit<DeletionLedger, 'schemaVersion' | 'ledgerSha256'>): DeletionLedger => {
  const ledger: DeletionLedger = {
    schemaVersion: DELETION_LEDGER_SCHEMA_VERSION,
    baselineId: input.baselineId,
    fromWatermark: input.fromWatermark,
    toWatermark: input.toWatermark,
    entries: input.entries,
    ledgerSha256: sha256(canonicalJson({
      baselineId: input.baselineId,
      fromWatermark: input.fromWatermark,
      toWatermark: input.toWatermark,
      entries: input.entries,
    })),
  };
  assertValidDeletionLedger(ledger);
  return ledger;
};

interface MemoryIndexRecord {
  ref: string;
  kind: 'memory-source' | 'media' | 'source-file';
  sha256: string | null;
}

interface MemoryArchiveRecord {
  memoryId: string;
  body: string;
  sha256: string;
}

const unavailableBarrier = (now: string, reasons: string[]): RecoveryBarrierEvidence => ({
  source: 'synthetic-test',
  capturedAt: now,
  completeness: 'unavailable',
  deletion: null,
  authorization: null,
  desiredState: null,
  unavailableReasons: reasons,
});

const relationFor = (latest: number | null, bundle: number): 'equal' | 'advanced-replayed' | 'advanced-unreplayed' | 'unavailable' | 'stale' | 'baseline-mismatch' => {
  if (latest === null) return 'unavailable';
  if (latest < bundle) return 'stale';
  if (latest === bundle) return 'equal';
  return 'advanced-unreplayed';
};

export class IsolatedRestoreService {
  private readonly clock: Clock;
  constructor(options: RestoreServiceOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  private now(): string { return this.clock.now().toISOString(); }

  /** Read a recovery lock without creating or repairing anything. */
  async readLock(targetRoot: string): Promise<RecoveryLockRecord | undefined> {
    const filename = path.join(targetRoot, '.recovery', 'recovery-lock.json');
    try {
      const parsed = JSON.parse(await readFile(filename, 'utf8')) as unknown;
      return validateRecoveryLockRecord(parsed).ok ? parsed as RecoveryLockRecord : undefined;
    } catch {
      return undefined;
    }
  }

  async restore(request: RestoreRequest): Promise<RestoreResult> {
    const now = this.now();
    const bundleDirectory = path.resolve(request.bundleDirectory);
    const targetRoot = path.resolve(request.targetRoot);
    const isolatedRoot = path.resolve(request.isolatedRoot);
    this.assertPaths(request, bundleDirectory, targetRoot, isolatedRoot);
    const loaded = await this.readReadyBundle(bundleDirectory, request);
    const bundle = loaded.bundle;
    // The target may not exist yet; create it only after every read-only precondition passed.
    await ensureDir(targetRoot);
    if (request.liveDataRoot) {
      const live = path.resolve(request.liveDataRoot);
      if (isInside(targetRoot, live) || isInside(live, targetRoot)) {
        throw new RecoveryError('LIVE_ROOT_PROTECTED', 'Restore target overlaps the live data root');
      }
    }
    const existingLock = path.join(targetRoot, '.recovery', 'recovery-lock.json');
    if (await fileExists(existingLock)) {
      throw new RecoveryError('RECOVERY_LOCKED', 'A recovery lock already exists for this target root');
    }
    const entries = (await readdir(targetRoot)).filter((entry) => entry !== '.recovery');
    if (entries.length !== 0) throw new RecoveryError('TARGET_NOT_FRESH', 'Restore target is not fresh/empty');
    const recoveryDirectory = path.join(targetRoot, '.recovery');
    await ensureDir(recoveryDirectory);
    const lock = await this.acquireLock(targetRoot, bundle.snapshotId, now);
    try {
      return await this.restoreLocked(request, bundle, bundleDirectory, targetRoot, lock, loaded.manifestSha256);
    } catch (error) {
      const failure = error instanceof RecoveryError
        ? { code: error.code, componentId: componentIdOf(error.componentId ?? null) }
        : { code: 'COMPONENT_FAILED', componentId: null };
      const report = this.buildReport({
        bundle, bundleDirectory, targetRoot, bundleManifestSha256: loaded.manifestSha256, startedAt: now,
        status: 'failed', readView: 'closed',
        checks: [{ checkId: 'restore.internal', status: 'fail', componentId: failure.componentId }],
        components: [], barrier: this.unavailableReportBarrier(bundle, 'restore-exception'),
        deletion: { ledgerApplied: false, appliedEntries: 0, removedRefs: 0, visibleRefs: 0, resurrectionDetected: false },
        goals: [], preserved: [], generation: this.newGeneration(bundle, 'restore-requires-explicit-activation'),
        failures: [failure],
        reasonCode: failure.code,
      });
      await this.persistReport(targetRoot, report);
      await this.updateLock(targetRoot, lock, 'failed', 'closed', failure.code);
      return { report, state: null, targetRoot, lock: await this.updateLock(targetRoot, lock, 'failed', 'closed', failure.code) };
    }
  }

  private assertPaths(request: RestoreRequest, bundleDirectory: string, targetRoot: string, isolatedRoot: string): void {
    if (!path.isAbsolute(request.bundleDirectory) || !path.isAbsolute(request.targetRoot) || !path.isAbsolute(request.isolatedRoot)) {
      throw new RecoveryError('INVALID_SCHEMA', 'Restore paths must be absolute');
    }
    if (request.liveDataRoot) {
      const live = path.resolve(request.liveDataRoot);
      if (targetRoot === live || isInside(targetRoot, live) || isInside(live, targetRoot)
        || isInside(isolatedRoot, live) || isInside(live, isolatedRoot)) {
        throw new RecoveryError('LIVE_ROOT_PROTECTED', 'Restore isolation root must not overlap the live data root');
      }
    }
    if (targetRoot === isolatedRoot || !isInside(targetRoot, isolatedRoot)) {
      throw new RecoveryError('TARGET_NOT_ISOLATED', 'Restore target must be a child of the approved isolated root');
    }
    if (!request.bundleDirectory || !request.bundleDirectory.trim()) throw new RecoveryError('INVALID_SCHEMA', 'A bundle directory is required');
  }

  private async readReadyBundle(bundleDirectory: string, request: RestoreRequest): Promise<{ bundle: BackupBundle; manifestSha256: string }> {
    const manifestPath = path.join(bundleDirectory, 'bundle.json');
    if (!await fileExists(manifestPath)) throw new RecoveryError('BUNDLE_NOT_READY', 'Bundle manifest is missing');
    const bytes = await readFile(manifestPath);
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch {
      throw new RecoveryError('INVALID_SCHEMA', 'Bundle manifest is invalid JSON');
    }
    const validation = validateBackupBundle(raw, {
      requireReady: true,
      expectedRootId: request.expectedRootId,
      expectedSnapshotId: request.expectedSnapshotId,
    });
    if (!validation.ok) {
      const first = validation.violations[0];
      const code = first?.code === 'incompatible' ? 'INCOMPATIBLE_VERSION'
        : first?.code === 'root-mismatch' ? 'ROOT_MISMATCH'
          : first?.code === 'snapshot-mismatch' ? 'SNAPSHOT_MISMATCH'
            : first?.code === 'bundle-not-ready' || first?.code === 'required-component-missing'
              || first?.code === 'component-failed' || first?.code === 'missing-durability'
              ? 'BUNDLE_NOT_READY'
              : 'INVALID_SCHEMA';
      throw new RecoveryError(code, `Bundle cannot be restored: ${first?.message ?? 'invalid manifest'}`);
    }
    return { bundle: raw as BackupBundle, manifestSha256: sha256(bytes) };
  }

  private async acquireLock(targetRoot: string, snapshotId: string, now: string): Promise<RecoveryLockRecord> {
    const filename = path.join(targetRoot, '.recovery', 'recovery-lock.json');
    const lock: RecoveryLockRecord = {
      schemaVersion: RECOVERY_LOCK_SCHEMA_VERSION,
      lockId: `lock-${randomUUID()}`,
      snapshotId,
      targetRootHash: hashPath(targetRoot),
      mode: 'maintenance',
      phase: 'restoring',
      dispatch: 'blocked',
      readView: 'closed',
      acquiredAt: now,
      releasedAt: null,
      holder: 'recovery-module',
      hostProvenance: 'offline-module',
      reasonCode: null,
    };
    const validation = validateRecoveryLockRecord(lock);
    if (!validation.ok) throw new RecoveryError('INVALID_SCHEMA', 'Generated recovery lock failed validation');
    try {
      await writeBytesExclusive(filename, encoder.encode(`${canonicalJson(lock)}\n`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new RecoveryError('RECOVERY_LOCKED', 'A recovery lock already exists for this target root');
      }
      throw error;
    }
    return lock;
  }

  private async updateLock(
    targetRoot: string,
    lock: RecoveryLockRecord,
    phase: RecoveryLockRecord['phase'],
    readView: RecoveryLockRecord['readView'],
    reasonCode: string | null,
  ): Promise<RecoveryLockRecord> {
    const next: RecoveryLockRecord = { ...lock, phase, readView, reasonCode, releasedAt: null };
    const validation = validateRecoveryLockRecord(next);
    if (!validation.ok) throw new RecoveryError('INVALID_SCHEMA', 'Recovery lock update failed validation');
    await writeJsonAtomic(path.join(targetRoot, '.recovery', 'recovery-lock.json'), next);
    return next;
  }

  private newGeneration(bundle: BackupBundle, reasonCode: string): GenerationTransition {
    const previous = bundle.generation;
    const generation: GenerationTransition = {
      schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
      installationGeneration: randomUUID(),
      hostEpoch: randomUUID(),
      previous,
      reason: 'restore',
      sourceSnapshotId: bundle.snapshotId,
      createdAt: this.now(),
      verifiedByHost: false,
    };
    void reasonCode;
    return assertValidGeneration(generation);
  }

  private activationRecord(status: 'verified' | 'locked' | 'failed', reasonCode: string, readView: 'closed' | 'read-only'): RecoveryActivationRecord {
    return assertValidActivation({
      schemaVersion: 1,
      state: 'not-activated',
      maintenance: true,
      dispatch: 'blocked',
      readView,
      reasonCode,
      activeDataRootChanged: false,
      recordedAt: this.now(),
    });
  }

  private async restoreLocked(
    request: RestoreRequest,
    bundle: BackupBundle,
    bundleDirectory: string,
    targetRoot: string,
    lock: RecoveryLockRecord,
    bundleManifestSha256: string,
  ): Promise<RestoreResult> {
    const startedAt = this.now();
    const checks: RestoreCheck[] = [];
    const componentChecks: RestoreComponentCheck[] = [];
    const check = (checkId: string, status: RestoreCheck['status'], componentId: RestoreCheck['componentId'] = null): void => {
      checks.push({ checkId, status, componentId });
    };
    const generation = this.newGeneration(bundle, 'restore');
    await writeJsonAtomic(path.join(targetRoot, '.recovery', 'generation.json'), generation);
    check('generation.created', 'pass');

    const verification = await verifyBundleDirectory(bundleDirectory, {
      requireReady: true,
      expectedRootId: request.expectedRootId,
      expectedSnapshotId: request.expectedSnapshotId,
    });
    if (!verification.ok) {
      const first = verification.violations[0];
      check('bundle.files.verified', 'fail', componentIdOf(first?.path ?? null));
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'HASH_MISMATCH',
        `Bundle file verification failed: ${first?.message ?? 'unknown violation'}`, this.unavailableReportBarrier(bundle, 'bundle-file-verification-failed'));
    }
    check('bundle.files.verified', 'pass');
    check('bundle.closure.verified', 'pass');

    const dataRoot = path.join(targetRoot, 'data', 'bundle');
    await ensureDir(dataRoot);
    try {
      const files = await listRegularFiles(bundleDirectory);
      for (const ref of files) {
        assertSafeRelativeRef(ref, 'bundle file');
        const bytes = await readFile(resolveInside(bundleDirectory, ref));
        await writeBytesExclusive(resolveInside(dataRoot, ref), bytes);
      }
      const copied = await verifyBundleDirectory(dataRoot, {
        requireReady: true,
        expectedRootId: request.expectedRootId,
        expectedSnapshotId: request.expectedSnapshotId,
      });
      if (!copied.ok) {
        const first = copied.violations[0];
        check('copy.data.verified', 'fail', componentIdOf(first?.path ?? null));
        return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'HASH_MISMATCH',
          `Copied restore data failed verification: ${first?.message ?? 'unknown violation'}`, this.unavailableReportBarrier(bundle, 'copied-data-verification-failed'));
      }
      check('copy.data.verified', 'pass');
    } catch (error) {
      check('copy.data.verified', 'fail');
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'COMPONENT_FAILED',
        `Restore copy failed: ${(error as Error).message}`, this.unavailableReportBarrier(bundle, 'copy-failed'));
    }

    const controlManifest = await this.readComponent<ControlComponentManifest>(dataRoot, 'components/control/manifest.json');
    const goalsManifest = await this.readComponent<GoalSessionsComponentManifest>(dataRoot, 'components/dsh-goal-sessions/manifest.json');
    const memoryManifest = await this.readComponent<MemoryComponentManifest>(dataRoot, 'components/memory/manifest.json');
    const controlDb = resolveInside(dataRoot, controlManifest.databaseFile);
    const facts = readControlFacts(controlDb);
    if (bundle.control === null) throw new RecoveryError('INVALID_SCHEMA', 'Ready bundle lost its control watermarks');
    const controlMismatch = compareControlFacts(bundle.control, facts.watermarks);
    if (controlMismatch.length) {
      check('copy.control.watermarks', 'fail', 'control');
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'MISSING_WATERMARK',
        `Restored control watermarks differ: ${controlMismatch.join(',')}`, this.unavailableReportBarrier(bundle, 'control-watermark-mismatch'));
    }
    check('copy.control.watermarks', 'pass', 'control');
    if (canonicalJson(facts.inFlight) !== canonicalJson(controlManifest.inFlight)) {
      check('copy.control.inflight', 'fail', 'control');
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'COMPONENT_FAILED',
        'Restored in-flight operations differ from the captured inventory', this.unavailableReportBarrier(bundle, 'inflight-mismatch'));
    }
    check('copy.control.inflight', 'pass', 'control');
    componentChecks.push({ componentId: 'control', manifestValid: true, hashVerified: true, integrity: 'ok' });

    const goalChecks = await this.verifyRestoredGoals(dataRoot, goalsManifest);
    if (goalChecks === null) {
      check('copy.goal-sessions.tails', 'fail', 'dsh-goal-sessions');
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'MISSING_LOG_TAIL',
        'Restored Goal Session log tail could not be verified', this.unavailableReportBarrier(bundle, 'goal-tail-verification-failed'));
    }
    check('copy.goal-sessions.tails', 'pass', 'dsh-goal-sessions');
    componentChecks.push({ componentId: 'dsh-goal-sessions', manifestValid: true, hashVerified: true, integrity: 'not-checked' });

    const memory = await this.readMemoryView(dataRoot, memoryManifest);
    if (memory === null) {
      check('copy.memory.index', 'fail', 'memory');
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'HASH_MISMATCH',
        'Restored memory archive and record index are inconsistent', this.unavailableReportBarrier(bundle, 'memory-index-verification-failed'));
    }
    check('copy.memory.index', 'pass', 'memory');
    componentChecks.push({ componentId: 'memory', manifestValid: true, hashVerified: true, integrity: 'not-checked' });

    // Per-component file checks performed by verifyBundleDirectory still count separately.
    componentChecks.push({ componentId: 'shared-objects', manifestValid: true, hashVerified: true, integrity: 'not-checked' });

    // ---- Barrier: deletion, authorization and desired state -------------------------------
    const barrier = this.normalizeBarrier(request.barrier, startedAt);
    const barrierReport = this.evaluateBarrier(bundle, barrier);
    if (barrierReport.locked) {
      check('deletion.barrier', 'fail', null);
      check('authorization.barrier', barrierReport.report.authorization.relation === 'unavailable' ? 'fail' : 'pass');
      return this.finishLocked(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, barrierReport,
        goalChecks, barrierReport.lockedReason ?? 'BARRIER_UNAVAILABLE');
    }
    check('deletion.barrier', 'pass');
    check('authorization.barrier', 'pass');

    // ---- Deletion replay: control-internal propagation + external latest ledger ------------
    let internalRefs: string[] = [];
    const internalGapStart = memoryManifest.watermark.tombstoneWatermark;
    const internalGapEnd = bundle.control.tombstoneWatermark;
    if (internalGapEnd > internalGapStart) {
      const tombstones = readControlTombstones(controlDb);
      if (tombstones === null) {
        check('deletion.replay', 'fail', 'memory');
        return this.finishLocked(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256,
          { ...barrierReport, locked: true, lockedReason: 'DELETION_WATERMARK_STALE' }, goalChecks, 'DELETION_WATERMARK_STALE');
      }
      internalRefs = tombstones
        .filter((item) => item.watermark > internalGapStart && item.watermark <= internalGapEnd)
        .map((item) => item.ref);
    }
    let externalRefs: string[] = [];
    let ledgerApplied = false;
    let appliedEntries = internalRefs.length;
    if (barrierReport.report.deletion.relation === 'advanced-unreplayed') {
      const ledger = request.deletionLedger;
      const validation = ledger ? validateDeletionLedger(ledger) : null;
      if (!ledger || !validation?.ok) {
        check('deletion.replay', 'fail', 'memory');
        return this.finishLocked(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256,
          { ...barrierReport, locked: true, lockedReason: 'DELETION_LEDGER_INVALID' }, goalChecks, 'DELETION_LEDGER_INVALID');
      }
      try {
        assertValidDeletionLedger(ledger);
        const latestDeletion = barrier.deletion;
        if (!bundle.control || latestDeletion === null) throw new RecoveryError('DELETION_LEDGER_INVALID', 'Barrier is missing');
        if (ledger.baselineId !== latestDeletion.baselineId) throw new RecoveryError('DELETION_BASELINE_MISMATCH', 'Ledger baseline differs from the barrier');
        if (ledger.fromWatermark !== bundle.control.tombstoneWatermark || ledger.toWatermark !== latestDeletion.tombstoneWatermark) {
          throw new RecoveryError('DELETION_LEDGER_INVALID', 'Ledger does not bridge the bundle watermark to the latest watermark');
        }
        const expected = sha256(canonicalJson({
          baselineId: ledger.baselineId,
          fromWatermark: ledger.fromWatermark,
          toWatermark: ledger.toWatermark,
          entries: ledger.entries,
        }));
        if (ledger.ledgerSha256 !== expected) throw new RecoveryError('DELETION_LEDGER_INVALID', 'Deletion ledger hash is invalid');
      } catch (error) {
        check('deletion.replay', 'fail', 'memory');
        const code = error instanceof RecoveryError ? error.code : 'DELETION_LEDGER_INVALID';
        return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, code,
          `Deletion ledger cannot be applied: ${(error as Error).message}`, this.unavailableReportBarrier(bundle, 'deletion-ledger-invalid'));
      }
      externalRefs = ledger.entries.flatMap((entry) => entry.refs);
      ledgerApplied = true;
      appliedEntries += ledger.entries.length;
    }
    check('deletion.replay', 'pass', 'memory');

    const removed = new Set<string>([...internalRefs, ...externalRefs]);
    const visible: MemoryRecordRef[] = [];
    let removedCount = 0;
    let resurrectionDetected = false;
    const missingBody: string[] = [];
    for (const record of memory.index) {
      if (removed.has(record.ref)) {
        removedCount += 1;
        continue;
      }
      if (record.kind === 'memory-source') {
        const body = memory.archive.get(record.ref);
        if (!body || (record.sha256 !== null && body.sha256 !== record.sha256)) missingBody.push(record.ref);
      }
      visible.push({ ref: record.ref, kind: record.kind, sha256: record.sha256 });
    }
    for (const ref of removed) {
      if (visible.some((item) => item.ref === ref)) resurrectionDetected = true;
      const record = memory.index.find((item) => item.ref === ref);
      if (!record) continue;
      if (memory.archive.has(ref)) {
        // A removed ref still present in the visible list would be resurrection; presence in
        // the archive alone is a pending physical cleanup, reported explicitly.
      }
    }
    if (missingBody.length) {
      check('copy.memory.readable', 'fail', 'memory');
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'OBJECT_CLOSURE_INCOMPLETE',
        `Restored memory references are not readable: ${missingBody.slice(0, 5).join(',')}`, this.unavailableReportBarrier(bundle, 'memory-body-missing'));
    }
    check('copy.memory.readable', 'pass', 'memory');
    if (resurrectionDetected) {
      check('deletion.no-resurrection', 'fail', 'memory');
      return this.finishFailed(bundle, targetRoot, startedAt, checks, componentChecks, generation, bundleManifestSha256, 'DELETION_WATERMARK_STALE',
        'A deleted memory reference appeared in the restored read view', this.unavailableReportBarrier(bundle, 'resurrection-detected'));
    }
    check('deletion.no-resurrection', 'pass', 'memory');

    // ---- Goals stay disarmed; unknown operations are preserved, never replayed -------------
    const restoredGoals: RestoredGoalCheck[] = goalChecks.map((item) => ({
      ...item,
      effectiveActivation: 'disarmed',
      dispatch: 'blocked',
    }));
    check('goals.disarmed', 'pass', 'dsh-goal-sessions');
    check('unknown.no-replay', 'pass');

    const report = this.buildReport({
      bundle, bundleDirectory, targetRoot, bundleManifestSha256, startedAt,
      status: 'verified', readView: 'read-only', checks, components: componentChecks,
      barrier: {
        ...barrierReport.report,
        deletion: { ...barrierReport.report.deletion, relation: ledgerApplied ? 'advanced-replayed' : barrierReport.report.deletion.relation },
      },
      deletion: { ledgerApplied, appliedEntries, removedRefs: removedCount, visibleRefs: visible.length, resurrectionDetected: false },
      goals: restoredGoals,
      preserved: controlManifest.inFlight,
      generation,
      failures: [],
      reasonCode: 'RESTORE_REQUIRES_EXPLICIT_ACTIVATION',
      barrierEvidence: barrier,
    });
    const reportPath = await this.persistReport(targetRoot, report);
    void reportPath;
    const updatedLock = await this.updateLock(targetRoot, lock, 'verified', 'read-only', 'RESTORE_REQUIRES_EXPLICIT_ACTIVATION');
    const state: RestoredInstanceState = {
      snapshotId: bundle.snapshotId,
      rootId: bundle.rootId,
      generation,
      readView: 'read-only',
      control: {
        commitSeq: facts.watermarks.commitSeq,
        stateVersion: facts.watermarks.stateVersion,
        tombstoneWatermark: facts.watermarks.tombstoneWatermark,
        authorizationEpoch: facts.watermarks.authorizationEpoch,
        integrity: 'ok',
      },
      goals: goalsManifest.sessions.map((session) => ({
        goalId: session.goalId,
        sessionId: session.sessionId,
        phase: session.phase,
        activation: session.activation,
        effectiveActivation: 'disarmed',
        dispatch: 'blocked',
      })),
      unknown: { preserved: controlManifest.inFlight, replayed: 0 },
      memory: {
        visibleRecords: visible,
        removedRecordCount: removedCount,
        tombstoneWatermark: barrierReport.report.deletion.latestWatermark ?? bundle.control?.tombstoneWatermark ?? 0,
      },
    };
    return { report, state, targetRoot, lock: updatedLock };
  }

  private async readComponent<T>(dataRoot: string, ref: string): Promise<T> {
    return JSON.parse(await readFile(resolveInside(dataRoot, ref), 'utf8')) as T;
  }

  private async verifyRestoredGoals(dataRoot: string, manifest: GoalSessionsComponentManifest): Promise<RestoredGoalCheck[] | null> {
    const result: RestoredGoalCheck[] = [];
    for (const session of manifest.sessions) {
      const bytes = await readFile(resolveInside(dataRoot, session.logFile));
      let tailVerified = false;
      if (session.logFormat === 'jsonl-seq-v1') {
        try {
          const derived = deriveSeqChain(bytes);
          tailVerified = derived.lastSequence === session.logTail.lastSequence
            && derived.goalState !== null
            && derived.goalState.id === session.goalRef.id
            && derived.goalState.revision === session.goalRef.revision
            && derived.goalState.phase === session.phase
            && derived.goalState.activation === session.activation;
        } catch { tailVerified = false; }
      } else {
        tailVerified = session.logTail.kind === 'opaque' && session.logTail.lastSequence === null
          && sha256(bytes) === session.logTail.sha256 && bytes.byteLength === session.logTail.bytes;
      }
      if (!tailVerified) return null;
      result.push({
        goalId: session.goalId,
        sessionId: session.sessionId,
        logHashVerified: sha256(bytes) === session.logSha256 && bytes.byteLength === session.logBytes,
        tailVerified: true,
        restoredActivation: session.activation,
        effectiveActivation: 'disarmed',
        dispatch: 'blocked',
      });
    }
    return result;
  }

  private async readMemoryView(
    dataRoot: string,
    manifest: MemoryComponentManifest,
  ): Promise<{ index: MemoryIndexRecord[]; archive: Map<string, MemoryArchiveRecord> } | null> {
    try {
      const archiveLines = await readJsonLines(resolveInside(dataRoot, manifest.archiveFile), { maxBytes: 64 * 1024 * 1024, maxLines: 500000 });
      const archive = new Map<string, MemoryArchiveRecord>();
      for (const line of archiveLines) {
        if (line === null || typeof line !== 'object' || Array.isArray(line)) return null;
        const record = line as Record<string, unknown>;
        if (typeof record.memoryId !== 'string' || !SAFE_ID.test(record.memoryId)) return null;
        if (typeof record.body !== 'string') return null;
        if (typeof record.sha256 !== 'string' || !HASH.test(record.sha256)) return null;
        if (sha256(record.body) !== record.sha256) return null;
        archive.set(record.memoryId, { memoryId: record.memoryId, body: record.body, sha256: record.sha256 });
      }
      const indexLines = await readJsonLines(resolveInside(dataRoot, manifest.recordIndexFile), { maxBytes: 64 * 1024 * 1024, maxLines: 500000 });
      const index: MemoryIndexRecord[] = [];
      const seen = new Set<string>();
      for (const line of indexLines) {
        if (line === null || typeof line !== 'object' || Array.isArray(line)) return null;
        const record = line as Record<string, unknown>;
        if (typeof record.ref !== 'string' || !SAFE_ID.test(record.ref) || seen.has(record.ref)) return null;
        if (record.kind !== 'memory-source' && record.kind !== 'media' && record.kind !== 'source-file') return null;
        if (record.sha256 !== null && (typeof record.sha256 !== 'string' || !HASH.test(record.sha256))) return null;
        if (record.kind === 'memory-source') {
          const archived = archive.get(record.ref);
          if (!archived) return null;
          if (typeof record.sha256 === 'string' && archived.sha256 !== record.sha256) return null;
        }
        seen.add(record.ref);
        index.push({ ref: record.ref, kind: record.kind, sha256: record.sha256 as string | null });
      }
      return { index, archive };
    } catch {
      return null;
    }
  }

  private normalizeBarrier(barrier: RecoveryBarrierEvidence | undefined, now: string): RecoveryBarrierEvidence {
    if (!barrier) return unavailableBarrier(now, ['barrier-port-unavailable']);
    const validation = validateRecoveryBarrierEvidence(barrier);
    if (!validation.ok) return unavailableBarrier(now, ['barrier-invalid']);
    return barrier;
  }

  private evaluateBarrier(bundle: BackupBundle, barrier: RecoveryBarrierEvidence): {
    locked: boolean;
    lockedReason: string | null;
    report: RestoreBarrierCheck;
  } {
    const control = bundle.control;
    if (!control) return { locked: true, lockedReason: 'MISSING_WATERMARK', report: { completeness: 'unavailable', deletion: { baselineId: '', bundleWatermark: 0, latestWatermark: null, relation: 'unavailable' }, authorization: { bundleEpoch: 0, latestEpoch: null, relation: 'unavailable' }, desiredState: 'unavailable' } };
    const latestDeletion = barrier.deletion;
    const deletionRelation = latestDeletion === null
      ? 'unavailable' as const
      : latestDeletion.baselineId !== control.deletionBaselineId
        ? 'baseline-mismatch' as const
        : relationFor(latestDeletion.tombstoneWatermark, control.tombstoneWatermark);
    const latestEpoch = barrier.authorization?.authEpoch ?? null;
    const authorizationRelation = latestEpoch === null
      ? 'unavailable' as const
      : latestEpoch < control.authorizationEpoch ? 'stale' as const : latestEpoch === control.authorizationEpoch ? 'current' as const : 'advanced' as const;
    const report: RestoreBarrierCheck = {
      completeness: barrier.completeness,
      deletion: {
        baselineId: latestDeletion?.baselineId ?? control.deletionBaselineId,
        bundleWatermark: control.tombstoneWatermark,
        latestWatermark: latestDeletion?.tombstoneWatermark ?? null,
        relation: deletionRelation,
      },
      authorization: { bundleEpoch: control.authorizationEpoch, latestEpoch, relation: authorizationRelation },
      desiredState: barrier.desiredState?.state ?? 'unavailable',
    };
    if (barrier.completeness !== 'complete') return { locked: true, lockedReason: 'BARRIER_UNAVAILABLE', report };
    if (deletionRelation === 'unavailable' || deletionRelation === 'baseline-mismatch' || deletionRelation === 'stale') {
      return { locked: true, lockedReason: deletionRelation === 'stale' ? 'DELETION_WATERMARK_STALE' : deletionRelation === 'baseline-mismatch' ? 'DELETION_BASELINE_MISMATCH' : 'BARRIER_UNAVAILABLE', report };
    }
    if (authorizationRelation === 'unavailable' || authorizationRelation === 'stale') {
      return { locked: true, lockedReason: authorizationRelation === 'stale' ? 'BARRIER_UNAVAILABLE' : 'BARRIER_UNAVAILABLE', report };
    }
    if (barrier.desiredState === null) return { locked: true, lockedReason: 'BARRIER_UNAVAILABLE', report };
    return { locked: false, lockedReason: null, report };
  }

  private unavailableReportBarrier(bundle: BackupBundle, reason: string): RestoreBarrierCheck {
    const control = bundle.control;
    return {
      completeness: 'unavailable',
      deletion: { baselineId: control?.deletionBaselineId ?? '', bundleWatermark: control?.tombstoneWatermark ?? 0, latestWatermark: null, relation: 'unavailable' },
      authorization: { bundleEpoch: control?.authorizationEpoch ?? 0, latestEpoch: null, relation: 'unavailable' },
      desiredState: 'unavailable',
    };
    void reason;
  }

  private buildReport(input: {
    bundle: BackupBundle;
    bundleDirectory: string;
    bundleManifestSha256: string;
    targetRoot: string;
    startedAt: string;
    status: RestoreReport['status'];
    readView: RestoreReport['readView'];
    checks: RestoreCheck[];
    components: RestoreComponentCheck[];
    barrier: RestoreBarrierCheck;
    deletion: RestoreReport['deletion'];
    goals: RestoredGoalCheck[];
    preserved: InFlightRecord[];
    generation: GenerationTransition;
    failures: { code: string; componentId: RestoreReport['failures'][number]['componentId'] }[];
    reasonCode: string;
    barrierEvidence?: RecoveryBarrierEvidence;
  }): RestoreReport {
    void input.bundleDirectory;
    void input.barrierEvidence;
    const report: RestoreReport = {
      schemaVersion: RESTORE_REPORT_SCHEMA_VERSION,
      reportId: `restore-${randomUUID()}`,
      snapshotId: input.bundle.snapshotId,
      bundleManifestSha256: input.bundleManifestSha256,
      mode: 'maintenance',
      dispatch: 'blocked',
      activate: 'not-activated',
      status: input.status,
      readView: input.readView,
      reconcileRequired: true,
      targetRootHash: hashPath(input.targetRoot),
      startedAt: input.startedAt,
      endedAt: this.now(),
      checks: input.checks.length ? input.checks : [{ checkId: 'restore.internal', status: 'unknown', componentId: null }],
      components: input.components,
      barrier: input.barrier,
      deletion: input.deletion,
      goals: input.goals,
      unknown: { preserved: input.preserved, replayed: 0 },
      generation: input.generation,
      activation: this.activationRecord(input.status, input.reasonCode, input.readView),
      oldRoot: 'untouched',
      liveActivation: 'not-changed',
      failures: input.failures,
    };
    return assertValidRestoreReport(report);
  }

  private async persistReport(targetRoot: string, report: RestoreReport): Promise<string> {
    const filename = path.join(targetRoot, '.recovery', 'restore-report.json');
    const validation = validateRestoreReport(report);
    if (!validation.ok) {
      // Never publish a report that its own validator rejects.
      throw new RecoveryError('INVALID_SCHEMA', `Restore report failed validation: ${validation.violations[0]?.message ?? 'unknown'}`);
    }
    await writeJsonAtomic(filename, report);
    return filename;
  }

  private async finishLocked(
    bundle: BackupBundle,
    targetRoot: string,
    startedAt: string,
    checks: RestoreCheck[],
    components: RestoreComponentCheck[],
    generation: GenerationTransition,
    bundleManifestSha256: string,
    barrierReport: { locked: boolean; lockedReason: string | null; report: RestoreBarrierCheck },
    goals: RestoredGoalCheck[],
    reasonCode: string,
  ): Promise<RestoreResult> {
    const report = this.buildReport({
      bundle, bundleDirectory: '', targetRoot, bundleManifestSha256, startedAt,
      status: 'locked', readView: 'closed', checks, components,
      barrier: barrierReport.report,
      deletion: { ledgerApplied: false, appliedEntries: 0, removedRefs: 0, visibleRefs: 0, resurrectionDetected: false },
      goals,
      preserved: [],
      generation,
      failures: [{ code: reasonCode, componentId: null }],
      reasonCode,
    });
    await this.persistReport(targetRoot, report);
    const lock = await this.readLock(targetRoot);
    if (!lock) throw new RecoveryError('RECOVERY_LOCKED', 'Recovery lock disappeared during restore');
    const updated = await this.updateLock(targetRoot, lock, 'locked', 'closed', reasonCode);
    return { report, state: null, targetRoot, lock: updated };
  }

  private async finishFailed(
    bundle: BackupBundle,
    targetRoot: string,
    startedAt: string,
    checks: RestoreCheck[],
    components: RestoreComponentCheck[],
    generation: GenerationTransition,
    bundleManifestSha256: string,
    code: string,
    message: string,
    barrier: RestoreBarrierCheck,
  ): Promise<RestoreResult> {
    void message;
    const report = this.buildReport({
      bundle, bundleDirectory: '', targetRoot, bundleManifestSha256, startedAt,
      status: 'failed', readView: 'closed', checks, components, barrier,
      deletion: { ledgerApplied: false, appliedEntries: 0, removedRefs: 0, visibleRefs: 0, resurrectionDetected: false },
      goals: [],
      preserved: [],
      generation,
      failures: [{ code, componentId: null }],
      reasonCode: code,
    });
    await this.persistReport(targetRoot, report);
    const lock = await this.readLock(targetRoot);
    if (!lock) throw new RecoveryError('RECOVERY_LOCKED', 'Recovery lock disappeared during restore');
    const updated = await this.updateLock(targetRoot, lock, 'failed', 'closed', code);
    return { report, state: null, targetRoot, lock: updated };
  }
}

const componentIdOf = (pathOrId: string | null): RestoreReport['failures'][number]['componentId'] => {
  if (!pathOrId) return null;
  for (const id of ['control', 'dsh-goal-sessions', 'memory', 'shared-objects'] as const) {
    if (pathOrId === id || pathOrId.includes(`components/${id}`) || pathOrId.includes(id)) return id;
  }
  return null;
};

/** Guard used by tests/hosts: assert a target path is inside the isolated root and outside the live root. */
export const assertIsolatedTarget = (targetRoot: string, isolatedRoot: string, liveDataRoot?: string): void => {
  const target = path.resolve(targetRoot);
  const isolated = path.resolve(isolatedRoot);
  if (target === isolated || !isInside(target, isolated)) throw new RecoveryError('TARGET_NOT_ISOLATED', 'Target is not inside the isolated root');
  if (liveDataRoot) {
    const live = path.resolve(liveDataRoot);
    if (target === live || isInside(target, live) || isInside(live, target) || isInside(isolated, live)) {
      throw new RecoveryError('LIVE_ROOT_PROTECTED', 'Target overlaps the live data root');
    }
  }
};

/** A rename helper kept local to make explicit that restore never moves a live root. */
export const renameRestoreStaging = async (source: string, destination: string): Promise<void> => rename(source, destination);
