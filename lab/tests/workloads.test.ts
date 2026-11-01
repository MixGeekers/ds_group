import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import { getScenario } from '../src/catalog.js';
import { executeWork, seedWorkspace } from '../src/workloads.js';
import type { ActionResult, ServiceState, TargetAction, TaskSpec, WorkContext } from '../src/types.js';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read OOXML ZIP contents independently of the authoring library. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  let end = buffer.length - 22;
  while (end >= Math.max(0, buffer.length - 65557) && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'must contain ZIP end-of-central-directory');
  let position = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50, 'valid ZIP central directory');
    const method = buffer.readUInt16LE(position + 10);
    const size = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'valid ZIP local header');
    const dataOffset = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const compressed = buffer.subarray(dataOffset, dataOffset + size);
    assert.ok(method === 0 || method === 8, 'supported OOXML compression');
    entries.set(name, method === 0 ? compressed : inflateRawSync(compressed));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function fixture(t: TestContext, options: { loseFirstWriteReceipt?: boolean; failWrites?: boolean } = {}) {
  await mkdir(path.join(labRoot, 'runtime'), { recursive: true });
  const runDir = await mkdtemp(path.join(labRoot, 'runtime', 'test-workloads-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const scenario = getScenario('mixed-office');
  await seedWorkspace(runDir, scenario);
  const workspace = path.join(runDir, 'workspace');
  const operations = new Map<string, ActionResult>();
  const attempts: Array<{ action: TargetAction; operationId?: string }> = [];
  const effects: TargetAction[] = [];
  let receiptLost = false;
  const action: WorkContext['action'] = async (command, operationId) => {
    attempts.push({ action: command, operationId });
    if (operationId && operations.has(operationId)) return structuredClone(operations.get(operationId)!);
    let answer: ActionResult;
    if (command.type === 'file.read') {
      answer = { ok: true, data: { path: command.path, content: await readFile(path.join(workspace, command.path), 'utf8'), encoding: 'utf8' } };
    } else if (command.type === 'file.write') {
      if (options.failWrites) return { ok: false, error: 'fixture deliberately rejects writes', retryable: false };
      const destination = path.join(workspace, command.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(command.content, command.encoding === 'base64' ? 'base64' : 'utf8'));
      effects.push(command);
      answer = { ok: true, data: { path: command.path } };
    } else if (command.type === 'service.inspect') {
      answer = { ok: true, data: JSON.parse(await readFile(path.join(workspace, 'service.json'), 'utf8')) };
    } else if (command.type === 'service.configure') {
      const service = JSON.parse(await readFile(path.join(workspace, 'service.json'), 'utf8')) as ServiceState;
      service.config.maxConnections = command.maxConnections;
      service.config.maintenance = command.maintenance;
      service.healthy = service.config.maxConnections >= service.config.requiredConnections && !service.config.maintenance;
      service.revision++;
      service.logs.push(`configured revision ${service.revision}`);
      await writeFile(path.join(workspace, 'service.json'), JSON.stringify(service));
      effects.push(command);
      answer = { ok: true, data: service };
    } else {
      answer = { ok: true };
    }
    if (operationId) operations.set(operationId, structuredClone(answer));
    if (command.type === 'file.write' && options.loseFirstWriteReceipt && !receiptLost) {
      receiptLost = true;
      return { ok: false, error: 'receipt lost after the write applied', unknown: true };
    }
    return answer;
  };
  const controller = new AbortController();
  return {
    runDir, workspace, scenario, action, attempts, effects, controller,
    run: (task: TaskSpec) => executeWork({ runDir, task, action, signal: controller.signal }),
    result: async (taskId: string) => JSON.parse(await readFile(path.join(workspace, 'outputs', taskId, 'result.json'), 'utf8')),
  };
}

test('eight work subjects produce usable files, correct business outcomes, and a repaired test service', async t => {
  const setup = await fixture(t);
  for (const task of setup.scenario.tasks) {
    await setup.run(task);
    for (const deliverable of task.deliverables) assert.ok((await stat(path.join(setup.workspace, deliverable))).size > 0, `${task.id}: ${deliverable} exists`);
  }
  const report = await setup.result('T01');
  assert.equal(report.grossRevenue, 4060);
  assert.equal(report.refundAmount, 300);
  assert.equal(report.netRevenue, 3760);
  assert.equal(report.orderCount, 4);
  assert.equal(report.netUnits, 29);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(setup.workspace, 'outputs/T01/report.xlsx'));
  assert.ok(workbook.worksheets.length >= 1);
  const workbookValues: unknown[] = [];
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => workbookValues.push(cell.value)));
  assert.ok(workbookValues.some(value => value === 3760 || (typeof value === 'object' && value !== null && 'result' in value && value.result === 3760)), 'workbook includes independently expected net revenue');
  assert.ok(workbookValues.some(value => typeof value === 'object' && value !== null && 'formula' in value), 'workbook includes recalculable formulas');

  const reconciliation = await setup.result('T02');
  assert.deepEqual(reconciliation.differences.map((item: { kind: string }) => item.kind).sort(), ['amount_mismatch', 'duplicate_invoice', 'missing_invoice', 'receipt_shortage']);
  assert.deepEqual(reconciliation.matchedPurchaseOrderIds, ['PO01']);

  const docx = unzip(await readFile(path.join(setup.workspace, 'outputs/T03/minutes.docx')));
  assert.ok(docx.has('[Content_Types].xml'));
  const document = docx.get('word/document.xml')!.toString('utf8');
  assert.ok(document.includes('蓝桥 S2 上市推进会纪要'));
  assert.ok(document.includes('2026-11-03'));
  assert.ok(document.includes('E05'));
  const copy = await setup.result('T04');
  assert.equal(copy.productId, 'LANQIAO-S2');
  assert.ok(copy.shortCopy.length <= 80);
  const comparison = await setup.result('T05');
  assert.equal(comparison.recommendedSupplierId, 'SA');
  assert.equal(comparison.ranking.find((item: { supplierId: string }) => item.supplierId === 'SA').totalCost, 10700);
  assert.equal(comparison.ranking.find((item: { supplierId: string }) => item.supplierId === 'SB').eligible, false);
  const plan = await setup.result('T06');
  assert.equal(plan.totalAllocated, 100);
  assert.equal(plan.allocations.reduce((sum: number, item: { shortage: number }) => sum + item.shortage, 0), 20);
  const inspection = await setup.result('T07');
  assert.equal(inspection.healthy, false);
  assert.equal(inspection.revision, 1);
  const repair = await setup.result('T08');
  assert.equal(repair.healthy, true);
  assert.equal(repair.verified, true);
  assert.ok(repair.afterRevision > repair.beforeRevision);
  const service = JSON.parse(await readFile(path.join(setup.workspace, 'service.json'), 'utf8')) as ServiceState;
  assert.equal(service.healthy, true);
  assert.ok(service.config.maxConnections >= service.config.requiredConnections);
  assert.ok(setup.effects.some(command => command.type === 'service.configure'), 'health derives from an actual service mutation');
});

