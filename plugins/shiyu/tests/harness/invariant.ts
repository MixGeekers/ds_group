/**
 * Shared oracle contract for the H0 test harness.
 *
 * Every detector in this directory returns a `CheckResult` instead of
 * throwing, so a caller can keep going, collect denominators and print
 * per-assertion evidence. `assertCheck` is the release-gate adapter that
 * turns a failed result into an `OracleFailure` error.
 *
 * The self-proof framework (`OracleSelfProof`, `runSelfProof`) makes
 * "the detector rejects known errors" executable instead of prose: each
 * oracle must ship at least one known-accept and one known-reject sample
 * (or async scenario) and the H0 self-proof test suite executes them all.
 * A detector that merely returns true for correct input does not pass.
 */
import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Machine-readable violation code. Codes are stable identifiers, not prose. */
export type CheckCode = string;

export interface Violation {
  readonly code: CheckCode;
  /** JSON-pointer-like location, e.g. `$["items"][3]["id"]`. */
  readonly path: string;
  readonly message: string;
  readonly detail?: JsonValue;
}

export interface CheckMetrics {
  readonly [key: string]: JsonValue;
}

/**
 * Result of one deterministic check. `ok` is derived from `violations`
 * being empty; it is never set independently.
 */
export interface CheckResult {
  readonly oracle: string;
  readonly version: string;
  /** One sentence describing the decision boundary of the oracle. */
  readonly boundary: string;
  /** What the particular invocation looked at. */
  readonly scope: string;
  readonly ok: boolean;
  /** Number of primary assertions/items examined, used as a denominator. */
  readonly checked: number;
  readonly violations: readonly Violation[];
  readonly metrics: CheckMetrics;
}

export interface ResultContext {
  readonly oracle: string;
  readonly version: string;
  readonly boundary: string;
  readonly scope: string;
}

export function violation(code: CheckCode, path: string, message: string, detail?: JsonValue): Violation {
  return detail === undefined ? { code, path, message } : { code, path, message, detail };
}

export function finish(
  context: ResultContext,
  checked: number,
  violations: readonly Violation[],
  metrics: CheckMetrics = {},
): CheckResult {
  return {
    oracle: context.oracle,
    version: context.version,
    boundary: context.boundary,
    scope: context.scope,
    ok: violations.length === 0,
    checked,
    violations: [...violations],
    metrics,
  };
}

export function pass(context: ResultContext, checked: number, metrics: CheckMetrics = {}): CheckResult {
  return finish(context, checked, [], metrics);
}

export function fail(
  context: ResultContext,
  checked: number,
  violations: readonly Violation[],
  metrics: CheckMetrics = {},
): CheckResult {
  return finish(context, checked, violations, metrics);
}

export function codesOf(result: CheckResult): string[] {
  return result.violations.map(item => item.code);
}

/** Thrown only by the `assert*` adapters, never by a detector. */
export class OracleFailure extends Error {
  readonly result: CheckResult;

  constructor(result: CheckResult, label?: string) {
    const summary = result.violations
      .map(item => `${item.code}@${item.path}: ${item.message}`)
      .join('; ');
    super(`${label ?? 'oracle'} failed (${result.oracle}): ${summary}`);
    this.name = 'OracleFailure';
    this.result = result;
  }
}

/**
 * Release-gate adapter: a check that is not `ok` becomes an exception.
 * Callers that need to keep executing use `check*` directly.
 */
export function assertCheck(result: CheckResult, label?: string): void {
  if (!result.ok) throw new OracleFailure(result, label);
}

