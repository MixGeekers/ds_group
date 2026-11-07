import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { packageRoot } from '../src/paths.mjs';
import { buildNaturalCorpus, publicCorpusSummary, naturalAssets } from './platform-natural-corpus.mjs';
import { naturalOracles, globalNaturalCriteria, forbiddenScenarioText } from './platform-natural-oracle.mjs';
import { checkNaturalStep, checkNaturalRun, packingContract } from './platform-natural-check.mjs';
import { naturalRestartRecord } from './platform-natural-maintenance.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function saveJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, file);
}
export function definitionFor(profile) {
  const corpus = buildNaturalCorpus(profile), oracles = Object.fromEntries(Object.entries(naturalOracles).filter(([key]) => key.startsWith(`${profile}-`)));
  return { corpus, oracles, globalCriteria: globalNaturalCriteria,
    corpusHash: hash(JSON.stringify(corpus)), oracleHash: hash(JSON.stringify({ oracles, globalNaturalCriteria, packingContract })),
    fixtureHash: hash(JSON.stringify(naturalAssets)), definitionHash: hash(JSON.stringify({ corpus, oracles, globalNaturalCriteria, packingContract, naturalAssets })) };
}
export function validateNaturalDefinition(definition) {
  const { corpus, oracles } = definition;
  assert.equal(corpus.people.length, 4); assert.equal(corpus.bots.length, 3);
  assert.equal(new Set(corpus.steps.map(step => step.id)).size, corpus.steps.length);
  for (const step of corpus.steps) {
    assert.equal(forbiddenScenarioText.test(step.body), false, `Evaluation/memory instruction leaked into ${step.id}`);
    assert.ok(corpus.people.some(person => person.key === step.sender), `Unknown sender ${step.id}`);
    assert.ok(corpus.rooms.some(room => room.key === step.room), `Unknown room ${step.id}`);
    for (const name of step.files || []) assert.ok(Object.hasOwn(naturalAssets, name), `Missing fixture ${name}`);
    if (step.bot !== null) assert.ok(step.bot >= 0 && step.bot < 3 && oracles[step.id], `Missing independent oracle ${step.id}`);
    for (const target of [step.cancel, step.amends].filter(Boolean)) assert.ok(corpus.steps.findIndex(row => row.id === target) < corpus.steps.indexOf(step), `Control target must precede ${step.id}`);
  }
  if (corpus.profile === 'full') {
    assert.equal(corpus.steps.length, 96);
    assert.ok(corpus.steps.filter(step => step.bot === null).length > corpus.steps.length / 2);
    assert.equal(new Set(corpus.steps.map(step => step.businessAt.slice(0, 10))).size, 3);
    assert.ok(corpus.maintenance.compactions.length >= 2 && corpus.maintenance.restarts.length >= 2);
  }
  return publicCorpusSummary(corpus);
}
export function summarizeObservedCalls(calls = [], decisionRows = []) {
  const starts = calls.filter(row => row.event === 'start'), ends = calls.filter(row => row.event === 'end');
  const ended = new Set(ends.map(row => row.callId));
  const abortCodes = new Set(['ABORTED', 'CANCELLED', 'CANCELED', 'ABORT_ERR', 'ERR_ABORTED']);
  const outcome = row => {
    if (['aborted', 'cancelled', 'canceled'].includes(row.status) || ['aborted', 'cancelled', 'canceled'].includes(row.finish?.kind)
      || [row.failure?.code, row.finish?.failure?.code, row.error?.code].some(code => abortCodes.has(code))) return 'aborted';
    if (row.status === 'truncated' || row.finish?.kind === 'max-tokens') return 'truncated';
    if (row.status === 'failed') return 'failed';
    if (row.status === 'completed' && row.finish?.kind !== 'error' && !row.failure && !row.error) return 'successful';
    return 'unknownEnded';
  };
  const outcomes = ends.map(outcome), count = kind => outcomes.filter(value => value === kind).length;
  const sumUsage = rows => rows.reduce((sum, row) => { for (const [key, value] of Object.entries(row.usage || {})) if (typeof value === 'number') sum[key] = (sum[key] || 0) + value; return sum; }, {});
  return { nativeStreams: { classificationVersion: 2, starts: starts.length, ended: ends.length, successful: count('successful'),
    failed: count('failed'), truncated: count('truncated'), aborted: count('aborted'), unknownEnded: count('unknownEnded'),
    unfinished: starts.filter(row => !ended.has(row.callId)).length, models: [...new Set(calls.map(row => row.model).filter(Boolean))],
    byPurpose: Object.fromEntries([...new Set(ends.map(row => row.purpose || 'unknown'))].map(purpose => [purpose, { streams: ends.filter(row => (row.purpose || 'unknown') === purpose).length,
      usage: sumUsage(ends.filter(row => (row.purpose || 'unknown') === purpose)) }])), observedUsage: sumUsage(ends), unit: 'Observed llm/stream lifecycles, including native short-circuit acknowledgements; not verified provider HTTP requests' },
    decisions: { recorded: decisionRows.length, observedUsage: sumUsage(decisionRows), complete: false },
    costComplete: false, unknown: ['Provider billed total and cache billing are not independently reconciled', 'Decision lifecycle/usage completeness requires the node attention_decisions export', 'Embedding server request totals and billed amounts remain separate'] };
}
export function checkDecisionEvidence(bots, decisions, ledger) {
  const known = new Set(ledger.map(event => event.event_id));
  return bots.map(bot => {
    const rows = decisions.filter(row => row.botId === bot.id && row.status === 'decided' && ['LISTEN', 'WAIT', 'SPEAK'].includes(row.action) && row.model);
    const traced = rows.filter(row => row.eventIds?.length && row.eventIds.every(id => known.has(id)));
    return { name: `realNaturalDecision:${bot.id}`, passed: traced.length > 0,
      detail: { recorded: decisions.filter(row => row.botId === bot.id).length, decided: rows.length, sourceLinked: traced.length,
        actions: [...new Set(rows.map(row => row.action))], models: [...new Set(rows.map(row => row.model))] } };
  });
}

