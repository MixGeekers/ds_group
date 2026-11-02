import { test, expect } from '@playwright/test';
import { makeSnapshot } from './fixtures.js';

// Synthetic snapshots/receipts only. No host, model, live database or Task runs.
const capabilityId = 'task.local-note.execute';
const definitionDigest = 'a'.repeat(64), environmentFingerprint = 'b'.repeat(64);
function record(overrides = {}) {
  return { schemaVersion: 1, authorityId: 'synthetic-ability-authority', revision: 7, safetyRevision: 3,
    definition: { capabilityId, version: 'local-note-v1', definitionDigest, providerRef: 'dsh:shiyu-worker-local-note', toolName: 'shiyu_worker_write_note',
      scope: 'local-owner', verificationPolicy: 'informational', requiredActions: [capabilityId, 'artifact.write'], maxBodyBytes: 1024 },
    binding: { definitionDigest, installationGeneration: 'synthetic-installation', environmentFingerprint },
    declared: true, enabled: true, availability: 'available', verification: 'unknown', usableForAuthorizedTask: true,
    reasonCode: 'SYNTHETIC_AVAILABLE', evidenceRefs: [], observedAt: new Date().toISOString(), ...overrides };
}
const snapshot = (ability = record(), overrides = {}) => ({ ...makeSnapshot(), ability: { ready: true, snapshot: ability }, ...overrides });
const receipt = (input, overrides = {}) => ({ requestId: input.requestId, changed: true, snapshot: record({ enabled: input.enabled, revision: input.expectedRevision + 1, ...overrides }) });
const control = async (request, data) => { expect((await request.post('/__test/control', { data })).ok()).toBe(true); };
async function intercept(page, handler = () => ({ error: 'Unexpected synthetic capability command' })) {
  const posts = [];
  await page.route('**/api/shiyu/commands', async route => {
    const input = route.request().postDataJSON();
    if (!input.action?.startsWith('ability.')) return route.fallback();
    posts.push(input); const result = await handler(input);
    await route.fulfill({ status: result.error ? 503 : 200, contentType: 'application/json', body: JSON.stringify(result) });
  }); return posts;
}
async function open(page) { await page.goto('/'); await page.getByRole('button', { name: '系统', exact: true }).click(); await expect(page.getByTestId('ability-state')).toBeVisible(); }
async function refresh(page) { await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled(); }
const fact = (page, label) => page.getByTestId('ability-state').getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]');
const enable = page => page.getByRole('button', { name: '启用本地便签能力', exact: true });
const disable = page => page.getByRole('button', { name: '停用本地便签能力', exact: true });
test.beforeEach(async ({ request }) => { await control(request, { reset: true, snapshot: snapshot() }); });

