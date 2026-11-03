import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { GoalSessionAdapter, CORE_GOAL_PRESET_ID, CORE_MODEL_PROBE_PROMPT, type CoreDecisionEventToolFactory,
  type GoalAuthorityContext, type GoalAuthorityVerdict, type GoalBinding, type GoalBindingPort,
  type GoalCommandReceipt, type GoalCreateRequest, type NativeGoalRef, type NativeGoalView, goalCommandIdentity } from '../src/adapters/dsh/goals.js';
import type { DshAgent, DshAgentContext, DshContext, DshSession, SessionEvent } from '../src/adapters/dsh/sessions.js';
import { nativeMessageHash, type NativeMessageInput, type NativeUserMessage } from '../src/adapters/dsh/native-message.js';
import { createCoreEventTools, CORE_EVENT_TOOL_NAMES } from '../src/adapters/dsh/event-tools.js';
import { LocalCoreService, summarizeCoreDecisionAccounting } from '../src/control/local-core.js';
import { eventStore, readerPrincipal } from './events-fixtures.js';

// Native lifecycle/protocol double only: no installed DSH, network or model call.
// The ordering intentionally matches native claim -> pre-step -> request ->
// user/message -> global llm/stream -> assistant/message -> turn/end.
type Hook = (...args: any[]) => any;
class Hooks {
  listeners = new Map<string, Hook[]>();
  on(name: string, handler: Hook) {
    const list = this.listeners.get(name) ?? []; list.push(handler); this.listeners.set(name, list);
    return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
  }
  emit(name: string, ...args: any[]) { for (const hook of [...this.listeners.get(name) ?? []]) hook(...args); }
  waterfall(name: string, args: unknown[], terminal: () => any): any {
    const hooks = [...this.listeners.get(name) ?? []]; let index = 0;
    const next = (): any => index < hooks.length ? hooks[index++]!(...args, next) : terminal();
    return next();
  }
}
const tick = () => new Promise<void>(done => setImmediate(done));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type DecisionRequest = Parameters<GoalSessionAdapter['decisionRound']>[0];
type Accounting = Parameters<DecisionRequest['onAccounting']>[0];
interface Stored {
  header: DshSession['header']; events: SessionEvent[]; durable: SessionEvent[];
  native?: Omit<NativeGoalView, 'activation'>; title?: { title: string; source: { kind: string }; messageSeqs?: number[]; eventSeq?: number };
  inbox: NativeUserMessage[];
}
interface FakeAgent extends DshAgent { hooks: Hooks; guards: Hook[]; activation: 'armed' | 'disarmed'; cancelled: boolean }
type RuntimeContextMessage = { id: string; role: string; content: { type: string; text: string }[];
  source: { kind: string; form: string; sections: { name: string; text: string }[] } };
