import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction, isPromise } from 'node:util/types';
import {
  LOCAL_NOTE_CAPABILITY_ID, capabilityFail as fail, capabilityFields as fields,
  capabilityHash, capabilityId as id, capabilityInstant as instant, capabilityInteger as integer,
  canonicalCapability, createLocalNoteDefinition, validateCapabilityBinding, validateCapabilityRef,
  validateCapabilitySnapshot, validateCapabilityTaskEvidence as evidence,
  type CapabilityAuthorityPort, type CapabilityBinding, type CapabilityCapture, type CapabilityCommands,
  type CapabilityCommandReceipt, type CapabilityDomainRequest, type CapabilityRef,
  type CapabilitySnapshot, type CapabilityTaskEvidence,
} from '../../contracts/capability.js';
import { SqliteTransactions } from './transaction.js';

export interface CapabilityDomainOptions {
  runtimeIdentity: { hostEpoch: string; installationGeneration: string };
  binding: CapabilityBinding;
  /** Trusted synchronous Task ledger reader, never a caller-supplied proof or external probe. */
  taskEvidence?: (taskId: string) => CapabilityTaskEvidence | undefined;
  now?: () => Date;
}
interface Observation {
  hostEpoch: string; binding: CapabilityBinding; status: CapabilitySnapshot['availability'];
  reasonCode: string; observedAt: string;
}
interface State {
  schemaVersion: 1; authorityId: string; revision: number; safetyRevision: number;
  definition: CapabilitySnapshot['definition']; binding: CapabilityBinding; enabled: boolean;
  hostEpoch: string; observation?: Observation; lastSuccess?: CapabilityTaskEvidence;
}
const TABLES = ['shiyu_capability_state', 'shiyu_capability_commands'];
const same = (a: unknown, b: unknown): boolean => canonicalCapability(a) === canonicalCapability(b);
function status(value: unknown): CapabilitySnapshot['availability'] {
  if (value !== 'available' && value !== 'unavailable' && value !== 'unknown') fail('INVALID_CAPABILITY_INPUT', 'Invalid capability availability');
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) fail('INVALID_CAPABILITY_INPUT', 'Expected a bounded capability reason code');
  return value;
}
function synchronous<T>(value: T): T {
  if (isPromise(value)) { void Promise.prototype.then.call(value, undefined, () => undefined); fail('ASYNC_CAPABILITY_SOURCE', 'Capability readers must be synchronous'); }
  if (value && typeof (value as { then?: unknown }).then === 'function') fail('ASYNC_CAPABILITY_SOURCE', 'Capability readers must be synchronous');
  return value;
}
function ref(state: State): CapabilityRef {
  return { capabilityId: LOCAL_NOTE_CAPABILITY_ID, authorityId: state.authorityId, safetyRevision: state.safetyRevision, ...state.binding };
}
function stable(ref: CapabilityRef): Omit<CapabilityRef, 'safetyRevision'> {
  const { safetyRevision: _revision, ...binding } = ref; return binding;
}

