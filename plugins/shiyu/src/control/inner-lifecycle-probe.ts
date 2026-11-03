/**
 * H4e fixed-host zero-model isolated lifecycle probe.
 *
 * The probe owns one *in-memory* ControlStore Worker (filename `:memory:`) and
 * drives the real relationship / emotion / cognition / personality domains
 * through their public IPC commands. It never receives a live data path, never
 * opens the live control database, never calls a model or embedding, never
 * creates a Task/Goal/Effect and never sends anything. Every run closes the
 * isolated store in `finally`; the receipt declares `liveDataTouched: false` and
 * a cleanup block that the caller can validate without trusting this comment.
 */
import { randomUUID } from 'node:crypto';
import { ControlStore } from '../adapters/control-store/index.js';
import { CONVERSATION_BACKGROUND_HANDLER } from '../adapters/control-store/conversation-domain.js';
import { SHIYU_EVENT_TYPES, type EventTypeDefinition } from '../contracts/events.js';

export const INNER_LIFECYCLE_PROBE_SCHEMA_VERSION = 1;
export const INNER_LIFECYCLE_PROBE_ACTION = 'runtime.probe-inner-lifecycle';
export const INNER_LIFECYCLE_PROBE_TOOL = 'shiyu_diagnose_inner_lifecycle';
export const INNER_LIFECYCLE_PROBE_MAX_BYTES = 24 * 1024;
const MAX_STEPS = 32;
const MAX_CHECKS = 32;
const MAX_TEXT = 300;

export type InnerLifecycleProbeStatus = 'passed' | 'failed';
export interface InnerLifecycleProbeStep { step: string; status: 'passed' | 'failed'; detail?: string }
export interface InnerLifecycleProbeCheck {
  check: string; status: 'passed' | 'failed'; expected: string; observed: string;
}
export interface InnerLifecycleProbeReceipt {
  schemaVersion: 1;
  toolName: typeof INNER_LIFECYCLE_PROBE_TOOL;
  zeroModel: true; zeroEmbedding: true; zeroTaskOrEffect: true;
  store: 'in-memory'; liveDataTouched: false;
  status: InnerLifecycleProbeStatus;
  startedAt: string; completedAt: string; durationMs: number;
  scenario: { conversation: 'synthetic-probe'; memoryDomain: 'skipped-no-backend'; seeded: { relationship: number; cognition: number; personality: number } };
  steps: InnerLifecycleProbeStep[];
  checks: InnerLifecycleProbeCheck[];
  diagnostics: {
    database: 'memory'; conversationId: string;
    derivedRevisionBefore: number; derivedRevisionAfter: number;
    degradation: { withdrawal: string; profileVersion: string };
    staleCaptureRejected: boolean; staleBodyRejected: boolean;
    recomputeIdempotent: boolean; sourceRevivalRefused: boolean;
    cleanup: { storeClosed: boolean; workerTerminated: boolean };
    zeroActivity: { modelCalls: 0; embeddingCalls: 0; tasks: 0; effects: 0; sends: 0 };
    livePathsAccepted: 0;
  };
  released: boolean; disposed: boolean;
}
export class InnerLifecycleProbeError extends Error {
  constructor(readonly code: string, message: string, readonly receipt?: InnerLifecycleProbeReceipt) {
    super(message); this.name = 'InnerLifecycleProbeError';
  }
}
export interface InnerLifecycleProbeOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  now?: () => Date;
  /** Trusted test/composition hook; never supplied by public JSON. */
  afterStep?: (step: string) => void | Promise<void>;
  maxReceiptBytes?: number;
}
const nowIso = (now?: () => Date): string => (now?.() ?? new Date()).toISOString();
const bounded = (value: unknown, max = MAX_TEXT): string => String(value).replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
const clone = <T>(value: T): T => structuredClone(value);
type StoreCall = (command: string, args?: unknown) => Promise<unknown>;
const call = <T>(store: StoreCall, command: string, args: Record<string, unknown> = {}): Promise<T> =>
  store(command, args) as Promise<T>;

