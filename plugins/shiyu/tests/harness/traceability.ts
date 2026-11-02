/**
 * Requirement → code path → test ID → oracle → evidence → status traceability.
 *
 * Sources are transcribed in `traceability-registry.ts` from the handoff
 * documents. This generator:
 * 1. verifies every source reference against the real markdown headings;
 * 2. computes statuses ONLY from frozen artifacts (self-proof TAP results,
 *    manifest file identities) — product requirements are always
 *    `not_covered` in H0 and can never be upgraded by this tool;
 * 3. emits machine-readable JSON plus a human-readable Markdown report with
 *    explicit uncovered denominators and regeneration/review commands.
 *
 * Boundary: the report proves that requirements are *registered* and that
 * the H0 tool capabilities are self-proven at a given file identity. It does
 * not prove any product V/S/FL behaviour, host integration or model quality.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult, Violation } from './invariant.js';
import { finish, sha256Hex, violation } from './invariant.js';
import { ALL_SELF_PROOFS, oracleTestName } from './index.js';
import { HARNESS_VERSION, SELF_PROOF_CORPUS } from './version.js';
import {
  ALL_REQUIREMENT_ROWS,
  HARNESS_CAPABILITY_ROWS,
  HISTORICAL_EVIDENCE,
  PRODUCT_KINDS,
  SOURCE_DOCUMENTS,
  type RequirementKind,
  type RequirementRow,
} from './traceability-registry.js';
import { ALLOWED_STATUSES, type RequirementStatus } from './traceability-types.js';
import { SELF_PROOF_ARTIFACT, checkSelfProofArtifact, type SelfProofArtifact } from './selfproof.js';
import { MANIFEST_KIND, verifyManifestFiles, type HarnessManifest } from './manifest.js';

export const TRACEABILITY_SCHEMA_VERSION = 1;
export const TRACEABILITY_KIND = 'shiyu.harness.traceability';
export const TRACEABILITY_JSON = 'traceability.json';
export const TRACEABILITY_MARKDOWN = 'traceability.md';
export const MANIFEST_ARTIFACT = 'manifest.json';

export interface SourceDocumentState {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly present: boolean;
  readonly headings: readonly string[];
}

export interface ArtifactState {
  readonly path: string;
  readonly present: boolean;
  readonly sha256: string | null;
  readonly generatedAt?: string;
  readonly note: string;
}

export interface ArtifactBundle {
  readonly selfproof: SelfProofArtifact | null;
  readonly selfproofState: ArtifactState;
  readonly selfproofCheck: { readonly ok: boolean; readonly fresh: boolean; readonly passingTests: ReadonlySet<string>; readonly failingTests: ReadonlySet<string>; readonly issues: readonly string[] } | null;
  readonly manifest: HarnessManifest | null;
  readonly manifestState: ArtifactState;
  readonly manifestCheck: { readonly ok: boolean; readonly issues: readonly string[] } | null;
}

export interface EvidenceIssue {
  readonly code: string;
  readonly rowId?: string;
  readonly message: string;
}

export interface EvaluatedRequirement extends RequirementRow {
  readonly status: RequirementStatus;
  readonly statusBasis: string;
  readonly sourceVerified: boolean;
  readonly verifiedTests: readonly string[];
  readonly missingTests: readonly string[];
  readonly oracleStatus: readonly { readonly name: string; readonly verified: boolean }[];
  readonly artifactChecks: readonly { readonly artifact: string; readonly present: boolean; readonly valid: boolean }[];
  readonly evidence: Readonly<Record<string, string | null>>;
}

export interface TraceabilitySummary {
  readonly rows: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly product: { readonly total: number; readonly covered: number; readonly notCovered: number };
  readonly harnessCurated: { readonly total: number; readonly selfProven: number; readonly partial: number; readonly notCovered: number };
  readonly oracles: { readonly total: number; readonly verified: number };
}

export interface TraceabilityMatrix {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly generatedAt: string;
  readonly harnessVersion: string;
  readonly selfProofCorpus: string;
  readonly sources: readonly SourceDocumentState[];
  readonly planIndexVerified: boolean;
  readonly artifacts: Readonly<Record<string, ArtifactState>>;
  readonly summary: TraceabilitySummary;
  readonly rows: readonly EvaluatedRequirement[];
  readonly oracles: readonly { readonly name: string; readonly version: string; readonly module: string; readonly samples: number; readonly scenarios: number; readonly verified: boolean }[];
  readonly historicalEvidence: readonly { readonly path: string; readonly present: boolean; readonly sha256: string | null; readonly scope: string; readonly refs: readonly string[] }[];
  readonly issues: readonly EvidenceIssue[];
  readonly gaps: readonly string[];
  readonly disclaimer: string;
  /** Machine-readable handoff rule for the post-H0b slices. */
  readonly handoff: {
    readonly milestone: 'H0b';
    readonly rule: string;
    readonly productRowSource: string;
    readonly toolingReadyMeaning: string;
    readonly forbidden: readonly string[];
  };
  readonly commands: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Source documents and heading verification.                          */
/* ------------------------------------------------------------------ */

export async function loadSourceDocuments(workspaceRoot: string): Promise<Map<string, SourceDocumentState>> {
  const map = new Map<string, SourceDocumentState>();
  for (const doc of SOURCE_DOCUMENTS) {
    const absolute = join(resolve(workspaceRoot), doc.path);
    try {
      const text = await readFile(absolute, 'utf8');
      map.set(doc.id, {
        id: doc.id,
        path: doc.path,
        sha256: sha256Hex(text),
        present: true,
        headings: text
          .split('\n')
          .map(line => line.trimEnd())
          .filter(line => /^#{2,4}\s/.test(line)),
      });
    } catch {
      map.set(doc.id, { id: doc.id, path: doc.path, sha256: '', present: false, headings: [] });
    }
  }
  return map;
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match === null ? 0 : match[1].length;
}

/** Locate the section starting at `heading` and return its text (incl. heading). */
export function findSection(lines: readonly string[], heading: string): { found: boolean; text: string } {
  const index = lines.findIndex(line => line.trim().startsWith(heading));
  if (index === -1) return { found: false, text: '' };
  const level = headingLevel(lines[index].trim());
  let end = lines.length;
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const candidate = lines[cursor].trim();
    if (candidate.length === 0) continue;
    const candidateLevel = headingLevel(candidate);
    if (candidateLevel > 0 && candidateLevel <= level) {
      end = cursor;
      break;
    }
  }
  return { found: true, text: lines.slice(index, end).join('\n') };
}

