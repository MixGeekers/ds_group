import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/server.ts';
import { executeWork } from '../src/workloads.ts';
import type { ActionResult, RunConfig, RunDetail, TargetAction, TargetInput, TaskSpec } from '../src/types.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('external HTTP protocol completes all eight workloads with a lost receipt and no target filesystem access', { timeout: 30000 }, async t => {
  await mkdir(path.join(projectRoot, 'runtime'), { recursive: true });
  const runtimeDir = await mkdtemp(path.join(projectRoot, 'runtime', 'test-external-'));
  const { app } = await buildApp({ runtimeDir, serveWeb: false, logger: false });
  const controller = new AbortController();
  const active = new Map<string, Promise<void>>();
  t.after(async () => {
    controller.abort();
    await Promise.allSettled([...active.values()]);
    try { await app.close(); }
    finally { await rm(runtimeDir, { recursive: true, force: true }); }
  });

  const config: RunConfig = {
    scenarioId: 'mixed-office', target: 'external', seed: 41, noiseCount: 60,
    speed: 100, workerConcurrency: 2, taskDelayMs: 0, fault: 'lost-receipt', maxDurationMs: 20000,
  };
  const created = await app.inject({ method: 'POST', url: '/api/runs', payload: { config, idempotencyKey: randomUUID() } });
  assert.equal(created.statusCode, 200, created.body);
  // The protocol client only receives identity/token here. It intentionally ignores the
  // operator's RunDetail, which includes future task configuration and observer metadata.
  const { run: { id: runId }, targetToken } = created.json<{ run: { id: string }; targetToken: string }>();
  assert.ok(targetToken);
  const headers = { authorization: `Bearer ${targetToken}` };
  const attempts: Array<{ operationId: string; action: TargetAction; result: ActionResult }> = [];
  const invoke = async (action: TargetAction, operationId: string = randomUUID()): Promise<ActionResult> => {
    const response = await app.inject({ method: 'POST', url: `/target/runs/${runId}/actions`, headers, payload: { operationId, action } });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<ActionResult>();
    attempts.push({ operationId, action, result });
    return result;
  };
  const mustInvoke = async (action: TargetAction, operationId: string) => {
    const result = await invoke(action, operationId);
    assert.equal(result.ok, true, result.error ?? action.type);
  };

  const tasks = new Map<string, TaskSpec>();
  const completed = new Set<string>();
  const started = new Set<string>();
  const failures: Error[] = [];
  const seenInputSequences = new Set<number>();
  let cursor = 0;
  let status = 'running';
  const execute = async (task: TaskSpec) => {
    await mustInvoke({ type: 'task.update', taskId: task.id, status: 'running', detail: 'Protocol fixture client working through HTTP tools' }, `external-start-${task.id}`);
    // executeWork supplies deterministic algorithms, not a real intelligent Agent. All
    // business input and effects use the HTTP adapter below. This impossible directory
    // ensures direct ctx.runDir filesystem access would fail rather than leak fixtures.
    await executeWork({
      runDir: '/dev/null/shiyu-lab-no-target-filesystem', task,
      signal: controller.signal, action: invoke,
    });
    await mustInvoke({ type: 'task.update', taskId: task.id, status: 'completed', detail: 'Protocol fixture client produced deliverables; independent acceptance pending' }, `external-complete-${task.id}`);
    await mustInvoke({ type: 'message.send', taskId: task.id, channelId: task.channelId, toActorId: task.ownerId, text: `「${task.title}」成果已交付：${task.deliverables.join('、')}` }, `external-deliver-${task.id}`);
    completed.add(task.id);
  };
  const pump = () => {
    for (const task of tasks.values()) {
      if (active.size >= 2) break;
      if (started.has(task.id) || task.dependencies.some(id => !completed.has(id))) continue;
      started.add(task.id);
      const work = execute(task).catch(error => { failures.push(error instanceof Error ? error : new Error(String(error))); }).finally(() => active.delete(task.id));
      active.set(task.id, work);
    }
  };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/target/runs/${runId}/inputs?after=${cursor}`, headers });
    assert.equal(response.statusCode, 200, response.body);
    const packet = response.json<{ status: string; inputs: TargetInput[] }>();
    status = packet.status;
    for (const input of packet.inputs) {
      assert.ok(input.seq > cursor, 'Cursor must only release newer input');
      assert.equal(seenInputSequences.has(input.seq), false, 'Client must not receive duplicate input sequences');
      seenInputSequences.add(input.seq);
      assert.ok(input.event.type.startsWith('input.'));
      if (input.event.type === 'input.request') {
        assert.ok(input.task, 'Released work request must include its TaskSpec');
        tasks.set(input.task.id, input.task);
      }
    }
    if (packet.inputs.length) cursor = Math.max(...packet.inputs.map(input => input.seq));
    pump();
    if (failures.length) throw failures[0];
    if (['completed', 'stopped', 'interrupted', 'failed'].includes(status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await Promise.all([...active.values()]);
  if (failures.length) throw failures[0];
  assert.equal(status, 'completed');
  assert.equal(tasks.size, 8);
  assert.equal(completed.size, 8);
  assert.ok(seenInputSequences.size >= 60, 'Noise and business inputs must arrive while work executes');

  const lost = attempts.filter(attempt => attempt.result.unknown);
  assert.equal(lost.length, 1, 'The configured fault must actually be exercised');
  const retried = attempts.filter(attempt => attempt.operationId === lost[0].operationId);
  assert.ok(retried.length >= 2);
  assert.ok(retried.some(attempt => attempt.result.ok), 'The original operation identity must recover the actual successful result');
  for (const attempt of retried) assert.deepEqual(attempt.action, lost[0].action);

  // Only after the protocol client finishes does the operator inspect sealed facts.
  let detail: RunDetail | undefined;
  do {
    const response = await app.inject(`/api/runs/${runId}`);
    assert.equal(response.statusCode, 200, response.body);
    detail = response.json<RunDetail>();
    if (detail.factReport) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.ok(detail?.factReport, 'Independent evaluation must finish');
  assert.equal(detail.factReport.scope, 'target_evaluation');
  assert.equal(detail.factReport.tasksTotal, 8);
  assert.equal(detail.factReport.tasksPassed, 8, JSON.stringify(detail.factReport.assertions.filter(a => a.taskId && a.status !== 'pass')));
  assert.equal(detail.events.filter(event => ['file.written', 'service.configured'].includes(event.type) && event.data?.operationId === lost[0].operationId).length, 1, 'Lost receipt retry must not duplicate the actual effect');
  assert.ok(detail.artifacts.some(artifact => artifact.path.endsWith('.xlsx')));
  assert.ok(detail.artifacts.some(artifact => artifact.path.endsWith('.docx')));
});
