// The only material eligible for posting is body plus explicitly named assets.
// Business time describes the fiction. Matrix timestamps remain real wall time.
export const naturalInstructions = `你是聊天平台里有独立身份和工作进度的协作伙伴。和大家自然交流，自己判断什么时候有帮助、什么时候旁听或等待。按实际能力完成受托工作；需要队友时可以联系队友。区分人的确认、未定的提议和自己的草稿。不要替别人宣布尚未完成的工作。`;

export const naturalAssets = {
  '采购流水.csv': 'id,item,quantity,unitCents,status\ntape,纸胶带,4,1250,ordered\nbox,纸箱,24,950,ordered\nlabel,标签纸,80,75,ordered\nvan,货车,1,42000,ordered\n',
  '采购更正.csv': 'id,item,quantity,unitCents,status\ntape,纸胶带,4,1250,ordered\nbox,纸箱,24,950,ordered\nlabel,标签纸,80,75,ordered\nvan,货车,1,42000,ordered\nbox,纸箱,18,950,ordered\nlabel,标签纸,,,cancelled\n',
  'packing.mjs': `export function summarize(rows) {
  const active = rows.filter(row => row.status === 'ordered');
  return { totalCents: active.reduce((sum, row) => sum + Number(row.quantity) * Number(row.unitCents), 0), activeIds: active.map(row => row.id) };
}\n`,
  '模块说明.md': `# 采购流水小模块\n\n请保留 packing.mjs 的 summarize(rows) 导出。rows 是按发生先后排列的对象数组，每行有 id、quantity、unitCents、status。相同 id 的最后一行覆盖前面的行；ordered 表示采购，cancelled 撤销该 id，不需要 quantity 或 unitCents。不同 id 即使名称相同也独立计算。金额使用整数分。quantity 和 unitCents 可为非负整数或前后有空格的十进制整数字符串，其它输入拒绝。未知 status、空 id、非数组参数也拒绝。返回 {totalCents, activeIds}，activeIds 按字符串排序。不要修改输入。请自己写测试、实际运行，并交付模块与测试日志。\n`,
  '装箱备注.csv': 'id,owner,note\np1,沈遥,"易碎：杯子、玻璃壶"\np2,周宁,"显示器写着""朝上""，别平放"\np3,贺川,"第一行是电源\n第二行是转接头"\np4,周宁,"  备用线请留两头空格  "\n',
  '领用便签.csv': 'id,label,count\nk1,短线,2\nk2,"长线,黑色",3\n',
};

const fullPeople = [
  { key: 'a', localpart: 'zhou_ops', name: '周宁', role: '运营；通勤时只用手机，喜欢简短中文；改名阿宁', interests: '烘焙、沿河散步', motivation: '搬家别打断客户交付' },
  { key: 'b', localpart: 'zhou_dev', name: '周宁', role: '工程；数据工作用英文和紧凑表格', interests: '机械键盘、爵士乐', motivation: '把临时统计代码做成别人能运行的小模块' },
  { key: 'c', localpart: 'shen_yao', name: '沈遥', role: '空间与摄影；联系物业和货车', interests: '胶片相机、猫', motivation: '保护易碎器材，减少重复采购' },
  { key: 'd', localpart: 'he_chuan', name: '贺川', role: '设计；前半天接孩子，不在搬家群', interests: '旧书、徒步', motivation: '工作台按时可用，同时留出家人时间' },
];
const diagnosticPeople = [
  { key: 'a', localpart: 'tan_prod', name: '谭悦', role: '播客制片', interests: '红茶', motivation: '周末录音交接顺利' },
  { key: 'b', localpart: 'tan_edit', name: '谭悦', role: '剪辑工程师', interests: '吉他', motivation: '便签转成可用数据' },
  { key: 'c', localpart: 'tao_xue', name: '陶雪', role: '场地联系人', interests: '慢跑', motivation: '避免给来宾错误指路' },
  { key: 'd', localpart: 'he_shan', name: '何山', role: '临时外出的同事', interests: '旧唱片', motivation: '回来后接上工作' },
];
const roomDefinitions = people => [
  { key: 'work', name: '梧桐 · 日常工作', humans: people.map(p => p.key), bots: [0, 1, 2] },
  { key: 'life', name: '下班路上', humans: people.map(p => p.key), bots: [0, 1, 2] },
  { key: 'project', name: '工作室搬家', humans: ['a', 'b', 'c'], bots: [0, 1], historyVisibility: 'joined' },
  { key: 'private-a', kind: 'direct', human: 'a', bot: 2 },
  { key: 'private-b', kind: 'direct', human: 'b', bot: 1 },
];

