import { test, expect } from '@playwright/test';
import { makeConversation, makeMemory, makeMemoryEntry, makeSnapshot } from './fixtures.js';

const operationId = 'test-memory-operation-1', conversationId = 'test-conversation-1';
const bodyText = '合成测试记忆正文：仅用于显式读取。';
const saveName = '保存片段', readName = '读取正文', withdrawName = '撤回读取许可';
const snapshot = overrides => ({ ...makeSnapshot(), conversations: [makeConversation()], memory: makeMemory(), ...overrides });
const control = async (request, data) => { expect((await request.post('/__test/control', { data })).ok()).toBe(true); };
const stats = async request => (await request.get('/__test/stats')).json();
function apiPosts(page) {
  const posted = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/')) posted.push(request.postDataJSON());
  });
  return posted;
}
async function open(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.getByTestId('memory-state')).toBeVisible();
}
async function select(page, id = operationId) {
  await page.getByRole('button', { name: `查看记忆 ${id}`, exact: true }).click();
  await expect(page.getByTestId('memory-detail')).toBeVisible();
}
async function draft(page, text = '合成测试：明确选择保存的片段。', id = conversationId) {
  await page.getByRole('combobox', { name: '关联对话', exact: true }).selectOption(id);
  await page.getByRole('textbox', { name: '记忆片段', exact: true }).fill(text);
}
async function refresh(page) {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
}
async function read(page, body = bodyText) {
  await page.getByRole('button', { name: readName, exact: true }).click();
  await expect(page.getByTestId('memory-body')).toContainText(body);
  await expect(page.getByRole('button', { name: readName, exact: true })).toBeEnabled();
}

test.beforeEach(async ({ request }) => { await control(request, { reset: true, snapshot: snapshot() }); });

test('memory navigation and polling show metadata only and never automatically read or save', async ({ page, request }) => {
  const posted = apiPosts(page);
  await page.clock.install();
  await control(request, { snapshot: snapshot({ memory: makeMemory({ body: 'SNAPSHOT_BODY_CANARY', entries: [makeMemoryEntry({ body: 'ENTRY_BODY_CANARY', text: 'ENTRY_TEXT_CANARY' })] }) }) });
  await open(page); await select(page);
  await expect(page.getByTestId('memory-detail')).toContainText(operationId);
  await expect(page.getByTestId('memory-state')).toContainText('语义检索尚未启用');
  for (const canary of ['SNAPSHOT_BODY_CANARY', 'ENTRY_BODY_CANARY', 'ENTRY_TEXT_CANARY']) await expect(page.locator('.syr')).not.toContainText(canary);
  await refresh(page);
  const reads = (await stats(request)).stateReads;
  await page.clock.fastForward(10001);
  await expect.poll(async () => (await stats(request)).stateReads).toBeGreaterThan(reads);
  expect(posted).toEqual([]);
});

test('missing, idle and failed memory readiness stay distinct and block saving without disrupting local conversations', async ({ page, request }) => {
  const posted = apiPosts(page);
  await open(page); await draft(page);
  await expect(page.getByRole('button', { name: saveName, exact: true })).toBeEnabled();
  for (const [memory, label] of [
    [undefined, '本地记忆尚未配置'],
    [makeMemory({ configured: false, ready: false, entries: [] }), '本地记忆尚未配置'],
    [makeMemory({ ready: false, backend: { ...makeMemory().backend, state: 'idle' } }), '记忆服务尚未就绪'],
    [makeMemory({ ready: false, errorCode: 'SYNTHETIC_UNAVAILABLE' }), '记忆服务不可用'],
  ]) {
    await control(request, { snapshot: snapshot({ memory }) }); await refresh(page);
    await expect(page.getByTestId('memory-state')).toContainText(label);
    await expect(page.getByRole('button', { name: saveName, exact: true })).toBeDisabled();
    if (label === '记忆服务尚未就绪') await expect(page.getByTestId('memory-state')).not.toContainText('记忆服务不可用');
  }
  expect(posted).toEqual([]);
});

