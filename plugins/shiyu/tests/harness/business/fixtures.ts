/**
 * Deterministic fixture / answer-pack generator for the H0c S/FL skeleton.
 *
 * - Same catalogue + seed => byte-identical fixture payloads.
 * - Seed only changes synthetic opaque ids/salt, never the allowed-answer
 *   semantics (the answer semantic digest is seed-independent).
 * - The public fixture contains driver inputs only. Answers, H labels,
 *   milestones, quality labels, oracle expectations, future steps and
 *   evaluation canaries never enter it.
 * - Answer packs are frozen before any run; they carry authorship metadata
 *   proving they were not derived from product output.
 */
import { sha256Hex, type CheckResult, type JsonValue, type Violation } from '../invariant.js';
import { canonicalJsonString } from '../json.js';
import { finish, violation } from '../invariant.js';
import {
  ALL_SCENARIOS,
  BUSINESS_GENERATOR_VERSION,
  CATALOG_VERSION,
  allBusinessVocabularyTokens,
  catalogDigest,
  semanticAnswersDigest,
  type ScenarioDefinition,
} from './catalog.js';
import { EVALUATION_CANARIES } from './catalog-fl.js';
import {
  ANSWER_PACK_KIND,
  FIXTURE_PACK_KIND,
  FIXTURE_SCHEMA_VERSION,
  type AnswerPack,
  type AnswerFreezeMetadata,
  type FixturePack,
  type PublicScenario,
  type PublicStep,
  type ScenarioId,
  type Split,
} from './types.js';

export const DEFAULT_SEED = 20261101;

export interface GenerateOptions {
  readonly seed?: number;
  readonly generatedAt?: string;
  readonly scenarioIds?: readonly ScenarioId[];
}

function selectedScenarios(ids?: readonly ScenarioId[]): readonly ScenarioDefinition[] {
  if (ids === undefined) return ALL_SCENARIOS;
  return ALL_SCENARIOS.filter(scenario => ids.includes(scenario.scenarioId));
}

export function scenarioSalt(seed: number, scenarioId: ScenarioId): string {
  return sha256Hex(`h0c-fixture:${seed}:${scenarioId}`).slice(0, 12);
}

function publicScenarioFor(scenario: ScenarioDefinition, seed: number): PublicScenario {
  const salt = scenarioSalt(seed, scenario.scenarioId);
  const publicSteps = scenario.publicSteps.map(step => withSyntheticIds(step, salt));
  return {
    scenarioId: scenario.scenarioId,
    familyId: scenario.familyId,
    split: scenario.split,
    fixtureSalt: salt,
    title: scenario.title,
    preconditions: scenario.preconditions,
    steps: publicSteps,
  };
}

function withSyntheticIds(step: PublicStep, salt: string): PublicStep {
  const event = step.event;
  return {
    ...step,
    event: {
      ...event,
      ...(event.sourceKey === undefined ? {} : { sourceKey: `${event.sourceKey}@${salt}` }),
      receivedAt: event.receivedAt,
    },
  };
}

export function generateFixturePack(options: GenerateOptions = {}): FixturePack {
  const seed = options.seed ?? DEFAULT_SEED;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError(`seed must be a non-negative safe integer, got ${String(seed)}`);
  const scenarios = selectedScenarios(options.scenarioIds);
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    kind: FIXTURE_PACK_KIND,
    generatorVersion: BUSINESS_GENERATOR_VERSION,
    catalogVersion: CATALOG_VERSION,
    seed,
    generatedAt: options.generatedAt ?? '1970-01-01T00:00:00.000Z',
    catalogDigest: catalogDigest(scenarios),
    scenarios: scenarios.map(scenario => publicScenarioFor(scenario, seed)),
  };
}

export interface AnswerPackOptions extends GenerateOptions {
  readonly frozenAt?: string;
}

