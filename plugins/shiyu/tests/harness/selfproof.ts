/**
 * H0 self-proof runner and TAP parser.
 *
 * Runs every root-level `tests/harness-*.test.ts` file through the Node test
 * runner with the TAP reporter, parses per-test pass/fail names, and writes a
 * frozen artifact (`tool-selfproof.json` + raw `tool-selfproof.tap`) that
 * records:
 * - per-file SHA256, exit code, pass/fail counts, and every test name;
 * - per-oracle self-proof verification (`oracle:<name>` passed);
 * - source hashes used to detect stale evidence later.
 *
 * `passed` is derived strictly: every expected file present, exit code 0,
 * zero failing tests, and no skipped-only claim. A failed run is still
 * written (with `passed:false`) so failures remain auditable instead of
 * being hidden by an absent artifact.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult, Violation } from './invariant.js';
import { finish, sha256Hex, violation } from './invariant.js';
import { ALL_SELF_PROOFS, oracleTestName } from './index.js';
import { HARNESS_VERSION, SELF_PROOF_CORPUS } from './version.js';

export const SELF_PROOF_SCHEMA_VERSION = 1;
export const SELF_PROOF_KIND = 'shiyu.harness.selfproof';
export const SELF_PROOF_ARTIFACT = 'tool-selfproof.json';
export const SELF_PROOF_TAP = 'tool-selfproof.tap';

export interface TapTestCase {
  readonly name: string;
  readonly ok: boolean;
}

export interface TapSummary {
  readonly tests: readonly TapTestCase[];
  readonly pass: number;
  readonly fail: number;
  readonly skipped: number;
  readonly todo: number;
  readonly cancelled: number;
}

/** Parse Node's TAP reporter output, keeping nested subtest names. */
export function parseTap(text: string): TapSummary {
  const tests: TapTestCase[] = [];
  const counters = { pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const summaryMatch = /^# (pass|fail|skipped|cancelled|todo) (\d+)$/.exec(line.trim());
    if (summaryMatch !== null) {
      counters[summaryMatch[1] as keyof typeof counters] = Number(summaryMatch[2]);
      continue;
    }
    const match = /^\s*(ok|not ok) \d+ - (.+?)(?:\s+#\s+(SKIP|TODO|CANCELLED)\b.*)?$/.exec(line);
    if (match === null) continue;
    const ok = match[1] === 'ok';
    let name = match[2].trim();
    const directive = match[3];
    if (directive !== undefined) {
      counters[directive === 'SKIP' ? 'skipped' : directive === 'TODO' ? 'todo' : 'cancelled'] += 1;
      continue;
    }
    // File-level results are named after the test file path; keep them out of
    // the per-test list but retain them for evidence in the raw TAP file.
    if (name.endsWith('.test.ts') || name.startsWith('/')) continue;
    name = name.replace(/\s+#\s+.*$/, '');
    tests.push({ name, ok });
  }
  return {
    tests,
    pass: tests.filter(item => item.ok).length,
    fail: tests.filter(item => !item.ok).length,
    skipped: counters.skipped,
    todo: counters.todo,
    cancelled: counters.cancelled,
  };
}

export interface SelfProofFileResult {
  readonly path: string;
  readonly sha256: string;
  readonly exitCode: number;
  readonly ok: boolean;
  readonly tests: readonly TapTestCase[];
  readonly pass: number;
  readonly fail: number;
  readonly durationMs: number;
  readonly tapSha256: string;
}

export interface SelfProofArtifact {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly generatedAt: string;
  readonly harnessVersion: string;
  readonly selfProofCorpus: string;
  readonly pluginRoot: '<plugin-root>';
  readonly command: readonly string[];
  readonly environment: { readonly node: string; readonly platform: string; readonly arch: string };
  readonly expectedFiles: readonly string[];
  readonly files: readonly SelfProofFileResult[];
  readonly totals: { readonly pass: number; readonly fail: number; readonly skipped: number; readonly cancelled: number; readonly todo: number; readonly files: number };
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly oracleSelfProofs: readonly { readonly name: string; readonly testName: string; readonly verified: boolean }[];
  /** SHA256 of every `tests/harness/**` source and every harness test file. */
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly rawTap: { readonly path: string; readonly sha256: string; readonly bytes: number };
}

export async function listHarnessTestFiles(pluginRoot: string): Promise<string[]> {
  const testsDir = join(pluginRoot, 'tests');
  const entries = await readdir(testsDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && /^harness-.*\.test\.ts$/.test(entry.name))
    .map(entry => `tests/${entry.name}`)
    .sort();
}

async function collectSourceHashes(pluginRoot: string, testFiles: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const harnessRoot = join(pluginRoot, 'tests/harness');
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') continue;
        await walk(join(directory, entry.name), `${prefix}/${entry.name}`);
      } else if (entry.isFile()) {
        hashes[`${prefix}/${entry.name}`] = sha256Hex(await readFile(join(directory, entry.name)));
      }
    }
  };
  await walk(harnessRoot, 'tests/harness');
  for (const testFile of testFiles) {
    hashes[testFile] = sha256Hex(await readFile(join(pluginRoot, testFile)));
  }
  return hashes;
}

