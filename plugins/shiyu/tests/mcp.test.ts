import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrivateStdioMcpClient, PrivateMcpError, type PrivateStdioMcpOptions } from '../src/adapters/mcp/index.js';
import type { OmbreMcpTransport } from '../src/adapters/ombre/index.js';

// A synthetic JSON-RPC peer only. The production client and stdio lifecycle use the real SDK.
const fixture = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const trace = process.env.MCP_FIXTURE_TRACE, mode = process.env.MCP_FIXTURE_MODE;
const log = value => appendFileSync(trace, JSON.stringify(value)+'\n');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const result = (id, value) => send({jsonrpc:'2.0',id,result:value});
let capabilities, pending, errors=[];
log({event:'spawn',pid:process.pid});
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if (m.method) log({method:m.method,name:m.params?.name});
 if (m.method==='initialize') {
  capabilities=m.params.capabilities;
  if(mode==='stall-init')return;
  return result(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic-private-mcp',version:'1.0.0'}});
 }
 if(m.method==='tools/list')return result(m.id,{tools:['echo','hold','drop','server_requests','stderr','error'].map(name=>({name,inputSchema:{type:'object',properties:{value:{type:'string'}}}})).concat([{name:'requires_task',inputSchema:{type:'object'},execution:{taskSupport:'required'}}])});
 if(m.method==='tools/call') {
  if(m.params.name==='hold')return;
  if(m.params.name==='drop')return process.exit(0);
  if(m.params.name==='server_requests') {
   pending=m.id;
   send({jsonrpc:'2.0',id:'server-sampling',method:'sampling/createMessage',params:{messages:[],maxTokens:1}});
   send({jsonrpc:'2.0',id:'server-elicitation',method:'elicitation/create',params:{mode:'form',message:'synthetic',requestedSchema:{type:'object',properties:{}}}});
   return;
  }
  if(m.params.name==='stderr')process.stderr.write('synthetic-private-secret'.repeat(300));
  return result(m.id,{content:[{type:'text',text:JSON.stringify(m.params.arguments)}],...(m.params.name==='error'?{isError:true}:{})});
 }
 if(m.id==='server-sampling'||m.id==='server-elicitation') {
  errors.push(m.error?.code??'unexpected-success');
  if(errors.length===2)result(pending,{content:[{type:'text',text:JSON.stringify({errors,capabilities})}]});
 }
});
process.stdin.on('end',()=>{log({event:'exit'});process.exit(0)});
`;
async function setup(overrides: Partial<PrivateStdioMcpOptions> = {}, mode = '') {
  const dir = await mkdtemp(join(tmpdir(), 'shiyu-mcp-')), trace = join(dir, 'trace.jsonl');
  const client = new PrivateStdioMcpClient({ command: process.execPath, args: ['--input-type=module', '-e', fixture], cwd: dir,
    env: { MCP_FIXTURE_TRACE: trace, MCP_FIXTURE_MODE: mode }, connectTimeoutMs: 1500, callTimeoutMs: 500, ...overrides });
  const asOmbrePort: OmbreMcpTransport = client; void asOmbrePort;
  return { client, dir, trace,
    async records(): Promise<Record<string, unknown>[]> { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    async cleanup() { try { await client.close(); } finally { await rm(dir, { recursive: true, force: true }); } },
  };
}
const hasCode = (code: PrivateMcpError['code']) => (error: unknown) => error instanceof PrivateMcpError && error.code === code;
async function waitForCall(f: Awaited<ReturnType<typeof setup>>, name: string) {
  for (let i = 0; i < 100; i++) {
    if ((await f.records()).some(row => row.method === 'tools/call' && row.name === name)) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Synthetic fixture did not receive the expected call');
}

test('construction performs no IO and explicit real-SDK connect/list/call/close has one dispatch', async () => {
  const f = await setup();
  try {
    assert.equal(f.client.status().state, 'idle'); await assert.rejects(stat(f.trace));
    await assert.rejects(f.client.callTool({ name: 'echo', arguments: {} }), hasCode('NOT_READY'));
    await f.client.connect(); const pid = f.client.status().pid; assert.ok(pid && pid > 0);
    assert.equal(f.client.listTools().length, 7);
    const listing = f.client.listTools(); (listing[0] as { name: string }).name = 'mutated';
    const result = await f.client.callTool({ name: 'echo', arguments: { value: 'synthetic' } });
    assert.deepEqual(result.content, [{ type: 'text', text: '{"value":"synthetic"}' }]);
    const rows = await f.records();
    assert.equal(rows.filter(row => row.event === 'spawn').length, 1); // no negotiation probe process
    assert.equal(rows.filter(row => row.method === 'initialize').length, 1);
    assert.equal(rows.filter(row => row.method === 'tools/list').length, 1);
    assert.equal(rows.filter(row => row.method === 'tools/call').length, 1);
    await f.client.close(); await f.client.close(); assert.equal(f.client.status().state, 'closed');
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    await assert.rejects(f.client.connect(), hasCode('NOT_READY'));
  } finally { await f.cleanup(); }
});

test('server sampling and elicitation are rejected without advertising either capability', async () => {
  const f = await setup();
  try {
    await f.client.connect(); const result = await f.client.callTool({ name: 'server_requests', arguments: {} });
    const text = result.content[0]; assert.equal(text.type, 'text');
    assert.deepEqual(JSON.parse((text as { text: string }).text), { errors: [-32601, -32601], capabilities: {} });
  } finally { await f.cleanup(); }
});

test('stderr is drained but retained only as bounded byte counters, and MCP tool errors remain errors', async () => {
  const f = await setup({ maxStderrBytes: 128 });
  try {
    await f.client.connect(); await f.client.callTool({ name: 'stderr', arguments: {} });
    const result = await f.client.callTool({ name: 'error', arguments: {} }); assert.equal(result.isError, true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.client.status().stderrBytes, 128); assert.equal(f.client.status().stderrTruncated, true);
    assert.equal(JSON.stringify(f.client.status()).includes('synthetic-private-secret'), false);
  } finally { await f.cleanup(); }
});

test('unknown or task-required tools and already-cancelled calls are rejected before dispatch', async () => {
  const f = await setup();
  try {
    await f.client.connect();
    for (const name of ['unknown', 'requires_task']) await assert.rejects(f.client.callTool({ name, arguments: {} }), hasCode('INVALID_REQUEST'));
    await assert.rejects(f.client.callTool({ name: 'echo', arguments: {} }, { signal: AbortSignal.abort() }), hasCode('CANCELLED'));
    assert.equal((await f.records()).filter(row => row.method === 'tools/call').length, 0);
  } finally { await f.cleanup(); }
});

test('a timed out real stdio call closes its owned process and cannot be replayed', async () => {
  const f = await setup();
  try {
    await f.client.connect(); const pid = f.client.status().pid;
    await assert.rejects(f.client.callTool({ name: 'hold', arguments: {} }, { timeoutMs: 30 }), hasCode('TIMEOUT'));
    assert.equal((await f.records()).filter(row => row.method === 'tools/call').length, 1);
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    await assert.rejects(f.client.callTool({ name: 'hold', arguments: {} }), hasCode('NOT_READY'));
  } finally { await f.cleanup(); }
});

test('cancellation and explicit close drain in-flight calls without a second dispatch', async () => {
  for (const action of ['abort', 'close']) {
    const f = await setup();
    try {
      await f.client.connect(); const controller = new AbortController();
      const rejected = assert.rejects(f.client.callTool({ name: 'hold', arguments: {} }, { signal: controller.signal }), hasCode('CANCELLED'));
      await waitForCall(f, 'hold');
      await assert.rejects(f.client.callTool({ name: 'echo', arguments: {} }), hasCode('BUSY'));
      if (action === 'abort') controller.abort(new Error('synthetic-private-secret')); else await f.client.close();
      await rejected; assert.equal((await f.records()).filter(row => row.method === 'tools/call').length, 1);
      assert.equal(f.client.status().state, 'closed');
    } finally { await f.cleanup(); }
  }
});

test('disconnect after a dispatched call is terminal and does not reconnect or replay', async () => {
  const f = await setup();
  try {
    await f.client.connect(); await assert.rejects(f.client.callTool({ name: 'drop', arguments: {} }), error => error instanceof PrivateMcpError);
    await assert.rejects(f.client.callTool({ name: 'drop', arguments: {} }), hasCode('NOT_READY'));
    const rows = await f.records(); assert.equal(rows.filter(row => row.event === 'spawn').length, 1); assert.equal(rows.filter(row => row.method === 'tools/call').length, 1);
  } finally { await f.cleanup(); }
});

test('initialize timeout closes the spawned process and pre-aborted connect creates none', async () => {
  const f = await setup({}, 'stall-init');
  try {
    await assert.rejects(f.client.connect({ timeoutMs: 80 }), hasCode('TIMEOUT'));
    const spawned = (await f.records()).find(row => row.event === 'spawn'); assert.ok(spawned);
    assert.throws(() => process.kill(spawned.pid as number, 0), { code: 'ESRCH' });
  } finally { await f.cleanup(); }
  const aborted = await setup();
  try { await assert.rejects(aborted.client.connect({ signal: AbortSignal.abort() }), hasCode('CANCELLED')); assert.deepEqual(await aborted.records(), []); }
  finally { await aborted.cleanup(); }
});
