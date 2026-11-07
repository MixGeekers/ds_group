// Post-run checks only: no server mutations, model calls or historical rewrites.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkNaturalStep, checkNaturalRun } from './platform-natural-check.mjs';

const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const jsonl = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const fileKey = file => `${file.eventId}/${file.id}`;

export function reviewArtifactBindings(report, ledger, files) {
  const botIds = new Set(report.bots.map(bot => bot.id));
  const expected = ledger.filter(e => e.type === 'm.room.message' && botIds.has(e.sender)).flatMap(event =>
    (event.content?.['org.ds_group']?.attachments || []).map(file => ({ ...file, eventId: event.event_id, roomKey: event.roomKey })));
  assert.equal(new Set(files.map(fileKey)).size, files.length, 'Duplicate artifact delivery in review manifest');
  assert.equal(files.length, expected.length, 'Every actual attachment delivery must be reviewed');
  const actual = new Map(files.map(file => [fileKey(file), file]));
  for (const file of expected) {
    const received = actual.get(fileKey(file));
    assert.ok(received, 'Missing actual artifact delivery');
    assert.equal(received.name, file.name); assert.equal(received.sha256, file.sha256); assert.equal(received.size, file.size);
    assert.equal(received.roomKey ?? received.room, file.roomKey, 'Artifact audience differs from actual Matrix delivery');
  }
  return expected;
}

