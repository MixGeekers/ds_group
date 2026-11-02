import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SqliteTransactions } from '../../adapters/control-store/transaction.js';

export interface Budget { tokens: number; calls: number; effects: number }
/** Host-authenticated identity. Never deserialize this from an Agent tool's arguments. */
export interface TrustedPolicyActor { principalId: string; kind: 'owner' | 'agent' | 'component'; scopes: string[] }
export interface MandateInput {
  id: string; scope: string; subjectIds: string[]; allowedActions: string[]; allowedResources: string[];
  limits: Budget; basisRef: string; expiresAt: string; validFrom?: string; maxExpiresAt?: string;
}
export interface Mandate {
  schemaVersion: 1; mandateId: string; scope: string; issuer: string; subjectIds: string[];
  allowedActions: string[]; allowedResources: string[]; limits: Budget; basisRef: string;
  validFrom: string; expiresAt: string; maxExpiresAt: string; policyVersion: 1;
  authEpoch: number; version: number; state: 'active' | 'suspended' | 'revoked' | 'expired';
  createdAt: string; updatedAt: string;
}
export interface PermitRequest {
  reservationId: string; mandateId: string; mandateVersion: number; authEpoch: number;
  scope: string; action: string; resourceScopes: string[];
}
export interface ReserveInput extends PermitRequest { amount: Budget; leaseMs?: number }
export interface BudgetReservation extends PermitRequest {
  schemaVersion: 1; principalId: string; amount: Budget; version: number;
  state: 'reserved' | 'unknown' | 'settled'; observed: Partial<Budget>; overrun: boolean;
  leaseExpiresAt: string; createdAt: string; updatedAt: string;
}
export interface Permit extends PermitRequest {
  principalId: string; reservationVersion: number; leaseExpiresAt: string;
  /** Upper bound reserved for this invocation; callers must also budget input/compaction usage. */
  maxTokens: number; budget: Budget;
}
export interface ReconcileInput {
  receiptId: string; reservationId: string; expectedVersion: number; complete: boolean;
  usage: { tokens?: number | null; calls?: number | null; effects?: number | null }; evidenceRef: string;
}
export interface MandateStoreOptions {
  ownerIds: string[]; reconcilerIds?: string[]; dispatcherIds?: string[]; now?: () => Date;
  /** When supplied, every configured service has an exact action allowlist. */
  dispatcherActions?: Record<string, string[]>; reconcilerActions?: Record<string, string[]>;
  /** Trusted per-invocation minima; e.g. an effect requires effects>=1, a model call calls>=1. */
  actionCosts: Record<string, Budget>;
}
export interface PolicyCatalogState { revision: number; policyHash: string }
export interface PolicyCatalogMigration {
  migrationId: string; expectedRevision: number; expectedPolicyHash: string;
  target: MandateStoreOptions; now?: () => Date;
}
export interface PolicyCatalogMigrationReceipt {
  migrationId: string; fromRevision: number; fromPolicyHash: string; toRevision: number;
  toPolicyHash: string; authEpoch: number; migratedAt: string;
}
export class MandateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'MandateError'; }
}
type Tx = Pick<SqliteTransactions, 'atomic' | 'owns' | 'assertUsable'>;
type Row = Record<string, unknown>;
const axes = ['tokens', 'calls', 'effects'] as const;
const zero = (): Budget => ({ tokens: 0, calls: 0, effects: 0 });
const fail = (code: string, message: string): never => { throw new MandateError(code, message); };
const clone = <T>(value: T): T => structuredClone(value);
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\u0000-\u001f]/u.test(value)) fail('INVALID_SCHEMA', `Invalid ${name}`);
  return value as string;
}
function integer(value: unknown, name: string, min = 0, max = 1e12): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail('INVALID_SCHEMA', `Invalid ${name}`);
  return value as number;
}
function object(value: unknown, allowed: string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SCHEMA', 'Expected bounded object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(record, key))) fail('INVALID_SCHEMA', 'Unknown or missing policy fields');
  return record;
}
function list(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) fail('INVALID_SCHEMA', `Invalid ${name}`);
  const values = (value as unknown[]).map(item => text(item, name));
  if (new Set(values).size !== values.length) fail('INVALID_SCHEMA', `Duplicate ${name}`);
  return values.sort();
}
function time(value: unknown, name: string): string {
  const result = text(value, name); const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) fail('INVALID_SCHEMA', `${name} must be canonical UTC`);
  return result;
}
function budget(value: unknown): Budget {
  const record = object(value, [...axes]);
  return { tokens: integer(record.tokens, 'tokens'), calls: integer(record.calls, 'calls'), effects: integer(record.effects, 'effects') };
}
function request(value: PermitRequest): PermitRequest {
  return {
    reservationId: text(value.reservationId, 'reservationId'), mandateId: text(value.mandateId, 'mandateId'),
    mandateVersion: integer(value.mandateVersion, 'mandateVersion', 1), authEpoch: integer(value.authEpoch, 'authEpoch', 1),
    scope: text(value.scope, 'scope'), action: text(value.action, 'action'), resourceScopes: list(value.resourceScopes, 'resourceScopes'),
  };
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

interface CatalogDefinition {
  owners: string[]; reconcilers: string[]; dispatchers: string[]; costs: [string, Budget][];
  dispatcherActions?: Record<string, string[]>; reconcilerActions?: Record<string, string[]>;
}
function catalogDefinition(options: MandateStoreOptions): CatalogDefinition {
  const optionalIds = (value: string[] | undefined, label: string) => value === undefined || (Array.isArray(value) && value.length === 0) ? [] : list(value, label);
  const owners = list(options.ownerIds, 'ownerIds'), reconcilers = optionalIds(options.reconcilerIds, 'reconcilerIds'), dispatchers = optionalIds(options.dispatcherIds, 'dispatcherIds');
  if (!options.actionCosts || typeof options.actionCosts !== 'object' || Array.isArray(options.actionCosts) || !Object.keys(options.actionCosts).length || Object.keys(options.actionCosts).length > 128) fail('INVALID_SCHEMA', 'A trusted bounded action cost catalog is required');
  const costs: [string, Budget][] = Object.entries(options.actionCosts).sort(([a], [b]) => a.localeCompare(b)).map(([action, minimum]) => [text(action, 'action'), budget(minimum)]);
  const actionSet = new Set(costs.map(([action]) => action));
  const permissions = (value: Record<string, string[]> | undefined, ids: string[], label: string) => {
    if (value === undefined) return undefined;
    object(value, ids);
    return Object.fromEntries(ids.map(id => {
      const actions = list(value[id], label);
      if (actions.some(action => !actionSet.has(action))) fail('UNKNOWN_ACTION', 'Service action restrictions reference an unregistered action');
      return [id, actions];
    }));
  };
  const dispatcherActions = permissions(options.dispatcherActions, dispatchers, 'dispatcherActions'), reconcilerActions = permissions(options.reconcilerActions, reconcilers, 'reconcilerActions');
  // Preserve the exact legacy hash shape when no role-action restrictions exist.
  return { owners, reconcilers, dispatchers, costs, ...(dispatcherActions === undefined ? {} : { dispatcherActions }), ...(reconcilerActions === undefined ? {} : { reconcilerActions }) };
}
export function policyCatalogHash(options: MandateStoreOptions): string { return digest(catalogDefinition(options)); }
function currentCatalog(db: DatabaseSync): PolicyCatalogState {
  const row = db.prepare('SELECT revision,policy_hash,definition_json FROM shiyu_policy_catalog_state WHERE id=1').get();
  const catalog = db.prepare('SELECT policy_hash FROM shiyu_policy_catalog WHERE id=1').get();
  if (!row || !catalog || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || typeof row.policy_hash !== 'string'
    || row.policy_hash !== catalog.policy_hash || typeof row.definition_json !== 'string') fail('CORRUPT_POLICY', 'Policy catalog authority is incomplete');
  let definition: unknown;
  try { definition = JSON.parse(String(row!.definition_json)); } catch { return fail('CORRUPT_POLICY', 'Invalid catalog definition'); }
  if (digest(definition) !== row!.policy_hash) fail('CORRUPT_POLICY', 'Catalog definition differs from its trusted hash');
  return { revision: Number(row!.revision), policyHash: String(row!.policy_hash) };
}
/**
 * Trusted composition/migration API only, never an Agent or dashboard command.
 * The caller must pin a reviewed source hash/revision and target declaration.
 * Existing grants and accounting records are deliberately not rewritten.
 */
export function migrateMandateCatalog(db: DatabaseSync, transactions: Tx, migration: PolicyCatalogMigration): PolicyCatalogMigrationReceipt {
  if (!transactions.owns(db)) fail('TRANSACTION_MISMATCH', 'Catalog migration requires the shared transaction connection');
  object(migration, ['migrationId', 'expectedRevision', 'expectedPolicyHash', 'target', 'now'], ['migrationId', 'expectedRevision', 'expectedPolicyHash', 'target']);
  const migrationId = text(migration.migrationId, 'migrationId'), expectedRevision = integer(migration.expectedRevision, 'catalog revision', 1, Number.MAX_SAFE_INTEGER - 1);
  const expectedPolicyHash = text(migration.expectedPolicyHash, 'expected policy hash'), target = catalogDefinition(migration.target), targetHash = digest(target);
  if (!/^[a-f0-9]{64}$/u.test(expectedPolicyHash)) fail('INVALID_SCHEMA', 'Expected a fixed policy hash');
  const intentHash = digest({ migrationId, expectedRevision, expectedPolicyHash, target });
  return transactions.atomic(() => {
    const current = currentCatalog(db);
    const prior = db.prepare('SELECT intent_hash,record_json FROM shiyu_policy_catalog_migrations WHERE migration_id=?').get(migrationId);
    if (prior) {
      if (prior.intent_hash !== intentHash) fail('IDEMPOTENCY_CONFLICT', 'Migration identity already names another declaration');
      return JSON.parse(String(prior.record_json)) as PolicyCatalogMigrationReceipt;
    }
    if (current.revision !== expectedRevision || current.policyHash !== expectedPolicyHash) fail('CATALOG_CONFLICT', 'Catalog does not match the reviewed source revision/hash');
    if (targetHash === expectedPolicyHash) fail('INVALID_MIGRATION', 'A migration must change the catalog declaration');
    const meta = db.prepare('SELECT auth_epoch FROM shiyu_policy_meta WHERE id=1').get();
    const epoch = integer(meta?.auth_epoch, 'stored authEpoch', 0, Number.MAX_SAFE_INTEGER - 1) + 1;
    const result: PolicyCatalogMigrationReceipt = { migrationId, fromRevision: current.revision, fromPolicyHash: current.policyHash,
      toRevision: current.revision + 1, toPolicyHash: targetHash, authEpoch: epoch, migratedAt: time((migration.now?.() ?? new Date()).toISOString(), 'migration time') };
    if (db.prepare('UPDATE shiyu_policy_catalog SET policy_hash=? WHERE id=1 AND policy_hash=?').run(targetHash, expectedPolicyHash).changes !== 1
      || db.prepare('UPDATE shiyu_policy_catalog_state SET revision=?,policy_hash=?,definition_json=? WHERE id=1 AND revision=? AND policy_hash=?').run(result.toRevision, targetHash, JSON.stringify(target), current.revision, current.policyHash).changes !== 1) fail('CATALOG_CONFLICT', 'Catalog changed during migration');
    db.prepare('UPDATE shiyu_policy_meta SET auth_epoch=? WHERE id=1').run(epoch);
    db.prepare('INSERT INTO shiyu_policy_catalog_migrations VALUES(?,?,?)').run(migrationId, intentHash, JSON.stringify(result));
    return clone(result);
  });
}

/**
 * Trusted policy facts and budget accounting on the existing control DB Worker.
 * This is not a Goal state machine or an authorization parser for natural text.
 * Owners are pinned by host configuration; Agent-facing tools must expose only
 * reserve/read requests, never grant/control/reconcile or the actor parameter.
 * Resources are exact opaque identities: no glob, path-prefix, or inherited scope.
 */
export class MandateStore {
  private readonly owners: ReadonlySet<string>;
  private readonly reconcilers: ReadonlySet<string>;
  private readonly dispatchers: ReadonlySet<string>;
  private readonly costs: ReadonlyMap<string, Budget>;
  private readonly policyHash: string;
  private readonly catalogRevision: number;
  private readonly dispatcherActions?: Record<string, string[]>;
  private readonly reconcilerActions?: Record<string, string[]>;
  constructor(private readonly db: DatabaseSync, private readonly transactions: Tx, private readonly options: MandateStoreOptions) {
    if (!transactions.owns(db)) fail('TRANSACTION_MISMATCH', 'Policy and transaction must own the same SQLite connection');
    const definition = catalogDefinition(options);
    this.owners = new Set(definition.owners); this.reconcilers = new Set(definition.reconcilers); this.dispatchers = new Set(definition.dispatchers);
    this.costs = new Map(definition.costs); this.dispatcherActions = definition.dispatcherActions; this.reconcilerActions = definition.reconcilerActions;
    this.policyHash = digest(definition);
    const policyHash = this.policyHash;
    this.catalogRevision = transactions.atomic(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_policy_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, frozen INTEGER NOT NULL, reason TEXT);
        INSERT OR IGNORE INTO shiyu_policy_meta VALUES(1,1,0,0,NULL);`);
      if (this.row('SELECT schema_version FROM shiyu_policy_meta WHERE id=1')?.schema_version !== 1) fail('INCOMPATIBLE_VERSION', 'Unsupported policy schema');
      db.exec('CREATE TABLE IF NOT EXISTS shiyu_policy_catalog (id INTEGER PRIMARY KEY CHECK(id=1), policy_hash TEXT NOT NULL)');
      db.prepare('INSERT OR IGNORE INTO shiyu_policy_catalog VALUES(1,?)').run(policyHash);
      if (this.row('SELECT policy_hash FROM shiyu_policy_catalog WHERE id=1')?.policy_hash !== policyHash) fail('INCOMPATIBLE_POLICY', 'Trusted policy configuration changed; explicit authority migration is required');
      const tracking = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('shiyu_policy_catalog_state','shiyu_policy_catalog_migrations')").all();
      if (tracking.length === 1) fail('CORRUPT_POLICY', 'Catalog revision tracking is incomplete');
      if (tracking.length === 0) {
        db.exec(`CREATE TABLE shiyu_policy_catalog_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,policy_hash TEXT NOT NULL,definition_json TEXT NOT NULL CHECK(json_valid(definition_json)));
          CREATE TABLE shiyu_policy_catalog_migrations(migration_id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)));`);
        db.prepare('INSERT INTO shiyu_policy_catalog_state VALUES(1,1,?,?)').run(policyHash, JSON.stringify(definition));
      }
      const state = currentCatalog(db);
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_mandates (id TEXT PRIMARY KEY, intent_hash TEXT NOT NULL, version INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
        CREATE TABLE IF NOT EXISTS shiyu_budget_reservations (id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES shiyu_mandates(id), intent_hash TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
        CREATE INDEX IF NOT EXISTS shiyu_reservations_mandate ON shiyu_budget_reservations(mandate_id);
        CREATE TABLE IF NOT EXISTS shiyu_budget_receipts (id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES shiyu_budget_reservations(id), receipt_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)));`);
      return state.revision;
    });
  }
  private assertCatalog(): PolicyCatalogState {
    this.transactions.assertUsable(); const current = currentCatalog(this.db);
    if (current.policyHash !== this.policyHash || current.revision !== this.catalogRevision) fail('STALE_CATALOG', 'This authority instance uses an obsolete policy catalog');
    return current;
  }
  catalog(): PolicyCatalogState { return this.transactions.atomic(() => this.assertCatalog()); }
  private serviceAction(kind: 'dispatcher' | 'reconciler', principalId: string, action: string): boolean {
    const ids = kind === 'dispatcher' ? this.dispatchers : this.reconcilers;
    const map = kind === 'dispatcher' ? this.dispatcherActions : this.reconcilerActions;
    return ids.has(principalId) && (map === undefined || map[principalId]?.includes(action) === true);
  }
  private subjectAction(actor: TrustedPolicyActor, action: string): void {
    // Being named a grant subject must not bypass a configured service role's
    // action boundary through the reserved-principal shortcut in checkedPermit.
    if (actor.kind !== 'component') return;
    if ((this.dispatcherActions && this.dispatchers.has(actor.principalId) && !this.serviceAction('dispatcher', actor.principalId, action))
      || (this.reconcilerActions && this.reconcilers.has(actor.principalId) && !this.serviceAction('reconciler', actor.principalId, action))) fail('FORBIDDEN', 'Action is outside this trusted service role');
  }
  private now(): string { return time((this.options.now?.() ?? new Date()).toISOString(), 'now'); }
  private row(sql: string, ...params: SQLInputValue[]): Row | undefined { this.transactions.assertUsable(); return this.db.prepare(sql).get(...params) as Row | undefined; }
  private actor(actor: TrustedPolicyActor, scope: string): void {
    this.assertCatalog();
    text(actor?.principalId, 'principalId');
    if (!['owner', 'agent', 'component'].includes(actor.kind) || !Array.isArray(actor.scopes) || !actor.scopes.includes(scope)) fail('FORBIDDEN', 'Trusted caller does not have this scope');
  }
  private owner(actor: TrustedPolicyActor, scope: string): void {
    this.actor(actor, scope);
    if (actor.kind !== 'owner' || !this.owners.has(actor.principalId)) fail('FORBIDDEN', 'A configured trusted owner is required');
  }
  private trustedReconciler(actor: TrustedPolicyActor, scope: string, action: string): void {
    this.actor(actor, scope);
    if (!(actor.kind === 'owner' && this.owners.has(actor.principalId)) && !(actor.kind === 'component' && this.serviceAction('reconciler', actor.principalId, action))) fail('FORBIDDEN', 'Only a trusted usage observer may reconcile budget');
  }
  private unfreezeRequired(): void { if (this.health().frozen) fail('BUDGET_OVERRUN', 'Usage overrun has frozen new authority and dispatch; reconcile through owner recovery'); }
  health(): { frozen: boolean; authEpoch: number; reason?: string } {
    this.assertCatalog();
    const row = this.row('SELECT auth_epoch,frozen,reason FROM shiyu_policy_meta WHERE id=1')!;
    if (!row || (row.frozen !== 0 && row.frozen !== 1) || !Number.isSafeInteger(row.auth_epoch) || (row.auth_epoch as number) < 0) fail('CORRUPT_POLICY', 'Invalid policy control state');
    return { frozen: row.frozen === 1, authEpoch: Number(row.auth_epoch), ...(row.reason ? { reason: String(row.reason) } : {}) };
  }
  private nextEpoch(): number {
    const current = integer(this.health().authEpoch, 'authEpoch', 0, Number.MAX_SAFE_INTEGER - 1);
    this.db.prepare('UPDATE shiyu_policy_meta SET auth_epoch=? WHERE id=1').run(current + 1); return current + 1;
  }
  private read(id: string): Mandate {
    this.assertCatalog();
    const row = this.row('SELECT * FROM shiyu_mandates WHERE id=?', text(id, 'mandateId'));
    if (!row) fail('NOT_FOUND', 'Mandate not found');
    const value = JSON.parse(String(row!.record_json)) as Mandate;
    if (value.schemaVersion !== 1 || value.mandateId !== row!.id || value.version !== row!.version || value.authEpoch !== row!.auth_epoch || !['active', 'suspended', 'revoked'].includes(value.state)) fail('CORRUPT_POLICY', 'Mandate record and projection disagree');
    budget(value.limits); list(value.subjectIds, 'subjectIds'); list(value.allowedActions, 'allowedActions'); list(value.allowedResources, 'allowedResources');
    text(value.issuer, 'issuer'); text(value.scope, 'scope'); time(value.validFrom, 'validFrom'); time(value.expiresAt, 'expiresAt');
    return value;
  }
  private reservation(id: string): BudgetReservation {
    this.assertCatalog();
    const row = this.row('SELECT * FROM shiyu_budget_reservations WHERE id=?', text(id, 'reservationId'));
    if (!row) fail('NOT_FOUND', 'Budget reservation not found');
    const value = JSON.parse(String(row!.record_json)) as BudgetReservation;
    if (value.schemaVersion !== 1 || value.reservationId !== row!.id || value.mandateId !== row!.mandate_id || value.version !== row!.version || !['reserved', 'unknown', 'settled'].includes(value.state)) fail('CORRUPT_POLICY', 'Reservation record and projection disagree');
    request(value); budget(value.amount); text(value.principalId, 'principalId'); time(value.leaseExpiresAt, 'leaseExpiresAt');
    object(value.observed, [...axes], value.state === 'settled' ? [...axes] : []);
    for (const axis of axes) if (value.observed[axis] !== undefined) integer(value.observed[axis], axis);
    return value;
  }
  private save(mandate: Mandate): Mandate {
    const version = mandate.version; mandate.version++; mandate.authEpoch = this.nextEpoch(); mandate.updatedAt = this.now();
    if (this.db.prepare('UPDATE shiyu_mandates SET version=?,auth_epoch=?,record_json=? WHERE id=? AND version=?').run(mandate.version, mandate.authEpoch, JSON.stringify(mandate), mandate.mandateId, version).changes !== 1) fail('VERSION_CONFLICT', 'Mandate changed');
    return clone(mandate);
  }
  private readable(actor: TrustedPolicyActor, mandate: Mandate): void {
    this.actor(actor, mandate.scope);
    if (!(actor.kind === 'owner' && this.owners.has(actor.principalId)) && !mandate.subjectIds.includes(actor.principalId) && !(actor.kind === 'component' && mandate.allowedActions.every(action => this.serviceAction('reconciler', actor.principalId, action) || this.serviceAction('dispatcher', actor.principalId, action)))) fail('FORBIDDEN', 'Mandate is not visible to this principal');
  }
  get(actor: TrustedPolicyActor, id: string): Mandate {
    const value = this.read(id); this.readable(actor, value);
    if (value.state !== 'revoked' && this.now() >= value.expiresAt) value.state = 'expired';
    return clone(value);
  }
  getReservation(actor: TrustedPolicyActor, id: string): BudgetReservation {
    const value = this.reservation(id); const mandate = this.read(value.mandateId); this.readable(actor, mandate);
    const observer = (actor.kind === 'owner' && this.owners.has(actor.principalId)) || (actor.kind === 'component' && mandate.allowedActions.every(action => this.serviceAction('reconciler', actor.principalId, action) || this.serviceAction('dispatcher', actor.principalId, action)));
    if (actor.principalId !== value.principalId && !observer) fail('FORBIDDEN', 'Reservation belongs to another principal');
    return clone(value);
  }
  grant(actor: TrustedPolicyActor, input: MandateInput): Mandate {
    object(input, ['id', 'scope', 'subjectIds', 'allowedActions', 'allowedResources', 'limits', 'basisRef', 'expiresAt', 'validFrom', 'maxExpiresAt'], ['id', 'scope', 'subjectIds', 'allowedActions', 'allowedResources', 'limits', 'basisRef', 'expiresAt']);
    const scope = text(input.scope, 'scope'); this.owner(actor, scope);
    return this.transactions.atomic(() => {
      const id = text(input.id, 'mandateId'); const old = this.row('SELECT * FROM shiyu_mandates WHERE id=?', id);
      const previous = old ? this.read(id) : undefined; const now = this.now();
      const specification = {
        mandateId: id, scope, issuer: actor.principalId, subjectIds: list(input.subjectIds, 'subjectIds'), allowedActions: list(input.allowedActions, 'allowedActions'),
        allowedResources: list(input.allowedResources, 'allowedResources'), limits: budget(input.limits), basisRef: text(input.basisRef, 'basisRef'),
        validFrom: time(input.validFrom ?? previous?.validFrom ?? now, 'validFrom'), expiresAt: time(input.expiresAt, 'expiresAt'), maxExpiresAt: time(input.maxExpiresAt ?? input.expiresAt, 'maxExpiresAt'),
      };
      const hash = digest(specification);
      if (old) { if (old.intent_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'Mandate ID has a different grant'); return this.get(actor, id); }
      this.unfreezeRequired();
      if (specification.allowedActions.some(action => !this.costs.has(action))) fail('UNKNOWN_ACTION', 'Action is absent from the trusted cost catalog');
      if (specification.validFrom >= specification.expiresAt || specification.expiresAt <= now || specification.expiresAt > specification.maxExpiresAt) fail('EXPIRED', 'Grant validity range is not allowed');
      const result: Mandate = { ...specification, schemaVersion: 1, policyVersion: 1, version: 1, authEpoch: this.nextEpoch(), state: 'active', createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO shiyu_mandates VALUES(?,?,?,?,?)').run(id, hash, 1, result.authEpoch, JSON.stringify(result));
      return clone(result);
    });
  }
  private control(actor: TrustedPolicyActor, input: { mandateId: string; expectedVersion: number }, state: 'active' | 'suspended' | 'revoked'): Mandate {
    object(input, ['mandateId', 'expectedVersion']);
    return this.transactions.atomic(() => {
      const mandate = this.read(input.mandateId); this.owner(actor, mandate.scope);
      if (mandate.version !== integer(input.expectedVersion, 'expectedVersion', 1)) fail('VERSION_CONFLICT', 'Mandate changed');
      if (state !== 'revoked') {
        if (mandate.state === 'revoked') fail('REVOKED', 'Revoked authority cannot resume');
        if (this.now() >= mandate.expiresAt) fail('EXPIRED', 'Expired authority cannot resume');
      }
      if (state === 'active') this.unfreezeRequired();
      if (mandate.state === state) return clone(mandate);
      mandate.state = state; return this.save(mandate);
    });
  }
  pause(actor: TrustedPolicyActor, input: { mandateId: string; expectedVersion: number }): Mandate { return this.control(actor, input, 'suspended'); }
  resume(actor: TrustedPolicyActor, input: { mandateId: string; expectedVersion: number }): Mandate { return this.control(actor, input, 'active'); }
  revoke(actor: TrustedPolicyActor, input: { mandateId: string; expectedVersion: number }): Mandate { return this.control(actor, input, 'revoked'); }
  private active(mandate: Mandate, input: PermitRequest): void {
    this.unfreezeRequired(); const now = this.now();
    if (mandate.state !== 'active') fail(mandate.state === 'revoked' ? 'REVOKED' : 'PAUSED', 'Mandate is not active');
    if (now < mandate.validFrom || now >= mandate.expiresAt) fail('EXPIRED', 'Mandate is outside its validity interval');
    if (mandate.version !== input.mandateVersion || mandate.authEpoch !== input.authEpoch) fail('STALE_AUTHORITY', 'Authorization version or epoch changed');
    if (mandate.scope !== input.scope || !mandate.allowedActions.includes(input.action) || input.resourceScopes.some(resource => !mandate.allowedResources.includes(resource))) fail('FORBIDDEN', 'Action, scope or exact resource is not granted');
  }
  private minimum(action: string, amount: Budget): void {
    const minimum = this.costs.get(action);
    if (!minimum) fail('UNKNOWN_ACTION', 'Action is absent from the trusted cost catalog');
    if (axes.some(axis => amount[axis] < minimum![axis])) fail('BUDGET_MINIMUM', 'Reservation does not cover this action’s minimum invocation cost');
  }
  balance(actor: TrustedPolicyActor, mandateId: string): { limits: Budget; spent: Budget; held: Budget; available: Budget } {
    const mandate = this.read(mandateId); this.readable(actor, mandate);
    const spent = zero(); const held = zero();
    for (const row of this.db.prepare('SELECT id FROM shiyu_budget_reservations WHERE mandate_id=?').all(mandateId)) {
      const value = this.reservation(String(row.id));
      for (const axis of axes) {
        const amount = value.state === 'settled' ? value.observed[axis]! : Math.max(value.amount[axis], value.observed[axis] ?? 0);
        const accumulator = value.state === 'settled' ? spent : held;
        accumulator[axis] += integer(amount, axis);
        if (!Number.isSafeInteger(accumulator[axis])) fail('CORRUPT_BUDGET', 'Budget arithmetic overflow');
      }
    }
    const available = zero(); for (const axis of axes) available[axis] = Math.max(0, mandate.limits[axis] - spent[axis] - held[axis]);
    return { limits: clone(mandate.limits), spent, held, available };
  }
  reserve(actor: TrustedPolicyActor, input: ReserveInput): BudgetReservation {
    object(input, ['reservationId', 'mandateId', 'mandateVersion', 'authEpoch', 'scope', 'action', 'resourceScopes', 'amount', 'leaseMs'], ['reservationId', 'mandateId', 'mandateVersion', 'authEpoch', 'scope', 'action', 'resourceScopes', 'amount']);
    const identity = request(input); const amount = budget(input.amount); const leaseMs = integer(input.leaseMs ?? 60000, 'leaseMs', 1, 600000);
    this.minimum(identity.action, amount);
    if (!axes.some(axis => amount[axis] > 0)) fail('INVALID_SCHEMA', 'A reservation must reserve a nonzero budget');
    this.actor(actor, identity.scope);
    return this.transactions.atomic(() => {
      const mandate = this.read(identity.mandateId); this.active(mandate, identity);
      this.subjectAction(actor, identity.action);
      if (!mandate.subjectIds.includes(actor.principalId)) fail('FORBIDDEN', 'Principal is not a grant subject');
      const hash = digest({ ...identity, principalId: actor.principalId, amount, leaseMs });
      const old = this.row('SELECT intent_hash FROM shiyu_budget_reservations WHERE id=?', identity.reservationId);
      if (old) { if (old.intent_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'Reservation ID has a different request'); return clone(this.reservation(identity.reservationId)); }
      const balance = this.balance(actor, identity.mandateId);
      if (axes.some(axis => amount[axis] > balance.available[axis])) fail('BUDGET_EXCEEDED', 'Budget is already spent or reserved');
      const now = this.now();
      const result: BudgetReservation = { ...identity, schemaVersion: 1, principalId: actor.principalId, amount, version: 1, state: 'reserved', observed: {}, overrun: false,
        leaseExpiresAt: new Date(Math.min(Date.parse(now) + leaseMs, Date.parse(mandate.expiresAt))).toISOString(), createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO shiyu_budget_reservations VALUES(?,?,?,?,?)').run(result.reservationId, result.mandateId, hash, 1, JSON.stringify(result));
      return clone(result);
    });
  }
  assertPermit(actor: TrustedPolicyActor, input: PermitRequest): Permit {
    object(input, ['reservationId', 'mandateId', 'mandateVersion', 'authEpoch', 'scope', 'action', 'resourceScopes']);
    const identity = request(input); this.actor(actor, identity.scope);
    return this.transactions.atomic(() => this.checkedPermit(actor, identity));
  }
  private checkedPermit(actor: TrustedPolicyActor, identity: PermitRequest): Permit {
    const reservation = this.reservation(identity.reservationId); this.active(this.read(identity.mandateId), identity);
    this.subjectAction(actor, identity.action);
    this.minimum(identity.action, reservation.amount);
    if (!same(request(reservation), identity)) fail('STALE_AUTHORITY', 'Permit does not match its reservation');
    if (actor.principalId !== reservation.principalId && !(actor.kind === 'component' && this.serviceAction('dispatcher', actor.principalId, identity.action))) fail('FORBIDDEN', 'Only the reserved principal or trusted dispatcher may use a permit');
    if (reservation.state !== 'reserved') fail('BUDGET_UNAVAILABLE', 'Unknown or settled reservations cannot authorize another invocation');
    if (this.now() >= reservation.leaseExpiresAt) fail('EXPIRED', 'Reservation lease expired; retained budget needs reconciliation');
    return { ...identity, principalId: reservation.principalId, reservationVersion: reservation.version, leaseExpiresAt: reservation.leaseExpiresAt, maxTokens: reservation.amount.tokens, budget: clone(reservation.amount) };
  }
  reconcile(actor: TrustedPolicyActor, input: ReconcileInput): BudgetReservation {
    object(input, ['receiptId', 'reservationId', 'expectedVersion', 'complete', 'usage', 'evidenceRef']);
    text(input.receiptId, 'receiptId'); text(input.reservationId, 'reservationId'); text(input.evidenceRef, 'evidenceRef'); integer(input.expectedVersion, 'expectedVersion', 1);
    if (typeof input.complete !== 'boolean') fail('INVALID_SCHEMA', 'complete must be a boolean');
    const raw = object(input.usage, [...axes], []); const usage: Partial<Budget> = {};
    for (const axis of axes) if (raw[axis] !== undefined && raw[axis] !== null) usage[axis] = integer(raw[axis], axis);
    if (input.complete && axes.some(axis => usage[axis] === undefined)) fail('INCOMPLETE_USAGE', 'Complete settlement requires every usage dimension');
    return this.transactions.atomic(() => {
      const reservation = this.reservation(input.reservationId); const mandate = this.read(reservation.mandateId); this.trustedReconciler(actor, mandate.scope, reservation.action);
      const hash = digest({ receiptId: input.receiptId, reservationId: input.reservationId, expectedVersion: input.expectedVersion,
        complete: input.complete, usage, evidenceRef: input.evidenceRef, observer: actor.principalId });
      const prior = this.row('SELECT receipt_hash,result_json FROM shiyu_budget_receipts WHERE id=?', input.receiptId);
      if (prior) { if (prior.receipt_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 'Usage receipt ID has different content'); return JSON.parse(String(prior.result_json)) as BudgetReservation; }
      if (reservation.version !== input.expectedVersion) fail('VERSION_CONFLICT', 'Reservation changed');
      if (reservation.state === 'settled' && !input.complete) fail('INVALID_STATE', 'Complete usage cannot become unknown again');
      for (const axis of axes) if (usage[axis] !== undefined && usage[axis]! < (reservation.observed[axis] ?? 0)) fail('USAGE_REGRESSION', 'Previously observed spending cannot decrease');
      const before = this.balance(actor, mandate.mandateId);
      const previousCharge = zero();
      for (const axis of axes) previousCharge[axis] = reservation.state === 'settled' ? reservation.observed[axis]! : Math.max(reservation.amount[axis], reservation.observed[axis] ?? 0);
      reservation.observed = { ...reservation.observed, ...usage };
      reservation.state = input.complete ? 'settled' : 'unknown'; reservation.version++; reservation.updatedAt = this.now();
      reservation.overrun ||= axes.some(axis => {
        const charge = reservation.state === 'settled' ? reservation.observed[axis]! : Math.max(reservation.amount[axis], reservation.observed[axis] ?? 0);
        return (reservation.observed[axis] ?? 0) > reservation.amount[axis] || before.spent[axis] + before.held[axis] - previousCharge[axis] + charge > mandate.limits[axis];
      });
      if (reservation.overrun) {
        this.db.prepare('UPDATE shiyu_policy_meta SET frozen=1,reason=? WHERE id=1').run(`Usage exceeded reservation ${reservation.reservationId}`);
        if (mandate.state !== 'revoked') mandate.state = 'suspended';
        this.save(mandate);
      }
      if (this.db.prepare('UPDATE shiyu_budget_reservations SET version=?,record_json=? WHERE id=? AND version=?').run(reservation.version, JSON.stringify(reservation), reservation.reservationId, input.expectedVersion).changes !== 1) fail('VERSION_CONFLICT', 'Reservation changed');
      this.db.prepare('INSERT INTO shiyu_budget_receipts VALUES(?,?,?,?)').run(input.receiptId, reservation.reservationId, hash, JSON.stringify(reservation));
      return clone(reservation);
    });
  }
}