type ContextFault = 'wrong-cwd' | 'extra-section' | 'forged-kind' | 'duplicate' | 'invalid-uuid' | 'uuid-v1' | 'wrong-form' | 'wrong-wrapper';
const RUNTIME_CONTEXT_PREFIX = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
function fixture(eventTools?: CoreDecisionEventToolFactory) {
  const global = new Hooks(), stored = new Map<string, Stored>(), live = new Map<string, FakeAgent>(), presets = new Set<string>();
  const bindings = new Map<string, GoalBinding>(), commands = new Map<string, GoalCommandReceipt>();
  const capability = Object.freeze({}), checks: GoalAuthorityContext[] = [], accounting: Accounting[] = [], trace: string[] = [];
  const admittedStreams: Record<string, unknown>[] = [];
  const nativeRequests = new WeakSet<object>();
  let allowed = true, expiredGrant = false, createGate: Promise<void> | undefined, streamGate: Promise<void> | undefined;
  let failDispose = false, failFlush = false, readFault: 'throw' | 'user-hash' | 'assistant-seq' | 'context-hash' | undefined;
  let contextFault: { stage: 'prepared' | 'committed'; kind: ContextFault } | undefined;
  let workingDirectory: string | undefined, workingDirectoryAvailable = true;
  const preparedContexts: RuntimeContextMessage[] = [], committedContexts: RuntimeContextMessage[] = [];
  let beforeAuthorize: ((context: GoalAuthorityContext) => void) | undefined;
  let mode: 'normal' | 'retry' | 'compaction' | 'title' | 'anonymous' | 'history' | 'history-update' | 'changed-prestep' | 'mutated-user' | 'extra-user'
    | 'host-context-prestep' | 'host-bad-context-prestep' | 'host-third-input-prestep' = 'normal', output = '{"proposal":"inspect the synthetic evidence"}';
  let messageNumber = 0, creates = 0, resumes = 0, followups = 0, disposals = 0, streams = 0, autoRounds = 0, opens = 0, closes = 0;
  let requests = 0, toolExecutions = 0, goalCalls = 0;
  const archives: string[] = [], toolReturns: unknown[] = [];
  let failArchive = false;
  let toolPlan: undefined | { name: string; args?: Record<string, unknown>; result?: unknown; unknownUsage?: boolean;
    duplicate?: boolean; omitResult?: boolean; skipExecution?: boolean; pauseOnTool?: boolean; secondRound?: boolean };
  const assemblies: { tools: { name: string }[] }[] = [];
  const toolErrors: string[] = [];
  let lastAgent: FakeAgent | undefined;
  const exact = (agent: DshAgent) => { assert.equal(live.get(agent.id), agent); return stored.get(agent.id)!; };
  const currentDirectory = (session: DshSession): string => {
    const value = workingDirectory ?? stored.get(session.id)!.header.cwd; assert.equal(typeof value, 'string'); return value as string;
  };
  const contextMessages = (session: DshSession, stage: 'prepared' | 'committed'): RuntimeContextMessage[] => {
    const record = stored.get(session.id)!, directoryText = `Current working directory: ${JSON.stringify(currentDirectory(session))}.`;
    // The SDK projects again during prepareRequest: only a retained matching
    // snapshot suppresses emission, not the ephemeral pre-step projection.
    const retained = record.events.findLast(event => event.type === 'user/message' && event.data?.source?.kind === 'runtime-context');
    if (retained?.data.source.sections?.length === 1 && retained.data.source.sections[0]?.text === directoryText) return [];
    const message: RuntimeContextMessage = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: `${RUNTIME_CONTEXT_PREFIX}\n\n${directoryText}` }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: directoryText }] } };
    const selected = contextFault?.stage === stage ? contextFault.kind : undefined;
    if (selected === 'wrong-cwd') {
      message.source.sections[0]!.text = 'Current working directory: "/synthetic/foreign".';
      message.content[0]!.text = `${RUNTIME_CONTEXT_PREFIX}\n\n${message.source.sections[0]!.text}`;
    }
    if (selected === 'extra-section') message.source.sections.push({ name: 'unregistered:secret', text: 'Unapproved runtime context' });
    if (selected === 'forged-kind') message.source.kind = 'user';
    if (selected === 'invalid-uuid') message.id = 'native-required-context';
    if (selected === 'uuid-v1') message.id = '11111111-1111-1111-8111-111111111111';
    if (selected === 'wrong-form') message.source.form = 'delta';
    if (selected === 'wrong-wrapper') message.content[0]!.text = directoryText;
    const messages = selected === 'duplicate' ? [message, { ...structuredClone(message), id: randomUUID() }] : [message];
    (stage === 'prepared' ? preparedContexts : committedContexts).push(...structuredClone(messages));
    return messages;
  };
  const append = (agent: FakeAgent, type: string, data: unknown, surfaceOp?: string) => {
    const record = exact(agent), event: SessionEvent = { seq: record.events.length, type, data: structuredClone(data), time: Date.now(), ...(surfaceOp ? { surfaceOp } : {}) };
    record.events.push(event); agent.hooks.emit('session/event', agent.session, event); global.emit('session/event', agent.session, event); return event;
  };
  const native = (agent: DshAgent): NativeGoalView | undefined => {
    const value = exact(agent).native; return value && structuredClone({ ...value, activation: (agent as FakeAgent).activation });
  };
  const schedule = (agent: FakeAgent) => { void Promise.resolve().then(() => { if (agent.activation === 'armed') autoRounds++; }); };
  const mutate = (name: string, agent: FakeAgent, ref: NativeGoalRef, changes: Record<string, unknown>) => {
    const record = exact(agent), prior = record.native!;
    if (!prior || prior.id !== ref.id || prior.revision !== ref.revision) throw new Error('Native Goal revision conflict');
    record.native = { ...prior, ...changes, revision: prior.revision + 1, updatedAt: Date.now() };
    if (name === 'resume') agent.activation = 'armed';
    append(agent, 'goal/change', { goal: record.native }); schedule(agent); return native(agent);
  };
  const goals = {
    get: native,
    disarm(agent: FakeAgent) { exact(agent); agent.activation = 'disarmed'; trace.push('disarm'); return native(agent); },
    create(agent: FakeAgent, input: { objective: string; maxGoalRounds: number }) {
      const record = exact(agent); assert.equal(record.native, undefined);
      record.native = { id: `native-goal-${creates}`, revision: 1, objective: input.objective, phase: 'active', roundsStarted: 0,
        maxGoalRounds: input.maxGoalRounds, createdAt: Date.now(), updatedAt: Date.now() };
      agent.activation = 'armed'; append(agent, 'goal/change', { goal: record.native }); schedule(agent); return native(agent);
    },
    edit: (agent: FakeAgent, ref: NativeGoalRef, changes: Record<string, unknown>) => mutate('edit', agent, ref, changes),
    pause: (agent: FakeAgent, ref: NativeGoalRef) => mutate('pause', agent, ref, { phase: 'paused' }),
    resume: (agent: FakeAgent, ref: NativeGoalRef) => mutate('resume', agent, ref, { phase: 'active' }),
    complete: (agent: FakeAgent, ref: NativeGoalRef) => mutate('complete', agent, ref, { phase: 'complete' }),
  };
  for (const name of ['get', 'create', 'edit', 'pause', 'resume', 'complete', 'disarm'] as const) {
    const original = (goals as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    (goals as unknown as Record<string, (...args: unknown[]) => unknown>)[name] = (...args: unknown[]) => { goalCalls++; return original(...args); };
  }
  function stream(options: Record<string, unknown>): AsyncIterable<unknown> {
    return global.waterfall('llm/stream', [options], () => {
      admittedStreams.push(Object.fromEntries(['sessionId', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'purpose', 'tools'].filter(key => options[key] !== undefined).map(key => [key, options[key]])));
      streams++; trace.push(`stream:${String(options.purpose ?? 'main')}`);
      return (async function* () { if (streamGate) await streamGate; yield { type: 'synthetic' }; })();
    });
  }
  const make = async (options: any, resume: boolean) => {
    if (createGate) await createGate; // Deliberately ignores AbortSignal to test late ownership.
    const id = resume ? options.resumeSessionId : options.sessionId;
    if (resume) { if (!stored.has(id)) throw new Error('Native Session not found'); resumes++; }
    else {
      assert.equal(stored.has(id), false);
      stored.set(id, { header: { version: 4, id, createdAt: 1, isSeeded: false, cwd: options.meta.cwd, agentPreset: options.meta.agentPreset }, events: [], durable: [], inbox: [] });
      creates++;
    }
    const record = stored.get(id)!, hooks = new Hooks(), guards: Hook[] = [], registeredTools = new Map<string, any>();
    const session: DshSession = {
      id, header: record.header, inheritedEventCount: 0,
      get seq() { return record.events.length; },
      append(type, data, appendOptions) { return append(agent, type, data, appendOptions?.surfaceOp); },
    };
    let idle = Promise.resolve(), agent: FakeAgent, maintenance: AbortController | undefined;
    const local: DshAgentContext & { tools: DshAgentContext['tools'] & { register(tool: any): () => void } } = {
      on: (name, handler) => hooks.on(name, handler),
      tools: { schemas: () => [{ name: 'shell' }, { name: 'run_code' }, { name: 'create_goal' }, ...[...registeredTools.values()].map(tool => ({ name: tool.name }))],
        presentAs: () => () => {}, restrict: () => () => {},
        register(tool: any) { assert.equal(registeredTools.has(tool.name), false); registeredTools.set(tool.name, tool); return () => { registeredTools.delete(tool.name); }; },
        guard(handler) { guards.push(handler); return () => { guards.splice(guards.indexOf(handler), 1); }; } },
      systemPrompt: { suppressRuntimeContext: () => () => {}, section: () => () => {},
        assemble: async () => hooks.waterfall('system-prompt/assemble', [{ tools: [{ name: 'shell' }] }, {}], () => ({ tools: [{ name: 'shell' }] })) },
    };
    agent = { id, session, ctx: local, hooks, guards, status: 'idle', activation: 'disarmed', cancelled: false,
      inbox: { get nextTurn() { return record.inbox; }, get nextStep() { return []; }, remove(messageId: string) {
        const index = record.inbox.findIndex(message => message.id === messageId); if (index < 0) return false;
        record.inbox.splice(index, 1); append(agent, 'agent/inbox/spliced', { target: 'next-turn', start: index, removedCount: 1, inserted: [], outcome: 'canceled' }); return true;
      } },
      followup(message) {
        followups++; trace.push('followup'); record.inbox.push(structuredClone(message));
        append(agent, 'agent/inbox/spliced', { target: 'next-turn', start: record.inbox.length - 1, inserted: [message] });
        hooks.emit('agent/inbox/inserted', { message }); agent.status = 'running';
        idle = (async () => {
          try {
            append(agent, 'turn/start', { turn: 1 });
            const claimed = structuredClone(record.inbox); record.inbox.length = 0;
            append(agent, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: claimed.length, inserted: [] });
            // Fixed SDK: working-directory context is required and survives
            // suppressRuntimeContext(); loop preStep appends this snapshot.
            // The fixed host may inject its required working-directory snapshot
            // into the first claimed turn alongside the followup message.
            const preparedContext = mode === 'host-context-prestep' || mode === 'host-bad-context-prestep' || mode === 'host-third-input-prestep'
              ? contextMessages(session, 'prepared') : [];
            if (mode === 'host-bad-context-prestep' && preparedContext[0]) {
              const bad = structuredClone(preparedContext[0]);
              bad.content[0]!.text = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "/synthetic/foreign".';
              bad.source.sections[0]!.text = 'Current working directory: "/synthetic/foreign".';
              preparedContext[0] = bad;
            }
            const firstStepPayload = mode === 'host-third-input-prestep'
              ? [...claimed, ...preparedContext, { id: 'unregistered-third-input', role: 'user', content: [{ type: 'text', text: 'extra hostile input' }], source: { kind: 'user' } }]
              : [...claimed, ...preparedContext];
            const step = await hooks.waterfall('agent/pre-step', [{ messages: firstStepPayload }], () => ({ kind: 'enter', messages: mode === 'changed-prestep' ? [] : firstStepPayload }));
            if (step.kind === 'reject') { append(agent, 'turn/end', { reason: agent.cancelled
              ? { kind: 'aborted', reason: { kind: 'hook', reason: 'Core decision cancelled' } } : { kind: 'blocked' } }); return; }
            const assembly = await local.systemPrompt.assemble({ scope: agent }); assemblies.push(structuredClone(assembly)); if (!eventTools) assert.deepEqual(assembly.tools, []);
            const request = await hooks.waterfall('agent/request', [{}], () => ({ ...options.agentOptions, maxTokens: 99999 }));
            const appended = structuredClone(message);
            if (mode === 'mutated-user') appended.content[0]!.text = 'Outer native hook replaced the approved input';
            append(agent, 'user/message', appended, 'append');
            if (mode === 'extra-user') append(agent, 'user/message', { ...structuredClone(message), id: 'unregistered-outer-notice' }, 'append');
            for (const snapshot of contextMessages(session, 'committed')) append(agent, 'user/message', snapshot, 'append');
            const toolDeclarations = eventTools ? [...registeredTools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) : [];
            const main: any = { ...request, sessionId: id, messages: claimed };
            if (toolDeclarations.length) {
              append(agent, 'developer/message', { message: { id: `developer-${message.id}`, role: 'developer', source: { kind: 'tool-registry' },
                content: toolDeclarations.map(tool => ({ type: 'tool-addition', toolName: tool.name })) } });
              main.tools = structuredClone(toolDeclarations);
            }
            requests++; nativeRequests.add(main);
            if (mode === 'compaction' || mode === 'title') {
              const purpose = mode === 'title' ? 'session-title' : 'compaction';
              append(agent, mode === 'title' ? 'session/title-llm-request' : 'compaction/start', {});
              for await (const _item of stream({ ...main, purpose })) { /* no provider should be reached */ }
            }
            if (mode === 'anonymous') for await (const _item of stream({ ...main })) { /* absent purpose is not official provenance */ }
            if (mode === 'history') main.toolHistory = { tools: [{ name: 'shell' }], updates: [] };
            if (mode === 'history-update') main.toolHistory = { tools: [], updates: [{ additions: [{ name: 'shell' }] }] };
            for await (const _item of stream(main)) { /* native provider stream double */ }
            if (mode === 'retry') {
              append(agent, 'assistant/attempt', { usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 }, reason: 'retry' });
              for await (const _item of stream(main)) { /* second next() must be blocked */ }
            }
            if (!agent.cancelled && !toolPlan) {
              append(agent, 'assistant/message', { message: { id: `assistant-${message.id}`, role: 'assistant', content: [{ type: 'text', text: output }] }, usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } });
            } else if (!agent.cancelled && toolPlan) {
              const callId = `call-${message.id}`;
              const argumentsText = JSON.stringify(toolPlan.args ?? {});
              const usage = toolPlan.unknownUsage ? undefined : { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
              const content = toolPlan.duplicate
                ? [{ type: 'tool-call', id: `${callId}-a`, name: toolPlan.name, arguments: argumentsText },
                   { type: 'tool-call', id: `${callId}-b`, name: toolPlan.name, arguments: argumentsText }]
                : [{ type: 'tool-call', id: callId, name: toolPlan.name, arguments: argumentsText }];
              append(agent, 'assistant/message', { message: { id: `assistant-${message.id}`, role: 'assistant', content }, ...(usage ? { usage } : {}) });
              if (!toolPlan.duplicate) {
                append(agent, 'tool/call', { turn: 1, step: 1, callId, name: toolPlan.name, arguments: argumentsText });
                let returned: unknown;
                if (!toolPlan.skipExecution) {
                  const tool = registeredTools.get(toolPlan.name); assert.ok(tool, 'mounted core event tool is registered');
                  if (toolPlan.pauseOnTool) allowed = false;
                  toolExecutions++;
                  try { returned = await tool.execute(structuredClone(toolPlan.args ?? {}), { signal: new AbortController().signal }); toolReturns.push(structuredClone(returned)); }
                  catch (error) { toolErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); }
                  allowed = true;
                }
                if (!toolPlan.omitResult) append(agent, 'tool/result', { turn: 1, step: 1, message: { id: `tool-result-${message.id}`, role: 'tool',
                  source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(toolPlan.result ?? returned ?? {}) }], isError: false } });
                if (toolPlan.secondRound) {
                  append(agent, 'tool/call', { turn: 1, step: 2, callId: `${callId}-2`, name: toolPlan.name, arguments: argumentsText });
                } else if (!toolPlan.omitResult) {
                  const step2 = await hooks.waterfall('agent/pre-step', [{ messages: [] }], () => ({ kind: 'enter', messages: contextMessages(session, 'prepared') }));
                  if (step2.kind === 'reject') { append(agent, 'turn/end', { reason: { kind: 'blocked' } }); return; }
                  assemblies.push(structuredClone(await local.systemPrompt.assemble({ scope: agent })));
                  const request2 = await hooks.waterfall('agent/request', [{}], () => ({ ...options.agentOptions, maxTokens: 99999 }));
                  requests++;
                  const main2: any = { ...request2, sessionId: id, messages: [], tools: structuredClone(toolDeclarations),
                    toolHistory: { tools: [], updates: [{ additions: toolDeclarations.map(tool => ({ type: 'tool-addition', toolName: tool.name })) }] } };
                  nativeRequests.add(main2);
                  for await (const _item of stream(main2)) { /* native provider stream double */ }
                  append(agent, 'assistant/message', { message: { id: `assistant-final-${message.id}`, role: 'assistant', content: [{ type: 'text', text: output }] }, usage: { inputTokens: 11, outputTokens: 9, totalTokens: 20 } });
                }
              }
            }
            append(agent, 'turn/end', { reason: { kind: agent.cancelled ? 'cancelled' : 'completed' } });
          } catch (error) { append(agent, 'turn/end', { reason: { kind: 'error' }, error: error instanceof Error ? error.message : String(error) }); }
          finally { agent.status = 'idle'; }
        })();
      },
      whenIdle: () => idle,
      async runMaintenance<T>(job: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
        if (maintenance !== undefined) throw new Error('Native Agent already has active work');
        maintenance = new AbortController();
        try { return await job(maintenance.signal); } finally { maintenance = undefined; }
      },
      cancel(_cause, options) { agent.cancelled = true; trace.push('cancel'); if (!options?.keepInbox) record.inbox.length = 0; },
    };
    lastAgent = agent; live.set(id, agent); await options.setup(local, agent); global.emit('agent/created', { agent });
    return { agent, async dispose() { disposals++; trace.push('dispose'); if (failDispose) throw new Error('Native disposal failed'); await idle; record.inbox.length = 0; live.delete(id); } };
  };
  const ctx: DshContext = {
    on: (name, handler) => global.on(name, handler), agents: { create: options => make(options, false), resume: options => make(options, true), list: () => [...live.values()] },
    get(name) {
      if (name === 'goals') return goals;
      if (name === 'workingDirectory') return workingDirectoryAvailable ? { get: currentDirectory } : undefined;
      if (name === 'llm') return { resolveCallConfig: async (value: unknown) => structuredClone(value), stream };
      if (name === 'agentPresets') return { register(value: { id: string }) { assert.equal(presets.has(value.id), false); presets.add(value.id); return () => { presets.delete(value.id); }; } };
      if (name === 'sessions') return {
        async flush(session: DshSession) { trace.push('flush'); if (failFlush) throw new Error('Native flush failed'); const record = stored.get(session.id)!; record.durable = structuredClone(record.events); return true; },
        get(id: string) { return live.get(id)?.session; },
      };
      if (name === 'workspaceRegistry') return {
        async archiveSession(id: string) { if (failArchive) throw new Error('Native archive failed'); archives.push(id); },
      };
      if (name === 'sessionTitle') return {
        get: (session: DshSession) => { const value = stored.get(session.id)?.title; return value && structuredClone(value); },
        rename(session: DshSession, title: string) {
          const agent = live.get(session.id)!;
          const event = append(agent, 'session/title', { title, messageSeqs: [], source: { kind: 'user' } });
          const result = { title, source: { kind: 'user' }, messageSeqs: [], eventSeq: event.seq };
          stored.get(session.id)!.title = structuredClone(result); return result;
        },
      };
      if (name === 'sessionPersistence') return { async open(sessionId: string, mode: string) {
        assert.equal(mode, 'read'); const record = stored.get(sessionId); if (!record) throw new Error('Native Session not found'); opens++;
        return { header: structuredClone(record.header), inheritedEventCount: 0, async read(offset: number, count: number) {
          if (readFault === 'throw') throw new Error('Native read failed');
          const events = structuredClone(record.durable.slice(offset, offset + count));
          if (count === 1 && events[0]?.type === 'user/message' && readFault === 'user-hash') events[0].data.content[0].text = 'changed durable body';
          if (count === 1 && events[0]?.type === 'user/message' && events[0].data.source?.kind === 'runtime-context' && readFault === 'context-hash') events[0].data.content[0].text = 'changed durable context';
          if (count === 1 && events[0]?.type === 'assistant/message' && readFault === 'assistant-seq') events[0].seq = events[0].seq! + 1;
          return { events, eventState: 'detached' };
        }, async close() { closes++; } };
      } };
      if (name === 'sessionProjections') return { async restore(_context: unknown, events: SessionEvent[], baseSeq: number) {
        const inbox: NativeUserMessage[] = [];
        events.forEach((event, index) => {
          if (event.seq !== baseSeq + index) throw new Error('Native projection cannot restore across a missing seq');
          if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn') inbox.splice(event.data.start, event.data.removedCount, ...event.data.inserted);
        });
        return { snapshot: { asOfSeq: events.at(-1)?.seq ?? baseSeq - 1, values: { inbox: { 'next-turn': inbox, 'next-step': [] } } } };
      } };
    },
  };
  const port: GoalBindingPort = {
    async load(goalId) { const value = bindings.get(goalId); return value && structuredClone(value); },
    async loadCommand(goalId, commandId) { const value = commands.get(JSON.stringify([goalId, commandId])); return value && structuredClone(value); },
    async compareAndSet(expected, binding) {
      assert.equal(bindings.get(binding.goalId)?.metadataVersion, expected);
      const receipt = binding.receipt, key = receipt && JSON.stringify([binding.goalId, receipt.commandId]), prior = key && commands.get(key);
      if (prior && receipt) assert.equal(goalCommandIdentity(prior), goalCommandIdentity(receipt));
      bindings.set(binding.goalId, structuredClone(binding)); if (key && receipt) commands.set(key, structuredClone(receipt));
    },
  };
  const authority = { async authorize(given: object, context: GoalAuthorityContext): Promise<GoalAuthorityVerdict> {
    checks.push(structuredClone(context)); beforeAuthorize?.(context);
    if (!allowed || given !== capability) return { allowed: false };
    return { allowed: true, kind: 'owner', ownerId: 'owner-1', scope: 'local-owner', expiresAt: new Date(Date.now() + (expiredGrant ? -1 : 60000)).toISOString() };
  } };
  const adapter = (namespace: 'core' | 'lifecycle' = 'core') => new GoalSessionAdapter({ ctx, bindings: port, authority, namespace,
    ...(eventTools ? { eventTools } : {}),
    isAgentLoopRequest: (request: unknown) => request !== null && typeof request === 'object' && nativeRequests.has(request),
    createUserMessage: (input: NativeMessageInput) => ({ ...structuredClone(input), role: 'user', id: `core-user-${++messageNumber}` }) });
  const create: GoalCreateRequest = { goalId: 'core-goal-a', ownerId: 'owner-1', scope: 'local-owner', cwd: '/synthetic/shiyu/core',
    completionCriteriaHash: 'a'.repeat(64), objective: 'Plan using approved synthetic evidence', commandId: 'create-a', capability };
  const decision = (ref: NativeGoalRef, patch: Partial<DecisionRequest> = {}): DecisionRequest => ({ goalId: create.goalId, expectedRef: ref,
    roundId: `decision-${accounting.length + 1}`, capability, prompt: 'Only propose the next check for the synthetic goal.', deadlineAtMs: Date.now() + 30000, maxTokens: 512,
    async onDispatch() { trace.push('dispatch-receipt'); }, async onContextDurable() { trace.push('context-receipt'); },
    async onAccounting(value) { accounting.push(structuredClone(value)); }, ...patch });
  return { ctx, stored, live, presets, bindings, commands, checks, accounting, trace, capability, create, decision, adapter, stream, admittedStreams, preparedContexts, committedContexts, assemblies, toolErrors,
    counts: () => ({ creates, resumes, followups, disposals, streams, requests, autoRounds, opens, closes, toolExecutions, goalCalls }),
    archives, toolReturns, agent: () => lastAgent!,
    async drain() { for (const [id, agent] of [...live]) { try { agent.cancel({ kind: 'hook', reason: 'fixture drain' }, { keepInbox: true }); } catch { /* fixture teardown */ } live.delete(id); record: void id; } },
    setToolPlan(value: typeof toolPlan) { toolPlan = value; },
    setFailArchive(value: boolean) { failArchive = value; },
    setAllowed(value: boolean) { allowed = value; }, setExpired(value: boolean) { expiredGrant = value; }, setMode(value: typeof mode) { mode = value; },
    setOutput(value: string) { output = value; }, setReadFault(value: typeof readFault) { readFault = value; }, setFlushFault(value: boolean) { failFlush = value; },
    setDisposeFault(value: boolean) { failDispose = value; }, setCreateGate(value: Promise<void> | undefined) { createGate = value; }, setStreamGate(value: Promise<void>) { streamGate = value; },
    beforeAuthorize(value: typeof beforeAuthorize) { beforeAuthorize = value; },
    setContextFault(stage: 'prepared' | 'committed', kind: ContextFault) { contextFault = { stage, kind }; },
    setWorkingDirectory(value: string | undefined) { workingDirectory = value; }, setWorkingDirectoryAvailable(value: boolean) { workingDirectoryAvailable = value; },
    insertForeign(sessionId: string, durable = true) {
      const record = stored.get(sessionId)!, message: NativeUserMessage = { id: 'foreign-message', role: 'user', content: [{ type: 'text', text: 'Unregistered input' }], source: { kind: 'user' } };
      record.inbox.push(message); const event: SessionEvent = { type: 'agent/inbox/spliced', seq: record.events.length, data: { target: 'next-turn', start: record.inbox.length - 1, removedCount: 0, inserted: [message] } };
      record.events.push(event); if (durable) record.durable = structuredClone(record.events);
      live.get(sessionId)?.hooks.emit('agent/inbox/inserted', { message });
    },
  };
}

