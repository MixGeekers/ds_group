/**
 * H7-acceptance: full acceptance tracking + gate runner.
 *
 * It joins four machine-readable inputs — the 40-module registry from
 * `架构与设计/A方案全景/目录.md`, the committed traceability matrix
 * (systems/V/S/FL product rows + evidence layers), the self-proof artifact,
 * the run manifest and the H0c scenario coverage — and produces:
 * - `acceptance-report.json`: per system/module/V/S/FL status, evidence refs,
 *   denominators (planned/executed/passed/failed/unknown/blocked/skipped/
 *   notRun/notApplicable), blocked-resource list and an honest gate;
 * - `acceptance-report.md`: the same for human review.
 *
 * Hard rules:
 * - no dimension can be `passed`/`complete` in H7-prep: there has been no
 *   product acceptance run, so executed/passed/failed are 0;
 * - limited evidence, `tooling_ready`, `not_covered`, `unknown` and `blocked`
 *   never count as acceptance pass;
 * - H0c scenarios keep `synthetic-fixture-only-not-run` and
 *   `canUseForBusinessAcceptance=false` unchanged;
 * - the gate always reports `completeNineSystems=false`; missing inputs are
 *   `unknown`, not silently omitted.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult, JsonValue, Violation } from './invariant.js';
import { finish, sha256Hex, violation } from './invariant.js';
import { BUSINESS_SCENARIO_ROWS, FL_SCENARIO_ROWS, NINE_SYSTEM_ROWS, V_ITEM_ROWS } from './traceability-registry.js';
import { ALL_SCENARIOS } from './business/index.js';
import type { CoverageIndex } from './business/coverage.js';
import type { TraceabilityMatrix } from './traceability.js';
import type { SelfProofArtifact } from './selfproof.js';
import type { HarnessManifest } from './manifest.js';
import {
  BLOCKED_RESOURCES,
  BLOCKED_RESOURCE_BY_ID,
  MODULE_AREAS,
  MODULE_DEFINITIONS,
  MODULE_REGISTRY_VERSION,
  SCENARIO_RESOURCE_BLOCKS,
  V_RESOURCE_BLOCKS,
  systemIds,
  type BlockedResource,
  type ModuleDefinition,
  type SystemId,
} from './acceptance-registry.js';
import { EVIDENCE_SOURCES, type EvaluatedRowEvidence, type EvidenceVerificationReport } from './evidence.js';

export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const ACCEPTANCE_KIND = 'shiyu.harness.acceptance-report';
export const ACCEPTANCE_REPORT_JSON = 'acceptance-report.json';
export const ACCEPTANCE_REPORT_MARKDOWN = 'acceptance-report.md';

export type ModuleStatus = 'not_covered' | 'limited-only' | 'unknown' | 'blocked';
export type DimensionStatus = 'not-covered' | 'limited-evidence-only' | 'unknown' | 'blocked' | 'synthetic-fixture-only-not-run';

export interface AcceptanceDenominators {
  readonly planned: number;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly unknown: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly notRun: number;
  readonly notApplicable: number;
}

export interface ModuleAcceptanceRow {
  readonly id: string;
  readonly title: string;
  readonly areaId: string;
  readonly graphId: string;
  readonly systems: readonly SystemId[];
  readonly status: ModuleStatus;
  readonly evidenceSourceIds: readonly string[];
  readonly evidenceRefs: readonly { readonly sourceId: string; readonly status: 'verified' | 'unknown'; readonly levels: readonly string[]; readonly files: readonly { readonly path: string; readonly sha256: string }[] }[];
  readonly codePaths: readonly { readonly path: string; readonly exists: boolean }[];
  readonly testIds: readonly { readonly id: string; readonly exists: boolean }[];
  readonly oracles: readonly string[];
  readonly blockedResourceIds: readonly string[];
  readonly limitations: readonly string[];
  readonly notes: readonly string[];
  readonly source: { readonly docPath: string; readonly docRowPresent: boolean; readonly readmePresent: boolean };
}

export interface SystemAcceptanceRow {
  readonly id: string;
  readonly title: string;
  readonly modules: readonly string[];
  readonly vRefs: readonly string[];
  readonly scenarioRefs: readonly string[];
  readonly status: DimensionStatus;
  readonly evidenceLevels: readonly string[];
  readonly evidenceSourceIds: readonly string[];
  readonly limitations: readonly string[];
  readonly gaps: readonly string[];
}

export interface VAcceptanceRow {
  readonly id: string;
  readonly title: string;
  readonly systems: readonly string[];
  readonly thresholds: readonly string[];
  readonly status: DimensionStatus;
  readonly evidenceLevels: readonly string[];
  readonly evidenceSourceIds: readonly string[];
  readonly limitations: readonly string[];
  readonly blockedResourceIds: readonly string[];
  readonly sourceHeadingPresent: boolean;
}

export interface ScenarioAcceptanceRow {
  readonly id: string;
  readonly kind: 'S' | 'FL';
  readonly title: string;
  readonly systems: readonly string[];
  readonly status: 'synthetic-fixture-only-not-run';
  readonly syntheticFixtureOnlyNotRun: true;
  readonly canUseForBusinessAcceptance: false;
  readonly coverageFlagsPropagated: boolean;
  readonly systemsMappedFromV: readonly string[];
  readonly blockedResourceIds: readonly string[];
  readonly gaps: readonly string[];
}

export interface BlockedResourceReport {
  readonly id: string;
  readonly title: string;
  readonly prerequisite: string;
  readonly blocks: string;
  readonly blocksModules: readonly string[];
  readonly blocksVItems: readonly string[];
  readonly blocksScenarios: readonly string[];
}

export interface AcceptanceReport {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly generatedAt: string;
  readonly registryVersion: string;
  readonly inputs: {
    readonly pluginRoot: string;
    readonly workspaceRoot: string;
    readonly traceabilitySha256: string | null;
    readonly selfproofSha256: string | null;
    readonly manifestSha256: string | null;
    readonly coverageSha256: string | null;
    readonly frozenHead: string | null;
    readonly selfproofPassed: boolean | null;
    readonly manifestDirty: boolean | null;
  };
  readonly summary: {
    readonly areas: number;
    readonly modules: number;
    readonly systems: number;
    readonly vItems: number;
    readonly scenarios: number;
    readonly denominators: AcceptanceDenominators;
    readonly byScope: Readonly<Record<'modules' | 'systems' | 'vItems' | 'scenarios', AcceptanceDenominators>>;
  };
  readonly modules: readonly ModuleAcceptanceRow[];
  readonly systems: readonly SystemAcceptanceRow[];
  readonly vItems: readonly VAcceptanceRow[];
  readonly scenarios: readonly ScenarioAcceptanceRow[];
  readonly mapping: {
    readonly systemToModules: Readonly<Record<string, readonly string[]>>;
    readonly moduleToSystems: Readonly<Record<string, readonly string[]>>;
    readonly systemToV: Readonly<Record<string, readonly string[]>>;
    readonly systemToScenarios: Readonly<Record<string, readonly string[]>>;
    readonly moduleCountByArea: Readonly<Record<string, number>>;
    readonly missingMappings: readonly string[];
  };
  readonly gate: {
    readonly overall: 'incomplete';
    readonly completeNineSystems: false;
    readonly completedDimensions: readonly string[];
    readonly reasons: readonly string[];
    readonly cannotClaim: readonly string[];
    readonly blockedResources: readonly BlockedResourceReport[];
  };
  readonly issues: readonly { readonly code: string; readonly message: string; readonly ref?: string }[];
}

export interface AcceptanceInputs {
  readonly pluginRoot: string;
  readonly workspaceRoot: string;
  readonly generatedAt: string;
  readonly traceability: TraceabilityMatrix | null;
  readonly traceabilitySha256?: string | null;
  readonly selfproof: SelfProofArtifact | null;
  readonly selfproofSha256?: string | null;
  readonly manifest: HarnessManifest | null;
  readonly manifestSha256?: string | null;
  readonly coverage: CoverageIndex | null;
  readonly coverageSha256?: string | null;
  readonly evidence: EvidenceVerificationReport | null;
  /** Pre-loaded documents (CLI reads them); tests may pass synthetic text. */
  readonly documents: {
    readonly moduleCatalog: string;
    readonly acceptanceDoc: string;
  };
}