test('the fixed capability distinguishes declaration, availability and success evidence; navigation and refresh stay read-only in both narrow locales', async ({ page, request }, testInfo) => {
  const posts = await intercept(page), errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = record({ verification: 'verified', evidenceRefs: ['task:synthetic-completed-task', 'effect:synthetic-effect', 'receipt:synthetic-receipt'],
    body: 'NEVER_RENDER_TOOL_OR_MODEL_BODY' });
  await control(request, { snapshot: snapshot(state) }); await open(page); await refresh(page);
  const card = page.getByTestId('ability-state');
  for (const value of [capabilityId, '已声明', '已启用', '有当前匹配的成功证据', '满足当前能力条件', '不代表已取得 Mandate', 'task:synthetic-completed-task']) await expect(card).toContainText(value);
  await expect(card).toContainText('来自启动时的受信依赖观察'); await expect(card).toContainText('不代表费用完整或模型服务当前可调用');
  await expect(card).not.toContainText('NEVER_RENDER_TOOL_OR_MODEL_BODY');
  await expect(card.getByRole('button')).toHaveCount(2); await expect(page.getByTestId('system-list').locator('article')).toHaveCount(9);
  await page.setViewportSize({ width: 390, height: 844 }); await card.screenshot({ path: testInfo.outputPath('capability-zh-light.png') });
  expect(await page.locator('.syr').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.locator('#locale').click(); await page.locator('#theme').click();
  await expect(card).toContainText('Matching success evidence recorded'); await expect(card).toContainText('does not grant a Mandate');
  await expect(card).toContainText('trusted dependency observations at startup'); await expect(card).toContainText('does not establish complete cost accounting or current model service availability');
  await card.screenshot({ path: testInfo.outputPath('capability-en-dark.png') });
  await page.getByTestId('ability-evidence').screenshot({ path: testInfo.outputPath('capability-evidence-en-dark.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(posts).toEqual([]); expect(errors).toEqual([]);
});

test('unknown or stale proof does not imply unusable; verified proof does not imply online or enabled', async ({ page, request }) => {
  const posts = await intercept(page); await open(page);
  const cases = [
    { enabled: true, availability: 'available', verification: 'unknown', usableForAuthorizedTask: true, evidence: '尚无当前成功证据', usable: '满足当前能力条件' },
    { enabled: true, availability: 'available', verification: 'stale', usableForAuthorizedTask: true, evidence: '历史成功证据当前不适用或不可核对', usable: '满足当前能力条件' },
    { enabled: true, availability: 'unavailable', verification: 'verified', usableForAuthorizedTask: false, evidence: '有当前匹配的成功证据', usable: '当前能力条件不满足' },
    { enabled: false, availability: 'available', verification: 'verified', usableForAuthorizedTask: false, evidence: '有当前匹配的成功证据', usable: '当前能力条件不满足' },
    { enabled: false, availability: 'unknown', verification: 'unknown', usableForAuthorizedTask: false, evidence: '尚无当前成功证据', usable: '当前能力条件不满足' },
  ];
  for (const { evidence, usable, ...state } of cases) {
    await control(request, { snapshot: snapshot(record(state)) }); await refresh(page);
    await expect(fact(page, '成功证据')).toHaveText(evidence); await expect(fact(page, '可供已授权任务使用')).toHaveText(usable);
    await expect(state.enabled ? disable(page) : enable(page)).toBeEnabled();
  }
  expect(posts).toEqual([]);
});

test('absent or failed capability state stays unknown and unsupported capabilities never create controls', async ({ page, request }) => {
  const posts = await intercept(page); await open(page);
  const invalid = record({ definition: { ...record().definition, capabilityId: 'dynamic.unsolicited-tool' } });
  for (const ability of [undefined, { ready: false, errorCode: 'SYNTHETIC_UNAVAILABLE' }, { ready: true, snapshot: invalid }, { ready: true, snapshot: record({ revision: 0 }) }]) {
    await control(request, { snapshot: snapshot(undefined, { ability }) }); await refresh(page);
    await expect(page.getByTestId('ability-unavailable')).toContainText('不可确认'); await expect(enable(page)).toBeDisabled(); await expect(disable(page)).toBeDisabled();
    await expect(fact(page, '启用状态')).toHaveText('未提供'); await expect(page.getByTestId('ability-state')).not.toContainText('dynamic.unsolicited-tool');
  }
  expect(posts).toEqual([]);
});

test('missing availability is unknown while owner controls and explicit verified evidence remain independent', async ({ page, request }) => {
  const posts = await intercept(page); await control(request, { snapshot: snapshot(record({ enabled: false, availability: undefined, verification: 'verified', usableForAuthorizedTask: undefined }), { state: 'paused' }) }); await open(page);
  await expect(fact(page, '当前可用性')).toHaveText('未知'); await expect(fact(page, '成功证据')).toHaveText('有当前匹配的成功证据');
  await expect(fact(page, '可供已授权任务使用')).toHaveText('未提供'); await expect(enable(page)).toBeEnabled(); expect(posts).toEqual([]);
});

test('successful Tasks or model prose never manufacture capability proof, and page staleness does not reclassify server proof', async ({ page, request }) => {
  const posts = await intercept(page); await control(request, { snapshot: snapshot(record(), { tasks: [{ taskId: 'synthetic-task', state: 'succeeded', result: 'Model says verified' }] }) }); await open(page);
  await expect(fact(page, '成功证据')).toHaveText('尚无当前成功证据');
  await control(request, { snapshot: snapshot(record({ verification: 'verified' }), { observedAt: new Date(Date.now() - 45_000).toISOString() }) }); await refresh(page);
  await expect(fact(page, '成功证据')).toHaveText('有当前匹配的成功证据'); await expect(disable(page)).toBeDisabled();
  await expect(page.getByTestId('ability-state')).not.toContainText('历史成功证据当前不适用或不可核对'); expect(posts).toEqual([]);
});

test('owner changes send exactly the revision CAS and stable request identity; receipts never replace the displayed snapshot', async ({ page, request }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const state = record({ verification: 'verified', evidenceRefs: ['task:previous-success'] });
  const posts = await intercept(page, async input => { await waiting; return receipt(input, { verification: state.verification, evidenceRefs: state.evidenceRefs }); });
  await control(request, { snapshot: snapshot(state, { state: 'paused', commitSeq: 900, stateVersion: 500 }) }); await open(page);
  await disable(page).evaluate(button => { button.click(); button.click(); }); await expect.poll(() => posts.length).toBe(1);
  expect(Object.keys(posts[0]).sort()).toEqual(['action', 'requestId', 'expectedRevision', 'enabled'].sort());
  expect(posts[0]).toMatchObject({ action: 'ability.setEnabled', expectedRevision: 7, enabled: false }); expect(posts[0].requestId).toMatch(/^ability-/);
  await expect(enable(page)).toBeDisabled(); await expect(disable(page)).toBeDisabled(); await refresh(page); expect(posts).toHaveLength(1);
  release(); await expect(page.getByTestId('ability-notice')).toBeVisible(); await expect(fact(page, '启用状态')).toHaveText('已启用');
  await control(request, { snapshot: snapshot({ ...state, revision: 8, safetyRevision: 4, enabled: false, usableForAuthorizedTask: false }, { state: 'paused' }) }); await refresh(page);
  await expect(fact(page, '启用状态')).toHaveText('已停用'); await expect(page.getByTestId('ability-evidence')).toContainText('task:previous-success'); await expect(enable(page)).toBeEnabled();
});

test('unknown outcomes retry only on an explicit click with the same request ID, while a new revision gets a new ID', async ({ page, request }) => {
  const posts = await intercept(page, () => ({ error: 'Synthetic unconfirmed change' })); await open(page);
  await disable(page).click(); await expect(page.getByTestId('ability-error')).toBeVisible(); await refresh(page); expect(posts).toHaveLength(1);
  await disable(page).click(); await expect.poll(() => posts.length).toBe(2); await expect(disable(page)).toBeEnabled(); expect(posts[1]).toEqual(posts[0]);
  await control(request, { snapshot: snapshot(record({ revision: 8, verification: 'verified' })) }); await refresh(page);
  await disable(page).click(); await expect.poll(() => posts.length).toBe(3); expect(posts[2].requestId).not.toBe(posts[0].requestId); expect(posts[2].expectedRevision).toBe(8);
});

test('both directions remain available during global pause, unavailable dependencies and unrelated in-flight work', async ({ page, request }) => {
  const posts = await intercept(page, input => receipt(input)); let release; const waiting = new Promise(resolve => { release = resolve; });
  const probes = [];
  await page.route('**/api/shiyu/commands', async route => {
    const input = route.request().postDataJSON(); if (input.action !== 'session.probe') return route.fallback();
    probes.push(input); await waiting; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, noModelCalled: true, released: true, archived: true }) });
  });
  await page.goto('/'); await page.getByRole('button', { name: '诊断', exact: true }).click(); await page.getByRole('button', { name: '检查会话接入（不调用模型）', exact: true }).click();
  await expect.poll(() => probes.length).toBe(1); await page.getByRole('button', { name: '系统', exact: true }).click();
  await disable(page).click(); await expect(page.getByTestId('ability-notice')).toBeVisible();
  await control(request, { snapshot: snapshot(record({ revision: 8, enabled: false, availability: 'unavailable', usableForAuthorizedTask: false }), { state: 'paused' }) }); await refresh(page);
  await enable(page).click(); await expect.poll(() => posts.length).toBe(2); await expect(page.getByTestId('ability-notice')).toBeVisible();
  expect(posts.map(input => input.enabled)).toEqual([false, true]); release();
});

