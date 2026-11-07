#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { packageRoot } from '../src/paths.mjs';

const execute = promisify(execFile);
const { values } = parseArgs({ options: { browser: { type: 'boolean', default: false } } });
const base = Number(process.env.DS_GROUP_PLATFORM_SMOKE_PORT_BASE || 24220);
if (!Number.isInteger(base) || base < 1024 || base > 65525) throw new Error('Invalid DS_GROUP_PLATFORM_SMOKE_PORT_BASE');
const project = `dscord-platform-${randomBytes(6).toString('hex')}`;
const reportPath = path.resolve(process.env.DS_GROUP_PLATFORM_SMOKE_REPORT || path.join(packageRoot, '.local', `${project}.json`));
const coreUrl = `http://127.0.0.1:${base}`, matrixUrl = `http://127.0.0.1:${base + 8}`, adminUrl = `http://127.0.0.1:${base + 10}`;
const env = { ...process.env, DS_GROUP_IMAGE: process.env.DS_GROUP_IMAGE || 'ds-group:ci',
  DS_GROUP_BIND: '127.0.0.1', DS_GROUP_HTTP_PORT: String(base), DS_GROUP_MATRIX_PORT: String(base + 8), DS_GROUP_ADMIN_PORT: String(base + 10),
  DS_GROUP_SERVER_NAME: `${project}.test`, DS_GROUP_PUBLIC_URL: coreUrl, DS_GROUP_MATRIX_PUBLIC_URL: matrixUrl,
  DS_GROUP_WEB_MODE: 'api-only', DS_GROUP_MEDIA_BACKEND: 'local', DS_GROUP_BOOTSTRAP_DEMO: 'true' };
if (process.env.DS_GROUP_PLATFORM) {
  assert.ok(['linux/amd64', 'linux/arm64'].includes(process.env.DS_GROUP_PLATFORM), 'Use a supported Linux deployment platform');
  env.DOCKER_DEFAULT_PLATFORM = process.env.DS_GROUP_PLATFORM;
}
const report = { schemaVersion: 1, project, startedAt: new Date().toISOString(), status: 'running',
  evidenceLevel: 'real isolated Docker Compose Core/Synapse/administration and persistent named volumes; synthetic identities; zero model',
  image: env.DS_GROUP_IMAGE, origins: { coreUrl, matrixUrl, adminUrl }, checks: [], modelCalls: 0, physicalCrossMachine: false };
