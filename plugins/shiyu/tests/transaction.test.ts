import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteTransactions, SynchronousTransactionRequired, TransactionFailure, TransactionPoisonedError,
} from '../src/adapters/control-store/transaction.js';
import type { TransactionConnection, TransactionOptions } from '../src/adapters/control-store/transaction.js';

interface Fault { sql: RegExp; error: Error; after?: boolean; remaining?: number }
class FaultConnection implements TransactionConnection {
  readonly statements: string[] = [];
  readonly faults: Fault[] = [];
  constructor(readonly db: DatabaseSync) {}
  get isTransaction() { return this.db.isTransaction; }
  exec(sql: string) {
    this.statements.push(sql);
    const fault = this.faults.find(fault => fault.sql.test(sql) && (fault.remaining ?? 1) > 0);
    if (fault) fault.remaining = (fault.remaining ?? 1) - 1;
    if (fault && !fault.after) throw fault.error;
    this.db.exec(sql);
    if (fault) throw fault.error;
  }
}
function fixture(t: TestContext, options: TransactionOptions = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shiyu-transaction-'));
  const filename = path.join(directory, 'control.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0; CREATE TABLE item (id INTEGER PRIMARY KEY)');
  const connection = new FaultConnection(db);
  const tx = new SqliteTransactions(connection, options);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const insert = (id: number) => { tx.assertUsable(); db.prepare('INSERT INTO item VALUES (?)').run(id); };
  const rows = () => db.prepare('SELECT id FROM item ORDER BY id').all().map(row => row.id);
  return { db, filename, connection, tx, insert, rows };
}
function capture(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  assert.fail('Expected operation to fail');
}
function errors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
}

test('outer transaction uses BEGIN IMMEDIATE and commits nested work before ordered notifications', t => {
  const { db, connection, tx, insert, rows } = fixture(t);
  assert.equal(tx.owns(connection), true); assert.equal(tx.owns(db), false);
  const notifications: string[] = [];
  const result = tx.atomic(() => {
    assert.equal(tx.depth, 1); insert(1);
    tx.afterCommit(() => { assert.equal(db.isTransaction, false); assert.equal(tx.depth, 0); notifications.push('outer-first'); });
    assert.equal(tx.atomic(() => { assert.equal(tx.depth, 2); insert(2); tx.afterCommit(() => { notifications.push('inner'); }); return 'inner-result'; }), 'inner-result');
    tx.afterCommit(() => { notifications.push('outer-last'); });
    assert.deepEqual(notifications, []);
    return 17;
  });
  assert.equal(result, 17);
  assert.deepEqual(rows(), [1, 2]);
  assert.deepEqual(notifications, ['outer-first', 'inner', 'outer-last']);
  assert.match(connection.statements[0]!, /^BEGIN IMMEDIATE$/);
  assert.match(connection.statements[1]!, /^SAVEPOINT shiyu_atomic_1$/);
  assert.equal(connection.statements.at(-1), 'COMMIT');
});

test('nested rollback discards only its writes and notifications; outer rollback discards all descendants', t => {
  const { tx, insert, rows } = fixture(t);
  const invoked: number[] = [];
  const innerFailure = new Error('inner domain rejection');
  tx.atomic(() => {
    insert(1); tx.afterCommit(() => { invoked.push(1); });
    assert.throws(() => tx.atomic(() => { insert(2); tx.afterCommit(() => { invoked.push(2); }); throw innerFailure; }), error => error === innerFailure);
    tx.atomic(() => { insert(3); tx.afterCommit(() => { invoked.push(3); }); });
  });
  assert.deepEqual(rows(), [1, 3]); assert.deepEqual(invoked, [1, 3]);
  const outerFailure = new Error('outer domain rejection');
  assert.throws(() => tx.atomic(() => {
    insert(4); tx.afterCommit(() => { invoked.push(4); });
    tx.atomic(() => { insert(5); tx.afterCommit(() => { invoked.push(5); }); });
    throw outerFailure;
  }), error => error === outerFailure);
  assert.deepEqual(rows(), [1, 3]); assert.deepEqual(invoked, [1, 3]);
  assert.equal(tx.depth, 0); assert.equal(tx.poisoned, false);
});