const ACCEPTANCE_ORACLE = 'acceptance';
const ACCEPTANCE_VERSION = '1.0.0';

function denominatorFor(statuses: readonly string[], planned: number): AcceptanceDenominators {
  const blocked = statuses.filter(status => status === 'blocked').length;
  const unknown = statuses.filter(status => status === 'unknown').length;
  const notRun = planned - blocked - unknown;
  return { planned, executed: 0, passed: 0, failed: 0, unknown, blocked, skipped: 0, notRun: Math.max(0, notRun), notApplicable: 0 };
}

function addDenominators(left: AcceptanceDenominators, right: AcceptanceDenominators): AcceptanceDenominators {
  return {
    planned: left.planned + right.planned,
    executed: left.executed + right.executed,
    passed: left.passed + right.passed,
    failed: left.failed + right.failed,
    unknown: left.unknown + right.unknown,
    blocked: left.blocked + right.blocked,
    skipped: left.skipped + right.skipped,
    notRun: left.notRun + right.notRun,
    notApplicable: left.notApplicable + right.notApplicable,
  };
}

function checkDenominator(denominator: AcceptanceDenominators): string[] {
  const issues: string[] = [];
  const sum = denominator.executed + denominator.unknown + denominator.blocked + denominator.skipped + denominator.notRun + denominator.notApplicable;
  if (sum !== denominator.planned) issues.push(`denominator ${denominator.planned} != executed+unknown+blocked+skipped+notRun+notApplicable (${sum})`);
  if (denominator.passed > denominator.executed) issues.push('passed exceeds executed');
  if (denominator.failed > denominator.executed) issues.push('failed exceeds executed');
  if (denominator.passed + denominator.failed > denominator.executed) issues.push('passed+failed exceeds executed');
  return issues;
}

/* ------------------------------------------------------------------ */
/* Evidence row helpers.                                               */
/* ------------------------------------------------------------------ */

function rowEvidenceById(traceability: TraceabilityMatrix | null): Map<string, EvaluatedRowEvidence> {
  const map = new Map<string, EvaluatedRowEvidence>();
  if (traceability === null) return map;
  for (const row of traceability.evidenceMapping.rows) map.set(row.rowId, row);
  return map;
}

function dimensionStatus(row: EvaluatedRowEvidence | undefined, missing: DimensionStatus = 'unknown'): DimensionStatus {
  if (row === undefined) return missing;
  if (row.state === 'unknown') return 'unknown';
  if (row.state === 'limited-only') return 'limited-evidence-only';
  if (row.state === 'invalid') return 'unknown';
  return 'not-covered';
}

function vRowStatus(row: EvaluatedRowEvidence | undefined, blocked: readonly string[]): DimensionStatus {
  if (blocked.length > 0) return 'blocked';
  return dimensionStatus(row, 'not-covered');
}

/* ------------------------------------------------------------------ */
/* Builder.                                                            */
/* ------------------------------------------------------------------ */

