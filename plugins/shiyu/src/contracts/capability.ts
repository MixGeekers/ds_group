import { createHash } from 'node:crypto';

export const LOCAL_NOTE_CAPABILITY_ID = 'task.local-note.execute' as const;
/** Fixed declaration, not a second tool registry or an authorization grant. */
export const LOCAL_NOTE_DECLARATION = Object.freeze({
  capabilityId: LOCAL_NOTE_CAPABILITY_ID,
  version: 'local-note-v1' as const,
  providerRef: 'dsh:shiyu-worker-local-note' as const,
  toolName: 'shiyu_worker_write_note' as const,
  scope: 'local-owner' as const,
  verificationPolicy: 'informational' as const,
  requiredActions: Object.freeze(['task.local-note.execute', 'artifact.write'] as const),
  maxBodyBytes: 1024 as const,
});
export type CapabilityId = typeof LOCAL_NOTE_CAPABILITY_ID;
export type LocalNoteDefinition = typeof LOCAL_NOTE_DECLARATION & { definitionDigest: string };
/** Produced by trusted composition from the related implementation/SDK content. */
export interface CapabilityBinding {
  definitionDigest: string; installationGeneration: string; environmentFingerprint: string;
}
/** Comparison metadata only. The original Task/Goal authority still decides permission. */
export interface CapabilityRef extends CapabilityBinding {
  capabilityId: CapabilityId; authorityId: string; safetyRevision: number;
}
/** Only a synchronous same-Worker Task reader may produce this after independently checking its ledger. */
export interface CapabilityTaskEvidence {
  taskId: string; taskVersion: number; assignmentId: string; effectId: string; receiptId: string;
  observedAt: string; capabilityRef: CapabilityRef;
}
export interface CapabilitySnapshot {
  schemaVersion: 1; authorityId: string; revision: number; safetyRevision: number;
  definition: LocalNoteDefinition; binding: CapabilityBinding;
  declared: true; enabled: boolean;
  availability: 'available' | 'unavailable' | 'unknown';
  verification: 'unknown' | 'verified' | 'stale';
  usableForAuthorizedTask: boolean; reasonCode: string;
  evidenceRefs: string[]; observedAt?: string; lastSuccess?: CapabilityTaskEvidence;
}
export interface CapabilityCapture {
  schemaVersion: 1; capturedAt: string; revision: number; record: CapabilitySnapshot; ref: CapabilityRef;
}
export interface CapabilityAuthorityPort {
  captureForCore(): CapabilityCapture;
  requireCurrent(): CapabilityRef;
  assertCurrent(ref: CapabilityRef): void;
}
export interface CapabilityCommandReceipt {
  requestId: string; changed: boolean; snapshot: CapabilitySnapshot;
}
export interface CapabilityCommands {
  'ability.snapshot': { input: Record<string, never>; output: CapabilitySnapshot };
  'ability.setEnabled': { input: { requestId: string; expectedRevision: number; enabled: boolean }; output: CapabilityCommandReceipt };
  /** Private Runtime observation. Never forward caller JSON or proof to this command. */
  'ability.observeLocalNote': { input: { requestId: string; expectedRevision: number; hostEpoch: string;
    binding: CapabilityBinding; status: CapabilitySnapshot['availability']; reasonCode: string }; output: CapabilityCommandReceipt };
}
export type CapabilityDomainRequest = { [K in keyof CapabilityCommands]: { command: K; args: CapabilityCommands[K]['input'] } }[keyof CapabilityCommands];
export class CapabilityError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CapabilityError'; }
}
export function capabilityFail(code: string, message: string): never { throw new CapabilityError(code, message); }
export function capabilityFields(value: unknown, keys: readonly string[], required = keys): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) capabilityFail('INVALID_CAPABILITY_INPUT', 'Expected bounded plain capability metadata');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key)) || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value') || !field.enumerable)) capabilityFail('INVALID_CAPABILITY_INPUT', 'Unknown, accessor or missing capability fields');
}
export function capabilityId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(value)) capabilityFail('INVALID_CAPABILITY_INPUT', 'Invalid capability metadata identity');
  return value;
}
export function capabilityInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) capabilityFail('INVALID_CAPABILITY_INPUT', 'Capability revisions must be positive safe integers');
  return Number(value);
}
export function capabilityInstant(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) capabilityFail('INVALID_CAPABILITY_INPUT', 'Invalid canonical capability timestamp');
  return value;
}
export function capabilityDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) capabilityFail('INVALID_CAPABILITY_INPUT', 'Expected an implementation content digest');
  return value;
}
export function createLocalNoteDefinition(definitionDigest: string): LocalNoteDefinition {
  return { ...structuredClone(LOCAL_NOTE_DECLARATION), definitionDigest: capabilityDigest(definitionDigest) };
}
export function validateCapabilityBinding(value: CapabilityBinding): CapabilityBinding {
  capabilityFields(value, ['definitionDigest', 'installationGeneration', 'environmentFingerprint']);
  return { definitionDigest: capabilityDigest(value.definitionDigest), installationGeneration: capabilityId(value.installationGeneration), environmentFingerprint: capabilityDigest(value.environmentFingerprint) };
}
export function validateCapabilityRef(value: CapabilityRef): CapabilityRef {
  capabilityFields(value, ['capabilityId', 'authorityId', 'safetyRevision', 'definitionDigest', 'installationGeneration', 'environmentFingerprint']);
  if (value.capabilityId !== LOCAL_NOTE_CAPABILITY_ID) capabilityFail('INVALID_CAPABILITY_INPUT', 'Only the fixed local-note capability is registered');
  return { capabilityId: LOCAL_NOTE_CAPABILITY_ID, authorityId: capabilityId(value.authorityId), safetyRevision: capabilityInteger(value.safetyRevision),
    ...validateCapabilityBinding({ definitionDigest: value.definitionDigest, installationGeneration: value.installationGeneration, environmentFingerprint: value.environmentFingerprint }) };
}
export function validateCapabilityTaskEvidence(value: CapabilityTaskEvidence): CapabilityTaskEvidence {
  capabilityFields(value, ['taskId', 'taskVersion', 'assignmentId', 'effectId', 'receiptId', 'observedAt', 'capabilityRef']);
  return { taskId: capabilityId(value.taskId), taskVersion: capabilityInteger(value.taskVersion), assignmentId: capabilityId(value.assignmentId),
    effectId: capabilityId(value.effectId), receiptId: capabilityId(value.receiptId), observedAt: capabilityInstant(value.observedAt),
    capabilityRef: validateCapabilityRef(value.capabilityRef) };
}
/** Validate historical facts as written, without reinterpreting them using today's availability. */
export function validateCapabilitySnapshot(value: CapabilitySnapshot): CapabilitySnapshot {
  capabilityFields(value, ['schemaVersion', 'authorityId', 'revision', 'safetyRevision', 'definition', 'binding', 'declared', 'enabled',
    'availability', 'verification', 'usableForAuthorizedTask', 'reasonCode', 'evidenceRefs', 'observedAt', 'lastSuccess'],
  ['schemaVersion', 'authorityId', 'revision', 'safetyRevision', 'definition', 'binding', 'declared', 'enabled', 'availability', 'verification', 'usableForAuthorizedTask', 'reasonCode', 'evidenceRefs']);
  capabilityId(value.authorityId); capabilityInteger(value.revision); capabilityInteger(value.safetyRevision);
  validateCapabilityBinding(value.binding);
  capabilityFields(value.definition, [...Object.keys(LOCAL_NOTE_DECLARATION), 'definitionDigest']);
  if (value.schemaVersion !== 1 || value.declared !== true || typeof value.enabled !== 'boolean' || value.safetyRevision > value.revision
    || canonicalCapability(value.definition) !== canonicalCapability(createLocalNoteDefinition(value.binding.definitionDigest))
    || !['available', 'unavailable', 'unknown'].includes(value.availability) || !['unknown', 'verified', 'stale'].includes(value.verification)
    || value.usableForAuthorizedTask !== (value.enabled && value.availability === 'available')
    || typeof value.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.reasonCode)) capabilityFail('INVALID_CAPABILITY_INPUT', 'Inconsistent capability snapshot');
  if (value.observedAt !== undefined) capabilityInstant(value.observedAt);
  if (value.availability === 'available' && value.observedAt === undefined) capabilityFail('INVALID_CAPABILITY_INPUT', 'Available capability has no observation');
  if (value.lastSuccess !== undefined) {
    const proof = validateCapabilityTaskEvidence(value.lastSuccess);
    if (proof.capabilityRef.authorityId !== value.authorityId || proof.capabilityRef.safetyRevision > value.safetyRevision
      || value.verification === 'unknown') capabilityFail('INVALID_CAPABILITY_INPUT', 'Inconsistent capability success reference');
    if (value.verification === 'verified' && (proof.capabilityRef.definitionDigest !== value.binding.definitionDigest
      || proof.capabilityRef.environmentFingerprint !== value.binding.environmentFingerprint
      || proof.capabilityRef.installationGeneration !== value.binding.installationGeneration)) capabilityFail('INVALID_CAPABILITY_INPUT', 'Verified capability evidence has a different binding');
  } else if (value.verification !== 'unknown') capabilityFail('INVALID_CAPABILITY_INPUT', 'Capability verification has no evidence');
  const expectedRefs = value.lastSuccess ? [value.lastSuccess.taskId, value.lastSuccess.assignmentId, value.lastSuccess.effectId, value.lastSuccess.receiptId] : [];
  if (!Array.isArray(value.evidenceRefs) || canonicalCapability(value.evidenceRefs) !== canonicalCapability(expectedRefs)) capabilityFail('INVALID_CAPABILITY_INPUT', 'Capability evidence references differ from their source');
  return structuredClone(value);
}
export function canonicalCapability(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
export function capabilityHash(value: unknown): string { return createHash('sha256').update(canonicalCapability(value)).digest('hex'); }
