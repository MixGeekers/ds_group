import { test, expect } from '@playwright/test';
import { makeInnerProjection, makeSnapshot } from './fixtures.js';

const stats = async request => (await request.get('/__test/stats')).json();
const control = async (request, body) => { const response = await request.post('/__test/control', { data: body }); expect(response.ok()).toBe(true); };
const recordErrors = page => { const errors = []; page.on('pageerror', error => errors.push(error.message)); return errors; };
const unavailable = (reason) => ({ status: 'unavailable', reason });

test.beforeEach(async ({ request }) => { await control(request, { reset: true }); });

test('shows the six published read capabilities without implying authorization or business acceptance', async ({ page, request }) => {
  const errors = recordErrors(page);
  await page.goto('/');
  const tab = page.getByRole('button', { name: '内层状态', exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.getByTestId('inner-state')).toBeVisible();
  const rows = page.getByTestId('inner-domain');
  await expect(rows).toHaveCount(6);
  for (const [domain, label, backend] of [['memory', '记忆', 'ombre-local'], ['relationship', '关系', 'control-relationship'],
    ['emotion', '情绪', 'control-emotion'], ['cognition', '认知', 'control-cognition'], ['personality', '人格', 'control-personality'], ['ability', '能力', 'control-ability']]) {
    const row = page.locator(`[data-testid="inner-domain"][data-domain="${domain}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(label);
    await expect(row).toContainText(backend);
  }
  await expect(page.locator('[data-testid="inner-domain"][data-domain="relationship"]')).toContainText('metadata_read, content_read');
  await expect(page.locator('[data-testid="inner-domain"][data-domain="memory"]')).toContainText('exact_read');
  await expect(page.locator('[data-testid="inner-domain"][data-domain="ability"]')).toContainText('state_read');
  await expect(page.locator('[data-testid="inner-domain"][data-domain="relationship"]')).toContainText('可用（仅读取能力）');
  await expect(page.getByTestId('inner-note')).toContainText('不授予工具或动作权限');
  await expect(page.getByTestId('inner-note')).toContainText('不表示业务已完成验收');
  await expect(page.getByTestId('inner-provenance')).toContainText('清单 schema · 4');
  const current = await stats(request);
  expect(current.commands).toEqual([]);
  expect(current.stateReads).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('English locale and a narrow viewport keep the same six-domain semantics', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('#locale').click();
  const tab = page.getByRole('button', { name: 'Inner state', exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  const rows = page.getByTestId('inner-domain');
  await expect(rows).toHaveCount(6);
  await expect(page.locator('[data-testid="inner-domain"][data-domain="relationship"]')).toContainText('Available (read capability only)');
  await expect(page.locator('[data-testid="inner-domain"][data-domain="relationship"]')).toContainText('metadata_read, content_read');
  await expect(page.locator('[data-testid="inner-domain"][data-domain="memory"]')).toContainText('exact_read');
  await expect(page.getByTestId('inner-note')).toContainText('grants no tool or action permission');
  await page.screenshot({ path: testInfo.outputPath('inner-en-wide.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('inner-state')).toBeVisible();
  await expect(rows).toHaveCount(6);
  await expect(page.locator('[data-testid="inner-domain"][data-domain="personality"]')).toContainText('control-personality');
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('.syr');
    const panel = document.querySelector('[data-testid="inner-state"]');
    return { page: document.documentElement.scrollWidth - window.innerWidth, panel: root && panel ? panel.getBoundingClientRect().width - root.getBoundingClientRect().width : 0 };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.panel).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('inner-en-narrow.png') });
});

test('unavailable domains show their published reason and never a fake available or empty state', async ({ page, request }) => {
  const snapshot = makeSnapshot();
  snapshot.innerProjection = makeInnerProjection({ domains: {
    memory: unavailable('source_unavailable'), relationship: unavailable('incompatible_version'),
    emotion: unavailable('verification_pending'), cognition: unavailable('not_implemented'),
    personality: unavailable('not_connected'), ability: unavailable('not_connected'),
  } });
  await control(request, { reset: true, snapshot });
  await page.goto('/');
  await page.getByRole('button', { name: '内层状态', exact: true }).click();
  const rows = page.getByTestId('inner-domain');
  await expect(rows).toHaveCount(6);
  for (const [domain, reason] of [['memory', '来源不可用'], ['relationship', '版本不兼容'], ['emotion', '待验证'],
    ['cognition', '未实现'], ['personality', '未接入'], ['ability', '未接入']]) {
    const row = page.locator(`[data-testid="inner-domain"][data-domain="${domain}"]`);
    await expect(row).toContainText('不可用');
    await expect(row).toContainText(reason);
    await expect(row).toContainText('未声明读取能力');
  }
  await expect(page.getByTestId('inner-reason')).toHaveCount(6);
  await expect(page.getByTestId('inner-note')).toContainText('读取方必须显式失败');
  expect((await stats(request)).commands).toEqual([]);
});

test('a snapshot without a published manifest is explicit instead of an empty success', async ({ page, request }) => {
  const snapshot = { ...makeSnapshot(), innerProjection: null };
  await control(request, { reset: true, snapshot });
  await page.goto('/');
  await page.getByRole('button', { name: '内层状态', exact: true }).click();
  await expect(page.getByTestId('inner-unpublished')).toBeVisible();
  await expect(page.getByTestId('inner-unpublished')).toContainText('这不等于全部为空或全部不可用');
  await expect(page.getByTestId('inner-domain')).toHaveCount(0);
  await expect(page.getByTestId('inner-note')).toBeVisible();
  expect((await stats(request)).commands).toEqual([]);
});

test('refreshing the inner panel is a read-only GET sequence with no command or model call', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '内层状态', exact: true }).click();
  const before = await stats(request);
  for (let round = 0; round < 3; round++) {
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByTestId('inner-state')).toBeVisible();
  }
  const after = await stats(request);
  expect(after.commands).toEqual([]);
  expect(after.stateReads).toBeGreaterThan(before.stateReads);
  await expect(page.getByTestId('inner-domain')).toHaveCount(6);
});
