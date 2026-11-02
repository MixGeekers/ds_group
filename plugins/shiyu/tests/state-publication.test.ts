import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { StatePublicationError, StatePublicationStore, createStatePublisher, initialStateManifest, manifestWithMemoryAvailability, manifestWithAbilityAvailability } from '../src/state/publication.js';
import type { MemoryStateManifest, PublishedState, StateManifest, StatePublishCommand, StatePublisher, AvailableAbilityDomain } from '../src/state/publication.js';

const actor = createStatePublisher('state-service');
const code = (expected: string) => (error: unknown) => error instanceof StatePublicationError && error.code === expected;
const next = (publication: PublishedState, requestId: string, manifest: StateManifest = initialStateManifest()): StatePublishCommand => ({
  requestId, expectedStateVersion: publication.stateVersion, expectedBaselineId: publication.baselineId, manifest,
});
function changed(): StateManifest { const value = initialStateManifest(); value.domains.memory.reason = 'source_unavailable'; return value; }
function memoryManifest(semantic = false): MemoryStateManifest {
  return { schemaVersion: 2, domains: { ...initialStateManifest().domains,
    memory: { status: 'available', backendId: 'ombre-local', deploymentId: 'memory-deployment',
      capabilities: semantic ? ['exact_read', 'semantic_search'] : ['exact_read'],
      ...(semantic ? { profileFingerprint: 'a'.repeat(64) } : {}) } } };
}
const abilityRead = (authorityId = 'ability-authority-one'): AvailableAbilityDomain => ({ status: 'available', backendId: 'control-ability', authorityId, capabilities: ['state_read'] });
const expected = (publication: PublishedState, requestId: string) => ({ requestId, expectedStateVersion: publication.stateVersion, expectedBaselineId: publication.baselineId });
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
  assert.equal(result.publication.manifest.domains.memory.status, 'unavailable');
  if (result.publication.manifest.domains.memory.status === 'unavailable') result.publication.manifest.domains.memory.reason = 'source_unavailable';
  assert.deepEqual(store.get()!.manifest.domains.memory, { status: 'unavailable', reason: 'not_connected' });
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

test('schema2 upgrades only memory availability and retains exact legacy history across reopen', t => {
  const f = fixture(t), initialCommand = { requestId: 'legacy', manifest: initialStateManifest() };
  const legacy = f.store.publish(actor, initialCommand);
  const legacyRow = f.db.prepare('SELECT * FROM shiyu_state_publication_commands WHERE request_id=?').get('legacy');
  const metadata = f.db.prepare('SELECT * FROM shiyu_state_publication_meta').get();
  assert.throws(() => f.store.publish(structuredClone(actor), next(legacy.publication, 'forged', memoryManifest())), code('FORBIDDEN'));
  const upgraded = f.store.publish(actor, next(legacy.publication, 'memory-read', memoryManifest()));
  assert.equal(upgraded.publication.schemaVersion, 1); assert.equal(upgraded.publication.manifest.schemaVersion, 2);
  assert.equal(upgraded.publication.stateVersion, 2); assert.equal(upgraded.publication.baselineId, legacy.publication.baselineId);
  assert.deepEqual(f.db.prepare('SELECT * FROM shiyu_state_publication_meta').get(), metadata);
  assert.deepEqual(f.db.prepare('SELECT * FROM shiyu_state_publication_commands WHERE request_id=?').get('legacy'), legacyRow);
  f.db.close(); const reopened = f.open();
  assert.deepEqual(reopened.store.get(), upgraded.publication);
  assert.deepEqual(reopened.store.publish(actor, initialCommand), legacy);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM shiyu_state_publication_commands WHERE request_id=?').get('legacy'), legacyRow);
  assert.equal(count(reopened.db), 2);
});

