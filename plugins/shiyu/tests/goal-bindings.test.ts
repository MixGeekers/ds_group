import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SQLiteGoalBindingStore } from '../src/adapters/control-store/goal-bindings.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { goalCommandIdentity } from '../src/adapters/dsh/goals.js';
import type { GoalBinding } from '../src/adapters/dsh/goals.js';

const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-goal-bindings-')), filename = join(directory, 'control.sqlite');
  const connections: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(filename); connections.push(db);
    db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;');
    const transactions = new SqliteTransactions(db), store = new SQLiteGoalBindingStore(db, transactions);
    return { db, transactions, store };
  };
  t.after(() => { for (const db of connections) if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, filename };
}
function binding(goalId = 'synthetic-goal'): GoalBinding {
  return { goalId, sessionId: `synthetic-session:${goalId}`, ownerId: 'synthetic-owner', scope: 'local-owner', cwd: '/synthetic/shiyu',
    completionCriteriaHash: 'a'.repeat(64), metadataVersion: 1,
    receipt: { commandId: `create:${goalId}`, operation: 'create', status: 'pending', postconditionHash: 'b'.repeat(64) } };
}
function confirmed(value: GoalBinding): GoalBinding {
  const goalRef = { id: 'synthetic-native-goal', revision: (value.receipt?.expectedRef?.revision ?? 0) + 1 };
  return { ...value, metadataVersion: value.metadataVersion + 1, goalRef, receipt: { ...value.receipt!, status: 'confirmed', observedRef: goalRef } };
}
function command(value: GoalBinding, commandId: string, operation: 'pause' | 'resume' | 'update' = 'pause'): GoalBinding {
  return { ...value, metadataVersion: value.metadataVersion + 1, receipt: { commandId, operation, status: 'pending', expectedRef: value.goalRef, postconditionHash: 'c'.repeat(64) } };
}
function advance(store: SQLiteGoalBindingStore, old: GoalBinding, next: GoalBinding): GoalBinding {
  store.compareAndSet(old.metadataVersion, next); return next;
}

test('bindings and command history survive reopening without native state or object aliasing', async t => {
  const f = fixture(t), first = binding(); f.store.compareAndSet(undefined, first);
  const complete = advance(f.store, first, confirmed(first));
  const pending = advance(f.store, complete, command(complete, 'pause-1'));
  const unknown = advance(f.store, pending, { ...pending, metadataVersion: pending.metadataVersion + 1,
    receipt: { ...pending.receipt!, status: 'unknown', reason: 'synthetic interruption after native write' } });
  f.db.close();
  const reopened = f.open().store;
  assert.deepEqual(reopened.load(first.goalId), unknown);
  assert.equal(reopened.loadCommand(first.goalId, first.receipt!.commandId)!.status, 'confirmed');
  assert.equal(reopened.loadCommand(first.goalId, 'pause-1')!.status, 'unknown');
  const read = reopened.load(first.goalId)!; read.receipt!.reason = 'caller mutation'; read.goalRef!.revision = 100;
  assert.deepEqual(await reopened.asPort().load(first.goalId), unknown);
  const historical = await reopened.asPort().loadCommand(first.goalId, first.receipt!.commandId); historical!.status = 'unknown';
  assert.equal(reopened.loadCommand(first.goalId, first.receipt!.commandId)!.status, 'confirmed');
  assert.equal('phase' in unknown, false); assert.equal('objective' in unknown, false); assert.equal('roundsStarted' in unknown, false);
  assert.throws(() => reopened.compareAndSet(unknown.metadataVersion, command(unknown, 'unsafe-resume', 'resume')), code('GOAL_COMMAND_UNRESOLVED'));
});

