/**
 * Independent fake native host for H1 business-path verification.
 *
 * This is a behaviour simulator written from the frozen DSH 0.2.1-rc.5 static
 * contract and the product's public DshContext/DshAgent seam (sessions.ts):
 * - agents.create/resume open the session log, resume appends the SDK's
 *   interrupted-turn closers and a session/end-seed marker before the Session
 *   is published;
 * - a followup enters the native inbox (durable splice), the loop claims it,
 *   runs the pre-step waterfall, appends the exact user/message, the request
 *   waterfall, the llm/stream middleware, one assistant/message and the turn
 *   end;
 * - sessions.flush is the durability barrier; session/title user rename is the
 *   fixed-title write; sessionProjections.restore is the official projector.
 *
 * It is deliberately independent from the product's own test doubles: no
 * product test file is imported or copied.
 */

import { createHash, randomUUID } from 'node:crypto';

import { foldNativeInbox, independentHash, type NativeUserMessage, type WorldEvent } from './independent.js';
import { buildHistory, NativeWorld } from './world.js';

type Listener = (...args: any[]) => any;

export class HookBus {
  listeners = new Map<string, Listener[]>();
  on(name: string, listener: Listener): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
    return () => { const current = this.listeners.get(name) ?? []; const index = current.indexOf(listener); if (index >= 0) current.splice(index, 1); };
  }
  /** Cordis-style synchronous notification: listeners run in registration order, synchronously. */
  emitSync(name: string, ...args: any[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) { try { void listener(...args); } catch { /* observer containment like the host */ } }
  }
  async emit(name: string, ...args: any[]): Promise<void> {
    for (const listener of [...(this.listeners.get(name) ?? [])]) await listener(...args);
  }
  async waterfall(name: string, args: any[], terminal: () => Promise<any>): Promise<any> {
    const hooks = [...(this.listeners.get(name) ?? [])];
    let position = 0;
    const next = (): Promise<any> => hooks[position++]?.(...args, next) ?? terminal();
    return next();
  }
  async stream(name: string, request: any, terminal: () => AsyncIterable<any>): Promise<AsyncIterable<any>> {
    const hooks = [...(this.listeners.get(name) ?? [])];
    let position = 0;
    const next = (): any => hooks[position++]?.(request, next) ?? terminal();
    return next();
  }
}

export interface ModelSelection { provider: string; model: string; reasoningEffort: 'low' | 'high' | 'max' }

export interface GenerationPlan {
  /** Assistant text produced for the admitted primary stream. */
  text?: string;
  /** Real core-Session shape: the loop appends the required working-directory runtime-context snapshot user message. */
  runtimeContext?: boolean;
  /** Host shape for a negative test: append a second unregistered plain user message after the owner input. */
  extraUserMessage?: boolean;
  /** Reported usage on the assistant/message event. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Called after the owner user/message was appended and before the primary stream is entered. */
  beforeStream?: (host: FakeHost, agent: FakeAgent) => void | Promise<void>;
}

export class FakeHost {
  readonly worlds = new Map<string, NativeWorld>();
  readonly hooks = new HookBus();
  readonly presets = new Set<string>();
  readonly live = new Map<string, FakeAgent>();
  readonly agents: FakeAgent[] = [];
  readonly flushLog: { sessionId: string; eventCount: number }[] = [];
  readonly resolveCalls: ModelSelection[] = [];
  readonly generationPlan: GenerationPlan;
  flushBehavior: ('ok' | 'false' | 'throw')[] = [];
  titleFailures = 0;
  /** Fake native Goal service state; only used by Core decision cases. */
  readonly goalViews = new Map<string, any>();
  createdSessions = 0;
  resumedSessions = 0;
  disposed = 0;
  private messageCounter = 0;
  readonly cwd: string;

  constructor(options: { generation?: GenerationPlan; cwd?: string } = {}) {
    this.generationPlan = options.generation ?? {};
    this.cwd = options.cwd ?? '/synthetic/verify/workspace';
  }

  messageFactory = (input: { content: { type: 'text'; text: string }[]; source: { kind: 'user' } }): NativeUserMessage => ({
    id: `native-message-${(++this.messageCounter).toString().padStart(4, '0')}-${independentHash(input.content).slice(0, 8)}`,
    role: 'user', content: structuredClone(input.content), source: structuredClone(input.source) as { kind: 'user' },
  });

