#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const { values } = parseArgs({ options: {
  tarball: { type: 'string', default: `.local/npm-release/dscord-${sourceManifest.version}-alpha.1.tgz` },
  report: { type: 'string', default: 'artifacts/npm-release-smoke.json' },
} });
const tarball = path.resolve(packageRoot, values.tarball);
const reportPath = path.resolve(packageRoot, values.report);
const corePort = 21100;
const matrixPort = 21008;
const containerName = 'dscord-npm-smoke';
const image = 'ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842';
const coreUrl = `http://127.0.0.1:${corePort}`;
const matrixUrl = `http://127.0.0.1:${matrixPort}`;
const runId = `npm-smoke-${randomUUID()}`;
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
  platform: process.platform, arch: process.arch, node: process.version,
  scope: 'clean-npm-tarball-install-real-matrix-core-zero-model', checks: [], modelCalls: 0 };
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let workspace;
let core;
let coreExit;
let containerId;
let coreLog = '';

async function command(binary, args, options = {}) {
  try {
    return (await execute(binary, args, { cwd: workspace || packageRoot, timeout: 180000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout;
  } catch (error) {
    // Detailed diagnostics stay in the ignored run directory, outside the public report.
    if (workspace) await writeFile(path.join(workspace, 'command-error.log'), String(error.stderr || error.stdout || error.message), { mode: 0o600 });
    throw new Error(`${path.basename(binary)} ${args[0] || ''} failed (${error.code ?? error.signal ?? 'unknown'}); see private diagnostics`);
  }
}

async function freePort(port) {
  const server = createServer();
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

async function waitReady(url, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (core && (core.exitCode !== null || core.signalCode !== null)) throw new Error('Installed core exited before readiness');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (response.ok) return; } catch {}
    await delay(300);
  }
  throw new Error(`Readiness timed out for ${new URL(url).pathname}`);
}

async function snapshot(directory, base = directory) {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name);
    const relative = path.relative(base, filename);
    assert.ok(!['.local', '.dscord'].includes(entry.name), 'The installed package must not contain runtime data directories');
    assert.ok(!/\.(?:sqlite(?:-shm|-wal)?|db|log)$/.test(entry.name), 'The installed package must not contain chat databases or logs');
    if (entry.isDirectory()) Object.assign(result, await snapshot(filename, base));
    else { assert.ok(entry.isFile(), 'Runtime package files must be regular files'); result[relative] = hash(await readFile(filename)); }
  }
  return result;
}

