import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { StatePublicationStore, createStatePublisher, initialStateManifest } from '../src/state/publication.js';
import { LocalReadSafetyStore, createLocalReadOwner } from '../src/state/safety.js';
import { ViewDomain, type LocalViewCapture } from '../src/adapters/control-store/view-domain.js';
import { createLocalReadView } from '../src/views/local.js';
import type { TaskView } from '../src/control/tasks/index.js';

const code = (...codes: string[]) => (error: unknown) => error instanceof Error && 'code' in error && codes.includes(String(error.code));
async function fixture(t: TestContext, config: { publish?: boolean; ttlMs?: number; maxCaptures?: number; busyTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-local-views-')), filename = join(directory, 'control.sqlite');
  let now = new Date('2026-11-02T10:00:00.000Z');
  const connections: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(filename); connections.push(db); db.exec(`PRAGMA busy_timeout=${config.busyTimeoutMs ?? 25};`);
    const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
    tx.atomic(() => {
      db.exec('CREATE TABLE IF NOT EXISTS synthetic_sources(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS synthetic_epoch(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);');
      db.prepare('INSERT OR IGNORE INTO synthetic_epoch VALUES(1,7)').run();
    });
    const publication = new StatePublicationStore(db, tx, { publisherIds: ['state-service'], now: () => now });
    const publisher = createStatePublisher('state-service');
    if (config.publish !== false && !publication.get()) publication.publish(publisher, { requestId: 'boot', manifest: initialStateManifest() });
    const safety = new LocalReadSafetyStore(db, tx, { getAuthEpoch: () => Number(db.prepare('SELECT value FROM synthetic_epoch WHERE id=1').get()!.value), now: () => now });
    const get = <T>(id: string): T => JSON.parse(String(db.prepare('SELECT value FROM synthetic_sources WHERE id=?').get(id)!.value)) as T;
    const save = (id: string, value: unknown) => tx.atomic(() => { db.prepare('INSERT INTO synthetic_sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)); });
    const views = new ViewDomain(db, tx, { publication, safety, watermark, context: () => get('context'), getTask: id => get<TaskView>(id), now: () => now, ttlMs: config.ttlMs, maxCaptures: config.maxCaptures });
    return { db, tx, watermark, publication, publisher, safety, views, get, save, owner: createLocalReadOwner() };
  };
  const f = open();
  f.save('task-one', { taskId: 'task-one', title: 'Synthetic task', state: 'running', version: 3, updatedAt: now.toISOString(), stopRequested: false,
    inputRefs: ['SECRET-INPUT'], artifactPath: '/private/SECRET-PATH', result: { summary: 'SECRET-MODEL-TEXT' } });
  f.save('context', { token: { bindingId: 'binding-one', conversationId: 'conversation-one', scope: 'local-owner', audienceVersion: 1, conversationGeneration: 2, routingRevision: 1, sessionEpoch: 1, contextVersion: 0 },
    sources: [{ reference: { kind: 'task', id: 'task-one' }, sourceVersion: 0 }], pending: [], needsSync: true, businessId: 'synthetic-business' } satisfies LocalViewCapture['context']);
  t.after(async () => { for (const db of connections) { try { db.close(); } catch {} } await rm(directory, { recursive: true, force: true }); });
  return { ...f, open, filename, advance(ms: number) { now = new Date(now.getTime() + ms); }, now: () => now,
    capture: () => f.views.captureLocal({ conversationId: 'conversation-one', purpose: 'reply_context' }),
    validate: async (id: string) => f.views.validateReplyCapture(id, { for: 'ready' }) };
}

test('capture is one bounded pure read with real publication, scoped safety and Task aggregate provenance', async t => {
  const f = await fixture(t), before = f.watermark.read(), context = f.get('context');
  const capture = f.capture(), local = createLocalReadView(capture, { validate: f.validate, now: f.now });
  t.after(() => local.close()); const view = await local.read(); await local.assertCurrent(view.viewId);
  assert.equal(capture.publication.stateVersion, 1); assert.ok(Object.values(capture.publication.manifest.domains).every(value => value.status === 'unavailable'));
  assert.deepEqual(view.aggregateVersions, [{ aggregateType: 'task', aggregateId: 'task-one', version: 3 }]);
  assert.equal(view.sourceRefs[0].revision, 3); assert.equal(capture.context.sources[0].sourceVersion, 0);
  assert.equal(view.freshness.status, 'current'); assert.equal(view.authority!.deletionScope, 'local-task-source'); assert.equal(view.authority!.indexMode, 'not-used');
  assert.equal(capture.safety.authEpoch, 7); assert.equal(capture.safety.tombstoneWatermark, 0); assert.equal(capture.safety.baseline, 'since-local-read-authority-installation');
  assert.doesNotMatch(JSON.stringify(capture), /SECRET-|artifactPath|inputRefs/);
  assert.deepEqual(f.watermark.read(), before); assert.deepEqual(f.get('context'), context);
  assert.throws(() => f.views.captureLocal({ conversationId: 'conversation-one', purpose: 'reply_context', principalId: 'owner' } as never), code('INVALID_SCHEMA'));
  assert.throws(() => f.tx.atomic(() => f.capture()), code('TRANSACTION_BOUNDARY'));
});

test('pure reads never publish a missing manifest', async t => {
  const f = await fixture(t, { publish: false }), before = f.watermark.read();
  assert.throws(f.capture, code('STATE_UNPUBLISHED')); assert.equal(f.publication.get(), undefined); assert.deepEqual(f.watermark.read(), before);
});

test('Task updates invalidate sources but never advance stateVersion; ack keeps the captured versions', async t => {
  const f = await fixture(t), capture = f.capture(), before = f.publication.get();
  f.save('task-one', { ...f.get<TaskView>('task-one'), state: 'waiting', version: 4 });
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'prepare' }), code('STALE_SOURCE'));
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ready' }), code('STALE_SOURCE'));
  assert.deepEqual(f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), capture);
  assert.deepEqual(f.publication.get(), before);
});