function builder(profile, people) {
  const steps = [], scenes = [];
  let scene;
  const add = (sender, room, body, options = {}) => {
    const offset = steps.length - scene.start;
    const at = new Date(Date.parse(scene.businessAt) + offset * 3 * 60000).toISOString();
    steps.push({ id: `${profile}-${String(steps.length + 1).padStart(3, '0')}`, scene: scene.name, businessAt: at,
      sender, room, bot: null, body, ...options });
  };
  return { steps, scenes, say: add, ask: (sender, room, bot, body, options = {}) => add(sender, room, body, { bot, ...options }),
    scene(name, businessAt) { scene = { name, businessAt, start: steps.length }; scenes.push(scene); },
    finish() { return { schemaVersion: 1, id: `platform-natural-${profile}-01`, profile,
      scenario: profile === 'full' ? '梧桐工作室搬家：三个普通工作日' : '播客录音间：短诊断',
      businessTimeZone: 'Asia/Shanghai', clockPolicy: 'accelerated fictional business time; independent real Matrix and runner wall clocks',
      people, bots: [{ index: 0, name: '识雨' }, { index: 1, name: '知秋' }, { index: 2, name: '听澜' }],
      rooms: roomDefinitions(people).map(room => profile === 'full' ? room : { ...room, name: room.name === '工作室搬家' ? '录音间交接' : room.name === '梧桐 · 日常工作' ? '录音小组' : room.name }),
      scenes, steps, maintenance: profile === 'full' ? { compactions: [{ after: 32, bot: 0 }, { after: 64, bot: 1 }], restarts: [36, 72] } : { compactions: [], restarts: [] } }; },
  };
}

