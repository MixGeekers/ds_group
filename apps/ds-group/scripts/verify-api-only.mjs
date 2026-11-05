#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { initializeCentralIdentity } from './central-init.mjs';
import { savePrivateJson } from './server-init.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(root, '.local', 'api-only', runId);
const reportPath = path.join(root, 'artifacts', 'api-only', `real-${runId}.json`);
const portBase = Number(process.env.DS_GROUP_API_ONLY_VERIFY_PORT_BASE || 24210);
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65527) {
  throw new Error('DS_GROUP_API_ONLY_VERIFY_PORT_BASE must be an integer from 1024 to 65527');
}
const corePort = portBase;
const clientPort = portBase + 1;
const matrixPort = portBase + 8;
const coreUrl = `http://127.0.0.1:${corePort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;
const matrixUrl = `http://127.0.0.1:${matrixPort}`;
const image = 'ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842';
const container = `dscord-api-only-${runId.toLowerCase()}`;
const dataRoot = path.join(directory, 'core'), synapseRoot = path.join(directory, 'matrix');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DS_GROUP_')));
const env = { ...cleanEnv, DS_GROUP_DATA_DIR: dataRoot, DS_GROUP_SYNAPSE_DIR: synapseRoot,
  DS_GROUP_SERVER_NAME: 'api-only-qa.test', DS_GROUP_MATRIX_URL: matrixUrl, DS_GROUP_MATRIX_PUBLIC_URL: matrixUrl,
  DS_GROUP_PUBLIC_URL: coreUrl, DS_GROUP_HOST: '127.0.0.1', DS_GROUP_PORT: String(corePort), DS_GROUP_WEB_DIR: path.join(root, 'dist/web') };
const password = randomBytes(24).toString('base64url');
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
  evidenceLevel: 'real CLI initialization + Core process + official Synapse + independent static origin Chromium; synthetic account; zero model',
  image, origins: { coreUrl, clientUrl, matrixUrl }, checks: [], modelCalls: 0, physicalCrossMachine: false,
  adminListener: 'owned by independent governance slice; not started or modified here' };
let child, browser, staticServer, containerStarted = false, session, roomId, eventId;
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const coreConfig = () => readFile(path.join(dataRoot, 'core-config.json'), 'utf8').then(JSON.parse);
async function check(name, work) {
  console.log(`Checking ${name}`);
  try { report.checks.push({ name, status: 'passed', details: await work() }); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
  finally { await save(); }
}
async function ready(url) {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {} await delay(300); }
  throw new Error(`Service did not become ready: ${url}`);
}
async function init(mode) {
  const result = await execute(process.execPath, ['bin/dscord.mjs', 'init', ...(mode ? ['--web-mode', mode] : [])], { cwd: root, env });
  return JSON.parse(result.stdout);
}
async function startCore() {
  const processToStart = spawn(process.execPath, ['bin/dscord.mjs', 'server'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child = processToStart;
  let output = ''; processToStart.stdout.on('data', part => { output += part; }); processToStart.stderr.on('data', part => { output += part; });
  processToStart.once('exit', () => writeFile(path.join(directory, `core-${processToStart.pid}.log`), output));
  await ready(coreUrl + '/readyz');
}
async function stopCore() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const processToStop = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { processToStop.kill('SIGKILL'); reject(new Error('CLI/Core failed graceful shutdown')); }, 12000);
    processToStop.once('exit', () => { clearTimeout(timer); resolve(); }); processToStop.kill('SIGTERM');
  });
}
async function api(route, options = {}) {
  const response = await fetch(coreUrl + route, { ...options, redirect: 'error', headers: {
    ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}), ...options.headers,
  } });
  assert.equal(response.status, 200, route); return response.json();
}
async function assertNoWeb() {
  for (const route of ['/', '/index.html', '/theme.js', '/manifest.webmanifest', '/sw.js', '/admin', ...report.builtAssets]) {
    const response = await fetch(coreUrl + route);
    assert.equal(response.status, 404, route); assert.equal((await response.json()).code, 'WEB_DISABLED');
  }
  assert.equal((await fetch(coreUrl + '/', { method: 'HEAD' })).status, 404);
}