// ---------------------------------------------------------------------------
// H2c tests: restricted core event tools in the permitted decision Session.
// ---------------------------------------------------------------------------
import type { CoreDecisionEventTools, CoreDecisionEventToolSchema } from '../src/adapters/dsh/goals.js';
import type { EventPrincipal } from '../src/contracts/events.js';

const ref = (value?: NativeGoalView): NativeGoalRef => { assert.ok(value); return { id: value.id, revision: value.revision }; };
const CORE_PRINCIPAL = (goalId = 'core-goal-a', scope = 'local-owner'): EventPrincipal => ({ principalId: `core:${goalId}`, kind: 'agent',
  scopes: [scope], publishTypes: ['agent.observation.reported'], subscribeTypes: [], targetRefs: [] });
const PLAN_OUTPUT = JSON.stringify({ kind: 'plan_candidate', plan: { basePlanVersion: 0, summary: 'synthetic plan', reasoningRefs: [],
  stopConditions: { onStepFailure: 'stop', maxFailedSteps: 0, onFactConflict: 'wait', maxParallelSteps: 1 },
  steps: [{ stepId: 'step-a', deliverableId: 'deliverable-a', dependsOn: [], requiredFacts: [], expectedArtifact: { kind: 'local-note', verifier: 'artifact.sha256.v1' } }] } });
