import { test, expect } from '@playwright/test';
import { makeContextVerificationRecord, makeConversation, makeConversationBackground, makeSnapshot, makeSucceededLocalTask } from './fixtures.js';

const conversationId = 'test-conversation-1', bindingId = 'test-binding-1';
const verifyName = '验证背景加载与会话复用', pendingName = '正在验证背景加载与会话复用…';
const unconfirmed = '检查回执未完整确认本次对话、绑定、同一 Session、2 次请求、背景持久化、每轮草稿放行核验及未发送；结果未确认。';
const success = '该次检查通过：2 轮生成复用同一 Session；背景确认已持久化，每轮草稿在放行时通过核验，未发送消息。';
const command = { action: 'conversation.verifyContext', conversationId };
const snapshot = overrides => {
  const base = makeSnapshot();
  return { ...base, tasks: [makeSucceededLocalTask()], conversations: [makeConversation()], background: makeConversationBackground(),
    ...overrides, diagnostics: { ...base.diagnostics, ...overrides?.diagnostics } };
};
const stats = async request => (await request.get('/__test/stats')).json();
const control = async (request, body) => { expect((await request.post('/__test/control', { data: body })).ok()).toBe(true); };
const refresh = async page => {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
};
function apiPosts(page) {
  const requests = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.postDataJSON());
  });
  return requests;
}
async function open(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: `查看对话 ${bindingId}`, exact: true }).click();
  await expect(page.getByTestId('context-verification')).toBeVisible();
}

test.beforeEach(async ({ request }) => { await control(request, { reset: true, snapshot: snapshot() }); });

