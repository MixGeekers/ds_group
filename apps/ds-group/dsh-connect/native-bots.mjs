/** Use the installed DS-Bot's owner API inside the authenticated DSH host.
 * No second runtime, state-file edits, copied models or replacement tool scopes. */
export class NativeBots {
  constructor(ctx, { ensureTeam } = {}) { this.ctx = ctx; this.ensureTeam = ensureTeam; this.queues = new Map(); }

  async enqueue(id, operation) {
    const queued = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, queued);
    try { return await queued; }
    finally { if (this.queues.get(id) === queued) this.queues.delete(id); }
  }

  async call(endpoint, payload = {}) {
    const handler = this.ctx.connection.createSharedFetchHandler('/api');
    const response = await handler.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }),
    }), this.ctx.connection.browserPeer);
    if (response.status === 404 && this.ensureTeam) {
      this.starting ||= this.ensureTeam();
      await this.starting;
      this.bundled = true;
      this.ensureTeam = undefined;
      return this.call(endpoint, payload);
    }
    if (!response.ok) throw Object.assign(new Error('请先在此 DSH 中启用原生 DS-Bot 插件'), { code: 'NATIVE_BOT_UNAVAILABLE' });
    const result = await response.json();
    if (!result.ok) throw Object.assign(new Error(result.error?.message || 'DS-Bot 操作失败'), { code: result.error?.code });
    return result.value;
  }

  async state() { return this.call('state'); }

  async list() {
    const state = await this.state();
    if (state.readOnly) throw new Error(state.readOnly);
    return state.bots.map(bot => ({ id: bot.id, name: bot.name, role: bot.role || '',
      model: bot.model || state.defaultModel || '', main: state.mainBotIds.includes(bot.id) }));
  }

  async bot(id) {
    const state = await this.state();
    const bot = state.bots.find(bot => bot.id === id);
    if (!bot) throw new Error('本机原生 Bot 不存在；请恢复原 Bot 或重新选择');
    return { ...bot, model: bot.model || state.defaultModel };
  }

  async models() {
    const state = await this.state();
    const providers = new Map();
    for (const model of state.models) {
      const id = model.ref.slice(0, model.ref.indexOf('/'));
      if (!providers.has(id)) providers.set(id, { id, name: id, models: [] });
      providers.get(id).models.push({ model: model.ref, name: model.name || model.ref, needsKey: model.needsKey });
    }
    return { available: true, providers: [...providers.values()], defaultSelection: state.defaultModel ? { model: state.defaultModel } : null };
  }

  async agent(sessionId) {
    const result = await this.ctx.sessionController.resolveAgent(sessionId);
    if (result.error) throw new Error(result.error.message);
    return result.agent;
  }

  async selectModel(id, selection) {
    await this.call('update-bot', { id, model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { effort: selection.reasoningEffort }) });
  }
}
