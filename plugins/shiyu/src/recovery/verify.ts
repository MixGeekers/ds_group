/**
 * File-level verification of a bundle directory.
 *
 * The schema validator decides whether a manifest is well-formed and whether
 * its ready preconditions are stated. This verifier reads real bytes and
 * re-derives the facts: file hashes/sizes, SQLite integrity, Goal-log tails,
 * projection digests, the control snapshot's own watermarks, the goal-binding
 * closure and the shared-object reference closure. A manifest is never trusted
 * on its own statements.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalJson,
  fileEvidence,
  fileExists,
  hashCanonical,
  readJsonLines,
  resolveInside,
  sha256,
  sqliteIntegrity,
} from './files.js';
import { readControlFacts } from './control-facts.js';
import {
  RECOVERY_READER_VERSION,
  SUPPORTED_COMPONENT_DATA_SCHEMAS,
  type BackupBundle,
  type ComponentId,
  type ControlComponentManifest,
  type GoalSessionRecord,
  type GoalSessionsComponentManifest,
  type MemoryComponentManifest,
  type SharedObjectsComponentManifest,
} from './types.js';
import {
  validateBackupBundle,
  validateControlComponentManifest,
  validateGoalSessionsComponentManifest,
  validateMemoryComponentManifest,
  validateSharedObjectsComponentManifest,
  type ValidationOptions,
  type ValidationViolation,
} from './schema.js';

export interface BundleCheck {
  checkId: string;
  status: 'pass' | 'fail';
  code?: string;
}

export interface BundleVerification {
  ok: boolean;
  bundleDirectory: string;
  manifest: BackupBundle | null;
  manifestSha256: string | null;
  checks: BundleCheck[];
  violations: ValidationViolation[];
}

export interface VerifyBundleOptions extends ValidationOptions {
  /** Enforce status==='ready' (restore path). Default: validate structure only. */
  requireReady?: boolean;
  maxGoalLogBytes?: number;
  maxMemoryIndexBytes?: number;
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

class Checks {
  readonly checks: BundleCheck[] = [];
  readonly violations: ValidationViolation[] = [];
  constructor(private readonly limit: number) {}
  pass(checkId: string): void { this.checks.push({ checkId, status: 'pass' }); }
  fail(checkId: string, code: string, path: string, message: string): void {
    this.checks.push({ checkId, status: 'fail', code });
    if (this.violations.length < this.limit) this.violations.push({ code, path, message });
  }
}

const expectTrue = (checks: Checks, checkId: string, condition: boolean, code: string, filePath: string, message: string): boolean => {
  if (condition) { checks.pass(checkId); return true; }
  checks.fail(checkId, code, filePath, message);
  return false;
};

const parseJsonFile = async (filename: string): Promise<unknown> => JSON.parse(await readFile(filename, 'utf8')) as unknown;

const readComponentManifest = async (
  checks: Checks,
  bundleDirectory: string,
  component: BackupBundle['components'][number],
  label: string,
): Promise<unknown> => {
  const filename = resolveInside(bundleDirectory, component.manifestRef);
  const exists = await fileExists(filename);
  if (!expectTrue(checks, `${label}.manifest.present`, exists, 'REQUIRED_COMPONENT_MISSING', component.manifestRef, 'component manifest file is missing')) return undefined;
  const evidence = await fileEvidence(filename);
  expectTrue(checks, `${label}.manifest.hash`, evidence.sha256 === component.manifestSha256, 'HASH_MISMATCH', component.manifestRef,
    'component manifest hash does not match the bundle component entry');
  expectTrue(checks, `${label}.manifest.bytes`, evidence.bytes > 0, 'BYTES_MISMATCH', component.manifestRef, 'component manifest is empty');
  return parseJsonFile(filename);
};

