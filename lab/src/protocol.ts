export const protocol = {
  version: 1,
  evaluationModes: {
    protocol: '默认：固定成果契约，兼容参考执行器。',
    outcome: '仅 external：按业务目标交付，文件名称/格式/步骤自选。TaskSpec.businessRequirements 与 deliveryPolicy 是公开要求；task.deliver 是明确提交，task.update(completed) 和普通消息不算提交。'
  },
  title: '识雨 Lab 外部被测 Agent 协议',
  notice: '这是本地 DEV 接口。参考执行器仅验证 Lab；真实 Agent 需独立进程接入。Agent 可读已发生输入及工作资产，不能读取评分答案。相同操作的重试必须复用 operationId。',
  lifecycle: [
    '在界面选择外部 Agent 并启动实验，取得 runId 和仅本次显示的 targetToken。',
    '所有 /target 请求使用 Authorization: Bearer <targetToken>。',
    'GET /target/runs/:runId 查看人员、会话、当前已引入任务和可读文件。',
    'GET /target/runs/:runId/inputs?after=0，之后按最大 seq 继续轮询。输入持续独立到达。',
    'POST /target/runs/:runId/actions，正文为 { operationId, action }。工作文件路径相对 workspace。',
    '任务状态是 Agent 的上报；验收读取实际文件、服务状态和送达事件。最后更新任务状态并交付到对应会话。'
  ],
  messageReceipt: {
    transport: 'DSH 插件 public target 接口：{ runId, targetToken, request }；非下方 standalone REST actions。',
    request: { action: 'message.receipt', operationId: '原发送操作标识', channelId: '原会话标识', bodyHash: '实际送达正文 UTF-8 SHA-256，小写64位十六进制；message.send 会 trim 正文' },
    response: { status: 'delivered | not_found | ambiguous', runId: '当前运行', operationId: '原发送操作标识', channelId: '原会话标识', bodyHash: '原查询散列', eventId: '仅 delivered：唯一持久送达事件', observedAt: '仅 delivered：该事件的 at' },
    rule: '只读单个运行的持久事件，不重发、不修改事件或运行。相同 operationId 出现多条送达事件一律 ambiguous；仅唯一 target/SHIYU 送达且 channelId 与正文散列匹配才 delivered。not_found 不证明未发送；日志缺失、损坏或截断时拒绝查询，调用方保持 unknown。活动和封存房间均需原有效接入身份。'
  },
  actions: {
    'file.read': { path: 'inputs/orders.csv' },
    'file.write': { taskId: 'T01', path: 'outputs/T01/result.json', content: '{...}', encoding: 'utf8 | base64' },
    'task.update': { taskId: 'T01', status: 'queued | running | waiting | completed | failed | cancelled', detail: '当前进度；outcome 禁止用 completed 代替显式提交' },
    'task.deliver': { taskId: 'T01', paths: ['outputs/T01/自选文件名.csv'], text: '实际交付正文或成果说明；仅 outcome。paths 为该任务已注册且未损坏的文件，最多32项；允许正文交付的任务可用空数组，但不能仅发接单确认。文本最多10000字符。收件人固定为任务负责人及会话。相同 operationId 重试返回原收据；新提交在封存后拒绝。' },
    'message.send': { channelId: '从目录读取', text: '交付说明', taskId: 'T01', toActorId: '可选' },
    'service.inspect': { taskId: 'T07' },
    'service.configure': { taskId: 'T08', maxConnections: 120, maintenance: false },
    'state.record': { domain: 'memory | relationship | cognition | emotion | personality | capability', key: '字段', value: '上报值', sourceRefs: ['事件 ID'] },
    observe: { role: 'core | worker | replyer | memory', text: '可公开决策摘要', taskId: '可选' }
  },
  judge: {
    setup: '服务端环境变量 LAB_JUDGE_URL、可选 LAB_JUDGE_TOKEN；启动评分时 POST EvidencePacket 给该端点。也可从界面导入独立 Agent 的 JSON 结果。',
    response: { provider: 'judge name/version', dimensions: [{ name: '协作推进', status: 'scored', score: 4, reason: '依据事件和产物的解释', evidenceRefs: ['使用 evidence packet 中的有效 ref'] }], needsHumanReview: false },
    rule: '每个 scored 维度须有 1–5 分及有效证据引用。not_applicable / insufficient_evidence 不填分。Judge 不覆盖程序事实判定。'
  }
};
