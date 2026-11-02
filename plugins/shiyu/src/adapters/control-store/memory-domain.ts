import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import { canonicalMemoryCommand, memoryCommandDigest, validateMemoryCreateCommand, MAX_MEMORY_BODY_BYTES } from '../../contracts/memory.js';
import type { MemoryBackendObservation, MemoryCreateCommand } from '../../contracts/memory.js';
import type { ConversationRecord } from '../../control/conversations/index.js';
import { EffectLedger, type EffectClaim, type EffectAuthorization } from '../../control/effects/index.js';
import { MemoryOperationLedger, memoryResource, type MemoryOperation, type MemoryDispatchVerdict, type MemoryReceiptVerifier } from '../../control/memory/index.js';
import type { BudgetReservation, MandateStore, PermitRequest, TrustedPolicyActor } from '../../control/policy/mandates.js';
import { createControlAuthority, MEMORY_DISPATCHER, MEMORY_VERIFIER } from './authority.js';
import { SqliteTransactions } from './transaction.js';

export type { MemoryCreateCommand, MemoryBackendObservation } from '../../contracts/memory.js';
export interface MemoryRuntimeIdentity { installationGeneration: string; hostEpoch: string }
export interface PrepareLocalMemory { requestId: string; conversationId: string; bodyDigest: string; bytes: number; sourceId?: string }
export interface LocalMemorySource {
  sourceId: string; revision: number; conversationId: string; scope: 'local-owner';
  bodyDigest: string; bodyBytes: number; audienceVersion: number;
  consent: { kind: 'explicit-owner-save'; basisRef: string; state: 'active' | 'withdrawn'; grantedAt: string; withdrawnAt?: string; forgottenAt?: string };
}
export interface LocalMemoryEntry {
  requestId: string; conversationId: string; source: LocalMemorySource;
  operation: MemoryOperation; command: MemoryCreateCommand;
  reservation: BudgetReservation;
  /** Current local read qualification; backend get must independently verify content. */
  reference?: { backendId: string; deploymentId: string; scope: 'local-owner'; nativeId: string; componentVersion: string; targetRef: string; sourceId: string };
  canPublish: boolean;
}
export interface PreparedLocalMemory extends LocalMemoryEntry { duplicate: boolean }
export const MAX_MEMORY_VIEW_CANDIDATES = 200;
export interface MemoryViewAuthority {
  backendId: string; deploymentId: string; installationGeneration: string; authorizationEpoch: number;
  deletionBaselineId: string; deletionScope: 'local-memory-source'; tombstoneWatermark: number; installedAt: string;
}
/** Per-record authorization metadata, never a backend body or similarity-derived grant. */
export interface MemoryViewSource {
  operationId: string; operationVersion: number; sourceId: string; sourceRevision: number; conversationId: string;
  targetRef: string; nativeId: string; componentVersion: string; command: MemoryCreateCommand; commandDigest: string; readToken: MemoryReadToken;
}
export interface MemoryViewSnapshot {
  schemaVersion: 1; conversationId: string; authority: MemoryViewAuthority; sources: MemoryViewSource[];
  /** Fixed selection/security identity. Does not change when an unrelated candidate is published. */
  snapshotHash: string;
  /** Observed bounded eligible pool only; not a backend revision, CAS or read permission. */
  collectionHash: string; truncated: boolean;
}
export interface MemoryContextInvalidation {
  conversationIds: string[];
  retiredSessions: { bindingId: string; sessionEpoch: number; sessionId?: string; businessId: string }[];
}
export interface WithdrawLocalMemoryResult extends LocalMemoryEntry {
  /** Best-effort wakeup/cancellation routing. Durable Conversation fences are authoritative. */
  contextInvalidation?: MemoryContextInvalidation;
}
/** A short-lived comparison vector, not authority that may be cached or reused. */
export interface MemoryReadToken {
  operationId: string; operationVersion: number; sourceId: string; sourceRevision: number; audienceVersion: number;
  authorizationEpoch: number; saveMandateVersion: number; deletionBaselineId: string; tombstoneWatermark: number;
  installationGeneration: string; backendId: string; deploymentId: string; nativeId: string; componentVersion: string;
}
export interface MemoryDispatchPlan { operation: MemoryOperation; command: MemoryCreateCommand; commandDigest: string; claim: EffectClaim }
export interface MemoryVerifiedReceiptInput {
  operationId: string; claim: EffectClaim; observation: MemoryBackendObservation; reconciliation: boolean;
}
/** Explicit logical lifecycle policy; no silent expiry and no second body authority. */
export const MEMORY_LIFECYCLE_POLICY_V1 = Object.freeze({
  schemaVersion: 1 as const, policyVersion: 1 as const, retentionMode: 'owner-controlled' as const,
  automaticExpiry: false as const, physicalErase: false as const, forgetMode: 'logical-tombstone' as const,
});
export interface MemoryLifecycle {
  schemaVersion: 1; policy: typeof MEMORY_LIFECYCLE_POLICY_V1;
  operationId: string; sourceId: string; conversationId: string; savedAt: string;
  consentState: 'active' | 'withdrawn'; withdrawnAt?: string; forgottenAt?: string;
  retention: { retained: boolean; mode: 'owner-controlled'; automaticExpiry: false; physicalErase: false; reasonCode: string };
  backendStatus: string; bodyReferencePresent: boolean; canPublish: boolean; deletionWatermark: number;
}
export interface MemoryCommands {
  'memory.prepareLocal': { input: PrepareLocalMemory; output: PreparedLocalMemory };
  'memory.claim': { input: { operationId: string; leaseMs?: number }; output: MemoryDispatchPlan | undefined };
  'memory.assertDispatch': { input: { operationId: string; claim: EffectClaim }; output: MemoryDispatchPlan };
  'memory.recordVerifiedReceipt': { input: MemoryVerifiedReceiptInput; output: LocalMemoryEntry };
  'memory.markUnknown': { input: { operationId: string; claim: EffectClaim; reasonCode: string }; output: LocalMemoryEntry };
  'memory.withdrawLocal': { input: { requestId: string; operationId: string }; output: WithdrawLocalMemoryResult };
  'memory.forgetLocal': { input: { requestId: string; operationId: string }; output: WithdrawLocalMemoryResult };
  'memory.lifecycle': { input: { operationId: string }; output: MemoryLifecycle };
  'memory.publishLocal': { input: { operationId: string; expectedVersion: number; receiptId: string }; output: LocalMemoryEntry };
  'memory.get': { input: { operationId: string }; output: LocalMemoryEntry };
  'memory.readLocal': { input: { operationId: string }; output: { entry: LocalMemoryEntry; readToken: MemoryReadToken; bodyReceiptId: string } };
  'memory.list': { input: { conversationId?: string }; output: LocalMemoryEntry[] };
  'memory.listEligibleForView': { input: { conversationId: string }; output: MemoryViewSnapshot };
  'memory.captureForView': { input: { conversationId: string; operationIds?: readonly string[] }; output: MemoryViewSnapshot };
  'memory.validateForView': { input: { snapshot: MemoryViewSnapshot }; output: MemoryViewSnapshot };
  'memory.validateExposedSources': { input: { sources: readonly MemoryViewSource[] }; output: { valid: true } };
}
export type MemoryDomainRequest = { [K in keyof MemoryCommands]: { command: K; args: MemoryCommands[K]['input'] } }[keyof MemoryCommands];
export interface MemoryDomainOptions {
  runtimeIdentity: MemoryRuntimeIdentity; backendId: string; deploymentId: string;
  /** Same-Worker read from the existing Conversation domain, including local binding ownership. */
  getConversation(conversationId: string): ConversationRecord;
  /** Same-transaction durable context retirement only. Never Session/model/backend I/O. */
  onWithdrawSources?(input: { withdrawalId: string; sourceIds: readonly string[] }): MemoryContextInvalidation | void;
  now?: () => Date;
}
interface LocalOperation {
  requestId: string; operationId: string; conversationId: string; sourceId: string;
  command: MemoryCreateCommand; mandateId: string; reservationId: string; createdAt: string;
  execution?: MemoryRuntimeIdentity & { fencingToken: number };
}
type Row = Record<string, unknown>;
const SCOPE = 'local-owner';
const OWNER: TrustedPolicyActor = { principalId: SCOPE, kind: 'owner', scopes: [SCOPE] };
const GRANT_MS = 600000;
const BUDGET = { tokens: 0, calls: 0, effects: 1 };
export class MemoryDomainError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MemoryDomainError'; }
}
const fail = (code: string, message: string): never => { throw new MemoryDomainError(code, message); };
const clone = <T>(value: T): T => structuredClone(value);
function fields(value: unknown, allowed: string[], required = allowed): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_MEMORY_INPUT', 'Expected a plain memory command');
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(properties).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(properties, key)) || Object.values(properties).some(property => !Object.hasOwn(property, 'value'))) fail('INVALID_MEMORY_INPUT', 'Unknown, accessor or missing memory fields');
}
function id(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,199}$/.test(value)) fail('INVALID_MEMORY_INPUT', `Invalid ${field}`);
  return value as string;
}
function integer(value: unknown, field: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail('INVALID_MEMORY_INPUT', `Invalid ${field}`);
  return Number(value);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID_MEMORY_INPUT', 'Invalid SHA256 digest');
  return value as string;
}
function time(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_MEMORY_INPUT', 'Time must be canonical UTC');
  return value as string;
}
function canonical(value: unknown): string { return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item); }
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/**
 * Explicit local-owner save authority, not Session history or another memory
 * content store. No method performs backend/model I/O or accepts a public actor.
 * recordVerifiedReceipt is an internal Worker command; only a trusted private
 * adapter may construct its observation after independent status + get checks.
 */
