import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { getScenario } from '../src/catalog.ts';
import { executeWork, initialServiceState, seedWorkspace } from '../src/workloads.ts';
import { buildEvidencePacket, evaluateRun, readWorkspaceEvidence } from '../src/evaluation.ts';
import type { ActionResult, LabEvent, RunDetail, TargetAction, TaskRecord } from '../src/types.ts';

const runtimeRoot = fileURLToPath(new URL('../runtime/evaluation-tests/', import.meta.url));
async function prepare(t: test.TestContext, selected = ['T01'], execute = true) {
  await mkdir(runtimeRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(runtimeRoot, 'run-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const scenario = getScenario('mixed-office');
  await seedWorkspace(runDir, scenario);
  const tasks: TaskRecord[] = scenario.tasks.filter(task => selected.includes(task.id)).map(task => ({ ...task, introduced: true, status: 'queued', artifactPaths: [] }));
  const detail: RunDetail = {
    id: 'test-run', name: '验收反例测试', status: 'completed', createdAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:01:00.000Z', targetLabel: '参考执行器',
    config: { scenarioId: scenario.id, target: 'reference', seed: 1, noiseCount: 0, speed: 1, workerConcurrency: 2, taskDelayMs: 0, fault: 'none', maxDurationMs: 30000 },
    metrics: { scheduledInputs: tasks.length, injectedInputs: tasks.length, replies: 0, toolCalls: 0, completedTasks: 0, failedTasks: 0, pendingTasks: 0, maxInjectionLagMs: 0, elapsedMs: 1000 },
    tasks, events: [], artifacts: [], reviews: [], service: structuredClone(initialServiceState), memory: {}, manifest: { test: true },
  };
  function event(type: string, taskId: string, data: Record<string, unknown> = {}, channelId?: string, text = type) {
    const e: LabEvent = { id: `e${detail.events.length + 1}`, seq: detail.events.length + 1, runId: detail.id, at: '2026-11-01T00:00:01.000Z', elapsedMs: detail.events.length, businessMs: detail.events.length, type, role: 'world', taskId, data: structuredClone(data), channelId, text };
    detail.events.push(e); return e;
  }
  async function action(input: TargetAction, operationId = 'op'): Promise<ActionResult> {
    switch (input.type) {
      case 'file.read': return { ok: true, data: { content: await readFile(path.join(runDir, 'workspace', input.path), 'utf8'), encoding: 'utf8' } };
      case 'file.write': {
        const buffer = Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8');
        const filename = path.join(runDir, 'workspace', input.path); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, buffer);
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        detail.artifacts = detail.artifacts.filter(a => a.path !== input.path);
        detail.artifacts.push({ path: input.path, name: path.basename(input.path), bytes: buffer.length, sha256, mime: 'application/octet-stream', taskId: input.taskId });
        detail.tasks.find(task => task.id === input.taskId)!.artifactPaths.push(input.path);
        event('file.written', input.taskId, { operationId, path: input.path, bytes: buffer.length, sha256 });
        return { ok: true };
      }
      case 'service.inspect': event('service.inspected', input.taskId!, { operationId, service: detail.service }); return { ok: true, data: structuredClone(detail.service) };
      case 'service.configure':
        detail.service.config.maxConnections = input.maxConnections; detail.service.config.maintenance = input.maintenance;
        detail.service.healthy = input.maxConnections >= detail.service.config.requiredConnections && !input.maintenance;
        detail.service.revision++;
        await writeFile(path.join(runDir, 'workspace/service.json'), JSON.stringify(detail.service));
        event('service.configured', input.taskId, { operationId, service: detail.service }); return { ok: true, data: structuredClone(detail.service) };
      default: return { ok: true };
    }
  }
  for (const task of tasks) {
    event('input.request', task.id, {}, task.channelId, task.instructions);
    event('message.delivered', task.id, { operationId: `${task.id}:ack` }, task.channelId, '收到，已接单');
    if (execute) {
      await executeWork({ runDir, task, signal: new AbortController().signal, action });
      task.status = 'completed';
      event('message.delivered', task.id, { operationId: `${task.id}:delivery` }, task.channelId, '成果已生成，请查看');
    }
  }
  return { detail, runDir, action, event };
}

test('independent verifier reads all eight real outputs and service effects', async t => {
  const { detail, runDir } = await prepare(t, ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08']);
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.scope, 'lab_self_test');
  assert.equal(report.tasksPassed, 8, JSON.stringify(report.assertions.filter(a => a.status === 'fail')));
  assert.equal(report.tasksTotal, 8); assert.equal(report.completionRate, 1);
  assert.equal(report.assertions.find(a => a.id === 'scope:internal-capabilities')?.status, 'inconclusive');
  detail.factReport = report;
  const packet = await buildEvidencePacket(detail, runDir);
  assert.ok(packet.evidence.some(e => e.ref === 'artifact:outputs/T01/result.json' && e.text.includes('3760')));
  assert.ok(packet.evidence.some(e => e.ref === 'artifact:service.json'));
});

test('task completed claim and acknowledgement cannot replace missing deliverables', async t => {
  const { detail, runDir } = await prepare(t, ['T01'], false); detail.tasks[0].status = 'completed';
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksPassed, 0); assert.equal(report.assertions[0].status, 'fail');
});

