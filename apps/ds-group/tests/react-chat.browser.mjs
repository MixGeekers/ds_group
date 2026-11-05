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
      import { Composer } from '/src/components/Composer.tsx';
      import { Timeline } from '/src/components/Timeline.tsx';

      const session = { user_id: '@alice:test', access_token: 'synthetic' };
      const people = [
        { id: '@alice:test', name: 'Alice', kind: 'human' },
        { id: '@bob:test', name: 'Bob', kind: 'human' },
        { id: '@finance:test', name: 'Finance', kind: 'bot' },
      ];
      const roster = {
        members: people,
        roles: [{ id: 'team', name: 'Team', color: '#5865f2', memberIds: ['@bob:test'], mentionable: true }],
        canMentionEveryone: true,
        canMentionHere: true,
      };
      const rooms = [
        { roomId: '!one:test', name: 'One', kind: 'group', participantIds: people.map(person => person.id) },
        { roomId: '!two:test', name: 'Two', kind: 'group', participantIds: people.map(person => person.id) },
      ];
      window.sent = [];
      window.errors = [];
      window.reads = [];
      window.memberClicks = [];

      function Fixture() {
        const [room, setRoom] = React.useState(rooms[0]);
        const [reply, setReply] = React.useState(null);
        const [replyMention, setReplyMention] = React.useState(true);
        const [pending, setPending] = React.useState(null);
        const [sending, setSending] = React.useState(false);
        const [limits, setLimits] = React.useState(undefined);
        window.changeLimits = value => {
          setLimits(value);
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        };
        window.switchRoom = index => {
          setReply(null);
          setPending(null);
          setRoom(rooms[index]);
        };
        const events = [{
          event_id: '$greeting', room_id: room.roomId, sender: '@bob:test',
          type: 'm.room.message', origin_server_ts: Date.now(),
          content: {
            body: '<@@alice:test> hello **there**',
            'org.ds_group': {
              mentions: { users: ['@alice:test'], roles: [], everyone: false, here: false },
            },
          },
        }];
        return React.createElement('main', { className: 'conversation', style: { height: '100dvh' } },
          React.createElement(Timeline, {
            key: room.roomId, events, participants: people, session, mentionables: roster, roles: roster.roles,
            onMember: id => window.memberClicks.push(id),
            onReply: event => {
              setReply({ eventId: event.event_id, senderName: 'Bob', body: event.content.body });
              setReplyMention(true);
            },
            onJump: id => { window.jumped = id; },
            onRead: id => window.reads.push(id),
          }),
          React.createElement(Composer, {
            session, room, mentionables: roster, reply, replyMention,
            onReplyMention: setReplyMention,
            onClearReply: () => setReply(null),
            onRestoreReply: (target, mention) => { setReply(target); setReplyMention(mention); },
            sending, pending, limits,
            onError: message => window.errors.push(message),
            onSend: async message => {
              setSending(true);
              window.sent.push(message);
              await new Promise(resolve => setTimeout(resolve, 30));
              setSending(false);
              if (window.failNext) {
                window.failNext = false;
                setPending(message);
                return false;
              }
              setPending(null);
              return true;
            },
          }),
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script>
  </body>
</html>`;

const temporary = await mkdtemp(path.join(os.tmpdir(), 'ds-group-react-chat-'));
const server = await createServer({
  configFile: false,
  root: path.join(packageRoot, 'web'),
  cacheDir: path.join(temporary, 'vite-cache'),
  plugins: [tailwindcss(), {
    name: 'react-chat-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__chat', async (request, response, next) => {
        if (request.url.includes('html-proxy')) { next(); return; }
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__chat', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});

let browser;
const checks = [];
const pageErrors = [];
const screenshotDirectory = path.join(packageRoot, '.local', 'attachment-cards');
try {
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 900, height: 720 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('ds-group.language', 'en');
    localStorage.setItem('ds-group.theme', 'dark');
  });
  const uploads = [];
  let releasePendingUpload;
  const pendingUpload = new Promise(resolve => { releasePendingUpload = resolve; });
  let retryFailed = false;
  await page.route('**/api/attachments?*', async route => {
    const name = new URL(route.request().url()).searchParams.get('filename');
    uploads.push(name);
    if (name === 'pending-upload.txt') {
      await pendingUpload;
      try { return await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Cancelled fixture"}' }); }
      catch { return; }
    }
    if (name === 'retry.zip' && !retryFailed) {
      retryFailed = true;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic upload failure"}' });
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ attachment: {
        id: name === 'expenses.csv' ? 'file-one' : 'file-limits', name,
        mimeType: route.request().headers()['content-type'],
        size: route.request().postDataBuffer().length, sha256: 'fixture',
      } }),
    });
  });

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__chat`);
  await page.locator('#message-input[contenteditable="true"]').waitFor();
  assert.equal(await page.locator('.message.mentioned').count(), 1);
  await page.locator('.message .mention-tag').click();
  assert.deepEqual(await page.evaluate(() => window.memberClicks), ['@alice:test']);
  checks.push('reactTimelineRendersAndResolvesMentions');

  const editor = page.locator('#message-input');
  await editor.click();
  await editor.pressSequentially('@Bo');
  await page.locator('.mention-suggestion').first().waitFor();
  await editor.press('Enter');
  assert.equal(await page.locator('.mention-chip').count(), 1);
  assert.equal(await page.evaluate(() => window.sent.length), 0);
  await editor.pressSequentially('Hello');
  await editor.press('Enter');
  await page.waitForFunction(() => window.sent.length === 1 && document.querySelector('#message-input').textContent === '');
  assert.deepEqual(await page.evaluate(() => window.sent[0].mentions.users), ['@bob:test']);
  checks.push('atomicMentionSelectionAndSingleSubmission');

  await editor.pressSequentially('draft-one');
  await page.evaluate(() => window.switchRoom(1));
  await page.waitForFunction(() => document.querySelector('#message-input').textContent === '');
  await editor.pressSequentially('draft-two');
  await page.evaluate(() => window.switchRoom(0));
  await page.waitForFunction(() => document.querySelector('#message-input').textContent === 'draft-one');
  checks.push('roomSwitchPreservesIndependentDrafts');

  await page.locator('.message').first().hover();
  await page.locator('.message-action').first().click();
  await page.locator('#reply-preview').waitFor({ state: 'visible' });
  await page.locator('#reply-mention-toggle').click();
  await page.evaluate(() => window.switchRoom(1));
  await page.waitForFunction(() => document.querySelector('#message-input').textContent === 'draft-two');
  await page.evaluate(() => window.switchRoom(0));
  await page.waitForFunction(() => document.querySelector('#reply-preview-name').textContent === 'Bob');
  assert.equal(await page.locator('#reply-mention-toggle').getAttribute('aria-pressed'), 'false');
  checks.push('replyAndPingPreferenceRestoreWithRoom');

  await page.locator('#attachment-input').setInputFiles({
    name: 'expenses.csv', mimeType: 'text/csv', buffer: Buffer.from('department,total\nHR,200\n'),
  });
  await page.locator('.attachment-draft-ready').waitFor();
  await page.evaluate(async () => { (await import('/i18n.js')).setLocalePreference('zh-CN'); });
  await page.getByRole('button', { name: '添加附件', exact: true }).waitFor();
  assert.equal(await editor.textContent(), 'draft-one');
  assert.equal(await page.locator('.attachment-draft-ready').count(), 1);
  checks.push('localeSwitchPreservesDraftReplyAndUpload');

  await page.waitForTimeout(220);
  await page.reload();
  await page.locator('#message-input[contenteditable="true"]').waitFor();
  assert.equal(await editor.textContent(), 'draft-one');
  assert.equal(await page.locator('.attachment-draft-ready').count(), 1);
  assert.equal(await page.locator('#reply-mention-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#reply-preview').isVisible(), true);
  assert.equal(await page.locator('#reply-preview-name').textContent(), 'Bob');
  checks.push('reloadRestoresFileAndReplyDraft');

  await page.evaluate(() => { window.failNext = true; });
  await page.locator('#send-button').click();
  await page.waitForFunction(() => window.sent.length === 1 && document.querySelector('#message-input').getAttribute('contenteditable') === 'false');
  await page.waitForFunction(() => !document.querySelector('#send-button').disabled);
  await page.locator('#send-button').click();
  await page.waitForFunction(() => window.sent.length === 2 && document.querySelector('#message-input').textContent === '');
  const sent = await page.evaluate(() => window.sent);
  assert.equal(sent[0].transactionId, sent[1].transactionId);
  assert.deepEqual(sent[0].attachments, ['file-one']);
  assert.equal(sent[0].replyMention, false);
  checks.push('failedSendRetryRetainsTransactionAndAttachments');

  await page.setViewportSize({ width: 390, height: 844 });
  await editor.click();
  await editor.pressSequentially('@Bo');
  await page.locator('.mention-suggestion').first().click();
  assert.equal(await page.locator('.mention-chip').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push('mobileTouchMentionAndLayout');

  await editor.pressSequentially('keep this draft');
  const draftWithMention = await editor.textContent();
  const mentionToken = await page.locator('.mention-chip').getAttribute('data-mention-token');
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  await page.evaluate(() => window.changeLimits({ maxBytes: 4, maxPerMessage: 10 }));
  const limitedFile = { name: 'limits.txt', mimeType: 'text/plain', buffer: Buffer.from('12345678') };
  await page.locator('#attachment-input').setInputFiles(limitedFile);
  await page.waitForFunction(() => window.errors.length === 1);
  assert.match((await page.evaluate(() => window.errors))[0], /limits\.txt/);
  assert.equal(await page.locator('.attachment-draft').count(), 0);
  assert.deepEqual(uploads, ['expenses.csv']);
  assert.equal(await editor.textContent(), draftWithMention);
  assert.equal(await page.locator('.mention-chip').getAttribute('data-mention-token'), mentionToken);
  await page.evaluate(() => { window.errors = []; });

  await page.evaluate(() => window.changeLimits({ maxBytes: 16, maxPerMessage: 10 }));
  await page.locator('#attachment-input').setInputFiles(limitedFile);
  await page.locator('.attachment-draft-ready').waitFor();
  assert.deepEqual(uploads, ['expenses.csv', 'limits.txt']);
  assert.equal(await editor.textContent(), draftWithMention);
  assert.equal(await page.locator('.mention-chip').getAttribute('data-mention-token'), mentionToken);
  checks.push('dynamicUploadLimitsPreserveDraftAndMentionChips');

  await page.evaluate(async () => {
    (await import('/i18n.js')).setLocalePreference('en');
    window.DSGroupTheme.setPreference('light');
  });
  await page.getByRole('button', { name: 'Remove attachment limits.txt', exact: true }).click();
  await page.evaluate(() => window.changeLimits({ maxBytes: 1000000, maxPerMessage: 10 }));
  await page.setViewportSize({ width: 900, height: 720 });
  await page.locator('#attachment-input').setInputFiles([
    { name: 'pending-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('pending upload') },
    { name: 'retry.zip', mimeType: 'application/zip', buffer: Buffer.from('retry fixture') },
    { name: 'ready.csv', mimeType: 'text/csv', buffer: Buffer.from('ready,1') },
  ]);
  await page.locator('.attachment-draft-uploading').filter({ hasText: 'pending-upload.txt' }).waitFor();
  await page.locator('.attachment-draft-failed').waitFor();
  await page.locator('.attachment-draft-ready').waitFor();
  assert.equal(await page.locator('.attachment-upload-progress').count(), 1);
  assert.equal(await page.locator('.attachment-upload-progress').evaluate(element => element.hasAttribute('value')), false);
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  await mkdir(screenshotDirectory, { recursive: true });
  await page.locator('#composer-box').screenshot({ path: path.join(screenshotDirectory, 'upload-pending-failed-ready-light-en.png') });
  await page.getByRole('button', { name: 'Upload retry.zip again', exact: true }).click();
  await page.locator('.attachment-draft-ready .attachment-name').filter({ hasText: 'retry.zip' }).waitFor();
  await page.locator('#composer-box').screenshot({ path: path.join(screenshotDirectory, 'upload-retried-light-en.png') });
  await page.getByRole('button', { name: 'Cancel uploading pending-upload.txt', exact: true }).click();
  await page.locator('.attachment-draft-cancelled').waitFor();
  releasePendingUpload();
  await page.evaluate(async () => {
    (await import('/i18n.js')).setLocalePreference('zh-CN');
    window.DSGroupTheme.setPreference('dark');
  });
  await page.locator('.attachment-draft-cancelled .attachment-status').filter({ hasText: '已取消上传' }).waitFor();
  await page.locator('#composer-box').screenshot({ path: path.join(screenshotDirectory, 'upload-cancelled-dark-zh.png') });
  await page.getByRole('button', { name: '移除附件 retry.zip', exact: true }).click();
  assert.equal(await page.locator('.attachment-name').filter({ hasText: 'retry.zip' }).count(), 0);
  const longName = 'DSCord-跨服务器协作与独立身份设计方案-最终评审完整附件文件名称-2026-11-05.csv';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#attachment-input').setInputFiles({
    name: longName, mimeType: 'text/csv', buffer: Buffer.from('long,1'),
  });
  await page.locator('.attachment-draft-ready .attachment-name').filter({ hasText: longName }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.attachment-name').filter({ hasText: longName }).evaluate(element =>
    element.scrollHeight <= element.clientHeight + 1), true);
  await page.locator('#composer-box').screenshot({ path: path.join(screenshotDirectory, 'upload-long-mobile-dark-zh.png') });
  checks.push('uploadCardsShowIndeterminateProgressRetryCancelReadyRemoveAndMobileLongName');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  await mkdir(path.join(packageRoot, '.local'), { recursive: true });
  await writeFile(path.join(packageRoot, '.local/react-chat-browser.json'), JSON.stringify({
    status: 'passed', level: 'real-chromium-react-chat-fixture', checks, modelCalls: 0, pageErrors,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks }));
} finally {
  await browser?.close();
  await server.close();
  await rm(temporary, { recursive: true, force: true });
}
