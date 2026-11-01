import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { jsonOutput, targetSchema, reviewSchema, targetPrompt, judgePrompt } from './tools.js';
import { importReview } from '../dist/gym/core/judge.js';

const terminal = s => ['completed', 'stopped', 'interrupted', 'failed'].includes(s);
const active = b => ['starting', 'running'].includes(b.status);
const message = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } });

export class GymAgentDriver {
  constructor(ctx, service, config) { this.ctx = ctx; this.service = service; this.config = config; this.live = new Map(); this.composed = new WeakSet(); this.closed = false; }
  bind(role, runId) {
    const binding = { runId, role, sessionId: `gym-${role}-${randomUUID()}`, status: 'starting', startedAt: new Date().toISOString(), model: this.service.model() };
    this.service.state.bindings.push(binding); this.service.persist(); return binding;
  }
  async startTarget(runId) { return this.start('target', runId); }
  async startJudge(runId) { return this.start('judge', runId); }
  async start(role, runId) {
    if (this.closed) throw new Error('Agent 接入已关闭');
    if (!this.service.capabilities().dshAgent) throw new Error('宿主没有可用的模型配置');
    const packet = role === 'judge' ? await this.service.packet(runId) : undefined;
    const binding = this.bind(role, runId);
    const state = { binding, handle: undefined, packet, busy: false, dirty: true, submitted: false, steps: 0, nudges: 0, disposers: [], closing: undefined };
    this.live.set(binding.sessionId, state);
    try {
      const cwd = role === 'target' ? path.join(this.service.engine.runDir(runId), 'workspace') : path.join(this.service.runtimeDir, 'judge-workspaces', binding.sessionId);
      await mkdir(cwd, { recursive: true });
      state.creation = this.ctx.agents.create({
        sessionId: binding.sessionId, meta: { cwd },
        agentOptions: { ...this.service.model(), maxTokens: 8192 },
        setup: (agentCtx, agent) => this.compose(state, agentCtx, agent),
      });
      state.handle = await state.creation;
      if (this.closed || !active(binding) || (role === 'target' && terminal(this.service.engine.getRun(runId).status))) {
        await this.retire(state, 'cancelled', '创建过程中实验已结束'); return { ...binding };
      }
      this.ctx.get('sessionTitle')?.rename(state.handle.agent.session, `识雨健身房 · ${role === 'target' ? '训练' : '评分'} · ${runId}`);
      this.service.updateBinding(binding, { status: 'running' });
      if (role === 'target') {
        const off = this.service.engine.subscribe(runId, event => {
          if (event.type.startsWith('input.')) { state.dirty = true; this.wake(state); }
          if (event.type === 'run.finished') { void this.retire(state, 'completed'); }
        }); state.disposers.push(off);
      }
      state.timer = setTimeout(() => { void this.retire(state, 'error', '达到模型运行时限；未伪造完成或评分。'); }, role === 'judge' ? this.config.judgeTimeoutMs : this.service.engine.getRun(runId).config.maxDurationMs);
      this.wake(state, role === 'target' ? '开始本次合成公司工作。先 inspect，再读取已经到达的 inputs。' : '请独立评审本次已封存实验。先 overview，按需读取来源与实际成果，再 submit。');
      return { ...binding };
    } catch (error) { await this.retire(state, 'error', error.message ?? String(error)); throw error; }
  }
  compose(state, agentCtx, agent) {
    this.composed.add(agent);
    const role = state.binding.role, name = role === 'judge' ? reviewSchema.name : targetSchema.name;
    // Both the live Agent and this plugin own teardown of these scoped contributions.
    const unregister = agentCtx.effect(() => {
      const cleanup = [];
      cleanup.push(agentCtx.tools.presentAs('native'));
      const globals = agentCtx.tools.schemas(agent).map(t => t.name).filter(name => name !== 'run_code');
      if (globals.length) cleanup.push(agentCtx.tools.restrict({ deny: globals }));
      cleanup.push(agentCtx.tools.guard(call => call.name === name ? undefined : '健身房角色只能使用本实验的专用工具。'));
      cleanup.push(agentCtx.systemPrompt.suppressRuntimeContext());
      cleanup.push(agentCtx.systemPrompt.section({ name: 'shiyu-gym-role', order: 0, complete: true, text: role === 'judge' ? judgePrompt : targetPrompt }));
      cleanup.push(agentCtx.tools.register({
        ...(role === 'judge' ? reviewSchema : targetSchema), output: jsonOutput, timeoutMs: 30000, isConcurrencySafe: false,
        execute: async (args, exec) => {
          if (!active(state.binding) || state.closing) throw new Error('此模型角色已结束，请新建训练或评分');
          if (role !== 'judge') return this.service.targetCall(state.binding.runId, args, exec.signal);
          if (args.action === 'overview') {
            const p = state.packet;
            return { runId: p.runId, instructions: p.instructions, facts: p.facts, tasks: p.tasks, fileIndex: p.fileIndex ?? p.artifacts, evidenceReferences: [...new Set([...p.evidence.map(e => e.ref), ...p.events.map(e => e.id), ...p.facts.assertions.map(a => a.id)])], omittedEventCount: Math.max(0, this.service.engine.getRun(p.runId).events.length - p.events.length) };
          }
          if (args.action === 'read') {
            const result = await this.service.preview(state.binding.runId, args.path, args.offset, true);
            const ref = `artifact:${result.path}`;
            (state.readRefs ??= new Set()).add(ref);
            return { ...result, evidenceRef: ref };
          }
          if (args.action === 'events') {
            const page = this.service.get(state.binding.runId, args.after, 50).eventPage;
            for (const event of page.events) (state.readRefs ??= new Set()).add(event.id);
            return page;
          }
          if (args.action === 'submit') {
            if (state.submitted) throw new Error('本评分 Session 已提交；复评请新建评分');
            const validationPacket = { ...state.packet, evidence: [...state.packet.evidence, ...[...(state.readRefs ?? [])].map(ref => ({ ref, text: '已由本评分 Session 的只读工具检索并核验。' }))] };
            const review = importReview(validationPacket, args.review, `dsh:${state.binding.model.provider}/${state.binding.model.model}`);
            if (review.status !== 'completed') return { accepted: false, error: review.error };
            review.usage = { sessionId: state.binding.sessionId, stepsStarted: state.steps, tokenCost: '请以 DSH Session 用量记录为准；健身房未估算费用。' };
            await this.service.engine.saveReview(state.binding.runId, review);
            state.submitted = true; exec.concludeTurn?.(); return { accepted: true, review };
          }
          throw new Error('未知只读评分操作');
        },
      }));
      cleanup.push(agentCtx.on('agent/pre-step', async (_payload, next) => {
        if (!active(state.binding) || state.closing) return { kind: 'reject' };
        if (++state.steps > (role === 'judge' ? this.config.maxJudgeSteps : this.config.maxTargetSteps)) {
          queueMicrotask(() => { void this.retire(state, 'error', '达到模型步骤预算；没有补造分数或成功结果。'); }); return { kind: 'reject' };
        }
        return next();
      }));
      cleanup.push(agentCtx.on('session/event', (_session, event) => {
        if (event.type === 'turn/end' && ['error', 'max-tokens', 'blocked'].includes(event.data?.reason?.kind)) state.turnError = `模型回合终止：${event.data.reason.kind}`;
      }));
      return async () => { for (const dispose of cleanup.reverse()) await dispose(); };
    });
    state.disposers.push(unregister);
  }
  // These managed Sessions are history-only after unload/restart. Never resume them
  // with the default unrestricted preset once their live role binding has gone away.
  protectResumed(agent) {
    if (this.composed.has(agent)) return;
    const binding = this.service.state.bindings.find(b => b.sessionId === agent.id);
    if (!binding) return;
    const dispose = agent.ctx.effect(() => {
      const masks = agent.ctx.tools.schemas(agent).map(t => t.name).filter(name => name !== 'run_code');
      const off = [agent.ctx.tools.guard(() => '此健身房 Session 已封存；请从健身房新建实验或复评。'), agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))];
      if (masks.length) off.push(agent.ctx.tools.restrict({ deny: masks }));
      return async () => { for (const fn of off.reverse()) await fn(); };
    });
    this.ctx.effect(() => dispose);
  }
  wake(state, firstPrompt) {
    if (!state.handle || state.busy || state.closing || !active(state.binding) || (!state.dirty && !firstPrompt)) return;
    state.dirty = false; state.busy = true;
    try { state.handle.agent.followup(message(firstPrompt ?? '有新的公司输入到达。请使用 inputs 游标读取并继续处理未完成的业务。')); }
    catch (error) { state.busy = false; void this.retire(state, 'error', error.message); return; }
    state.turn = (async () => {
      try {
        await state.handle.agent.whenIdle(); state.busy = false;
        if (state.closing || !active(state.binding)) return;
        if (state.turnError) { await this.retire(state, 'error', state.turnError); return; }
        if (state.binding.role === 'judge') {
          await this.retire(state, state.submitted ? 'completed' : 'error', state.submitted ? undefined : '模型结束但未提交有效评分；没有默认分数。'); return;
        }
        const run = this.service.engine.getRun(state.binding.runId);
        if (terminal(run.status)) { await this.retire(state, 'completed'); return; }
        if (state.dirty) this.wake(state);
        else if (run.tasks.some(t => t.introduced && !['completed', 'failed', 'cancelled'].includes(t.status)) && state.nudges++ < 2) {
          state.dirty = true; this.wake(state, '仍有已到达但未交付的任务。请核查 inspect，并继续工作或明确说明缺少的信息。');
        }
      } catch (error) { state.busy = false; if (!state.closing) await this.retire(state, 'error', error.message ?? String(error)); }
    })();
  }
  async retire(state, status, error) {
    if (state.closing) return state.closing;
    this.service.updateBinding(state.binding, { status, finishedAt: new Date().toISOString(), stepsStarted: state.steps, ...(error ? { error: String(error).slice(0, 1500) } : {}) });
    state.closing = (async () => {
      clearTimeout(state.timer);
      try {
        const handle = state.handle ?? await state.creation?.catch(() => undefined);
        handle?.agent.cancel({ kind: 'hook', reason: error ?? '健身房角色结束' });
        await handle?.dispose();
        for (const dispose of state.disposers.splice(0).reverse()) await dispose();
        if (state.binding.role === 'judge' && !state.submitted && error) {
          const review = importReview(state.packet, { status: 'judge_error', error }, `dsh:${state.binding.model.provider}/${state.binding.model.model}`);
          await this.service.engine.saveReview(state.binding.runId, review);
        }
      } finally { this.live.delete(state.binding.sessionId); }
    })();
    return state.closing;
  }
  async cancel(runId, role) {
    for (const state of [...this.live.values()].filter(s => s.binding.runId === runId && s.binding.role === role)) await this.retire(state, 'cancelled', '用户停止了此模型角色');
  }
  async probe() {
    if (!this.service.capabilities().dshAgent) throw new Error('宿主未配置模型');
    const binding = this.bind('probe', '__probe');
    const state = { binding, steps: 0, disposers: [] };
    let handle;
    try {
      const cwd = path.join(this.service.runtimeDir, 'probes', binding.sessionId); await mkdir(cwd, { recursive: true });
      const meter = this.ctx.get('tokenMeter');
      const estimate = assembly => meter ? meter.estimateMessage({ id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: JSON.stringify({ sections: assembly.sections, contexts: assembly.contexts, tools: assembly.tools }) }] }) : null;
      handle = await this.ctx.agents.create({ sessionId: binding.sessionId, meta: { cwd }, agentOptions: { ...this.service.model(), maxTokens: 512 }, setup: async (c, a) => {
        state.beforeTokens = estimate(await c.systemPrompt.assemble({ scope: a }));
        this.compose(state, c, a);
      } });
      const tools = handle.agent.ctx.tools.schemas(handle.agent).map(t => t.name);
      const assembly = await handle.agent.ctx.systemPrompt.assemble({ scope: handle.agent });
      if (tools.some(name => name !== targetSchema.name) || !tools.includes(targetSchema.name)) throw new Error('角色工具隔离未生效');
      this.service.updateBinding(binding, { status: 'completed', finishedAt: new Date().toISOString() });
      return { ready: true, noModelCalled: true, node: process.version, sessionId: binding.sessionId, tools, promptCharacters: assembly.sections.reduce((n, s) => n + s.text.length, 0), promptTokenEstimate: { before: state.beforeTokens, after: estimate(assembly), method: 'DSH heuristic over serialized prompt sections, contexts and tool schemas; not provider billing' }, note: '已创建真实宿主 Session、挂载受限工具并释放；未 followup，未发送模型请求。' };
    } catch (error) { this.service.updateBinding(binding, { status: 'error', error: error.message, finishedAt: new Date().toISOString() }); throw error; }
    finally { await handle?.dispose(); for (const fn of state.disposers.reverse()) await fn(); }
  }
  async close() { this.closed = true; await Promise.allSettled([...this.live.values()].map(s => this.retire(s, 'interrupted', '健身房插件卸载，未自动续跑'))); }
}
