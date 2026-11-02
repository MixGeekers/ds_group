import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { MandateStore, MandateError } from '../src/control/policy/mandates.js';
import type { Budget, Mandate, MandateInput, PermitRequest, ReserveInput, TrustedPolicyActor } from '../src/control/policy/mandates.js';

const owner: TrustedPolicyActor = { principalId: 'local-owner', kind: 'owner', scopes: ['local'] };
const worker: TrustedPolicyActor = { principalId: 'worker', kind: 'agent', scopes: ['local'] };
const dispatcher: TrustedPolicyActor = { principalId: 'dispatcher', kind: 'component', scopes: ['local'] };
const observer: TrustedPolicyActor = { principalId: 'usage-observer', kind: 'component', scopes: ['local'] };
const options = { ownerIds: ['local-owner'], dispatcherIds: ['dispatcher'], reconcilerIds: ['usage-observer'], actionCosts: {
  'artifact.write': { tokens: 0, calls: 0, effects: 1 }, 'model.generate': { tokens: 1, calls: 1, effects: 0 },
} };
const initial = '2026-11-02T12:00:00.000Z';
const expires = '2026-11-02T13:00:00.000Z';
function grantInput(patch: Partial<MandateInput> = {}): MandateInput {
  return { id: 'mandate', scope: 'local', subjectIds: ['worker'], allowedActions: ['artifact.write'], allowedResources: ['artifact:task-1'], limits: { tokens: 100, calls: 10, effects: 10 }, basisRef: 'owner-control:synthetic', expiresAt: expires, ...patch };
}
function reserveInput(mandate: Mandate, id = 'effect-1', amount: Budget = { tokens: 10, calls: 1, effects: 1 }): ReserveInput {
  return { reservationId: id, mandateId: mandate.mandateId, mandateVersion: mandate.version, authEpoch: mandate.authEpoch, scope: 'local', action: 'artifact.write', resourceScopes: ['artifact:task-1'], amount };
}
function permit(input: ReserveInput): PermitRequest { const { amount: _amount, leaseMs: _leaseMs, ...value } = input; return value; }
function code(expected: string) { return (error: unknown) => error instanceof MandateError && error.code === expected; }
function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'shiyu-mandates-'));
  const filename = path.join(directory, 'control.sqlite'); let now = initial;
  const db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
  const tx = new SqliteTransactions(db);
  const store = new MandateStore(db, tx, { ...options, now: () => new Date(now) });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { db, tx, store, filename, setTime(value: string) { now = value; } };
}

test('only configured owner grants trusted identity; stable grant IDs do not widen or resurrect authority', t => {
  const { store } = fixture(t);
  assert.throws(() => store.grant(worker, grantInput()), code('FORBIDDEN'));
  assert.throws(() => store.grant({ ...owner, principalId: 'unrecognized-owner' }, grantInput()), code('FORBIDDEN'));
  assert.throws(() => store.grant(owner, { ...grantInput(), issuer: 'forged' } as MandateInput), code('INVALID_SCHEMA'));
  const granted = store.grant(owner, grantInput());
  assert.equal(granted.issuer, owner.principalId); assert.equal(granted.version, 1); assert.equal(granted.authEpoch, 1);
  assert.deepEqual(store.grant(owner, grantInput()), granted);
  granted.allowedResources.push('anything'); assert.deepEqual(store.get(owner, 'mandate').allowedResources, ['artifact:task-1']);
  assert.throws(() => store.grant(owner, grantInput({ allowedActions: ['shell'] })), code('IDEMPOTENCY_CONFLICT'));
  store.revoke(owner, { mandateId: 'mandate', expectedVersion: 1 });
  assert.equal(store.grant(owner, grantInput()).state, 'revoked');
  assert.throws(() => store.resume(owner, { mandateId: 'mandate', expectedVersion: 2 }), code('REVOKED'));
});

