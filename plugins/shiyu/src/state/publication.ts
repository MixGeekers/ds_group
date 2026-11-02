import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SqliteTransactions } from '../adapters/control-store/transaction.js';

export const STATE_DOMAINS = ['memory', 'relationship', 'emotion', 'cognition', 'personality', 'ability'] as const;
export type StateDomain = typeof STATE_DOMAINS[number];
export const UNAVAILABLE_REASONS = ['not_connected', 'not_implemented', 'source_unavailable', 'verification_pending', 'incompatible_version'] as const;
export type UnavailableReason = typeof UNAVAILABLE_REASONS[number];
export interface UnavailableDomain { status: 'unavailable'; reason: UnavailableReason }
/** Frozen 3C schema: every domain is explicitly unavailable. */
export interface LegacyStateManifest { schemaVersion: 1; domains: Record<StateDomain, UnavailableDomain> }
export interface AvailableMemoryDomain {
  status: 'available'; backendId: string; deploymentId: string;
  capabilities: ['exact_read'] | ['exact_read', 'semantic_search'];
  /** Identifies a verified semantic profile, never an index completion watermark. */
  profileFingerprint?: string;
}
/** Availability metadata only; memory bodies, safety vectors and index receipts stay with their authorities. */
export interface MemoryStateManifest {
  schemaVersion: 2;
  domains: Record<Exclude<StateDomain, 'memory'>, UnavailableDomain> & { memory: UnavailableDomain | AvailableMemoryDomain };
}
export type StateManifest = LegacyStateManifest | MemoryStateManifest;
export interface PublishedState {
  schemaVersion: 1; baselineId: string; stateVersion: number; manifest: StateManifest;
  manifestHash: string; publishedAt: string; publisherId: string;
}
export interface StatePublishCommand { requestId: string; expectedStateVersion?: number; expectedBaselineId?: string; manifest: StateManifest }
export interface StatePublicationReceipt {
  requestId: string; publisherId: string; status: 'published' | 'unchanged'; recordedAt: string;
  /** The publication observed by this command, not a pointer to a subsequently changed head. */
  publication: PublishedState;
}
declare const publisherBrand: unique symbol;
export interface StatePublisher { readonly principalId: string; readonly [publisherBrand]: true }
export interface StatePublicationOptions { publisherIds: readonly string[]; now?: () => Date }
export class StatePublicationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'StatePublicationError'; }
}
type Tx = Pick<SqliteTransactions, 'atomic' | 'owns' | 'assertUsable'>;
type Row = Record<string, unknown>;
const publishers = new WeakMap<object, string>();
function fail(code: string, message: string): never { throw new StatePublicationError(code, message); }
const clone = <T>(value: T): T => structuredClone(value);
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value)) fail('INVALID_SCHEMA', `Invalid ${label}`);
  return value as string;
}
function plain(value: unknown, keys: readonly string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_SCHEMA', 'Expected bounded plain publication metadata');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(fields).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(fields, key))
    || Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) fail('INVALID_SCHEMA', 'Unknown, accessor or missing publication fields');
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('INVALID_SCHEMA', 'State versions are positive safe integers');
  return value as number;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_SCHEMA', 'Expected canonical UTC publication time');
  return value as string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function availableMemory(value: unknown): AvailableMemoryDomain {
  const item = plain(value, ['status', 'backendId', 'deploymentId', 'capabilities', 'profileFingerprint'], ['status', 'backendId', 'deploymentId', 'capabilities']);
  const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,199}$/.test(value);
  if (item.status !== 'available' || !identity(item.backendId) || !identity(item.deploymentId)
    || !Array.isArray(item.capabilities) || ![1, 2].includes(item.capabilities.length)
    || item.capabilities[0] !== 'exact_read' || (item.capabilities.length === 2 && item.capabilities[1] !== 'semantic_search')) fail('INVALID_MANIFEST', 'Invalid available memory identity or capabilities');
  const semantic = item.capabilities.length === 2;
  if (semantic ? typeof item.profileFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.profileFingerprint)
    : Object.hasOwn(item, 'profileFingerprint')) fail('INVALID_MANIFEST', 'Semantic memory requires its exact profile fingerprint; exact-only memory has no profile');
  return { status: 'available', backendId: item.backendId, deploymentId: item.deploymentId,
    capabilities: semantic ? ['exact_read', 'semantic_search'] : ['exact_read'],
    ...(semantic ? { profileFingerprint: item.profileFingerprint as string } : {}) };
}
function manifest(value: unknown): StateManifest {
  const root = plain(value, ['schemaVersion', 'domains']);
  if (root.schemaVersion !== 1 && root.schemaVersion !== 2) fail('INCOMPATIBLE_VERSION', 'Unsupported state manifest schema');
  const domains = plain(root.domains, STATE_DOMAINS);
  const result = {} as MemoryStateManifest['domains'];
  for (const domain of STATE_DOMAINS) {
    if (root.schemaVersion === 2 && domain === 'memory' && plain(domains.memory, ['status', 'reason', 'backendId', 'deploymentId', 'capabilities', 'profileFingerprint'], ['status']).status === 'available') {
      result.memory = availableMemory(domains.memory); continue;
    }
    const item = plain(domains[domain], ['status', 'reason']);
    if (item.status !== 'unavailable' || !UNAVAILABLE_REASONS.includes(item.reason as UnavailableReason)) fail('INVALID_MANIFEST', 'Only schema2 memory can be available; other domains require a registered unavailable reason');
    result[domain] = { status: 'unavailable', reason: item.reason as UnavailableReason };
  }
  return root.schemaVersion === 1 ? { schemaVersion: 1, domains: result as LegacyStateManifest['domains'] } : { schemaVersion: 2, domains: result };
}
/** Trusted composition only: never expose this factory as a model or UI command. */
export function createStatePublisher(principalId: string): StatePublisher {
  const id = text(principalId, 'publisher identity');
  const capability = Object.freeze({ principalId: id }) as StatePublisher;
  publishers.set(capability, id);
  return capability;
}
export function initialStateManifest(): LegacyStateManifest {
  return { schemaVersion: 1, domains: Object.fromEntries(STATE_DOMAINS.map(domain => [domain, { status: 'unavailable', reason: 'not_connected' }])) as Record<StateDomain, UnavailableDomain> };
}

