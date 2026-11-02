import { test, expect } from '@playwright/test';
import { makeSnapshot, makeTask } from './fixtures.js';

// Synthetic metadata only. No DSH, model, Task admission or real owner grant is used.
const goalId = 'test-core-goal-1', otherGoalId = 'test-core-goal-2';
const createName = '创建并授权本地目标', objective = '合成目标：整理两张本地便签';
const budget = { tokens: 131072, calls: 12, effects: 3 };
const forbiddenBody = 'NEVER_RENDER_CORE_DELIVERABLE_BODY';
const now = () => new Date().toISOString();
function makeGoal(overrides = {}) {
  return {
    schemaVersion: 1, goalId, requestId: 'synthetic-owner-request', objective,
    deliverables: [{ id: 'note-1', title: '合成便签一', bodyBytes: 36, dependsOn: [] }],
    budget: { ...budget }, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), maxEvaluations: 4,
    completionCriteria: '独立核验每张授权便签的产物和效果回执', completionCriteriaHash: 'a'.repeat(64),
    version: 3, authorized: true, paused: false, cancelled: false, controlEpoch: 1,
    mandateId: 'synthetic-owner-mandate',
    native: { goalId, goalRef: { id: 'synthetic-native-goal', revision: 2 }, sessionId: 'synthetic-core-session', phase: 'active', observedAt: now() },
    taskRefs: [], evaluations: 0, evaluationsLog: [],
    balance: { limits: { ...budget }, spent: { tokens: 0, calls: 0, effects: 0 }, held: { tokens: 0, calls: 0, effects: 0 }, available: { ...budget } },
    createdAt: now(), updatedAt: now(), ...overrides,
  };
}
function snapshot(goals = [makeGoal()], overrides = {}) {
  return { ...makeSnapshot(), core: { ready: true, pump: { state: 'idle', running: false }, goals }, ...overrides };
}
function createdGoal(input, overrides = {}) {
  return makeGoal({ requestId: input.requestId, objective: input.objective, budget: input.budget, expiresAt: input.expiresAt,
    maxEvaluations: input.maxEvaluations, deliverables: input.deliverables.map(({ content, ...item }) => ({ ...item, bodyBytes: Buffer.byteLength(content) })), ...overrides });
}
const control = async (request, data) => { expect((await request.post('/__test/control', { data })).ok()).toBe(true); };
async function intercept(page, handler = () => ({ error: 'Unexpected synthetic core command' })) {
  const posts = [];
  await page.route('**/api/shiyu/commands', async route => {
    const input = route.request().postDataJSON(); posts.push(input);
    if (!input.action?.startsWith('core.')) return route.fallback();
    const result = await handler(input);
    await route.fulfill({ status: result.error ? 503 : 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  return posts;
}
async function open(page) {
  await page.goto('/'); await page.getByRole('button', { name: '目标与判断', exact: true }).click();
  await expect(page.getByTestId('core-state')).toBeVisible();
}
async function select(page, id = goalId) { await page.getByRole('button', { name: `查看目标 ${id}`, exact: true }).click(); }
async function refresh(page) {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
}
async function draft(page) {
  await page.getByRole('textbox', { name: '目标说明', exact: true }).fill(objective);
  await page.getByRole('textbox', { name: '便签 1 标题', exact: true }).fill('合成便签一');
  await page.getByRole('textbox', { name: '便签 1 正文', exact: true }).fill('第一张合成便签正文。');
}
const mutation = (input, overrides = {}) => ({ goal: makeGoal({ goalId: input.goalId, version: input.expectedVersion,
  paused: input.action === 'core.pause', cancelled: input.action === 'core.cancel', ...overrides }) });
test.beforeEach(async ({ request }) => { await control(request, { reset: true, snapshot: snapshot() }); });

test('Goal navigation and refresh remain read-only, metadata excludes bodies, and both narrow locales fit', async ({ page, request }, testInfo) => {
  const posts = await intercept(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  const goal = makeGoal({ deliverables: [{ id: 'note-1', title: '合成便签一', bodyBytes: 36, content: forbiddenBody, dependsOn: [] }] });
  await control(request, { snapshot: snapshot([goal]) }); await open(page); await select(page); await refresh(page);
  const detail = page.getByTestId('core-detail');
  for (const value of [goalId, objective, 'note-1', 'synthetic-native-goal', 'synthetic-core-session']) await expect(detail).toContainText(value);
  await expect(page.getByTestId('core-budget')).toContainText(/131,?072/);
  await expect(page.getByTestId('core-budget')).toContainText('实际用量可能超额，核实后停止');
  await expect(page.locator('.syr')).not.toContainText(forbiddenBody);
  expect(posts).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('core-native').screenshot({ path: testInfo.outputPath('core-mobile-zh-light.png') });
  await page.getByTestId('core-budget').screenshot({ path: testInfo.outputPath('core-budget-mobile-zh-light.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#locale').click(); await page.locator('#theme').click();
  await expect(detail).toContainText('synthetic-native-goal');
  await expect(page.getByTestId('core-budget')).toContainText('Actual usage may exceed it');
  await expect(page.getByRole('button', { name: createName, exact: true })).toHaveCount(0);
  await page.getByTestId('core-native').screenshot({ path: testInfo.outputPath('core-mobile-en-dark.png') });
  await page.getByTestId('core-budget').screenshot({ path: testInfo.outputPath('core-budget-mobile-en-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.syr').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(posts).toEqual([]); expect(errors).toEqual([]);
});

test('missing or failed Core capability never enables a new owner grant', async ({ page, request }) => {
  const posts = await intercept(page); await open(page); await draft(page);
  for (const core of [undefined, { ready: false, goals: [] }, { ready: false, errorCode: 'SYNTHETIC_CORE_UNAVAILABLE', goals: [] }]) {
    await control(request, { snapshot: snapshot([], { core }) }); await refresh(page);
    await expect(page.getByRole('button', { name: createName, exact: true })).toBeDisabled();
    if (core?.errorCode) await expect(page.getByTestId('core-state')).toContainText(core.errorCode);
  }
  expect(posts).toEqual([]);
});

test('owner form rejects empty content, unknown or cyclic dependencies and invalid budgets without POST', async ({ page }) => {
  const posts = await intercept(page); await open(page);
  const create = page.getByRole('button', { name: createName, exact: true });
  await expect(create).toBeDisabled(); await draft(page); await expect(create).toBeEnabled();
  const dependency = page.getByRole('textbox', { name: '便签 1 依赖', exact: true });
  for (const value of ['missing-note', 'note-1']) { await dependency.fill(value); await expect(create).toBeDisabled(); }
  await dependency.fill('');
  await page.getByRole('button', { name: '添加便签', exact: true }).click();
  await page.getByRole('textbox', { name: '便签 2 标题', exact: true }).fill('合成便签二');
  await page.getByRole('textbox', { name: '便签 2 正文', exact: true }).fill('第二张合成正文。');
  await page.getByRole('textbox', { name: '便签 2 ID', exact: true }).fill('note-1'); await expect(create).toBeDisabled();
  await page.getByRole('textbox', { name: '便签 2 ID', exact: true }).fill('note-2');
  await dependency.fill('note-2'); await page.getByRole('textbox', { name: '便签 2 依赖', exact: true }).fill('note-1');
  await expect(create).toBeDisabled(); await dependency.fill(''); await expect(create).toBeEnabled();
  for (const [name, invalid, valid] of [['总 Token 上限', '-1', '131072'], ['总 Token 上限', '100000001', '131072'], ['总调用上限', '0', '12'], ['总调用上限', '1001', '12'], ['总效果上限', '-1', '3'], ['最多判断次数', '101', '4']]) {
    const field = page.getByRole('spinbutton', { name, exact: true }); await field.fill(invalid); await expect(create).toBeDisabled(); await field.fill(valid);
  }
  await page.getByRole('textbox', { name: '便签 2 正文', exact: true }).fill('合'.repeat(342)); await expect(create).toBeDisabled();
  await page.getByRole('textbox', { name: '便签 2 正文', exact: true }).fill(''); await expect(create).toBeDisabled();
  await page.getByRole('button', { name: '移除便签', exact: true }).last().click(); await expect(create).toBeEnabled();
  expect(posts).toEqual([]);
});

test('creating a Goal sends one exact owner payload and receipt metadata cannot insert an optimistic Goal', async ({ page, request }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => { await waiting; return { goal: createdGoal(input), duplicate: false }; });
  await control(request, { snapshot: snapshot([]) }); await open(page); await draft(page);
  await page.getByRole('button', { name: '添加便签', exact: true }).click();
  await page.getByRole('textbox', { name: '便签 2 标题', exact: true }).fill('合成便签二');
  await page.getByRole('textbox', { name: '便签 2 正文', exact: true }).fill('第二张合成便签正文。');
  await page.getByRole('textbox', { name: '便签 2 依赖', exact: true }).fill('note-1');
  await page.getByTestId('core-form').getByRole('combobox').selectOption('30');
  const before = Date.now();
  await page.getByRole('button', { name: createName, exact: true }).evaluate(element => { element.click(); element.click(); });
  await expect.poll(() => posts.length).toBe(1);
  const input = posts[0];
  expect(Object.keys(input).sort()).toEqual(['action', 'budget', 'deliverables', 'expiresAt', 'maxEvaluations', 'objective', 'requestId']);
  expect(input).toMatchObject({ action: 'core.create', objective, budget, maxEvaluations: 4 });
  expect(input.requestId).toEqual(expect.any(String)); expect(input.requestId.trim()).not.toBe('');
  expect(input.deliverables).toEqual([
    { id: 'note-1', title: '合成便签一', content: '第一张合成便签正文。', dependsOn: [] },
    { id: 'note-2', title: '合成便签二', content: '第二张合成便签正文。', dependsOn: ['note-1'] },
  ]);
  expect(Date.parse(input.expiresAt)).toBeGreaterThanOrEqual(before + 30 * 60_000 - 2000);
  expect(Date.parse(input.expiresAt)).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 2000);
  await refresh(page); expect(posts).toHaveLength(1); release();
  await expect(page.getByTestId('core-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: `查看目标 ${goalId}`, exact: true })).toHaveCount(0);
  await control(request, { snapshot: snapshot([createdGoal(input)]) }); await refresh(page);
  await expect(page.getByRole('button', { name: `查看目标 ${goalId}`, exact: true })).toBeVisible();
  expect(posts).toHaveLength(1);
});

test('an uncertain create retains its request identity and expiry until the owner changes the draft', async ({ page }) => {
  const posts = await intercept(page, () => ({ error: '合成接纳结果未知；不要自动重试。' }));
  await open(page); await draft(page);
  const create = page.getByRole('button', { name: createName, exact: true });
  await create.click(); await expect(page.getByTestId('core-error')).toContainText('结果未知');
  await refresh(page); expect(posts).toHaveLength(1); await expect(create).toBeEnabled(); await create.click();
  await expect.poll(() => posts.length).toBe(2); await expect(create).toBeEnabled(); expect(posts[1]).toEqual(posts[0]);
  await page.getByRole('textbox', { name: '目标说明', exact: true }).fill(`${objective}（新授权草稿）`); await create.click();
  await expect.poll(() => posts.length).toBe(3); await expect(create).toBeEnabled();
  expect(posts[2].requestId).not.toBe(posts[0].requestId);
  await expect(page.getByTestId('core-notice')).toHaveCount(0);
});

test('candidate, accepted Task, native phase and unknown usage remain distinct facts', async ({ page, request }) => {
  const posts = await intercept(page);
  const candidate = { kind: 'task_intent', deliverableId: 'note-1', reason: '合成候选：仅选择已授权便签' };
  const goal = makeGoal({ evaluations: 2, taskRefs: [{ deliverableId: 'note-1', taskId: 'synthetic-accepted-task' }], evaluationsLog: [
    { evaluationId: 'synthetic-candidate-only', status: 'unknown', triggerRefs: ['synthetic-trigger-one'], candidate,
      reasonCode: 'SYNTHETIC_COVERAGE_UNKNOWN', usage: { complete: false, tokens: null, calls: null }, sessionId: 'synthetic-core-session' },
    { evaluationId: 'synthetic-accepted-evaluation', status: 'committed', triggerRefs: ['synthetic-trigger-two'], candidate,
      receipt: { evaluationId: 'synthetic-accepted-evaluation', proposalId: 'synthetic-proposal', kind: 'task_intent', status: 'committed', reasonCode: 'ACCEPTED', taskId: 'synthetic-accepted-task' },
      usage: { complete: true, tokens: 19, calls: 1 }, sessionId: 'synthetic-core-session' },
  ] });
  await control(request, { snapshot: snapshot([goal], { tasks: [makeTask({ taskId: 'synthetic-accepted-task', goalId, state: 'succeeded' })] }) });
  await open(page); await select(page);
  const log = page.getByTestId('core-evaluations');
  for (const value of ['synthetic-candidate-only', 'synthetic-trigger-one', 'SYNTHETIC_COVERAGE_UNKNOWN', 'synthetic-accepted-evaluation', 'synthetic-accepted-task']) await expect(log).toContainText(value);
  await expect(log).toContainText('未知');
  await expect(page.getByTestId('core-accepted-tasks')).toContainText('成功');
  const nativePhase = page.getByTestId('core-detail').getByText('原生阶段', { exact: true }).locator('xpath=following-sibling::dd[1]');
  await expect(nativePhase).toHaveText('有效');
  await expect(page.getByTestId('core-native').getByText('已完成', { exact: true })).toHaveCount(0);
  await refresh(page); expect(posts).toEqual([]);
});

test('owner pause and cancel remain available while Runtime is paused; Goal resume does not', async ({ page, request }) => {
  const posts = await intercept(page, input => mutation(input));
  await control(request, { snapshot: snapshot([makeGoal()], { state: 'paused' }) }); await open(page); await select(page);
  await expect(page.getByRole('button', { name: createName, exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '暂停目标', exact: true }).click(); await expect(page.getByTestId('core-notice')).toBeVisible();
  await page.getByRole('button', { name: '取消目标', exact: true }).click(); await expect.poll(() => posts.length).toBe(2);
  expect(posts).toEqual([{ action: 'core.pause', goalId, expectedVersion: 3 }, { action: 'core.cancel', goalId, expectedVersion: 3 }]);
  await control(request, { snapshot: snapshot([makeGoal({ paused: true })], { state: 'paused' }) }); await refresh(page);
  await expect(page.getByRole('button', { name: '恢复目标', exact: true })).toBeDisabled();
});

test('a pending create does not block the independent Goal pause lane and neither lane double-dispatches', async ({ page }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => input.action === 'core.create'
    ? (await waiting, { error: '合成创建回执未确认。' }) : mutation(input));
  await open(page); await select(page); await draft(page);
  await page.getByRole('button', { name: createName, exact: true }).click(); await expect.poll(() => posts.length).toBe(1);
  const pause = page.getByRole('button', { name: '暂停目标', exact: true }); await expect(pause).toBeEnabled();
  await pause.evaluate(element => { element.click(); element.click(); });
  await expect.poll(() => posts.length).toBe(2); await expect(page.getByTestId('core-notice')).toBeVisible();
  expect(posts[1]).toEqual({ action: 'core.pause', goalId, expectedVersion: 3 });
  await refresh(page); expect(posts).toHaveLength(2); release();
  await expect(page.getByTestId('core-error')).toContainText('未确认'); expect(posts).toHaveLength(2);
});

test('resume requires a fresh authorized unexpired noncancelled Goal and an active Runtime', async ({ page, request }) => {
  const posts = await intercept(page, input => mutation(input));
  const paused = makeGoal({ paused: true }); await control(request, { snapshot: snapshot([paused]) }); await open(page); await select(page);
  for (const goal of [makeGoal({ paused: true, authorized: false }), makeGoal({ paused: true, cancelled: true }), makeGoal({ paused: true, expiresAt: new Date(Date.now() - 1000).toISOString() })]) {
    await control(request, { snapshot: snapshot([goal]) }); await refresh(page);
    const resume = page.getByRole('button', { name: '恢复目标', exact: true });
    if (await resume.count()) await expect(resume).toBeDisabled();
  }
  await control(request, { snapshot: snapshot([paused]) }); await refresh(page);
  await control(request, { failReads: true }); await refresh(page);
  await expect(page.getByRole('button', { name: '恢复目标', exact: true })).toBeDisabled(); expect(posts).toEqual([]);
  await control(request, { failReads: false, snapshot: snapshot([paused]) }); await refresh(page);
  await page.getByRole('button', { name: '恢复目标', exact: true }).click(); await expect(page.getByTestId('core-notice')).toBeVisible();
  expect(posts).toEqual([{ action: 'core.resume', goalId, expectedVersion: 3 }]);
});

test('an idempotent same-version control receipt is accepted without changing the displayed snapshot', async ({ page, request }) => {
  const posts = await intercept(page, input => mutation(input)); await open(page); await select(page);
  await page.getByRole('button', { name: '暂停目标', exact: true }).click(); await expect(page.getByTestId('core-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停目标', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '恢复目标', exact: true })).toBeDisabled();
  await control(request, { snapshot: snapshot([makeGoal({ paused: true, version: 4 })]) }); await refresh(page);
  await expect(page.getByRole('button', { name: '恢复目标', exact: true })).toBeEnabled(); expect(posts).toHaveLength(1);
});

test('wrong Goal and older-version control receipts are unconfirmed and never retried by refresh', async ({ page }) => {
  const posts = await intercept(page, input => mutation(input, posts.length === 1 ? { goalId: otherGoalId } : { version: input.expectedVersion - 1 }));
  await open(page); await select(page);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.getByRole('button', { name: '暂停目标', exact: true }).click(); await expect(page.getByTestId('core-error')).toBeVisible();
    await expect(page.getByTestId('core-notice')).toHaveCount(0); await refresh(page); expect(posts).toHaveLength(attempt);
  }
});

test('late control receipts cannot survive selection A-B-A, Runtime replacement or a newer Goal revision', async ({ page, request }) => {
  for (const mode of ['selection', 'instance', 'version']) {
    await page.unroute('**/api/shiyu/commands');
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const goals = [makeGoal(), makeGoal({ goalId: otherGoalId, objective: '另一个合成目标' })];
    const posts = await intercept(page, async input => { await waiting; return mutation(input); });
    await control(request, { snapshot: snapshot(goals) }); await open(page); await select(page);
    await page.getByRole('button', { name: '暂停目标', exact: true }).click(); await expect.poll(() => posts.length).toBe(1);
    if (mode === 'selection') { await select(page, otherGoalId); await select(page); }
    else {
      const changed = mode === 'instance' ? snapshot(goals, { instanceId: 'replacement-runtime' }) : snapshot([makeGoal({ version: 4 }), goals[1]]);
      await control(request, { snapshot: changed }); await refresh(page);
    }
    release(); await expect(page.getByTestId('core-error')).toBeVisible();
    await expect(page.getByTestId('core-notice')).toHaveCount(0); await refresh(page); expect(posts).toHaveLength(1);
  }
});

test('a stop receipt remains valid when GET has already observed that exact returned revision', async ({ page, request }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => { await waiting; return mutation(input, { paused: true, version: 4 }); });
  await open(page); await select(page); await page.getByRole('button', { name: '暂停目标', exact: true }).click();
  await expect.poll(() => posts.length).toBe(1);
  await control(request, { snapshot: snapshot([makeGoal({ paused: true, version: 4 })]) }); await refresh(page);
  await expect(page.getByRole('button', { name: '暂停目标', exact: true })).toBeDisabled(); release();
  await expect(page.getByTestId('core-notice')).toBeVisible(); await expect(page.getByTestId('core-error')).toHaveCount(0);
  expect(posts).toEqual([{ action: 'core.pause', goalId, expectedVersion: 3 }]);
});

test('pending and unknown native commands do not inherit confirmation from the last observed phase or permit resume', async ({ page, request }) => {
  const posts = await intercept(page);
  for (const status of ['pending', 'unknown']) {
    const goal = makeGoal({ paused: true, nativeCommand: { commandId: 'native-complete-command', operation: 'complete', status },
      evaluationsLog: [{ evaluationId: 'completion-candidate', status: 'committed', triggerRefs: ['synthetic-task-completion'],
        candidate: { kind: 'complete_candidate', reason: '合成完成候选' },
        receipt: { evaluationId: 'completion-candidate', proposalId: 'completion-proposal', kind: 'complete_candidate', status: 'committed', reasonCode: 'COMPLETION_CANDIDATE' },
        usage: { complete: true, tokens: 17, calls: 1 } }] });
    await control(request, { snapshot: snapshot([goal]) }); await open(page); await select(page);
    await expect(page.getByTestId('core-native')).toContainText('有效');
    await expect(page.getByTestId('core-native-command')).toContainText('native-complete-command');
    await expect(page.getByTestId('core-native-command')).toContainText('原生命令尚未确认');
    await expect(page.getByTestId('core-native-command').getByText(status === 'pending' ? '待处理' : '未知', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复目标', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '取消目标', exact: true })).toBeEnabled();
    await draft(page); await expect(page.getByRole('button', { name: createName, exact: true })).toBeEnabled();
    await control(request, { snapshot: snapshot([{ ...goal, paused: false }]) }); await refresh(page);
    await expect(page.getByRole('button', { name: '暂停目标', exact: true })).toBeEnabled();
  }
  expect(posts).toEqual([]);
});
