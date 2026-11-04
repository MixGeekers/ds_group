import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { GymService } from '../service.js';
import { serveTarget } from '../index.js';

test('public plugin protocol carries story clock, own reminders, hidden agenda boundary and controller watermark', async t => {
  await mkdir('runtime', { recursive: true });
  const runtimeDir = await mkdtemp('runtime/plugin-time-');
  const service = new GymService({ get: () => undefined }, { runtimeDir }); await service.init();
  t.after(async () => { await service.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const created = await service.dispatch({ action: 'create', driver: 'external', idempotencyKey: randomUUID(), config: { scenarioId: 'free-chat', keepOpen: true, evaluationMode: 'outcome', noiseCount: 0, maxDurationMs: 600000, time: { mode: 'story', startAt: '2026-01-05T13:00:00Z', timeZone: 'America/Caracas' } } });
  const runId = created.run.id;
  const call = async request => {
    const response = await serveTarget(service, new Request('http://localhost/api/shiyu-gym/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, targetToken: created.targetToken, request }) }));
    assert.equal(response.status, 200); return response.json();
  };
  const view = await call({ action: 'inspect' });
  assert.equal(view.time.storyAt, '2026-01-05T13:00:00.000Z');
  assert.equal(view.time.rules, undefined); assert.equal(view.time.schedules.length, 0);
  const scheduled = await call({ action: 'act', operationId: 'remind', operation: { type: 'time.schedule', scheduleId: 'r', revision: 1, kind: 'reminder', dueAt: '2026-01-06T13:00:00Z', text: '明早九点提醒' } });
  assert.equal(scheduled.ok, true);
  const step = () => service.dispatch({ action: 'time_control', runId, command: 'step', expectedSeq: service.engine.getRun(runId).events.at(-1).seq });
  await step(); // empty script ends before the reminder, while the room remains open
  await step();
  const inputs = await call({ action: 'inputs' });
  assert.equal(inputs.time.storyAt, '2026-01-06T13:00:00.000Z');
  assert.equal(inputs.inputs.filter(input => input.event.type === 'input.reminder').length, 1);
  await service.dispatch({ action: 'control', command: 'stop', runId });
  const packet = await service.packet(runId);
  assert.equal(packet.time.mode, 'story'); assert.equal(packet.time.storySpanMs, 86400000);
  assert.ok(packet.time.realElapsedMs < 86400000);
});

test('native model barrier blocks steps while pause remains available', async t => {
  await mkdir('runtime', { recursive: true });
  const runtimeDir = await mkdtemp('runtime/plugin-time-barrier-');
  const service = new GymService({ get: () => undefined }, { runtimeDir }); await service.init();
  t.after(async () => { service.driver.live.clear(); await service.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const { run } = await service.dispatch({ action: 'create', driver: 'external', idempotencyKey: randomUUID(), config: { scenarioId: 'free-chat', noiseCount: 0, keepOpen: true, time: { mode: 'story', startAt: '2026-01-05T13:00:00Z', timeZone: 'UTC' } } });
  service.driver.live.set('synthetic-busy', { binding: { runId: run.id, status: 'running' }, busy: true });
  const control = command => service.dispatch({ action: 'time_control', runId: run.id, command, expectedSeq: service.engine.getRun(run.id).events.at(-1).seq });
  await assert.rejects(() => control('step'), /时间屏障/);
  await control('pause');
  assert.equal(service.engine.getRun(run.id).time.paused, true);
  service.driver.live.clear(); await control('step');
});
