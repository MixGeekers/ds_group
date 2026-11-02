import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import type { SqliteTransactions } from '../../adapters/control-store/transaction.js';
import { EffectLedger } from '../effects/index.js';
import type { EffectAuthorization, EffectClaim, EffectOrigin, EffectRecord } from '../effects/index.js';
import type { TrustedPolicyActor } from '../policy/mandates.js';
import { MemoryOperationError } from './contracts.js';
import type {
  MemoryApprover, MemoryBackendReceipt, MemoryClaimRequest, MemoryDispatchAuthorizer,
  MemoryLedgerOptions, MemoryOperation, MemoryOperationInput, MemoryReceiptRecord,
  MemoryReceiptVerifier, MemoryReceiptVerdict, MemorySourceRef, MemoryTombstone, MemoryTombstoneInput,
} from './contracts.js';
export * from './contracts.js';

type Tx = Pick<SqliteTransactions, 'atomic' | 'owns' | 'assertUsable' | 'depth'>;
type Row = Record<string, unknown>;
interface StoredOperation {
  input: MemoryOperationInput; effectId: string; approvedBy: string; createdAt: string;
  localVersion: number; blockedAtWatermark?: number; publishedReceiptId?: string; lastReceiptId?: string;
  publicationBlockReason?: 'PUBLICATION_NOT_AUTHORIZED' | 'DEPENDENCY_NOT_APPLIED';
}
type Role = 'approverIds' | 'dispatcherIds' | 'verifierIds' | 'eraserIds';
const fail = (code: string, message: string): never => { throw new MemoryOperationError(code, message); };
const clone = <T>(value: T): T => structuredClone(value);
function text(value: unknown, label: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail('INVALID_SCHEMA', `Invalid ${label}`);
  return value as string;
}
function integer(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail('INVALID_SCHEMA', `Invalid ${label}`);
  return value as number;
}
function object(value: unknown, keys: string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SCHEMA', 'Expected a bounded object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(record, key))) fail('INVALID_SCHEMA', 'Unknown or missing memory fields');
  return record;
}
function list(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > 32 || (!allowEmpty && !value.length)) fail('INVALID_SCHEMA', `Invalid ${label}`);
  const values = (value as unknown[]).map(item => text(item, label));
  if (new Set(values).size !== values.length) fail('INVALID_SCHEMA', `Duplicate ${label}`);
  return values.sort();
}
function sources(value: unknown): MemorySourceRef[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) fail('INVALID_SCHEMA', 'A bounded source set is required');
  const values = (value as unknown[]).map(item => { const r = object(item, ['sourceId', 'revision']); return { sourceId: text(r.sourceId, 'sourceId'), revision: integer(r.revision, 'source revision', 1) }; });
  if (new Set(values.map(item => item.sourceId)).size !== values.length) fail('INVALID_SCHEMA', 'Duplicate source identity');
  return values.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
