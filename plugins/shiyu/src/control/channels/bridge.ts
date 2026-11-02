import type { DatabaseSync } from 'node:sqlite';
import type { ControlStore } from '../../adapters/control-store/index.js';
import type {
  ChannelAudienceMode, ChannelConnectionView, ChannelConversationView, ChannelInvalidation, ChannelParticipantView,
  ChannelSnapshot, ChannelWatermark,
} from '../../contracts/channel.js';
import { innerAccount, type InnerAccount, type RelationshipEntityKind } from '../../contracts/inner.js';
import type { ConversationKey } from '../conversations/types.js';
import { toConversationKey } from '../ingress/index.js';

/**
 * H6b: trusted bridge between the generic channel ledger (H6a, `channel.*`) and
 * the existing ConversationStore/RelationshipDomain (H1/H4).
 *
 * Three separate concerns share this module:
 *
 * 1. Pure identity composition: a channel audience maps to the exact
 *    `ConversationKey` shape and a channel participant maps to the exact
 *    `InnerAccount` tuple. Both are validated against the real contracts; no
 *    parallel identity scheme is introduced.
 * 2. A trusted same-SQLite read of the channel ledger used by the Worker-side
 *    binding commands. That read is not a business conversation read: it only
 *    resolves the authoritative channel conversation identity/audience state
 *    for a binding request.
 * 3. The host-side `ChannelRuntimeBridge` used by Runtime/Lead integration: it
 *    binds channel conversations to ConversationStore conversations, applies
 *    invalidation signals to already-affected conversation audiences (pull
 *    path), and exposes one bounded read-only projection for
 *    `runtime.snapshot()`. It never sends, never calls a model and never
 *    accepts an actor/authorization from outside the trusted Worker command
 *    surface.
 */

export class ChannelBridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ChannelBridgeError'; }
}
export const channelBridgeFail = (code: string, message: string): never => { throw new ChannelBridgeError(code, message); };

/** Bounded as trusted adapter/control identities, not as public model text. */
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,299}$/;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/@#-]{0,199}$/;
export const CHANNEL_BINDING_LIMIT = 128;
export const CHANNEL_PROJECTION_LIMIT = 20;
export const CHANNEL_PROJECTION_INVALIDATION_LIMIT = 200;

function bridgeText(value: unknown, label: string, pattern: RegExp, max = 300): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) {
    channelBridgeFail('INVALID_SCHEMA', `Invalid ${label}`);
  }
  return value as string;
}
export function normalizeBridgeScope(value: unknown): string { return bridgeText(value, 'bridge scope', SCOPE_PATTERN, 200); }
export function normalizeBridgeConversationId(value: unknown): string { return bridgeText(value, 'conversationId', CONVERSATION_ID_PATTERN); }
export function normalizeBridgeReason(value: unknown): string { return bridgeText(value, 'reasonRef', REASON_PATTERN, 200); }

/* ------------------------- same-SQLite channel ledger read ------------------ */

export interface BridgedChannelConversation {
  channelRef: string;
  connectionId: string;
  sourceNamespace: string;
  accountId: string;
  nativeConversationId: string;
  threadId?: string;
  mode: ChannelAudienceMode;
  audienceVersion: number;
  audienceStatus: 'pending' | 'current' | 'revoked';
  participantCount: number;
}

/**
 * Trusted same-database read used only to validate a binding request against
 * the authoritative channel ledger. It writes nothing and exposes no message
 * body. A missing ledger (e.g. an event-only store) fails closed.
 */
export function readChannelConversationForBridge(db: DatabaseSync, channelRef: string): BridgedChannelConversation | undefined {
  const ledger = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='shiyu_channel_conversations'").get();
  if (!ledger) channelBridgeFail('CHANNEL_LEDGER_UNAVAILABLE', 'The channel ingress ledger is not installed in this control store');
  const row = db.prepare('SELECT * FROM shiyu_channel_conversations WHERE conversation_ref=?').get(channelRef) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const mode = String(row.mode);
  const audienceStatus = String(row.audience_status);
  const audienceVersion = Number(row.audience_version);
  if (!['direct', 'group', 'channel'].includes(mode) || !['pending', 'current', 'revoked'].includes(audienceStatus)
    || !Number.isSafeInteger(audienceVersion) || audienceVersion < 0) {
    channelBridgeFail('CORRUPT_CHANNEL_LEDGER', 'The channel conversation row is not readable as trusted identity');
  }
  const participants = db.prepare("SELECT COUNT(*) AS n FROM shiyu_channel_audience WHERE conversation_ref=? AND state='active'")
    .get(channelRef) as { n: number };
  return {
    channelRef: String(row.conversation_ref), connectionId: String(row.connection_id), sourceNamespace: String(row.source_namespace),
    accountId: String(row.account_id), nativeConversationId: String(row.native_conversation_id),
    ...(row.thread_id === null || row.thread_id === undefined ? {} : { threadId: String(row.thread_id) }),
    mode: mode as ChannelAudienceMode, audienceVersion, audienceStatus: audienceStatus as BridgedChannelConversation['audienceStatus'],
    participantCount: Number(participants.n),
  };
}

