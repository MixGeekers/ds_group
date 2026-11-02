import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ControlStore } from "../src/adapters/control-store/index.js";
import { EventService } from "../src/control/events/index.js";
import { SHIYU_EVENT_TYPES, type EventPrincipal, type SubscribeInput } from "../src/contracts/events.js";

const eventType = "component.observation.reported";
const publisher: EventPrincipal = {
  principalId: "test-component", kind: "component", scopes: ["team-a"],
  publishTypes: SHIYU_EVENT_TYPES.map((type) => type.type), subscribeTypes: SHIYU_EVENT_TYPES.map((type) => type.type),
  targetRefs: ["test.handler", "second.handler", "topic-a"],
};
const subscription = (id: string, patch: Partial<SubscribeInput> = {}): SubscribeInput => ({
  id, types: [eventType], scope: "team-a", target: { kind: "component", handlerRef: "test.handler" },
  deliveryMode: "component", start: { kind: "from_now" }, ...patch,
});
const message = (key: string, sourceRef = "file-a") => ({
  type: eventType, scope: "team-a", payload: { message: key, sourceRef }, idempotencyKey: key,
});
const hasCode = (code: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "shiyu-events-"));
  const stores: ControlStore[] = [];
  const open = async () => {
    const store = await ControlStore.open({ filename: join(directory, "control.sqlite"), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ["test.handler", "second.handler"] });
    stores.push(store); return { store, events: new EventService(store) };
  };
  t.after(async () => { await Promise.all(stores.map((store) => store.close())); await rm(directory, { recursive: true, force: true }); });
  return { ...await open(), open };
}

test("typed publication rejects forged authority and cross-scope access", async (t) => {
  const { events } = await fixture(t);
  const agent: EventPrincipal = { ...publisher, principalId: "worker-1", kind: "agent" };
  await assert.rejects(events.publish(agent, { type: "task.succeeded", scope: "team-a", payload: { taskId: "task-1" }, idempotencyKey: "forged" }), hasCode("FORBIDDEN"));
  await assert.rejects(events.publish(publisher, { type: "task.succeeded", scope: "team-a", payload: { taskId: "task-1" }, idempotencyKey: "wrong-component" }), hasCode("FORBIDDEN"));
  await assert.rejects(events.publish(publisher, { ...message("wrong-scope"), scope: "private" }), hasCode("FORBIDDEN"));
  await assert.rejects(events.publish(publisher, { ...message("bad-payload"), payload: { message: 42 } }), hasCode("INVALID_PAYLOAD"));
  await events.publish(agent, { type: "agent.observation.reported", scope: "team-a", payload: { message: "An observation, not verified success" }, idempotencyKey: "observation" });
  const foreign = { ...publisher, principalId: "other", scopes: ["team-b"] };
  assert.deepEqual(await events.listEvents(foreign), []);
  assert.equal((await events.stats(foreign)).events, 0);
  assert.equal((await events.listEvents(publisher))[0].actor.principalId, "worker-1");
  assert.equal((await events.stats(publisher)).events, 1);
});

