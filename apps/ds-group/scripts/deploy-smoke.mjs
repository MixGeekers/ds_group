#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';
import { importNodeBundle } from './server-admin.mjs';

const execute = promisify(execFile);
const name = `ds-group-smoke-${randomBytes(5).toString('hex')}`;
const reportPath = path.resolve(process.env.DS_GROUP_SMOKE_REPORT || path.join(packageRoot, '.local', 'deploy-smoke.json'));
const composeFiles = ['-f', path.join(packageRoot, 'deploy', 'compose.yaml')];
const portBase = process.env.DS_GROUP_SMOKE_PORT_BASE === undefined ? 0 : Number(process.env.DS_GROUP_SMOKE_PORT_BASE);
if (!Number.isInteger(portBase) || portBase < 0 || portBase > 65525 || (portBase > 0 && portBase < 1024)) throw new Error('Invalid DS_GROUP_SMOKE_PORT_BASE');
const env = { ...process.env, DS_GROUP_IMAGE: process.env.DS_GROUP_IMAGE || 'ds-group:ci',
  DS_GROUP_MEDIA_BACKEND: 'local', DS_GROUP_WEB_MODE: 'bundled', DS_GROUP_BOOTSTRAP_DEMO: 'true',
  DS_GROUP_HTTP_PORT: String(portBase), DS_GROUP_MATRIX_PORT: String(portBase ? portBase + 8 : 0),
  DS_GROUP_ADMIN_PORT: String(portBase ? portBase + 10 : 0), DS_GROUP_BIND: '127.0.0.1', DS_GROUP_SERVER_NAME: `${name}.local`,
  DS_GROUP_PUBLIC_URL: 'http://localhost:18100', DS_GROUP_MATRIX_PUBLIC_URL: 'http://localhost:18008' };
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), project: name,
  platform: process.env.DS_GROUP_PLATFORM || process.platform + '/' + process.arch,
  runner: { platform: process.platform, architecture: process.arch },
  scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  level: 'real-container-matrix-http', image: env.DS_GROUP_IMAGE, modelCalls: 0, checks: [] };

