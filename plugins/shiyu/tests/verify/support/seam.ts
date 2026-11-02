/**
 * Dynamic resolution of the H1 behaviour seam.
 *
 * The DSH handover explicitly allows the implementer to change interface names
 * while preserving behaviour targets (03 §4.4). This resolver therefore binds
 * to whatever public cold-history entry point the product currently exports
 * (snapshot form preferred, inbox-array compatibility form accepted) and
 * reports an INTERFACE-BLOCKED case (never a pass) when no public seam exists.
 */
import type { DshContext } from '../../../src/adapters/dsh/sessions.js';
import { normalizeColdResult, type NormalizedColdResult } from './independent.js';
import { worldContext, type NativeWorld } from './world.js';

export interface ColdSeam {
  module: Record<string, any>;
  exportNames: string[];
  functionName: string;
  fn: (...args: any[]) => any;
  limits: Record<string, number> | undefined;
  rawLimits: unknown;
  /** The function declares enough parameters for an options fifth argument. */
  acceptsOptions: boolean;
}

const COLD_CANDIDATES = [
  'coldNativeInboxSnapshot',
  'coldNativeInbox',
  'readNativeColdInbox',
  'nativeColdInbox',
  'coldNativeHistory',
  'readNativeHistory',
  'inspectNativeColdInbox',
  'assertNativeColdInboxCurrent',
];

const LIMIT_CANDIDATES = ['NATIVE_HISTORY_LIMITS', 'nativeHistoryLimits', 'NATIVE_COLD_HISTORY_LIMITS', 'HISTORY_LIMITS', 'NATIVE_HISTORY_LIMIT'];

export async function loadColdSeam(): Promise<ColdSeam> {
  const module = await import('../../../src/adapters/dsh/native-context.js') as unknown as Record<string, any>;
  const exportNames = Object.keys(module).sort();
  const functionName = COLD_CANDIDATES.find(name => typeof module[name] === 'function')
    ?? exportNames.find(name => typeof module[name] === 'function' && /cold.*inbox|inbox.*cold|cold.*history|history.*cold/i.test(name));
  if (!functionName) throw new Error(`INTERFACE-BLOCKED: no public cold-history entry point in native-context.ts (exports: ${exportNames.join(', ')})`);
  const fn = module[functionName] as (...args: any[]) => any;
  let rawLimits: unknown;
  let limitsName: string | undefined;
  for (const name of LIMIT_CANDIDATES) if (module[name] !== undefined) { rawLimits = module[name]; limitsName = name; break; }
  if (rawLimits === undefined) {
    for (const name of exportNames) {
      const value = module[name];
      if (value && typeof value === 'object' && !Array.isArray(value)
        && ['pageEvents', 'pageSize', 'maxEvents', 'maxReads', 'timeoutMs', 'maxBytes'].some(key => typeof value[key] === 'number')) {
        rawLimits = value; limitsName = name; break;
      }
    }
  }
  const limits: Record<string, number> | undefined = rawLimits && typeof rawLimits === 'object'
    ? Object.fromEntries(Object.entries(rawLimits as Record<string, unknown>).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)) as [string, number][])
    : undefined;
  return {
    module, exportNames, functionName, fn, limits, rawLimits,
    acceptsOptions: fn.length >= 5,
  };
}

export interface SeamOutcome {
  result?: unknown;
  error?: unknown;
  elapsedMs: number;
  normalized?: NormalizedColdResult;
  normalizeError?: unknown;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Only forwarded when the resolved seam advertises an options parameter. */
  options?: Record<string, unknown>;
  sessionId?: string;
  preset?: string;
}

export function coldContext(world: NativeWorld, options?: Parameters<typeof worldContext>[1]): DshContext {
  return worldContext(world, options) as unknown as DshContext;
}

export async function callCold(seam: ColdSeam, world: NativeWorld, call: CallOptions = {}, context = coldContext(world)): Promise<SeamOutcome> {
  const started = performance.now();
  const args: unknown[] = [context, call.sessionId ?? world.sessionId, call.preset ?? String(world.header.agentPreset), call.signal];
  // Passing the documented options object as the fifth argument is safe for a
  // compatibility signature (extra arguments are ignored) and prevents the
  // verifier from silently not exercising a behaviour target such as
  // expectedPrefix/liveSession.
  if (call.options !== undefined) args.push(call.options);
  try {
    const result = await seam.fn(...args);
    const outcome: SeamOutcome = { result, elapsedMs: performance.now() - started };
    try { outcome.normalized = normalizeColdResult(result); } catch (error) { outcome.normalizeError = error; }
    return outcome;
  } catch (error) {
    return { error, elapsedMs: performance.now() - started };
  }
}

/** Preferred limits, resolved by semantic key aliases over whatever the seam exports. */
export function resolveLimits(limits: Record<string, number> | undefined): {
  pageEvents?: number; maxEvents?: number; maxBytes?: number; maxReads?: number; timeoutMs?: number; raw?: Record<string, number>;
} {
  if (!limits) return {};
  const pick = (...names: string[]) => { for (const name of names) if (typeof limits[name] === 'number') return limits[name]; return undefined; };
  return {
    pageEvents: pick('pageEvents', 'pageSize', 'page', 'eventsPerPage', 'pageLimit'),
    maxEvents: pick('maxEvents', 'maxHistoryEvents', 'events', 'historyEvents', 'maxEventCount'),
    maxBytes: pick('maxBytes', 'bytes', 'historyBytes', 'maxHistoryBytes'),
    maxReads: pick('maxReads', 'reads', 'maxPageReads', 'readLimit'),
    timeoutMs: pick('timeoutMs', 'timeout', 'deadlineMs', 'recoveryTimeoutMs'),
    raw: limits,
  };
}
