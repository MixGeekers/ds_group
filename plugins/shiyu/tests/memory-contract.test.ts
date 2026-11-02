import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMemoryBody, memoryBodyDigest, memoryCommandDigest, validateMemoryCreateCommand, type MemoryCreateCommand } from '../src/contracts/memory.js';
import { ControlledOmbreAdapter, ControlledOmbreError } from '../src/adapters/ombre/controlled.js';

const body = '合成记忆 🪶';
const command: MemoryCreateCommand = { schemaVersion: 1, kind: 'create', operationId: 'op-1', backendId: 'ombre-local', scope: 'local-owner', targetRef: 'target-1', ...memoryBodyDigest(body), sourceRefs: [{ sourceId: 'source-1', revision: 1 }] };
const digest = 'e69a2de3b025b7256112be410c09b0868328b035aef723e072f2a78903583ede';
const binding = { backendId: 'ombre-local', deploymentId: 'deployment-1', scope: 'local-owner' as const };
const native = 'shiyu_' + 'a'.repeat(32);
const receipt = { schemaVersion: 1, ...binding, receiptId: 'receipt_' + 'b'.repeat(64), operationId: command.operationId, commandDigest: digest,
  nativeId: native, ...memoryBodyDigest(body), sourceRefs: command.sourceRefs, componentVersion: 'sha256:' + 'e'.repeat(64), outcome: 'applied', bodyDurable: true,
  indexState: 'unknown', observedAt: '2026-11-02T09:00:00.000Z', reconciled: false };
const status = () => ({ schemaVersion: 1, ...binding, operationId: command.operationId, state: 'applied', command, commandDigest: digest, plannedNativeId: native, nativeId: native, receipt, reason: null });
const read = () => ({ schemaVersion: 1, ...binding, state: 'found', nativeId: native, command, commandDigest: digest, receipt, body, bodyDigest: command.bodyDigest, componentVersion: receipt.componentVersion, reason: null });
const wire = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const fixture = (change: (name: string, value: any) => unknown = (_name, value) => value) => {
  const calls: string[] = [];
  const adapter = new ControlledOmbreAdapter({ callTool: async request => {
    calls.push(request.name);
    return wire(change(request.name, structuredClone(request.name === 'shiyu_memory_get' ? read() : status())));
  } }, binding);
  return { adapter, calls };
};

test('command digest pins the cross-language UTF8 contract and rejects ambiguous fields/order/integers', () => {
  assert.equal(memoryCommandDigest(command), digest); assert.equal(command.bodyBytes, 17);
  for (const patch of [{ ignored: true }, { bodyBytes: 0 }, { bodyBytes: 16385 }, { operationId: '../x' }, { sourceRefs: [{ sourceId: 'b', revision: 1 }, { sourceId: 'a', revision: 1 }] }, { sourceRefs: [{ sourceId: 'a', revision: Number.MAX_SAFE_INTEGER + 1 }] }]) {
    assert.throws(() => validateMemoryCreateCommand({ ...command, ...patch }));
  }
  for (const value of ['', ' x', 'x\n', '\ud800', 'a\rb', 'a\u202eb', '雪'.repeat(5500)]) assert.throws(() => memoryBodyDigest(value));
  assert.throws(() => assertMemoryBody(command, '不同正文'));
});

test('create is only an observation; separate status and exact get establish a body-free receipt DTO', async () => {
  const f = fixture();
  const observed = await f.adapter.create(command, body); assert.equal(observed.state, 'applied');
  assert.deepEqual(f.calls, ['shiyu_memory_create']);
  const verified = await f.adapter.verifyApplied(command);
  assert.equal(verified.body, body); assert.equal(verified.observation.bodyDigest, command.bodyDigest);
  assert.equal(JSON.stringify(verified.observation).includes(body), false);
  assert.deepEqual(f.calls, ['shiyu_memory_create', 'shiyu_memory_operation_status', 'shiyu_memory_get']);
});

test('wrong deployment, source, operation, body or native version never becomes a verified receipt', async () => {
  const changes: ((name: string, value: any) => unknown)[] = [
    (_name, value) => ({ ...value, deploymentId: 'another-vault' }),
    (_name, value) => ({ ...value, command: { ...value.command, sourceRefs: [{ sourceId: 'forged-source', revision: 1 }] } }),
    (_name, value) => ({ ...value, operationId: 'different-operation' }),
    (name, value) => name === 'shiyu_memory_get' ? { ...value, body: '另一个记忆' } : value,
    (name, value) => name === 'shiyu_memory_get' ? { ...value, componentVersion: 'sha256:' + 'f'.repeat(64) } : value,
    (_name, value) => ({ ...value, receipt: { ...value.receipt, bodyDurable: false } }),
  ];
  for (const change of changes) {
    const f = fixture(change); await assert.rejects(f.adapter.verifyApplied(command));
    assert.equal(f.calls.includes('shiyu_memory_create'), false);
    assert.equal(f.calls.filter(name => name === 'shiyu_memory_operation_status').length, 1);
  }
});

test('unknown operations are not read as successful, and failures never trigger automatic writes', async () => {
  const f = fixture((_name, value) => ({ ...value, state: 'unknown', receipt: null, nativeId: null, reason: 'NATIVE_MISMATCH' }));
  await assert.rejects(f.adapter.verifyApplied(command), (error: unknown) => error instanceof ControlledOmbreError && error.code === 'UNSETTLED_OPERATION');
  assert.deepEqual(f.calls, ['shiyu_memory_operation_status']);
  let calls = 0;
  const failed = new ControlledOmbreAdapter({ callTool: async () => { calls++; throw new Error('disconnected'); } }, binding);
  await assert.rejects(failed.create(command, body)); assert.equal(calls, 1);
  await assert.rejects(failed.create(command, 'changed')); assert.equal(calls, 1);
});

test('MCP error or conflicting structured/text observations cannot bypass typed checks', async () => {
  for (const response of [{ ...wire(status()), isError: true }, { ...wire(status()), structuredContent: { ...status(), state: 'unknown' } }, { content: [{ type: 'text', text: '[OB-E004] error' }] }]) {
    const adapter = new ControlledOmbreAdapter({ callTool: async () => response }, binding);
    await assert.rejects(adapter.create(command, body), ControlledOmbreError);
  }
});