async function manifest() {
  let commit = null, files = [];
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim();
    files = execFileSync('git', ['ls-files', '-z', 'src', 'dsh-connect', 'memory', 'vendor/ds-bot', 'scripts', 'dsh-plugin'], { cwd: packageRoot }).toString().split('\0').filter(Boolean); } catch {}
  const hashes = {};
  for (const file of files) hashes[file] = hash(await readFile(path.join(packageRoot, file)));
  return { commit, at: new Date().toISOString(), hashes };
}

export async function runNaturalScenario({ definition, adapter, directory, resume = false, shouldStop = () => false, onProgress = () => {} }) {
  validateNaturalDefinition(definition);
  const { corpus } = definition; await mkdir(directory, { recursive: true });
  const reportFile = path.join(directory, 'report.json');
  let previous;
  try { previous = await readJson(reportFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    assert.ok(resume, 'A report already exists; use another fresh directory or explicitly resume');
    assert.equal(previous.definitionHash, definition.definitionHash, 'A posted scenario and its independent criteria are immutable');
    await mkdir(path.join(directory, 'prior-attempts'), { recursive: true });
    await saveJson(path.join(directory, 'prior-attempts', `report-${Date.now()}.json`), previous);
  }
  const report = previous || { schemaVersion: 1, ...Object.fromEntries(['corpusHash', 'oracleHash', 'fixtureHash', 'definitionHash'].map(key => [key, definition[key]])),
    profile: corpus.profile, scenario: corpus.scenario, startedAt: new Date().toISOString(), evidenceLevel: adapter.evidenceLevel || 'real-local-services-and-provider',
    businessTimeZone: corpus.businessTimeZone, businessStart: corpus.steps[0].businessAt, businessEnd: corpus.steps.at(-1).businessAt,
    planned: publicCorpusSummary(corpus), rows: [], failures: [], reviews: [], maintenance: [], attempts: [], bots: [] };
  report.attempts.push({ startedAt: new Date().toISOString(), resumedAfter: report.rows.length, source: await manifest(),
    ...(adapter.maintenancePolicy ? { maintenancePolicy: adapter.maintenancePolicy } : {}) });
  const save = async () => { report.updatedAt = new Date().toISOString(); await saveJson(reportFile, report); await saveJson(path.join(directory, 'progress.json'), {
    status: report.status, posted: report.rows.length, evaluated: report.rows.filter(row => row.completedAt).length, planned: corpus.steps.length,
    current: report.current, failures: report.failures.length, pendingReviews: report.reviews.filter(row => row.status === 'pending').length, at: report.updatedAt }); };
  const maintain = async after => {
    for (const item of corpus.maintenance.compactions.filter(item => item.after === after)) {
      if (report.maintenance.some(row => row.type === 'native-compaction' && row.after === after && row.result?.compacted)) continue;
      const result = await adapter.compact(item.bot);
      report.maintenance.push({ type: 'native-compaction', after, bot: item.bot, result, at: new Date().toISOString() }); await save();
      if (result.compacted !== true) throw new Error(`Native compaction was not demonstrated after ${after}`);
    }
    if (corpus.maintenance.restarts.includes(after) && !report.maintenance.some(row => row.type === 'native-restart' && row.after === after && row.identitiesPreserved && row.sessionsPreserved)) {
      const result = await adapter.restart(); report.maintenance.push(naturalRestartRecord(after, result)); await save();
      assert.ok(result.identitiesPreserved && result.sessionsPreserved, 'Restart changed native identities or sessions');
    }
  };
  try {
    report.status = 'preparing'; await save(); await saveJson(path.join(directory, 'frozen-definition.json'), definition);
    const identity = await adapter.initialize();
    if (previous?.bots?.length) assert.deepEqual(identity.bots.map(bot => ({ id: bot.id, nativeBotId: bot.nativeBotId, sessionId: bot.sessionId })), previous.bots.map(bot => ({ id: bot.id, nativeBotId: bot.nativeBotId, sessionId: bot.sessionId })), 'Resume must preserve all identities and native sessions');
    report.attempts.at(-1).model = identity.model;
    Object.assign(report, identity); adapter.restoreRows?.(report.rows); report.status = 'running'; await save();
    for (const [index, step] of corpus.steps.entries()) {
      let row = report.rows.find(row => row.id === step.id);
      if (row?.completedAt) {
        // Only the interrupted boundary may be completed on resume. Earlier
        // missing maintenance cannot be retroactively proved by doing it now.
        if (index + 1 === report.rows.filter(item => item.completedAt).length) await maintain(index + 1);
        continue;
      }
      while (await exists(path.join(directory, 'pause'))) { report.status = 'paused-by-operator'; await save(); if (shouldStop()) break; await sleep(500); }
      if (shouldStop() || await exists(path.join(directory, 'stop'))) { report.status = 'stopped-by-operator'; break; }
      report.status = 'running'; report.current = { id: step.id, number: index + 1, scene: step.scene, stage: 'posting' }; await save();
      if (!row) {
        const kind = step.cancel ? 'cancel' : step.amends ? 'amend' : null;
        const observedControl = kind ? await adapter.inspectTarget(kind, step.cancel || step.amends) : null;
        const posted = await adapter.post(step);
        row = { id: step.id, number: index + 1, scene: step.scene, room: step.room, businessAt: step.businessAt, wallStartedAt: new Date().toISOString(), ...posted,
          ...(observedControl ? { observedControl } : {}), checks: [] };
        report.rows.push(row); await save();
      }
      if ((step.cancel || step.amends) && !row.control) {
        row.control = { ...await adapter.control(step.cancel ? 'cancel' : 'amend', step.cancel || step.amends, row.observedControl), correctionEventId: row.eventId }; await save();
      }
      let result;
      if (step.awaitStarted) { row.startedObservation = await adapter.waitStarted(step); result = { receipt: row.startedObservation.receipt, delivered: [] }; }
      else if (step.bot !== null && !step.optional) result = await adapter.waitReply(step);
      else result = await adapter.settle(step);
      row.receipt = result.receipt || null; row.replyEventIds = (result.delivered || []).map(event => event.event_id);
      row.artifacts = await adapter.downloads(result.delivered || [], step);
      const checked = await checkNaturalStep({ step, ...result, artifacts: row.artifacts,
        events: await adapter.protocolEvents(), previousRows: report.rows, directory: path.join(directory, 'contracts', step.id) });
      row.checks = checked.checks; row.reply = checked.reply;
      report.reviews.push(...checked.review.map(item => ({ id: step.id, eventId: row.eventId, replyEventIds: row.replyEventIds, ...item })));
      const failed = row.checks.filter(check => !check.passed);
      if (failed.length) report.failures.push({ id: step.id, type: 'frozen-step-checks', checks: failed });
      if (result.timeout) report.failures.push({ id: step.id, type: 'reply-timeout', status: result.receipt?.status });
      row.completedAt = new Date().toISOString(); await save();
      if (index === corpus.steps.length - 1 || corpus.steps[index + 1]?.scene !== step.scene) {
        const quiet = await adapter.quiet?.();
        if (quiet) { report.maintenance.push({ type: 'scene-quiet-window', after: index + 1, ...quiet }); await save(); }
      }
      await maintain(index + 1); await onProgress({ id: step.id, posted: report.rows.length, failures: report.failures.length, pendingReviews: report.reviews.length });
    }
    if (report.rows.length === corpus.steps.length && report.rows.every(row => row.completedAt)) {
      await adapter.capture();
      report.allDeliveredArtifacts = await adapter.downloads(adapter.ledger.filter(event => report.bots.some(bot => bot.id === event.sender)), { id: 'all-bot-deliveries' });
      report.allBotMessageReview = adapter.ledger.filter(event => report.bots.some(bot => bot.id === event.sender)).map(event => ({
        eventId: event.event_id, room: event.roomKey, botId: event.sender, body: event.content?.body || '',
        originEventId: event.content?.['org.ds_group']?.replyTo || event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id || null,
        criteria: ['回应与当时自然话题相关；可以旁听，不逐条强求发言', '不抢占人与人交谈，不把闲聊无端转成任务', '身份、私聊边界、当时信息和忙闲判断相称'], status: 'pending' }));
      report.runChecks = await checkNaturalRun({ corpus, report, eventLedger: adapter.ledger, directory });
      const failed = report.runChecks.filter(check => !check.passed);
      if (failed.length) report.failures.push({ type: 'frozen-run-checks', checks: failed });
      report.status = report.failures.length ? 'completed-with-failures' : 'completed-awaiting-review';
    }
  } catch (error) {
    report.status = error.code === 'MODEL_QUOTA_EXCEEDED' ? 'provider-blocked' : 'failed';
    report.failures.push({ type: 'runtime-error', id: report.current?.id, code: error.code || null, error: error.message });
    report.error = { code: error.code || null, message: error.message, at: new Date().toISOString() };
  } finally {
    try {
      const evidence = await adapter.finalize(); report.accounting = summarizeObservedCalls(evidence.calls, evidence.decisions); report.final = { ...evidence, calls: undefined, decisions: undefined };
      report.decisionChecks = checkDecisionEvidence(report.bots, evidence.decisions || [], adapter.ledger || []);
      if (report.status.startsWith('completed')) {
        const failed = report.decisionChecks.filter(check => !check.passed);
        if (failed.length) { report.failures.push({ type: 'natural-decisions-not-proven', checks: failed }); report.status = 'completed-with-failures'; }
      }
    }
    catch (error) { report.teardownEvidenceError = error.message; }
    try { await adapter.close(); } catch (error) { report.closeError = error.message; report.status = 'failed'; }
    report.attempts.at(-1).finishedAt = new Date().toISOString(); report.attempts.at(-1).sourceEnd = await manifest();
    report.finishedAt = new Date().toISOString(); report.wallElapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt); await save();
  }
  return report;
}

