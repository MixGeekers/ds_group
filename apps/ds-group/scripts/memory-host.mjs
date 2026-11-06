import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from './runtime-config.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';
import {MODEL,restrictTestProvider} from './memory-test-model.mjs';
import {modelReference} from '../src/model-config.mjs';
import {parse as parseYaml} from 'yaml';

export {MODEL};
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class MemoryTestHost {
  constructor(directory) { this.directory = directory; this.home = path.join(directory, 'home'); this.boot = 0; }
  async prepare() {
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
    await writeFile(harness, `import {registerHooks} from 'node:module';\nimport {pathToFileURL} from 'node:url';
const root=${JSON.stringify(packageRoot)};
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.startsWith(pathToFileURL(root).href)&&specifier.startsWith('@deepseek-ai/')) return next(specifier,{...context,parentURL:pathToFileURL(${JSON.stringify(path.join(installation.runtime, 'package.json'))}).href});
 if(context.parentURL?.startsWith(pathToFileURL(root).href)&&(specifier==='yaml'||specifier==='deep-view'||specifier.startsWith('deep-view/'))) return next(specifier,{...context,parentURL:pathToFileURL(${JSON.stringify(path.join(deps, 'package.json'))}).href});
 return next(specifier,context);
}});
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
    const installation=this.installation||await resolveDsh(),route=modelReference(MODEL);
    const executable=installation.runtime.includes('/app.asar/')?path.resolve(installation.runtime,'../../..','MacOS/DeepSeek Harness'):process.execPath;
    const source=await promisify(execFile)(executable,[path.join(packageRoot,'dsh-plugin/model-profile.mjs'),installation.runtime,
      process.env.DS_GROUP_DSH_SOURCE_HOME||path.join(homedir(),'.dsh'),process.env.DS_GROUP_DSH_SOURCE_PROFILE||'desktop'],
      {env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DS_GROUP_MODEL:MODEL,DS_GROUP_REASONING_EFFORT:route.provider==='opencode-go'?'low':''},maxBuffer:4*1024*1024});
    const prepared=JSON.parse(source.stdout);if(prepared.selection.model!==MODEL)throw new Error('TEST_MODEL_MISMATCH');
    const file=path.join(this.home,'profiles/web/cordis.patch.yml'),patches=parseYaml(await readFile(file,'utf8'));
    await writeFile(path.join(this.home,'.credentials.yaml'),JSON.stringify(prepared.credentials),{mode:0o600});
    await writeFile(file,JSON.stringify([
      {id:'llm-pi-ai',config:{providers:{[route.provider]:restrictTestProvider(prepared.provider)}}},
      {id:'agent-default-model',config:{provider:route.provider,model:route.model,...(prepared.selection.reasoningEffort?{reasoningEffort:prepared.selection.reasoningEffort}:{})}},
      ...patches.filter(row=>!['llm-pi-ai','agent-default-model'].includes(row.id)),
    ]),{mode:0o600});
  }
  async start() {
    if (!this.installation) await this.prepare();
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    this.port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    this.logfile = path.join(this.directory, `host-${++this.boot}.log`);
    this.log = await open(this.logfile, 'a', 0o600);
    this.child = spawn(this.installation.cli, ['web', '--host', '127.0.0.1', '--port', String(this.port), '--no-open'],
      { cwd: this.directory, detached: true, stdio: ['ignore', this.log.fd, this.log.fd], env: { ...process.env, DSH_HOME: this.home, DSH_TELEMETRY_DISABLED: '1' } });
    this.exited = new Promise(resolve => this.child.once('close', resolve)); this.cookie = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.child.exitCode !== null) throw new Error(`Host exited: inspect ${this.logfile}`);
      try { const state = await this.api('state'); if (state?.bots?.length) return state; } catch { /* starting */ }
      await delay(500);
    }
    throw new Error(`Host unavailable: inspect ${this.logfile}`);
  }
  async api(action, input = {}) {
    if (!this.cookie) {
      const log = await readFile(this.logfile, 'utf8'), url = log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
      if (!url) throw new Error('Host starting');
      const response = await fetch(url, { redirect: 'manual' }); this.cookie = response.headers.get('set-cookie')?.split(';')[0];
    }
    const response = await fetch(`http://127.0.0.1:${this.port}/api/memory-test`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({ action, input }), signal: AbortSignal.timeout(600000) });
    const result = await response.json(); if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.value;
  }
  async stop() {
    if (!this.child) return;
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch { /* ended */ }
    await Promise.race([this.exited, delay(10000)]);
    if (this.child.exitCode === null && this.child.signalCode === null) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} await this.exited; }
    await this.log.close(); this.child = null;
  }
}
