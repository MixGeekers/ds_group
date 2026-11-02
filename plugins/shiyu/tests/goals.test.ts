import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteGoalBindingStore } from '../src/adapters/control-store/goal-bindings.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { GoalSessionAdapter, GoalOperationUnknownError, GOAL_PRESET_ID, goalCommandIdentity } from '../src/adapters/dsh/goals.js';
import type { GoalAuthorityContext, GoalAuthorityVerdict, GoalBinding, GoalBindingPort, GoalCommandReceipt, GoalCreateRequest, GoalReadResult, NativeGoalRef, NativeGoalView } from '../src/adapters/dsh/goals.js';
import type { DshAgent, DshAgentContext, DshContext, DshSession } from '../src/adapters/dsh/sessions.js';

type Hook = (...args: any[]) => any;
class Hooks {
  listeners = new Map<string, Hook[]>();
  on(name: string, handler: Hook) { const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list); return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); }; }
  async emit(name: string, ...args: any[]) { for (const fn of [...this.listeners.get(name) ?? []]) await fn(...args); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const pause = () => new Promise<void>(done => setImmediate(done));
interface FakeAgent extends DshAgent { hooks: Hooks; guards: Hook[]; activation: 'armed' | 'disarmed' }
function fixture() {
  const global = new Hooks(), live = new Map<string, FakeAgent>(), presets = new Set<string>();
  const stored = new Map<string, { header: DshSession['header']; native?: Omit<NativeGoalView, 'activation'>; title?: { title: string; source: { kind: string } } }>();
  const bindings = new Map<string, GoalBinding>(), trace: string[] = [], operations: string[] = [], checks: GoalAuthorityContext[] = [];
  const commands = new Map<string, GoalCommandReceipt>();
  const capability = Object.freeze({});
  let allowed = true, kind: 'owner' | 'mandate' = 'owner', completion: Extract<GoalAuthorityVerdict, { allowed: true }>['completion'];
  let creates = 0, resumes = 0, autoRounds = 0, disposals = 0, failConfirm = false, failFlush = false, failRead = false, failDispose = false;
  let createGate: Promise<void> | undefined, lastAgent: FakeAgent | undefined;
  let nativeSignal: AbortSignal | undefined;
  let failAfterMutation: string | undefined;
  let beforeAuthorize: ((context: GoalAuthorityContext) => void) | undefined;
  const exact = (agent: DshAgent) => { assert.equal(live.get(agent.id), agent); return stored.get(agent.id)!; };
  const view = (agent: DshAgent): NativeGoalView | undefined => {
    if (failRead) throw new Error('Native Goal replay failed');
    const value = exact(agent).native;
    return value && structuredClone({ ...value, activation: (agent as FakeAgent).activation });
  };
  const schedule = (agent: DshAgent) => { void Promise.resolve().then(() => { if ((agent as FakeAgent).activation === 'armed') autoRounds++; }); };
  const mutate = (name: string, agent: DshAgent, ref: NativeGoalRef, change: Record<string, unknown>) => {
    const record = exact(agent), prior = record.native!;
    if (!prior || prior.id !== ref.id || prior.revision !== ref.revision) throw new Error('Native Goal revision conflict');
    if ((name === 'pause' && prior.phase !== 'active') || ((name === 'resume' || name === 'complete') && prior.phase === 'complete')) throw Object.assign(new Error('Invalid native Goal transition'), { code: 'GOAL_INVALID_TRANSITION' });
    operations.push(name); trace.push(name);
    record.native = { ...prior, ...change, revision: prior.revision + 1, updatedAt: Date.now() };
    if (name === 'resume') (agent as FakeAgent).activation = 'armed';
    schedule(agent); if (failAfterMutation === name) throw new Error('Native mutation committed before error'); return view(agent);
  };
  const goals = {
    get: view,
    disarm(agent: DshAgent) { exact(agent); (agent as FakeAgent).activation = 'disarmed'; trace.push('disarm'); return view(agent); },
    create(agent: DshAgent, input: { objective: string; maxGoalRounds: number }) {
      const record = exact(agent); if (record.native && record.native.phase !== 'complete') throw new Error('Native Goal already exists');
      operations.push('create'); trace.push('create-goal');
      record.native = { id: `native-goal-${creates}`, revision: 1, objective: input.objective.trim(), maxGoalRounds: input.maxGoalRounds, phase: 'active', roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now() };
      (agent as FakeAgent).activation = 'armed'; schedule(agent); return view(agent);
    },
    edit: (agent: DshAgent, ref: NativeGoalRef, changes: Record<string, unknown>) => mutate('edit', agent, ref, changes),
    pause: (agent: DshAgent, ref: NativeGoalRef) => mutate('pause', agent, ref, { phase: 'paused' }),
    resume: (agent: DshAgent, ref: NativeGoalRef) => mutate('resume', agent, ref, { phase: 'active' }),
    complete: (agent: DshAgent, ref: NativeGoalRef) => mutate('complete', agent, ref, { phase: 'complete' }),
  };
  const make = async (options: any, resume: boolean) => {
    nativeSignal = options.signal;
    if (createGate) await createGate;
    const id = resume ? options.resumeSessionId : options.sessionId;
    if (resume) { if (!stored.has(id)) throw new Error('Native Session not found'); resumes++; }
    else { if (stored.has(id)) throw new Error('Native Session already exists'); stored.set(id, { header: structuredClone(options.meta) }); creates++; }
    const local = new Hooks(), guards: Hook[] = [];
    const session: DshSession = { id, header: stored.get(id)!.header };
    const ctx: DshAgentContext = {
      on: (name, handler) => local.on(name, handler),
      tools: { schemas: () => [{ name: 'shell' }, { name: 'create_goal' }, { name: 'update_goal' }], presentAs: () => () => {}, restrict: () => () => {}, guard(handler) { guards.push(handler); return () => { guards.splice(guards.indexOf(handler), 1); }; } },
      systemPrompt: { suppressRuntimeContext: () => () => {}, section: () => () => {}, assemble: async () => ({ tools: [] }) },
    };
    const agent: FakeAgent = { id, ctx, session, hooks: local, guards, activation: 'disarmed', status: 'idle', followup() { throw new Error('Goal adapter must not dispatch a model'); }, whenIdle: async () => {}, cancel() { trace.push('cancel'); } };
    lastAgent = agent; live.set(id, agent);
    await options.setup(ctx, agent);
    await global.emit('agent/created', { agent });
    return { agent, async dispose() { disposals++; trace.push('dispose'); if (failDispose) throw new Error('Native disposal failed'); live.delete(id); } };
  };
  const ctx: DshContext = {
    on: (name, handler) => global.on(name, handler),
    agents: { create: options => make(options, false), resume: options => make(options, true), list: () => [...live.values()] },
    get(name) {
      if (name === 'goals') return goals;
      if (name === 'sessionProjections' || name === 'sessionPersistence') return {};
      if (name === 'agentPresets') return { register(value: { id: string }) { if (presets.has(value.id)) throw new Error('Duplicate preset'); presets.add(value.id); return () => { presets.delete(value.id); }; } };
      if (name === 'sessions') return { async flush(session: DshSession) { assert.equal(live.get(session.id)?.session, session); trace.push('flush'); if (failFlush && stored.get(session.id)?.native) throw new Error('Native flush failed'); return true; } };
      if (name === 'sessionTitle') return {
        get(session: DshSession) { return stored.get(session.id)?.title; },
        rename(session: DshSession, title: string) { assert.equal(live.get(session.id)?.session, session); const result = { title, source: { kind: 'user' } }; stored.get(session.id)!.title = result; return result; },
      };
    },
  };
  const port = {
    async load(id: string) { const value = bindings.get(id); return value && structuredClone(value); },
    async loadCommand(id: string, commandId: string) { const value = commands.get(JSON.stringify([id, commandId])); return value && structuredClone(value); },
    async compareAndSet(expected: number | undefined, binding: GoalBinding) {
      assert.equal(bindings.get(binding.goalId)?.metadataVersion, expected);
      if (failConfirm && binding.receipt?.status === 'confirmed') { failConfirm = false; throw new Error('Binding confirmation failed'); }
      const receipt = binding.receipt, key = receipt && JSON.stringify([binding.goalId, receipt.commandId]), prior = key && commands.get(key);
      if (prior && receipt) {
        assert.equal(bindings.get(binding.goalId)?.receipt?.commandId, receipt.commandId, 'Historical command cannot become current again');
        assert.equal(goalCommandIdentity(prior), goalCommandIdentity(receipt));
      }
      if (key && receipt) commands.set(key, structuredClone(receipt));
      bindings.set(binding.goalId, structuredClone(binding)); trace.push(`receipt:${binding.receipt?.status}`);
    },
  };
  const authority = { async authorize(given: object, context: GoalAuthorityContext): Promise<GoalAuthorityVerdict> {
    checks.push(context); beforeAuthorize?.(context);
    if (given !== capability || !allowed) return { allowed: false };
    return { allowed: true, kind, ownerId: 'owner-1', scope: 'local', expiresAt: new Date(Date.now() + 60000).toISOString(), ...(kind === 'mandate' ? { mandateId: 'mandate-1', mandateVersion: 1, authEpoch: 1 } : {}), ...(completion ? { completion } : {}) };
  } };
  const adapter = (bindingsPort: GoalBindingPort = port) => new GoalSessionAdapter({ ctx, bindings: bindingsPort, authority });
  const request: GoalCreateRequest = { goalId: 'goal-1', ownerId: 'owner-1', scope: 'local', cwd: '/synthetic/shiyu', completionCriteriaHash: 'a'.repeat(64), objective: 'Produce a verified synthetic artifact', commandId: 'command-create', capability };
  return { adapter, request, ctx, bindings, stored, live, presets, trace, operations, checks, capability,
    counts: () => ({ creates, resumes, autoRounds, disposals }), agent: () => lastAgent!,
    nativeSignal: () => nativeSignal,
    setAllowed(value: boolean) { allowed = value; }, setKind(value: typeof kind) { kind = value; }, setProof(value: typeof completion) { completion = value; },
    failConfirmation() { failConfirm = true; }, setFlushFailure(value: boolean) { failFlush = value; }, setReadFailure(value: boolean) { failRead = value; }, setDisposeFailure(value: boolean) { failDispose = value; },
    setCreateGate(gate: Promise<void>) { createGate = gate; }, beforeAuthorize(fn: (context: GoalAuthorityContext) => void) { beforeAuthorize = fn; },
    failAfterMutation(name: string) { failAfterMutation = name; },
    async uiResume(id: string) { if (!presets.has(stored.get(id)?.header.agentPreset as string)) throw new Error('Unknown agent preset'); return make({ resumeSessionId: id, setup: () => {} }, true); },
  };
}
const reference = (value: NativeGoalView | undefined): NativeGoalRef => { assert.ok(value); return { id: value.id, revision: value.revision }; };

test('native Goal create persists only refs/receipt, disarms before queued driver work, and fixes its title', async () => {
  const f = fixture(), driver = f.adapter();
  const result = await driver.create(f.request);
  assert.equal(result.native?.phase, 'active'); assert.equal(result.native?.activation, 'disarmed');
  assert.equal(f.counts().autoRounds, 0); assert.equal(f.counts().creates, 1); assert.equal(f.live.size, 0);
  assert.equal(result.binding.receipt?.status, 'confirmed'); assert.deepEqual(result.binding.goalRef, reference(result.native));
  assert.equal('phase' in result.binding, false); assert.equal('objective' in result.binding, false);
  assert.equal(f.stored.get(result.binding.sessionId)?.title?.source.kind, 'user');
  assert.equal(f.stored.get(result.binding.sessionId)?.header.agentPreset, GOAL_PRESET_ID);
  assert.ok(f.trace.indexOf('receipt:pending') < f.trace.indexOf('create-goal'));
  assert.equal(f.trace[f.trace.indexOf('create-goal') + 1], 'disarm');
  await driver.close();
});

test('native update/pause/resume retain one Session and resume never automatically dispatches', async () => {
  const f = fixture(), driver = f.adapter(); let result = await driver.create(f.request);
  const write = () => ({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: `command-${result.native?.revision}`, capability: f.capability });
  result = await driver.update({ ...write(), objective: 'Updated bounded goal', maxGoalRounds: 8 });
  assert.equal(result.native?.objective, 'Updated bounded goal'); assert.equal(result.native?.revision, 2);
  result = await driver.pause(write()); assert.equal(result.native?.phase, 'paused');
  result = await driver.resume(write()); assert.equal(result.native?.phase, 'active'); assert.equal(result.native?.activation, 'disarmed');
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().resumes, 3); assert.equal(f.counts().autoRounds, 0);
  assert.deepEqual(f.operations, ['create', 'edit', 'pause', 'resume']); await driver.close();
});

