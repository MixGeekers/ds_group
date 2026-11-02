import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LabEngine } from '../src/engine.ts';
import { getScenario } from '../src/catalog.ts';
import { buildEvidencePacket, evaluateRun } from '../src/evaluation.ts';
import { ScenarioLibrary } from '../src/scenarios.ts';
import type { RunConfig, Scenario } from '../src/types.ts';

const runtimeRoot = fileURLToPath(new URL('../runtime/collaboration-tests/', import.meta.url));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Collaboration test timed out'); await delay(5); }
}
async function setup(t: test.TestContext, config: Partial<RunConfig> = {}, scenario?: Scenario) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'run-'));
  const library = new ScenarioLibrary(root); library.init();
  const engine = new LabEngine({ runtimeDir: root, scenarioResolver: (id, mode) => scenario ? structuredClone(scenario) : library.get(id, mode).scenario }); await engine.init();
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const { run, targetToken } = await engine.createRun({ scenarioId: scenario?.id ?? 'free-chat', target: 'external', evaluationMode: 'outcome', noiseCount: 0, speed: 1000, keepOpen: true, maxDurationMs: 30000, ...config });
  return { engine, id: run.id, root, library, targetToken: targetToken! };
}

test('free chat stays open after scripted input and explicit drain seals it', async t => {
  const { engine, id } = await setup(t);
  await until(() => engine.getRun(id).events.some(event => event.type === 'run.inputs_finished'));
  assert.equal(engine.getRun(id).status, 'running');
  const sent = await engine.postMessage(id, { channelId: 'D-SHIYU', text: '你好，今天一起核对计划。' }, 'hello');
  assert.equal(sent.ok, true, sent.error);
  assert.equal(engine.targetInputs(id).at(-1)?.event.data?.source, 'human');
  await engine.controlRun(id, 'drain');
  await until(() => Boolean(engine.getRun(id).factReport));
  assert.equal(engine.getRun(id).status, 'completed');
  assert.equal((await engine.postMessage(id, { channelId: 'D-SHIYU', text: '封存后新消息' }, 'late')).ok, false);
  assert.deepEqual(await engine.postMessage(id, { channelId: 'D-SHIYU', text: '你好，今天一起核对计划。' }, 'hello'), sent);
});

test('uploaded inputs stay private until shared; retries are single effects and reject changed content', async t => {
  const { engine, id } = await setup(t);
  const input = { path: 'inputs/user/列表.json', content: '[1,2,3]', encoding: 'utf8' as const };
  const upload = await engine.addInputFile(id, input, 'upload-one');
  assert.equal(upload.ok, true, upload.error);
  assert.equal((await engine.act(id, { type: 'file.read', path: input.path }, 'read-private')).ok, false);
  assert.deepEqual(await engine.addInputFile(id, input, 'upload-one'), upload);
  assert.equal((await engine.addInputFile(id, { ...input, content: '[4]' }, 'upload-one')).ok, false);
  const message = { channelId: 'D-SHIYU', text: '请阅读列表', attachments: [input.path] };
  const receipt = await engine.postMessage(id, message, 'share-one');
  assert.equal(receipt.ok, true, receipt.error);
  assert.deepEqual(await engine.postMessage(id, message, 'share-one'), receipt);
  const read = await engine.act(id, { type: 'file.read', path: input.path }, 'read-shared');
  assert.equal(read.ok, true, read.error); assert.equal((read.data as { content: string }).content, input.content);
  assert.equal(engine.getRun(id).events.filter(event => event.type === 'workspace.input_added').length, 1);
  assert.equal(engine.getRun(id).events.filter(event => event.data?.humanOperationKey === 'human/share-one').length, 1);
  assert.equal((await engine.postMessage(id, { ...message, attachments: ['inputs/user/missing.json'] }, 'share-missing')).ok, false);
});

test('drain rejects new human input while permitting an admitted task to deliver', async t => {
  const { engine, id } = await setup(t);
  const published = await engine.publishTask(id, { channelId: 'D-SHIYU', title: '排空前的任务', instructions: '交付一条可执行的安排。' }, 'admitted-task');
  assert.equal(published.ok, true, published.error);
  const taskId = (published.data as { task: { id: string } }).task.id;
  await engine.controlRun(id, 'drain');
  assert.equal(engine.getRun(id).status, 'draining');
  assert.equal((await engine.postMessage(id, { channelId: 'D-SHIYU', text: '新的任务输入' }, 'during-drain')).ok, false);
  assert.equal((await engine.addInputFile(id, { path: 'inputs/user/late.txt', content: 'late' }, 'late-upload')).ok, false);
  assert.equal((await engine.act(id, { type: 'task.deliver', taskId, paths: [], text: '明日上午九点先核对清单，十点前完成资料整理并在此会话交付。' }, 'admitted-delivery')).ok, true);
  await until(() => Boolean(engine.getRun(id).factReport));
  assert.equal(engine.getRun(id).status, 'completed');
  assert.equal(engine.getRun(id).factReport?.tasksSubmitted, 1);
});

