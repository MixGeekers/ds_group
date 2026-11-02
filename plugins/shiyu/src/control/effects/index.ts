import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import type { SqliteTransactions } from '../../adapters/control-store/transaction.js';
import { EffectError } from './contracts.js';
import type {
  ClaimRequest, DispatchAuthorizer, DispatchVerdict, EffectAttempt, EffectClaim,
  EffectInput, EffectOrigin, EffectReceipt, EffectReceiptInput, EffectRecord,
  EffectState, ReceiptVerifier, ReceiptVerdict,
} from './contracts.js';
export * from './contracts.js';

type Row = Record<string, unknown>;
type TransactionPort = Pick<SqliteTransactions, 'atomic' | 'assertUsable' | 'owns' | 'depth'>;
const states: EffectState[] = ['pending', 'dispatching', 'succeeded', 'failed', 'unknown', 'cancelled'];
const failure = (code: string, text: string): never => { throw new EffectError(code, text); };
const clone = <T>(value: T): T => structuredClone(value);
function string(value: unknown, label: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) return failure('INVALID_SCHEMA', `Invalid ${label}.`);
  return value;
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return failure('INVALID_SCHEMA', `Invalid ${label}.`);
  return value as number;
}
function timestamp(value: unknown, label: string): string {
  const text = string(value, label, 40);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) return failure('INVALID_SCHEMA', `${label} must be canonical UTC time.`);
  return text;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) return failure('INVALID_SCHEMA', 'Invalid payload hash.');
  return value;
}
function object(value: unknown, fields: string[], required: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failure('INVALID_SCHEMA', `Invalid ${label}.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(record, key))) return failure('INVALID_SCHEMA', `Unknown or missing ${label} fields.`);
  return record;
}
function origin(value: unknown): EffectOrigin {
  const data = value as EffectOrigin;
  if (data?.kind === 'task') {
    object(data, ['kind', 'taskId', 'assignmentId'], ['kind', 'taskId', 'assignmentId'], 'task origin');
    return { kind: 'task', taskId: string(data.taskId, 'taskId'), assignmentId: string(data.assignmentId, 'assignmentId') };
  }
  if (data?.kind === 'dialogue') {
    object(data, ['kind', 'conversationId', 'turnId', 'conversationGeneration'], ['kind', 'conversationId', 'turnId', 'conversationGeneration'], 'dialogue origin');
    return { kind: 'dialogue', conversationId: string(data.conversationId, 'conversationId'), turnId: string(data.turnId, 'turnId'), conversationGeneration: integer(data.conversationGeneration, 'conversationGeneration') };
  }
  return failure('INVALID_SCHEMA', 'An Effect requires exactly one complete origin.');
}
function checkedInput(input: EffectInput): Omit<EffectRecord, 'schemaVersion' | 'effectId' | 'status' | 'version' | 'attempts' | 'createdAt' | 'updatedAt'> {
  object(input, ['effectId', 'idempotencyKey', 'origin', 'action', 'resourceScopes', 'payloadRef', 'payloadHash', 'replayClass', 'authorization', 'expiresAt', 'maxAttempts'], ['idempotencyKey', 'origin', 'action', 'resourceScopes', 'payloadRef', 'payloadHash', 'replayClass', 'authorization', 'expiresAt'], 'effect');
  const a = object(input.authorization, ['mandateId', 'mandateVersion', 'authEpoch', 'installationGeneration'], ['mandateId', 'mandateVersion', 'authEpoch', 'installationGeneration'], 'authorization');
  if (!['idempotent', 'reconcilable', 'non_replayable'].includes(input.replayClass)) failure('INVALID_SCHEMA', 'Invalid replay class.');
  if (!Array.isArray(input.resourceScopes) || !input.resourceScopes.length || input.resourceScopes.length > 32) failure('INVALID_SCHEMA', 'Effect requires bounded resource scopes.');
  const scopes = input.resourceScopes.map(scope => string(scope, 'resource scope'));
  if (new Set(scopes).size !== scopes.length) failure('INVALID_SCHEMA', 'Duplicate resource scope.');
  return {
    idempotencyKey: string(input.idempotencyKey, 'idempotency key'), origin: origin(input.origin), action: string(input.action, 'action', 100),
    resourceScopes: scopes.sort(), payloadRef: string(input.payloadRef, 'payload reference'), payloadHash: hash(input.payloadHash), replayClass: input.replayClass,
    authorization: { mandateId: string(a.mandateId, 'mandateId'), mandateVersion: integer(a.mandateVersion, 'mandateVersion', 1), authEpoch: integer(a.authEpoch, 'authEpoch'), installationGeneration: string(a.installationGeneration, 'installationGeneration') },
    expiresAt: timestamp(input.expiresAt, 'expiresAt'), maxAttempts: integer(input.maxAttempts ?? 1, 'maxAttempts', 1, 20),
  };
}
function synchronous<T>(result: T): T {
  if (isPromise(result)) {
    void Promise.prototype.then.call(result, undefined, () => undefined);
    failure('ASYNC_POLICY', 'Policy and verification hooks must use synchronous local facts.');
  }
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    // Do not assimilate a foreign thenable: doing so would invoke its code after
    // this transaction has rolled back. Already-running I/O cannot be undone.
    failure('ASYNC_POLICY', 'Policy and verification hooks must use synchronous local facts.');
  }
  return result;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function checkedClaim(value: EffectClaim): EffectClaim {
  const fields = ['effectId', 'attempt', 'claimToken', 'ownerId', 'hostEpoch', 'installationGeneration', 'fencingToken', 'claimedAt', 'leaseExpiresAt'];
  object(value, fields, fields, 'claim identity');
  return {
    effectId: string(value.effectId, 'effectId'), attempt: integer(value.attempt, 'attempt', 1, 20), claimToken: string(value.claimToken, 'claimToken'),
    ownerId: string(value.ownerId, 'ownerId'), hostEpoch: string(value.hostEpoch, 'hostEpoch'), installationGeneration: string(value.installationGeneration, 'installationGeneration'),
    fencingToken: integer(value.fencingToken, 'fencingToken', 1), claimedAt: timestamp(value.claimedAt, 'claimedAt'), leaseExpiresAt: timestamp(value.leaseExpiresAt, 'leaseExpiresAt'),
  };
}

/**
 * Durable Effect facts, owned by the same DB Worker/transaction as Task writes.
 * This is not the Superagent Effects scheduler: it supplies the separate facts,
 * attempts and unknown/reconciliation semantics that scheduler must preserve.
 * No method performs external I/O; a dispatcher uses assertDispatch immediately
 * before calling its adapter, then records a verified receipt or uncertainty.
 */
export class EffectLedger {
  constructor(private readonly db: DatabaseSync, private readonly transaction: TransactionPort, private readonly options: { now?: () => Date } = {}) {
    if (!transaction.owns(db)) failure('TRANSACTION_MISMATCH', 'Effect ledger and transaction must own the same SQLite connection.');
    this.transaction.atomic(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shiyu_effect_schema (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
        INSERT OR IGNORE INTO shiyu_effect_schema(id,version) VALUES(1,1);
      `);
      if (this.row('SELECT version FROM shiyu_effect_schema WHERE id=1')?.version !== 1) failure('INCOMPATIBLE_VERSION', 'Unsupported Effect schema.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS shiyu_effects (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, effect_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT NOT NULL UNIQUE, intent_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','dispatching','succeeded','failed','unknown','cancelled')),
          version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
        );
        CREATE INDEX IF NOT EXISTS shiyu_effects_status ON shiyu_effects(status,seq);
        CREATE TABLE IF NOT EXISTS shiyu_effect_attempts (
          effect_id TEXT NOT NULL REFERENCES shiyu_effects(effect_id), attempt INTEGER NOT NULL,
          claim_token TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
          PRIMARY KEY(effect_id,attempt)
        );
        CREATE TABLE IF NOT EXISTS shiyu_effect_receipts (
          receipt_id TEXT PRIMARY KEY, effect_id TEXT NOT NULL REFERENCES shiyu_effects(effect_id),
          claim_token TEXT NOT NULL, receipt_hash TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        );
      `);
    });
  }
  private now(): string { return timestamp((this.options.now?.() ?? new Date()).toISOString(), 'current time'); }
  private row(sql: string, ...values: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...values) as Row | undefined; }
  private read(row: Row | undefined): EffectRecord | undefined {
    if (!row) return undefined;
    const record = JSON.parse(String(row.record_json)) as EffectRecord;
    if (record.schemaVersion !== 1 || !states.includes(record.status) || record.effectId !== row.effect_id || record.status !== row.status || record.version !== row.version) failure('CORRUPT_EFFECT', 'Effect projection and record disagree.');
    return record;
  }
  private required(id: string): EffectRecord { return this.get(id) ?? failure('NOT_FOUND', 'Effect does not exist.'); }
  private save(effect: EffectRecord, now: string): EffectRecord {
    const expected = effect.version;
    effect.version++; effect.updatedAt = now;
    const result = this.db.prepare('UPDATE shiyu_effects SET status=?,version=?,record_json=? WHERE effect_id=? AND version=?').run(effect.status, effect.version, JSON.stringify(effect), effect.effectId, expected);
    if (result.changes !== 1) failure('VERSION_CONFLICT', 'Effect changed concurrently.');
    return clone(effect);
  }
  private saveAttempt(claim: EffectClaim, patch: Partial<EffectAttempt>): void {
    const row = this.row('SELECT record_json FROM shiyu_effect_attempts WHERE effect_id=? AND attempt=?', claim.effectId, claim.attempt);
    if (!row) failure('CORRUPT_EFFECT', 'Effect attempt is missing.');
    const attempt = { ...JSON.parse(String(row!.record_json)) as EffectAttempt, ...patch };
    this.db.prepare('UPDATE shiyu_effect_attempts SET record_json=? WHERE effect_id=? AND attempt=?').run(JSON.stringify(attempt), claim.effectId, claim.attempt);
  }
  private revision(effect: EffectRecord, expected: number): void {
    integer(expected, 'expectedVersion', 1);
    if (effect.version !== expected) failure('VERSION_CONFLICT', 'Effect changed concurrently.');
  }
  private match(effect: EffectRecord, claim: EffectClaim): void {
    if (!effect.currentClaim || JSON.stringify(effect.currentClaim) !== JSON.stringify(claim)) failure('STALE_FENCE', 'Receipt or dispatch does not match the current Effect attempt.');
  }
  private authorize(effect: EffectRecord, authorize: DispatchAuthorizer, request?: Pick<ClaimRequest, 'hostEpoch' | 'installationGeneration' | 'fencingToken'>): DispatchVerdict & { allowed: true } {
    if (typeof authorize !== 'function') return failure('FORBIDDEN', 'A trusted dispatch authorization hook is required.');
    if (isAsyncFunction(authorize)) return failure('ASYNC_POLICY', 'Dispatch authorization must be synchronous.');
    const verdict = synchronous(authorize(clone(effect)));
    if (!verdict || verdict.allowed !== true) return failure('FORBIDDEN', 'Current dispatch authorization rejected the Effect.');
    const a = effect.authorization;
    if (verdict.mandateId !== a.mandateId || verdict.mandateVersion !== a.mandateVersion || verdict.authEpoch !== a.authEpoch || verdict.installationGeneration !== a.installationGeneration) failure('STALE_AUTHORIZATION', 'Effect authorization no longer matches current policy.');
    string(verdict.hostEpoch, 'authorized hostEpoch'); integer(verdict.fencingToken, 'authorized fencingToken', 1);
    if (request && (request.hostEpoch !== verdict.hostEpoch || request.installationGeneration !== verdict.installationGeneration || request.fencingToken !== verdict.fencingToken)) failure('STALE_FENCE', 'Dispatch does not match the current execution fence.');
    if (effect.origin.kind === 'dialogue' && verdict.conversationGeneration !== effect.origin.conversationGeneration) failure('STALE_CONVERSATION', 'Reply is from an obsolete conversation generation.');
    return verdict;
  }
  private dispatchable(effect: EffectRecord, now: string): void {
    if (effect.cancelRequestedAt) failure('CANCEL_REQUESTED', 'Cancellation prevents a new dispatch.');
    if (effect.expiresAt <= now) failure('EXPIRED', 'Effect deadline has passed.');
  }
  private uncertainAttempt(effect: EffectRecord): boolean {
    return Boolean(effect.currentClaim && this.attempts(effect.effectId).at(-1)?.status === 'unknown');
  }
  private assertNoOtherUncertainResource(effect: EffectRecord): void {
    for (const row of this.db.prepare("SELECT effect_id,status,version,record_json FROM shiyu_effects WHERE effect_id<>? AND status IN ('pending','dispatching','unknown')").all(effect.effectId) as Row[]) {
      const other = this.read(row)!;
      // An explicit idempotent retry changes the Effect back to pending, but the
      // original attempt is still uncertain until the same operation is settled.
      if (other.status === 'pending' && !this.uncertainAttempt(other)) continue;
      if (other.resourceScopes.some(scope => effect.resourceScopes.includes(scope))) failure('RESOURCE_BUSY', 'A resource has an in-flight or unknown Effect.');
    }
  }
  get(effectId: string): EffectRecord | undefined {
    this.transaction.assertUsable(); string(effectId, 'effectId');
    return this.read(this.row('SELECT effect_id,status,version,record_json FROM shiyu_effects WHERE effect_id=?', effectId));
  }
  /** Includes a retry queued for an operation whose previous result is unknown. */
  hasUncertainty(effectId: string): boolean {
    const effect = this.required(effectId);
    return effect.status === 'unknown' || (['pending', 'dispatching'].includes(effect.status) && this.attempts(effectId).some(attempt => attempt.status === 'unknown'));
  }
  /** Not truncated by a diagnostic list limit; used for Task outcome projection. */
  hasUncertaintyForTask(taskId: string): boolean {
    this.transaction.assertUsable(); string(taskId, 'taskId');
    const rows = this.db.prepare("SELECT effect_id FROM shiyu_effects WHERE json_extract(record_json,'$.origin.kind')='task' AND json_extract(record_json,'$.origin.taskId')=? AND status IN ('pending','dispatching','unknown')").all(taskId) as Row[];
    return rows.some(row => this.hasUncertainty(String(row.effect_id)));
  }
  list(options: { status?: EffectState; limit?: number } = {}): EffectRecord[] {
    this.transaction.assertUsable();
    const limit = integer(options.limit ?? 100, 'limit', 1, 1000);
    if (options.status !== undefined && !states.includes(options.status)) failure('INVALID_SCHEMA', 'Invalid Effect status.');
    const query = options.status === undefined ? this.db.prepare('SELECT effect_id,status,version,record_json FROM shiyu_effects ORDER BY seq LIMIT ?').all(limit) : this.db.prepare('SELECT effect_id,status,version,record_json FROM shiyu_effects WHERE status=? ORDER BY seq LIMIT ?').all(options.status, limit);
    return (query as Row[]).map(row => this.read(row)!);
  }
  attempts(effectId: string): EffectAttempt[] {
    this.transaction.assertUsable(); string(effectId, 'effectId');
    return (this.db.prepare('SELECT record_json FROM shiyu_effect_attempts WHERE effect_id=? ORDER BY attempt').all(effectId) as Row[]).map(row => JSON.parse(String(row.record_json)) as EffectAttempt);
  }
  receipts(effectId: string): EffectReceipt[] {
    this.transaction.assertUsable(); string(effectId, 'effectId');
    return (this.db.prepare('SELECT record_json FROM shiyu_effect_receipts WHERE effect_id=? ORDER BY rowid').all(effectId) as Row[]).map(row => JSON.parse(String(row.record_json)) as EffectReceipt);
  }
  enqueue(input: EffectInput): EffectRecord {
    const intent = checkedInput(input); const effectId = input.effectId === undefined ? randomUUID() : string(input.effectId, 'effectId');
    const intentHash = digest(intent);
    return this.transaction.atomic(() => {
      const existing = this.row('SELECT effect_id,status,version,record_json,intent_hash FROM shiyu_effects WHERE idempotency_key=?', intent.idempotencyKey);
      if (existing) {
        if (existing.intent_hash !== intentHash || (input.effectId !== undefined && existing.effect_id !== input.effectId)) failure('IDEMPOTENCY_CONFLICT', 'The idempotency key already names a different Effect.');
        return this.read(existing)!;
      }
      if (this.get(effectId)) failure('IDEMPOTENCY_CONFLICT', 'Effect ID already exists under another key.');
      const now = this.now();
      if (intent.expiresAt <= now) failure('EXPIRED', 'Cannot enqueue an expired Effect.');
      const effect: EffectRecord = { ...intent, schemaVersion: 1, effectId, status: 'pending', version: 1, attempts: 0, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO shiyu_effects(effect_id,idempotency_key,intent_hash,status,version,record_json) VALUES(?,?,?,?,?,?)').run(effectId, intent.idempotencyKey, intentHash, effect.status, effect.version, JSON.stringify(effect));
      return clone(effect);
    });
  }
  /** Commits an attempt BEFORE the caller may perform external work. */
  claim(input: ClaimRequest, authorize: DispatchAuthorizer): EffectClaim | undefined {
    if (this.transaction.depth !== 0) failure('NESTED_DISPATCH', 'A dispatch claim must be committed before returning to its caller.');
    object(input, ['effectId', 'ownerId', 'hostEpoch', 'installationGeneration', 'fencingToken', 'leaseMs'], ['effectId', 'ownerId', 'hostEpoch', 'installationGeneration', 'fencingToken', 'leaseMs'], 'claim');
    string(input.ownerId, 'ownerId'); string(input.hostEpoch, 'hostEpoch'); string(input.installationGeneration, 'installationGeneration');
    integer(input.fencingToken, 'fencingToken', 1); integer(input.leaseMs, 'leaseMs', 1, 300000);
    return this.transaction.atomic(() => {
      const effect = this.required(input.effectId); if (effect.status !== 'pending') return undefined;
      const now = this.now(); this.dispatchable(effect, now); this.authorize(effect, authorize, input);
      this.assertNoOtherUncertainResource(effect);
      if (effect.attempts >= effect.maxAttempts) failure('ATTEMPTS_EXHAUSTED', 'Effect attempt budget is exhausted.');
      if (effect.currentClaim && input.fencingToken <= effect.currentClaim.fencingToken) failure('STALE_FENCE', 'A later attempt requires a greater fencing token.');
      const claim: EffectClaim = { effectId: effect.effectId, attempt: effect.attempts + 1, claimToken: randomUUID(), ownerId: input.ownerId, hostEpoch: input.hostEpoch, installationGeneration: input.installationGeneration, fencingToken: input.fencingToken, claimedAt: now, leaseExpiresAt: new Date(Math.min(Date.parse(now) + input.leaseMs, Date.parse(effect.expiresAt))).toISOString() };
      effect.currentClaim = claim; effect.attempts = claim.attempt; effect.status = 'dispatching'; delete effect.reasonCode;
      this.db.prepare('INSERT INTO shiyu_effect_attempts(effect_id,attempt,claim_token,record_json) VALUES(?,?,?,?)').run(effect.effectId, claim.attempt, claim.claimToken, JSON.stringify({ ...claim, status: 'dispatching' } satisfies EffectAttempt));
      this.save(effect, now); return clone(claim);
    });
  }
  /** Recheck immediately at the actual execution point; never cache its result. */
  assertDispatch(claim: EffectClaim, authorize: DispatchAuthorizer): EffectRecord {
    if (this.transaction.depth !== 0) failure('NESTED_DISPATCH', 'The execution-point authorization check must be outside a business transaction.');
    claim = checkedClaim(claim);
    return this.transaction.atomic(() => {
      const effect = this.required(claim.effectId); this.match(effect, claim);
      const now = this.now();
      if (effect.status !== 'dispatching' || claim.leaseExpiresAt <= now) failure('STALE_FENCE', 'Effect is not currently eligible for dispatch.');
      this.dispatchable(effect, now); this.authorize(effect, authorize, claim); this.assertNoOtherUncertainResource(effect);
      return effect;
    });
  }
  markUnknown(claim: EffectClaim, reasonCode: string): EffectRecord {
    claim = checkedClaim(claim);
    string(reasonCode, 'reasonCode', 100);
    return this.transaction.atomic(() => {
      const effect = this.required(claim.effectId); this.match(effect, claim);
      if (effect.status === 'unknown') return effect;
      if (effect.status !== 'dispatching') failure('INVALID_STATE', 'Only a dispatched Effect may become unknown.');
      const now = this.now(); effect.status = 'unknown'; effect.reasonCode = reasonCode;
      this.saveAttempt(claim, { status: 'unknown', reasonCode });
      return this.save(effect, now);
    });
  }
  /** Recovery classifies uncertainty; it never starts work or changes identity. */
  recover(current: { installationGeneration: string; hostEpoch: string }): EffectRecord[] {
    string(current.installationGeneration, 'installationGeneration'); string(current.hostEpoch, 'hostEpoch');
    return this.transaction.atomic(() => {
      const now = this.now(); const changed: EffectRecord[] = [];
      for (const row of this.db.prepare("SELECT effect_id,status,version,record_json FROM shiyu_effects WHERE status='dispatching' ORDER BY seq").all() as Row[]) {
        const effect = this.read(row)!; const claim = effect.currentClaim;
        if (!claim) failure('CORRUPT_EFFECT', 'Dispatched Effect has no attempt.');
        if (claim!.installationGeneration !== current.installationGeneration || claim!.hostEpoch !== current.hostEpoch || claim!.leaseExpiresAt <= now) {
          effect.status = 'unknown'; effect.reasonCode = claim!.installationGeneration !== current.installationGeneration ? 'installation_changed' : claim!.hostEpoch !== current.hostEpoch ? 'host_changed' : 'lease_expired';
          this.saveAttempt(claim!, { status: 'unknown', reasonCode: effect.reasonCode }); changed.push(this.save(effect, now));
        }
      }
      return changed;
    });
  }
  cancel(effectId: string, expectedVersion: number, reasonCode: string): EffectRecord {
    string(reasonCode, 'reasonCode', 100);
    return this.transaction.atomic(() => {
      const effect = this.required(effectId); this.revision(effect, expectedVersion);
      if (effect.cancelRequestedAt || ['succeeded', 'failed', 'cancelled'].includes(effect.status)) return effect;
      const now = this.now(); effect.cancelRequestedAt = now; effect.cancelReason = reasonCode;
      if (effect.status === 'pending') {
        // Cancelling an unsent retry cannot undo its uncertain original attempt.
        effect.status = this.uncertainAttempt(effect) ? 'unknown' : 'cancelled';
      }
      return this.save(effect, now);
    });
  }
  /** Deliberate retry only. Queue recovery must not call this automatically. */
  retry(effectId: string, expectedVersion: number, reasonCode: string, authorize: DispatchAuthorizer): EffectRecord {
    string(reasonCode, 'reasonCode', 100);
    return this.transaction.atomic(() => {
      const effect = this.required(effectId); this.revision(effect, expectedVersion);
      if (!['failed', 'unknown'].includes(effect.status) || effect.replayClass !== 'idempotent') failure('REPLAY_FORBIDDEN', 'Only a proven idempotent Effect may be explicitly retried.');
      const now = this.now(); this.dispatchable(effect, now); this.authorize(effect, authorize);
      if (effect.attempts >= effect.maxAttempts) failure('ATTEMPTS_EXHAUSTED', 'Effect attempt budget is exhausted.');
      effect.status = 'pending'; effect.reasonCode = reasonCode; delete effect.receiptId;
      return this.save(effect, now);
    });
  }
  complete(claim: EffectClaim, receipt: EffectReceiptInput, verify: ReceiptVerifier): EffectRecord { return this.recordReceipt(claim, receipt, verify, 'completion'); }
  reconcile(claim: EffectClaim, receipt: EffectReceiptInput, verify: ReceiptVerifier): EffectRecord { return this.recordReceipt(claim, receipt, verify, 'reconciliation'); }
  private recordReceipt(claim: EffectClaim, input: EffectReceiptInput, verify: ReceiptVerifier, mode: EffectReceipt['mode']): EffectRecord {
    claim = checkedClaim(claim);
    object(input, ['receiptId', 'serviceId', 'externalOperationId', 'observedAt', 'outcome', 'payloadHash', 'evidenceRefs'], ['receiptId', 'serviceId', 'externalOperationId', 'observedAt', 'outcome', 'payloadHash', 'evidenceRefs'], 'receipt');
    if (!['succeeded', 'failed'].includes(input.outcome)) failure('INVALID_SCHEMA', 'Receipt must report a definite outcome.');
    if (!Array.isArray(input.evidenceRefs) || !input.evidenceRefs.length || input.evidenceRefs.length > 32) failure('INVALID_SCHEMA', 'Verified receipt requires bounded evidence references.');
    const receipt: EffectReceiptInput = { receiptId: string(input.receiptId, 'receiptId'), serviceId: string(input.serviceId, 'serviceId'), externalOperationId: string(input.externalOperationId, 'externalOperationId'), observedAt: timestamp(input.observedAt, 'observedAt'), outcome: input.outcome, payloadHash: hash(input.payloadHash), evidenceRefs: input.evidenceRefs.map(ref => string(ref, 'evidence reference')) };
    return this.transaction.atomic(() => {
      const effect = this.required(claim.effectId); this.match(effect, claim);
      if (receipt.payloadHash !== effect.payloadHash) failure('RECEIPT_MISMATCH', 'Receipt payload does not match the Effect.');
      if (typeof verify !== 'function') failure('UNVERIFIED_RECEIPT', 'A trusted receipt verifier is required.');
      if (isAsyncFunction(verify)) failure('ASYNC_POLICY', 'Receipt verification must be synchronous.');
      const verdict: ReceiptVerdict = synchronous(verify(clone(effect), clone(receipt)));
      if (!verdict || verdict.verified !== true || verdict.serviceId !== receipt.serviceId || verdict.externalOperationId !== receipt.externalOperationId) return failure('UNVERIFIED_RECEIPT', 'Receipt was not verified against the original external operation.');
      if (verdict.installationGeneration !== effect.authorization.installationGeneration) failure('STALE_FENCE', 'Receipt belongs to a previous installation generation.');
      if (typeof verdict.reconciled !== 'boolean' || (mode === 'reconciliation' && verdict.reconciled !== true)) failure('UNVERIFIED_RECEIPT', 'Unknown Effect requires independent reconciliation evidence.');
      if (!verdict.settledEffect) failure('RESULT_UNKNOWN', 'An attempt result cannot settle the whole Effect.');
      if (verdict.settledEffect!.idempotencyKey !== effect.idempotencyKey || verdict.settledEffect!.payloadHash !== effect.payloadHash || verdict.settledEffect!.outcome !== receipt.outcome) failure('UNVERIFIED_RECEIPT', 'Verification does not settle this Effect identity, payload and outcome.');
      const receiptHash = digest({ ...receipt, effectId: effect.effectId, claim, mode });
      const duplicate = this.row('SELECT receipt_hash FROM shiyu_effect_receipts WHERE receipt_id=?', receipt.receiptId);
      if (duplicate) {
        if (duplicate.receipt_hash !== receiptHash) failure('IDEMPOTENCY_CONFLICT', 'Receipt ID already names different evidence.');
        return effect;
      }
      const now = this.now();
      if (mode === 'completion' && (effect.status !== 'dispatching' || claim.leaseExpiresAt <= now)) failure('RESULT_UNKNOWN', 'Late or uncertain completion must use reconciliation.');
      if (mode === 'reconciliation' && effect.status !== 'unknown' && !(effect.status === 'pending' && this.uncertainAttempt(effect))) failure('INVALID_STATE', 'Only an unknown Effect may be reconciled.');
      const record: EffectReceipt = { ...receipt, effectId: effect.effectId, claim: clone(claim), receivedAt: now, mode, verification: {
        verified: true, installationGeneration: verdict.installationGeneration, serviceId: verdict.serviceId,
        externalOperationId: verdict.externalOperationId, reconciled: verdict.reconciled,
        settledEffect: { idempotencyKey: effect.idempotencyKey, payloadHash: effect.payloadHash, outcome: receipt.outcome },
      } };
      this.db.prepare('INSERT INTO shiyu_effect_receipts(receipt_id,effect_id,claim_token,receipt_hash,record_json) VALUES(?,?,?,?,?)').run(receipt.receiptId, effect.effectId, claim.claimToken, receiptHash, JSON.stringify(record));
      effect.status = receipt.outcome; effect.receiptId = receipt.receiptId; delete effect.reasonCode;
      this.saveAttempt(claim, { status: receipt.outcome, endedAt: now });
      return this.save(effect, now);
    });
  }
}
