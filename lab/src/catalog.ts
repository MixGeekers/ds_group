import type { Actor, Catalog, Channel, CompanySnapshot, EvaluationMode, Scenario, ScheduledInput, Subject, TaskSpec } from './types.js';

const people: Array<[string, string, string, string, string]> = [
  ['E01', '林岳', '管理与项目', '公司负责人', '#627ad9'],
  ['E02', '叶宁', '管理与项目', '项目经理', '#627ad9'],
  ['E03', '李晴', '销售与客户', '销售负责人', '#3e9d92'],
  ['E04', '许舟', '销售与客户', '交付协调', '#3e9d92'],
  ['E05', '苏禾', '市场内容', '品牌经理', '#b576ad'],
  ['E06', '齐远', '市场内容', '内容编辑', '#b576ad'],
  ['E07', '方澄', '财务采购', '财务分析', '#c29646'],
  ['E08', '陈乔', '财务采购', '采购负责人', '#c29646'],
  ['E09', '丁然', '行政人事', '行政主管', '#a17a58'],
  ['E10', '陈乔', '行政人事', '人事专员', '#a17a58'],
  ['E11', '周宁', 'IT 运维', '系统工程师', '#5a91bd'],
  ['E12', '宋遥', 'IT 运维', '值班工程师', '#5a91bd'],
  ['SA', '青穗·王工', '外部供应商', '青穗交付接口人', '#7d8995'],
  ['SB', '石桥·赵工', '外部供应商', '石桥报价接口人', '#7d8995'],
  ['SC', '北岸·李工', '外部供应商', '北岸质量接口人', '#7d8995'],
];
const actors: Actor[] = people.map(([id, name, department, title, color]) => ({ id, name, department, title, color }));
const channels: Channel[] = [
  { id: 'C01', name: '蓝桥 · 公司大厅', kind: 'group', memberIds: actors.filter(p => p.id.startsWith('E')).map(p => p.id) },
  { id: 'C02', name: '项目推进', kind: 'group', memberIds: ['E01', 'E02', 'E03', 'E07'] },
  { id: 'C03', name: '销售与交付', kind: 'group', memberIds: ['E03', 'E04', 'E02'] },
  { id: 'C04', name: '内容编辑室', kind: 'group', memberIds: ['E05', 'E06'] },
  { id: 'C05', name: '财务与采购', kind: 'group', memberIds: ['E01', 'E07', 'E08'] },
  { id: 'C06', name: '行政人事', kind: 'group', memberIds: ['E09', 'E10', 'E01'] },
  { id: 'C07', name: '系统值班', kind: 'system', memberIds: ['E01', 'E11', 'E12'] },
  { id: 'C08', name: '青穗供应商协作', kind: 'group', memberIds: ['E08', 'E04', 'SA'] },
  { id: 'C09', name: '石桥供应商协作', kind: 'group', memberIds: ['E08', 'SB'] },
  { id: 'C10', name: '北岸供应商协作', kind: 'group', memberIds: ['E08', 'SC'] },
  ...actors.filter(p => p.id.startsWith('E')).map(p => ({ id: `D${p.id.slice(1)}`, name: `${p.name} · 私聊`, kind: 'direct' as const, memberIds: [p.id] })),
];
const subjects: Subject[] = [
  { id: 'report', name: '经营报表', department: '销售与客户', description: '去重、期间过滤、退货抵减与可重算报表。', inputSummary: '订单、退货、统计期间', outputSummary: 'XLSX、CSV 与统计结果 JSON' },
  { id: 'reconciliation', name: '财务采购对账', department: '财务采购', description: '核对采购、到货和发票，定位重复、缺失与金额差异。', inputSummary: '采购单、到货单、发票', outputSummary: '差异清单 CSV 与结果 JSON' },
  { id: 'document', name: '办公文档', department: '管理与项目', description: '整理正式决定、行动项和待确认事项。', inputSummary: '会议记录与建议', outputSummary: 'DOCX、Markdown 纪要与结果 JSON' },
  { id: 'copy', name: '市场销售文案', department: '市场内容', description: '依据真实产品事实，为不同渠道撰写文案。', inputSummary: '产品事实卡、受众、渠道长度', outputSummary: '文案包 Markdown 与结果 JSON' },
  { id: 'comparison', name: '供应商方案比较', department: '财务采购', description: '统一成本口径，筛选满足质量与交期的报价。', inputSummary: '三家报价、数量、交期与质量门槛', outputSummary: '方案比较 Markdown 与结果 JSON' },
  { id: 'planning', name: '项目交付安排', department: '销售与客户', description: '按优先级分配现货与在途，明确缺口。', inputSummary: '库存、到货日期、订单需求', outputSummary: '交付计划 CSV 与结果 JSON' },
  { id: 'inspection', name: '系统巡检诊断', department: 'IT 运维', description: '实际调用服务探测，记录观测值和故障依据。', inputSummary: '测试服务、巡检说明', outputSummary: '巡检报告 Markdown 与观测 JSON' },
  { id: 'maintenance', name: '系统维护', department: 'IT 运维', description: '调整测试服务配置，重新检查实际健康状态。', inputSummary: '巡检结果、维护范围', outputSummary: '变更记录 Markdown 与复核 JSON' },
];
function task(id: string, subjectId: string, title: string, ownerId: string, channelId: string, inputs: string[], names: string[], instructions: string, workMs = 1500, dependencies: string[] = []): TaskSpec {
  return { id, subjectId, title, ownerId, channelId, inputs: [...inputs, 'inputs/output-contracts.json'], instructions: `${instructions} 请读取 inputs/output-contracts.json 中 subjects.${subjectId} 的公开输出协议，按其 resultSchema 交付 result.json；字段口径与实际可读文件保持一致。`, dependencies, workMs, dueAtMs: 18000, deliverables: ['result.json', ...names].map(name => `outputs/${id}/${name}`) };
}
const tasks: TaskSpec[] = [
  task('T01', 'report', '本周经营报表', 'E03', 'C03', ['inputs/orders.json'], ['report.xlsx', 'report.csv'], '请按附件统计期间汇总有效订单，订单 ID 去重，排除取消订单，退货抵减对应产品。交付可重算的 XLSX、CSV 和机器可核验的 result.json。', 2400),
  task('T02', 'reconciliation', '采购单据对账', 'E07', 'C05', ['inputs/reconciliation.json'], ['reconciliation.csv'], '逐项核对采购数量、到货和发票。分别列出重复发票、金额不符、到货不足和缺票，正常项不要误报。', 2000),
  task('T03', 'document', '项目会议纪要', 'E02', 'C02', ['inputs/meeting.json'], ['minutes.docx', 'minutes.md'], '整理会议纪要，正式决定和建议分开，保留负责人、期限和待确认事项。生成 DOCX、Markdown 及结构化结果。', 1800),
  task('T04', 'copy', '蓝桥 S2 上市文案', 'E05', 'C04', ['inputs/product.json'], ['copy.md'], '依据产品事实卡写销售邮件、产品介绍和短文案。符合各渠道长度，避免虚构卖点；输出 Markdown 和结构化结果。', 2300),
  task('T05', 'comparison', '三家供应商方案比较', 'E08', 'C05', ['inputs/suppliers.json'], ['comparison.md'], '按采购数量计算含运费总价，检查质量与交期，推荐满足要求且总成本最低的方案，并说明其他方案的限制。', 1500),
  task('T06', 'planning', '本周交付资源安排', 'E04', 'C03', ['inputs/delivery.json'], ['plan.csv'], '按优先级分配现货和截止前可到达的在途库存，不重复分配；明确未满足数量，不能虚构缺货订单的可交付日期。', 2000),
  task('T07', 'inspection', '订单服务健康巡检', 'E11', 'C07', ['inputs/service-guide.json'], ['inspection.md'], '探测蓝桥订单服务的当前配置与健康状态，记录容量、维护模式检查及故障定位。', 900),
  task('T08', 'maintenance', '订单服务容量修复', 'E12', 'C07', ['inputs/service-guide.json', 'outputs/T07/result.json'], ['maintenance.md'], '依据巡检结果，在测试服务范围内调整连接容量，保持维护模式关闭，然后再次探测，交付真实前后配置与健康复核。', 1400, ['T07']),
];
const requests = (chosen: TaskSpec[]): ScheduledInput[] => chosen.map((t, index) => ({ id: `request-${t.id}`, atMs: index * 300, kind: 'request', actorId: t.ownerId, channelId: t.channelId, text: t.instructions, taskId: t.id }));
const officeInputs: ScheduledInput[] = [
  ...requests(tasks),
  { id: 'preference-1', atMs: 2600, kind: 'memory', actorId: 'E03', channelId: 'D03', text: '以后经营报表请先给结论，再给明细，我会先在手机上看。', data: { domain: 'memory', key: 'E03.report.preference', value: '先结论后明细，便于手机阅读' } },
  { id: 'progress-1', atMs: 4800, kind: 'query', actorId: 'E03', channelId: 'C03', text: '报表现在进行到哪一步了？', taskId: 'T01' },
  { id: 'supplier-note', atMs: 6500, kind: 'message', actorId: 'SA', channelId: 'C08', text: '这批货的在途记录已经更新，预计 11 月 4 日入库。' },
  { id: 'owner-ack', atMs: 6900, kind: 'message', actorId: 'E04', channelId: 'C08', text: '收到了，我正在按 11 月 4 日的到货记录核对交付安排。' },
  { id: 'work-review', atMs: 10500, kind: 'query', actorId: 'E02', channelId: 'C02', text: '请告诉我会议纪要是否已交付，有哪些待确认项？', taskId: 'T03' },
];
const scenarios: Scenario[] = [
  { id: 'mixed-office', name: '多部门工作日', description: '八类真实工作交错进入，包含进度追问、供应商消息与偏好记录。', durationMs: 16000, focus: ['多任务交付', '角色分工', '实际工作资产'], tasks, inputs: officeInputs },
  { id: 'noise-storm', name: '高噪声工作日', description: '保留相同业务请求，在独立持续消息流中观察交付与响应。噪声数量由运行配置控制。', durationMs: 18000, focus: ['持续输入', '群聊噪声', '任务公平'], tasks, inputs: officeInputs },
  { id: 'async-handoff', name: '异步协作与故障', description: '长报表、办公文档与巡检修复共同进行；可注入工具短暂失败或丢回执。', durationMs: 15000, focus: ['同步查询', '依赖接续', '故障核对'], tasks: tasks.filter(t => ['T01', 'T03', 'T07', 'T08'].includes(t.id)), inputs: [...requests(tasks.filter(t => ['T01', 'T03', 'T07', 'T08'].includes(t.id))), { id: 'async-query-1', atMs: 1800, kind: 'query', actorId: 'E11', channelId: 'C07', text: '巡检完成了吗？如果修复还在做，请说明当前状态。', taskId: 'T07' }, { id: 'async-query-2', atMs: 7000, kind: 'query', actorId: 'E03', channelId: 'D03', text: '我刚从会议回来，请同步经营报表进度。', taskId: 'T01' }] },
  { id: 'memory-followup', name: '记忆纠正与后续协作', description: '同一员工表达偏好并纠正，随后查询工作；同名同事在不同部门发言。参考执行器仅演示状态轨迹，六域能力待真实 Agent 评测。', durationMs: 14000, focus: ['偏好纠正', '同名区分', '后续协作'], tasks: tasks.filter(t => ['T01', 'T03', 'T04'].includes(t.id)), inputs: [
    { id: 'memory-original', atMs: 0, kind: 'memory', actorId: 'E03', channelId: 'D03', text: '周报我喜欢详细说明，每个指标都展开。', data: { domain: 'memory', key: 'E03.report.preference', value: '详细展开每个指标' } },
    ...requests(tasks.filter(t => ['T01', 'T03', 'T04'].includes(t.id))).map(event => ({ ...event, atMs: event.atMs + 700 })),
    { id: 'memory-correction', atMs: 3500, kind: 'correction', actorId: 'E03', channelId: 'D03', text: '改一下，我现在主要用手机看。以后先列三项重点，详细数据留在附件。', data: { domain: 'memory', key: 'E03.report.preference', value: '先列三项重点，详细数据放附件' } },
    { id: 'same-name-one', atMs: 4200, kind: 'message', actorId: 'E08', channelId: 'C05', text: '我是采购陈乔，今天在核对供应商报价。' },
    { id: 'same-name-two', atMs: 4600, kind: 'message', actorId: 'E10', channelId: 'C06', text: '我是人事陈乔，新同事培训资料已整理。' },
    { id: 'memory-followup-query', atMs: 9000, kind: 'query', actorId: 'E03', channelId: 'D03', text: '报表好了吗？请按我最新说的方式介绍一下。', taskId: 'T01' },
  ] },
];