test('human cannot write into employee direct chats and target cannot attach unregistered or changed files', async t => {
  const { engine, id } = await setup(t, { scenarioId: 'mixed-office', speed: 1 });
  assert.equal((await engine.postMessage(id, { channelId: 'D03', text: '不属于此会话的发言' }, 'private')).ok, false);
  assert.equal((await engine.publishTask(id, { channelId: 'D03', title: '越界任务', instructions: '请检查资料' }, 'private-task')).ok, false);
  assert.equal((await engine.act(id, { type: 'message.send', channelId: 'D03', text: '可以向职员发言' }, 'target-message')).ok, true);
  assert.equal((await engine.act(id, { type: 'message.send', channelId: 'D-SHIYU', text: '', attachments: ['inputs/orders.json'] }, 'input-as-output')).ok, false);
  const published = await engine.publishTask(id, { channelId: 'D-SHIYU', title: '写一份说明', instructions: '写出实际说明内容' }, 'new-task');
  assert.equal(published.ok, true, published.error);
  const taskId = (published.data as { task: { id: string } }).task.id;
  const filename = `outputs/${taskId}/说明.md`;
  assert.equal((await engine.act(id, { type: 'file.write', taskId, path: filename, content: '实际成果' }, 'write-note')).ok, true);
  assert.equal((await engine.act(id, { type: 'message.send', channelId: 'D-SHIYU', text: '', attachments: [filename] }, 'attach-note')).ok, true);
  await writeFile(path.join(engine.runDir(id), 'workspace', filename), '被改变的成果');
  assert.equal((await engine.act(id, { type: 'message.send', channelId: 'D-SHIYU', text: '', attachments: [filename] }, 'attach-changed')).ok, false);
});

test('manual tasks with JSON-array inputs submit, seal with evidence, and restore without replay', async t => {
  const { engine, id, root } = await setup(t);
  const file = { path: 'inputs/user/list.json', content: '[2,3,5]' };
  assert.equal((await engine.addInputFile(id, file, 'list-upload')).ok, true);
  const published = await engine.publishTask(id, { channelId: 'D-SHIYU', title: '列表汇总', instructions: '给出数量与总和', inputs: [file.path] }, 'list-task');
  assert.equal(published.ok, true, published.error);
  assert.deepEqual(await engine.publishTask(id, { channelId: 'D-SHIYU', title: '列表汇总', instructions: '给出数量与总和', inputs: [file.path] }, 'list-task'), published);
  const taskId = (published.data as { task: { id: string } }).task.id;
  assert.equal((await engine.act(id, { type: 'task.deliver', taskId, paths: [], text: '列表包含 3 个数字，总和为 10；按原始列表逐项汇总。' }, 'submit-list')).ok, true);
  await engine.controlRun(id, 'drain'); await until(() => Boolean(engine.getRun(id).factReport));
  const run = engine.getRun(id), facts = run.factReport!;
  assert.equal(facts.tasksSubmitted, 1); assert.equal(facts.tasksPassed, 0);
  assert.ok(!facts.assertions.some(assertion => assertion.taskId === taskId && assertion.status === 'fail'), JSON.stringify(facts));
  const packet = await buildEvidencePacket(run, engine.runDir(id));
  assert.ok(packet.fileIndex?.some(entry => entry.path === file.path));
  assert.ok(packet.events.some(event => event.actorId === 'HUMAN' && event.type === 'input.request'));
  assert.ok(packet.company?.actors.some(actor => actor.id === 'SHIYU'));
  const eventCount = run.events.length;
  await engine.close();
  const restored = new LabEngine({ runtimeDir: root }); await restored.init();
  try {
    assert.equal(restored.getRun(id).status, 'completed');
    assert.equal(restored.getRun(id).events.length, eventCount);
    assert.deepEqual(await restored.publishTask(id, { channelId: 'D-SHIYU', title: '列表汇总', instructions: '给出数量与总和', inputs: [file.path] }, 'list-task'), published);
    assert.equal(restored.getRun(id).tasks.length, 1);
  } finally { await restored.close(); }
});

