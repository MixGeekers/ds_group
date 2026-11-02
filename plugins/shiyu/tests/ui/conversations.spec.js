import { test, expect } from '@playwright/test';
import { makeConversation, makeConversationBackground, makeLocalTask, makeSnapshot, makeSucceededLocalTask } from './fixtures.js';

const taskId = 'test-local-task-1';
const linkName = '关联本地任务';
const pendingName = '正在受理关联…';
const unconfirmed = '关联回执未完整确认本次任务、Conversation 和绑定；结果未确认。请刷新核对，不会自动重试。';
const notInSnapshot = '当前快照尚未包含回执对应的对话绑定；关联状态仍待核对。';
const command = { action: 'conversation.linkLocalTask', taskId };
const localTask = (id = taskId, updatedAt = new Date().toISOString()) => ({ ...makeLocalTask(id), inputRefs: [`local-input:${id}`], updatedAt });
const snapshot = overrides => ({ ...makeSnapshot(), tasks: [localTask()], conversations: [], background: makeConversationBackground(), ...overrides });
const control = async (request, body) => { expect((await request.post('/__test/control', { data: body })).ok()).toBe(true); };
const stats = async request => (await request.get('/__test/stats')).json();
const value = (region, label) => region.getByText(label, { exact: true }).first().locator('xpath=following-sibling::dd[1]');
const refresh = async page => {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
};
async function open(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByTestId('conversation-link')).toBeVisible();
}
// Capture even unknown commands: an accidental acknowledge POST must not hide
// behind the fake API's allowlist or a rejected response.
function commandRequests(page) {
  const posted = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/shiyu/commands') posted.push(request.postDataJSON());
  });
  return posted;
}

test.beforeEach(async ({ request }) => { await control(request, { reset: true, snapshot: snapshot() }); });

