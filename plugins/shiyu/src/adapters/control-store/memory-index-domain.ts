import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import { EffectLedger, type EffectClaim, type EffectRecord, type DispatchVerdict } from '../../control/effects/index.js';
import type { BudgetReservation, MandateStore, PermitRequest, TrustedPolicyActor } from '../../control/policy/mandates.js';
import { canonicalSemanticMemory, memoryIndexCommandDigest, validateMemoryIndexCommand, validateMemoryIndexObservation, validateSemanticBackendStatus,
  type MemoryIndexCommand, type MemoryIndexObservation, type SemanticBackendStatus } from '../../contracts/semantic-memory.js';
import type { LocalMemoryEntry, MemoryReadToken, MemoryRuntimeIdentity } from './memory-domain.js';
import { createControlAuthority, MEMORY_DISPATCHER, MEMORY_VERIFIER } from './authority.js';
import { SqliteTransactions } from './transaction.js';

export interface MemoryIndexSourcePort {
  /** Trusted same-Worker authority. No backend or asynchronous work in this port. */
  readLocal(input: { operationId: string }): { entry: LocalMemoryEntry; readToken: MemoryReadToken; bodyReceiptId: string };
  get(operationId: string): LocalMemoryEntry;
}
export interface MemoryIndexDomainOptions {
  runtimeIdentity: MemoryRuntimeIdentity; backendId: string; deploymentId: string;
  memory: MemoryIndexSourcePort; now?: () => Date;
}
export interface PrepareMemoryIndex {
  requestId: string; operationId: string;
  /** From a private typed backend status read; never accepted as public caller authority. */
  backendStatus: SemanticBackendStatus; deadlineAtMs: number;
}
export interface MemoryIndexEntry {
  indexOperationId: string; requestId: string; command: MemoryIndexCommand;
  effect: EffectRecord; reservation: BudgetReservation;
  /** Embedding requests are separate from generation token/call accounting. */
  embeddingUsage: { maxEmbeddingCalls: 2; calls: number | null; complete: boolean };
  observation?: MemoryIndexObservation;
  /** Current source eligibility only; this does not publish an inner StateService version. */
  publishable: boolean;
}
export interface MemoryIndexPlan { entry: MemoryIndexEntry; command: MemoryIndexCommand; claim: EffectClaim }
export interface MemoryIndexCoverageState {
  indexedCount: number; staleCount: number; pendingCount: number; unknownCount: number; cancelledCount: number; failedCount: number;
  indexBaselineId: string | null; indexWatermark: number | null; observedAt: string | null;
}
export interface MemoryIndexCommands {
  'memory.index.prepare': { input: PrepareMemoryIndex; output: { duplicate: boolean; entry: MemoryIndexEntry } };
  'memory.index.claim': { input: { indexOperationId: string; leaseMs?: number }; output: MemoryIndexPlan | undefined };
  'memory.index.assertDispatch': { input: { indexOperationId: string; claim: EffectClaim }; output: MemoryIndexPlan };
  'memory.index.recordVerified': { input: { indexOperationId: string; claim: EffectClaim; observation: MemoryIndexObservation }; output: MemoryIndexEntry };
  'memory.index.markUnknown': { input: { indexOperationId: string; claim: EffectClaim; reasonCode: string; observation?: MemoryIndexObservation }; output: MemoryIndexEntry };
  'memory.index.cancel': { input: { indexOperationId: string; reasonCode: string }; output: MemoryIndexEntry };
  'memory.index.get': { input: { indexOperationId: string }; output: MemoryIndexEntry };
  'memory.index.coverage': { input: Record<string, never>; output: MemoryIndexCoverageState };
}
export type MemoryIndexRequest = { [K in keyof MemoryIndexCommands]: { command: K; args: MemoryIndexCommands[K]['input'] } }[keyof MemoryIndexCommands];
interface IndexRecord {
  indexOperationId: string; requestId: string; command: MemoryIndexCommand; readToken: MemoryReadToken;
  effectId: string; mandateId: string; reservationId: string; createdAt: string;
  execution?: MemoryRuntimeIdentity & { fencingToken: number };
  embeddingUsage: MemoryIndexEntry['embeddingUsage']; observation?: MemoryIndexObservation;
}
const OWNER: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const BUDGET = { tokens: 0, calls: 0, effects: 1 };
const TABLES = ['shiyu_memory_index_meta', 'shiyu_memory_index_operations', 'shiyu_memory_index_receipts'];
export class MemoryIndexError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MemoryIndexError'; }
}
const fail = (code: string, message: string): never => { throw new MemoryIndexError(code, message); };
const hash = (value: unknown): string => createHash('sha256').update(canonicalSemanticMemory(value)).digest('hex');
const same = (a: unknown, b: unknown): boolean => canonicalSemanticMemory(a) === canonicalSemanticMemory(b);
function fields(value: unknown, keys: string[], required = keys): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INDEX_INPUT', 'Expected a bounded plain command');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value'))) fail('INVALID_INDEX_INPUT', 'Unknown, accessor or missing index fields');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,149}$/.test(value)) return fail('INVALID_INDEX_INPUT', 'Invalid index identity');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail('INVALID_INDEX_INPUT', 'Invalid bounded index count');
  return Number(value);
}
function synchronous<T>(value: T): T {
  if (isPromise(value)) { void Promise.prototype.then.call(value, undefined, () => undefined); fail('ASYNC_INDEX_SOURCE', 'Source authority must be synchronous'); }
  if (value && typeof (value as { then?: unknown }).then === 'function') fail('ASYNC_INDEX_SOURCE', 'Source authority must be synchronous');
  return value;
}
/** One controlled index effect, with no body/vector storage, backend I/O or replay loop. */
export class MemoryIndexDomain {
  private readonly authority: MandateStore;
  private readonly effects: EffectLedger;
  private readonly identity: MemoryRuntimeIdentity;
  private readonly binding: { backendId: string; deploymentId: string; scope: 'local-owner' };
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: MemoryIndexDomainOptions) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Index authority and effects require the shared connection');
    fields(options.runtimeIdentity, ['hostEpoch', 'installationGeneration']);
    this.identity = { hostEpoch: id(options.runtimeIdentity.hostEpoch), installationGeneration: id(options.runtimeIdentity.installationGeneration) };
    this.binding = { backendId: id(options.backendId), deploymentId: id(options.deploymentId), scope: 'local-owner' };
    if (!options.memory || ['readLocal', 'get'].some(key => typeof options.memory[key as keyof MemoryIndexSourcePort] !== 'function' || isAsyncFunction(options.memory[key as keyof MemoryIndexSourcePort]))) fail('ASYNC_INDEX_SOURCE', 'Index requires the synchronous Memory domain');
    this.authority = createControlAuthority(db, tx, { now: () => this.now() });
    this.effects = new EffectLedger(db, tx, { now: () => this.now() });
    tx.atomic(() => {
      const existing = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'shiyu_memory_index_%'").all();
      if (existing.length && TABLES.some(table => !existing.some(row => row.name === table))) fail('CORRUPT_INDEX_DOMAIN', 'Index control history is incomplete');
      if (!existing.length) {
        if (db.prepare("SELECT id FROM shiyu_mandates WHERE id LIKE 'memory-index-mandate:%' LIMIT 1").get()
          || db.prepare("SELECT effect_id FROM shiyu_effects WHERE json_extract(record_json,'$.action')='memory.index' LIMIT 1").get()) fail('CORRUPT_INDEX_DOMAIN', 'Index authority history cannot be reseeded');
        db.exec(`CREATE TABLE shiyu_memory_index_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,backend_id TEXT NOT NULL,deployment_id TEXT NOT NULL,fence INTEGER NOT NULL);
          CREATE TABLE shiyu_memory_index_operations(index_operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,intent_hash TEXT NOT NULL,effect_id TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL CHECK(json_valid(record_json)));
          CREATE TABLE shiyu_memory_index_receipts(receipt_id TEXT PRIMARY KEY,index_operation_id TEXT NOT NULL,proof_hash TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)));`);
        db.prepare('INSERT INTO shiyu_memory_index_meta VALUES(1,1,?,?,0)').run(this.binding.backendId, this.binding.deploymentId);
      }
      const meta = db.prepare('SELECT * FROM shiyu_memory_index_meta WHERE id=1').get();
      if (!meta || meta.schema_version !== 1 || meta.backend_id !== this.binding.backendId || meta.deployment_id !== this.binding.deploymentId || !Number.isSafeInteger(meta.fence) || Number(meta.fence) < 0) fail('CORRUPT_INDEX_DOMAIN', 'Index deployment metadata is missing or incompatible');
      // Recover only this domain's effects; other domains retain their own budget/recovery hooks.
      for (const row of db.prepare('SELECT index_operation_id FROM shiyu_memory_index_operations').all()) {
        const local = this.local(String(row.index_operation_id)), effect = this.effect(local), claim = effect.currentClaim;
        if (effect.status === 'dispatching' && claim && (claim.hostEpoch !== this.identity.hostEpoch || claim.installationGeneration !== this.identity.installationGeneration || Date.parse(claim.leaseExpiresAt) <= this.now().getTime())) {
          this.effects.markUnknown(claim, 'INDEX_HOST_RECOVERY'); this.hold(local);
        } else if (effect.status === 'unknown') this.hold(local);
      }
    });
  }
  private now(): Date {
    const now = this.options.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) fail('INVALID_INDEX_INPUT', 'Invalid index clock');
    return now;
  }
  private local(indexOperationId: string): IndexRecord {
    this.tx.assertUsable(); const row = this.db.prepare('SELECT * FROM shiyu_memory_index_operations WHERE index_operation_id=?').get(id(indexOperationId));
    if (!row) return fail('UNKNOWN_INDEX_OPERATION', 'No index operation has this identity');
    const value = JSON.parse(String(row.record_json)) as IndexRecord;
    if (value.indexOperationId !== row.index_operation_id || value.requestId !== row.request_id || value.effectId !== row.effect_id
      || value.command.indexOperationId !== value.indexOperationId || !same(validateMemoryIndexCommand(value.command), value.command)
      || value.command.backendId !== this.binding.backendId || value.command.deploymentId !== this.binding.deploymentId || value.command.scope !== this.binding.scope) fail('CORRUPT_INDEX_DOMAIN', 'Index record and projection differ');
    const usage = value.embeddingUsage;
    if (!usage || usage.maxEmbeddingCalls !== 2 || typeof usage.complete !== 'boolean' || (usage.calls !== null && (!Number.isSafeInteger(usage.calls) || usage.calls < 0 || usage.calls > 2))
      || (usage.complete && usage.calls === null)) fail('CORRUPT_INDEX_DOMAIN', 'Index embedding accounting is incomplete');
    if (value.observation) {
      const observed = validateMemoryIndexObservation(value.observation, value.command);
      if (observed.state === 'absent' || observed.embeddingCalls !== usage.calls || observed.usageComplete !== usage.complete) fail('CORRUPT_INDEX_DOMAIN', 'Stored index observation differs from usage');
      if (observed.receipt) {
        const stored = this.db.prepare('SELECT index_operation_id,proof_hash,record_json FROM shiyu_memory_index_receipts WHERE receipt_id=?').get(observed.receipt.receiptId);
        if (!stored || stored.index_operation_id !== value.indexOperationId || stored.proof_hash !== hash(observed.receipt)
          || !same(JSON.parse(String(stored.record_json)), observed.receipt)) fail('CORRUPT_INDEX_DOMAIN', 'Verified index proof is missing or changed');
      }
    }
    return value;
  }
  private save(local: IndexRecord): void { this.db.prepare('UPDATE shiyu_memory_index_operations SET record_json=? WHERE index_operation_id=?').run(JSON.stringify(local), local.indexOperationId); }
  private effect(local: IndexRecord): EffectRecord {
    const effect = this.effects.get(local.effectId);
    if (!effect || effect.action !== 'memory.index' || effect.payloadHash !== memoryIndexCommandDigest(local.command) || effect.authorization.mandateId !== local.mandateId
      || effect.maxAttempts !== 1 || effect.replayClass !== 'reconcilable' || (effect.status === 'succeeded' && local.observation?.state !== 'applied')) return fail('CORRUPT_INDEX_DOMAIN', 'Index effect and its persisted command/proof disagree');
    return effect;
  }
  private source(operationId: string): ReturnType<MemoryIndexSourcePort['readLocal']> {
    const source = synchronous(this.options.memory.readLocal({ operationId }));
    if (!source.entry.reference || source.entry.operation.operationId !== operationId || source.entry.reference.backendId !== this.binding.backendId
      || source.entry.reference.deploymentId !== this.binding.deploymentId || source.entry.reference.scope !== this.binding.scope
      || source.readToken.installationGeneration !== this.identity.installationGeneration || !/^receipt_[a-f0-9]{64}$/.test(source.bodyReceiptId)) fail('INDEX_SOURCE_FORBIDDEN', 'Current verified memory source does not match this index deployment');
    return source;
  }
  private sourceCurrent(local: IndexRecord): boolean {
    try {
      const current = this.source(local.command.memoryOperationId);
      // Fresh readLocal already proves this source is not deleted. Unrelated
      // grants/deletions must not permanently invalidate an established index.
      const stable = ({ authorizationEpoch: _epoch, tombstoneWatermark: _watermark, ...token }: MemoryReadToken) => token;
      return same(stable(current.readToken), stable(local.readToken)) && current.bodyReceiptId === local.command.bodyReceiptId
        && current.entry.command.bodyDigest === local.command.bodyDigest && current.entry.reference!.nativeId === local.command.nativeId
        && current.entry.reference!.componentVersion === local.command.componentVersion;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['MEMORY_READ_FORBIDDEN', 'MEMORY_CONVERSATION_FORBIDDEN', 'UNKNOWN_MEMORY_OPERATION', 'UNKNOWN_CONVERSATION', 'INDEX_SOURCE_FORBIDDEN', 'FORBIDDEN'].includes(String(error.code))) return false;
      throw error;
    }
  }
  private permit(local: IndexRecord): PermitRequest {
    const effect = this.effect(local);
    return { reservationId: local.reservationId, mandateId: local.mandateId, mandateVersion: effect.authorization.mandateVersion,
      authEpoch: effect.authorization.authEpoch, scope: this.binding.scope, action: 'memory.index', resourceScopes: effect.resourceScopes };
  }
  private authorize(local: IndexRecord): DispatchVerdict {
    if (!local.execution || local.execution.hostEpoch !== this.identity.hostEpoch || local.execution.installationGeneration !== this.identity.installationGeneration) return fail('STALE_INDEX_EXECUTION', 'Index belongs to another execution generation');
    if (!this.sourceCurrent(local)) fail('INDEX_SOURCE_FORBIDDEN', 'Source consent, body proof or audience changed');
    if (local.command.deadlineAtMs <= this.now().getTime()) fail('INDEX_EXPIRED', 'Index deadline has passed');
    this.authority.assertPermit(MEMORY_DISPATCHER, this.permit(local));
    const effect = this.effect(local);
    return { allowed: true, ...effect.authorization, ...this.identity, fencingToken: local.execution.fencingToken,
      ...(effect.origin.kind === 'dialogue' ? { conversationGeneration: effect.origin.conversationGeneration } : {}) };
  }
  prepare(input: PrepareMemoryIndex): { duplicate: boolean; entry: MemoryIndexEntry } {
    fields(input, ['requestId', 'operationId', 'backendStatus', 'deadlineAtMs']);
    const requestId = id(input.requestId), operationId = id(input.operationId), status = validateSemanticBackendStatus(input.backendStatus, this.binding);
    const intent = { requestId, operationId, ...this.binding, profileFingerprint: status.profileFingerprint, indexBaselineId: status.indexBaselineId };
    return this.tx.atomic(() => {
      const existing = this.db.prepare('SELECT index_operation_id,intent_hash FROM shiyu_memory_index_operations WHERE request_id=?').get(requestId);
      if (existing) {
        if (existing.intent_hash !== hash(intent)) fail('IDEMPOTENCY_CONFLICT', 'Index request identity names another source or deployment');
        return { duplicate: true, entry: this.get(String(existing.index_operation_id)) };
      }
      const now = this.now(), deadlineAtMs = integer(input.deadlineAtMs, now.getTime() + 1, now.getTime() + status.limits.maxDeadlineMs);
      const source = this.source(operationId), indexOperationId = randomUUID(), expiresAt = new Date(deadlineAtMs).toISOString();
      const command = validateMemoryIndexCommand({ schemaVersion: 1, kind: 'ensure-index', indexOperationId, memoryOperationId: operationId, bodyReceiptId: source.bodyReceiptId,
        ...this.binding, nativeId: source.entry.reference!.nativeId, componentVersion: source.entry.reference!.componentVersion, bodyDigest: source.entry.command.bodyDigest,
        profileFingerprint: status.profileFingerprint, indexBaselineId: status.indexBaselineId, expectedIndexWatermark: status.indexWatermark, deadlineAtMs, maxEmbeddingCalls: 2 });
      const mandateId = `memory-index-mandate:${indexOperationId}`, reservationId = `memory-index-reservation:${indexOperationId}`, effectId = `memory-index-effect:${indexOperationId}`;
      const resource = `memory-index:${hash({ ...this.binding, nativeId: command.nativeId, profileFingerprint: command.profileFingerprint, indexBaselineId: command.indexBaselineId })}`;
      const grant = this.authority.grant(OWNER, { id: mandateId, scope: this.binding.scope, subjectIds: [MEMORY_DISPATCHER.principalId], allowedActions: ['memory.index'],
        allowedResources: [resource], limits: BUDGET, basisRef: `owner-memory-index:${requestId}`, expiresAt });
      this.authority.reserve(MEMORY_DISPATCHER, { reservationId, mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, scope: this.binding.scope,
        action: 'memory.index', resourceScopes: [resource], amount: BUDGET, leaseMs: deadlineAtMs - now.getTime() });
      this.effects.enqueue({ effectId, idempotencyKey: `memory-index:${indexOperationId}`, origin: source.entry.operation.origin, action: 'memory.index', resourceScopes: [resource],
        payloadRef: `memory-index-command:${indexOperationId}`, payloadHash: memoryIndexCommandDigest(command), replayClass: 'reconcilable', maxAttempts: 1,
        authorization: { mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, installationGeneration: this.identity.installationGeneration }, expiresAt });
      const local: IndexRecord = { indexOperationId, requestId, command, readToken: this.source(operationId).readToken, effectId, mandateId, reservationId,
        createdAt: now.toISOString(), embeddingUsage: { maxEmbeddingCalls: 2, calls: null, complete: false } };
      this.db.prepare('INSERT INTO shiyu_memory_index_operations VALUES(?,?,?,?,?)').run(indexOperationId, requestId, hash(intent), effectId, JSON.stringify(local));
      return { duplicate: false, entry: this.get(indexOperationId) };
    });
  }
  claim(input: MemoryIndexCommands['memory.index.claim']['input']): MemoryIndexPlan | undefined {
    fields(input, ['indexOperationId', 'leaseMs'], ['indexOperationId']);
    const leaseMs = integer(input.leaseMs ?? 30000, 1, 60000);
    if (this.tx.depth) fail('NESTED_DISPATCH', 'Index claim must commit before dispatch');
    const local = this.tx.atomic(() => {
      const local = this.local(input.indexOperationId); if (this.effect(local).status !== 'pending') return undefined;
      const meta = this.db.prepare('SELECT fence FROM shiyu_memory_index_meta WHERE id=1').get();
      const fence = integer(Number(meta?.fence) + 1, 1, Number.MAX_SAFE_INTEGER);
      local.execution = { ...this.identity, fencingToken: fence };
      this.db.prepare('UPDATE shiyu_memory_index_meta SET fence=? WHERE id=1').run(fence); this.save(local); this.authorize(local); return local;
    });
    if (!local) return undefined;
    const claim = this.effects.claim({ effectId: local.effectId, ownerId: MEMORY_DISPATCHER.principalId, ...this.identity, fencingToken: local.execution!.fencingToken, leaseMs }, () => this.authorize(this.local(local.indexOperationId)));
    return claim ? { entry: this.get(local.indexOperationId), command: structuredClone(local.command), claim } : undefined;
  }
  assertDispatch(input: MemoryIndexCommands['memory.index.assertDispatch']['input']): MemoryIndexPlan {
    fields(input, ['indexOperationId', 'claim']); const local = this.local(input.indexOperationId);
    if (input.claim.effectId !== local.effectId) fail('INDEX_CLAIM_MISMATCH', 'Index claim belongs to another operation');
    this.effects.assertDispatch(input.claim, () => this.authorize(this.local(local.indexOperationId)));
    return { entry: this.get(local.indexOperationId), command: structuredClone(local.command), claim: structuredClone(input.claim) };
  }
  private hold(local: IndexRecord): void {
    const reservation = this.authority.getReservation(OWNER, local.reservationId);
    if (reservation.state === 'reserved') this.authority.reconcile(MEMORY_VERIFIER, { receiptId: `memory-index-unknown:${local.indexOperationId}`, reservationId: local.reservationId,
      expectedVersion: reservation.version, complete: false, usage: { tokens: 0, calls: 0 }, evidenceRef: `memory-index:${local.indexOperationId}` });
  }
  markUnknown(input: MemoryIndexCommands['memory.index.markUnknown']['input']): MemoryIndexEntry {
    fields(input, ['indexOperationId', 'claim', 'reasonCode', 'observation'], ['indexOperationId', 'claim', 'reasonCode']); id(input.reasonCode);
    return this.tx.atomic(() => {
      const local = this.local(input.indexOperationId);
      if (input.claim.effectId !== local.effectId) fail('INDEX_CLAIM_MISMATCH', 'Index claim belongs to another operation');
      if (input.observation) {
        const observation = validateMemoryIndexObservation(input.observation, local.command);
        if (observation.state !== 'unknown') fail('INDEX_OBSERVATION_UNSETTLED', 'Unknown recording requires an unknown independent status');
        if (observation.usageComplete && observation.embeddingCalls === null) fail('INDEX_USAGE_UNKNOWN', 'Complete usage must include its observed embedding count');
        if (local.embeddingUsage.calls !== null && (observation.embeddingCalls ?? 0) < local.embeddingUsage.calls) fail('INDEX_USAGE_REGRESSION', 'Known embedding usage cannot decrease');
        if (local.embeddingUsage.complete && !observation.usageComplete) fail('INDEX_USAGE_REGRESSION', 'Complete embedding usage cannot become unknown');
        local.embeddingUsage = { maxEmbeddingCalls: 2, calls: observation.embeddingCalls, complete: observation.usageComplete }; local.observation = observation; this.save(local);
      }
      this.effects.markUnknown(input.claim, input.reasonCode); this.hold(local); return this.get(local.indexOperationId);
    });
  }
  cancel(input: MemoryIndexCommands['memory.index.cancel']['input']): MemoryIndexEntry {
    fields(input, ['indexOperationId', 'reasonCode']); id(input.reasonCode);
    return this.tx.atomic(() => {
      const local = this.local(input.indexOperationId), current = this.effect(local);
      const effect = this.effects.cancel(current.effectId, current.version, input.reasonCode);
      if (effect.status === 'cancelled') {
        const reservation = this.authority.getReservation(OWNER, local.reservationId);
        if (reservation.state !== 'settled') this.authority.reconcile(MEMORY_VERIFIER, { receiptId: `memory-index-unused:${local.indexOperationId}`, reservationId: local.reservationId,
          expectedVersion: reservation.version, complete: true, usage: { tokens: 0, calls: 0, effects: 0 }, evidenceRef: `memory-index-cancelled:${local.indexOperationId}` });
        local.embeddingUsage = { maxEmbeddingCalls: 2, calls: 0, complete: true }; this.save(local);
      } else if (effect.status === 'dispatching' || effect.status === 'unknown') {
        if (effect.status === 'dispatching') this.effects.markUnknown(effect.currentClaim!, input.reasonCode);
        this.hold(local);
      }
      return this.get(local.indexOperationId);
    });
  }
  /** Accept only independently queried full index proof. The create response alone is not this authority. */
  recordVerified(input: MemoryIndexCommands['memory.index.recordVerified']['input']): MemoryIndexEntry {
    fields(input, ['indexOperationId', 'claim', 'observation']);
    return this.tx.atomic(() => {
      const local = this.local(input.indexOperationId), observation = validateMemoryIndexObservation(input.observation, local.command);
      if (input.claim.effectId !== local.effectId) fail('INDEX_CLAIM_MISMATCH', 'Index claim belongs to another operation');
      if (observation.state !== 'applied' || !observation.receipt || !observation.usageComplete || observation.embeddingCalls === null) return fail('INDEX_OBSERVATION_UNSETTLED', 'Index requires an independently verified applied receipt and complete usage');
      const receipt = observation.receipt, proofHash = hash(receipt);
      const previous = this.db.prepare('SELECT proof_hash FROM shiyu_memory_index_receipts WHERE receipt_id=?').get(receipt.receiptId);
      if (previous && previous.proof_hash !== proofHash) fail('IDEMPOTENCY_CONFLICT', 'Index receipt names different full proof');
      if (local.embeddingUsage.calls !== null && observation.embeddingCalls < local.embeddingUsage.calls) fail('INDEX_USAGE_REGRESSION', 'Verified usage cannot erase observed calls');
      let effect = this.effect(local);
      if (effect.status === 'dispatching' && (Date.parse(input.claim.leaseExpiresAt) <= this.now().getTime() || input.claim.hostEpoch !== this.identity.hostEpoch || input.claim.installationGeneration !== this.identity.installationGeneration)) effect = this.effects.markUnknown(input.claim, 'INDEX_LATE_OBSERVATION');
      const existing = this.effects.receipts(effect.effectId).find(item => item.receiptId === receipt.receiptId);
      const reconcile = existing ? existing.mode === 'reconciliation' : effect.status === 'unknown';
      const proof = { receiptId: receipt.receiptId, serviceId: this.binding.backendId, externalOperationId: local.indexOperationId, observedAt: receipt.observedAt,
        outcome: 'succeeded' as const, payloadHash: memoryIndexCommandDigest(local.command), evidenceRefs: [`index-proof:${proofHash}`] };
      const verify = () => ({ verified: true as const, installationGeneration: effect.authorization.installationGeneration, serviceId: this.binding.backendId,
        externalOperationId: local.indexOperationId, reconciled: true, settledEffect: { idempotencyKey: effect.idempotencyKey, payloadHash: effect.payloadHash, outcome: 'succeeded' as const } });
      if (reconcile) this.effects.reconcile(input.claim, proof, verify); else this.effects.complete(input.claim, proof, verify);
      const reservation = this.authority.getReservation(OWNER, local.reservationId);
      if (reservation.state !== 'settled') this.authority.reconcile(MEMORY_VERIFIER, { receiptId: `memory-index-usage:${receipt.receiptId}`, reservationId: local.reservationId,
        expectedVersion: reservation.version, complete: true, usage: BUDGET, evidenceRef: `index-proof:${proofHash}` });
      else if (!same(reservation.observed, BUDGET)) fail('INDEX_USAGE_CONFLICT', 'Settled generation/effect accounting differs from index proof');
      local.embeddingUsage = { maxEmbeddingCalls: 2, calls: observation.embeddingCalls, complete: true };
      // Re-observation may advance the backend's current watermark, not rewrite a receipt's original proof.
      if (!previous) {
        this.db.prepare('INSERT INTO shiyu_memory_index_receipts VALUES(?,?,?,?)').run(receipt.receiptId, local.indexOperationId, proofHash, JSON.stringify(receipt));
        local.observation = observation; this.save(local);
      }
      return this.get(local.indexOperationId);
    });
  }
  get(indexOperationId: string): MemoryIndexEntry {
    return this.tx.atomic(() => {
      const local = this.local(indexOperationId), effect = this.effect(local);
      return { indexOperationId: local.indexOperationId, requestId: local.requestId, command: structuredClone(local.command), effect,
        reservation: this.authority.getReservation(OWNER, local.reservationId), embeddingUsage: structuredClone(local.embeddingUsage),
        ...(local.observation ? { observation: structuredClone(local.observation) } : {}), publishable: effect.status === 'succeeded' && !effect.cancelRequestedAt && local.embeddingUsage.complete && this.sourceCurrent(local) };
    });
  }
  /**
   * Read-only index coverage reconciliation. It never dispatches, retries or
   * mutates: applied entries whose source is no longer current count as stale,
   * and pending/unknown work is reported as unsettled rather than success.
   */
  coverage(): MemoryIndexCoverageState {
    return this.tx.atomic(() => {
      const rows = this.db.prepare('SELECT index_operation_id FROM shiyu_memory_index_operations ORDER BY rowid').all() as { index_operation_id: string }[];
      let indexedCount = 0, staleCount = 0, pendingCount = 0, unknownCount = 0, cancelledCount = 0, failedCount = 0;
      let indexBaselineId: string | null = null, indexWatermark: number | null = null, observedAt: string | null = null;
      for (const row of rows) {
        const local = this.local(String(row.index_operation_id)), status = this.effect(local).status;
        if (status === 'succeeded' && local.observation?.state === 'applied') {
          if (this.sourceCurrent(local)) indexedCount++; else staleCount++;
        } else if (status === 'pending' || status === 'dispatching') pendingCount++;
        else if (status === 'unknown') unknownCount++;
        else if (status === 'cancelled') cancelledCount++;
        else if (status === 'failed') failedCount++;
        if (local.observation && local.observation.state !== 'absent') {
          const baseline = local.observation.currentIndexBaselineId, watermark = local.observation.currentIndexWatermark;
          if (indexWatermark === null || watermark > indexWatermark) { indexWatermark = watermark; indexBaselineId = baseline; observedAt = local.observation.receipt?.observedAt ?? null; }
        }
      }
      return { indexedCount, staleCount, pendingCount, unknownCount, cancelledCount, failedCount, indexBaselineId, indexWatermark, observedAt };
    });
  }
  execute(request: MemoryIndexRequest): MemoryIndexCommands[keyof MemoryIndexCommands]['output'] {
    switch (request.command) {
      case 'memory.index.prepare': return this.prepare(request.args);
      case 'memory.index.claim': return this.claim(request.args);
      case 'memory.index.assertDispatch': return this.assertDispatch(request.args);
      case 'memory.index.recordVerified': return this.recordVerified(request.args);
      case 'memory.index.markUnknown': return this.markUnknown(request.args);
      case 'memory.index.cancel': return this.cancel(request.args);
      case 'memory.index.get': fields(request.args, ['indexOperationId']); return this.get(request.args.indexOperationId);
      case 'memory.index.coverage': fields(request.args, []); return this.coverage();
      default: return fail('UNKNOWN_INDEX_COMMAND', 'Unknown index control command');
    }
  }
}
