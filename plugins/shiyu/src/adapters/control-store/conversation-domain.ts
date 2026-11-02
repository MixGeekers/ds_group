import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ConversationError, ConversationStore, type BackgroundReceipt, type PendingBackground, type SourceVersion, type ContextSnapshot } from '../../control/conversations/index.js';
import type { TaskView } from '../../control/tasks/index.js';
import type { TrustedPolicyActor } from '../../control/policy/mandates.js';
import type { AckInput, ClaimedDelivery, ClaimInput, EventPrincipal, EventStats, FailInput, StoredDelivery, StoredEvent, StoredSubscription, SubscribeInput } from '../../contracts/events.js';
import { SqliteTransactions } from './transaction.js';
import { LocalReplyDomain, type LocalReplyAuthority, type LocalReplyCommands, type LocalReplyDomainRequest, type LocalReplyOperation } from './local-reply-domain.js';

export const CONVERSATION_BACKGROUND_HANDLER = 'conversation.background';
export const LOCAL_CONVERSATION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LOCAL_SCOPE = 'local-owner';
const OWNER: TrustedPolicyActor = { principalId: LOCAL_SCOPE, kind: 'owner', scopes: [LOCAL_SCOPE] };
const PROJECTOR: TrustedPolicyActor = { principalId: 'shiyu-conversation-background', kind: 'component', scopes: [LOCAL_SCOPE] };

/** Only the Worker binds this identity to existing Event functions; public commands never supply it. */
export function conversationEventPrincipal(): EventPrincipal {
  return { principalId: PROJECTOR.principalId, kind: 'component', scopes: [LOCAL_SCOPE], publishTypes: [], subscribeTypes: ['task.succeeded'], targetRefs: [CONVERSATION_BACKGROUND_HANDLER] };
}
export interface ConversationEventPort {
  subscribe(input: SubscribeInput): StoredSubscription;
  listSubscriptions(): StoredSubscription[];
  stats(): EventStats;
  claim(input: ClaimInput): ClaimedDelivery[];
  /** Revalidates claim and reloads its stored event; never trusts the claim response as fresh authority. */
  inspectClaim(input: AckInput): { delivery: StoredDelivery; event: StoredEvent };
  ack(input: AckInput): StoredDelivery;
  fail(input: FailInput): StoredDelivery;
}
export interface LocalConversationEntry {
  source?: { kind: 'local-task' } | { kind: 'lab'; connectionId: string; runId: string; channelId: string; membersDigest: string };
  conversationId: string;
  localConversationKey: string;
  topicId: string;
  bindingId: string;
  scope: 'local-owner';
  audienceVersion: number;
  conversationGeneration: number;
  routingRevision: number;
  sessionEpoch: number;
  contextVersion: number;
  needsSync: boolean;
  sources: SourceVersion[];
  pending: PendingBackground[];
  taskRefs: { taskId: string; state: TaskView['state']; version: number }[];
  latestReply?: Pick<LocalReplyOperation, 'operationId' | 'inputId' | 'status' | 'durability' | 'viewId' | 'draftId' | 'updatedAt' | 'reasonCode'> & { sessionId?: string; userMessageSeq?: number; assistantEventSeq?: number };
  subscriptionRefs: { id: string; taskId: string; status: StoredSubscription['status']; replayTruncated: boolean; replayedCount: number; startSequence: number }[];
}
export type LocalBackgroundStats = Pick<EventStats, 'subscriptions' | 'pending' | 'claimed' | 'acknowledged' | 'failed' | 'cancelled'>;
export interface LocalConversationSnapshot {
  schemaVersion: 1;
  scope: 'local-owner';
  conversations: LocalConversationEntry[];
  background: LocalBackgroundStats;
}
export interface BackgroundConsumptionResult {
  claimed: number;
  acknowledged: number;
  /** Included in acknowledged, not another attempted delivery. */
  duplicate: number;
  failed: number;
  deliveries: { deliveryId: string; eventId: string; status: 'acked' | 'retrying' | 'failed' | 'stale'; backgroundStatus?: BackgroundReceipt['status']; errorCode?: string }[];
}
export interface ConversationCommands extends LocalReplyCommands {
  'conversation.ensureLocalTask': { input: { taskId: string; localConversationKey?: string }; output: LocalConversationEntry };
  'conversation.ensureLabChannel': { input: LabChannelInput; output: LocalConversationEntry };
  'conversation.consumeBackground': { input: { limit?: number }; output: BackgroundConsumptionResult };
  'conversation.snapshotLocal': { input: { conversationId?: string }; output: LocalConversationSnapshot };
}
export type ConversationDomainRequest = { [K in keyof ConversationCommands]: { command: K; args: ConversationCommands[K]['input'] } }[keyof ConversationCommands];
interface LocalBinding { localKey: string; conversationId: string; topicId: string; bindingId: string }
export interface LabChannelKey { connectionId: string; runId: string; channelId: string }
export interface LabChannelInput extends LabChannelKey { kind: 'direct' | 'group' | 'channel'; membersDigest: string }
interface LabBinding extends LocalBinding, LabChannelInput { retired: number }
interface Options { events: ConversationEventPort; getTask(taskId: string): TaskView }
const fail = (code: string, message: string): never => { throw new ConversationError(code, message); };
function fields(value: unknown, allowed: string[], required = allowed): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_SCHEMA', 'Unknown or missing local conversation fields');
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !LOCAL_CONVERSATION_KEY_PATTERN.test(value)) fail('INVALID_SCHEMA', `Invalid ${field}`);
  return value as string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'PROJECTION_FAILED';
}

