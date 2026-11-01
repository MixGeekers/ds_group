import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { LabEngine } from '../src/engine.ts';
import { getScenario, outcomeCatalog } from '../src/catalog.ts';
import { buildEvidencePacket, evaluateRun, readEvidenceFile } from '../src/evaluation.ts';
import type { RunConfig, RunDetail, TargetAction } from '../src/types.ts';

const runtimeRoot = fileURLToPath(new URL('../runtime/outcome-tests/', import.meta.url));
async function until(condition: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Outcome test condition timed out'); await delay(10); }
}
async function setup(t: test.TestContext, config: Partial<RunConfig> = {}, introduce = true) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'run-'));
  const engine = new LabEngine({ runtimeDir: root }); await engine.init();
  t.after(async () => {
    await engine.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(runtimeRoot) + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const { run } = await engine.createRun({ scenarioId: 'mixed-office', target: 'external', evaluationMode: 'outcome', noiseCount: 0, speed: 1000, taskDelayMs: 0, maxDurationMs: 30000, ...config });
  if (introduce) await until(() => engine.getRun(run.id).tasks.every(task => task.introduced));
  return { engine, id: run.id, runDir: engine.runDir(run.id), root };
}
async function write(engine: LabEngine, id: string, taskId: string, name: string, content: string | Buffer) {
  const filename = `outputs/${taskId}/${name}`;
  const result = await engine.act(id, { type: 'file.write', taskId, path: filename, content: typeof content === 'string' ? content : content.toString('base64'), encoding: typeof content === 'string' ? 'utf8' : 'base64' });
  assert.equal(result.ok, true, result.error);
  return filename;
}
async function submit(engine: LabEngine, id: string, taskId: string, paths: string[], text: string, operationId?: string) {
  return engine.act(id, { type: 'task.deliver', taskId, paths, text }, operationId);
}
const main = (report: Awaited<ReturnType<typeof evaluateRun>>, taskId: string) => report.assertions.find(assertion => assertion.id === `task:${taskId}:verified`)!;
async function inspect(engine: LabEngine, id: string, runDir: string) { return evaluateRun(engine.getRun(id), runDir); }
const totals = { grossRevenue: 4060, refundAmount: 300, netRevenue: 3760, orderCount: 4, netUnits: 29 };
const substantive = '会议纪要：已确认事项、行动负责人和截止日期见正文；未决事项单独列出，建议未当作决定。';

test('protocol remains the default, outcome has eight goal-based tasks and rejects the reference executor', async t => {
  const protocol = getScenario('mixed-office');
  assert.ok(protocol.tasks.every(task => task.deliverables.some(file => file.endsWith('/result.json'))));
  const outcome = getScenario('mixed-office', 'outcome');
  assert.equal(outcome.tasks.length, 8); assert.equal(outcomeCatalog.scenarios.length, 4);
  assert.ok(outcome.tasks.every(task => !task.deliverables.length && task.businessRequirements?.length && task.deliveryPolicy && task.evaluationMode === 'outcome'));
  assert.ok(outcome.tasks.every(task => !task.instructions.includes('result.json') && !task.inputs.some(input => input.includes('output-contracts') || input.startsWith('outputs/'))));
  assert.ok(outcome.inputs.filter(input => input.kind === 'request').every(input => !input.text.includes('result.json')));
  const { engine, id } = await setup(t, { evaluationMode: undefined }, false);
  assert.equal(engine.getRun(id).config.evaluationMode, 'protocol');
  await assert.rejects(engine.createRun({ target: 'reference', evaluationMode: 'outcome' }), /仅支持 external/);
  await assert.rejects(engine.createRun({ evaluationMode: 'unknown' as any }), /未知验收模式/);
});

test('unintroduced tasks and their inputs/service cannot be accessed or submitted', async t => {
  const { engine, id } = await setup(t, { speed: 1 }, false);
  assert.equal(engine.targetInputs(id).length, 0);
  assert.equal((await submit(engine, id, 'T04', [], '完整产品文案内容在此。')).ok, false);
  assert.equal((await engine.act(id, { type: 'file.read', path: 'inputs/product.json' })).ok, false);
  assert.equal((await engine.act(id, { type: 'service.inspect' })).ok, false);
  await until(() => engine.getRun(id).tasks[0].introduced);
  const inputs = engine.targetInputs(id);
  assert.ok(inputs.every(input => input.evaluationMode === 'outcome'));
  assert.ok(inputs.filter(input => input.task).every(input => input.task!.id === 'T01'));
  assert.ok(inputs[0].task?.businessRequirements?.length);
  assert.ok(!JSON.stringify(inputs).includes('factReport') && !JSON.stringify(inputs).includes('inputAssets'));
  assert.equal((await engine.act(id, { type: 'file.read', path: 'inputs/orders.json' })).ok, true);
  assert.equal((await engine.act(id, { type: 'file.read', path: 'inputs/output-contracts.json' })).ok, false);
});

for (const [name, content] of [
  ['本周经营分析.md', '# 经营分析\n销售额：4060\n退款：300\n净收入：3760\n有效订单数：4\n净销量：29\n异常：存在重复及取消订单，已在口径中排除。'],
  ['totals-any-name.csv', '销售额,4060\n退款,300\n净收入,3760\n有效订单数,4\n净销量,29\n'],
  ['another-structure.json', JSON.stringify({ totals, explanation: '去重、排除取消及期间外订单，并抵减退货。' })],
]) {
  test(`different legitimate output names and formats are accepted without fixed JSON: ${name}`, async t => {
    const { engine, id, runDir } = await setup(t);
    const filename = await write(engine, id, 'T01', name, content);
    assert.equal((await submit(engine, id, 'T01', [filename], '报表与统计口径已交付。')).ok, true);
    const report = await inspect(engine, id, runDir);
    assert.equal(report.evaluationMode, 'outcome');
    assert.equal(report.tasksTotal, 8); assert.equal(report.tasksSubmitted, 1);
    assert.equal(main(report, 'T01').status, 'inconclusive');
    assert.equal(report.assertions.find(assertion => assertion.id === 'outcome:T01:numbers')?.status, 'pass');
    assert.equal(report.tasksPassed, 0); assert.equal(report.completionRate, 0); assert.equal(report.needsJudge, true);
    const run = engine.getRun(id), submitted = run.events.find(event => event.type === 'task.delivered')!, delivered = run.events.find(event => event.causeId === submitted.id)!;
    assert.ok(delivered.seq > submitted.seq); assert.equal(delivered.type, 'message.delivered');
    assert.deepEqual(delivered.data?.paths, [filename]); assert.equal(delivered.data?.toActorId, 'E03');
    assert.equal(run.tasks[0].delivery?.eventId, submitted.id);
  });
}

test('a real differently named spreadsheet is read as evidence, not forced into the reference workbook layout', async t => {
  const { engine, id, runDir } = await setup(t);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('自由布局');
  sheet.addRow(['销售额', 4060]); sheet.addRow(['退款', 300]); sheet.addRow(['净收入', { formula: 'B1-B2', result: 3760 }]);
  const filename = await write(engine, id, 'T01', '自由报表.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  assert.equal((await submit(engine, id, 'T01', [filename], '各指标和公式见表，异常解释另待评审。')).ok, true);
  const report = await inspect(engine, id, runDir);
  assert.equal(main(report, 'T01').status, 'inconclusive');
  assert.equal(report.assertions.find(assertion => assertion.id === 'outcome:T01:numbers')?.status, 'pass');
});

test('actual body delivery is allowed, but messages/acknowledgements/completed claims are not the submission gesture', async t => {
  const { engine, id, runDir } = await setup(t);
  assert.equal((await engine.act(id, { type: 'message.send', taskId: 'T03', channelId: 'C02', text: substantive })).ok, true);
  assert.equal(engine.getRun(id).tasks.find(task => task.id === 'T03')!.status, 'queued');
  assert.equal((await engine.act(id, { type: 'task.update', taskId: 'T03', status: 'completed' })).ok, false);
  assert.equal((await submit(engine, id, 'T03', [], '收到，已接单，稍后处理。')).ok, false);
  assert.equal((await submit(engine, id, 'T03', [], '已完成。')).ok, false);
  assert.equal((await submit(engine, id, 'T03', [], substantive)).ok, true);
  const report = await inspect(engine, id, runDir);
  assert.equal(main(report, 'T03').status, 'inconclusive');
  assert.equal(report.tasksSubmitted, 1);
});

test('required files, registration, owning task, uniqueness and path boundaries are validated before submission', async t => {
  const { engine, id, runDir } = await setup(t);
  assert.equal((await submit(engine, id, 'T01', [], JSON.stringify(totals))).ok, false);
  const own = await write(engine, id, 'T01', 'registered.md', JSON.stringify(totals));
  const other = await write(engine, id, 'T02', 'other-task.txt', '采购单据对账成果');
  await writeFile(path.join(runDir, 'workspace/outputs/T01/unregistered.txt'), 'not registered');
  for (const paths of [['outputs/T01/missing.txt'], ['outputs/T01/unregistered.txt'], [other], [own, own], ['outputs/T01/../../../manifest.json'], ['/etc/passwd'], ['outputs/T01/../T02/other-task.txt']]) {
    assert.equal((await submit(engine, id, 'T01', paths, '提交实际成果。')).ok, false, JSON.stringify(paths));
  }
  assert.equal((await submit(engine, id, 'T99', [], '虚构任务内容')).ok, false);
  assert.equal(engine.getRun(id).events.filter(event => event.type === 'task.delivered').length, 0);
  assert.equal((await submit(engine, id, 'T01', [own], '实际成果在附件。')).ok, true);
});

test('registered files changed before submission are rejected and damaged files after submission fail independent verification', async t => {
  const { engine, id, runDir } = await setup(t);
  const filename = await write(engine, id, 'T01', 'report.txt', JSON.stringify(totals));
  await writeFile(path.join(runDir, 'workspace', filename), 'tampered');
  assert.equal((await submit(engine, id, 'T01', [filename], '报表成果')).ok, false);
  await write(engine, id, 'T01', 'report.txt', JSON.stringify(totals));
  assert.equal((await submit(engine, id, 'T01', [filename], '报表成果')).ok, true);
  await writeFile(path.join(runDir, 'workspace', filename), 'changed after delivery');
  const detail = engine.getRun(id);
  await assert.rejects(readEvidenceFile(detail, runDir, filename), /摘要/);
  assert.equal(main(await evaluateRun(detail, runDir), 'T01').status, 'fail');
});

test('submission and Judge evidence reject internal symlinks, not just lexical traversal', async t => {
  const { engine, id, runDir } = await setup(t);
  const filename = await write(engine, id, 'T01', 'report.txt', JSON.stringify(totals));
  const absolute = path.resolve(runDir, 'workspace', filename), moved = path.resolve(runDir, 'workspace/outputs/T01/original.txt');
  assert.ok(absolute.startsWith(path.resolve(runDir, 'workspace/outputs/T01') + path.sep));
  assert.ok(moved.startsWith(path.resolve(runDir, 'workspace/outputs/T01') + path.sep));
  await rename(absolute, moved); await symlink(moved, absolute);
  assert.equal((await submit(engine, id, 'T01', [filename], '报表成果')).ok, false);
  await assert.rejects(readEvidenceFile(engine.getRun(id), runDir, filename), /符号链接/);
  await assert.rejects(readEvidenceFile(engine.getRun(id), runDir, '../manifest.json'), /范围/);
});

test('forged completion and incorrect delivery recipient/order do not count as completed business work', async t => {
  const { engine, id, runDir } = await setup(t);
  const fake = engine.getRun(id); fake.status = 'completed'; fake.tasks[2].status = 'completed';
  assert.equal(main(await evaluateRun(fake, runDir), 'T03').status, 'fail');
  assert.equal((await submit(engine, id, 'T03', [], substantive)).ok, true);
  for (const mutation of ['recipient', 'order', 'body', 'writeAfterDelivery']) {
    const detail = engine.getRun(id), sent = detail.events.find(event => event.type === 'message.delivered' && event.taskId === 'T03')!;
    if (mutation === 'recipient') sent.data!.toActorId = 'E01';
    if (mutation === 'order') sent.seq = 0;
    if (mutation === 'body') sent.data!.text = '替换后的业务正文';
    if (mutation === 'writeAfterDelivery') detail.events.push({ ...detail.events.find(event => event.type === 'task.delivered')!, id: 'fake-extra-submission', seq: detail.events.length + 1 });
    assert.equal(main(await evaluateRun(detail, runDir), 'T03').status, 'fail', mutation);
  }
});

test('garbage and unsupported formats never auto-pass, while understood wrong numerical facts fail', async t => {
  const { engine, id, runDir } = await setup(t);
  const filename = await write(engine, id, 'T01', 'anything.weird', Buffer.from([0, 255, 1, 254]));
  assert.equal((await submit(engine, id, 'T01', [filename], '成果文件在此，请审阅。')).ok, true);
  let report = await inspect(engine, id, runDir);
  assert.equal(main(report, 'T01').status, 'inconclusive'); assert.equal(report.tasksPassed, 0);
  assert.equal((await submit(engine, id, 'T04', [], 'abcdefghijklmnopqrstuvwxyz')).ok, true);
  report = await inspect(engine, id, runDir);
  assert.equal(main(report, 'T04').status, 'inconclusive'); assert.equal(report.tasksPassed, 0);
  const next = await engine.createRun({ target: 'external', evaluationMode: 'outcome', speed: 1000, noiseCount: 0 });
  await until(() => engine.getRun(next.run.id).tasks[0].introduced);
  const wrong = await write(engine, next.run.id, 'T01', 'different-name.md', '净收入：999999\n');
  assert.equal((await submit(engine, next.run.id, 'T01', [wrong], '本周经营统计。')).ok, true);
  const wrongReport = await evaluateRun(engine.getRun(next.run.id), engine.runDir(next.run.id));
  assert.equal(main(wrongReport, 'T01').status, 'fail');
  assert.ok(wrongReport.assertions.some(assertion => assertion.status === 'fail' && assertion.detail.includes('数值错误')));
});

test('claimed Office output containing junk is not accepted as readable business evidence', async t => {
  const { engine, id, runDir } = await setup(t);
  const filename = await write(engine, id, 'T01', 'fake.xlsx', 'not a real spreadsheet');
  assert.equal((await submit(engine, id, 'T01', [filename], JSON.stringify(totals))).ok, true);
  const report = await inspect(engine, id, runDir);
  assert.equal(main(report, 'T01').status, 'fail'); assert.equal(report.tasksPassed, 0);
});

test('lost submission receipt retries one actual delivery, preserves request identity, and remains readable after sealing', async t => {
  const { engine, id } = await setup(t, { fault: 'lost-receipt' });
  const action: TargetAction = { type: 'task.deliver', taskId: 'T03', paths: [], text: substantive };
  const first = await engine.act(id, action, 'submit-once'); assert.equal(first.unknown, true);
  const repeated = await engine.act(id, action, 'submit-once'); assert.equal(repeated.ok, true);
  assert.equal((await engine.act(id, { ...action, text: 'different text' }, 'submit-once')).ok, false);
  assert.equal((await engine.act(id, action, 'another-submission')).ok, false);
  await engine.controlRun(id, 'stop');
  assert.deepEqual(await engine.act(id, action, 'submit-once'), repeated);
  assert.equal((await submit(engine, id, 'T04', [], '新的市场文案交付。')).ok, false);
  const events = engine.getRun(id).events.filter(event => event.data?.operationId === 'submit-once');
  assert.equal(events.filter(event => event.type === 'task.delivered').length, 1);
  assert.equal(events.filter(event => event.type === 'message.delivered').length, 1);
  assert.equal(engine.getRun(id).factReport?.assertions.find(assertion => assertion.id === 'protocol:unique-effects')?.status, 'pass');
});

test('a transient submission failure has no effect and a same-identity retry can succeed', async t => {
  const { engine, id } = await setup(t, { fault: 'tool-once' });
  const action: TargetAction = { type: 'task.deliver', taskId: 'T03', paths: [], text: substantive };
  assert.equal((await engine.act(id, action, 'transient-submit')).retryable, true);
  assert.equal(engine.getRun(id).events.filter(event => event.type === 'task.delivered').length, 0);
  assert.equal((await engine.act(id, action, 'transient-submit')).ok, true);
});

test('outcome completion waits for explicit submissions, not fixed deliverables', async t => {
  const { engine, id } = await setup(t, { scenarioId: 'memory-followup' });
  const reportFile = await write(engine, id, 'T01', 'any-name.txt', JSON.stringify(totals));
  await submit(engine, id, 'T01', [reportFile], '经营结论与明细。');
  await submit(engine, id, 'T03', [], substantive);
  await engine.controlRun(id, 'drain');
  assert.equal(engine.getRun(id).status, 'draining');
  assert.equal((await engine.act(id, { type: 'task.update', taskId: 'T04', status: 'completed' })).ok, false);
  await submit(engine, id, 'T04', [], '销售邮件：为目标客户介绍蓝桥 S2。产品介绍与短文案按事实卡另列如下。');
  await until(() => Boolean(engine.getRun(id).factReport));
  const detail = engine.getRun(id);
  assert.equal(detail.status, 'completed'); assert.equal(detail.factReport?.tasksSubmitted, 3);
  assert.equal(detail.factReport?.tasksPassed, 0);
  assert.ok(detail.artifacts.every(artifact => !artifact.path.endsWith('/result.json')));
  assert.equal((await writeLate()).ok, false);
  function writeLate() { return engine.act(id, { type: 'file.write', taskId: 'T01', path: reportFile, content: 'late edit' }); }
});

test('maintenance facts accept a different healthy capacity and fail self-report without effects/recheck', async t => {
  const { engine, id, runDir } = await setup(t);
  assert.equal((await engine.act(id, { type: 'service.configure', taskId: 'T08', maxConnections: 48, maintenance: false })).ok, true);
  assert.equal((await engine.act(id, { type: 'service.inspect', taskId: 'T08' })).ok, true);
  assert.equal((await submit(engine, id, 'T08', [], '连接容量改为 48，维护模式关闭，已经复核服务实际健康。')).ok, true);
  const report = await inspect(engine, id, runDir);
  assert.equal(report.assertions.find(assertion => assertion.id === 'outcome:T08:service')?.status, 'pass');
  assert.equal(main(report, 'T08').status, 'inconclusive');
  assert.equal((await submit(engine, id, 'T07', [], '巡检已进行，服务没有问题，可以继续使用。')).ok, true);
  assert.equal(main(await inspect(engine, id, runDir), 'T07').status, 'fail');
});

test('Judge packet exposes actual scoped inputs/body/artifacts and raw read rejects tampered inputs', async t => {
  const { engine, id, runDir } = await setup(t, { scenarioId: 'memory-followup' });
  const filename = await write(engine, id, 'T01', '自由报表.md', `净收入：3760\n${'业务说明。'.repeat(7000)}`);
  await submit(engine, id, 'T01', [filename], '主结论和完整明细见交付文件。');
  await engine.controlRun(id, 'stop');
  const detail = engine.getRun(id), packet = await buildEvidencePacket(detail, runDir);
  assert.equal(packet.evaluationMode, 'outcome');
  assert.ok(packet.fileIndex?.some(file => file.path === filename && file.kind === 'artifact'));
  assert.ok(packet.fileIndex?.some(file => file.path === 'inputs/orders.json' && file.kind === 'input'));
  assert.ok(!packet.fileIndex?.some(file => file.path === 'inputs/suppliers.json'));
  assert.ok(packet.evidence.find(evidence => evidence.ref === `artifact:${filename}`)?.text.includes('已截断'));
  assert.match(packet.instructions, /只读证据工具/);
  assert.ok(packet.events.some(event => event.type === 'task.delivered' && event.data?.text === '主结论和完整明细见交付文件。'));
  assert.ok((await readEvidenceFile(detail, runDir, filename)).length > 24000);
  await assert.rejects(readEvidenceFile(detail, runDir, 'inputs/suppliers.json'), /范围/);
  const original = await readFile(path.join(runDir, 'workspace/inputs/orders.json'));
  await writeFile(path.join(runDir, 'workspace/inputs/orders.json'), original.toString('utf8').replace('80', '99'));
  await assert.rejects(readEvidenceFile(detail, runDir, 'inputs/orders.json'), /初始摘要/);
  assert.equal(main(await evaluateRun(detail, runDir), 'T01').status, 'fail');
});

test('supplier outcomes allow a defensible non-cheapest recommendation while checking actual cost/eligibility', async t => {
  const { engine, id, runDir } = await setup(t);
  const text = JSON.stringify({ ranking: [
    { supplierId: 'SA', totalCost: 10700, eligible: true }, { supplierId: 'SB', totalCost: 10200, eligible: false }, { supplierId: 'SC', totalCost: 11000, eligible: true },
  ], recommendedSupplierId: 'SC', rationale: '为更高质量支付合理溢价；满足截止日期。' });
  assert.equal((await submit(engine, id, 'T05', [], text)).ok, true);
  const report = await inspect(engine, id, runDir);
  assert.equal(report.assertions.find(assertion => assertion.id === 'outcome:T05:numbers')?.status, 'pass');
  assert.equal(main(report, 'T05').status, 'inconclusive');
  const next = await engine.createRun({ target: 'external', evaluationMode: 'outcome', speed: 1000, noiseCount: 0 });
  await until(() => engine.getRun(next.run.id).tasks.some(task => task.id === 'T05' && task.introduced));
  assert.equal((await submit(engine, next.run.id, 'T05', [], JSON.stringify({ recommendedSupplierId: 'SB' }))).ok, true);
  assert.equal(main(await evaluateRun(engine.getRun(next.run.id), engine.runDir(next.run.id)), 'T05').status, 'fail');
});

test('determinable reconciliation and allocation contradictions fail without requiring standard deliverable names', async t => {
  const { engine, id, runDir } = await setup(t);
  assert.equal((await submit(engine, id, 'T02', [], JSON.stringify({ differences: [{ kind: 'receipt_shortage', purchaseOrderId: 'PO02', expected: 50, actual: 500 }] }))).ok, true);
  assert.equal((await submit(engine, id, 'T06', [], JSON.stringify({ allocations: [{ orderId: 'ORDER-A1', fromStock: 50, fromInbound: 0, shortage: 0 }, { orderId: 'ORDER-A2', fromStock: 30, fromInbound: 0, shortage: 0 }] }))).ok, true);
  const report = await inspect(engine, id, runDir);
  assert.equal(main(report, 'T02').status, 'fail'); assert.equal(main(report, 'T06').status, 'fail');
  assert.ok(report.assertions.some(assertion => assertion.id === 'outcome:T06:facts' && assertion.detail.includes('现货')));
});

test('the final lost receipt cannot strand a run and failed tasks cannot inflate business success', async t => {
  const { engine, id } = await setup(t, { fault: 'lost-receipt' });
  for (const task of engine.getRun(id).tasks.filter(task => task.id !== 'T03')) assert.equal((await engine.act(id, { type: 'task.update', taskId: task.id, status: 'failed', detail: '明确失败，不冒充完成' })).ok, true);
  await engine.controlRun(id, 'drain');
  const action: TargetAction = { type: 'task.deliver', taskId: 'T03', paths: [], text: substantive };
  assert.equal((await engine.act(id, action, 'last-submission')).unknown, true);
  await until(() => Boolean(engine.getRun(id).factReport));
  assert.equal(engine.getRun(id).status, 'completed');
  assert.equal((await engine.act(id, action, 'last-submission')).ok, true);
  const report = engine.getRun(id).factReport!;
  assert.equal(report.tasksSubmitted, 1); assert.equal(report.tasksPassed, 0);
  assert.equal(main(report, 'T01').status, 'fail');
});

test('independent outcome verification detects a duplicated actual delivery even with continuous event sequence', async t => {
  const { engine, id, runDir } = await setup(t);
  await submit(engine, id, 'T03', [], substantive);
  const detail = engine.getRun(id), delivered = detail.events.find(event => event.type === 'message.delivered' && event.taskId === 'T03')!;
  detail.events.push({ ...structuredClone(delivered), id: 'duplicated-effect', seq: detail.events.length + 1 });
  const report = await evaluateRun(detail, runDir);
  assert.equal(main(report, 'T03').status, 'fail');
  assert.equal(report.assertions.find(assertion => assertion.id === 'protocol:unique-effects')?.status, 'fail');
});

test('sealed outcome submissions and their idempotent receipts survive a normal engine restart', async t => {
  const { engine, id, root } = await setup(t);
  const action: TargetAction = { type: 'task.deliver', taskId: 'T03', paths: [], text: substantive };
  const receipt = await engine.act(id, action, 'persistent-submission'); assert.equal(receipt.ok, true);
  await engine.controlRun(id, 'stop'); await engine.close();
  const reopened = new LabEngine({ runtimeDir: root });
  try {
    await reopened.init();
    assert.equal(reopened.getRun(id).config.evaluationMode, 'outcome');
    assert.equal(reopened.getRun(id).tasks.find(task => task.id === 'T03')?.delivery?.operationId, 'persistent-submission');
    assert.deepEqual(await reopened.act(id, action, 'persistent-submission'), receipt);
    assert.equal((await reopened.act(id, action, 'new-after-seal')).ok, false);
  } finally { await reopened.close(); }
});
