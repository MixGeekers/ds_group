#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from './runtime-config.mjs';
import { packNpm } from './npm-pack.mjs';

const installation = await resolveDsh();
const captureUi = process.argv.includes('--screenshots');
const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-native-model-settings-'));
const home = path.join(directory, 'home');
const profile = path.join(home, 'profiles/web');
const reportPath = path.join(packageRoot, '.local/model-settings-native.json');
const report = { status: 'failed', level: 'real-dsh-native-model-settings-zero-generation', modelCalls: 0, checks: [] };
const bot = { id: '@model-test:synthetic.test', localpart: 'model-test', name: '项目助手', kind: 'bot' };
const core = createServer((request, response) => {
  request.resume();
  response.setHeader('content-type', 'application/json');
  const value = request.url === '/api/login' ? { user_id: '@alice:synthetic.test', access_token: 'synthetic-user-token' }
    : request.url === '/api/bots' ? { bots: [bot] }
      : { budget: { maxTokens: 8192, allowedModels: null } };
  response.end(JSON.stringify(value));
});
core.listen(0, '127.0.0.1');
await once(core, 'listening');
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
await mkdir(profile, { recursive: true });
let pluginName = path.join(packageRoot, 'dsh-connect/index.mjs');
if (captureUi) {
  const packed = await packNpm();
  const unpacked = path.join(directory, 'release');
  await mkdir(unpacked);
  await promisify(execFile)('tar', ['-xzf', packed.archive, '-C', unpacked]);
  await mkdir(path.join(profile, 'node_modules'), { recursive: true });
  await symlink(path.join(unpacked, 'package'), path.join(profile, 'node_modules/dscord'), 'dir');
  pluginName = 'dscord';
}
await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'model-settings-smoke', private: true,
  type: 'module', ...(captureUi ? { dependencies: { dscord: '0.3.0-alpha.1' } } : {}),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