test('CAS advances one metadata version and fixes owner, scope, cwd, native Session and completion criteria', t => {
  const { store } = fixture(t), first = binding();
  assert.throws(() => store.compareAndSet(undefined, { ...first, metadataVersion: 2 }), code('GOAL_BINDING_INVALID'));
  store.compareAndSet(undefined, first);
  assert.throws(() => store.compareAndSet(undefined, first), code('GOAL_BINDING_CONFLICT'));
  const next = confirmed(first);
  for (const patch of [{ ownerId: 'other' }, { scope: 'other' }, { cwd: '/another/synthetic' }, { sessionId: 'other-session' }, { completionCriteriaHash: 'd'.repeat(64) }]) {
    assert.throws(() => store.compareAndSet(1, { ...next, ...patch }), code('GOAL_BINDING_CONFLICT'));
  }
  assert.throws(() => store.compareAndSet(undefined, { ...binding('other-goal'), sessionId: first.sessionId }), code('GOAL_BINDING_CONFLICT'));
  advance(store, first, next);
  assert.throws(() => store.compareAndSet(1, next), code('GOAL_BINDING_CONFLICT'));
  assert.throws(() => store.compareAndSet(2, { ...next, metadataVersion: 4 }), code('GOAL_BINDING_INVALID'));
  assert.equal(store.load(first.goalId)!.metadataVersion, 2);
});

test('trusted owner and scope list filters expose only matching bindings in deterministic order', t => {
  const { store } = fixture(t);
  const values = [binding('z-local'), { ...binding('other-owner'), ownerId: 'different-owner' },
    { ...binding('other-scope'), scope: 'different-scope' }, binding('a-local')];
  for (const value of values) store.compareAndSet(undefined, value);
  const visible = store.list({ ownerId: 'synthetic-owner', scope: 'local-owner' });
  assert.deepEqual(visible.map(value => value.goalId), ['a-local', 'z-local']);
  visible[0].scope = 'caller mutation';
  assert.equal(store.list({ ownerId: 'synthetic-owner', scope: 'local-owner' }).length, 2);
  assert.deepEqual(store.list({ ownerId: 'unknown-owner', scope: 'local-owner' }), []);
  assert.throws(() => store.list({ ownerId: 'synthetic-owner' } as never), code('GOAL_BINDING_INVALID'));
});

test('current receipt can become unknown after confirmation but historical command IDs never dispatch again', t => {
  const { store } = fixture(t), first = binding(); store.compareAndSet(undefined, first);
  let current = advance(store, first, confirmed(first));
  const originalIdentity = goalCommandIdentity(current.receipt!);
  current = advance(store, current, { ...current, metadataVersion: current.metadataVersion + 1, receipt: { ...current.receipt!, status: 'unknown', reason: 'synthetic native handle disposal failed' } });
  assert.equal(goalCommandIdentity(current.receipt!), originalIdentity);
  current = advance(store, current, { ...current, metadataVersion: current.metadataVersion + 1, receipt: { ...current.receipt!, status: 'confirmed', reason: 'independent native read-back' } });
  const createReceipt = structuredClone(current.receipt!);
  const pending = advance(store, current, command(current, 'pause-1'));
  current = advance(store, pending, confirmed(pending));
  assert.throws(() => store.compareAndSet(current.metadataVersion, { ...current, metadataVersion: current.metadataVersion + 1,
    receipt: { ...createReceipt, status: 'unknown' } }), code('GOAL_COMMAND_REPLAY'));
  const reused = command(current, 'pause-1');
  assert.throws(() => store.compareAndSet(current.metadataVersion, reused), code('GOAL_COMMAND_CONFLICT'));
  assert.equal(store.loadCommand(first.goalId, first.receipt!.commandId)!.status, 'confirmed');
  assert.equal(store.loadCommand(first.goalId, 'pause-1')!.status, 'confirmed');
  const repeatedPending = { ...current, metadataVersion: current.metadataVersion + 1, receipt: { ...current.receipt!, status: 'pending' as const } };
  assert.throws(() => store.compareAndSet(current.metadataVersion, repeatedPending), code('GOAL_COMMAND_CONFLICT'));
});

