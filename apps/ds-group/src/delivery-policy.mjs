import { parseMentionTokens } from '../web/mention-tokens.js';

const quotePairs = new Map([['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']]);
const chinesePolite = /^(?:(?:请|麻烦|劳驾|拜托|记得|务必|另外|还有|还是|直接|就)(?:你)?\s*)+/;
const chineseTiming = /^(?:(?:等|在)?(?:你)?(?:做|处理|生成|整理|计算|分析|弄|写|检查|核对)(?:完|好|完成)(?:以后|之后|后|了)(?:再)?|(?:完成|结束)(?:以后|之后|后)(?:再)?|最后|届时|随后|然后|接着|到时)\s*/;
const chineseArrival = /^(?:等|在)?(?:你)?(?:收到|拿到|取得|接到)\s*(?:来自)?(?:(?!并|且|再|然后|之后|以后)[\p{L}\p{N}_.·\s-]){0,40}?(?:成果|成品|结果|文件|附件|报告|表格|清单|文档)(?:以后|之后|后)(?:再)?\s*/u;
const chineseDeliveryActor = /^(?:由你(?:来|负责)?|让你(?:来|负责)?|你来|你负责)\s*(?=把|将|在|通过|用|私聊|私信|私下|单独|发|发送|交付|交|传|给|送)/;
const englishPolite = /^(?:(?:please|kindly|can you|could you|would you|remember to|make sure to|actually)\s+)+/i;
const englishTiming = /^(?:once (?:it is |you are |you're )?(?:done|ready|finished)|when (?:it is |you are |you're )?(?:done|ready|finished)|after (?:finishing|completion)|afterwards|finally|then)\s*/i;
const reporting = /(?:他说|她说|说过|写着|提到|示例|例如|含义|意思|为什么|如何|怎么|\b(?:says?|said|means?|example|why|whether)\b)/i;
const businessAction = /(?:分析|整理|计算|制作|生成|编辑|修改|处理|汇总|检查|核对|完成|读取|导出|写一|做一|\b(?:analyse|analyze|summarize|calculate|create|generate|edit|revise|update|process|prepare|make|write|build|export)\b)/i;