test('busy BEGIN acquires no frame, executes no callback and permits a later retry', t => {
  const { filename, tx, insert, rows } = fixture(t);
  const blocker = new DatabaseSync(filename); blocker.exec('BEGIN IMMEDIATE');
  let called = false;
  const failure = capture(() => tx.atomic(() => { called = true; }));
  assert.ok(failure instanceof TransactionFailure);
  assert.equal(failure.phase, 'begin'); assert.equal(failure.outcome, 'not_started');
  assert.equal(failure.poisoned, false); assert.equal(called, false); assert.equal(tx.depth, 0);
  blocker.exec('ROLLBACK'); blocker.close();
  tx.atomic(() => insert(1)); assert.deepEqual(rows(), [1]);
});

test('SAVEPOINT failure never pushes a frame and caught inner failure cannot permit outer commit', t => {
  const { db, connection, tx, insert, rows } = fixture(t);
  const fault = new Error('cannot create savepoint');
  connection.faults.push({ sql: /^SAVEPOINT/, error: fault });
  let innerCalled = false; let notified = false;
  const failure = capture(() => tx.atomic(() => {
    insert(1); tx.afterCommit(() => { notified = true; });
    const inner = capture(() => tx.atomic(() => { innerCalled = true; }));
    assert.ok(inner instanceof TransactionFailure);
    assert.ok(errors(inner).includes(fault)); assert.equal(tx.depth, 1);
    // Domain code swallowing an inner failure does not clear quarantine.
  }));
  assert.ok(failure instanceof TransactionFailure);
  assert.equal(tx.poisoned, true); assert.equal(tx.depth, 0);
  assert.equal(innerCalled, false); assert.equal(notified, false);
  assert.equal(db.isTransaction, false); assert.deepEqual(rows(), []);
  assert.equal(connection.statements.includes('COMMIT'), false);
  assert.throws(() => tx.atomic(() => undefined), TransactionPoisonedError);
});

test('native async callbacks are not invoked; returned Promises and thenables roll back synchronous writes', async t => {
  const { tx, insert, rows } = fixture(t);
  let asyncCalled = false;
  const asyncCallback = async () => { asyncCalled = true; insert(1); };
  assert.throws(() => tx.atomic(asyncCallback as unknown as () => void), SynchronousTransactionRequired);
  assert.equal(asyncCalled, false);
  const rejected = new Error('already-created rejected Promise');
  assert.throws(() => tx.atomic((): unknown => { insert(2); return Promise.reject(rejected); }), SynchronousTransactionRequired);
  const unusualPromise = Promise.reject(new Error('rejection with a throwing then getter'));
  Object.defineProperty(unusualPromise, 'then', { get() { throw new Error('overridden then'); } });
  assert.throws(() => tx.atomic((): unknown => unusualPromise), SynchronousTransactionRequired);
  let assimilated = false;
  assert.throws(() => tx.atomic((): unknown => { insert(3); return { then() { assimilated = true; } }; }), SynchronousTransactionRequired);
  assert.equal(assimilated, false);
  const getterFailure = new Error('then getter rejected');
  assert.throws(() => tx.atomic((): unknown => { insert(4); return { get then() { throw getterFailure; } }; }), error => error === getterFailure);
  await new Promise(resolve => setImmediate(resolve)); // node:test also fails on any unhandled rejection.
  assert.deepEqual(rows(), []); assert.equal(tx.poisoned, false);
  if (false) {
    // @ts-expect-error async transactions are rejected by the public type too.
    tx.atomic(async () => 1);
    // @ts-expect-error wake-up notifications must be synchronous.
    tx.afterCommit(async () => undefined);
  }
});

test('COMMIT failure rolls back, preserves its cause, suppresses notification and quarantines', t => {
  const { db, connection, tx, insert, rows } = fixture(t);
  const commitFailure = new Error('commit denied');
  connection.faults.push({ sql: /^COMMIT$/, error: commitFailure });
  let notified = false;
  const failure = capture(() => tx.atomic(() => { insert(1); tx.afterCommit(() => { notified = true; }); }));
  assert.ok(failure instanceof TransactionFailure);
  assert.equal(failure.phase, 'commit'); assert.equal(failure.outcome, 'rolled_back');
  assert.equal(failure.cause, commitFailure); assert.equal(failure.poisoned, true);
  assert.equal(notified, false); assert.equal(db.isTransaction, false); assert.deepEqual(rows(), []);
});

