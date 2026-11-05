import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const DSH_VERSION = '0.2.1-rc.5';
export const MODEL = 'deepseek-v4.1-flash';

export function nodeIdentifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value) || ['all', 'core'].includes(value)) {
    throw new Error('Node must use a local Bot account name with lowercase letters, digits, underscores or hyphens');
  }
  return value;
}

export function portNumber(value, fallback, name) {
  const port = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a port between 1 and 65535`);
  return port;
}

export function httpUrl(value, name, { originOnly = true } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment`);
  }
  if (originOnly && url.pathname !== '/') throw new Error(`${name} must use the server origin without a path prefix`);
  return url.href.replace(/\/$/, '');
}

export function runtimeSettings(nodeId, { env = process.env, root, userHome = homedir() } = {}) {
  nodeIdentifier(nodeId);
  const dataRoot = path.resolve(env.DS_GROUP_DATA_DIR || path.join(root, '.local'));
  const local = path.join(dataRoot, `dsh-${nodeId}`);
  const defaultPort = { finance: 18091, hr: 18092 }[nodeId];
  const configuredPort = env.DS_GROUP_BRIDGE_PORT || env[`DS_GROUP_${nodeId.toUpperCase()}_PORT`];
  if (!configuredPort && !defaultPort) throw new Error('Set DS_GROUP_BRIDGE_PORT for this Bot node');
  const port = portNumber(configuredPort, defaultPort, 'Bridge port');
  const corePort = portNumber(env.DS_GROUP_PORT, 18100, 'DS_GROUP_PORT');
  const sourceHome = path.resolve(env.DS_GROUP_DSH_SOURCE_HOME || path.join(userHome, '.dsh'));
  const sourceProfile = env.DS_GROUP_DSH_SOURCE_PROFILE || 'desktop';
  if (!/^[a-zA-Z0-9_-]+$/.test(sourceProfile)) throw new Error('DS_GROUP_DSH_SOURCE_PROFILE must be a profile name');
  return {
    nodeId, port, dataRoot, local, home: path.join(local, 'home'),
    bridgeUrl: `http://127.0.0.1:${port}`,
    coreUrl: httpUrl(env.DS_GROUP_CORE_URL || `http://127.0.0.1:${corePort}`, 'DS_GROUP_CORE_URL'),
    coreConfigPath: path.resolve(env.DS_GROUP_CORE_CONFIG_PATH || path.join(dataRoot, 'core-config.json')),
    sourceHome, sourceProfile,
  };
}

async function executable(filename) {
  try { await access(filename, constants.X_OK); return filename; } catch { return undefined; }
}

export async function resolveDsh({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') throw new Error('Run Bot hosts with Linux containers or WSL2 on Windows');
  let cli;
  if (env.DS_GROUP_DSH_CLI?.includes(path.sep)) {
    cli = await executable(path.resolve(env.DS_GROUP_DSH_CLI));
    if (!cli) throw new Error('DS_GROUP_DSH_CLI does not name an executable file');
  } else {
    const command = env.DS_GROUP_DSH_CLI || 'dsh';
    const candidates = [];
    if (env.DS_GROUP_DSH_RUNTIME && !env.DS_GROUP_DSH_CLI) {
      candidates.push(path.resolve(env.DS_GROUP_DSH_RUNTIME, 'node_modules', '.bin', 'dsh'));
      candidates.push(path.resolve(env.DS_GROUP_DSH_RUNTIME, 'lib', 'bin.js'));
    }
    candidates.push(...(env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command)));
    if (platform === 'darwin' && !env.DS_GROUP_DSH_CLI) candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
    for (const candidate of candidates) {
      cli = await executable(candidate);
      if (cli) break;
    }
  }
  if (!cli) throw new Error(`Install @deepseek-ai/dsh@${DSH_VERSION} and set DS_GROUP_DSH_CLI, or put dsh on PATH`);
  cli = await realpath(cli);
  if (env.DS_GROUP_DSH_RUNTIME) return { cli, runtime: path.resolve(env.DS_GROUP_DSH_RUNTIME) };
  const desktopSuffix = `${path.sep}runtime${path.sep}cli${path.sep}bin${path.sep}dsh`;
  if (platform === 'darwin' && cli.endsWith(desktopSuffix)) {
    return { cli, runtime: path.join(cli.slice(0, -desktopSuffix.length), 'app.asar', 'dsh') };
  }
  for (let directory = path.dirname(cli); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === '@deepseek-ai/dsh') return { cli, runtime: directory };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Cannot locate the DSH SDK. Set DS_GROUP_DSH_RUNTIME to its package root or npm installation prefix');
}

export function providerConfiguration({ env = process.env, sourceProvider, sourceCredentials } = {}) {
  const suppliedKey = env.OPENCODE_API_KEY?.trim();
  let provider;
  let key;
  let credentialName;
  if (suppliedKey) {
    credentialName = 'DS_GROUP_OPENCODE_API_KEY';
    key = suppliedKey;
    provider = { apiKeyEnv: credentialName };
  } else {
    if (!sourceProvider || typeof sourceProvider.apiKeyEnv !== 'string') {
      throw new Error('Set OPENCODE_API_KEY or configure opencode-go in DS_GROUP_DSH_SOURCE_HOME / DS_GROUP_DSH_SOURCE_PROFILE');
    }
    credentialName = sourceProvider.apiKeyEnv;
    key = sourceCredentials?.refs?.[credentialName];
    if (typeof key !== 'string' || !key.trim()) throw new Error('The opencode-go credential reference is unavailable');
    provider = { ...sourceProvider };
  }
  if (env.DS_GROUP_OPENCODE_BASE_URL) provider.baseURL = httpUrl(env.DS_GROUP_OPENCODE_BASE_URL, 'DS_GROUP_OPENCODE_BASE_URL', { originOnly: false });
  provider.models = [{ ...(sourceProvider?.models?.find(model => model.id === MODEL) || {}), id: MODEL }];
  delete provider.modelOverrides;
  provider.retryPolicy = { mode: 'normal', maxRetries: 0 };
  return { provider, credentials: { version: 1, records: {}, refs: { [credentialName]: key } } };
}
