/**
 * H5b checkpoint availability probe (read-only diagnostics).
 *
 * This module exists so a host can prove, with a zero-model owner command,
 * which parts of the checkpoint pipeline are actually available **without**
 * capturing anything. Guarantees enforced by construction and asserted by the
 * tests:
 *  - no capture service is imported or called;
 *  - no file is created, written or deleted (only lstat/readdir reads);
 *  - an injected Session-log resolver is only presence-checked, never invoked;
 *  - no native Session content, live control write handle or staging directory
 *    is touched beyond ordinary read-only metadata;
 *  - the returned `paused` value is an observation; this module never changes
 *    pause state and never dispatches work.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  HOST_GOAL_SESSION_REQUIRED_SCOPE,
  HOST_MEMORY_REQUIRED_SCOPE,
} from './host-ports.js';
import {
  CHECKPOINT_PROBE_SCHEMA_VERSION,
  type CheckpointProbeBlocker,
  type CheckpointProbeComponent,
  type CheckpointProbeComponentId,
  type CheckpointProbeComponentStatus,
  type CheckpointProbeGoalBindings,
  type CheckpointProbeResult,
  type CheckpointProbeStaging,
} from './types.js';

export interface CheckpointProbeControlStore {
  request(command: string, args?: unknown): Promise<unknown>;
}

export interface CheckpointProbeGoalSeams {
  /** Presence only: a public read-only native Goal state reader is injected. */
  nativeState?: boolean;
  /** Presence only: an acknowledged Session flush is injected. */
  flush?: boolean;
  /** Presence only: a projection definition/configuration export is injected. */
  projection?: boolean;
}

export interface CheckpointProbeOptions {
  /** Trusted checkpoint staging root; undefined/empty means "not configured". Never created. */
  stagingRoot?: string;
  /** Optional trusted allow-list for the staging root. */
  allowedStagingRoots?: readonly string[];
  /** Live data root; used only for path-overlap rules, never opened as a database. */
  dataDir?: string;
  /** Current pause state, observed read-only. */
  paused?: boolean;
  /** Existing ControlStore seam used for read-only GoalBinding enumeration. */
  controlStore?: CheckpointProbeControlStore;
  ownerId?: string;
  scope?: string;
  /** Pre-computed GoalBinding rows (alternative to controlStore for tests/compositions). */
  goalBindings?: readonly unknown[];
  /** Alternative read-only GoalBinding source. */
  goalBindingSource?: { list(ownerId: string, scope: string): Promise<readonly unknown[]> };
  /**
   * Presence-only Session-log resolver marker. The value is never inspected
   * beyond "defined" and its resolve method is never called.
   */
  sessionLogResolver?: unknown;
  /** Goal Session seam presence flags (defaults: none injected). */
  goalSeams?: CheckpointProbeGoalSeams;
  /**
   * Memory export availability. Production passes nothing, which reports
   * MEMORY_EXPORT_UNAVAILABLE. Tests may inject an explicit availability value.
   */
  memoryExport?: boolean | { available: boolean; reasonCode?: string; detail?: string; requiredScope?: string[] };
  /** Workspace root to check for readability; defaults to dataDir/workspaces when dataDir is set. */
  workspaceRoot?: string;
  /** Bounded directory listing count (read-only). */
  maxWorkspaceEntries?: number;
  now?: () => Date;
}

const COMPONENT_IDS: readonly CheckpointProbeComponentId[] = [
  'staging', 'control', 'dsh-goal-sessions', 'memory', 'shared-objects',
] as const;

const reason = (code: string | null, detail: string, requiredScope: string[] = []): CheckpointProbeComponent => ({
  id: 'staging',
  status: 'unavailable',
  reasonCode: code,
  requiredScope,
  detail,
});

const component = (
  id: CheckpointProbeComponentId,
  status: CheckpointProbeComponentStatus,
  reasonCode: string | null,
  detail: string,
  requiredScope: string[] = [],
): CheckpointProbeComponent => ({ id, status, reasonCode, requiredScope, detail });

const nowIso = (now?: () => Date): string => (now?.() ?? new Date()).toISOString();

