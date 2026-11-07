import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { csvRows } from './collaboration-long-check.mjs';
import { researchTraceEvidence } from './collaboration-long-audit.mjs';
import { naturalAssets } from './platform-natural-corpus.mjs';
import { naturalOracles } from './platform-natural-oracle.mjs';

const execute = promisify(execFile);
const terminalTool = /^(?:bash|terminal|exec|shell|python|run_command)$/;
export function naturalResearchEvidence(receipt, events) {
  return researchTraceEvidence(receipt, events).map(row => {
    if (row.level !== 'request-completed-needs-content-review') return row;
    const result = events.find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === row.callId);
    const text = (result?.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
    return /\bhttp(?:[_ -]?(?:status|code))?\s*[:=]\s*200\b/i.test(text) ? { ...row, level: 'observed-http-200' } : row;
  });
}
export const packingContract = `import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {summarize}=await import(pathToFileURL(process.argv[2]).href);
const row=(id,quantity,unitCents,status='ordered')=>({id,quantity,unitCents,status,item:'同名'});
const checks=[];
const test=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:error.message});}};
test('empty',()=>assert.deepEqual(summarize([]),{totalCents:0,activeIds:[]}));
test('latest-id-replaces',()=>assert.deepEqual(summarize([row('b',24,950),row('a',4,1250),row('b',18,950)]),{totalCents:22100,activeIds:['a','b']}));
test('cancel-without-numbers',()=>assert.deepEqual(summarize([row('a',2,75),{id:'a',status:'cancelled'}]),{totalCents:0,activeIds:[]}));
test('reorder-after-cancel',()=>assert.deepEqual(summarize([{id:'a',status:'cancelled'},row('a',3,80)]),{totalCents:240,activeIds:['a']}));
test('same-label-distinct-id',()=>assert.equal(summarize([row('a',2,75),row('b',2,75)]).totalCents,300));
test('trimmed-decimals',()=>assert.equal(summarize([row('a',' 3 ',' 1250 ')]).totalCents,3750));
test('zero',()=>assert.deepEqual(summarize([row('a',0,0)]),{totalCents:0,activeIds:['a']}));
test('negative-quantity',()=>assert.throws(()=>summarize([row('a',-1,100)])));
test('fractional-quantity',()=>assert.throws(()=>summarize([row('a',1.5,100)])));
test('fractional-cents',()=>assert.throws(()=>summarize([row('a',1,12.5)])));
test('blank-number',()=>assert.throws(()=>summarize([row('a',' ',100)])));
test('numeric-prefix',()=>assert.throws(()=>summarize([row('a','2boxes',100)])));
test('unknown-status',()=>assert.throws(()=>summarize([row('a',1,100,'maybe')])));
test('empty-id',()=>assert.throws(()=>summarize([row('',1,100)])));
test('non-array',()=>assert.throws(()=>summarize(null)));
test('special-id',()=>assert.deepEqual(summarize([row('__proto__',1,100),row('constructor',1,200)]),{totalCents:300,activeIds:['__proto__','constructor']}));
test('immutable',()=>{const input=Object.freeze([Object.freeze(row('a',2,150))]);assert.equal(summarize(input).totalCents,300);});
console.log(JSON.stringify({checks,passed:checks.filter(c=>c.passed).length,total:checks.length}));
if(checks.some(c=>!c.passed))process.exitCode=1;
`;

