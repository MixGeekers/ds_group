import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { CapabilityDomain, type CapabilityDomainOptions } from '../src/adapters/control-store/capability-domain.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { createLocalNoteDefinition, validateCapabilitySnapshot, type CapabilityBinding, type CapabilityTaskEvidence } from '../src/contracts/capability.js';

const binding: CapabilityBinding = { definitionDigest: 'a'.repeat(64), environmentFingerprint: 'b'.repeat(64), installationGeneration: 'capability-test-install' };
const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-capability-')), path = join(directory, 'control.sqlite');
  const connections = new Set<DatabaseSync>(), proofs = new Map<string, CapabilityTaskEvidence>();
  let clock = Date.parse('2026-11-02T12:00:00.000Z'), sequence = 0, reads = 0;
  let reader: CapabilityDomainOptions['taskEvidence'] = taskId => { reads++; return proofs.get(taskId); };
  const open = (input: { hostEpoch?: string; binding?: CapabilityBinding; taskEvidence?: CapabilityDomainOptions['taskEvidence'] } = {}) => {
    const db = new DatabaseSync(path); connections.add(db); db.exec('PRAGMA busy_timeout=1000');
    const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
    const hostEpoch = input.hostEpoch ?? 'capability-test-host', selected = input.binding ?? binding;
    const domain = new CapabilityDomain(db, tx, { runtimeIdentity: { hostEpoch, installationGeneration: selected.installationGeneration },
      binding: selected, now: () => new Date(clock), taskEvidence: input.taskEvidence ?? (taskId => reader?.(taskId)) });
    const observe = (status: 'available' | 'unavailable' | 'unknown' = 'available') => domain.observeLocalNote({ requestId: `observe:${++sequence}`,
      expectedRevision: domain.snapshot().revision, hostEpoch, binding: selected, status, reasonCode: status === 'available' ? 'TEST_READY' : 'TEST_UNAVAILABLE' });
    const proof = (taskId = 'task:test'): CapabilityTaskEvidence => ({ taskId, taskVersion: 8, assignmentId: `assignment:${taskId}`, effectId: `effect:${taskId}`,
      receiptId: `receipt:${taskId}`, observedAt: new Date(clock).toISOString(), capabilityRef: domain.requireCurrent() });
    return { db, tx, watermark, domain, observe, proof, hostEpoch, binding: selected,
      close() { db.close(); connections.delete(db); } };
  };
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, proofs, reads: () => reads, advance: (ms: number) => { clock += ms; }, setReader(value: typeof reader) { reader = value; } };
}

test('fixed definition is detached, bounded, and does not grant permission', () => {
  const one = createLocalNoteDefinition(binding.definitionDigest), two = createLocalNoteDefinition(binding.definitionDigest);
  assert.equal(one.capabilityId, 'task.local-note.execute'); assert.equal(one.verificationPolicy, 'informational');
  assert.equal(one.definitionDigest, binding.definitionDigest); assert.deepEqual(one.requiredActions, ['task.local-note.execute', 'artifact.write']);
  (one.requiredActions as unknown as string[]).push('unsafe'); assert.equal(two.requiredActions.length, 2);
  assert.throws(() => createLocalNoteDefinition('unbound-version-label'), code('INVALID_CAPABILITY_INPUT'));
});

test('first authorized call can use an observed builtin with unknown verification; all read ports are pure', t => {
  const f = fixture(t), initial = f.domain.snapshot();
  assert.equal(initial.enabled, true); assert.equal(initial.availability, 'unknown'); assert.equal(initial.verification, 'unknown');
  assert.equal(initial.usableForAuthorizedTask, false); assert.throws(() => f.domain.requireCurrent(), code('CAPABILITY_UNAVAILABLE'));
  f.observe(); const current = f.domain.snapshot(), ref = f.domain.requireCurrent(), before = f.watermark.read();
  assert.equal(current.verification, 'unknown'); assert.equal(current.usableForAuthorizedTask, true);
  for (let i = 0; i < 1000; i++) {
    assert.deepEqual(f.domain.snapshot(), current); assert.deepEqual(f.domain.requireCurrent(), ref); f.domain.assertCurrent(ref);
    const capture = f.domain.captureForCore(); assert.deepEqual(capture.record, current); assert.deepEqual(capture.ref, ref);
    assert.equal(capture.revision, current.revision); assert.equal(capture.capturedAt, '2026-11-02T12:00:00.000Z');
  }
  assert.deepEqual(f.watermark.read(), before); assert.equal(f.reads(), 0);
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'shiyu_capability_%' ORDER BY name").all().map(row => row.name), ['shiyu_capability_commands', 'shiyu_capability_state']);
});

