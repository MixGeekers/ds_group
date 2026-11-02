import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { goalCommandIdentity } from '../dsh/goals.js';
import type { GoalBinding, GoalBindingPort, GoalCommandReceipt, NativeGoalRef } from '../dsh/goals.js';
import { SqliteTransactions } from './transaction.js';

export const GOAL_BINDING_SCHEMA_VERSION = 1;
export class GoalBindingStoreError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GoalBindingStoreError'; }
}
const fail = (code: string, message: string): never => { throw new GoalBindingStoreError(code, message); };
const invalid = (message: string): never => fail('GOAL_BINDING_INVALID', message);
const fixed = ['goalId', 'sessionId', 'ownerId', 'scope', 'cwd', 'completionCriteriaHash'] as const;
const states = ['pending', 'unknown', 'confirmed', 'rejected'] as const;
function object(value: unknown, allowed: string[], required = allowed): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('Expected plain Goal binding metadata');
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid('Unknown or missing Goal metadata fields');
}
function text(value: unknown, field: string, limit = 2048): void {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) invalid(`Invalid ${field}`);
}
function positive(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`Invalid ${field}`);
}
function hash(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(`Invalid ${field}`);
}
function reference(value: NativeGoalRef): void {
  object(value, ['id', 'revision']); text(value.id, 'native Goal id'); positive(value.revision, 'native Goal revision');
}
function sameRef(left?: NativeGoalRef, right?: NativeGoalRef): boolean {
  return left?.id === right?.id && left?.revision === right?.revision;
}
function evidence(value: string[]): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) invalid('Invalid Goal evidence references');
  for (const item of value) text(item, 'Goal evidence reference');
}
function validateReceipt(receipt: GoalCommandReceipt): void {
  object(receipt, ['commandId', 'operation', 'status', 'expectedRef', 'postconditionHash', 'observedRef', 'evidenceRefs', 'completionProof', 'reason'], ['commandId', 'operation', 'status', 'postconditionHash']);
  text(receipt.commandId, 'commandId'); hash(receipt.postconditionHash, 'postconditionHash');
  if (!['create', 'update', 'pause', 'resume', 'complete'].includes(receipt.operation) || !states.includes(receipt.status)) invalid('Invalid Goal command operation or status');
  if (receipt.expectedRef !== undefined) reference(receipt.expectedRef);
  if (receipt.observedRef !== undefined) reference(receipt.observedRef);
  if (receipt.evidenceRefs !== undefined) evidence(receipt.evidenceRefs);
  if (receipt.reason !== undefined) text(receipt.reason, 'Goal command reason');
  if (receipt.operation === 'create' ? receipt.expectedRef !== undefined : receipt.expectedRef === undefined) invalid('Goal command expected reference does not match its operation');
  if (receipt.status === 'confirmed' && !receipt.observedRef) invalid('A confirmed command needs an observed native reference');
  if (receipt.completionProof !== undefined) {
    const proof = receipt.completionProof;
    object(proof, ['goalRef', 'completionCriteriaHash', 'evidenceRefs', 'verifierId', 'verifiedAt']);
    reference(proof.goalRef); hash(proof.completionCriteriaHash, 'completion proof criteria hash'); evidence(proof.evidenceRefs);
    text(proof.verifierId, 'completion verifier'); text(proof.verifiedAt, 'completion verification time');
    if (!Number.isFinite(Date.parse(proof.verifiedAt)) || !sameRef(proof.goalRef, receipt.expectedRef)
      || canonical(proof.evidenceRefs) !== canonical(receipt.evidenceRefs)) invalid('Completion proof does not match command evidence');
  }
  if (receipt.operation === 'complete' && !receipt.completionProof) invalid('Completion command needs an independent proof reference');
}
function validateBinding(binding: GoalBinding): void {
  object(binding, [...fixed, 'metadataVersion', 'goalRef', 'receipt'], [...fixed, 'metadataVersion']);
  for (const key of fixed) text(binding[key], key, key === 'cwd' ? 8192 : 2048);
  positive(binding.metadataVersion, 'metadataVersion'); hash(binding.completionCriteriaHash, 'completionCriteriaHash');
  if (!isAbsolute(binding.cwd) || resolve(binding.cwd) !== binding.cwd) invalid('Goal cwd must be an absolute normalized path');
  if (binding.goalRef !== undefined) reference(binding.goalRef);
  if (binding.receipt !== undefined) {
    validateReceipt(binding.receipt);
    if (binding.receipt.status === 'confirmed' && !sameRef(binding.goalRef, binding.receipt.observedRef)) invalid('Confirmed receipt must match the bound native reference');
    if (binding.receipt.completionProof && binding.receipt.completionProof.completionCriteriaHash !== binding.completionCriteriaHash) invalid('Completion proof criteria cannot change');
  }
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function parse<T>(value: unknown): T {
  if (typeof value !== 'string') return fail('GOAL_BINDING_CORRUPT', 'Missing persisted Goal metadata');
  try { return JSON.parse(value) as T; } catch { return fail('GOAL_BINDING_CORRUPT', 'Unreadable persisted Goal metadata'); }
}

/**
 * Trusted synchronous DB kernel. Construct only in the control DB Worker with
 * its existing transaction owner. It authenticates no JSON principal: the host
 * Goal adapter must authorize before calling, and no model/UI may invoke this
 * store directly. Native Goal phase, objective, rounds and execution stay in
 * DSH. This store owns neither a SQLite connection nor a native Session.
 *
 * compareAndSet commits binding + command journal in one BEGIN IMMEDIATE (or
 * the caller's savepoint). It performs no I/O beyond this same DB connection.
 * Reopening only checks schema; unresolved receipts remain unresolved.
 */
export class SQLiteGoalBindingStore {
  constructor(private readonly db: DatabaseSync, readonly transactions: SqliteTransactions) {
    if (!transactions.owns(db)) throw new Error('Goal bindings and transactions must use the same SQLite connection');
    this.transactions.atomic(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shiyu_goal_binding_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO shiyu_goal_binding_meta(id,version) VALUES(1,1);
      `);
      if (db.prepare('SELECT version FROM shiyu_goal_binding_meta WHERE id=1').get()?.version !== GOAL_BINDING_SCHEMA_VERSION) fail('GOAL_BINDING_SCHEMA', 'Unsupported Goal binding schema; existing data was preserved');
      db.exec(`
        CREATE TABLE IF NOT EXISTS shiyu_goal_bindings(
          goal_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, metadata_version INTEGER NOT NULL CHECK(metadata_version>=1),
          value TEXT NOT NULL CHECK(json_valid(value))
        );
        CREATE TABLE IF NOT EXISTS shiyu_goal_commands(
          goal_id TEXT NOT NULL REFERENCES shiyu_goal_bindings(goal_id) ON DELETE RESTRICT,
          command_id TEXT NOT NULL, identity_hash TEXT NOT NULL,
          first_metadata_version INTEGER NOT NULL CHECK(first_metadata_version>=1),
          last_metadata_version INTEGER NOT NULL CHECK(last_metadata_version>=first_metadata_version),
          value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(goal_id,command_id)
        );
        CREATE INDEX IF NOT EXISTS shiyu_goal_commands_history ON shiyu_goal_commands(goal_id,first_metadata_version);
        CREATE INDEX IF NOT EXISTS shiyu_goal_bindings_scope ON shiyu_goal_bindings(json_extract(value,'$.ownerId'),json_extract(value,'$.scope'),goal_id);
      `);
    });
  }

  load(goalId: string): GoalBinding | undefined {
    this.transactions.assertUsable(); text(goalId, 'goalId');
    // A single statement also observes the matching journal receipt in the same
    // SQLite snapshot, even while another independent connection commits.
    const row = this.db.prepare(`SELECT b.value,b.goal_id,b.session_id,b.metadata_version,
      c.value AS receipt_value,c.identity_hash FROM shiyu_goal_bindings b LEFT JOIN shiyu_goal_commands c
      ON c.goal_id=b.goal_id AND c.command_id=json_extract(b.value,'$.receipt.commandId') WHERE b.goal_id=?`).get(goalId);
    if (!row) return undefined;
    return this.decodeBinding(row);
  }

  /** A trusted caller fixes owner/scope before invoking; this is a filter, not authentication. */
  list(input: { ownerId: string; scope: string }): GoalBinding[] {
    this.transactions.assertUsable(); object(input, ['ownerId', 'scope']); text(input.ownerId, 'ownerId'); text(input.scope, 'scope');
    const rows = this.db.prepare(`SELECT b.value,b.goal_id,b.session_id,b.metadata_version,
      c.value AS receipt_value,c.identity_hash FROM shiyu_goal_bindings b LEFT JOIN shiyu_goal_commands c
      ON c.goal_id=b.goal_id AND c.command_id=json_extract(b.value,'$.receipt.commandId')
      WHERE json_extract(b.value,'$.ownerId')=? AND json_extract(b.value,'$.scope')=? ORDER BY b.goal_id`).all(input.ownerId, input.scope);
    return rows.map(row => this.decodeBinding(row));
  }

  private decodeBinding(row: Record<string, unknown>): GoalBinding {
    const binding = parse<GoalBinding>(row.value); validateBinding(binding);
    if (binding.goalId !== row.goal_id || binding.sessionId !== row.session_id || binding.metadataVersion !== row.metadata_version) fail('GOAL_BINDING_CORRUPT', 'Persisted binding indexes do not match metadata');
    if (binding.receipt && (row.identity_hash !== goalCommandIdentity(binding.receipt)
      || canonical(parse<GoalCommandReceipt>(row.receipt_value)) !== canonical(binding.receipt))) fail('GOAL_BINDING_CORRUPT', 'Binding and command journal disagree');
    return binding;
  }

  loadCommand(goalId: string, commandId: string): GoalCommandReceipt | undefined {
    this.transactions.assertUsable(); text(goalId, 'goalId'); text(commandId, 'commandId');
    const row = this.db.prepare('SELECT identity_hash,value FROM shiyu_goal_commands WHERE goal_id=? AND command_id=?').get(goalId, commandId);
    if (!row) return undefined;
    const receipt = parse<GoalCommandReceipt>(row.value); validateReceipt(receipt);
    if (receipt.commandId !== commandId || row.identity_hash !== goalCommandIdentity(receipt)) fail('GOAL_BINDING_CORRUPT', 'Command identity and journal disagree');
    return receipt;
  }

  compareAndSet(expectedMetadataVersion: number | undefined, input: GoalBinding): void {
    this.transactions.assertUsable();
    if (expectedMetadataVersion !== undefined) positive(expectedMetadataVersion, 'expectedMetadataVersion');
    validateBinding(input);
    if (input.metadataVersion !== (expectedMetadataVersion === undefined ? 1 : expectedMetadataVersion + 1)) invalid('Goal metadata version must start at one and advance exactly once');
    const binding = structuredClone(input), serialized = canonical(binding);
    this.transactions.atomic(() => {
      const old = this.load(binding.goalId);
      if (old?.metadataVersion !== expectedMetadataVersion) fail('GOAL_BINDING_CONFLICT', 'Goal binding changed before compare-and-set');
      if (old && fixed.some(key => old[key] !== binding[key])) fail('GOAL_BINDING_CONFLICT', 'Goal ownership, scope, cwd, Session and completion criteria are immutable');
      const sessionOwner = this.db.prepare('SELECT goal_id FROM shiyu_goal_bindings WHERE session_id=?').get(binding.sessionId);
      if (sessionOwner && sessionOwner.goal_id !== binding.goalId) fail('GOAL_BINDING_CONFLICT', 'Native Session is already bound to another Goal');
      if (old?.receipt && !binding.receipt) fail('GOAL_COMMAND_CONFLICT', 'Current command receipt cannot be removed');
      if (old?.goalRef && (!binding.goalRef || old.goalRef.id !== binding.goalRef.id || old.goalRef.revision > binding.goalRef.revision)) fail('GOAL_BINDING_CONFLICT', 'Native Goal identity cannot change or move backwards');
      if (old && !sameRef(old.goalRef, binding.goalRef) && binding.receipt?.status !== 'confirmed') fail('GOAL_BINDING_CONFLICT', 'Only a confirmed native observation may advance the bound reference');

      const receipt = binding.receipt;
      if (receipt) {
        const previous = this.loadCommand(binding.goalId, receipt.commandId);
        if (previous) {
          if (goalCommandIdentity(previous) !== goalCommandIdentity(receipt)) fail('GOAL_COMMAND_CONFLICT', 'Command ID already identifies different content');
          if (old?.receipt?.commandId !== receipt.commandId) fail('GOAL_COMMAND_REPLAY', 'A historical command cannot become current again');
          const transitions: Record<GoalCommandReceipt['status'], readonly GoalCommandReceipt['status'][]> = {
            pending: ['unknown', 'confirmed', 'rejected'], unknown: ['unknown', 'confirmed'], confirmed: ['confirmed', 'unknown'], rejected: ['rejected'],
          };
          if (!transitions[previous.status].includes(receipt.status)) fail('GOAL_COMMAND_CONFLICT', 'Command receipt cannot return to dispatchable pending state');
        } else {
          if (receipt.status !== 'pending') fail('GOAL_COMMAND_CONFLICT', 'A new command must first persist as pending');
          if (old?.receipt && ['pending', 'unknown'].includes(old.receipt.status)) fail('GOAL_COMMAND_UNRESOLVED', 'Current command needs reconciliation before another command');
          if (receipt.operation === 'create' ? binding.goalRef !== undefined : !sameRef(receipt.expectedRef, old?.goalRef)) fail('GOAL_BINDING_CONFLICT', 'New command does not target the current native reference');
        }
      }

      this.db.prepare(`INSERT INTO shiyu_goal_bindings(goal_id,session_id,metadata_version,value) VALUES(?,?,?,?)
        ON CONFLICT(goal_id) DO UPDATE SET metadata_version=excluded.metadata_version,value=excluded.value`)
        .run(binding.goalId, binding.sessionId, binding.metadataVersion, serialized);
      if (receipt) this.db.prepare(`INSERT INTO shiyu_goal_commands(goal_id,command_id,identity_hash,first_metadata_version,last_metadata_version,value)
        VALUES(?,?,?,?,?,?) ON CONFLICT(goal_id,command_id) DO UPDATE SET last_metadata_version=excluded.last_metadata_version,value=excluded.value`)
        .run(binding.goalId, receipt.commandId, goalCommandIdentity(receipt), binding.metadataVersion, binding.metadataVersion, canonical(receipt));
    });
  }

  /** For trusted adapters outside atomic callbacks; production may use an IPC proxy instead. */
  asPort(): GoalBindingPort {
    return { load: async goalId => this.load(goalId), loadCommand: async (goalId, commandId) => this.loadCommand(goalId, commandId),
      compareAndSet: async (expected, binding) => this.compareAndSet(expected, binding) };
  }
}
