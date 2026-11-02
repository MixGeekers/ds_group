import { test, expect } from '@playwright/test';
import { makeConversation, makeMemory, makeSnapshot } from './fixtures.js';

const conversationId = 'test-conversation-1', operationId = 'test-memory-operation-1', bindingId = 'test-binding-1';
const snapshot = overrides => ({ ...makeSnapshot(), conversations: [makeConversation()], memory: makeMemory({ semanticConfigured: true,
  backend: { state: 'ready', backendId: 'test-memory-backend', deploymentId: 'test-memory-deployment', scope: 'local-owner', embedding: 'managed-harrier', semanticReady: false,
    semantic: { state: 'unverified', profileCompatible: true, embeddingVerified: false } } }), ...overrides });
const control = async (request, data) => { expect((await request.post('/__test/control', { data })).ok()).toBe(true); };
const indexResult = (duplicate = false) => ({ duplicate, entry: { indexOperationId: 'synthetic-index-one', memoryOperationId: operationId, status: 'applied', publishable: true, embeddingUsage: { calls: 1, complete: true } } });
const searchResult = (state = 'ok') => ({ state, matches: state === 'ok' ? [{ operationId, score: 0.85 }] : [], coverage: { eligibleCount: 1, indexedCount: state === 'ok' ? 1 : 0, missingCount: state === 'ok' ? 0 : 1 }, embeddingCalls: state === 'ok' ? 1 : 0, usageComplete: true });
function loadResult(input, sessionEpoch = 1) {
  return { status: 'loaded', duplicate: false, operation: { operationId: 'synthetic-load-one', conversationId: input.conversationId, inputId: input.inputId, bindingId,
    sessionEpoch, status: 'loaded', durability: 'confirmed' }, view: { data: [{ fields: { text: 'NEVER_RENDER_NATIVE_CONTEXT_BODY' } }] },
    load: { mode: 'load-only', inferenceRequested: false, followupRequested: false, binding: { sessionId: 'synthetic-native-session' },
      contextReceipt: { operationId: 'synthetic-load-one', sessionEpoch, sessionId: 'synthetic-native-session', durability: 'confirmed', userMessageSeq: 5, messageId: 'native-user-one', messageHash: 'a'.repeat(64) } } };
}
async function intercept(page, handler) {
  const posts = [];
  await page.route('**/api/shiyu/commands', async route => {
    const body = route.request().postDataJSON(); posts.push(body);
    if (!['memory.indexLocal', 'memory.searchLocal', 'conversation.loadContext'].includes(body.action)) return route.fallback();
    const result = await handler(body);
    await route.fulfill({ status: result.error ? 503 : 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  return posts;
}
async function memoryPage(page) { await page.goto('/'); await page.getByRole('button', { name: '记忆', exact: true }).click(); }
async function selectMemory(page) { await page.getByRole('button', { name: `查看记忆 ${operationId}`, exact: true }).click(); }
async function searchInput(page) {
  await page.getByRole('combobox', { name: '关联对话', exact: true }).selectOption(conversationId);
  await page.getByRole('textbox', { name: '搜索内容', exact: true }).fill('合成查询：笔记本位置');
}
async function conversationPage(page, id = bindingId) {
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: `查看对话 ${id}`, exact: true }).click();
}
async function refresh(page) { await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled(); }
test.beforeEach(async ({ request }) => { await control(request, { reset: true, snapshot: snapshot() }); });

test('indexing is an independent explicit action; unverified embedding permits the first call and duplicate uses the same ID', async ({ page }) => {
  const posts = await intercept(page, () => indexResult(posts.length > 1));
  await memoryPage(page); await selectMemory(page); await refresh(page); expect(posts).toEqual([]);
  await expect(page.getByTestId('memory-state')).toContainText('已配置，向量调用尚未验证');
  const button = page.getByRole('button', { name: '建立语义索引', exact: true }); await expect(button).toBeEnabled();
  await button.evaluate(element => { element.click(); element.click(); });
  await expect(page.getByTestId('memory-index-receipt')).toContainText('累计记录'); expect(posts).toHaveLength(1);
  expect(Object.keys(posts[0]).sort()).toEqual(['action', 'operationId', 'requestId']); expect(posts[0].operationId).toBe(operationId);
  await refresh(page); expect(posts).toHaveLength(1); await button.click();
  await expect(page.getByRole('status').filter({ hasText: '索引请求已存在' })).toBeVisible();
  expect(posts).toEqual([posts[0], posts[0]]); await expect(page.getByTestId('memory-body')).toHaveCount(0);
});

test('search shows only matching metadata and selecting a match never reads the body', async ({ page }, testInfo) => {
  const posts = await intercept(page, () => ({ ...searchResult(), body: 'NEVER_RENDER_SEARCH_BODY' }));
  await memoryPage(page); await searchInput(page); await refresh(page); expect(posts).toEqual([]);
  await page.getByRole('button', { name: '搜索记忆', exact: true }).click();
  await expect(page.getByTestId('memory-search-result')).toContainText(operationId);
  await expect(page.getByTestId('memory-search-result')).toContainText('0.85');
  await page.getByTestId('memory-search-result').getByRole('button', { name: operationId, exact: true }).click();
  await expect(page.getByTestId('memory-detail')).toBeVisible(); await expect(page.locator('.syr')).not.toContainText('NEVER_RENDER_SEARCH_BODY');
  expect(posts).toEqual([{ action: 'memory.searchLocal', conversationId, query: '合成查询：笔记本位置' }]);
  await refresh(page); expect(posts).toHaveLength(1);
  await page.getByTestId('memory-search').screenshot({ path: testInfo.outputPath('memory-search-desktop-zh-light.png') });
});

test('missing index coverage is explicit and is never described as a search with no matches', async ({ page }) => {
  const posts = await intercept(page, () => searchResult('index_required'));
  await memoryPage(page); await searchInput(page); await page.getByRole('button', { name: '搜索记忆', exact: true }).click();
  await expect(page.getByTestId('memory-search-result')).toContainText('需先建立索引');
  await expect(page.getByTestId('memory-search-result')).not.toContainText('本次没有匹配记录');
  expect(posts).toHaveLength(1); await expect(page.getByTestId('memory-body')).toHaveCount(0);
});

test('foreign result references are rejected without reading or retrying', async ({ page }) => {
  const posts = await intercept(page, () => ({ ...searchResult(), matches: [{ operationId: 'foreign-memory', score: 0.99 }] }));
  await memoryPage(page); await searchInput(page); await page.getByRole('button', { name: '搜索记忆', exact: true }).click();
  await expect(page.getByTestId('memory-error')).toContainText('结果未显示'); await expect(page.getByTestId('memory-search-result')).toHaveCount(0);
  await refresh(page); expect(posts).toHaveLength(1);
});

test('inconsistent coverage is rejected while a valid incomplete usage observation stays explicitly unknown', async ({ page }) => {
  const posts = await intercept(page, () => posts.length === 1
    ? { ...searchResult(), coverage: { eligibleCount: 1, indexedCount: 1, missingCount: 1 } }
    : { ...searchResult(), embeddingCalls: null, usageComplete: false });
  await memoryPage(page); await searchInput(page); await page.getByRole('button', { name: '搜索记忆', exact: true }).click();
  await expect(page.getByTestId('memory-error')).toContainText('回执不完整');
  await expect(page.getByTestId('memory-search-result')).toHaveCount(0);
  await page.getByRole('button', { name: '搜索记忆', exact: true }).click();
  await expect(page.getByTestId('memory-search-result')).toContainText('尚不完整');
  await expect(page.getByTestId('memory-search-result')).toContainText(operationId); expect(posts).toHaveLength(2);
});

test('an existing unknown index is not shown as a new completion or verified index', async ({ page, request }) => {
  const posts = await intercept(page, () => ({ duplicate: true, entry: { ...indexResult().entry, status: 'unknown', publishable: false,
    embeddingUsage: { calls: null, complete: false } } }));
  const current = snapshot(); current.memory.lastSemanticOperation = { kind: 'index', status: 'existing', outcome: 'unknown',
    at: new Date().toISOString(), embeddingUsage: { calls: null, complete: false } };
  await control(request, { snapshot: current }); await memoryPage(page); await selectMemory(page);
  await expect(page.getByTestId('memory-last-semantic')).toContainText('已有操作');
  await expect(page.getByTestId('memory-last-semantic')).toContainText('已记录结果 未知');
  await expect(page.getByTestId('memory-last-semantic')).not.toContainText('已完成');
  await page.getByRole('button', { name: '建立语义索引', exact: true }).click();
  await expect(page.getByTestId('memory-index-receipt')).toContainText('未知');
  await expect(page.getByRole('status').filter({ hasText: '索引请求已存在' })).toBeVisible();
  await expect(page.locator('.syr')).not.toContainText('索引已有独立核验回执。'); expect(posts).toHaveLength(1);
});

test('a semantic schema failure blocks vector actions but preserves explicit body reads', async ({ page, request }) => {
  const posts = await intercept(page, () => indexResult());
  const current = snapshot(); current.lifecycle = 'degraded'; current.memory.semanticConfigured = false;
  current.memory.semanticErrorCode = 'MEMORY_INDEX_SCHEMA_MIGRATION_REQUIRED';
  await control(request, { snapshot: current }); await memoryPage(page); await selectMemory(page); await searchInput(page);
  await expect(page.getByTestId('memory-state')).toContainText('语义检索暂不可用');
  await expect(page.getByTestId('memory-state')).toContainText('MEMORY_INDEX_SCHEMA_MIGRATION_REQUIRED');
  await expect(page.getByRole('button', { name: '建立语义索引', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '搜索记忆', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '读取正文', exact: true })).toBeEnabled(); expect(posts).toEqual([]);
  await page.getByRole('button', { name: '读取正文', exact: true }).click();
  await expect(page.getByTestId('memory-body')).toBeVisible(); expect(posts.map(item => item.action)).toEqual(['memory.readLocal']);
});

test('paused or incompatible semantics block index and search while existing withdrawal stays available', async ({ page, request }) => {
  const posts = await intercept(page, () => indexResult());
  await memoryPage(page); await selectMemory(page); await searchInput(page);
  await control(request, { snapshot: snapshot({ state: 'paused' }) }); await refresh(page);
  await expect(page.getByRole('button', { name: '建立语义索引', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '搜索记忆', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '撤回读取许可', exact: true })).toBeEnabled();
  const invalid = snapshot(); invalid.memory.backend.semantic = { state: 'unavailable', profileCompatible: false, embeddingVerified: false };
  await control(request, { snapshot: invalid }); await refresh(page);
  await expect(page.getByRole('button', { name: '建立语义索引', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '搜索记忆', exact: true })).toBeDisabled(); expect(posts).toEqual([]);
});

test('context loading displays only an exact zero-generation receipt, never returned view body or a draft', async ({ page }, testInfo) => {
  const posts = await intercept(page, input => loadResult(input));
  await page.goto('/'); await conversationPage(page);
  await page.getByRole('textbox', { name: '加载诊断输入', exact: true }).fill('合成诊断输入');
  await refresh(page); expect(posts).toEqual([]);
  await page.getByRole('button', { name: '加载只读上下文（不生成）', exact: true }).click();
  await expect(page.getByTestId('context-load-receipt')).toContainText('未请求生成或 followup');
  await expect(page.getByTestId('context-load-receipt')).toContainText('synthetic-native-session');
  await expect(page.locator('.syr')).not.toContainText('NEVER_RENDER_NATIVE_CONTEXT_BODY');
  expect(Object.keys(posts[0]).sort()).toEqual(['action', 'conversationId', 'inputId', 'text']); expect(posts[0].text).toBe('合成诊断输入');
  expect(posts).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#locale').click(); await page.locator('#theme').click();
  await expect(page.getByRole('button', { name: 'Load context without generation', exact: true })).toBeEnabled();
  await expect(page.getByTestId('context-load-receipt')).toContainText('does not verify a model answer');
  await page.getByTestId('context-load-only').screenshot({ path: testInfo.outputPath('context-load-mobile-en-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(posts).toHaveLength(1);
});

test('a receipt that claims generation or a different input is refused as a load diagnostic', async ({ page }) => {
  const posts = await intercept(page, input => { const result = loadResult(input); result.load.inferenceRequested = true; return result; });
  await page.goto('/'); await conversationPage(page); await page.getByRole('textbox', { name: '加载诊断输入', exact: true }).fill('合成诊断');
  await page.getByRole('button', { name: '加载只读上下文（不生成）', exact: true }).click();
  await expect(page.getByTestId('context-load-only').getByRole('alert')).toContainText('原生加载回执未完整确认');
  await expect(page.getByTestId('context-load-receipt')).toHaveCount(0); expect(posts).toHaveLength(1);
});

test('context selection A-B-A refuses a late load receipt even when the final binding matches again', async ({ page, request }) => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => { await wait; return loadResult(input); });
  await control(request, { snapshot: snapshot({ conversations: [makeConversation(), makeConversation({ conversationId: 'other-conversation', bindingId: 'other-binding' })] }) });
  await page.goto('/'); await conversationPage(page); await page.getByRole('textbox', { name: '加载诊断输入', exact: true }).fill('合成诊断');
  await page.getByRole('button', { name: '加载只读上下文（不生成）', exact: true }).click(); await expect.poll(() => posts.length).toBe(1);
  await page.getByRole('button', { name: '查看对话 other-binding', exact: true }).click();
  await page.getByRole('button', { name: `查看对话 ${bindingId}`, exact: true }).click(); release();
  await expect(page.getByTestId('context-load-only').getByRole('alert')).toContainText('结果未显示');
  await expect(page.getByTestId('context-load-receipt')).toHaveCount(0); expect(posts).toHaveLength(1);
});

test('a safety epoch change clears the old load receipt and starts a new input identity without changing the text', async ({ page, request }) => {
  let epoch = 1;
  const posts = await intercept(page, input => loadResult(input, epoch));
  await page.goto('/'); await conversationPage(page); await page.getByRole('textbox', { name: '加载诊断输入', exact: true }).fill('相同的合成输入');
  const load = page.getByRole('button', { name: '加载只读上下文（不生成）', exact: true }); await load.click();
  await expect(page.getByTestId('context-load-receipt')).toContainText('已持久核对'); await expect(load).toBeEnabled();
  await refresh(page); await load.click(); await expect(load).toBeEnabled();
  expect(posts).toHaveLength(2); expect(posts[1].inputId).toBe(posts[0].inputId);
  epoch = 2; await control(request, { snapshot: snapshot({ conversations: [makeConversation({ sessionEpoch: epoch })] }) }); await refresh(page);
  await expect(page.getByTestId('context-load-receipt')).toHaveCount(0);
  await load.click(); await expect(page.getByTestId('context-load-receipt')).toContainText('已持久核对');
  expect(posts).toHaveLength(3); expect(posts[2].inputId).not.toBe(posts[0].inputId); expect(posts[2].text).toBe(posts[0].text);
});
