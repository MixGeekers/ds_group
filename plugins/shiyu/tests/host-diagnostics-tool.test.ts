/**
 * Tool-definition contracts for the host read-only status and the zero-model
 * worker-tool diagnosis tool. These are thin wrappers: the test pins the exact
 * command they execute, their read-only/zero-model descriptions and that their
 * parameters accept no authority fields.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointAvailabilityTool, coreModelToolProbeTool, coreToolDiagnosisTool, statusTool, timeSourceDiagnosisTool, timeTriggerDiagnosisTool, workerToolDiagnosisTool } from '../src/index.js';

test('status tool is parameterless, concurrency-safe and simply returns the runtime snapshot', async () => {
  const snapshot = { schemaVersion: 1, instanceId: 'synthetic', state: 'idle' };
  const tool = statusTool({ snapshot: async () => snapshot });
  assert.equal(tool.name, 'shiyu_status');
  assert.equal(tool.isConcurrencySafe, true);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(await tool.execute(), snapshot);
  const rendered = tool.output.render({}, snapshot) as Array<{ type: string; text: string }>;
  assert.equal(rendered.length, 1);
  assert.deepEqual(JSON.parse(rendered[0]!.text), snapshot);
  assert.match(tool.description, /不执行任务或调用模型/);
});

test('worker tool diagnosis executes exactly the zero-model probe command and renders its receipt', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, zeroModel: true, readOnly: true, sent: false, tools: ['shiyu_worker_probe_task'], counters: { requests: 0 } };
  const tool = workerToolDiagnosisTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_worker_tools');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /零模型诊断/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-event-tools' }]);
  const rendered = tool.output.render({}, receipt) as Array<{ text: string }>;
  assert.deepEqual(JSON.parse(rendered[0]!.text), receipt);
});

test('core tool diagnosis executes exactly the zero-model core probe command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, zeroModel: true, readOnly: true, sent: false, probeSessionId: 'shiyu-core-probe-synthetic', tools: [], counters: { modelRequests: 0 } };
  const tool = coreToolDiagnosisTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_core_event_tools');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /零模型诊断/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-event-tools' }]);
  const rendered = tool.output.render({}, receipt) as Array<{ text: string }>;
  assert.deepEqual(JSON.parse(rendered[0]!.text), receipt);
});

test('time source diagnosis tool executes exactly the zero-model probe command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, zeroModel: true, readOnly: true, sent: false, toolName: 'shiyu_diagnose_time_source', released: true, disposed: true };
  const tool = timeSourceDiagnosisTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_time_source');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /零模型诊断/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-time-source' }]);
});

test('checkpoint availability tool executes exactly the read-only probe command', async () => {
  const calls: unknown[] = [];
  const receipt = { ready: false, expectedReady: false, readOnly: true, captureAttempted: false, filesWritten: 0, blockers: [] };
  const tool = checkpointAvailabilityTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_checkpoint_availability');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /只读诊断/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.checkpoint.probe' }]);
});

test('core model tool probe executes exactly the bounded real-model command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: false, status: 'unknown', sent: false, usage: { status: 'unknown' } };
  const tool = coreModelToolProbeTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_core_model_tools');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /不重试/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-model-tools' }]);
});

test('live time-trigger diagnosis tool executes exactly the append-only probe command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, zeroModel: true, readOnly: false, sent: false, liveDataTouched: 'control-events-append-only', sideEffects: { controlEventAppended: true } };
  const tool = timeTriggerDiagnosisTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_time_trigger');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /append-only/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-time-trigger' }]);
});