const SCHEMAS: readonly CoreDecisionEventToolSchema[] = Object.freeze([
  { name: 'shiyu_core_event_types', description: 'Read-only: list currently visible event types with schema version, payload fields, filterable fields, scope and whether this round may publish or subscribe. This grants no authority. At most one event-tool call is allowed this round; you must still return one final JSON candidate.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'shiyu_core_event_subscriptions', description: 'Read-only: list this core Agent identity’s existing event subscriptions, their owner-scope revisions/activation generations and recent delivery references. Creating or changing subscriptions is not available in this round.', parameters: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'shiyu_core_event_report', description: 'Publish one scoped observation for this goal as untrusted reported data. Actor, scope, source trust level and allowed type are injected by the trusted runtime and cannot be supplied in arguments. Reserved success facts, verification receipts, owner authorization and accounting facts are rejected. Acceptance is not task completion. At most one event-tool call is allowed this round; you must still return one final JSON candidate.', parameters: { type: 'object', properties: { type: { type: 'string' }, payload: { type: 'object' }, idempotencyKey: { type: 'string' }, correlationId: { type: 'string' } }, required: ['type', 'payload', 'idempotencyKey'], additionalProperties: false } },
]);
function testProvider(log: { name: string; args: unknown; context: unknown }[], result: unknown = { readOnly: true, types: [] }): CoreDecisionEventTools {
  return { names: () => [...CORE_EVENT_TOOL_NAMES], schemas: () => SCHEMAS,
    async execute(name, args, context) {
      log.push(structuredClone({ name, args, context }));
      if (args && typeof args === 'object' && Object.keys(args).some(key => ['scope', 'actor', 'permit', 'taskId', 'ownerId', 'kind'].includes(key))) {
        throw Object.assign(new Error('Tool arguments cannot carry authority'), { code: 'INVALID_INPUT' });
      }
      return structuredClone(result) as Record<string, unknown>;
    } };
}
const realProvider = (events: any, wake?: () => void): CoreDecisionEventToolFactory => binding => createCoreEventTools({ service: events,
  principal: CORE_PRINCIPAL(binding.goalId, binding.scope), ...(wake ? { onPublished: () => wake() } : {}) });
const authorityFields = (value: unknown, found = new Set<string>()): string[] => {
  const authority = new Set(['actor', 'principal', 'principalId', 'kind', 'permit', 'scope', 'taskId', 'assignmentId', 'hostEpoch',
    'installationGeneration', 'fencingToken', 'leaseExpiresAt', 'authorization', 'ownerId', 'grant', 'mandate', 'budget', 'targetRefs']);
  const walk = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { for (const entry of item) walk(entry); return; }
    const source = item as Record<string, unknown>;
    if (source.properties && typeof source.properties === 'object') for (const [key, child] of Object.entries(source.properties as Record<string, unknown>)) { if (authority.has(key)) found.add(key); walk(child); }
    for (const key of ['items', 'additionalProperties', 'oneOf'] as const) if (source[key] !== undefined) walk(source[key]);
  };
  walk(value);
  return [...found].sort();
};

test('core event tool provider is discoverable, read-only and bound to the host-injected identity', async t => {
  const f = await eventStore(t, []);
  const published: unknown[] = [];
  const provider = createCoreEventTools({ service: f.events, principal: CORE_PRINCIPAL(),
    onPublished: receipt => published.push(receipt) });
  assert.deepEqual(provider.names(), [...CORE_EVENT_TOOL_NAMES]);
  for (const schema of provider.schemas()) {
    assert.equal(schema.parameters.type, 'object');
    assert.deepEqual(authorityFields(schema.parameters), []);
  }
  const before = await f.events.stats(readerPrincipal());
  const types: any = await provider.execute('shiyu_core_event_types', {}, { signal: new AbortController().signal, goalId: 'core-goal-a', sessionId: 'shiyu-core-goal-a', roundId: 'round-1' });
  assert.equal(types.scope, 'local-owner');
  assert.equal(types.toolsEnabled, true);
  assert.deepEqual(types.canPublish, ['agent.observation.reported']);
  assert.equal(types.types.some((type: any) => type.type === 'task.succeeded'), false, 'reserved success facts are not discoverable as publishable');
  const subs: any = await provider.execute('shiyu_core_event_subscriptions', { limit: 5 }, { signal: new AbortController().signal, goalId: 'core-goal-a', sessionId: 'shiyu-core-goal-a', roundId: 'round-1' });
  assert.equal(subs.readOnly, true);
  assert.deepEqual(subs.subscriptions, []);
  assert.equal(subs.note.includes('neither acknowledges'), true);
  assert.deepEqual(await f.events.stats(readerPrincipal()), before, 'read-only tools never change the event ledger');
  const receipt: any = await provider.execute('shiyu_core_event_report', { type: 'agent.observation.reported', payload: { message: 'synthetic observation' }, idempotencyKey: 'core-report-1' },
    { signal: new AbortController().signal, goalId: 'core-goal-a', sessionId: 'shiyu-core-goal-a', roundId: 'round-1' });
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.scope, 'local-owner');
  assert.match(receipt.meaning, /not task completion/);
  assert.equal(published.length, 1);
  const events = await f.events.listEvents(readerPrincipal());
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor.principalId, 'core:core-goal-a');
  assert.equal(events[0]!.actor.kind, 'agent');
  assert.equal(events[0]!.correlationId, 'core:core-goal-a');
  const duplicate: any = await provider.execute('shiyu_core_event_report', { type: 'agent.observation.reported', payload: { message: 'synthetic observation' }, idempotencyKey: 'core-report-1' },
    { signal: new AbortController().signal, goalId: 'core-goal-a', sessionId: 'shiyu-core-goal-a', roundId: 'round-2' });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.eventId, receipt.eventId);
  assert.equal((await f.events.listEvents(readerPrincipal())).length, 1);
});

