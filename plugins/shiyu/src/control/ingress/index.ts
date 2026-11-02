import { createHash } from 'node:crypto';
import { innerAccount, type InnerAccount } from '../../contracts/inner.js';
import type { ConversationKey } from '../conversations/types.js';
import type {
  ChannelAccountKind, ChannelAttachmentRef, ChannelAudienceMode, ChannelCapabilities, ChannelContent,
  ChannelConversationInput, ChannelEventKind, ChannelInboundEvent, ChannelMessageStatus, ChannelParticipantInput,
  ChannelParticipantKind, ChannelPlatformRef, ChannelPrivacyClass,
} from '../../contracts/channel.js';

/**
 * Pure identity, validation and revision rules for the generic channel ingress.
 *
 * This module never touches SQLite, the clock or the network, so the identity
 * matrix can be proven independently of persistence. The persistence domain
 * (`adapters/control-store/ingress-domain.ts`) must not invent another identity
 * scheme: it derives every key through these functions.
 *
 * Threat split (H6a):
 *  - trusted adapter metadata = envelope fields validated here (namespaces,
 *    ids, revision numbers, actor kind, privacy class, capabilities);
 *  - untrusted content = `content` fields only (digest, opaque reference,
 *    bounded summary, attachment references). Content is never parsed for
 *    identity and cannot add fields to the envelope.
 */

export class IngressError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'IngressError'; }
}
export const ingressFail = (code: string, message: string): never => { throw new IngressError(code, message); };

/** Strict plain-object check: no accessors, no symbols, no unknown keys. */
export function ingressFields(value: unknown, keys: readonly string[], required: readonly string[] = keys): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    ingressFail('INVALID_SCHEMA', 'Expected bounded plain channel metadata');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some(field => !Object.hasOwn(field, 'value') || !field.enumerable)) {
    ingressFail('INVALID_SCHEMA', 'Unknown, accessor or missing channel fields');
  }
}

const namespacePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const accountPartPattern = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,199}$/;
const opaquePattern = /^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,199}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const MODES: readonly ChannelAudienceMode[] = ['direct', 'group', 'channel'];
const KINDS: readonly ChannelEventKind[] = ['message.create', 'message.edit', 'message.retract', 'message.delete'];
const PARTICIPANT_KINDS: readonly ChannelParticipantKind[] = ['human', 'bot', 'system'];
const ACCOUNT_KINDS: readonly ChannelAccountKind[] = ['bot', 'service', 'human'];
const PRIVACY_CLASSES: readonly ChannelPrivacyClass[] = ['public', 'internal', 'private'];
const ATTACHMENT_KINDS: readonly ChannelAttachmentRef['kind'][] = ['file', 'image', 'audio', 'video', 'other'];

export const MAX_CHANNEL_SOURCE_ID = 200;
export const MAX_CHANNEL_SUMMARY_BYTES = 512;
export const MAX_CHANNEL_ATTACHMENTS = 8;
export const MAX_CHANNEL_NATIVE_REVISION = 1_000_000_000;
const MAX_ATTACHMENT_BYTES = 2 ** 31;

function text(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) ingressFail('INVALID_SCHEMA', `Invalid ${label}`);
  return value as string;
}
function namespace(value: unknown, label: string): string { return text(value, label, namespacePattern); }
function accountPart(value: unknown, label: string): string { return text(value, label, accountPartPattern); }
function opaque(value: unknown, label: string): string { return text(value, label, opaquePattern); }
function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) ingressFail('INVALID_SCHEMA', `Invalid ${label}`);
  return value as string;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) ingressFail('INVALID_SCHEMA', `Invalid ${label}`);
  return Number(value);
}
function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) ingressFail('INVALID_SCHEMA', `Invalid ${label}`);
  return value as T;
}
function instant(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    ingressFail('INVALID_SCHEMA', `Expected canonical UTC ${label}`);
  }
  return value as string;
}
function summary(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || Buffer.byteLength(value, 'utf8') > MAX_CHANNEL_SUMMARY_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value) || /\p{Surrogate}/u.test(value)) ingressFail('INVALID_SCHEMA', 'Invalid bounded content summary');
  return value as string;
}