test('model JSON cannot grant capability, and a mandate cannot resume a stopped Goal', async () => {
  const f = fixture(), driver = f.adapter();
  await assert.rejects(driver.create({ ...f.request, capability: { trusted: true, ownerId: 'owner-1' } }), /capability denied/);
  assert.equal(f.bindings.size, 0); assert.equal(f.counts().creates, 0);
  const result = await driver.create(f.request); f.setKind('mandate');
  await assert.rejects(driver.resume({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'resume', capability: f.capability }), /Only the trusted owner/);
  assert.deepEqual(f.operations, ['create']); await driver.close();
});

test('completion requires independent evidence bound to native revision and completion criteria', async () => {
  const f = fixture(), driver = f.adapter(), result = await driver.create(f.request), ref = reference(result.native);
  const command = { goalId: f.request.goalId, expectedRef: ref, commandId: 'complete', capability: f.capability };
  await assert.rejects(driver.complete(command), /completion evidence/);
  f.setProof({ goalRef: { ...ref, revision: ref.revision + 1 }, completionCriteriaHash: f.request.completionCriteriaHash, evidenceRefs: ['artifact:verified'], verifierId: 'independent', verifiedAt: new Date().toISOString() });
  await assert.rejects(driver.complete(command), /completion evidence/);
  f.setProof({ goalRef: ref, completionCriteriaHash: f.request.completionCriteriaHash, evidenceRefs: ['artifact:verified'], verifierId: 'independent', verifiedAt: new Date().toISOString() });
  const complete = await driver.complete(command);
  assert.equal(complete.native?.phase, 'complete'); assert.deepEqual(complete.binding.receipt?.evidenceRefs, ['artifact:verified']);
  await driver.close();
});

