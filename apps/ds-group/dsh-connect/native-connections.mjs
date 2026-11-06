import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { BotNode, createTaskClient, createRosterClient, acquireNodeLock } from '../src/bot-node.mjs';
import { createDeliveryClient } from '../src/node-delivery.mjs';
import { createNodeWorkClient } from '../src/node-work.mjs';
import { NodeStore } from '../src/node-store.mjs';
import { NodeFiles } from '../src/node-files.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';
import { readOptionalJson } from '../scripts/server-init.mjs';
import { NativeBridge } from './native-bridge.mjs';

export class NativeConnections {
  constructor({ ctx, native }) {
    Object.assign(this, { ctx, native });
    this.connections = new Map();
  }

  async available() {
    try { await this.native.list(); return { available: true, mode: 'native' }; }
    catch (error) { return { available: false, mode: 'native', message: error.message }; }
  }

  async start(node) {
    if (!node.nativeBotId) throw new Error('请先为此服务器账号绑定一个已有的原生 Bot');
    if (this.connections.has(node.id)) return;
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
      const botNode = new BotNode({ participant, participants: setup.participants, roomId: setup.roomId, matrix, store, bridge, work,
        files: new NodeFiles({ coreUrl: node.serverUrl, accessToken: participant.accessToken, directory: path.join(directory, 'tasks'), work, matrix }),
        tasks: createTaskClient(node.serverUrl, config.nodeSecret),
        delivery: createDeliveryClient(node.serverUrl, participant.accessToken),
        roster: createRosterClient(node.serverUrl, participant.accessToken),
        onError: message => { entry.lastError = message; },
        heartbeat: async body => {
          const response = await fetch(new URL('/internal/nodes/heartbeat', node.serverUrl), { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.nodeSecret}` },
            body: JSON.stringify({ ...body, engine: 'Native DS-Bot', executionMode: 'native' }), signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw new Error(`Core heartbeat HTTP ${response.status}`);
        },
      });
      Object.assign(entry, { bridge, botNode });
      await botNode.start();
      this.connections.set(node.id, entry);
    } catch (error) {
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
    await entry.bridge.detach();
    await entry.botNode.stop();
    await entry.release();
  }

  async probe(node) {
    const entry = this.connections.get(node.id);
    if (!entry) return { status: 'offline', lastError: null };
    const status = await entry.bridge.runtimeStatus();
    return { status: entry.botNode.lastError ? 'error' : 'online', lastError: entry.botNode.lastError, ...status };
  }
}