  world(sessionId: string): NativeWorld | undefined { return this.worlds.get(sessionId); }

  ensureWorld(sessionId: string, header: Record<string, unknown>, events: WorldEvent[] = []): NativeWorld {
    const world = new NativeWorld({ sessionId, header: { ...header }, events });
    this.worlds.set(sessionId, world);
    return world;
  }

  /** Services object handed to the product adapters. */
  get ctx(): any {
    return {
      get: (name: string) => this.service(name),
      on: (name: string, listener: Listener) => this.hooks.on(name, listener),
      agents: {
        create: (options: any) => this.create(options),
        resume: (options: any) => this.resume(options),
        list: () => [...this.live.values()],
      },
    };
  }

  private service(name: string): any {
    switch (name) {
      case 'agentPresets': return { register: async (preset: { id: string }) => { this.presets.add(preset.id); return () => { this.presets.delete(preset.id); }; } };
      case 'sessionPersistence': return { open: (id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }) => this.openWorld(id, access, options) };
      case 'sessionProjections': return { restore: (checkpoint: unknown, events: WorldEvent[], baseSeq: number, header: any, inherited: number) => this.project(header, events, baseSeq, inherited) };
      case 'sessions': return {
        flush: async (session: any) => this.flush(session),
        get: (id: string) => this.live.get(id)?.session,
        list: () => [...this.live.values()].map(agent => agent.session),
      };
      case 'sessionTitle': return {
        rename: (session: any, title: string) => this.rename(session, title),
        get: (session: any) => this.titleOf(session),
      };
      case 'workingDirectory': return { get: (session: any) => this.worlds.get(session?.id)?.header.cwd };
      case 'llm': return {
        resolveCallConfig: async (model: ModelSelection) => { this.resolveCalls.push(structuredClone(model)); return structuredClone(model); },
      };
      case 'goals': return this.goalService();
      default: return undefined;
    }
  }

  private goalService(): any {
    const view = (agent: FakeAgent) => this.goalViews.get(agent.id) ?? [...this.goalViews.values()][0];
    return {
      get: (agent: any) => structuredClone(view(agent)),
      create: (agent: any, request: { objective: string; maxGoalRounds: number }) => {
        const next = { id: `goal-${this.goalViews.size + 1}`, revision: 1, objective: request.objective, maxGoalRounds: request.maxGoalRounds, phase: 'active', roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now(), activation: 'disarmed' };
        this.goalViews.set(agent.id, next); return structuredClone(next);
      },
      edit: (agent: any, ref: any, changes: any) => { const current = view(agent); const next = { ...current, ...changes, revision: current.revision + 1, updatedAt: Date.now() }; this.goalViews.set(agent.id, next); return structuredClone(next); },
      pause: (agent: any, ref: any) => { const current = view(agent); const next = { ...current, phase: 'paused', revision: current.revision + 1, updatedAt: Date.now() }; this.goalViews.set(agent.id, next); return structuredClone(next); },
      resume: (agent: any, ref: any) => { const current = view(agent); const next = { ...current, phase: 'active', revision: current.revision + 1, updatedAt: Date.now() }; this.goalViews.set(agent.id, next); return structuredClone(next); },
      complete: (agent: any, ref: any) => { const current = view(agent); const next = { ...current, phase: 'complete', revision: current.revision + 1, updatedAt: Date.now() }; this.goalViews.set(agent.id, next); return structuredClone(next); },
      disarm: (agent: any) => { const current = view(agent); if (!current) return undefined; const next = { ...current, activation: 'disarmed' }; this.goalViews.set(agent.id, next); return structuredClone(next); },
    };
  }

  private openWorld(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<any> {
    const world = this.worlds.get(id);
    if (!world) return Promise.reject(Object.assign(new Error(`session "${id}" not found`), { name: 'SessionPersistenceNotFoundError' }));
    return world.open(id, access, options);
  }

  private project(header: any, events: WorldEvent[], baseSeq: number, inherited: number): Promise<any> {
    const world = this.worlds.get(header?.id);
    if (!world) return Promise.reject(new Error('unknown session projection'));
    return world.restore({}, events, baseSeq, header, inherited);
  }

  private async flush(session: any): Promise<boolean> {
    const world = this.worlds.get(session?.id);
    if (!world || !this.live.has(session.id)) return false;
    const behavior = this.flushBehavior.shift() ?? 'ok';
    if (behavior === 'throw') throw new Error('synthetic durability failure');
    if (behavior === 'false') return false;
    world.flushCalls++;
    this.flushLog.push({ sessionId: session.id, eventCount: world.events.length });
    return true;
  }

  private titleSnapshot(session: any): any {
    const world = this.worlds.get(session?.id);
    if (!world) return undefined;
    const event = [...world.events].reverse().find(candidate => candidate.type === 'session/title');
    if (!event) return undefined;
    return { title: event.data.title, source: event.data.source, messageSeqs: event.data.messageSeqs, eventSeq: event.seq, updatedAt: event.time };
  }

  private titleOf(session: any): any { return this.titleSnapshot(session); }

  rename(session: any, title: string): any {
    if (this.titleFailures > 0) { this.titleFailures--; throw new Error('synthetic title write failure'); }
    if (!this.live.has(session.id)) throw new Error('session is not live');
    session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
    return this.titleSnapshot(session);
  }

  async create(options: any): Promise<any> {
    options.signal?.throwIfAborted();
    const id = options.sessionId;
    const world = new NativeWorld({
      sessionId: id,
      header: { version: 4, id, createdAt: Date.now(), isSeeded: false, cwd: options.meta?.cwd ?? this.cwd, agentPreset: options.meta?.agentPreset },
      events: [],
    });
    this.worlds.set(id, world);
    this.createdSessions++;
    return this.publishAgent(options, id);
  }

  async resume(options: any): Promise<any> {
    options.signal?.throwIfAborted();
    const id = options.resumeSessionId;
    const world = this.worlds.get(id);
    if (!world) throw Object.assign(new Error(`session "${id}" not found`), { name: 'SessionPersistenceNotFoundError' });
    this.resumedSessions++;
    this.appendResumeSuffix(world);
    return this.publishAgent(options, id);
  }

  /** The frozen SDK resume suffix: interrupted-turn closers then the end-seed marker. */
  private appendResumeSuffix(world: NativeWorld): void {
    let openTurn: number | null = null;
    let openStep: number | null = null;
    for (const event of world.events) {
      if (event.type === 'turn/start') { openTurn = event.data.turn; openStep = null; }
      else if (event.type === 'turn/end') { openTurn = null; openStep = null; }
      else if (event.type === 'step/start') openStep = event.data.step;
      else if (event.type === 'step/end') openStep = null;
    }
    if (openTurn !== null) {
      if (openStep !== null) world.append('step/end', { turn: openTurn, step: openStep });
      world.append('turn/end', { turn: openTurn, reason: { kind: 'interrupted' } });
    }
    if (world.events.at(-1)?.type !== 'session/end-seed') world.append('session/end-seed', {});
  }

  private async publishAgent(options: any, id: string): Promise<any> {
    const world = this.worlds.get(id)!;
    const agent = new FakeAgent(this, id, world);
    this.agents.push(agent);
    this.live.set(id, agent);
    await options.setup?.(agent.ctx, agent);
    return { agent, dispose: () => agent.dispose() };
  }

  /** Deliver the primary-stream middleware chain to whatever hooks are registered. */
  stream(request: any): AsyncIterable<any> {
    return iterableFrom(this.hooks, request);
  }

  readonly llmStreamTerminal = (_request: any): AsyncIterable<any> => (async function* () { yield { type: 'text-delta', text: 'synthetic' }; })();

  inboxOf(session: any): { nextTurn: NativeUserMessage[]; nextStep: NativeUserMessage[] } {
    const world = this.worlds.get(session.id)!;
    return foldNativeInbox(world.events);
  }
}

