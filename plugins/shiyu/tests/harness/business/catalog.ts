/**
 * H0c catalogue assembly + structural validation.
 *
 * The catalogue is the single source for the synthetic fixtures and their
 * independent answer sets. Validation here is deliberately strict: a broken
 * or ambiguous answer record fails the build instead of being silently
 * skipped (which would otherwise turn "no evidence" into "no violations").
 */
import { sha256Hex, type CheckResult, type JsonValue, type Violation } from '../invariant.js';
import { canonicalJsonString } from '../json.js';
import { finish, jsonPointerChild, violation } from '../invariant.js';
import { FL_SCENARIOS, EVALUATION_CANARIES } from './catalog-fl.js';
import { S_SCENARIOS } from './catalog-s.js';
import {
  ACTION_TOKENS,
  ATTENTION_TOKENS,
  EXPRESSION_TOKENS,
  HARNESS_ORACLES,
  H_DIMENSIONS,
  INTERNAL_TOKENS,
  ORACLE_KINDS,
  QUALITY_DIMENSIONS,
  SCENARIO_IDS,
  SPLITS,
  type ClassExpectation,
  type HDimension,
  type QualityDimensionId,
  type ScenarioDefinition,
  type ScenarioId,
  type StepAnswers,
} from './types.js';

export const CATALOG_VERSION = '1.0.0';
export const BUSINESS_GENERATOR_VERSION = '1.0.0';

export const ALL_SCENARIOS: readonly ScenarioDefinition[] = [...S_SCENARIOS, ...FL_SCENARIOS];

export function scenarioById(id: ScenarioId): ScenarioDefinition {
  const found = ALL_SCENARIOS.find(scenario => scenario.scenarioId === id);
  if (found === undefined) throw new Error(`unknown scenario ${id}`);
  return found;
}

export function catalogSourceFiles(): readonly string[] {
  return [
    'tests/harness/business/types.ts',
    'tests/harness/business/catalog-support.ts',
    'tests/harness/business/catalog-s.ts',
    'tests/harness/business/catalog-fl.ts',
    'tests/harness/business/catalog.ts',
  ];
}

export function allVocabularyTokens(): readonly string[] {
  return [...ATTENTION_TOKENS, ...INTERNAL_TOKENS, ...EXPRESSION_TOKENS, ...ACTION_TOKENS];
}

export const allBusinessVocabularyTokens = allVocabularyTokens;

function hasDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const value of values) {
    if (seen.has(value)) duplicates.push(value);
    seen.add(value);
  }
  return duplicates;
}

function checkClass<T extends string>(
  expectation: ClassExpectation<T>,
  vocabulary: readonly string[],
  path: string,
  violations: Violation[],
): void {
  const buckets: readonly [string, readonly T[]][] = [
    ['required', expectation.required],
    ['allowed', expectation.allowed],
    ['forbidden', expectation.forbidden],
    ['policyPending', expectation.policyPending ?? []],
  ];
  for (const [name, tokens] of buckets) {
    for (const duplicate of hasDuplicates(tokens)) {
      violations.push(violation('duplicate_token', `${path}[${JSON.stringify(name)}]`, `token ${duplicate} appears twice`));
    }
    for (const token of tokens) {
      if (!vocabulary.includes(token)) {
        violations.push(violation('unknown_token', `${path}[${JSON.stringify(name)}]`, `token ${String(token)} is not in the four-class vocabulary`));
      }
    }
  }
  for (const token of expectation.required) {
    if (expectation.forbidden.includes(token)) {
      violations.push(violation('required_forbidden_overlap', path, `token ${token} is both required and forbidden`));
    }
  }
  for (const token of expectation.allowed) {
    if (expectation.forbidden.includes(token)) {
      violations.push(violation('allowed_forbidden_overlap', path, `token ${token} is both allowed and forbidden`));
    }
  }
}

const H_SET = new Set(H_DIMENSIONS);
const QUALITY_SET = new Set(QUALITY_DIMENSIONS.map(definition => definition.id));
const SPLIT_SET = new Set(SPLITS);

