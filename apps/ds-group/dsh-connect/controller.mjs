import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { httpUrl } from '../scripts/runtime-config.mjs';
import { importNodeBundle } from '../scripts/server-admin.mjs';
import { readOptionalJson, savePrivateJson } from '../scripts/server-init.mjs';
import { availablePort, NodeProcesses } from './processes.mjs';

function publicBot(bot) {
  return { id: bot.id, name: bot.name || bot.localpart, localpart: bot.localpart };
}

export class ConnectController {
  constructor({ directory, sourceHome, sourceProfile, processes, request = fetch, selectPort = availablePort }) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, 'connection.json');
    this.processes = processes || new NodeProcesses({ sourceHome, sourceProfile });
    this.request = request;
    this.selectPort = selectPort;
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
      return { ...bot, ...current, connected: Boolean(node?.desired) };
    }));
    return { serverUrl: this.state.serverUrl, user: this.state.user, bots, runtime: this.runtime,
      dataDirectory: this.directory, lastError };
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
    if (previous.accessToken && previous.accessToken !== login.access_token) {
      await this.remote(previous.serverUrl, '/api/logout', { method: 'POST', token: previous.accessToken, body: {} }).catch(() => {});
    }
    return this.status({ refresh: false });
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
    if (existing && this.running.has(botId)) await this.stop(existing, false);
    const { bundle } = await this.remote(this.state.serverUrl, `/api/bots/${encodeURIComponent(botId)}/connect`, {
      method: 'POST', token: this.state.accessToken, body: {},
    });
    const key = createHash('sha256').update(`${this.state.serverUrl}\n${botId}`).digest('hex').slice(0, 24);
    const directory = path.join(this.directory, 'nodes', key);
    await this.writeBundle(bot, bundle, directory);
    const node = { ...publicBot(bot), directory, serverUrl: this.state.serverUrl,
      port: existing?.port || await this.selectPort(), desired: true };
    const next = { ...this.state, nodes: { ...this.state.nodes, [botId]: node } };
    await this.save(next);
    this.state = next;
    await this.start(node);
    return this.status({ refresh: false });
  }

  async start(node) {
    this.running.set(node.id, { status: 'connecting', lastError: null });
    try {
      await this.processes.start(node);
      this.running.set(node.id, { status: 'online', lastError: null });
    } catch (error) {
      let message = error.message;
      try { await this.processes.stop(node); } catch (stopError) { message += `\n${stopError.message}`; }
      this.running.set(node.id, { status: 'error', lastError: message });
      throw new Error(message);
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
    const errors = [];
    for (const node of Object.values(this.state.nodes)) {
      try { await this.stop(node, clearDesired); } catch (error) { errors.push(error); }
    }
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
    return this.serial(async () => {
      if (this.closed) throw new Error('连接插件正在关闭');
      switch (body.action) {
        case 'login': return this.login(body);
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
    await this.queue;
    await this.stopAll(false);
  }
}
