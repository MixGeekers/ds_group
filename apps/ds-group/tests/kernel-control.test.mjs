import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KernelControl, publicKernelSummary } from '../src/kernel-control.mjs';

const ownerId = '@owner:kernel.test';
const botId = '@bot:kernel.test';
const otherBotId = '@other:kernel.test';
const people = [
  { id: ownerId, kind: 'human', name: 'Same name' },
  { id: '@other-owner:kernel.test', kind: 'human', name: 'Same name' },
  { id: botId, kind: 'bot', ownerId, localpart: 'bot' },
  { id: otherBotId, kind: 'bot', ownerId, localpart: 'other' },
];

async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-control-'));
  let time = 1000000;
  const nodes = new Map();
  const accounts = {
    human(id) {
      const person = people.find(person => person.id === id && person.kind === 'human');
      if (!person) throw Object.assign(new Error('Human required'), { status: 403 });
      return person;
    },
    person: id => people.find(person => person.id === id),
  };
  const args = { dataRoot, accounts, node: id => nodes.get(id), now: () => time, ...options };
  let control = await new KernelControl(args).initialize();
  t.after(async () => { control.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const online = (id = botId, runtimeId = 'run-1', extra = {}) => {
    const person = accounts.person(id);
    nodes.set(id, { id: person.localpart, botId: id, runtimeId, status: 'idle', heartbeatAt: time, kernelControl: { version: 1 }, ...extra });
    return { botId: id, nodeId: person.localpart, runtimeId };
  };
  return {
    get control() { return control; }, dataRoot, nodes, online,
    advance(ms) { time += ms; },
    async restart() { control.close(); control = await new KernelControl(args).initialize(); },
  };
}

const scopeFor = identity => ({ botId: identity.botId, nodeId: identity.nodeId });
const resultFor = (command, result) => ({ ...command, status: 'completed', result });
const list = { kind: 'person', items: [{ id: 'matrix:@alice:test', name: 'Alice', kind: 'person', aliases: ['A'], currentCount: 2, historyCount: 3, scopes: ['bot:bot'] }], more: false };

test('kernel projection keeps unknowns and publishes only declared credential-free health fields', () => {
  assert.deepEqual(publicKernelSummary(null), {
    runtime: { id: null, version: null, upstreamVersion: null, available: null },
    attention: { mode: null, provider: { configured: null, available: null, model: null }, activity: null, queue: null, lastDecision: null },
    work: { status: 'unknown', activeTasks: null, waiting: null },
    memorySummary: { people: null, projects: null, pendingReview: null },
  });
  const output = publicKernelSummary({
    runtime: { id: 'dscord', version: '0.4.0', upstreamVersion: '0.3.1', available: true, decisionKey: 'private' },
    attention: { mode: 'natural', activity: 'listening', provider: { configured: true, available: true, model: 'provider/model', apiKey: 'private' },
      queue: { pending: 1, waiting: 2, evaluating: 0, errors: -1, private: 'private' },
      lastDecision: { id: 'd1', action: 'LISTEN', status: 'decided', outcome: 'waiting', at: 1, eventIds: ['$event'], watermark: { sequence: 1, eventId: '$event', roomId: '!room:test' }, latencyMs: 2, prompt: 'private' } },
    work: { status: 'idle', activeTasks: 0, waiting: 0, accessToken: 'private' },
    memorySummary: { people: 1, projects: 2, pendingReview: 3, raw: 'private' },
  });
  assert.equal(JSON.stringify(output).includes('private'), false);
  assert.equal(output.attention.queue.errors, null);
  assert.equal(output.attention.provider.model, 'provider/model');
  assert.equal(output.runtime.version, '0.4.0');
});

test('attention desired mode persists offline, applies by revision, and reapplies to a replacement runtime', async t => {
  const app = await fixture(t);
  assert.equal((await stat(path.join(app.dataRoot, 'kernel-control.sqlite'))).mode & 0o777, 0o600);
  assert.deepEqual(app.control.setAttention(botId, { mode: 'shadow' }), { mode: 'shadow', revision: 1, status: 'pending', applied: false, online: false });
  assert.equal(app.control.setAttention(botId, { mode: 'shadow' }).revision, 1);
  await app.restart();
  const identity = app.online();
  const scope = scopeFor(identity);
  const [command] = app.control.poll(identity, scope).commands;
  assert.equal(command.operation, 'attention-set');
  assert.deepEqual(command.args, { mode: 'shadow' });
  assert.equal(command.revision, 1);
  assert.throws(() => app.control.result(resultFor(command, {}), scope), error => error.code === 'INVALID_ATTENTION_RESULT');
  assert.deepEqual(app.control.result(resultFor(command, { mode: 'shadow', revision: 1 }), scope), { recorded: true, duplicate: false });
  assert.deepEqual(app.control.result(resultFor(command, { mode: 'shadow', revision: 1 }), scope), { recorded: true, duplicate: true });
  assert.equal(app.control.desired(botId).status, 'applied');
  assert.equal(app.control.poll(identity, scope).commands.length, 0);
  const replacement = app.online(botId, 'run-2');
  const [next] = app.control.poll(replacement, scope).commands;
  assert.equal(next.revision, 1);
  assert.notEqual(next.leaseId, command.leaseId);
  assert.equal(app.control.desired(botId).status, 'pending');
  assert.throws(() => app.control.result(resultFor(command, { mode: 'shadow', revision: 1 }), scope), error => error.code === 'KERNEL_RUNTIME_CHANGED');
  app.control.result(resultFor(next, { mode: 'shadow', revision: 1 }), scope);
  assert.equal(app.control.desired(botId).status, 'applied');
});

test('newer attention revisions supersede in-flight settings and failed settings retry the same revision', async t => {
  const app = await fixture(t);
  const identity = app.online();
  const scope = scopeFor(identity);
  app.control.setAttention(botId, { mode: 'mention' });
  const [old] = app.control.poll(identity, scope).commands;
  assert.equal(app.control.setAttention(botId, { mode: 'natural' }).revision, 2);
  assert.throws(() => app.control.result(resultFor(old, { mode: 'mention', revision: 1 }), scope), error => error.code === 'KERNEL_LEASE_EXPIRED');
  const [current] = app.control.poll(identity, scope).commands;
  app.control.result({ ...current, status: 'error', error: { code: 'RUNTIME_BUSY', message: 'private' } }, scope);
  assert.equal(app.control.desired(botId).status, 'pending');
  assert.equal(app.control.poll(identity, scope).commands.length, 0);
  app.advance(5001);
  const [retry] = app.control.poll(identity, scope).commands;
  assert.equal(retry.revision, 2);
  assert.notEqual(retry.commandId, current.commandId);
});

test('read RPC returns actual list data and rejects cross-Bot, cross-lease and conflicting duplicate receipts', async t => {
  const app = await fixture(t);
  const identity = app.online();
  const other = app.online(otherBotId);
  const scope = scopeFor(identity);
  const pending = app.control.readMemory(botId, { kind: 'person' });
  const [command] = app.control.poll(identity, scope).commands;
  assert.equal(command.operation, 'memory-profiles');
  assert.throws(() => app.control.poll(identity, scopeFor(other)), error => error.status === 403);
  assert.throws(() => app.control.result({ ...command, ...other, status: 'failed', error: { code: 'FAILED' } }, scopeFor(other)), error => error.status === 403);
  assert.throws(() => app.control.result({ ...command, status: 'error', leaseId: 'fake', error: { code: 'FAILED' } }, scope), error => error.code === 'KERNEL_LEASE_MISMATCH');
  const receipt = resultFor(command, { ...list, decisionKey: 'private', provider: { apiKey: 'private' } });
  app.control.result(receipt, scope);
  assert.deepEqual(await pending, list);
  assert.deepEqual(app.control.result(receipt, scope), { recorded: true, duplicate: true });
  assert.throws(() => app.control.result(resultFor(command, { ...list, items: [] }), scope), error => error.status === 409);
});

test('profile RPC preserves evidence but removes nested credentials and validates profile identity', async t => {
  const app = await fixture(t);
  const identity = app.online();
  const scope = scopeFor(identity);
  const id = 'matrix:@alice:test';
  const pending = app.control.readMemory(botId, { kind: 'person', id });
  const [command] = app.control.poll(identity, scope).commands;
  const result = { kind: 'person', id, identity: { id, name: 'Alice', provider: { apiKey: 'private' } }, view: {
    currentClaims: [{ text: 'Prefers Chinese', source: { eventId: '$real', authorId: '@alice:test' }, decisionKey: 'private' }],
    historyGaps: ['Before observation'], version: 3, knowledgeBoundary: { observedOnly: true },
  }, rawState: 'private' };
  assert.throws(() => app.control.result(resultFor(command, { ...result, id: 'another' }), scope), error => error.code === 'KERNEL_INVALID_RESULT');
  app.control.result(resultFor(command, result), scope);
  const profile = await pending;
  assert.equal(profile.view.currentClaims[0].source.eventId, '$real');
  assert.equal(profile.view.version, 3);
  assert.deepEqual(profile.view.historyGaps, ['Before observation']);
  assert.equal(profile.view.preferences, null);
  assert.equal(JSON.stringify(profile).includes('private'), false);
});

test('expired read leases can retry but cannot settle a new lease, including error receipts', async t => {
  const app = await fixture(t, { leaseMs: 100 });
  const identity = app.online();
  const scope = scopeFor(identity);
  const pending = app.control.readMemory(botId, { kind: 'person' });
  const [old] = app.control.poll(identity, scope).commands;
  app.advance(101);
  assert.throws(() => app.control.result({ ...old, status: 'failed', error: { code: 'OLD' } }, scope), error => error.code === 'KERNEL_LEASE_EXPIRED');
  const [retry] = app.control.poll(identity, scope).commands;
  assert.equal(old.commandId, retry.commandId);
  assert.notEqual(old.leaseId, retry.leaseId);
  assert.throws(() => app.control.result(resultFor(old, list), scope), error => error.code === 'KERNEL_LEASE_MISMATCH');
  app.control.result(resultFor(retry, list), scope);
  assert.deepEqual(await pending, list);
});

test('memory reads distinguish disconnected, unsupported, unknown profile, node error and timeout', async t => {
  const app = await fixture(t, { rpcTimeoutMs: 30 });
  assert.throws(() => app.control.readMemory(botId, { kind: 'person' }), error => error.code === 'BOT_OFFLINE');
  let identity = app.online(botId, 'run-1', { kernelControl: null });
  assert.throws(() => app.control.readMemory(botId, { kind: 'person' }), error => error.code === 'KERNEL_CONTROL_UNAVAILABLE');
  identity = app.online();
  const scope = scopeFor(identity);
  let pending = app.control.readMemory(botId, { kind: 'project', id: 'project:unknown' });
  let assertion = assert.rejects(pending, error => error.status === 404 && error.code === 'MEMORY_PROFILE_NOT_KNOWN');
  let [command] = app.control.poll(identity, scope).commands;
  app.control.result({ ...command, status: 'failed', error: { code: 'MEMORY_PROFILE_NOT_KNOWN', message: 'private' } }, scope);
  await assertion;
  pending = app.control.readMemory(botId, { kind: 'person' });
  assertion = assert.rejects(pending, error => error.status === 502 && error.code === 'KERNEL_NODE_ERROR' && !error.message.includes('private'));
  [command] = app.control.poll(identity, scope).commands;
  app.control.result({ ...command, status: 'failed', error: { code: 'DB_FAILED', message: 'private' } }, scope);
  await assertion;
  await assert.rejects(app.control.readMemory(botId, { kind: 'person' }), error => error.status === 504 && error.code === 'KERNEL_TIMEOUT');
});

test('disconnect and Core restart retire pending reads without inventing empty memory', async t => {
  const app = await fixture(t);
  const identity = app.online();
  let pending = app.control.readMemory(botId, { kind: 'person' });
  let assertion = assert.rejects(pending, error => error.code === 'BOT_OFFLINE');
  app.nodes.get(botId).status = 'offline';
  app.control.observeNode(botId);
  await assertion;
  app.online();
  app.control.setAttention(botId, { mode: 'natural' });
  pending = app.control.readMemory(botId, { kind: 'person' });
  assertion = assert.rejects(pending, error => error.code === 'KERNEL_CORE_RESTARTED');
  const commands = app.control.poll(identity, scopeFor(identity)).commands;
  await app.restart();
  await assertion;
  const after = app.control.poll(identity, scopeFor(identity)).commands;
  assert.equal(after.length, 1);
  assert.equal(after[0].operation, 'attention-set');
  assert.equal(after[0].revision, 1);
  assert.ok(commands.every(command => command.commandId !== after[0].commandId));
});

test('owner identity, stale summaries, invalid management inputs and aborted reads remain bounded', async t => {
  const app = await fixture(t);
  assert.throws(() => app.control.owner('@other-owner:kernel.test', botId), error => error.status === 403);
  assert.throws(() => app.control.owner(botId, botId), error => error.status === 403);
  assert.equal(app.control.owner(ownerId, botId).id, botId);
  for (const input of [{ mode: 'wrong' }, { mode: 'natural', decisionKey: 'private' }, null]) {
    assert.throws(() => app.control.setAttention(botId, input), error => error.status === 400);
  }
  const identity = app.online(botId, 'run-1', { kernel: { runtime: { available: true }, attention: { mode: 'natural' }, memorySummary: { people: 3 } } });
  assert.equal(app.control.snapshot(botId).memorySummary.people, 3);
  app.advance(20001);
  assert.equal(app.control.snapshot(botId).online, false);
  assert.equal(app.control.snapshot(botId).runtime.available, false);
  assert.equal(app.control.snapshot(botId).memorySummary.people, null);
  app.online();
  for (const input of [{ kind: 'wrong' }, { kind: 'person', id: '' }, { kind: 'person', id: {} }]) {
    assert.throws(() => app.control.readMemory(botId, input), error => error.status === 400);
  }
  const controller = new AbortController();
  const pending = app.control.readMemory(botId, { kind: 'person' }, controller.signal);
  const assertion = assert.rejects(pending, error => error.code === 'KERNEL_QUERY_CANCELLED');
  controller.abort();
  await assertion;
  assert.equal(app.control.poll(identity, scopeFor(identity)).commands.length, 0);
});

test('a disconnected browser releases its queue slots and excessive parallel reads are rejected', async t => {
  const app = await fixture(t);
  const identity = app.online();
  const controller = new AbortController();
  const assertions = Array.from({ length: 32 }, () => assert.rejects(app.control.readMemory(botId, { kind: 'person' }, controller.signal), error => error.code === 'KERNEL_QUERY_CANCELLED'));
  assert.throws(() => app.control.readMemory(botId, { kind: 'person' }), error => error.status === 429 && error.code === 'KERNEL_QUEUE_FULL');
  controller.abort();
  await Promise.all(assertions);
  assert.equal(app.control.poll(identity, scopeFor(identity)).commands.length, 0);
  const pending = app.control.readMemory(botId, { kind: 'person' });
  const [command] = app.control.poll(identity, scopeFor(identity)).commands;
  app.control.result(resultFor(command, { ...list, items: [] }), scopeFor(identity));
  assert.deepEqual(await pending, { ...list, items: [] }, 'Only an actual completed node response establishes an empty profile list');
});