async function compose(args) {
  try {
    const { stdout } = await execute('docker', ['compose', '--project-name', name, ...composeFiles, ...args], {
      cwd: packageRoot, env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    // Command output only contains container lifecycle diagnostics, never account output.
    throw new Error(`Compose ${args[0]} failed: ${error.stderr || error.message}`);
  }
}

async function endpoint() {
  const binding = (await compose(['port', 'core', '18100'])).split('\n')[0];
  return `http://${binding}`;
}

async function request(baseUrl, route, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, `${route} returned HTTP ${response.status}`);
  return response.json();
}

async function snapshot() {
  const code = "const fs=require('node:fs'),c=require('node:crypto');let s={};for(const f of ['matrix-setup.json','core-config.json'])s[f]=c.createHash('sha256').update(fs.readFileSync('/data/'+f)).digest('hex');console.log(JSON.stringify(s));";
  return JSON.parse(await compose(['exec', '-T', 'core', 'node', '-e', code]));
}

async function archiveVolume(directory) {
  const { stdout } = await execute('docker', ['compose', '--project-name', name, ...composeFiles,
    'run', '--rm', '--no-deps', '-T', '--user', '0:0', 'config', 'tar', '-czf', '-', '-C', directory, '.'], {
    cwd: packageRoot, env, encoding: 'buffer', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function restoreVolume(directory, archive) {
  const child = spawn('docker', ['compose', '--project-name', name, ...composeFiles,
    'run', '--rm', '--no-deps', '-T', '--user', '0:0', 'config', 'tar', '-xzf', '-', '-C', directory], {
    cwd: packageRoot, env, stdio: ['pipe', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Volume restore failed: ${diagnostics}`)));
    child.stdin.on('error', reject);
  });
  child.stdin.end(archive);
  await completed;
}

async function checkRemoteAdapter(bundle, coreUrl, token) {
  const directory = await mkdtemp(path.join(path.dirname(reportPath), `${name}-node-`));
  let registrations = 0;
  let statusReads = 0;
  let kernelReads = 0;
  let attentionReads = 0;
  const observedEvents = new Set();
  const unexpectedRequests = [];
  const bridge = http.createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (incoming.url === '/api/ds-group-node/bots' && incoming.method === 'POST') {
      registrations++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ready' }));
    } else if (incoming.url === '/api/ds-group-node/status' && incoming.method === 'GET') {
      statusReads++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ready', model: null }));
    } else if (incoming.url === '/api/ds-group-node/kernel/state' && incoming.method === 'POST') {
      kernelReads++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ runtime: { id: 'dscord-kernel', version: '0.4.0', upstreamVersion: '0.3.1', apiVersion: 1, available: true },
        work: { status: 'idle', activeTasks: 0, tasks: [] } }));
    } else if (incoming.url === '/api/ds-group-node/observe' && incoming.method === 'POST') {
      for (const event of input.events || []) observedEvents.add(event.event_id);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ observed: input.events?.length || 0 }));
    } else if (incoming.url === '/api/ds-group-node/attention/view' && incoming.method === 'POST') {
      attentionReads++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ available: false, runtime: { status: 'idle' }, memory: { available: false } }));
    } else {
      unexpectedRequests.push(`${incoming.method} ${incoming.url}`);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Generation is forbidden in deployment smoke' }));
    }
  });
  let child;
  let childExit;
  let diagnostics = '';
  try {
    await importNodeBundle(bundle, directory);
    await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
    const matrixUrl = `http://${(await compose(['port', 'synapse', '8008'])).split('\n')[0]}`;
    const endpoint = `http://127.0.0.1:${bridge.address().port}`;
    child = spawn(process.execPath, [path.join(packageRoot, 'src', 'bot-node.mjs'), '--bot', 'finance', '--endpoint', endpoint], {
      cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        DS_GROUP_DATA_DIR: directory, DS_GROUP_CORE_URL: coreUrl, DS_GROUP_MATRIX_URL: matrixUrl,
        DS_GROUP_MATRIX_SETUP_PATH: path.join(directory, 'matrix-setup.json'), DS_GROUP_CORE_CONFIG_PATH: path.join(directory, 'core-config.json') },
    });
    child.stdout.on('data', chunk => { diagnostics += chunk.toString(); });
    child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    childExit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const sent = await request(coreUrl, `/api/rooms/${encodeURIComponent(bundle.setup.roomId)}/messages`, { token,
      body: { body: 'Deployment adapter sync check', to: [], transactionId: `${name}-adapter-sync` } });
    const deadline = Date.now() + 20_000;
    let synchronized = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Adapter exited: ${diagnostics}`);
      const status = await request(coreUrl, '/api/status');
      const connected = status.nodes.find(node => node.botId === bundle.setup.participants.find(person => person.localpart === 'finance').id);
      let observed = false;
      try {
        const database = new DatabaseSync(path.join(directory, 'nodes', 'finance', 'node.sqlite'), { readOnly: true });
        try { observed = Boolean(database.prepare('SELECT event_id FROM messages WHERE event_id=?').get(sent.event_id)); }
        finally { database.close(); }
      } catch (error) { if (error.code !== 'ERR_SQLITE_ERROR') throw error; }
      if (connected?.status === 'idle' && !connected.lastError && observed && observedEvents.has(sent.event_id)) { synchronized = true; break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(synchronized, `Remote adapter did not sync a real Matrix event: ${diagnostics}`);
    assert.equal(registrations, 1);
    assert.ok(statusReads > 0, 'Adapter must read runtime status without generating a reply');
    assert.ok(kernelReads > 0, 'Adapter must publish its kernel read view');
    assert.ok(observedEvents.has(sent.event_id), 'The real Matrix event must reach the background observation bridge');
    assert.deepEqual(unexpectedRequests, [], 'Deployment smoke permits registration, observation and read-only bridge operations');
    report.adapter = { core: 'real-container', matrix: 'real-container', adapter: 'real-host-process',
      inferenceBridge: 'registration-observation-and-read-only-fixture', statusReads, kernelReads, attentionReads,
      observedEventCount: observedEvents.size, sentEventObserved: true, generationCalls: 0 };
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      let timer;
      try {
        await Promise.race([childExit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Adapter did not stop within 20 seconds')), 20_000); })]);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) { child.kill('SIGKILL'); await childExit; }
      }
    }
    await new Promise(resolve => bridge.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

await mkdir(path.dirname(reportPath), { recursive: true });
if (process.env.DS_GROUP_PLATFORM) {
  const override = path.join(path.dirname(reportPath), `${name}.compose.json`);
  await writeFile(override, JSON.stringify({ services: Object.fromEntries(['config', 'synapse', 'bootstrap', 'core', 'administration'].map(service => [service, { platform: process.env.DS_GROUP_PLATFORM }])) }));
  composeFiles.push('-f', override);
}

try {
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '180']);
  report.containerRuntime = JSON.parse(await compose(['exec', '-T', 'core', 'node', '-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version}))']));
  if (process.env.DS_GROUP_PLATFORM) assert.equal(`${report.containerRuntime.platform}/${report.containerRuntime.arch === 'x64' ? 'amd64' : report.containerRuntime.arch}`, process.env.DS_GROUP_PLATFORM);
  let url = await endpoint();
  const initial = await request(url, '/api/bootstrap');
  assert.equal(initial.participants.length, 4);
  await request(url, '/readyz');
  report.checks.push('freshVolumesReady');
  const demo = await fetch(`${url}/api/demo-login?user=alice`);
  assert.equal(demo.status, 404);
  report.checks.push('serverRequiresLogin');
  const credentials = JSON.parse(await compose(['exec', '-T', 'core', 'node', 'scripts/server-admin.mjs', 'credentials', 'alice']));
  const login = await request(url, '/api/login', { body: credentials });
  assert.equal(login.user_id, initial.participants.find(person => person.localpart === 'alice').id);
  const token = login.access_token;
  const group = await request(url, '/api/rooms', { token, body: { name: 'Deployment smoke', inviteIds: [], requestId: `${name}-group` } });
  const message = `Persisted deployment message ${name}`;
  const sent = await request(url, `/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token,
    body: { body: message, to: [], transactionId: `${name}-message` } });
  const history = await request(url, `/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token });
  assert.ok(history.events.some(event => event.event_id === sent.event_id && event.content.body === message));
  report.checks.push('matrixLoginGroupAndMessage');
  const manifest = await fetch(`${url}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).display, 'standalone');
  report.checks.push('pwaManifest');
  const notificationConfig = await request(url, '/api/push/config');
  const before = await snapshot();
  const exported = JSON.parse(await compose(['exec', '-T', 'core', 'node', 'scripts/server-admin.mjs', 'export-node', 'finance']));
  assert.equal(exported.setup.participants.filter(person => person.accessToken).length, 1);
  assert.equal(exported.setup.participants.find(person => person.accessToken).localpart, 'finance');
  assert.ok(!JSON.stringify(exported).includes('password'));
  report.checks.push('remoteNodeExport');
  await checkRemoteAdapter(exported, url, token);
  report.checks.push('exportedNodeImportsConnectsAndSyncs');
  await compose(['down', '--timeout', '45']);
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '180']);
  url = await endpoint();
  const restored = await request(url, '/api/bootstrap');
  assert.equal(restored.roomId, initial.roomId);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await request(url, '/api/push/config'), notificationConfig);
  const restoredHistory = await request(url, `/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token });
  assert.ok(restoredHistory.events.some(event => event.event_id === sent.event_id && event.content.body === message));
  report.checks.push('recreatePreservesUsersRoomTokensSecretsVapidAndHistory');
  const sameGroup = await request(url, '/api/rooms', { token, body: { name: 'Deployment smoke', inviteIds: [], requestId: `${name}-group` } });
  assert.equal(sameGroup.roomId, group.roomId);
  const duplicate = await request(url, `/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token,
    body: { body: message, to: [], transactionId: `${name}-message` } });
  assert.equal(duplicate.event_id, sent.event_id);
  report.checks.push('retryAfterRecreateDeduplicates');
  await compose(['stop', '--timeout', '45', 'core', 'administration', 'synapse']);
  const coreArchive = await archiveVolume('/data');
  const matrixArchive = await archiveVolume('/synapse');
  const governanceArchive = await archiveVolume('/dscord-policy');
  // Only this randomly named smoke project owns these temporary volumes.
  await compose(['down', '--volumes', '--timeout', '45']);
  await restoreVolume('/data', coreArchive);
  await restoreVolume('/synapse', matrixArchive);
  await restoreVolume('/dscord-policy', governanceArchive);
  await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '180']);
  url = await endpoint();
  assert.deepEqual(await snapshot(), before);
  const recovered = await request(url, `/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token });
  assert.ok(recovered.events.some(event => event.event_id === sent.event_id && event.content.body === message));
  assert.deepEqual(await request(url, '/api/push/config'), notificationConfig);
  report.checks.push('backupRestoreToFreshVolumes');
  const status = await request(url, '/api/status');
  assert.equal(status.budget.used, 0);
  report.loadedCoreSha256 = status.core.loadedCoreSha256;
  report.checks.push('zeroModelCalls');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
  const diagnostics = await compose(['logs', '--no-color', '--tail', '80']).catch(() => 'Container logs unavailable');
  await writeFile(path.join(path.dirname(reportPath), `${name}.log`), diagnostics);
} finally {
  try { await compose(['down', '--volumes', '--remove-orphans', '--timeout', '45']); report.cleanedUp = true; }
  catch (error) { report.cleanedUp = false; report.cleanupError = error.message; process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: reportPath, cleanedUp: report.cleanedUp }));
}