test('scope, subject, action and exact opaque resource are independently enforced', t => {
  const { store } = fixture(t); const mandate = store.grant(owner, grantInput()); const input = reserveInput(mandate);
  assert.throws(() => store.reserve({ ...worker, scopes: ['other'] }, input), code('FORBIDDEN'));
  assert.throws(() => store.reserve({ ...worker, principalId: 'another-worker' }, input), code('FORBIDDEN'));
  assert.throws(() => store.reserve(worker, { ...input, scope: 'other' }), code('FORBIDDEN'));
  assert.throws(() => store.reserve(worker, { ...input, action: 'artifact.read' }), code('UNKNOWN_ACTION'));
  assert.throws(() => store.reserve(worker, { ...input, resourceScopes: ['artifact:task-1/child'] }), code('FORBIDDEN'));
  store.reserve(worker, input);
  const allowed = store.assertPermit(dispatcher, permit(input));
  assert.equal(allowed.maxTokens, 10); assert.equal(allowed.principalId, 'worker'); assert.equal(allowed.reservationVersion, 1);
  assert.throws(() => store.assertPermit({ ...dispatcher, principalId: 'other' }, permit(input)), code('FORBIDDEN'));
});

test('grant validity, upper expiry and not-yet-valid authority fail closed', t => {
  const { store, setTime } = fixture(t);
  assert.throws(() => store.grant(owner, grantInput({ expiresAt: initial })), code('EXPIRED'));
  assert.throws(() => store.grant(owner, grantInput({ maxExpiresAt: '2026-11-02T12:30:00.000Z' })), code('EXPIRED'));
  const mandate = store.grant(owner, grantInput({ validFrom: '2026-11-02T12:10:00.000Z' }));
  assert.throws(() => store.reserve(worker, reserveInput(mandate)), code('EXPIRED'));
  setTime('2026-11-02T12:11:00.000Z'); store.reserve(worker, reserveInput(mandate));
  setTime(expires); const expired = store.get(owner, mandate.mandateId);
  assert.equal(expired.state, 'expired'); assert.equal(expired.version, 1);
  assert.throws(() => store.resume(owner, { mandateId: 'mandate', expectedVersion: 1 }), code('EXPIRED'));
});

test('reservation identity is stable and every budget axis limits further requests', t => {
  const { store } = fixture(t); const mandate = store.grant(owner, grantInput({ limits: { tokens: 10, calls: 1, effects: 1 } }));
  const input = reserveInput(mandate); const first = store.reserve(worker, input);
  assert.deepEqual(store.reserve(worker, input), first);
  assert.throws(() => store.reserve(worker, { ...input, amount: { tokens: 9, calls: 1, effects: 1 } }), code('IDEMPOTENCY_CONFLICT'));
  for (const amount of [{ tokens: 1, calls: 0, effects: 1 }, { tokens: 0, calls: 1, effects: 1 }, { tokens: 0, calls: 0, effects: 1 }]) {
    assert.throws(() => store.reserve(worker, reserveInput(mandate, 'next', amount)), code('BUDGET_EXCEEDED'));
  }
  assert.deepEqual(store.balance(owner, 'mandate'), { limits: mandate.limits, spent: { tokens: 0, calls: 0, effects: 0 }, held: mandate.limits, available: { tokens: 0, calls: 0, effects: 0 } });
});

test('unknown and partial usage retains the complete reservation and cannot authorize another invocation', t => {
  const { store } = fixture(t); const mandate = store.grant(owner, grantInput()); const input = reserveInput(mandate); store.reserve(worker, input);
  const unknown = store.reconcile(observer, { receiptId: 'unknown', reservationId: input.reservationId, expectedVersion: 1, complete: false, usage: { tokens: null, calls: 1, effects: null }, evidenceRef: 'usage:partial' });
  assert.equal(unknown.state, 'unknown'); assert.deepEqual(unknown.observed, { calls: 1 });
  assert.deepEqual(store.balance(owner, 'mandate').held, input.amount);
  assert.throws(() => store.assertPermit(dispatcher, permit(input)), code('BUDGET_UNAVAILABLE'));
  assert.throws(() => store.reconcile(observer, { receiptId: 'incomplete', reservationId: input.reservationId, expectedVersion: 2, complete: true, usage: { calls: 1, effects: 0 }, evidenceRef: 'usage:incomplete' }), code('INCOMPLETE_USAGE'));
});

