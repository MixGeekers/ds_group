/** Scheduling only. Durable triggers, round claims, gates, per-Goal cooldown and
 * unknown reconciliation belong to the control domain and LocalCoreService. */
export interface CoreFactBatch { claimed: number; processed: number; failed: number }
export interface CoreEvaluationResult {
  status: 'evaluated' | 'idle' | 'deferred' | 'unknown';
  goalId?: string;
  decisionId?: string;
  /** Observation only; never permission to retry an unknown round. */
  retryAt?: string;
}
export interface CorePumpState {
  state: 'idle' | 'running' | 'degraded' | 'stopped';
  phase?: 'facts' | 'pending' | 'evaluating';
  lastScanAt?: string;
  /** Absent when no fact consumer is configured; no fabricated claim/ack count. */
  lastFactBatch?: CoreFactBatch;
  lastEvaluation?: CoreEvaluationResult & { observedAt: string };
  /** Historical observation only; current uncertainty is read from the ledger. */
  lastUncertainty?: CoreEvaluationResult & { observedAt: string };
  lastCancellationAt?: string;
  lastFailure?: string;
}
export interface CorePumpOptions {
  /** Optional pure fact consumer. Its own DB transaction must couple trigger
   * acceptance with ack. It must not call a model or wait for an evaluation. */
  consumeFacts?(limit: number): Promise<CoreFactBatch>;
  /** Read current durable eligibility, excluding unknown rounds. This is only a
   * hint: evaluatePending must independently recheck and atomically claim. */
  pending(): Promise<boolean>;
  /** At most one evaluation. Strong gate, reservation, native dispatch intent,
   * fact settlement and current commit checks remain this service's duty. A
   * rejection after possible dispatch must persist unknown before settling. */
  evaluatePending(input: { signal: AbortSignal }): Promise<CoreEvaluationResult>;
  intervalMs?: number;
  /** Global anti-spin spacing, not the durable per-Goal decision cooldown. */
  minTickMs?: number;
  batchSize?: number;
  maxFactBatchesPerWake?: number;
  maxEvaluationsPerWake?: number;
}
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
function evaluation(value: CoreEvaluationResult): CoreEvaluationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['status', 'goalId', 'decisionId', 'retryAt'].includes(key))
    || !['evaluated', 'idle', 'deferred', 'unknown'].includes(value.status)
    || [value.goalId, value.decisionId].some(id => id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(id)))
    || (value.retryAt !== undefined && (typeof value.retryAt !== 'string' || !Number.isFinite(Date.parse(value.retryAt)) || new Date(value.retryAt).toISOString() !== value.retryAt))) throw new Error('Invalid core evaluation receipt');
  return structuredClone(value);
}

/** One owned timer and one in-flight scan. Wakeups are hints, never model inputs
 * or retries. A fulfilled wake() does not acknowledge any particular trigger. */
export class CorePump {
  private readonly intervalMs: number;
  private readonly minTickMs: number;
  private readonly batchSize: number;
  private readonly maxFacts: number;
  private readonly maxEvaluations: number;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = Infinity;
  private inFlight?: Promise<void>;
  private active?: AbortController;
  private dirty = false;
  private started = false;
  private closed = false;
  private closing?: Promise<void>;
  private nextTickAt = 0;
  private factFailure?: string;
  private evaluationFailure?: string;
  private observation: CorePumpState = { state: 'idle' };