test('core event tools reject reserved facts, ungranted types, forged authority and programme-owned publishers', async t => {
  const f = await eventStore(t, []);
  const provider = createCoreEventTools({ service: f.events, principal: CORE_PRINCIPAL() });
  const context = { signal: new AbortController().signal, goalId: 'core-goal-a', sessionId: 'shiyu-core-goal-a', roundId: 'round-deny' };
  for (const args of [
    { type: 'task.succeeded', payload: { taskId: 'task-1' }, idempotencyKey: 'reserved-1' },
    { type: 'component.observation.reported', payload: { message: 'x' }, idempotencyKey: 'foreign-1' },
    { type: 'agent.observation.reported', payload: { message: 'x' }, idempotencyKey: 'authority-1', scope: 'private' },
    { type: 'agent.observation.reported', payload: { message: 'x' }, idempotencyKey: 'authority-2', actor: { principalId: 'task-service', kind: 'component' } },
    { type: 'agent.observation.reported', payload: { message: 42 }, idempotencyKey: 'payload-1' },
  ]) {
    await assert.rejects(async () => provider.execute('shiyu_core_event_report', args, context), /FORBIDDEN|INVALID|Reserved|limited|Unexpected field|authority|Invalid payload/);
  }
  await assert.rejects(async () => provider.execute('shiyu_core_event_unknown', {}, context), /FORBIDDEN|Unknown core event tool/);
  assert.equal((await f.events.listEvents(readerPrincipal())).length, 0);
  // Overbroad host grants fail closed at construction.
  assert.throws(() => createCoreEventTools({ service: f.events, principal: { ...CORE_PRINCIPAL(), publishTypes: ['task.succeeded'] } }), /reserved|observation/);
  assert.throws(() => createCoreEventTools({ service: f.events, principal: { ...CORE_PRINCIPAL(), targetRefs: ['goal:1'] } }), /subscription target/);
  assert.throws(() => createCoreEventTools({ service: f.events, principal: { ...CORE_PRINCIPAL(), kind: 'component' } }), /Agent identity/);
});

test('H2c accounting helper separates main model calls and tool calls without padding unknown usage', () => {
  const base = { goalId: 'goal', roundId: 'round', sessionId: 'session', dispatchAttempted: true, outcome: 'observed' as const };
  const assistant = (total: number) => ({ type: 'assistant/message', seq: total, usage: { totalTokens: total } });
  const toolCall = { type: 'tool/call', seq: 3 };
  const toolResult = { type: 'tool/result', seq: 4 };
  const single = summarizeCoreDecisionAccounting('eval-1', { ...base, usage: { status: 'reported', totalTokens: 18 },
    modelCalls: 1, mainModelRequests: 1, mainModelStreams: 1, toolCalls: 0, toolResults: 0, nativeObservations: [assistant(18)] });
  assert.equal(single.complete, true); assert.equal(single.tokens, 18); assert.equal(single.calls, 1); assert.equal(single.toolCalls, 0);
  assert.equal(single.evidenceRef, 'native-core-usage:eval-1:main=1:streams=1:tools=0:results=0');

  const withTool = summarizeCoreDecisionAccounting('eval-2', { ...base, usage: { status: 'reported', totalTokens: 38 },
    modelCalls: 2, mainModelRequests: 2, mainModelStreams: 2, toolCalls: 1, toolResults: 1, nativeObservations: [assistant(18), toolCall, toolResult, assistant(20)] });
  assert.equal(withTool.complete, true); assert.equal(withTool.tokens, 38); assert.equal(withTool.calls, 2); assert.equal(withTool.toolCalls, 1);
  assert.equal(withTool.evidenceRef, 'native-core-usage:eval-2:main=2:streams=2:tools=1:results=1');

  const unknown = summarizeCoreDecisionAccounting('eval-3', { ...base, outcome: 'unknown', usage: { status: 'unknown' },
    modelCalls: null, mainModelRequests: 2, mainModelStreams: 2, toolCalls: 1, toolResults: 1, nativeObservations: [assistant(18)] });
  assert.equal(unknown.complete, false); assert.equal(unknown.tokens, undefined); assert.equal(unknown.calls, undefined);
  assert.equal(unknown.toolCalls, 1, 'observed tool count stays visible even when usage is unknown');

  const missingAssistant = summarizeCoreDecisionAccounting('eval-4', { ...base, usage: { status: 'reported', totalTokens: 38 },
    modelCalls: 2, mainModelRequests: 2, mainModelStreams: 2, toolCalls: 1, toolResults: 1, nativeObservations: [assistant(18), toolCall] });
  assert.equal(missingAssistant.complete, false, 'a missing main assistant observation cannot be complete');
  const toolWithoutRound = summarizeCoreDecisionAccounting('eval-5', { ...base, usage: { status: 'reported', totalTokens: 18 },
    modelCalls: 1, mainModelRequests: 1, mainModelStreams: 1, toolCalls: 1, toolResults: 1, nativeObservations: [assistant(18), toolCall, toolResult] });
  assert.equal(toolWithoutRound.complete, false, 'a tool call without its second main request is incomplete');

  const legacy = summarizeCoreDecisionAccounting('eval-legacy', { ...base, usage: { status: 'reported', totalTokens: 18 },
    modelCalls: 1, nativeObservations: [assistant(18)] });
  assert.equal(legacy.complete, true, 'H1 adapter-shaped accounting keeps its historical single-request rule');
  assert.equal(legacy.toolCalls, null);
});

test('a core decision mounts exactly the three restricted event tools and completes a types -> plan_candidate round', async t => {
  const f = await eventStore(t, []);
  const wake: number[] = [];
  const calls: { name: string; args: unknown; context: any }[] = [];
  const providerFactory: CoreDecisionEventToolFactory = binding => {
    const real = createCoreEventTools({ service: f.events, principal: CORE_PRINCIPAL(binding.goalId, binding.scope), onPublished: () => wake.push(1) });
    return { names: () => real.names(), schemas: () => real.schemas(), async execute(name, args, context) {
      calls.push({ name, args, context });
      return (await real.execute(name, args, context)) as Record<string, unknown>;
    } };
  };
  const host = fixture(providerFactory), driver = host.adapter();
  try {
    const created = await driver.create(host.create);
    host.setToolPlan({ name: 'shiyu_core_event_types', args: {}, result: { readOnly: true, types: [] } });
    host.setOutput(PLAN_OUTPUT);
    const result = await driver.decisionRound(host.decision(ref(created.native)));
    assert.equal(result.text, PLAN_OUTPUT);
    assert.equal(result.verified, false);
    assert.equal(result.modelCalls, 2);
    assert.equal(result.mainModelRequests, 2);
    assert.equal(result.mainModelStreams, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.toolResults, 1);
    assert.deepEqual(host.counts().toolExecutions, 1);
    assert.deepEqual(host.counts().requests, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, 'shiyu_core_event_types');
    assert.equal(calls[0]!.context.goalId, 'core-goal-a');
    assert.equal(calls[0]!.context.sessionId, created.binding.sessionId);
    assert.equal(calls[0]!.context.roundId, host.decision(ref(created.native)).roundId === 'never' ? '' : calls[0]!.context.roundId);
    assert.match(String(calls[0]!.context.roundId), /^decision-/);
    // Mounted surface: exactly the three trusted read-only schemas, never host tools.
    for (const assembly of host.assemblies) assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [...CORE_EVENT_TOOL_NAMES].sort());
    // Admitted streams: first request declares the same tools; the bounded
    // second request uses the remaining output budget (512 - 7 = 505).
    assert.deepEqual(host.admittedStreams.map(stream => stream.maxTokens), [512, 505]);
    for (const stream of host.admittedStreams) assert.deepEqual((stream.tools as any[]).map(tool => tool.name).sort(), [...CORE_EVENT_TOOL_NAMES].sort());
    const accounting = host.accounting[0]!;
    assert.equal(accounting.outcome, 'observed');
    assert.equal(accounting.mainModelRequests, 2);
    assert.equal(accounting.mainModelStreams, 2);
    assert.equal(accounting.toolCalls, 1);
    assert.equal(accounting.toolResults, 1);
    assert.deepEqual([...accounting.toolNames!].sort(), [...CORE_EVENT_TOOL_NAMES].sort());
    assert.equal(accounting.usage.status, 'reported');
    assert.equal(accounting.usage.totalTokens, 38);
    assert.equal(accounting.modelCalls, 2);
    assert.ok(accounting.nativeObservations.filter(item => item.type === 'assistant/message').length === 2);
    assert.ok(accounting.nativeObservations.some(item => item.type === 'tool/call'));
    assert.ok(accounting.nativeObservations.some(item => item.type === 'tool/result'));
    // The plan candidate is still only text: no Task/Goal-native fact was created.
    const record = host.stored.get(created.binding.sessionId)!;
    assert.equal(record.native!.roundsStarted, 0);
    assert.equal(record.native!.revision, created.native!.revision);
    assert.equal((await f.events.listEvents(readerPrincipal())).length, 0, 'types query publishes nothing');
  } finally { await driver.close(); }
});

test('the mounted event tools stay optional: an unused tool surface keeps the historical single-request path', async t => {
  const f = await eventStore(t, []);
  const host = fixture(realProvider(f.events)), driver = host.adapter();
  try {
    const created = await driver.create(host.create);
    host.setOutput(PLAN_OUTPUT);
    const result = await driver.decisionRound(host.decision(ref(created.native)));
    assert.equal(result.modelCalls, 1); assert.equal(result.mainModelRequests, 1); assert.equal(result.mainModelStreams, 1);
    assert.equal(result.toolCalls, 0); assert.equal(result.toolResults, 0);
    assert.equal(host.counts().requests, 1); assert.equal(host.counts().streams, 1); assert.equal(host.counts().toolExecutions, 0);
    for (const assembly of host.assemblies) assert.equal(assembly.tools.length, CORE_EVENT_TOOL_NAMES.length);
    assert.deepEqual(host.admittedStreams.map(stream => stream.maxTokens), [512]);
    const accounting = host.accounting[0]!;
    assert.equal(accounting.mainModelRequests, 1); assert.equal(accounting.toolCalls, 0);
    assert.equal(accounting.usage.totalTokens, 18); assert.equal(accounting.modelCalls, 1);
    const summary = summarizeCoreDecisionAccounting('no-tool', accounting);
    assert.equal(summary.complete, true); assert.equal(summary.toolCalls, 0);
  } finally { await driver.close(); }
});

