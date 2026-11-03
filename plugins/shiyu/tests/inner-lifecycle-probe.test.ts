import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INNER_LIFECYCLE_PROBE_ACTION, INNER_LIFECYCLE_PROBE_TOOL,
  InnerLifecycleProbeError, RuntimeInnerLifecycleProbeCommand,
  innerLifecycleDiagnosisTool, probeInnerLifecycle, validateInnerLifecycleProbeReceipt,
  type InnerLifecycleProbeReceipt,
} from '../src/control/inner-lifecycle-probe.js';

const errorCode = (expected: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === expected;
const probeError = (error: unknown): InnerLifecycleProbeError => error as InnerLifecycleProbeError;

test('isolated in-memory probe passes its full lifecycle scenario without live data', async t => {
  const receipt = await probeInnerLifecycle();
  t.diagnostic(`probe bytes ${Buffer.byteLength(JSON.stringify(receipt))}`);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.toolName, INNER_LIFECYCLE_PROBE_TOOL);
  assert.equal(receipt.zeroModel, true); assert.equal(receipt.zeroEmbedding, true); assert.equal(receipt.zeroTaskOrEffect, true);
  assert.equal(receipt.store, 'in-memory'); assert.equal(receipt.liveDataTouched, false);
  assert.equal(receipt.released, true); assert.equal(receipt.disposed, true);
  assert.equal(receipt.diagnostics.database, 'memory');
  assert.equal(receipt.diagnostics.livePathsAccepted, 0);
  assert.deepEqual(receipt.diagnostics.zeroActivity, { modelCalls: 0, embeddingCalls: 0, tasks: 0, effects: 0, sends: 0 });
  assert.equal(receipt.diagnostics.derivedRevisionAfter, receipt.diagnostics.derivedRevisionBefore + 1);
  assert.notEqual(receipt.diagnostics.degradation.withdrawal, 'current');
  assert.equal(receipt.diagnostics.staleCaptureRejected, true);
  assert.equal(receipt.diagnostics.staleBodyRejected, true);
  assert.equal(receipt.diagnostics.recomputeIdempotent, true);
  assert.equal(receipt.diagnostics.sourceRevivalRefused, true);
  assert.equal(receipt.diagnostics.cleanup.storeClosed, true); assert.equal(receipt.diagnostics.cleanup.workerTerminated, true);
  assert.equal(receipt.steps.length >= 10, true); assert.equal(receipt.steps.every(step => step.status === 'passed'), true);
  const names = receipt.checks.map(check => check.check);
  for (const name of ['dependent-not-current', 'stale-capture-rejected', 'stale-bodies-rejected', 'exactly-one-revision-bump',
    'recompute-idempotent', 'withdrawn-source-cannot-revive', 'profile-version-needs-review', 'stale-personality-capture-rejected']) {
    assert.ok(names.includes(name), `missing check ${name}`);
  }
  assert.equal(receipt.checks.every(check => check.status === 'passed'), true);
});

test('the probe receipt is bounded, lossless and validated before being trusted', async () => {
  const receipt = await probeInnerLifecycle();
  const serialized = JSON.stringify(receipt), parsed = JSON.parse(serialized) as InnerLifecycleProbeReceipt;
  assert.deepEqual(parsed, receipt);
  assert.equal(Buffer.byteLength(serialized, 'utf8') <= 24 * 1024, true);
  assert.deepEqual(validateInnerLifecycleProbeReceipt(receipt), []);
  const tampered = structuredClone(receipt) as unknown as Record<string, unknown>;
  tampered.liveDataTouched = true;
  assert.equal(validateInnerLifecycleProbeReceipt(tampered).length >= 1, true);
  const failedClaim = structuredClone(receipt); (failedClaim.steps[0] as { status: string }).status = 'failed';
  assert.equal(validateInnerLifecycleProbeReceipt(failedClaim).some(violation => violation.startsWith('steps')), true);
  assert.equal(validateInnerLifecycleProbeReceipt(structuredClone(receipt), 100).some(violation => violation.includes('exceeds')), true);
});

test('repeated probe runs are independent and each bump exactly one derivation revision', async () => {
  const first = await probeInnerLifecycle(), second = await probeInnerLifecycle();
  assert.equal(first.status, 'passed'); assert.equal(second.status, 'passed');
  assert.notEqual(first.diagnostics.conversationId, second.diagnostics.conversationId);
  for (const receipt of [first, second]) assert.equal(receipt.diagnostics.derivedRevisionAfter, receipt.diagnostics.derivedRevisionBefore + 1);
  assert.equal(first.diagnostics.cleanup.storeClosed, true); assert.equal(second.diagnostics.cleanup.storeClosed, true);
});

test('an aborted probe stops, closes the isolated store and reports no live-data touch', async () => {
  const controller = new AbortController();
  let thrown: unknown;
  try {
    await probeInnerLifecycle({ signal: controller.signal, afterStep: step => {
      if (step === 'capture-metadata-before-change') controller.abort();
    } });
  } catch (error) { thrown = error; }
  const failure = probeError(thrown);
  assert.equal(failure.code, 'INNER_LIFECYCLE_PROBE_ABORTED');
  assert.equal(failure.receipt?.status, 'failed');
  assert.equal(failure.receipt?.disposed, true);
  assert.equal(failure.receipt?.liveDataTouched, false);
  assert.equal(failure.receipt?.diagnostics.cleanup.storeClosed, true);
  assert.equal(failure.receipt!.steps.some(step => step.status === 'failed'), true);
});

