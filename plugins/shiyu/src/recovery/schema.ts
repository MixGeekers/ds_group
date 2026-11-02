/**
 * Strict schema + semantic validation for the H5-B1 checkpoint contracts.
 *
 * "Readable JSON" is never sufficient: every validator checks structure,
 * bounded sizes, canonical times, independent versions, reference shapes and
 * the ready-publication preconditions (required components, actual watermark
 * or verifiable revision, compatible reader versions, conservative
 * captureTime). File existence / hash closure is verified separately by
 * verifyBundleDirectory, which reads real bytes.
 */
import { RecoveryError } from './errors.js';
import {
  BUNDLE_SCHEMA_VERSION,
  COMPONENT_MANIFEST_SCHEMA_VERSION,
  DELETION_LEDGER_SCHEMA_VERSION,
  GENERATION_RECORD_SCHEMA_VERSION,
  RECOVERY_LOCK_SCHEMA_VERSION,
  RECOVERY_READER_VERSION,
  REQUIRED_COMPONENT_IDS,
  RESTORE_REPORT_SCHEMA_VERSION,
  STAGING_JOURNAL_SCHEMA_VERSION,
  SUPPORTED_COMPONENT_DATA_SCHEMAS,
  type BackupBundle,
  type BundleComponent,
  type ComponentId,
  type ControlComponentManifest,
  type DeletionLedger,
  type GenerationTransition,
  type GoalSessionsComponentManifest,
  type LastGoodPointer,
  type MemoryComponentManifest,
  type RecoveryActivationRecord,
  type RecoveryBarrierEvidence,
  type RecoveryLockRecord,
  type RestoreReport,
  type RuntimeManifest,
  type SharedObjectsComponentManifest,
  type StagingJournal,
} from './types.js';

export interface ValidationViolation {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: ValidationViolation[];
}

export interface ValidationOptions {
  readerVersion?: number;
  expectedRootId?: string;
  expectedSnapshotId?: string;
  requireReady?: boolean;
  violationLimit?: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID_LIKE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLATFORM = /^(darwin|linux|win32|freebsd|openbsd|sunos|aix|android)$/;
const COMPONENT_VERSION_ID = /^[a-z][a-z0-9-]{1,40}$/;
const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete'] as const;
const ACTIVATIONS = ['armed', 'disarmed'] as const;
const TAIL_KINDS = ['jsonl-seq-v1', 'opaque'] as const;
const FLUSH_KINDS = ['host-flush', 'maintenance-window', 'quiescent-copy'] as const;
const IN_FLIGHT_KINDS = ['goal-command', 'effect', 'budget-reservation', 'memory-operation'] as const;
const COMMAND_STATUSES = ['none', 'pending', 'unknown', 'confirmed', 'rejected'] as const;
const COMPONENT_IDS: readonly ComponentId[] = REQUIRED_COMPONENT_IDS;

class Violations {
  readonly items: ValidationViolation[] = [];
  constructor(private readonly limit: number) {}
  add(code: string, path: string, message: string): void {
    if (this.items.length < this.limit) this.items.push({ code, path, message });
  }
  get full(): boolean { return this.items.length >= this.limit; }
  result(): ValidationResult { return { ok: this.items.length === 0, violations: this.items }; }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const ownData = (value: Record<string, unknown>, key: string): boolean => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
};

const checkObject = (
  out: Violations,
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): value is Record<string, unknown> => {
  if (!isPlainObject(value)) { out.add('type', path, 'expected a plain object'); return false; }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) { out.add('unknown-field', `${path}.${key}`, 'unknown field'); continue; }
    if (!ownData(value, key)) out.add('accessor-field', `${path}.${key}`, 'fields must be plain enumerable data properties');
  }
  for (const key of required) if (!Object.hasOwn(value, key)) out.add('missing-field', `${path}.${key}`, 'required field is missing');
  return true;
};

const checkArray = (out: Violations, value: unknown, path: string, maxItems: number): value is unknown[] => {
  if (!Array.isArray(value)) { out.add('type', path, 'expected an array'); return false; }
  if (Object.getPrototypeOf(value) !== Array.prototype) { out.add('type', path, 'expected a plain array'); return false; }
  if (value.length > maxItems) { out.add('limit', path, `array exceeds ${maxItems} items`); return false; }
  return true;
};

const checkText = (out: Violations, value: unknown, path: string, options: { max?: number; pattern?: RegExp; min?: number } = {}): value is string => {
  if (typeof value !== 'string') { out.add('type', path, 'expected a string'); return false; }
  const min = options.min ?? 1;
  if (value.length < min) { out.add('range', path, 'string is too short'); return false; }
  if (value.length > (options.max ?? 400)) { out.add('range', path, 'string is too long'); return false; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) { out.add('format', path, 'string contains control characters'); return false; }
  if (options.pattern && !options.pattern.test(value)) { out.add('format', path, 'string does not match the expected format'); return false; }
  return true;
};

const checkInteger = (out: Violations, value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    out.add('range', path, 'expected a bounded safe integer');
    return false;
  }
  return true;
};

const checkBoolean = (out: Violations, value: unknown, path: string, expected?: boolean): value is boolean => {
  if (typeof value !== 'boolean' || (expected !== undefined && value !== expected)) {
    out.add('value', path, expected === undefined ? 'expected a boolean' : `expected ${String(expected)}`);
    return false;
  }
  return true;
};

const checkTime = (out: Violations, value: unknown, path: string): value is string => {
  if (typeof value !== 'string' || value.length > 40) { out.add('type', path, 'expected a canonical UTC time'); return false; }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) { out.add('format', path, 'time must be canonical UTC ISO-8601'); return false; }
  return true;
};

const checkEnum = <T extends string>(out: Violations, value: unknown, path: string, allowed: readonly T[]): value is T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) { out.add('enum', path, `expected one of ${allowed.join('|')}`); return false; }
  return true;
};

const checkOneOf = (out: Violations, value: unknown, path: string, allowed: readonly string[]): void => {
  if (typeof value !== 'string' || !allowed.includes(value)) out.add('enum', path, `expected one of ${allowed.join('|')}`);
};

const checkStringArray = (out: Violations, value: unknown, path: string, maxItems: number, pattern: RegExp, unique = true): value is string[] => {
  if (!checkArray(out, value, path, maxItems)) return false;
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!checkText(out, item, `${path}[${index}]`, { max: 200, pattern })) continue;
    if (unique && seen.has(item)) out.add('duplicate', `${path}[${index}]`, 'duplicate entry');
    seen.add(item);
  }
  return true;
};

const checkHash = (out: Violations, value: unknown, path: string): value is string => checkText(out, value, path, { max: 64, min: 64, pattern: HASH });

/* ------------------------------------------------------------------------------------------------
 * Shared leaf validators
 * ---------------------------------------------------------------------------------------------- */

const checkGoalRef = (out: Violations, value: unknown, path: string): boolean => {
  if (!checkObject(out, value, path, ['id', 'revision'], ['id', 'revision'])) return false;
  checkText(out, value.id, `${path}.id`, { max: 200, pattern: SAFE_ID });
  checkInteger(out, value.revision, `${path}.revision`, 1);
  return true;
};

const checkLogTail = (out: Violations, value: unknown, path: string): boolean => {
  if (!checkObject(out, value, path, ['kind', 'bytes', 'sha256', 'lastSequence'], ['kind', 'bytes', 'sha256', 'lastSequence'])) return false;
  const kindOk = checkEnum(out, value.kind, `${path}.kind`, TAIL_KINDS);
  checkInteger(out, value.bytes, `${path}.bytes`, 0);
  checkHash(out, value.sha256, `${path}.sha256`);
  if (value.lastSequence === null) {
    if (kindOk && value.kind === 'jsonl-seq-v1') out.add('semantics', `${path}.lastSequence`, 'jsonl-seq-v1 requires a durable sequence');
  } else {
    checkInteger(out, value.lastSequence, `${path}.lastSequence`, 1);
    if (kindOk && value.kind === 'opaque') out.add('semantics', `${path}.lastSequence`, 'opaque tail must not invent a sequence');
  }
  return true;
};

const checkFlush = (out: Violations, value: unknown, path: string): boolean => {
  if (!checkObject(out, value, path, ['kind', 'acknowledged', 'durableTail', 'observedAt'], ['kind', 'acknowledged', 'durableTail', 'observedAt'])) return false;
  checkEnum(out, value.kind, `${path}.kind`, FLUSH_KINDS);
  checkBoolean(out, value.acknowledged, `${path}.acknowledged`, true);
  checkLogTail(out, value.durableTail, `${path}.durableTail`);
  checkTime(out, value.observedAt, `${path}.observedAt`);
  return true;
};

const checkProjection = (out: Violations, value: unknown, path: string): boolean => {
  if (!checkObject(out, value, path,
    ['projectionId', 'schemaVersion', 'minimumReaderVersion', 'digest', 'configSha256'],
    ['projectionId', 'schemaVersion', 'minimumReaderVersion', 'digest', 'configSha256'])) return false;
  checkText(out, value.projectionId, `${path}.projectionId`, { max: 120, pattern: SAFE_ID });
  checkInteger(out, value.schemaVersion, `${path}.schemaVersion`, 1);
  checkInteger(out, value.minimumReaderVersion, `${path}.minimumReaderVersion`, 1);
  checkHash(out, value.digest, `${path}.digest`);
  checkHash(out, value.configSha256, `${path}.configSha256`);
  return true;
};

