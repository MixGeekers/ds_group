import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActionResult, LabEvent, RunDetail } from './types.ts';

interface RunRow { id: string; metadata: string; }
interface OperationRow { request_hash: string; result: string; }
interface TokenRow { token_hash: string; }
interface StoredOperation { requestHash: string; result: ActionResult; }

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Lab-owned persistence. The event ledger is independent of target claims. */
export class LabStore {
  readonly runtimeDir: string;
  private canonicalRoot?: string;
  private db?: DatabaseSync;

  constructor(runtimeDir: string) {
    this.runtimeDir = resolve(runtimeDir);
  }

  init(): void {
    if (this.db) return;
    mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    this.canonicalRoot = realpathSync(this.runtimeDir);
    const runs = join(this.canonicalRoot, 'runs');
    this.assertNotSymlink(runs);
    mkdirSync(runs, { recursive: true, mode: 0o700 });
    const index = join(this.canonicalRoot, 'index.sqlite');
    for (const file of [index, `${index}-wal`, `${index}-shm`]) this.assertNotSymlink(file);
    this.db = new DatabaseSync(index);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        run_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS target_tokens (
        run_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL
      );
    `);
  }

  runDir(id: string): string {
    this.assertReady();
    if (!RUN_ID.test(id)) throw new Error('Invalid run ID');
    const runs = join(this.canonicalRoot!, 'runs');
    this.assertNotSymlink(runs);
    const directory = join(runs, id);
    this.assertNotSymlink(directory);
    return directory;
  }

  saveRun(run: RunDetail): void {
    const directory = this.ensureRunDir(run.id);
    // The snapshot is only an index. events.jsonl remains the event authority.
    const snapshot = { ...run, events: [], persistedEventCount: run.events.length };
    this.atomicJSON(join(directory, 'snapshot.json'), snapshot);
    this.atomicJSON(join(directory, 'manifest.json'), run.manifest);
    this.db!.prepare(`
      INSERT INTO runs (id, status, created_at, metadata) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, created_at = excluded.created_at, metadata = excluded.metadata
    `).run(run.id, run.status, run.createdAt, JSON.stringify(snapshot));
  }

  appendEvent(runId: string, event: LabEvent): void {
    if (event.runId !== runId || !Number.isInteger(event.seq) || event.seq < 1) {
      throw new Error('Event run identity or sequence is invalid');
    }
    const directory = this.ensureRunDir(runId);
    const filename = join(directory, 'events.jsonl');
    this.assertNotSymlink(filename);
    const fd = openSync(filename, 'a', 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  loadRuns(): RunDetail[] {
    this.assertReady();
    const rows = this.db!.prepare('SELECT id, metadata FROM runs ORDER BY created_at DESC').all() as unknown as RunRow[];
    const indexed = new Map(rows.map((row) => [row.id, row.metadata]));
    const runsRoot = join(this.canonicalRoot!, 'runs');
    this.assertNotSymlink(runsRoot);
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!RUN_ID.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink run directory: ${entry.name}`);
      if (entry.isDirectory() && !indexed.has(entry.name)) indexed.set(entry.name, '');
    }

    const result: RunDetail[] = [];
    for (const [id, metadata] of indexed) {
      const directory = this.runDir(id);
      const snapshotPath = join(directory, 'snapshot.json');
      this.assertNotSymlink(snapshotPath);
      const issues: string[] = [];
      let run: RunDetail & { persistedEventCount?: number };
      try {
        run = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      } catch (error) {
        if (!metadata) {
          // A directory with only an unfinished temporary snapshot never became a run.
          const hasEvidence = existsSync(join(directory, 'events.jsonl')) || existsSync(snapshotPath);
          if (!hasEvidence) continue;
          throw new Error(`Cannot recover run ${id}: snapshot and SQLite metadata unavailable`, { cause: error });
        }
        try { run = JSON.parse(metadata); }
        catch { throw new Error(`Cannot recover run ${id}: invalid snapshot and SQLite metadata`); }
        issues.push('snapshot missing or unreadable; recovered metadata from SQLite');
      }
      if (!run || run.id !== id || !Array.isArray(run.tasks) || !run.config || !run.manifest) {
        throw new Error(`Cannot recover run ${id}: invalid stored run structure`);
      }

      const eventsPath = join(directory, 'events.jsonl');
      this.assertNotSymlink(eventsPath);
      let events: LabEvent[] = [];
      if (existsSync(eventsPath)) {
        const recovered = this.readEvents(eventsPath, id);
        events = recovered.events;
        issues.push(...recovered.issues);
      } else if ((run.persistedEventCount ?? run.events?.length ?? 0) > 0) {
        issues.push('event ledger is missing');
      }
      if ((run.persistedEventCount ?? 0) > events.length) issues.push('event ledger has fewer records than the saved snapshot');
      if (run.persistedEventCount !== undefined && run.persistedEventCount < events.length) {
        issues.push('snapshot lags the event ledger; latest state could not be recovered atomically');
      }
      run.events = events;
      delete run.persistedEventCount;
      if (issues.length) {
        run.status = 'interrupted';
        run.error = `Evidence recovery incomplete: ${[...new Set(issues)].join('; ')}`;
        delete run.factReport;
        run.manifest = {
          ...run.manifest,
          evidenceRecovery: { status: 'incomplete', at: new Date().toISOString(), issues: [...new Set(issues)] },
        };
      }
      result.push(run);
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  saveOperation(runId: string, operationId: string, requestHash: string, result: ActionResult): void {
    this.runDir(runId);
    this.validateOperationId(operationId);
    if (!requestHash || requestHash.length > 256) throw new Error('Invalid operation request hash');
    const old = this.getOperation(runId, operationId);
    if (old) {
      if (old.requestHash !== requestHash) throw new Error('Operation ID was already used for a different request');
      return;
    }
    this.db!.prepare(`INSERT INTO operations (run_id, operation_id, request_hash, result, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(runId, operationId, requestHash, JSON.stringify(result), new Date().toISOString());
  }

  getOperation(runId: string, operationId: string): StoredOperation | undefined {
    this.runDir(runId);
    this.validateOperationId(operationId);
    const row = this.db!.prepare('SELECT request_hash, result FROM operations WHERE run_id = ? AND operation_id = ?')
      .get(runId, operationId) as unknown as OperationRow | undefined;
    return row ? { requestHash: row.request_hash, result: JSON.parse(row.result) as ActionResult } : undefined;
  }

  /** Cold, read-only evidence from exactly one run; never repair or accept a partial ledger. */
  readPersistedEvents(runId: string, expectedEventCount: number): LabEvent[] {
    if (!Number.isSafeInteger(expectedEventCount) || expectedEventCount < 0) throw new Error('Invalid expected event count');
    const filename = join(this.runDir(runId), 'events.jsonl');
    this.assertNotSymlink(filename);
    const { events, issues } = this.readEvents(filename, runId);
    if (issues.length || events.length !== expectedEventCount) throw new Error('Persisted event evidence is incomplete or inconsistent');
    return events;
  }

  saveToken(runId: string, tokenHash: string): void {
    this.runDir(runId);
    if (!tokenHash || tokenHash.length > 256) throw new Error('Invalid target token hash');
    this.db!.prepare(`INSERT INTO target_tokens (run_id, token_hash) VALUES (?, ?)
      ON CONFLICT(run_id) DO UPDATE SET token_hash = excluded.token_hash`).run(runId, tokenHash);
  }

  getTokenHash(runId: string): string | undefined {
    this.runDir(runId);
    const row = this.db!.prepare('SELECT token_hash FROM target_tokens WHERE run_id = ?')
      .get(runId) as unknown as TokenRow | undefined;
    return row?.token_hash;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private readEvents(filename: string, runId: string): { events: LabEvent[]; issues: string[] } {
    const content = readFileSync(filename, 'utf8');
    const events: LabEvent[] = [];
    const issues: string[] = [];
    if (content && !content.endsWith('\n')) issues.push('event ledger ends in a possibly incomplete record');
    const ids = new Set<string>();
    let previousSeq = 0;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line && i === lines.length - 1) continue;
      try {
        const event = JSON.parse(line) as LabEvent;
        if (!event || event.runId !== runId || typeof event.id !== 'string'
          || !Number.isInteger(event.seq) || event.seq <= previousSeq || typeof event.text !== 'string') {
          issues.push(`invalid event at line ${i + 1}`);
          continue;
        }
        if (ids.has(event.id)) {
          issues.push(`duplicate event ID at line ${i + 1}`);
          continue;
        }
        if (event.seq !== previousSeq + 1) issues.push(`event sequence gap before ${event.seq}`);
        previousSeq = event.seq;
        ids.add(event.id);
        events.push(event);
      } catch {
        issues.push(`unreadable event at line ${i + 1}`);
      }
    }
    return { events, issues };
  }

  private assertReady(): void {
    if (!this.db || !this.canonicalRoot) throw new Error('LabStore.init() must be called first');
  }

  private ensureRunDir(id: string): string {
    const directory = this.runDir(id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private assertNotSymlink(path: string): void {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private validateOperationId(id: string): void {
    if (typeof id !== 'string' || id.length < 1 || id.length > 512 || /[\u0000-\u001f]/.test(id)) {
      throw new Error('Invalid operation ID');
    }
  }

  private atomicJSON(filename: string, value: unknown): void {
    this.assertNotSymlink(filename);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try { renameSync(temporary, filename); }
    catch (error) {
      try { unlinkSync(temporary); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }
}
