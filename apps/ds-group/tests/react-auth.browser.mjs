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
      import { AuthDialog } from '/src/components/AuthDialog.tsx';

      const initialBootstrap = {
        name: 'DSCord', roomId: '!general:test', roomName: 'General', demoLogin: false,
        registration: { enabled: true, mode: 'open' },
        participants: [{ id: '@alice:test', localpart: 'alice', name: 'Alice', kind: 'human' }],
      };
      const fixture = window.fixture = { calls: [], closeCount: 0, clearCount: 0, behavior: 'success' };
      function Fixture() {
        const [bootstrap, setBootstrap] = React.useState(initialBootstrap);
        const [session, setSession] = React.useState(null);
        const [open, setOpen] = React.useState(true);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');
        fixture.bootstrap = value => setBootstrap(previous => ({ ...previous, ...value }));
        fixture.session = setSession;
        fixture.open = setOpen;
        fixture.rerender = () => setBootstrap(previous => ({
          ...previous, participants: previous.participants.map(person => ({ ...person })),
        }));
        return React.createElement(AuthDialog, {
          open, bootstrap, session, busy, error,
          onClearError() { fixture.clearCount++; setError(''); },
          onClose() { fixture.closeCount++; setOpen(false); },
          async onSubmit(input) {
            fixture.calls.push(input);
            setBusy(true);
            setError('');
            try {
              if (fixture.behavior === 'hold') await new Promise(resolve => { fixture.release = resolve; });
              if (fixture.behavior === 'server-error') setError('Username is already registered');
              if (fixture.behavior === 'throw') throw new Error('Synthetic connection failure');
            } finally { setBusy(false); }
          },
        });
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script>
  </body>
</html>`;

const temporary = await mkdtemp(path.join(os.tmpdir(), 'dscord-react-auth-'));
const server = await createServer({
  configFile: false,
  root: path.join(packageRoot, 'web'),
  cacheDir: path.join(temporary, 'vite-cache'),
  plugins: [tailwindcss(), {
    name: 'react-auth-fixture',
    configureServer(vite) {
      vite.middlewares.use('/__auth', async (request, response, next) => {
        if (request.url.includes('html-proxy')) { next(); return; }
        response.setHeader('Content-Type', 'text/html');
        response.end(await vite.transformIndexHtml('/__auth', html));
      });
    },
  }],
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});

const checks = [];
const pageErrors = [];
const report = { status: 'failed', level: 'real-chromium-auth-component-fixture', checks, pageErrors, modelCalls: 0 };
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 985, height: 822 } });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    localStorage.setItem('ds-group.language', 'en');
    localStorage.setItem('ds-group.theme', 'dark');
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__auth`);
  await page.locator('#login-dialog[open]').waitFor();

  await page.locator('#login-submit').click();
  assert.equal(await page.locator('#login-user').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#login-password').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#username-error').textContent(), 'Enter your username');
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#login-dialog').evaluate(element => element.open), true);
  checks.push('requiredFieldsIdentifyErrorsAndSignedOutDialogStaysOpen');

  await page.locator('#login-user').fill('new-person');
  await page.locator('#login-password').fill('synthetic-pass');
  await page.evaluate(() => window.fixture.rerender());
  assert.equal(await page.locator('#login-user').inputValue(), 'new-person');
  assert.equal(await page.locator('#login-password').inputValue(), 'synthetic-pass');
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => window.fixture.calls.length === 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.calls[0]), {
    mode: 'login', username: 'new-person', password: 'synthetic-pass', displayName: '',
  });
  checks.push('unknownUsernameCanSignInAndBootstrapRefreshPreservesCredentials');

  await page.locator('#password-toggle').click();
  assert.equal(await page.locator('#login-password').getAttribute('type'), 'text');
  assert.equal(await page.locator('#password-toggle').getAttribute('aria-label'), 'Hide password');
  await page.locator('#password-toggle').click();
  assert.equal(await page.locator('#login-password').getAttribute('type'), 'password');
  checks.push('passwordVisibilityUsesAccessibleExplicitToggle');

  await page.locator('#auth-toggle-mode').click();
  assert.equal(await page.locator('#login-title').textContent(), 'Create account');
  assert.equal(await page.locator('#login-user').inputValue(), 'new-person');
  assert.equal(await page.locator('#login-password').getAttribute('autocomplete'), 'new-password');
  await page.locator('#login-password').fill('');
  await page.locator('#login-submit').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'register-name');
  assert.equal(await page.locator('#login-password').getAttribute('aria-invalid'), 'true');
  await page.locator('#login-password').fill('synthetic-pass');
  assert.equal(await page.locator('#register-name').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#display-name-error').textContent(), 'Enter your display name');
  await page.locator('#register-name').fill('New Person');
  await page.evaluate(() => { window.fixture.behavior = 'server-error'; });
  await page.locator('#login-submit').click();
  await page.locator('#login-error').filter({ hasText: 'Username is already registered' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.calls.at(-1)), {
    mode: 'register', username: 'new-person', password: 'synthetic-pass', displayName: 'New Person',
  });
  await page.locator('#auth-toggle-mode').click();
  assert.equal(await page.locator('#login-title').textContent(), 'Sign in');
  assert.equal(await page.locator('#login-user').inputValue(), 'new-person');
  assert.equal(await page.locator('#login-error').isVisible(), false);
  assert.equal(await page.evaluate(() => window.fixture.clearCount), 2);
  checks.push('openRegistrationCollectsDisplayNameAndReturnsToLoginWithoutStaleError');

  await page.evaluate(() => { window.fixture.behavior = 'hold'; });
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => typeof window.fixture.release === 'function');
  assert.equal(await page.locator('#login-user').isDisabled(), true);
  assert.equal(await page.locator('#login-password').isDisabled(), true);
  assert.equal(await page.locator('#password-toggle').isDisabled(), true);
  assert.equal(await page.locator('#auth-toggle-mode').isDisabled(), true);
  const submittedCount = await page.evaluate(() => window.fixture.calls.length);
  await page.locator('#login-form').evaluate(element => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(await page.evaluate(() => window.fixture.calls.length), submittedCount);
  await page.evaluate(() => window.fixture.release());
  await page.waitForFunction(() => !document.querySelector('#login-submit').disabled);
  checks.push('busySubmissionLocksControlsAndPreventsDuplicateRequests');

  await page.evaluate(() => { window.fixture.behavior = 'throw'; });
  await page.locator('#login-submit').click();
  await page.locator('#login-error').filter({ hasText: 'Synthetic connection failure' }).waitFor();
  assert.equal(await page.locator('#login-user').inputValue(), 'new-person');
  assert.equal(await page.locator('#login-password').inputValue(), 'synthetic-pass');
  assert.equal(await page.locator('#login-submit').isEnabled(), true);
  checks.push('failedRequestPreservesCredentialsAndAllowsRetry');

  await page.locator('#auth-toggle-mode').click();
  await page.evaluate(() => window.fixture.bootstrap({ registration: { enabled: false, mode: 'closed' } }));
  await page.waitForFunction(() => document.querySelector('#login-title').textContent === 'Sign in');
  assert.equal(await page.locator('#auth-toggle-mode').count(), 0);
  assert.equal(await page.locator('#register-name').count(), 0);
  await page.evaluate(() => window.fixture.bootstrap({ registration: { enabled: true, mode: 'closed' } }));
  assert.equal(await page.locator('#auth-toggle-mode').count(), 0);
  checks.push('closedRegistrationCannotBeSelectedAndPolicyChangeReturnsToLogin');

  await page.evaluate(() => window.fixture.bootstrap({ demoLogin: true }));
  await page.locator('#login-user').fill('alice');
  await page.locator('#login-password').fill('');
  await page.evaluate(() => { window.fixture.behavior = 'success'; });
  await page.locator('#login-submit').click();
  await page.waitForFunction(() => window.fixture.calls.at(-1)?.username === 'alice');
  assert.equal((await page.evaluate(() => window.fixture.calls.at(-1))).password, '');
  assert.equal(await page.locator('#demo-accounts option[value="alice"]').count(), 1);
  checks.push('explicitDemoModeKeepsPasswordlessKnownAccountPath');

  await page.locator('#login-user').fill('mobile-person');
  await page.locator('#login-password').fill('mobile-password');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const language = await import('/i18n.js');
    language.setLocalePreference('zh-CN');
    window.DSGroupTheme.setPreference('light');
  });
  await page.waitForFunction(() => document.querySelector('#login-title').textContent === '登录');
  assert.equal(await page.locator('#login-user').inputValue(), 'mobile-person');
  assert.equal(await page.locator('#login-password').inputValue(), 'mobile-password');
  assert.equal(await page.evaluate(() => {
    const dialog = document.querySelector('#login-dialog');
    const bounds = dialog.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
  }), true);
  checks.push('mobileLanguageAndThemeChangesPreserveTypedCredentials');

  await page.evaluate(() => window.fixture.session({ user_id: '@alice:test', access_token: 'fixture-only' }));
  await page.locator('#close-login').click();
  await page.locator('#login-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.closeCount), 1);
  assert.deepEqual(pageErrors, []);
  checks.push('signedInAccountSwitcherClosesExplicitly');
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await mkdir(path.join(packageRoot, '.local'), { recursive: true });
  await writeFile(path.join(packageRoot, '.local/react-auth-browser.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await server.close();
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