test('public schemas reject actor, proof, body, dynamic capabilities, accessors and hidden fields', t => {
  const f = fixture(t), before = f.watermark.read(); let invoked = 0;
  const valid = { requestId: 'disable', expectedRevision: 1, enabled: false };
  for (const extra of [{ actor: 'owner' }, { proof: {} }, { body: 'private note body' }, { capabilityId: 'new.tool' }])
    assert.throws(() => f.domain.setEnabled({ ...valid, ...extra }), code('INVALID_CAPABILITY_INPUT'));
  assert.throws(() => f.domain.setEnabled({ ...valid, get actor() { invoked++; return 'owner'; } }), code('INVALID_CAPABILITY_INPUT'));
  assert.throws(() => f.domain.setEnabled(Object.defineProperty({ ...valid }, 'enabled', { value: false, enumerable: false })), code('INVALID_CAPABILITY_INPUT'));
  assert.throws(() => f.domain.setEnabled({ ...valid, [Symbol('proof')]: true }), code('INVALID_CAPABILITY_INPUT'));
  assert.throws(() => f.domain.execute({ command: 'ability.recordSuccessfulTask', args: { taskId: 'fake' } } as never), code('INVALID_CAPABILITY_INPUT'));
  assert.throws(() => f.domain.execute({ command: 'ability.snapshot', args: { probe: true } } as never), code('INVALID_CAPABILITY_INPUT'));
  assert.equal(invoked, 0); assert.deepEqual(f.watermark.read(), before);
});

test('observations require the current host, binding, revision, bounded status and reason', t => {
  const f = fixture(t), before = f.watermark.read();
  const input = { requestId: 'observe', expectedRevision: 1, hostEpoch: f.hostEpoch, binding, status: 'available' as const, reasonCode: 'TEST_READY' };
  for (const patch of [{ hostEpoch: 'other' }, { binding: { ...binding, definitionDigest: 'c'.repeat(64) } }])
    assert.throws(() => f.domain.observeLocalNote({ ...input, ...patch }), code('CAPABILITY_CHANGED'));
  for (const patch of [{ status: 'verified' }, { reasonCode: 'arbitrary note body' }, { proof: {} }, { expectedRevision: 0 }])
    assert.throws(() => f.domain.observeLocalNote({ ...input, ...patch } as never), code('INVALID_CAPABILITY_INPUT'));
  assert.deepEqual(f.watermark.read(), before); f.observe();
  assert.throws(() => f.domain.observeLocalNote(input), code('CAPABILITY_CONFLICT'));
});

test('owner commands use CAS across connections and exact historical replay before checking the current head', t => {
  const f = fixture(t), other = f.open(), input = { requestId: 'disable', expectedRevision: 1, enabled: false };
  const first = f.domain.setEnabled(input), after = f.watermark.read();
  assert.equal(first.changed, true); assert.equal(first.snapshot.safetyRevision, 2);
  assert.deepEqual(other.domain.setEnabled(input), first); assert.deepEqual(f.watermark.read(), after);
  assert.throws(() => other.domain.setEnabled({ requestId: 'racer', expectedRevision: 1, enabled: true }), code('CAPABILITY_CONFLICT'));
  assert.throws(() => other.domain.setEnabled({ ...input, enabled: true }), code('IDEMPOTENCY_CONFLICT'));
  f.domain.setEnabled({ requestId: 'enable', expectedRevision: 2, enabled: true });
  assert.deepEqual(other.domain.setEnabled(input), first); assert.equal(other.domain.snapshot().enabled, true);
});

test('noop commands preserve the revision but have one durable replayable receipt', t => {
  const f = fixture(t), input = { requestId: 'already-enabled', expectedRevision: 1, enabled: true }, before = f.watermark.read();
  const receipt = f.domain.setEnabled(input); assert.equal(receipt.changed, false); assert.equal(receipt.snapshot.revision, 1);
  assert.equal(f.watermark.read().commitSeq, before.commitSeq + 1);
  const after = f.watermark.read(); assert.deepEqual(f.domain.setEnabled(input), receipt); assert.deepEqual(f.watermark.read(), after);
});

