/**
 * H1 business-path case for Core decision on a resumed long Goal Session
 * (03 §5 row 8; task-3 A5, 03 §4.3 dispatch boundary).
 *
 * The Core adapter must: keep the pre-resume cut, accept only the trusted native
 * resume/title suffix, recheck the exact live baseline after onDispatch awaits,
 * load exactly one owner input with flush + independent readback before any
 * context receipt, and admit exactly one native primary stream under its
 * explicit budget. A foreign native write across the dispatch wait must block.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  CORE_GOAL_PRESET_ID, GoalSessionAdapter,
  type GoalBinding, type GoalBindingPort, type GoalAuthority, type GoalCommandReceipt,
} from '../../src/adapters/dsh/goals.js';
import type { CoreDecisionRequest } from '../../src/adapters/dsh/core-decision.js';
import { FakeHost } from './support/host.js';
import { buildHistory, userMessage, type NativeWorld } from './support/world.js';
import { verifyCase } from './support/evidence.js';

const CORE_PREFIX = 'shiyu-core-goal-';
const goalSessionId = (goalId: string, ownerId: string, scope: string) => CORE_PREFIX + createHash('sha256').update(JSON.stringify([goalId, ownerId, scope])).digest('hex');

class MemoryGoalBindings implements GoalBindingPort {
  rows = new Map<string, GoalBinding>();
  async load(goalId: string) { const value = this.rows.get(goalId); return value ? structuredClone(value) : undefined; }
  async loadCommand(_goalId: string, _commandId: string): Promise<GoalCommandReceipt | undefined> { return undefined; }
  async compareAndSet(expected: number | undefined, binding: GoalBinding) {
    const current = this.rows.get(binding.goalId);
    if (current?.metadataVersion !== expected) throw new Error('goal binding CAS mismatch');
    this.rows.set(binding.goalId, structuredClone(binding));
  }
}

interface CoreHarness {
  host: FakeHost;
  bindings: MemoryGoalBindings;
  adapter: GoalSessionAdapter;
  world: NativeWorld;
  dispatches: any[];
  contextReceipts: any[];
  accounting: any[];
  generation?: any;
}

function makeCoreHarness(options: { historyLength?: number; endOpenTurn?: boolean; generation?: any } = {}): CoreHarness {
  const goalId = 'goal-verify-1', ownerId = 'owner-verify', scope = 'goal-scope-verify';
  const cwd = '/synthetic/verify/goal-cwd';
  const sessionId = goalSessionId(goalId, ownerId, scope);
  const host = new FakeHost({ cwd, generation: options.generation ?? { text: 'core proposal text' } });
  const history = buildHistory({ length: options.historyLength ?? 2000 });
  const events = structuredClone(history.events);
  if (options.endOpenTurn) {
    events.push({ type: 'turn/start', seq: events.length, time: 1_700_000_100_000, data: { turn: 9 } });
    events.push({ type: 'step/start', seq: events.length, time: 1_700_000_100_001, data: { turn: 9, step: 1 } });
    events.push({ type: 'user/message', seq: events.length, time: 1_700_000_100_002, data: { id: 'interrupted-user', role: 'user', content: [{ type: 'text', text: 'interrupted turn input' }], source: { kind: 'user' } }, surfaceOp: 'append' });
  }
  const world = host.ensureWorld(sessionId, { agentPreset: CORE_GOAL_PRESET_ID, cwd, version: 4, createdAt: 1_700_000_000_000, isSeeded: false }, events);
  const goalView = { id: 'goal-verify-1', revision: 2, objective: 'verify long-history core planning', phase: 'active', maxGoalRounds: 32, roundsStarted: 0, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, activation: 'disarmed' };
  host.goalViews.set(sessionId, goalView);
  const bindings = new MemoryGoalBindings();
  const binding: GoalBinding = {
    goalId, sessionId, ownerId, scope, cwd, completionCriteriaHash: createHash('sha256').update('verify completion criteria').digest('hex'),
    metadataVersion: 1, goalRef: { id: goalView.id, revision: goalView.revision },
  };
  bindings.rows.set(goalId, binding);
  const authority: GoalAuthority = {
    authorize: async (_capability, context) => ({
      allowed: true, kind: 'owner', ownerId: context.ownerId, scope: context.scope,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  };
  const dispatches: any[] = [], contextReceipts: any[] = [], accounting: any[] = [];
  const adapter = new GoalSessionAdapter({
    ctx: host.ctx as any, bindings, authority, namespace: 'core',
    createUserMessage: host.messageFactory, isAgentLoopRequest: () => true,
  } as any);
  const harness: CoreHarness = { host, bindings, adapter, world, dispatches, contextReceipts, accounting, generation: options.generation };
  (harness as any).goalId = goalId;
  (harness as any).sessionId = sessionId;
  return harness;
}

function decisionRequest(harness: CoreHarness, overrides: Record<string, unknown> = {}): CoreDecisionRequest {
  const request: any = {
    goalId: (harness as any).goalId,
    expectedRef: { id: 'goal-verify-1', revision: 2 },
    roundId: String(overrides.roundId ?? 'core-round-verify-1'),
    capability: { trusted: 'verification-capability' },
    prompt: String(overrides.prompt ?? 'produce one bounded verified proposal'),
    deadlineAtMs: Date.now() + 60_000,
    maxTokens: 512,
    onDispatch: async (binding: any) => { harness.dispatches.push(binding); },
    onContextDurable: async (receipt: any) => { harness.contextReceipts.push(receipt); },
    onAccounting: async (observation: any) => { harness.accounting.push(observation); },
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
  return request as CoreDecisionRequest;
}

test('CO01 core decision on a resumed long Goal Session completes one bounded round', async () => {
  const c = verifyCase({ id: 'CO01', title: 'core long-history decision round', spec: ['03 §5 row8', '03 §4.3', '6.3'], expectation: 'same Goal Session resumed from long history; trusted suffix+title bound; exact dispatch receipt; one primary stream; bounded candidate' });
  const h = makeCoreHarness({ historyLength: 2000, endOpenTurn: true });
  // Faithful fixed-host shape: the native loop appends the required
  // working-directory runtime-context snapshot after the owner input.
  h.host.generationPlan.runtimeContext = true;
  const historyLength = h.world.events.length;
  const result = await h.adapter.decisionRound(decisionRequest(h));
  const problems: string[] = [];
  if (result.text !== 'core proposal text') problems.push(`candidate text=${result.text}`);
  if (result.binding.sessionId !== (h as any).sessionId) problems.push('Goal Session identity changed');
  if (result.verified !== false) problems.push('candidate must be unverified until control-layer checks');
  if (result.modelCalls !== 1) problems.push(`modelCalls=${result.modelCalls}`);
  if (result.usage?.status !== 'reported' || result.usage?.totalTokens !== 37) problems.push(`usage=${JSON.stringify(result.usage)}`);
  if (result.nativeGoalRound !== false || result.nativeRoundsStarted.before !== result.nativeRoundsStarted.after) problems.push('native Goal round accounting changed');
  if (h.dispatches.length !== 1) problems.push(`onDispatch calls=${h.dispatches.length}`);
  else if (h.dispatches[0].messageId !== result.binding.messageId) problems.push('dispatch receipt is not the owner message');
  if (h.contextReceipts.length !== 1) problems.push(`onContextDurable calls=${h.contextReceipts.length}`);
  if (h.accounting.length !== 1 || h.accounting[0].outcome !== 'observed') problems.push(`accounting=${JSON.stringify(h.accounting[0])}`);
  const world = h.world;
  if (world.events.length <= historyLength) problems.push('no trusted resume suffix/title appended to the resumed Goal Session');
  const inputEvent = world.events[result.inputRef.eventSeq];
  if (inputEvent?.type !== 'user/message' || inputEvent.data?.id !== result.inputRef.messageId) problems.push('input ref is not the exact durable user message');
  if (inputEvent?.data?.content?.[0]?.text !== 'produce one bounded verified proposal') problems.push('input message text mismatch');
  const assistantEvent = world.events[result.assistantRef.eventSeq];
  if (assistantEvent?.type !== 'assistant/message' || assistantEvent.data?.message?.id !== result.assistantRef.messageId) problems.push('assistant ref is not the exact durable event');
  if (!Array.isArray(result.runtimeContextRefs) || result.runtimeContextRefs.length !== 1) problems.push(`runtimeContextRefs=${JSON.stringify(result.runtimeContextRefs?.length)}`);
  else {
    const contextEvent = world.events[result.runtimeContextRefs[0]!.eventSeq];
    if (contextEvent?.type !== 'user/message' || contextEvent.data?.source?.kind !== 'runtime-context') problems.push('runtime context ref is not the exact durable cwd snapshot');
    if (contextEvent?.data?.id !== result.runtimeContextRefs[0]!.messageId) problems.push('runtime context message id mismatch');
  }
  const agent = h.host.agents.at(-1)!;
  if (agent.modelCalls !== 1) problems.push(`native model calls=${agent.modelCalls}`);
  if (world.events.filter(event => event.type === 'session/title').length !== 1) problems.push('fixed Goal Session title append missing');
  if (problems.length) { c.fail(`core decision mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`same Goal Session resumed; candidate text, exact input seq=${result.inputRef.eventSeq} and assistant seq=${result.assistantRef.eventSeq}, one model call, observed accounting`);
});

test('CO04 an extra unregistered plain user message beside the owner input is refused', async () => {
  const c = verifyCase({ id: 'CO04', title: 'extra unregistered core input', spec: ['03 §4.3', 'NATIVE_SEAMS core input boundary'], expectation: 'only the owner input plus at most the exact cwd runtime snapshot may enter the core request; any other user message is rejected before/at the stream boundary' });
  const h = makeCoreHarness({ historyLength: 300 });
  h.host.generationPlan.extraUserMessage = true;
  let error: unknown;
  try { await h.adapter.decisionRound(decisionRequest(h)); } catch (failure) { error = failure; }
  const problems: string[] = [];
  if (error === undefined) problems.push('an extra unregistered user input still produced a candidate');
  if (h.contextReceipts.length !== 0) problems.push(`onContextDurable called ${h.contextReceipts.length} times`);
  if (h.host.agents.at(-1)!.modelCalls !== 0 && h.contextReceipts.length === 0) problems.push('a model was admitted with unregistered extra input');
  if (problems.length) { c.fail(`extra core input handling failed: ${problems.join('; ')}`, { problems, error: String((error as Error)?.message ?? error) }); assert.fail(problems.join('; ')); }
  c.pass(`round refused with "${String((error as Error)?.message ?? error).slice(0, 140)}"; no candidate/context receipt`);
});

test('CO05 a pre-existing unknown pending inbox blocks the core round before dispatch', async () => {
  const c = verifyCase({ id: 'CO05', title: 'core pending inbox blocks', spec: ['03 §4.1', '03 §5 row5'], expectation: 'an unknown pending native input on the resumed Goal Session blocks the decision before any dispatch/model call; the input is preserved' });
  const h = makeCoreHarness({ historyLength: 260 });
  const pending = userMessage('unknown goal inbox input', 'unknown-goal-inbox');
  h.world.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [pending] });
  let error: unknown;
  try { await h.adapter.decisionRound(decisionRequest(h)); } catch (failure) { error = failure; }
  const problems: string[] = [];
  if (error === undefined) problems.push('a pending inbox input still allowed the core decision');
  if (h.dispatches.length !== 0) problems.push(`onDispatch called ${h.dispatches.length} times`);
  if (h.host.agents.some(agent => agent.modelCalls > 0)) problems.push('a model call was admitted');
  const remaining = h.world.events.filter(event => event.type === 'agent/inbox/spliced');
  if (remaining.length !== 1) problems.push('pending input was removed instead of preserved');
  if (problems.length) { c.fail(`core pending-inbox handling failed: ${problems.join('; ')}`, { problems, error: String((error as Error)?.message ?? error) }); assert.fail(problems.join('; ')); }
  c.pass(`decision refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; input preserved; zero dispatch/model`);
});

test('CO02 foreign native user/message during onDispatch await blocks the round', async () => {
  const c = verifyCase({ id: 'CO02', title: 'foreign write during onDispatch', spec: ['03 §4.3', '03 §5 row5'], expectation: 'a foreign native input appended while onDispatch awaits must be detected by the synchronous live baseline recheck before dispatch; no candidate, no context receipt' });
  const h = makeCoreHarness({ historyLength: 500 });
  let injected = false;
  const request = decisionRequest(h);
  request.onDispatch = async (binding: any) => {
    h.dispatches.push(binding);
    if (!injected) {
      injected = true;
      await Promise.resolve();
      const agent = h.host.live.get(binding.sessionId)!;
      agent.session.append('user/message', { id: 'foreign-on-dispatch', role: 'user', content: [{ type: 'text', text: 'FOREIGN-ON-DISPATCH-CANARY' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    }
  };
  let error: unknown;
  try { await h.adapter.decisionRound(request); } catch (failure) { error = failure; }
  const problems: string[] = [];
  if (!injected) problems.push('injection did not run');
  if (error === undefined) problems.push('a candidate escaped despite the foreign dispatch-window write');
  if (h.contextReceipts.length !== 0) problems.push(`onContextDurable called ${h.contextReceipts.length} times`);
  if (h.accounting.length === 0) problems.push('accounting observation was not recorded for the failed round');
  if (problems.length) { c.fail(`foreign onDispatch handling failed: ${problems.join('; ')}`, { problems, error: String((error as Error)?.message ?? error) }); assert.fail(problems.join('; ')); }
  c.pass(`round refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; no candidate/context receipt, accounting preserved`);
});

test('CO03 foreign native write during a Core authorization await is rechecked before dispatch', async () => {
  const c = verifyCase({ id: 'CO03', title: 'foreign write during core gate await', spec: ['03 §4.3', '03 §5 row5'], expectation: 'the dispatch gate rechecks the live baseline after an authorization await, so a write landing there is refused before any model call' });
  const h = makeCoreHarness({ historyLength: 400 });
  let injected = false;
  const authority = (h.adapter as any).options.authority;
  (h.adapter as any).options.authority = {
    authorize: async (capability: any, context: any) => {
      const verdict = await authority.authorize(capability, context);
      if (context.phase === 'dispatch' && !injected && context.expectedRef) {
        injected = true;
        await Promise.resolve();
        const agent = h.host.live.get((h as any).sessionId)!;
        agent.session.append('user/message', { id: 'foreign-in-gate', role: 'user', content: [{ type: 'text', text: 'FOREIGN-IN-GATE-CANARY' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
      }
      return verdict;
    },
  };
  let error: unknown;
  try { await h.adapter.decisionRound(decisionRequest(h)); } catch (failure) { error = failure; }
  const problems: string[] = [];
  if (!injected) problems.push('injection did not run');
  if (error === undefined) problems.push('a candidate escaped despite the foreign gate-window write');
  if (h.host.agents.at(-1) && h.host.agents.at(-1)!.modelCalls !== 0) problems.push('model was called after the foreign gate write');
  if (h.contextReceipts.length !== 0) problems.push('a context receipt was issued');
  if (problems.length) { c.fail(`foreign gate-window handling failed: ${problems.join('; ')}`, { problems, error: String((error as Error)?.message ?? error) }); assert.fail(problems.join('; ')); }
  c.pass(`round refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; zero model calls`);
});
