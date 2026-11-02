import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrivateStdioMcpClient, type PrivateStdioMcpOptions } from '../src/adapters/mcp/index.js';
import { ManagedOmbreBackend, ManagedOmbreError, loadManagedOmbreConfig, type ManagedOmbreConfig, type ManagedOmbreTransport, type ManagedOmbreHarrier } from '../src/adapters/ombre/managed.js';
import { HARRIER_PROFILE } from '../src/adapters/embedding/index.js';
import { OMBRE_HARRIER_PROFILE_ID, OMBRE_HARRIER_PROFILE_FINGERPRINT, memoryIndexCommandDigest, memoryQueryDigest, type MemoryIndexCommand, type MemorySearchRequest } from '../src/contracts/semantic-memory.js';

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
  async callTool(request: Parameters<ManagedOmbreTransport['callTool']>[0], options: Parameters<ManagedOmbreTransport['callTool']>[1] = {}): ReturnType<ManagedOmbreTransport['callTool']> {
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

const semanticTools = () => [...tools(), ...Object.entries({ shiyu_memory_backend_status: ['scope'], shiyu_memory_index_ensure: ['command', 'commandDigest'],
  shiyu_memory_index_status: ['indexOperationId', 'scope'], shiyu_memory_search_candidates: ['scope', 'query', 'limit', 'eligibleRefs', 'profileFingerprint', 'expectedIndexBaselineId', 'expectedIndexWatermark', 'deadlineAtMs'] })
  .map(([name, args]) => ({ name, inputSchema: { type: 'object' as const, properties: Object.fromEntries(args.map(key => [key, {
    type: key === 'command' ? 'object' : key === 'eligibleRefs' ? 'array' : ['limit', 'expectedIndexWatermark', 'deadlineAtMs'].includes(key) ? 'integer' : 'string' }])), required: args } }))];
class HarrierFixture implements ManagedOmbreHarrier {
  state: ReturnType<ManagedOmbreHarrier['status']>['state'] = 'idle'; opens = 0; closes = 0; hold = false; entered?: () => void;
  constructor(readonly order: string[], readonly directory: string) {}
  status(): ReturnType<ManagedOmbreHarrier['status']> { return { state: this.state, verified: this.state === 'ready', profileId: HARRIER_PROFILE.id,
    runtimeFingerprint: 'a'.repeat(64), childGeneration: this.opens, readinessProbe: this.state === 'ready' ? 'passed' : 'not-run', embeddingVerified: false }; }
  async open(options: Parameters<ManagedOmbreHarrier['open']>[0] = {}) {
    this.opens++; this.order.push('harrier-open'); this.state = 'opening';
    if (this.hold) { this.entered?.(); await new Promise<void>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }); if (options.signal?.aborted) reject(options.signal.reason);
    }); }
    this.state = 'ready'; return { endpoint: 'http://127.0.0.1:12345/v1/embeddings', keyFile: join(this.directory, 'owned-key-file') };
  }
  async close() { this.closes++; this.order.push('harrier-close'); this.state = 'closed'; }
}
class SemanticTransportFixture extends TransportFixture {
  override listing = semanticTools(); backendPatch: Record<string, unknown> = {}; searchEmbeddingCalls = 1;
  constructor(binding: ManagedOmbreConfig, readonly order: string[]) { super(binding); }
  override async connect(options: Parameters<ManagedOmbreTransport['connect']>[0] = {}) { this.order.push('ombre-open'); await super.connect(options); }
  override async callTool(request: Parameters<ManagedOmbreTransport['callTool']>[0], options: Parameters<ManagedOmbreTransport['callTool']>[1] = {}) {
    if (request.name !== 'shiyu_memory_backend_status' && request.name !== 'shiyu_memory_search_candidates') return super.callTool(request, options);
    this.calls.push(structuredClone(request));
    const common = { schemaVersion: 2, backendId: this.binding.backendId, deploymentId: this.binding.deploymentId, scope: 'local-owner',
      profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT, indexBaselineId: 'index_' + '1'.repeat(32), indexWatermark: 5 };
    let body: Record<string, unknown>;
    if (request.name === 'shiyu_memory_backend_status') body = { ...common, semanticApi: true, recordedIndexedCount: 1, embeddingConfigured: true,
      limits: { maxEligibleRefs: 128, maxScannedRows: 2048, maxResults: 10, maxEmbeddingCallsPerIndex: 2, maxDeadlineMs: 60000 }, ...this.backendPatch };
    else {
      const input = request.arguments as unknown as MemorySearchRequest;
      body = { ...common, state: 'ok', queryDigest: memoryQueryDigest(input.query), embeddingCalls: input.eligibleRefs.length ? this.searchEmbeddingCalls : 0,
        usageComplete: true, coverage: { eligibleCount: input.eligibleRefs.length, indexedCount: input.eligibleRefs.length, missingCount: 0 },
        matches: input.eligibleRefs.map(ref => ({ memoryOperationId: ref.memoryOperationId, nativeId: ref.nativeId, componentVersion: ref.componentVersion,
          bodyDigest: ref.bodyDigest, indexReceiptId: 'index_receipt_' + '2'.repeat(64), indexWatermark: 5, score: 0.8 })) };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], structuredContent: body };
  }
  override async close() { this.order.push('ombre-close'); await super.close(); }
}
async function semanticFixture(t: TestContext) {
  const f = await fixture(t); const modelArtifact = join(f.directory, 'model-artifact'); await writeFile(modelArtifact, 'synthetic artifact; never executed');
  const config: ManagedOmbreConfig = { ...f.config, schemaVersion: 2, embedding: { mode: 'managed-harrier', profileId: OMBRE_HARRIER_PROFILE_ID,
    serverBinary: process.execPath, modelArtifact } };
  const order: string[] = [], harrier = new HarrierFixture(order, f.directory), client = new SemanticTransportFixture(config, order);
  let harrierFactories = 0, transportFactories = 0, launch: PrivateStdioMcpOptions | undefined;
  const managed = new ManagedOmbreBackend(config, { harrierFactory() { harrierFactories++; return harrier; },
    transportFactory(options) { transportFactories++; launch = options; return client; } });
  return { ...f, config, order, harrier, client, managed, stats: () => ({ harrierFactories, transportFactories, launch }) };
}