test('old native revision and authority revoked after the pending receipt cannot mutate Goal', async () => {
  const f = fixture(), driver = f.adapter(), result = await driver.create(f.request);
  await assert.rejects(driver.pause({ goalId: f.request.goalId, expectedRef: { ...reference(result.native), revision: 77 }, commandId: 'stale', capability: f.capability }), /Stale Goal revision/);
  f.beforeAuthorize(context => { if (context.operation === 'pause' && f.bindings.get(f.request.goalId)?.receipt?.status === 'pending') f.setAllowed(false); });
  await assert.rejects(driver.pause({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'revoked', capability: f.capability }), /capability denied/);
  assert.deepEqual(f.operations, ['create']); assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'rejected');
  await driver.close();
});

test('native success plus failed binding confirmation becomes unknown; recover reads original Session without replay', async () => {
  const f = fixture(), driver = f.adapter(); f.failConfirmation();
  await assert.rejects(driver.create(f.request), GoalOperationUnknownError);
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'unknown'); assert.deepEqual(f.operations, ['create']);
  await assert.rejects(driver.create(f.request), /already exists/);
  const result = await driver.recover(f.request.goalId, f.capability);
  assert.equal(result.reconciliation, 'confirmed'); assert.equal(result.binding.receipt?.status, 'confirmed');
  assert.deepEqual(f.operations, ['create']); assert.equal(f.counts().creates, 1); await driver.close();
});

