/**
 * H1 recovery-continuity cases (03 §4.2/§4.3, 03 §5 rows 4-5, task-3 4).
 *
 * Behaviour targets under test, through the public seam only:
 * - a post-resume cold read may only grow the pre-resume cut and only by the
 *   trusted native resume/setup/title suffix (end-seed marker, interrupted-turn
 *   closers, fixed user-pinned title); any new user/assistant/inbox input must
 *   be refused instead of being dropped as "recovery noise";
 * - the prefix identity is a full digest over the complete earlier cut (not a
 *   count/tail/empty-inbox check);
 * - live Session object/id/header/preset/inherited/seq/inbox must be consistent
 *   with the observed baseline;
 * - a legitimate write we performed (fixed title, exact load-only message) is
 *   re-read at its exact seq and extends the baseline instead of being assumed
 *   not to change seq.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistory, NativeWorld, userMessage } from './support/world.js';
import { cold, judgeLegal, judgeRejection } from './support/harness.js';
import { callCold, coldContext, loadColdSeam, resolveLimits } from './support/seam.js';
import { verifyCase } from './support/evidence.js';
import { expectedFor } from './support/world.js';

const seam = await loadColdSeam();
const limits = resolveLimits(seam.limits);

function snapshotModule(): Record<string, any> {
  const module = seam.module as Record<string, any>;
  for (const name of ['coldNativeInboxSnapshot', 'coldNativeInbox', 'coldNativeHistory']) if (typeof module[name] === 'function') return module;
  return module;
}

async function baselineOf(world: NativeWorld): Promise<any> {
  const outcome = await cold(seam, world);
  if (outcome.error !== undefined) throw new Error(`baseline read failed: ${String((outcome.error as Error)?.message ?? outcome.error)}`);
  if (Array.isArray(outcome.result)) throw new Error('INTERFACE-BLOCKED: the seam only returns inbox references, so expectedPrefix continuity cannot be verified');
  return outcome.result;
}

function trustedSuffixEvents(world: NativeWorld): { type: string; data: unknown; surfaceOp?: string }[] {
  return [
    { type: 'session/end-seed', data: {} },
    { type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'closer-tool-result-1', role: 'tool', toolCallId: 'call-1', isError: true, source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'tool had not started' }] }, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } },
    { type: 'session/title', data: { title: '识雨 · 受限回复', messageSeqs: [], source: { kind: 'user' } } },
  ];
}

function appendSuffix(world: NativeWorld): number {
  let count = 0;
  for (const event of trustedSuffixEvents(world)) { world.append(event.type, event.data, (event as any).surfaceOp); count++; }
  return count;
}

test('S00 cold seam exposes the expectedPrefix continuity capability', async () => {
  const c = verifyCase({ id: 'S00', title: 'expectedPrefix capability', spec: ['03 §4.2', '03 §4.4'], expectation: 'the public seam accepts a previous complete cut and returns appendedCount/appendedTypes for a continuity proof' });
  const history = buildHistory({ length: 120 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-prefix-cap', events: history.events, pageCap: 32 });
  const outcome = await cold(seam, w, { options: { expectedPrefix: undefined } });
  if (outcome.error !== undefined || !outcome.result || Array.isArray(outcome.result)) {
    c.blocked(`the resolved seam ${seam.functionName} does not return a snapshot object; expectedPrefix continuity is not observable (exports: ${seam.exportNames.join(', ')})`);
    return;
  }
  const raw = outcome.result as Record<string, unknown>;
  if (raw.appendedCount === undefined || !Array.isArray(raw.appendedTypes)) {
    c.fail('snapshot seam does not report appendedCount/appendedTypes, so a prefix continuity proof is unobservable', { keys: Object.keys(raw) });
    assert.fail('appendedCount/appendedTypes missing');
  }
  c.pass(`snapshot seam reports appendedCount=${String(raw.appendedCount)} appendedTypes=${JSON.stringify(raw.appendedTypes)}`, { functionName: seam.functionName, keys: Object.keys(raw) });
});

test('S01 unchanged log re-observed with expectedPrefix reports a zero-length trusted suffix', async () => {
  const c = verifyCase({ id: 'S01', title: 'prefix unchanged', spec: ['03 §4.2'], expectation: 'no new events → appendedCount=0, same asOfSeq/eventCount/digest/references' });
  const history = buildHistory({ length: 200, inbox: [{ text: 'baseline pending', at: 195 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-prefix-same', events: history.events, pageCap: 64 });
  const baseline = await baselineOf(w);
  const outcome = await cold(seam, w, { options: { expectedPrefix: baseline } });
  if (outcome.error !== undefined) {
    c.fail(`an unchanged prefix was rejected: ${String((outcome.error as Error)?.message ?? outcome.error)}`, { baseline: { asOfSeq: baseline.asOfSeq, eventCount: baseline.eventCount } });
    assert.fail('unchanged prefix rejected');
  }
  const result = outcome.result as any;
  const problems: string[] = [];
  if (result.appendedCount !== 0) problems.push(`appendedCount=${result.appendedCount}`);
  if (result.eventCount !== baseline.eventCount) problems.push(`eventCount=${result.eventCount} vs ${baseline.eventCount}`);
  if (result.asOfSeq !== baseline.asOfSeq) problems.push(`asOfSeq=${result.asOfSeq} vs ${baseline.asOfSeq}`);
  if (result.historyDigest !== baseline.historyDigest) problems.push('historyDigest changed without any append');
  if (JSON.stringify(result.references) !== JSON.stringify(baseline.references)) problems.push('references changed without any append');
  if (problems.length) { c.fail(`unchanged-prefix observation drifted: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`unchanged prefix proven (digest chain equal, appendedCount=0, ${baseline.references.length} refs)`);
});

test('S02 trusted native resume/setup/title suffix extends the baseline exactly', async () => {
  const c = verifyCase({ id: 'S02', title: 'trusted recovery suffix', spec: ['03 §4.2', '03 §5 row4', '03 §3 native resume'], expectation: 'end-seed + interrupted closers + user-pinned fixed title are accepted, counted and reported by type; older cut keeps its digest' });
  const history = buildHistory({ length: 220, inbox: [{ text: 'suffix baseline pending', at: 215 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-trusted-suffix', events: history.events, pageCap: 64 });
  const baseline = await baselineOf(w);
  const appended = appendSuffix(w);
  const outcome = await cold(seam, w, { options: { expectedPrefix: baseline } });
  if (outcome.error !== undefined) {
    c.fail(`trusted resume suffix was rejected: ${String((outcome.error as Error)?.message ?? outcome.error)}`, { appended, types: trustedSuffixEvents(w).map(event => event.type) });
    assert.fail('trusted resume suffix rejected');
  }
  const result = outcome.result as any;
  const problems: string[] = [];
  if (result.appendedCount !== appended) problems.push(`appendedCount=${result.appendedCount} expected ${appended}`);
  const expectedTypes = trustedSuffixEvents(w).map(event => event.type);
  if (JSON.stringify(result.appendedTypes) !== JSON.stringify(expectedTypes)) problems.push(`appendedTypes=${JSON.stringify(result.appendedTypes)} expected ${JSON.stringify(expectedTypes)}`);
  if (result.eventCount !== baseline.eventCount + appended) problems.push(`eventCount=${result.eventCount}`);
  if (result.asOfSeq !== baseline.asOfSeq + appended) problems.push(`asOfSeq=${result.asOfSeq}`);
  if (JSON.stringify(result.references) !== JSON.stringify(baseline.references)) problems.push('references changed although the suffix contained no inbox input');
  if (result.historyDigest === baseline.historyDigest) problems.push('historyDigest did not extend');
  if (problems.length) { c.fail(`trusted suffix continuity mismatch: ${problems.join('; ')}`, { problems, appendedTypes: result.appendedTypes }); assert.fail(problems.join('; ')); }
  c.pass(`accepted ${appended} trusted suffix events ${JSON.stringify(expectedTypes)}; prefix digest preserved, baseline references unchanged`);
});

test('S03-S06 foreign recovery-window inputs are refused (user/assistant/inbox/automatic title)', async () => {
  const variants: [string, string, (world: NativeWorld) => void][] = [
    ['S03', 'foreign user/message in recovery suffix', world => world.appendUserMessage('foreign user during resume window', 'foreign-user-recovery')],
    ['S04', 'foreign assistant/message in recovery suffix', world => world.append('assistant/message', { message: { id: 'foreign-assistant-recovery', role: 'assistant', content: [{ type: 'text', text: 'foreign assistant' }] } }, 'append')],
    ['S05', 'foreign inbox splice in recovery suffix', world => world.insertInboxMessage(userMessage('foreign inbox during resume window', 'foreign-inbox-recovery'))],
    ['S06', 'automatic (non-user) title in recovery suffix', world => world.append('session/title', { title: 'automatic title', messageSeqs: [3], source: { kind: 'assistant' } })],
  ];
  for (const [id, name, inject] of variants) {
    const c = verifyCase({ id, title: name, spec: ['03 §4.2', '03 §5 row4', '03 §4.3'], expectation: 'a foreign event appended between the pre-resume cut and resume must reject the continuity proof; it is never discarded as recovery noise' });
    const history = buildHistory({ length: 150 });
    const w = new NativeWorld({ sessionId: `shiyu-verify-${id}-foreign`, events: history.events, pageCap: 64 });
    const baseline = await baselineOf(w);
    inject(w);
    const outcome = await cold(seam, w, { options: { expectedPrefix: baseline } });
    judgeRejection(c, w, outcome, { leakCanaries: ['foreign user during resume window', 'foreign inbox during resume window'], note: 'foreign append after the observed cut' });
  }
});

test('S07-S08 earlier-cut rewrite or shrink is refused by the full-prefix digest', async () => {
  {
    const c = verifyCase({ id: 'S07', title: 'prefix same-length rewrite', spec: ['03 §4.2', '03 §3'], expectation: 'a same-length rewrite inside the previously observed prefix must fail the prefix digest, not just a count/tail comparison' });
    const history = buildHistory({ length: 160 });
    const w = new NativeWorld({ sessionId: 'shiyu-verify-prefix-rewrite', events: history.events, pageCap: 64 });
    const baseline = await baselineOf(w);
    w.rewriteEvent(5, { ...(w.events[5]!.data as any), note: 'rewritten early content' });
    judgeRejection(c, w, await cold(seam, w, { options: { expectedPrefix: baseline } }));
  }
  {
    const c = verifyCase({ id: 'S08', title: 'prefix shrink', spec: ['03 §4.2', '03 §3'], expectation: 'a log shortened below the observed cut must fail (no silently shortened recovery)' });
    const history = buildHistory({ length: 160 });
    const w = new NativeWorld({ sessionId: 'shiyu-verify-prefix-shrink', events: history.events, pageCap: 64 });
    const baseline = await baselineOf(w);
    w.truncate(100);
    judgeRejection(c, w, await cold(seam, w, { options: { expectedPrefix: baseline } }));
  }
});

test('S09-S10 tampered expectedPrefix metadata is refused', async () => {
  const cases: [string, string, (baseline: any) => any][] = [
    ['S09', 'prefix digest mismatch', baseline => ({ ...baseline, historyDigest: '00'.repeat(32) })],
    ['S10a', 'prefix header hash mismatch', baseline => ({ ...baseline, headerHash: '11'.repeat(32) })],
    ['S10b', 'prefix inherited mismatch', baseline => ({ ...baseline, inheritedEventCount: 1 })],
    ['S10c', 'prefix session identity mismatch', baseline => ({ ...baseline, sessionId: 'another-session' })],
    ['S10d', 'prefix preset mismatch', baseline => ({ ...baseline, preset: 'another-preset' })],
  ];
  for (const [id, name, tamper] of cases) {
    const c = verifyCase({ id, title: name, spec: ['03 §4.2'], expectation: 'a stale/tampered baseline must be refused when used as expectedPrefix' });
    const history = buildHistory({ length: 90 });
    const w = new NativeWorld({ sessionId: 'shiyu-verify-prefix-tamper', events: history.events, pageCap: 32 });
    const baseline = await baselineOf(w);
    judgeRejection(c, w, await cold(seam, w, { options: { expectedPrefix: tamper(baseline) } }));
  }
});

test('S11 appended suffix beyond the declared bound is refused', async () => {
  const c = verifyCase({ id: 'S11', title: 'suffix bound', spec: ['03 §4.2', '03 §4.1 bounds'], expectation: 'a recovery suffix larger than the declared maxAppendedEvents rejects instead of accepting unbounded recovery writes' });
  if (limits.raw === undefined) { c.blocked('no resolvable limits export'); return; }
  const maxAppended = (limits.raw as any).maxAppendedEvents ?? seam?.module?.NATIVE_HISTORY_LIMITS?.maxAppendedEvents;
  if (typeof maxAppended !== 'number') { c.blocked(`maxAppendedEvents not exposed in ${JSON.stringify(limits.raw)}`); return; }
  const history = buildHistory({ length: 100 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-suffix-bound', events: history.events, pageCap: 32 });
  const baseline = await baselineOf(w);
  for (let index = 0; index < maxAppended + 1; index++) w.append('step/end', { turn: 1, step: index });
  judgeRejection(c, w, await cold(seam, w, { options: { expectedPrefix: baseline } }), { note: `appended=${maxAppended + 1}, maxAppendedEvents=${maxAppended}` });
});

test('S12 trustedNativeRecoverySuffix accepts only native resume/setup/title events', () => {
  const c = verifyCase({ id: 'S12', title: 'trusted suffix predicate', spec: ['03 §3 native resume', '03 §4.2'], expectation: 'hand-built positive/negative matrix: exactly the SDK resume closers/end-seed/fixed user title pass; user/assistant/inbox/automatic-title/compaction events fail' });
  const predicate = (seam.module as any).trustedNativeRecoverySuffix;
  if (typeof predicate !== 'function') { c.blocked('trustedNativeRecoverySuffix is not exported'); return; }
  const toolResult = { type: 'tool/result', seq: 0, time: 0, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'r1', role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [] }, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } } };
  const positives: [string, any][] = [
    ['end-seed {}', { type: 'session/end-seed', seq: 0, time: 0, data: {} }],
    ['end-seed inherited', { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } }],
    ['interrupted tool/result', toolResult],
    ['interrupted tool/result unknown', { ...toolResult, data: { ...toolResult.data, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } } }],
    ['step/end', { type: 'step/end', seq: 0, time: 0, data: { turn: 1, step: 2 } }],
    ['turn/end interrupted', { type: 'turn/end', seq: 0, time: 0, data: { turn: 1, reason: { kind: 'interrupted' } } }],
    ['fixed user title', { type: 'session/title', seq: 0, time: 0, data: { title: '识雨 · 受限回复', messageSeqs: [], source: { kind: 'user' } } }],
  ];
  const negatives: [string, any][] = [
    ['user/message', { type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [], source: { kind: 'user' } }, surfaceOp: 'append' }],
    ['assistant/message', { type: 'assistant/message', seq: 0, time: 0, data: { message: { id: 'a', role: 'assistant', content: [] } }, surfaceOp: 'append' }],
    ['inbox splice', { type: 'agent/inbox/spliced', seq: 0, time: 0, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [] } }],
    ['automatic title (assistant source)', { type: 'session/title', seq: 0, time: 0, data: { title: 'auto', messageSeqs: [1], source: { kind: 'assistant' } } }],
    ['user title with messageSeqs', { type: 'session/title', seq: 0, time: 0, data: { title: 'x', messageSeqs: [2], source: { kind: 'user' } } }],
    ['completed turn/end', { type: 'turn/end', seq: 0, time: 0, data: { turn: 1, reason: { kind: 'completed' } } }],
    ['title-llm-request', { type: 'session/title-llm-request', seq: 0, time: 0, data: { sessionId: 's' } }],
    ['compaction summary', { type: 'compaction/summary', seq: 0, time: 0, data: { summary: 'x' } }],
    ['end-seed bad inherited type', { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: 'yes' } }],
    ['tool/result without surfaceOp', { ...toolResult, surfaceOp: undefined }],
  ];
  const wrong: string[] = [];
  for (const [name, event] of positives) if (predicate(event) !== true) wrong.push(`false-negative: ${name}`);
  for (const [name, event] of negatives) if (predicate(event) !== false) wrong.push(`false-positive: ${name}`);
  if (wrong.length) { c.fail(`trusted suffix predicate matrix failed: ${wrong.join('; ')}`, { wrong }); assert.fail(wrong.join('; ')); }
  c.pass(`accepted ${positives.length} trusted events, refused ${negatives.length} foreign/automatic events`, { positives: positives.map(([name]) => name), negatives: negatives.map(([name]) => name) });
});

function liveSessionFor(world: NativeWorld): any {
  // The exact live native Session shape the frozen SDK exposes: append() exists
  // on a live Session and is what maintenance-only loading requires.
  return {
    id: world.sessionId, header: structuredClone(world.header), seq: world.events.length,
    inheritedEventCount: world.inheritedEventCount,
    append() { throw new Error('verification live Session append is not exercised by cold-read cases'); },
  };
}

function liveInboxFor(world: NativeWorld): any {
  return { nextTurn: world.projectedInbox('next-turn'), nextStep: world.projectedInbox('next-step') };
}

test('S13 live Session identity/header/inherited/seq/inbox must match the observed baseline', async () => {
  const c = verifyCase({ id: 'S13', title: 'live baseline binding', spec: ['03 §4.2', '03 §5 row5'], expectation: 'exact live object/id/header/preset/inherited/seq and the projected live inbox must all match; each mismatch rejects' });
  const history = buildHistory({ length: 120, inbox: [{ text: 'live inbox pending', at: 115 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-live', events: history.events, pageCap: 32 });
  const live = liveSessionFor(w);
  const sessions = new Map([[w.sessionId, live]]);
  const context = coldContext(w, { liveSessions: sessions, flushResult: true }) as any;
  const baseline = await baselineOf(w);
  const ok = await callCold(seam, w, { options: { expectedPrefix: baseline, liveSession: live, liveInbox: liveInboxFor(w) } }, context);
  if (ok.error !== undefined) {
    c.fail(`matching live Session/inbox was rejected: ${String((ok.error as Error)?.message ?? ok.error)}`);
    assert.fail('matching live binding rejected');
  }
  const malformed: [string, any, any][] = [
    ['different live object', { ...live }, liveInboxFor(w)],
    ['wrong live seq', { ...live, seq: live.seq + 1 }, liveInboxFor(w)],
    ['wrong live header', { ...live, header: { ...live.header, cwd: '/synthetic/other' } }, liveInboxFor(w)],
    ['wrong live inherited', { ...live, inheritedEventCount: 0, header: { ...live.header, isSeeded: true } }, liveInboxFor(w)],
    ['wrong live inbox', live, { nextTurn: [userMessage('unexpected pending', 'unexpected-pending')], nextStep: [] }],
  ];
  for (const [name, sessionValue, inboxValue] of malformed) {
    // The store keeps the canonical live object; the candidate may differ from it.
    const sessions2 = new Map([[w.sessionId, live]]);
    const context2 = coldContext(w, { liveSessions: sessions2 }) as any;
    const outcome = await callCold(seam, w, { options: { expectedPrefix: baseline, liveSession: sessionValue, liveInbox: inboxValue } }, context2);
    if (outcome.error === undefined) {
      c.fail(`mismatched live binding (${name}) was accepted`, { name });
      assert.fail(`${name} accepted`);
    }
  }
  c.pass('matching live binding accepted; all 5 mismatched bindings rejected', { baseline: { asOfSeq: baseline.asOfSeq, eventCount: baseline.eventCount, inheritedEventCount: baseline.inheritedEventCount } });
  assert.equal(w.handleStats.openHandles, 0);
});

test('S14 extendNativeHistorySnapshot accepts one exact legitimate appended event and stretches the baseline', async () => {
  const c = verifyCase({ id: 'S14', title: 'extend baseline by one exact event', spec: ['03 §4.3', '03 §5 row5'], expectation: 'a fixed-title/load-only style exact append is re-read at its exact seq, EOF confirmed, and the baseline extended; a stale, duplicated or inbox-splice append fails' });
  const extend = (seam.module as any).extendNativeHistorySnapshot;
  if (typeof extend !== 'function') { c.blocked('extendNativeHistorySnapshot is not exported'); return; }
  const history = buildHistory({ length: 130 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-extend', events: history.events, pageCap: 32 });
  const context = coldContext(w) as any;
  const baseline = await baselineOf(w);
  const message = userMessage('exact load-only message', 'exact-load-only-message');
  const event = w.append('user/message', message, 'append');
  const expectation = { seq: baseline.eventCount, validate: (candidate: any) => candidate?.type === 'user/message' && candidate?.data?.id === message.id };
  const extended = await extend(context, baseline, expectation, baseline.preset);
  const problems: string[] = [];
  if (extended.eventCount !== baseline.eventCount + 1) problems.push(`eventCount=${extended.eventCount}`);
  if (extended.asOfSeq !== event.seq) problems.push(`asOfSeq=${extended.asOfSeq} expected ${event.seq}`);
  if (extended.tailEventHash === baseline.tailEventHash) problems.push('tailEventHash unchanged');
  if (JSON.stringify(extended.references) !== JSON.stringify(baseline.references)) problems.push('references changed on a non-inbox append');
  if (extended.appendedCount !== 0) problems.push(`appendedCount=${extended.appendedCount}`);
  if (problems.length) { c.fail(`extension mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  // A wrong validator, a hidden second append, and an inbox splice must all fail.
  const failures: string[] = [];
  try { await extend(context, baseline, { seq: baseline.eventCount, validate: () => false }, baseline.preset); failures.push('wrong validator accepted'); } catch { /* expected */ }
  w.append('turn/start', { turn: 2 });
  try { await extend(context, baseline, expectation, baseline.preset); failures.push('append beyond the one expected event accepted'); } catch { /* expected */ }
  const splice = userMessage('splice for extend', 'splice-for-extend');
  const spliceEvent = w.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [splice] });
  try { await extend(context, { ...extended, eventCount: spliceEvent.seq, references: extended.references }, { seq: spliceEvent.seq, validate: () => true }, baseline.preset); failures.push('inbox splice accepted as a legitimate append'); } catch { /* expected */ }
  if (failures.length) { c.fail(`extension safety failed: ${failures.join('; ')}`, { failures }); assert.fail(failures.join('; ')); }
  c.pass('exact legitimate append extended the baseline; wrong validator, stale extra append and inbox splice all refused');
});