const checkGenerationIdentity = (out: Violations, value: unknown, path: string): boolean => {
  if (!checkObject(out, value, path, ['installationGeneration', 'hostEpoch'], ['installationGeneration', 'hostEpoch'])) return false;
  checkText(out, value.installationGeneration, `${path}.installationGeneration`, { max: 120, pattern: UUID_LIKE });
  checkText(out, value.hostEpoch, `${path}.hostEpoch`, { max: 120, pattern: UUID_LIKE });
  return true;
};

const checkComponentVersion = (out: Violations, value: unknown, path: string): boolean => {
  if (!checkObject(out, value, path,
    ['componentId', 'version', 'upstreamCommit', 'patchDigest', 'dataSchema', 'minimumReaderVersion'],
    ['componentId', 'version', 'upstreamCommit', 'patchDigest', 'dataSchema', 'minimumReaderVersion'])) return false;
  checkText(out, value.componentId, `${path}.componentId`, { max: 40, pattern: COMPONENT_VERSION_ID });
  checkText(out, value.version, `${path}.version`, { max: 80 });
  checkText(out, value.upstreamCommit, `${path}.upstreamCommit`, { max: 80 });
  checkHash(out, value.patchDigest, `${path}.patchDigest`);
  checkInteger(out, value.dataSchema, `${path}.dataSchema`, 1);
  checkInteger(out, value.minimumReaderVersion, `${path}.minimumReaderVersion`, 1);
  return true;
};

const checkRuntimeManifest = (out: Violations, value: unknown, path: string): value is RuntimeManifest => {
  if (!checkObject(out, value, path,
    ['dshVersion', 'dshCommit', 'nodeVersion', 'nodePlatform', 'nodeArch', 'sqliteVersion', 'components'],
    ['dshVersion', 'dshCommit', 'nodeVersion', 'nodePlatform', 'nodeArch', 'sqliteVersion', 'components'])) return false;
  checkText(out, value.dshVersion, `${path}.dshVersion`, { max: 80 });
  checkText(out, value.dshCommit, `${path}.dshCommit`, { max: 80 });
  checkText(out, value.nodeVersion, `${path}.nodeVersion`, { max: 40 });
  checkText(out, value.nodePlatform, `${path}.nodePlatform`, { max: 20, pattern: PLATFORM });
  checkText(out, value.nodeArch, `${path}.nodeArch`, { max: 20, pattern: /^[a-z0-9]+$/ });
  checkText(out, value.sqliteVersion, `${path}.sqliteVersion`, { max: 40 });
  if (checkArray(out, value.components, `${path}.components`, 16)) {
    const seen = new Set<string>();
    for (const [index, item] of value.components.entries()) {
      if (!checkComponentVersion(out, item, `${path}.components[${index}]`)) continue;
      const id = (item as { componentId: string }).componentId;
      if (seen.has(id)) out.add('duplicate', `${path}.components[${index}].componentId`, 'duplicate component version');
      seen.add(id);
    }
    for (const required of ['dsh', 'shiyu-plugin', 'projection']) {
      if (!seen.has(required)) out.add('missing-component', `${path}.components`, `runtime manifest lacks ${required}`);
    }
  }
  return true;
};

const checkControlWatermarks = (out: Violations, value: unknown, path: string): boolean => {
  if (!checkObject(out, value, path,
    ['commitSeq', 'stateVersion', 'tombstoneWatermark', 'deletionBaselineId', 'authorizationEpoch'],
    ['commitSeq', 'stateVersion', 'tombstoneWatermark', 'deletionBaselineId', 'authorizationEpoch'])) return false;
  checkInteger(out, value.commitSeq, `${path}.commitSeq`, 0);
  checkInteger(out, value.stateVersion, `${path}.stateVersion`, 1);
  checkInteger(out, value.tombstoneWatermark, `${path}.tombstoneWatermark`, 0);
  checkText(out, value.deletionBaselineId, `${path}.deletionBaselineId`, { max: 120, pattern: SAFE_ID });
  checkInteger(out, value.authorizationEpoch, `${path}.authorizationEpoch`, 0);
  return true;
};

/* ------------------------------------------------------------------------------------------------
 * Component manifests
 * ---------------------------------------------------------------------------------------------- */

const checkGoalExclusions = (out: Violations, value: unknown, path: string): void => {
  if (!checkArray(out, value, path, 5000)) return;
  const goalIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!checkObject(out, item, itemPath, ['goalId', 'sessionId', 'reasonCode', 'detail'], ['goalId', 'sessionId', 'reasonCode', 'detail'])) continue;
    if (checkText(out, item.goalId, `${itemPath}.goalId`, { max: 200, pattern: SAFE_ID })) {
      if (goalIds.has(item.goalId)) out.add('duplicate', `${itemPath}.goalId`, 'duplicate goal exclusion');
      goalIds.add(item.goalId);
    }
    checkText(out, item.sessionId, `${itemPath}.sessionId`, { max: 200, pattern: SAFE_ID });
    checkText(out, item.reasonCode, `${itemPath}.reasonCode`, { max: 64, pattern: /^[A-Z][A-Z0-9_]{2,63}$/ });
    checkText(out, item.detail, `${itemPath}.detail`, { max: 300 });
  }
};

const checkWorkspaceInventory = (out: Violations, value: unknown, path: string): void => {
  if (!checkObject(out, value, path, ['rootId', 'files', 'totalBytes', 'aggregateSha256', 'truncated', 'excludedCount'],
    ['rootId', 'files', 'totalBytes', 'aggregateSha256', 'truncated', 'excludedCount'])) return;
  checkHash(out, value.rootId, `${path}.rootId`);
  checkInteger(out, value.totalBytes, `${path}.totalBytes`, 0);
  checkHash(out, value.aggregateSha256, `${path}.aggregateSha256`);
  checkBoolean(out, value.truncated, `${path}.truncated`);
  checkInteger(out, value.excludedCount, `${path}.excludedCount`, 0);
  if (checkArray(out, value.files, `${path}.files`, 5000)) {
    const paths = new Set<string>();
    let total = 0;
    for (const [index, item] of value.files.entries()) {
      const itemPath = `${path}.files[${index}]`;
      if (!checkObject(out, item, itemPath, ['relativePath', 'bytes', 'sha256'], ['relativePath', 'bytes', 'sha256'])) continue;
      if (checkText(out, item.relativePath, `${itemPath}.relativePath`, { max: 300 })) {
        if (item.relativePath.startsWith('/') || item.relativePath.split('/').some((segment: string) => !segment || segment === '.' || segment === '..')) {
          out.add('format', `${itemPath}.relativePath`, 'workspace inventory path must be a safe relative path');
        }
        if (paths.has(item.relativePath)) out.add('duplicate', `${itemPath}.relativePath`, 'duplicate workspace inventory path');
        paths.add(item.relativePath);
      }
      if (checkInteger(out, item.bytes, `${itemPath}.bytes`, 0)) total += item.bytes;
      checkHash(out, item.sha256, `${itemPath}.sha256`);
    }
    if (value.truncated === false && typeof value.totalBytes === 'number' && total !== value.totalBytes) {
      out.add('semantics', `${path}.totalBytes`, 'workspace inventory total does not match its file entries');
    }
  }
};

const CONTROL_KEYS = ['schemaVersion', 'componentId', 'databaseFile', 'databaseBytes', 'databaseSha256', 'integrity',
  'watermarks', 'goalBindings', 'inFlight', 'objectRefs', 'livePrecheck', 'capturedAt'] as const;
const CONTROL_REQUIRED = CONTROL_KEYS.filter((key) => key !== 'livePrecheck');

