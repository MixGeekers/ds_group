import { test, expect } from '@playwright/test';
import { makeLocalTask, makeSnapshot, makeTaskVerification } from './fixtures.js';

const runName = '运行本地任务验证';
const pendingName = '正在受理本地任务…';
const unconfirmed = '本地任务受理回执不完整，受理结果未确认。请刷新任务状态；不会自动重试。';
const expectedCommand = {
  action: 'task.createLocal', requestId: 'local-validation-test-runtime-instance', title: '本地任务链路验证',
  content: '识雨本地任务验证：受限 worker 写入专属产物，独立核验内容与回执。',
};
const stats = async request => (await request.get('/__test/stats')).json();
const control = async (request, body) => { const response = await request.post('/__test/control', { data: body }); expect(response.ok()).toBe(true); };
const refresh = async page => {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
};
const detailValue = (detail, name) => detail.getByText(name, { exact: true }).locator('xpath=following-sibling::dd[1]');
async function diagnostics(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '诊断', exact: true }).click();
  await expect(page.getByTestId('local-task-validation')).toBeVisible();
}

test.beforeEach(async ({ request }) => { await control(request, { reset: true }); });

test('local validation posts only on request and admission never substitutes for the GET task state', async ({ page, request }, testInfo) => {
  const task = makeLocalTask();
  // A complete-looking receipt must not become a fabricated task snapshot.
  await control(request, { snapshot: { ...makeSnapshot(), tasks: [] }, taskAdmission: {
    publish: false, overrides: { task: { ...task, state: 'succeeded', verification: makeTaskVerification({ taskId: task.taskId }) } },
  } });
  await diagnostics(page);
  const panel = page.getByTestId('local-task-validation');
  for (const text of ['note.txt', 'deepseek-v4.1-flash', 'high', '1024', '最多 2 个模型步骤']) await expect(panel).toContainText(text);
  await expect(panel).toContainText('独立核验内容与回执后才算成功');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('local-task-validation-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await refresh(page);
  expect((await stats(request)).commands).toEqual([]);
  await page.locator('#locale').click();
  await expect(page.getByRole('button', { name: 'Run local task validation', exact: true })).toBeEnabled();
  await page.locator('#locale').click();
  await page.getByRole('button', { name: runName, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('本地任务已受理（test-local-task-1）；是否完成以任务状态和独立核验为准。');
  await expect(page.getByRole('button', { name: '任务', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('暂无任务', { exact: true })).toBeVisible();
  await expect(page.getByText('当前快照尚未包含选中的任务记录。', { exact: true })).toBeVisible();
  await expect(page.getByTestId('task-detail')).toHaveCount(0);
  expect((await stats(request)).commands).toEqual([expectedCommand]);
  await control(request, { snapshot: { ...makeSnapshot(), tasks: [task] } });
  await refresh(page);
  const detail = page.getByTestId('task-detail');
  await expect(detailValue(detail, '任务状态')).toHaveText('排队中');
  await expect(page.getByTestId('task-verification')).toContainText('尚无独立核验记录');
  const verified = { ...task, state: 'succeeded', attempt: 1, verification: makeTaskVerification({ taskId: task.taskId }) };
  await control(request, { snapshot: { ...makeSnapshot(), tasks: [verified] } });
  await refresh(page);
  await expect(detailValue(detail, '任务状态')).toHaveText('成功');
  await expect(page.getByTestId('task-verification')).toContainText('synthetic-verifier-v1');
  expect((await stats(request)).commands).toEqual([expectedCommand]);
});

test('double activation has one in-flight POST and later explicit activation reuses the same instance request ID', async ({ page, request }) => {
  await control(request, { taskAdmission: { defer: true } });
  await diagnostics(page);
  await page.getByRole('button', { name: runName, exact: true }).evaluate(element => { element.click(); element.click(); });
  await expect.poll(async () => (await stats(request)).pendingTaskAdmissions).toBe(1);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  expect((await stats(request)).commands).toEqual([expectedCommand]);
  await control(request, { releaseTaskAdmission: true, taskAdmission: {} });
  await expect(page.getByRole('status').filter({ hasText: '本地任务已受理' })).toBeVisible();
  await page.getByRole('button', { name: '诊断', exact: true }).click();
  await page.getByRole('button', { name: runName, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '本地任务已受理' })).toBeVisible();
  await expect.poll(async () => (await stats(request)).commands.length).toBe(2);
  expect((await stats(request)).commands).toEqual([expectedCommand, expectedCommand]);
  expect((await stats(request)).taskAdmissions).toBe(1);
});

test('an unconfirmed admission is not retried automatically and an explicit retry retains its request ID', async ({ page, request }) => {
  await page.clock.install();
  await control(request, { taskAdmission: { error: true } });
  await diagnostics(page);
  await page.getByRole('button', { name: runName, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('合成测试：受理回执未确认。');
  await page.clock.fastForward(10001);
  expect((await stats(request)).commands).toEqual([expectedCommand]);
  await control(request, { taskAdmission: {} });
  await page.getByRole('button', { name: runName, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('本地任务已受理（test-local-task-1）');
  expect((await stats(request)).commands).toEqual([expectedCommand, expectedCommand]);
  expect((await stats(request)).taskAdmissions).toBe(1);
});

test('HTTP admission timeout leaves the admitted task visible through GET without restarting it', async ({ page, request }) => {
  await page.clock.install();
  await control(request, { taskAdmission: { defer: true } });
  await diagnostics(page);
  await page.getByRole('button', { name: runName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingTaskAdmissions).toBe(1);
  await page.clock.fastForward(20001);
  await expect(page.getByRole('alert')).toContainText('操作结果未确认，请先刷新状态再决定下一步。');
  await expect.poll(async () => (await stats(request)).admissionAborts).toBe(1);
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看任务 test-local-task-1', exact: true })).toBeVisible();
  expect((await stats(request)).taskAdmissions).toBe(1);
  expect((await stats(request)).commands).toEqual([expectedCommand]);
});

test('a paused runtime disables local task creation', async ({ page, request }) => {
  await control(request, { snapshot: makeSnapshot({ state: 'paused' }) });
  await diagnostics(page);
  await expect(page.getByRole('button', { name: runName, exact: true })).toBeDisabled();
  expect((await stats(request)).commands).toEqual([]);
});

test('an unconfirmed snapshot disables local task creation', async ({ page, request }) => {
  await diagnostics(page);
  await expect(page.getByRole('button', { name: runName, exact: true })).toBeEnabled();
  await control(request, { failReads: true });
  await refresh(page);
  await expect(page.getByTestId('snapshot-stale')).toBeVisible();
  await expect(page.getByRole('button', { name: runName, exact: true })).toBeDisabled();
  expect((await stats(request)).commands).toEqual([]);
});

for (const [label, taskAdmission] of [
  ['missing accepted', { omit: ['accepted'] }],
  ['missing task', { omit: ['task'] }],
  ['missing task ID', { omitTask: ['taskId'] }],
  ['rejected acceptance', { overrides: { accepted: false } }],
  ['empty task ID', { overrides: { task: { taskId: ' ' } } }],
]) {
  test(`local task ${label} evidence does not claim admission`, async ({ page, request }) => {
    await control(request, { taskAdmission });
    await diagnostics(page);
    await page.getByRole('button', { name: runName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(unconfirmed);
    await expect(page.getByRole('status').filter({ hasText: '本地任务已受理' })).toHaveCount(0);
    await refresh(page);
    expect((await stats(request)).commands).toEqual([expectedCommand]);
  });
}
