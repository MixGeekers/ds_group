import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HARRIER_PROFILE, verifyHarrierArtifact } from '../src/adapters/embedding/index.js';
import { ManagedHarrier, ManagedHarrierError, verifyHarrierRuntime, type ManagedHarrierConfig, type ManagedHarrierOptions } from '../src/adapters/embedding/managed.js';
import { HARRIER_RUNTIME_MANIFEST } from '../src/adapters/embedding/runtime-manifest.js';

// Synthetic HTTP server: never imports llama, a model, Ombre or the DSH host.
const CHILD = `
import http from 'node:http'; import fs from 'node:fs';
const args=process.argv.slice(1), arg=name=>args[args.indexOf(name)+1];
const mode=arg('--synthetic-mode'), secret=fs.readFileSync(arg('--api-key-file'),'utf8').trim();
if(mode==='ignore-term') process.on('SIGTERM',()=>{});
if(mode==='early-exit') process.exit(17);
if(mode==='hold') { setInterval(()=>{},1000); } else {
const server=http.createServer((req,res)=>{
process.send?.({path:req.url,authorized:req.headers.authorization==='Bearer '+secret});
if(req.url==='/health') {res.writeHead(mode==='never-ready'?503:200);res.end('{}');return;}
if(req.url!=='/v1/models') {res.writeHead(400);res.end('{}');return;}
if(mode!=='public-models' && req.headers.authorization!=='Bearer '+secret) {res.writeHead(401);res.end('{}');return;}
res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:mode==='wrong-model'?'other':arg('--alias')}]}));
});
server.on('error',()=>process.exit(18));server.listen(Number(arg('--port')),arg('--host'),()=>process.send?.({listening:true,env:process.env}));
}
`;
const code = (expected: ManagedHarrierError['code']) => (error: unknown) => error instanceof ManagedHarrierError && error.code === expected;
async function fixture(t: TestContext, mode = 'normal', extra: ManagedHarrierOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-harrier-test-'));
  const config: ManagedHarrierConfig = { serverBinary: process.execPath, modelArtifact: join(directory, 'synthetic-no-model') };
  const children: ChildProcess[] = [], requests: { path?: string; authorized?: boolean; env?: Record<string, string> }[] = [];
  const launches: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  let checks = 0;
  const options: ManagedHarrierOptions = { verifyFiles: async (_config, signal) => { checks++; signal.throwIfAborted(); },
    spawn(command, args, options) {
      launches.push({ command, args, options });
      const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, '--', ...args, '--synthetic-mode', mode], { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', message => requests.push(message as typeof requests[number])); children.push(child); return child;
    }, ...extra };
  const managed = new ManagedHarrier(config, options);
  t.after(async () => { await managed.close().catch(() => {}); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); });
  return { directory, config, managed, launches, children, requests, get checks() { return checks; }, keyFile: () => { const args = launches[0]!.args; return args[args.indexOf('--api-key-file') + 1]!; } };
}
async function noFile(path: string) { await assert.rejects(stat(path), { code: 'ENOENT' }); }

test('constructor and repeated status are IO-free, public metadata never exposes paths or a credential', async t => {
  const f = await fixture(t); const before = await readdir(f.directory);
  for (let i = 0; i < 5; i++) { const state = f.managed.status(); assert.equal(state.state, 'idle'); assert.equal(state.verified, false); assert.equal(state.embeddingVerified, false); assert.equal(state.childGeneration, 0); assert.match(state.runtimeFingerprint, /^[a-f0-9]{64}$/); }
  assert.equal(f.checks, 0); assert.equal(f.launches.length, 0); assert.deepEqual(await readdir(f.directory), before);
  await f.managed.close(); assert.equal(f.managed.status().state, 'closed'); assert.equal(f.launches.length, 0);
  const status = JSON.stringify(f.managed.status()); assert.ok(!status.includes(f.directory)); assert.ok(!status.includes('keyFile')); assert.ok(!status.includes('endpoint'));
});

test('configuration cannot supply a port, key, environment, shell command or arbitrary relative path', () => {
  const good = { serverBinary: '/synthetic/server', modelArtifact: '/synthetic/model' };
  for (const bad of [{ ...good, port: 1234 }, { ...good, env: {} }, { ...good, apiKey: 'secret' }, { ...good, endpoint: 'http://remote' }, { ...good, serverBinary: 'llama-server' }, { ...good, modelArtifact: '/a/../b' }, { ...good, serverBinary: '/bad\0path' }]) assert.throws(() => new ManagedHarrier(bad), code('INVALID_CONFIG'));
});