const composeArgs = ['compose', '--project-name', project, '-f', path.join(packageRoot, 'deploy/compose.yaml')];
const sensitive = new Set();
let browser, page, adminToken, login, group, sent, savedPolicy, before, started = false;
const hash = value => createHash('sha256').update(value).digest('hex');
async function save() {
  let output = JSON.stringify(report, null, 2) + '\n';
  for (const value of sensitive) if (value) output = output.replaceAll(value, '[REDACTED]');
  await writeFile(reportPath, output);
}
async function compose(args) {
  try { return (await execute('docker', [...composeArgs, ...args], { cwd: packageRoot, env, timeout: 240000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch (error) { throw new Error(`Compose ${args[0]} failed: ${error.stderr || error.message}`); }
}
async function request(origin, route, { token, body, method = body === undefined ? 'GET' : 'POST', status = 200 } = {}) {
  const response = await fetch(origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, status, `${method} ${route} returned ${response.status}`); return response.json();
}
async function check(name, work) {
  console.log(`Checking ${name}`);
  try { report.checks.push({ name, status: 'passed', details: await work() }); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
  finally { await save(); }
}
async function noChatWeb() {
  for (const route of ['/', '/index.html', '/theme.js', '/manifest.webmanifest', '/sw.js']) {
    const response = await request(coreUrl, route, { status: 404 }); assert.equal(response.code, 'WEB_DISABLED');
  }
}
async function snapshot() {
  const code = "const fs=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(['core-config.json','server.json','identity-config.json','matrix-setup.json'].map(f=>[f,c.createHash('sha256').update(fs.readFileSync('/data/'+f)).digest('hex')]))));";
  return JSON.parse(await compose(['exec', '-T', 'core', 'node', '-e', code]));
}

await mkdir(path.dirname(reportPath), { recursive: true });
try {
  for (const port of [base, base + 8, base + 10]) {
    const server = http.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  }
  for (const file of ['Dockerfile', 'deploy/compose.yaml', 'scripts/server-init.mjs', 'scripts/central-init.mjs', 'scripts/platform-deploy-smoke.mjs',
    'src/core.mjs', 'src/admin.mjs', 'src/admin-auth.mjs', 'src/identity.mjs', 'src/web-mode.mjs', 'deploy/synapse/dscord_guard.py']) {
    (report.sourceSha256 ||= {})[file] = hash(await readFile(path.join(packageRoot, file)));
  }
  report.imageIdentity = (await execute('docker', ['image', 'inspect', env.DS_GROUP_IMAGE, '--format', '{{.Id}} {{.Os}}/{{.Architecture}}'])).stdout.trim();
  started = true;
  await check('real Compose starts API-only Core, official Synapse and independent administration listener', async () => {
    await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '180']);
    report.containerRuntime = JSON.parse(await compose(['exec', '-T', 'core', 'node', '-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version}))']));
    if (process.env.DS_GROUP_PLATFORM) assert.equal(`${report.containerRuntime.platform}/${report.containerRuntime.arch === 'x64' ? 'amd64' : report.containerRuntime.arch}`, process.env.DS_GROUP_PLATFORM);
    await request(coreUrl, '/healthz'); await request(coreUrl, '/readyz'); await request(adminUrl, '/healthz'); await request(matrixUrl, '/_matrix/client/versions');
    assert.equal((await request(coreUrl, '/api/bootstrap')).web.mode, 'api-only'); await noChatWeb();
    return { services: ['config', 'synapse', 'bootstrap', 'core', 'administration'], mode: 'api-only', rootStatus: 404, adminHealth: 200 };
  });
  await check('containerized central initialization persists the default home without replacing its Matrix identities', async () => {
    const initial = await request(coreUrl, '/api/bootstrap');
    const result = JSON.parse(await compose(['run', '--rm', '--no-deps', '-T', '--user', '1000:1000', 'config', 'node', 'scripts/central-init.mjs',
      '--data-dir', '/data', '--core-url', coreUrl, '--matrix-url', matrixUrl]));
    assert.equal(result.mode, 'central'); assert.equal(result.registeredAccounts, 4);
    await compose(['restart', '--timeout', '30', 'core']); await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '180']);
    const discovery = await request(coreUrl, '/.well-known/dscord/client');
    assert.equal(discovery.mode, 'central'); assert.equal(discovery.home.coreUrl, coreUrl); assert.equal(discovery.home.matrixUrl, matrixUrl);
    assert.deepEqual((await request(coreUrl, '/api/bootstrap')).participants.map(p => p.id), initial.participants.map(p => p.id));
    return { mode: discovery.mode, authorityId: discovery.authorityId, home: discovery.home, existingIdentitiesPreserved: true };
  });
  await check('ordinary central login and room business work while management credentials remain separate', async () => {
    const credentials = JSON.parse(await compose(['exec', '-T', 'core', 'node', 'scripts/server-admin.mjs', 'credentials', 'alice']));
    sensitive.add(credentials.password);
    login = await request(coreUrl, '/api/login', { body: credentials }); sensitive.add(login.access_token);
    group = await request(coreUrl, '/api/rooms', { token: login.access_token, body: { name: 'Platform deployment QA', inviteIds: [], requestId: 'platform-room' } });
    sent = await request(coreUrl, `/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token: login.access_token,
      body: { body: 'Persistent API-only deployment message', to: [], transactionId: 'platform-message' } });
    await request(adminUrl, '/admin-api/me', { token: login.access_token, status: 401 });
    await compose(['exec', '-T', 'administration', 'node', 'scripts/admin.mjs', 'init', 'qa-admin']);
    const admin = JSON.parse(await compose(['exec', '-T', 'administration', 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/data/initial-administrator.json','utf8'))"]));
    sensitive.add(admin.password);
    const authenticated = await request(adminUrl, '/admin-api/login', { body: { username: admin.username, password: admin.password } });
    adminToken = authenticated.access_token; sensitive.add(adminToken);
    await request(coreUrl, '/api/me', { token: adminToken, status: 401 });
    report.adminBrowser = values.browser ? { requested: true } : { requested: false, scope: 'real management HTML/assets/API checked; interactive browser is optional --browser' };
    if (values.browser) {
      const { chromium } = await import('@playwright/test'); browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(() => { localStorage.setItem('ds-group.language', 'en'); localStorage.setItem('ds-group.theme', 'light'); });
      page = await context.newPage(); report.adminBrowser.pageErrors = [];
      page.on('pageerror', error => report.adminBrowser.pageErrors.push(error.message));
      await page.goto(adminUrl); await page.getByLabel('Administrator', { exact: true }).fill(admin.username);
      await page.getByLabel('Password', { exact: true }).fill(admin.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    }
    return { userId: login.user_id, subjectId: login.identity.subjectId, ordinaryTokenManagementStatus: 401, managementTokenCoreStatus: 401, eventId: sent.event_id };
  });
  await check('independent management UI/assets and real governance apply work against the containerized Synapse guard', async () => {
    const response = await fetch(adminUrl); assert.equal(response.status, 200); const html = await response.text();
    assert.match(html, /DSCord Administration/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]); assert.ok(assets.length >= 2);
    for (const resource of [...assets, '/theme.js']) assert.equal((await fetch(adminUrl + resource)).status, 200, resource);
    assert.equal((await fetch(adminUrl + '/api/bootstrap')).status, 404);
    const { policy } = await request(adminUrl, '/admin-api/policy', { token: adminToken });
    const changed = { ...policy, settings: { ...policy.settings, maxUploadBytes: 2097152 } };
    savedPolicy = (await request(adminUrl, '/admin-api/policy', { token: adminToken, body: changed, method: 'PUT' })).policy;
    const applied = await request(adminUrl, '/admin-api/apply', { token: adminToken, body: { revision: savedPolicy.revision } });
    report.application = applied;
    assert.equal(applied.application.status, 'prepared'); assert.equal(applied.livePolicyObserved, true); assert.equal(applied.restartRequired, false);
    if (page) {
      await page.reload(); await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Deployment', exact: true }).click();
      assert.equal(await page.getByLabel('Attachment limit (MiB)', { exact: true }).inputValue(), '2');
      const desktop = reportPath.replace(/\.json$/, '-admin-desktop.png'); await page.screenshot({ path: desktop, fullPage: true });
      report.adminBrowser.desktop = path.basename(desktop); report.adminBrowser.loginAndActualPolicyRead = true;
    }
    return { builtAssets: assets.length, savedRevision: savedPolicy.revision, actualApplication: applied.application.status, livePolicyObserved: applied.livePolicyObserved, configurationWritable: applied.configurationWritable };
  });
  await check('container recreation with mode omitted preserves central identity, sessions, admin policy and API-only', async () => {
    before = await snapshot(); await compose(['down', '--timeout', '45']); env.DS_GROUP_WEB_MODE = '';
    await compose(['up', '--no-build', '--detach', '--wait', '--wait-timeout', '180']); await noChatWeb();
    assert.deepEqual(await snapshot(), before);
    const me = await request(coreUrl, '/api/me', { token: login.access_token }); assert.equal(me.identity.subjectId, login.identity.subjectId);
    const history = await request(coreUrl, `/api/rooms/${encodeURIComponent(group.roomId)}/messages`, { token: login.access_token });
    assert.ok(history.events.some(event => event.event_id === sent.event_id));
    assert.equal((await request(adminUrl, '/admin-api/me', { token: adminToken })).username, 'qa-admin');
    const policy = await request(adminUrl, '/admin-api/policy', { token: adminToken }); assert.deepEqual(policy.policy, savedPolicy); assert.equal(policy.application.livePolicyObserved, true);
    assert.equal((await request(coreUrl, '/api/status')).budget.used, 0);
    if (page) { await page.reload(); await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor(); assert.deepEqual(report.adminBrowser.pageErrors, []); report.adminBrowser.sessionSurvivedRecreation = true; }
    return { sameSubjectAndMatrixId: true, sameConfigurationHashes: true, chatSessionAndHistory: true, adminSessionAndPolicy: true, mode: 'api-only', modelCalls: 0 };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
  if (started) await writeFile(reportPath.replace(/\.json$/, '.log'), await compose(['logs', '--no-color', '--tail', '100']).catch(() => 'Container logs unavailable'));
} finally {
  await browser?.close();
  if (started) {
    try { await compose(['down', '--volumes', '--remove-orphans', '--timeout', '45']); report.cleanedUp = true; }
    catch (error) { report.cleanedUp = false; report.cleanupError = error.message; process.exitCode = 1; }
    report.remainingContainers = (await execute('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}'])).stdout.trim();
    report.remainingVolumes = (await execute('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}'])).stdout.trim();
    if (report.remainingContainers || report.remainingVolumes) { report.cleanedUp = false; process.exitCode = 1; }
  }
  report.completedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: report.status, checks: report.checks.length, reportPath, cleanedUp: report.cleanedUp }));
}
