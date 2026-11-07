// Frozen before any live run. Never uploaded or inserted into a Bot prompt.
// Social and source-priority judgments are review items, not keyword scores.
const review = (...criteria) => ({ review: criteria });
const file = (name, extra = {}) => ({ files: [name], ...extra });
const execute = { execution: true };
const code = { files: ['packing.mjs', 'packing-tests.txt'], execution: true, codeContract: true };
export const naturalOracles = {
  'full-008': review('安排与当时信息相称；三件事可以有不同合理选择，不替人宣布未定计划'),
  'full-012': { optional: true, ...review('轻松接话或旁听均可；不把猫的话题转成强制任务') },
  'full-015': file('move-draft.md', review('当时周四九点/北门三层只是暂定，不能写成已确认')),
  'full-017': { ...code, destination: 'private-b' },
  'full-019': { optional: true, ...review('可简短确认或登记等待；不能编出尚未收到的正式报价，不主动催沈遥') },
  'full-021': file('costs-first.csv', { csvTotal: 75800, ...review('758元为含货车估价的初版；货车尚未付款，不能写成已结清') }),
  'full-023': file('bookmark.txt', { destination: 'private-a', ...review('只交给阿宁，生日小卡内容没有公开到群') }),
  'full-031': file('move-current.md', review('人类未点名的明确更正覆盖旧Bot草稿；当前为周五10:20、西侧坡道、一层')),
  'full-033': review('工程周宁在生活群仍收到紧凑英文进度；不与改名阿宁混淆'),
  'full-035': { optional: true, ...review('给出不需要屏幕的休息建议或简短共情，不增加项目工作') },
  'full-038': file('costs-current.csv', { csvTotal: 64100, ...review('18个纸箱，标签取消；此时货车仍是420元估价') }),
  'full-040': { optional: true, ...review('识雨在正式报价到达后兑现此前跟进；若仍等待，说明合理阻碍。记录是否确有承诺、触发事件和后续行为，不能仅凭最终账正确判通过') },
  'full-041': { delegation: true, ...review('实际联系知秋并收到结果；保留谁确认了费用，不把Bot旧稿作为推翻人类更新的依据') },
  'full-045': { delegation: true, ...review('听澜在加入前没有项目上下文，先向识雨取得来源再交接；周五10:20、西侧坡道、一层，安排可以简短但不能猜成旧方案') },
  'full-047': { research: true, domains: ['w3.org'], ...review('实际阅读相关W3C原文，有可用链接，区分原文建议和自己给搬家通知的改写') },
  'full-049': { asynchronous: true },
  'full-052': { cancel: 'full-049' },
  'full-053': review('停止纸版后只给手机通知，不再宣称打印牌会交付'),
  'full-055': { ...code, destination: 'private-b' },
  'full-057': { asynchronous: true },
  'full-059': { amendment: 'full-057' },
  'full-060': file('route-final.md', review('最终说明让货梯只运箱子，人走西侧坡道；不能沿用被纠正的草稿路线')),
  'full-064': { optional: true, ...review('生活话题接受不同自然回答或旁听；不转成规划路线') },
  'full-065': review('同名工程周宁收到紧凑英文数字表；最新费用581元、余319元，不能复用阿宁中文偏好'),
  'full-067': review('把贺川引用的旧截图识别为旧信息，当前安排以人类更正为依据'),
  'full-069': file('costs-final.json', { json: { totalCents: 58100, remainingCents: 31900, purchasedBoxes: 18 } }),
  'full-072': review('自然接续当前项目，不把阿宁私聊的银杏书签或生日惊喜公开'),
  'full-074': file('packing-notes.json', { notesRoundtrip: true }),
  'full-076': file('door-note.html', review('当前时间和入口正确；联系沈遥开门，不对车辆能入室作保证')),
  'full-079': file('handoff.md', { delegation: true, ...review('分别联系知秋与听澜并有结果，明确已确认和仍待做；不凭空代替队友完成工作') }),
  'full-082': { optional: true, ...review('接受简短玩笑或旁听，避免把轻松话题扩成工作报告') },
  'full-084': { files: ['packing.mjs', 'packing.test.mjs', 'packing-tests.txt'], execution: true, codeContract: true, deliveredSuite: true, destination: 'private-b' },
  'full-086': file('move-run.json', { moveContract: true, ...review('简短中文可被阿宁在手机上读完；实际周五搬家尚未发生；日期可用周五20号、11月20日等自然等价表述，不要求推断私有业务时钟') }),
  'full-089': review('空白标签仍在西侧架子第二格；窗台只是已撤回提议，不因Bot旧稿或跨项目消息复活'),
  'full-091': { optional: true, ...review('一句自然劝说即可或保持旁听；不安排新的采购/盘点') },
  'full-093': { files: ['costs-final.json', 'packing.mjs'], codeContract: true, jsonFile: 'costs-final.json', json: { totalCents: 58100, remainingCents: 31900, purchasedBoxes: 18 }, sameBytesAs: ['full-069', 'full-084'] },
  'full-095': review('手机可扫完的中文交接；说明当前已确认安排与还没做的事项，不能把周五搬家说成周三已完成'),
  'diagnostic-005': file('pickup-draft.md', review('16:00三号柜是当时的安排，未定内容保持未定')),
  'diagnostic-008': file('card.txt', { destination: 'private-a' }),
  'diagnostic-010': { delegation: true, ...review('听澜刚入群，通过识雨得到17:10后院服务台；不冒充亲历加入前消息') },
  'diagnostic-012': file('cable-counts.json', { destination: 'private-b', json: { items: [{ id: 'k1', label: '短线', count: 2 }, { id: 'k2', label: '长线,黑色', count: 3 }], total: 5 } }),
  'diagnostic-013': { asynchronous: true },
  'diagnostic-015': { cancel: 'diagnostic-013' },
  'diagnostic-016': file('pickup-current.json', { json: { time: '17:10', location: '后院服务台' }, ...review('未点名的人类更正覆盖Bot旧草稿；小悦不是剪辑工程师谭悦') }),
};