test('failure before native Goal create leaves a reference fence and recovery does not invent the Goal', async () => {
  const f = fixture(), driver = f.adapter(); let grants = 0;
  f.beforeAuthorize(context => { if (context.operation === 'create' && ++grants === 2) f.setAllowed(false); });
  await assert.rejects(driver.create(f.request), GoalOperationUnknownError); f.setAllowed(true);
  const result = await driver.recover(f.request.goalId, f.capability);
  assert.equal(result.reconciliation, 'not_observed'); assert.equal(result.native, undefined); assert.equal(result.binding.receipt?.status, 'unknown');
  assert.deepEqual(f.operations, []); await driver.close();
});

test('durability failure keeps the native outcome unknown and mutation blocked until recovery', async () => {
  const f = fixture(), driver = f.adapter(); f.setFlushFailure(true);
  await assert.rejects(driver.create(f.request), GoalOperationUnknownError);
  const binding = f.bindings.get(f.request.goalId)!;
  await assert.rejects(driver.pause({ goalId: f.request.goalId, expectedRef: { id: 'unverified', revision: 1 }, commandId: 'pause', capability: f.capability }), /requires recovery/);
  f.setFlushFailure(false); const result = await driver.recover(f.request.goalId, f.capability);
  assert.equal(result.binding.sessionId, binding.sessionId); assert.equal(result.reconciliation, 'confirmed'); assert.deepEqual(f.operations, ['create']); await driver.close();
});

