import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeService } from '../src/runtime.js';
import type { SessionDriver } from '../src/runtime.js';
import { defaultModel } from '../src/adapters/dsh/sessions.js';
import type { DshContext, ReplyRequest, ReplyResult } from '../src/adapters/dsh/sessions.js';
import type { WorkerRunRequest, WorkerRunResult, WorkerEventToolProbeResult } from '../src/adapters/dsh/workers.js';
import type { GoalLifecycleResult, GoalLifecycleRunOptions } from '../src/control/goal-lifecycle.js';
import { prepareSyntheticLocalNote } from './helpers/capability.js';

class FakeGoals {
  calls = 0;
  async initialize() {}
  async run(_taskId: string, _options: GoalLifecycleRunOptions): Promise<GoalLifecycleResult> { this.calls++; throw new Error('Synthetic Goal driver was not configured'); }
  async close() {}
}

const probeReceipt = (): WorkerEventToolProbeResult => ({
  ok: true, preset: 'shiyu-runtime-worker-v1', probeSessionId: 'shiyu-worker-probe-synthetic-fixture', scope: 'local-owner',
  tools: [
    { name: 'shiyu_worker_probe_task', description: 'restricted task slot', parameters: { type: 'object', properties: {}, additionalProperties: false }, source: 'assignment' },
    { name: 'shiyu_worker_event_types', description: 'Discover the event report types this Assignment may publish.', parameters: { type: 'object', properties: {}, additionalProperties: false }, source: 'event' },
    { name: 'shiyu_worker_event_report', description: 'Publish one scoped observation or reported result for this Assignment.', parameters: { type: 'object', properties: {}, additionalProperties: false }, source: 'event' },
  ],
  assignmentTools: ['shiyu_worker_probe_task'], eventTools: ['shiyu_worker_event_types', 'shiyu_worker_event_report'], hostTools: ['shell', 'network'],
  authorityFields: [], counters: { modelRequests: 0, modelStreams: 0, assistantMessages: 0, userMessages: 0, toolEvents: 0, usageEvents: 0 },
  released: true, disposed: true, observedAt: new Date().toISOString(),
});
class FakeWorkers {
  probeCalls = 0; runs = 0; probeFailure?: Error;
  target?: string;
  prepareLocalNote = prepareSyntheticLocalNote;
  async initialize() {}
  async probeEventTools(options?: { signal?: AbortSignal }) {
    options?.signal?.throwIfAborted();
    this.probeCalls++;
    if (this.probeFailure) throw this.probeFailure;
    return probeReceipt();
  }
  async run(_request: WorkerRunRequest): Promise<WorkerRunResult> { this.runs++; throw new Error('Synthetic worker was not configured'); }
  async close() {}
}
class PlainWorkers {
  prepareLocalNote = prepareSyntheticLocalNote;
  async initialize() {}
  async run(_request: WorkerRunRequest): Promise<WorkerRunResult> { throw new Error('Synthetic worker was not configured'); }
  async close() {}
}
class FakeSessions implements SessionDriver {
  generations = 0;
  async initialize() {}
  async prepareContextSafety() { return { ready: true as const, messageFactory: 'injected' as const, nativeReadback: true as const, coldProjection: true as const }; }
  async probe() { return { ready: true as const, noModelCalled: true as const, sessionId: 'synthetic-probe', tools: [], model: defaultModel('replyer'), released: true as const, archived: true as const }; }
  generateReply(_input: ReplyRequest): Promise<ReplyResult> { this.generations++; return new Promise((_resolve, reject) => { reject(new Error('Synthetic model must not be called')); }); }
  async getStatus() { return []; }
  async cancel() {}
  async close() {}
}

async function fixture(t: import('node:test').TestContext, workers: FakeWorkers | PlainWorkers = new FakeWorkers()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shiyu-runtime-event-probe-'));
  const sessions = new FakeSessions();
  const goals = new FakeGoals();
  const runtime = new RuntimeService({} as DshContext, { dataDir: directory }, {
    sessionFactory: () => sessions, workerFactory: () => workers as any, goalFactory: () => goals,
  });
  await runtime.init();
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, sessions, goals, workers, directory };
}

test('runtime.probe-event-tools returns the real driver receipt and persists it only as diagnostics', async t => {
  const fake = new FakeWorkers();
  const { runtime, sessions, goals } = await fixture(t, fake);
  const before = (await runtime.snapshot()).events.published;
  const receipt: any = await runtime.command({ action: 'runtime.probe-event-tools' });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.zeroModel, true);
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.sent, false);
  assert.equal(receipt.probeSessionId, 'shiyu-worker-probe-synthetic-fixture');
  assert.deepEqual(receipt.eventTools, ['shiyu_worker_event_types', 'shiyu_worker_event_report']);
  assert.equal(fake.probeCalls, 1);
  assert.equal(fake.runs, 0);
  assert.equal(goals.calls, 0);
  assert.equal(sessions.generations, 0);
  const snapshot: any = await runtime.snapshot();
  assert.equal(snapshot.diagnostics.eventToolProbe.probeSessionId, 'shiyu-worker-probe-synthetic-fixture');
  assert.deepEqual(snapshot.tasks, []);
  assert.equal(snapshot.activeWork.length, 0);
  assert.equal(snapshot.events.published, before, 'the diagnostic must not publish a lifecycle or business event');
  // The invocation is idempotent only in the read-only sense: each explicit
  // request performs one bounded probe, and no business state accumulates.
  const second: any = await runtime.command({ action: 'runtime.probe-event-tools' });
  assert.equal(second.ok, true);
  assert.equal(fake.probeCalls, 2);
  const after: any = await runtime.snapshot();
  assert.deepEqual(after.tasks, []);
  assert.equal(after.events.published, before);
});

test('the probe command follows probe admission semantics: unavailable while paused and rejected for stray input', async t => {
  const fake = new FakeWorkers();
  const { runtime } = await fixture(t, fake);
  await assert.rejects(runtime.command({ action: 'runtime.probe-event-tools', extra: true }), /Invalid event tool probe input/);
  assert.equal(fake.probeCalls, 0);
  await runtime.command({ action: 'runtime.pause' });
  await assert.rejects(runtime.command({ action: 'runtime.probe-event-tools' }), /paused/);
  assert.equal(fake.probeCalls, 0);
  await runtime.command({ action: 'runtime.resume' });
  const receipt: any = await runtime.command({ action: 'runtime.probe-event-tools' });
  assert.equal(receipt.ok, true);
  assert.equal(fake.probeCalls, 1);
});

test('a worker driver without the probe method or with a failing probe reports an explicit error and stores no receipt', async t => {
  const plain = await fixture(t, new PlainWorkers());
  await assert.rejects(plain.runtime.command({ action: 'runtime.probe-event-tools' }), /WORKER_EVENT_TOOL_PROBE_UNAVAILABLE/);
  assert.equal((await plain.runtime.snapshot()).diagnostics.eventToolProbe, null);

  const failing = new FakeWorkers();
  failing.probeFailure = Object.assign(new Error('Native probe creation refused'), { code: 'PROBE_FAILED' });
  const broken = await fixture(t, failing);
  await assert.rejects(broken.runtime.command({ action: 'runtime.probe-event-tools' }), /Native probe creation refused/);
  const snapshot: any = await broken.runtime.snapshot();
  assert.equal(snapshot.diagnostics.eventToolProbe, null);
  assert.equal(snapshot.lifecycle, 'degraded');
  assert.equal(snapshot.activeWork.length, 0);
});
