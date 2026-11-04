import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LabEngine } from '../src/engine.ts';
import { Timeline, MAX_STORY_MS, validateTimeConfig } from '../src/time.ts';
import type { MissedPolicy, ScheduleRule, TimelineState } from '../src/time.ts';
import type { Scenario } from '../src/types.ts';
import { validateScenario } from '../src/scenarios.ts';
import { buildApp } from '../src/server.ts';

const DAY = 86400000;
const config = { mode: 'story' as const, startAt: '2026-01-30T13:00:00.000Z', timeZone: 'America/Caracas' };
const scenario: Scenario = { id: 'time-test', name: '合成连续时间', description: '时间基础设施', durationMs: 9 * DAY, focus: [], actors: [], channels: [],
  tasks: [{ id: 'T1', subjectId: 'generic', title: '合成工作', ownerId: 'HUMAN', channelId: 'D-SHIYU', instructions: '交付结果', inputs: [], deliverables: [], dependencies: [], workMs: 0, dueAtMs: 3 * DAY }],
  inputs: [{ id: 'request', atMs: 0, actorId: 'HUMAN', channelId: 'D-SHIYU', kind: 'request', text: '开始工作', taskId: 'T1' },
    { id: 'update', atMs: 2 * DAY, actorId: 'HUMAN', channelId: 'D-SHIYU', kind: 'message', text: '报价更新' },
    { id: 'later', atMs: 8 * DAY, actorId: 'HUMAN', channelId: 'D-SHIYU', kind: 'message', text: '后续复用' }] };

async function setup(t: any, overrides: Record<string, unknown> = {}) {
  await mkdir('runtime', { recursive: true });
  const directory = await mkdtemp(join('runtime', 'time-test-'));
  const clock = { wall: Date.parse('2026-11-03T10:00:00Z'), mono: 0, wallNow() { return this.wall; }, monotonicNow() { return this.mono; } };
  let engine = new LabEngine({ runtimeDir: directory, scenarioResolver: () => scenario, clock });
  await engine.init();
  const { run } = await engine.createRun({ target: 'external', evaluationMode: 'outcome', scenarioId: scenario.id, noiseCount: 0, speed: 1, maxDurationMs: 10000, keepOpen: true, time: config, ...overrides });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { get engine() { return engine; }, id: run.id, clock, directory,
    control(command: 'pause' | 'resume' | 'step' | 'recover') { return engine.controlTime(run.id, command, engine.getRun(run.id).events.at(-1)!.seq); },
    async reopen(edit?: (snapshot: any) => void) {
      await engine.close();
      if (edit) { const file = join(directory, 'runs', run.id, 'snapshot.json'); const snapshot = JSON.parse(await readFile(file, 'utf8')); edit(snapshot); await writeFile(file, JSON.stringify(snapshot)); }
      engine = new LabEngine({ runtimeDir: directory, scenarioResolver: () => scenario, clock }); await engine.init();
    } };
}

test('story steps encounter tomorrow reminder, external changes, own check and deadline in order', async t => {
  const f = await setup(t); f.control('step');
  for (const [scheduleId, days, kind] of [['tomorrow', 1, 'reminder'], ['check', 2.5, 'check']] as const) {
    assert.equal((await f.engine.act(f.id, { type: 'time.schedule', scheduleId, revision: 1, kind, dueAt: new Date(Date.parse(config.startAt) + days * DAY).toISOString(), text: scheduleId }, scheduleId)).ok, true);
  }
  const seen = [];
  for (let i = 0; i < 5; i++) { const run = f.control('step'); seen.push(run.time!.businessMs); }
  assert.deepEqual(seen, [DAY, 2 * DAY, 2.5 * DAY, 3 * DAY, 8 * DAY]);
  const run = f.engine.getRun(f.id);
  assert.equal(run.events.filter(event => event.type === 'input.reminder').length, 1);
  assert.equal(run.events.filter(event => event.type === 'task.deadline').length, 1);
  assert.equal(f.engine.targetInputs(f.id).filter(input => input.event.type === 'task.deadline').length, 1);
  assert.ok(run.events.every(event => event.at.startsWith('2026-11-03')));
  assert.equal(run.metrics.elapsedMs, 0);
  assert.equal(run.metrics.storySpanMs, 8 * DAY);
  assert.equal(run.events.find(event => event.type === 'input.reminder')?.storyAt, '2026-01-31T13:00:00.000Z');
});

