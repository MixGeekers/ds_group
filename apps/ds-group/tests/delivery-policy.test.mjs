import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsDirectDeliveryProposal, isDeliveryFollowup, isDeliveryResend, normalizeDelivery, parseDeliveryDirective } from '../src/delivery-policy.mjs';

const alice = '@alice:delivery.test';
const bob = '@bob:delivery.test';
const bot = '@finance:delivery.test';
const participants = [{ id: alice, kind: 'human' }, { id: bob, kind: 'human' }, { id: bot, kind: 'bot' }];
const direct = { kind: 'direct', recipientId: alice };

test('standalone self-directed delivery instructions are routing controls across Chinese and English', () => {
  for (const text of [
    '<@@finance:delivery.test> 处理完以后，请通过私信把成品交给我。',
    '请把报告发到我的私聊里。',
    '请把最终报告单独发送给我。',
    '完成后，单独发送结果给我，谢谢。',
    'Please send the finished report to me by DM.',
    'Once it is ready, kindly DM me the spreadsheet.',
  ]) assert.deepEqual(parseDeliveryDirective(text, alice), { delivery: direct, routingOnly: true }, text);
});

test('combined business instructions keep their work while selecting private delivery', () => {
  for (const text of [
    '请汇总这张费用表，并且私信给我。',
    '整理名单后私聊发我。',
    'Create a department summary and then DM me the report.',
    '请检查附件中的公式，最后把结果发到我的私信。',
  ]) assert.deepEqual(parseDeliveryDirective(text, alice), { delivery: direct, routingOnly: false }, text);
});

test('result arrival and delivery actor prefixes remain routing-only without extra work instructions', () => {
  for (const text of [
    '收到整理员的成品后，由你把这份报告私信发给我。',
    '拿到核算员结果以后，由你将报告发到我们的私聊里。',
    '取得会计助理的文件后在我们私聊里发给我。',
    '请在我们的私聊里把最终成果交给我。',
    '等收到 <@@reviewer:delivery.test> 的成果后，请由你把这份文件发到我的私信里。',
  ]) assert.deepEqual(parseDeliveryDirective(text, alice), { delivery: direct, routingOnly: true }, text);
  for (const text of [
    '请委派整理员用工具制作核对清单。收到整理员成品后，由你把这份清单私聊发给我。请先委派。',
    '收到核算员文件后，由你检查公式，再在我们私聊里发给我。',
    '收到整理员成果后由你核对表格后在我们的私聊里发送给我。',
    '收到核算员报告并核对表格后，请私信我。',
  ]) assert.deepEqual(parseDeliveryDirective(text, alice), { delivery: direct, routingOnly: false }, text);
  assert.equal(parseDeliveryDirective('收到整理员报告后，不要在我们的私聊里发给我。', alice), undefined);
});

test('quoted text, code, descriptions and negated private instructions cannot choose a recipient', () => {
  for (const text of [
    '解释“请私信我”的含义。',
    'The example says "DM me the file".',
    '`Please DM me`',
    '```text\n请私聊我\n```',
    '~~~text\nDM me',
    '> Please DM me the report',
    '请不要私信我。',
    "Don't DM me the spreadsheet.",
    '请解释为什么有人会私信给我。',
    'Please send the report to Bob by DM.',
  ]) assert.equal(parseDeliveryDirective(text, alice), undefined, text);
});

test('explicit origin delivery overrides a prior direct clause in the current instruction', () => {
  assert.deepEqual(parseDeliveryDirective('请私信我，最后把成果放在当前频道。', alice), { delivery: { kind: 'origin' }, routingOnly: true });
  assert.deepEqual(parseDeliveryDirective('不要私信我，结果发在群内。', alice), { delivery: { kind: 'origin' }, routingOnly: true });
  assert.deepEqual(parseDeliveryDirective('Please post the report in this channel.', alice), { delivery: { kind: 'origin' }, routingOnly: true });
  assert.deepEqual(parseDeliveryDirective('还是把报告发群里。', alice), { delivery: { kind: 'origin' }, routingOnly: true });
  assert.deepEqual(parseDeliveryDirective('不用私聊，就发在群里。', alice), { delivery: { kind: 'origin' }, routingOnly: true });
  assert.deepEqual(parseDeliveryDirective('Actually send me the file here, not privately.', alice), { delivery: { kind: 'origin' }, routingOnly: true });
  assert.deepEqual(parseDeliveryDirective('继续改这份表格后在群里发。', alice), { delivery: { kind: 'origin' }, routingOnly: false });
  assert.deepEqual(parseDeliveryDirective('Keep editing this report and then post it here.', alice), { delivery: { kind: 'origin' }, routingOnly: false });
});