/** Fixed builtin state. This does not discover/execute tools, grant permission, or run verification tasks. */
export class CapabilityDomain implements CapabilityAuthorityPort {
  private readonly identity: CapabilityDomainOptions['runtimeIdentity'];
  private readonly binding: CapabilityBinding;
  private readonly taskEvidence?: CapabilityDomainOptions['taskEvidence'];
  private readonly clock?: CapabilityDomainOptions['now'];
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, options: CapabilityDomainOptions) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Capability state requires the shared connection');
    fields(options, ['runtimeIdentity', 'binding', 'taskEvidence', 'now'], ['runtimeIdentity', 'binding']);
    fields(options.runtimeIdentity, ['hostEpoch', 'installationGeneration']);
    this.identity = { hostEpoch: id(options.runtimeIdentity.hostEpoch), installationGeneration: id(options.runtimeIdentity.installationGeneration) };
    this.binding = validateCapabilityBinding(options.binding);
    if (this.binding.installationGeneration !== this.identity.installationGeneration) fail('INVALID_CAPABILITY_INPUT', 'Capability installation binding differs from the current host');
    for (const callback of [options.taskEvidence, options.now]) if (callback !== undefined && (typeof callback !== 'function' || isAsyncFunction(callback))) fail('ASYNC_CAPABILITY_SOURCE', 'Capability readers must be synchronous');
    this.taskEvidence = options.taskEvidence; this.clock = options.now;
    tx.atomic(() => {
      const existing = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN (?,?)").all(...TABLES);
      if (existing.length && existing.length !== TABLES.length) fail('CAPABILITY_STORAGE_INVALID', 'Capability state and command history must both exist');
      if (!existing.length) {
        db.exec(`CREATE TABLE shiyu_capability_state(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)));
          CREATE TABLE shiyu_capability_commands(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,intent_hash TEXT NOT NULL,receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)));`);
        const initial: State = { schemaVersion: 1, authorityId: `ability:${randomUUID()}`, revision: 1, safetyRevision: 1,
          definition: createLocalNoteDefinition(this.binding.definitionDigest), binding: this.binding, enabled: true, hostEpoch: this.identity.hostEpoch };
        db.prepare('INSERT INTO shiyu_capability_state VALUES(1,1,?)').run(JSON.stringify(initial));
      }
      const current = this.read();
      if (!same(current.binding, this.binding) || current.hostEpoch !== this.identity.hostEpoch) {
        current.binding = this.binding; current.definition = createLocalNoteDefinition(this.binding.definitionDigest);
        current.hostEpoch = this.identity.hostEpoch; delete current.observation;
        this.advance(current, true); this.save(current);
      }
    });
  }

  private now(): string {
    const value = synchronous(this.clock?.() ?? new Date());
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_CAPABILITY_INPUT', 'Invalid capability clock');
    return instant(value.toISOString());
  }
  private read(): State {
    this.tx.assertUsable();
    const rows = this.db.prepare('SELECT * FROM shiyu_capability_state').all();
    if (rows.length !== 1 || rows[0]!.id !== 1 || rows[0]!.schema_version !== 1) fail('CAPABILITY_STORAGE_INVALID', 'Missing or unsupported capability state');
    try {
      const value = JSON.parse(String(rows[0]!.record_json)) as State;
      fields(value, ['schemaVersion', 'authorityId', 'revision', 'safetyRevision', 'definition', 'binding', 'enabled', 'hostEpoch', 'observation', 'lastSuccess'],
        ['schemaVersion', 'authorityId', 'revision', 'safetyRevision', 'definition', 'binding', 'enabled', 'hostEpoch']);
      if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') throw new Error('Invalid capability schema');
      id(value.authorityId); integer(value.revision); integer(value.safetyRevision); id(value.hostEpoch);
      if (value.safetyRevision > value.revision || !same(validateCapabilityBinding(value.binding), value.binding)
        || !same(createLocalNoteDefinition(value.binding.definitionDigest), value.definition)) throw new Error('Invalid capability binding');
      if (value.observation !== undefined) {
        const live = value.observation;
        fields(live, ['hostEpoch', 'binding', 'status', 'reasonCode', 'observedAt']);
        if (id(live.hostEpoch) !== value.hostEpoch || !same(validateCapabilityBinding(live.binding), value.binding)) throw new Error('Invalid observation binding');
        status(live.status); reason(live.reasonCode); instant(live.observedAt);
      }
      if (value.lastSuccess !== undefined) {
        const proof = evidence(value.lastSuccess);
        if (proof.capabilityRef.authorityId !== value.authorityId || proof.capabilityRef.safetyRevision > value.safetyRevision) throw new Error('Invalid historical evidence authority');
      }
      return value;
    } catch (error) { return fail('CAPABILITY_STORAGE_INVALID', `Capability metadata is invalid: ${error instanceof Error ? error.message : 'invalid record'}`); }
  }
  private save(state: State): void {
    if (this.db.prepare('UPDATE shiyu_capability_state SET record_json=? WHERE id=1 AND schema_version=1').run(JSON.stringify(state)).changes !== 1) fail('CAPABILITY_STORAGE_INVALID', 'Capability state disappeared');
  }
  private advance(state: State, safety: boolean): void {
    state.revision = integer(state.revision + 1);
    if (safety) state.safetyRevision = integer(state.safetyRevision + 1);
  }
  private bound(state: State): boolean { return state.hostEpoch === this.identity.hostEpoch && same(state.binding, this.binding); }
  private trustedEvidence(taskId: string): CapabilityTaskEvidence | undefined {
    const value = synchronous(this.taskEvidence?.(taskId));
    if (value === undefined) return undefined;
    const checked = evidence(value);
    if (checked.taskId !== taskId) fail('INVALID_CAPABILITY_EVIDENCE', 'Task evidence has a different source identity');
    return checked;
  }
  private present(state: State): CapabilitySnapshot {
    const bound = this.bound(state), live = bound ? state.observation : undefined;
    const availability = live?.status ?? 'unknown';
    let verification: CapabilitySnapshot['verification'] = 'unknown';
    if (state.lastSuccess) {
      verification = 'stale';
      if (same(stable(state.lastSuccess.capabilityRef), stable(ref(state)))) {
        // Historical evidence is informational. A missing/unreadable source must
        // not prevent an owner from disabling the capability or invent a proof.
        try {
          const current = this.trustedEvidence(state.lastSuccess.taskId);
          if (current && same(current, state.lastSuccess)) verification = 'verified';
        } catch { verification = 'stale'; }
      }
    }
    return { schemaVersion: 1, authorityId: state.authorityId, revision: state.revision, safetyRevision: state.safetyRevision,
      definition: structuredClone(state.definition), binding: structuredClone(state.binding), declared: true, enabled: state.enabled,
      availability, verification, usableForAuthorizedTask: state.enabled && availability === 'available',
      reasonCode: !state.enabled ? 'CAPABILITY_DISABLED' : !bound ? 'CAPABILITY_HOST_CHANGED' : live?.reasonCode ?? 'CAPABILITY_NOT_OBSERVED',
      evidenceRefs: state.lastSuccess ? [state.lastSuccess.taskId, state.lastSuccess.assignmentId, state.lastSuccess.effectId, state.lastSuccess.receiptId] : [],
      ...(live ? { observedAt: live.observedAt } : {}), ...(state.lastSuccess ? { lastSuccess: structuredClone(state.lastSuccess) } : {}) };
  }
  private require(state: State): CapabilityRef {
    if (!this.bound(state) || !state.enabled || state.observation?.status !== 'available') fail('CAPABILITY_UNAVAILABLE', 'Local-note capability is disabled or has no available observation for this host');
    return ref(state);
  }
  snapshot(): CapabilitySnapshot { return this.tx.atomic(() => this.present(this.read())); }
  captureForCore(): CapabilityCapture {
    return this.tx.atomic(() => { const state = this.read(); return { schemaVersion: 1, capturedAt: this.now(), revision: state.revision, record: this.present(state), ref: ref(state) }; });
  }
  requireCurrent(): CapabilityRef { return this.tx.atomic(() => this.require(this.read())); }
  assertCurrent(input: CapabilityRef): void {
    const checked = validateCapabilityRef(input);
    this.tx.atomic(() => { const current = this.read();
      if (!same(checked, ref(current))) fail('CAPABILITY_CHANGED', 'Capability authority or safety binding changed');
      this.require(current);
    });
  }
  private replay(requestId: string, kind: string, intent: unknown): CapabilityCommandReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM shiyu_capability_commands WHERE request_id=?').get(requestId);
    if (!row) return undefined;
    if (row.kind !== kind || row.intent_hash !== capabilityHash(intent)) fail('IDEMPOTENCY_CONFLICT', 'Capability command identity was reused with different input');
    let receipt: CapabilityCommandReceipt;
    try {
      receipt = JSON.parse(String(row.receipt_json)) as CapabilityCommandReceipt;
      fields(receipt, ['requestId', 'changed', 'snapshot']);
      id(receipt.requestId); validateCapabilitySnapshot(receipt.snapshot);
    }
    catch { return fail('CAPABILITY_STORAGE_INVALID', 'Invalid capability command receipt'); }
    if (receipt.requestId !== requestId || typeof receipt.changed !== 'boolean' || receipt.snapshot?.schemaVersion !== 1) fail('CAPABILITY_STORAGE_INVALID', 'Invalid capability command receipt');
    return receipt;
  }
  private receipt(requestId: string, kind: string, intent: unknown, changed: boolean, state: State): CapabilityCommandReceipt {
    const receipt = { requestId, changed, snapshot: this.present(state) };
    this.db.prepare('INSERT INTO shiyu_capability_commands VALUES(?,?,?,?)').run(requestId, kind, capabilityHash(intent), JSON.stringify(receipt));
    return receipt;
  }
  private compare(state: State, expectedRevision: number): void {
    if (!this.bound(state)) fail('CAPABILITY_CHANGED', 'Only the current host binding may change capability state');
    if (state.revision !== expectedRevision) fail('CAPABILITY_CONFLICT', 'Capability revision changed; refresh before submitting a new command');
  }
  setEnabled(input: CapabilityCommands['ability.setEnabled']['input']): CapabilityCommandReceipt {
    fields(input, ['requestId', 'expectedRevision', 'enabled']); id(input.requestId); integer(input.expectedRevision);
    if (typeof input.enabled !== 'boolean') fail('INVALID_CAPABILITY_INPUT', 'Capability enabled must be boolean');
    return this.tx.atomic(() => {
      const replay = this.replay(input.requestId, 'setEnabled', input); if (replay) return replay;
      const current = this.read(); this.compare(current, input.expectedRevision);
      const changed = current.enabled !== input.enabled;
      if (changed) { current.enabled = input.enabled; this.advance(current, true); this.save(current); }
      return this.receipt(input.requestId, 'setEnabled', input, changed, current);
    });
  }
  observeLocalNote(input: CapabilityCommands['ability.observeLocalNote']['input']): CapabilityCommandReceipt {
    fields(input, ['requestId', 'expectedRevision', 'hostEpoch', 'binding', 'status', 'reasonCode']);
    id(input.requestId); integer(input.expectedRevision); id(input.hostEpoch); validateCapabilityBinding(input.binding); status(input.status); reason(input.reasonCode);
    return this.tx.atomic(() => {
      const replay = this.replay(input.requestId, 'observeLocalNote', input); if (replay) return replay;
      if (input.hostEpoch !== this.identity.hostEpoch || !same(input.binding, this.binding)) fail('CAPABILITY_CHANGED', 'Observation does not belong to this host and implementation');
      const current = this.read(); this.compare(current, input.expectedRevision);
      const observation: Observation = { hostEpoch: input.hostEpoch, binding: structuredClone(input.binding), status: input.status, reasonCode: input.reasonCode, observedAt: this.now() };
      const changed = !same(current.observation, observation);
      if (changed) {
        const safety = current.observation?.status !== input.status;
        current.observation = observation; this.advance(current, safety); this.save(current);
      }
      return this.receipt(input.requestId, 'observeLocalNote', input, changed, current);
    });
  }
  /** Internal post-completion projection; a Task id alone is not evidence. */
  recordSuccessfulTask(taskId: string): { recorded: boolean; snapshot: CapabilitySnapshot } {
    id(taskId);
    return this.tx.atomic(() => {
      const state = this.read(), proof = this.trustedEvidence(taskId);
      if (!this.bound(state) || !proof || !same(stable(proof.capabilityRef), stable(ref(state)))) return { recorded: false, snapshot: this.present(state) };
      if (proof.capabilityRef.safetyRevision > state.safetyRevision) fail('INVALID_CAPABILITY_EVIDENCE', 'Success evidence refers to a future safety revision');
      if (Date.parse(proof.observedAt) > Date.parse(this.now())) fail('INVALID_CAPABILITY_EVIDENCE', 'Success evidence cannot be from the future');
      if (state.lastSuccess && (same(state.lastSuccess, proof) || Date.parse(state.lastSuccess.observedAt) > Date.parse(proof.observedAt))) return { recorded: false, snapshot: this.present(state) };
      state.lastSuccess = proof; this.advance(state, false); this.save(state);
      return { recorded: true, snapshot: this.present(state) };
    });
  }
  execute(request: CapabilityDomainRequest): unknown {
    fields(request, ['command', 'args']);
    switch (request.command) {
      case 'ability.snapshot': fields(request.args, []); return this.snapshot();
      case 'ability.setEnabled': return this.setEnabled(request.args);
      case 'ability.observeLocalNote': return this.observeLocalNote(request.args);
      default: return fail('INVALID_CAPABILITY_INPUT', 'Unknown capability command');
    }
  }
}