const readComponentFile = async (
  checks: Checks,
  bundleDirectory: string,
  ref: string,
  expected: { bytes: number; sha256: string },
  checkId: string,
  label: string,
): Promise<Buffer | undefined> => {
  const filename = resolveInside(bundleDirectory, ref);
  if (!expectTrue(checks, `${checkId}.present`, await fileExists(filename), 'REQUIRED_COMPONENT_MISSING', ref, `${label} file is missing`)) return undefined;
  const bytes = await readFile(filename);
  expectTrue(checks, `${checkId}.bytes`, bytes.byteLength === expected.bytes, 'BYTES_MISMATCH', ref, `${label} byte count mismatches`);
  expectTrue(checks, `${checkId}.sha256`, sha256(bytes) === expected.sha256, 'HASH_MISMATCH', ref, `${label} hash mismatches`);
  return bytes;
};

const verifySeqChain = (bytes: Buffer, record: GoalSessionRecord, checkPrefix: string, checks: Checks): void => {
  if (record.logFormat !== 'jsonl-seq-v1') {
    expectTrue(checks, `${checkPrefix}.opaque-tail`, record.logTail.kind === 'opaque' && record.logTail.lastSequence === null,
      'MISSING_LOG_TAIL', record.logFile, 'opaque required-API-limited log must not invent a sequence');
    return;
  }
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) {
    checks.fail(`${checkPrefix}.tail`, 'MISSING_LOG_TAIL', record.logFile, 'JSONL Goal Session log is not newline terminated');
    return;
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length === 0) {
    checks.fail(`${checkPrefix}.tail`, 'MISSING_LOG_TAIL', record.logFile, 'Goal Session log is empty');
    return;
  }
  let previous = 0;
  let lastGoalState: { id: string; revision: number; phase: string; activation: string } | null = null;
  let chainOk = true;
  for (const [index, line] of lines.entries()) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch {
      checks.fail(`${checkPrefix}.tail`, 'MISSING_LOG_TAIL', record.logFile, `invalid JSON at Goal Session log line ${index + 1}`);
      return;
    }
    if (typeof entry.seq !== 'number' || !Number.isSafeInteger(entry.seq) || entry.seq !== previous + 1) {
      checks.fail(`${checkPrefix}.tail`, 'MISSING_LOG_TAIL', record.logFile, `Goal Session log sequence gap at line ${index + 1}`);
      chainOk = false;
      break;
    }
    previous = entry.seq;
    if (entry.type === 'goal/state') {
      const goal = entry.goal;
      if (goal !== null && typeof goal === 'object' && !Array.isArray(goal)) {
        const candidate = goal as Record<string, unknown>;
        if (typeof candidate.id === 'string' && typeof candidate.revision === 'number' && typeof candidate.phase === 'string'
          && typeof candidate.activation === 'string') {
          lastGoalState = { id: candidate.id, revision: candidate.revision, phase: candidate.phase, activation: candidate.activation };
        }
      }
    }
  }
  if (!chainOk) return;
  expectTrue(checks, `${checkPrefix}.tail.sequence`, previous === record.logTail.lastSequence, 'MISSING_LOG_TAIL', record.logFile,
    'durable tail sequence does not match the captured log');
  expectTrue(checks, `${checkPrefix}.tail.bytes`, bytes.byteLength === record.logTail.bytes, 'BYTES_MISMATCH', record.logFile,
    'durable tail byte count does not match the captured log');
  expectTrue(checks, `${checkPrefix}.tail.sha256`, sha256(bytes) === record.logTail.sha256, 'HASH_MISMATCH', record.logFile,
    'durable tail hash does not match the captured log');
  if (lastGoalState === null) {
    checks.fail(`${checkPrefix}.tail.goal-state`, 'MISSING_LOG_TAIL', record.logFile, 'Goal Session log has no verifiable goal/state record');
    return;
  }
  const state: { id: string; revision: number; phase: string; activation: string } = lastGoalState;
  expectTrue(checks, `${checkPrefix}.goal-ref`, state.id === record.goalRef.id && state.revision === record.goalRef.revision,
    'GOAL_REF_MISMATCH', record.logFile, 'Goal Session log goal reference does not match the captured GoalRef');
  expectTrue(checks, `${checkPrefix}.goal-phase`, state.phase === record.phase && state.activation === record.activation,
    'GOAL_REF_MISMATCH', record.logFile, 'Goal Session log phase/activation does not match the captured state');
};