test('background, generation and initial Session binding have distinct invalidation rules', async t => {
  const f = await fixture(t), capture = f.capture();
  let context = f.get<LocalViewCapture['context']>('context'); context.token.contextVersion++; context.sources[0].sourceVersion++;
  f.save('context', context); assert.deepEqual(f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), capture);
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ready' }), code('STALE_SOURCE'));
  context = structuredClone(capture.context); context.sessionId = 'first-native-session'; f.save('context', context);
  assert.deepEqual(f.views.validateReplyCapture(capture.captureId, { for: 'prepare' }), capture);
  const bound = f.capture(); context.sessionId = 'different-session'; f.save('context', context);
  assert.throws(() => f.views.validateReplyCapture(bound.captureId, { for: 'ack' }), code('STALE_CONTEXT'));
  context = structuredClone(capture.context); context.token.conversationGeneration++; f.save('context', context);
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), code('STALE_CONTEXT'));
});

test('unrelated real commits do not invalidate a capture or refresh its fixed deadline', async t => {
  const f = await fixture(t), capture = f.capture(), local = createLocalReadView(capture, { validate: f.validate, now: f.now }); t.after(() => local.close());
  const view = await local.read(); f.advance(5000); f.save('unrelated', { counter: 1 });
  assert.ok(f.watermark.read().commitSeq > capture.control.commitSeq); assert.deepEqual(await f.validate(capture.captureId), capture);
  await local.assertCurrent(view.viewId); assert.equal((await local.read()).expiresAt, capture.expiresAt);
  f.advance(25000); await assert.rejects(f.validate(capture.captureId), code('UNKNOWN_CAPTURE')); await assert.rejects(local.read(), code('DEPENDENCY_UNAVAILABLE'));
});

test('fresh authority checks invalidate policy, real global epoch and local source withdrawal independently', async t => {
  const f = await fixture(t); let capture = f.capture(), safety = f.safety.snapshot();
  f.safety.setEnabled(f.owner, { expectedPolicyAuthorityId: safety.policyAuthorityId, expectedPolicyVersion: safety.policyVersion, enabled: false });
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), code('VIEW_INVALIDATED')); assert.throws(f.capture, code('FORBIDDEN'));
  safety = f.safety.snapshot(); f.safety.setEnabled(f.owner, { expectedPolicyAuthorityId: safety.policyAuthorityId, expectedPolicyVersion: safety.policyVersion, enabled: true });
  capture = f.capture(); f.tx.atomic(() => { f.db.prepare('UPDATE synthetic_epoch SET value=value+1 WHERE id=1').run(); });
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), code('VIEW_INVALIDATED'));
  capture = f.capture(); safety = f.safety.snapshot(); f.safety.withdrawTask(f.owner, { taskId: 'task-one', expectedDeletionAuthorityId: safety.deletionAuthorityId, expectedTombstoneWatermark: 0 });
  assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ack' }), code('VIEW_INVALIDATED')); assert.throws(f.capture, code('SOURCE_WITHDRAWN'));
});

test('local owner policy and source withdrawal survive reopen; copied identities cannot mutate authority', async t => {
  const f = await fixture(t), safety = f.safety.snapshot();
  assert.throws(() => f.safety.setEnabled({ principalId: 'local-owner' } as never, { expectedPolicyAuthorityId: safety.policyAuthorityId, expectedPolicyVersion: 1, enabled: false }), code('FORBIDDEN'));
  assert.throws(() => f.safety.setEnabled(f.owner, { expectedPolicyAuthorityId: 'old-baseline', expectedPolicyVersion: 1, enabled: false }), code('VERSION_CONFLICT'));
  const before = f.watermark.read(); f.safety.setEnabled(f.owner, { expectedPolicyAuthorityId: safety.policyAuthorityId, expectedPolicyVersion: 1, enabled: true }); assert.deepEqual(f.watermark.read(), before);
  assert.throws(() => f.tx.atomic(() => { f.safety.setEnabled(f.owner, { expectedPolicyAuthorityId: safety.policyAuthorityId, expectedPolicyVersion: 1, enabled: false }); throw new Error('rollback'); }), /rollback/);
  assert.equal(f.safety.snapshot().policyVersion, 1);
  f.safety.setEnabled(f.owner, { expectedPolicyAuthorityId: safety.policyAuthorityId, expectedPolicyVersion: 1, enabled: false });
  f.safety.withdrawTask(f.owner, { taskId: 'task-one', expectedDeletionAuthorityId: safety.deletionAuthorityId, expectedTombstoneWatermark: 0 });
  const expected = f.safety.snapshot(), manifest = f.publication.get(); f.db.close(); const reopened = f.open();
  assert.deepEqual(reopened.safety.snapshot(), expected); assert.deepEqual(reopened.publication.get(), manifest);
  assert.equal(reopened.safety.isWithdrawn('task-one'), true); assert.throws(() => reopened.views.captureLocal({ conversationId: 'conversation-one', purpose: 'task_status' }), code('FORBIDDEN'));
});