function iterableFrom(hooks: HookBus, request: any): AsyncIterable<any> {
  // Resolve the hook chain eagerly into one async iterable.
  const terminal = async function* () { yield { type: 'text-delta', text: 'synthetic' }; };
  const chain: Listener[] = [...(hooks.listeners.get('llm/stream') ?? [])];
  let position = 0;
  const next = (): AsyncIterable<any> => {
    const hook = chain[position++];
    return hook ? hook(request, next) : terminal();
  };
  return next();
}

export const deriveSurfaceMessages = (events: readonly WorldEvent[]): unknown[] =>
  events.filter(event => event.surfaceOp === 'append' && ['user/message', 'assistant/message', 'tool/result', 'system/message'].includes(event.type))
    .map(event => event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'system/message' ? event.data.message : event.data)
    .filter(message => message !== undefined);

export class FakeAgent {
  readonly host: FakeHost;
  readonly id: string;
  readonly world: NativeWorld;
  readonly hooks = new HookBus();
  status: 'idle' | 'running' = 'idle';
  private maintenance = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;
  private abort = new AbortController();
  followupCalls = 0;
  modelCalls = 0;
  maintenanceCalls = 0;
  maintenanceEntered = 0;
  cancelled = 0;
  disposedFlag = false;
  readonly session: any;
  readonly ctx: any;
  private readonly hostRef: FakeHost;

