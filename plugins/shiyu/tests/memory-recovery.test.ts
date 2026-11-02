import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { EffectLedger, EffectError } from '../src/control/effects/index.js';
import { MemoryOperationLedger, MemoryOperationError } from '../src/control/memory/index.js';
import type { MemoryApprover, MemoryBackendReceipt, MemoryClaimRequest, MemoryDispatchAuthorizer, MemoryLedgerOptions, MemoryOperationInput, MemoryReceiptVerifier } from '../src/control/memory/index.js';
import type { TrustedPolicyActor } from '../src/control/policy/mandates.js';

const instant = '2026-11-02T05:00:00.000Z';
const auth = { mandateId: 'mandate-a', mandateVersion: 1, authEpoch: 2, installationGeneration: 'install-a' };
const core: TrustedPolicyActor = { principalId: 'core', kind: 'agent', scopes: ['private-a'] };
const dispatcher: TrustedPolicyActor = { principalId: 'dispatcher', kind: 'component', scopes: ['private-a'] };
const verifier: TrustedPolicyActor = { principalId: 'verifier', kind: 'component', scopes: ['private-a'] };
const owner: TrustedPolicyActor = { principalId: 'owner', kind: 'owner', scopes: ['private-a'] };
const options: MemoryLedgerOptions = { backendIds: ['synthetic-vault-a'], approverIds: ['core'], dispatcherIds: ['dispatcher'], verifierIds: ['verifier'], eraserIds: ['owner'] };
const intent = (id = 'operation-a', patch: Partial<MemoryOperationInput> = {}): MemoryOperationInput => ({
  operationId: id, backendId: 'synthetic-vault-a', proposalId: `proposal-${id}`, kind: 'append', commandRef: `command-${id}`, commandDigest: 'a'.repeat(64),
  scope: 'private-a', targetRef: `target-${id}`, sourceRefs: [{ sourceId: 'source-a', revision: 1 }], dependencyRefs: [], expectedTombstoneWatermark: 0,
  origin: { kind: 'task', taskId: 'task-a', assignmentId: 'assignment-a' }, mandateRef: auth, expiresAt: '2026-11-02T06:00:00.000Z', ...patch,
});
const approved: MemoryApprover = () => ({ allowed: true, authorization: auth, sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: null, atomicVersionCheck: false });
const allowed: MemoryDispatchAuthorizer = () => ({ allowed: true, ...auth, hostEpoch: 'host-a', fencingToken: 1, sourcesVerified: true, dependenciesVerified: true, observedComponentVersion: null, atomicVersionCheck: false });
const request = (operationId = 'operation-a', expectedVersion = 1): MemoryClaimRequest => ({ operationId, expectedVersion, ownerId: 'dispatcher', hostEpoch: 'host-a', installationGeneration: 'install-a', fencingToken: 1, leaseMs: 1000 });
const result = (operationId = 'operation-a', patch: Partial<MemoryBackendReceipt> = {}): MemoryBackendReceipt => ({
  receiptId: `receipt-${operationId}`, operationId, backendId: 'synthetic-vault-a', externalOperationId: `external-${operationId}`, commandDigest: 'a'.repeat(64),
  outcome: 'applied', observedAt: instant, nativeId: `native-${operationId}`, componentVersion: null, backendReceiptRef: `backend-receipt-${operationId}`, verificationRef: `verification-${operationId}`, evidenceRefs: [`evidence-${operationId}`], ...patch,
});
const verified: MemoryReceiptVerifier = (operation, receipt) => ({
  verified: true, operationId: operation.operationId, backendId: receipt.backendId, externalOperationId: receipt.externalOperationId,
  commandDigest: operation.commandDigest, outcome: receipt.outcome, installationGeneration: 'install-a', nativeId: receipt.nativeId, componentVersion: receipt.componentVersion,
  sourceRefs: operation.sourceRefs, operationSettled: true, reconciled: true, publicationAllowed: true, atomicCas: null,
});
const publicationAllowed = () => ({ allowed: true as const, authorization: auth, sourcesVerified: true, dependenciesVerified: true });
const code = (...codes: string[]) => (error: unknown) => (error instanceof MemoryOperationError || error instanceof EffectError) && codes.includes(error.code);
const ledgerError = (error: unknown) => error instanceof MemoryOperationError || error instanceof EffectError;
const memoryTables = ['shiyu_memory_meta', 'shiyu_memory_operations', 'shiyu_memory_receipts', 'shiyu_memory_deletions', 'shiyu_memory_tombstones', 'shiyu_memory_publications'] as const;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-memory-recovery-')), filename = join(directory, 'control.sqlite');
  const connections: DatabaseSync[] = [];
  const clock = () => new Date(instant);
  const open = () => {
    const db = new DatabaseSync(filename); connections.push(db);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
    const ledger = new MemoryOperationLedger(db, tx, { ...options, now: clock });
    const effects = new EffectLedger(db, tx, { now: clock });
    return { db, tx, watermark, ledger, effects };
  };
  t.after(() => { for (const db of connections) if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, clock };
}
function rawConnection(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-memory-raw-')), db = new DatabaseSync(join(directory, 'control.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  const tx = new SqliteTransactions(db), clock = () => new Date(instant);
  t.after(() => { if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, tx, clock };
}
function deferredPublication(f: ReturnType<typeof fixture>, operationId = 'operation-a') {
  f.ledger.approve(core, intent(operationId), approved);
  const claim = f.ledger.claim(dispatcher, request(operationId), allowed)!;
  const receipt = result(operationId);
  const operation = f.ledger.complete(verifier, operationId, 2, claim, receipt, (op, proof) => ({ ...verified(op, proof), publicationAllowed: false }));
  assert.equal(operation.status, 'unknown'); assert.equal(f.effects.get(claim.effectId)!.status, 'succeeded');
  return { claim, receipt, operation, command: { operationId, expectedVersion: operation.version, receiptId: receipt.receiptId } };
}
function erase(f: ReturnType<typeof fixture>, refs = ['unrelated-deleted-source']) {
  return f.ledger.tombstone(owner, { deletionId: 'delete-a', scope: 'private-a', refs, expectedWatermark: 0, reasonCode: 'USER_ERASURE' });
}

test('schema two deletion authority is persistent and pure reads do not advance the real commit watermark', t => {
  const f = fixture(t), original = f.ledger.deletionState(), before = f.watermark.read();
  assert.equal(original.schemaVersion, 2); assert.equal(original.tombstoneWatermark, 0);
  assert.match(original.baselineId, /^[a-f0-9-]{36}$/); assert.equal(original.installedAt, instant);
  assert.deepEqual(f.ledger.deletionState(), original); assert.equal(f.ledger.watermark(), 0);
  assert.deepEqual(f.watermark.read(), before);
  f.db.close(); const reopened = f.open();
  assert.deepEqual(reopened.ledger.deletionState(), original); assert.deepEqual(reopened.watermark.read(), before);
});

test('memory approval, committed claim, receipt and deletion each count one outer commit; failures count none', t => {
  const f = fixture(t); let seq = f.watermark.read().commitSeq;
  f.ledger.approve(core, intent(), approved); assert.equal(f.watermark.read().commitSeq, ++seq);
  f.ledger.approve(core, intent(), approved); assert.equal(f.watermark.read().commitSeq, seq);
  assert.throws(() => f.tx.atomic(() => f.ledger.claim(dispatcher, request(), allowed)), code('NESTED_DISPATCH'));
  assert.equal(f.watermark.read().commitSeq, seq);
  const claim = f.ledger.claim(dispatcher, request(), allowed)!; assert.equal(f.watermark.read().commitSeq, ++seq);
  f.ledger.assertDispatch(dispatcher, 'operation-a', claim, allowed); assert.equal(f.watermark.read().commitSeq, seq);
  f.ledger.complete(verifier, 'operation-a', 2, claim, result(), verified); assert.equal(f.watermark.read().commitSeq, ++seq);
  f.ledger.complete(verifier, 'operation-a', 2, claim, result(), verified); assert.equal(f.watermark.read().commitSeq, seq);
  erase(f); assert.equal(f.watermark.read().commitSeq, ++seq);
  f.ledger.get('operation-a'); f.ledger.receipts('operation-a'); f.ledger.deletionState();
  assert.equal(f.watermark.read().commitSeq, seq);
  const state = f.ledger.deletionState(); f.db.close(); const reopened = f.open();
  assert.deepEqual(reopened.ledger.deletionState(), state); assert.equal(reopened.watermark.read().commitSeq, seq);
});

for (const table of memoryTables) test(`an existing installation refuses a missing required table: ${table}`, t => {
  // No tracker here: its own guard rejects DROP of tracked tables before the
  // domain can observe missing schema. Exercise the domain's independent guard.
  const f = rawConnection(t); new MemoryOperationLedger(f.db, f.tx, { ...options, now: f.clock });
  f.tx.atomic(() => f.db.exec(`DROP TABLE ${table}`));
  const schema = () => f.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all();
  const before = schema();
  assert.throws(() => new MemoryOperationLedger(f.db, f.tx, { ...options, now: f.clock }), code('CORRUPT_LEDGER'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name=?").get(table)!.n, 0);
  assert.deepEqual(schema(), before);
});

test('missing metadata cannot reset deletion progress or accept replacement trusted roles', t => {
  const f = fixture(t); erase(f);
  f.tx.atomic(() => f.db.prepare('DELETE FROM shiyu_memory_meta').run()); const before = f.watermark.read();
  assert.throws(() => new MemoryOperationLedger(f.db, f.tx, { ...options, verifierIds: ['replacement-verifier'], now: f.clock }), code('CORRUPT_LEDGER'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_memory_meta').get()!.n, 0);
  assert.throws(() => f.ledger.deletionState(), code('CORRUPT_LEDGER')); assert.deepEqual(f.watermark.read(), before);
});

test('legacy schema one requires explicit migration and cannot be silently relabelled as schema two', t => {
  const f = fixture(t);
  f.tx.atomic(() => f.db.prepare('UPDATE shiyu_memory_meta SET schema_version=1').run()); const before = f.watermark.read();
  assert.throws(() => new MemoryOperationLedger(f.db, f.tx, { ...options, now: f.clock }), code('MIGRATION_REQUIRED'));
  assert.equal(f.db.prepare('SELECT schema_version FROM shiyu_memory_meta').get()!.schema_version, 1);
  assert.deepEqual(f.watermark.read(), before);
});

test('a genuine legacy five-table schema without baseline, closure or publication columns requires migration', t => {
  const f = rawConnection(t);
  f.tx.atomic(() => f.db.exec(`
    CREATE TABLE shiyu_memory_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,policy_hash TEXT NOT NULL,tombstone_watermark INTEGER NOT NULL);
    CREATE TABLE shiyu_memory_operations(operation_id TEXT PRIMARY KEY,effect_id TEXT NOT NULL UNIQUE,scope TEXT NOT NULL,intent_hash TEXT NOT NULL,local_version INTEGER NOT NULL,record_json TEXT NOT NULL);
    CREATE TABLE shiyu_memory_receipts(receipt_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,intent_hash TEXT NOT NULL,record_json TEXT NOT NULL);
    CREATE TABLE shiyu_memory_deletions(deletion_id TEXT PRIMARY KEY,intent_hash TEXT NOT NULL,record_json TEXT NOT NULL);
    CREATE TABLE shiyu_memory_tombstones(scope TEXT NOT NULL,ref TEXT NOT NULL,watermark INTEGER NOT NULL,PRIMARY KEY(scope,ref));
    INSERT INTO shiyu_memory_meta VALUES(1,1,'legacy-policy-hash',0);
  `));
  const before = f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  assert.throws(() => new MemoryOperationLedger(f.db, f.tx, { ...options, now: f.clock }), code('MIGRATION_REQUIRED'));
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), before);
});

const corruptions = [
  { name: 'missing tombstone row', sql: 'DELETE FROM shiyu_memory_tombstones' },
  { name: 'changed tombstone reference', sql: "UPDATE shiyu_memory_tombstones SET ref='forged-source'" },
  { name: 'changed tombstone watermark', sql: 'UPDATE shiyu_memory_tombstones SET watermark=watermark+1' },
  { name: 'missing deletion receipt', sql: 'DELETE FROM shiyu_memory_deletions' },
  { name: 'changed deletion receipt', sql: "UPDATE shiyu_memory_deletions SET record_json=json_set(record_json,'$.refs[0]','forged-source')" },
  { name: 'changed deletion watermark', sql: 'UPDATE shiyu_memory_meta SET tombstone_watermark=tombstone_watermark+1' },
] as const;
for (const damage of corruptions) test(`${damage.name} fails closed at startup and every write/publication boundary`, t => {
  const f = fixture(t);
  f.ledger.approve(core, intent('pending'), approved); f.ledger.approve(core, intent('running'), approved);
  const claim = f.ledger.claim(dispatcher, request('running'), allowed)!;
  const deferred = deferredPublication(f, 'deferred'); erase(f);
  // Independent preexisting instances ensure each boundary detects corruption
  // itself, rather than merely inheriting an earlier read's isolation flag.
  const guards = Array.from({ length: 5 }, () => new MemoryOperationLedger(f.db, f.tx, { ...options, now: f.clock }));
  f.tx.atomic(() => f.db.exec(damage.sql)); const before = f.watermark.read();
  let callbacks = 0;
  assert.throws(() => new MemoryOperationLedger(f.db, f.tx, { ...options, now: f.clock }), code('CORRUPT_LEDGER'));
  assert.throws(() => f.ledger.deletionState(), code('CORRUPT_LEDGER'));
  assert.throws(() => guards[0]!.approve(core, intent('fresh', { expectedTombstoneWatermark: 1 }), (...args) => { callbacks++; return approved(...args); }), code('CORRUPT_LEDGER'));
  assert.throws(() => guards[1]!.claim(dispatcher, request('pending'), (...args) => { callbacks++; return allowed(...args); }), code('CORRUPT_LEDGER'));
  assert.throws(() => guards[2]!.assertDispatch(dispatcher, 'running', claim, (...args) => { callbacks++; return allowed(...args); }), code('CORRUPT_LEDGER'));
  assert.throws(() => guards[3]!.complete(verifier, 'running', 2, claim, result('running'), (...args) => { callbacks++; return verified(...args); }), code('CORRUPT_LEDGER'));
  assert.throws(() => guards[4]!.recheckPublication(verifier, deferred.command, () => { callbacks++; return publicationAllowed(); }), code('CORRUPT_LEDGER'));
  assert.equal(callbacks, 0); assert.deepEqual(f.watermark.read(), before);
});

test('a tampered derived deletion closure fails closed even when original references and barrier rows remain', t => {
  const f = fixture(t);
  f.ledger.approve(core, intent(), approved);
  f.ledger.approve(core, intent('derived', { sourceRefs: [{ sourceId: 'source-b', revision: 1 }], dependencyRefs: ['target-operation-a'] }), approved);
  erase(f, ['source-a']);
  const original = JSON.parse(String(f.db.prepare('SELECT closure_json FROM shiyu_memory_deletions').get()!.closure_json)) as string[];
  assert.ok(original.includes('source-a')); assert.ok(original.includes('target-derived'));
  f.tx.atomic(() => f.db.prepare('UPDATE shiyu_memory_deletions SET closure_json=?').run(JSON.stringify(original.filter(ref => ref !== 'target-derived'))));
  const before = f.watermark.read();
  assert.throws(() => f.ledger.approve(core, intent('new', { expectedTombstoneWatermark: 1 }), approved), code('CORRUPT_LEDGER'));
  assert.throws(() => new MemoryOperationLedger(f.db, f.tx, { ...options, now: f.clock }), code('CORRUPT_LEDGER'));
  assert.deepEqual(f.watermark.read(), before);
});

test('a current publication grant can reveal a settled receipt without another Effect, receipt or dispatch', t => {
  const f = fixture(t), pending = deferredPublication(f), before = f.watermark.read();
  const effect = f.effects.get(pending.claim.effectId), attempts = f.effects.attempts(pending.claim.effectId), receipts = f.ledger.receipts('operation-a'), effectReceipts = f.effects.receipts(pending.claim.effectId);
  const currentAuth = { ...auth, mandateVersion: 2, authEpoch: 3 };
  const applied = f.ledger.recheckPublication(verifier, pending.command, () => ({ ...publicationAllowed(), authorization: currentAuth }));
  assert.equal(applied.status, 'applied'); assert.equal(applied.nativeId, 'native-operation-a'); assert.equal(applied.version, pending.operation.version + 1);
  assert.equal(applied.reasonCode, undefined); assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
  assert.deepEqual(f.effects.get(pending.claim.effectId), effect); assert.deepEqual(f.effects.attempts(pending.claim.effectId), attempts);
  assert.deepEqual(f.ledger.receipts('operation-a'), receipts); assert.deepEqual(f.effects.receipts(pending.claim.effectId), effectReceipts);
  assert.deepEqual(applied.mandateRef, auth);
  const audit = JSON.parse(String(f.db.prepare('SELECT record_json FROM shiyu_memory_publications WHERE operation_id=?').get('operation-a')!.record_json));
  assert.deepEqual(audit.authorization, currentAuth); assert.equal(audit.checkedBy, verifier.principalId);
  assert.equal(audit.operationId, 'operation-a'); assert.equal(audit.receiptId, pending.receipt.receiptId);
  assert.equal(audit.version, applied.version); assert.equal(audit.previousVersion, pending.operation.version);
  assert.deepEqual(audit.deletionState, f.ledger.deletionState());
  const settled = f.watermark.read();
  assert.deepEqual(f.ledger.recheckPublication(verifier, { ...pending.command, expectedVersion: applied.version }, publicationAllowed), applied);
  assert.deepEqual(f.watermark.read(), settled);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_memory_publications').get()!.n, 1);
  f.db.close(); const reopened = f.open(); assert.deepEqual(reopened.ledger.get('operation-a'), applied);
  assert.deepEqual(reopened.ledger.receipts('operation-a'), receipts);
  assert.deepEqual(JSON.parse(String(reopened.db.prepare('SELECT record_json FROM shiyu_memory_publications WHERE operation_id=?').get('operation-a')!.record_json)), audit);
});

test('publication permission, source facts, scope, installation and operation CAS are rechecked', t => {
  const f = fixture(t), pending = deferredPublication(f), before = f.watermark.read();
  assert.throws(() => f.ledger.recheckPublication(core, pending.command, publicationAllowed), code('FORBIDDEN'));
  assert.throws(() => f.ledger.recheckPublication({ ...verifier, scopes: ['private-b'] }, pending.command, publicationAllowed), code('FORBIDDEN'));
  assert.throws(() => f.ledger.recheckPublication(verifier, { ...pending.command, expectedVersion: pending.operation.version - 1 }, publicationAllowed), code('VERSION_CONFLICT'));
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, () => ({ allowed: false, reasonCode: 'CONSENT_WITHDRAWN' })), code('FORBIDDEN'));
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, () => ({ ...publicationAllowed(), sourcesVerified: false })), code('UNVERIFIED_SOURCES'));
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, () => ({ ...publicationAllowed(), dependenciesVerified: false })), code('UNVERIFIED_DEPENDENCIES'));
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, () => ({ ...publicationAllowed(), authorization: { ...auth, installationGeneration: 'different-installation' } })), code('STALE_AUTHORIZATION', 'STALE_FENCE'));
  assert.throws(() => f.ledger.recheckPublication(verifier, { ...pending.command, receiptId: 'different-receipt' }, publicationAllowed), ledgerError);
  assert.throws(() => f.ledger.recheckPublication(verifier, { ...pending.command, receipt: result() } as never, publicationAllowed), code('INVALID_SCHEMA'));
  assert.deepEqual(f.ledger.get('operation-a'), pending.operation); assert.deepEqual(f.watermark.read(), before);
});

