import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { SessionBinding } from '../adapters/dsh/sessions.js';
import type { ModelUsage } from '../adapters/dsh/sessions.js';

export interface LocalState {
  schemaVersion: 1;
  paused: boolean;
  installationGeneration?: string;
  bindings: SessionBinding[];
  lastProbe?: { at: string; ok: boolean; message: string; instanceId?: string };
  lastModelVerification?: { at: string; ok: boolean; message: string; instanceId: string; calls: number; sessionId?: string; usage: ModelUsage[] };
  lastGoalVerification?: { at: string; ok: boolean; message: string; instanceId: string; goalId?: string; sessionId?: string };
}

/** Business bindings only. Model history and compaction remain in DSH. */
export class LocalStateFile {
  state: LocalState = { schemaVersion: 1, paused: false, bindings: [] };
  private tail: Promise<void> = Promise.resolve();
  private release?: () => Promise<void>;
  private fault?: Error;
  private faultListeners = new Set<(error: Error) => void>();
  private closed = false;
  private constructor(readonly directory: string, private readonly file: string) {}
  static async open(directory: string): Promise<LocalStateFile> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonical = await realpath(directory);
    const result = new LocalStateFile(canonical, path.join(canonical, 'runtime-state.json'));
    result.release = await lockfile.lock(canonical, { realpath: true, retries: 0, stale: 30000, update: 10000,
      onCompromised(error) { result.setFault(error); } });
    try {
      let exists = true;
      try { const s = await lstat(result.file); if (!s.isFile() || s.isSymbolicLink()) throw new Error('State must be a regular file'); }
      catch (error: any) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (exists) {
        const parsed = JSON.parse(await readFile(result.file, 'utf8'));
        if (parsed.schemaVersion !== 1 || typeof parsed.paused !== 'boolean' || !Array.isArray(parsed.bindings)) throw new Error('Unsupported runtime state');
        result.state = parsed;
      } else await result.update(() => undefined);
      return result;
    } catch (error) { await result.release(); throw error; }
  }
  assertHealthy(): void { if (this.closed) throw new Error('Runtime state is closed'); if (this.fault) throw new Error(`Runtime state unavailable: ${this.fault.message}`); }
  onFault(listener: (error: Error) => void): () => void {
    this.faultListeners.add(listener);
    if (this.fault) listener(this.fault);
    return () => { this.faultListeners.delete(listener); };
  }
  private setFault(error: Error): void {
    this.fault ??= error;
    for (const listener of this.faultListeners) { try { listener(this.fault); } catch { /* Preserve the original storage failure. */ } }
  }
  update(change: (state: LocalState) => void): Promise<void> {
    const next = this.tail.then(async () => {
      this.assertHealthy();
      const state = structuredClone(this.state); change(state);
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
        this.assertHealthy(); await rename(temp, this.file);
        // Rename has already changed the visible file. If directory durability
        // cannot be confirmed, freeze further writes rather than overwrite it
        // later using the previous in-memory value.
        this.state = state;
        try {
          const parent = await open(this.directory, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        } catch (error) {
          this.setFault(new Error('State replacement durability is uncertain', { cause: error }));
          throw this.fault;
        }
      } finally { await rm(temp, { force: true }); }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  async close(): Promise<void> { await this.tail; this.closed = true; this.faultListeners.clear(); await this.release?.(); this.release = undefined; }
}