await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(path.dirname(reportPath), { recursive: true });
try {
  for (const port of [corePort, clientPort, matrixPort]) {
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
  const index = await readFile(path.join(root, 'dist/web/index.html'));
  report.builtAssets = [...index.toString().matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]);
  assert.ok(report.builtAssets.length > 0);
  for (const file of ['src/core.mjs', 'src/web-mode.mjs', 'src/accounts.mjs', 'src/identity.mjs', 'scripts/server-init.mjs', 'bin/dscord.mjs', 'deploy/compose.yaml', 'scripts/verify-api-only.mjs', 'dist/web/index.html']) {
    (report.sourceSha256 ||= {})[file] = hash(await readFile(path.join(root, file)));
  }
  await check('normal CLI initialization persists api-only and central initialization preserves it', async () => {
    assert.equal((await init('api-only')).webMode, 'api-only');
    await initializeCentralIdentity({ dataRoot, coreUrl, matrixUrl, clientOrigins: [clientUrl] });
    assert.equal((await coreConfig()).webMode, 'api-only');
    return { mode: 'api-only', cli: 'dscord init --web-mode api-only', configurationPersisted: true };
  });
  await execute('docker', ['run', '--detach', '--name', container, '--label', `dscord.api-only=${runId}`,
    '--publish', `127.0.0.1:${matrixPort}:8008`, '--mount', `type=bind,source=${synapseRoot},target=/data`, '--env', 'UID=0', '--env', 'GID=0',
    image, 'run', '-m', 'synapse.app.homeserver', '--config-path=/data/homeserver.yaml'], { timeout: 30000 });
  containerStarted = true; await ready(matrixUrl + '/_matrix/client/versions'); await startCore();
  await check('api-only retains health/readiness/discovery and rejects actual bundled PWA assets', async () => {
    for (const route of ['/healthz', '/readyz', '/api/bootstrap', '/api/client-config', '/.well-known/dscord/client', '/.well-known/matrix/client']) {
      assert.equal((await fetch(coreUrl + route)).status, 200, route);
    }
    assert.equal((await (await fetch(coreUrl + '/api/bootstrap')).json()).web.mode, 'api-only');
    await assertNoWeb(); return { publicApiStatus: 200, rootAndAssetsStatus: 404, errorCode: 'WEB_DISABLED', existingBuildPresent: true };
  });
  staticServer = http.createServer(async (request, response) => {
    if (request.url === '/qa.html') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>API-only independent-origin verification</title>'); return; }
    const pathname = new URL(request.url, clientUrl).pathname;
    const file = path.resolve(root, 'dist/web', pathname === '/' ? 'index.html' : '.' + pathname);
    if (!file.startsWith(path.join(root, 'dist/web') + path.sep)) { response.writeHead(404); response.end(); return; }
    try { response.setHeader('Content-Type', path.extname(file) === '.html' ? 'text/html' : 'application/octet-stream'); response.end(await readFile(file)); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => staticServer.listen(clientPort, '127.0.0.1', resolve));
  assert.equal(hash(Buffer.from(await (await fetch(clientUrl)).arrayBuffer())), hash(index));
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.goto(clientUrl + '/qa.html');
  await check('independent static origin registers and logs in through the API-only Core', async () => {
    const details = await page.evaluate(async ({ coreUrl, password }) => {
      const json = async (route, body) => {
        const response = await fetch(coreUrl + route, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`Authentication returned ${response.status}`); return response.json();
      };
      await json('/api/register', { username: 'alice', displayName: 'API QA Alice', password });
      window.session = await json('/api/login', { user: 'alice', password });
      return { userId: window.session.user_id, subjectId: window.session.identity.subjectId };
    }, { coreUrl, password });
    session = await page.evaluate(() => window.session);
    assert.equal(details.userId, '@alice:api-only-qa.test'); return { ...details, staticIndexIsOriginalBuild: true };
  });
  await check('independent-origin business APIs send/read a message and upload/read an attachment', async () => {
    const matrix = new MatrixClient({ baseUrl: matrixUrl, accessToken: session.access_token });
    roomId = (await matrix.createRoom({ name: 'API-only QA', preset: 'private_chat' })).room_id;
    const result = await page.evaluate(async ({ coreUrl, roomId }) => {
      const request = async (route, options = {}) => fetch(coreUrl + route, { ...options, credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${window.session.access_token}`, ...options.headers } });
      const upload = await request('/api/attachments?filename=api-only.txt', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Upload-Id': 'api-only-upload' }, body: 'API-only attachment' });
      if (!upload.ok) throw new Error(`Upload returned ${upload.status}`);
      const attachment = (await upload.json()).attachment;
      const message = await request(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'API-only business message', transactionId: 'api-only-message', attachments: [attachment.id] }) });
      if (!message.ok) throw new Error(`Message returned ${message.status}`);
      const receipt = await message.json();
      const timeline = await (await request(`/api/rooms/${encodeURIComponent(roomId)}/messages`)).json();
      return { eventId: receipt.event_id, timelineContainsMessage: timeline.events.some(event => event.event_id === receipt.event_id), attachmentText: await (await request(`/api/attachments/${encodeURIComponent(attachment.id)}`)).text() };
    }, { coreUrl, roomId });
    assert.equal(result.timelineContainsMessage, true); assert.equal(result.attachmentText, 'API-only attachment'); eventId = result.eventId;
    return { messageSentAndRead: true, attachmentBytesVerified: true, eventId };
  });
  await check('argument-free reinitialization and actual Core/Synapse restart retain api-only, session and business history', async () => {
    await stopCore(); assert.equal((await init()).webMode, 'api-only');
    await execute('docker', ['restart', '--time', '15', container], { timeout: 30000 });
    await ready(matrixUrl + '/_matrix/client/versions'); await startCore(); await assertNoWeb();
    const me = await api('/api/me'); assert.equal(me.identity.subjectId, session.identity.subjectId);
    const timeline = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`); assert.ok(timeline.events.some(event => event.event_id === eventId));
    return { modePreserved: true, sameAccountSubject: true, sameHistory: true, rootStatus: 404 };
  });
  await check('explicit bundled rollback and old config without a mode both retain original single-server web hosting', async () => {
    await stopCore(); assert.equal((await init('bundled')).webMode, 'bundled'); await startCore();
    assert.equal(hash(Buffer.from(await (await fetch(coreUrl)).arrayBuffer())), hash(index));
    await stopCore(); const config = await coreConfig(); delete config.webMode; await savePrivateJson(path.join(dataRoot, 'core-config.json'), config);
    await startCore(); assert.equal((await fetch(coreUrl)).status, 200);
    assert.equal((await api('/api/status')).core.webMode, 'bundled');
    assert.equal((await api('/api/me')).identity.subjectId, session.identity.subjectId);
    return { explicitRollbackRootStatus: 200, missingFieldRootStatus: 200, sessionPreserved: true };
  });
  await check('Compose renders explicit api-only for init/runtime and empty selection preserves persisted state', async () => {
    const render = async mode => JSON.parse((await execute('docker', ['compose', '-f', 'deploy/compose.yaml', 'config', '--format', 'json'], { cwd: root, env: { ...cleanEnv, DS_GROUP_WEB_MODE: mode } })).stdout);
    const explicit = await render('api-only'); const omitted = await render('');
    for (const service of ['config', 'core']) { assert.equal(explicit.services[service].environment.DS_GROUP_WEB_MODE, 'api-only'); assert.equal(omitted.services[service].environment.DS_GROUP_WEB_MODE, ''); }
    return { explicitInitAndRuntime: 'api-only', omittedValue: '', evidenceScope: 'real Compose configuration renderer; full Compose deployment not run in this slice' };
  });
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  await browser?.close(); if (staticServer) await new Promise(resolve => staticServer.close(resolve));
  try { await stopCore(); } catch (error) { report.cleanupError = error.message; }
  if (containerStarted) {
    const logs = await execute('docker', ['logs', container], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: '', stderr: '' }));
    await writeFile(path.join(directory, 'synapse.log'), logs.stdout + logs.stderr); await execute('docker', ['rm', '--force', container]);
  }
  report.cleanup = { coreStopped: !child || child.exitCode !== null || child.signalCode !== null, staticServerStopped: true, containerRemoved: containerStarted };
  report.finishedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: report.status, checks: report.checks.length, reportPath }));
}