/** Exact mapping to the existing ConversationStore key contract. */
export function channelConversationKey(channel: BridgedChannelConversation, scope: string): ConversationKey {
  return toConversationKey({
    connectionId: channel.connectionId, nativeConversationId: channel.nativeConversationId,
    ...(channel.threadId === undefined ? {} : { threadId: channel.threadId }), mode: channel.mode,
  }, scope);
}

/** Exact mapping from a channel participant view to the existing H4 identity tuple. */
export function channelParticipantAccount(view: Pick<ChannelParticipantView, 'innerAccount'>): InnerAccount {
  return innerAccount(view.innerAccount);
}

/* --------------------------------- contracts -------------------------------- */

export interface ChannelBindingInput {
  channelRef: string;
  scope: string;
  /** Optional explicit existing conversation. Omitted => deterministic conversation for this channel audience. */
  conversationId?: string;
  /** Required for an explicit rebind; the current binding version must match. */
  expectedBindingVersion?: number;
}

export interface ChannelBindingConversationContext {
  /** ConversationStore audience version at read time (stale drafts are detected through it). */
  audienceVersion: number;
  /** ConversationStore record revision at read time. */
  revision: number;
  archived: boolean;
  /** Highest native reply Session epoch across this conversation's reply bindings. */
  replySessionEpoch: number;
}

export interface ChannelConversationBinding {
  channelRef: string;
  conversationId: string;
  scope: string;
  version: number;
  appliedInvalidationWatermark: number;
  createdAt: string;
  updatedAt: string;
  lastInvalidationReason?: string;
  lastInvalidationAt?: string;
  lastInvalidationSourceWatermark?: number;
  conversation: ChannelBindingConversationContext;
}

export interface ChannelInvalidateInput {
  channelRef: string;
  reasonRef: string;
  /** Monotonic channel invalidation watermark being applied; re-applying it is a no-op. */
  sourceWatermark: number;
  /** Optional CAS against the current ConversationStore audience version. */
  expectedConversationAudienceVersion?: number;
}

export interface ChannelInvalidateOutcome {
  binding: ChannelConversationBinding;
  applied: boolean;
}

export interface ChannelBridgePendingInput { afterWatermark?: number; limit?: number }
export interface ChannelBridgePendingOutcome {
  fromWatermark: number;
  toWatermark: number;
  scanned: number;
  applied: number;
  skippedUnbound: number;
  /** Host must re-scan when the bounded page is full. */
  truncated: boolean;
}

/** Read-only projection intended for `runtime.snapshot()`; plain JSON, no bodies, no authority. */
export interface ChannelRuntimeProjection {
  schemaVersion: 1;
  source: 'channel-ingress';
  capturedAt: string;
  status: { ready: boolean; schemaVersion: number; errorCode?: string };
  watermark: ChannelWatermark;
  bindings: Array<Pick<ChannelConversationBinding, 'channelRef' | 'conversationId' | 'scope' | 'version'
    | 'appliedInvalidationWatermark' | 'lastInvalidationAt'> & { conversationAudienceVersion: number; replySessionEpoch: number }>;
  connections: Array<Pick<ChannelConnectionView, 'connectionId' | 'sourceNamespace' | 'revision'> & {
    provider: string; deployment: string; accountId: string;
  }>;
  conversations: Array<Pick<ChannelConversationView, 'conversationRef' | 'connectionId' | 'mode' | 'audienceVersion' | 'audienceStatus'>
    & { participantCount: number; nativeConversationId: string; threadId?: string }>;
  pending: { invalidationWatermark: number; appliedThrough: number; unapplied: number; unbound: number; truncated: boolean };
  degraded: string[];
}

export const EMPTY_CHANNEL_WATERMARK: ChannelWatermark = Object.freeze({
  intakeSeq: 0, invalidationWatermark: 0, deletionWatermark: 0, revocationWatermark: 0,
});

/* ------------------------------ host-side bridge ---------------------------- */

