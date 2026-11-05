import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from '../scripts/runtime-config.mjs';

const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function availablePort(start = 23100) {
  for (let port = start; port < Math.min(start + 100, 65536); port++) {
    const server = createServer();
    const available = await new Promise((resolve, reject) => {
      server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error('没有可用的 Bot 本地端口');
}

export class NodeProcesses {
  constructor({ sourceHome, sourceProfile, env = process.env } = {}) {
    this.sourceHome = sourceHome;
    this.sourceProfile = sourceProfile;
    this.env = env;
  }

  async available() {
    try {
      await resolveDsh({ env: this.env });
      return { available: true, message: null };
    } catch (error) {
      return { available: false, message: error.message };
    }
  }

  environment(node) {
    const env = {
      ...this.env,
      DS_GROUP_DATA_DIR: node.directory,
      DS_GROUP_CORE_URL: node.serverUrl,
      DS_GROUP_CORE_CONFIG_PATH: path.join(node.directory, 'core-config.json'),
      DS_GROUP_MATRIX_SETUP_PATH: path.join(node.directory, 'matrix-setup.json'),
      DS_GROUP_BRIDGE_PORT: String(node.port),
      DS_GROUP_BOT_ENDPOINT: `http://127.0.0.1:${node.port}`,
      DS_GROUP_DSH_SOURCE_HOME: this.sourceHome,
      DS_GROUP_DSH_SOURCE_PROFILE: this.sourceProfile,
    };
    delete env.DS_GROUP_MATRIX_URL;
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    return env;
  }

  async command(node, script, args) {
    if (!/^[a-zA-Z0-9_-]+$/.test(node.localpart) || ['all', 'core'].includes(node.localpart)) {
      throw new Error('Bot 账号与服务命令保留名称冲突');
    }
    try {
      await execute(this.env.DS_GROUP_NODE_EXECUTABLE || process.execPath, [path.join(packageRoot, script), ...args], {
        cwd: packageRoot, env: this.environment(node), timeout: 240_000, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const details = String(error.stderr || '').trim().split('\n').filter(Boolean).slice(-5).join('\n');
      throw new Error(details || `Bot 进程命令失败 (${error.code || error.signal || 'unknown'})`);
    }
  }

  async start(node) {
    await this.command(node, 'scripts/service.mjs', ['up', node.localpart]);
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await this.probe(node);
      if (status.status === 'online') return;
      if (status.status === 'error') throw new Error(status.lastError);
      await delay(500);
    }
    throw new Error('Bot 已启动，但服务器尚未确认上线');
  }

  async stop(node) {
    // Drain the Matrix adapter before stopping its isolated DSH runtime.
    await this.command(node, 'scripts/service.mjs', ['down', node.localpart]);
    await this.command(node, 'scripts/dsh-node.mjs', ['stop', node.localpart]);
  }

  async probe(node) {
    try {
      const record = JSON.parse(await readFile(path.join(node.directory, 'processes', `${node.localpart}.json`), 'utf8'));
      const expected = path.join(packageRoot, 'src/bot-node.mjs');
      if (!Number.isInteger(record.pid) || record.pid < 1 || record.script !== expected) return { status: 'offline', lastError: null };
      process.kill(record.pid, 0);
      const { stdout } = await execute('ps', ['-p', String(record.pid), '-o', 'command=']);
      if (!stdout.includes(expected)) return { status: 'offline', lastError: null };
      const [bridgeResponse, coreResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${node.port}/api/ds-group-node/status`, { signal: AbortSignal.timeout(2000) }),
        fetch(`${node.serverUrl}/api/status`, { signal: AbortSignal.timeout(2000) }),
      ]);
      if (!bridgeResponse.ok || !coreResponse.ok) throw new Error('Bot 状态暂时不可用');
      const [bridge, core] = await Promise.all([bridgeResponse.json(), coreResponse.json()]);
      if (bridge.nodeId !== node.localpart) throw new Error('本地端口已由另一个 Bot 使用');
      const remote = core.nodes?.find(item => item.botId === node.id);
      if (!remote || remote.status === 'offline') return { status: 'offline', lastError: null };
      if (remote.status === 'error') return { status: 'error', lastError: remote.lastError || 'Bot 运行异常' };
      return { status: 'online', lastError: null };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH' || error.code === 1) return { status: 'offline', lastError: null };
      return { status: 'error', lastError: error.message };
    }
  }
}
