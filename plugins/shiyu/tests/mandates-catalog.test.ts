import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { MandateStore, MandateError, migrateMandateCatalog, policyCatalogHash } from '../src/control/policy/mandates.js';
import type { Mandate, MandateInput, MandateStoreOptions, PermitRequest, ReserveInput, TrustedPolicyActor } from '../src/control/policy/mandates.js';
import { TASK_AUTHORITY_V1, CONTROL_AUTHORITY_V2, CONTROL_AUTHORITY_V3, CONTROL_AUTHORITY_V4, CORE_DISPATCHER, CORE_VERIFIER, createControlAuthority } from '../src/adapters/control-store/authority.js';

const instant = '2026-11-02T12:00:00.000Z', expires = '2026-11-02T13:00:00.000Z';
const clock = () => new Date(instant);
const owner: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local-owner'] };
const taskWorker: TrustedPolicyActor = { principalId: 'task-worker-a', kind: 'agent', scopes: ['local-owner'] };
const memoryWorker: TrustedPolicyActor = { principalId: 'memory-worker-a', kind: 'agent', scopes: ['local-owner'] };
const component = (principalId: string): TrustedPolicyActor => ({ principalId, kind: 'component', scopes: ['local-owner'] });
const taskDispatcher = () => component(TASK_AUTHORITY_V1.dispatcherIds![0]!);
const taskReconciler = () => component(TASK_AUTHORITY_V1.reconcilerIds![0]!);
const memoryDispatcher = () => component(CONTROL_AUTHORITY_V2.dispatcherIds!.find(id => !TASK_AUTHORITY_V1.dispatcherIds!.includes(id))!);
const memoryReconciler = () => component(CONTROL_AUTHORITY_V2.reconcilerIds!.find(id => !TASK_AUTHORITY_V1.reconcilerIds!.includes(id))!);
const memoryAction = () => Object.keys(CONTROL_AUTHORITY_V2.actionCosts).find(action => !Object.hasOwn(TASK_AUTHORITY_V1.actionCosts, action))!;
const code = (...codes: string[]) => (error: unknown) => error instanceof MandateError && codes.includes(error.code);

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-mandate-catalog-')), filename = join(directory, 'control.sqlite');
  const connections: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(filename); connections.push(db);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
    return { db, tx, watermark };
  };
  t.after(() => { for (const db of connections) if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open };
}
function grantInput(patch: Partial<MandateInput> = {}): MandateInput {
  return { id: 'task-mandate', scope: 'local-owner', subjectIds: [taskWorker.principalId], allowedActions: ['task.local-note.execute', 'artifact.write'],
    allowedResources: ['artifact:task-a'], limits: { tokens: 1000, calls: 20, effects: 20 }, basisRef: 'synthetic-owner-grant', expiresAt: expires, ...patch };
}
function reserveInput(mandate: Mandate, reservationId = 'task-invocation', patch: Partial<ReserveInput> = {}): ReserveInput {
  return { reservationId, mandateId: mandate.mandateId, mandateVersion: mandate.version, authEpoch: mandate.authEpoch,
    scope: mandate.scope, action: 'task.local-note.execute', resourceScopes: ['artifact:task-a'], amount: { tokens: 20, calls: 2, effects: 1 }, ...patch };
}
function permit(input: ReserveInput): PermitRequest { const { amount: _amount, leaseMs: _lease, ...identity } = input; return identity; }
function seed(f: ReturnType<typeof fixture>, catalog = TASK_AUTHORITY_V1) {
  const store = new MandateStore(f.db, f.tx, { ...catalog, now: clock });
  const mandate = store.grant(owner, grantInput()), active = reserveInput(mandate);
  store.reserve(taskWorker, active);
  const completed = reserveInput(mandate, 'completed-invocation'); store.reserve(taskWorker, completed);
  const receipt = { receiptId: 'usage-before-migration', reservationId: completed.reservationId, expectedVersion: 1, complete: true,
    usage: { tokens: 8, calls: 1, effects: 1 }, evidenceRef: 'synthetic-observed-usage' };
  store.reconcile(taskReconciler(), receipt);
  return { store, mandate, active, completed, receipt };
}
function dataBytes(db: DatabaseSync) {
  return {
    mandates: db.prepare('SELECT * FROM shiyu_mandates ORDER BY id').all(),
    reservations: db.prepare('SELECT * FROM shiyu_budget_reservations ORDER BY id').all(),
    receipts: db.prepare('SELECT * FROM shiyu_budget_receipts ORDER BY id').all(),
  };
}
function migrate(f: ReturnType<typeof fixture>, store: MandateStore, migrationId = 'task-to-memory') {
  const current = store.catalog();
  const command = { migrationId, expectedRevision: current.revision, expectedPolicyHash: current.policyHash, target: CONTROL_AUTHORITY_V2, now: clock };
  return { command, receipt: migrateMandateCatalog(f.db, f.tx, command) };
}
const migrationRows = (db: DatabaseSync) => db.prepare('SELECT * FROM shiyu_policy_catalog_migrations ORDER BY migration_id').all();

