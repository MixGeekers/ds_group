import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { REPAIR_BODY, REPAIR_FILES, repairTarget, repairPaths, repairOptions, originalEvidenceManifest,
  compareOriginalEvidence, postRepairFeedback, validateRepairDelivery } from '../scripts/platform-natural-full-repair.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleCode = `export function summarize(rows) {
 if(!Array.isArray(rows))throw new Error('rows');
 const latest=new Map();for(const row of rows){if(!row||typeof row.id!=='string'||!row.id.trim()||!['ordered','cancelled'].includes(row.status))throw new Error('row');latest.set(row.id,row);}
 const number=v=>{if(typeof v==='string'){if(!/^\\d+$/.test(v.trim()))throw new Error('number');v=Number(v.trim());}if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error('number');return v;};
 let totalCents=0;const activeIds=[];for(const [id,row] of latest)if(row.status==='ordered'){totalCents+=number(row.quantity)*number(row.unitCents);activeIds.push(id);}return{totalCents,activeIds:activeIds.sort()};
}\n`;
const names = Array.from({ length: 15 }, (_, index) => `original-case-${index + 1}`);
const originalTap = names.map(name => `# Subtest: ${name}`).join('\n');
const definition = { corpus: { steps: [{ id: 'full-084', sender: 'b', room: 'private-b', bot: 1 }] } };
const source = { id: 'full-084', senderId: '@engineer:test', botId: '@actual:test', roomId: '!private-b:test', room: 'private-b', replyEventIds: ['$original-reply'] };
const report = { rows: [source], people: { b: { id: source.senderId, name: 'Same name' } }, bots: [{ id: '@wrong:test' }, { id: source.botId, name: 'Actual Bot' }], rooms: { 'private-b': { roomId: source.roomId } } };
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-repair-runner-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function deliveryFixture(t, { outside, changedNames = false } = {}) {
  const directory = await temporary(t), incoming = path.join(directory, 'received'); await mkdir(incoming);
  const testNames = changedNames ? names.map((name, index) => index === 13 ? 'replacement-case' : name) : names;
  const suite = `import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{summarize}from'./packing.mjs';\n`
    + testNames.map((name, index) => `test(${JSON.stringify(name)},()=>{${outside && index === 13 ? `readFileSync(${JSON.stringify(outside)},'utf8');` : ''}assert.deepEqual(summarize([]),{totalCents:0,activeIds:[]});});`).join('\n');
  const contents = { 'packing.mjs': moduleCode, 'packing.test.mjs': suite, 'packing-tests.txt': 'Test log: 15 passed.' };
  const artifacts = [];
  for (const name of REPAIR_FILES) { const file = path.join(incoming, name); await writeFile(file, contents[name]); artifacts.push({ name, path: file, size: Buffer.byteLength(contents[name]), sha256: sha(contents[name]) }); }
  return { directory, artifacts, receipt: { artifacts: structuredClone(artifacts) }, originalRow: { artifacts: structuredClone(artifacts),
    checks: [{ name: 'deliveredSuiteRunsWithDeliveredModule', detail: { stdout: originalTap } }] } };
}

test('repair target comes from the frozen request, including the actual Bot index', () => {
  const target = repairTarget(definition, report);
  assert.equal(target.bot.id, '@actual:test'); assert.equal(target.person.id, '@engineer:test'); assert.equal(target.replyTo, '$original-reply');
  assert.throws(() => repairTarget(definition, { ...report, rows: [{ ...source, botId: '@wrong:test' }] }));
});

test('repair defaults to preview and refuses output directories overlapping the original evidence', () => {
  assert.equal(repairOptions([]).run, false); assert.equal(repairOptions(['--run']).run, true);
  assert.throws(() => repairPaths('/tmp/original', '/tmp/original/repair'));
  assert.throws(() => repairPaths('/tmp/original/nested', '/tmp/original'));
  assert.throws(() => repairOptions(['--timeout-ms', 'NaN']));
});

test('normal feedback uses only the original person, room, Bot and reply relation', async () => {
  const requests = [], person = { id: source.senderId, accessToken: 'synthetic' };
  const adapter = { people: { b: person }, requests: new Map(), async api(route, options) { requests.push({ route, options }); return { event_id: '$repair' }; } };
  const result = await postRepairFeedback(adapter, { definition, originalReport: report });
  assert.equal(result.botId, source.botId); assert.equal(result.senderId, source.senderId);
  assert.equal(requests[0].options.person, person); assert.equal(requests[0].options.body.replyTo, '$original-reply');
  assert.equal(requests[0].options.body.body, `<@${source.botId}> ${REPAIR_BODY}`);
  assert.deepEqual(requests[0].options.body.attachments, []); assert.doesNotMatch(requests[0].options.body.body, /oracle|17|15|hidden|判据/i);
});

test('frozen original evidence changes are detected without rewriting any original file', async t => {
  const original = await temporary(t); await mkdir(path.join(original, 'host'));
  await writeFile(path.join(original, 'report.json'), '{"original":true}'); await writeFile(path.join(original, 'host/events.jsonl'), 'old-events\n');
  const context = { original, target: { row: { artifacts: [] } } }, before = await originalEvidenceManifest(context);
  assert.ok(compareOriginalEvidence(before, await originalEvidenceManifest(context)).every(item => item.unchanged));
  await writeFile(path.join(original, 'host/events.jsonl'), 'changed\n');
  assert.equal(compareOriginalEvidence(before, await originalEvidenceManifest(context)).find(item => item.file === 'host/events.jsonl').unchanged, false);
  assert.equal(await readFile(path.join(original, 'report.json'), 'utf8'), '{"original":true}');
});

test('three downloaded files pass the complete 15-case suite and independent 17-case module contract', async t => {
  const fixture = await deliveryFixture(t), result = await validateRepairDelivery(fixture);
  assert.equal(result.passed, true, JSON.stringify({ checks: result.checks, stdout: result.delivered.stdout, stderr: result.delivered.stderr })); assert.equal(result.delivered.parsed.tests, 15); assert.equal(result.contract.details.passed, 17);
  assert.deepEqual((await readdir(path.join(fixture.directory, 'delivered-only'))).sort(), [...REPAIR_FILES].sort());
  assert.equal(result.relations.length, 3); assert.ok(result.relations.every(item => item.downloaded.sha256 === item.source.sha256));
});

test('a CSV existing outside the delivered directory cannot mask an undeclared dependency', async t => {
  const outsideDir = await temporary(t), outside = path.join(outsideDir, '采购流水.csv'); await writeFile(outside, 'sample exists on this host');
  const fixture = await deliveryFixture(t, { outside }), result = await validateRepairDelivery(fixture);
  assert.equal(result.passed, false); assert.equal(result.delivered.parsed.tests, 15); assert.equal(result.delivered.parsed.failed, 1);
  assert.match(result.delivered.stdout, /ERR_ACCESS_DENIED/); assert.equal(result.contract.passed, true);
});

test('renamed cases retain both title lists for semantic review without failing a runnable delivery', async t => {
  const fixture = await deliveryFixture(t, { changedNames: true }), result = await validateRepairDelivery(fixture);
  assert.equal(result.delivered.parsed.passed, 15); assert.equal(result.passed, true);
  assert.equal(result.coverageReview.sameNamesRetained, false); assert.equal(result.coverageReview.status, 'pending-independent-review');
});
