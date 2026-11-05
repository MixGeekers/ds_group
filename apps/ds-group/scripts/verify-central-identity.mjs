#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { initializeServer, savePrivateJson } from './server-init.mjs';
import { initializeCentralIdentity } from './central-init.mjs';
import { MatrixClient } from '../src/matrix-client.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const directory = path.join(root, '.local', 'central-identity', runId);
const reportPath = path.join(root, 'artifacts', 'central-identity', `real-${runId}.json`);
const image = 'ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842';
const containerName = `dscord-central-identity-${runId.toLowerCase()}`;
const portBase = Number(process.env.DS_GROUP_IDENTITY_VERIFY_PORT_BASE ?? 24200);
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65527) {
  throw new Error('DS_GROUP_IDENTITY_VERIFY_PORT_BASE must be an integer from 1024 to 65527');
}
const ports = { core: portBase, client: portBase + 1, remote: portBase + 2, matrix: portBase + 8 };
const coreUrl = `http://127.0.0.1:${ports.core}`;
const clientUrl = `http://127.0.0.1:${ports.client}`;
const remoteUrl = `http://127.0.0.1:${ports.remote}`;
const matrixUrl = `http://127.0.0.1:${ports.matrix}`;
const dataRoot = path.join(directory, 'core');
const synapseRoot = path.join(directory, 'matrix');
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: 'running',
  evidenceLevel: 'real-local-Synapse-Core-and-independent-origin-Chromium; synthetic accounts; zero model',
  image, origins: { coreUrl, clientUrl, remoteUrl, matrixUrl }, checks: [], modelCalls: 0, physicalCrossMachine: false, federatedRoom: 'owned by parallel federation slice' };
