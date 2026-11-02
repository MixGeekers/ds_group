import type { DatabaseSync } from 'node:sqlite';
import { MandateError, MandateStore, migrateMandateCatalog, policyCatalogHash, type MandateStoreOptions, type TrustedPolicyActor } from '../../control/policy/mandates.js';
import type { SqliteTransactions } from './transaction.js';

const taskActions = ['artifact.write', 'task.local-note.execute'];
const memoryActions = ['memory.erase', 'memory.read', 'memory.write'];
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
/** Exact pre-memory declaration. Its hash is a reviewed migration source, not an inferred permission set. */
export const TASK_AUTHORITY_V1: MandateStoreOptions = freeze({
  ownerIds: ['local-owner'], dispatcherIds: ['shiyu-task-dispatcher'], reconcilerIds: ['shiyu-artifact-verifier'],
  actionCosts: { 'artifact.write': { tokens: 0, calls: 0, effects: 1 }, 'task.local-note.execute': { tokens: 1, calls: 1, effects: 1 } },
});
export const MEMORY_DISPATCHER: TrustedPolicyActor = freeze({ principalId: 'shiyu-memory-dispatcher', kind: 'component', scopes: ['local-owner'] });
export const MEMORY_VERIFIER: TrustedPolicyActor = freeze({ principalId: 'shiyu-memory-verifier', kind: 'component', scopes: ['local-owner'] });
/** Catalog registration grants nothing. Read/erase remain ungranted until their service paths exist. */
export const CONTROL_AUTHORITY_V2: MandateStoreOptions = freeze({
  ownerIds: ['local-owner'], dispatcherIds: ['shiyu-task-dispatcher', MEMORY_DISPATCHER.principalId],
  reconcilerIds: ['shiyu-artifact-verifier', MEMORY_VERIFIER.principalId],
  dispatcherActions: { 'shiyu-task-dispatcher': taskActions, [MEMORY_DISPATCHER.principalId]: memoryActions },
  reconcilerActions: { 'shiyu-artifact-verifier': taskActions, [MEMORY_VERIFIER.principalId]: memoryActions },
  actionCosts: {
    ...TASK_AUTHORITY_V1.actionCosts,
    // Tokens/calls count generation inference. Local embedding request/resource
    // bounds belong to the Memory driver; these zeros do not mean no network I/O.
    'memory.write': { tokens: 0, calls: 0, effects: 1 },
    'memory.read': { tokens: 0, calls: 0, effects: 0 },
    'memory.erase': { tokens: 0, calls: 0, effects: 1 },
  },
});
/** Indexing is an explicitly budgeted derived write, separate from saving a body. */
export const CONTROL_AUTHORITY_V3: MandateStoreOptions = freeze({
  ...CONTROL_AUTHORITY_V2,
  dispatcherActions: { ...CONTROL_AUTHORITY_V2.dispatcherActions, [MEMORY_DISPATCHER.principalId]: [...memoryActions, 'memory.index'] },
  reconcilerActions: { ...CONTROL_AUTHORITY_V2.reconcilerActions, [MEMORY_VERIFIER.principalId]: [...memoryActions, 'memory.index'] },
  actionCosts: { ...CONTROL_AUTHORITY_V2.actionCosts, 'memory.index': { tokens: 0, calls: 0, effects: 1 } },
});
const MIGRATION_ID = 'shiyu-control-authority-task-v1-memory-v2';
const instances = new WeakMap<DatabaseSync, { transactions: SqliteTransactions; store: MandateStore }>();

/**
 * Trusted Worker composition only; never exposed as an Agent/UI command. All
 * domains on this exact DB share one policy instance, catalog and authEpoch.
 * Fresh assembly/migration requires an outermost transaction boundary so an
 * authority instance cannot escape a caller's later rollback into the cache.
 */
export function createControlAuthority(db: DatabaseSync, transactions: SqliteTransactions, options: { now?: () => Date } = {}): MandateStore {
  if (!transactions.owns(db)) throw new MandateError('TRANSACTION_MISMATCH', 'Authority requires the exact shared connection');
  const cached = instances.get(db);
  if (cached) {
    if (cached.transactions !== transactions) throw new MandateError('TRANSACTION_MISMATCH', 'Authority already belongs to another transaction owner');
    cached.store.catalog(); return cached.store;
  }
  if (transactions.depth || db.isTransaction) throw new MandateError('ASSEMBLY_TRANSACTION', 'Create the shared authority before opening a domain transaction');
  const store = transactions.atomic(() => {
    const catalogExists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='shiyu_policy_catalog'").get();
    if (catalogExists) {
      let currentHash = db.prepare('SELECT policy_hash FROM shiyu_policy_catalog WHERE id=1').get()?.policy_hash;
      if (currentHash === policyCatalogHash(TASK_AUTHORITY_V1)) {
        const legacy = new MandateStore(db, transactions, { ...TASK_AUTHORITY_V1, ...options });
        migrateMandateCatalog(db, transactions, { migrationId: MIGRATION_ID, expectedRevision: 1,
          expectedPolicyHash: legacy.catalog().policyHash, target: CONTROL_AUTHORITY_V2, ...options });
        currentHash = policyCatalogHash(CONTROL_AUTHORITY_V2);
      }
      if (currentHash === policyCatalogHash(CONTROL_AUTHORITY_V2)) {
        const legacy = new MandateStore(db, transactions, { ...CONTROL_AUTHORITY_V2, ...options });
        const previous = legacy.catalog();
        if (![1, 2].includes(previous.revision)) throw new MandateError('INCOMPATIBLE_POLICY', 'Unexpected memory v2 catalog history');
        migrateMandateCatalog(db, transactions, { migrationId: 'shiyu-control-authority-memory-v2-index-v3',
          expectedRevision: previous.revision, expectedPolicyHash: previous.policyHash, target: CONTROL_AUTHORITY_V3, ...options });
      } else if (currentHash !== policyCatalogHash(CONTROL_AUTHORITY_V3)) {
        throw new MandateError('INCOMPATIBLE_POLICY', 'Control authority only migrates reviewed Task v1 and memory v2 declarations');
      }
    }
    return new MandateStore(db, transactions, { ...CONTROL_AUTHORITY_V3, ...options });
  });
  instances.set(db, { transactions, store });
  return store;
}