test('same-time priority, revision identity, cancellation and no duplicate step on stale watermark', async t => {
  const f = await setup(t); f.control('step');
  const action = { type: 'time.schedule' as const, scheduleId: 'cancel-me', revision: 1, kind: 'reminder' as const, dueAt: '2026-02-01T13:00:00Z', text: 'cancel' };
  assert.equal((await f.engine.act(f.id, action, 'first')).ok, true);
  assert.equal((await f.engine.act(f.id, action, 'first')).ok, true);
  assert.equal((await f.engine.act(f.id, { type: 'time.cancel', scheduleId: 'cancel-me', revision: 1 }, 'cancel')).ok, true);
  assert.equal((await f.engine.act(f.id, { ...action, scheduleId: 'same-time' }, 'same')).ok, true);
  assert.equal((await f.engine.act(f.id, { ...action, scheduleId: 'same-time', revision: 1 }, 'bad-revision')).ok, false);
  const seq = f.engine.getRun(f.id).events.at(-1)!.seq;
  f.control('step');
  assert.throws(() => f.engine.controlTime(f.id, 'step', seq), /水位/);
  const occurrences = f.engine.getRun(f.id).events.filter(event => event.type === 'time.occurrence' && event.businessMs === 2 * DAY);
  assert.deepEqual(occurrences.map(event => event.data?.source), ['external', 'target']);
  assert.equal(f.engine.getRun(f.id).events.filter(event => event.type === 'input.reminder').length, 1);
  assert.ok(!JSON.stringify(f.engine.timeView(f.id)).includes('报价更新'));
});

test('paused story retains real timeout, independent of audit clock jumps', async t => {
  const f = await setup(t, { maxDurationMs: 120 });
  f.clock.mono = 120; f.clock.wall -= 3 * DAY;
  await delay(180);
  const run = f.engine.getRun(f.id);
  assert.equal(run.status, 'interrupted'); assert.equal(run.time!.businessMs, 0);
  assert.equal(run.metrics.elapsedMs, 120);
  assert.throws(() => f.control('recover'), /预算/);
});

test('clean restart restores cancelled and pending agendas, preserves identities and cumulative elapsed', async t => {
  const f = await setup(t); f.control('step');
  const action = { type: 'time.schedule' as const, scheduleId: 'daily', revision: 1, kind: 'check' as const, dueAt: '2026-01-31T13:00:00Z', everyMs: DAY, until: '2026-02-02T13:00:00Z', text: 'check' };
  await f.engine.act(f.id, action, 'daily');
  await f.engine.act(f.id, { ...action, scheduleId: 'cancelled' }, 'cancelled');
  await f.engine.act(f.id, { type: 'time.cancel', scheduleId: 'cancelled', revision: 1 }, 'cancel');
  f.control('step'); f.clock.mono = 50;
  const before = f.engine.getRun(f.id).events.filter(event => event.type === 'time.occurrence').map(event => event.data!.id);
  await f.reopen(); f.clock.mono = 1000; f.control('recover');
  assert.equal(f.engine.getRun(f.id).time!.paused, true);
  f.control('step');
  const run = f.engine.getRun(f.id), ids = run.events.filter(event => event.type === 'time.occurrence').map(event => event.data!.id);
  assert.ok((run.manifest.timeResumptions as any[])[0].priorFactReport);
  assert.deepEqual(ids.slice(0, before.length), before); assert.equal(new Set(ids).size, ids.length);
  assert.equal(run.events.filter(event => event.type === 'input.check').length, 2);
  assert.equal(run.metrics.elapsedMs, 50);
});

test('unknown occurrence blocks recovery without replay', async t => {
  const f = await setup(t); f.control('step');
  await f.reopen(snapshot => { snapshot.time.pending = { id: 'unknown', ruleId: 'external:update' }; });
  const count = f.engine.getRun(f.id).events.length;
  assert.throws(() => f.control('recover'), /恢复条件/);
  assert.equal(f.engine.getRun(f.id).events.length, count);
});