test('explicit open pins launch flags and authenticates owned readiness without making an embedding request', async t => {
  const f = await fixture(t); const result = await f.managed.open({ timeoutMs: 5000 });
  assert.match(result.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/embeddings$/);
  const launch = f.launches[0]!; assert.equal(f.launches.length, 1); assert.equal(f.checks, 1);
  assert.deepEqual(launch.options.env, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' });
  assert.equal(launch.options.shell, false); assert.equal(launch.options.detached, false);
  const flags = Object.fromEntries(launch.args.flatMap((value, index) => value.startsWith('-') && value !== '--embeddings' ? [[value, launch.args[index + 1]]] : []));
  assert.equal(flags['-m'], f.config.modelArtifact); assert.equal(flags['--pooling'], 'last'); assert.equal(flags['--alias'], HARRIER_PROFILE.model);
  assert.equal(flags['--host'], '127.0.0.1'); assert.equal(flags['-c'], '4096'); assert.equal(flags['-b'], '512'); assert.equal(flags['-ub'], '512'); assert.equal(flags['-t'], '4'); assert.equal(flags['-fa'], 'off');
  assert.equal(flags['--api-key-file'], result.keyFile); assert.ok(launch.args.includes('--embeddings'));
  const key = await readFile(result.keyFile, 'utf8'); assert.match(key, /^[a-f0-9]{64}\n$/); assert.equal((await stat(result.keyFile)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(result.keyFile))).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(launch.args).includes(key.trim())); assert.ok(!JSON.stringify(f.managed.status()).includes(key.trim()));
  assert.deepEqual(f.requests.filter(item => item.path).map(({ path, authorized }) => ({ path, authorized })), [
    { path: '/health', authorized: false }, { path: '/v1/models', authorized: false }, { path: '/v1/models', authorized: true }]);
  const environment = f.requests.find(item => item.env)!.env!;
  assert.ok(Object.keys(environment).every(key => ['PATH', 'LANG', 'LC_ALL', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', '__CF_USER_TEXT_ENCODING'].includes(key)));
  assert.equal(f.managed.status().verified, true); assert.equal(f.managed.status().embeddingVerified, false); assert.equal(f.managed.status().readinessProbe, 'passed');
  await assert.rejects(f.managed.open(), code('NOT_READY')); assert.equal(f.launches.length, 1);
  await f.managed.close(); await f.managed.close(); await noFile(result.keyFile); await noFile(dirname(result.keyFile));
  assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null); assert.equal(f.managed.status().state, 'closed');
});

test('pre-abort, artifact rejection and cancellation during verification never spawn or allocate a key', async t => {
  const pre = await fixture(t); await assert.rejects(pre.managed.open({ signal: AbortSignal.abort() }), code('CANCELLED')); assert.equal(pre.checks, 0);
  const bad = await fixture(t, 'normal', { verifyFiles: async () => { throw new ManagedHarrierError('ARTIFACT_MISMATCH'); } });
  await assert.rejects(bad.managed.open(), code('ARTIFACT_MISMATCH')); assert.equal(bad.launches.length, 0);
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const held = await fixture(t, 'normal', { verifyFiles: async (_config, signal) => { started(); await delay(60000, undefined, { signal }); } });
  const opening = held.managed.open(); const rejected = assert.rejects(opening, code('CANCELLED')); await entered; await held.managed.close(); await rejected;
  assert.equal(held.launches.length, 0); assert.equal(held.managed.status().state, 'closed');
});

for (const mode of ['wrong-model', 'public-models'] as const) test(`readiness rejects ${mode} without retry and removes the owned key`, async t => {
  const f = await fixture(t, mode); await assert.rejects(f.managed.open({ timeoutMs: 3000 }), code('IDENTITY_MISMATCH'));
  assert.equal(f.launches.length, 1); assert.equal(f.managed.status().verified, false); await noFile(f.keyFile()); assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
});

test('close during readiness aborts startup, reaps only its child and removes its key', async t => {
  const f = await fixture(t, 'never-ready'); const opening = f.managed.open({ timeoutMs: 5000 }); const rejection = assert.rejects(opening, code('CANCELLED'));
  while (!f.launches.length) await delay(5); const key = f.keyFile(); await f.managed.close(); await rejection;
  await noFile(key); assert.equal(f.managed.status().state, 'closed'); assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
});

test('synchronous spawn failure and caller abort after launch remove the key without an automatic retry', async t => {
  let keyFile: string | undefined, starts = 0;
  const failed = await fixture(t, 'normal', { spawn(_command, args) { starts++; keyFile = args[args.indexOf('--api-key-file') + 1]!; throw new Error('synthetic spawn error with a private path'); } });
  await assert.rejects(failed.managed.open({ timeoutMs: 3000 }), code('OPEN_FAILED')); assert.equal(starts, 1); await noFile(keyFile!);
  const held = await fixture(t, 'hold'), controller = new AbortController();
  const opening = held.managed.open({ timeoutMs: 5000, signal: controller.signal }); const rejected = assert.rejects(opening, code('CANCELLED'));
  while (!held.launches.length) await delay(5); controller.abort(); await rejected; await noFile(held.keyFile());
  assert.equal(held.launches.length, 1); assert.ok(held.children[0]!.exitCode !== null || held.children[0]!.signalCode !== null);
});

test('readiness timeout and early child exit fail closed without restarts', async t => {
  for (const mode of ['never-ready', 'early-exit']) {
    const f = await fixture(t, mode); await assert.rejects(f.managed.open({ timeoutMs: 350 }), code(mode === 'never-ready' ? 'TIMEOUT' : 'DISCONNECTED'));
    assert.equal(f.launches.length, 1); assert.equal(f.managed.status().state, 'failed'); await noFile(f.keyFile());
  }
});

test('a port collision neither adopts nor kills the existing server and never chooses another port', async t => {
  const foreign = createServer((_req, res) => { res.writeHead(200); res.end(JSON.stringify({ data: [{ id: HARRIER_PROFILE.model }] })); });
  await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => foreign.close(() => resolve())));
  const address = foreign.address(); assert.ok(address && typeof address !== 'string'); let allocated = 0;
  const f = await fixture(t, 'normal', { allocatePort: async () => { allocated++; return address.port; } });
  await assert.rejects(f.managed.open({ timeoutMs: 3000 }), error => error instanceof ManagedHarrierError && ['IDENTITY_MISMATCH', 'DISCONNECTED'].includes(error.code));
  assert.equal(allocated, 1); assert.equal(f.launches.length, 1); assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200); await noFile(f.keyFile());
});

