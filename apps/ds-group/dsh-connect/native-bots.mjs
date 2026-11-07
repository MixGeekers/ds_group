import { KERNEL_API, KERNEL_ID, KERNEL_API_VERSION } from './kernel-runtime.mjs';

/** The authenticated DSH host carries one explicitly identified DSCord kernel. */
export class NativeBots {
  constructor(ctx, { ensureTeam } = {}) { this.ctx = ctx; this.ensureTeam = ensureTeam; this.queues = new Map(); }

  async enqueue(id, operation) {
    const queued = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, queued);
    try { return await queued; }
    finally { if (this.queues.get(id) === queued) this.queues.delete(id); }
  }

  async request(endpoint, payload = {}) {
    const handler = this.ctx.connection.createSharedFetchHandler('/api');
    const response = await handler.fetch(new Request(`http://localhost${KERNEL_API}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }),
    }), this.ctx.connection.browserPeer);
    if (!response.ok) throw Object.assign(new Error('DSCord 自有内核尚不可用'), { code: 'DSCORD_KERNEL_UNAVAILABLE', status: response.status });
    const result = await response.json();
    if (!result.ok) throw Object.assign(new Error(result.error?.message || 'DSCord 内核操作失败'), { code: result.error?.code, details: result.error?.details });
    return result.value;
  }

  async ensure() {
    if (this.starting) return this.starting;
    const starting = (async () => {
      let info;
      try { info = await this.request('kernel-info'); }
      catch (error) {
        if (error.status !== 404 || !this.ensureTeam) throw error;
        this.runtime = await this.ensureTeam();
        info = await this.request('kernel-info');
      }
      if (info?.runtime?.id !== KERNEL_ID || info.runtime.apiVersion !== KERNEL_API_VERSION) {
        throw Object.assign(new Error('此地址的运行时不是兼容的 DSCord 自有内核'), { code: 'DSCORD_KERNEL_INCOMPATIBLE', details: { runtime: info?.runtime ?? null } });
      }
      if (info.runtime.status && info.runtime.status !== 'running') {
        throw Object.assign(new Error('DSCord 内核仍在启动或已停止，请稍后重试'), { code: 'DSCORD_KERNEL_NOT_READY', details: { runtime: info.runtime } });
      }
      this.runtimeInfo = info.runtime;
      this.bundled = true;
      return info.runtime;
    })();
    this.starting = starting;
    try { return await starting; }
    catch (error) { if (this.starting === starting) this.starting = undefined; throw error; }
  }

  async call(endpoint, payload = {}) {
    await this.ensure();
    return this.request(endpoint, payload);
  }

  async info() { await this.ensure(); return this.request('kernel-info'); }

  async state() { return this.call('state'); }

  async list() {
    const state = await this.state();
    if (state.readOnly) throw new Error(state.readOnly);
    return state.bots.map(bot => ({ id: bot.id, name: bot.name, role: bot.role || '',
      model: bot.model || state.defaultModel || '', main: state.mainBotIds.includes(bot.id),
      ...(bot.owner === undefined ? {} : { owner: bot.owner }),
      ...(bot.creationSource === undefined ? {} : { creationSource: bot.creationSource }) }));
  }

  async bot(id) {
    const state = await this.state();
    const bot = state.bots.find(bot => bot.id === id);
    if (!bot) throw new Error('本机原生 Bot 不存在；请恢复原 Bot 或重新选择');
    return { ...bot, model: bot.model || state.defaultModel };
  }

  async models() {
    await this.call('models');
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
