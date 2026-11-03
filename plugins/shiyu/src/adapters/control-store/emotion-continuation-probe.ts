/**
 * H4f fixed-host zero-model emotion-continuation probe.
 *
 * It owns a private in-memory ControlStore Worker and drives the real emotion
 * domain through public IPC. It proves only that a conversation-scoped,
 * sourced, timestamped system-state projection and its bounded recent events are
 * readable, audience-trimmed, revocation-aware and explicitly non-subjective.
 * It never creates a Task/Goal/Effect, never calls a model/embedding, never
 * touches the live runtime or its data root, and never writes Ombre metadata.
 */
import { randomUUID } from 'node:crypto';
import { ControlStore } from './index.js';
import { CONVERSATION_BACKGROUND_HANDLER } from './conversation-domain.js';
import { SHIYU_EVENT_TYPES, type EventTypeDefinition } from '../../contracts/events.js';
import type { EmotionContext, EmotionState, InnerCapture } from '../../contracts/inner.js';

export const EMOTION_PROBE_SCHEMA_VERSION = 1;
export const EMOTION_PROBE_ACTION = 'runtime.probe-emotion-continuation';
export const EMOTION_PROBE_TOOL = 'shiyu_diagnose_emotion_continuation';
export const EMOTION_PROBE_MAX_BYTES = 24 * 1024;
const MAX_STEPS = 24, MAX_CHECKS = 24, MAX_TEXT = 300;
export interface EmotionProbeStep { step: string; status: 'passed' | 'failed'; detail?: string }
export interface EmotionProbeCheck { check: string; status: 'passed' | 'failed'; expected: string; observed: string }
export interface EmotionProbeReceipt {
  schemaVersion: 1; toolName: typeof EMOTION_PROBE_TOOL;
  zeroModel: true; zeroEmbedding: true; zeroTaskOrEffect: true;
  store: 'in-memory'; liveDataTouched: false; status: 'passed' | 'failed';
  startedAt: string; completedAt: string; durationMs: number;
  steps: EmotionProbeStep[]; checks: EmotionProbeCheck[];
  diagnostics: {
    conversationId: string; policyVersion: number; recentCountBefore: number; recentCountAfterWithdrawal: number;
    stateBefore: { label: string; valenceBps: number; arousalBps: number; derivation: string };
    stateAfterWithdrawal: { label: string; valenceBps: number; arousalBps: number; derivation: string };
    withdrawnRecordId: string | null; staleCaptureRejected: boolean;
    memoryDimension: { readOnly: boolean; ombreMetadataWritten: boolean };
    disclosure: { subjectiveExperience: boolean; longTermPersonality: boolean; modelSelfReportAuthority: string; ombrePulseTreatedAsEmotion: boolean };
    cleanup: { storeClosed: boolean; workerTerminated: boolean };
    zeroActivity: { modelCalls: 0; embeddingCalls: 0; tasks: 0; effects: 0; sends: 0 };
    livePathsAccepted: 0;
  };
  released: boolean; disposed: boolean;
}
export class EmotionContinuationProbeError extends Error {
  constructor(readonly code: string, message: string, readonly receipt?: EmotionProbeReceipt) { super(message); this.name = 'EmotionContinuationProbeError'; }
}
export interface EmotionProbeOptions {
  signal?: AbortSignal; deadlineMs?: number; now?: () => Date; afterStep?: (step: string) => void | Promise<void>; maxReceiptBytes?: number;
}
const nowIso = (now?: () => Date) => (now?.() ?? new Date()).toISOString();
const bounded = (value: unknown, max = MAX_TEXT): string => String(value).replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
const clone = <T>(value: T): T => structuredClone(value);
type StoreCall = (command: string, args?: unknown) => Promise<unknown>;
const call = <T>(store: StoreCall, command: string, args: Record<string, unknown> = {}): Promise<T> => store(command, args) as Promise<T>;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function validateEmotionProbeReceipt(receipt: unknown, maxBytes = EMOTION_PROBE_MAX_BYTES): string[] {
  const violations: string[] = [];
  const fail = (path: string, message: string): void => { violations.push(`${path}: ${message}`); };
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['$: expected plain object'];
  let serialized: string;
  try { serialized = JSON.stringify(receipt); } catch { return ['$: not lossless JSON']; }
  if (JSON.stringify(JSON.parse(serialized)) !== serialized) fail('$', 'not lossless JSON');
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) fail('$', `receipt exceeds ${maxBytes} bytes`);
  const value = receipt as Record<string, unknown>;
  if (value.schemaVersion !== EMOTION_PROBE_SCHEMA_VERSION) fail('schemaVersion', 'unsupported schema');
  if (value.toolName !== EMOTION_PROBE_TOOL) fail('toolName', 'unexpected tool identity');
  for (const flag of ['zeroModel', 'zeroEmbedding', 'zeroTaskOrEffect'] as const) if (value[flag] !== true) fail(flag, 'must be true');
  if (value.store !== 'in-memory') fail('store', 'must be in-memory');
  if (value.liveDataTouched !== false) fail('liveDataTouched', 'must be false');
  if (value.status !== 'passed' && value.status !== 'failed') fail('status', 'invalid status');
  if (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS) fail('steps', 'bounded step list required');
  if (!Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) fail('checks', 'bounded check list required');
  if (value.status === 'passed' && ((value.checks as unknown[]).length < 1 || (value.steps as { status: string }[]).some(step => step.status !== 'passed')
    || (value.checks as { status: string }[]).some(check => check.status !== 'passed'))) fail('cleanup', 'passed receipt requires all steps/checks passed');
  if (value.status === 'passed' && (value.released !== true || value.disposed !== true)) fail('cleanup', 'a passed receipt must be released and disposed');
  return violations;
}
export function emotionContinuationDiagnosisTool(service: { command(input: unknown): Promise<unknown> }) {
  return {
    name: EMOTION_PROBE_TOOL,
    description: '零模型诊断：在隔离 :memory: 控制库内验证情绪状态/最近事件的可读、来源与时间、受众裁剪、撤回与派生状态；回执显式声明无主观体验、Ombre pulse 不当情绪且不写 set_emotion/记忆元数据；关闭隔离库且不写 live 业务库、不调模型/embedding。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: false,
    execute: async () => service.command({ action: EMOTION_PROBE_ACTION }),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
  };
}
export interface RuntimeEmotionProbeDeps {
  isOpen(): boolean; isPaused(): boolean;
  probe?(options: EmotionProbeOptions): Promise<EmotionProbeReceipt>;
  onReceipt?(receipt: EmotionProbeReceipt): void;
  maxReceiptBytes?: number;
}
export class RuntimeEmotionContinuationProbeCommand {
  private active = false;
  private last?: EmotionProbeReceipt;
  constructor(private readonly deps: RuntimeEmotionProbeDeps) {}
  async handle(input: unknown, signal?: AbortSignal): Promise<EmotionProbeReceipt> {
    if (!this.deps.isOpen()) throw new EmotionContinuationProbeError('EMOTION_PROBE_CLOSED', 'Runtime is not open');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EmotionContinuationProbeError('EMOTION_PROBE_INPUT', 'Expected command object');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).length !== 1 || value.action !== EMOTION_PROBE_ACTION) throw new EmotionContinuationProbeError('EMOTION_PROBE_INPUT', 'Invalid emotion probe input');
    if (this.deps.isPaused()) throw new EmotionContinuationProbeError('EMOTION_PROBE_PAUSED', 'Runtime is paused');
    signal?.throwIfAborted();
    if (this.active) throw new EmotionContinuationProbeError('EMOTION_PROBE_BUSY', 'An emotion probe is already running');
    this.active = true;
    try {
      const receipt = await (this.deps.probe ?? probeEmotionContinuation)({ ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      const violations = validateEmotionProbeReceipt(receipt, this.deps.maxReceiptBytes);
      if (violations.length) throw new EmotionContinuationProbeError('EMOTION_PROBE_INVALID', `Receipt failed validation at ${violations[0]}`, receipt);
      if (receipt.status !== 'passed') throw new EmotionContinuationProbeError('EMOTION_PROBE_FAILED', 'Emotion probe did not pass', receipt);
      this.last = clone(receipt);
      try { this.deps.onReceipt?.(clone(receipt)); } catch { /* diagnostics sink failures never change the receipt */ }
      return clone(receipt);
    } finally { this.active = false; }
  }
  receipt(): EmotionProbeReceipt | undefined { return this.last ? clone(this.last) : undefined; }
}
export async function probeEmotionContinuation(options: EmotionProbeOptions = {}): Promise<EmotionProbeReceipt> {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['signal', 'deadlineMs', 'now', 'afterStep', 'maxReceiptBytes'].includes(key))) {
    throw new EmotionContinuationProbeError('EMOTION_PROBE_INPUT', 'Invalid probe options');
  }
  const startedAt = nowIso(options.now), deadlineMs = options.deadlineMs ?? 15000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000) throw new EmotionContinuationProbeError('EMOTION_PROBE_INPUT', 'Invalid probe deadline');
  const deadline = Date.parse(startedAt) + deadlineMs;
  const steps: EmotionProbeStep[] = [], checks: EmotionProbeCheck[] = [];
  const ensureAlive = (): void => { options.signal?.throwIfAborted(); if (Date.parse(nowIso(options.now)) > deadline) throw new EmotionContinuationProbeError('EMOTION_PROBE_DEADLINE', 'Emotion probe deadline exceeded'); };
  const step = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    ensureAlive();
    try { await run(); await options.afterStep?.(name); ensureAlive(); }
    catch (error) { steps.push({ step: name, status: 'failed', detail: bounded(error instanceof Error ? error.message : String(error)) }); throw error; }
    steps.push({ step: name, status: 'passed' });
  };
  const check = (name: string, condition: boolean, expected: string, observed: unknown): void => {
    checks.push({ check: name, status: condition ? 'passed' : 'failed', expected: bounded(expected), observed: bounded(observed) });
    if (!condition) throw new EmotionContinuationProbeError('EMOTION_PROBE_FAILED', `Emotion probe check failed: ${name}`);
  };
  const diagnostics: EmotionProbeReceipt['diagnostics'] = {
    conversationId: '', policyVersion: 0, recentCountBefore: 0, recentCountAfterWithdrawal: 0,
    stateBefore: { label: '', valenceBps: 0, arousalBps: 0, derivation: '' }, stateAfterWithdrawal: { label: '', valenceBps: 0, arousalBps: 0, derivation: '' },
    withdrawnRecordId: null, staleCaptureRejected: false,
    memoryDimension: { readOnly: false, ombreMetadataWritten: true },
    disclosure: { subjectiveExperience: false, longTermPersonality: false, modelSelfReportAuthority: 'none', ombrePulseTreatedAsEmotion: false },
    cleanup: { storeClosed: false, workerTerminated: false }, zeroActivity: { modelCalls: 0, embeddingCalls: 0, tasks: 0, effects: 0, sends: 0 }, livePathsAccepted: 0,
  };
  let store: ControlStore | undefined, failureCode: string | undefined, failureMessage = '';
  try {
    await step('open-isolated-in-memory-store', async () => {
      store = await ControlStore.open({ filename: ':memory:', eventTypes: SHIYU_EVENT_TYPES as EventTypeDefinition[],
        componentHandlers: [CONVERSATION_BACKGROUND_HANDLER], runtimeIdentity: { hostEpoch: `emotion-probe-${randomUUID()}`, installationGeneration: `emotion-probe-${randomUUID()}` } });
    });
    const api: StoreCall = (command, args) => store!.request(command as never, (args ?? {}) as never);
    let conversationId = '', secondConversationId = '', firstRecordId = '', secondRecordId = '', staleCapture: InnerCapture | undefined;
    const observation = (conversation: string) => ({ kind: 'conversation-observation' as const, sourceId: conversation, revision: 1 });
    await step('seed-conversations', async () => {
      conversationId = (await call<{ conversationId: string }>(api, 'conversation.ensureLabChannel', { connectionId: 'emotion-probe-connection', runId: 'emotion-probe-run',
        channelId: 'emotion-probe-primary', kind: 'direct', membersDigest: 'a'.repeat(64) })).conversationId;
      secondConversationId = (await call<{ conversationId: string }>(api, 'conversation.ensureLabChannel', { connectionId: 'emotion-probe-connection', runId: 'emotion-probe-run',
        channelId: 'emotion-probe-other', kind: 'direct', membersDigest: 'b'.repeat(64) })).conversationId;
      diagnostics.conversationId = conversationId;
    });
    await step('observe-sourced-experiences', async () => {
      const twoHoursAgo = new Date(Date.parse(startedAt) - 2 * 3_600_000).toISOString();
      const first = await call<{ record: { recordId: string } }>(api, 'emotion.observe', { requestId: `emotion-probe-first-${randomUUID()}`, conversationId,
        valenceBps: 7200, arousalBps: 4200, label: 'positive', observedAt: twoHoursAgo, sourceRefs: [observation(conversationId)] });
      firstRecordId = first.record.recordId;
      const second = await call<{ record: { recordId: string } }>(api, 'emotion.observe', { requestId: `emotion-probe-second-${randomUUID()}`, conversationId,
        valenceBps: 2800, arousalBps: 7300, label: 'alert', observedAt: new Date(Date.parse(startedAt) - 30 * 60_000).toISOString(), sourceRefs: [observation(conversationId)] });
      secondRecordId = second.record.recordId;
    });
    await step('read-context-with-sources-and-time', async () => {
      const context = await call<EmotionContext>(api, 'emotion.context', { conversationId });
      diagnostics.policyVersion = context.policy.policyVersion;
      diagnostics.stateBefore = { label: context.state.label, valenceBps: context.state.valenceBps, arousalBps: context.state.arousalBps, derivation: context.state.derivation };
      diagnostics.recentCountBefore = context.recent.length;
      diagnostics.memoryDimension = { readOnly: context.memoryDimension.readOnly, ombreMetadataWritten: context.memoryDimension.ombreMetadataWritten };
      diagnostics.disclosure = context.disclosure;
      check('recent-events-visible', context.recent.length === 2, 'two current events', context.recent.length);
      check('events-carry-source-and-time', context.recent.every(event => event.sourceRefs.length > 0 && Boolean(event.observedAt)), 'sourceRefs + observedAt on every event', context.recent.length);
      check('event-derivation-explicit', context.recent.every(event => ['current', 'needs_review', 'degraded', 'source_invalid', 'revoked'].includes(event.derivation)), 'bounded derivation state', context.recent.map(event => event.derivation).join(','));
      check('system-state-not-human-feeling', context.subject === 'system-state' && context.humanFeeling === false && context.disclosure.subjectiveExperience === false, 'subject=system-state, humanFeeling=false, subjectiveExperience=false', JSON.stringify({ subject: context.subject, humanFeeling: context.humanFeeling }));
      check('memory-dimension-read-only', context.memoryDimension.readOnly === true && context.memoryDimension.ombreMetadataWritten === false, 'readOnly=true, ombreMetadataWritten=false', JSON.stringify(context.memoryDimension));
      check('no-pulse-as-emotion', context.disclosure.ombrePulseTreatedAsEmotion === false, 'ombrePulseTreatedAsEmotion=false', context.disclosure.ombrePulseTreatedAsEmotion);
      check('decay-policy-versioned', context.policy.halfLifeMs > 0 && context.policy.policyVersion >= 1, 'versioned decay policy', `${context.policy.policyVersion}/${context.policy.halfLifeMs}`);
      staleCapture = await call<InnerCapture>(api, 'emotion.captureForView', { conversationId });
    });
    await step('audience-trimming', async () => {
      const other = await call<EmotionContext>(api, 'emotion.context', { conversationId: secondConversationId });
      check('other-conversation-has-no-primary-events', other.recent.length === 0, 'no cross-conversation events', other.recent.length);
      check('other-conversation-neutral', other.state.valenceBps === 5000 && other.state.arousalBps === 5000, 'neutral 5000/5000 without sources', `${other.state.valenceBps}/${other.state.arousalBps}`);
    });
    await step('withdraw-one-source', async () => {
      await call(api, 'emotion.withdraw', { requestId: `emotion-probe-withdraw-${randomUUID()}`, recordIds: [firstRecordId] });
      diagnostics.withdrawnRecordId = firstRecordId;
      const context = await call<EmotionContext>(api, 'emotion.context', { conversationId });
      diagnostics.recentCountAfterWithdrawal = context.recent.length;
      diagnostics.stateAfterWithdrawal = { label: context.state.label, valenceBps: context.state.valenceBps, arousalBps: context.state.arousalBps, derivation: context.state.derivation };
      check('withdrawn-event-not-current', !context.recent.some(event => event.recordId === firstRecordId), 'withdrawn event absent from context', context.recent.map(event => event.recordId).join(','));
      check('state-recomputed-after-withdrawal', context.state.derivation !== 'revoked', 'explicit non-revoked derivation with remaining source', context.state.derivation);
      try { await call(api, 'emotion.validateForView', { capture: staleCapture }); }
      catch (error) { diagnostics.staleCaptureRejected = true; void error; }
      check('stale-capture-rejected', diagnostics.staleCaptureRejected, 'old capture rejected after source change', diagnostics.staleCaptureRejected);
      let revival: unknown;
      try { await call(api, 'emotion.observe', { requestId: `emotion-probe-revival-${randomUUID()}`, conversationId, valenceBps: 9000, arousalBps: 1000, label: 'positive',
        sourceRefs: [{ kind: 'emotion-record', sourceId: firstRecordId, revision: 1 }, observation(conversationId)] }); }
      catch (error) { revival = error; }
      check('withdrawn-source-cannot-revive', revival !== undefined, 'explicit INNER_SOURCE_* rejection', (revival as { code?: string } | undefined)?.code ?? 'none');
    });
    await step('withdraw-evidence-degrades-state', async () => {
      await call(api, 'emotion.withdraw', { requestId: `emotion-probe-evidence-${randomUUID()}`, evidenceRefs: [observation(conversationId)] });
      const context = await call<EmotionContext>(api, 'emotion.context', { conversationId });
      const revoked = context.recent.find(event => event.recordId === secondRecordId);
      check('state-degradation-explicit', context.state.revokedEvidence.includes(secondRecordId) && context.state.derivation !== 'current',
        'revokedEvidence contains the now-unsourced event; derivation non-current', JSON.stringify({ revokedEvidence: context.state.revokedEvidence, derivation: context.state.derivation }));
      check('event-derivation-invalid', revoked?.derivation === 'source_invalid', 'remaining event derivation=source_invalid', revoked?.derivation ?? 'missing');
    });
    for (const item of steps) if (item.status !== 'passed') throw new EmotionContinuationProbeError('EMOTION_PROBE_FAILED', `Probe step failed: ${item.step}`);
    void secondRecordId;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failureCode = error instanceof EmotionContinuationProbeError ? error.code
      : failure.name === 'AbortError' || options.signal?.aborted ? 'EMOTION_PROBE_ABORTED' : 'EMOTION_PROBE_FAILED';
    failureMessage = failure.message;
  } finally {
    if (store) {
      try { await store.close(); diagnostics.cleanup.storeClosed = true; diagnostics.cleanup.workerTerminated = true; }
      catch { diagnostics.cleanup.storeClosed = false; diagnostics.cleanup.workerTerminated = false; }
      store = undefined;
    }
  }
  const completedAt = nowIso(options.now);
  const receipt: EmotionProbeReceipt = { schemaVersion: 1, toolName: EMOTION_PROBE_TOOL, zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true,
    store: 'in-memory', liveDataTouched: false, status: failureCode ? 'failed' : 'passed', startedAt, completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), steps, checks, diagnostics, released: true, disposed: diagnostics.cleanup.storeClosed };
  const violations = validateEmotionProbeReceipt(receipt, options.maxReceiptBytes);
  if (violations.length) throw new EmotionContinuationProbeError('EMOTION_PROBE_INVALID', `Probe receipt failed validation at ${violations[0]}`, receipt);
  if (failureCode) throw new EmotionContinuationProbeError(failureCode, bounded(failureMessage), receipt);
  return receipt;
}