export function verifySourceReferences(
  rows: readonly RequirementRow[],
  documents: ReadonlyMap<string, SourceDocumentState>,
  documentTexts: ReadonlyMap<string, readonly string[]>,
): { readonly verified: ReadonlySet<string>; readonly issues: readonly EvidenceIssue[] } {
  const verified = new Set<string>();
  const issues: EvidenceIssue[] = [];
  for (const row of rows) {
    const document = documents.get(row.source.doc);
    if (document === undefined || !document.present) {
      issues.push({ code: 'source_doc_missing', rowId: row.id, message: `source document ${row.source.doc} (${row.source.heading}) is absent` });
      continue;
    }
    const lines = documentTexts.get(row.source.doc) ?? [];
    const section = findSection(lines, row.source.heading);
    if (!section.found) {
      issues.push({ code: 'source_heading_missing', rowId: row.id, message: `heading ${JSON.stringify(row.source.heading)} not found in ${document.path}` });
      continue;
    }
    const headingLine = section.text.split('\n')[0] ?? '';
    if (headingLine.includes(row.source.contains) || section.text.includes(row.source.contains)) {
      verified.add(row.id);
    } else {
      issues.push({
        code: 'source_contains_missing',
        rowId: row.id,
        message: `section ${JSON.stringify(row.source.heading)} in ${document.path} does not contain ${JSON.stringify(row.source.contains)}`,
      });
    }
  }
  return { verified, issues };
}

