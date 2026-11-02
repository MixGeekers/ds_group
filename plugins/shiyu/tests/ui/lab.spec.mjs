import { test, expect } from '@playwright/test';
import { makeSnapshot } from './fixtures.js';

// Synthetic snapshots and command receipts only: no model, host or Lab calls.
const connectionId = 'lab-connection-a', otherId = 'lab-connection-b';
const token = 'SYNTHETIC_PRIVATE_TARGET_TOKEN'.padEnd(43, '_');
const forbidden = 'NEVER_RENDER_INPUT_OR_DRAFT_TEXT';
const budget = { tokens: 65536, calls: 4, effects: 4 };
const now = () => new Date().toISOString();
const expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
function makeSend(overrides = {}) {
  return { sendId: 'lab-send-a', channelId: 'GROUP_A', replyId: 'reply-a', draftOperationId: 'draft-a', bodyHash: 'a'.repeat(64), bodyBytes: 29,
    status: 'unknown', canReconcile: true, ...overrides };
}
function deliveredSend(overrides = {}) {
  const send = makeSend(overrides);
  return { ...send, canReconcile: false, status: 'succeeded',
    observation: { eventId: 'LAB_RUN:77', channelId: send.channelId, opId: send.sendId, bodyHash: send.bodyHash, observedAt: now() } };
}
function makeConnection(overrides = {}) {
  return { connectionId, requestId: 'lab-request-a', runId: 'LAB_RUN', version: 3, epoch: 1, status: 'connected', live: true, budget,
    expiresAt: expiresAt(), createdAt: now(), updatedAt: now(),
    channels: [{ channelId: 'GROUP_A', kind: 'group', membersDigest: 'b'.repeat(64), conversationId: 'conversation-group', inputVersion: 4, cursor: 9,
      latestInput: { eventId: 'LAB_RUN:9', channelId: 'GROUP_A', seq: 9, bodyHash: 'c'.repeat(64), bodyBytes: 12, text: forbidden }, pendingCount: 1 },
    { channelId: 'DM_B', kind: 'direct', membersDigest: 'd'.repeat(64), conversationId: 'conversation-dm', inputVersion: 1, cursor: 10, pendingCount: 0 }],
    balance: { limits: budget, spent: { tokens: 19, calls: 1, effects: 0 }, held: { tokens: 16384, calls: 1, effects: 1 }, available: { tokens: 49133, calls: 2, effects: 3 } },
    replies: [{ replyId: 'reply-a', channelId: 'GROUP_A', anchorEventId: 'LAB_RUN:9', status: 'accounted', text: forbidden }],
    sends: [makeSend()], ...overrides };
}
const snapshot = (connections = [makeConnection()], overrides = {}) => ({ ...makeSnapshot(), lab: { ready: true, connections }, ...overrides });
const control = async (request, data) => { expect((await request.post('/__test/control', { data })).ok()).toBe(true); };
async function intercept(page, handler = () => ({ error: 'Unexpected Lab command' })) {
  const posts = [];
  await page.route('**/api/shiyu/commands', async route => {
    const input = route.request().postDataJSON();
    if (!input.action?.startsWith('lab.')) return route.fallback();
    posts.push(input); const result = await handler(input);
    await route.fulfill({ status: result.error ? 503 : 200, contentType: 'application/json', body: JSON.stringify(result) });
  }); return posts;
}
async function open(page) { await page.goto('/'); await page.getByRole('button', { name: 'Lab 连接', exact: true }).click(); await expect(page.getByTestId('lab-state')).toBeVisible(); }
async function select(page, id = connectionId) { await page.getByRole('button', { name: `查看连接 ${id}`, exact: true }).click(); }
async function refresh(page) { await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled(); }
async function draft(page) {
  await page.getByRole('textbox', { name: 'Lab Run ID', exact: true }).fill('LAB_RUN');
  await page.getByLabel('目标连接令牌', { exact: true }).fill(token);
  await page.getByRole('textbox', { name: '获准频道 ID', exact: true }).fill('GROUP_A, DM_B');
}
const connectResult = input => ({ connection: makeConnection({ requestId: input.requestId, runId: input.runId, expiresAt: input.expiresAt, budget: input.budget,
  channels: input.channelIds.map((channelId, i) => ({ channelId, kind: i ? 'direct' : 'group', conversationId: `conversation-${i}`, inputVersion: 0, cursor: 0, pendingCount: 0 })) }), duplicate: false });