test('custom report sources use an unknown-schema result instead of a false numerical failure', async t => {
  const { engine, library } = await setup(t);
  const saved = library.save({ scenario: { id: 'draft', name: '自己的经营数据', durationMs: 20, actors: [], channels: [], assets: [{ path: 'inputs/custom/sales.json', content: '[{"amount":15},{"amount":25}]' }], tasks: [{ id: 'Sales', subjectId: 'report', title: '销售汇总', instructions: '汇总实际金额', inputs: ['inputs/custom/sales.json'] }], inputs: [{ id: 'SalesRequest', kind: 'request', atMs: 0, actorId: 'HUMAN', channelId: 'D-SHIYU', taskId: 'Sales', text: '汇总实际销售金额。' }] } });
  const { run } = await engine.createRun({ scenarioId: saved.scenario.id, target: 'external', evaluationMode: 'outcome', keepOpen: true, speed: 1000, noiseCount: 0, maxDurationMs: 10000 });
  await until(() => engine.getRun(run.id).tasks[0].introduced);
  const filename = 'outputs/Sales/totals.csv';
  assert.equal((await engine.act(run.id, { type: 'file.write', taskId: 'Sales', path: filename, content: '销售额,40\n' }, 'report-write')).ok, true);
  assert.equal((await engine.act(run.id, { type: 'task.deliver', taskId: 'Sales', paths: [filename], text: '销售额：40' }, 'report-submit')).ok, true);
  await engine.controlRun(run.id, 'drain'); await until(() => Boolean(engine.getRun(run.id).factReport));
  const result = engine.getRun(run.id);
  assert.ok(!result.factReport?.assertions.some(assertion => assertion.taskId === 'Sales' && assertion.status === 'fail'));
  assert.match(result.factReport?.assertions.find(assertion => assertion.id === 'outcome:Sales:numbers')?.detail ?? '', /自定义输入/);
  const snapshot = await readFile(path.join(engine.runDir(run.id), 'scenario.json'));
  assert.equal((result.manifest.scenarioSnapshot as { sha256: string }).sha256, createHash('sha256').update(snapshot).digest('hex'));
  await writeFile(path.join(engine.runDir(run.id), 'workspace/inputs/custom/sales.json'), '[999]');
  const damaged = await evaluateRun(result, engine.runDir(run.id));
  assert.ok(damaged.assertions.some(assertion => assertion.taskId === 'Sales' && assertion.status === 'fail'));
});

test('token rotation invalidates old token and live chat restart preserves interruption', async t => {
  const { engine, id, root, targetToken } = await setup(t);
  const nextToken = engine.rotateTargetToken(id);
  assert.equal(engine.authorizeTarget(id, targetToken), false); assert.equal(engine.authorizeTarget(id, nextToken), true);
  const input = { channelId: 'D-SHIYU', text: '重启后仅保留历史，不自动重新执行。' };
  assert.equal((await engine.postMessage(id, input, 'before-restart')).ok, true);
  await engine.close();
  const reopened = new LabEngine({ runtimeDir: root }); await reopened.init();
  try {
    assert.equal(reopened.getRun(id).status, 'interrupted');
    const events = reopened.getRun(id).events.length;
    await delay(20); assert.equal(reopened.getRun(id).events.length, events);
    assert.equal((await reopened.postMessage(id, { ...input, text: '新的输入' }, 'after-restart')).ok, false);
    assert.throws(() => reopened.rotateTargetToken(id), /活动 external/);
  } finally { await reopened.close(); }
});

test('open chat expires normally with no tasks and keeps its original history on restart', async t => {
  const { engine, id, root } = await setup(t, { maxDurationMs: 150 });
  await until(() => Boolean(engine.getRun(id).factReport));
  const run = engine.getRun(id);
  assert.equal(run.status, 'completed'); assert.equal(run.error, undefined);
  assert.ok(run.events.some(event => event.type === 'run.deadline_reached' && event.data?.reason === 'time_budget_after_delivery'));
  await engine.close();
  const reopened = new LabEngine({ runtimeDir: root }); await reopened.init();
  try { assert.deepEqual(reopened.getRun(id).events, run.events); assert.equal(reopened.getRun(id).status, 'completed'); }
  finally { await reopened.close(); }
});

test('open chat expires normally after actual submission without promoting business success', async t => {
  const { engine, id } = await setup(t, { maxDurationMs: 500 });
  const published = await engine.publishTask(id, { channelId: 'D-SHIYU', title: '到期前交付', instructions: '给出一条明确行动安排。' }, 'deadline-task');
  const taskId = (published.data as { task: { id: string } }).task.id;
  const delivered = await engine.act(id, { type: 'task.deliver', taskId, paths: [], text: '明日上午九点核对需求清单，由负责人确认范围后按优先级登记行动项。' }, 'deadline-delivery');
  assert.equal(delivered.ok, true, delivered.error);
  assert.equal(engine.getRun(id).status, 'running');
  await until(() => Boolean(engine.getRun(id).factReport));
  const run = engine.getRun(id);
  assert.equal(run.status, 'completed'); assert.equal(run.error, undefined);
  assert.equal(run.factReport?.tasksSubmitted, 1); assert.equal(run.factReport?.tasksPassed, 0);
});

