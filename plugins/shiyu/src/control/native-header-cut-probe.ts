import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { defaultModel, type DshAgentHandle, type DshContext } from '../adapters/dsh/sessions.js';
import { nativeMessageHash } from '../adapters/dsh/native-message.js';
import { assertNativeLiveHistory, coldNativeInboxSnapshot, nativeHeaderFieldDiff, nativeInboxReferences,
  NativeHistoryError, type NativeHistoryDiagnostic } from '../adapters/dsh/native-context.js';

export const NATIVE_HEADER_CUT_PROBE_TOOL = 'shiyu_diagnose_native_header_cut';
export const NATIVE_HEADER_CUT_RECEIPT_MAX_BYTES = 24 * 1024;
export const NATIVE_HEADER_CUT_PROBE_TIMEOUT_MS = 30_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const prefix = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{16,}$/i.test(value) ? value.slice(0, 16) : '';

export class NativeHeaderCutProbeError extends Error {
  constructor(readonly code: 'NATIVE_HEADER_CUT_PAUSED' | 'NATIVE_HEADER_CUT_BUSY' | 'NATIVE_HEADER_CUT_CAPACITY'
    | 'NATIVE_HEADER_CUT_INVALID' | 'NATIVE_HEADER_CUT_UNAVAILABLE', message: string) {
    super(message); this.name = 'NativeHeaderCutProbeError';
  }
}
/** Pure owner-command admission helper: paused rejects, the single probe slot is
 * exclusive and the generic runtime capacity is respected. No retries. */
export function assertNativeHeaderCutAdmission(state: { paused: boolean; operations: number; capacity: number; sameActionRunning: boolean }): void {
  if (state.paused) throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_PAUSED', 'Native header-cut probe requires an unpaused runtime');
  if (state.sameActionRunning) throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_BUSY', 'Native header-cut probe is already running');
  if (!Number.isSafeInteger(state.operations) || state.operations < 0 || state.capacity < 1 || state.operations >= state.capacity) {
    throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_CAPACITY', 'Native header-cut probe requires an idle runtime slot');
  }
}

export type NativeHeaderCutProbeStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';
export interface NativeHeaderCutProbeReceipt {
  schemaVersion: 1;
  kind: 'native-header-cut-probe';
  toolName: typeof NATIVE_HEADER_CUT_PROBE_TOOL;
  zeroModel: true; zeroEmbedding: true; zeroTaskOrEffect: true; createdGoal: false;
  status: NativeHeaderCutProbeStatus;
  startedAt: string; completedAt: string; durationMs: number;
  createdSessionId?: string;
  cold?: { eventCount: number; inheritedEventCount: number; headerHashPrefix: string };
  live?: { eventCount: number; seq: number; inheritedEventCount: number; headerHashPrefix: string };
  matched: boolean;
  headerDiff: string[];
  mismatchKind?: string;
  checks: string[];
  released: boolean; disposed: boolean; archived: boolean;
  cleanup: { ok: boolean; failures: string[] };
  error?: { code: string; message: string };
}
export interface NativeHeaderCutProbeOptions {
  ctx: DshContext;
  /** Absolute cwd used for the bare lifecycle Session meta (same shape as Goal Sessions). */
  cwd: string;
  /** Agent preset used by the managed core Goal Sessions. */
  preset: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  now?: () => number;
}
/** Bounded controlled probe error text: codes only; no native body/path. */
function probeError(error: unknown): { code: string; message: string } {
  const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'NATIVE_HEADER_CUT_PROBE_ERROR';
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
  return { code: /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'NATIVE_HEADER_CUT_PROBE_ERROR', message };
}
function iso(epochMs: number): string { return new Date(epochMs).toISOString(); }

/**
 * Owner-only ZERO-MODEL diagnostic for the cold-versus-live Session header cut:
 * creates exactly one bare lifecycle Session (managed core Goal preset/cwd/meta,
 * no event tools, no Goal/Task/Effect/budget, model requests rejected, empty
 * inbox), flushes it, cold-reads the persisted cut and compares the cold header
 * with the live `session.header` field by field (hash prefixes / value
 * categories only). It never writes the business store, never calls a model or
 * embedding and never creates a Goal. The probe Session is always cancelled,
 * disposed and archived; the bounded receipt is validated even on failure.
 */
