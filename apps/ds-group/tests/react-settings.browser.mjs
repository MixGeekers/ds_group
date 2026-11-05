import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { packageRoot } from '../src/paths.mjs';

const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="/theme.js"></script>
    <link rel="stylesheet" href="/tokens.css">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SettingsDialog } from '/src/components/SettingsDialog.tsx';
      import { RolesDialog } from '/src/components/RolesDialog.tsx';
      import { InboxDialog } from '/src/components/InboxDialog.tsx';
      import { NotificationDialog } from '/src/components/NotificationDialog.tsx';

      const people = [
        { id: '@alice:test', name: 'Alice', kind: 'human' },
        { id: '@bob:test', name: 'Bob', kind: 'human' },
      ];
      const rooms = [{ roomId: '!one:test', name: 'One', kind: 'group', participantIds: people.map(person => person.id) }];
      const defaults = { mode: 'mentions', muted: false, suppressEveryone: false, suppressRoles: false };
      const fixture = window.fixture = {
        calls: [], roles: [], preferences: { ...defaults }, events: [], roleChanges: 0,
        reads: [], jumps: [], pwaReady: 0, savedPreferences: 0, changedInbox: 0,
      };
      const copy = value => JSON.parse(JSON.stringify(value));
      const api = async (route, options = {}) => {
        const method = options.method || 'GET';
        fixture.calls.push({ route, method, body: options.body });
        if (route === '/api/push/config') return { enabled: false };
        if (route === '/api/roles') {
          if (method === 'GET') return copy({ roles: fixture.roles, canManage: true });
          if (method === 'POST') {
            const role = { ...copy(options.body), id: 'role-' + (fixture.roles.length + 1) };
            fixture.roles.push(role);
            return copy({ role });
          }
        }
        if (route.startsWith('/api/roles/')) {
          const id = decodeURIComponent(route.slice('/api/roles/'.length));
          if (method === 'PUT') {
            const role = { ...copy(options.body), id };
            fixture.roles = fixture.roles.map(item => item.id === id ? role : item);
            return copy({ role });
          }
          if (method === 'DELETE') {
            fixture.roles = fixture.roles.filter(item => item.id !== id);
            return { deleted: true };
          }
        }
        if (route.endsWith('/notifications')) {
          if (method === 'PUT') fixture.preferences = copy(options.body);
          return copy(fixture.preferences);
        }
        if (route.startsWith('/api/inbox?')) {
          const query = new URL(route, location.origin).searchParams;
          const events = fixture.events.filter(event => {
            if (query.get('filter') === 'unread') return !event.read;
            return event.mentionKinds.some(kind => kind !== 'here'
              && (query.get('includeEveryone') !== 'false' || kind !== 'everyone')
              && (query.get('includeRoles') !== 'false' || kind !== 'role'));
          });
          return copy({ events, unreadCount: fixture.events.filter(event => !event.read).length, mentionCount: fixture.events.length });
        }
        if (route.endsWith('/read')) {
          const roomId = decodeURIComponent(route.split('/')[3]);
          fixture.reads.push(roomId);
          fixture.events = fixture.events.map(event => event.room_id === roomId ? { ...event, read: true } : event);
          return { read: true };
        }
        throw new Error('Unexpected fixture request: ' + method + ' ' + route);
      };
      fixture.addEvent = (id, kind, body) => fixture.events.push({
        event_id: id, room_id: rooms[0].roomId, sender: '@bob:test', type: 'm.room.message',
        origin_server_ts: Date.now(), read: false, mentionKinds: [kind], content: { body },
      });

      function Fixture() {
        const [tab, setTab] = React.useState('account');
        const [rolesOpen, setRolesOpen] = React.useState(false);
        const session = React.useMemo(() => ({ user_id: '@alice:test', access_token: 'fixture-only' }), []);
        const [inboxOpen, setInboxOpen] = React.useState(false);
        const [notificationRoom, setNotificationRoom] = React.useState(null);
        return React.createElement(React.Fragment, null,
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            React.createElement('button', { id: 'open-roles', onClick: () => { setTab(null); setRolesOpen(true); } }, 'Roles'),
            React.createElement('button', { id: 'open-settings', onClick: () => setTab('account') }, 'Settings'),
            React.createElement('button', { id: 'open-inbox', onClick: () => setInboxOpen(true) }, 'Inbox'),
            React.createElement('button', { id: 'open-notifications', onClick: () => setNotificationRoom(rooms[0]) }, 'Notifications'),
          ),
          React.createElement(SettingsDialog, {
            tab, onClose: () => setTab(null), onTab: setTab,
            session: { user_id: '@alice:test', access_token: 'fixture-only' },
            participants: people, status: { nodes: [], budget: { used: 0, limit: null } }, api,
            onSwitchAccount: () => { fixture.switchAccount = true; },
            onLogout: () => { fixture.logout = true; }, logoutBusy: false,
            onRolesChanged: () => { fixture.roleChanges++; },
            onOpenRoom: (roomId, eventId) => fixture.jumps.push({ roomId, eventId }),
            onPwaReady: handle => { fixture.pwaReady++; fixture.pwa = handle; },
          }),
          React.createElement(RolesDialog, { open: rolesOpen, session, participants: people, api, onClose: () => setRolesOpen(false), onChanged: () => { fixture.roleChanges++; } }),
          React.createElement(InboxDialog, {
            open: inboxOpen, api, rooms, participants: people, onClose: () => setInboxOpen(false),
            onJump: (roomId, eventId) => fixture.jumps.push({ roomId, eventId }),
            onChanged: () => { fixture.changedInbox++; },
          }),
          React.createElement(NotificationDialog, {
            room: notificationRoom, api, onClose: () => setNotificationRoom(null),
            onSaved: () => { fixture.savedPreferences++; },
          }),
        );
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script>
  </body>
