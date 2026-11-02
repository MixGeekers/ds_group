import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeChannelBinding, makeChannelConnection, makeChannelConversation, makeChannelProjection, makeEmptyChannelProjection, makeSnapshot } from './fixtures.js';

// Synthetic client behavior only: the mock host serves this snapshot, no real
// DSH, platform, account, model or channel send is involved.
const stats = async request => (await request.get('/__test/stats')).json();
const control = async (request, body) => { const response = await request.post('/__test/control', { data: body }); expect(response.ok()).toBe(true); };
const captureCommands = page => {
  const posted = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/shiyu/commands') posted.push(request.postDataJSON());
  });
  return posted;
};
const refresh = async page => {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
};
async function open(page, locale = 'zh') {
  await page.goto('/');
  if (locale === 'en') await page.locator('#locale').click();
  await page.getByRole('button', { name: locale === 'en' ? 'Channels' : '渠道', exact: true }).click();
  await expect(page.getByTestId('channel-projection')).toBeVisible();
}
const value = (region, label) => region.getByText(label, { exact: true }).first().locator('xpath=following-sibling::dd[1]');
const snapshot = overrides => ({ ...makeSnapshot(), ...overrides });

test.beforeEach(async ({ request }) => { await control(request, { reset: true }); });

test('ready projection renders bindings, connections, conversations, watermarks and pending metadata without bodies', async ({ page, request }) => {
  const posted = captureCommands(page), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const binding = makeChannelBinding({ channelRef: 'chconv-' + 'a'.repeat(32), conversationId: 'conversation-visible-1',
    version: 4, appliedInvalidationWatermark: 7, conversationAudienceVersion: 3, replySessionEpoch: 2 });
  // Canary fields do not exist in the real projection; the UI must ignore them.
  binding.body = 'BODY_CANARY_CHANNEL_BINDING'; binding.summary = 'SUMMARY_CANARY_BINDING'; binding.participantText = 'NAME_CANARY_PARTICIPANT';
  const connection = makeChannelConnection({ provider: 'synthetic-chat', deployment: 'env-visible', accountId: 'account-visible', revision: 5 });
  connection.rawBody = 'BODY_CANARY_CONNECTION';
  const conversation = makeChannelConversation({ mode: 'group', audienceVersion: 3, audienceStatus: 'current', participantCount: 2, nativeConversationId: 'native-visible' });
  conversation.summary = 'SUMMARY_CANARY_CONVERSATION'; conversation.participantNames = ['NAME_CANARY_PARTICIPANT'];
  const projection = makeChannelProjection({ bindings: [binding], connections: [connection], conversations: [conversation],
    pending: { appliedThrough: 5, unapplied: 2, unbound: 1, truncated: false }, degraded: [] });
  projection.bodyRef = 'BODY_REF_CANARY';
  await control(request, { snapshot: snapshot({ channels: projection }) });
  await open(page);
  const panel = page.getByTestId('channel-projection');
  await expect(page.getByTestId('channel-read-only')).toContainText('只读元数据');
  await expect(page.getByTestId('channel-read-only')).toContainText('不显示消息正文、摘要、正文引用或参与者文本');
  await expect(page.getByTestId('channel-read-only')).toContainText('不代表真实平台已接入');
  const status = page.getByTestId('channel-status');
  await expect(status).toContainText('就绪');
  await expect(value(status, '投影来源')).toHaveText('channel-ingress');
  await expect(value(status, 'schema 版本')).toHaveText('1');
  const watermark = page.getByTestId('channel-watermark');
  await expect(value(watermark, '接纳序号')).toHaveText('12');
  await expect(value(watermark, '失效水位')).toHaveText('3');
  await expect(value(watermark, '删除水位')).toHaveText('1');
  await expect(value(watermark, '撤权水位')).toHaveText('2');
  const pending = page.getByTestId('channel-pending');
  await expect(value(pending, '已应用到')).toHaveText('5');
  await expect(value(pending, '未应用')).toHaveText('2');
  await expect(value(pending, '未绑定频道')).toHaveText('1');
  await expect(value(pending, '结果截断')).toHaveText('否');
  await expect(page.getByTestId('channel-degraded')).toContainText('未报告渠道投影受限原因。');
  const bindings = page.getByTestId('channel-binding');
  await expect(bindings).toHaveCount(1);
  await expect(bindings).toContainText('chconv-' + 'a'.repeat(32));
  await expect(bindings).toContainText('conversation-visible-1');
  await expect(value(bindings, '固定受众范围')).toHaveText('local-owner');
  await expect(value(bindings, '记录版本')).toHaveText('4');
  await expect(value(bindings, '已应用失效水位')).toHaveText('7');
  await expect(value(bindings, '受众版本')).toHaveText('3');
  await expect(value(bindings, '回复 Session 代次')).toHaveText('2');
  const connections = page.getByTestId('channel-connection');
  await expect(connections).toHaveCount(1);
  await expect(value(connections, '平台提供方')).toHaveText('synthetic-chat');
  await expect(value(connections, '部署')).toHaveText('env-visible');
  await expect(value(connections, '账号 ID')).toHaveText('account-visible');
  await expect(value(connections, '连接版本')).toHaveText('5');
  const conversations = page.getByTestId('channel-conversation');
  await expect(conversations).toHaveCount(1);
  await expect(value(conversations, '受众模式')).toHaveText('group');
  await expect(value(conversations, '受众版本')).toHaveText('3');
  await expect(value(conversations, '参与者数量')).toHaveText('2');
  await expect(value(conversations, '原生会话标识')).toHaveText('native-visible');
  await expect(panel.locator('input,textarea,select,[contenteditable="true"]')).toHaveCount(0);
  const text = await panel.innerText();
  for (const canary of ['BODY_CANARY_', 'SUMMARY_CANARY_', 'NAME_CANARY_', 'BODY_REF_CANARY']) expect(text).not.toContain(canary);
  expect(posted).toEqual([]);
  expect((await stats(request)).commands).toEqual([]);
  expect(errors).toEqual([]);
});