test('a real mounted provider publishes only a scoped observation and cannot produce authoritative facts', async t => {
  const f = await eventStore(t, []);
  const host = fixture(realProvider(f.events)), driver = host.adapter();
  try {
    const created = await driver.create(host.create);
    host.setToolPlan({ name: 'shiyu_core_event_report', args: { type: 'agent.observation.reported', payload: { message: 'core observed synthetic evidence' }, idempotencyKey: 'e2e-report-1' },
      result: { status: 'accepted', meaning: 'observation only' } });
    host.setOutput(PLAN_OUTPUT);
    const result = await driver.decisionRound(host.decision(ref(created.native)));
    assert.equal(result.verified, false);
    const events = await f.events.listEvents(readerPrincipal());
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'agent.observation.reported');
    assert.equal(events[0]!.actor.principalId, 'core:core-goal-a');
    assert.equal(events[0]!.scope, 'local-owner');
    assert.equal(events.some(event => event.type === 'task.succeeded'), false);
    // The tool result can claim anything; the program still returns only the
    // final candidate text and verifies nothing by itself.
    const accounting = host.accounting[0]!;
    assert.equal(accounting.toolCalls, 1); assert.equal(accounting.usage.totalTokens, 38);
  } finally { await driver.close(); }
});

test('the one tool-round budget rejects duplicate calls, a second tool round and malformed tool step input', async t => {
  for (const [plan, expected] of [
    [{ name: 'shiyu_core_event_types', duplicate: true }, /tool call/],
    [{ name: 'shiyu_core_event_types', secondRound: true }, /tool call|more than one tool/],
  ] as const) {
    const f = await eventStore(t, []);
    const calls: { name: string; args: unknown; context: any }[] = [];
    const host = fixture(() => testProvider(calls)), driver = host.adapter();
    try {
      const created = await driver.create(host.create);
      host.setToolPlan(plan as any); host.setOutput(PLAN_OUTPUT);
      await assert.rejects(driver.decisionRound(host.decision(ref(created.native))), expected);
      assert.equal(calls.length, (plan as any).secondRound ? 1 : 0, 'a second round/call never executes another provider call');
      assert.equal(host.counts().streams, 1);
      assert.equal(host.accounting[0]!.outcome, 'unknown');
      assert.equal(host.accounting[0]!.modelCalls, null);
    } finally { await driver.close(); }
  }
});

test('unknown tool-round usage is recorded as unknown, never zero-padded, and blocks the second request', async t => {
  const f = await eventStore(t, []);
  const calls: { name: string; args: unknown; context: any }[] = [];
  const host = fixture(() => testProvider(calls)), driver = host.adapter();
  try {
    const created = await driver.create(host.create);
    host.setToolPlan({ name: 'shiyu_core_event_types', unknownUsage: true }); host.setOutput(PLAN_OUTPUT);
    await assert.rejects(driver.decisionRound(host.decision(ref(created.native))), /usage is unknown/);
    assert.equal(host.counts().streams, 1);
    assert.equal(host.counts().requests, 1);
    assert.equal(calls.length, 1);
    const accounting = host.accounting[0]!;
    assert.equal(accounting.outcome, 'unknown');
    assert.equal(accounting.usage.status, 'unknown');
    assert.equal(accounting.usage.totalTokens, undefined, 'missing usage must not become zero tokens');
    assert.equal(accounting.modelCalls, null, 'unknown main coverage must not be reported as a zero call count');
    assert.equal(accounting.mainModelRequests, 1);
    assert.ok(accounting.toolCalls === 1 && accounting.toolResults === 1);
    const summary = summarizeCoreDecisionAccounting('unknown-usage', accounting);
    assert.equal(summary.complete, false); assert.equal(summary.tokens, undefined); assert.equal(summary.calls, undefined);
  } finally { await driver.close(); }
});

test('a revoked or paused core tool call is denied before provider execution and leaves no accepted event', async t => {
  const f = await eventStore(t, []);
  const calls: { name: string; args: unknown; context: any }[] = [];
  const host = fixture(() => testProvider(calls)), driver = host.adapter();
  try {
    const created = await driver.create(host.create);
    host.setToolPlan({ name: 'shiyu_core_event_types', pauseOnTool: true }); host.setOutput(PLAN_OUTPUT);
    await assert.rejects(driver.decisionRound(host.decision(ref(created.native))));
    assert.equal(calls.length, 0, 'a revoked authority check blocks the tool before its provider executes');
    assert.equal(host.counts().streams, 1);
    assert.equal(host.accounting[0]!.outcome, 'unknown');
    assert.equal((await f.events.listEvents(readerPrincipal())).length, 0);
  } finally { await driver.close(); }
});

test('authority-looking tool arguments and reserved report types are refused by the mounted surface', async t => {
  for (const plan of [
    { name: 'shiyu_core_event_types', args: { scope: 'private' } },
    { name: 'shiyu_core_event_report', args: { type: 'task.succeeded', payload: { taskId: 'task-1' }, idempotencyKey: 'bad-1' } },
    { name: 'shiyu_core_event_report', args: { type: 'agent.observation.reported', payload: { message: 'x' }, idempotencyKey: 'bad-2', permit: { fencingToken: 9 } } },
  ] as const) {
    const f = await eventStore(t, []);
    const host = fixture(realProvider(f.events)), driver = host.adapter();
    try {
      const created = await driver.create(host.create);
      host.setToolPlan(plan as any); host.setOutput(PLAN_OUTPUT);
      await assert.rejects(driver.decisionRound(host.decision(ref(created.native))), /authority|FORBIDDEN|Reserved|INVALID/);
      assert.equal((await f.events.listEvents(readerPrincipal())).length, 0);
      assert.equal(host.accounting[0]!.outcome, 'unknown');
    } finally { await driver.close(); }
  }
});

test('an overbroad mounted provider is rejected before dispatch, preserving the zero-tool fallback', async t => {
  const f = await eventStore(t, []);
  const overbroad: CoreDecisionEventToolFactory = () => ({ names: () => [...CORE_EVENT_TOOL_NAMES],
    schemas: () => SCHEMAS.map((schema, index) => index === 0 ? { ...schema, parameters: { type: 'object', properties: { taskId: { type: 'string' } }, additionalProperties: false } } : schema),
    execute: async () => ({}) });
  const host = fixture(overbroad), driver = host.adapter();
  try {
    const created = await driver.create(host.create);
    await assert.rejects(driver.decisionRound(host.decision(ref(created.native))), /authority fields/);
    assert.equal(host.counts().followups, 0);
    assert.equal(host.counts().streams, 0);
    assert.equal(host.accounting[0]!.dispatchAttempted, false);
  } finally { await driver.close(); }
  // No factory means the historical H1 zero-tool decision remains fully usable.
  const legacy = fixture(), legacyDriver = legacy.adapter();
  try {
    const created = await legacyDriver.create(legacy.create);
    legacy.setOutput(PLAN_OUTPUT);
    const result = await legacyDriver.decisionRound(legacy.decision(ref(created.native)));
    assert.equal(result.modelCalls, 1); assert.equal(result.toolCalls, 0);
    assert.deepEqual(legacy.assemblies[0]!.tools, []);
    assert.equal(legacy.checks.every(check => check.phase !== 'tool'), true);
  } finally { await legacyDriver.close(); }
});

// ---------------------------------------------------------------------------
// H2c zero-model mount probe: proves the restricted core tool surface without a
// Goal command, model call, tool execution or business Session.
// ---------------------------------------------------------------------------
test('zero-model probe assembles the three core event tools through the same trusted path and releases', async t => {
  const f = await eventStore(t, []);
  const host = fixture(realProvider(f.events)), adapter = host.adapter();
  try {
    const probe = await adapter.probeCoreDecisionEventTools(realProvider(f.events), { cwd: '/synthetic/shiyu/core', scope: 'local-owner' });
    assert.equal(probe.ok, true);
    assert.equal(probe.preset, CORE_GOAL_PRESET_ID);
    assert.ok(probe.probeSessionId.startsWith('shiyu-core-probe-'));
    assert.deepEqual(probe.tools.map(tool => tool.name).sort(), [...CORE_EVENT_TOOL_NAMES].sort());
    for (const tool of probe.tools) {
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.parameters.additionalProperties, false);
      assert.ok(tool.description.length > 20);
    }
    assert.ok(probe.hostTools.includes('shell') && probe.hostTools.includes('network') === false);
    assert.deepEqual(probe.tools.map(tool => tool.name).filter(name => probe.hostTools.includes(name)), []);
    assert.deepEqual(probe.authorityFields, []);
    assert.deepEqual(probe.counters, { modelRequests: 0, modelStreams: 0, assistantMessages: 0, userMessages: 0, toolEvents: 0, usageEvents: 0 });
    assert.equal(probe.released, true); assert.equal(probe.disposed, true);
    assert.equal(host.counts().followups, 0); assert.equal(host.counts().toolExecutions, 0);
    assert.equal((await f.events.stats(readerPrincipal())).events, 0, 'the probe publishes nothing');
    assert.equal(host.bindings.size, 0, 'the probe never creates a Goal binding');
    const sessions = host.stored.get(probe.probeSessionId)!;
    assert.equal(sessions.events.filter(event => /^(?:user\/message|assistant\/|tool\/|turn\/)/u.test(event.type)).length, 0);
  } finally { await adapter.close(); }
});

