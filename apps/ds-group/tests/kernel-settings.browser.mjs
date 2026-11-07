import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { packageRoot } from '../src/paths.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dscord-kernel-ui-'));
const output = path.join(packageRoot, '.local/kernel-settings-browser');
await mkdir(output, { recursive: true });
const checks = [];
const errors = [];
const report = { status: 'failed', level: 'real-chromium-component-and-dsh-client-fixture', modelCalls: 0, checks, errors, screenshots: [] };
const style = `<meta name="viewport" content="width=device-width, initial-scale=1"><script src="/theme.js"></script><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/@fs/${packageRoot}/ui/tailwind.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/@fs/${packageRoot}/ui/styles.css">`;
const webHtml = `<!doctype html><html><head>${style}</head><body><div id="root"></div><script type="module">
  import React from 'react'; import { createRoot } from 'react-dom/client';
  import { MyBotsDialog } from '/src/components/MyBotsDialog.tsx';
  import { MemberDialog } from '/src/components/BasicDialogs.tsx';
  import { setLocalePreference } from '/i18n.js';
  const owner = {id:'@alice:home.test',name:'Alice',kind:'human'};
  const bot = {id:'@helper:home.test',name:'Shiyu',kind:'bot',ownerId:owner.id,nativeBinding:{hostId:'node-a',nativeBotId:'local-shiyu',botId:'@helper:home.test'}};
  const person = {id:'@bob:home.test',name:'Bob',kind:'human'};
  const room = {roomId:'!project:home.test',name:'Garden project',kind:'group',participantIds:[owner.id,bot.id,person.id]};
  const fixture = window.fixture = {calls:[],offline:false,failSave:false,direct:[],mode:'natural',desired:null};
  const source = {id:'source-2',revision:2,authorId:person.id,authorKind:'human',eventId:'$updated-plan',roomId:room.roomId,timestamp:1793898000000};
  const claim = {id:'claim-1',revision:2,text:'Bob proposed planting herbs on Saturday.',claimState:'proposal',kind:'reported',saidBy:owner.id,scope:'room:'+room.roomId,sources:[source],sourceRefs:[{id:source.id,revision:2}],conflicts:['claim-conflicting-date']};
  const api = async (route, options={}) => {
    fixture.calls.push({route,method:options.method,body:options.body});
    if(route.endsWith('/kernel')) return {runtime:{id:'dscord-kernel',version:'0.4.0',available:!fixture.offline},online:!fixture.offline,updatedAt:Date.now(),desiredAttention:fixture.desired,attention:fixture.offline?null:{mode:fixture.mode,activity:'waiting',provider:{configured:true,available:null,health:'unknown',model:'participation-model'},queue:{pending:2,waiting:1,evaluating:0,errors:0}},work:{status:fixture.offline?null:'waiting',activeTasks:fixture.offline?null:0,waiting:fixture.offline?null:1},memorySummary:{people:1,projects:1,pendingReview:0}};
    if(route.endsWith('/attention')) {if(fixture.failSave)throw new Error('Synthetic uncertain save'); fixture.desired={mode:options.body.mode,revision:1,status:'pending',applied:false,online:!fixture.offline};return fixture.desired;}
    if(route.includes('/memory/profile')) {
      if(fixture.holdMemory) await new Promise(resolve=>{fixture.releaseMemory=resolve;});
      const query=new URL(route,'http://fixture.test').searchParams;
      const kind=query.get('kind');const id=query.get('id');
      if(!id)return {kind,items:[{id:kind==='person'?person.id:'project:garden',name:kind==='person'?'Bob':'Garden',kind,currentCount:1,historyCount:1,scopes:['room:'+room.roomId]}],more:false};
      return {kind,id,identity:{id,name:kind==='person'?'Bob':'Garden',kind},view:{currentClaims:[claim],preferences:[],projectFacts:[],changes:[{...claim,id:'claim-old',text:'The old draft said Friday.',claimState:'statement',kind:'legacy',derivation:'superseded',conflicts:[]}],recentSources:[source],historyGaps:[]}};
    }
    throw new Error('Unexpected fixture route '+route);
  };
  function Fixture(){const [open,setOpen]=React.useState(true);const [member,setMember]=React.useState(null);const [user,setUser]=React.useState(owner.id);const [selected,setSelected]=React.useState(null);
    fixture.locale=setLocalePreference;fixture.switchUser=setUser;
    const session={user_id:user,access_token:'synthetic-token'};
    return React.createElement(React.Fragment,null,
      React.createElement('button',{id:'open-profile',onClick:()=>setMember(bot)},'Profile'),
      React.createElement('button',{id:'open-bots',onClick:()=>{setSelected(null);setOpen(true);}},'Bots'),
      React.createElement(MyBotsDialog,{open,bots:[bot],status:{nodes:[{id:'n',botId:bot.id,name:bot.name,status:'waiting'}]},session,api,rooms:[room],participants:[owner,person,bot],initialBotId:selected,onClose:()=>setOpen(false),onCreate:()=>{},onDirect:id=>fixture.direct.push(id)}),
      React.createElement(MemberDialog,{member,session,room,roles:[],botStatus:'waiting',owner,onClose:()=>setMember(null),onDirect:()=>{},onMention:()=>{},onManageBot:id=>{setMember(null);setSelected(id);setOpen(true);}}));
  }createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const dshHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;height:100dvh"><div id="root" style="height:100%"></div><script type="module">
  import React from 'react';import {createRoot} from 'react-dom/client';
  let descriptor;window.__ModuleLoader__={load:value=>{descriptor=value;}};
  await import('/@fs/${packageRoot}/dsh-connect/client.js');
  const listeners=new Set();const dictionaries=new Map();let language='en';let main;const cleanup=[];
  const locale={register:(id,value)=>{dictionaries.set(id,value);},bind:id=>(key,params={})=>{const text=dictionaries.get(id)?.[language]?.[key]||key;return text.replace(/\\{(\\w+)\\}/g,(m,k)=>params[k]??m);}};
  function Button({variant,...props}){return React.createElement('button',props);}
  const plugin=descriptor.factory(name=>name==='react'?React:name==='react-dom'?{createPortal:element=>element}:{Button,Input:'input',IconPluginPinwheelOutlineRegular:()=>null});
  plugin.apply({locale,effect:fn=>cleanup.push(fn()),slots:{inject:(_n,fn)=>fn(),register:(options,component)=>{if(options.name==='main')main={options,component};return ()=>{};}},layout:{selectPanel:()=>{}}});
  const root=createRoot(document.getElementById('root'));const connection=main.options.inject().connection;
  window.fixture={connection,locale:value=>{language=value;render();}};
  function render(){root.render(React.createElement(main.component,{connection,t:locale.bind(main.options.locale)}));}render();
</script></body></html>`;

