#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { packageRoot, localPath } from '../src/paths.mjs';
import { writeSpreadsheet } from '../src/file-formats.mjs';
import { readZip } from '../vendor/ds-bot/src/office/zip.js';

const { values } = parseArgs({ options: {
  run: { type: 'boolean', default: false }, cases: { type: 'string', default: 'csv,revision,xlsx,delegate,cancel' },
  report: { type: 'string' }, timeout: { type: 'string', default: '600000' },
} });
const base = new URL(process.env.DS_GROUP_CORE_URL || 'http://127.0.0.1:19100').origin;
assert.notEqual(new URL(base).port, '18100', 'Use an isolated core for the file-work verification');
const setup = JSON.parse(await readFile(process.env.DS_GROUP_MATRIX_SETUP_PATH || localPath('matrix-setup.json'), 'utf8'));
assert.notEqual(new URL(setup.homeserverUrl).port, '18008', 'Use an isolated Matrix server');
const people = Object.fromEntries(setup.participants.map(person => [person.localpart, person]));
const selected = values.cases.split(',');
for (const name of selected) assert.ok(['csv', 'revision', 'xlsx', 'delegate', 'cancel', 'image'].includes(name), `Unknown case ${name}`);
if (selected.includes('revision')) assert.ok(selected.includes('csv'), 'revision requires the csv case');
const timeout = Number(values.timeout);
assert.ok(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 1_800_000, 'timeout must be between 1000 and 1800000 milliseconds');
const runId = `file-work-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const directory = localPath('verification', runId);
const reportPath = path.resolve(values.report || path.join(packageRoot, 'artifacts', `${runId}.json`));
const meta = event => event.content?.['org.ds_group'] || {};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
  level: values.run ? 'real-matrix-dsh-tool-and-model-file-work' : 'read-only-preflight',
  model: 'opencode-go/deepseek-v4.1-flash', physicalHosts: 1, coreUrl: base,
  cases: [], eventIds: [], artifacts: [], modelCalls: 0 };

async function api(route, { user = 'alice', body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(new URL(route, base), { method,
    headers: { Authorization: `Bearer ${people[user].accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${route} failed with HTTP ${response.status}: ${result.error || ''}`);
  return result;
}

async function status() { return api('/api/status'); }
async function save() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function waitFor(work, label, duration = timeout) {
  const deadline = Date.now() + duration;
  let last;
  while (Date.now() < deadline) {
    last = await work();
    if (last) return last;
    await delay(750);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function check(name, work) {
  console.log(`Checking ${name}`);
  try {
    const details = await work();
    report.cases.push({ name, status: 'passed', details, checkedAt: new Date().toISOString() });
    console.log(`Passed ${name}`);
    return details;
  } catch (error) {
    report.cases.push({ name, status: 'failed', error: error.message, checkedAt: new Date().toISOString() });
    throw error;
  } finally { await save(); }
}

async function upload(filename) {
  const bytes = await readFile(filename);
  const extension = path.extname(filename);
  const mimeType = extension === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : extension === '.png' ? 'image/png' : 'text/csv';
  const url = new URL('/api/attachments', base);
  url.searchParams.set('filename', path.basename(filename));
  const uploadId = `${runId}-${path.basename(filename)}`;
  const options = { method: 'POST', headers: { Authorization: `Bearer ${people.alice.accessToken}`,
    'Content-Type': mimeType, 'X-Upload-Id': uploadId }, body: bytes };
  const first = await fetch(url, options);
  const firstResult = await first.json();
  assert.ok(first.ok, `Upload returned HTTP ${first.status}: ${firstResult.error || ''}`);
  const { attachment } = firstResult;
  assert.equal(attachment.sha256, hash(bytes));
  assert.equal(attachment.size, bytes.length);
  const second = await fetch(url, options);
  const secondResult = await second.json();
  assert.ok(second.ok, `Idempotent upload returned HTTP ${second.status}: ${secondResult.error || ''}`);
  assert.equal(secondResult.attachment.id, attachment.id);
  return attachment;
}

async function send(roomId, text, bot, attachments = [], extra = {}) {
  const transactionId = `${runId}-${randomUUID()}`;
  const body = `${bot ? `<@${people[bot].id}> ` : ''}${text}`;
  const request = { body, attachments: attachments.map(item => item.id), transactionId,
    mentions: { users: bot ? [people[bot].id] : [], roles: [], everyone: false, here: false }, ...extra };
  const sent = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { body: request });
  report.eventIds.push(sent.event_id);
  const duplicate = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { body: request });
  assert.equal(duplicate.event_id, sent.event_id);
  return sent;
}

async function tasks(roomId) { return (await api(`/api/rooms/${encodeURIComponent(roomId)}/tasks`)).tasks; }
async function events(roomId) { return (await api(`/api/rooms/${encodeURIComponent(roomId)}/messages?limit=200`)).events; }

async function completed(roomId, eventId, bot) {
  return waitFor(async () => {
    const task = (await tasks(roomId)).find(item => item.eventId === eventId && item.botId === people[bot].id);
    if (!task) return null;
    if (['failed', 'cancelled', 'unknown'].includes(task.status)) throw new Error(`Task ${task.status}: ${task.summary}`);
    if (task.status !== 'completed') return null;
    assert.ok(task.artifacts.length, 'Completed file task must record its delivered artifacts');
    const deliveredIds = new Set(task.artifacts.map(artifact => artifact.id));
    const message = (await events(roomId)).reverse().find(item => item.sender === people[bot].id
      && (meta(item).replyTo === eventId || meta(item).originEventId === eventId)
      && meta(item).attachments?.some(artifact => deliveredIds.has(artifact.id)));
    return message ? { task, message } : null;
  }, `${bot} artifact reply`);
}

async function download(attachment) {
  const response = await fetch(new URL(`/api/attachments/${encodeURIComponent(attachment.id)}?download=1`, base), {
    headers: { Authorization: `Bearer ${people.alice.accessToken}` }, signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Artifact download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(bytes), attachment.sha256);
  assert.equal(bytes.length, attachment.size);
  assert.ok(bytes.length > 0, 'Artifact must have content');
  const destination = path.join(directory, `${attachment.id}-${path.basename(attachment.name)}`);
  await writeFile(destination, bytes);
  report.artifacts.push({ id: attachment.id, name: attachment.name, sha256: attachment.sha256, size: attachment.size });
  return bytes;
}

// These parsers read the returned artifact independently from the product's
// table reader and summarizer. Only ZIP decompression is shared with the vendor.
function csvRows(bytes) {
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
      row = []; value = '';
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  assert.equal(quoted, false, 'CSV quotes must be balanced');
  return rows;
}

function xmlText(value) {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (_all, hex, decimal, name) => {
    if (hex || decimal) return String.fromCodePoint(parseInt(hex || decimal, hex ? 16 : 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
  });
}

function xlsxRows(bytes) {
  const parts = new Map(readZip(bytes).map(item => [item.name, item.data.toString('utf8')]));
  assert.ok(parts.has('xl/workbook.xml'), 'Result must be an XLSX workbook');
  const shared = [...(parts.get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(text => xmlText(text[1])).join(''));
  const worksheets = [...parts].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  for (const [, sheet] of worksheets) {
    const rows = [];
    for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const reference = /\br="([A-Z]+)\d+"/.exec(cell[1]);
        if (!reference) continue;
        const column = [...reference[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
        const scalar = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? '';
        row[column] = type === 's' ? shared[Number(scalar)] : type === 'inlineStr'
          ? [...cell[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(text => xmlText(text[1])).join('') : xmlText(scalar);
      }
      rows.push(row);
    }
    if (rows[0]?.some(value => /^(department|部门)$/i.test(String(value)))) return rows;
  }
  throw new Error('No summary worksheet with a department column was found');
}

function verifyTotals(rows, expected) {
  const header = rows[0].map(value => String(value).trim().toLowerCase());
  const groupIndex = header.findIndex(value => ['department', '部门'].includes(value));
  const totalIndex = header.findIndex(value => ['total', 'cost', 'amount', '费用', '合计', '总额'].includes(value));
  assert.ok(groupIndex >= 0 && totalIndex >= 0, 'Summary needs department and total/cost columns');
  const totals = {};
  for (const row of rows.slice(1)) {
    const department = String(row[groupIndex] ?? '').trim();
    if (!Object.hasOwn(expected, department)) continue;
    assert.equal(Object.hasOwn(totals, department), false, `Duplicate summary row for ${department}`);
    const amount = Number(String(row[totalIndex]).replaceAll(',', ''));
    assert.ok(Number.isFinite(amount), `Invalid total for ${department}`);
    totals[department] = Math.round(amount * 100);
  }
  assert.deepEqual(totals, expected, 'Downloaded artifact totals must match the independent fixture calculation');
  return totals;
}

async function verifyResult(result, expected, extension, { requireTools = true } = {}) {
  const attachment = meta(result.message).attachments.find(item => item.name.toLowerCase().endsWith(extension));
  assert.ok(attachment, `Expected a downloadable ${extension} result`);
  const bytes = await download(attachment);
  const totals = verifyTotals(extension === '.xlsx' ? xlsxRows(bytes) : csvRows(bytes), expected);
  if (requireTools) assert.ok(result.task.toolCalls > 0, 'Task must record actual tool work');
  return { requestId: result.task.requestId, sourceEventId: result.task.eventId, replyEventId: result.message.event_id,
    toolCalls: result.task.toolCalls, attachment: { id: attachment.id, name: attachment.name, size: attachment.size, sha256: attachment.sha256 }, totalsCents: totals };
}

async function cancellationEvidence(receipt) {
  assert.equal(receipt.status, 'cancelled');
  const aborted = receipt.toolReceipts.filter(tool => tool.name === 'bash' && tool.status === 'failed' && /aborted/i.test(tool.summary));
  if (aborted.length) return { mode: 'foreground-tool-aborted', tools: aborted };

  const jobIds = receipt.toolReceipts.filter(tool => tool.name === 'bash' && tool.status === 'completed')
    .map(tool => /started background job ([a-zA-Z0-9_-]+)/.exec(tool.summary)?.[1]).filter(Boolean);
  assert.ok(jobIds.length, 'Cancellation needs an aborted foreground tool or an identified background job');
  assert.match(receipt.sessionId, /^session-[a-zA-Z0-9-]+$/, 'Native Session ID must name a local session file');
  const sessionPath = localPath('dsh-finance', 'home', 'storages', 'session_projcache', 'sessions', `${receipt.sessionId}.json`);
  return waitFor(async () => {
    const bytes = await readFile(sessionPath);
    const session = JSON.parse(bytes.toString('utf8'));
    const notices = new Set();
    function collect(value) {
      if (typeof value === 'string') {
        if (/status:\s*killed/.test(value) && value.includes('DS-Group task cancelled')) notices.add(value);
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) collect(child);
      }
    }
    collect(session);
    const matched = jobIds.map(jobId => ({ jobId, notice: [...notices].find(value => value.includes(`background job ${jobId} `)) }));
    if (matched.some(item => !item.notice)) return null;
    return { mode: 'native-background-job-killed', sessionId: receipt.sessionId, nativeSessionSha256: hash(bytes), jobs: matched };
  }, 'durable native background-job cancellation notice', 15_000);
}

let baseline;
try {
  const health = await api('/readyz');
  assert.equal(health.status, 'ready');
  baseline = await status();
  for (const nodeId of ['finance', 'hr']) {
    const node = baseline.nodes.find(item => item.id === nodeId);
    assert.ok(node && node.status === 'idle', `${nodeId} must be idle before verification`);
  }
  report.initialCalls = baseline.budget.used;
  report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim();
  report.sourceHashes = {};
  for (const filename of ['scripts/verify-file-work.mjs', 'src/core.mjs', 'src/media.mjs', 'src/matrix-client.mjs', 'src/bot-node.mjs', 'src/node-store.mjs', 'src/node-files.mjs', 'src/tasks.mjs', 'dsh-plugin/runtime.mjs', 'dsh-plugin/runtime-rules.mjs', 'dsh-plugin/work-files.mjs', 'src/file-formats.mjs']) {
    report.sourceHashes[filename] = hash(await readFile(path.join(packageRoot, filename)));
  }
  assert.equal(baseline.core.loadedCoreSha256, report.sourceHashes['src/core.mjs'], 'Running core must match the current source');
  report.runtimes = [];
  for (const [nodeId, fallbackPort] of [['finance', 19091], ['hr', 19092]]) {
    const port = process.env[`DS_GROUP_${nodeId.toUpperCase()}_PORT`] || fallbackPort;
    assert.ok(![18091, 18092].includes(Number(port)), 'Use isolated DSH nodes');
    const response = await fetch(`http://127.0.0.1:${port}/api/ds-group-node/status`, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `${nodeId} bridge must be reachable`);
    const runtime = await response.json();
    assert.equal(runtime.loadedRuntimeSha256, report.sourceHashes['dsh-plugin/runtime.mjs'], `${nodeId} loaded source must match`);
    assert.equal(runtime.model, report.model);
    report.runtimes.push({ nodeId, model: runtime.model, loadedRuntimeSha256: runtime.loadedRuntimeSha256 });
  }
  if (values.run) {
    await mkdir(directory, { recursive: true });
    const extraCents = randomInt(1, 90);
    const rows = [['employee', 'department', 'cost'], ['Ada', 'HR', 125.5], ['Ben', 'Finance', 210.25],
      ['Cai', 'HR', 74.5], ['Dara', 'Finance', 89.75], ['Eli', 'Operations', 48 + extraCents / 100]];
    const expected = {};
    for (const row of rows.slice(1)) expected[row[1]] = (expected[row[1]] || 0) + Math.round(row[2] * 100);
    const workbookRows = rows.map(row => [...row]);
    workbookRows[2][2] = Number((workbookRows[2][2] + 37.29).toFixed(2));
    workbookRows[5][2] = Number((workbookRows[5][2] + 11.13).toFixed(2));
    const workbookExpected = { ...expected, Finance: expected.Finance + 3729, Operations: expected.Operations + 1113 };
    const csvPath = path.join(directory, 'expenses.csv');
    const xlsxPath = path.join(directory, 'expenses.xlsx');
    await writeFile(csvPath, rows.map(row => row.join(',')).join('\r\n') + '\r\n');
    await writeSpreadsheet(xlsxPath, { sheets: [{ name: 'Expenses', rows: workbookRows }] });
    report.fixture = { csvSha256: hash(await readFile(csvPath)), xlsxSha256: hash(await readFile(xlsxPath)), expectedCents: expected, workbookExpectedCents: workbookExpected };
    const csv = await upload(csvPath);
    const xlsx = await upload(xlsxPath);
    const financeRoom = (await api('/api/dm', { body: { participantId: people.finance.id } })).roomId;
    let firstResult;
    if (selected.includes('csv')) await check('CSV attachment to independently verified downloadable summary', async () => {
      const sent = await send(financeRoom, '请用工具实际读取附件 expenses.csv，按 department 汇总 cost。生成一个新的 department-summary.csv，表头为 department,total。请用工具回读文件检查，然后交付这个CSV附件和简短说明。', null, [csv]);
      firstResult = await completed(financeRoom, sent.event_id, 'finance');
      return verifyResult(firstResult, expected, '.csv');
    });
    if (selected.includes('revision')) await check('follow-up creates a new downloadable artifact version', async () => {
      const priorFile = meta(firstResult.message).attachments.find(item => item.name.endsWith('.csv'));
      const sent = await send(financeRoom, '基于上一份 department-summary.csv，把 HR 的汇总费用增加20，其他部门保持原值。用工具实际修改和检查，生成新的 department-summary-v2.csv，表头 department,total，然后交付新文件。', null, [], { replyTo: firstResult.message.event_id, replyMention: true });
      const result = await completed(financeRoom, sent.event_id, 'finance');
      const details = await verifyResult(result, { ...expected, HR: expected.HR + 2000 }, '.csv');
      assert.notEqual(details.attachment.id, priorFile.id);
      assert.notEqual(details.attachment.sha256, priorFile.sha256);
      return details;
    });
    if (selected.includes('xlsx')) await check('XLSX input and output through a group Bot mention', async () => {
      const sent = await send(setup.roomId, '请实际读取附件 expenses.xlsx 的 Expenses 工作表，按 department 汇总 cost。使用工具生成 department-summary.xlsx，汇总表列为 department,total。回读核对后交付新的Excel附件。', 'finance', [xlsx]);
      return verifyResult(await completed(setup.roomId, sent.event_id, 'finance'), workbookExpected, '.xlsx');
    });
    if (selected.includes('delegate')) await check('HR delegates the same attachment and returns Finance’s verified file to the original DM', async () => {
      const roomId = (await api('/api/dm', { body: { participantId: people.hr.id } })).roomId;
      const sent = await send(roomId, '请用 delegate 委派财务小雨处理附件 expenses.csv，要求实际读取文件、按 department 汇总 cost，生成列为 department,total 的 CSV 文件并回读核对。收到财务结果后，把那份CSV成果和简短说明返回我们的私聊。请先委派财务。', null, [csv]);
      const result = await completed(roomId, sent.event_id, 'hr');
      const details = await verifyResult(result, expected, '.csv', { requireTools: false });
      const shared = await events(setup.roomId);
      const delegated = shared.find(event => event.sender === people.hr.id && meta(event).kind === 'task.request' && meta(event).originEventId === sent.event_id);
      assert.ok(delegated, 'A real HR delegation event must exist');
      assert.ok(meta(delegated).attachments.some(item => item.sha256 === csv.sha256), 'Delegation must carry the uploaded file');
      const returned = shared.find(event => event.sender === people.finance.id && meta(event).kind === 'task.result' && meta(event).originEventId === sent.event_id);
      assert.ok(returned && meta(returned).attachments?.length, 'Finance must send a real artifact result');
      const financeTask = (await tasks(setup.roomId)).find(task => task.eventId === delegated.event_id && task.botId === people.finance.id);
      assert.ok(financeTask?.toolCalls > 0, 'Delegated computation must record tool execution');
      assert.ok(meta(returned).attachments.some(item => item.sha256 === details.attachment.sha256));
      return { ...details, toolCalls: result.task.toolCalls, financeToolCalls: financeTask.toolCalls,
        delegatedEventId: delegated.event_id, financeResultEventId: returned.event_id, originalRoomId: roomId };
    });
    if (selected.includes('cancel')) await check('a running native tool can be cancelled through the chat API', async () => {
      const sent = await send(financeRoom, '请用 bash 运行一个等待90秒的命令，等待结束后创建 outputs/finished.txt，内容为 FINISHED，然后交付该文件。', null);
      const task = await waitFor(async () => {
        const current = (await tasks(financeRoom)).find(item => item.eventId === sent.event_id);
        if (current && ['completed', 'failed', 'cancelled', 'unknown'].includes(current.status)) throw new Error(`Expected a running tool before cancellation, got ${current.status}`);
        return current?.status === 'running' && current.toolCalls > 0 ? current : null;
      }, 'native tool start before cancellation');
      const request = await api(`/api/tasks/${encodeURIComponent(task.requestId)}/cancel`, { body: {} });
      assert.equal(request.task.cancelRequested, true);
      const cancelled = await waitFor(async () => {
        const current = (await tasks(financeRoom)).find(item => item.requestId === task.requestId);
        if (current?.status === 'completed') throw new Error('Task completed before cancellation took effect');
        if (current && ['failed', 'unknown'].includes(current.status)) throw new Error(`Cancellation ended as ${current.status}: ${current.summary}`);
        return current?.status === 'cancelled' ? current : null;
      }, 'cancelled task', 90_000);
      assert.equal(cancelled.artifacts.length, 0);
      const response = await fetch(`http://127.0.0.1:${process.env.DS_GROUP_FINANCE_PORT || 19091}/api/ds-group-node/turns/${encodeURIComponent(task.requestId)}`);
      assert.ok(response.ok);
      const receipt = await response.json();
      const execution = await cancellationEvidence(receipt);
      let artifactExists = false;
      try { artifactExists = (await stat(path.join(receipt.workdir, 'outputs', 'finished.txt'))).isFile(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(artifactExists, false, 'Cancelled command must not publish its completion artifact');
      return { requestId: task.requestId, eventId: sent.event_id, status: cancelled.status, stage: cancelled.stage,
        toolCallsBeforeCancel: task.toolCalls, toolReceipts: receipt.toolReceipts, execution, completionArtifactExists: false };
    });
    if (selected.includes('image')) await check('the configured model reads a real image through the native image tool', async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      const imagePath = path.join(directory, 'invoice.png');
      const valueA = randomInt(100, 250);
      const valueB = randomInt(251, 400);
      try {
        const page = await browser.newPage({ viewport: { width: 700, height: 400 }, deviceScaleFactor: 1 });
        await page.setContent(`<html><body style="background:white;color:black;font:36px Arial;padding:36px"><h1 style="font-size:42px">Invoice</h1><p>A = ${valueA}</p><p>B = ${valueB}</p></body></html>`);
        await page.screenshot({ path: imagePath });
      } finally { await browser.close(); }
      const attachment = await upload(imagePath);
      const sent = await send(financeRoom, '请使用 read_image 实际读取这张图片中的 A 和 B 数值，计算两者的和。用工具创建 image-result.json，格式为 {"A":数值,"B":数值,"total":两者之和}，交付该JSON文件。', null, [attachment]);
      const result = await completed(financeRoom, sent.event_id, 'finance');
      const artifact = meta(result.message).attachments.find(item => item.name.endsWith('.json'));
      assert.ok(artifact, 'Image task must deliver a JSON artifact');
      assert.deepEqual(JSON.parse((await download(artifact)).toString('utf8')), { A: valueA, B: valueB, total: valueA + valueB });
      const response = await fetch(`http://127.0.0.1:${process.env.DS_GROUP_FINANCE_PORT || 19091}/api/ds-group-node/turns/${encodeURIComponent(result.task.requestId)}`);
      assert.ok(response.ok);
      const receipt = await response.json();
      assert.ok(receipt.toolReceipts.some(tool => tool.name === 'read_image' && tool.status === 'completed'), 'A real native read_image tool receipt is required');
      return { requestId: result.task.requestId, eventId: sent.event_id, toolCalls: result.task.toolCalls,
        inputSha256: attachment.sha256, outputSha256: artifact.sha256, expected: { A: valueA, B: valueB, total: valueA + valueB } };
    });
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (baseline) {
    const final = await status().catch(() => null);
    if (final) {
      report.finalCalls = final.budget.used;
      report.modelCalls = final.budget.used - baseline.budget.used;
      const initialIds = new Set(baseline.budget.claims.map(claim => claim.claimId));
      report.claims = final.budget.claims.filter(claim => !initialIds.has(claim.claimId));
      if (report.claims.some(claim => claim.model !== report.model)) {
        report.status = 'failed';
        report.error = 'Verification observed a model outside the configured scope';
        process.exitCode = 1;
      }
      report.finalNodes = final.nodes.map(node => ({ id: node.id, status: node.status, pending: node.pending, lastError: node.lastError }));
    }
  }
  report.completedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: report.status, checks: report.cases.length, modelCalls: report.modelCalls, report: reportPath, ...(report.error ? { error: report.error } : {}) }));
}