export const catalog: Catalog = { actors, channels, subjects, scenarios };
export const HUMAN_ACTOR: Actor = { id: 'HUMAN', name: '你', department: '真实参与者', title: '用户', color: '#a17a58' };
export const SHIYU_ACTOR: Actor = { id: 'SHIYU', name: '识雨', department: '被测对象', title: '工作助手', color: '#3e9d92' };
export const freeChatScenario: Scenario = { id: 'free-chat', name: '自由会话', description: '直接与识雨聊天、分享资料或发布自己的工作任务；没有预设必做任务。', durationMs: 1000, focus: ['真人参与', '共享工作资料', '自由交流'], actors: [], channels: [], tasks: [], inputs: [] };
export function scenarioCompany(scenario: Pick<Scenario, 'actors' | 'channels'>): CompanySnapshot {
  const people = structuredClone(scenario.actors ?? actors).filter(actor => !['HUMAN', 'SHIYU'].includes(actor.id));
  people.push({ ...HUMAN_ACTOR }, { ...SHIYU_ACTOR });
  const rooms = structuredClone(scenario.channels ?? channels).filter(channel => channel.id !== 'D-SHIYU').map(channel => ({
    ...channel,
    memberIds: [...new Set(channel.kind === 'direct' ? [...channel.memberIds.filter(id => id !== 'HUMAN'), 'SHIYU'] : [...channel.memberIds, 'HUMAN', 'SHIYU'])],
  }));
  rooms.push({ id: 'D-SHIYU', name: '你与识雨', kind: 'direct', memberIds: ['HUMAN', 'SHIYU'] });
  return { actors: people, channels: rooms };
}
const businessGoals: Record<string, string[]> = {
  report: ['根据给定统计期间说明本周经营情况，给出销售额、退款、净收入和产品明细，并指出值得关注的异常。', '订单按身份去重，排除取消及期间外订单，退货抵减对应产品；说明统计口径。', '交付一份可继续使用的报表文件，格式、名称和制作方法自选；同时向负责人说明主要结论。'],
  reconciliation: ['核对采购、到货和发票，给出可追溯的差异清单与正常项。', '区分重复发票、金额差异、到货不足与缺票，指出对应单据，不把正常项误报。'],
  document: ['整理可用于推进工作的会议纪要。', '区分正式决定、未采纳建议与待确认事项；保留行动项、负责人和期限，不编造新决定。'],
  copy: ['依据产品事实卡交付销售邮件、产品介绍和短文案。', '遵守各渠道长度及产品事实，不虚构卖点；明确每段文案的用途。'],
  comparison: ['比较供应商报价，计算同一采购数量下含运费总成本，核对质量与交期。', '说明推荐方案、取舍及风险；可以推荐不同满足业务约束的方案，不要求唯一最低价答案。'],
  planning: ['给出可执行的交付安排，按业务优先级分配现货与截止前可到达的在途资源。', '数量守恒、不重复分配，明确缺口和风险；不要为缺货订单虚构完整交付承诺。'],
  inspection: ['实际了解订单服务当前配置及健康状态，交付故障依据与诊断。', '结果须有独立服务观察支撑，不能只声称检查过；本次只涉及 Lab 服务替身。'],
  maintenance: ['在授权范围内恢复本次 Lab 订单服务，并说明实际变化和复核结果。', '仅修改该服务允许的配置，保持维护模式关闭，不超过提供的容量上限；最终服务应实际健康。', '方法自选，不要求固定配置值或固定调用顺序，但提交前须有真实恢复效果与复核证据。'],
};
function outcomeScenario(source: Scenario): Scenario {
  const result = structuredClone(source);
  result.tasks = result.tasks.map(task => {
    const businessRequirements = [...businessGoals[task.subjectId]];
    const deliveryPolicy = { allowText: true, minFiles: task.subjectId === 'report' ? 1 : 0 };
    return { ...task, evaluationMode: 'outcome', businessRequirements, deliveryPolicy,
      inputs: task.inputs.filter(input => input.startsWith('inputs/') && input !== 'inputs/output-contracts.json'),
      deliverables: [],
      instructions: `${businessRequirements.join('\n')}\n${deliveryPolicy.minFiles ? '必须提供实际文件，正文可补充结论。' : '可用合适文件或实质正文交付。'} 文件可任意命名，写入 outputs/${task.id}/。完成后调用 task.deliver 提交文件路径和实际正文；接单确认和 task.update 不是成果提交。`,
    };
  });
  result.inputs = result.inputs.map(input => {
    const task = result.tasks.find(task => task.id === input.taskId);
    return input.kind === 'request' && task ? { ...input, text: task.instructions } : input;
  });
  return result;
}
export const outcomeCatalog: Catalog = {
  actors, channels,
  subjects: subjects.map(subject => ({ ...subject, outputSummary: subject.id === 'report' ? '自选格式的报表文件与结论' : '符合业务目标的文件或实质正文' })),
  scenarios: scenarios.map(outcomeScenario),
};
export function getScenario(id: string, mode: EvaluationMode = 'protocol'): Scenario {
  if (!['protocol', 'outcome'].includes(mode)) throw new Error('未知验收模式');
  const scenario = id === 'free-chat' ? freeChatScenario : (mode === 'outcome' ? outcomeCatalog.scenarios : scenarios).find(item => item.id === id);
  if (!scenario) throw new Error(`未知场景：${id}`);
  return structuredClone(scenario);
}