test('zero-model probe fails closed on a missing/overbroad provider and on disposal failure', async t => {
  const f = await eventStore(t, []);
  const host = fixture(realProvider(f.events));
  const adapter = host.adapter();
  try {
    await assert.rejects(adapter.probeCoreDecisionEventTools(undefined), /trusted event tool factory/);
    const overbroad: CoreDecisionEventToolFactory = () => ({ names: () => [...CORE_EVENT_TOOL_NAMES],
      schemas: () => SCHEMAS.map((schema, index) => index === 2 ? { ...schema, parameters: { type: 'object', properties: { scope: { type: 'string' } }, additionalProperties: false } } : schema),
      execute: async () => ({}) });
    await assert.rejects(adapter.probeCoreDecisionEventTools(overbroad, { cwd: '/synthetic/shiyu/core' }), /authority fields/);
    assert.equal(host.counts().creates, 0);
  } finally { await adapter.close(); }
  const failing = fixture(realProvider(f.events)), failingAdapter = failing.adapter();
  try {
    failing.setDisposeFault(true);
    await assert.rejects(failingAdapter.probeCoreDecisionEventTools(realProvider(f.events), { cwd: '/synthetic/shiyu/core' }), /cleanup failed/);
  } finally { await failingAdapter.close().catch(() => undefined); }
});

test('the core service exposes a zero-model probe that follows existing paused-admission semantics', async () => {
  const factory: CoreDecisionEventToolFactory = () => testProvider([]);
  const calls: unknown[] = [];
  const receipt = { ok: true, preset: CORE_GOAL_PRESET_ID, probeSessionId: 'shiyu-core-probe-synthetic', scope: 'local-owner',
    tools: [], hostTools: [], authorityFields: [], counters: { modelRequests: 0, modelStreams: 0, assistantMessages: 0, userMessages: 0, toolEvents: 0, usageEvents: 0 },
    released: true, disposed: true, observedAt: new Date().toISOString() } as const;
  let allowed = true;
  const adapter = { async initialize() {}, async close() {},
    async probeCoreDecisionEventTools(given: unknown, options?: unknown) { calls.push({ given, options }); return receipt; } };
  const service = new LocalCoreService({ ctx: {} as DshContext, store: {} as any, bindings: {} as any, artifacts: {} as any,
    assertRuntimeAllowed() { if (!allowed) throw new Error('Runtime paused'); }, eventTools: factory, adapterFactory: () => adapter as any });
  try {
    const first = await service.probeCoreEventTools({ cwd: '/synthetic/shiyu/core', scope: 'local-owner' });
    assert.equal(first.ok, true);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as any).given, factory);
    allowed = false;
    await assert.rejects(service.probeCoreEventTools({ cwd: '/synthetic/shiyu/core' }), /paused/);
    assert.equal(calls.length, 1, 'a paused runtime never reaches the native probe');
  } finally { await service.close(); }
});

// ---------------------------------------------------------------------------
// H2c real-model bounded probe: implementation receipt only (the Lead executes
// the one real model round on the fixed host; these tests use the synthetic
// provider/session doubles above and never contact a model or the network).
// ---------------------------------------------------------------------------
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const probeBinding = (goalId = 'probe-core-model-1'): GoalBinding => ({ goalId, sessionId: `shiyu-core-model-probe-${goalId}`,
  ownerId: 'probe', scope: 'local-owner', cwd: '/synthetic/shiyu/core', completionCriteriaHash: '0'.repeat(64), metadataVersion: 1 });
async function visibleTypeCount(f: Awaited<ReturnType<typeof eventStore>>): Promise<number> {
  const provider = realProvider(f.events)(probeBinding());
  assert.ok(provider);
  const value = await provider.execute('shiyu_core_event_types', {}, { signal: new AbortController().signal,
    goalId: 'probe-core-model-1', sessionId: 'probe-session', roundId: 'probe-round' }) as { types?: unknown };
  return Array.isArray(value.types) ? value.types.length : 0;
}
async function probeFixture(t: Parameters<typeof eventStore>[0]) {
  const events = await eventStore(t, []);
  const f = fixture(realProvider(events.events));
  const adapter = f.adapter();
  return { events, f, adapter, typesSeen: await visibleTypeCount(events) };
}

test('bounded real-model probe performs exactly one read-only types round and returns an honest passed receipt', async t => {
  const { events, f, adapter, typesSeen } = await probeFixture(t);
  const before = await events.events.stats(readerPrincipal());
  f.setOutput(JSON.stringify({ ok: true, typesSeen }));
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  try {
    const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', scope: 'local-owner', timeoutMs: 5000 });
    assert.equal(receipt.status, 'passed'); assert.equal(receipt.ok, true); assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_PASSED');
    assert.match(receipt.sessionId, /^shiyu-core-model-probe-/);
    assert.equal(receipt.promptSha256, sha256(CORE_MODEL_PROBE_PROMPT));
    assert.ok(Buffer.byteLength(CORE_MODEL_PROBE_PROMPT) <= 2048);
    assert.equal(CORE_MODEL_PROBE_PROMPT.includes('shiyu_core_event_types'), true);
    assert.equal(CORE_MODEL_PROBE_PROMPT.includes('{{'), false);
    assert.deepEqual({ provider: receipt.provider, model: receipt.model, reasoningEffort: receipt.reasoningEffort },
      { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' });
    assert.equal(receipt.maxTokens, 256);
    assert.deepEqual(receipt.counters, { followups: 1, turns: 1, userMessages: 2, assistantMessages: 2,
      mainModelRequests: 2, mainModelStreams: 2, toolCalls: 1, toolResults: 1 });
    assert.deepEqual(receipt.toolCalls, [{ name: 'shiyu_core_event_types', argumentsSha256: sha256('{}') }]);
    assert.equal(receipt.toolResult!.typesSeen, typesSeen);
    assert.equal(receipt.toolResult!.outcome, 'observed');
    assert.deepEqual(receipt.finalJson, { ok: true, typesSeen });
    assert.equal(receipt.usage.status, 'reported'); assert.equal(receipt.usage.complete, true);
    assert.equal(receipt.usage.totalTokens, 38); assert.equal(receipt.usage.inputTokens, 22); assert.equal(receipt.usage.outputTokens, 16);
    assert.deepEqual({ released: receipt.released, disposed: receipt.disposed, archived: receipt.archived, cleanupVerified: receipt.cleanupVerified },
      { released: true, disposed: true, archived: true, cleanupVerified: true });
    assert.deepEqual(f.archives, [receipt.sessionId]);
    // Exactly one tool execution; no Goal, Task, budget, Effect, authority or event fact.
    assert.equal(f.counts().toolExecutions, 1); assert.equal(f.counts().goalCalls, 0); assert.equal(f.checks.length, 0);
    assert.equal(f.counts().followups, 1); assert.equal(f.counts().disposals, 1); assert.equal(f.counts().toolExecutions, 1);
    assert.equal(f.bindings.size, 0); assert.equal(f.commands.size, 0); assert.equal(f.accounting.length, 0);
    assert.deepEqual(await events.events.stats(readerPrincipal()), before, 'the probe writes no events or business facts');
    assert.equal(f.live.size, 0);
    // The disposable Session log holds only the immutable prompt and the one tool round.
    const stored = f.stored.get(receipt.sessionId)!;
    const userMessages = stored.events.filter(event => event.type === 'user/message');
    assert.equal(userMessages[0]!.data.content[0].text, CORE_MODEL_PROBE_PROMPT);
    assert.equal(stored.header.agentPreset, CORE_GOAL_PRESET_ID);
    assert.equal(stored.events.filter(event => event.type === 'tool/call').length, 1);
    assert.equal(stored.events.filter(event => event.type === 'assistant/message').length, 2);
  } finally { await adapter.close(); }
});

test('the probe reports a model answer that never called the tool as failed without retrying', async t => {
  const { f, adapter, typesSeen } = await probeFixture(t);
  f.setOutput(JSON.stringify({ ok: true, typesSeen }));
  const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
  try {
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.ok, false); assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_NO_TOOL_CALL');
    assert.equal(receipt.counters.mainModelRequests, 1); assert.equal(receipt.counters.mainModelStreams, 1);
    assert.equal(receipt.counters.toolCalls, 0); assert.equal(receipt.counters.toolResults, 0);
    assert.equal(receipt.counters.followups, 1); assert.equal(receipt.cleanupVerified, true);
    assert.equal(f.counts().followups, 1, 'no retry is launched');
    assert.equal(f.counts().requests, 1);
  } finally { await adapter.close(); }
});

test('the probe reports a malformed final answer and a wrong types count as failed', async t => {
  const malformed = await probeFixture(t);
  malformed.f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  malformed.f.setOutput('I observed the tool types but will not return JSON.');
  try {
    const receipt = await malformed.adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_FINAL_JSON_INVALID');
    assert.equal(receipt.counters.toolCalls, 1); assert.equal(receipt.counters.toolResults, 1);
    assert.equal(receipt.cleanupVerified, true);
  } finally { await malformed.adapter.close(); }
  const mismatch = await probeFixture(t);
  mismatch.f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  mismatch.f.setOutput(JSON.stringify({ ok: true, typesSeen: mismatch.typesSeen + 7 }));
  try {
    const receipt = await mismatch.adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_TYPES_COUNT_MISMATCH');
    assert.equal(receipt.toolResult!.typesSeen, mismatch.typesSeen);
    assert.deepEqual(receipt.finalJson, { ok: true, typesSeen: mismatch.typesSeen + 7 });
  } finally { await mismatch.adapter.close(); }
});

test('missing provider usage stays unknown rather than zero and the probe still cleans up', async t => {
  const { f, adapter, typesSeen } = await probeFixture(t);
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {}, unknownUsage: true });
  f.setOutput(JSON.stringify({ ok: true, typesSeen }));
  const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
  try {
    assert.equal(receipt.status, 'unknown'); assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_USAGE_UNKNOWN');
    assert.deepEqual(receipt.usage, { status: 'unknown', complete: false });
    assert.equal(receipt.usage.totalTokens, undefined); assert.equal(receipt.usage.inputTokens, undefined);
    assert.equal(receipt.counters.toolCalls, 1); assert.equal(receipt.counters.toolResults, 1);
    assert.equal(receipt.cleanupVerified, true); assert.deepEqual(f.archives, [receipt.sessionId]);
  } finally { await adapter.close(); }
});

