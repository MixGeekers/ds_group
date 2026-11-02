/**
 * Owner-only `runtime.checkpoint.capture` command handler.
 *
 * The handler is deliberately a plain deterministic function/class so the
 * Runtime integration diff is small and reviewable:
 *  - strict input shape (only `action` and an optional `requestId`);
 *  - single-flight: a concurrent request returns `busy` and never queues;
 *  - allowed while paused (it performs no model/dispatch side effects) and it
 *    never changes pause state;
 *  - never triggered by a GET/snapshot/status read: the composition is only
 *    created by explicit composition, and `handle()` is the sole entry;
 *  - no automatic retry: one attempt per request; failures are returned as a
 *    structured degraded result for the owner and recorded as diagnostics.
 */
import { randomUUID } from 'node:crypto';
import { RecoveryError } from './errors.js';
import { summarizeCaptureResult } from './host-ports.js';
import { validateCheckpointProbeResult } from './checkpoint-probe.js';
import type { CaptureResult, CheckpointProbeResult } from './types.js';
import type { RuntimeCheckpointComposition } from './host-ports.js';

export interface RuntimeCheckpointCommandDeps {
  /**
   * Trusted composition result (or a lazy resolver invoked only by an explicit
   * owner command). Undefined/null means the staging root was not configured.
   */
  composition?: RuntimeCheckpointComposition
    | (() => RuntimeCheckpointComposition | undefined | null | Promise<RuntimeCheckpointComposition | undefined | null>);
  isOpen(): boolean;
  isPaused(): boolean;
  now?: () => Date;
  snapshotId?: () => string;
  /** Optional diagnostic sink; failures are retained but never change the result. */
  onDiagnostic?(entry: { at: string; status: string; snapshotId: string; code: string | null }): void;
}

export interface RuntimeCheckpointComponentState {
  componentId: string;
  status: string;
  failureCodes: string[];
}

export interface RuntimeCheckpointCommandResult {
  schemaVersion: 1;
  action: 'runtime.checkpoint.capture';
  requestId: string;
  status: 'ready' | 'incomplete' | 'failed' | 'busy' | 'unavailable';
  code: string | null;
  snapshotId: string | null;
  bundleStatus: string | null;
  manifestSha256: string | null;
  captureTime: string | null;
  componentStates: RuntimeCheckpointComponentState[];
  failureCodes: string[];
  blockedComponents: { componentId: string; code: string; requiredScope: string[] }[];
  stagingRootHash: string | null;
  generation: { installationGeneration: string; hostEpoch: string } | null;
  retried: false;
  autoTriggered: false;
  pausedAtRequest: boolean;
  desiredState: 'unchanged';
  degradedReason: string | null;
  durationMs: number;
}

const ACTION = 'runtime.checkpoint.capture';
const INPUT_KEYS = ['action', 'requestId'] as const;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const sanitizeText = (text: string, replacements: [string, string][]): string => {
  let result = text;
  for (const [from, to] of replacements) {
    if (from && from.length > 1) result = result.split(from).join(to);
  }
  return result.replace(/(?:\/Users|\/home|\/private|\/var|\/tmp)\/[^\s'")]+/g, '<path>').slice(0, 300);
};

const readRequest = (input: unknown): { requestId: string } => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Expected a checkpoint command object');
  }
  const value = input as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
    throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Checkpoint command must contain plain data fields');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !(INPUT_KEYS as readonly string[]).includes(key))) {
    throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Unknown checkpoint command field');
  }
  if (value.action !== ACTION) throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Unsupported checkpoint action');
  if (value.requestId !== undefined && (typeof value.requestId !== 'string' || !SAFE.test(value.requestId))) {
    throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'requestId must be a bounded identifier');
  }
  return { requestId: typeof value.requestId === 'string' ? value.requestId : randomUUID() };
};