export interface RunSelfProofOptions {
  readonly pluginRoot: string;
  readonly outDir: string;
  readonly generatedAt?: Date;
  readonly timeoutMs?: number;
}

export async function runSelfProofSuite(options: RunSelfProofOptions): Promise<SelfProofArtifact> {
  const pluginRoot = resolve(options.pluginRoot);
  const expectedFiles = await listHarnessTestFiles(pluginRoot);
  if (expectedFiles.length === 0) throw new Error('no tests/harness-*.test.ts files found');
  const outDir = resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const files: SelfProofFileResult[] = [];
  const tapTexts: string[] = [];
  const failures: string[] = [];
  for (const testFile of expectedFiles) {
    const absolute = join(pluginRoot, testFile);
    const sha256 = sha256Hex(await readFile(absolute));
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', absolute], {
      cwd: pluginRoot,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 20 * 60 * 1000,
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, HARNESS_SELF_PROOF: '1' },
    });
    const tap = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const summary = parseTap(tap);
    const exitCode = result.status ?? (result.error !== undefined ? 1 : 0);
    const ok = exitCode === 0 && summary.fail === 0 && summary.cancelled === 0 && summary.tests.length > 0;
    for (const test of summary.tests) {
      if (!test.ok) failures.push(`${testFile}::${test.name}`);
    }
    if (result.error !== undefined) failures.push(`${testFile}::spawn-error:${result.error.message}`);
    if (!ok && summary.tests.length === 0) failures.push(`${testFile}::no-tests-parsed`);
    files.push({
      path: testFile,
      sha256,
      exitCode,
      ok,
      tests: summary.tests,
      pass: summary.pass,
      fail: summary.fail,
      durationMs: Date.now() - startedAt,
      tapSha256: sha256Hex(tap),
    });
    tapTexts.push(`# ===== ${testFile} exit=${exitCode} =====\n${tap}`);
  }
  const oracleSelfProofs = ALL_SELF_PROOFS.map(proof => {
    const testName = oracleTestName(proof.name);
    const verified = files.some(file => file.tests.some(test => test.ok && test.name === testName));
    return { name: proof.name, testName, verified };
  });
  for (const oracle of oracleSelfProofs) if (!oracle.verified) failures.push(`oracle:${oracle.name}::missing-passing-self-proof`);
  const totals = {
    pass: files.reduce((sum, file) => sum + file.pass, 0),
    fail: files.reduce((sum, file) => sum + file.fail, 0),
    skipped: 0,
    cancelled: 0,
    todo: 0,
    files: files.length,
  };
  const passed = files.every(file => file.ok) && failures.length === 0;
  const rawTapText = tapTexts.join('\n');
  const tapPath = join(outDir, SELF_PROOF_TAP);
  await writeFile(tapPath, rawTapText, 'utf8');
  const artifact: SelfProofArtifact = {
    schemaVersion: SELF_PROOF_SCHEMA_VERSION,
    kind: SELF_PROOF_KIND,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    harnessVersion: HARNESS_VERSION,
    selfProofCorpus: SELF_PROOF_CORPUS,
    pluginRoot: '<plugin-root>',
    command: ['node', '--import', 'tsx', 'scripts/harness/selfproof.mjs'],
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    expectedFiles,
    files,
    totals,
    passed,
    failures,
    oracleSelfProofs,
    sourceHashes: await collectSourceHashes(pluginRoot, expectedFiles),
    rawTap: { path: SELF_PROOF_TAP, sha256: sha256Hex(rawTapText), bytes: Buffer.byteLength(rawTapText, 'utf8') },
  };
  await writeFile(join(outDir, SELF_PROOF_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return artifact;
}

export interface SelfProofArtifactCheck {
  readonly result: CheckResult;
  readonly passingTests: ReadonlySet<string>;
  readonly failingTests: ReadonlySet<string>;
  readonly fresh: boolean;
}

/**
 * Validate a self-proof artifact against the current tree. This is what stops
 * a stale or hand-edited artifact from being accepted as release evidence:
 * `passed:true` with a failure, a non-zero file exit, a missing oracle test
 * or a changed harness source all fail.
 */
export async function checkSelfProofArtifact(artifact: unknown, options: { pluginRoot: string }): Promise<SelfProofArtifactCheck> {
  const violations: Violation[] = [];
  const shape = artifact as Partial<SelfProofArtifact> | null;
  if (shape === null || typeof shape !== 'object' || shape.kind !== SELF_PROOF_KIND || shape.schemaVersion !== SELF_PROOF_SCHEMA_VERSION) {
    violations.push(violation('artifact_shape_invalid', '$', 'self-proof artifact is missing or has the wrong kind/schemaVersion'));
    return {
      result: finish({ oracle: 'selfproof', version: '1.0.0', boundary: SELF_PROOF_BOUNDARY, scope: 'artifact' }, 0, violations),
      passingTests: new Set(),
      failingTests: new Set(),
      fresh: false,
    };
  }
  const files = shape.files ?? [];
  const passingTests = new Set<string>();
  const failingTests = new Set<string>();
  for (const file of files) {
    for (const test of file.tests) {
      if (test.ok) passingTests.add(test.name);
      else failingTests.add(test.name);
    }
  }
  const expectedFiles = await listHarnessTestFiles(options.pluginRoot);
  if (shape.passed === true) {
    for (const file of files) {
      if (!file.ok || file.exitCode !== 0 || file.fail > 0) {
        violations.push(violation('artifact_claims_pass_with_failures', '$', `artifact claims pass but ${file.path} has exit=${file.exitCode} fail=${file.fail}`));
      }
    }
    if ((shape.failures ?? []).length > 0) violations.push(violation('artifact_claims_pass_with_failures', '$["failures"]', 'artifact claims pass but lists failures'));
    if ((shape.totals?.fail ?? 0) > 0) violations.push(violation('artifact_claims_pass_with_failures', '$["totals"]["fail"]', 'artifact claims pass but totals.fail > 0'));
  } else {
    violations.push(violation('selfproof_not_passed', '$["passed"]', 'self-proof run did not pass; its evidence cannot support release gates'));
  }
  for (const file of expectedFiles) {
    if (!files.some(item => item.path === file)) violations.push(violation('expected_test_file_missing', '$["files"]', `${file} was not executed in this artifact`));
  }
  const oracleSelfProofs = shape.oracleSelfProofs ?? [];
  for (const proof of ALL_SELF_PROOFS) {
    const entry = oracleSelfProofs.find(item => item.name === proof.name);
    if (entry === undefined || !entry.verified) violations.push(violation('oracle_unverified', '$["oracleSelfProofs"]', `oracle ${proof.name} has no passing self-proof test in the artifact`));
    if (!passingTests.has(oracleTestName(proof.name))) violations.push(violation('oracle_test_missing', '$["files"]', `passing test ${oracleTestName(proof.name)} not found`));
  }
  // Freshness: recorded source hash for every current harness file must match.
  const recorded = shape.sourceHashes ?? {};
  let fresh = true;
  const currentHarness = await collectSourceHashes(options.pluginRoot, expectedFiles);
  for (const [path, hash] of Object.entries(currentHarness)) {
    if (recorded[path] === undefined) {
      violations.push(violation('stale_selfproof', '$["sourceHashes"]', `current harness file ${path} is not recorded in the artifact`));
      fresh = false;
    } else if (recorded[path] !== hash) {
      violations.push(violation('stale_selfproof', '$["sourceHashes"]', `harness file ${path} changed after the self-proof run`));
      fresh = false;
    }
  }
  return {
    result: finish(
      { oracle: 'selfproof', version: '1.0.0', boundary: SELF_PROOF_BOUNDARY, scope: 'artifact' },
      files.length + oracleSelfProofs.length,
      violations,
      { files: files.length, pass: shape.totals?.pass ?? 0, fail: shape.totals?.fail ?? 0, fresh },
    ),
    passingTests,
    failingTests,
    fresh,
  };
}

const SELF_PROOF_BOUNDARY =
  '核对 H0 自证 artifact：所有预期测试文件执行、零失败、passed 不得与失败并存、每个 oracle 的已知正确/错误样本测试均通过、sourceHashes 与当前文件一致（防 stale 证据）。' +
  '不证明产品行为，只证明测试工具自身在本次文件版本下验真。';

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export interface SelfProofCliResult {
  readonly exitCode: number;
  readonly summary: string;
  readonly artifact?: SelfProofArtifact;
}

export function runSelfProofCli(argv: readonly string[]): Promise<SelfProofCliResult> {
  return runSelfProofCliInternal(argv);
}

async function runSelfProofCliInternal(argv: readonly string[]): Promise<SelfProofCliResult> {
  const moduleRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  let pluginRoot = moduleRoot;
  let outDir = join(pluginRoot, 'artifacts/dsh/harness');
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--plugin-root') pluginRoot = resolve(argv[++index] ?? pluginRoot);
    else if (argument === '--out-dir') outDir = resolve(argv[++index] ?? outDir);
    else if (argument === '--help') return { exitCode: 0, summary: 'usage: node --import tsx tests/harness/selfproof.ts [--plugin-root <dir>] [--out-dir <dir>]' };
    else return { exitCode: 1, summary: `unknown argument ${argument}` };
  }
  try {
    const artifact = await runSelfProofSuite({ pluginRoot, outDir });
    const fileLines = artifact.files.map(file => `  ${file.ok ? 'PASS' : 'FAIL'} ${file.path} tests=${file.tests.length} pass=${file.pass} fail=${file.fail} exit=${file.exitCode} ${file.durationMs}ms`);
    const verifiedOracles = artifact.oracleSelfProofs.filter(item => item.verified).length;
    const summary =
      `self-proof ${artifact.passed ? 'PASSED' : 'FAILED'}\n` +
      `${fileLines.join('\n')}\n` +
      `  files=${artifact.totals.files} pass=${artifact.totals.pass} fail=${artifact.totals.fail}\n` +
      `  oracle self-proofs verified=${verifiedOracles}/${artifact.oracleSelfProofs.length}\n` +
      `  artifact=${relative(outDir, join(outDir, SELF_PROOF_ARTIFACT))} tap=${SELF_PROOF_TAP}\n` +
      (artifact.failures.length === 0 ? '' : `  failures:\n${artifact.failures.map(item => `    - ${item}`).join('\n')}\n`);
    return { exitCode: artifact.passed ? 0 : 1, summary, artifact };
  } catch (error) {
    return { exitCode: 1, summary: `self-proof run failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}` };
  }
}

function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(moduleUrl));
}

if (isMain(import.meta.url)) {
  const result = await runSelfProofCli(process.argv.slice(2));
  process.stderr.write(`${result.summary}\n`);
  process.exitCode = result.exitCode;
}

/** Sanitise a path for evidence by replacing the home/plugin prefixes. */
export function sanitisePath(path: string, pluginRoot: string): string {
  return resolve(path).replaceAll(resolve(pluginRoot), '<plugin-root>').replaceAll(homedir(), '<home>');
}