test('host restart recovery is disarmed, retains native lifecycle, and never consumes a Goal round', async () => {
  const f = fixture(), driver = f.adapter(), result = await driver.create(f.request); await driver.close();
  const resumed = f.adapter(), recovered = await resumed.recover(f.request.goalId, f.capability);
  assert.equal(recovered.reconciliation, 'consistent'); assert.equal(recovered.native?.activation, 'disarmed'); assert.equal(recovered.native?.roundsStarted, 0);
  assert.equal(recovered.binding.sessionId, result.binding.sessionId); assert.equal(f.counts().autoRounds, 0); assert.deepEqual(f.operations, ['create']); await resumed.close();
});

test('ordinary UI restore cannot bypass the managed preset before or after plugin unload', async () => {
  const f = fixture(), driver = f.adapter(), result = await driver.create(f.request);
  await assert.rejects(f.uiResume(result.binding.sessionId), /recovered by Shiyu/);
  assert.ok(f.agent().guards.every(guard => typeof guard({ name: 'update_goal' }) === 'string'));
  const decision = await f.agent().hooks.listeners.get('agent/pre-step')?.[0]!({}); assert.deepEqual(decision, { kind: 'reject' });
  await driver.close(); await assert.rejects(f.uiResume(result.binding.sessionId), /Unknown agent preset/);
});

test('late native creation after adapter close cannot create or arm a Goal', async () => {
  const f = fixture(), driver = f.adapter(), gate = deferred(); f.setCreateGate(gate.promise);
  const creating = driver.create(f.request), rejected = assert.rejects(creating, GoalOperationUnknownError);
  await pause(); const closing = driver.close(); gate.resolve(); await Promise.all([closing, rejected]);
  assert.deepEqual(f.operations, []); assert.equal(f.live.size, 0); assert.equal(f.presets.size, 0); assert.equal(f.counts().autoRounds, 0);
});

test('resume that commits armed then throws is synchronously disarmed before unknown receipt persistence', async () => {
  const f = fixture(), driver = f.adapter(); let result = await driver.create(f.request);
  result = await driver.pause({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'pause', capability: f.capability });
  f.failAfterMutation('resume');
  await assert.rejects(driver.resume({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'resume', capability: f.capability }), GoalOperationUnknownError);
  assert.equal(f.counts().autoRounds, 0); assert.equal(f.agent().activation, 'disarmed');
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'unknown');
  const recovered = await driver.recover(f.request.goalId, f.capability);
  assert.equal(recovered.reconciliation, 'confirmed'); assert.deepEqual(f.operations, ['create', 'pause', 'resume']); await driver.close();
});