  constructor(host: FakeHost, id: string, world: NativeWorld) {
    this.hostRef = host;
    this.host = host;
    this.id = id;
    this.world = world;
    const agent = this;
    this.session = {
      id,
      get header() { return world.header; },
      get seq() { return world.events.length; },
      get inheritedEventCount() { return world.inheritedEventCount; },
      append(type: string, data: unknown, options?: { surfaceOp?: unknown }) {
        if (agent.disposedFlag) throw new Error('append on a disposed Session');
        const event = world.append(type, data, options?.surfaceOp);
        agent.hooks.emitSync('session/event', agent.session, event);
        if (type === 'agent/inbox/spliced' && Array.isArray((data as any)?.inserted)) {
          for (const message of (data as any).inserted) agent.hooks.emitSync('agent/inbox/inserted', { message });
        }
        return event;
      },
      deriveMessages() { return deriveSurfaceMessages(world.events); },
      remove(messageId: string) { return agent.removeInbox(messageId); },
    };
    this.ctx = {
      on: (name: string, listener: Listener) => this.hooks.on(name, listener),
      tools: {
        presentAs: () => () => {},
        schemas: () => [] as { name: string }[],
        restrict: () => () => {},
        guard: () => () => {},
      },
      systemPrompt: {
        suppressRuntimeContext: () => () => {},
        section: () => () => {},
        assemble: async () => ({ tools: [] as { name: string }[], messages: [] }),
      },
    };
  }

  get inbox(): any {
    const agent = this;
    return {
      get nextTurn() { return agent.inboxRefs.nextTurn; },
      get nextStep() { return agent.inboxRefs.nextStep; },
      remove: (messageId: string) => agent.removeInbox(messageId),
    };
  }

  private removeInbox(messageId: string): boolean {
    const folded = foldNativeInbox(this.world.events);
    for (const lane of ['next-turn', 'next-step'] as const) {
      const list = lane === 'next-turn' ? folded.nextTurn : folded.nextStep;
      const index = list.findIndex(message => message.id === messageId);
      if (index < 0) continue;
      this.session.append('agent/inbox/spliced', { target: lane, start: index, removedCount: 1, inserted: [], outcome: 'canceled' });
      return true;
    }
    return false;
  }

  /** Live inbox getters must read the durable projection. */
  get inboxRefs(): { nextTurn: NativeUserMessage[]; nextStep: NativeUserMessage[] } { return foldNativeInbox(this.world.events); }

  runMaintenance<T>(job: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    if (this.status !== 'idle' || this.maintenance) return Promise.reject(new Error('native maintenance requires an idle Agent'));
    this.maintenance = true;
    this.maintenanceCalls++;
    this.maintenanceEntered++;
    try {
      return Promise.resolve(job(this.abort.signal)).finally(() => { this.maintenance = false; });
    } catch (error) {
      this.maintenance = false;
      return Promise.reject(error);
    }
  }

  followup(message: NativeUserMessage): void {
    this.followupCalls++;
    if (this.status === 'running') throw new Error('followup while running');
    const folded = foldNativeInbox(this.world.events);
    this.session.append('agent/inbox/spliced', { target: 'next-turn', start: folded.nextTurn.length, removedCount: 0, inserted: [message] });
    this.status = 'running';
    this.abort = new AbortController();
    this.idle = new Promise<void>(resolve => { this.resolveIdle = resolve; });
    void this.runLoop().catch(() => { /* surfaced through whenIdle rejection below */ });
  }

  whenIdle(): Promise<void> { return this.idle; }

