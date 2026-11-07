#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { packageRoot } from '../src/paths.mjs';
import { DSH_VERSION, resolveDsh } from './runtime-config.mjs';
import { KERNEL_ID, KERNEL_VERSION } from '../dsh-connect/kernel-runtime.mjs';
import { prepareRuntimeDependencies } from './runtime-dependencies.mjs';
import { packNpm } from './npm-pack.mjs';

const installation = await resolveDsh();
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dscord-native-ui-')));
const home = path.join(directory, 'home');
const profile = path.join(home, 'profiles/web');
const dependencies = path.join(directory, 'dependencies');
const reportPath = path.resolve(process.env.DS_GROUP_NATIVE_UI_REPORT || path.join(packageRoot, '.local/native-ui.json'));
const screenshotDirectory = path.join(path.dirname(reportPath), 'native-ui');
const report = { schemaVersion: 2, checkedAt: new Date().toISOString(), status: 'failed',
  level: 'packaged-plugin-in-real-dsh-web-ui-with-isolated-local-provider', expectedDshVersion: DSH_VERSION,
  remoteModelCalls: 0, localModelCalls: 0, checks: [], browserErrors: [], screenshots: [] };
const localModel = createServer((request, response) => {
  request.resume(); report.localModelCalls++;
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end('{"error":"This UI smoke does not run model generation."}');
});
localModel.listen(0, '127.0.0.1'); await once(localModel, 'listening');
const localModelUrl = `http://127.0.0.1:${localModel.address().port}/v1`;
const env = { PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), DSH_HOME: home,
  DS_GROUP_DSH_RUNTIME: installation.runtime, DS_GROUP_RUNTIME_DEPS_DIR: dependencies, DSH_TELEMETRY_DISABLED: '1' };