export function checkAnswers(step: StepAnswers, path: string, violations: Violation[]): void {
  if (step.stepId.length === 0) violations.push(violation('missing_step_id', path, 'stepId is required'));
  if (step.routes.length === 0) violations.push(violation('missing_routes', path, 'route marks are required'));
  if (step.hDimensions.length === 0) violations.push(violation('missing_h_dimensions', path, 'at least one H dimension is required'));
  if (step.evidenceRefs.length === 0) violations.push(violation('missing_evidence_refs', path, 'evidence refs are required'));
  checkClass(step.attention, ATTENTION_TOKENS, `${path}.attention`, violations);
  checkClass(step.internal, INTERNAL_TOKENS, `${path}.internal`, violations);
  checkClass(step.expression, EXPRESSION_TOKENS, `${path}.expression`, violations);
  checkClass(step.action, ACTION_TOKENS, `${path}.action`, violations);
  for (const dimension of step.hDimensions) {
    if (!H_SET.has(dimension)) violations.push(violation('unknown_h_dimension', path, `unknown H dimension ${dimension}`));
  }
  for (const dimension of step.quality?.applicable ?? []) {
    if (!QUALITY_SET.has(dimension as QualityDimensionId)) violations.push(violation('unknown_quality_dimension', path, `unknown quality dimension ${dimension}`));
  }
  const oracleIds = new Set<string>(HARNESS_ORACLES);
  for (const check of step.oracleChecks) {
    if (!(ORACLE_KINDS as readonly string[]).includes(check.kind)) {
      violations.push(violation('unknown_oracle_kind', path, `unknown oracle kind ${String(check.kind)}`));
    }
    if (check.kind === 'harness-oracle' && !oracleIds.has(check.oracle)) {
      violations.push(violation('unknown_harness_oracle', path, `unknown harness oracle ${check.oracle}`));
    }
  }
}

export function checkScenarioStructure(scenario: ScenarioDefinition, path: string, violations: Violation[]): void {
  if (!SCENARIO_IDS.includes(scenario.scenarioId)) violations.push(violation('unknown_scenario_id', path, `unknown scenario ${scenario.scenarioId}`));
  if (!SPLIT_SET.has(scenario.split)) violations.push(violation('invalid_split', path, `invalid split ${scenario.split}`));
  if (scenario.familyId.trim().length === 0) violations.push(violation('missing_family', path, 'familyId is required'));
  if (scenario.source.sourcePath.trim().length === 0) violations.push(violation('missing_source_path', path, 'source path is required'));
  if (scenario.steps.length === 0) violations.push(violation('empty_scenario', path, 'scenario has no materialised steps'));
  const milestoneIds = new Set(scenario.milestones.map(item => item.id));
  const stepIds = scenario.steps.map(step => step.stepId);
  for (const duplicate of hasDuplicates(stepIds)) violations.push(violation('duplicate_step_id', path, `duplicate step id ${duplicate}`));
  if (new Set(scenario.publicSteps.map(step => step.stepId)).size !== scenario.publicSteps.length) {
    violations.push(violation('duplicate_public_step_id', path, 'public steps contain duplicate ids'));
  }
  if (scenario.publicSteps.length !== scenario.steps.length) {
    violations.push(violation('public_step_count_mismatch', path, `public steps ${scenario.publicSteps.length} != answer steps ${scenario.steps.length}`));
  }
  scenario.steps.forEach((step, index) => {
    const stepPath = jsonPointerChild(`${path}.steps`, index);
    checkAnswers(step, stepPath, violations);
    if (!step.stepId.startsWith(scenario.scenarioId)) {
      violations.push(violation('step_prefix_mismatch', stepPath, `step ${step.stepId} does not belong to ${scenario.scenarioId}`));
    }
    for (const milestone of step.milestones) {
      if (!milestoneIds.has(milestone)) violations.push(violation('unknown_milestone_ref', stepPath, `unknown milestone ${milestone}`));
    }
    const publicStep = scenario.publicSteps[index];
    if (publicStep === undefined) return;
    if (publicStep.stepId !== step.stepId) {
      violations.push(violation('public_step_mismatch', stepPath, `public step ${publicStep.stepId} != answer step ${step.stepId} at index ${index}`));
    }
    if (publicStep.index !== index + 1) violations.push(violation('public_step_order_mismatch', `${stepPath}.index`, `expected index ${index + 1}, got ${publicStep.index}`));
    if (publicStep.event.text.trim().length === 0) violations.push(violation('missing_public_text', `${stepPath}.event`, 'public event text is required'));
    for (const historyId of publicStep.visibleHistory) {
      const historyIndex = scenario.publicSteps.findIndex(item => item.stepId === historyId);
      if (historyIndex === -1) violations.push(violation('unknown_visible_history', stepPath, `visible history ${historyId} is not a public step`));
      else if (historyIndex >= index) violations.push(violation('future_content_visible', stepPath, `visible history ${historyId} is not earlier than current step`));
    }
  });
  for (const milestone of scenario.milestones) {
    if (milestone.scenarioId !== scenario.scenarioId) violations.push(violation('milestone_scenario_mismatch', path, `milestone ${milestone.id} belongs to ${milestone.scenarioId}`));
    if (milestone.evidenceHints.length === 0) violations.push(violation('milestone_without_evidence', path, `milestone ${milestone.id} needs evidence hints`));
    for (const hint of milestone.evidenceHints) {
      if (!stepIds.includes(hint) && !scenario.designStepIds.includes(hint)) {
        violations.push(violation('milestone_unknown_step', path, `milestone ${milestone.id} references unknown step ${hint}`));
      }
    }
  }
  const materialized = new Set(scenario.materializedStepIds);
  const design = new Set(scenario.designStepIds);
  const designBase = (id: string): string => id.replace(/[A-Z]$/, '');
  const coversDesign = (materializedId: string): boolean => design.has(materializedId) || design.has(designBase(materializedId));
  for (const id of scenario.materializedStepIds) {
    if (scenario.designStepIds.length > 0 && !coversDesign(id)) {
      violations.push(violation('materialized_step_not_in_design', path, `${id} is materialised but not in design steps`));
    }
    if (!stepIds.includes(id)) violations.push(violation('materialized_step_missing', path, `${id} is listed as materialised but has no answer record`));
  }
  for (const id of scenario.uncoveredDesignStepIds) {
    if (materialized.has(id) || [...materialized].some(materializedId => designBase(materializedId) === id)) {
      violations.push(violation('uncovered_step_materialized', path, `${id} is both uncovered and materialised`));
    }
    if (!design.has(id)) violations.push(violation('uncovered_step_not_in_design', path, `${id} is uncovered but not in design steps`));
  }
  if (scenario.source.kind === 'case-doc' && scenario.source.existingStepCount === 0) {
    violations.push(violation('case_doc_without_steps', path, 'case-doc source must declare its existing step count'));
  }
  if (scenario.source.kind === 'matrix-only' && scenario.source.existingStepCount !== 0) {
    violations.push(violation('matrix_only_claims_steps', path, 'matrix-only source must not claim existing steps'));
  }
  if (scenario.variants.length === 0) violations.push(violation('missing_variants', path, 'at least one variant contract is required'));
  if (!scenario.variants.some(item => item.expectation === 'same_allowed_answers')) violations.push(violation('missing_same_answer_variant', path, 'needs an answer-invariant variant'));
  if (!scenario.variants.some(item => item.expectation === 'changed_allowed_answers')) violations.push(violation('missing_changed_answer_variant', path, 'needs an answer-changing variant'));
  if (scenario.variants.some(item => item.materialised !== false)) violations.push(violation('variant_materialised_claim', path, 'H0c variants must be declared unmaterialised'));
}

