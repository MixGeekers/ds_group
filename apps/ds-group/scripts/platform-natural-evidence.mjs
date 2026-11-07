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

export async function exportNaturalEvidence(directory, destination, { reviewFile } = {}) {
  const raw = await readFile(path.join(directory, 'report.json'), 'utf8'), report = JSON.parse(raw);
  if (['preparing', 'running', 'paused-by-operator'].includes(report.status)) throw new Error('Export a stopped or completed attempt; do not publish an active snapshot as a result');
  const definition = await readJson(path.join(directory, 'frozen-definition.json'));
  let messageIds = new Set(), eventFilterSource = 'matrix-events-unavailable';
  try {
    const botIds = new Set((report.bots || []).map(bot => bot.id));
    const events = (await readFile(path.join(directory, 'matrix-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    messageIds = new Set(events.filter(event => event.type === 'm.room.message' && botIds.has(event.sender)).map(event => event.event_id));
    eventFilterSource = 'actual m.room.message events in matrix-events.jsonl';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const originalMessageReviews = report.allBotMessageReview || [];
  const allBotMessageReview = originalMessageReviews.filter(row => messageIds.has(row.eventId)).map(row => ({ ...row,
    ...(row.room?.startsWith('private-') ? { body: '[Private message body omitted from public evidence]', privateBodyRedacted: true } : {}) }));
  let independentReview;
  if (reviewFile) {
    const review = await readJson(reviewFile);
    if (review.source?.reportSha256 !== sha(raw) || review.source?.definitionHash !== report.definitionHash) throw new Error('Independent review does not match the immutable source report and definition');
    independentReview = { reviewId: review.reviewId, status: review.status, reviewedAt: review.reviewedAt,
      source: { run: review.source.run, sourceCommit: review.source.sourceCommit, reportSha256: review.source.reportSha256, definitionHash: review.source.definitionHash },
      coverage: review.coverage, oracleReviews: review.oracleReviews,
      regressionReviews: review.regressionReviews, workChangedReview: review.workChangedReview, coverageLimits: review.coverageLimits,
      messageReviews: (review.messageReviews || []).filter(row => messageIds.has(row.eventId)).map(({ eventId, room, bot, verdict, reason, findingIds }) => ({ eventId, room, bot, verdict, reason, findingIds })),
      fileReviews: review.fileReviews, findings: review.findings, ambiguities: review.ambiguities,
      privacy: review.privacy, controlReviews: review.controlReviews, delegationReview: review.delegationReview,
      accountingNotes: review.accountingNotes, immutableSourceCheck: review.immutableSourceCheck };
  }
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
    reviews: report.reviews, allBotMessageReview,
    messageReviewFilter: { source: eventFilterSource, originalRows: originalMessageReviews.length, actualBotMessages: messageIds.size,
      publishedRows: allBotMessageReview.length, excludedNonMessages: originalMessageReviews.length - allBotMessageReview.length },
    ...(independentReview ? { independentReview } : {}), maintenance: report.maintenance,
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
  if (![4, 5].includes(process.argv.length)) throw new Error('Use: node scripts/platform-natural-evidence.mjs <private-run-directory> <new-output-json> [independent-review-sidecar]');
  const destination = path.resolve(process.argv[3]);
  if (!destination.startsWith(path.join(packageRoot, 'artifacts/kernel-platform') + path.sep)) throw new Error('Public evidence belongs under artifacts/kernel-platform/');
  const result = await exportNaturalEvidence(path.resolve(process.argv[2]), destination,
    process.argv[4] ? { reviewFile: path.resolve(process.argv[4]) } : {});
  console.log(JSON.stringify({ status: result.status, posted: result.posted, failures: result.failures.length, destination }));
}
