import { test, expect } from '@playwright/test';
import { makeSnapshot, makeSucceededLocalTask } from './fixtures.js';

const runName = '检查原生 Goal 生命周期（零推理）';
const pendingName = '正在检查原生 Goal 生命周期…';
const success = '原生 Goal 生命周期检查通过：创建、暂停、恢复和完成已确认，未请求模型推理。';
const unconfirmed = '原生 Goal 检查回执未完整确认任务、目标、会话、完成状态、零推理及四步操作链；结果未确认。';
const selectedId = 'test-local-task-1';
const command = { action: 'goal.verify-lifecycle', taskId: selectedId };
const stats = async request => (await request.get('/__test/stats')).json();
const control = async (request, body) => { const response = await request.post('/__test/control', { data: body }); expect(response.ok()).toBe(true); };
const refresh = async page => {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
};
async function diagnostics(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '诊断', exact: true }).click();
  await expect(page.getByTestId('goal-verification')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await control(request, { reset: true, snapshot: { ...makeSnapshot(), tasks: [makeSucceededLocalTask()] } });
});

test('Goal check is one explicit POST and displays only the confirmed receipt, with bilingual narrow layout', async ({ page, request }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await diagnostics(page);
  const panel = page.getByTestId('goal-verification');
  await expect(panel).toContainText(selectedId);
  await expect(panel).toContainText('不会请求模型推理或发送消息');
  await expect(page.getByTestId('goal-verification-receipt')).toHaveCount(0);
  await refresh(page);
  expect((await stats(request)).commands).toEqual([]);
  await page.getByRole('button', { name: runName, exact: true }).click();
  await expect(page.getByRole('status')).toContainText(success);
  const receipt = page.getByRole('region', { name: '本次 Goal 检查回执', exact: true });
  for (const value of [selectedId, 'test-goal-binding-1', 'test-native-goal-1', 'test-goal-session-1', 'complete', 'create → pause → resume → complete', '未请求']) await expect(receipt).toContainText(value);
  expect((await stats(request)).commands).toEqual([command]);
  expect((await stats(request)).taskAdmissions).toBe(0);
  await page.locator('#locale').click();
  await expect(page.getByRole('button', { name: 'Check native Goal lifecycle (no inference)', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Goal check receipt', exact: true })).toContainText('Not requested');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('goal-verification-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await stats(request)).commands).toEqual([command]);
  expect(errors).toEqual([]);
});

test('Goal check selects the latest valid succeeded local task by its exact input marker', async ({ page, request }) => {
  const at = Date.now();
  const older = makeSucceededLocalTask('local-old', new Date(at - 4000).toISOString());
  const latest = makeSucceededLocalTask('local-latest', new Date(at - 2000).toISOString());
  const invalidTime = makeSucceededLocalTask('invalid-time', 'not-a-timestamp');
  const notLocal = { ...makeSucceededLocalTask('not-local', new Date(at).toISOString()), inputRefs: ['synthetic:input/request'] };
  const wrongMarker = { ...makeSucceededLocalTask('wrong-marker', new Date(at).toISOString()), inputRefs: ['local-input:wrong-marker-suffix'] };
  const notSucceeded = { ...makeSucceededLocalTask('not-succeeded', new Date(at).toISOString()), state: 'waiting' };
  await control(request, { snapshot: { ...makeSnapshot(), tasks: [notLocal, latest, invalidTime, older, wrongMarker, notSucceeded] } });
  await diagnostics(page);
  await expect(page.getByTestId('goal-verification')).toContainText('(local-latest)');
  await page.getByRole('button', { name: runName, exact: true }).click();
  await expect(page.getByRole('status')).toContainText(success);
  expect((await stats(request)).commands).toEqual([{ action: 'goal.verify-lifecycle', taskId: 'local-latest' }]);
});

for (const [label, snapshot] of [
  ['missing tasks', makeSnapshot()],
  ['empty tasks', { ...makeSnapshot(), tasks: [] }],
  ['only ineligible tasks', { ...makeSnapshot(), tasks: [
    { ...makeSucceededLocalTask('waiting-local'), state: 'waiting' },
    { ...makeSucceededLocalTask('nonlocal'), inputRefs: ['local-input:someone-else'] },
    makeSucceededLocalTask('invalid-time', 'invalid'),
  ] }],
]) {
  test(`Goal check is disabled with ${label}`, async ({ page, request }) => {
    await control(request, { snapshot });
    await diagnostics(page);
    await expect(page.getByRole('button', { name: runName, exact: true })).toBeDisabled();
    await expect(page.getByTestId('goal-verification')).toContainText('请先完成本地任务验证');
    expect((await stats(request)).commands).toEqual([]);
  });
}

test('paused and stale runtime states each disable Goal checks despite a successful task', async ({ page, request }) => {
  await control(request, { snapshot: { ...makeSnapshot({ state: 'paused' }), tasks: [makeSucceededLocalTask()] } });
  await diagnostics(page);
  await expect(page.getByRole('button', { name: runName, exact: true })).toBeDisabled();
  await control(request, { snapshot: { ...makeSnapshot(), tasks: [makeSucceededLocalTask()] } });
  await refresh(page);
  await expect(page.getByRole('button', { name: runName, exact: true })).toBeEnabled();
  await control(request, { failReads: true });
  await refresh(page);
  await expect(page.getByTestId('snapshot-stale')).toBeVisible();
  await expect(page.getByRole('button', { name: runName, exact: true })).toBeDisabled();
  expect((await stats(request)).commands).toEqual([]);
});

test('pending Goal checks reject repeated activation while pause retains its independent request channel', async ({ page, request }) => {
  await control(request, { goalVerification: { defer: true, error: true } });
  await diagnostics(page);
  await page.getByRole('button', { name: runName, exact: true }).evaluate(element => { element.click(); element.click(); });
  await expect.poll(async () => (await stats(request)).pendingGoalVerifications).toBe(1);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  expect((await stats(request)).commands).toEqual([command]);
  await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '暂停运行', exact: true }).click();
  await expect.poll(async () => (await stats(request)).commands).toEqual([command, { action: 'runtime.pause' }]);
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeDisabled();
  await refresh(page);
  expect((await stats(request)).pendingGoalVerifications).toBe(1);
  await control(request, { releaseGoalVerification: true });
  await expect(page.getByRole('alert')).toContainText('合成测试：Goal 生命周期回执未确认。');
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
  expect((await stats(request)).commands).toEqual([command, { action: 'runtime.pause' }]);
});