const privateState = { password: randomBytes(24).toString('base64url'), legacyPassword: randomBytes(24).toString('base64url'), adminPassword: randomBytes(24).toString('base64url') };
let child, browser, startedContainer = false;
const httpServers = [];
const observedRemote = [];
async function save() {
  let output = JSON.stringify(report, null, 2) + '\n';
  const redact = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/password|token|secret/i.test(key) && typeof item === 'string' && item) output = output.replaceAll(item, '[REDACTED]');
      else if (typeof item === 'object') redact(item);
    }
  };
  redact(privateState);
  await writeFile(reportPath, output);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, work) {
  process.stdout.write(`Checking ${name}\n`);
  try { report.checks.push({ name, status: 'passed', details: await work() }); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
  finally { await save(); }
}
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(300);
  }
  throw new Error(`Service did not become ready: ${url}`);
}
async function startCore() {
  child = spawn(process.execPath, ['src/core.mjs'], { cwd: root, env: { ...process.env,
    DS_GROUP_DATA_DIR: dataRoot, DS_GROUP_MATRIX_URL: matrixUrl, DS_GROUP_PORT: String(ports.core), DS_GROUP_HOST: '127.0.0.1', DS_GROUP_DEMO_LOGIN: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { output += part; });
  child.once('exit', () => writeFile(path.join(directory, `core-${child.pid}.log`), output));
  await ready(coreUrl + '/readyz');
}
async function stopCore() {
  if (!child || child.exitCode !== null) return;
  const processToStop = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { processToStop.kill('SIGKILL'); reject(new Error('Core did not shut down gracefully')); }, 12000);
    processToStop.once('exit', () => { clearTimeout(timer); resolve(); });
    processToStop.kill('SIGTERM');
  });
}
async function api(route, { token, body, method = body === undefined ? 'GET' : 'POST', status = 200 } = {}) {
  const res = await fetch(coreUrl + route, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(res.status, status, `${method} ${route}: expected ${status}, received ${res.status}`);
  return res.json();
}
async function registerRaw(localpart, password, admin = false) {
  const metadata = JSON.parse(await readFile(path.join(dataRoot, 'server.json'), 'utf8'));
  const client = new MatrixClient({ baseUrl: matrixUrl });
  const { nonce } = await client.request('GET', '/_synapse/admin/v1/register');
  const mac = createHmac('sha1', metadata.registrationSecret).update([nonce, localpart, password, admin ? 'admin' : 'notadmin'].join('\0')).digest('hex');
  return client.request('POST', '/_synapse/admin/v1/register', { nonce, username: localpart, password, admin, mac });
}
function updateAccount(work) {
  const db = new DatabaseSync(path.join(dataRoot, 'accounts.sqlite'));
  try { return work(db); } finally { db.close(); }
}
async function freePorts() {
  for (const port of Object.values(ports)) {
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
}

await mkdir(directory, { recursive: true, mode: 0o700 });
await mkdir(path.dirname(reportPath), { recursive: true });
try {
  await freePorts();
  for (const source of ['src/accounts.mjs', 'src/identity.mjs', 'tests/helpers/home-session.mjs', 'src/core.mjs', 'src/matrix-client.mjs', 'scripts/central-init.mjs', 'scripts/verify-central-identity.mjs']) {
    (report.sourceSha256 ||= {})[source] = createHash('sha256').update(await readFile(path.join(root, source))).digest('hex');
  }
  await check('initialize empty default home twice without synthetic demo credentials', async () => {
    await initializeServer({ dataRoot, synapseRoot, serverName: 'central-qa.test', homeserverUrl: matrixUrl, publicUrl: coreUrl, publicHomeserverUrl: matrixUrl }, { containerOwnership: false });
    const config = { dataRoot, coreUrl, matrixUrl, clientOrigins: [clientUrl] };
    const first = await initializeCentralIdentity(config);
    const second = await initializeCentralIdentity(config);
    assert.equal(first.authorityId, second.authorityId);
    assert.equal(second.registeredAccounts, 0);
    report.authorityId = first.authorityId;
    return { accounts: 0, mode: first.mode, repeatedInitialization: true };
  });
  await execute('docker', ['run', '--detach', '--name', containerName, '--label', `dscord.central-identity=${runId}`,
    '--publish', `127.0.0.1:${ports.matrix}:8008`, '--mount', `type=bind,source=${synapseRoot},target=/data`,
    '--env', 'UID=0', '--env', 'GID=0', image, 'run', '-m', 'synapse.app.homeserver', '--config-path=/data/homeserver.yaml'], { timeout: 30000 });
  startedContainer = true;
  await ready(matrixUrl + '/_matrix/client/versions');
  await startCore();
  const remote = http.createServer((req, res) => {
    observedRemote.push({ method: req.method, path: req.url, authorization: Boolean(req.headers.authorization), cookie: Boolean(req.headers.cookie) });
    req.resume(); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: 'Untrusted collaboration server', home: { coreUrl: remoteUrl, matrixUrl: remoteUrl } }));
  });
  await new Promise(resolve => remote.listen(ports.remote, '127.0.0.1', resolve)); httpServers.push(remote);
  const fixtureModule = await readFile(path.join(root, 'tests/helpers/home-session.mjs'));
  const clientServer = http.createServer((req, res) => {
    if (req.url === '/home-session.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(fixtureModule); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>DSCord identity origin verification</title>');
  });
  await new Promise(resolve => clientServer.listen(ports.client, '127.0.0.1', resolve)); httpServers.push(clientServer);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); await page.goto(clientUrl);
  await check('real Chromium on independent origin discovers, registers and signs in through normal APIs', async () => {
    const details = await page.evaluate(async ({ coreUrl, password }) => {
      const sdk = await import('/home-session.mjs');
      const discovery = await sdk.discoverHome(coreUrl);
      window.home = new sdk.HomeSession(discovery, coreUrl);
      const first = await window.home.register({ username: 'alice', password, displayName: 'QA Alice' });
      window.firstSession = first;
      const second = await window.home.login({ user: 'alice', password });
      localStorage.setItem('home-session', JSON.stringify(window.home.export()));
      return { userId: second.user_id, subjectId: second.identity.subjectId, firstDevice: first.device_id, secondDevice: second.device_id, home: second.home, me: await window.home.me() };
    }, { coreUrl, password: privateState.password });
    assert.equal(details.userId, '@alice:central-qa.test');
    assert.notEqual(details.firstDevice, details.secondDevice);
    privateState.alice = await page.evaluate(() => window.home.export());
    privateState.first = await page.evaluate(() => window.firstSession);
    return { userId: details.userId, subjectId: details.subjectId, distinctClientDevices: true, stableOwner: details.me.identity.subjectId === details.subjectId };
  });
  await check('untrusted remote discovery receives no credentials and cannot replace the pinned home', async () => {
    const value = await page.evaluate(async ({ remoteUrl, coreUrl }) => {
      const data = await (await fetch(remoteUrl + '/api/bootstrap', { credentials: 'omit', redirect: 'error' })).json();
      let denied = 0;
      for (const url of [remoteUrl + '/api/me', `//${new URL(remoteUrl).host}/api/me`, '/api/../_synapse/admin/v1/users']) {
        try { await window.home.request(url); } catch (e) { if (e.code === 'CREDENTIAL_TARGET_DENIED') denied++; }
      }
      const me = await window.home.me();
      return { denied, homeUnchanged: window.home.home.coreUrl === coreUrl, userId: me.user.id, discovered: data.name };
    }, { remoteUrl, coreUrl });
    assert.equal(value.denied, 3); assert.equal(value.homeUnchanged, true);
    assert.equal(observedRemote.length, 1); assert.equal(observedRemote[0].authorization, false); assert.equal(observedRemote[0].cookie, false);
    return { ...value, observedRemote: [...observedRemote] };
  });
  await check('real independent-origin attachment upload, idempotent retry, byte readback and Range', async () => {
    const details = await page.evaluate(async () => {
      const bytes = new TextEncoder().encode('DSCord independent origin attachment 中文');
      const upload = async () => {
        const response = await window.home.request('/api/attachments?filename=origin-check.txt', { method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'X-Upload-Id': 'origin-check-stable' }, body: bytes });
        if (!response.ok) throw new Error(`Upload returned ${response.status}`);
        return (await response.json()).attachment;
      };
      const first = await upload(); const second = await upload();
      const full = await window.home.request(`/api/attachments/${encodeURIComponent(first.id)}?download=1`);
      const fullBytes = new Uint8Array(await full.arrayBuffer());
      const partial = await window.home.request(`/api/attachments/${encodeURIComponent(first.id)}`, { headers: { Range: 'bytes=0-5' } });
      const partialBytes = new Uint8Array(await partial.arrayBuffer());
      return { sameAttachment: first.id === second.id, size: first.size, sameBytes: bytes.every((value, index) => value === fullBytes[index]) && bytes.length === fullBytes.length,
        disposition: full.headers.get('Content-Disposition'), rangeStatus: partial.status, range: partial.headers.get('Content-Range'), partial: [...partialBytes] };
    });
    assert.equal(details.sameAttachment, true); assert.equal(details.sameBytes, true); assert.equal(details.rangeStatus, 206);
    assert.ok(details.disposition?.includes('origin-check.txt')); assert.ok(details.range?.startsWith('bytes 0-5/'));
    return details;
  });
  await check('wrong browser Origin fails real CORS preflight and receives no central session', async () => {
    const evil = await browser.newPage(); await evil.goto(remoteUrl);
    const blocked = await evil.evaluate(async ({ coreUrl, password }) => {
      try { await fetch(coreUrl + '/api/login', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'alice', password }) }); return false; }
      catch { return true; }
    }, { coreUrl, password: privateState.password });
    await evil.close(); assert.equal(blocked, true);
    return { browserBlocked: true };
  });
  await check('verified legacy account import, Bot ownership and node credentials remain separate', async () => {
    privateState.admin = await registerRaw('qa-operator', privateState.adminPassword, true);
    privateState.legacy = await registerRaw('legacy', privateState.legacyPassword);
    await api('/api/login', { body: { user: 'legacy', password: 'wrong-password' }, status: 403 });
    privateState.legacy = await api('/api/login', { body: { user: 'legacy', password: privateState.legacyPassword } });
    const token = privateState.alice.access_token;
    const bot = (await api('/api/bots', { token, body: { name: 'QA Alice', requestId: 'stable-bot' }, status: 201 })).bot;
    const again = (await api('/api/bots', { token, body: { name: 'QA Alice', requestId: 'stable-bot' }, status: 201 })).bot;
    assert.equal(again.id, bot.id); assert.equal(bot.ownerId, privateState.alice.user_id);
    const bundle = (await api(`/api/bots/${encodeURIComponent(bot.id)}/connect`, { token, body: {} })).bundle;
    assert.ok(bundle.coreConfig.nodeSecret !== token, 'A node credential must differ from a client token');
    assert.equal(bundle.setup.participants.find(person => person.id === bot.id).ownerId, privateState.alice.user_id);
    await api('/internal/nodes/heartbeat', { token, body: {}, status: 401 });
    const directAdmin = await fetch(matrixUrl + '/_synapse/admin/v2/users', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(directAdmin.status, 403);
    privateState.bot = bot; privateState.nodeSecret = bundle.coreConfig.nodeSecret;
    return { legacyId: privateState.legacy.user_id, legacySubject: privateState.legacy.identity.subjectId, botId: bot.id, ownerId: bot.ownerId, duplicateRequestSameBot: true, ordinaryTokenNodeStatus: 401, ordinaryTokenSynapseAdminStatus: 403 };
  });
  await check('browser refresh and Core/Synapse restart preserve subjects, sessions, Bot owners and node credentials', async () => {
    const admin = new MatrixClient({ baseUrl: matrixUrl, accessToken: privateState.admin.access_token });
    await admin.request('PUT', `/_synapse/admin/v2/users/${encodeURIComponent(privateState.alice.user_id)}`, { displayname: 'Renamed QA Alice' });
    updateAccount(db => db.prepare('UPDATE accounts SET name=? WHERE user_id=?').run('Renamed QA Alice', privateState.alice.user_id));
    await stopCore();
    await execute('docker', ['restart', '--time', '15', containerName], { timeout: 30000 });
    await ready(matrixUrl + '/_matrix/client/versions'); await startCore();
    await page.reload();
    const me = await page.evaluate(async coreUrl => {
      const { discoverHome, HomeSession } = await import('/home-session.mjs');
      window.home = new HomeSession(await discoverHome(coreUrl), coreUrl);
      window.home.restore(JSON.parse(localStorage.getItem('home-session')));
      return window.home.me();
    }, coreUrl);
    assert.equal(me.identity.subjectId, privateState.alice.identity.subjectId);
    assert.equal(me.user.name, 'Renamed QA Alice');
    assert.equal(me.ownedBots[0].id, privateState.bot.id); assert.equal(me.ownedBots[0].ownerId, privateState.alice.user_id);
    const again = (await api(`/api/bots/${encodeURIComponent(privateState.bot.id)}/connect`, { token: privateState.alice.access_token, body: {} })).bundle;
    assert.ok(again.coreConfig.nodeSecret === privateState.nodeSecret, 'The node credential must remain stable across restart');
    return { sameSubject: true, sameMatrixId: true, renamedDisplayOnly: true, sameBotAndOwner: true, sameNodeCredential: true, restoredClientSession: true };
  });
  await check('local disable blocks all protected API families and survives another Core restart', async () => {
    updateAccount(db => db.prepare("UPDATE accounts SET status='disabled' WHERE user_id=?").run(privateState.alice.user_id));
    const routes = ['/api/me', '/api/attachments/unknown/metadata', '/api/rooms/unknown/messages', '/api/spaces', '/api/bots', '/api/tasks/unknown', '/api/push/subscriptions'];
    for (const route of routes) await api(route, { token: privateState.alice.access_token, status: 403 });
    await api('/api/login', { body: { user: 'alice', password: privateState.password }, status: 403 });
    await api('/api/register', { body: { username: 'alice', password: privateState.password, displayName: 'QA Alice' }, status: 403 });
    await stopCore(); await startCore();
    await api('/api/me', { token: privateState.alice.access_token, status: 403 });
    updateAccount(db => db.prepare("UPDATE accounts SET status='active' WHERE user_id=?").run(privateState.alice.user_id));
    await stopCore(); await startCore();
    return { blockedRoutes: routes, loginRejected: true, persistedAcrossRestart: true, localDisableDoesNotClaimDirectMatrixRevocation: true };
  });
  await check('logout is idempotent, revokes one actual device and preserves the other device and service credential', async () => {
    await api('/api/logout', { token: privateState.first.access_token, body: {} });
    await api('/api/logout', { token: privateState.first.access_token, body: {} });
    await api('/api/me', { token: privateState.first.access_token, status: 401 });
    await api('/api/me', { token: privateState.alice.access_token });
    const token = updateAccount(db => db.prepare('SELECT service_token FROM accounts WHERE user_id=?').get(privateState.alice.user_id).service_token);
    assert.equal((await new MatrixClient({ baseUrl: matrixUrl, accessToken: token }).whoami()).user_id, privateState.alice.user_id);
    return { revokedClientStatus: 401, otherDeviceStatus: 200, coreServiceValid: true, repeatedLogoutSucceeded: true };
  });
  await check('actual Synapse deactivation rejects the existing account token and future password login', async () => {
    const admin = new MatrixClient({ baseUrl: matrixUrl, accessToken: privateState.admin.access_token });
    await admin.request('POST', `/_synapse/admin/v1/deactivate/${encodeURIComponent(privateState.legacy.user_id)}`, { erase: false });
    await api('/api/me', { token: privateState.legacy.access_token, status: 401 });
    const response = await fetch(coreUrl + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'legacy', password: privateState.legacyPassword }) });
    assert.equal(response.status, 403);
    return { revokedTokenStatus: 401, loginStatus: response.status, matrixHistoryErased: false };
  });
  await check('homeserver operator recovery retains the original subject and Bot owner while rotating client and service sessions', async () => {
    const admin = new MatrixClient({ baseUrl: matrixUrl, accessToken: privateState.admin.access_token });
    const previous = privateState.alice;
    const previousService = updateAccount(db => db.prepare('SELECT service_token FROM accounts WHERE user_id=?').get(previous.user_id).service_token);
    privateState.password = randomBytes(24).toString('base64url');
    await admin.request('POST', `/_synapse/admin/v1/reset_password/${encodeURIComponent(previous.user_id)}`, { new_password: privateState.password, logout_devices: true });
    await api('/api/me', { token: previous.access_token, status: 401 });
    privateState.alice = await api('/api/login', { body: { user: 'alice', password: privateState.password } });
    assert.equal(privateState.alice.identity.subjectId, previous.identity.subjectId);
    const currentService = updateAccount(db => db.prepare('SELECT service_token FROM accounts WHERE user_id=?').get(previous.user_id).service_token);
    assert.ok(currentService !== previousService, 'The Core service session must rotate after homeserver recovery');
    const me = await api('/api/me', { token: privateState.alice.access_token });
    assert.equal(me.ownedBots[0].id, privateState.bot.id);
    return { oldClientStatus: 401, sameSubjectAndMatrixId: true, newServiceSession: true, botOwnershipPreserved: true, recoveryAuthority: 'dedicated Synapse operator; ordinary central login has no recovery admin grant' };
  });
  await check('actual short-lived Matrix token expiry reaches Core as 401 and helper refuses an expired restored session', async () => {
    await stopCore();
    const filename = path.join(synapseRoot, 'homeserver.yaml');
    const config = JSON.parse(await readFile(filename, 'utf8'));
    config.nonrefreshable_access_token_lifetime = '2s'; await savePrivateJson(filename, config);
    await execute('docker', ['restart', '--time', '15', containerName], { timeout: 30000 });
    await ready(matrixUrl + '/_matrix/client/versions'); await startCore();
    const short = await api('/api/login', { body: { user: 'alice', password: privateState.password } });
    assert.ok(short.expires_in_ms > 0 && short.expires_in_ms <= 2000);
    await api('/api/me', { token: short.access_token }); await delay(2300);
    await api('/api/me', { token: short.access_token, status: 401 });
    const rejected = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('home-session')); saved.expiresAt = Date.now() - 1000;
      try { window.home.restore(saved); return false; } catch (error) { return error.code === 'SESSION_EXPIRED'; }
    });
    assert.equal(rejected, true);
    return { expiryMs: short.expires_in_ms, expiredCoreStatus: 401, expiredHelperRestoreRejected: true };
  });
  await savePrivateJson(path.join(directory, 'private-state.json'), privateState);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
  await savePrivateJson(path.join(directory, 'private-state.json'), privateState);
} finally {
  await browser?.close();
  for (const server of httpServers) await new Promise(resolve => server.close(resolve));
  try { await stopCore(); } catch (error) { report.cleanupError = error.message; }
  if (startedContainer) {
    const logs = await execute('docker', ['logs', containerName], { maxBuffer: 8 * 1024 * 1024 }).catch(() => ({ stdout: '', stderr: '' }));
    await writeFile(path.join(directory, 'synapse.log'), logs.stdout + logs.stderr);
    await execute('docker', ['rm', '--force', containerName]);
  }
  report.finishedAt = new Date().toISOString(); report.cleanup = { containerRemoved: startedContainer, httpServersStopped: true, coreStopped: !child || child.exitCode !== null };
  await save(); console.log(JSON.stringify({ status: report.status, checks: report.checks.length, reportPath }));
}
