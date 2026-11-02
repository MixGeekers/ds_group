import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { StatePublicationError, StatePublicationStore, createStatePublisher, initialStateManifest } from '../src/state/publication.js';
import type { PublishedState, StateManifest, StatePublishCommand, StatePublisher } from '../src/state/publication.js';

const actor = createStatePublisher('state-service');
const code = (expected: string) => (error: unknown) => error instanceof StatePublicationError && error.code === expected;
const next = (publication: PublishedState, requestId: string, manifest = initialStateManifest()): StatePublishCommand => ({
  requestId, expectedStateVersion: publication.stateVersion, expectedBaselineId: publication.baselineId, manifest,
});
function changed(): StateManifest { const value = initialStateManifest(); value.domains.memory.reason = 'source_unavailable'; return value; }
function fixture(t: TestContext, tracked = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'shiyu-state-publication-'));
  const filename = path.join(directory, 'control.sqlite'); const connections: DatabaseSync[] = [];
  let clock = Date.parse('2026-11-02T18:00:00.000Z');
  const open = () => {
    const db = new DatabaseSync(filename); connections.push(db);
    db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;');
    const tx = new SqliteTransactions(db), watermark = tracked ? installCommitWatermark(db, tx) : undefined;
    const store = new StatePublicationStore(db, tx, { publisherIds: ['state-service', 'another-publisher'], now: () => new Date(clock) });
    return { db, tx, store, watermark };
  };
  t.after(() => { for (const db of connections) if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, filename, advance: () => { clock += 1000; } };
}
const count = (db: DatabaseSync) => db.prepare('SELECT count(*) AS n FROM shiyu_state_publication_commands').get()!.n;

test('an explicit first publication starts at one; get does not invent or publish version zero', t => {
  const { store, db } = fixture(t); const before = db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.equal(store.get(), undefined); assert.equal(store.get(), undefined);
  assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, before); assert.equal(count(db), 0);
  const result = store.publish(actor, { requestId: 'initial', manifest: initialStateManifest() });
  assert.equal(result.status, 'published'); assert.equal(result.publication.stateVersion, 1);
  assert.match(result.publication.baselineId, /^[a-f0-9-]{36}$/); assert.deepEqual(store.get(), result.publication);
  result.publication.manifest.domains.memory.reason = 'source_unavailable';
  assert.equal(store.get()!.manifest.domains.memory.reason, 'not_connected');
});

test('publisher authority requires the original process-local capability and a configured identity', t => {
  const { store, db } = fixture(t);
  for (const invalid of [{ principalId: 'state-service' }, structuredClone(actor), new Proxy(actor, {}), createStatePublisher('outsider'), null]) {
    assert.throws(() => store.publish(invalid as StatePublisher, { requestId: 'invalid', manifest: initialStateManifest() }), code('FORBIDDEN'));
  }
  assert.equal(Object.isFrozen(actor), true); assert.equal(store.get(), undefined); assert.equal(count(db), 0);
});

test('manifest schema is closed and cannot claim current domains, embed bodies or skip a domain', t => {
  const { store, db } = fixture(t);
  const invalid: unknown[] = [
    { ...initialStateManifest(), body: 'not a state projection' },
    { ...initialStateManifest(), schemaVersion: 2 },
    { schemaVersion: 1, domains: {} },
    { schemaVersion: 1, domains: { ...initialStateManifest().domains, task: { status: 'unavailable', reason: 'not_connected' } } },
  ];
  const current = initialStateManifest() as any; current.domains.memory = { status: 'current', sourceRefs: [] }; invalid.push(current);
  const body = initialStateManifest() as any; body.domains.memory.body = 'memory body'; invalid.push(body);
  const reason = initialStateManifest() as any; reason.domains.ability.reason = 'x'.repeat(10000); invalid.push(reason);
  for (const value of invalid) assert.throws(() => store.publish(actor, { requestId: 'bad', manifest: value as StateManifest }), StatePublicationError);
  assert.throws(() => store.publish(actor, { requestId: 'bad-first', manifest: changed() }), code('INVALID_INITIAL_MANIFEST'));
  assert.throws(() => store.publish(actor, { requestId: 'x'.repeat(201), manifest: initialStateManifest() }), code('INVALID_SCHEMA'));
  assert.equal(store.get(), undefined); assert.equal(count(db), 0);
});