test('an unrelated deletion does not permanently pin publication to its original global watermark', t => {
  const f = fixture(t), pending = deferredPublication(f), effect = f.effects.get(pending.claim.effectId), receipts = f.ledger.receipts('operation-a');
  erase(f); assert.equal(f.ledger.deletionState().tombstoneWatermark, 1);
  const before = f.watermark.read();
  assert.equal(f.ledger.recheckPublication(verifier, pending.command, publicationAllowed).status, 'applied');
  assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
  assert.deepEqual(f.effects.get(pending.claim.effectId), effect); assert.deepEqual(f.ledger.receipts('operation-a'), receipts);
});

test('publication rollback retains the settled fact but does not reveal its native reference', t => {
  const f = fixture(t), pending = deferredPublication(f), before = f.watermark.read(), receipts = f.ledger.receipts('operation-a');
  assert.throws(() => f.tx.atomic(() => { assert.equal(f.ledger.recheckPublication(verifier, pending.command, publicationAllowed).status, 'applied'); throw new Error('publication rollback'); }), /publication rollback/);
  assert.deepEqual(f.ledger.get('operation-a'), pending.operation); assert.deepEqual(f.ledger.receipts('operation-a'), receipts);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM shiyu_memory_publications').get()!.n, 0);
  assert.equal(f.effects.get(pending.claim.effectId)!.status, 'succeeded'); assert.deepEqual(f.watermark.read(), before);
  assert.equal(f.ledger.recheckPublication(verifier, pending.command, publicationAllowed).status, 'applied');
});