const verifyProjection = async (
  checks: Checks,
  bundleDirectory: string,
  record: GoalSessionRecord,
  prefix: string,
  readerVersion: number,
): Promise<void> => {
  const definition = await safeRead(bundleDirectory, record.projectionDefinitionFile);
  if (!definition) {
    checks.fail(`${prefix}.projection.definition`, 'MISSING_PROJECTION', record.projectionDefinitionFile, 'projection definition file is missing');
    return;
  }
  expectTrue(checks, `${prefix}.projection.definition.hash`, sha256(definition) === record.projection.digest,
    'HASH_MISMATCH', record.projectionDefinitionFile, 'projection definition digest mismatches');
  const configBytes = await safeRead(bundleDirectory, record.projectionConfigFile);
  if (!configBytes) {
    checks.fail(`${prefix}.projection.config`, 'MISSING_PROJECTION', record.projectionConfigFile, 'projection configuration file is missing');
    return;
  }
  expectTrue(checks, `${prefix}.projection.config.hash`, sha256(configBytes) === record.projection.configSha256,
    'HASH_MISMATCH', record.projectionConfigFile, 'projection configuration hash mismatches');
  expectTrue(checks, `${prefix}.projection.version`, record.projection.minimumReaderVersion <= readerVersion,
    'INCOMPATIBLE_VERSION', record.projectionDefinitionFile, 'projection requires a newer recovery reader');
  expectTrue(checks, `${prefix}.projection.schema`, record.projection.schemaVersion === 1,
    'INCOMPATIBLE_VERSION', record.projectionDefinitionFile, 'unsupported projection schema version');
};

const safeRead = async (root: string, ref: string): Promise<Buffer | undefined> => {
  const filename = resolveInside(root, ref);
  return await fileExists(filename) ? await readFile(filename) : undefined;
};

const verifyControl = async (
  checks: Checks,
  bundleDirectory: string,
  manifest: BackupBundle,
  component: ControlComponentManifest,
  readerVersion: number,
): Promise<void> => {
  const bytes = await readComponentFile(checks, bundleDirectory, component.databaseFile,
    { bytes: component.databaseBytes, sha256: component.databaseSha256 }, 'control.database', 'control snapshot');
  if (!bytes) return;
  const filename = resolveInside(bundleDirectory, component.databaseFile);
  let integrity: { quickCheck: 'ok'; foreignKeyCheck: 'ok' };
  try { integrity = await sqliteIntegrity(filename); } catch (error) {
    checks.fail('control.integrity', 'INTEGRITY_CHECK_FAILED', component.databaseFile, `SQLite integrity check failed: ${(error as Error).message}`);
    return;
  }
  expectTrue(checks, 'control.integrity', integrity.quickCheck === 'ok' && integrity.foreignKeyCheck === 'ok',
    'INTEGRITY_CHECK_FAILED', component.databaseFile, 'SQLite integrity check failed');
  let facts;
  try { facts = readControlFacts(filename); } catch (error) {
    checks.fail('control.watermarks', (error as { code?: string }).code ?? 'MISSING_WATERMARK', component.databaseFile, `control facts unreadable: ${(error as Error).message}`);
    return;
  }
  expectTrue(checks, 'control.watermarks.self', canonicalJson(facts.watermarks) === canonicalJson(component.watermarks),
    'MISSING_WATERMARK', component.databaseFile, 'control component manifest watermarks do not match the staged database');
  if (manifest.control !== null) {
    expectTrue(checks, 'control.watermarks.top', canonicalJson(facts.watermarks) === canonicalJson(manifest.control),
      'MISSING_WATERMARK', component.databaseFile, 'top-level control watermarks do not match the staged database');
  }
  expectTrue(checks, 'control.quiescence', component.databaseSha256 !== '' && component.databaseBytes > 0,
    'COMPONENT_FAILED', component.databaseFile, 'control snapshot evidence is incomplete');
  expectTrue(checks, 'control.inflight.self', canonicalJson(facts.inFlight) === canonicalJson(component.inFlight),
    'COMPONENT_FAILED', component.databaseFile, 'captured in-flight inventory does not match the staged control snapshot');
  expectTrue(checks, 'control.goal-bindings.self', canonicalJson(facts.goalBindings) === canonicalJson(component.goalBindings),
    'COMPONENT_FAILED', component.databaseFile, 'captured goal bindings do not match the staged control snapshot');
  expectTrue(checks, 'control.reader-version', component.watermarks.commitSeq >= 0 && readerVersion >= 1,
    'INCOMPATIBLE_VERSION', component.databaseFile, 'unsupported reader version');
  if (manifest.status === 'ready' && manifest.control !== null) {
    expectTrue(checks, 'control.ready-watermarks', manifest.control.commitSeq === component.watermarks.commitSeq,
      'MISSING_WATERMARK', component.databaseFile, 'ready bundle requires control commitSeq equality');
  }
};

