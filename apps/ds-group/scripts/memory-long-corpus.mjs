// Frozen independent oracle. Values are provided only in learning turns, never in queries.
export const rooms = ['!north:memory.test', '!south:memory.test', '!design:memory.test', '!field:memory.test'];
export const roomNames = ['北组', '南组', '设计组', '现场组'];
export const senders = ['@lin:a.test', '@lin:b.test', '@song:memory.test'];
export function buildCorpus() {
  const steps = [], facts = [];
  const add = (index, room, sender, body, extra = {}) => steps.push({ index, room, sender, body, ...extra });
  for (let bot = 0; bot < 3; bot++) for (let room = 0; room < 4; room++) {
    const code = `苍鹭-${7321 + bot * 137 + room * 29}`;
    const rack = `${['蓝','紫','绿'][bot]}色硬盘-${room + 2}号柜`;
    const project = `${roomNames[room]}河湾${bot + 1}号`;
    for (const [attribute, value] of [['备份标签', code], ['存放位置', rack], ['发布时段', `周${['二','三','四','五'][room]}${9 + bot}点`]]) {
      facts.push({ bot, room, sender: bot % 2, project, attribute, value, learnedAt: steps.length });
      add(bot, room, bot % 2, `请记住一条${roomNames[room]}项目事实：${project}的${attribute}是「${value}」。这只适用于当前群的这个项目；后续查这项请按来源回忆。简短确认即可。`, { type: 'learn', fact: facts.length - 1 });
    }
  }
  // 36 early facts. Ordinary work makes the later checks depend on persistent memory.
  while (steps.length < 60) {
    const n = steps.length, bot = n % 3, room = n % 4;
    if (n === 40) add(0, 0, 0, '我是林青 @lin:a.test。我的报告偏好是简体中文且最多五条；请记在 own 范围，跨群都适用。', { type: 'preference' });
    else if (n === 41) add(0, 1, 1, '我是另一个林青 @lin:b.test。我的报告偏好是英文详细版且附计算表；请记在 own 范围，跨群都适用。', { type: 'preference' });
    else if (n === 44) add(0, 0, 0, '我 @lin:a.test 把显示名从林青改成青禾，账号没变。请记住我仍然要原来的报告风格。', { type: 'rename', name: '青禾' });
    else if (n === 46) add(0, 0, 2, '我只是转述，不是北组的决定：@lin:b.test 在别处说北组河湾1号的备份标签是“海鸥-9999”。我没有见过硬盘，未核实。请保留转述身份，不要改动原项目事实。', { type: 'quote' });
    else if (n === 48) add(0, 0, 0, '纠正北组河湾1号的存放位置：现在从原来位置移到了「琥珀盒-7号柜」。请 recall 找到原位置并替换；其他字段不变。', { type: 'correction', correctFact: 1, newValue: '琥珀盒-7号柜' });
    else if (n === 52) add(1, 2, 0, '请记住设计组的临时值班口令「灰鲸-527」，有效到本消息时间之后的两分钟；这是短期安排，到期就不能当作当前口令。', { type: 'expiry' });
    else if (n === 54) add(2, 3, 1, '请记住现场组的一条临时便签：旧备用钥匙盒的标记是「赤狐-804」。', { type: 'withdraw-learn' });
    else if (n === 56) add(2, 3, 1, '请忘记现场组旧备用钥匙盒那条「赤狐-804」便签。它已作废；以后不要把它当作有效记忆。', { type: 'withdraw' });
    else add(bot, room, n % 3, `本轮临时工作：有${n + 7}份样本，每箱最多6份，请算需要几箱、最后一箱多少份；列出计算结果即可，不必长期记忆。`, { type: 'work' });
  }
  for (let n = 60; n < 96; n++) {
    if ([60, 72, 84].includes(n)) {
      const bot = n === 60 ? 0 : n === 72 ? 1 : 2;
      add(bot, n % 4, 2, `请用原生文件工具创建「round-${n}.txt」，写入本轮样本统计：${n + 3}乘以7的结果，以及当前群的完整 ID。完成后给出文件。这个文件是任务产物，不要把我的任务描述当成长期偏好。`, { type: 'file', artifact: `round-${n}.txt`, expectedNumber: (n + 3) * 7 });
    } else if (n === 66) add(0, 0, 0, '请委派知秋计算23乘以19，让它返回计算结果；你收到它的实际回复后，把结果和执行者名字告诉我。使用你原生的 Bot 协作工具。', { type: 'delegate', expected: '437' });
    else if (n === 78) add(0, 0, 0, '请让听澜检查这条由我提供的信息：北组临时包裹编号为“云雀-619”。请它原样回报并注明原始说话人是 @lin:a.test、来源是北组；这次转述不构成另一个人的独立确认。', { type: 'relay', expected: '云雀-619' });
    else add(n % 3, n % 4, n % 3, `本轮临时讨论：为编号${n}的演示设计一个三步检查顺序，分别核对输入、计算和输出，每步一句话；不要改变之前的群项目事实，不必记忆这些临时步骤。`, { type: 'work' });
  }
  // 24 intermediate checks, each oracle established in an earlier learning turn.
  for (const factIndex of Array.from({ length: 24 }, (_, i) => (i * 7) % facts.length)) {
    const fact = facts[factIndex];
    add(fact.bot, fact.room, fact.sender, `请先调用 recall 查找${fact.project}的${fact.attribute}，只回答这个字段的当前值和原始说话人账号。不得凭相近项目猜测。`, { type: 'query', fact: factIndex, requiresRecall: true });
  }
  while (steps.length < 192) {
    const n = steps.length;
    if ([126, 150, 174].includes(n)) add(n % 3, n % 4, 2,
      `请用原生终端工具计算字符串“memory-round-${n}”的 SHA-256，然后调用 remember 保存“本次校验任务的实际 SHA-256”，标注为工具观测，subjectId=task:hash-${n}，predicate=sha256。完成后给出摘要。`, { type: 'tool-evidence', hashText: `memory-round-${n}` });
    else add(n % 3, n % 4, n % 3,
      `临时协作练习${n}：一批${n * 3 + 11}个零件先取走${n % 7 + 3}个，剩余按8个一组。请给出剩余数量、完整组数和余数；只处理本轮，不必保存长期记忆。`, { type: 'work' });
  }
  for (const [factIndex, fact] of facts.entries()) add(fact.bot, fact.room, fact.sender,
    `请调用 recall，查${fact.project}的${fact.attribute}。回答当前值、它适用的群完整 ID，以及原始说话人账号。若有别处转述，与本群事实分开。`,
    { type: 'query', fact: factIndex, requiresRecall: true, longGap: true });
  for (let i = 0; i < 3; i++) {
    add(0, i % 4, 2, '请 recall scope own，分别给出 @lin:a.test 和 @lin:b.test 的报告偏好，并说明现在“青禾”对应哪个账号。不要因两人都曾叫林青而合并。', { type: 'identity-query' });
    add(1, 2, 0, '请调用 recall 并用 history=true 查历史：设计组那条有效期两分钟的临时值班口令，现在是否仍有效？只答有效/已过期/未知并解释，不要猜新的口令。', { type: 'expiry-query' });
    add(2, 3, 1, '请调用 recall 并用 history=true 查历史：现场组旧备用钥匙盒的便签现在是否仍有效？只答有效/已撤回或作废/未知，不要把已忘记的便签当成当前事实。', { type: 'withdraw-query' });
    add(0, 0, 2, '请 recall 核对：海鸥-9999 这条消息是谁转述、声称原作者是谁，它是否成为北组河湾1号的正式备份标签？请区分转述与原项目事实。', { type: 'quote-query' });
  }
  if (steps.length !== 240) throw new Error(`Expected 240 steps, got ${steps.length}`);
  for (const step of steps) if (step.correctFact !== undefined) facts[step.correctFact].value = step.newValue;
  return { steps, facts };
}