/**
 * Host-side trusted coordinator. All writes go through the existing Worker
 * command surface (`conversation.channelBind`, `conversation.channelInvalidate`)
 * so the durable binding and the ConversationStore change share one SQLite
 * transaction. Read paths never write.
 */
export class ChannelRuntimeBridge {
  constructor(private readonly store: Pick<ControlStore, 'request'>, private readonly options: { now?: () => Date } = {}) {}
  private nowISO(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  /** Idempotent binding/rebind; a stale `expectedBindingVersion` never overwrites a newer binding. */
  async bind(input: ChannelBindingInput): Promise<ChannelConversationBinding & { duplicate: boolean }> {
    return this.store.request('conversation.channelBind', {
      channelRef: input.channelRef, scope: input.scope,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.expectedBindingVersion === undefined ? {} : { expectedBindingVersion: input.expectedBindingVersion }),
    });
  }

  async bindings(input: { channelRef?: string; conversationId?: string } = {}): Promise<ChannelConversationBinding[]> {
    return this.store.request('conversation.channelBindings', {
      ...(input.channelRef === undefined ? {} : { channelRef: input.channelRef }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    });
  }

  /** Applies one channel invalidation watermark to the bound conversation audience. */
  async invalidate(input: ChannelInvalidateInput): Promise<ChannelInvalidateOutcome> {
    return this.store.request('conversation.channelInvalidate', {
      channelRef: input.channelRef, reasonRef: input.reasonRef, sourceWatermark: input.sourceWatermark,
      ...(input.expectedConversationAudienceVersion === undefined ? {} : { expectedConversationAudienceVersion: input.expectedConversationAudienceVersion }),
    });
  }

  /**
   * Pull path for `channel.invalidationsAfter`: applies every still-pending
   * invalidation of a bound channel to its conversation audience. Idempotent by
   * the binding's applied watermark, so a crash between two pages or a host
   * restart never amplifies a stale audience change into a second fact.
   */
  async bridgePending(input: ChannelBridgePendingInput = {}): Promise<ChannelBridgePendingOutcome> {
    const bindings = await this.bindings();
    const bound = new Set(bindings.map(binding => binding.channelRef));
    const appliedThrough = bindings.length ? Math.min(...bindings.map(binding => binding.appliedInvalidationWatermark)) : 0;
    const fromWatermark = Math.max(input.afterWatermark ?? 0, appliedThrough);
    const limit = input.limit ?? CHANNEL_PROJECTION_INVALIDATION_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHANNEL_PROJECTION_INVALIDATION_LIMIT) {
      channelBridgeFail('INVALID_SCHEMA', 'Invalid bounded bridge pending limit');
    }
    const rows = await this.store.request('channel.invalidationsAfter', { afterWatermark: fromWatermark, limit });
    let applied = 0, skippedUnbound = 0;
    let toWatermark = fromWatermark;
    for (const row of rows) {
      toWatermark = Math.max(toWatermark, row.watermark);
      if (!bound.has(row.conversationRef)) { skippedUnbound++; continue; }
      const outcome = await this.invalidate({ channelRef: row.conversationRef,
        reasonRef: channelBridgeReason(row), sourceWatermark: row.watermark });
      if (outcome.applied) applied++;
    }
    return { fromWatermark, toWatermark, scanned: rows.length, applied, skippedUnbound,
      truncated: rows.length === limit && rows.length > 0 };
  }

  /** Same mapping the Worker uses; exposed for host code that needs the exact key. */
  conversationKey(channel: ChannelSnapshot['conversations'][number], scope: string): ConversationKey {
    return toConversationKey({ connectionId: channel.connectionId, nativeConversationId: channel.nativeConversationId,
      ...(channel.threadId === undefined ? {} : { threadId: channel.threadId }), mode: channel.mode }, scope);
  }

  /** Trusted InnerAccount tuple for a channel participant (read-only). */
  async participantAccount(participantRef: string): Promise<InnerAccount> {
    const participant = await this.store.request('channel.getParticipant', { participantRef });
    return channelParticipantAccount(participant);
  }

  /** Registers the channel participant as a stable H4 relationship subject; same tuple is idempotent. */
  async registerParticipantSubject(participantRef: string, input: { requestId: string; entityKind: RelationshipEntityKind; displayName: string }) {
    const account = await this.participantAccount(participantRef);
    const result = await this.store.request('relationship.registerSubject', {
      requestId: input.requestId, account, entityKind: input.entityKind, displayName: input.displayName,
    });
    return { ...result, account };
  }

