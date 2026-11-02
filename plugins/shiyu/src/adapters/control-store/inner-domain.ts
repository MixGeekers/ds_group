import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import {
  INNER_DOMAINS, MAX_INNER_SOURCE_REFS, MAX_INNER_VIEW_RECORDS,
  innerAudience, innerDigest, innerEvidenceVisible, innerFail, innerFields, innerId, innerInstant, innerInteger,
  innerOwnerCommandRequest, innerRecordDigest, innerSourceRefs, innerToken, innerCaptureHash, validateInnerCapture,
  validateInnerBodyRead, innerAudienceVisible,
  type InnerAudience, type InnerAuthority, type InnerBodyRead, type InnerBodyReadInput, type InnerCapture,
  type InnerCaptureInput, type InnerConversationFacts, type InnerDomain, type InnerEvidenceFacts,
  type InnerEvidenceState, type InnerRecordMetadata, type InnerSourceRef, type InnerWithdrawReceipt,
} from '../../contracts/inner.js';
import { SqliteTransactions } from './transaction.js';

export const INNER_SCOPE = 'local-owner';
const OWNER_AUDIENCE: InnerAudience = Object.freeze({ scope: INNER_SCOPE, kind: 'owner', audienceId: INNER_SCOPE });

export interface InnerDomainBaseOptions {
  domain: InnerDomain;
  runtimeIdentity: { hostEpoch: string; installationGeneration: string };
  policyVersion: number;
  /** Trusted same-Worker conversation/audience read. Never supplied from public JSON. */
  resolveConversation(conversationId: string): InnerConversationFacts | undefined;
  /** Trusted same-Worker evidence read for non-conversation sources. Must be synchronous. */
  resolveEvidence?(ref: InnerSourceRef, context: { audience: InnerAudience }): InnerEvidenceFacts | undefined;
  now?: () => Date;
}

export interface StoredInnerRecord {
  schemaVersion: 1;
  recordId: string;
  identity: string;
  revision: number;
  kind: string;
  status: string;
  domain: InnerDomain;
  audience: InnerAudience;
  sourceRefs: InnerSourceRef[];
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  supersedes?: string;
  payloadDigest: string;
  recordDigest: string;
}
interface Meta {
  schemaVersion: 1;
  authorityId: string;
  installationGeneration: string;
  policyVersion: number;
  revision: number;
  tombstoneWatermark: number;
  baselineId: string;
  installedAt: string;
}
type Row = Record<string, unknown>;

const recordKeys = ['schemaVersion', 'recordId', 'identity', 'revision', 'kind', 'status', 'domain', 'audience', 'sourceRefs',
  'observedAt', 'validFrom', 'validUntil', 'supersedes', 'payloadDigest', 'recordDigest'] as const;
const recordRequired = ['schemaVersion', 'recordId', 'identity', 'revision', 'kind', 'status', 'domain', 'audience', 'sourceRefs',
  'observedAt', 'payloadDigest', 'recordDigest'] as const;

function synchronous<T>(value: T): T {
  if (isPromise(value)) { void Promise.prototype.then.call(value, undefined, () => undefined); innerFail('ASYNC_INNER_SOURCE', 'Inner-domain sources must be synchronous'); }
  if (value && typeof (value as { then?: unknown }).then === 'function') innerFail('ASYNC_INNER_SOURCE', 'Inner-domain sources must be synchronous');
  return value;
}
function same(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x.localeCompare(y))) : item);
  return canonical(a) === canonical(b);
}

/**
 * Shared trusted local-control storage for the four H4 inner domains.
 *
 * This class owns mechanical invariants only: durable authority/revision/deletion
 * watermarks, provenance resolution, metadata-only captures, body separation and
 * idempotent receipts. Each domain file must keep its own payload schema,
 * status transitions and business invariants explicit; a domain may not use this
 * class to claim capabilities it does not implement.
 */