test('resend classification is restricted to a request for the existing delivery', () => {
  for (const text of ['麻烦把刚才的那份结果重新发送给我。', '请重发一份。', '请再给我发一份。', 'Please resend the attachment to me.', 'Send that again to me.']) {
    assert.equal(isDeliveryResend(text), true, text);
    assert.equal(isDeliveryFollowup(text), true, text);
  }
  for (const text of ['生成一份新的预算表。', '先修改税率，再发给我。', '为什么需要重新发送？', 'The document says "resend it".']) {
    assert.equal(isDeliveryResend(text), false, text);
  }
});

test('model direct proposals require current positive private delivery to the speaker', () => {
  for (const text of [
    '弄好把成品扔到咱俩的私聊窗口给我就成。',
    '把核对结果丢进我的小窗。',
    '整理表格后，麻烦单独发给我一份。',
    'Please drop the finished workbook into my DMs.',
    'Pass the final attachment to me in private.',
    '不要发到群里，私戳我发一下成品。',
  ]) assert.equal(allowsDirectDeliveryProposal(text), true, text);
  for (const text of [
    '把文件发给我。',
    '请单独整理这个月的费用后发给我。',
    '导出私信记录发给我。',
    '把私聊里的内容整理后发给我。',
    'Please send the workbook to me.',
    'Export my DMs and send the archive to me.',
    '请不要把结果私信发给我。',
    "Don't drop the report into my DMs.",
    '解释“把成品丢进我的小窗”的意思。',
    '`Drop the file into my DMs.`',
    '> 把文件私信发给我。',
    '为什么有人会私信给我？',
    '可以私聊发给我吗？',
    'Please send my workbook to Bob by DM.',
    '把成果私聊发给小林。',
  ]) assert.equal(allowsDirectDeliveryProposal(text), false, text);
});

test('followup classification requires a reference to the existing artifact', () => {
  for (const text of ['请继续修改这份报告，增加日期列。', '把上一版表格改成按周汇总。', '调整刚才结果里的日期。', '重新核对上一版表格。', '修改这个文件里的日期。', '把这个表格改成按季度汇总。', 'Adjust the previous spreadsheet to include tax.', 'Please keep editing that document.']) {
    assert.equal(isDeliveryFollowup(text), true, text);
  }
  for (const text of ['请修改公司的年度预算。', '计算这个月的费用。', '更新这个季度的预算。', '把这个部门的人员表改成按地区汇总。', 'Update this quarter’s budget.', 'Create a new file.', '告诉我如何修改这份表格。']) {
    assert.equal(isDeliveryFollowup(text), false, text);
  }
});

test('delivery normalization uses canonical destinations and rejects fabricated rooms or Bots', () => {
  assert.equal(normalizeDelivery(undefined, participants), undefined);
  assert.deepEqual(normalizeDelivery({ kind: 'origin' }, participants), { kind: 'origin' });
  assert.deepEqual(normalizeDelivery({ recipientId: bob, kind: 'direct' }, participants), { kind: 'direct', recipientId: bob });
  for (const value of [null, [], { kind: 'room', roomId: '!fabricated:test' }, { kind: 'origin', roomId: '!fabricated:test' },
    { kind: 'direct', recipientId: bot }, { kind: 'direct', recipientId: '@unknown:test' }, { kind: 'direct' },
    { kind: 'direct', recipientId: alice, roomId: '!fabricated:test' }]) {
    assert.throws(() => normalizeDelivery(value, participants), error => error.code === 'INVALID_DELIVERY' && error.status === 400);
  }
});