export function checkCatalogIntegrity(scenarios: readonly ScenarioDefinition[] = ALL_SCENARIOS): CheckResult {
  const violations: Violation[] = [];
  const ids = scenarios.map(scenario => scenario.scenarioId);
  for (const duplicate of hasDuplicates(ids)) violations.push(violation('duplicate_scenario', '$', `duplicate scenario ${duplicate}`));
  for (const required of SCENARIO_IDS) {
    if (!ids.includes(required)) violations.push(violation('missing_scenario', '$', `scenario ${required} is not materialised`));
  }
  scenarios.forEach((scenario, index) => checkScenarioStructure(scenario, jsonPointerChild('$["scenarios"]', index), violations));
  return finish(
    {
      oracle: 'business-catalog',
      version: '1.0.0',
      boundary:
        '判定 S/FL 目录结构：16 个场景齐全、公开步骤与答案步骤一一对应、四类词表合法、milestone/变体/split 结构完整。' +
        '不证明业务语义正确，也不表示任何场景已运行。',
      scope: 'sfl-catalog',
    },
    scenarios.length,
    violations,
    {
      scenarios: scenarios.length,
      steps: scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0),
      designSteps: scenarios.reduce((sum, scenario) => sum + scenario.designStepIds.length, 0),
    },
  );
}

/** Answer-side semantic projection: seed-independent, used for freeze digests. */
export function answerSemanticProjection(scenarios: readonly ScenarioDefinition[] = ALL_SCENARIOS): JsonValue {
  return scenarios.map(scenario => ({
    scenarioId: scenario.scenarioId,
    familyId: scenario.familyId,
    split: scenario.split,
    source: {
      sourcePath: scenario.source.sourcePath,
      kind: scenario.source.kind,
      existingStepCount: scenario.source.existingStepCount,
    },
    steps: scenario.steps.map(step => ({
      stepId: step.stepId,
      attention: { required: step.attention.required, allowed: step.attention.allowed, forbidden: step.attention.forbidden, policyPending: step.attention.policyPending ?? [] },
      internal: { required: step.internal.required, allowed: step.internal.allowed, forbidden: step.internal.forbidden, policyPending: step.internal.policyPending ?? [] },
      expression: {
        required: step.expression.required,
        allowed: step.expression.allowed,
        forbidden: step.expression.forbidden,
        policyPending: step.expression.policyPending ?? [],
        allowedAudiences: step.expression.allowedAudiences ?? [],
        forbiddenAudiences: step.expression.forbiddenAudiences ?? [],
      },
      action: { required: step.action.required, allowed: step.action.allowed, forbidden: step.action.forbidden, policyPending: step.action.policyPending ?? [] },
      routes: step.routes,
      counts: step.counts,
      oracleChecks: step.oracleChecks,
      milestones: step.milestones,
      hDimensions: step.hDimensions,
      quality: step.quality ?? null,
      policyPending: step.policyPending ?? [],
      evidenceRefs: step.evidenceRefs,
    })),
    milestones: scenario.milestones,
    variants: scenario.variants,
  })) as unknown as JsonValue;
}

