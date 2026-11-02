/**
 * H1 legal long-history cases: empty, 2048 boundary (±1), far beyond one page,
 * conforming short pages, inherited seeds and exact native projection.
 *
 * Spec: DSH交接 03 §5 row 1 (空史、2048边界前后、远超一页的合法史、继承seed →
 * 恢复到正确官方投影；同业务Session身份保留；不能只证明超限拒绝).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistory, NativeWorld, userMessage } from './support/world.js';
import { cold, judgeLegal } from './support/harness.js';
import { loadColdSeam, resolveLimits } from './support/seam.js';
import { verifyCase } from './support/evidence.js';

const seam = await loadColdSeam();
const limits = resolveLimits(seam.limits);

function world(sessionId: string, history: ReturnType<typeof buildHistory>, extra: ConstructorParameters<typeof NativeWorld>[0] extends infer T ? Partial<T> : never = {}) {
  return new NativeWorld({ sessionId, events: history.events, ...extra } as any);
}

test('L01 empty native history restores the empty official projection', async () => {
  const c = verifyCase({ id: 'L01', title: 'empty history', spec: ['03 §5 row1', '03 §3', '6.6'], expectation: 'asOfSeq=-1, eventCount=0, inherited=0, empty inbox, handle released' });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-empty' });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
  assert.equal(w.restoreCalls.length, 1, 'exactly one official projector invocation over the observed cut');
});

test('L02 unmaterialized detached pending log is a legal empty cut', async () => {
  const c = verifyCase({ id: 'L02', title: 'detached pending empty cut', spec: ['03 §3', 'session-persistence README'], expectation: 'both frozen/detached event states are adoptable; empty cut restores with asOfSeq=-1' });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-detached', detached: true });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L03 2047 events (old 2048 cap - 1) with short backend pages', async () => {
  const c = verifyCase({ id: 'L03', title: '2048-1 legal history', spec: ['03 §5 row1', '6.6'], expectation: '2047 events restored exactly; conforming pages of 512 are not mistaken for EOF' });
  const history = buildHistory({ length: 2047, inbox: [{ text: 'pending at 2040', at: 2040 }] });
  const w = world('shiyu-verify-2047', history, { pageCap: 512 });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L04 exactly 2048 events (old cap boundary)', async () => {
  const c = verifyCase({ id: 'L04', title: '2048 legal history', spec: ['03 §5 row1', '6.6'], expectation: 'exactly 2048 events restored with exact projection and asOfSeq=2047' });
  const history = buildHistory({ length: 2048, inbox: [{ text: 'pending at 2044', at: 2044, lane: 'next-step' }] });
  const w = world('shiyu-verify-2048', history, { pageCap: 512 });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L05 2049 events (old cap + 1) must succeed, proving the old rejection is gone', async () => {
  const c = verifyCase({ id: 'L05', title: '2048+1 legal history', spec: ['03 §5 row1', '6.6'], expectation: 'the old hard 2048 limit must not reject a legal 2049-event history' });
  const history = buildHistory({ length: 2049, inbox: [{ text: 'pending at 2045', at: 2045 }] });
  const w = world('shiyu-verify-2049', history, { pageCap: 512 });
  const outcome = await cold(seam, w);
  if (outcome.error !== undefined) {
    c.fail(`2049-event legal history was rejected: ${String((outcome.error as Error)?.message ?? outcome.error)}`, { events: 2049 });
    assert.fail('2049-event legal history was rejected');
  }
  judgeLegal(c, seam, w, outcome);
});

test('L06 far beyond one page with conforming short pages (5000 events, pageCap=100)', async () => {
  const c = verifyCase({ id: 'L06', title: 'short pages non-EOF', spec: ['03 §5 row1/row2', '03 §3'], expectation: 'a conforming backend returning fewer events than requested maximum does not terminate the scan early' });
  const history = buildHistory({ length: 5000, inbox: [{ text: 'short-page pending 1', at: 4990 }, { text: 'short-page pending 2', at: 4995, lane: 'next-step' }] });
  const w = world('shiyu-verify-5000', history, { pageCap: 100 });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L07 generated 10000-event history with tiny pages (far beyond one page)', async () => {
  const c = verifyCase({ id: 'L07', title: '10k events tiny pages', spec: ['03 §5 row1', '6.6'], expectation: 'long legal history restores exactly, no silent truncation, bounded pages honoured' });
  const history = buildHistory({ length: 10000, inbox: [{ text: 'long-history pending', at: 9994 }] });
  const w = world('shiyu-verify-10000', history, { pageCap: 100 });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L08 seeded history: inherited prefix included in the projection', async () => {
  const c = verifyCase({ id: 'L08', title: 'inherited seed prefix', spec: ['03 §5 row1', '03 §3 header/inherited'], expectation: 'inheritedEventCount=300 reported exactly; inherited-prefix inbox splices are projected; official asOfSeq covers the whole log' });
  const history = buildHistory({ length: 900, seeded: true, inheritedPrefix: 300, pageCap: 128 } as any);
  // Place one pending inbox splice inside the inherited prefix and one in own history.
  const withInbox = buildHistory({ length: 900, seeded: true, inheritedPrefix: 300, inbox: [{ text: 'inherited pending', at: 120, lane: 'next-turn' }, { text: 'own pending', at: 880, lane: 'next-step' }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-seeded', events: withInbox.events, inheritedEventCount: 300, pageCap: 128, header: { isSeeded: true } });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
  assert.ok(history.events.length > 0);
});

test('L09 seeded history with inheritedEventCount=0 and cut marker at seq 0', async () => {
  const c = verifyCase({ id: 'L09', title: 'seeded cut at zero', spec: ['03 §3', '03 §5 row1'], expectation: 'a seeded header whose inherited cut is the empty prefix passes; marker at seq 0 is part of the log' });
  const history = buildHistory({ length: 61, seeded: true, inheritedPrefix: 0, inbox: [{ text: 'seeded-zero pending', at: 55 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-seeded-zero', events: history.events, inheritedEventCount: 0, pageCap: 16, header: { isSeeded: true } });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L10 interleaved lanes, insertions and cancellations project exactly', async () => {
  const c = verifyCase({ id: 'L10', title: 'inbox lane ordering and removal', spec: ['03 §5 row1', 'agent-loop inbox projection'], expectation: 'next-turn refs precede next-step refs; insert+remove history folds to the final durable inbox' });
  const history = buildHistory({ length: 300 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-inbox-order', events: history.events, pageCap: 37 });
  const first = userMessage('lane a1', 'lane-a1');
  const second = userMessage('lane b1', 'lane-b1');
  const third = userMessage('lane a2', 'lane-a2');
  w.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [first] });
  w.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [second] });
  w.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [third] });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L11 custom managed Session identity and preset are preserved', async () => {
  const c = verifyCase({ id: 'L11', title: 'same business Session identity', spec: ['03 §5 row1'], expectation: 'a long-lived managed Session keeps its exact native id and managed preset across cold recovery' });
  const history = buildHistory({ length: 1500, inbox: [{ text: 'identity pending', at: 1490 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-replyer-verify-identity-1234', preset: 'shiyu-runtime-replyer-v1', events: history.events, pageCap: 256 });
  const outcome = await cold(seam, w, { sessionId: 'shiyu-replyer-verify-identity-1234', preset: 'shiyu-runtime-replyer-v1' } as any);
  judgeLegal(c, seam, w, outcome);
});

test('L12 natural short final page (700 events)', async () => {
  const c = verifyCase({ id: 'L12', title: 'natural short final page', spec: ['03 §5 row2'], expectation: 'a final page shorter than the requested maximum (because the log ends) is read to explicit EOF and succeeds' });
  const history = buildHistory({ length: 700, inbox: [{ text: 'tail pending', at: 694 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-700', events: history.events });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('L13 declared recovery limit is not lower than the legal 2049 case', () => {
  const c = verifyCase({ id: 'L13', title: 'declared capacity covers old boundary', spec: ['03 §2', '03 §4.1'], expectation: 'explicit advertised maxEvents >= 2049 so the old hard limit is genuinely replaced' });
  if (limits.maxEvents === undefined) {
    c.blocked(`cold seam ${seam.functionName} exposes no resolvable explicit history limit (raw=${JSON.stringify(seam.rawLimits)})`, { exports: seam.exportNames });
    return;
  }
  if (limits.maxEvents < 2049) {
    c.fail(`declared maxEvents=${limits.maxEvents} is below the legal 2049 boundary`, { maxEvents: limits.maxEvents });
    assert.fail('declared maxEvents below the legal 2049 boundary');
  }
  c.pass(`declared maxEvents=${limits.maxEvents} (pageEvents=${String(limits.pageEvents)}, maxBytes=${String(limits.maxBytes)}, maxReads=${String(limits.maxReads)}, timeoutMs=${String(limits.timeoutMs)})`,
    { limits });
});