function timestamp(value: unknown): string {
  const result = text(value, 'UTC time', 40); const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) fail('INVALID_SCHEMA', 'Time must be canonical UTC');
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('INVALID_SCHEMA', 'Invalid command digest');
  return value as string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function syncCall<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): R {
  if (typeof fn !== 'function' || isAsyncFunction(fn)) fail('ASYNC_POLICY', 'Memory hooks must be synchronous trusted local facts');
  const result = fn(...args);
  if (isPromise(result)) { void Promise.prototype.then.call(result, undefined, () => undefined); fail('ASYNC_POLICY', 'Promise-returning memory hook rejected'); }
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') fail('ASYNC_POLICY', 'Thenable memory hook rejected without invoking it');
  return result;
}
function authorization(value: unknown): EffectAuthorization {
  const a = object(value, ['mandateId', 'mandateVersion', 'authEpoch', 'installationGeneration']);
  return { mandateId: text(a.mandateId, 'mandateId'), mandateVersion: integer(a.mandateVersion, 'mandateVersion', 1), authEpoch: integer(a.authEpoch, 'authEpoch'), installationGeneration: text(a.installationGeneration, 'installationGeneration') };
}
function origin(value: unknown): EffectOrigin {
  const item = value as EffectOrigin;
  if (item?.kind === 'task') { object(item, ['kind', 'taskId', 'assignmentId']); return { kind: 'task', taskId: text(item.taskId, 'taskId'), assignmentId: text(item.assignmentId, 'assignmentId') }; }
  if (item?.kind === 'dialogue') { object(item, ['kind', 'conversationId', 'turnId', 'conversationGeneration']); return { kind: 'dialogue', conversationId: text(item.conversationId, 'conversationId'), turnId: text(item.turnId, 'turnId'), conversationGeneration: integer(item.conversationGeneration, 'conversationGeneration') }; }
  return fail('INVALID_SCHEMA', 'An operation needs a Task or dialogue origin');
}
function input(value: MemoryOperationInput): MemoryOperationInput {
  const fields = ['operationId', 'backendId', 'proposalId', 'kind', 'commandRef', 'commandDigest', 'scope', 'targetRef', 'sourceRefs', 'dependencyRefs', 'expectedComponentVersion', 'expectedTombstoneWatermark', 'origin', 'mandateRef', 'expiresAt'];
  object(value, fields, fields.filter(key => key !== 'expectedComponentVersion'));
  if (!['append', 'update'].includes(value.kind)) fail('INVALID_SCHEMA', 'Unknown memory command kind');
  if (value.kind === 'update' && value.expectedComponentVersion === undefined) fail('CAS_REQUIRED', 'Updating existing backend state requires an atomic expected version');
  return {
    operationId: text(value.operationId, 'operationId', 150), backendId: text(value.backendId, 'backendId'), proposalId: text(value.proposalId, 'proposalId'),
    kind: value.kind, commandRef: text(value.commandRef, 'commandRef'), commandDigest: hash(value.commandDigest),
    scope: text(value.scope, 'scope'), targetRef: text(value.targetRef, 'targetRef'), sourceRefs: sources(value.sourceRefs), dependencyRefs: list(value.dependencyRefs, 'dependencyRefs', true),
    ...(value.expectedComponentVersion === undefined ? {} : { expectedComponentVersion: text(value.expectedComponentVersion, 'expectedComponentVersion') }),
    expectedTombstoneWatermark: integer(value.expectedTombstoneWatermark, 'expectedTombstoneWatermark'), origin: origin(value.origin), mandateRef: authorization(value.mandateRef), expiresAt: timestamp(value.expiresAt),
  };
}
function receipt(value: MemoryBackendReceipt): MemoryBackendReceipt {
  object(value, ['receiptId', 'operationId', 'backendId', 'externalOperationId', 'commandDigest', 'outcome', 'observedAt', 'nativeId', 'componentVersion', 'backendReceiptRef', 'verificationRef', 'evidenceRefs']);
  if (!['applied', 'rejected'].includes(value.outcome)) fail('INVALID_SCHEMA', 'Receipt must report an operation outcome');
  const result = {
    receiptId: text(value.receiptId, 'receiptId'), operationId: text(value.operationId, 'operationId', 150), backendId: text(value.backendId, 'backendId'), externalOperationId: text(value.externalOperationId, 'externalOperationId'),
    commandDigest: hash(value.commandDigest), outcome: value.outcome, observedAt: timestamp(value.observedAt), nativeId: value.nativeId === null ? null : text(value.nativeId, 'nativeId'),
    componentVersion: value.componentVersion === null ? null : text(value.componentVersion, 'componentVersion'), backendReceiptRef: text(value.backendReceiptRef, 'backendReceiptRef'), verificationRef: text(value.verificationRef, 'verificationRef'), evidenceRefs: list(value.evidenceRefs, 'evidenceRefs'),
  };
  if (result.outcome === 'applied' && result.nativeId === null) fail('UNVERIFIED_RECEIPT', 'Applied memory requires a verifiable native reference');
  return result;
}
/** Exact opaque resource identity for a configured backend deployment and scope. */
export function memoryResource(scope: string, backendId: string, targetRef: string): string {
  return `memory-resource:${digest([text(scope, 'scope'), text(backendId, 'backendId'), text(targetRef, 'targetRef')])}`;
}

/**
 * Control metadata on the existing DB Worker. Effect owns attempts, fences,
 * uncertain execution and receipts; the backend exclusively owns memory bodies.
 * Hooks consume prior trusted observations. Nothing here calls the backend.
 */
