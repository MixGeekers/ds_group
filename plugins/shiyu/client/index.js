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
      status_ready: '就绪', status_opening: '正在启动', status_closing: '正在关闭', status_stopping: '正在停止', status_degraded: '受限运行', status_implemented: '已实现', status_partial: '部分实现',
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
      contextVerifyTitle: '背景加载与会话复用', contextVerify: '验证背景加载与会话复用', contextVerifying: '正在验证背景加载与会话复用…',
      contextVerifyHint: '显式执行 2 轮本地合成模型生成，验证背景加载并复用同一 Session。', contextVerifyLimits: '使用 opencode-go/deepseek-v4.1-flash（low），每轮最多 512 输出 tokens；只读，不发送消息，不自动重试。',
      contextVerifyNeedsTask: '当前对话需有至少一项已关联任务。', contextVerifyPending: '正在等待对话（{id}）的背景加载检查回执；可通过“暂停运行”取消。',
      contextVerifyUnconfirmed: '检查回执未完整确认本次对话、绑定、同一 Session、2 次请求、背景持久化、每轮草稿放行核验及未发送；结果未确认。',
      contextVerifyTimeout: '等待背景加载检查超时，结果未确认。请刷新核对；不会自动重试。', contextVerifyReturned: '对话（{id}）的检查回执已收到，可在对应对话详情查看。',
      contextVerifyReceipt: '本次背景检查回执', contextVerifyDone: '该次检查通过：2 轮生成复用同一 Session；背景确认已持久化，每轮草稿在放行时通过核验，未发送消息。',
      contextVerifySnapshotOnly: '待加载状态仍以服务快照为准；本次回执不会清空页面中的背景记录。',
      contextDurable: '背景确认持久化', draftsValidated: '每轮草稿放行核验', sameSession: 'Session 复用', confirmed: '已确认', outboundMessage: '对外消息', notSent: '未发送',
      contextVerifyHistory: '已保存的背景检查记录', contextVerifyHistoryHint: '这是该次检查的持久记录，不能确认当前背景状态，也不代表本次操作通过。', diagnosticMessage: '记录说明',
      contextSafetyUnavailable: '原生背景加载尚不可用，请查看诊断中的依赖状态。', contextSafetyMissing: '原生背景加载就绪检查尚未接入。',
      contextAttemptedRounds: '尝试轮数', contextAttemptedRoundsHint: '读取视图或模型派发前失败，也可能计入尝试轮数。实际模型调用以 Session 观察记录为准；此计数不代表完整计费用量。',
      memory: '记忆', memoryHint: '显式保存本地记忆片段，按记录读取已保存内容。',
      memoryUnconfigured: '本地记忆尚未配置', memoryReady: '精确记忆存取可用', memoryWaiting: '记忆服务尚未就绪', memoryUnavailable: '记忆服务不可用', memoryWaitingHint: '服务可能尚未启动；以当前依赖状态为准。',
      memorySemanticDisabled: '语义检索尚未启用', memoryBackend: '记忆后端', backendId: '后端 ID', deploymentId: '部署 ID', memoryScope: '记忆范围', memoryEmbedding: '语义检索', errorCode: '错误代码',
      memorySaveTitle: '保存片段', memorySave: '保存片段', memorySaving: '正在保存片段…', memoryConversation: '关联对话', memoryChooseConversation: '请选择已有本地对话', memorySnippet: '记忆片段',
      memorySaveHint: '明确点击后保存；同一未修改片段保持请求 ID，刷新不会重新提交，结果未知时不会自动重试。', memoryNoConversation: '请先关联一个本地对话。', memoryBodyLimit: '片段最多 16,384 UTF-8 字节。',
      memorySaved: '保存请求已有回执；记录状态以最新快照为准。', memoryDuplicate: '该请求已存在，未作为新保存请求提交；请核对快照中的状态。', memoryUnconfirmed: '记忆操作回执不完整，结果未确认；不会自动重试。',
      memoryEntries: '记忆记录', memoryEntriesUnknown: '尚未提供记忆记录', memoryEmpty: '暂无记忆记录', memoryDetails: '记忆详情', memorySelect: '选择记录查看元信息', memoryView: '查看记忆 {id}',
      memoryOperationId: '操作 ID', memoryRequestId: '保存请求 ID', memoryNativeId: '后端记录 ID', memoryBytes: '正文字节数', memoryConsent: '读取许可', memoryConsentActive: '有效', memoryConsentWithdrawn: '已撤回', memoryBlocked: '是否受阻', memoryNotBlocked: '未受阻', memoryCreated: '创建时间',
      memoryRead: '读取正文', memoryReading: '正在读取正文…', memoryBodyTitle: '本次读取的正文', memoryBodyHint: '正文仅在本页临时显示；切换记录、许可失效或撤回后清除。', memoryReadChanged: '读取期间所选记录或读取许可已变化，正文未显示。请重新核对。',
      memoryWithdraw: '撤回读取许可', memoryWithdrawing: '正在撤回读取许可…', memoryWithdrawHint: '撤回后停止读取此片段；这不表示后端正文已被物理删除。暂停时仍可撤回。', memoryWithdrawn: '读取许可已撤回，临时正文已清除；不代表物理删除。', memoryWithdrawUnconfirmed: '撤回结果未确认，临时正文已清除；请刷新核对，不会自动重试。',
      memoryBusy: '记忆请求正在处理，请等待回执；不会自动重试。', memoryNotInSnapshot: '当前快照尚未包含选中的记忆记录。', status_applied: '已应用', status_dispatching: '派发中', status_prepared: '已准备', status_proposed: '已提出',
      commandFailed: '操作未完成', commandUncertain: '操作结果未确认，请先刷新状态再决定下一步。', requestFailed: '请求失败',
      controlPending: '正在处理请求…', close: '关闭详情', phase: '阶段', checked: '最近检查', source: '来自运行快照',
    };
    const en = {
      nav: 'Shiyu Runtime', title: 'Shiyu · Runtime', overview: 'Overview', systems: 'Systems', sessions: 'Sessions', diagnostics: 'Diagnostics',
      refresh: 'Refresh', refreshing: 'Refreshing', loading: 'Reading runtime state…', retry: 'Retry', pause: 'Pause runtime', resume: 'Resume runtime',
      runtimeState: 'Current state', currentWork: 'Current work', attention: 'Needs attention', activities: 'Recent activity', noWork: 'No work is currently running',
      noAttention: 'Nothing needs attention', noActivities: 'No activity recorded yet', noSessions: 'No sessions recorded yet', noSystems: 'No implementation status received yet',
      status_idle: 'Idle', status_busy: 'Busy', status_waiting: 'Waiting', status_paused: 'Paused', status_unknown: 'Unknown',
      status_ready: 'Ready', status_opening: 'Opening', status_closing: 'Closing', status_stopping: 'Stopping', status_degraded: 'Degraded', status_implemented: 'Implemented', status_partial: 'Partial',
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
      contextVerifyTitle: 'Context loading and Session reuse', contextVerify: 'Verify context loading and Session reuse', contextVerifying: 'Verifying context loading and Session reuse…',
      contextVerifyHint: 'Explicitly runs 2 local synthetic model turns to check context loading and reuse of the same Session.', contextVerifyLimits: 'Uses opencode-go/deepseek-v4.1-flash (low), with at most 512 output tokens per turn. Read-only, no outbound message, and no automatic retry.',
      contextVerifyNeedsTask: 'This conversation needs at least one linked task.', contextVerifyPending: 'Waiting for the context check receipt for Conversation ({id}). Use “Pause runtime” to cancel.',
      contextVerifyUnconfirmed: 'The receipt does not fully confirm this Conversation, binding, same Session, 2 requests, durable context acknowledgement, draft validation at each release, and no send. The result is unconfirmed.',
      contextVerifyTimeout: 'The context check timed out with no confirmed result. Refresh to inspect it; no automatic retry will occur.', contextVerifyReturned: 'A check receipt was received for Conversation ({id}). View it in that conversation’s details.',
      contextVerifyReceipt: 'Context check receipt from this operation', contextVerifyDone: 'This check passed: 2 turns reused one Session, context acknowledgement was persisted, each draft passed validation at release, and no message was sent.',
      contextVerifySnapshotOnly: 'Pending context still follows the service snapshot. This receipt does not clear background records in the page.',
      contextDurable: 'Context acknowledgement persisted', draftsValidated: 'Draft validation at each release', sameSession: 'Same Session reused', confirmed: 'Confirmed', outboundMessage: 'Outbound message', notSent: 'Not sent',
      contextVerifyHistory: 'Saved context check record', contextVerifyHistoryHint: 'This persisted record describes that check. It does not confirm the current context state or a pass for this operation.', diagnosticMessage: 'Record message',
      contextSafetyUnavailable: 'Native context loading is unavailable. See dependency status in Diagnostics.', contextSafetyMissing: 'The native context readiness check is not connected yet.',
      contextAttemptedRounds: 'Attempted turns', contextAttemptedRoundsHint: 'Failures while reading a view or before model dispatch may still count as attempted turns. Use Session observations for actual model calls; this is not a complete billing measure.',
      memory: 'Memory', memoryHint: 'Explicitly save local memory snippets and read saved content by record.',
      memoryUnconfigured: 'Local memory is not configured', memoryReady: 'Exact memory storage is available', memoryWaiting: 'Memory service is not ready', memoryUnavailable: 'Memory service is unavailable', memoryWaitingHint: 'The service may not have started. Check the current dependency state.',
      memorySemanticDisabled: 'Semantic search is not enabled', memoryBackend: 'Memory backend', backendId: 'Backend ID', deploymentId: 'Deployment ID', memoryScope: 'Memory scope', memoryEmbedding: 'Semantic search', errorCode: 'Error code',
      memorySaveTitle: 'Save snippet', memorySave: 'Save snippet', memorySaving: 'Saving snippet…', memoryConversation: 'Linked conversation', memoryChooseConversation: 'Choose an existing local conversation', memorySnippet: 'Memory snippet',
      memorySaveHint: 'Saves only after an explicit click. An unchanged snippet keeps its request ID. Refreshing never resubmits, and uncertain results are not retried automatically.', memoryNoConversation: 'Link a local conversation first.', memoryBodyLimit: 'At most 16,384 UTF-8 bytes per snippet.',
      memorySaved: 'A save receipt was received. Use the latest snapshot to check the record state.', memoryDuplicate: 'This request already exists and was not submitted as a new save. Check its state in the snapshot.', memoryUnconfirmed: 'The memory receipt is incomplete. The result is unconfirmed; no automatic retry will occur.',
      memoryEntries: 'Memory records', memoryEntriesUnknown: 'Memory records are not reported', memoryEmpty: 'No memory records', memoryDetails: 'Memory details', memorySelect: 'Select a record to inspect its metadata', memoryView: 'View memory {id}',
      memoryOperationId: 'Operation ID', memoryRequestId: 'Save request ID', memoryNativeId: 'Backend record ID', memoryBytes: 'Body bytes', memoryConsent: 'Read consent', memoryConsentActive: 'Active', memoryConsentWithdrawn: 'Withdrawn', memoryBlocked: 'Blocked', memoryNotBlocked: 'Not blocked', memoryCreated: 'Created',
      memoryRead: 'Read body', memoryReading: 'Reading body…', memoryBodyTitle: 'Body from this read', memoryBodyHint: 'The body is shown only temporarily in this page. Selecting another record, losing access, or withdrawing consent clears it.', memoryReadChanged: 'The selection or read permission changed during this read. The body was not displayed. Inspect the current record again.',
      memoryWithdraw: 'Withdraw read consent', memoryWithdrawing: 'Withdrawing read consent…', memoryWithdrawHint: 'Withdrawal stops reads of this snippet. It does not mean the backend body was physically deleted. Withdrawal remains available while paused.', memoryWithdrawn: 'Read consent was withdrawn and the temporary body was cleared. This does not confirm physical deletion.', memoryWithdrawUnconfirmed: 'Withdrawal is unconfirmed and the temporary body was cleared. Refresh to inspect it; no automatic retry will occur.',
      memoryBusy: 'A memory request is running. Waiting for its receipt; no automatic retry will occur.', memoryNotInSnapshot: 'The selected memory record is not in the current snapshot.', status_applied: 'Applied', status_dispatching: 'Dispatching', status_prepared: 'Prepared', status_proposed: 'Proposed',
      commandFailed: 'Operation did not complete', commandUncertain: 'The result is unconfirmed. Refresh the state before deciding what to do next.', requestFailed: 'Request failed',
      controlPending: 'Processing request…', close: 'Close details', phase: 'Phase', checked: 'Last checked', source: 'From the runtime snapshot',
    };
    const arr = value => Array.isArray(value) ? value : [];
    const text = value => value == null ? '' : String(value);
    Object.assign(zh, {
      "memorySemanticReady": "语义检索已验证",
      "memorySemanticUnverified": "已配置，向量调用尚未验证",
      "memorySemanticUnavailable": "语义检索暂不可用",
      "memoryIndex": "建立语义索引",
      "memoryIndexing": "正在建立索引…",
      "memoryIndexHint": "保存与建索引分开操作；建索引会显式调用本地 embedding，刷新不会触发。",
      "memoryIndexReceipt": "本次索引回执",
      "memoryIndexPublishable": "索引核验",
      "memoryIndexUsageHint": "调用数属于该索引操作的累计记录；重复请求不代表新增调用。",
      "memoryIndexed": "索引已有独立核验回执。",
      "memoryIndexDuplicate": "索引请求已存在，未自动重新执行；显示该操作累计记录。",
      "memoryIndexUnconfirmed": "索引结果尚未确认，请核对状态；不会自动重试。",
      "memorySearchTitle": "语义搜索",
      "memorySearch": "搜索记忆",
      "memorySearching": "正在搜索…",
      "memoryQuery": "搜索内容",
      "memorySearchHint": "只搜索上方关联对话内获准的记忆，返回记录引用；不会自动读取正文或保存查询。",
      "memorySearchNeedsIndex": "需先建立索引；覆盖不完整，不能判断是否命中。",
      "memorySearchNoMatch": "已核对索引覆盖，本次没有匹配记录。",
      "memorySearchMatches": "本次匹配记录；点击只选择记录，正文需另行读取。",
      "memoryEligibleCount": "获准记录",
      "memoryIndexedCount": "已有索引",
      "memoryMissingCount": "缺少索引",
      "memorySimilarity": "相似度",
      "embeddingCalls": "Embedding 调用数",
      "embeddingUsageCompleteness": "用量完整性",
      "usageComplete": "已完整观察",
      "usageIncomplete": "尚不完整",
      "memoryLastSemantic": "最近语义操作（索引为累计用量）",
      "memorySemanticOutcome": "已记录结果",
      "memorySemanticError": "语义检索错误",
      "status_existing": "已有操作",
      "semanticUnconfirmed": "语义操作回执不完整，结果未确认；不会自动重试。",
      "semanticResultChanged": "处理期间对话、许可或运行实例变化，结果未显示。",
      "contextLoadTitle": "只读上下文加载诊断",
      "contextLoadInput": "加载诊断输入",
      "contextLoadOnly": "加载只读上下文（不生成）",
      "contextLoadingOnly": "正在加载上下文…",
      "contextLoadHint": "显式读取获准资料并持久加载到原生 Session，不生成草稿、不发送消息。若启用语义检索，会使用本地 embedding。",
      "contextLoaded": "原生上下文已持久核对；未请求生成或 followup，不代表模型回答验收。",
      "contextLoadDuplicate": "该输入已有操作记录，未重新加载或生成。",
      "contextLoadUnconfirmed": "原生加载回执未完整确认本次输入及 Session，结果未确认。",
      "nativeUserMessageSeq": "原生消息序号",
      "status_loaded": "已加载"
    });
    Object.assign(en, {
      "memorySemanticReady": "Semantic retrieval verified",
      "memorySemanticUnverified": "Configured; embedding call not yet verified",
      "memorySemanticUnavailable": "Semantic retrieval unavailable",
      "memoryIndex": "Build semantic index",
      "memoryIndexing": "Building index…",
      "memoryIndexHint": "Saving and indexing are separate actions. Indexing explicitly calls local embeddings; refreshing does not.",
      "memoryIndexReceipt": "Index receipt",
      "memoryIndexPublishable": "Index verification",
      "memoryIndexUsageHint": "Calls are cumulative for this index operation. A repeated request does not imply new calls.",
      "memoryIndexed": "The index has an independently verified receipt.",
      "memoryIndexDuplicate": "This index request already exists; it was not rerun. Showing cumulative operation evidence.",
      "memoryIndexUnconfirmed": "Index outcome is not confirmed. Check its status; no automatic retry.",
      "memorySearchTitle": "Semantic search",
      "memorySearch": "Search memories",
      "memorySearching": "Searching…",
      "memoryQuery": "Search query",
      "memorySearchHint": "Search only permitted memories in the conversation selected above. Results are references; no body is read and no query is saved automatically.",
      "memorySearchNeedsIndex": "Build the missing indexes first. Incomplete coverage cannot establish a match or no match.",
      "memorySearchNoMatch": "Index coverage was checked; no matching records were found.",
      "memorySearchMatches": "Matching references. Selecting one does not read its body.",
      "memoryEligibleCount": "Permitted records",
      "memoryIndexedCount": "Indexed records",
      "memoryMissingCount": "Missing indexes",
      "memorySimilarity": "Similarity",
      "embeddingCalls": "Embedding calls",
      "embeddingUsageCompleteness": "Usage completeness",
      "usageComplete": "Fully observed",
      "usageIncomplete": "Incomplete",
      "memoryLastSemantic": "Latest semantic operation (index usage is cumulative)",
      "memorySemanticOutcome": "Recorded outcome",
      "memorySemanticError": "Semantic retrieval error",
      "status_existing": "Existing operation",
      "semanticUnconfirmed": "The semantic receipt is incomplete; outcome unconfirmed. No automatic retry.",
      "semanticResultChanged": "Conversation, access or runtime identity changed; the result was not displayed.",
      "contextLoadTitle": "Read-only context load diagnostic",
      "contextLoadInput": "Load diagnostic input",
      "contextLoadOnly": "Load context without generation",
      "contextLoadingOnly": "Loading context…",
      "contextLoadHint": "Explicitly read permitted context and persist it in the native Session. No draft or outgoing message. Semantic retrieval, when enabled, uses local embeddings.",
      "contextLoaded": "Native context durability verified. No generation or followup requested; this does not verify a model answer.",
      "contextLoadDuplicate": "This input already has an operation record. It was not loaded or generated again.",
      "contextLoadUnconfirmed": "The native load receipt did not fully confirm this input and Session. Outcome unconfirmed.",
      "nativeUserMessageSeq": "Native message sequence",
      "status_loaded": "Loaded"
    });
    Object.assign(zh, {
      "core": "目标与判断",
      "coreHint": "查看明确授权的本地目标、判断记录与已接纳任务。",
      "coreUnavailable": "目标与判断尚未接入。",
      "coreNotReady": "目标服务尚未就绪。",
      "coreScope": "当前能力：仅按授权正文创建本地便签（local-note）。",
      "coreCreateTitle": "授权一个本地目标",
      "coreCreateHint": "点击后授权识雨在下列范围、总预算和期限内判断并执行。模型只能选择便签 ID，不能修改正文或扩大权限。",
      "coreObjective": "目标说明",
      "coreNoteNumber": "便签 {number}",
      "coreNoteId": "便签 {number} ID",
      "coreNoteTitle": "便签 {number} 标题",
      "coreNoteBody": "便签 {number} 正文",
      "coreNoteDepends": "便签 {number} 依赖",
      "coreDependenciesHint": "正文最多 1,024 UTF-8 字节。依赖填写其他便签 ID，以逗号或空格分隔；不允许循环。",
      "coreAddNote": "添加便签",
      "coreRemoveNote": "移除便签",
      "coreLimit_tokens": "总 Token 上限",
      "coreLimit_calls": "总调用上限",
      "coreLimit_effects": "总效果上限",
      "coreLimit_maxEvaluations": "最多判断次数",
      "coreBudgetHint": "Token 用于预留和对账，实际用量可能超额，核实后停止。原生调用次数与输出长度另有限制。预算不代表实际费用或完成保证；未核清用量继续占用额度，不自动重试。",
      "coreLifetime": "有效期",
      "core30Minutes": "30 分钟",
      "core1Hour": "1 小时",
      "coreInvalidForm": "请填写有效目标和便签，核对 ID、依赖与正整数预算；正文须符合字节上限。",
      "coreExpiredDraft": "此请求的期限已过；修改表单后可创建新授权请求。",
      "coreCreate": "创建并授权本地目标",
      "coreGoals": "已登记目标",
      "coreNoGoals": "暂无已登记目标。",
      "coreView": "查看目标 {id}",
      "coreDetails": "目标详情",
      "coreAuthorization": "目标状态",
      "coreExpiresAt": "授权期限",
      "coreEvaluations": "已开始判断 / 上限",
      "coreActiveEvaluation": "当前判断 ID",
      "coreNextEligible": "下次允许判断",
      "corePause": "暂停目标",
      "coreResume": "恢复目标",
      "coreCancel": "取消目标",
      "coreControlHint": "这里只控制所选目标；暂停或取消不会撤销已发生的效果。恢复须由你明确发起。",
      "coreNative": "原生 Goal 观察",
      "coreNativeHint": "这是原生 Goal 的已观察状态；任务接纳或完成不会由界面推算成 Goal 完成。",
      "coreBudget": "授权预算与账本余额",
      "coreBudgetAxes": "数值依次为：Token / 调用 / 效果。未知不视为零。",
      "coreBudgetLimit": "总上限",
      "coreBudgetSpent": "已结算",
      "coreBudgetHeld": "仍占用",
      "coreBudgetAvailable": "可用额度",
      "coreApprovedNotes": "已授权便签范围",
      "coreDeliverable": "便签 ID",
      "coreDepends": "依赖便签",
      "coreNone": "无",
      "coreAcceptedTasks": "已接纳任务",
      "coreNoAcceptedTasks": "尚无已接纳任务；判断候选不代表执行授权。",
      "coreDecisions": "判断记录",
      "coreNoDecisions": "尚无判断记录。",
      "coreTriggers": "触发来源",
      "coreCandidate": "模型候选",
      "coreCandidateHint": "候选仅供控制域核对；接纳结果另行记录。",
      "coreDecisionReceipt": "判断接纳回执",
      "coreReasonCode": "结果代码",
      "coreObservedTokens": "已观察 Token",
      "coreUnknown": "本次判断结果或用量尚未核清；不会默认重放，也不表示任务已完成。",
      "coreNotInSnapshot": "当前快照尚未包含选中的目标。",
      "coreSelect": "选择一个目标查看详情。",
      "corePump": "判断调度",
      "coreUnconfirmed": "目标操作回执未完整确认；请刷新核对，不会自动重试。",
      "coreChanged": "处理期间目标、版本或运行实例变化，旧回执未采用。",
      "coreAccepted": "目标请求已接收；授权与运行状态以刷新后的账本为准。",
      "coreDuplicate": "该目标请求已有记录，未重新授权；请核对当前状态。",
      "coreControlAccepted": "控制请求已有回执；当前目标状态以刷新后的账本为准。",
      "status_authorized": "已授权",
      "status_unapproved": "待授权",
      "status_expired": "已过期",
      "status_committed": "已提交",
      "status_claimed": "已领取",
      "status_rejected": "已拒绝",
      "status_conflict": "版本冲突",
      "status_complete": "已完成"
    });
    Object.assign(en, {
      "core": "Goals & decisions",
      "coreHint": "Inspect explicitly authorized local goals, decisions and accepted tasks.",
      "coreUnavailable": "Goals and decisions are not connected.",
      "coreNotReady": "Goal service is not ready.",
      "coreScope": "Current capability: create local notes using only the authorized text (local-note).",
      "coreCreateTitle": "Authorize a local goal",
      "coreCreateHint": "This action authorizes decisions and execution within the notes, total budget and expiry below. The model may select note IDs; it cannot change their text or expand access.",
      "coreObjective": "Goal objective",
      "coreNoteNumber": "Note {number}",
      "coreNoteId": "Note {number} ID",
      "coreNoteTitle": "Note {number} title",
      "coreNoteBody": "Note {number} text",
      "coreNoteDepends": "Note {number} dependencies",
      "coreDependenciesHint": "Text is limited to 1,024 UTF-8 bytes. Separate other note IDs with commas or spaces; cycles are not allowed.",
      "coreAddNote": "Add note",
      "coreRemoveNote": "Remove note",
      "coreLimit_tokens": "Total token limit",
      "coreLimit_calls": "Total call limit",
      "coreLimit_effects": "Total effect limit",
      "coreLimit_maxEvaluations": "Maximum evaluations",
      "coreBudgetHint": "Tokens are a reservation and accounting limit. Actual usage may exceed it; confirmed overruns stop further work. Native call and output limits are separate. Budget is not measured cost or a completion guarantee. Unreconciled usage stays held, without automatic retry.",
      "coreLifetime": "Valid for",
      "core30Minutes": "30 minutes",
      "core1Hour": "1 hour",
      "coreInvalidForm": "Complete the objective and notes, and check IDs, dependencies and positive integer budgets. Note text must fit the byte limit.",
      "coreExpiredDraft": "This request has expired. Edit the form to create a new authorization request.",
      "coreCreate": "Create and authorize local goal",
      "coreGoals": "Recorded goals",
      "coreNoGoals": "No recorded goals.",
      "coreView": "View goal {id}",
      "coreDetails": "Goal details",
      "coreAuthorization": "Goal state",
      "coreExpiresAt": "Authorization expires",
      "coreEvaluations": "Evaluations started / limit",
      "coreActiveEvaluation": "Current evaluation ID",
      "coreNextEligible": "Next eligible evaluation",
      "corePause": "Pause goal",
      "coreResume": "Resume goal",
      "coreCancel": "Cancel goal",
      "coreControlHint": "These controls apply only to the selected goal. Pausing or cancelling does not undo effects that already occurred. Resume requires your explicit action.",
      "coreNative": "Native Goal observation",
      "coreNativeHint": "This is the observed native Goal state. The UI does not infer Goal completion from task acceptance or completion.",
      "coreBudget": "Authorized budget and ledger balance",
      "coreBudgetAxes": "Values are: tokens / calls / effects. Unknown is not zero.",
      "coreBudgetLimit": "Total limit",
      "coreBudgetSpent": "Settled",
      "coreBudgetHeld": "Held",
      "coreBudgetAvailable": "Available",
      "coreApprovedNotes": "Authorized note scope",
      "coreDeliverable": "Note ID",
      "coreDepends": "Dependencies",
      "coreNone": "None",
      "coreAcceptedTasks": "Accepted tasks",
      "coreNoAcceptedTasks": "No accepted tasks. A decision candidate is not execution authorization.",
      "coreDecisions": "Decision records",
      "coreNoDecisions": "No decision records.",
      "coreTriggers": "Trigger references",
      "coreCandidate": "Model candidate",
      "coreCandidateHint": "The control domain checks this candidate. Acceptance is recorded separately.",
      "coreDecisionReceipt": "Decision commit receipt",
      "coreReasonCode": "Result code",
      "coreObservedTokens": "Observed tokens",
      "coreUnknown": "This evaluation or its usage remains unreconciled. It is not replayed automatically and does not establish task completion.",
      "coreNotInSnapshot": "The selected goal is not in the current snapshot.",
      "coreSelect": "Select a goal to inspect it.",
      "corePump": "Evaluation scheduler",
      "coreUnconfirmed": "The goal operation receipt is unconfirmed. Refresh to inspect it; no automatic retry.",
      "coreChanged": "The goal, revision or runtime instance changed; the old receipt was not applied.",
      "coreAccepted": "Goal request received. Refreshed ledger state determines authorization and execution status.",
      "coreDuplicate": "This goal request already exists and was not authorized again. Inspect its current state.",
      "coreControlAccepted": "Control receipt received. The refreshed ledger determines the current goal state.",
      "status_authorized": "Authorized",
      "status_unapproved": "Awaiting authorization",
      "status_expired": "Expired",
      "status_committed": "Committed",
      "status_claimed": "Claimed",
      "status_rejected": "Rejected",
      "status_conflict": "Revision conflict",
      "status_complete": "Complete"
    });
    Object.assign(zh, {
      "coreNativeCommand": "最近原生命令",
      "coreNativeCommandId": "原生命令 ID",
      "coreNativeCommandOperation": "请求操作",
      "coreNativeOperation_create": "创建目标",
      "coreNativeOperation_update": "更新目标",
      "coreNativeOperation_pause": "暂停目标",
      "coreNativeOperation_resume": "恢复目标",
      "coreNativeOperation_complete": "完成目标",
      "coreNativeUnconfirmed": "原生命令尚未确认；已观察阶段不能证明本次命令完成。恢复暂不可用，仍可暂停或取消。",
      "status_confirmed": "已确认"
    });
    Object.assign(en, {
      "coreNativeCommand": "Latest native command",
      "coreNativeCommandId": "Native command ID",
      "coreNativeCommandOperation": "Requested operation",
      "coreNativeOperation_create": "Create goal",
      "coreNativeOperation_update": "Update goal",
      "coreNativeOperation_pause": "Pause goal",
      "coreNativeOperation_resume": "Resume goal",
      "coreNativeOperation_complete": "Complete goal",
      "coreNativeUnconfirmed": "The native command is unconfirmed. The last observed phase does not establish its completion. Resume is unavailable; pause and cancel remain possible.",
      "status_confirmed": "Confirmed"
    });
    Object.assign(zh, {
      "lab": "Lab 连接",
      "labHint": "连接明确授权的健身房运行，分别查看输入处理、回复草稿与实际送达。",
      "labUnavailable": "Lab 接口尚未接入。",
      "labNotReady": "Lab 服务尚未就绪。",
      "labScope": "当前范围：获准群聊或私聊中的文本消息。文件和任务完成操作尚未开放。",
      "labConnectTitle": "授权并连接 Lab",
      "labConnectHint": "点击后授权在指定频道、预算和期限内接收输入、生成回复并发送文本。查看或刷新只读取状态。",
      "labRunId": "Lab Run ID",
      "labTargetToken": "目标连接令牌",
      "labTokenHint": "令牌用于新连接或所选历史连接的回执查询，仅提交给本次 Runtime；不保存到浏览器，提交后立即清空。",
      "labChannelIds": "获准频道 ID",
      "labChannelHint": "以逗号或空格分隔，最多 20 个。按频道 ID 隔离群聊与私聊，同名参与者不会合并。",
      "labLimit_tokens": "回复 Token 总上限",
      "labLimit_calls": "回复调用总上限",
      "labLimit_effects": "消息总上限",
      "labBudgetHint": "Token 是预留与对账限额；未知用量或送达仍占用额度。草稿和调用计数不证明消息已经送达，也不代表完整费用。",
      "labConnect": "授权并连接",
      "labConnecting": "正在连接…",
      "labConnections": "已登记连接",
      "labNoConnections": "暂无 Lab 连接。",
      "labView": "查看连接 {id}",
      "labDetails": "连接详情",
      "labConnectionId": "连接 ID",
      "labConnectionState": "连接状态",
      "labSelect": "选择连接查看详情。",
      "labNotInSnapshot": "当前快照尚未包含所选连接，请刷新核对。",
      "labPause": "暂停连接",
      "labDisconnect": "断开连接",
      "labStopHint": "暂停或断连会阻止新回复和发送，已发生的效果保留。重新接入需要再次明确授权；刷新不会重连。",
      "labChannels": "获准频道与当前输入",
      "labChannelId": "频道 ID",
      "labChannelKind": "频道类型",
      "labKind_group": "群聊",
      "labKind_direct": "私聊",
      "labInputVersion": "当前输入版本",
      "labInputEvent": "当前输入事件",
      "labInputSeq": "输入序号",
      "labPendingInputs": "待答输入数",
      "labReplies": "回复处理记录",
      "labNoReplies": "尚无回复处理记录。",
      "labReplyId": "回复 ID",
      "labReplyStage": "处理阶段",
      "labReply_claimed": "已领取，处理中",
      "labReply_accounted": "生成用量已核算",
      "labReply_unknown": "生成或用量未确认",
      "labReply_sent": "已记录发送结果",
      "labReplyHint": "这些记录描述回复处理；实际送达以独立发送回执为准。",
      "labSends": "草稿与实际送达",
      "labNoSends": "尚无发送记录。",
      "labSendId": "发送操作 ID",
      "labDraftId": "已核对草稿 ID",
      "labEffectState": "效果状态",
      "labDelivery": "实际送达",
      "labDelivered": "已确认送达",
      "labDeliveryUnknown": "送达未知，保留占用",
      "labNotDelivered": "尚无送达证明",
      "labDeliveryEvent": "Lab 送达事件",
      "labReconcile": "显式核对未知发送",
      "labReconcileHint": "核对只读取 Lab 已有送达回执，不重新发送或调用模型。即使原授权过期或输入已更新，仍可核对既存事实；找不到回执时继续保留未知。",
      "labReconcileBlocked": "当前无法读取此发送回执；未知结果继续保留，刷新不会自动核对。",
      "labInvalidForm": "请填写有效 Run ID、令牌和不重复的频道 ID，并核对正整数预算。",
      "labExpiredDraft": "此连接请求已过期；修改授权表单以创建新请求。",
      "labUnconfirmed": "Lab 操作结果未确认，请刷新核对；不会自动重试。",
      "labChanged": "处理期间所选连接、版本或运行实例变化，旧回执未采用。",
      "labAccepted": "连接请求已有回执；连接与送达状态以刷新后的账本为准。",
      "labControlAccepted": "控制请求已有回执；当前状态以刷新后的账本为准。",
      "labReconcileAccepted": "核对请求已有回执；是否实际送达以刷新后的发送记录为准。",
      "status_connected": "已连接",
      "status_disconnected": "已断开",
      "status_needs_reconnect": "等待重新接入",
      "labTransport": "当前传输接入",
      "labPump": "输入扫描状态",
      "labActiveReplies": "正在处理的回复",
      "labBudgetAxes": "数值依次为：Token / 调用 / 消息。未知不视为零。",
      "status_polling": "正在扫描",
      "labAttach": "连接回执查询",
      "labAttachHint": "使用上方刚输入的令牌，按所选历史连接原有的请求、频道、预算和期限接入回执查询。不会新授权、恢复回复处理、调用模型或发送消息；之后仍需显式核对未知发送。",
      "labAttached": "历史连接已仅接入回执查询；未新授权或恢复回复处理，未发送消息。当前传输状态以刷新后的记录为准。",
      "labGroupTooLarge": "待合并输入过大，原始输入保留，受影响频道的回复处理已暂停；其他获准频道可继续。不会略过旧输入只处理最近几条。",
      "labInputBackpressure": "待答输入积压超限，原始输入保留，受影响频道的回复处理已暂停；其他获准频道可继续。不会静默丢弃或跳过输入。"
    });
    Object.assign(en, {
      "lab": "Lab connections",
      "labHint": "Connect an explicitly authorized Gym run and inspect input processing, reply drafts and actual delivery separately.",
      "labUnavailable": "The Lab interface is not connected.",
      "labNotReady": "The Lab service is not ready.",
      "labScope": "Current scope: text messages in permitted group chats or direct messages. File and task completion actions are unavailable.",
      "labConnectTitle": "Authorize and connect Lab",
      "labConnectHint": "This action authorizes receiving inputs, generating replies and sending text within the channels, budget and expiry below. Viewing and refreshing only read state.",
      "labRunId": "Lab Run ID",
      "labTargetToken": "Target connection token",
      "labTokenHint": "Use this token for a new connection or receipt access to the selected historical connection. It is submitted only to this Runtime, never saved in browser storage, and cleared immediately after submission.",
      "labChannelIds": "Permitted channel IDs",
      "labChannelHint": "Separate up to 20 IDs with commas or spaces. Group chats and direct messages remain isolated by channel ID; matching participant names do not merge identities.",
      "labLimit_tokens": "Total reply token limit",
      "labLimit_calls": "Total reply call limit",
      "labLimit_effects": "Total message limit",
      "labBudgetHint": "Tokens are a reservation and accounting limit. Unconfirmed usage or delivery stays held. Drafts and call counts do not establish delivery or complete cost.",
      "labConnect": "Authorize and connect",
      "labConnecting": "Connecting…",
      "labConnections": "Recorded connections",
      "labNoConnections": "No Lab connections.",
      "labView": "View connection {id}",
      "labDetails": "Connection details",
      "labConnectionId": "Connection ID",
      "labConnectionState": "Connection state",
      "labSelect": "Select a connection to inspect it.",
      "labNotInSnapshot": "The selected connection is absent from the current snapshot. Refresh to inspect it.",
      "labPause": "Pause connection",
      "labDisconnect": "Disconnect",
      "labStopHint": "Pausing or disconnecting blocks new replies and sends. Effects that already occurred remain recorded. Reconnecting requires explicit authorization; refreshing never reconnects.",
      "labChannels": "Permitted channels and current inputs",
      "labChannelId": "Channel ID",
      "labChannelKind": "Channel type",
      "labKind_group": "Group chat",
      "labKind_direct": "Direct message",
      "labInputVersion": "Current input version",
      "labInputEvent": "Current input event",
      "labInputSeq": "Input sequence",
      "labPendingInputs": "Pending input count",
      "labReplies": "Reply processing records",
      "labNoReplies": "No reply processing records.",
      "labReplyId": "Reply ID",
      "labReplyStage": "Processing stage",
      "labReply_claimed": "Claimed; processing",
      "labReply_accounted": "Generation usage accounted",
      "labReply_unknown": "Generation or usage unconfirmed",
      "labReply_sent": "Send outcome recorded",
      "labReplyHint": "These records describe reply processing. Actual delivery requires a separate send receipt.",
      "labSends": "Drafts and actual delivery",
      "labNoSends": "No send records.",
      "labSendId": "Send operation ID",
      "labDraftId": "Validated draft ID",
      "labEffectState": "Effect state",
      "labDelivery": "Actual delivery",
      "labDelivered": "Delivery confirmed",
      "labDeliveryUnknown": "Delivery unknown; budget held",
      "labNotDelivered": "No delivery evidence yet",
      "labDeliveryEvent": "Lab delivery event",
      "labReconcile": "Reconcile unknown send",
      "labReconcileHint": "Reconciliation only reads an existing Lab delivery receipt. It never resends or calls a model. Existing facts can be checked after authorization expiry or newer input; a missing receipt leaves the outcome unknown.",
      "labReconcileBlocked": "This send receipt cannot currently be read. Its outcome remains unknown; refreshing does not reconcile it automatically.",
      "labInvalidForm": "Enter a valid Run ID, token and unique channel IDs, and check positive integer budgets.",
      "labExpiredDraft": "This connection request has expired. Edit the authorization form to create a new request.",
      "labUnconfirmed": "The Lab outcome is unconfirmed. Refresh to inspect it; no automatic retry.",
      "labChanged": "The selected connection, revision or runtime instance changed; the old receipt was not applied.",
      "labAccepted": "Connection receipt received. Refreshed ledger state determines connection and delivery status.",
      "labControlAccepted": "Control receipt received. The refreshed ledger determines the current state.",
      "labReconcileAccepted": "Reconciliation receipt received. Refreshed send records determine actual delivery.",
      "status_connected": "Connected",
      "status_disconnected": "Disconnected",
      "status_needs_reconnect": "Reconnect required",
      "labTransport": "Current transport",
      "labPump": "Input polling state",
      "labActiveReplies": "Active replies",
      "labBudgetAxes": "Values are: tokens / calls / messages. Unknown is not zero.",
      "status_polling": "Polling",
      "labAttach": "Connect receipt access",
      "labAttachHint": "Use the token entered above with this historical connection’s original request, channels, budget and expiry. This only connects receipt access: no new authorization, reply processing, model call or message send. Unknown sends still require explicit reconciliation.",
      "labAttached": "Historical receipt access is connected. No new authorization, reply processing or message send was started. Refreshed records determine the current transport state.",
      "labGroupTooLarge": "The pending input group is too large. Original inputs are retained and reply processing for the affected channel is paused; other permitted channels can continue. Older inputs are not skipped to process only the latest few.",
      "labInputBackpressure": "The pending input backlog exceeds its limit. Original inputs are retained and reply processing for the affected channel is paused; other permitted channels can continue. Inputs are not silently discarded or skipped."
    });
    const knownStates = new Set(Object.keys(en).filter(key => key.startsWith('status_')).map(key => key.slice(7)));
    const css = `
.syr{--sr-bg:var(--dsw-alias-bg-base,#fff);--sr-layer:var(--dsw-alias-bg-layer-1,#fafafa);--sr-hover:var(--dsw-alias-bg-layer-2,#f2f3f5);--sr-text:var(--dsw-alias-label-primary,#202124);--sr-muted:var(--dsw-alias-label-secondary,#71757c);--sr-line:var(--dsw-alias-border-l1,#e6e8eb);--sr-accent:var(--dsw-alias-brand-primary,#4b62d8);--sr-error:var(--dsw-alias-state-error-primary,#b93b3b);--sr-ok:var(--dsw-alias-state-success-primary,#2f7d68);height:100%;min-height:0;min-width:0;overflow:auto;color:var(--sr-text);background:var(--sr-bg);font-size:13px;line-height:1.6;font-family:inherit}
.syr,.syr *{box-sizing:border-box}.syr h1,.syr h2,.syr h3,.syr p{margin:0}.syr button{font:inherit;cursor:pointer;color:inherit}.syr button:disabled{cursor:default;opacity:.5}.syr :focus-visible{outline:2px solid var(--sr-accent);outline-offset:3px}.syr-wrap{max-width:1152px;margin:0 auto;padding:28px 32px 40px}.syr-header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.syr-brand{display:flex;align-items:center;gap:11px;min-width:0}.syr-brand svg{color:var(--sr-accent);flex:none}.syr h1{font-size:22px;font-weight:600;letter-spacing:-.4px;line-height:1.4}.syr-meta{font-size:11px;color:var(--sr-muted);display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}.syr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.syr-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:33px;padding:5px 11px;border:1px solid var(--sr-line);border-radius:7px;background:var(--sr-bg);white-space:normal;text-align:center}.syr-btn:hover:not(:disabled){background:var(--sr-hover)}.syr-btn.syr-subtle{border-color:transparent;background:transparent;color:var(--sr-muted)}.syr-btn.syr-subtle:hover{background:var(--sr-hover)}.syr-btn svg{flex:none}.syr-tabs{display:flex;gap:24px;border-bottom:1px solid var(--sr-line);margin-bottom:24px;overflow-x:auto}.syr-tab{border:0;border-bottom:2px solid transparent;background:none;padding:9px 1px;color:var(--sr-muted)!important;white-space:nowrap}.syr-tab[aria-current=page]{color:var(--sr-text)!important;border-bottom-color:var(--sr-accent);font-weight:600}.syr-stack{display:flex;flex-direction:column;gap:22px}.syr-row{display:flex;align-items:center;gap:10px;min-width:0}.syr-between{justify-content:space-between}.syr-muted{color:var(--sr-muted)}.syr-small{font-size:12px}.syr-break{overflow-wrap:anywhere;word-break:break-word}.syr-section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.syr h2{font-size:15px;font-weight:600}.syr h3{font-size:13px;font-weight:600}.syr-count{font-variant-numeric:tabular-nums;font-size:11px;font-weight:400;color:var(--sr-muted);margin-left:8px}.syr-state{border:1px solid var(--sr-line);border-radius:9px;padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:20px;background:var(--sr-layer)}.syr-state-label{font-size:11px;color:var(--sr-muted);margin-bottom:7px}.syr-state-main{display:flex;align-items:center;gap:10px;font-size:24px;font-weight:550;line-height:1.35;margin-bottom:8px}.syr-dot{width:8px;height:8px;border-radius:50%;background:var(--sr-muted);flex:none;display:inline-block}.syr-dot[data-state=idle],.syr-dot[data-state=ready],.syr-dot[data-state=available],.syr-dot[data-state=implemented],.syr-dot[data-state=completed],.syr-dot[data-state=succeeded]{background:var(--sr-ok)}.syr-dot[data-state=busy],.syr-dot[data-state=running],.syr-dot[data-state=partial],.syr-dot[data-state=active]{background:var(--sr-accent)}.syr-dot[data-state=failed],.syr-dot[data-state=blocked],.syr-dot[data-state=unavailable],.syr-dot[data-state=error]{background:var(--sr-error)}.syr-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:11px;color:var(--sr-muted)}.syr-status .syr-dot{width:5px;height:5px}.syr-state-info{text-align:right;flex:none;font-size:11px;color:var(--sr-muted)}.syr-columns{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:24px}.syr-box{min-width:0;border:1px solid var(--sr-line);border-radius:9px;padding:18px 20px}.syr-empty{font-size:12px;color:var(--sr-muted);padding:18px 0}.syr-entry{padding:12px 0;border-bottom:1px solid var(--sr-line);min-width:0}.syr-entry:last-child{border-bottom:0;padding-bottom:0}.syr-entry:first-child{padding-top:0}.syr-entry-title{font-weight:500;overflow-wrap:anywhere}.syr-entry p{font-size:12px;overflow-wrap:anywhere;margin-top:4px}.syr-notice{padding-left:11px;border-left:2px solid var(--sr-line)}.syr-notice[data-level=error]{border-left-color:var(--sr-error)}.syr-notice[data-level=warning]{border-left-color:var(--sr-accent)}.syr-alert{border:1px solid var(--sr-line);border-left:3px solid var(--sr-error);border-radius:7px;padding:11px 14px;margin-bottom:18px;font-size:12px;overflow-wrap:anywhere;background:var(--sr-layer)}.syr-alert strong{display:block;margin-bottom:3px}.syr-feedback{font-size:12px;color:var(--sr-muted);padding:10px 0;margin-bottom:8px;overflow-wrap:anywhere}.syr-timeline{list-style:none;padding:0;margin:0}.syr-timeline li{display:grid;grid-template-columns:110px 1fr auto;gap:16px;padding:11px 0;border-bottom:1px solid var(--sr-line);align-items:start}.syr-timeline li:last-child{border:0}.syr-timeline time{color:var(--sr-muted);font-size:11px;font-variant-numeric:tabular-nums}.syr-event-metrics{display:flex;gap:22px;flex-wrap:wrap;margin:4px 0 12px}.syr-metric{font-size:12px;color:var(--sr-muted)}.syr-metric strong{font-weight:500;color:var(--sr-text);margin-right:6px;font-variant-numeric:tabular-nums}.syr-system-list{border-top:1px solid var(--sr-line)}.syr-system-row{padding:17px 0;display:grid;grid-template-columns:minmax(150px,.7fr) 110px minmax(0,2fr);gap:20px;border-bottom:1px solid var(--sr-line);align-items:start}.syr-system-row p{font-size:12px;color:var(--sr-muted);overflow-wrap:anywhere}.syr-session-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.9fr);gap:24px;align-items:start}.syr-session-list{display:flex;flex-direction:column;gap:7px}.syr-session-button{border:1px solid var(--sr-line);border-radius:7px;text-align:left;padding:13px 14px;background:var(--sr-bg);width:100%;min-width:0}.syr-session-button:hover{background:var(--sr-layer)}.syr-session-button[aria-pressed=true]{border-color:var(--sr-accent);background:var(--sr-layer)}.syr-session-button .syr-id{display:block;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--sr-muted);margin-top:6px}.syr-facts{margin:0;display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 14px;font-size:12px}.syr-facts dt{color:var(--sr-muted)}.syr-facts dd{margin:0;overflow-wrap:anywhere}.syr-facts .syr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.syr-divider{border:0;border-top:1px solid var(--sr-line);margin:18px 0}.syr-diagnostic-head{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap}.syr-dependency{padding:12px 0;border-bottom:1px solid var(--sr-line)}.syr-dependency:last-child{border:0}.syr-dependency p{margin-top:5px;font-size:12px;color:var(--sr-muted);overflow-wrap:anywhere}.syr-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}.syr-footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--sr-line);margin-top:28px;padding-top:12px;font-size:11px;color:var(--sr-muted)}.syr-loading{padding:36px 0;color:var(--sr-muted);font-size:13px}.syr-system-heading{margin-bottom:20px}.syr-system-heading p{font-size:12px;color:var(--sr-muted);margin-top:6px}.syr-section-gap{margin-top:22px}
@media(max-width:820px){.syr-wrap{padding:22px 22px 32px}.syr-columns,.syr-session-layout{grid-template-columns:1fr}.syr-system-row{grid-template-columns:minmax(0,1fr) auto;gap:7px 16px}.syr-system-row p{grid-column:1/-1}.syr-state-info{display:none}}
@media(max-width:480px){.syr-wrap{padding:18px 16px 26px}.syr-header{align-items:flex-start;flex-wrap:wrap;gap:12px}.syr h1{font-size:21px}.syr-header>.syr-actions{margin-left:37px}.syr-tabs{gap:22px;margin-bottom:18px}.syr-box{padding:16px}.syr-state{padding:17px}.syr-state-main{font-size:22px}.syr-timeline li{grid-template-columns:1fr auto;gap:4px 12px}.syr-timeline time{grid-column:1/-1}.syr-facts{grid-template-columns:94px minmax(0,1fr);gap:9px 12px}.syr-diagnostic-head{align-items:flex-start;flex-direction:column}.syr-diagnostic-head .syr-btn{max-width:100%}.syr-footer{flex-direction:column;gap:4px}}
.syr-task-layout{display:grid;grid-template-columns:minmax(240px,.75fr) minmax(0,1.4fr);gap:24px;align-items:start}.syr-task-label{font-weight:500;overflow-wrap:anywhere}.syr-task-list-row{align-items:flex-start;flex-wrap:wrap}.syr-task-caption{display:block;margin-top:5px;font-size:11px;color:var(--sr-muted)}.syr-task-detail{min-width:0}.syr-task-detail>.syr-section-title{align-items:flex-start}.syr-task-detail .syr-alert{margin-top:16px}.syr-task-check{border-top:1px solid var(--sr-line);padding:14px 0}.syr-task-check:last-child{padding-bottom:0}.syr-task-check>h3,.syr-task-check>.syr-row{margin-bottom:10px}.syr-evidence{margin:6px 0 0;padding-left:18px;font-size:11px;overflow-wrap:anywhere}.syr-evidence li{padding:3px 0}.syr-evidence code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.syr-task-result{margin-top:16px;padding-top:16px;border-top:1px solid var(--sr-line)}.syr-task-result .syr-small{margin-top:8px}
.syr-link-controls{min-width:0;flex:1 1 280px}.syr-select-label{display:flex;flex-direction:column;gap:5px;margin-top:12px;max-width:100%;font-size:12px}.syr-select{font:inherit;color:var(--sr-text);background:var(--sr-bg);border:1px solid var(--sr-line);border-radius:7px;min-height:34px;padding:6px 8px;width:100%;max-width:480px;min-width:0}.syr-select:disabled{opacity:.5}
.syr-textarea{font:inherit;color:var(--sr-text);background:var(--sr-bg);border:1px solid var(--sr-line);border-radius:7px;min-height:120px;width:100%;padding:9px 10px;resize:vertical}.syr-table-wrap{max-width:100%;overflow-x:auto}.syr-table{width:100%;border-collapse:collapse;font-size:12px}.syr-table th,.syr-table td{text-align:left;padding:11px 10px;border-bottom:1px solid var(--sr-line);vertical-align:top}.syr-table th{font-weight:500;color:var(--sr-muted)}.syr-table td:first-child{min-width:140px;max-width:320px;overflow-wrap:anywhere}.syr-table .syr-btn{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere;text-align:left}.syr-memory-body{margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:inherit;font-size:12px}.syr-memory-form>.syr-actions{margin-top:14px}
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
        // Native observation is authoritative; a candidate or successful Task
        // cannot turn the local dispatch pause into Goal completion.
        const coreGoalComplete = goal => goal?.native?.phase === 'complete';
        const labConnectionValid = connection => connection && typeof connection.connectionId === 'string' && connection.connectionId.trim()
          && typeof connection.runId === 'string' && connection.runId.trim() && Number.isSafeInteger(connection.version) && connection.version >= 1
          && ['connected', 'paused', 'disconnected', 'needs_reconnect'].includes(connection.status) && Array.isArray(connection.channels);
        const labHistoricalIntentValid = connection => labConnectionValid(connection) && typeof connection.requestId === 'string' && Boolean(connection.requestId.trim())
          && Number.isFinite(Date.parse(connection.expiresAt)) && ['tokens', 'calls', 'effects'].every(key => Number.isSafeInteger(connection.budget?.[key]) && connection.budget[key] > 0)
          && connection.channels.length > 0 && connection.channels.length <= 20 && connection.channels.every(channel => typeof channel.channelId === 'string' && Boolean(channel.channelId.trim()))
          && new Set(connection.channels.map(channel => channel.channelId)).size === connection.channels.length;
        const labIntentMatches = (connection, payload) => labHistoricalIntentValid(connection) && connection.requestId === payload.requestId && connection.runId === payload.runId
          && connection.expiresAt === payload.expiresAt && ['tokens', 'calls', 'effects'].every(key => connection.budget[key] === payload.budget?.[key])
          && JSON.stringify(connection.channels.map(channel => channel.channelId)) === JSON.stringify(payload.channelIds);
        const labDelivered = send => send?.status === 'succeeded' && typeof send.sendId === 'string' && Boolean(send.sendId.trim())
          && typeof send.channelId === 'string' && Boolean(send.channelId.trim()) && /^[a-f0-9]{64}$/.test(send.bodyHash)
          && typeof send.observation?.eventId === 'string' && Boolean(send.observation.eventId.trim()) && send.observation.opId === send.sendId
          && send.observation.channelId === send.channelId && send.observation.bodyHash === send.bodyHash && Number.isFinite(Date.parse(send.observation.observedAt));
        const labCanReconcile = (current, connection, send) => current?.lab?.ready === true
          && labConnectionValid(connection) && connection.live === true
          && send?.canReconcile === true && send.status === 'unknown'
          && connection.channels.some(channel => channel.channelId === send.channelId);
        const memoryEntryValid = entry => entry && typeof entry === 'object' && !Array.isArray(entry)
          && ['operationId', 'requestId', 'conversationId', 'status'].every(key => typeof entry[key] === 'string' && Boolean(entry[key].trim()))
          && Number.isSafeInteger(entry.version) && entry.version >= 1 && typeof entry.blocked === 'boolean'
          && Number.isSafeInteger(entry.bodyBytes) && entry.bodyBytes >= 0 && ['active', 'withdrawn'].includes(entry.consent) && typeof entry.canRead === 'boolean';
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
          const [selectedCoreGoal, setSelectedCoreGoal] = useState(null);
          const [coreObjective, setCoreObjective] = useState('');
          const [coreNotes, setCoreNotes] = useState([{ id: 'note-1', title: '', content: '', dependencies: '' }]);
          const [coreBudget, setCoreBudget] = useState({ tokens: '131072', calls: '12', effects: '3', maxEvaluations: '4' });
          const [coreLifetime, setCoreLifetime] = useState('30');
          const [coreControl, setCoreControl] = useState('');
          const [coreError, setCoreError] = useState('');
          const [coreNotice, setCoreNotice] = useState('');
          const coreDraft = useRef({ revision: 0, payload: null });
          const coreSelection = useRef({ id: null, revision: 0 });
          const [selectedLabConnection, setSelectedLabConnection] = useState(null);
          const [labRunId, setLabRunId] = useState('');
          const [labToken, setLabToken] = useState('');
          const [labChannels, setLabChannels] = useState('');
          const [labBudget, setLabBudget] = useState({ tokens: '65536', calls: '4', effects: '4' });
          const [labLifetime, setLabLifetime] = useState('30');
          const [labControl, setLabControl] = useState('');
          const [labError, setLabError] = useState('');
          const [labNotice, setLabNotice] = useState('');
          // The retry identity holds only public grant metadata, never the token.
          const labDraft = useRef({ revision: 0, payload: null });
          const labSelection = useRef({ id: null, revision: 0 });
          const [selectedConversation, setSelectedConversation] = useState(null);
          const [linkTaskId, setLinkTaskId] = useState(null);
          const [command, setCommand] = useState('');
          const [commandError, setCommandError] = useState('');
          const [commandNotice, setCommandNotice] = useState('');
          const [controlCommand, setControlCommand] = useState('');
          const [controlError, setControlError] = useState('');
          const [controlNotice, setControlNotice] = useState('');
          const [goalReceipt, setGoalReceipt] = useState(null);
          const [contextReceipt, setContextReceipt] = useState(null);
          const [contextAttempt, setContextAttempt] = useState(null);
          const [memorySelected, setMemorySelected] = useState(null);
          const [memoryConversationId, setMemoryConversationId] = useState('');
          const [memoryText, setMemoryText] = useState('');
          const [memoryBody, setMemoryBody] = useState(null);
          const [memoryWithdrawing, setMemoryWithdrawing] = useState('');
          const [memoryError, setMemoryError] = useState('');
          const [memoryNotice, setMemoryNotice] = useState('');
          const [memoryQuery, setMemoryQuery] = useState('');
          const [memorySearch, setMemorySearch] = useState(null);
          const [memoryIndexReceipt, setMemoryIndexReceipt] = useState(null);
          const [contextLoadText, setContextLoadText] = useState('');
          const [contextLoadReceipt, setContextLoadReceipt] = useState(null);
          const memoryDraftId = useRef(null), memoryWithdrawIds = useRef(new Map());
          const memoryIndexIds = useRef(new Map()), memorySearchGuard = useRef(0), contextLoadGuard = useRef(0), contextLoadDraftId = useRef(null), contextLoadSelection = useRef(null);
          const memoryGuard = useRef({ snapshot: null, fresh: false, selected: null, revision: 0, body: null, revoked: new Set() });
          function clearMemoryBody() { memoryGuard.current.revision++; memoryGuard.current.body = null; setMemoryBody(null); }
          function chooseMemory(operationId) { clearMemoryBody(); memoryGuard.current.selected = operationId; setMemorySelected(operationId); }
          function changeCoreDraft() { coreDraft.current.revision++; coreDraft.current.payload = null; setCoreNotice(''); }
          function chooseCoreGoal(goalId) { coreSelection.current = { id: goalId, revision: coreSelection.current.revision + 1 }; setSelectedCoreGoal(goalId); setCoreError(''); setCoreNotice(''); }
          function changeLabDraft() { labDraft.current.revision++; labDraft.current.payload = null; setLabNotice(''); }
          function chooseLabConnection(connectionId) { labSelection.current = { id: connectionId, revision: labSelection.current.revision + 1 }; setSelectedLabConnection(connectionId); setLabError(''); setLabNotice(''); }
          function chooseConversation(value) { contextLoadGuard.current++; contextLoadDraftId.current = null; contextLoadSelection.current = value; setContextLoadReceipt(null); setSelectedConversation(value); }
          function memoryCanRead(operationId) {
            const guard = memoryGuard.current, current = guard.snapshot;
            const entry = arr(current?.memory?.entries).find(item => item?.operationId === operationId);
            return guard.fresh && Number.isFinite(Date.parse(current?.observedAt)) && Date.now() - Date.parse(current.observedAt) <= 30000
              && current.memory?.configured === true && current.memory?.ready === true && ['idle', 'busy', 'waiting'].includes(current.state)
              && current.lifecycle !== 'stopping' && !guard.revoked.has(operationId) && memoryEntryValid(entry) && entry.canRead === true && entry.consent === 'active' && !entry.blocked;
          }
          const rootRef = useRef(null);
          const operations = useRef({ refresh: () => {}, command: () => {}, memory: () => {}, semantic: () => {}, core: () => {}, lab: () => {} });
          useEffect(() => {
            if (disposed) return;
            let alive = true, panelVisible = Boolean(rootRef.current?.getClientRects().length), reading = null, commandInFlight = false, controlInFlight = false, withdrawalInFlight = false, coreControlInFlight = false, labControlInFlight = false;
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
                const guard = memoryGuard.current;
                const previousEntry = arr(guard.snapshot?.memory?.entries).find(item => item?.operationId === guard.selected);
                const nextEntry = arr(next.memory?.entries).find(item => item?.operationId === guard.selected);
                const instanceChanged = guard.snapshot && guard.snapshot.instanceId !== next.instanceId;
                const selection = contextLoadSelection.current;
                const selectedBinding = item => item?.bindingId === selection?.bindingId && item?.conversationId === selection?.conversationId;
                const priorConversation = arr(guard.snapshot?.conversations).find(selectedBinding), nextConversation = arr(next.conversations).find(selectedBinding);
                if (selection && (instanceChanged || priorConversation?.sessionEpoch !== nextConversation?.sessionEpoch)) {
                  contextLoadGuard.current++; contextLoadDraftId.current = null; setContextLoadReceipt(null);
                }
                if (instanceChanged) { coreSelection.current.revision++; labSelection.current.revision++; changeLabDraft(); setLabToken(''); setLabNotice(''); }
                guard.snapshot = next; guard.fresh = true;
                if (instanceChanged || (guard.selected && (!memoryCanRead(guard.selected) || !previousEntry || !nextEntry || previousEntry.version !== nextEntry.version
                  || previousEntry.requestId !== nextEntry.requestId || previousEntry.conversationId !== nextEntry.conversationId || previousEntry.nativeId !== nextEntry.nativeId))) clearMemoryBody();
                setSnapshot(next); setLastRead(new Date().toISOString()); setReadError(''); setClock(Date.now());
                return true;
              } catch (error) {
                if (alive && !disposed && reading === controller) { memoryGuard.current.fresh = false; clearMemoryBody(); setReadError(controller.signal.aborted ? t('loadFailed') : error.message || t('loadFailed')); }
                return false;
              } finally {
                clearTimeout(timeout);
                if (reading === controller) { reading = null; if (alive && !disposed) setLoading(false); }
              }
            }
            async function issue(action, payload = {}, expected = {}) {
              const isControl = action === 'runtime.pause' || action === 'runtime.resume';
              if (!alive || disposed || (isControl ? controlInFlight || (action === 'runtime.resume' && commandInFlight) : commandInFlight || controlInFlight || withdrawalInFlight || coreControlInFlight || labControlInFlight)) return;
              const setPending = isControl ? setControlCommand : setCommand;
              const setError = isControl ? setControlError : setCommandError;
              const setNotice = isControl ? setControlNotice : setCommandNotice;
              if (isControl) controlInFlight = true; else commandInFlight = true;
              setPending(action); setError(''); setNotice('');
              if (action === 'runtime.pause') clearMemoryBody();
              if (action === 'goal.verify-lifecycle') setGoalReceipt(null);
              if (action === 'conversation.verifyContext') { setContextReceipt(null); setContextAttempt({ conversationId: payload.conversationId, bindingId: expected.bindingId }); }
              const controller = new AbortController(); writes.add(controller);
              let timedOut = false;
              const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, action === 'session.verify-model' ? 250000 : action === 'conversation.verifyContext' ? 95000 : 20000);
              deadlines.add(timeout);
              try {
                const result = await api('commands', { signal: controller.signal, action, payload });
                if (action === 'session.probe' && (result?.ready !== true || result?.noModelCalled !== true || result?.released !== true || result?.archived !== true)) throw new Error(t('probeUnconfirmed'));
                if (action === 'session.verify-model' && (result?.verified !== true || result?.calls !== 2 || result?.sameSession !== true || result?.sent !== false)) throw new Error(t('modelVerifyUnconfirmed'));
                if (action === 'task.createLocal' && (result?.accepted !== true || typeof result?.task?.taskId !== 'string' || !result.task.taskId.trim())) throw new Error(t('localTaskUnconfirmed'));
                if (action === 'conversation.linkLocalTask' && (result?.accepted !== true || result?.taskId !== payload.taskId
                  || !['conversationId', 'bindingId'].every(key => typeof result?.[key] === 'string' && Boolean(result[key].trim())))) throw new Error(t('conversationLinkUnconfirmed'));
                if (action === 'conversation.verifyContext' && (result?.verified !== true || result?.conversationId !== payload.conversationId
                  || typeof result?.bindingId !== 'string' || !result.bindingId.trim() || result.bindingId !== expected.bindingId
                  || typeof result?.sessionId !== 'string' || !result.sessionId.trim() || result?.sameSession !== true || result?.calls !== 2
                  || result?.contextDurable !== true || result?.draftsValidated !== true || result?.sent !== false)) throw new Error(t('contextVerifyUnconfirmed'));
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
                  chooseConversation({ conversationId: result.conversationId, bindingId: result.bindingId, taskId: result.taskId }); setTab('conversations');
                }
                if (action === 'conversation.verifyContext') {
                  // Only receipt metadata is retained. Binding identity is local
                  // validation context and is never added to the public command.
                  setContextReceipt({ conversationId: result.conversationId, bindingId: result.bindingId, sessionId: result.sessionId,
                    calls: result.calls, instanceId: expected.instanceId });
                  setNotice(t('contextVerifyReturned', { id: result.conversationId }));
                }
                const refreshed = await refresh(true);
                if (alive && !disposed && refreshed && !['task.createLocal', 'goal.verify-lifecycle', 'conversation.linkLocalTask', 'conversation.verifyContext'].includes(action)) setNotice(t(action === 'session.probe' ? 'probeDone' : action === 'session.verify-model' ? 'modelVerifyDone' : action === 'runtime.pause' ? 'pausedDone' : 'resumedDone'));
              } catch (error) {
                if (alive && !disposed) {
                  const message = timedOut && action === 'session.verify-model' ? t('modelVerifyTimeout') : timedOut && action === 'conversation.verifyContext' ? t('contextVerifyTimeout') : controller.signal.aborted ? t('commandUncertain') : error.message || t('commandFailed');
                  setError(action === 'conversation.verifyContext' ? `${t('conversationId')} · ${payload.conversationId}: ${message}` : message); await refresh(true);
                }
              } finally {
                clearTimeout(timeout); deadlines.delete(timeout); writes.delete(controller);
                if (isControl) controlInFlight = false; else commandInFlight = false;
                if (alive && !disposed) { setPending(''); if (action === 'conversation.verifyContext') setContextAttempt(null); }
              }
            }
            async function issueMemory(action, payload) {
              const withdraw = action === 'memory.withdrawLocal';
              if (!alive || disposed || (withdraw ? withdrawalInFlight : commandInFlight || controlInFlight || withdrawalInFlight)) return;
              const guard = memoryGuard.current, current = guard.snapshot;
              const currentEntry = arr(current?.memory?.entries).find(item => item?.operationId === payload.operationId);
              if (withdraw) {
                if (!memoryEntryValid(currentEntry) || currentEntry.consent !== 'active' || current?.lifecycle === 'stopping') return;
                withdrawalInFlight = true; setMemoryWithdrawing(payload.operationId); guard.revoked.add(payload.operationId); clearMemoryBody();
              } else {
                const fresh = guard.fresh && Number.isFinite(Date.parse(current?.observedAt)) && Date.now() - Date.parse(current.observedAt) <= 30000;
                if (!fresh || current?.memory?.configured !== true || current.memory.ready !== true || !['idle', 'busy', 'waiting'].includes(current.state) || current.lifecycle === 'stopping') return;
                if (action === 'memory.readLocal' && (!memoryCanRead(payload.operationId) || guard.selected !== payload.operationId)) return;
                commandInFlight = true; setCommand(action);
                if (action === 'memory.readLocal') clearMemoryBody();
              }
              const readRevision = guard.revision, readVersion = currentEntry?.version, instanceId = current?.instanceId;
              setMemoryError(''); setMemoryNotice('');
              const controller = new AbortController(); writes.add(controller);
              const timeout = setTimeout(() => controller.abort(), 70000); deadlines.add(timeout);
              try {
                const result = await api('commands', { action, payload, signal: controller.signal });
                if (!alive || disposed) return;
                if (action === 'memory.rememberLocal') {
                  if (typeof result?.duplicate !== 'boolean' || !memoryEntryValid(result?.entry) || result.entry.requestId !== payload.requestId || result.entry.conversationId !== payload.conversationId) throw new Error(t('memoryUnconfirmed'));
                  chooseMemory(result.entry.operationId); setMemoryNotice(t(result.duplicate ? 'memoryDuplicate' : 'memorySaved'));
                  // A receipt selects an ID, never inserts returned metadata/body into the snapshot.
                } else if (action === 'memory.readLocal') {
                  const latest = arr(guard.snapshot?.memory?.entries).find(item => item?.operationId === payload.operationId);
                  if (!memoryEntryValid(result?.entry) || result.entry.operationId !== payload.operationId || result.entry.version !== readVersion || result.entry.canRead !== true || result.entry.consent !== 'active' || result.entry.blocked || typeof result.body !== 'string') throw new Error(t('memoryUnconfirmed'));
                  if (guard.revision !== readRevision || guard.selected !== payload.operationId || guard.snapshot?.instanceId !== instanceId || !memoryCanRead(payload.operationId)
                    || latest.version !== result.entry.version || latest.requestId !== result.entry.requestId || latest.conversationId !== result.entry.conversationId || latest.nativeId !== result.entry.nativeId) throw new Error(t('memoryReadChanged'));
                  const body = { operationId: payload.operationId, version: result.entry.version, instanceId, body: result.body };
                  guard.body = body; setMemoryBody(body);
                } else {
                  if (!memoryEntryValid(result) || result.operationId !== payload.operationId || result.consent !== 'withdrawn' || result.canRead !== false) throw new Error(t('memoryWithdrawUnconfirmed'));
                  setMemoryNotice(t('memoryWithdrawn'));
                }
                await refresh(true);
              } catch (error) {
                if (alive && !disposed) { setMemoryError(withdraw ? t('memoryWithdrawUnconfirmed') : controller.signal.aborted ? t('memoryUnconfirmed') : error.message || t('memoryUnconfirmed')); await refresh(true); }
              } finally {
                clearTimeout(timeout); deadlines.delete(timeout); writes.delete(controller);
                if (withdraw) { withdrawalInFlight = false; if (alive && !disposed) setMemoryWithdrawing(''); }
                else { commandInFlight = false; if (alive && !disposed) setCommand(''); }
              }
            }
            async function issueSemantic(action, payload, expected = {}) {
              if (!alive || disposed || commandInFlight || controlInFlight || withdrawalInFlight) return;
              const guard = memoryGuard.current, current = guard.snapshot, load = action === 'conversation.loadContext';
              const fresh = guard.fresh && Number.isFinite(Date.parse(current?.observedAt)) && Date.now() - Date.parse(current.observedAt) <= 30000;
              const semantic = current?.memory?.backend?.semantic;
              if (!fresh || !['idle', 'busy', 'waiting'].includes(current?.state) || current.lifecycle === 'stopping') return;
              if (load ? current.diagnostics?.contextSafety?.ready !== true : current.memory?.semanticConfigured !== true || current.memory?.ready !== true
                || semantic?.profileCompatible !== true || !['unverified', 'ready'].includes(semantic.state)) return;
              if (action === 'memory.indexLocal' && (!memoryCanRead(payload.operationId) || guard.selected !== payload.operationId)) return;
              commandInFlight = true; setCommand(action); setMemoryError(''); setMemoryNotice('');
              const instanceId = current.instanceId, searchRevision = memorySearchGuard.current, loadRevision = contextLoadGuard.current;
              if (action === 'memory.searchLocal') setMemorySearch(null);
              if (load) setContextLoadReceipt(null);
              const controller = new AbortController(); writes.add(controller);
              const timeout = setTimeout(() => controller.abort(), 70000); deadlines.add(timeout);
              const usageValid = value => value && typeof value.complete === 'boolean' && (value.calls === null ? value.complete === false : Number.isSafeInteger(value.calls) && value.calls >= 0);
              try {
                const result = await api('commands', { action, payload, signal: controller.signal });
                if (!alive || disposed) return;
                const latest = guard.snapshot;
                if (latest?.instanceId !== instanceId || latest.state === 'paused' || !guard.fresh) throw new Error(t('semanticResultChanged'));
                if (action === 'memory.indexLocal') {
                  const entry = result?.entry;
                  if (typeof result?.duplicate !== 'boolean' || entry?.memoryOperationId !== payload.operationId || typeof entry.indexOperationId !== 'string' || !entry.indexOperationId
                    || typeof entry.status !== 'string' || typeof entry.publishable !== 'boolean' || !usageValid(entry.embeddingUsage)) throw new Error(t('semanticUnconfirmed'));
                  if (!memoryCanRead(payload.operationId)) throw new Error(t('semanticResultChanged'));
                  setMemoryIndexReceipt({ operationId: payload.operationId, instanceId, duplicate: result.duplicate, indexOperationId: entry.indexOperationId,
                    status: entry.status, publishable: entry.publishable, embeddingUsage: { calls: entry.embeddingUsage.calls, complete: entry.embeddingUsage.complete } });
                  setMemoryNotice(t(result.duplicate ? 'memoryIndexDuplicate' : entry.publishable ? 'memoryIndexed' : 'memoryIndexUnconfirmed'));
                } else if (action === 'memory.searchLocal') {
                  const coverage = result?.coverage;
                  if (!['ok', 'index_required'].includes(result?.state) || !Array.isArray(result.matches) || result.matches.length > 10
                    || result.matches.some(item => typeof item?.operationId !== 'string' || !item.operationId || typeof item.score !== 'number' || !Number.isFinite(item.score))
                    || new Set(result.matches.map(item => item.operationId)).size !== result.matches.length
                    || !coverage || !['eligibleCount', 'indexedCount', 'missingCount'].every(key => Number.isSafeInteger(coverage[key]) && coverage[key] >= 0)
                    || coverage.indexedCount + coverage.missingCount !== coverage.eligibleCount || (result.state === 'index_required' && !coverage.missingCount)
                    || (result.state === 'index_required' && result.matches.length) || (result.state === 'ok' && coverage.missingCount)
                    || !usageValid({ calls: result.embeddingCalls, complete: result.usageComplete })) throw new Error(t('semanticUnconfirmed'));
                  if (searchRevision !== memorySearchGuard.current || !arr(latest.conversations).some(item => item.conversationId === payload.conversationId && item.scope === 'local-owner')
                    || result.matches.some(item => !memoryCanRead(item.operationId) || arr(latest.memory.entries).find(entry => entry.operationId === item.operationId)?.conversationId !== payload.conversationId)) throw new Error(t('semanticResultChanged'));
                  setMemorySearch({ instanceId, conversationId: payload.conversationId, revision: searchRevision, state: result.state,
                    matches: result.matches.map(({ operationId, score }) => ({ operationId, score })), coverage: { eligibleCount: coverage.eligibleCount, indexedCount: coverage.indexedCount, missingCount: coverage.missingCount },
                    embeddingCalls: result.embeddingCalls, usageComplete: result.usageComplete });
                } else {
                  const operation = result?.operation, receipt = result?.load?.contextReceipt;
                  if (typeof result?.duplicate !== 'boolean' || operation?.conversationId !== payload.conversationId || operation.inputId !== payload.inputId
                    || operation.bindingId !== expected.bindingId || operation.sessionEpoch !== expected.sessionEpoch || typeof operation.operationId !== 'string' || !operation.operationId) throw new Error(t('contextLoadUnconfirmed'));
                  if (!result.duplicate && (result.status !== 'loaded' || operation.status !== 'loaded' || operation.durability !== 'confirmed' || result.load?.mode !== 'load-only'
                    || result.load.inferenceRequested !== false || result.load.followupRequested !== false || receipt?.durability !== 'confirmed'
                    || receipt.operationId !== operation.operationId || receipt.sessionEpoch !== operation.sessionEpoch || receipt.sessionId !== result.load.binding?.sessionId
                    || typeof receipt.sessionId !== 'string' || !receipt.sessionId || !Number.isSafeInteger(receipt.userMessageSeq) || receipt.userMessageSeq < 1
                    || typeof receipt.messageId !== 'string' || !receipt.messageId || !/^[a-f0-9]{64}$/.test(receipt.messageHash))) throw new Error(t('contextLoadUnconfirmed'));
                  const currentConversation = arr(latest.conversations).find(item => item.conversationId === payload.conversationId && item.bindingId === expected.bindingId);
                  if (loadRevision !== contextLoadGuard.current || currentConversation?.sessionEpoch !== expected.sessionEpoch) throw new Error(t('semanticResultChanged'));
                  setContextLoadReceipt({ instanceId, conversationId: payload.conversationId, bindingId: expected.bindingId, sessionEpoch: operation.sessionEpoch,
                    operationId: operation.operationId, duplicate: result.duplicate, status: operation.status,
                    ...(!result.duplicate ? { sessionId: receipt.sessionId, userMessageSeq: receipt.userMessageSeq } : {}) });
                  setMemoryNotice(t(result.duplicate ? 'contextLoadDuplicate' : 'contextLoaded'));
                }
                await refresh(true);
              } catch (error) {
                if (alive && !disposed) { setMemoryError(controller.signal.aborted ? t('semanticUnconfirmed') : error.message || t('semanticUnconfirmed')); await refresh(true); }
              } finally {
                clearTimeout(timeout); deadlines.delete(timeout); writes.delete(controller); commandInFlight = false;
                if (alive && !disposed) setCommand('');
              }
            }
            async function issueCore(action, payload) {
              const create = action === 'core.create', stop = action === 'core.pause' || action === 'core.cancel';
              if (!alive || disposed || coreControlInFlight || controlInFlight || (!stop && (commandInFlight || withdrawalInFlight))) return;
              const guard = memoryGuard.current, current = guard.snapshot;
              const fresh = guard.fresh && Number.isFinite(Date.parse(current?.observedAt)) && Date.now() - Date.parse(current.observedAt) <= 30000;
              const goal = arr(current?.core?.goals).find(item => item.goalId === payload.goalId);
              if (!fresh || current?.core?.ready !== true || current.lifecycle === 'stopping') return;
              if (!stop && !['idle', 'busy', 'waiting'].includes(current.state)) return;
              if (!create && (!goal || goal.version !== payload.expectedVersion || coreSelection.current.id !== goal.goalId || goal.cancelled === true || coreGoalComplete(goal))) return;
              if (action === 'core.resume' && (goal.authorized !== true || goal.paused !== true || Date.parse(goal.expiresAt) <= Date.now()
                || ['pending', 'unknown'].includes(goal.nativeCommand?.status))) return;
              if (create) { commandInFlight = true; setCommand(action); } else { coreControlInFlight = true; setCoreControl(action); }
              setCoreError(''); setCoreNotice('');
              const instanceId = current.instanceId, selectionRevision = coreSelection.current.revision, draftRevision = coreDraft.current.revision;
              const controller = new AbortController(); writes.add(controller);
              const timeout = setTimeout(() => controller.abort(), 70000); deadlines.add(timeout);
              try {
                const result = await api('commands', { action, payload, signal: controller.signal }), returned = result?.goal;
                if (!alive || disposed) return;
                if (!returned || typeof returned.goalId !== 'string' || !returned.goalId.trim() || !Number.isSafeInteger(returned.version) || returned.version < 1
                  || !['authorized', 'paused', 'cancelled'].every(key => typeof returned[key] === 'boolean')) throw new Error(t('coreUnconfirmed'));
                const latest = guard.snapshot;
                if (!guard.fresh || latest?.instanceId !== instanceId || selectionRevision !== coreSelection.current.revision
                  || (create && draftRevision !== coreDraft.current.revision)) throw new Error(t('coreChanged'));
                if (create) {
                  const delivered = arr(returned.deliverables);
                  if ((result.duplicate !== undefined && typeof result.duplicate !== 'boolean') || returned.requestId !== payload.requestId || returned.objective !== payload.objective
                    || returned.expiresAt !== payload.expiresAt || returned.maxEvaluations !== payload.maxEvaluations
                    || !['tokens', 'calls', 'effects'].every(key => returned.budget?.[key] === payload.budget[key]) || delivered.length !== payload.deliverables.length
                    || payload.deliverables.some(note => { const actual = delivered.find(item => item.id === note.id); return !actual || actual.title !== note.title
                      || actual.bodyBytes !== new TextEncoder().encode(note.content).length || JSON.stringify(arr(actual.dependsOn).slice().sort()) !== JSON.stringify(arr(note.dependsOn).slice().sort()); })) throw new Error(t('coreUnconfirmed'));
                  chooseCoreGoal(returned.goalId); setCoreNotice(t(result.duplicate ? 'coreDuplicate' : 'coreAccepted'));
                } else {
                  const observed = arr(latest.core?.goals).find(item => item.goalId === payload.goalId);
                  // A stop is persisted before its native call returns. The GET
                  // may already show this receipt's version; a different newer
                  // revision must not be overwritten by a late response.
                  if (!observed || ![payload.expectedVersion, returned.version].includes(observed.version)) throw new Error(t('coreChanged'));
                  if (returned.goalId !== payload.goalId || returned.version < payload.expectedVersion
                    || (action === 'core.pause' && returned.paused !== true) || (action === 'core.cancel' && returned.cancelled !== true)
                    || (action === 'core.resume' && (returned.paused !== false || returned.cancelled !== false))) throw new Error(t('coreUnconfirmed'));
                  setCoreNotice(t('coreControlAccepted'));
                }
                await refresh(true);
              } catch (error) {
                if (alive && !disposed) { setCoreError(controller.signal.aborted ? t('coreUnconfirmed') : error.message || t('coreUnconfirmed')); await refresh(true); }
              } finally {
                clearTimeout(timeout); deadlines.delete(timeout); writes.delete(controller);
                if (create) commandInFlight = false; else coreControlInFlight = false;
                if (alive && !disposed) { if (create) setCommand(''); else setCoreControl(''); }
              }
            }
            async function issueLab(action, payload, expected = {}) {
              const connect = action === 'lab.connect', stop = action === 'lab.pause' || action === 'lab.disconnect';
              const attach = connect && expected.attach === true;
              if (!alive || disposed || labControlInFlight || controlInFlight || (!stop && (commandInFlight || withdrawalInFlight || coreControlInFlight))) return;
              const guard = memoryGuard.current, current = guard.snapshot;
              const fresh = guard.fresh && Number.isFinite(Date.parse(current?.observedAt)) && Date.now() - Date.parse(current.observedAt) <= 30000;
              const connection = arr(current?.lab?.connections).find(item => item.connectionId === (attach ? expected.connectionId : payload.connectionId));
              const send = arr(connection?.sends).find(item => item.sendId === payload.sendId);
              if (!fresh || current?.lab?.ready !== true || current.lifecycle === 'stopping') return;
              if (connect && !attach && !['idle', 'busy', 'waiting'].includes(current.state)) return;
              if (attach && (!labIntentMatches(connection, payload) || connection.live !== false || connection.version !== expected.version || labSelection.current.id !== connection.connectionId)) return;
              if (!connect && (!labConnectionValid(connection) || connection.version !== payload.expectedVersion || labSelection.current.id !== connection.connectionId)) return;
              if (stop && (connection.status === 'disconnected' || (action === 'lab.pause' && connection.status === 'paused'))) return;
              if (action === 'lab.reconcile' && !labCanReconcile(current, connection, send)) return;
              if (stop) { labControlInFlight = true; setLabControl(action); } else { commandInFlight = true; setCommand(action); }
              setLabError(''); setLabNotice('');
              const instanceId = current.instanceId, selectionRevision = labSelection.current.revision, draftRevision = labDraft.current.revision;
              const originalSend = send && { sendId: send.sendId, channelId: send.channelId, draftOperationId: send.draftOperationId, bodyHash: send.bodyHash };
              const controller = new AbortController(); writes.add(controller);
              const timeout = setTimeout(() => controller.abort(), 70000); deadlines.add(timeout);
              let changed = false;
              try {
                const result = await api('commands', { action, payload, signal: controller.signal });
                if (!alive || disposed) return;
                const latest = guard.snapshot;
                changed = !guard.fresh || latest?.instanceId !== instanceId || selectionRevision !== labSelection.current.revision || (connect && !attach && draftRevision !== labDraft.current.revision);
                if (changed) throw new Error();
                if (connect) {
                  const returned = result?.connection;
                  if (!labConnectionValid(returned) || (result.duplicate !== undefined && typeof result.duplicate !== 'boolean') || returned.requestId !== payload.requestId || returned.runId !== payload.runId || returned.expiresAt !== payload.expiresAt
                    || !['tokens', 'calls', 'effects'].every(key => returned.budget?.[key] === payload.budget[key])
                    || JSON.stringify(returned.channels.map(channel => channel.channelId).sort()) !== JSON.stringify([...payload.channelIds].sort())) throw new Error();
                  if (attach) {
                    const observed = arr(latest.lab?.connections).find(item => item.connectionId === expected.connectionId);
                    changed = !observed || ![expected.version, returned.version].includes(observed.version) || !labIntentMatches(observed, payload);
                    if (changed) throw new Error();
                    if (result.duplicate !== true || returned.connectionId !== expected.connectionId || returned.version < expected.version || !labIntentMatches(returned, payload) || returned.live !== true) throw new Error();
                    setLabNotice(t('labAttached'));
                  } else {
                    // A confirmed connection permits a later explicit new grant;
                    // an uncertain request keeps its original identity for lookup.
                    labDraft.current.payload = null;
                    chooseLabConnection(returned.connectionId); setLabNotice(t('labAccepted'));
                  }
                } else {
                  const observed = arr(latest.lab?.connections).find(item => item.connectionId === payload.connectionId);
                  const returned = result?.connection;
                  if (!labConnectionValid(returned) || returned.connectionId !== payload.connectionId || returned.version < payload.expectedVersion) throw new Error();
                  changed = !observed || ![payload.expectedVersion, returned.version].includes(observed.version);
                  if (changed) throw new Error();
                  if (stop) {
                    if (returned.status !== (action === 'lab.pause' ? 'paused' : 'disconnected')) throw new Error();
                    setLabNotice(t('labControlAccepted'));
                  } else {
                    const actual = arr(returned.sends).find(item => item.sendId === payload.sendId);
                    const latestSend = arr(observed.sends).find(item => item.sendId === payload.sendId);
                    if (!actual || !latestSend || !['sendId', 'channelId', 'draftOperationId', 'bodyHash'].every(key => actual[key] === originalSend[key] && latestSend[key] === originalSend[key])
                      || !['unknown', 'succeeded'].includes(actual.status)) throw new Error();
                    setLabNotice(t('labReconcileAccepted'));
                  }
                }
                await refresh(true);
              } catch {
                // Lab failures may originate from credential-bearing transports.
                // Never render raw error or response strings in this request lane.
                if (alive && !disposed) { setLabError(t(changed ? 'labChanged' : 'labUnconfirmed')); await refresh(true); }
              } finally {
                clearTimeout(timeout); deadlines.delete(timeout); writes.delete(controller);
                if (stop) labControlInFlight = false; else commandInFlight = false;
                if (alive && !disposed) { if (stop) setLabControl(''); else setCommand(''); }
              }
            }
            operations.current = { refresh: () => refresh(true), command: issue, memory: issueMemory, semantic: issueSemantic, core: issueCore, lab: issueLab };
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
              memoryGuard.current.fresh = false; memoryGuard.current.body = null; memoryGuard.current.revision++;
              document.removeEventListener('visibilitychange', onVisibility);
              operations.current = { refresh: () => {}, command: () => {}, memory: () => {}, semantic: () => {}, core: () => {}, lab: () => {} };
              panelDisposers.delete(cleanup);
            };
            panelDisposers.add(cleanup);
            return cleanup;
          }, []);
          const observedMs = snapshot ? Date.parse(snapshot.observedAt) : NaN;
          const aged = Boolean(snapshot && (!Number.isFinite(observedMs) || clock - observedMs > 30000));
          const stale = Boolean(readError || aged);
          const state = snapshot?.state || 'unknown';
          const canCommand = Boolean(snapshot && !stale && snapshot.lifecycle !== 'stopping' && !command && !controlCommand && !memoryWithdrawing && !coreControl && !labControl);
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
          const memoryConfigured = snapshot?.memory?.configured === true, memoryReady = memoryConfigured && snapshot?.memory?.ready === true;
          const semanticStatus = snapshot?.memory?.backend?.semantic;
          const semanticAvailable = memoryReady && snapshot?.memory?.semanticConfigured === true && semanticStatus?.profileCompatible === true && ['unverified', 'ready'].includes(semanticStatus.state);
          const memoryEntries = arr(snapshot?.memory?.entries), memoryEntry = memoryEntries.find(item => item?.operationId === memorySelected);
          const memoryBodyVisible = memoryBody && memoryBody.operationId === memorySelected && memoryBody.instanceId === snapshot?.instanceId
            && memoryBody.version === memoryEntry?.version && !stale && memoryCanRead(memorySelected);
          useEffect(() => {
            if (stale || tab !== 'memory' || state === 'paused' || !memoryReady) clearMemoryBody();
          }, [stale, tab, state, memoryReady]);
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
          function coreContent() {
            const projection = snapshot.core, goals = arr(projection?.goals), connected = projection && Array.isArray(projection.goals);
            const goal = goals.find(item => item.goalId === selectedCoreGoal), ready = projection?.ready === true;
            const bytes = value => new TextEncoder().encode(value).length;
            const notes = coreNotes.map(note => ({ id: note.id.trim(), title: note.title.trim(), content: note.content,
              dependsOn: note.dependencies.trim().split(/[\s,]+/).filter(Boolean) }));
            const ids = notes.map(note => note.id), budget = { tokens: Number(coreBudget.tokens), calls: Number(coreBudget.calls), effects: Number(coreBudget.effects) };
            const maxEvaluations = Number(coreBudget.maxEvaluations), objective = coreObjective.trim();
            const acyclic = () => {
              const visited = new Set(), visiting = new Set();
              const visit = id => { if (visiting.has(id)) return false; if (visited.has(id)) return true; visiting.add(id);
                if (!arr(notes.find(note => note.id === id)?.dependsOn).every(visit)) return false; visiting.delete(id); visited.add(id); return true; };
              return ids.every(visit);
            };
            const formValid = objective.length > 0 && objective.length <= 4000 && !objective.includes('\0') && objective.isWellFormed() && notes.length >= 1 && notes.length <= 3
              && new Set(ids).size === ids.length && notes.every(note => /^[A-Za-z0-9_-]{1,80}$/.test(note.id) && note.title.length > 0 && note.title.length <= 160
                && !note.title.includes('\0') && note.title.isWellFormed() && note.content.trim().length > 0 && !note.content.includes('\0') && note.content.isWellFormed() && bytes(note.content) <= 1024
                && arr(note.dependsOn).every(id => ids.includes(id) && id !== note.id) && new Set(arr(note.dependsOn)).size === arr(note.dependsOn).length)
              && acyclic() && Object.entries(budget).every(([key, value]) => Number.isSafeInteger(value) && value > 0 && value <= (key === 'tokens' ? 100000000 : 1000))
              && Number.isSafeInteger(maxEvaluations) && maxEvaluations >= 1 && maxEvaluations <= 100;
            const expiredDraft = coreDraft.current.payload && Date.parse(coreDraft.current.payload.expiresAt) <= clock;
            const canCreate = ready && canStartCommand && ['idle', 'busy', 'waiting'].includes(state) && formValid && !expiredDraft;
            const canStop = ready && !stale && snapshot.lifecycle !== 'stopping' && !coreControl && !controlCommand && goal && goal.cancelled === false && !coreGoalComplete(goal);
            const canResume = canStop && canStartCommand && ['idle', 'busy', 'waiting'].includes(state) && goal.authorized === true && goal.paused === true
              && Number.isFinite(Date.parse(goal.expiresAt)) && Date.parse(goal.expiresAt) > clock && !['pending', 'unknown'].includes(goal.nativeCommand?.status);
            const status = item => coreGoalComplete(item) ? 'complete' : item.cancelled === true ? 'cancelled' : item.authorized === false ? 'unapproved' : item.paused === true ? 'paused'
              : Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) <= clock ? 'expired' : item.authorized === true ? 'authorized' : 'unknown';
            const editNote = (index, key, value) => { changeCoreDraft(); setCoreNotes(current => current.map((note, at) => at === index ? { ...note, [key]: value } : note)); };
            const field = (name, value, onChange, options = {}) => h('label', { className: 'syr-select-label' }, h('span', null, name), h('input', {
              className: 'syr-select', 'aria-label': name, value, disabled: Boolean(command || coreControl || controlCommand), onChange: event => onChange(event.target.value), ...options }));
            const budgetFields = value => `${numeric(value?.tokens)} / ${numeric(value?.calls)} / ${numeric(value?.effects)}`;
            return h('div', { className: 'syr-stack' },
              h('section', { 'data-testid': 'core-state' }, h('div', { className: 'syr-system-heading' }, h(Title, { count: connected ? goals.length : undefined }, t('core')), h('p', null, t('coreHint'))),
                !connected ? h(Empty, null, t('coreUnavailable')) : !ready ? h('p', { className: 'syr-alert' }, `${t('coreNotReady')} ${text(projection.errorCode)}`) : h('p', { className: 'syr-small syr-muted' }, t('coreScope')),
                projection?.pump && h(Facts, { rows: [['corePump', label(projection.pump.state)], ['phase', text(projection.pump.phase) || t('unknownValue')], ['checked', dateTime(projection.pump.lastScanAt, locale)]] })),
              h('section', { className: 'syr-box syr-memory-form', 'data-testid': 'core-form', 'aria-label': t('coreCreateTitle') }, h(Title, null, t('coreCreateTitle')),
                h('p', { className: 'syr-small syr-muted' }, t('coreCreateHint')),
                h('label', { className: 'syr-select-label' }, h('span', null, t('coreObjective')), h('textarea', { className: 'syr-textarea', 'aria-label': t('coreObjective'), value: coreObjective,
                  maxLength: 4000, disabled: Boolean(command || coreControl || controlCommand), onChange: event => { changeCoreDraft(); setCoreObjective(event.target.value); } })),
                ...coreNotes.map((note, index) => h('section', { className: 'syr-task-result', key: index }, h('h3', null, t('coreNoteNumber', { number: index + 1 })),
                  field(t('coreNoteId', { number: index + 1 }), note.id, value => editNote(index, 'id', value), { maxLength: 80 }),
                  field(t('coreNoteTitle', { number: index + 1 }), note.title, value => editNote(index, 'title', value), { maxLength: 160 }),
                  h('label', { className: 'syr-select-label' }, h('span', null, t('coreNoteBody', { number: index + 1 })), h('textarea', { className: 'syr-textarea', 'aria-label': t('coreNoteBody', { number: index + 1 }), value: note.content,
                    maxLength: 1024, disabled: Boolean(command || coreControl || controlCommand), onChange: event => editNote(index, 'content', event.target.value) })),
                  field(t('coreNoteDepends', { number: index + 1 }), note.dependencies, value => editNote(index, 'dependencies', value), { maxLength: 200 }),
                  coreNotes.length > 1 && h(Button, { disabled: Boolean(command || coreControl || controlCommand), onClick: () => { changeCoreDraft(); setCoreNotes(current => current.filter((_, at) => at !== index)); } }, t('coreRemoveNote')))),
                h('p', { className: 'syr-small syr-muted' }, t('coreDependenciesHint')),
                h(Button, { disabled: coreNotes.length >= 3 || Boolean(command || coreControl || controlCommand), onClick: () => { changeCoreDraft(); setCoreNotes(current => [...current, { id: `note-${current.length + 1}`, title: '', content: '', dependencies: '' }]); } }, t('coreAddNote')),
                h('div', { className: 'syr-columns syr-section-gap' }, ...['tokens', 'calls', 'effects', 'maxEvaluations'].map(key => field(t(`coreLimit_${key}`), coreBudget[key], value => { changeCoreDraft(); setCoreBudget(current => ({ ...current, [key]: value })); }, { type: 'number', min: 1, step: 1 }))),
                h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('coreBudgetHint')),
                h('label', { className: 'syr-select-label' }, h('span', null, t('coreLifetime')), h('select', { className: 'syr-select', 'aria-label': t('coreLifetime'), value: coreLifetime, disabled: Boolean(command || coreControl || controlCommand),
                  onChange: event => { changeCoreDraft(); setCoreLifetime(event.target.value); } }, h('option', { value: '30' }, t('core30Minutes')), h('option', { value: '60' }, t('core1Hour')))),
                !formValid && (coreObjective || coreNotes.some(note => note.title || note.content || note.dependencies)) && h('p', { className: 'syr-small syr-muted' }, t('coreInvalidForm')),
                expiredDraft && h('p', { className: 'syr-small syr-muted' }, t('coreExpiredDraft')),
                h('div', { className: 'syr-actions syr-section-gap' }, h(Button, { disabled: !canCreate, onClick: () => {
                  if (!canCreate) return; coreDraft.current.payload ||= { requestId: `core-${crypto.randomUUID()}`, objective, deliverables: notes, budget,
                    expiresAt: new Date(Date.now() + Number(coreLifetime) * 60000).toISOString(), maxEvaluations };
                  void operations.current.core('core.create', coreDraft.current.payload);
                } }, t('coreCreate')))),
              coreError && h('div', { className: 'syr-alert', role: 'alert', 'data-testid': 'core-error' }, coreError),
              coreNotice && h('p', { className: 'syr-feedback', role: 'status', 'data-testid': 'core-notice' }, coreNotice),
              coreControl && h('p', { className: 'syr-feedback', role: 'status' }, t('controlPending')),
              h('section', null, h(Title, null, t('coreGoals')), !connected ? h(Empty, null, t('coreUnavailable')) : !goals.length ? h(Empty, null, t('coreNoGoals')) : h('div', { className: 'syr-task-layout' },
                h('div', { className: 'syr-session-list', 'data-testid': 'core-list' }, ...goals.map(item => h('button', { type: 'button', key: item.goalId, className: 'syr-session-button', 'aria-label': t('coreView', { id: item.goalId }),
                  'aria-pressed': item.goalId === selectedCoreGoal, onClick: () => chooseCoreGoal(item.goalId) }, h('span', { className: 'syr-task-label' }, text(item.objective)), h('span', { className: 'syr-id' }, text(item.goalId)), h(Status, { value: status(item) })))),
                goal ? h('section', { className: 'syr-box syr-task-detail', 'data-testid': 'core-detail' }, h(Title, null, t('coreDetails')),
                  h('p', { className: 'syr-break' }, text(goal.objective)), h(Facts, { rows: [['goalId', goal.goalId, true], ['recordVersion', numeric(goal.version)], ['coreAuthorization', label(status(goal))], ['coreExpiresAt', dateTime(goal.expiresAt, locale)],
                    ['coreEvaluations', `${numeric(goal.evaluations)} / ${numeric(goal.maxEvaluations)}`], ['coreActiveEvaluation', goal.activeEvaluationId, true], ['coreNextEligible', dateTime(goal.nextEligibleAt, locale)]] }),
                  h('div', { className: 'syr-actions syr-section-gap' }, h(Button, { disabled: !canStop || goal.paused === true, onClick: () => void operations.current.core('core.pause', { goalId: goal.goalId, expectedVersion: goal.version }) }, t('corePause')),
                    h(Button, { disabled: !canResume, onClick: () => void operations.current.core('core.resume', { goalId: goal.goalId, expectedVersion: goal.version }) }, t('coreResume')),
                    h(Button, { disabled: !canStop, onClick: () => void operations.current.core('core.cancel', { goalId: goal.goalId, expectedVersion: goal.version }) }, t('coreCancel'))),
                  h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('coreControlHint')),
                  h('section', { className: 'syr-task-result', 'data-testid': 'core-native' }, h(Title, null, t('coreNative')), h(Facts, { rows: [['nativeGoalId', goal.native?.goalRef?.id, true], ['recordVersion', numeric(goal.native?.goalRef?.revision)],
                    ['sessionId', goal.native?.sessionId, true], ['nativePhase', goal.native?.phase ? label(goal.native.phase) : t('unknownValue')], ['observed', dateTime(goal.native?.observedAt, locale)]] }), h('p', { className: 'syr-small syr-muted' }, t('coreNativeHint'))),
                  h('section', { className: 'syr-task-result', 'data-testid': 'core-native-command' }, h(Title, null, t('coreNativeCommand')), h(Facts, { rows: [['coreNativeCommandId', goal.nativeCommand?.commandId, true],
                    ['coreNativeCommandOperation', ['create', 'update', 'pause', 'resume', 'complete'].includes(goal.nativeCommand?.operation) ? t(`coreNativeOperation_${goal.nativeCommand.operation}`) : t('unknownValue')],
                    ['status', goal.nativeCommand?.status ? label(goal.nativeCommand.status) : t('unknownValue')]] }), ['pending', 'unknown'].includes(goal.nativeCommand?.status) && h('p', { className: 'syr-alert' }, t('coreNativeUnconfirmed'))),
                  h('section', { className: 'syr-task-result', 'data-testid': 'core-budget' }, h(Title, null, t('coreBudget')), h('p', { className: 'syr-small syr-muted' }, t('coreBudgetAxes')),
                    h(Facts, { rows: [['coreBudgetLimit', budgetFields(goal.balance?.limits ?? goal.budget)], ['coreBudgetSpent', budgetFields(goal.balance?.spent)], ['coreBudgetHeld', budgetFields(goal.balance?.held)], ['coreBudgetAvailable', budgetFields(goal.balance?.available)]] }), h('p', { className: 'syr-small syr-muted' }, t('coreBudgetHint'))),
                  h('section', { className: 'syr-task-result' }, h(Title, null, t('coreApprovedNotes')), ...arr(goal.deliverables).map(note => h('div', { className: 'syr-entry', key: note.id }, h('h3', null, text(note.title)),
                    h(Facts, { rows: [['coreDeliverable', note.id, true], ['memoryBytes', numeric(note.bodyBytes)], ['coreDepends', arr(note.dependsOn).join(', ') || t('coreNone')]] })))),
                  h('section', { className: 'syr-task-result', 'data-testid': 'core-accepted-tasks' }, h(Title, null, t('coreAcceptedTasks')), !arr(goal.taskRefs).length ? h(Empty, null, t('coreNoAcceptedTasks')) : arr(goal.taskRefs).map(ref => {
                    const linkedTask = tasks.find(item => item.taskId === ref.taskId && item.goalId === goal.goalId);
                    return h('div', { className: 'syr-entry', key: ref.taskId }, h('p', null, text(ref.deliverableId)), h(Button, { onClick: () => { setSelectedTask(ref.taskId); setTab('tasks'); } }, text(ref.taskId)), h('p', null, label(linkedTask?.state || 'unknown')));
                  })),
                  h('section', { className: 'syr-task-result', 'data-testid': 'core-evaluations' }, h(Title, null, t('coreDecisions')), !arr(goal.evaluationsLog).length ? h(Empty, null, t('coreNoDecisions')) : arr(goal.evaluationsLog).map(evaluation => h('article', { className: 'syr-entry', key: evaluation.evaluationId },
                    h('h3', { className: 'syr-code' }, text(evaluation.evaluationId)), h(Status, { value: evaluation.status }), h('p', { className: 'syr-small syr-muted' }, t('coreTriggers')), h(Evidence, { values: evaluation.triggerRefs }),
                    evaluation.candidate && h('section', { className: 'syr-section-gap' }, h('h3', null, t('coreCandidate')), h('p', null, text(evaluation.candidate.kind)), h('p', null, text(evaluation.candidate.reason)),
                      evaluation.candidate.deliverableId && h('p', { className: 'syr-code' }, text(evaluation.candidate.deliverableId)), h('p', { className: 'syr-small syr-muted' }, t('coreCandidateHint'))),
                    h(Facts, { rows: [['coreDecisionReceipt', evaluation.receipt ? label(evaluation.receipt.status) : t('unknownValue')], ['coreReasonCode', evaluation.receipt?.reasonCode ?? evaluation.reasonCode, true], ['taskId', evaluation.receipt?.taskId, true],
                      ['coreObservedTokens', numeric(evaluation.usage?.tokens)], ['calls', numeric(evaluation.usage?.calls)], ['embeddingUsageCompleteness', t(evaluation.usage?.complete === true ? 'usageComplete' : 'usageIncomplete')], ['sessionId', evaluation.sessionId, true]] }),
                    evaluation.status === 'unknown' && h('p', { className: 'syr-alert' }, t('coreUnknown')))))) : h(Empty, null, t(selectedCoreGoal ? 'coreNotInSnapshot' : 'coreSelect')))));
          }
          function labContent() {
            const projection = snapshot.lab, connections = arr(projection?.connections).filter(labConnectionValid);
            const connection = connections.find(item => item.connectionId === selectedLabConnection), ready = projection?.ready === true;
            const runId = labRunId.trim(), channelIds = labChannels.trim().split(/[\s,]+/).filter(Boolean);
            const budget = Object.fromEntries(['tokens', 'calls', 'effects'].map(key => [key, Number(labBudget[key])]));
            const formValid = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(runId) && /^[A-Za-z0-9_-]{43}$/.test(labToken)
              && channelIds.length >= 1 && channelIds.length <= 20 && new Set(channelIds).size === channelIds.length && channelIds.every(id => /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id))
              && Object.entries(budget).every(([key, value]) => Number.isSafeInteger(value) && value > 0 && value <= (key === 'tokens' ? 100000000 : 1000));
            const expiredDraft = labDraft.current.payload && Date.parse(labDraft.current.payload.expiresAt) <= clock;
            const canConnect = ready && canStartCommand && ['idle', 'busy', 'waiting'].includes(state) && formValid && !expiredDraft;
            const canAttach = ready && canCommand && connection?.live === false && labHistoricalIntentValid(connection) && /^[A-Za-z0-9_-]{43}$/.test(labToken);
            const canStop = ready && !stale && snapshot.lifecycle !== 'stopping' && !labControl && !controlCommand && connection && connection.status !== 'disconnected';
            const disabled = Boolean(command || labControl || controlCommand);
            const field = (key, value, onChange, options = {}) => h('label', { className: 'syr-select-label' }, h('span', null, t(key)), h('input', {
              className: 'syr-select', 'aria-label': t(key), value, disabled, autoComplete: 'off', onChange: event => onChange(event.target.value), ...options }));
            const budgetFields = value => `${numeric(value?.tokens)} / ${numeric(value?.calls)} / ${numeric(value?.effects)}`;
            return h('div', { className: 'syr-stack' },
              h('section', { 'data-testid': 'lab-state' }, h('div', { className: 'syr-system-heading' }, h(Title, null, t('lab')), h('p', null, t('labHint'))),
                !projection ? h(Empty, null, t('labUnavailable')) : !ready ? h('p', { className: 'syr-alert' }, t('labNotReady')) : h('p', { className: 'syr-small syr-muted' }, t('labScope')),
                projection?.pump && h(Facts, { rows: [['labPump', label(projection.pump.state)], ['labActiveReplies', numeric(projection.pump.activeReplies)], ['checked', dateTime(projection.pump.lastPollAt, locale)]] }),
                ['LAB_GROUP_TOO_LARGE', 'LAB_INPUT_BACKPRESSURE'].includes(projection?.pump?.errorCode) && h('p', { className: 'syr-alert', role: 'status', 'data-testid': 'lab-input-limit' },
                  t(projection.pump.errorCode === 'LAB_GROUP_TOO_LARGE' ? 'labGroupTooLarge' : 'labInputBackpressure'))),
              h('section', { className: 'syr-box syr-memory-form', 'data-testid': 'lab-form', 'aria-label': t('labConnectTitle') }, h(Title, null, t('labConnectTitle')), h('p', { className: 'syr-small syr-muted' }, t('labConnectHint')),
                field('labRunId', labRunId, value => { changeLabDraft(); setLabRunId(value); }, { maxLength: 160 }),
                field('labTargetToken', labToken, setLabToken, { type: 'password', maxLength: 43, autoComplete: 'new-password', spellCheck: false }),
                h('p', { className: 'syr-small syr-muted' }, t('labTokenHint')),
                field('labChannelIds', labChannels, value => { changeLabDraft(); setLabChannels(value); }, { maxLength: 1620 }), h('p', { className: 'syr-small syr-muted' }, t('labChannelHint')),
                h('div', { className: 'syr-columns syr-section-gap' }, ...['tokens', 'calls', 'effects'].map(key => field(`labLimit_${key}`, labBudget[key], value => { changeLabDraft(); setLabBudget(current => ({ ...current, [key]: value })); }, { type: 'number', min: 1, step: 1 }))),
                h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('labBudgetHint')),
                h('label', { className: 'syr-select-label' }, h('span', null, t('coreLifetime')), h('select', { className: 'syr-select', 'aria-label': t('coreLifetime'), value: labLifetime, disabled,
                  onChange: event => { changeLabDraft(); setLabLifetime(event.target.value); } }, h('option', { value: '30' }, t('core30Minutes')), h('option', { value: '60' }, t('core1Hour')))),
                !formValid && (labRunId || labChannels) && h('p', { className: 'syr-small syr-muted' }, t('labInvalidForm')),
                expiredDraft && h('p', { className: 'syr-small syr-muted' }, t('labExpiredDraft')),
                h('div', { className: 'syr-actions' }, h(Button, { disabled: !canConnect, onClick: () => {
                  if (!canConnect) return;
                  labDraft.current.payload ||= { requestId: `lab-${crypto.randomUUID()}`, runId, channelIds, budget, expiresAt: new Date(Date.now() + Number(labLifetime) * 60000).toISOString() };
                  const targetToken = labToken; setLabToken('');
                  void operations.current.lab('lab.connect', { ...labDraft.current.payload, targetToken });
                } }, t(command === 'lab.connect' ? 'labConnecting' : 'labConnect')))),
              labError && h('div', { className: 'syr-alert', role: 'alert', 'data-testid': 'lab-error' }, labError),
              labNotice && h('div', { className: 'syr-feedback', role: 'status', 'data-testid': 'lab-notice' }, labNotice),
              h('section', null, h(Title, { count: connections.length }, t('labConnections')), !connections.length && h(Empty, null, t('labNoConnections')),
                h('div', { className: 'syr-task-layout' }, h('div', { className: 'syr-session-list', 'data-testid': 'lab-list' }, ...connections.map(item => h('button', { type: 'button', key: item.connectionId, className: 'syr-session-button',
                  'aria-label': t('labView', { id: item.connectionId }), 'aria-pressed': selectedLabConnection === item.connectionId, onClick: () => chooseLabConnection(item.connectionId) },
                  h('span', { className: 'syr-row syr-between syr-task-list-row' }, h('strong', { className: 'syr-break' }, item.runId), h(Status, { value: item.status })), h('span', { className: 'syr-id' }, item.connectionId)))),
                  connection ? h('section', { className: 'syr-box syr-task-detail', 'aria-label': t('labDetails'), 'data-testid': 'lab-detail' },
                    h('div', { className: 'syr-section-title' }, h('h2', null, t('labDetails')), h(Button, { icon: 'close', className: 'syr-btn syr-subtle', 'aria-label': t('close'), onClick: () => chooseLabConnection(null) })),
                    h(Facts, { rows: [['labConnectionId', connection.connectionId, true], ['labRunId', connection.runId, true], ['labConnectionState', label(connection.status)], ['labTransport', label(connection.live === true ? 'connected' : connection.live === false ? 'not_attached' : 'unknown')], ['recordVersion', numeric(connection.version)], ['coreExpiresAt', dateTime(connection.expiresAt, locale)]] }),
                    h('section', { className: 'syr-task-result', 'data-testid': 'lab-attach' }, h(Button, { disabled: !canAttach, onClick: () => {
                      if (!canAttach) return;
                      const targetToken = labToken; setLabToken('');
                      void operations.current.lab('lab.connect', { requestId: connection.requestId, runId: connection.runId, channelIds: connection.channels.map(channel => channel.channelId),
                        budget: { tokens: connection.budget.tokens, calls: connection.budget.calls, effects: connection.budget.effects }, expiresAt: connection.expiresAt, targetToken },
                        { attach: true, connectionId: connection.connectionId, version: connection.version });
                    } }, t('labAttach')), h('p', { className: 'syr-small syr-muted' }, t('labAttachHint'))),
                    h('div', { className: 'syr-actions syr-section-gap' }, ...['pause', 'disconnect'].map(action => h(Button, { key: action, disabled: !canStop || (action === 'pause' && connection.status === 'paused'),
                      onClick: () => void operations.current.lab(`lab.${action}`, { connectionId: connection.connectionId, expectedVersion: connection.version }) }, t(action === 'pause' ? 'labPause' : 'labDisconnect')))),
                    h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('labStopHint')),
                    h('section', { className: 'syr-task-result', 'data-testid': 'lab-budget' }, h(Title, null, t('coreBudget')), h('p', { className: 'syr-small syr-muted' }, t('labBudgetAxes')),
                      h(Facts, { rows: [['coreBudgetLimit', budgetFields(connection.balance?.limits ?? connection.budget)], ['coreBudgetSpent', budgetFields(connection.balance?.spent)], ['coreBudgetHeld', budgetFields(connection.balance?.held)], ['coreBudgetAvailable', budgetFields(connection.balance?.available)]] }), h('p', { className: 'syr-small syr-muted' }, t('labBudgetHint'))),
                    h('section', { className: 'syr-task-result', 'data-testid': 'lab-channels' }, h(Title, null, t('labChannels')), ...connection.channels.map(channel => h('article', { className: 'syr-entry', key: channel.channelId },
                      h(Facts, { rows: [['labChannelId', channel.channelId, true], ['labChannelKind', ['group', 'direct'].includes(channel.kind) ? t(`labKind_${channel.kind}`) : t('unknownValue')],
                        ['conversationId', channel.conversationId, true], ['labInputVersion', numeric(channel.inputVersion)], ['labInputEvent', channel.latestInput?.eventId, true], ['labInputSeq', numeric(channel.latestInput?.seq)],
                        ['labPendingInputs', numeric(channel.pendingCount)]] })))),
                    h('section', { className: 'syr-task-result', 'data-testid': 'lab-replies' }, h(Title, null, t('labReplies')), h('p', { className: 'syr-small syr-muted' }, t('labReplyHint')),
                      !arr(connection.replies).length ? h(Empty, null, t('labNoReplies')) : arr(connection.replies).map(reply => h('article', { className: 'syr-entry', key: reply.replyId }, h(Facts, { rows: [
                        ['labReplyId', reply.replyId, true], ['labChannelId', reply.channelId, true], ['labReplyStage', ['claimed', 'accounted', 'unknown', 'sent'].includes(reply.status) ? t(`labReply_${reply.status}`) : t('unknownValue')], ['labInputEvent', reply.anchorEventId, true]] })))),
                    h('section', { className: 'syr-task-result', 'data-testid': 'lab-sends' }, h(Title, null, t('labSends')), h('p', { className: 'syr-small syr-muted' }, t('labReconcileHint')),
                      !arr(connection.sends).length ? h(Empty, null, t('labNoSends')) : arr(connection.sends).map(send => h('article', { className: 'syr-entry', key: send.sendId, 'data-testid': 'lab-send' },
                        h(Facts, { rows: [['labSendId', send.sendId, true], ['labChannelId', send.channelId, true], ['labDraftId', send.draftOperationId, true], ['labEffectState', label(send.status)],
                          ['labDelivery', t(labDelivered(send) ? 'labDelivered' : send.status === 'unknown' ? 'labDeliveryUnknown' : 'labNotDelivered')], ['labDeliveryEvent', send.observation?.eventId, true]] }),
                        send.status === 'unknown' && h(React.Fragment, null, h(Button, { disabled: !canCommand || !labCanReconcile(snapshot, connection, send),
                          onClick: () => void operations.current.lab('lab.reconcile', { connectionId: connection.connectionId, sendId: send.sendId, expectedVersion: connection.version }) }, t('labReconcile')),
                          !labCanReconcile(snapshot, connection, send) && h('p', { className: 'syr-small syr-muted' }, t('labReconcileBlocked')))))))
                    : h(Empty, null, t(selectedLabConnection ? 'labNotInSnapshot' : 'labSelect')))));
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
                    onClick: () => chooseConversation({ conversationId: item.conversationId, bindingId: item.bindingId }) },
                    h('span', { className: 'syr-task-label' }, text(item.localConversationKey) || text(item.conversationId)),
                    h('span', { className: 'syr-task-caption' }, contextLabel(item)),
                    h('span', { className: 'syr-task-caption' }, `${t('contextVersion')} · ${numeric(item.contextVersion)}`), h('span', { className: 'syr-id' }, item.bindingId)))),
                  conversation ? h('section', { className: 'syr-box syr-task-detail', 'aria-label': t('conversationDetails'), 'data-testid': 'conversation-detail' },
                    h('div', { className: 'syr-section-title' }, h('h2', null, t('conversationDetails')), h(Button, { icon: 'close', className: 'syr-btn syr-subtle', 'aria-label': t('close'), onClick: () => chooseConversation(null) })),
                    h('p', { className: 'syr-notice syr-small', 'data-level': conversation.needsSync === true ? 'warning' : 'info', 'data-testid': 'conversation-load-state' }, contextLabel(conversation)),
                    h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('conversationReadOnly')),
                    contextVerificationContent(),
                    contextLoadContent(),
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
          function contextVerificationContent() {
            const hasTask = arr(conversation?.taskRefs).some(ref => typeof ref?.taskId === 'string' && Boolean(ref.taskId.trim()));
            const identityKnown = conversation?.scope === 'local-owner' && ['conversationId', 'bindingId'].every(key => typeof conversation?.[key] === 'string' && Boolean(conversation[key].trim()));
            const contextReady = snapshot.diagnostics?.contextSafety?.ready === true;
            const canVerify = canStartCommand && ['idle', 'busy', 'waiting'].includes(state) && identityKnown && hasTask && contextReady;
            const pendingHere = command === 'conversation.verifyContext' && contextAttempt?.conversationId === conversation.conversationId && contextAttempt?.bindingId === conversation.bindingId;
            const receipt = contextReceipt?.conversationId === conversation.conversationId && contextReceipt?.bindingId === conversation.bindingId && contextReceipt?.instanceId === snapshot.instanceId ? contextReceipt : null;
            const saved = snapshot.diagnostics?.contextVerification;
            const history = saved && typeof saved === 'object' && !Array.isArray(saved) && saved.conversationId === conversation.conversationId ? saved : null;
            return h('section', { className: 'syr-task-result', 'aria-label': t('contextVerifyTitle'), 'data-testid': 'context-verification' },
              h(Title, null, t('contextVerifyTitle')), h('p', { className: 'syr-small syr-muted' }, t('contextVerifyHint')), h('p', { className: 'syr-small syr-muted' }, t('contextVerifyLimits')),
              !contextReady && h('p', { className: 'syr-small syr-muted', 'data-testid': 'context-verification-readiness' }, t(snapshot.diagnostics?.contextSafety?.ready === false ? 'contextSafetyUnavailable' : 'contextSafetyMissing')),
              !hasTask && h('p', { className: 'syr-small syr-muted' }, t('contextVerifyNeedsTask')),
              h('div', { className: 'syr-section-gap' }, h(Button, { disabled: !canVerify, onClick: () => {
                if (canVerify) void operations.current.command('conversation.verifyContext', { conversationId: conversation.conversationId }, { bindingId: conversation.bindingId, instanceId: snapshot.instanceId });
              } }, t(pendingHere ? 'contextVerifying' : 'contextVerify'))),
              receipt && h('section', { className: 'syr-task-result', 'aria-label': t('contextVerifyReceipt'), 'data-testid': 'context-verification-receipt' }, h(Title, null, t('contextVerifyReceipt')),
                h('p', { className: 'syr-small' }, t('contextVerifyDone')), h('p', { className: 'syr-small syr-muted' }, t('contextVerifySnapshotOnly')),
                h('p', { className: 'syr-small syr-muted' }, t('contextAttemptedRoundsHint')),
                h('div', { className: 'syr-section-gap' }, h(Facts, { rows: [['conversationId', receipt.conversationId, true], ['replyBindingId', receipt.bindingId, true], ['sessionId', receipt.sessionId, true], ['contextAttemptedRounds', numeric(receipt.calls)], ['sameSession', t('confirmed')], ['contextDurable', t('confirmed')], ['draftsValidated', t('confirmed')], ['outboundMessage', t('notSent')]] }))),
              history && h('section', { className: 'syr-task-result', 'aria-label': t('contextVerifyHistory'), 'data-testid': 'context-verification-history' }, h(Title, null, t('contextVerifyHistory')),
                h('p', { className: 'syr-small syr-muted' }, t('contextVerifyHistoryHint')),
                h('p', { className: 'syr-small syr-muted' }, t('contextAttemptedRoundsHint')),
                h('div', { className: 'syr-section-gap' }, h(Facts, { rows: [['checked', dateTime(history.at, locale)], ['status', label(history.ok === true ? 'passed' : history.ok === false ? 'failed' : 'unknown')], ['instance', history.instanceId, true], ['contextAttemptedRounds', numeric(history.calls)], ['conversationId', history.conversationId, true], ['sessionId', history.sessionId, true], ['diagnosticMessage', typeof history.message === 'string' ? history.message : t('unknownValue')]] }))));
          }
          function memoryContent() {
            const backend = snapshot.memory?.backend, errorCode = snapshot.memory?.errorCode;
            const statusKey = !memoryConfigured ? 'memoryUnconfigured' : memoryReady ? 'memoryReady' : errorCode ? 'memoryUnavailable' : 'memoryWaiting';
            const snippetBytes = new TextEncoder().encode(memoryText.trim()).length;
            const conversationKnown = conversations.some(item => item.conversationId === memoryConversationId);
            const canSave = canStartCommand && ['idle', 'busy', 'waiting'].includes(state) && memoryReady && conversationKnown && snippetBytes > 0 && snippetBytes <= 16384;
            const readable = memoryEntry?.canRead === true && memoryEntry?.consent === 'active' && !memoryEntry?.blocked && !memoryGuard.current.revoked.has(memorySelected);
            const canRead = canStartCommand && memoryReady && readable && memoryCanRead(memorySelected);
            const canIndex = canRead && semanticAvailable;
            const canSearch = canStartCommand && semanticAvailable && conversationKnown && Boolean(memoryQuery.trim()) && memoryQuery.length <= 4096;
            const searchCurrent = memorySearch && memorySearch.instanceId === snapshot.instanceId && memorySearch.conversationId === memoryConversationId
              && memorySearch.revision === memorySearchGuard.current && !stale && state !== 'paused'
              && memorySearch.matches.every(item => memoryCanRead(item.operationId));
            const indexReceipt = memoryIndexReceipt?.operationId === memorySelected && memoryIndexReceipt?.instanceId === snapshot.instanceId ? memoryIndexReceipt : null;
            const semanticLabel = snapshot.memory?.semanticErrorCode ? 'memorySemanticUnavailable' : snapshot.memory?.semanticConfigured !== true ? 'memorySemanticDisabled' : semanticStatus?.state === 'ready' ? 'memorySemanticReady'
              : semanticStatus?.state === 'unverified' && semanticStatus.profileCompatible ? 'memorySemanticUnverified' : 'memorySemanticUnavailable';
            const canWithdraw = memoryEntryValid(memoryEntry) && memoryEntry.consent === 'active' && snapshot.lifecycle !== 'stopping' && !memoryWithdrawing;
            const consentLabel = value => t(value === 'active' ? 'memoryConsentActive' : value === 'withdrawn' ? 'memoryConsentWithdrawn' : 'unknownValue');
            return h('div', { className: 'syr-stack' },
              h('section', null, h('div', { className: 'syr-system-heading' }, h('h2', null, t('memory')), h('p', null, t('memoryHint'))),
                h('div', { className: 'syr-box', 'data-testid': 'memory-state' }, h(Title, null, t(statusKey)),
                  memoryConfigured && !memoryReady && !errorCode && h('p', { className: 'syr-small syr-muted' }, t('memoryWaitingHint')),
                  backend && h(Facts, { rows: [['status', label(backend.state)], ['backendId', text(backend.backendId), true], ['deploymentId', text(backend.deploymentId), true], ['memoryScope', text(backend.scope), true], ['memoryEmbedding', t(semanticLabel)]] }),
                  snapshot.memory?.lastSemanticOperation && h('p', { className: 'syr-small syr-muted syr-section-gap', 'data-testid': 'memory-last-semantic' },
                    `${t('memoryLastSemantic')} · ${label(snapshot.memory.lastSemanticOperation.status)}${snapshot.memory.lastSemanticOperation.outcome ? ` · ${t('memorySemanticOutcome')} ${label(snapshot.memory.lastSemanticOperation.outcome)}` : ''} · ${t('embeddingCalls')} ${numeric(snapshot.memory.lastSemanticOperation.embeddingUsage?.calls)} · ${t(snapshot.memory.lastSemanticOperation.embeddingUsage?.complete === true ? 'usageComplete' : 'usageIncomplete')}`),
                  snapshot.memory?.semanticErrorCode && h('p', { className: 'syr-small syr-code syr-section-gap' }, `${t('memorySemanticError')} · ${text(snapshot.memory.semanticErrorCode)}`),
                  errorCode && h('p', { className: 'syr-small syr-code syr-section-gap' }, `${t('errorCode')} · ${text(errorCode)}`))),
              h('section', { className: 'syr-box syr-memory-form', 'aria-label': t('memorySaveTitle'), 'data-testid': 'memory-form' }, h(Title, null, t('memorySaveTitle')),
                h('p', { className: 'syr-small syr-muted' }, t('memorySaveHint')),
                h('label', { className: 'syr-select-label' }, h('span', null, t('memoryConversation')), h('select', { className: 'syr-select', 'aria-label': t('memoryConversation'), value: memoryConversationId, disabled: Boolean(command || controlCommand || memoryWithdrawing), onChange: event => { memoryDraftId.current = null; memorySearchGuard.current++; setMemorySearch(null); setMemoryConversationId(event.target.value); } },
                  h('option', { value: '' }, t('memoryChooseConversation')), ...conversations.map(item => h('option', { key: item.bindingId, value: item.conversationId }, `${item.localConversationKey || item.conversationId} (${item.conversationId})`)))),
                !conversations.length && h('p', { className: 'syr-small syr-muted' }, t('memoryNoConversation')),
                h('label', { className: 'syr-select-label' }, h('span', null, t('memorySnippet')), h('textarea', { className: 'syr-textarea', 'aria-label': t('memorySnippet'), value: memoryText, maxLength: 20000, disabled: Boolean(command || controlCommand || memoryWithdrawing), onChange: event => { memoryDraftId.current = null; setMemoryText(event.target.value); } })),
                h('p', { className: 'syr-small syr-muted' }, t('memoryBodyLimit')),
                h('div', { className: 'syr-actions' }, h(Button, { disabled: !canSave, onClick: () => {
                  if (!canSave) return;
                  memoryDraftId.current ||= `memory-${crypto.randomUUID()}`;
                  void operations.current.memory('memory.rememberLocal', { requestId: memoryDraftId.current, conversationId: memoryConversationId, text: memoryText });
                } }, t(command === 'memory.rememberLocal' ? 'memorySaving' : 'memorySave')))),
              h('section', { className: 'syr-box syr-memory-form', 'aria-label': t('memorySearchTitle'), 'data-testid': 'memory-search' }, h(Title, null, t('memorySearchTitle')),
                h('p', { className: 'syr-small syr-muted' }, t('memorySearchHint')),
                !semanticAvailable && h('p', { className: 'syr-small syr-muted' }, t(semanticLabel)),
                h('label', { className: 'syr-select-label' }, h('span', null, t('memoryQuery')), h('input', { className: 'syr-select', 'aria-label': t('memoryQuery'), value: memoryQuery, maxLength: 4096,
                  disabled: Boolean(command || controlCommand || memoryWithdrawing), onChange: event => { memorySearchGuard.current++; setMemorySearch(null); setMemoryQuery(event.target.value); } })),
                h('div', { className: 'syr-actions' }, h(Button, { disabled: !canSearch, onClick: () => { if (canSearch) void operations.current.semantic('memory.searchLocal', { conversationId: memoryConversationId, query: memoryQuery }); } },
                  t(command === 'memory.searchLocal' ? 'memorySearching' : 'memorySearch'))),
                searchCurrent && h('section', { className: 'syr-task-result', 'data-testid': 'memory-search-result' },
                  h('p', { className: 'syr-small' }, t(memorySearch.state === 'index_required' ? 'memorySearchNeedsIndex' : memorySearch.matches.length ? 'memorySearchMatches' : 'memorySearchNoMatch')),
                  h(Facts, { rows: [['memoryEligibleCount', numeric(memorySearch.coverage.eligibleCount)], ['memoryIndexedCount', numeric(memorySearch.coverage.indexedCount)], ['memoryMissingCount', numeric(memorySearch.coverage.missingCount)],
                    ['embeddingCalls', numeric(memorySearch.embeddingCalls)], ['embeddingUsageCompleteness', t(memorySearch.usageComplete ? 'usageComplete' : 'usageIncomplete')]] }),
                  memorySearch.matches.length > 0 && h('ul', { className: 'syr-evidence' }, ...memorySearch.matches.map(item => h('li', { key: item.operationId },
                    h(Button, { onClick: () => chooseMemory(item.operationId) }, text(item.operationId)), ` · ${t('memorySimilarity')} ${numeric(item.score)}`))))),
              memoryError && h('div', { className: 'syr-alert', role: 'alert', 'data-testid': 'memory-error' }, memoryError),
              memoryNotice && h('p', { className: 'syr-feedback', role: 'status' }, memoryNotice),
              (command.startsWith('memory.') || memoryWithdrawing) && h('p', { className: 'syr-feedback', role: 'status' }, t(memoryWithdrawing ? 'memoryWithdrawing' : 'memoryBusy')),
              h('section', null, h(Title, { count: Array.isArray(snapshot.memory?.entries) ? memoryEntries.length : undefined }, t('memoryEntries')),
                !Array.isArray(snapshot.memory?.entries) ? h(Empty, null, t('memoryEntriesUnknown')) : !memoryEntries.length ? h(Empty, null, t('memoryEmpty')) : h('div', { className: 'syr-table-wrap', 'data-testid': 'memory-list' },
                  h('table', { className: 'syr-table' }, h('thead', null, h('tr', null, ...['memoryOperationId', 'status', 'memoryConsent', 'memoryBytes'].map(key => h('th', { key, scope: 'col' }, t(key))))),
                    h('tbody', null, ...memoryEntries.map(item => h('tr', { key: item.operationId },
                      h('td', null, h(Button, { 'aria-label': t('memoryView', { id: item.operationId }), 'aria-pressed': memorySelected === item.operationId, onClick: () => chooseMemory(item.operationId) }, text(item.operationId))),
                      h('td', null, h(Status, { value: item.status })), h('td', null, consentLabel(item.consent)), h('td', null, numeric(item.bodyBytes)))))))),
              memoryEntry ? h('section', { className: 'syr-box', 'aria-label': t('memoryDetails'), 'data-testid': 'memory-detail' }, h(Title, null, t('memoryDetails')),
                h(Facts, { rows: [['memoryOperationId', text(memoryEntry.operationId), true], ['memoryRequestId', text(memoryEntry.requestId), true], ['conversationId', text(memoryEntry.conversationId), true], ['recordVersion', numeric(memoryEntry.version)], ['status', label(memoryEntry.status)], ['memoryConsent', consentLabel(memoryEntry.consent)], ['memoryBlocked', memoryEntry.blocked === true ? t('status_blocked') : memoryEntry.blocked === false ? t('memoryNotBlocked') : t('unknownValue')], ['memoryBytes', numeric(memoryEntry.bodyBytes)], ['memoryNativeId', memoryEntry.nativeId, true], ['memoryCreated', dateTime(memoryEntry.createdAt, locale)]] }),
                h('div', { className: 'syr-actions syr-section-gap' }, readable && h(Button, { disabled: !canRead, onClick: () => { if (canRead) void operations.current.memory('memory.readLocal', { operationId: memoryEntry.operationId }); } }, t(command === 'memory.readLocal' ? 'memoryReading' : 'memoryRead')),
                  readable && h(Button, { disabled: !canIndex, onClick: () => {
                    if (!canIndex) return;
                    if (!memoryIndexIds.current.has(memoryEntry.operationId)) memoryIndexIds.current.set(memoryEntry.operationId, `memory-index-${crypto.randomUUID()}`);
                    void operations.current.semantic('memory.indexLocal', { requestId: memoryIndexIds.current.get(memoryEntry.operationId), operationId: memoryEntry.operationId });
                  } }, t(command === 'memory.indexLocal' ? 'memoryIndexing' : 'memoryIndex')),
                  memoryEntry.consent === 'active' && h(Button, { disabled: !canWithdraw, onClick: () => {
                    if (!canWithdraw) return;
                    if (!memoryWithdrawIds.current.has(memoryEntry.operationId)) memoryWithdrawIds.current.set(memoryEntry.operationId, `memory-withdraw-${crypto.randomUUID()}`);
                    void operations.current.memory('memory.withdrawLocal', { requestId: memoryWithdrawIds.current.get(memoryEntry.operationId), operationId: memoryEntry.operationId });
                  } }, t(memoryWithdrawing === memoryEntry.operationId ? 'memoryWithdrawing' : 'memoryWithdraw'))),
                h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('memoryWithdrawHint')),
                h('p', { className: 'syr-small syr-muted' }, t('memoryIndexHint')),
                indexReceipt && h('section', { className: 'syr-task-result', 'data-testid': 'memory-index-receipt' }, h(Title, null, t('memoryIndexReceipt')),
                  h('p', { className: 'syr-small syr-muted' }, t('memoryIndexUsageHint')), h(Facts, { rows: [['status', label(indexReceipt.status)], ['memoryIndexPublishable', t(indexReceipt.publishable ? 'confirmed' : 'unknownValue')],
                    ['embeddingCalls', numeric(indexReceipt.embeddingUsage.calls)], ['embeddingUsageCompleteness', t(indexReceipt.embeddingUsage.complete ? 'usageComplete' : 'usageIncomplete')]] })),
                memoryBodyVisible && h('section', { className: 'syr-task-result', 'aria-label': t('memoryBodyTitle'), 'data-testid': 'memory-body' }, h(Title, null, t('memoryBodyTitle')), h('p', { className: 'syr-small syr-muted' }, t('memoryBodyHint')), h('pre', { className: 'syr-memory-body' }, memoryBody.body)))
                : h(Empty, null, t(memorySelected ? 'memoryNotInSnapshot' : 'memorySelect')));
          }
          function contextLoadContent() {
            const enabled = canStartCommand && snapshot.diagnostics?.contextSafety?.ready === true && Boolean(contextLoadText.trim()) && contextLoadText.length <= 16000;
            const receipt = contextLoadReceipt?.conversationId === conversation.conversationId && contextLoadReceipt?.bindingId === conversation.bindingId
              && contextLoadReceipt?.sessionEpoch === conversation.sessionEpoch && contextLoadReceipt?.instanceId === snapshot.instanceId && !stale ? contextLoadReceipt : null;
            return h('section', { className: 'syr-task-result syr-memory-form', 'aria-label': t('contextLoadTitle'), 'data-testid': 'context-load-only' }, h(Title, null, t('contextLoadTitle')),
              h('p', { className: 'syr-small syr-muted' }, t('contextLoadHint')),
              h('label', { className: 'syr-select-label' }, h('span', null, t('contextLoadInput')), h('textarea', { className: 'syr-textarea', 'aria-label': t('contextLoadInput'), value: contextLoadText,
                disabled: Boolean(command || controlCommand), maxLength: 16000, onChange: event => { contextLoadGuard.current++; contextLoadDraftId.current = null; setContextLoadReceipt(null); setContextLoadText(event.target.value); } })),
              h('div', { className: 'syr-actions' }, h(Button, { disabled: !enabled, onClick: () => {
                if (!enabled) return; contextLoadDraftId.current ||= `context-load-${crypto.randomUUID()}`;
                void operations.current.semantic('conversation.loadContext', { conversationId: conversation.conversationId, inputId: contextLoadDraftId.current, text: contextLoadText },
                  { bindingId: conversation.bindingId, sessionEpoch: conversation.sessionEpoch });
              } }, t(command === 'conversation.loadContext' ? 'contextLoadingOnly' : 'contextLoadOnly'))),
              memoryError && h('p', { className: 'syr-alert', role: 'alert' }, memoryError),
              receipt && h('section', { className: 'syr-task-result', 'data-testid': 'context-load-receipt' },
                h('p', { className: 'syr-small' }, t(receipt.duplicate ? 'contextLoadDuplicate' : 'contextLoaded')),
                h(Facts, { rows: [['memoryOperationId', receipt.operationId, true], ['status', label(receipt.status)], ['sessionId', receipt.sessionId, true], ['nativeUserMessageSeq', numeric(receipt.userMessageSeq)]] })));
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
            h('nav', { className: 'syr-tabs', 'aria-label': t('title') }, ...['overview', 'core', 'tasks', 'conversations', 'lab', 'memory', 'systems', 'sessions', 'diagnostics'].map(id => h('button', { type: 'button', className: 'syr-tab', key: id, 'aria-current': tab === id ? 'page' : undefined, onClick: () => { if (tab === 'lab' && id !== 'lab') setLabToken(''); setTab(id); } }, t(id)))),
            stale && h('div', { className: 'syr-alert', role: 'alert', 'data-testid': 'snapshot-stale' }, h('strong', null, t(snapshot ? 'staleTitle' : 'loadFailed')), h('p', null, readError || t('snapshotOld')), snapshot && h('p', null, t('staleHint'))),
            commandError && h('div', { className: 'syr-alert', role: 'alert' }, h('strong', null, t('commandFailed')), commandError),
            controlError && h('div', { className: 'syr-alert', role: 'alert' }, h('strong', null, t('commandFailed')), controlError),
            commandNotice && h('p', { className: 'syr-feedback', role: 'status' }, commandNotice),
            controlNotice && h('p', { className: 'syr-feedback', role: 'status' }, controlNotice),
            command && h('p', { className: 'syr-feedback', role: 'status' }, t(command === 'session.verify-model' ? 'modelVerifyPending' : command === 'conversation.verifyContext' ? 'contextVerifyPending' : 'controlPending', { id: contextAttempt?.conversationId || t('unknownValue') })),
            controlCommand && h('p', { className: 'syr-feedback', role: 'status' }, t('controlPending')),
            snapshot ? (tab === 'overview' ? overview() : tab === 'core' ? coreContent() : tab === 'tasks' ? taskContent() : tab === 'conversations' ? conversationContent() : tab === 'lab' ? labContent() : tab === 'memory' ? memoryContent() : tab === 'systems' ? systemContent() : tab === 'sessions' ? sessionContent() : diagnostics()) : !readError && h('p', { className: 'syr-loading', role: 'status' }, t('loading')),
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