test('incomplete persistence blocks recovery without replay', async t => {
  const f = await setup(t); f.control('step');
  await f.reopen(snapshot => { snapshot.persistedEventCount += 1; });
  const count = f.engine.getRun(f.id).events.length;
  assert.throws(() => f.control('recover'), /恢复条件/);
  assert.equal(f.engine.getRun(f.id).events.length, count);
});

test('unclean process state cannot reset an unknown real runtime budget on recovery', async t => {
  const f = await setup(t);
  await f.reopen(snapshot => { snapshot.status = 'running'; delete snapshot.finishedAt; });
  assert.equal((f.engine.getRun(f.id).manifest.timeRecovery as any).elapsed, 'lower_bound');
  assert.throws(() => f.control('recover'), /恢复条件/);
});

test('load injection continues independently and paused load excludes the paused interval', async t => {
  const f = await setup(t, { time: { ...config, mode: 'load' } });
  await delay(20); // first event at zero is delivered by the runtime timer
  assert.equal(f.engine.getRun(f.id).tasks[0].introduced, true);
  f.control('pause'); f.clock.mono = 4 * DAY;
  assert.equal(f.engine.timeView(f.id)!.businessMs, 0);
  f.control('resume');
  // A near-term target check reschedules the timer, then the event loop sees
  // a backlog that spans an external update and a pending task's deadline.
  await f.engine.act(f.id, { type: 'time.schedule', scheduleId: 'tick', revision: 1, kind: 'check', dueAt: new Date(Date.parse(config.startAt) + 10).toISOString(), text: 'tick' }, 'tick');
  f.clock.mono += 3 * DAY;
  await delay(40);
  const run = f.engine.getRun(f.id);
  assert.equal(run.time!.businessMs, 3 * DAY);
  assert.equal(run.tasks[0].status, 'queued');
  assert.equal(run.events.filter(event => event.type === 'input.check').length, 1);
  assert.equal(run.events.filter(event => event.type === 'task.deadline').length, 1);
  assert.ok(run.events.some(event => event.text === '报价更新'));
});