test('missing safety baseline fails closed rather than reinstalling enabled authority', async t => {
  const f = await fixture(t); f.tx.atomic(() => f.db.prepare('DELETE FROM shiyu_local_read_safety').run());
  assert.throws(f.capture, code('CORRUPT_AUTHORITY')); assert.throws(() => new LocalReadSafetyStore(f.db, f.tx, { getAuthEpoch: () => 7 }), code('CORRUPT_AUTHORITY'));
});

test('capture is invalid across Worker-equivalent reopen and bounded capacity/expiry are enforced', async t => {
  const f = await fixture(t, { ttlMs: 10, maxCaptures: 1 }), capture = f.capture();
  assert.throws(f.capture, code('VIEW_CAPACITY')); f.advance(11); assert.notEqual(f.capture().captureId, capture.captureId);
  f.db.close(); const reopened = f.open(); assert.throws(() => reopened.views.validateReplyCapture(capture.captureId, { for: 'ack' }), code('UNKNOWN_CAPTURE'));
});

test('component data remains pinned and a source change during asynchronous read cannot mix versions', async t => {
  const f = await fixture(t), capture = f.capture(); let passes = 0;
  const local = createLocalReadView(capture, { now: f.now, validate: async id => {
    passes++; if (passes === 2) f.save('task-one', { ...f.get<TaskView>('task-one'), title: 'New title', version: 4 }); return f.validate(id);
  } }); t.after(() => local.close());
  await assert.rejects(local.read(), code('DEPENDENCY_UNAVAILABLE')); assert.equal(capture.tasks[0].version, 3);
  const tampered = structuredClone(capture); tampered.tasks[0].title = 'forged';
  const rebound = createLocalReadView(tampered, { validate: async () => capture, now: f.now }); t.after(() => rebound.close());
  await assert.rejects(rebound.read(), code('DEPENDENCY_UNAVAILABLE'));
});

test('actual new inner manifest publication invalidates old capture without pretending Task progress published it', async t => {
  const f = await fixture(t), capture = f.capture(), before = f.publication.get()!, manifest = initialStateManifest(); manifest.domains.memory.reason = 'verification_pending';
  f.publication.publish(f.publisher, { requestId: 'availability-changed', expectedStateVersion: before.stateVersion, expectedBaselineId: before.baselineId, manifest });
  assert.equal(f.publication.get()!.stateVersion, 2); assert.throws(() => f.views.validateReplyCapture(capture.captureId, { for: 'ready' }), code('VIEW_INVALIDATED'));
});

test('fixed capture TTL is rechecked after a real competing connection releases the SQLite write lock', async t => {
  const f = await fixture(t, { busyTimeoutMs: 2000 }), barrier = new SharedArrayBuffer(4), flag = new Int32Array(barrier);
  const holder = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.filename); const flag = new Int32Array(workerData.barrier);
    parentPort.once('message', () => {
      db.exec('BEGIN IMMEDIATE'); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
      Atomics.wait(flag, 0, 1, 350); db.exec('ROLLBACK'); db.close(); parentPort.postMessage('released'); parentPort.close();
    });
    parentPort.postMessage('ready');
  `, { eval: true, execArgv: [], workerData: { filename: f.filename, barrier } });
  t.after(async () => { await holder.terminate(); });
  await new Promise<void>((resolve, reject) => { holder.once('message', () => resolve()); holder.once('error', reject); });
  const views = new ViewDomain(f.db, f.tx, { publication: f.publication, safety: f.safety, watermark: f.watermark,
    context: () => f.get('context'), getTask: id => f.get<TaskView>(id), ttlMs: 100 });
  const capture = views.captureLocal({ conversationId: 'conversation-one', purpose: 'reply_context' });
  holder.postMessage('hold'); if (Atomics.load(flag, 0) !== 1) Atomics.wait(flag, 0, 0, 2000);
  assert.equal(Atomics.load(flag, 0), 1); assert.ok(Date.now() < Date.parse(capture.expiresAt));
  assert.throws(() => views.validateReplyCapture(capture.captureId, { for: 'ready' }), code('EXPIRED'));
  assert.ok(Date.now() >= Date.parse(capture.expiresAt));
});
