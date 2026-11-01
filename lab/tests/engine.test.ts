import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { LabEngine, generateNoise } from '../src/engine.ts';
import type { RunDetail, TargetAction } from '../src/types.ts';

async function until(read: () => boolean, timeoutMs = 10000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!read()) { if (Date.now() > end) throw new Error('Condition timed out'); await delay(15); }
}
async function createEngine(): Promise<{ engine: LabEngine; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'shiyu-lab-engine-'));
  const engine = new LabEngine({ runtimeDir: root }); await engine.init();
  return { engine, root, cleanup: async () => { await engine.close(); await rm(root, { recursive: true, force: true }); } };
}

test('noise generation is seeded, schedule-bound, and does not expose a noise label', () => {
  const first = generateNoise(41, 30, 1000);
  assert.deepEqual(first, generateNoise(41, 30, 1000));
  assert.notDeepEqual(first, generateNoise(42, 30, 1000));
  assert.ok(first.every(event => event.atMs >= 0 && event.atMs < 1000 && event.kind === 'message' && !event.data));
});

test('all eight real workloads finish under continuous noise, with independent input injection', async () => {
  const { engine, cleanup } = await createEngine();
  try {
    const { run } = await engine.createRun({ target: 'reference', scenarioId: 'mixed-office', noiseCount: 50, speed: 40, workerConcurrency: 2, taskDelayMs: 250, maxDurationMs: 10000 });
    await until(() => engine.getRun(run.id).tasks.every(task => task.introduced));
    const whileBusy = engine.getRun(run.id);
    assert.ok(whileBusy.tasks.some(task => task.status === 'queued' || task.status === 'running'));
    assert.equal(whileBusy.tasks.filter(task => task.introduced).length, 8);
    await until(() => Boolean(engine.getRun(run.id).factReport));
    const result = engine.getRun(run.id);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.metrics.completedTasks, 8);
    assert.equal(result.factReport?.scope, 'lab_self_test');
    assert.equal(result.factReport?.tasksPassed, 8, JSON.stringify(result.factReport?.assertions.filter(item => item.status === 'fail')));
    assert.ok(result.events.some(event => event.type === 'input.message' && event.data?.interaction === 'bounded_script'));
    assert.ok(result.service.healthy);
    assert.ok(result.metrics.injectedInputs >= 64);
    const workbook = await readFile(join(engine.runDir(run.id), 'workspace/outputs/T01/report.xlsx'));
    const document = await readFile(join(engine.runDir(run.id), 'workspace/outputs/T03/minutes.docx'));
    assert.equal(workbook.subarray(0, 2).toString(), 'PK');
    assert.equal(document.subarray(0, 2).toString(), 'PK');
  } finally { await cleanup(); }
});

test('lost receipt is a real single effect; retry checks the original result and rejects changed content', async () => {
  const { engine, cleanup } = await createEngine();
  try {
    const { run, targetToken } = await engine.createRun({ target: 'external', noiseCount: 0, speed: 1000, fault: 'lost-receipt', maxDurationMs: 5000 });
    assert.ok(targetToken && engine.authorizeTarget(run.id, targetToken));
    assert.equal(engine.authorizeTarget(run.id, 'wrong-token'), false);
    assert.equal(engine.targetInputs(run.id).length, 0);
    await until(() => engine.getRun(run.id).tasks[0].introduced);
    const action: TargetAction = { type: 'file.write', taskId: 'T01', path: 'outputs/T01/probe.txt', content: 'actual effect' };
    const first = await engine.act(run.id, action, 'write-probe');
    assert.equal(first.unknown, true);
    assert.equal(await readFile(join(engine.runDir(run.id), 'workspace/outputs/T01/probe.txt'), 'utf8'), 'actual effect');
    const repeated = await engine.act(run.id, action, 'write-probe');
    assert.equal(repeated.ok, true);
    const changed = await engine.act(run.id, { ...action, content: 'changed' }, 'write-probe');
    assert.equal(changed.ok, false);
    assert.equal(engine.getRun(run.id).events.filter(event => event.type === 'file.written' && event.data?.operationId === 'write-probe').length, 1);
  } finally { await cleanup(); }
});

