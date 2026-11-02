export const systems = [
  { id: 'conversation', name: '接入与对话', status: 'partial', summary: '本地对话/背景、受控 Lab 限定频道与私聊回复回执已接线；通用渠道的身份/去重/受众/墓碑（H6a）与渠道→对话持久绑定、同事务失效桥、只读投影（H6b）已离线接线，真实平台适配、渠道发送与固定宿主验收仍未完成。' },
  { id: 'events', name: '事件与订阅', status: 'partial', summary: '持久订阅、任务完成与对话背景原子消费；外部来源与 Agent 自动续接待接入。' },
  { id: 'core', name: '核心判断与规划', status: 'partial', summary: '已接入预授权本地事项选择、持久触发、独立任务核验与原生 Goal 完成；开放式分解和长期规划待接入。' },
  { id: 'tasks', name: '目标、任务与执行', status: 'partial', summary: '本地任务、原生 worker、独立核验及共享 Goal 授权已接线；外部执行与完整恢复待接入。' },
  { id: 'inner', name: '内层六部分状态', status: 'partial', summary: '记忆、关系、情绪、认知、人格与能力六域已在本机控制库接线：各域保留权威、版本、来源与撤回/删除屏障，只读视图按受众裁剪并分离元数据与正文；available 只是已发布的读取能力声明，不等于授权或业务验收，真实生成路径与跨域重算仍待推进。' },
  { id: 'sessions', name: '模型与 Session', status: 'partial', summary: '原生 replyer / worker 与 core Goal Session、受限主调用观测已接线；业务压缩、长历史恢复和长期缓存效果仍待推进。' },
  { id: 'policy', name: '权限与控制', status: 'partial', summary: 'Goal 与 Lab 范围授权、预算预留与对账、委派准入和暂停已接线；真实多用户及外部能力授权待接入。' },
  { id: 'reliability', name: '数据与运行保障', status: 'partial', summary: '独立数据库线程、单实例、持久绑定与重启恢复；检查点和独立备份待接入。' },
  { id: 'dashboard', name: '运行仪表盘', status: 'partial', summary: '展示真实生命周期、事件、会话、渠道只读投影和未接入项，按能力逐步扩充。' },
] as const;