test('saving is explicit and an unchanged draft retains its request ID after an uncertain receipt', async ({ page, request }) => {
  const posted = apiPosts(page), text = '合成测试：重复确认同一片段。';
  await control(request, { memoryRemember: { defer: true, error: true, publish: false } });
  await open(page); await draft(page, text);
  await refresh(page); expect(posted).toEqual([]);
  await page.getByRole('button', { name: saveName, exact: true }).evaluate(element => { element.click(); element.click(); });
  await expect.poll(async () => (await stats(request)).pendingMemoryRemembers).toBe(1);
  expect(posted).toHaveLength(1);
  expect(Object.keys(posted[0]).sort()).toEqual(['action', 'conversationId', 'requestId', 'text']);
  expect(posted[0]).toMatchObject({ action: 'memory.rememberLocal', conversationId, text });
  expect(posted[0].requestId).toEqual(expect.any(String)); expect(posted[0].requestId.length).toBeGreaterThan(0);
  await control(request, { releaseMemoryRemember: true });
  await expect(page.getByRole('alert')).toContainText('合成测试：记忆操作结果未确认。');
  await expect(page.getByRole('button', { name: saveName, exact: true })).toBeEnabled();
  await refresh(page); expect(posted).toHaveLength(1);
  await control(request, { memoryRemember: { publish: false } });
  await page.getByRole('button', { name: saveName, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '该请求已存在' })).toBeVisible();
  await expect(page.getByText('当前快照尚未包含选中的记忆记录。', { exact: true })).toBeVisible();
  expect(posted).toEqual([posted[0], posted[0]]);
  expect((await stats(request)).rememberedMemory).toBe(1);
  await page.getByRole('textbox', { name: '记忆片段', exact: true }).fill(`${text}这是新草稿。`);
  await page.getByRole('button', { name: saveName, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '保存请求已有回执' })).toBeVisible();
  expect(posted).toHaveLength(3);
  expect(posted[2].requestId).not.toBe(posted[0].requestId);
  expect((await stats(request)).rememberedMemory).toBe(2);
});

test('explicit reads render text only and the native bilingual layout fits 390 pixels', async ({ page, request }, testInfo) => {
  const posted = apiPosts(page), errors = [];
  const body = '合成测试正文 <img src=x onerror="window.memoryInjected=true">\n第二行 javascript:synthetic-only';
  page.on('pageerror', error => errors.push(error.message));
  await control(request, { memoryRead: { body } });
  await open(page); await select(page); await read(page, body);
  expect(posted).toEqual([{ action: 'memory.readLocal', operationId }]);
  await expect(page.getByTestId('memory-body').locator('img,script,a')).toHaveCount(0);
  expect(await page.evaluate(() => window.memoryInjected)).toBeUndefined();
  await expect(page.getByTestId('memory-detail')).toContainText('这不表示后端正文已被物理删除');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('memory-form').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('memory-form-mobile-zh.png'), fullPage: true });
  await page.getByTestId('memory-detail').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('memory-detail-mobile-zh.png'), fullPage: true });
  await page.locator('#locale').click(); await page.locator('#theme').click();
  await expect(page.getByRole('button', { name: 'Memory', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read body', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Withdraw read consent', exact: true })).toBeEnabled();
  await expect(page.getByTestId('memory-detail')).toContainText('physically deleted');
  await page.getByTestId('memory-body').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('memory-detail-mobile-en-dark.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.syr').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(posted).toEqual([{ action: 'memory.readLocal', operationId }]);
  expect(errors).toEqual([]);
});

for (const [label, entries] of [
  ['read permission false', [makeMemoryEntry({ canRead: false })]],
  ['withdrawn consent', [makeMemoryEntry({ consent: 'withdrawn' })]],
  ['new entry version', [makeMemoryEntry({ version: 2 })]],
  ['entry disappearance', []],
]) {
  test(`a GET showing ${label} clears previously displayed memory`, async ({ page, request }) => {
    const posted = apiPosts(page);
    await open(page); await select(page); await read(page);
    await control(request, { snapshot: snapshot({ memory: makeMemory({ entries }) }) }); await refresh(page);
    await expect(page.locator('.syr')).not.toContainText(bodyText);
    expect(posted).toEqual([{ action: 'memory.readLocal', operationId }]);
  });
}