export const validateControlComponentManifest = (value: unknown, out = new Violations(50), path = '$'): ValidationResult => {
  if (checkObject(out, value, path, CONTROL_KEYS, CONTROL_REQUIRED)) {
    if (value.schemaVersion !== COMPONENT_MANIFEST_SCHEMA_VERSION) out.add('version', `${path}.schemaVersion`, 'unsupported component manifest schema');
    if (value.componentId !== 'control') out.add('value', `${path}.componentId`, 'expected control');
    checkText(out, value.databaseFile, `${path}.databaseFile`, { max: 300 });
    checkInteger(out, value.databaseBytes, `${path}.databaseBytes`, 1);
    checkHash(out, value.databaseSha256, `${path}.databaseSha256`);
    if (checkObject(out, value.integrity, `${path}.integrity`, ['quickCheck', 'foreignKeyCheck'], ['quickCheck', 'foreignKeyCheck'])) {
      if (value.integrity.quickCheck !== 'ok') out.add('integrity', `${path}.integrity.quickCheck`, 'quick_check must be ok');
      if (value.integrity.foreignKeyCheck !== 'ok') out.add('integrity', `${path}.integrity.foreignKeyCheck`, 'foreign_key_check must be ok');
    }
    checkControlWatermarks(out, value.watermarks, `${path}.watermarks`);
    if (checkArray(out, value.goalBindings, `${path}.goalBindings`, 5000)) {
      const goalIds = new Set<string>(); const sessionIds = new Set<string>();
      for (const [index, item] of value.goalBindings.entries()) {
        const itemPath = `${path}.goalBindings[${index}]`;
        if (!checkObject(out, item, itemPath,
          ['goalId', 'sessionId', 'goalRef', 'metadataVersion', 'ownerId', 'scope', 'cwdHash', 'completionCriteriaHash', 'commandStatus', 'commandOperation'],
          ['goalId', 'sessionId', 'goalRef', 'metadataVersion', 'ownerId', 'scope', 'cwdHash', 'completionCriteriaHash', 'commandStatus', 'commandOperation'])) continue;
        if (checkText(out, item.goalId, `${itemPath}.goalId`, { max: 200, pattern: SAFE_ID })) {
          if (goalIds.has(item.goalId)) out.add('duplicate', `${itemPath}.goalId`, 'duplicate goal binding');
          goalIds.add(item.goalId);
        }
        if (checkText(out, item.sessionId, `${itemPath}.sessionId`, { max: 200, pattern: SAFE_ID })) {
          if (sessionIds.has(item.sessionId)) out.add('duplicate', `${itemPath}.sessionId`, 'duplicate session binding');
          sessionIds.add(item.sessionId);
        }
        if (item.goalRef !== null) checkGoalRef(out, item.goalRef, `${itemPath}.goalRef`);
        checkInteger(out, item.metadataVersion, `${itemPath}.metadataVersion`, 1);
        checkText(out, item.ownerId, `${itemPath}.ownerId`, { max: 200 });
        checkText(out, item.scope, `${itemPath}.scope`, { max: 200 });
        checkHash(out, item.cwdHash, `${itemPath}.cwdHash`);
        checkHash(out, item.completionCriteriaHash, `${itemPath}.completionCriteriaHash`);
        checkEnum(out, item.commandStatus, `${itemPath}.commandStatus`, COMMAND_STATUSES);
        if (item.commandOperation !== null) checkText(out, item.commandOperation, `${itemPath}.commandOperation`, { max: 40 });
      }
    }
    if (checkArray(out, value.inFlight, `${path}.inFlight`, 20000)) {
      const seen = new Set<string>();
      for (const [index, item] of value.inFlight.entries()) {
        const itemPath = `${path}.inFlight[${index}]`;
        if (!checkObject(out, item, itemPath, ['kind', 'id', 'status', 'component'], ['kind', 'id', 'status', 'component'])) continue;
        checkEnum(out, item.kind, `${itemPath}.kind`, IN_FLIGHT_KINDS);
        checkText(out, item.status, `${itemPath}.status`, { max: 40, pattern: /^[a-z][a-z0-9-]{1,39}$/ });
        checkOneOf(out, item.component, `${itemPath}.component`, ['control', 'memory', 'device']);
        if (checkText(out, item.id, `${itemPath}.id`, { max: 200, pattern: SAFE_ID })) {
          const key = `${String(item.kind)}:${item.id}`;
          if (seen.has(key)) out.add('duplicate', `${itemPath}.id`, 'duplicate in-flight operation');
          seen.add(key);
        }
      }
    }
    checkStringArray(out, value.objectRefs, `${path}.objectRefs`, 5000, SAFE_ID);
    if (value.livePrecheck !== undefined) {
      if (checkObject(out, value.livePrecheck, `${path}.livePrecheck`, ['commitSeq', 'stateVersion', 'observedAt'], ['commitSeq', 'stateVersion', 'observedAt'])) {
        checkInteger(out, value.livePrecheck.commitSeq, `${path}.livePrecheck.commitSeq`, 0);
        checkInteger(out, value.livePrecheck.stateVersion, `${path}.livePrecheck.stateVersion`, 1);
        checkTime(out, value.livePrecheck.observedAt, `${path}.livePrecheck.observedAt`);
      }
    }
    checkTime(out, value.capturedAt, `${path}.capturedAt`);
  }
  return out.result();
};

const GOAL_SESSIONS_KEYS = ['schemaVersion', 'componentId', 'sessions', 'excludedBindings', 'versions', 'capturedAt'] as const;
const GOAL_SESSIONS_REQUIRED = GOAL_SESSIONS_KEYS.filter((key) => key !== 'excludedBindings');

export const validateGoalSessionsComponentManifest = (value: unknown, out = new Violations(50), path = '$'): ValidationResult => {
  if (checkObject(out, value, path, GOAL_SESSIONS_KEYS, GOAL_SESSIONS_REQUIRED)) {
    if (value.schemaVersion !== COMPONENT_MANIFEST_SCHEMA_VERSION) out.add('version', `${path}.schemaVersion`, 'unsupported component manifest schema');
    if (value.componentId !== 'dsh-goal-sessions') out.add('value', `${path}.componentId`, 'expected dsh-goal-sessions');
    if (checkArray(out, value.sessions, `${path}.sessions`, 5000)) {
      const goalIds = new Set<string>(); const sessionIds = new Set<string>();
      for (const [index, item] of value.sessions.entries()) {
        const itemPath = `${path}.sessions[${index}]`;
        if (!checkObject(out, item, itemPath,
          ['goalId', 'sessionId', 'goalRef', 'phase', 'activation', 'binding', 'logFile', 'logBytes', 'logSha256', 'logTail',
            'logFormat', 'projection', 'projectionDefinitionFile', 'projectionConfigFile', 'plugin', 'flush', 'capturedAt'],
          ['goalId', 'sessionId', 'goalRef', 'phase', 'activation', 'binding', 'logFile', 'logBytes', 'logSha256', 'logTail',
            'logFormat', 'projection', 'projectionDefinitionFile', 'projectionConfigFile', 'plugin', 'flush', 'capturedAt'])) continue;
        if (checkText(out, item.goalId, `${itemPath}.goalId`, { max: 200, pattern: SAFE_ID })) {
          if (goalIds.has(item.goalId)) out.add('duplicate', `${itemPath}.goalId`, 'duplicate goal session');
          goalIds.add(item.goalId);
        }
        if (checkText(out, item.sessionId, `${itemPath}.sessionId`, { max: 200, pattern: SAFE_ID })) {
          if (sessionIds.has(item.sessionId)) out.add('duplicate', `${itemPath}.sessionId`, 'duplicate session');
          sessionIds.add(item.sessionId);
        }
        checkGoalRef(out, item.goalRef, `${itemPath}.goalRef`);
        checkEnum(out, item.phase, `${itemPath}.phase`, GOAL_PHASES);
        checkEnum(out, item.activation, `${itemPath}.activation`, ACTIVATIONS);
        if (checkObject(out, item.binding, `${itemPath}.binding`,
          ['ownerId', 'scope', 'cwdHash', 'metadataVersion', 'completionCriteriaHash'],
          ['ownerId', 'scope', 'cwdHash', 'metadataVersion', 'completionCriteriaHash'])) {
          checkText(out, item.binding.ownerId, `${itemPath}.binding.ownerId`, { max: 200 });
          checkText(out, item.binding.scope, `${itemPath}.binding.scope`, { max: 200 });
          checkHash(out, item.binding.cwdHash, `${itemPath}.binding.cwdHash`);
          checkInteger(out, item.binding.metadataVersion, `${itemPath}.binding.metadataVersion`, 1);
          checkHash(out, item.binding.completionCriteriaHash, `${itemPath}.binding.completionCriteriaHash`);
        }
        checkText(out, item.logFile, `${itemPath}.logFile`, { max: 300 });
        checkInteger(out, item.logBytes, `${itemPath}.logBytes`, 1);
        checkHash(out, item.logSha256, `${itemPath}.logSha256`);
        checkLogTail(out, item.logTail, `${itemPath}.logTail`);
        checkEnum(out, item.logFormat, `${itemPath}.logFormat`, TAIL_KINDS);
        if (item.logFormat === 'jsonl-seq-v1' && item.logTail !== null && isPlainObject(item.logTail) && item.logTail.lastSequence === null) {
          out.add('semantics', `${itemPath}.logTail.lastSequence`, 'jsonl-seq-v1 log requires the actual sequence');
        }
        if (item.logTail !== null && isPlainObject(item.logTail) && item.logFormat !== item.logTail.kind) {
          out.add('semantics', `${itemPath}.logTail.kind`, 'tail kind must match the log format');
        }
        checkProjection(out, item.projection, `${itemPath}.projection`);
        checkText(out, item.projectionDefinitionFile, `${itemPath}.projectionDefinitionFile`, { max: 300 });
        checkText(out, item.projectionConfigFile, `${itemPath}.projectionConfigFile`, { max: 300 });
        if (checkObject(out, item.plugin, `${itemPath}.plugin`, ['dshVersion', 'shiyuVersion'], ['dshVersion', 'shiyuVersion'])) {
          checkText(out, item.plugin.dshVersion, `${itemPath}.plugin.dshVersion`, { max: 80 });
          checkText(out, item.plugin.shiyuVersion, `${itemPath}.plugin.shiyuVersion`, { max: 80 });
        }
        checkFlush(out, item.flush, `${itemPath}.flush`);
        checkTime(out, item.capturedAt, `${itemPath}.capturedAt`);
        if (isPlainObject(item.logTail) && isPlainObject(item.flush) && isPlainObject(item.flush.durableTail)) {
          if (item.logTail.sha256 !== item.flush.durableTail.sha256 || item.logTail.bytes !== item.flush.durableTail.bytes) {
            out.add('semantics', `${itemPath}.flush.durableTail`, 'durable tail must match the captured log bytes');
          }
        }
        if (isPlainObject(item.flush) && isPlainObject(item.projection) && isPlainObject(item.logTail)
          && item.logTail.bytes !== item.logBytes) out.add('semantics', `${itemPath}.logBytes`, 'log bytes must match the tail identity');
      }
    }
    if (value.excludedBindings !== undefined) checkGoalExclusions(out, value.excludedBindings, `${path}.excludedBindings`);
    if (checkArray(out, value.versions, `${path}.versions`, 16)) {
      for (const [index, item] of value.versions.entries()) checkComponentVersion(out, item, `${path}.versions[${index}]`);
    }
    checkTime(out, value.capturedAt, `${path}.capturedAt`);
  }
  return out.result();
};