export function buildNaturalCorpus(profile = 'full') {
  if (profile === 'diagnostic') return diagnosticCorpus();
  if (profile !== 'full') throw new Error(`Unknown natural profile: ${profile}`);
  const b = builder('full', fullPeople), { say, ask } = b;
  b.scene('周一早上的小插曲', '2026-11-16T08:30:00+08:00');
  say('a', 'life', '早。雨大得我又退回楼上拿伞，结果错过了那班总晚点的公交。');
  say('c', 'life', '我也是！我们上回在站台分那只芝士面包，还是一样的天气。');
  say('d', 'life', '那次面包是我买的，伞是你俩借走的，到现在还在我车里。');
  say('b', 'life', 'At least the keyboard stayed dry this time. Mine was not so lucky last month.');
  say('a', 'work', '这周要把工作室搬完，客户那两份稿照常交。别为了搬家把所有人的一天都排满。');
  say('d', 'work', '我今天上午在学校办事，搬家群先不用拉我。下午回来能整理桌面。');
  say('c', 'work', '我负责跟物业和司机说，玻璃壶和相机我自己包，大家别抢。');
  ask('a', 'work', 0, '识雨，帮我列个轻一点的开头：今天先做哪三件事就够了？');
  say('b', 'work', 'For the numbers, compact English tables work best for me. I tend to read them between builds.');
  say('a', 'work', '群里两个周宁太容易叫错了，我把名字换成阿宁。工作安排给我简短中文就好，我上下班只看手机。', { rename: '阿宁' });
  say('c', 'life', '我家猫刚坐进空纸箱了，它对搬家唯一的贡献是增加一箱重量。');
  ask('d', 'life', 2, '听澜，你觉得它会先霸占新窗台，还是先检查每个抽屉？', { optional: true });

  b.scene('先动手，安排还没定死', '2026-11-16T14:00:00+08:00');
  say('c', 'project', '物业最早说周四九点从北门上三层，但还要等楼里会议排期。先把它当暂定。');
  say('a', 'project', '那先收不影响工作的东西，显示器和路由器放最后。我不想周三就开始用手机干活。');
  ask('a', 'project', 0, '给我一份 move-draft.md，暂定的地方显眼地标出来，先让大家知道从哪儿开始。');
  say('b', 'project', 'I found the little purchase helper I wrote in a hurry. It counts old rows twice after a correction.', { files: ['采购流水.csv', 'packing.mjs', '模块说明.md'] });
  ask('b', 'private-b', 1, 'Can you fix the purchase helper, run your own tests, and send packing.mjs and packing-tests.txt here? I have attached a copy; the module note describes the interface.', { files: ['packing.mjs', '模块说明.md', '采购流水.csv'] });
  say('c', 'project', '空箱里有几个是借的，别往上面贴那种撕不下来的大胶带。');
  ask('a', 'project', 0, '货车还没回正式报价。我现在去开会，等沈遥把报价发进来后，再帮我补进费用说明，先不用催她。', { optional: true, commitment: 'van-quote' });
  say('b', 'project', 'The allowance is 900 yuan. The van row is still an estimate; I have not paid it.');
  ask('b', 'project', 1, 'Please turn the purchase ledger into a readable costs-first.csv with id, item, quantity, unitCents, lineCents and status columns. Keep the van marked as estimated, and send the file.');
  say('d', 'life', '学校的事办完了。路过旧书摊差点又买一箱，想起这周搬家才忍住。');
  ask('a', 'private-a', 2, '贺川周三生日，我想悄悄做张银杏书签夹在他那本旧书里。帮我写两句，做成 bookmark.txt，只发这里，群里先别提。');
  say('c', 'life', '我先下班去取胶片，今天不绕去店里买更多收纳盒了。');

  b.scene('周二，有人忙，有人改了主意', '2026-11-17T08:40:00+08:00');
  say('d', 'work', '早上要陪家里人复诊，我到中午才上线，急事先找阿宁。');
  say('a', 'life', '今天终于坐上那班公交。人太挤，我把咖啡留在家里了。');
  say('b', 'life', 'Tea is safer near my desk anyway. My keyboard has served its time as a coffee filter.');
  say('a', 'project', '物业刚确认：改到周五10:20，从西侧坡道进一层。周四九点和北门三层那版作废，别让司机按旧稿走。');
  say('c', 'project', '我跟司机说了，他在西侧等我开卷门。车能到坡道口，先别承诺能开进屋。');
  say('b', 'project', 'I still have move-draft.md open. That is yesterday’s draft, so I will not use its route to book anything.');
  ask('a', 'project', 0, '帮我把给同事看的安排改成 move-current.md，我待会儿转给还没上线的人。');
  say('c', 'life', '复诊要等挺久吧。贺川回来再看就行，我这边箱子能慢慢收。');
  ask('b', 'life', 1, 'How is the little purchase helper looking? Just a compact progress note here, please.');
  say('a', 'life', '午饭我想吃热汤面，昨天那个冷三明治吃得我整个人都没精神。');
  ask('c', 'life', 2, '你给一个不需要盯屏幕的休息办法吧，我今天已经把相机背带绕成结三次了。', { optional: true });
  say('a', 'work', '我进会了，有零碎消息先放群里，不用每条等我点头。');

  b.scene('报价来了，缺席的人回来了', '2026-11-17T12:00:00+08:00');
  say('c', 'project', '仓库翻出了剩余标签纸，新标签不用买了。纸箱也够用，采购改为18个，我把更正后的流水放这里。', { files: ['采购更正.csv'] });
  ask('b', 'project', 1, 'Please update costs-current.csv from the corrected rows, using the same columns. Keep the cancelled line understandable to a person checking the bill.');
  say('c', 'life', '汤面果然好，老板居然还认得我们去年一起加班那会儿的口味。');
  say('c', 'project', '司机的正式价到了：360元，包含装卸，没有额外楼层费。就是这辆小货车，我已经确认。', { trigger: 'van-quote', followupWindowMs: 45000 });
  ask('a', 'project', 0, '知秋那边的费用和你这边的安排帮我对一下，有差异直接问它，别各算一份越改越多。');
  say('b', 'project', 'The old 758-yuan total is still in my screenshot. I am closing that image before I confuse myself.');
  say('a', 'life', '终于能喘口气。谁把窗边那盆植物带走？我怕它比我们先受不了折腾。');
  say('d', 'project', '我回来了，刚进搬家群。上午手机静音，翻到的截图还是昨天的。', { joins: ['d', 2] });
  ask('d', 'project', 2, '听澜，你也是刚进来吧？先和识雨对一下，我现在只需要知道到哪儿、什么时候，以及我先帮哪件事。');
  say('c', 'project', '你把自己的参考书装一箱就帮大忙了，插线板先留下，下午大家还要工作。');
  ask('d', 'project', 2, '门口那张手机说明想做得清楚一点。W3C 对链接文字有什么建议？查一下原文，给我们一个适合写在搬家通知里的例子。');
  say('d', 'life', '植物归我，我上回把它养活了两个月，履历应该够用了。');

  b.scene('工作还在走，纸版计划停了', '2026-11-17T15:00:00+08:00');
  ask('a', 'project', 2, '帮我做四种配色的可打印门牌，放进 door-print.html，先按现在的安排排版，我准备带去文印店。', { asynchronous: true, awaitStarted: true });
  say('b', 'life', 'The build is running, so I have exactly enough time to find out who took my mug.');
  say('c', 'life', '杯子在窗边。我把猫照片打印出来塞进去，本来想等你自己发现。');
  say('a', 'project', '等一下，文印店今天关门，纸版门牌不做了，先把这项停掉。我只在手机群里发通知。', { cancel: 'full-049' });
  ask('a', 'project', 2, '换成一段能直接转发的手机通知就够了，别再继续纸版。');
  say('c', 'project', '手机通知不需要二维码，大家本来就在群里。门口我带人就好。');
  ask('b', 'private-b', 1, 'Please run the repaired module against the latest purchase rows, including the confirmed van price. Send packing.mjs and a fresh packing-tests.txt here.');
  say('b', 'life', 'Found the mug. The cat looks much more organized than this moving project.');
  ask('a', 'project', 0, '给我起一份给同事的搬运路线说明 route-working.md，我想把人走的路和箱子走的路说清楚。', { asynchronous: true, awaitStarted: true });
  say('d', 'life', '我先去接孩子，半小时后回来。你们忙，不用等我回来才聊。');
  say('c', 'project', '物业又补了一句：货梯只运箱子，人走西侧坡道。别给同事安排在货梯口等着一起上。', { amends: 'full-057' });
  ask('a', 'project', 0, '路线说明把刚才那条补进去，最后交我 route-final.md，发之前看一眼两种路线有没有混在一起。');

  b.scene('周三早上接着过日子', '2026-11-18T08:45:00+08:00');
  say('c', 'life', '天晴了，洗的相机背带终于干了。今天不想再闻到纸箱味。');
  say('d', 'work', '我带了新订书机，旧的那个一按就散架，搬过去也只会给新桌子添乱。');
  say('a', 'work', '我九点到十点见客户，搬家这边先照昨天下午确认的走。有新情况在群里说。');
  ask('d', 'life', 2, '今天中午我想出去走十分钟，别给路线，随便讲个你觉得值得抬头看的小东西。', { optional: true });
  ask('b', 'work', 1, 'Can I have the current purchase numbers in a compact English table here? I am sending a note to finance.');
  say('d', 'project', '我缓存里那张图写的是北门九点，难怪昨天听着对不上。截图真会骗人。');
  ask('d', 'project', 0, '我给司机打电话前，你帮我确认一下现在该怎么说吧，我不想又把旧截图念给他。');
  say('c', 'project', '实际打包暂时只用了12个箱子，18个采购是留余量，别把余下的都当丢了。');
  ask('b', 'project', 1, 'Please send costs-final.json with totalCents, remainingCents and purchasedBoxes. Use the current ledger and the actual allowance.');
  say('a', 'work', '客户那份稿已经发出，我回来喝口水。今天午饭谁有空一起下楼？');
  say('c', 'life', '我有空，但先去给植物晒两分钟太阳，不然贺川接手第一天它就蔫了。');
  ask('a', 'project', 2, '搬家通知现在还有哪句容易让人误会？只挑一处最值得改的就行。');

  b.scene('零碎文件也要有人接住', '2026-11-18T14:00:00+08:00');
  say('c', 'project', '箱子备注也录好了，有人的原话带引号和换行，别替他们改语气。', { files: ['装箱备注.csv'] });
  ask('b', 'project', 1, 'Please convert those notes to packing-notes.json, an array of objects with the CSV headers as keys. Preserve every note exactly, including spaces and line breaks.');
  say('d', 'life', '今天那十分钟走到书店门口就折回来了，没有买书，算不算搬家周最大的进步。');
  ask('c', 'project', 2, '给司机的门口说明做成 door-note.html，手机打开能看清当前时间、入口和找谁开门。');
  say('c', 'project', '没买的新标签省下来了。现有的空白标签先放西侧架子第二格，谁要就从那里拿。');
  say('d', 'project', '窗台看着顺手，我要不把标签挪那儿？有光也好找。');
  ask('a', 'project', 0, '你和知秋、听澜一起看下交接还缺什么，每个人只补自己确认过的部分，给我一份 handoff.md。');
  say('a', 'project', '窗台那个想法先撤回，那里下午晒得厉害。标签还留原处，别为了顺手又换一次地方。');
  say('b', 'life', 'Three people have said “final” today. I am naming my next branch “probably”.');
  ask('d', 'life', 2, '那我箱子上写“基本确定是书”，是不是也挺诚实。', { optional: true });
  say('c', 'life', '只要别把玻璃壶写成“也许耐摔”，我都没意见。');
  ask('b', 'private-b', 1, 'Please rerun your complete current suite and send packing.mjs, packing.test.mjs, and the fresh packing-tests.txt together. I want the version someone else can run.');

  b.scene('收工前把现实交接好', '2026-11-18T17:00:00+08:00');
  say('a', 'project', '我看到旧稿里还留着周四的安排，先别删历史，当前给人的那份必须用后来确认的。');
  ask('a', 'project', 0, '给我 move-run.json，字段用 day、time、entrance、floor、boxLift、passengerRoute、contact，方便我导入小表单，再附一份能直接读的简短中文。');
  say('d', 'work', '隔壁团队也搬，约的是北门周四九点。他们问能不能借我们的胶带。');
  say('c', 'work', '胶带可以借一卷，车和物业是他们自己约的，别把两家混成一趟。');
  ask('d', 'project', 0, '我现在去写箱签，空白标签去哪儿拿？');
  say('c', 'life', '今晚我想吃披萨。忙了三天，厨房现在像临时仓库，实在不想开火。');
  ask('a', 'life', 2, '用一句话劝我今天别再买收纳盒了，语气随便一点。', { optional: true });
  say('b', 'life', 'I am taking the small keyboard home. It has earned a quiet evening.');
  ask('b', 'work', 1, 'Before I log off, send the final costs JSON and the tested module here as well. Same bytes as the versions you just checked, please.');
  say('d', 'life', '阿宁放我书里的东西我看到了，谢谢，回家路上再慢慢看。');
  ask('a', 'work', 0, '最后给我一个手机能扫完的交接：现在确定了什么，谁还有自己的事没做完。别把周五当天的事说成今天已经完成。');
  say('c', 'life', '那今天先到这里。我去取披萨，明天该上班上班，周五再一起搬。');
  return b.finish();
}