export async function probeNativeHeaderCut(options: NativeHeaderCutProbeOptions): Promise<NativeHeaderCutProbeReceipt> {
  if (!options || typeof options !== 'object') throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_INVALID', 'Invalid native header-cut probe options');
  const { ctx } = options;
  if (!ctx || typeof ctx.agents?.create !== 'function' || typeof ctx.get !== 'function') throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_UNAVAILABLE', 'Native agent services are unavailable');
  if (typeof options.preset !== 'string' || !options.preset.trim()) throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_INVALID', 'A fixed managed preset is required');
  if (typeof options.cwd !== 'string' || !isAbsolute(options.cwd)) throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_INVALID', 'An absolute probe cwd is required');
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const deadline = options.deadlineAtMs === undefined ? startedAtMs + NATIVE_HEADER_CUT_PROBE_TIMEOUT_MS : Math.min(options.deadlineAtMs, startedAtMs + NATIVE_HEADER_CUT_PROBE_TIMEOUT_MS);
  if (!Number.isSafeInteger(options.deadlineAtMs ?? 0)) throw new NativeHeaderCutProbeError('NATIVE_HEADER_CUT_INVALID', 'Invalid probe deadline');
  const signal = options.signal;
  const checks: string[] = [];
  const cleanupFailures: string[] = [];
  let status: NativeHeaderCutProbeStatus = 'completed';
  let createdSessionId: string | undefined;
  let handle: DshAgentHandle | undefined;
  let released = false, disposed = false, archived = false;
  let cold: NativeHeaderCutProbeReceipt['cold'];
  let live: NativeHeaderCutProbeReceipt['live'];
  let matched = false;
  let headerDiff: string[] = [];
  let mismatchKind: string | undefined;
  let failure: { code: string; message: string } | undefined;
  const remaining = () => deadline - now();
  try {
    if (signal?.aborted) { status = 'cancelled'; checks.push('caller-aborted-before-create'); throw Object.assign(new Error('Native header-cut probe cancelled'), { code: 'NATIVE_HISTORY_CANCELLED' }); }
    if (remaining() <= 0) { status = 'timeout'; checks.push('deadline-before-create'); throw Object.assign(new Error('Native header-cut probe deadline exceeded'), { code: 'NATIVE_HISTORY_DEADLINE' }); }
    const sessions = ctx.get('sessions');
    if (typeof sessions?.flush !== 'function') throw new Error('Native Session flush service is required');
    createdSessionId = `shiyu-native-header-cut-${randomUUID()}`;
    checks.push('creating-bare-lifecycle-session');
    handle = await ctx.agents.create({
      sessionId: createdSessionId,
      ...(signal ? { signal } : {}),
      agentOptions: { ...defaultModel('core'), maxTokens: 1 },
      meta: { cwd: options.cwd, agentPreset: options.preset },
      setup: (agentCtx, agent) => {
        // No tools and no model turn: the probe Session is only flushed/read.
        agentCtx.tools.guard(() => 'Native header-cut probe Session cannot execute tools.');
        agentCtx.on('agent/pre-step', async () => ({ kind: 'reject' }));
        if (agent.id !== createdSessionId || agent.session.header.agentPreset !== options.preset) throw new Error('Native header-cut probe Session identity mismatch');
      },
    });
    checks.push('created');
    if (nativeInboxReferences(handle.agent.inbox).length) throw new Error('Native header-cut probe Session inbox is not empty');
    checks.push('empty-inbox');
    if (await sessions.flush(handle.agent.session) !== true) throw new Error('Native Session durability listener did not handle the probe flush');
    checks.push('flushed');
    if (signal?.aborted) { status = 'cancelled'; throw Object.assign(new Error('Native header-cut probe cancelled'), { code: 'NATIVE_HISTORY_CANCELLED' }); }
    if (remaining() <= 0) { status = 'timeout'; throw Object.assign(new Error('Native header-cut probe deadline exceeded'), { code: 'NATIVE_HISTORY_DEADLINE' }); }
    const snapshot = await coldNativeInboxSnapshot(ctx, createdSessionId, options.preset, signal, { deadlineAtMs: deadline });
    checks.push('cold-observed');
    const liveHeaderHash = nativeMessageHash(handle.agent.session.header);
    cold = { eventCount: snapshot.eventCount, inheritedEventCount: snapshot.inheritedEventCount, headerHashPrefix: prefix(snapshot.headerHash) };
    live = { eventCount: Number(handle.agent.session.seq), seq: Number(handle.agent.session.seq),
      inheritedEventCount: Number(handle.agent.session.inheritedEventCount), headerHashPrefix: prefix(liveHeaderHash) };
    headerDiff = nativeHeaderFieldDiff(snapshot.headerFacts, handle.agent.session.header).slice(0, 12);
    try {
      assertNativeLiveHistory(ctx, handle.agent.session, snapshot, handle.agent.inbox, { liveCut: 'seq-excluding-header' });
      matched = cold.headerHashPrefix === live.headerHashPrefix && cold.eventCount - (snapshot.headerEventCount ?? 0) === live.seq
        && cold.inheritedEventCount === live.inheritedEventCount;
      checks.push(matched ? 'cold-live-header-cut-matched' : 'cold-live-header-cut-mismatched');
    } catch (error) {
      if (!(error instanceof NativeHistoryError)) throw error;
      matched = false;
      mismatchKind = error.historyDiagnostic?.mismatchKind ?? 'unknown';
      const diagnostic: NativeHistoryDiagnostic | undefined = error.historyDiagnostic;
      if (!headerDiff.length && diagnostic?.headerDiff?.length) headerDiff = diagnostic.headerDiff.slice(0, 12);
      checks.push('cold-live-header-cut-mismatched');
    }
  } catch (error) {
    failure = probeError(error);
    if (status === 'completed') status = failure.code === 'NATIVE_HISTORY_CANCELLED' ? 'cancelled' : failure.code === 'NATIVE_HISTORY_DEADLINE' ? 'timeout' : 'failed';
    checks.push(`failed:${status}`);
  } finally {
    if (handle) {
      try {
        handle.agent.cancel({ kind: 'hook', reason: 'Native header-cut probe finished' }, { keepInbox: true });
        released = true; checks.push('released');
      } catch (error) { cleanupFailures.push(`release:${probeError(error).code}`); }
      try { await handle.dispose(); disposed = true; checks.push('disposed'); }
      catch (error) { cleanupFailures.push(`dispose:${probeError(error).code}`); }
      try {
        const workspace = ctx.get('workspaceRegistry');
        if (typeof workspace?.archiveSession !== 'function') throw new Error('Native Session archive service is required');
        await workspace.archiveSession(handle.agent.session.id);
        archived = true; checks.push('archived');
      } catch (error) { cleanupFailures.push(`archive:${probeError(error).code}`); }
    }
  }
  const completedAtMs = Math.max(now(), startedAtMs);
  const receipt: NativeHeaderCutProbeReceipt = {
    schemaVersion: 1, kind: 'native-header-cut-probe', toolName: NATIVE_HEADER_CUT_PROBE_TOOL,
    zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true, createdGoal: false, status,
    startedAt: iso(startedAtMs), completedAt: iso(completedAtMs), durationMs: Math.max(0, completedAtMs - startedAtMs),
    ...(createdSessionId ? { createdSessionId } : {}),
    ...(cold ? { cold } : {}), ...(live ? { live } : {}),
    matched, headerDiff, ...(mismatchKind ? { mismatchKind } : {}), checks: checks.slice(0, 32),
    released, disposed, archived, cleanup: { ok: cleanupFailures.length === 0, failures: cleanupFailures.slice(0, 8) },
    ...(failure ? { error: failure } : {}),
  };
  assertNativeHeaderCutProbeReceipt(receipt);
  return receipt;
}