  constructor(private readonly options: CorePumpOptions) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.minTickMs = options.minTickMs ?? 1000;
    this.batchSize = options.batchSize ?? 20;
    this.maxFacts = options.maxFactBatchesPerWake ?? 4;
    this.maxEvaluations = options.maxEvaluationsPerWake ?? 1;
    if (typeof options.pending !== 'function' || typeof options.evaluatePending !== 'function'
      || (options.consumeFacts !== undefined && typeof options.consumeFacts !== 'function')
      || !integer(this.intervalMs, 10, 60000) || !integer(this.minTickMs, 10, 60000) || this.intervalMs < this.minTickMs
      || !integer(this.batchSize, 1, 100) || !integer(this.maxFacts, 1, 10) || !integer(this.maxEvaluations, 1, 4)) throw new Error('Invalid bounded core pump configuration');
  }
  snapshot(): CorePumpState { return structuredClone(this.observation); }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Core pump is closed'));
    if (this.started) return this.inFlight ?? Promise.resolve();
    this.started = true; return this.wake();
  }
  wake(): Promise<void> {
    if (this.closed || !this.started) return Promise.resolve();
    this.dirty = true;
    if (this.inFlight) return this.inFlight;
    if (performance.now() < this.nextTickAt) { this.schedule(this.nextTickAt); return Promise.resolve(); }
    this.clearTimer(); this.dirty = false;
    this.nextTickAt = performance.now() + this.minTickMs;
    const controller = new AbortController(); this.active = controller;
    // Install ownership before any user port, including a synchronous throw.
    const work = Promise.resolve().then(() => this.scan(controller));
    this.inFlight = work.finally(() => {
      this.inFlight = undefined; this.active = undefined;
      // A wake in the scan/finally tail remains dirty. Never recurse into an
      // unbounded drain; even accumulated work waits for the minimum tick.
      if (!this.closed) this.schedule(this.dirty ? Math.max(this.nextTickAt, performance.now()) : performance.now() + this.intervalMs);
    });
    return this.inFlight;
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.timerAt = Infinity; }
  private schedule(at: number): void {
    if (this.closed || !this.started || this.inFlight || (this.timer && this.timerAt <= at)) return;
    this.clearTimer(); this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = undefined; this.timerAt = Infinity; void this.wake(); }, Math.max(1, Math.ceil(at - performance.now())));
    this.timer.unref();
  }
  private phase(phase: NonNullable<CorePumpState['phase']>): void { this.observation = { ...this.observation, state: 'running', phase }; }
  private finishObservation(): void {
    const { phase: _phase, lastFailure: _failure, ...previous } = this.observation;
    const message = this.evaluationFailure ?? this.factFailure;
    this.observation = { ...previous, state: this.closed ? 'stopped' : message ? 'degraded' : 'idle', ...(message ? { lastFailure: message } : {}) };
  }
  private async scan(controller: AbortController): Promise<void> {
    try {
      if (this.closed) return;
      if (this.options.consumeFacts) {
        for (let batch = 0; batch < this.maxFacts && !this.closed; batch++) {
          this.phase('facts');
          const value = await this.options.consumeFacts(this.batchSize);
          if (!value || ![value.claimed, value.processed, value.failed].every(count => integer(count, 0, this.batchSize))
            || value.processed + value.failed !== value.claimed) throw new Error('Invalid core fact consumption receipt');
          this.observation.lastFactBatch = { claimed: value.claimed, processed: value.processed, failed: value.failed };
          this.factFailure = value.failed ? 'Core fact deliveries require retry or inspection' : undefined;
          if (value.failed) return;
          if (value.claimed < this.batchSize) break;
        }
      }
      this.observation.lastScanAt = new Date().toISOString();
      for (let count = 0; count < this.maxEvaluations && !this.closed && !controller.signal.aborted; count++) {
        this.phase('pending');
        const pending = await this.options.pending();
        if (typeof pending !== 'boolean') throw new Error('Invalid core pending observation');
        if (!pending || this.closed || controller.signal.aborted) return;
        this.phase('evaluating');
        const result = evaluation(await this.options.evaluatePending({ signal: controller.signal }));
        const observed = { ...result, observedAt: new Date().toISOString() };
        this.observation.lastEvaluation = observed;
        if (result.status === 'unknown') {
          this.observation.lastUncertainty = structuredClone(observed);
          this.evaluationFailure = 'Core evaluation outcome requires independent reconciliation';
        } else if (result.status === 'evaluated') this.evaluationFailure = undefined;
        // Only the durable domain can make other work eligible. No local retry,
        // and retryAt (including a past value) never starts another evaluation.
        if (result.status !== 'evaluated' || controller.signal.aborted) return;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (this.observation.phase === 'facts') this.factFailure = failure(error);
        else this.evaluationFailure = failure(error);
      }
    } finally { this.finishObservation(); }
  }
  /** Best-effort cancellation after Runtime closes its immediate gate. Facts
   * still flow on subsequent scans; persistent pause/stop is not owned here. */
  cancelEvaluation(reason: unknown = new Error('Core evaluation cancelled')): void {
    if (this.observation.phase !== 'evaluating' || !this.active || this.active.signal.aborted) return;
    this.observation.lastCancellationAt = new Date().toISOString(); this.active.abort(reason);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.dirty = false; this.clearTimer(); this.active?.abort(new Error('Core pump closed'));
    // Do not race away the underlying work: late native facts may still need
    // the store. The Runtime closes dependencies only after this drains.
    this.closing = (async () => { await this.inFlight; this.finishObservation(); })();
    return this.closing;
  }
}
