import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { BotNode, createTaskClient, createRosterClient, acquireNodeLock } from '../src/bot-node.mjs';
import { createDeliveryClient } from '../src/node-delivery.mjs';
import { createNodeWorkClient } from '../src/node-work.mjs';
import { NodeStore } from '../src/node-store.mjs';
import { NodeFiles } from '../src/node-files.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';
import { readOptionalJson } from '../scripts/server-init.mjs';
import { savePrivateJson } from '../scripts/server-init.mjs';
import { NativeBridge } from './native-bridge.mjs';
import { DecisionSettings } from './decision-settings.mjs';
import { KernelNodeClient } from '../src/kernel-node-client.mjs';

export class NativeConnections {
  constructor({ ctx, native, decisionSettings, enableKernelControl = true }) {
    Object.assign(this, { ctx, native, decisionSettings, enableKernelControl });
    this.connections = new Map();
  }

  async configure({ directory }) {
    this.directory = directory;
    this.decisionSettings ||= await new DecisionSettings({ directory }).initialize();
  }

  decisionStatus() {
    return this.decisionSettings?.publicStatus() || { configured: false, available: false, enabled: true, model: 'gpt-6-luna', health: 'unconfigured' };
  }

  async saveDecisionProvider(settings) {
    if (!this.decisionSettings) throw new Error('DECISION_SETTINGS_UNAVAILABLE');
    await this.decisionSettings.save(settings);
    for (const entry of this.connections.values()) entry.botNode.setDecisionProvider(this.decisionSettings.provider);
    return this.decisionStatus();
  }

  async available() {
    try {
      const { runtime } = await this.native.info();
      return { available: true, mode: 'native', runtime };
    }
    catch (error) { return { available: false, mode: 'native', message: error.message }; }
  }

  async start(node) {
    if (!node.nativeBotId) throw new Error('请先为此服务器账号绑定一个已有的原生 Bot');
    if (this.connections.has(node.id)) return;
    if (!this.decisionSettings) await this.configure({ directory: this.directory || node.directory });
    const setup = await readOptionalJson(path.join(node.directory, 'matrix-setup.json'));
    const config = await readOptionalJson(path.join(node.directory, 'core-config.json'));
    const participant = setup.participants.find(bot => bot.id === node.id);
    const directory = path.join(node.directory, 'nodes', node.localpart);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await acquireNodeLock(path.join(directory, 'process.lock'));
    let bridge;
    let store;
    const entry = { node, release };
    try {
      const work = createNodeWorkClient(node.serverUrl, config.nodeSecret, node.id);
      const matrix = new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken: participant.accessToken });
      bridge = await new NativeBridge({ ctx: this.ctx, native: this.native, node }).initialize();
      store = new NodeStore(path.join(directory, 'node.sqlite'), node.id);
      const savedAttention = await readOptionalJson(path.join(node.directory, 'attention.json'));
      const botNode = new BotNode({ participant, participants: setup.participants, roomId: setup.roomId, matrix, store, bridge, work,
        executionMode: 'native', attention: savedAttention || node.attention || { mode: 'mention' },
        decisionProvider: this.decisionSettings?.provider,
        observe: input => bridge.observe({ ...input, participants: botNode.participants,
          rooms: Object.fromEntries([...new Set(input.events.map(event => event.room_id))]
            .map(roomId => [roomId, store.roomContext(roomId)])) }),
        readAttentionView: input => bridge.readAttentionView(input),
        files: new NodeFiles({ coreUrl: node.serverUrl, accessToken: participant.accessToken, directory: path.join(directory, 'tasks'), work, matrix }),
        tasks: createTaskClient(node.serverUrl, config.nodeSecret),
        delivery: createDeliveryClient(node.serverUrl, participant.accessToken),
        roster: createRosterClient(node.serverUrl, participant.accessToken),
        onError: message => { entry.lastError = message; },
        heartbeat: async body => {
          const kernel = await bridge.kernelState();
          const response = await fetch(new URL('/internal/nodes/heartbeat', node.serverUrl), { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.nodeSecret}` },
            body: JSON.stringify({ ...body, engine: 'DSCord kernel', executionMode: 'native',
              kernel: { runtime: kernel.runtime, work: kernel.work, memorySummary: kernel.memorySummary,
                attention: botNode.attentionStatus() },
              ...(this.enableKernelControl ? { kernelControl: { version: 1 } } : {}) }), signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error(`Core heartbeat HTTP ${response.status}`);
        },
      });
      Object.assign(entry, { bridge, botNode });
      await botNode.start();
      if (this.enableKernelControl) {
        entry.control = new KernelNodeClient({ coreUrl: node.serverUrl, nodeSecret: config.nodeSecret,
          botId: node.id, nodeId: participant.localpart, runtimeId: botNode.runtimeId,
          operations: {
            configureAttention: setting => this.applyAttention(entry, setting),
            memoryProfiles: options => bridge.memoryProfiles(options),
            memoryProfile: options => bridge.memoryProfile(options),
          }, onError: code => { entry.controlError = code; } });
        entry.control.start();
      }
      this.connections.set(node.id, entry);
    } catch (error) {
      await entry.control?.stop();
      await entry.botNode?.stop();
      await bridge?.detach();
      store?.close();
      await release();
      throw error;
    }
  }

  async stop(node) {
    const entry = this.connections.get(node.id);
    if (!entry) return;
    this.connections.delete(node.id);
    await entry.control?.stop();
    await entry.bridge.detach();
    await entry.botNode.stop();
    await entry.release();
  }

  async probe(node) {
    const entry = this.connections.get(node.id);
    if (!entry) return { status: 'offline', lastError: null };
    const status = await entry.bridge.runtimeStatus();
    return { status: entry.botNode.lastError ? 'error' : 'online', lastError: entry.botNode.lastError,
      ...status, attention: entry.botNode.attentionStatus() };
  }

  async applyAttention(entry, setting) {
    const state = entry.botNode.configureAttention(setting);
    await savePrivateJson(path.join(entry.node.directory, 'attention.json'), { mode: state.mode, revision: state.revision });
    return state;
  }

  async configureAttention(nativeBotId, setting) {
    await this.native.bot(nativeBotId);
    const entries = [...this.connections.values()].filter(entry => entry.node.nativeBotId === nativeBotId);
    const states = [];
    for (const entry of entries) states.push(await this.applyAttention(entry, setting));
    return states[0] || { mode: setting.mode, activity: 'unknown', online: false, provider: this.decisionStatus() };
  }

  async kernelState(nativeBotId) {
    if (!nativeBotId) return { ...await this.native.info(), decisionProvider: this.decisionStatus() };
    const entry = [...this.connections.values()].find(entry => entry.node.nativeBotId === nativeBotId);
    const bridge = entry?.bridge || new NativeBridge({ ctx: this.ctx, native: this.native,
      node: { id: null, nativeBotId, directory: this.directory } });
    return { ...await bridge.kernelState(),
      attention: entry?.botNode.attentionStatus() || { mode: 'mention', activity: 'unknown', provider: this.decisionStatus(), online: false },
      decisionProvider: this.decisionStatus() };
  }
}
