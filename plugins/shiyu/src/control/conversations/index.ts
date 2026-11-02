import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAsyncFunction, isPromise } from "node:util/types";
import type { SqliteTransactions } from "../../adapters/control-store/transaction.js";
import type {
  BackgroundReceipt, BackgroundUpdate, BusinessReference, ContextAcknowledgement, ContextSnapshot, ContextToken, ConversationActor,
  ConversationBindingVersion, ConversationKey, ConversationPermission, ConversationRecord, ConversationStoreOptions,
  PendingBackground, ReplyBinding, ReplyDraft, SourceVersion, TopicRecord, TopicRelation,
} from "./types.js";
export type * from "./types.js";

type Tx = Pick<SqliteTransactions, "atomic" | "owns" | "assertUsable">;
type Row = Record<string, unknown>;
type TopicLink = { conversationId: string; topicId: string; active: boolean };
type SourceRecord = SourceVersion & { eventId: string; evidenceRef: string; gap: boolean };
export class ConversationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ConversationError"; }
}
const fail = (code: string, message: string): never => { throw new ConversationError(code, message); };
const clone = <T>(value: T): T => structuredClone(value);
const referenceKey = (ref: BusinessReference) => JSON.stringify([ref.kind, ref.id]);
const businessId = (binding: Pick<ReplyBinding, "conversationId" | "topicId" | "sessionEpoch">) =>
  `conversation:${binding.conversationId}:reply:${digest([binding.topicId ?? null, binding.sessionEpoch])}`;
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function text(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail("INVALID_SCHEMA", `Invalid ${field}`);
  return value as string;
}
function integer(value: unknown, field: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail("INVALID_SCHEMA", `Invalid ${field}`);
  return value as number;
}
function fields(value: unknown, allowed: string[], required = allowed): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_SCHEMA", "Expected a bounded command object");
  if (Object.keys(value as object).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value as object, key))) fail("INVALID_SCHEMA", "Unknown or missing command fields");
}
function reference(value: BusinessReference): BusinessReference {
  fields(value, ["kind", "id"]);
  if (!["task", "goal", "source"].includes(value.kind)) fail("INVALID_SCHEMA", "Unknown business reference kind");
  return { kind: value.kind, id: text(value.id, "reference.id") };
}
function evidence(value: string[]): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) fail("INVALID_SCHEMA", "Explicit relationship changes require bounded evidence references");
  return [...new Set(value.map(item => text(item, "evidenceRef")))].sort();
}

/**
 * Business routing and context invalidation only. No native Session history, inbox,
 * model execution or channel sending. All writes share the existing DB transaction owner.
 */
