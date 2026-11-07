import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { httpUrl } from '../scripts/runtime-config.mjs';
import { importNodeBundle } from '../scripts/server-admin.mjs';
import { readOptionalJson, savePrivateJson } from '../scripts/server-init.mjs';
import { availablePort, NodeProcesses } from './processes.mjs';
import { LEGACY_MODEL, checkModelPolicy } from '../src/model-config.mjs';

function publicBot(bot) {
  return { id: bot.id, name: bot.name || bot.localpart, localpart: bot.localpart,
    ...(bot.ownerId ? { ownerId: bot.ownerId } : {}),
    ...(bot.nativeBinding ? { nativeBinding: bot.nativeBinding } : {}) };
}

export class ConnectController {
  constructor({ directory, sourceHome, sourceProfile, processes, models, native, request = fetch, selectPort = availablePort }) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, 'connection.json');
    this.processes = processes || new NodeProcesses({ sourceHome, sourceProfile });
    this.request = request;
    this.selectPort = selectPort;
    this.models = models;
    this.native = native;
    this.state = { schemaVersion: 1, serverUrl: '', user: null, accessToken: null, bots: [], nodes: {} };
    this.running = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async initialize() {
    const saved = await readOptionalJson(this.filename);
    if (saved) {
      if (saved.schemaVersion !== 1) throw new Error('连接配置版本不受支持');
      this.state = saved;
    }
    this.state.modelSelections ||= {};
    this.state.attentionModes ||= {};
    this.state.nativeCreationRequests ||= {};
    if (this.native && !this.state.hostId) { this.state.hostId = randomUUID(); await this.save(); }
    await this.processes.configure?.({ directory: this.directory });
    for (const node of Object.values(this.state.nodes)) {
      if (Object.hasOwn(this.state.modelSelections, node.id)) continue;
      const prepared = await readOptionalJson(path.join(node.directory, `dsh-${node.localpart}`, 'node-config.json'));
      if (prepared?.model) {
        const legacyEffort = prepared.modelConfigVersion === undefined && prepared.model === LEGACY_MODEL ? 'low' : undefined;
        const reasoningEffort = prepared.reasoningEffort ?? legacyEffort;
        this.state.modelSelections[node.id] = { model: prepared.model, maxTokens: prepared.maxTokens || 4096,
          ...(reasoningEffort ? { reasoningEffort } : {}) };
      }
    }
    this.runtime = await this.processes.available();
    this.restoring = this.serial(async () => {
      for (const node of Object.values(this.state.nodes)) {
        if (!node.desired || this.closed) continue;
        try { await this.start(node); } catch { /* The status page retains each startup error. */ }
      }
    });
    return this;
  }

  serial(operation) {
    const work = this.queue.then(operation);
    this.queue = work.catch(() => {});
    return work;
  }

  async save(state = this.state) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await savePrivateJson(this.filename, state);
  }

  async remote(serverUrl, pathname, { method = 'GET', token, body } = {}) {
    const response = await this.request(`${serverUrl}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : `服务器请求失败 (${response.status})`);
      error.code = response.status === 401 ? 'dscord/login-required' : 'dscord/server-error';
      throw error;
    }
    return data;
  }

  async status({ refresh = true } = {}) {
    let lastError = null;
    if (refresh) this.runtime = await this.processes.available();
    if (refresh && this.state.accessToken && !this.closed) {
      const { serverUrl, accessToken } = this.state;
      try {
        const { bots } = await this.remote(serverUrl, '/api/bots', { token: accessToken });
        if (!Array.isArray(bots)) throw new Error('服务器没有返回 Bot 列表');
        if (serverUrl === this.state.serverUrl && accessToken === this.state.accessToken) this.state.bots = bots.map(publicBot);
      } catch (error) { lastError = error.message; }
    }
    const bots = await Promise.all(this.state.bots.map(async bot => {
      const node = this.state.nodes[bot.id];
      const active = this.running.get(bot.id);
      let current = active || { status: 'offline', lastError: null };
      if (node && active?.status === 'online') current = await this.processes.probe(node);
      return { ...bot, ...current, connected: Boolean(node?.desired),
        modelSelection: this.state.modelSelections?.[bot.id] ?? null,
        activeModel: current.status === 'online' ? current.modelConfig ?? active?.modelConfig ?? null : null };
    }));
    let nativeBots = [];
    if (this.native) {
      try { nativeBots = await this.ownedNativeBots(); } catch (error) { lastError ||= error.message; }
      for (const bot of bots) {
        const local = nativeBots.find(local => local.id === bot.nativeBinding?.nativeBotId && bot.nativeBinding.hostId === this.state.hostId);
        if (local) { bot.modelSelection = local.model ? { model: local.model } : null; bot.nativeBotId = local.id; }
      }
    }
    return { serverUrl: this.state.serverUrl, user: this.state.user, bots, runtime: this.runtime,
      ...(this.native ? { nativeBots, hostId: this.state.hostId, nativeMode: true, nativeBundled: this.native.bundled === true } : {}),
      dataDirectory: this.directory, lastError, modelPolicy: this.modelPolicy,
      models: this.native ? await this.native.models().catch(() => ({ available: false })) : this.models ? await this.models.view() : { available: false } };
  }

  async ownedNativeBots() {
    const bots = await this.native.list();
    return bots.filter(bot => !this.state.user || !bot.owner?.id || bot.owner.id === this.state.user.id);
  }

  async ownedNativeBot(id, { claim = false } = {}) {
    if (!this.native) throw new Error('DSCORD_KERNEL_UNAVAILABLE');
    const bot = await this.native.bot(id);
    if (this.state.user && bot.owner?.id && bot.owner.id !== this.state.user.id) {
      throw Object.assign(new Error('请选择属于当前账号的 Bot'), { code: 'BOT_OWNER_CONFLICT' });
    }
    if (claim && this.state.user && !bot.owner?.id) {
      await this.native.call('claim-bot', { id, owner: { ...this.state.user, kind: 'human' },
        source: { sender: { ...this.state.user, kind: 'human' }, transport: 'matrix' } });
    }
    return bot;
  }

  async createNative(body) {
    if (!this.native) throw new Error('DSCORD_KERNEL_UNAVAILABLE');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    if (!name || name.length > 120 || role.length > 4000) throw new Error('请输入有效的 Bot 名称和职责');
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(body.requestId)) throw new Error('创建请求缺少有效的标识');
    await this.modelSource({ model: body.model });
    const hash = createHash('sha256').update(JSON.stringify({ name, role, model: body.model,
      ownerId: this.state.user?.id || null })).digest('hex');
    const prior = this.state.nativeCreationRequests[body.requestId];
    if (prior && prior.hash !== hash) throw new Error('同一创建请求的内容已经变化');
    if (prior?.nativeBotId) {
      await this.ownedNativeBot(prior.nativeBotId);
      return this.status({ refresh: false });
    }
    this.state.nativeCreationRequests[body.requestId] = { hash, status: 'creating' };
    await this.save();
    const sender = this.state.user ? { ...this.state.user, kind: 'human' }
      : { id: `local-user:${this.state.hostId}`, name: 'Local user', kind: 'human' };
    try {
      const created = await this.native.call('create-bot', { name, role, model: body.model, greet: false,
        requestId: body.requestId, ...(this.state.user ? { owner: sender } : {}),
        source: { sender, requestId: body.requestId, transport: this.state.user ? 'matrix' : 'native' } });
      const id = created?.id || created?.bot?.id;
      if (!id) throw new Error('内核没有返回新建 Bot 的身份');
      this.state.nativeCreationRequests[body.requestId] = { hash, status: 'completed', nativeBotId: id };
      await this.save();
    } catch (error) {
      this.state.nativeCreationRequests[body.requestId] = { hash, status: 'unknown' };
      await this.save();
      throw error;
    }
    await this.publishNative();
    return this.status({ refresh: false });
  }

  async login({ serverUrl: input, user, password }) {
    const serverUrl = httpUrl(String(input || '').trim(), '服务器地址');
    if (typeof user !== 'string' || !user.trim() || typeof password !== 'string' || !password) throw new Error('请输入账号和密码');
    const login = await this.remote(serverUrl, '/api/login', { method: 'POST', body: { user: user.trim(), password } });
    if (!login.access_token || !login.user_id) throw new Error('服务器登录响应不完整');
    let bots;
    try {
      ({ bots } = await this.remote(serverUrl, '/api/bots', { token: login.access_token }));
      if (!Array.isArray(bots)) throw new Error('服务器没有返回 Bot 列表');
    } catch (error) {
      await this.remote(serverUrl, '/api/logout', { method: 'POST', token: login.access_token, body: {} }).catch(() => {});
      throw error;
    }
    const sameIdentity = serverUrl === this.state.serverUrl && login.user_id === this.state.user?.id;
    const previous = { serverUrl: this.state.serverUrl, accessToken: this.state.accessToken };
    const next = {
      schemaVersion: 1, serverUrl, user: { id: login.user_id, name: login.user?.name || login.user_id },
      accessToken: login.access_token, bots: bots.map(publicBot), nodes: sameIdentity ? this.state.nodes : {},
      modelSelections: sameIdentity ? this.state.modelSelections : {},
      attentionModes: sameIdentity ? this.state.attentionModes : {},
      nativeCreationRequests: this.state.nativeCreationRequests || {},
      ...(this.state.hostId ? { hostId: this.state.hostId } : {}),
    };
    try {
      if (!sameIdentity) await this.stopAll(false);
      await this.save(next);
    } catch (error) {
      if (previous.accessToken !== login.access_token) {
        await this.remote(serverUrl, '/api/logout', { method: 'POST', token: login.access_token, body: {} }).catch(() => {});
      }
      throw error;
    }
    this.state = next;
    if (!sameIdentity) this.modelPolicy = undefined;
    if (previous.accessToken && previous.accessToken !== login.access_token) {
      await this.remote(previous.serverUrl, '/api/logout', { method: 'POST', token: previous.accessToken, body: {} }).catch(() => {});
    }
    if (this.native) await this.publishNative();
    return this.status({ refresh: false });
  }

  async publishNative() {
    if (!this.native || !this.state.accessToken || this.closed) return;
    await this.remote(this.state.serverUrl, '/api/bot-catalog', { method: 'POST', token: this.state.accessToken,
      body: { hostId: this.state.hostId, label: hostname(), bots: await this.ownedNativeBots() } });
  }

  synchronizeNative() {
    return this.serial(async () => {
      if (!this.native || !this.state.accessToken || this.closed) return;
      await this.publishNative();
      const { bots } = await this.remote(this.state.serverUrl, '/api/bots', { token: this.state.accessToken });
      this.state.bots = bots.map(publicBot);
      for (const bot of bots) {
        if (bot.nativeBinding?.hostId !== this.state.hostId || this.closed) continue;
        const node = this.state.nodes[bot.id];
        const active = this.running.get(bot.id);
        if (node && (!node.desired || ['online', 'connecting'].includes(active?.status))) continue;
        try { await this.connect(bot.id); }
        catch (error) {
          if (!this.closed) this.running.set(bot.id, { status: 'error', lastError: error.message });
        }
      }
    });
  }

  async writeBundle(bot, bundle, directory) {
    if (bundle?.schemaVersion !== 1 || !bundle.coreConfig?.nodeSecret || !bundle.coreUrl) throw new Error('服务器返回的节点配置不完整');
    if (bundle?.nodeId !== bot.localpart || !/^[a-zA-Z0-9_-]+$/.test(bot.localpart)) throw new Error('服务器返回的 Bot 身份不匹配');
    if (['all', 'core'].includes(bot.localpart)) throw new Error('Bot 账号与服务命令保留名称冲突');
    const identity = bundle.setup?.participants?.find(item => item.id === bot.id && item.kind === 'bot');
    if (!identity?.accessToken || identity.localpart !== bot.localpart) throw new Error('服务器没有返回所选 Bot 的节点凭据');
    const prior = await readOptionalJson(path.join(directory, 'matrix-setup.json'));
    if (!prior) return importNodeBundle(bundle, directory);
    const previousBot = prior.participants?.find(item => item.accessToken && item.kind === 'bot');
    if (previousBot?.id !== bot.id || prior.homeserverUrl !== bundle.setup.homeserverUrl) throw new Error('节点目录属于另一个 Bot');
    // The account identity is stable while roster, public names and credentials can change.
    await savePrivateJson(path.join(directory, 'matrix-setup.json'), bundle.setup);
    await savePrivateJson(path.join(directory, 'core-config.json'), bundle.coreConfig);
  }

  async connect(botId) {
    if (!this.state.accessToken) throw new Error('请先登录服务器');
    const { bots } = await this.remote(this.state.serverUrl, '/api/bots', { token: this.state.accessToken });
    const bot = bots?.find(item => item.id === botId);
    if (!bot) throw new Error('请选择自己的 Bot');
    this.state.bots = bots.map(publicBot);
    const existing = this.state.nodes[botId];
    if (existing && this.running.get(botId)?.status === 'online' && (await this.processes.probe(existing)).status === 'online') {
      return this.status({ refresh: false });
    }
    this.runtime = await this.processes.available();
    if (!this.runtime.available) throw new Error(this.runtime.message);
    const local = this.native ? await this.ownedNativeBot(bot.nativeBinding?.hostId === this.state.hostId ? bot.nativeBinding.nativeBotId : '', { claim: true }) : undefined;
    const source = this.models ? await this.modelSource(local ? { model: local.model, reasoningEffort: local.effort } : this.state.modelSelections?.[botId]) : undefined;
    if (this.closed) throw new Error('连接插件正在关闭');
    if (existing && this.running.has(botId)) await this.stop(existing, false);
    const { bundle } = await this.remote(this.state.serverUrl, `/api/bots/${encodeURIComponent(botId)}/connect`, {
      method: 'POST', token: this.state.accessToken, body: {},
    });
    if (this.closed) throw new Error('连接插件正在关闭');
    const key = createHash('sha256').update(`${this.state.serverUrl}\n${botId}`).digest('hex').slice(0, 24);
    const directory = path.join(this.directory, 'nodes', key);
    await this.writeBundle(bot, bundle, directory);
    const node = { ...publicBot(bot), directory, serverUrl: this.state.serverUrl,
      ...(local ? { nativeBotId: local.id } : {}),
      ...(local && this.state.attentionModes[local.id] ? { attention: { mode: this.state.attentionModes[local.id] } } : {}),
      ...(!local ? { port: existing?.port || await this.selectPort() } : {}), desired: true };
    if (this.closed) throw new Error('连接插件正在关闭');
    const next = { ...this.state, nodes: { ...this.state.nodes, [botId]: node } };
    await this.save(next);
    this.state = next;
    await this.start(node, source);
    return this.status({ refresh: false });
  }

  async modelSource(selection) {
    const source = this.native ? { selection: { ...selection } } : await this.models.export(selection);
    if (this.native) {
      const catalog = await this.native.models();
      const model = catalog.providers.flatMap(provider => provider.models).find(model => model.model === selection?.model);
      if (!model) throw Object.assign(new Error('请在 DSH 中选择可用模型'), { code: 'MODEL_UNAVAILABLE' });
      if (model.needsKey) throw Object.assign(new Error('请在 DSH 中配置模型凭据'), { code: 'MISSING_CREDENTIAL' });
      return source;
    }
    const { budget } = await this.remote(this.state.serverUrl, '/api/status', { token: this.state.accessToken });
    this.modelPolicy = { maxTokens: budget?.maxTokens, allowedModels: budget?.allowedModels ?? null };
    checkModelPolicy(source.selection, this.modelPolicy);
    return source;
  }

  async start(node, preparedSource) {
    if (this.closed) throw new Error('连接插件正在关闭');
    this.running.set(node.id, { status: 'connecting', lastError: null });
    try {
      let modelConfig;
      if (this.models && !node.nativeBotId) {
        const source = preparedSource ?? await this.modelSource(this.state.modelSelections?.[node.id]);
        modelConfig = source.selection;
        await savePrivateJson(path.join(node.directory, 'model-source.json'), source);
        if (!this.state.modelSelections[node.id]) {
          const next = { ...this.state, modelSelections: { ...this.state.modelSelections, [node.id]: source.selection } };
          await this.save(next);
          this.state = next;
        }
      }
      await this.processes.start(node);
      if (this.closed) await this.processes.stop(node);
      else this.running.set(node.id, { status: 'online', lastError: null, modelConfig });
    } catch (error) {
      let message = error.message;
      if (!this.closed) {
        try { await this.processes.stop(node); } catch (stopError) { message += `\n${stopError.message}`; }
        this.running.set(node.id, { status: 'error', lastError: message });
      }
      throw Object.assign(new Error(message), { code: error.code });
    }
  }

  async stop(node, clearDesired) {
    if (clearDesired) {
      const next = { ...this.state, nodes: { ...this.state.nodes, [node.id]: { ...node, desired: false } } };
      await this.save(next);
      this.state = next;
    }
    if (this.running.has(node.id)) await this.processes.stop(node);
    this.running.delete(node.id);
  }

  async stopAll(clearDesired) {
    if (clearDesired) {
      const nodes = Object.fromEntries(Object.entries(this.state.nodes).map(([id, node]) => [id, { ...node, desired: false }]));
      const next = { ...this.state, nodes };
      await this.save(next);
      this.state = next;
    }
    // Start every cleanup before awaiting any one Bot's drain or the host shutdown deadline.
    const results = await Promise.allSettled(Object.values(this.state.nodes).map(node => this.stop(node, false)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }

  async logout() {
    await this.stopAll(true);
    const previous = this.state;
    const next = { ...previous, user: null, accessToken: null, bots: [] };
    await this.save(next);
    this.state = next;
    if (previous.accessToken) {
      await this.remote(previous.serverUrl, '/api/logout', { method: 'POST', token: previous.accessToken, body: {} }).catch(() => {});
    }
    return this.status({ refresh: false });
  }

  async handle(body) {
    if (this.closed) throw new Error('连接插件正在关闭');
    if (body.action === 'status') return this.status();
    if (body.action === 'kernel-state') {
      if (body.nativeBotId) await this.ownedNativeBot(body.nativeBotId);
      const value = await this.processes.kernelState(body.nativeBotId);
      const desired = this.state.attentionModes[body.nativeBotId];
      return { ...value, ...(desired ? { desiredAttention: { mode: desired,
        status: value.attention?.mode === desired ? 'applied' : 'pending' } } : {}) };
    }
    if (body.action === 'memory-profile') {
      await this.ownedNativeBot(body.nativeBotId);
      return this.native.call(body.id ? 'memory-profile' : 'memory-profiles', {
        botId: body.nativeBotId, kind: body.kind, ...(body.id ? { id: body.id } : {}),
        ...(body.roomId ? { roomId: body.roomId } : {}), ...(body.query ? { query: body.query } : {}) });
    }
    return this.serial(async () => {
      if (this.closed) throw new Error('连接插件正在关闭');
      switch (body.action) {
        case 'create-native': return this.createNative(body);
        case 'save-decision-provider': return this.processes.saveDecisionProvider({ apiKey: body.apiKey, enabled: body.enabled,
          model: body.model, endpoint: body.endpoint });
        case 'attention-update': {
          await this.ownedNativeBot(body.nativeBotId);
          if (!['mention', 'shadow', 'natural'].includes(body.mode)) throw new Error('请选择有效的参与方式');
          this.state.attentionModes[body.nativeBotId] = body.mode;
          await this.save();
          let result = { mode: body.mode, status: 'pending', online: false };
          for (const node of Object.values(this.state.nodes).filter(node => node.nativeBotId === body.nativeBotId)) {
            if (!this.state.accessToken || node.serverUrl !== this.state.serverUrl) continue;
            result = await this.remote(node.serverUrl, `/api/bots/${encodeURIComponent(node.id)}/attention`, {
              method: 'PATCH', token: this.state.accessToken, body: { mode: body.mode } });
          }
          return result;
        }
        case 'save-model': {
          if (!this.models || !this.state.accessToken || !this.state.bots.some(bot => bot.id === body.botId)) throw new Error('请选择自己的 Bot');
          const prior = this.state.modelSelections?.[body.botId];
          const selection = body.selection && { ...body.selection, maxTokens: body.selection.maxTokens ?? prior?.maxTokens ?? 4096 };
          const source = await this.modelSource(selection);
          if (this.native) {
            const bot = this.state.bots.find(bot => bot.id === body.botId);
            if (bot.nativeBinding?.hostId !== this.state.hostId) throw new Error('请选择本机已经绑定的 Bot');
            await this.native.selectModel(bot.nativeBinding.nativeBotId, source.selection);
            await this.publishNative();
            return this.status({ refresh: false });
          }
          const next = { ...this.state, modelSelections: { ...this.state.modelSelections, [body.botId]: source.selection } };
          await this.save(next);
          this.state = next;
          return this.status({ refresh: false });
        }
        case 'login': return this.login(body);
        case 'attach': {
          if (!this.native || !this.state.accessToken) throw new Error('请先登录并启用原生 DS-Bot');
          await this.ownedNativeBot(body.nativeBotId, { claim: true });
          await this.publishNative();
          const { bot } = await this.remote(this.state.serverUrl, '/api/bots/attach', { method: 'POST', token: this.state.accessToken,
            body: { hostId: this.state.hostId, nativeBotId: body.nativeBotId, ...(body.botId ? { botId: body.botId } : {}) } });
          return this.connect(bot.id);
        }
        case 'logout': return this.logout();
        case 'connect': return this.connect(body.botId);
        case 'disconnect': {
          const node = this.state.nodes[body.botId];
          if (node) await this.stop(node, true);
          return this.status({ refresh: false });
        }
        default: throw new Error('未知连接操作');
      }
    });
  }

  async dispose() {
    this.closed = true;
    const cleanup = this.stopAll(false).then(() => null, error => error);
    await this.queue;
    const error = await cleanup;
    if (error) throw error;
  }
}