test('complete settlement releases only unused budget, never observed spending; receipt retries are stable', t => {
  const { store } = fixture(t); const mandate = store.grant(owner, grantInput({ limits: { tokens: 10, calls: 1, effects: 1 } })); const input = reserveInput(mandate); store.reserve(worker, input);
  const receipt = { receiptId: 'final', reservationId: input.reservationId, expectedVersion: 1, complete: true, usage: { tokens: 4, calls: 1, effects: 0 }, evidenceRef: 'usage:final' };
  const settled = store.reconcile(observer, receipt);
  assert.deepEqual(store.reconcile(observer, { usage: { effects: 0, calls: 1, tokens: 4 }, evidenceRef: 'usage:final', complete: true, expectedVersion: 1, reservationId: input.reservationId, receiptId: 'final' }), settled);
  assert.deepEqual(store.balance(owner, 'mandate'), { limits: mandate.limits, spent: { tokens: 4, calls: 1, effects: 0 }, held: { tokens: 0, calls: 0, effects: 0 }, available: { tokens: 6, calls: 0, effects: 1 } });
  store.reserve(worker, reserveInput(mandate, 'next', { tokens: 6, calls: 0, effects: 1 }));
  assert.throws(() => store.reserve(worker, reserveInput(mandate, 'excess', { tokens: 1, calls: 0, effects: 1 })), code('BUDGET_EXCEEDED'));
  assert.throws(() => store.reconcile(observer, { ...receipt, usage: { ...receipt.usage, tokens: 5 } }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.reconcile(observer, { ...receipt, receiptId: 'less', expectedVersion: 2, usage: { tokens: 3, calls: 1, effects: 0 } }), code('USAGE_REGRESSION'));
});

test('only trusted observation can reconcile, with strict finite counts and boolean completeness', t => {
  const { store } = fixture(t); const mandate = store.grant(owner, grantInput()); const input = reserveInput(mandate); store.reserve(worker, input);
  const receipt = { receiptId: 'final', reservationId: input.reservationId, expectedVersion: 1, complete: true, usage: input.amount, evidenceRef: 'usage:final' };
  assert.throws(() => store.reconcile(worker, receipt), code('FORBIDDEN'));
  assert.throws(() => store.reconcile({ ...observer, principalId: 'untrusted-observer' }, receipt), code('FORBIDDEN'));
  assert.throws(() => store.reconcile(observer, { ...receipt, complete: 'false' } as never), code('INVALID_SCHEMA'));
  for (const bad of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => store.reconcile(observer, { ...receipt, usage: { tokens: bad, calls: 1, effects: 1 } }), code('INVALID_SCHEMA'));
  }
  assert.equal(store.getReservation(owner, input.reservationId).version, 1);
});