export abstract class InnerDomainBase {
  protected readonly domain: InnerDomain;
  protected readonly prefix: string;
  protected readonly identity: { hostEpoch: string; installationGeneration: string };
  private readonly options: InnerDomainBaseOptions;
  protected constructor(protected readonly db: DatabaseSync, protected readonly tx: SqliteTransactions, options: InnerDomainBaseOptions) {
    if (!tx.owns(db)) innerFail('TRANSACTION_MISMATCH', 'Inner domains require the shared control connection');
    innerFields(options, ['domain', 'runtimeIdentity', 'policyVersion', 'resolveConversation', 'resolveEvidence', 'now'],
      ['domain', 'runtimeIdentity', 'policyVersion', 'resolveConversation']);
    if (!INNER_DOMAINS.includes(options.domain)) innerFail('INVALID_INNER_CONFIGURATION', 'Invalid inner domain identity');
    innerFields(options.runtimeIdentity, ['hostEpoch', 'installationGeneration']);
    if (typeof options.resolveConversation !== 'function' || isAsyncFunction(options.resolveConversation)) {
      innerFail('INVALID_INNER_CONFIGURATION', 'Inner-domain conversation authority must be synchronous');
    }
    if (options.resolveEvidence !== undefined && (typeof options.resolveEvidence !== 'function' || isAsyncFunction(options.resolveEvidence))) {
      innerFail('INVALID_INNER_CONFIGURATION', 'Inner-domain evidence authority must be synchronous');
    }
    if (options.now !== undefined && (typeof options.now !== 'function' || isAsyncFunction(options.now))) innerFail('INVALID_INNER_CONFIGURATION', 'Invalid inner-domain clock');
    this.domain = options.domain;
    this.prefix = `shiyu_${options.domain}_`;
    this.identity = { hostEpoch: innerId(options.runtimeIdentity.hostEpoch, 'hostEpoch'), installationGeneration: innerId(options.runtimeIdentity.installationGeneration, 'installationGeneration') };
    this.options = options;
    this.tx.atomic(() => this.install());
  }