const MEMORY_KEYS = ['schemaVersion', 'componentId', 'backend', 'componentVersion', 'watermark', 'archiveFile', 'archiveBytes',
  'archiveSha256', 'recordIndexFile', 'recordIndexBytes', 'recordIndexSha256', 'recordCount', 'objectRefs', 'capturedAt'] as const;

export const validateMemoryComponentManifest = (value: unknown, out = new Violations(50), path = '$'): ValidationResult => {
  if (checkObject(out, value, path, MEMORY_KEYS, MEMORY_KEYS)) {
    if (value.schemaVersion !== COMPONENT_MANIFEST_SCHEMA_VERSION) out.add('version', `${path}.schemaVersion`, 'unsupported component manifest schema');
    if (value.componentId !== 'memory') out.add('value', `${path}.componentId`, 'expected memory');
    if (checkObject(out, value.backend, `${path}.backend`, ['backendId', 'deploymentId'], ['backendId', 'deploymentId'])) {
      checkText(out, value.backend.backendId, `${path}.backend.backendId`, { max: 120, pattern: SAFE_ID });
      checkText(out, value.backend.deploymentId, `${path}.backend.deploymentId`, { max: 120, pattern: SAFE_ID });
    }
    checkText(out, value.componentVersion, `${path}.componentVersion`, { max: 120 });
    if (checkObject(out, value.watermark, `${path}.watermark`,
      ['tombstoneWatermark', 'baselineId'], ['tombstoneWatermark', 'baselineId'])) {
      checkInteger(out, value.watermark.tombstoneWatermark, `${path}.watermark.tombstoneWatermark`, 0);
      checkText(out, value.watermark.baselineId, `${path}.watermark.baselineId`, { max: 120, pattern: SAFE_ID });
    }
    checkText(out, value.archiveFile, `${path}.archiveFile`, { max: 300 });
    checkInteger(out, value.archiveBytes, `${path}.archiveBytes`, 1);
    checkHash(out, value.archiveSha256, `${path}.archiveSha256`);
    checkText(out, value.recordIndexFile, `${path}.recordIndexFile`, { max: 300 });
    checkInteger(out, value.recordIndexBytes, `${path}.recordIndexBytes`, 1);
    checkHash(out, value.recordIndexSha256, `${path}.recordIndexSha256`);
    checkInteger(out, value.recordCount, `${path}.recordCount`, 0);
    checkStringArray(out, value.objectRefs, `${path}.objectRefs`, 5000, SAFE_ID);
    checkTime(out, value.capturedAt, `${path}.capturedAt`);
  }
  return out.result();
};

const SHARED_KEYS = ['schemaVersion', 'componentId', 'objects', 'referencedBy', 'workspaceInventory', 'capturedAt'] as const;
const SHARED_REQUIRED = SHARED_KEYS.filter((key) => key !== 'workspaceInventory');

export const validateSharedObjectsComponentManifest = (value: unknown, out = new Violations(50), path = '$'): ValidationResult => {
  if (checkObject(out, value, path, SHARED_KEYS, SHARED_REQUIRED)) {
    if (value.schemaVersion !== COMPONENT_MANIFEST_SCHEMA_VERSION) out.add('version', `${path}.schemaVersion`, 'unsupported component manifest schema');
    if (value.componentId !== 'shared-objects') out.add('value', `${path}.componentId`, 'expected shared-objects');
    if (checkArray(out, value.objects, `${path}.objects`, 20000)) {
      const ids = new Set<string>();
      for (const [index, item] of value.objects.entries()) {
        const itemPath = `${path}.objects[${index}]`;
        if (!checkObject(out, item, itemPath, ['objectId', 'file', 'bytes', 'sha256'], ['objectId', 'file', 'bytes', 'sha256'])) continue;
        if (checkText(out, item.objectId, `${itemPath}.objectId`, { max: 200, pattern: SAFE_ID })) {
          if (ids.has(item.objectId)) out.add('duplicate', `${itemPath}.objectId`, 'duplicate object id');
          ids.add(item.objectId);
        }
        checkText(out, item.file, `${itemPath}.file`, { max: 300 });
        checkInteger(out, item.bytes, `${itemPath}.bytes`, 0);
        checkHash(out, item.sha256, `${itemPath}.sha256`);
      }
    }
    if (checkArray(out, value.referencedBy, `${path}.referencedBy`, 16)) {
      for (const [index, item] of value.referencedBy.entries()) {
        const itemPath = `${path}.referencedBy[${index}]`;
        if (!checkObject(out, item, itemPath, ['componentId', 'objectIds'], ['componentId', 'objectIds'])) continue;
        checkOneOf(out, item.componentId, `${itemPath}.componentId`, ['control', 'memory']);
        checkStringArray(out, item.objectIds, `${itemPath}.objectIds`, 20000, SAFE_ID);
      }
    }
    if (value.workspaceInventory !== undefined) checkWorkspaceInventory(out, value.workspaceInventory, `${path}.workspaceInventory`);
    checkTime(out, value.capturedAt, `${path}.capturedAt`);
  }
  return out.result();
};

/* ------------------------------------------------------------------------------------------------
 * Top-level bundle
 * ---------------------------------------------------------------------------------------------- */

const BUNDLE_KEYS = ['schemaVersion', 'bundleSchemaVersion', 'minimumReaderVersion', 'snapshotId', 'rootId', 'captureTime',
  'completedAt', 'status', 'reconcileRequired', 'generation', 'runtimeManifest', 'control', 'components', 'objectManifest',
  'durability', 'failure'] as const;

const COMPONENT_KEYS = ['componentId', 'status', 'upstreamCommit', 'patchDigest', 'dataSchema', 'minimumReaderVersion',
  'snapshotRef', 'manifestRef', 'manifestSha256', 'watermark', 'actualRevision', 'capturedAt', 'quiescenceEvidence', 'failureCodes'] as const;

const checkBundleComponent = (out: Violations, value: unknown, path: string, readerVersion: number): value is BundleComponent => {
  if (!checkObject(out, value, path, COMPONENT_KEYS, COMPONENT_KEYS)) return false;
  if (!checkEnum(out, value.componentId, `${path}.componentId`, COMPONENT_IDS)) return false;
  checkEnum(out, value.status, `${path}.status`, ['complete', 'failed']);
  checkText(out, value.upstreamCommit, `${path}.upstreamCommit`, { max: 80 });
  checkHash(out, value.patchDigest, `${path}.patchDigest`);
  if (checkInteger(out, value.dataSchema, `${path}.dataSchema`, 1)) {
    const supported = SUPPORTED_COMPONENT_DATA_SCHEMAS[value.componentId];
    if (value.dataSchema !== supported) out.add('incompatible', `${path}.dataSchema`, `component data schema ${String(value.dataSchema)} is not supported (reader knows ${String(supported)})`);
  }
  if (checkInteger(out, value.minimumReaderVersion, `${path}.minimumReaderVersion`, 1)) {
    if (value.minimumReaderVersion > readerVersion) out.add('incompatible', `${path}.minimumReaderVersion`, 'component requires a newer reader');
  }
  checkText(out, value.snapshotRef, `${path}.snapshotRef`, { max: 300 });
  checkText(out, value.manifestRef, `${path}.manifestRef`, { max: 300 });
  checkHash(out, value.manifestSha256, `${path}.manifestSha256`);
  if (value.watermark !== null) checkInteger(out, value.watermark, `${path}.watermark`, 0);
  if (value.actualRevision !== null) checkText(out, value.actualRevision, `${path}.actualRevision`, { max: 300 });
  if (value.watermark === null && value.actualRevision === null) out.add('missing-watermark', `${path}`, 'component exposes neither a watermark nor a verifiable revision');
  if (value.status === 'complete' && value.watermark === null && value.actualRevision === null) {
    out.add('missing-watermark', `${path}`, 'complete component requires an actual watermark or revision');
  }
  checkTime(out, value.capturedAt, `${path}.capturedAt`);
  checkText(out, value.quiescenceEvidence, `${path}.quiescenceEvidence`, { max: 300 });
  checkStringArray(out, value.failureCodes, `${path}.failureCodes`, 64, /^[A-Z][A-Z0-9_]{2,63}$/);
  return true;
};