test('memory availability metadata is closed, bound to deployment and never substitutes for index proof', t => {
  const f = fixture(t);
  assert.throws(() => f.store.publish(actor, { requestId: 'skip-legacy', manifest: memoryManifest() }), code('INVALID_INITIAL_MANIFEST'));
  const initial = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() }).publication;
  const invalid = [
    { status: 'available' },
    { ...memoryManifest().domains.memory, body: 'must stay in native memory' },
    { ...memoryManifest().domains.memory, sourceRefs: [] },
    { ...memoryManifest().domains.memory, indexWatermark: 1 },
    { ...memoryManifest().domains.memory, backendId: 'wrong scope whitespace' },
    { ...memoryManifest().domains.memory, deploymentId: '' },
    { ...memoryManifest().domains.memory, capabilities: ['semantic_search'] },
    { ...memoryManifest().domains.memory, capabilities: ['semantic_search', 'exact_read'] },
    { ...memoryManifest().domains.memory, capabilities: ['exact_read', 'exact_read'] },
    { ...memoryManifest().domains.memory, capabilities: ['exact_read', 'write'] },
    { ...memoryManifest().domains.memory, capabilities: ['exact_read', 'semantic_search'] },
    { ...memoryManifest().domains.memory, profileFingerprint: 'a'.repeat(64) },
    { ...memoryManifest().domains.memory, profileFingerprint: undefined },
    { ...memoryManifest(true).domains.memory, profileFingerprint: 'unknown' },
    { ...memoryManifest(true).domains.memory, profileFingerprint: 'A'.repeat(64) },
  ];
  for (const memory of invalid) {
    const value = { ...memoryManifest(), domains: { ...memoryManifest().domains, memory } } as StateManifest;
    assert.throws(() => f.store.publish(actor, next(initial, 'invalid', value)), StatePublicationError);
  }
  for (const domain of ['relationship', 'emotion', 'cognition', 'personality', 'ability']) {
    const value = memoryManifest(); (value.domains as Record<string, unknown>)[domain] = structuredClone(value.domains.memory);
    assert.throws(() => f.store.publish(actor, next(initial, `invalid-${domain}`, value)), StatePublicationError);
  }
  const disguisedLegacy = { schemaVersion: 1, domains: memoryManifest().domains } as StateManifest;
  assert.throws(() => f.store.publish(actor, next(initial, 'legacy-available', disguisedLegacy)), StatePublicationError);
  let invoked = false;
  const accessor = memoryManifest(); Object.defineProperty(accessor.domains.memory, 'backendId', { enumerable: true, get: () => { invoked = true; return 'ombre-local'; } });
  assert.throws(() => f.store.publish(actor, next(initial, 'accessor', accessor)), code('INVALID_SCHEMA'));
  assert.equal(invoked, false); assert.equal(count(f.db), 1); assert.deepEqual(f.store.get(), initial);
});

test('schema2 exact and semantic publications use CAS while equivalent metadata does not claim new progress', t => {
  const f = fixture(t, true), initial = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() }).publication;
  const exact = f.store.publish(actor, next(initial, 'exact', memoryManifest())); f.advance();
  const same = f.store.publish(actor, next(exact.publication, 'same', memoryManifest()));
  assert.equal(same.status, 'unchanged'); assert.deepEqual(same.publication, exact.publication);
  const semantic = f.store.publish(actor, next(exact.publication, 'semantic', memoryManifest(true)));
  assert.equal(semantic.publication.stateVersion, 3); assert.equal(semantic.publication.manifest.domains.memory.status, 'available');
  assert.throws(() => f.store.publish(actor, next(exact.publication, 'stale-profile', memoryManifest(true))), code('VERSION_CONFLICT'));
  const before = f.watermark!.read().commitSeq;
  const rows = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  for (let i = 0; i < 3; i++) assert.deepEqual(f.store.get(), semantic.publication);
  assert.equal(f.watermark!.read().commitSeq, before); assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, rows);
  const changedProfile = memoryManifest(true);
  if (changedProfile.domains.memory.status === 'available') changedProfile.domains.memory.profileFingerprint = 'b'.repeat(64);
  const changed = f.store.publish(actor, next(semantic.publication, 'new-profile', changedProfile));
  assert.equal(changed.publication.stateVersion, 4);
  assert.deepEqual(f.store.publish(actor, next(initial, 'exact', memoryManifest())), exact);
});

test('availability can be withdrawn under schema2 without downgrading or rewriting old commands', t => {
  const f = fixture(t), legacyCommand = { requestId: 'legacy', manifest: initialStateManifest() };
  const initial = f.store.publish(actor, legacyCommand);
  const available = f.store.publish(actor, next(initial.publication, 'available', memoryManifest()));
  assert.throws(() => f.store.publish(actor, next(available.publication, 'downgrade')), code('SCHEMA_DOWNGRADE'));
  const unavailable: MemoryStateManifest = { schemaVersion: 2, domains: { ...initialStateManifest().domains, memory: { status: 'unavailable', reason: 'source_unavailable' } } };
  const stopped = f.store.publish(actor, next(available.publication, 'stopped', unavailable));
  assert.equal(stopped.publication.stateVersion, 3); assert.deepEqual(stopped.publication.manifest.domains.memory, unavailable.domains.memory);
  assert.deepEqual(f.store.publish(actor, legacyCommand), initial);
  const resumed = f.store.publish(actor, next(stopped.publication, 'reconnected', memoryManifest()));
  assert.equal(resumed.publication.stateVersion, 4); assert.equal(count(f.db), 4);
});

