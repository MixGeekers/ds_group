export const systems = [
  { id: 'conversation', name: '接入与对话', status: 'partial', summary: '受限回复入口已接线；渠道、多人话题和发送回执待接入。' },
  { id: 'events', name: '事件与订阅', status: 'partial', summary: '持久事件、订阅和组件消费；外部来源与 Agent 自动续接待接入。' },
  { id: 'core', name: '核心判断与规划', status: 'planned', summary: '尚未接入决策与计划流程。' },
  { id: 'tasks', name: '目标、任务与执行', status: 'planned', summary: 'Goal、Task、worker 和效果核验闭环尚未接入。' },
  { id: 'inner', name: '内层六部分状态', status: 'planned', summary: '记忆、关系、情绪、认知、人格、能力尚未接入。' },
  { id: 'sessions', name: '模型与 Session', status: 'partial', summary: '受限原生 replyer 会话适配；实际宿主能力以连接检查结果为准。' },
  { id: 'policy', name: '权限与控制', status: 'partial', summary: '角色与事件范围校验、运行暂停；完整 Mandate 与撤权链待接入。' },
  { id: 'reliability', name: '数据与运行保障', status: 'partial', summary: '独立数据库线程、单实例、持久绑定与重启恢复；检查点和独立备份待接入。' },
  { id: 'dashboard', name: '运行仪表盘', status: 'partial', summary: '展示真实生命周期、事件、会话和未接入项，按能力逐步扩充。' },
] as const;