test('recovery failure or conflicting native state preserves an unknown receipt and never replays a write', async () => {
  const f = fixture(), driver = f.adapter(); f.failConfirmation();
  await assert.rejects(driver.create(f.request), GoalOperationUnknownError);
  f.setFlushFailure(true);
  await assert.rejects(driver.recover(f.request.goalId, f.capability), GoalOperationUnknownError);
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'unknown');
  f.setFlushFailure(false);
  const binding = f.bindings.get(f.request.goalId)!, native = f.stored.get(binding.sessionId)!.native!;
  native.objective = 'An owner changed the native Goal independently'; native.revision++;
  const recovered = await driver.recover(f.request.goalId, f.capability);
  assert.equal(recovered.reconciliation, 'conflict'); assert.equal(recovered.binding.receipt?.status, 'unknown');
  assert.deepEqual(f.operations, ['create']); await driver.close();
});

test('missing independent completion evidence prevents unknown complete receipt reconciliation', async () => {
  const f = fixture(), driver = f.adapter(), result = await driver.create(f.request), ref = reference(result.native);
  f.setProof({ goalRef: ref, completionCriteriaHash: f.request.completionCriteriaHash, evidenceRefs: ['artifact:verified'], verifierId: 'independent', verifiedAt: new Date().toISOString() });
  f.failConfirmation();
  await assert.rejects(driver.complete({ goalId: f.request.goalId, expectedRef: ref, commandId: 'complete', capability: f.capability }), GoalOperationUnknownError);
  const binding = f.bindings.get(f.request.goalId)!;
  assert.deepEqual(binding.receipt?.evidenceRefs, ['artifact:verified']);
  assert.deepEqual(binding.receipt?.completionProof?.goalRef, ref);
  binding.receipt!.evidenceRefs = [];
  await assert.rejects(driver.recover(f.request.goalId, f.capability), GoalOperationUnknownError);
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'unknown');
  assert.deepEqual(f.operations, ['create', 'complete']); await driver.close();
});

test('changing independent evidence after its durable receipt rejects completion before the native write', async () => {
  const f = fixture(), driver = f.adapter(), result = await driver.create(f.request), ref = reference(result.native);
  const proof = { goalRef: ref, completionCriteriaHash: f.request.completionCriteriaHash, evidenceRefs: ['artifact:first'], verifierId: 'independent', verifiedAt: new Date().toISOString() };
  f.setProof(proof);
  f.beforeAuthorize(context => { if (context.operation === 'complete' && f.bindings.get(f.request.goalId)?.receipt?.status === 'pending') f.setProof({ ...proof, evidenceRefs: ['artifact:other'] }); });
  await assert.rejects(driver.complete({ goalId: f.request.goalId, expectedRef: ref, commandId: 'complete', capability: f.capability }), /evidence changed/);
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'rejected'); assert.deepEqual(f.operations, ['create']); await driver.close();
});

test('failed native release after a committed mutation cannot return success or leave a confirmed receipt', async () => {
  const f = fixture(), driver = f.adapter(), result = await driver.create(f.request); f.setDisposeFailure(true);
  await assert.rejects(driver.pause({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'pause', capability: f.capability }), GoalOperationUnknownError);
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'unknown'); assert.equal(f.agent().activation, 'disarmed');
  assert.ok(f.agent().guards.length > 0); await assert.rejects(driver.close(), /cleanup failed/);
});

test('historical command IDs cannot be reused with a newer native revision', async () => {
  const f = fixture(), driver = f.adapter(); let result = await driver.create(f.request);
  result = await driver.update({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'edit-once', capability: f.capability, objective: 'Updated goal' });
  await assert.rejects(driver.pause({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'command-create', capability: f.capability }), /already accepted/);
  await assert.rejects(driver.update({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'edit-once', capability: f.capability, objective: 'Changed again' }), /already accepted/);
  assert.deepEqual(f.operations, ['create', 'edit']); await driver.close();
});