test('real monotonic load entry point admits zero-offset events and injects while target is idle', async t => {
  await mkdir('runtime', { recursive: true });
  const runtimeDir = await mkdtemp('runtime/real-clock-time-');
  const short = { ...scenario, durationMs: 100, tasks: [], inputs: [0, 30, 60].map(atMs => ({ id: `i${atMs}`, atMs, actorId: 'HUMAN', channelId: 'D-SHIYU', kind: 'message' as const, text: String(atMs) })) };
  const engine = new LabEngine({ runtimeDir, scenarioResolver: () => short }); await engine.init();
  t.after(async () => { await engine.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const { run } = await engine.createRun({ scenarioId: short.id, target: 'external', time: { ...config, mode: 'load' }, noiseCount: 0, keepOpen: true, speed: 1, maxDurationMs: 10000 });
  await delay(200);
  assert.deepEqual(engine.targetInputs(run.id).map(input => input.event.text), ['0', '30', '60']);
  assert.ok(engine.getRun(run.id).events.every(event => Date.parse(event.storyAt!) === Date.parse(config.startAt) + event.businessMs));
});

test('pending future reminders prevent empty room from being scored completed at real expiry', async t => {
  await mkdir('runtime', { recursive: true });
  const runtimeDir = await mkdtemp('runtime/expiry-time-');
  const engine = new LabEngine({ runtimeDir, scenarioResolver: () => ({ ...scenario, tasks: [], inputs: [], durationMs: 1 }) });
  await engine.init();
  t.after(async () => { await engine.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const { run } = await engine.createRun({ scenarioId: scenario.id, target: 'external', time: config, noiseCount: 0, keepOpen: true, maxDurationMs: 120 });
  await engine.act(run.id, { type: 'time.schedule', scheduleId: 'future', revision: 1, kind: 'check', dueAt: '2026-01-31T13:00:00Z', text: 'future' }, 'future');
  engine.controlTime(run.id, 'step', engine.getRun(run.id).events.at(-1)!.seq);
  await delay(200);
  assert.equal(engine.getRun(run.id).status, 'interrupted');
  assert.equal(engine.getRun(run.id).events.filter(event => event.type === 'input.check').length, 0);
});

test('invalid manual deadline does not leave an orphan task', async t => {
  const f = await setup(t);
  const before = f.engine.getRun(f.id).tasks.length;
  const result = await f.engine.publishTask(f.id, { title: 'bad', instructions: 'bad', channelId: 'D-SHIYU', dueAtMs: MAX_STORY_MS + 1 }, 'bad');
  assert.equal(result.ok, false);
  assert.equal(f.engine.getRun(f.id).tasks.length, before);
});

test('stopped run rejects time advancement and fresh target scheduling', async t => {
  const f = await setup(t); await f.engine.controlRun(f.id, 'stop');
  assert.throws(() => f.control('resume'), /封存/);
  assert.throws(() => f.control('recover'), /恢复条件/);
  assert.equal((await f.engine.act(f.id, { type: 'time.cancel', scheduleId: 'x', revision: 1 }, 'x')).ok, false);
});

test('closed engine rejects recovery before mutating the durable runtime', async t => {
  const f = await setup(t); await f.engine.close();
  const before = f.engine.getRun(f.id);
  assert.throws(() => f.control('recover'), /已关闭/);
  assert.deepEqual(f.engine.getRun(f.id), before);
});

for (const missed of ['each', 'latest', 'coalesce', 'skip'] as MissedPolicy[]) test(`periodic ${missed} records denominator and stable occurrence identities`, () => {
  const state: TimelineState = { version: 1, config, businessMs: 0, paused: true, stopped: false, rules: [] };
  const timeline = new Timeline('run', state, 1);
  timeline.add({ id: 'daily', revision: 1, source: 'target', kind: 'check', nextAtMs: 1000, everyMs: 1000, untilMs: 4000, missed, payload: {} });
  const events = [];
  for (let occurrence = timeline.next(4500); occurrence; occurrence = timeline.next(4500)) {
    events.push(occurrence); timeline.claim(occurrence); timeline.settle();
  }
  assert.equal(events.reduce((sum, event) => sum + event.count, 0), 4);
  assert.equal(events.length, missed === 'each' ? 4 : 1);
  assert.equal(events.reduce((sum, event) => sum + event.deliveredCount, 0), missed === 'skip' ? 0 : missed === 'each' ? 4 : 1);
  assert.equal(new Timeline('run', structuredClone(state), 1).next(4500), undefined);
});

test('load clock uses monotonic time, pauses, resumes without offline catchup, and interval revision clears old recurrence', () => {
  let mono = 0;
  const source = { wallNow: () => -1000, monotonicNow: () => mono };
  const state: TimelineState = { version: 1, config: { ...config, mode: 'load' }, businessMs: 0, paused: false, stopped: false, rules: [] };
  const timeline = new Timeline('run', state, 10, source);
  mono = 50; assert.equal(timeline.now(), 500); timeline.pause();
  mono = 500; assert.equal(timeline.now(), 500); timeline.resume();
  mono = 600; assert.equal(timeline.now(), 1500);
  const rule: ScheduleRule = { id: 'r', revision: 1, source: 'target', kind: 'reminder', nextAtMs: 2000, everyMs: 1000, untilMs: 5000, missed: 'each', payload: {} };
  timeline.add(rule); const oldIdentity = timeline.next(2000)!.id;
  const { everyMs, untilMs, ...once } = rule;
  timeline.add({ ...once, revision: 2 });
  assert.notEqual(timeline.next(2000)!.id, oldIdentity);
  timeline.claim(timeline.next(2000)!); timeline.settle();
  assert.equal(timeline.next(5000), undefined);
});

test('90-day validation and absolute calendar views cover month boundary and DST offsets', () => {
  assert.equal(validateScenario({ ...scenario, durationMs: MAX_STORY_MS }).durationMs, MAX_STORY_MS);
  assert.throws(() => validateScenario({ ...scenario, durationMs: MAX_STORY_MS + 1 }));
  assert.throws(() => validateTimeConfig({ ...config, startAt: '2026-01-01T00:00:00' }));
  assert.throws(() => validateTimeConfig({ ...config, startAt: '2026-02-30T00:00:00Z' }));
  assert.throws(() => validateTimeConfig({ ...config, timeZone: 'No/SuchZone' }));
  const state: TimelineState = { version: 1, config: { mode: 'story', startAt: '2026-03-08T06:30:00Z', timeZone: 'America/New_York' }, businessMs: 0, paused: true, stopped: false, rules: [] };
  const timeline = new Timeline('dst', state, 1);
  assert.match(timeline.view().localDateTime, /01:30/);
  state.businessMs = 3600000; assert.match(timeline.view().localDateTime, /03:30/);
});

test('custom scenario capacity admits five staff, 1120 planned utterances and 71 tasks over seven business days', () => {
  const actors = ['boss', 'finance', 'tech', 'developer', 'onsite'].map(id => ({ id, name: id, department: '合成公司', title: id, color: '#627ad9' }));
  const channels = actors.map(actor => ({ id: `D-${actor.id}`, name: actor.id, kind: 'direct' as const, memberIds: [actor.id, 'SHIYU'] }));
  const days = [0, 1, 2, 3, 4, 7, 8];
  const inputs = actors.flatMap(actor => days.flatMap(day => Array.from({ length: 32 }, (_, turn) => ({
    id: `${actor.id}-${day}-${turn}`, actorId: actor.id, channelId: `D-${actor.id}`, kind: 'message' as 'message' | 'request',
    atMs: day * DAY + turn * 60000, text: '仅用于输入计划容量核查', taskId: undefined as string | undefined,
  }))));
  const requests = inputs.filter((_, index) => index % 32 < 2);
  requests.push(inputs[2]);
  const tasks = requests.map((input, index) => {
    input.kind = 'request'; input.taskId = `T${index}`;
    return { ...scenario.tasks[0], id: input.taskId, ownerId: input.actorId, channelId: input.channelId, dueAtMs: input.atMs + (index === 70 ? 3 * DAY : 3600000) };
  });
  const checked = validateScenario({ ...scenario, actors, channels, tasks, inputs });
  assert.equal(checked.inputs.length, 1120); assert.equal(checked.tasks.length, 71);
  assert.ok(checked.tasks[70].dueAtMs - inputs[2].atMs > DAY);
  // This is input capacity evidence. It does not count any target responses.
});

test('standalone HTTP endpoints expose and control the same opt-in timeline', async t => {
  await mkdir('runtime', { recursive: true });
  const runtimeDir = await mkdtemp('runtime/http-time-');
  const { app } = await buildApp({ runtimeDir, serveWeb: false });
  t.after(async () => { await app.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { idempotencyKey: 'time-http', config: { scenarioId: 'mixed-office', target: 'external', noiseCount: 0, time: config } } });
  assert.equal(response.statusCode, 200, response.body);
  const { run, targetToken } = response.json();
  const headers = { authorization: `Bearer ${targetToken}` };
  const view = (await app.inject({ url: `/target/runs/${run.id}`, headers })).json();
  assert.equal(view.time.storyAt, config.startAt); assert.equal(view.time.rules, undefined);
  const action = await app.inject({ method: 'POST', url: `/target/runs/${run.id}/actions`, headers, payload: { operationId: 'cancel', action: { type: 'time.cancel', scheduleId: 'unknown', revision: 1 } } });
  assert.equal(action.json().ok, false);
  const current = (await app.inject({ url: `/api/runs/${run.id}` })).json();
  const stepped = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/time`, payload: { command: 'step', expectedSeq: current.events.at(-1).seq } });
  assert.equal(stepped.statusCode, 200, stepped.body);
  const inputs = (await app.inject({ url: `/target/runs/${run.id}/inputs`, headers })).json();
  assert.ok(inputs.inputs.length); assert.equal(inputs.time.mode, 'story');
});
