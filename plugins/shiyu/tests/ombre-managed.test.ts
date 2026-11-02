import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrivateStdioMcpClient, type PrivateStdioMcpOptions } from '../src/adapters/mcp/index.js';
import { ManagedOmbreBackend, ManagedOmbreError, loadManagedOmbreConfig, type ManagedOmbreConfig, type ManagedOmbreTransport } from '../src/adapters/ombre/managed.js';

const tools = () => Object.entries({ shiyu_memory_create: ['command', 'commandDigest', 'body'], shiyu_memory_get: ['nativeId', 'scope'], shiyu_memory_operation_status: ['operationId', 'scope'] })
  .map(([name, args]) => ({ name, inputSchema: { type: 'object' as const, properties: Object.fromEntries(args.map(key => [key, { type: key === 'command' ? 'object' : 'string' }])), required: args } }));
const errorCode = (expected: ManagedOmbreError['code']) => (error: unknown) => error instanceof ManagedOmbreError && error.code === expected;
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-managed-ombre-'));
  const config: ManagedOmbreConfig = { schemaVersion: 1, backendId: 'ombre-managed-test', deploymentId: 'deployment-managed-test', scope: 'local-owner',
    python: process.execPath, upstream: join(directory, 'upstream'), root: join(directory, 'private-root'), embedding: 'disabled' };
  await mkdir(config.upstream);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const descriptor = join(directory, 'memory', 'backend.json');
  return { directory, config, descriptor, async save(value: unknown = config) { await mkdir(dirname(descriptor), { recursive: true }); await writeFile(descriptor, JSON.stringify(value)); } };
}
class TransportFixture implements ManagedOmbreTransport {
  state: ReturnType<ManagedOmbreTransport['status']>['state'] = 'idle';
  connects = 0; closes = 0; calls: { name: string; arguments: Readonly<Record<string, unknown>> }[] = [];
  listing = tools(); lists = 0; failClose = false;
  identityPatch: Record<string, unknown> = {};
  hold?: 'connect' | 'probe'; onHold?: () => void;
  mutateAfterProbe = false;
  constructor(readonly binding: ManagedOmbreConfig) {}
  status() { return { state: this.state, pid: null, toolCount: this.state === 'ready' ? this.listing.length : 0, stderrBytes: 7, stderrTruncated: false }; }
  async wait(signal?: AbortSignal) {
    this.onHold?.(); await new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('synthetic cancel')), { once: true }); if (signal?.aborted) reject(new Error('synthetic cancel')); });
  }
  async connect(options: Parameters<ManagedOmbreTransport['connect']>[0] = {}) { this.connects++; this.state = 'connecting'; if (this.hold === 'connect') await this.wait(options.signal); this.state = 'ready'; }
  listTools() { this.lists++; return structuredClone(this.listing); }
  async callTool(request: Parameters<ManagedOmbreTransport['callTool']>[0], options: Parameters<ManagedOmbreTransport['callTool']>[1] = {}) {
    this.calls.push(structuredClone(request)); if (this.hold === 'probe') await this.wait(options.signal);
    const body = { schemaVersion: 1, backendId: this.binding.backendId, deploymentId: this.binding.deploymentId, scope: this.binding.scope,
      operationId: request.arguments.operationId, state: 'absent', command: null, commandDigest: null, plannedNativeId: null, nativeId: null, receipt: null, reason: null, ...this.identityPatch };
    if (this.mutateAfterProbe) this.listing.push({ name: 'uncontrolled', inputSchema: { type: 'object', properties: {}, required: [] } });
    return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: body };
  }
  async close() { this.closes++; if (this.failClose) throw new Error('synthetic secret path must not escape'); this.state = 'closed'; }
}

test('missing descriptor, construction and status never create a transport, root or configuration', async t => {
  const f = await fixture(t); assert.equal(await loadManagedOmbreConfig(f.directory), undefined);
  let created = 0;
  const managed = new ManagedOmbreBackend(f.config, { transportFactory() { created++; return new TransportFixture(f.config); } });
  for (let i = 0; i < 5; i++) assert.equal(managed.status().state, 'idle');
  assert.equal(created, 0); assert.deepEqual(await readdir(f.directory), ['upstream']);
  await managed.close(); assert.equal(created, 0); assert.equal(managed.status().state, 'closed');
});

test('descriptor is a bounded strict regular JSON file, and no executable script or environment override is accepted', async t => {
  const f = await fixture(t); await f.save(); assert.deepEqual(await loadManagedOmbreConfig(f.directory), f.config);
  for (const value of [{ ...f.config, env: {} }, { ...f.config, servicePath: '/another.py' }, { ...f.config, scope: 'other' }, { ...f.config, embedding: 'harrier' },
    { ...f.config, python: 'python3' }, { ...f.config, root: '/' }, { ...f.config, root: f.config.upstream }, { ...f.config, upstream: `${f.config.upstream}/../other` }]) {
    await f.save(value); await assert.rejects(loadManagedOmbreConfig(f.directory), errorCode('INVALID_CONFIG'));
  }
  await writeFile(f.descriptor, ' '.repeat(16385)); await assert.rejects(loadManagedOmbreConfig(f.directory), errorCode('INVALID_CONFIG'));
  await writeFile(f.descriptor, Buffer.from([0xff, 0xfe])); await assert.rejects(loadManagedOmbreConfig(f.directory), errorCode('INVALID_CONFIG'));
  await rm(f.descriptor); const actual = join(f.directory, 'other.json'); await writeFile(actual, JSON.stringify(f.config)); await symlink(actual, f.descriptor);
  await assert.rejects(loadManagedOmbreConfig(f.directory), errorCode('INVALID_CONFIG'));
});