test('a failure reported after actual COMMIT remains unknown and is never disguised as rollback', t => {
  const { connection, tx, insert, rows } = fixture(t);
  const lostResult = new Error('lost commit result');
  connection.faults.push({ sql: /^COMMIT$/, error: lostResult, after: true });
  let notified = false;
  const failure = capture(() => tx.atomic(() => { insert(1); tx.afterCommit(() => { notified = true; }); }));
  assert.ok(failure instanceof TransactionFailure);
  assert.equal(failure.outcome, 'unknown'); assert.equal(tx.poisoned, true);
  assert.deepEqual(rows(), [1]); assert.equal(notified, false);
  assert.equal(connection.statements.includes('ROLLBACK'), false);
  assert.throws(() => tx.atomic(() => undefined), TransactionPoisonedError);
});

test('domain failure and all nested cleanup failures survive; outer catch cannot commit', t => {
  const { db, connection, tx, insert, rows } = fixture(t);
  const domain = new Error('domain rejected');
  const rollback = new Error('rollback to failed');
  const release = new Error('release failed');
  connection.faults.push({ sql: /^ROLLBACK TO/, error: rollback }, { sql: /^RELEASE SAVEPOINT/, error: release });
  let innerFailure: unknown;
  const outerFailure = capture(() => tx.atomic(() => {
    insert(1);
    innerFailure = capture(() => tx.atomic(() => { insert(2); throw domain; }));
  }));
  assert.ok(innerFailure instanceof TransactionFailure);
  assert.deepEqual(errors(innerFailure), [domain, rollback, release]);
  assert.equal(innerFailure.outcome, 'unknown'); assert.equal(innerFailure.poisoned, true);
  assert.ok(outerFailure instanceof TransactionFailure);
  assert.equal(outerFailure.outcome, 'rolled_back');
  assert.equal(connection.statements.includes('COMMIT'), false);
  assert.equal(db.isTransaction, false); assert.deepEqual(rows(), []); assert.equal(tx.depth, 0);
});

test('failed RELEASE after SQLite released the savepoint retains cleanup error and outer rollback', t => {
  const { connection, tx, insert, rows } = fixture(t);
  const lostRelease = new Error('lost release result');
  connection.faults.push({ sql: /^RELEASE SAVEPOINT/, error: lostRelease, after: true });
  let innerFailure: unknown;
  capture(() => tx.atomic(() => {
    insert(1);
    innerFailure = capture(() => tx.atomic(() => { insert(2); }));
  }));
  assert.ok(innerFailure instanceof TransactionFailure);
  assert.equal(innerFailure.cause, lostRelease);
  assert.equal(errors(innerFailure).length, 3);
  assert.equal(innerFailure.outcome, 'unknown'); assert.deepEqual(rows(), []);
});

test('outer rollback failure keeps original error and poisons every later access', t => {
  const { db, connection, tx, insert } = fixture(t);
  const domain = new Error('domain rejected'); const rollback = new Error('rollback unavailable');
  connection.faults.push({ sql: /^ROLLBACK$/, error: rollback });
  const failure = capture(() => tx.atomic(() => { insert(1); throw domain; }));
  assert.ok(failure instanceof TransactionFailure);
  assert.deepEqual(errors(failure).slice(0, 2), [domain, rollback]);
  assert.match((errors(failure)[2] as Error).message, /state changed outside/);
  assert.equal(failure.outcome, 'unknown'); assert.equal(tx.depth, 0); assert.equal(tx.poisoned, true);
  assert.throws(() => tx.assertUsable(), TransactionPoisonedError);
  assert.throws(() => tx.afterCommit(() => undefined), TransactionPoisonedError);
  // Owner teardown may close a quarantined connection; business code cannot resume it.
  db.exec('ROLLBACK');
});

