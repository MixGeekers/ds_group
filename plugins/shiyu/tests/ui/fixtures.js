// Synthetic six-domain publication manifest for client behavior only.
export function makeInnerProjection({ stateVersion = 3, domains = {} } = {}) {
  const at = new Date().toISOString();
  const defaults = {
    memory: { status: 'available', backendId: 'ombre-local', deploymentId: 'deployment-a', capabilities: ['exact_read'] },
    relationship: { status: 'available', backendId: 'control-relationship', authorityId: 'relationship-test-authority', capabilities: ['metadata_read', 'content_read'] },
    emotion: { status: 'available', backendId: 'control-emotion', authorityId: 'emotion-test-authority', capabilities: ['metadata_read', 'content_read'] },
    cognition: { status: 'available', backendId: 'control-cognition', authorityId: 'cognition-test-authority', capabilities: ['metadata_read', 'content_read'] },
    personality: { status: 'available', backendId: 'control-personality', authorityId: 'personality-test-authority', capabilities: ['metadata_read', 'content_read'] },
    ability: { status: 'available', backendId: 'control-ability', authorityId: 'ability:test-authority', capabilities: ['state_read'] },
  };
  return {
    schemaVersion: 1, baselineId: 'synthetic-baseline-0000', stateVersion,
    manifest: { schemaVersion: 4, domains: { ...defaults, ...domains } },
    manifestHash: 'a'.repeat(64), publishedAt: at, publisherId: 'shiyu-state-service',
  };
}

// Synthetic channel-ingress projection (H6c). Metadata only: this fixture never
// contains a message body, summary, bodyRef or participant text, and the client
// must not invent any. Defaults mirror a ready-but-empty real ledger.
export function makeChannelBinding(overrides = {}) {
  return {
    channelRef: 'chconv-11111111111111111111111111111111', conversationId: 'test-channel-conversation-1',
    scope: 'local-owner', version: 1, appliedInvalidationWatermark: 3,
    conversationAudienceVersion: 2, replySessionEpoch: 1, lastInvalidationAt: new Date().toISOString(), ...overrides,
  };
}
export function makeChannelConnection(overrides = {}) {
  return {
    connectionId: 'chconn-22222222222222222222222222222222', sourceNamespace: 'synthetic.chat',
    provider: 'synthetic-chat', deployment: 'offline-ui-lab', accountId: 'acct-alpha', revision: 2, ...overrides,
  };
}
export function makeChannelConversation(overrides = {}) {
  return {
    conversationRef: 'chconv-33333333333333333333333333333333', connectionId: 'chconn-22222222222222222222222222222222',
    nativeConversationId: 'native-short-group-1', mode: 'group', audienceVersion: 2, audienceStatus: 'current', participantCount: 2, ...overrides,
  };
}
export function makeChannelProjection({ bindings = [makeChannelBinding()], connections = [makeChannelConnection()], conversations = [makeChannelConversation()], pending = {}, degraded = [], status = { ready: true, schemaVersion: 1 }, watermark = {}, ...rest } = {}) {
  const at = new Date().toISOString();
  return {
    schemaVersion: 1, source: 'channel-ingress', capturedAt: at, status,
    watermark: { intakeSeq: 12, invalidationWatermark: 3, deletionWatermark: 1, revocationWatermark: 2, ...watermark },
    bindings, connections, conversations,
    pending: { invalidationWatermark: 3, appliedThrough: 3, unapplied: 0, unbound: 0, truncated: false, ...pending },
    degraded, ...rest,
  };
}
export function makeEmptyChannelProjection(overrides = {}) {
  return makeChannelProjection({ bindings: [], connections: [], conversations: [],
    watermark: { intakeSeq: 0, invalidationWatermark: 0, deletionWatermark: 0, revocationWatermark: 0 },
    pending: { invalidationWatermark: 0, appliedThrough: 0, unapplied: 0, unbound: 0, truncated: false }, ...overrides });
}

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
      { id: 'inner', name: '内层状态', status: 'partial', summary: '合成测试：六域读取能力清单与不可用原因。' },
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
    diagnostics: { contextSafety: { ready: true, messageFactory: 'injected' } },
    innerProjection: makeInnerProjection(),
    // Authentic real-host shape at the current wiring level: ready, empty fields,
    // no message bodies. Individual specs override with synthetic bindings.
    channels: makeEmptyChannelProjection(),
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

// Fabricated receipt for client behavior only. No provider is contacted.
export function makeVerificationReceipt() {
  return {
    verified: true, calls: 2, sameSession: true, sessionId: 'test-model-session-1', sent: false,
    model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'low' },
    usage: [
      { inputTokens: 8, outputTokens: 2, cacheReadTokens: null },
      { inputTokens: 12, outputTokens: 2, cacheReadTokens: null },
    ],
    synthetic: true,
  };
}