for (const field of ['verified', 'taskId', 'goalId', 'nativeGoalId', 'sessionId', 'nativePhase', 'inferenceRequested', 'operations']) {
  test(`Goal check does not report success without ${field}`, async ({ page, request }) => {
    await control(request, { goalVerification: { omit: [field] } });
    await diagnostics(page);
    await page.getByRole('button', { name: runName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(unconfirmed);
    await expect(page.getByTestId('goal-verification-receipt')).toHaveCount(0);
    await refresh(page);
    expect((await stats(request)).commands).toEqual([command]);
  });
}

for (const [label, overrides] of [
  ['verified false', { verified: false }],
  ['wrong task', { taskId: 'another-local-task' }],
  ['empty Goal ID', { goalId: '' }],
  ['empty native Goal ID', { nativeGoalId: ' ' }],
  ['empty Session ID', { sessionId: '' }],
  ['incomplete native phase', { nativePhase: 'active' }],
  ['inference requested', { inferenceRequested: true }],
  ['reordered operations', { operations: ['create', 'resume', 'pause', 'complete'] }],
  ['missing operation', { operations: ['create', 'pause', 'complete'] }],
  ['extra operation', { operations: ['create', 'pause', 'resume', 'complete', 'create'] }],
]) {
  test(`Goal check rejects ${label} without reporting success or retrying`, async ({ page, request }) => {
    await control(request, { goalVerification: { overrides } });
    await diagnostics(page);
    await page.getByRole('button', { name: runName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(unconfirmed);
    await expect(page.getByTestId('goal-verification-receipt')).toHaveCount(0);
    expect((await stats(request)).commands).toEqual([command]);
  });
}