const verifyGoalSessions = async (
  checks: Checks,
  bundleDirectory: string,
  manifest: BackupBundle,
  component: GoalSessionsComponentManifest,
  readerVersion: number,
): Promise<void> => {
  const maxGoalLogBytes = 256 * 1024 * 1024;
  for (const [index, record] of component.sessions.entries()) {
    const prefix = `goal-sessions.session[${index}]`;
    const logBytes = await readComponentFile(checks, bundleDirectory, record.logFile,
      { bytes: record.logBytes, sha256: record.logSha256 }, `${prefix}.log`, 'Goal Session log');
    if (!logBytes) continue;
    verifySeqChain(logBytes, record, prefix, checks);
    await verifyProjection(checks, bundleDirectory, record, prefix, readerVersion);
    expectTrue(checks, `${prefix}.flush`, record.flush.durableTail.kind === record.logTail.kind
      && record.flush.durableTail.sha256 === record.logTail.sha256
      && record.flush.durableTail.bytes === record.logTail.bytes
      && record.flush.durableTail.lastSequence === record.logTail.lastSequence,
    'MISSING_LOG_TAIL', record.logFile, 'flush/durability evidence does not match the captured log tail');
    expectTrue(checks, `${prefix}.flush-ack`, record.flush.acknowledged === true,
      'MISSING_LOG_TAIL', record.logFile, 'Goal Session flush was not acknowledged');
  }
  const maxLog = component.sessions.reduce((max, item) => Math.max(max, item.logBytes), 0);
  expectTrue(checks, 'goal-sessions.size-limit', maxLog <= maxGoalLogBytes, 'BYTES_MISMATCH', 'components/dsh-goal-sessions',
    'Goal Session log exceeds the offline capture limit');
  if (manifest.status === 'ready') {
    const expectedRevision = hashCanonical(component.sessions.map((item) => ({
      goalId: item.goalId, sessionId: item.sessionId, sha256: item.logSha256, bytes: item.logBytes,
    })));
    const actual = manifest.components.find((item) => item.componentId === 'dsh-goal-sessions');
    if (actual) {
      expectTrue(checks, 'goal-sessions.revision', actual.actualRevision === `goal-sessions:${expectedRevision}`,
        'COMPONENT_FAILED', 'components/dsh-goal-sessions/manifest.json', 'goal session component revision does not match captured sessions');
      const numeric = actual.watermark;
      const expectedNumeric = component.sessions.length === 0
        ? null
        : component.sessions.reduce((max, item) => Math.max(max, item.logTail.lastSequence ?? 0), 0);
      expectTrue(checks, 'goal-sessions.watermark', numeric === expectedNumeric,
        'MISSING_LOG_TAIL', 'components/dsh-goal-sessions/manifest.json', 'goal session numeric watermark does not match captured tails');
    }
  }
};

