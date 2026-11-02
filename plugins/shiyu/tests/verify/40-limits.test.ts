/**
 * H1 explicit capacity-limit cases.
 *
 * Spec: DSH交接 03 §2/§4.1 (页面大小、总事件、字节、读取次数、期限都必须有
 * 明确失败/容量行为，长期目标不能靠不断调大数组) and 03 §5 row 2 ("超限" must
 * reject with no acceptance receipt). Boundaries are taken from the public
 * limit constants the implementer freezes; when they are not exposed the case is
 * recorded as blocked rather than guessed green.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistory, NativeWorld } from './support/world.js';
import { cold, judgeLegal, judgeRejection } from './support/harness.js';
import { loadColdSeam, resolveLimits } from './support/seam.js';
import { verifyCase } from './support/evidence.js';

const seam = await loadColdSeam();
const limits = resolveLimits(seam.limits);

function bigEventHistory(count: number, payloadBytes: number): ReturnType<typeof buildHistory> {
  const history = buildHistory({ length: 0 });
  const events: any[] = [];
  const canaries: string[] = [];
  for (let index = 0; index < count; index++) {
    const text = `payload-${index}-` + 'x'.repeat(Math.max(0, payloadBytes - 24));
    canaries.push(text.slice(0, 32));
    events.push({ type: 'user/message', seq: index, time: 1_700_000_000_000 + index, data: { id: `big-${index}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, surfaceOp: 'append' });
  }
  return { events, canaries, messages: [] };
}

function serializedBytes(events: { data: unknown }[]): number {
  return events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
}

test('B00 advertised limits are explicit and self-consistent', () => {
  const c = verifyCase({ id: 'B00', title: 'declared limits', spec: ['03 §2', '03 §4.1'], expectation: 'page/maxEvents/maxBytes/maxReads/timeout are explicit numbers; page < maxEvents; bounds exceed the legal 2049 history' });
  if (!limits.raw) {
    c.blocked(`no public limit constants found on ${seam.functionName} module (exports: ${seam.exportNames.join(', ')})`, { exports: seam.exportNames });
    return;
  }
  const problems: string[] = [];
  if (limits.maxEvents === undefined) problems.push('maxEvents missing');
  if (limits.maxBytes === undefined) problems.push('maxBytes missing');
  if (limits.maxReads === undefined) problems.push('maxReads missing');
  if (limits.timeoutMs === undefined) problems.push('timeoutMs missing');
  if (limits.pageEvents === undefined) problems.push('pageEvents missing');
  if (limits.pageEvents !== undefined && limits.maxEvents !== undefined && limits.pageEvents >= limits.maxEvents) problems.push('pageEvents >= maxEvents');
  if (limits.maxEvents !== undefined && limits.maxEvents < 2049) problems.push('maxEvents < 2049');
  if (problems.length) {
    c.fail(`declared limits are incomplete/inconsistent: ${problems.join('; ')}`, { limits });
    assert.fail(`limit constants incomplete: ${problems.join('; ')}`);
  }
  c.pass(`explicit limits: ${JSON.stringify(limits)}`, { limits });
});

test('B01 exactly maxEvents is a legal history', async () => {
  const c = verifyCase({ id: 'B01', title: 'maxEvents boundary legal', spec: ['03 §4.1'], expectation: 'the declared capacity boundary itself must still recover; only maxEvents+1 may fail' });
  if (limits.maxEvents === undefined) { c.blocked('no maxEvents constant'); return; }
  if (limits.maxEvents > 200_000) { c.blocked(`maxEvents=${limits.maxEvents} too large for a deterministic fixture`); return; }
  const history = buildHistory({ length: limits.maxEvents, inbox: [{ text: 'boundary pending', at: limits.maxEvents - 2 }] });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-maxevents', events: history.events, pageCap: Math.min(limits.pageEvents ?? 512, 512) });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome);
});

test('B02 maxEvents + 1 rejects explicitly (no silent truncation)', async () => {
  const c = verifyCase({ id: 'B02', title: 'maxEvents exceeded', spec: ['03 §4.1', '03 §5 row2'], expectation: 'one event past the declared capacity rejects with a diagnosable limit error and releases the handle; it must not return a truncated history' });
  if (limits.maxEvents === undefined) { c.blocked('no maxEvents constant'); return; }
  if (limits.maxEvents > 200_000) { c.blocked(`maxEvents=${limits.maxEvents} too large for a deterministic fixture`); return; }
  const history = buildHistory({ length: limits.maxEvents + 1 });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-maxevents-plus', events: history.events, pageCap: Math.min(limits.pageEvents ?? 512, 512) });
  judgeRejection(c, w, await cold(seam, w));
});

test('B03 serialized history beyond maxBytes rejects', async () => {
  const c = verifyCase({ id: 'B03', title: 'maxBytes exceeded', spec: ['03 §2', '03 §4.1'], expectation: 'a history whose serialized events exceed the declared byte bound rejects; no partial projection' });
  if (limits.maxBytes === undefined) { c.blocked('no maxBytes constant'); return; }
  const count = 12;
  const payload = Math.ceil(limits.maxBytes / count) + 64 * 1024;
  const history = bigEventHistory(count, payload);
  const bytes = serializedBytes(history.events);
  assert.ok(bytes > limits.maxBytes, `fixture self-check: ${bytes} > ${limits.maxBytes}`);
  const w = new NativeWorld({ sessionId: 'shiyu-verify-maxbytes', events: history.events as any, pageCap: 64 });
  judgeRejection(c, w, await cold(seam, w), { note: `serialized fixture bytes=${bytes}, maxBytes=${limits.maxBytes}` });
});

test('B04 history well below maxBytes still succeeds (byte bound is not over-restrictive)', async () => {
  const c = verifyCase({ id: 'B04', title: 'maxBytes legal', spec: ['03 §4.1'], expectation: 'a multi-megabyte history below the byte bound recovers exactly' });
  if (limits.maxBytes === undefined) { c.blocked('no maxBytes constant'); return; }
  const target = Math.min(Math.floor(limits.maxBytes / 4), 8 * 1024 * 1024);
  const count = 6;
  const history = bigEventHistory(count, Math.max(1024, Math.floor(target / count)));
  const bytes = serializedBytes(history.events);
  if (bytes >= limits.maxBytes) { c.blocked(`fixture bytes ${bytes} not below maxBytes ${limits.maxBytes}`); return; }
  const w = new NativeWorld({ sessionId: 'shiyu-verify-maxbytes-ok', events: history.events as any, pageCap: 1 });
  const outcome = await cold(seam, w);
  judgeLegal(c, seam, w, outcome, { skipReadDiscipline: true, leakCanaries: history.canaries });
  assert.ok(bytes < limits.maxBytes);
});

test('B06 byte accounting counts UTF-8 bytes, not JavaScript characters', async () => {
  const c = verifyCase({ id: 'B06', title: 'utf8 byte accounting', spec: ['03 §4.1'], expectation: 'a history whose serialized UTF-8 bytes exceed maxBytes rejects even when its JSON character count is smaller; byte accounting is not a character count' });
  if (limits.maxBytes === undefined) { c.blocked('no maxBytes constant'); return; }
  const count = 12;
  // 3 UTF-8 bytes per CJK character, so <= maxBytes characters can exceed maxBytes bytes.
  const charsPerEvent = Math.ceil(limits.maxBytes / count / 2);
  const history = buildHistory({ length: 0 });
  const events: any[] = [];
  for (let index = 0; index < count; index++) {
    events.push({ type: 'other/event', seq: index, time: 1_700_000_000_000 + index, data: { payload: '雨'.repeat(charsPerEvent) } });
  }
  const characters = events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
  const bytes = events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0);
  if (!(bytes > limits.maxBytes && characters <= limits.maxBytes)) { c.blocked(`fixture did not straddle the byte/char boundary (chars=${characters}, bytes=${bytes}, max=${limits.maxBytes})`); return; }
  const w = new NativeWorld({ sessionId: 'shiyu-verify-utf8-bytes', events: events as any, pageCap: 64 });
  judgeRejection(c, w, await cold(seam, w), { note: `UTF-8 bytes=${bytes} > maxBytes=${limits.maxBytes}; JS characters=${characters} <= maxBytes` });
});

test('B05 read-count bound rejects instead of looping forever', async () => {
  const c = verifyCase({ id: 'B05', title: 'maxReads exceeded', spec: ['03 §2', '03 §4.1'], expectation: 'a backend forcing more than maxReads slices (pageCap=1) rejects with a bounded-work error rather than unbounded reads' });
  if (limits.maxReads === undefined) { c.blocked('no maxReads constant'); return; }
  const eventsWanted = Math.min(limits.maxReads + 10, (limits.maxEvents ?? limits.maxReads + 10) - 1);
  if (eventsWanted < 1) { c.blocked('fixture would exceed maxEvents'); return; }
  const history = buildHistory({ length: eventsWanted });
  const w = new NativeWorld({ sessionId: 'shiyu-verify-maxreads', events: history.events, pageCap: 1 });
  judgeRejection(c, w, await cold(seam, w), { note: `events=${eventsWanted}, maxReads=${limits.maxReads}, pageCap=1` });
});