test('receipt failure rolls back the state and watermark together', t => {
  const f = fixture(t), before = f.domain.snapshot(), watermark = f.watermark.read(), prepare = f.db.prepare;
  f.db.prepare = function(sql: string) { if (sql.startsWith('INSERT INTO shiyu_capability_commands')) throw new Error('synthetic receipt failure'); return prepare.call(this, sql); };
  try { assert.throws(() => f.domain.setEnabled({ requestId: 'disable', expectedRevision: 1, enabled: false }), /synthetic receipt failure/); }
  finally { f.db.prepare = prepare; }
  assert.deepEqual(f.domain.snapshot(), before); assert.deepEqual(f.watermark.read(), watermark);
  assert.equal(f.db.prepare('SELECT count(*) n FROM shiyu_capability_commands').get()!.n, 0);
});

test('disable then re-enable never revives an old safety reference', t => {
  const f = fixture(t); f.observe(); const old = f.domain.requireCurrent();
  const disabled = f.domain.setEnabled({ requestId: 'disable', expectedRevision: f.domain.snapshot().revision, enabled: false });
  assert.equal(disabled.snapshot.availability, 'available'); assert.equal(disabled.snapshot.usableForAuthorizedTask, false);
  assert.throws(() => f.domain.requireCurrent(), code('CAPABILITY_UNAVAILABLE'));
  f.domain.setEnabled({ requestId: 'enable', expectedRevision: disabled.snapshot.revision, enabled: true });
  assert.throws(() => f.domain.assertCurrent(old), code('CAPABILITY_CHANGED'));
  f.domain.assertCurrent(f.domain.requireCurrent());
});

test('healthy observation refresh preserves a current reference; health loss and recovery cannot revive it', t => {
  const f = fixture(t); f.observe(); const old = f.domain.requireCurrent(), initial = f.domain.snapshot();
  f.advance(1000); const refreshed = f.observe().snapshot;
  assert.equal(refreshed.revision, initial.revision + 1); assert.equal(refreshed.safetyRevision, initial.safetyRevision); f.domain.assertCurrent(old);
  f.observe('unavailable'); assert.throws(() => f.domain.requireCurrent(), code('CAPABILITY_UNAVAILABLE'));
  f.observe('available'); assert.throws(() => f.domain.assertCurrent(old), code('CAPABILITY_CHANGED'));
});

test('same host reopens without writes; new host requires a new observation and rejects the old instance', t => {
  const f = fixture(t); f.observe(); const old = f.domain.requireCurrent(), before = f.watermark.read();
  const same = f.open(); assert.deepEqual(same.watermark.read(), before); same.domain.assertCurrent(old);
  const next = f.open({ hostEpoch: 'new-host' });
  assert.equal(next.domain.snapshot().availability, 'unknown'); assert.throws(() => next.domain.requireCurrent(), code('CAPABILITY_UNAVAILABLE'));
  assert.throws(() => f.domain.requireCurrent(), code('CAPABILITY_UNAVAILABLE'));
  next.observe(); assert.throws(() => next.domain.assertCurrent(old), code('CAPABILITY_CHANGED')); next.domain.requireCurrent();
});

test('old host observation retry returns the exact receipt across restart without restoring stale availability', t => {
  const f = fixture(t), input = { requestId: 'old-observation', expectedRevision: 1, hostEpoch: f.hostEpoch, binding, status: 'available' as const, reasonCode: 'TEST_READY' };
  const first = f.domain.observeLocalNote(input); f.close(); const next = f.open({ hostEpoch: 'new-host' }), before = next.watermark.read();
  assert.deepEqual(next.domain.observeLocalNote(input), first); assert.equal(next.domain.snapshot().availability, 'unknown'); assert.deepEqual(next.watermark.read(), before);
  assert.throws(() => next.domain.observeLocalNote({ ...input, requestId: 'stale-new-request', expectedRevision: next.domain.snapshot().revision }), code('CAPABILITY_CHANGED'));
});

test('disabled owner choice survives new host and new implementation binding', t => {
  const f = fixture(t); f.domain.setEnabled({ requestId: 'disable', expectedRevision: 1, enabled: false }); f.close();
  const next = f.open({ hostEpoch: 'new-host', binding: { ...binding, definitionDigest: 'c'.repeat(64) } });
  assert.equal(next.domain.snapshot().enabled, false); next.observe(); assert.throws(() => next.domain.requireCurrent(), code('CAPABILITY_UNAVAILABLE'));
});