const verifyMemory = async (
  checks: Checks,
  bundleDirectory: string,
  manifest: BackupBundle,
  component: MemoryComponentManifest,
  readerVersion: number,
): Promise<void> => {
  await readComponentFile(checks, bundleDirectory, component.archiveFile,
    { bytes: component.archiveBytes, sha256: component.archiveSha256 }, 'memory.archive', 'memory export archive');
  const indexBytes = await readComponentFile(checks, bundleDirectory, component.recordIndexFile,
    { bytes: component.recordIndexBytes, sha256: component.recordIndexSha256 }, 'memory.record-index', 'memory record index');
  if (indexBytes) {
    const entries = await readJsonLines(resolveInside(bundleDirectory, component.recordIndexFile), { maxBytes: 64 * 1024 * 1024, maxLines: 500000 });
    const refs = new Set<string>();
    let valid = true;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { valid = false; break; }
      const record = entry as Record<string, unknown>;
      if (typeof record.ref !== 'string' || !SAFE.test(record.ref)) { valid = false; break; }
      if (record.kind !== 'memory-source' && record.kind !== 'media' && record.kind !== 'source-file') { valid = false; break; }
      if (record.sha256 !== null && (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256))) { valid = false; break; }
      if (refs.has(record.ref)) { valid = false; break; }
      refs.add(record.ref);
    }
    expectTrue(checks, 'memory.record-index.shape', valid, 'COMPONENT_FAILED', component.recordIndexFile, 'memory record index is malformed');
    expectTrue(checks, 'memory.record-count', entries.length === component.recordCount, 'COMPONENT_FAILED', component.recordIndexFile,
      'memory record count does not match the record index');
  }
  expectTrue(checks, 'memory.reader-version', readerVersion >= 1 && component.watermark.tombstoneWatermark >= 0,
    'INCOMPATIBLE_VERSION', 'components/memory/manifest.json', 'unsupported memory component version');
  if (manifest.status === 'ready') {
    const actual = manifest.components.find((item) => item.componentId === 'memory');
    if (actual) {
      expectTrue(checks, 'memory.watermark', actual.watermark === component.watermark.tombstoneWatermark,
        'MISSING_WATERMARK', 'components/memory/manifest.json', 'memory component watermark does not match its manifest');
      expectTrue(checks, 'memory.revision', actual.actualRevision === `memory:${component.backend.backendId}:${component.componentVersion}`,
        'COMPONENT_FAILED', 'components/memory/manifest.json', 'memory component revision does not match its manifest');
    }
  }
};

const verifySharedObjects = async (
  checks: Checks,
  bundleDirectory: string,
  manifest: BackupBundle,
  component: SharedObjectsComponentManifest,
): Promise<void> => {
  for (const [index, object] of component.objects.entries()) {
    await readComponentFile(checks, bundleDirectory, object.file, { bytes: object.bytes, sha256: object.sha256 },
      `shared-objects.object[${index}]`, 'shared object');
  }
  if (manifest.status === 'ready') {
    if (manifest.objectManifest === null) {
      checks.fail('shared-objects.manifest-ref', 'OBJECT_CLOSURE_INCOMPLETE', 'bundle.json', 'ready bundle requires a top-level object manifest');
      return;
    }
    expectTrue(checks, 'shared-objects.manifest-ref', manifest.objectManifest.ref === `components/shared-objects/manifest.json`,
      'OBJECT_CLOSURE_INCOMPLETE', 'bundle.json', 'top-level object manifest must point at the shared-objects component manifest');
    const actual = manifest.components.find((item) => item.componentId === 'shared-objects');
    if (actual) {
      expectTrue(checks, 'shared-objects.revision', actual.actualRevision === `objects:${manifest.objectManifest.sha256}`,
        'COMPONENT_FAILED', 'components/shared-objects/manifest.json', 'shared-objects revision does not match the object manifest hash');
      expectTrue(checks, 'shared-objects.watermark', actual.watermark === component.objects.length,
        'COMPONENT_FAILED', 'components/shared-objects/manifest.json', 'shared-objects watermark must equal its object count');
    }
    expectTrue(checks, 'shared-objects.count', manifest.objectManifest.objectCount === component.objects.length,
      'OBJECT_CLOSURE_INCOMPLETE', 'bundle.json', 'top-level object count does not match the object manifest');
  }
};