export async function buildAcceptanceReport(inputs: AcceptanceInputs): Promise<{ report: AcceptanceReport; result: CheckResult }> {
  const issues: { code: string; message: string; ref?: string }[] = [];
  const pluginRoot = resolve(inputs.pluginRoot);
  const workspaceRoot = resolve(inputs.workspaceRoot);
  const evidenceVerification = inputs.evidence;
  const evidenceById = new Map((evidenceVerification?.sources ?? []).map(source => [source.id, source]));
  const traceability = inputs.traceability;
  const evidenceRows = rowEvidenceById(traceability);
  const productRowById = new Map((traceability?.rows ?? []).map(row => [row.id, row]));
  const vRows = V_ITEM_ROWS;
  const moduleCatalog = inputs.documents.moduleCatalog;
  const acceptanceDoc = inputs.documents.acceptanceDoc;

  // ---------- areas + modules ----------
  const areaIds = new Set(MODULE_AREAS.map(area => area.id));
  const moduleIds = new Set(MODULE_DEFINITIONS.map(module => module.id));
  if (MODULE_AREAS.length !== 12) issues.push({ code: 'area_count_mismatch', message: `expected 12 areas, found ${MODULE_AREAS.length}` });
  if (MODULE_DEFINITIONS.length !== 40) issues.push({ code: 'module_count_mismatch', message: `expected 40 modules, found ${MODULE_DEFINITIONS.length}` });
  if (moduleIds.size !== MODULE_DEFINITIONS.length) issues.push({ code: 'module_not_unique', message: 'duplicate module ids in registry' });
  if (areaIds.size !== MODULE_AREAS.length) issues.push({ code: 'area_not_unique', message: 'duplicate area ids in registry' });

  const moduleRows: ModuleAcceptanceRow[] = [];
  for (const module of MODULE_DEFINITIONS) {
    if (!areaIds.has(module.areaId)) issues.push({ code: 'module_unknown_area', message: `${module.id} references unknown area ${module.areaId}`, ref: module.id });
    if (module.systems.length === 0) issues.push({ code: 'module_without_system', message: `${module.id} has no system mapping`, ref: module.id });
    if (!moduleCatalog.includes(module.docRow)) issues.push({ code: 'module_doc_row_missing', message: `${module.id} doc row ${module.docRow} not found in 目录.md`, ref: module.id });
    if (!moduleCatalog.includes(module.title)) issues.push({ code: 'module_doc_title_missing', message: `${module.id} title ${module.title} not found in 目录.md`, ref: module.id });
    const readmePresent = existsSync(join(workspaceRoot, module.docPath));
    if (!readmePresent) issues.push({ code: 'module_readme_missing', message: `${module.id} README ${module.docPath} is absent`, ref: module.id });
    const codePaths = module.codePaths.map(path => {
      const exists = existsSync(join(pluginRoot, path));
      if (!exists) issues.push({ code: 'module_code_path_missing', message: `${module.id} declared code path ${path} is absent`, ref: module.id });
      return { path, exists };
    });
    const testIds = module.testIds.map(id => {
      const exists = existsSync(join(pluginRoot, id));
      if (!exists) issues.push({ code: 'module_test_id_missing', message: `${module.id} declared test id ${id} is absent`, ref: module.id });
      return { id, exists };
    });
    for (const sourceId of module.evidenceSourceIds) {
      if (!(EVIDENCE_SOURCES as readonly { id: string }[]).some(source => source.id === sourceId)) {
        issues.push({ code: 'module_unknown_evidence_source', message: `${module.id} references unknown evidence source ${sourceId}`, ref: module.id });
      }
    }
    for (const resourceId of module.blockedResourceIds) {
      if (!BLOCKED_RESOURCE_BY_ID.has(resourceId)) issues.push({ code: 'module_unknown_blocked_resource', message: `${module.id} references unknown blocked resource ${resourceId}`, ref: module.id });
    }
    const evidenceRefs = module.evidenceSourceIds.map(sourceId => {
      const source = evidenceById.get(sourceId);
      if (source === undefined) {
        issues.push({ code: 'module_evidence_unknown', message: `${module.id} evidence source ${sourceId} is not verified (evidence report missing or unknown)`, ref: module.id });
        return { sourceId, status: 'unknown' as const, levels: [] as string[], files: [] as { path: string; sha256: string }[] };
      }
      return {
        sourceId,
        status: source.status,
        levels: source.levels as string[],
        files: source.files.map(file => ({ path: file.path, sha256: file.sha256 })),
      };
    });
    const hasUnknownEvidence = evidenceRefs.some(ref => ref.status === 'unknown');
    const hasVerifiedEvidence = evidenceRefs.some(ref => ref.status === 'verified');
    const declaredPathMissing = codePaths.some(item => !item.exists) || testIds.some(item => !item.exists);
    let status: ModuleStatus;
    if (module.blockedResourceIds.length > 0) status = 'blocked';
    else if (hasUnknownEvidence || declaredPathMissing) status = 'unknown';
    else if (hasVerifiedEvidence) status = 'limited-only';
    else status = 'not_covered';
    const limitations = [
      ...module.notes,
      ...evidenceRefs.flatMap(ref => (evidenceById.get(ref.sourceId)?.limitations ?? [])),
    ];
    moduleRows.push({
      id: module.id,
      title: module.title,
      areaId: module.areaId,
      graphId: module.graphId,
      systems: module.systems,
      status,
      evidenceSourceIds: module.evidenceSourceIds,
      evidenceRefs,
      codePaths,
      testIds,
      oracles: module.oracles,
      blockedResourceIds: module.blockedResourceIds,
      limitations: [...new Set(limitations)],
      notes: module.notes,
      source: { docPath: module.docPath, docRowPresent: moduleCatalog.includes(module.docRow), readmePresent },
    });
  }

  // ---------- systems ----------
  const systemRows: SystemAcceptanceRow[] = systemIds().map(system => {
    const modules = modulesForSystemSafe(system);
    const systemRequirement = NINE_SYSTEM_ROWS.find(row => row.id === `SYS.${system}`);
    const evidenceRow = evidenceRows.get(`SYS.${system}`);
    const state = dimensionStatus(evidenceRow);
    const evidenceLevels = evidenceRow?.levels ?? [];
    const scenarioRefs = scenarioRowsForSystem(system, vRows);
    return {
      id: `SYS.${system}`,
      title: systemRequirement?.title ?? `系统 ${system}`,
      modules: modules.map(module => module.id),
      vRefs: systemRequirement?.refs.v ?? [],
      scenarioRefs,
      status: state,
      evidenceLevels,
      evidenceSourceIds: evidenceRow?.sources.map(source => source.id) ?? [],
      limitations: evidenceRow?.limitations ?? [],
      gaps: [
        'H7-prep 没有产品/宿主/模型/业务验收执行（executed=0）',
        ...(evidenceRow === undefined ? ['无已提交证据层映射'] : ['仅有限工具/模块证据，不是完整系统验收']),
      ],
    };
  });
  for (const system of systemIds()) {
    const modules = modulesForSystemSafe(system);
    if (modules.length === 0) issues.push({ code: 'system_without_modules', message: `system ${system} has no mapped modules` });
  }
  for (const system of systemIds()) {
    const scenarios = systemRows.find(row => row.id === `SYS.${system}`)?.scenarioRefs ?? [];
    if (scenarios.length === 0) issues.push({ code: 'system_without_scenarios', message: `system ${system} has no S/FL scenario mapping` });
  }

  // ---------- V items ----------
  if (vRows.length !== 27) issues.push({ code: 'v_item_count_mismatch', message: `expected 27 V items, found ${vRows.length}` });
  const vIdSet = new Set(vRows.map(row => row.id));
  if (vIdSet.size !== vRows.length) issues.push({ code: 'v_item_not_unique', message: 'duplicate V ids' });
  const expectedVIds = Array.from({ length: 27 }, (_unused, index) => `V${String(index + 1).padStart(2, '0')}`);
  for (const id of expectedVIds) if (!vIdSet.has(id)) issues.push({ code: 'v_item_missing', message: `V item ${id} missing (no renumbering allowed)` });
  const vAcceptanceRows: VAcceptanceRow[] = vRows.map(row => {
    const sourceHeadingPresent = acceptanceDoc.includes(row.source.heading) && acceptanceDoc.includes(row.source.contains);
    if (!sourceHeadingPresent) issues.push({ code: 'v_source_heading_missing', message: `${row.id} source heading/row not found in 验证与验收.md`, ref: row.id });
    if (row.thresholds.length === 0) issues.push({ code: 'v_threshold_missing', message: `${row.id} has no frozen threshold summary`, ref: row.id });
    const blocked = V_RESOURCE_BLOCKS[row.id] ?? [];
    const evidenceRow = evidenceRows.get(row.id);
    return {
      id: row.id,
      title: row.title,
      systems: row.systems,
      thresholds: row.thresholds,
      status: vRowStatus(evidenceRow, blocked),
      evidenceLevels: evidenceRow?.levels ?? [],
      evidenceSourceIds: evidenceRow?.sources.map(source => source.id) ?? [],
      limitations: evidenceRow?.limitations ?? [],
      blockedResourceIds: blocked,
      sourceHeadingPresent,
    };
  });

  // ---------- scenarios (H0c skeleton flags must propagate) ----------
  const coverageById = new Map((inputs.coverage?.rows ?? []).map(row => [row.scenarioId, row]));
  const scenarioAcceptanceRows: ScenarioAcceptanceRow[] = ALL_SCENARIOS.map(scenario => {
    const coverageRow = coverageById.get(scenario.scenarioId);
    const expectedStatus = 'synthetic-fixture-only-not-run';
    const syntheticFixtureOnlyNotRun = true as const;
    const canUse = false as const;
    let flagsPropagated = true;
    if (coverageRow === undefined) {
      flagsPropagated = false;
      issues.push({ code: 'scenario_coverage_missing', message: `${scenario.scenarioId} has no H0c coverage row (flags cannot be propagated)`, ref: scenario.scenarioId });
    } else {
      if (coverageRow.verificationStatus !== expectedStatus) {
        flagsPropagated = false;
        issues.push({ code: 'scenario_status_upgraded', message: `${scenario.scenarioId} coverage status ${coverageRow.verificationStatus} != ${expectedStatus}`, ref: scenario.scenarioId });
      }
      if (coverageRow.cannotUseForBusinessAcceptance !== true) {
        flagsPropagated = false;
        issues.push({ code: 'scenario_cannot_use_flag_missing', message: `${scenario.scenarioId} cannotUseForBusinessAcceptance is not true`, ref: scenario.scenarioId });
      }
    }
    const traceabilityRow = productRowById.get(scenario.scenarioId);
    const systems = new Set<string>();
    for (const vRef of traceabilityRow?.refs.v ?? []) {
      const vRow = vRows.find(item => item.id === vRef);
      for (const system of vRow?.systems ?? []) systems.add(system);
    }
    if (systems.size === 0) issues.push({ code: 'scenario_without_system_mapping', message: `${scenario.scenarioId} cannot be mapped to a system via V refs`, ref: scenario.scenarioId });
    return {
      id: scenario.scenarioId,
      kind: scenario.scenarioId.startsWith('FL') ? 'FL' : 'S',
      title: scenario.title,
      systems: [...systems].sort(),
      status: 'synthetic-fixture-only-not-run',
      syntheticFixtureOnlyNotRun,
      canUseForBusinessAcceptance: canUse,
      coverageFlagsPropagated: flagsPropagated,
      systemsMappedFromV: [...systems].sort(),
      blockedResourceIds: SCENARIO_RESOURCE_BLOCKS,
      gaps: [
        'H0c 仅为合成 fixture/答案骨架：synthetic-fixture-only-not-run',
        '不是 HOLDOUT、无双人盲评、无真实业务运行',
      ],
    };
  });
  if (scenarioAcceptanceRows.length !== 16) issues.push({ code: 'scenario_count_mismatch', message: `expected 16 S/FL scenarios, found ${scenarioAcceptanceRows.length}` });

  // ---------- mapping ----------
  const systemToModules: Record<string, string[]> = {};
  const moduleToSystems: Record<string, string[]> = {};
  const systemToV: Record<string, string[]> = {};
  const systemToScenarios: Record<string, string[]> = {};
  for (const system of systemIds()) {
    systemToModules[system] = moduleRows.filter(module => module.systems.includes(system)).map(module => module.id);
    systemToV[system] = vAcceptanceRows.filter(row => row.systems.includes(system)).map(row => row.id);
    systemToScenarios[system] = scenarioAcceptanceRows.filter(row => row.systems.includes(system)).map(row => row.id);
  }
  for (const module of moduleRows) moduleToSystems[module.id] = [...module.systems];
  const moduleCountByArea: Record<string, number> = {};
  for (const area of MODULE_AREAS) moduleCountByArea[area.id] = moduleRows.filter(module => module.areaId === area.id).length;
  const missingMappings: string[] = [];
  for (const module of moduleRows) if ((moduleToSystems[module.id] ?? []).length === 0) missingMappings.push(`module:${module.id}`);
  for (const system of systemIds()) {
    if ((systemToModules[system] ?? []).length === 0) missingMappings.push(`system-modules:${system}`);
    if ((systemToV[system] ?? []).length === 0) missingMappings.push(`system-v:${system}`);
    if ((systemToScenarios[system] ?? []).length === 0) missingMappings.push(`system-scenarios:${system}`);
  }
  for (const id of missingMappings) issues.push({ code: 'mapping_missing', message: `mapping ${id} is empty`, ref: id });

  // ---------- blocked resources ----------
  const blockedResources: BlockedResourceReport[] = BLOCKED_RESOURCES.map(resource => ({
    id: resource.id,
    title: resource.title,
    prerequisite: resource.prerequisite,
    blocks: resource.blocks,
    blocksModules: moduleRows.filter(module => module.blockedResourceIds.includes(resource.id)).map(module => module.id),
    blocksVItems: vAcceptanceRows.filter(row => row.blockedResourceIds.includes(resource.id)).map(row => row.id),
    blocksScenarios: scenarioAcceptanceRows.filter(row => row.blockedResourceIds.includes(resource.id)).map(row => row.id),
  }));
  for (const resource of blockedResources) {
    if (resource.blocksModules.length + resource.blocksVItems.length + resource.blocksScenarios.length === 0) {
      issues.push({ code: 'blocked_resource_unused', message: `blocked resource ${resource.id} blocks nothing`, ref: resource.id });
    }
  }

  // ---------- denominators + gate ----------
  const moduleDenominator = denominatorFor(moduleRows.map(row => row.status), moduleRows.length);
  const systemDenominator = denominatorFor(systemRows.map(row => row.status), systemRows.length);
  const vDenominator = denominatorFor(vAcceptanceRows.map(row => row.status), vAcceptanceRows.length);
  const scenarioDenominator = denominatorFor(scenarioAcceptanceRows.map(row => row.status), scenarioAcceptanceRows.length);
  const denominators = addDenominators(addDenominators(moduleDenominator, systemDenominator), addDenominators(vDenominator, scenarioDenominator));
  for (const [scope, denominator] of Object.entries({ modules: moduleDenominator, systems: systemDenominator, vItems: vDenominator, scenarios: scenarioDenominator })) {
    for (const problem of checkDenominator(denominator)) issues.push({ code: 'denominator_invalid', message: `${scope}: ${problem}` });
  }
  for (const problem of checkDenominator(denominators)) issues.push({ code: 'denominator_invalid', message: `overall: ${problem}` });

  const gate = {
    overall: 'incomplete' as const,
    completeNineSystems: false as const,
    completedDimensions: [] as string[],
    reasons: [
      'H7-prep 没有执行任何产品/宿主/模型/业务验收：所有维度 executed=0、passed=0',
      '产品行仍全部 not_covered；仅有有限工具/模块证据层（limited-only/unknown/blocked）',
      'H0c S/FL 仍为 synthetic-fixture-only-not-run 且 cannotUseForBusinessAcceptance=false',
      '40 模块中部分模块无可提交证据、部分被真实设备/凭据等资源阻塞',
      '完整九系统/40模块/V01–V27/S/FL 总体验收未完成，不得声明完成',
    ],
    cannotClaim: [
      '不得声明完整九系统完成',
      '不得声明任何 V 项整体通过',
      '不得把 tooling_ready/limited-only/unknown/blocked 计为 pass',
      '不得把 H0c synthetic fixture 当业务验收或 HOLDOUT',
      '不得把历史限定样本升级为当前 HEAD 或完整门槛通过',
    ],
    blockedResources,
  };

  const report: AcceptanceReport = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    kind: ACCEPTANCE_KIND,
    generatedAt: inputs.generatedAt,
    registryVersion: MODULE_REGISTRY_VERSION,
    inputs: {
      pluginRoot,
      workspaceRoot,
      traceabilitySha256: inputs.traceabilitySha256 ?? null,
      selfproofSha256: inputs.selfproofSha256 ?? null,
      manifestSha256: inputs.manifestSha256 ?? null,
      coverageSha256: inputs.coverageSha256 ?? null,
      frozenHead: traceability?.evidenceMapping.frozenHead ?? null,
      selfproofPassed: inputs.selfproof?.passed ?? null,
      manifestDirty: inputs.manifest?.vcs.dirty ?? null,
    },
    summary: {
      areas: MODULE_AREAS.length,
      modules: moduleRows.length,
      systems: systemRows.length,
      vItems: vAcceptanceRows.length,
      scenarios: scenarioAcceptanceRows.length,
      denominators,
      byScope: { modules: moduleDenominator, systems: systemDenominator, vItems: vDenominator, scenarios: scenarioDenominator },
    },
    modules: moduleRows,
    systems: systemRows,
    vItems: vAcceptanceRows,
    scenarios: scenarioAcceptanceRows,
    mapping: { systemToModules, moduleToSystems, systemToV, systemToScenarios, moduleCountByArea, missingMappings },
    gate,
    issues,
  };
  const violations = issues.map(issue => violation(issue.code, '$', `${issue.ref === undefined ? '' : `${issue.ref}: `}${issue.message}`));
  const result = finish(
    {
      oracle: ACCEPTANCE_ORACLE,
      version: ACCEPTANCE_VERSION,
      boundary:
        '全量验收追踪：把 40 模块清单、已提交 traceability 证据层、H0c S/FL skeleton 标志与资源阻塞合并为分母和门控；' +
        'H7-prep 无产品验收执行，门控只能 incomplete，不得声明九系统完成。不运行产品/宿主/模型。',
      scope: 'acceptance-build',
    },
    moduleRows.length + systemRows.length + vAcceptanceRows.length + scenarioAcceptanceRows.length,
    violations,
    {
      modules: moduleRows.length,
      systems: systemRows.length,
      vItems: vAcceptanceRows.length,
      scenarios: scenarioAcceptanceRows.length,
      executed: denominators.executed,
      passed: denominators.passed,
      blocked: denominators.blocked,
      unknown: denominators.unknown,
      notRun: denominators.notRun,
    },
  );
  return { report, result };
}