function visibleText(value) {
  if (typeof value !== 'string') return '';
  const body = value.replace(/^\s*>.*$/gm, '').normalize('NFKC');
  let result = '';
  let index = 0;
  while (index < body.length) {
    const quote = quotePairs.get(body[index]);
    const apostrophe = body[index] === "'" && /[\p{L}\p{N}]/u.test(body[index - 1] || '');
    const fence = body.slice(index).match(/^(`+|~{3,})/);
    if (fence) {
      const closing = body.indexOf(fence[0], index + fence[0].length);
      index = closing < 0 ? body.length : closing + fence[0].length;
      result += ' ';
    } else if (quote && !apostrophe) {
      let closing = index + 1;
      while (closing < body.length && body[closing] !== quote) closing += body[closing] === '\\' ? 2 : 1;
      index = Math.min(closing + 1, body.length);
      result += ' ';
    } else {
      result += body[index++];
    }
  }
  const tokens = parseMentionTokens(result).tokens;
  for (const token of tokens.toReversed()) result = result.slice(0, token.start) + ' ' + result.slice(token.end);
  return result.replace(/[ \t]+/g, ' ').trim();
}

function withoutPreamble(value) {
  let text = value.trim();
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(chinesePolite, '').replace(englishPolite, '').replace(chineseArrival, '')
      .replace(chineseDeliveryActor, '').replace(chineseTiming, '').replace(englishTiming, '').trim();
  }
  return text.replace(/(?:谢谢|就好|即可|就行|吧|一下|please|thanks)\s*$/i, '').trim();
}

function commandRoute(value) {
  const text = withoutPreamble(value.replace(/^(?:并且|并|再)\s*/, ''));
  if (!text || reporting.test(text)) return undefined;
  const compact = text.replace(/\s+/g, '');
  const directChinese = [
    /^(?:通过|用|以)?(?:私聊|私信|私下|单独|私人消息)(?:的方式)?(?:把|将)?(?:这份|那份|当前|最终|生成的|做好的|刚才的)?(?:结果|成果|文件|附件|报告|表格|成品|清单|文档)?(?:发|发送|交付|交|传|给|发来|发过来|送)(?:一份|一次|一遍|一下)?(?:给)?我(?:一份|一次|一遍|一下)?$/,
    /^(?:通过|用|以)?(?:私聊|私信|私下|单独|私人消息)(?:的方式)?(?:发|发送|交付|交|传|送)(?:这份|那份|当前|最终|生成的|做好的|刚才的)?(?:结果|成果|文件|附件|报告|表格|成品|清单|文档)(?:给)?我$/,
    /^(?:把|将)?(?:这份|那份|当前|最终|生成的|做好的|刚才的)?(?:结果|成果|文件|附件|报告|表格|成品|清单|文档)(?:通过|用)?(?:私聊|私信|私下|单独)(?:发|发送|交付|交|传|送)(?:给)?我$/,
    /^(?:私信|私聊)我$/,
    /^(?:把|将)?(?:这份|那份|当前|最终|生成的|做好的|刚才的)?(?:结果|成果|文件|附件|报告|表格|成品|清单|文档)?(?:发|发送|交付|交|传|送)(?:到|给)?(?:我们?的?|你和我的?)?(?:私聊|私信|私人消息)(?:里|中)?$/,
    /^在(?:我们?的?|你和我的?)?(?:私聊|私信|私人消息)(?:里|中)?(?:把|将)?(?:这份|那份|当前|最终|生成的|做好的|刚才的)?(?:结果|成果|文件|附件|报告|表格|成品|清单|文档)?(?:(?:发|发送|交付|交|传|送)(?:给我|我)?|给我)$/,
    /^(?:发|发送)(?:一条)?(?:私信|私聊消息)(?:给)?我$/,
    /^(?:走|用|通过)?(?:私聊|私信)$/,
  ];
  const originChinese = [
    /^(?:把|将)?(?:这份|那份|当前|最终|生成的|做好的|刚才的)?(?:结果|成果|文件|附件|报告|表格|成品|清单|文档)?(?:发|发送|交付|贴|贴出|留|放)(?:到|在|回)?(?:这个|当前|原来|本)?(?:群里|群内|群聊|群|频道|这里|这儿)(?:里|中)?$/,
    /^(?:在|就在|通过)?(?:这个|当前|原来|本)?(?:群里|群内|群聊|群|频道|这里|这儿)(?:里|中)?(?:发|发送|交付|回复|贴出)$/,
  ];
  if (originChinese.some(pattern => pattern.test(compact))) return 'origin';
  if (directChinese.some(pattern => pattern.test(compact))) return 'direct';
  const english = text.toLowerCase();
  const negativePrivate = /(?:\bnot\b|don't|do not|never|avoid|instead of|rather than)\s+(?:\w+\s+){0,3}(?:dm\b|private|privately|direct message)/i.test(english);
  if (/^(?:post|send|deliver|share|leave|reply)(?:\s+.+)?\s+(?:in|to|on)\s+(?:this|the current|the original|the)?\s*(?:channel|group|conversation|chat)$/.test(english)
    || /^(?:post|send|deliver|share|leave|reply)(?:\s+.{1,160})?\s+here$/.test(english)) return 'origin';
  if (negativePrivate) return undefined;
  if (/^(?:dm|direct message|private message|privately message)\s+me(?:\s+.{1,160})?$/.test(english)) return 'direct';
  if (/^(?:send|deliver|forward|share)\b/.test(english) && /\b(?:me|my)\b/.test(english)
    && /\b(?:dm|direct messages?|private messages?|privately|in private)\b/.test(english)) return 'direct';
  return undefined;
}

function directiveInClause(clause) {
  const route = commandRoute(clause);
  if (route) return { kind: route, routingOnly: true };
  if (reporting.test(clause)) return undefined;
  for (const match of clause.matchAll(/(?:在(?:我们?的?|你和我的?)?(?:私聊|私信|私人消息)|私聊|私信|私下|单独|在群里|在群内|在频道|在这里|\bdm\b|\bsend\b|\bdeliver\b|\bpost\b|发|发送|交付)/gi)) {
    const prefix = clause.slice(0, match.index).trim();
    if (!(businessAction.test(prefix) || isDeliveryFollowup(prefix)) || !/(?:后|再|然后|并且|并|\band then|\band|\bthen)\s*$/i.test(prefix)) continue;
    const suffixRoute = commandRoute(clause.slice(match.index));
    if (suffixRoute) return { kind: suffixRoute, routingOnly: false };
  }
  return undefined;
}

function routingFiller(clause) {
  if (!withoutPreamble(clause)) return true;
  return /^(?:(?:请)?(?:不要|别|不用|无需|不必)(?:再)?(?:私聊|私信|私下)(?:发|发送)?(?:给)?我?|(?:please )?(?:don't|do not|never) (?:dm|private message|direct message) me|not (?:privately|by dm|in private|in a direct message))$/i.test(clause.trim());
}

export function parseDeliveryDirective(body, senderId) {
  if (typeof senderId !== 'string' || !senderId) return undefined;
  const clauses = visibleText(body).split(/[，,。.!！?？；;\n]+/).map(clause => clause.trim()).filter(Boolean);
  let selected;
  let routingOnly = true;
  for (const clause of clauses) {
    const directive = directiveInClause(clause);
    if (directive) {
      selected = directive.kind;
      routingOnly &&= directive.routingOnly;
    } else routingOnly &&= routingFiller(clause);
  }
  if (!selected) return undefined;
  return { delivery: selected === 'direct' ? { kind: 'direct', recipientId: senderId } : { kind: 'origin' }, routingOnly };
}

export function allowsDirectDeliveryProposal(body) {
  const clauses = visibleText(body).split(/[，,。.!！；;\n]+/).map(clause => clause.trim()).filter(Boolean);
  return clauses.some(clause => {
    if (reporting.test(clause)
      || /(?:[?？]|是否|能否|是不是|吗$)/i.test(clause)
      || /(?:不要|别|不用|无需|不必|不想|不需要|不能|禁止|不再|\b(?:not|never|avoid)\b|don't|do not|instead of|rather than)/i.test(clause)) return false;
    const chinesePrivateCue = /(?:(?:私聊|私信|私戳|小窗|私人消息)(?!记录|历史|列表|内容|功能|设置|权限|说明|截图|(?:里|中)(?:的)?(?:内容|记录))|私下|单独(?:给我)?(?:发|发送|传|交付|交|送))/.test(clause);
    const englishPrivateCue = /\b(?:dm me|(?:direct|private) message me|privately|in private|(?:by|via|in|into|to) (?:my |our |a )?(?:dms?|direct messages?|private messages?))\b/i.test(clause);
    const chineseAction = /(?:发|发送|传|交付|交|递|丢|扔|甩|送|分享|转发|私戳|私信|私聊)/.test(clause);
    const chineseRecipient = /(?:给我|(?:发|传|交|送|私戳|私信|私聊)我|到我(?:这|的)|(?:我们?的?|咱俩的?|你和我的?)(?:私聊|私信|小窗|私人消息))/.test(clause);
    const englishAction = /\b(?:send|drop|deliver|forward|share|pass|message|dm)\b/i.test(clause);
    const englishRecipient = /\b(?:(?:send|drop|deliver|forward|pass|message|dm) me|(?:to|with) me|(?:my|our) (?:dms?|direct messages?|private messages?|inbox))\b/i.test(clause);
    return (chinesePrivateCue && chineseAction && chineseRecipient)
      || (englishPrivateCue && englishAction && englishRecipient);
  });
}

function followupText(body) {
  return withoutPreamble(visibleText(body).replace(/[。.!！?？]+$/g, '')).trim();
}

export function isDeliveryResend(body) {
  const text = followupText(body);
  if (!text || text.length > 240 || reporting.test(text)) return false;
  const compact = text.replace(/\s+/g, '');
  return /^(?:再|重新|重)(?:给我)?(?:发|发送|传)(?:一份|一遍|一次|一下)?(?:给)?我?(?:一份|一遍|一次|一下)?$/.test(compact)
    || /^(?:把|将)?(?:刚才|之前|上次|先前)?(?:的)?(?:那份|这份|上一版|上一个|最终)?(?:结果|成果|文件|附件|报告|表格)?(?:再|重新|重)(?:发|发送|传)(?:一份|一遍|一次|一下)?(?:给)?我?(?:一份|一遍|一次|一下)?$/.test(compact)
    || /^(?:resend|re-send)(?:\s+(?:it|that|this|the (?:file|report|result|attachment)))?(?:\s+to me)?$/i.test(text)
    || /^send\s+(?:it|that|this|the (?:file|report|result|attachment))\s+(?:to me\s+)?again(?:\s+to me)?$/i.test(text);
}

export function isDeliveryFollowup(body) {
  if (isDeliveryResend(body)) return true;
  const text = followupText(body);
  if (!text || reporting.test(text)) return false;
  const compact = text.replace(/\s+/g, '');
  return /^(?:继续|再|重新|帮我)?(?:改|修改|调整|优化|完善|更新|计算|核对|汇总)(?:一下)?(?:这份|那份|刚才的?|之前的?|上一版|这个(?=文件|表格|报告|结果|成果|成品|清单|文档|附件|版本)|原来的?|同一份|现有的?|上面的?)/.test(compact)
    || /^(?:把|在)(?:这份|那份|刚才的|之前的|上一版|这个(?=文件|表格|报告|结果|成果|成品|清单|文档|附件|版本)|原来的|同一份|现有的|上面的).{0,30}(?:改|修改|调整|增加|添加|删|更新)/.test(compact)
    || /^(?:continue|keep)\s+(?:editing|revising|working on)\s+(?:this|that|it|the same)\b/i.test(text)
    || /^(?:edit|revise|update|adjust|fix|change)\s+(?:it\b|(?:this|that|the previous|the last|the same)\s+(?:file|report|result|document|spreadsheet|version)\b)/i.test(text);
}

export function normalizeDelivery(value, participants = []) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'kind')) {
    throw Object.assign(new Error('Delivery must select an origin conversation or a human recipient'), { code: 'INVALID_DELIVERY', status: 400 });
  }
  const validKeys = value.kind === 'origin' ? ['kind'] : ['kind', 'recipientId'];
  if (Object.keys(value).some(key => !validKeys.includes(key))) {
    throw Object.assign(new Error('Delivery cannot supply room identifiers or additional fields'), { code: 'INVALID_DELIVERY', status: 400 });
  }
  if (value.kind === 'origin') return { kind: 'origin' };
  if (value.kind !== 'direct' || !Object.hasOwn(value, 'recipientId')
    || !participants.some(person => person.kind === 'human' && person.id === value.recipientId)) {
    throw Object.assign(new Error('Direct delivery requires a registered human recipient'), { code: 'INVALID_DELIVERY', status: 400 });
  }
  return { kind: 'direct', recipientId: value.recipientId };
}
