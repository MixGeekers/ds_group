import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction } from 'node:util/types';
import type {
  ChannelAudienceChange, ChannelAudienceParticipant, ChannelAudienceRevocation, ChannelCommands, ChannelContentReadResult,
  ChannelConversationView, ChannelDeletion, ChannelDomainRequest, ChannelIngestResult, ChannelIntakeReceipt, ChannelInvalidation,
  ChannelInvalidationSignal, ChannelMessageMetadata, ChannelMessageStatus, ChannelParticipantInput, ChannelParticipantView,
  ChannelRevocation,
  ChannelSnapshot, ChannelWatermark,
} from '../../contracts/channel.js';
import {
  capabilityForKind, channelRef, conversationRefFor, ingressCanonical, ingressFail,
  ingressFields, messageIdFor, normalizeChannelLimits, normalizeConnection, normalizeConversationInput, normalizeInboundEvent,
  normalizeParticipantInput, normalizeReasonRef, participantRefFor, revisionDecision, toInnerAccount,
  type ChannelIngressLimits, type ChannelMessageState, type NormalizedConnection, type NormalizedInboundEvent,
} from '../../control/ingress/index.js';
import type { SqliteTransactions } from './transaction.js';

type Row = Record<string, unknown>;
const SCHEMA_VERSION = 1;
const fail = ingressFail;
const integer = (value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail('INVALID_SCHEMA', `Invalid ${label}`);
  return Number(value);
};

export interface IngressDomainOptions {
  now?: () => Date;
  /** Trusted same-Worker invalidation sink (synchronous, no external I/O).
   * A throw here rolls the audience change/deletion back with its signal. */
  onInvalidation?: (signal: ChannelInvalidationSignal) => void;
  limits?: Partial<ChannelIngressLimits>;
}

interface Meta { schemaVersion: number; intakeSeq: number; invalidationWatermark: number; deletionWatermark: number; revocationWatermark: number }
type Counter = 'intake_seq' | 'invalidation_watermark' | 'deletion_watermark' | 'revocation_watermark';

/**
 * Durable generic channel-ingress ledger (H6a, offline).
 *
 * Owns normalized channel/account/conversation/thread/message/revision identity,
 * monotonic intake dedupe, audience versions, deletion/revocation watermarks and
 * a metadata-only two-phase content exposure gate. It shares the one control
 * SQLite connection/transaction owner with the rest of the control store and
 * exposes only named IPC commands; it stores no body text, no native Session
 * history, no send queue and no second chat record.
 */