test('the fixed Task catalog preserves its legacy hash and catalog hashing is canonical', () => {
  const legacy = createHash('sha256').update(JSON.stringify({ owners: [...TASK_AUTHORITY_V1.ownerIds].sort(),
    reconcilers: [...TASK_AUTHORITY_V1.reconcilerIds!].sort(), dispatchers: [...TASK_AUTHORITY_V1.dispatcherIds!].sort(),
    costs: Object.entries(TASK_AUTHORITY_V1.actionCosts).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex');
  assert.equal(policyCatalogHash(TASK_AUTHORITY_V1), legacy);
  assert.equal(policyCatalogHash({ ...TASK_AUTHORITY_V1, now: () => new Date(0), actionCosts: Object.fromEntries(Object.entries(TASK_AUTHORITY_V1.actionCosts).reverse()) }), legacy);
  const reversed: MandateStoreOptions = { ...CONTROL_AUTHORITY_V2, ownerIds: [...CONTROL_AUTHORITY_V2.ownerIds].reverse(),
    dispatcherIds: [...CONTROL_AUTHORITY_V2.dispatcherIds!].reverse(), reconcilerIds: [...CONTROL_AUTHORITY_V2.reconcilerIds!].reverse(),
    actionCosts: Object.fromEntries(Object.entries(CONTROL_AUTHORITY_V2.actionCosts).reverse()),
    dispatcherActions: Object.fromEntries(Object.entries(CONTROL_AUTHORITY_V2.dispatcherActions!).reverse().map(([id, actions]) => [id, [...actions].reverse()])),
    reconcilerActions: Object.fromEntries(Object.entries(CONTROL_AUTHORITY_V2.reconcilerActions!).reverse().map(([id, actions]) => [id, [...actions].reverse()])) };
  assert.equal(policyCatalogHash(reversed), policyCatalogHash(CONTROL_AUTHORITY_V2));
  const dispatcherActions = structuredClone(CONTROL_AUTHORITY_V2.dispatcherActions!);
  dispatcherActions[memoryDispatcher().principalId]!.push('artifact.write');
  assert.notEqual(policyCatalogHash({ ...CONTROL_AUTHORITY_V2, dispatcherActions }), policyCatalogHash(CONTROL_AUTHORITY_V2));
  assert.notEqual(legacy, policyCatalogHash(CONTROL_AUTHORITY_V2));
});

test('a fresh shared authority has the current catalog and repeated factory reads do not write', t => {
  const f = fixture(t), authority = createControlAuthority(f.db, f.tx, { now: clock });
  assert.deepEqual(authority.catalog(), { revision: 1, policyHash: policyCatalogHash(CONTROL_AUTHORITY_V4) });
  const before = f.watermark.read();
  assert.equal(createControlAuthority(f.db, f.tx, { now: clock }), authority);
  assert.deepEqual(authority.catalog(), { revision: 1, policyHash: policyCatalogHash(CONTROL_AUTHORITY_V4) });
  assert.deepEqual(f.watermark.read(), before); assert.equal(migrationRows(f.db).length, 0);
  f.db.close(); const reopened = f.open(), next = createControlAuthority(reopened.db, reopened.tx, { now: clock });
  assert.deepEqual(next.catalog(), { revision: 1, policyHash: policyCatalogHash(CONTROL_AUTHORITY_V4) });
  assert.deepEqual(reopened.watermark.read(), before);
});

test('explicit migration atomically changes catalog once and retains every old grant, budget and receipt byte', t => {
  const f = fixture(t), old = seed(f), bytes = dataBytes(f.db), balance = old.store.balance(owner, old.mandate.mandateId);
  const previous = old.store.catalog(), epoch = old.store.health().authEpoch, before = f.watermark.read();
  const { command, receipt } = migrate(f, old.store);
  assert.deepEqual(receipt, { migrationId: command.migrationId, fromRevision: previous.revision, fromPolicyHash: previous.policyHash,
    toRevision: previous.revision + 1, toPolicyHash: policyCatalogHash(CONTROL_AUTHORITY_V2), authEpoch: epoch + 1, migratedAt: instant });
  assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1); assert.equal(migrationRows(f.db).length, 1);
  assert.deepEqual(dataBytes(f.db), bytes);
  const authority = new MandateStore(f.db, f.tx, { ...CONTROL_AUTHORITY_V2, now: clock });
  assert.deepEqual(authority.balance(owner, old.mandate.mandateId), balance);
  assert.deepEqual(authority.get(owner, old.mandate.mandateId), old.mandate);
  assert.equal(authority.assertPermit(taskDispatcher(), permit(old.active)).reservationId, old.active.reservationId);
  assert.throws(() => authority.reserve(taskWorker, { ...reserveInput(old.mandate, 'cannot-escalate'), action: memoryAction() }), code('FORBIDDEN'));
  assert.equal(f.db.prepare('PRAGMA table_info(shiyu_policy_catalog)').all().length, 2, 'Keep the original two-column catalog compatible with existing tracking schema');
});

test('migration identity is idempotent, payload-bound and CAS protected without extra commits', t => {
  const f = fixture(t), old = seed(f), { command, receipt } = migrate(f, old.store), before = f.watermark.read();
  assert.deepEqual(migrateMandateCatalog(f.db, f.tx, { ...command, now: () => new Date('2026-11-02T12:01:00.000Z') }), receipt);
  for (const patch of [{ expectedRevision: command.expectedRevision + 1 }, { expectedPolicyHash: 'a'.repeat(64) }, { target: TASK_AUTHORITY_V1 }]) {
    assert.throws(() => migrateMandateCatalog(f.db, f.tx, { ...command, ...patch }), code('IDEMPOTENCY_CONFLICT'));
  }
  assert.throws(() => migrateMandateCatalog(f.db, f.tx, { ...command, migrationId: 'stale-cas' }), code('CATALOG_CONFLICT'));
  assert.deepEqual(f.watermark.read(), before); assert.equal(migrationRows(f.db).length, 1);
});

test('migration rollback preserves the old live authority and leaves no migration receipt or counter increment', t => {
  const f = fixture(t), old = seed(f), bytes = dataBytes(f.db), catalog = old.store.catalog(), before = f.watermark.read();
  assert.throws(() => f.tx.atomic(() => { migrate(f, old.store); throw new Error('synthetic migration abort'); }), /synthetic migration abort/);
  assert.deepEqual(old.store.catalog(), catalog); assert.deepEqual(dataBytes(f.db), bytes); assert.equal(migrationRows(f.db).length, 0);
  assert.deepEqual(f.watermark.read(), before); assert.equal(old.store.assertPermit(taskDispatcher(), permit(old.active)).reservationId, old.active.reservationId);
  assert.equal(migrate(f, old.store).receipt.toRevision, catalog.revision + 1);
});

test('catalog migration preserves an overrun freeze and all already held or spent budget', t => {
  const f = fixture(t), old = seed(f);
  old.store.reconcile(taskReconciler(), { receiptId: 'overrun-before-migration', reservationId: old.active.reservationId, expectedVersion: 1,
    complete: false, usage: { tokens: old.active.amount.tokens + 1 }, evidenceRef: 'synthetic-overrun' });
  const health = old.store.health(), bytes = dataBytes(f.db), balance = old.store.balance(owner, old.mandate.mandateId);
  assert.equal(health.frozen, true); migrate(f, old.store);
  const store = createControlAuthority(f.db, f.tx, { now: clock });
  assert.deepEqual(store.health(), { ...health, authEpoch: health.authEpoch + 3 });
  assert.deepEqual(dataBytes(f.db), bytes); assert.deepEqual(store.balance(owner, old.mandate.mandateId), balance);
  assert.throws(() => store.grant(owner, grantInput({ id: 'frozen-new-grant' })), code('BUDGET_OVERRUN'));
});

test('a migration receipt storage failure rolls back catalog and auth epoch as one transaction', t => {
  const f = fixture(t), old = seed(f), catalog = old.store.catalog(), health = old.store.health(), bytes = dataBytes(f.db), before = f.watermark.read();
  const original = f.db.prepare;
  f.db.prepare = function (sql: string) {
    if (/INSERT\s+INTO\s+shiyu_policy_catalog_migrations/i.test(sql)) throw new Error('synthetic catalog receipt failure');
    return original.call(this, sql);
  };
  try { assert.throws(() => migrate(f, old.store), /synthetic catalog receipt failure/); }
  finally { f.db.prepare = original; }
  assert.deepEqual(old.store.catalog(), catalog); assert.deepEqual(old.store.health(), health); assert.deepEqual(dataBytes(f.db), bytes);
  assert.equal(migrationRows(f.db).length, 0); assert.deepEqual(f.watermark.read(), before);
});

test('every old instance capability is fenced after another connection migrates the catalog', t => {
  const f = fixture(t), old = seed(f), second = f.open();
  const simultaneous = new MandateStore(second.db, second.tx, { ...TASK_AUTHORITY_V1, now: clock });
  migrateMandateCatalog(second.db, second.tx, { migrationId: 'other-connection', expectedRevision: simultaneous.catalog().revision,
    expectedPolicyHash: simultaneous.catalog().policyHash, target: CONTROL_AUTHORITY_V2, now: clock });
  const before = f.watermark.read();
  const checks = [
    () => old.store.catalog(), () => old.store.health(), () => old.store.get(owner, old.mandate.mandateId),
    () => old.store.getReservation(owner, old.active.reservationId), () => old.store.balance(owner, old.mandate.mandateId),
    () => old.store.grant(owner, grantInput()), () => old.store.grant(owner, grantInput({ id: 'new-old-catalog-grant' })),
    () => old.store.reserve(taskWorker, old.active), () => old.store.reserve(taskWorker, reserveInput(old.mandate, 'new-old-reservation')),
    () => old.store.assertPermit(taskDispatcher(), permit(old.active)),
    () => old.store.pause(owner, { mandateId: old.mandate.mandateId, expectedVersion: 1 }),
    () => old.store.resume(owner, { mandateId: old.mandate.mandateId, expectedVersion: 1 }),
    () => old.store.revoke(owner, { mandateId: old.mandate.mandateId, expectedVersion: 1 }),
    () => old.store.reconcile(taskReconciler(), old.receipt),
    () => old.store.reconcile(taskReconciler(), { ...old.receipt, receiptId: 'new-old-receipt', reservationId: old.active.reservationId }),
    () => simultaneous.catalog(),
  ];
  for (const action of checks) assert.throws(action, code('STALE_CATALOG'));
  assert.deepEqual(f.watermark.read(), before);
});

test('an ABA return to the previous policy hash cannot revive an old catalog revision', t => {
  const f = fixture(t), old = seed(f), first = old.store.catalog(); migrate(f, old.store);
  const intermediate = new MandateStore(f.db, f.tx, { ...CONTROL_AUTHORITY_V2, now: clock }), second = intermediate.catalog();
  migrateMandateCatalog(f.db, f.tx, { migrationId: 'explicit-return-to-task', expectedRevision: second.revision,
    expectedPolicyHash: second.policyHash, target: TASK_AUTHORITY_V1, now: clock });
  const current = new MandateStore(f.db, f.tx, { ...TASK_AUTHORITY_V1, now: clock });
  assert.deepEqual(current.catalog(), { revision: first.revision + 2, policyHash: first.policyHash });
  assert.throws(() => old.store.catalog(), code('STALE_CATALOG'));
  assert.throws(() => old.store.assertPermit(taskDispatcher(), permit(old.active)), code('STALE_CATALOG'));
  assert.throws(() => intermediate.catalog(), code('STALE_CATALOG'));
  assert.equal(current.assertPermit(taskDispatcher(), permit(old.active)).reservationId, old.active.reservationId);
});

test('Task and Memory dispatch and reconciliation stay separated after the catalog adds Memory actions', t => {
  const f = fixture(t), old = seed(f); migrate(f, old.store);
  const store = createControlAuthority(f.db, f.tx, { now: clock }), bytes = dataBytes(f.db), before = f.watermark.read();
  assert.ok(memoryDispatcher().principalId); assert.ok(memoryReconciler().principalId); assert.ok(memoryAction());
  assert.throws(() => store.assertPermit(memoryDispatcher(), permit(old.active)), code('FORBIDDEN'));
  assert.throws(() => store.get(memoryDispatcher(), old.mandate.mandateId), code('FORBIDDEN'));
  assert.throws(() => store.getReservation(memoryReconciler(), old.active.reservationId), code('FORBIDDEN'));
  assert.throws(() => store.balance(memoryReconciler(), old.mandate.mandateId), code('FORBIDDEN'));
  assert.throws(() => store.reconcile(memoryReconciler(), { receiptId: 'wrong-memory-observer', reservationId: old.active.reservationId, expectedVersion: 1,
    complete: true, usage: { tokens: 0, calls: 0, effects: 0 }, evidenceRef: 'must-not-release-task-budget' }), code('FORBIDDEN'));
  assert.deepEqual(dataBytes(f.db), bytes); assert.deepEqual(f.watermark.read(), before);
  assert.equal(store.assertPermit(taskDispatcher(), permit(old.active)).reservationId, old.active.reservationId);
  const mandate = store.grant(owner, grantInput({ id: 'memory-mandate', subjectIds: [memoryWorker.principalId], allowedActions: [memoryAction()], allowedResources: ['memory:target-a'] }));
  const reserved = reserveInput(mandate, 'memory-invocation', { action: memoryAction(), resourceScopes: ['memory:target-a'] }); store.reserve(memoryWorker, reserved);
  assert.equal(store.assertPermit(memoryDispatcher(), permit(reserved)).reservationId, reserved.reservationId);
  assert.throws(() => store.assertPermit(taskDispatcher(), permit(reserved)), code('FORBIDDEN'));
  assert.throws(() => store.get(taskDispatcher(), mandate.mandateId), code('FORBIDDEN'));
  assert.throws(() => store.getReservation(taskReconciler(), reserved.reservationId), code('FORBIDDEN'));
  assert.throws(() => store.balance(taskReconciler(), mandate.mandateId), code('FORBIDDEN'));
  assert.throws(() => store.assertPermit({ ...memoryDispatcher(), kind: 'agent' }, permit(reserved)), code('FORBIDDEN'));
  const proof = { receiptId: 'memory-usage', reservationId: reserved.reservationId, expectedVersion: 1, complete: true, usage: reserved.amount, evidenceRef: 'synthetic-memory-usage' };
  assert.throws(() => store.reconcile(taskReconciler(), proof), code('FORBIDDEN'));
  assert.equal(store.reconcile(memoryReconciler(), proof).state, 'settled');
});

for (const domain of ['task', 'memory'] as const) test(`a registered service cannot bypass its action allowlist as the ${domain} grant subject`, t => {
  const f = fixture(t);
  const unrestricted: MandateStoreOptions = { ownerIds: [...CONTROL_AUTHORITY_V2.ownerIds], dispatcherIds: [...CONTROL_AUTHORITY_V2.dispatcherIds!],
    reconcilerIds: [...CONTROL_AUTHORITY_V2.reconcilerIds!], actionCosts: structuredClone(CONTROL_AUTHORITY_V2.actionCosts) };
  const old = new MandateStore(f.db, f.tx, { ...unrestricted, now: clock });
  const subject = domain === 'task' ? memoryDispatcher() : taskDispatcher(), action = domain === 'task' ? 'task.local-note.execute' : memoryAction();
  const mandate = old.grant(owner, grantInput({ subjectIds: [subject.principalId], allowedActions: [action] }));
  const input = reserveInput(mandate, 'service-owned-invocation', { action }); old.reserve(subject, input);
  assert.equal(old.assertPermit(subject, permit(input)).principalId, subject.principalId);
  const catalog = old.catalog();
  migrateMandateCatalog(f.db, f.tx, { migrationId: 'restrict-service-actions', expectedRevision: catalog.revision, expectedPolicyHash: catalog.policyHash, target: CONTROL_AUTHORITY_V2, now: clock });
  const store = new MandateStore(f.db, f.tx, { ...CONTROL_AUTHORITY_V2, now: clock }), before = f.watermark.read(), bytes = dataBytes(f.db);
  assert.throws(() => store.assertPermit(subject, permit(input)), code('FORBIDDEN'));
  assert.throws(() => store.reserve(subject, { ...input, reservationId: 'another-service-owned-invocation' }), code('FORBIDDEN'));
  assert.deepEqual(dataBytes(f.db), bytes); assert.deepEqual(f.watermark.read(), before);
});

test('the shared factory migrates only the fixed historical Task declaration and reuses one object per connection and owner', t => {
  const f = fixture(t), old = seed(f), bytes = dataBytes(f.db), before = f.watermark.read();
  const store = createControlAuthority(f.db, f.tx, { now: clock });
  assert.equal(store.catalog().policyHash, policyCatalogHash(CONTROL_AUTHORITY_V4)); assert.equal(store.catalog().revision, 4);
  assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1); assert.deepEqual(dataBytes(f.db), bytes);
  const after = f.watermark.read(); assert.equal(createControlAuthority(f.db, f.tx, { now: clock }), store); assert.deepEqual(f.watermark.read(), after);
  assert.throws(() => old.store.catalog(), code('STALE_CATALOG'));
  assert.throws(() => createControlAuthority(f.db, new SqliteTransactions(f.db), { now: clock }), code('TRANSACTION_MISMATCH'));
  const other = f.open(); assert.throws(() => createControlAuthority(other.db, f.tx, { now: clock }), code('TRANSACTION_MISMATCH'));
  const separate = createControlAuthority(other.db, other.tx, { now: clock }); assert.notEqual(separate, store); assert.deepEqual(separate.catalog(), store.catalog());
});

test('first factory assembly cannot escape an outer rollback, while a committed cached authority is reusable inside transactions', t => {
  const f = fixture(t), before = f.watermark.read();
  assert.throws(() => f.tx.atomic(() => createControlAuthority(f.db, f.tx, { now: clock })), code('ASSEMBLY_TRANSACTION'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='shiyu_policy_catalog'").get()!.n, 0);
  assert.deepEqual(f.watermark.read(), before);
  const store = createControlAuthority(f.db, f.tx, { now: clock }), committed = f.watermark.read();
  assert.equal(f.tx.atomic(() => createControlAuthority(f.db, f.tx, { now: clock })), store);
  assert.throws(() => f.tx.atomic(() => { assert.equal(createControlAuthority(f.db, f.tx, { now: clock }), store); throw new Error('cached read rollback'); }), /cached read rollback/);
  assert.equal(createControlAuthority(f.db, f.tx, { now: clock }), store); assert.deepEqual(f.watermark.read(), committed);
});

test('memory v2 migrates through the index catalog to core without widening an existing saving grant', t => {
  const f = fixture(t), prior = new MandateStore(f.db, f.tx, { ...CONTROL_AUTHORITY_V2, now: clock });
  const grant = prior.grant(owner, { id: 'existing-memory-save', scope: 'local-owner', subjectIds: [memoryDispatcher().principalId],
    allowedActions: ['memory.write'], allowedResources: ['memory:local-owner:old-record'],
    limits: { tokens: 0, calls: 0, effects: 1 }, basisRef: 'owner-explicit-save', expiresAt: new Date(Date.parse(instant) + 600000).toISOString() });
  const before = dataBytes(f.db), epoch = prior.health().authEpoch;
  const current = createControlAuthority(f.db, f.tx, { now: clock });
  assert.equal(current.catalog().policyHash, policyCatalogHash(CONTROL_AUTHORITY_V4));
  assert.equal(current.catalog().revision, 3); assert.equal(current.health().authEpoch, epoch + 2);
  assert.deepEqual(dataBytes(f.db), before); assert.deepEqual(current.get(owner, grant.mandateId).allowedActions, ['memory.write']);
  assert.throws(() => current.reserve(memoryDispatcher(), { reservationId: 'index-under-old-save', mandateId: grant.mandateId,
    mandateVersion: grant.version, authEpoch: grant.authEpoch, scope: 'local-owner', action: 'memory.index',
    resourceScopes: ['memory:local-owner:old-record'], amount: { tokens: 0, calls: 0, effects: 1 }, leaseMs: 30000 }), code('FORBIDDEN'));
  assert.equal(migrationRows(f.db).length, 2);
});

test('unknown catalogs are refused by the factory and a changed constructor never implicitly migrates', t => {
  const f = fixture(t), unknown: MandateStoreOptions = { ...TASK_AUTHORITY_V1, ownerIds: ['unknown-owner'] };
  const store = new MandateStore(f.db, f.tx, { ...unknown, now: clock }), catalog = store.catalog(), before = f.watermark.read();
  assert.throws(() => createControlAuthority(f.db, f.tx, { now: clock }), code('INCOMPATIBLE_POLICY', 'UNKNOWN_CATALOG'));
  assert.throws(() => new MandateStore(f.db, f.tx, { ...CONTROL_AUTHORITY_V2, now: clock }), code('INCOMPATIBLE_POLICY'));
  assert.deepEqual(store.catalog(), catalog); assert.deepEqual(f.watermark.read(), before); assert.equal(migrationRows(f.db).length, 0);
});

test('genuine legacy two-column catalog gains explicit tracking and migration without altering its original columns', t => {
  const f = fixture(t);
  f.tx.atomic(() => {
    f.db.exec(`CREATE TABLE shiyu_policy_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,auth_epoch INTEGER NOT NULL,frozen INTEGER NOT NULL,reason TEXT);
      CREATE TABLE shiyu_policy_catalog(id INTEGER PRIMARY KEY CHECK(id=1),policy_hash TEXT NOT NULL);
      CREATE TABLE shiyu_mandates(id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,version INTEGER NOT NULL,auth_epoch INTEGER NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)));
      CREATE TABLE shiyu_budget_reservations(id TEXT PRIMARY KEY,mandate_id TEXT NOT NULL REFERENCES shiyu_mandates(id),intent_hash TEXT NOT NULL,version INTEGER NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json)));
      CREATE INDEX shiyu_reservations_mandate ON shiyu_budget_reservations(mandate_id);
      CREATE TABLE shiyu_budget_receipts(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL REFERENCES shiyu_budget_reservations(id),receipt_hash TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)));
      INSERT INTO shiyu_policy_meta VALUES(1,1,0,0,NULL);`);
    f.db.prepare('INSERT INTO shiyu_policy_catalog VALUES(1,?)').run(policyCatalogHash(TASK_AUTHORITY_V1));
  });
  const originalSql = f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='shiyu_policy_catalog'").get()!.sql, before = f.watermark.read();
  const store = createControlAuthority(f.db, f.tx, { now: clock });
  assert.equal(store.catalog().revision, 4); assert.equal(store.catalog().policyHash, policyCatalogHash(CONTROL_AUTHORITY_V4));
  assert.equal(f.db.prepare("SELECT sql FROM sqlite_schema WHERE name='shiyu_policy_catalog'").get()!.sql, originalSql);
  assert.equal(migrationRows(f.db).length, 3); assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
});

test('the core catalog adds only bounded generation evaluation and keeps the reviewed v3 declaration fixed', () => {
  assert.equal(policyCatalogHash(CONTROL_AUTHORITY_V3), 'eb3183573ec2c51a50f46127b649e86e722dc99350a514a9f1ae50397755d752');
  assert.deepEqual(CORE_DISPATCHER, { principalId: 'shiyu-core-dispatcher', kind: 'component', scopes: ['local-owner'] });
  assert.deepEqual(CORE_VERIFIER, { principalId: 'shiyu-core-verifier', kind: 'component', scopes: ['local-owner'] });
  assert.deepEqual(CONTROL_AUTHORITY_V4, {
    ...CONTROL_AUTHORITY_V3,
    dispatcherIds: [...CONTROL_AUTHORITY_V3.dispatcherIds!, CORE_DISPATCHER.principalId],
    reconcilerIds: [...CONTROL_AUTHORITY_V3.reconcilerIds!, CORE_VERIFIER.principalId],
    dispatcherActions: { ...CONTROL_AUTHORITY_V3.dispatcherActions, [CORE_DISPATCHER.principalId]: ['core.evaluate'] },
    reconcilerActions: { ...CONTROL_AUTHORITY_V3.reconcilerActions, [CORE_VERIFIER.principalId]: ['core.evaluate'] },
    actionCosts: { ...CONTROL_AUTHORITY_V3.actionCosts, 'core.evaluate': { tokens: 1, calls: 1, effects: 0 } },
  });
  assert.ok(Object.isFrozen(CORE_DISPATCHER.scopes)); assert.ok(Object.isFrozen(CORE_VERIFIER));
  assert.ok(Object.isFrozen(CONTROL_AUTHORITY_V4.dispatcherActions![CORE_DISPATCHER.principalId]));
});

test('v3 migration preserves active and unknown holds and settled receipts, fences old instances and never grants core implicitly', t => {
  const f = fixture(t), old = seed(f, CONTROL_AUTHORITY_V3);
  const memory = old.store.grant(owner, grantInput({ id: 'v3-index-grant', subjectIds: [memoryDispatcher().principalId],
    allowedActions: ['memory.index'], allowedResources: ['memory:v3-source'], limits: { tokens: 0, calls: 0, effects: 2 } }));
  const index = reserveInput(memory, 'v3-unknown-index', { action: 'memory.index', resourceScopes: ['memory:v3-source'], amount: { tokens: 0, calls: 0, effects: 1 } });
  old.store.reserve(memoryDispatcher(), index);
  old.store.reconcile(memoryReconciler(), { receiptId: 'v3-partial-index-receipt', reservationId: index.reservationId, expectedVersion: 1,
    complete: false, usage: {}, evidenceRef: 'synthetic-index-unknown' });
  const bytes = dataBytes(f.db), taskBalance = old.store.balance(owner, old.mandate.mandateId), memoryBalance = old.store.balance(owner, memory.mandateId);
  const epoch = old.store.health().authEpoch, before = f.watermark.read(), second = f.open();
  const current = createControlAuthority(second.db, second.tx, { now: clock });
  assert.deepEqual(current.catalog(), { revision: 2, policyHash: policyCatalogHash(CONTROL_AUTHORITY_V4) });
  assert.equal(current.health().authEpoch, epoch + 1); assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
  assert.deepEqual(dataBytes(f.db), bytes);
  assert.deepEqual(current.balance(owner, old.mandate.mandateId), taskBalance);
  assert.deepEqual(current.balance(owner, memory.mandateId), memoryBalance);
  assert.deepEqual(memoryBalance.held, { tokens: 0, calls: 0, effects: 1 });
  assert.equal(current.getReservation(owner, index.reservationId).state, 'unknown');
  assert.equal(current.assertPermit(taskDispatcher(), permit(old.active)).reservationId, old.active.reservationId);
  for (const action of [() => old.store.catalog(), () => old.store.grant(owner, grantInput({ id: 'stale-grant' })),
    () => old.store.reserve(taskWorker, old.active), () => old.store.assertPermit(taskDispatcher(), permit(old.active)),
    () => old.store.reconcile(taskReconciler(), old.receipt)]) assert.throws(action, code('STALE_CATALOG'));
  assert.throws(() => current.reserve(taskWorker, reserveInput(old.mandate, 'core-under-old-task', { action: 'core.evaluate' })), code('FORBIDDEN'));
  assert.throws(() => current.reserve(memoryDispatcher(), reserveInput(memory, 'core-under-old-memory', { action: 'core.evaluate' })), code('FORBIDDEN'));
  const rows = migrationRows(f.db); assert.equal(rows.length, 1);
  const receipt = JSON.parse(String(rows[0]!.record_json));
  assert.deepEqual(receipt, { migrationId: 'shiyu-control-authority-index-v3-core-v4', fromRevision: 1,
    fromPolicyHash: policyCatalogHash(CONTROL_AUTHORITY_V3), toRevision: 2, toPolicyHash: policyCatalogHash(CONTROL_AUTHORITY_V4), authEpoch: epoch + 1, migratedAt: instant });
  const committed = f.watermark.read();
  assert.deepEqual(migrateMandateCatalog(f.db, f.tx, { migrationId: receipt.migrationId, expectedRevision: 1,
    expectedPolicyHash: receipt.fromPolicyHash, target: CONTROL_AUTHORITY_V4, now: clock }), receipt);
  assert.deepEqual(createControlAuthority(f.db, f.tx, { now: clock }).catalog(), current.catalog());
  assert.deepEqual(f.watermark.read(), committed); assert.deepEqual(dataBytes(f.db), bytes);
});

test('a failed v3 factory migration leaves the old authority usable and does not cache an uncommitted v4', t => {
  const f = fixture(t), old = seed(f, CONTROL_AUTHORITY_V3), before = f.watermark.read(), bytes = dataBytes(f.db);
  const catalog = old.store.catalog(), health = old.store.health(), original = f.db.prepare;
  f.db.prepare = function (sql: string) {
    if (/INSERT\s+INTO\s+shiyu_policy_catalog_migrations/i.test(sql)) throw new Error('synthetic core migration receipt failure');
    return original.call(this, sql);
  };
  try { assert.throws(() => createControlAuthority(f.db, f.tx, { now: clock }), /synthetic core migration receipt failure/); }
  finally { f.db.prepare = original; }
  assert.deepEqual(old.store.catalog(), catalog); assert.deepEqual(old.store.health(), health);
  assert.deepEqual(dataBytes(f.db), bytes); assert.deepEqual(f.watermark.read(), before); assert.equal(migrationRows(f.db).length, 0);
  assert.equal(old.store.assertPermit(taskDispatcher(), permit(old.active)).reservationId, old.active.reservationId);
  const current = createControlAuthority(f.db, f.tx, { now: clock });
  assert.equal(current.catalog().revision, 2); assert.equal(current.catalog().policyHash, policyCatalogHash(CONTROL_AUTHORITY_V4));
  assert.equal(migrationRows(f.db).length, 1); assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
});

test('a failure only at the final core migration rolls back the complete Task-to-v4 factory chain', t => {
  const f = fixture(t), old = seed(f), before = f.watermark.read(), bytes = dataBytes(f.db);
  const catalog = old.store.catalog(), health = old.store.health(), original = f.db.prepare;
  let earlierReceipts = 0;
  f.db.prepare = function (sql: string) {
    if (/INSERT\s+INTO\s+shiyu_policy_catalog_migrations/i.test(sql)) {
      earlierReceipts = migrationRows(f.db).length;
      if (earlierReceipts === 2) throw new Error('synthetic final chain receipt failure');
    }
    return original.call(this, sql);
  };
  try { assert.throws(() => createControlAuthority(f.db, f.tx, { now: clock }), /synthetic final chain receipt failure/); }
  finally { f.db.prepare = original; }
  assert.equal(earlierReceipts, 2, 'Both earlier migration receipts existed inside the still-uncommitted factory transaction');
  assert.deepEqual(old.store.catalog(), catalog); assert.deepEqual(old.store.health(), health);
  assert.deepEqual(dataBytes(f.db), bytes); assert.deepEqual(f.watermark.read(), before); assert.equal(migrationRows(f.db).length, 0);
  assert.equal(old.store.assertPermit(taskDispatcher(), permit(old.active)).reservationId, old.active.reservationId);
  const current = createControlAuthority(f.db, f.tx, { now: clock });
  assert.equal(current.catalog().revision, 4); assert.equal(current.health().authEpoch, health.authEpoch + 3);
  assert.equal(migrationRows(f.db).length, 3); assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
});

for (const action of ['task.local-note.execute', 'memory.index']) test(`new core roles cannot reuse a pre-v4 ${action} subject permit`, t => {
  const f = fixture(t), prior = new MandateStore(f.db, f.tx, { ...CONTROL_AUTHORITY_V3, now: clock });
  const grant = prior.grant(owner, grantInput({ id: 'pre-core-subject-grant', subjectIds: [CORE_DISPATCHER.principalId, CORE_VERIFIER.principalId], allowedActions: [action] }));
  const inputs = [CORE_DISPATCHER, CORE_VERIFIER].map(actor => reserveInput(grant, `old-${actor.principalId}`, { action }));
  for (const [index, actor] of [CORE_DISPATCHER, CORE_VERIFIER].entries()) {
    prior.reserve(actor, inputs[index]!); assert.equal(prior.assertPermit(actor, permit(inputs[index]!)).principalId, actor.principalId);
  }
  const bytes = dataBytes(f.db), current = createControlAuthority(f.db, f.tx, { now: clock }), committed = f.watermark.read();
  for (const [index, actor] of [CORE_DISPATCHER, CORE_VERIFIER].entries()) {
    const input = inputs[index]!;
    assert.throws(() => current.assertPermit(actor, permit(input)), code('FORBIDDEN'));
    assert.throws(() => current.reserve(actor, input), code('FORBIDDEN'));
    assert.throws(() => current.reserve(actor, { ...input, reservationId: `new-${actor.principalId}` }), code('FORBIDDEN'));
  }
  assert.deepEqual(dataBytes(f.db), bytes); assert.deepEqual(f.watermark.read(), committed);
});

test('the v3 migration refuses an unreviewed revision even when its policy hash matches', t => {
  const f = fixture(t); let prior = new MandateStore(f.db, f.tx, { ...CONTROL_AUTHORITY_V3, now: clock });
  for (const [index, target] of [CONTROL_AUTHORITY_V2, TASK_AUTHORITY_V1, CONTROL_AUTHORITY_V3].entries()) {
    const current = prior.catalog();
    migrateMandateCatalog(f.db, f.tx, { migrationId: `synthetic-history-${index}`, expectedRevision: current.revision,
      expectedPolicyHash: current.policyHash, target, now: clock });
    prior = new MandateStore(f.db, f.tx, { ...target, now: clock });
  }
  const catalog = prior.catalog(), before = f.watermark.read(), rows = migrationRows(f.db);
  assert.deepEqual(catalog, { revision: 4, policyHash: policyCatalogHash(CONTROL_AUTHORITY_V3) });
  assert.throws(() => createControlAuthority(f.db, f.tx, { now: clock }), code('INCOMPATIBLE_POLICY'));
  assert.deepEqual(prior.catalog(), catalog); assert.deepEqual(migrationRows(f.db), rows); assert.deepEqual(f.watermark.read(), before);
});

test('core and Task share an explicit Goal grant while dispatch and settlement remain action restricted', t => {
  const f = fixture(t), store = createControlAuthority(f.db, f.tx, { now: clock });
  const subjects = [CORE_DISPATCHER, CORE_VERIFIER, taskDispatcher(), taskReconciler()];
  const grant = store.grant(owner, grantInput({ id: 'explicit-goal-grant', subjectIds: subjects.map(actor => actor.principalId),
    allowedActions: ['core.evaluate', 'task.local-note.execute'], allowedResources: ['goal:synthetic'] }));
  const core = reserveInput(grant, 'goal-core-evaluation', { action: 'core.evaluate', resourceScopes: ['goal:synthetic'], amount: { tokens: 8, calls: 1, effects: 0 } });
  const task = reserveInput(grant, 'goal-task-invocation', { resourceScopes: ['goal:synthetic'] });
  for (const actor of subjects) assert.equal(store.get(actor, grant.mandateId).mandateId, grant.mandateId);
  const before = f.watermark.read();
  for (const amount of [{ tokens: 0, calls: 1, effects: 0 }, { tokens: 1, calls: 0, effects: 0 }]) {
    assert.throws(() => store.reserve(CORE_DISPATCHER, { ...core, amount }), code('BUDGET_MINIMUM'));
  }
  assert.deepEqual(f.watermark.read(), before);
  store.reserve(CORE_DISPATCHER, core); store.reserve(taskDispatcher(), task);
  assert.equal(store.assertPermit(CORE_DISPATCHER, permit(core)).maxTokens, 8);
  assert.equal(store.assertPermit(taskDispatcher(), permit(task)).reservationId, task.reservationId);
  for (const actor of [CORE_DISPATCHER, CORE_VERIFIER]) {
    assert.throws(() => store.reserve(actor, { ...task, reservationId: `${actor.principalId}-wrong-task` }), code('FORBIDDEN'));
    assert.throws(() => store.assertPermit(actor, permit(task)), code('FORBIDDEN'));
  }
  for (const actor of [taskDispatcher(), taskReconciler()]) {
    assert.throws(() => store.reserve(actor, { ...core, reservationId: `${actor.principalId}-wrong-core` }), code('FORBIDDEN'));
    assert.throws(() => store.assertPermit(actor, permit(core)), code('FORBIDDEN'));
  }
  const coreProof = { receiptId: 'goal-core-usage', reservationId: core.reservationId, expectedVersion: 2, complete: true, usage: core.amount, evidenceRef: 'synthetic-core-usage' };
  const taskProof = { receiptId: 'goal-task-usage', reservationId: task.reservationId, expectedVersion: 1, complete: true, usage: task.amount, evidenceRef: 'synthetic-task-usage' };
  assert.equal(store.reconcile(CORE_VERIFIER, { ...coreProof, receiptId: 'goal-core-partial-usage', expectedVersion: 1,
    complete: false, usage: { tokens: 1 } }).state, 'unknown');
  assert.throws(() => store.assertPermit(CORE_DISPATCHER, permit(core)), code('BUDGET_UNAVAILABLE'));
  assert.deepEqual(store.balance(CORE_VERIFIER, grant.mandateId).held, { tokens: 28, calls: 3, effects: 1 });
  assert.throws(() => store.reconcile(CORE_VERIFIER, { ...coreProof, usage: { tokens: 8, calls: 1 } }), code('INCOMPLETE_USAGE'));
  assert.throws(() => store.reconcile(taskReconciler(), coreProof), code('FORBIDDEN'));
  assert.throws(() => store.reconcile(CORE_VERIFIER, taskProof), code('FORBIDDEN'));
  assert.equal(store.reconcile(CORE_VERIFIER, coreProof).state, 'settled');
  assert.equal(store.reconcile(taskReconciler(), taskProof).state, 'settled');
  assert.deepEqual(store.balance(CORE_VERIFIER, grant.mandateId).held, { tokens: 0, calls: 0, effects: 0 });
  assert.deepEqual(store.balance(CORE_VERIFIER, grant.mandateId).spent, { tokens: 28, calls: 3, effects: 1 });
});

test('core and Memory service subjects cannot borrow each other\'s action from a combined grant', t => {
  const f = fixture(t), store = createControlAuthority(f.db, f.tx, { now: clock });
  const grant = store.grant(owner, grantInput({ id: 'explicit-core-memory-grant',
    subjectIds: [CORE_DISPATCHER, CORE_VERIFIER, memoryDispatcher(), memoryReconciler()].map(actor => actor.principalId),
    allowedActions: ['core.evaluate', 'memory.index'], allowedResources: ['memory:synthetic'] }));
  const core = reserveInput(grant, 'combined-core', { action: 'core.evaluate', resourceScopes: ['memory:synthetic'], amount: { tokens: 1, calls: 1, effects: 0 } });
  const memory = reserveInput(grant, 'combined-memory', { action: 'memory.index', resourceScopes: ['memory:synthetic'], amount: { tokens: 0, calls: 0, effects: 1 } });
  store.reserve(CORE_DISPATCHER, core); store.reserve(memoryDispatcher(), memory);
  for (const [actors, wrong] of [[[CORE_DISPATCHER, CORE_VERIFIER], memory], [[memoryDispatcher(), memoryReconciler()], core]] as const) {
    for (const actor of actors) {
      assert.throws(() => store.reserve(actor, { ...wrong, reservationId: `${actor.principalId}-wrong-domain` }), code('FORBIDDEN'));
      assert.throws(() => store.assertPermit(actor, permit(wrong)), code('FORBIDDEN'));
    }
  }
  assert.throws(() => store.reconcile(CORE_VERIFIER, { receiptId: 'wrong-core-observer', reservationId: memory.reservationId,
    expectedVersion: 1, complete: true, usage: memory.amount, evidenceRef: 'synthetic-memory-usage' }), code('FORBIDDEN'));
  assert.throws(() => store.reconcile(memoryReconciler(), { receiptId: 'wrong-memory-observer', reservationId: core.reservationId,
    expectedVersion: 1, complete: true, usage: core.amount, evidenceRef: 'synthetic-core-usage' }), code('FORBIDDEN'));
});