const sanitize = (message: string): string => message
  .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp)\/[^\s'")]+/g, '<path>')
  .slice(0, 300);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const INSIDE = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${path.sep}`);

interface ParsedBindings {
  total: number;
  active: number;
}

/**
 * A binding is "active" when it has a native GoalRef or an unresolved command
 * receipt; the probe cannot read native phase without a session API, so this is
 * deliberately conservative (never under-counts).
 */
const parseGoalBindings = (rows: readonly unknown[]): ParsedBindings => {
  let active = 0;
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const goalRef = row.goalRef;
    const hasGoalRef = isPlainObject(goalRef) && typeof goalRef.id === 'string' && typeof goalRef.revision === 'number';
    const receipt = isPlainObject(row.receipt) ? row.receipt : undefined;
    const unresolved = receipt !== undefined && (receipt.status === 'pending' || receipt.status === 'unknown');
    if (hasGoalRef || unresolved) active += 1;
  }
  return { total: rows.length, active };
};

const readGoalBindings = async (options: CheckpointProbeOptions): Promise<
  { ok: true; bindings: ParsedBindings; source: 'controlStore' | 'injected' } | { ok: false; detail: string }
> => {
  if (options.goalBindings !== undefined) {
    if (!Array.isArray(options.goalBindings)) return { ok: false, detail: 'Injected GoalBinding rows are not an array' };
    return { ok: true, bindings: parseGoalBindings(options.goalBindings), source: 'injected' };
  }
  if (options.goalBindingSource !== undefined) {
    try {
      const rows = await options.goalBindingSource.list(options.ownerId ?? 'local-owner', options.scope ?? 'local-owner');
      if (!Array.isArray(rows)) return { ok: false, detail: 'Injected GoalBinding source did not return an array' };
      return { ok: true, bindings: parseGoalBindings(rows), source: 'injected' };
    } catch (error) {
      return { ok: false, detail: sanitize(error instanceof Error ? error.message : 'GoalBinding source failed') };
    }
  }
  if (options.controlStore !== undefined) {
    try {
      const rows = await options.controlStore.request('goal.binding.list', {
        ownerId: options.ownerId ?? 'local-owner',
        scope: options.scope ?? 'local-owner',
      });
      if (!Array.isArray(rows)) return { ok: false, detail: 'ControlStore goal.binding.list did not return an array' };
      return { ok: true, bindings: parseGoalBindings(rows), source: 'controlStore' };
    } catch (error) {
      return { ok: false, detail: sanitize(error instanceof Error ? error.message : 'ControlStore goal enumeration failed') };
    }
  }
  return { ok: false, detail: 'No read-only GoalBinding source is injected (controlStore / goalBindingSource / goalBindings)' };
};

const probeStaging = async (options: CheckpointProbeOptions): Promise<{ result: CheckpointProbeStaging; component: CheckpointProbeComponent }> => {
  const stagingRoot = options.stagingRoot;
  if (stagingRoot === undefined || stagingRoot === null || (typeof stagingRoot === 'string' && stagingRoot.trim() === '')) {
    const result: CheckpointProbeStaging = { configured: false, exists: null, withinLiveRoot: null, detail: 'No trusted checkpoint staging root is configured' };
    return { result, component: component('staging', 'unconfigured', 'CHECKPOINT_STAGING_UNCONFIGURED', result.detail, ['trusted checkpoint staging root outside the live data root']) };
  }
  if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot)) {
    const result: CheckpointProbeStaging = { configured: false, exists: null, withinLiveRoot: null, detail: 'Configured staging root is not an absolute path' };
    return { result, component: component('staging', 'unavailable', 'CHECKPOINT_STAGING_UNCONFIGURED', result.detail, ['trusted absolute checkpoint staging root outside the live data root']) };
  }
  const resolvedStaging = path.resolve(stagingRoot);
  let withinLiveRoot: boolean | null = null;
  if (options.dataDir !== undefined) {
    if (!path.isAbsolute(options.dataDir)) {
      const result: CheckpointProbeStaging = { configured: true, exists: null, withinLiveRoot: null, detail: 'Live data root probe input is not an absolute path' };
      return { result, component: component('staging', 'unavailable', 'CHECKPOINT_STAGING_UNCONFIGURED', result.detail, ['trusted absolute live data root']) };
    }
    const live = path.resolve(options.dataDir);
    withinLiveRoot = INSIDE(resolvedStaging, live) || INSIDE(live, resolvedStaging);
    if (withinLiveRoot) {
      const result: CheckpointProbeStaging = { configured: true, exists: null, withinLiveRoot: true, detail: 'Staging root overlaps the live data root' };
      return { result, component: component('staging', 'unavailable', 'LIVE_ROOT_PROTECTED', result.detail, ['staging root strictly outside the live data root']) };
    }
  }
  if (options.allowedStagingRoots !== undefined) {
    const allowed = options.allowedStagingRoots.some((root) => typeof root === 'string' && path.isAbsolute(root)
      && (resolvedStaging === path.resolve(root) || resolvedStaging.startsWith(`${path.resolve(root)}${path.sep}`)));
    if (!allowed) {
      const result: CheckpointProbeStaging = { configured: true, exists: null, withinLiveRoot, detail: 'Staging root is outside the approved staging roots' };
      return { result, component: component('staging', 'unavailable', 'TARGET_NOT_ISOLATED', result.detail, ['staging root inside an approved staging parent']) };
    }
  }
  // Metadata-only read; never create, open for write or list the staging tree.
  let exists: boolean | null = null;
  try {
    const info = await lstat(resolvedStaging);
    exists = info.isDirectory();
    if (info.isSymbolicLink() || !info.isDirectory()) {
      const result: CheckpointProbeStaging = { configured: true, exists, withinLiveRoot, detail: 'Configured staging root exists but is not a regular directory' };
      return { result, component: component('staging', 'unavailable', 'CHECKPOINT_STAGING_UNCONFIGURED', result.detail, ['regular staging directory outside the live data root']) };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const result: CheckpointProbeStaging = { configured: true, exists: null, withinLiveRoot, detail: sanitize(`Staging root metadata is unreadable: ${(error as Error).message}`) };
      return { result, component: component('staging', 'unavailable', 'CHECKPOINT_STAGING_UNCONFIGURED', result.detail, ['readable staging parent']) };
    }
    exists = false; // absent is fine: capture would create it, the probe never does.
  }
  const result: CheckpointProbeStaging = { configured: true, exists, withinLiveRoot, detail: 'Configured outside the live data root; probe performed read-only metadata checks only' };
  return { result, component: component('staging', 'available', null, result.detail) };
};

const probeWorkspace = async (
  options: CheckpointProbeOptions,
): Promise<{ component: CheckpointProbeComponent; readable: boolean; entries: number | null }> => {
  const root = options.workspaceRoot ?? (options.dataDir !== undefined ? path.join(options.dataDir, 'workspaces') : undefined);
  if (root === undefined) {
    return {
      component: component('shared-objects', 'unavailable', 'WORKSPACE_INVENTORY_UNAVAILABLE',
        'No workspace root is configured for the read-only inventory probe', ['readable {dataDir}/workspaces or an approved object-store root']),
      readable: false, entries: null,
    };
  }
  if (!path.isAbsolute(root)) {
    return {
      component: component('shared-objects', 'unavailable', 'WORKSPACE_INVENTORY_UNAVAILABLE',
        'Workspace root probe input is not an absolute path', ['absolute workspace root']),
      readable: false, entries: null,
    };
  }
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return {
        component: component('shared-objects', 'unavailable', 'WORKSPACE_INVENTORY_UNAVAILABLE',
          'Workspace root exists but is not a regular directory', ['regular workspace directory']),
        readable: false, entries: null,
      };
    }
    const limit = Math.max(1, Math.min(options.maxWorkspaceEntries ?? 200, 2000));
    const names = await readdir(root, { withFileTypes: true });
    return {
      component: component('shared-objects', 'available', null,
        `Workspace root is readable (bounded read-only listing; ${Math.min(names.length, limit)} entries observed, no hashing or capture)`),
      readable: true, entries: names.length,
    };
  } catch (error) {
    return {
      component: component('shared-objects', 'unavailable', 'WORKSPACE_INVENTORY_UNAVAILABLE',
        sanitize(`Workspace root is not readable: ${(error as Error).message}`), ['readable {dataDir}/workspaces or an approved object-store root']),
      readable: false, entries: null,
    };
  }
};

const memoryIndicator = (value: CheckpointProbeOptions['memoryExport']): { available: boolean; reasonCode: string | null; detail: string; requiredScope: string[] } => {
  if (value === undefined || value === false) {
    return {
      available: false, reasonCode: 'MEMORY_EXPORT_UNAVAILABLE',
      detail: 'The managed Ombre backend exposes no public export/archive tool in this deployment; a Bundle cannot be ready',
      requiredScope: [...HOST_MEMORY_REQUIRED_SCOPE],
    };
  }
  if (value === true) return { available: true, reasonCode: null, detail: 'Memory export port is injected (availability probe only; not invoked)', requiredScope: [] };
  const available = value.available === true;
  return {
    available,
    reasonCode: available ? null : (value.reasonCode ?? 'MEMORY_EXPORT_UNAVAILABLE'),
    detail: value.detail ?? (available ? 'Memory export port is injected (availability probe only; not invoked)' : 'Memory export is not available'),
    requiredScope: available ? [] : (value.requiredScope ?? [...HOST_MEMORY_REQUIRED_SCOPE]),
  };
};

/**
 * Read-only checkpoint availability probe. It never calls a resolver, capture
 * service or live session; only ControlStore read commands and filesystem
 * metadata reads are used.
 */
export const probeCheckpointAvailability = async (options: CheckpointProbeOptions = {}): Promise<CheckpointProbeResult> => {
  const observedAt = nowIso(options.now);
  const staging = await probeStaging(options);
  const workspace = await probeWorkspace(options);
  const bindings = await readGoalBindings(options);
  const memory = memoryIndicator(options.memoryExport);

  const components: CheckpointProbeComponent[] = [staging.component];

  let goalBindings: CheckpointProbeGoalBindings;
  if (!bindings.ok) {
    components.push(component('control', 'unavailable', 'CONTROL_FACTS_UNAVAILABLE',
      `Read-only GoalBinding enumeration failed: ${bindings.detail}`, ['read-only ControlStore goal.binding.list or an injected equivalent']));
    goalBindings = { source: 'unavailable', total: null, active: null, detail: bindings.detail };
    components.push(component('dsh-goal-sessions', 'unavailable', 'GOAL_SESSION_EXPORT_UNAVAILABLE',
      'Active Goal bindings cannot be enumerated, so Goal Session export cannot be assessed', [...HOST_GOAL_SESSION_REQUIRED_SCOPE]));
  } else {
    components.push(component('control', 'available', null,
      `Read-only GoalBinding enumeration succeeded via ${bindings.source}; live control database was not opened`));
    goalBindings = {
      source: bindings.source, total: bindings.bindings.total, active: bindings.bindings.active,
      detail: `${bindings.bindings.active} active of ${bindings.bindings.total} bindings (conservative: native GoalRef or unresolved receipt)`,
    };
    if (bindings.bindings.active === 0) {
      components.push(component('dsh-goal-sessions', 'available', null,
        'No active GoalBinding requires a Goal Session log in this probe; resolver was not invoked'));
    } else {
      const resolverPresent = options.sessionLogResolver !== undefined && options.sessionLogResolver !== null;
      const seams = options.goalSeams ?? {};
      const missing: string[] = [];
      if (!resolverPresent) missing.push('injected exact Session log path resolver');
      if (seams.nativeState !== true) missing.push('read-only native Goal state reader');
      if (seams.flush !== true) missing.push('acknowledged Session flush');
      if (seams.projection !== true) missing.push('projection definition/configuration export');
      if (missing.length === 0) {
        components.push(component('dsh-goal-sessions', 'available', null,
          `Injected Goal Session seams are present for ${bindings.bindings.active} active binding(s); resolver presence-checked only, never invoked`));
      } else {
        components.push(component('dsh-goal-sessions', 'unavailable', 'GOAL_SESSION_EXPORT_UNAVAILABLE',
          `Missing host capabilities: ${missing.join('; ')}`, [...HOST_GOAL_SESSION_REQUIRED_SCOPE]));
      }
    }
  }

  components.push(memory.available
    ? component('memory', 'available', null, memory.detail)
    : component('memory', 'unavailable', memory.reasonCode ?? 'MEMORY_EXPORT_UNAVAILABLE', memory.detail, memory.requiredScope));
  components.push(workspace.component);

  // Keep the declared order stable regardless of evaluation order.
  components.sort((a, b) => COMPONENT_IDS.indexOf(a.id) - COMPONENT_IDS.indexOf(b.id));
  const blockers: CheckpointProbeBlocker[] = components
    .filter((item) => item.status !== 'available')
    .map((item) => ({ id: item.id, reasonCode: item.reasonCode ?? 'COMPONENT_UNAVAILABLE', requiredScope: [...item.requiredScope] }));

  return {
    schemaVersion: CHECKPOINT_PROBE_SCHEMA_VERSION,
    action: 'runtime.checkpoint.probe',
    observedAt,
    paused: options.paused === true,
    readOnly: true,
    captureAttempted: false,
    resolverInvoked: false,
    filesWritten: 0,
    ready: false,
    expectedReady: false,
    staging: staging.result,
    goalBindings,
    components,
    blockers,
  };
};

export interface CheckpointProbeViolation { code: string; path: string; message: string }
export interface CheckpointProbeValidation {
  ok: boolean;
  violations: CheckpointProbeViolation[];
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;
const STATUS: readonly CheckpointProbeComponentStatus[] = ['available', 'unavailable', 'unconfigured'];

/** Strict validator used by the owner command before storing a receipt. */
export const validateCheckpointProbeResult = (value: unknown): CheckpointProbeValidation => {
  const violations: CheckpointProbeViolation[] = [];
  const add = (code: string, at: string, message: string): void => { if (violations.length < 60) violations.push({ code, path: at, message }); };
  if (!isPlainObject(value)) return { ok: false, violations: [{ code: 'type', path: '$', message: 'expected a plain object' }] };
  const keys = ['schemaVersion', 'action', 'observedAt', 'paused', 'readOnly', 'captureAttempted', 'resolverInvoked', 'filesWritten',
    'ready', 'expectedReady', 'staging', 'goalBindings', 'components', 'blockers'];
  for (const key of Object.keys(value)) if (!keys.includes(key)) add('unknown-field', `$.${key}`, 'unknown field');
  for (const key of keys) if (!Object.hasOwn(value, key)) add('missing-field', `$.${key}`, 'required field is missing');
  if (value.schemaVersion !== CHECKPOINT_PROBE_SCHEMA_VERSION) add('version', '$.schemaVersion', 'unsupported probe schema');
  if (value.action !== 'runtime.checkpoint.probe') add('value', '$.action', 'unexpected action');
  if (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt as string).toISOString() !== value.observedAt) {
    add('format', '$.observedAt', 'observedAt must be canonical UTC');
  }
  if (typeof value.paused !== 'boolean') add('type', '$.paused', 'expected a boolean');
  if (value.readOnly !== true) add('value', '$.readOnly', 'probe must be read-only');
  if (value.captureAttempted !== false) add('value', '$.captureAttempted', 'probe must not capture');
  if (value.resolverInvoked !== false) add('value', '$.resolverInvoked', 'probe must not invoke the resolver');
  if (value.filesWritten !== 0) add('value', '$.filesWritten', 'probe must not write files');
  if (value.ready !== false) add('value', '$.ready', 'probe never claims a ready bundle');
  if (value.expectedReady !== false) add('value', '$.expectedReady', 'probe never claims expected-ready');
  if (isPlainObject(value.staging)) {
    for (const key of ['configured', 'exists', 'withinLiveRoot', 'detail']) if (!Object.hasOwn(value.staging, key)) add('missing-field', `$.staging.${key}`, 'required field is missing');
    if (typeof value.staging.configured !== 'boolean') add('type', '$.staging.configured', 'expected a boolean');
    if (value.staging.exists !== null && typeof value.staging.exists !== 'boolean') add('type', '$.staging.exists', 'expected boolean or null');
    if (value.staging.withinLiveRoot !== null && typeof value.staging.withinLiveRoot !== 'boolean') add('type', '$.staging.withinLiveRoot', 'expected boolean or null');
    if (typeof value.staging.detail !== 'string' || (value.staging.detail as string).length > 300) add('format', '$.staging.detail', 'bounded detail required');
  } else add('type', '$.staging', 'expected an object');
  if (isPlainObject(value.goalBindings)) {
    if (!['controlStore', 'injected', 'unavailable'].includes(String(value.goalBindings.source))) add('enum', '$.goalBindings.source', 'unexpected source');
    if (value.goalBindings.total !== null && (!Number.isSafeInteger(value.goalBindings.total) || (value.goalBindings.total as number) < 0)) add('range', '$.goalBindings.total', 'invalid total');
    if (value.goalBindings.active !== null && (!Number.isSafeInteger(value.goalBindings.active) || (value.goalBindings.active as number) < 0)) add('range', '$.goalBindings.active', 'invalid active count');
  } else add('type', '$.goalBindings', 'expected an object');
  const components = Array.isArray(value.components) ? value.components as unknown[] : null;
  if (!components) add('type', '$.components', 'expected an array');
  const seen = new Set<string>();
  const nonAvailable = new Map<string, string | null>();
  if (components) {
    if (components.length !== COMPONENT_IDS.length) add('range', '$.components', 'expected staging/control/goal/memory/shared-objects components');
    for (const [index, item] of components.entries()) {
      const at = `$.components[${index}]`;
      if (!isPlainObject(item)) { add('type', at, 'expected an object'); continue; }
      if (typeof item.id !== 'string' || !(COMPONENT_IDS as readonly string[]).includes(item.id)) add('enum', `${at}.id`, 'unexpected component id');
      else if (seen.has(item.id)) add('duplicate', `${at}.id`, 'duplicate component');
      else seen.add(item.id);
      if (typeof item.status !== 'string' || !STATUS.includes(item.status as CheckpointProbeComponentStatus)) add('enum', `${at}.status`, 'unexpected status');
      if (item.reasonCode !== null && (typeof item.reasonCode !== 'string' || !REASON.test(item.reasonCode))) add('format', `${at}.reasonCode`, 'invalid reason code');
      if (item.status === 'available' && item.reasonCode !== null) add('semantics', `${at}.reasonCode`, 'available component must not carry a reason code');
      if (item.status !== 'available' && item.reasonCode === null) add('semantics', `${at}.reasonCode`, 'unavailable/unconfigured component requires a reason code');
      if (!Array.isArray(item.requiredScope) || (item.requiredScope as unknown[]).some((entry) => typeof entry !== 'string' || entry.length > 300)) {
        add('type', `${at}.requiredScope`, 'requiredScope must be a bounded string array');
      }
      if (typeof item.detail !== 'string' || item.detail.length > 300) add('format', `${at}.detail`, 'bounded detail required');
      if (typeof item.id === 'string' && item.status !== 'available') nonAvailable.set(item.id, item.reasonCode as string | null);
    }
  }
  if (!Array.isArray(value.blockers)) add('type', '$.blockers', 'expected an array');
  else {
    if (value.blockers.length !== nonAvailable.size) add('semantics', '$.blockers', 'blockers must match non-available components');
    for (const [index, item] of value.blockers.entries()) {
      const at = `$.blockers[${index}]`;
      if (!isPlainObject(item)) { add('type', at, 'expected an object'); continue; }
      if (typeof item.id !== 'string' || !nonAvailable.has(item.id)) add('semantics', `${at}.id`, 'blocker does not match a non-available component');
      else if (item.reasonCode !== nonAvailable.get(item.id)) add('semantics', `${at}.reasonCode`, 'blocker reason does not match its component');
      if (!Array.isArray(item.requiredScope)) add('type', `${at}.requiredScope`, 'expected an array');
    }
  }
  return { ok: violations.length === 0, violations };
};

export const CHECKPOINT_PROBE_REASON_CODES = Object.freeze([
  'CHECKPOINT_STAGING_UNCONFIGURED',
  'GOAL_SESSION_EXPORT_UNAVAILABLE',
  'MEMORY_EXPORT_UNAVAILABLE',
]);