const mutation = input => ({ connection: makeConnection({ connectionId: input.connectionId, version: input.expectedVersion,
  status: input.action === 'lab.pause' ? 'paused' : input.action === 'lab.disconnect' ? 'disconnected' : 'connected' }) });
test.beforeEach(async ({ request }) => { await control(request, { reset: true, snapshot: snapshot() }); });

test('Lab navigation and refresh are read-only; channel identities, drafts and actual delivery stay distinct in narrow Chinese and English layouts', async ({ page, request }, testInfo) => {
  const posts = await intercept(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  await control(request, { snapshot: snapshot([makeConnection({ targetToken: token, sends: [makeSend(), deliveredSend({ sendId: 'delivered-send' }),
    makeSend({ sendId: 'draft-only', status: 'pending', canReconcile: false, text: forbidden })] })]) });
  await open(page); await select(page); await refresh(page);
  const detail = page.getByTestId('lab-detail');
  for (const value of ['GROUP_A', 'DM_B', '群聊', '私聊', 'conversation-group', 'conversation-dm', '已核对草稿 ID', '生成用量已核算', '送达未知，保留占用', '已确认送达', '尚无送达证明']) await expect(detail).toContainText(value);
  await expect(page.locator('.syr')).not.toContainText(forbidden); await expect(page.locator('.syr')).not.toContainText(token);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('lab-sends').screenshot({ path: testInfo.outputPath('lab-mobile-zh-light.png') });
  expect(await page.locator('.syr').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.locator('#locale').click(); await page.locator('#theme').click();
  await expect(detail).toContainText('Direct message'); await expect(detail).toContainText('Delivery confirmed'); await expect(detail).toContainText('It never resends or calls a model');
  await page.getByTestId('lab-sends').screenshot({ path: testInfo.outputPath('lab-mobile-en-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.syr').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(posts).toEqual([]); expect(errors).toEqual([]);
});

test('owner form validates channels and budgets; absent or unready capability never connects', async ({ page, request }) => {
  const posts = await intercept(page); await open(page); const connect = page.getByRole('button', { name: '授权并连接', exact: true });
  await expect(connect).toBeDisabled(); await draft(page); await expect(connect).toBeEnabled();
  for (const value of ['GROUP_A GROUP_A', 'bad/channel', Array.from({ length: 21 }, (_, i) => `GROUP_${i}`).join(',')]) {
    await page.getByRole('textbox', { name: '获准频道 ID', exact: true }).fill(value); await expect(connect).toBeDisabled();
  }
  await page.getByRole('textbox', { name: '获准频道 ID', exact: true }).fill('GROUP_A DM_B');
  for (const [name, invalid, valid] of [['回复 Token 总上限', '0', '65536'], ['回复调用总上限', '1.5', '4'], ['消息总上限', '1001', '4']]) {
    await page.getByRole('spinbutton', { name, exact: true }).fill(invalid); await expect(connect).toBeDisabled(); await page.getByRole('spinbutton', { name, exact: true }).fill(valid);
  }
  for (const lab of [undefined, { ready: false, connections: [] }]) { await control(request, { snapshot: snapshot([], { lab }) }); await refresh(page); await expect(connect).toBeDisabled(); }
  expect(posts).toEqual([]);
});

test('connect submits one exact grant and clears its password immediately without browser persistence or optimistic delivery', async ({ page, request }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => { await waiting; return connectResult(input); });
  await control(request, { snapshot: snapshot([]) }); await open(page); await draft(page);
  const secret = page.getByLabel('目标连接令牌', { exact: true }); await expect(secret).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '授权并连接', exact: true }).evaluate(element => { element.click(); element.click(); });
  await expect.poll(() => posts.length).toBe(1); await expect(secret).toHaveValue('');
  expect(posts[0]).toMatchObject({ action: 'lab.connect', runId: 'LAB_RUN', targetToken: token, channelIds: ['GROUP_A', 'DM_B'], budget });
  expect(Object.keys(posts[0]).sort()).toEqual(['action', 'requestId', 'runId', 'targetToken', 'channelIds', 'budget', 'expiresAt'].sort());
  expect(Date.parse(posts[0].expiresAt)).toBeGreaterThan(Date.now() + 29 * 60_000);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }))).not.toContain(token);
  await refresh(page); expect(posts).toHaveLength(1); release(); await expect(page.getByTestId('lab-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: `查看连接 ${connectionId}`, exact: true })).toHaveCount(0);
  await expect(page.locator('.syr')).not.toContainText(token); await expect(page.getByTestId('lab-sends')).toHaveCount(0);
});

