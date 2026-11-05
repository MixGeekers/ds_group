import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { packageRoot } from '../src/paths.mjs';

const csv = 'department,total\nHR,200\n';
const reportPath = path.join(packageRoot, '.local', 'react-artifacts-browser.json');
const screenshotDirectory = path.join(packageRoot, '.local', 'attachment-cards');
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
    <link rel="stylesheet" href="/@fs/${path.join(packageRoot, 'ui/tailwind.css')}">
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/@fs/${path.join(packageRoot, 'ui/styles.css')}">
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { TaskHistoryDialog } from '/src/components/TaskTray.tsx';
      import { AttachmentView } from '/src/components/AttachmentView.tsx';
      import { renderAttachmentCard } from '/attachments.js';

      const session = { user_id: '@alice:test', access_token: 'synthetic' };
      const participants = [{ id: '@finance:test', name: 'Finance', kind: 'bot' }];
      const attachment = { id: 'table', name: 'summary.csv', mimeType: 'text/csv', size: 24 };
      const secondAttachment = { ...attachment, id: 'details', name: 'details.csv' };
      const archive = { id: 'archive', name: 'deployment-bundle.zip', mimeType: 'application/zip', size: 860000 };
      const longAttachment = { id: 'long-name', name: 'DSCord-跨服务器协作与独立身份设计方案-最终评审完整附件文件名称-2026-11-05.csv', mimeType: 'text/csv', size: 26000 };
      const imageAttachment = { id: 'brand-image', name: 'DSCord brand mark.png', mimeType: 'image/png', size: 10240 };
      const brokenImage = { ...imageAttachment, id: 'broken-image', name: 'Unavailable image.png' };
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
      let plainCard;
      window.showPlainImage = () => {
        const card = renderAttachmentCard(imageAttachment, { getSession: () => session });
        document.getElementById('plain-image').replaceChildren(card);
        plainCard = card;
        return card;
      };
      window.hidePlainImage = () => {
        plainCard?.dispose();
        document.getElementById('plain-image').replaceChildren();
        plainCard = null;
      };
      let rejectNextCancellation = true;

      function Fixture() {
        const [tasks, setTasks] = React.useState(initialTasks);
        const [identity, setIdentity] = React.useState(session);
        const [historyOpen, setHistoryOpen] = React.useState(false);
        const [files, setFiles] = React.useState([attachment, secondAttachment]);
        window.showAttachmentSet = mode => setFiles({
          original: [attachment, secondAttachment],
          single: [attachment],
          multiple: [attachment, secondAttachment, archive],
          long: [longAttachment],
          image: [imageAttachment],
          broken: [brokenImage],
        }[mode]);
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

        return React.createElement(React.Fragment, null,
          React.createElement('main', { className: 'conversation', style: { height: '100dvh' } },
            React.createElement('div', { className: 'message-attachments' },
              files.map(file => React.createElement(AttachmentView, {
                key: file.id, attachment: file, session: identity,
                onError: message => window.errors.push(message),
              })),
            ),
            React.createElement('div', { id: 'plain-image' }),
            React.createElement('button', { id: 'open-history', onClick: () => setHistoryOpen(true) }, 'Work history'),
          ),
          React.createElement(TaskHistoryDialog, {
            tasks, participants, open: historyOpen, onClose: () => setHistoryOpen(false),
            onError: message => window.errors.push(message), onCancel: cancelTask,
          }),
        );
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
    plugins: [tailwindcss(), fixturePlugin],
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
  let holdRead = null;
  await page.route('**/api/attachments/table', async route => {
    reads++;
    if (holdRead) await holdRead;
    return route.fulfill({ contentType: 'text/csv', body: csv });
  });
  const brandImage = await readFile(path.join(packageRoot, 'web/icons/mark-128.png'));
  await page.route('**/api/attachments/brand-image', route =>
    route.fulfill({ contentType: 'image/png', body: brandImage }));
  await page.route('**/api/attachments/broken-image', route =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Image unavailable"}' }));
  await page.addInitScript(() => {
    localStorage.setItem('ds-group.theme', 'light');
    localStorage.setItem('ds-group.language', 'en');
  });

  await page.goto(`http://127.0.0.1:${address.port}/__artifacts`);
  await page.locator('.message-attachments .attachment-card').first().waitFor();
  await mkdir(screenshotDirectory, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => window.showAttachmentSet('single'));
  await page.locator('.attachment-card').first().waitFor();
  await page.locator('.message-attachments').screenshot({ path: path.join(screenshotDirectory, 'desktop-single-light.png') });
  await page.evaluate(() => window.showAttachmentSet('multiple'));
  await page.locator('.attachment-card').nth(2).waitFor();
  assert.equal(await page.locator('[data-attachment-id="archive"] button[aria-label^="Preview"]').count(), 0);
  assert.equal(await page.locator('[data-attachment-id="archive"] button[aria-label^="Download"]').count(), 1);
  await page.locator('.message-attachments').screenshot({ path: path.join(screenshotDirectory, 'desktop-multiple-light.png') });
  await page.evaluate(() => window.DSGroupTheme.setPreference('dark'));
  await page.locator('.message-attachments').screenshot({ path: path.join(screenshotDirectory, 'desktop-multiple-dark.png') });
  await page.evaluate(() => window.showAttachmentSet('image'));
  await page.locator('.attachment-image[src^="blob:"]').waitFor();
  assert.equal(await page.locator('.attachment-card-image .attachment-image-caption').count(), 1);
  await page.locator('.message-attachments').screenshot({ path: path.join(screenshotDirectory, 'desktop-image-dark.png') });
  await page.getByRole('button', { name: 'Open image DSCord brand mark.png', exact: true }).click();
  await page.locator('#preview-dialog[open] .preview-image').waitFor();
  await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-image-preview-dark.png') });
  await page.locator('#close-preview').click();
  await page.evaluate(() => window.DSGroupTheme.setPreference('light'));
  await page.locator('.message-attachments').screenshot({ path: path.join(screenshotDirectory, 'desktop-image-light.png') });
  assert.equal(await page.getByRole('button', { name: 'Preview DSCord brand mark.png', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Open image DSCord brand mark.png', exact: true }).click();
  await page.locator('#preview-dialog[open] .preview-image').waitFor();
  await page.screenshot({ path: path.join(screenshotDirectory, 'desktop-image-preview-light.png') });
  await page.locator('#close-preview').click();
  await page.evaluate(() => window.showAttachmentSet('broken'));
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-attachment-id="broken-image"]');
    return card && !card.classList.contains('attachment-card-image');
  });
  assert.equal(await page.locator('[data-attachment-id="broken-image"] .attachment-file-symbol').count(), 1);
  assert.equal(await page.locator('[data-attachment-id="broken-image"] .attachment-info').count(), 1);
  assert.equal(await page.locator('[data-attachment-id="broken-image"] .attachment-name-preview').count(), 1);
  assert.equal(await page.locator('[data-attachment-id="broken-image"] .attachment-actions button').count(), 1);
  report.checks.push('imageThumbnailFailureRestoresCompleteFileCardAndArchiveHasNoFalsePreview');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.showAttachmentSet('long'));
  await page.locator('[data-attachment-id="long-name"]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('[data-attachment-id="long-name"] .attachment-name').evaluate(element =>
    element.scrollHeight <= element.clientHeight + 1), true);
  await page.locator('.message-attachments').screenshot({ path: path.join(screenshotDirectory, 'mobile-long-name-light.png') });
  await page.evaluate(() => window.showAttachmentSet('multiple'));
  await page.locator('[data-attachment-id="archive"]').waitFor();
  await page.locator('.message-attachments').screenshot({ path: path.join(screenshotDirectory, 'mobile-multiple-light.png') });
  report.checks.push('independentCardsFitMobileAndLongNameRemainsFullyReadable');
  await page.evaluate(() => window.showAttachmentSet('original'));
  await page.locator('.attachment-card').nth(1).waitFor();
  assert.equal(await page.locator('#task-tray').count(), 0);
  assert.equal(await page.locator('#task-history-dialog').isVisible(), false);
  assert.equal(await page.locator('.task-card').count(), 0);
  assert.equal(await page.locator('.attachment-card').count(), 2);
  report.checks.push('taskActivityAndCompletionStayOutsideNormalConversation');

  await page.locator('#open-history').click();
  await page.locator('#task-history-dialog[open]').waitFor();
  assert.equal(await page.locator('.task-card').count(), 2);
  assert.equal(await page.locator('#task-history-dialog .attachment-card').count(), 0);
  assert.equal(await page.locator('.attachment-card').count(), 2);
  report.checks.push('explicitHistoryOpensWithoutDuplicatingMessageAttachments');

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
  await page.locator('#close-task-history').click();
  await page.locator('#task-history-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.task-card').count(), 0);

  let releaseRead;
  holdRead = new Promise(resolve => { releaseRead = resolve; });
  await page.getByRole('button', { name: 'Preview summary.csv', exact: true }).click();
  await page.locator('[data-attachment-id="table"][aria-busy="true"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Preview summary.csv', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Download summary.csv', exact: true }).isDisabled(), true);
  releaseRead();
  holdRead = null;
  await page.locator('dialog[open] .preview-text').filter({ hasText: 'HR,200' }).waitFor();
  assert.equal(await page.locator('#preview-dialog').evaluate(dialog => {
    const box = dialog.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth + 1 && box.height === 760;
  }), true);
  await page.screenshot({ path: path.join(screenshotDirectory, 'mobile-text-preview-light.png') });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download summary.csv', exact: true }).click();
  const downloadedFile = await download;
  assert.equal(downloadedFile.suggestedFilename(), 'summary.csv');
  assert.equal(await readFile(await downloadedFile.path(), 'utf8'), csv);
  assert.equal(reads, 1);
  report.checks.push('attachmentBusyStateCoversFilenameAndDownload');
  report.checks.push('previewAndDownloadShareVerifiedBytes');

  await page.evaluate(() => window.rerender());
  await page.locator('#open-history').click();
  await page.evaluate(async () => {
    const i18n = await import('/i18n.js');
    i18n.setLocalePreference('zh-CN');
  });
  await page.getByText('已完成', { exact: true }).waitFor();
  assert.equal(reads, 1);
  assert.equal(await page.locator('#task-history-title').textContent(), '工作记录');
  assert.equal(await page.getByRole('button', { name: '关闭工作记录', exact: true }).count(), 1);
  assert.equal(await page.locator('.message-attachments button[aria-label="下载 summary.csv"]').count(), 1);
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

  assert.equal(await page.evaluate(() => {
    const dialog = document.querySelector('#task-history-dialog');
    const bounds = dialog.getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth
      && bounds.left >= 0 && bounds.right <= innerWidth
      && dialog.scrollWidth <= dialog.clientWidth;
  }), true);
  report.checks.push('mobileHistoryOverlayFits');

  await page.keyboard.press('Escape');
  await page.locator('#task-history-dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.restoreTasks());
  assert.equal(await page.locator('.task-card').count(), 0);
  assert.equal(await page.locator('#task-history-dialog').isVisible(), false);
  report.checks.push('historyClosesOnEscapeAndNewTaskUpdatesDoNotReopenIt');

  await page.evaluate(() => window.showPlainImage());
  await page.locator('#plain-image .attachment-image[src^="blob:"]').waitFor();
  assert.equal(await page.locator('#plain-image .attachment-image-button').isDisabled(), true);
  const plainDownload = page.waitForEvent('download');
  await page.locator('#plain-image .attachment-actions button').click();
  await plainDownload;
  await page.waitForFunction(() => !document.querySelector('#plain-image .attachment-card')?.hasAttribute('aria-busy'));
  assert.equal(await page.locator('#plain-image .attachment-image-button').isDisabled(), true);
  assert.equal(await page.locator('#plain-image .attachment-actions button').isEnabled(), true);
  await page.evaluate(() => window.hidePlainImage());
  report.checks.push('downloadPreservesDisabledThumbnailWhenPreviewIsUnavailable');

  await page.getByRole('button', { name: '预览 summary.csv', exact: true }).click();
  await page.locator('dialog[open]').waitFor();
  await page.evaluate(() => window.switchUser());
  await page.waitForFunction(() => document.querySelector('#preview-dialog') === null);
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
