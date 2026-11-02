/**
 * Self-proof runner tests (H0.SELFCHECK) and the documentation contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELF_PROOF_KIND,
  checkSelfProofArtifact,
  listHarnessTestFiles,
  parseTap,
  type SelfProofArtifact,
} from './harness/selfproof.js';
import { ALL_SELF_PROOFS, oracleTestName } from './harness/index.js';
import { sha256Hex } from './harness/invariant.js';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const SAMPLE_TAP = `TAP version 13
# Subtest: outer
    # Subtest: nested pass
    ok 1 - nested pass
      ---
      duration_ms: 0.1
      ...
    # Subtest: nested fail
    not ok 2 - nested fail
      ---
      duration_ms: 0.2
      failureType: 'testCodeFailure'
      ...
    1..2
ok 3 - outer
# Subtest: skipped one
ok 4 - skipped one # SKIP not today
1..4
# tests 4
# pass 2
# fail 1
# skipped 1
# cancelled 0
# todo 0
# duration_ms 12.5
`;

async function collectSourceHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}/${entry.name}`);
      else hashes[`${prefix}/${entry.name}`] = sha256Hex(await readFile(join(directory, entry.name)));
    }
  };
  await walk(join(pluginRoot, 'tests/harness'), 'tests/harness');
  for (const testFile of await listHarnessTestFiles(pluginRoot)) hashes[testFile] = sha256Hex(await readFile(join(pluginRoot, testFile)));
  return hashes;
}

async function buildArtifact(patch: (artifact: Record<string, unknown>) => void = () => {}): Promise<SelfProofArtifact> {
  const expectedFiles = await listHarnessTestFiles(pluginRoot);
  const sourceHashes = await collectSourceHashes();
  const tests = [...ALL_SELF_PROOFS.map(proof => ({ name: oracleTestName(proof.name), ok: true })), { name: 'docs:readme-contract', ok: true }];
  const artifact: Record<string, unknown> = {
    schemaVersion: 1,
    kind: SELF_PROOF_KIND,
    generatedAt: '2026-11-02T00:00:00.000Z',
    harnessVersion: '0.1.0',
    selfProofCorpus: 'h0-selfproof-1',
    pluginRoot: '<plugin-root>',
    command: [],
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    expectedFiles,
    files: expectedFiles.map((path, index) => ({
      path,
      sha256: sourceHashes[path],
      exitCode: 0,
      ok: true,
      tests: index === 0 ? tests : [],
      pass: index === 0 ? tests.length : 0,
      fail: 0,
      durationMs: 1,
      tapSha256: 'a'.repeat(64),
    })),
    totals: { pass: tests.length, fail: 0, skipped: 0, cancelled: 0, todo: 0, files: expectedFiles.length },
    passed: true,
    failures: [],
    oracleSelfProofs: ALL_SELF_PROOFS.map(proof => ({ name: proof.name, testName: oracleTestName(proof.name), verified: true })),
    sourceHashes,
    rawTap: { path: 'tool-selfproof.tap', sha256: 'b'.repeat(64), bytes: 2 },
  };
  patch(artifact);
  return artifact as unknown as SelfProofArtifact;
}

test('selfproof:tap-parser', () => {
  const summary = parseTap(SAMPLE_TAP);
  assert.equal(summary.pass, 2);
  assert.equal(summary.fail, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.cancelled, 0);
  const names = summary.tests.map(testCase => testCase.name);
  assert.ok(names.includes('nested pass'));
  assert.ok(names.includes('nested fail'));
  assert.ok(names.includes('outer'));
  assert.equal(names.filter(name => name.includes('skipped one') && !name.includes('SKIP')).length, 0, 'skip directive must not be counted as a passing test');
  assert.equal(summary.tests.find(testCase => testCase.name === 'nested fail')?.ok, false);
  const fileLevel = parseTap('ok 1 - /tmp/some.test.ts\n');
  assert.equal(fileLevel.tests.length, 0, 'file-level results are not test IDs');
  assert.equal(parseTap('').tests.length, 0);
});

test('selfproof:artifact-honesty-validation', async () => {
  const clean = await checkSelfProofArtifact(await buildArtifact(), { pluginRoot });
  assert.equal(clean.result.ok, true, JSON.stringify(clean.result.violations));
  assert.equal(clean.fresh, true);
  assert.equal(ALL_SELF_PROOFS.every(proof => clean.passingTests.has(oracleTestName(proof.name))), true);

  const claimsPassWithFailure = await buildArtifact(artifact => {
    const files = artifact.files as { ok: boolean; exitCode: number; fail: number }[];
    files[0].ok = false;
    files[0].exitCode = 1;
    files[0].fail = 1;
  });
  const failureCheck = await checkSelfProofArtifact(claimsPassWithFailure, { pluginRoot });
  assert.equal(failureCheck.result.ok, false);
  assert.ok(failureCheck.result.violations.some(item => item.code === 'artifact_claims_pass_with_failures'));

  const honestFailure = await buildArtifact(artifact => {
    artifact.passed = false;
    artifact.failures = ['tests/harness-oracles.test.ts::oracle:counts'];
    artifact.totals = { ...(artifact.totals as object), fail: 1 };
  });
  const honestCheck = await checkSelfProofArtifact(honestFailure, { pluginRoot });
  assert.ok(honestCheck.result.violations.some(item => item.code === 'selfproof_not_passed'));

  const missingOracle = await buildArtifact(artifact => {
    artifact.oracleSelfProofs = (artifact.oracleSelfProofs as { name: string }[]).filter(entry => entry.name !== 'lossless-json');
  });
  const missingCheck = await checkSelfProofArtifact(missingOracle, { pluginRoot });
  assert.ok(missingCheck.result.violations.some(item => item.code === 'oracle_unverified'));

  const missingFile = await buildArtifact(artifact => {
    const files = artifact.files as { path: string }[];
    artifact.files = files.filter(file => !file.path.endsWith('harness-observer.test.ts'));
  });
  const missingFileCheck = await checkSelfProofArtifact(missingFile, { pluginRoot });
  assert.ok(missingFileCheck.result.violations.some(item => item.code === 'expected_test_file_missing'));
});

test('selfproof:artifact-staleness-detection', async () => {
  const artifact = await buildArtifact();
  const fresh = await checkSelfProofArtifact(artifact, { pluginRoot });
  assert.equal(fresh.result.ok, true, JSON.stringify(fresh.result.violations));
  const stale = JSON.parse(JSON.stringify(artifact)) as SelfProofArtifact & { sourceHashes: Record<string, string> };
  const firstPath = Object.keys(stale.sourceHashes)[0];
  stale.sourceHashes[firstPath] = '0'.repeat(64);
  const staleCheck = await checkSelfProofArtifact(stale, { pluginRoot });
  assert.equal(staleCheck.fresh, false);
  assert.ok(staleCheck.result.violations.some(item => item.code === 'stale_selfproof'));
  const missingHash = JSON.parse(JSON.stringify(artifact)) as SelfProofArtifact & { sourceHashes: Record<string, string> };
  delete missingHash.sourceHashes[firstPath];
  const missingCheck = await checkSelfProofArtifact(missingHash, { pluginRoot });
  assert.ok(missingCheck.result.violations.some(item => item.code === 'stale_selfproof'));
});

test('docs:readme-contract', async () => {
  const harnessReadme = await readFile(join(pluginRoot, 'tests/harness/README.md'), 'utf8');
  const scriptsReadme = await readFile(join(pluginRoot, 'scripts/harness/README.md'), 'utf8');
  for (const required of [
    'node scripts/harness/manifest.mjs',
    'node scripts/harness/selfproof.mjs',
    'node scripts/harness/traceability.mjs',
    'npm run check',
    'self_proven',
    'not_covered',
    '未覆盖',
    '## 证据如何复核',
  ]) {
    assert.ok(harnessReadme.includes(required), `tests/harness/README.md must document ${required}`);
  }
  for (const heading of ['## 如何运行', '## 如何接入后续切片', '## 证据如何复核', '## 已知限制与边界']) {
    assert.ok(harnessReadme.includes(heading), `tests/harness/README.md must contain ${heading}`);
  }
  for (const required of ['manifest.mjs', 'selfproof.mjs', 'traceability.mjs', 'tests/harness/README.md']) {
    assert.ok(scriptsReadme.includes(required), `scripts/harness/README.md must reference ${required}`);
  }
});
