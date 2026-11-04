import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { packageRoot } from '../src/paths.mjs';

const fixture = `<!doctype html><html><meta charset="utf-8"><style>
body { margin:20px; background:#313338; color:#fff; font:16px sans-serif; }
#editor { margin-top:250px; border:1px solid #aaa; min-height:64px; padding:12px; white-space:pre-wrap; }
.mention-chip { background:#414675; color:#ccd1ff; }
.mention-popup { overflow:auto; background:#222; z-index:10; }
.mention-popup[hidden] { display:none; }
.mention-suggestion { padding:8px; display:flex; gap:8px; }
.mention-suggestion.selected { background:#555; }
</style><div id="editor" aria-label="消息"></div><div id="popup"></div><script type="module">
import { createMentionEditor } from '/web/mention-editor.js';
window.roster = { members:[
{id:'@alice:example.test',name:'Alice',localpart:'alice',kind:'human',online:true},
{id:'@bob:example.test',name:'Bob',localpart:'bob',kind:'human'},
{id:'@finance:example.test',name:'小雨 · 财务',localpart:'finance',kind:'bot',status:'idle'}],
roles:[{id:'finance-team',name:'财务组',mentionable:true,color:'#12abef'}],canMentionEveryone:true,canMentionHere:true };
window.submits=[];window.uploads=[];window.changes=[];
window.editor=createMentionEditor({element:document.querySelector('#editor'),popup:document.querySelector('#popup'),
getMentionables:()=>window.roster,onSubmit:value=>window.submits.push(value),onChange:value=>window.changes.push(value),
onFiles:files=>window.uploads.push(...files.map(file=>file.name))});
window.editor.setPlaceholder('发送消息');
</script></html>`;

const server = createServer(async (request, response) => {
  if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixture); return; }
  if (!['/web/mention-editor.js', '/web/mention-tokens.js'].includes(request.url)) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  response.end(await readFile(path.join(packageRoot, request.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const report = { level: 'real-chromium-composer-fixture', checks: [], modelCalls: 0, status: 'failed' };
const reportPath = process.env.DS_GROUP_MENTION_REPORT || path.join(packageRoot, '.local', 'mention-editor-browser.json');
async function check(name, operation) { await operation(); report.checks.push(name); }
async function setBody(body) {
  await page.evaluate(value => { window.editor.setValue(value); window.editor.focus(); }, body);
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => Boolean(window.editor));
  const input = page.locator('#editor');
  await check('memberSearchAndKeyboardSelection', async () => {
    await input.fill('@fin');
    await page.waitForFunction(() => !document.querySelector('#popup').hidden);
    assert.equal(await page.locator('#popup [role=option]').first().locator('.mention-suggestion-name').innerText(), '小雨 · 财务');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue()), {
      body: '<@@finance:example.test> ', mentions: { users: ['@finance:example.test'], roles: [], everyone: false, here: false },
    });
    assert.equal(await input.locator('[contenteditable=false]').innerText(), '@小雨 · 财务');
    assert.equal(await page.evaluate(() => window.submits.length), 0);
    await page.keyboard.type('请计算');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.submits.at(-1).body), '<@@finance:example.test> 请计算');
  });
  await check('arrowNavigationTabAndEscape', async () => {
    await input.fill('@');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue().mentions.users), ['@bob:example.test']);
    await input.fill('@fin');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#popup').isHidden(), true);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.submits.at(-1).mentions.users), []);
  });
  await check('roleAndGroupMentions', async () => {
    await input.fill('@财务组');
    await page.keyboard.press('Tab');
    assert.deepEqual(await page.evaluate(() => window.editor.getValue().mentions.roles), ['finance-team']);
    await input.fill('@here');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.editor.getValue().mentions.here), true);
    await input.fill('@everyone');
    await page.locator('#popup [role=option]').click();
    assert.equal(await page.evaluate(() => window.editor.getValue().mentions.everyone), true);
  });
  await check('atomicDeletionUndoRedoAndCaretInsertion', async () => {
    await setBody('<@@finance:example.test>');
    await page.keyboard.press('Backspace');
    assert.equal(await page.evaluate(() => window.editor.getValue().body), '');
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal(await page.evaluate(() => window.editor.getValue().body), '<@@finance:example.test>');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    assert.equal(await page.evaluate(() => window.editor.getValue().body), '');
    await setBody('前文 后文');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('@fin');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => window.editor.getValue().body), '前文 <@@finance:example.test> 后文');
  });
  await check('imeAndCodeEscapesDoNotSubmitOrMention', async () => {
    const before = await page.evaluate(() => window.submits.length);
    await input.fill('@fin');
    await page.evaluate(() => {
      const node = document.querySelector('#editor');
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.submits.length), before);
    for (const text of ['mail@fin', '`@fin', '\\@fin', '```\n@fin']) {
      await input.fill(text);
      assert.equal(await page.locator('#popup').isHidden(), true, text);
      assert.deepEqual(await page.evaluate(() => window.editor.getValue().mentions.users), []);
    }
  });
  await check('copyPasteRetainsIdentityAndStripsHtml', async () => {
    await setBody('<@@finance:example.test> 财务');
    const clipboard = await page.evaluate(() => {
      const node = document.querySelector('#editor');
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer();
      node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return { plain: data.getData('text/plain'), canonical: data.getData('application/x-ds-group-message') };
    });
    assert.equal(clipboard.plain, '@小雨 · 财务 财务');
    assert.equal(clipboard.canonical, '<@@finance:example.test> 财务');
    await setBody('');
    await page.evaluate(value => {
      const data = new DataTransfer(); data.setData('text/plain', value.plain); data.setData('application/x-ds-group-message', value.canonical);
      data.setData('text/html', '<img src=x onerror="window.bad=true">');
      document.querySelector('#editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, clipboard);
    assert.equal(await page.evaluate(() => window.editor.getValue().body), clipboard.canonical);
    assert.equal(await input.locator('img').count(), 0);
    await page.evaluate(() => {
      const data = new DataTransfer(); data.setData('text/plain', ' 普通文字'); data.setData('text/html', '<img src=x onerror="window.bad=true">');
      document.querySelector('#editor').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    assert.equal(await input.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.editor.getValue().body), clipboard.canonical + ' 普通文字');
  });
  await check('pasteFileAndMultilineSubmission', async () => {
    await setBody('第一行');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('第二行');
    assert.equal(await page.evaluate(() => window.editor.getValue().body), '第一行\n第二行');
    await page.evaluate(() => {
      const data = new DataTransfer(); data.items.add(new File(['synthetic'], 'paste.png', { type: 'image/png' }));
      document.querySelector('#editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    assert.deepEqual(await page.evaluate(() => window.uploads), ['paste.png']);
  });
  await check('mobileTouchSelectionAndDisabledState', async () => {
    await page.setViewportSize({ width: 390, height: 700 });
    await input.fill('@fin');
    const bounds = await page.locator('#popup').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    await page.locator('#popup [role=option]').first().dispatchEvent('pointerdown', { pointerType: 'touch', bubbles: true });
    assert.deepEqual(await page.evaluate(() => window.editor.getValue().mentions.users), ['@finance:example.test']);
    await page.evaluate(() => window.editor.setDisabled(true));
    assert.equal(await input.getAttribute('contenteditable'), 'false');
    assert.equal(await input.getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('#popup').isHidden(), true);
  });
  assert.deepEqual(errors, []);
  report.status = 'passed';
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  report.browserErrors = errors;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify(report, null, 2));
}
