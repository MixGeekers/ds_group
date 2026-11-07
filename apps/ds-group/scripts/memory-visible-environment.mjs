import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { initializeServer, savePrivateJson } from './server-init.mjs';
import { bootstrapServer } from './server-bootstrap.mjs';
import { packageRoot } from '../src/paths.mjs';
import { MODEL, memoryTestModel } from './memory-test-model.mjs';

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const image = 'ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842';
async function unused(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
export function visibleEnvironmentModelSettings({model=MODEL,allowedModels}={}) {
  model=model==null?null:memoryTestModel(model);
  allowedModels=allowedModels===undefined?(model?[model]:null):allowedModels;
  if(allowedModels!==null&&(!Array.isArray(allowedModels)||!allowedModels.length))throw new Error('allowedModels must be null or a nonempty list');
  if(allowedModels)for(const value of allowedModels)memoryTestModel(value);
  if(model&&allowedModels&&!allowedModels.includes(model))throw new Error('The selected model must be in allowedModels');
  return{model,allowedModels};
}
export async function startVisibleEnvironment({ port = 25300, matrixPort = 25308, serverName = 'memory-live.local',
  prefix = 'memory-visible', activeFile = 'memory-visible-active.json', preparingMessage,
  profiles = [ ['watch', '长测观察员'], ['lin_a', '林青'], ['lin_b', '林青'], ['song', '宋禾'] ],
  allowedModels, model = MODEL, plannedRounds = 240 } = {}) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.some(profile => !Array.isArray(profile) || profile.length !== 2
    || !/^[a-z0-9._=-]+$/.test(profile[0]) || typeof profile[1] !== 'string' || !profile[1].trim())
    || new Set(profiles.map(profile => profile[0])).size !== profiles.length) throw new Error('Profiles require unique synthetic localparts and nonempty display names');
  ({model,allowedModels}=visibleEnvironmentModelSettings({model,allowedModels}));
  if (!Number.isSafeInteger(plannedRounds) || plannedRounds < 0) throw new Error('plannedRounds must be a nonnegative integer');
  await unused(port); await unused(matrixPort);
  await mkdir(path.join(packageRoot, '.local'), { recursive: true });
  const directory = await mkdtemp(path.join(packageRoot, `.local/${prefix}-`));
  const dataRoot = path.join(directory, 'core'), synapseRoot = path.join(directory, 'synapse');
  const coreUrl = `http://127.0.0.1:${port}`, matrixUrl = `http://127.0.0.1:${matrixPort}`;
  const containerName = `dscord-memory-visible-${path.basename(directory).split('-').at(-1).toLowerCase()}`;
  const options = { dataRoot, synapseRoot, serverName, homeserverUrl: matrixUrl, publicUrl: coreUrl, publicHomeserverUrl: matrixUrl, webMode: 'bundled' };
  await initializeServer(options);
  await savePrivateJson(path.join(dataRoot, 'matrix-setup.json'), { serverName, homeserverUrl: matrixUrl,
    publicHomeserverUrl: matrixUrl, roomId: null, participants: profiles.map(([localpart, name]) => ({
      id: `@${localpart}:${serverName}`, localpart, name, kind: 'human', password: randomBytes(24).toString('base64url'), accessToken: null,
    })) });
  const configFile = path.join(dataRoot, 'core-config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  Object.assign(config, { demoLogin: false, registrationMode: 'closed', allowedModels: allowedModels?[...allowedModels]:null });
  await savePrivateJson(configFile, config);
  await execute('docker', ['run', '--detach', '--name', containerName, '--label', 'dscord.memory-visible=true',
    '--publish', `127.0.0.1:${matrixPort}:8008`, '--volume', `${synapseRoot}:/data`, image], { timeout: 60000 });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${matrixUrl}/_matrix/client/versions`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (attempt >= 100) throw new Error(`Matrix startup failed; inspect owned container ${containerName}`);
    await sleep(500);
  }
  await bootstrapServer({ ...options, demo: true });
  const log = await open(path.join(directory, 'core.log'), 'a', 0o600);
  const core = spawn(process.execPath, [path.join(packageRoot, 'src/core.mjs')], { cwd: packageRoot,
    detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, DS_GROUP_DATA_DIR: dataRoot,
      DS_GROUP_PORT: String(port), DS_GROUP_HOST: '127.0.0.1', DS_GROUP_WEB_DIR: path.join(packageRoot, 'dist/web') } });
  core.unref(); await log.close();
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${coreUrl}/api/bootstrap`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (attempt >= 100) throw new Error(`Core startup failed; inspect ${directory}/core.log`);
    await sleep(300);
  }
  const setup = JSON.parse(await readFile(path.join(dataRoot, 'matrix-setup.json'), 'utf8'));
  const state = { version: 1, directory, coreUrl, matrixUrl, serverName, containerName, corePid: core.pid,
    roomId: setup.roomId, observerId: setup.participants[0].id, model,
    plannedRounds, createdAt: new Date().toISOString() };
  await savePrivateJson(path.join(directory, 'environment.json'), state);
  await savePrivateJson(path.join(packageRoot, '.local', activeFile), state);
  const response = await fetch(`${coreUrl}/api/rooms/${encodeURIComponent(setup.roomId)}/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${setup.participants[0].accessToken}` },
    body: JSON.stringify({ body: preparingMessage || `【实时长程测试 · 准备中】\n这是新的隔离测试环境，消息通过真实 DSCord 与 Matrix 发送。计划 ${plannedRounds} 轮；模型由运行者显式选择。服务准备本身不发起模型请求，后续运行会保留真实输入、回答与检查结果。`, transactionId: 'visible-test-preparing', to: [] }) });
  if (!response.ok) throw new Error(`Initial visible message HTTP ${response.status}`);
  return state;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await startVisibleEnvironment(), null, 2));
}
