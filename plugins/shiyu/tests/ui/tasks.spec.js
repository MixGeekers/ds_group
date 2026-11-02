import { test, expect } from '@playwright/test';
import { makeSnapshot, makeTask, makeTaskVerification } from './fixtures.js';

const control = async (request, body) => { const response = await request.post('/__test/control', { data: body }); expect(response.ok()).toBe(true); };
const assertReadOnly = async request => { expect((await (await request.get('/__test/stats')).json()).commands).toEqual([]); };
const taskSnapshot = tasks => ({ ...makeSnapshot(), tasks });
const detailValue = (detail, name) => detail.getByText(name, { exact: true }).locator('xpath=following-sibling::dd[1]');
const refresh = async page => {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
};
async function openTask(page, taskId = 'test-task-1') {
  await page.goto('/');
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await page.getByRole('button', { name: `查看任务 ${taskId}`, exact: true }).click();
  return page.getByRole('region', { name: '任务详情', exact: true });
}

test.beforeEach(async ({ request }) => { await control(request, { reset: true }); });

test('task view distinguishes an absent integration from an empty task list without writing', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByText('任务视图尚未接入', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无任务', { exact: true })).toHaveCount(0);
  await control(request, { snapshot: taskSnapshot([]) });
  await refresh(page);
  await expect(page.getByText('暂无任务', { exact: true })).toBeVisible();
  await expect(page.getByText('任务视图尚未接入', { exact: true })).toHaveCount(0);
  await assertReadOnly(request);
});

test('a ready result and passing checks do not upgrade the authoritative waiting state', async ({ page, request }) => {
  const task = makeTask();
  await control(request, { snapshot: taskSnapshot([task]) });
  const detail = await openTask(page);
  await expect(page.getByTestId('task-list')).toContainText(task.title);
  await expect(detail).toContainText('等待完成核验');
  await expect(detailValue(detail, '任务状态')).toHaveText('等待中');
  await expect(detail).toContainText(task.activeAssignmentId);
  await expect(detailValue(detail, '执行次数')).toHaveText('1');
  await expect(detailValue(detail, '最近更新')).not.toHaveText('未提供');
  await expect(detail).toContainText('test-check-artifact');
  await expect(detail).toContainText('synthetic:artifact/report.txt');
  await expect(detail.getByText('成功', { exact: true })).toHaveCount(0);
  task.waitReason = 'completion_unconfirmed';
  task.verification = makeTaskVerification();
  await control(request, { snapshot: taskSnapshot([task]) });
  await refresh(page);
  await expect(detail).toContainText('完成结果未确认');
  await expect(detailValue(detail, '任务状态')).toHaveText('等待中');
  await expect(detail).toContainText('synthetic:evidence/artifact');
  await expect(detail.getByText('成功', { exact: true })).toHaveCount(0);
  await assertReadOnly(request);
});

test('unknown execution and stop requests remain unconfirmed and evidence references stay inert', async ({ page, request }, testInfo) => {
  const evidenceRefs = [
    'javascript:alert(document.cookie)',
    'file:///Users/synthetic/private/report.txt',
    'https://synthetic.invalid/evidence?token=not-a-real-token',
    '<img src=x onerror="alert(1)">',
  ];
  const task = makeTask({
    state: 'unknown', waitReason: undefined, stopRequested: true,
    uncertainty: { reason: '合成测试：外部效果尚未核对', at: new Date().toISOString(), evidenceRefs },
    verification: makeTaskVerification({ checks: [{ checkId: 'test-check-artifact', status: 'pass', evidenceRefs }] }),
  });
  await control(request, { snapshot: taskSnapshot([task]) });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const detail = await openTask(page);
  await expect(detail).toContainText('结果未知，待核对');
  await expect(detail).toContainText('已请求停止');
  await expect(detail).toContainText('停止请求尚不等于已取消；仍需核对执行和外部效果。');
  await expect(detail).toContainText(task.uncertainty.reason);
  for (const ref of evidenceRefs) await expect(detail.getByText(ref, { exact: true }).first()).toBeVisible();
  await expect(detail.getByRole('link')).toHaveCount(0);
  await expect(detail.locator('img, iframe')).toHaveCount(0);
  for (const ref of evidenceRefs) await expect(detail.getByRole('button', { name: ref, exact: true })).toHaveCount(0);
  await expect(detail.getByText('已取消', { exact: true })).toHaveCount(0);
  await expect(detail.getByText('成功', { exact: true })).toHaveCount(0);
  await page.locator('#locale').click();
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Task details', exact: true })).toContainText('Unknown');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('task-detail').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('task-detail-mobile.png'), fullPage: true });
  await page.locator('.syr').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: testInfo.outputPath('task-detail-mobile-bottom.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await assertReadOnly(request);
  expect(errors).toEqual([]);
});

test('a stop request in waiting state is not cancellation and uses the stopping wait reason', async ({ page, request }) => {
  const task = makeTask({ state: 'waiting', waitReason: 'cancel_requested', stopRequested: true });
  await control(request, { snapshot: taskSnapshot([task]) });
  const detail = await openTask(page);
  await expect(detail).toContainText('等待停止确认');
  await expect(detail).toContainText('已请求停止');
  await expect(detail).toContainText('停止请求尚不等于已取消；仍需核对执行和外部效果。');
  await expect(detailValue(detail, '任务状态')).toHaveText('等待中');
  await expect(detail.getByText('已取消', { exact: true })).toHaveCount(0);
  await assertReadOnly(request);
});

test('succeeded state and independent verification are displayed separately, including missing verification', async ({ page, request }) => {
  const task = makeTask({ state: 'succeeded', waitReason: undefined, activeAssignmentId: undefined, stopRequested: true, verification: makeTaskVerification() });
  await control(request, { snapshot: taskSnapshot([task]) });
  const detail = await openTask(page);
  await expect(detailValue(detail, '任务状态')).toHaveText('成功');
  await expect(page.getByTestId('task-stop-pending')).toContainText('停止请求尚不等于已取消；仍需核对执行和外部效果。');
  await expect(detail).toContainText('synthetic-verifier-v1');
  await expect(detail).toContainText('synthetic:evidence/artifact');
  await expect(detail).toContainText('synthetic:evidence/effect');
  delete task.verification;
  await control(request, { snapshot: taskSnapshot([task]) });
  await refresh(page);
  await expect(detailValue(detail, '任务状态')).toHaveText('成功');
  await expect(page.getByTestId('task-verification')).toContainText('尚无独立核验记录');
  await expect(detail).not.toContainText('synthetic-verifier-v1');
  await expect(detail).not.toContainText('synthetic:evidence/artifact');
  await expect(detail.getByText('通过', { exact: true })).toHaveCount(0);
  await page.locator('#locale').click();
  await expect(page.getByTestId('task-verification')).toContainText('No independent verification recorded');
  await expect(detailValue(page.getByTestId('task-detail'), 'Task state')).toHaveText('Succeeded');
  await assertReadOnly(request);
});