export function generateAnswerPack(options: AnswerPackOptions = {}): AnswerPack {
  const seed = options.seed ?? DEFAULT_SEED;
  const scenarios = selectedScenarios(options.scenarioIds);
  const generatedAt = options.generatedAt ?? '1970-01-01T00:00:00.000Z';
  const freeze: AnswerFreezeMetadata = {
    frozenAt: options.frozenAt ?? generatedAt,
    frozenBy: 'h0c-authoring',
    derivedFromProductOutput: false,
    historicalSamplesReused: false,
    sourceRefs: [
      '测试/2026-11-01-测试集设计/判分与数据拆分.md',
      '测试/2026-11-01-测试集设计/实验计划.md',
      '测试/2026-11-01-信息流Lab/合成公司与标注约定.md',
      '测试/2026-11-01-信息流Lab/覆盖与拟验契约.md',
    ],
    revision: 1,
  };
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    kind: ANSWER_PACK_KIND,
    generatorVersion: BUSINESS_GENERATOR_VERSION,
    catalogVersion: CATALOG_VERSION,
    seed,
    generatedAt,
    catalogDigest: catalogDigest(scenarios),
    semanticDigest: semanticAnswersDigest(scenarios),
    scenarios: scenarios.map(scenario => ({
      scenarioId: scenario.scenarioId,
      familyId: scenario.familyId,
      split: scenario.split,
      steps: scenario.steps,
      milestones: scenario.milestones,
      variants: scenario.variants,
      source: scenario.source,
    })),
    freeze,
  };
}

export function answerPackDigest(pack: AnswerPack): string {
  const projection = JSON.parse(
    JSON.stringify({
      kind: pack.kind,
      schemaVersion: pack.schemaVersion,
      generatorVersion: pack.generatorVersion,
      catalogVersion: pack.catalogVersion,
      semanticDigest: pack.semanticDigest,
      scenarios: pack.scenarios.map(scenario => ({
        scenarioId: scenario.scenarioId,
        familyId: scenario.familyId,
        split: scenario.split,
        steps: scenario.steps,
        milestones: scenario.milestones,
        variants: scenario.variants,
        source: scenario.source,
      })),
    }),
  ) as JsonValue;
  return sha256Hex(canonicalJsonString(projection));
}

/** Build the driver input for one step: current event + visible earlier history only. */
export interface DriverInput {
  readonly scenarioId: ScenarioId;
  readonly familyId: string;
  readonly stepId: string;
  readonly preconditions: Readonly<Record<string, JsonValue>>;
  readonly visibleSteps: readonly PublicStep[];
  readonly currentStep: PublicStep;
}