export class MemoryDomain {
  private readonly ledger: MemoryOperationLedger;
  private readonly effects: EffectLedger;
  private readonly mandates: MandateStore;
  private readonly identity: MemoryRuntimeIdentity;
  private readonly backendId: string;
  private readonly deploymentId: string;
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: MemoryDomainOptions) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Memory domain must share the control connection');
    if (typeof options.getConversation !== 'function' || isAsyncFunction(options.getConversation)) fail('INVALID_MEMORY_CONFIGURATION', 'Conversation authority must be a synchronous existing-domain read');
    if (options.onWithdrawSources !== undefined && (typeof options.onWithdrawSources !== 'function' || isAsyncFunction(options.onWithdrawSources))) fail('INVALID_MEMORY_CONFIGURATION', 'Context retirement must be a synchronous same-transaction hook');
    fields(options.runtimeIdentity, ['hostEpoch', 'installationGeneration']);
    this.identity = { hostEpoch: id(options.runtimeIdentity.hostEpoch, 'hostEpoch'), installationGeneration: id(options.runtimeIdentity.installationGeneration, 'installationGeneration') };
    this.backendId = id(options.backendId, 'backendId'); this.deploymentId = id(options.deploymentId, 'deploymentId');
    this.mandates = createControlAuthority(db, tx, { now: () => new Date(this.now()) });
    this.ledger = new MemoryOperationLedger(db, tx, { backendIds: [this.backendId], approverIds: [OWNER.principalId], dispatcherIds: [MEMORY_DISPATCHER.principalId], verifierIds: [MEMORY_VERIFIER.principalId], eraserIds: [OWNER.principalId], now: () => new Date(this.now()) });
    this.effects = new EffectLedger(db, tx, { now: () => new Date(this.now()) });
    tx.atomic(() => {
      const tables = ['shiyu_local_memory_meta', 'shiyu_local_memory_sources', 'shiyu_local_memory_operations', 'shiyu_local_memory_withdrawals'];
      const existing = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'shiyu_local_memory_%'").all() as Row[]).map(row => String(row.name)));
      if (existing.size && tables.some(table => !existing.has(table))) fail('CORRUPT_MEMORY_DOMAIN', 'Local memory metadata is incomplete');
      if (!existing.size) {
        if (db.prepare("SELECT id FROM shiyu_mandates WHERE id LIKE 'memory-mandate:%' LIMIT 1").get()
          || db.prepare("SELECT operation_id FROM shiyu_memory_operations WHERE json_extract(record_json,'$.input.proposalId') LIKE 'memory-proposal:%' LIMIT 1").get()) fail('CORRUPT_MEMORY_DOMAIN', 'Local memory consent authority is absent but its operation history remains');
        db.exec(`CREATE TABLE shiyu_local_memory_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,backend_id TEXT NOT NULL,deployment_id TEXT NOT NULL,fence INTEGER NOT NULL);
          CREATE TABLE shiyu_local_memory_sources(source_id TEXT PRIMARY KEY,record_json TEXT NOT NULL CHECK(json_valid(record_json)));
          CREATE TABLE shiyu_local_memory_operations(operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,conversation_id TEXT NOT NULL,source_id TEXT NOT NULL UNIQUE REFERENCES shiyu_local_memory_sources(source_id),record_json TEXT NOT NULL CHECK(json_valid(record_json)));
          CREATE TABLE shiyu_local_memory_withdrawals(request_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES shiyu_local_memory_operations(operation_id),intent_hash TEXT NOT NULL);
          CREATE INDEX shiyu_local_memory_conversation ON shiyu_local_memory_operations(conversation_id);`);
        db.prepare('INSERT INTO shiyu_local_memory_meta VALUES(1,1,?,?,0)').run(this.backendId, this.deploymentId);
      }
      const metadata = this.row('SELECT * FROM shiyu_local_memory_meta WHERE id=1');
      if (!metadata || metadata.schema_version !== 1 || metadata.backend_id !== this.backendId || metadata.deployment_id !== this.deploymentId) fail('MEMORY_DEPLOYMENT_MISMATCH', 'Local memory deployment binding needs explicit recovery or migration');
      for (const operation of this.ledger.recover(MEMORY_DISPATCHER, this.identity)) {
        if (this.row('SELECT operation_id FROM shiyu_local_memory_operations WHERE operation_id=?', operation.operationId)) this.unknownBudget(this.local(operation.operationId));
      }
    });
  }
  private now(): string { return time((this.options.now?.() ?? new Date()).toISOString()); }
  private row(sql: string, ...values: SQLInputValue[]): Row | undefined { this.tx.assertUsable(); return this.db.prepare(sql).get(...values) as Row | undefined; }
  private local(operationId: string): LocalOperation {
    const row = this.row('SELECT record_json FROM shiyu_local_memory_operations WHERE operation_id=?', id(operationId, 'operationId', 150));
    if (!row) fail('UNKNOWN_MEMORY_OPERATION', 'No local-owner memory operation has this identity');
    return JSON.parse(String(row!.record_json)) as LocalOperation;
  }
  private source(sourceId: string): LocalMemorySource {
    const row = this.row('SELECT record_json FROM shiyu_local_memory_sources WHERE source_id=?', sourceId);
    if (!row) fail('CORRUPT_MEMORY_DOMAIN', 'The memory source and saving consent are missing');
    return JSON.parse(String(row!.record_json)) as LocalMemorySource;
  }
  private operation(local: LocalOperation): MemoryOperation { return this.ledger.get(local.operationId) ?? fail('CORRUPT_MEMORY_DOMAIN', 'The approved memory operation is missing'); }
  private conversation(conversationId: string): ConversationRecord {
    id(conversationId, 'conversationId'); const result = this.options.getConversation(conversationId);
    if (isPromise(result)) { void Promise.prototype.then.call(result, undefined, () => undefined); fail('INVALID_MEMORY_CONFIGURATION', 'Conversation read returned a Promise'); }
    if (result && typeof (result as unknown as { then?: unknown }).then === 'function') fail('INVALID_MEMORY_CONFIGURATION', 'Conversation read returned a thenable');
    if (!result || result.conversationId !== conversationId || result.key?.scope !== SCOPE || result.key.connectionId !== 'local-synthetic' || result.key.kind !== 'direct' || result.archived !== false) fail('MEMORY_CONVERSATION_FORBIDDEN', 'Memory saving requires an existing active local-owner conversation');
    integer(result.audienceVersion, 'audienceVersion'); integer(result.conversationGeneration, 'conversationGeneration');
    return clone(result);
  }
  private sourceAllowed(local: LocalOperation, checkGeneration: boolean): boolean {
    const source = this.source(local.sourceId), operation = this.operation(local), conversation = this.conversation(local.conversationId);
    return source.scope === SCOPE && source.conversationId === local.conversationId && source.consent.kind === 'explicit-owner-save' && source.consent.state === 'active'
      && operation.mandateRef.installationGeneration === this.identity.installationGeneration
      && source.revision === local.command.sourceRefs[0]!.revision && source.bodyDigest === local.command.bodyDigest && source.bodyBytes === local.command.bodyBytes
      && source.audienceVersion === conversation.audienceVersion && operation.origin.kind === 'dialogue' && (!checkGeneration || operation.origin.conversationGeneration === conversation.conversationGeneration);
  }
  private permit(local: LocalOperation): PermitRequest {
    const operation = this.operation(local);
    return { reservationId: local.reservationId, mandateId: local.mandateId, mandateVersion: operation.mandateRef.mandateVersion, authEpoch: operation.mandateRef.authEpoch, scope: SCOPE, action: 'memory.write', resourceScopes: [memoryResource(SCOPE, this.backendId, local.command.targetRef)] };
  }
  private authorization(local: LocalOperation): EffectAuthorization {
    const grant = this.mandates.get(OWNER, local.mandateId);
    return { mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, installationGeneration: this.identity.installationGeneration };
  }
  private publicationAllowed(local: LocalOperation): boolean {
    try {
      const operation = this.operation(local), grant = this.mandates.get(OWNER, local.mandateId);
      return !operation.blocked && !this.mandates.health().frozen && this.sourceAllowed(local, true) && grant.state === 'active'
        && grant.version === operation.mandateRef.mandateVersion && grant.authEpoch === operation.mandateRef.authEpoch
        && operation.mandateRef.installationGeneration === this.identity.installationGeneration && grant.allowedActions.includes('memory.write')
        && grant.allowedResources.includes(memoryResource(SCOPE, this.backendId, local.command.targetRef)) && this.now() >= grant.validFrom && this.now() < grant.expiresAt;
    } catch (error) {
      // Missing/foreign/archived conversation is a read denial. Corrupt authority
      // or ledger is not a normal false answer and must stop the control path.
      if (error && typeof error === 'object' && 'code' in error && ['NOT_FOUND', 'UNKNOWN_CONVERSATION', 'MEMORY_CONVERSATION_FORBIDDEN', 'FORBIDDEN'].includes(String(error.code))) return false;
      throw error;
    }
  }
  private authorize(local: LocalOperation): MemoryDispatchVerdict {
    const operation = this.operation(local); const execution = local.execution;
    if (!execution || execution.hostEpoch !== this.identity.hostEpoch || execution.installationGeneration !== this.identity.installationGeneration) fail('STALE_MEMORY_EXECUTION', 'Memory execution belongs to another host generation');
    if (!this.sourceAllowed(local, true)) fail('MEMORY_CONSENT_WITHDRAWN', 'Saving consent, source revision or conversation changed');
    this.mandates.assertPermit(MEMORY_DISPATCHER, this.permit(local));
    return { allowed: true, ...this.authorization(local), hostEpoch: this.identity.hostEpoch, fencingToken: execution!.fencingToken,
      conversationGeneration: this.conversation(local.conversationId).conversationGeneration,
      sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: null, atomicVersionCheck: false };
  }
  prepareLocal(value: PrepareLocalMemory): PreparedLocalMemory {
    fields(value, ['requestId', 'conversationId', 'bodyDigest', 'bytes', 'sourceId'], ['requestId', 'conversationId', 'bodyDigest', 'bytes']);
    const input = { requestId: id(value.requestId, 'requestId'), conversationId: id(value.conversationId, 'conversationId'), bodyDigest: hash(value.bodyDigest), bytes: integer(value.bytes, 'bytes', 1, MAX_MEMORY_BODY_BYTES), sourceId: value.sourceId === undefined ? null : id(value.sourceId, 'sourceId') };
    return this.tx.atomic(() => {
      this.conversation(input.conversationId);
      const old = this.row('SELECT operation_id,request_hash FROM shiyu_local_memory_operations WHERE request_id=?', input.requestId);
      if (old) { if (old.request_hash !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 'Request identity already names different memory input'); return { ...this.get(String(old.operation_id)), duplicate: true }; }
      const conversation = this.conversation(input.conversationId), operationId = randomUUID(), sourceId = input.sourceId ?? randomUUID(), at = this.now();
      if (this.row('SELECT source_id FROM shiyu_local_memory_sources WHERE source_id=?', sourceId)) fail('SOURCE_ALREADY_REGISTERED', 'A source identity cannot be reused or overwrite its saving consent');
      const source: LocalMemorySource = { sourceId, revision: 1, conversationId: input.conversationId, scope: SCOPE, bodyDigest: input.bodyDigest, bodyBytes: input.bytes,
        audienceVersion: conversation.audienceVersion, consent: { kind: 'explicit-owner-save', basisRef: `owner-memory-request:${input.requestId}`, state: 'active', grantedAt: at } };
      const command = validateMemoryCreateCommand({ schemaVersion: 1, kind: 'create', operationId, backendId: this.backendId, scope: SCOPE, targetRef: randomUUID(), bodyDigest: input.bodyDigest, bodyBytes: input.bytes, sourceRefs: [{ sourceId, revision: 1 }] });
      const local: LocalOperation = { requestId: input.requestId, operationId, conversationId: input.conversationId, sourceId, command, mandateId: `memory-mandate:${operationId}`, reservationId: `memory-reservation:${operationId}`, createdAt: at };
      const resource = memoryResource(SCOPE, this.backendId, command.targetRef), expiresAt = new Date(Date.parse(at) + GRANT_MS).toISOString();
      const grant = this.mandates.grant(OWNER, { id: local.mandateId, scope: SCOPE, subjectIds: [MEMORY_DISPATCHER.principalId], allowedActions: ['memory.write'], allowedResources: [resource], limits: BUDGET, basisRef: source.consent.basisRef, expiresAt });
      const mandateRef = { mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, installationGeneration: this.identity.installationGeneration };
      this.mandates.reserve(MEMORY_DISPATCHER, { reservationId: local.reservationId, mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, scope: SCOPE, action: 'memory.write', resourceScopes: [resource], amount: BUDGET, leaseMs: GRANT_MS });
      this.db.prepare('INSERT INTO shiyu_local_memory_sources VALUES(?,?)').run(sourceId, JSON.stringify(source));
      this.ledger.approve(OWNER, { operationId, backendId: this.backendId, proposalId: `memory-proposal:${operationId}`, kind: 'append', commandRef: `memory-command:${operationId}`, commandDigest: memoryCommandDigest(command), scope: SCOPE, targetRef: command.targetRef,
        sourceRefs: command.sourceRefs, dependencyRefs: [], expectedTombstoneWatermark: this.ledger.watermark(), origin: { kind: 'dialogue', conversationId: input.conversationId, turnId: `owner-memory:${input.requestId}`, conversationGeneration: conversation.conversationGeneration }, mandateRef, expiresAt }, () => {
        this.mandates.assertPermit(MEMORY_DISPATCHER, { reservationId: local.reservationId, mandateId: grant.mandateId, mandateVersion: grant.version, authEpoch: grant.authEpoch, scope: SCOPE, action: 'memory.write', resourceScopes: [resource] });
        return { allowed: true, authorization: mandateRef, sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: null, atomicVersionCheck: false };
      });
      this.db.prepare('INSERT INTO shiyu_local_memory_operations VALUES(?,?,?,?,?,?)').run(operationId, input.requestId, digest(input), input.conversationId, sourceId, JSON.stringify(local));
      return { ...this.get(operationId), duplicate: false };
    });
  }
  claim(input: MemoryCommands['memory.claim']['input']): MemoryDispatchPlan | undefined {
    fields(input, ['operationId', 'leaseMs'], ['operationId']);
    const leaseMs = input.leaseMs === undefined ? 30000 : integer(input.leaseMs, 'leaseMs', 1, 120000);
    if (this.tx.depth !== 0) fail('NESTED_DISPATCH', 'Memory dispatch must return only after its claim commits');
    const prepared = this.tx.atomic(() => {
      const local = this.local(input.operationId), operation = this.operation(local);
      if (operation.status !== 'approved') return undefined;
      if (!this.sourceAllowed(local, true)) fail('MEMORY_CONSENT_WITHDRAWN', 'Saving consent or conversation changed');
      this.mandates.assertPermit(MEMORY_DISPATCHER, this.permit(local));
      if (!local.execution || local.execution.hostEpoch !== this.identity.hostEpoch || local.execution.installationGeneration !== this.identity.installationGeneration) {
        const fence = integer(Number(this.row('SELECT fence FROM shiyu_local_memory_meta WHERE id=1')!.fence) + 1, 'fencingToken');
        this.db.prepare('UPDATE shiyu_local_memory_meta SET fence=? WHERE id=1').run(fence);
        local.execution = { ...this.identity, fencingToken: fence };
        this.db.prepare('UPDATE shiyu_local_memory_operations SET record_json=? WHERE operation_id=?').run(JSON.stringify(local), local.operationId);
      }
      return { local, operation };
    });
    if (!prepared) return undefined;
    const claim = this.ledger.claim(MEMORY_DISPATCHER, { operationId: prepared.local.operationId, expectedVersion: prepared.operation.version, ownerId: MEMORY_DISPATCHER.principalId, ...this.identity, fencingToken: prepared.local.execution!.fencingToken, leaseMs }, () => this.authorize(this.local(input.operationId)));
    return claim ? { operation: this.operation(prepared.local), command: clone(prepared.local.command), commandDigest: memoryCommandDigest(prepared.local.command), claim } : undefined;
  }
  assertDispatch(input: MemoryCommands['memory.assertDispatch']['input']): MemoryDispatchPlan {
    fields(input, ['operationId', 'claim']); const local = this.local(input.operationId);
    const operation = this.ledger.assertDispatch(MEMORY_DISPATCHER, local.operationId, input.claim, () => this.authorize(this.local(local.operationId)));
    return { operation, command: clone(local.command), commandDigest: memoryCommandDigest(local.command), claim: clone(input.claim) };
  }
  private observation(local: LocalOperation, value: MemoryBackendObservation): MemoryBackendObservation {
    fields(value, ['command', 'commandDigest', 'deploymentId', 'nativeId', 'receiptId', 'componentVersion', 'bodyDigest', 'bodyBytes', 'sourceRefs', 'observedAt']);
    const command = validateMemoryCreateCommand(value.command);
    if (canonicalMemoryCommand(command) !== canonicalMemoryCommand(local.command) || hash(value.commandDigest) !== memoryCommandDigest(local.command)
      || id(value.deploymentId, 'deploymentId') !== this.deploymentId || hash(value.bodyDigest) !== command.bodyDigest || integer(value.bodyBytes, 'bodyBytes', 1, MAX_MEMORY_BODY_BYTES) !== command.bodyBytes
      || canonical(value.sourceRefs) !== canonical(command.sourceRefs)) fail('MEMORY_OBSERVATION_MISMATCH', 'Trusted readback does not match this approved command and deployment');
    if (typeof value.componentVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.componentVersion)) fail('MEMORY_OBSERVATION_MISMATCH', 'Backend observation must carry the exact native-file fingerprint');
    if (typeof value.nativeId !== 'string' || !/^shiyu_[a-f0-9]{32}$/.test(value.nativeId) || typeof value.receiptId !== 'string' || !/^receipt_[a-f0-9]{64}$/.test(value.receiptId)) fail('MEMORY_OBSERVATION_MISMATCH', 'Backend observation has an invalid native or receipt identity');
    time(value.observedAt);
    return clone(value);
  }
  recordVerifiedReceipt(input: MemoryVerifiedReceiptInput): LocalMemoryEntry {
    fields(input, ['operationId', 'claim', 'observation', 'reconciliation']); if (typeof input.reconciliation !== 'boolean') fail('INVALID_MEMORY_INPUT', 'reconciliation must be boolean');
    return this.tx.atomic(() => {
      const local = this.local(input.operationId), observed = this.observation(local, input.observation), operation = this.operation(local);
      const receipt = { receiptId: observed.receiptId, operationId: local.operationId, backendId: this.backendId, externalOperationId: local.operationId, commandDigest: operation.commandDigest,
        outcome: 'applied' as const, observedAt: observed.observedAt, nativeId: observed.nativeId, componentVersion: observed.componentVersion,
        backendReceiptRef: `strict-memory-receipt:${observed.receiptId}`, verificationRef: `strict-memory-readback:${digest(observed)}`, evidenceRefs: [`strict-memory-native:${observed.nativeId}:${observed.componentVersion}`] };
      const verify: MemoryReceiptVerifier = current => ({ verified: true, operationId: current.operationId, backendId: this.backendId, externalOperationId: current.operationId,
        commandDigest: current.commandDigest, outcome: 'applied', installationGeneration: current.mandateRef.installationGeneration, nativeId: observed.nativeId, componentVersion: observed.componentVersion,
        sourceRefs: observed.sourceRefs, operationSettled: true, reconciled: input.reconciliation, publicationAllowed: this.publicationAllowed(local), atomicCas: null });
      // A later status/get observation may confirm an already committed receipt.
      // Preserve its original mode rather than rewriting history or publishing
      // again. Effect/Memory receipt identity still checks all fields and claim.
      const existing = this.ledger.receipts(local.operationId).find(record => record.receiptId === receipt.receiptId);
      const reconciliation = existing ? existing.mode === 'reconciliation' : input.reconciliation;
      if (reconciliation) this.ledger.reconcile(MEMORY_VERIFIER, local.operationId, operation.version, input.claim, receipt, verify);
      else this.ledger.complete(MEMORY_VERIFIER, local.operationId, operation.version, input.claim, receipt, verify);
      this.settleBudget(local, 1, `memory-usage:${observed.receiptId}`, receipt.verificationRef);
      return this.get(local.operationId);
    });
  }
  private settleBudget(local: LocalOperation, effects: 0 | 1, receiptId: string, evidenceRef: string): void {
    const reservation = this.mandates.getReservation(OWNER, local.reservationId);
    if (reservation.state === 'settled') {
      if (reservation.observed.effects !== effects || reservation.observed.tokens !== 0 || reservation.observed.calls !== 0) fail('MEMORY_USAGE_CONFLICT', 'Settled backend effect accounting differs');
      return;
    }
    this.mandates.reconcile(MEMORY_VERIFIER, { receiptId, reservationId: local.reservationId, expectedVersion: reservation.version, complete: true, usage: { tokens: 0, calls: 0, effects }, evidenceRef });
  }
  private unknownBudget(local: LocalOperation): void {
    const reservation = this.mandates.getReservation(OWNER, local.reservationId);
    if (reservation.state !== 'reserved') return;
    this.mandates.reconcile(MEMORY_VERIFIER, { receiptId: `memory-unknown:${local.operationId}`, reservationId: local.reservationId, expectedVersion: reservation.version, complete: false, usage: { tokens: 0, calls: 0 }, evidenceRef: `memory-operation:${local.operationId}` });
  }
  markUnknown(input: MemoryCommands['memory.markUnknown']['input']): LocalMemoryEntry {
    fields(input, ['operationId', 'claim', 'reasonCode']); id(input.reasonCode, 'reasonCode', 100);
    return this.tx.atomic(() => {
      const local = this.local(input.operationId), operation = this.operation(local);
      this.ledger.markUnknown(MEMORY_DISPATCHER, local.operationId, operation.version, input.claim, input.reasonCode); this.unknownBudget(local); return this.get(local.operationId);
    });
  }
  withdrawLocal(input: MemoryCommands['memory.withdrawLocal']['input']): WithdrawLocalMemoryResult {
    return this.removeLocalSource(input, 'withdraw');
  }
  /**
   * Logical forget: the same durable consent/deletion barrier as withdrawal, but
   * recorded as an explicit owner forget. It never copies or erases a second body
   * and never resurrects a forgotten source.
   */
  forgetLocal(input: MemoryCommands['memory.forgetLocal']['input']): WithdrawLocalMemoryResult {
    return this.removeLocalSource(input, 'forget');
  }
  private removeLocalSource(input: { requestId: string; operationId: string }, mode: 'withdraw' | 'forget'): WithdrawLocalMemoryResult {
    fields(input, ['requestId', 'operationId']); id(input.requestId, 'requestId'); id(input.operationId, 'operationId', 150);
    return this.tx.atomic(() => {
      const local = this.local(input.operationId), source = this.source(local.sourceId);
      // Withdrawing one's already registered source must also work after its
      // conversation is archived/removed. Fixed owner + original stored scope
      // are the authority; an active conversation is only a saving/read gate.
      if (source.scope !== SCOPE || source.conversationId !== local.conversationId) fail('MEMORY_CONVERSATION_FORBIDDEN', 'Source is not owned by this local-owner conversation');
      const old = this.row('SELECT operation_id,intent_hash FROM shiyu_local_memory_withdrawals WHERE request_id=?', input.requestId);
      if (old) { if (old.intent_hash !== digest(input)) fail('IDEMPOTENCY_CONFLICT', 'Withdrawal identity changed'); return this.get(local.operationId); }
      const operationIdTag = mode === 'forget' ? 'memory-forget' : 'memory-withdrawal';
      let contextInvalidation: MemoryContextInvalidation | undefined;
      if (source.consent.state === 'active' || mode === 'forget') {
        const wasActive = source.consent.state === 'active';
        if (wasActive) { source.consent.state = 'withdrawn'; source.consent.withdrawnAt = this.now(); }
        if (mode === 'forget' && !source.consent.forgottenAt) source.consent.forgottenAt = this.now();
        source.revision++;
        this.db.prepare('UPDATE shiyu_local_memory_sources SET record_json=? WHERE source_id=?').run(JSON.stringify(source), source.sourceId);
        this.ledger.tombstone(OWNER, { deletionId: `${operationIdTag}:${input.requestId}`, scope: SCOPE, refs: [source.sourceId], expectedWatermark: this.ledger.watermark(),
          reasonCode: mode === 'forget' ? 'OWNER_FORGET' : 'OWNER_SAVE_CONSENT_WITHDRAWN' });
        if (wasActive) {
          const grant = this.mandates.get(OWNER, local.mandateId); if (grant.state !== 'revoked') this.mandates.revoke(OWNER, { mandateId: grant.mandateId, expectedVersion: grant.version });
          const effect = this.effects.get(this.operation(local).effectId)!;
          if (effect.status === 'cancelled') this.settleBudget(local, 0, `memory-unused:${local.operationId}`, `${operationIdTag}:${input.requestId}`);
          else if (effect.status === 'unknown' || effect.status === 'dispatching') this.unknownBudget(local);
          // This is deliberately inside the consent/tombstone transaction. Native
          // cancellation is a later notification; durable context fences must
          // commit atomically even when that notification never arrives.
          if (this.options.onWithdrawSources) contextInvalidation = this.withdrawContext(`${operationIdTag}:${digest(input)}`, [source.sourceId]);
        }
      }
      this.db.prepare('INSERT INTO shiyu_local_memory_withdrawals VALUES(?,?,?)').run(input.requestId, local.operationId, digest(input));
      return { ...this.get(local.operationId), ...(contextInvalidation ? { contextInvalidation } : {}) };
    });
  }
  /** Read-only, auditable retention/forget state; never mutates or widens access. */
  lifecycle(input: MemoryCommands['memory.lifecycle']['input']): MemoryLifecycle {
    fields(input, ['operationId']);
    return this.tx.atomic(() => {
      const entry = this.get(input.operationId), source = entry.source;
      const forgottenAt = source.consent.forgottenAt;
      const retained = source.consent.state === 'active';
      return {
        schemaVersion: 1, policy: structuredClone(MEMORY_LIFECYCLE_POLICY_V1),
        operationId: input.operationId, sourceId: source.sourceId, conversationId: source.conversationId, savedAt: source.consent.grantedAt,
        consentState: source.consent.state,
        ...(source.consent.withdrawnAt === undefined ? {} : { withdrawnAt: source.consent.withdrawnAt }),
        ...(forgottenAt === undefined ? {} : { forgottenAt }),
        retention: { retained, mode: 'owner-controlled', automaticExpiry: false, physicalErase: false,
          reasonCode: retained ? 'CONSENT_ACTIVE' : forgottenAt ? 'OWNER_FORGET' : 'OWNER_SAVE_CONSENT_WITHDRAWN' },
        backendStatus: entry.operation.status, bodyReferencePresent: Boolean(entry.reference), canPublish: entry.canPublish,
        deletionWatermark: this.ledger.deletionState().tombstoneWatermark,
      };
    });
  }
  publishLocal(input: MemoryCommands['memory.publishLocal']['input']): LocalMemoryEntry {
    fields(input, ['operationId', 'expectedVersion', 'receiptId']);
    return this.tx.atomic(() => {
      const local = this.local(input.operationId);
      this.ledger.recheckPublication(MEMORY_VERIFIER, input, () => this.publicationAllowed(local) ? { allowed: true, authorization: this.authorization(local), sourcesVerified: true, dependenciesVerified: true } : { allowed: false, reasonCode: 'CURRENT_LOCAL_MEMORY_AUTHORITY_REQUIRED' });
      return this.get(local.operationId);
    });
  }
  get(operationId: string): LocalMemoryEntry {
    return this.tx.atomic(() => {
      const local = this.local(operationId), operation = this.operation(local), source = this.source(local.sourceId);
      let readable = false;
      try { readable = this.sourceAllowed(local, false); }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || !['NOT_FOUND', 'UNKNOWN_CONVERSATION', 'MEMORY_CONVERSATION_FORBIDDEN', 'FORBIDDEN'].includes(String(error.code))) throw error;
      }
      const reference = operation.status === 'applied' && !operation.blocked && readable && operation.nativeId && operation.componentVersion
        ? { backendId: this.backendId, deploymentId: this.deploymentId, scope: SCOPE, nativeId: operation.nativeId, componentVersion: operation.componentVersion, targetRef: local.command.targetRef, sourceId: source.sourceId } as const : undefined;
      return { requestId: local.requestId, conversationId: local.conversationId, source, operation, command: clone(local.command), reservation: this.mandates.getReservation(OWNER, local.reservationId), ...(reference ? { reference } : {}), canPublish: operation.backendOutcome === 'applied' && this.publicationAllowed(local) };
    });
  }
  list(input: MemoryCommands['memory.list']['input'] = {}): LocalMemoryEntry[] {
    fields(input, ['conversationId'], []); if (input.conversationId !== undefined) this.conversation(input.conversationId);
    return this.tx.atomic(() => (this.db.prepare(`SELECT operation_id FROM shiyu_local_memory_operations ${input.conversationId === undefined ? '' : 'WHERE conversation_id=?'} ORDER BY rowid`).all(...input.conversationId === undefined ? [] : [input.conversationId]) as Row[]).map(row => this.get(String(row.operation_id))));
  }
  /**
   * Explicit local-owner read: saving grant expiry/settlement does not erase read
   * consent. Re-read this vector after backend I/O before returning any body.
   * Everyday dialogue generations do not revoke memory; audience changes do.
   */
  readLocal(input: MemoryCommands['memory.readLocal']['input']): MemoryCommands['memory.readLocal']['output'] {
    fields(input, ['operationId']);
    return this.tx.atomic(() => {
      const entry = this.get(input.operationId), reference = entry.reference;
      if (!reference) fail('MEMORY_READ_FORBIDDEN', 'No currently readable verified local memory reference');
      const deletion = this.ledger.deletionState(), grant = this.mandates.get(OWNER, this.local(input.operationId).mandateId);
      const bodyReceiptId = this.effects.get(entry.operation.effectId)?.receiptId;
      if (!bodyReceiptId || !/^receipt_[a-f0-9]{64}$/.test(bodyReceiptId) || entry.operation.backendReceiptRef !== `strict-memory-receipt:${bodyReceiptId}`) fail('CORRUPT_MEMORY_DOMAIN', 'Readable memory is missing its fixed verified backend receipt');
      return { entry, bodyReceiptId: bodyReceiptId!, readToken: { operationId: entry.operation.operationId, operationVersion: entry.operation.version, sourceId: entry.source.sourceId,
        sourceRevision: entry.source.revision, audienceVersion: entry.source.audienceVersion, authorizationEpoch: this.mandates.health().authEpoch,
        saveMandateVersion: grant.version, deletionBaselineId: deletion.baselineId, tombstoneWatermark: deletion.tombstoneWatermark,
        installationGeneration: this.identity.installationGeneration, backendId: this.backendId, deploymentId: this.deploymentId,
        nativeId: reference!.nativeId, componentVersion: reference!.componentVersion } };
    });
  }
  private withdrawContext(withdrawalId: string, sourceIds: readonly string[]): MemoryContextInvalidation | undefined {
    const hook = this.options.onWithdrawSources;
    if (typeof hook !== 'function' || isAsyncFunction(hook)) fail('ASYNC_MEMORY_INVALIDATION', 'Context retirement must stay a synchronous local hook');
    const result = hook!({ withdrawalId, sourceIds: Object.freeze([...sourceIds]) });
    if (isPromise(result)) { void Promise.prototype.then.call(result, undefined, () => undefined); fail('ASYNC_MEMORY_INVALIDATION', 'Context retirement cannot return a Promise'); }
    if (result && typeof (result as unknown as { then?: unknown }).then === 'function') fail('ASYNC_MEMORY_INVALIDATION', 'Context retirement thenable rejected without invoking it');
    if (result === undefined) return undefined;
    fields(result, ['conversationIds', 'retiredSessions']);
    if (!Array.isArray(result.conversationIds) || !Array.isArray(result.retiredSessions) || result.conversationIds.length > 4096 || result.retiredSessions.length > 4096) fail('INVALID_MEMORY_INVALIDATION', 'Invalid bounded context retirement result');
    const conversationIds = result.conversationIds.map(value => id(value, 'retired conversationId'));
    if (new Set(conversationIds).size !== conversationIds.length) fail('INVALID_MEMORY_INVALIDATION', 'Repeated retired conversation identity');
    const retiredSessions = result.retiredSessions.map(value => {
      fields(value, ['bindingId', 'sessionEpoch', 'sessionId', 'businessId'], ['bindingId', 'sessionEpoch', 'businessId']);
      return { bindingId: id(value.bindingId, 'bindingId'), sessionEpoch: integer(value.sessionEpoch, 'sessionEpoch'), businessId: id(value.businessId, 'businessId'), ...(value.sessionId === undefined ? {} : { sessionId: id(value.sessionId, 'sessionId') }) };
    });
    return { conversationIds, retiredSessions };
  }
  private viewAuthority(): MemoryViewAuthority {
    const deletion = this.ledger.deletionState();
    return { backendId: this.backendId, deploymentId: this.deploymentId, installationGeneration: this.identity.installationGeneration,
      authorizationEpoch: this.mandates.health().authEpoch, deletionBaselineId: deletion.baselineId,
      deletionScope: 'local-memory-source', tombstoneWatermark: deletion.tombstoneWatermark, installedAt: deletion.installedAt };
  }
  private viewSource(operationId: string, conversationId: string): MemoryViewSource {
    const { entry, readToken } = this.readLocal({ operationId });
    // A private-owner scope alone is not a cross-conversation sharing grant.
    // This first view slice only uses memory from its exact source conversation.
    if (entry.conversationId !== conversationId) fail('MEMORY_VIEW_FORBIDDEN', 'Memory source belongs to another conversation');
    const command = validateMemoryCreateCommand(entry.command), commandDigest = memoryCommandDigest(command), reference = entry.reference!;
    if (entry.operation.commandDigest !== commandDigest || command.sourceRefs.length !== 1 || command.sourceRefs[0]!.sourceId !== entry.source.sourceId
      || command.sourceRefs[0]!.revision !== entry.source.revision || command.backendId !== reference.backendId || command.scope !== SCOPE || command.targetRef !== reference.targetRef) fail('CORRUPT_MEMORY_DOMAIN', 'Memory reference and approved command disagree');
    return { operationId: entry.operation.operationId, operationVersion: entry.operation.version, sourceId: entry.source.sourceId, sourceRevision: entry.source.revision,
      conversationId, targetRef: reference.targetRef, nativeId: reference.nativeId, componentVersion: reference.componentVersion, command, commandDigest, readToken };
  }
  private eligibleViewSources(conversationId: string): { sources: MemoryViewSource[]; truncated: boolean; collectionHash: string } {
    const sources: MemoryViewSource[] = []; let truncated = false;
    // Local references only. Pending/unknown/withdrawn records never become
    // candidates merely because a search backend happens to return their IDs.
    for (const item of this.db.prepare('SELECT operation_id FROM shiyu_local_memory_operations WHERE conversation_id=? ORDER BY rowid').all(conversationId) as Row[]) {
      let source: MemoryViewSource;
      try { source = this.viewSource(String(item.operation_id), conversationId); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'MEMORY_READ_FORBIDDEN') continue; throw error; }
      if (sources.length === MAX_MEMORY_VIEW_CANDIDATES) { truncated = true; break; }
      sources.push(source);
    }
    return { sources, truncated, collectionHash: digest({ conversationId, sources, truncated }) };
  }
  private selectionHash(snapshot: Pick<MemoryViewSnapshot, 'schemaVersion' | 'conversationId' | 'authority' | 'sources'>): string {
    return digest({ schemaVersion: snapshot.schemaVersion, conversationId: snapshot.conversationId, authority: snapshot.authority, sources: snapshot.sources });
  }
  /** An allowlist for trusted semantic retrieval. Query text/scores are not authority inputs. */
  listEligibleForView(input: MemoryCommands['memory.listEligibleForView']['input']): MemoryViewSnapshot {
    fields(input, ['conversationId']); return this.captureForView(input);
  }
  /** Same-Worker capture: source metadata only, no body read, save or publication side effect. */
  captureForView(input: MemoryCommands['memory.captureForView']['input']): MemoryViewSnapshot {
    fields(input, ['conversationId', 'operationIds'], ['conversationId']); id(input.conversationId, 'conversationId');
    if (input.operationIds !== undefined && (!Array.isArray(input.operationIds) || input.operationIds.length > MAX_MEMORY_VIEW_CANDIDATES)) fail('INVALID_MEMORY_INPUT', 'Memory view selection exceeds its bound');
    const operationIds = input.operationIds?.map(value => id(value, 'operationId', 150));
    if (operationIds && new Set(operationIds).size !== operationIds.length) fail('INVALID_MEMORY_INPUT', 'Duplicate memory view selection');
    return this.tx.atomic(() => {
      this.conversation(input.conversationId);
      const authority = this.viewAuthority(), pool = this.eligibleViewSources(input.conversationId);
      const sources = operationIds === undefined ? pool.sources : operationIds.map(operationId => this.viewSource(operationId, input.conversationId));
      const snapshot = { schemaVersion: 1 as const, conversationId: input.conversationId, authority, sources,
        collectionHash: pool.collectionHash, truncated: operationIds === undefined && pool.truncated };
      return { ...snapshot, snapshotHash: this.selectionHash(snapshot) };
    });
  }
  private checkedViewSource(value: MemoryViewSource): void {
    fields(value, ['operationId', 'operationVersion', 'sourceId', 'sourceRevision', 'conversationId', 'targetRef', 'nativeId', 'componentVersion', 'command', 'commandDigest', 'readToken']);
    id(value.operationId, 'operationId', 150); integer(value.operationVersion, 'operationVersion'); id(value.sourceId, 'sourceId'); integer(value.sourceRevision, 'sourceRevision'); id(value.conversationId, 'conversationId');
    id(value.targetRef, 'targetRef'); id(value.nativeId, 'nativeId'); hash(value.commandDigest);
    if (typeof value.componentVersion !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.componentVersion)) fail('INVALID_MEMORY_INPUT', 'Invalid native memory fingerprint');
    validateMemoryCreateCommand(value.command);
    fields(value.readToken, ['operationId', 'operationVersion', 'sourceId', 'sourceRevision', 'audienceVersion', 'authorizationEpoch', 'saveMandateVersion', 'deletionBaselineId', 'tombstoneWatermark', 'installationGeneration', 'backendId', 'deploymentId', 'nativeId', 'componentVersion']);
  }
  /** Exact short-lived capture validation: deletion is strong even during context acknowledgement. */
  validateForView(snapshot: MemoryViewSnapshot): MemoryViewSnapshot {
    fields(snapshot, ['schemaVersion', 'conversationId', 'authority', 'sources', 'snapshotHash', 'collectionHash', 'truncated']);
    if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.sources) || snapshot.sources.length > MAX_MEMORY_VIEW_CANDIDATES || typeof snapshot.truncated !== 'boolean') fail('INVALID_MEMORY_INPUT', 'Invalid bounded memory capture');
    id(snapshot.conversationId, 'conversationId'); hash(snapshot.snapshotHash); hash(snapshot.collectionHash);
    fields(snapshot.authority, ['backendId', 'deploymentId', 'installationGeneration', 'authorizationEpoch', 'deletionBaselineId', 'deletionScope', 'tombstoneWatermark', 'installedAt']);
    for (const source of snapshot.sources) this.checkedViewSource(source);
    if (new Set(snapshot.sources.map(source => source.operationId)).size !== snapshot.sources.length || this.selectionHash(snapshot) !== snapshot.snapshotHash) fail('MEMORY_VIEW_INVALIDATED', 'Memory selection identity changed');
    return this.tx.atomic(() => {
      this.conversation(snapshot.conversationId);
      if (canonical(this.viewAuthority()) !== canonical(snapshot.authority)) fail('MEMORY_VIEW_INVALIDATED', 'Memory authorization or independent deletion authority changed');
      for (const source of snapshot.sources) {
        const current = this.viewSource(source.operationId, snapshot.conversationId);
        if (canonical(current) !== canonical(source)) fail('MEMORY_VIEW_INVALIDATED', 'A selected memory source changed or lost permission');
      }
      // Do not refresh a pinned capture or invalidate it because a different
      // eligible result was published. Selection and pool observation differ.
      return clone(snapshot);
    });
  }
  /**
   * Native history reuse needs fresh per-source authority, not immortal capture
   * tokens. Unrelated grants/deletions may change global counters; they do not
   * permanently disable an otherwise unchanged, still authorized source.
   */
  validateExposedSources(sources: readonly MemoryViewSource[]): void {
    if (!Array.isArray(sources) || sources.length > MAX_MEMORY_VIEW_CANDIDATES) fail('INVALID_MEMORY_INPUT', 'Invalid bounded memory exposure set');
    if (new Set(sources.map(source => source.operationId)).size !== sources.length) fail('INVALID_MEMORY_INPUT', 'Duplicate memory exposure identity');
    for (const source of sources) this.checkedViewSource(source);
    const stable = (source: MemoryViewSource) => {
      const { authorizationEpoch: _epoch, saveMandateVersion: _save, tombstoneWatermark: _watermark, ...readToken } = source.readToken;
      return { ...source, readToken };
    };
    this.tx.atomic(() => {
      this.viewAuthority(); // A missing/corrupt deletion authority always fails closed.
      for (const source of sources) if (canonical(stable(this.viewSource(source.operationId, source.conversationId))) !== canonical(stable(source))) fail('MEMORY_VIEW_INVALIDATED', 'Exposed source identity, audience or current permission changed');
    });
  }
  execute(request: MemoryDomainRequest): MemoryCommands[keyof MemoryCommands]['output'] {
    switch (request.command) {
      case 'memory.prepareLocal': return this.prepareLocal(request.args);
      case 'memory.claim': return this.claim(request.args);
      case 'memory.assertDispatch': return this.assertDispatch(request.args);
      case 'memory.recordVerifiedReceipt': return this.recordVerifiedReceipt(request.args);
      case 'memory.markUnknown': return this.markUnknown(request.args);
      case 'memory.withdrawLocal': return this.withdrawLocal(request.args);
      case 'memory.forgetLocal': return this.forgetLocal(request.args);
      case 'memory.lifecycle': return this.lifecycle(request.args);
      case 'memory.publishLocal': return this.publishLocal(request.args);
      case 'memory.get': fields(request.args, ['operationId']); return this.get(request.args.operationId);
      case 'memory.readLocal': return this.readLocal(request.args);
      case 'memory.list': return this.list(request.args);
      case 'memory.listEligibleForView': return this.listEligibleForView(request.args);
      case 'memory.captureForView': return this.captureForView(request.args);
      case 'memory.validateForView': fields(request.args, ['snapshot']); return this.validateForView(request.args.snapshot);
      case 'memory.validateExposedSources': fields(request.args, ['sources']); this.validateExposedSources(request.args.sources); return { valid: true };
      default: return fail('UNKNOWN_MEMORY_COMMAND', 'Unknown memory domain command');
    }
  }
}