export class RuntimeCheckpointCommand {
  private running: Promise<RuntimeCheckpointCommandResult> | undefined;
  constructor(private readonly deps: RuntimeCheckpointCommandDeps) {}

  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }

  private baseResult(requestId: string, paused: boolean, durationMs: number): RuntimeCheckpointCommandResult {
    return {
      schemaVersion: 1,
      action: ACTION,
      requestId,
      status: 'failed',
      code: null,
      snapshotId: null,
      bundleStatus: null,
      manifestSha256: null,
      captureTime: null,
      componentStates: [],
      failureCodes: [],
      blockedComponents: [],
      stagingRootHash: null,
      generation: null,
      retried: false,
      autoTriggered: false,
      pausedAtRequest: paused,
      desiredState: 'unchanged',
      degradedReason: null,
      durationMs,
    };
  }

  private report(result: RuntimeCheckpointCommandResult): void {
    try { this.deps.onDiagnostic?.({ at: this.now(), status: result.status, snapshotId: result.snapshotId ?? '', code: result.code }); } catch { /* diagnostics never change the result */ }
  }

  /** Only an explicit owner command reaches this method; GET/status paths never call it. */
  async handle(input: unknown, signal?: AbortSignal): Promise<RuntimeCheckpointCommandResult> {
    if (!this.deps.isOpen()) throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Runtime is not open');
    signal?.throwIfAborted();
    const { requestId } = readRequest(input);
    if (this.running) {
      const busy = this.baseResult(requestId, this.deps.isPaused(), 0);
      busy.status = 'busy';
      busy.code = 'CHECKPOINT_BUSY';
      busy.degradedReason = 'Another checkpoint capture is already running; this request was not queued or retried';
      this.report(busy);
      return busy;
    }
    const started = Date.now();
    const paused = this.deps.isPaused();
    const execution = this.execute(requestId, paused, started, signal);
    this.running = execution;
    try { return await execution; } finally { this.running = undefined; }
  }

  private async execute(requestId: string, paused: boolean, started: number, signal?: AbortSignal): Promise<RuntimeCheckpointCommandResult> {
    const result = this.baseResult(requestId, paused, 0);
    let composition: RuntimeCheckpointComposition | undefined;
    try {
      const candidate = this.deps.composition;
      composition = (typeof candidate === 'function' ? await candidate() : candidate) ?? undefined;
    } catch (error) {
      result.status = 'failed';
      result.code = error instanceof RecoveryError ? error.code : 'CHECKPOINT_STAGING_UNCONFIGURED';
      result.failureCodes = [result.code];
      result.degradedReason = sanitizeText(error instanceof Error ? error.message : 'checkpoint composition failed', []);
      result.durationMs = Date.now() - started;
      this.report(result);
      return result;
    }
    if (!composition) {
      result.status = 'unavailable';
      result.code = 'CHECKPOINT_STAGING_UNCONFIGURED';
      result.degradedReason = 'No checkpoint staging root is configured; no capture was attempted and no retry will occur';
      result.durationMs = Date.now() - started;
      this.report(result);
      return result;
    }
    result.stagingRootHash = composition.stagingRootHash;
    try {
      const availability = composition.availability();
      result.blockedComponents = availability.blockers.map((item) => ({ ...item, requiredScope: [...item.requiredScope] }));
      signal?.throwIfAborted();
      const snapshotId = this.deps.snapshotId?.() ?? (await import('./host-ports.js')).newCheckpointSnapshotId(this.deps.now);
      result.snapshotId = snapshotId;
      let capture: CaptureResult;
      try {
        capture = await composition.capture(snapshotId);
      } catch (error) {
        result.status = 'failed';
        result.code = error instanceof RecoveryError ? error.code : 'COMPONENT_FAILED';
        result.failureCodes = [result.code];
        result.degradedReason = sanitizeText(error instanceof Error ? error.message : 'checkpoint capture failed', [[composition.dataDir, '<dataRoot>'], [composition.stagingRoot, '<staging>']]);
        result.durationMs = Date.now() - started;
        this.report(result);
        return result;
      }
      result.status = capture.status;
      result.code = capture.status === 'ready' ? null : (capture.failure.code ?? null);
      result.failureCodes = capture.status === 'ready' ? [] : [capture.failure.code];
      result.degradedReason = capture.status === 'ready'
        ? (availability.expectedReady ? null : 'Capture is ready for its component snapshot vector; host components marked unavailable remain outside this bundle')
        : sanitizeText(capture.failure.message, [[composition.dataDir, '<dataRoot>'], [composition.stagingRoot, '<staging>']]);
      if (capture.status !== 'ready' && result.failureCodes.length === 0) result.failureCodes = ['COMPONENT_FAILED'];
      const summary = await summarizeCaptureResult(capture);
      result.bundleStatus = summary.bundleStatus;
      result.manifestSha256 = summary.manifestSha256;
      result.captureTime = summary.captureTime;
      result.componentStates = summary.componentStates;
      result.generation = { ...composition.generation };
      result.durationMs = Date.now() - started;
      signal?.throwIfAborted();
      this.report(result);
      return result;
    } catch (error) {
      if (error instanceof RecoveryError || signal?.aborted) throw error;
      result.status = 'failed';
      result.code = 'COMPONENT_FAILED';
      result.failureCodes = [result.code];
      result.degradedReason = sanitizeText(error instanceof Error ? error.message : 'checkpoint command failed', [[composition.dataDir, '<dataRoot>'], [composition.stagingRoot, '<staging>']]);
      result.durationMs = Date.now() - started;
      this.report(result);
      return result;
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Owner-only read-only availability probe
 * ---------------------------------------------------------------------------------------------- */

export interface RuntimeCheckpointProbeDeps {
  /** Trusted closure that performs the read-only probe; never captures. */
  probe(): CheckpointProbeResult | Promise<CheckpointProbeResult>;
  isOpen(): boolean;
  isPaused(): boolean;
  /** Receipt sink; the Runtime stores this under snapshot().diagnostics.checkpointProbe. */
  onReceipt?(receipt: CheckpointProbeResult): void;
  now?(): Date;
}

const PROBE_ACTION = 'runtime.checkpoint.probe';

const readProbeRequest = (input: unknown): void => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Expected a checkpoint probe command object');
  }
  const value = input as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
    throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Checkpoint probe command must contain plain data fields');
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'action') throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Checkpoint probe accepts exactly one field: action');
  if (value.action !== PROBE_ACTION) throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Unsupported checkpoint probe action');
};

