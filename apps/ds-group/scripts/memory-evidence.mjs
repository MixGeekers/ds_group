// Publish only synthetic test evidence. DSH profiles, credentials, login URLs and
// full runtime/session logs never leave the ignored run directories.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';

const local = join(packageRoot, '.local'), destination = join(packageRoot, 'artifacts/memory');
const read = async filename => JSON.parse(await readFile(filename, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const errorOf = value => value ? String(value).split('\n')[0].slice(0, 1500) : undefined;
async function callsOf(directory) {
  const content = await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => '');
  const events = content.trim().split('\n').filter(Boolean).map(JSON.parse);
  const key = row => row.callId || `${row.sessionId}:${row.purpose}:${row.startedAt}`;
  const ends = events.filter(row => row.event === 'end'), ended = new Set(ends.map(key));
  const unfinished = events.filter(row => row.event === 'start' && !ended.has(key(row)));
  return { events: events.map(row => ({ event: row.event, callId: key(row), model: row.model, sessionId: row.sessionId,
    purpose: row.purpose, startedAt: row.startedAt, finishedAt: row.finishedAt, status: row.status, usage: row.usage,
    finish: row.finish?.kind, failureCode: row.finish?.failure?.code || row.failure?.code,
    error: errorOf(row.finish?.failure?.message || row.failure?.message || row.error) })),
    summary: { started: events.filter(row => row.event === 'start').length, finished: ends.length,
      failed: ends.filter(row => row.status === 'failed').length, unfinished: unfinished.length,
      models: [...new Set(events.map(row => row.model))],
      byPurpose: Object.fromEntries([...new Set(ends.map(row => row.purpose))].map(purpose => [purpose, ends.filter(row => row.purpose === purpose).length])),
      observedUsage: ends.reduce((sum, row) => { for (const [key, value] of Object.entries(row.usage || {})) if (typeof value === 'number') sum[key] = (sum[key] || 0) + value; return sum; }, {}),
      usageRecords: ends.filter(row => row.usage).length, costComplete: false } };
}
await mkdir(destination, { recursive: true });
const attempts = [];
for (const name of (await readdir(local)).filter(name => /^memory-(?:native|vector|long|recovery|compat|delivery)-/.test(name))) {
  const directory = join(local, name);
  const report = await read(join(directory, 'report.json')).catch(() => null); if (!report) continue;
  const calls = await callsOf(directory), interruption = await read(join(directory, 'interruption.json')).catch(() => null);
  if (report.status === 'running' && !interruption) continue;
  attempts.push({ run: name, type: name.split('-')[1], status: report.status, startedAt: report.startedAt, finishedAt: report.finishedAt,
    reportSha256: hash(await readFile(join(directory, 'report.json'))), checks: report.checks, rounds: report.rounds?.length,
    checkpoints: report.checkpoints?.length, error: errorOf(report.error), calls: calls.summary, interruption,
    ...(name === 'memory-native-rYD5HM' ? { audit: 'Initial success invalidated by later audit: runtime snapshots had been ingested as human sources. Fixed and rerun.' } : {}) });
}
attempts.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
await writeFile(join(destination, 'attempts.json'), JSON.stringify({ generatedAt: new Date().toISOString(), attempts }, null, 2) + '\n');

const selected = process.argv[2];
if (!selected) { console.log(JSON.stringify({ attempts: attempts.length, destination })); process.exit(0); }
const directory = resolve(packageRoot, selected), report = await read(join(directory, 'report.json'));
if (report.status === 'running') throw new Error('Wait until the selected long run finishes');
const calls = await callsOf(directory), corpus = await read(join(directory, 'corpus.json'));
const rows = report.finalMemory?.entries || [], sources = report.finalMemory?.sources || [];
const sourceById = new Map(sources.map(source => [source.id, source]));
const runtimeEvents = (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const nativeMessageKinds = new Map(runtimeEvents.filter(event => event.type === 'user/message')
  .map(event => [`${event.sessionId}:${event.seq ?? event.sequence}`, (event.data?.message || event.data)?.source?.kind]));
const toolResults = new Map(runtimeEvents.filter(event => event.type === 'tool/result').map(event => {
  const message = event.data?.message || event.data;
  const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  let value; try { value = JSON.parse(text); } catch { /* not a structured memory tool result */ }
  return [message.toolCallId, value];
}));
const current = row => row.derivation === 'current';
const audit = [];
const test = (name, passed, details) => audit.push({ name, passed: Boolean(passed), details });
test('exactGenerationModelOnly', calls.summary.models.length === 1 && calls.summary.models[0] === 'opencode-go/deepseek-v4.1-flash', calls.summary.models);
test('240CompletedInteractions', report.rounds.length === 240, report.rounds.length);
test('72IndependentQueryCheckpoints', report.checkpoints.length === 72, report.checkpoints.length);
test('sixRealNativeCompactions', report.maintenance.filter(row => row.type === 'native-compaction' && row.result.compacted).length === 6);
test('threePlannedRestartsWithSameIdentities', report.maintenance.filter(row => row.type === 'planned-restart' && row.identitiesPreserved).length === 3);
test('noRuntimeInstructionSources', sources.filter(source => source.transport === 'native')
  .every(source => ['user', 'bot', 'user-question-reply'].includes(nativeMessageKinds.get(source.eventId))));
const quoted = rows.filter(row => current(row) && row.text.includes('海鸥-9999'));
test('quoteRemainsReportedWithOriginalAndRelayingPerson', quoted.length > 0 && quoted.every(row => row.kind === 'reported'
  && row.saidBy === 'matrix:@lin:b.test' && row.sourceRefs.every(ref => sourceById.get(ref.id)?.authorId === 'matrix:@song:memory.test')),
  quoted.map(row => ({ id: row.id, kind: row.kind, saidBy: row.saidBy, sourceRefs: row.sourceRefs })));
const expired = rows.filter(row => row.text.includes('灰鲸-527'));
test('temporaryFactHasExpiredTimestamp', expired.length > 0 && expired.every(row => !current(row)) && expired.some(row => row.validUntil && row.derivation === 'expired'));
const withdrawn = rows.filter(row => row.text.includes('赤狐-804'));
test('forgottenFactHasNoCurrentDuplicate', withdrawn.length > 0 && withdrawn.every(row => !current(row)));
for (const n of [126, 150, 174]) {
  const expected = hash(`memory-round-${n}`), found = rows.filter(row => current(row) && row.text.includes(expected));
  test(`toolObservation${n}`, found.length > 0 && found.every(row => row.kind === 'observation'
    && row.sourceRefs.every(ref => sourceById.get(ref.id)?.authorKind === 'tool')), found.map(row => ({ id: row.id, kind: row.kind, sourceRefs: row.sourceRefs })));
}
const originalRelay = sources.find(source => source.transport === 'matrix' && source.eventId === '$long-78');
const relayCopies = sources.filter(source => source.authorKind === 'bot' && source.originRefs?.some(ref => ref.id === originalRelay?.id));
test('nativeRelayRetainsOriginalEvidence', originalRelay && relayCopies.length > 0, relayCopies.map(row => ({ id: row.id, authorId: row.authorId, originRefs: row.originRefs })));
const finalChecks = report.rounds.filter(row => row.round >= 192 && row.round < 228);
const gaps = finalChecks.map(row => {
  const fact = corpus.steps[row.round].fact;
  return row.round - (fact === 1 ? 48 : corpus.facts[fact].learnedAt);
});
test('earlyFactsSurviveOver100Interactions', gaps.length === 36 && Math.min(...gaps) >= 100, {
  minGap: Math.min(...gaps), maxGap: Math.max(...gaps),
  meaning: 'Global interactions across all three Bots, measured from the current value: the corrected location is learned at round 48, not at its original round 1.' });
const normalized = value => String(value).replace(/[\s，,。:：、\-「」“”`]/g, '');
// An independent time check accepts ordinary Chinese/clock spellings while
// preventing a substring match from accepting 19:00 in place of 09:00.
const releaseTimeMatches = (value, expected) => {
  const hours = { 九: '9', 十: '10', 十一: '11' };
  const text = String(value).replace(/星期|礼拜/g, '周').replace(/十一|十|九/g, word => hours[word]);
  const day = expected[1], hour = Number(expected.match(/\d+/)?.[0]);
  const matches = [...text.matchAll(/周([二三四五2-5])\s*(上午|下午|早上|晚上)?\s*(\d{1,2})\s*(?:(?:点|时)(?:整|\s*(\d{1,2})\s*分?|半)?|[:：]\s*(\d{2}))/g)];
  const days = { 二: 2, 三: 3, 四: 4, 五: 5 };
  return matches.some(match => Number(days[match[1]] || match[1]) === days[day]
    && !['下午', '晚上'].includes(match[2]) && Number(match[3]) === hour
    && !match[0].includes('半') && Number(match[4] || match[5] || 0) === 0);
};
const roomIds = ['!north:memory.test', '!south:memory.test', '!design:memory.test', '!field:memory.test'];
const persistentFacts = corpus.facts.map((fact, index) => {
  const expectedEvent = `$long-${index === 1 ? 48 : fact.learnedAt}`;
  const matching = rows.filter(row => current(row) && row.botId === report.bots?.[fact.bot]?.dsBotId
    && row.scope === `room:${roomIds[fact.room]}`
    && row.sourceRefs.some(ref => sourceById.get(ref.id)?.eventId === expectedEvent)
    && (fact.attribute === '发布时段'
      ? releaseTimeMatches(row.text, fact.value)
      : normalized(row.text).includes(normalized(fact.value))));
  return { fact: index, expectedEvent, passed: matching.some(row => row.receipt?.nativeId && row.index?.state === 'applied'), records: matching.map(row => row.id) };
});
test('all36CurrentFactsRemainInDurableIndexedStoreWithExpectedSource', persistentFacts.every(row => row.passed), persistentFacts);
const timeAnswers = report.checkpoints.filter(checkpoint => checkpoint.type === 'query'
  && corpus.facts[corpus.steps[checkpoint.round].fact].attribute === '发布时段').map(checkpoint => {
  let answer; try { answer = JSON.parse(checkpoint.text.slice(checkpoint.text.indexOf('{'), checkpoint.text.lastIndexOf('}') + 1)); } catch { /* invalid answer fails */ }
  const expected = corpus.facts[corpus.steps[checkpoint.round].fact].value;
  return { round: checkpoint.round, expected, value: answer?.value, passed: releaseTimeMatches(answer?.value, expected) };
});
test('releaseTimeAnswersMatchWholeHourAndWeekday', timeAnswers.length > 0 && timeAnswers.every(answer => answer.passed), timeAnswers);
const queryModes = report.checkpoints.map(checkpoint => {
  const round = report.rounds.find(row => row.round === checkpoint.round);
  const attempts = report.attempts.filter(attempt => attempt.round === checkpoint.round && attempt.record.source?.eventId === `$long-${checkpoint.round}`);
  return { round: checkpoint.round, type: checkpoint.type, acceptedRequestId: round?.requestId,
    results: attempts.flatMap(attempt => (attempt.record.toolReceipts || []).filter(tool => tool.name === 'recall')
      .map(tool => { const result = toolResults.get(tool.callId); return { requestId: attempt.record.requestId, attempt: attempt.attempt,
        callId: tool.callId, status: tool.status, mode: result?.mode, issue: result?.issue, entries: result?.entries?.length }; })) };
});
// Registered before the first query checkpoint: retrying a completed answer for
// a failed background review does not require retrieving the same event again.
// The frozen runner's stricter last-attempt checks remain unchanged above.
const logicalCheckpoints = report.checkpoints.map(checkpoint => {
  const modes = queryModes.find(row => row.round === checkpoint.round);
  const recall = modes.results.filter(result => result.status === 'completed');
  const checks = checkpoint.checks.map(check => check.name === 'usesRecall' ? { ...check, passed: recall.length > 0 } : check);
  return { round: checkpoint.round, type: checkpoint.type, rawPassed: checkpoint.passed,
    passed: checks.every(check => check.passed), checks,
    reusedRecallFromEarlierAttempt: recall.length > 0 && !recall.some(result => result.requestId === modes.acceptedRequestId),
    recallCallIds: recall.map(result => result.callId) };
});
test('allLogicalQueryCheckpointsMatchAnswerAndSourceWithActualRecall', logicalCheckpoints.length === 72 && logicalCheckpoints.every(row => row.passed), {
  passed: logicalCheckpoints.filter(row => row.passed).length,
  reusedRecallRounds: logicalCheckpoints.filter(row => row.reusedRecallFromEarlierAttempt).map(row => row.round),
  failed: logicalCheckpoints.filter(row => !row.passed) });
test('longRunActuallyUsesSemanticRecall', queryModes.some(row => row.results.some(result => result.mode === 'semantic')), {
  semantic: queryModes.filter(row => row.results.some(result => result.mode === 'semantic')).length,
  exact: queryModes.filter(row => row.results.some(result => result.mode === 'exact')).length,
  fallback: queryModes.filter(row => row.results.some(result => result.mode === 'lexical-fallback')).length });
const unplannedRestarts = report.maintenance.filter(row => row.type === 'recovery-restart');
const harrierLog = await readFile(join(directory, 'home/bot/knowledge/ombre/harrier.log'), 'utf8').catch(() => '');
const embeddingResponses = harrierLog.split('\n').filter(line => /POST \/v1\/embeddings/.test(line));
const embedding = { ...report.accounting?.embedding,
  ...(unplannedRestarts.some(row => !row.embeddingSnapshot) ? { complete: false, issue: 'This runner did not snapshot its in-memory embedding counters before unplanned restarts; client totals cover only captured boots.' } : {}),
  serverMatchingAccessLogLines: embeddingResponses.length,
  serverCompletedHttpResponses: embeddingResponses.length || null,
  serverCounterMeaning: embeddingResponses.length
    ? 'Matching completed /v1/embeddings responses in the owned access log; not proof that no request was interrupted.'
    : 'This server build emitted no HTTP access lines. The independent server request count is unknown, not zero; use the separately reported client protocol receipts.' };
const incidentalFindings = report.attempts.filter(attempt => attempt.round === 51 && /需要\s*9\s*箱/.test(attempt.record.text || ''))
  .map(attempt => ({ round: 51, type: 'ungraded-temporary-arithmetic', expected: '58 samples in boxes of 6 require 10 boxes', observed: attempt.record.text,
    scope: 'Filler work is preserved but is not part of the 72 memory-answer checkpoints. This arithmetic slip is not counted as a memory pass.' }));
const published = { run: basename(directory), model: report.model, status: report.status === 'passed' && audit.every(row => row.passed) ? 'passed' : 'failed', runtimeStatus: report.status, startedAt: report.startedAt,
  finishedAt: report.finishedAt, elapsedMs: report.elapsedMs, topology: report.topology, sourceHashes: report.sourceHashes,
  corpusHash: report.corpusHash, rawReportSha256: hash(await readFile(join(directory, 'report.json'))),
  rounds: report.rounds, checkpoints: report.checkpoints, failures: report.failures, maintenance: report.maintenance,
  attempts: report.attempts.map(attempt => ({ round: attempt.round, attempt: attempt.attempt, reviewError: attempt.reviewError,
    requestId: attempt.record.requestId, status: attempt.record.status, text: attempt.record.text, sessionId: attempt.record.sessionId,
    model: attempt.record.model, calls: attempt.record.calls, toolReceipts: attempt.record.toolReceipts,
    artifacts: attempt.record.artifacts?.map(item => ({ name: item.name, sha256: item.sha256, size: item.size })) })),
  accounting: { ...calls.summary, embedding, embeddingByBoot: report.embeddingByBoot },
  audit, queryModes, logicalCheckpoints, incidentalFindings, error: errorOf(report.error), detached: report.detached ? { text: report.detached.text, reason: report.detached.reason, botId: report.detached.bot.id } : undefined,
  finalMemory: { entries: rows.map(({ receipt, index, ...row }) => ({ ...row, bodyReceipt: receipt ? { nativeId: receipt.nativeId,
    componentVersion: receipt.componentVersion, bodyDigest: receipt.bodyDigest } : null, indexed: index?.state === 'applied' })), sources, contacts: report.finalMemory?.contacts,
    pending: report.finalMemory?.pending, errors: report.finalMemory?.errors } };
await writeFile(join(destination, 'long-run.json'), JSON.stringify(published, null, 2) + '\n');
await writeFile(join(destination, 'calls.jsonl'), calls.events.map(row => JSON.stringify(row)).join('\n') + '\n');
await writeFile(join(destination, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n');
console.log(JSON.stringify({ status: published.status, runtimeStatus: report.status, auditPassed: audit.filter(row => row.passed).length, auditTotal: audit.length,
  failedAudit: audit.filter(row => !row.passed), destination }, null, 2));
if (published.status !== 'passed') process.exitCode = 1;
