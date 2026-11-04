import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { packageRoot } from '../src/paths.mjs';

const people = [
  { id: '@alice:test', localpart: 'alice', name: 'Alice', kind: 'human' },
  { id: '@bob:test', localpart: 'bob', name: 'Bob', kind: 'human' },
];
const rooms = [
  { roomId: '!one:test', name: 'One', kind: 'group', participantIds: people.map(person => person.id) },
  { roomId: '!two:test', name: 'Two', kind: 'group', participantIds: people.map(person => person.id) },
];
const bootstrap = {
  name: 'DS-Group',
  roomId: rooms[0].roomId,
  roomName: rooms[0].name,
  participants: people,
  demoLogin: true,
  attachments: { maxBytes: 52428800, maxPerMessage: 10 },
};
const sessions = {
  alice: { user_id: people[0].id, access_token: 'alice-fixture' },
  bob: { user_id: people[1].id, access_token: 'bob-fixture' },
};
const pendingMessage = {
  body: 'Alice pending in One',
  mentions: { users: [], roles: [], everyone: false, here: false },
  attachments: [],
  transactionId: 'already-submitted-one',
};
const aliceTwoDraft = {
  body: 'Independent Alice draft Two',
  attachments: [],
  replyMention: true,
};
const bobOneDraft = {
  body: 'Bob private draft One',
  attachments: [],
  replyMention: true,
};
const alicePendingKey = `ds-group.pending.${sessions.alice.user_id}.${rooms[0].roomId}`;
const aliceTwoDraftKey = `ds-group.draft.${sessions.alice.user_id}.${rooms[1].roomId}`;
const bobOneDraftKey = `ds-group.draft.${sessions.bob.user_id}.${rooms[0].roomId}`;

const html = `<!doctype html>
<html>
  <head>
    <script src="/theme.js"></script>
    <link rel="stylesheet" href="/tokens.css">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import App from '/src/App.tsx';
      createRoot(document.getElementById('root')).render(React.createElement(App));
    </script>
  </body>
</html>`;