test('native repeated pause is a confirmed rejection and does not permanently fence later valid commands', async () => {
  const f = fixture(), driver = f.adapter(); let result = await driver.create(f.request);
  result = await driver.pause({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'pause-once', capability: f.capability });
  await assert.rejects(driver.pause({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'pause-twice', capability: f.capability }), /Invalid native Goal transition/);
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'rejected');
  result = await driver.resume({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'resume-after-rejection', capability: f.capability });
  assert.equal(result.native?.phase, 'active'); assert.deepEqual(f.operations, ['create', 'pause', 'resume']); await driver.close();
});

test('caller cancellation reaches native Session creation and a late returned handle cannot mutate Goal', async () => {
  const f = fixture(), driver = f.adapter(), gate = deferred(), controller = new AbortController(); f.setCreateGate(gate.promise);
  const running = driver.create({ ...f.request, signal: controller.signal }), rejected = assert.rejects(running, GoalOperationUnknownError);
  while (!f.nativeSignal()) await pause();
  assert.equal(f.nativeSignal()?.aborted, false); controller.abort(new Error('Caller cancelled creation'));
  assert.equal(f.nativeSignal()?.aborted, true); gate.resolve(); await rejected;
  assert.deepEqual(f.operations, []); assert.equal(f.live.size, 0); assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'unknown'); await driver.close();
});

test('caller cancellation during the final authority check prevents a native lifecycle mutation', async () => {
  const f = fixture(), driver = f.adapter(), controller = new AbortController(), result = await driver.create(f.request);
  f.beforeAuthorize(context => { if (context.operation === 'pause' && f.bindings.get(f.request.goalId)?.receipt?.status === 'pending') controller.abort(new Error('Caller cancelled mutation')); });
  await assert.rejects(driver.pause({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'cancelled-pause', capability: f.capability, signal: controller.signal }), /Caller cancelled mutation/);
  assert.equal(f.nativeSignal()?.aborted, true); assert.deepEqual(f.operations, ['create']);
  assert.equal(f.bindings.get(f.request.goalId)?.receipt?.status, 'rejected'); await driver.close();
});

test('actual SQLite binding journal composes with the native adapter through unknown recovery and completion', async () => {
  const db = new DatabaseSync(':memory:'), store = new SQLiteGoalBindingStore(db, new SqliteTransactions(db)), raw = store.asPort();
  let failConfirmation = true;
  const port: GoalBindingPort = { ...raw, async compareAndSet(expected, binding) {
    if (failConfirmation && binding.receipt?.status === 'confirmed') { failConfirmation = false; throw new Error('Synthetic confirmation fault'); }
    await raw.compareAndSet(expected, binding);
  } };
  const f = fixture(), driver = f.adapter(port);
  try {
    await assert.rejects(driver.create(f.request), GoalOperationUnknownError);
    assert.equal(store.load(f.request.goalId)?.receipt?.status, 'unknown');
    let result: GoalReadResult = await driver.recover(f.request.goalId, f.capability);
    for (const operation of ['pause', 'resume'] as const) result = await driver[operation]({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: operation, capability: f.capability });
    f.setProof({ goalRef: reference(result.native), completionCriteriaHash: f.request.completionCriteriaHash, evidenceRefs: ['artifact:verified'], verifierId: 'independent', verifiedAt: new Date().toISOString() });
    result = await driver.complete({ goalId: f.request.goalId, expectedRef: reference(result.native), commandId: 'complete', capability: f.capability });
    assert.equal(result.native?.phase, 'complete'); assert.equal(store.load(f.request.goalId)?.receipt?.status, 'confirmed');
    assert.equal(store.loadCommand(f.request.goalId, 'command-create')?.status, 'confirmed'); assert.equal(f.counts().autoRounds, 0);
  } finally { await driver.close(); db.close(); }
});