test('pause and revoke persist across reopened connections, CAS fences concurrent controls, and resume never restores old permits', t => {
  const { store, filename } = fixture(t); const mandate = store.grant(owner, grantInput()); const input = reserveInput(mandate); store.reserve(worker, input);
  const paused = store.pause(owner, { mandateId: 'mandate', expectedVersion: 1 });
  assert.equal(paused.state, 'suspended'); assert.ok(paused.authEpoch > mandate.authEpoch);
  assert.throws(() => store.resume(owner, { mandateId: 'mandate', expectedVersion: 1 }), code('VERSION_CONFLICT'));
  assert.throws(() => store.resume(worker, { mandateId: 'mandate', expectedVersion: 2 }), code('FORBIDDEN'));
  const reopenedDb = new DatabaseSync(filename); const reopened = new MandateStore(reopenedDb, new SqliteTransactions(reopenedDb), { ...options, now: () => new Date(initial) });
  try {
    assert.equal(reopened.get(owner, 'mandate').state, 'suspended');
    assert.throws(() => reopened.reserve(worker, reserveInput(mandate, 'paused')), code('PAUSED'));
    const resumed = reopened.resume(owner, { mandateId: 'mandate', expectedVersion: 2 });
    assert.ok(resumed.authEpoch > paused.authEpoch); assert.equal(resumed.version, 3);
    assert.throws(() => reopened.assertPermit(dispatcher, permit(input)), code('STALE_AUTHORITY'));
    const revoked = reopened.revoke(owner, { mandateId: 'mandate', expectedVersion: 3 });
    assert.equal(store.get(owner, 'mandate').state, 'revoked'); assert.ok(revoked.authEpoch > resumed.authEpoch);
  } finally { reopenedDb.close(); }
});

test('lease expiry preserves held budget until explicit complete reconciliation', t => {
  const { store, setTime } = fixture(t); const mandate = store.grant(owner, grantInput()); const input = { ...reserveInput(mandate), leaseMs: 1000 }; store.reserve(worker, input);
  setTime('2026-11-02T12:00:01.000Z');
  assert.throws(() => store.assertPermit(dispatcher, permit(input)), code('EXPIRED'));
  assert.deepEqual(store.balance(owner, 'mandate').held, input.amount);
  store.reconcile(observer, { receiptId: 'never-started', reservationId: input.reservationId, expectedVersion: 1, complete: true, usage: { tokens: 0, calls: 0, effects: 0 }, evidenceRef: 'execution:never-started' });
  assert.deepEqual(store.balance(owner, 'mandate').available, mandate.limits);
});

test('usage overrun is retained and persistently freezes new grants, reserves and dispatch', t => {
  const { store, filename } = fixture(t); const mandate = store.grant(owner, grantInput()); const input = reserveInput(mandate); store.reserve(worker, input);
  const overrun = store.reconcile(observer, { receiptId: 'overrun', reservationId: input.reservationId, expectedVersion: 1, complete: false, usage: { tokens: 11 }, evidenceRef: 'usage:overrun' });
  assert.equal(overrun.overrun, true); assert.equal(overrun.state, 'unknown'); assert.equal(store.balance(owner, 'mandate').held.tokens, 11);
  assert.equal(store.health().frozen, true);
  assert.throws(() => store.grant(owner, grantInput({ id: 'new' })), code('BUDGET_OVERRUN'));
  assert.throws(() => store.reserve(worker, reserveInput(mandate, 'next')), code('BUDGET_OVERRUN'));
  assert.throws(() => store.assertPermit(dispatcher, permit(input)), code('BUDGET_OVERRUN'));
  const reopenedDb = new DatabaseSync(filename); const reopened = new MandateStore(reopenedDb, new SqliteTransactions(reopenedDb), { ...options, now: () => new Date(initial) });
  try { assert.equal(reopened.health().frozen, true); assert.throws(() => reopened.resume(owner, { mandateId: 'mandate', expectedVersion: 2 }), code('BUDGET_OVERRUN')); }
  finally { reopenedDb.close(); }
  const settled = store.reconcile(observer, { receiptId: 'known-overrun', reservationId: input.reservationId, expectedVersion: 2, complete: true, usage: { tokens: 11, calls: 1, effects: 0 }, evidenceRef: 'usage:complete' });
  assert.equal(settled.state, 'settled'); assert.equal(store.health().frozen, true); assert.equal(store.balance(owner, 'mandate').spent.tokens, 11);
});