test('cancellation stops the single model round, returns a cancelled receipt and never retries', async t => {
  const { f, adapter } = await probeFixture(t);
  const gate = deferred();
  f.setStreamGate(gate.promise);
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  const controller = new AbortController();
  const pending = adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000, signal: controller.signal });
  try {
    for (let index = 0; index < 200 && f.counts().streams === 0; index++) await tick();
    assert.equal(f.counts().streams, 1);
    controller.abort(new Error('synthetic owner cancellation'));
    gate.resolve();
    const receipt = await pending;
    assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_CANCELLED');
    assert.equal(receipt.ok, false); assert.equal(receipt.counters.mainModelRequests, 1);
    assert.equal(receipt.counters.followups, 1); assert.equal(f.counts().followups, 1, 'cancellation is not retried');
    assert.equal(receipt.cleanupVerified, true);
  } finally { await adapter.close(); }
});

test('a disposable Session cleanup failure is explicit and never reported as success', async t => {
  const { f, adapter } = await probeFixture(t);
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  f.setOutput(JSON.stringify({ ok: true, typesSeen: 0 }));
  f.setDisposeFault(true);
  try {
    await assert.rejects(adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 }), /cleanup failed/);
    assert.equal(f.counts().disposals, 1); assert.deepEqual(f.archives, []);
    assert.equal(f.live.size, 1, 'the fixture double deliberately leaves the native Session for inspection');
  } finally { await f.drain(); await adapter.close(); }
});

test('the probe refuses a non-read-only tool call and writes no event facts', async t => {
  const { events, f, adapter, typesSeen } = await probeFixture(t);
  const before = await events.events.stats(readerPrincipal());
  f.setToolPlan({ name: 'shiyu_core_event_report', args: { type: 'agent.observation.reported', payload: { message: 'synthetic' }, idempotencyKey: 'probe-report-1' } });
  f.setOutput(JSON.stringify({ ok: true, typesSeen }));
  const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
  try {
    assert.equal(receipt.status, 'failed'); assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_PROTOCOL_VIOLATION');
    assert.equal(f.toolErrors.some(error => /bounded probe may execute only the read-only types tool/.test(error)), true);
    assert.deepEqual(await events.events.stats(readerPrincipal()), before, 'a forbidden report call cannot publish an event');
    assert.equal(receipt.cleanupVerified, true);
  } finally { await adapter.close(); }
});

test('an overbroad mounted tool schema is rejected before any probe Session is created', async t => {
  const events = await eventStore(t, []);
  const overbroad: CoreDecisionEventToolFactory = () => ({
    names: () => [...CORE_EVENT_TOOL_NAMES],
    schemas: () => SCHEMAS.map((schema, index) => index === 0
      ? { ...schema, parameters: { type: 'object', properties: { scope: { type: 'string' } }, additionalProperties: false } }
      : schema),
    execute: async () => ({ readOnly: true }),
  });
  const f = fixture(overbroad);
  const adapter = f.adapter();
  try {
    await assert.rejects(adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core' }), /authority fields/);
    assert.equal(f.counts().creates, 0); assert.equal(f.counts().followups, 0);
  } finally { await adapter.close(); }
  void events;
});

test('the probe rejects malformed options and an absent trusted event tool factory before any Session work', async t => {
  const events = await eventStore(t, []);
  const withoutFactory = fixture();
  const noFactoryAdapter = withoutFactory.adapter();
  try {
    await assert.rejects(noFactoryAdapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core' }), /trusted event tool factory/);
    const f = fixture(realProvider(events.events));
    const adapter = f.adapter();
    try {
      for (const invalid of [{ maxTokens: 4096 }, { maxTokens: 257 }, { timeoutMs: 999 }, { timeoutMs: 120001 }, { cwd: 'relative/path' }, { scope: 'bad scope!' }]) {
        await assert.rejects(adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', ...invalid }), /Invalid|must be a normalized/);
      }
      assert.equal(f.counts().creates, 0); assert.equal(f.counts().followups, 0);
    } finally { await adapter.close(); }
  } finally { await noFactoryAdapter.close(); }
});

// ---------------------------------------------------------------------------
// H2c-probe-fix regression: the fixed host injects its required
// working-directory runtime-context snapshot into the first claimed turn even
// with suppressRuntimeContext(); the probe must accept exactly one registered
// prompt plus at most that one exact bound snapshot, and still reject anything
// else before any model request.
// ---------------------------------------------------------------------------
test('a host-injected working-directory snapshot in the first claimed turn is accepted and the round proceeds', async t => {
  const { events, f, adapter, typesSeen } = await probeFixture(t);
  f.setMode('host-context-prestep');
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  f.setOutput(JSON.stringify({ ok: true, typesSeen }));
  const before = await events.events.stats(readerPrincipal());
  try {
    const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
    assert.equal(receipt.status, 'passed', JSON.stringify(receipt));
    assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_PASSED');
    assert.deepEqual(receipt.counters, { followups: 1, turns: 1, userMessages: 2, assistantMessages: 2,
      mainModelRequests: 2, mainModelStreams: 2, toolCalls: 1, toolResults: 1 });
    assert.equal(receipt.cleanupVerified, true);
    assert.deepEqual(await events.events.stats(readerPrincipal()), before);
    assert.equal(f.counts().requests, 2); assert.equal(f.counts().streams, 2); assert.equal(f.counts().toolExecutions, 1);
    assert.deepEqual(f.toolErrors, []);
    assert.equal(f.counts().goalCalls, 0);
    const stored = f.stored.get(receipt.sessionId)!;
    assert.equal(stored.events.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'blocked'), false);
  } finally { await adapter.close(); }
});

test('a wrong host working-directory snapshot is rejected in the first step before any model request', async t => {
  const { f, adapter } = await probeFixture(t);
  f.setMode('host-bad-context-prestep');
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  f.setOutput(JSON.stringify({ ok: true, typesSeen: 0 }));
  try {
    const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_PROTOCOL_VIOLATION');
    assert.deepEqual(receipt.counters, { followups: 1, turns: 1, userMessages: 0, assistantMessages: 0,
      mainModelRequests: 0, mainModelStreams: 0, toolCalls: 0, toolResults: 0 });
    assert.equal(f.counts().requests, 0); assert.equal(f.counts().streams, 0); assert.equal(f.counts().toolExecutions, 0);
    const stored = f.stored.get(receipt.sessionId)!;
    assert.equal(stored.events.some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'blocked'), true);
    assert.equal(stored.events.some(event => event.type === 'user/message'), false);
    assert.equal(receipt.cleanupVerified, true);
    // Bounded diagnostics: the receipt explains why the first step failed and
    // how many host messages were claimed, without leaking the absolute cwd.
    assert.equal(receipt.firstStepMessageCount, 2);
    assert.match(String(receipt.failureDetail), /runtime context/i);
    assert.ok(!String(receipt.failureDetail).includes('/synthetic/shiyu/core'));
  } finally { await adapter.close(); }
});

test('a third native first-step input is rejected before any model request', async t => {
  const { f, adapter } = await probeFixture(t);
  f.setMode('host-third-input-prestep');
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  f.setOutput(JSON.stringify({ ok: true, typesSeen: 0 }));
  try {
    const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.reasonCode, 'CORE_MODEL_PROBE_PROTOCOL_VIOLATION');
    assert.equal(receipt.counters.mainModelRequests, 0); assert.equal(receipt.counters.mainModelStreams, 0);
    assert.equal(receipt.counters.toolCalls, 0); assert.equal(f.counts().requests, 0); assert.equal(f.counts().streams, 0);
    assert.equal(receipt.cleanupVerified, true);
    assert.equal(receipt.firstStepMessageCount, 3);
    assert.match(String(receipt.failureDetail), /first step/i);
  } finally { await adapter.close(); }
});

test('the single claimed input path stays accepted without a host runtime-context snapshot', async t => {
  const { f, adapter, typesSeen } = await probeFixture(t);
  f.setToolPlan({ name: 'shiyu_core_event_types', args: {} });
  f.setOutput(JSON.stringify({ ok: true, typesSeen }));
  try {
    const receipt = await adapter.probeCoreEventToolModelRound({ cwd: '/synthetic/shiyu/core', timeoutMs: 5000 });
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.counters.mainModelRequests, 2); assert.equal(receipt.counters.mainModelStreams, 2);
    assert.equal(receipt.counters.userMessages, 2);
    assert.equal(receipt.cleanupVerified, true);
  } finally { await adapter.close(); }
});