test('only trusted exact Task evidence records success; proof changes revision without invalidating active refs', t => {
  const f = fixture(t); f.observe(); const proof = f.proof(), old = f.domain.requireCurrent(), before = f.domain.snapshot();
  assert.equal(f.domain.recordSuccessfulTask(proof.taskId).recorded, false); assert.equal(f.domain.snapshot().verification, 'unknown');
  f.proofs.set(proof.taskId, proof); const result = f.domain.recordSuccessfulTask(proof.taskId);
  assert.equal(result.recorded, true); assert.equal(result.snapshot.verification, 'verified'); assert.equal(result.snapshot.revision, before.revision + 1);
  assert.equal(result.snapshot.safetyRevision, before.safetyRevision); f.domain.assertCurrent(old);
  assert.deepEqual(result.snapshot.evidenceRefs, [proof.taskId, proof.assignmentId, proof.effectId, proof.receiptId]);
  const watermark = f.watermark.read(); assert.equal(f.domain.recordSuccessfulTask(proof.taskId).recorded, false); assert.deepEqual(f.watermark.read(), watermark);
  validateCapabilitySnapshot(result.snapshot);
});

test('late successful facts after disable retain evidence without granting new work', t => {
  const f = fixture(t); f.observe(); const proof = f.proof();
  f.domain.setEnabled({ requestId: 'disable', expectedRevision: f.domain.snapshot().revision, enabled: false }); f.proofs.set(proof.taskId, proof);
  const result = f.domain.recordSuccessfulTask(proof.taskId);
  assert.equal(result.recorded, true); assert.equal(result.snapshot.verification, 'verified'); assert.equal(result.snapshot.usableForAuthorizedTask, false);
  assert.throws(() => f.domain.requireCurrent(), code('CAPABILITY_UNAVAILABLE'));
});

test('success evidence has no TTL and survives a same-content/environment host restart without model verification', t => {
  const f = fixture(t); f.observe(); const proof = f.proof(); f.proofs.set(proof.taskId, proof); f.domain.recordSuccessfulTask(proof.taskId);
  f.advance(90 * 24 * 60 * 60 * 1000); f.close(); const next = f.open({ hostEpoch: 'later-host' });
  assert.equal(next.domain.snapshot().verification, 'verified'); assert.equal(next.domain.snapshot().availability, 'unknown');
  next.observe(); assert.equal(next.domain.snapshot().usableForAuthorizedTask, true); assert.deepEqual(next.domain.snapshot().lastSuccess, proof);
});

test('definition/environment/installation changes make old proof stale, while first authorized new use remains possible', t => {
  for (const patch of [{ definitionDigest: 'c'.repeat(64) }, { environmentFingerprint: 'd'.repeat(64) }, { installationGeneration: 'new-install' }]) {
    const f = fixture(t); f.observe(); const proof = f.proof(); f.proofs.set(proof.taskId, proof); f.domain.recordSuccessfulTask(proof.taskId); f.close();
    const next = f.open({ binding: { ...binding, ...patch } });
    assert.equal(next.domain.snapshot().verification, 'stale'); assert.equal(next.domain.snapshot().availability, 'unknown');
    next.observe(); assert.equal(next.domain.snapshot().usableForAuthorizedTask, true); assert.throws(() => next.domain.assertCurrent(proof.capabilityRef), code('CAPABILITY_CHANGED'));
    assert.equal(next.domain.recordSuccessfulTask(proof.taskId).recorded, false);
  }
});

test('missing, altered or unreadable proof sources become stale on pure read and do not block owner disabling', t => {
  const f = fixture(t); f.observe(); const proof = f.proof(); f.proofs.set(proof.taskId, proof); f.domain.recordSuccessfulTask(proof.taskId);
  const before = f.watermark.read(); f.proofs.delete(proof.taskId); assert.equal(f.domain.snapshot().verification, 'stale');
  f.proofs.set(proof.taskId, { ...proof, receiptId: 'changed-receipt' }); assert.equal(f.domain.snapshot().verification, 'stale');
  f.setReader(() => { throw new Error('synthetic unavailable source'); }); assert.equal(f.domain.snapshot().verification, 'stale'); assert.deepEqual(f.watermark.read(), before);
  assert.equal(f.domain.setEnabled({ requestId: 'disable', expectedRevision: f.domain.snapshot().revision, enabled: false }).snapshot.enabled, false);
});

