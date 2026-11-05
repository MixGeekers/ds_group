import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { packageRoot } from '../src/paths.mjs';

const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="/theme.js"></script>
    <link rel="stylesheet" href="/tokens.css">
    <link rel="stylesheet" href="/@fs/${path.join(packageRoot, 'ui/tailwind.css')}">
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/@fs/${path.join(packageRoot, 'ui/styles.css')}">
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CreateBotDialog } from '/src/components/CreateBotDialog.tsx';
      import { ApiError } from '/src/api.ts';

      const fixture = window.fixture = {
        mode: 'unknown', calls: [], created: [], callbacksFail: false,
        userId: '@alice:test', copied: [],
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async value => { fixture.copied.push(value); },
      } });
      const api = async (route, options = {}) => {
        fixture.calls.push({ route, method: options.method, body: options.body, userId: fixture.userId });
        if (route !== '/api/bots' || options.method !== 'POST') throw new Error('Unexpected API request');
        if (fixture.mode === 'unknown') throw new Error('Synthetic connection interrupted');
        if (fixture.mode === 'validation') throw new ApiError('Synthetic invalid Bot name', 400);
        if (fixture.mode === 'hold') await new Promise(resolve => { fixture.release = resolve; });
        if (fixture.mode === 'missing') return {};
        return { bot: {
          id: '@bot-' + options.body.requestId + ':test',
          localpart: 'bot-' + options.body.requestId,
          name: options.body.name, kind: 'bot', ownerId: fixture.userId,
        } };
      };
      function Fixture() {
        const [open, setOpen] = React.useState(true);
        const [userId, setUserId] = React.useState('@alice:test');
        const [status, setStatus] = React.useState({ nodes: [] });
        fixture.switchUser = id => { fixture.userId = id; setUserId(id); };
        fixture.setStatus = setStatus;
        return React.createElement(React.Fragment, null,
          React.createElement('button', { id: 'open-create-bot', onClick: () => setOpen(true) }, 'Open'),
          React.createElement(CreateBotDialog, {
            open, api, session: { user_id: userId, access_token: 'synthetic-' + userId }, status,
            onClose: () => setOpen(false),
            onCreated: async bot => {
              fixture.created.push(bot);
              if (fixture.callbacksFail) throw new Error('Synthetic list refresh failed');
            },
          }),
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script>
  </body>
</html>`;

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dscord-react-bots-'));
const reportPath = path.join(packageRoot, '.local/react-bots-browser.json');
const checks = [];
const pageErrors = [];
const report = { status: 'failed', level: 'real-chromium-react-bot-creation-fixture', checks, pageErrors, modelCalls: 0 };
const server = await createServer({
  configFile: false,
  root: path.join(packageRoot, 'web'),
  cacheDir: path.join(temporary, 'vite-cache'),
  plugins: [tailwindcss(), {
    name: 'react-bots-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__bots', async (request, response, next) => {
        if (request.url.includes('html-proxy')) { next(); return; }
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__bots', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 985, height: 822 }, locale: 'en-US' });
  context.setDefaultTimeout(10000);
  await context.addInitScript(() => {
    localStorage.setItem('ds-group.language', 'en');
    localStorage.setItem('ds-group.theme', 'dark');
  });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__bots`);
  await page.locator('#create-bot-dialog[open]').waitFor();
  await page.locator('#create-bot-submit').click();
  assert.equal(await page.locator('#bot-name').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
  checks.push('blankNameShowsFieldErrorWithoutCreatingBot');

  await page.locator('#bot-name').fill('Finance');
  await page.locator('#create-bot-submit').click();
  await page.locator('#create-bot-error').filter({ hasText: 'Synthetic connection interrupted' }).waitFor();
  assert.equal(await page.locator('#bot-name').getAttribute('readonly'), '');
  const firstRequest = await page.evaluate(() => window.fixture.calls[0].body);
  assert.ok(firstRequest.requestId);
  await page.locator('#close-create-bot').click();
  await page.locator('#open-create-bot').click();
  assert.equal(await page.locator('#bot-name').inputValue(), 'Finance');
  assert.equal(await page.locator('#create-bot-submit').textContent(), 'Retry creation');
  await page.evaluate(() => { window.fixture.mode = 'missing'; });
  await page.locator('#create-bot-submit').click();
  await page.locator('#create-bot-error').filter({ hasText: 'receipt is incomplete' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.calls[1].body), firstRequest);
  checks.push('unknownReceiptPersistsAcrossCloseAndRetriesSameRequest');

  await page.evaluate(() => window.fixture.switchUser('@bob:test'));
  await page.waitForFunction(() => document.querySelector('#bot-name').value === '');
  assert.equal(await page.locator('#bot-name').getAttribute('readonly'), null);
  await page.locator('#bot-name').fill('People');
  await page.evaluate(() => { window.fixture.mode = 'unknown'; });
  await page.locator('#create-bot-submit').click();
  await page.locator('#create-bot-error').filter({ hasText: 'Synthetic connection interrupted' }).waitFor();
  const bobRequest = await page.evaluate(() => window.fixture.calls[2].body);
  assert.notEqual(bobRequest.requestId, firstRequest.requestId);
  await page.evaluate(() => window.fixture.switchUser('@alice:test'));
  await page.waitForFunction(() => document.querySelector('#bot-name').value === 'Finance');
  checks.push('pendingCreationIsScopedToAccount');

  await page.evaluate(() => { window.fixture.mode = 'hold'; window.fixture.callbacksFail = true; });
  await page.locator('#create-bot-submit').click();
  await page.waitForFunction(() => typeof window.fixture.release === 'function');
  assert.equal(await page.locator('#create-bot-submit').isDisabled(), true);
  assert.equal(await page.locator('#close-create-bot').isDisabled(), true);
  await page.locator('#create-bot-form').evaluate(form => form.requestSubmit());
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 4);
  await page.evaluate(() => window.fixture.release());
  await page.locator('#bot-connection-id').waitFor();
  const botId = await page.locator('#bot-connection-id').inputValue();
  assert.equal(botId, '@bot-' + firstRequest.requestId + ':test');
  assert.equal(await page.locator('#create-bot-submit').count(), 0);
  assert.equal(await page.locator('#create-bot-error').textContent(), 'Bot created. The list could not refresh. Synthetic list refresh failed');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ds-group.pending-bot.@alice:test')), null);
  assert.equal(await page.evaluate(() => window.fixture.created.length), 1);
  checks.push('confirmedCreationSurvivesCallbackFailureAndPreventsDuplicateSubmit');

  assert.equal(await page.locator('.bot-connection-status').textContent(), 'Offline');
  await page.locator('#copy-bot-id').click();
  assert.deepEqual(await page.evaluate(() => window.fixture.copied), [botId]);
  await page.evaluate(id => window.fixture.setStatus({ nodes: [{ id: 'node', botId: id, name: 'Finance', status: 'ready' }] }), botId);
  await page.locator('.bot-connection-status').filter({ hasText: 'Online' }).waitFor();
  checks.push('connectionViewExposesFullBotIdCopyAndLiveStatus');

  await page.evaluate(async () => {
    (await import('/i18n.js')).setLocalePreference('zh-CN');
    window.DSGroupTheme.setPreference('light');
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#create-bot-title').filter({ hasText: '连接 Bot' }).waitFor();
  assert.equal(await page.locator('#bot-connection-id').inputValue(), botId);
  assert.equal(await page.locator('.bot-connection-status').textContent(), '在线');
  assert.equal(await page.evaluate(() => {
    const dialog = document.querySelector('#create-bot-dialog');
    const bounds = dialog.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
  }), true);
  checks.push('localeThemeAndMobileLayoutPreserveConnectionDetails');

  await page.locator('#close-create-bot').click();
  await page.locator('#open-create-bot').click();
  await page.locator('#bot-name').fill('Invalid');
  await page.evaluate(() => { window.fixture.mode = 'validation'; });
  await page.locator('#create-bot-submit').click();
  await page.locator('#create-bot-error').filter({ hasText: 'Synthetic invalid Bot name' }).waitFor();
  assert.equal(await page.locator('#bot-name').getAttribute('readonly'), null);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ds-group.pending-bot.@alice:test')), null);
  checks.push('knownValidationFailureAllowsNameCorrection');

  const longBotName = 'A'.repeat(80);
  await page.locator('#bot-name').fill(longBotName);
  await page.evaluate(() => { window.fixture.mode = 'success'; window.fixture.callbacksFail = false; });
  await page.locator('#create-bot-submit').click();
  await page.locator('.bot-connection-details h3').filter({ hasText: longBotName }).waitFor();
  assert.equal(await page.locator('.bot-connection-details h3').textContent(), longBotName);
  assert.equal(await page.evaluate(() => {
    const dialog = document.querySelector('#create-bot-dialog');
    const heading = dialog.querySelector('.bot-connection-details h3');
    const bounds = dialog.getBoundingClientRect();
    return innerWidth === 390 && bounds.left >= 0 && bounds.right <= innerWidth
      && dialog.scrollWidth <= dialog.clientWidth && heading.scrollWidth <= heading.clientWidth;
  }), true);
  checks.push('longBotNameWrapsInsideMobileConnectionDetails');

  assert.deepEqual(pageErrors, []);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await mkdir(path.dirname(reportPath), { recursive: true });
  if (report.status !== 'passed' && page) await page.screenshot({ path: path.join(packageRoot, '.local/react-bots-browser-failure.png') }).catch(() => {});
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await server.close();
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
