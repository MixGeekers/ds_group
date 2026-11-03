/**
 * Tool-definition contracts for the host read-only status and the zero-model
 * worker-tool diagnosis tool. These are thin wrappers: the test pins the exact
 * command they execute, their read-only/zero-model descriptions and that their
 * parameters accept no authority fields.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointAvailabilityTool, coreGoalValidationTool, coreGoalValidationV2Tool, coreGoalValidationV3Tool, coreGoalValidationV4Tool, coreGoalValidationV5Tool, coreGoalValidationV6Tool, coreModelToolProbeTool, coreToolDiagnosisTool, coreValidationReconcileTool, emotionContinuationDiagnosisTool, memoryEmbeddingProbeTool, nativeHeaderCutProbeTool, statusTool, timeSourceDiagnosisTool, timeTriggerDiagnosisTool, workerToolDiagnosisTool } from '../src/index.js';
import { innerLifecycleDiagnosisTool } from '../src/control/inner-lifecycle-probe.js';

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

test('inner lifecycle diagnosis tool executes exactly the isolated zero-model probe command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true, store: { kind: 'in-memory' }, liveDataTouched: false, checks: [] };
  const tool = innerLifecycleDiagnosisTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_inner_lifecycle');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /零模型|zero-model/i);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-inner-lifecycle' }]);
});

test('core goal validation tool executes exactly the declared bounded real business command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, status: 'completed', readOnlyProbe: false, declaredSideEffects: { goal: true, task: true, realModelCalls: true } };
  const tool = coreGoalValidationTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_validate_core_goal');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /非只读探针/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-goal' }]);
});

test('core validation reconcile tool executes exactly the read-mostly reconcile command', async () => {
  const calls: unknown[] = [];
  const receipt = { classification: 'inert-unauthorized', readback: 'complete', readOnly: true, createsGoal: false, modelCalls: 0, retries: 0 };
  const tool = coreValidationReconcileTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_reconcile_core_validation_goal');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /不创建|不重试/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.reconcile-core-validation-goal' }]);
});

test('core goal validation v2 tool executes exactly the new frozen experiment command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, status: 'failed', reasonCode: 'CORE_VALIDATION_CREATE_FAILED', readOnlyProbe: false };
  const tool = coreGoalValidationV2Tool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_validate_core_goal_v2');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /v2 新冻结实验/);
  assert.match(tool.description, /不是对 v1 的 replay/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-goal-v2' }]);
});

test('core goal validation v3 tool executes exactly the third frozen experiment command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, status: 'failed', reasonCode: 'CORE_VALIDATION_CREATE_FAILED', requestId: 'core-validation-frozen-v3', readOnlyProbe: false };
  const tool = coreGoalValidationV3Tool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_validate_core_goal_v3');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /v3 全新冻结实验/);
  assert.match(tool.description, /非 v1\/v2 重试/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-goal-v3' }]);
});

test('native header-cut probe tool executes exactly the zero-model owner command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, status: 'passed', matched: false, zeroModel: true, zeroEmbedding: true, zeroTaskOrEffect: true };
  const tool = nativeHeaderCutProbeTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_native_header_cut');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /零模型/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-native-header-cut' }]);
});

test('core goal validation v4 tool executes exactly the fourth frozen experiment command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, status: 'failed', reasonCode: 'CORE_VALIDATION_CREATE_FAILED', requestId: 'core-validation-frozen-v4', readOnlyProbe: false };
  const tool = coreGoalValidationV4Tool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_validate_core_goal_v4');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /v4 全新冻结实验/);
  assert.match(tool.description, /非 v1\/v2\/v3 重试/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-goal-v4' }]);
});

test('core goal validation v5 tool executes exactly the fifth frozen experiment command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, status: 'failed', reasonCode: 'CORE_VALIDATION_EVALUATION_UNKNOWN', requestId: 'core-validation-frozen-v5', readOnlyProbe: false };
  const tool = coreGoalValidationV5Tool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_validate_core_goal_v5');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /v5 全新冻结实验/);
  assert.match(tool.description, /非 v1-v4 重试/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-goal-v5' }]);
});

test('core goal validation v6 tool executes exactly the sixth frozen experiment command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, status: 'failed', reasonCode: 'CORE_VALIDATION_EVALUATION_UNKNOWN', requestId: 'core-validation-frozen-v6', readOnlyProbe: false };
  const tool = coreGoalValidationV6Tool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_validate_core_goal_v6');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /v6 全新冻结实验/);
  assert.match(tool.description, /非 v1-v5 重试/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-core-goal-v6' }]);
});

test('memory embedding verification tool executes exactly the zero-generation-model probe command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, embeddingCalls: 1, usageComplete: true, generationModelCalls: 0 };
  const tool = memoryEmbeddingProbeTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_verify_memory_embedding');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.match(tool.description, /零生成模型/);
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-memory-embedding' }]);
});

test('emotion continuation diagnosis tool executes exactly the isolated probe command', async () => {
  const calls: unknown[] = [];
  const receipt = { ok: true, zeroModel: true, liveDataTouched: false, checks: [] };
  const tool = emotionContinuationDiagnosisTool({ command: async (input: unknown) => { calls.push(input); return receipt; } });
  assert.equal(tool.name, 'shiyu_diagnose_emotion_continuation');
  assert.equal(tool.isConcurrencySafe, false);
  assert.deepEqual(tool.parameters, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(await tool.execute(), receipt);
  assert.deepEqual(calls, [{ action: 'runtime.probe-emotion-continuation' }]);
});