/**
 * Data-level bundle validation. It cannot prove that files exist or that their
 * hashes match; `verifyBundleDirectory` does that from real bytes.
 */
export const validateBackupBundle = (value: unknown, options: ValidationOptions = {}): ValidationResult => {
  const out = new Violations(options.violationLimit ?? 100);
  const readerVersion = options.readerVersion ?? RECOVERY_READER_VERSION;
  const requireReady = options.requireReady ?? false;
  if (!checkObject(out, value, '$', BUNDLE_KEYS, BUNDLE_KEYS)) return out.result();
  const bundle = value;
  if (bundle.schemaVersion !== 1) out.add('version', '$.schemaVersion', 'unsupported bundle document schema');
  if (!checkInteger(out, bundle.bundleSchemaVersion, '$.bundleSchemaVersion', 1)) return out.result();
  if (bundle.bundleSchemaVersion !== BUNDLE_SCHEMA_VERSION) out.add('incompatible', '$.bundleSchemaVersion', 'unsupported bundle schema version');
  if (checkInteger(out, bundle.minimumReaderVersion, '$.minimumReaderVersion', 1)) {
    if (bundle.minimumReaderVersion > readerVersion) out.add('incompatible', '$.minimumReaderVersion', 'bundle requires a newer reader');
  }
  if (checkText(out, bundle.snapshotId, '$.snapshotId', { max: 128, pattern: SNAPSHOT_ID }) && options.expectedSnapshotId && bundle.snapshotId !== options.expectedSnapshotId) {
    out.add('snapshot-mismatch', '$.snapshotId', 'unexpected snapshot id');
  }
  if (checkHash(out, bundle.rootId, '$.rootId') && options.expectedRootId && bundle.rootId !== options.expectedRootId) {
    out.add('root-mismatch', '$.rootId', 'bundle belongs to a different data root');
  }
  const captureOk = checkTime(out, bundle.captureTime, '$.captureTime');
  const completedOk = checkTime(out, bundle.completedAt, '$.completedAt');
  if (captureOk && completedOk && (bundle.captureTime as string) > (bundle.completedAt as string)) {
    out.add('time-order', '$.captureTime', 'captureTime is after completedAt');
  }
  checkEnum(out, bundle.status, '$.status', ['creating', 'ready', 'failed', 'incomplete']);
  const statusOk = ['creating', 'ready', 'failed', 'incomplete'].includes(bundle.status as string);
  checkBoolean(out, bundle.reconcileRequired, '$.reconcileRequired');
  if (bundle.generation !== null) checkGenerationIdentity(out, bundle.generation, '$.generation');
  if (bundle.runtimeManifest !== null) checkRuntimeManifest(out, bundle.runtimeManifest, '$.runtimeManifest');
  if (bundle.control !== null) checkControlWatermarks(out, bundle.control, '$.control');
  if (bundle.objectManifest !== null) {
    if (checkObject(out, bundle.objectManifest, '$.objectManifest', ['ref', 'sha256', 'bytes', 'objectCount'], ['ref', 'sha256', 'bytes', 'objectCount'])) {
      checkText(out, bundle.objectManifest.ref, '$.objectManifest.ref', { max: 300 });
      checkHash(out, bundle.objectManifest.sha256, '$.objectManifest.sha256');
      checkInteger(out, bundle.objectManifest.bytes, '$.objectManifest.bytes', 1);
      checkInteger(out, bundle.objectManifest.objectCount, '$.objectManifest.objectCount', 0);
    }
  }
  if (checkObject(out, bundle.durability, '$.durability', ['crossComponentCommonSection', 'perComponent'],
    ['crossComponentCommonSection', 'perComponent'])) {
    if (bundle.durability.crossComponentCommonSection !== false) {
      out.add('false-common-section', '$.durability.crossComponentCommonSection', 'this module never proves a cross-component common section');
    }
    if (checkArray(out, bundle.durability.perComponent, '$.durability.perComponent', 16)) {
      const seen = new Set<string>();
      for (const [index, item] of bundle.durability.perComponent.entries()) {
        const itemPath = `$.durability.perComponent[${index}]`;
        if (!checkObject(out, item, itemPath, ['componentId', 'evidence'], ['componentId', 'evidence'])) continue;
        if (checkEnum(out, item.componentId, `${itemPath}.componentId`, COMPONENT_IDS)) {
          if (seen.has(item.componentId)) out.add('duplicate', `${itemPath}.componentId`, 'duplicate durability evidence');
          seen.add(item.componentId);
        }
        checkText(out, item.evidence, `${itemPath}.evidence`, { max: 300 });
      }
    }
  }
  if (bundle.failure !== null) {
    if (checkObject(out, bundle.failure, '$.failure', ['code', 'componentId', 'message'], ['code', 'componentId', 'message'])) {
      checkText(out, bundle.failure.code, '$.failure.code', { max: 64, pattern: /^[A-Z][A-Z0-9_]{2,63}$/ });
      if (bundle.failure.componentId !== null) checkOneOf(out, bundle.failure.componentId, '$.failure.componentId', COMPONENT_IDS);
      checkText(out, bundle.failure.message, '$.failure.message', { max: 300 });
    }
  }
  const componentList = checkArray(out, bundle.components, '$.components', 8) ? bundle.components as unknown[] : [];
  const ids = new Set<string>();
  for (const [index, item] of componentList.entries()) {
    if (!checkBundleComponent(out, item, `$.components[${index}]`, readerVersion)) continue;
    if (ids.has(item.componentId)) out.add('duplicate', `$.components[${index}].componentId`, 'duplicate component');
    ids.add(item.componentId);
  }
  if (!statusOk) return out.result();
  if (requireReady && bundle.status !== 'ready') out.add('bundle-not-ready', '$.status', `bundle status is ${String(bundle.status)}`);
  if (bundle.status === 'ready') {
    if (bundle.failure !== null) out.add('semantics', '$.failure', 'a ready bundle must not carry a failure record');
    if (bundle.generation === null) out.add('missing-field', '$.generation', 'a ready bundle requires the host generation it was captured under');
    if (bundle.runtimeManifest === null) out.add('missing-field', '$.runtimeManifest', 'a ready bundle requires a runtime manifest');
    if (bundle.control === null) out.add('missing-field', '$.control', 'a ready bundle requires control watermarks');
    if (bundle.objectManifest === null) out.add('missing-field', '$.objectManifest', 'a ready bundle requires an object manifest reference');
    if (bundle.control !== null && isPlainObject(bundle.objectManifest) && bundle.objectManifest.objectCount === undefined) {
      out.add('missing-field', '$.objectManifest.objectCount', 'object count is required');
    }
    if (bundle.reconcileRequired !== true) out.add('semantics', '$.reconcileRequired', 'ready bundles of this module remain reconcileRequired');
    for (const id of COMPONENT_IDS) if (!ids.has(id)) out.add('required-component-missing', '$.components', `required component ${id} is missing`);
    if (componentList.length !== COMPONENT_IDS.length) out.add('semantics', '$.components', 'ready bundle must contain exactly the required components');
    for (const [index, item] of componentList.entries()) {
      if (!isPlainObject(item)) continue;
      if (item.status !== 'complete') out.add('component-failed', `$.components[${index}].status`, 'ready bundle requires every required component to be complete');
      if (Array.isArray(item.failureCodes) && item.failureCodes.length) out.add('component-failed', `$.components[${index}].failureCodes`, 'complete component must not carry failure codes');
    }
    if (captureOk && componentList.length) {
      const times = componentList.map((item) => (isPlainObject(item) && typeof item.capturedAt === 'string' ? item.capturedAt : null));
      if (times.every((time): time is string => time !== null)) {
        const earliest = [...times].sort()[0]!;
        if (bundle.captureTime !== earliest) out.add('capture-time', '$.captureTime', 'captureTime must be the conservative earliest component capture time');
      }
    }
    const controlComponent = componentList.find((item) => isPlainObject(item) && item.componentId === 'control');
    if (isPlainObject(controlComponent) && isPlainObject(bundle.control)) {
      if (controlComponent.watermark !== bundle.control.commitSeq) out.add('watermark', '$.components[control].watermark', 'control component watermark must equal control.commitSeq');
    }
    if (isPlainObject(controlComponent) && controlComponent.quiescenceEvidence === '') out.add('semantics', '$.components[control].quiescenceEvidence', 'missing quiescence evidence');
    const durability = isPlainObject(bundle.durability) ? bundle.durability : null;
    const perComponent = durability && Array.isArray(durability.perComponent) ? durability.perComponent as unknown[] : null;
    for (const id of COMPONENT_IDS) {
      if (!perComponent) continue;
      if (!perComponent.some((item) => isPlainObject(item) && item.componentId === id)) {
        out.add('missing-durability', '$.durability.perComponent', `missing durability evidence for ${id}`);
      }
    }
  }
  if (bundle.status === 'failed' || bundle.status === 'incomplete') {
    if (bundle.failure === null) out.add('semantics', '$.failure', 'a failed/incomplete bundle must record its failure');
  }
  if (bundle.status === 'creating' && !requireReady) {
    // In-flight staging manifests are validated for shape only.
  }
  return out.result();
};