export function buildDriverInput(fixture: FixturePack, scenarioId: ScenarioId, stepId: string): DriverInput {
  const scenario = fixture.scenarios.find(item => item.scenarioId === scenarioId);
  if (scenario === undefined) throw new Error(`unknown scenario ${scenarioId}`);
  const index = scenario.steps.findIndex(item => item.stepId === stepId);
  if (index === -1) throw new Error(`unknown step ${scenarioId}/${stepId}`);
  const currentStep = scenario.steps[index];
  const visibleIds = new Set<string>([...currentStep.visibleHistory, currentStep.stepId]);
  return {
    scenarioId,
    familyId: scenario.familyId,
    stepId,
    preconditions: scenario.preconditions,
    visibleSteps: scenario.steps.filter((step, stepIndex) => stepIndex <= index && visibleIds.has(step.stepId)),
    currentStep,
  };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

const ANSWER_FIELD_PATTERN = /"(required|allowed|forbidden|policyPending|oracleChecks|hDimensions|milestones|quality|evidenceRefs|attentionExpectation|internalChanges|allowedActions)"\s*:/;
const MILESTONE_PATTERN = /"M\.[A-Z]/;
const H_DIMENSION_PATTERN = /"H[1-8]"/;
const QUALITY_PATTERN = /"(situational_understanding|memory_helpfulness|emotional_fit|personality_continuity|initiative_and_intrusion)"/;

export interface IsolationOptions {
  readonly fixtureDirectory?: string;
  readonly answersDirectory?: string;
}

/**
 * Fail-closed isolation check between the public fixture and the answer pack.
 * Scans the serialised public fixture for answer fields, four-class tokens,
 * milestone/H/quality labels, evaluation canaries and future-step leakage.
 */
export function checkFixtureIsolation(fixture: FixturePack, answers: AnswerPack, options: IsolationOptions = {}): CheckResult {
  const violations: Violation[] = [];
  const text = serialized(fixture);
  if (ANSWER_FIELD_PATTERN.test(text)) violations.push(violation('answer_field_in_fixture', '$', 'public fixture contains an answer-side field name'));
  const tokens = allBusinessVocabularyTokens();
  for (const token of tokens) {
    if (text.includes(token)) violations.push(violation('vocabulary_token_in_fixture', '$', `public fixture contains four-class token ${token}`));
  }
  if (MILESTONE_PATTERN.test(text)) violations.push(violation('milestone_id_in_fixture', '$', 'public fixture contains a milestone id'));
  if (H_DIMENSION_PATTERN.test(text)) violations.push(violation('h_dimension_in_fixture', '$', 'public fixture contains an H dimension label'));
  if (QUALITY_PATTERN.test(text)) violations.push(violation('quality_dimension_in_fixture', '$', 'public fixture contains a quality dimension id'));
  for (const canary of EVALUATION_CANARIES) {
    if (text.includes(canary)) violations.push(violation('canary_in_fixture', '$', 'evaluation canary leaked into the public fixture'));
  }
  const answerText = serialized(answers);
  const canariesInAnswers = EVALUATION_CANARIES.filter(canary => answerText.includes(canary));
  if (canariesInAnswers.length === 0) {
    violations.push(violation('canary_missing_from_answers', '$', 'evaluation canaries must be kept on the answer side'));
  }
  // Per-scenario step parity + no answer step appears in the fixture as an extra future step.
  for (const scenario of answers.scenarios) {
    const publicScenario = fixture.scenarios.find(item => item.scenarioId === scenario.scenarioId);
    if (publicScenario === undefined) {
      violations.push(violation('answer_scenario_without_fixture', '$', `answer scenario ${scenario.scenarioId} has no public fixture`));
      continue;
    }
    if (publicScenario.steps.length !== scenario.steps.length) {
      violations.push(
        violation('fixture_answer_count_mismatch', `$["scenarios"][${JSON.stringify(scenario.scenarioId)}]`, `${publicScenario.steps.length} public steps vs ${scenario.steps.length} answer steps`),
      );
    }
  }
  if (options.fixtureDirectory !== undefined && options.answersDirectory !== undefined) {
    if (options.fixtureDirectory === options.answersDirectory) {
      violations.push(violation('same_directory', '$', 'fixture and answers must not share a root directory'));
    }
    if (options.answersDirectory.startsWith(`${options.fixtureDirectory}/`)) {
      violations.push(violation('answers_inside_fixture_root', '$', 'answers directory must not be inside the fixture root'));
    }
    if (options.fixtureDirectory.startsWith(`${options.answersDirectory}/`)) {
      violations.push(violation('fixture_inside_answers_root', '$', 'fixture directory must not be inside the answers root'));
    }
  }
  return finish(
    {
      oracle: 'business-fixture-isolation',
      version: '1.0.0',
      boundary:
        '扫描序列化公开 fixture：拒绝答案字段、四类 token、milestone/H/quality 标签、评估 canary 与未来步骤内容；要求 canary 只存在于答案侧；' +
        '目录分离只防误放，同机同用户目录不是秘密隔离。',
      scope: 'fixture-answer-isolation',
    },
    fixture.scenarios.length,
    violations,
    {
      fixtureBytes: Buffer.byteLength(text, 'utf8'),
      answerBytes: Buffer.byteLength(answerText, 'utf8'),
      canariesInAnswers: canariesInAnswers.length,
    },
  );
}

/** Runtime guard: a driver input for one step may not expose future steps or answers. */
export function checkDriverInputBoundary(fixture: FixturePack, answers: AnswerPack, input: DriverInput): CheckResult {
  const violations: Violation[] = [];
  const scenario = fixture.scenarios.find(item => item.scenarioId === input.scenarioId);
  if (scenario === undefined) {
    violations.push(violation('unknown_scenario', '$', `scenario ${input.scenarioId} is not in the fixture pack`));
    return finish({ oracle: 'business-driver-input', version: '1.0.0', boundary: DRIVER_BOUNDARY, scope: 'driver-input' }, 0, violations);
  }
  const index = scenario.steps.findIndex(item => item.stepId === input.stepId);
  if (index === -1) violations.push(violation('unknown_step', '$', `step ${input.stepId} is not in the fixture`));
  const allowedIds = new Set(scenario.steps.slice(0, index + 1).map(step => step.stepId));
  for (const step of input.visibleSteps) {
    if (!allowedIds.has(step.stepId)) violations.push(violation('future_step_in_driver_input', '$', `driver input exposes future step ${step.stepId}`));
  }
  if (!input.visibleSteps.some(step => step.stepId === input.stepId)) {
    violations.push(violation('missing_current_step', '$', 'driver input does not include the current step'));
  }
  const text = serialized(input);
  if (ANSWER_FIELD_PATTERN.test(text)) violations.push(violation('answer_in_driver_input', '$', 'driver input contains answer-side fields'));
  for (const token of allBusinessVocabularyTokens()) {
    if (text.includes(token)) violations.push(violation('vocabulary_token_in_driver_input', '$', `driver input contains four-class token ${token}`));
  }
  const answerScenario = answers.scenarios.find(item => item.scenarioId === input.scenarioId);
  if (answerScenario === undefined) violations.push(violation('missing_answer_scenario', '$', 'answers for this scenario are missing'));
  return finish(
    { oracle: 'business-driver-input', version: '1.0.0', boundary: DRIVER_BOUNDARY, scope: 'driver-input' },
    input.visibleSteps.length,
    violations,
    { scenarioId: input.scenarioId, stepId: input.stepId },
  );
}

const DRIVER_BOUNDARY =
  '判定单步驱动输入边界：只允许当前步骤与更早可见历史，拒绝未来步骤、答案字段与四类 token；' +
  '不证明被测系统实际只使用了这些输入（需 H1+ 运行侧取证）。';

/** All scenario ids and their split for quick reporting. */
export function splitSummary(fixture: FixturePack): Readonly<Record<Split, number>> {
  const summary: Record<Split, number> = { DEV: 0, REG: 0, HOLDOUT: 0 };
  for (const scenario of fixture.scenarios) summary[scenario.split] += 1;
  return summary;
}


/* --------------------------- self-proof --------------------------- */

export const fixtureIsolationSelfProof = {
  name: 'business-fixture-isolation',
  version: '1.0.0',
  module: 'tests/harness/business/fixtures.ts',
  boundary:
    '扫描序列化公开 fixture：拒绝答案字段、四类 token、milestone/H/quality 标签、评估 canary 与未来步骤内容；要求 canary 只存在于答案侧；' +
    '目录分离只防误放，同机同用户目录不是秘密隔离。',
  evaluate: (input: unknown) => {
    const candidate = input as {
      mode: 'isolation' | 'tampered-fixture' | 'driver' | 'tampered-driver';
      seed?: number;
      scenarioId?: ScenarioId;
      stepId?: string;
    };
    const fixture = generateFixturePack({ seed: candidate.seed ?? DEFAULT_SEED, generatedAt: '2026-11-01T00:00:00.000Z' });
    const answers = generateAnswerPack({ seed: candidate.seed ?? DEFAULT_SEED, generatedAt: '2026-11-01T00:00:00.000Z' });
    if (candidate.mode === 'isolation') return checkFixtureIsolation(fixture, answers);
    if (candidate.mode === 'driver') {
      return checkDriverInputBoundary(fixture, answers, buildDriverInput(fixture, candidate.scenarioId ?? 'S01', candidate.stepId ?? 'S01.1'));
    }
    if (candidate.mode === 'tampered-fixture') {
      const tampered = JSON.parse(JSON.stringify(fixture)) as FixturePack;
      (tampered.scenarios[0].steps[0].event as { text: string }).text = 'leaked required token must_process_as_business';
      return checkFixtureIsolation(tampered, answers);
    }
    const scenarioId = candidate.scenarioId ?? 'S01';
    const stepId = candidate.stepId ?? 'S01.1';
    const inputValue = buildDriverInput(fixture, scenarioId, stepId);
    const scenario = fixture.scenarios.find(item => item.scenarioId === scenarioId)!;
    const index = scenario.steps.findIndex(item => item.stepId === stepId);
    const futureStep = scenario.steps[index + 1];
    const tamperedInput = {
      ...inputValue,
      visibleSteps: futureStep === undefined ? inputValue.visibleSteps : [...inputValue.visibleSteps, futureStep],
    };
    return checkDriverInputBoundary(fixture, answers, tamperedInput);
  },
  samples: [
    {
      label: 'accept-default-fixture-isolation',
      input: { mode: 'isolation' as const },
      expect: 'accept' as const,
      why: '默认公开 fixture 不含答案字段/四类 token/canary/未来步骤',
    },
    {
      label: 'accept-single-step-driver-input',
      input: { mode: 'driver' as const, scenarioId: 'FL01' as ScenarioId, stepId: 'FL01.2' },
      expect: 'accept' as const,
      why: '单步驱动输入只含当前与更早可见历史',
    },
    {
      label: 'reject-token-in-public-fixture',
      input: { mode: 'tampered-fixture' as const },
      expect: 'reject' as const,
      expectCodes: ['vocabulary_token_in_fixture'],
      why: '四类 token 混入公开 fixture 必须拒绝',
    },
    {
      label: 'reject-future-step-in-driver-input',
      input: { mode: 'tampered-driver' as const, scenarioId: 'S01' as ScenarioId, stepId: 'S01.1' },
      expect: 'reject' as const,
      expectCodes: ['future_step_in_driver_input'],
      why: '驱动输入提前暴露未来步骤必须拒绝',
    },
  ],
};
