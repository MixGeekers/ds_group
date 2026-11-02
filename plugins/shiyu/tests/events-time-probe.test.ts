import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { EventService } from '../src/control/events/index.js';
import { probeTimeSource, TIME_PROBE_TOOL_NAME } from '../src/control/events/probe.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal } from '../src/contracts/events.js';

const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const check = (result: Awaited<ReturnType<typeof probeTimeSource>>, id: string) => {
  const found = result.checks.find(item => item.id === id);
  assert.ok(found, `missing probe check ${id}`);
  assert.equal(found.ok, true, `probe check ${id} failed: ${found.detail ?? ''}`);
  return found;
};
const reader: EventPrincipal = { principalId: 'probe-test-reader', kind: 'component', scopes: ['local-owner'], publishTypes: [],
  subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs: ['probe.handler'] };

test('probe is fully in-memory and leaves an independent live store untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-time-probe-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = await ControlStore.open({ filename: join(directory, 'live.sqlite'), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [] });
  t.after(() => live.close().catch(() => undefined));
  const liveEvents = new EventService(live);
  const publisher: EventPrincipal = { principalId: 'live-component', kind: 'component', scopes: ['local-owner'],
    publishTypes: ['component.observation.reported'], subscribeTypes: [], targetRefs: [] };
  await liveEvents.publish(publisher, { type: 'component.observation.reported', scope: 'local-owner', payload: { message: 'live fact' }, idempotencyKey: 'live-1' });
  const before = await liveEvents.stats(reader);
  const result = await probeTimeSource({ baseTimeMs: BASE });
  const after = await liveEvents.stats(reader);
  assert.deepEqual(after, before, 'the probe never writes the live control store');
  assert.equal(result.ok, true);
  assert.equal(result.store.kind, 'in-memory');
  assert.equal(result.store.liveDataTouched, false);
  assert.equal(result.released, true);
  assert.equal(result.disposed, true);
  assert.deepEqual(result.diagnostics.cleanupErrors, []);
  check(result, 'isolated_in_memory_store');
});

test('one deterministic once rule produces exactly one canonical time.occurred identity across two ticks', async () => {
  const result = await probeTimeSource({ baseTimeMs: BASE });
  check(result, 'once_single_occurrence');
  check(result, 'repeat_tick_no_second_event');
  const identity = result.events.identity;
  assert.ok(identity);
  assert.equal(identity.subscriptionId, 'probe-once');
  assert.equal(identity.ruleRevision, 1);
  assert.equal(identity.scheduledFor, new Date(BASE + 5000).toISOString());
  assert.equal(identity.occurrence, `once:1:${new Date(BASE + 5000).toISOString()}`);
  assert.equal(identity.idempotencyKeyHash.length, 64);
  const onceDue = result.ticks.find(step => step.step === 'once-due')!;
  const repeat = result.ticks.find(step => step.step === 'repeat-same-identity')!;
  assert.equal(onceDue.accepted, 1);
  assert.equal(onceDue.eventsAfter, 1);
  assert.equal(repeat.accepted, 0);
  assert.equal(repeat.eventsAfter, 1, 'a repeated tick never creates a second time event');
  // A second probe run with the same deterministic base yields the same canonical identity.
  const again = await probeTimeSource({ baseTimeMs: BASE });
  assert.equal(again.events.identity?.idempotencyKeyHash, identity.idempotencyKeyHash);
  assert.equal(again.events.identity?.occurrence, identity.occurrence);
  assert.equal(again.events.identity?.scheduledFor, identity.scheduledFor);
});

test('latest-only merges missed periods and keeps the canonical scheduled boundary', async () => {
  const result = await probeTimeSource({ baseTimeMs: BASE });
  check(result, 'latest_only_single_merged_occurrence');
  check(result, 'latest_repeat_stays_silent');
  const merged = result.ticks.find(step => step.step === 'latest-multi-period')!;
  assert.equal(merged.accepted, 1);
  assert.equal(merged.eventsAfter, 2);
  const latest = result.ticks.find(step => step.step === 'latest-repeat')!;
  assert.equal(latest.accepted, 0);
  assert.equal(latest.eventsAfter, 2);
});

