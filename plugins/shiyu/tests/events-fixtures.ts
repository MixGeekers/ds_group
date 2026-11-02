/**
 * Shared synthetic fixtures for the H2a event-path tests.
 *
 * Everything here is a native-protocol double or a trusted composition seam:
 * real temporary SQLite through the ControlStore worker thread, plus a compact
 * DSH Agent protocol double. It never contacts the installed host, a model or
 * an embedding backend.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { ControlStore } from '../src/adapters/control-store/index.js';
import { EventService } from '../src/control/events/index.js';
import { SHIYU_EVENT_TYPES, type EventPrincipal, type SubscribeInput } from '../src/contracts/events.js';
import { EventDeliveryCoordinator, type AgentEventTarget, type ComponentEventConsumer, type ContinuationContextReceipt } from '../src/control/events/index.js';
import type { DshAgent, DshAgentContext, DshContext, DshSession, SessionEvent } from '../src/adapters/dsh/sessions.js';
import type { NativeMessageInput, NativeUserMessage } from '../src/adapters/dsh/native-message.js';

export const HANDLER_A = 'shiyu.test.handler-a';
export const HANDLER_B = 'shiyu.test.handler-b';

/** Trusted read-only observer identity for test oracles (never a product principal). */
export function readerPrincipal(scopes = ['local-owner'], targetRefs: string[] = []): EventPrincipal {
  return { principalId: 'test-reader', kind: 'component', scopes, publishTypes: [],
    subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs };
}
/** Trusted coordinator identity used by delivery tests. */
export function coordinatorPrincipal(targetRefs: string[], scopes = ['local-owner']): EventPrincipal {
  return { principalId: 'shiyu-runtime-coordinator', kind: 'component', scopes,
    publishTypes: [], subscribeTypes: SHIYU_EVENT_TYPES.map(type => type.type), targetRefs };
}

export async function eventStore(t: TestContext, componentHandlers: string[] = [HANDLER_A, HANDLER_B], eventTypes = SHIYU_EVENT_TYPES) {
  const base = await mkdtemp(join(tmpdir(), 'shiyu-events-h2a-'));
  const stores: ControlStore[] = [];
  const filename = join(base, 'control.sqlite');
  const open = async () => {
    const store = await ControlStore.open({ filename, eventTypes, componentHandlers });
    stores.push(store);
    return { store, events: new EventService(store) };
  };
  t.after(async () => { await Promise.all(stores.map(store => store.close().catch(() => undefined))); await rm(base, { recursive: true, force: true }); });
  return { directory: base, filename, ...await open(), open };
}

type Hook = (...args: any[]) => any;
class Hooks {
  listeners = new Map<string, Hook[]>();
  on(name: string, handler: Hook) {
    const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list);
    return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
  }
  async emit(name: string, ...args: any[]) { for (const handler of [...(this.listeners.get(name) ?? [])]) await handler(...args); }
  async waterfall(name: string, args: any[], terminal: () => Promise<any>) {
    const list = [...(this.listeners.get(name) ?? [])]; let index = 0;
    const next = (): Promise<any> => list[index++]?.(...args, next) ?? terminal();
    return next();
  }
}
const pause = () => new Promise<void>(done => setImmediate(done));
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

interface FakeAgent extends DshAgent { hooks: Hooks; guards: Hook[]; registered: Map<string, any>; cancelled: boolean }

/**
 * Minimal native DSH Agent protocol double for the managed worker driver.
 * It implements exactly the interfaces workers.ts composes against: presets,
 * persistence, flush, title pin, model resolver, tool registry, waterfall
 * hooks and the durable-ish event sequence.
 */