test('target tools reject traversal, hidden files, symlinks, and mutation after stop', async () => {
  const { engine, root, cleanup } = await createEngine();
  try {
    const { run } = await engine.createRun({ target: 'external', noiseCount: 0, speed: 100, maxDurationMs: 5000 });
    await until(() => engine.getRun(run.id).tasks[0].introduced);
    const attempts: TargetAction[] = [
      { type: 'file.read', path: '../manifest.json' },
      { type: 'file.read', path: 'inputs/unknown.json' },
      { type: 'file.write', taskId: 'T01', path: 'outputs/T01/../../../escape', content: 'x' },
      { type: 'file.write', taskId: 'T01', path: 'outputs/T02/stolen', content: 'x' },
    ];
    for (let index = 0; index < attempts.length; index++) assert.equal((await engine.act(run.id, attempts[index], `bad-${index}`)).ok, false);
    await symlink(root, join(engine.runDir(run.id), 'workspace/outputs/T01'));
    assert.equal((await engine.act(run.id, { type: 'file.write', taskId: 'T01', path: 'outputs/T01/escape.txt', content: 'x' }, 'symlink')).ok, false);
    await engine.controlRun(run.id, 'stop');
    assert.equal((await engine.act(run.id, { type: 'message.send', channelId: 'C01', text: 'late' }, 'late')).ok, false);
  } finally { await cleanup(); }
});

test('stop interrupts workers and persists partial evidence without resuming on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiyu-lab-recovery-'));
  let engine = new LabEngine({ runtimeDir: root }); await engine.init();
  try {
    const { run } = await engine.createRun({ target: 'reference', noiseCount: 10, speed: 20, taskDelayMs: 5000, maxDurationMs: 10000 });
    await until(() => engine.getRun(run.id).tasks.some(task => task.status === 'running'));
    await engine.controlRun(run.id, 'stop');
    const stopped = engine.getRun(run.id);
    assert.equal(stopped.status, 'stopped');
    assert.ok(stopped.factReport);
    assert.equal(stopped.artifacts.length, 0);
    const count = stopped.events.length;
    await delay(50);
    assert.equal(engine.getRun(run.id).events.length, count);
    await engine.close();
    engine = new LabEngine({ runtimeDir: root }); await engine.init();
    const restored = engine.getRun(run.id);
    assert.equal(restored.status, 'stopped');
    assert.equal(restored.events.length, count);
    assert.equal(restored.artifacts.length, 0);
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }); }
});

test('reference executor survives one injected tool failure and does not duplicate a lost effect', async () => {
  const { engine, cleanup } = await createEngine();
  try {
    for (const fault of ['tool-once', 'lost-receipt'] as const) {
      const { run } = await engine.createRun({ scenarioId: 'async-handoff', target: 'reference', fault, noiseCount: 8, speed: 100, taskDelayMs: 5, maxDurationMs: 10000 });
      await until(() => Boolean(engine.getRun(run.id).factReport));
      const result = engine.getRun(run.id);
      assert.equal(result.factReport?.tasksPassed, 4, JSON.stringify(result.factReport));
      assert.ok(result.events.some(event => event.type === 'tool.result' && event.data?.ok === false));
      const effectIds = result.events.filter(event => ['file.written', 'service.configured'].includes(event.type)).map(event => event.data?.operationId);
      assert.equal(new Set(effectIds).size, effectIds.length);
    }
  } finally { await cleanup(); }
});

test('actor response follows delivery and unknown questions are recorded as Lab limitations', async () => {
  const { engine, cleanup } = await createEngine();
  try {
    const { run } = await engine.createRun({ target: 'external', noiseCount: 0, speed: 100, maxDurationMs: 5000 });
    await until(() => engine.getRun(run.id).tasks[0].introduced);
    await engine.act(run.id, { type: 'message.send', taskId: 'T01', channelId: 'C03', text: '请告诉我报表材料在哪里？' }, 'ask-assets');
    await until(() => engine.getRun(run.id).events.some(event => event.type === 'input.message' && event.data?.respondsTo === 'ask-assets'));
    const events = engine.getRun(run.id).events;
    const delivered = events.find(event => event.type === 'message.delivered' && event.data?.operationId === 'ask-assets')!;
    const response = events.find(event => event.type === 'input.message' && event.data?.respondsTo === 'ask-assets')!;
    assert.ok(delivered.seq < response.seq);
    assert.equal(response.actorId, 'E03');
    assert.match(response.text, /inputs\/orders.json/);
    await engine.act(run.id, { type: 'message.send', taskId: 'T01', channelId: 'C03', text: '下个季度是否要换一个经营模式？' }, 'ask-unknown');
    assert.ok(engine.getRun(run.id).events.some(event => event.type === 'lab.unsupported' && event.data?.operationId === 'ask-unknown'));
  } finally { await cleanup(); }
});