test('empty, missing, incompatible, degraded and unknown projections are explicit, never fake available', async ({ page, request }) => {
  const posted = captureCommands(page);
  // Ready but empty: explicit "no adapter yet", never a fake available success.
  await control(request, { snapshot: snapshot({ channels: makeEmptyChannelProjection() }) });
  await open(page);
  await expect(page.getByTestId('channel-empty')).toContainText('尚无渠道适配器接入');
  await expect(page.getByTestId('channel-empty')).toContainText('空投影不等于真实渠道验收通过');
  await expect(page.getByTestId('channel-binding')).toHaveCount(0);
  await expect(page.getByTestId('channel-connections')).toContainText('尚无渠道连接');
  await expect(page.getByTestId('channel-conversations')).toContainText('尚无渠道会话');
  await expect(value(page.getByTestId('channel-watermark'), '接纳序号')).toHaveText('0');
  // Missing projection: explicit unknown, not an empty success.
  const missing = makeSnapshot();
  delete missing.channels;
  await control(request, { snapshot: missing });
  await refresh(page);
  await expect(page.getByTestId('channel-missing')).toContainText('当前快照未提供渠道投影');
  await expect(page.getByTestId('channel-read-only')).toContainText('只读元数据');
  await expect(page.getByTestId('channel-status')).toHaveCount(0);
  // Incompatible schema: not rendered as available.
  await control(request, { snapshot: snapshot({ channels: { ...makeChannelProjection(), schemaVersion: 2 } }) });
  await refresh(page);
  await expect(page.getByTestId('channel-incompatible')).toContainText('渠道投影不兼容');
  await expect(page.getByTestId('channel-bindings')).toHaveCount(0);
  // Degraded and unavailable: reasons are shown with their raw codes.
  await control(request, { snapshot: snapshot({ channels: makeChannelProjection({ bindings: [], connections: [], conversations: [],
    status: { ready: false, schemaVersion: 1, errorCode: 'SYNTHETIC_CHANNEL_UNAVAILABLE' },
    degraded: ['channel_ingress_unavailable', 'conversation_domain_unavailable'] }) }) });
  await refresh(page);
  await expect(page.getByTestId('channel-status')).toContainText('不可用');
  await expect(page.getByTestId('channel-status')).toContainText('SYNTHETIC_CHANNEL_UNAVAILABLE');
  const degraded = page.getByTestId('channel-degraded');
  await expect(degraded).toContainText('渠道接入域不可用 (channel_ingress_unavailable)');
  await expect(degraded).toContainText('对话域不可用 (conversation_domain_unavailable)');
  await expect(page.getByTestId('channel-empty')).toHaveCount(0);
  // Malformed fields: arrays become explicit unknown messages and scalars unknown.
  await control(request, { snapshot: snapshot({ channels: { schemaVersion: 1, source: 'channel-ingress', capturedAt: new Date().toISOString(),
    status: null, watermark: null, pending: null, bindings: null, connections: 'invalid', conversations: [], degraded: null } }) });
  await refresh(page);
  await expect(page.getByTestId('channel-status-unknown')).toContainText('不能推断为可用或不可用');
  await expect(page.getByTestId('channel-status')).toContainText('未知');
  await expect(page.getByTestId('channel-watermark')).toContainText('未提供');
  await expect(page.getByTestId('channel-pending')).toContainText('未提供');
  await expect(page.getByTestId('channel-bindings')).toContainText('快照未提供渠道绑定记录');
  await expect(page.getByTestId('channel-connections')).toContainText('快照未提供渠道连接记录');
  await expect(page.getByTestId('channel-degraded')).toContainText('投影完整性未知');
  expect(posted).toEqual([]);
  expect((await stats(request)).commands).toEqual([]);
});