  /**
   * One bounded read-only projection for `runtime.snapshot()`/dashboard.
   * It reports bridge availability, watermarks and pending invalidations; it is
   * never a permission grant and never exposes message bodies or participant
   * display text.
   */
  async snapshot(input: { connectionLimit?: number; conversationLimit?: number; bindingLimit?: number } = {}): Promise<ChannelRuntimeProjection> {
    const connectionLimit = projectionLimit(input.connectionLimit, 'connectionLimit');
    const conversationLimit = projectionLimit(input.conversationLimit, 'conversationLimit');
    const bindingLimit = projectionLimit(input.bindingLimit, 'bindingLimit');
    const status = await this.store.request('channel.status', {});
    const capturedAt = this.nowISO();
    if (!status.ready) {
      return {
        schemaVersion: 1, source: 'channel-ingress', capturedAt,
        status: { ready: false, schemaVersion: status.schemaVersion, ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }) },
        watermark: { ...EMPTY_CHANNEL_WATERMARK }, bindings: [], connections: [], conversations: [],
        pending: { invalidationWatermark: 0, appliedThrough: 0, unapplied: 0, unbound: 0, truncated: false },
        degraded: ['channel_ingress_unavailable'],
      };
    }
    const channelSnapshot = await this.store.request('channel.snapshot', {});
    const degraded: string[] = [];
    let bindings: ChannelConversationBinding[] = [];
    try { bindings = await this.bindings(); }
    catch (error) {
      degraded.push(errorCode(error) === 'CONVERSATIONS_UNAVAILABLE' ? 'conversation_domain_unavailable' : 'channel_binding_unavailable');
    }
    const appliedThrough = bindings.length ? Math.min(...bindings.map(binding => binding.appliedInvalidationWatermark)) : 0;
    let pendingRows: ChannelInvalidation[] = [];
    try {
      pendingRows = await this.store.request('channel.invalidationsAfter', { afterWatermark: appliedThrough, limit: CHANNEL_PROJECTION_INVALIDATION_LIMIT });
    } catch { degraded.push('channel_invalidations_unavailable'); }
    const boundRefs = new Set(bindings.map(binding => binding.channelRef));
    const unbound = pendingRows.filter(row => !boundRefs.has(row.conversationRef)).length;
    const projection: ChannelRuntimeProjection = {
      schemaVersion: 1, source: 'channel-ingress', capturedAt,
      status: { ready: true, schemaVersion: status.schemaVersion },
      watermark: { ...channelSnapshot.watermark },
      bindings: bindings.slice(0, bindingLimit).map(binding => ({
        channelRef: binding.channelRef, conversationId: binding.conversationId, scope: binding.scope, version: binding.version,
        appliedInvalidationWatermark: binding.appliedInvalidationWatermark,
        conversationAudienceVersion: binding.conversation.audienceVersion,
        replySessionEpoch: binding.conversation.replySessionEpoch,
        ...(binding.lastInvalidationAt === undefined ? {} : { lastInvalidationAt: binding.lastInvalidationAt }),
      })),
      connections: channelSnapshot.connections.slice(0, connectionLimit).map(connection => ({
        connectionId: connection.connectionId, sourceNamespace: connection.sourceNamespace, revision: connection.revision,
        provider: connection.platform.provider, deployment: connection.platform.deployment, accountId: connection.account.accountId,
      })),
      conversations: channelSnapshot.conversations.slice(0, conversationLimit).map(conversation => ({
        conversationRef: conversation.conversationRef, connectionId: conversation.connectionId, mode: conversation.mode,
        audienceVersion: conversation.audienceVersion, audienceStatus: conversation.audienceStatus,
        participantCount: conversation.participants.length, nativeConversationId: conversation.nativeConversationId,
        ...(conversation.threadId === undefined ? {} : { threadId: conversation.threadId }),
      })),
      pending: {
        invalidationWatermark: channelSnapshot.watermark.invalidationWatermark, appliedThrough,
        unapplied: pendingRows.length, unbound,
        truncated: pendingRows.length === CHANNEL_PROJECTION_INVALIDATION_LIMIT,
      },
      degraded,
    };
    return projection;
  }
}

function projectionLimit(value: unknown, label: string): number {
  if (value === undefined) return CHANNEL_PROJECTION_LIMIT;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 200) channelBridgeFail('INVALID_SCHEMA', `Invalid ${label}`);
  return Number(value);
}
function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
}
/** Deterministic reason reference; the invalidation watermark is part of the identity. */
export function channelBridgeReason(invalidation: Pick<ChannelInvalidation, 'type' | 'watermark'>): string {
  return `channel-bridge:${invalidation.type}:${invalidation.watermark}`;
}