test('publication hooks reject async and thenable execution without changing the ledger', async t => {
  const f = fixture(t), pending = deferredPublication(f), before = f.watermark.read(); let calls = 0;
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, (async () => { calls++; return publicationAllowed(); }) as never), code('ASYNC_POLICY'));
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, (() => ({ then() { calls++; } })) as never), code('ASYNC_POLICY'));
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, (() => Promise.reject(new Error('synthetic rejection'))) as never), code('ASYNC_POLICY'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
  assert.deepEqual(f.ledger.get('operation-a'), pending.operation); assert.deepEqual(f.watermark.read(), before);
});

test('publication recheck cannot settle unknown execution, invent missing proof or promote a rejected outcome', t => {
  const f = fixture(t); f.ledger.approve(core, intent(), approved);
  const command = { operationId: 'operation-a', expectedVersion: 1, receiptId: 'receipt-operation-a' };
  assert.throws(() => f.ledger.recheckPublication(verifier, command, publicationAllowed), ledgerError);
  const claim = f.ledger.claim(dispatcher, request(), allowed)!;
  const uncertain = f.ledger.markUnknown(dispatcher, 'operation-a', 2, claim, 'TIMEOUT');
  let before = f.watermark.read();
  assert.throws(() => f.ledger.recheckPublication(verifier, { ...command, expectedVersion: uncertain.version }, publicationAllowed), ledgerError);
  assert.equal(f.ledger.claim(dispatcher, request('operation-a', uncertain.version), allowed), undefined);
  assert.equal(f.effects.attempts(claim.effectId).length, 1); assert.deepEqual(f.watermark.read(), before);
  const rejected = f.ledger.reconcile(verifier, 'operation-a', uncertain.version, claim, result('operation-a', { outcome: 'rejected', nativeId: null }), verified);
  before = f.watermark.read();
  assert.throws(() => f.ledger.recheckPublication(verifier, { ...command, expectedVersion: rejected.version }, publicationAllowed), ledgerError);
  assert.equal(f.effects.get(claim.effectId)!.status, 'failed'); assert.deepEqual(f.watermark.read(), before);
});