export class MemoryOperationLedger {
  private readonly effects: EffectLedger;
  private readonly config: Record<Role | 'backendIds', ReadonlySet<string>>;
  constructor(private readonly db: DatabaseSync, private readonly tx: Tx, private readonly options: MemoryLedgerOptions) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Memory ledger must share its transaction connection');
    this.config = {
      backendIds: new Set(list(options.backendIds, 'backendIds')), approverIds: new Set(list(options.approverIds, 'approverIds')),
      dispatcherIds: new Set(list(options.dispatcherIds, 'dispatcherIds')), verifierIds: new Set(list(options.verifierIds, 'verifierIds')), eraserIds: new Set(list(options.eraserIds, 'eraserIds')),
    };
    this.effects = new EffectLedger(db, tx, { now: options.now });
    tx.atomic(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_memory_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, policy_hash TEXT NOT NULL, tombstone_watermark INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_memory_operations (operation_id TEXT PRIMARY KEY, effect_id TEXT NOT NULL UNIQUE REFERENCES shiyu_effects(effect_id), scope TEXT NOT NULL, intent_hash TEXT NOT NULL, local_version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
        CREATE TABLE IF NOT EXISTS shiyu_memory_receipts (receipt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES shiyu_memory_operations(operation_id), intent_hash TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
        CREATE TABLE IF NOT EXISTS shiyu_memory_deletions (deletion_id TEXT PRIMARY KEY, intent_hash TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
        CREATE TABLE IF NOT EXISTS shiyu_memory_tombstones (scope TEXT NOT NULL, ref TEXT NOT NULL, watermark INTEGER NOT NULL, PRIMARY KEY(scope,ref));
        CREATE INDEX IF NOT EXISTS shiyu_memory_scope ON shiyu_memory_operations(scope);`);
      const policyHash = digest(Object.fromEntries(Object.entries(this.config).map(([key, values]) => [key, [...values].sort()])));
      db.prepare('INSERT OR IGNORE INTO shiyu_memory_meta VALUES(1,1,?,0)').run(policyHash);
      const meta = this.row('SELECT * FROM shiyu_memory_meta WHERE id=1')!;
      if (meta.schema_version !== 1) fail('INCOMPATIBLE_VERSION', 'Unsupported MemoryOperation schema');
      if (meta.policy_hash !== policyHash) fail('INCOMPATIBLE_POLICY', 'Changing trusted memory roles/backends requires an explicit migration');
    });
  }
  private row(sql: string, ...args: SQLInputValue[]): Row | undefined { this.tx.assertUsable(); return this.db.prepare(sql).get(...args) as Row | undefined; }
  private now(): string { return timestamp((this.options.now?.() ?? new Date()).toISOString()); }
  private actor(actor: TrustedPolicyActor, role: Role, scope?: string): TrustedPolicyActor {
    object(actor, ['principalId', 'kind', 'scopes']);
    const result = { principalId: text(actor.principalId, 'principalId'), kind: actor.kind, scopes: list(actor.scopes, 'actor scopes') };
    if (!['owner', 'component', 'agent'].includes(result.kind) || !this.config[role].has(result.principalId) || (scope !== undefined && !result.scopes.includes(scope))) fail('FORBIDDEN', 'Authenticated memory actor lacks this role or exact scope');
    return result;
  }
  private stored(id: string): StoredOperation | undefined {
    const row = this.row('SELECT record_json FROM shiyu_memory_operations WHERE operation_id=?', text(id, 'operationId', 150));
    return row ? JSON.parse(String(row.record_json)) as StoredOperation : undefined;
  }
  private required(id: string): StoredOperation { return this.stored(id) ?? fail('NOT_FOUND', 'MemoryOperation does not exist'); }
  private effect(row: StoredOperation): EffectRecord { return this.effects.get(row.effectId) ?? fail('CORRUPT_LEDGER', 'Linked Effect missing'); }
  private receiptRow(id: string): MemoryReceiptRecord | undefined {
    const row = this.row('SELECT record_json FROM shiyu_memory_receipts WHERE receipt_id=?', id);
    return row ? JSON.parse(String(row.record_json)) as MemoryReceiptRecord : undefined;
  }
  private refs(operation: MemoryOperationInput): string[] { return [operation.targetRef, ...operation.sourceRefs.map(ref => ref.sourceId), ...operation.dependencyRefs]; }
  private tombstoned(operation: MemoryOperationInput): number | undefined {
    let watermark: number | undefined;
    for (const ref of this.refs(operation)) {
      const row = this.row('SELECT watermark FROM shiyu_memory_tombstones WHERE scope=? AND ref=?', operation.scope, ref);
      if (row) watermark = Math.max(watermark ?? 0, Number(row.watermark));
    }
    return watermark;
  }
  private project(row: StoredOperation): MemoryOperation {
    const effect = this.effect(row); const last = row.lastReceiptId ? this.receiptRow(row.lastReceiptId) : undefined;
    const barrier = row.blockedAtWatermark ?? this.tombstoned(row.input);
    const status = effect.status === 'pending' ? 'approved' : effect.status === 'succeeded' ? (row.publishedReceiptId ? 'applied' : 'unknown') : ['failed', 'cancelled'].includes(effect.status) ? 'rejected' : effect.status;
    return {
      ...clone(row.input), schemaVersion: 1, effectId: row.effectId, approvedBy: row.approvedBy, createdAt: row.createdAt,
      version: integer(row.localVersion + effect.version - 1, 'operation version', 1), status: status as MemoryOperation['status'], effectState: effect.status,
      blocked: barrier !== undefined, ...(barrier === undefined ? {} : { blockedAtWatermark: barrier }),
      ...(last ? { backendReceiptRef: last.backendReceiptRef, verificationRef: last.verificationRef, backendOutcome: last.outcome } : {}),
      // Blocked references must not become a usable local publication again.
      ...(row.publishedReceiptId && barrier === undefined && last?.nativeId ? { nativeId: last.nativeId, ...(last.componentVersion === null ? {} : { componentVersion: last.componentVersion }) } : {}),
      ...(barrier !== undefined ? { reasonCode: 'TOMBSTONED' } : row.publicationBlockReason ? { reasonCode: row.publicationBlockReason } : effect.reasonCode ? { reasonCode: effect.reasonCode } : {}),
    };
  }
  private cas(row: StoredOperation, expected: number): MemoryOperation {
    const operation = this.project(row);
    if (operation.version !== integer(expected, 'expectedVersion', 1)) fail('VERSION_CONFLICT', 'MemoryOperation version changed');
    return operation;
  }
  private save(row: StoredOperation): void {
    const prior = row.localVersion; row.localVersion = integer(prior + 1, 'localVersion', 1);
    const result = this.db.prepare('UPDATE shiyu_memory_operations SET local_version=?,record_json=? WHERE operation_id=? AND local_version=?').run(row.localVersion, JSON.stringify(row), row.input.operationId, prior);
    if (result.changes !== 1) fail('VERSION_CONFLICT', 'MemoryOperation local revision changed');
  }
  private policy(operation: MemoryOperationInput, sourcesVerified: unknown, dependenciesVerified: unknown, observedVersion: unknown, atomic: unknown): void {
    if (sourcesVerified !== true) fail('UNVERIFIED_SOURCES', 'Current source identity, revision and saving policy must be verified');
    if (dependenciesVerified !== true) fail('UNVERIFIED_DEPENDENCIES', 'Current dependency scope and availability must be verified');
    if (typeof atomic !== 'boolean' || (observedVersion !== null && typeof observedVersion !== 'string')) fail('INVALID_POLICY', 'Backend capability/observation is not a trusted typed fact');
    if (operation.expectedComponentVersion !== undefined) {
      if (atomic !== true) fail('BACKEND_CAS_UNSUPPORTED', 'Backend atomic conditional update has not been verified');
      if (observedVersion !== operation.expectedComponentVersion) fail('COMPONENT_CONFLICT', 'Observed backend revision changed');
    }
  }
  private notBlocked(row: StoredOperation): void {
    if (row.blockedAtWatermark !== undefined || this.tombstoned(row.input) !== undefined) fail('TOMBSTONED', 'Deleted sources, dependencies or targets cannot be reused');
  }
  private knownDependenciesAvailable(operation: MemoryOperationInput): boolean {
    // Source edges may also point at a locally registered memory target. Inspect
    // both kinds of incoming edge, not only the explicit dependency list.
    const refs = new Set([...operation.dependencyRefs, ...operation.sourceRefs.map(source => source.sourceId)]);
    for (const ref of refs) {
      const rows = this.db.prepare("SELECT operation_id FROM shiyu_memory_operations WHERE scope=? AND operation_id<>? AND json_extract(record_json,'$.input.targetRef')=?").all(operation.scope, operation.operationId, ref) as Row[];
      if (!rows.length) continue; // The trusted policy must verify external refs.
      const states = rows.map(row => this.project(this.required(String(row.operation_id))));
      if (states.some(state => ['approved', 'dispatching', 'unknown'].includes(state.status)) || !states.some(state => state.status === 'applied' && !state.blocked && state.nativeId !== undefined)) return false;
    }
    return true;
  }
  private knownDependencies(operation: MemoryOperationInput): void {
    if (!this.knownDependenciesAvailable(operation)) fail('DEPENDENCY_NOT_APPLIED', 'A known memory dependency is not available as a verified applied result');
  }
  get(operationId: string): MemoryOperation | undefined { const row = this.stored(operationId); return row ? this.project(row) : undefined; }
  watermark(): number { return Number(this.row('SELECT tombstone_watermark FROM shiyu_memory_meta WHERE id=1')!.tombstone_watermark); }
  receipts(operationId: string): MemoryReceiptRecord[] {
    this.tx.assertUsable(); text(operationId, 'operationId', 150);
    return (this.db.prepare('SELECT record_json FROM shiyu_memory_receipts WHERE operation_id=? ORDER BY rowid').all(operationId) as Row[]).map(row => JSON.parse(String(row.record_json)) as MemoryReceiptRecord);
  }
  approve(actor: TrustedPolicyActor, value: MemoryOperationInput, authorize: MemoryApprover): MemoryOperation {
    const intent = input(value); const trusted = this.actor(actor, 'approverIds', intent.scope);
    if (!this.config.backendIds.has(intent.backendId)) fail('FORBIDDEN_BACKEND', 'Backend deployment is not registered');
    return this.tx.atomic(() => {
      const old = this.row('SELECT intent_hash FROM shiyu_memory_operations WHERE operation_id=?', intent.operationId);
      if (old) {
        if (old.intent_hash !== digest(intent)) fail('IDEMPOTENCY_CONFLICT', 'operationId already names different memory intent');
        return this.project(this.required(intent.operationId));
      }
      if (intent.expectedTombstoneWatermark !== this.watermark()) fail('STALE_WATERMARK', 'Proposal must observe the latest deletion barrier');
      if (this.tombstoned(intent) !== undefined) fail('TOMBSTONED', 'Proposal refers to deleted material');
      const verdict = syncCall(authorize, clone(intent), clone(trusted));
      if (!verdict || verdict.allowed !== true) return fail('FORBIDDEN', 'Current policy did not approve memory storage');
      if (!same(authorization(verdict.authorization), intent.mandateRef)) fail('STALE_AUTHORIZATION', 'Approval authorization differs from current policy');
      this.policy(intent, verdict.sourcesVerified, verdict.dependenciesVerified, verdict.observedComponentVersion, verdict.atomicVersionCheck);
      if (this.effects.get(`memory-effect:${intent.operationId}`)) fail('IDEMPOTENCY_CONFLICT', 'Effect identity is already owned by another admission');
      const effect = this.effects.enqueue({
        effectId: `memory-effect:${intent.operationId}`, idempotencyKey: `memory-operation:${intent.operationId}`,
        origin: intent.origin, action: 'memory.write', resourceScopes: [memoryResource(intent.scope, intent.backendId, intent.targetRef)],
        payloadRef: intent.commandRef, payloadHash: intent.commandDigest, authorization: intent.mandateRef,
        expiresAt: intent.expiresAt, replayClass: 'reconcilable', maxAttempts: 1,
      });
      const row: StoredOperation = { input: intent, effectId: effect.effectId, approvedBy: trusted.principalId, createdAt: this.now(), localVersion: 1 };
      this.db.prepare('INSERT INTO shiyu_memory_operations VALUES(?,?,?,?,?,?)').run(intent.operationId, effect.effectId, intent.scope, digest(intent), 1, JSON.stringify(row));
      return this.project(row);
    });
  }
  claim(actor: TrustedPolicyActor, request: MemoryClaimRequest, authorize: MemoryDispatchAuthorizer): EffectClaim | undefined {
    object(request, ['operationId', 'expectedVersion', 'ownerId', 'hostEpoch', 'installationGeneration', 'fencingToken', 'leaseMs']);
    const initial = this.required(request.operationId); const trusted = this.actor(actor, 'dispatcherIds', initial.input.scope);
    return this.effects.claim({ effectId: initial.effectId, ownerId: request.ownerId, hostEpoch: request.hostEpoch, installationGeneration: request.installationGeneration, fencingToken: request.fencingToken, leaseMs: request.leaseMs }, () => {
      const row = this.required(request.operationId); const operation = this.cas(row, request.expectedVersion); this.notBlocked(row); this.knownDependencies(row.input);
      const verdict = syncCall(authorize, operation, clone(trusted));
      if (!verdict || verdict.allowed !== true) return fail('FORBIDDEN', 'Memory dispatch is not currently allowed');
      this.policy(row.input, verdict.sourcesVerified, verdict.dependenciesVerified, verdict.observedComponentVersion, verdict.atomicVersionCheck);
      return verdict;
    });
  }
  assertDispatch(actor: TrustedPolicyActor, operationId: string, claim: EffectClaim, authorize: MemoryDispatchAuthorizer): MemoryOperation {
    const row = this.required(operationId); const trusted = this.actor(actor, 'dispatcherIds', row.input.scope); this.match(row, claim);
    this.effects.assertDispatch(claim, () => {
      const current = this.required(operationId); this.notBlocked(current); this.knownDependencies(current.input);
      const verdict = syncCall(authorize, this.project(current), clone(trusted));
      if (!verdict || verdict.allowed !== true) return fail('FORBIDDEN', 'Memory execution authorization was withdrawn');
      this.policy(current.input, verdict.sourcesVerified, verdict.dependenciesVerified, verdict.observedComponentVersion, verdict.atomicVersionCheck);
      return verdict;
    });
    return this.get(operationId)!;
  }
  private match(row: StoredOperation, claim: EffectClaim): void { if (claim?.effectId !== row.effectId) fail('CLAIM_MISMATCH', 'Claim belongs to another MemoryOperation'); }
  markUnknown(actor: TrustedPolicyActor, operationId: string, expectedVersion: number, claim: EffectClaim, reasonCode: string): MemoryOperation {
    return this.tx.atomic(() => {
      const row = this.required(operationId); this.actor(actor, 'dispatcherIds', row.input.scope); this.cas(row, expectedVersion); this.match(row, claim);
      this.effects.markUnknown(claim, reasonCode); return this.project(row);
    });
  }
  reject(actor: TrustedPolicyActor, operationId: string, expectedVersion: number, reasonCode: string): MemoryOperation {
    return this.tx.atomic(() => {
      const row = this.required(operationId); this.actor(actor, 'approverIds', row.input.scope); this.cas(row, expectedVersion);
      const effect = this.effect(row);
      if (effect.status !== 'pending') fail('INVALID_STATE', 'A dispatched operation cannot be declared not applied without backend evidence');
      this.effects.cancel(effect.effectId, effect.version, text(reasonCode, 'reasonCode', 100)); return this.project(row);
    });
  }
  complete(actor: TrustedPolicyActor, operationId: string, expectedVersion: number, claim: EffectClaim, result: MemoryBackendReceipt, verify: MemoryReceiptVerifier): MemoryOperation {
    return this.recordReceipt(actor, operationId, expectedVersion, claim, result, verify, 'completion');
  }
  reconcile(actor: TrustedPolicyActor, operationId: string, expectedVersion: number, claim: EffectClaim, result: MemoryBackendReceipt, verify: MemoryReceiptVerifier): MemoryOperation {
    return this.recordReceipt(actor, operationId, expectedVersion, claim, result, verify, 'reconciliation');
  }
  private recordReceipt(actor: TrustedPolicyActor, operationId: string, expectedVersion: number, claim: EffectClaim, value: MemoryBackendReceipt, verify: MemoryReceiptVerifier, mode: MemoryReceiptRecord['mode']): MemoryOperation {
    const result = receipt(value);
    return this.tx.atomic(() => {
      const row = this.required(operationId); this.actor(actor, 'verifierIds', row.input.scope); this.match(row, claim);
      if (result.operationId !== operationId || result.backendId !== row.input.backendId || result.commandDigest !== row.input.commandDigest) fail('RECEIPT_MISMATCH', 'Receipt does not describe the approved memory operation');
      const receiptHash = digest({ result, claim, mode });
      const prior = this.row('SELECT intent_hash FROM shiyu_memory_receipts WHERE receipt_id=?', result.receiptId);
      if (prior) { if (prior.intent_hash !== receiptHash) fail('IDEMPOTENCY_CONFLICT', 'Receipt identity changed'); return this.project(row); }
      const operation = this.cas(row, expectedVersion);
      const verdict = syncCall(verify, clone(operation), clone(result));
      this.verifyReceipt(operation, result, verdict, mode);
      const verified = verdict as Extract<MemoryReceiptVerdict, { verified: true }>;
      const outcome = result.outcome === 'applied' ? 'succeeded' : 'failed';
      this.effects[mode === 'completion' ? 'complete' : 'reconcile'](claim, {
        receiptId: result.receiptId, serviceId: result.backendId, externalOperationId: result.externalOperationId,
        observedAt: result.observedAt, outcome, payloadHash: result.commandDigest, evidenceRefs: result.evidenceRefs,
      }, effect => ({ verified: true, installationGeneration: verified.installationGeneration, serviceId: result.backendId, externalOperationId: result.externalOperationId, reconciled: verified.reconciled, settledEffect: { idempotencyKey: effect.idempotencyKey, payloadHash: effect.payloadHash, outcome } }));
      const dependenciesAvailable = this.knownDependenciesAvailable(row.input);
      const published = result.outcome === 'applied' && verified.publicationAllowed && dependenciesAvailable && row.blockedAtWatermark === undefined && this.tombstoned(row.input) === undefined;
      const record: MemoryReceiptRecord = { ...result, effectId: row.effectId, claim: clone(claim), receivedAt: this.now(), mode, published, verification: { ...verified, sourceRefs: sources(verified.sourceRefs) } };
      this.db.prepare('INSERT INTO shiyu_memory_receipts VALUES(?,?,?,?)').run(result.receiptId, operationId, receiptHash, JSON.stringify(record));
      row.lastReceiptId = result.receiptId; if (published) row.publishedReceiptId = result.receiptId;
      if (result.outcome === 'applied' && !verified.publicationAllowed) row.publicationBlockReason = 'PUBLICATION_NOT_AUTHORIZED';
      else if (result.outcome === 'applied' && !dependenciesAvailable) row.publicationBlockReason = 'DEPENDENCY_NOT_APPLIED';
      this.save(row); return this.project(row);
    });
  }
  private verifyReceipt(operation: MemoryOperation, result: MemoryBackendReceipt, verdict: MemoryReceiptVerdict, mode: MemoryReceiptRecord['mode']): void {
    if (!verdict || verdict.verified !== true) return fail('UNVERIFIED_RECEIPT', 'Backend receipt needs independent trusted verification');
    object(verdict, ['verified', 'operationId', 'backendId', 'externalOperationId', 'commandDigest', 'outcome', 'installationGeneration', 'nativeId', 'componentVersion', 'sourceRefs', 'operationSettled', 'reconciled', 'publicationAllowed', 'atomicCas']);
    if (verdict.operationSettled !== true || typeof verdict.reconciled !== 'boolean' || (mode === 'reconciliation' && verdict.reconciled !== true)) fail('RESULT_UNKNOWN', 'Attempt acceptance or failure cannot settle uncertain backend state');
    if (typeof verdict.publicationAllowed !== 'boolean') fail('UNVERIFIED_RECEIPT', 'Publication authorization must be an explicit trusted current fact');
    if (verdict.atomicCas !== null) { object(verdict.atomicCas, ['expectedVersion', 'resultVersion']); text(verdict.atomicCas.expectedVersion, 'expected CAS version'); text(verdict.atomicCas.resultVersion, 'result CAS version'); }
    for (const key of ['operationId', 'backendId', 'externalOperationId', 'commandDigest', 'outcome', 'nativeId', 'componentVersion'] as const) {
      if (verdict[key] !== result[key]) fail('UNVERIFIED_RECEIPT', `Verified ${key} does not match the backend receipt`);
    }
    if (verdict.installationGeneration !== operation.mandateRef.installationGeneration) fail('STALE_FENCE', 'Receipt installation generation differs');
    if (!same(sources(verdict.sourceRefs), operation.sourceRefs)) fail('UNVERIFIED_SOURCES', 'Backend provenance does not match the approved source revisions');
    if (operation.expectedComponentVersion !== undefined && result.outcome === 'applied') {
      if (!verdict.atomicCas || verdict.atomicCas.expectedVersion !== operation.expectedComponentVersion || verdict.atomicCas.resultVersion !== result.componentVersion || result.componentVersion === null) fail('UNVERIFIED_CAS', 'Backend must prove the atomic conditional write, not a preflight observation');
    }
  }
  /**
   * Local immediate barrier only. Never claims backend erasure or backup purge.
   * In-flight work becomes unknown; late receipts remain facts without publishing.
   */
  tombstone(actor: TrustedPolicyActor, value: MemoryTombstoneInput): MemoryTombstone {
    object(value, ['deletionId', 'scope', 'refs', 'expectedWatermark', 'reasonCode']);
    const intent: MemoryTombstoneInput = { deletionId: text(value.deletionId, 'deletionId'), scope: text(value.scope, 'scope'), refs: list(value.refs, 'deleted refs'), expectedWatermark: integer(value.expectedWatermark, 'expectedWatermark'), reasonCode: text(value.reasonCode, 'reasonCode', 100) };
    const trusted = this.actor(actor, 'eraserIds', intent.scope);
    return this.tx.atomic(() => {
      const old = this.row('SELECT * FROM shiyu_memory_deletions WHERE deletion_id=?', intent.deletionId);
      if (old) { if (old.intent_hash !== digest(intent)) fail('IDEMPOTENCY_CONFLICT', 'Deletion identity changed'); return JSON.parse(String(old.record_json)) as MemoryTombstone; }
      if (intent.expectedWatermark !== this.watermark()) fail('STALE_WATERMARK', 'Deletion watermark changed');
      const watermark = integer(intent.expectedWatermark + 1, 'watermark', 1);
      const result: MemoryTombstone = { ...intent, watermark, acceptedAt: this.now(), acceptedBy: trusted.principalId };
      this.db.prepare('UPDATE shiyu_memory_meta SET tombstone_watermark=? WHERE id=1').run(watermark);
      this.db.prepare('INSERT INTO shiyu_memory_deletions VALUES(?,?,?)').run(intent.deletionId, digest(intent), JSON.stringify(result));
      // Close the recorded dependency graph before updating any operation: a
      // derivation through another target must be blocked in this transaction.
      const rows = (this.db.prepare('SELECT operation_id FROM shiyu_memory_operations WHERE scope=?').all(intent.scope) as Row[]).map(item => this.required(String(item.operation_id)));
      const erased = new Set(intent.refs); const affected = new Set<StoredOperation>();
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) {
          if (affected.has(row) || !this.refs(row.input).some(ref => erased.has(ref))) continue;
          affected.add(row); erased.add(row.input.targetRef); changed = true;
        }
      }
      for (const ref of erased) this.db.prepare('INSERT INTO shiyu_memory_tombstones VALUES(?,?,?) ON CONFLICT(scope,ref) DO UPDATE SET watermark=excluded.watermark').run(intent.scope, ref, watermark);
      for (const row of affected) {
        row.blockedAtWatermark = watermark;
        const effect = this.effect(row);
        if (effect.status === 'pending' || effect.status === 'dispatching' || effect.status === 'unknown') {
          this.effects.cancel(effect.effectId, effect.version, 'MEMORY_TOMBSTONED');
          if (effect.status === 'dispatching') this.effects.markUnknown(effect.currentClaim!, 'MEMORY_TOMBSTONED_IN_FLIGHT');
        }
        this.save(row);
      }
      return result;
    });
  }
  /** Scoped crash classification; it neither replays writes nor recovers other domains. */
  recover(actor: TrustedPolicyActor, current: { installationGeneration: string; hostEpoch: string }): MemoryOperation[] {
    object(current, ['installationGeneration', 'hostEpoch']); text(current.installationGeneration, 'installationGeneration'); text(current.hostEpoch, 'hostEpoch');
    const trusted = this.actor(actor, 'dispatcherIds');
    return this.tx.atomic(() => {
      const changed: MemoryOperation[] = []; const now = this.now();
      for (const item of this.db.prepare('SELECT operation_id FROM shiyu_memory_operations').all() as Row[]) {
        const row = this.required(String(item.operation_id)); if (!trusted.scopes.includes(row.input.scope)) continue;
        const effect = this.effect(row); const claim = effect.currentClaim;
        if (effect.status === 'dispatching' && claim && (claim.installationGeneration !== current.installationGeneration || claim.hostEpoch !== current.hostEpoch || claim.leaseExpiresAt <= now)) {
          this.effects.markUnknown(claim, 'MEMORY_RECOVERY_UNKNOWN'); changed.push(this.project(row));
        }
      }
      return changed;
    });
  }
}
