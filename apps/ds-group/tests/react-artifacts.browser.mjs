import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { packageRoot } from '../src/paths.mjs';

const csv = 'department,total\nHR,200\n';
const reportPath = path.join(packageRoot, '.local', 'react-artifacts-browser.json');
const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'ds-group-artifact-browser-'));
const report = {
  status: 'running',
  level: 'real-chromium-react-components-fixture',
  checks: [],
  modelCalls: 0,
  pageErrors: [],
};

const fixtureHtml = `<!doctype html>
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
      import { TaskTray } from '/src/components/TaskTray.tsx';

      const session = { user_id: '@alice:test', access_token: 'synthetic' };
      const participants = [{ id: '@finance:test', name: 'Finance', kind: 'bot' }];
      const attachment = { id: 'table', name: 'summary.csv', mimeType: 'text/csv', size: 24 };
      const task = {
        botId: '@finance:test', roomId: '!room:test', artifacts: [], toolCalls: 2,
        cancelRequested: false, createdAt: Date.now(), updatedAt: Date.now(),
      };
      const initialTasks = [
        { ...task, requestId: 'complete', eventId: '$completed', status: 'completed',
          stage: 'completed', summary: 'Summary ready', artifacts: [attachment], toolCalls: 3 },
        { ...task, requestId: 'running', eventId: '$running', status: 'running',
          stage: 'executing', summary: 'Processing' },
      ];

      window.cancelAttempts = [];
      window.errors = [];
      let rejectNextCancellation = true;

      function Fixture() {
        const [tasks, setTasks] = React.useState(initialTasks);
        const [identity, setIdentity] = React.useState(session);
        window.switchUser = () => setIdentity({ ...session, user_id: '@bob:test' });
        window.rerender = () => setTasks(current => current.map(item => ({ ...item, artifacts: [...item.artifacts] })));
        window.showSummaryFixtures = () => setTasks([
          { ...initialTasks[0], summary: '处理完成' },
          { ...initialTasks[1], summary: '正在使用 bash' },
          { ...task, requestId: 'step-progress', eventId: '$step', status: 'running',
            stage: 'working', summary: '正在处理，第 3 步' },
          { ...task, requestId: 'business-error', eventId: '$error', status: 'failed',
            stage: 'failed', summary: '客户账目缺少凭据，请人工复核' },
        ]);
        window.setApplicationSummary = summary => setTasks(current => current.map(item =>
          item.requestId === 'complete' ? { ...item, summary } : item));
        window.restoreTasks = () => setTasks(initialTasks);

        async function cancelTask(requestId) {
          window.cancelAttempts.push(requestId);
          await new Promise(resolve => setTimeout(resolve, 30));
          if (rejectNextCancellation) {
            rejectNextCancellation = false;
            throw new Error('Synthetic cancellation failure');
          }
          setTasks(current => current.map(item => item.requestId === requestId
            ? { ...item, status: 'cancelled', stage: 'cancelled' } : item));
        }

        return React.createElement(TaskTray, {
          tasks, participants, session: identity, showHistory: true,
          onError: message => window.errors.push(message), onCancel: cancelTask,
        });
      }

      const root = createRoot(document.getElementById('root'));
      root.render(React.createElement(Fixture));
      window.unmount = () => root.unmount();
    </script>
  </body>
</html>`;

const fixturePlugin = {
  name: 'ds-group-artifact-fixture',
  configureServer(server) {
    server.middlewares.use('/__artifacts', async (request, response, next) => {
      if (request.url.includes('html-proxy')) {
        next();
        return;
      }
      try {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml('/__artifacts', fixtureHtml));
      } catch (error) {
        next(error);
      }
    });
  },
};