/** Verify that 九系统计划 §5 lists V01–V27, as the task requires. */
export function verifyPlanVIndex(documents: ReadonlyMap<string, SourceDocumentState>, documentTexts: ReadonlyMap<string, readonly string[]>): boolean {
  const lines = documentTexts.get('doc-plan') ?? [];
  const section = findSection(lines, '## 5. V01–V27 覆盖与实测门槛');
  if (!section.found) return false;
  for (let index = 1; index <= 27; index++) {
    const id = `V${String(index).padStart(2, '0')}`;
    if (!section.text.includes(id)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Artifact loading.                                                   */
/* ------------------------------------------------------------------ */

async function readArtifactJson(path: string): Promise<{ value: unknown; sha256: string } | null> {
  try {
    const text = await readFile(path, 'utf8');
    return { value: JSON.parse(text) as unknown, sha256: sha256Hex(text) };
  } catch {
    return null;
  }
}

export interface LoadArtifactOptions {
  readonly pluginRoot: string;
  readonly outputDir: string;
  readonly selfproofPath?: string;
  readonly manifestPath?: string;
}

export async function loadArtifacts(options: LoadArtifactOptions): Promise<ArtifactBundle> {
  const pluginRoot = resolve(options.pluginRoot);
  const outputDir = resolve(options.outputDir);
  const selfproofPath = resolve(options.selfproofPath ?? join(outputDir, SELF_PROOF_ARTIFACT));
  const manifestPath = resolve(options.manifestPath ?? join(outputDir, MANIFEST_ARTIFACT));
  const selfproofRead = await readArtifactJson(selfproofPath);
  const manifestRead = await readArtifactJson(manifestPath);
  const selfproof = (selfproofRead?.value as SelfProofArtifact | undefined) ?? null;
  let selfproofCheck: ArtifactBundle['selfproofCheck'] = null;
  if (selfproof !== null) {
    const check = await checkSelfProofArtifact(selfproof, { pluginRoot });
    selfproofCheck = {
      ok: check.result.ok,
      fresh: check.fresh,
      passingTests: check.passingTests,
      failingTests: check.failingTests,
      issues: check.result.violations.map(item => `${item.code}: ${item.message}`),
    };
  }
  const manifest = (manifestRead?.value as HarnessManifest | undefined) ?? null;
  let manifestCheck: ArtifactBundle['manifestCheck'] = null;
  if (manifest !== null && manifest.kind === MANIFEST_KIND) {
    const check = verifyManifestFiles(manifest, { pluginRoot });
    manifestCheck = { ok: check.ok, issues: check.violations.map(item => `${item.code}: ${item.message}`) };
  } else if (manifest !== null) {
    manifestCheck = { ok: false, issues: ['artifact_shape_invalid: manifest kind does not match'] };
  }
  return {
    selfproof,
    selfproofState: {
      path: relative(pluginRoot, selfproofPath),
      present: selfproofRead !== null,
      sha256: selfproofRead?.sha256 ?? null,
      generatedAt: selfproof?.generatedAt,
      note: selfproofRead === null ? 'artifact absent (run scripts/harness/selfproof.mjs first)' : selfproof?.passed === true ? 'self-proof passed' : 'self-proof did not pass',
    },
    selfproofCheck,
    manifest,
    manifestState: {
      path: relative(pluginRoot, manifestPath),
      present: manifestRead !== null,
      sha256: manifestRead?.sha256 ?? null,
      generatedAt: manifest?.generatedAt,
      note: manifestRead === null ? 'artifact absent (run scripts/harness/manifest.mjs first)' : manifestCheck?.ok === true ? 'manifest files match the current tree' : 'manifest is stale or invalid',
    },
    manifestCheck,
  };
}

/* ------------------------------------------------------------------ */
/* Requirement evaluation.                                             */
/* ------------------------------------------------------------------ */

function registryIssues(): EvidenceIssue[] {
  const issues: EvidenceIssue[] = [];
  const ids = new Set<string>();
  for (const row of ALL_REQUIREMENT_ROWS) {
    if (ids.has(row.id)) issues.push({ code: 'duplicate_requirement_id', rowId: row.id, message: `requirement id ${row.id} is duplicated` });
    ids.add(row.id);
    if (row.title.trim().length === 0) issues.push({ code: 'requirement_title_missing', rowId: row.id, message: 'requirement title is empty' });
  }
  const vIds = new Set(ALL_REQUIREMENT_ROWS.filter(row => row.kind === 'v-item').map(row => row.id));
  const sIds = new Set(ALL_REQUIREMENT_ROWS.filter(row => row.kind === 'business-scenario').map(row => row.id));
  const flIds = new Set(ALL_REQUIREMENT_ROWS.filter(row => row.kind === 'fl-scenario').map(row => row.id));
  const systemIds = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  const oracleNames = new Set(ALL_SELF_PROOFS.map(proof => proof.name));
  for (const row of ALL_REQUIREMENT_ROWS) {
    for (const system of row.systems) {
      if (!systemIds.has(system)) issues.push({ code: 'unknown_system_ref', rowId: row.id, message: `system ref ${system} is not 1–9` });
    }
    for (const vRef of row.refs.v ?? []) {
      if (!vIds.has(vRef)) issues.push({ code: 'unknown_v_ref', rowId: row.id, message: `V ref ${vRef} is not registered` });
    }
    for (const sRef of row.refs.s ?? []) {
      if (!sIds.has(sRef)) issues.push({ code: 'unknown_s_ref', rowId: row.id, message: `S ref ${sRef} is not registered` });
    }
    for (const flRef of row.refs.fl ?? []) {
      if (!flIds.has(flRef)) issues.push({ code: 'unknown_fl_ref', rowId: row.id, message: `FL ref ${flRef} is not registered` });
    }
    for (const oracle of [...row.oracles, ...(row.verification?.oracleRefs ?? [])]) {
      if (!oracleNames.has(oracle)) issues.push({ code: 'unknown_oracle_ref', rowId: row.id, message: `oracle ref ${oracle} is not in ALL_SELF_PROOFS` });
    }
  }
  const expectedKinds: readonly [RequirementKind, number][] = [
    ['nine-system', 9],
    ['v-item', 27],
    ['business-scenario', 8],
    ['fl-scenario', 8],
    ['scoring-dimension', 8],
    ['combo-scenario', 10],
    ['system-matrix', 9],
    ['tool-verification', 9],
    ['harness-asset', 8],
    ['harness-capability', 7],
  ];
  for (const [kind, expected] of expectedKinds) {
    const actual = ALL_REQUIREMENT_ROWS.filter(row => row.kind === kind).length;
    if (actual !== expected) issues.push({ code: 'requirement_count_mismatch', message: `${kind}: expected ${expected} rows, found ${actual}` });
  }
  return issues;
}

function evaluateHarnessRow(
  row: RequirementRow,
  bundle: ArtifactBundle,
  sourceVerified: boolean,
): { status: RequirementStatus; entries: EvidenceIssue[]; basis: string; verifiedTests: string[]; missingTests: string[]; oracleStatus: { name: string; verified: boolean }[]; artifactChecks: { artifact: string; present: boolean; valid: boolean }[] } {
  const entries: EvidenceIssue[] = [];
  const verification = row.verification;
  const passing = bundle.selfproofCheck?.passingTests ?? new Set<string>();
  const failing = bundle.selfproofCheck?.failingTests ?? new Set<string>();
  const requiredTests = verification?.requiredTests ?? [];
  const verifiedTests = requiredTests.filter(name => passing.has(name));
  const missingTests = requiredTests.filter(name => !passing.has(name));
  for (const name of missingTests) {
    entries.push({
      code: failing.has(name) ? 'selfproof_test_failed' : 'selfproof_test_missing',
      rowId: row.id,
      message: `required test ${name} is not passing in the self-proof artifact`,
    });
  }
  const oracleStatus = (verification?.oracleRefs ?? []).map(name => ({ name, verified: passing.has(oracleTestName(name)) }));
  for (const oracle of oracleStatus) {
    if (!oracle.verified) entries.push({ code: 'oracle_unverified', rowId: row.id, message: `oracle ${oracle.name} has no passing self-proof test` });
  }
  const artifactChecks = (verification?.requiredArtifacts ?? []).map(artifact => {
    if (artifact === 'selfproof') {
      return { artifact, present: bundle.selfproofState.present, valid: bundle.selfproofCheck?.ok === true && bundle.selfproofCheck.fresh };
    }
    if (artifact === 'manifest') {
      return { artifact, present: bundle.manifestState.present, valid: bundle.manifestCheck?.ok === true };
    }
    return { artifact, present: false, valid: false };
  });
  for (const check of artifactChecks) {
    if (!check.valid) entries.push({ code: 'required_artifact_invalid', rowId: row.id, message: `required artifact ${check.artifact} is ${check.present ? 'present but invalid/stale' : 'absent'}` });
  }
  for (const path of verification?.requiredPaths ?? []) {
    // Path existence is verified by the self-proof artifact source hashes: an
    // absent path means the capability's own test would fail. Record it for
    // reviewers when the artifact does not include it.
    if (!passing.has('docs:readme-contract') && path.endsWith('README.md')) {
      entries.push({ code: 'required_path_unverified', rowId: row.id, message: `required path ${path} cannot be verified without the docs contract test` });
    }
  }
  if (!sourceVerified) entries.push({ code: 'source_unverified', rowId: row.id, message: 'source document reference could not be verified' });
  const allChecks = requiredTests.length + (verification?.oracleRefs ?? []).length + artifactChecks.length;
  const passedChecks = verifiedTests.length + oracleStatus.filter(item => item.verified).length + artifactChecks.filter(item => item.valid).length;
  let status: RequirementStatus;
  let basis: string;
  if (row.kind === 'tool-verification') {
    // Tool-verification rows describe product scenarios whose deterministic
    // judge exists but whose scenario has NOT run. They can never be
    // self_proven by H0 alone.
    if (oracleStatus.length > 0 && oracleStatus.every(item => item.verified)) {
      status = 'tooling_ready';
      basis = 'H0 判定器已自证；对应产品场景尚未运行，状态不是通过';
    } else if (verification?.allowPartial === true && passedChecks > 0) {
      status = 'partial_tooling';
      basis = `H0 判定器仅部分就绪：${entries.map(item => item.code).join(', ')}`;
    } else {
      status = 'not_covered';
      basis = entries.length === 0 ? 'H0 未交付对应判定能力（例如 Judge 语义裁定）' : `未取证：${entries.map(item => item.code).join(', ')}`;
    }
  } else if (entries.length === 0 && allChecks > 0 && passedChecks === allChecks) {
    status = 'self_proven';
    basis = `self-proof artifact + manifest verified: tests ${verifiedTests.length}/${requiredTests.length}, oracles ${oracleStatus.filter(item => item.verified).length}/${oracleStatus.length}, artifacts ${artifactChecks.filter(item => item.valid).length}/${artifactChecks.length}`;
  } else if (verification?.allowPartial === true && passedChecks > 0) {
    status = 'partial_tooling';
    basis = `H0 子能力已交付但未全部取证：${entries.map(item => item.code).join(', ')}`;
  } else {
    status = 'not_covered';
    basis = entries.length === 0 ? 'H0 未交付/未运行该能力' : `未取证：${entries.map(item => item.code).join(', ')}`;
  }
  return { status, entries, basis, verifiedTests, missingTests, oracleStatus, artifactChecks };
}

export interface EvaluateOptions {
  readonly pluginRoot: string;
  readonly workspaceRoot: string;
  readonly bundle: ArtifactBundle;
  readonly generatedAt?: Date;
}

export async function evaluateTraceability(options: EvaluateOptions): Promise<TraceabilityMatrix> {
  const documents = await loadSourceDocuments(options.workspaceRoot);
  const documentTexts = new Map<string, readonly string[]>();
  for (const doc of SOURCE_DOCUMENTS) {
    try {
      const text = await readFile(join(resolve(options.workspaceRoot), doc.path), 'utf8');
      documentTexts.set(doc.id, text.split('\n').map(line => line.replace(/\r$/, '')));
    } catch {
      documentTexts.set(doc.id, []);
    }
  }
  const sourceCheck = verifySourceReferences(ALL_REQUIREMENT_ROWS, documents, documentTexts);
  const planIndexVerified = verifyPlanVIndex(documents, documentTexts);
  const issues: EvidenceIssue[] = [...registryIssues(), ...sourceCheck.issues];
  if (!planIndexVerified) issues.push({ code: 'plan_v_index_missing', message: '九系统计划 §5 does not list all V01–V27' });
  if (options.bundle.selfproofCheck !== null) {
    for (const issue of options.bundle.selfproofCheck.issues) issues.push({ code: 'selfproof_artifact_issue', message: issue });
  }
  if (options.bundle.manifestCheck !== null) {
    for (const issue of options.bundle.manifestCheck.issues) issues.push({ code: 'manifest_artifact_issue', message: issue });
  }

  const rows: EvaluatedRequirement[] = [];
  for (const row of ALL_REQUIREMENT_ROWS) {
    const sourceVerified = sourceCheck.verified.has(row.id);
    let status: RequirementStatus;
    let statusBasis: string;
    let verifiedTests: string[] = [];
    let missingTests: string[] = [];
    let oracleStatus: { name: string; verified: boolean }[] = [];
    let artifactChecks: { artifact: string; present: boolean; valid: boolean }[] = [];
    if (PRODUCT_KINDS.includes(row.kind)) {
      status = 'not_covered';
      statusBasis = 'H0 只登记需求，未运行/未实现对应产品验证；历史有限证据不计入状态';
    } else {
      const evaluated = evaluateHarnessRow(row, options.bundle, sourceVerified);
      status = evaluated.status;
      statusBasis = evaluated.basis;
      verifiedTests = evaluated.verifiedTests;
      missingTests = evaluated.missingTests;
      oracleStatus = evaluated.oracleStatus;
      artifactChecks = evaluated.artifactChecks;
      issues.push(...evaluated.entries);
    }
    const evidence: Record<string, string | null> = {};
    if (row.kind === 'harness-capability' || row.kind === 'harness-asset' || row.kind === 'tool-verification') {
      evidence.selfproof = options.bundle.selfproofState.present ? `${options.bundle.selfproofState.path}@${options.bundle.selfproofState.sha256 ?? 'unhashed'}` : null;
      evidence.manifest = options.bundle.manifestState.present ? `${options.bundle.manifestState.path}@${options.bundle.manifestState.sha256 ?? 'unhashed'}` : null;
      evidence.historical = null;
    } else {
      evidence.historical = row.historicalEvidence.length > 0 ? row.historicalEvidence.join(',') : null;
    }
    rows.push({
      ...row,
      status,
      statusBasis,
      sourceVerified,
      verifiedTests,
      missingTests,
      oracleStatus,
      artifactChecks,
      evidence,
    });
  }
  const productRows = rows.filter(row => PRODUCT_KINDS.includes(row.kind));
  const harnessRows = rows.filter(row => !PRODUCT_KINDS.includes(row.kind));
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  const selfProofed = harnessRows.filter(row => row.status === 'self_proven').length;
  const partial = harnessRows.filter(row => row.status === 'partial_tooling' || row.status === 'tooling_ready').length;
  const oracles = ALL_SELF_PROOFS.map(proof => ({
    name: proof.name,
    version: proof.version,
    module: proof.module,
    samples: (proof.samples ?? []).length,
    scenarios: (proof.scenarios ?? []).length,
    verified: options.bundle.selfproofCheck?.passingTests.has(oracleTestName(proof.name)) ?? false,
  }));
  const historicalEvidence = await Promise.all(
    HISTORICAL_EVIDENCE.map(async item => {
      try {
        const text = await readFile(join(resolve(options.workspaceRoot), item.path));
        return { path: item.path, present: true, sha256: sha256Hex(text), scope: item.scope, refs: item.refs };
      } catch {
        return { path: item.path, present: false, sha256: null, scope: item.scope, refs: item.refs };
      }
    }),
  );
  for (const evidence of historicalEvidence) {
    if (!evidence.present) issues.push({ code: 'historical_evidence_missing', message: `historical evidence ${evidence.path} is absent` });
  }
  const gaps = buildGaps(rows, options.bundle);
  const summary: TraceabilitySummary = {
    rows: rows.length,
    byKind,
    byStatus,
    product: { total: productRows.length, covered: 0, notCovered: productRows.filter(row => row.status === 'not_covered').length },
    harnessCurated: {
      total: harnessRows.length,
      selfProven: selfProofed,
      partial,
      notCovered: harnessRows.filter(row => row.status === 'not_covered').length,
    },
    oracles: { total: oracles.length, verified: oracles.filter(oracle => oracle.verified).length },
  };
  const artifacts: Record<string, ArtifactState> = {
    selfproof: options.bundle.selfproofState,
    manifest: options.bundle.manifestState,
  };
  return {
    schemaVersion: TRACEABILITY_SCHEMA_VERSION,
    kind: TRACEABILITY_KIND,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    harnessVersion: HARNESS_VERSION,
    selfProofCorpus: SELF_PROOF_CORPUS,
    sources: [...documents.values()],
    planIndexVerified,
    artifacts,
    summary,
    rows,
    oracles,
    historicalEvidence,
    issues,
    gaps,
    disclaimer:
      '本清单只证明需求已登记、来源可核验，以及 H0 测试工具在 manifest/selfproof 冻结的文件身份下完成自证。' +
      '产品 V01–V27、九个系统与 S/FL 场景均未由 H0 运行或验收；not_covered 不得被读作通过，历史有限证据不计入状态。',
    handoff: {
      milestone: 'H0b',
      rule: 'H0b 之后产品行由后续切片按其实际证据更新；禁止后续切片复用 H0 的 tooling_ready 冒充产品通过',
      productRowSource: '产品行状态只能来自该切片的独立运行证据（manifest/selfproof/traceability + 独立效果账本 + 宿主/业务证据）；H0 的 not_covered 保持不变直到该切片实际运行。',
      toolingReadyMeaning: 'tooling_ready 仅表示 H0 判定器已自证、对应产品场景未运行；它不是交付证据，不得升级为 self_proven、通过或覆盖结论。',
      forbidden: [
        '把 tooling_ready 写成产品通过',
        '用 H0 的 oracle 自证替代产品运行证据',
        '用历史有限证据（phase3h/3i 等）覆盖 not_covered',
        '在 WIP 未提交时把共享树结果写成切片证据',
      ],
    },
    commands: [
      'node scripts/harness/manifest.mjs',
      'node scripts/harness/selfproof.mjs',
      'node scripts/harness/traceability.mjs --strict',
      'node --import tsx --test --test-concurrency=1 tests/harness-*.test.ts',
    ],
  };
}

function buildGaps(rows: readonly EvaluatedRequirement[], bundle: ArtifactBundle): string[] {
  const gaps: string[] = [];
  const productRows = rows.filter(row => PRODUCT_KINDS.includes(row.kind));
  gaps.push(`产品需求 ${productRows.length} 项全部未覆盖（H0 范围外）：25 个 V 完整门槛、9 个系统、S01–S08、FL01–FL08、02 §6 组合场景与 E1–E3 均未运行`);
  if (bundle.selfproof === null) gaps.push('缺少自证 artifact：先运行 scripts/harness/selfproof.mjs，否则任何 H0 能力不能标为 self_proven');
  else if (bundle.selfproofCheck?.ok !== true) gaps.push('自证 artifact 未通过或已过期：按失败列表修复后重跑');
  if (bundle.manifest === null) gaps.push('缺少 manifest artifact：先运行 scripts/harness/manifest.mjs');
  else if (bundle.manifestCheck?.ok !== true) gaps.push('manifest 与当前树不一致：重新生成 manifest');
  for (const row of rows) {
    if (row.kind === 'harness-asset' && row.status !== 'self_proven') gaps.push(`H0 资产 ${row.id} ${row.title}：${row.statusBasis}`);
  }
  for (const row of rows.filter(item => item.kind === 'tool-verification' && item.status !== 'tooling_ready')) {
    gaps.push(`工具验真行 ${row.id} 未就绪：${row.statusBasis}`);
  }
  gaps.push('合成业务 fixture 生成器、独立答案集与 HOLDOUT 隔离尚未交付（02 §4.1；H0 只提供 oracle 输入样本与临时真实文件/SQLite）');
  gaps.push('固定宿主适配与恢复驱动、Judge 语义独立评分、长历史/长期运行观察器仍属后续切片；H0 不声明 V24/V25');
  gaps.push('观察器哈希链不是签名；同一机器/用户下的目录不构成秘密隔离，HOLDOUT 答案隔离仍需独立保管');
  return gaps;
}

/* ------------------------------------------------------------------ */
/* Honesty gate.                                                       */
/* ------------------------------------------------------------------ */

/**
 * Reject unsupported claims: product rows may only be `not_covered`; a
 * `self_proven` row needs verified tests and artifacts; unknown statuses or
 * `tooling_ready` without verified oracles fail.
 */
export function checkHonestStatuses(rows: readonly EvaluatedRequirement[]): CheckResult {
  const violations: Violation[] = [];
  for (const row of rows) {
    if (!ALLOWED_STATUSES.includes(row.status)) {
      violations.push(violation('unknown_status', `$["rows"][${JSON.stringify(row.id)}]`, `status ${String(row.status)} is not an allowed evidence layer`));
      continue;
    }
    if (PRODUCT_KINDS.includes(row.kind) && row.status !== 'not_covered') {
      violations.push(violation('product_claim_without_evidence', `$["rows"][${JSON.stringify(row.id)}]`, `product requirement ${row.id} claims ${row.status}; H0 cannot verify product behaviour`));
    }
    if (row.status === 'self_proven') {
      const hasTests = row.verifiedTests.length > 0;
      const hasArtifact = row.artifactChecks.some(check => check.valid);
      const hasOracle = row.oracleStatus.some(oracle => oracle.verified);
      if (!hasTests && !hasArtifact && !hasOracle) {
        violations.push(violation('self_proven_without_evidence', `$["rows"][${JSON.stringify(row.id)}]`, `row ${row.id} is self_proven without any verified test/oracle/artifact`));
      }
      if (row.artifactChecks.some(check => check.present && !check.valid)) {
        violations.push(violation('self_proven_on_invalid_artifact', `$["rows"][${JSON.stringify(row.id)}]`, `row ${row.id} references an invalid/stale artifact`));
      }
      if (row.missingTests.length > 0) {
        violations.push(violation('self_proven_with_missing_tests', `$["rows"][${JSON.stringify(row.id)}]`, `row ${row.id} is self_proven but ${row.missingTests.length} required test(s) are missing`));
      }
    }
    if (row.status === 'tooling_ready' && !row.oracleStatus.some(oracle => oracle.verified)) {
      violations.push(violation('tooling_ready_without_oracle', `$["rows"][${JSON.stringify(row.id)}]`, `row ${row.id} is tooling_ready without a verified oracle`));
    }
    if (!row.sourceVerified) {
      violations.push(violation('row_source_unverified', `$["rows"][${JSON.stringify(row.id)}]`, `row ${row.id} has no verified source reference`));
    }
  }
  return finish(
    {
      oracle: 'traceability',
      version: '1.0.0',
      boundary: '核对追踪表状态诚实性：产品行只能是 not_covered；self_proven 必须有通过测试/经受的 artifact；tooling_ready 必须有自证 oracle；来源不可核验即拒绝。',
      scope: 'traceability-honesty',
    },
    rows.length,
    violations,
  );
}

/* ------------------------------------------------------------------ */
/* Markdown report.                                                    */
/* ------------------------------------------------------------------ */

function statusLabel(status: RequirementStatus): string {
  const labels: Record<RequirementStatus, string> = {
    not_covered: '未覆盖',
    tooling_ready: '工具就绪（场景未运行）',
    partial_tooling: '部分工具',
    self_proven: 'H0 自证通过',
    blocked: '阻塞',
    unknown: '未知',
    failing: '失败',
  };
  return labels[status];
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${header.join(' | ')} |`;
  const separator = `| ${header.map(() => '---').join(' | ')} |`;
  return [head, separator, ...rows.map(row => `| ${row.map(cell => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)].join('\n');
}

function shortTitle(title: string, length = 40): string {
  return title.length <= length ? title : `${title.slice(0, length - 1)}…`;
}

export function renderMarkdown(matrix: TraceabilityMatrix): string {
  const lines: string[] = [];
  lines.push('# H0 测试工具覆盖追踪报告');
  lines.push('');
  lines.push(`生成时间：${matrix.generatedAt}；harness ${matrix.harnessVersion}；self-proof corpus \`${matrix.selfProofCorpus}\`。`);
  lines.push('');
  lines.push(`> ${matrix.disclaimer}`);
  lines.push('');
  lines.push('## 1. 汇总与证据层');
  lines.push('');
  lines.push(
    table(
      ['层级', '计数', '说明'],
      [
        ['总需求行', String(matrix.summary.rows), '需求→来源→代码路径→测试/ oracle→证据→状态'],
        ['产品需求行', String(matrix.summary.product.total), `全部 not_covered=${matrix.summary.product.notCovered}（H0 未运行产品验证）`],
        ['H0 能力行', String(matrix.summary.harnessCurated.total), `self_proven=${matrix.summary.harnessCurated.selfProven}，partial=${matrix.summary.harnessCurated.partial}，not_covered=${matrix.summary.harnessCurated.notCovered}`],
        ['oracle', `${matrix.summary.oracles.verified}/${matrix.summary.oracles.total}`, '自证 artifact 中 oracle:<name> 测试通过的个数'],
        ['来源文档', `${matrix.sources.filter(source => source.present).length}/${matrix.sources.length}`, '标题/表格行引用逐项核验'],
      ],
    ),
  );
  lines.push('');
  lines.push('状态图例：`未覆盖` 不得读作通过；`工具就绪（场景未运行）` 表示 H0 判定器已自证但产品场景未运行；`H0 自证通过` 仅指测试工具自身在冻结文件身份下验真。');
  lines.push('');
  lines.push(`**H0b 交接规则（机器可读字段 \`handoff\`）**：${matrix.handoff.rule}。${matrix.handoff.productRowSource}`);
  lines.push(`明确禁止：${matrix.handoff.forbidden.map(item => `\`${item}\``).join('；')}。`);
  lines.push('');
  lines.push('## 2. 冻结产物（memory of evidence）');
  lines.push('');
  lines.push(
    table(
      ['产物', '存在', 'SHA256', '生成时间', '说明'],
      Object.entries(matrix.artifacts).map(([name, artifact]) => [name, String(artifact.present), artifact.sha256 ?? '—', artifact.generatedAt ?? '—', artifact.note]),
    ),
  );
  lines.push('');
  lines.push('## 3. H0 工具能力（可 self_proven 的唯一一类）');
  lines.push('');
  lines.push(
    table(
      ['ID', '状态', '能力', '测试通过/要求', 'oracle 通过', '证据', '依据/缺口'],
      matrix.rows
        .filter(row => row.kind === 'harness-capability')
        .map(row => [
          row.id,
          statusLabel(row.status),
          shortTitle(row.title, 30),
          `${row.verifiedTests.length}/${row.verifiedTests.length + row.missingTests.length}`,
          `${row.oracleStatus.filter(item => item.verified).length}/${row.oracleStatus.length}`,
          row.evidence.selfproof ?? row.evidence.manifest ?? '—',
          shortTitle(row.statusBasis, 60),
        ]),
    ),
  );
  lines.push('');
  lines.push('## 4. 02 §1 必须资产（H0 范围与缺口）');
  lines.push('');
  lines.push(
    table(
      ['ID', '状态', '资产', '依据/缺口'],
      matrix.rows.filter(row => row.kind === 'harness-asset').map(row => [row.id, statusLabel(row.status), row.title, shortTitle(row.statusBasis, 80)]),
    ),
  );
  lines.push('');
  lines.push('## 5. 工具验真样本（02 §3.2；oracle 就绪 ≠ 场景已运行）');
  lines.push('');
  lines.push(
    table(
      ['ID', '状态', '样本要求', '相关 oracle', '边界'],
      matrix.rows.filter(row => row.kind === 'tool-verification').map(row => [
        row.id,
        statusLabel(row.status),
        shortTitle(row.title, 46),
        row.oracleStatus.length === 0 ? '（无确定性 oracle）' : row.oracleStatus.map(item => `${item.name}${item.verified ? '✓' : '✗'}`).join(', '),
        shortTitle(row.thresholds.join('；') || row.note, 46),
      ]),
    ),
  );
  lines.push('');
  lines.push('## 6. oracle 目录（每个都有 known-pass 与 known-fail 自证）');
  lines.push('');
  lines.push(
    table(
      ['oracle', '版本', '模块', '样本', '场景', '自证'],
      matrix.oracles.map(oracle => [oracle.name, oracle.version, oracle.module, String(oracle.samples), String(oracle.scenarios), oracle.verified ? '通过' : '未通过/缺失']),
    ),
  );
  lines.push('');
  const productGroups: readonly [RequirementKind, string][] = [
    ['nine-system', '九系统（01）'],
    ['system-matrix', '02 §5 验收矩阵'],
    ['v-item', 'V01–V27（原文门槛保留）'],
    ['business-scenario', 'S01–S08 业务场景'],
    ['fl-scenario', 'FL01–FL08 信息流场景'],
    ['scoring-dimension', 'H1–H8 判分维度'],
    ['combo-scenario', '02 §6 组合/长期/故障场景'],
  ];
  let productSection = 1;
  for (const [kind, heading] of productGroups) {
    const rows = matrix.rows.filter(row => row.kind === kind);
    lines.push(`## 7.${productSection} ${heading}`);
    productSection++;
    lines.push('');
    const extraHeader = kind === 'v-item' ? '门槛（摘）' : kind === 'business-scenario' || kind === 'fl-scenario' ? 'V 关联' : '关联';
    lines.push(
      table(
        ['ID', extraHeader, '标题/要求', '状态', '来源'],
        rows.map(row => {
          const relation =
            kind === 'v-item'
              ? shortTitle(row.thresholds.join('；'), 70)
              : [...(row.refs.v ?? []), ...(row.refs.s ?? []), ...(row.refs.fl ?? [])].join(', ') || row.systems.join(',');
          return [row.id, relation, shortTitle(row.title, 50), statusLabel(row.status), `${row.source.doc} ${row.source.heading}`];
        }),
      ),
    );
    lines.push('');
  }
  lines.push('## 8. 来源可核验性');
  lines.push('');
  lines.push(
    table(
      ['文档', '存在', 'SHA256', '被引行核验'],
      matrix.sources.map(source => [
        source.path,
        String(source.present),
        source.sha256 === '' ? '—' : source.sha256,
        String(matrix.rows.filter(row => row.source.doc === source.id && row.sourceVerified).length),
      ]),
    ),
  );
  lines.push('');
  lines.push(`九系统计划 §5 的 V01–V27 索引核验：${matrix.planIndexVerified ? '通过' : '失败'}。`);
  lines.push('');
  lines.push('## 9. 历史有限证据（单独列出，不计入任何状态）');
  lines.push('');
  lines.push(
    table(
      ['证据', '存在', 'SHA256', '范围（历史，限定）', '关联'],
      matrix.historicalEvidence.map(item => [item.path, String(item.present), item.sha256 ?? '—', item.scope, item.refs.join(',') || '—']),
    ),
  );
  lines.push('');
  lines.push('## 10. 未覆盖与下一步');
  lines.push('');
  for (const gap of matrix.gaps) lines.push(`- ${gap}`);
  lines.push('');
  lines.push('## 11. 复核与再生命令');
  lines.push('');
  for (const command of matrix.commands) lines.push(`- \`${command}\``);
  lines.push('');
  lines.push('复核方法：');
  lines.push('');
  lines.push('1. 用 `sha256sum`（或 `shasum -a 256`）核对本文件声明的 artifact SHA256 与 `artifacts/dsh/harness/*.json`。');
  lines.push('2. 打开 `tool-selfproof.json` 确认每个 `oracle:<name>` 测试名为 `ok`，并确认 `sourceHashes` 与当前 `tests/harness/**` 一致（不一致即 evidence 过期，必须重跑）。');
  lines.push('3. 打开 `manifest.json`，任取文件按 `sha256` 重算；`aggregates.digest` 可独立按排序后的 `sha256  path` 行重算。');
  lines.push('4. 对任一需求行：`source` 追到原始 Markdown 标题/表格行；`testIds`/`oracles` 追到自证 artifact；`status` 只按本报告证据层解释。');
  lines.push('5. 任何产品 V/S/FL 结论请查 02 §9 与 `not_covered` 行——本报告不提供产品通过结论。');
  lines.push('');
  if (matrix.issues.length > 0) {
    lines.push('## 12. 生成期问题（必须处理）');
    lines.push('');
    for (const issue of matrix.issues) lines.push(`- \`${issue.code}\`${issue.rowId === undefined ? '' : ` (${issue.rowId})`}: ${issue.message}`);
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export interface TraceabilityCliResult {
  readonly exitCode: number;
  readonly summary: string;
  readonly matrix?: TraceabilityMatrix;
}

export async function runTraceabilityCli(argv: readonly string[]): Promise<TraceabilityCliResult> {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const workspaceModuleRoot = resolve(moduleRoot, '../..');
  let pluginRoot = moduleRoot;
  let workspaceRoot = workspaceModuleRoot;
  let outDir = join(pluginRoot, 'artifacts/dsh/harness');
  let selfproofPath: string | undefined;
  let manifestPath: string | undefined;
  let strict = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--plugin-root') pluginRoot = resolve(argv[++index] ?? pluginRoot);
    else if (argument === '--workspace-root') workspaceRoot = resolve(argv[++index] ?? workspaceRoot);
    else if (argument === '--out-dir') outDir = resolve(argv[++index] ?? outDir);
    else if (argument === '--selfproof') selfproofPath = resolve(argv[++index] ?? '');
    else if (argument === '--manifest') manifestPath = resolve(argv[++index] ?? '');
    else if (argument === '--strict') strict = true;
    else if (argument === '--help') return { exitCode: 0, summary: 'usage: node --import tsx tests/harness/traceability.ts [--plugin-root d] [--workspace-root d] [--out-dir d] [--selfproof f] [--manifest f] [--strict]' };
    else return { exitCode: 1, summary: `unknown argument ${argument}` };
  }
  try {
    const bundle = await loadArtifacts({ pluginRoot, outputDir: outDir, selfproofPath, manifestPath });
    const matrix = await evaluateTraceability({ pluginRoot, workspaceRoot, bundle });
    const honesty = checkHonestStatuses(matrix.rows);
    if (!honesty.ok) {
      return { exitCode: 2, summary: `traceability honesty gate failed:\n${honesty.violations.map(item => `  - ${item.code} (${item.path}): ${item.message}`).join('\n')}`, matrix };
    }
    const hardIssues = matrix.issues.filter(issue => issue.code !== 'selfproof_artifact_issue' && issue.code !== 'manifest_artifact_issue');
    await import('node:fs/promises').then(async fs => {
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(join(outDir, TRACEABILITY_JSON), `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
      await fs.writeFile(join(outDir, TRACEABILITY_MARKDOWN), `${renderMarkdown(matrix)}\n`, 'utf8');
    });
    const summaryLines = [
      `traceability written: ${relative(workspaceRoot, join(outDir, TRACEABILITY_JSON))} + ${TRACEABILITY_MARKDOWN}`,
      `  rows=${matrix.summary.rows} kinds=${Object.keys(matrix.summary.byKind).length}`,
      `  product not_covered=${matrix.summary.product.notCovered}/${matrix.summary.product.total} (0 claimed covered)`,
      `  H0 self_proven=${matrix.summary.harnessCurated.selfProven}/${matrix.summary.harnessCurated.total} partial=${matrix.summary.harnessCurated.partial} not_covered=${matrix.summary.harnessCurated.notCovered}`,
      `  oracles verified=${matrix.summary.oracles.verified}/${matrix.summary.oracles.total}`,
      `  sources verified=${matrix.sources.filter(source => source.present).length}/${matrix.sources.length} planVIndex=${matrix.planIndexVerified}`,
      `  artifacts selfproof=${matrix.artifacts.selfproof.present ? 'present' : 'absent'} manifest=${matrix.artifacts.manifest.present ? 'present' : 'absent'}`,
      `  issues=${matrix.issues.length} hardIssues=${hardIssues.length}`,
    ];
    const hidden = matrix.issues.filter(issue => issue.code.startsWith('selfproof_') || issue.code.startsWith('manifest_'));
    if (hidden.length > 0) summaryLines.push(`  artifact issues: ${hidden.length}（先重跑 manifest/selfproof）`);
    const capabilitiesUnproven = matrix.rows.some(row => row.kind === 'harness-capability' && row.status !== 'self_proven');
    const exitCode = strict && (capabilitiesUnproven || hardIssues.length > 0) ? 3 : 0;
    if (exitCode === 3) {
      summaryLines.push(
        capabilitiesUnproven
          ? '  --strict: H0 能力仍未全部 self_proven（见报告 §3）'
          : `  --strict: 生成期存在 ${hardIssues.length} 个 hard issue（见报告 §12）`,
      );
    }
    if (hardIssues.length > 0) summaryLines.push(`  hard issues:\n${hardIssues.slice(0, 20).map(issue => `    - ${issue.code}${issue.rowId === undefined ? '' : ` (${issue.rowId})`}: ${issue.message}`).join('\n')}`);
    return { exitCode, summary: summaryLines.join('\n'), matrix };
  } catch (error) {
    return { exitCode: 1, summary: `traceability generation failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}` };
  }
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(moduleUrl));
}

if (isMain(import.meta.url)) {
  const result = await runTraceabilityCli(process.argv.slice(2));
  process.stderr.write(`${result.summary}\n`);
  process.exitCode = result.exitCode;
}