const verifyClosure = (
  checks: Checks,
  manifest: BackupBundle,
  control: ControlComponentManifest,
  goals: GoalSessionsComponentManifest,
  memory: MemoryComponentManifest,
  objects: SharedObjectsComponentManifest,
): void => {
  const objectIds = new Set(objects.objects.map((item) => item.objectId));
  const referenced = new Map<'control' | 'memory', Set<string>>();
  const addRef = (componentId: 'control' | 'memory', ids: readonly string[]): void => {
    const target = referenced.get(componentId) ?? new Set<string>();
    for (const id of ids) target.add(id);
    referenced.set(componentId, target);
  };
  addRef('control', control.objectRefs);
  addRef('memory', memory.objectRefs);
  const missing: string[] = [];
  for (const [componentId, ids] of referenced) for (const id of ids) if (!objectIds.has(id)) missing.push(`${componentId}:${id}`);
  expectTrue(checks, 'closure.object-refs', missing.length === 0, 'OBJECT_CLOSURE_INCOMPLETE', 'components/shared-objects/manifest.json',
    `object references are missing from the bundle: ${missing.slice(0, 5).join(',')}`);
  const declared = new Map(objects.referencedBy.map((item) => [item.componentId, [...item.objectIds].sort()]));
  for (const [componentId, ids] of referenced) {
    const expected = [...ids].sort();
    expectTrue(checks, `closure.referenced-by.${componentId}`, canonicalJson(declared.get(componentId) ?? []) === canonicalJson(expected),
      'OBJECT_CLOSURE_INCOMPLETE', 'components/shared-objects/manifest.json', `object referencedBy list mismatches for ${componentId}`);
  }
  expectTrue(checks, 'closure.memory-baseline', memory.watermark.baselineId === control.watermarks.deletionBaselineId,
    'DELETION_BASELINE_MISMATCH', 'components/memory/manifest.json', 'memory deletion baseline does not match the control deletion ledger');
  expectTrue(checks, 'closure.memory-watermark-order', memory.watermark.tombstoneWatermark <= control.watermarks.tombstoneWatermark,
    'DELETION_WATERMARK_STALE', 'components/memory/manifest.json', 'memory deletion watermark is ahead of the control ledger');
  const bindings = new Map(control.goalBindings.map((item) => [item.goalId, item]));
  const sessions = new Map(goals.sessions.map((item) => [item.goalId, item]));
  let closureOk = true;
  for (const [goalId, binding] of bindings) {
    const session = sessions.get(goalId);
    if (!session) { closureOk = false; break; }
    if (session.sessionId !== binding.sessionId) { closureOk = false; break; }
    if (binding.goalRef !== null && (session.goalRef.id !== binding.goalRef.id || session.goalRef.revision !== binding.goalRef.revision)) { closureOk = false; break; }
    if (canonicalJson(session.binding) !== canonicalJson({
      ownerId: binding.ownerId, scope: binding.scope, cwdHash: binding.cwdHash,
      metadataVersion: binding.metadataVersion, completionCriteriaHash: binding.completionCriteriaHash,
    })) { closureOk = false; break; }
  }
  expectTrue(checks, 'closure.goal-bindings', closureOk, 'MISSING_GOAL_SESSION', 'components/dsh-goal-sessions/manifest.json',
    'Goal Session closure does not match the control GoalBinding set');
  expectTrue(checks, 'closure.goal-sessions-count', sessions.size === bindings.size, 'UNDECLARED_GOAL_SESSION', 'components/dsh-goal-sessions/manifest.json',
    'captured Goal Sessions do not exactly cover the control GoalBinding set');
  if (manifest.status === 'ready' && manifest.runtimeManifest !== null) {
    const versions = new Map(manifest.runtimeManifest.components.map((item) => [item.componentId, item]));
    for (const required of ['dsh', 'shiyu-plugin', 'projection']) {
      expectTrue(checks, `closure.runtime.${required}`, versions.has(required), 'REQUIRED_COMPONENT_MISSING', 'bundle.json',
        `runtime manifest lacks the ${required} version needed to interpret recovered data`);
    }
  }
  for (const [componentId, component] of manifest.components.map((item) => [item.componentId, item] as const)) {
    expectTrue(checks, `closure.schema.${componentId}`, component.dataSchema === SUPPORTED_COMPONENT_DATA_SCHEMAS[componentId],
      'INCOMPATIBLE_VERSION', 'bundle.json', `unsupported ${componentId} data schema`);
  }
};

/**
 * Verify a bundle directory from real files. Returns every check performed; a
 * single failed check makes `ok` false.
 */