function modulesForSystemSafe(system: SystemId): readonly ModuleDefinition[] {
  return MODULE_DEFINITIONS.filter(module => module.systems.includes(system));
}

function scenarioRowsForSystem(system: SystemId, vRows: readonly { id: string; systems: readonly string[] }[]): string[] {
  const scenarioRows = [...BUSINESS_SCENARIO_ROWS, ...FL_SCENARIO_ROWS];
  const result: string[] = [];
  for (const scenario of scenarioRows) {
    const systems = new Set<string>();
    for (const vRef of scenario.refs.v ?? []) {
      const vRow = vRows.find(row => row.id === vRef);
      for (const id of vRow?.systems ?? []) systems.add(id);
    }
    if (systems.has(system)) result.push(scenario.id);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Honesty gate.                                                       */
/* ------------------------------------------------------------------ */

const HONESTY_BOUNDARY =
  '拒绝任何把 H7-prep 写成完成/通过的报告：门控必须 incomplete、completeNineSystems=false；不允许 passed/complete/verified 状态；' +
  'tooling_ready/limited-only/unknown/blocked 不得计为 pass；unknown/skipped/notRun 不得从分母消失；H0c 标志必须原样保留。';

export function checkAcceptanceHonesty(report: AcceptanceReport): CheckResult {
  const violations: Violation[] = [];
  if (report.gate.overall !== 'incomplete') violations.push(violation('full_completion_claimed', '$.gate.overall', `gate overall ${String(report.gate.overall)} must be incomplete in H7-prep`));
  if (report.gate.completeNineSystems !== false) violations.push(violation('full_completion_claimed', '$.gate.completeNineSystems', 'completeNineSystems must be false'));
  if (report.gate.completedDimensions.length > 0) violations.push(violation('dimension_passed_claimed', '$.gate.completedDimensions', 'no dimension can be completed without product acceptance'));
  if (report.summary.denominators.executed !== 0 || report.summary.denominators.passed !== 0 || report.summary.denominators.failed !== 0) {
    violations.push(violation('denominator_mismatch', '$.summary.denominators', 'H7-prep must report executed/passed/failed = 0'));
  }
  for (const [scope, denominator] of Object.entries(report.summary.byScope)) {
    for (const problem of checkDenominator(denominator)) violations.push(violation('denominator_invalid', `$.summary.byScope.${scope}`, problem));
    const rows =
      scope === 'modules' ? report.modules : scope === 'systems' ? report.systems : scope === 'vItems' ? report.vItems : report.scenarios;
    const recomputed = denominatorFor(rows.map(row => row.status), rows.length);
    if (JSON.stringify(recomputed) !== JSON.stringify(denominator)) {
      violations.push(violation('denominator_mismatch', `$.summary.byScope.${scope}`, `reported ${JSON.stringify(denominator)} != recomputed ${JSON.stringify(recomputed)}`));
    }
  }
  const modules = report.modules;
  if (modules.length !== 40) violations.push(violation('module_count_mismatch', '$.modules', `expected 40 modules, got ${modules.length}`));
  if (new Set(modules.map(module => module.id)).size !== modules.length) violations.push(violation('module_not_unique', '$.modules', 'duplicate module ids'));
  for (const module of modules) {
    if (!['not_covered', 'limited-only', 'unknown', 'blocked'].includes(module.status)) {
      violations.push(violation('dimension_passed_claimed', `$.modules.${module.id}`, `module status ${module.status} is not an allowed evidence-derived status`));
    }
    if (module.status === 'limited-only' && module.evidenceRefs.filter(ref => ref.status === 'verified').length === 0) {
      violations.push(violation('limited_only_without_evidence', `$.modules.${module.id}`, 'limited-only module has no verified evidence reference'));
    }
    if (module.status === 'blocked' && module.blockedResourceIds.length === 0) {
      violations.push(violation('blocked_without_resource', `$.modules.${module.id}`, 'blocked module must declare a blocked resource'));
    }
  }
  for (const system of report.systems) {
    if (system.status === ('passed' as never) || (system.status as string) === 'complete') {
      violations.push(violation('dimension_passed_claimed', `$.systems.${system.id}`, 'system cannot be passed/complete'));
    }
  }
  for (const scenario of report.scenarios) {
    if (scenario.status !== 'synthetic-fixture-only-not-run') {
      violations.push(violation('skeleton_upgraded', `$.scenarios.${scenario.id}`, `scenario status ${scenario.status} must stay synthetic-fixture-only-not-run`));
    }
    if (scenario.canUseForBusinessAcceptance !== false) violations.push(violation('skeleton_upgraded', `$.scenarios.${scenario.id}`, 'canUseForBusinessAcceptance must stay false'));
    if (scenario.coverageFlagsPropagated !== true) violations.push(violation('scenario_flag_missing', `$.scenarios.${scenario.id}`, 'coverage flags were not propagated'));
  }
  if (report.scenarios.length !== 16) violations.push(violation('scenario_count_mismatch', '$.scenarios', `expected 16 scenarios, got ${report.scenarios.length}`));
  if (report.vItems.length !== 27) violations.push(violation('v_item_count_mismatch', '$.vItems', `expected 27 V items, got ${report.vItems.length}`));
  const blockedIds = new Set(report.gate.blockedResources.map(resource => resource.id));
  for (const module of modules) {
    for (const resourceId of module.blockedResourceIds) {
      if (!blockedIds.has(resourceId)) violations.push(violation('blocked_resource_missing', `$.modules.${module.id}`, `blocked resource ${resourceId} missing from gate list`));
    }
  }
  if (report.gate.cannotClaim.length === 0) violations.push(violation('cannot_claim_missing', '$.gate.cannotClaim', 'gate must state what cannot be claimed'));
  if (!report.gate.reasons.some(reason => reason.includes('executed=0'))) {
    violations.push(violation('execution_claim_missing', '$.gate.reasons', 'gate must state that no acceptance execution happened'));
  }
  return finish(
    { oracle: ACCEPTANCE_ORACLE, version: ACCEPTANCE_VERSION, boundary: HONESTY_BOUNDARY, scope: 'acceptance-honesty' },
    report.modules.length + report.systems.length + report.vItems.length + report.scenarios.length,
    violations,
    { modules: report.modules.length, executed: report.summary.denominators.executed, passed: report.summary.denominators.passed },
  );
}

/* ------------------------------------------------------------------ */
/* Markdown.                                                           */
/* ------------------------------------------------------------------ */

function mdTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cell => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`),
  ].join('\n');
}

export function renderAcceptanceMarkdown(report: AcceptanceReport): string {
  const lines: string[] = [];
  lines.push('# H7-acceptance 全量验收追踪与门控报告');
  lines.push('');
  lines.push(`生成时间：${report.generatedAt}；registry ${report.registryVersion}；schema ${report.schemaVersion}。`);
  lines.push('');
  lines.push('> **门控结论：incomplete（未完成）。不得声明完整九系统完成或任何 V 项整体通过。** ' +
    'H7-prep 只有已提交切片证据层与 H0c 合成骨架，没有任何产品/宿主/模型/业务验收执行。');
  lines.push('');
  lines.push('## 1. 输入与诚实边界');
  lines.push('');
  lines.push(mdTable(
    ['输入', 'SHA256 前缀', '状态'],
    [
      ['traceability.json', report.inputs.traceabilitySha256?.slice(0, 16) ?? '—', report.inputs.traceabilitySha256 === null ? '缺省/unknown' : 'present'],
      ['tool-selfproof.json', report.inputs.selfproofSha256?.slice(0, 16) ?? '—', report.inputs.selfproofPassed === true ? 'passed' : report.inputs.selfproofPassed === false ? 'failed' : 'unknown'],
      ['manifest.json', report.inputs.manifestSha256?.slice(0, 16) ?? '—', report.inputs.manifestDirty === false ? 'clean-vcs' : report.inputs.manifestDirty === true ? 'dirty' : 'unknown'],
      ['fl-scenarios/coverage.json', report.inputs.coverageSha256?.slice(0, 16) ?? '—', report.inputs.coverageSha256 === null ? '缺省/unknown' : 'present'],
      ['frozen HEAD', report.inputs.frozenHead ?? '—', report.inputs.frozenHead === null ? 'unknown' : 'bound'],
    ],
  ));
  lines.push('');
  lines.push('## 2. 分母（H7-prep 无验收执行）');
  lines.push('');
  const denominatorRows: string[][] = [];
  for (const [scope, denominator] of Object.entries(report.summary.byScope)) {
    denominatorRows.push([scope, String(denominator.planned), String(denominator.executed), String(denominator.passed), String(denominator.failed), String(denominator.unknown), String(denominator.blocked), String(denominator.skipped), String(denominator.notRun), String(denominator.notApplicable)]);
  }
  denominatorRows.push(['overall', String(report.summary.denominators.planned), String(report.summary.denominators.executed), String(report.summary.denominators.passed), String(report.summary.denominators.failed), String(report.summary.denominators.unknown), String(report.summary.denominators.blocked), String(report.summary.denominators.skipped), String(report.summary.denominators.notRun), String(report.summary.denominators.notApplicable)]);
  lines.push(mdTable(['scope', 'planned', 'executed', 'passed', 'failed', 'unknown', 'blocked', 'skipped', 'notRun', 'notApplicable'], denominatorRows));
  lines.push('');
  lines.push('## 3. 九系统（均为未完成）');
  lines.push('');
  lines.push(mdTable(
    ['系统', '状态', '模块数', 'V 关联', 'S/FL 关联', '证据层', '缺口'],
    report.systems.map(system => [
      `${system.id} ${system.title}`,
      system.status,
      String(system.modules.length),
      system.vRefs.join(','),
      system.scenarioRefs.join(',') || '—',
      system.evidenceLevels.join(',') || '—',
      system.gaps.join('；'),
    ]),
  ));
  lines.push('');
  lines.push('## 4. 40 模块清单（状态只允许 not_covered/limited-only/unknown/blocked）');
  lines.push('');
  lines.push(mdTable(
    ['模块', '区域', '系统', '状态', '证据来源', '代码路径', '测试ID', '阻塞资源'],
    report.modules.map(module => [
      `${module.id} ${module.title}`,
      module.areaId,
      module.systems.join(','),
      module.status,
      module.evidenceSourceIds.join(',') || '—',
      module.codePaths.filter(path => path.exists).map(path => path.path).join(',') || '—',
      module.testIds.filter(id => id.exists).map(id => id.id).join(',') || '—',
      module.blockedResourceIds.join(',') || '—',
    ]),
  ));
  lines.push('');
  lines.push('## 5. V01–V27（原门槛保留，状态不升级）');
  lines.push('');
  lines.push(mdTable(
    ['V', '状态', '系统', '证据层', '门槛（摘）', '阻塞资源'],
    report.vItems.map(row => [row.id, row.status, row.systems.join(','), row.evidenceLevels.join(',') || '—', row.thresholds.join('；'), row.blockedResourceIds.join(',') || '—']),
  ));
  lines.push('');
  lines.push('## 6. S01–S08 / FL01–FL08（H0c skeleton 标志原样传播）');
  lines.push('');
  lines.push(mdTable(
    ['场景', '类别', '状态', 'synthetic-fixture-only-not-run', 'canUseForBusinessAcceptance', '系统映射', '阻塞资源'],
    report.scenarios.map(row => [row.id, row.kind, row.status, String(row.syntheticFixtureOnlyNotRun), String(row.canUseForBusinessAcceptance), row.systems.join(','), row.blockedResourceIds.join(',')]),
  ));
  lines.push('');
  lines.push('## 7. 40 模块 ↔ 九系统 ↔ V/S/FL 映射');
  lines.push('');
  lines.push(mdTable(
    ['系统', '模块', 'V', 'S/FL'],
    Object.keys(report.mapping.systemToModules).map(system => [
      system,
      report.mapping.systemToModules[system].join(', '),
      report.mapping.systemToV[system].join(', '),
      report.mapping.systemToScenarios[system].join(', ') || '—',
    ]),
  ));
  lines.push('');
  lines.push(`缺失映射：${report.mapping.missingMappings.length === 0 ? '无' : report.mapping.missingMappings.join(', ')}。`);
  lines.push('');
  lines.push('## 8. 资源阻塞清单');
  lines.push('');
  lines.push(mdTable(
    ['资源', '前提', '阻塞模块', '阻塞 V', '阻塞 S/FL'],
    report.gate.blockedResources.map(resource => [resource.id, resource.prerequisite, resource.blocksModules.join(',') || '—', resource.blocksVItems.join(',') || '—', resource.blocksScenarios.join(',') || '—']),
  ));
  lines.push('');
  lines.push('## 9. 门控结论');
  lines.push('');
  lines.push(`- overall：**${report.gate.overall}**`);
  lines.push(`- completeNineSystems：**${String(report.gate.completeNineSystems)}**`);
  lines.push(`- completedDimensions：${report.gate.completedDimensions.length === 0 ? '无' : report.gate.completedDimensions.join(',')}`);
  for (const reason of report.gate.reasons) lines.push(`- 原因：${reason}`);
  lines.push('');
  lines.push('明确不可声明：');
  for (const claim of report.gate.cannotClaim) lines.push(`- ${claim}`);
  lines.push('');
  if (report.issues.length > 0) {
    lines.push('## 10. 生成期问题（必须处理）');
    lines.push('');
    for (const issue of report.issues) lines.push(`- \`${issue.code}\`${issue.ref === undefined ? '' : ` (${issue.ref})`}: ${issue.message}`);
    lines.push('');
  }
  lines.push('## 11. 复核命令');
  lines.push('');
  lines.push('- `node scripts/harness/acceptance.mjs`');
  lines.push('- `node scripts/harness/traceability.mjs --strict`');
  lines.push('- `node --import tsx --test --test-concurrency=1 tests/harness-acceptance.test.ts`');
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI.                                                                */
/* ------------------------------------------------------------------ */