export async function runNaturalReviewChecks({ runDirectory, downloadManifest, directory }) {
  runDirectory = path.resolve(runDirectory); directory = path.resolve(directory);
  assert.ok(directory !== runDirectory && !directory.startsWith(runDirectory + path.sep), 'Write review checks outside the original run');
  await mkdir(directory, { recursive: false });
  const reportBytes = await readFile(path.join(runDirectory, 'report.json')), report = JSON.parse(reportBytes);
  const definition = await json(path.join(runDirectory, 'frozen-definition.json')),
    ledger = await jsonl(path.join(runDirectory, 'matrix-events.jsonl')), events = await jsonl(path.join(runDirectory, 'host/events.jsonl')),
    files = (await json(downloadManifest)).map(file => ({ ...file, roomKey: file.roomKey ?? file.room }));
  const expected = reviewArtifactBindings(report, ledger, files);
  for (const file of files) {
    const bytes = await readFile(file.path); assert.equal(bytes.length, file.size); assert.equal(sha(bytes), file.sha256);
  }
  const rows = [];
  for (const step of definition.corpus.steps) {
    const row = report.rows.find(row => row.id === step.id); if (!row?.completedAt) continue;
    const delivered = ledger.filter(event => row.replyEventIds?.includes(event.event_id));
    const artifacts = files.filter(file => delivered.some(event => event.event_id === file.eventId));
    const result = await checkNaturalStep({ step, delivered, receipt: row.receipt, artifacts, directory: path.join(directory, 'contracts', step.id), events, previousRows: report.rows });
    rows.push({ id: step.id, checks: result.checks, originalPassFlagsMatch: JSON.stringify(result.checks.map(({ name, passed }) => ({ name, passed })))
      === JSON.stringify(row.checks.map(({ name, passed }) => ({ name, passed }))) });
  }
  const globalChecks = await checkNaturalRun({ corpus: definition.corpus, report: { ...report, allDeliveredArtifacts: files }, eventLedger: ledger, directory });
  const archives = [];
  for (const name of ['control-timeout-01', 'control-timeout-02']) {
    const root = path.join(runDirectory, 'prior-attempts', name), manifest = await json(path.join(root, 'manifest.json'));
    const archiveFiles = [];
    for (const [filename, info] of Object.entries(manifest.files)) {
      const bytes = await readFile(path.join(root, filename));
      assert.equal(bytes.length, info.bytes); assert.equal(sha(bytes), info.sha256);
      let stillAnExactPrefix;
      if (['host/calls.jsonl', 'host/events.jsonl', 'matrix-events.jsonl'].includes(filename)) {
        const current = await readFile(path.join(runDirectory, filename)); stillAnExactPrefix = current.subarray(0, bytes.length).equals(bytes);
        assert.equal(stillAnExactPrefix, true, 'Historical event/call prefix changed');
      }
      archiveFiles.push({ filename, bytes: bytes.length, sha256: sha(bytes), ...(stillAnExactPrefix === undefined ? {} : { stillAnExactPrefix }) });
    }
    archives.push({ name, capturedAt: manifest.capturedAt, files: archiveFiles, allDigestsMatch: true });
  }
  // Original public repair used tests/packing.test.mjs and a distinct module.
  // Reproduce that declared layout without changing any delivered bytes.
  const first = files.find(file => file.name === 'packing.mjs'), firstSuite = files.find(file => file.eventId === first.eventId && file.name === 'packing.test.mjs');
  const legacy = path.join(directory, 'original-seventeen-suite'); await mkdir(path.join(legacy, 'tests'), { recursive: true });
  await copyFile(first.path, path.join(legacy, 'packing.mjs')); await copyFile(firstSuite.path, path.join(legacy, 'tests/packing.test.mjs'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const originalSuite = await execute(process.execPath, ['--test', '--test-reporter=tap', 'tests/packing.test.mjs'], { cwd: legacy, env, timeout: 30000, maxBuffer: 512000 });
  assert.match(originalSuite.stdout, /# tests 17\b/); assert.match(originalSuite.stdout, /# pass 17\b/); assert.match(originalSuite.stdout, /# fail 0\b/);
  await writeFile(path.join(legacy, 'actual-output.txt'), originalSuite.stdout + originalSuite.stderr);
  assert.equal(sha(await readFile(path.join(runDirectory, 'report.json'))), sha(reportBytes));
  const result = { schemaVersion: 1, at: new Date().toISOString(), sourceReportSha256: sha(reportBytes), sourceStatus: report.status,
    definitionHash: report.definitionHash, actualBotMessages: ledger.filter(e => e.type === 'm.room.message' && report.bots.some(b => b.id === e.sender)).length,
    actualArtifactDeliveries: expected.length, everyArtifactByteAndAudienceVerified: true, rows, globalChecks, archives,
    originalSeventeenSuite: { passed: true, tests: 17, moduleSha256: first.sha256, suiteSha256: firstSuite.sha256,
      layout: 'packing.mjs + tests/packing.test.mjs, exactly the original reply layout', stdout: originalSuite.stdout, stderr: originalSuite.stderr },
    originalReportUnchanged: true, newModelCalls: 0,
    limits: ['Frozen mechanical checks are replayed without changing their meaning; independent semantic review remains separate',
      'Attachment download is a separate prerequisite; this entry verifies the recorded actual Matrix bindings and current bytes',
      'Archived unknown/unfinished calls remain in the current prefix; no billed-cost reconciliation is inferred'] };
  await writeFile(path.join(directory, 'checks.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 5) throw new Error('Use: node scripts/platform-natural-review-check.mjs <original-run> <download-manifest.json> <new-check-directory>');
  const result = await runNaturalReviewChecks({ runDirectory: process.argv[2], downloadManifest: process.argv[3], directory: process.argv[4] });
  console.log(JSON.stringify({ actualBotMessages: result.actualBotMessages, artifactsVerified: result.actualArtifactDeliveries,
    mechanicalFailures: result.rows.filter(row => row.checks.some(check => !check.passed)).map(row => ({ id: row.id, checks: row.checks.filter(check => !check.passed).map(check => check.name) })),
    originalPassFlagsMatch: result.rows.every(row => row.originalPassFlagsMatch), archiveFilesVerified: result.archives.reduce((n, archive) => n + archive.files.length, 0),
    originalSeventeenSuitePassed: result.originalSeventeenSuite.passed, originalReportUnchanged: result.originalReportUnchanged }));
}
