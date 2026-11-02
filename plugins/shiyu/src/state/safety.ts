import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteTransactions } from '../adapters/control-store/transaction.js';

export const LOCAL_TASK_FIELDS = ['taskId', 'title', 'state', 'version', 'updatedAt', 'stopRequested'] as const;
export interface LocalReadSafety {
  schemaVersion: 1; policyAuthorityId: string; policyVersion: number; enabled: boolean;
  deletionAuthorityId: string; deletionScope: 'local-task-source'; tombstoneWatermark: number;
  baseline: 'since-local-read-authority-installation'; installedAt: string;
  /** Existing MandateStore global epoch; this module owns no second authEpoch. */
  authEpoch: number;
}
declare const ownerBrand: unique symbol;
export interface LocalReadOwner { readonly principalId: string; readonly [ownerBrand]: true }
const owners = new WeakSet<object>();
/** Trusted host composition only. This capability is never an IPC/model parameter. */
export function createLocalReadOwner(): LocalReadOwner {
  const value = Object.freeze({ principalId: 'local-owner' }) as LocalReadOwner; owners.add(value); return value;
}
export class LocalReadSafetyError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'LocalReadSafetyError'; }
}
const fail = (code: string, message: string): never => { throw new LocalReadSafetyError(code, message); };
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
interface Options { getAuthEpoch(): number; now?: () => Date }
/**
 * Local Task status read policy and source-withdrawal barrier only. No memory
 * bodies, remote deletion, backup erasure, index, or second mandate authority.
 * All changes require an original in-process owner capability. Reads do not
 * initialize, repair, grant or advance any watermark.
 */
export class LocalReadSafetyStore {
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: Options) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Read safety requires the shared transaction connection');
    tx.atomic(() => {
      const installed = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='shiyu_local_read_safety'").get();
      db.exec(`CREATE TABLE IF NOT EXISTS shiyu_local_read_safety(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,
        policy_authority_id TEXT NOT NULL,policy_version INTEGER NOT NULL,enabled INTEGER NOT NULL,
        deletion_authority_id TEXT NOT NULL,tombstone_watermark INTEGER NOT NULL,installed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_local_read_withdrawals(task_id TEXT PRIMARY KEY,watermark INTEGER NOT NULL,withdrawn_at TEXT NOT NULL);`);
      if (!db.prepare('SELECT id FROM shiyu_local_read_safety WHERE id=1').get()) {
        if (installed || db.prepare('SELECT task_id FROM shiyu_local_read_withdrawals LIMIT 1').get()) fail('CORRUPT_AUTHORITY', 'Missing local safety baseline; refusing to silently grant reads again');
        // This is an explicit boot policy install, never a GET default.
        db.prepare('INSERT INTO shiyu_local_read_safety VALUES(1,1,?,1,1,?,0,?)').run(randomUUID(), randomUUID(), this.now());
      }
      this.snapshot();
    });
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private owner(actor: LocalReadOwner): void { if (!actor || !owners.has(actor)) fail('FORBIDDEN', 'An original trusted local owner capability is required'); }
  snapshot(): LocalReadSafety {
    this.tx.assertUsable();
    const row = this.db.prepare('SELECT * FROM shiyu_local_read_safety WHERE id=1').get();
    const epoch = this.options.getAuthEpoch();
    if (!row || row.schema_version !== 1 || !identity(row.policy_authority_id) || !identity(row.deletion_authority_id)
      || !integer(row.policy_version) || row.policy_version < 1 || ![0, 1].includes(Number(row.enabled))
      || !integer(row.tombstone_watermark) || !integer(epoch) || typeof row.installed_at !== 'string' || !Number.isFinite(Date.parse(row.installed_at))) fail('CORRUPT_AUTHORITY', 'Local read policy or trusted global auth epoch is unavailable');
    return { schemaVersion: 1, policyAuthorityId: String(row!.policy_authority_id), policyVersion: Number(row!.policy_version), enabled: row!.enabled === 1,
      deletionAuthorityId: String(row!.deletion_authority_id), deletionScope: 'local-task-source', tombstoneWatermark: Number(row!.tombstone_watermark),
      baseline: 'since-local-read-authority-installation', installedAt: String(row!.installed_at), authEpoch: epoch };
  }
  setEnabled(actor: LocalReadOwner, input: { expectedPolicyAuthorityId: string; expectedPolicyVersion: number; enabled: boolean }): LocalReadSafety {
    this.owner(actor);
    if (!input || Object.keys(input).some(key => !['expectedPolicyAuthorityId', 'expectedPolicyVersion', 'enabled'].includes(key)) || !identity(input.expectedPolicyAuthorityId) || !integer(input.expectedPolicyVersion) || typeof input.enabled !== 'boolean') fail('INVALID_SCHEMA', 'Invalid read policy CAS');
    return this.tx.atomic(() => {
      const current = this.snapshot();
      if (current.policyAuthorityId !== input.expectedPolicyAuthorityId || current.policyVersion !== input.expectedPolicyVersion) fail('VERSION_CONFLICT', 'Local read policy changed');
      if (current.enabled === input.enabled) return current;
      if (current.policyVersion === Number.MAX_SAFE_INTEGER) fail('VERSION_EXHAUSTED', 'Local policy version exhausted');
      this.db.prepare('UPDATE shiyu_local_read_safety SET enabled=?,policy_version=policy_version+1 WHERE id=1').run(Number(input.enabled));
      return this.snapshot();
    });
  }
  withdrawTask(actor: LocalReadOwner, input: { taskId: string; expectedDeletionAuthorityId: string; expectedTombstoneWatermark: number }): LocalReadSafety {
    this.owner(actor);
    if (!input || Object.keys(input).some(key => !['taskId', 'expectedDeletionAuthorityId', 'expectedTombstoneWatermark'].includes(key)) || !identity(input.expectedDeletionAuthorityId) || !identity(input.taskId) || !integer(input.expectedTombstoneWatermark)) fail('INVALID_SCHEMA', 'Invalid local Task withdrawal');
    return this.tx.atomic(() => {
      const current = this.snapshot();
      if (current.deletionAuthorityId !== input.expectedDeletionAuthorityId || current.tombstoneWatermark !== input.expectedTombstoneWatermark) fail('VERSION_CONFLICT', 'Local withdrawal barrier changed');
      if (this.isWithdrawn(input.taskId)) return current;
      if (current.tombstoneWatermark === Number.MAX_SAFE_INTEGER) fail('VERSION_EXHAUSTED', 'Local withdrawal watermark exhausted');
      this.db.prepare('INSERT INTO shiyu_local_read_withdrawals VALUES(?,?,?)').run(input.taskId, current.tombstoneWatermark + 1, this.now());
      this.db.prepare('UPDATE shiyu_local_read_safety SET tombstone_watermark=tombstone_watermark+1 WHERE id=1').run();
      return this.snapshot();
    });
  }
  isWithdrawn(taskId: string): boolean {
    this.tx.assertUsable(); this.snapshot();
    if (!identity(taskId)) fail('INVALID_SCHEMA', 'Invalid Task source identity');
    return Boolean(this.db.prepare('SELECT task_id FROM shiyu_local_read_withdrawals WHERE task_id=?').get(taskId));
  }
}
