import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SqliteTransactions } from "../src/adapters/control-store/transaction.js";
import { ConversationStore, type BackgroundUpdate, type BusinessReference, type ConversationActor, type ConversationKey,
  type ConversationStoreOptions, type ReplyBinding } from "../src/control/conversations/index.js";

const owner: ConversationActor = { principalId: "owner", kind: "owner", scopes: ["team", "private-a", "private-b"] };
const router: ConversationActor = { principalId: "router", kind: "component", scopes: owner.scopes };
const component: ConversationActor = { principalId: "updates", kind: "component", scopes: owner.scopes };
const replyer: ConversationActor = { principalId: "reply-coordinator", kind: "component", scopes: owner.scopes };
const X: BusinessReference = { kind: "task", id: "task-x" };
const Y: BusinessReference = { kind: "source", id: "source-y" };
const key = (scope = "team", patch: Partial<ConversationKey> = {}): ConversationKey => ({ connectionId: "stable-connection", platformConversationId: "platform-chat", kind: scope === "team" ? "group" : "direct", scope, ...patch });
const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "shiyu-conversations-"));
  const filename = join(directory, "control.sqlite");
  const handles: DatabaseSync[] = [];
  const revoked = new Set<string>(); let time = 0;
  const options: ConversationStoreOptions = {
    ownerIds: ["owner"], componentPermissions: { router: ["read", "manage", "reply"], updates: ["background", "read"], "reply-coordinator": ["read", "reply"] },
    authorizeReference: ({ scope, reference }) => !revoked.has(`${scope}:${reference.kind}:${reference.id}`),
    now: () => new Date(Date.UTC(2026, 10, 2, 12, 0, 0, time++)),
  };
  const open = () => { const db = new DatabaseSync(filename); db.exec("PRAGMA busy_timeout=10000"); handles.push(db); const tx = new SqliteTransactions(db); return { db, tx, store: new ConversationStore(db, tx, options) }; };
  t.after(() => { for (const db of handles) { try { db.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open, options, revoked };
}
function binding(store: ConversationStore, scope = "team", topicId = "topic-a", chatId = "platform-chat"): ReplyBinding {
  const conversation = store.ensureConversation(owner, key(scope, { platformConversationId: chatId }));
  const topic = store.createTopic(owner, { topicId, scope });
  store.linkTopic(owner, { conversationId: conversation.conversationId, topicId, expectedConversationRevision: conversation.revision, expectedTopicRevision: topic.revision });
  return store.ensureReplyBinding(owner, { conversationId: conversation.conversationId, topicId });
}
function ref(store: ConversationStore, topicId: string, reference: BusinessReference) {
  return store.linkReference(owner, { topicId, reference, expectedRevision: store.getTopic(owner, topicId).revision });
}
function update(store: ConversationStore, eventId: string, reference = X, sourceVersion = 1, scope = "team") {
  return store.recordBackgroundUpdate(component, { eventId, scope, reference, sourceVersion, evidenceRef: `event:${eventId}` });
}
function bindNative(store: ConversationStore, initial: ReplyBinding, sessionId: string) {
  const current = store.getReplyBinding(owner, initial.bindingId);
  return store.bindSession(replyer, { bindingId: current.bindingId, expectedRevision: current.revision, sessionEpoch: current.sessionEpoch, sessionId });
}

test("stable conversation keys and native references survive reopening without copying Session history", t => {
  const h = fixture(t); const a = binding(h.store); bindNative(h.store, a, "native-a");
  const before = h.store.getConversation(owner, a.conversationId);
  const fresh = h.open();
  assert.deepEqual(fresh.store.ensureConversation(owner, key()), before);
  const reused = fresh.store.ensureReplyBinding(owner, { conversationId: a.conversationId, topicId: "topic-a" });
  assert.equal(reused.bindingId, a.bindingId); assert.equal(reused.businessId, a.businessId); assert.equal(reused.sessionId, "native-a");
  assert.notEqual(fresh.store.ensureConversation(owner, key("team", { threadId: "native-thread" })).conversationId, a.conversationId);
  assert.notEqual(fresh.store.ensureConversation(owner, key("private-a")).conversationId, a.conversationId);
  const tables = (h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
  assert.ok(tables.every(name => !/history|inbox|message/.test(name)));
});

test("default and literally named default topic bindings have distinct native business identities", t => {
  const { store } = fixture(t); const topicBinding = binding(store, "team", "default");
  const defaultBinding = store.ensureReplyBinding(owner, { conversationId: topicBinding.conversationId });
  assert.notEqual(defaultBinding.bindingId, topicBinding.bindingId);
  assert.notEqual(defaultBinding.businessId, topicBinding.businessId);
  bindNative(store, defaultBinding, "native-default"); bindNative(store, topicBinding, "native-topic-default");
  assert.equal(store.ensureReplyBinding(owner, { conversationId: topicBinding.conversationId }).businessId, defaultBinding.businessId);
  assert.throws(() => store.ensureReplyBinding(owner, { conversationId: topicBinding.conversationId, topicId: "" }), code("INVALID_SCHEMA"));
});

test("trusted identity, component capabilities and audience scope all constrain metadata access", t => {
  const { store } = fixture(t); const privateBinding = binding(store, "private-a", "private-topic");
  assert.throws(() => store.ensureConversation({ ...owner, principalId: "forged-owner" }, key()), code("FORBIDDEN"));
  assert.throws(() => store.ensureConversation(component, key()), code("FORBIDDEN"));
  assert.throws(() => store.getReplyBinding({ ...replyer, scopes: ["team"] }, privateBinding.bindingId), code("FORBIDDEN"));
  assert.throws(() => store.contextSnapshot({ ...router, scopes: ["private-b"] }, privateBinding.bindingId), code("FORBIDDEN"));
  assert.throws(() => store.ensureConversation(owner, { ...key(), actor: owner } as ConversationKey), code("INVALID_SCHEMA"));
  assert.throws(() => store.recordBackgroundUpdate({ ...component, kind: "agent" }, { eventId: "pretend", scope: "private-a", reference: X, sourceVersion: 1, evidenceRef: "event:pretend" }), code("FORBIDDEN"));
});

test("private scopes cannot merge or share native Sessions even for the same business Task", t => {
  const { store } = fixture(t); const a = binding(store, "private-a", "private-topic-a"), b = binding(store, "private-b", "private-topic-b");
  ref(store, "private-topic-a", X); ref(store, "private-topic-b", X);
  bindNative(store, a, "private-session-a");
  assert.notEqual(a.businessId, b.businessId);
  assert.throws(() => bindNative(store, b, "private-session-a"), code("SESSION_BINDING_CONFLICT"));
  assert.throws(() => store.mergeTopics(owner, { relationId: "cross", sourceTopicId: "private-topic-a", targetTopicId: "private-topic-b", expectedSourceRevision: 2, expectedTargetRevision: 2, evidenceRefs: ["owner:request"] }), code("CROSS_SCOPE"));
  assert.throws(() => store.linkTopic(owner, { conversationId: a.conversationId, topicId: "private-topic-b", expectedConversationRevision: store.getConversation(owner, a.conversationId).revision, expectedTopicRevision: 2 }), code("CROSS_SCOPE"));
  const receipt = update(store, "private-result", X, 1, "private-a");
  assert.deepEqual(receipt.affectedBindingIds, [a.bindingId]);
  assert.equal(store.contextSnapshot(owner, b.bindingId).token.contextVersion, 0);
  assert.equal(store.contextSnapshot(owner, b.bindingId).sources[0].sourceVersion, 0);
});

test("background updates only mark authorized linked contexts and preserve generation", t => {
  const { store } = fixture(t); const a = binding(store), b = binding(store, "team", "topic-a", "second-chat"), other = binding(store, "team", "topic-other", "third-chat");
  ref(store, "topic-a", X); ref(store, "topic-other", Y);
  const before = store.version(owner, a.bindingId);
  const receipt = update(store, "verified-task-complete");
  assert.deepEqual(new Set(receipt.affectedBindingIds), new Set([a.bindingId, b.bindingId]));
  const after = store.version(owner, a.bindingId);
  assert.equal(after.contextVersion, before.contextVersion + 1);
  assert.equal(after.conversationGeneration, before.conversationGeneration);
  assert.equal(after.routingRevision, before.routingRevision);
  assert.equal(store.version(owner, other.bindingId).contextVersion, 0);
  assert.equal(store.getReplyBinding(owner, a.bindingId).sessionId, undefined);
});

test("old context acknowledgement cannot consume newer or unread updates", t => {
  const { store } = fixture(t); const a = binding(store); ref(store, "topic-a", X); ref(store, "topic-a", Y);
  update(store, "x1"); const first = store.contextSnapshot(replyer, a.bindingId);
  update(store, "x2", X, 2); update(store, "y1", Y);
  store.ackContext(replyer, { token: first.token, sources: first.sources });
  const pending = store.contextSnapshot(replyer, a.bindingId);
  assert.equal(pending.pending.length, 2); assert.deepEqual(pending.pending.map(item => item.eventId), ["x2", "y1"]);
  store.ackContext(replyer, { token: pending.token, sources: pending.sources.filter(item => item.reference.id === X.id) });
  const unread = store.contextSnapshot(replyer, a.bindingId);
  assert.equal(unread.pending.length, 1); assert.equal(unread.pending[0].eventId, "y1"); assert.equal(unread.needsSync, true);
  store.ackContext(replyer, { token: unread.token, sources: unread.sources });
  assert.equal(store.contextSnapshot(replyer, a.bindingId).pending.length, 0);
});

test("partial acknowledgements retain unread sources already present when a binding is created", t => {
  const h = fixture(t); const { store } = h;
  update(store, "existing-x", X, 1); update(store, "existing-y", Y, 1);
  const topic = store.createTopic(owner, { topicId: "preexisting", scope: "team" });
  ref(store, topic.topicId, X); ref(store, topic.topicId, Y);
  const a = binding(store, "team", topic.topicId), snapshot = store.contextSnapshot(replyer, a.bindingId);
  assert.equal(snapshot.pending.length, 0); assert.equal(snapshot.needsSync, true);
  store.ackContext(replyer, { token: snapshot.token, sources: snapshot.sources.filter(item => item.reference.id === X.id) });
  assert.equal(store.contextSnapshot(replyer, a.bindingId).needsSync, true);
  const reopened = h.open().store;
  assert.equal(reopened.contextSnapshot(replyer, a.bindingId).needsSync, true);
  reopened.ackContext(replyer, { token: snapshot.token, sources: snapshot.sources.filter(item => item.reference.id === Y.id) });
  assert.equal(reopened.contextSnapshot(replyer, a.bindingId).needsSync, false);
  // A new native context cannot inherit the old context's per-source acknowledgement.
  reopened.invalidateAudience(owner, { conversationId: a.conversationId, expectedRevision: reopened.getConversation(owner, a.conversationId).revision, reasonRef: "policy:audience-change" });
  const reset = reopened.contextSnapshot(replyer, a.bindingId);
  reopened.ackContext(replyer, { token: reset.token, sources: [] });
  assert.equal(reopened.contextSnapshot(replyer, a.bindingId).needsSync, true);
});

test("background redelivery is idempotent, older versions cannot regress state and gaps remain visible", t => {
  const { store } = fixture(t); const a = binding(store); ref(store, "topic-a", X);
  update(store, "v1"); const original = store.version(owner, a.bindingId);
  assert.equal(update(store, "v1").status, "duplicate"); assert.deepEqual(store.version(owner, a.bindingId), original);
  assert.throws(() => update(store, "v1", X, 2), code("IDEMPOTENCY_CONFLICT"));
  update(store, "v4", X, 4); assert.equal(update(store, "old-v2", X, 2).status, "obsolete");
  const snapshot = store.contextSnapshot(owner, a.bindingId);
  assert.equal(snapshot.sources[0].sourceVersion, 4); assert.equal(snapshot.pending.length, 1); assert.equal(snapshot.pending[0].gap, true);
  update(store, "v5", X, 5);
  const latest = store.contextSnapshot(replyer, a.bindingId);
  assert.equal(latest.pending.length, 1); assert.equal(latest.pending[0].sourceVersion, 5); assert.equal(latest.pending[0].gap, true);
  store.ackContext(replyer, { token: snapshot.token, sources: snapshot.sources });
  assert.equal(store.contextSnapshot(replyer, a.bindingId).pending[0].gap, true);
  // Acknowledge only after reloading the scoped current snapshot; this does not reconstruct missing history.
  store.ackContext(replyer, { token: latest.token, sources: latest.sources });
  assert.equal(store.contextSnapshot(replyer, a.bindingId).pending.length, 0);
  update(store, "v6", X, 6); assert.equal(store.contextSnapshot(replyer, a.bindingId).pending[0].gap, false);
});

test("unrelated background changes preserve drafts; dependency versions and new user input invalidate them", t => {
  const { store } = fixture(t); const a = binding(store); ref(store, "topic-a", X); ref(store, "topic-a", Y);
  update(store, "x1"); update(store, "y1", Y);
  store.beginReply(replyer, { draftId: "draft-x", bindingId: a.bindingId, dependencies: [X] });
  update(store, "y2", Y, 2);
  store.completeReply(replyer, { draftId: "draft-x", draftRef: "object:draft-x" });
  assert.equal(store.assertDraftCurrent(replyer, "draft-x").draftRef, "object:draft-x");
  update(store, "x2", X, 2); assert.throws(() => store.assertDraftCurrent(replyer, "draft-x"), code("STALE_DRAFT"));
  store.beginReply(replyer, { draftId: "draft-next", bindingId: a.bindingId, dependencies: [X] });
  const conversation = store.getConversation(owner, a.conversationId);
  const input = { conversationId: a.conversationId, expectedRevision: conversation.revision, eventId: "user-correction", reason: "input" as const };
  const changed = store.advanceGeneration(replyer, input); assert.deepEqual(store.advanceGeneration(replyer, input), changed);
  assert.throws(() => store.completeReply(replyer, { draftId: "draft-next", draftRef: "object:late" }), code("STALE_CONTEXT"));
});

test("same-conversation reply generation remains serial across separate topics", t => {
  const { store } = fixture(t); const a = binding(store), b = binding(store, "team", "topic-b");
  store.beginReply(replyer, { draftId: "a", bindingId: a.bindingId, dependencies: [] });
  assert.throws(() => store.beginReply(replyer, { draftId: "b", bindingId: b.bindingId, dependencies: [] }), code("CONVERSATION_BUSY"));
  store.abandonReply(replyer, "a"); assert.equal(store.beginReply(replyer, { draftId: "b", bindingId: b.bindingId, dependencies: [] }).status, "generating");
});

test("merge and explicit separation preserve provenance, never concatenate Sessions, and invalidate old routing", t => {
  const { store } = fixture(t); const a = binding(store), b = binding(store, "team", "topic-b", "second-chat");
  ref(store, "topic-a", X); ref(store, "topic-b", Y); bindNative(store, a, "session-a"); bindNative(store, b, "session-b");
  store.beginReply(replyer, { draftId: "before-merge", bindingId: a.bindingId, dependencies: [X] });
  const merge = { relationId: "merge-a-b", sourceTopicId: "topic-a", targetTopicId: "topic-b", expectedSourceRevision: store.getTopic(owner, "topic-a").revision, expectedTargetRevision: store.getTopic(owner, "topic-b").revision, evidenceRefs: ["owner:confirmed-same-work"] };
  const relation = store.mergeTopics(owner, merge); assert.deepEqual(store.mergeTopics(owner, merge), relation);
  assert.equal(store.getReplyBinding(owner, a.bindingId).sessionId, "session-a"); assert.equal(store.getReplyBinding(owner, b.bindingId).sessionId, "session-b");
  assert.throws(() => store.completeReply(replyer, { draftId: "before-merge", draftRef: "object:stale" }), code("STALE_CONTEXT"));
  assert.deepEqual(new Set(store.contextSnapshot(owner, a.bindingId).sources.map(item => item.reference.id)), new Set([X.id, Y.id]));
  const mergedSnapshot = store.contextSnapshot(owner, a.bindingId);
  store.separateTopic(owner, { relationId: "undo-merge", topicId: "topic-a", canonicalTopicId: "topic-b", expectedRevision: store.getTopic(owner, "topic-a").revision, evidenceRefs: ["owner:misassociation"] });
  const separated = store.getReplyBinding(owner, a.bindingId);
  assert.equal(separated.sessionId, undefined); assert.equal(separated.sessionEpoch, 2); assert.notEqual(separated.businessId, a.businessId);
  assert.throws(() => store.ackContext(replyer, { token: mergedSnapshot.token, sources: mergedSnapshot.sources }), code("STALE_CONTEXT"));
  assert.throws(() => bindNative(store, separated, "session-a"), code("SESSION_BINDING_CONFLICT"));
  assert.equal(bindNative(store, separated, "session-a-fresh").sessionId, "session-a-fresh");
  assert.deepEqual(store.contextSnapshot(owner, a.bindingId).sources.map(item => item.reference.id), [X.id]);
  assert.deepEqual(store.relations(owner, "topic-a").map(item => item.kind), ["merge", "separate"]);
});

test("branching records a relationship without duplicating references, Tasks or inherited subscriptions", t => {
  const { store } = fixture(t); const a = binding(store); ref(store, "topic-a", X);
  store.branchTopic(owner, { relationId: "branch", topicId: "topic-a", newTopicId: "child", expectedRevision: store.getTopic(owner, "topic-a").revision, evidenceRefs: ["event:two-explicit-requests"] });
  assert.equal(store.getTopic(owner, "child").parentTopicId, "topic-a");
  const child = binding(store, "team", "child", "child-chat");
  assert.deepEqual(store.contextSnapshot(owner, child.bindingId).sources, []);
  assert.equal(update(store, "task-complete").affectedBindingIds.includes(child.bindingId), false);
  assert.equal(store.contextSnapshot(owner, a.bindingId).sources[0].reference.id, X.id);
});

test("audience changes rotate context identity and reference revocation blocks old drafts", t => {
  const h = fixture(t); const a = binding(h.store); ref(h.store, "topic-a", X); bindNative(h.store, a, "old-audience-session");
  h.store.beginReply(replyer, { draftId: "restricted", bindingId: a.bindingId, dependencies: [X] });
  h.store.completeReply(replyer, { draftId: "restricted", draftRef: "object:restricted" });
  h.revoked.add("team:task:task-x"); assert.throws(() => h.store.assertDraftCurrent(replyer, "restricted"), code("FORBIDDEN_REFERENCE"));
  const current = h.store.getConversation(owner, a.conversationId);
  h.store.invalidateAudience(owner, { conversationId: a.conversationId, expectedRevision: current.revision, reasonRef: "policy:member-removed" });
  assert.equal(h.store.getReplyBinding(owner, a.bindingId).sessionId, undefined);
  assert.equal(h.store.version(owner, a.bindingId).audienceVersion, 2);
  assert.deepEqual(h.store.contextSnapshot(owner, a.bindingId).sources, []);
});

test("archive does not erase background associations; detach invalidates old context acknowledgements", t => {
  const { store } = fixture(t); const a = binding(store); ref(store, "topic-a", X);
  const snapshot = store.contextSnapshot(owner, a.bindingId), conversation = store.getConversation(owner, a.conversationId);
  store.setArchived(owner, { conversationId: a.conversationId, expectedRevision: conversation.revision, archived: true });
  assert.equal(update(store, "while-archived").affectedBindingIds.length, 1);
  assert.throws(() => store.beginReply(replyer, { draftId: "archived", bindingId: a.bindingId, dependencies: [X] }), code("INACTIVE_BINDING"));
  store.setArchived(owner, { conversationId: a.conversationId, expectedRevision: store.getConversation(owner, a.conversationId).revision, archived: false });
  store.detachTopic(owner, { conversationId: a.conversationId, topicId: "topic-a", expectedConversationRevision: store.getConversation(owner, a.conversationId).revision });
  assert.throws(() => store.ackContext(replyer, { token: snapshot.token, sources: snapshot.sources }), code("INACTIVE_BINDING"));
  assert.equal(update(store, "after-detach", X, 2).affectedBindingIds.length, 0);
});

test("background marks and existing event-consumption facts commit or roll back together", t => {
  const { store, tx, db } = fixture(t); const a = binding(store); ref(store, "topic-a", X);
  db.exec("CREATE TABLE synthetic_delivery_receipts (delivery_id TEXT PRIMARY KEY)");
  assert.throws(() => tx.atomic(() => {
    update(store, "atomic-event"); db.prepare("INSERT INTO synthetic_delivery_receipts VALUES (?)").run("delivery-1"); throw new Error("injected commit failure");
  }), /injected/);
  assert.equal(store.version(owner, a.bindingId).contextVersion, 0);
  assert.equal(store.contextSnapshot(owner, a.bindingId).pending.length, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM synthetic_delivery_receipts").get()!.count, 0);
  tx.atomic(() => { update(store, "atomic-event"); db.prepare("INSERT INTO synthetic_delivery_receipts VALUES (?)").run("delivery-1"); });
  assert.equal(store.version(owner, a.bindingId).contextVersion, 1);
  assert.equal(update(store, "atomic-event").status, "duplicate");
});

test("draft validation can share a transaction with effect intent creation and rejects a stale dependency", t => {
  const { store, tx, db } = fixture(t); const a = binding(store); ref(store, "topic-a", X); update(store, "x1");
  store.beginReply(replyer, { draftId: "draft", bindingId: a.bindingId, dependencies: [X] });
  store.completeReply(replyer, { draftId: "draft", draftRef: "object:body" });
  db.exec("CREATE TABLE synthetic_send_intents (draft_id TEXT PRIMARY KEY)");
  update(store, "x2", X, 2);
  assert.throws(() => tx.atomic(() => { store.assertDraftCurrent(replyer, "draft"); db.prepare("INSERT INTO synthetic_send_intents VALUES (?)").run("draft"); }), code("STALE_DRAFT"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM synthetic_send_intents").get()!.count, 0);
});

test("queries are read-only and async authorization cannot produce background writes", t => {
  const h = fixture(t); const a = binding(h.store); ref(h.store, "topic-a", X);
  const changes = h.db.prepare("SELECT total_changes() AS count").get()!.count;
  h.store.getConversation(owner, a.conversationId); h.store.getTopic(owner, "topic-a"); h.store.getReplyBinding(owner, a.bindingId);
  h.store.version(owner, a.bindingId); h.store.contextSnapshot(owner, a.bindingId); h.store.relations(owner, "topic-a");
  assert.equal(h.db.prepare("SELECT total_changes() AS count").get()!.count, changes);
  assert.throws(() => new ConversationStore(h.db, h.tx, { ...h.options, authorizeReference: (async () => true) as never }), /must be synchronous/);
  const bad = new ConversationStore(h.db, h.tx, { ...h.options, authorizeReference: (() => Promise.resolve(true)) as never });
  assert.throws(() => update(bad, "async-auth"), code("ASYNC_AUTHORIZATION"));
  assert.equal(h.store.version(owner, a.bindingId).contextVersion, 0);
  const other = new DatabaseSync(":memory:"); try { assert.throws(() => new ConversationStore(h.db, new SqliteTransactions(other), h.options), /share one SQLite/); } finally { other.close(); }
});