test('pre-aborted open and invalid filesystem paths fail before creating the owned transport', async t => {
  const f = await fixture(t); let created = 0;
  const options = { transportFactory() { created++; return new TransportFixture(f.config); } };
  const aborted = new ManagedOmbreBackend(f.config, options);
  await assert.rejects(aborted.open({ signal: AbortSignal.abort() }), errorCode('CANCELLED')); assert.equal(created, 0);
  const missing = new ManagedOmbreBackend({ ...f.config, python: join(f.directory, 'missing-python') }, options);
  await assert.rejects(missing.open(), errorCode('INVALID_PATH')); assert.equal(created, 0);
  await symlink(f.config.upstream, f.config.root);
  const linked = new ManagedOmbreBackend(f.config, options);
  await assert.rejects(linked.open(), errorCode('INVALID_PATH')); assert.equal(created, 0);
  await Promise.all([aborted.close(), missing.close(), linked.close()]);
});

test('explicit open checks the exact tool contract and one read-only binding probe without a create or implicit replay', async t => {
  const f = await fixture(t); const client = new TransportFixture(f.config); let launch: PrivateStdioMcpOptions | undefined;
  const managed = new ManagedOmbreBackend(f.config, { transportFactory(options) { launch = options; return client; } });
  await managed.open(); const status = managed.status(); assert.equal(status.state, 'ready'); assert.equal(status.bindingVerified, true); assert.equal(status.semanticReady, false);
  assert.equal(client.connects, 1); assert.equal(client.calls.length, 1); assert.equal(client.calls[0]!.name, 'shiyu_memory_operation_status');
  assert.match(String(client.calls[0]!.arguments.operationId), /^managed-probe:/); assert.equal(client.calls[0]!.arguments.scope, 'local-owner');
  assert.equal(launch!.command, '/usr/bin/env'); assert.equal(launch!.args![0], '-i'); assert.deepEqual(launch!.env, {});
  assert.ok(launch!.args!.includes(f.config.python)); assert.ok(launch!.args!.includes('-I')); assert.equal(launch!.args!.at(-1), '--without-embedding');
  assert.equal(launch!.args!.filter(value => value.endsWith('/service/ombre/service.py')).length, 1);
  assert.ok(!JSON.stringify(status).includes(f.directory)); assert.ok(!JSON.stringify(status).includes('PATH')); assert.equal(status.stderrBytes, 7);
  await assert.rejects(managed.open(), errorCode('NOT_READY')); assert.equal(client.connects, 1);
  await managed.close(); await managed.close(); assert.equal(client.closes, 1);
});

test('additional, missing or incompatible tools close the child before the binding probe', async t => {
  for (const mode of ['extra', 'missing', 'schema', 'required-task'] as const) {
    const f = await fixture(t); const client = new TransportFixture(f.config);
    if (mode === 'extra') client.listing.push({ name: 'raw_grow', inputSchema: { type: 'object', properties: {}, required: [] } });
    if (mode === 'missing') client.listing.pop();
    if (mode === 'schema') client.listing[0]!.inputSchema.required = [];
    if (mode === 'required-task') Object.assign(client.listing[0]!, { execution: { taskSupport: 'required' } });
    const managed = new ManagedOmbreBackend(f.config, { transportFactory: () => client });
    await assert.rejects(managed.open(), errorCode('TOOL_MISMATCH')); assert.equal(client.calls.length, 0); assert.equal(client.closes, 1); assert.equal(managed.status().state, 'failed');
    await managed.close();
  }
});

test('binding mismatch, non-absent random probe and a changed post-probe tool set are terminal', async t => {
  for (const patch of [{ backendId: 'wrong-backend' }, { deploymentId: 'wrong-deployment' }, { scope: 'wrong-scope' }, { state: 'unknown' }]) {
    const f = await fixture(t); const client = new TransportFixture(f.config); client.identityPatch = patch;
    const managed = new ManagedOmbreBackend(f.config, { transportFactory: () => client });
    await assert.rejects(managed.open(), errorCode('BINDING_MISMATCH')); assert.equal(client.calls.length, 1); assert.equal(client.closes, 1); assert.equal(managed.status().bindingVerified, false); await managed.close();
  }
  const f = await fixture(t), client = new TransportFixture(f.config); client.mutateAfterProbe = true;
  const managed = new ManagedOmbreBackend(f.config, { transportFactory: () => client });
  await assert.rejects(managed.open(), errorCode('TOOL_MISMATCH')); assert.equal(client.calls.length, 1); assert.equal(client.closes, 1); await managed.close();
});

