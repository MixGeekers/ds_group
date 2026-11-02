import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import {
  StatePublicationError, StatePublicationStore, createStatePublisher, initialStateManifest,
  manifestWithInnerAvailability, manifestWithMemoryAvailability,
  type AvailableInnerDomain, type InnerDomainAvailability, type PublishedState, type StateManifest,
} from '../src/state/publication.js';
import type { InnerDomain } from '../src/contracts/inner.js';

const actor = createStatePublisher('state-service');
const code = (expected: string) => (error: unknown) => error instanceof StatePublicationError && error.code === expected;
const availableInner = (domain: InnerDomain, authorityId = `${domain}-authority`): AvailableInnerDomain => ({
  status: 'available', backendId: { relationship: 'control-relationship', emotion: 'control-emotion', cognition: 'control-cognition', personality: 'control-personality' }[domain],
  authorityId, capabilities: ['metadata_read', 'content_read'],
});
const innerAvailability = (patch: Partial<Record<InnerDomain, AvailableInnerDomain>> = {}): InnerDomainAvailability => ({
  relationship: patch.relationship ?? availableInner('relationship'), emotion: patch.emotion ?? { status: 'unavailable', reason: 'not_connected' },
  cognition: patch.cognition ?? { status: 'unavailable', reason: 'not_connected' }, personality: patch.personality ?? { status: 'unavailable', reason: 'not_connected' },
});
const expected = (publication: PublishedState, requestId: string) => ({ requestId, expectedBaselineId: publication.baselineId, expectedStateVersion: publication.stateVersion });
function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'shiyu-inner-publication-'));
  const filename = path.join(directory, 'control.sqlite');
  const connections: DatabaseSync[] = [];
  let clock = Date.parse('2026-11-02T12:00:00.000Z');
  const open = () => {
    const db = new DatabaseSync(filename); connections.push(db);
    db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;');
    const tx = new SqliteTransactions(db);
    const store = new StatePublicationStore(db, tx, { publisherIds: ['state-service'], now: () => new Date(clock) });
    return { db, tx, store };
  };
  t.after(() => { for (const db of connections) if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, directory, advance() { clock += 1000; } };
}