test('schema2 requires a fixed owned Harrier descriptor and construction/status remain side-effect free', async t => {
  const f = await semanticFixture(t); await f.save(f.config);
  assert.deepEqual(await loadManagedOmbreConfig(f.directory), f.config);
  for (const embedding of ['disabled', { ...f.config.embedding, endpoint: 'http://127.0.0.1:9/v1/embeddings' },
    { ...f.config.embedding, keyFile: '/untrusted/key' }, { ...f.config.embedding, env: {} }, { ...f.config.embedding, profileId: HARRIER_PROFILE.id },
    { ...f.config.embedding, serverBinary: 'llama-server' }, { ...f.config.embedding, mode: 'external' }]) {
    await f.save({ ...f.config, embedding }); await assert.rejects(loadManagedOmbreConfig(f.directory), errorCode('INVALID_CONFIG'));
  }
  for (let i = 0; i < 5; i++) { assert.equal(f.managed.status().storageReady, false); assert.equal(f.managed.status().semanticReady, false); }
  assert.equal(f.stats().harrierFactories, 0); assert.equal(f.stats().transportFactories, 0); assert.deepEqual(f.order, []);
  await f.managed.close(); assert.deepEqual(f.order, []);
});

test('schema2 starts the owned embedding provider before Ombre, checks all seven tools, and closes in dependency order', async t => {
  const f = await semanticFixture(t); await f.managed.open();
  assert.deepEqual(f.order, ['harrier-open', 'ombre-open']);
  assert.deepEqual(f.client.calls.map(call => call.name), ['shiyu_memory_operation_status', 'shiyu_memory_backend_status']);
  const status = f.managed.status(); assert.equal(status.storageReady, true); assert.equal(status.toolCount, 7); assert.equal(status.semanticReady, false);
  assert.equal(status.semantic!.state, 'unverified'); assert.equal(status.semantic!.profileCompatible, true); assert.equal(status.semantic!.embeddingVerified, false);
  const launch = f.stats().launch!; assert.ok(launch.args!.includes('--semantic-api')); assert.ok(launch.args!.includes('--embedding-key-file'));
  assert.ok(launch.args!.includes('http://127.0.0.1:12345/v1/embeddings')); assert.equal(launch.args!.includes('--without-embedding'), false);
  const calls = f.client.calls.length; for (let i = 0; i < 5; i++) f.managed.status(); assert.equal(f.client.calls.length, calls);
  assert.equal(JSON.stringify(status).includes(f.directory), false); assert.equal(JSON.stringify(status).includes('12345'), false);
  await f.managed.close(); assert.deepEqual(f.order, ['harrier-open', 'ombre-open', 'ombre-close', 'harrier-close']);
  await f.managed.close(); assert.equal(f.harrier.closes, 1); assert.equal(f.client.closes, 1);
});

