/**
 * Helpers for authoring the H0c S/FL skeleton catalogue.
 *
 * The catalogue is authored data: it materialises one representative, fully
 * specified trace per scenario. Historical case documents contain more steps
 * (54 S steps + 26 FL steps); those un-materialised steps are listed in the
 * coverage report instead of being silently claimed as covered.
 */
import type { JsonValue } from '../invariant.js';
import type {
  ScenarioVariant,
  ActionToken,
  AttentionToken,
  ClassExpectation,
  ExpectedCounts,
  ExpressionExpectation,
  ExpressionToken,
  FaultTrigger,
  HDimension,
  InternalToken,
  OracleCheck,
  PublicEvent,
  PublicStep,
  QualityDimensionId,
  SourceStepCount,
  StepAnswers,
} from './types.js';

export const BASE_TIME = '2026-11-01T09:00:00-04:00';
export const FL_BASE_TIME = '2026-11-01T09:00:00-04:00';

/** Deterministic ISO seconds shift preserving the fixed -04:00 offset. */
export function plusIso(baseIso: string, seconds: number, offsetHours = -4): string {
  const epoch = Date.parse(baseIso) + seconds * 1000;
  const wall = new Date(epoch + offsetHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, '');
  const sign = offsetHours < 0 ? '-' : '+';
  const absolute = Math.abs(offsetHours);
  const hours = String(Math.floor(absolute)).padStart(2, '0');
  const minutes = String(Math.round((absolute - Math.floor(absolute)) * 60)).padStart(2, '0');
  const result = `${wall}${sign}${hours}:${minutes}`;
  if (Date.parse(result) !== epoch) throw new Error(`plusIso drift for ${baseIso}+${seconds}: ${result}`);
  return result;
}

export function expect<T extends string>(
  required: readonly T[],
  allowed: readonly T[],
  forbidden: readonly T[],
  policyPending?: readonly T[],
): ClassExpectation<T> {
  return policyPending === undefined ? { required, allowed, forbidden } : { required, allowed, forbidden, policyPending };
}

export function expressionExpectation(
  required: readonly ExpressionToken[],
  allowed: readonly ExpressionToken[],
  forbidden: readonly ExpressionToken[],
  options: { audiences?: readonly string[]; forbiddenAudiences?: readonly string[]; policyPending?: readonly ExpressionToken[] } = {},
): ExpressionExpectation {
  return {
    required,
    allowed,
    forbidden,
    ...(options.audiences === undefined ? {} : { allowedAudiences: options.audiences }),
    ...(options.forbiddenAudiences === undefined ? {} : { forbiddenAudiences: options.forbiddenAudiences }),
    ...(options.policyPending === undefined ? {} : { policyPending: options.policyPending }),
  };
}

export function event(
  actor: string,
  audience: string,
  channel: string,
  text: string,
  occurredAt: string,
  extra: Partial<Omit<PublicEvent, 'actor' | 'audience' | 'channel' | 'text' | 'occurredAt' | 'receivedAt'>> & { receivedAt?: string } = {},
): PublicEvent {
  return {
    actor,
    audience,
    channel,
    text,
    occurredAt,
    receivedAt: extra.receivedAt ?? occurredAt,
    ...(extra.sourceKey === undefined ? {} : { sourceKey: extra.sourceKey }),
    ...(extra.sourceRevision === undefined ? {} : { sourceRevision: extra.sourceRevision }),
    ...(extra.attachmentState === undefined ? {} : { attachmentState: extra.attachmentState }),
  };
}

export function publicStep(
  stepId: string,
  index: number,
  title: string,
  eventValue: PublicEvent,
  options: {
    visibleHistory?: readonly string[];
    capabilities?: readonly string[];
    faults?: readonly FaultTrigger[];
    note?: string;
  } = {},
): PublicStep {
  return {
    stepId,
    index,
    title,
    event: eventValue,
    visibleHistory: options.visibleHistory ?? [],
    availableCapabilities: options.capabilities ?? ['ReadView.local', 'Effect.dispatch.synthetic', 'MemoryBackend.synthetic', 'Clock.fake'],
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.note === undefined ? {} : { note: options.note }),
  };
}

export interface StepAuthorInput {
  readonly stepId: string;
  readonly attention: ClassExpectation<AttentionToken>;
  readonly internal: ClassExpectation<InternalToken>;
  readonly expression: ExpressionExpectation;
  readonly action: ClassExpectation<ActionToken>;
  readonly routes: readonly StepAnswers['routes'][number][];
  readonly counts?: ExpectedCounts;
  readonly oracleChecks?: readonly OracleCheck[];
  readonly milestones?: readonly string[];
  readonly hDimensions: readonly HDimension[];
  readonly quality?: StepAnswers['quality'];
  readonly policyPending?: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export function answers(input: StepAuthorInput): StepAnswers {
  return {
    stepId: input.stepId,
    attention: input.attention,
    internal: input.internal,
    expression: input.expression,
    action: input.action,
    routes: input.routes,
    counts: input.counts ?? {},
    oracleChecks: input.oracleChecks ?? [],
    milestones: input.milestones ?? [],
    hDimensions: input.hDimensions,
    ...(input.quality === undefined ? {} : { quality: input.quality }),
    ...(input.policyPending === undefined ? {} : { policyPending: input.policyPending }),
    evidenceRefs: input.evidenceRefs,
  };
}

export function noWrite(required: readonly InternalToken[] = [], allowed: readonly InternalToken[] = ['no_internal_write']): ClassExpectation<InternalToken> {
  return expect(required, allowed.length === 0 ? ['no_internal_write'] : allowed, []);
}

export function zeroCounts(partial: ExpectedCounts = {}): ExpectedCounts {
  return { modelCalls: 0, externalSends: 0, backendWrites: 0, ...partial };
}

export function sourceCount(
  sourcePath: string,
  kind: SourceStepCount['kind'],
  existingStepCount: number,
): SourceStepCount {
  return { sourcePath, kind, existingStepCount, machineReadableAnswers: false, statusAtSource: 'design-doc-only-unrun' };
}

export function quality(
  applicable: readonly QualityDimensionId[],
  pairing?: string,
  note?: string,
): StepAnswers['quality'] {
  return { applicable, ...(pairing === undefined ? {} : { pairing }), ...(note === undefined ? {} : { note }) };
}

/** Standard per-scenario variant contract: one answer-invariant and one answer-changing transform. */
export function variantsFor(scenarioId: string, sameDescription: string, changedDescription: string): readonly ScenarioVariant[] {
  return [
    {
      id: `${scenarioId}.noise-or-rename`,
      kind: 'noise',
      expectation: 'same_allowed_answers',
      description: sameDescription,
      materialised: false,
      reason: 'H0c 只物化主线代表轨迹；噪音/改名变体待后续切片生成并逐条审查',
    },
    {
      id: `${scenarioId}.structure-change`,
      kind: 'correction',
      expectation: 'changed_allowed_answers',
      description: changedDescription,
      materialised: false,
      reason: '需要新的因果结构；不能只改词或换种子冒充新样本',
    },
  ];
}

/** Public precondition helper for a scenario (JSON-serialisable facts only). */
export function preconditions(values: Record<string, JsonValue>): Record<string, JsonValue> {
  return values;
}