</html>`;

const temporary = await mkdtemp(path.join(os.tmpdir(), 'ds-group-react-settings-'));
const reportPath = path.join(packageRoot, '.local/react-settings-browser.json');
const server = await createServer({
  configFile: false,
  root: path.join(packageRoot, 'web'),
  cacheDir: path.join(temporary, 'vite-cache'),
  plugins: [{
    name: 'react-settings-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__settings', async (request, response, next) => {
        if (request.url.includes('html-proxy')) { next(); return; }
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__settings', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});

let browser;
const checks = [];
const pageErrors = [];
const report = { status: 'failed', level: 'real-chromium-react-settings-fixture', checks, modelCalls: 0, pageErrors };
try {
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'en-US', colorScheme: 'dark', viewport: { width: 1000, height: 850 },
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem('ds-group.language')) localStorage.setItem('ds-group.language', 'zh-CN');
    window.fixtureNotificationPermission = 'denied';
    Object.defineProperty(Notification, 'permission', {
      configurable: true,
      get: () => window.fixtureNotificationPermission,
    });
    if ('serviceWorker' in navigator) {
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => ({
        active: {}, pushManager: { getSubscription: async () => null },
      }) });
    }
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__settings`);
  await page.locator('#settings-dialog[open]').waitFor();

  await page.locator('[data-settings-tab="appearance"]').click();
  await page.locator('#language-select').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('#settings-title').textContent(), 'Settings');
  await page.locator('#language-select').selectOption('system');
  assert.equal(await page.locator('#language-select').inputValue(), 'system');
  await page.locator('#language-select').selectOption('en');
  assert.equal(await page.locator('#language-select').inputValue(), 'en');
  checks.push('languagePreferenceChangesEvenWhenResolvedLocaleMatches');

  await page.locator('#theme-select').selectOption('light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('#theme-select').selectOption('system');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.locator('#theme-select').selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.reload();
  await page.locator('[data-settings-tab="appearance"]').click();
  assert.equal(await page.locator('#theme-select').inputValue(), 'dark');
  assert.equal(await page.locator('#language-select').inputValue(), 'en');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  checks.push('themeSystemOverrideAndPreferencePersistence');

  assert.deepEqual(await page.locator('[data-settings-tab]').evaluateAll(elements => elements.map(element => element.dataset.settingsTab)), ['account', 'appearance', 'notifications']);
  await page.locator('#close-settings').click();
  await page.locator('#open-roles').click();
  await page.locator('#new-role').click();
  await page.locator('#role-name').fill('Reviewers');
  await page.locator('#role-members input[value="@bob:test"]').check();
  await page.locator('#role-form button[type="submit"]').click();
  await page.locator('.role-row').filter({ hasText: 'Reviewers' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.roles[0].memberIds), ['@bob:test']);
  await page.locator('.role-row').filter({ hasText: 'Reviewers' }).click();
  await page.locator('#role-name').fill('Editors');
  await page.locator('#role-mentionable').uncheck();
  await page.locator('#role-form button[type="submit"]').click();
  await page.locator('.role-row').filter({ hasText: 'Editors' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixture.roles[0].mentionable), false);
  await page.locator('.role-row').filter({ hasText: 'Editors' }).click();
  await page.locator('#delete-role').click();
  await page.waitForFunction(() => window.fixture.roles.length === 0);
  assert.equal(await page.evaluate(() => window.fixture.roleChanges), 3);
  checks.push('collaborationRolesRemainSeparateFromPersonalSettings');
  checks.push('roleCreateEditDeleteUsesTypedComponentState');

  await page.locator('#roles-dialog .dialog-heading button').click();
  await page.locator('#open-notifications').click();
  await page.locator('#notification-muted').check();
  await page.locator('input[name="notification-mode"][value="all"]').check();
  await page.locator('#notification-everyone').check();
  await page.locator('#notification-roles').check();
  await page.locator('#notification-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#notification-dialog').open);
  assert.deepEqual(await page.evaluate(() => window.fixture.preferences), {
    mode: 'all', muted: true, suppressEveryone: true, suppressRoles: true,
  });
  await page.locator('#open-notifications').click();
  await page.waitForFunction(() => !document.querySelector('#notification-muted').disabled);
  assert.ok(await page.locator('#notification-muted').isChecked());
  assert.ok(await page.locator('input[name="notification-mode"][value="all"]').isChecked());
  await page.locator('#close-notification').click();
  checks.push('roomNotificationPreferencesSaveAndReopen');

  await page.locator('#open-inbox').click();
  await page.locator('.inbox-empty').waitFor();
  await page.evaluate(() => window.fixture.addEvent('$direct', 'direct', '<@@alice:test> Fresh mention'));
  await page.locator('.inbox-item').filter({ hasText: 'Fresh mention' }).waitFor({ timeout: 8000 });
  await page.locator('.inbox-item').filter({ hasText: 'Fresh mention' }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.jumps), [{ roomId: '!one:test', eventId: '$direct' }]);
  checks.push('openInboxPollsNewMentionsAndJumpsToMessage');

  await page.evaluate(() => {
    window.fixture.addEvent('$everyone', 'everyone', '@everyone Group notice');
    window.fixture.addEvent('$role', 'role', 'Role notice');
    window.fixture.addEvent('$here', 'here', '@here Online notice');
  });
  await page.locator('#open-inbox').click();
  await page.waitForFunction(() => document.querySelectorAll('.inbox-item').length === 3);
  await page.locator('#inbox-everyone').uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.inbox-item').length === 2);
  await page.locator('#inbox-roles').uncheck();
  await page.waitForFunction(() => document.querySelectorAll('.inbox-item').length === 1);
  await page.locator('#inbox-unread').click();
  await page.waitForFunction(() => document.querySelectorAll('.inbox-item').length === 4);
  assert.ok(await page.locator('#inbox-everyone').isDisabled());
  await page.locator('#mark-all-read').click();
  await page.locator('.inbox-empty').waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.reads), ['!one:test']);
  assert.equal(await page.evaluate(() => window.fixture.changedInbox), 1);
  await page.locator('#close-inbox').click();
  const readsAfterClose = await page.evaluate(() => window.fixture.calls.filter(call => call.route.startsWith('/api/inbox?')).length);
  await page.waitForTimeout(2700);
  assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.route.startsWith('/api/inbox?')).length), readsAfterClose);
  checks.push('inboxFiltersMarkReadAndCloseStopsPolling');

  await page.locator('#open-settings').click();
  await page.locator('[data-settings-tab="notifications"]').click();
  assert.match(await page.locator('#push-status').textContent(), /Notifications are blocked/);
  assert.ok(await page.locator('#enable-push').isDisabled());
  await page.evaluate(async () => {
    window.fixtureNotificationPermission = 'granted';
    await window.fixture.pwa.refresh();
  });
  report.pwaFixture = await page.evaluate(() => ({
    permissionAndRegistrationMocked: true,
    status: document.querySelector('#push-status').textContent,
    secure: window.isSecureContext,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
    pushManager: 'PushManager' in window,
  }));
  await page.waitForFunction(() => document.querySelector('#push-status').textContent.includes('disabled on this server'), undefined, { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.fixture.pwaReady), 1);
  assert.equal(await page.locator('#enable-push').count(), 1);
  assert.ok(await page.locator('#enable-push').isDisabled());
  await page.locator('[data-settings-tab="appearance"]').click();
  assert.equal(await page.locator('#install-app').count(), 1);
  assert.equal(await page.locator('#offline-status').textContent(), 'Online');
  await page.locator('#theme-select').selectOption('light');
  await page.locator('#language-select').selectOption('zh-CN');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.equal(await page.locator('#settings-title').textContent(), '设置');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  checks.push('pwaControlsRemainMountedAndLocalizedOnMobile');

  assert.deepEqual(pageErrors, []);
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await server.close();
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
