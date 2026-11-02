#!/usr/bin/env node
/**
 * Read-only audit of the shiyu runtime host state (control database, local
 * runtime state file, and owned native Session files).
 *
 * This tool never writes product data, never opens a write database handle and
 * never calls the runtime service. It is intended for frozen before/after
 * snapshots around an ordered plugin reload or a bounded zero-model check.
 *
 * Usage:
 *   node scripts/host-state-audit.mjs [--data-dir <absolute dir>] [--out <json path>]
 *
 * Defaults to plugins/shiyu/.local/runtime inside this package. The output is
 * metadata/digest only: no message body, credential, claim token or prompt text
 * is read from native Session files (only bytes/SHA256/mtime).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import process from 'node:process';

const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { dataDir: join(product, '.local', 'runtime'), out: undefined };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--data-dir') options.dataDir = resolve(argv[++index]);
    else if (argv[index] === '--out') options.out = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const tally = (items) => Object.fromEntries([...items.reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map()).entries()].sort(([a], [b]) => String(a).localeCompare(String(b))));

function readState(dataDir) {
  const file = join(dataDir, 'runtime-state.json');
  if (!existsSync(file)) return { present: false };
  const bytes = readFileSync(file);
  const state = JSON.parse(bytes.toString('utf8'));
  return {
    present: true, bytes: bytes.length, sha256: sha256(bytes),
    schemaVersion: state.schemaVersion, paused: state.paused, installationGeneration: state.installationGeneration,
    bindings: state.bindings?.length ?? 0,
    bindingsByStatus: tally((state.bindings ?? []).map((binding) => binding.status ?? 'unknown')),
    bindingsByRole: tally((state.bindings ?? []).map((binding) => binding.role ?? 'unknown')),
    lastProbe: state.lastProbe ? { at: state.lastProbe.at, ok: state.lastProbe.ok, instanceId: state.lastProbe.instanceId } : null,
    lastModelVerification: state.lastModelVerification ? { at: state.lastModelVerification.at, ok: state.lastModelVerification.ok, calls: state.lastModelVerification.calls ?? null } : null,
    lastGoalVerification: state.lastGoalVerification ? { at: state.lastGoalVerification.at, ok: state.lastGoalVerification.ok } : null,
    lastContextVerification: state.lastContextVerification ? { at: state.lastContextVerification.at, ok: state.lastContextVerification.ok, calls: state.lastContextVerification.calls ?? null } : null,
  };
}

function openReadOnly(filename) {
  if (!existsSync(filename)) return undefined;
  try { return new DatabaseSync(filename, { readOnly: true }); } catch { return undefined; }
}

function jsonColumn(db, sql) {
  try { return db.prepare(sql).all().map((row) => JSON.parse(row.value ?? row.record_json)); } catch { return undefined; }
}

function readControl(dataDir) {
  const dir = join(dataDir, 'control');
  const base = join(dir, 'events.sqlite');
  const db = openReadOnly(base);
  if (!db) return { present: false };
  const one = (sql) => { try { return db.prepare(sql).get(); } catch { return undefined; } };
  const rows = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  try {
    const watermark = one('SELECT version, commit_seq, baseline_id, started_at, schema_hash FROM shiyu_commit_watermark WHERE id=1');
    const publication = one('SELECT state_version, record_json FROM shiyu_state_publication_head WHERE id=1');
    let publicationSummary = null;
    if (publication) {
      const record = JSON.parse(publication.record_json);
      const domains = record.manifest?.domains ?? record.domains ?? {};
      publicationSummary = { stateVersion: publication.state_version, manifestHash: record.manifestHash ?? null, publishedAt: record.publishedAt ?? null,
        domains: Object.fromEntries(Object.entries(domains).map(([id, value]) => [id, { status: value?.status ?? null, reason: value?.reason ?? null }])) };
    }
    const capability = one('SELECT record_json FROM shiyu_capability_state WHERE id=1');
    let capabilitySummary = null;
    if (capability) {
      const record = JSON.parse(capability.record_json);
      capabilitySummary = { schemaVersion: record.schemaVersion, revision: record.revision, safetyRevision: record.safetyRevision,
        capabilityId: record.definition?.capabilityId ?? null, enabled: record.enabled ?? null, hostEpoch: record.hostEpoch ?? null,
        bindingDigest: record.binding?.definitionDigest ?? null,
        observation: record.observation ? { hostEpoch: record.observation.hostEpoch ?? null,
          availability: record.observation.availability ?? record.observation.status ?? null,
          proof: record.observation.proof?.status ?? null } : null };
    }
    const taskRecords = jsonColumn(db, 'SELECT value FROM shiyu_task_record') ?? [];
    const taskRuns = jsonColumn(db, 'SELECT value FROM shiyu_task_runs') ?? [];
    const coreGoals = jsonColumn(db, 'SELECT value FROM shiyu_core_goals') ?? [];
    const coreEvaluations = jsonColumn(db, 'SELECT value FROM shiyu_core_evaluations') ?? [];
    const labConnections = jsonColumn(db, 'SELECT record_json FROM shiyu_lab_connections') ?? [];
    const reservations = jsonColumn(db, 'SELECT record_json FROM shiyu_budget_reservations') ?? [];
    const effects = rows('SELECT status, count(*) AS count FROM shiyu_effects GROUP BY status');
    const deliveries = rows('SELECT status, count(*) AS count FROM deliveries GROUP BY status');
    return {
      present: true, bytes: statSync(base).size, sha256: sha256(readFileSync(base)),
      walBytes: existsSync(`${base}-wal`) ? statSync(`${base}-wal`).size : 0,
      watermark: watermark ? { version: watermark.version, commitSeq: watermark.commit_seq, baselineId: watermark.baseline_id,
        startedAt: watermark.started_at, schemaHash: watermark.schema_hash } : null,
      publication: publicationSummary,
      capability: capabilitySummary,
      tasks: { count: taskRecords.length,
        states: tally(taskRecords.map((task) => task.terminal?.state ?? (task.uncertainty ? 'unknown' : 'open'))),
        ids: taskRecords.map((task) => task.taskId).sort(),
        // Explicit per-task version/update metadata, so recovery-time metadata
        // refreshes are visible in the audit snapshot instead of needing a live DB read.
        metadata: taskRecords.map((task) => ({ taskId: task.taskId, version: task.version ?? null,
          updatedAt: task.updatedAt ?? null, state: task.terminal?.state ?? (task.uncertainty ? 'unknown' : 'open'),
          uncertaintyReason: task.uncertainty?.reason ?? null })) },
      taskRuns: { count: taskRuns.length, states: tally(taskRuns.map((run) => run.state ?? 'unknown')) },
      coreGoals: { count: coreGoals.length, cancelled: coreGoals.filter((goal) => goal.cancelled === true).length,
        paused: coreGoals.filter((goal) => goal.paused === true).length,
        nativePhases: tally(coreGoals.map((goal) => goal.native?.phase ?? 'none')),
        evaluations: { count: coreEvaluations.length, states: tally(coreEvaluations.map((evaluation) => evaluation.status ?? 'unknown')) } },
      lab: { connections: { count: labConnections.length, states: tally(labConnections.map((connection) => connection.status ?? 'unknown')) },
        replies: rows('SELECT count(*) AS count FROM shiyu_lab_replies')[0]?.count ?? 0,
        sends: rows('SELECT count(*) AS count FROM shiyu_lab_sends')[0]?.count ?? 0 },
      budgetReservations: { count: reservations.length, states: tally(reservations.map((reservation) => reservation.state ?? 'unknown')) },
      effects: Object.fromEntries(effects.map((row) => [row.status, row.count])),
      deliveries: Object.fromEntries(deliveries.map((row) => [row.status, row.count])),
      events: one('SELECT count(*) AS count FROM events')?.count ?? 0,
      tables: one("SELECT count(*) AS count FROM sqlite_schema WHERE type='table'")?.count ?? 0,
    };
  } finally { db.close(); }
}

function ownedSessionFiles() {
  const root = join(os.homedir(), '.dsh', 'sessions');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.zstd')) continue;
      const rel = relative(root, full);
      if (!rel.includes('shiyu-')) continue;
      const bytes = readFileSync(full);
      files.push({ relativePath: rel, bytes: bytes.length, sha256: sha256(bytes), mtimeMs: statSync(full).mtimeMs });
    }
  };
  if (existsSync(root)) walk(root);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { root, count: files.length, digest: sha256(Buffer.from(files.map((file) => `${file.relativePath}:${file.sha256}`).join('\n'))), files };
}

function distIdentity() {
  const dir = join(product, 'dist');
  if (!existsSync(dir)) return { present: false };
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = relative(product, full);
      files.push({ path: rel, bytes: statSync(full).size, sha256: sha256(readFileSync(full)) });
    }
  };
  walk(dir);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { present: true, files: files.length, digest: sha256(Buffer.from(files.map((file) => `${file.path}:${file.sha256}`).join('\n'))), entries: files };
}

const options = parseArgs(process.argv.slice(2));
const report = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  scope: 'read-only shiyu host-state audit; no product API, model, embedding or tool call',
  dataDir: options.dataDir,
  state: readState(options.dataDir),
  control: readControl(options.dataDir),
  sessions: ownedSessionFiles(),
  dist: distIdentity(),
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) { await mkdir(dirname(options.out), { recursive: true }); await writeFile(options.out, text); process.stdout.write(`${options.out}\n`); }
else process.stdout.write(text);