export function semanticAnswersDigest(scenarios: readonly ScenarioDefinition[] = ALL_SCENARIOS): string {
  return sha256Hex(canonicalJsonString(answerSemanticProjection(scenarios)));
}

/**
 * Catalog digest used to identify the generated fixture/answer pack. Includes
 * the public inputs and the answer projection so regenerating after any edit
 * changes the digest.
 */
export function catalogDigest(scenarios: readonly ScenarioDefinition[] = ALL_SCENARIOS): string {
  const projection: JsonValue = scenarios.map(scenario => ({
    scenarioId: scenario.scenarioId,
    familyId: scenario.familyId,
    split: scenario.split,
    title: scenario.title,
    source: { sourcePath: scenario.source.sourcePath, kind: scenario.source.kind, existingStepCount: scenario.source.existingStepCount },
    preconditions: scenario.preconditions as JsonValue,
    publicSteps: scenario.publicSteps as unknown as JsonValue,
    answers: answerSemanticProjection([scenario]) as JsonValue,
  })) as unknown as JsonValue;
  return sha256Hex(canonicalJsonString(projection));
}

export const EVALUATION_ONLY_CANARIES: readonly string[] = EVALUATION_CANARIES;

export type { ScenarioDefinition, ScenarioId, HDimension };

/* --------------------------- self-proof --------------------------- */

export const catalogSelfProof = {
  name: 'business-catalog',
  version: '1.0.0',
  module: 'tests/harness/business/catalog.ts',
  boundary:
    '判定 S/FL 目录结构：16 个场景齐全、公开步骤与答案步骤一一对应、四类词表合法、milestone/变体/split 结构完整。' +
    '不证明业务语义正确，也不表示任何场景已运行。',
  evaluate: (input: unknown) => {
    const { scenarios } = input as { scenarios: ScenarioDefinition[] };
    return checkCatalogIntegrity(scenarios);
  },
  samples: [
    {
      label: 'accept-full-catalog',
      input: { scenarios: ALL_SCENARIOS as ScenarioDefinition[] },
      expect: 'accept' as const,
      why: '16 个场景、全部代表步骤与四类答案结构完整',
    },
    {
      label: 'reject-unknown-four-class-token',
      input: {
        scenarios: JSON.parse(JSON.stringify(ALL_SCENARIOS)) as ScenarioDefinition[],
        mutate: 'unknown-token',
      },
      expect: 'reject' as const,
      expectCodes: ['unknown_token'],
      why: '四类词表外的 token 必须被拒绝',
    },
    {
      label: 'reject-public-future-content',
      input: { scenarios: JSON.parse(JSON.stringify(ALL_SCENARIOS)) as ScenarioDefinition[], mutate: 'future-history' },
      expect: 'reject' as const,
      expectCodes: ['future_content_visible'],
      why: '公开步骤把未来步骤列为可见历史时拒绝',
    },
  ],
};

// The sample `mutate` marker is applied by the evaluate wrapper so the negative
// samples stay readable. This keeps the oracle deterministic and side-effect free.
const baseCatalogEvaluate = catalogSelfProof.evaluate;
catalogSelfProof.evaluate = (input: unknown) => {
  const candidate = input as { scenarios: ScenarioDefinition[]; mutate?: string };
  const scenarios = candidate.scenarios;
  if (candidate.mutate === 'unknown-token') {
    const tampered = JSON.parse(JSON.stringify(scenarios)) as ScenarioDefinition[];
    const step = tampered[0].steps[0] as unknown as { attention: { required: string[] } };
    step.attention.required = [...step.attention.required, 'not_a_four_class_token'];
    return checkCatalogIntegrity(tampered);
  }
  if (candidate.mutate === 'future-history') {
    const tampered = JSON.parse(JSON.stringify(scenarios)) as ScenarioDefinition[];
    const publicSteps = tampered[0].publicSteps as unknown as { visibleHistory: string[] }[];
    publicSteps[0].visibleHistory = [publicSteps[1].visibleHistory[0] ?? tampered[0].steps[1].stepId];
    // Point the first public step at a later step to simulate pre-exposed future content.
    publicSteps[0].visibleHistory = [tampered[0].publicSteps[1].stepId];
    return checkCatalogIntegrity(tampered);
  }
  return baseCatalogEvaluate(input);
};