async function jsonRequest(route, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(new URL(route, coreUrl), { method, signal: AbortSignal.timeout(15000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${method} ${route.split('?')[0]} returned ${response.status}`);
  return response.json();
}

async function check(name, work) {
  console.log(`Checking ${name}`);
  await work();
  report.checks.push(name);
  console.log(`Passed ${name}`);
}

try {
  await freePort(corePort);
  await freePort(matrixPort);
  const existing = (await command('docker', ['ps', '-a', '--filter', `name=^/${containerName}$`, '--format', '{{.ID}}'])).trim();
  assert.equal(existing, '', 'The smoke container name is already in use');
  await command('docker', ['image', 'inspect', image]);
  const smokeRoot = path.join(packageRoot, '.local', 'npm-smoke');
  await mkdir(smokeRoot, { recursive: true, mode: 0o700 });
  workspace = await mkdtemp(path.join(smokeRoot, 'run-'));
  const installRoot = path.join(workspace, 'install');
  await mkdir(installRoot);
  await writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'dscord-install-smoke', private: true, version: '1.0.0' }));
  report.tarball = { name: path.basename(tarball), sha256: hash(await readFile(tarball)), sha1: createHash('sha1').update(await readFile(tarball)).digest('hex') };
  report.scriptSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  await check('clean-production-install', async () => {
    await command('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], { cwd: installRoot });
    await command('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: installRoot });
  });
  const installed = await realpath(path.join(installRoot, 'node_modules', 'dscord'));
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dscord');
  report.version = manifest.version;
  const beforeFiles = await snapshot(installed);
  const cli = path.join(installRoot, 'node_modules', '.bin', 'dscord');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS_GROUP_') && key !== 'NODE_PATH' && key !== 'OPENCODE_API_KEY'));
  Object.assign(env, { DS_GROUP_DATA_DIR: './data', DS_GROUP_SYNAPSE_DIR: './synapse', DS_GROUP_SERVER_NAME: 'npm-smoke.local',
    DS_GROUP_MATRIX_URL: matrixUrl, DS_GROUP_MATRIX_PUBLIC_URL: matrixUrl, DS_GROUP_PUBLIC_URL: coreUrl,
    DS_GROUP_HOST: '127.0.0.1', DS_GROUP_PORT: String(corePort), DS_GROUP_DEMO_LOGIN: 'false' });
  await check('installed-cli-and-relative-data-paths', async () => {
    assert.match(await command(cli, ['--help'], { env }), /Usage: dscord/);
    assert.equal((await command(cli, ['--version'], { env })).trim(), manifest.version);
    assert.equal((await command(cli, ['path'], { env })).trim(), installed);
    await command(cli, ['init'], { env });
    const originalMetadata = await readFile(path.join(workspace, 'data', 'server.json'));
    await readFile(path.join(workspace, 'synapse', 'homeserver.yaml'));
    await command(cli, ['init'], { env });
    assert.deepEqual(await readFile(path.join(workspace, 'data', 'server.json')), originalMetadata);
  });
  await check('installed-runtime-import-closure', async () => {
    const probe = `import { createRequire } from 'node:module'; import { realpathSync } from 'node:fs'; import { pathToFileURL } from 'node:url';
      const root=process.argv[1]; const required=createRequire(root+'/package.json');
      for (const name of ${JSON.stringify(Object.keys(manifest.dependencies || {}))}) {
        if (!realpathSync(required.resolve(name)).startsWith(process.argv[2]+'/')) throw new Error('Dependency escaped the clean install: '+name);
      }
      for (const file of ['src/core.mjs','src/bot-node.mjs','src/file-formats.mjs','scripts/runtime-config.mjs','dsh-plugin/index.mjs','dsh-connect/index.mjs']) await import(pathToFileURL(root+'/'+file));`;
    await command(process.execPath, ['--input-type=module', '-e', probe, installed, installRoot], { cwd: installRoot, env });
  });
  const uid = process.getuid?.() || 1000;
  const gid = process.getuid?.() ? process.getgid() : 1000;
  containerId = (await command('docker', ['run', '--detach', '--rm', '--pull=never', '--name', containerName,
    '--label', `dscord.smoke=${runId}`, '--user', `${uid}:${gid}`, '--publish', `127.0.0.1:${matrixPort}:8008`,
    '--mount', `type=bind,source=${path.join(workspace, 'synapse')},target=/data`, image])).trim();
  report.synapse = { image, nonRootUid: uid, hostPort: matrixPort };
  await waitReady(`${matrixUrl}/_matrix/client/versions`);
  await check('real-synapse-bootstrap-and-idempotency', async () => {
    await command(cli, ['bootstrap'], { env });
    const registry = await readFile(path.join(workspace, 'data', 'matrix-setup.json'));
    await command(cli, ['bootstrap'], { env });
    assert.deepEqual(await readFile(path.join(workspace, 'data', 'matrix-setup.json')), registry);
  });
  const setup = JSON.parse(await readFile(path.join(workspace, 'data', 'matrix-setup.json'), 'utf8'));
  const people = Object.fromEntries(setup.participants.map(person => [person.localpart, person]));
  core = spawn(cli, ['server'], { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  coreExit = once(core, 'exit');
  core.stdout.on('data', value => { coreLog += value; });
  core.stderr.on('data', value => { coreLog += value; });
  await check('installed-core-health-and-prebuilt-pwa', async () => {
    await waitReady(`${coreUrl}/readyz`);
    assert.equal((await jsonRequest('/healthz')).status, 'ok');
    assert.equal((await jsonRequest('/readyz')).status, 'ready');
    const response = await fetch(coreUrl);
    assert.equal(response.status, 200);
    const html = await response.text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map(match => match[1]))];
    assert.ok(assets.some(asset => asset.startsWith('/assets/') && asset.endsWith('.js')));
    for (const asset of assets) assert.equal((await fetch(new URL(asset, coreUrl))).status, 200, `Prebuilt asset ${asset}`);
    const pwa = await jsonRequest('/manifest.webmanifest');
    assert.equal(pwa.display, 'standalone');
    for (const icon of pwa.icons) assert.equal((await fetch(new URL(icon.src, coreUrl))).status, 200);
    const serviceWorker = await fetch(`${coreUrl}/sw.js`);
    assert.equal(serviceWorker.status, 200);
    assert.match(await serviceWorker.text(), /addEventListener/);
    report.web = { assetCount: assets.length, manifest: true, serviceWorker: true };
  });
  await check('real-two-human-login-message-and-attachment-roundtrip', async () => {
    const alice = await jsonRequest('/api/login', { body: { user: people.alice.id, password: people.alice.password } });
    const bob = await jsonRequest('/api/login', { body: { user: people.bob.id, password: people.bob.password } });
    assert.equal(alice.user_id, people.alice.id);
    assert.equal(bob.user_id, people.bob.id);
    report.humanLoginAttempts = { alice: 1, bob: 1, retries: 0 };
    const content = Buffer.from(`Synthetic npm smoke attachment ${runId}\n`);
    const upload = await fetch(`${coreUrl}/api/attachments?filename=smoke.txt`, { method: 'POST',
      headers: { Authorization: `Bearer ${alice.access_token}`, 'Content-Type': 'text/plain', 'X-Upload-Id': runId }, body: content });
    assert.equal(upload.status, 200);
    const { attachment } = await upload.json();
    const route = `/api/rooms/${encodeURIComponent(setup.roomId)}/messages`;
    const input = { body: 'Synthetic npm attachment', attachments: [attachment.id], transactionId: `${runId}-alice` };
    const sent = await jsonRequest(route, { token: alice.access_token, body: input });
    assert.equal((await jsonRequest(route, { token: alice.access_token, body: input })).event_id, sent.event_id);
    const replied = await jsonRequest(route, { token: bob.access_token, body: { body: 'Synthetic npm reply', replyTo: sent.event_id, transactionId: `${runId}-bob` } });
    const { events } = await jsonRequest(route, { token: bob.access_token });
    const original = events.find(event => event.event_id === sent.event_id);
    const reply = events.find(event => event.event_id === replied.event_id);
    assert.equal(original.sender, people.alice.id);
    assert.equal(reply.sender, people.bob.id);
    assert.equal(reply.content['m.relates_to']['m.in_reply_to'].event_id, sent.event_id);
    assert.equal(original.content['org.ds_group'].attachments[0].sha256, hash(content));
    const download = await fetch(`${coreUrl}/api/attachments/${encodeURIComponent(attachment.id)}?download=1`, { headers: { Authorization: `Bearer ${bob.access_token}` } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
    report.matrix = { humanSenders: 2, messageRetrySameEvent: true, replyRelation: true, attachmentBytes: content.length, attachmentSha256: hash(content) };
  });
  await check('zero-model-and-immutable-install', async () => {
    const status = await jsonRequest('/api/status');
    assert.equal(status.budget.used, 0);
    assert.equal(status.nodes.length, setup.participants.filter(person => person.kind === 'bot').length);
    assert.ok(status.nodes.every(node => node.status === 'offline'), 'Bot profiles must remain offline throughout this zero-model smoke');
    report.botStatuses = status.nodes.map(({ id, status }) => ({ id, status }));
    assert.equal(status.core.loadedCoreSha256, beforeFiles['src/core.mjs']);
    assert.deepEqual(await snapshot(installed), beforeFiles);
    report.installation = { fileCount: Object.keys(beforeFiles).length, filesUnchanged: true, runtimeDataOutsidePackage: true };
    report.loadedCoreSha256 = status.core.loadedCoreSha256;
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  if (core) {
    try {
      if (core.exitCode === null && core.signalCode === null) {
        core.kill('SIGTERM');
        let timer;
        try {
          await Promise.race([coreExit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Core did not stop after SIGTERM')), 15000); })]);
        } catch (error) {
          process.kill(-core.pid, 'SIGKILL');
          await coreExit;
          throw error;
        } finally { clearTimeout(timer); }
      }
      await freePort(corePort);
      report.coreStopped = true;
    } catch (error) { cleanupErrors.push(error.message); }
    if (workspace) await writeFile(path.join(workspace, 'core.log'), coreLog, { mode: 0o600 });
  }
  if (containerId) {
    try {
      const owner = (await command('docker', ['inspect', containerId, '--format', '{{index .Config.Labels "dscord.smoke"}}'])).trim();
      assert.equal(owner, runId, 'Container ownership must match this smoke run');
      await command('docker', ['stop', '--time', '20', containerId]);
      await freePort(matrixPort);
      report.synapseStopped = true;
    } catch (error) { cleanupErrors.push(error.message); }
  }
  if (cleanupErrors.length) { report.status = 'failed'; report.cleanupErrors = cleanupErrors; process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: reportPath, ...(report.error ? { error: report.error } : {}) }));
}