test("publish and subscription IDs retain stable identity across restart", async (t) => {
  const { store, events, open } = await fixture(t);
  const input = subscription("stable-sub");
  await events.subscribe(publisher, input);
  const receipt = await events.publish(publisher, message("stable-event"));
  await store.close();
  const reopened = await open();
  assert.equal((await reopened.events.subscribe(publisher, input)).id, "stable-sub");
  const duplicate = await reopened.events.publish(publisher, message("stable-event"));
  assert.equal(duplicate.eventId, receipt.eventId);
  assert.equal(duplicate.status, "duplicate");
  assert.equal((await reopened.events.listDeliveries(publisher)).length, 1);
  await assert.rejects(reopened.events.publish(publisher, { ...message("stable-event"), payload: { message: "changed" } }), hasCode("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(reopened.events.subscribe(publisher, subscription("stable-sub", { once: true })), hasCode("IDEMPOTENCY_CONFLICT"));
});

test("two SQLite workers serialize publication and subscription establishment without a lost completion", async (t) => {
  const first = await fixture(t); const second = await first.open();
  const [left, right] = await Promise.all([
    first.events.publish(publisher, message("same-event")), second.events.publish(publisher, message("same-event")),
  ]);
  assert.equal(left.eventId, right.eventId);
  assert.deepEqual([left.status, right.status].sort(), ["accepted", "duplicate"]);
  await Promise.all([
    first.events.subscribe(publisher, subscription("racing-sub", { start: { kind: "replay", afterSequence: right.sequence, limit: 20 } })),
    second.events.publish(publisher, message("completion-racing-with-subscribe")),
  ]);
  const deliveries = await first.events.listDeliveries(publisher, { subscriptionId: "racing-sub" });
  assert.equal(deliveries.length, 1);
  assert.equal((await first.events.stats(publisher)).events, 2);
});

test("concurrent claims have one winner and expired tokens cannot acknowledge a new attempt", async (t) => {
  const first = await fixture(t); const second = await first.open();
  await first.events.subscribe(publisher, subscription("claim-sub"));
  await first.events.publish(publisher, message("claim-event"));
  const [a, b] = await Promise.all([
    first.events.claim(publisher, { consumerId: "a", deliveryMode: "component", leaseMs: 100 }),
    second.events.claim(publisher, { consumerId: "b", deliveryMode: "component", leaseMs: 100 }),
  ]);
  assert.equal(a.length + b.length, 1);
  const old = [...a, ...b][0];
  await delay(120);
  const [retried] = await second.events.claim(publisher, { consumerId: "retry", deliveryMode: "component", leaseMs: 5000 });
  assert.equal(retried.deliveryId, old.deliveryId);
  assert.notEqual(retried.claimToken, old.claimToken);
  assert.equal(retried.attempts, 2);
  await assert.rejects(first.events.ack(publisher, old), hasCode("STALE_CLAIM"));
  assert.equal((await second.events.ack(publisher, retried)).status, "acked");
  assert.equal((await second.events.ack(publisher, retried)).status, "acked");
});

test("background targets remain durable references and are never returned to the component dispatcher", async (t) => {
  const { events } = await fixture(t);
  await events.subscribe(publisher, subscription("background-sub", { target: { kind: "agent", bindingId: "topic-a" }, deliveryMode: "background" }));
  await events.publish(publisher, message("background-change"));
  assert.deepEqual(await events.claim(publisher, { consumerId: "component-loop", deliveryMode: "component" }), []);
  assert.equal((await events.listDeliveries(publisher))[0].status, "pending");
  const [reference] = await events.claim(publisher, { consumerId: "background-reader", deliveryMode: "background" });
  assert.equal(reference.target.kind, "agent");
  await events.ack(publisher, reference);
  await assert.rejects(events.subscribe(publisher, subscription("unknown-handler", { target: { kind: "component", handlerRef: "arbitrary.callback" } })), hasCode("FORBIDDEN"));
  await assert.rejects(events.subscribe(publisher, subscription("ungranted-binding", { target: { kind: "agent", bindingId: "someone-private-session" }, deliveryMode: "background" })), hasCode("FORBIDDEN"));
});

test("pause fences claims; resume preserves dedup and only accepts new matches", async (t) => {
  const { events } = await fixture(t);
  const sub = await events.subscribe(publisher, subscription("pause-sub"));
  await events.publish(publisher, message("before-pause"));
  const [old] = await events.claim(publisher, { consumerId: "slow", deliveryMode: "component" });
  const paused = await events.update(publisher, sub.id, sub.revision, { status: "paused" });
  await assert.rejects(events.ack(publisher, old), hasCode("STALE_CLAIM"));
  await events.publish(publisher, message("during-pause"));
  const resumed = await events.update(publisher, sub.id, paused.revision, { status: "active" });
  assert.equal(resumed.ruleRevision, sub.ruleRevision);
  assert.ok(resumed.activationGeneration > sub.activationGeneration);
  assert.equal((await events.publish(publisher, message("before-pause"))).status, "duplicate");
  assert.deepEqual(await events.claim(publisher, { consumerId: "after-resume", deliveryMode: "component" }), []);
  await events.publish(publisher, message("after-resume"));
  const [fresh] = await events.claim(publisher, { consumerId: "after-resume", deliveryMode: "component" });
  assert.equal(fresh.event.payload.message, "after-resume");
  await events.unsubscribe(publisher, resumed.id, resumed.revision);
  await assert.rejects(events.ack(publisher, fresh), hasCode("STALE_CLAIM"));
});

test("limited replay declares a gap and from_now never backfills old events", async (t) => {
  const { events } = await fixture(t);
  for (const key of ["one", "two", "three"]) await events.publish(publisher, message(key));
  const replay = await events.subscribe(publisher, subscription("bounded", { start: { kind: "replay", afterSequence: 0, limit: 2 } }));
  assert.equal(replay.startSequence, 3);
  assert.equal(replay.replayedCount, 2);
  assert.equal(replay.replayTruncated, true);
  const fresh = await events.subscribe(publisher, subscription("future-only"));
  assert.equal(fresh.replayedCount, 0);
  assert.equal((await events.listDeliveries(publisher, { subscriptionId: fresh.id })).length, 0);
  await events.publish(publisher, message("four"));
  assert.equal((await events.listDeliveries(publisher, { subscriptionId: replay.id })).length, 3);
  assert.equal((await events.listDeliveries(publisher, { subscriptionId: fresh.id })).length, 1);
});

test("one event fans out; a failed consumer neither blocks another nor gains unlimited attempts", async (t) => {
  const { events } = await fixture(t);
  await events.subscribe(publisher, subscription("bad", { maxAttempts: 2 }));
  await events.subscribe(publisher, subscription("good", { target: { kind: "component", handlerRef: "second.handler" } }));
  const receipt = await events.publish(publisher, message("fanout"));
  assert.equal(receipt.deliveryCount, 2);
  const claims = await events.claim(publisher, { consumerId: "handlers", deliveryMode: "component" });
  const bad = claims.find((item) => item.subscriptionId === "bad")!;
  const good = claims.find((item) => item.subscriptionId === "good")!;
  await events.ack(publisher, good);
  await events.fail(publisher, { ...bad, error: "temporary", retryAfterMs: 0 });
  const [retry] = await events.claim(publisher, { consumerId: "retry", deliveryMode: "component" });
  assert.equal(retry.deliveryId, bad.deliveryId);
  assert.equal((await events.fail(publisher, { ...retry, error: "still failed", retryAfterMs: 0 })).status, "failed");
  assert.deepEqual(await events.claim(publisher, { consumerId: "retry", deliveryMode: "component" }), []);
  const stats = await events.stats(publisher);
  assert.equal(stats.acknowledged, 1); assert.equal(stats.failed, 1);
});

test("filters, one-shot subscriptions, and current authorization are enforced at consumption", async (t) => {
  const { events } = await fixture(t);
  const sub = await events.subscribe(publisher, subscription("one-shot", { once: true, filter: { sourceRef: "wanted" } }));
  await events.publish(publisher, message("not-matching"));
  await events.publish(publisher, message("match-one", "wanted"));
  await events.publish(publisher, message("match-two", "wanted"));
  assert.equal((await events.listDeliveries(publisher)).length, 1);
  const revoked = { ...publisher, scopes: [] };
  assert.deepEqual(await events.claim(revoked, { consumerId: "revoked", deliveryMode: "component" }), []);
  const [claimed] = await events.claim(publisher, { consumerId: "allowed", deliveryMode: "component" });
  await assert.rejects(events.ack(revoked, claimed), hasCode("FORBIDDEN"));
  await assert.rejects(events.update(publisher, sub.id, 99, { status: "paused" }), hasCode("REVISION_CONFLICT"));
  await events.ack(publisher, claimed);
  await assert.rejects(events.subscribe(publisher, subscription("bad-filter", { filter: { message: "not declared filterable" } })), hasCode("INVALID_INPUT"));
});

test("expiry is rechecked when a handler acknowledges, not only when it claims", async (t) => {
  const { events } = await fixture(t);
  await events.subscribe(publisher, subscription("expiry"));
  await events.publish(publisher, { ...message("short-lived"), expiresAt: new Date(Date.now() + 100).toISOString() });
  const [claimed] = await events.claim(publisher, { consumerId: "slow", deliveryMode: "component", leaseMs: 5000 });
  assert.ok(claimed);
  await delay(120);
  await assert.rejects(events.ack(publisher, claimed), hasCode("STALE_CLAIM"));
});
