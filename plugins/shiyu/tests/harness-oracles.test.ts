/**
 * H0 oracle self-proof suite.
 *
 * Each oracle must prove BOTH directions: known-correct inputs are accepted
 * and known-incorrect inputs are rejected with the declared violation codes.
 * The aggregate test reports per-oracle sample/scenario pass counts; a
 * deliberate "always accepts" oracle is injected to prove the framework
 * itself fails such a detector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OracleSelfProof } from './harness/invariant.js';
import { ALL_SELF_PROOFS, HARNESS_VERSION, ORACLE_API_VERSION, checkLosslessJson, oracleTestName, pass, runSelfProof, selfProofFailureMessage } from './harness/index.js';

const pluginRoot = resolvePluginRoot();
const ORACLE_COUNT = 15;

function resolvePluginRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

test('oracle-manifest:contract', () => {
  assert.match(HARNESS_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(ORACLE_API_VERSION, 1);
  assert.equal(ALL_SELF_PROOFS.length, ORACLE_COUNT, 'oracle catalogue size is part of the contract');
  const names = ALL_SELF_PROOFS.map(proof => proof.name);
  assert.equal(new Set(names).size, names.length, 'oracle names must be unique');
  for (const proof of ALL_SELF_PROOFS) {
    assert.match(proof.name, /^[a-z0-9][a-z0-9-]*$/, `oracle name ${proof.name}`);
    assert.match(proof.version, /^\d+\.\d+\.\d+$/, `oracle version ${proof.version}`);
    assert.ok(proof.boundary.length >= 20, `oracle ${proof.name} must document its boundary`);
    assert.ok(existsSync(join(pluginRoot, proof.module)), `oracle ${proof.name} module ${proof.module} must exist`);
    const samples = proof.samples ?? [];
    const scenarios = proof.scenarios ?? [];
    assert.ok(samples.length + scenarios.length > 0, `oracle ${proof.name} has no self-proof`);
    const expects = [...samples, ...scenarios].map(item => item.expect);
    assert.ok(expects.includes('accept'), `oracle ${proof.name} needs a known-accept proof`);
    assert.ok(expects.includes('reject'), `oracle ${proof.name} needs a known-reject proof`);
    if (samples.length > 0) assert.equal(typeof proof.evaluate, 'function', `oracle ${proof.name} samples require evaluate()`);
    assert.equal(oracleTestName(proof.name), `oracle:${proof.name}`);
  }
});

for (const proof of ALL_SELF_PROOFS) {
  test(oracleTestName(proof.name), async t => {
    const run = await runSelfProof(proof);
    const accepted = run.outcomes.filter(outcome => outcome.expect === 'accept' && outcome.ok).length;
    const rejected = run.outcomes.filter(outcome => outcome.expect === 'reject' && outcome.ok).length;
    t.diagnostic(
      `oracle=${run.oracle} version=${run.version} samples=${run.sampleCount} scenarios=${run.scenarioCount} ` +
        `known-accept-pass=${accepted} known-reject-caught=${rejected} failures=${run.failures.length}`,
    );
    assert.deepEqual(run.failures, [], selfProofFailureMessage(run));
    assert.ok(run.outcomes.length > 0);
    assert.ok(accepted > 0, 'oracle must accept at least one known-correct sample');
    assert.ok(rejected > 0, 'oracle must reject at least one known-incorrect sample');
    for (const outcome of run.outcomes) {
      if (outcome.expect === 'reject' && outcome.ok) {
        assert.ok(outcome.actualCodes.length > 0, `${run.oracle}/${outcome.label} rejection must cite violation codes`);
        for (const expectedCode of outcome.expectCodes) {
          assert.ok(outcome.actualCodes.includes(expectedCode), `${run.oracle}/${outcome.label} must include ${expectedCode}`);
        }
      }
    }
  });
}

test('oracle-selfproof:aggregate', async t => {
  const lines: string[] = ['oracle,version,samples,scenarios,known_accept_pass,known_reject_caught,failures'];
  let totalAccepted = 0;
  let totalRejected = 0;
  let totalSamples = 0;
  let totalScenarios = 0;
  const failures: string[] = [];
  for (const proof of ALL_SELF_PROOFS) {
    const run = await runSelfProof(proof);
    const accepted = run.outcomes.filter(outcome => outcome.expect === 'accept').length;
    const rejected = run.outcomes.filter(outcome => outcome.expect === 'reject').length;
    const acceptedOk = run.outcomes.filter(outcome => outcome.expect === 'accept' && outcome.ok).length;
    const rejectedOk = run.outcomes.filter(outcome => outcome.expect === 'reject' && outcome.ok).length;
    totalAccepted += acceptedOk;
    totalRejected += rejectedOk;
    totalSamples += run.sampleCount;
    totalScenarios += run.scenarioCount;
    lines.push(`${run.oracle},${run.version},${run.sampleCount},${run.scenarioCount},${acceptedOk}/${accepted},${rejectedOk}/${rejected},${run.failures.length}`);
    if (!run.ok) failures.push(...run.failures);
    assert.ok(accepted > 0 && rejected > 0, `${run.oracle} must exercise both verdict directions`);
  }
  t.diagnostic(`\n${lines.join('\n')}`);
  assert.deepEqual(failures, []);
  assert.equal(ALL_SELF_PROOFS.length, ORACLE_COUNT);
  assert.ok(totalAccepted >= ORACLE_COUNT, 'every oracle must accept its known-correct samples');
  assert.ok(totalRejected >= ORACLE_COUNT, 'every oracle must reject its known-incorrect samples');
  assert.ok(totalSamples + totalScenarios >= ORACLE_COUNT * 2);
});

test('selfproof:framework-rejects-accepting-oracle', async () => {
  const acceptsEverything: OracleSelfProof = {
    name: 'broken-demo',
    version: '1.0.0',
    module: 'tests/harness/invariant.ts',
    boundary: 'deliberately broken detector used to prove the self-proof framework rejects an oracle that never rejects errors',
    evaluate: input => {
      const candidate = input as { result?: boolean };
      void candidate;
      return pass({ oracle: 'broken-demo', version: '1.0.0', boundary: 'broken detector', scope: 'test' }, 1);
    },
    samples: [
      { label: 'known-correct', input: { value: 1 }, expect: 'accept', why: 'correct input' },
      { label: 'known-wrong', input: { value: -1 }, expect: 'reject', expectCodes: ['must_reject'], why: 'error must be rejected' },
    ],
  };
  const run = await runSelfProof(acceptsEverything);
  assert.equal(run.ok, false, 'a detector that accepts a known error must fail self-proof');
  assert.ok(run.failures.some(failure => failure.includes('known-wrong') && failure.includes('expected reject')), run.failures.join('\n'));
  const noRejectDeclared: OracleSelfProof = {
    ...acceptsEverything,
    name: 'broken-demo-2',
    samples: [{ label: 'only-correct', input: { value: 1 }, expect: 'accept', why: 'only positive direction declared' }],
  };
  const run2 = await runSelfProof(noRejectDeclared);
  assert.equal(run2.ok, false, 'an oracle without any known-reject sample must fail the self-proof contract');
  assert.ok(run2.failures.some(failure => failure.includes('needs at least one known-reject proof')), run2.failures.join('\n'));
});

test('selfproof:lossless-json-detects-host-snapshot-defect', () => {
  // The real H0 host defect shape: explicit undefined in a snapshot.
  const snapshot = {
    status: 'ok',
    dependencies: [
      { id: 'local-note', status: 'available', checkedAt: undefined },
      { id: 'memory', status: 'unavailable', probe: { at: undefined } },
    ],
  };
  const check = checkLosslessJson(snapshot);
  assert.equal(check.ok, false, 'snapshot with explicit undefined must be rejected as lossy');
  assert.ok(check.violations.some(item => item.code === 'undefined_value'));
  const fixed = { status: 'ok', dependencies: [{ id: 'local-note', status: 'available' }, { id: 'memory', status: 'unavailable' }] };
  assert.equal(checkLosslessJson(fixed).ok, true, 'conditionally-omitted fields are lossless');
});