test('stopped missing work is inconclusive; tasks never introduced are excluded', async t => {
  const { detail, runDir } = await prepare(t, ['T01', 'T02'], false);
  detail.status = 'stopped'; detail.tasks[1].introduced = false;
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksTotal, 1); assert.equal(report.tasksPassed, 0);
  assert.equal(report.assertions[0].status, 'inconclusive'); assert.equal(report.assertions[1].status, 'not_applicable');
});

test('a pre-work acknowledgement never counts as post-artifact delivery', async t => {
  const { detail, runDir } = await prepare(t, ['T01']);
  detail.events.pop();
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksPassed, 0); assert.match(report.assertions[0].detail, /实际交付/);
});

test('numerical corruption fails even after artifact metadata and write receipts are refreshed', async t => {
  const { detail, runDir, action, event } = await prepare(t, ['T01']);
  const relative = 'outputs/T01/result.json', result = JSON.parse(await readFile(path.join(runDir, 'workspace', relative), 'utf8'));
  result.netRevenue += 100;
  await action({ type: 'file.write', taskId: 'T01', path: relative, content: JSON.stringify(result) }, 'tamper-report');
  event('message.delivered', 'T01', { operationId: 'redelivery' }, detail.tasks[0].channelId, '修订完成');
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksPassed, 0); assert.match(report.assertions[0].detail, /净收入/);
});

test('a fake Office file fails despite valid JSON business totals', async t => {
  const { detail, runDir, action, event } = await prepare(t, ['T03']);
  await action({ type: 'file.write', taskId: 'T03', path: 'outputs/T03/minutes.docx', content: 'pretend this is a Word file' }, 'fake-docx');
  event('message.delivered', 'T03', { operationId: 'redelivery' }, detail.tasks[0].channelId, '修订完成');
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksPassed, 0); assert.match(report.assertions[0].detail, /ZIP/);
});

for (const [taskId, filename] of [['T01', 'report.csv'], ['T02', 'reconciliation.csv'], ['T06', 'plan.csv'], ['T05', 'comparison.md'], ['T07', 'inspection.md'], ['T08', 'maintenance.md']]) {
  test(`human-readable ${filename} cannot be junk while its JSON remains correct`, async t => {
    const { detail, runDir, action, event } = await prepare(t, [taskId]);
    await action({ type: 'file.write', taskId, path: `outputs/${taskId}/${filename}`, content: '这里没有任何可用的业务成果。\n' }, `corrupt-${filename}`);
    event('message.delivered', taskId, { operationId: 'redelivery' }, detail.tasks[0].channelId, '已交付');
    const report = await evaluateRun(detail, runDir);
    assert.equal(report.tasksPassed, 0); assert.equal(report.assertions[0].status, 'fail');
  });
}