export class ConversationStore {
  private readonly owners: Set<string>;
  private readonly permissions: Record<string, ConversationPermission[]>;
  constructor(private readonly db: DatabaseSync, private readonly tx: Tx, private readonly options: ConversationStoreOptions) {
    if (!tx.owns(db)) throw new Error("Conversations and transactions must share one SQLite connection");
    if (isAsyncFunction(options.authorizeReference)) throw new Error("Reference authorization must be synchronous");
    this.owners = new Set(options.ownerIds.map(id => text(id, "ownerId")));
    this.permissions = clone(options.componentPermissions);
    for (const [id, permissions] of Object.entries(this.permissions)) {
      text(id, "componentId");
      if (!Array.isArray(permissions) || permissions.some(p => !["read", "manage", "background", "reply"].includes(p))) fail("INVALID_SCHEMA", "Invalid configured component permissions");
    }
    tx.atomic(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS shiyu_conversation_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL);
        INSERT OR IGNORE INTO shiyu_conversation_meta VALUES(1,1);
        CREATE TABLE IF NOT EXISTS shiyu_conversations(id TEXT PRIMARY KEY,binding_key TEXT NOT NULL UNIQUE,scope TEXT NOT NULL,record_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_topics(id TEXT PRIMARY KEY,scope TEXT NOT NULL,record_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_topic_links(conversation_id TEXT NOT NULL,topic_id TEXT NOT NULL,scope TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(conversation_id,topic_id));
        CREATE TABLE IF NOT EXISTS shiyu_topic_references(topic_id TEXT NOT NULL,ref_key TEXT NOT NULL,scope TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(topic_id,ref_key));
        CREATE TABLE IF NOT EXISTS shiyu_topic_relations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,input_hash TEXT NOT NULL,record_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_reply_bindings(id TEXT PRIMARY KEY,binding_key TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,scope TEXT NOT NULL,record_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_reply_sessions(session_id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,epoch INTEGER NOT NULL,scope TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shiyu_reply_source_cursors(binding_id TEXT NOT NULL,ref_key TEXT NOT NULL,source_version INTEGER NOT NULL,PRIMARY KEY(binding_id,ref_key));
        CREATE TABLE IF NOT EXISTS shiyu_background_sources(scope TEXT NOT NULL,ref_key TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(scope,ref_key));
        CREATE TABLE IF NOT EXISTS shiyu_background_events(scope TEXT NOT NULL,event_id TEXT NOT NULL,input_hash TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(scope,event_id));
        CREATE TABLE IF NOT EXISTS shiyu_background_pending(binding_id TEXT NOT NULL,ref_key TEXT NOT NULL,context_version INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(binding_id,ref_key));
        CREATE TABLE IF NOT EXISTS shiyu_conversation_generations(conversation_id TEXT NOT NULL,event_id TEXT NOT NULL,input_hash TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(conversation_id,event_id));
        CREATE TABLE IF NOT EXISTS shiyu_reply_drafts(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,binding_id TEXT NOT NULL,scope TEXT NOT NULL,record_json TEXT NOT NULL);
      `);
      if (db.prepare("SELECT schema_version FROM shiyu_conversation_meta WHERE id=1").get()!.schema_version !== 1) fail("INCOMPATIBLE_VERSION", "Unsupported conversation schema");
    });
  }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  private rows<T>(sql: string, ...values: string[]): T[] {
    this.tx.assertUsable(); return (this.db.prepare(sql).all(...values) as Row[]).map(row => JSON.parse(String(row.record_json)) as T);
  }
  private one<T>(table: string, id: string): T {
    text(id, "identity");
    return this.rows<T>(`SELECT record_json FROM ${table} WHERE id=?`, id)[0] ?? fail("NOT_FOUND", "Requested conversation record is unavailable");
  }
  private save(table: string, id: string, value: unknown): void {
    this.tx.assertUsable(); this.db.prepare(`UPDATE ${table} SET record_json=? WHERE id=?`).run(JSON.stringify(value), id);
  }
  private authorize(actor: ConversationActor, scope: string, permission: ConversationPermission): void {
    this.tx.assertUsable(); text(scope, "scope"); text(actor?.principalId, "principalId");
    if (!Array.isArray(actor.scopes) || !actor.scopes.includes(scope)) fail("FORBIDDEN", "Conversation audience is not authorized");
    if (actor.kind === "owner" && this.owners.has(actor.principalId)) return;
    if (actor.kind === "component" && this.permissions[actor.principalId]?.includes(permission)) return;
    fail("FORBIDDEN", "Principal does not have this conversation capability");
  }
  private canReference(actor: ConversationActor, scope: string, ref: BusinessReference, access: "read" | "link" | "background"): boolean {
    const result = this.options.authorizeReference({ actor: clone(actor), scope, reference: clone(ref), access });
    if (isPromise(result)) { void result.catch(() => undefined); fail("ASYNC_AUTHORIZATION", "Reference authorization must not await external work"); }
    if (typeof result !== "boolean") fail("INVALID_AUTHORIZATION", "Reference authorization must return a boolean");
    return result;
  }
  private requireReference(actor: ConversationActor, scope: string, ref: BusinessReference, access: "read" | "link" | "background"): void {
    if (!this.canReference(actor, scope, ref, access)) fail("FORBIDDEN_REFERENCE", "Business reference is not authorized for this audience");
  }
  private cas(actual: number, expected: number): void { integer(expected, "expectedRevision", 1); if (actual !== expected) fail("VERSION_CONFLICT", "Conversation routing revision changed"); }
  private conversation(id: string): ConversationRecord { return this.one("shiyu_conversations", id); }
  private topic(id: string): TopicRecord { return this.one("shiyu_topics", id); }
  private binding(id: string): ReplyBinding { return this.one("shiyu_reply_bindings", id); }
  private scopedConversation(actor: ConversationActor, id: string, permission: ConversationPermission): ConversationRecord {
    const result = this.conversation(id); this.authorize(actor, result.key.scope, permission); return result;
  }
  private scopedTopic(actor: ConversationActor, id: string, permission: ConversationPermission): TopicRecord {
    const result = this.topic(id); this.authorize(actor, result.scope, permission); return result;
  }
  private scopedBinding(actor: ConversationActor, id: string, permission: ConversationPermission, active = false): ReplyBinding {
    const result = this.binding(id); this.authorize(actor, result.scope, permission);
    const conversation = this.conversation(result.conversationId);
    if (active && (conversation.archived || (result.topicId && !this.linked(conversation.conversationId, result.topicId)))) fail("INACTIVE_BINDING", "Reply binding is archived or detached");
    return result;
  }
  private linked(conversationId: string, topicId: string): boolean {
    return this.rows<TopicLink>("SELECT record_json FROM shiyu_topic_links WHERE conversation_id=? AND topic_id=?", conversationId, topicId)[0]?.active === true;
  }
  private canonicalTopic(id: string): string {
    const seen = new Set<string>(); let current = this.topic(id);
    while (current.canonicalTopicId) {
      if (seen.has(current.topicId)) fail("CORRUPT_RELATION", "Topic aliases contain a cycle");
      seen.add(current.topicId); const next = this.topic(current.canonicalTopicId);
      if (next.scope !== current.scope) fail("CORRUPT_RELATION", "Topic alias crosses an audience");
      current = next;
    }
    return current.topicId;
  }
  private cluster(id: string): string[] {
    const topic = this.topic(id), canonical = this.canonicalTopic(id);
    return this.rows<TopicRecord>("SELECT record_json FROM shiyu_topics WHERE scope=?", topic.scope).filter(item => this.canonicalTopic(item.topicId) === canonical).map(item => item.topicId);
  }
  private bindingTopics(binding: ReplyBinding): string[] {
    if (binding.topicId) return this.linked(binding.conversationId, binding.topicId) ? this.cluster(binding.topicId) : [];
    return [...new Set(this.rows<TopicLink>("SELECT record_json FROM shiyu_topic_links WHERE conversation_id=?", binding.conversationId)
      .filter(link => link.active).flatMap(link => this.cluster(link.topicId)))];
  }
  private references(binding: ReplyBinding): BusinessReference[] {
    const found = new Map<string, BusinessReference>();
    for (const id of this.bindingTopics(binding)) for (const ref of this.rows<BusinessReference>("SELECT record_json FROM shiyu_topic_references WHERE topic_id=?", id)) found.set(referenceKey(ref), ref);
    return [...found.values()].sort((a, b) => referenceKey(a).localeCompare(referenceKey(b)));
  }
  private source(scope: string, ref: BusinessReference): SourceRecord | undefined {
    return this.rows<SourceRecord>("SELECT record_json FROM shiyu_background_sources WHERE scope=? AND ref_key=?", scope, referenceKey(ref))[0];
  }
  private writeBinding(binding: ReplyBinding): void { binding.revision++; binding.updatedAt = this.now(); this.save("shiyu_reply_bindings", binding.bindingId, binding); }
  private changeRouting(bindings: ReplyBinding[], resetSession: boolean): void {
    const conversations = new Set<string>();
    for (const binding of new Map(bindings.map(item => [item.bindingId, item])).values()) {
      binding.routingRevision++;
      if (resetSession) {
        binding.sessionEpoch++; binding.businessId = businessId(binding); delete binding.sessionId; binding.syncedContextVersion = 0; binding.syncedRoutingRevision = 0;
        this.db.prepare("DELETE FROM shiyu_reply_source_cursors WHERE binding_id=?").run(binding.bindingId);
      }
      this.writeBinding(binding); conversations.add(binding.conversationId);
    }
    for (const id of conversations) this.bumpConversation(this.conversation(id));
  }
  private bumpConversation(conversation: ConversationRecord): ConversationRecord {
    conversation.revision++; conversation.conversationGeneration++; conversation.updatedAt = this.now();
    this.save("shiyu_conversations", conversation.conversationId, conversation); return conversation;
  }
  private bindingsForTopics(topicIds: string[], scope: string): ReplyBinding[] {
    const selected = new Set(topicIds);
    return this.rows<ReplyBinding>("SELECT record_json FROM shiyu_reply_bindings WHERE scope=?", scope)
      .filter(binding => this.bindingTopics(binding).some(id => selected.has(id)));
  }

  ensureConversation(actor: ConversationActor, key: ConversationKey): ConversationRecord {
    fields(key, ["connectionId", "platformConversationId", "threadId", "kind", "scope"], ["connectionId", "platformConversationId", "kind", "scope"]);
    this.authorize(actor, key.scope, "manage");
    const normalized: ConversationKey = { connectionId: text(key.connectionId, "connectionId"), platformConversationId: text(key.platformConversationId, "platformConversationId"),
      ...key.threadId !== undefined ? { threadId: text(key.threadId, "threadId") } : {}, kind: key.kind, scope: key.scope };
    if (!["direct", "group", "channel"].includes(key.kind)) fail("INVALID_SCHEMA", "Unknown conversation kind");
    return this.tx.atomic(() => {
      const bindingKey = digest(normalized);
      const previous = this.rows<ConversationRecord>("SELECT record_json FROM shiyu_conversations WHERE binding_key=?", bindingKey)[0];
      if (previous) return previous;
      const record: ConversationRecord = { conversationId: randomUUID(), key: normalized, revision: 1, audienceVersion: 1, conversationGeneration: 1, archived: false, createdAt: this.now(), updatedAt: this.now() };
      this.db.prepare("INSERT INTO shiyu_conversations VALUES(?,?,?,?)").run(record.conversationId, bindingKey, key.scope, JSON.stringify(record)); return record;
    });
  }
  getConversation(actor: ConversationActor, conversationId: string): ConversationRecord { return this.scopedConversation(actor, conversationId, "read"); }
  listConversations(actor: ConversationActor, scope: string): ConversationRecord[] { this.authorize(actor, scope, "read"); return this.rows("SELECT record_json FROM shiyu_conversations WHERE scope=? ORDER BY rowid", scope); }
  createTopic(actor: ConversationActor, input: { topicId: string; scope: string }): TopicRecord {
    fields(input, ["topicId", "scope"]); this.authorize(actor, input.scope, "manage"); text(input.topicId, "topicId");
    return this.tx.atomic(() => {
      const old = this.rows<TopicRecord>("SELECT record_json FROM shiyu_topics WHERE id=?", input.topicId)[0];
      if (old) { if (old.scope !== input.scope) fail("IDEMPOTENCY_CONFLICT", "Topic identity already exists"); return old; }
      const topic: TopicRecord = { ...input, revision: 1, createdAt: this.now(), updatedAt: this.now() };
      this.db.prepare("INSERT INTO shiyu_topics VALUES(?,?,?)").run(topic.topicId, topic.scope, JSON.stringify(topic)); return topic;
    });
  }
  getTopic(actor: ConversationActor, topicId: string): TopicRecord { return this.scopedTopic(actor, topicId, "read"); }
  linkTopic(actor: ConversationActor, input: { conversationId: string; topicId: string; expectedConversationRevision: number; expectedTopicRevision: number }): void {
    fields(input, ["conversationId", "topicId", "expectedConversationRevision", "expectedTopicRevision"]);
    this.tx.atomic(() => {
      const conversation = this.scopedConversation(actor, input.conversationId, "manage"), topic = this.scopedTopic(actor, input.topicId, "manage");
      if (conversation.key.scope !== topic.scope) fail("CROSS_SCOPE", "Topic links cannot cross audience boundaries");
      if (this.linked(conversation.conversationId, topic.topicId)) return;
      this.cas(conversation.revision, input.expectedConversationRevision); this.cas(topic.revision, input.expectedTopicRevision);
      this.db.prepare("INSERT INTO shiyu_topic_links VALUES(?,?,?,?) ON CONFLICT(conversation_id,topic_id) DO UPDATE SET record_json=excluded.record_json").run(conversation.conversationId, topic.topicId, topic.scope, JSON.stringify({ conversationId: conversation.conversationId, topicId: topic.topicId, active: true }));
      const bindings = this.rows<ReplyBinding>("SELECT record_json FROM shiyu_reply_bindings WHERE conversation_id=?", conversation.conversationId).filter(binding => !binding.topicId || binding.topicId === topic.topicId);
      if (bindings.length) this.changeRouting(bindings, false); else this.bumpConversation(conversation);
    });
  }
  detachTopic(actor: ConversationActor, input: { conversationId: string; topicId: string; expectedConversationRevision: number }): void {
    fields(input, ["conversationId", "topicId", "expectedConversationRevision"]);
    this.tx.atomic(() => {
      const conversation = this.scopedConversation(actor, input.conversationId, "manage"), topic = this.scopedTopic(actor, input.topicId, "manage");
      if (conversation.key.scope !== topic.scope) fail("CROSS_SCOPE", "Topic links cannot cross audience boundaries");
      this.cas(conversation.revision, input.expectedConversationRevision);
      if (!this.linked(input.conversationId, input.topicId)) return;
      this.db.prepare("UPDATE shiyu_topic_links SET record_json=? WHERE conversation_id=? AND topic_id=?").run(JSON.stringify({ conversationId: input.conversationId, topicId: input.topicId, active: false }), input.conversationId, input.topicId);
      const bindings = this.rows<ReplyBinding>("SELECT record_json FROM shiyu_reply_bindings WHERE conversation_id=?", conversation.conversationId).filter(binding => !binding.topicId || binding.topicId === topic.topicId);
      if (bindings.length) this.changeRouting(bindings, true); else this.bumpConversation(conversation);
    });
  }
  linkReference(actor: ConversationActor, input: { topicId: string; expectedRevision: number; reference: BusinessReference }): TopicRecord {
    fields(input, ["topicId", "expectedRevision", "reference"]); const ref = reference(input.reference);
    return this.tx.atomic(() => {
      const topic = this.scopedTopic(actor, input.topicId, "manage"); this.requireReference(actor, topic.scope, ref, "link");
      if (this.rows("SELECT record_json FROM shiyu_topic_references WHERE topic_id=? AND ref_key=?", topic.topicId, referenceKey(ref)).length) return topic;
      this.cas(topic.revision, input.expectedRevision);
      this.db.prepare("INSERT INTO shiyu_topic_references VALUES(?,?,?,?)").run(topic.topicId, referenceKey(ref), topic.scope, JSON.stringify(ref));
      topic.revision++; topic.updatedAt = this.now(); this.save("shiyu_topics", topic.topicId, topic);
      this.changeRouting(this.bindingsForTopics(this.cluster(topic.topicId), topic.scope), false); return topic;
    });
  }

  private existingRelation(actor: ConversationActor, id: string, scope: string, input: unknown): TopicRelation | undefined {
    this.authorize(actor, scope, "manage"); text(id, "relationId");
    const row = this.db.prepare("SELECT scope,input_hash,record_json FROM shiyu_topic_relations WHERE id=?").get(id);
    if (!row) return undefined;
    if (row.scope !== scope || row.input_hash !== digest(input)) fail("IDEMPOTENCY_CONFLICT", "Relationship command already names different content");
    return JSON.parse(String(row.record_json)) as TopicRelation;
  }
  private saveRelation(actor: ConversationActor, input: unknown, relation: Omit<TopicRelation, "actorId" | "createdAt">): TopicRelation {
    const row = { ...relation, actorId: actor.principalId, createdAt: this.now() };
    this.db.prepare("INSERT INTO shiyu_topic_relations VALUES(?,?,?,?)").run(row.relationId, row.scope, digest(input), JSON.stringify(row)); return row;
  }
  branchTopic(actor: ConversationActor, input: { relationId: string; topicId: string; newTopicId: string; expectedRevision: number; evidenceRefs: string[] }): TopicRelation {
    fields(input, ["relationId", "topicId", "newTopicId", "expectedRevision", "evidenceRefs"]); const refs = evidence(input.evidenceRefs);
    return this.tx.atomic(() => {
      const parent = this.scopedTopic(actor, input.topicId, "manage");
      const old = this.existingRelation(actor, input.relationId, parent.scope, input); if (old) return old;
      this.cas(parent.revision, input.expectedRevision); text(input.newTopicId, "newTopicId");
      if (this.rows("SELECT record_json FROM shiyu_topics WHERE id=?", input.newTopicId).length) fail("IDEMPOTENCY_CONFLICT", "Branch requires a new topic identity");
      const child = this.createTopic(actor, { topicId: input.newTopicId, scope: parent.scope }); child.parentTopicId = parent.topicId; this.save("shiyu_topics", child.topicId, child);
      parent.revision++; parent.updatedAt = this.now(); this.save("shiyu_topics", parent.topicId, parent);
      this.changeRouting(this.bindingsForTopics(this.cluster(parent.topicId), parent.scope), false);
      return this.saveRelation(actor, input, { relationId: input.relationId, scope: parent.scope, kind: "branch", fromTopicId: parent.topicId, toTopicId: child.topicId, evidenceRefs: refs });
    });
  }
  mergeTopics(actor: ConversationActor, input: { relationId: string; sourceTopicId: string; targetTopicId: string; expectedSourceRevision: number; expectedTargetRevision: number; evidenceRefs: string[] }): TopicRelation {
    fields(input, ["relationId", "sourceTopicId", "targetTopicId", "expectedSourceRevision", "expectedTargetRevision", "evidenceRefs"]); const refs = evidence(input.evidenceRefs);
    return this.tx.atomic(() => {
      const source = this.scopedTopic(actor, input.sourceTopicId, "manage"), target = this.scopedTopic(actor, input.targetTopicId, "manage");
      if (source.scope !== target.scope) fail("CROSS_SCOPE", "Topic merges cannot cross audience boundaries");
      const old = this.existingRelation(actor, input.relationId, source.scope, input); if (old) return old;
      this.cas(source.revision, input.expectedSourceRevision); this.cas(target.revision, input.expectedTargetRevision);
      if (source.topicId === target.topicId || source.canonicalTopicId || target.canonicalTopicId) fail("INVALID_RELATION", "Merge explicit canonical topic identities only");
      const bindings = this.bindingsForTopics([...this.cluster(source.topicId), ...this.cluster(target.topicId)], source.scope);
      source.canonicalTopicId = target.topicId; source.revision++; source.updatedAt = this.now(); target.revision++; target.updatedAt = this.now();
      this.save("shiyu_topics", source.topicId, source); this.save("shiyu_topics", target.topicId, target); this.changeRouting(bindings, false);
      return this.saveRelation(actor, input, { relationId: input.relationId, scope: source.scope, kind: "merge", fromTopicId: source.topicId, toTopicId: target.topicId, evidenceRefs: refs });
    });
  }
  separateTopic(actor: ConversationActor, input: { relationId: string; topicId: string; canonicalTopicId: string; expectedRevision: number; evidenceRefs: string[] }): TopicRelation {
    fields(input, ["relationId", "topicId", "canonicalTopicId", "expectedRevision", "evidenceRefs"]); const refs = evidence(input.evidenceRefs);
    return this.tx.atomic(() => {
      const topic = this.scopedTopic(actor, input.topicId, "manage"), canonical = this.scopedTopic(actor, input.canonicalTopicId, "manage");
      if (topic.scope !== canonical.scope) fail("CROSS_SCOPE", "Topic separation cannot cross audience boundaries");
      const old = this.existingRelation(actor, input.relationId, topic.scope, input); if (old) return old;
      this.cas(topic.revision, input.expectedRevision);
      if (topic.canonicalTopicId !== canonical.topicId) fail("INVALID_RELATION", "Topic no longer has that merge relationship");
      const bindings = this.bindingsForTopics(this.cluster(topic.topicId), topic.scope);
      delete topic.canonicalTopicId; topic.revision++; topic.updatedAt = this.now(); canonical.revision++; canonical.updatedAt = this.now();
      this.save("shiyu_topics", topic.topicId, topic); this.save("shiyu_topics", canonical.topicId, canonical);
      // Old native contexts may have seen the former merged references. Require a new business binding epoch.
      this.changeRouting(bindings, true);
      return this.saveRelation(actor, input, { relationId: input.relationId, scope: topic.scope, kind: "separate", fromTopicId: topic.topicId, toTopicId: canonical.topicId, evidenceRefs: refs });
    });
  }
  relations(actor: ConversationActor, topicId: string): TopicRelation[] {
    const topic = this.scopedTopic(actor, topicId, "read");
    return this.rows<TopicRelation>("SELECT record_json FROM shiyu_topic_relations WHERE scope=? ORDER BY rowid", topic.scope).filter(row => row.fromTopicId === topicId || row.toTopicId === topicId);
  }

  ensureReplyBinding(actor: ConversationActor, input: { conversationId: string; topicId?: string }): ReplyBinding {
    fields(input, ["conversationId", "topicId"], ["conversationId"]);
    if (input.topicId !== undefined) text(input.topicId, "topicId");
    return this.tx.atomic(() => {
      const conversation = this.scopedConversation(actor, input.conversationId, "manage");
      if (input.topicId) {
        const topic = this.scopedTopic(actor, input.topicId, "manage");
        if (topic.scope !== conversation.key.scope) fail("CROSS_SCOPE", "Session bindings cannot cross audience boundaries");
        if (!this.linked(conversation.conversationId, topic.topicId)) fail("INACTIVE_BINDING", "Link the topic to the conversation first");
      }
      const key = digest([conversation.conversationId, input.topicId ?? null, conversation.key.scope]);
      const old = this.rows<ReplyBinding>("SELECT record_json FROM shiyu_reply_bindings WHERE binding_key=?", key)[0]; if (old) return old;
      const base = { conversationId: conversation.conversationId, ...input.topicId ? { topicId: input.topicId } : {}, sessionEpoch: 1 };
      const binding: ReplyBinding = { ...base, bindingId: randomUUID(), scope: conversation.key.scope, revision: 1, routingRevision: 1,
        contextVersion: 0, syncedContextVersion: 0, syncedRoutingRevision: 0, businessId: businessId(base), createdAt: this.now(), updatedAt: this.now() };
      this.db.prepare("INSERT INTO shiyu_reply_bindings VALUES(?,?,?,?,?)").run(binding.bindingId, key, binding.conversationId, binding.scope, JSON.stringify(binding)); return binding;
    });
  }
  getReplyBinding(actor: ConversationActor, bindingId: string): ReplyBinding { return this.scopedBinding(actor, bindingId, "read"); }
  bindSession(actor: ConversationActor, input: { bindingId: string; expectedRevision: number; sessionEpoch: number; sessionId: string }): ReplyBinding {
    fields(input, ["bindingId", "expectedRevision", "sessionEpoch", "sessionId"]); text(input.sessionId, "sessionId");
    return this.tx.atomic(() => {
      const binding = this.scopedBinding(actor, input.bindingId, "reply", true);
      if (binding.sessionEpoch !== input.sessionEpoch) fail("STALE_CONTEXT", "Native Session binding epoch changed");
      if (binding.sessionId === input.sessionId) return binding;
      this.cas(binding.revision, input.expectedRevision);
      if (binding.sessionId || this.db.prepare("SELECT session_id FROM shiyu_reply_sessions WHERE session_id=?").get(input.sessionId)) fail("SESSION_BINDING_CONFLICT", "Native Session identity cannot be shared or reused after a context reset");
      this.db.prepare("INSERT INTO shiyu_reply_sessions VALUES(?,?,?,?)").run(input.sessionId, binding.bindingId, binding.sessionEpoch, binding.scope);
      binding.sessionId = input.sessionId; this.writeBinding(binding); return binding;
    });
  }
  version(actor: ConversationActor, bindingId: string): ConversationBindingVersion {
    return this.tx.atomic(() => {
      const binding = this.scopedBinding(actor, bindingId, "read", true), conversation = this.conversation(binding.conversationId);
      return { bindingId, conversationId: binding.conversationId, scope: binding.scope, audienceVersion: conversation.audienceVersion,
        conversationGeneration: conversation.conversationGeneration, routingRevision: binding.routingRevision, sessionEpoch: binding.sessionEpoch, contextVersion: binding.contextVersion };
    });
  }
  invalidateAudience(actor: ConversationActor, input: { conversationId: string; expectedRevision: number; reasonRef: string }): ConversationRecord {
    fields(input, ["conversationId", "expectedRevision", "reasonRef"]); text(input.reasonRef, "reasonRef");
    return this.tx.atomic(() => {
      const conversation = this.scopedConversation(actor, input.conversationId, "manage"); this.cas(conversation.revision, input.expectedRevision);
      conversation.audienceVersion++; conversation.lastAudienceChange = { reasonRef: input.reasonRef, at: this.now() };
      this.save("shiyu_conversations", conversation.conversationId, conversation);
      const bindings = this.rows<ReplyBinding>("SELECT record_json FROM shiyu_reply_bindings WHERE conversation_id=?", conversation.conversationId);
      if (bindings.length) this.changeRouting(bindings, true); else this.bumpConversation(conversation);
      return this.conversation(conversation.conversationId);
    });
  }
  setArchived(actor: ConversationActor, input: { conversationId: string; expectedRevision: number; archived: boolean }): ConversationRecord {
    fields(input, ["conversationId", "expectedRevision", "archived"]); if (typeof input.archived !== "boolean") fail("INVALID_SCHEMA", "archived must be boolean");
    return this.tx.atomic(() => {
      const conversation = this.scopedConversation(actor, input.conversationId, "manage"); this.cas(conversation.revision, input.expectedRevision);
      conversation.archived = input.archived; return this.bumpConversation(conversation);
    });
  }
  advanceGeneration(actor: ConversationActor, input: { conversationId: string; expectedRevision: number; eventId: string; reason: "input" | "interrupt" | "cancel" }): ConversationRecord {
    fields(input, ["conversationId", "expectedRevision", "eventId", "reason"]); text(input.eventId, "eventId");
    if (!["input", "interrupt", "cancel"].includes(input.reason)) fail("INVALID_SCHEMA", "Unknown generation cause");
    return this.tx.atomic(() => {
      const conversation = this.scopedConversation(actor, input.conversationId, "reply");
      const inputHash = digest({ eventId: input.eventId, reason: input.reason });
      const previous = this.db.prepare("SELECT input_hash,record_json FROM shiyu_conversation_generations WHERE conversation_id=? AND event_id=?").get(input.conversationId, input.eventId);
      if (previous) { if (previous.input_hash !== inputHash) fail("IDEMPOTENCY_CONFLICT", "Input event already advanced a different generation cause"); return JSON.parse(String(previous.record_json)) as ConversationRecord; }
      this.cas(conversation.revision, input.expectedRevision); this.bumpConversation(conversation);
      this.db.prepare("INSERT INTO shiyu_conversation_generations VALUES(?,?,?,?)").run(input.conversationId, input.eventId, inputHash, JSON.stringify(conversation)); return conversation;
    });
  }

  recordBackgroundUpdate(actor: ConversationActor, input: BackgroundUpdate): BackgroundReceipt {
    fields(input, ["eventId", "scope", "reference", "sourceVersion", "evidenceRef"]);
    this.authorize(actor, input.scope, "background"); const ref = reference(input.reference);
    text(input.eventId, "eventId"); text(input.evidenceRef, "evidenceRef"); integer(input.sourceVersion, "sourceVersion", 1);
    return this.tx.atomic(() => {
      this.requireReference(actor, input.scope, ref, "background");
      const hash = digest(input), previous = this.db.prepare("SELECT input_hash,record_json FROM shiyu_background_events WHERE scope=? AND event_id=?").get(input.scope, input.eventId);
      if (previous) {
        if (previous.input_hash !== hash) fail("IDEMPOTENCY_CONFLICT", "Background event already identifies different content");
        return { ...JSON.parse(String(previous.record_json)) as BackgroundReceipt, status: "duplicate" };
      }
      const current = this.source(input.scope, ref), affectedBindingIds: string[] = [];
      const obsolete = current !== undefined && input.sourceVersion <= current.sourceVersion;
      if (!obsolete) {
        const source: SourceRecord = { reference: ref, sourceVersion: input.sourceVersion, eventId: input.eventId, evidenceRef: input.evidenceRef, gap: input.sourceVersion > (current?.sourceVersion ?? 0) + 1 };
        this.db.prepare("INSERT INTO shiyu_background_sources VALUES(?,?,?) ON CONFLICT(scope,ref_key) DO UPDATE SET record_json=excluded.record_json").run(input.scope, referenceKey(ref), JSON.stringify(source));
        for (const binding of this.rows<ReplyBinding>("SELECT record_json FROM shiyu_reply_bindings WHERE scope=?", input.scope)) {
          if (!this.references(binding).some(value => referenceKey(value) === referenceKey(ref))) continue;
          binding.contextVersion++; this.writeBinding(binding); affectedBindingIds.push(binding.bindingId);
          const previousPending = this.rows<PendingBackground>("SELECT record_json FROM shiyu_background_pending WHERE binding_id=? AND ref_key=?", binding.bindingId, referenceKey(ref))[0];
          const pending: PendingBackground = { contextVersion: binding.contextVersion, eventId: input.eventId, reference: ref, sourceVersion: input.sourceVersion, evidenceRef: input.evidenceRef, gap: source.gap || previousPending?.gap === true };
          this.db.prepare("INSERT INTO shiyu_background_pending VALUES(?,?,?,?) ON CONFLICT(binding_id,ref_key) DO UPDATE SET context_version=excluded.context_version,record_json=excluded.record_json").run(binding.bindingId, referenceKey(ref), binding.contextVersion, JSON.stringify(pending));
        }
      }
      const receipt: BackgroundReceipt = { eventId: input.eventId, scope: input.scope, status: obsolete ? "obsolete" : "recorded", affectedBindingIds };
      this.db.prepare("INSERT INTO shiyu_background_events VALUES(?,?,?,?)").run(input.scope, input.eventId, hash, JSON.stringify(receipt)); return receipt;
    });
  }
  contextSnapshot(actor: ConversationActor, bindingId: string): ContextSnapshot {
    return this.tx.atomic(() => {
      const binding = this.scopedBinding(actor, bindingId, "read", true);
      const allowed = this.references(binding).filter(ref => this.canReference(actor, binding.scope, ref, "read"));
      const keys = new Set(allowed.map(referenceKey));
      const pending = this.rows<PendingBackground>("SELECT record_json FROM shiyu_background_pending WHERE binding_id=? ORDER BY context_version", bindingId).filter(item => keys.has(referenceKey(item.reference)));
      const sources = allowed.map(ref => ({ reference: ref, sourceVersion: this.source(binding.scope, ref)?.sourceVersion ?? 0 }));
      const cursors = new Map((this.db.prepare("SELECT ref_key,source_version FROM shiyu_reply_source_cursors WHERE binding_id=?").all(bindingId) as { ref_key: string; source_version: number }[])
        .map(row => [row.ref_key, row.source_version]));
      const unreadSource = sources.some(source => !cursors.has(referenceKey(source.reference)) || cursors.get(referenceKey(source.reference))! < source.sourceVersion);
      return { token: this.version(actor, bindingId), sources,
        pending, needsSync: unreadSource || pending.length > 0 || binding.contextVersion > binding.syncedContextVersion || binding.routingRevision > binding.syncedRoutingRevision };
    });
  }
  ackContext(actor: ConversationActor, input: ContextAcknowledgement): ReplyBinding {
    fields(input, ["token", "sources"]); const token = input.token;
    fields(token, ["bindingId", "conversationId", "scope", "audienceVersion", "conversationGeneration", "routingRevision", "sessionEpoch", "contextVersion"]);
    if (!Array.isArray(input.sources) || input.sources.length > 256) fail("INVALID_SCHEMA", "Context acknowledgements require bounded observed source versions");
    return this.tx.atomic(() => {
      const binding = this.scopedBinding(actor, token.bindingId, "reply", true); this.assertToken(actor, token, false);
      integer(token.contextVersion, "contextVersion");
      if (token.contextVersion > binding.contextVersion) fail("STALE_CONTEXT", "Cannot acknowledge an unseen future context version");
      const available = new Set(this.references(binding).map(referenceKey));
      for (const source of input.sources) {
        fields(source, ["reference", "sourceVersion"]); const ref = reference(source.reference); integer(source.sourceVersion, "sourceVersion");
        this.requireReference(actor, binding.scope, ref, "read");
        if (!available.has(referenceKey(ref)) || source.sourceVersion > (this.source(binding.scope, ref)?.sourceVersion ?? 0)) fail("STALE_CONTEXT", "Context acknowledgement names an unrelated or future source");
        this.db.prepare("INSERT INTO shiyu_reply_source_cursors VALUES(?,?,?) ON CONFLICT(binding_id,ref_key) DO UPDATE SET source_version=MAX(source_version,excluded.source_version)")
          .run(binding.bindingId, referenceKey(ref), source.sourceVersion);
        this.db.prepare("DELETE FROM shiyu_background_pending WHERE binding_id=? AND ref_key=? AND context_version<=? AND json_extract(record_json,'$.sourceVersion')<=?")
          .run(binding.bindingId, referenceKey(ref), token.contextVersion, source.sourceVersion);
      }
      binding.syncedContextVersion = Math.max(binding.syncedContextVersion, token.contextVersion); binding.syncedRoutingRevision = binding.routingRevision;
      this.writeBinding(binding); return binding;
    });
  }
  private assertToken(actor: ConversationActor, token: ContextToken, dependencies = true): void {
    const current = this.version(actor, token.bindingId);
    for (const key of ["conversationId", "scope", "audienceVersion", "conversationGeneration", "routingRevision", "sessionEpoch"] as const) {
      if (current[key] !== token[key]) fail("STALE_CONTEXT", "Conversation audience, generation or routing changed");
    }
    if (dependencies && token.contextVersion > current.contextVersion) fail("STALE_CONTEXT", "Invalid future context version");
  }
  beginReply(actor: ConversationActor, input: { draftId: string; bindingId: string; dependencies: BusinessReference[] }): ReplyDraft {
    fields(input, ["draftId", "bindingId", "dependencies"]); text(input.draftId, "draftId");
    if (!Array.isArray(input.dependencies) || input.dependencies.length > 64) fail("INVALID_SCHEMA", "Reply dependencies must be bounded references");
    const refs = input.dependencies.map(reference); if (new Set(refs.map(referenceKey)).size !== refs.length) fail("INVALID_SCHEMA", "Duplicate reply dependencies");
    return this.tx.atomic(() => {
      const binding = this.scopedBinding(actor, input.bindingId, "reply", true);
      if (this.rows("SELECT record_json FROM shiyu_reply_drafts WHERE id=?", input.draftId).length) fail("IDEMPOTENCY_CONFLICT", "Draft identity already exists");
      const available = new Set(this.references(binding).map(referenceKey));
      for (const ref of refs) { if (!available.has(referenceKey(ref))) fail("UNRELATED_REFERENCE", "Reply dependency is not linked to this audience binding"); this.requireReference(actor, binding.scope, ref, "read"); }
      for (const draft of this.rows<ReplyDraft>("SELECT record_json FROM shiyu_reply_drafts WHERE conversation_id=?", binding.conversationId)) {
        if (draft.status !== "generating") continue;
        try { this.assertCurrent(actor, draft); fail("CONVERSATION_BUSY", "A reply is already generating for this conversation"); }
        catch (error) { if (!(error instanceof ConversationError) || !["STALE_CONTEXT", "STALE_DRAFT", "INACTIVE_BINDING", "FORBIDDEN_REFERENCE"].includes(error.code)) throw error; }
      }
      const draft: ReplyDraft = { draftId: input.draftId, bindingId: binding.bindingId, conversationId: binding.conversationId, scope: binding.scope, token: this.version(actor, binding.bindingId),
        dependencies: refs.map(ref => ({ reference: ref, sourceVersion: this.source(binding.scope, ref)?.sourceVersion ?? 0 })), status: "generating", createdAt: this.now(), updatedAt: this.now() };
      this.db.prepare("INSERT INTO shiyu_reply_drafts VALUES(?,?,?,?,?)").run(draft.draftId, draft.conversationId, draft.bindingId, draft.scope, JSON.stringify(draft)); return draft;
    });
  }
  private assertCurrent(actor: ConversationActor, draft: ReplyDraft): void {
    this.authorize(actor, draft.scope, "reply"); this.scopedBinding(actor, draft.bindingId, "reply", true); this.assertToken(actor, draft.token);
    if (draft.status === "abandoned") fail("STALE_DRAFT", "Reply generation was abandoned");
    const binding = this.binding(draft.bindingId), available = new Set(this.references(binding).map(referenceKey));
    for (const dependency of draft.dependencies) {
      this.requireReference(actor, draft.scope, dependency.reference, "read");
      if (!available.has(referenceKey(dependency.reference)) || (this.source(draft.scope, dependency.reference)?.sourceVersion ?? 0) !== dependency.sourceVersion) fail("STALE_DRAFT", "A reply dependency changed");
    }
  }
  completeReply(actor: ConversationActor, input: { draftId: string; draftRef: string }): ReplyDraft {
    fields(input, ["draftId", "draftRef"]); text(input.draftRef, "draftRef");
    return this.tx.atomic(() => {
      const draft = this.one<ReplyDraft>("shiyu_reply_drafts", input.draftId); this.assertCurrent(actor, draft);
      if (draft.status === "ready" && draft.draftRef !== input.draftRef) fail("IDEMPOTENCY_CONFLICT", "Draft reference cannot change");
      draft.status = "ready"; draft.draftRef = input.draftRef; draft.updatedAt = this.now(); this.save("shiyu_reply_drafts", draft.draftId, draft); return draft;
    });
  }
  assertDraftCurrent(actor: ConversationActor, draftId: string): ReplyDraft {
    const draft = this.one<ReplyDraft>("shiyu_reply_drafts", draftId); this.assertCurrent(actor, draft);
    if (draft.status !== "ready") fail("DRAFT_NOT_READY", "No completed draft reference is available");
    return draft;
  }
  abandonReply(actor: ConversationActor, draftId: string): void {
    this.tx.atomic(() => {
      const draft = this.one<ReplyDraft>("shiyu_reply_drafts", draftId); this.authorize(actor, draft.scope, "reply");
      draft.status = "abandoned"; draft.updatedAt = this.now(); this.save("shiyu_reply_drafts", draftId, draft);
    });
  }
}