  /* ------------------------------ identity/clock ------------------------------ */
  protected now(): string {
    const value = synchronous(this.options.now?.() ?? new Date());
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) innerFail('INVALID_INNER_CLOCK', 'Invalid inner-domain clock');
    return value.toISOString();
  }
  ownedAudience(): InnerAudience { return { ...OWNER_AUDIENCE }; }
  protected conversation(conversationId: string): InnerConversationFacts {
    const value = synchronous(this.options.resolveConversation(innerId(conversationId, 'conversationId')));
    if (!value) innerFail('UNKNOWN_INNER_CONVERSATION', 'No trusted local conversation has this identity');
    const facts: InnerConversationFacts = {
      audience: innerAudience(value.audience),
      revision: innerInteger(value.revision, 'conversation revision'),
      audienceVersion: innerInteger(value.audienceVersion, 'audienceVersion'),
      active: value.active,
    };
    if (typeof facts.active !== 'boolean') innerFail('INVALID_INNER_CONFIGURATION', 'Invalid conversation activity flag');
    if (facts.audience.scope !== INNER_SCOPE) innerFail('INNER_AUDIENCE_FORBIDDEN', 'Inner domains are limited to the local-owner scope');
    return facts;
  }
  protected activeConversation(conversationId: string): InnerConversationFacts {
    const facts = this.conversation(conversationId);
    if (!facts.active) innerFail('INNER_CONVERSATION_INACTIVE', 'The audience is archived or no longer active');
    return facts;
  }

  /* --------------------------------- storage -------------------------------- */
  private tables(): string[] {
    return ['meta', 'records', 'bodies', 'evidence_tombstones', 'record_tombstones', 'commands'].map(name => `${this.prefix}${name}`);
  }
  private install(): void {
    const expected = this.tables();
    const existing = new Set((this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE ?").all(`${this.prefix}%`) as Row[]).map(row => String(row.name)));
    if (existing.size && expected.some(table => !existing.has(table))) innerFail('CORRUPT_INNER_DOMAIN', 'Inner-domain storage is incomplete; refusing to rebuild it');
    if (!existing.size) {
      this.db.exec(`
        CREATE TABLE ${this.prefix}meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,authority_id TEXT NOT NULL,
          installation_generation TEXT NOT NULL,policy_version INTEGER NOT NULL,revision INTEGER NOT NULL,
          tombstone_watermark INTEGER NOT NULL,baseline_id TEXT NOT NULL,installed_at TEXT NOT NULL);
        CREATE TABLE ${this.prefix}records(record_id TEXT PRIMARY KEY,identity TEXT NOT NULL,revision INTEGER NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json)),UNIQUE(identity,revision));
        CREATE INDEX ${this.prefix}records_identity ON ${this.prefix}records(identity,revision DESC);
        CREATE TABLE ${this.prefix}bodies(record_id TEXT PRIMARY KEY REFERENCES ${this.prefix}records(record_id),
          payload_digest TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
        CREATE TABLE ${this.prefix}evidence_tombstones(kind TEXT NOT NULL,source_id TEXT NOT NULL,watermark INTEGER NOT NULL,
          withdrawn_at TEXT NOT NULL,PRIMARY KEY(kind,source_id));
        CREATE TABLE ${this.prefix}record_tombstones(identity TEXT PRIMARY KEY,watermark INTEGER NOT NULL,withdrawn_at TEXT NOT NULL);
        CREATE TABLE ${this.prefix}commands(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,intent_hash TEXT NOT NULL,
          receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)));`);
    }
    this.installDomainTables();
    const metaRow = this.db.prepare(`SELECT * FROM ${this.prefix}meta WHERE id=1`).get() as Row | undefined;
    if (!metaRow) {
      for (const table of ['records', 'bodies', 'evidence_tombstones', 'record_tombstones', 'commands']) {
        const column = table === 'evidence_tombstones' ? 'kind' : table === 'record_tombstones' ? 'identity' : table === 'commands' ? 'request_id' : 'record_id';
        if (this.db.prepare(`SELECT ${column} FROM ${this.prefix}${table} LIMIT 1`).get()) innerFail('CORRUPT_INNER_DOMAIN', 'Inner-domain authority is missing but durable state remains');
      }
      const at = this.now();
      this.db.prepare(`INSERT INTO ${this.prefix}meta VALUES(1,1,?,?,?,0,0,?,?)`).run(
        randomUUID(), this.identity.installationGeneration, this.policyVersion(), randomUUID(), at);
    }
    const meta = this.meta();
    if (meta.policyVersion !== this.policyVersion()) innerFail('INCOMPATIBLE_INNER_POLICY', 'Inner-domain rules version needs an explicit migration');
    if (meta.installationGeneration !== this.identity.installationGeneration) {
      // A reinstall keeps the owner's local judgements but invalidates old captures via authority equality.
      this.db.prepare(`UPDATE ${this.prefix}meta SET installation_generation=?,revision=revision+1 WHERE id=1`).run(this.identity.installationGeneration);
    }
    this.initializeDomain();
  }
  protected policyVersion(): number { return innerInteger(this.options.policyVersion, 'policyVersion'); }
  protected installDomainTables(): void { /* domain-specific tables */ }
  protected initializeDomain(): void { /* domain-specific baseline, only on explicit install */ }
  protected meta(): Meta {
    this.tx.assertUsable();
    const row = this.db.prepare(`SELECT * FROM ${this.prefix}meta WHERE id=1`).get() as Row | undefined;
    if (!row || row.schema_version !== 1 || typeof row.authority_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(row.authority_id)
      || typeof row.installation_generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(row.installation_generation)
      || !Number.isSafeInteger(row.policy_version) || Number(row.policy_version) < 1 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
      || !Number.isSafeInteger(row.tombstone_watermark) || Number(row.tombstone_watermark) < 0
      || typeof row.baseline_id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.baseline_id)
      || typeof row.installed_at !== 'string' || !Number.isFinite(Date.parse(row.installed_at))) {
      innerFail('CORRUPT_INNER_DOMAIN', 'Inner-domain authority metadata is invalid');
    }
    return { schemaVersion: 1, authorityId: String(row.authority_id), installationGeneration: String(row.installation_generation),
      policyVersion: Number(row.policy_version), revision: Number(row.revision), tombstoneWatermark: Number(row.tombstone_watermark),
      baselineId: String(row.baseline_id), installedAt: String(row.installed_at) };
  }
  private saveMeta(meta: Meta): void {
    const changed = this.db.prepare(`UPDATE ${this.prefix}meta SET installation_generation=?,policy_version=?,revision=?,tombstone_watermark=? WHERE id=1`)
      .run(meta.installationGeneration, meta.policyVersion, meta.revision, meta.tombstoneWatermark);
    if (changed.changes !== 1) innerFail('CORRUPT_INNER_DOMAIN', 'Inner-domain authority disappeared');
  }
  private touch(): void { const meta = this.meta(); meta.revision = innerInteger(meta.revision + 1, 'revision', 0); this.saveMeta(meta); }
  /** Invalidation-relevant authority; excludes data revision so unrelated writes do not pin captures. */
  authority(): InnerAuthority {
    const meta = this.meta();
    return { domain: this.domain, authorityId: meta.authorityId, installationGeneration: meta.installationGeneration,
      policyVersion: meta.policyVersion, tombstoneWatermark: meta.tombstoneWatermark, baselineId: meta.baselineId };
  }

  /* ------------------------------- record rows ------------------------------ */
  private stored(value: unknown): StoredInnerRecord {
    innerFields(value, recordKeys, recordRequired);
    if (value.schemaVersion !== 1 || value.domain !== this.domain) innerFail('CORRUPT_INNER_DOMAIN', 'Stored inner record belongs to another schema or domain');
    return {
      schemaVersion: 1,
      recordId: innerId(value.recordId, 'recordId'),
      identity: innerId(value.identity, 'identity'),
      revision: innerInteger(value.revision, 'revision'),
      kind: innerToken(value.kind, 'record kind'),
      status: innerToken(value.status, 'record status'),
      domain: value.domain as InnerDomain,
      audience: innerAudience(value.audience),
      sourceRefs: innerSourceRefs(value.sourceRefs),
      observedAt: innerInstant(value.observedAt, 'observedAt'),
      ...(value.validFrom === undefined ? {} : { validFrom: innerInstant(value.validFrom, 'validFrom') }),
      ...(value.validUntil === undefined ? {} : { validUntil: innerInstant(value.validUntil, 'validUntil') }),
      ...(value.supersedes === undefined ? {} : { supersedes: innerId(value.supersedes, 'supersedes') }),
      payloadDigest: String(value.payloadDigest), recordDigest: String(value.recordDigest),
    };
  }
  private recordRows(): Row[] {
    this.tx.assertUsable();
    return this.db.prepare(`SELECT r.record_id,r.record_json,b.payload_digest FROM ${this.prefix}records r
      JOIN ${this.prefix}bodies b ON b.record_id=r.record_id ORDER BY r.record_id`).all() as Row[];
  }
  private checkedRecord(row: Row): StoredInnerRecord {
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.record_json)); } catch { innerFail('CORRUPT_INNER_DOMAIN', 'Stored inner record is not JSON'); }
    const record = this.stored(parsed);
    if (!/^[a-f0-9]{64}$/.test(record.payloadDigest) || !/^[a-f0-9]{64}$/.test(record.recordDigest)) innerFail('CORRUPT_INNER_DOMAIN', 'Stored inner digest is invalid');
    const expected = innerRecordDigest(record);
    if (expected !== record.recordDigest) innerFail('CORRUPT_INNER_DOMAIN', 'Stored inner record digest disagrees with its provenance');
    if (String(row.payload_digest) !== record.payloadDigest) innerFail('CORRUPT_INNER_DOMAIN', 'Stored inner body digest disagrees with its record');
    this.checkRecord(record);
    return record;
  }
  /** Domain-specific stored-metadata invariants; fail closed on every read. */
  protected checkRecord(record: StoredInnerRecord): void { void record; }
  protected abstract validatePayload(kind: string, payload: unknown): Record<string, unknown>;
  /** Whether a latest record participates in metadata captures (e.g. only the active profile). */
  protected captureEligible(record: StoredInnerRecord): boolean { void record; return true; }

  protected records(): StoredInnerRecord[] { this.meta(); return this.recordRows().map(row => this.checkedRecord(row)); }
  protected latestRecords(): StoredInnerRecord[] {
    const latest = new Map<string, StoredInnerRecord>();
    for (const record of this.records()) {
      const current = latest.get(record.identity);
      if (!current || record.revision > current.revision) latest.set(record.identity, record);
    }
    return [...latest.values()].sort((a, b) => a.recordId.localeCompare(b.recordId));
  }
  protected latest(identity: string): StoredInnerRecord | undefined {
    return this.latestRecords().find(record => record.identity === identity);
  }
  protected latestOrFail(identity: string): StoredInnerRecord {
    const record = this.latest(identity);
    if (!record) innerFail('UNKNOWN_INNER_RECORD', 'No inner record has this identity');
    return record;
  }
  protected record(recordId: string): StoredInnerRecord | undefined {
    innerId(recordId, 'recordId'); this.meta();
    const row = this.db.prepare(`SELECT r.record_id,r.record_json,b.payload_digest FROM ${this.prefix}records r
      JOIN ${this.prefix}bodies b ON b.record_id=r.record_id WHERE r.record_id=?`).get(recordId) as Row | undefined;
    return row ? this.checkedRecord(row) : undefined;
  }
  protected nextRevision(identity: string): number {
    const current = this.latest(identity);
    return current ? innerInteger(current.revision + 1, 'revision') : 1;
  }
  protected isIdentityTombstoned(identity: string): boolean {
    this.tx.assertUsable();
    return Boolean(this.db.prepare(`SELECT identity FROM ${this.prefix}record_tombstones WHERE identity=?`).get(identity));
  }
  protected isEvidenceTombstoned(ref: InnerSourceRef): boolean {
    this.tx.assertUsable();
    return Boolean(this.db.prepare(`SELECT kind FROM ${this.prefix}evidence_tombstones WHERE kind=? AND source_id=?`).get(ref.kind, ref.sourceId));
  }

  /** Insert one immutable revision plus its separated body. */
  protected persist(input: {
    recordId: string; identity: string; kind: string; status: string; audience: InnerAudience;
    sourceRefs: InnerSourceRef[]; observedAt?: string; validFrom?: string; validUntil?: string; supersedes?: string;
    payload: unknown;
  }): StoredInnerRecord {
    const payload = this.validatePayload(input.kind, input.payload);
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > 4096 * 4) innerFail('INVALID_INNER_INPUT', 'Inner payload exceeds its bound');
    const recordId = innerId(input.recordId, 'recordId');
    const identity = innerId(input.identity, 'identity');
    if (this.isIdentityTombstoned(identity)) innerFail('INNER_TOMBSTONED', 'A withdrawn inner identity cannot be recreated');
    if (this.record(recordId)) innerFail('INNER_RECORD_CONFLICT', 'Inner record identity already exists');
    const revision = this.nextRevision(identity);
    const observedAt = input.observedAt === undefined ? this.now() : innerInstant(input.observedAt, 'observedAt');
    if (input.validFrom !== undefined && Date.parse(input.validFrom) > Date.parse(observedAt)) innerFail('INVALID_INNER_INPUT', 'Validity cannot start after observation');
    if (input.validFrom !== undefined && input.validUntil !== undefined && Date.parse(input.validFrom) >= Date.parse(input.validUntil)) innerFail('INVALID_INNER_INPUT', 'Validity interval is empty');
    const payloadDigest = innerDigest(payload);
    const audience = innerAudience(input.audience);
    const sourceRefs = innerSourceRefs(input.sourceRefs);
    const base = { recordId, identity, revision, kind: innerToken(input.kind, 'record kind'), status: innerToken(input.status, 'record status'),
      audience, sourceRefs, observedAt, ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }) };
    const recordDigest = innerRecordDigest({ ...base, payloadDigest });
    const record: StoredInnerRecord = { schemaVersion: 1, domain: this.domain, ...base, payloadDigest, recordDigest };
    this.db.prepare(`INSERT INTO ${this.prefix}records VALUES(?,?,?,?)`).run(recordId, identity, revision, JSON.stringify(record));
    this.db.prepare(`INSERT INTO ${this.prefix}bodies VALUES(?,?,?)`).run(recordId, payloadDigest, payloadJson);
    this.touch();
    return structuredClone(record);
  }
  /** Status transitions are provenance-visible and invalidate captures that pinned the old bytes. */
  protected setStatus(record: StoredInnerRecord, status: string): StoredInnerRecord {
    innerToken(status, 'record status');
    const current = this.record(record.recordId);
    if (!current) innerFail('CORRUPT_INNER_DOMAIN', 'Inner record disappeared');
    if (current.revision !== record.revision) innerFail('INNER_RECORD_CONFLICT', 'Inner record revision changed');
    const next: StoredInnerRecord = { ...current, status, recordDigest: innerRecordDigest({ ...current, status }) };
    if (this.db.prepare(`UPDATE ${this.prefix}records SET record_json=? WHERE record_id=?`).run(JSON.stringify(next), record.recordId).changes !== 1) {
      innerFail('CORRUPT_INNER_DOMAIN', 'Inner record update affected no row');
    }
    this.touch();
    return structuredClone(next);
  }
  protected payload(record: StoredInnerRecord): Record<string, unknown> {
    const row = this.db.prepare(`SELECT payload_digest,payload_json FROM ${this.prefix}bodies WHERE record_id=?`).get(record.recordId) as Row | undefined;
    if (!row || String(row.payload_digest) !== record.payloadDigest) innerFail('CORRUPT_INNER_DOMAIN', 'Inner body is missing or changed');
    let parsed: unknown;
    try { parsed = JSON.parse(String(row.payload_json)); } catch { innerFail('CORRUPT_INNER_DOMAIN', 'Inner body is not JSON'); }
    const normalized = this.validatePayload(record.kind, parsed);
    if (innerDigest(normalized) !== record.payloadDigest) innerFail('CORRUPT_INNER_DOMAIN', 'Inner body digest disagrees with its record');
    return normalized;
  }

  /* -------------------------------- evidence -------------------------------- */
  private evidenceFact(ref: InnerSourceRef, audience: InnerAudience): 'valid' | 'invalid' {
    if (this.isEvidenceTombstoned(ref)) return 'invalid';
    if (ref.kind === 'owner-command') return innerOwnerCommandRequest(ref) === undefined ? 'invalid' : 'valid';
    if (ref.kind === 'conversation-observation') {
      let facts: InnerConversationFacts | undefined;
      try { facts = synchronous(this.options.resolveConversation(ref.sourceId)); } catch { return 'invalid'; }
      if (!facts || !facts.active) return 'invalid';
      const source = innerAudience(facts.audience);
      return innerEvidenceVisible(source, audience) ? 'valid' : 'invalid';
    }
    const resolver = this.options.resolveEvidence;
    if (!resolver) return 'invalid';
    let facts: InnerEvidenceFacts | undefined;
    try { facts = synchronous(resolver(structuredClone(ref), { audience: structuredClone(audience) })); } catch { return 'invalid'; }
    if (!facts || !facts.valid) return 'invalid';
    const source = innerAudience(facts.audience);
    return innerEvidenceVisible(source, audience) ? 'valid' : 'invalid';
  }
  protected evidenceState(record: StoredInnerRecord): InnerEvidenceState {
    if (this.isIdentityTombstoned(record.identity)) return 'revoked';
    let valid = 0, invalid = 0;
    for (const ref of record.sourceRefs) {
      if (this.evidenceFact(ref, record.audience) === 'valid') valid++; else invalid++;
    }
    return invalid === 0 ? 'valid' : valid === 0 ? 'revoked' : 'degraded';
  }
  /**
   * Write-time provenance check. Every reference resolves inside the writing
   * audience; a memory/task source must still be current; a conversation source
   * must be the same trusted audience. Returns the number of non-owner-command
   * (independently observable) references so domains can require real evidence.
   */
  protected assertWriteEvidence(sourceRefs: InnerSourceRef[], audience: InnerAudience, requestId: string): { refs: InnerSourceRef[]; external: number } {
    const refs = innerSourceRefs(sourceRefs);
    let external = 0;
    for (const ref of refs) {
      if (ref.kind === 'owner-command') {
        if (innerOwnerCommandRequest(ref) !== requestId) innerFail('INNER_SOURCE_INVALID', 'Owner-command provenance must name this exact trusted command');
        continue;
      }
      const state = this.evidenceFact(ref, audience);
      if (state !== 'valid') {
        if (ref.kind === 'memory-operation' && this.isEvidenceTombstoned(ref)) innerFail('INNER_SOURCE_REVOKED', 'A withdrawn source cannot support new inner state');
        innerFail('INNER_SOURCE_UNAVAILABLE', 'An evidence source is unavailable, withdrawn or outside this audience');
      }
      external++;
    }
    if (!external) innerFail('INNER_SOURCE_REQUIRED', 'Inner judgements require at least one independently observable source');
    return { refs, external };
  }
  protected ownerCommand(requestId: string): InnerSourceRef { return { kind: 'owner-command', sourceId: `owner-command:${innerId(requestId, 'requestId')}`, revision: 1 }; }

  /* -------------------------------- captures -------------------------------- */
  protected captureRecord(record: StoredInnerRecord, evidenceState: InnerEvidenceState): InnerRecordMetadata {
    return {
      recordId: record.recordId, revision: record.revision, kind: record.kind, status: record.status,
      evidenceState, audience: structuredClone(record.audience), sourceRefs: structuredClone(record.sourceRefs),
      observedAt: record.observedAt, ...(record.validUntil === undefined ? {} : { validUntil: record.validUntil }),
      recordDigest: record.recordDigest, bodyAvailable: evidenceState !== 'revoked',
    };
  }
  protected visibleLatest(conversationId: string): StoredInnerRecord[] {
    const facts = this.conversation(conversationId);
    return this.latestRecords().filter(record => {
      if (this.isIdentityTombstoned(record.identity)) return false;
      if (!innerAudienceVisible(record.audience, facts.audience)) return false;
      return this.captureEligible(record);
    });
  }
  captureForView(input: InnerCaptureInput): InnerCapture {
    innerFields(input, ['conversationId', 'recordIds'], ['conversationId']);
    const conversationId = innerId(input.conversationId, 'conversationId');
    const selected = input.recordIds === undefined ? undefined : boundedRecordIds(input.recordIds);
    return this.tx.atomic(() => {
      const facts = this.activeConversation(conversationId);
      const eligible = this.visibleLatest(conversationId);
      let records = eligible;
      if (selected) {
        const byId = new Map(eligible.map(record => [record.recordId, record]));
        records = selected.map(recordId => byId.get(recordId) ?? innerFail('INNER_VIEW_FORBIDDEN', 'A selected inner record is not visible in this audience'));
      }
      const truncated = !selected && records.length > MAX_INNER_VIEW_RECORDS;
      if (truncated) records = records.slice(0, MAX_INNER_VIEW_RECORDS);
      const metadata = records.map(record => this.captureRecord(record, this.evidenceState(record)));
      const header = { domain: this.domain, conversationId, capturedAt: this.now(), audience: structuredClone(facts.audience), authority: this.authority(), records: metadata, truncated };
      return { schemaVersion: 1 as const, ...header, snapshotHash: innerCaptureHash(header) };
    });
  }
  /** Fresh re-authorization of one pinned metadata capture; no body is read here. */
  validateForView(input: { capture: InnerCapture }): InnerCapture {
    innerFields(input, ['capture']);
    return this.tx.atomic(() => this.checkCapture(input.capture));
  }
  protected checkCapture(input: unknown): InnerCapture {
    const capture = validateInnerCapture(input);
    if (capture.domain !== this.domain) innerFail('INNER_CAPTURE_INVALIDATED', 'Capture belongs to another inner domain');
    const facts = this.activeConversation(capture.conversationId);
    if (!same(facts.audience, capture.audience)) innerFail('INNER_CAPTURE_INVALIDATED', 'The captured audience changed');
    if (!same(this.authority(), capture.authority)) innerFail('INNER_CAPTURE_INVALIDATED', 'Inner-domain authority or deletion barrier changed');
    for (const metadata of capture.records) {
      const current = this.record(metadata.recordId);
      if (!current || current.revision !== metadata.revision || current.recordDigest !== metadata.recordDigest) {
        innerFail('INNER_CAPTURE_INVALIDATED', 'A captured inner record changed or lost its authority');
      }
      if (this.isIdentityTombstoned(current.identity)) innerFail('INNER_CAPTURE_INVALIDATED', 'A captured inner source was withdrawn');
      if (this.evidenceState(current) !== metadata.evidenceState) innerFail('INNER_CAPTURE_INVALIDATED', 'A captured inner source changed availability');
      if (!innerAudienceVisible(current.audience, capture.audience)) innerFail('INNER_CAPTURE_INVALIDATED', 'A captured inner record left its audience');
    }
    return structuredClone(capture);
  }
  /** Exact content read: only for metadata captured for this audience; revalidates before returning bytes. */
  readBodies(input: InnerBodyReadInput): InnerBodyRead {
    innerFields(input, ['capture', 'recordIds']);
    const ids = boundedRecordIds(input.recordIds);
    return this.tx.atomic(() => {
      const capture = this.checkCapture(input.capture);
      const allowed = new Map(capture.records.map(record => [record.recordId, record]));
      const bodies = ids.map(recordId => {
        const metadata = allowed.get(recordId);
        if (!metadata) innerFail('INNER_BODY_FORBIDDEN', 'Requested body was not captured for this audience');
        if (!metadata.bodyAvailable) innerFail('INNER_BODY_FORBIDDEN', 'A withdrawn inner source has no readable body');
        const record = this.record(recordId) ?? innerFail('INNER_CAPTURE_INVALIDATED', 'Captured inner record disappeared');
        if (record.revision !== metadata.revision || record.recordDigest !== metadata.recordDigest) innerFail('INNER_CAPTURE_INVALIDATED', 'Captured inner record changed before its body read');
        return { recordId, revision: record.revision, kind: record.kind, evidenceState: metadata.evidenceState, payload: this.payload(record) };
      });
      return { schemaVersion: 1 as const, domain: this.domain, authority: structuredClone(capture.authority), capturedAt: capture.capturedAt, bodies };
    });
  }

  /* ------------------------------- withdrawals ------------------------------ */
  protected withdraw(input: { requestId: string; recordIds?: string[]; evidenceRefs?: InnerSourceRef[] }): InnerWithdrawReceipt {
    innerFields(input, ['requestId', 'recordIds', 'evidenceRefs'], ['requestId']);
    const requestId = innerId(input.requestId, 'requestId');
    const recordIds = input.recordIds === undefined ? [] : boundedRecordIds(input.recordIds, true);
    const evidenceRefs = input.evidenceRefs === undefined || (Array.isArray(input.evidenceRefs) && input.evidenceRefs.length === 0)
      ? [] : innerSourceRefs(input.evidenceRefs);
    if (!recordIds.length && !evidenceRefs.length) innerFail('INVALID_INNER_INPUT', 'A withdrawal must name records or evidence');
    const intent = { recordIds, evidenceRefs };
    return this.tx.atomic(() => this.command(requestId, 'withdraw', intent, () => {
      const meta = this.meta();
      let added = 0;
      for (const recordId of recordIds) {
        const record = this.record(recordId) ?? innerFail('UNKNOWN_INNER_RECORD', 'A withdrawn record does not exist');
        const changed = this.db.prepare(`INSERT OR IGNORE INTO ${this.prefix}record_tombstones VALUES(?,?,?)`)
          .run(record.identity, meta.tombstoneWatermark + 1, this.now()).changes;
        added += Number(changed);
      }
      for (const ref of evidenceRefs) {
        const changed = this.db.prepare(`INSERT OR IGNORE INTO ${this.prefix}evidence_tombstones VALUES(?,?,?,?)`)
          .run(ref.kind, ref.sourceId, meta.tombstoneWatermark + 1, this.now()).changes;
        added += Number(changed);
      }
      if (added) {
        meta.tombstoneWatermark = innerInteger(meta.tombstoneWatermark + 1, 'tombstoneWatermark', 0);
        meta.revision = innerInteger(meta.revision + 1, 'revision', 0);
        this.saveMeta(meta);
      }
      const receipt: InnerWithdrawReceipt = { requestId, withdrawnRecordIds: [...new Set(recordIds)].sort(), withdrawnEvidenceRefs: evidenceRefs,
        tombstoneWatermark: meta.tombstoneWatermark };
      return receipt;
    }));
  }

  /* ------------------------------ idempotency ------------------------------- */
  protected command<T>(requestId: string, kind: string, intent: unknown, run: () => T): T {
    const id = innerId(requestId, 'requestId');
    innerToken(kind, 'command kind');
    const intentHash = innerDigest(intent);
    const prior = this.db.prepare(`SELECT kind,intent_hash,receipt_json FROM ${this.prefix}commands WHERE request_id=?`).get(id) as Row | undefined;
    if (prior) {
      if (prior.kind !== kind || prior.intent_hash !== intentHash) innerFail('IDEMPOTENCY_CONFLICT', 'Inner command identity was reused with different input');
      let receipt: unknown;
      try { receipt = JSON.parse(String(prior.receipt_json)); } catch { innerFail('CORRUPT_INNER_DOMAIN', 'Inner command receipt is not JSON'); }
      innerFields(receipt, Object.keys(receipt as object));
      return structuredClone(receipt) as T;
    }
    const value = run();
    this.db.prepare(`INSERT INTO ${this.prefix}commands VALUES(?,?,?,?)`).run(id, kind, intentHash, JSON.stringify(value));
    return structuredClone(value);
  }
}

/* ------------------------------ local helpers ------------------------------ */
export function boundedRecordIds(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > MAX_INNER_VIEW_RECORDS || (!allowEmpty && !value.length)) innerFail('INVALID_INNER_INPUT', 'Invalid bounded record selection');
  const ids = value.map(item => innerId(item, 'recordId'));
  if (new Set(ids).size !== ids.length) innerFail('INVALID_INNER_INPUT', 'Duplicate record selection');
  return ids;
}
export { MAX_INNER_SOURCE_REFS };
