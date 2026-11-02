/**
 * Read control-domain facts from a *completed* control snapshot.
 *
 * Capture never reads watermarks from the live database before or while the
 * online backup runs; after `sqlite.backup` finishes, this reader opens the
 * staged copy read-only and publishes what that copy actually contains.
 *
 * Only tables that exist in the current control store are read. Required
 * watermarks (commit sequence, published state version, authorization epoch,
 * deletion watermark) fail closed when absent or malformed: a Bundle missing
 * any of them can never be ready.
 */
import { DatabaseSync } from 'node:sqlite';
import { RecoveryError } from './errors.js';
import { sha256 } from './files.js';
import type {
  ControlGoalBindingRecord,
  ControlWatermarks,
  GoalRef,
  InFlightRecord,
} from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function fail(code: ConstructorParameters<typeof RecoveryError>[0], message: string): never {
  throw new RecoveryError(code, `Control snapshot: ${message}`);
}

const asSafeInteger = (value: unknown, label: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return fail('MISSING_WATERMARK', `invalid ${label}`);
};

const asCanonicalTime = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length > 40) return fail('INVALID_SCHEMA', `invalid ${label}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return fail('INVALID_SCHEMA', `non-canonical ${label}`);
  return value;
};

const asHash = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !HASH.test(value)) return fail('INVALID_SCHEMA', `invalid ${label}`);
  return value;
};

const asIdentity = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) return fail('INVALID_SCHEMA', `invalid ${label}`);
  return value;
};

const parseJson = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'string') return fail('INVALID_SCHEMA', `missing JSON column ${label}`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return fail('INVALID_SCHEMA', `invalid JSON in ${label}`); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('INVALID_SCHEMA', `non-object JSON in ${label}`);
  return parsed as Record<string, unknown>;
};

const tableExists = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;

const row = (db: DatabaseSync, sql: string): Record<string, unknown> | undefined =>
  db.prepare(sql).get() as Record<string, unknown> | undefined;

export interface ControlFacts {
  watermarks: ControlWatermarks;
  goalBindings: ControlGoalBindingRecord[];
  inFlight: InFlightRecord[];
  tablesPresent: string[];
}

interface GoalBindingValue {
  goalId?: unknown;
  sessionId?: unknown;
  ownerId?: unknown;
  scope?: unknown;
  cwd?: unknown;
  completionCriteriaHash?: unknown;
  metadataVersion?: unknown;
  goalRef?: unknown;
  receipt?: unknown;
}

const readGoalRef = (value: unknown, label: string): GoalRef | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_SCHEMA', `invalid ${label}`);
  const record = value as Record<string, unknown>;
  const id = asIdentity(record.id, `${label}.id`);
  const revision = asSafeInteger(record.revision, `${label}.revision`);
  if (revision < 1) return fail('INVALID_SCHEMA', `invalid ${label}.revision`);
  return { id, revision };
};

const readBindings = (db: DatabaseSync): ControlGoalBindingRecord[] => {
  if (!tableExists(db, 'shiyu_goal_bindings')) return [];
  const rows = db.prepare('SELECT goal_id, session_id, metadata_version, value FROM shiyu_goal_bindings ORDER BY goal_id').all() as unknown as Record<string, unknown>[];
  if (rows.length > 5000) fail('INVALID_SCHEMA', 'goal binding count exceeds the bounded capture limit');
  const result: ControlGoalBindingRecord[] = [];
  for (const item of rows) {
    const value = parseJson(item.value, 'goal binding value') as GoalBindingValue;
    const goalId = asIdentity(item.goal_id, 'goal binding goal_id');
    const sessionId = asIdentity(item.session_id, 'goal binding session_id');
    if (value.goalId !== goalId || value.sessionId !== sessionId) fail('INVALID_SCHEMA', `goal binding identity mismatch for ${goalId}`);
    const ownerId = asIdentity(value.ownerId, `goal binding ${goalId}.ownerId`);
    const scope = asIdentity(value.scope, `goal binding ${goalId}.scope`);
    const cwd = value.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 1000) fail('INVALID_SCHEMA', `goal binding ${goalId}.cwd`);
    const metadataVersion = asSafeInteger(item.metadata_version, `goal binding ${goalId}.metadata_version`);
    if (metadataVersion < 1 || value.metadataVersion !== metadataVersion) fail('INVALID_SCHEMA', `goal binding ${goalId}.metadataVersion`);
    const completionCriteriaHash = asHash(value.completionCriteriaHash, `goal binding ${goalId}.completionCriteriaHash`);
    const goalRef = readGoalRef(value.goalRef, `goal binding ${goalId}.goalRef`);
    let commandStatus: ControlGoalBindingRecord['commandStatus'] = 'none';
    let commandOperation: string | null = null;
    if (value.receipt !== undefined && value.receipt !== null) {
      if (typeof value.receipt !== 'object' || Array.isArray(value.receipt)) fail('INVALID_SCHEMA', `goal binding ${goalId}.receipt`);
      const receipt = value.receipt as Record<string, unknown>;
      const status = receipt.status;
      if (status === 'pending' || status === 'unknown' || status === 'confirmed' || status === 'rejected') {
        commandStatus = status;
      } else {
        fail('INVALID_SCHEMA', `goal binding ${goalId}.receipt.status`);
      }
      if (typeof receipt.operation === 'string' && SAFE_ID.test(receipt.operation)) commandOperation = receipt.operation;
    }
    result.push({
      goalId, sessionId, goalRef, metadataVersion, ownerId, scope,
      cwdHash: sha256(cwd), completionCriteriaHash, commandStatus, commandOperation,
    });
  }
  return result;
};

const readInFlight = (db: DatabaseSync): InFlightRecord[] => {
  const result: InFlightRecord[] = [];
  if (tableExists(db, 'shiyu_goal_commands')) {
    const rows = db.prepare('SELECT goal_id, command_id, value FROM shiyu_goal_commands ORDER BY goal_id, command_id').all() as unknown as Record<string, unknown>[];
    for (const item of rows) {
      const value = parseJson(item.value, 'goal command value');
      const status = value.status;
      if (status !== 'pending' && status !== 'unknown') continue;
      result.push({
        kind: 'goal-command',
        id: asIdentity(item.command_id, 'goal command id'),
        status,
        component: 'control',
      });
    }
  }
  if (tableExists(db, 'shiyu_effects')) {
    const rows = db.prepare("SELECT effect_id, status FROM shiyu_effects WHERE status IN ('pending','dispatching','unknown') ORDER BY effect_id").all() as unknown as Record<string, unknown>[];
    for (const item of rows) {
      result.push({
        kind: 'effect',
        id: asIdentity(item.effect_id, 'effect id'),
        status: asIdentity(item.status, 'effect status'),
        component: 'control',
      });
    }
  }
  if (tableExists(db, 'shiyu_budget_reservations')) {
    const rows = db.prepare('SELECT id, record_json FROM shiyu_budget_reservations ORDER BY id').all() as unknown as Record<string, unknown>[];
    for (const item of rows) {
      const value = parseJson(item.record_json, 'budget reservation record');
      if (value.state !== 'unknown') continue;
      result.push({
        kind: 'budget-reservation',
        id: asIdentity(item.id, 'reservation id'),
        status: 'unknown',
        component: 'control',
      });
    }
  }
  if (tableExists(db, 'shiyu_memory_operations')) {
    const rows = db.prepare('SELECT operation_id, record_json FROM shiyu_memory_operations ORDER BY operation_id').all() as unknown as Record<string, unknown>[];
    for (const item of rows) {
      const value = parseJson(item.record_json, 'memory operation record');
      const effectState = value.effectState;
      const status = value.status;
      const final = effectState === 'succeeded' || effectState === 'failed' || status === 'published' || status === 'rejected' || status === 'failed';
      if (final) continue;
      if (effectState === 'pending' || effectState === 'dispatching' || effectState === 'unknown') {
        result.push({
          kind: 'memory-operation',
          id: asIdentity(item.operation_id, 'memory operation id'),
          status: typeof effectState === 'string' ? effectState : 'unknown',
          component: 'memory',
        });
      }
    }
  }
  return result;
};

/**
 * Read the required control watermarks from a completed snapshot.
 * Missing required authority rows are MISSING_WATERMARK, never zero.
 */
export const readControlFacts = (filename: string): ControlFacts => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as unknown as { name: string }[]).map((item) => item.name);
    if (!tableExists(db, 'shiyu_commit_watermark')) fail('MISSING_WATERMARK', 'commit watermark table is missing');
    const watermark = row(db, 'SELECT version, commit_seq, baseline_id, started_at, schema_hash FROM shiyu_commit_watermark WHERE id=1');
    if (!watermark) fail('MISSING_WATERMARK', 'commit watermark row is missing (historical progress cannot be reconstructed)');
    if (watermark.version !== 1) fail('INCOMPATIBLE_VERSION', 'unsupported commit watermark version');
    const commitSeq = asSafeInteger(watermark.commit_seq, 'commit_seq');
    const baselineId = watermark.baseline_id;
    if (typeof baselineId !== 'string' || !UUID.test(baselineId)) fail('INVALID_SCHEMA', 'invalid commit baseline_id');
    asCanonicalTime(watermark.started_at, 'commit started_at');
    asHash(watermark.schema_hash, 'commit schema_hash');

    if (!tableExists(db, 'shiyu_state_publication_head')) fail('MISSING_WATERMARK', 'state publication head table is missing');
    const publication = row(db, 'SELECT state_version, record_json FROM shiyu_state_publication_head WHERE id=1');
    if (!publication) fail('MISSING_WATERMARK', 'published state version is missing');
    const stateVersion = asSafeInteger(publication.state_version, 'state_version');
    if (stateVersion < 1) fail('MISSING_WATERMARK', 'invalid state_version');
    const publicationRecord = parseJson(publication.record_json, 'state publication record');
    asHash(publicationRecord.manifestHash, 'published manifestHash');
    asCanonicalTime(publicationRecord.publishedAt, 'state publishedAt');

    if (!tableExists(db, 'shiyu_policy_meta')) fail('MISSING_WATERMARK', 'authorization epoch table is missing');
    const policy = row(db, 'SELECT auth_epoch, frozen FROM shiyu_policy_meta WHERE id=1');
    if (!policy) fail('MISSING_WATERMARK', 'authorization epoch row is missing');
    const authorizationEpoch = asSafeInteger(policy.auth_epoch, 'auth_epoch');
    if (policy.frozen !== 0 && policy.frozen !== 1) fail('INVALID_SCHEMA', 'invalid policy frozen flag');

    if (!tableExists(db, 'shiyu_memory_meta')) fail('MISSING_WATERMARK', 'deletion watermark table is missing');
    const deletion = row(db, 'SELECT tombstone_watermark, baseline_id FROM shiyu_memory_meta WHERE id=1');
    if (!deletion) fail('MISSING_WATERMARK', 'deletion watermark row is missing');
    const tombstoneWatermark = asSafeInteger(deletion.tombstone_watermark, 'tombstone_watermark');
    const deletionBaselineId = deletion.baseline_id;
    if (typeof deletionBaselineId !== 'string' || !SAFE_ID.test(deletionBaselineId)) fail('INVALID_SCHEMA', 'invalid deletion baseline_id');

    return {
      watermarks: { commitSeq, stateVersion, tombstoneWatermark, deletionBaselineId, authorizationEpoch },
      goalBindings: readBindings(db),
      inFlight: readInFlight(db),
      tablesPresent: tables,
    };
  } finally {
    db.close();
  }
};

export interface ControlTombstone {
  scope: string;
  ref: string;
  watermark: number;
}

/**
 * Read the deletion barrier rows carried by the restored control snapshot.
 * Missing table means the internal deletion propagation cannot be proven.
 */
export const readControlTombstones = (filename: string): ControlTombstone[] | null => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (!tableExists(db, 'shiyu_memory_tombstones')) return null;
    const rows = db.prepare('SELECT scope, ref, watermark FROM shiyu_memory_tombstones ORDER BY watermark, scope, ref').all() as unknown as Record<string, unknown>[];
    const result: ControlTombstone[] = [];
    for (const item of rows) {
      const scope = asIdentity(item.scope, 'tombstone scope');
      const ref = asIdentity(item.ref, 'tombstone ref');
      const watermark = asSafeInteger(item.watermark, 'tombstone watermark');
      result.push({ scope, ref, watermark });
    }
    return result;
  } finally {
    db.close();
  }
};

/** Compare a restored control snapshot against the manifest facts without trusting either alone. */
export const compareControlFacts = (expected: ControlWatermarks, actual: ControlWatermarks): string[] => {
  const mismatches: string[] = [];
  if (expected.commitSeq !== actual.commitSeq) mismatches.push('commitSeq');
  if (expected.stateVersion !== actual.stateVersion) mismatches.push('stateVersion');
  if (expected.tombstoneWatermark !== actual.tombstoneWatermark) mismatches.push('tombstoneWatermark');
  if (expected.deletionBaselineId !== actual.deletionBaselineId) mismatches.push('deletionBaselineId');
  if (expected.authorizationEpoch !== actual.authorizationEpoch) mismatches.push('authorizationEpoch');
  return mismatches;
};
