import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GymService } from '../service.js';

test('model configuration rejection can retry the same create key without duplicating a started run', async t => {
  const root = fileURLToPath(new URL('../../runtime/', import.meta.url));
  await mkdir(root, { recursive: true });
  const runtimeDir = await mkdtemp(path.join(root, 'retry-test-'));
  let configured = false, starts = 0;
  const ctx = { get: name => name === 'agents' ? {} : name === 'agentDefaultModel' && configured ? { currentSelection: () => ({ provider: 'fake', model: 'no-model-called' }) } : undefined };
  const service = new GymService(ctx, { runtimeDir }); await service.init();
  t.after(async () => { await service.close(); await rm(runtimeDir, { recursive: true, force: true }); });
  service.driver.startTarget = async runId => { starts++; return { runId, role: 'target', sessionId: 'stub', status: 'running' }; };
  const request = { action: 'create', driver: 'dsh', idempotencyKey: 'same-click', config: { scenarioId: 'free-chat', keepOpen: true, noiseCount: 0, maxDurationMs: 30000 } };
  await assert.rejects(service.dispatch(request), /宿主尚未配置/);
  assert.equal(service.state.requests['create:same-click'], undefined);
  assert.equal(service.engine.listRuns().length, 0);
  configured = true;
  const created = await service.dispatch(request);
  configured = false;
  const replay = await service.dispatch(request);
  assert.equal(replay.run.id, created.run.id);
  assert.equal(replay.replayed, true);
  assert.equal(starts, 1);
  assert.equal(service.engine.listRuns().length, 1);
});