test('mismatched request, authority, target or old revision receipts remain unconfirmed', async ({ page }) => {
  let mode = 'request';
  const posts = await intercept(page, input => { const result = receipt(input); if (mode === 'request') result.requestId = 'wrong-request';
    else if (mode === 'authority') result.snapshot.authorityId = 'wrong-authority'; else if (mode === 'target') result.snapshot.enabled = true;
    else result.snapshot.revision = input.expectedRevision - 1; return result; });
  await open(page);
  for (const value of ['request', 'authority', 'target', 'revision']) { mode = value; await disable(page).click(); await expect(page.getByTestId('ability-error')).toBeVisible(); await expect(page.getByTestId('ability-notice')).toHaveCount(0); }
  await refresh(page); expect(posts).toHaveLength(4); await expect(fact(page, '启用状态')).toHaveText('已启用');
});

for (const mode of ['authority', 'instance', 'binding', 'revision']) {
  test(`late receipts cannot survive ${mode} changes, including identity A-B-A`, async ({ page, request }) => {
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const posts = await intercept(page, async input => { await waiting; return receipt(input); }); await open(page); await disable(page).click(); await expect.poll(() => posts.length).toBe(1);
    const original = record();
    const changed = mode === 'authority' ? snapshot({ ...original, authorityId: 'replacement-authority' }) : mode === 'instance' ? snapshot(original, { instanceId: 'replacement-instance' })
      : mode === 'binding' ? snapshot({ ...original, binding: { ...original.binding, environmentFingerprint: 'c'.repeat(64) } }) : snapshot({ ...original, revision: 10 });
    await control(request, { snapshot: changed }); await refresh(page);
    if (mode !== 'revision') { await control(request, { snapshot: snapshot(original) }); await refresh(page); }
    release(); await expect(page.getByTestId('ability-error')).toContainText('旧回执未采用'); await expect(page.getByTestId('ability-notice')).toHaveCount(0); await refresh(page); expect(posts).toHaveLength(1);
  });
}

test('a receipt remains valid when GET already observed its exact revision, and proof updates alone send no command', async ({ page, request }) => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const posts = await intercept(page, async input => { await waiting; return receipt(input); }); await open(page); await disable(page).click(); await expect.poll(() => posts.length).toBe(1);
  await control(request, { snapshot: snapshot(record({ revision: 8, enabled: false, usableForAuthorizedTask: false })) }); await refresh(page); release();
  await expect(page.getByTestId('ability-notice')).toBeVisible(); await expect(page.getByTestId('ability-error')).toHaveCount(0);
  await control(request, { snapshot: snapshot(record({ revision: 9, enabled: false, verification: 'verified', usableForAuthorizedTask: false, evidenceRefs: ['task:synthetic-proof'] })) }); await refresh(page);
  await expect(fact(page, '启用状态')).toHaveText('已停用'); await expect(fact(page, '成功证据')).toHaveText('有当前匹配的成功证据'); expect(posts).toHaveLength(1);
});