test('missing and empty projections remain distinct and never create or acknowledge automatically', async ({ page, request }) => {
  const posted = commandRequests(page);
  await control(request, { snapshot: { ...makeSnapshot(), tasks: [localTask()] } });
  await open(page);
  await expect(page.getByText('对话视图尚未接入', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeDisabled();
  await control(request, { snapshot: snapshot({ tasks: [] }) });
  await refresh(page);
  await expect(page.getByText('暂无本地对话记录', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeDisabled();
  await expect(page.getByTestId('conversation-link')).toContainText('请先运行本地任务验证；任务无需已完成。');
  expect(posted).toEqual([]);
});

test('control metadata remains read-only across refresh, polling and bilingual narrow views', async ({ page, request }, testInfo) => {
  const posted = commandRequests(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  const entry = makeConversation();
  entry.body = 'BODY_CANARY_CONVERSATION';
  entry.sources[0].body = 'BODY_CANARY_SOURCE';
  entry.pending[0].body = 'BODY_CANARY_PENDING';
  entry.pending[0].evidenceRef = 'javascript:alert("synthetic-only")';
  entry.pending.push({ ...entry.pending[0], eventId: 'test-file-evidence-event', evidenceRef: 'file:///synthetic/private/note.txt' });
  await control(request, { snapshot: snapshot({ conversations: [entry], background: makeConversationBackground({ pending: 0, acknowledged: 9 }) }) });
  await open(page);
  await page.getByRole('button', { name: '查看对话 test-binding-1', exact: true }).click();
  const detail = page.getByTestId('conversation-detail'), pending = page.getByTestId('conversation-pending'), background = page.getByTestId('conversation-background');
  await expect(detail).toHaveAttribute('aria-label', '对话详情');
  await expect(value(detail, '固定受众范围')).toHaveText('local-owner');
  await expect(value(detail, '背景版本')).toHaveText('7');
  await expect(page.getByTestId('conversation-load-state')).toHaveText('背景信息待加载');
  await expect(value(page.getByTestId('conversation-sources'), '来源版本')).toHaveText('4');
  await expect(pending).toContainText('test-background-event-1');
  await expect(pending).toContainText('存在缺口，待核对');
  await expect(pending).toContainText('javascript:alert("synthetic-only")');
  await expect(pending).toContainText('file:///synthetic/private/note.txt');
  await expect(pending.locator('a,button')).toHaveCount(0);
  await expect(detail.locator('input,textarea,[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByTestId('conversation-link').locator('input,textarea,[contenteditable="true"]')).toHaveCount(0);
  await expect(value(background, '待投递')).toHaveText('0');
  await expect(value(background, '已落库确认')).toHaveText('9');
  await expect(page.locator('.syr')).not.toContainText('BODY_CANARY_');
  const reads = (await stats(request)).stateReads;
  await refresh(page);
  await page.clock.fastForward(10001);
  await expect.poll(async () => (await stats(request)).stateReads).toBeGreaterThan(reads + 1);
  await page.getByRole('button', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(page.getByTestId('conversation-load-state')).toHaveText('背景信息待加载');
  await expect(pending).toContainText('test-background-event-1');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('conversation-link').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('conversation-link-mobile-zh.png'), fullPage: true });
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('conversation-mobile-zh.png'), fullPage: true });
  await page.locator('#locale').click();
  await expect(page.getByRole('button', { name: 'Conversations', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation details', exact: true })).toBeVisible();
  await expect(value(detail, 'Fixed audience scope')).toHaveText('local-owner');
  await expect(page.getByTestId('conversation-load-state')).toHaveText('Background context awaiting load');
  await expect(page.getByRole('button', { name: 'Link local task', exact: true })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Task to link', exact: true })).toHaveValue(taskId);
  await page.getByTestId('conversation-link').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('conversation-link-mobile-en.png'), fullPage: true });
  await pending.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('conversation-mobile-en.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.syr').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(posted).toEqual([]);
  expect(errors).toEqual([]);
});

test('initial sources without increments do not imply loaded context, and unknown metadata stays unknown', async ({ page, request }) => {
  const posted = commandRequests(page);
  await control(request, { snapshot: snapshot({ conversations: [makeConversation({ contextVersion: 1, sources: [{ reference: { kind: 'task', id: taskId }, sourceVersion: 1 }], pending: [], needsSync: true })] }) });
  await open(page);
  await page.getByRole('button', { name: '查看对话 test-binding-1', exact: true }).click();
  await expect(page.getByTestId('conversation-load-state')).toHaveText('背景信息待加载');
  await expect(page.getByTestId('conversation-pending')).toContainText('暂无背景增量记录；当前来源仍可能尚未加载。');
  const unknown = makeConversation();
  delete unknown.needsSync; delete unknown.pending; delete unknown.sources;
  await control(request, { snapshot: snapshot({ conversations: [unknown] }) });
  await refresh(page);
  await expect(page.getByTestId('conversation-load-state')).toHaveText('背景加载状态未确认');
  await expect(page.getByTestId('conversation-pending')).toContainText('尚未提供待加载来源记录');
  await expect(page.getByTestId('conversation-sources')).toContainText('尚未提供来源记录');
  expect(posted).toEqual([]);
});

test('link uses the newest exact local marker even before task completion, then waits for a matching GET projection', async ({ page, request }) => {
  const posted = commandRequests(page), at = Date.now();
  const latest = { ...localTask('local-latest', new Date(at - 1000).toISOString()), state: 'running' };
  const tasks = [makeSucceededLocalTask('local-old', new Date(at - 5000).toISOString()), latest,
    { ...localTask('nonlocal', new Date(at).toISOString()), inputRefs: ['synthetic:input/request'] },
    { ...localTask('wrong-marker', new Date(at).toISOString()), inputRefs: ['local-input:wrong-marker-suffix'] },
    localTask('invalid-time', 'invalid')];
  await control(request, { snapshot: snapshot({ tasks }), conversationLink: { publish: false } });
  await open(page);
  await expect(page.getByTestId('conversation-link')).toContainText('(local-latest)');
  await refresh(page);
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: linkName, exact: true }).click();
  await expect(page.getByRole('status')).toContainText('任务关联请求已受理（local-latest）');
  await expect(page.getByRole('status')).toContainText('尚不表示背景已加载');
  await expect(page.getByText('暂无本地对话记录', { exact: true })).toBeVisible();
  await expect(page.getByText(notInSnapshot, { exact: true })).toBeVisible();
  await expect(page.getByTestId('conversation-detail')).toHaveCount(0);
  const entry = makeConversation({ conversationId: 'test-linked-conversation-1', bindingId: 'test-linked-binding-1', taskRefs: [{ taskId: latest.taskId, state: 'running', version: 4 }] });
  await control(request, { snapshot: snapshot({ tasks, conversations: [entry] }) });
  await refresh(page);
  await expect(page.getByTestId('conversation-detail')).toContainText('local-latest');
  await expect(page.getByTestId('conversation-load-state')).toHaveText('背景信息待加载');
  expect(posted).toEqual([{ action: 'conversation.linkLocalTask', taskId: latest.taskId }]);
  expect((await stats(request)).taskAdmissions).toBe(0);
});

test('explicit local task selection survives refresh and validates the selected task receipt', async ({ page, request }) => {
  const posted = commandRequests(page), at = Date.now();
  const older = makeSucceededLocalTask('local-older-succeeded', new Date(at - 5000).toISOString());
  const newer = { ...localTask('local-newer-unknown', new Date(at - 1000).toISOString()), state: 'unknown' };
  await control(request, { snapshot: snapshot({ tasks: [older, newer] }), conversationLink: { publish: false } });
  await open(page);
  const select = page.getByRole('combobox', { name: '本次关联任务', exact: true });
  await expect(select).toHaveValue(newer.taskId);
  await select.selectOption(older.taskId);
  await refresh(page);
  await expect(select).toHaveValue(older.taskId);
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: linkName, exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`任务关联请求已受理（${older.taskId}）`);
  await expect(page.getByText(notInSnapshot, { exact: true })).toBeVisible();
  await expect(page.getByTestId('conversation-detail')).toHaveCount(0);
  await expect(select).toHaveValue(older.taskId);
  // An otherwise valid receipt for the default/newest task is not confirmation
  // of the older task the user explicitly selected.
  await control(request, { conversationLink: { publish: false, overrides: { taskId: newer.taskId } } });
  await page.getByRole('button', { name: linkName, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(unconfirmed);
  await expect(page.getByRole('status')).toHaveCount(0);
  await control(request, { snapshot: snapshot({ tasks: [newer] }) });
  await refresh(page);
  await expect(select).toHaveValue('');
  await expect(page.getByTestId('conversation-link')).toContainText('选定任务不在当前快照中，请重新选择。');
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeDisabled();
  expect(posted).toEqual([{ action: 'conversation.linkLocalTask', taskId: older.taskId }, { action: 'conversation.linkLocalTask', taskId: older.taskId }]);
});

test('paused and stale states preserve read access and block new links', async ({ page, request }) => {
  const posted = commandRequests(page), entry = makeConversation();
  await control(request, { snapshot: snapshot({ state: 'paused', conversations: [entry] }) });
  await open(page);
  await page.getByRole('button', { name: '查看对话 test-binding-1', exact: true }).click();
  await expect(page.getByTestId('conversation-pending')).toContainText('test-background-event-1');
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeDisabled();
  await control(request, { snapshot: snapshot({ conversations: [entry] }) });
  await refresh(page);
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeEnabled();
  await control(request, { failReads: true });
  await refresh(page);
  await expect(page.getByTestId('snapshot-stale')).toBeVisible();
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeDisabled();
  await expect(page.getByTestId('conversation-pending')).toContainText('test-background-event-1');
  expect(posted).toEqual([]);
});

test('pending admission blocks duplicate links while pause keeps its independent channel', async ({ page, request }) => {
  const posted = commandRequests(page);
  await control(request, { conversationLink: { defer: true, error: true } });
  await open(page);
  await page.getByRole('button', { name: linkName, exact: true }).evaluate(element => { element.click(); element.click(); });
  await expect.poll(async () => (await stats(request)).pendingConversationLinks).toBe(1);
  await expect(page.getByRole('button', { name: pendingName, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '暂停运行', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '暂停运行', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeDisabled();
  await refresh(page);
  await control(request, { releaseConversationLink: true });
  await expect(page.getByRole('alert')).toContainText('合成测试：对话关联回执未确认。');
  await expect(page.getByRole('button', { name: '恢复运行', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeDisabled();
  expect(posted).toEqual([command, { action: 'runtime.pause' }]);
});

test('out-of-scope records are hidden and unknown runtime state cannot initiate a link', async ({ page, request }) => {
  const posted = commandRequests(page);
  await control(request, { snapshot: snapshot({ state: 'unknown', conversations: [makeConversation({ scope: 'other-audience', localConversationKey: 'FOREIGN_CANARY_RECORD' })] }) });
  await open(page);
  await expect(page.getByText('快照包含范围未确认的对话记录；未展示该记录。', { exact: true })).toBeVisible();
  await expect(page.locator('.syr')).not.toContainText('FOREIGN_CANARY_RECORD');
  await expect(page.getByTestId('conversation-list')).toHaveCount(0);
  await expect(page.getByRole('button', { name: linkName, exact: true })).toBeDisabled();
  expect(posted).toEqual([]);
});

for (const field of ['accepted', 'taskId', 'conversationId', 'bindingId']) {
  test(`link admission remains unconfirmed without ${field}`, async ({ page, request }) => {
    const posted = commandRequests(page);
    await control(request, { conversationLink: { publish: false, omit: [field] } });
    await open(page);
    await page.getByRole('button', { name: linkName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(unconfirmed);
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByTestId('conversation-detail')).toHaveCount(0);
    await refresh(page);
    expect(posted).toEqual([command]);
  });
}

for (const [label, overrides] of [
  ['false acceptance', { accepted: false }], ['another task', { taskId: 'other-task' }],
  ['empty conversation ID', { conversationId: '' }], ['blank binding ID', { bindingId: ' ' }],
]) {
  test(`link admission rejects ${label} without retry or snapshot insertion`, async ({ page, request }) => {
    const posted = commandRequests(page);
    await control(request, { conversationLink: { publish: false, overrides } });
    await open(page);
    await page.getByRole('button', { name: linkName, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(unconfirmed);
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByTestId('conversation-detail')).toHaveCount(0);
    expect(posted).toEqual([command]);
  });
}

for (const [label, entry] of [
  ['unrelated task in a matching binding', makeConversation({ taskRefs: [{ taskId: 'unrelated-task', state: 'running', version: 1 }] })],
  ['mismatched conversation ID', makeConversation({ conversationId: 'different-conversation' })],
  ['mismatched binding ID', makeConversation({ bindingId: 'different-binding' })],
]) {
  test(`accepted receipt does not auto-select ${label}`, async ({ page, request }) => {
    const posted = commandRequests(page);
    await control(request, { snapshot: snapshot({ conversations: [entry] }), conversationLink: { publish: false, overrides: { conversationId: 'test-conversation-1', bindingId: 'test-binding-1' } } });
    await open(page);
    await page.getByRole('button', { name: linkName, exact: true }).click();
    await expect(page.getByRole('status')).toContainText('任务关联请求已受理');
    await expect(page.getByText(notInSnapshot, { exact: true })).toBeVisible();
    await expect(page.getByTestId('conversation-detail')).toHaveCount(0);
    expect(posted).toEqual([command]);
  });
}
