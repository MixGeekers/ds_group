#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
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
const captureUi = true;
const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-native-ui-'));
const home = path.join(directory, 'home');
const profile = path.join(home, 'profiles/web');
const reportPath = path.join(packageRoot, '.local/native-ui.json');
const report = { status: 'failed', level: 'real-dsh-native-ui-scripted-local-provider', remoteModelCalls: 0, localModelCalls: 0, checks: [] };
const localModel = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks)); report.localModelCalls++;
  const chunk = { id: `ui-${report.localModelCalls}`, object: 'chat.completion.chunk', created: 1, model: input.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '原生 Bot 已就绪。可以让我创建伙伴、配置模型和职责，再把他们加入 DSCord。' }, finish_reason: null }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify(chunk)}\n\n`); chunk.choices[0].delta = {}; chunk.choices[0].finish_reason = 'stop';
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
localModel.listen(0, '127.0.0.1'); await once(localModel, 'listening');
const localModelUrl = `http://127.0.0.1:${localModel.address().port}/v1`;
const bot = { id: '@model-test:synthetic.test', localpart: 'model-test', name: '主理 Bot', kind: 'bot' };
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
  await symlink(path.join(packageRoot, 'node_modules'), path.join(unpacked, 'package/node_modules'), 'dir');
  pluginName = 'dscord';
}
await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'model-settings-smoke', private: true,
  type: 'module', ...(captureUi ? { dependencies: { dscord: '0.3.0-alpha.1' } } : {}),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
await writeFile(path.join(profile, 'cordis.yml'), '[]\n');
await writeFile(path.join(home, '.credentials.yaml'), JSON.stringify({ version: 1, refs: { SYNTHETIC_KEY: 'synthetic-local-key' }, records: {} }), { mode: 0o600 });
await writeFile(path.join(profile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'llm-pi-ai', config: { providers: {
    'native-test': { api: 'openai-completions', baseURL: localModelUrl, models: [{ id: 'team/chat' }], apiKeyEnv: 'SYNTHETIC_KEY' },
    'second-test': { api: 'openai-completions', baseURL: localModelUrl, models: [{ id: 'local/assistant' }], apiKeyEnv: 'SYNTHETIC_KEY' },
    'missing-key': { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'chat' }], apiKeyEnv: 'MISSING_KEY' },
  } } },
  { id: 'agent-default-model', config: { provider: 'native-test', model: 'team/chat' } },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: true, surfaceContext: false } },
  { insert: [
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
const screenshotDirectory = path.join(packageRoot, '.local/native-ui');
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
  report.initial = initial;
  assert.ok(initial.nativeBundled, 'complete native team starts when no DS-Bot plugin is installed');
  assert.equal(initial.nativeBots.length, 1);
  bot.nativeBinding = { hostId: initial.hostId, nativeBotId: initial.nativeBots[0].id, botId: bot.id };
  const initialProfile = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
  const initialCredentials = await readFile(path.join(home, '.credentials.yaml'), 'utf8');
  await api('login', { serverUrl: `http://127.0.0.1:${core.address().port}`, user: 'alice', password: 'synthetic' });
  let value = await api('save-model', { botId: bot.id, selection: { model: 'native-test/team/chat' } });
  assert.equal(value.bots[0].modelSelection.model, 'native-test/team/chat');
  assert.ok(['MISSING_CREDENTIAL','MODEL_UNAVAILABLE'].includes((await api('save-model', { botId: bot.id, selection: { model: 'missing-key/chat' } }, false)).code));
  assert.equal((await api('save-model', { botId: bot.id, selection: { model: 'native-test/unknown' } }, false)).code, 'MODEL_UNAVAILABLE');
  assert.deepEqual(parseYaml(await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')), parseYaml(initialProfile));
  assert.equal(await readFile(path.join(home, '.credentials.yaml'), 'utf8'), initialCredentials);
  report.checks.push('bundledOriginalNativeTeam', 'nativeModelSelectionWithoutCredentialCopy', 'rejectUnknownModel', 'preserveDshModelConfiguration');
  if (captureUi) {
    await api('logout');
    const { chromium } = await import('playwright');
    await mkdir(screenshotDirectory, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', colorScheme: 'light' });
    const separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: `http://127.0.0.1:${port}` }]);
    page = await context.newPage();
    report.browserErrors = [];
    page.on('pageerror', error => report.browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}`);
    const intro = page.getByRole('button', { name: '继续', exact: true });
    await intro.click();
    await page.getByRole('button', { name: 'DSCord', exact: true }).click({ timeout: 30_000 });
    await page.getByLabel('服务器地址', { exact: true }).fill(`http://127.0.0.1:${core.address().port}`);
    await page.getByLabel('账号', { exact: true }).fill('alice');
    await page.getByLabel('密码', { exact: true }).fill('synthetic');
    assert.match(await page.locator('.dc-login input').first().getAttribute('class'), /input/);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.dscord-connect select').waitFor();
    await page.locator('.dscord-connect select').selectOption('second-test/local/assistant');
    await page.locator('.dc-model-form button').click();
    await page.locator('.dc-notice[role="status"]').waitFor();
    assert.equal(await page.getByRole('heading', { name: '本机原生 Bot' }).count(), 1);
    assert.match(await page.locator('.dc-model-form button').getAttribute('class'), /button/);
    await page.screenshot({ path: path.join(screenshotDirectory, 'dsh-native-bots.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'));
    await page.screenshot({ path: path.join(screenshotDirectory, 'dsh-native-bots-dark.png') });
    await page.getByRole('button', { name: 'DS Bot', exact: true }).click();
    await page.getByRole('region', { name: 'Bot 列表' }).waitFor();
    await page.waitForFunction(() => Math.abs(document.querySelector('.bt-leftcol')?.getBoundingClientRect().left ?? -999) < 1);
    await page.screenshot({ path: path.join(screenshotDirectory, 'dsh-original-bot-mode.png'), animations: 'disabled' });
    assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n'));
    report.checks.push('packagedPluginLoadsInRealDshShellAndSavesNativeModelSelection', 'nativeButtonsInputsAndDshThemeSwitch');
    report.nativeUi = { host: 'DSH 0.2.1-rc.5 web shell', viewport: { width: 1440, height: 1000 },
      server: 'isolated synthetic Core API', botRuntime: 'offline', nativeControls: ['Button', 'Input'],
      screenshots: ['dsh-native-bots.png', 'dsh-native-bots-dark.png', 'dsh-original-bot-mode.png'] };
  }
  report.checks.push('zeroRemoteProviderCalls');
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
  localModel.closeAllConnections(); await new Promise(resolve => localModel.close(resolve));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (report.status === 'passed') await rm(directory, { recursive: true, force: true });
}