test('a permanent source tombstone still blocks publication after a valid backend success', t => {
  const f = fixture(t), pending = deferredPublication(f); erase(f, ['source-a']);
  const blocked = f.ledger.get('operation-a')!, before = f.watermark.read();
  assert.equal(blocked.blocked, true);
  assert.throws(() => f.ledger.recheckPublication(verifier, { ...pending.command, expectedVersion: blocked.version }, publicationAllowed), code('TOMBSTONED'));
  assert.equal(f.ledger.get('operation-a')!.nativeId, undefined); assert.equal(f.effects.get(pending.claim.effectId)!.status, 'succeeded');
  assert.deepEqual(f.watermark.read(), before);
});

for (const table of ['shiyu_memory_receipts', 'shiyu_effect_receipts']) test(`publication rejects mismatched fixed proof in ${table}`, t => {
  const f = fixture(t), pending = deferredPublication(f); let calls = 0;
  f.tx.atomic(() => f.db.prepare(`UPDATE ${table} SET record_json=json_set(record_json,'$.externalOperationId','different-backend-operation') WHERE receipt_id=?`).run(pending.receipt.receiptId));
  const before = f.watermark.read();
  assert.throws(() => f.ledger.recheckPublication(verifier, pending.command, () => { calls++; return publicationAllowed(); }), code('CORRUPT_LEDGER'));
  assert.equal(calls, 0); assert.equal(f.ledger.get('operation-a')!.nativeId, undefined);
  assert.deepEqual(f.watermark.read(), before);
});

