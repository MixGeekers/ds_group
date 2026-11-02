/**
 * C00 self-verification of the independent judge and the native-world fixture.
 *
 * DSH交接 02 §3.2/§1 requires the oracle itself to be verified on known-good
 * and known-bad hand samples BEFORE its green results may be used as evidence.
 * These cases construct the expected/observed values by hand (no product call);
 * they must accept every correct sample and reject every wrong one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedColdSnapshot, foldNativeInbox, inboxReferences, judgeColdError, judgeColdSuccess,
  normalizeColdResult, type NormalizedColdResult,
} from './support/independent.js';
import { buildHistory, expectedFor, userMessage, NativeWorld } from './support/world.js';
import { evaluateLegal } from './support/harness.js';
import { verifyCase } from './support/evidence.js';

function normalized(overrides: Record<string, unknown> = {}): NormalizedColdResult {
  return normalizeColdResult({ references: [], ...overrides });
}

function seedHistory() {
  return buildHistory({ length: 40, inbox: [{ text: 'pending alpha', lane: 'next-turn', at: 35 }, { text: 'pending beta', lane: 'next-step', at: 38 }] });
}

test('C00a oracle accepts hand-constructed correct cold snapshots', () => {
  const c = verifyCase({ id: 'C00a', title: 'oracle accepts correct hand samples', spec: ['02 §3.2', '03 §5'], expectation: 'independent judge reports no violation for correct snapshot and refs' });
  const built = seedHistory();
  const expected = expectedColdSnapshot({ sessionId: 'shiyu-verify-session', header: { id: 'shiyu-verify-session', agentPreset: 'shiyu-runtime-replyer-v1', isSeeded: false }, inheritedEventCount: 0, events: built.events });
  // Hand-built correct result, derived from the independent expectation (not from the product).
  const correct = normalized({
    references: expected.references.map(reference => ({ messageId: reference.messageId, lane: reference.lane, index: reference.index, messageHash: `hash-of-${reference.messageId}` })),
    asOfSeq: expected.asOfSeq, eventCount: expected.eventCount, sessionId: expected.sessionId, preset: expected.preset,
    inheritedEventCount: expected.inheritedEventCount, headerHash: 'h'.repeat(64), historyBytes: 4096,
    historyDigest: 'd'.repeat(64), readPages: 3, tailEventHash: 't'.repeat(64),
  });
  const judgement = judgeColdSuccess(correct, expected);
  assert.deepEqual(judgement.violations, [], `correct sample must not be rejected: ${JSON.stringify(judgement.violations)}`);
  assert.deepEqual(judgement.unobservable, []);
  // A second correct sample: empty history.
  const emptyExpected = expectedColdSnapshot({ sessionId: 'empty', header: { id: 'empty', agentPreset: 'p', isSeeded: false }, inheritedEventCount: 0, events: [] });
  const emptyCorrect = normalized({ references: [], asOfSeq: -1, eventCount: 0, sessionId: 'empty', preset: 'p', inheritedEventCount: 0, headerHash: 'h', historyBytes: 0, historyDigest: 'd'.repeat(64), readPages: 1 });
  assert.deepEqual(judgeColdSuccess(emptyCorrect, emptyExpected).violations, []);
  c.pass('accepted both correct hand samples (40-event mixed history and empty history)');
});

test('C00b oracle rejects wrong asOfSeq/eventCount/inherited and mixed references', () => {
  const c = verifyCase({ id: 'C00b', title: 'oracle rejects wrong watermarks and references', spec: ['02 §3.2', '03 §3', '03 §5'], expectation: 'each of 4 hand-built wrong samples is rejected with the matching field violation' });
  const built = seedHistory();
  const expected = expectedColdSnapshot({ sessionId: 'shiyu-verify-session', header: { id: 'shiyu-verify-session', agentPreset: 'shiyu-runtime-replyer-v1', isSeeded: false }, inheritedEventCount: 0, events: built.events });
  const references = expected.references.map(reference => ({ messageId: reference.messageId, lane: reference.lane, index: reference.index, messageHash: `h-${reference.messageId}` }));
  const bad: [string, NormalizedColdResult, string][] = [
    ['asOfSeq off by one', normalized({ references, asOfSeq: expected.asOfSeq - 1, eventCount: expected.eventCount, sessionId: expected.sessionId, preset: expected.preset, inheritedEventCount: 0, headerHash: 'h', historyBytes: 1, historyDigest: 'd'.repeat(64), readPages: 1 }), 'asOfSeq'],
    ['eventCount is last-page length', normalized({ references, asOfSeq: expected.asOfSeq, eventCount: 8, sessionId: expected.sessionId, preset: expected.preset, inheritedEventCount: 0, headerHash: 'h', historyBytes: 1, historyDigest: 'd'.repeat(64), readPages: 1 }), 'eventCount'],
    ['inherited count invented from header', normalized({ references, asOfSeq: expected.asOfSeq, eventCount: expected.eventCount, sessionId: expected.sessionId, preset: expected.preset, inheritedEventCount: 3, headerHash: 'h', historyBytes: 1, historyDigest: 'd'.repeat(64), readPages: 1 }), 'inheritedEventCount'],
    ['mixed-reference history (one pending message missing)', normalized({ references: references.slice(1), asOfSeq: expected.asOfSeq, eventCount: expected.eventCount, sessionId: expected.sessionId, preset: expected.preset, inheritedEventCount: 0, headerHash: 'h', historyBytes: 1, historyDigest: 'd'.repeat(64), readPages: 1 }), 'references'],
    ['-0 watermark', normalized({ references, asOfSeq: -0, eventCount: 0, sessionId: expected.sessionId, preset: expected.preset, inheritedEventCount: 0, headerHash: 'h', historyBytes: 1, historyDigest: 'd'.repeat(64), readPages: 1 }), 'asOfSeq'],
  ];
  for (const [name, sample, field] of bad) {
    const judgement = judgeColdSuccess(sample, expected);
    assert.ok(judgement.violations.some(violation => violation.field === field), `${name} must be rejected on ${field}; got ${JSON.stringify(judgement.violations)}`);
  }
  c.pass(`rejected all ${bad.length} hand-built wrong snapshots with the expected fields`, { samples: bad.map(([name]) => name) });
});

test('C00c oracle rejects malformed inbox histories and bad inherited metadata', () => {
  const c = verifyCase({ id: 'C00c', title: 'oracle rejects malformed inbox/history inputs', spec: ['02 §3.2', '03 §3'], expectation: 'independent fold refuses duplicate/out-of-range/gap inputs instead of projecting them' });
  const messageA = userMessage('dup alpha', 'dup-a');
  const messageB = userMessage('other', 'dup-b');
  const splice = (seq: number, data: unknown) => ({ type: 'agent/inbox/spliced', seq, time: 0, data });
  const samples: [string, any[], RegExp][] = [
    ['duplicate pending message id across lanes', [splice(0, { target: 'next-turn', start: 0, removedCount: 0, inserted: [messageA] }), splice(1, { target: 'next-step', start: 0, removedCount: 0, inserted: [messageA] })], /duplicate pending/],
    ['splice range beyond lane length', [splice(0, { target: 'next-turn', start: 3, removedCount: 0, inserted: [messageA] })], /invalid inbox splice range/],
    ['non-contiguous log (missing seq)', [splice(0, { target: 'next-turn', start: 0, removedCount: 0, inserted: [messageA] }), splice(2, { target: 'next-turn', start: 1, removedCount: 0, inserted: [messageB] })], /non-contiguous/],
    ['unidentified pending message', [splice(0, { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ role: 'user' }] })], /no identity/],
  ];
  for (const [name, events, pattern] of samples) assert.throws(() => foldNativeInbox(events as any), pattern, `${name} must be rejected`);
  // Seeded metadata rules come from the frozen Session/SessionLogOffset contract.
  const header = { id: 'seed-session', agentPreset: 'p', isSeeded: true };
  assert.throws(() => expectedColdSnapshot({ sessionId: 'seed-session', header: { ...header, isSeeded: false }, inheritedEventCount: 2, events: buildHistory({ length: 10 }).events }), /unseeded header must have inherited count 0/);
  assert.throws(() => expectedColdSnapshot({ sessionId: 'seed-session', header, inheritedEventCount: -0, events: buildHistory({ length: 10 }).events }), /branded offset/);
  assert.throws(() => expectedColdSnapshot({ sessionId: 'seed-session', header, inheritedEventCount: 11, events: buildHistory({ length: 10 }).events }), /exceeds the event log/);
  c.pass(`rejected ${samples.length + 3} malformed hand samples`, { samples: samples.map(([name]) => name) });
});

test('C00d oracle rejects a safe-looking error that leaks bodies or retains the handle', () => {
  const c = verifyCase({ id: 'C00d', title: 'oracle verifies rejection safety', spec: ['02 §3.2', '03 §5'], expectation: 'clean rejection passes; body-leaking, unclosed-handle, empty-message and missing-error samples fail' });
  const clean = judgeColdError(new Error('Native history was not readable'), ['TOP-SECRET-CANARY'], { opens: 1, closes: 1, openHandles: 0 });
  assert.deepEqual(clean.violations, []);
  const leak = judgeColdError(new Error('failed for TOP-SECRET-CANARY body'), ['TOP-SECRET-CANARY'], { opens: 1, closes: 1, openHandles: 0 });
  assert.ok(leak.violations.some(v => v.field === 'error.leak'));
  const leaked = judgeColdError(new Error('synthetic read failure'), ['synthetic read failure'], { opens: 1, closes: 1, openHandles: 0 });
  assert.ok(leaked.violations.some(v => v.field === 'error.leak'), 'fixture self-check: a canary that appears in the message must be detected');
  const unclosed = judgeColdError(new Error('Native history was not readable'), [], { opens: 1, closes: 0, openHandles: 1 });
  assert.ok(unclosed.violations.some(v => v.field === 'handle'));
  const empty = judgeColdError(Object.assign(new Error(''), { name: 'NativeHistoryError' }), [], { opens: 1, closes: 1, openHandles: 0 });
  assert.ok(empty.violations.some(v => v.field === 'error.message'));
  const missing = judgeColdError(undefined, [], { opens: 0, closes: 0, openHandles: 0 });
  assert.ok(missing.violations.some(v => v.field === 'error'), 'a resolution must never be treated as an acceptable rejection');
  c.pass('accepted the clean rejection and rejected all 5 unsafe rejection samples', { samples: ['clean', 'leak', 'unclosed', 'empty-message', 'missing-error'] });
});

test('C00f harness mutation-test: a correct hand reader passes; three buggy readers are rejected', async () => {
  const c = verifyCase({ id: 'C00f', title: 'harness rejects buggy implementations', spec: ['02 §3.2', '02 §3.1', '03 §5'], expectation: 'independent world+judge accepts a hand-written correct two-pass reader and rejects single-pass, stale-cut and short-page-as-EOF readers' });
  type Mode = 'correct' | 'single-pass' | 'stale-cut' | 'short-page-as-eof';

  async function naiveRead(world: NativeWorld, mode: Mode): Promise<any> {
    const handle = await world.open(world.sessionId, 'read');
    const page = 100;
    const readAll = async () => {
      const out: any[] = [];
      for (;;) {
        const result = await handle.read(out.length, page);
        if (!result.events.length) break;
        out.push(...result.events);
      }
      return out;
    };
    try {
      let events = await readAll();
      if (mode === 'single-pass') { /* deliberately no verification pass */ }
      else if (mode === 'short-page-as-eof') {
        const first = await handle.read(0, page);
        events = first.events.slice(0, Math.max(1, first.events.length - 1));
      } else if (mode === 'stale-cut') {
        world.appendUserMessage('mutation after the observed cut', 'mutation-after-cut');
      } else {
        const verify = await readAll();
        if (JSON.stringify(verify) !== JSON.stringify(events)) throw new Error('verification pass disagreed');
      }
      const expected = expectedFor(world);
      const references = expected.references.map(reference => ({ messageId: reference.messageId, lane: reference.lane, index: reference.index, messageHash: reference.fingerprint }));
      const cutCount = mode === 'stale-cut' || mode === 'short-page-as-eof' ? events.length : expected.eventCount;
      const cutAsOf = cutCount - 1;
      return {
        references: cutCount === expected.eventCount ? references : (mode === 'short-page-as-eof' ? [] : (references.length ? [] : references)),
        asOfSeq: cutAsOf, eventCount: cutCount, sessionId: expected.sessionId, preset: expected.preset,
        inheritedEventCount: expected.inheritedEventCount, headerHash: 'h'.repeat(64), historyBytes: 1024,
        historyDigest: 'd'.repeat(64), readPages: world.reads.length, ...(cutCount ? { tailEventHash: 't'.repeat(64) } : {}),
      };
    } finally { await handle.close(); }
  }

  const correctWorld = new NativeWorld({ sessionId: 'mutation-correct', events: buildHistory({ length: 500, inbox: [{ text: 'mutation pending', at: 490 }] }).events });
  const correct = await naiveRead(correctWorld, 'correct');
  const accepted = evaluateLegal(correctWorld, { result: correct, elapsedMs: 0 }, { skipReadDiscipline: false });
  assert.deepEqual(accepted.violations, [], `hand-written correct reader must be accepted: ${JSON.stringify(accepted.violations)}`);

  const mutants: [string, Mode, string][] = [
    ['single-pass', 'single-pass', 'read discipline'],
    ['stale-cut', 'stale-cut', 'final coherent cut'],
    ['short-page-as-eof', 'short-page-as-eof', 'incomplete history'],
  ];
  const rejected: string[] = [];
  for (const [name, mode, _reason] of mutants) {
    const world = new NativeWorld({ sessionId: `mutation-${mode}`, events: buildHistory({ length: 500, inbox: [{ text: 'mutation pending', at: 490 }] }).events });
    const outcome = await naiveRead(world, mode);
    const evaluation = evaluateLegal(world, { result: outcome, elapsedMs: 0 });
    if (!evaluation.violations.length) { c.fail(`harness accepted the ${name} mutant`); assert.fail(`harness accepted the ${name} mutant`); }
    rejected.push(`${name}:${evaluation.violations[0]!.slice(0, 80)}`);
  }
  c.pass(`accepted the correct hand reader and rejected all 3 mutants (${rejected.join(' | ')})`, { rejected });
});