test('late upward corrections also freeze when previously released capacity was reserved elsewhere', t => {
  const { store } = fixture(t); const mandate = store.grant(owner, grantInput()); const input = reserveInput(mandate, 'first', { tokens: 100, calls: 1, effects: 1 }); store.reserve(worker, input);
  store.reconcile(observer, { receiptId: 'first-known', reservationId: 'first', expectedVersion: 1, complete: true, usage: { tokens: 10, calls: 1, effects: 0 }, evidenceRef: 'usage:first' });
  store.reserve(worker, reserveInput(mandate, 'second', { tokens: 90, calls: 1, effects: 1 }));
  const corrected = store.reconcile(observer, { receiptId: 'correction', reservationId: 'first', expectedVersion: 2, complete: true, usage: { tokens: 100, calls: 1, effects: 0 }, evidenceRef: 'usage:correction' });
  assert.equal(corrected.overrun, true); assert.equal(store.health().frozen, true);
  assert.equal(store.balance(owner, 'mandate').spent.tokens, 100); assert.equal(store.balance(owner, 'mandate').held.tokens, 90);
});

test('50 competing reservation requests through five independent SQLite connections cannot exceed the grant', async t => {
  const { store, filename } = fixture(t); const mandate = store.grant(owner, grantInput());
  const workerSource = `
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    (async()=>{
      const {register}=await import('tsx/esm/api'); const unregister=register();
      const {SqliteTransactions}=await import(workerData.transactionModule);
      const {MandateStore}=await import(workerData.policyModule);
      const db=new DatabaseSync(workerData.filename); db.exec('PRAGMA busy_timeout=10000');
      const store=new MandateStore(db,new SqliteTransactions(db),{...workerData.options,now:()=>new Date(workerData.now)});
      parentPort.on('message', async input=>{
        if(input==='close'){db.close(); await unregister(); parentPort.close(); return;}
        try {store.reserve(workerData.actor,input); parentPort.postMessage({ok:true,id:input.reservationId});}
        catch(error){parentPort.postMessage({ok:false,code:error.code,id:input.reservationId});}
      });
      parentPort.postMessage({ready:true});
    })().catch(error=>{parentPort.postMessage({fatal:String(error)});process.exitCode=1;});`;
  const pool = Array.from({ length: 5 }, () => new Worker(workerSource, { eval: true, workerData: {
    transactionModule: new URL('../src/adapters/control-store/transaction.ts', import.meta.url).href,
    policyModule: new URL('../src/control/policy/mandates.ts', import.meta.url).href,
    filename, options, now: initial, actor: worker,
  } }));
  t.after(async () => { await Promise.all(pool.map(thread => thread.terminate())); });
  await Promise.all(pool.map(thread => new Promise<void>((resolve, reject) => {
    thread.once('error', reject); thread.once('message', message => message.ready ? resolve() : reject(new Error(JSON.stringify(message))));
  })));
  const results = await new Promise<{ ok: boolean; code?: string }[]>((resolve, reject) => {
    const values: { ok: boolean; code?: string }[] = [];
    for (const thread of pool) { thread.once('error', reject); thread.on('message', value => { values.push(value); if (values.length === 50) resolve(values); }); }
    for (let i = 0; i < 50; i++) pool[i % pool.length]!.postMessage(reserveInput(mandate, `competing-${i}`));
  });
  assert.equal(results.filter(result => result.ok).length, 10);
  assert.equal(results.filter(result => result.code === 'BUDGET_EXCEEDED').length, 40);
  assert.deepEqual(store.balance(owner, 'mandate').held, mandate.limits);
  await Promise.all(pool.map(thread => new Promise<void>((resolve, reject) => { thread.once('exit', exitCode => exitCode === 0 ? resolve() : reject(new Error(`worker exit ${exitCode}`))); thread.postMessage('close'); })));
});

test('Mandate and budget changes roll back with the enclosing task transaction', t => {
  const { store, tx } = fixture(t);
  assert.throws(() => tx.atomic(() => { store.grant(owner, grantInput()); throw new Error('Task admission rejected'); }), /Task admission/);
  assert.throws(() => store.get(owner, 'mandate'), code('NOT_FOUND')); assert.equal(store.health().authEpoch, 0);
  const mandate = store.grant(owner, grantInput());
  assert.throws(() => tx.atomic(() => { store.reserve(worker, reserveInput(mandate)); throw new Error('Effect insertion failed'); }), /Effect insertion/);
  assert.deepEqual(store.balance(owner, 'mandate').available, mandate.limits);
});