const guardPath = path.join(directory, 'zero-model.mjs');
const markerPath = path.join(directory, 'unexpected-model-call');
await writeFile(guardPath, `import { writeFile } from 'node:fs/promises';
export function apply(ctx) { ctx.on('llm/stream', () => (async function* () {
  await writeFile(${JSON.stringify(markerPath)}, 'blocked'); throw new Error('ZERO_MODEL_CHECK');
})()); }
`);
await writeFile(path.join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { SYNTHETIC_KEY: 'synthetic-local-key' }, records: {} }), { mode: 0o600 });
await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'llm-pi-ai', config: { providers: {
    'native-test': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'team/chat' }], apiKeyEnv: 'SYNTHETIC_KEY' },
    'second-test': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'local/assistant' }] },
    'missing-key': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'chat' }], apiKeyEnv: 'MISSING_KEY' },
  } } },
  { id: 'agent-default-model', config: { provider: 'native-test', model: 'team/chat' } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: false } },
  { insert: [
    { id: 'zero-model', name: guardPath },
    { id: 'dscord-connect', name: pluginName, config: { dataDirectory: path.join(directory, 'connection') } },
  ] },
]));
const log = await open(path.join(directory, 'host.log'), 'a', 0o600);
const child = spawn(installation.cli, ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
  cwd: directory, detached: true, stdio: ['ignore', log.fd, log.fd],
  env: { ...process.env, DSH_HOME: home, DS_GROUP_DSH_RUNTIME: installation.runtime, DSH_TELEMETRY_DISABLED: '1' },
});
const exited = new Promise(resolve => child.once('close', resolve));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let cookie;
let browser;
let page;
const screenshotDirectory = path.join(packageRoot, '.local/model-settings-native');
async function api(action, input = {}, expected = true) {
  if (!cookie) {
    const output = await readFile(path.join(directory, 'host.log'), 'utf8');
    const url = output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
    if (!url) throw new Error('Waiting for DSH launch authentication');
    const exchange = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    cookie = exchange.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/dscord`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ action, ...input }), signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, expected, result.error?.code);
  assert.equal(JSON.stringify(result).includes('synthetic-local-key'), false);
  return result.ok ? result.value : result.error;
}
try {
  let initial;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('DSH host exited during native model settings initialization');
    try { initial = await api('status'); break; } catch { await sleep(500); }
  }
  assert.ok(initial, 'Native model settings did not become available');
  assert.equal(initial.models.providers.find(provider => provider.id === 'native-test').credential, 'configured');
  assert.equal(initial.models.providers.find(provider => provider.id === 'missing-key').credential, 'missing');
  const initialProfile = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
  const initialCredentials = await readFile(path.join(home, '.credentials.yaml'), 'utf8');
  report.checks.push('nativeProviderDirectoryAndCredentialStatus');
  await api('login', { serverUrl: `http://127.0.0.1:${core.address().port}`, user: 'alice', password: 'synthetic' });
  let value = await api('save-model', { botId: bot.id, selection: { model: 'native-test/team/chat', maxTokens: 2048 } });
  assert.deepEqual(value.bots[0].modelSelection, { model: 'native-test/team/chat', maxTokens: 2048 });
  assert.equal((await api('save-model', { botId: bot.id, selection: { model: 'missing-key/chat' } }, false)).code, 'MISSING_CREDENTIAL');
  assert.equal((await api('save-model', { botId: bot.id, selection: { model: 'native-test/unknown' } }, false)).code, 'MODEL_UNAVAILABLE');
  report.checks.push('saveSelectionAndRejectMissingCredentialAndInvalidModel');
  value = await api('save-model', { botId: bot.id, selection: { model: 'second-test/local/assistant' } });
  assert.equal(value.bots[0].modelSelection.model, 'second-test/local/assistant');
  assert.equal(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), initialProfile);
  assert.equal(await readFile(path.join(home, '.credentials.yaml'), 'utf8'), initialCredentials);
  await api('add-provider', { provider: 'unwanted' }, false);
  await api('set-provider-key', { provider: 'native-test', key: 'unwanted' }, false);
  assert.equal(await readFile(path.join(home, '.credentials.yaml'), 'utf8'), initialCredentials);
  report.checks.push('selectingAnotherDshModelPreservesNativeProviderAndCredentials', 'providerEditingActionsUnavailable');
  if (captureUi) {
    await api('logout');
    const { chromium } = await import('playwright');
    await mkdir(screenshotDirectory, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light' });
    const separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: `http://127.0.0.1:${port}` }]);
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: 'DSCord', exact: true }).click({ timeout: 30_000 });
    await page.getByLabel('服务器地址', { exact: true }).fill(`http://127.0.0.1:${core.address().port}`);
    await page.getByLabel('账号', { exact: true }).fill('alice');
    await page.getByLabel('密码', { exact: true }).fill('synthetic');
    assert.match(await page.locator('.dc-login input').first().getAttribute('class'), /input/);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.dscord-connect select').waitFor();
    await page.locator('.dscord-connect select').selectOption('native-test/team/chat');
    await page.locator('.dc-model-form button').click();
    await page.locator('.dc-notice[role="status"]').waitFor();
    assert.match(await page.locator('.dc-model-form button').getAttribute('class'), /button/);
    await page.screenshot({ path: path.join(screenshotDirectory, 'dsh-model-selection.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
    await page.screenshot({ path: path.join(screenshotDirectory, 'dsh-model-selection-dark.png') });
    report.checks.push('packagedPluginLoadsInRealDshShellAndSavesNativeModelSelection', 'nativeButtonsInputsAndDshThemeSwitch');
    report.nativeUi = { host: 'DSH 0.2.1-rc.5 web shell', viewport: { width: 1440, height: 1000 },
      server: 'isolated synthetic Core API', botRuntime: 'offline', nativeControls: ['Button', 'Input'],
      screenshots: ['dsh-model-selection.png', 'dsh-model-selection-dark.png'] };
  }
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
  report.checks.push('zeroGenerationAttempts');
  report.status = 'passed';
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(screenshotDirectory, 'failure.png') }).catch(() => {});
    await writeFile(path.join(screenshotDirectory, 'failure.txt'), await page.locator('body').innerText().catch(() => '')).catch(() => {});
  }
  report.error = error.message;
  report.diagnosticDirectory = directory;
  process.exitCode = 1;
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 40_000); })]);
  clearTimeout(timer);
  if (!stopped) { process.kill(-child.pid, 'SIGKILL'); await exited; report.status = 'failed'; report.forcedStop = true; process.exitCode = 1; }
  await log.close();
  await new Promise(resolve => core.close(resolve));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