/**
 * Strict owner-only `runtime.checkpoint.probe` handler. Read-only and
 * idempotent: it never captures, writes files, calls a resolver or changes
 * pause state. Its validated receipt is the only output; the Runtime stores it
 * in `snapshot().diagnostics.checkpointProbe`.
 */
export class RuntimeCheckpointProbeCommand {
  private lastReceipt?: CheckpointProbeResult;
  constructor(private readonly deps: RuntimeCheckpointProbeDeps) {}

  private now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }

  async handle(input: unknown, signal?: AbortSignal): Promise<CheckpointProbeResult> {
    if (!this.deps.isOpen()) throw new RecoveryError('CHECKPOINT_INPUT_INVALID', 'Runtime is not open');
    signal?.throwIfAborted();
    readProbeRequest(input);
    const receipt = await this.deps.probe();
    signal?.throwIfAborted();
    const validation = validateCheckpointProbeResult(receipt);
    if (!validation.ok) {
      const first = validation.violations[0];
      throw new RecoveryError('CHECKPOINT_PROBE_INVALID', `Probe receipt failed validation at ${first?.path ?? '$'}: ${first?.message ?? 'unknown violation'}`);
    }
    this.lastReceipt = structuredClone(receipt);
    try { this.deps.onReceipt?.(structuredClone(receipt)); } catch { /* a diagnostics sink failure never changes the probe receipt */ }
    return receipt;
  }

  /** Latest validated receipt (diagnostics helper; no I/O). */
  receipt(): CheckpointProbeResult | undefined {
    return this.lastReceipt ? structuredClone(this.lastReceipt) : undefined;
  }
}