for (const [label, contextSafety] of [
  ['unavailable', { ready: false, error: 'Synthetic native context adapter unavailable.' }],
  ['missing', undefined],
]) {
  test(`context safety readiness ${label} blocks only context verification`, async ({ page, request }) => {
    const posted = apiPosts(page);
    await control(request, { snapshot: snapshot({ diagnostics: { contextSafety } }) });
    await open(page);
    const button = page.getByRole('button', { name: verifyName, exact: true });
    await expect(button).toBeDisabled();
    await expect(page.getByTestId('context-verification-readiness')).toHaveText(label === 'unavailable'
      ? '原生背景加载尚不可用，请查看诊断中的依赖状态。' : '原生背景加载就绪检查尚未接入。');
    await button.evaluate(element => element.click());
    await refresh(page);
    await expect(button).toBeDisabled();
    await expect(page.getByRole('button', { name: '关联本地任务', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '诊断', exact: true }).click();
    for (const name of ['检查会话接入（不调用模型）', '验证模型与会话复用（2 次请求）', '运行本地任务验证', '检查原生 Goal 生命周期（零推理）']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
    }
    expect(posted).toEqual([]);
    await control(request, { snapshot: snapshot() });
    await refresh(page);
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await expect(button).toBeEnabled();
    expect(posted).toEqual([]);
  });
}

test('context verification is explicit, uses the exact public payload, and only GET changes pending context', async ({ page, request }, testInfo) => {
  const posted = apiPosts(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await control(request, { contextVerification: { overrides: { body: 'RECEIPT_BODY_CANARY', drafts: [{ content: 'DRAFT_BODY_CANARY' }] } } });
  await open(page);
  const panel = page.getByTestId('context-verification');
  for (const text of ['2', '512', 'opencode-go/deepseek-v4.1-flash', 'low', '只读', '不发送消息', '不自动重试']) await expect(panel).toContainText(text);
  await refresh(page);
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: verifyName, exact: true }).click();
  const receipt = page.getByTestId('context-verification-receipt');
  await expect(receipt).toHaveAttribute('aria-label', '本次背景检查回执');
  await expect(receipt).toContainText(success);
  await expect(receipt.getByText('尝试轮数', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('2');
  await expect(receipt.locator('dt').filter({ hasText: /^模型调用$/ })).toHaveCount(0);
  for (const text of [conversationId, bindingId, 'test-context-session-1', '背景确认持久化', '每轮草稿放行核验', '未发送']) await expect(receipt).toContainText(text);
  await expect(page.getByTestId('conversation-load-state')).toHaveText('背景信息待加载');
  await expect(page.getByTestId('conversation-pending')).toContainText('test-background-event-1');
  await expect(page.locator('.syr')).not.toContainText('BODY_CANARY');
  expect(posted).toEqual([command]);
  expect((await stats(request)).taskAdmissions).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('context-verification-mobile-zh.png'), fullPage: true });
  await page.locator('#locale').click();
  await page.locator('#theme').click();
  await expect(page.getByRole('button', { name: 'Verify context loading and Session reuse', exact: true })).toBeEnabled();
  await expect(receipt).toHaveAttribute('aria-label', 'Context check receipt from this operation');
  await expect(receipt).toContainText('This check passed: 2 turns reused one Session');
  await expect(receipt.getByText('Attempted turns', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('2');
  await expect(receipt.locator('dt').filter({ hasText: /^Model calls$/ })).toHaveCount(0);
  await expect(panel).toContainText('512 output tokens per turn');
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('context-verification-mobile-en-dark.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.syr').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.locator('#locale').click();
  await control(request, { snapshot: snapshot({ conversations: [makeConversation({ needsSync: false, pending: [] })] }) });
  await refresh(page);
  await expect(page.getByTestId('conversation-load-state')).toHaveText('当前未标记待加载');
  await expect(page.getByTestId('conversation-pending')).not.toContainText('test-background-event-1');
  expect(posted).toEqual([command]);
  expect(errors).toEqual([]);
});

test('paused, stale, unknown and missing task references block verification while records stay readable', async ({ page, request }) => {
  const posted = apiPosts(page);
  await control(request, { snapshot: snapshot({ state: 'paused' }) });
  await open(page);
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeDisabled();
  await expect(page.getByTestId('conversation-pending')).toContainText('test-background-event-1');
  await control(request, { snapshot: snapshot({ state: 'unknown' }) });
  await refresh(page);
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeDisabled();
  for (const taskRefs of [[], undefined, [{ taskId: ' ' }]]) {
    await control(request, { snapshot: snapshot({ conversations: [makeConversation({ taskRefs })] }) });
    await refresh(page);
    await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeDisabled();
    await expect(page.getByTestId('context-verification')).toContainText('当前对话需有至少一项已关联任务。');
  }
  await control(request, { snapshot: snapshot() });
  await refresh(page);
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeEnabled();
  await control(request, { failReads: true });
  await refresh(page);
  await expect(page.getByTestId('snapshot-stale')).toBeVisible();
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeDisabled();
  await expect(page.getByTestId('conversation-pending')).toContainText('test-background-event-1');
  expect(posted).toEqual([]);
});

test('only a selected local-owner conversation offers context verification', async ({ page, request }) => {
  const posted = apiPosts(page);
  await control(request, { snapshot: snapshot({ conversations: [makeConversation(), makeConversation({ conversationId: 'foreign-conversation', bindingId: 'foreign-binding', scope: 'other-audience' })] }) });
  await page.goto('/');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByTestId('context-verification')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看对话 foreign-binding', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `查看对话 ${bindingId}`, exact: true }).click();
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeEnabled();
  expect(posted).toEqual([]);
});

test('saved diagnostics remain historical and do not confirm the current operation or another conversation', async ({ page, request }) => {
  const posted = apiPosts(page), other = makeConversation({ conversationId: 'test-conversation-2', bindingId: 'test-binding-2' });
  await control(request, { snapshot: snapshot({ conversations: [makeConversation(), other], diagnostics: { contextVerification: makeContextVerificationRecord({ instanceId: 'previous-runtime-instance' }) } }) });
  await open(page);
  const history = page.getByTestId('context-verification-history');
  await expect(history).toContainText('previous-runtime-instance');
  await expect(history).toContainText('不能确认当前背景状态，也不代表本次操作通过');
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeEnabled();
  await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
  await expect(page.getByTestId('context-verification')).not.toContainText(success);
  await expect(page.getByTestId('conversation-load-state')).toHaveText('背景信息待加载');
  await page.getByRole('button', { name: '查看对话 test-binding-2', exact: true }).click();
  await expect(history).toHaveCount(0);
  await page.getByRole('button', { name: `查看对话 ${bindingId}`, exact: true }).click();
  await control(request, { snapshot: snapshot({ diagnostics: { contextVerification: makeContextVerificationRecord() } }) });
  await refresh(page);
  await expect(history).toContainText('test-runtime-instance');
  await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
  expect(posted).toEqual([]);
});

test('failed history counts attempted turns without claiming observed model calls or triggering requests', async ({ page, request }) => {
  const posted = apiPosts(page);
  await control(request, { snapshot: snapshot({ diagnostics: { contextVerification: makeContextVerificationRecord({
    ok: false, calls: 1, message: '合成测试：派发前读取视图失败。',
  }) } }) });
  await open(page);
  const history = page.getByTestId('context-verification-history');
  await expect(history).toContainText('合成测试：派发前读取视图失败。');
  await expect(history.getByText('尝试轮数', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('1');
  await expect(history.locator('dt').filter({ hasText: /^模型调用$/ })).toHaveCount(0);
  await expect(history).toContainText('读取视图或模型派发前失败，也可能计入尝试轮数。实际模型调用以 Session 观察记录为准');
  await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
  await refresh(page);
  await page.locator('#locale').click();
  await expect(history.getByText('Attempted turns', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('1');
  await expect(history.locator('dt').filter({ hasText: /^Model calls$/ })).toHaveCount(0);
  await expect(history).toContainText('Use Session observations for actual model calls');
  expect(posted).toEqual([]);
});

test('a pending check cannot be repeated and pause retains an independent channel even after read failure', async ({ page, request }) => {
  const posted = apiPosts(page);
  await control(request, { contextVerification: { defer: true, error: true } });
  await open(page);
  await page.getByRole('button', { name: verifyName, exact: true }).evaluate(element => { element.click(); element.click(); });
  await expect.poll(async () => (await stats(request)).pendingContextVerifications).toBe(1);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  await control(request, { failReads: true });
  await refresh(page);
  await expect(page.getByTestId('snapshot-stale')).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled();
  await control(request, { failReads: false });
  await page.getByRole('button', { name: '暂停运行', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeDisabled();
  await refresh(page);
  expect((await stats(request)).pendingContextVerifications).toBe(1);
  await control(request, { releaseContextVerification: true });
  await expect(page.getByRole('alert')).toContainText('合成测试：背景验证结果未确认。');
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
  await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
  expect(posted).toEqual([command, { action: 'runtime.pause' }]);
});

test('the bounded wait survives 20 seconds and aborts once at 95 seconds without retry', async ({ page, request }) => {
  const posted = apiPosts(page);
  await page.clock.install();
  await control(request, { contextVerification: { defer: true } });
  await open(page);
  await page.getByRole('button', { name: verifyName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingContextVerifications).toBe(1);
  await page.clock.fastForward(21000);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  expect((await stats(request)).contextVerificationAborts).toBe(0);
  await page.clock.fastForward(73000);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  expect((await stats(request)).pendingContextVerifications).toBe(1);
  await page.clock.fastForward(1001);
  await expect(page.getByRole('alert').filter({ hasText: '等待背景加载检查超时' })).toContainText('结果未确认。请刷新核对；不会自动重试。');
  await expect.poll(async () => (await stats(request)).contextVerificationAborts).toBe(1);
  await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
  await page.clock.fastForward(10001);
  expect(posted).toEqual([command]);
});

test('switching conversations during a check cannot attach its receipt to the new selection or a new runtime instance', async ({ page, request }) => {
  const posted = apiPosts(page), other = makeConversation({ conversationId: 'test-conversation-2', bindingId: 'test-binding-2' });
  await control(request, { snapshot: snapshot({ conversations: [makeConversation(), other] }), contextVerification: { defer: true } });
  await open(page);
  await page.getByRole('button', { name: verifyName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingContextVerifications).toBe(1);
  await page.getByRole('button', { name: '查看对话 test-binding-2', exact: true }).click();
  await expect(page.getByRole('button', { name: verifyName, exact: true })).toBeDisabled();
  await control(request, { releaseContextVerification: true });
  await expect(page.getByRole('status')).toContainText(`对话（${conversationId}）的检查回执已收到`);
  await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
  await expect(page.getByTestId('context-verification')).not.toContainText(success);
  await page.getByRole('button', { name: `查看对话 ${bindingId}`, exact: true }).click();
  await expect(page.getByTestId('context-verification-receipt')).toContainText(success);
  await control(request, { snapshot: snapshot({ instanceId: 'new-runtime-instance' }) });
  await refresh(page);
  await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
  expect(posted).toEqual([command]);
});

for (const field of ['verified', 'conversationId', 'bindingId', 'sameSession', 'sessionId', 'calls', 'contextDurable', 'draftsValidated', 'sent']) {
  test(`context verification requires ${field} receipt evidence`, async ({ page, request }) => {
    const posted = apiPosts(page);
    await control(request, { contextVerification: { omit: [field] } });
    await open(page);
    await page.getByRole('button', { name: verifyName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(unconfirmed);
    await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
    await expect(page.getByTestId('conversation-pending')).toContainText('test-background-event-1');
    await refresh(page);
    expect(posted).toEqual([command]);
  });
}

for (const [label, overrides] of [
  ['verified false', { verified: false }], ['different conversation', { conversationId: 'another-conversation' }],
  ['different binding', { bindingId: 'another-binding' }], ['blank binding', { bindingId: ' ' }],
  ['different sessions', { sameSession: false }], ['blank session', { sessionId: ' ' }],
  ['one attempted turn', { calls: 1 }], ['string attempted-turn count', { calls: '2' }],
  ['unpersisted context', { contextDurable: false }], ['unvalidated drafts', { draftsValidated: false }], ['message sent', { sent: true }],
]) {
  test(`context verification rejects ${label} without optimistic pending changes or retry`, async ({ page, request }) => {
    const posted = apiPosts(page);
    await control(request, { contextVerification: { overrides } });
    await open(page);
    await page.getByRole('button', { name: verifyName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(unconfirmed);
    await expect(page.getByTestId('context-verification-receipt')).toHaveCount(0);
    await expect(page.getByTestId('conversation-load-state')).toHaveText('背景信息待加载');
    expect(posted).toEqual([command]);
  });
}