test('a v2 service cannot downgrade, expand its tool set, or replace the expected profile and deployment', async t => {
  for (const mode of ['three-tools', 'extra-tool', 'arg-type', 'profile', 'deployment', 'limits'] as const) {
    const f = await semanticFixture(t);
    if (mode === 'three-tools') f.client.listing = tools();
    if (mode === 'extra-tool') f.client.listing.push({ name: 'raw_search', inputSchema: { type: 'object', properties: {}, required: [] } });
    if (mode === 'arg-type') f.client.listing.find(tool => tool.name === 'shiyu_memory_search_candidates')!.inputSchema.properties.limit = { type: 'string' };
    if (mode === 'profile') f.client.backendPatch = { profileFingerprint: '0'.repeat(64) };
    if (mode === 'deployment') f.client.backendPatch = { deploymentId: 'other-deployment' };
    if (mode === 'limits') f.client.backendPatch = { limits: {} };
    await assert.rejects(f.managed.open(), errorCode(['extra-tool', 'three-tools', 'arg-type'].includes(mode) ? 'TOOL_MISMATCH' : 'BINDING_MISMATCH'));
    assert.deepEqual(f.order, ['harrier-open', 'ombre-open', 'ombre-close', 'harrier-close']);
    assert.equal(f.managed.status().bindingVerified, false); assert.equal(f.managed.status().storageReady, false); assert.equal(f.managed.status().semanticReady, false);
    await f.managed.close();
  }
});

test('cancellation and total startup timeout stop Harrier without ever creating the Ombre child', async t => {
  for (const timed of [false, true]) {
    const f = await semanticFixture(t); f.harrier.hold = true;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); f.harrier.entered = entered;
    const cancelled = assert.rejects(f.managed.open({ timeoutMs: timed ? 15 : 1000 }), errorCode(timed ? 'TIMEOUT' : 'CANCELLED'));
    await started; if (!timed) await f.managed.close(); await cancelled;
    assert.equal(f.stats().transportFactories, 0); assert.equal(f.harrier.closes, 1); assert.deepEqual(f.order, ['harrier-open', 'harrier-close']);
    await f.managed.close(); assert.equal(f.harrier.closes, 1);
  }
});

test('only observed real embedding work marks inference verified, and provider loss immediately removes semantic readiness', async t => {
  const f = await semanticFixture(t); await f.managed.open();
  const input: MemorySearchRequest = { scope: 'local-owner', query: 'synthetic query', limit: 1, eligibleRefs: [], profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
    expectedIndexBaselineId: 'index_' + '1'.repeat(32), expectedIndexWatermark: 5, deadlineAtMs: Date.now() + 30000 };
  assert.equal((await f.managed.adapter.searchCandidates(input)).embeddingCalls, 0); assert.equal(f.managed.status().semanticReady, false);
  input.eligibleRefs = [{ memoryOperationId: 'memory-one', bodyReceiptId: 'receipt_' + '3'.repeat(64), nativeId: 'shiyu_' + '4'.repeat(32),
    componentVersion: 'sha256:' + '5'.repeat(64), bodyDigest: '6'.repeat(64) }];
  f.client.searchEmbeddingCalls = 0;
  await f.managed.adapter.searchCandidates(input); assert.equal(f.managed.status().semanticReady, false);
  f.client.searchEmbeddingCalls = 1;
  await f.managed.adapter.searchCandidates(input); assert.equal(f.managed.status().semanticReady, true); assert.equal(f.managed.status().semantic!.embeddingVerified, true);
  f.harrier.state = 'failed'; assert.equal(f.managed.status().semanticReady, false); assert.equal(f.managed.status().storageReady, true);
  assert.equal(f.managed.status().semantic!.state, 'unavailable');
  const calls = f.client.calls.length; await assert.rejects(f.managed.adapter.searchCandidates(input), errorCode('EMBEDDING_UNAVAILABLE')); assert.equal(f.client.calls.length, calls);
  await f.managed.close();
});