test('a failed memory availability receipt rolls back schema upgrade and leaves legacy publication recoverable', t => {
  const f = fixture(t), initial = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  f.db.exec("CREATE TRIGGER deny_memory_receipt BEFORE INSERT ON shiyu_state_publication_commands BEGIN SELECT RAISE(ABORT,'synthetic memory publication failure'); END");
  assert.throws(() => f.store.publish(actor, next(initial.publication, 'memory', memoryManifest(true))), /synthetic memory publication failure/);
  assert.deepEqual(f.store.get(), initial.publication); assert.equal(count(f.db), 1);
  f.db.exec('DROP TRIGGER deny_memory_receipt');
  const memory = f.store.publish(actor, next(initial.publication, 'memory', memoryManifest(true)));
  const current = f.open(); assert.deepEqual(current.store.get(), memory.publication);
  assert.equal(count(current.db), 2);
});

test('schema3 adds only ability read availability while preserving schema1/2 publication and exact receipts', t => {
  const f = fixture(t), legacyCommand = { requestId: 'legacy', manifest: initialStateManifest() };
  const legacy = f.store.publish(actor, legacyCommand), memoryCommand = next(legacy.publication, 'memory', memoryManifest(true));
  const memory = f.store.publish(actor, memoryCommand);
  const priorRows = f.db.prepare('SELECT * FROM shiyu_state_publication_commands ORDER BY rowid').all();
  const metadata = f.db.prepare('SELECT * FROM shiyu_state_publication_meta').get();
  const command = { ...expected(memory.publication, 'ability'), availability: abilityRead() };
  const ability = f.store.publishAbilityAvailability(actor, command);
  assert.equal(ability.publication.manifest.schemaVersion, 3); assert.equal(ability.publication.stateVersion, 3);
  assert.equal(ability.publication.baselineId, legacy.publication.baselineId);
  assert.deepEqual(ability.publication.manifest.domains.memory, memory.publication.manifest.domains.memory);
  assert.deepEqual(ability.publication.manifest.domains.ability, abilityRead());
  for (const domain of ['relationship', 'emotion', 'cognition', 'personality'] as const) assert.deepEqual(ability.publication.manifest.domains[domain], legacy.publication.manifest.domains[domain]);
  assert.deepEqual(f.db.prepare('SELECT * FROM shiyu_state_publication_commands ORDER BY rowid LIMIT 2').all(), priorRows);
  assert.deepEqual(f.db.prepare('SELECT * FROM shiyu_state_publication_meta').get(), metadata);
  f.db.close(); const reopened = f.open();
  assert.deepEqual(reopened.store.get(), ability.publication);
  assert.deepEqual(reopened.store.publish(actor, legacyCommand), legacy);
  assert.deepEqual(reopened.store.publish(actor, memoryCommand), memory);
  assert.deepEqual(reopened.store.publishMemoryAvailability(actor, { ...expected(legacy.publication, 'memory'), availability: memoryManifest(true).domains.memory }), memory);
  assert.deepEqual(reopened.store.publishAbilityAvailability(actor, command), ability);
  assert.equal(count(reopened.db), 3);
  assert.throws(() => reopened.store.publish(actor, next(ability.publication, 'downgrade2', memoryManifest())), code('SCHEMA_DOWNGRADE'));
  assert.throws(() => reopened.store.publish(actor, next(ability.publication, 'downgrade1')), code('SCHEMA_DOWNGRADE'));
});