let child, exited, log, cookie, base, browser, page;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function authenticated() {
  if (cookie) return;
  const output = await readFile(path.join(directory, 'host.log'), 'utf8');
  const launch = output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
  if (!launch) throw new Error('Waiting for DSH launch authentication');
  const exchange = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
  cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'The isolated DSH did not issue a browser session');
  base = new URL(launch).origin;
}
async function request(route, body, expected = true) {
  await authenticated();
  const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `${route} is unavailable`);
  const result = await response.json();
  assert.equal(result.ok, expected, result.error?.message);
  assert.equal(JSON.stringify(result).includes('synthetic-local-key'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-ui-decision-key'), false);
  return result.ok ? result.value : result.error;
}
const connect = (action, input = {}) => request('/api/dscord', { action, ...input });
const kernel = (endpoint, payload = {}) => request('/api/dscord/kernel', { endpoint, payload });
async function screenshot(name) {
  const filename = path.join(screenshotDirectory, name);
  await page.screenshot({ path: filename, animations: 'disabled' }); report.screenshots.push(filename);
}

try {
  await mkdir(screenshotDirectory, { recursive: true });
  const version = await promisify(execFile)(installation.cli, ['--version'], { env, timeout: 30000 });
  report.dshVersion = version.stdout.trim(); assert.equal(report.dshVersion, DSH_VERSION);
  const packed = process.env.DS_GROUP_NATIVE_UI_ARCHIVE ? { archive: path.resolve(process.env.DS_GROUP_NATIVE_UI_ARCHIVE) } : await packNpm();
  const unpacked = path.join(directory, 'release'); await mkdir(unpacked);
  await promisify(execFile)('tar', ['-xzf', packed.archive, '-C', unpacked]);
  const release = path.join(unpacked, 'package');
  const manifest = JSON.parse(await readFile(path.join(release, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dscord'); assert.ok(manifest.version.startsWith(KERNEL_VERSION + '-'));
  report.package = { version: manifest.version, archive: packed.archive,
    sha256: createHash('sha256').update(await readFile(packed.archive)).digest('hex') };
  await prepareRuntimeDependencies({ directory: dependencies, plugin: path.join(release, 'dsh-plugin'), runtime: installation.runtime });
  await symlink(path.join(packageRoot, 'node_modules'), path.join(release, 'node_modules'), 'dir');
  await mkdir(path.join(profile, 'node_modules'), { recursive: true });
  await symlink(release, path.join(profile, 'node_modules/dscord'), 'dir');
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'dscord-native-ui-smoke', private: true,
    type: 'module', dependencies: { dscord: manifest.version },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
  await writeFile(path.join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { SYNTHETIC_KEY: 'synthetic-local-key' }, records: {} }), { mode: 0o600 });
  await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: {
      'native-test': { api: 'openai-completions', baseURL: localModelUrl, models: [{ id: 'team/chat' }], apiKeyEnv: 'SYNTHETIC_KEY' },
      'second-test': { api: 'openai-completions', baseURL: localModelUrl, models: [{ id: 'local/assistant' }], apiKeyEnv: 'SYNTHETIC_KEY' },
    } } },
    { id: 'agent-default-model', config: { provider: 'native-test', model: 'team/chat' } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: false } },
    { insert: [{ id: 'dscord-connect', name: 'dscord', config: { dataDirectory: path.join(directory, 'connection') } }] },
  ]));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  log = await open(path.join(directory, 'host.log'), 'a', 0o600);
  child = spawn(installation.cli, ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: directory, detached: true, stdio: ['ignore', log.fd, log.fd], env,
  });
  exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  let initial;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('DSH exited before packaged UI readiness');
    try { initial = await connect('status'); break; } catch { await sleep(500); }
  }
  assert.ok(initial, 'Packaged DSCord did not become ready');
  report.initial = { nativeMode: initial.nativeMode, nativeBundled: initial.nativeBundled, runtime: initial.runtime, lastError: initial.lastError };
  assert.equal(initial.nativeBundled, true, 'The archive must start the DSCord kernel'); assert.deepEqual(initial.nativeBots, []);
  const runtime = (await kernel('kernel-info')).runtime;
  assert.equal(runtime.id, KERNEL_ID); assert.equal(runtime.version, KERNEL_VERSION);
  assert.equal(runtime.api, '/api/dscord/kernel');
  const empty = await kernel('state'); assert.deepEqual(empty.bots, []); assert.deepEqual(empty.mainBotIds, []);
  report.runtime = { id: runtime.id, version: runtime.version, upstreamVersion: runtime.upstreamVersion, api: runtime.api };
  report.checks.push('archiveLoadsWithPinnedDshAndPrivateDependencies', 'readingStateDoesNotCreateChiefOrOtherBots');
  const providerSettings = patches => patches.filter(entry => ['llm-pi-ai', 'agent-default-model'].includes(entry.id));
  const initialProfile = providerSettings(parseYaml(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')));
  const initialCredentials = await readFile(path.join(home, '.credentials.yaml'), 'utf8');
  const { chromium } = await import('playwright'); browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light' });
  const separator = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }]);
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('response', async response => {
    if (!response.url().endsWith('/api/dscord/kernel') || response.request().postDataJSON()?.endpoint !== 'state') return;
    const result = await response.json().catch(() => null);
    if (result) report.lastWorkspaceState = { ok: result.ok, error: result.error,
      bots: result.value?.bots?.length, mainBotIds: result.value?.mainBotIds,
      unchanged: result.value?.unchanged, revision: result.value?.revision };
  });
  const creates = [];
  page.on('request', value => {
    if (!value.url().endsWith('/api/dscord') || value.method() !== 'POST') return;
    const body = value.postDataJSON(); if (body.action === 'create-native') creates.push(body);
  });
  await page.goto(base);
  const intro = page.getByRole('button', { name: /^(继续|Continue)$/ });
  await intro.click({ timeout: 15000 });
  await page.getByRole('button', { name: 'DSCord', exact: true }).click({ timeout: 30000 });
  await page.locator('.dc-create summary').click();
  await page.locator('input[name="botName"]').fill('识雨');
  await page.locator('input[name="botRole"]').fill('合成界面检查伙伴');
  await page.locator('select[name="localModel"]').selectOption('second-test/local/assistant');
  assert.match(await page.locator('input[name="botName"]').getAttribute('class'), /input/);
  await page.getByRole('button', { name: '创建到此节点', exact: true }).click();
  await page.getByText('Bot 已创建，可将它加入服务器。', { exact: true }).waitFor();
  assert.equal(creates.length, 1); assert.ok(creates[0].requestId);
  const created = (await connect('status')).nativeBots;
  assert.equal(created.length, 1); assert.equal(created[0].name, '识雨'); assert.equal(created[0].model, 'second-test/local/assistant');
  const createdState = await kernel('state');
  assert.equal(createdState.bots.length, 1);
  assert.ok(createdState.mainBotIds.every(id => id === created[0].id), 'Explicit creation must not add another Chief');
  report.bot = { nativeBotId: created[0].id, model: created[0].model, name: created[0].name, mainBotIds: createdState.mainBotIds };
  report.checks.push('realDshFormExplicitlyCreatesFirstBotWithStableRequestAndChosenModel');
  await page.getByRole('button', { name: 'Bot 设置', exact: true }).click();
  await page.getByRole('radio', { name: /自然参与/ }).check();
  await page.getByRole('button', { name: '保存参与方式', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '下次同步' }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('.dc-mode-options').disabled);
  assert.equal(await page.getByRole('radio', { name: /自然参与/ }).isChecked(), true);
  await page.getByText('没有匹配的记忆记录。', { exact: true }).waitFor();
  report.checks.push('offlineDesiredParticipationStaysPendingAndMemoryReadUsesOwnedKernel');
  await screenshot('dsh-kernel-light.png');
  await page.getByText('参与判断服务', { exact: true }).click();
  await page.locator('input[name="decisionApiKey"]').fill('synthetic-ui-decision-key');
  await page.locator('input[name="enabled"]').uncheck();
  await page.getByRole('button', { name: '保存判断服务', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '判断服务已保存' }).waitFor();
  assert.equal(await page.locator('input[name="decisionApiKey"]').inputValue(), '');
  assert.equal((await page.locator('body').innerText()).includes('synthetic-ui-decision-key'), false);
  const privatePath = path.join(directory, 'connection/decision-provider.json');
  const privateDecision = JSON.parse(await readFile(privatePath, 'utf8'));
  assert.equal(privateDecision.enabled, false); assert.equal(privateDecision.apiKey, 'synthetic-ui-decision-key');
  assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
  report.checks.push('realDshPrivateDecisionFormClearsKeyAndSavesDisabledServiceWith0600Mode');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
  await screenshot('dsh-kernel-dark.png');
  await page.getByRole('button', { name: 'DS Bot', exact: true }).click();
  await page.getByRole('region', { name: 'Bot 列表' }).waitFor();
  const workspaceBot = page.locator(`.bt-leftcol [data-bot-id="${created[0].id}"]`);
  await workspaceBot.waitFor({ timeout: 15000 });
  await workspaceBot.click();
  assert.equal((await kernel('state')).bots.length, 1); assert.deepEqual((await kernel('state')).mainBotIds, createdState.mainBotIds);
  await screenshot('dsh-kernel-workspace.png');
  report.checks.push('packagedBotWorkspaceReadsSameOwnedKernelWithoutExtraBotCreation', 'hostNativeControlsAndLightDarkThemeRender');
  assert.deepEqual(providerSettings(parseYaml(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'))), initialProfile);
  assert.equal(await readFile(path.join(home, '.credentials.yaml'), 'utf8'), initialCredentials);
  assert.equal(report.localModelCalls, 0); assert.deepEqual(report.browserErrors, []);
  report.checks.push('dshProviderConfigurationUnchanged', 'zeroLocalAndRemoteModelGeneration');
  report.status = 'passed';
} catch (error) {
  if (page) await screenshot('failure.png').catch(() => {});
  report.error = error.message; report.errorStack = error.stack; report.diagnosticDirectory = directory; process.exitCode = 1;
} finally {
  await browser?.close();
  if (child) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let timer;
    const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 40000); })]);
    clearTimeout(timer);
    if (!stopped) { process.kill(-child.pid, 'SIGKILL'); await exited; report.status = 'failed'; report.forcedStop = true; process.exitCode = 1; }
  }
  await log?.close(); localModel.closeAllConnections(); await new Promise(resolve => localModel.close(resolve));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