/* ------------------------------------------------------------------------------------------------
 * Staging / last-good / recovery state records
 * ---------------------------------------------------------------------------------------------- */

export const validateStagingJournal = (value: unknown): ValidationResult => {
  const out = new Violations(30);
  if (!checkObject(out, value, '$', ['schemaVersion', 'snapshotId', 'phase', 'startedAt', 'updatedAt', 'estimatedBytes', 'freeBytes', 'attempts', 'lastErrorCode'],
    ['schemaVersion', 'snapshotId', 'phase', 'startedAt', 'updatedAt', 'estimatedBytes', 'freeBytes', 'attempts', 'lastErrorCode'])) return out.result();
  if (value.schemaVersion !== STAGING_JOURNAL_SCHEMA_VERSION) out.add('version', '$.schemaVersion', 'unsupported journal schema');
  checkText(out, value.snapshotId, '$.snapshotId', { max: 128, pattern: SNAPSHOT_ID });
  checkEnum(out, value.phase, '$.phase', ['started', 'capacity-checked', 'control-snapshot', 'goal-sessions', 'memory-export',
    'shared-objects', 'manifest-built', 'publishing', 'published', 'interrupted']);
  checkTime(out, value.startedAt, '$.startedAt');
  checkTime(out, value.updatedAt, '$.updatedAt');
  checkInteger(out, value.estimatedBytes, '$.estimatedBytes', 0);
  if (value.freeBytes !== null) checkInteger(out, value.freeBytes, '$.freeBytes', 0);
  checkInteger(out, value.attempts, '$.attempts', 1, 1000);
  if (value.lastErrorCode !== null) checkText(out, value.lastErrorCode, '$.lastErrorCode', { max: 64, pattern: /^[A-Z][A-Z0-9_]{2,63}$/ });
  return out.result();
};

export const validateLastGoodPointer = (value: unknown): ValidationResult => {
  const out = new Violations(20);
  if (!checkObject(out, value, '$', ['schemaVersion', 'snapshotId', 'manifestSha256', 'captureTime', 'updatedAt'],
    ['schemaVersion', 'snapshotId', 'manifestSha256', 'captureTime', 'updatedAt'])) return out.result();
  if (value.schemaVersion !== 1) out.add('version', '$.schemaVersion', 'unsupported last-good schema');
  checkText(out, value.snapshotId, '$.snapshotId', { max: 128, pattern: SNAPSHOT_ID });
  checkHash(out, value.manifestSha256, '$.manifestSha256');
  checkTime(out, value.captureTime, '$.captureTime');
  checkTime(out, value.updatedAt, '$.updatedAt');
  return out.result();
};

export const validateRecoveryLockRecord = (value: unknown): ValidationResult => {
  const out = new Violations(30);
  if (!checkObject(out, value, '$', ['schemaVersion', 'lockId', 'snapshotId', 'targetRootHash', 'mode', 'phase', 'dispatch',
    'readView', 'acquiredAt', 'releasedAt', 'holder', 'hostProvenance', 'reasonCode'],
  ['schemaVersion', 'lockId', 'snapshotId', 'targetRootHash', 'mode', 'phase', 'dispatch', 'readView', 'acquiredAt', 'releasedAt', 'holder', 'hostProvenance', 'reasonCode'])) return out.result();
  if (value.schemaVersion !== RECOVERY_LOCK_SCHEMA_VERSION) out.add('version', '$.schemaVersion', 'unsupported recovery lock schema');
  checkText(out, value.lockId, '$.lockId', { max: 128, pattern: SAFE_ID });
  checkText(out, value.snapshotId, '$.snapshotId', { max: 128, pattern: SNAPSHOT_ID });
  checkHash(out, value.targetRootHash, '$.targetRootHash');
  if (value.mode !== 'maintenance') out.add('value', '$.mode', 'restores always start in maintenance');
  checkEnum(out, value.phase, '$.phase', ['restoring', 'verified', 'locked', 'failed']);
  if (value.dispatch !== 'blocked') out.add('value', '$.dispatch', 'recovery never enables dispatch');
  checkOneOf(out, value.readView, '$.readView', ['closed', 'read-only']);
  checkTime(out, value.acquiredAt, '$.acquiredAt');
  if (value.releasedAt !== null) checkTime(out, value.releasedAt, '$.releasedAt');
  if (value.holder !== 'recovery-module') out.add('value', '$.holder', 'unexpected lock holder');
  if (value.hostProvenance !== 'offline-module') out.add('value', '$.hostProvenance', 'offline module cannot claim host provenance');
  if (value.reasonCode !== null) checkText(out, value.reasonCode, '$.reasonCode', { max: 64, pattern: /^[A-Z][A-Z0-9_]{2,63}$/ });
  const phase = value.phase;
  const readView = value.readView;
  if (phase !== undefined && readView !== undefined && typeof phase === 'string' && typeof readView === 'string') {
    if (phase === 'verified' && readView === 'closed' && value.reasonCode === null) out.add('semantics', '$.readView', 'verified read-only restores must state why the read view is closed');
    if ((phase === 'locked' || phase === 'failed') && readView !== 'closed') out.add('semantics', '$.readView', 'locked/failed restores must keep the read view closed');
  }
  return out.result();
};

export const validateGenerationTransition = (value: unknown): ValidationResult => {
  const out = new Violations(25);
  if (!checkObject(out, value, '$', ['schemaVersion', 'installationGeneration', 'hostEpoch', 'previous', 'reason',
    'sourceSnapshotId', 'createdAt', 'verifiedByHost'],
  ['schemaVersion', 'installationGeneration', 'hostEpoch', 'previous', 'reason', 'sourceSnapshotId', 'createdAt', 'verifiedByHost'])) return out.result();
  if (value.schemaVersion !== GENERATION_RECORD_SCHEMA_VERSION) out.add('version', '$.schemaVersion', 'unsupported generation schema');
  checkText(out, value.installationGeneration, '$.installationGeneration', { max: 120, pattern: UUID_LIKE });
  checkText(out, value.hostEpoch, '$.hostEpoch', { max: 120, pattern: UUID_LIKE });
  if (value.previous !== null) checkGenerationIdentity(out, value.previous, '$.previous');
  checkEnum(out, value.reason, '$.reason', ['capture', 'restore', 'fresh-install', 'migration']);
  if (value.sourceSnapshotId !== null) checkText(out, value.sourceSnapshotId, '$.sourceSnapshotId', { max: 128, pattern: SNAPSHOT_ID });
  checkTime(out, value.createdAt, '$.createdAt');
  if (value.verifiedByHost !== false) out.add('value', '$.verifiedByHost', 'offline module must not claim host verification');
  if (isPlainObject(value.previous) && typeof value.installationGeneration === 'string' && typeof value.previous.installationGeneration === 'string') {
    if (value.installationGeneration === value.previous.installationGeneration) out.add('semantics', '$.installationGeneration', 'a restore must generate a new installation generation');
    if (value.hostEpoch === value.previous.hostEpoch) out.add('semantics', '$.hostEpoch', 'a restore must generate a new host epoch');
  }
  return out.result();
};

export const validateActivationRecord = (value: unknown): ValidationResult => {
  const out = new Violations(20);
  if (!checkObject(out, value, '$', ['schemaVersion', 'state', 'maintenance', 'dispatch', 'readView', 'reasonCode',
    'activeDataRootChanged', 'recordedAt'],
  ['schemaVersion', 'state', 'maintenance', 'dispatch', 'readView', 'reasonCode', 'activeDataRootChanged', 'recordedAt'])) return out.result();
  if (value.schemaVersion !== 1) out.add('version', '$.schemaVersion', 'unsupported activation schema');
  if (value.state !== 'not-activated') out.add('value', '$.state', 'recovery module never activates a root');
  if (value.maintenance !== true) out.add('value', '$.maintenance', 'restored roots stay in maintenance');
  if (value.dispatch !== 'blocked') out.add('value', '$.dispatch', 'restored roots never dispatch');
  checkOneOf(out, value.readView, '$.readView', ['closed', 'read-only']);
  checkText(out, value.reasonCode, '$.reasonCode', { max: 64, pattern: /^[A-Z][A-Z0-9_]{2,63}$/ });
  if (value.activeDataRootChanged !== false) out.add('value', '$.activeDataRootChanged', 'offline restore does not switch the active root');
  checkTime(out, value.recordedAt, '$.recordedAt');
  return out.result();
};