test('S15 observeNativeBaseline flushes inside native maintenance and binds the live cut', async () => {
  const c = verifyCase({ id: 'S15', title: 'native maintenance baseline observation', spec: ['03 §4.2', '03 §5 row5'], expectation: 'flush is performed, exactly one maintenance phase runs, and live identity/inbox are bound; running/disabled hosts reject without success' });
  const observe = (seam.module as any).observeNativeBaseline;
  if (typeof observe !== 'function') { c.blocked('observeNativeBaseline is not exported'); return; }
  const history = buildHistory({ length: 140, inbox: [{ text: 'observe pending', at: 135 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-observe', events: history.events, pageCap: 32 });
  const live = liveSessionFor(w);
  const context = coldContext(w, { liveSessions: new Map([[w.sessionId, live]]) }) as any;
  let maintenance = 0;
  const agent: any = { status: 'idle', session: live, inbox: liveInboxFor(w), async runMaintenance(job: any) { maintenance++; const controller = new AbortController(); return job(controller.signal); } };
  const snapshot = await observe(context, agent, String(w.header.agentPreset));
  if (maintenance !== 1) { c.fail(`maintenance phases=${maintenance}`); assert.fail('maintenance not exclusive'); }
  if (w.flushCalls === 0) { c.fail('observeNativeBaseline did not flush'); assert.fail('no flush'); }
  if (snapshot.eventCount !== w.events.length) { c.fail(`eventCount=${snapshot.eventCount} vs ${w.events.length}`); assert.fail('wrong cut'); }
  // A running Agent cannot enter the exclusive maintenance phase.
  const running = { ...agent, status: 'running' };
  const rejected = await (async () => { try { await observe(context, running, String(w.header.agentPreset)); return false; } catch { return true; } })();
  if (!rejected) { c.fail('a running native Agent was observed as if idle'); assert.fail('running agent accepted'); }
  // A flush that no durability listener handles must never produce a baseline.
  const noFlush = coldContext(w, { liveSessions: new Map([[w.sessionId, live]]), flushResult: false }) as any;
  const noFlushRejected = await (async () => { try { await observe(noFlush, agent, String(w.header.agentPreset)); return false; } catch { return true; } })();
  if (!noFlushRejected) { c.fail('an unhandled flush still produced a baseline'); assert.fail('flush false accepted'); }
  c.pass(`one maintenance phase, ${w.flushCalls} flushes, bound cut eventCount=${snapshot.eventCount}; running host and failed flush both rejected`, { flushCalls: w.flushCalls, readPages: snapshot.readPages });
});

test('S16 recovery-window foreign append is refused even through observeNativeBaseline + expectedPrefix', async () => {
  const c = verifyCase({ id: 'S16', title: 'observe with expectedPrefix', spec: ['03 §4.2', '03 §4.3'], expectation: 'a foreign user/message appended after the pre-resume baseline is refused by the post-flush observation, never acknowledged' });
  const observe = (seam.module as any).observeNativeBaseline;
  if (typeof observe !== 'function') { c.blocked('observeNativeBaseline is not exported'); return; }
  const history = buildHistory({ length: 110 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-observe-foreign', events: history.events, pageCap: 32 });
  const baseline = await baselineOf(w);
  const live = liveSessionFor(w);
  const context = coldContext(w, { liveSessions: new Map([[w.sessionId, live]]) }) as any;
  w.appendUserMessage('foreign during resume', 'foreign-during-resume');
  const agent: any = { status: 'idle', session: live, inbox: liveInboxFor(w), async runMaintenance(job: any) { return job(new AbortController().signal); } };
  const outcome = await (async () => { try { await observe(context, agent, String(w.header.agentPreset), { expectedPrefix: baseline }); return undefined; } catch (error) { return error; } })();
  judgeRejection(c, w, { error: outcome } as any, { leakCanaries: ['foreign during resume'] });
});

test('S19 caller-controlled allowAppended can admit an explicitly authorised suffix', async () => {
  const c = verifyCase({ id: 'S19', title: 'allowAppended override', spec: ['03 §4.2 public seam'], expectation: 'an explicit caller policy (not the default trusted native suffix) is honoured and the appended count/types reflect exactly what it admitted' });
  const history = buildHistory({ length: 120 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-allow-appended', events: history.events, pageCap: 32 });
  const baseline = await baselineOf(w);
  w.appendUserMessage('caller-approved append', 'caller-approved-append');
  const outcome = await cold(seam, w, { options: { expectedPrefix: baseline, allowAppended: (event: any) => event.type === 'user/message' } });
  if (outcome.error !== undefined) { c.fail(`an explicitly allowed suffix was rejected: ${String((outcome.error as Error)?.message ?? outcome.error)}`); assert.fail('allowAppended override rejected'); }
  const result = outcome.result as any;
  const problems: string[] = [];
  if (result.appendedCount !== 1) problems.push(`appendedCount=${result.appendedCount}`);
  if (JSON.stringify(result.appendedTypes) !== JSON.stringify(['user/message'])) problems.push(`appendedTypes=${JSON.stringify(result.appendedTypes)}`);
  if (result.eventCount !== baseline.eventCount + 1) problems.push(`eventCount=${result.eventCount}`);
  if (problems.length) { c.fail(problems.join('; '), { problems }); assert.fail(problems.join('; ')); }
  c.pass('caller-controlled policy admitted exactly one user/message suffix event');
});

test('S18 compatibility inbox-array helper agrees with the snapshot seam and still refuses bad history', async () => {
  const c = verifyCase({ id: 'S18', title: 'compat inkbox helper', spec: ['03 §4.4 interface freedom', 'NATIVE_SEAMS compatibility helper'], expectation: 'the array-shaped compatibility helper returns the same exact references as the snapshot and rejects malformed history the same way' });
  const compat = (seam.module as any).coldNativeInbox;
  if (typeof compat !== 'function') { c.blocked('coldNativeInbox compatibility helper is not exported'); return; }
  const history = buildHistory({ length: 300, inbox: [{ text: 'compat pending', at: 290 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-compat', events: history.events, pageCap: 64 });
  const snapshotOutcome = await cold(seam, w);
  if (snapshotOutcome.error !== undefined) { c.fail(`snapshot read failed: ${String((snapshotOutcome.error as Error)?.message ?? snapshotOutcome.error)}`); assert.fail('snapshot read failed'); }
  const snapshot = snapshotOutcome.result as any;
  const context = coldContext(w) as any;
  const refs = await compat(context, w.sessionId, String(w.header.agentPreset));
  const problems: string[] = [];
  if (JSON.stringify(refs) !== JSON.stringify(snapshot.references)) problems.push('compat helper refs differ from the snapshot refs');
  // Malformed history must be refused by the compat helper too.
  const malformed = buildHistory({ length: 6 }).events;
  const gapped = [malformed[0], malformed[1], { ...malformed[3]! }];
  const badWorld = new NativeWorld({ sessionId: 'shiyu-verify-compat-bad', events: gapped });
  let rejected = false;
  try { await compat(coldContext(badWorld) as any, badWorld.sessionId, String(badWorld.header.agentPreset)); } catch { rejected = true; }
  if (!rejected) problems.push('compat helper accepted a gapped history');
  if (problems.length) { c.fail(problems.join('; '), { problems }); assert.fail(problems.join('; ')); }
  c.pass(`compat helper returned ${refs.length} identical references and refused malformed history`);
});

test('S17 post-recovery cut of a long session keeps the same business Session and exact projection', async () => {
  const c = verifyCase({ id: 'S17', title: 'long-session recovery projection', spec: ['03 §5 row1/row4'], expectation: 'after a trusted resume suffix on a long history, the same business Session id/preset and the whole projected inbox are preserved' });
  const history = buildHistory({ length: 2600, inbox: [{ text: 'recovery pending one', at: 2580 }, { text: 'recovery pending two', at: 2590, lane: 'next-step' }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-long-recovery', events: history.events, pageCap: 128 });
  const baseline = await baselineOf(w);
  appendSuffix(w);
  const outcome = await cold(seam, w, { options: { expectedPrefix: baseline } });
  if (outcome.error !== undefined) { c.fail(`long recovery rejected: ${String((outcome.error as Error)?.message ?? outcome.error)}`); assert.fail('long recovery rejected'); }
  const result = outcome.result as any;
  const expected = expectedFor(w);
  const problems: string[] = [];
  if (result.sessionId !== expected.sessionId) problems.push('session id changed');
  if (result.preset !== expected.preset) problems.push('preset changed');
  if (result.asOfSeq !== expected.asOfSeq) problems.push(`asOfSeq=${result.asOfSeq} vs ${expected.asOfSeq}`);
  if (JSON.stringify((result.references ?? []).map((r: any) => [r.messageId, r.lane, r.index])) !== JSON.stringify(expected.references.map(r => [r.messageId, r.lane, r.index]))) problems.push('inbox projection changed');
  if (problems.length) { c.fail(problems.join('; '), { problems }); assert.fail(problems.join('; ')); }
  c.pass(`same Session ${expected.sessionId}, preset ${expected.preset}, asOfSeq=${expected.asOfSeq}, ${expected.references.length} inbox refs after trusted suffix`);
});
