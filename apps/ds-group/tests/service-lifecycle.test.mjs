import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { packageRoot } from '../src/paths.mjs';
import { acquireNodeLock } from '../src/bot-node.mjs';

const execute = promisify(execFile);
const nodeId = 'bot-lifecycle-test';
const serviceScript = path.join(packageRoot, 'scripts/service.mjs');
const runtimeScript = path.join(packageRoot, 'scripts/dsh-node.mjs');
const unixOnly = { skip: process.platform === 'win32', timeout: 15_000 };

async function fixture(t, { relativeData = false } = {}) {
  const parent = path.join(packageRoot, '.local');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'service-lifecycle-'));
  const processes = [];
  t.after(async () => {
    for (const { child } of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(processes.map(({ closed }) => closed));
    await rm(directory, { recursive: true, force: true });
  });
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DS_GROUP_') || key === 'OPENCODE_API_KEY' || key === 'NODE_OPTIONS') delete environment[key];
  }
  Object.assign(environment, {
    DS_GROUP_DATA_DIR: relativeData ? '.' : directory,
    DS_GROUP_BRIDGE_PORT: '23999',
    DS_GROUP_CORE_URL: 'http://127.0.0.1:1',
    DS_GROUP_CORE_CONFIG_PATH: path.join(directory, 'core-config.json'),
    LIFECYCLE_LOG: path.join(directory, 'events.jsonl'),
  });
  async function start(args) {
    const child = spawn(process.execPath, args, { cwd: packageRoot, env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const processRecord = { child, closed };
    processes.push(processRecord);
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(message, 'ready', stderr);
    return processRecord;
  }

  const adapterScript = path.join(directory, 'adapter.mjs');
  await writeFile(adapterScript, `
import { appendFileSync } from 'node:fs';
const record = event => appendFileSync(process.env.LIFECYCLE_LOG, JSON.stringify(event) + '\\n');
process.once('SIGTERM', () => {
  record('adapter:term');
  setTimeout(() => { record('adapter:drained'); process.exit(0); }, 150);
});
setInterval(() => {}, 1000);
process.send('ready');
`);
  const adapter = await start([adapterScript]);
  const runtime = await start(['-e', `
const { appendFileSync } = require('node:fs');
const record = event => appendFileSync(process.env.LIFECYCLE_LOG, JSON.stringify(event) + '\\n');
process.once('SIGTERM', () => {
  record('runtime:term');
  try {
    process.kill(${adapter.child.pid}, 0);
    record('runtime:adapter-alive');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    record('runtime:adapter-exited');
  }
  record('runtime:stopped');
  process.exit(0);
});
setInterval(() => {}, 1000);
process.send('ready');
`, runtimeScript, 'run', nodeId]);
  const adapterRecord = path.join(directory, 'processes', `${nodeId}.json`);
  const runtimeDirectory = path.join(directory, `dsh-${nodeId}`);
  await mkdir(path.dirname(adapterRecord), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(adapterRecord, JSON.stringify({ name: nodeId, pid: adapter.child.pid, script: adapterScript }));
  await writeFile(path.join(runtimeDirectory, 'process.json'), JSON.stringify({
    nodeId, pid: runtime.child.pid, script: runtimeScript, local: runtimeDirectory,
  }));
  const lifecycleLock = path.join(directory, 'processes', `${nodeId}.lifecycle.sqlite`);
  const down = (...flags) => {
    const result = execute(process.execPath, [serviceScript, 'down', nodeId, ...flags], {
      cwd: relativeData ? directory : packageRoot, env: environment, timeout: 10_000,
    });
    const child = result.child;
    const closed = new Promise(resolve => child.once('close', resolve));
    processes.push({ child, closed });
    return result;
  };
  const readLockOwner = () => {
    const db = new DatabaseSync(lifecycleLock, { readOnly: true });
    try { return db.prepare('SELECT pid FROM owner WHERE id=1').get()?.pid; }
    finally { db.close(); }
  };
  const events = async () => (await readFile(environment.LIFECYCLE_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  return { adapter, runtime, adapterRecord, down, events, lifecycleLock, readLockOwner, start };
}

test('service down drains the adapter and retains its runtime until explicitly requested', unixOnly, async t => {
  const f = await fixture(t);
  await f.down();
  assert.deepEqual(await f.adapter.closed, { code: 0, signal: null });
  assert.equal(f.runtime.child.exitCode, null);
  assert.equal(f.runtime.child.signalCode, null);
  assert.doesNotThrow(() => process.kill(f.runtime.child.pid, 0));
  assert.deepEqual(await f.events(), ['adapter:term', 'adapter:drained']);
  await assert.rejects(readFile(f.adapterRecord), { code: 'ENOENT' });

  // A host can stop after the adapter exits and retry cleanup from its durable runtime record.
  await f.down('--with-runtime');
  assert.deepEqual(await f.runtime.closed, { code: 0, signal: null });
  assert.deepEqual(await f.events(), ['adapter:term', 'adapter:drained', 'runtime:term', 'runtime:adapter-exited', 'runtime:stopped']);
});

test('one service down command drains the adapter before stopping its runtime and is retryable', unixOnly, async t => {
  const f = await fixture(t);
  await f.down('--with-runtime');
  assert.deepEqual(await f.adapter.closed, { code: 0, signal: null });
  assert.deepEqual(await f.runtime.closed, { code: 0, signal: null });
  assert.deepEqual(await f.events(), ['adapter:term', 'adapter:drained', 'runtime:term', 'runtime:adapter-exited', 'runtime:stopped']);
  await assert.rejects(readFile(f.adapterRecord), { code: 'ENOENT' });
  await f.down('--with-runtime');
  assert.deepEqual(await f.events(), ['adapter:term', 'adapter:drained', 'runtime:term', 'runtime:adapter-exited', 'runtime:stopped']);
});

test('service runtime shutdown resolves relative data paths from the caller directory', unixOnly, async t => {
  const f = await fixture(t, { relativeData: true });
  await f.down('--with-runtime');
  assert.deepEqual(await f.adapter.closed, { code: 0, signal: null });
  assert.deepEqual(await f.runtime.closed, { code: 0, signal: null });
  assert.deepEqual(await f.events(), ['adapter:term', 'adapter:drained', 'runtime:term', 'runtime:adapter-exited', 'runtime:stopped']);
});

test('service CLI waits for the active lifecycle owner and continues after release', unixOnly, async t => {
  const f = await fixture(t);
  const release = await acquireNodeLock(f.lifecycleLock);
  let pending;
  try {
    await assert.rejects(acquireNodeLock(f.lifecycleLock), { code: 'NODE_PROCESS_ACTIVE' });
    let finished = false;
    const operation = f.down('--with-runtime');
    pending = operation.then(
      result => { finished = true; return { result }; },
      error => { finished = true; return { error }; },
    );
    await once(operation.child, 'spawn');
    await delay(600);
    assert.equal(finished, false);
    assert.equal(f.readLockOwner(), process.pid);
    assert.equal(f.adapter.child.exitCode, null);
    assert.equal(f.runtime.child.exitCode, null);
    await assert.rejects(f.events(), { code: 'ENOENT' });
  } finally { await release(); }
  const result = await pending;
  assert.ifError(result.error);
  assert.deepEqual(await f.adapter.closed, { code: 0, signal: null });
  assert.deepEqual(await f.runtime.closed, { code: 0, signal: null });
  assert.equal(f.readLockOwner(), undefined);
});

test('service CLI reclaims a lifecycle lock after its actual owner process exits', unixOnly, async t => {
  const f = await fixture(t);
  const moduleUrl = pathToFileURL(path.join(packageRoot, 'src/bot-node.mjs')).href;
  const owner = await f.start(['--input-type=module', '-e', `
import { acquireNodeLock } from ${JSON.stringify(moduleUrl)};
await acquireNodeLock(${JSON.stringify(f.lifecycleLock)});
setInterval(() => {}, 1000);
process.send('ready');
`]);
  assert.equal(f.readLockOwner(), owner.child.pid);
  owner.child.kill('SIGKILL');
  assert.deepEqual(await owner.closed, { code: null, signal: 'SIGKILL' });
  assert.equal(f.readLockOwner(), owner.child.pid);

  await f.down('--with-runtime');
  assert.deepEqual(await f.adapter.closed, { code: 0, signal: null });
  assert.deepEqual(await f.runtime.closed, { code: 0, signal: null });
  assert.equal(f.readLockOwner(), undefined);
  assert.deepEqual(await f.events(), ['adapter:term', 'adapter:drained', 'runtime:term', 'runtime:adapter-exited', 'runtime:stopped']);
});