const DIFF_ENTRY = /^[A-Za-z][A-Za-z0-9_]{0,39}: (absent|boolean:(true|false)|number:[0-9-]{1,20}|string-sha:[a-f0-9]{8}|string:other|object|array|null|other)→(absent|boolean:(true|false)|number:[0-9-]{1,20}|string-sha:[a-f0-9]{8}|string:other|object|array|null|other)$/;
const HASH_PREFIX = /^[a-f0-9]{0,16}$/;
/** Independent strict validator: plain lossless JSON, bounded size <=24KiB,
 * controlled hash prefixes / headerDiff categories only (no path/body text). */
export function assertNativeHeaderCutProbeReceipt(value: unknown): asserts value is NativeHeaderCutProbeReceipt {
  const lossless = (item: unknown, depth: number): void => {
    if (depth > 8) throw new Error('Native header-cut receipt is too deep');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('Native header-cut receipt contains a non-finite number'); return; }
    if (typeof item === 'string') { if (item.length > 240) throw new Error('Native header-cut receipt contains an oversized string'); return; }
    if (Array.isArray(item)) { if (item.length > 64) throw new Error('Native header-cut receipt array is too long'); for (const entry of item) lossless(entry, depth + 1); return; }
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Native header-cut receipt is not lossless JSON');
    for (const entry of Object.values(item)) lossless(entry, depth + 1);
  };
  lossless(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > NATIVE_HEADER_CUT_RECEIPT_MAX_BYTES) throw new Error('Native header-cut receipt exceeds its bounded size');
  if (JSON.stringify(JSON.parse(encoded)) !== encoded) throw new Error('Native header-cut receipt is not lossless');
  const receipt = value as NativeHeaderCutProbeReceipt;
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'native-header-cut-probe' || receipt.toolName !== NATIVE_HEADER_CUT_PROBE_TOOL) throw new Error('Native header-cut receipt header is invalid');
  if (receipt.zeroModel !== true || receipt.zeroEmbedding !== true || receipt.zeroTaskOrEffect !== true || receipt.createdGoal !== false) throw new Error('Native header-cut receipt cannot claim non-zero effects');
  if (!['completed', 'failed', 'cancelled', 'timeout'].includes(receipt.status)) throw new Error('Native header-cut status is invalid');
  for (const field of ['startedAt', 'completedAt'] as const) {
    if (typeof receipt[field] !== 'string' || new Date(receipt[field]).toISOString() !== receipt[field]) throw new Error(`Native header-cut ${field} is not canonical UTC`);
  }
  if (!Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0) throw new Error('Native header-cut duration is invalid');
  if (receipt.createdSessionId !== undefined && (typeof receipt.createdSessionId !== 'string' || receipt.createdSessionId.length > 120)) throw new Error('Native header-cut Session id is invalid');
  if (receipt.cold !== undefined) {
    if (!Number.isSafeInteger(receipt.cold.eventCount) || !Number.isSafeInteger(receipt.cold.inheritedEventCount)
      || !HASH_PREFIX.test(receipt.cold.headerHashPrefix)) throw new Error('Native header-cut cold facts are malformed');
  }
  if (receipt.live !== undefined) {
    if (!Number.isSafeInteger(receipt.live.eventCount) || !Number.isSafeInteger(receipt.live.seq)
      || !Number.isSafeInteger(receipt.live.inheritedEventCount) || !HASH_PREFIX.test(receipt.live.headerHashPrefix)) {
      throw new Error('Native header-cut live facts are malformed');
    }
  }
  if (typeof receipt.matched !== 'boolean' || !Array.isArray(receipt.headerDiff) || receipt.headerDiff.length > 12) throw new Error('Native header-cut match facts are malformed');
  if (receipt.headerDiff.some(entry => typeof entry !== 'string' || entry.length > 80 || !DIFF_ENTRY.test(entry))) throw new Error('Native header-cut headerDiff is not a controlled field/category diff');
  if (receipt.headerDiff.join('\n').length > 300) throw new Error('Native header-cut headerDiff exceeds its bounded size');
  if (!Array.isArray(receipt.checks) || receipt.checks.length > 32 || receipt.checks.some(entry => typeof entry !== 'string' || !/^[a-z][a-z0-9:_-]{0,63}$/.test(entry))) {
    throw new Error('Native header-cut checks are invalid');
  }
  if (typeof receipt.released !== 'boolean' || typeof receipt.disposed !== 'boolean' || typeof receipt.archived !== 'boolean'
    || !receipt.cleanup || typeof receipt.cleanup.ok !== 'boolean' || !Array.isArray(receipt.cleanup.failures)
    || receipt.cleanup.failures.length > 8 || receipt.cleanup.failures.some(entry => typeof entry !== 'string' || !/^[a-z]+:[A-Z][A-Z0-9_]{0,99}$/.test(entry))) {
    throw new Error('Native header-cut cleanup facts are invalid');
  }
  if (receipt.status === 'failed' && receipt.error === undefined) throw new Error('A failed native header-cut receipt must keep its controlled error');
  if (receipt.error !== undefined && (typeof receipt.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(receipt.error.code)
    || typeof receipt.error.message !== 'string' || receipt.error.message.length > 160)) throw new Error('Native header-cut error is invalid');
}
