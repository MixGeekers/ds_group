const roles = ['target', 'judge'];
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const defaults = () => ({ target: { mode: 'follow_host' }, judge: { mode: 'follow_host' } });
const selectedModel = value => value?.provider && value?.model ? {
  provider: value.provider, model: value.model,
  ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
} : undefined;
function normalize(raw) {
  if (!object(raw) || Object.keys(raw).some(key => !roles.includes(key)) || roles.some(role => !object(raw[role]))) throw new Error('设置必须包含 target 和 judge，不能包含其他配置');
  return Object.fromEntries(roles.map(role => {
    const value = raw[role];
    if (Object.keys(value).some(key => !['mode', 'model'].includes(key))) throw new Error('模型设置包含不支持的字段');
    if (value.mode === 'follow_host') {
      if (value.model !== undefined) throw new Error('跟随宿主时不能同时指定模型');
      return [role, { mode: 'follow_host' }];
    }
    const model = value.model;
    if (value.mode !== 'explicit' || !object(model) || Object.keys(model).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('独立选择必须提供模型标识；设置不接收凭据或连接地址');
    for (const key of ['provider', 'model']) if (typeof model[key] !== 'string' || !model[key].trim() || model[key].length > 256) throw new Error('provider/model 必须是有效宿主模型标识');
    if (model.reasoningEffort !== undefined && (typeof model.reasoningEffort !== 'string' || !model.reasoningEffort.trim() || model.reasoningEffort.length > 120)) throw new Error('思考强度必须使用宿主提供的标识');
    return [role, { mode: 'explicit', model: selectedModel(model) }];
  }));
}

/** Lab-only preferences. Host providers own credentials, catalogs and inference. */
export class GymSettings {
  constructor(service) { this.service = service; this.writes = Promise.resolve(); }
  initialize() {
    const saved = this.service.state.settings;
    if (saved === undefined) { this.service.state.settings = { revision: 0, settings: defaults() }; return; }
    if (!object(saved) || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('健身房模型设置版本无效');
    this.service.state.settings = { revision: saved.revision, settings: normalize(saved.settings) };
  }
  hostModel() { return selectedModel(this.service.ctx.get('agentDefaultModel')?.currentSelection()); }
  selection(role = 'target') {
    const value = (this.service.state.settings?.settings ?? defaults())[role === 'judge' ? 'judge' : 'target'];
    return value.mode === 'follow_host' ? this.hostModel() : clone(value.model);
  }
  available(role) {
    const value = (this.service.state.settings?.settings ?? defaults())[role];
    return Boolean(this.selection(role) && (value.mode === 'follow_host' || this.service.ctx.get('llm')?.resolveCallConfig));
  }
  snapshot() {
    return { ...clone(this.service.state.settings), hostModel: this.hostModel() ?? null,
      effective: { target: this.selection('target') ?? null, judge: this.selection('judge') ?? null },
      capabilities: { modelSelection: typeof this.service.ctx.get('llm')?.resolveCallConfig === 'function' }, appliesTo: 'new_sessions' };
  }
  async validateModel(model, signal, required = true) {
    signal?.throwIfAborted();
    const llm = this.service.ctx.get('llm');
    if (typeof llm?.resolveCallConfig !== 'function') {
      if (required) throw new Error('当前宿主未提供模型选择服务');
      return model;
    }
    // Public DSH metadata validation; this does not prepare or dispatch inference.
    return selectedModel(await llm.resolveCallConfig(model, signal));
  }
  async resolve(role = 'target', signal) {
    const selected = this.selection(role);
    if (!selected) throw new Error('宿主尚未配置可用模型');
    const mode = (this.service.state.settings?.settings ?? defaults())[role === 'judge' ? 'judge' : 'target'].mode;
    return this.validateModel(selected, signal, mode === 'explicit');
  }
  save(args, signal) {
    const job = this.writes.then(async () => {
      if (this.service.closed) throw new Error('健身房正在关闭');
      signal?.throwIfAborted();
      const settings = normalize(args.settings), expectedRevision = args.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('保存设置需要读取时的 expectedRevision');
      const request = { settings, expectedRevision };
      const existing = this.service.state.requests[`room:settings_save:${args.idempotencyKey}`];
      if (!existing) for (const role of roles) if (settings[role].mode === 'explicit') await this.validateModel(settings[role].model, signal);
      signal?.throwIfAborted();
      return this.service.collaboration.mutate('settings_save', args.idempotencyKey, request, () => {
        this.service.state.settings = { revision: expectedRevision + 1, settings };
        this.service.persist(); return this.snapshot();
      }, false, () => {
        if (this.service.state.settings.revision !== expectedRevision) throw new Error('设置 revision 冲突，请刷新后再保存');
      });
    });
    this.writes = job.catch(() => {}); return job;
  }
  async close() { await this.writes; }
}