test('paused rules neither trigger while paused nor revive a missed occurrence after resume', async () => {
  const result = await probeTimeSource({ baseTimeMs: BASE });
  const paused = check(result, 'paused_not_triggered_no_replay');
  assert.match(paused.detail ?? '', /paused=0, resumed=0/);
  const pausedTick = result.ticks.find(step => step.step === 'paused-due')!;
  const resumedTick = result.ticks.find(step => step.step === 'resumed-after-pause')!;
  assert.equal(pausedTick.eventsAfter, 2);
  assert.equal(resumedTick.eventsAfter, 2);
});

test('clock rollback stays a visible gap instead of retriggering', async () => {
  const result = await probeTimeSource({ baseTimeMs: BASE });
  check(result, 'clock_rollback_gap_no_trigger');
  const rollback = result.ticks.find(step => step.step === 'clock-rollback')!;
  assert.ok(rollback.gaps.includes('CLOCK_ROLLBACK'));
  assert.equal(rollback.accepted, 0);
});

test('the receipt proves zero model/embedding/task/effect and a complete once-wait match', async () => {
  const result = await probeTimeSource({ baseTimeMs: BASE });
  assert.equal(result.toolName, TIME_PROBE_TOOL_NAME);
  assert.equal(result.zeroModel, true);
  assert.equal(result.zeroEmbedding, true);
  assert.equal(result.zeroTaskOrEffect, true);
  assert.deepEqual(result.onceWait, { claimed: 1, matched: 1, backgroundOnly: 0, zeroModel: true });
  check(result, 'once_wait_matched_zero_model');
  check(result, 'zero_model_no_task_effect');
  assert.deepEqual(result.events.types, ['time.occurred']);
  assert.equal(result.events.count, 2, 'only the two canonical time facts (once + merged latest) exist');
  for (const tick of result.ticks) assert.ok(Number.isSafeInteger(tick.accepted) && tick.accepted >= 0);
});

test('every probe run closes its store and removes its temporary directory', async () => {
  const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('shiyu-time-probe-')));
  const first = await probeTimeSource({ baseTimeMs: BASE });
  const second = await probeTimeSource({ baseTimeMs: BASE + 1000 });
  for (const result of [first, second]) {
    check(result, 'cleanup_complete');
    assert.equal(result.diagnostics.ruleStoreClosed, true);
    assert.equal(result.diagnostics.controlStoreClosed, true);
    assert.equal(result.diagnostics.tempDirectoryRemoved, true);
  }
  const after = (await readdir(tmpdir())).filter(name => name.startsWith('shiyu-time-probe-'));
  assert.deepEqual(after.filter(name => !before.has(name)), [], 'no probe temporary directory survives');
  assert.equal(first.clock.base, new Date(BASE).toISOString());
  assert.equal(second.clock.base, new Date(BASE + 1000).toISOString());
});

test('an aborted probe rejects, performs no scenario work, and cleanup stays available afterwards', async () => {
  const controller = new AbortController();
  const reason = new Error('probe cancelled by owner');
  controller.abort(reason);
  await assert.rejects(probeTimeSource({ baseTimeMs: BASE, signal: controller.signal }), (error) => error === reason);
  const result = await probeTimeSource({ baseTimeMs: BASE });
  assert.equal(result.ok, true);
  check(result, 'cleanup_complete');
});

test('the receipt is lossless bounded JSON with no undefined or non-finite values', async () => {
  const result = await probeTimeSource({ baseTimeMs: BASE });
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('undefined'), false);
  const parsed = JSON.parse(encoded);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(result)));
  assert.ok(Buffer.byteLength(encoded) < 16384, `probe receipt is too large: ${Buffer.byteLength(encoded)} bytes`);
  const walk = (value: unknown): void => {
    if (value === undefined) assert.fail('undefined value in receipt');
    if (typeof value === 'number') assert.equal(Number.isFinite(value), true);
    if (Array.isArray(value)) for (const item of value) walk(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item);
  };
  walk(result);
});
