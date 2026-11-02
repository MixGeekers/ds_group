export const systems = [
  { id: 'conversation', name: '接入与对话', status: 'partial', summary: '本地任务与记忆视图、稳定会话、背景加载回执及撤回失效已接线；外部渠道与发送回执待接入。' },
  { id: 'events', name: '事件与订阅', status: 'partial', summary: '持久订阅、任务完成与对话背景原子消费；外部来源与 Agent 自动续接待接入。' },
  { id: 'core', name: '核心判断与规划', status: 'planned', summary: '尚未接入决策与计划流程。' },
  { id: 'tasks', name: '目标、任务与执行', status: 'partial', summary: '受限本地任务、原生 worker、独立核验及 Goal 生命周期；持续规划和外部执行待接入。' },
  { id: 'inner', name: '内层六部分状态', status: 'partial', summary: '记忆存取、独立语义索引及授权读取已接线，可用性按真实依赖发布；关系、情绪、认知、人格、能力待接入。' },
  { id: 'sessions', name: '模型与 Session', status: 'partial', summary: '原生 replyer / worker 会话、模型路由与受限工具；压缩和长期缓存效果待验证。' },
  { id: 'policy', name: '权限与控制', status: 'partial', summary: '本地任务 Mandate、预算预留、执行资格与暂停；多用户及外部能力授权待接入。' },
  { id: 'reliability', name: '数据与运行保障', status: 'partial', summary: '独立数据库线程、单实例、持久绑定与重启恢复；检查点和独立备份待接入。' },
  { id: 'dashboard', name: '运行仪表盘', status: 'partial', summary: '展示真实生命周期、事件、会话和未接入项，按能力逐步扩充。' },
] as const;
