import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CapabilityDomain } from '../../src/adapters/control-store/capability-domain.js';
import type { CommitWatermarkReader } from '../../src/adapters/control-store/commit-watermark.js';
import type { SqliteTransactions } from '../../src/adapters/control-store/transaction.js';
import type { TaskDomain, TaskRuntimeIdentity } from '../../src/adapters/control-store/task-domain.js';
import { StatePublicationStore, createStatePublisher, initialStateManifest, manifestWithAbilityAvailability } from '../../src/state/publication.js';
import { LocalReadSafetyStore } from '../../src/state/safety.js';
import { syntheticLocalNoteBinding } from './capability.js';

/** Real temporary SQLite domains; available means the explicit synthetic
 * executor used by these tests, never a probe of the installed host. */
export function installCoreCapabilityFixture(db: DatabaseSync, tx: SqliteTransactions, tasks: TaskDomain,
  runtimeIdentity: TaskRuntimeIdentity, watermark: CommitWatermarkReader, now?: () => Date) {
  const binding = syntheticLocalNoteBinding(runtimeIdentity.installationGeneration);
  const capability = new CapabilityDomain(db, tx, { runtimeIdentity, binding, now,
    taskEvidence: taskId => tasks.inspectCapabilityEvidence(taskId) });
  tasks.setCapabilityAuthority(capability);
  const snapshot = capability.snapshot();
  capability.observeLocalNote({ requestId: `core-fixture-observe:${randomUUID()}`, expectedRevision: snapshot.revision,
    hostEpoch: runtimeIdentity.hostEpoch, binding, status: 'available', reasonCode: 'TRUSTED_FIXTURE_READY' });
  const publication = new StatePublicationStore(db, tx, { publisherIds: ['core-fixture'], now });
  const publisher = createStatePublisher('core-fixture');
  if (!publication.get()) publication.publish(publisher, { requestId: `core-fixture-initialize:${randomUUID()}`, manifest: initialStateManifest() });
  const current = publication.get()!;
  const manifest = manifestWithAbilityAvailability(current.manifest, {
    status: 'available', backendId: 'control-ability', authorityId: capability.snapshot().authorityId, capabilities: ['state_read'] });
  publication.publish(publisher, { requestId: `core-fixture-publish:${randomUUID()}`, manifest,
    expectedStateVersion: current.stateVersion, expectedBaselineId: current.baselineId });
  const safety = new LocalReadSafetyStore(db, tx, { getAuthEpoch: () => tasks.mandates.health().authEpoch, now });
  return { capability, publication, safety, watermark, binding };
}