const temporary = await mkdtemp(path.join(os.tmpdir(), 'ds-group-react-app-'));
const server = await createServer({
  configFile: false,
  root: path.join(packageRoot, 'web'),
  cacheDir: path.join(temporary, 'vite-cache'),
  plugins: [{
    name: 'react-app-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__app', async (request, response, next) => {
        if (request.url.includes('html-proxy')) {
          next();
          return;
        }
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__app', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});

const checks = [];
const pageErrors = [];
const unhandledRequests = [];
const sentMessages = [];
let apiRequestCount = 0;
let browser;
let page;
let failure;

try {
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  context.setDefaultTimeout(15000);
  await context.addInitScript((seed) => {
    localStorage.setItem('ds-group.language', 'en');
    localStorage.setItem('ds-group.theme', 'dark');
    const stored = {
      'ds-group.session': seed.sessions.alice,
      'ds-group.workspace': seed.bootstrap,
      [`ds-group.rooms.${seed.sessions.alice.user_id}`]: seed.rooms,
      [`ds-group.rooms.${seed.sessions.bob.user_id}`]: seed.rooms,
      [`ds-group.room.${seed.sessions.alice.user_id}`]: seed.rooms[0].roomId,
      [seed.alicePendingKey]: seed.pendingMessage,
      [seed.aliceTwoDraftKey]: seed.aliceTwoDraft,
      [seed.bobOneDraftKey]: seed.bobOneDraft,
    };
    for (const [key, value] of Object.entries(stored)) {
      sessionStorage.setItem(key, JSON.stringify(value));
    }
    if ('serviceWorker' in navigator) {
      Object.defineProperty(navigator.serviceWorker, 'register', {
        configurable: true,
        value: async () => ({
          active: {},
          pushManager: { getSubscription: async () => null },
        }),
      });
    }
  }, {
    sessions, bootstrap, rooms, pendingMessage, aliceTwoDraft, bobOneDraft,
    alicePendingKey, aliceTwoDraftKey, bobOneDraftKey,
  });

  const responses = new Map([
    ['GET /api/bootstrap', bootstrap],
    ['GET /api/status', { nodes: [], core: { roomId: rooms[0].roomId }, budget: { used: 0, limit: null } }],
    ['GET /api/rooms', { rooms }],
    ['GET /api/bots', { bots: [] }],
    ['GET /api/inbox?filter=mentions&limit=1', { events: [], unreadCount: 0, mentionCount: 0 }],
    ['GET /api/roles', { roles: [], canManage: true }],
    ['GET /api/push/config', { enabled: false }],
    ['POST /api/presence', { accepted: true }],
    ['GET /api/demo-login?user=alice', sessions.alice],
    ['GET /api/demo-login?user=bob', sessions.bob],
  ]);
  for (const room of rooms) {
    const base = `/api/rooms/${encodeURIComponent(room.roomId)}`;
    responses.set(`GET ${base}/messages?limit=200`, { events: [] });
    responses.set(`GET ${base}/tasks`, { tasks: [] });
    responses.set(`POST ${base}/read`, { read: true });
    responses.set(`GET ${base}/mentionables`, {
      members: people,
      roles: [],
      canMentionEveryone: true,
      canMentionHere: true,
    });
  }

  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}${url.search}`;
    apiRequestCount++;
    let body;
    let status = 200;
    if (key === `POST /api/rooms/${encodeURIComponent(rooms[0].roomId)}/messages`) {
      sentMessages.push({
        roomId: rooms[0].roomId,
        authorization: request.headers().authorization,
        body: request.postDataJSON(),
      });
      status = sentMessages.length === 1 ? 503 : 200;
      body = status === 503
        ? { error: 'Synthetic temporarily unavailable' }
        : { event_id: '$confirmed-fixture-send' };
    } else if (responses.has(key)) {
      body = responses.get(key);
    } else {
      unhandledRequests.push(key);
      status = 501;
      body = { error: `Unhandled fixture request ${key}` };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__app`);
  const editor = page.locator('#message-input');
  const sendButton = page.locator('#send-button');
  async function expectEditor(body, editable) {
    await page.waitForFunction(({ body, editable }) => {
      const input = document.querySelector('#message-input');
      return input?.textContent === body && input.getAttribute('contenteditable') === String(editable);
    }, { body, editable });
  }
  async function readStorage(key) {
    return page.evaluate(storageKey => JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'), key);
  }
  async function switchAccount(localpart, displayName) {
    await page.locator('#identity-button').click();
    await page.locator('#login-dialog[open]').waitFor();
    await page.locator('#login-user').selectOption(localpart);
    await page.locator('#login-submit').click();
    await page.waitForFunction(name => document.querySelector('#current-name')?.textContent === name, displayName);
    await page.locator('#login-dialog').waitFor({ state: 'hidden' });
  }

  await expectEditor(pendingMessage.body, false);
  assert.equal(await sendButton.isEnabled(), true);
  assert.equal(await page.locator('#send-button-text').textContent(), 'Retry sending');
  assert.deepEqual(await readStorage(alicePendingKey), pendingMessage);
  checks.push('appRestoresPendingMessageForInitialAccountAndRoom');

  await page.locator('#additional-rooms button').filter({ hasText: 'Two' }).click();
  await expectEditor(aliceTwoDraft.body, true);
  assert.equal(await page.locator('#room-title').textContent(), 'Two');
  assert.equal(await sendButton.isEnabled(), true);
  assert.equal(await page.locator('#send-button-text').textContent(), 'Send');
  await page.waitForTimeout(220);
  assert.equal((await readStorage(aliceTwoDraftKey)).body, aliceTwoDraft.body);
  assert.deepEqual(await readStorage(alicePendingKey), pendingMessage);
  checks.push('roomSwitchDoesNotApplyPreviousPendingMessageToIndependentDraft');

  await page.locator('#group-room-button').click();
  await expectEditor(pendingMessage.body, false);
  assert.equal(await page.locator('#room-title').textContent(), 'One');
  assert.equal(await page.locator('#send-button-text').textContent(), 'Retry sending');
  assert.equal((await readStorage(aliceTwoDraftKey)).body, aliceTwoDraft.body);
  checks.push('returningToPendingRoomRestoresReadonlyRetryState');

  await switchAccount('bob', 'Bob');
  await expectEditor(bobOneDraft.body, true);
  assert.equal(await page.locator('#send-button-text').textContent(), 'Send');
  await page.waitForTimeout(220);
  assert.equal((await readStorage(bobOneDraftKey)).body, bobOneDraft.body);
  assert.deepEqual(await readStorage(alicePendingKey), pendingMessage);
  checks.push('accountSwitchDoesNotApplyAlicePendingMessageToBobDraft');

  await switchAccount('alice', 'Alice');
  await expectEditor(pendingMessage.body, false);
  assert.equal(await page.locator('#send-button-text').textContent(), 'Retry sending');
  assert.equal((await readStorage(bobOneDraftKey)).body, bobOneDraft.body);
  checks.push('returningToAliceRestoresOnlyAlicePendingMessage');

  await sendButton.click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Synthetic temporarily unavailable'));
  await expectEditor(pendingMessage.body, false);
  assert.equal(sentMessages.length, 1);
  assert.equal(await sendButton.isEnabled(), true);
  assert.deepEqual(await readStorage(alicePendingKey), pendingMessage);
  checks.push('unconfirmedSendRemainsPendingAfterServerFailure');

  await sendButton.click();
  await expectEditor('', true);
  assert.equal(sentMessages.length, 2);
  assert.deepEqual(sentMessages, Array.from({ length: 2 }, () => ({
    roomId: rooms[0].roomId,
    authorization: `Bearer ${sessions.alice.access_token}`,
    body: pendingMessage,
  })));
  assert.equal(await readStorage(alicePendingKey), null);
  assert.equal((await readStorage(aliceTwoDraftKey)).body, aliceTwoDraft.body);
  assert.equal((await readStorage(bobOneDraftKey)).body, bobOneDraft.body);
  assert.equal(await editor.textContent(), '');
  checks.push('retryReusesOriginalTransactionAndClearsOnlyConfirmedAccountRoom');

  const currentRoomBase = `/api/rooms/${encodeURIComponent(rooms[0].roomId)}`;
  const attachment = {
    id: 'delivered-sheet', name: 'result.xlsx', size: 4096,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const task = {
    requestId: 'activity-fixture', botId: people[1].id, roomId: rooms[0].roomId,
    eventId: '$task-request', status: 'running', stage: 'thinking',
    summary: '正在处理任务', artifacts: [attachment], toolCalls: 1,
    cancelRequested: false, createdAt: Date.now(), updatedAt: Date.now(),
  };
  responses.set(`GET ${currentRoomBase}/messages?limit=200`, {
    events: [{
      event_id: '$delivered-sheet', room_id: rooms[0].roomId,
      sender: people[1].id, type: 'm.room.message', origin_server_ts: Date.now(),
      content: { body: 'Delivered spreadsheet', 'org.ds_group': { attachments: [attachment] } },
    }],
  });
  async function refreshTask(nextTask) {
    responses.set(`GET ${currentRoomBase}/tasks`, { tasks: nextTask ? [nextTask] : [] });
    const refreshed = page.waitForResponse(response =>
      new URL(response.url()).pathname === `${currentRoomBase}/tasks`);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await refreshed;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await mkdir(path.join(packageRoot, '.local'), { recursive: true });
  await page.locator('#toast').waitFor({ state: 'hidden' });
  for (const viewport of [{ width: 985, height: 822 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => document.querySelector('#details-panel').getBoundingClientRect().left >= innerWidth - 1);
    await page.waitForFunction(() => {
      const panel = document.querySelector('#channel-panel');
      return getComputedStyle(panel).position !== 'fixed' || panel.getBoundingClientRect().right <= 1;
    });
    await refreshTask(null);
    const idleTimeline = await page.locator('#timeline').boundingBox();
    await refreshTask(task);
    await page.locator('.composer-activity').waitFor();
    assert.equal(await page.locator('.composer-activity').getAttribute('aria-label'), 'Processing');
    assert.equal(await page.locator('.composer-activity').textContent(), '');
    assert.equal(await page.locator('.composer-activity > span').count(), 3);
    assert.equal(await page.locator('.conversation .task-card, #task-tray').count(), 0);
    assert.equal(await page.locator('#task-history-dialog').evaluate(element => element.open), false);
    assert.equal(await page.locator('.attachment-card[data-attachment-id="delivered-sheet"]').count(), 1);
    const fileIcon = page.locator('.attachment-card[data-attachment-id="delivered-sheet"] svg.attachment-file-icon');
    assert.equal(await fileIcon.count(), 1);
    assert.equal(await fileIcon.textContent(), '');
    assert.equal(await fileIcon.getAttribute('stroke-width'), '2');
    assert.equal(await fileIcon.evaluate(element => getComputedStyle(element).borderWidth), '0px');
    const activeTimeline = await page.locator('#timeline').boundingBox();
    assert.equal(activeTimeline.height, idleTimeline.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(packageRoot, '.local', `chat-activity-${viewport.width}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await page.locator('.composer-activity > span').evaluateAll(elements =>
    elements.map(element => getComputedStyle(element).animationName)), ['none', 'none', 'none']);
  checks.push('activityUsesAnonymousDotsWithoutTaskCardsDuplicateFilesOrLayoutShift');

  await refreshTask({ ...task, status: 'completed', stage: 'completed', summary: '已交付' });
  await page.locator('.composer-activity').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.task-card').count(), 0);
  const closedTimeline = await page.locator('#timeline').boundingBox();
  await page.locator('#tasks-button').click();
  await page.locator('#task-history-dialog[open]').waitFor();
  assert.equal(await page.locator('#task-history-dialog .task-card').count(), 1);
  assert.equal(await page.locator('#task-history-dialog .attachment-card').count(), 0);
  assert.equal(await page.locator('.attachment-card[data-attachment-id="delivered-sheet"]').count(), 1);
  assert.equal((await page.locator('#timeline').boundingBox()).height, closedTimeline.height);
  await page.locator('#close-task-history').click();
  await page.locator('#task-history-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.task-card').count(), 0);
  checks.push('completedWorkDisappearsAndHistoryRequiresExplicitOverlayOpen');

  assert.deepEqual(unhandledRequests, []);
  assert.deepEqual(pageErrors, []);
  checks.push('fullAppUsesOnlyMockedApiAndHasNoPageErrors');
} catch (error) {
  failure = error;
} finally {
  const reportDirectory = path.join(packageRoot, '.local');
  await mkdir(reportDirectory, { recursive: true });
  if (failure && page) {
    await page.screenshot({ path: path.join(reportDirectory, 'react-app-browser-failure.png') }).catch(() => {});
  }
  const report = {
    passed: !failure,
    evidence: 'real Chromium with actual React App, isolated Vite and mocked APIs',
    checks,
    pageErrors,
    unhandledRequests,
    apiRequestCount,
    sentMessages,
    modelCalls: 0,
    ...(failure ? { error: failure.stack ?? String(failure) } : {}),
  };
  await writeFile(path.join(reportDirectory, 'react-app-browser.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
  await rm(temporary, { recursive: true, force: true });
}

if (failure) throw failure;
console.log(`React App browser checks passed (${checks.length})`);