for (const status of ['queued', 'running', 'waiting', 'failed', 'cancelled'] as const) {
  test(`open chat expiry preserves interruption for an unsubmitted ${status} task`, async t => {
    const { engine, id } = await setup(t, { maxDurationMs: 500 });
    const published = await engine.publishTask(id, { channelId: 'D-SHIYU', title: '尚未交付', instructions: '给出实际处理结果。' }, 'unsubmitted');
    const taskId = (published.data as { task: { id: string } }).task.id;
    if (status !== 'queued') assert.equal((await engine.act(id, { type: 'task.update', taskId, status }, 'set-status')).ok, true);
    await until(() => Boolean(engine.getRun(id).factReport));
    assert.equal(engine.getRun(id).status, 'interrupted');
    assert.equal(engine.getRun(id).factReport?.tasksSubmitted, 0);
  });
}

test('open chat with not-yet-finished scripted input still expires as interrupted', async t => {
  const { engine, id } = await setup(t, { maxDurationMs: 150, speed: 1 });
  await until(() => Boolean(engine.getRun(id).factReport));
  assert.equal(engine.getRun(id).status, 'interrupted');
  assert.ok(!engine.getRun(id).events.some(event => event.type === 'run.inputs_finished'));
});

test('expiry does not complete while a scripted actor response is still pending', async t => {
  const source = getScenario('mixed-office', 'outcome');
  const task = source.tasks.find(item => item.id === 'T03')!;
  const scenario = { ...source, id: 'deadline-actor', durationMs: 1, tasks: [task], inputs: [{ ...source.inputs.find(input => input.kind === 'request' && input.taskId === task.id)!, atMs: 0 }] };
  const { engine, id } = await setup(t, { maxDurationMs: 100 }, scenario);
  await until(() => engine.getRun(id).tasks[0].introduced);
  assert.equal((await engine.act(id, { type: 'message.send', taskId: task.id, channelId: task.channelId, text: '会议纪要已完成，成果已经交付。' }, 'notify-actor')).ok, true);
  assert.equal((await engine.act(id, { type: 'task.deliver', taskId: task.id, paths: [], text: '会议决定分两批交付；项目经理在明天下午前确认第一批清单，未定日期单独待确认。' }, 'actor-task-deliver')).ok, true);
  await until(() => Boolean(engine.getRun(id).factReport));
  assert.equal(engine.getRun(id).status, 'interrupted');
  assert.equal(engine.getRun(id).factReport?.tasksSubmitted, 1);
  assert.match(engine.getRun(id).error ?? '', /已经交付的成果/);
});

test('expiry interrupts a reference worker that is still executing', async t => {
  const source = getScenario('mixed-office');
  const scenario = { ...source, id: 'deadline-worker', durationMs: 1, tasks: [source.tasks[0]], inputs: [source.inputs[0]] };
  const { engine, id } = await setup(t, { target: 'reference', evaluationMode: 'protocol', taskDelayMs: 1000, maxDurationMs: 150 }, scenario);
  await until(() => engine.getRun(id).tasks[0].status === 'running');
  await until(() => Boolean(engine.getRun(id).factReport));
  assert.equal(engine.getRun(id).status, 'interrupted');
  assert.equal(engine.getRun(id).artifacts.length, 0);
});

for (const filesWritten of [false, true]) {
  test(`protocol expiry rejects a completed claim without delivery (${filesWritten ? 'files exist' : 'files missing'})`, async t => {
    const source = getScenario('mixed-office');
    const scenario = { ...source, id: 'deadline-protocol', durationMs: 1, tasks: [source.tasks[0]], inputs: [source.inputs[0]] };
    const { engine, id } = await setup(t, { evaluationMode: 'protocol', maxDurationMs: 500 }, scenario);
    await until(() => engine.getRun(id).tasks[0].introduced);
    const task = engine.getRun(id).tasks[0];
    if (filesWritten) for (const filename of task.deliverables) assert.equal((await engine.act(id, { type: 'file.write', taskId: task.id, path: filename, content: '实际文件尚未送达' })).ok, true);
    assert.equal((await engine.act(id, { type: 'task.update', taskId: task.id, status: 'completed' }, 'claim-completed')).ok, true);
    await until(() => Boolean(engine.getRun(id).factReport));
    assert.equal(engine.getRun(id).status, 'interrupted');
  });
}
