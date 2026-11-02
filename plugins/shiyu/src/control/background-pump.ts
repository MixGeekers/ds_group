/** In-memory wake-ups only. Event deliveries and retry eligibility remain in the control DB. */
export interface BackgroundBatch { claimed: number; processed: number; failed: number }
export interface BackgroundPumpState {
  state: 'idle' | 'running' | 'degraded' | 'stopped';
  lastScanAt?: string;
  lastBatch?: BackgroundBatch;
  lastFailure?: string;
}
export interface BackgroundPumpOptions {
  consume(limit: number): Promise<BackgroundBatch>;
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerWake?: number;
}

export class BackgroundPump {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private rerun = false;
  private started = false;
  private closed = false;
  private observation: BackgroundPumpState = { state: 'idle' };

  constructor(private readonly options: BackgroundPumpOptions) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 50;
    this.maxBatches = options.maxBatchesPerWake ?? 4;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 10 || this.intervalMs > 60000
      || !Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 100
      || !Number.isSafeInteger(this.maxBatches) || this.maxBatches < 1 || this.maxBatches > 10) throw new Error('Invalid bounded background scanner configuration');
  }
  snapshot(): BackgroundPumpState { return structuredClone(this.observation); }
  async start(): Promise<void> {
    if (this.closed) throw new Error('Background scanner is closed');
    if (this.started) return this.inFlight;
    this.started = true;
    this.timer = setInterval(() => { void this.wake(); }, this.intervalMs);
    this.timer.unref();
    await this.wake();
  }
  wake(): Promise<void> {
    if (this.closed || !this.started) return Promise.resolve();
    if (this.inFlight) { this.rerun = true; return this.inFlight; }
    // Defer the body so inFlight is installed before consume can resolve/throw.
    const running = Promise.resolve().then(() => this.drain());
    this.inFlight = running.finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async drain(): Promise<void> {
    for (let batch = 0; batch < this.maxBatches && !this.closed; batch++) {
      this.rerun = false;
      this.observation.state = 'running';
      try {
        const result = await this.options.consume(this.batchSize);
        if (![result.claimed, result.processed, result.failed].every(value => Number.isSafeInteger(value) && value >= 0)
          || result.claimed > this.batchSize || result.processed + result.failed !== result.claimed) throw new Error('Invalid background consumption receipt');
        this.observation = { state: result.failed ? 'degraded' : 'idle', lastScanAt: new Date().toISOString(), lastBatch: { ...result },
          ...(result.failed ? { lastFailure: 'Some background deliveries require retry or inspection' } : {}) };
        // Domain failure keeps the durable delivery's backoff; never spin on it.
        if (result.failed || (!this.rerun && result.claimed < this.batchSize)) break;
      } catch (error) {
        this.observation = { ...this.observation, state: 'degraded', lastScanAt: new Date().toISOString(), lastFailure: error instanceof Error ? error.message : String(error) };
        break;
      }
    }
    if (this.closed) this.observation.state = 'stopped';
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.observation.state = 'stopped';
  }
}