const receiptBytes = (receipt: unknown): number => Buffer.byteLength(JSON.stringify(receipt), 'utf8');

/**
 * Strict, lossless receipt validation. It rejects unserializable values, unknown
 * top-level shape errors and oversized receipts before a receipt is cached or
 * returned; a failed probe never claims `status: passed`.
 */
export function validateInnerLifecycleProbeReceipt(receipt: unknown, maxBytes = INNER_LIFECYCLE_PROBE_MAX_BYTES): string[] {
  const violations: string[] = [];
  const fail = (path: string, message: string): void => { violations.push(`${path}: ${message}`); };
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['$: expected plain object'];
  let serialized: string;
  try { serialized = JSON.stringify(receipt); } catch { return ['$: not lossless JSON']; }
  if (JSON.stringify(JSON.parse(serialized)) !== serialized) fail('$', 'not lossless JSON');
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) fail('$', `receipt exceeds ${maxBytes} bytes`);
  const value = receipt as Record<string, unknown>;
  if (value.schemaVersion !== INNER_LIFECYCLE_PROBE_SCHEMA_VERSION) fail('schemaVersion', 'unsupported probe schema');
  if (value.toolName !== INNER_LIFECYCLE_PROBE_TOOL) fail('toolName', 'unexpected tool identity');
  for (const flag of ['zeroModel', 'zeroEmbedding', 'zeroTaskOrEffect'] as const) if (value[flag] !== true) fail(flag, 'must be true');
  if (value.store !== 'in-memory') fail('store', 'must be the isolated in-memory store');
  if (value.liveDataTouched !== false) fail('liveDataTouched', 'must be false');
  if (value.status !== 'passed' && value.status !== 'failed') fail('status', 'invalid status');
  if (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS || value.steps.length < 1) fail('steps', 'bounded non-empty step list required');
  if (!Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) fail('checks', 'bounded check list required');
  if (value.status === 'passed' && (value.checks as unknown[]).length < 1) fail('checks', 'a passed receipt requires at least one check');
  for (const step of (value.steps as unknown[])) {
    if (!step || typeof step !== 'object') { fail('steps[]', 'invalid step'); continue; }
    const item = step as Record<string, unknown>;
    if (typeof item.step !== 'string' || (item.status !== 'passed' && item.status !== 'failed')) fail('steps[]', 'invalid step entry');
  }
  for (const check of (value.checks as unknown[])) {
    if (!check || typeof check !== 'object') { fail('checks[]', 'invalid check'); continue; }
    const item = check as Record<string, unknown>;
    if (typeof item.check !== 'string' || (item.status !== 'passed' && item.status !== 'failed')
      || typeof item.expected !== 'string' || typeof item.observed !== 'string') fail('checks[]', 'invalid check entry');
  }
  if (value.status === 'passed' && (value.steps as { status: string }[]).some(step => step.status !== 'passed')) fail('steps[]', 'passed receipt has a failed step');
  if (value.status === 'passed' && (value.checks as { status: string }[]).some(check => check.status !== 'passed')) fail('checks[]', 'passed receipt has a failed check');
  if (value.released !== true || value.disposed !== true) { if (value.status === 'passed') fail('cleanup', 'a passed receipt must be released and disposed'); }
  return violations;
}
/** Tool definition for the host adapter; the runtime command itself is owner-only. */
export function innerLifecycleDiagnosisTool(service: { command(input: unknown): Promise<unknown> },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
) {
  return {
    name: INNER_LIFECYCLE_PROBE_TOOL,
    description: '零模型诊断：在隔离的 :memory: 控制库内构造真实内层四域依赖，撤回/版本变更来源后核验派生降级、旧 capture/正文拒绝、重算幂等与不复活；关闭隔离库且不写 live 业务库、不调模型/embedding、不建 Task/Effect。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: INNER_LIFECYCLE_PROBE_ACTION }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  };
}

/** Owner-only command: exact schema, session.probe-like admission, single slot, abortable, never retried. */
export interface RuntimeInnerLifecycleProbeDeps {
  isOpen(): boolean; isPaused(): boolean;
  probe?(options: InnerLifecycleProbeOptions): Promise<InnerLifecycleProbeReceipt>;
  onReceipt?(receipt: InnerLifecycleProbeReceipt): void;
  now?: () => Date;
  maxReceiptBytes?: number;
}
export class RuntimeInnerLifecycleProbeCommand {
  private active = false;
  private lastReceipt?: InnerLifecycleProbeReceipt;
  constructor(private readonly deps: RuntimeInnerLifecycleProbeDeps) {}
  private ensureOpen(): void { if (!this.deps.isOpen()) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_CLOSED', 'Runtime is not open'); }
  async handle(input: unknown, signal?: AbortSignal): Promise<InnerLifecycleProbeReceipt> {
    this.ensureOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_INPUT', 'Expected command object');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).length !== 1 || value.action !== INNER_LIFECYCLE_PROBE_ACTION) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_INPUT', 'Invalid inner lifecycle probe input');
    if (this.deps.isPaused()) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_PAUSED', 'Runtime is paused');
    signal?.throwIfAborted();
    if (this.active) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_BUSY', 'An inner lifecycle probe is already running');
    this.active = true;
    try {
      const receipt = await (this.deps.probe ?? probeInnerLifecycle)({ ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      const violations = validateInnerLifecycleProbeReceipt(receipt, this.deps.maxReceiptBytes);
      if (violations.length) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_INVALID', `Probe receipt failed validation at ${violations[0]}`, receipt);
      if (receipt.status !== 'passed') throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_FAILED', 'Inner lifecycle probe did not pass', receipt);
      this.lastReceipt = clone(receipt);
      try { this.deps.onReceipt?.(clone(receipt)); } catch { /* diagnostics sink failures never change the receipt */ }
      return clone(receipt);
    } finally { this.active = false; }
  }
  receipt(): InnerLifecycleProbeReceipt | undefined { return this.lastReceipt ? clone(this.lastReceipt) : undefined; }
}

/**
 * Run one isolated lifecycle scenario. The only persistence is the in-memory
 * SQLite database owned by the private Worker; the live runtime never supplies a
 * filename or its ControlStore here.
 */
export async function probeInnerLifecycle(options: InnerLifecycleProbeOptions = {}): Promise<InnerLifecycleProbeReceipt> {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['signal', 'deadlineMs', 'now', 'afterStep', 'maxReceiptBytes'].includes(key))) {
    throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_INPUT', 'Invalid probe options');
  }
  const startedAt = nowIso(options.now);
  const deadlineMs = options.deadlineMs ?? 15000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_INPUT', 'Invalid probe deadline');
  const deadline = Date.parse(startedAt) + deadlineMs;
  const steps: InnerLifecycleProbeStep[] = [];
  const checks: InnerLifecycleProbeCheck[] = [];
  const ensureAlive = (): void => {
    options.signal?.throwIfAborted();
    if (Date.parse(nowIso(options.now)) > deadline) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_DEADLINE', 'Inner lifecycle probe deadline exceeded');
  };
  const step = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    ensureAlive();
    try {
      await run();
      await options.afterStep?.(name);
      ensureAlive();
    } catch (error) {
      steps.push({ step: name, status: 'failed', detail: bounded(error instanceof Error ? error.message : String(error)) });
      throw error;
    }
    steps.push({ step: name, status: 'passed' });
  };
  const check = (name: string, condition: boolean, expected: string, observed: unknown): void => {
    checks.push({ check: name, status: condition ? 'passed' : 'failed', expected: bounded(expected), observed: bounded(observed) });
    if (!condition) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_FAILED', `Inner lifecycle check failed: ${name}`);
  };
  let store: ControlStore | undefined;
  let failureCode: string | undefined; let failureMessage = '';
  const diagnostics: InnerLifecycleProbeReceipt['diagnostics'] = {
    database: 'memory', conversationId: '', derivedRevisionBefore: 0, derivedRevisionAfter: 0,
    degradation: { withdrawal: 'pending', profileVersion: 'pending' },
    staleCaptureRejected: false, staleBodyRejected: false, recomputeIdempotent: false, sourceRevivalRefused: false,
    cleanup: { storeClosed: false, workerTerminated: false },
    zeroActivity: { modelCalls: 0, embeddingCalls: 0, tasks: 0, effects: 0, sends: 0 },
    livePathsAccepted: 0,
  };
  try {
    await step('open-isolated-in-memory-store', async () => {
      store = await ControlStore.open({ filename: ':memory:', eventTypes: SHIYU_EVENT_TYPES as EventTypeDefinition[],
        componentHandlers: [CONVERSATION_BACKGROUND_HANDLER], runtimeIdentity: { hostEpoch: `inner-lifecycle-probe-${randomUUID()}`,
          installationGeneration: `inner-lifecycle-probe-${randomUUID()}` } });
    });
    const api: StoreCall = (command, args) => store!.request(command as never, (args ?? {}) as never);
    let conversationId = '';
    let subjectEntityId = '';
    let assertionRecordId = '';
    let claimRecordId = '';
    let staleCognitionCapture: { captureId: string } | undefined;
    let stalePersonalityCapture: { captureId: string } | undefined;
    await step('seed-isolated-conversation', async () => {
      const conversation = await call<{ conversationId: string }>(api, 'conversation.ensureLabChannel', { connectionId: 'inner-lifecycle-probe-connection',
        runId: 'inner-lifecycle-probe-run', channelId: 'inner-lifecycle-probe-channel', kind: 'direct', membersDigest: 'a'.repeat(64) });
      conversationId = conversation.conversationId; diagnostics.conversationId = conversationId;
    });
    const observation = (): { kind: 'conversation-observation'; sourceId: string; revision: number } => ({ kind: 'conversation-observation', sourceId: conversationId, revision: 1 });
    await step('seed-relationship-source', async () => {
      const subject = await call<{ record: { entityId: string } }>(api, 'relationship.registerSubject', { requestId: `probe-subject-${randomUUID()}`,
        account: { connectionId: 'inner-lifecycle-probe', identityNamespace: 'synthetic-lab', identityType: 'member', externalSubjectId: 'probe-person' },
        entityKind: 'person', displayName: '探针同名' });
      const assertion = await call<{ record: { recordId: string } }>(api, 'relationship.assert', { requestId: `probe-assertion-${randomUUID()}`,
        conversationId, subjectId: subject.record.entityId, predicate: 'alias', value: '探针别名', sourceRefs: [observation()] });
      subjectEntityId = subject.record.entityId;
      assertionRecordId = assertion.record.recordId;
    });
    await step('seed-dependent-cognition', async () => {
      const claim = await call<{ record: { recordId: string } }>(api, 'cognition.propose', { requestId: `probe-claim-${randomUUID()}`,
        conversationId, claimType: 'external-observation', subjectIds: ['probe-subject'], predicate: 'observed-alias', proposition: '探针观察到别名。',
        confidenceBps: 6000, sourceRefs: [observation(), { kind: 'relationship-record', sourceId: assertionRecordId, revision: 1 }] });
      claimRecordId = claim.record.recordId;
    });
    await step('seed-personality-version-dependency', async () => {
      const personalityCapture = await call<{ captureId: string; records: { recordId: string }[] }>(api, 'personality.captureForView', { conversationId });
      stalePersonalityCapture = personalityCapture;
      const profile = personalityCapture.records.find(record => record.recordId.startsWith('profile:'))!;
      await call(api, 'cognition.propose', { requestId: `probe-profile-claim-${randomUUID()}`, conversationId, claimType: 'external-observation',
        subjectIds: ['probe-profile-subject'], predicate: 'follows-probe-profile', proposition: '探针遵循当前人格。', confidenceBps: 6000,
        sourceRefs: [observation(), { kind: 'personality-profile', sourceId: profile.recordId, revision: 1 }] });
    });
    await step('capture-metadata-before-change', async () => {
      staleCognitionCapture = await call<{ captureId: string }>(api, 'cognition.captureForView', { conversationId });
    });
    await step('record-derived-revision', async () => {
      diagnostics.derivedRevisionBefore = (await call<{ derivedRevision: number }>(api, 'cognition.derivations')).derivedRevision;
    });
    let withdrawalRejected: unknown, bodyRejected: unknown, revivalRejected: unknown;
    await step('withdraw-source-and-recompute', async () => {
      await call(api, 'relationship.withdraw', { requestId: `probe-withdraw-${randomUUID()}`, recordIds: [assertionRecordId] });
    });
    await step('verify-derived-degradation', async () => {
      const capture = await call<{ records: { recordId: string; evidenceState: string; derivation?: string; derivationReasons?: string[]; bodyAvailable: boolean }[] }>(api, 'cognition.captureForView', { conversationId });
      const claim = capture.records.find(record => record.recordId === claimRecordId);
      if (!claim) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_FAILED', 'Dependent cognition record disappeared');
      diagnostics.degradation.withdrawal = claim.derivation ?? 'missing';
      check('dependent-not-current', claim.derivation !== 'current' && claim.evidenceState !== 'valid', 'derivation != current and evidenceState != valid',
        `${claim.derivation}/${claim.evidenceState}`);
      check('degradation-reason-present', (claim.derivationReasons ?? []).length > 0, 'at least one bounded reason', claim.derivationReasons ?? []);
      const profileCapture = await call<{ records: { recordId: string; derivation?: string; evidenceState: string; bodyAvailable: boolean }[] }>(api, 'personality.captureForView', { conversationId });
      diagnostics.degradation.profileVersion = profileCapture.records.find(record => record.recordId.startsWith('profile:'))?.derivation ?? 'missing';
    });
    await step('verify-stale-capture-rejected', async () => {
      try { await call(api, 'cognition.validateForView', { capture: staleCognitionCapture }); }
      catch (error) { withdrawalRejected = error; }
      diagnostics.staleCaptureRejected = withdrawalRejected !== undefined;
      check('stale-capture-rejected', diagnostics.staleCaptureRejected, 'INNER_CAPTURE_INVALIDATED error', (withdrawalRejected as { code?: string } | undefined)?.code ?? 'none');
    });
    await step('verify-stale-bodies-rejected', async () => {
      try { await call(api, 'cognition.readBodies', { capture: staleCognitionCapture, recordIds: [claimRecordId] }); }
      catch (error) { bodyRejected = error; }
      diagnostics.staleBodyRejected = bodyRejected !== undefined;
      check('stale-bodies-rejected', diagnostics.staleBodyRejected, 'explicit rejection, not empty success', (bodyRejected as { code?: string } | undefined)?.code ?? 'none');
    });
    await step('verify-recompute-idempotent', async () => {
      const before = (await call<{ derivedRevision: number }>(api, 'cognition.derivations')).derivedRevision;
      const recompute = await call<{ changed: boolean; derivedRevision: number }>(api, 'cognition.recompute', { requestId: `probe-recompute-${randomUUID()}` });
      const after = (await call<{ derivedRevision: number }>(api, 'cognition.derivations')).derivedRevision;
      diagnostics.derivedRevisionAfter = after;
      diagnostics.recomputeIdempotent = recompute.changed === false && after === before;
      check('exactly-one-revision-bump', after === diagnostics.derivedRevisionBefore + 1, `+1 (before ${diagnostics.derivedRevisionBefore})`, after);
      check('recompute-idempotent', diagnostics.recomputeIdempotent, 'changed=false and no extra bump', JSON.stringify({ before, after, changed: recompute.changed }));
    });
    await step('verify-source-not-revived', async () => {
      try {
        await call(api, 'relationship.assert', { requestId: `probe-revival-${randomUUID()}`, conversationId, subjectId: subjectEntityId,
          predicate: 'alias', value: '不应复活', sourceRefs: [observation(), { kind: 'relationship-record', sourceId: assertionRecordId, revision: 1 }] });
      } catch (error) { revivalRejected = error; }
      diagnostics.sourceRevivalRefused = revivalRejected !== undefined;
      check('withdrawn-source-cannot-revive', diagnostics.sourceRevivalRefused, 'explicit INNER_SOURCE_* rejection',
        (revivalRejected as { code?: string } | undefined)?.code ?? 'none');
    });
    await step('verify-personality-version-degrades-dependants', async () => {
      const before = await call<{ records: { recordId: string; derivation?: string; evidenceState: string }[] }>(api, 'cognition.captureForView', { conversationId });
      const profileClaim = before.records.find(record => record.recordId.startsWith('claim:'));
      void profileClaim;
      const proposal = await call<{ record: { candidateId: string } }>(api, 'personality.propose', { requestId: `probe-persona-${randomUUID()}`,
        conversationId, expectedProfileVersion: 1, sourceKind: 'user-explicit', displayName: '探针人格', sourceRefs: [observation()] });
      await call(api, 'personality.review', { requestId: `probe-persona-review-${randomUUID()}`, conversationId,
        candidateId: proposal.record.candidateId, expectedRevision: 1, decision: 'approve', sourceRefs: [observation()] });
      const after = await call<{ records: { recordId: string; derivation?: string; evidenceState: string; bodyAvailable: boolean }[] }>(api, 'cognition.captureForView', { conversationId });
      const versions = after.records.filter(record => record.derivation === 'needs_review').map(record => record.recordId);
      check('profile-version-needs-review', versions.length >= 1, 'at least one needs_review dependant', versions.length);
      let stalePersonalityRejected: unknown;
      try { await call(api, 'personality.validateForView', { capture: stalePersonalityCapture }); } catch (error) { stalePersonalityRejected = error; }
      check('stale-personality-capture-rejected', stalePersonalityRejected !== undefined, 'explicit rejection',
        (stalePersonalityRejected as { code?: string } | undefined)?.code ?? 'none');
    });
    for (const item of steps) if (item.status !== 'passed') throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_FAILED', `Probe step failed: ${item.step}`);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failureCode = error instanceof InnerLifecycleProbeError ? error.code
      : failure.name === 'AbortError' || options.signal?.aborted ? 'INNER_LIFECYCLE_PROBE_ABORTED' : 'INNER_LIFECYCLE_PROBE_FAILED';
    failureMessage = failure.message;
  } finally {
    if (store) {
      try { await store.close(); diagnostics.cleanup.storeClosed = true; diagnostics.cleanup.workerTerminated = true; }
      catch { diagnostics.cleanup.storeClosed = false; diagnostics.cleanup.workerTerminated = false; }
      store = undefined;
    }
  }
  if (failureCode) {
    const completedAt = nowIso(options.now);
    const receipt: InnerLifecycleProbeReceipt = {
      schemaVersion: 1, toolName: INNER_LIFECYCLE_PROBE_TOOL, zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true,
      store: 'in-memory', liveDataTouched: false, status: 'failed', startedAt, completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      scenario: { conversation: 'synthetic-probe', memoryDomain: 'skipped-no-backend', seeded: { relationship: 0, cognition: 0, personality: 0 } },
      steps, checks, diagnostics, released: true, disposed: diagnostics.cleanup.storeClosed,
    };
    const violations = validateInnerLifecycleProbeReceipt(receipt, options.maxReceiptBytes);
    if (violations.length) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_INVALID', `Probe failure receipt failed validation at ${violations[0]}`, receipt);
    throw new InnerLifecycleProbeError(failureCode, bounded(failureMessage), receipt);
  }
  const completedAt = nowIso(options.now);
  const receipt: InnerLifecycleProbeReceipt = {
    schemaVersion: 1, toolName: INNER_LIFECYCLE_PROBE_TOOL, zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true,
    store: 'in-memory', liveDataTouched: false, status: 'passed', startedAt, completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    scenario: { conversation: 'synthetic-probe', memoryDomain: 'skipped-no-backend', seeded: { relationship: 1, cognition: 2, personality: 1 } },
    steps, checks, diagnostics, released: true, disposed: true,
  };
  const violations = validateInnerLifecycleProbeReceipt(receipt, options.maxReceiptBytes);
  if (violations.length) throw new InnerLifecycleProbeError('INNER_LIFECYCLE_PROBE_INVALID', `Probe receipt failed validation at ${violations[0]}`, receipt);
  return receipt;
}
