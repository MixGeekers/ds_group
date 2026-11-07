import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from './runtime-config.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';
import {MODEL,memoryTestModel,restrictTestProvider} from './memory-test-model.mjs';
import {modelReference} from '../src/model-config.mjs';
import {parse as parseYaml} from 'yaml';

export {MODEL};
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Local maintenance can legitimately produce no headers while native work runs.
// A single explicit deadline covers connect, headers and body, without fetch's
// independent default headers timeout. Native network error codes are retained.
export async function requestMemoryHost(url, { method = 'GET', headers = {}, body,
  timeoutMs = 600000, maxResponseBytes = 16 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid memory host request timeout');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new RangeError('Invalid memory host response limit');
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const request = httpRequest(url, { method, headers, agent: false }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          const error = Object.assign(new Error(`Memory host response exceeds ${maxResponseBytes} bytes`), { code: 'MEMORY_HOST_RESPONSE_TOO_LARGE', maxResponseBytes });
          finish(error); request.destroy(error); return;
        }
        chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('end', () => finish(null, { statusCode: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', error => finish(error));
    timer = setTimeout(() => {
      const error = Object.assign(new Error(`Memory host request exceeded ${timeoutMs}ms`), { code: 'ETIMEDOUT', timeoutMs });
      finish(error); request.destroy(error);
    }, timeoutMs);
    request.end(body);
  });
}

export class MemoryTestHost {
  constructor(directory, { model = MODEL, sourceHome, sourceProfile, requestTimeoutMs = 600000, maxResponseBytes = 16 * 1024 * 1024 } = {}) {
    this.directory = directory; this.home = path.join(directory, 'home'); this.boot = 0;
    Object.assign(this,{model,sourceHome,sourceProfile});
    this.requestOptions = { timeoutMs: requestTimeoutMs, maxResponseBytes };
  }
  async prepare() {
    this.model=memoryTestModel(this.model);
    const installation = this.installation = await resolveDsh();
    const profile = path.join(this.home, 'profiles/web'); await mkdir(profile, { recursive: true });
    // A normal native workspace outside the product checkout avoids importing this
    // repository's engineering AGENTS.md into synthetic office conversations.
    // It has the full native tool surface and danger-full-access, not a sandbox.
    this.workspace = await mkdtemp(path.join(tmpdir(), 'dscord-memory-work-'));
    await writeFile(path.join(this.directory, 'workspace.json'), JSON.stringify({ path: this.workspace }));
    const deps = path.join(this.directory, 'dependencies');
    await prepareRuntimeDependencies({ directory: deps, plugin: path.join(packageRoot, 'dsh-plugin'), runtime: installation.runtime });
    const harness = path.join(this.directory, 'harness.mjs');
    await writeFile(harness, `import {readFile} from 'node:fs/promises';\nimport {pathToFileURL} from 'node:url';
import {registerRuntimeResolution} from ${JSON.stringify(new URL('../dsh-plugin/index.mjs', import.meta.url).href)};
const root=${JSON.stringify(packageRoot)};
const {dependencies}=JSON.parse(await readFile(root+'/dsh-plugin/runtime-dependencies.json','utf8'));
registerRuntimeResolution({project:pathToFileURL(root).href+'/',anchor:pathToFileURL(${JSON.stringify(path.join(installation.runtime, 'package.json'))}).href,
 dependencyAnchor:pathToFileURL(${JSON.stringify(path.join(deps, 'package.json'))}).href,dependencies});
export const inject=['llm','tools','systemPrompt','sessionController','sessions','sessionTitle','workspaceRegistry','connection'];
export async function apply(ctx){const plugin=await import(pathToFileURL(root+'/scripts/memory-host-plugin.mjs').href);return plugin.apply(ctx,{directory:${JSON.stringify(this.directory)},workspace:${JSON.stringify(this.workspace)}});}`);
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'memory-acceptance', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
    await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: false } },
      { insert: [{ id: 'memory-harness', name: harness }] },
    ]), { mode: 0o600 });
    await this.configureModel();
  }
  async configureModel() {
    const model=this.model=memoryTestModel(this.model),installation=this.installation||await resolveDsh(),route=modelReference(model);
    const executable=installation.runtime.includes('/app.asar/')?path.resolve(installation.runtime,'../../..','MacOS/DeepSeek Harness'):process.execPath;
    const source=await promisify(execFile)(executable,[path.join(packageRoot,'dsh-plugin/model-profile.mjs'),installation.runtime,
      this.sourceHome||process.env.DS_GROUP_DSH_SOURCE_HOME||path.join(homedir(),'.dsh'),this.sourceProfile||process.env.DS_GROUP_DSH_SOURCE_PROFILE||'desktop'],
      {env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DS_GROUP_MODEL:model},maxBuffer:4*1024*1024});
    const prepared=JSON.parse(source.stdout);if(prepared.selection.model!==model)throw new Error('TEST_MODEL_MISMATCH');
    const file=path.join(this.home,'profiles/web/cordis.patch.yml'),patches=parseYaml(await readFile(file,'utf8'));
    await writeFile(path.join(this.home,'.credentials.yaml'),JSON.stringify(prepared.credentials),{mode:0o600});
    await writeFile(file,JSON.stringify([
      {id:'llm-pi-ai',config:{providers:{[route.provider]:restrictTestProvider(prepared.provider,model)}}},
      {id:'agent-default-model',config:{provider:route.provider,model:route.model,...(prepared.selection.reasoningEffort?{reasoningEffort:prepared.selection.reasoningEffort}:{})}},
      ...patches.filter(row=>!['llm-pi-ai','agent-default-model'].includes(row.id)),
    ]),{mode:0o600});
  }
  async start() {
    this.model=memoryTestModel(this.model);
    if (!this.installation) await this.prepare();
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    this.port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    this.logfile = path.join(this.directory, `host-${++this.boot}.log`);
    this.log = await open(this.logfile, 'a', 0o600);
    this.child = spawn(this.installation.cli, ['web', '--host', '127.0.0.1', '--port', String(this.port), '--no-open'],
      { cwd: this.directory, detached: true, stdio: ['ignore', this.log.fd, this.log.fd], env: { ...process.env, DSCORD_MEMORY_TEST_MODEL:this.model, DSH_HOME: this.home, DSH_TELEMETRY_DISABLED: '1' } });
    this.exited = new Promise(resolve => this.child.once('close', resolve)); this.cookie = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.child.exitCode !== null) throw new Error(`Host exited: inspect ${this.logfile}`);
      try { const state = await this.api('state'); if (Array.isArray(state?.bots)) return state; } catch { /* starting */ }
      await delay(500);
    }
    throw new Error(`Host unavailable: inspect ${this.logfile}`);
  }
  async api(action, input = {}) {
    if (!this.cookie) {
      const log = await readFile(this.logfile, 'utf8'), url = log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
      if (!url) throw new Error('Host starting');
      const response = await requestMemoryHost(url, this.requestOptions);
      if (response.statusCode >= 400) throw Object.assign(new Error(`Memory host authentication failed: HTTP ${response.statusCode}`), { code: `HTTP_${response.statusCode}` });
      this.cookie = response.headers['set-cookie']?.[0]?.split(';')[0];
    }
    const response = await requestMemoryHost(`http://127.0.0.1:${this.port}/api/memory-test`, { ...this.requestOptions, method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) }, body: JSON.stringify({ action, input }) });
    let result;
    try { result = JSON.parse(response.body); }
    catch (cause) { throw Object.assign(new Error('Memory host returned invalid JSON', { cause }), { code: 'MEMORY_HOST_INVALID_JSON', statusCode: response.statusCode }); }
    if (response.statusCode >= 400 || !result?.ok) throw Object.assign(new Error(result?.error?.message || JSON.stringify(result?.error) || `Memory host API failed: HTTP ${response.statusCode}`),
      { code: result?.error?.code || (response.statusCode >= 400 ? `HTTP_${response.statusCode}` : 'MEMORY_HOST_API_ERROR'), statusCode: response.statusCode, remoteError: result?.error });
    return result.value;
  }
  async stop() {
    if (!this.child) return;
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* ended */ }
    await Promise.race([this.exited, delay(10000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} await this.exited; }
    await this.log.close(); this.child = null;
  }
}