test('command identity rejects changed expected refs, postconditions and proof evidence without losing history', t => {
  const { store } = fixture(t), first = binding(); store.compareAndSet(undefined, first);
  const created = advance(store, first, confirmed(first));
  const completion: GoalBinding = { ...created, metadataVersion: created.metadataVersion + 1, receipt: {
    commandId: 'complete-1', operation: 'complete', status: 'pending', expectedRef: created.goalRef, postconditionHash: 'd'.repeat(64), evidenceRefs: ['artifact:synthetic'],
    completionProof: { goalRef: created.goalRef!, completionCriteriaHash: created.completionCriteriaHash, evidenceRefs: ['artifact:synthetic'], verifierId: 'synthetic-independent-verifier', verifiedAt: '2026-11-02T12:00:00.000Z' },
  } };
  advance(store, created, completion);
  const finish = confirmed(completion);
  const changedProof = { ...finish.receipt!.completionProof!, verifierId: 'different-verifier' };
  assert.throws(() => store.compareAndSet(completion.metadataVersion, { ...finish, receipt: { ...finish.receipt!, completionProof: changedProof } }), code('GOAL_COMMAND_CONFLICT'));
  assert.throws(() => store.compareAndSet(completion.metadataVersion, { ...finish, receipt: { ...finish.receipt!, postconditionHash: 'e'.repeat(64) } }), code('GOAL_COMMAND_CONFLICT'));
  advance(store, completion, finish);
  assert.equal(store.loadCommand(first.goalId, 'complete-1')!.completionProof!.verifierId, 'synthetic-independent-verifier');
});

test('binding and journal roll back together on journal failure and with an enclosing domain transaction', t => {
  const { store, db, transactions } = fixture(t), first = binding();
  assert.throws(() => transactions.atomic(() => { store.compareAndSet(undefined, first); throw new Error('synthetic outer transaction failure'); }), /outer transaction failure/);
  assert.equal(store.load(first.goalId), undefined); assert.equal(store.loadCommand(first.goalId, first.receipt!.commandId), undefined);
  store.compareAndSet(undefined, first); const created = advance(store, first, confirmed(first));
  db.exec(`CREATE TRIGGER synthetic_goal_journal_failure BEFORE INSERT ON shiyu_goal_commands
    WHEN new.command_id='atomic-failure' BEGIN SELECT RAISE(ABORT,'synthetic journal failure'); END;`);
  assert.throws(() => store.compareAndSet(created.metadataVersion, command(created, 'atomic-failure')), /synthetic journal failure/);
  assert.deepEqual(store.load(first.goalId), created); assert.equal(store.loadCommand(first.goalId, 'atomic-failure'), undefined);
  assert.equal(transactions.poisoned, false);
  db.exec('DROP TRIGGER synthetic_goal_journal_failure');
  advance(store, created, command(created, 'atomic-failure'));
});

test('metadata validation excludes native state and corrupt or unsupported persisted records fail closed', t => {
  const { store, db, transactions } = fixture(t), first = binding();
  for (const extra of [{ phase: 'active' }, { objective: 'native goal text' }, { roundsStarted: 5 }]) {
    assert.throws(() => store.compareAndSet(undefined, { ...first, ...extra }), code('GOAL_BINDING_INVALID'));
  }
  assert.throws(() => store.compareAndSet(undefined, { ...first, cwd: '/synthetic/../shiyu' }), code('GOAL_BINDING_INVALID'));
  assert.throws(() => store.compareAndSet(undefined, { ...first, receipt: { ...first.receipt!, phase: 'active' } } as never), code('GOAL_BINDING_INVALID'));
  const other = new DatabaseSync(':memory:');
  try { assert.throws(() => new SQLiteGoalBindingStore(other, transactions), /same SQLite connection/); } finally { other.close(); }
  store.compareAndSet(undefined, first);
  db.prepare('UPDATE shiyu_goal_commands SET identity_hash=? WHERE goal_id=?').run('0'.repeat(64), first.goalId);
  assert.throws(() => store.load(first.goalId), code('GOAL_BINDING_CORRUPT'));
  assert.throws(() => store.loadCommand(first.goalId, first.receipt!.commandId), code('GOAL_BINDING_CORRUPT'));
  db.exec('UPDATE shiyu_goal_binding_meta SET version=99 WHERE id=1');
  assert.throws(() => new SQLiteGoalBindingStore(db, transactions), code('GOAL_BINDING_SCHEMA'));
  assert.equal(db.prepare('SELECT count(*) AS count FROM shiyu_goal_bindings').get()!.count, 1);
});