/** Canonical JSON: sorted object keys, undefined properties omitted, arrays preserved. */
export function ingressCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) ingressFail('INVALID_SCHEMA', 'Non-finite number in channel metadata');
    return JSON.stringify(value);
  }
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(ingressCanonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${ingressCanonical(item)}`).join(',')}}`;
  }
  return ingressFail('INVALID_SCHEMA', 'Unsupported value in channel metadata');
}
export function ingressDigest(value: unknown): string { return createHash('sha256').update(ingressCanonical(value)).digest('hex'); }

export interface ChannelIngressLimits {
  maxEventsPerBatch: number;
  maxIntakeRows: number;
  maxMessagesPerConversation: number;
  maxParticipantsPerConversation: number;
  maxCaptures: number;
  maxConnections: number;
  maxConversations: number;
  captureTtlMs: number;
}
/** Defensive bounds, not measured capacity. Tests may lower them for boundary cases. */
export const CHANNEL_INGRESS_LIMITS: Readonly<ChannelIngressLimits> = Object.freeze({
  maxEventsPerBatch: 100, maxIntakeRows: 100_000, maxMessagesPerConversation: 10_000, maxParticipantsPerConversation: 1_000,
  maxCaptures: 512, maxConnections: 100, maxConversations: 1_000, captureTtlMs: 120_000,
});
export function normalizeChannelLimits(overrides?: Partial<ChannelIngressLimits>): ChannelIngressLimits {
  if (overrides === undefined) return { ...CHANNEL_INGRESS_LIMITS };
  ingressFields(overrides, Object.keys(CHANNEL_INGRESS_LIMITS), []);
  const limits = { ...CHANNEL_INGRESS_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const min = key === 'captureTtlMs' ? 1_000 : 1;
    limits[key as keyof ChannelIngressLimits] = integer(value, key, min, 10_000_000);
  }
  return limits;
}

const REF_PATTERNS = {
  connection: /^chconn-[a-f0-9]{32}$/,
  conversation: /^chconv-[a-f0-9]{32}$/,
  participant: /^chpart-[a-f0-9]{32}$/,
  message: /^chmsg-[a-f0-9]{40}$/,
  capture: /^chcap-[a-f0-9]{32}$/,
} as const;
export type ChannelRefKind = keyof typeof REF_PATTERNS;
export function channelRef(value: unknown, kind: ChannelRefKind): string {
  if (typeof value !== 'string' || !REF_PATTERNS[kind].test(value)) ingressFail('INVALID_SCHEMA', `Invalid ${kind} reference`);
  return value as string;
}
export function normalizeReasonRef(value: unknown): string { return opaque(value, 'reasonRef'); }
export function normalizeOptionalReasonRef(value: unknown): string | undefined {
  return value === undefined ? undefined : opaque(value, 'reasonRef');
}

/* --------------------------------- identity -------------------------------- */

export interface NormalizedConnection {
  connectionId: string;
  sourceNamespace: string;
  platform: ChannelPlatformRef;
  account: { accountId: string; nativeAccountId: string; kind: ChannelAccountKind };
  capabilities: ChannelCapabilities;
}

export function normalizeCapabilities(value: unknown): ChannelCapabilities {
  const keys = ['edit', 'retract', 'delete', 'receipts', 'idempotentSend'];
  ingressFields(value, keys);
  const capabilities = {} as ChannelCapabilities;
  for (const key of keys) {
    if (typeof (value as Record<string, unknown>)[key] !== 'boolean') ingressFail('INVALID_SCHEMA', `Capability ${key} must be boolean`);
    (capabilities as unknown as Record<string, boolean>)[key] = (value as Record<string, boolean>)[key];
  }
  return capabilities;
}

