import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ControlStore } from "../src/adapters/control-store/index.js";
import { EventService } from "../src/control/events/index.js";
import { SHIYU_EVENT_TYPES, type EventPrincipal } from "../src/contracts/events.js";

const actor: EventPrincipal = { principalId: "store-test", kind: "component", scopes: ["test"], publishTypes: ["component.observation.reported"], subscribeTypes: ["component.observation.reported"], targetRefs: ["handler"] };

test("SQLite uses a dedicated worker and reports actual runtime durability settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shiyu-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await ControlStore.open({ filename: join(directory, "db.sqlite"), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ["handler"] });
  try {
    const info = await store.info();
    assert.ok(info.workerThreadId > 0);
    assert.match(info.sqliteVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(["wal", "delete"].includes(info.journalMode));
    assert.equal(info.synchronous, 2);
    assert.equal(info.foreignKeys, true);
    assert.equal(info.busyTimeoutMs, 5000);
  } finally { await store.close(); }
  await assert.rejects(store.info(), /closed/);
  await store.close();
});

test("durable unacknowledged claim survives a worker restart and old receipt is fenced", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shiyu-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { filename: join(directory, "db.sqlite"), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: ["handler"] };
  const first = await ControlStore.open(options);
  const events = new EventService(first);
  await events.subscribe(actor, { id: "resume", types: actor.subscribeTypes, scope: "test", target: { kind: "component", handlerRef: "handler" }, deliveryMode: "component", start: { kind: "from_now" } });
  await events.publish(actor, { type: actor.publishTypes[0], scope: "test", payload: { message: "durable" }, idempotencyKey: "persist" });
  const [before] = await events.claim(actor, { consumerId: "old-worker", deliveryMode: "component", leaseMs: 50 });
  await first.close();
  await delay(60);
  const second = await ControlStore.open(options);
  try {
    const recovered = new EventService(second);
    const [after] = await recovered.claim(actor, { consumerId: "new-worker", deliveryMode: "component" });
    assert.equal(after.deliveryId, before.deliveryId);
    assert.equal(after.attempts, 2);
    await assert.rejects(recovered.ack(actor, before), /superseded/);
    await recovered.ack(actor, after);
    assert.equal((await recovered.stats(actor)).acknowledged, 1);
  } finally { await second.close(); }
});

test("schema drift on restart fails closed instead of reinterpreting persisted event types", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shiyu-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { filename: join(directory, "db.sqlite"), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [] };
  const store = await ControlStore.open(options); await store.close();
  const changed = structuredClone(SHIYU_EVENT_TYPES);
  changed[0].payloadSchema.properties.message = "number";
  await assert.rejects(ControlStore.open({ ...options, eventTypes: changed }), /schema version increment/);
});

test("an accepted publication can be retried after a catalog schema upgrade", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shiyu-schema-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { filename: join(directory, "db.sqlite"), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [] };
  const first = await ControlStore.open(options);
  const input = { type: actor.publishTypes[0], scope: "test", payload: { message: "v1-payload" }, idempotencyKey: "v1-accepted" };
  const accepted = await new EventService(first).publish(actor, input);
  await first.close();
  const upgraded = structuredClone(SHIYU_EVENT_TYPES);
  const definition = upgraded.find((type) => type.type === input.type)!;
  definition.schemaVersion = 2;
  definition.payloadSchema.properties.newRequiredField = "string";
  definition.payloadSchema.required.push("newRequiredField");
  const second = await ControlStore.open({ ...options, eventTypes: upgraded });
  try {
    const events = new EventService(second);
    const retry = await events.publish(actor, input);
    assert.equal(retry.status, "duplicate");
    assert.equal(retry.eventId, accepted.eventId);
    await assert.rejects(events.publish(actor, { ...input, idempotencyKey: "new-v2-event" }), /Missing payload field/);
  } finally { await second.close(); }
});

test("close drains an already full command queue before terminating its worker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "shiyu-close-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await ControlStore.open({ filename: join(directory, "db.sqlite"), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [] });
  const pending = Array.from({ length: 256 }, () => store.info());
  const closing = store.close();
  const results = await Promise.all(pending);
  assert.equal(results.length, 256);
  await closing;
});
