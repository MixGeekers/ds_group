// Evidence-only reconciliation. This module never rewrites a historical report.
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export function naturalRestartRecord(step, result, at = new Date().toISOString()) {
  assert.ok(Number.isSafeInteger(step) && step >= 1, 'Restart boundary must be a step number');
  const { before, after, identitiesBefore, identitiesAfter, ...rest } = result;
  return { ...rest, type: 'native-restart', after: step,
    identitiesBefore: identitiesBefore ?? before ?? [],
    identitiesAfter: identitiesAfter ?? (Array.isArray(after) ? after : []), at };
}

export function auditNaturalRestarts(report, { planned = [], hostBoots = [] } = {}) {
  const seenBoots = new Set();
  const records = report.maintenance.filter(row => row.type === 'native-restart').map((record, index) => {
    const at = Date.parse(record.at), before = record.identitiesBefore ?? record.before,
      after = record.identitiesAfter ?? (Array.isArray(record.after) ? record.after : undefined);
    const previous = report.rows.filter(row => Number.isSafeInteger(row.number) && Date.parse(row.completedAt) <= at)
      .sort((a, b) => b.number - a.number)[0];
    const next = report.rows.filter(row => Number.isSafeInteger(row.number) && row.number === previous?.number + 1
      && Number(row.postedAt ?? Date.parse(row.wallStartedAt)) >= at)[0];
    const rowBoundaryVerified = Boolean(previous && next && Date.parse(previous.completedAt) <= at
      && at <= Number(next.postedAt ?? Date.parse(next.wallStartedAt)));
    const candidates = rowBoundaryVerified ? hostBoots.filter(boot => boot.boot > 1
      && boot.bornAtMs >= Date.parse(previous.completedAt) && boot.bornAtMs <= at) : [];
    const boot = candidates.sort((a, b) => b.bornAtMs - a.bornAtMs)[0];
    const repeatedBootEvidence = Boolean(boot && seenBoots.has(boot.boot));
    if (boot) seenBoots.add(boot.boot);
    const completeIdentityArrays = Array.isArray(before) && Array.isArray(after) && before.length > 0 && before.length === after.length
      && before.every(bot => typeof bot.id === 'string' && typeof bot.sessionId === 'string')
      && after.every(bot => typeof bot.id === 'string' && typeof bot.sessionId === 'string');
    const identitiesVerified = Boolean(completeIdentityArrays && isDeepStrictEqual(before.map(bot => bot.id), after.map(bot => bot.id)));
    const sessionsVerified = Boolean(completeIdentityArrays && isDeepStrictEqual(before.map(bot => bot.sessionId), after.map(bot => bot.sessionId)));
    const boundary = rowBoundaryVerified ? previous.number : null;
    const declaredStep = Number.isSafeInteger(record.after) ? record.after : null;
    return { index, declaredStep, legacyAfterWasIdentityArray: Array.isArray(record.after), inferredStep: boundary,
      declaredStepAgrees: declaredStep === null ? null : declaredStep === boundary,
      recordAt: record.at, rowBoundaryVerified,
      window: previous && next ? { previousId: previous.id, previousCompletedAt: previous.completedAt,
        nextId: next.id, nextPostedAt: next.postedAt ?? Date.parse(next.wallStartedAt) } : null,
      hostBoot: boot ? { boot: boot.boot, filename: boot.filename, bornAtMs: boot.bornAtMs } : null,
      repeatedBootEvidence, identitiesVerified, sessionsVerified,
      identitiesBefore: before || [], identitiesAfter: after || [],
      restartEvidenceVerified: Boolean(rowBoundaryVerified && boot && !repeatedBootEvidence && identitiesVerified && sessionsVerified),
      scope: 'Log-file creation plus original row window and exact retained identity arrays; no historical report mutation' };
  });
  const boundaries = [...new Set(records.filter(row => row.restartEvidenceVerified).map(row => row.inferredStep))];
  return { records, verifiedBoundaries: boundaries,
    plannedBoundaryChecks: planned.map(step => ({ step, passed: boundaries.includes(step) })),
    unknownRecords: records.filter(row => !row.restartEvidenceVerified).length,
    limits: ['Filesystem log birth times are local evidence, not proof of a different physical machine',
      'Missing timestamps or boot evidence remain unknown; planned positions are never used to invent a boundary'] };
}

export async function auditNaturalRestartDirectory(directory, destination) {
  const raw = await readFile(path.join(directory, 'report.json')), report = JSON.parse(raw),
    definition = JSON.parse(await readFile(path.join(directory, 'frozen-definition.json'), 'utf8'));
  const hostBoots = [];
  for (const name of (await readdir(path.join(directory, 'host'))).filter(name => /^host-\d+\.log$/.test(name))) {
    const info = await stat(path.join(directory, 'host', name));
    hostBoots.push({ boot: Number(/^host-(\d+)\.log$/.exec(name)[1]), filename: name, bornAtMs: info.birthtimeMs });
  }
  const result = { schemaVersion: 1, at: new Date().toISOString(), sourceStatus: report.status, observedRows: report.rows.length,
    reportSnapshotSha256: createHash('sha256').update(raw).digest('hex'), sourceCommit: report.attempts?.[0]?.source?.commit,
    ...auditNaturalRestarts(report, { planned: definition.corpus.maintenance.restarts, hostBoots }),
    originalReportRewritten: false };
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4) throw new Error('Use: node scripts/platform-natural-maintenance.mjs <run-directory> <new-sidecar.json>');
  const result = await auditNaturalRestartDirectory(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
  console.log(JSON.stringify({ sourceStatus: result.sourceStatus, observedRows: result.observedRows,
    verifiedBoundaries: result.verifiedBoundaries, plannedBoundaryChecks: result.plannedBoundaryChecks }));
}