export function normalizeConnection(value: unknown): NormalizedConnection {
  ingressFields(value, ['sourceNamespace', 'platform', 'account', 'capabilities']);
  const sourceNamespace = namespace(value.sourceNamespace, 'sourceNamespace');
  ingressFields(value.platform, ['provider', 'deployment']);
  const platform: ChannelPlatformRef = {
    provider: namespace(value.platform.provider, 'platform.provider'),
    deployment: namespace(value.platform.deployment, 'platform.deployment'),
  };
  ingressFields(value.account, ['accountId', 'nativeAccountId', 'kind']);
  const account = {
    accountId: accountPart(value.account.accountId, 'account.accountId'),
    nativeAccountId: opaque(value.account.nativeAccountId, 'account.nativeAccountId'),
    kind: oneOf(value.account.kind, 'account.kind', ACCOUNT_KINDS),
  };
  const capabilities = normalizeCapabilities(value.capabilities);
  return { connectionId: connectionIdFor(sourceNamespace, platform, account), sourceNamespace, platform, account, capabilities };
}

/**
 * Persistent connection identity: derived only from the trusted source tuple.
 * Reconnect or process restart with the same tuple yields the same connection;
 * a second account or deployment can never collide with the first.
 */
export function connectionIdFor(sourceNamespace: string, platform: ChannelPlatformRef, account: NormalizedConnection['account']): string {
  return `chconn-${ingressDigest([sourceNamespace, platform.provider, platform.deployment, account.accountId, account.nativeAccountId, account.kind]).slice(0, 32)}`;
}

export function normalizeConversationInput(value: unknown): ChannelConversationInput {
  ingressFields(value, ['nativeConversationId', 'threadId', 'mode'], ['nativeConversationId', 'mode']);
  return {
    nativeConversationId: opaque(value.nativeConversationId, 'nativeConversationId'),
    mode: oneOf(value.mode, 'conversation.mode', MODES),
    ...(value.threadId === undefined ? {} : { threadId: opaque(value.threadId, 'threadId') }),
  };
}

export function normalizeParticipantInput(value: unknown): ChannelParticipantInput {
  ingressFields(value, ['nativeParticipantId', 'kind']);
  return {
    nativeParticipantId: accountPart(value.nativeParticipantId, 'nativeParticipantId'),
    kind: oneOf(value.kind, 'participant.kind', PARTICIPANT_KINDS),
  };
}

export function conversationRefFor(connectionId: string, conversation: ChannelConversationInput): string {
  return `chconv-${ingressDigest([connectionId, conversation.nativeConversationId, conversation.threadId ?? null, conversation.mode]).slice(0, 32)}`;
}

/** Participant identity is per namespace+account, never per display name or short id. */
export function participantRefFor(connection: Pick<NormalizedConnection, 'sourceNamespace' | 'account'>, participant: ChannelParticipantInput): string {
  return `chpart-${ingressDigest([connection.sourceNamespace, connection.account.accountId, participant.nativeParticipantId]).slice(0, 32)}`;
}

export function messageIdFor(connection: Pick<NormalizedConnection, 'sourceNamespace' | 'account'>, conversationRef: string, nativeMessageId: string): string {
  return `chmsg-${ingressDigest([connection.sourceNamespace, connection.account.accountId, conversationRef, nativeMessageId]).slice(0, 40)}`;
}

/** Order-insensitive digest of the active audience; mode is part of the identity. */
export function audienceDigest(mode: ChannelAudienceMode, participantRefs: readonly string[]): string {
  return ingressDigest([mode, [...new Set(participantRefs)].sort()]);
}

export function capabilityForKind(capabilities: ChannelCapabilities, kind: ChannelEventKind): boolean {
  return kind === 'message.create' ? true : kind === 'message.edit' ? capabilities.edit
    : kind === 'message.retract' ? capabilities.retract : capabilities.delete;
}

/* ------------------------------- inbound events ----------------------------- */

export interface NormalizedContent {
  contentHash?: string;
  bodyRef?: string;
  summary?: string;
  attachments: ChannelAttachmentRef[];
}
export interface NormalizedInboundEvent {
  nativeEventId?: string;
  kind: ChannelEventKind;
  message: { nativeMessageId: string; revision: number; occurredAt: string };
  sequence?: number;
  actor: ChannelParticipantInput;
  privacyClass: ChannelPrivacyClass;
  content: NormalizedContent;
  reasonRef?: string;
  sourceEventId: string;
  composedSourceEventId: boolean;
  fingerprint: string;
}