/** Trusted local/Lab bindings and durable background projection; no native I/O, message body or send port. */
export class ConversationDomain {
  private readonly conversations: ConversationStore;
  private readonly replies: LocalReplyDomain;
  constructor(private readonly db: DatabaseSync, private readonly tx: SqliteTransactions, private readonly options: Options) {
    if (!tx.owns(db)) fail('TRANSACTION_MISMATCH', 'Conversation domain requires the shared transaction connection');
    this.conversations = new ConversationStore(db, tx, {
      ownerIds: [OWNER.principalId], componentPermissions: { [PROJECTOR.principalId]: ['read', 'background'] },
      authorizeReference: ({ scope, reference }) => {
        if (scope !== LOCAL_SCOPE || reference.kind !== 'task') return false;
        try { return this.options.getTask(reference.id).taskId === reference.id; }
        catch (error) { if (errorCode(error) === 'UNKNOWN_TASK') return false; throw error; }
      },
    });
    tx.atomic(() => db.exec(`CREATE TABLE IF NOT EXISTS shiyu_local_conversations (
      local_key TEXT PRIMARY KEY,conversation_id TEXT NOT NULL UNIQUE,topic_id TEXT NOT NULL UNIQUE,binding_id TEXT NOT NULL UNIQUE
    ); CREATE TABLE IF NOT EXISTS shiyu_lab_conversations (
      connection_id TEXT NOT NULL,run_id TEXT NOT NULL,channel_id TEXT NOT NULL,kind TEXT NOT NULL,members_digest TEXT NOT NULL,retired INTEGER NOT NULL,
      conversation_id TEXT NOT NULL UNIQUE,topic_id TEXT NOT NULL UNIQUE,binding_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(run_id,channel_id)
    )`));
    this.replies = new LocalReplyDomain(db, tx, { conversations: this.conversations, bindingFor: conversationId => this.localReplyBinding(conversationId) });
  }
  private localReplyBinding(conversationId: string) {
    text(conversationId, 'conversationId');
    const local = this.bindings(conversationId)[0];
    if (!local) fail('UNKNOWN_CONVERSATION', 'No managed local conversation has this identity');
    return this.conversations.getReplyBinding(OWNER, local!.bindingId);
  }
  /** Trusted same-Worker view authority is installed once; no public command can replace it. */
  setReplyAuthority(authority: LocalReplyAuthority): void { this.replies.setAuthority(authority); }
  /** Same-Worker send gate. It performs no native I/O and cannot grant a draft. */
  assertReadyDraft(operationId: string): LocalReplyOperation { return this.replies.assertReadyDraft(operationId); }
  /** Same-Worker withdrawal callback, intentionally absent from public IPC. */
  invalidateMemorySources(input: Parameters<LocalReplyDomain['invalidateMemorySources']>[0]) { return this.replies.invalidateMemorySources(input); }
  /** Same-Worker owner authority for source consent; never accepts an actor or remote scope. */
  getLocalConversation(conversationId: string) {
    return this.tx.atomic(() => {
      text(conversationId, 'conversationId');
      if (!this.bindings(conversationId).length) fail('UNKNOWN_CONVERSATION', 'No local conversation has this identity');
      return this.conversations.getConversation(OWNER, conversationId);
    });
  }
  replyContext(conversationId: string): ContextSnapshot & { businessId: string; sessionId?: string } {
    return this.tx.atomic(() => {
      const binding = this.localReplyBinding(conversationId);
      return { ...this.conversations.contextSnapshot(OWNER, binding.bindingId), businessId: binding.businessId,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}) };
    });
  }
  private bindings(conversationId?: string): LocalBinding[] {
    return [...this.localBindings(conversationId), ...this.labBindings(conversationId)];
  }
  private localBindings(conversationId?: string): LocalBinding[] {
    this.tx.assertUsable();
    return (this.db.prepare(`SELECT local_key AS localKey,conversation_id AS conversationId,topic_id AS topicId,binding_id AS bindingId
      FROM shiyu_local_conversations ${conversationId ? 'WHERE conversation_id=?' : ''} ORDER BY local_key`).all(...conversationId ? [conversationId] : []) as unknown as LocalBinding[]);
  }
  private labBindings(conversationId?: string): LabBinding[] {
    this.tx.assertUsable();
    return (this.db.prepare(`SELECT connection_id AS connectionId,run_id AS runId,channel_id AS channelId,kind,members_digest AS membersDigest,retired,
      conversation_id AS conversationId,topic_id AS topicId,binding_id AS bindingId FROM shiyu_lab_conversations
      ${conversationId ? 'WHERE conversation_id=?' : ''} ORDER BY connection_id,run_id,channel_id`).all(...conversationId ? [conversationId] : []) as unknown as Omit<LabBinding, 'localKey'>[])
      .map(binding => ({ ...binding, localKey: `lab_${hash(JSON.stringify([binding.runId, binding.channelId]))}` }));
  }
  private labKey(input: LabChannelKey): void {
    for (const value of [input.connectionId, input.runId, input.channelId]) if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value)) fail('INVALID_SCHEMA', 'Invalid Lab channel identity');
  }
  private labBinding(input: LabChannelKey): LabBinding {
    this.labKey(input);
    const binding = this.labBindings().find(value => value.runId === input.runId && value.channelId === input.channelId);
    if (!binding) fail('UNKNOWN_CONVERSATION', 'No Lab channel has this identity');
    return binding!;
  }
  /** Trusted Lab domain only: no fake Task, subscription, history or inbox is created. */
  ensureLabChannel(input: LabChannelInput): LocalConversationEntry {
    fields(input, ['connectionId', 'runId', 'channelId', 'kind', 'membersDigest']); this.labKey(input);
    if (!['direct', 'group', 'channel'].includes(input.kind) || !/^[a-f0-9]{64}$/.test(input.membersDigest)) fail('INVALID_SCHEMA', 'Invalid Lab channel audience');
    return this.tx.atomic(() => {
      let binding = this.labBindings().find(value => value.runId === input.runId && value.channelId === input.channelId);
      if (!binding) {
        if (this.labBindings().length >= 128) fail('CONVERSATION_CAPACITY', 'At most 128 Lab channel bindings are supported');
        const key = hash(JSON.stringify([input.runId, input.channelId]));
        const conversation = this.conversations.ensureConversation(OWNER, { connectionId: `lab-run:${hash(input.runId)}`, platformConversationId: key, kind: input.kind, scope: LOCAL_SCOPE });
        const topic = this.conversations.createTopic(OWNER, { topicId: `lab-topic:${key}`, scope: LOCAL_SCOPE });
        this.conversations.linkTopic(OWNER, { conversationId: conversation.conversationId, topicId: topic.topicId, expectedConversationRevision: conversation.revision, expectedTopicRevision: topic.revision });
        const reply = this.conversations.ensureReplyBinding(OWNER, { conversationId: conversation.conversationId, topicId: topic.topicId });
        binding = { ...input, retired: 0, localKey: `lab_${key}`, conversationId: conversation.conversationId, topicId: topic.topicId, bindingId: reply.bindingId };
        this.db.prepare('INSERT INTO shiyu_lab_conversations VALUES(?,?,?,?,?,?,?,?,?)').run(input.connectionId, input.runId, input.channelId, input.kind, input.membersDigest, 0, binding.conversationId, binding.topicId, binding.bindingId);
      } else {
        if (binding.kind !== input.kind) fail('IDEMPOTENCY_CONFLICT', 'Lab channel kind cannot change');
        if (binding.connectionId !== input.connectionId && binding.retired !== 1) fail('LAB_CHANNEL_OWNED', 'Lab channel still has an active connection owner');
        if (binding.membersDigest !== input.membersDigest) {
          const current = this.conversations.getConversation(OWNER, binding.conversationId);
          // invalidateAudience already retires the native epoch exactly once.
          this.conversations.invalidateAudience(OWNER, { conversationId: current.conversationId, expectedRevision: current.revision, reasonRef: `lab-members:${input.membersDigest}` });
          this.db.prepare('UPDATE shiyu_lab_conversations SET members_digest=? WHERE conversation_id=?').run(input.membersDigest, binding.conversationId);
          binding.membersDigest = input.membersDigest;
        }
        if (binding.connectionId !== input.connectionId || binding.retired !== 0) {
          this.db.prepare('UPDATE shiyu_lab_conversations SET connection_id=?,retired=0 WHERE conversation_id=?').run(input.connectionId, binding.conversationId);
          binding.connectionId = input.connectionId; binding.retired = 0;
        }
      }
      return this.entry(binding, []);
    });
  }
  /** Same-transaction Lab ingest fence; the Lab ledger owns event/body identity. */
  advanceLabInput(input: LabChannelKey & { eventId: string }): LocalConversationEntry {
    fields(input, ['connectionId', 'runId', 'channelId', 'eventId']);
    if (typeof input.eventId !== 'string' || !input.eventId || input.eventId.length > 200) fail('INVALID_SCHEMA', 'Invalid Lab input identity');
    return this.tx.atomic(() => {
      const binding = this.labBinding(input), conversation = this.conversations.getConversation(OWNER, binding.conversationId);
      if (binding.connectionId !== input.connectionId || binding.retired !== 0) fail('STALE_LAB_CONNECTION', 'Lab input does not own the current channel binding');
      this.conversations.advanceGeneration(OWNER, { conversationId: conversation.conversationId, expectedRevision: conversation.revision,
        eventId: `lab-input:${hash(JSON.stringify([input.runId, input.channelId, input.eventId]))}`, reason: 'input' });
      return this.entry(binding, []);
    });
  }
  /** Retire a connection's authority, preserving the native Session for the
   * same run/channel/audience. Only a membership change resets its epoch. */
  retireLabChannel(input: LabChannelKey & { reasonRef: string }): LocalConversationEntry {
    fields(input, ['connectionId', 'runId', 'channelId', 'reasonRef']);
    if (typeof input.reasonRef !== 'string' || !input.reasonRef || input.reasonRef.length > 200) fail('INVALID_SCHEMA', 'Invalid Lab retirement reason');
    return this.tx.atomic(() => {
      const binding = this.labBinding(input);
      // A late old owner's cleanup must never retire the replacement owner.
      if (binding.connectionId !== input.connectionId || binding.retired === 1) return this.entry(binding, []);
      const conversation = this.conversations.getConversation(OWNER, binding.conversationId);
      this.conversations.advanceGeneration(OWNER, { conversationId: conversation.conversationId, expectedRevision: conversation.revision,
        eventId: `lab-retire:${hash(JSON.stringify([input.connectionId, input.reasonRef]))}`, reason: 'cancel' });
      this.db.prepare('UPDATE shiyu_lab_conversations SET retired=1 WHERE conversation_id=?').run(binding.conversationId);
      binding.retired = 1;
      return this.entry(binding, []);
    });
  }
  private entry(binding: LocalBinding, subscriptions: StoredSubscription[]): LocalConversationEntry {
    const version = this.conversations.version(OWNER, binding.bindingId), context = this.conversations.contextSnapshot(OWNER, binding.bindingId);
    const taskRefs = context.sources.filter(source => source.reference.kind === 'task').map(source => {
      const task = this.options.getTask(source.reference.id); return { taskId: task.taskId, state: task.state, version: task.version };
    });
    const ids = new Set(taskRefs.map(task => task.taskId));
    const reply = this.replies.latest(binding.conversationId);
    const latestReply = reply ? { operationId: reply.operationId, inputId: reply.inputId, status: reply.status, durability: reply.durability, updatedAt: reply.updatedAt,
      ...(reply.viewId ? { viewId: reply.viewId } : {}), ...(reply.draftId ? { draftId: reply.draftId } : {}), ...(reply.reasonCode ? { reasonCode: reply.reasonCode } : {}),
      ...(reply.nativeBinding ? { sessionId: reply.nativeBinding.sessionId } : {}), ...(reply.contextReceipt ? { userMessageSeq: reply.contextReceipt.userMessageSeq } : {}),
      ...(reply.assistantRef ? { assistantEventSeq: reply.assistantRef.eventSeq } : {}) } : undefined;
    return {
      source: 'membersDigest' in binding ? { kind: 'lab', connectionId: (binding as LabBinding).connectionId, runId: (binding as LabBinding).runId,
        channelId: (binding as LabBinding).channelId, membersDigest: (binding as LabBinding).membersDigest } : { kind: 'local-task' },
      conversationId: binding.conversationId, localConversationKey: binding.localKey, topicId: binding.topicId, bindingId: binding.bindingId, scope: LOCAL_SCOPE,
      audienceVersion: version.audienceVersion, conversationGeneration: version.conversationGeneration, routingRevision: version.routingRevision,
      sessionEpoch: version.sessionEpoch, contextVersion: version.contextVersion, needsSync: context.needsSync, sources: context.sources, pending: context.pending, taskRefs, ...(latestReply ? { latestReply } : {}),
      subscriptionRefs: subscriptions.filter(sub => typeof sub.filter?.taskId === 'string' && ids.has(sub.filter.taskId)).map(sub => ({ id: sub.id, taskId: String(sub.filter!.taskId),
        status: sub.status, replayTruncated: sub.replayTruncated, replayedCount: sub.replayedCount, startSequence: sub.startSequence })),
    };
  }
  ensureLocalTask(input: ConversationCommands['conversation.ensureLocalTask']['input']): LocalConversationEntry {
    fields(input, ['taskId', 'localConversationKey'], ['taskId']); const taskId = text(input.taskId, 'taskId');
    const localKey = input.localConversationKey === undefined ? taskId : text(input.localConversationKey, 'localConversationKey');
    return this.tx.atomic(() => {
      this.options.getTask(taskId); // Existing local Task only; this method cannot create or dispatch one.
      let binding = this.localBindings().find(value => value.localKey === localKey);
      if (!binding) {
        if (this.localBindings().length >= 64) fail('CONVERSATION_CAPACITY', 'At most 64 local synthetic conversation bindings are supported');
        const conversation = this.conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: localKey, kind: 'direct', scope: LOCAL_SCOPE });
        const topic = this.conversations.createTopic(OWNER, { topicId: `local-topic:${hash(localKey)}`, scope: LOCAL_SCOPE });
        this.conversations.linkTopic(OWNER, { conversationId: conversation.conversationId, topicId: topic.topicId, expectedConversationRevision: conversation.revision, expectedTopicRevision: topic.revision });
        const reply = this.conversations.ensureReplyBinding(OWNER, { conversationId: conversation.conversationId, topicId: topic.topicId });
        binding = { localKey, conversationId: conversation.conversationId, topicId: topic.topicId, bindingId: reply.bindingId };
        this.db.prepare('INSERT INTO shiyu_local_conversations VALUES(?,?,?,?)').run(localKey, binding.conversationId, binding.topicId, binding.bindingId);
      }
      this.conversations.linkReference(OWNER, { topicId: binding.topicId, expectedRevision: this.conversations.getTopic(OWNER, binding.topicId).revision, reference: { kind: 'task', id: taskId } });
      this.options.events.subscribe({ id: `conversation-task-success:${taskId}`, types: ['task.succeeded'], scope: LOCAL_SCOPE,
        target: { kind: 'component', handlerRef: CONVERSATION_BACKGROUND_HANDLER }, deliveryMode: 'component',
        start: { kind: 'replay', afterSequence: 0, limit: 1 }, filter: { taskId }, maxAttempts: 5 });
      return this.entry(binding, this.options.events.listSubscriptions());
    });
  }
  snapshotLocal(input: ConversationCommands['conversation.snapshotLocal']['input']): LocalConversationSnapshot {
    fields(input, ['conversationId'], []);
    if (input.conversationId !== undefined) text(input.conversationId, 'conversationId');
    return this.tx.atomic(() => {
      const bindings = this.bindings(input.conversationId);
      if (input.conversationId && !bindings.length) fail('UNKNOWN_CONVERSATION', 'No managed local conversation has this identity');
      const subscriptions = this.options.events.listSubscriptions(), stats = this.options.events.stats();
      const { subscriptions: count, pending, claimed, acknowledged, failed, cancelled } = stats;
      return { schemaVersion: 1, scope: LOCAL_SCOPE, conversations: bindings.map(binding => this.entry(binding, subscriptions)),
        background: { subscriptions: count, pending, claimed, acknowledged, failed, cancelled } };
    });
  }
  consumeBackground(input: ConversationCommands['conversation.consumeBackground']['input']): BackgroundConsumptionResult {
    fields(input, ['limit'], []); const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) fail('INVALID_SCHEMA', 'Background batch limit must be between 1 and 20');
    // Persist attempts independently. Projection failures must not roll the claim attempt back forever.
    const claims = this.options.events.claim({ consumerId: CONVERSATION_BACKGROUND_HANDLER, deliveryMode: 'component', limit, leaseMs: 30000 });
    const result: BackgroundConsumptionResult = { claimed: claims.length, acknowledged: 0, duplicate: 0, failed: 0, deliveries: [] };
    for (const claim of claims) {
      const receipt = { deliveryId: claim.deliveryId, claimToken: claim.claimToken };
      try {
        const background = this.tx.atomic(() => {
          const { delivery, event } = this.options.events.inspectClaim(receipt);
          if (delivery.target.kind !== 'component' || delivery.target.handlerRef !== CONVERSATION_BACKGROUND_HANDLER || delivery.deliveryMode !== 'component'
            || event.type !== 'task.succeeded' || event.schemaVersion !== 1 || event.scope !== LOCAL_SCOPE
            || event.actor.kind !== 'component' || event.actor.principalId !== 'task-service') fail('UNTRUSTED_BACKGROUND_EVENT', 'Background completion must come from the trusted Task service');
          fields(event.payload, ['taskId']); const taskId = text(event.payload.taskId, 'taskId');
          const task = this.options.getTask(taskId);
          if (task.state !== 'succeeded') fail('UNVERIFIED_TASK', 'A published observation cannot establish Task completion');
          // v1 is one immutable verified-success fact per Task, not the global Event sequence or Task aggregate revision.
          const projected = this.conversations.recordBackgroundUpdate(PROJECTOR, { eventId: event.eventId, scope: LOCAL_SCOPE,
            reference: { kind: 'task', id: taskId }, sourceVersion: 1, evidenceRef: `event:${event.eventId}` });
          this.options.events.ack(receipt); return projected;
        });
        result.acknowledged++; if (background.status === 'duplicate') result.duplicate++;
        result.deliveries.push({ deliveryId: claim.deliveryId, eventId: claim.eventId, status: 'acked', backgroundStatus: background.status });
      } catch (error) {
        this.tx.assertUsable(); // Unknown transaction outcomes quarantine the store; never claim a clean per-delivery failure.
        let status: 'retrying' | 'failed' | 'stale';
        try { const delivery = this.options.events.fail({ ...receipt, error: errorCode(error), retryAfterMs: 1000 }); status = delivery.status === 'failed' ? 'failed' : 'retrying'; }
        catch (receiptError) {
          this.tx.assertUsable();
          if (!['STALE_CLAIM', 'FORBIDDEN'].includes(errorCode(receiptError))) throw receiptError;
          status = 'stale';
        }
        result.failed++; result.deliveries.push({ deliveryId: claim.deliveryId, eventId: claim.eventId, status, errorCode: errorCode(error) });
      }
    }
    return result;
  }
  execute(request: ConversationDomainRequest): unknown {
    if (request.command.startsWith('conversation.reply.')) return this.replies.execute(request as LocalReplyDomainRequest);
    switch (request.command) {
      case 'conversation.ensureLocalTask': return this.ensureLocalTask(request.args);
      case 'conversation.ensureLabChannel': return this.ensureLabChannel(request.args);
      case 'conversation.consumeBackground': return this.consumeBackground(request.args);
      case 'conversation.snapshotLocal': return this.snapshotLocal(request.args);
    }
  }
}