export class IngressDomain {
  private readonly options: IngressDomainOptions;
  private readonly limits: ChannelIngressLimits;
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, options: IngressDomainOptions = {}) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Channel ingress requires the shared control connection');
    if (options === null || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_CONFIG', 'Invalid ingress options');
    if (Object.keys(options).some(key => !['now', 'onInvalidation', 'limits'].includes(key))) fail('INVALID_CONFIG', 'Unknown ingress option');
    if (options.now !== undefined && (typeof options.now !== 'function' || isAsyncFunction(options.now))) fail('INVALID_CONFIG', 'Invalid ingress clock');
    if (options.onInvalidation !== undefined && (typeof options.onInvalidation !== 'function' || isAsyncFunction(options.onInvalidation))) {
      fail('INVALID_CONFIG', 'The ingress invalidation sink must be a synchronous callback');
    }
    this.options = { ...(options.now ? { now: options.now } : {}), ...(options.onInvalidation ? { onInvalidation: options.onInvalidation } : {}) };
    this.limits = normalizeChannelLimits(options.limits);
    this.tx.atomic(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shiyu_channel_meta(
          id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,
          intake_seq INTEGER NOT NULL,invalidation_watermark INTEGER NOT NULL,deletion_watermark INTEGER NOT NULL,revocation_watermark INTEGER NOT NULL,
          baseline_id TEXT NOT NULL,installed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_channel_connections(
          connection_id TEXT PRIMARY KEY,source_namespace TEXT NOT NULL,platform_provider TEXT NOT NULL,platform_deployment TEXT NOT NULL,
          account_id TEXT NOT NULL,account_native_id TEXT NOT NULL,account_kind TEXT NOT NULL,capabilities_json TEXT NOT NULL,
          revision INTEGER NOT NULL,registered_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_channel_participants(
          source_namespace TEXT NOT NULL,account_id TEXT NOT NULL,native_participant_id TEXT NOT NULL,participant_ref TEXT NOT NULL UNIQUE,
          connection_id TEXT NOT NULL,kind TEXT NOT NULL,first_seen_at TEXT NOT NULL,PRIMARY KEY(source_namespace,account_id,native_participant_id));
        CREATE TABLE IF NOT EXISTS shiyu_channel_conversations(
          conversation_ref TEXT PRIMARY KEY,connection_id TEXT NOT NULL,source_namespace TEXT NOT NULL,account_id TEXT NOT NULL,
          native_conversation_id TEXT NOT NULL,thread_id TEXT,mode TEXT NOT NULL,
          audience_version INTEGER NOT NULL,audience_status TEXT NOT NULL,last_audience_reason TEXT,last_audience_at TEXT,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_channel_audience(
          conversation_ref TEXT NOT NULL,participant_ref TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
          added_version INTEGER NOT NULL,revoked_version INTEGER,revoked_watermark INTEGER,revocation_reason TEXT,revoked_at TEXT,
          PRIMARY KEY(conversation_ref,participant_ref));
        CREATE TABLE IF NOT EXISTS shiyu_channel_messages(
          message_id TEXT PRIMARY KEY,conversation_ref TEXT NOT NULL,source_namespace TEXT NOT NULL,account_id TEXT NOT NULL,
          participant_ref TEXT NOT NULL,participant_kind TEXT NOT NULL,privacy_class TEXT NOT NULL,native_message_id TEXT NOT NULL,
          status TEXT NOT NULL,last_kind TEXT NOT NULL,native_revision INTEGER NOT NULL,revision INTEGER NOT NULL,
          content_hash TEXT,body_ref TEXT,summary TEXT,attachments_json TEXT NOT NULL,attachment_count INTEGER NOT NULL,
          deletion_kind TEXT,deletion_watermark INTEGER,deletion_reason TEXT,deleted_at TEXT,
          occurred_at TEXT NOT NULL,first_received_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_intake_seq INTEGER NOT NULL,
          last_sequence INTEGER);
        CREATE INDEX IF NOT EXISTS shiyu_channel_messages_conversation ON shiyu_channel_messages(conversation_ref,last_intake_seq);
        CREATE TABLE IF NOT EXISTS shiyu_channel_revisions(
          revision_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,native_revision INTEGER NOT NULL,
          source_event_id TEXT NOT NULL,participant_ref TEXT NOT NULL,privacy_class TEXT NOT NULL,
          content_hash TEXT,body_ref TEXT,summary TEXT,attachments_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,source_sequence INTEGER,UNIQUE(message_id,revision));
        CREATE INDEX IF NOT EXISTS shiyu_channel_revisions_message ON shiyu_channel_revisions(message_id,revision);
        CREATE TABLE IF NOT EXISTS shiyu_channel_intake(
          source_namespace TEXT NOT NULL,account_id TEXT NOT NULL,conversation_ref TEXT NOT NULL,source_event_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,status TEXT NOT NULL,reason_code TEXT,native_event_id TEXT,message_id TEXT,
          intake_seq INTEGER NOT NULL UNIQUE,received_at TEXT NOT NULL,receipt_json TEXT NOT NULL,
          PRIMARY KEY(source_namespace,account_id,conversation_ref,source_event_id));
        CREATE TABLE IF NOT EXISTS shiyu_channel_intake_conflicts(
          source_namespace TEXT NOT NULL,account_id TEXT NOT NULL,conversation_ref TEXT NOT NULL,source_event_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,intake_seq INTEGER NOT NULL,received_at TEXT NOT NULL,
          PRIMARY KEY(source_namespace,account_id,conversation_ref,source_event_id,fingerprint));
        CREATE TABLE IF NOT EXISTS shiyu_channel_invalidations(
          watermark INTEGER PRIMARY KEY,type TEXT NOT NULL,conversation_ref TEXT NOT NULL,connection_id TEXT NOT NULL,
          audience_version INTEGER NOT NULL,message_id TEXT,participant_ref TEXT,reason_ref TEXT NOT NULL,at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_channel_deletions(
          watermark INTEGER PRIMARY KEY,conversation_ref TEXT NOT NULL,message_id TEXT NOT NULL,message_revision INTEGER NOT NULL,
          native_revision INTEGER NOT NULL,kind TEXT NOT NULL,reason_ref TEXT,source_event_id TEXT NOT NULL,at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_channel_revocations(
          watermark INTEGER PRIMARY KEY,conversation_ref TEXT NOT NULL,participant_ref TEXT,scope TEXT NOT NULL,
          audience_version INTEGER NOT NULL,reason_ref TEXT NOT NULL,at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_channel_captures(
          capture_id TEXT PRIMARY KEY,conversation_ref TEXT NOT NULL,connection_id TEXT NOT NULL,audience_version INTEGER NOT NULL,
          intake_seq INTEGER NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,record_json TEXT NOT NULL);
      `);
      this.db.prepare(`INSERT OR IGNORE INTO shiyu_channel_meta
        (id,schema_version,intake_seq,invalidation_watermark,deletion_watermark,revocation_watermark,baseline_id,installed_at)
        VALUES(1,?,0,0,0,0,?,?)`).run(SCHEMA_VERSION, randomUUID(), new Date(this.nowMs()).toISOString());
      this.meta();
    });
  }

  private nowMs(): number { return (this.options.now?.() ?? new Date()).getTime(); }
  private nowISO(): string { return new Date(this.nowMs()).toISOString(); }
  private assertUsable(): void { this.tx.assertUsable(); }
  private one(sql: string, ...args: (string | number | null)[]): Row | undefined {
    this.assertUsable();
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    this.assertUsable();
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private run(sql: string, ...args: (string | number | null)[]): void {
    this.assertUsable();
    this.db.prepare(sql).run(...args);
  }
  private meta(): Meta {
    const row = this.one('SELECT * FROM shiyu_channel_meta WHERE id=1') ?? fail('CORRUPT_CHANNEL_STORE', 'Channel ingress metadata is missing');
    const meta: Meta = {
      schemaVersion: Number(row.schema_version), intakeSeq: Number(row.intake_seq),
      invalidationWatermark: Number(row.invalidation_watermark), deletionWatermark: Number(row.deletion_watermark),
      revocationWatermark: Number(row.revocation_watermark),
    };
    if (meta.schemaVersion !== SCHEMA_VERSION) fail('INCOMPATIBLE_VERSION', 'Unsupported channel ingress schema version');
    for (const [key, value] of Object.entries(meta)) {
      if (key !== 'schemaVersion' && (!Number.isSafeInteger(value) || value < 0)) fail('CORRUPT_CHANNEL_STORE', 'Invalid channel watermark');
    }
    return meta;
  }
  private bump(column: Counter): number {
    const meta = this.meta();
    const current = column === 'intake_seq' ? meta.intakeSeq : column === 'invalidation_watermark' ? meta.invalidationWatermark
      : column === 'deletion_watermark' ? meta.deletionWatermark : meta.revocationWatermark;
    if (current >= Number.MAX_SAFE_INTEGER) fail('VERSION_EXHAUSTED', 'Channel watermark exhausted');
    this.run(`UPDATE shiyu_channel_meta SET ${column}=? WHERE id=1`, current + 1);
    return current + 1;
  }
  private emit(signal: ChannelInvalidationSignal): void {
    // Deliberately the last step of the same transaction: a sink throw rolls the
    // acceptance and its invalidation ledger back together.
    if (this.options.onInvalidation) this.options.onInvalidation(signal);
  }
  private cas(expected: unknown, actual: number, label = 'expectedAudienceVersion'): void {
    integer(expected, label, 0);
    if (expected !== actual) fail('VERSION_CONFLICT', 'Audience version changed; read the current version');
  }

  /* ------------------------------- connections ------------------------------ */

  private connectionRow(connectionId: string): Row {
    return this.one('SELECT * FROM shiyu_channel_connections WHERE connection_id=?', connectionId)
      ?? fail('UNKNOWN_CONNECTION', 'No trusted adapter registration has this connection identity');
  }
  private connectionFromRow(row: Row): NormalizedConnection {
    return {
      connectionId: String(row.connection_id), sourceNamespace: String(row.source_namespace),
      platform: { provider: String(row.platform_provider), deployment: String(row.platform_deployment) },
      account: { accountId: String(row.account_id), nativeAccountId: String(row.account_native_id), kind: String(row.account_kind) as NormalizedConnection['account']['kind'] },
      capabilities: JSON.parse(String(row.capabilities_json)) as NormalizedConnection['capabilities'],
    };
  }
  private connectionView(connection: NormalizedConnection, row: Row): ChannelCommands['channel.registerConnection']['output'] {
    return {
      connectionId: connection.connectionId, sourceNamespace: connection.sourceNamespace, platform: { ...connection.platform },
      account: { ...connection.account }, capabilities: { ...connection.capabilities },
      revision: Number(row.revision), registeredAt: String(row.registered_at), updatedAt: String(row.updated_at), duplicate: true,
    };
  }
  registerConnection(input: ChannelCommands['channel.registerConnection']['input']): ChannelCommands['channel.registerConnection']['output'] {
    const normalized = normalizeConnection(input);
    return this.tx.atomic(() => {
      const existing = this.one('SELECT * FROM shiyu_channel_connections WHERE connection_id=?', normalized.connectionId);
      const now = this.nowISO();
      if (!existing) {
        if (Number(this.one('SELECT COUNT(*) AS n FROM shiyu_channel_connections')!.n) >= this.limits.maxConnections) {
          fail('CHANNEL_CAPACITY', 'Trusted channel connection capacity reached');
        }
        this.run(`INSERT INTO shiyu_channel_connections
          (connection_id,source_namespace,platform_provider,platform_deployment,account_id,account_native_id,account_kind,capabilities_json,revision,registered_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,1,?,?)`, normalized.connectionId, normalized.sourceNamespace, normalized.platform.provider,
          normalized.platform.deployment, normalized.account.accountId, normalized.account.nativeAccountId, normalized.account.kind,
          ingressCanonical(normalized.capabilities), now, now);
        const view = this.connectionView(normalized, this.connectionRow(normalized.connectionId));
        return { ...view, duplicate: false };
      }
      const persisted = this.connectionFromRow(existing);
      for (const field of ['sourceNamespace', 'platform', 'account'] as const) {
        if (ingressCanonical(persisted[field]) !== ingressCanonical(normalized[field])) fail('IDENTITY_CONFLICT', 'Persisted trusted connection identity differs');
      }
      if (ingressCanonical(persisted.capabilities) !== ingressCanonical(normalized.capabilities)) {
        this.run('UPDATE shiyu_channel_connections SET capabilities_json=?,revision=revision+1,updated_at=? WHERE connection_id=?',
          ingressCanonical(normalized.capabilities), now, normalized.connectionId);
      }
      return { ...this.connectionView(normalized, this.connectionRow(normalized.connectionId)), duplicate: true };
    });
  }

  /* ------------------------------ conversations ----------------------------- */

  private conversationRow(conversationRef: string): Row | undefined {
    return this.one('SELECT * FROM shiyu_channel_conversations WHERE conversation_ref=?', conversationRef);
  }
  private requireConversation(conversationRef: string): Row {
    return this.conversationRow(conversationRef) ?? fail('UNKNOWN_CONVERSATION', 'No channel conversation has this identity');
  }
  private conversationView(row: Row): ChannelConversationView {
    const conversationRef = String(row.conversation_ref);
    const audience = this.all('SELECT * FROM shiyu_channel_audience WHERE conversation_ref=? ORDER BY participant_ref', conversationRef);
    const participants: ChannelAudienceParticipant[] = [];
    const revokedParticipants: ChannelAudienceRevocation[] = [];
    for (const member of audience) {
      if (String(member.state) === 'active') {
        participants.push({ participantRef: String(member.participant_ref), kind: String(member.kind) as ChannelAudienceParticipant['kind'], addedVersion: Number(member.added_version) });
      } else {
        revokedParticipants.push({ participantRef: String(member.participant_ref), version: Number(member.revoked_version),
          watermark: Number(member.revoked_watermark), reasonRef: String(member.revocation_reason), at: String(member.revoked_at) });
      }
    }
    return {
      conversationRef, connectionId: String(row.connection_id), sourceNamespace: String(row.source_namespace), accountId: String(row.account_id),
      nativeConversationId: String(row.native_conversation_id),
      ...(row.thread_id === null || row.thread_id === undefined ? {} : { threadId: String(row.thread_id) }),
      mode: String(row.mode) as ChannelConversationView['mode'],
      audienceVersion: Number(row.audience_version), audienceStatus: String(row.audience_status) as ChannelConversationView['audienceStatus'],
      participants, revokedParticipants, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      ...(row.last_audience_reason === null || row.last_audience_reason === undefined ? {} : {
        lastAudienceChange: { audienceVersion: Number(row.audience_version), reasonRef: String(row.last_audience_reason), at: String(row.last_audience_at) },
      }),
    };
  }
  private createConversationRow(connection: NormalizedConnection, conversationRef: string, conversation: ReturnType<typeof normalizeConversationInput>, now: string): void {
    if (Number(this.one('SELECT COUNT(*) AS n FROM shiyu_channel_conversations')!.n) >= this.limits.maxConversations) {
      fail('CHANNEL_CAPACITY', 'Channel conversation capacity reached');
    }
    this.run(`INSERT INTO shiyu_channel_conversations
      (conversation_ref,connection_id,source_namespace,account_id,native_conversation_id,thread_id,mode,audience_version,audience_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,0,'pending',?,?)`,
    conversationRef, connection.connectionId, connection.sourceNamespace, connection.account.accountId,
    conversation.nativeConversationId, conversation.threadId ?? null, conversation.mode, now, now);
  }
  ensureConversation(input: ChannelCommands['channel.ensureConversation']['input']): ChannelCommands['channel.ensureConversation']['output'] {
    ingressFields(input, ['connectionId', 'conversation', 'reasonRef']);
    const connectionId = channelRef(input.connectionId, 'connection');
    const conversation = normalizeConversationInput(input.conversation);
    normalizeReasonRef(input.reasonRef);
    return this.tx.atomic(() => {
      const connection = this.connectionFromRow(this.connectionRow(connectionId));
      const conversationRef = conversationRefFor(connection.connectionId, conversation);
      const existing = this.conversationRow(conversationRef);
      if (existing) return { ...this.conversationView(existing), created: false };
      this.createConversationRow(connection, conversationRef, conversation, this.nowISO());
      return { ...this.conversationView(this.conversationRow(conversationRef)!), created: true };
    });
  }

  /* -------------------------------- audience -------------------------------- */

  private participantRow(connection: NormalizedConnection, nativeParticipantId: string): Row | undefined {
    return this.one('SELECT * FROM shiyu_channel_participants WHERE source_namespace=? AND account_id=? AND native_participant_id=?',
      connection.sourceNamespace, connection.account.accountId, nativeParticipantId);
  }
  private ensureParticipant(connection: NormalizedConnection, participant: ChannelParticipantInput): string {
    const participantRef = participantRefFor(connection, participant);
    const existing = this.participantRow(connection, participant.nativeParticipantId);
    if (!existing) {
      this.run(`INSERT INTO shiyu_channel_participants
        (source_namespace,account_id,native_participant_id,participant_ref,connection_id,kind,first_seen_at) VALUES(?,?,?,?,?,?,?)`,
      connection.sourceNamespace, connection.account.accountId, participant.nativeParticipantId, participantRef,
      connection.connectionId, participant.kind, this.nowISO());
      return participantRef;
    }
    if (String(existing.kind) !== participant.kind) fail('PARTICIPANT_KIND_CONFLICT', 'A participant kind cannot change after it was trusted');
    if (String(existing.participant_ref) !== participantRef) fail('CORRUPT_CHANNEL_STORE', 'Persisted participant identity differs');
    return participantRef;
  }
  private audienceRows(conversationRef: string): Row[] {
    return this.all('SELECT * FROM shiyu_channel_audience WHERE conversation_ref=? ORDER BY participant_ref', conversationRef);
  }
  private writeInvalidation(input: Omit<ChannelInvalidation, 'watermark' | 'at'>): ChannelInvalidationSignal {
    const watermark = this.bump('invalidation_watermark');
    const at = this.nowISO();
    const invalidation: ChannelInvalidation = { ...input, watermark, at };
    this.run(`INSERT INTO shiyu_channel_invalidations
      (watermark,type,conversation_ref,connection_id,audience_version,message_id,participant_ref,reason_ref,at) VALUES(?,?,?,?,?,?,?,?,?)`,
    watermark, invalidation.type, invalidation.conversationRef, invalidation.connectionId, invalidation.audienceVersion,
    invalidation.messageId ?? null, invalidation.participantRef ?? null, invalidation.reasonRef, at);
    return { ...invalidation, removedParticipants: [] };
  }
  updateAudience(input: ChannelCommands['channel.updateAudience']['input']): ChannelCommands['channel.updateAudience']['output'] {
    ingressFields(input, ['conversationRef', 'participants', 'reasonRef', 'expectedAudienceVersion']);
    const conversationRef = channelRef(input.conversationRef, 'conversation');
    const reasonRef = normalizeReasonRef(input.reasonRef);
    integer(input.expectedAudienceVersion, 'expectedAudienceVersion', 0);
    if (!Array.isArray(input.participants) || input.participants.length > this.limits.maxParticipantsPerConversation) {
      fail('INVALID_SCHEMA', 'Bounded audience participants are required');
    }
    const participants = input.participants.map(normalizeParticipantInput);
    return this.tx.atomic(() => {
      const row = this.requireConversation(conversationRef);
      if (String(row.audience_status) === 'revoked') fail('CONVERSATION_REVOKED', 'This conversation audience was revoked');
      const currentVersion = Number(row.audience_version);
      this.cas(input.expectedAudienceVersion, currentVersion);
      const connection = this.connectionFromRow(this.connectionRow(String(row.connection_id)));
      const mode = String(row.mode) as ChannelConversationView['mode'];
      const refs = participants.map(participant => participantRefFor(connection, participant));
      if (new Set(refs).size !== refs.length) fail('INVALID_SCHEMA', 'Duplicate participant identity in audience');
      const rows = this.audienceRows(conversationRef);
      const active = new Map(rows.filter(member => String(member.state) === 'active').map(member => [String(member.participant_ref), member]));
      const revokedRefs = new Set(rows.filter(member => String(member.state) === 'revoked').map(member => String(member.participant_ref)));
      const desired = new Set(refs);
      if (mode === 'direct') {
        // A DM has one counterpart participant, fixed for the lifetime of the
        // conversation. Replacing it would be a different audience, not an edit.
        if (rows.length === 0) {
          if (desired.size !== 1) fail('AUDIENCE_MODE_CONFLICT', 'A direct conversation has exactly one counterpart participant');
        } else {
          const current = [...active.keys()].sort();
          const next = [...desired].sort();
          if (current.length !== next.length || current.some((value, index) => value !== next[index])) {
            fail('AUDIENCE_MODE_CONFLICT', 'A direct counterpart cannot be replaced; revoke access first');
          }
        }
      }
      for (const participantRef of desired) {
        if (revokedRefs.has(participantRef)) fail('PARTICIPANT_REVOKED', 'A revoked participant cannot be re-added to this audience');
        this.ensureParticipant(connection, participants[refs.indexOf(participantRef)]!);
      }
      const added = refs.filter(participantRef => !active.has(participantRef)).sort();
      const removed = [...active.keys()].filter(participantRef => !desired.has(participantRef)).sort();
      if (!added.length && !removed.length) return { conversation: this.conversationView(this.conversationRow(conversationRef)!) };
      if (currentVersion >= Number.MAX_SAFE_INTEGER) fail('VERSION_EXHAUSTED', 'Audience version exhausted');
      const version = currentVersion + 1;
      const now = this.nowISO();
      const kindOf = new Map(refs.map((participantRef, index) => [participantRef, participants[index]!.kind]));
      for (const participantRef of added) {
        this.run(`INSERT INTO shiyu_channel_audience(conversation_ref,participant_ref,kind,state,added_version)
          VALUES(?,?,?,'active',?) ON CONFLICT(conversation_ref,participant_ref) DO UPDATE SET state='active',kind=excluded.kind,added_version=excluded.added_version`,
        conversationRef, participantRef, kindOf.get(participantRef)!, version);
      }
      for (const participantRef of removed) {
        const watermark = this.bump('revocation_watermark');
        this.run(`UPDATE shiyu_channel_audience SET state='revoked',revoked_version=?,revoked_watermark=?,revocation_reason=?,revoked_at=?
          WHERE conversation_ref=? AND participant_ref=?`, version, watermark, reasonRef, now, conversationRef, participantRef);
        this.run('INSERT INTO shiyu_channel_revocations(watermark,conversation_ref,participant_ref,scope,audience_version,reason_ref,at) VALUES(?,?,?,?,?,?,?)',
          watermark, conversationRef, participantRef, 'participant', version, reasonRef, now);
      }
      this.run(`UPDATE shiyu_channel_conversations SET audience_version=?,audience_status='current',last_audience_reason=?,last_audience_at=?,updated_at=?
        WHERE conversation_ref=?`, version, reasonRef, now, now, conversationRef);
      const signal = this.writeInvalidation({ type: 'audience_changed', conversationRef, connectionId: connection.connectionId,
        audienceVersion: version, reasonRef });
      signal.removedParticipants = removed;
      this.emit(signal);
      const change: ChannelAudienceChange = {
        conversationRef, previousVersion: currentVersion, audienceVersion: version,
        previousStatus: String(row.audience_status) as ChannelAudienceChange['previousStatus'], mode,
        added, removed, reasonRef, invalidationWatermark: signal.watermark, at: now,
      };
      return { conversation: this.conversationView(this.conversationRow(conversationRef)!), change };
    });
  }
  revokeAccess(input: ChannelCommands['channel.revokeAccess']['input']): ChannelCommands['channel.revokeAccess']['output'] {
    ingressFields(input, ['conversationRef', 'scope', 'participantRef', 'reasonRef', 'expectedAudienceVersion'],
      ['conversationRef', 'scope', 'reasonRef', 'expectedAudienceVersion']);
    const conversationRef = channelRef(input.conversationRef, 'conversation');
    const reasonRef = normalizeReasonRef(input.reasonRef);
    if (!['participant', 'conversation'].includes(input.scope)) fail('INVALID_SCHEMA', 'Invalid revocation scope');
    const participantRef = input.scope === 'participant' ? channelRef(input.participantRef, 'participant') : undefined;
    if (input.scope === 'conversation' && input.participantRef !== undefined) fail('INVALID_SCHEMA', 'Conversation revocation takes no participant');
    integer(input.expectedAudienceVersion, 'expectedAudienceVersion', 0);
    return this.tx.atomic(() => {
      const row = this.requireConversation(conversationRef);
      if (String(row.audience_status) === 'revoked') fail('CONVERSATION_REVOKED', 'This conversation audience was already revoked');
      const currentVersion = Number(row.audience_version);
      this.cas(input.expectedAudienceVersion, currentVersion);
      if (currentVersion >= Number.MAX_SAFE_INTEGER) fail('VERSION_EXHAUSTED', 'Audience version exhausted');
      const connectionId = String(row.connection_id);
      const now = this.nowISO();
      const version = currentVersion + 1;
      if (participantRef !== undefined) {
        const member = this.one('SELECT * FROM shiyu_channel_audience WHERE conversation_ref=? AND participant_ref=?', conversationRef, participantRef);
        if (!member || String(member.state) !== 'active') fail('PARTICIPANT_NOT_IN_AUDIENCE', 'Only an active participant can be revoked');
      }
      const watermark = this.bump('revocation_watermark');
      if (participantRef !== undefined) {
        this.run(`UPDATE shiyu_channel_audience SET state='revoked',revoked_version=?,revoked_watermark=?,revocation_reason=?,revoked_at=?
          WHERE conversation_ref=? AND participant_ref=?`, version, watermark, reasonRef, now, conversationRef, participantRef);
      }
      const revocation: ChannelRevocation = {
        watermark, conversationRef, ...(participantRef === undefined ? {} : { participantRef }),
        scope: input.scope, audienceVersion: version, reasonRef, at: now,
      };
      this.run('INSERT INTO shiyu_channel_revocations(watermark,conversation_ref,participant_ref,scope,audience_version,reason_ref,at) VALUES(?,?,?,?,?,?,?)',
        watermark, conversationRef, participantRef ?? null, input.scope, version, reasonRef, now);
      this.run(`UPDATE shiyu_channel_conversations SET audience_version=?,audience_status=?,last_audience_reason=?,last_audience_at=?,updated_at=?
        WHERE conversation_ref=?`, version, input.scope === 'conversation' ? 'revoked' : String(row.audience_status),
      reasonRef, now, now, conversationRef);
      const signal = this.writeInvalidation({ type: input.scope === 'conversation' ? 'conversation_access_revoked' : 'participant_revoked',
        conversationRef, connectionId, audienceVersion: version, reasonRef, ...(participantRef === undefined ? {} : { participantRef }) });
      if (participantRef !== undefined) signal.removedParticipants = [participantRef];
      this.emit(signal);
      return { conversation: this.conversationView(this.conversationRow(conversationRef)!), revocation };
    });
  }

  /* ---------------------------------- ingest -------------------------------- */

  private messageRow(messageId: string): Row | undefined {
    return this.one('SELECT * FROM shiyu_channel_messages WHERE message_id=?', messageId);
  }
  private intakeRow(connection: NormalizedConnection, conversationRef: string, sourceEventId: string): Row | undefined {
    return this.one(`SELECT * FROM shiyu_channel_intake WHERE source_namespace=? AND account_id=? AND conversation_ref=? AND source_event_id=?`,
      connection.sourceNamespace, connection.account.accountId, conversationRef, sourceEventId);
  }
  private conflictSeq(connection: NormalizedConnection, conversationRef: string, sourceEventId: string, fingerprint: string): number {
    const existing = this.one(`SELECT intake_seq,received_at FROM shiyu_channel_intake_conflicts
      WHERE source_namespace=? AND account_id=? AND conversation_ref=? AND source_event_id=? AND fingerprint=?`,
    connection.sourceNamespace, connection.account.accountId, conversationRef, sourceEventId, fingerprint);
    if (existing) return Number(existing.intake_seq);
    const intakeSeq = this.bump('intake_seq');
    this.run(`INSERT INTO shiyu_channel_intake_conflicts
      (source_namespace,account_id,conversation_ref,source_event_id,fingerprint,intake_seq,received_at) VALUES(?,?,?,?,?,?,?)`,
    connection.sourceNamespace, connection.account.accountId, conversationRef, sourceEventId, fingerprint, intakeSeq, this.nowISO());
    return intakeSeq;
  }
  private persistReceipt(connection: NormalizedConnection, conversationRef: string, event: NormalizedInboundEvent, receipt: ChannelIntakeReceipt): ChannelIntakeReceipt {
    if (Number(this.one('SELECT COUNT(*) AS n FROM shiyu_channel_intake')!.n) >= this.limits.maxIntakeRows) {
      fail('CHANNEL_BACKPRESSURE', 'Channel intake ledger capacity reached; the batch was not accepted');
    }
    this.run(`INSERT INTO shiyu_channel_intake
      (source_namespace,account_id,conversation_ref,source_event_id,fingerprint,status,reason_code,native_event_id,message_id,intake_seq,received_at,receipt_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, connection.sourceNamespace, connection.account.accountId, conversationRef, event.sourceEventId,
    event.fingerprint, receipt.status, receipt.reasonCode ?? null, receipt.nativeEventId ?? null, receipt.messageId ?? null,
    receipt.intakeSeq, receipt.receivedAt, JSON.stringify(receipt));
    return receipt;
  }
  private messageState(row: Row): ChannelMessageState {
    return { status: String(row.status) as ChannelMessageStatus, nativeRevision: Number(row.native_revision), conversationRef: String(row.conversation_ref) };
  }
  private messageMetadata(row: Row): ChannelMessageMetadata {
    const deletedAt = row.deleted_at === null || row.deleted_at === undefined ? undefined : String(row.deleted_at);
    const deletionKind = row.deletion_kind === null || row.deletion_kind === undefined ? undefined : String(row.deletion_kind);
    return {
      messageId: String(row.message_id), conversationRef: String(row.conversation_ref), participantRef: String(row.participant_ref),
      participantKind: String(row.participant_kind) as ChannelMessageMetadata['participantKind'],
      privacyClass: String(row.privacy_class) as ChannelMessageMetadata['privacyClass'],
      status: String(row.status) as ChannelMessageMetadata['status'], revision: Number(row.revision), nativeRevision: Number(row.native_revision),
      kind: String(row.last_kind) as ChannelMessageMetadata['kind'],
      ...(row.content_hash === null || row.content_hash === undefined ? {} : { contentHash: String(row.content_hash) }),
      ...(row.last_sequence === null || row.last_sequence === undefined ? {} : { sourceSequence: Number(row.last_sequence) }),
      hasBodyRef: row.body_ref !== null && row.body_ref !== undefined,
      summaryBytes: row.summary === null || row.summary === undefined ? 0 : Buffer.byteLength(String(row.summary), 'utf8'),
      attachmentCount: Number(row.attachment_count), nativeMessageId: String(row.native_message_id),
      occurredAt: String(row.occurred_at), firstReceivedAt: String(row.first_received_at), updatedAt: String(row.updated_at),
      ...(deletedAt === undefined || deletionKind === undefined ? {} : {
        deleted: { kind: deletionKind as 'message.retract' | 'message.delete', revision: Number(row.revision), nativeRevision: Number(row.native_revision),
          deletionWatermark: Number(row.deletion_watermark), ...(row.deletion_reason === null || row.deletion_reason === undefined ? {} : { reasonRef: String(row.deletion_reason) }), at: deletedAt },
      }),
    };
  }
  private admitEvent(connection: NormalizedConnection, conversation: Row, conversationRef: string, event: NormalizedInboundEvent, signals: ChannelInvalidationSignal[]): ChannelIntakeReceipt {
    const previous = this.intakeRow(connection, conversationRef, event.sourceEventId);
    const receivedAt = this.nowISO();
    if (previous) {
      if (String(previous.fingerprint) !== event.fingerprint) {
        const intakeSeq = this.conflictSeq(connection, conversationRef, event.sourceEventId, event.fingerprint);
        return {
          status: 'rejected', reasonCode: 'IDEMPOTENCY_CONFLICT', sourceEventId: event.sourceEventId,
          composedSourceEventId: event.composedSourceEventId, conversationRef, intakeSeq, receivedAt,
          ...(event.nativeEventId === undefined ? {} : { nativeEventId: event.nativeEventId }),
        };
      }
      const stored = JSON.parse(String(previous.receipt_json)) as ChannelIntakeReceipt;
      // A redelivery is not a second business fact: the original intake sequence
      // and identity are returned; only a first acceptance is reported duplicate.
      return { ...stored, status: stored.status === 'accepted' ? 'duplicate' : stored.status };
    }
    // An explicit native event id is one source event per account. Re-delivering
    // it under another conversation label is an adapter conflict, never a second
    // business fact; composed identities stay conversation-scoped by construction.
    if (!event.composedSourceEventId) {
      const foreign = this.one('SELECT conversation_ref FROM shiyu_channel_intake WHERE source_namespace=? AND account_id=? AND source_event_id=? LIMIT 1',
        connection.sourceNamespace, connection.account.accountId, event.sourceEventId);
      if (foreign && String(foreign.conversation_ref) !== conversationRef) {
        const intakeSeq = this.conflictSeq(connection, conversationRef, event.sourceEventId, event.fingerprint);
        return { status: 'rejected', reasonCode: 'SOURCE_EVENT_CONFLICT', sourceEventId: event.sourceEventId,
          composedSourceEventId: false, conversationRef, intakeSeq, receivedAt, ...(event.nativeEventId === undefined ? {} : { nativeEventId: event.nativeEventId }) };
      }
    }
    const intakeSeq = this.bump('intake_seq');
    const participantRef = participantRefFor(connection, event.actor);
    const messageId = messageIdFor(connection, conversationRef, event.message.nativeMessageId);
    const receipt = (status: ChannelIntakeReceipt['status'], reasonCode?: string, messageRevision?: number): ChannelIntakeReceipt => this.persistReceipt(connection, conversationRef, event, {
      status, sourceEventId: event.sourceEventId, composedSourceEventId: event.composedSourceEventId, conversationRef, intakeSeq, receivedAt,
      ...(event.nativeEventId === undefined ? {} : { nativeEventId: event.nativeEventId }), messageId,
      ...(messageRevision === undefined ? {} : { messageRevision }), nativeRevision: event.message.revision,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
    if (String(conversation.audience_status) === 'revoked') return receipt('rejected', 'CONVERSATION_REVOKED');
    const knownParticipant = this.participantRow(connection, event.actor.nativeParticipantId);
    if (knownParticipant && String(knownParticipant.kind) !== event.actor.kind) return receipt('rejected', 'PARTICIPANT_KIND_CONFLICT');
    if (!capabilityForKind(connection.capabilities, event.kind)) return receipt('rejected', 'CAPABILITY_MISMATCH');
    const current = this.messageRow(messageId);
    const decision = revisionDecision(current ? this.messageState(current) : undefined, event);
    if (decision.action === 'reject') return receipt('rejected', decision.reasonCode);
    if (decision.action === 'stale') return receipt('stale', decision.reasonCode, current ? Number(current.revision) : undefined);
    // Accepted business fact from here on. Participant registration and the
    // message/revision write share the caller's atomic batch.
    this.ensureParticipant(connection, event.actor);
    if (decision.action === 'create') {
      if (Number(this.one('SELECT COUNT(*) AS n FROM shiyu_channel_messages WHERE conversation_ref=?', conversationRef)!.n) >= this.limits.maxMessagesPerConversation) {
        fail('CHANNEL_CAPACITY', 'Conversation message capacity reached; the batch was not accepted');
      }
      this.run(`INSERT INTO shiyu_channel_messages
        (message_id,conversation_ref,source_namespace,account_id,participant_ref,participant_kind,privacy_class,native_message_id,status,last_kind,
         native_revision,revision,content_hash,body_ref,summary,attachments_json,attachment_count,occurred_at,first_received_at,updated_at,last_intake_seq,last_sequence)
        VALUES(?,?,?,?,?,?,?,?,'active',?,?,1,?,?,?,?,?,?,?,?,?,?)`, messageId, conversationRef, connection.sourceNamespace,
      connection.account.accountId, participantRef, event.actor.kind, event.privacyClass, event.message.nativeMessageId, event.kind,
      event.message.revision, event.content.contentHash ?? null, event.content.bodyRef ?? null, event.content.summary ?? null,
      JSON.stringify(event.content.attachments), event.content.attachments.length, event.message.occurredAt, receivedAt, receivedAt, intakeSeq,
      event.sequence ?? null);
      this.insertRevision(messageId, 1, event, participantRef, receivedAt);
      return receipt('accepted', undefined, 1);
    }
    const admitted = current ?? fail('CORRUPT_CHANNEL_STORE', 'Revision decision requires an admitted message');
    const revision = Number(admitted.revision) + 1;
    const terminal = event.kind === 'message.retract' || event.kind === 'message.delete';
    if (terminal) {
      const deletionWatermark = this.bump('deletion_watermark');
      this.run(`UPDATE shiyu_channel_messages SET status=?,last_kind=?,native_revision=?,revision=?,content_hash=?,body_ref=NULL,summary=NULL,
        attachments_json='[]',attachment_count=0,deletion_kind=?,deletion_watermark=?,deletion_reason=?,deleted_at=?,updated_at=?,last_intake_seq=?,last_sequence=?
        WHERE message_id=?`, event.kind === 'message.retract' ? 'retracted' : 'deleted', event.kind, event.message.revision, revision,
      event.content.contentHash ?? null, event.kind, deletionWatermark, event.reasonRef ?? null, receivedAt, receivedAt, intakeSeq,
      event.sequence ?? null, messageId);
      // Content references are cleared from every revision; hashes and revision
      // provenance stay for the deletion ledger, never for re-exposure.
      this.run(`UPDATE shiyu_channel_revisions SET body_ref=NULL,summary=NULL,attachments_json='[]' WHERE message_id=?`, messageId);
      this.run(`INSERT INTO shiyu_channel_deletions(watermark,conversation_ref,message_id,message_revision,native_revision,kind,reason_ref,source_event_id,at)
        VALUES(?,?,?,?,?,?,?,?,?)`, deletionWatermark, conversationRef, messageId, revision, event.message.revision,
      event.kind, event.reasonRef ?? null, event.sourceEventId, receivedAt);
      const signal = this.writeInvalidation({ type: 'message_deleted', conversationRef, connectionId: connection.connectionId,
        audienceVersion: Number(conversation.audience_version), reasonRef: event.sourceEventId, messageId });
      signals.push(signal);
    } else {
      this.run(`UPDATE shiyu_channel_messages SET status='edited',last_kind=?,native_revision=?,revision=?,content_hash=?,body_ref=?,summary=?,
        attachments_json=?,attachment_count=?,updated_at=?,last_intake_seq=?,last_sequence=? WHERE message_id=?`, event.kind, event.message.revision, revision,
      event.content.contentHash ?? null, event.content.bodyRef ?? null, event.content.summary ?? null, JSON.stringify(event.content.attachments),
      event.content.attachments.length, receivedAt, intakeSeq, event.sequence ?? null, messageId);
    }
    this.insertRevision(messageId, revision, event, participantRef, receivedAt);
    return receipt('accepted', undefined, revision);
  }
  private insertRevision(messageId: string, revision: number, event: NormalizedInboundEvent, participantRef: string, receivedAt: string): void {
    const terminal = event.kind === 'message.retract' || event.kind === 'message.delete';
    this.run(`INSERT INTO shiyu_channel_revisions
      (revision_id,message_id,revision,kind,native_revision,source_event_id,participant_ref,privacy_class,content_hash,body_ref,summary,attachments_json,occurred_at,received_at,source_sequence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, `${messageId}#r${revision}`, messageId, revision, event.kind, event.message.revision,
    event.sourceEventId, participantRef, event.privacyClass, event.content.contentHash ?? null,
    terminal ? null : event.content.bodyRef ?? null, terminal ? null : event.content.summary ?? null,
    terminal ? '[]' : JSON.stringify(event.content.attachments), event.message.occurredAt, receivedAt, event.sequence ?? null);
  }
  ingest(input: ChannelCommands['channel.ingest']['input']): ChannelIngestResult {
    ingressFields(input, ['connectionId', 'conversation', 'events']);
    const connectionId = channelRef(input.connectionId, 'connection');
    const conversationInput = normalizeConversationInput(input.conversation);
    if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > this.limits.maxEventsPerBatch) {
      fail('INVALID_SCHEMA', 'A bounded nonempty inbound event batch is required');
    }
    // Envelope validation happens before any write, so one malformed adapter
    // payload rejects the whole batch instead of half-admitting it.
    const events = input.events.map(normalizeInboundEvent);
    return this.tx.atomic(() => {
      const connection = this.connectionFromRow(this.connectionRow(connectionId));
      const conversationRef = conversationRefFor(connection.connectionId, conversationInput);
      let conversation = this.conversationRow(conversationRef);
      if (!conversation) {
        this.createConversationRow(connection, conversationRef, conversationInput, this.nowISO());
        conversation = this.conversationRow(conversationRef)!;
      }
      const activeConversation = conversation ?? fail('CORRUPT_CHANNEL_STORE', 'Channel conversation could not be created');
      const signals: ChannelInvalidationSignal[] = [];
      const results = events.map(event => this.admitEvent(connection, activeConversation, conversationRef, event, signals));
      for (const signal of signals) this.emit(signal);
      return { results };
    });
  }

  /* ----------------------------------- reads -------------------------------- */

  getMessage(input: ChannelCommands['channel.getMessage']['input']): ChannelMessageMetadata {
    ingressFields(input, ['messageId', 'expectedAudienceVersion'], ['messageId']);
    const messageId = channelRef(input.messageId, 'message');
    if (input.expectedAudienceVersion !== undefined) integer(input.expectedAudienceVersion, 'expectedAudienceVersion', 0);
    return this.tx.atomic(() => {
      const row = this.messageRow(messageId) ?? fail('UNKNOWN_MESSAGE', 'No channel message has this identity');
      if (input.expectedAudienceVersion !== undefined) {
        const conversation = this.conversationRow(String(row.conversation_ref)) ?? fail('CORRUPT_CHANNEL_STORE', 'Message conversation is missing');
        if (Number(conversation.audience_version) !== input.expectedAudienceVersion) {
          fail('STALE_AUDIENCE', 'Conversation audience version changed; re-capture before reading');
        }
      }
      return this.messageMetadata(row);
    });
  }
  getParticipant(input: ChannelCommands['channel.getParticipant']['input']): ChannelParticipantView {
    ingressFields(input, ['participantRef']);
    const participantRef = channelRef(input.participantRef, 'participant');
    return this.tx.atomic(() => {
      const row = this.one('SELECT * FROM shiyu_channel_participants WHERE participant_ref=?', participantRef)
        ?? fail('UNKNOWN_PARTICIPANT', 'No channel participant has this identity');
      return {
        participantRef, connectionId: String(row.connection_id), sourceNamespace: String(row.source_namespace), accountId: String(row.account_id),
        nativeParticipantId: String(row.native_participant_id), kind: String(row.kind) as ChannelParticipantView['kind'],
        firstSeenAt: String(row.first_seen_at),
        innerAccount: toInnerAccount({ connectionId: String(row.connection_id), sourceNamespace: String(row.source_namespace),
          accountId: String(row.account_id), nativeParticipantId: String(row.native_participant_id),
          kind: String(row.kind) as ChannelParticipantView['kind'] }),
      };
    });
  }
  captureAudience(input: ChannelCommands['channel.captureAudience']['input']): ChannelCommands['channel.captureAudience']['output'] {
    ingressFields(input, ['conversationRef', 'expectedAudienceVersion', 'limit'], ['conversationRef']);
    const conversationRef = channelRef(input.conversationRef, 'conversation');
    if (input.expectedAudienceVersion !== undefined) integer(input.expectedAudienceVersion, 'expectedAudienceVersion', 0);
    const limit = input.limit === undefined ? 100 : integer(input.limit, 'limit', 1, 200);
    return this.tx.atomic(() => {
      const conversation = this.requireConversation(conversationRef);
      if (String(conversation.audience_status) === 'revoked') fail('CONVERSATION_REVOKED', 'This conversation audience was revoked');
      const audienceVersion = Number(conversation.audience_version);
      if (input.expectedAudienceVersion !== undefined && input.expectedAudienceVersion !== audienceVersion) {
        fail('STALE_AUDIENCE', 'Conversation audience version changed; re-read the current audience');
      }
      const now = this.nowISO(), nowMs = this.nowMs();
      this.run('DELETE FROM shiyu_channel_captures WHERE expires_at<=?', now);
      if (Number(this.one('SELECT COUNT(*) AS n FROM shiyu_channel_captures')!.n) >= this.limits.maxCaptures) {
        fail('CHANNEL_CAPACITY', 'Audience capture capacity reached');
      }
      const rows = this.all('SELECT * FROM shiyu_channel_messages WHERE conversation_ref=? ORDER BY last_intake_seq LIMIT ?', conversationRef, limit + 1);
      const truncated = rows.length > limit;
      const selected = rows.slice(0, limit);
      const messages = selected.map(row => this.messageMetadata(row));
      const captureId = `chcap-${randomUUID().replaceAll('-', '')}`;
      const expiresAt = new Date(nowMs + this.limits.captureTtlMs).toISOString();
      const intakeSeq = selected.length ? Number(selected[selected.length - 1]!.last_intake_seq) : 0;
      this.run(`INSERT INTO shiyu_channel_captures(capture_id,conversation_ref,connection_id,audience_version,intake_seq,created_at,expires_at,record_json)
        VALUES(?,?,?,?,?,?,?,?)`, captureId, conversationRef, String(conversation.connection_id), audienceVersion, intakeSeq, now, expiresAt,
      JSON.stringify({ schemaVersion: 1, conversationRef, audienceVersion, intakeSeq,
        messages: selected.map(row => ({ messageId: String(row.message_id), revision: Number(row.revision) })) }));
      const view = this.conversationView(conversation);
      return { captureId, connectionId: view.connectionId, conversationRef, mode: view.mode, audienceVersion: view.audienceVersion,
        audienceStatus: view.audienceStatus, participants: view.participants, messages, truncated, createdAt: now, expiresAt };
    });
  }
  readContentRefs(input: ChannelCommands['channel.readContentRefs']['input']): ChannelContentReadResult {
    ingressFields(input, ['captureId', 'messageIds']);
    const captureId = channelRef(input.captureId, 'capture');
    if (!Array.isArray(input.messageIds) || input.messageIds.length < 1 || input.messageIds.length > 64
      || new Set(input.messageIds).size !== input.messageIds.length) fail('INVALID_SCHEMA', 'Bounded unique captured message ids are required');
    const messageIds = input.messageIds.map(value => channelRef(value, 'message'));
    return this.tx.atomic(() => {
      const capture = this.one('SELECT * FROM shiyu_channel_captures WHERE capture_id=?', captureId)
        ?? fail('UNKNOWN_CAPTURE', 'Audience capture is unavailable');
      if (String(capture.expires_at) <= this.nowISO()) fail('EXPIRED', 'Audience capture expired');
      const conversationRef = String(capture.conversation_ref);
      const conversation = this.requireConversation(conversationRef);
      if (String(conversation.audience_status) === 'revoked') fail('CONVERSATION_REVOKED', 'This conversation audience was revoked');
      const audienceVersion = Number(conversation.audience_version);
      const snapshot = JSON.parse(String(capture.record_json)) as { audienceVersion: number; messages: { messageId: string; revision: number }[] };
      if (snapshot.audienceVersion !== audienceVersion) fail('STALE_AUDIENCE', 'Audience changed after this capture; re-capture before exposure');
      const captured = new Map(snapshot.messages.map(message => [message.messageId, message]));
      const content: ChannelContentReadResult['content'] = [];
      for (const messageId of messageIds) {
        // A message outside this capture belongs to another audience/snapshot;
        // never fall back to a direct row read.
        const snapshotMessage = captured.get(messageId) ?? fail('CROSS_AUDIENCE', 'Requested message is not part of this audience capture');
        const row = this.messageRow(messageId) ?? fail('UNKNOWN_MESSAGE', 'Captured message no longer exists');
        if (String(row.conversation_ref) !== conversationRef) fail('CROSS_AUDIENCE', 'Captured message belongs to another conversation');
        // Deletion outranks revision staleness: the strongest safe fact is reported.
        if (String(row.status) === 'retracted' || String(row.status) === 'deleted') fail('MESSAGE_DELETED', 'Deleted message content is not exposed');
        if (Number(row.revision) !== snapshotMessage.revision) fail('STALE_CAPTURE', 'Message revision changed after capture');
        content.push({
          messageId, revision: Number(row.revision), nativeRevision: Number(row.native_revision),
          ...(row.content_hash === null || row.content_hash === undefined ? {} : { contentHash: String(row.content_hash) }),
          ...(row.body_ref === null || row.body_ref === undefined ? {} : { bodyRef: String(row.body_ref) }),
          ...(row.summary === null || row.summary === undefined ? {} : { summary: String(row.summary) }),
          attachments: JSON.parse(String(row.attachments_json)) as ChannelContentReadResult['content'][number]['attachments'],
        });
      }
      return { captureId, conversationRef, audienceVersion, content };
    });
  }

  /* -------------------------------- watermarks ------------------------------ */

  watermark(): ChannelWatermark {
    return this.tx.atomic(() => {
      const meta = this.meta();
      return { intakeSeq: meta.intakeSeq, invalidationWatermark: meta.invalidationWatermark, deletionWatermark: meta.deletionWatermark,
        revocationWatermark: meta.revocationWatermark };
    });
  }
  private after(input: { afterWatermark?: number; limit?: number }): { after: number; limit: number } {
    ingressFields(input, ['afterWatermark', 'limit'], []);
    return {
      after: input.afterWatermark === undefined ? 0 : integer(input.afterWatermark, 'afterWatermark', 0),
      limit: input.limit === undefined ? 100 : integer(input.limit, 'limit', 1, 200),
    };
  }
  invalidationsAfter(input: ChannelCommands['channel.invalidationsAfter']['input']): ChannelInvalidation[] {
    const { after, limit } = this.after(input);
    return this.tx.atomic(() => this.all('SELECT * FROM shiyu_channel_invalidations WHERE watermark>? ORDER BY watermark LIMIT ?', after, limit).map(row => ({
      watermark: Number(row.watermark), type: String(row.type) as ChannelInvalidation['type'], conversationRef: String(row.conversation_ref),
      connectionId: String(row.connection_id), audienceVersion: Number(row.audience_version), reasonRef: String(row.reason_ref), at: String(row.at),
      ...(row.message_id === null || row.message_id === undefined ? {} : { messageId: String(row.message_id) }),
      ...(row.participant_ref === null || row.participant_ref === undefined ? {} : { participantRef: String(row.participant_ref) }),
    })));
  }
  deletionsAfter(input: ChannelCommands['channel.deletionsAfter']['input']): ChannelDeletion[] {
    const { after, limit } = this.after(input);
    return this.tx.atomic(() => this.all('SELECT * FROM shiyu_channel_deletions WHERE watermark>? ORDER BY watermark LIMIT ?', after, limit).map(row => ({
      watermark: Number(row.watermark), conversationRef: String(row.conversation_ref), messageId: String(row.message_id),
      messageRevision: Number(row.message_revision), nativeRevision: Number(row.native_revision),
      kind: String(row.kind) as ChannelDeletion['kind'],
      ...(row.reason_ref === null || row.reason_ref === undefined ? {} : { reasonRef: String(row.reason_ref) }),
      sourceEventId: String(row.source_event_id), at: String(row.at),
    })));
  }
  revocationsAfter(input: ChannelCommands['channel.revocationsAfter']['input']): ChannelRevocation[] {
    const { after, limit } = this.after(input);
    return this.tx.atomic(() => this.all('SELECT * FROM shiyu_channel_revocations WHERE watermark>? ORDER BY watermark LIMIT ?', after, limit).map(row => ({
      watermark: Number(row.watermark), conversationRef: String(row.conversation_ref),
      ...(row.participant_ref === null || row.participant_ref === undefined ? {} : { participantRef: String(row.participant_ref) }),
      scope: String(row.scope) as ChannelRevocation['scope'], audienceVersion: Number(row.audience_version),
      reasonRef: String(row.reason_ref), at: String(row.at),
    })));
  }
  snapshot(input: ChannelCommands['channel.snapshot']['input']): ChannelSnapshot {
    ingressFields(input, ['connectionId', 'limit'], []);
    const connectionId = input.connectionId === undefined ? undefined : channelRef(input.connectionId, 'connection');
    const limit = input.limit === undefined ? 100 : integer(input.limit, 'limit', 1, 200);
    return this.tx.atomic(() => {
      const meta = this.meta();
      const connectionRows = connectionId === undefined
        ? this.all('SELECT * FROM shiyu_channel_connections ORDER BY connection_id LIMIT ?', limit)
        : this.all('SELECT * FROM shiyu_channel_connections WHERE connection_id=?', connectionId);
      const connections = connectionRows.map(row => this.connectionView(this.connectionFromRow(row), row));
      const conversationRows = connectionId === undefined
        ? this.all('SELECT * FROM shiyu_channel_conversations ORDER BY conversation_ref LIMIT ?', limit)
        : this.all('SELECT * FROM shiyu_channel_conversations WHERE connection_id=? ORDER BY conversation_ref LIMIT ?', connectionId, limit);
      return {
        status: { ready: true, schemaVersion: SCHEMA_VERSION },
        watermark: { intakeSeq: meta.intakeSeq, invalidationWatermark: meta.invalidationWatermark,
          deletionWatermark: meta.deletionWatermark, revocationWatermark: meta.revocationWatermark },
        connections, conversations: conversationRows.map(row => this.conversationView(row)),
      };
    });
  }

  execute(request: ChannelDomainRequest): unknown {
    switch (request.command) {
      case 'channel.status': return { ready: true, schemaVersion: SCHEMA_VERSION };
      case 'channel.registerConnection': return this.registerConnection(request.args);
      case 'channel.ensureConversation': return this.ensureConversation(request.args);
      case 'channel.updateAudience': return this.updateAudience(request.args);
      case 'channel.revokeAccess': return this.revokeAccess(request.args);
      case 'channel.ingest': return this.ingest(request.args);
      case 'channel.getMessage': return this.getMessage(request.args);
      case 'channel.getParticipant': return this.getParticipant(request.args);
      case 'channel.captureAudience': return this.captureAudience(request.args);
      case 'channel.readContentRefs': return this.readContentRefs(request.args);
      case 'channel.watermark': return this.watermark();
      case 'channel.invalidationsAfter': return this.invalidationsAfter(request.args);
      case 'channel.deletionsAfter': return this.deletionsAfter(request.args);
      case 'channel.revocationsAfter': return this.revocationsAfter(request.args);
      case 'channel.snapshot': return this.snapshot(request.args);
      default: return fail('INVALID_COMMAND', 'Unknown channel ingress command');
    }
  }
}