test('close drains open during connect or the identity probe, and it never reconnects', async t => {
  for (const hold of ['connect', 'probe'] as const) {
    const f = await fixture(t); const client = new TransportFixture(f.config); client.hold = hold;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); client.onHold = entered;
    const managed = new ManagedOmbreBackend(f.config, { transportFactory: () => client });
    const rejected = assert.rejects(managed.open(), errorCode('CANCELLED')); await started;
    await managed.close(); await rejected; assert.equal(managed.status().state, 'closed'); assert.equal(client.closes, 1); assert.equal(client.connects, 1);
    await assert.rejects(managed.open(), errorCode('NOT_READY'));
  }
});

test('transport loss and unconfirmed child close remain visible without environment or backend error text', async t => {
  const f = await fixture(t), client = new TransportFixture(f.config);
  const managed = new ManagedOmbreBackend(f.config, { transportFactory: () => client }); await managed.open();
  client.state = 'failed'; assert.equal(managed.status().state, 'failed'); assert.equal(managed.status().lastErrorCode, 'DISCONNECTED');
  assert.equal(client.connects, 1); client.failClose = true;
  await assert.rejects(managed.close(), errorCode('CLOSE_UNCONFIRMED')); assert.equal(managed.status().state, 'failed');
  assert.equal(managed.status().lastErrorCode, 'CLOSE_UNCONFIRMED'); assert.ok(!JSON.stringify(managed.status()).includes('synthetic secret'));
});

test('real SDK owns the synthetic stdio peer while env -i prevents inherited defaults from reaching it', async t => {
  const f = await fixture(t), trace = join(f.directory, 'peer-trace.jsonl');
  // This peer replaces only the Python/service program inside a trusted test factory.
  // The production launcher and real SDK transport remain; no Ombre/model is run.
  const peer = `import {appendFileSync} from 'node:fs'; import {createInterface} from 'node:readline';
const log=x=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(x)+'\\n'); const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
log({event:'spawn',pid:process.pid,envKeys:Object.keys(process.env).sort()});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method)log({method:m.method,name:m.params?.name});
if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-controlled-peer',version:'1'}});
if(m.method==='tools/list')send(m.id,{tools:${JSON.stringify(tools())}});
if(m.method==='tools/call'){const body={schemaVersion:1,backendId:${JSON.stringify(f.config.backendId)},deploymentId:${JSON.stringify(f.config.deploymentId)},scope:'local-owner',operationId:m.params.arguments.operationId,state:'absent',command:null,commandDigest:null,plannedNativeId:null,nativeId:null,receipt:null,reason:null};send(m.id,{content:[{type:'text',text:JSON.stringify(body)}],structuredContent:body});}});
process.stdin.on('end',()=>process.exit(0));`;
  let real: PrivateStdioMcpClient | undefined;
  const managed = new ManagedOmbreBackend(f.config, { transportFactory(launch) {
    const beforePython = launch.args!.slice(0, launch.args!.indexOf(f.config.python));
    return real = new PrivateStdioMcpClient({ ...launch, args: [...beforePython, process.execPath, '--input-type=module', '-e', peer] });
  } });
  t.after(() => managed.close()); await managed.open(); const pid = real!.status().pid; assert.ok(pid);
  const rows = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  // macOS may synthesize __CF_USER_TEXT_ENCODING during process startup; this
  // is not inherited SDK/user configuration. No values are inspected.
  assert.deepEqual(rows[0].envKeys.filter((key: string) => !(process.platform === 'darwin' && key === '__CF_USER_TEXT_ENCODING')), ['LANG', 'LC_ALL', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TMPDIR']);
  assert.equal(rows.filter(row => row.method === 'tools/call').length, 1); assert.equal(rows.find(row => row.method === 'tools/call').name, 'shiyu_memory_operation_status');
  await managed.close(); assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
});

test('parent directory aliases cannot place a new data root inside upstream or an interpreter installation', async t => {
  const f = await fixture(t); const alias = join(f.directory, 'upstream-alias'); await symlink(f.config.upstream, alias);
  let created = 0; const factory = () => { created++; return new TransportFixture(f.config); };
  const managed = new ManagedOmbreBackend({ ...f.config, root: join(alias, 'new-parent', 'private-vault') }, { transportFactory: factory });
  await assert.rejects(managed.open(), errorCode('INVALID_PATH')); assert.equal(created, 0); assert.deepEqual(await readdir(f.config.upstream), []); await managed.close();
  const executableAlias = join(f.directory, 'interpreter-installation'); await symlink(dirname(process.execPath), executableAlias);
  // A Python executable may legitimately be a venv symlink, but the dedicated
  // data root may not resolve to the directory containing that interpreter.
  const parent = new ManagedOmbreBackend({ ...f.config, root: executableAlias }, { transportFactory: factory });
  await assert.rejects(parent.open(), errorCode('INVALID_PATH')); assert.equal(created, 0); await parent.close();
});