/**
 * One control-DB owner for the published inner-state manifest. A publication is
 * not a Task/Conversation version, authorization epoch, deletion barrier, or a
 * distributed component snapshot. Only explicit publish commands advance it.
 * No model, backend, filesystem or other external I/O belongs in these methods.
 * Domain data remains with its existing owner; this store retains no memory body.
 */
export class StatePublicationStore {
  private readonly publisherIds: ReadonlySet<string>;
  constructor(private readonly db: DatabaseSync, private readonly tx: Tx, private readonly options: StatePublicationOptions) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'State publication must use the shared transaction connection');
    if (!Array.isArray(options.publisherIds) || !options.publisherIds.length || options.publisherIds.length > 32) fail('INVALID_SCHEMA', 'A bounded trusted publisher set is required');
    const ids = options.publisherIds.map(id => text(id, 'publisher identity'));
    if (new Set(ids).size !== ids.length) fail('INVALID_SCHEMA', 'Duplicate publisher identity');
    this.publisherIds = new Set(ids);
    const policyHash = digest([...ids].sort());
    tx.atomic(() => {
      const installed = this.row("SELECT name FROM sqlite_schema WHERE type='table' AND name='shiyu_state_publication_meta'") !== undefined;
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_state_publication_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,baseline_id TEXT NOT NULL,publisher_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_state_publication_head(id INTEGER PRIMARY KEY CHECK(id=1),state_version INTEGER NOT NULL CHECK(state_version>=1),record_json TEXT NOT NULL CHECK(json_valid(record_json)));
        CREATE TABLE IF NOT EXISTS shiyu_state_publication_commands(request_id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)));`);
      const existing = this.row('SELECT * FROM shiyu_state_publication_meta WHERE id=1');
      if (!existing) {
        if (installed || this.row('SELECT id FROM shiyu_state_publication_head LIMIT 1') || this.row('SELECT request_id FROM shiyu_state_publication_commands LIMIT 1')) fail('CORRUPT_STATE', 'Publication baseline is missing; refusing to reset existing progress');
        db.prepare('INSERT INTO shiyu_state_publication_meta VALUES(1,1,?,?)').run(randomUUID(), policyHash);
      }
      const metadata = this.metadata();
      if (metadata.publisher_hash !== policyHash) fail('INCOMPATIBLE_POLICY', 'Changing trusted publishers requires an explicit migration');
      this.current();
    });
  }
  private row(sql: string, ...args: string[]): Row | undefined { this.tx.assertUsable(); return this.db.prepare(sql).get(...args) as Row | undefined; }
  private metadata(): Row {
    const row = this.row('SELECT * FROM shiyu_state_publication_meta WHERE id=1');
    if (!row || row.schema_version !== 1 || typeof row.baseline_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.baseline_id)
      || typeof row.publisher_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.publisher_hash)) fail('CORRUPT_STATE', 'Missing or unsupported publication baseline');
    return row;
  }
  private parsed(value: unknown): unknown {
    try { if (typeof value !== 'string') throw new Error(); return JSON.parse(value); }
    catch { return fail('CORRUPT_STATE', 'Invalid stored publication metadata'); }
  }
  private publication(value: unknown): PublishedState {
    const row = plain(value, ['schemaVersion', 'baselineId', 'stateVersion', 'manifest', 'manifestHash', 'publishedAt', 'publisherId']);
    const body = manifest(row.manifest);
    if (row.schemaVersion !== 1 || row.baselineId !== this.metadata().baseline_id || row.manifestHash !== digest(body) || !this.publisherIds.has(String(row.publisherId))) fail('CORRUPT_STATE', 'Publication identity or manifest does not match its authority');
    return { schemaVersion: 1, baselineId: String(row.baselineId), stateVersion: positive(row.stateVersion), manifest: body,
      manifestHash: String(row.manifestHash), publishedAt: instant(row.publishedAt), publisherId: text(row.publisherId, 'publisher identity') };
  }
  private current(): PublishedState | undefined {
    const row = this.row('SELECT state_version,record_json FROM shiyu_state_publication_head WHERE id=1');
    if (!row) {
      if (this.row('SELECT request_id FROM shiyu_state_publication_commands LIMIT 1')) fail('CORRUPT_STATE', 'Publication head is missing but command history exists');
      return undefined;
    }
    const publication = this.publication(this.parsed(row.record_json));
    if (publication.stateVersion !== row.state_version) fail('CORRUPT_STATE', 'Publication head and version disagree');
    return publication;
  }
  private prior(requestId: string, intentHash: string): StatePublicationReceipt | undefined {
    const row = this.row('SELECT intent_hash,record_json FROM shiyu_state_publication_commands WHERE request_id=?', requestId);
    if (!row) return undefined;
    if (row.intent_hash !== intentHash) fail('IDEMPOTENCY_CONFLICT', 'requestId already identifies a different publication command');
    const receipt = plain(this.parsed(row.record_json), ['requestId', 'publisherId', 'status', 'recordedAt', 'publication']);
    if (receipt.requestId !== requestId || !this.publisherIds.has(String(receipt.publisherId)) || !['published', 'unchanged'].includes(String(receipt.status))) fail('CORRUPT_STATE', 'Invalid publication command receipt');
    return { requestId, publisherId: String(receipt.publisherId), status: receipt.status as StatePublicationReceipt['status'], recordedAt: instant(receipt.recordedAt), publication: this.publication(receipt.publication) };
  }
  /** No publication exists before the first committed publish; reads never initialize version zero. */
  get(): PublishedState | undefined { return this.tx.atomic(() => { this.metadata(); return this.current(); }); }
  publish(actor: StatePublisher, command: StatePublishCommand): StatePublicationReceipt {
    const publisherId = actor && typeof actor === 'object' ? publishers.get(actor) : undefined;
    if (!publisherId || !this.publisherIds.has(publisherId)) fail('FORBIDDEN', 'An original trusted publisher capability is required');
    plain(command, ['requestId', 'expectedStateVersion', 'expectedBaselineId', 'manifest'], ['requestId', 'manifest']);
    const requestId = text(command.requestId, 'publication requestId');
    const expected = command.expectedStateVersion === undefined ? undefined : positive(command.expectedStateVersion);
    const expectedBaseline = command.expectedBaselineId === undefined ? undefined : text(command.expectedBaselineId, 'expected baseline');
    if ((expected === undefined) !== (expectedBaseline === undefined)) fail('INVALID_SCHEMA', 'Expected state version and baseline must be supplied together');
    const body = manifest(command.manifest);
    const intentHash = digest({ publisherId, expectedStateVersion: expected ?? null, expectedBaselineId: expectedBaseline ?? null, manifest: body });
    return this.tx.atomic(() => {
      const duplicate = this.prior(requestId, intentHash); if (duplicate) return clone(duplicate);
      const current = this.current();
      if (current?.stateVersion !== expected || current?.baselineId !== expectedBaseline) fail('VERSION_CONFLICT', 'Published state changed; use its current baseline and version');
      // Historical schema1 commands remain replayable above. A new command must
      // not silently remove the meaning of an already adopted manifest schema.
      if (current?.manifest.schemaVersion === 2 && body.schemaVersion === 1) fail('SCHEMA_DOWNGRADE', 'Use a schema2 unavailable declaration instead of downgrading the manifest');
      const recordedAt = instant((this.options.now?.() ?? new Date()).toISOString());
      const unchanged = current !== undefined && canonical(current.manifest) === canonical(body);
      let publication = current;
      if (!unchanged) {
        if (!current && (body.schemaVersion !== 1 || STATE_DOMAINS.some(domain => body.domains[domain].reason !== 'not_connected'))) fail('INVALID_INITIAL_MANIFEST', 'The initial publication must explicitly leave all six domains not connected under schema1');
        if (current?.stateVersion === Number.MAX_SAFE_INTEGER) fail('VERSION_EXHAUSTED', 'Published state version is exhausted');
        publication = { schemaVersion: 1, baselineId: String(this.metadata().baseline_id), stateVersion: (current?.stateVersion ?? 0) + 1,
          manifest: body, manifestHash: digest(body), publishedAt: recordedAt, publisherId };
        if (!current) this.db.prepare('INSERT INTO shiyu_state_publication_head VALUES(1,?,?)').run(publication.stateVersion, JSON.stringify(publication));
        else {
          const changed = this.db.prepare('UPDATE shiyu_state_publication_head SET state_version=?,record_json=? WHERE id=1 AND state_version=?').run(publication.stateVersion, JSON.stringify(publication), current.stateVersion);
          if (changed.changes !== 1) fail('VERSION_CONFLICT', 'Publication head changed before commit');
        }
      }
      const result: StatePublicationReceipt = { requestId, publisherId, status: unchanged ? 'unchanged' : 'published', recordedAt, publication: publication! };
      this.db.prepare('INSERT INTO shiyu_state_publication_commands VALUES(?,?,?)').run(requestId, intentHash, JSON.stringify(result));
      return clone(result);
    });
  }
}
