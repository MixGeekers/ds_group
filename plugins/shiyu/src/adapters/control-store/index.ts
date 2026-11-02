import { Worker } from "node:worker_threads";
import { EventServiceError } from "../../contracts/events.js";
import type { StoreInfo } from "../../contracts/events.js";
import type { ControlStoreOptions, StoreCommands, StoreResponse } from "./protocol.js";

export type { ControlStoreOptions } from "./protocol.js";

/** SQLite is opened exclusively inside the dedicated worker, never in the host thread. */
export class ControlStore {
  private nextId = 1;
  private closing = false;
  private stopped = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly worker: Worker;
  private closePromise?: Promise<void>;
  private constructor(options: ControlStoreOptions) {
    const entry = import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js";
    this.worker = new Worker(new URL(entry, import.meta.url), { workerData: options });
  }

  static async open(options: ControlStoreOptions): Promise<ControlStore> {
    const store = new ControlStore(options);
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      store.worker.on("message", (message: StoreResponse) => {
        if (message.kind === "ready") { ready = true; resolve(); return; }
        if (message.kind === "fatal") {
          const error = new EventServiceError(message.error.code, message.error.message);
          store.stop(error);
          reject(error);
          void store.worker.terminate();
          return;
        }
        const request = store.pending.get(message.id);
        if (!request) return;
        store.pending.delete(message.id);
        if (message.error) request.reject(new EventServiceError(message.error.code, message.error.message));
        else request.resolve(message.value);
      });
      store.worker.on("error", (error) => { store.stop(error); reject(error); });
      store.worker.on("exit", (code) => {
        const error = new EventServiceError("STORE_CLOSED", `Control store worker exited (${code}).`);
        store.stop(error);
        if (!ready) reject(error);
      });
    });
    return store;
  }

  /** Only the closed set of named domain commands crosses the thread boundary. */
  request<K extends keyof StoreCommands>(command: K, args: StoreCommands[K]["input"]): Promise<StoreCommands[K]["output"]> {
    if (this.stopped || (this.closing && command !== "close")) {
      return Promise.reject(new EventServiceError("STORE_CLOSED", "Control store is closed."));
    }
    if (command !== "close" && this.pending.size >= 256) return Promise.reject(new EventServiceError("BACKPRESSURE", "Control store request queue is full."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { this.worker.postMessage({ id, command, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  info(): Promise<StoreInfo> { return this.request("info", {}); }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (!this.stopped) {
        try { await this.request("close", {}); }
        finally { this.stop(new EventServiceError("STORE_CLOSED", "Control store is closed.")); await this.worker.terminate(); }
      }
    })();
    return this.closePromise;
  }

  private stop(error: Error): void {
    this.stopped = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
