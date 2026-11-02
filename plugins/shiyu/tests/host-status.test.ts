/**
 * Host-status regression (H0): the public read-only tool `shiyu_status` returns
 * `RuntimeService.snapshot()`. DSH 0.2.1-rc.5 validates every tool output as
 * lossless JSON before rendering, so snapshot() must never contain an explicit
 * `undefined`, a non-finite number, `-0`, a sparse array, or a non-plain object.
 *
 * Observed real failure before this slice: `invalid output: value is not lossless JSON`.
 * Two producers were responsible:
 *   - `dependencies[].checkedAt` used `probe?.at` / `verification?.at` (undefined on a
 *     fresh instance that had not yet observed those dependencies);
 *   - the Lab public projection always emitted `reasonCode` / `sendId` keys even
 *     when the durable row had no value (structuredClone keeps explicit undefined).
 *
 * This test implements the lossless rule independently (from the documented
 * contract, not from a product helper) and is itself verified against known-bad
 * and known-good samples.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeService } from '../src/runtime.js';
import type { SessionDriver } from '../src/runtime.js';
import type { DshContext, ReplyRequest, ReplyResult } from '../src/adapters/dsh/sessions.js';
import { defaultModel } from '../src/adapters/dsh/sessions.js';
import type { WorkerRunRequest, WorkerRunResult } from '../src/adapters/dsh/workers.js';
import type { GoalLifecycleResult, GoalLifecycleRunOptions } from '../src/control/goal-lifecycle.js';
import { publicConnection } from '../src/control/lab.js';
import type { LabConnectionDetail } from '../src/contracts/lab.js';
import { prepareSyntheticLocalNote } from './helpers/capability.js';

/** Independent implementation of the lossless-JSON rule documented for DSH tool output. */
function losslessViolation(value: unknown, at = '$', ancestors = new Set<object>()): string | undefined {
  if (value === null) return undefined;
  if (typeof value === 'boolean' || typeof value === 'string') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? undefined : `${at}: non-lossless number ${String(value)}`;
  if (typeof value !== 'object') return `${at}: non-JSON ${typeof value}`;
  const current = value as object;
  if (ancestors.has(current)) return undefined;
  ancestors.add(current);
  try {
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) return `${at}: non-plain array prototype`;
      if (Object.keys(current).length !== current.length) return `${at}: sparse or extra-keyed array`;
      for (let index = 0; index < current.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(current, index)) return `${at}[${index}]: missing dense slot`;
        const problem = losslessViolation(current[index], `${at}[${index}]`, ancestors);
        if (problem) return problem;
      }
      return undefined;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return `${at}: non-plain object (${prototype?.constructor?.name ?? 'null-proto'})`;
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') return `${at}: symbol key`;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable) return `${at}.${key}: non-enumerable property`;
      if (!('value' in descriptor)) return `${at}.${key}: accessor property`;
      const problem = losslessViolation(descriptor.value, `${at}.${key}`, ancestors);
      if (problem) return problem;
    }
    return undefined;
  } finally {
    ancestors.delete(current);
  }
}

test('lossless checker itself rejects known-bad silently-lossy values and accepts known-good ones', () => {
  const bad: Array<[string, () => unknown]> = [
    ['explicit undefined', () => ({ ok: true, missing: undefined })],
    ['undefined in array', () => [1, undefined, 3]],
    ['NaN', () => ({ value: Number.NaN })],
    ['Infinity', () => ({ value: Number.POSITIVE_INFINITY })],
    ['negative zero', () => ({ value: -0 })],
    ['class instance', () => ({ at: new Date() })],
    ['Map', () => ({ map: new Map() })],
    ['sparse array', () => { const list = [1, 2, 3]; delete (list as unknown as Record<string, unknown>)['1']; return list; }],
    ['symbol key', () => ({ [Symbol('x')]: 1 })],
    ['function', () => ({ run() {} })],
  ];
  for (const [name, make] of bad) assert.ok(losslessViolation(make()), `${name} must be rejected`);
  const good: unknown[] = [{ a: 1, b: 'x', c: null, d: [1, 2, { e: true }] }, { nested: { empty: {}, list: [] } }, 0, false, ''];
  for (const value of good) assert.equal(losslessViolation(value), undefined, `${JSON.stringify(value)} must pass`);
  // JSON.stringify silently drops explicit undefined, which is exactly why the
  // native LOSSLESS contract is stronger than a JSON round trip on the wire.
  assert.equal(JSON.stringify({ ok: true, missing: undefined }), JSON.stringify({ ok: true }));
  assert.deepEqual(JSON.parse(JSON.stringify({ ok: true, missing: undefined })), { ok: true });
});