function diagnosticCorpus() {
  const b = builder('diagnostic', diagnosticPeople), { say, ask } = b;
  b.scene('午茶前的录音间交接', '2026-11-23T10:00:00+08:00');
  say('a', 'work', '早，录音间那批线材先别动，来领的人下午才到。何山还在路上，先不用拉进交接群。');
  say('b', 'work', 'Same name again. For my editing notes, short English tables are easier to scan.');
  say('a', 'work', '那我改叫小悦。我这边还是简短中文，今天一直在外面跑。', { rename: '小悦' });
  say('c', 'project', '线材暂时放三号柜，来领的人原约16:00。');
  ask('a', 'project', 0, '识雨，先出一份 pickup-draft.md，我给接班的人看，未定的地方保留。');
  say('c', 'project', '刚跟前台核过了，改为17:10在后院服务台领取，三号柜那版不要用了。');
  say('b', 'life', 'The coffee machine sounds like our old tape deck. I am taking that as a warning.');
  ask('a', 'private-a', 2, '我给何山藏了一张海蓝色唱片卡，先别在群里提。帮我写两句放进 card.txt，只发这里。');
  say('d', 'project', '我回来了，刚进这个群，手机上只有早晨的截图。', { joins: ['d', 2] });
  ask('d', 'project', 2, '听澜，你跟识雨对一下，我要给来领线材的人发消息，现在该告诉他去哪儿、几点？');
  say('b', 'project', '顺手把领用便签放这儿，下午剪辑时我就不看群了。', { files: ['领用便签.csv'] });
  ask('b', 'private-b', 1, 'Please convert this cable note to cable-counts.json and send it here. Use {items:[{id,label,count}],total}, preserve labels and use numeric counts.', { files: ['领用便签.csv'] });
  ask('a', 'project', 2, '再做一份四配色的打印提示牌 pickup-print.html，我想拿到楼下打印。', { asynchronous: true, awaitStarted: true });
  say('c', 'life', '我煮水了，谁的杯子还没拿过来？别等水凉了又说想喝热的。');
  say('a', 'project', '打印机坏了，那份打印牌先停掉，不用做完也别发旧版。我直接发手机消息。', { cancel: 'diagnostic-013' });
  ask('a', 'project', 0, '那给我一份可直接转发的短交接，再附 pickup-current.json，字段用 time 和 location。');
  return b.finish();
}

export function publicCorpusSummary(corpus) {
  const directed = corpus.steps.filter(step => step.bot !== null);
  return { id: corpus.id, profile: corpus.profile, scenario: corpus.scenario, participants: corpus.people.length,
    bots: corpus.bots.length, messages: corpus.steps.length, humanConversation: corpus.steps.length - directed.length,
    directedMessages: directed.length, optionalSocialReplies: directed.filter(step => step.optional).length,
    businessStart: corpus.steps[0].businessAt, businessEnd: corpus.steps.at(-1).businessAt, businessTimeZone: corpus.businessTimeZone,
    maintenance: corpus.maintenance, rooms: corpus.rooms.map(({ key, kind = 'group' }) => ({ key, kind })) };
}