for (const [label, changed] of [
  ['read access revoked', snapshot({ memory: makeMemory({ entries: [makeMemoryEntry({ canRead: false })] }) })],
  ['entry version advanced', snapshot({ memory: makeMemory({ entries: [makeMemoryEntry({ version: 2 })] }) })],
  ['runtime instance changed', snapshot({ instanceId: 'new-test-runtime' })],
]) {
  test(`a late read cannot display a body after ${label}`, async ({ page, request }) => {
    const posted = apiPosts(page);
    await control(request, { memoryRead: { defer: true } });
    await open(page); await select(page);
    await page.getByRole('button', { name: readName, exact: true }).click();
    await expect.poll(async () => (await stats(request)).pendingMemoryReads).toBe(1);
    await control(request, { snapshot: changed }); await refresh(page);
    await control(request, { releaseMemoryRead: true });
    await expect(page.getByRole('alert')).toContainText('正文未显示');
    await expect(page.locator('.syr')).not.toContainText(bodyText);
    expect(posted).toEqual([{ action: 'memory.readLocal', operationId }]);
  });
}

test('A-to-B-to-A selection invalidates the first read instead of showing a late body', async ({ page, request }) => {
  const posted = apiPosts(page), otherId = 'test-memory-operation-2';
  await control(request, { snapshot: snapshot({ memory: makeMemory({ entries: [makeMemoryEntry(), makeMemoryEntry({ operationId: otherId, requestId: 'test-request-2' })] }) }), memoryRead: { defer: true } });
  await open(page); await select(page);
  await page.getByRole('button', { name: readName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingMemoryReads).toBe(1);
  await select(page, otherId); await select(page);
  await control(request, { releaseMemoryRead: true });
  await expect(page.getByRole('alert')).toContainText('正文未显示');
  await expect(page.locator('.syr')).not.toContainText(bodyText);
  expect(posted).toEqual([{ action: 'memory.readLocal', operationId }]);
});

test('withdrawal remains independent of a pending read and its late old receipt cannot resurrect the body', async ({ page, request }) => {
  const posted = apiPosts(page);
  await control(request, { memoryRead: { defer: true } });
  await open(page); await select(page);
  await page.getByRole('button', { name: readName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingMemoryReads).toBe(1);
  await expect(page.getByRole('button', { name: withdrawName, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: withdrawName, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '读取许可已撤回' })).toContainText('不代表物理删除');
  await control(request, { releaseMemoryRead: true });
  await expect(page.getByRole('alert')).toContainText('正文未显示');
  await expect(page.locator('.syr')).not.toContainText(bodyText);
  await expect(page.getByRole('button', { name: readName, exact: true })).toHaveCount(0);
  expect(posted).toHaveLength(2);
  expect(posted[0]).toEqual({ action: 'memory.readLocal', operationId });
  expect(posted[1]).toMatchObject({ action: 'memory.withdrawLocal', operationId, requestId: expect.any(String) });
  expect(Object.keys(posted[1]).sort()).toEqual(['action', 'operationId', 'requestId']);
});

test('pause blocks save and read but still permits withdrawing read consent', async ({ page, request }) => {
  const posted = apiPosts(page);
  await open(page); await draft(page); await select(page);
  await control(request, { snapshot: snapshot({ state: 'paused' }) }); await refresh(page);
  await expect(page.getByRole('button', { name: saveName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: readName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: withdrawName, exact: true })).toBeEnabled();
  await page.getByRole('button', { name: withdrawName, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '读取许可已撤回' })).toBeVisible();
  expect(posted).toHaveLength(1); expect(posted[0].action).toBe('memory.withdrawLocal');
});

test('a failed state refresh clears displayed body and blocks save and read', async ({ page, request }) => {
  const posted = apiPosts(page);
  await open(page); await draft(page); await select(page); await read(page);
  await control(request, { failReads: true }); await refresh(page);
  await expect(page.getByTestId('snapshot-stale')).toBeVisible();
  await expect(page.locator('.syr')).not.toContainText(bodyText);
  await expect(page.getByRole('button', { name: saveName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: readName, exact: true })).toBeDisabled();
  expect(posted).toEqual([{ action: 'memory.readLocal', operationId }]);
});

test('an uncertain withdrawal clears body even when a stale snapshot still says canRead', async ({ page, request }) => {
  const posted = apiPosts(page);
  await open(page); await select(page); await read(page);
  await control(request, { memoryWithdraw: { error: true, publish: false } });
  await page.getByRole('button', { name: withdrawName, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('撤回结果未确认，临时正文已清除');
  await refresh(page);
  await expect(page.locator('.syr')).not.toContainText(bodyText);
  await expect(page.getByRole('button', { name: readName, exact: true })).toHaveCount(0);
  expect(posted.map(item => item.action)).toEqual(['memory.readLocal', 'memory.withdrawLocal']);
});

test('saving waits past 20 seconds, stops at 70 seconds and preserves the request ID for an explicit retry', async ({ page, request }) => {
  const posted = apiPosts(page);
  await page.clock.install();
  await control(request, { memoryRemember: { defer: true, publish: false } });
  await open(page); await draft(page);
  await page.getByRole('button', { name: saveName, exact: true }).click();
  await expect.poll(async () => (await stats(request)).pendingMemoryRemembers).toBe(1);
  await page.clock.fastForward(21000);
  await expect(page.getByRole('button', { name: '正在保存片段…', exact: true })).toBeDisabled();
  await page.clock.fastForward(48000);
  expect((await stats(request)).pendingMemoryRemembers).toBe(1);
  await page.clock.fastForward(1001);
  await expect(page.getByRole('alert').filter({ hasText: '记忆操作回执不完整' })).toContainText('不会自动重试');
  await expect.poll(async () => (await stats(request)).pendingMemoryRemembers).toBe(0);
  expect(posted).toHaveLength(1);
  const observedAt = await page.evaluate(() => new Date().toISOString());
  await control(request, { snapshot: snapshot({ observedAt }), memoryRemember: { publish: false } }); await refresh(page);
  await page.getByRole('button', { name: saveName, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '该请求已存在' })).toBeVisible();
  expect(posted).toEqual([posted[0], posted[0]]);
});

for (const [label, options] of [
  ['missing duplicate flag', { omit: ['duplicate'] }], ['missing entry', { omit: ['entry'] }],
  ['another request ID', { entryOverrides: { requestId: 'different-request' } }],
  ['another conversation', { entryOverrides: { conversationId: 'different-conversation' } }],
  ['invalid version', { entryOverrides: { version: 0 } }],
]) {
  test(`save rejects ${label} without optimistic metadata insertion or retry`, async ({ page, request }) => {
    const posted = apiPosts(page);
    await control(request, { memoryRemember: { ...options, publish: false } });
    await open(page); await draft(page);
    await page.getByRole('button', { name: saveName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('记忆操作回执不完整');
    await expect(page.getByRole('button', { name: '查看记忆 test-saved-memory-1', exact: true })).toHaveCount(0);
    await refresh(page); expect(posted).toHaveLength(1);
  });
}

for (const [label, options] of [
  ['wrong operation', { entryOverrides: { operationId: 'wrong-operation' } }],
  ['wrong version', { entryOverrides: { version: 2 } }],
  ['read denied', { entryOverrides: { canRead: false } }],
  ['consent withdrawn', { entryOverrides: { consent: 'withdrawn' } }],
  ['blocked entry', { entryOverrides: { blocked: true } }],
  ['wrong native identity', { entryOverrides: { nativeId: 'wrong-native' } }],
  ['non-text body', { overrides: { body: { text: bodyText } } }],
]) {
  test(`read rejects ${label} without displaying a body or retrying`, async ({ page, request }) => {
    const posted = apiPosts(page);
    await control(request, { memoryRead: options });
    await open(page); await select(page);
    await page.getByRole('button', { name: readName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(/记忆操作回执不完整|正文未显示/);
    await expect(page.locator('.syr')).not.toContainText(bodyText);
    await refresh(page); expect(posted).toEqual([{ action: 'memory.readLocal', operationId }]);
  });
}