test('an unconfirmed Ombre shutdown still closes the owned provider and never reconnects', async t => {
  const f = await semanticFixture(t); await f.managed.open(); f.client.failClose = true;
  await assert.rejects(f.managed.close(), errorCode('CLOSE_UNCONFIRMED'));
  assert.equal(f.harrier.closes, 1); assert.equal(f.client.connects, 1); assert.equal(f.managed.status().state, 'failed');
  assert.deepEqual(f.order, ['harrier-open', 'ombre-open', 'ombre-close', 'harrier-close']);
});

test('historical index usage cannot attest a fresh provider process, and late results are withheld after close', async t => {
  const f = await semanticFixture(t); await f.managed.open();
  const command: MemoryIndexCommand = { schemaVersion: 1, kind: 'ensure-index', backendId: f.config.backendId, deploymentId: f.config.deploymentId,
    scope: 'local-owner', indexOperationId: 'historical-index', memoryOperationId: 'memory-one', bodyReceiptId: 'receipt_' + '3'.repeat(64),
    nativeId: 'shiyu_' + '4'.repeat(32), componentVersion: 'sha256:' + '5'.repeat(64), bodyDigest: '6'.repeat(64), profileFingerprint: OMBRE_HARRIER_PROFILE_FINGERPRINT,
    indexBaselineId: 'index_' + '1'.repeat(32), expectedIndexWatermark: 4, deadlineAtMs: Date.now() - 30000, maxEmbeddingCalls: 2 };
  const original = f.client.callTool.bind(f.client);
  f.client.callTool = async (request, options) => {
    if (request.name !== 'shiyu_memory_index_status') return original(request, options);
    const receipt = { schemaVersion: 2, backendId: f.config.backendId, deploymentId: f.config.deploymentId, scope: 'local-owner',
      receiptId: 'index_receipt_' + '2'.repeat(64), indexOperationId: command.indexOperationId, memoryOperationId: command.memoryOperationId,
      bodyReceiptId: command.bodyReceiptId, commandDigest: memoryIndexCommandDigest(command), nativeId: command.nativeId, componentVersion: command.componentVersion,
      bodyDigest: command.bodyDigest, profileFingerprint: command.profileFingerprint, indexBaselineId: command.indexBaselineId, indexWatermark: 5,
      content: { digest: command.bodyDigest, vectorHash: '7'.repeat(64), dimensions: 1024 }, meaning: { state: 'absent', digest: null, vectorHash: null, dimensions: null },
      embeddingCalls: 1, observedAt: new Date(command.deadlineAtMs - 1000).toISOString() };
    const body = { schemaVersion: 2, backendId: f.config.backendId, deploymentId: f.config.deploymentId, scope: 'local-owner', indexOperationId: command.indexOperationId,
      state: 'applied', command, commandDigest: memoryIndexCommandDigest(command), receipt, reason: null, currentIndexBaselineId: command.indexBaselineId,
      currentIndexWatermark: 5, embeddingCalls: 1, usageComplete: true };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
  };
  assert.equal((await f.managed.adapter.indexStatus(command)).embeddingCalls, 1);
  assert.equal(f.managed.status().semantic!.embeddingVerified, false); assert.equal(f.managed.status().semantic!.lastEmbeddingSuccessAt, null);
  let arrived!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.client.callTool = async (...args) => { const result = await original(...args); arrived(); await gate; return result; };
  const late = assert.rejects(f.managed.adapter.backendStatus(), errorCode('NOT_READY'));
  await entered; await f.managed.close(); release(); await late;
  assert.equal(f.managed.status().storageReady, false); assert.equal(f.managed.status().semanticReady, false);
});