export function parseNaturalArguments(args) {
  const options = { profile: 'diagnostic', action: 'plan' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (['--plan', '--run', '--freeze'].includes(flag)) options.action = flag.slice(2);
    else if (flag === '--resume') options.resume = true;
    else if (['--profile', '--environment', '--outdir', '--pace-ms', '--timeout-ms'].includes(flag)) {
      const value = args[++index]; assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}`);
      options[{ '--profile': 'profile', '--environment': 'environment', '--outdir': 'directory', '--pace-ms': 'paceMs', '--timeout-ms': 'timeoutMs' }[flag]] = value;
    } else throw new Error(`Unknown natural runner argument: ${flag}`);
  }
  assert.ok(['diagnostic', 'full'].includes(options.profile));
  for (const key of ['paceMs', 'timeoutMs']) if (options[key] !== undefined) assert.ok(Number.isFinite(Number(options[key])) && Number(options[key]) > 0 && Number(options[key]) <= 1200000, `${key} must be a finite positive duration no greater than 20 minutes`);
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = parseNaturalArguments(process.argv.slice(2)), definition = definitionFor(options.profile);
  const summary = validateNaturalDefinition(definition);
  if (options.action === 'freeze') {
    const destination = path.join(packageRoot, 'artifacts/kernel-platform'); await mkdir(destination, { recursive: true });
    await saveJson(path.join(destination, `natural-${options.profile}-definition.json`), definition); console.log(JSON.stringify({ ...summary, definitionHash: definition.definitionHash }));
  } else if (options.action === 'plan') console.log(JSON.stringify({ ...summary, definitionHash: definition.definitionHash, criteria: definition.globalCriteria }, null, 2));
  else {
    assert.ok(options.environment && options.directory, '--run requires --environment and a fresh --outdir');
    const directory = path.resolve(options.directory), ignoredRoot = path.join(packageRoot, '.local') + path.sep;
    assert.ok(directory.startsWith(ignoredRoot), 'Live output including synthetic credentials must stay under this package .local/');
    const environment = await readJson(path.resolve(options.environment));
    const { NaturalLiveAdapter } = await import('./platform-natural-live.mjs');
    let stopping = false; for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
    const adapter = new NaturalLiveAdapter({ ...options, directory, environment, corpus: definition.corpus, corpusHash: definition.definitionHash,
      ...(options.paceMs ? { paceMs: Number(options.paceMs) } : {}), ...(options.timeoutMs ? { timeoutMs: Number(options.timeoutMs) } : {}) });
    const report = await runNaturalScenario({ definition, adapter, directory, resume: options.resume, shouldStop: () => stopping,
      onProgress: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ status: report.status, posted: report.rows.length, failures: report.failures.length, reviews: report.reviews.length, directory }));
    if (['failed', 'provider-blocked'].includes(report.status)) process.exitCode = 1;
  }
}