test('availability helpers preserve the other domain and retry historical intents instead of rebuilding them from the current head', t => {
  const f = fixture(t, true), legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  // The original memory command predates the helper and schema3 entirely.
  const oldMemoryCommand = next(legacy.publication, 'old-memory', memoryManifest(true));
  const oldMemory = f.store.publish(actor, oldMemoryCommand);
  const firstAbilityCommand = { ...expected(oldMemory.publication, 'first-ability'), availability: abilityRead() };
  const firstAbility = f.store.publishAbilityAvailability(actor, firstAbilityCommand);
  const stopped = f.store.publishMemoryAvailability(actor, { ...expected(firstAbility.publication, 'memory-stop'), availability: { status: 'unavailable', reason: 'source_unavailable' } });
  assert.equal(stopped.publication.manifest.schemaVersion, 3);
  assert.deepEqual(stopped.publication.manifest.domains.ability, abilityRead());
  const changedAbility = f.store.publishAbilityAvailability(actor, { ...expected(stopped.publication, 'new-authority'), availability: abilityRead('ability-authority-two') });
  assert.deepEqual(changedAbility.publication.manifest.domains.memory, stopped.publication.manifest.domains.memory);
  const before = f.watermark!.read(), rows = count(f.db);
  const replay = { ...expected(legacy.publication, 'old-memory'), availability: memoryManifest(true).domains.memory };
  assert.deepEqual(f.store.publishMemoryAvailability(actor, replay), oldMemory);
  assert.deepEqual(f.store.publishAbilityAvailability(actor, firstAbilityCommand), firstAbility);
  assert.deepEqual(f.store.get(), changedAbility.publication); assert.deepEqual(f.watermark!.read(), before); assert.equal(count(f.db), rows);
  for (const modified of [ { ...replay, availability: memoryManifest().domains.memory },
    { ...replay, expectedStateVersion: replay.expectedStateVersion + 1 }, { ...replay, expectedBaselineId: 'another-baseline' } ]) {
    assert.throws(() => f.store.publishMemoryAvailability(actor, modified), code('IDEMPOTENCY_CONFLICT'));
  }
  assert.throws(() => f.store.publishMemoryAvailability(createStatePublisher('another-publisher'), replay), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.store.publishAbilityAvailability(actor, { ...firstAbilityCommand, availability: abilityRead('different-authority') }), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(f.watermark!.read(), before);
});

test('schema3 ability metadata is a closed read description, never registration, permission, health or verification', t => {
  const f = fixture(t), initial = f.store.publish(actor, { requestId: 'initial', manifest: initialStateManifest() }).publication;
  const invalid: unknown[] = [ {}, { status: 'available' }, { ...abilityRead(), backendId: 'dsh-tools' },
    { ...abilityRead(), authorityId: '' }, { ...abilityRead(), authorityId: 'private authority' },
    { ...abilityRead(), capabilities: [] }, { ...abilityRead(), capabilities: ['execute'] }, { ...abilityRead(), capabilities: ['state_read', 'state_read'] },
    { ...abilityRead(), capabilities: ['state_read', 'write'] }, { ...abilityRead(), enabled: true }, { ...abilityRead(), verification: 'verified' },
    { ...abilityRead(), body: 'native tool source' }, { ...abilityRead(), safetyRevision: 1 }, { ...abilityRead(), definitionDigest: 'a'.repeat(64) },
    { ...abilityRead(), reason: 'not_connected' } ];
  for (const availability of invalid) assert.throws(() => f.store.publishAbilityAvailability(actor, { ...expected(initial, 'bad'), availability } as never), StatePublicationError);
  let accessed = false; const getter = abilityRead(); Object.defineProperty(getter, 'authorityId', { enumerable: true, get: () => { accessed = true; return 'forged'; } });
  assert.throws(() => f.store.publishAbilityAvailability(actor, { ...expected(initial, 'getter'), availability: getter }), code('INVALID_SCHEMA')); assert.equal(accessed, false);
  const schema3 = manifestWithAbilityAvailability(initial.manifest, abilityRead());
  for (const domain of ['relationship', 'emotion', 'cognition', 'personality'] as const) {
    const body = structuredClone(schema3); (body.domains as Record<string, unknown>)[domain] = abilityRead();
    assert.throws(() => f.store.publish(actor, next(initial, `bad-${domain}`, body)), StatePublicationError);
  }
  assert.throws(() => f.store.publish(actor, next(initial, 'disguised-schema2', { ...schema3, schemaVersion: 2 } as StateManifest)), StatePublicationError);
  for (const forged of [structuredClone(actor), { principalId: actor.principalId }] as StatePublisher[]) {
    assert.throws(() => f.store.publishAbilityAvailability(forged, { ...expected(initial, 'forged'), availability: abilityRead() }), code('FORBIDDEN'));
    assert.throws(() => f.store.publishMemoryAvailability(forged, { ...expected(initial, 'forged'), availability: memoryManifest().domains.memory }), code('FORBIDDEN'));
  }
  assert.equal(count(f.db), 1); assert.deepEqual(f.store.get(), initial);
});

test('pure composition and 1000 schema3 reads never publish or change control watermarks', t => {
  const f = fixture(t, true), initial = f.store.publish(actor, { requestId: 'initial', manifest: initialStateManifest() }).publication;
  const source = memoryManifest(true), original = structuredClone(source), available = abilityRead(), originalAbility = structuredClone(available);
  const combined = manifestWithAbilityAvailability(source, available), updated = manifestWithMemoryAvailability(combined, { status: 'unavailable', reason: 'not_connected' });
  assert.equal(updated.schemaVersion, 3); assert.deepEqual(updated.domains.ability, available);
  assert.deepEqual(source, original); assert.deepEqual(available, originalAbility);
  available.authorityId = 'changed-after-composition'; assert.deepEqual(combined.domains.ability, originalAbility);
  assert.equal(count(f.db), 1); assert.deepEqual(f.store.get(), initial);
  const publication = f.store.publish(actor, next(initial, 'combined', combined)).publication;
  const before = f.watermark!.read(), changes = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  for (let i = 0; i < 1000; i++) assert.deepEqual(f.store.get(), publication);
  assert.deepEqual(f.watermark!.read(), before); assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changes); assert.equal(count(f.db), 2);
});