export function fakeWorkerHost() {
  const hooks = new Hooks(), live = new Map<string, FakeAgent>(), presets = new Set<string>();
  const persisted = new Map<string, { header: DshSession['header']; events: SessionEvent[] }>();
  const trace: string[] = [], requests: any[] = [], assemblies: any[] = [];
  const messages: NativeUserMessage[] = [];
  const titles = new Map<string, { title: string; source: { kind: string } }>();
  const factory = (input: NativeMessageInput): NativeUserMessage => {
    const message: NativeUserMessage = { ...structuredClone(input), role: 'user', id: `worker-fixture-${messages.length + 1}` };
    messages.push(message); return message;
  };
  let steps = 1, outputTokens: number | undefined = 5;
  let candidate: unknown = { summary: 'candidate only', evidenceRequests: [] };
  let call: { name: string; args: Record<string, unknown> } | undefined;
  let lastAgent: FakeAgent | undefined;
  let failDispose = false, creates = 0, resumes = 0, disposals = 0, followups = 0;
  let createFault: Error | undefined;
  let createGate: Promise<void> | undefined, creationAttempts = 0;
  let setupHook: ((agent: FakeAgent, helpers: { emit(event: SessionEvent): Promise<void>; request(): Promise<unknown> }) => Promise<void>) | undefined;
  const make = async (options: any, resume: boolean) => {
    creationAttempts++;
    if (createGate) await createGate;
    if (createFault) throw createFault;
    const id = resume ? options.resumeSessionId : options.sessionId;
    const stored: { header: DshSession['header']; events: SessionEvent[] } | undefined = resume ? persisted.get(id) : { header: options.meta, events: [] };
    if (!stored) throw new Error('Session not found');
    const local = new Hooks(), registered = new Map<string, any>(), guards: Hook[] = [];
    const session: DshSession = { id, header: stored.header };
    let idle = Promise.resolve();
    const emit = async (event: SessionEvent) => { stored.events.push(event); await local.emit('session/event', session, event); await hooks.emit('session/event', session, event); };
    const ctx = {
      on: (name: string, handler: Hook) => local.on(name, handler),
      tools: {
        schemas: () => [{ name: 'shell' }, { name: 'read_file' }, { name: 'network' }, { name: 'run_code' }, ...[...registered.values()].map(tool => ({ name: tool.name }))],
        presentAs: () => () => {}, restrict: () => () => {},
        guard(handler: Hook) { guards.push(handler); return () => { const index = guards.indexOf(handler); if (index >= 0) guards.splice(index, 1); }; },
        register(tool: any) { assert.equal(registered.has(tool.name), false); registered.set(tool.name, tool); return () => { registered.delete(tool.name); }; },
      },
      systemPrompt: {
        suppressRuntimeContext: () => () => {}, section: () => () => {},
        assemble: () => local.waterfall('system-prompt/assemble', [{}, {}], async () => ({ tools: [{ name: 'shell' }, { name: 'dynamic_future_tool' }] })),
      },
    } as DshAgentContext;
    const agent: FakeAgent = {
      id, session, ctx, hooks: local, guards, registered, status: 'idle', cancelled: false,
      followup(input) {
        assert.equal(input.role, 'user');
        followups++; trace.push('followup'); agent.status = 'running';
        idle = (async () => {
          try {
            await emit({ type: 'user/message', data: input });
            for (let step = 0; step < steps; step++) {
              const decision = await local.waterfall('agent/pre-step', [{ agent }], async () => ({ kind: 'enter' }));
              if (decision.kind === 'reject') throw new Error('Step rejected');
              assemblies.push(await ctx.systemPrompt.assemble({ scope: agent }));
              const request = await local.waterfall('agent/request', [{}], async () => ({ provider: 'host-default', model: 'host-default', reasoningEffort: 'max', maxTokens: 99999 }));
              requests.push(request);
              let toolBlock: any;
              if (call) {
                const denied = guards.map(guard => guard(call)).find(Boolean); if (denied) throw new Error(String(denied));
                const tool = registered.get(call.name); if (!tool) throw new Error('No registered tool');
                const result = await tool.execute(call.args, { signal: new AbortController().signal });
                toolBlock = { type: 'tool-call', id: `call-${step}`, name: call.name, arguments: JSON.stringify(call.args) };
                await emit({ type: 'tool/call', data: { turn: 0, step, callId: `call-${step}`, name: call.name, arguments: JSON.stringify(call.args) } });
                await emit({ type: 'tool/result', data: { turn: 0, step, message: { role: 'tool', content: [{ type: 'text', text: JSON.stringify(result) }] } } });
              }
              const content: any[] = [];
              if (toolBlock) content.push(toolBlock);
              if (step === steps - 1) content.push({ type: 'text', text: JSON.stringify(candidate) });
              else content.push({ type: 'text', text: 'intermediate' });
              await emit({ type: 'assistant/message', data: { message: { content }, usage: { inputTokens: 10, ...(outputTokens === undefined ? {} : { outputTokens, totalTokens: 10 + outputTokens }) } } });
            }
            await emit({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
          } catch (error) { await emit({ type: 'turn/end', data: { reason: { kind: 'blocked' }, error: String(error) } }); throw error; }
          finally { agent.status = 'idle'; }
        })();
      },
      whenIdle: () => idle,
      cancel() { agent.cancelled = true; },
    };
    lastAgent = agent;
    await options.setup(ctx, agent);
    if (setupHook) await setupHook(agent as FakeAgent, { emit, request: () => local.waterfall('agent/request', [{}], async () => ({})) });
    await hooks.emit('agent/created', { agent });
    persisted.set(id, stored); live.set(id, agent);
    if (resume) resumes++; else creates++;
    return { agent, async dispose() { disposals++; trace.push('dispose'); agent.cancel({ kind: 'hook', reason: 'disposed' }); try { await idle; } catch { /* run error is reported by the driver */ } live.delete(id); if (failDispose) throw new Error('Native dispose failed'); } };
  };
  const ctx: DshContext = {
    on: (name, handler) => hooks.on(name, handler),
    get(name) {
      if (name === 'agentPresets') return { async register(value: { id: string }) { if (presets.has(value.id)) throw new Error('Duplicate preset'); presets.add(value.id); return () => { presets.delete(value.id); }; } };
      if (name === 'sessionPersistence') return {};
      if (name === 'sessions') return { async flush(session: DshSession) { trace.push('flush'); assert.equal(live.get(session.id)?.session, session); return true; } };
      if (name === 'sessionTitle') return {
        rename(session: DshSession, title: string) {
          assert.equal(live.get(session.id)?.session, session);
          trace.push('title'); const snapshot = { title, source: { kind: 'user' } }; titles.set(session.id, snapshot); return snapshot;
        },
        get(session: DshSession) { return titles.get(session.id); },
      };
      if (name === 'llm') return { async resolveCallConfig(model: any) { return { ...model }; } };
    },
    agents: { create: (options: any) => make(options, false), resume: (options: any) => make(options, true), list: () => [...live.values()] },
  };
  return {
    ctx, live, persisted, presets, trace, requests, assemblies, titles, factory, messages,
    agent: () => lastAgent!,
    counts: () => ({ creates, resumes, disposals, followups, attempts: creationAttempts }),
    setSteps(value: number) { steps = value; },
    setCandidate(value: unknown) { candidate = value; },
    setUsage(value: number | undefined) { outputTokens = value; },
    failDispose() { failDispose = true; },
    setCreateFault(error: Error) { createFault = error; },
    setCreateGate(promise: Promise<void>) { createGate = promise; },
    setSetupHook(hook: typeof setupHook) { setupHook = hook; },
    /** Simulate the model's tool call for this turn (the native loop executes it). */
    toolCall(name: string, args: Record<string, unknown>) { call = { name, args }; },
    async uiResume(id: string) { const stored = persisted.get(id)!; if (!presets.has(stored.header.agentPreset as string)) throw new Error('Unknown agent preset'); return make({ resumeSessionId: id, setup: () => {} }, true); },
  };
}

export function workerRequest(scope = 'local-owner', overrides: Record<string, unknown> = {}) {
  const identity = { taskId: 'task-1', assignmentId: 'assignment-1', scope, hostEpoch: 'host-1',
    installationGeneration: 'install-1', fencingToken: 1, leaseExpiresAt: new Date(Date.now() + 120000).toISOString() };
  const checks: any[] = [];
  return {
    identity,
    input: {
      taskId: identity.taskId, assignmentId: identity.assignmentId, scope: identity.scope, cwd: '/tmp/shiyu-worker-event-test',
      prompt: 'Report one synthetic observation.',
      permit: { hostEpoch: identity.hostEpoch, installationGeneration: identity.installationGeneration,
        fencingToken: identity.fencingToken, leaseExpiresAt: identity.leaseExpiresAt,
        check: (context: any) => { checks.push(context); return context.phase === 'tool' || context.phase === 'tool-result' ? { allowed: true, ...identity } : { allowed: true, ...identity }; } },
      onBound: async () => {},
      ...overrides,
    } as any,
    checks,
  };
}

/**
 * Synthetic durable consumer-side ledger. Independent from product state: it is
 * the "effect endpoint" oracle for at-least-once delivery and idempotency.
 */
export class EffectLedger {
  readonly effects: { key: string; value: string }[] = [];
  readonly duplicates: string[] = [];
  private readonly done = new Map<string, string>();
  record(key: string, value: string): { effectRef: string; duplicate: boolean } {
    const existing = this.done.get(key);
    if (existing !== undefined) { this.duplicates.push(key); return { effectRef: existing, duplicate: true }; }
    const effectRef = `effect:${this.effects.length + 1}`;
    this.effects.push({ key, value }); this.done.set(key, effectRef);
    return { effectRef, duplicate: false };
  }
  get count(): number { return this.effects.length; }
}

/** Synthetic native Session bridge that only appends after its trusted gate. */
export class SyntheticAgentSession {
  readonly appended: { deliveryId: string; eventId: string; text: string; eventSeq: number; messageId: string }[] = [];
  /** Number of times a model wake would have been admitted. */
  modelWakes = 0;
  private readonly done = new Map<string, { sessionId: string; eventSeq: number; messageId: string; durability: 'confirmed' }>();
  readonly sessionId = 'shiyu-core-goal-synthetic';
  append(input: { deliveryId: string; eventId: string; text: string }): { sessionId: string; eventSeq: number; messageId: string; durability: 'confirmed' } {
    const existing = this.done.get(input.deliveryId);
    if (existing) return existing;
    const eventSeq = this.appended.length;
    const messageId = `native-user-${eventSeq + 1}`;
    this.appended.push({ deliveryId: input.deliveryId, eventId: input.eventId, text: input.text, eventSeq, messageId });
    this.modelWakes++;
    const receipt = { sessionId: this.sessionId, eventSeq, messageId, durability: 'confirmed' as const };
    this.done.set(input.deliveryId, receipt);
    return receipt;
  }
}

export { pause };

// --- Shared four-path composition helpers -----------------------------------

export const OWNER_SCOPE = 'local-owner';

export function componentPublisher(types = ['component.observation.reported'], principalId = 'trusted-component:files'): EventPrincipal {
  return { principalId, kind: 'component', scopes: [OWNER_SCOPE], publishTypes: types, subscribeTypes: [], targetRefs: [] };
}

export function agentSubscriber(targetRefs: string[],
  subscribeTypes = ['task.succeeded', 'component.observation.reported', 'worker.result.reported', 'agent.observation.reported']): EventPrincipal {
  return { principalId: 'core-agent:goal-1', kind: 'agent' as const, scopes: [OWNER_SCOPE],
    publishTypes: ['agent.observation.reported'], subscribeTypes, targetRefs };
}

export function subscriptionFor(id: string, types: string[], patch: Partial<SubscribeInput> = {}): SubscribeInput {
  return { id, types, scope: OWNER_SCOPE, target: { kind: 'component', handlerRef: HANDLER_A },
    deliveryMode: 'component', start: { kind: 'from_now' }, ...patch };
}

export function componentConsumer(handlerRef: string, ledger: EffectLedger, calls?: () => void): ComponentEventConsumer {
  return { handlerRef, async consume(input) {
    calls?.();
    const recorded = ledger.record(input.deliveryId, `${input.event.type}:${input.event.eventId}`);
    return { effectRef: recorded.effectRef };
  } };
}

export interface GoalPorts {
  target: AgentEventTarget;
  model: SyntheticAgentSession;
  references: EffectLedger;
  wakes: () => number;
  setPaused(value: boolean): void;
  setAllowed(value: boolean): void;
  setReason(value: string | undefined): void;
  gateCalls: number;
  dispatches: number;
}
export function goalTarget(bindingId: string, mode: 'background' | 'continuation', model = new SyntheticAgentSession()): GoalPorts {
  const references = new EffectLedger();
  const state = { paused: false, allowed: true, reason: undefined as string | undefined };
  const ports: GoalPorts = {
    model, references, gateCalls: 0, dispatches: 0,
    wakes: () => model.modelWakes,
    setPaused(value) { state.paused = value; },
    setAllowed(value) { state.allowed = value; },
    setReason(value) { state.reason = value; },
    target: {
      bindingId, mode,
      async updateBackground(input) {
        const recorded = references.record(input.deliveryId, input.eventId);
        return { referenceId: recorded.effectRef, duplicate: recorded.duplicate };
      },
      async evaluateContinuation() {
        ports.gateCalls++;
        if (state.paused) return { allowed: false, reason: 'PAUSED' };
        return state.allowed ? { allowed: true } : { allowed: false, reason: state.reason ?? 'REVOKED' };
      },
      async dispatchContinuation(input) {
        ports.dispatches++;
        return model.append({ deliveryId: input.deliveryId, eventId: input.eventId, text: `${input.event.type}:${input.event.eventId}` }) as ContinuationContextReceipt;
      },
    },
  };
  return ports;
}

export function coordinatorFor(events: any, handlers: ComponentEventConsumer[], agentTargets: AgentEventTarget[],
  targetRefs: string[], timeoutMs = 1000) {
  return new EventDeliveryCoordinator({ events, principal: coordinatorPrincipal(targetRefs, [OWNER_SCOPE]), handlers, agentTargets,
    handlerTimeoutMs: timeoutMs, retryDelayMs: 0 });
}