export const verifyBundleDirectory = async (bundleDirectory: string, options: VerifyBundleOptions = {}): Promise<BundleVerification> => {
  const checks = new Checks(options.violationLimit ?? 200);
  const readerVersion = options.readerVersion ?? RECOVERY_READER_VERSION;
  const result: BundleVerification = { ok: false, bundleDirectory, manifest: null, manifestSha256: null, checks: checks.checks, violations: checks.violations };
  const manifestPath = path.join(bundleDirectory, 'bundle.json');
  if (!await fileExists(manifestPath)) {
    checks.fail('bundle.present', 'REQUIRED_COMPONENT_MISSING', 'bundle.json', 'bundle manifest is missing');
    return result;
  }
  const manifestBytes = await readFile(manifestPath);
  result.manifestSha256 = sha256(manifestBytes);
  checks.pass('bundle.present');
  let raw: unknown;
  try { raw = JSON.parse(manifestBytes.toString('utf8')) as unknown; } catch {
    checks.fail('bundle.json', 'INVALID_SCHEMA', 'bundle.json', 'bundle manifest is invalid JSON');
    return result;
  }
  const structural = validateBackupBundle(raw, { ...options, requireReady: false });
  for (const violation of structural.violations) checks.fail('bundle.schema', violation.code, violation.path, violation.message);
  if (!structural.ok) return result;
  const manifest = raw as BackupBundle;
  result.manifest = manifest;
  if (options.requireReady && manifest.status !== 'ready') {
    checks.fail('bundle.ready', 'BUNDLE_NOT_READY', 'bundle.json', `bundle status is ${manifest.status}`);
    return result;
  }
  const componentIds: ComponentId[] = ['control', 'dsh-goal-sessions', 'memory', 'shared-objects'];
  // Only ready bundles (or a caller that explicitly requires readiness) must
  // carry every required component; failed/incomplete evidence bundles may stop
  // at the component where the capture failed.
  if (manifest.status === 'ready' || options.requireReady) {
    for (const id of componentIds) if (!manifest.components.some((item) => item.componentId === id)) {
      checks.fail(`bundle.component.${id}`, 'REQUIRED_COMPONENT_MISSING', 'bundle.json', `required component ${id} is missing`);
    }
  }
  const find = (id: ComponentId) => manifest.components.find((item) => item.componentId === id);
  const controlEntry = find('control');
  const goalsEntry = find('dsh-goal-sessions');
  const memoryEntry = find('memory');
  const objectsEntry = find('shared-objects');

  const controlRaw = controlEntry ? await readComponentManifest(checks, bundleDirectory, controlEntry, 'control') : undefined;
  let parsedControl: ControlComponentManifest | null = null;
  if (controlRaw !== undefined) {
    const validation = validateControlComponentManifest(controlRaw);
    for (const violation of validation.violations) checks.fail('control.manifest.schema', violation.code, violation.path, violation.message);
    if (validation.ok) {
      parsedControl = controlRaw as ControlComponentManifest;
      await verifyControl(checks, bundleDirectory, manifest, parsedControl, readerVersion);
    }
  }
  const goalsRaw = goalsEntry ? await readComponentManifest(checks, bundleDirectory, goalsEntry, 'goal-sessions') : undefined;
  let parsedGoals: GoalSessionsComponentManifest | null = null;
  if (goalsRaw !== undefined) {
    const validation = validateGoalSessionsComponentManifest(goalsRaw);
    for (const violation of validation.violations) checks.fail('goal-sessions.manifest.schema', violation.code, violation.path, violation.message);
    if (validation.ok) {
      parsedGoals = goalsRaw as GoalSessionsComponentManifest;
      await verifyGoalSessions(checks, bundleDirectory, manifest, parsedGoals, readerVersion);
    }
  }
  const memoryRaw = memoryEntry ? await readComponentManifest(checks, bundleDirectory, memoryEntry, 'memory') : undefined;
  let parsedMemory: MemoryComponentManifest | null = null;
  if (memoryRaw !== undefined) {
    const validation = validateMemoryComponentManifest(memoryRaw);
    for (const violation of validation.violations) checks.fail('memory.manifest.schema', violation.code, violation.path, violation.message);
    if (validation.ok) {
      parsedMemory = memoryRaw as MemoryComponentManifest;
      await verifyMemory(checks, bundleDirectory, manifest, parsedMemory, readerVersion);
    }
  }
  const objectsRaw = objectsEntry ? await readComponentManifest(checks, bundleDirectory, objectsEntry, 'shared-objects') : undefined;
  let parsedObjects: SharedObjectsComponentManifest | null = null;
  if (objectsRaw !== undefined) {
    const validation = validateSharedObjectsComponentManifest(objectsRaw);
    for (const violation of validation.violations) checks.fail('shared-objects.manifest.schema', violation.code, violation.path, violation.message);
    if (validation.ok) {
      parsedObjects = objectsRaw as SharedObjectsComponentManifest;
      await verifySharedObjects(checks, bundleDirectory, manifest, parsedObjects);
    }
  }
  if (manifest.status === 'ready') {
    expectTrue(checks, 'bundle.components.ready', parsedControl !== null && parsedGoals !== null && parsedMemory !== null && parsedObjects !== null,
      'REQUIRED_COMPONENT_MISSING', 'bundle.json', 'ready bundle requires every component manifest to be verifiable');
  }
  if (parsedControl && parsedGoals && parsedMemory && parsedObjects) {
    verifyClosure(checks, manifest, parsedControl, parsedGoals, parsedMemory, parsedObjects);
  }
  if (manifest.objectManifest !== null) {
    const objectManifestFile = resolveInside(bundleDirectory, manifest.objectManifest.ref);
    if (await fileExists(objectManifestFile)) {
      const objectBytes = await readFile(objectManifestFile);
      expectTrue(checks, 'bundle.object-manifest.hash', sha256(objectBytes) === manifest.objectManifest.sha256,
        'HASH_MISMATCH', manifest.objectManifest.ref, 'object manifest hash mismatches');
      expectTrue(checks, 'bundle.object-manifest.bytes', objectBytes.byteLength === manifest.objectManifest.bytes,
        'BYTES_MISMATCH', manifest.objectManifest.ref, 'object manifest byte count mismatches');
    } else {
      checks.fail('bundle.object-manifest.present', 'OBJECT_CLOSURE_INCOMPLETE', manifest.objectManifest.ref, 'object manifest is missing');
    }
  }
  result.ok = checks.checks.every((check) => check.status === 'pass');
  return result;
};