test('ability availability withdrawal keeps schema3 and preserved memory while noop and stale-CAS rules remain unchanged', t => {
  const f = fixture(t), initial = f.store.publish(actor, { requestId: 'initial', manifest: initialStateManifest() }).publication;
  const memory = f.store.publishMemoryAvailability(actor, { ...expected(initial, 'memory'), availability: memoryManifest(true).domains.memory }).publication;
  const ability = f.store.publishAbilityAvailability(actor, { ...expected(memory, 'ability'), availability: abilityRead() }).publication;
  const second = f.open(), stale = second.store.get()!;
  const sameCommand = { ...expected(ability, 'same'), availability: abilityRead() };
  const same = f.store.publishAbilityAvailability(actor, sameCommand);
  assert.equal(same.status, 'unchanged'); assert.deepEqual(same.publication, ability);
  const stopped = f.store.publishAbilityAvailability(actor, { ...expected(ability, 'stop'), availability: { status: 'unavailable', reason: 'source_unavailable' } });
  assert.equal(stopped.publication.manifest.schemaVersion, 3); assert.deepEqual(stopped.publication.manifest.domains.memory, memory.manifest.domains.memory);
  assert.throws(() => second.store.publishMemoryAvailability(actor, { ...expected(stale, 'stale-memory'), availability: { status: 'unavailable', reason: 'source_unavailable' } }), code('VERSION_CONFLICT'));
  assert.deepEqual(second.store.get(), stopped.publication);
  const rowCount = count(second.db);
  assert.deepEqual(second.store.publishAbilityAvailability(actor, sameCommand), same);
  assert.deepEqual(second.store.get(), stopped.publication); assert.equal(count(second.db), rowCount);
});

test('schema3 receipt failure atomically rolls back the upgrade and cannot initialize a newer schema implicitly', t => {
  const f = fixture(t);
  assert.throws(() => f.store.publish(actor, { requestId: 'skip-initial', manifest: manifestWithAbilityAvailability(initialStateManifest(), abilityRead()) }), code('INVALID_INITIAL_MANIFEST'));
  assert.equal(f.store.get(), undefined); assert.equal(count(f.db), 0);
  const initial = f.store.publish(actor, { requestId: 'initial', manifest: initialStateManifest() }).publication;
  const memory = f.store.publishMemoryAvailability(actor, { ...expected(initial, 'memory'), availability: memoryManifest(true).domains.memory }).publication;
  const command = { ...expected(memory, 'ability'), availability: abilityRead() };
  f.db.exec("CREATE TRIGGER deny_ability_receipt BEFORE INSERT ON shiyu_state_publication_commands BEGIN SELECT RAISE(ABORT,'synthetic ability publication failure'); END");
  assert.throws(() => f.store.publishAbilityAvailability(actor, command), /synthetic ability publication failure/);
  assert.deepEqual(f.store.get(), memory); assert.equal(count(f.db), 2);
  f.db.exec('DROP TRIGGER deny_ability_receipt');
  assert.equal(f.store.publishAbilityAvailability(actor, command).publication.manifest.schemaVersion, 3);
});
