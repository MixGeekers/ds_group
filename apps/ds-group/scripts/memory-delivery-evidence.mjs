// Publish the focused native regression without profiles or full host logs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';
import { MODEL } from './memory-host.mjs';

if (!process.argv[2]) throw new Error('Pass the completed memory-delivery run directory');
const directory = resolve(packageRoot, process.argv[2]);
const rawReport = await readFile(join(directory, 'report.json'));
const report = JSON.parse(rawReport);
if (report.status === 'running') throw new Error('The regression is still running');
const rawCalls = await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => '');
const events = rawCalls.trim().split('\n').filter(Boolean).map(JSON.parse);
const ends = events.filter(row => row.event === 'end');
const ended = new Set(ends.map(row => row.callId));
const unfinished = events.filter(row => row.event === 'start' && !ended.has(row.callId));
const models = [...new Set(events.map(row => row.model))];
const errorOf = value => value ? String(value).split('\n')[0].slice(0, 1500) : undefined;
const sha = value => createHash('sha256').update(value).digest('hex');
const calls = events.map(row => ({ event: row.event, callId: row.callId, model: row.model,
  purpose: row.purpose, sessionId: row.sessionId, startedAt: row.startedAt, finishedAt: row.finishedAt,
  status: row.status, usage: row.usage, finish: row.finish?.kind,
  failureCode: row.finish?.failure?.code || row.failure?.code,
  error: errorOf(row.finish?.failure?.message || row.failure?.message || row.error) }));
const published = {
  run: basename(directory), status: report.status, startedAt: report.startedAt, finishedAt: report.finishedAt,
  elapsedMs: Date.parse(report.finishedAt) - Date.parse(report.startedAt), topology: report.topology,
  model: report.model, checks: report.checks, sourceHashes: report.sourceHashes, cases: report.cases,
  rawReportSha256: sha(rawReport), rawCallsSha256: sha(rawCalls), error: errorOf(report.error),
  attempts: report.attempts.map(({ phase, round, index, repetition, attempt, record, reviewError, error }) => ({
    phase, round, index, repetition, attempt, error: errorOf(error), reviewError: errorOf(reviewError),
    ...(record ? { requestId: record.requestId, status: record.status, text: record.text,
      sessionId: record.sessionId, model: record.model, calls: record.calls, toolReceipts: record.toolReceipts,
      artifacts: record.artifacts?.map(({ name, sha256, size }) => ({ name, sha256, size })) } : {}),
  })),
  accounting: { started: events.filter(row => row.event === 'start').length, finished: ends.length,
    failed: ends.filter(row => row.status === 'failed').length, unfinished: unfinished.length, models,
    byPurpose: Object.fromEntries([...new Set(ends.map(row => row.purpose))]
      .map(purpose => [purpose, ends.filter(row => row.purpose === purpose).length])),
    observedUsage: ends.reduce((sum, row) => {
      for (const [key, value] of Object.entries(row.usage || {})) if (typeof value === 'number') sum[key] = (sum[key] || 0) + value;
      return sum;
    }, {}), usageRecords: ends.filter(row => row.usage).length, embedding: report.embedding, costComplete: false },
  accountingChecks: { onlyRequestedModel: models.length === 1 && models[0] === MODEL, noUnfinishedStreams: unfinished.length === 0 },
};
if (!Object.values(published.accountingChecks).every(Boolean)) published.status = 'failed';
const destination = join(packageRoot, 'artifacts/memory');
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'native-delivery.json'), JSON.stringify(published, null, 2) + '\n');
await writeFile(join(destination, 'native-delivery-calls.jsonl'), calls.map(row => JSON.stringify(row)).join('\n') + '\n');
console.log(JSON.stringify({ status: published.status, checks: published.checks.length, accounting: published.accounting,
  accountingChecks: published.accountingChecks, destination }, null, 2));
if (published.status !== 'passed') process.exitCode = 1;
