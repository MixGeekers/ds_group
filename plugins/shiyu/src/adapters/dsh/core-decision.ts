import type { GoalBinding, GoalAuthorityVerdict, NativeGoalRef, NativeGoalView } from './goals.js';
import { defaultModel, type DshAgent, type DshAgentContext, type DshContext, type DshSession, type ModelUsage, type SessionEvent } from './sessions.js';
import { checkedNativeUserMessage, loadNativeMessageFactory, nativeMessageHash, type NativeMessageFactory, type NativeUserMessage } from './native-message.js';
import { flushNative, nativeInboxReferences, verifyNativeEvent } from './native-context.js';

export type CoreDecisionPhase = 'start' | 'bound' | 'dispatch' | 'pre-step' | 'request' | 'stream' | 'context' | 'result';
export interface CoreDecisionBinding { goalId: string; goalRef: NativeGoalRef; roundId: string; sessionId: string; messageId: string; messageHash: string }
export interface CoreDecisionMessageRef { sessionId: string; eventSeq: number; messageId: string; messageHash: string; durability: 'confirmed' }
export interface CoreModelObservation { type: string; seq?: number; usage?: Omit<ModelUsage, 'status'> }
export interface CoreDecisionAccounting {
  goalId: string; roundId: string; sessionId?: string; usage: ModelUsage; modelCalls: number | null;
  nativeObservations: CoreModelObservation[]; dispatchAttempted: boolean; outcome: 'observed' | 'unknown';
}
export interface CoreDecisionRequest {
  goalId: string; expectedRef: NativeGoalRef; roundId: string; capability: object;
  prompt: string; deadlineAtMs: number; maxTokens: number; signal?: AbortSignal;
  onDispatch(binding: Readonly<CoreDecisionBinding>): void | Promise<void>;
  onContextDurable?(receipt: Readonly<CoreDecisionMessageRef>): void | Promise<void>;
  onAccounting(observation: Readonly<CoreDecisionAccounting>): void | Promise<void>;
}
export interface CoreDecisionResult {
  binding: CoreDecisionBinding; text: string; inputRef: CoreDecisionMessageRef; assistantRef: CoreDecisionMessageRef;
  /** Independently cold-read native cwd snapshots; never owner input authority. */
  runtimeContextRefs?: CoreDecisionMessageRef[];
  /** Observable native middleware calls, not provider-internal transport retries. */
  usage: ModelUsage; modelCalls: number | null; nativeObservations: CoreModelObservation[]; verified: false;
  /** Ordinary official user followups do not increment the native Goal driver's round counter. */
  nativeRoundsStarted: { before: number; after: number }; nativeGoalRound: false;
}
interface Options {
  ctx: DshContext; request: CoreDecisionRequest; now: () => number; shutdown: AbortSignal;
  createUserMessage?: NativeMessageFactory;
  isAgentLoopRequest?: (request: unknown) => boolean;
  authorize(binding: GoalBinding, phase: CoreDecisionPhase): Promise<Extract<GoalAuthorityVerdict, { allowed: true }>>;
  readGoal(agent: DshAgent): NativeGoalView | undefined;
}
type Disposer = () => void | Promise<void>;
const MODEL = Object.freeze(defaultModel('core'));
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const OBSERVED_TYPES = new Set(['assistant/message', 'assistant/attempt', 'session/title-llm-request']);
const sameRef = (a: NativeGoalRef | undefined, b: NativeGoalRef): boolean => a?.id === b.id && a.revision === b.revision;
function nativeRejected(code: 'CORE_NATIVE_INPUT_REJECTED' | 'CORE_NATIVE_CONTEXT_REJECTED', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export function validateCoreDecisionRequest(value: CoreDecisionRequest, now: number): CoreDecisionRequest {
  if (!value || typeof value.goalId !== 'string' || !value.goalId.trim() || value.goalId.length > 2048
    || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,149}$/.test(value.roundId)
    || typeof value.expectedRef?.id !== 'string' || !value.expectedRef.id || value.expectedRef.id.length > 2048
    || !Number.isSafeInteger(value.expectedRef.revision) || value.expectedRef.revision < 1
    || typeof value.prompt !== 'string' || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 64000
    || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 4096
    || !Number.isSafeInteger(value.deadlineAtMs) || value.deadlineAtMs <= now || value.deadlineAtMs > now + 120000
    || !value.capability || typeof value.capability !== 'object'
    || typeof value.onDispatch !== 'function' || typeof value.onAccounting !== 'function'
    || (value.onContextDurable !== undefined && typeof value.onContextDurable !== 'function')) throw new Error('Invalid bounded Core decision request');
  return { ...value, expectedRef: Object.freeze({ ...value.expectedRef }) };
}
/** One native followup admission, never a model loop. No generated text is execution authority. */
export class CoreDecisionRun {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly maxTokens: number;
  private timer: ReturnType<typeof setTimeout>;
  private deadline: number;
  private binding?: GoalBinding;
  private message?: NativeUserMessage;
  private agent?: DshAgent;
  private expected?: CoreDecisionBinding;
  private steps = 0;
  private requests = 0;
  private streams = 0;
  private dispatchAttempted = false;
  private released = false;
  private failure?: unknown;
  private readonly events: SessionEvent[] = [];
  private accounted = false;
  private isAgentLoopRequest?: (request: unknown) => boolean;
  unknownInbox = false;
  constructor(private readonly options: Options) {
    this.maxTokens = options.request.maxTokens; this.deadline = options.request.deadlineAtMs;
    this.signal = AbortSignal.any([this.controller.signal, options.shutdown, ...(options.request.signal ? [options.request.signal] : [])]);
    this.timer = setTimeout(() => this.stop(new Error('Core decision deadline expired')), Math.max(1, this.deadline - options.now()));
    this.signal.addEventListener('abort', this.onAbort, { once: true });
  }
  private onAbort = (): void => {
    if (!this.released) try { this.agent?.cancel({ kind: 'hook', reason: 'Core decision cancelled' }, { keepInbox: true }); }
    catch (error) { this.failure ??= error; }
  };
  private assertCurrent(): void {
    this.signal.throwIfAborted();
    if (this.options.now() >= this.deadline) throw this.stop(new Error('Core decision deadline expired'));
    if (this.failure) throw this.failure;
    if (this.unknownInbox) throw new Error('Unregistered Core Goal inbox input');
  }
  private stop(error: unknown): unknown {
    this.failure ??= error;
    if (!this.controller.signal.aborted) this.controller.abort(error);
    return error;
  }
  async gate(phase: CoreDecisionPhase): Promise<void> {
    this.assertCurrent();
    if (!this.binding) throw new Error('Core Goal binding unavailable');
    const grant = await this.options.authorize(this.binding, phase);
    this.assertCurrent();
    const expires = Date.parse(grant.expiresAt);
    if (expires < this.deadline) {
      this.deadline = expires; clearTimeout(this.timer);
      this.timer = setTimeout(() => this.stop(new Error('Core decision authority expired')), Math.max(1, expires - this.options.now()));
    }
    this.assertCurrent();
    if (this.agent && !this.released) { this.goal(); this.assertNativeCwd(); }
  }
  private assertNativeCwd(): void {
    let current: unknown;
    try {
      const directories = this.options.ctx.get('workingDirectory');
      if (typeof directories?.get === 'function') current = directories.get(this.agent!.session);
    } catch { /* Native details are not safe diagnostic payloads. */ }
    if (current !== this.binding?.cwd) {
      throw nativeRejected('CORE_NATIVE_CONTEXT_REJECTED', 'Core native working directory differs from its trusted binding');
    }
  }
  /** Only the fixed SDK's required cwd snapshot is admitted beside owner input. */
  private validateInputs(messages: unknown): void {
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 2 || messages[0]?.id !== this.expected?.messageId
      || nativeMessageHash(messages[0]) !== this.expected!.messageHash) throw nativeRejected('CORE_NATIVE_INPUT_REJECTED', 'Core owner input is missing, changed or accompanied by unregistered input');
    if (messages.length === 1) return;
    const context = messages[1];
    if (!context || typeof context.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.id)
      || context.id === this.expected!.messageId) throw nativeRejected('CORE_NATIVE_CONTEXT_REJECTED', 'Core native context has no distinct official message identity');
    const directoryText = `Current working directory: ${JSON.stringify(this.binding!.cwd)}.`;
    const expected = { id: context.id, role: 'user', content: [{ type: 'text', text: `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${directoryText}` }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory:current', text: directoryText }] } };
    if (nativeMessageHash(context) !== nativeMessageHash(expected)) throw nativeRejected('CORE_NATIVE_CONTEXT_REJECTED', 'Core native context does not match the exact bound working-directory snapshot');
  }
  private committedInputs(): SessionEvent[] {
    const inputs = this.events.filter(event => event.type === 'user/message');
    this.validateInputs(inputs.map(event => event.data));
    if (inputs.some((event, index) => !Number.isSafeInteger(event.seq) || event.seq! < 0 || (index > 0 && event.seq! <= inputs[index - 1]!.seq!))) {
      throw nativeRejected('CORE_NATIVE_INPUT_REJECTED', 'Core native input event ordering is invalid');
    }
    return inputs;
  }
  private goal(): NativeGoalView {
    const native = this.options.readGoal(this.agent!);
    if (!native || !sameRef(native, this.options.request.expectedRef) || native.phase !== 'active' || native.activation !== 'disarmed'
      || !Number.isSafeInteger(native.roundsStarted) || native.roundsStarted < 0) throw new Error('Core Goal is stopped or its native revision changed');
    return native;
  }
  async prepare(binding: GoalBinding): Promise<void> {
    this.binding = structuredClone(binding);
    if (!sameRef(binding.goalRef, this.options.request.expectedRef) || (binding.receipt && ['pending', 'unknown'].includes(binding.receipt.status))) throw new Error('Core Goal revision or lifecycle command requires reconciliation');
    await this.gate('start');
    const llm = this.options.ctx.get('llm');
    if (typeof llm?.resolveCallConfig !== 'function') throw new Error('Native model resolver is unavailable');
    if (typeof this.options.ctx.get('workingDirectory')?.get !== 'function') throw nativeRejected('CORE_NATIVE_CONTEXT_REJECTED', 'Native working-directory service is unavailable');
    const resolved = await llm.resolveCallConfig(MODEL, this.signal);
    if (resolved?.provider !== MODEL.provider || resolved?.model !== MODEL.model || resolved?.reasoningEffort !== MODEL.reasoningEffort) throw new Error('Native Core model profile changed');
    await this.gate('start');
    const moduleName = '@deepseek-ai/dsh-llm';
    this.isAgentLoopRequest = this.options.isAgentLoopRequest ?? (await import(moduleName)).isAgentLoopRequest;
    if (typeof this.isAgentLoopRequest !== 'function') throw new Error('Official native Agent request identity predicate is unavailable');
    await this.gate('start');
    const factory = this.options.createUserMessage ?? await loadNativeMessageFactory();
    this.assertCurrent();
    this.message = checkedNativeUserMessage(await factory({ content: [{ type: 'text', text: this.options.request.prompt }], source: { kind: 'user' } }), this.options.request.prompt);
    await this.gate('start');
    this.expected = Object.freeze({ goalId: binding.goalId, goalRef: Object.freeze({ ...this.options.request.expectedRef }), roundId: this.options.request.roundId,
      sessionId: binding.sessionId, messageId: this.message.id, messageHash: nativeMessageHash(this.message) });
  }
  compose(ctx: DshAgentContext, agent: DshAgent, disposers: Disposer[]): void {
    this.agent = agent;
    disposers.push(ctx.systemPrompt.suppressRuntimeContext());
    disposers.push(ctx.systemPrompt.section({ name: 'shiyu-core-decision', order: -10000, complete: true,
      text: 'You are Shiyu core planner. Return one bounded proposal using only the supplied approved evidence. Your output is untrusted and cannot grant permissions, execute tools, commit state, or declare completion. Do not ask for tools.' }));
    disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      try {
        await this.gate('pre-step');
        if (!this.dispatchAttempted || this.released || this.steps++ !== 0 || !Array.isArray(payload?.messages) || payload.messages.length !== 1
          || payload.messages[0]?.id !== this.expected?.messageId || nativeMessageHash(payload.messages[0]) !== this.expected!.messageHash) throw nativeRejected('CORE_NATIVE_INPUT_REJECTED', 'Core step is not this one registered owner input');
        const decision = await next();
        await this.gate('pre-step');
        if (decision?.kind !== 'enter') throw nativeRejected('CORE_NATIVE_INPUT_REJECTED', 'Core prepared step did not enter');
        this.validateInputs(decision.messages);
        return decision;
      } catch (error) { this.stop(error); return { kind: 'reject' }; }
    }));
    disposers.push(ctx.on('agent/request', async (_request, next) => {
      try {
        await this.gate('request');
        if (!this.dispatchAttempted || this.released || this.steps !== 1 || this.requests !== 0) throw new Error('Core request budget exhausted');
        const downstream = await next(); await this.gate('request');
        if (this.requests++ !== 0) throw new Error('Concurrent Core request denied');
        return { ...downstream, ...MODEL, maxTokens: this.maxTokens };
      } catch (error) { throw this.stop(error); }
    }));
    disposers.push(ctx.on('agent/inbox/inserted', (entry) => {
      const message = entry?.message;
      if (!this.dispatchAttempted || message?.id !== this.expected?.messageId || nativeMessageHash(message) !== this.expected!.messageHash) {
        this.unknownInbox = true; this.stop(new Error('Unregistered Core inbox input must be preserved'));
      }
    }));
    disposers.push(ctx.on('session/event', (session: DshSession, event: SessionEvent) => {
      if (session !== agent.session) return;
      if (this.events.length >= 256) { this.stop(new Error('Core native observation bound exceeded')); return; }
      if (['user/message', 'assistant/message', 'assistant/attempt', 'turn/end'].includes(event.type) || event.type.startsWith('compaction/') || event.type === 'session/title-llm-request') this.events.push(structuredClone(event));
      if (event.type === 'turn/end' && event.data?.reason?.kind !== 'completed') this.failure ??= new Error(`Core turn ended: ${event.data?.reason?.kind ?? 'unknown'}`);
      if (event.type === 'assistant/message' && Number.isFinite(event.data?.usage?.outputTokens) && event.data.usage.outputTokens > this.maxTokens) this.stop(new Error('Native Core output exceeded its limit'));
    }));
  }
  /** Public llm/stream middleware also covers compaction/title direct LLM paths. */
  stream(request: any, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
    const self = this;
    return (async function* () {
      try {
        await self.gate('stream');
        if (!self.dispatchAttempted || self.released || self.requests !== 1 || self.streams !== 0 || request.purpose !== undefined || !self.isAgentLoopRequest?.(request)
          || request.sessionId !== self.binding?.sessionId || request.provider !== MODEL.provider || request.model !== MODEL.model
          || request.reasoningEffort !== MODEL.reasoningEffort || request.maxTokens !== self.maxTokens
          || (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length))) throw new Error('Core stream is outside the single admitted primary request');
        // Some native providers rebuild tool declarations from historical updates after this hook.
        const history = request.toolHistory;
        if (history !== undefined && (!Array.isArray(history?.tools) || history.tools.length || !Array.isArray(history?.updates)
          || history.updates.some((update: any) => !Array.isArray(update?.additions) || update.additions.length))) throw new Error('Core historical tool declarations are forbidden');
        // Outer hooks and the loop's refreshed required context can change the
        // final messages. Recheck exact owner input plus only the allowed cwd
        // snapshot; its newly generated UUID need not equal the pre-step UUID.
        self.committedInputs();
        self.streams++;
        yield* next();
      } catch (error) { throw self.stop(error); }
    })();
  }
  private async exact(event: SessionEvent, assistant = false): Promise<CoreDecisionMessageRef> {
    try {
      await flushNative(this.options.ctx, this.agent!.session, this.signal);
      await verifyNativeEvent(this.options.ctx, this.binding!.sessionId, event, this.signal);
      const message = assistant ? event.data?.message : event.data;
      if (typeof message?.id !== 'string' || !message.id || message.role !== (assistant ? 'assistant' : 'user')) throw new Error('Native complete message identity is unavailable');
      return { sessionId: this.binding!.sessionId, eventSeq: event.seq!, messageId: message.id, messageHash: nativeMessageHash(message), durability: 'confirmed' };
    } catch (error) {
      this.signal.throwIfAborted();
      if (assistant) throw error;
      throw nativeRejected(event.data?.source?.kind === 'runtime-context' ? 'CORE_NATIVE_CONTEXT_REJECTED' : 'CORE_NATIVE_INPUT_REJECTED', 'Core native input durability could not be confirmed');
    }
  }
  async execute(agent: DshAgent): Promise<CoreDecisionResult> {
    this.agent = agent; await this.gate('bound'); const before = this.goal().roundsStarted;
    if (agent.status !== 'idle' || nativeInboxReferences(agent.inbox).length) throw new Error('Core decision requires an idle empty native inbox');
    await this.options.request.onDispatch(structuredClone(this.expected!));
    await this.gate('dispatch');
    if (nativeInboxReferences(agent.inbox).length) { this.unknownInbox = true; throw new Error('Core inbox changed before dispatch'); }
    this.dispatchAttempted = true; agent.followup(this.message!);
    // Native cancellation owns the loop; do not race disposal against a still-running native stream.
    await agent.whenIdle();
    this.signal.throwIfAborted();
    const inputs = this.committedInputs();
    const inputRef = await this.exact(inputs[0]!);
    const runtimeContextRefs: CoreDecisionMessageRef[] = [];
    for (const event of inputs.slice(1)) runtimeContextRefs.push(await this.exact(event));
    // A failed model turn may still have durably loaded the exact registered input.
    await this.gateForContext(); await this.options.request.onContextDurable?.(Object.freeze({ ...inputRef }));
    this.assertCurrent();
    const assistants = this.events.filter(event => event.type === 'assistant/message');
    const assistant = assistants[0];
    if (assistants.length !== 1 || assistant?.data?.interrupted || assistant!.seq! <= inputs.at(-1)!.seq!
      || this.steps !== 1 || this.requests !== 1 || this.streams !== 1) throw new Error('Core has no single complete native candidate');
    const assistantRef = await this.exact(assistant!, true);
    const content = assistant!.data.message.content;
    if (!Array.isArray(content)) throw new Error('Native Core content is unavailable');
    const parts = content.filter((part: any) => part.type === 'text');
    if (!parts.length || parts.some((part: any) => typeof part.text !== 'string') || content.some((part: any) => ['tool-call', 'tool_use'].includes(part.type))) throw new Error('Native Core returned unsupported candidate content');
    const text = parts.map((part: any) => part.text).join('\n');
    if (!text.trim() || Buffer.byteLength(text) > 64000) throw new Error('Native Core candidate is not bounded text');
    await this.gate('result'); const after = this.goal().roundsStarted;
    if (before !== after) throw new Error('Native Goal driver ran outside the controlled decision');
    return { binding: structuredClone(this.expected!), text, inputRef, assistantRef, runtimeContextRefs, ...this.observations(), verified: false, nativeRoundsStarted: { before, after }, nativeGoalRound: false };
  }
  private async gateForContext(): Promise<void> {
    // Generation failure does not undo a successful input append; authorization still must be fresh.
    this.signal.throwIfAborted();
    await this.options.authorize(this.binding!, 'context');
    this.signal.throwIfAborted(); this.goal(); this.assertNativeCwd();
    if (this.options.now() >= this.deadline || this.unknownInbox) throw new Error('Core context receipt admission expired');
  }
  private observations(): Pick<CoreDecisionResult, 'usage' | 'modelCalls' | 'nativeObservations'> {
    const events = this.events.filter(event => OBSERVED_TYPES.has(event.type) || event.type.startsWith('compaction/'));
    const nativeObservations = events.map(event => {
      const usage: Omit<ModelUsage, 'status'> = {};
      for (const key of USAGE_KEYS) if (Number.isSafeInteger(event.data?.usage?.[key]) && event.data.usage[key] >= 0) usage[key] = event.data.usage[key];
      return { type: event.type, ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}), ...(Object.keys(usage).length ? { usage } : {}) };
    });
    const samples = events.filter(event => ['assistant/message', 'assistant/attempt', 'compaction/summary'].includes(event.type));
    const partial = events.some(event => event.type !== 'assistant/message') || samples.length !== this.streams || this.streams !== 1;
    const usage: ModelUsage = { status: partial || !samples.length ? 'unknown' : 'reported' };
    for (const key of USAGE_KEYS) {
      const known = samples.map(event => event.data?.usage?.[key]).filter(value => Number.isSafeInteger(value) && value >= 0);
      const sum = known.reduce((a: number, b: number) => a + b, 0);
      if (known.length && Number.isSafeInteger(sum) && (partial || known.length === samples.length)) usage[key] = sum;
    }
    if (Object.keys(usage).length === 1) usage.status = 'unknown';
    // Counts native middleware dispatches only; provider-internal transport retries remain unobservable.
    return { usage, modelCalls: this.streams === 1 ? 1 : null, nativeObservations };
  }
  releasing(): void { this.released = true; }
  async account(success: boolean): Promise<void> {
    if (this.accounted) throw new Error('Core accounting cannot be dispatched twice');
    this.accounted = true;
    await this.options.request.onAccounting(Object.freeze({ goalId: this.options.request.goalId, roundId: this.options.request.roundId,
      ...(this.binding ? { sessionId: this.binding.sessionId } : {}), ...this.observations(), dispatchAttempted: this.dispatchAttempted, outcome: success ? 'observed' : 'unknown' }));
  }
  close(): void { clearTimeout(this.timer); this.signal.removeEventListener('abort', this.onAbort); }
}