test('trusted action minima prevent tokens from substituting for effect or model-call budget', t => {
  const { store, db } = fixture(t);
  const mandate = store.grant(owner, grantInput({ limits: { tokens: 100, calls: 0, effects: 0 }, allowedActions: ['artifact.write', 'model.generate'] }));
  const input = reserveInput(mandate, 'no-effect-budget', { tokens: 1, calls: 0, effects: 0 });
  assert.throws(() => store.reserve(worker, input), code('BUDGET_MINIMUM'));
  assert.throws(() => store.reserve(worker, { ...input, action: 'model.generate' }), code('BUDGET_MINIMUM'));
  assert.throws(() => store.reserve(worker, { ...input, action: 'model.generate', amount: { tokens: 1, calls: 1, effects: 0 } }), code('BUDGET_EXCEEDED'));
  assert.throws(() => store.grant(owner, grantInput({ id: 'unknown', allowedActions: ['arbitrary.tool'] })), code('UNKNOWN_ACTION'));
  const valid = store.grant(owner, grantInput({ id: 'valid' })); const reservedInput = reserveInput(valid, 'valid-effect');
  store.reserve(worker, reservedInput);
  // A corrupt or externally modified reservation is checked again at dispatch.
  db.prepare("UPDATE shiyu_budget_reservations SET record_json=json_set(record_json,'$.amount.effects',0) WHERE id=?").run('valid-effect');
  assert.throws(() => store.assertPermit(dispatcher, permit(reservedInput)), code('BUDGET_MINIMUM'));
});

test('trusted owner, observer and cost configuration cannot silently change across reopen', t => {
  const { store, db, tx } = fixture(t); store.grant(owner, grantInput());
  assert.throws(() => new MandateStore(db, tx, { ...options, ownerIds: ['another-owner'] }), code('INCOMPATIBLE_POLICY'));
  assert.throws(() => new MandateStore(db, tx, { ...options, actionCosts: { ...options.actionCosts, 'artifact.write': { tokens: 0, calls: 0, effects: 0 } } }), code('INCOMPATIBLE_POLICY'));
  assert.throws(() => new MandateStore(db, tx, { ...options, reconcilerIds: ['new-observer'] }), code('INCOMPATIBLE_POLICY'));
  assert.equal(store.get(owner, 'mandate').state, 'active'); assert.equal(tx.poisoned, false);
});

test('malformed persisted budget and control fields fail closed instead of granting an unbounded permit', t => {
  const { store, db } = fixture(t); const mandate = store.grant(owner, grantInput());
  db.exec("UPDATE shiyu_mandates SET record_json=json_set(record_json,'$.limits.tokens','unlimited')");
  assert.throws(() => store.reserve(worker, reserveInput(mandate)), code('INVALID_SCHEMA'));
  db.exec('UPDATE shiyu_policy_meta SET frozen=2');
  assert.throws(() => store.health(), code('CORRUPT_POLICY'));
});

test('other grant subjects cannot read or use another principal’s reservation', t => {
  const { store } = fixture(t); const mandate = store.grant(owner, grantInput({ subjectIds: ['worker', 'second'] })); const input = reserveInput(mandate); store.reserve(worker, input);
  const second: TrustedPolicyActor = { principalId: 'second', kind: 'component', scopes: ['local'] };
  assert.equal(store.get(second, 'mandate').mandateId, 'mandate');
  assert.throws(() => store.getReservation(second, input.reservationId), code('FORBIDDEN'));
  assert.throws(() => store.assertPermit(second, permit(input)), code('FORBIDDEN'));
  assert.equal(store.getReservation(observer, input.reservationId).principalId, 'worker');
});