test('a workbook containing the right three totals but no usable report fails', async t => {
  const { detail, runDir, action, event } = await prepare(t, ['T01']);
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('数字').addRow([4060, 300, 3760]);
  await action({ type: 'file.write', taskId: 'T01', path: 'outputs/T01/report.xlsx', content: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'), encoding: 'base64' }, 'junk-workbook');
  event('message.delivered', 'T01', { operationId: 'redelivery' }, detail.tasks[0].channelId, '已交付');
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksPassed, 0); assert.match(report.assertions[0].detail, /Excel 缺少/);
});

test('correct cached Excel totals do not conceal an incorrect formula', async t => {
  const { detail, runDir, action, event } = await prepare(t, ['T01']);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.join(runDir, 'workspace/outputs/T01/report.xlsx'));
  const cell = workbook.getWorksheet('经营汇总')!.getCell('D3');
  assert.ok(cell.value && typeof cell.value === 'object' && 'result' in cell.value);
  cell.value = { formula: 'B3+C3', result: cell.value.result };
  await action({ type: 'file.write', taskId: 'T01', path: 'outputs/T01/report.xlsx', content: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'), encoding: 'base64' }, 'bad-formula');
  event('message.delivered', 'T01', { operationId: 'redelivery' }, detail.tasks[0].channelId, '已交付');
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksPassed, 0); assert.match(report.assertions[0].detail, /公式缓存/);
});

test('inspection self-report needs independent service observation', async t => {
  const { detail, runDir } = await prepare(t, ['T07']);
  detail.events = detail.events.filter(e => e.type !== 'service.inspected').map((e, i) => ({ ...e, seq: i + 1, id: `e${i + 1}` }));
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.tasksPassed, 0); assert.match(report.assertions[0].detail, /真实探测/);
});

test('same operation producing a second effect is independently detected', async t => {
  const { detail, runDir, event } = await prepare(t, ['T04']);
  const original = detail.events.find(e => e.type === 'file.written')!;
  event(original.type, 'T04', original.data);
  const report = await evaluateRun(detail, runDir);
  assert.equal(report.assertions.find(a => a.id === 'protocol:unique-effects')?.status, 'fail');
});

test('evidence reader refuses lexical traversal and symlink escape', async t => {
  const { runDir } = await prepare(t, [], false);
  await writeFile(path.join(runDir, 'outside.txt'), 'not evidence');
  await symlink(path.join(runDir, 'outside.txt'), path.join(runDir, 'workspace/escape.txt'));
  await assert.rejects(readWorkspaceEvidence(runDir, '../outside.txt'), /跳转/);
  await assert.rejects(readWorkspaceEvidence(runDir, 'escape.txt'), /越出/);
});

test('large evidence packets keep task evidence and explicitly disclose omitted events', async t => {
  const { detail, runDir } = await prepare(t, ['T04']);
  const originalCount = detail.events.length;
  for (let i = 0; i < 250; i++) detail.events.push({
    id: `noise-${i}`, seq: detail.events.length + 1, runId: detail.id, at: detail.createdAt,
    elapsedMs: i, businessMs: i, type: 'input.message', role: 'world', text: '背景闲聊'.repeat(1000),
  });
  detail.factReport = await evaluateRun(detail, runDir);
  const packet = await buildEvidencePacket(detail, runDir);
  assert.ok(packet.events.length < detail.events.length);
  assert.ok(packet.events.length >= originalCount);
  assert.match(packet.instructions, new RegExp(`/${detail.events.length} 条事件`));
  assert.ok(packet.evidence.some(e => e.ref === 'artifact:outputs/T04/copy.md'));
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 2 * 1024 * 1024);
});