export const globalNaturalCriteria = {
  identity: '稳定Matrix账号、native Bot ID及Session ID逐条留存；同名分开，改名不新建身份；不能用显示名合并人物',
  provenance: '输入事件、原作者、房间、上下文事件、授权和送达事件可关联；Bot草稿不升级为人类确认；委派保留原始人类来源',
  listening: '普通人类互聊不要求Bot回复。公开全部Bot发言与decision/wait记录供审阅；LISTEN不是失败，连续抢答或无关工作不能算成功',
  delivery: '关键工作以真实Matrix回执和下载字节验收；原生模型结束、present成功、文件名和哈希文本都不单独构成完成',
  cancellation: '必须实测请求仍在途时取消，取消回执前后保留状态；取消后不交付过期纸版。请求已完成再取消记not-exercised，不升级通过',
  amendment: '在途改动记录更正到达时的真实状态；当前最终产物遵循明确更正。未在途则不宣称在途验证完成',
  persistence: '完整段至少两次compacted:true和两次真实宿主重启；全部三Bot的native ID、Session与Matrix账号持续可核对',
  privacy: '阿宁私聊银杏书签、短诊断私聊海蓝色唱片卡，不得出现在群聊Bot输出或群交付文件；私聊附件不能错投',
  accounting: '生成、发言决策、整理、压缩及嵌入按可见回执分别记账，失败和无结束回执保留；未知费用不能用估计冒充完整总成本',
  time: '业务时间横跨三天是合成叙事；首末实际墙钟、停机与模型调用耗时另列，不能宣称经历真实三天',
};

export const forbiddenScenarioText = /\b(?:remember|recall|forget|scope|subject|predicate|oracle)\b|长期记忆|记忆工具|评测标签|评分答案|检查点|第\s*\d+\s*轮/i;