export const validateRecoveryBarrierEvidence = (value: unknown): ValidationResult => {
  const out = new Violations(30);
  if (!checkObject(out, value, '$', ['source', 'capturedAt', 'completeness', 'deletion', 'authorization', 'desiredState', 'unavailableReasons'],
    ['source', 'capturedAt', 'completeness', 'deletion', 'authorization', 'desiredState', 'unavailableReasons'])) return out.result();
  checkOneOf(out, value.source, '$.source', ['host-external-control-record', 'synthetic-test']);
  checkTime(out, value.capturedAt, '$.capturedAt');
  checkOneOf(out, value.completeness, '$.completeness', ['complete', 'partial', 'unavailable']);
  if (value.deletion !== null) {
    if (checkObject(out, value.deletion, '$.deletion', ['baselineId', 'tombstoneWatermark'], ['baselineId', 'tombstoneWatermark'])) {
      checkText(out, value.deletion.baselineId, '$.deletion.baselineId', { max: 120, pattern: SAFE_ID });
      checkInteger(out, value.deletion.tombstoneWatermark, '$.deletion.tombstoneWatermark', 0);
    }
  }
  if (value.authorization !== null) {
    if (checkObject(out, value.authorization, '$.authorization', ['authEpoch'], ['authEpoch'])) {
      checkInteger(out, value.authorization.authEpoch, '$.authorization.authEpoch', 0);
    }
  }
  if (value.desiredState !== null) {
    if (checkObject(out, value.desiredState, '$.desiredState', ['state', 'intentSeq'], ['state', 'intentSeq'])) {
      checkOneOf(out, value.desiredState.state, '$.desiredState.state', ['running', 'paused', 'stopped']);
      checkInteger(out, value.desiredState.intentSeq, '$.desiredState.intentSeq', 0);
    }
  }
  if (checkArray(out, value.unavailableReasons, '$.unavailableReasons', 16)) {
    for (const [index, item] of value.unavailableReasons.entries()) {
      checkText(out, item, `$.unavailableReasons[${index}]`, { max: 120, pattern: /^[a-z][a-z0-9_-]{1,79}$/ });
    }
  }
  if (value.completeness === 'complete' && (value.deletion === null || value.authorization === null || value.desiredState === null)) {
    out.add('semantics', '$.completeness', 'a complete barrier requires deletion, authorization and desired state');
  }
  return out.result();
};

export const validateDeletionLedger = (value: unknown): ValidationResult => {
  const out = new Violations(40);
  if (!checkObject(out, value, '$', ['schemaVersion', 'baselineId', 'fromWatermark', 'toWatermark', 'entries', 'ledgerSha256'],
    ['schemaVersion', 'baselineId', 'fromWatermark', 'toWatermark', 'entries', 'ledgerSha256'])) return out.result();
  if (value.schemaVersion !== DELETION_LEDGER_SCHEMA_VERSION) out.add('version', '$.schemaVersion', 'unsupported deletion ledger schema');
  checkText(out, value.baselineId, '$.baselineId', { max: 120, pattern: SAFE_ID });
  checkInteger(out, value.fromWatermark, '$.fromWatermark', 0);
  checkInteger(out, value.toWatermark, '$.toWatermark', 0);
  checkHash(out, value.ledgerSha256, '$.ledgerSha256');
  if (checkArray(out, value.entries, '$.entries', 10000)) {
    let previous = typeof value.fromWatermark === 'number' ? value.fromWatermark : -1;
    for (const [index, item] of value.entries.entries()) {
      const itemPath = `$.entries[${index}]`;
      if (!checkObject(out, item, itemPath, ['watermark', 'refs', 'reasonCode', 'recordedAt'], ['watermark', 'refs', 'reasonCode', 'recordedAt'])) continue;
      if (checkInteger(out, item.watermark, `${itemPath}.watermark`, 1) && previous >= 0 && item.watermark !== previous + 1) {
        out.add('ledger-gap', `${itemPath}.watermark`, 'deletion ledger must be contiguous from fromWatermark');
      }
      if (typeof item.watermark === 'number') previous = item.watermark;
      const refsOk = checkStringArray(out, item.refs, `${itemPath}.refs`, 1000, SAFE_ID);
      if (Array.isArray(item.refs) && item.refs.length === 0) out.add('ledger-empty-entry', `${itemPath}.refs`, 'a deletion watermark entry must carry at least one ref');
      checkText(out, item.reasonCode, `${itemPath}.reasonCode`, { max: 64, pattern: /^[A-Z][A-Z0-9_]{2,63}$/ });
      checkTime(out, item.recordedAt, `${itemPath}.recordedAt`);
      if (!refsOk) continue;
    }
    if (typeof value.toWatermark === 'number' && previous >= 0 && value.entries.length && previous !== value.toWatermark) {
      out.add('ledger-gap', '$.toWatermark', 'last ledger entry must reach toWatermark');
    }
    if (typeof value.fromWatermark === 'number' && typeof value.toWatermark === 'number' && value.fromWatermark < value.toWatermark
      && value.entries.length !== value.toWatermark - value.fromWatermark) {
      out.add('ledger-gap', '$.entries', 'ledger entry count must bridge the watermark range');
    }
  }
  return out.result();
};

