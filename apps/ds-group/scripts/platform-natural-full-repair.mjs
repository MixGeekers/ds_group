import assert from 'node:assert/strict';
import { memoryTestModel } from './memory-test-model.mjs';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packageDirectory = path.resolve(import.meta.dirname, '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const within = (file, directory) => file === directory || file.startsWith(directory + path.sep);
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
export const REPAIR_BODY = '同事只拿这三个文件跑，少了采购流水.csv。把样例内联到测试里，仍交这三个文件，在只含它们的新目录跑过再发。';
export const REPAIR_FILES = ['packing.mjs', 'packing.test.mjs', 'packing-tests.txt'];

export function repairTarget(definition, report, stepId = 'full-084') {
  const step = definition.corpus.steps.find(item => item.id === stepId), row = report.rows.find(item => item.id === stepId);
  assert.ok(step && row, `Original completed step is missing: ${stepId}`);
  assert.ok(Number.isSafeInteger(step.bot), 'Repair requires an original Bot request');
  const bot = report.bots[step.bot], person = report.people[step.sender], room = report.rooms[step.room];
  assert.equal(row.botId, bot?.id); assert.equal(row.senderId, person?.id); assert.equal(row.roomId, room?.roomId);
  assert.equal(row.room, step.room); assert.ok(row.replyEventIds?.length, 'Original reply is missing');
  return { step, row, bot, person, room, replyTo: row.replyEventIds[0] };
}

export function repairPaths(original, directory) {
  original = path.resolve(original); directory = path.resolve(directory);
  assert.ok(!within(directory, original) && !within(original, directory), 'Repair evidence must be separate from the original run');
  return { original, directory, originalHost: path.join(original, 'host'), host: path.join(directory, 'host') };
}

export async function loadRepairContext({ environmentFile, originalDirectory, directory }) {
  const paths = repairPaths(originalDirectory, directory);
  const environment = await readJson(path.resolve(environmentFile));
  for (const key of ['coreUrl', 'matrixUrl']) assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(environment[key]).hostname), 'This runner reuses the local full-run environment');
  const definition = await readJson(path.join(paths.original, 'frozen-definition.json'));
  const originalReport = await readJson(path.join(paths.original, 'report.json'));
  assert.equal(originalReport.definitionHash, definition.definitionHash); assert.equal(originalReport.rows.length, 96);
  const target = repairTarget(definition, originalReport);
  assert.equal(target.step.room, 'private-b'); assert.equal(target.person.id, originalReport.people.b.id);
  const setup = await readJson(path.join(environment.directory, 'core/matrix-setup.json'));
  const nodes = await readJson(path.join(paths.originalHost, 'nodes.json'));
  const nativeState = await readJson(path.join(paths.originalHost, 'home/bot/state.json'));
  const workspace = (await readJson(path.join(paths.originalHost, 'workspace.json'))).path;
  const scenario = await readJson(path.join(paths.originalHost, 'scenario-profile.json'));
  const marker = await readJson(path.join(paths.originalHost, 'natural-home.json'));
  const previousHost = await readJson(path.join(paths.original, 'host-current.json'));
  assert.ok(Number.isSafeInteger(previousHost.pid) && previousHost.pid > 0, 'Original host PID is missing');
  assert.equal(marker.corpusHash, definition.definitionHash); assert.equal(marker.profile, 'full');
  assert.equal(nodes.length, 3); assert.equal(Object.keys(nativeState.bots).length, 3);
  for (const bot of originalReport.bots) {
    assert.ok(nodes.some(node => node.id === bot.id && node.nativeBotId === bot.nativeBotId));
    assert.ok(nativeState.bots[bot.nativeBotId], 'The original native Bot is absent from the original home');
  }
  environment.model=memoryTestModel(environment.model);
  return { ...paths, environmentFile: path.resolve(environmentFile), environment, definition, originalReport,
    target, setup, nodes, nativeState, workspace, scenario, previousHost, home: path.join(paths.originalHost, 'home') };
}