test('English locale and a 390px viewport keep the same read-only channel semantics', async ({ page, request }, testInfo) => {
  const posted = captureCommands(page);
  const binding = makeChannelBinding({ channelRef: 'chconv-' + 'b'.repeat(32), conversationId: 'conversation-en-1' });
  binding.body = 'BODY_CANARY_EN_BINDING';
  const projection = makeChannelProjection({ bindings: [binding], pending: { truncated: true, unapplied: 1 } });
  projection.summary = 'SUMMARY_CANARY_EN';
  await control(request, { snapshot: snapshot({ channels: projection }) });
  await open(page, 'en');
  const panel = page.getByTestId('channel-projection');
  await expect(page.getByTestId('channel-read-only')).toContainText('read-only metadata only');
  await expect(page.getByTestId('channel-read-only')).toContainText('does not mean a real platform');
  await expect(value(page.getByTestId('channel-watermark'), 'Intake sequence')).toHaveText('12');
  await expect(value(page.getByTestId('channel-watermark'), 'Revocation watermark')).toHaveText('2');
  await expect(value(page.getByTestId('channel-pending'), 'Truncated')).toHaveText('Yes');
  await expect(page.getByTestId('channel-binding')).toContainText('conversation-en-1');
  await expect(value(page.getByTestId('channel-binding'), 'Reply Session epoch')).toHaveText('1');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('channel-binding')).toBeVisible();
  await expect(page.getByTestId('channel-watermark')).toBeVisible();
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('.syr');
    const region = document.querySelector('[data-testid="channel-projection"]');
    return { page: document.documentElement.scrollWidth - window.innerWidth,
      panel: root && region ? region.getBoundingClientRect().width - root.getBoundingClientRect().width : 0 };
  });
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.panel).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('channels-en-narrow.png'), fullPage: true });
  expect(await panel.innerText()).not.toContain('BODY_CANARY_');
  expect(await panel.innerText()).not.toContain('SUMMARY_CANARY_');
  expect(posted).toEqual([]);
  expect((await stats(request)).commands).toEqual([]);
});

test('refreshing the channel panel is a read-only GET sequence with no command or model call', async ({ page, request }) => {
  const posted = captureCommands(page);
  await control(request, { snapshot: snapshot({ channels: makeChannelProjection() }) });
  await open(page);
  const before = await stats(request);
  for (let round = 0; round < 3; round++) {
    await refresh(page);
    await expect(page.getByTestId('channel-binding')).toHaveCount(1);
  }
  await page.getByRole('button', { name: '概览', exact: true }).click();
  await page.getByRole('button', { name: '渠道', exact: true }).click();
  await expect(page.getByTestId('channel-projection')).toBeVisible();
  const after = await stats(request);
  expect(after.commands).toEqual([]);
  expect(after.stateReads).toBeGreaterThan(before.stateReads + 1);
  expect(posted).toEqual([]);
});

test('the conversation system copy stays truthful about offline slices and the missing real platform', async () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/health/systems.ts', import.meta.url)), 'utf8');
  const line = source.split('\n').find(entry => entry.includes("id: 'conversation'"));
  expect(line).toBeTruthy();
  expect(line).toContain('H6a');
  expect(line).toContain('H6b');
  expect(line).toContain('离线');
  expect(line).toContain('真实平台');
  expect(line).toContain('仍未完成');
  expect(line).not.toContain('完整接入');
  expect(line).not.toContain('真实平台已接入');
  expect(line).not.toContain('业务已验收');
});
