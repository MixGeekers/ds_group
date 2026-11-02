import { test, expect } from '@playwright/test';
import { makeSnapshot } from './fixtures.js';

const stats = async request => (await request.get('/__test/stats')).json();
const control = async (request, body) => { const response = await request.post('/__test/control', { data: body }); expect(response.ok()).toBe(true); };
const recordErrors = page => { const errors = []; page.on('pageerror', error => errors.push(error.message)); return errors; };
const detailValue = (detail, name) => detail.getByText(name, { exact: true }).locator('xpath=following-sibling::dd[1]');

test.beforeEach(async ({ request }) => { await control(request, { reset: true }); });

test('starts with actual empty state and read-only requests, with implementation detail secondary', async ({ page, request }) => {
  const errors = recordErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '识雨 · 运行', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '测试宿主侧栏' }).getByRole('button', { name: '识雨运行', exact: true })).toBeVisible();
  await expect(page.getByTestId('active-work')).toContainText('当前没有正在处理的工作');
  await expect(page.getByTestId('attention')).toContainText('合成 UI 测试快照');
  await expect(page.getByTestId('system-list')).toHaveCount(0);
  await page.getByRole('button', { name: '系统', exact: true }).click();
  for (const name of ['运行底座', '事件系统', '会话系统', '核心判断', '内层状态', '任务执行', '对话表达', '设备接入', '恢复与检查点']) {
    await expect(page.getByTestId('system-list').getByText(name, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.getByText('还没有会话记录', { exact: true })).toBeVisible();
  expect((await stats(request)).commands).toEqual([]);
  expect(errors).toEqual([]);
});

