// Synthetic UI fixtures only. These do not describe a running Shiyu instance.
export function makeSnapshot({ state = 'idle', populated = false } = {}) {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1,
    version: '0.1.0',
    instanceId: 'test-runtime-instance',
    observedAt: at,
    startedAt: at,
    lifecycle: 'ready',
    state,
    systems: [
      { id: 'runtime', name: '运行底座', status: 'implemented', summary: '合成测试：生命周期已接入。' },
      { id: 'events', name: '事件系统', status: 'partial', summary: '合成测试：观察事件。' },
      { id: 'sessions', name: '会话系统', status: 'partial', summary: '合成测试：DSH Session 绑定。' },
      { id: 'core', name: '核心判断', status: 'planned', summary: '尚未实施。' },
      { id: 'inner', name: '内层状态', status: 'planned', summary: '尚未实施。' },
      { id: 'execution', name: '任务执行', status: 'planned', summary: '尚未实施。' },
      { id: 'outer', name: '对话表达', status: 'partial', summary: '合成测试：只读仪表盘。' },
      { id: 'devices', name: '设备接入', status: 'planned', summary: '尚未实施。' },
      { id: 'recovery', name: '恢复与检查点', status: 'planned', summary: '尚未实施。' },
    ],
    activeWork: populated ? [{ id: 'test-work-1', title: '合成测试工作：核对会话绑定', phase: 'checking', status: 'running' }] : [],
    activities: populated ? [{ id: 'test-activity-1', at, kind: 'diagnostic', title: '合成测试活动：会话检查结束', status: 'succeeded' }] : [],
    sessions: populated ? [makeSession(at)] : [],
    events: {
      published: populated ? 1 : 0,
      pending: 0,
      failed: 0,
      subscriptions: populated ? [{ id: 'test-subscription-1', type: 'session.updated', status: 'active', target: 'test-status-observer' }] : [],
      recent: populated ? [{ id: 'test-event-1', type: 'session.updated', at, status: 'delivered' }] : [],
    },
    dependencies: [
      { id: 'dsh-session', name: 'DSH Session', status: 'available', summary: '合成宿主接口可用，不调用真实 DSH 或模型。', checkedAt: at },
      { id: 'model', name: '模型服务', status: 'unconfigured', summary: '测试未配置模型。' },
    ],
    usage: { calls: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null },
    notices: [{ id: 'synthetic-fixture', level: 'info', message: '合成 UI 测试快照，不代表本体运行验收。' }],
  };
}

export function makeSession(at = new Date().toISOString()) {
  return {
    id: 'test-session-1', role: 'diagnostic', businessId: 'test-probe-1', status: 'archived', hostStatus: 'not_attached',
    provider: 'synthetic', model: 'no-model-called', effort: 'none', lastActivityAt: at,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null },
  };
}