test('notification and diagnostic failures do not throw or roll back committed data; other notifications still run', t => {
  const reporting = new Error('diagnostic sink failed'); const wake = new Error('wake failed');
  const { connection, tx, insert, rows } = fixture(t, { onNotificationFailure(failure) { assert.equal(failure.committed, true); throw reporting; } });
  let later = false;
  const result = tx.atomic(() => {
    insert(1);
    tx.afterCommit(() => { throw wake; });
    tx.afterCommit(() => { later = true; });
    return 'committed-value';
  });
  assert.equal(result, 'committed-value'); assert.deepEqual(rows(), [1]); assert.equal(later, true);
  assert.deepEqual(tx.lastNotificationFailure?.errors, [wake, reporting]);
  assert.equal(tx.lastNotificationFailure?.committed, true);
  assert.equal(tx.poisoned, false); assert.equal(connection.statements.includes('ROLLBACK'), false);
  tx.atomic(() => insert(2)); assert.deepEqual(rows(), [1, 2]);
});

test('commit notification reentry starts an independent transaction after old frames are removed', t => {
  const { tx, insert, rows } = fixture(t);
  const order: string[] = [];
  tx.atomic(() => {
    insert(1);
    tx.afterCommit(() => {
      assert.equal(tx.depth, 0); order.push('first');
      tx.atomic(() => { insert(2); tx.afterCommit(() => { order.push('new'); }); });
    });
    tx.afterCommit(() => { order.push('last'); });
  });
  assert.deepEqual(rows(), [1, 2]); assert.deepEqual(order, ['first', 'new', 'last']);
  tx.afterCommit(() => { order.push('immediate'); });
  assert.equal(order.at(-1), 'immediate');
});

test('foreign transaction ownership is refused, without rolling back somebody else’s work', t => {
  const { db, connection, tx } = fixture(t);
  db.exec('BEGIN'); let called = false;
  assert.throws(() => tx.atomic(() => { called = true; }), /outside its owner/);
  assert.equal(called, false); assert.equal(tx.poisoned, true);
  assert.deepEqual(connection.statements, []); assert.equal(db.isTransaction, true);
  db.exec('ROLLBACK');
});

test('BEGIN and transaction-state inspection failures are both preserved', () => {
  const begin = new Error('begin failed'); const state = new Error('state unavailable');
  let broken = false;
  const tx = new SqliteTransactions({
    exec() { broken = true; throw begin; },
    get isTransaction() { if (broken) throw state; return false; },
  });
  const failure = capture(() => tx.atomic(() => undefined));
  assert.ok(failure instanceof TransactionFailure);
  assert.deepEqual(errors(failure), [begin, state]);
  assert.equal(failure.outcome, 'unknown'); assert.equal(failure.poisoned, true); assert.equal(tx.depth, 0);
});

test('async diagnostic sinks are rejected and rejected Promise sinks do not escape as unhandled', async t => {
  let asyncCalled = false;
  const a = fixture(t, { async onNotificationFailure() { asyncCalled = true; throw new Error('must not run'); } });
  a.tx.atomic(() => { a.insert(1); a.tx.afterCommit(() => { throw new Error('wake'); }); });
  assert.equal(asyncCalled, false);
  assert.ok(a.tx.lastNotificationFailure?.errors[1] instanceof SynchronousTransactionRequired);
  const b = fixture(t, { onNotificationFailure() { return Promise.reject(new Error('async return')); } });
  b.tx.atomic(() => { b.insert(2); b.tx.afterCommit(() => { throw new Error('wake'); }); });
  assert.ok(b.tx.lastNotificationFailure?.errors[1] instanceof SynchronousTransactionRequired);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(a.rows(), [1]); assert.deepEqual(b.rows(), [2]);
});

test('immediate notifications cannot run inside a foreign transaction or claim a commit that did not occur', t => {
  const a = fixture(t); let called = false;
  a.db.exec('BEGIN');
  assert.throws(() => a.tx.afterCommit(() => { called = true; }), /outside its owner/);
  assert.equal(called, false); assert.equal(a.db.isTransaction, true); a.db.exec('ROLLBACK');
  const b = fixture(t);
  b.tx.afterCommit(() => { throw new Error('immediate wake failed'); });
  assert.equal(b.tx.lastNotificationFailure?.committed, false);
  assert.equal(b.tx.poisoned, false);
});