test('dependency-delayed publication may resume after the pending dependency mutation is rejected', t => {
  const f = fixture(t);
  f.ledger.approve(core, intent(), approved); const sourceClaim = f.ledger.claim(dispatcher, request(), allowed)!;
  f.ledger.complete(verifier, 'operation-a', 2, sourceClaim, result(), verified);
  f.ledger.approve(core, intent('derived', { sourceRefs: [{ sourceId: 'other-source', revision: 1 }], dependencyRefs: ['target-operation-a'] }), approved);
  const claim = f.ledger.claim(dispatcher, request('derived'), allowed)!;
  f.ledger.approve(core, intent('source-change', { targetRef: 'target-operation-a' }), approved);
  const pending = f.ledger.complete(verifier, 'derived', 2, claim, result('derived'), verified);
  assert.equal(pending.reasonCode, 'DEPENDENCY_NOT_APPLIED'); assert.equal(pending.status, 'unknown');
  const command = { operationId: 'derived', expectedVersion: pending.version, receiptId: 'receipt-derived' };
  assert.throws(() => f.ledger.recheckPublication(verifier, command, publicationAllowed), code('DEPENDENCY_NOT_APPLIED'));
  f.ledger.reject(core, 'source-change', 1, 'CANCELLED_BEFORE_DISPATCH');
  const before = f.watermark.read(), effect = f.effects.get(claim.effectId);
  assert.equal(f.ledger.recheckPublication(verifier, command, publicationAllowed).status, 'applied');
  assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1); assert.deepEqual(f.effects.get(claim.effectId), effect);
});