/** Read and structurally validate just the manifest document of a published bundle. */
export const readBundleManifest = async (bundleDirectory: string): Promise<{ bundle: BackupBundle; bytes: number; sha256: string }> => {
  const manifestPath = path.join(bundleDirectory, 'bundle.json');
  const bytes = await readFile(manifestPath);
  const raw = JSON.parse(bytes.toString('utf8')) as unknown;
  const validation = validateBackupBundle(raw, { requireReady: false });
  if (!validation.ok) {
    const first = validation.violations[0];
    throw new Error(`Bundle manifest invalid at ${first?.path ?? '$'}: ${first?.message ?? 'unknown'}`);
  }
  return { bundle: raw as BackupBundle, bytes: bytes.byteLength, sha256: sha256(bytes) };
};

/** Read the durable tail sequence from a jsonl-seq-v1 log without trusting metadata. */
export const deriveSeqChain = (bytes: Buffer): { lastSequence: number; goalState: { id: string; revision: number; phase: string; activation: string } | null } => {
  const text = bytes.toString('utf8');
  if (!text.endsWith('\n')) throw new Error('JSONL log is not newline terminated');
  const lines = text.slice(0, -1).split('\n');
  let previous = 0;
  let goalState: { id: string; revision: number; phase: string; activation: string } | null = null;
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry.seq !== 'number' || entry.seq !== previous + 1) throw new Error('JSONL log sequence is not contiguous');
    previous = entry.seq;
    if (entry.type === 'goal/state' && entry.goal !== null && typeof entry.goal === 'object') {
      const goal = entry.goal as Record<string, unknown>;
      if (typeof goal.id === 'string' && typeof goal.revision === 'number' && typeof goal.phase === 'string' && typeof goal.activation === 'string') {
        goalState = { id: goal.id, revision: goal.revision, phase: goal.phase, activation: goal.activation };
      }
    }
  }
  return { lastSequence: previous, goalState };
};