test('wrong, future, body-bearing and async evidence never becomes a successful proof', t => {
  const f = fixture(t); f.observe(); const proof = f.proof(), before = f.watermark.read();
  for (const value of [{ ...proof, taskId: 'different' }, { ...proof, body: 'private content' }, { ...proof, observedAt: '2027-01-01T00:00:00.000Z' },
    { ...proof, capabilityRef: { ...proof.capabilityRef, safetyRevision: proof.capabilityRef.safetyRevision + 1 } }]) {
    f.setReader(() => value); assert.throws(() => f.domain.recordSuccessfulTask(proof.taskId));
  }
  f.setReader((() => Promise.reject(new Error('synthetic async evidence'))) as never);
  assert.throws(() => f.domain.recordSuccessfulTask(proof.taskId), code('ASYNC_CAPABILITY_SOURCE'));
  let invoked = 0; f.setReader((() => ({ then() { invoked++; } })) as never);
  assert.throws(() => f.domain.recordSuccessfulTask(proof.taskId), code('ASYNC_CAPABILITY_SOURCE')); assert.equal(invoked, 0);
  assert.deepEqual(f.watermark.read(), before); assert.equal(f.domain.snapshot().verification, 'unknown');
  const records = JSON.stringify(f.db.prepare('SELECT * FROM shiyu_capability_state').all()); assert.equal(records.includes('private content'), false);
});

test('constructor rejects asynchronous readers, mismatched transactions and installation identities before writing', t => {
  const f = fixture(t), before = f.watermark.read(), base = { runtimeIdentity: { hostEpoch: f.hostEpoch, installationGeneration: binding.installationGeneration }, binding };
  assert.throws(() => new CapabilityDomain(f.db, f.tx, { ...base, taskEvidence: (async () => undefined) as never }), code('ASYNC_CAPABILITY_SOURCE'));
  assert.throws(() => new CapabilityDomain(f.db, f.tx, { ...base, runtimeIdentity: { ...base.runtimeIdentity, installationGeneration: 'different' } }), code('INVALID_CAPABILITY_INPUT'));
  const other = new DatabaseSync(':memory:'); t.after(() => other.close());
  assert.throws(() => new CapabilityDomain(f.db, new SqliteTransactions(other), base), code('TRANSACTION_MISMATCH'));
  assert.deepEqual(f.watermark.read(), before);
});

test('damaged historical receipts cannot return fabricated verification or mismatched binding', t => {
  const f = fixture(t), input = { requestId: 'historical', expectedRevision: 1, enabled: false }, first = f.domain.setEnabled(input);
  for (const snapshot of [{ ...first.snapshot, verification: 'verified' }, { ...first.snapshot, usableForAuthorizedTask: true },
    { ...first.snapshot, definition: { ...first.snapshot.definition, definitionDigest: 'c'.repeat(64) } }, { ...first.snapshot, body: 'private' }]) {
    f.tx.atomic(() => f.db.prepare('UPDATE shiyu_capability_commands SET receipt_json=? WHERE request_id=?').run(JSON.stringify({ ...first, snapshot }), input.requestId));
    assert.throws(() => f.domain.setEnabled(input), code('CAPABILITY_STORAGE_INVALID'));
  }
});

test('missing/future state and partial table history fail closed rather than being reconstructed by reads or startup', t => {
  for (const mode of ['row', 'version'] as const) {
    const f = fixture(t);
    f.tx.atomic(() => { if (mode === 'row') f.db.exec('DELETE FROM shiyu_capability_state');
      else f.db.exec('UPDATE shiyu_capability_state SET schema_version=999'); });
    const before = f.watermark.read();
    assert.throws(() => f.domain.snapshot(), code('CAPABILITY_STORAGE_INVALID'));
    assert.throws(() => new CapabilityDomain(f.db, f.tx, { runtimeIdentity: { hostEpoch: f.hostEpoch, installationGeneration: binding.installationGeneration }, binding }), code('CAPABILITY_STORAGE_INVALID'));
    assert.deepEqual(f.watermark.read(), before);
  }
  // An incomplete legacy file exists before the guarded connection opens. The
  // watermark itself forbids dropping guarded tables to synthesize corruption.
  const directory = mkdtempSync(join(tmpdir(), 'shiyu-capability-partial-')), db = new DatabaseSync(join(directory, 'control.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec('CREATE TABLE shiyu_capability_state(id INTEGER PRIMARY KEY,schema_version INTEGER,record_json TEXT)');
  const tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx), before = watermark.read();
  assert.throws(() => new CapabilityDomain(db, tx, { runtimeIdentity: { hostEpoch: 'host', installationGeneration: binding.installationGeneration }, binding }), code('CAPABILITY_STORAGE_INVALID'));
  assert.deepEqual(watermark.read(), before);
});
