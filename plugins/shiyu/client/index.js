window.__ModuleLoader__.load({
  id: '@shiyu/runtime',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState, useSyncExternalStore } = React;
    const NS = 'shiyuRuntime';
    const zh = {
      nav: '识雨运行', title: '识雨 · 运行', overview: '概览', systems: '系统', sessions: '会话', diagnostics: '诊断',
      refresh: '刷新', refreshing: '正在刷新', loading: '正在读取运行状态…', retry: '重试', pause: '暂停运行', resume: '恢复运行',
      runtimeState: '当前状态', currentWork: '当前工作', attention: '需要处理', activities: '最近活动', noWork: '当前没有正在处理的工作',
      noAttention: '暂无需要处理的事项', noActivities: '还没有活动记录', noSessions: '还没有会话记录', noSystems: '尚未收到系统实现状态',
      status_idle: '空闲', status_busy: '处理中', status_waiting: '等待中', status_paused: '已暂停', status_unknown: '未知',
      status_ready: '就绪', status_stopping: '正在停止', status_degraded: '受限运行', status_implemented: '已实现', status_partial: '部分实现',
      status_planned: '待实现', status_blocked: '受阻', status_available: '可用', status_unavailable: '不可用', status_unconfigured: '未配置',
      status_running: '运行中', status_created: '已创建', status_completed: '已完成', status_failed: '失败', status_cancelled: '已取消',
      status_pending: '待处理', status_active: '有效', status_closed: '已关闭', status_passed: '通过', status_succeeded: '成功',
      status_accepted: '已受理', status_disposed: '已释放', status_published: '已发布', status_delivered: '已投递', status_skipped: '已跳过',
      status_diagnostic: '诊断', status_registered: '已登记', status_disabled: '已停用', status_warning: '提示', status_error: '错误',
      status_archived: '已归档', status_released: '已释放', status_creating: '创建中', status_not_attached: '未连接',
      status_queued: '排队中', status_pass: '通过', status_fail: '未通过', status_inconclusive: '不可判定',
      idleHint: '目前没有正在执行的工作。', busyHint: '正在处理已受理的工作。', waitingHint: '正在等待后续条件或处理结果。',
      pausedHint: '运行已暂停，当前状态仍可查看。', unknownHint: '暂时无法确认当前运行状态。', degradedHint: '部分运行条件尚不可用，请查看需要处理的事项。',
      stoppingHint: '正在释放本次运行资源。', staleTitle: '状态未确认', staleHint: '以下保留上次成功读取的快照。',
      loadFailed: '暂时无法读取运行状态', invalidSnapshot: '运行状态响应不兼容', snapshotOld: '快照超过 30 秒，正在等待新的状态。',
      lastRead: '最近读取', observed: '快照时间', started: '本次启动', instance: '运行实例', version: '版本', lifecycle: '生命周期',
      autoRefresh: '页面可见时每 10 秒刷新', unknownValue: '未提供', usageUnknown: '尚未取得用量',
      implementation: '实现状态', implementationHint: '这里展示各系统已落地的范围。运行状态以概览和实际活动为准。',
      sessionHint: '查看本次运行登记的会话及已报告的用量。', sessionDetails: '会话详情', sessionSelect: '选择一条会话查看详情',
      viewSession: '查看会话 {id}', sessionId: '会话 ID', role: '角色', businessId: '业务关联', status: '状态', provider: '模型提供方',
      model: '模型', effort: '思考强度', lastActivity: '最近活动', inputTokens: '输入 tokens', outputTokens: '输出 tokens', cacheReadTokens: '缓存读取 tokens',
      bindingStatus: '记录状态', hostStatus: '宿主状态', hostDetached: '当前识雨实例未连接此宿主会话。', hostUnknown: '快照未提供可确认的宿主状态。',
      calls: '模型调用', usage: '已报告用量', usageHint: '“未提供”表示尚未取得数据，不能据此推断为零。',
      events: '事件', published: '已发布', pending: '待处理', failed: '失败', subscriptions: '已登记订阅', noSubscriptions: '还没有订阅记录',
      recentEvents: '最近事件', noEvents: '还没有事件记录', eventType: '事件类型', target: '目标', dependencies: '依赖状态', noDependencies: '尚未收到依赖状态',
      probe: '检查会话接入（不调用模型）', probing: '正在检查会话接入…', probeHint: '创建一个空会话，检查接入后释放并归档。不会调用模型。',
      probeDone: '会话接入检查完成，临时空会话已释放并归档；未调用模型。', probeUnconfirmed: '会话检查回执缺少释放、归档或无模型调用的确认，请查看当前会话状态。', pausedDone: '暂停请求已完成，状态已重新读取。', resumedDone: '恢复请求已完成，状态已重新读取。',
      modelVerifyTitle: '模型与会话复用', modelVerify: '验证模型与会话复用（2 次请求）', modelVerifying: '正在验证模型与会话复用…',
      modelVerifyHint: '仅发送 2 轮合成输入，每轮最多 1024 输出 tokens。', modelVerifyLimits: '使用 opencode-go/deepseek-v4.1-flash（low）；不自动重试，不对外发送消息。',
      modelVerifyPending: '正在等待验证结果或取消回执；可通过“暂停运行”取消。', modelVerifyDone: '模型与会话复用验证通过：2 次请求使用同一会话，未对外发送消息。',
      modelVerifyUnconfirmed: '模型验证回执未完整确认 2 次请求、同一会话和未对外发送消息；结果未确认。', modelVerifyTimeout: '等待验证结果已达 250 秒，结果未确认。请查看当前状态；不会自动重试。',
      tasks: '任务', tasksHint: '查看任务记录、完成条件与独立核验结果。', tasksUnavailable: '任务视图尚未接入', noTasks: '暂无任务', taskDetails: '任务详情', taskSelect: '选择一项任务查看详情', viewTask: '查看任务 {id}',
      taskId: '任务 ID', taskState: '任务状态', waitReason: '等待原因', activeAssignment: '当前执行实例', noActiveAssignment: '无活动执行实例', attempt: '执行次数', taskUpdated: '最近更新',
      completionSpec: '完成条件', checkType: '检查类型', targetRef: '目标引用', expected: '预期结果', evidenceRequired: '是否需要证据', yes: '需要', no: '不要求', noCompletionChecks: '未提供完成检查项',
      verification: '独立核验', noVerification: '尚无独立核验记录', verificationAssignment: '被核验执行实例', verifierVersion: '核验器版本', verifiedAt: '核验时间', completionSpecVersion: '完成条件版本', resultHash: '结果摘要', noVerificationChecks: '未提供核验检查项',
      evidenceRefs: '证据引用', noEvidence: '未提供证据引用', uncertainty: '待核对信息', unknownResult: '结果未知，待核对', noUncertainty: '尚无核对原因或证据记录', uncertaintyReason: '原因', uncertaintyAt: '记录时间',
      stopRequested: '停止请求', stopRequestedYes: '已请求停止', stopRequestedNo: '未请求停止', stopPending: '停止请求尚不等于已取消；仍需核对执行和外部效果。',
      waitVerification: '等待完成核验', waitCompletionUnconfirmed: '完成结果未确认', waitCancel: '等待停止确认', waitDelivery: '输入投递未完成', waitWaiting: '等待后续条件', waitBlocked: '执行受阻', waitFailed: '执行失败待处理',
      localTaskTitle: '本地任务链路', localTaskRun: '运行本地任务验证', localTaskStarting: '正在受理本地任务…',
      localTaskHint: '仅在识雨本体的专属目录写入 note.txt。使用 deepseek-v4.1-flash（high），最多 2 个模型步骤，输出总预算 1024 tokens。',
      localTaskLimits: '受理后由后台执行，独立核验内容与回执后才算成功。不会自动启动或重试；暂停运行可取消在途模型，未确认的结果会保留为未知。',
      localTaskAccepted: '本地任务已受理（{id}）；是否完成以任务状态和独立核验为准。', localTaskUnconfirmed: '本地任务受理回执不完整，受理结果未确认。请刷新任务状态；不会自动重试。', taskNotInSnapshot: '当前快照尚未包含选中的任务记录。',
      goalVerifyTitle: '原生 Goal 生命周期', goalVerify: '检查原生 Goal 生命周期（零推理）', goalVerifying: '正在检查原生 Goal 生命周期…',
      goalVerifyHint: '使用最近已成功的本地任务，重新核验产物，再检查目标的创建、暂停、恢复和完成。不会请求模型推理或发送消息。',
      goalVerifyNeedsTask: '请先完成本地任务验证', goalVerifyTask: '检查依据任务', goalVerifyDone: '原生 Goal 生命周期检查通过：创建、暂停、恢复和完成已确认，未请求模型推理。',
      goalVerifyUnconfirmed: '原生 Goal 检查回执未完整确认任务、目标、会话、完成状态、零推理及四步操作链；结果未确认。',
      goalVerifyReceipt: '本次 Goal 检查回执', goalId: '识雨目标 ID', nativeGoalId: '原生 Goal ID', nativePhase: '原生阶段', goalOperations: '已确认操作链', inferenceRequested: '模型推理请求', noInferenceRequested: '未请求',
      conversations: '对话', conversationsHint: '查看本地对话的控制记录、任务关联和背景来源版本。这里不展示聊天或记忆正文。',
      conversationsUnavailable: '对话视图尚未接入', noConversations: '暂无本地对话记录', conversationDetails: '对话详情', conversationSelect: '选择一条对话查看详情', viewConversation: '查看对话 {id}',
      conversationId: 'Conversation ID', topicId: 'Topic ID', replyBindingId: '绑定 ID', localConversationKey: '本地对话标识', conversationScope: '固定受众范围',
      conversationScopeUnknown: '快照包含范围未确认的对话记录；未展示该记录。', conversationNotInSnapshot: '当前快照尚未包含回执对应的对话绑定；关联状态仍待核对。',
      contextVersion: '背景版本', audienceVersion: '受众版本', conversationGeneration: '对话代次', routingRevision: '路由版本', sessionEpoch: 'Session 代次',
      contextNeedsLoad: '背景信息待加载', contextNoPending: '当前未标记待加载', contextUnknown: '背景加载状态未确认',
      conversationReadOnly: '查看或刷新不会加载、消费或确认背景信息，也不代表已同步到 Session。',
      linkedTasks: '已关联任务', noLinkedTasks: '暂无已关联任务', linkedTasksUnknown: '尚未提供任务关联', recordVersion: '记录版本',
      contextSources: '当前来源版本', noContextSources: '暂无来源记录', sourcesUnknown: '尚未提供来源记录', sourceReference: '来源引用', sourceVersion: '来源版本',
      pendingSources: '待加载的背景更新', noPendingSources: '暂无背景增量记录；当前来源仍可能尚未加载。', pendingSourcesUnknown: '尚未提供待加载来源记录',
      backgroundEventId: '背景事件 ID', sourceGap: '来源版本缺口', gapPresent: '存在缺口，待核对', gapAbsent: '未记录缺口',
      conversationLinkTitle: '本地任务关联', conversationLink: '关联本地任务', conversationLinking: '正在受理关联…',
      conversationLinkHint: '选择本地任务，关联到固定 local-owner 范围的对话，默认选中最近更新的任务。只记录控制关系，不创建 Session、不调用模型或发送消息。',
      conversationLinkNeedsTask: '请先运行本地任务验证；任务无需已完成。', conversationLinkTask: '本次关联任务', conversationLinkTaskMissing: '选定任务不在当前快照中，请重新选择。',
      conversationLinkAccepted: '任务关联请求已受理（{id}）；关联记录以读取到的对话快照为准，尚不表示背景已加载。',
      conversationLinkUnconfirmed: '关联回执未完整确认本次任务、Conversation 和绑定；结果未确认。请刷新核对，不会自动重试。',
      backgroundDelivery: '后台标记投递', backgroundDeliveryHint: '这里的待投递与已落库计数属于后台投递，不代表来源已加载到 Session；暂停时仍可接收后台标记。',
      backgroundUnavailable: '后台投递状态尚未接入', backgroundState: '扫描状态', backgroundPending: '待投递', backgroundClaimed: '已认领', backgroundAcknowledged: '已落库确认', backgroundCancelled: '已取消投递',
      backgroundLastScan: '最近扫描', backgroundLastFailure: '最近失败', backgroundBatch: '最近扫描批次', backgroundProcessed: '已处理', status_stopped: '已停止',
      commandFailed: '操作未完成', commandUncertain: '操作结果未确认，请先刷新状态再决定下一步。', requestFailed: '请求失败',
      controlPending: '正在处理请求…', close: '关闭详情', phase: '阶段', checked: '最近检查', source: '来自运行快照',
    };
    const en = {
      nav: 'Shiyu Runtime', title: 'Shiyu · Runtime', overview: 'Overview', systems: 'Systems', sessions: 'Sessions', diagnostics: 'Diagnostics',
      refresh: 'Refresh', refreshing: 'Refreshing', loading: 'Reading runtime state…', retry: 'Retry', pause: 'Pause runtime', resume: 'Resume runtime',
      runtimeState: 'Current state', currentWork: 'Current work', attention: 'Needs attention', activities: 'Recent activity', noWork: 'No work is currently running',
      noAttention: 'Nothing needs attention', noActivities: 'No activity recorded yet', noSessions: 'No sessions recorded yet', noSystems: 'No implementation status received yet',
      status_idle: 'Idle', status_busy: 'Busy', status_waiting: 'Waiting', status_paused: 'Paused', status_unknown: 'Unknown',
      status_ready: 'Ready', status_stopping: 'Stopping', status_degraded: 'Degraded', status_implemented: 'Implemented', status_partial: 'Partial',
      status_planned: 'Planned', status_blocked: 'Blocked', status_available: 'Available', status_unavailable: 'Unavailable', status_unconfigured: 'Not configured',
      status_running: 'Running', status_created: 'Created', status_completed: 'Completed', status_failed: 'Failed', status_cancelled: 'Cancelled',
      status_pending: 'Pending', status_active: 'Active', status_closed: 'Closed', status_passed: 'Passed', status_succeeded: 'Succeeded',
      status_accepted: 'Accepted', status_disposed: 'Disposed', status_published: 'Published', status_delivered: 'Delivered', status_skipped: 'Skipped',
      status_diagnostic: 'Diagnostic', status_registered: 'Registered', status_disabled: 'Disabled', status_warning: 'Notice', status_error: 'Error',
      status_archived: 'Archived', status_released: 'Released', status_creating: 'Creating', status_not_attached: 'Not attached',
      status_queued: 'Queued', status_pass: 'Pass', status_fail: 'Fail', status_inconclusive: 'Inconclusive',
      idleHint: 'No work is executing at the moment.', busyHint: 'Processing accepted work.', waitingHint: 'Waiting for a condition or result.',
      pausedHint: 'The runtime is paused. Its current state remains available.', unknownHint: 'The current runtime state cannot be confirmed.',
      degradedHint: 'Some runtime conditions are unavailable. Review the items needing attention.', stoppingHint: 'Releasing resources for this runtime.',
      staleTitle: 'State unconfirmed', staleHint: 'Showing the last successfully read snapshot.', loadFailed: 'Runtime state is temporarily unavailable',
      invalidSnapshot: 'Incompatible runtime state response', snapshotOld: 'The snapshot is over 30 seconds old. Waiting for fresh state.',
      lastRead: 'Last read', observed: 'Snapshot time', started: 'Started', instance: 'Runtime instance', version: 'Version', lifecycle: 'Lifecycle',
      autoRefresh: 'Refreshes every 10 seconds while visible', unknownValue: 'Not reported', usageUnknown: 'Usage not reported yet',
      implementation: 'Implementation status', implementationHint: 'These entries describe implemented scope. See Overview and actual activity for runtime state.',
      sessionHint: 'Sessions registered by this runtime and their reported usage.', sessionDetails: 'Session details', sessionSelect: 'Select a session to inspect it',
      viewSession: 'View session {id}', sessionId: 'Session ID', role: 'Role', businessId: 'Business reference', status: 'Status', provider: 'Provider',
      model: 'Model', effort: 'Reasoning effort', lastActivity: 'Last activity', inputTokens: 'Input tokens', outputTokens: 'Output tokens', cacheReadTokens: 'Cache read tokens',
      bindingStatus: 'Record state', hostStatus: 'Host state', hostDetached: 'This Shiyu instance is not attached to the Host Session.', hostUnknown: 'The snapshot does not provide a confirmed Host state.',
      calls: 'Model calls', usage: 'Reported usage', usageHint: '“Not reported” means data is unavailable; it does not mean zero.',
      events: 'Events', published: 'Published', pending: 'Pending', failed: 'Failed', subscriptions: 'Registered subscriptions', noSubscriptions: 'No subscriptions recorded yet',
      recentEvents: 'Recent events', noEvents: 'No events recorded yet', eventType: 'Event type', target: 'Target', dependencies: 'Dependencies', noDependencies: 'No dependency status received yet',
      probe: 'Check session connection (no model call)', probing: 'Checking session connection…', probeHint: 'Creates an empty Session, checks access, then releases and archives it. No model is called.',
      probeDone: 'Session access checked. The temporary empty Session was released and archived; no model was called.', probeUnconfirmed: 'The check receipt does not confirm release, archive, or no model call. Inspect the current Session state.', pausedDone: 'Pause request completed and the state was refreshed.', resumedDone: 'Resume request completed and the state was refreshed.',
      modelVerifyTitle: 'Model and Session reuse', modelVerify: 'Verify model and Session reuse (2 requests)', modelVerifying: 'Verifying model and Session reuse…',
      modelVerifyHint: 'Sends only 2 synthetic input turns, with at most 1,024 output tokens per turn.', modelVerifyLimits: 'Uses opencode-go/deepseek-v4.1-flash (low). No automatic retries or outbound messages.',
      modelVerifyPending: 'Waiting for a result or cancellation receipt. Use “Pause runtime” to cancel.', modelVerifyDone: 'Model and Session reuse verified: 2 requests used the same Session, with no outbound message.',
      modelVerifyUnconfirmed: 'The receipt does not fully confirm 2 requests, the same Session, and no outbound message. The result is unconfirmed.', modelVerifyTimeout: 'No confirmed result after 250 seconds. Inspect the current state; no automatic retry will occur.',
      tasks: 'Tasks', tasksHint: 'Inspect task records, completion criteria, and independent verification results.', tasksUnavailable: 'Task view is not connected yet', noTasks: 'No tasks yet', taskDetails: 'Task details', taskSelect: 'Select a task to inspect it', viewTask: 'View task {id}',
      taskId: 'Task ID', taskState: 'Task state', waitReason: 'Waiting reason', activeAssignment: 'Active Assignment', noActiveAssignment: 'No active Assignment', attempt: 'Execution attempts', taskUpdated: 'Last updated',
      completionSpec: 'Completion criteria', checkType: 'Check type', targetRef: 'Target reference', expected: 'Expected result', evidenceRequired: 'Evidence required', yes: 'Required', no: 'Not required', noCompletionChecks: 'No completion checks provided',
      verification: 'Independent verification', noVerification: 'No independent verification recorded', verificationAssignment: 'Verified Assignment', verifierVersion: 'Verifier version', verifiedAt: 'Verified at', completionSpecVersion: 'Completion criteria version', resultHash: 'Result digest', noVerificationChecks: 'No verification checks provided',
      evidenceRefs: 'Evidence references', noEvidence: 'No evidence references provided', uncertainty: 'Reconciliation details', unknownResult: 'Result unknown; reconciliation required', noUncertainty: 'No reconciliation reason or evidence recorded', uncertaintyReason: 'Reason', uncertaintyAt: 'Recorded at',
      stopRequested: 'Stop request', stopRequestedYes: 'Stop requested', stopRequestedNo: 'No stop requested', stopPending: 'A stop request does not confirm cancellation. Execution and external effects still require reconciliation.',
      waitVerification: 'Awaiting completion verification', waitCompletionUnconfirmed: 'Completion unconfirmed', waitCancel: 'Awaiting stop confirmation', waitDelivery: 'Input delivery incomplete', waitWaiting: 'Waiting for a condition', waitBlocked: 'Execution blocked', waitFailed: 'Execution failure needs attention',
      localTaskTitle: 'Local task workflow', localTaskRun: 'Run local task validation', localTaskStarting: 'Admitting local task…',
      localTaskHint: 'Writes only note.txt in Shiyu’s dedicated directory. Uses deepseek-v4.1-flash (high), at most 2 model steps, and a total output budget of 1,024 tokens.',
      localTaskLimits: 'Runs in the background after admission. Success requires independent content and receipt verification. No automatic start or retry. Pause runtime cancels in-flight model work; unconfirmed outcomes remain unknown.',
      localTaskAccepted: 'Local task accepted ({id}). Completion depends on its task state and independent verification.', localTaskUnconfirmed: 'The task admission receipt is incomplete; acceptance is unconfirmed. Refresh task state. No automatic retry will occur.', taskNotInSnapshot: 'The selected task record is not in the current snapshot yet.',
      goalVerifyTitle: 'Native Goal lifecycle', goalVerify: 'Check native Goal lifecycle (no inference)', goalVerifying: 'Checking native Goal lifecycle…',
      goalVerifyHint: 'Uses the latest successful local task, rechecks its artifact, then checks Goal creation, pause, resume, and completion. No model inference or outbound message is requested.',
      goalVerifyNeedsTask: 'Complete local task validation first', goalVerifyTask: 'Task used for this check', goalVerifyDone: 'Native Goal lifecycle checked: creation, pause, resume, and completion confirmed, with no model inference requested.',
      goalVerifyUnconfirmed: 'The Goal receipt does not fully confirm the task, Goal, Session, completion, no inference, and the four-step operation sequence. The result is unconfirmed.',
      goalVerifyReceipt: 'Goal check receipt', goalId: 'Shiyu Goal ID', nativeGoalId: 'Native Goal ID', nativePhase: 'Native phase', goalOperations: 'Confirmed operation sequence', inferenceRequested: 'Model inference requested', noInferenceRequested: 'Not requested',
      conversations: 'Conversations', conversationsHint: 'Inspect local conversation control records, task links, and background source versions. Chat and memory content are not displayed.',
      conversationsUnavailable: 'Conversation view is not connected yet', noConversations: 'No local conversations yet', conversationDetails: 'Conversation details', conversationSelect: 'Select a conversation to inspect it', viewConversation: 'View conversation {id}',
      conversationId: 'Conversation ID', topicId: 'Topic ID', replyBindingId: 'Binding ID', localConversationKey: 'Local conversation key', conversationScope: 'Fixed audience scope',
      conversationScopeUnknown: 'The snapshot contains a conversation with an unconfirmed scope. That record is not displayed.', conversationNotInSnapshot: 'The receipt’s conversation binding is not in the current snapshot. The link still needs confirmation.',
      contextVersion: 'Context version', audienceVersion: 'Audience version', conversationGeneration: 'Conversation generation', routingRevision: 'Routing revision', sessionEpoch: 'Session epoch',
      contextNeedsLoad: 'Background context awaiting load', contextNoPending: 'No pending load marked', contextUnknown: 'Context load state unconfirmed',
      conversationReadOnly: 'Viewing or refreshing does not load, consume, or acknowledge context, and does not confirm synchronization to a Session.',
      linkedTasks: 'Linked tasks', noLinkedTasks: 'No linked tasks', linkedTasksUnknown: 'Task links not reported', recordVersion: 'Record version',
      contextSources: 'Current source versions', noContextSources: 'No source records', sourcesUnknown: 'Source records not reported', sourceReference: 'Source reference', sourceVersion: 'Source version',
      pendingSources: 'Background updates awaiting load', noPendingSources: 'No background update records. Current sources may still be awaiting their first load.', pendingSourcesUnknown: 'Pending source records not reported',
      backgroundEventId: 'Background event ID', sourceGap: 'Source version gap', gapPresent: 'Gap recorded; review required', gapAbsent: 'No gap recorded',
      conversationLinkTitle: 'Local task link', conversationLink: 'Link local task', conversationLinking: 'Admitting task link…',
      conversationLinkHint: 'Choose a local task to link to a conversation in the fixed local-owner scope. Defaults to the most recently updated task. Records control relationships only, without creating a Session, calling a model, or sending a message.',
      conversationLinkNeedsTask: 'Run local task validation first. The task need not be complete.', conversationLinkTask: 'Task to link', conversationLinkTaskMissing: 'The selected task is not in the current snapshot. Select a task again.',
      conversationLinkAccepted: 'Task link request accepted ({id}). Check the conversation snapshot for the link; this does not confirm that background context was loaded.',
      conversationLinkUnconfirmed: 'The receipt does not fully confirm this task, Conversation, and binding. The result is unconfirmed. Refresh to inspect it; no automatic retry will occur.',
      backgroundDelivery: 'Background marker delivery', backgroundDeliveryHint: 'Pending and acknowledged delivery counts do not confirm that sources were loaded into a Session. Background markers may still arrive while paused.',
      backgroundUnavailable: 'Background delivery status is not connected yet', backgroundState: 'Scanner state', backgroundPending: 'Awaiting delivery', backgroundClaimed: 'Claimed', backgroundAcknowledged: 'Recorded acknowledgements', backgroundCancelled: 'Cancelled deliveries',
      backgroundLastScan: 'Last scan', backgroundLastFailure: 'Last failure', backgroundBatch: 'Last scan batch', backgroundProcessed: 'Processed', status_stopped: 'Stopped',
      commandFailed: 'Operation did not complete', commandUncertain: 'The result is unconfirmed. Refresh the state before deciding what to do next.', requestFailed: 'Request failed',
      controlPending: 'Processing request…', close: 'Close details', phase: 'Phase', checked: 'Last checked', source: 'From the runtime snapshot',
    };
    const arr = value => Array.isArray(value) ? value : [];
    const text = value => value == null ? '' : String(value);
    const knownStates = new Set(Object.keys(en).filter(key => key.startsWith('status_')).map(key => key.slice(7)));
    const css = `
.syr{--sr-bg:var(--dsw-alias-bg-base,#fff);--sr-layer:var(--dsw-alias-bg-layer-1,#fafafa);--sr-hover:var(--dsw-alias-bg-layer-2,#f2f3f5);--sr-text:var(--dsw-alias-label-primary,#202124);--sr-muted:var(--dsw-alias-label-secondary,#71757c);--sr-line:var(--dsw-alias-border-l1,#e6e8eb);--sr-accent:var(--dsw-alias-brand-primary,#4b62d8);--sr-error:var(--dsw-alias-state-error-primary,#b93b3b);--sr-ok:var(--dsw-alias-state-success-primary,#2f7d68);height:100%;min-height:0;min-width:0;overflow:auto;color:var(--sr-text);background:var(--sr-bg);font-size:13px;line-height:1.6;font-family:inherit}
.syr,.syr *{box-sizing:border-box}.syr h1,.syr h2,.syr h3,.syr p{margin:0}.syr button{font:inherit;cursor:pointer;color:inherit}.syr button:disabled{cursor:default;opacity:.5}.syr :focus-visible{outline:2px solid var(--sr-accent);outline-offset:3px}.syr-wrap{max-width:1152px;margin:0 auto;padding:28px 32px 40px}.syr-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.syr-brand{display:flex;align-items:center;gap:11px;min-width:0}.syr-brand svg{color:var(--sr-accent);flex:none}.syr h1{font-size:22px;font-weight:600;letter-spacing:-.4px;line-height:1.4}.syr-meta{font-size:11px;color:var(--sr-muted);display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}.syr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.syr-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:33px;padding:5px 11px;border:1px solid var(--sr-line);border-radius:7px;background:var(--sr-bg);white-space:normal;text-align:center}.syr-btn:hover:not(:disabled){background:var(--sr-hover)}.syr-btn.syr-subtle{border-color:transparent;background:transparent;color:var(--sr-muted)}.syr-btn.syr-subtle:hover{background:var(--sr-hover)}.syr-btn svg{flex:none}.syr-tabs{display:flex;gap:24px;border-bottom:1px solid var(--sr-line);margin-bottom:24px;overflow-x:auto}.syr-tab{border:0;border-bottom:2px solid transparent;background:none;padding:9px 1px;color:var(--sr-muted)!important;white-space:nowrap}.syr-tab[aria-current=page]{color:var(--sr-text)!important;border-bottom-color:var(--sr-accent);font-weight:600}.syr-stack{display:flex;flex-direction:column;gap:22px}.syr-row{display:flex;align-items:center;gap:10px;min-width:0}.syr-between{justify-content:space-between}.syr-muted{color:var(--sr-muted)}.syr-small{font-size:12px}.syr-break{overflow-wrap:anywhere;word-break:break-word}.syr-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.syr h2{font-size:15px;font-weight:600}.syr h3{font-size:13px;font-weight:600}.syr-count{font-variant-numeric:tabular-nums;font-size:11px;font-weight:400;color:var(--sr-muted);margin-left:8px}.syr-state{border:1px solid var(--sr-line);border-radius:9px;padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:20px;background:var(--sr-layer)}.syr-state-label{font-size:11px;color:var(--sr-muted);margin-bottom:7px}.syr-state-main{display:flex;align-items:center;gap:10px;font-size:24px;font-weight:550;line-height:1.35;margin-bottom:8px}.syr-dot{width:8px;height:8px;border-radius:50%;background:var(--sr-muted);flex:none;display:inline-block}.syr-dot[data-state=idle],.syr-dot[data-state=ready],.syr-dot[data-state=available],.syr-dot[data-state=implemented],.syr-dot[data-state=completed],.syr-dot[data-state=succeeded]{background:var(--sr-ok)}.syr-dot[data-state=busy],.syr-dot[data-state=running],.syr-dot[data-state=partial],.syr-dot[data-state=active]{background:var(--sr-accent)}.syr-dot[data-state=failed],.syr-dot[data-state=blocked],.syr-dot[data-state=unavailable],.syr-dot[data-state=error]{background:var(--sr-error)}.syr-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:11px;color:var(--sr-muted)}.syr-status .syr-dot{width:5px;height:5px}.syr-state-info{text-align:right;flex:none;font-size:11px;color:var(--sr-muted)}.syr-columns{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:24px}.syr-box{min-width:0;border:1px solid var(--sr-line);border-radius:9px;padding:18px 20px}.syr-empty{font-size:12px;color:var(--sr-muted);padding:18px 0}.syr-entry{padding:12px 0;border-bottom:1px solid var(--sr-line);min-width:0}.syr-entry:last-child{border-bottom:0;padding-bottom:0}.syr-entry:first-child{padding-top:0}.syr-entry-title{font-weight:500;overflow-wrap:anywhere}.syr-entry p{font-size:12px;overflow-wrap:anywhere;margin-top:4px}.syr-notice{padding-left:11px;border-left:2px solid var(--sr-line)}.syr-notice[data-level=error]{border-left-color:var(--sr-error)}.syr-notice[data-level=warning]{border-left-color:var(--sr-accent)}.syr-alert{border:1px solid var(--sr-line);border-left:3px solid var(--sr-error);border-radius:7px;padding:11px 14px;margin-bottom:18px;font-size:12px;overflow-wrap:anywhere;background:var(--sr-layer)}.syr-alert strong{display:block;margin-bottom:3px}.syr-feedback{font-size:12px;color:var(--sr-muted);padding:10px 0;margin-bottom:8px;overflow-wrap:anywhere}.syr-timeline{list-style:none;padding:0;margin:0}.syr-timeline li{display:grid;grid-template-columns:110px 1fr auto;gap:16px;padding:11px 0;border-bottom:1px solid var(--sr-line);align-items:start}.syr-timeline li:last-child{border:0}.syr-timeline time{color:var(--sr-muted);font-size:11px;font-variant-numeric:tabular-nums}.syr-event-metrics{display:flex;gap:22px;flex-wrap:wrap;margin:4px 0 12px}.syr-metric{font-size:12px;color:var(--sr-muted)}.syr-metric strong{font-weight:500;color:var(--sr-text);margin-right:6px;font-variant-numeric:tabular-nums}.syr-system-list{border-top:1px solid var(--sr-line)}.syr-system-row{padding:17px 0;display:grid;grid-template-columns:minmax(150px,.7fr) 110px minmax(0,2fr);gap:20px;border-bottom:1px solid var(--sr-line);align-items:start}.syr-system-row p{font-size:12px;color:var(--sr-muted);overflow-wrap:anywhere}.syr-session-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.9fr);gap:24px;align-items:start}.syr-session-list{display:flex;flex-direction:column;gap:7px}.syr-session-button{border:1px solid var(--sr-line);border-radius:7px;text-align:left;padding:13px 14px;background:var(--sr-bg);width:100%;min-width:0}.syr-session-button:hover{background:var(--sr-layer)}.syr-session-button[aria-pressed=true]{border-color:var(--sr-accent);background:var(--sr-layer)}.syr-session-button .syr-id{display:block;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--sr-muted);margin-top:6px}.syr-facts{margin:0;display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 14px;font-size:12px}.syr-facts dt{color:var(--sr-muted)}.syr-facts dd{margin:0;overflow-wrap:anywhere}.syr-facts .syr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.syr-divider{border:0;border-top:1px solid var(--sr-line);margin:18px 0}.syr-diagnostic-head{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}.syr-dependency{padding:12px 0;border-bottom:1px solid var(--sr-line)}.syr-dependency:last-child{border:0}.syr-dependency p{margin-top:5px;font-size:12px;color:var(--sr-muted);overflow-wrap:anywhere}.syr-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}.syr-footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--sr-line);margin-top:28px;padding-top:12px;font-size:11px;color:var(--sr-muted)}.syr-loading{padding:36px 0;color:var(--sr-muted);font-size:13px}.syr-system-heading{margin-bottom:20px}.syr-system-heading p{font-size:12px;color:var(--sr-muted);margin-top:6px}.syr-section-gap{margin-top:22px}
@media(max-width:820px){.syr-wrap{padding:22px 22px 32px}.syr-columns,.syr-session-layout{grid-template-columns:1fr}.syr-system-row{grid-template-columns:minmax(0,1fr) auto;gap:7px 16px}.syr-system-row p{grid-column:1/-1}.syr-state-info{display:none}}
@media(max-width:480px){.syr-wrap{padding:18px 16px 26px}.syr-header{align-items:flex-start;flex-wrap:wrap;gap:12px}.syr h1{font-size:21px}.syr-header>.syr-actions{margin-left:37px}.syr-tabs{gap:22px;margin-bottom:18px}.syr-box{padding:16px}.syr-state{padding:17px}.syr-state-main{font-size:22px}.syr-timeline li{grid-template-columns:1fr auto;gap:4px 12px}.syr-timeline time{grid-column:1/-1}.syr-facts{grid-template-columns:94px minmax(0,1fr);gap:9px 12px}.syr-diagnostic-head{align-items:flex-start;flex-direction:column}.syr-diagnostic-head .syr-btn{max-width:100%}.syr-footer{flex-direction:column;gap:4px}}
.syr-task-layout{display:grid;grid-template-columns:minmax(240px,.75fr) minmax(0,1.4fr);gap:24px;align-items:start}.syr-task-label{font-weight:500;overflow-wrap:anywhere}.syr-task-list-row{align-items:flex-start;flex-wrap:wrap}.syr-task-caption{display:block;margin-top:5px;font-size:11px;color:var(--sr-muted)}.syr-task-detail{min-width:0}.syr-task-detail>.syr-section-title{align-items:flex-start}.syr-task-detail .syr-alert{margin-top:16px}.syr-task-check{border-top:1px solid var(--sr-line);padding:14px 0}.syr-task-check:last-child{padding-bottom:0}.syr-task-check>h3,.syr-task-check>.syr-row{margin-bottom:10px}.syr-evidence{margin:6px 0 0;padding-left:18px;font-size:11px;overflow-wrap:anywhere}.syr-evidence li{padding:3px 0}.syr-evidence code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.syr-task-result{margin-top:16px;padding-top:16px;border-top:1px solid var(--sr-line)}.syr-task-result .syr-small{margin-top:8px}
.syr-link-controls{min-width:0;flex:1 1 280px}.syr-select-label{display:flex;flex-direction:column;gap:5px;margin-top:12px;max-width:100%;font-size:12px}.syr-select{font:inherit;color:var(--sr-text);background:var(--sr-bg);border:1px solid var(--sr-line);border-radius:7px;min-height:34px;padding:6px 8px;width:100%;max-width:480px;min-width:0}.syr-select:disabled{opacity:.5}
@media(max-width:820px){.syr-task-layout{grid-template-columns:1fr}.syr-task-detail .syr-facts{grid-template-columns:100px minmax(0,1fr)}}
@media(max-width:480px){.syr-link-controls{flex:initial;width:100%}}
`;
    function Icon({ name = 'rain', size = 18 }) {
      const paths = {
        rain: ['M12 2.5C9.6 6.3 6.3 9.5 6.3 13a5.7 5.7 0 0 0 11.4 0c0-3.5-3.3-6.7-5.7-10.5Z', 'M4 20.2c2.7-1.3 5.3-1.3 8 0s5.3 1.3 8 0'],
        refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 6.5A7.5 7.5 0 0 1 18.9 9L20 12M4 12l1.1 3a7.5 7.5 0 0 0 12.8 2.5'],
        pause: ['M8 5v14M16 5v14'], play: ['m8 4 12 8-12 8Z'], close: ['m6 6 12 12M18 6 6 18'],
      };
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        ...(paths[name] || paths.rain).map((d, index) => h('path', { d, key: index })));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        const panelDisposers = new Set();
        let disposed = false;
        const subscribe = callback => ctx.locale.subscribe(callback);
        const getLocale = () => ctx.locale.getSnapshot();
        const endpoint = name => new URL(`api/shiyu/${name}`, document.baseURI).href;
        const label = value => knownStates.has(value) ? t(`status_${value}`) : text(value) || t('unknownValue');
        const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : t('unknownValue');
        const waitReason = value => {
          const key = { completion_verification: 'waitVerification', completion_unconfirmed: 'waitCompletionUnconfirmed', cancel_requested: 'waitCancel', delivery_failed: 'waitDelivery', waiting: 'waitWaiting', blocked: 'waitBlocked', failed: 'waitFailed' }[value];
          return key ? t(key) : text(value) || t('unknownValue');
        };
        const expectedValue = value => typeof value === 'string' ? value : JSON.stringify(value) ?? t('unknownValue');
        function dateTime(value, locale) {
          if (!value) return t('unknownValue');
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return t('unknownValue');
          try { return date.toLocaleString(locale || 'zh', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
          catch { return date.toISOString(); }
        }
        async function api(name, { signal, action, payload = {} } = {}) {
          let response;
          try {
            response = await fetch(endpoint(name), { method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
              ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, action }) } : {}) });
          } catch (error) { if (signal?.aborted) throw error; throw new Error(t(action ? 'commandUncertain' : 'loadFailed')); }
          let data;
          try { data = await response.json(); }
          catch { throw new Error(`${t(action ? 'commandUncertain' : 'invalidSnapshot')} (${response.status})`); }
          if (!response.ok || data?.ok === false) throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message) || data?.message || `${t('requestFailed')} (${response.status})`);
          return data;
        }
        function Status({ value }) { return h('span', { className: 'syr-status' }, h('span', { className: 'syr-dot', 'data-state': value }), label(value)); }
        function Button({ icon, children, ...props }) { return h('button', { type: 'button', className: 'syr-btn', ...props }, icon && h(Icon, { name: icon, size: 15 }), children); }
        function Empty({ children }) { return h('p', { className: 'syr-empty' }, children); }
        function Title({ children, count }) { return h('div', { className: 'syr-section-title' }, h('h2', null, children, count !== undefined && h('span', { className: 'syr-count' }, count))); }
        function Facts({ rows }) { return h('dl', { className: 'syr-facts' }, ...rows.flatMap(([key, value, mono]) => [h('dt', { key: `${key}:label` }, t(key)), h('dd', { key, className: mono ? 'syr-mono' : undefined }, value ?? t('unknownValue'))])); }
        function Evidence({ values }) {
          return arr(values).length ? h('ul', { className: 'syr-evidence' }, ...values.map((value, index) => h('li', { key: index }, h('code', null, text(value))))) : h('p', { className: 'syr-small syr-muted' }, t('noEvidence'));
        }
        function RuntimePanel() {
          const locale = useSyncExternalStore(subscribe, getLocale, getLocale).active;
          const [snapshot, setSnapshot] = useState(null);
          const [readError, setReadError] = useState('');
          const [loading, setLoading] = useState(true);
          const [lastRead, setLastRead] = useState(null);
          const [clock, setClock] = useState(Date.now());
          const [tab, setTab] = useState('overview');
          const [selectedSession, setSelectedSession] = useState(null);
          const [selectedTask, setSelectedTask] = useState(null);
          const [selectedConversation, setSelectedConversation] = useState(null);
          const [linkTaskId, setLinkTaskId] = useState(null);
          const [command, setCommand] = useState('');
          const [commandError, setCommandError] = useState('');
          const [commandNotice, setCommandNotice] = useState('');
          const [controlCommand, setControlCommand] = useState('');
          const [controlError, setControlError] = useState('');
          const [controlNotice, setControlNotice] = useState('');
          const [goalReceipt, setGoalReceipt] = useState(null);
          const rootRef = useRef(null);
          const operations = useRef({ refresh: () => {}, command: () => {} });
          useEffect(() => {
            if (disposed) return;
            let alive = true, panelVisible = Boolean(rootRef.current?.getClientRects().length), reading = null, commandInFlight = false, controlInFlight = false;
            const writes = new Set(), deadlines = new Set();
            const canRead = () => alive && !disposed && panelVisible && document.visibilityState !== 'hidden';
            async function refresh(force = false) {
              if (!alive || disposed || (!force && !canRead())) return false;
              if (reading) { if (!force) return false; reading.abort(); }
              const controller = new AbortController(); reading = controller;
              setLoading(true);
              const timeout = setTimeout(() => controller.abort(), 15000);
              try {
                const next = await api('state', { signal: controller.signal });
                if (next?.schemaVersion !== 1 || !Array.isArray(next.systems) || !Array.isArray(next.sessions) || !next.observedAt || !['idle', 'busy', 'waiting', 'paused', 'unknown'].includes(next.state)) throw new Error(t('invalidSnapshot'));
                if (!alive || disposed || reading !== controller) return false;
                setSnapshot(next); setLastRead(new Date().toISOString()); setReadError(''); setClock(Date.now());
                return true;
              } catch (error) {
                if (alive && !disposed && reading === controller) setReadError(controller.signal.aborted ? t('loadFailed') : error.message || t('loadFailed'));
                return false;
              } finally {
                clearTimeout(timeout);
                if (reading === controller) { reading = null; if (alive && !disposed) setLoading(false); }
              }
            }
            async function issue(action, payload = {}) {
              const isControl = action === 'runtime.pause' || action === 'runtime.resume';
              if (!alive || disposed || (isControl ? controlInFlight || (action === 'runtime.resume' && commandInFlight) : commandInFlight || controlInFlight)) return;
              const setPending = isControl ? setControlCommand : setCommand;
              const setError = isControl ? setControlError : setCommandError;
              const setNotice = isControl ? setControlNotice : setCommandNotice;
              if (isControl) controlInFlight = true; else commandInFlight = true;
              setPending(action); setError(''); setNotice('');
              if (action === 'goal.verify-lifecycle') setGoalReceipt(null);
              const controller = new AbortController(); writes.add(controller);
              let timedOut = false;
              const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, action === 'session.verify-model' ? 250000 : 20000);
              deadlines.add(timeout);
              try {
                const result = await api('commands', { signal: controller.signal, action, payload });
                if (action === 'session.probe' && (result?.ready !== true || result?.noModelCalled !== true || result?.released !== true || result?.archived !== true)) throw new Error(t('probeUnconfirmed'));
                if (action === 'session.verify-model' && (result?.verified !== true || result?.calls !== 2 || result?.sameSession !== true || result?.sent !== false)) throw new Error(t('modelVerifyUnconfirmed'));
                if (action === 'task.createLocal' && (result?.accepted !== true || typeof result?.task?.taskId !== 'string' || !result.task.taskId.trim())) throw new Error(t('localTaskUnconfirmed'));
                if (action === 'conversation.linkLocalTask' && (result?.accepted !== true || result?.taskId !== payload.taskId
                  || !['conversationId', 'bindingId'].every(key => typeof result?.[key] === 'string' && Boolean(result[key].trim())))) throw new Error(t('conversationLinkUnconfirmed'));
                if (action === 'goal.verify-lifecycle' && (result?.verified !== true || result?.taskId !== payload.taskId
                  || !['goalId', 'nativeGoalId', 'sessionId'].every(key => typeof result?.[key] === 'string' && Boolean(result[key].trim()))
                  || result?.nativePhase !== 'complete' || result?.inferenceRequested !== false
                  || !Array.isArray(result?.operations) || result.operations.length !== 4
                  || !['create', 'pause', 'resume', 'complete'].every((operation, index) => result.operations[index] === operation))) throw new Error(t('goalVerifyUnconfirmed'));
                if (!alive || disposed) return;
                if (action === 'task.createLocal') {
                  // Admission is a receipt, not a task outcome or a replacement snapshot.
                  setNotice(t('localTaskAccepted', { id: result.task.taskId }));
                  setSelectedTask(result.task.taskId); setTab('tasks');
                }
                if (action === 'goal.verify-lifecycle') {
                  setGoalReceipt({ taskId: result.taskId, goalId: result.goalId, nativeGoalId: result.nativeGoalId, sessionId: result.sessionId,
                    nativePhase: result.nativePhase, inferenceRequested: result.inferenceRequested, operations: [...result.operations] });
                  setNotice(t('goalVerifyDone'));
                }
                if (action === 'conversation.linkLocalTask') {
                  // A receipt selects a binding; only a subsequent GET supplies its projection.
                  setNotice(t('conversationLinkAccepted', { id: result.taskId }));
                  setSelectedConversation({ conversationId: result.conversationId, bindingId: result.bindingId, taskId: result.taskId }); setTab('conversations');
                }
                const refreshed = await refresh(true);
                if (alive && !disposed && refreshed && !['task.createLocal', 'goal.verify-lifecycle', 'conversation.linkLocalTask'].includes(action)) setNotice(t(action === 'session.probe' ? 'probeDone' : action === 'session.verify-model' ? 'modelVerifyDone' : action === 'runtime.pause' ? 'pausedDone' : 'resumedDone'));
              } catch (error) {
                if (alive && !disposed) { setError(timedOut && action === 'session.verify-model' ? t('modelVerifyTimeout') : controller.signal.aborted ? t('commandUncertain') : error.message || t('commandFailed')); await refresh(true); }
              } finally {
                clearTimeout(timeout); deadlines.delete(timeout); writes.delete(controller);
                if (isControl) controlInFlight = false; else commandInFlight = false;
                if (alive && !disposed) setPending('');
              }
            }
            operations.current = { refresh: () => refresh(true), command: issue };
            const onVisibility = () => { setClock(Date.now()); if (canRead()) void refresh(); };
            document.addEventListener('visibilitychange', onVisibility);
            const timer = setInterval(() => { if (canRead()) { setClock(Date.now()); void refresh(); } }, 10000);
            const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
              const wasVisible = panelVisible; panelVisible = entries.some(entry => entry.isIntersecting);
              if (!wasVisible && panelVisible && canRead()) void refresh();
            }) : null;
            if (rootRef.current) observer?.observe(rootRef.current);
            void refresh();
            const cleanup = () => {
              if (!alive) return; alive = false;
              reading?.abort(); for (const controller of writes) controller.abort(); for (const timeout of deadlines) clearTimeout(timeout);
              writes.clear(); deadlines.clear(); clearInterval(timer); observer?.disconnect();
              document.removeEventListener('visibilitychange', onVisibility);
              operations.current = { refresh: () => {}, command: () => {} };
              panelDisposers.delete(cleanup);
            };
            panelDisposers.add(cleanup);
            return cleanup;
          }, []);
          const observedMs = snapshot ? Date.parse(snapshot.observedAt) : NaN;
          const aged = Boolean(snapshot && (!Number.isFinite(observedMs) || clock - observedMs > 30000));
          const stale = Boolean(readError || aged);
          const state = snapshot?.state || 'unknown';
          const canCommand = Boolean(snapshot && !stale && snapshot.lifecycle !== 'stopping' && !command && !controlCommand);
          const canStartCommand = canCommand && state !== 'paused';
          const canCreateLocalTask = canStartCommand && typeof snapshot?.instanceId === 'string' && Boolean(snapshot.instanceId.trim());
          // Pausing has its own request lane, including while a long check is waiting.
          // A stale read must not prevent cancellation of a request this panel started.
          const canControl = state === 'paused' ? canCommand : Boolean(snapshot && snapshot.lifecycle !== 'stopping' && !controlCommand && (!stale || command));
          const work = arr(snapshot?.activeWork), activities = arr(snapshot?.activities), sessions = arr(snapshot?.sessions);
          const systems = arr(snapshot?.systems), dependencies = arr(snapshot?.dependencies), notices = arr(snapshot?.notices);
          const tasksConnected = Array.isArray(snapshot?.tasks), tasks = arr(snapshot?.tasks);
          const goalTask = tasks.filter(item => item.state === 'succeeded' && typeof item.taskId === 'string' && Boolean(item.taskId.trim())
            && arr(item.inputRefs).includes(`local-input:${item.taskId}`) && Number.isFinite(Date.parse(item.updatedAt)))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.taskId.localeCompare(b.taskId))[0];
          const localTasks = tasks.filter(item => typeof item.taskId === 'string' && Boolean(item.taskId.trim())
            && arr(item.inputRefs).includes(`local-input:${item.taskId}`) && Number.isFinite(Date.parse(item.updatedAt)))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.taskId.localeCompare(b.taskId));
          const localTask = linkTaskId === null ? localTasks[0] : localTasks.find(item => item.taskId === linkTaskId);
          const conversationsConnected = Array.isArray(snapshot?.conversations);
          const conversations = arr(snapshot?.conversations).filter(item => item?.scope === 'local-owner');
          const foreignConversations = conversations.length !== arr(snapshot?.conversations).length;
          const conversation = selectedConversation ? conversations.find(item => item.bindingId === selectedConversation.bindingId && item.conversationId === selectedConversation.conversationId
            && (!selectedConversation.taskId || arr(item.taskRefs).some(ref => ref.taskId === selectedConversation.taskId))) : undefined;
          const background = snapshot?.background && typeof snapshot.background === 'object' && !Array.isArray(snapshot.background) ? snapshot.background : null;
          const contextLabel = item => t(item?.needsSync === true ? 'contextNeedsLoad' : item?.needsSync === false ? 'contextNoPending' : 'contextUnknown');
          const sourceRef = value => typeof value?.kind === 'string' && typeof value?.id === 'string' ? `${value.kind}:${value.id}` : t('unknownValue');
          const task = tasks.find(item => item.taskId === selectedTask);
          const selected = sessions.find(session => session.id === selectedSession);
          const hostState = session => ['idle', 'running', 'not_attached'].includes(session.hostStatus) ? session.hostStatus : 'unknown';
          const sessionRows = session => [
            ['sessionId', session.id, true], ['role', session.role], ['businessId', session.businessId || t('unknownValue'), true], ['bindingStatus', label(session.status)], ['hostStatus', label(hostState(session))],
            ['provider', session.provider || t('unknownValue')], ['model', session.model || t('unknownValue')], ['effort', session.effort || t('unknownValue')],
            ['lastActivity', dateTime(session.lastActivityAt, locale)],
          ];
          const usageRows = usage => ['inputTokens', 'outputTokens', 'cacheReadTokens'].map(key => [key, numeric(usage?.[key])]);
          function eventMetrics() {
            return h('div', { className: 'syr-event-metrics' }, ...['published', 'pending', 'failed'].map(key => h('span', { className: 'syr-metric', key }, h('strong', null, numeric(snapshot?.events?.[key])), t(key))));
          }
          function overview() {
            const lifecycle = snapshot.lifecycle;
            const stateHint = lifecycle === 'stopping' ? 'stoppingHint' : lifecycle === 'degraded' ? 'degradedHint' : `${state}Hint`;
            return h('div', { className: 'syr-stack' },
              h('section', { className: 'syr-state', 'aria-label': t('runtimeState'), 'data-testid': 'runtime-state' },
                h('div', null, h('div', { className: 'syr-state-label' }, t('runtimeState')), h('div', { className: 'syr-state-main' }, h('span', { className: 'syr-dot', 'data-state': stale ? 'unknown' : state }), stale ? t('staleTitle') : label(state)), h('p', { className: 'syr-small syr-muted' }, stale ? t('staleHint') : t(stateHint))),
                h('div', { className: 'syr-state-info' }, h('div', null, `${t('lifecycle')} · ${label(lifecycle)}`), h('div', null, `${t('started')} · ${dateTime(snapshot.startedAt, locale)}`))),
              h('div', { className: 'syr-columns' },
                h('section', { className: 'syr-box', 'data-testid': 'active-work', 'aria-label': t('currentWork') }, h(Title, { count: work.length }, t('currentWork')),
                  work.length ? work.map(item => h('article', { className: 'syr-entry', key: item.id }, h('div', { className: 'syr-row syr-between' }, h('span', { className: 'syr-entry-title' }, item.title), h(Status, { value: item.status })), h('p', { className: 'syr-muted' }, `${t('phase')} · ${text(item.phase) || t('unknownValue')}`))) : h(Empty, null, t('noWork'))),
                h('section', { className: 'syr-box', 'data-testid': 'attention', 'aria-label': t('attention') }, h(Title, { count: notices.length }, t('attention')),
                  notices.length ? notices.map(item => h('div', { key: item.id, className: 'syr-entry' }, h('p', { className: 'syr-notice', 'data-level': item.level }, item.message))) : h(Empty, null, t('noAttention')))),
              h('section', { 'data-testid': 'activities', 'aria-label': t('activities') }, h(Title, null, t('activities')),
                activities.length ? h('ol', { className: 'syr-timeline' }, ...activities.map(item => h('li', { key: item.id }, h('time', { dateTime: item.at }, dateTime(item.at, locale)), h('span', { className: 'syr-break' }, item.title), h(Status, { value: item.status })))) : h(Empty, null, t('noActivities'))),
              h('section', { className: 'syr-box' }, h(Title, null, t('events')), eventMetrics()));
          }
          function systemContent() {
            return h('section', null, h('div', { className: 'syr-system-heading' }, h('h2', null, t('implementation')), h('p', null, t('implementationHint'))),
              h('div', { className: 'syr-system-list', 'data-testid': 'system-list' }, systems.length ? systems.map(item => h('article', { key: item.id, className: 'syr-system-row' }, h('h3', null, item.name), h(Status, { value: item.status }), h('p', null, item.summary))) : h(Empty, null, t('noSystems'))));
          }
          function sessionContent() {
            return h('section', null, h('div', { className: 'syr-system-heading' }, h('h2', null, t('sessions')), h('p', null, t('sessionHint'))),
              sessions.length ? h('div', { className: 'syr-session-layout' },
                h('div', { className: 'syr-session-list' }, ...sessions.map(session => h('button', { type: 'button', key: session.id, className: 'syr-session-button', 'aria-label': t('viewSession', { id: session.id }), 'aria-pressed': selectedSession === session.id, onClick: () => setSelectedSession(session.id) }, h('span', { className: 'syr-row syr-between' }, h('strong', null, session.role), h(Status, { value: session.status })), h('span', { className: 'syr-id' }, session.id), session.model && h('span', { className: 'syr-small syr-muted' }, session.model)))),
                selected ? h('section', { className: 'syr-box', 'aria-label': t('sessionDetails'), 'data-testid': 'session-detail' }, h('div', { className: 'syr-section-title' }, h('h2', null, t('sessionDetails')), h(Button, { icon: 'close', className: 'syr-btn syr-subtle', 'aria-label': t('close'), onClick: () => setSelectedSession(null) })), h(Facts, { rows: sessionRows(selected) }), ['not_attached', 'unknown'].includes(hostState(selected)) && h('p', { className: 'syr-small syr-muted syr-section-gap' }, t(hostState(selected) === 'not_attached' ? 'hostDetached' : 'hostUnknown')), h('hr', { className: 'syr-divider' }), h(Title, null, t('usage')), h(Facts, { rows: usageRows(selected.usage) }), h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('usageHint'))) : h(Empty, null, t('sessionSelect')))
                : h(Empty, null, t('noSessions')));
          }
          function taskContent() {
            const checks = arr(task?.completionSpec?.checks), verification = task?.verification;
            const stopPending = task?.stopRequested === true && task?.state !== 'cancelled';
            return h('section', null,
              h('div', { className: 'syr-system-heading' }, h(Title, { count: tasksConnected ? tasks.length : undefined }, t('tasks')), h('p', null, t('tasksHint'))),
              !tasksConnected ? h(Empty, null, t('tasksUnavailable')) : !tasks.length ? h(React.Fragment, null, h(Empty, null, t('noTasks')), selectedTask && h('p', { className: 'syr-small syr-muted' }, t('taskNotInSnapshot'))) : h('div', { className: 'syr-task-layout' },
                h('div', { className: 'syr-session-list', 'data-testid': 'task-list' }, ...tasks.map(item => h('button', { type: 'button', key: item.taskId, className: 'syr-session-button', 'aria-label': t('viewTask', { id: item.taskId }), 'aria-pressed': selectedTask === item.taskId, onClick: () => setSelectedTask(item.taskId) },
                  h('span', { className: 'syr-row syr-between syr-task-list-row' }, h('span', { className: 'syr-task-label' }, text(item.title)), h(Status, { value: item.state })),
                  item.waitReason && h('span', { className: 'syr-task-caption' }, waitReason(item.waitReason)),
                  item.state === 'unknown' && h('span', { className: 'syr-task-caption' }, t('unknownResult')),
                  item.stopRequested === true && h('span', { className: 'syr-task-caption' }, t('stopRequestedYes')),
                  h('span', { className: 'syr-task-caption' }, `${t('attempt')} · ${numeric(item.attempt)}`), h('span', { className: 'syr-task-caption' }, `${t('taskUpdated')} · ${dateTime(item.updatedAt, locale)}`)))),
                task ? h('section', { className: 'syr-box syr-task-detail', 'aria-label': t('taskDetails'), 'data-testid': 'task-detail' },
                  h('div', { className: 'syr-section-title' }, h('div', null, h('h2', { className: 'syr-break' }, text(task.title)), h(Status, { value: task.state })), h(Button, { icon: 'close', className: 'syr-btn syr-subtle', 'aria-label': t('close'), onClick: () => setSelectedTask(null) })),
                  h(Facts, { rows: [['taskId', task.taskId, true], ['taskState', label(task.state)], ...(task.waitReason ? [['waitReason', waitReason(task.waitReason)]] : []), ['activeAssignment', task.activeAssignmentId || t('noActiveAssignment'), true], ['attempt', numeric(task.attempt)], ['taskUpdated', dateTime(task.updatedAt, locale)], ['stopRequested', t(task.stopRequested === true ? 'stopRequestedYes' : task.stopRequested === false ? 'stopRequestedNo' : 'unknownValue')]] }),
                  stopPending && h('p', { className: 'syr-alert', 'data-testid': 'task-stop-pending' }, t('stopPending')),
                  (task.state === 'unknown' || task.uncertainty) && h('section', { className: 'syr-alert', 'data-testid': 'task-uncertainty', 'aria-label': t('uncertainty') }, h('strong', null, task.state === 'unknown' ? t('unknownResult') : t('uncertainty')),
                    task.uncertainty ? h(React.Fragment, null, h(Facts, { rows: [['uncertaintyReason', text(task.uncertainty.reason)], ['uncertaintyAt', dateTime(task.uncertainty.at, locale)]] }), h('p', { className: 'syr-small syr-muted' }, t('evidenceRefs')), h(Evidence, { values: task.uncertainty.evidenceRefs })) : h('p', null, t('noUncertainty'))),
                  h('section', { className: 'syr-task-result', 'aria-label': t('completionSpec'), 'data-testid': 'task-completion' }, h(Title, null, t('completionSpec')), h('p', { className: 'syr-small syr-muted' }, `${t('completionSpecVersion')} · ${numeric(task.completionSpec?.version)}`),
                    checks.length ? checks.map(check => h('div', { className: 'syr-task-check', key: check.checkId }, h('h3', { className: 'syr-code' }, text(check.checkId)), h(Facts, { rows: [['checkType', text(check.type)], ['targetRef', text(check.targetRef), true], ...(Object.hasOwn(check, 'expected') ? [['expected', expectedValue(check.expected), true]] : []), ['evidenceRequired', t(check.evidenceRequired === true ? 'yes' : check.evidenceRequired === false ? 'no' : 'unknownValue')]] }))) : h(Empty, null, t('noCompletionChecks'))),
                  h('section', { className: 'syr-task-result', 'aria-label': t('verification'), 'data-testid': 'task-verification' }, h(Title, null, t('verification')),
                    verification ? h(React.Fragment, null,
                      h(Facts, { rows: [['verificationAssignment', verification.assignmentId, true], ['completionSpecVersion', numeric(verification.completionSpecVersion)], ['verifierVersion', verification.verifierVersion, true], ['verifiedAt', dateTime(verification.verifiedAt, locale)], ['resultHash', verification.resultHash, true]] }),
                      arr(verification.checks).length ? verification.checks.map(check => h('div', { className: 'syr-task-check', key: check.checkId }, h('div', { className: 'syr-row syr-between' }, h('h3', { className: 'syr-code' }, text(check.checkId)), h(Status, { value: check.status })), h('p', { className: 'syr-small syr-muted' }, t('evidenceRefs')), h(Evidence, { values: check.evidenceRefs }))) : h(Empty, null, t('noVerificationChecks')))
                      : h(Empty, null, t('noVerification')))) : h(Empty, null, t(selectedTask ? 'taskNotInSnapshot' : 'taskSelect'))));
          }
          function conversationContent() {
            const canLink = canStartCommand && ['idle', 'busy', 'waiting'].includes(state) && conversationsConnected && Boolean(localTask);
            return h('div', { className: 'syr-stack' },
              h('section', null, h('div', { className: 'syr-system-heading' }, h(Title, { count: conversationsConnected && !foreignConversations ? conversations.length : undefined }, t('conversations')), h('p', null, t('conversationsHint'))),
                h('div', { className: 'syr-box syr-diagnostic-head', 'data-testid': 'conversation-link' },
                  h('div', { className: 'syr-link-controls' }, h('h2', null, t('conversationLinkTitle')), h('p', { className: 'syr-small syr-muted' }, t('conversationLinkHint')),
                    localTasks.length > 0 && h('label', { className: 'syr-select-label' }, h('span', null, t('conversationLinkTask')),
                      h('select', { className: 'syr-select', 'aria-label': t('conversationLinkTask'), 'data-testid': 'conversation-task-select', value: localTask?.taskId || '', disabled: Boolean(command || controlCommand), onChange: event => setLinkTaskId(event.target.value) },
                        !localTask && h('option', { value: '', disabled: true }, t('conversationLinkTaskMissing')),
                        ...localTasks.map(item => h('option', { key: item.taskId, value: item.taskId }, `${text(item.title)} (${item.taskId}) · ${label(item.state)}`)))),
                    localTask ? h('p', { className: 'syr-small syr-break' }, `${t('conversationLinkTask')} · ${text(localTask.title)} (${localTask.taskId}) · ${label(localTask.state)}`) : h('p', { className: 'syr-small syr-muted' }, t(linkTaskId === null ? 'conversationLinkNeedsTask' : 'conversationLinkTaskMissing'))),
                  h(Button, { disabled: !canLink, onClick: () => { if (canLink) void operations.current.command('conversation.linkLocalTask', { taskId: localTask.taskId }); } }, t(command === 'conversation.linkLocalTask' ? 'conversationLinking' : 'conversationLink')))),
              h('section', { 'data-testid': 'conversation-records' },
                foreignConversations && h('p', { className: 'syr-alert', role: 'alert' }, t('conversationScopeUnknown')),
                !conversationsConnected ? h(Empty, null, t('conversationsUnavailable')) : !conversations.length ? h(React.Fragment, null, h(Empty, null, t('noConversations')), selectedConversation && h('p', { className: 'syr-small syr-muted' }, t('conversationNotInSnapshot'))) : h('div', { className: 'syr-task-layout' },
                  h('div', { className: 'syr-session-list', 'data-testid': 'conversation-list' }, ...conversations.map(item => h('button', { type: 'button', key: item.bindingId, className: 'syr-session-button', 'aria-label': t('viewConversation', { id: item.bindingId }), 'aria-pressed': conversation?.bindingId === item.bindingId,
                    onClick: () => setSelectedConversation({ conversationId: item.conversationId, bindingId: item.bindingId }) },
                    h('span', { className: 'syr-task-label' }, text(item.localConversationKey) || text(item.conversationId)),
                    h('span', { className: 'syr-task-caption' }, contextLabel(item)),
                    h('span', { className: 'syr-task-caption' }, `${t('contextVersion')} · ${numeric(item.contextVersion)}`), h('span', { className: 'syr-id' }, item.bindingId)))),
                  conversation ? h('section', { className: 'syr-box syr-task-detail', 'aria-label': t('conversationDetails'), 'data-testid': 'conversation-detail' },
                    h('div', { className: 'syr-section-title' }, h('h2', null, t('conversationDetails')), h(Button, { icon: 'close', className: 'syr-btn syr-subtle', 'aria-label': t('close'), onClick: () => setSelectedConversation(null) })),
                    h('p', { className: 'syr-notice syr-small', 'data-level': conversation.needsSync === true ? 'warning' : 'info', 'data-testid': 'conversation-load-state' }, contextLabel(conversation)),
                    h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('conversationReadOnly')),
                    h('div', { className: 'syr-section-gap' }, h(Facts, { rows: [
                      ['conversationId', conversation.conversationId, true], ['topicId', conversation.topicId, true], ['replyBindingId', conversation.bindingId, true], ['localConversationKey', conversation.localConversationKey, true], ['conversationScope', conversation.scope, true],
                      ['contextVersion', numeric(conversation.contextVersion)], ['audienceVersion', numeric(conversation.audienceVersion)], ['conversationGeneration', numeric(conversation.conversationGeneration)], ['routingRevision', numeric(conversation.routingRevision)], ['sessionEpoch', numeric(conversation.sessionEpoch)],
                    ] })),
                    h('section', { className: 'syr-task-result', 'aria-label': t('linkedTasks') }, h(Title, null, t('linkedTasks')),
                      !Array.isArray(conversation.taskRefs) ? h(Empty, null, t('linkedTasksUnknown')) : !conversation.taskRefs.length ? h(Empty, null, t('noLinkedTasks')) : conversation.taskRefs.map(ref => h('div', { key: ref.taskId, className: 'syr-task-check' },
                        h('h3', { className: 'syr-code' }, text(ref.taskId)), h(Facts, { rows: [['taskState', label(ref.state)], ['recordVersion', numeric(ref.version)]] })))),
                    h('section', { className: 'syr-task-result', 'aria-label': t('contextSources'), 'data-testid': 'conversation-sources' }, h(Title, null, t('contextSources')),
                      !Array.isArray(conversation.sources) ? h(Empty, null, t('sourcesUnknown')) : !conversation.sources.length ? h(Empty, null, t('noContextSources')) : conversation.sources.map((source, index) => h('div', { key: index, className: 'syr-task-check' },
                        h(Facts, { rows: [['sourceReference', sourceRef(source.reference), true], ['sourceVersion', numeric(source.sourceVersion)]] })))),
                    h('section', { className: 'syr-task-result', 'aria-label': t('pendingSources'), 'data-testid': 'conversation-pending' }, h(Title, { count: Array.isArray(conversation.pending) ? conversation.pending.length : undefined }, t('pendingSources')),
                      !Array.isArray(conversation.pending) ? h(Empty, null, t('pendingSourcesUnknown')) : !conversation.pending.length ? h(Empty, null, t('noPendingSources')) : conversation.pending.map((source, index) => h('div', { key: index, className: 'syr-task-check' },
                        h(Facts, { rows: [['sourceReference', sourceRef(source.reference), true], ['sourceVersion', numeric(source.sourceVersion)], ['contextVersion', numeric(source.contextVersion)], ['backgroundEventId', text(source.eventId), true], ['sourceGap', t(source.gap === true ? 'gapPresent' : source.gap === false ? 'gapAbsent' : 'unknownValue')]] }),
                        h('p', { className: 'syr-small syr-muted' }, t('evidenceRefs')), h(Evidence, { values: typeof source.evidenceRef === 'string' ? [source.evidenceRef] : [] }))))) : h(Empty, null, t(selectedConversation ? 'conversationNotInSnapshot' : 'conversationSelect')))),
              h('section', { className: 'syr-box', 'aria-label': t('backgroundDelivery'), 'data-testid': 'conversation-background' }, h(Title, null, t('backgroundDelivery')), h('p', { className: 'syr-small syr-muted' }, t('backgroundDeliveryHint')),
                !background ? h(Empty, null, t('backgroundUnavailable')) : h('div', { className: 'syr-section-gap' },
                  h(Facts, { rows: [['backgroundState', label(['idle', 'running', 'degraded', 'stopped'].includes(background.state) ? background.state : 'unknown')], ['backgroundLastScan', dateTime(background.lastScanAt, locale)],
                    ['subscriptions', numeric(background.subscriptions)], ['backgroundPending', numeric(background.pending)], ['backgroundClaimed', numeric(background.claimed)], ['backgroundAcknowledged', numeric(background.acknowledged)], ['failed', numeric(background.failed)], ['backgroundCancelled', numeric(background.cancelled)]] }),
                  typeof background.lastFailure === 'string' && background.lastFailure && h('p', { className: 'syr-alert syr-section-gap', 'data-testid': 'conversation-background-failure' }, h('strong', null, t('backgroundLastFailure')), background.lastFailure),
                  background.lastBatch && h('section', { className: 'syr-task-result' }, h(Title, null, t('backgroundBatch')), h(Facts, { rows: [['backgroundClaimed', numeric(background.lastBatch.claimed)], ['backgroundProcessed', numeric(background.lastBatch.processed)], ['failed', numeric(background.lastBatch.failed)]] })))));
          }
          function diagnostics() {
            return h('div', { className: 'syr-stack' },
              h('section', { className: 'syr-box syr-diagnostic-head' }, h('div', null, h('h2', null, t('diagnostics')), h('p', { className: 'syr-small syr-muted' }, t('probeHint'))), h(Button, { disabled: !canStartCommand, onClick: () => void operations.current.command('session.probe') }, t(command === 'session.probe' ? 'probing' : 'probe'))),
              h('section', { className: 'syr-box syr-diagnostic-head', 'data-testid': 'model-verification' }, h('div', null, h('h2', null, t('modelVerifyTitle')), h('p', { className: 'syr-small syr-muted' }, t('modelVerifyHint')), h('p', { className: 'syr-small syr-muted syr-break' }, t('modelVerifyLimits'))), h(Button, { disabled: !canStartCommand, onClick: () => void operations.current.command('session.verify-model') }, t(command === 'session.verify-model' ? 'modelVerifying' : 'modelVerify'))),
              h('section', { className: 'syr-box syr-diagnostic-head', 'data-testid': 'local-task-validation' }, h('div', null, h('h2', null, t('localTaskTitle')), h('p', { className: 'syr-small syr-muted' }, t('localTaskHint')), h('p', { className: 'syr-small syr-muted' }, t('localTaskLimits'))), h(Button, { disabled: !canCreateLocalTask, onClick: () => void operations.current.command('task.createLocal', { requestId: `local-validation-${snapshot.instanceId}`, title: '本地任务链路验证', content: '识雨本地任务验证：受限 worker 写入专属产物，独立核验内容与回执。' }) }, t(command === 'task.createLocal' ? 'localTaskStarting' : 'localTaskRun'))),
              h('section', { className: 'syr-box', 'data-testid': 'goal-verification' },
                h('div', { className: 'syr-diagnostic-head' }, h('div', null, h('h2', null, t('goalVerifyTitle')), h('p', { className: 'syr-small syr-muted' }, t('goalVerifyHint'))),
                  h(Button, { disabled: !canStartCommand || !goalTask, onClick: () => { if (goalTask) void operations.current.command('goal.verify-lifecycle', { taskId: goalTask.taskId }); } }, t(command === 'goal.verify-lifecycle' ? 'goalVerifying' : 'goalVerify'))),
                h('p', { className: 'syr-small syr-muted syr-break syr-section-gap' }, goalTask ? `${t('goalVerifyTask')} · ${text(goalTask.title)} (${goalTask.taskId})` : t('goalVerifyNeedsTask')),
                goalReceipt && h('section', { className: 'syr-task-result', 'aria-label': t('goalVerifyReceipt'), 'data-testid': 'goal-verification-receipt' }, h(Title, null, t('goalVerifyReceipt')),
                  h(Facts, { rows: [['taskId', goalReceipt.taskId, true], ['goalId', goalReceipt.goalId, true], ['nativeGoalId', goalReceipt.nativeGoalId, true], ['sessionId', goalReceipt.sessionId, true], ['nativePhase', goalReceipt.nativePhase, true], ['goalOperations', goalReceipt.operations.join(' → '), true], ['inferenceRequested', t('noInferenceRequested')]] }))),
              h('div', { className: 'syr-columns' },
                h('section', { className: 'syr-box' }, h(Title, null, t('dependencies')), dependencies.length ? dependencies.map(item => h('div', { key: item.id, className: 'syr-dependency' }, h('div', { className: 'syr-row syr-between' }, h('h3', null, item.name), h(Status, { value: item.status })), h('p', null, item.summary), item.checkedAt && h('p', null, `${t('checked')} · ${dateTime(item.checkedAt, locale)}`))) : h(Empty, null, t('noDependencies'))),
                h('section', { className: 'syr-box' }, h(Title, null, t('usage')), h(Facts, { rows: [['calls', numeric(snapshot.usage?.calls)], ...usageRows(snapshot.usage)] }), h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('usageHint')))),
              h('section', null, h(Title, null, t('subscriptions')), arr(snapshot.events?.subscriptions).length ? h('div', null, ...snapshot.events.subscriptions.map(item => h('div', { key: item.id, className: 'syr-entry' }, h('div', { className: 'syr-row syr-between' }, h('span', { className: 'syr-code' }, item.type), h(Status, { value: item.status })), h('p', { className: 'syr-muted' }, `${t('target')} · ${text(item.target)}`)))) : h(Empty, null, t('noSubscriptions'))),
              h('section', null, h(Title, null, t('recentEvents')), eventMetrics(), arr(snapshot.events?.recent).length ? h('ol', { className: 'syr-timeline' }, ...snapshot.events.recent.map(item => h('li', { key: item.id }, h('time', { dateTime: item.at }, dateTime(item.at, locale)), h('span', { className: 'syr-code' }, item.type), h(Status, { value: item.status })))) : h(Empty, null, t('noEvents'))),
              h('section', { className: 'syr-box' }, h(Facts, { rows: [['instance', snapshot.instanceId, true], ['version', snapshot.version], ['lifecycle', label(snapshot.lifecycle)], ['started', dateTime(snapshot.startedAt, locale)], ['observed', dateTime(snapshot.observedAt, locale)]] })));
          }
          return h('div', { className: 'syr', ref: rootRef }, h('style', null, css), h('div', { className: 'syr-wrap' },
            h('header', { className: 'syr-header' }, h('div', { className: 'syr-brand' }, h(Icon, { size: 27 }), h('div', null, h('h1', null, t('title')), h('div', { className: 'syr-meta' }, snapshot && h('span', null, `v${snapshot.version}`), h('span', null, t('source'))))),
              h('div', { className: 'syr-actions' }, snapshot && h(Button, { icon: state === 'paused' ? 'play' : 'pause', disabled: !canControl, onClick: () => void operations.current.command(state === 'paused' ? 'runtime.resume' : 'runtime.pause') }, t(state === 'paused' ? 'resume' : 'pause')), h(Button, { icon: 'refresh', disabled: loading, onClick: () => void operations.current.refresh(), 'aria-label': t('refresh'), 'aria-busy': loading }, t(loading ? 'refreshing' : 'refresh')))),
            h('nav', { className: 'syr-tabs', 'aria-label': t('title') }, ...['overview', 'tasks', 'conversations', 'systems', 'sessions', 'diagnostics'].map(id => h('button', { type: 'button', className: 'syr-tab', key: id, 'aria-current': tab === id ? 'page' : undefined, onClick: () => setTab(id) }, t(id)))),
            stale && h('div', { className: 'syr-alert', role: 'alert', 'data-testid': 'snapshot-stale' }, h('strong', null, t(snapshot ? 'staleTitle' : 'loadFailed')), h('p', null, readError || t('snapshotOld')), snapshot && h('p', null, t('staleHint'))),
            commandError && h('div', { className: 'syr-alert', role: 'alert' }, h('strong', null, t('commandFailed')), commandError),
            controlError && h('div', { className: 'syr-alert', role: 'alert' }, h('strong', null, t('commandFailed')), controlError),
            commandNotice && h('p', { className: 'syr-feedback', role: 'status' }, commandNotice),
            controlNotice && h('p', { className: 'syr-feedback', role: 'status' }, controlNotice),
            command && h('p', { className: 'syr-feedback', role: 'status' }, t(command === 'session.verify-model' ? 'modelVerifyPending' : 'controlPending')),
            controlCommand && h('p', { className: 'syr-feedback', role: 'status' }, t('controlPending')),
            snapshot ? (tab === 'overview' ? overview() : tab === 'tasks' ? taskContent() : tab === 'conversations' ? conversationContent() : tab === 'systems' ? systemContent() : tab === 'sessions' ? sessionContent() : diagnostics()) : !readError && h('p', { className: 'syr-loading', role: 'status' }, t('loading')),
            h('footer', { className: 'syr-footer' }, h('span', null, lastRead ? `${t('lastRead')} · ${dateTime(lastRead, locale)}` : t('unknownHint')), h('span', null, t('autoRefresh')))));
        }
        ctx.effect(() => {
          const cleanup = [
            ctx.locale.register(NS, 'zh', zh), ctx.locale.register(NS, 'zh-CN', zh), ctx.locale.register(NS, 'en', en),
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'shiyu-runtime', locale: NS }, RuntimePanel)),
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'shiyu-runtime', order: -15, label: () => t('nav'), locale: NS }, Icon)),
          ];
          return () => { disposed = true; for (const stop of [...panelDisposers]) stop(); for (const stop of cleanup.reverse()) if (typeof stop === 'function') stop(); };
        });
      },
    };
  },
});
