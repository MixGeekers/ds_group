import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { SHIYU_EVENT_TYPES } from '../src/contracts/events.js';
import type { GoalBinding } from '../src/adapters/dsh/goals.js';

function binding(): GoalBinding {
  const goalId = 'synthetic-goal', ownerId = 'local-owner', scope = 'local-owner';
  return { goalId, ownerId, scope, cwd: '/tmp/shiyu-synthetic-goal',
    sessionId: 'shiyu-goal-' + createHash('sha256').update(JSON.stringify([goalId, ownerId, scope])).digest('hex'),
    completionCriteriaHash: 'a'.repeat(64), metadataVersion: 1,
    receipt: { commandId: 'create-one', operation: 'create', status: 'pending', postconditionHash: 'b'.repeat(64) } };
}

test('Goal bookkeeping crosses the DB Worker with durable CAS and a retained command journal', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiyu-goal-ipc-'));
  const open = (epoch: string) => ControlStore.open({ filename: path.join(dir, 'control.sqlite'), eventTypes: SHIYU_EVENT_TYPES, componentHandlers: [], runtimeIdentity: { hostEpoch: epoch, installationGeneration: 'synthetic-installation' } });
  let store = await open('one');
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const pending = binding();
  await store.request('goal.binding.compareAndSet', { binding: pending });
  assert.deepEqual(await store.request('goal.binding.load', { goalId: pending.goalId }), pending);
  const native = { id: 'synthetic-native-goal', revision: 1 };
  const confirmed: GoalBinding = { ...pending, metadataVersion: 2, goalRef: native, receipt: { ...pending.receipt!, status: 'confirmed', observedRef: native } };
  await store.request('goal.binding.compareAndSet', { expectedMetadataVersion: 1, binding: confirmed });
  await assert.rejects(store.request('goal.binding.compareAndSet', { expectedMetadataVersion: 1, binding: confirmed }));
  assert.equal((await store.request('goal.binding.loadCommand', { goalId: pending.goalId, commandId: 'create-one' }))?.status, 'confirmed');
  assert.equal((await store.request('goal.binding.list', { ownerId: 'local-owner', scope: 'different-scope' })).length, 0);
  await store.close(); store = await open('two');
  assert.deepEqual(await store.request('goal.binding.load', { goalId: pending.goalId }), confirmed);
  const rows = await store.request('goal.binding.list', { ownerId: 'local-owner', scope: 'local-owner' });
  assert.equal(rows.length, 1); assert.equal(Object.hasOwn(rows[0], 'phase'), false);
});

test('an event-only worker does not accept Goal bookkeeping commands', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shiyu-goal-ipc-deny-'));
  const store = await ControlStore.open({ filename: path.join(dir, 'control.sqlite'), eventTypes: [], componentHandlers: [] });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(store.request('goal.binding.compareAndSet', { binding: binding() }), /trusted runtime identity/);
});