const server = await createServer({
  configFile: false, root: path.join(packageRoot, 'web'), cacheDir: path.join(temporary, 'vite-cache'), plugins: [tailwindcss(), {
    name: 'kernel-settings-fixture', configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const route = request.url.split('?')[0];
        if (!['/__kernel', '/__native'].includes(route) || request.url.includes('html-proxy')) return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml(route, route === '/__kernel' ? webHtml : dshHtml));
      });
    },
  }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error',
});
let browser;
let page;
async function screenshot(name) { const filename = path.join(output, name); await page.screenshot({ path: filename }); report.screenshots.push(filename); }
async function fits(selector) {
  const bounds = await page.locator(selector).evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, scroll: element.scrollWidth, client: element.clientWidth, viewport: innerWidth, top: r.top, bottom: r.bottom, height: innerHeight }; });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport + 1 && bounds.scroll <= bounds.client + 1 && bounds.top >= 0 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds));
}
try {
  await server.listen(); browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1120, height: 850 }, locale: 'en-US' });
  context.setDefaultTimeout(10000);
  await context.addInitScript(() => { localStorage.setItem('ds-group.language', 'en'); localStorage.setItem('ds-group.theme', 'dark'); });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.goto(`${origin}/__kernel`);
  await page.locator('[data-bot-settings-button]').click();
  await page.locator('[data-activity="waiting"]').waitFor();
  assert.match(await page.locator('[data-bot-panel="overview"]').innerText(), /Alice/);
  assert.match(await page.locator('[data-bot-panel="overview"]').innerText(), /normal state/);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.match(await page.locator('.bot-settings-identity').innerText(), /@helper:home.test/);
  checks.push('stableBotAndOwnerIdentityWithWaitingAsNormalActivity');
  await screenshot('bot-overview-dark-en.png');
  await page.getByRole('button', { name: 'Participation', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: /Join naturally/ }).isChecked(), true);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.getByRole('radio', { name: /Observe quietly/ }).check();
  await page.locator('#save-bot-participation').click();
  await page.getByRole('status').filter({ hasText: 'Saved. The node' }).first().waitFor();
  assert.equal(await page.locator('#save-bot-participation').isDisabled(), true);
  const patch = await page.evaluate(() => window.fixture.calls.find(call => call.method === 'PATCH'));
  assert.deepEqual(patch.body, { mode: 'shadow' });
  assert.equal(patch.route, '/api/bots/%40helper%3Ahome.test/attention');
  checks.push('ownerModeSaveUsesRealContractAndKeepsPendingDistinctFromApplied');
  await page.locator('.bot-settings-content').evaluate(element => { element.scrollTop = 0; });
  await screenshot('bot-participation-dark-en.png');
  await page.evaluate(() => { window.fixture.failSave = true; });
  await page.getByRole('radio', { name: /When mentioned/ }).check();
  await page.locator('#save-bot-participation').click();
  await page.getByRole('status').filter({ hasText: 'not confirmed' }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /When mentioned/ }).isDisabled(), true);
  checks.push('uncertainSaveLocksFurtherWritesUntilRefreshed');
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.locator('[data-memory-profile="@bob:home.test"]').click();
  await page.locator('[data-memory-record="claim-1"]').waitFor();
  const record = page.locator('[data-memory-record="claim-1"]');
  assert.match(await record.innerText(), /Proposal/); assert.match(await record.innerText(), /Reported by someone else/); assert.match(await record.innerText(), /Unresolved conflict/);
  await record.locator('summary').click();
  assert.match(await record.innerText(), /Bob/); assert.match(await record.innerText(), /Garden project/); assert.match(await record.innerText(), /\$updated-plan/);
  assert.match(await page.locator('.bot-memory-profile').innerText(), /not presented as current facts/);
  checks.push('memoryKeepsOriginalSourcesReportedClaimsConflictsAndHistoricalChanges');
  await screenshot('bot-memory-dark-en.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.fixture.locale('zh-CN'); window.DSGroupTheme.setPreference('light'); });
  await page.getByRole('button', { name: '参与方式', exact: true }).waitFor();
  await fits('#my-bots-dialog');
  await screenshot('bot-memory-light-zh-mobile.png');
  checks.push('mobileLightThemeAndChineseKeepDialogInsideViewport');
  await page.getByRole('button', { name: '概览', exact: true }).click();
  await page.evaluate(() => { window.fixture.offline = true; window.fixture.failSave = false; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator('[data-activity="unknown"]').waitFor();
  assert.match(await page.locator('[data-bot-panel="overview"]').innerText(), /离线/);
  await page.getByRole('button', { name: '参与方式', exact: true }).click();
  await page.getByRole('radio', { name: /自然参与/ }).check();
  await page.locator('#save-bot-participation').click();
  await page.getByRole('status').filter({ hasText: '下次同步' }).first().waitFor();
  checks.push('offlineActivityStaysUnknownAndDesiredModeCanBeSaved');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('#open-profile').click();
  assert.match(await page.locator('.bot-profile-owner').innerText(), /Alice/);
  await page.locator('#member-bot-settings').click();
  await page.locator('[data-bot-settings]').waitFor();
  checks.push('memberProfileShowsOwnerAndOpensOwnedBotSettings');
  await page.getByRole('navigation', { name: 'Bot 设置' }).getByRole('button', { name: '记忆', exact: true }).click();
  await page.evaluate(() => { window.fixture.holdMemory = true; });
  await page.locator('[data-memory-profile]').click();
  await page.waitForFunction(() => !!window.fixture.releaseMemory);
  await page.evaluate(() => { window.fixture.switchUser('@bob:home.test'); window.fixture.releaseMemory(); });
  await page.locator('[data-bot-settings]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-memory-record]').count(), 0);
  checks.push('lateMemoryReadCannotPublishIntoAnotherOwnersAccount');

  const nativeState = { serverUrl: 'https://chat.example.test', user: { id: '@alice:home.test', name: 'Alice' }, bots: [], nativeBots: [], nativeMode: true, hostId: 'node-a', runtime: { available: true }, models: { available: true, defaultSelection: { model: 'local/chat' }, providers: [{ id: 'local', name: 'Local', models: [{ model: 'local/chat', name: 'Local chat', needsKey: false }] }] } };
  const nativeRequests = [];
  let nativeMode = 'mention';
  let keySubmitted = false;
  let creationReceiptLost = false;
  const creations = new Map();
  await page.route('**/api/dscord', async route => {
    const body = route.request().postDataJSON(); nativeRequests.push({ ...body, ...(body.apiKey ? { apiKey: '[redacted synthetic test key]' } : {}) });
    let value;
    if (body.action === 'status') value = nativeState;
    else if (body.action === 'create-native') {
      if (!creations.has(body.requestId)) {
        const created = { id: 'local-shiyu', name: body.name, role: body.role, model: body.model };
        nativeState.nativeBots.push(created); creations.set(body.requestId, created);
      }
      if (!creationReceiptLost) { creationReceiptLost = true; await route.fulfill({ json: { ok: false, error: { message: 'Synthetic creation receipt lost' } } }); return; }
      value = nativeState;
    }
    else if (body.action === 'kernel-state') value = { runtime: { id: 'dscord-kernel', available: true }, decisionProvider: { configured: keySubmitted, available: keySubmitted, model: 'participation-model' }, ...(body.nativeBotId ? { attention: { mode: nativeMode, activity: 'listening', provider: { configured: keySubmitted, available: keySubmitted } }, work: { activeTasks: 0, waiting: 0 }, memorySummary: { people: 1, projects: 0, pendingReview: 0 } } : {}) };
    else if (body.action === 'attention-update') { nativeMode = body.mode; value = { mode: nativeMode, status: 'applied' }; }
    else if (body.action === 'save-decision-provider') { assert.equal(body.apiKey, 'synthetic-decision-key'); keySubmitted = true; value = { configured: true, available: true, model: 'participation-model' }; }
    else if (body.action === 'memory-profile') value = body.id ? { kind: body.kind, id: body.id, identity: { id: body.id, name: 'Bob' }, view: { currentClaims: [{ id: 'native-claim', text: 'Bob prefers herbs.', claimState: 'statement', kind: 'stated', sources: [{ id: 's', authorId: '@bob:home.test', roomId: '!project:home.test', eventId: '$source' }] }] } } : { kind: body.kind, items: [{ id: '@bob:home.test', name: 'Bob' }], more: false };
    else throw new Error('Unexpected native fixture action ' + body.action);
    await route.fulfill({ json: { ok: true, value } });
  });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${origin}/__native`);
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
  await page.getByText('There are no Bots on this node yet. Create one here.', { exact: true }).waitFor();
  await page.getByText('Create Bot', { exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Shiyu');
  await page.getByLabel('Role or introduction').fill('A friend and project partner');
  await page.getByRole('button', { name: 'Create on this node' }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic creation receipt lost' }).waitFor();
  await page.getByRole('button', { name: 'Confirm same creation' }).click();
  await page.getByText('Bot created. You can now add it to the server.', { exact: true }).waitFor();
  const creationRequests = nativeRequests.filter(item => item.action === 'create-native');
  assert.equal(creationRequests.length, 2); assert.deepEqual(creationRequests[0], creationRequests[1]);
  assert.ok(typeof creationRequests[0].requestId === 'string' && creationRequests[0].requestId.length > 10);
  assert.deepEqual({ ...creationRequests[0], requestId: '[stable request]' }, { action: 'create-native', name: 'Shiyu', role: 'A friend and project partner', model: 'local/chat', requestId: '[stable request]' });
  assert.equal(nativeState.nativeBots.length, 1);
  checks.push('dshCreatesLocalBotWithChosenModelAndConfirmsSameRequestAfterLostReceipt');
  await page.getByRole('button', { name: 'Bot settings', exact: true }).click();
  await page.getByRole('radio', { name: /Join naturally/ }).check();
  await page.getByRole('button', { name: 'Save participation', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Participation saved' }).waitFor();
  assert.equal(nativeRequests.find(item => item.action === 'attention-update').nativeBotId, 'local-shiyu');
  await page.getByRole('button', { name: 'Bob', exact: true }).click();
  await page.getByText('Bob prefers herbs.', { exact: true }).waitFor();
  checks.push('dshLocalModeAndMemoryUseStableNativeBotIdentity');
  await page.getByText('Participation service', { exact: true }).click();
  await page.getByLabel('Decision service API key', { exact: true }).fill('synthetic-decision-key');
  await page.getByRole('button', { name: 'Save participation service', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Participation service saved' }).waitFor();
  assert.equal(await page.getByLabel('Decision service API key', { exact: true }).inputValue(), '');
  assert.equal(await page.evaluate(() => JSON.stringify(window.fixture.connection.getSnapshot()).includes('synthetic-decision-key')), false);
  assert.equal((await page.locator('body').innerText()).includes('synthetic-decision-key'), false);
  checks.push('decisionCredentialIsSubmitOnlyAndNeverReadBackOrStoredInConnectionSnapshot');
  await screenshot('local-decision-private-dark-en.png');
  await page.locator('.dscord-connect').evaluate(element => { element.scrollTop = 0; });
  await screenshot('local-kernel-dark-en.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.fixture.locale('zh'); document.body.removeAttribute('data-ds-dark-theme'); });
  const nativeBounds = await page.locator('.dscord-connect').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  assert.ok(nativeBounds.scroll <= nativeBounds.client + 1);
  await screenshot('local-kernel-light-zh-mobile.png');
  assert.deepEqual(errors, []);
  checks.push('dshNativeSettingsRenderInChineseOnMobileWithoutOverflowOrBrowserErrors');
  report.status = 'passed';
} catch (error) {
  report.error = error.stack ?? String(error);
  if (page) await screenshot('failure.png').catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await server.close(); await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
