#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, symlink, open, readlink, chmod, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';
import { runtimeSettings, resolveDsh, providerConfiguration, httpUrl } from './runtime-config.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';
import { LEGACY_MODEL, modelReference } from '../src/model-config.mjs';
import { readOptionalJson, savePrivateJson } from './server-init.mjs';

const [operation = 'start', nodeId = 'finance'] = process.argv.slice(2);
if (!['start', 'run', 'stop', 'status', 'prepare'].includes(operation)) throw new Error('Use start, run, stop, status or prepare');
const settings = runtimeSettings(nodeId, { root: packageRoot });
if (!process.env.DS_GROUP_CORE_URL || ['start', 'run', 'prepare'].includes(operation)) {
  const imported = await readOptionalJson(settings.coreConfigPath);
  if (!process.env.DS_GROUP_CORE_URL && imported?.publicUrl) settings.coreUrl = httpUrl(imported.publicUrl, 'Imported core URL');
  if (imported?.nativeBinding && ['start', 'run', 'prepare'].includes(operation)) {
    throw Object.assign(new Error('DSCORD_NATIVE_BOT_HOST_REQUIRED: Connect this Bot from DSCord in its owning DSH host. Its exported identity cannot start another standalone kernel.'), {
      code: 'DSCORD_NATIVE_BOT_HOST_REQUIRED',
    });
  }
}
const { local, home, bridgeUrl, dataRoot } = settings;
const webPort = process.env.DS_GROUP_DSH_WEB_PORT || '0';
if (!/^\d{1,5}$/.test(webPort) || Number(webPort) > 65535) throw new Error('DS_GROUP_DSH_WEB_PORT must be a port from 0 to 65535');
const script = fileURLToPath(import.meta.url);
const pidPath = join(local, 'process.json');
const plugin = join(packageRoot, 'dsh-plugin');
const config = {
  nodeId, port: settings.port, dataDir: join(local, 'runtime'), coreUrl: settings.coreUrl,
  coreConfigPath: settings.coreConfigPath, maxTokens: 4096,
};
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function processRecord() {
  try { return JSON.parse(await readFile(pidPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function ownsProcess(recorded) {
  if (!recorded || recorded.nodeId !== nodeId || !isAlive(recorded.pid)) return false;
  const { stdout } = await execute('ps', ['-p', String(recorded.pid), '-o', 'command=']);
  if (recorded.script) return recorded.script === script && recorded.local === local && stdout.includes(`${script} run ${nodeId}`);
  // Existing 0.1.0 desktop installations recorded the DSH process directly.
  return recorded.cli?.endsWith('/runtime/cli/bin/dsh') && stdout.includes('dsh-desktop-host/lib/cli.js');
}

async function status() {
  try {
    const response = await fetch(`${bridgeUrl}/api/ds-group-node/status`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const current = await response.json();
    return current.nodeId === nodeId ? current : undefined;
  } catch { return undefined; }
}

if (operation === 'status') {
  console.log(JSON.stringify(await status() ?? { nodeId, status: 'offline' }));
  process.exit(0);
}
if (operation === 'stop') {
  const recorded = await processRecord();
  if (!recorded) {
    console.log(JSON.stringify({ nodeId, status: 'stopped' }));
    process.exit(0);
  }
  if (recorded.nodeId !== nodeId || !Number.isInteger(recorded.pid)) throw new Error('Invalid node process record');
  if (isAlive(recorded.pid)) {
    if (!await ownsProcess(recorded)) throw new Error('Recorded PID no longer belongs to this DSH launcher');
    process.kill(recorded.pid, 'SIGTERM');
  }
  const deadline = Date.now() + 40_000;
  while (isAlive(recorded.pid)) {
    if (Date.now() >= deadline) throw new Error('Node has not finished stopping; inspect its private log');
    await delay(200);
  }
  console.log(JSON.stringify({ nodeId, status: 'stopped', pid: recorded.pid }));
  process.exit(0);
}
if (operation === 'start') {
  const recorded = await processRecord();
  const existing = await status();
  if (existing) {
    if (!await ownsProcess(recorded)) throw new Error(`Bridge port ${settings.port} belongs to another running installation`);
    console.log(JSON.stringify({ nodeId, status: 'already-running', url: bridgeUrl }));
    process.exit(0);
  }
  if (recorded && isAlive(recorded.pid)) throw new Error('The recorded DSH process is still starting or stopping; inspect its private log');
  await mkdir(local, { recursive: true, mode: 0o700 });
  const logPath = join(local, 'host.log');
  const log = await open(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [script, 'run', nodeId], {
    cwd: process.cwd(), detached: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, DS_GROUP_DATA_DIR: dataRoot },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  await writeFile(pidPath, `${JSON.stringify({ nodeId, pid: child.pid, script, local, startedAt: new Date().toISOString(), logPath }, null, 2)}\n`, { mode: 0o600 });
  child.unref();
  await log.close();
  console.log(JSON.stringify({ nodeId, status: 'starting', pid: child.pid, url: bridgeUrl, logPath }));
  process.exit(0);
}

if (await status()) throw new Error('Stop this Bot runtime before preparing or replacing its model configuration.');
const { cli, runtime } = await resolveDsh();
await mkdir(local, { recursive: true, mode: 0o700 });
const dependencies = join(dataRoot, 'dsh-deps');
const requireDependency = await prepareRuntimeDependencies({ directory: dependencies, plugin, runtime });
const yaml = requireDependency(join(dependencies, 'node_modules', 'yaml', 'dist', 'index.js'));
async function ensureLink(target, link) {
  try { await symlink(target, link, 'dir'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let current;
    try { current = await readlink(link); }
    catch { throw new Error(`Expected a dependency link at ${link}`); }
    if (resolve(link, '..', current) !== resolve(target)) throw new Error(`Dependency link belongs to another data directory: ${link}`);
  }
}
const previous = await readOptionalJson(join(local, 'node-config.json'));
const modelEnv = { ...process.env };
if (!modelEnv.DS_GROUP_MODEL && !modelEnv.DS_GROUP_MODEL_SOURCE_PATH && previous?.model) {
  modelEnv.DS_GROUP_MODEL = previous.model;
  const legacyEffort = previous.modelConfigVersion === undefined && previous.model === LEGACY_MODEL ? 'low' : undefined;
  modelEnv.DS_GROUP_REASONING_EFFORT ??= previous.reasoningEffort ?? legacyEffort;
  modelEnv.DS_GROUP_MAX_OUTPUT_TOKENS ??= String(previous.maxTokens || 4096);
}
let prepared;
if (modelEnv.DS_GROUP_MODEL_SOURCE_PATH) {
  const source = await readOptionalJson(resolve(modelEnv.DS_GROUP_MODEL_SOURCE_PATH));
  if (!source?.selection || !source.providers) throw new Error('Invalid private model source snapshot');
  prepared = providerConfiguration({ env: modelEnv, sourceSelection: source.selection,
    sourceProviders: source.providers, sourceCredentials: source.credentials, sourceCredentialRefs: source.credentialRefs });
} else {
  const manifest = await readOptionalJson(join(settings.sourceHome, 'profiles', settings.sourceProfile, 'package.json'));
  if (manifest) {
    // Desktop SDK files live in an ASAR archive, which its bundled Electron can read.
    const executable = runtime.includes(`${sep}app.asar${sep}`)
      ? resolve(runtime, '..', '..', '..', 'MacOS', 'DeepSeek Harness') : process.execPath;
    try {
      const result = await execute(executable, [join(plugin, 'model-profile.mjs'), runtime, settings.sourceHome, settings.sourceProfile], {
        env: { ...modelEnv, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      });
      prepared = JSON.parse(result.stdout);
    } catch (error) {
      const code = error.stderr?.includes('MISSING_CREDENTIAL') ? 'MISSING_CREDENTIAL' : 'MODEL_PROFILE_INVALID';
      throw new Error(`${code}: Check the selected DSH profile, model and credential. Native profile diagnostics stay on the host.`);
    }
  } else prepared = providerConfiguration({ env: modelEnv });
}
const { provider, providerId, credentials, selection } = prepared;
Object.assign(config, selection, { reasoningEffort: selection.reasoningEffort });
const profile = join(home, 'profiles', 'web');
await mkdir(join(profile, 'node_modules', '@ds-group'), { recursive: true });
await ensureLink(plugin, join(profile, 'node_modules', '@ds-group', 'dsh-node'));
async function createOnce(filename, contents) {
  try { await writeFile(filename, contents, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
await createOnce(join(profile, 'package.json'), `${JSON.stringify({ name: `ds-group-${nodeId}-profile`, private: true,
  type: 'module', dependencies: { '@ds-group/dsh-node': `link:${plugin}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2)}\n`);
await createOnce(join(profile, 'cordis.yml'), '[]\n');
async function optionalYaml(filename, fallback) {
  try { return yaml.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function privateYaml(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, yaml.stringify(value), { mode: 0o600 });
  await rename(temporary, filename);
  await chmod(filename, 0o600);
}
const credentialsPath = join(home, '.credentials.yaml');
const existingCredentials = await optionalYaml(credentialsPath, {});
const patchPath = join(profile, 'cordis.patch.yml');
const patch = await optionalYaml(patchPath, []);
if (!Array.isArray(patch)) throw new Error('Invalid node profile patch');
function upsert(id, value) {
  const entry = patch.find(entry => entry.id === id);
  if (entry) entry.config = { ...entry.config, ...value };
  else patch.push({ id, config: value });
}
const providers = patch.find(entry => entry.id === 'llm-pi-ai')?.config?.providers;
upsert('llm-pi-ai', { providers: { ...providers, [providerId]: provider } });
// Replace the full selection so a model with no reasoning keeps its own native default.
const defaultEntry = patch.find(entry => entry.id === 'agent-default-model');
if (defaultEntry) defaultEntry.config = {};
upsert('agent-default-model', { ...modelReference(selection.model),
  ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) });
upsert('web-runtime', { openBrowser: false, printUrl: false, surfaceContext: false });
const nodeEntry = patch.flatMap(entry => entry.insert || []).find(entry => entry.id === 'ds-group-node');
if (nodeEntry) nodeEntry.config = { ...nodeEntry.config, ...config };
else patch.push({ insert: [{ id: 'ds-group-node', name: '@ds-group/dsh-node', config }] });
await privateYaml(credentialsPath, { ...existingCredentials, version: 1,
  refs: { ...existingCredentials.refs, ...credentials.refs }, records: { ...existingCredentials.records, ...credentials.records } });
await privateYaml(patchPath, patch);
await savePrivateJson(join(local, 'node-config.json'), { ...config, modelConfigVersion: 1, bridgeUrl, home, cli, runtime });
if (operation === 'prepare') {
  console.log(JSON.stringify({ nodeId, status: 'prepared', url: bridgeUrl }));
  process.exit(0);
}

const childEnvironment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DS_GROUP_DSH_RUNTIME: runtime,
  DS_GROUP_RUNTIME_DEPS_DIR: dependencies };
delete childEnvironment.OPENCODE_API_KEY;
const child = spawn(cli, ['web', '--host', '127.0.0.1', '--port', webPort, '--no-open'], {
  cwd: local, stdio: 'inherit', env: childEnvironment,
});
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shuttingDown = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = shuttingDown ? 0 : (code ?? 1); });