test('canonical equivalent retries return the same historical command receipt without new writes', t => {
  const f = fixture(t), original = f.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() });
  const reverse = JSON.parse(JSON.stringify(initialStateManifest(), ['domains', 'ability', 'personality', 'cognition', 'emotion', 'relationship', 'memory', 'reason', 'status', 'schemaVersion'])) as StateManifest;
  const writes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.deepEqual(f.store.publish(actor, { manifest: reverse, requestId: 'one' }), original);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, writes);
  f.store.publish(actor, next(original.publication, 'two', changed()));
  assert.deepEqual(f.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }), original);
  assert.equal(f.store.get()!.stateVersion, 2); assert.equal(count(f.db), 2);
});

test('request identity binds the actor, expected publication tuple and entire manifest', t => {
  const { store, db } = fixture(t), first = store.publish(actor, { requestId: 'one', manifest: initialStateManifest() });
  assert.throws(() => store.publish(actor, next(first.publication, 'one')), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.publish(actor, { requestId: 'one', manifest: changed() }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.publish(createStatePublisher('another-publisher'), { requestId: 'one', manifest: initialStateManifest() }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(count(db), 1);
});

test('new equivalent commands persist noop receipts but retain the published version and publication time', t => {
  const f = fixture(t), first = f.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }); f.advance();
  const noop = f.store.publish(actor, next(first.publication, 'noop'));
  assert.equal(noop.status, 'unchanged'); assert.deepEqual(noop.publication, first.publication);
  assert.notEqual(noop.recordedAt, first.recordedAt); assert.equal(count(f.db), 2);
  assert.throws(() => f.store.publish(actor, { requestId: 'missing-version', manifest: initialStateManifest() }), code('VERSION_CONFLICT'));
  assert.throws(() => f.store.publish(actor, { requestId: 'half-version', expectedStateVersion: 1, manifest: initialStateManifest() }), code('INVALID_SCHEMA'));
  const changedReceipt = f.store.publish(actor, next(first.publication, 'changed', changed()));
  assert.equal(changedReceipt.publication.stateVersion, 2);
  assert.throws(() => f.store.publish(actor, next(first.publication, 'stale-noop', changed())), code('VERSION_CONFLICT'));
});

test('publication CAS cannot use a matching numeric version from another baseline', t => {
  const a = fixture(t), b = fixture(t);
  const firstA = a.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }).publication;
  const firstB = b.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }).publication;
  assert.notEqual(firstA.baselineId, firstB.baselineId);
  assert.throws(() => b.store.publish(actor, next(firstA, 'from-other-baseline', changed())), code('VERSION_CONFLICT'));
  assert.equal(b.store.get()!.stateVersion, 1); assert.equal(count(b.db), 1);
});

test('reopen retains the baseline, current publication and immutable older receipts', t => {
  const f = fixture(t); const one = f.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() });
  const two = f.store.publish(actor, next(one.publication, 'two', changed())); f.db.close();
  const reopened = f.open(); assert.deepEqual(reopened.store.get(), two.publication);
  assert.deepEqual(reopened.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }), one);
  assert.equal(count(reopened.db), 2);
});

test('outer and nested rollback discard publication, version and receipt together', t => {
  const { store, tx, db } = fixture(t);
  assert.throws(() => tx.atomic(() => { store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }); throw new Error('outer abort'); }), /outer abort/);
  assert.equal(store.get(), undefined); assert.equal(count(db), 0);
  tx.atomic(() => {
    assert.throws(() => tx.atomic(() => { store.publish(actor, { requestId: 'inner', manifest: initialStateManifest() }); throw new Error('inner abort'); }), /inner abort/);
    assert.equal(store.get(), undefined);
  });
  const one = store.publish(actor, { requestId: 'one', manifest: initialStateManifest() });
  assert.throws(() => tx.atomic(() => { store.publish(actor, next(one.publication, 'two', changed())); throw new Error('outer abort'); }), /outer abort/);
  assert.deepEqual(store.get(), one.publication); assert.equal(count(db), 1);
  assert.equal(store.publish(actor, next(one.publication, 'two', changed())).publication.stateVersion, 2);
});

test('receipt insertion failure rolls back an already updated publication head', t => {
  const { store, db } = fixture(t); const one = store.publish(actor, { requestId: 'one', manifest: initialStateManifest() });
  db.exec("CREATE TRIGGER deny_receipt BEFORE INSERT ON shiyu_state_publication_commands BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END");
  assert.throws(() => store.publish(actor, next(one.publication, 'two', changed())), /synthetic receipt failure/);
  assert.deepEqual(store.get(), one.publication); assert.equal(count(db), 1);
  db.exec('DROP TRIGGER deny_receipt');
  assert.equal(store.publish(actor, next(one.publication, 'two', changed())).publication.stateVersion, 2);
});