// TaskView examples remain UI fixtures, never live tasks or execution requests.
export function makeTask(overrides = {}) {
  const at = new Date().toISOString();
  return {
    taskId: 'test-task-1', title: '合成任务：核对测试产物', state: 'waiting', waitReason: 'completion_verification',
    version: 1, goalId: 'test-goal-1', mandateId: 'test-mandate-1', mandateVersion: 1,
    completionSpec: { version: 1, checks: [
      { checkId: 'test-check-artifact', type: 'artifact_exists', targetRef: 'synthetic:artifact/report.txt', evidenceRequired: true },
      { checkId: 'test-check-effect', type: 'effect_verified', targetRef: 'synthetic:effect/result', evidenceRequired: true },
    ] },
    originEventIds: ['test-origin-event'], inputRefs: ['synthetic:input/request'],
    activeAssignmentId: 'test-assignment-1', latestAssignmentId: 'test-assignment-1', attempt: 1,
    result: { resultHash: 'synthetic-result-hash', artifactRefs: ['synthetic:artifact/report.txt'], effectRefs: ['synthetic:effect/result'] },
    stopRequested: false, createdAt: at, updatedAt: at,
    ...overrides,
  };
}

export function makeTaskVerification(overrides = {}) {
  return {
    taskId: 'test-task-1', assignmentId: 'test-assignment-1', completionSpecVersion: 1,
    resultHash: 'synthetic-result-hash', verifierVersion: 'synthetic-verifier-v1', verifiedAt: new Date().toISOString(),
    checks: [
      { checkId: 'test-check-artifact', status: 'pass', evidenceRefs: ['synthetic:evidence/artifact'] },
      { checkId: 'test-check-effect', status: 'pass', evidenceRefs: ['synthetic:evidence/effect'] },
    ],
    ...overrides,
  };
}

export function makeLocalTask(taskId = 'test-local-task-1') {
  return makeTask({
    taskId, title: '本地任务链路验证', state: 'queued', waitReason: undefined,
    activeAssignmentId: undefined, latestAssignmentId: undefined, attempt: 0, result: undefined,
  });
}

export function makeSucceededLocalTask(taskId = 'test-local-task-1', updatedAt = new Date().toISOString()) {
  return {
    ...makeLocalTask(taskId), state: 'succeeded', inputRefs: [`local-input:${taskId}`], updatedAt,
    verification: makeTaskVerification({ taskId }),
  };
}

// Synthetic lifecycle evidence only: this fixture creates no DSH Goal or Session.
export function makeGoalVerificationReceipt(taskId) {
  return {
    verified: true, taskId, goalId: 'test-goal-binding-1', nativeGoalId: 'test-native-goal-1',
    sessionId: 'test-goal-session-1', nativePhase: 'complete', inferenceRequested: false,
    operations: ['create', 'pause', 'resume', 'complete'], synthetic: true,
  };
}

// Local Conversation control projection only; intentionally contains no body.
export function makeConversation(overrides = {}) {
  const taskId = 'test-local-task-1';
  return {
    conversationId: 'test-conversation-1', localConversationKey: 'test-local-conversation',
    topicId: 'test-topic-1', bindingId: 'test-binding-1', scope: 'local-owner',
    audienceVersion: 1, conversationGeneration: 2, routingRevision: 3, sessionEpoch: 1,
    contextVersion: 7, needsSync: true,
    sources: [{ reference: { kind: 'task', id: taskId }, sourceVersion: 4 }],
    pending: [{ contextVersion: 7, eventId: 'test-background-event-1', reference: { kind: 'task', id: taskId }, sourceVersion: 4, evidenceRef: 'synthetic:evidence/task-version-4', gap: true }],
    taskRefs: [{ taskId, state: 'running', version: 4 }],
    subscriptionRefs: [{ id: 'test-background-subscription-1', taskId, status: 'active', replayTruncated: false, replayedCount: 0, startSequence: 1 }],
    ...overrides,
  };
}

export function makeConversationBackground(overrides = {}) {
  return {
    subscriptions: 1, pending: 0, claimed: 0, acknowledged: 9, failed: 0, cancelled: 0,
    state: 'idle', lastScanAt: new Date().toISOString(), lastBatch: { claimed: 1, processed: 1, failed: 0 },
    ...overrides,
  };
}

// Fabricated bounded context-check evidence. No Session, inference or context
// acknowledgement occurs in this fixture; GET projections are set separately.
export function makeContextVerificationReceipt(conversationId = 'test-conversation-1', bindingId = 'test-binding-1') {
  return {
    verified: true, conversationId, bindingId, sameSession: true,
    sessionId: 'test-context-session-1', calls: 2, contextDurable: true,
    draftsValidated: true, sent: false, synthetic: true,
  };
}

export function makeContextVerificationRecord(overrides = {}) {
  return {
    at: new Date().toISOString(), ok: true, message: '合成测试：背景验证保存记录。',
    instanceId: 'test-runtime-instance', calls: 2,
    conversationId: 'test-conversation-1', sessionId: 'test-context-session-1',
    ...overrides,
  };
}

// Ordinary-memory metadata only. Bodies belong to explicit synthetic read
// responses, never to makeMemory() or the runtime snapshot fixture.
export function makeMemoryEntry(overrides = {}) {
  return {
    operationId: 'test-memory-operation-1', requestId: 'test-memory-request-1',
    conversationId: 'test-conversation-1', version: 1, status: 'applied', blocked: false,
    bodyBytes: 42, consent: 'active', canRead: true,
    nativeId: 'test-native-memory-1', createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeMemory(overrides = {}) {
  return {
    configured: true, ready: true,
    backend: { state: 'ready', backendId: 'test-memory-backend', deploymentId: 'test-memory-deployment', scope: 'local-owner', embedding: 'disabled', toolCount: 3 },
    entries: [makeMemoryEntry()], ...overrides,
  };
}