class FakeSessions implements SessionDriver {
  async initialize() {}
  async prepareContextSafety() { return { ready: true as const, messageFactory: 'injected' as const, nativeReadback: true as const, coldProjection: true as const }; }
  async probe() { return { ready: true as const, noModelCalled: true as const, sessionId: 'synthetic-probe', tools: [], model: defaultModel('replyer'), released: true as const, archived: true as const }; }
  generateReply(_input: ReplyRequest): Promise<ReplyResult> { return new Promise(() => {}); }
  async getStatus() { return []; }
  async cancel() {}
  async close() {}
}
class FakeWorkers {
  prepareLocalNote = prepareSyntheticLocalNote;
  async initialize() {}
  async run(_request: WorkerRunRequest): Promise<WorkerRunResult> { throw new Error('Synthetic worker was not configured'); }
  async close() {}
}
class FakeGoals {
  async initialize() {}
  async run(_taskId: string, _options: GoalLifecycleRunOptions): Promise<GoalLifecycleResult> { throw new Error('Synthetic Goal driver was not configured'); }
  async close() {}
}

async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiyu-host-status-test-'));
  const sessions = new FakeSessions();
  const runtime = new RuntimeService({} as DshContext, { dataDir: directory }, {
    sessionFactory: () => sessions, workerFactory: () => new FakeWorkers() as any, goalFactory: () => new FakeGoals() as any,
  });
  await runtime.init();
  t.after(async () => { await runtime.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  return { runtime, directory };
}

test('runtime snapshot is lossless JSON on a fresh instance without dependency observations', async t => {
  const { runtime } = await fixture(t);
  const snapshot = await runtime.snapshot();
  assert.equal(losslessViolation(snapshot), undefined);
  // A fresh instance has no probe/model/goal observation; checkedAt must be absent,
  // not an explicit undefined property that DSH would reject before rendering.
  for (const dependency of snapshot.dependencies) {
    if (Object.prototype.hasOwnProperty.call(dependency, 'checkedAt')) {
      assert.equal(typeof dependency.checkedAt, 'string', `${dependency.id} checkedAt must be a real timestamp when present`);
    }
  }
  const nativeSession = snapshot.dependencies.find(dependency => dependency.id === 'native-session' as never) as any;
  assert.equal(nativeSession.checkedAt, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(nativeSession, 'checkedAt'));
  // The lossless snapshot must survive the same JSON round trip the HTTP route uses.
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('runtime snapshot stays lossless with tasks, conversations and active diagnostics', async t => {
  const { runtime } = await fixture(t);
  const created: any = await runtime.command({ action: 'task.createLocal', requestId: 'host-status-lossless', title: 'Synthetic status Task', content: 'Synthetic status artifact' });
  await runtime.command({ action: 'conversation.linkLocalTask', taskId: created.task.taskId });
  for (let round = 0; round < 3; round++) {
    const snapshot = await runtime.snapshot();
    assert.equal(losslessViolation(snapshot), undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  }
});

test('lab public projection omits absent optional reply fields instead of emitting undefined', () => {
  const detail = {
    connectionId: 'lab-synthetic', requestId: 'request-synthetic', runId: 'run-synthetic', version: 7, epoch: 2,
    status: 'connected', expiresAt: '2026-11-02T12:10:00.000Z',
    budget: { tokens: 1, calls: 1, effects: 1 }, balance: { limits: { tokens: 1, calls: 1, effects: 1 }, spent: { tokens: 0, calls: 0, effects: 0 }, held: { tokens: 0, calls: 0, effects: 0 }, available: { tokens: 1, calls: 1, effects: 1 } },
    channels: [{ channelId: 'C-SYNTH', kind: 'group', membersDigest: 'members', conversationId: 'conversation-synthetic', inputVersion: 1, cursor: 1,
      latestInput: { eventId: 'event-1', channelId: 'C-SYNTH', seq: 1, actorId: 'actor-1', actorType: 'human', bodyHash: 'hash', bodyBytes: 2 }, pendingInputs: [] }],
    replies: [
      { replyId: 'reply-1', channelId: 'C-SYNTH', anchorEventId: 'event-1', status: 'accounted', reasonCode: undefined, sendId: undefined, reservation: { state: 'reserved', amount: { tokens: 1, calls: 1, effects: 0 }, observed: { tokens: 0, calls: 0, effects: 0 } } },
      { replyId: 'reply-2', channelId: 'C-SYNTH', anchorEventId: 'event-2', status: 'unknown', reasonCode: 'LAB_OPERATION_UNCONFIRMED', sendId: 'send-2', reservation: { state: 'unknown', amount: { tokens: 1, calls: 1, effects: 0 }, observed: { tokens: 0, calls: 0, effects: 0 } } },
    ],
    sends: [],
  } as unknown as LabConnectionDetail;
  const projected = publicConnection(detail, true);
  assert.equal(losslessViolation(projected), undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(projected.replies[0], 'reasonCode'));
  assert.ok(!Object.prototype.hasOwnProperty.call(projected.replies[0], 'sendId'));
  assert.equal(projected.replies[1].reasonCode, 'LAB_OPERATION_UNCONFIRMED');
  assert.equal(projected.replies[1].sendId, 'send-2');
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
});
