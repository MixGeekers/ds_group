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
        if (route === '/api/bot-catalog') return {bots:[{id:'native-a',hostId:'host-a',hostName:'Local DSH',name:'Researcher',role:'Research',model:'local/chat',main:true,available:true,botId:null},{id:'offline',hostId:'host-b',hostName:'Offline DSH',name:'Offline Bot',role:'Writer',model:'local/chat',available:false,botId:null}]};
        if (route !== '/api/bots/attach' || options.method !== 'POST') throw new Error('Unexpected API request');
        if (fixture.mode === 'unknown') throw new Error('Synthetic connection interrupted');
        if (fixture.mode === 'validation') throw new ApiError('Synthetic invalid Bot name', 400);
        if (fixture.mode === 'hold') await new Promise(resolve => { fixture.release = resolve; });
        if (fixture.mode === 'missing') return {};
        return { bot: {
          id: '@bot-' + options.body.nativeBotId + ':test',
          localpart: 'bot-' + options.body.nativeBotId,
          name: 'Researcher', kind: 'bot', ownerId: fixture.userId,
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
const report = { status: 'failed', level: 'real-chromium-existing-native-bot-selector-fixture', checks, pageErrors, modelCalls: 0 };
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
  const add = page.getByRole('button', {name:'Add existing Bot',exact:true});
  await page.getByRole('radio').first().waitFor();
  assert.equal(await add.isDisabled(),true);
  assert.equal(await page.getByRole('radio').last().isDisabled(),true);
  assert.equal(await page.locator('input[type="text"]').count(),0);
  checks.push('selectsExistingLocalBotsWithoutNameCreationForm');
  await page.getByRole('radio').first().check();
  await add.click();
  await page.getByRole('alert').filter({hasText:'Synthetic connection interrupted'}).waitFor();
  await page.evaluate(()=>{window.fixture.mode='hold';});
  await add.click();
  assert.equal(await page.getByRole('button',{name:'Adding',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.fixture.release();});
  await page.waitForFunction(()=>window.fixture.created.length===1);
  const calls=await page.evaluate(()=>window.fixture.calls.filter(call=>call.method==='POST'));
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0].body,calls[1].body);
  assert.equal(calls[0].route,'/api/bots/attach');
  assert.deepEqual(calls[0].body,{hostId:'host-a',nativeBotId:'native-a'});
  checks.push('retryUsesStableNativeIdentityAndPreventsDuplicateSubmit');
  await page.locator('#open-create-bot').click();
  await page.getByRole('radio').first().check();
  await add.click();
  await page.evaluate(()=>window.fixture.switchUser('@bob:test'));
  await page.waitForFunction(()=>window.fixture.calls.some(call=>call.route==='/api/bot-catalog' && call.userId==='@bob:test'));
  await page.evaluate(()=>window.fixture.release());
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.fixture.created.length),1);
  checks.push('lateAttachDoesNotPublishIntoAnotherAccount');
  await page.setViewportSize({width:390,height:844});
  const bounds=await page.locator('#create-bot-dialog').evaluate(element=>({width:element.getBoundingClientRect().width,scroll:element.scrollWidth,client:element.clientWidth}));
  assert.ok(bounds.width<=390 && bounds.scroll<=bounds.client+1);
  assert.deepEqual(pageErrors,[]);
  checks.push('mobileLayoutFitsAndHasNoBrowserErrors');
  report.status='passed';
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
