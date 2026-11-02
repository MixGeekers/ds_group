import { randomUUID } from 'node:crypto';
import type { ControlStore } from '../../src/adapters/control-store/index.js';
import { localNoteDefinitionDigest, localNoteEnvironmentFingerprint } from '../../src/adapters/capability-identity.js';
import type { CapabilityBinding } from '../../src/contracts/capability.js';

/** An explicit synthetic dependency identity. It is never a native-host proof. */
export const SYNTHETIC_WORKER_DEPENDENCY = 'f'.repeat(64);

/** Tests opt in to a fixed local-note binding at store construction. No production defaults change. */
export function syntheticLocalNoteBinding(installationGeneration: string): CapabilityBinding {
  return { definitionDigest: localNoteDefinitionDigest(), installationGeneration,
    environmentFingerprint: localNoteEnvironmentFingerprint(SYNTHETIC_WORKER_DEPENDENCY) };
}

/** Explicit trusted fixture setup, after opening a real temporary control store.
 * This observation proves only the fake executor selected by the calling test.
 * Tests of unconfigured/unknown availability must not call it. */
export async function observeSyntheticLocalNote(store: Pick<ControlStore, 'request'>,
  identity: { hostEpoch: string; installationGeneration: string },
  binding = syntheticLocalNoteBinding(identity.installationGeneration)) {
  const current = await store.request('ability.snapshot', {});
  return store.request('ability.observeLocalNote', { requestId: `synthetic-preflight:${randomUUID()}`,
    expectedRevision: current.revision, hostEpoch: identity.hostEpoch, binding,
    status: 'available', reasonCode: 'TRUSTED_FIXTURE_READY' });
}

/** Only Runtime fixtures opt in. Real Runtime must call the real driver preflight. */
export async function prepareSyntheticLocalNote(): Promise<{ dependencyFingerprint: string }> {
  return { dependencyFingerprint: SYNTHETIC_WORKER_DEPENDENCY };
}