export interface AcceptanceCliResult {
  readonly exitCode: number;
  readonly summary: string;
  readonly report?: AcceptanceReport;
}

interface JsonArtifact<T> {
  readonly value: T | null;
  readonly sha256: string | null;
}

async function readJson<T>(path: string): Promise<JsonArtifact<T>> {
  try {
    const text = await readFile(path, 'utf8');
    return { value: JSON.parse(text) as T, sha256: sha256Hex(text) };
  } catch {
    return { value: null, sha256: null };
  }
}

export async function runAcceptanceCli(argv: readonly string[]): Promise<AcceptanceCliResult> {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const workspaceModuleRoot = resolve(moduleRoot, '../..');
  let pluginRoot = moduleRoot;
  let workspaceRoot = workspaceModuleRoot;
  let outDir = join(pluginRoot, 'artifacts/dsh/harness');
  let traceabilityPath: string | undefined;
  let selfproofPath: string | undefined;
  let manifestPath: string | undefined;
  let coveragePath: string | undefined;
  let generatedAt: string | undefined;
  let print = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--plugin-root') pluginRoot = resolve(argv[++index] ?? pluginRoot);
    else if (argument === '--workspace-root') workspaceRoot = resolve(argv[++index] ?? workspaceRoot);
    else if (argument === '--out-dir') outDir = resolve(argv[++index] ?? outDir);
    else if (argument === '--traceability') traceabilityPath = resolve(argv[++index] ?? '');
    else if (argument === '--selfproof') selfproofPath = resolve(argv[++index] ?? '');
    else if (argument === '--manifest') manifestPath = resolve(argv[++index] ?? '');
    else if (argument === '--coverage') coveragePath = resolve(argv[++index] ?? '');
    else if (argument === '--generated-at') generatedAt = String(argv[++index] ?? '');
    else if (argument === '--print') print = true;
    else if (argument === '--help') {
      return { exitCode: 0, summary: 'usage: node --import tsx tests/harness/acceptance.ts [--plugin-root d] [--workspace-root d] [--out-dir d] [--traceability f] [--selfproof f] [--manifest f] [--coverage f] [--generated-at iso] [--print]' };
    } else return { exitCode: 1, summary: `unknown argument ${argument}` };
  }
  const traceability = await readJson<TraceabilityMatrix>(traceabilityPath ?? join(outDir, 'traceability.json'));
  const selfproof = await readJson<SelfProofArtifact>(selfproofPath ?? join(outDir, 'tool-selfproof.json'));
  const manifest = await readJson<HarnessManifest>(manifestPath ?? join(outDir, 'manifest.json'));
  const coverage = await readJson<CoverageIndex>(coveragePath ?? join(pluginRoot, 'artifacts/dsh/harness/fl-scenarios/coverage.json'));
  const moduleCatalog = await readFile(join(workspaceRoot, '架构与设计/A方案全景/目录.md'), 'utf8');
  const acceptanceDoc = await readFile(join(workspaceRoot, '架构与设计/A方案全景/验证与验收.md'), 'utf8');
  const missingInputs = [
    traceability.value === null ? 'traceability.json' : null,
    selfproof.value === null ? 'tool-selfproof.json' : null,
    manifest.value === null ? 'manifest.json' : null,
    coverage.value === null ? 'fl-scenarios/coverage.json' : null,
  ].filter((item): item is string => item !== null);
  if (missingInputs.length > 0) {
    return { exitCode: 2, summary: `acceptance inputs missing: ${missingInputs.join(', ')} (fail-closed; regenerate harness artifacts first)` };
  }
  let evidence: EvidenceVerificationReport | null = null;
  const frozenHead = traceability.value?.evidenceMapping.frozenHead;
  if (frozenHead !== undefined && /^[0-9a-f]{40}$/.test(frozenHead)) {
    const { verifyEvidenceSources } = await import('./evidence.js');
    evidence = (await verifyEvidenceSources(workspaceRoot, frozenHead)).report;
  }
  const { report, result } = await buildAcceptanceReport({
    pluginRoot,
    workspaceRoot,
    generatedAt: generatedAt ?? new Date().toISOString(),
    traceability: traceability.value,
    traceabilitySha256: traceability.sha256,
    selfproof: selfproof.value,
    selfproofSha256: selfproof.sha256,
    manifest: manifest.value,
    manifestSha256: manifest.sha256,
    coverage: coverage.value,
    coverageSha256: coverage.sha256,
    evidence,
    documents: { moduleCatalog, acceptanceDoc },
  });
  const honesty = checkAcceptanceHonesty(report);
  const hardIssues = report.issues.filter(issue => !['module_evidence_unknown', 'module_code_path_missing', 'module_test_id_missing', 'module_readme_missing', 'module_doc_row_missing', 'module_doc_title_missing'].includes(issue.code));
  const jsonWrite = `${JSON.stringify(report, null, 2)}\n`;
  const mdWrite = `${renderAcceptanceMarkdown(report)}\n`;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, ACCEPTANCE_REPORT_JSON), jsonWrite, 'utf8');
  await writeFile(join(outDir, ACCEPTANCE_REPORT_MARKDOWN), mdWrite, 'utf8');
  const summaryLines = [
    `acceptance report written: ${relativeTo(workspaceRoot, join(outDir, ACCEPTANCE_REPORT_JSON))} + ${ACCEPTANCE_REPORT_MARKDOWN}`,
    `  gate=${report.gate.overall} completeNineSystems=${String(report.gate.completeNineSystems)} executed=${report.summary.denominators.executed} passed=${report.summary.denominators.passed}`,
    `  modules=${report.summary.modules} (not_run=${report.summary.byScope.modules.notRun} blocked=${report.summary.byScope.modules.blocked} unknown=${report.summary.byScope.modules.unknown})`,
    `  systems=${report.summary.systems} vItems=${report.summary.vItems} scenarios=${report.summary.scenarios}`,
    `  deniedClaims=${report.gate.cannotClaim.length} blockedResources=${report.gate.blockedResources.length}`,
    `  buildIssues=${report.issues.length} hardIssues=${hardIssues.length} honesty=${honesty.ok ? 'pass' : 'fail'}`,
  ];
  if (print) summaryLines.push(`  jsonSha256=${sha256Hex(jsonWrite)} markdownSha256=${sha256Hex(mdWrite)}`);
  if (!honesty.ok) {
    for (const item of honesty.violations.slice(0, 20)) summaryLines.push(`  honesty violation: ${item.code} ${item.message}`);
    return { exitCode: 2, summary: summaryLines.join('\n'), report };
  }
  if (hardIssues.length > 0) {
    for (const issue of hardIssues.slice(0, 20)) summaryLines.push(`  hard issue: ${issue.code} ${issue.message}`);
    return { exitCode: 2, summary: summaryLines.join('\n'), report };
  }
  void result;
  return { exitCode: 0, summary: summaryLines.join('\n'), report };
}

function relativeTo(base: string, target: string): string {
  const relative = target.startsWith(base) ? target.slice(base.length + 1) : target;
  return relative.split('\\').join('/');
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(moduleUrl));
}

if (isMain(import.meta.url)) {
  const result = await runAcceptanceCli(process.argv.slice(2));
  process.stderr.write(`${result.summary}\n`);
  process.exitCode = result.exitCode;
}

export { MODULE_DEFINITIONS, MODULE_AREAS, BLOCKED_RESOURCES, V_RESOURCE_BLOCKS, SCENARIO_RESOURCE_BLOCKS };
export type { BlockedResource };