test('unexpected owned exit changes status and removes the ephemeral key; shutdown escalates for an uncooperative owned child', async t => {
  const f = await fixture(t); const connection = await f.managed.open({ timeoutMs: 3000 }); f.children[0]!.kill('SIGKILL');
  while (f.managed.status().state === 'ready') await delay(5);
  assert.equal(f.managed.status().state, 'failed'); assert.equal(f.managed.status().verified, false); await f.managed.close(); await noFile(connection.keyFile);
  const stubborn = await fixture(t, 'ignore-term'); const opened = await stubborn.managed.open({ timeoutMs: 3000 }); await stubborn.managed.close();
  assert.equal(stubborn.children[0]!.signalCode, 'SIGKILL'); await noFile(opened.keyFile);
});

test('default verification rejects changed runtime bytes and aborts artifact hashing without loading models', async t => {
  const f = await fixture(t); const badRuntime = join(f.directory, 'llama-server'); await writeFile(badRuntime, 'synthetic changed binary');
  await assert.rejects(verifyHarrierRuntime(badRuntime), code(process.platform === 'darwin' && process.arch === 'arm64' ? 'RUNTIME_MISMATCH' : 'UNSUPPORTED_PLATFORM'));
  assert.equal(HARRIER_RUNTIME_MANIFEST.files.length, 10); assert.equal(new Set(HARRIER_RUNTIME_MANIFEST.files.map(entry => entry.name)).size, 10);
  await assert.rejects(verifyHarrierArtifact('/does-not-exist', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  // Sparse synthetic GGUF header reaches streaming verification, but never contains a model.
  const file = join(f.directory, 'synthetic.gguf'), header = Buffer.alloc(24); header.write('GGUF'); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(310n, 8);
  await writeFile(file, header); await truncate(file, HARRIER_PROFILE.artifactBytes);
  const controller = new AbortController(); const verify = verifyHarrierArtifact(file, { signal: controller.signal }); setTimeout(() => controller.abort(), 5);
  await assert.rejects(verify, { name: 'AbortError' }); assert.equal(f.launches.length, 0);
});
