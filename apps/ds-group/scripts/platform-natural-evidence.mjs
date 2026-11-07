// Publish a whitelist of synthetic evidence; private homes/configurations and
// full provider/session/kernel logs stay in the ignored run directory.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const safeError = value => value ? String(value).split('\n')[0].replace(/Bearer\s+\S+|sk-[\w-]{12,}/gi, '<redacted>').slice(0, 1200) : undefined;

export async function exportNaturalEvidence(directory, destination) {
  const raw = await readFile(path.join(directory, 'report.json'), 'utf8'), report = JSON.parse(raw);
  if (['preparing', 'running', 'paused-by-operator'].includes(report.status)) throw new Error('Export a stopped or completed attempt; do not publish an active snapshot as a result');
  const definition = await readJson(path.join(directory, 'frozen-definition.json'));
  const artifacts = (report.allDeliveredArtifacts || report.rows.flatMap(row => row.artifacts || [])).map(({ name, size, sha256, eventId, roomKey }) => ({ name, size, sha256, eventId, room: roomKey }));
  const result = { schemaVersion: 1, run: path.basename(directory), generatedAt: new Date().toISOString(),
    evidenceLevel: report.evidenceLevel, status: report.status, model: report.model,
    reportSha256: sha(raw), definitionHash: report.definitionHash, corpusHash: report.corpusHash, oracleHash: report.oracleHash, fixtureHash: report.fixtureHash,
    startedAt: report.startedAt, finishedAt: report.finishedAt, wallElapsedMs: report.wallElapsedMs,
    businessTime: { start: report.businessStart, end: report.businessEnd, zone: report.businessTimeZone, synthetic: true },
    planned: report.planned, posted: report.rows.length, evaluated: report.rows.filter(row => row.completedAt).length,
    bots: report.bots, people: report.people, rooms: report.rooms, membershipEvidence: report.membershipEvidence, topology: report.topology, memoryObservation: report.memoryObservation,
    attempts: report.attempts.map(attempt => ({ startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, resumedAfter: attempt.resumedAfter, model: attempt.model,
      startCommit: attempt.source?.commit, endCommit: attempt.sourceEnd?.commit,
      sourceHashesAtStart: attempt.source?.hashes, sourceHashesAtEnd: attempt.sourceEnd?.hashes })),
    rows: report.rows.map(row => ({ id: row.id, number: row.number, room: row.room, businessAt: row.businessAt,
      wallStartedAt: row.wallStartedAt, completedAt: row.completedAt, senderId: row.senderId, botId: row.botId, eventId: row.eventId, requestId: row.requestId,
      replyEventIds: row.replyEventIds, checks: row.checks, control: row.control ? { kind: row.control.kind, targetId: row.control.targetId,
        requestId: row.control.requestId, correctionEventId: row.control.correctionEventId, observedStatus: row.control.observedStatus,
        observedActive: row.control.observedActive, observedAt: row.control.observedAt, completedAt: row.control.completedAt } : undefined })),
    runChecks: report.runChecks, decisionChecks: report.decisionChecks, failures: report.failures,
    reviews: report.reviews, allBotMessageReview: report.allBotMessageReview, maintenance: report.maintenance,
    accounting: report.accounting, finalEvidence: report.final ? { eventCount: report.final.eventCount, kernelSnapshots: report.final.kernelSnapshots,
      decisionExportErrors: report.final.decisionExportErrors, memoryUsage: report.final.memoryUsage, memoryObservation: report.final.memoryObservation } : undefined,
    artifacts, criteria: definition.globalCriteria, error: safeError(report.error?.message),
    limits: ['Synthetic roles and accelerated story dates; not a real three-day observation', 'One physical host; no physical cross-machine result',
      'completed-awaiting-review is not acceptance; social/source-priority reviews must be finished separately', 'Provider billed total and complete embedding cost remain unknown unless separately reconciled'] };
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4) throw new Error('Use: node scripts/platform-natural-evidence.mjs <private-run-directory> <new-output-json>');
  const destination = path.resolve(process.argv[3]);
  if (!destination.startsWith(path.join(packageRoot, 'artifacts/kernel-platform') + path.sep)) throw new Error('Public evidence belongs under artifacts/kernel-platform/');
  const result = await exportNaturalEvidence(path.resolve(process.argv[2]), destination);
  console.log(JSON.stringify({ status: result.status, posted: result.posted, failures: result.failures.length, destination }));
}