let server;
let browser;
try {
  server = await createServer({
    configFile: false,
    root: path.join(packageRoot, 'web'),
    cacheDir: cacheDirectory,
    plugins: [fixturePlugin],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  let reads = 0;
  await page.route('**/api/attachments/table', route => {
    reads++;
    return route.fulfill({ contentType: 'text/csv', body: csv });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ds-group.theme', 'light');
    localStorage.setItem('ds-group.language', 'en');
  });

  await page.goto(`http://127.0.0.1:${address.port}/__artifacts`);
  await page.locator('.task-card').first().waitFor();
  assert.equal(await page.locator('.task-card').count(), 2);
  report.checks.push('typedTaskCardsRender');

  await page.evaluate(() => window.showSummaryFixtures());
  await page.locator('[data-request-id="running"] .task-summary').filter({ hasText: 'Using bash' }).waitFor();
  assert.equal(await page.locator('[data-request-id="complete"] .task-summary').count(), 0);
  assert.equal(await page.locator('[data-request-id="step-progress"] .task-summary').textContent(), 'Working · step 3');
  assert.equal(await page.locator('[data-request-id="business-error"] .task-summary').textContent(), '客户账目缺少凭据，请人工复核');
  const summaries = [
    ['正在保存结果', 'Saving results'],
    ['正在准备文件', 'Preparing'],
    ['正在检查成果', 'Checking results'],
    ['成果文件已准备好', 'Result files are ready'],
    ['已取消', 'Cancelled'],
    ['等待处理', 'Queued'],
    ['正在取消', 'Cancelling'],
    ['附件传输中断，正在重试', 'Attachment transfer interrupted. Retrying…'],
    ['协作任务已取消', 'Cancelled'],
    ['正在保存成果', 'Saving results'],
    ['正在发送成果', 'Sending results'],
    ['任务已取消', 'Cancelled'],
    ['成果已生成，正在重试上传', 'Results are ready. Retrying upload…'],
    ['等待协作 Bot 的成果', 'Waiting for collaborator'],
    ['已交付', 'Delivered'],
    ['协作成果已交付', 'Delivered'],
    ['正在读取附件', 'Reading attachments'],
    ['正在处理任务', 'Working'],
  ];
  for (const [source, translated] of summaries) {
    await page.evaluate(value => window.setApplicationSummary(value), source);
    await page.waitForFunction(value => document.querySelector('[data-request-id="complete"] .task-summary')?.textContent === value, translated);
  }
  report.checks.push('applicationProgressSummariesLocalizeWithoutChangingBusinessText');
  await page.evaluate(() => window.restoreTasks());
  await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 2);

  await page.getByRole('button', { name: 'Preview summary.csv', exact: true }).click();
  await page.locator('dialog[open] .preview-text').filter({ hasText: 'HR,200' }).waitFor();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download summary.csv', exact: true }).click();
  const downloadedFile = await download;
  assert.equal(await readFile(await downloadedFile.path(), 'utf8'), csv);
  assert.equal(reads, 1);
  report.checks.push('previewAndDownloadShareVerifiedBytes');

  await page.evaluate(() => window.rerender());
  await page.evaluate(async () => {
    const i18n = await import('/i18n.js');
    i18n.setLocalePreference('zh-CN');
  });
  await page.getByText('已完成', { exact: true }).waitFor();
  assert.equal(reads, 1);
  assert.equal(await page.getByRole('button', { name: '下载 summary.csv', exact: true }).count(), 1);
  report.checks.push('localeRefreshPreservesCachedAttachment');

  const cancel = page.getByRole('button', { name: '取消', exact: true });
  await cancel.click();
  await page.waitForFunction(() => window.errors.length === 1);
  assert.deepEqual(await page.evaluate(() => window.errors), ['Synthetic cancellation failure']);
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.locator('[data-request-id="running"]').getAttribute('class'), 'task-card task-running');
  report.checks.push('failedCancellationCanBeRetried');

  await page.evaluate(() => { window.errors = []; });
  await cancel.click();
  await page.getByText('已取消', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.cancelAttempts), ['running', 'running']);
  report.checks.push('cancellationUpdatesCard');

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  report.checks.push('mobileLayoutFits');

  await page.getByRole('button', { name: '预览 summary.csv', exact: true }).click();
  await page.locator('dialog[open]').waitFor();
  await page.evaluate(() => window.switchUser());
  await page.waitForFunction(() => document.querySelectorAll('dialog').length === 0);
  report.checks.push('identityChangeClosesOldPreview');

  await page.getByRole('button', { name: '预览 summary.csv', exact: true }).click();
  await page.locator('dialog[open]').waitFor();
  await page.evaluate(() => window.unmount());
  assert.equal(await page.locator('dialog').count(), 0);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  report.checks.push('unmountClosesPreviewWithoutErrors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  await rm(cacheDirectory, { recursive: true, force: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