test('schema4 declares only the inner domains that a trusted publisher actually wires, preserving memory and ability', t => {
  const f = fixture(t);
  assert.throws(() => f.store.publish(actor, { requestId: 'skip', manifest: manifestWithInnerAvailability(initialStateManifest(), innerAvailability()) }), code('INVALID_INITIAL_MANIFEST'));
  const legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  const memory = f.store.publishMemoryAvailability(actor, { ...expected(legacy.publication, 'memory'),
    availability: { status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a', capabilities: ['exact_read'] } }).publication;
  const ability = f.store.publishAbilityAvailability(actor, { ...expected(memory, 'ability'),
    availability: { status: 'available', backendId: 'control-ability', authorityId: 'ability-authority', capabilities: ['state_read'] } }).publication;
  const inner = f.store.publishInnerAvailability(actor, { ...expected(ability, 'inner'), availability: innerAvailability({ relationship: availableInner('relationship') }) });
  assert.equal(inner.publication.manifest.schemaVersion, 4); assert.equal(inner.publication.stateVersion, 4);
  assert.deepEqual(inner.publication.manifest.domains.relationship, availableInner('relationship'));
  assert.deepEqual(inner.publication.manifest.domains.memory, memory.manifest.domains.memory);
  assert.deepEqual(inner.publication.manifest.domains.ability, ability.manifest.domains.ability);
  assert.deepEqual(inner.publication.manifest.domains.cognition, { status: 'unavailable', reason: 'not_connected' });
  assert.deepEqual(f.store.publishInnerAvailability(actor, { ...expected(ability, 'inner'), availability: innerAvailability({ relationship: availableInner('relationship') }) }), inner);
  assert.throws(() => f.store.publishInnerAvailability(actor, { ...expected(ability, 'stale'), availability: innerAvailability() }), code('VERSION_CONFLICT'));
  // AVAILABLE is a closed read description, never registration/permission/health.
  for (const invalid of [
    { ...availableInner('relationship'), backendId: 'control-ability' },
    { ...availableInner('relationship'), authorityId: '' },
    { ...availableInner('relationship'), capabilities: ['read'] },
    { ...availableInner('relationship'), capabilities: ['metadata_read'] },
    { ...availableInner('relationship'), body: 'profile body' },
    { ...availableInner('relationship'), enabled: true },
    { ...availableInner('relationship'), reason: 'not_connected' },
  ]) {
    assert.throws(() => f.store.publishInnerAvailability(actor, { ...expected(inner.publication, 'bad'), availability: innerAvailability({ relationship: invalid as never }) }), StatePublicationError);
  }
});

test('schema1-3 manifests still require the four inner domains to be unavailable; schema4 is required to declare them', t => {
  const f = fixture(t);
  const legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  const witness = initialStateManifest() as unknown as { schemaVersion: number; domains: Record<string, unknown> };
  witness.schemaVersion = 3; witness.domains.relationship = availableInner('relationship');
  assert.throws(() => f.store.publish(actor, { ...expected(legacy.publication, 'schema3-available'), manifest: witness as unknown as StateManifest }), StatePublicationError);
  const inner = f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner'), availability: innerAvailability() }).publication;
  assert.throws(() => f.store.publish(actor, { ...expected(inner, 'downgrade'), manifest: initialStateManifest() }), code('SCHEMA_DOWNGRADE'));
  // A legacy schema3 declaration remains replayable and its old receipt keeps its exact bytes.
  const replay = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  assert.deepEqual(replay, legacy);
  assert.equal(f.store.get()!.stateVersion, 2);
});

test('memory and ability availability updates preserve a schema4 inner-domain publication', t => {
  const f = fixture(t);
  const legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  const inner = f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner'), availability: innerAvailability() }).publication;
  const memory = f.store.publishMemoryAvailability(actor, { ...expected(inner, 'memory-update'),
    availability: { status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a', capabilities: ['exact_read'] } });
  assert.equal(memory.publication.manifest.schemaVersion, 4);
  assert.deepEqual(memory.publication.manifest.domains.relationship, availableInner('relationship'));
  const ability = f.store.publishAbilityAvailability(actor, { ...expected(memory.publication, 'ability-update'),
    availability: { status: 'available', backendId: 'control-ability', authorityId: 'ability-authority', capabilities: ['state_read'] } });
  assert.equal(ability.publication.manifest.schemaVersion, 4);
  assert.deepEqual(ability.publication.manifest.domains.relationship, availableInner('relationship'));
  assert.deepEqual(ability.publication.manifest.domains.memory, memory.publication.manifest.domains.memory);
});

test('withdrawing an inner-domain read capability stays schema4 and can be resumed without rewriting history', t => {
  const f = fixture(t);
  const legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  const first = f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner-one'), availability: innerAvailability() }).publication;
  const stopped = f.store.publishInnerAvailability(actor, { ...expected(first, 'inner-stop'), availability: innerAvailability({ relationship: { status: 'unavailable', reason: 'source_unavailable' } as never }) });
  assert.equal(stopped.publication.manifest.schemaVersion, 4); assert.deepEqual(stopped.publication.manifest.domains.relationship, { status: 'unavailable', reason: 'source_unavailable' });
  const resumed = f.store.publishInnerAvailability(actor, { ...expected(stopped.publication, 'inner-resume'), availability: innerAvailability() });
  assert.deepEqual(resumed.publication.manifest.domains.relationship, availableInner('relationship'));
  assert.deepEqual(f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner-one'), availability: innerAvailability() }).publication, first);
});

test('a failed inner availability receipt rolls back the schema upgrade and leaves the prior publication intact', t => {
  const f = fixture(t), legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  f.db.exec("CREATE TRIGGER deny_inner_receipt BEFORE INSERT ON shiyu_state_publication_commands BEGIN SELECT RAISE(ABORT,'synthetic inner publication failure'); END");
  assert.throws(() => f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner'), availability: innerAvailability() }), /synthetic inner publication failure/);
  assert.deepEqual(f.store.get(), legacy.publication);
  f.db.exec('DROP TRIGGER deny_inner_receipt');
  assert.equal(f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner'), availability: innerAvailability() }).publication.manifest.schemaVersion, 4);
});

test('pure composition upgrades to schema4 and never mutates its inputs or publishes implicitly', t => {
  const f = fixture(t), legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() }).publication;
  const availability = innerAvailability({ emotion: availableInner('emotion') }), original = structuredClone(availability);
  const composed = manifestWithInnerAvailability(manifestWithMemoryAvailability(legacy.manifest,
    { status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a', capabilities: ['exact_read'] }), availability);
  assert.equal(composed.schemaVersion, 4); assert.deepEqual(composed.domains.emotion, availableInner('emotion'));
  assert.deepEqual(composed.domains.memory, { status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a', capabilities: ['exact_read'] });
  assert.deepEqual(availability, original); assert.deepEqual(f.store.get(), legacy);
  availability.emotion = availableInner('emotion', 'changed-after-composition');
  assert.deepEqual(composed.domains.emotion, availableInner('emotion'));
});

test('schema4 inner availability retries replay their original receipt instead of the current head', t => {
  const f = fixture(t), legacy = f.store.publish(actor, { requestId: 'legacy', manifest: initialStateManifest() });
  const first = f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner'), availability: innerAvailability({ relationship: availableInner('relationship') }) });
  const stopped = f.store.publishInnerAvailability(actor, { ...expected(first.publication, 'stop'), availability: innerAvailability() }).publication;
  const replay = f.store.publishInnerAvailability(actor, { ...expected(legacy.publication, 'inner'), availability: innerAvailability({ relationship: availableInner('relationship') }) });
  assert.deepEqual(replay, first); assert.deepEqual(f.store.get(), stopped);
  for (const modified of [{ ...expected(legacy.publication, 'inner'), availability: innerAvailability({ relationship: { status: 'unavailable', reason: 'source_unavailable' } as never }) },
    { ...expected(first.publication, 'inner'), availability: innerAvailability({ relationship: availableInner('relationship') }) }]) {
    assert.throws(() => f.store.publishInnerAvailability(actor, modified), code('IDEMPOTENCY_CONFLICT'));
  }
});