export async function originalEvidenceManifest(context) {
  const files = (await readdir(context.original, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name);
  files.push('host/events.jsonl', 'host/calls.jsonl', 'host/harness.mjs', 'host/scenario-profile.json');
  for (const file of context.target.row.artifacts || []) files.push(path.relative(context.original, file.path));
  const result = {};
  for (const relative of [...new Set(files)].sort()) {
    const file = path.resolve(context.original, relative); assert.ok(within(file, context.original));
    try { const bytes = await readFile(file); result[relative] = { size: bytes.length, sha256: hash(bytes) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; result[relative] = { absent: true }; }
  }
  return result;
}

export function compareOriginalEvidence(before, after) {
  return Object.keys(before).map(file => ({ file, unchanged: JSON.stringify(before[file]) === JSON.stringify(after[file]), before: before[file], after: after[file] }));
}

export function publicRepairPlan(context) {
  const { target } = context;
  return { status: 'not-run', originalStep: target.step.id, originalRequestId: target.row.requestId,
    sender: target.person, bot: target.bot, room: { key: target.step.room, id: target.room.roomId },
    feedback: REPAIR_BODY, replyTo: target.replyTo, evidenceDirectory: context.directory, home: context.home,
    sourceArtifacts: target.row.artifacts.map(({ name, sha256, size }) => ({ name, sha256, size })),
    checks: ['exactly three newly downloaded attachments', 'complete delivered suite with at least the original 15 tests in a directory containing only the three files',
      'existing independent 17-check packing contract', 'receipt/download/source byte relations', 'same native identities and current Sessions', 'unchanged original evidence', 'final host stop'] };
}

export async function repairSourceManifest(harness) {
  const files = {};
  for (const name of ['src/message-context.mjs', 'src/native-request.mjs', 'memory/native.mjs', 'memory/source-query.mjs', 'memory/snapshot-context.mjs',
    'vendor/ds-bot/src/host/parts.js', 'dsh-connect/native-bridge.mjs',
    'scripts/memory-visible-host-plugin.mjs', 'scripts/platform-natural-full-repair.mjs']) files[name] = hash(await readFile(path.join(packageDirectory, name)));
  const git = await execute('git', ['rev-parse', 'HEAD'], { cwd: packageDirectory, encoding: 'utf8' });
  return { gitHead: git.stdout.trim(), files, ...(harness ? { harness: { path: harness, sha256: hash(await readFile(harness)) } } : {}) };
}

// Reusable same-home connection for this repair; it neither initializes another
// roster nor changes the original profiles, harness, instructions or evidence.
export async function openRepairSession(context, { timeoutMs = 720000 } = {}) {
  assert.ok(!groupAlive(context.previousHost.pid), 'The original host group is still active; finish stopping it before reusing this home');
  const [{ MemoryTestHost }, { NaturalLiveAdapter }, { naturalHarness }, { resolveDsh }] = await Promise.all([
    import('./memory-host.mjs'), import('./platform-natural-live.mjs'), import('./platform-natural-host.mjs'), import('./runtime-config.mjs'),
  ]);
  await mkdir(context.host, { recursive: false, mode: 0o700 });
  const host = new MemoryTestHost(context.host, { model:context.environment.model, requestTimeoutMs: timeoutMs });
  host.home = context.home; host.workspace = context.workspace; host.installation = await resolveDsh();
  await writeJson(path.join(context.host, 'scenario-profile.json'), { ...context.scenario, evidenceDirectory: context.host });
  await writeJson(path.join(context.host, 'nodes.json'), context.nodes);
  for (const [index, node] of context.nodes.entries()) await symlink(node.directory, path.join(context.host, `node-${index}`), 'dir');
  const harness = path.join(context.host, 'repair-harness.mjs'), loader = path.join(context.host, 'repair-loader.mjs');
  await writeFile(harness, naturalHarness({ root: packageDirectory, runtime: host.installation.runtime,
    dependencies: path.join(context.originalHost, 'dependencies'), directory: context.host, workspace: context.workspace }), { mode: 0o600 });
  const originalHarness = pathToFileURL(await realpath(path.join(context.originalHost, 'harness.mjs'))).href;
  await writeFile(loader, `import {registerHooks} from 'node:module';\nimport {readFileSync} from 'node:fs';\nregisterHooks({load(url,context,next){const clean=new URL(url);clean.search='';clean.hash='';if(clean.href===${JSON.stringify(originalHarness)})return{format:'module',source:readFileSync(${JSON.stringify(harness)},'utf8'),shortCircuit:true};return next(url,context);}});\n`, { mode: 0o600 });
  const adapter = new NaturalLiveAdapter({ environment: context.environment, directory: context.directory,
    corpus: context.definition.corpus, corpusHash: context.definition.definitionHash, resume: true, timeoutMs });
  adapter.host = host; adapter.hostDirectory = context.host;
  adapter.people = Object.fromEntries(context.definition.corpus.people.map(profile => {
    const person = context.setup.participants.find(item => item.id === context.originalReport.people[profile.key].id && item.kind === 'human');
    assert.ok(person?.accessToken); return [profile.key, person];
  }));
  adapter.owner = adapter.people.d;
  adapter.bots = context.originalReport.bots.map(bot => ({ ...context.nodes.find(node => node.id === bot.id), ...bot,
    sessionId: context.nativeState.bots[bot.nativeBotId].sessionId || bot.nativeBotId }));
  adapter.rooms = Object.fromEntries(context.definition.corpus.rooms.map(definition => [definition.key,
    { ...context.originalReport.rooms[definition.key], definition, reader: definition.kind === 'direct' ? definition.human : definition.humans[0] }]));
  const ledger = (await readFile(path.join(context.original, 'matrix-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  for (const event of ledger) adapter.seen.add(`${event.room_id}/${event.event_id}`);
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = [previousOptions, `--import ${JSON.stringify(pathToFileURL(loader).href)}`].filter(Boolean).join(' ');
  try {
    try { await host.start(); } finally { if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions; }
    const state = await host.api('state');
    const expected = adapter.bots.map(bot => ({ id: bot.nativeBotId, sessionId: bot.sessionId })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(state.bots.map(({ id, sessionId }) => ({ id, sessionId })).sort((a, b) => a.id.localeCompare(b.id)), expected);
    await host.api('connect');
    return { adapter, host, state, identity: expected, process: { pid: host.child.pid, port: host.port, home: host.home, workspace: host.workspace,
      runtime: host.installation.runtime, evidenceDirectory: context.host, harness, harnessSha256: hash(await readFile(harness)), loaderSha256: hash(await readFile(loader)) } };
  } catch (error) {
    await host.stop().catch(() => {});
    throw error;
  }
}

export async function postRepairFeedback(adapter, context, { id = 'full084-repair-01', body = REPAIR_BODY, originalStepId = 'full-084' } = {}) {
  const target = repairTarget(context.definition, context.originalReport, originalStepId), step = { ...target.step, id, body };
  const person = adapter.people[step.sender], to = [target.bot.id];
  const result = await adapter.api(`/api/rooms/${encodeURIComponent(target.room.roomId)}/messages`, { person, body: {
    body: `<@${target.bot.id}> ${body}`, transactionId: `natural-${id}`, to, attachments: [], replyTo: target.replyTo,
    mentions: { users: to, roles: [], everyone: false, here: false } } });
  const { nativeRequestId } = await import('./platform-natural-live.mjs');
  const posted = { eventId: result.event_id, roomId: target.room.roomId, senderId: target.person.id, botId: target.bot.id,
    requestId: nativeRequestId(target.bot.id, result.event_id), postedAt: Date.now(), step };
  adapter.requests.set(id, posted); return posted;
}

export function parseDeliveredTap(output) {
  const number = name => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
  return { tests: number('tests'), passed: number('pass'), failed: number('fail'), skipped: number('skipped'),
    todo: number('todo'), cancelled: number('cancelled'), cases: [...output.matchAll(/^# Subtest: (.*)$/gm)].map(match => match[1]) };
}

async function nodeCommand(args, cwd) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' };
  try { return { ...await execute(process.execPath, args, { cwd, env, timeout: 30000, maxBuffer: 1024 * 1024 }), exitCode: 0 }; }
  catch (error) { return { stdout: error.stdout || '', stderr: error.stderr || error.message, exitCode: typeof error.code === 'number' ? error.code : null, signal: error.signal || null }; }
}

export async function validateRepairDelivery({ artifacts, receipt, originalRow, directory, verifySources = true }) {
  const checks = [], add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  add('exactThreeFiles', artifacts.length === 3 && new Set(artifacts.map(file => file.name)).size === 3 && REPAIR_FILES.every(name => artifacts.some(file => file.name === name)));
  if (!checks[0].passed) return { checks, passed: false };
  const clean = path.join(directory, 'delivered-only'); await mkdir(clean, { recursive: false });
  const relations = [];
  for (const file of artifacts) {
    assert.equal(path.basename(file.name), file.name);
    const bytes = await readFile(file.path), claimed = receipt.artifacts?.find(item => item.name === file.name), previous = originalRow.artifacts.find(item => item.name === file.name);
    let source;
    if (verifySources && claimed?.path) {
      try { const info = await lstat(claimed.path); assert.ok(info.isFile()); const body = await readFile(claimed.path); source = { size: body.length, sha256: hash(body), mtimeMs: info.mtimeMs }; }
      catch (error) { source = { error: error.message }; }
    }
    const downloaded = { size: bytes.length, sha256: hash(bytes) };
    add(`download:${file.name}`, file.size === downloaded.size && file.sha256 === downloaded.sha256);
    add(`receipt:${file.name}`, claimed?.sha256 === downloaded.sha256 && claimed?.size === downloaded.size);
    if (verifySources) add(`source:${file.name}`, source?.sha256 === downloaded.sha256 && source?.size === downloaded.size);
    relations.push({ name: file.name, downloaded, receipt: claimed && { path: claimed.path, size: claimed.size, sha256: claimed.sha256 }, source,
      originalSha256: previous?.sha256, sameAsOriginal: previous?.sha256 === downloaded.sha256 });
    await copyFile(file.path, path.join(clean, file.name), fsConstants.COPYFILE_EXCL);
  }
  const beforeFiles = (await readdir(clean)).sort(); assert.deepEqual(beforeFiles, [...REPAIR_FILES].sort());
  const syntax = await Promise.all(['packing.mjs', 'packing.test.mjs'].map(async name => ({ name, ...await nodeCommand(['--check', name], clean) })));
  add('javascriptPrototypes', syntax.every(result => result.exitCode === 0), syntax);
  const canonicalClean = await realpath(clean);
  const delivered = await nodeCommand(['--permission', `--allow-fs-read=${canonicalClean}`, '--test-isolation=none', '--test', '--test-reporter=tap', 'packing.test.mjs'], canonicalClean);
  const parsed = parseDeliveredTap(delivered.stdout);
  const originalTap = originalRow.checks?.find(item => item.name === 'deliveredSuiteRunsWithDeliveredModule')?.detail?.stdout;
  const originalCases = originalTap ? parseDeliveredTap(originalTap).cases : [];
  const minimumTests = Math.max(15, originalCases.length);
  add('completeDeliveredSuite', delivered.exitCode === 0 && parsed.tests >= minimumTests && parsed.passed === parsed.tests && parsed.failed === 0
    && parsed.skipped === 0 && parsed.todo === 0 && parsed.cancelled === 0, { ...parsed, minimumTests });
  const coverageReview = { status: 'pending-independent-review', originalCases, currentCases: parsed.cases,
    sameNamesRetained: originalCases.every(name => parsed.cases.includes(name)),
    criterion: 'Compare original and repaired case semantics; names may change and new regression cases may be added.' };
  const afterFiles = (await readdir(clean)).sort(); add('cleanDirectoryContainsOnlyDelivery', JSON.stringify(beforeFiles) === JSON.stringify(afterFiles), afterFiles);
  await writeJson(path.join(directory, 'delivered-suite-result.json'), { ...delivered, parsed, beforeFiles, afterFiles, syntax });
  const { runPackingContract } = await import('./platform-natural-check.mjs');
  const contract = await runPackingContract(path.join(clean, 'packing.mjs'), path.join(directory, 'independent'));
  add('independentSeventeenContracts', contract.passed, { exitCode: contract.exitCode, details: contract.details });
  return { passed: checks.every(item => item.passed), checks, relations, delivered: { ...delivered, parsed }, coverageReview, contract };
}

export async function runFull084Repair(options) {
  const context = await loadRepairContext(options);
  await mkdir(context.directory, { recursive: false, mode: 0o700 });
  const before = await originalEvidenceManifest(context), report = { schemaVersion: 1, startedAt: new Date().toISOString(),
    evidenceLevel: 'real-same-home-natural-feedback-with-independent-downloaded-file-checks', originalStep: 'full-084',
    originalFailure: 'The 15-test suite passed with an additional CSV fixture; the three delivered files alone passed 14/15. The original reply disclosed the fixture dependency after claiming the three-file set was runnable.',
    plan: publicRepairPlan(context), status: 'preparing', originalEvidenceBefore: before, sourceBefore: await repairSourceManifest() };
  await writeJson(path.join(context.directory, 'manifest.json'), { originalEvidenceBefore: before, plan: report.plan, sourceBefore: report.sourceBefore });
  const previousModel = process.env.DSCORD_MEMORY_TEST_MODEL;
  process.env.DSCORD_MEMORY_TEST_MODEL = context.environment.model;
  let session, previousIds = new Set();
  try {
    const { readNaturalDecisions } = await import('./platform-natural-accounting.mjs');
    const decisionsBefore = await readNaturalDecisions(context.nodes);
    previousIds = new Set(decisionsBefore.decisions.map(row => `${row.botId}/${row.id}`));
    report.decisionBaseline = { ids: [...previousIds], errors: decisionsBefore.errors };
    session = await openRepairSession(context, options);
    report.host = session.process; report.identitiesBefore = session.identity;
    report.sourceBefore.harness = { path: session.process.harness, sha256: session.process.harnessSha256 };
    await writeJson(path.join(context.directory, 'host-current.json'), session.process);
    const check = compareOriginalEvidence(before, await originalEvidenceManifest(context));
    assert.ok(check.every(item => item.unchanged), 'Original raw evidence changed before repair feedback');
    report.posted = await postRepairFeedback(session.adapter, context);
    report.status = 'waiting'; await writeJson(path.join(context.directory, 'report.json'), report);
    const result = await session.adapter.waitReply(report.posted.step);
    report.receipt = result.receipt; report.delivered = result.delivered; report.timeout = result.timeout || false;
    report.artifacts = await session.adapter.downloads(result.delivered, report.posted.step);
    const source = result.receipt?.source;
    report.identityChecks = { sender: source?.sender?.id === context.target.person.id, room: source?.roomId === context.target.room.roomId,
      event: source?.eventId === report.posted.eventId, bot: result.receipt?.botId === context.target.bot.id,
      receivedInOriginalRoom: result.delivered.length > 0 && result.delivered.every(event => event.room_id === context.target.room.roomId && event.sender === context.target.bot.id) };
    report.validation = await validateRepairDelivery({ artifacts: report.artifacts, receipt: result.receipt || {}, originalRow: context.target.row, directory: context.directory });
    const final = await session.adapter.finalize();
    report.final = { ...final, decisions: final.decisions.filter(row => !previousIds.has(`${row.botId}/${row.id}`)) };
    await writeJson(path.join(context.directory, 'decision-delta.json'), report.final.decisions);
    report.identitiesAfter = (await session.host.api('state')).bots.map(({ id, sessionId }) => ({ id, sessionId })).sort((a, b) => a.id.localeCompare(b.id));
    report.identitiesPreserved = JSON.stringify(report.identitiesBefore) === JSON.stringify(report.identitiesAfter);
    report.status = result.receipt?.status === 'completed' && !report.timeout && Object.values(report.identityChecks).every(Boolean)
      && report.validation.passed && report.identitiesPreserved ? 'passed' : 'failed';
    report.review = { status: 'pending-independent-review', criterion: 'Inspect the Bot tool trace and the delivered log for its own three-file clean-directory execution before presenting; independent reruns do not retroactively prove that claim.' };
  } catch (error) { report.status = 'failed'; report.error = { code: error.code || null, message: error.message }; }
  finally {
    if (session) {
      const child = session.host.child;
      try { await session.adapter.close(); report.stopped = { pid: child?.pid, exitCode: child?.exitCode, signal: child?.signalCode,
        disconnected: true, terminated: !groupAlive(child.pid), at: new Date().toISOString() };
        if (!report.stopped.terminated) report.status = 'failed'; }
      catch (error) { report.status = 'failed'; report.stopError = error.message; }
      try {
        const { readNaturalDecisions } = await import('./platform-natural-accounting.mjs');
        const observed = await readNaturalDecisions(context.nodes), isNew = row => !previousIds.has(`${row.botId}/${row.id}`);
        const decisions = observed.decisions.filter(isNew);
        report.final = { ...report.final, decisions, decisionExportErrors: observed.errors };
        await writeJson(path.join(context.directory, 'decision-delta.json'), { decisions, records: observed.records.filter(isNew), errors: observed.errors });
        const calls = (await readFile(path.join(context.host, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        const { summarizeObservedCalls } = await import('./platform-natural-run.mjs');
        report.accounting = summarizeObservedCalls(calls, decisions);
      } catch (error) { if (error.code !== 'ENOENT') report.accountingError = error.message; }
    }
    const after = await originalEvidenceManifest(context), preservation = compareOriginalEvidence(before, after);
    report.originalEvidencePreserved = preservation.every(item => item.unchanged);
    if (!report.originalEvidencePreserved) report.status = 'failed';
    report.sourceAfter = await repairSourceManifest(session?.process.harness);
    report.sourceUnchanged = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
    if (!report.sourceUnchanged) report.status = 'failed';
    await writeJson(path.join(context.directory, 'manifest.json'), { originalEvidenceBefore: before, originalEvidenceAfter: after,
      preservation, plan: report.plan, host: report.host, sourceBefore: report.sourceBefore, sourceAfter: report.sourceAfter, sourceUnchanged: report.sourceUnchanged });
    report.finishedAt = new Date().toISOString(); await writeJson(path.join(context.directory, 'report.json'), report);
    if (previousModel === undefined) delete process.env.DSCORD_MEMORY_TEST_MODEL; else process.env.DSCORD_MEMORY_TEST_MODEL = previousModel;
  }
  return report;
}

export function repairOptions(argv) {
  const options = { run: false, environmentFile: path.join(packageDirectory, '.local/platform-natural-full-active.json'),
    originalDirectory: path.join(packageDirectory, '.local/platform-natural-full-run-01'), directory: path.join(packageDirectory, '.local/platform-natural-full-repair-01') };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--run') options.run = true;
    else if (['--environment', '--original', '--outdir', '--timeout-ms'].includes(flag)) {
      const value = argv[++i]; assert.ok(value, `Missing value for ${flag}`);
      options[{ '--environment': 'environmentFile', '--original': 'originalDirectory', '--outdir': 'directory', '--timeout-ms': 'timeoutMs' }[flag]] = flag === '--timeout-ms' ? Number(value) : path.resolve(value);
    } else throw new Error(`Unknown repair option: ${flag}`);
  }
  if (options.timeoutMs !== undefined) assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 3600000);
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = repairOptions(process.argv.slice(2));
  if (!options.run) console.log(JSON.stringify(publicRepairPlan(await loadRepairContext(options)), null, 2));
  else {
    const report = await runFull084Repair(options);
    console.log(JSON.stringify({ status: report.status, directory: options.directory, requestId: report.posted?.requestId,
      files: report.artifacts?.map(file => file.name), originalEvidencePreserved: report.originalEvidencePreserved, sourceUnchanged: report.sourceUnchanged,
      stopped: report.stopped, error: report.error }));
    if (report.status !== 'passed') process.exitCode = 1;
  }
}
