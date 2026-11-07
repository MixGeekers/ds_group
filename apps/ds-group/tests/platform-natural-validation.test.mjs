import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { buildNaturalCorpus, naturalAssets } from '../scripts/platform-natural-corpus.mjs';
import { globalNaturalCriteria, forbiddenScenarioText } from '../scripts/platform-natural-oracle.mjs';
import { checkNaturalStep, checkNaturalRun, runPackingContract, naturalResearchEvidence } from '../scripts/platform-natural-check.mjs';
import { definitionFor, validateNaturalDefinition, summarizeObservedCalls, checkDecisionEvidence, parseNaturalArguments, runNaturalScenario } from '../scripts/platform-natural-run.mjs';
import { exportNaturalEvidence } from '../scripts/platform-natural-evidence.mjs';
import { readNaturalDecisions } from '../scripts/platform-natural-accounting.mjs';
import { naturalEnvironmentProfiles, naturalEnvironmentModelSettings } from '../scripts/platform-natural-environment.mjs';
import { naturalHarness, observedNaturalTopology } from '../scripts/platform-natural-host.mjs';
import { MODEL } from '../scripts/memory-test-model.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const referenceModule = `export function summarize(rows) {
 if(!Array.isArray(rows))throw new Error('rows');
 const latest=new Map();for(const row of rows){if(!row||typeof row.id!=='string'||!row.id.trim()||!['ordered','cancelled'].includes(row.status))throw new Error('row');latest.set(row.id,row);}
 const number=v=>{if(typeof v==='string'){if(!/^\\d+$/.test(v.trim()))throw new Error('number');v=Number(v.trim());}if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error('number');return v;};
 let totalCents=0;const activeIds=[];for(const [id,row] of latest)if(row.status==='ordered'){totalCents+=number(row.quantity)*number(row.unitCents);activeIds.push(id);}return{totalCents,activeIds:activeIds.sort()};
}\n`;
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-natural-zero-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function artifact(directory, name, text, roomKey = 'project') { const filename = path.join(directory, name); await writeFile(filename, text); return { name, path: filename, sha256: sha(text), size: Buffer.byteLength(text), roomKey, eventId: 'reply-1' }; }
const reply = (body = 'done', roomKey = 'project') => [{ event_id: 'reply-1', sender: '@bot:synthetic', roomKey, content: { body } }];

test('full scenario is three days of four people and three bots, mainly human conversation', () => {
  const definition = definitionFor('full'), summary = validateNaturalDefinition(definition), corpus = definition.corpus;
  assert.equal(summary.messages, 96); assert.equal(summary.humanConversation, 62); assert.equal(summary.directedMessages, 34);
  assert.equal(summary.optionalSocialReplies, 6); assert.equal(corpus.people.filter(person => person.name === '周宁').length, 2);
  assert.equal(corpus.steps.filter(step => step.rename).length, 1); assert.equal(corpus.steps.filter(step => step.cancel).length, 1);
  assert.equal(corpus.maintenance.compactions.length, 2); assert.equal(corpus.maintenance.restarts.length, 2);
  assert.ok(corpus.rooms.some(room => room.key === 'project' && room.historyVisibility === 'joined' && !room.bots.includes(2) && !room.humans.includes('d')));
  assert.ok(corpus.steps.some(step => step.joins?.includes(2))); assert.equal(Object.keys(globalNaturalCriteria).length, 10);
});
test('diagnostic has independent facts, prompts contain no evaluator or memory instructions', () => {
  const full = definitionFor('full'), diagnostic = definitionFor('diagnostic');
  assert.equal(validateNaturalDefinition(diagnostic).messages, 16); assert.notEqual(full.definitionHash, diagnostic.definitionHash);
  assert.equal(full.corpus.steps.some(step => /后院服务台|17:10|海蓝色唱片卡/.test(step.body)), false);
  assert.equal(diagnostic.corpus.steps.some(step => /西侧坡道|10:20|银杏书签/.test(step.body)), false);
  for (const corpus of [full.corpus, diagnostic.corpus]) for (const step of corpus.steps) assert.equal(forbiddenScenarioText.test(step.body), false);
  assert.equal(forbiddenScenarioText.test('这次请 recall 再回答'), true);
});
test('each new environment creates its own names and account namespace with the intended owner first', () => {
  const full = naturalEnvironmentProfiles('full'), diagnostic = naturalEnvironmentProfiles('diagnostic');
  assert.deepEqual(full[0], ['he_chuan', '贺川']); assert.deepEqual(diagnostic[0], ['he_shan', '何山']);
  assert.equal(new Set([...full, ...diagnostic].map(([localpart]) => localpart)).size, 8);
  assert.equal([...full, ...diagnostic].some(([localpart]) => ['watch', 'lin_a', 'lin_b', 'song'].includes(localpart)), false);
  assert.equal(full.filter(([, name]) => name === '周宁').length, 2);
});
test('environment admission and metadata use the selected authorized model and actual scenario size', () => {
  assert.deepEqual(naturalEnvironmentModelSettings('diagnostic'), { allowedModels: [MODEL], model: MODEL, plannedRounds: 16 });
  assert.deepEqual(naturalEnvironmentModelSettings('full'), { allowedModels: [MODEL], model: MODEL, plannedRounds: 96 });
});
test('topology reports only the observed backend and never guesses an embedding model', () => {
  const unknown = observedNaturalTopology(); assert.match(unknown, /unverified/); assert.doesNotMatch(unknown, /Ombre|Harrier|SQLite/);
  const local = observedNaturalTopology({ nativeBackend: 'source-aware-v1', backend: 'local-exact' });
  assert.match(local, /SQLite\/exact\/lexical/); assert.doesNotMatch(local, /Ombre|Harrier/);
  assert.match(observedNaturalTopology({ backend: 'ombre' }), /embedding model unverified/);
});
test('definition hashes change when criteria or fixtures change and remain deterministic', () => {
  assert.equal(definitionFor('full').definitionHash, definitionFor('full').definitionHash);
  assert.notEqual(definitionFor('full').corpusHash, definitionFor('diagnostic').corpusHash);
  assert.ok(definitionFor('full').oracleHash && definitionFor('full').fixtureHash);
});
test('packing contract passes an independent implementation and rejects the actual broken seed', async t => {
  const directory = await temporary(t), good = await artifact(directory, 'good.mjs', referenceModule), bad = await artifact(directory, 'bad.mjs', naturalAssets['packing.mjs']);
  const passed = await runPackingContract(good.path, path.join(directory, 'good-check'));
  assert.equal(passed.passed, true); assert.equal(passed.details.total, 17);
  const failed = await runPackingContract(bad.path, path.join(directory, 'bad-check'));
  assert.equal(failed.passed, false); assert.ok(failed.details.checks.filter(row => !row.passed).length >= 5);
});
test('native model completion or filename prose cannot replace a downloaded file', async t => {
  const directory = await temporary(t), step = buildNaturalCorpus().steps.find(step => step.id === 'full-069');
  const checked = await checkNaturalStep({ step, receipt: { status: 'completed' }, delivered: reply('I made costs-final.json, totalCents 58100'), artifacts: [], directory });
  assert.equal(checked.checks.find(row => row.name === 'actualMatrixReply').passed, true);
  assert.equal(checked.checks.find(row => row.name === 'downloaded:costs-final.json').passed, false);
  assert.equal(checked.checks.find(row => row.name === 'parseDownloadedJson').passed, false);
});
test('JSON financial values are parsed from actual received bytes', async t => {
  const directory = await temporary(t), step = buildNaturalCorpus().steps.find(step => step.id === 'full-069');
  const file = await artifact(directory, 'costs-final.json', JSON.stringify({ totalCents: 58100, remainingCents: 31900, purchasedBoxes: 18 }));
  let result = await checkNaturalStep({ step, delivered: reply(), artifacts: [file], directory });
  assert.equal(result.checks.every(row => row.passed), true);
  await writeFile(file.path, JSON.stringify({ totalCents: 58100, remainingCents: 31900, purchasedBoxes: 12 }));
  result = await checkNaturalStep({ step, delivered: reply('18 boxes'), artifacts: [file], directory });
  assert.equal(result.checks.find(row => row.name === 'json:purchasedBoxes').passed, false);
});
test('move date accepts equivalent human-visible expressions without a hidden calendar format', async t => {
  const directory = await temporary(t), step = buildNaturalCorpus().steps.find(step => step.id === 'full-086');
  for (const day of ['周五20号', '11月20日', '20号', '2026-11-20']) {
    const file = await artifact(directory, 'move-run.json', JSON.stringify({ day, time: '10:20', entrance: '西侧坡道', floor: '一层', boxLift: '只运箱子', passengerRoute: '西侧坡道', contact: '沈遥' }));
    const result = await checkNaturalStep({ step, delivered: reply(), artifacts: [file], directory });
    assert.equal(result.checks.every(check => check.passed), true, day);
  }
});
test('quoted CSV notes require exact spaces, quotes, rows and line breaks', async t => {
  const directory = await temporary(t), step = buildNaturalCorpus().steps.find(step => step.id === 'full-074');
  const expected = [{ id: 'p1', owner: '沈遥', note: '易碎：杯子、玻璃壶' }, { id: 'p2', owner: '周宁', note: '显示器写着"朝上"，别平放' },
    { id: 'p3', owner: '贺川', note: '第一行是电源\n第二行是转接头' }, { id: 'p4', owner: '周宁', note: '  备用线请留两头空格  ' }];
  const file = await artifact(directory, 'packing-notes.json', JSON.stringify(expected));
  assert.equal((await checkNaturalStep({ step, delivered: reply(), artifacts: [file], directory })).checks.find(row => row.name === 'losslessCsvNotes').passed, true);
  expected[3].note = expected[3].note.trim(); await writeFile(file.path, JSON.stringify(expected));
  assert.equal((await checkNaturalStep({ step, delivered: reply(), artifacts: [file], directory })).checks.find(row => row.name === 'losslessCsvNotes').passed, false);
});
test('private delivery checks the actual destination rather than the requested destination', async t => {
  const directory = await temporary(t), step = buildNaturalCorpus('diagnostic').steps.find(step => step.id === 'diagnostic-008');
  const file = await artifact(directory, 'card.txt', '给何山的小卡');
  const wrong = await checkNaturalStep({ step, delivered: reply('Only sent privately', 'project'), artifacts: [file], directory });
  assert.equal(wrong.checks.find(row => row.name === 'correctDestination').passed, false);
  const good = await checkNaturalStep({ step, delivered: reply('给你', 'private-a'), artifacts: [file], directory });
  assert.equal(good.checks.find(row => row.name === 'correctDestination').passed, true);
});
test('research recognizes http=200 without counting an echoed official URL as a visit', () => {
  const receipt = { toolReceipts: [{ name: 'bash', callId: 'c1', status: 'completed' }] };
  const events = [{ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'curl -L -w "http=%{http_code}" https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html' } } },
    { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '<html>Understanding link purpose</html>\nhttp=200' }] } } }];
  assert.equal(naturalResearchEvidence(receipt, events)[0].level, 'observed-http-200');
  events[0].data.arguments.command = 'echo https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html';
  assert.equal(naturalResearchEvidence(receipt, events)[0].level, 'url-only-not-proof');
});
test('downloaded test file really runs with the downloaded module in a new directory', async t => {
  const directory = await temporary(t), step = buildNaturalCorpus().steps.find(step => step.id === 'full-084');
  const artifacts = await Promise.all([artifact(directory, 'packing.mjs', referenceModule, 'private-b'),
    artifact(directory, 'packing.test.mjs', "import test from 'node:test';import assert from 'node:assert/strict';import {summarize}from './packing.mjs';test('empty',()=>assert.equal(summarize([]).totalCents,0));", 'private-b'),
    artifact(directory, 'packing-tests.txt', 'This prose is not accepted as test execution.', 'private-b')]);
  const result = await checkNaturalStep({ step, receipt: { toolReceipts: [{ name: 'bash', status: 'completed' }] }, delivered: reply('files', 'private-b'), artifacts, directory });
  assert.equal(result.checks.find(row => row.name === 'deliveredSuiteRunsWithDeliveredModule').passed, true, JSON.stringify(result.checks.find(row => row.name === 'deliveredSuiteRunsWithDeliveredModule')));
  await writeFile(artifacts[1].path, "import test from 'node:test';test('fails',()=>{throw new Error('failure')});");
  const failed = await checkNaturalStep({ step, receipt: { toolReceipts: [{ name: 'bash', status: 'completed' }] }, delivered: reply('pass 100', 'private-b'), artifacts, directory });
  assert.equal(failed.checks.find(row => row.name === 'deliveredSuiteRunsWithDeliveredModule').passed, false);
});
test('final re-delivery compares bytes with the checked version', async t => {
  const directory = await temporary(t), step = buildNaturalCorpus().steps.find(step => step.id === 'full-093');
  const module = await artifact(directory, 'packing.mjs', referenceModule), json = await artifact(directory, 'costs-final.json', JSON.stringify({ totalCents: 58100, remainingCents: 31900, purchasedBoxes: 18 }));
  const result = await checkNaturalStep({ step, delivered: reply(), artifacts: [module, json], previousRows: [{ id: 'full-084', artifacts: [{ name: 'packing.mjs', sha256: 'different-hash' }] }], directory });
  assert.equal(result.checks.find(row => row.name === 'sameBytes:full-084:packing.mjs').passed, false);
});
test('cancellation after completion is not counted as an in-flight pass and late files fail', async t => {
  const directory = await temporary(t), corpus = buildNaturalCorpus('diagnostic');
  const report = { rows: corpus.steps.map(step => ({ id: step.id, eventId: `event-${step.id}`, room: step.room, artifacts: [] })), bots: [{ id: '@bot:synthetic' }], maintenance: [] };
  report.rows.find(row => row.id === 'diagnostic-015').control = { kind: 'cancel', observedActive: false, botId: '@bot:synthetic', completedAt: 500 };
  const eventLedger = [{ event_id: 'late', sender: '@bot:synthetic', roomKey: 'project', origin_server_ts: 501,
    content: { body: 'finished', 'org.ds_group': { attachments: [{ name: 'pickup-print.html' }] } } }];
  const checks = await checkNaturalRun({ corpus, report, eventLedger, directory });
  assert.equal(checks.find(row => row.name === 'inflightCancel:diagnostic-015').passed, false);
  assert.equal(checks.find(row => row.name === 'noCancelledPrintDelivery:diagnostic-015').passed, false);
});
test('public attachments and unsolicited Bot speech are included in the privacy gate', async t => {
  const directory = await temporary(t), corpus = buildNaturalCorpus('diagnostic'), file = await artifact(directory, 'leak.txt', '海蓝色唱片卡');
  const report = { rows: [], bots: [{ id: '@bot:synthetic' }], maintenance: [], allDeliveredArtifacts: [file] };
  const checks = await checkNaturalRun({ corpus, report, eventLedger: [], directory });
  assert.equal(checks.find(row => row.name === 'privateSurpriseStaysPrivate').passed, false);
});
test('accounting keeps failures, truncation, unfinished streams and decisions separate', () => {
  const calls = [{ event: 'start', callId: 'a', model: 'ordinary' }, { event: 'end', callId: 'a', status: 'completed', model: 'ordinary', purpose: 'generation', usage: { inputTokens: 11 } },
    { event: 'start', callId: 'b', model: 'ordinary' }, { event: 'end', callId: 'b', status: 'truncated', purpose: 'memory', usage: { inputTokens: 5 } },
    { event: 'start', callId: 'c', model: 'ordinary' }, { event: 'end', callId: 'c', status: 'failed', purpose: 'memory' }, { event: 'start', callId: 'd', model: 'ordinary' }];
  const summary = summarizeObservedCalls(calls, [{ usage: { input_tokens: 7 } }]);
  assert.equal(summary.nativeStreams.successful, 1); assert.equal(summary.nativeStreams.failed, 1); assert.equal(summary.nativeStreams.truncated, 1);
  assert.equal(summary.nativeStreams.unfinished, 1); assert.equal(summary.nativeStreams.observedUsage.inputTokens, 16);
  assert.equal(summary.decisions.observedUsage.input_tokens, 7); assert.equal(summary.costComplete, false);
});
test('natural mode configuration is insufficient without real decisions linked to Matrix sources', () => {
  const bots = [{ id: 'b0' }, { id: 'b1' }], ledger = [{ event_id: 'e1' }];
  const decisions = [{ botId: 'b0', status: 'decided', action: 'LISTEN', model: 'decision-model', eventIds: ['e1'] },
    { botId: 'b1', status: 'error', action: 'LISTEN', model: 'decision-model', eventIds: ['e1'] }];
  const checks = checkDecisionEvidence(bots, decisions, ledger);
  assert.equal(checks[0].passed, true); assert.equal(checks[1].passed, false);
  decisions[0].eventIds = ['missing']; assert.equal(checkDecisionEvidence(bots, decisions, ledger)[0].passed, false);
});
test('read-only accounting finds real nested node stores and retains errors without losing valid rows', async t => {
  const directory = await temporary(t), nested = path.join(directory, 'nodes', 'actual_bot'); await mkdir(nested, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite'), filename = path.join(nested, 'node.sqlite'), database = new DatabaseSync(filename);
  database.exec('CREATE TABLE attention_decisions (id TEXT, status TEXT, created_at INTEGER, completed_at INTEGER, input_json TEXT, result_json TEXT, outcome TEXT, error_code TEXT)');
  database.prepare('INSERT INTO attention_decisions VALUES (?,?,?,?,?,?,?,?)').run('d1', 'decided', 10, 20, JSON.stringify({ eventIds: ['e1'], watermark: 3 }), JSON.stringify({ action: 'LISTEN', model: 'decision-model', usage: { input_tokens: 4 } }), 'listen', null);
  database.close();
  const before = sha(await readFile(filename));
  const result = await readNaturalDecisions([{ id: 'b0', localpart: 'actual_bot', directory }, { id: 'missing', localpart: 'none', directory }]);
  assert.equal(result.decisions.length, 1); assert.deepEqual(result.decisions[0].eventIds, ['e1']); assert.equal(result.decisions[0].usage.input_tokens, 4);
  assert.equal(result.errors.length, 1); assert.equal(sha(await readFile(filename)), before);
});
test('runner arguments reject unknown flags and invalid timeouts; the default is a read-only plan', () => {
  assert.equal(parseNaturalArguments([]).action, 'plan'); assert.equal(parseNaturalArguments(['--profile', 'full']).profile, 'full');
  assert.throws(() => parseNaturalArguments(['--fast'])); assert.throws(() => parseNaturalArguments(['--pace-ms', 'NaN']));
  assert.throws(() => parseNaturalArguments(['--timeout-ms'])); assert.throws(() => parseNaturalArguments(['--profile', 'unknown']));
});
test('generated test harness includes every private runtime dependency and avoids old corpus rules', () => {
  const text = naturalHarness({ root: '/synthetic/project', runtime: '/synthetic/runtime', dependencies: '/synthetic/deps', directory: '/synthetic/run', workspace: '/synthetic/work' });
  assert.ok(text.includes('registerRuntimeResolution')); assert.ok(text.includes('runtime-dependencies.json')); assert.ok(text.includes("specifier.startsWith(name+'/')"));
  assert.equal(text.includes('collaboration-long-corpus'), false); assert.equal(text.includes('recall'), false);
});

class ZeroAdapter {
  evidenceLevel = 'synthetic-zero-model-self-check';
  ledger = []; posts = []; closed = false; requests = new Map(); bots = [{ id: '@b0:synthetic', nativeBotId: 'n0', sessionId: 's0' }, { id: '@b1:synthetic', nativeBotId: 'n1', sessionId: 's1' }, { id: '@b2:synthetic', nativeBotId: 'n2', sessionId: 's2' }];
  async initialize() { return { bots: this.bots, model: 'none', topology: 'synthetic adapter; no network and no model' }; }
  restoreRows(rows) { for (const row of rows) this.requests.set(row.id, row); }
  async post(step) { this.posts.push(step.id); const value = { eventId: `e-${step.id}`, roomId: step.room, senderId: `@${step.sender}:synthetic`, botId: step.bot === null ? null : this.bots[step.bot].id, requestId: `r-${step.id}`, postedAt: Date.now() }; this.requests.set(step.id, value); return value; }
  async inspectTarget(kind, targetId) { return { kind, targetId, botId: this.requests.get(targetId).botId, observedActive: true, observedStatus: 'running', observedAt: Date.now() }; }
  async control(kind, targetId, observed) { return { ...observed, completedAt: Date.now() }; }
  async waitStarted() { return { observedActive: true, status: 'running', receipt: { status: 'running' } }; }
  async waitReply() { return { receipt: { status: 'completed' }, delivered: [] }; }
  async settle() { return { delivered: [], receipt: null }; }
  async downloads() { return []; }
  async protocolEvents() { return []; }
  async compact() { return { compacted: true }; }
  async restart() { return { identitiesPreserved: true, sessionsPreserved: true }; }
  async flush() {} async capture() {} async finalize() { return { calls: [], decisions: [] }; }
  async close() { this.closed = true; }
}
test('driver preserves actual posted count on stop, resumes without re-posting and keeps failures', async t => {
  const directory = await temporary(t), definition = definitionFor('diagnostic'), first = new ZeroAdapter();
  const partial = await runNaturalScenario({ definition, adapter: first, directory, shouldStop: () => first.posts.length >= 8 });
  assert.equal(partial.status, 'stopped-by-operator'); assert.equal(partial.rows.length, 8); assert.equal(first.closed, true);
  assert.ok(partial.failures.some(row => row.id === 'diagnostic-005')); const oldFailures = partial.failures.length;
  const second = new ZeroAdapter();
  const resumed = await runNaturalScenario({ definition, adapter: second, directory, resume: true });
  assert.equal(resumed.rows.length, 16); assert.equal(second.posts.length, 8); assert.equal(resumed.attempts.length, 2);
  assert.equal(resumed.evidenceLevel, 'synthetic-zero-model-self-check'); assert.equal(resumed.status, 'completed-with-failures');
  assert.ok(resumed.failures.length > oldFailures); assert.equal(resumed.accounting.nativeStreams.starts, 0);
  const saved = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')); assert.equal(saved.rows.length, 16);
  const destination = path.join(directory, 'published.json');
  const published = await exportNaturalEvidence(directory, destination);
  assert.equal(published.evidenceLevel, 'synthetic-zero-model-self-check'); assert.equal(published.posted, 16);
  await assert.rejects(exportNaturalEvidence(directory, destination), { code: 'EEXIST' });
});
test('resume rejects changed frozen criteria before touching the adapter', async t => {
  const directory = await temporary(t), definition = definitionFor('diagnostic'), first = new ZeroAdapter();
  await runNaturalScenario({ definition, adapter: first, directory, shouldStop: () => first.posts.length >= 1 });
  const changed = { ...definition, definitionHash: 'changed' }, second = new ZeroAdapter();
  await assert.rejects(runNaturalScenario({ definition: changed, adapter: second, directory, resume: true }), /immutable/);
  assert.equal(second.posts.length, 0);
});
test('pure human conversations and optional social turns allow silence without a false failure', async t => {
  const directory = await temporary(t), corpus = buildNaturalCorpus();
  for (const id of ['full-001', 'full-012']) {
    const step = corpus.steps.find(step => step.id === id), result = await checkNaturalStep({ step, directory });
    assert.equal(result.silenceAllowed, true); assert.equal(result.checks.some(row => !row.passed), false);
  }
});
test('public evidence filters membership comments, redacts private bodies and binds the review to the original report', async t => {
  const directory = await temporary(t), definition = definitionFor('diagnostic');
  const report = { status: 'completed-awaiting-review', definitionHash: definition.definitionHash, rows: [], attempts: [], failures: [], bots: [{ id: 'b0' }],
    allBotMessageReview: [{ eventId: 'membership', room: 'project', body: '' }, { eventId: 'public', room: 'project', body: 'public text' },
      { eventId: 'private', room: 'private-a', body: 'synthetic confidential card' }] };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report));
  await writeFile(path.join(directory, 'frozen-definition.json'), JSON.stringify(definition));
  await writeFile(path.join(directory, 'matrix-events.jsonl'), [{ event_id: 'membership', sender: 'b0', type: 'm.room.member' },
    { event_id: 'public', sender: 'b0', type: 'm.room.message' }, { event_id: 'private', sender: 'b0', type: 'm.room.message' }].map(JSON.stringify).join('\n'));
  const reviewFile = path.join(directory, 'review.json'), review = { reviewId: 'review-1', status: 'reviewed-with-findings',
    source: { reportSha256: sha(JSON.stringify(report)), definitionHash: definition.definitionHash },
    coverage: { actualBotMessages: 2 }, findings: [], regressionReviews: [{ id: 'F1', status: 'not-observed' }],
    workChangedReview: { chains: 1 }, coverageLimits: ['fixed-version limit'],
    messageReviews: [{ eventId: 'public', verdict: 'acceptable' }], internalSecrets: 'DO_NOT_EXPORT' };
  await writeFile(reviewFile, JSON.stringify(review));
  const result = await exportNaturalEvidence(directory, path.join(directory, 'public.json'), { reviewFile });
  assert.equal(result.allBotMessageReview.length, 2); assert.equal(result.messageReviewFilter.excludedNonMessages, 1);
  assert.equal(result.independentReview.reviewId, 'review-1'); assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
  assert.equal(result.independentReview.regressionReviews[0].id, 'F1'); assert.equal(result.independentReview.workChangedReview.chains, 1);
  assert.equal(JSON.stringify(result).includes('synthetic confidential card'), false);
  review.source.reportSha256 = 'wrong-run'; await writeFile(reviewFile, JSON.stringify(review));
  await assert.rejects(exportNaturalEvidence(directory, path.join(directory, 'wrong.json'), { reviewFile }), /does not match/);
});