test('C00e native-world fixture matches the frozen reader contract', async () => {
  const c = verifyCase({ id: 'C00e', title: 'fixture models read/offset/shrink/restore semantics', spec: ['03 §3'], expectation: 'offset slices, explicit EOF, monotonic shrink rejection, empty asOfSeq=-1 and detached state' });
  const built = buildHistory({ length: 12 });
  const world = new NativeWorld({ sessionId: 'fixture', events: built.events });
  const handle = await world.open('fixture', 'read');
  const first = await handle.read(0, 5);
  assert.equal(first.events.length, 5);
  assert.equal(first.events[0]!.seq, 0);
  assert.equal(first.eventState, 'shared-frozen');
  const second = await handle.read(5, 100);
  assert.equal(second.events.length, 7);
  const eof = await handle.read(12, 1);
  assert.deepEqual(eof.events, []);
  world.truncate(11);
  await assert.rejects(handle.read(0, 5), /shrank below a previously observed prefix/);
  await handle.close();
  await handle.close();
  assert.equal(world.closes, 1);
  const empty = new NativeWorld({ sessionId: 'empty', events: [] });
  const restored = await empty.restore({}, [], 0, { id: 'empty', agentPreset: 'p' }, 0);
  assert.equal(restored.snapshot.asOfSeq, -1);
  const detached = new NativeWorld({ sessionId: 'pending', detached: true });
  const detachedHandle = await detached.open('pending', 'read');
  const detachedRead = await detachedHandle.read(0, 10);
  assert.deepEqual(detachedRead, { eventState: 'detached', events: [] });
  await detachedHandle.close();
  // provider projection: end-seed events are inert for the inbox fold.
  const seeded = buildHistory({ length: 20, seeded: true, inheritedPrefix: 7, inbox: [{ text: 'inherited pending', at: 3 }] });
  const projected = await new NativeWorld({ sessionId: 'seeded', events: seeded.events, inheritedEventCount: 7, header: { isSeeded: true } })
    .restore({}, seeded.events, 0, { id: 'seeded', agentPreset: 'p', isSeeded: true }, 7);
  assert.equal(projected.snapshot.asOfSeq, 19);
  assert.equal(projected.snapshot.values.inbox['next-turn'].length, 1);
  const expectedInbox = inboxReferences(foldNativeInbox(seeded.events));
  assert.equal(expectedInbox.length, 1);
  c.pass('fixture semantics verified (slices, EOF, shrink rejection, empty asOfSeq -1, detached state, inert end-seed)');
});