export async function runPackingContract(modulePath, directory) {
  await mkdir(directory, { recursive: true });
  const deliveredModule = path.join(directory, 'packing.mjs'), probe = path.join(directory, 'independent-contract.mjs');
  await copyFile(modulePath, deliveredModule);
  await writeFile(probe, packingContract);
  const result = await runCommand([probe, deliveredModule], directory);
  let details;
  try { details = JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch {}
  const passed = result.exitCode === 0 && details?.total === 17 && details?.passed === 17;
  await writeFile(path.join(directory, 'independent-result.json'), JSON.stringify({ ...result, details, passed }, null, 2));
  return { passed, ...result, details };
}

async function runCommand(args, cwd) {
  const environment = { ...process.env };
  // Node's parent test-runner marker would otherwise skip a real child suite.
  delete environment.NODE_TEST_CONTEXT;
  try {
    const result = await execute(process.execPath, args, { cwd, env: environment, timeout: 30000, maxBuffer: 512000 });
    return { ...result, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || error.message, exitCode: typeof error.code === 'number' ? error.code : null, signal: error.signal || null };
  }
}

async function runDeliveredSuite(artifacts, directory) {
  const module = artifacts.find(f => f.name === 'packing.mjs'), suite = artifacts.find(f => f.name === 'packing.test.mjs');
  if (!module || !suite) return { passed: false, reason: 'Both delivered module and delivered test file are required' };
  await mkdir(directory, { recursive: true });
  await copyFile(module.path, path.join(directory, 'packing.mjs'));
  await copyFile(suite.path, path.join(directory, 'packing.test.mjs'));
  const result = await runCommand(['--test', '--test-reporter=tap', 'packing.test.mjs'], directory);
  const output = `${result.stdout}\n${result.stderr}`;
  const tests = Number(output.match(/(?:#|ℹ)\s*tests\s+(\d+)/)?.[1] || 0);
  const fails = output.match(/(?:#|ℹ)\s*fail\s+(\d+)/)?.[1];
  return { ...result, tests, passed: result.exitCode === 0 && tests > 0 && fails === '0' };
}

function moveFieldChecks(value) {
  const text = key => String(value[key] ?? '').replace(/\s/g, '');
  return {
    day: /周五|星期五|2026[-/.]11[-/.]20|2026年11月20[日号]?|11月20[日号]?|^20(?:日|号)?$|Friday/i.test(text('day')),
    time: /10[:：]20|十点二十/.test(text('time')),
    entrance: /西侧坡道/.test(text('entrance')),
    floor: /^(?:1|1F|一层|1层|一楼|1楼)$/i.test(text('floor')),
    boxLift: /箱|货物|cargo|box/i.test(text('boxLift')) && !/人和箱|peopleandboxes|乘客可/.test(text('boxLift')),
    passengerRoute: /西侧坡道/.test(text('passengerRoute')),
    contact: /沈遥/.test(text('contact')),
  };
}

export async function checkNaturalStep({ step, delivered = [], receipt, artifacts = [], directory, events = [], previousRows = [] }) {
  const oracle = naturalOracles[step.id] || {};
  const checks = [], add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
  const required = step.bot !== null && !step.optional && !step.asynchronous;
  if (required) add('actualMatrixReply', delivered.length > 0, { eventIds: delivered.map(event => event.event_id), receiptStatus: receipt?.status || null });
  const contents = await Promise.all(artifacts.map(async file => ({ ...file, text: await readFile(file.path, 'utf8') })));
  for (const name of oracle.files || []) add(`downloaded:${name}`, contents.some(file => file.name === name));
  if (oracle.destination) add('correctDestination', delivered.length > 0 && delivered.every(event => event.roomKey === oracle.destination), { expected: oracle.destination, rooms: delivered.map(event => event.roomKey) });
  if (oracle.execution) add('realExecutionReceipt', receipt?.toolReceipts?.some(tool => terminalTool.test(tool.name) && tool.status === 'completed'));
  if (oracle.delegation) add('nativeDelegationReceipt', receipt?.toolReceipts?.some(tool => tool.name === 'message_bot' && tool.status === 'completed'), 'Complete exchange and original source remain separate review criteria');
  if (oracle.research) {
    const body = delivered.map(event => event.content?.body || '').join('\n');
    add('relevantPrimarySourceLink', (oracle.domains || []).some(domain => new RegExp(`https?://(?:[^/]+\\.)?${domain.replace(/\./g, '\\.')}[/#?]`, 'i').test(body)));
    const evidence = naturalResearchEvidence(receipt || {}, events);
    add('actualResearchTrace', evidence.some(row => ['native-fetch-returned', 'observed-http-200', 'request-completed-needs-content-review'].includes(row.level)), evidence);
  }
  if (oracle.json) {
    try {
      const file = contents.find(file => file.name === (oracle.jsonFile || oracle.files[0]));
      const value = JSON.parse(file.text);
      for (const [key, expected] of Object.entries(oracle.json)) add(`json:${key}`, isDeepStrictEqual(value[key], expected), { observed: value[key], expected });
    } catch (error) { add('parseDownloadedJson', false, error.message); }
  }
  if (oracle.csvTotal !== undefined) {
    try {
      const file = contents.find(file => file.name === oracle.files[0]), [headers, ...rows] = csvRows(file.text.replace(/^\uFEFF/, ''));
      const index = headers.indexOf('lineCents'), id = headers.indexOf('id'), status = headers.indexOf('status');
      assert.ok(index >= 0 && id >= 0 && status >= 0, 'Requested CSV columns are missing');
      const latest = new Map(rows.filter(row => row[id] && !/total|合计|总计|remaining|budget|余量|余额|上限/i.test(row[id])).map(row => [row[id], row]));
      const active = [...latest.values()].filter(row => !/cancelled|取消|撤销/i.test(row[status]));
      assert.ok(active.every(row => Number.isSafeInteger(Number(row[index])) && Number(row[index]) >= 0), 'lineCents must be integer cents');
      const observed = active.reduce((sum, row) => sum + Number(row[index]), 0);
      add('downloadedLedgerTotal', observed === oracle.csvTotal, { observed, expected: oracle.csvTotal });
    } catch (error) { add('downloadedLedgerTotal', false, error.message); }
  }
  if (oracle.notesRoundtrip) {
    try {
      const value = JSON.parse(contents.find(file => file.name === 'packing-notes.json').text);
      const [headers, ...rows] = csvRows(naturalAssets['装箱备注.csv']);
      const expected = rows.map(row => Object.fromEntries(headers.map((key, index) => [key, row[index]])));
      add('losslessCsvNotes', isDeepStrictEqual(value, expected), { rows: Array.isArray(value) ? value.length : null });
    } catch (error) { add('losslessCsvNotes', false, error.message); }
  }
  if (oracle.moveContract) {
    try {
      const value = JSON.parse(contents.find(file => file.name === 'move-run.json').text);
      for (const [key, passed] of Object.entries(moveFieldChecks(value))) add(`currentMove:${key}`, passed, { observed: value[key] });
    } catch (error) { add('parseMoveContract', false, error.message); }
  }
  if (oracle.codeContract) {
    const file = contents.find(file => file.name === 'packing.mjs');
    if (!file) add('independentPackingContract', false, 'No delivered module');
    else {
      const result = await runPackingContract(file.path, path.join(directory, 'independent'));
      add('independentPackingContract', result.passed, { exitCode: result.exitCode, details: result.details, stderr: result.stderr });
    }
  }
  if (oracle.deliveredSuite) {
    const result = await runDeliveredSuite(contents, path.join(directory, 'delivered-suite'));
    add('deliveredSuiteRunsWithDeliveredModule', result.passed, result);
  }
  for (const sourceId of oracle.sameBytesAs || []) {
    const previous = previousRows.find(row => row.id === sourceId);
    for (const file of previous?.artifacts || []) {
      const current = artifacts.find(value => value.name === file.name);
      if (current) add(`sameBytes:${sourceId}:${file.name}`, current.sha256 === file.sha256, { previous: file.sha256, current: current.sha256 });
    }
  }
  return { checks, review: (oracle.review || []).map(criterion => ({ criterion, status: 'pending' })),
    reply: delivered.map(event => event.content?.body || '').join('\n'),
    optionalResponse: step.bot !== null && Boolean(step.optional), silenceAllowed: step.bot === null || Boolean(step.optional) };
}

export async function checkNaturalRun({ corpus, report, eventLedger, directory }) {
  const checks = [], add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  add('allParticipantMessagesPosted', report.rows.length === corpus.steps.length && report.rows.every(row => row.eventId), { planned: corpus.steps.length, posted: report.rows.length });
  const compactions = report.maintenance.filter(row => row.type === 'native-compaction' && row.result?.compacted === true);
  const restarts = report.maintenance.filter(row => row.type === 'native-restart' && row.identitiesPreserved === true && row.sessionsPreserved === true);
  add('plannedNativeCompactions', compactions.length >= corpus.maintenance.compactions.length, compactions.map(row => row.after));
  add('plannedNativeRestarts', restarts.length >= corpus.maintenance.restarts.length, restarts.map(row => row.after));
  const secret = corpus.profile === 'full' ? /银杏书签/ : /海蓝色唱片卡/;
  const publicBotEvents = eventLedger.filter(event => report.bots.some(bot => bot.id === event.sender) && !event.roomKey.startsWith('private-'));
  const leaked = publicBotEvents.filter(event => secret.test(event.content?.body || ''));
  const allFiles = report.allDeliveredArtifacts || report.rows.flatMap(row => (row.artifacts || []).map(file => ({ ...file, roomKey: row.room })));
  for (const file of allFiles) if (!file.roomKey.startsWith('private-') && secret.test(await readFile(file.path, 'utf8'))) leaked.push({ event_id: file.eventId, file: file.name });
  add('privateSurpriseStaysPrivate', leaked.length === 0, leaked.map(event => ({ eventId: event.event_id, file: event.file })));
  for (const row of report.rows.filter(row => row.control?.kind === 'cancel')) {
    add(`inflightCancel:${row.id}`, row.control.observedActive === true, row.control);
    const late = eventLedger.filter(event => event.sender === row.control.botId && event.origin_server_ts > row.control.completedAt &&
      (event.content?.['org.ds_group']?.attachments || []).some(file => /(?:door|pickup)-print\.html/.test(file.name)));
    add(`noCancelledPrintDelivery:${row.id}`, late.length === 0, late.map(event => event.event_id));
  }
  for (const row of report.rows.filter(row => row.control?.kind === 'amend')) add(`inflightAmendment:${row.id}`, row.control.observedActive === true, row.control);
  await writeFile(path.join(directory, 'run-checks.json'), JSON.stringify(checks, null, 2));
  return checks;
}
