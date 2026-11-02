import { test, expect } from '@playwright/test';

const stats = async request => (await request.get('/__test/stats')).json();
const control = async (request, body) => { const response = await request.post('/__test/control', { data: body }); expect(response.ok()).toBe(true); };
const verifyName = '验证模型与会话复用（2 次请求）';
const pendingName = '正在验证模型与会话复用…';
const uncertain = '模型验证回执未完整确认 2 次请求、同一会话和未对外发送消息；结果未确认。';
const actions = async request => (await stats(request)).commands.map(command => command.action);

async function openDiagnostics(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '诊断', exact: true }).click();
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeEnabled();
}

test.beforeEach(async ({ request }) => { await control(request, { reset: true }); });

test('model verification is explicit, bounded in the UI, bilingual and acknowledges complete evidence', async ({ page, request }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openDiagnostics(page);
  const panel = page.getByTestId('model-verification');
  for (const text of ['2', '1024', 'opencode-go', 'deepseek-v4.1-flash', 'low']) await expect(panel).toContainText(text);
  await expect(panel).toContainText('不自动重试');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  expect(await actions(request)).toEqual([]);
  await page.locator('#locale').click();
  await expect(page.getByRole('button', { name: 'Verify model and Session reuse (2 requests)', exact: true })).toBeEnabled();
  await page.locator('#locale').click();
  await page.getByRole('button', { name: verifyName, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('模型与会话复用验证通过：2 次请求使用同一会话，未对外发送消息。');
  expect(await actions(request)).toEqual(['session.verify-model']);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('model-verification-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

for (const field of ['verified', 'calls', 'sameSession', 'sent']) {
  test(`model verification does not report success when ${field} evidence is missing`, async ({ page, request }) => {
    await control(request, { verification: { omit: [field] } });
    await openDiagnostics(page);
    await page.getByRole('button', { name: verifyName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(uncertain);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    expect(await actions(request)).toEqual(['session.verify-model']);
  });
}

for (const [field, value] of [['verified', false], ['calls', 1], ['sameSession', false], ['sent', true]]) {
  test(`model verification rejects contradictory ${field} evidence`, async ({ page, request }) => {
    await control(request, { verification: { overrides: { [field]: value } } });
    await openDiagnostics(page);
    await page.getByRole('button', { name: verifyName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(uncertain);
    expect(await actions(request)).toEqual(['session.verify-model']);
  });
}

test('model verification error is shown without automatic command retry', async ({ page, request }) => {
  await page.clock.install();
  await control(request, { verification: { error: true } });
  await openDiagnostics(page);
  await page.getByRole('button', { name: verifyName, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('合成测试：模型验证失败。');
  await page.clock.fastForward(20001);
  expect(await actions(request)).toEqual(['session.verify-model']);
});

test('pause uses a separate request while verification is pending and resume waits for its result', async ({ page, request }) => {
  await control(request, { verification: { defer: true, error: true } });
  await openDiagnostics(page);
  await page.getByRole('button', { name: verifyName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingVerifications).toBe(1);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '暂停运行', exact: true }).click();
  await expect.poll(() => actions(request)).toEqual(['session.verify-model', 'runtime.pause']);
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  expect((await stats(request)).pendingVerifications).toBe(1);
  expect(await actions(request)).toEqual(['session.verify-model', 'runtime.pause']);
  await control(request, { releaseVerification: true });
  await expect(page.getByRole('alert')).toContainText('合成测试：模型验证失败。');
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
  expect(await actions(request)).toEqual(['session.verify-model', 'runtime.pause']);
});

test('model verification survives the old 20 second limit and aborts once at the 250 second bound', async ({ page, request }) => {
  await page.clock.install();
  await control(request, { verification: { defer: true } });
  await openDiagnostics(page);
  await page.getByRole('button', { name: verifyName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingVerifications).toBe(1);
  await page.clock.fastForward(21000);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  expect((await stats(request)).verificationAborts).toBe(0);
  await page.clock.fastForward(228000);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  expect((await stats(request)).pendingVerifications).toBe(1);
  await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled();
  await page.clock.fastForward(1001);
  await expect(page.getByRole('alert').filter({ hasText: '等待验证结果已达 250 秒' })).toContainText('结果未确认。请查看当前状态；不会自动重试。');
  await expect.poll(async () => (await stats(request)).verificationAborts).toBe(1);
  expect((await stats(request)).pendingVerifications).toBe(0);
  expect(await actions(request)).toEqual(['session.verify-model']);
});