test('a synthetic step failure is reported as a bounded failed receipt with cleanup', async () => {
  let thrown: unknown;
  try {
    await probeInnerLifecycle({ afterStep: step => { if (step === 'seed-dependent-cognition') throw new Error('synthetic dependent seed failure'); } });
  } catch (error) { thrown = error; }
  const failure = probeError(thrown);
  assert.equal(failure.code, 'INNER_LIFECYCLE_PROBE_FAILED');
  assert.equal(failure.receipt?.status, 'failed');
  assert.equal(failure.receipt?.disposed, true);
  assert.equal(failure.receipt?.diagnostics.cleanup.storeClosed, true);
  assert.equal(failure.receipt!.steps.some(step => step.step === 'seed-dependent-cognition' && step.status === 'failed'), true);
  assert.match(failure.message, /synthetic dependent seed failure/);
  assert.equal(Buffer.byteLength(JSON.stringify(failure.receipt), 'utf8') <= 24 * 1024, true);
});

test('a probe that exceeds its deadline aborts mid-run and still cleans up', async () => {
  const start = Date.parse('2026-11-02T12:00:00.000Z');
  let clock = start;
  let jumped = false;
  const now = () => new Date(clock);
  let thrown: unknown;
  try {
    await probeInnerLifecycle({ deadlineMs: 5000, now, afterStep: step => {
      if (step === 'open-isolated-in-memory-store' && !jumped) { jumped = true; clock += 60_000; }
    } });
  } catch (error) { thrown = error; }
  const failure = probeError(thrown);
  assert.equal(failure.code, 'INNER_LIFECYCLE_PROBE_DEADLINE');
  assert.equal(failure.receipt?.disposed, true);
  assert.equal(failure.receipt?.diagnostics.cleanup.storeClosed, true);
  assert.equal(failure.receipt?.steps.some(step => step.step === 'open-isolated-in-memory-store' && step.status === 'failed'), true);
});

test('the owner command rejects invalid/paused/closed input and runs at most one probe at a time', async () => {
  const receipt = await probeInnerLifecycle();
  let open = true, paused = false, calls = 0;
  let release!: (value: InnerLifecycleProbeReceipt) => void;
  let failure!: (error: Error) => void;
  const command = new RuntimeInnerLifecycleProbeCommand({ isOpen: () => open, isPaused: () => paused,
    probe: async () => { calls++; return new Promise<InnerLifecycleProbeReceipt>((resolve, reject) => { release = resolve; failure = reject; }); } });
  const first = command.handle({ action: INNER_LIFECYCLE_PROBE_ACTION });
  await assert.rejects(command.handle({ action: INNER_LIFECYCLE_PROBE_ACTION }), errorCode('INNER_LIFECYCLE_PROBE_BUSY'));
  await assert.rejects(command.handle({ action: INNER_LIFECYCLE_PROBE_ACTION, extra: true }), errorCode('INNER_LIFECYCLE_PROBE_INPUT'));
  await assert.rejects(command.handle({ action: 'runtime.other' }), errorCode('INNER_LIFECYCLE_PROBE_INPUT'));
  paused = true;
  const pausedResult = command.handle({ action: INNER_LIFECYCLE_PROBE_ACTION }).then(() => undefined, error => error);
  release(structuredClone(receipt));
  assert.deepEqual(await first, receipt);
  assert.equal((await pausedResult)?.code, 'INNER_LIFECYCLE_PROBE_PAUSED');
  paused = false; open = false;
  await assert.rejects(command.handle({ action: INNER_LIFECYCLE_PROBE_ACTION }), errorCode('INNER_LIFECYCLE_PROBE_CLOSED'));
  open = true;
  assert.equal(calls, 1);
  assert.deepEqual(command.receipt(), receipt);
  void failure;
});

test('the owner command never retries a failed probe and rejects invalid receipts', async () => {
  let calls = 0, mode: 'fail' | 'pass' = 'fail';
  const good = await probeInnerLifecycle();
  const command = new RuntimeInnerLifecycleProbeCommand({ isOpen: () => true, isPaused: () => false,
    probe: async () => { calls++; if (mode === 'fail') throw new Error('synthetic probe failure'); return structuredClone(good); } });
  await assert.rejects(command.handle({ action: INNER_LIFECYCLE_PROBE_ACTION }), /synthetic probe failure/);
  assert.equal(calls, 1);
  assert.equal(command.receipt(), undefined);
  mode = 'pass';
  assert.deepEqual(await command.handle({ action: INNER_LIFECYCLE_PROBE_ACTION }), good);
  assert.equal(calls, 2);
  const invalid = new RuntimeInnerLifecycleProbeCommand({ isOpen: () => true, isPaused: () => false,
    probe: async () => ({ ...structuredClone(good), liveDataTouched: true } as unknown as InnerLifecycleProbeReceipt) });
  await assert.rejects(invalid.handle({ action: INNER_LIFECYCLE_PROBE_ACTION }), errorCode('INNER_LIFECYCLE_PROBE_INVALID'));
});

test('the diagnosis tool is zero-parameter, routes only the owner probe action and accepts no live path', async () => {
  const actions: unknown[] = [];
  let value: unknown;
  const tool = innerLifecycleDiagnosisTool({ command: async input => { actions.push(input); value = await probeInnerLifecycle(); return value; } });
  assert.equal(tool.name, INNER_LIFECYCLE_PROBE_TOOL);
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(await tool.execute(), value);
  assert.deepEqual(actions, [{ action: INNER_LIFECYCLE_PROBE_ACTION }]);
  await assert.rejects(probeInnerLifecycle({ dataDir: '/live/data' } as never), errorCode('INNER_LIFECYCLE_PROBE_INPUT'));
  await assert.rejects(probeInnerLifecycle({ filename: '/live/control.sqlite' } as never), errorCode('INNER_LIFECYCLE_PROBE_INPUT'));
});
