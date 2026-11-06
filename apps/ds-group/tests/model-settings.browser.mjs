import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { ConnectController } from '../dsh-connect/controller.mjs';
import { DshModels } from '../dsh-connect/models.mjs';
import { packageRoot } from '../src/paths.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dscord-model-ui-'));
const output = path.join(packageRoot, '.local/model-settings');
await mkdir(output, { recursive: true });
const bot = { id: '@project-helper:chat.example', name: '项目助手', localpart: 'project-helper', kind: 'bot' };
const profiles = {
  'team-api': { displayName: '团队 API', apiKeyEnv: 'TEAM_KEY', models: [{ id: 'team/chat' }] },
  'local-model': { displayName: '本地推理', api: 'openai-completions', baseURL: 'http://127.0.0.1:9991/v1', models: [{ id: 'assistant' }] },
  'missing-api': { displayName: '待配置服务', apiKeyEnv: 'MISSING_KEY', models: [{ id: 'assistant' }] },
};
const refs = { TEAM_KEY: 'synthetic-team-key' };
const services = {
  settings: {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles }, user: { providers: profiles }, base: { providers: {} }, revision: 'synthetic' }],
    async mutate(_namespace, operations) { for (const op of operations) profiles[op.path[1]] = op.value; },
  },
  credentials: {
    describe: async ref => ({ configured: Boolean(refs[ref]), writable: true }),
    resolve: async ref => refs[ref] ? { value: refs[ref] } : undefined,
    readRecord: async () => undefined,
    set: async (ref, key) => { refs[ref] = key; },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'team-api', model: 'team/chat', reasoningEffort: 'high' }) },
};
const llm = {
  listProviders: () => Object.keys(profiles).map(id => ({ id })),
  listConfigurableProviders: () => Object.keys(profiles).map(provider => ({ provider, displayName: profiles[provider].displayName || provider,
    settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: true })),
  listModels: async provider => profiles[provider].apiKeyEnv && !refs[profiles[provider].apiKeyEnv] ? [] : profiles[provider].models,
  resolveModelInfo: async provider => provider === 'team-api' ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } } : {},
};
const effects = [];
const live = new Map();
const controller = await new ConnectController({
  directory: path.join(temporary, 'connection'), models: new DshModels({ llm, get: name => services[name] }), selectPort: async () => 23100,
  processes: {
    available: async () => ({ available: true }),
    async start(node) {
      effects.push('start');
      live.set(node.id, JSON.parse(await readFile(path.join(node.directory, 'model-source.json'), 'utf8')).selection);
    },
    async stop(node) { effects.push('stop'); live.delete(node.id); },
    probe: async node => ({ status: live.has(node.id) ? 'online' : 'offline', modelConfig: live.get(node.id) }),
  },
  async request(url) {
    if (url.endsWith('/api/login')) return Response.json({ user_id: '@alice:chat.example', access_token: 'synthetic-user-token', user: { name: 'Alice' } });
    if (url.endsWith('/api/status')) return Response.json({ budget: { maxTokens: 8192, allowedModels: null } });
    if (url.endsWith('/api/bots')) return Response.json({ bots: [bot] });
    if (url.endsWith('/connect')) return Response.json({ bundle: {
      schemaVersion: 1, nodeId: bot.localpart, coreUrl: 'https://chat.example',
      coreConfig: { nodeSecret: 'synthetic-node-token', publicUrl: 'https://chat.example' },
      setup: { homeserverUrl: 'https://matrix.example', participants: [{ ...bot, accessToken: 'synthetic-bot-token' }] },
    } });
    return Response.json({});
  },
}).initialize();
await controller.restoring;
await controller.handle({ action: 'login', serverUrl: 'https://chat.example', user: 'alice', password: 'synthetic' });

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
const dictionaries = new Map();
const listeners = new Set();
let language = 'zh';
let entry;
const disposers = [];
const locale = {
  register(name, value) { dictionaries.set(name, value); return () => {}; },
  bind(name) { return (key, values = {}) => (dictionaries.get(name)[language][key] || key).replace(/\\{(\\w+)\\}/g, (_, key) => values[key] ?? key); },
};
window.fixture = { setLanguage(value) { language = value; for (const callback of listeners) callback(); } };
window.__ModuleLoader__ = { load(descriptor) {
  const plugin = descriptor.factory(name => name === 'react' ? React : { Button: 'button', Input: 'input', IconPluginPinwheelOutlineRegular: () => null });
  plugin.apply({ locale, effect(setup) { disposers.push(setup()); }, slots: {
    inject(_name, setup) { return setup(); },
    register(options, component) { if (options.name === 'main') entry = { options, component }; return () => {}; },
  } });
} };
await import('/@fs/${path.join(packageRoot, 'dsh-connect/client.js')}');
function Fixture() {
  React.useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => language);
  return React.createElement(entry.component, { ...entry.options.inject(), t: locale.bind(entry.options.locale) });
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const pageErrors = [];
const checks = [];
const server = await createServer({ configFile: false, root: path.join(packageRoot, 'web'), cacheDir: path.join(temporary, 'vite-cache'),
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'model-settings-fixture', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (request.url === '/api/dscord') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        let result;
        try { result = { ok: true, value: await controller.handle(JSON.parse(Buffer.concat(chunks).toString())) }; }
        catch (error) { result = { ok: false, error: { code: error.code, message: error.message } }; }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
      } else if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end(await vite.transformIndexHtml('/', html));
      } else next();
    });
  } }],
});
let browser;
let page;
const report = { status: 'failed', level: 'real-chromium-production-ui-controller-synthetic-dsh-and-processes', modelCalls: 0, checks, pageErrors };
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1120, height: 1000 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByText('项目助手', { exact: true }).waitFor();
  assert.equal(await page.locator('select').count(), 1);
  assert.equal(await page.locator('input[type="password"], input[type="number"], textarea').count(), 0);
  const originalProfiles = JSON.stringify(profiles);
  const originalRefs = JSON.stringify(refs);
  await page.getByLabel('模型', { exact: true }).selectOption('local-model/assistant');
  await page.getByRole('button', { name: '保存选择' }).click();
  await page.getByRole('status').filter({ hasText: '模型选择已保存' }).waitFor();
  assert.equal(effects.length, 0);
  assert.deepEqual(controller.state.modelSelections[bot.id], { model: 'local-model/assistant', maxTokens: 4096 });
  checks.push('singleNativeModelPickerWithoutProviderOrCredentialForms');
  checks.push('selectionSavedThroughRealControllerBeforeFirstConnection');
  await page.getByRole('button', { name: '上线 项目助手', exact: true }).click();
  await page.getByText('当前运行 · local-model/assistant', { exact: true }).waitFor();
  await page.getByLabel('模型', { exact: true }).selectOption('team-api/team/chat');
  await page.getByRole('button', { name: '保存选择' }).click();
  await page.getByText('已选模型 · team-api/team/chat', { exact: true }).waitFor();
  assert.deepEqual(effects, ['start']);
  await page.getByText('点击重连应用新模型。重连会停止当前任务。').waitFor();
  checks.push('savingDuringExecutionRetainsRunningModelAndShowsPendingSelection');
  await page.screenshot({ path: path.join(output, 'model-settings-light.png'), fullPage: true });
  assert.equal(JSON.stringify(profiles), originalProfiles);
  assert.equal(JSON.stringify(refs), originalRefs);
  checks.push('selectingModelsKeepsDshProviderAndCredentialConfigurationIntact');
  await page.getByRole('button', { name: '重新连接 项目助手' }).click();
  await page.getByText('当前运行 · team-api/team/chat', { exact: true }).waitFor();
  assert.deepEqual(effects, ['start', 'stop', 'start']);
  checks.push('explicitReconnectAppliesSavedSelection');
  await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); window.fixture.setLanguage('en'); });
  await page.getByText('Running model · team-api/team/chat', { exact: true }).waitFor();
  await page.locator('.dscord-connect').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'model-settings-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.fixture.setLanguage('zh'); });
  await page.locator('.dscord-connect').evaluate(element => { element.scrollTop = 0; });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'model-settings-mobile.png'), fullPage: true });
  checks.push('lightDarkEnglishChineseAndMobileLayout');
  assert.deepEqual(pageErrors, []);
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await controller.dispose();
  await writeFile(path.join(output, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