test('rejected commands remain historical and a new command can be admitted after a known rejection', t => {
  const { store } = fixture(t), first = binding(); store.compareAndSet(undefined, first);
  const created = advance(store, first, confirmed(first));
  const pending = advance(store, created, command(created, 'revoked-pause'));
  const rejected = advance(store, pending, { ...pending, metadataVersion: pending.metadataVersion + 1, receipt: { ...pending.receipt!, status: 'rejected', reason: 'synthetic authority revoked before native call' } });
  const fresh = advance(store, rejected, command(rejected, 'fresh-pause'));
  assert.equal(store.loadCommand(first.goalId, 'revoked-pause')!.status, 'rejected');
  assert.equal(store.load(first.goalId)!.receipt!.commandId, fresh.receipt!.commandId);
});

test('independent SQLite worker connections compete for initial and subsequent CAS without losing command history', async t => {
  const { store, filename } = fixture(t), first = binding();
  const source = `
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    (async()=>{
      const {register}=await import('tsx/esm/api'); const unregister=register();
      const {SqliteTransactions}=await import(workerData.txModule);
      const {SQLiteGoalBindingStore}=await import(workerData.storeModule);
      const db=new DatabaseSync(workerData.filename); db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;');
      const store=new SQLiteGoalBindingStore(db,new SqliteTransactions(db));
      parentPort.on('message',async input=>{
        if(input==='close'){db.close();await unregister();parentPort.close();return;}
        Atomics.add(new Int32Array(workerData.barrier),0,1);
        Atomics.wait(new Int32Array(workerData.barrier),1,0);
        try{store.compareAndSet(input.expected,input.binding);parentPort.postMessage({ok:true});}
        catch(error){parentPort.postMessage({ok:false,code:error.code});}
      });
      parentPort.postMessage({ready:true});
    })().catch(error=>{parentPort.postMessage({fatal:String(error)});process.exitCode=1;});`;
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2), gate = new Int32Array(barrier);
  const workers = Array.from({ length: 5 }, () => new Worker(source, { eval: true, workerData: { filename, barrier,
    txModule: new URL('../src/adapters/control-store/transaction.ts', import.meta.url).href,
    storeModule: new URL('../src/adapters/control-store/goal-bindings.ts', import.meta.url).href,
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    worker.once('error', reject); worker.once('message', message => message.ready ? resolve() : reject(new Error(JSON.stringify(message))));
  })));
  async function compete(expected: number | undefined, candidates: GoalBinding[]) {
    Atomics.store(gate, 0, 0); Atomics.store(gate, 1, 0);
    const outcomes = workers.map((worker, index) => new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
      worker.once('error', reject); worker.once('message', resolve); worker.postMessage({ expected, binding: candidates[index] });
    }));
    const deadline = Date.now() + 10000;
    while (Atomics.load(gate, 0) !== workers.length) {
      if (Date.now() > deadline) throw new Error('SQLite competition barrier timed out');
      await new Promise<void>(resolve => setTimeout(resolve, 2));
    }
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    const results = await Promise.all(outcomes);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.code === 'GOAL_BINDING_CONFLICT').length, workers.length - 1);
  }
  await compete(undefined, workers.map(() => first));
  const created = advance(store, first, confirmed(first));
  const candidates = workers.map((_, index) => command(created, `competing-pause-${index}`));
  await compete(created.metadataVersion, candidates);
  const winner = store.load(first.goalId)!;
  assert.equal(winner.metadataVersion, 3);
  assert.equal(candidates.filter(candidate => store.loadCommand(first.goalId, candidate.receipt!.commandId)).length, 1);
  assert.equal(store.loadCommand(first.goalId, first.receipt!.commandId)!.status, 'confirmed');
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    worker.once('exit', status => status === 0 ? resolve() : reject(new Error(`SQLite test worker exit ${status}`))); worker.postMessage('close');
  })));
});