export function passOrThrow(result: CheckResult, label?: string): CheckResult {
  assertCheck(result, label);
  return result;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function jsonPointerChild(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
}

/* ------------------------------------------------------------------ */
/* Oracle self-proof framework (known-accept / known-reject samples).  */
/* ------------------------------------------------------------------ */

export type ExpectedVerdict = 'accept' | 'reject';

export interface OracleSample {
  readonly label: string;
  readonly input: unknown;
  readonly expect: ExpectedVerdict;
  /** Required for `reject`: every listed code must appear in the result. */
  readonly expectCodes?: readonly string[];
  /** Why this sample is correct/incorrect, i.e. the human-checkable answer. */
  readonly why: string;
}

export interface OracleScenarioProof {
  readonly label: string;
  readonly expect: ExpectedVerdict;
  readonly expectCodes?: readonly string[];
  readonly why: string;
  readonly run: () => Promise<CheckResult>;
}

/**
 * Declarative self-proof shipped by every oracle. `samples` exercise the
 * synchronous detector through `evaluate`; `scenarios` exercise async
 * behaviour (real files, child processes, clocks) and return a CheckResult.
 */
export interface OracleSelfProof {
  readonly name: string;
  readonly version: string;
  /** Module that implements this oracle, relative to the plugin root. */
  readonly module: string;
  readonly boundary: string;
  readonly samples?: readonly OracleSample[];
  readonly scenarios?: readonly OracleScenarioProof[];
  readonly evaluate?: (input: unknown) => CheckResult;
}

export type SelfProofOutcomeKind = 'sample' | 'scenario';

export interface SelfProofOutcome {
  readonly kind: SelfProofOutcomeKind;
  readonly label: string;
  readonly expect: ExpectedVerdict;
  readonly actual: 'accept' | 'reject' | 'error';
  readonly ok: boolean;
  readonly expectCodes: readonly string[];
  readonly actualCodes: readonly string[];
  readonly why: string;
  readonly error?: string;
  readonly result?: CheckResult;
}

export interface SelfProofRun {
  readonly oracle: string;
  readonly version: string;
  readonly module: string;
  readonly boundary: string;
  readonly outcomes: readonly SelfProofOutcome[];
  readonly failures: readonly string[];
  readonly accepted: number;
  readonly rejected: number;
  readonly sampleCount: number;
  readonly scenarioCount: number;
  readonly ok: boolean;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function resultCodes(result: CheckResult): string[] {
  return result.violations.map(item => item.code);
}

function judgeOutcome(
  base: Omit<SelfProofOutcome, 'actual' | 'ok' | 'actualCodes' | 'error' | 'result'>,
  outcome: { result?: CheckResult; error?: string },
): SelfProofOutcome {
  if (outcome.error !== undefined) {
    return { ...base, actual: 'error', ok: false, actualCodes: [], error: outcome.error };
  }
  const result = outcome.result!;
  const actualCodes = resultCodes(result);
  const actual: 'accept' | 'reject' = result.ok ? 'accept' : 'reject';
  let ok: boolean;
  if (base.expect === 'accept') {
    ok = result.ok && result.violations.length === 0;
  } else {
    ok = !result.ok && base.expectCodes.length > 0 && base.expectCodes.every(code => actualCodes.includes(code));
  }
  return { ...base, actual, ok, actualCodes, result };
}

function proofContractFailures(proof: OracleSelfProof): string[] {
  const failures: string[] = [];
  if (!NAME_PATTERN.test(proof.name)) failures.push(`oracle name is not kebab-case: ${proof.name}`);
  if (!VERSION_PATTERN.test(proof.version)) failures.push(`${proof.name}: version must be semver x.y.z, got ${proof.version}`);
  if (proof.boundary.trim().length < 20) failures.push(`${proof.name}: boundary must be a meaningful sentence`);
  if (proof.module.trim().length === 0) failures.push(`${proof.name}: module must be declared`);
  const samples = proof.samples ?? [];
  const scenarios = proof.scenarios ?? [];
  if (samples.length === 0 && scenarios.length === 0) failures.push(`${proof.name}: no self-proof samples or scenarios`);
  if (samples.length > 0 && typeof proof.evaluate !== 'function') failures.push(`${proof.name}: samples require evaluate()`);
  const labels = [...samples.map(item => item.label), ...scenarios.map(item => item.label)];
  if (new Set(labels).size !== labels.length) failures.push(`${proof.name}: duplicate sample/scenario labels`);
  for (const sample of samples) {
    if (sample.expect === 'reject' && (sample.expectCodes === undefined || sample.expectCodes.length === 0)) {
      failures.push(`${proof.name}/${sample.label}: reject sample must declare expectCodes`);
    }
    if (sample.why.trim().length === 0) failures.push(`${proof.name}/${sample.label}: missing why`);
  }
  for (const scenario of scenarios) {
    if (scenario.expect === 'reject' && (scenario.expectCodes === undefined || scenario.expectCodes.length === 0)) {
      failures.push(`${proof.name}/${scenario.label}: reject scenario must declare expectCodes`);
    }
    if (scenario.why.trim().length === 0) failures.push(`${proof.name}/${scenario.label}: missing why`);
  }
  const expects = [...samples, ...scenarios].map(item => item.expect);
  if (!expects.includes('accept')) failures.push(`${proof.name}: needs at least one known-accept proof`);
  if (!expects.includes('reject')) failures.push(`${proof.name}: needs at least one known-reject proof`);
  return failures;
}

/**
 * Run every declared sample/scenario and verify each verdict matches the
 * pre-declared expectation. This is the executable form of "判定器会拒绝
 * 错误": a negative sample that the oracle silently accepts turns this
 * run into a failure, and a positive sample the oracle false-rejects
 * also fails.
 */
export async function runSelfProof(proof: OracleSelfProof): Promise<SelfProofRun> {
  const contractFailures = proofContractFailures(proof);
  const outcomes: SelfProofOutcome[] = [];
  for (const sample of proof.samples ?? []) {
    const base = {
      kind: 'sample' as const,
      label: sample.label,
      expect: sample.expect,
      expectCodes: sample.expectCodes ?? [],
      why: sample.why,
    };
    try {
      const result = proof.evaluate!(sample.input);
      outcomes.push(judgeOutcome(base, { result }));
    } catch (error) {
      outcomes.push(judgeOutcome(base, { error: error instanceof Error ? error.message : String(error) }));
    }
  }
  for (const scenario of proof.scenarios ?? []) {
    const base = {
      kind: 'scenario' as const,
      label: scenario.label,
      expect: scenario.expect,
      expectCodes: scenario.expectCodes ?? [],
      why: scenario.why,
    };
    try {
      outcomes.push(judgeOutcome(base, { result: await scenario.run() }));
    } catch (error) {
      outcomes.push(judgeOutcome(base, { error: error instanceof Error ? error.message : String(error) }));
    }
  }
  const failures: string[] = [...contractFailures];
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      const codes = outcome.actualCodes.length > 0 ? ` actual codes=[${outcome.actualCodes.join(',')}]` : '';
      const error = outcome.error === undefined ? '' : ` error=${outcome.error}`;
      failures.push(
        `${proof.name}/${outcome.label}: expected ${outcome.expect}${outcome.expectCodes.length > 0 ? ` [${outcome.expectCodes.join(',')}]` : ''},` +
          ` actual=${outcome.actual}${codes}${error} (${outcome.why})`,
      );
    }
  }
  const accepted = outcomes.filter(item => item.actual === 'accept').length;
  const rejected = outcomes.filter(item => item.actual === 'reject').length;
  return {
    oracle: proof.name,
    version: proof.version,
    module: proof.module,
    boundary: proof.boundary,
    outcomes,
    failures,
    accepted,
    rejected,
    sampleCount: (proof.samples ?? []).length,
    scenarioCount: (proof.scenarios ?? []).length,
    ok: failures.length === 0,
  };
}

export function selfProofFailureMessage(run: SelfProofRun): string {
  if (run.ok) return `${run.oracle}: self-proof passed`;
  return `${run.oracle}: ${run.failures.length} self-proof failure(s):\n${run.failures.map(item => `  - ${item}`).join('\n')}`;
}