test('two independently managed connections race on the same publication tuple with one winner', async t => {
  const f = fixture(t); const one = f.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }).publication;
  const source = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{
    const {tsImport}=await import('tsx/esm/api');const {DatabaseSync}=await import('node:sqlite');
    const {SqliteTransactions}=await tsImport(workerData.tx,workerData.base);const {StatePublicationStore,createStatePublisher}=await tsImport(workerData.store,workerData.base);
    const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA busy_timeout=5000');
    const store=new StatePublicationStore(db,new SqliteTransactions(db),{publisherIds:['state-service','another-publisher']});
    parentPort.once('message',()=>{try{const value=store.publish(createStatePublisher('state-service'),workerData.command);parentPort.postMessage({status:value.status,version:value.publication.stateVersion});}
      catch(error){parentPort.postMessage({code:error.code,message:error.message});}finally{db.close();parentPort.close();}});parentPort.postMessage({ready:true});
    })().catch(error=>{parentPort.postMessage({error:String(error)});process.exitCode=1});`;
  const workers = [0, 1].map(i => new Worker(source, { eval: true, workerData: {
    filename: f.filename, command: next(one, `race-${i}`, changed()), base: import.meta.url,
    tx: new URL('../src/adapters/control-store/transaction.ts', import.meta.url).href,
    store: new URL('../src/state/publication.ts', import.meta.url).href,
  } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => { worker.once('error', reject); worker.once('message', value => value.ready ? resolve() : reject(new Error(value.error))); })));
  const results = await Promise.all(workers.map(worker => new Promise<{status?: string; code?: string}>((resolve, reject) => { worker.once('error', reject); worker.once('message', resolve); worker.postMessage('publish'); })));
  assert.equal(results.filter(value => value.status === 'published').length, 1);
  assert.equal(results.filter(value => value.code === 'VERSION_CONFLICT').length, 1);
  assert.equal(f.store.get()!.stateVersion, 2); assert.equal(count(f.db), 2);
});

test('Task/Conversation writes and read-only capture advance no inner-state version', t => {
  const f = fixture(t, true); const one = f.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() }).publication;
  const before = f.watermark!.read().commitSeq;
  f.tx.atomic(() => f.db.exec('CREATE TABLE synthetic_task_progress(id INTEGER PRIMARY KEY,revision INTEGER);CREATE TABLE synthetic_conversation_context(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO synthetic_task_progress VALUES(1,1);INSERT INTO synthetic_conversation_context VALUES(1,1)'));
  f.tx.atomic(() => f.db.exec('UPDATE synthetic_task_progress SET revision=2;UPDATE synthetic_conversation_context SET revision=2'));
  assert.ok(f.watermark!.read().commitSeq > before); assert.deepEqual(f.store.get(), one);
  const settled = f.watermark!.read().commitSeq;
  for (let i = 0; i < 3; i++) assert.deepEqual(f.tx.atomic(() => ({ state: f.store.get(), watermark: f.watermark!.read().commitSeq })), { state: one, watermark: settled });
  assert.equal(f.watermark!.read().commitSeq, settled);
});

test('different transaction owners, changed publisher configuration and damaged baselines fail closed', t => {
  const f = fixture(t), other = new DatabaseSync(':memory:');
  try { assert.throws(() => new StatePublicationStore(other, f.tx, { publisherIds: ['state-service'] }), code('TRANSACTION_MISMATCH')); } finally { other.close(); }
  assert.throws(() => new StatePublicationStore(f.db, f.tx, { publisherIds: ['outsider'] }), code('INCOMPATIBLE_POLICY'));
  f.db.exec('DELETE FROM shiyu_state_publication_meta');
  assert.throws(() => new StatePublicationStore(f.db, f.tx, { publisherIds: ['state-service', 'another-publisher'] }), code('CORRUPT_STATE'));
  const published = fixture(t); published.store.publish(actor, { requestId: 'one', manifest: initialStateManifest() });
  published.db.exec('DELETE FROM shiyu_state_publication_head');
  assert.throws(() => published.store.get(), code('CORRUPT_STATE'));
  assert.throws(() => published.open(), code('CORRUPT_STATE'));
});
