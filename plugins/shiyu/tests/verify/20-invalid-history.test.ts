/**
 * H1 invalid-history / malformed-backend cases.
 *
 * Spec: DSH交接 03 §5 row 2 (短页、缺号、重复/乱序、页超量、坏header/preset/
 * 继承、−0 → 其他失效无接受回执/派发，资源释放) and task-3 (2).
 * Every case must reject, stay diagnosable, avoid leaking message bodies and
 * release the native persistence handle (a deliberately simulated close
 * failure is the only case allowed to retain it).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistory, NativeWorld, userMessage, type NativeWorldOptions } from './support/world.js';
import { cold, coldContext, judgeLegal, judgeRejection } from './support/harness.js';
import { callCold, loadColdSeam } from './support/seam.js';
import { verifyCase } from './support/evidence.js';

const seam = await loadColdSeam();

function rawWorld(sessionId: string, events: any[], extra: Partial<NativeWorldOptions> = {}): NativeWorld {
  return new NativeWorld({ sessionId, events, ...extra });
}

function badHeaderWorld(sessionId: string, header: Record<string, unknown>, extra: Partial<NativeWorldOptions> = {}): NativeWorld {
  const history = buildHistory({ length: 40 });
  return new NativeWorld({ sessionId, events: history.events, header, ...extra });
}

test('I01 missing event sequence is refused', async () => {
  const c = verifyCase({ id: 'I01', title: 'missing seq', spec: ['03 §5 row2'], expectation: 'a gap in the logical sequence must reject; a completed prefix must not be accepted' });
  const events = buildHistory({ length: 10 }).events;
  const gapped = [events[0], events[1], { ...events[3]! }];
  const w = rawWorld('shiyu-verify-gap', gapped);
  judgeRejection(c, w, await cold(seam, w));
});

test('I02 duplicate and out-of-order sequences are refused', async () => {
  for (const [id, events] of [
    ['I02a', [0, 1, 1, 2]],
    ['I02b', [0, 2, 1, 3]],
  ] as const) {
    const c = verifyCase({ id, title: 'duplicate/out-of-order seq', spec: ['03 §5 row2'], expectation: 'non-strictly-increasing seqs must reject' });
    const base = buildHistory({ length: 4 }).events;
    const broken = events.map((seq, index) => ({ ...base[index]!, seq }));
    const w = rawWorld(`shiyu-verify-${id}`, broken);
    judgeRejection(c, w, await cold(seam, w));
  }
});

test('I03 backend returning more events than requested is refused', async () => {
  const c = verifyCase({ id: 'I03', title: 'oversized page', spec: ['03 §5 row2', '03 §3 read(offset,length)'], expectation: 'read length is a maximum; a page exceeding it must be treated as an invalid backend, not silently consumed' });
  const history = buildHistory({ length: 1200 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-oversize', events: history.events, oversizePages: 5 });
  judgeRejection(c, w, await cold(seam, w), { note: 'page oversize is listed as invalid in 03 §5' });
});

test('I04 malformed read result shape is refused', async () => {
  const c = verifyCase({ id: 'I04', title: 'malformed read result', spec: ['03 §5 row2', '03 §4.1'], expectation: 'a backend result without an events array must reject and release the handle' });
  const history = buildHistory({ length: 30 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-malformed', events: history.events, readReplaceAt: new Map([[1, { events: null, eventState: 'shared-frozen' }]]) });
  judgeRejection(c, w, await cold(seam, w));
});

test('I05 header identity mismatch is refused', async () => {
  const c = verifyCase({ id: 'I05', title: 'bad header id', spec: ['03 §5 row2', '03 §3 header.id'], expectation: 'a stored header bound to another Session id must never be accepted as this managed Session' });
  const w = badHeaderWorld('shiyu-verify-header-id', { id: 'some-other-session' });
  judgeRejection(c, w, await cold(seam, w));
});

test('I06 preset mismatch is refused', async () => {
  const c = verifyCase({ id: 'I06', title: 'bad preset', spec: ['03 §5 row2', '03 §3 header/preset'], expectation: 'a Session whose agentPreset differs from the managed binding must reject' });
  const w = badHeaderWorld('shiyu-verify-preset', { agentPreset: 'some-other-preset' });
  judgeRejection(c, w, await cold(seam, w, { preset: 'shiyu-runtime-replyer-v1' }), { note: 'requested preset shiyu-runtime-replyer-v1 vs stored some-other-preset' });
});

test('I07 unsupported header version is refused', async () => {
  const c = verifyCase({ id: 'I07', title: 'bad header version', spec: ['03 §5 row2', '03 §3', 'SDK validateSessionHeader'], expectation: 'a non-current stored header version must not be projected as current history' });
  const w = badHeaderWorld('shiyu-verify-version', { version: 3 });
  judgeRejection(c, w, await cold(seam, w));
});

test('I08 non-boolean header isSeeded is refused', async () => {
  const c = verifyCase({ id: 'I08', title: 'bad isSeeded type', spec: ['03 §5 row2', '03 §3', 'SDK header validation'], expectation: 'isSeeded must be a boolean; a string must reject before projection' });
  const w = badHeaderWorld('shiyu-verify-seeded-type', { isSeeded: 'yes' });
  judgeRejection(c, w, await cold(seam, w));
});

test('I09 branded -0 inherited count is refused', async () => {
  const c = verifyCase({ id: 'I09', title: 'inherited -0', spec: ['03 §4.4', '03 §5 row2', 'SDK SessionLogOffset'], expectation: 'the frozen SDK brand rejects -0; a recovered inherited count of -0 must never be accepted' });
  const history = buildHistory({ length: 20 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-minus-zero', events: history.events, inheritedEventCount: -0, header: { isSeeded: true } });
  judgeRejection(c, w, await cold(seam, w));
});

test('I10-I13 malformed inherited ranges are refused', async () => {
  const samples: [string, Partial<NativeWorldOptions>][] = [
    ['I10 fractional inherited', { inheritedEventCount: 1.5 }],
    ['I11 negative inherited', { inheritedEventCount: -1 }],
    ['I12 inherited beyond log', { inheritedEventCount: 11 }],
    ['I13 unseeded nonzero inherited', { inheritedEventCount: 3 }],
  ];
  const history = buildHistory({ length: 10 });
  for (const [name, extra] of samples) {
    const c = verifyCase({ id: name.split(' ')[0]!, title: name, spec: ['03 §5 row2', '03 §4.4'], expectation: 'inheritedEventCount must be a branded safe integer within the log and exactly 0 for an unseeded Session' });
    const w = new NativeWorld({ sessionId: `shiyu-verify-${name.split(' ')[0]}`, events: history.events, ...extra } as NativeWorldOptions);
    judgeRejection(c, w, await cold(seam, w));
  }
});

test('I14 seeded header without a valid inherited cut marker is refused', async () => {
  const c = verifyCase({ id: 'I14', title: 'seeded cut marker', spec: ['03 §5 row2', 'SDK Session constructor'], expectation: 'a seeded header must identify its inherited cut with data.inherited===true session/end-seed (or inherited===eventCount)' });
  const history = buildHistory({ length: 30 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-seed-marker', events: history.events, inheritedEventCount: 5, header: { isSeeded: true } });
  judgeRejection(c, w, await cold(seam, w));
});

test('I15 unidentified pending inbox message is refused', async () => {
  const c = verifyCase({ id: 'I15', title: 'unidentified inbox message', spec: ['03 §5 row2', '03 §4.1'], expectation: 'an inbox entry without a complete native message id must reject rather than project an anonymous pending input' });
  const history = buildHistory({ length: 20 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-anon-inbox', events: history.events });
  w.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ role: 'user', content: [] }] });
  judgeRejection(c, w, await cold(seam, w));
});

test('I16 duplicate pending message identity across lanes is refused', async () => {
  const c = verifyCase({ id: 'I16', title: 'duplicate pending id', spec: ['03 §5 row2', 'agent-loop inbox projection'], expectation: 'the official inbox fold rejects the same pending message id appearing twice; cold recovery must not accept it' });
  const history = buildHistory({ length: 20 });
  const message = userMessage('duplicate pending', 'duplicate-pending-id');
  const w = new NativeWorld({ sessionId: 'shiyu-verify-dup-inbox', events: history.events });
  w.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] });
  w.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 0, inserted: [message] });
  judgeRejection(c, w, await cold(seam, w));
});

test('I17 invalid inbox splice range is refused', async () => {
  const c = verifyCase({ id: 'I17', title: 'invalid inbox splice', spec: ['03 §5 row2', 'agent-loop inbox projection'], expectation: 'a persisted splice outside its lane range must reject instead of being clamped' });
  const history = buildHistory({ length: 20 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-bad-splice', events: history.events });
  w.append('agent/inbox/spliced', { target: 'next-turn', start: 5, removedCount: 0, inserted: [userMessage('bad splice', 'bad-splice-id')] });
  judgeRejection(c, w, await cold(seam, w));
});

test('I18 official projection throwing must reject the load', async () => {
  const c = verifyCase({ id: 'I18', title: 'projection failure', spec: ['03 §5 last row', '03 §4.1'], expectation: 'a projection failure must reject with no acceptance receipt and release the handle' });
  const history = buildHistory({ length: 40 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-projection-fail', events: history.events, restoreThrow: new Error('synthetic projection failure') });
  judgeRejection(c, w, await cold(seam, w));
});

test('I19 projection without the registered inbox value is refused', async () => {
  const c = verifyCase({ id: 'I19', title: 'missing inbox projection', spec: ['03 §5 last row', '03 §4.1'], expectation: 'an absent registered inbox projection must never be interpreted as an empty inbox' });
  const history = buildHistory({ length: 40 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-no-inbox', events: history.events, restoreMissingInbox: true });
  judgeRejection(c, w, await cold(seam, w));
});

test('I20 projection watermark that disagrees with the observed cut is refused', async () => {
  const c = verifyCase({ id: 'I20', title: 'wrong asOfSeq', spec: ['03 §3 snapshot.asOfSeq', '03 §5'], expectation: 'snapshot.asOfSeq must equal the last observed seq (eventCount-1); a projector claiming another cut must reject' });
  const history = buildHistory({ length: 50 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-wrong-asof', events: history.events, restoreWrongAsOfSeq: 7 });
  judgeRejection(c, w, await cold(seam, w));
});

test('I21 native read failure rejects and does not leak event bodies', async () => {
  const c = verifyCase({ id: 'I21', title: 'read failure/no body leak', spec: ['03 §5 last row', '02 §9'], expectation: 'a read error rejects, stays diagnosable, releases the handle and never includes event/message bodies' });
  const history = buildHistory({ length: 40, inbox: [{ text: 'CANARY-inbox-body-9d31', at: 35 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-read-fail', events: history.events, readThrowAt: new Map([[2, new Error('synthetic native read failure')]]) });
  judgeRejection(c, w, await cold(seam, w), { leakCanaries: ['CANARY-inbox-body-9d31'] });
});

test('I22 handle close failure rejects while retaining that handle for diagnosis', async () => {
  const c = verifyCase({ id: 'I22', title: 'close failure', spec: ['03 §5 last row', '03 §4.1'], expectation: 'a close error must reject the operation (no acceptance receipt); the handle may remain for diagnosis, but no success result escapes' });
  const history = buildHistory({ length: 30 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-close-fail', events: history.events, closeThrowAt: 1 });
  judgeRejection(c, w, await cold(seam, w), { allowUnclosed: 1, note: 'synthetic close failure is deliberately not marked closed' });
});

test('I23-I25 missing required native services are refused', async () => {
  for (const missing of ['sessions', 'sessionPersistence', 'sessionProjections'] as const) {
    const id = missing === 'sessions' ? 'I23' : missing === 'sessionPersistence' ? 'I24' : 'I25';
    const c = verifyCase({ id, title: `missing ${missing} service`, spec: ['03 §4.1', '03 §5 last row'], expectation: 'flush, read-only persistence and cold projection are all required; a missing service rejects without opening/accepted receipt' });
    const history = buildHistory({ length: 10 });
    const w = new NativeWorld({ sessionId: `shiyu-verify-missing-${missing}`, events: history.events });
    const context = coldContext(w, { missingServices: [missing] }) as any;
    const outcome = await callCold(seam, w, {}, context);
    judgeRejection(c, w, outcome);
  }
});

test('I26 native Session not found is refused', async () => {
  const c = verifyCase({ id: 'I26', title: 'Session not found', spec: ['03 §5 last row'], expectation: 'opening a non-existent Session rejects; no substitute Session is created' });
  const history = buildHistory({ length: 10 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-not-found', events: history.events });
  const outcome = await callCold(seam, w, { sessionId: 'shiyu-verify-absent-session' });
  judgeRejection(c, w, outcome);
});

test('I27 empty-cut projection watermark must also be exact', async () => {
  const c = verifyCase({ id: 'I27', title: 'wrong empty asOfSeq', spec: ['03 §3', '03 §5 last row'], expectation: 'for an empty log asOfSeq must be -1; a projector claiming 0 must reject' });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-empty-asof', restoreWrongAsOfSeq: 0 });
  judgeRejection(c, w, await cold(seam, w));
});