export function normalizedContent(value: unknown, kind: ChannelEventKind): NormalizedContent {
  ingressFields(value, ['contentHash', 'bodyRef', 'summary', 'attachments'], []);
  const raw = value as Record<string, unknown>;
  if (kind === 'message.retract' || kind === 'message.delete') {
    // A tombstone revision never carries body or attachment references.
    const present = ['contentHash', 'bodyRef', 'summary', 'attachments'].filter(key => raw[key] !== undefined);
    if (present.length) ingressFail('INVALID_SCHEMA', 'A retract/delete revision must not carry content references');
    return { attachments: [] };
  }
  if (raw.contentHash === undefined) ingressFail('INVALID_SCHEMA', 'Create/edit revisions require the exact native content hash');
  const attachments = raw.attachments === undefined ? [] : raw.attachments;
  if (!Array.isArray(attachments) || attachments.length > MAX_CHANNEL_ATTACHMENTS) ingressFail('INVALID_SCHEMA', 'Bounded attachment references are required');
  const refs: ChannelAttachmentRef[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments as unknown[]) {
    ingressFields(attachment, ['ref', 'kind', 'sha256', 'byteLength'], ['ref', 'kind']);
    const ref = opaque((attachment as Record<string, unknown>).ref, 'attachment.ref');
    if (seen.has(ref)) ingressFail('INVALID_SCHEMA', 'Duplicate attachment reference');
    seen.add(ref);
    refs.push({
      ref, kind: oneOf((attachment as Record<string, unknown>).kind, 'attachment.kind', ATTACHMENT_KINDS),
      ...((attachment as Record<string, unknown>).sha256 === undefined ? {} : { sha256: hash((attachment as Record<string, unknown>).sha256, 'attachment.sha256') }),
      ...((attachment as Record<string, unknown>).byteLength === undefined ? {} : { byteLength: integer((attachment as Record<string, unknown>).byteLength, 'attachment.byteLength', 0, MAX_ATTACHMENT_BYTES) }),
    });
  }
  return {
    contentHash: hash(raw.contentHash, 'content.contentHash'),
    ...(raw.bodyRef === undefined ? {} : { bodyRef: opaque(raw.bodyRef, 'content.bodyRef') }),
    ...(raw.summary === undefined ? {} : { summary: summary(raw.summary) }),
    attachments: refs,
  };
}

export function normalizeInboundEvent(value: unknown): NormalizedInboundEvent {
  ingressFields(value, ['nativeEventId', 'kind', 'message', 'sequence', 'actor', 'privacyClass', 'content', 'reasonRef'],
    ['kind', 'message', 'actor', 'privacyClass', 'content']);
  const raw = value as Record<string, unknown>;
  const kind = oneOf(raw.kind, 'event.kind', KINDS);
  ingressFields(raw.message, ['nativeMessageId', 'revision', 'occurredAt']);
  const nativeMessageId = opaque(raw.message.nativeMessageId, 'message.nativeMessageId');
  const revision = integer(raw.message.revision, 'message.revision', 1, MAX_CHANNEL_NATIVE_REVISION);
  if (kind === 'message.create' ? revision !== 1 : revision < 2) ingressFail('INVALID_SCHEMA', 'Create revisions start at 1; later revisions follow 2..');
  const message = { nativeMessageId, revision, occurredAt: instant(raw.message.occurredAt, 'message.occurredAt') };
  const sequence = raw.sequence === undefined ? undefined : integer(raw.sequence, 'sequence', 0, Number.MAX_SAFE_INTEGER);
  const actor = normalizeParticipantInput(raw.actor);
  const privacyClass = oneOf(raw.privacyClass, 'privacyClass', PRIVACY_CLASSES);
  const content = normalizedContent(raw.content, kind);
  const reasonRef = raw.reasonRef === undefined ? undefined : opaque(raw.reasonRef, 'reasonRef');
  if (raw.nativeEventId !== undefined && raw.nativeEventId !== null) {
    const nativeEventId = opaque(raw.nativeEventId, 'nativeEventId');
    const fingerprint = ingressDigest({ kind, message, sequence: sequence ?? null, actor, privacyClass, content, reasonRef: reasonRef ?? null });
    return { nativeEventId, kind, message, ...(sequence === undefined ? {} : { sequence }), actor, privacyClass, content,
      ...(reasonRef === undefined ? {} : { reasonRef }), sourceEventId: nativeEventId, composedSourceEventId: false, fingerprint };
  }
  const sourceEventId = `${nativeMessageId}#r${revision}#${kind}`;
  if (sourceEventId.length > MAX_CHANNEL_SOURCE_ID) ingressFail('INVALID_SCHEMA', 'Composed source event identity is too long');
  const fingerprint = ingressDigest({ kind, message, sequence: sequence ?? null, actor, privacyClass, content, reasonRef: reasonRef ?? null });
  return { kind, message, ...(sequence === undefined ? {} : { sequence }), actor, privacyClass, content, ...(reasonRef === undefined ? {} : { reasonRef }),
    sourceEventId, composedSourceEventId: true, fingerprint };
}