test('shows evidence, Session detail, locale updates and a narrow native-theme layout', async ({ page, request }, testInfo) => {
  await control(request, { reset: true, state: 'busy', populated: true });
  const errors = recordErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('active-work')).toContainText('合成测试工作：核对会话绑定');
  await expect(page.getByTestId('activities')).toContainText('合成测试活动：会话检查结束');
  await page.screenshot({ path: testInfo.outputPath('runtime-light.png') });
  await page.locator('#theme').click();
  await page.screenshot({ path: testInfo.outputPath('runtime-dark.png') });
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await page.getByRole('button', { name: '查看会话 test-session-1', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话详情', exact: true })).toContainText('test-session-1');
  await expect(page.getByTestId('session-detail')).toContainText('no-model-called');
  await expect(page.getByTestId('session-detail')).toContainText('test-probe-1');
  const detail = page.getByTestId('session-detail');
  await expect(detailValue(detail, '记录状态')).toHaveText('已归档');
  await expect(detailValue(detail, '宿主状态')).toHaveText('未连接');
  await expect(detail).toContainText('当前识雨实例未连接此宿主会话。');
  await page.locator('#locale').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Shiyu');
  await expect(page.getByRole('navigation', { name: '测试宿主侧栏' }).getByRole('button', { name: 'Shiyu Runtime', exact: true })).toBeVisible();
  await expect(detailValue(detail, 'Record state')).toHaveText('Archived');
  await expect(detailValue(detail, 'Host state')).toHaveText('Not attached');
  await expect(detail).toContainText('This Shiyu instance is not attached to the Host Session.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('runtime-session-mobile.png'), fullPage: true });
  await page.locator('.syr').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: testInfo.outputPath('runtime-session-mobile-bottom.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await stats(request)).commands).toEqual([]);
  expect(errors).toEqual([]);
});

test('keeps the last successful snapshot and labels it unconfirmed after a read failure', async ({ page, request }) => {
  const errors = recordErrors(page);
  await control(request, { reset: true, state: 'busy', populated: true });
  await page.goto('/');
  await expect(page.getByTestId('active-work')).toContainText('合成测试工作：核对会话绑定');
  await control(request, { failReads: true });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByTestId('snapshot-stale')).toContainText('状态未确认');
  await expect(page.getByTestId('snapshot-stale')).toContainText('以下保留上次成功读取的快照。');
  await expect(page.getByTestId('active-work')).toContainText('合成测试工作：核对会话绑定');
  await control(request, { failReads: false });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByTestId('snapshot-stale')).toHaveCount(0);
  expect((await stats(request)).commands).toEqual([]);
  expect(errors).toEqual([]);
});

test('only issues commands after explicit probe, pause and resume actions', async ({ page, request }) => {
  const errors = recordErrors(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '诊断', exact: true }).click();
  expect((await stats(request)).commands).toEqual([]);
  await page.getByRole('button', { name: '检查会话接入（不调用模型）', exact: true }).click();
  await expect.poll(async () => (await stats(request)).commands.map(item => item.action)).toEqual(['session.probe']);
  await expect(page.getByRole('status')).toContainText('未调用模型');
  await expect(page.getByRole('status')).toContainText('释放');
  await expect(page.getByRole('status')).toContainText('归档');
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看会话 test-session-1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看会话 test-session-1', exact: true }).click();
  await expect(detailValue(page.getByTestId('session-detail'), '记录状态')).toHaveText('已归档');
  await expect(detailValue(page.getByTestId('session-detail'), '宿主状态')).toHaveText('未连接');
  await page.getByRole('button', { name: '暂停运行', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '恢复运行', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled();
  expect((await stats(request)).commands.map(item => item.action)).toEqual(['session.probe', 'runtime.pause', 'runtime.resume']);
  expect(errors).toEqual([]);
});

test('reports missing and unsupported Host status as unknown, independently of the record status', async ({ page, request }) => {
  const errors = recordErrors(page);
  const snapshot = makeSnapshot({ populated: true });
  delete snapshot.sessions[0].hostStatus;
  await control(request, { snapshot });
  await page.goto('/');
  await page.getByRole('button', { name: '会话', exact: true }).click();
  await page.getByRole('button', { name: '查看会话 test-session-1', exact: true }).click();
  const detail = page.getByTestId('session-detail');
  await expect(detailValue(detail, '记录状态')).toHaveText('已归档');
  await expect(detailValue(detail, '宿主状态')).toHaveText('未知');
  await expect(detail).toContainText('快照未提供可确认的宿主状态。');
  snapshot.sessions[0].hostStatus = 'unsupported-future-host-status';
  await control(request, { snapshot });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(detailValue(detail, '宿主状态')).toHaveText('未知');
  await expect(detail).not.toContainText('unsupported-future-host-status');
  await page.locator('#locale').click();
  await expect(detailValue(detail, 'Record state')).toHaveText('Archived');
  await expect(detailValue(detail, 'Host state')).toHaveText('Unknown');
  expect((await stats(request)).commands).toEqual([]);
  expect(errors).toEqual([]);
});

for (const missing of ['ready', 'noModelCalled', 'released', 'archived']) {
  test(`does not claim a complete probe receipt without ${missing} or automatically repeat the command`, async ({ page, request }) => {
    await page.route('**/api/shiyu/commands', async route => {
      const response = await route.fetch();
      const json = await response.json();
      delete json[missing];
      await route.fulfill({ response, json });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '诊断', exact: true }).click();
    await page.getByRole('button', { name: '检查会话接入（不调用模型）', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('会话检查回执缺少释放、归档或无模型调用的确认，请查看当前会话状态。');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    expect((await stats(request)).commands.map(item => item.action)).toEqual(['session.probe']);
  });
}

test('polls every ten seconds while visible and suspends polling while hidden', async ({ page, request }) => {
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('active-work')).toBeVisible();
  const initial = (await stats(request)).stateReads;
  await page.clock.fastForward(10001);
  await expect.poll(async () => (await stats(request)).stateReads).toBeGreaterThan(initial);
  await page.evaluate(() => window.__SHIYU_UI_HARNESS__.setVisibility(false));
  const hidden = (await stats(request)).stateReads;
  await page.clock.fastForward(30001);
  expect((await stats(request)).stateReads).toBe(hidden);
  await page.evaluate(() => window.__SHIYU_UI_HARNESS__.setVisibility(true));
  await expect.poll(async () => (await stats(request)).stateReads).toBeGreaterThan(hidden);
  expect((await stats(request)).commands).toEqual([]);
});

test('unload removes slots, locale subscriptions and future refresh work', async ({ page, request }) => {
  const errors = recordErrors(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByTestId('active-work')).toBeVisible();
  await page.locator('#unmount').click();
  await expect(page.getByRole('heading', { name: '识雨 · 运行', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__SHIYU_UI_HARNESS__.inspect())).toEqual({ loaded: false, registrations: 0, localeListeners: 0, dictionaries: 0 });
  const before = (await stats(request)).stateReads;
  await page.clock.fastForward(30001);
  expect((await stats(request)).stateReads).toBe(before);
  expect((await stats(request)).commands).toEqual([]);
  expect(errors).toEqual([]);
});