test('uncertain connects hide transport secrets, preserve grant identity and never retry on refresh', async ({ page }) => {
  const messages = []; page.on('console', msg => messages.push(msg.text()));
  const posts = await intercept(page, () => ({ error: `Transport echoed ${token}` })); await open(page); await draft(page);
  await page.getByRole('button', { name: '授权并连接', exact: true }).click(); await expect(page.getByTestId('lab-error')).toContainText('结果未确认');
  await expect(page.locator('.syr')).not.toContainText(token); await refresh(page); expect(posts).toHaveLength(1);
  await page.getByLabel('目标连接令牌', { exact: true }).fill(token); await page.getByRole('button', { name: '授权并连接', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2); expect(posts[1]).toEqual(posts[0]); await expect(page.getByRole('button', { name: '授权并连接', exact: true })).toBeDisabled();
  expect(messages.join('\n')).not.toContain(token);
});

test('leaving the Lab page or observing a replacement instance clears an unsubmitted token', async ({ page, request }) => {
  const posts = await intercept(page); await open(page); await draft(page);
  await page.getByRole('button', { name: '概览', exact: true }).click(); await page.getByRole('button', { name: 'Lab 连接', exact: true }).click();
  await expect(page.getByLabel('目标连接令牌', { exact: true })).toHaveValue(''); await page.getByLabel('目标连接令牌', { exact: true }).fill(token);
  await control(request, { snapshot: snapshot(undefined, { instanceId: 'new-runtime' }) }); await refresh(page);
  await expect(page.getByLabel('目标连接令牌', { exact: true })).toHaveValue(''); expect(posts).toEqual([]);
});

test('Runtime pause still permits connection pause and disconnect, without optimistic status changes', async ({ page, request }) => {
  const posts = await intercept(page, mutation); await control(request, { snapshot: snapshot(undefined, { state: 'paused' }) }); await open(page); await select(page); await draft(page);
  await expect(page.getByRole('button', { name: '授权并连接', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '暂停连接', exact: true }).click(); await expect(page.getByTestId('lab-notice')).toBeVisible();
  await expect(page.getByTestId('lab-detail').getByText('连接状态', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('已连接');
  await page.getByRole('button', { name: '断开连接', exact: true }).click(); await expect.poll(() => posts.length).toBe(2);
  expect(posts).toEqual([{ action: 'lab.pause', connectionId, expectedVersion: 3 }, { action: 'lab.disconnect', connectionId, expectedVersion: 3 }]);
});

test('explicit receipt lookup can observe expired or superseded sends and does not claim delivery for an unknown receipt', async ({ page, request }) => {
  const expired = makeConnection({ expiresAt: new Date(Date.now() - 1000).toISOString(), status: 'paused' });
  const posts = await intercept(page, () => ({ connection: expired }));
  await control(request, { snapshot: snapshot([expired], { state: 'paused' }) }); await open(page); await select(page);
  const reconcile = page.getByRole('button', { name: '显式核对未知发送', exact: true }); await expect(reconcile).toBeEnabled();
  await expect(page.getByTestId('lab-sends')).toContainText('不重新发送或调用模型'); await reconcile.click(); await expect(page.getByTestId('lab-notice')).toBeVisible();
  await expect(page.getByTestId('lab-sends')).toContainText('送达未知，保留占用'); await expect(page.getByTestId('lab-sends')).not.toContainText('已确认送达');
  await refresh(page); expect(posts).toEqual([{ action: 'lab.reconcile', connectionId, sendId: 'lab-send-a', expectedVersion: 3 }]);
});

test('reconciliation eligibility and fresh snapshots are rechecked; a bare success flag is not delivery evidence', async ({ page, request }) => {
  const posts = await intercept(page); await open(page); await select(page);
  await control(request, { snapshot: snapshot([makeConnection({ sends: [makeSend({ canReconcile: false })] })]) }); await refresh(page);
  await expect(page.getByRole('button', { name: '显式核对未知发送', exact: true })).toBeDisabled();
  await control(request, { snapshot: snapshot([makeConnection({ live: false })]) }); await refresh(page);
  await expect(page.getByRole('button', { name: '显式核对未知发送', exact: true })).toBeDisabled();
  await expect(page.getByTestId('lab-detail')).toContainText('未连接');
  await control(request, { snapshot: snapshot() }); await refresh(page); await control(request, { failReads: true }); await refresh(page);
  await expect(page.getByRole('button', { name: '显式核对未知发送', exact: true })).toBeDisabled();
  await control(request, { failReads: false, snapshot: snapshot([makeConnection({ sends: [makeSend({ status: 'succeeded' }),
    { ...deliveredSend({ sendId: 'mismatched' }), observation: { ...deliveredSend().observation, opId: 'wrong-operation' } }] })]) }); await refresh(page);
  await expect(page.getByTestId('lab-sends')).not.toContainText('已确认送达'); expect(posts).toEqual([]);
});

test('a confirmed connection allows a later explicit new grant while unknown requests keep their original identity', async ({ page, request }) => {
  const posts = await intercept(page, connectResult); await control(request, { snapshot: snapshot([]) }); await open(page); await draft(page);
  await page.getByRole('button', { name: '授权并连接', exact: true }).click(); await expect(page.getByTestId('lab-notice')).toBeVisible();
  await page.getByLabel('目标连接令牌', { exact: true }).fill(token); await page.getByRole('button', { name: '授权并连接', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2); await expect(page.getByTestId('lab-notice')).toBeVisible();
  expect(posts[1].requestId).not.toBe(posts[0].requestId); await expect(page.getByLabel('目标连接令牌', { exact: true })).toHaveValue('');
});

test('an outstanding receipt lookup does not block pausing and neither request is double-dispatched', async ({ page }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => { if (input.action === 'lab.reconcile') { await waiting; return { error: 'Synthetic interrupted lookup' }; } return mutation(input); });
  await open(page); await select(page);
  await page.getByRole('button', { name: '显式核对未知发送', exact: true }).evaluate(button => { button.click(); button.click(); }); await expect.poll(() => posts.length).toBe(1);
  await page.getByRole('button', { name: '暂停连接', exact: true }).evaluate(button => { button.click(); button.click(); }); await expect.poll(() => posts.length).toBe(2);
  await expect(page.getByTestId('lab-notice')).toBeVisible(); await refresh(page); expect(posts).toHaveLength(2); release();
  await expect(page.getByTestId('lab-error')).toContainText('结果未确认'); expect(posts.map(input => input.action)).toEqual(['lab.reconcile', 'lab.pause']);
});

test('a late connect receipt cannot select a connection after the user changes selection A-B-A', async ({ page, request }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => { await waiting; return connectResult(input); });
  await control(request, { snapshot: snapshot([makeConnection(), makeConnection({ connectionId: otherId })]) }); await open(page); await select(page); await draft(page);
  await page.getByRole('button', { name: '授权并连接', exact: true }).click(); await expect.poll(() => posts.length).toBe(1);
  await select(page, otherId); await select(page); release(); await expect(page.getByTestId('lab-error')).toContainText('旧回执未采用');
  await expect(page.getByTestId('lab-notice')).toHaveCount(0); await refresh(page); expect(posts).toHaveLength(1);
});

for (const mode of ['selection', 'instance', 'version']) {
  test(`late connection controls are rejected after ${mode} changes, including A-B-A`, async ({ page, request }) => {
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const connections = [makeConnection(), makeConnection({ connectionId: otherId, runId: 'OTHER_RUN' })];
    const posts = await intercept(page, async input => { await waiting; return mutation(input); });
    await control(request, { snapshot: snapshot(connections) }); await open(page); await select(page);
    await page.getByRole('button', { name: '暂停连接', exact: true }).click(); await expect.poll(() => posts.length).toBe(1);
    if (mode === 'selection') { await select(page, otherId); await select(page); }
    else { await control(request, { snapshot: mode === 'instance' ? snapshot(connections, { instanceId: 'replacement' }) : snapshot([{ ...connections[0], version: 4 }, connections[1]]) }); await refresh(page); }
    release(); await expect(page.getByTestId('lab-error')).toContainText('旧回执未采用'); await expect(page.getByTestId('lab-notice')).toHaveCount(0);
    await refresh(page); expect(posts).toHaveLength(1);
  });
}

test('wrong connection and mismatched send receipts stay unconfirmed; only a later GET confirms actual delivery', async ({ page, request }) => {
  let mode = 'wrong';
  const posts = await intercept(page, () => ({ connection: mode === 'wrong' ? makeConnection({ connectionId: otherId }) : mode === 'mismatch'
    ? makeConnection({ sends: [deliveredSend({ draftOperationId: 'different-draft' })] }) : makeConnection({ sends: [deliveredSend()] }) }));
  await open(page); await select(page);
  for (const next of ['wrong', 'mismatch', 'valid']) {
    mode = next; await page.getByRole('button', { name: '显式核对未知发送', exact: true }).click();
    await expect(page.getByTestId(next === 'valid' ? 'lab-notice' : 'lab-error')).toBeVisible();
    await expect(page.getByTestId('lab-sends')).toContainText('送达未知，保留占用');
  }
  await control(request, { snapshot: snapshot([makeConnection({ sends: [deliveredSend()] })]) }); await refresh(page);
  await expect(page.getByTestId('lab-sends')).toContainText('已确认送达'); expect(posts).toHaveLength(3);
});

test('historical receipt access uses the exact expired intent while globally paused, without starting work or optimistic transport state', async ({ page, request }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const historical = makeConnection({ requestId: 'historical-request', runId: 'HISTORICAL_RUN', status: 'needs_reconnect', live: false,
    expiresAt: new Date(Date.now() - 3600_000).toISOString(), budget: { tokens: 32768, calls: 2, effects: 1 }, channels: makeConnection().channels.reverse() });
  const posts = await intercept(page, async () => { await waiting; return { connection: { ...historical, live: true }, duplicate: true }; });
  await control(request, { snapshot: snapshot([historical], { state: 'paused', diagnostics: { contextSafety: { ready: false } } }) }); await open(page); await select(page);
  // An unrelated, incomplete new-grant draft must never replace the old intent.
  await page.getByRole('textbox', { name: 'Lab Run ID', exact: true }).fill('UNRELATED_NEW_RUN');
  await page.getByRole('textbox', { name: '获准频道 ID', exact: true }).fill('UNRELATED_CHANNEL');
  await page.getByRole('spinbutton', { name: '消息总上限', exact: true }).fill('99');
  await page.getByRole('combobox', { name: '有效期', exact: true }).selectOption('60');
  await page.getByLabel('目标连接令牌', { exact: true }).fill(token);
  await expect(page.getByRole('button', { name: '授权并连接', exact: true })).toBeDisabled();
  const attach = page.getByRole('button', { name: '连接回执查询', exact: true }); await expect(attach).toBeEnabled();
  await attach.evaluate(button => { button.click(); button.click(); }); await expect.poll(() => posts.length).toBe(1);
  await expect(page.getByLabel('目标连接令牌', { exact: true })).toHaveValue('');
  expect(posts[0]).toEqual({ action: 'lab.connect', requestId: historical.requestId, runId: historical.runId, targetToken: token,
    channelIds: ['DM_B', 'GROUP_A'], budget: historical.budget, expiresAt: historical.expiresAt });
  await refresh(page); expect(posts).toHaveLength(1); release(); await expect(page.getByTestId('lab-notice')).toContainText('仅接入回执查询');
  await expect(page.getByTestId('lab-detail').getByText('当前传输接入', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('未连接');
  await expect(page.getByRole('button', { name: '显式核对未知发送', exact: true })).toBeDisabled();
  await control(request, { snapshot: snapshot([{ ...historical, live: true }], { state: 'paused' }) }); await refresh(page);
  await expect(attach).toBeDisabled(); await expect(page.getByRole('button', { name: '显式核对未知发送', exact: true })).toBeEnabled();
  expect(posts).toHaveLength(1); await expect(page.locator('.syr')).not.toContainText(token);
});

test('historical access rejects nonduplicate, different-connection and changed-intent receipts without creating a new request', async ({ page, request }) => {
  const historical = makeConnection({ status: 'needs_reconnect', live: false }); let mode = 'new-grant';
  const posts = await intercept(page, () => ({ duplicate: mode !== 'new-grant', connection: { ...historical, live: true,
    ...(mode === 'wrong-id' ? { connectionId: otherId } : mode === 'changed-intent' ? { expiresAt: new Date(Date.parse(historical.expiresAt) + 1000).toISOString() } : {}) } }));
  await control(request, { snapshot: snapshot([historical], { state: 'paused' }) }); await open(page); await select(page);
  for (const value of ['new-grant', 'wrong-id', 'changed-intent']) {
    mode = value; await page.getByLabel('目标连接令牌', { exact: true }).fill(token);
    await page.getByRole('button', { name: '连接回执查询', exact: true }).click(); await expect(page.getByTestId('lab-error')).toContainText('结果未确认');
    await expect(page.getByTestId('lab-notice')).toHaveCount(0); await expect(page.getByRole('button', { name: '显式核对未知发送', exact: true })).toBeDisabled();
  }
  expect(posts).toHaveLength(3); expect(posts[1]).toEqual(posts[0]); expect(posts[2]).toEqual(posts[0]);
});

for (const mode of ['selection', 'version']) {
  test(`historical access rejects a late ${mode} response and never silently creates a fresh grant`, async ({ page, request }) => {
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const historical = makeConnection({ status: 'needs_reconnect', live: false });
    const connections = [historical, makeConnection({ connectionId: otherId })];
    const posts = await intercept(page, async () => { await waiting; return { connection: { ...historical, live: true }, duplicate: true }; });
    await control(request, { snapshot: snapshot(connections, { state: 'paused' }) }); await open(page); await select(page);
    await page.getByLabel('目标连接令牌', { exact: true }).fill(token); await page.getByRole('button', { name: '连接回执查询', exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    if (mode === 'selection') { await select(page, otherId); await select(page); }
    else { await control(request, { snapshot: snapshot([{ ...historical, version: historical.version + 1 }, connections[1]], { state: 'paused' }) }); await refresh(page); }
    release(); await expect(page.getByTestId('lab-error')).toContainText('旧回执未采用'); await expect(page.getByTestId('lab-notice')).toHaveCount(0);
    await refresh(page); expect(posts).toHaveLength(1); expect(posts[0].requestId).toBe(historical.requestId);
  });
}

test('missing historical intent or stale state disables receipt access instead of falling back to a new authorization', async ({ page, request }) => {
  const posts = await intercept(page); const historical = makeConnection({ status: 'needs_reconnect', live: false });
  await control(request, { snapshot: snapshot([historical], { state: 'paused' }) }); await open(page); await select(page);
  await page.getByLabel('目标连接令牌', { exact: true }).fill(token); const attach = page.getByRole('button', { name: '连接回执查询', exact: true }); await expect(attach).toBeEnabled();
  for (const missing of [{ requestId: undefined }, { expiresAt: undefined }, { budget: undefined }, { channels: [] }]) {
    await control(request, { snapshot: snapshot([{ ...historical, ...missing }], { state: 'paused' }) }); await refresh(page); await expect(attach).toBeDisabled();
  }
  await control(request, { snapshot: snapshot([historical], { state: 'paused' }) }); await refresh(page); await control(request, { failReads: true }); await refresh(page);
  await expect(attach).toBeDisabled(); expect(posts).toEqual([]);
});

test('oversized groups and input backlog explain retained inputs and the affected channel pause in both locales', async ({ page, request }) => {
  const posts = await intercept(page);
  for (const [errorCode, chinese, english] of [
    ['LAB_GROUP_TOO_LARGE', '待合并输入过大', 'pending input group is too large'],
    ['LAB_INPUT_BACKPRESSURE', '待答输入积压超限', 'pending input backlog exceeds its limit'],
  ]) {
    await control(request, { snapshot: snapshot(undefined, { lab: { ready: true, pump: { state: 'degraded', activeReplies: 1, errorCode }, connections: [makeConnection()] } }) });
    await open(page); const notice = page.getByTestId('lab-input-limit');
    await expect(notice).toContainText(chinese); await expect(notice).toContainText('原始输入保留'); await expect(notice).toContainText('其他获准频道可继续');
    await page.locator('#locale').click(); await expect(notice).toContainText(english); await expect(notice).toContainText('Original inputs are retained');
    await expect(notice).toContainText('other permitted channels can continue'); await page.locator('#locale').click(); await refresh(page);
  }
  expect(posts).toEqual([]);
});