test('report calculations follow changed business data rather than a fixed expected answer', async t => {
  const setup = await fixture(t);
  const inputPath = path.join(setup.workspace, 'inputs/orders.json');
  const data = JSON.parse(await readFile(inputPath, 'utf8'));
  data.orders.find((order: { id: string }) => order.id === 'O1001').unitPrice = 90;
  await writeFile(inputPath, JSON.stringify(data));
  await setup.run(setup.scenario.tasks.find(task => task.id === 'T01')!);
  assert.equal((await setup.result('T01')).netRevenue, 3880);
});

test('a lost write receipt is recovered with the same operation ID and without applying the write twice', async t => {
  const setup = await fixture(t, { loseFirstWriteReceipt: true });
  const task = setup.scenario.tasks.find(item => item.id === 'T04')!;
  await setup.run(task);
  const writes = setup.attempts.filter(item => item.action.type === 'file.write');
  assert.ok(writes.length > setup.effects.length, 'lost receipt must cause a check/retry');
  assert.ok(writes[0].operationId, 'write has a stable operation identity');
  assert.equal(writes[0].operationId, writes[1].operationId, 'recovery reuses the original operation identity');
  const paths = setup.effects.filter((item): item is Extract<TargetAction, { type: 'file.write' }> => item.type === 'file.write').map(item => item.path);
  assert.equal(new Set(paths).size, paths.length, 'each output is applied exactly once');
  assert.equal((await setup.result('T04')).productId, 'LANQIAO-S2');
});

test('an aborted worker does not start new effects', async t => {
  const setup = await fixture(t);
  setup.controller.abort(new Error('stopped by test'));
  await assert.rejects(setup.run(setup.scenario.tasks[0]));
  assert.equal(setup.attempts.length, 0);
  assert.equal(setup.effects.length, 0);
});

test('a permanently rejected output does not get reported as completed work', async t => {
  const setup = await fixture(t, { failWrites: true });
  await assert.rejects(setup.run(setup.scenario.tasks.find(task => task.id === 'T04')!));
  assert.equal(setup.effects.length, 0);
  await assert.rejects(setup.result('T04'));
});

test('every target task exposes a public result contract that accepts its actual deliverable', async t => {
  const setup = await fixture(t);
  const contracts = JSON.parse(await readFile(path.join(setup.workspace, 'inputs/output-contracts.json'), 'utf8')) as {
    schemaVersion: number;
    subjects: Record<string, { resultSchema: Record<string, unknown>; rules: string[] }>;
  };
  assert.equal(contracts.schemaVersion, 1);
  const app = Fastify();
  t.after(() => app.close());
  for (const task of setup.scenario.tasks) {
    assert.ok(task.inputs.includes('inputs/output-contracts.json'), `${task.id} exposes the contract as an input`);
    assert.ok(task.instructions.includes(`subjects.${task.subjectId}`), `${task.id} identifies the matching schema`);
    const contract = contracts.subjects[task.subjectId];
    assert.ok(contract?.resultSchema && contract.rules.length > 0, `${task.id} has schema and field semantics`);
    app.post(`/${task.subjectId}`, { schema: { body: contract.resultSchema } }, async () => ({ accepted: true }));
  }
  await app.ready();
  for (const task of setup.scenario.tasks) {
    await setup.run(task);
    const actual = await setup.result(task.id);
    const valid = await app.inject({ method: 'POST', url: `/${task.subjectId}`, payload: actual });
    assert.equal(valid.statusCode, 200, `${task.id}: reference deliverable must satisfy the public contract: ${valid.body}`);
    const invalid = await app.inject({ method: 'POST', url: `/${task.subjectId}`, payload: {} });
    assert.equal(invalid.statusCode, 400, `${task.id}: an empty deliverable must not satisfy the protocol`);
  }
});