/* ------------------------------ revision model ------------------------------ */

export interface ChannelMessageState {
  status: ChannelMessageStatus;
  nativeRevision: number;
  conversationRef: string;
}
export type ChannelRevisionDecision =
  | { action: 'create' }
  | { action: 'apply' }
  | { action: 'stale'; reasonCode: 'STALE_REVISION' }
  | { action: 'reject'; reasonCode: 'MESSAGE_NOT_ADMITTED' | 'MESSAGE_ALREADY_ADMITTED' | 'MESSAGE_DELETED' };

/**
 * Pure revision gate for one message identity.
 *
 * A terminal retract/delete is not resurrected. A late or duplicate revision
 * never overwrites a newer native revision; an unknown message never accepts an
 * edit (platform ordering is explicit, not guessed from received-at time).
 */
export function revisionDecision(current: ChannelMessageState | undefined, event: Pick<NormalizedInboundEvent, 'kind' | 'message'>): ChannelRevisionDecision {
  if (!current) return event.kind === 'message.create' ? { action: 'create' } : { action: 'reject', reasonCode: 'MESSAGE_NOT_ADMITTED' };
  if (event.kind === 'message.create') return { action: 'reject', reasonCode: 'MESSAGE_ALREADY_ADMITTED' };
  if (current.status === 'retracted' || current.status === 'deleted') return { action: 'reject', reasonCode: 'MESSAGE_DELETED' };
  if (event.message.revision <= current.nativeRevision) return { action: 'stale', reasonCode: 'STALE_REVISION' };
  return { action: 'apply' };
}

/* --------------------------- cross-domain composition ----------------------- */

/** Stable inner identity-binding tuple for the same trusted account reference. */
export function toInnerAccount(input: {
  connectionId: string;
  sourceNamespace: string;
  accountId: string;
  nativeParticipantId: string;
  kind: ChannelParticipantKind;
}): InnerAccount {
  // innerAccount() re-validates the exact contract used by RelationshipDomain,
  // so an ingress participant can be registered as a stable relationship subject.
  return innerAccount({
    connectionId: input.connectionId,
    identityNamespace: `${input.sourceNamespace}:${input.accountId}`,
    identityType: `channel-${input.kind}`,
    externalSubjectId: input.nativeParticipantId,
  });
}

/** Map a channel audience to the existing ConversationStore key shape. */
export function toConversationKey(
  conversation: Pick<{ connectionId: string; nativeConversationId: string; threadId?: string; mode: ChannelAudienceMode }, 'connectionId' | 'nativeConversationId' | 'threadId' | 'mode'>,
  scope: string,
): ConversationKey {
  if (!scope || scope.length > 200 || /[\u0000-\u001f]/u.test(scope)) ingressFail('INVALID_SCHEMA', 'Invalid conversation scope');
  return {
    connectionId: conversation.connectionId,
    platformConversationId: conversation.nativeConversationId,
    ...(conversation.threadId === undefined ? {} : { threadId: conversation.threadId }),
    kind: conversation.mode,
    scope,
  };
}

/** Deterministic reason reference for ConversationStore.invalidateAudience. */
export function conversationInvalidationReason(input: { conversationRef: string; audienceVersion: number; reasonRef: string }): string {
  const value = `channel-audience:${input.conversationRef}:v${input.audienceVersion}:${input.reasonRef}`;
  return value.slice(0, 300);
}