  private async runLoop(): Promise<void> {
    let stepOpen = false, turnOpen = false;
    try {
      const signal = this.abort.signal;
      this.session.append('turn/start', { turn: 1 });
      turnOpen = true;
      const claimed = this.claimInbox();
      if (!claimed.length) { this.finishIdle(); return; }
      const decision = await this.hooks.waterfall('agent/pre-step', [{ messages: claimed.map(message => structuredClone(message)) }],
        async () => ({ kind: 'enter', messages: claimed.map(message => structuredClone(message)) }));
      if (decision?.kind !== 'enter') { this.turnEnd({ kind: 'cancelled' }); this.finishIdle(); return; }
      this.session.append('step/start', { turn: 1, step: 1 });
      stepOpen = true;
      for (const message of claimed) this.session.append('user/message', message, { surfaceOp: 'append' });
      if (this.host.generationPlan.runtimeContext) {
        const directoryText = `Current working directory: ${JSON.stringify(this.world.header.cwd)}.`;
        this.session.append('user/message', {
          id: randomUUID(), role: 'user',
          content: [{ type: 'text', text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${directoryText}` }],
          source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: directoryText }] },
        }, { surfaceOp: 'append' });
      }
      if (this.host.generationPlan.extraUserMessage) {
        this.session.append('user/message', { id: 'extra-unregistered-user', role: 'user', content: [{ type: 'text', text: 'EXTRA-UNREGISTERED-USER' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
      }
      if (signal.aborted) throw signal.reason ?? new Error('cancelled');
      const request = await this.hooks.waterfall('agent/request', [{}], async () => ({
        sessionId: this.id,
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'low',
        maxTokens: 1024,
        messages: this.session.deriveMessages(),
        tools: [] as { name: string }[],
      }));
      this.host.generationPlan.beforeStream?.(this.host, this);
      const stream = this.host.stream(request);
      for await (const _chunk of stream) { void _chunk; }
      this.modelCalls++;
      const text = this.host.generationPlan.text ?? 'synthetic reply body';
      const usage = { inputTokens: 30, outputTokens: 7, totalTokens: 37, ...(this.host.generationPlan.usage ?? {}) };
      this.session.append('assistant/message', { message: { id: `assistant-${this.id}-${this.world.events.length}`, role: 'assistant', content: [{ type: 'text', text }] }, usage }, { surfaceOp: 'append' });
      if (stepOpen) { this.session.append('step/end', { turn: 1, step: 1 }); stepOpen = false; }
      this.turnEnd({ kind: 'completed' });
      this.finishIdle();
    } catch (error) {
      // A native turn that failed inside a stream/reporting boundary still ends
      // with a non-completed turn/end, which is what the adapter observes.
      try {
        if (stepOpen) { this.session.append('step/end', { turn: 1, step: 1 }); stepOpen = false; }
        if (turnOpen) this.turnEnd({ kind: 'error' });
      } catch { /* already disposed */ }
      this.finishIdle(error);
    }
  }

  private turnEnd(reason: { kind: string }): void {
    this.session.append('turn/end', { turn: 1, reason });
  }

  private claimInbox(): NativeUserMessage[] {
    const folded = foldNativeInbox(this.world.events);
    const claimed = [...folded.nextStep, ...folded.nextTurn];
    if (folded.nextStep.length) this.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: folded.nextStep.length, inserted: [], outcome: 'claimed' });
    if (folded.nextTurn.length) this.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'claimed' });
    return claimed.slice(0, folded.nextStep.length + 1);
  }

  private finishIdle(error?: unknown): void {
    this.status = 'idle';
    const resolve = this.resolveIdle;
    this.resolveIdle = undefined;
    resolve?.();
    if (error) { /* real host would reject whenIdle; keep the turn error observable through turn/end */ }
  }

  cancel(cause: { kind: string; reason: string }, options?: { keepInbox?: boolean }): void {
    this.cancelled++;
    this.abort.abort(new Error(cause.reason));
    if (!options?.keepInbox) {
      const folded = foldNativeInbox(this.world.events);
      for (const lane of ['next-step', 'next-turn'] as const) {
        const list = lane === 'next-step' ? folded.nextStep : folded.nextTurn;
        if (list.length) this.session.append('agent/inbox/spliced', { target: lane, start: 0, removedCount: list.length, inserted: [], outcome: 'canceled' });
      }
    }
    this.status = 'idle';
  }

  async dispose(): Promise<void> {
    this.disposedFlag = true;
    this.cancel({ kind: 'hook', reason: 'disposed' });
    if (this.host.live.get(this.id) === this) this.host.live.delete(this.id);
    this.host.disposed++;
  }
}