export const validateRestoreReport = (value: unknown): ValidationResult => {
  const out = new Violations(80);
  const keys = ['schemaVersion', 'reportId', 'snapshotId', 'bundleManifestSha256', 'mode', 'dispatch', 'activate', 'status',
    'readView', 'reconcileRequired', 'targetRootHash', 'startedAt', 'endedAt', 'checks', 'components', 'barrier', 'deletion',
    'goals', 'goalExclusions', 'unknown', 'generation', 'activation', 'oldRoot', 'liveActivation', 'failures'] as const;
  const requiredKeys = keys.filter((key) => key !== 'goalExclusions');
  if (!checkObject(out, value, '$', keys, requiredKeys)) return out.result();
  if (value.schemaVersion !== RESTORE_REPORT_SCHEMA_VERSION) out.add('version', '$.schemaVersion', 'unsupported restore report schema');
  checkText(out, value.reportId, '$.reportId', { max: 128, pattern: SAFE_ID });
  checkText(out, value.snapshotId, '$.snapshotId', { max: 128, pattern: SNAPSHOT_ID });
  checkHash(out, value.bundleManifestSha256, '$.bundleManifestSha256');
  if (value.mode !== 'maintenance') out.add('value', '$.mode', 'restores are maintenance-only');
  if (value.dispatch !== 'blocked') out.add('value', '$.dispatch', 'restore never enables dispatch');
  if (value.activate !== 'not-activated') out.add('value', '$.activate', 'restore module never activates a root');
  checkEnum(out, value.status, '$.status', ['verified', 'locked', 'failed']);
  checkOneOf(out, value.readView, '$.readView', ['closed', 'read-only']);
  checkBoolean(out, value.reconcileRequired, '$.reconcileRequired');
  checkHash(out, value.targetRootHash, '$.targetRootHash');
  checkTime(out, value.startedAt, '$.startedAt');
  checkTime(out, value.endedAt, '$.endedAt');
  if (checkArray(out, value.checks, '$.checks', 200)) {
    for (const [index, item] of value.checks.entries()) {
      const itemPath = `$.checks[${index}]`;
      if (!checkObject(out, item, itemPath, ['checkId', 'status', 'componentId'], ['checkId', 'status', 'componentId'])) continue;
      checkText(out, item.checkId, `${itemPath}.checkId`, { max: 120, pattern: /^[a-z][a-z0-9.-]{1,119}$/ });
      checkOneOf(out, item.status, `${itemPath}.status`, ['pass', 'fail', 'unknown']);
      if (item.componentId !== null) checkOneOf(out, item.componentId, `${itemPath}.componentId`, COMPONENT_IDS);
    }
  }
  if (checkArray(out, value.components, '$.components', 8)) {
    for (const [index, item] of value.components.entries()) {
      const itemPath = `$.components[${index}]`;
      if (!checkObject(out, item, itemPath, ['componentId', 'manifestValid', 'hashVerified', 'integrity'],
        ['componentId', 'manifestValid', 'hashVerified', 'integrity'])) continue;
      checkOneOf(out, item.componentId, `${itemPath}.componentId`, COMPONENT_IDS);
      checkBoolean(out, item.manifestValid, `${itemPath}.manifestValid`);
      checkBoolean(out, item.hashVerified, `${itemPath}.hashVerified`);
      checkOneOf(out, item.integrity, `${itemPath}.integrity`, ['ok', 'failed', 'not-checked']);
    }
  }
  if (checkObject(out, value.barrier, '$.barrier', ['completeness', 'deletion', 'authorization', 'desiredState'],
    ['completeness', 'deletion', 'authorization', 'desiredState'])) {
    checkOneOf(out, value.barrier.completeness, '$.barrier.completeness', ['complete', 'partial', 'unavailable']);
    if (checkObject(out, value.barrier.deletion, '$.barrier.deletion', ['baselineId', 'bundleWatermark', 'latestWatermark', 'relation'],
      ['baselineId', 'bundleWatermark', 'latestWatermark', 'relation'])) {
      checkText(out, value.barrier.deletion.baselineId, '$.barrier.deletion.baselineId', { max: 120, pattern: SAFE_ID });
      checkInteger(out, value.barrier.deletion.bundleWatermark, '$.barrier.deletion.bundleWatermark', 0);
      if (value.barrier.deletion.latestWatermark !== null) checkInteger(out, value.barrier.deletion.latestWatermark, '$.barrier.deletion.latestWatermark', 0);
      checkOneOf(out, value.barrier.deletion.relation, '$.barrier.deletion.relation', ['equal', 'advanced-replayed', 'advanced-unreplayed', 'unavailable', 'stale', 'baseline-mismatch']);
    }
    if (checkObject(out, value.barrier.authorization, '$.barrier.authorization', ['bundleEpoch', 'latestEpoch', 'relation'],
      ['bundleEpoch', 'latestEpoch', 'relation'])) {
      checkInteger(out, value.barrier.authorization.bundleEpoch, '$.barrier.authorization.bundleEpoch', 0);
      if (value.barrier.authorization.latestEpoch !== null) checkInteger(out, value.barrier.authorization.latestEpoch, '$.barrier.authorization.latestEpoch', 0);
      checkOneOf(out, value.barrier.authorization.relation, '$.barrier.authorization.relation', ['current', 'advanced', 'stale', 'unavailable']);
    }
    checkOneOf(out, value.barrier.desiredState, '$.barrier.desiredState', ['running', 'paused', 'stopped', 'unavailable']);
  }
  if (checkObject(out, value.deletion, '$.deletion', ['ledgerApplied', 'appliedEntries', 'removedRefs', 'visibleRefs', 'resurrectionDetected'],
    ['ledgerApplied', 'appliedEntries', 'removedRefs', 'visibleRefs', 'resurrectionDetected'])) {
    checkBoolean(out, value.deletion.ledgerApplied, '$.deletion.ledgerApplied');
    checkInteger(out, value.deletion.appliedEntries, '$.deletion.appliedEntries', 0);
    checkInteger(out, value.deletion.removedRefs, '$.deletion.removedRefs', 0);
    checkInteger(out, value.deletion.visibleRefs, '$.deletion.visibleRefs', 0);
    if (typeof value.deletion.resurrectionDetected !== 'boolean') out.add('type', '$.deletion.resurrectionDetected', 'expected a boolean');
  }
  if (checkArray(out, value.goals, '$.goals', 5000)) {
    for (const [index, item] of value.goals.entries()) {
      const itemPath = `$.goals[${index}]`;
      if (!checkObject(out, item, itemPath, ['goalId', 'sessionId', 'logHashVerified', 'tailVerified', 'restoredActivation', 'effectiveActivation', 'dispatch'],
        ['goalId', 'sessionId', 'logHashVerified', 'tailVerified', 'restoredActivation', 'effectiveActivation', 'dispatch'])) continue;
      checkText(out, item.goalId, `${itemPath}.goalId`, { max: 200, pattern: SAFE_ID });
      checkText(out, item.sessionId, `${itemPath}.sessionId`, { max: 200, pattern: SAFE_ID });
      checkBoolean(out, item.logHashVerified, `${itemPath}.logHashVerified`);
      checkBoolean(out, item.tailVerified, `${itemPath}.tailVerified`);
      checkOneOf(out, item.restoredActivation, `${itemPath}.restoredActivation`, ACTIVATIONS);
      if (item.effectiveActivation !== 'disarmed') out.add('semantics', `${itemPath}.effectiveActivation`, 'restored goals must remain disarmed');
      if (item.dispatch !== 'blocked') out.add('semantics', `${itemPath}.dispatch`, 'restored goals must not dispatch');
    }
  }
  if (value.goalExclusions !== undefined) checkGoalExclusions(out, value.goalExclusions, '$.goalExclusions');
  if (checkObject(out, value.unknown, '$.unknown', ['preserved', 'replayed'], ['preserved', 'replayed'])) {
    checkArray(out, value.unknown.preserved, '$.unknown.preserved', 20000);
    if (value.unknown.replayed !== 0) out.add('semantics', '$.unknown.replayed', 'unknown operations must never be replayed');
  }
  const generation = validateGenerationTransition(value.generation);
  if (!generation.ok) out.add('generation', '$.generation', 'invalid generation transition');
  const activation = validateActivationRecord(value.activation);
  if (!activation.ok) out.add('activation', '$.activation', 'invalid activation record');
  if (value.oldRoot !== 'untouched') out.add('value', '$.oldRoot', 'restore must not touch the old root');
  if (value.liveActivation !== 'not-changed') out.add('value', '$.liveActivation', 'restore must not change live activation');
  if (checkArray(out, value.failures, '$.failures', 200)) {
    for (const [index, item] of value.failures.entries()) {
      const itemPath = `$.failures[${index}]`;
      if (!checkObject(out, item, itemPath, ['code', 'componentId'], ['code', 'componentId'])) continue;
      checkText(out, item.code, `${itemPath}.code`, { max: 64, pattern: /^[A-Z][A-Z0-9_]{2,63}$/ });
      if (item.componentId !== null) checkOneOf(out, item.componentId, `${itemPath}.componentId`, COMPONENT_IDS);
    }
  }
  const status = value.status;
  if (status === 'verified') {
    if (value.readView !== 'read-only') out.add('semantics', '$.readView', 'verified restores open a read-only view');
    if (isPlainObject(value.deletion) && value.deletion.resurrectionDetected !== false) {
      out.add('semantics', '$.deletion.resurrectionDetected', 'a verified report can never accept resurrection');
    }
    if (Array.isArray(value.failures) && value.failures.length) out.add('semantics', '$.failures', 'verified restore must not carry failures');
    if (Array.isArray(value.checks) && value.checks.some((item) => isPlainObject(item) && item.status !== 'pass')) {
      out.add('semantics', '$.checks', 'verified restore requires every check to pass');
    }
  } else if (value.readView !== 'closed') {
    out.add('semantics', '$.readView', 'locked/failed restores keep the read view closed');
  }
  return out.result();
};

/* ------------------------------------------------------------------------------------------------
 * Small wrappers used by capture for host-provided runtime facts.
 * ---------------------------------------------------------------------------------------------- */

export const validateGenerationIdentityValue = (value: unknown): ValidationResult => {
  const out = new Violations(10);
  checkGenerationIdentity(out, value, '$');
  return out.result();
};

export const validateRuntimeManifestValue = (value: unknown): ValidationResult => {
  const out = new Violations(30);
  checkRuntimeManifest(out, value, '$');
  return out.result();
};

/* ------------------------------------------------------------------------------------------------
 * Assertion helpers used internally before publishing durable records.
 * ---------------------------------------------------------------------------------------------- */

export const assertValid = (result: ValidationResult, label: string): void => {
  if (result.ok) return;
  const first = result.violations[0];
  throw new RecoveryError(first?.code === 'incompatible' ? 'INCOMPATIBLE_VERSION' : 'INVALID_SCHEMA',
    `${label} failed schema validation at ${first?.path ?? '$'}: ${first?.message ?? 'unknown violation'}`);
};

export const assertValidBundle = (value: unknown, options: ValidationOptions = {}): BackupBundle => {
  const result = validateBackupBundle(value, options);
  if (!result.ok) {
    const first = result.violations[0];
    throw new RecoveryError(first?.code === 'incompatible' ? 'INCOMPATIBLE_VERSION' : first?.code === 'root-mismatch' ? 'ROOT_MISMATCH'
      : first?.code === 'bundle-not-ready' ? 'BUNDLE_NOT_READY' : 'INVALID_SCHEMA',
    `BackupBundle failed validation at ${first?.path ?? '$'}: ${first?.message ?? 'unknown violation'}`);
  }
  return value as BackupBundle;
};

export const assertValidRecoveryLock = (value: unknown): RecoveryLockRecord => {
  assertValid(validateRecoveryLockRecord(value), 'Recovery lock');
  return value as RecoveryLockRecord;
};

export const assertValidGeneration = (value: unknown): GenerationTransition => {
  assertValid(validateGenerationTransition(value), 'Generation transition');
  return value as GenerationTransition;
};

export const assertValidActivation = (value: unknown): RecoveryActivationRecord => {
  assertValid(validateActivationRecord(value), 'Activation record');
  return value as RecoveryActivationRecord;
};

export const assertValidBarrier = (value: unknown): RecoveryBarrierEvidence => {
  assertValid(validateRecoveryBarrierEvidence(value), 'Recovery barrier');
  return value as RecoveryBarrierEvidence;
};

export const assertValidDeletionLedger = (value: unknown): DeletionLedger => {
  assertValid(validateDeletionLedger(value), 'Deletion ledger');
  return value as DeletionLedger;
};

export const assertValidRestoreReport = (value: unknown): RestoreReport => {
  assertValid(validateRestoreReport(value), 'Restore report');
  return value as RestoreReport;
};

export const assertValidStagingJournal = (value: unknown): StagingJournal => {
  assertValid(validateStagingJournal(value), 'Staging journal');
  return value as StagingJournal;
};

export const assertValidLastGood = (value: unknown): LastGoodPointer => {
  assertValid(validateLastGoodPointer(value), 'Last-good pointer');
  return value as LastGoodPointer;
};

export const assertValidGenerationIdentity = (value: unknown): { installationGeneration: string; hostEpoch: string } => {
  assertValid(validateGenerationIdentityValue(value), 'Generation identity');
  return value as { installationGeneration: string; hostEpoch: string };
};

export const assertValidRuntimeManifest = (value: unknown): RuntimeManifest => {
  assertValid(validateRuntimeManifestValue(value), 'Runtime manifest');
  return value as RuntimeManifest;
};
