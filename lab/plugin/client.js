window.__ModuleLoader__.load({
  id: '@shiyu/gym',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useId, useRef, useState, useSyncExternalStore } = React;
    const NS = 'shiyuGym';
    const PAGE_SIZE = 100;
    const list = value => Array.isArray(value) ? value : [];
    const text = value => value == null ? '' : String(value);
    const pretty = value => JSON.stringify(value, null, 2);
    const errorText = error => error instanceof Error ? error.message : text(error);
    const activeRun = status => ['prepared', 'running', 'draining'].includes(status);
    const activeAgent = status => ['starting', 'running'].includes(status);
    const sealed = run => Boolean(run?.factReport && ['completed', 'stopped', 'interrupted', 'failed'].includes(run.status));
    const defaults = { scenarioId: 'mixed-office', seed: 42, noiseCount: 20, speed: 5, workerConcurrency: 2, taskDelayMs: 150, fault: 'none', maxDurationMs: 60000, evaluationMode: 'protocol' };
    const zh = {
      title: '识雨健身房', subtitle: '在合成公司里练习工作，用独立证据检验成果。',
      refresh: '刷新', loading: '正在加载…', retry: '重试', close: '关闭', requestFailed: '请求失败', invalidResponse: '服务返回了无法解析的响应。', unknown: '未知', none: '无',
      loadFailed: '无法读取健身房状态', detailFailed: '无法读取运行详情', apiHint: '请确认识雨健身房 Host 已启用。刷新失败不会清空已有结果。',
      newRun: '新建练习', history: '运行历史', historyEmpty: '还没有运行记录。', historyHelp: '从参考执行器开始，先检查测试系统本身。', historyCount: '{count} 次运行',
      scenario: '练习场景', driver: '执行驱动', reference: '参考执行器 · 安全自检', dsh: 'DSH 模型 Agent · 工作练习', external: '外部 Agent · 协议接入', mode: '验收方式', protocol: '固定协议自检', outcome: '业务成果验收',
      referenceNote: '参考执行器是确定性程序，不调用模型；通过只证明 Lab 自检，不代表识雨能力已实现。',
      dshNote: '点击开始才会创建 DSH 模型会话并消耗当前宿主模型额度。这是任务练习，不是模型参数训练，也不代表真实识雨内核已接入。',
      externalNote: '开始后使用本次运行令牌接入外部 Agent。健身房本身不会替你调用外部模型。',
      outcomeNote: '按业务目标和实际成果验收，不要求复刻参考执行器的路径或工具步骤。', protocolNote: '按公开交付契约自检；固定路径并非自然任务的唯一正确做法。',
      model: '当前宿主模型', noModel: '未配置可用模型', dshUnavailable: 'Host 尚未启用 DSH 模型执行能力。', parameters: '运行参数', seed: '随机种子', noiseCount: '噪声消息数', speed: '场景播放速度', workerConcurrency: '参考 worker 并发', taskDelayMs: '参考任务延迟（毫秒）', maxDurationMs: '运行时限（毫秒）', fault: '故障注入', fault_none: '不注入故障', fault_tool_once: '工具暂时失败一次', fault_lost_receipt: '效果成功后丢失回执', referenceParameters: '并发与任务延迟用于参考执行器，不替模型决定派工策略。',
      start: '开始安全自检', startDsh: '开始模型练习（消耗额度）', startExternal: '建立外部运行', starting: '正在建立运行…', invalidConfig: '请检查参数，数值必须在输入框提示的范围内。',
      catalog: '合成公司', actors: '参与者', channels: '会话', subjects: '工作科目', scenarios: '场景', syntheticNote: '仅使用合成资料和测试服务；不连接真实公司账号或生产设备。', emptyTitle: '选择一次运行，或开始第一次练习', emptyBody: '查看工作过程、实际交付和独立验收。默认安全自检不消耗模型额度。',
      selectedRun: '当前运行', runId: '运行 ID', createdAt: '创建时间', finishedAt: '结束时间', runtimeDir: '运行数据目录', version: '版本', runConfig: '实际运行配置', scopeReference: 'Lab 自检 · 不计为识雨能力成绩', scopeModel: '模型工作练习 · 不等于识雨内核实现', scopeExternal: '外部目标测评 · 能力结论以证据为准', modeLabel: '验收方式：{mode}', drain: '停止注入并排空', stop: '停止运行', stopHint: '停止阻止新的 Lab 效果；已有证据保留。模型会话可另行取消。', drainDone: '已请求停止注入并排空。', stopDone: '已请求停止运行。', cancelAgent: '取消模型会话', cancelDone: '已提交会话取消请求。',
      overview: '总览', tasks: '任务', timeline: '事件', artifacts: '产物', facts: '事实验收', reviews: 'Agent 评分', compare: '运行比较',
      status_prepared: '准备中', status_running: '运行中', status_draining: '排空中', status_completed: '已完成', status_stopped: '已停止', status_interrupted: '已中断', status_failed: '失败', status_queued: '排队中', status_waiting: '等待中', status_cancelled: '已取消', status_starting: '启动中', status_error: '错误', status_pass: '通过', status_fail: '未通过', status_inconclusive: '不可判定', status_not_applicable: '不适用', status_scored: '已评分', status_insufficient_evidence: '证据不足', status_judge_error: '评分失败',
      submittedTasks: '有效提交', outcomePending: '已提交 {submitted}/{total}，业务质量待评分。', outcomeReviewed: '已提交 {submitted}/{total}；业务质量请查看独立 Agent 评分，不等于程序已确认全部通过。', independentlyConfirmed: '程序独立确认',
      passedTasks: '独立验收通过', declaredTasks: '上报完成任务', inputCount: '已注入输入', toolCalls: '工具调用', elapsed: '运行时长', injectionLag: '最大输入延迟', replies: '回复数', pendingTasks: '待完成任务', failedTasks: '失败任务', factsPending: '尚未封存事实报告', factsPendingHelp: '运行结束并完成独立验收后显示；任务自报完成不等于验收通过。',
      noTasks: '当前运行还没有任务。', notIntroduced: '尚未到达', owner: '负责人', channel: '会话', instructions: '任务目标与要求', dependencies: '依赖任务', inputs: '输入资料', expectedOutputs: '任务声明的交付要求', producedOutputs: '已登记产物', evidenceRefs: '证据引用',
      filterEvents: '筛选已加载事件', filterPlaceholder: '搜索正文、角色、任务或事件类型', loadedEvents: '已加载 {count} 条事件；搜索仅覆盖这些事件。', noEvents: '暂无已加载事件。', noMatches: '已加载事件中没有匹配项。', loadMore: '加载后续事件', loadingMore: '正在加载后续事件…', caughtUp: '已读到当前末尾；新事件到达后可继续加载。', eventPageMissing: '服务未返回事件分页数据，未使用截断的 run.events 冒充完整时间线。', eventType: '事件类型', eventData: '事件数据',
      role_core: 'core', role_worker: 'worker', role_replyer: 'replyer', role_world: '模拟公司', role_lab: 'Lab', role_memory: '记忆观察', noArtifacts: '暂无已登记产物。', artifactHelp: '仅提供 Host 已登记的受控产物，不依赖固定文件名。', preview: '预览', download: '下载', previewTitle: '产物预览', previewEmpty: '选择一个产物查看内容。', binaryPreview: '二进制产物，请下载后用相应应用打开。', truncated: '预览已截断，请下载查看完整内容。', previewFailed: '无法预览产物', bytes: '{count} 字节', seconds: '{count} 秒', sha256: 'SHA-256',
      factsHelp: '程序独立核对实际文件、世界状态和交付记录；与模型意见分开保存。', limitations: '限制与不可判定项', evidenceDownload: '下载封存证据', judgeHelp: '评分 Agent 使用独立只读会话查看封存证据。评分是意见，不覆盖程序事实报告。', judgeCost: '点击评分会消耗当前宿主模型额度；每次重评保留独立记录。', judge: '启动独立 Agent 评分（消耗额度）', judgeRunning: '评分会话正在运行', judgeUnavailable: 'Host 尚未启用 DSH 评分能力。', sealedOnly: '只有已结束且封存事实报告的运行才能评分或导出证据。', judgeStarted: '已启动独立评分会话。', noReviews: '尚无 Agent 评分。', humanReview: '需要人工复核',
      importReview: '导入评分 JSON', importHelp: '导入只新增意见；Host 会校验证据引用与评分结构。', reviewJson: '评分 JSON 对象', importSubmit: '校验并导入', importing: '正在导入…', invalidJson: '请输入有效的 JSON 对象（不能是数组或空值）。', importDone: '评分结果已导入。', importFailed: '评分校验未通过，请查看错误记录。',
      sessionBindings: '模型会话', noBindings: '本次运行没有关联的 DSH 模型会话。', binding_target: '被测模型', binding_judge: '独立评分', sessionId: '会话 ID', sessionReadOnly: '仅显示会话标识；此处不自动恢复或唤醒模型。', usage: '模型用量记录', tokenTitle: '外部 Agent 接入令牌', tokenNote: '仅用于本次运行。页面不会持久保存令牌，请勿放入报告或日志。', copyToken: '复制令牌', copied: '已复制', copyFailed: '剪贴板不可用，请手动选择复制。',
      externalProtocol: '请从 DSH 已认证的同源连接发送 POST {endpoint}，正文携带 runId、targetToken 和 request。这不是旧独立服务的 /target 接口。', externalActions: 'request.action 可为 inspect、inputs 或 act；其余字段按对应动作填写。', tokenMissing: '当前页面没有明文令牌。令牌仅在首次成功创建响应中返回；若该响应丢失，请停止此运行后重新创建。', tokenPlaceholder: '首次创建返回的 targetToken', requestExample: '请求格式示例',
      selectCompare: '选择对照运行', noCompare: '请另选一次运行作为对照。', compareLoading: '正在读取对照运行…', compareFailed: '无法读取对照运行', metric: '指标', current: '当前运行', baseline: '对照运行', conditionsDifferent: '实验条件不同，不能将分数或耗时差异直接归因于模型能力。', conditionsSame: '已记录配置相同；这仍不构成因果结论，需核对模型版本、资料和实验重复次数。', differingFields: '不同的条件', compareUnsealed: '至少一次运行尚未封存；当前为过程快照，不是最终成绩。', compareScope: '比较包括驱动、验收模式及全部已记录配置。', rawManifest: '运行范围与版本记录',
    };
    const en = {
      title: 'Shiyu Gym', subtitle: 'Practice work in a synthetic company. Verify outcomes with independent evidence.', refresh: 'Refresh', loading: 'Loading…', retry: 'Retry', close: 'Close', requestFailed: 'Request failed', invalidResponse: 'The server returned an unreadable response.', unknown: 'Unknown', none: 'None', loadFailed: 'Unable to load Gym status', detailFailed: 'Unable to load run details', apiHint: 'Check that Shiyu Gym Host is enabled. A failed refresh does not clear saved results.', newRun: 'New exercise', history: 'Run history', historyEmpty: 'No runs yet.', historyHelp: 'Start with the reference executor to check the test system itself.', historyCount: '{count} runs', scenario: 'Scenario', driver: 'Execution driver', reference: 'Reference executor · safe self-test', dsh: 'DSH model Agent · work practice', external: 'External Agent · protocol connection', mode: 'Evaluation mode', protocol: 'Protocol self-test', outcome: 'Business outcomes',
      referenceNote: 'The reference executor is deterministic and uses no model. Passing proves Lab self-tests, not Shiyu intelligence.', dshNote: 'Only clicking Start creates a DSH session and consumes the current Host model allowance. This is work practice, not model weight training or a completed Shiyu kernel.', externalNote: 'Connect an external Agent with the per-run token after creation. Gym does not call an external model for you.', outcomeNote: 'Evaluate goals and outcomes, without requiring reference file paths or tool sequences.', protocolNote: 'Check the public delivery contract. Fixed paths are not the only valid solution to natural work tasks.', model: 'Current Host model', noModel: 'No model configured', dshUnavailable: 'The Host has not enabled DSH model execution.', parameters: 'Run parameters', seed: 'Random seed', noiseCount: 'Noise messages', speed: 'Scenario speed', workerConcurrency: 'Reference worker concurrency', taskDelayMs: 'Reference delay (ms)', maxDurationMs: 'Run timeout (ms)', fault: 'Fault injection', fault_none: 'No fault', fault_tool_once: 'One temporary tool failure', fault_lost_receipt: 'Lose receipt after successful effect', referenceParameters: 'Concurrency and delay control the reference executor, not model delegation.', start: 'Start safe self-test', startDsh: 'Start model practice (uses allowance)', startExternal: 'Create external run', starting: 'Creating run…', invalidConfig: 'Check the parameters: numbers must stay within the indicated ranges.',
      catalog: 'Synthetic company', actors: 'Participants', channels: 'Conversations', subjects: 'Work subjects', scenarios: 'Scenarios', syntheticNote: 'Synthetic data and test services only; no real company accounts or production devices.', emptyTitle: 'Select a run or start your first exercise', emptyBody: 'Inspect work, actual deliverables and independent checks. The default self-test uses no model allowance.', selectedRun: 'Selected run', runId: 'Run ID', createdAt: 'Created', finishedAt: 'Finished', runtimeDir: 'Runtime data directory', version: 'Version', runConfig: 'Recorded configuration', scopeReference: 'Lab self-test · not a Shiyu capability score', scopeModel: 'Model work practice · not a completed Shiyu kernel', scopeExternal: 'External target evaluation · evidence determines conclusions', modeLabel: 'Evaluation: {mode}', drain: 'Stop input and drain', stop: 'Stop run', stopHint: 'Stopping blocks new Lab effects and retains evidence. Model sessions can be cancelled separately.', drainDone: 'Input stop and drain requested.', stopDone: 'Run stop requested.', cancelAgent: 'Cancel model session', cancelDone: 'Session cancellation requested.', overview: 'Overview', tasks: 'Tasks', timeline: 'Events', artifacts: 'Artifacts', facts: 'Fact checks', reviews: 'Agent reviews', compare: 'Compare',
      submittedTasks: 'Valid submissions', outcomePending: '{submitted}/{total} submitted; business quality awaits review.', outcomeReviewed: '{submitted}/{total} submitted. See the independent Agent opinion for business quality; this is not full program-confirmed acceptance.', independentlyConfirmed: 'Independently confirmed by program',
      status_prepared: 'Prepared', status_running: 'Running', status_draining: 'Draining', status_completed: 'Completed', status_stopped: 'Stopped', status_interrupted: 'Interrupted', status_failed: 'Failed', status_queued: 'Queued', status_waiting: 'Waiting', status_cancelled: 'Cancelled', status_starting: 'Starting', status_error: 'Error', status_pass: 'Pass', status_fail: 'Fail', status_inconclusive: 'Inconclusive', status_not_applicable: 'Not applicable', status_scored: 'Scored', status_insufficient_evidence: 'Insufficient evidence', status_judge_error: 'Review failed', passedTasks: 'Independently verified', declaredTasks: 'Reported complete', inputCount: 'Inputs injected', toolCalls: 'Tool calls', elapsed: 'Elapsed', injectionLag: 'Max input lag', replies: 'Replies', pendingTasks: 'Pending tasks', failedTasks: 'Failed tasks', factsPending: 'No sealed fact report yet', factsPendingHelp: 'Available after the run ends and independent verification finishes. Self-reported completion is not acceptance.', noTasks: 'No tasks in this run yet.', notIntroduced: 'Not yet introduced', owner: 'Owner', channel: 'Conversation', instructions: 'Goal and requirements', dependencies: 'Dependencies', inputs: 'Input materials', expectedOutputs: 'Declared delivery requirements', producedOutputs: 'Registered artifacts', evidenceRefs: 'Evidence references',
      filterEvents: 'Filter loaded events', filterPlaceholder: 'Search text, role, task or event type', loadedEvents: '{count} events loaded. Search covers only these events.', noEvents: 'No loaded events yet.', noMatches: 'No matching loaded events.', loadMore: 'Load subsequent events', loadingMore: 'Loading subsequent events…', caughtUp: 'At the current end. Load more when new events arrive.', eventPageMissing: 'The server did not return eventPage. Truncated run.events is not used as a complete timeline.', eventType: 'Event type', eventData: 'Event data', role_core: 'core', role_worker: 'worker', role_replyer: 'replyer', role_world: 'Simulated company', role_lab: 'Lab', role_memory: 'Memory observation', noArtifacts: 'No registered artifacts yet.', artifactHelp: 'Downloads are restricted to Host-registered artifacts, with no fixed filename assumptions.', preview: 'Preview', download: 'Download', previewTitle: 'Artifact preview', previewEmpty: 'Select an artifact to inspect its content.', binaryPreview: 'Binary artifact. Download to open in its native application.', truncated: 'Preview truncated. Download for complete content.', previewFailed: 'Unable to preview artifact', bytes: '{count} bytes', seconds: '{count} s', sha256: 'SHA-256',
      factsHelp: 'The program checks actual files, world state and delivery records independently of model opinions.', limitations: 'Limitations and uncertainty', evidenceDownload: 'Download sealed evidence', judgeHelp: 'An independent read-only Agent session reviews sealed evidence. Opinions never replace the fact report.', judgeCost: 'Starting a review consumes current Host model allowance. Each re-review keeps its own record.', judge: 'Start independent Agent review (uses allowance)', judgeRunning: 'A review session is running', judgeUnavailable: 'The Host has not enabled DSH reviews.', sealedOnly: 'Reviews and evidence export require an ended run with a sealed fact report.', judgeStarted: 'Independent review session started.', noReviews: 'No Agent reviews yet.', humanReview: 'Human review required', importReview: 'Import review JSON', importHelp: 'Import adds an opinion; the Host validates the schema and evidence references.', reviewJson: 'Review JSON object', importSubmit: 'Validate and import', importing: 'Importing…', invalidJson: 'Enter a valid JSON object, not an array or null.', importDone: 'Review imported.', importFailed: 'Review validation failed. Inspect the recorded error.', sessionBindings: 'Model sessions', noBindings: 'No associated DSH model sessions for this run.', binding_target: 'Target model', binding_judge: 'Independent reviewer', sessionId: 'Session ID', sessionReadOnly: 'Identifier only; this view never automatically resumes or wakes a model.', usage: 'Model usage record', tokenTitle: 'External Agent token', tokenNote: 'For this run only. This page does not persist it. Keep it out of reports and logs.', copyToken: 'Copy token', copied: 'Copied', copyFailed: 'Clipboard unavailable. Select and copy the token manually.',
      externalProtocol: 'Send POST {endpoint} from an authenticated, same-origin DSH connection with runId, targetToken and request in the body. This is not the old standalone /target endpoint.', externalActions: 'request.action is inspect, inputs or act; supply the remaining fields required by that action.', tokenMissing: 'This page has no plaintext token. Only the first successful create response returns it. If that response was lost, stop this run and create a new one.', tokenPlaceholder: 'targetToken from the first create response', requestExample: 'Request shape example',
      selectCompare: 'Select comparison run', noCompare: 'Choose a different run to compare.', compareLoading: 'Loading comparison…', compareFailed: 'Unable to load comparison', metric: 'Metric', current: 'Current run', baseline: 'Comparison run', conditionsDifferent: 'Conditions differ. Do not attribute score or timing differences directly to model capability.', conditionsSame: 'Recorded settings match. This is not causal evidence: also check model versions, materials and repeated trials.', differingFields: 'Different conditions', compareUnsealed: 'At least one run is not sealed. These are progress snapshots, not final scores.', compareScope: 'Comparison includes the driver, evaluation mode and every recorded configuration field.', rawManifest: 'Scope and version record',
    };
    const css = `
.sgym{height:100%;min-height:0;min-width:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.5;box-sizing:border-box}.sgym *{box-sizing:border-box}.sgym button,.sgym input,.sgym select,.sgym textarea{font:inherit}.sgym :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.sgym h1,.sgym h2,.sgym h3,.sgym p{margin:0}.sgym h1{font-size:20px;font-weight:650}.sgym h2{font-size:15px;font-weight:650}.sgym h3{font-size:13px;font-weight:600}.sgym a{color:var(--dsw-alias-brand-primary);text-decoration:none}.sgym a:hover{text-decoration:underline}.sgym code{font-size:12px;overflow-wrap:anywhere;user-select:text}.sgym pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;font-size:12px;padding:12px;background:var(--dsw-alias-bg-layer-1);border-radius:6px}.sgym summary{cursor:pointer;overflow-wrap:anywhere}
.sgym-shell{max-width:1480px;margin:0 auto;padding:24px}.sgym-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}.sgym-heading{display:flex;gap:12px;align-items:center}.sgym-mark{color:var(--dsw-alias-brand-primary);display:flex;flex:none}.sgym-subtitle{color:var(--dsw-alias-label-secondary);margin-top:3px!important}.sgym-layout{display:grid;grid-template-columns:292px minmax(0,1fr);gap:20px;align-items:start}.sgym-sidebar,.sgym-main{min-width:0;display:flex;flex-direction:column;gap:16px}.sgym-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);min-width:0;overflow:hidden}.sgym-card-head{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;justify-content:space-between;align-items:center;gap:12px}.sgym-card-body{padding:16px}.sgym-stack{display:flex;flex-direction:column;gap:12px}.sgym-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.sgym-between{justify-content:space-between}.sgym-muted{color:var(--dsw-alias-label-secondary)}.sgym-small{font-size:12px}.sgym-wrap{white-space:pre-wrap;overflow-wrap:anywhere}.sgym-section{margin-top:16px}.sgym-field{display:flex;flex-direction:column;gap:5px;min-width:0}.sgym-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}.sgym-input{width:100%;min-width:0;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.sgym-input:disabled{opacity:.6;cursor:not-allowed}.sgym textarea.sgym-input{min-height:150px;resize:vertical;font-family:monospace}.sgym-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.sgym-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;line-height:1.4;max-width:100%;text-align:center}.sgym-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);text-decoration:none}.sgym-btn:disabled{opacity:.5;cursor:not-allowed}.sgym-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-brand-primary)}.sgym-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9}.sgym-btn-danger{color:var(--dsw-alias-state-error-primary)}.sgym-full{width:100%}.sgym-note{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-state-idle-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);overflow-wrap:anywhere;font-size:12px}.sgym-note-warning{border-left-color:var(--dsw-alias-state-warn-primary)}.sgym-note-error{border-left-color:var(--dsw-alias-state-error-primary)}.sgym-note-success{border-left-color:var(--dsw-alias-state-success-primary)}.sgym-note>strong{display:block;margin-bottom:3px}.sgym-badge{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;padding:2px 7px;border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}.sgym-badge[data-tone=success]{color:var(--dsw-alias-state-success-primary)}.sgym-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary)}.sgym-badge[data-tone=warning]{color:var(--dsw-alias-state-warn-primary)}.sgym-badge[data-tone=active]{color:var(--dsw-alias-brand-primary)}
.sgym-history{list-style:none;padding:0;margin:0;max-height:440px;overflow:auto}.sgym-history li+li{border-top:1px solid var(--dsw-alias-border-l1)}.sgym-history-item{width:100%;padding:12px 14px;display:flex;flex-direction:column;gap:5px;text-align:left;background:var(--dsw-alias-bg-base);border:0;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0}.sgym-history-item:hover,.sgym-history-item[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1)}.sgym-history-item[aria-pressed=true]{box-shadow:inset 3px 0 var(--dsw-alias-brand-primary)}.sgym-history-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.sgym-empty{padding:40px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary)}.sgym-empty strong{color:var(--dsw-alias-label-primary);font-size:14px}.sgym-tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 12px;background:var(--dsw-alias-bg-base)}.sgym-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:11px 10px;white-space:nowrap;cursor:pointer}.sgym-tab[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}.sgym-panel{padding:16px;min-width:0}.sgym-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.sgym-metric{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:12px;background:var(--dsw-alias-bg-layer-1);min-width:0}.sgym-metric>span{display:block;font-size:11px;color:var(--dsw-alias-label-secondary)}.sgym-metric>strong{display:block;font-size:19px;font-weight:600;margin-top:5px;overflow-wrap:anywhere}.sgym-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}.sgym-item{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:12px;min-width:0}.sgym-item>summary{display:flex;align-items:center;justify-content:space-between;gap:8px}.sgym-item[open]>summary{margin-bottom:12px}.sgym-kv{display:grid;grid-template-columns:minmax(85px,auto) minmax(0,1fr);gap:7px 14px;margin:0}.sgym-kv dt{color:var(--dsw-alias-label-secondary);font-size:12px}.sgym-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}.sgym-refs{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.sgym-refs code{padding:2px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-1)}.sgym-event{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.sgym-event:first-child{padding-top:0}.sgym-event:last-child{border-bottom:0}.sgym-event-meta{display:flex;align-items:center;flex-wrap:wrap;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:5px}.sgym-event p{white-space:pre-wrap;overflow-wrap:anywhere}.sgym-event details{margin-top:8px}.sgym-pagination{padding-top:16px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.sgym-artifact-name{min-width:0;flex:1}.sgym-table-wrap{overflow:auto}.sgym-table{width:100%;border-collapse:collapse;font-size:12px}.sgym-table th,.sgym-table td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;overflow-wrap:anywhere;min-width:100px}.sgym-table th{font-weight:600;background:var(--dsw-alias-bg-layer-1)}.sgym-table tr:last-child td{border-bottom:0}.sgym-score{font-size:16px;color:var(--dsw-alias-brand-primary);font-weight:600}.sgym-inline-code{display:block;padding:8px;background:var(--dsw-alias-bg-layer-1);border-radius:5px;white-space:pre-wrap;overflow-wrap:anywhere}.sgym-footer{margin-top:18px;font-size:11px;color:var(--dsw-alias-label-secondary)}
@media(max-width:1050px){.sgym-shell{padding:16px}.sgym-layout{grid-template-columns:260px minmax(0,1fr);gap:14px}.sgym-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.sgym-shell{padding:14px}.sgym-layout{grid-template-columns:minmax(0,1fr)}.sgym-header{gap:8px}.sgym-header>.sgym-btn{flex:none}.sgym-sidebar{display:grid;grid-template-columns:minmax(0,1fr)}.sgym-history{max-height:220px}.sgym-card-body,.sgym-panel{padding:12px}.sgym-card-head{padding:12px}.sgym-heading{gap:9px}.sgym h1{font-size:18px}.sgym-kv{grid-template-columns:minmax(0,1fr)}.sgym-kv dd{margin-bottom:5px}}
`;
    function GymIcon({ size = 20, active = false }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: 'M7 9h10M7 15h10M4 8v8M20 8v8M2 10v4M22 10v4' }), h('rect', { x: 4, y: 6, width: 3, height: 12, rx: 1 }), h('rect', { x: 17, y: 6, width: 3, height: 12, rx: 1 }));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const translate = ctx.locale.bind(NS);
        const t = (key, values) => {
          const value = translate(key);
          return values ? value.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? text(values[name]) : match) : value;
        };
        const subscribeLocale = listener => ctx.locale.subscribe(listener);
        const localeSnapshot = () => ctx.locale.getSnapshot();
        const statusLabel = status => Object.hasOwn(zh, `status_${status}`) ? t(`status_${status}`) : text(status);
        const modeLabel = mode => t(mode === 'outcome' ? 'outcome' : 'protocol');
        const isOutcome = run => run?.config?.evaluationMode === 'outcome' || typeof run?.factReport?.tasksSubmitted === 'number';
        const progressLabel = run => t(isOutcome(run) ? 'submittedTasks' : 'passedTasks');
        const progressValue = run => !run?.factReport ? t('factsPending') : `${isOutcome(run) ? run.factReport.tasksSubmitted ?? 0 : run.factReport.tasksPassed} / ${run.factReport.tasksTotal}`;
        const outcomeMessage = run => t(list(run?.reviews).some(review => review.status === 'completed') ? 'outcomeReviewed' : 'outcomePending', { submitted: run?.factReport?.tasksSubmitted ?? 0, total: run?.factReport?.tasksTotal ?? 0 });
        const roleLabel = role => Object.hasOwn(zh, `role_${role}`) ? t(`role_${role}`) : text(role);
        const duration = value => t('seconds', { count: (Number(value || 0) / 1000).toFixed(1) });
        const dateLabel = (value, locale, timeOnly = false) => {
          if (!value) return t('none');
          const date = new Date(value);
          if (!Number.isFinite(date.getTime())) return text(value);
          try { return new Intl.DateTimeFormat(typeof locale === 'string' ? locale : undefined, timeOnly ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date); }
          catch { return date.toLocaleString(); }
        };
        const endpoint = (kind, params) => {
          const url = new URL(`api/shiyu-gym${kind ? `/${kind}` : ''}`, document.baseURI);
          for (const [name, value] of Object.entries(params || {})) url.searchParams.set(name, text(value));
          return url.href;
        };
        async function api(action, payload = {}, signal) {
          const response = await fetch(new URL('api/shiyu-gym', document.baseURI), { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
          let data;
          try { data = await response.json(); } catch { throw new Error(`${t('invalidResponse')} (${response.status})`); }
          if (!response.ok || data?.ok === false) {
            const message = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message;
            throw new Error(message || `${t('requestFailed')} (${response.status})`);
          }
          return data;
        }
        function Badge({ status }) {
          const tone = ['completed', 'pass', 'scored'].includes(status) ? 'success' : ['failed', 'error', 'fail', 'judge_error'].includes(status) ? 'error' : ['inconclusive', 'interrupted', 'insufficient_evidence'].includes(status) ? 'warning' : ['running', 'starting', 'draining'].includes(status) ? 'active' : 'idle';
          return h('span', { className: 'sgym-badge', 'data-tone': tone }, statusLabel(status));
        }
        function Note({ kind = '', title, children, live = false }) {
          return h('div', { className: `sgym-note${kind ? ` sgym-note-${kind}` : ''}`, role: kind === 'error' ? 'alert' : live ? 'status' : undefined }, title && h('strong', null, title), children);
        }
        function Empty({ title, children }) { return h('div', { className: 'sgym-empty' }, h(GymIcon, { size: 28 }), h('strong', null, title), children && h('p', null, children)); }
        function Metric({ label, value }) { return h('div', { className: 'sgym-metric' }, h('span', null, label), h('strong', null, value ?? t('unknown'))); }
        function Field({ label, children }) { return h('label', { className: 'sgym-field' }, h('span', null, label), children); }
        function Refs({ refs }) { return list(refs).length ? h('div', { className: 'sgym-refs', 'aria-label': t('evidenceRefs') }, list(refs).map((ref, index) => h('code', { key: `${text(ref)}-${index}` }, text(ref)))) : null; }
        function Metadata({ entries }) { return h('dl', { className: 'sgym-kv' }, entries.flatMap(([label, value], index) => [h('dt', { key: `k${index}` }, label), h('dd', { key: `v${index}` }, value)])); }
        function driverOf(run, bindings) {
          if (run?.config?.target === 'reference') return 'reference';
          if (list(bindings).some(item => item.runId === run?.id && item.role === 'target') || run?.manifest?.driver === 'dsh' || run?.driver === 'dsh') return 'dsh';
          return 'external';
        }
        function BindingList({ bindings, busy, onCancel, locale }) {
          if (!bindings.length) return h('p', { className: 'sgym-muted sgym-small' }, t('noBindings'));
          return h('div', { className: 'sgym-stack' }, h('p', { className: 'sgym-muted sgym-small' }, t('sessionReadOnly')), bindings.map(binding => h('section', { className: 'sgym-item sgym-stack', key: `${binding.role}-${binding.sessionId}` },
            h('div', { className: 'sgym-row sgym-between' }, h('strong', null, t(binding.role === 'judge' ? 'binding_judge' : 'binding_target')), h(Badge, { status: binding.status })),
            h(Metadata, { entries: [[t('sessionId'), h('code', null, binding.sessionId)], [t('createdAt'), dateLabel(binding.startedAt, locale)], ...(binding.finishedAt ? [[t('finishedAt'), dateLabel(binding.finishedAt, locale)]] : [])] }),
            binding.error && h(Note, { kind: 'error' }, binding.error), binding.usage && h('details', null, h('summary', null, t('usage')), h('pre', null, pretty(binding.usage))),
            activeAgent(binding.status) && h('div', null, h('button', { type: 'button', className: 'sgym-btn sgym-btn-danger', disabled: Boolean(busy), onClick: () => onCancel(binding.role) }, t('cancelAgent'))))));
        }
        function GymPanel() {
          const localeState = useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot);
          const locale = localeState.active;
          const uid = useId();
          const [snapshot, setSnapshot] = useState(null);
          const [snapshotError, setSnapshotError] = useState('');
          const [refresh, setRefresh] = useState(0);
          const [driver, setDriver] = useState('reference');
          const [draft, setDraft] = useState(defaults);
          const [selectedId, setSelectedId] = useState('');
          const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
          const [run, setRun] = useState(null);
          const [targetBinding, setTargetBinding] = useState(null);
          const [detailError, setDetailError] = useState('');
          const [tab, setTab] = useState('overview');
          const [busy, setBusy] = useState('');
          const operationRef = useRef(false);
          const [actionError, setActionError] = useState('');
          const [notice, setNotice] = useState('');
          const [tokens, setTokens] = useState({});
          const [connections, setConnections] = useState({});
          const [copied, setCopied] = useState(false);
          const [events, setEvents] = useState([]);
          const [moreEvents, setMoreEvents] = useState(false);
          const [pageBusy, setPageBusy] = useState(false);
          const [pageError, setPageError] = useState('');
          const [eventFilter, setEventFilter] = useState('');
          const cursorRef = useRef(0);
          const loadedRunRef = useRef('');
          const pageRequest = useRef(null);
          const [preview, setPreview] = useState(null);
          const [previewBusy, setPreviewBusy] = useState('');
          const [previewError, setPreviewError] = useState('');
          const previewRequest = useRef(null);
          const [reviewJson, setReviewJson] = useState('');
          const [compareId, setCompareId] = useState('');
          const [comparison, setComparison] = useState(null);
          const [compareError, setCompareError] = useState('');
          const createKey = useRef(null);
          const judgeKeys = useRef(new Map());
          const mounted = useRef(true);
          const runs = list(snapshot?.runs);
          const allBindings = list(snapshot?.bindings).filter(item => ['target', 'judge'].includes(item.role));
          const bindings = allBindings.filter(item => item.runId === selectedId);
          if (targetBinding?.runId === selectedId && !bindings.some(item => item.sessionId === targetBinding.sessionId)) bindings.push(targetBinding);
          const catalog = draft.evaluationMode === 'outcome' && Array.isArray(snapshot?.outcomeCatalog?.scenarios) ? snapshot.outcomeCatalog : snapshot?.catalog;
          const scenarios = list(catalog?.scenarios);
          const selectedScenario = scenarios.find(item => item.id === draft.scenarioId);
          const capabilities = snapshot?.capabilities || {};
          const modelName = [capabilities.model?.provider, capabilities.model?.model].filter(Boolean).join(' / ');
          const safeRun = run?.id === selectedId ? run : null;
          const runDriver = safeRun ? driverOf(safeRun, bindings) : 'reference';
          const isSealed = sealed(safeRun);
          const judgeActive = bindings.some(item => item.role === 'judge' && activeAgent(item.status));
          const bump = () => setRefresh(value => value + 1);
          useEffect(() => {
            mounted.current = true;
            return () => { mounted.current = false; pageRequest.current?.abort(); previewRequest.current?.abort(); };
          }, []);
          // Polling is read-only. Only explicit button actions create or cancel model work.
          useEffect(() => {
            const controller = new AbortController(); let timer;
            async function poll() {
              try { const result = await api('snapshot', {}, controller.signal); if (!controller.signal.aborted) { setSnapshot(result); setSnapshotError(''); } }
              catch (error) { if (!controller.signal.aborted) setSnapshotError(errorText(error)); }
              finally { if (!controller.signal.aborted) timer = setTimeout(poll, 5000); }
            }
            void poll(); return () => { controller.abort(); clearTimeout(timer); };
          }, [refresh]);
          useEffect(() => {
            if (!scenarios.length || scenarios.some(item => item.id === draft.scenarioId)) return;
            createKey.current = null; setDraft(current => ({ ...current, scenarioId: scenarios[0].id }));
          }, [catalog, draft.scenarioId]);
          useEffect(() => {
            if (!selectedId) return;
            const controller = new AbortController(); let timer;
            if (loadedRunRef.current !== selectedId) {
              setRun(null); setTargetBinding(null); setEvents([]); setMoreEvents(false); setDetailError(''); setPageError(''); setPageBusy(false); cursorRef.current = 0;
              pageRequest.current?.abort(); previewRequest.current?.abort(); setPreview(null); setPreviewError(''); setPreviewBusy(''); setCopied(false); setReviewJson('');
            }
            async function poll() {
              const initial = loadedRunRef.current !== selectedId;
              const after = initial ? 0 : cursorRef.current;
              try {
                const result = await api('get', { runId: selectedId, after, limit: initial ? PAGE_SIZE : 1 }, controller.signal);
                if (controller.signal.aborted) return;
                setRun(result.run); setTargetBinding(result.binding || null); setDetailError('');
                if (!result.eventPage) setPageError(t('eventPageMissing'));
                else if (initial) {
                  setEvents(list(result.eventPage.events)); cursorRef.current = result.eventPage.nextAfter;
                  setMoreEvents(Boolean(result.eventPage.hasMore)); setPageError(''); loadedRunRef.current = selectedId;
                } else if (after === cursorRef.current) {
                  // Probe only: unread pages remain explicit user actions; no run.events fallback.
                  setMoreEvents(Boolean(result.eventPage.hasMore || list(result.eventPage.events).length));
                }
              } catch (error) { if (!controller.signal.aborted) setDetailError(errorText(error)); }
              finally { if (!controller.signal.aborted) timer = setTimeout(poll, 3000); }
            }
            void poll(); return () => { controller.abort(); clearTimeout(timer); };
          }, [selectedId, refresh]);
          useEffect(() => {
            setComparison(null); setCompareError('');
            if (!compareId || compareId === selectedId) return;
            const controller = new AbortController();
            api('get', { runId: compareId, after: 0, limit: 1 }, controller.signal)
              .then(result => { if (!controller.signal.aborted) setComparison(result.run); })
              .catch(error => { if (!controller.signal.aborted) setCompareError(errorText(error)); });
            return () => controller.abort();
          }, [compareId, selectedId, refresh]);
          function chooseRun(id) {
            if (id !== selectedId) { loadedRunRef.current = ''; setRun(null); setEventFilter(''); setTab('overview'); }
            setSelectedId(id); setActionError(''); setNotice('');
          }
          function updateDraft(key, value) { createKey.current = null; setDraft(current => ({ ...current, [key]: value })); }
          function chooseDriver(value) {
            createKey.current = null; setDriver(value);
            setDraft(current => ({ ...current, evaluationMode: value === 'reference' ? 'protocol' : 'outcome', ...(value === 'dsh' ? { speed: 1, maxDurationMs: 600000 } : {}) }));
          }
          async function perform(key, operation, successKey) {
            if (operationRef.current) return;
            const operationRun = selectedRef.current;
            operationRef.current = true; setBusy(key); setActionError(''); setNotice('');
            try { const result = await operation(); if (mounted.current) { if (successKey && selectedRef.current === operationRun) setNotice(t(successKey)); bump(); } return result; }
            catch (error) { if (mounted.current && (key === 'create' || selectedRef.current === operationRun)) setActionError(errorText(error)); }
            finally { operationRef.current = false; if (mounted.current) setBusy(''); }
          }
          async function createRun(event) {
            event.preventDefault();
            if (!snapshot || (driver === 'dsh' && !capabilities.dshAgent)) return;
            const config = { ...draft, evaluationMode: driver === 'reference' ? 'protocol' : draft.evaluationMode };
            const numeric = [['seed', 0, 4294967295, true], ['noiseCount', 0, 5000, true], ['speed', .1, 1000, false], ['workerConcurrency', 1, 8, true], ['taskDelayMs', 0, 30000, true], ['maxDurationMs', 100, 600000, true]];
            for (const [key, min, max, integer] of numeric) {
              config[key] = Number(config[key]);
              if (draft[key] === '' || !Number.isFinite(config[key]) || config[key] < min || config[key] > max || (integer && !Number.isInteger(config[key]))) { setActionError(t('invalidConfig')); return; }
            }
            createKey.current ||= crypto.randomUUID(); const key = createKey.current;
            await perform('create', async () => {
              const result = await api('create', { driver, config, idempotencyKey: key });
              if (mounted.current) {
                createKey.current = null;
                if (result.targetToken) setTokens(current => ({ ...current, [result.run.id]: result.targetToken }));
                if (driver === 'external') setConnections(current => ({ ...current, [result.run.id]: { endpoint: result.endpoint, connectionNote: result.connectionNote, tokenNotice: result.tokenNotice } }));
                chooseRun(result.run.id); setRun(result.run); setTargetBinding(result.binding || null);
              }
              return result;
            });
          }
          async function control(command) {
            const id = selectedId;
            await perform(command, async () => { const result = await api('control', { runId: id, command }); if (mounted.current && selectedRef.current === id && result.run) setRun(result.run); return result; }, command === 'stop' ? 'stopDone' : 'drainDone');
          }
          async function cancelAgent(role) { await perform(`cancel-${role}`, () => api('cancel_agent', { runId: selectedId, role }), 'cancelDone'); }
          async function startJudge() {
            if (!isSealed || !capabilities.judge || judgeActive) return;
            const id = selectedId;
            if (!judgeKeys.current.has(id)) judgeKeys.current.set(id, crypto.randomUUID());
            await perform('judge', async () => {
              const result = await api('judge', { runId: id, idempotencyKey: judgeKeys.current.get(id) }); judgeKeys.current.delete(id);
              if (mounted.current && result.binding) setSnapshot(current => current ? { ...current, bindings: [...list(current.bindings).filter(item => item.sessionId !== result.binding.sessionId), result.binding] } : current);
              return result;
            }, 'judgeStarted');
          }
          async function importReview(event) {
            event.preventDefault(); let review;
            try { review = JSON.parse(reviewJson); if (!review || Array.isArray(review) || typeof review !== 'object') throw new Error(); }
            catch { setActionError(t('invalidJson')); return; }
            const id = selectedId;
            await perform('import', async () => {
              const result = await api('import_review', { runId: id, review });
              if (mounted.current && selectedRef.current === id) {
                if (result.review?.status === 'judge_error') setActionError(result.review.error || t('importFailed'));
                else { setNotice(t('importDone')); setReviewJson(''); }
              }
              return result;
            });
          }
          async function loadEvents() {
            if (pageBusy || !selectedId) return;
            const id = selectedId, after = cursorRef.current;
            pageRequest.current?.abort(); const controller = new AbortController(); pageRequest.current = controller;
            setPageBusy(true); setPageError('');
            try {
              const result = await api('get', { runId: id, after, limit: PAGE_SIZE }, controller.signal);
              if (controller.signal.aborted || selectedRef.current !== id) return;
              if (!result.eventPage) throw new Error(t('eventPageMissing'));
              setEvents(current => { const known = new Set(current.map(item => item.id)); return [...current, ...list(result.eventPage.events).filter(item => !known.has(item.id))]; });
              cursorRef.current = result.eventPage.nextAfter; setMoreEvents(Boolean(result.eventPage.hasMore)); setRun(result.run); setTargetBinding(result.binding || null);
            } catch (error) { if (!controller.signal.aborted && selectedRef.current === id) setPageError(errorText(error)); }
            finally { if (!controller.signal.aborted && selectedRef.current === id) setPageBusy(false); }
          }
          async function showPreview(artifact) {
            const id = selectedId;
            previewRequest.current?.abort(); const controller = new AbortController(); previewRequest.current = controller;
            setPreviewBusy(artifact.path); setPreviewError(''); setPreview(null);
            try { const result = await api('preview', { runId: id, path: artifact.path }, controller.signal); if (!controller.signal.aborted && selectedRef.current === id) setPreview(result); }
            catch (error) { if (!controller.signal.aborted && selectedRef.current === id) setPreviewError(errorText(error)); }
            finally { if (!controller.signal.aborted && selectedRef.current === id) setPreviewBusy(''); }
          }
          async function copyToken() {
            try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(tokens[selectedId]); if (mounted.current) setCopied(true); }
            catch { if (mounted.current) setActionError(t('copyFailed')); }
          }
          const actorName = id => list(snapshot?.catalog?.actors).find(item => item.id === id)?.name || id || t('none');
          const channelName = id => list(snapshot?.catalog?.channels).find(item => item.id === id)?.name || id || t('none');
          const downloadLink = artifact => endpoint('artifact', { runId: selectedId, path: artifact.path });
          const artifactLink = path => { const artifact = list(safeRun?.artifacts).find(item => item.path === path); return artifact ? h('a', { href: downloadLink(artifact), download: true }, path) : h('code', null, path); };
          const btn = (label, onClick, disabled = false, extraClass = '') => h('button', { type: 'button', className: `sgym-btn ${extraClass}`, onClick, disabled }, label);
          function configForm() {
            const numberField = (key, min, max, step = 1) => h(Field, { label: t(key), key }, h('input', { className: 'sgym-input', type: 'number', value: draft[key], min, max, step, required: true, disabled: Boolean(busy), onChange: event => updateDraft(key, event.target.value) }));
            return h('section', { className: 'sgym-card' }, h('div', { className: 'sgym-card-head' }, h('h2', null, t('newRun'))),
              h('form', { className: 'sgym-card-body sgym-stack', onSubmit: createRun },
                h(Field, { label: t('scenario') }, h('select', { className: 'sgym-input', value: draft.scenarioId, disabled: !scenarios.length || Boolean(busy), onChange: event => updateDraft('scenarioId', event.target.value) }, scenarios.map(item => h('option', { value: item.id, key: item.id }, item.name)))),
                selectedScenario && h('p', { className: 'sgym-muted sgym-small' }, selectedScenario.description),
                h(Field, { label: t('driver') }, h('select', { className: 'sgym-input', value: driver, disabled: Boolean(busy), onChange: event => chooseDriver(event.target.value) }, h('option', { value: 'reference' }, t('reference')), h('option', { value: 'dsh', disabled: !capabilities.dshAgent }, t('dsh')), h('option', { value: 'external' }, t('external')))),
                h(Field, { label: t('mode') }, h('select', { className: 'sgym-input', value: draft.evaluationMode, disabled: driver === 'reference' || Boolean(busy), onChange: event => updateDraft('evaluationMode', event.target.value) }, h('option', { value: 'protocol' }, t('protocol')), h('option', { value: 'outcome' }, t('outcome')))),
                h(Note, { kind: driver === 'dsh' ? 'warning' : '' }, t(driver === 'reference' ? 'referenceNote' : driver === 'dsh' ? 'dshNote' : 'externalNote')),
                h('p', { className: 'sgym-muted sgym-small' }, t(draft.evaluationMode === 'outcome' ? 'outcomeNote' : 'protocolNote')),
                driver === 'dsh' && h('p', { className: 'sgym-small sgym-wrap' }, `${t('model')}: ${modelName || t('noModel')}`),
                h('details', null, h('summary', null, t('parameters')),
                  h('div', { className: 'sgym-form-grid sgym-section' }, numberField('seed', 0, 4294967295), numberField('noiseCount', 0, 5000), numberField('speed', .1, 1000, .1), numberField('workerConcurrency', 1, 8), numberField('taskDelayMs', 0, 30000), numberField('maxDurationMs', 100, 600000)),
                  h('div', { className: 'sgym-section' }, h(Field, { label: t('fault') }, h('select', { className: 'sgym-input', value: draft.fault, disabled: Boolean(busy), onChange: event => updateDraft('fault', event.target.value) }, ['none', 'tool-once', 'lost-receipt'].map(value => h('option', { value, key: value }, t(`fault_${value.replaceAll('-', '_')}`)))))),
                  h('p', { className: 'sgym-muted sgym-small sgym-section' }, t('referenceParameters'))),
                h('button', { type: 'submit', className: 'sgym-btn sgym-btn-primary sgym-full', disabled: Boolean(busy) || !snapshot || !scenarios.length || (driver === 'dsh' && !capabilities.dshAgent) }, busy === 'create' ? t('starting') : t(driver === 'reference' ? 'start' : driver === 'dsh' ? 'startDsh' : 'startExternal')),
                !capabilities.dshAgent && snapshot && h('p', { className: 'sgym-muted sgym-small' }, t('dshUnavailable'))));
          }
          function historyPanel() {
            return h('section', { className: 'sgym-card' }, h('div', { className: 'sgym-card-head' }, h('h2', null, t('history')), h('span', { className: 'sgym-muted sgym-small' }, t('historyCount', { count: runs.length }))),
              runs.length ? h('ul', { className: 'sgym-history' }, runs.map(item => h('li', { key: item.id }, h('button', { type: 'button', className: 'sgym-history-item', 'aria-pressed': selectedId === item.id, onClick: () => chooseRun(item.id) },
                h('span', { className: 'sgym-row sgym-between' }, h('strong', { className: 'sgym-history-title' }, item.name || item.id), h(Badge, { status: item.status })),
                h('span', { className: 'sgym-muted sgym-small' }, dateLabel(item.createdAt, locale)),
                h('span', { className: 'sgym-muted sgym-small' }, `${modeLabel(item.config?.evaluationMode)} · ${progressLabel(item)} ${progressValue(item)}`), h('code', { className: 'sgym-muted' }, item.id))))) : h('div', { className: 'sgym-card-body sgym-stack' }, h('p', null, t('historyEmpty')), h('p', { className: 'sgym-muted sgym-small' }, t('historyHelp'))));
          }
          function overviewPanel() {
            const metrics = [[progressLabel(safeRun), progressValue(safeRun)], [t('inputCount'), `${safeRun.metrics?.injectedInputs ?? 0} / ${safeRun.metrics?.scheduledInputs ?? 0}`], [t('toolCalls'), safeRun.metrics?.toolCalls ?? 0], [t('elapsed'), duration(safeRun.metrics?.elapsedMs)]];
            return h('div', { className: 'sgym-stack' }, h('div', { className: 'sgym-metrics' }, metrics.map(([label, value]) => h(Metric, { label, value, key: label }))),
              h(Metadata, { entries: [[t('runId'), h('code', null, safeRun.id)], [t('createdAt'), dateLabel(safeRun.createdAt, locale)], [t('finishedAt'), dateLabel(safeRun.finishedAt, locale)], [t('declaredTasks'), safeRun.metrics?.completedTasks ?? 0], [t('pendingTasks'), safeRun.metrics?.pendingTasks ?? 0], [t('injectionLag'), duration(safeRun.metrics?.maxInjectionLagMs)]] }),
              isOutcome(safeRun) && safeRun.factReport && h(Note, { kind: safeRun.factReport.needsJudge ? 'warning' : '' }, outcomeMessage(safeRun)),
              safeRun.error && h(Note, { kind: 'error' }, safeRun.error),
              h('h3', null, t('sessionBindings')), h(BindingList, { bindings, busy, onCancel: cancelAgent, locale }),
              runDriver === 'external' && h('details', { className: 'sgym-item', open: true }, h('summary', null, t('tokenTitle')),
                h('div', { className: 'sgym-stack' },
                  h(Note, { kind: 'warning' }, t('tokenNote')),
                  h('p', { className: 'sgym-wrap sgym-small' }, t('externalProtocol', { endpoint: connections[selectedId]?.endpoint || endpoint('target') })),
                  connections[selectedId]?.connectionNote && h(Note, null, connections[selectedId].connectionNote),
                  !tokens[selectedId] && h(Note, { kind: 'warning' }, connections[selectedId]?.tokenNotice || t('tokenMissing')),
                  tokens[selectedId] && h(React.Fragment, null, h('code', { className: 'sgym-inline-code' }, tokens[selectedId]), h('div', null, btn(t(copied ? 'copied' : 'copyToken'), copyToken))),
                  h('details', null, h('summary', null, t('requestExample')), h('pre', null, pretty({ runId: safeRun.id, targetToken: t('tokenPlaceholder'), request: { action: 'inspect' } })), h('p', { className: 'sgym-muted sgym-small sgym-section' }, t('externalActions'))))),
              h('details', { className: 'sgym-item' }, h('summary', null, t('runConfig')), h('pre', null, pretty(safeRun.config))),
              safeRun.manifest && h('details', { className: 'sgym-item' }, h('summary', null, t('rawManifest')), h('pre', null, pretty(safeRun.manifest))));
          }
          function tasksPanel() {
            if (!list(safeRun.tasks).length) return h(Empty, { title: t('noTasks') });
            return h('div', { className: 'sgym-stack' }, list(safeRun.tasks).map(task => h('details', { className: 'sgym-item', key: task.id },
              h('summary', null, h('span', { className: 'sgym-wrap' }, h('code', null, task.id), ' · ', h('strong', null, task.title)), h('span', { className: 'sgym-row' }, task.introduced === false && h('span', { className: 'sgym-muted sgym-small' }, t('notIntroduced')), h(Badge, { status: task.status }))),
              h('div', { className: 'sgym-stack' }, h(Metadata, { entries: [[t('owner'), actorName(task.ownerId)], [t('channel'), channelName(task.channelId)], [t('dependencies'), list(task.dependencies).join(', ') || t('none')]] }), h('h3', null, t('instructions')), h('p', { className: 'sgym-wrap' }, task.instructions), task.detail && h(Note, null, task.detail),
                list(task.inputs).length > 0 && h('div', null, h('h3', null, t('inputs')), h(Refs, { refs: task.inputs })),
                list(task.deliverables).length > 0 && h('div', null, h('h3', null, t('expectedOutputs')), h(Refs, { refs: task.deliverables })),
                list(task.artifactPaths).length > 0 && h('div', null, h('h3', null, t('producedOutputs')), h('ul', null, task.artifactPaths.map(path => h('li', { key: path }, artifactLink(path)))))))));
          }
          function eventsPanel() {
            const needle = eventFilter.trim().toLocaleLowerCase();
            const visible = events.filter(item => !needle || [item.text, item.type, item.role, item.taskId, actorName(item.actorId), channelName(item.channelId)].some(value => text(value).toLocaleLowerCase().includes(needle)));
            return h('div', { className: 'sgym-stack' }, h(Field, { label: t('filterEvents') }, h('input', { className: 'sgym-input', type: 'search', value: eventFilter, placeholder: t('filterPlaceholder'), onChange: event => setEventFilter(event.target.value) })), h('p', { className: 'sgym-muted sgym-small' }, t('loadedEvents', { count: events.length })), pageError && h(Note, { kind: 'error' }, pageError),
              !visible.length ? h('p', { className: 'sgym-muted' }, t(events.length ? 'noMatches' : 'noEvents')) : h('div', { 'aria-label': t('timeline') }, visible.map(item => h('article', { className: 'sgym-event', key: item.id },
                h('div', { className: 'sgym-event-meta' }, h('code', null, `#${item.seq}`), h('time', { dateTime: item.at }, dateLabel(item.at, locale, true)), h('span', null, roleLabel(item.role)), item.actorId && h('span', null, actorName(item.actorId)), item.channelId && h('span', null, channelName(item.channelId)), item.taskId && h('code', null, item.taskId), h('code', { title: t('eventType') }, item.type)), h('p', null, item.text), item.data && h('details', null, h('summary', { className: 'sgym-muted sgym-small' }, t('eventData')), h('pre', null, pretty(item.data)))))),
              h('div', { className: 'sgym-pagination' }, btn(t(pageBusy ? 'loadingMore' : 'loadMore'), loadEvents, pageBusy || (!moreEvents && !pageError)), !moreEvents && !pageBusy && h('span', { className: 'sgym-muted sgym-small' }, t('caughtUp'))));
          }
          function artifactsPanel() {
            return h('div', { className: 'sgym-stack' }, h('p', { className: 'sgym-muted sgym-small' }, t('artifactHelp')),
              !list(safeRun.artifacts).length ? h('p', { className: 'sgym-muted' }, t('noArtifacts')) : h('ul', { className: 'sgym-list' }, safeRun.artifacts.map(artifact => h('li', { className: 'sgym-item', key: artifact.path },
                h('div', { className: 'sgym-row' }, h('div', { className: 'sgym-artifact-name' }, h('code', null, artifact.path), h('p', { className: 'sgym-muted sgym-small' }, `${t('bytes', { count: Number(artifact.bytes || 0).toLocaleString() })}${artifact.mime ? ` · ${artifact.mime}` : ''}`)), btn(previewBusy === artifact.path ? t('loading') : t('preview'), () => showPreview(artifact), previewBusy === artifact.path), h('a', { className: 'sgym-btn', href: downloadLink(artifact), download: true }, t('download'))),
                artifact.sha256 && h('details', { className: 'sgym-section sgym-small' }, h('summary', { className: 'sgym-muted' }, t('sha256')), h('code', null, artifact.sha256))))),
              h('section', { className: 'sgym-stack sgym-section', 'aria-label': t('previewTitle'), 'aria-busy': Boolean(previewBusy) }, h('h3', null, t('previewTitle')), previewError && h(Note, { kind: 'error', title: t('previewFailed') }, previewError),
                previewBusy ? h('p', { className: 'sgym-muted', role: 'status' }, t('loading')) : preview ? h(React.Fragment, null, h('div', { className: 'sgym-row sgym-between' }, h('code', null, preview.path), btn(t('close'), () => setPreview(null))), preview.binary ? h(Note, null, t('binaryPreview')) : h('pre', { tabIndex: 0 }, text(preview.content)), preview.truncated && h(Note, { kind: 'warning' }, t('truncated'))) : h('p', { className: 'sgym-muted sgym-small' }, t('previewEmpty'))));
          }
          function factsPanel() {
            const facts = safeRun.factReport;
            return h('div', { className: 'sgym-stack' }, h(Note, null, t('factsHelp')),
              !facts ? h(Empty, { title: t('factsPending') }, t('factsPendingHelp')) : h(React.Fragment, null,
                isOutcome(safeRun) && h(Note, { kind: facts.needsJudge ? 'warning' : '' }, outcomeMessage(safeRun), h('p', { className: 'sgym-section' }, `${t('independentlyConfirmed')}: ${facts.tasksPassed} / ${facts.tasksTotal}`)),
                h('div', { className: 'sgym-row sgym-between' }, h('h3', null, `${progressLabel(safeRun)}: ${progressValue(safeRun)}`), isSealed && h('a', { className: 'sgym-btn', href: endpoint('evidence', { runId: selectedId }), download: true }, t('evidenceDownload'))), h('p', { className: 'sgym-wrap' }, facts.summary),
                list(facts.limitations).length > 0 && h(Note, { kind: 'warning', title: t('limitations') }, h('ul', null, facts.limitations.map((item, index) => h('li', { key: index }, item)))),
                h('div', { className: 'sgym-stack' }, list(facts.assertions).map(assertion => h('details', { className: 'sgym-item', key: assertion.id }, h('summary', null, h('strong', { className: 'sgym-wrap' }, assertion.name), h(Badge, { status: assertion.status })), h('p', { className: 'sgym-wrap' }, assertion.detail), h(Refs, { refs: assertion.evidenceRefs }))))));
          }
          function reviewsPanel() {
            return h('div', { className: 'sgym-stack' }, h(Note, null, t('judgeHelp')), h('p', { className: 'sgym-muted sgym-small' }, t('judgeCost')),
              h('div', { className: 'sgym-row' }, btn(t(judgeActive ? 'judgeRunning' : 'judge'), startJudge, Boolean(busy) || !isSealed || !capabilities.judge || judgeActive, 'sgym-btn-primary'), isSealed && h('a', { className: 'sgym-btn', href: endpoint('evidence', { runId: selectedId }), download: true }, t('evidenceDownload'))),
              !isSealed && h('p', { className: 'sgym-muted sgym-small' }, t('sealedOnly')), !capabilities.judge && h('p', { className: 'sgym-muted sgym-small' }, t('judgeUnavailable')),
              h(BindingList, { bindings: bindings.filter(item => item.role === 'judge'), busy, onCancel: cancelAgent, locale }), !list(safeRun.reviews).length && h('p', { className: 'sgym-muted' }, t('noReviews')),
              list(safeRun.reviews).map(review => h('section', { className: 'sgym-item sgym-stack', key: review.id }, h('div', { className: 'sgym-row sgym-between' }, h('span', { className: 'sgym-small' }, `${review.provider || t('unknown')} · ${dateLabel(review.at, locale)}`), h(Badge, { status: review.status })), h('code', { className: 'sgym-muted' }, review.id), review.error && h(Note, { kind: 'error' }, review.error), review.needsHumanReview && h(Note, { kind: 'warning' }, t('humanReview')),
                list(review.dimensions).map((dimension, index) => h('div', { className: 'sgym-item', key: `${dimension.name}-${index}` }, h('div', { className: 'sgym-row sgym-between' }, h('strong', null, dimension.name), dimension.status === 'scored' ? h('span', { className: 'sgym-score' }, `${dimension.score} / 5`) : h(Badge, { status: dimension.status })), h('p', { className: 'sgym-wrap sgym-section' }, dimension.reason), h(Refs, { refs: dimension.evidenceRefs }))), review.usage && h('details', null, h('summary', null, t('usage')), h('pre', null, pretty(review.usage))))),
              h('details', { className: 'sgym-item' }, h('summary', null, t('importReview')), h('form', { className: 'sgym-section sgym-stack', onSubmit: importReview }, h('p', { className: 'sgym-muted sgym-small' }, t('importHelp')), h(Field, { label: t('reviewJson') }, h('textarea', { className: 'sgym-input', value: reviewJson, spellCheck: false, required: true, disabled: !isSealed || Boolean(busy), onChange: event => setReviewJson(event.target.value) })), h('div', null, h('button', { type: 'submit', className: 'sgym-btn', disabled: Boolean(busy) || !isSealed || !reviewJson.trim() }, t(busy === 'import' ? 'importing' : 'importSubmit'))))));
          }
          function comparePanel() {
            const left = { ...safeRun.config, driver: driverOf(safeRun, allBindings), evaluationMode: safeRun.config?.evaluationMode || 'protocol' };
            const right = comparison ? { ...comparison.config, driver: driverOf(comparison, allBindings), evaluationMode: comparison.config?.evaluationMode || 'protocol' } : {};
            const differences = comparison ? [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key])) : [];
            const rows = comparison ? [
              ['submittedTasks', typeof safeRun.factReport?.tasksSubmitted === 'number' ? `${safeRun.factReport.tasksSubmitted} / ${safeRun.factReport.tasksTotal}` : t('none'), typeof comparison.factReport?.tasksSubmitted === 'number' ? `${comparison.factReport.tasksSubmitted} / ${comparison.factReport.tasksTotal}` : t('none')],
              ['independentlyConfirmed', safeRun.factReport ? `${safeRun.factReport.tasksPassed} / ${safeRun.factReport.tasksTotal}` : t('factsPending'), comparison.factReport ? `${comparison.factReport.tasksPassed} / ${comparison.factReport.tasksTotal}` : t('factsPending')], ['declaredTasks', safeRun.metrics?.completedTasks, comparison.metrics?.completedTasks], ['failedTasks', safeRun.metrics?.failedTasks, comparison.metrics?.failedTasks], ['inputCount', safeRun.metrics?.injectedInputs, comparison.metrics?.injectedInputs], ['toolCalls', safeRun.metrics?.toolCalls, comparison.metrics?.toolCalls], ['replies', safeRun.metrics?.replies, comparison.metrics?.replies], ['elapsed', duration(safeRun.metrics?.elapsedMs), duration(comparison.metrics?.elapsedMs)], ['injectionLag', duration(safeRun.metrics?.maxInjectionLagMs), duration(comparison.metrics?.maxInjectionLagMs)],
            ] : [];
            return h('div', { className: 'sgym-stack' }, h(Field, { label: t('selectCompare') }, h('select', { className: 'sgym-input', value: compareId === selectedId ? '' : compareId, onChange: event => setCompareId(event.target.value) }, h('option', { value: '' }, t('noCompare')), runs.filter(item => item.id !== selectedId).map(item => h('option', { key: item.id, value: item.id }, `${item.name} · ${dateLabel(item.createdAt, locale)} · ${item.id}`)))), h('p', { className: 'sgym-muted sgym-small' }, t('compareScope')), compareError && h(Note, { kind: 'error', title: t('compareFailed') }, compareError), compareId && compareId !== selectedId && !comparison && !compareError && h('p', { role: 'status' }, t('compareLoading')),
              comparison && h(React.Fragment, null, h(Note, { kind: differences.length ? 'warning' : '' }, t(differences.length ? 'conditionsDifferent' : 'conditionsSame'), differences.length > 0 && h('p', { className: 'sgym-section' }, `${t('differingFields')}: ${differences.map(key => Object.hasOwn(zh, key) ? t(key) : key).join(', ')}`)), (!sealed(safeRun) || !sealed(comparison)) && h(Note, { kind: 'warning' }, t('compareUnsealed')),
                isOutcome(safeRun) && safeRun.factReport && h(Note, { kind: 'warning' }, `${t('current')}: ${outcomeMessage(safeRun)}`),
                isOutcome(comparison) && comparison.factReport && h(Note, { kind: 'warning' }, `${t('baseline')}: ${outcomeMessage(comparison)}`),
                h('div', { className: 'sgym-table-wrap' },
                  h('table', { className: 'sgym-table' },
                    h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('metric')), h('th', { scope: 'col' }, t('current')), h('th', { scope: 'col' }, t('baseline')))),
                    h('tbody', null,
                      h('tr', null, h('th', { scope: 'row' }, t('runId')), h('td', null, h('code', null, safeRun.id)), h('td', null, h('code', null, comparison.id))),
                      rows.map(([key, a, b]) => h('tr', { key }, h('th', { scope: 'row' }, t(key)), h('td', null, a ?? t('unknown')), h('td', null, b ?? t('unknown')))),
                      differences.map(key => h('tr', { key: `condition-${key}` }, h('th', { scope: 'row' }, Object.hasOwn(zh, key) ? t(key) : key), h('td', null, text(left[key]) || t('none')), h('td', null, text(right[key]) || t('none'))))
                    )
                  )
                )
              )
            );
          }
          const tabs = ['overview', 'tasks', 'timeline', 'artifacts', 'facts', 'reviews', 'compare'];
          const panels = { overview: overviewPanel, tasks: tasksPanel, timeline: eventsPanel, artifacts: artifactsPanel, facts: factsPanel, reviews: reviewsPanel, compare: comparePanel };
          function tabKeyDown(event, index) {
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabs.length - 1;
            if (next === undefined) return;
            event.preventDefault(); setTab(tabs[next]);
            // Only this component's tablist is traversed, never another plugin's DOM.
            event.currentTarget.parentElement?.children[next]?.focus();
          }
          return h('div', { className: 'sgym' }, h('style', null, css), h('div', { className: 'sgym-shell' },
            h('header', { className: 'sgym-header' }, h('div', { className: 'sgym-heading' }, h('span', { className: 'sgym-mark' }, h(GymIcon, { size: 30, active: true })), h('div', null, h('h1', null, t('title')), h('p', { className: 'sgym-subtitle' }, t('subtitle')))), btn(t('refresh'), bump)),
            snapshotError && h('div', { className: 'sgym-section' }, h(Note, { kind: 'error', title: t('loadFailed') }, snapshotError, h('p', { className: 'sgym-section' }, t('apiHint')))), !snapshot && !snapshotError && h('p', { role: 'status', className: 'sgym-muted' }, t('loading')),
            h('div', { className: 'sgym-layout sgym-section' }, h('aside', { className: 'sgym-sidebar', 'aria-label': t('newRun') }, configForm(), historyPanel(), snapshot && h('section', { className: 'sgym-card' }, h('div', { className: 'sgym-card-head' }, h('h2', null, t('catalog'))), h('div', { className: 'sgym-card-body sgym-stack' }, h(Metadata, { entries: [[t('actors'), list(snapshot.catalog?.actors).length], [t('channels'), list(snapshot.catalog?.channels).length], [t('subjects'), list(snapshot.catalog?.subjects).length], [t('scenarios'), list(snapshot.catalog?.scenarios).length]] }), h('p', { className: 'sgym-muted sgym-small' }, t('syntheticNote'))))),
              h('main', { className: 'sgym-main', 'aria-label': t('selectedRun') }, actionError && h(Note, { kind: 'error' }, actionError), notice && h(Note, { kind: 'success', live: true }, notice), detailError && h(Note, { kind: 'error', title: t('detailFailed') }, detailError),
                !selectedId ? h('section', { className: 'sgym-card' }, h(Empty, { title: t('emptyTitle') }, t('emptyBody'))) : !safeRun ? h('section', { className: 'sgym-card' }, h(Empty, { title: t('loading') })) : h(React.Fragment, null,
                  h('section', { className: 'sgym-card' }, h('div', { className: 'sgym-card-body sgym-stack' }, h('div', { className: 'sgym-row sgym-between' }, h('h2', { className: 'sgym-wrap' }, safeRun.name || safeRun.id), h(Badge, { status: safeRun.status })), h(Note, { kind: runDriver === 'dsh' ? 'warning' : '' }, t(runDriver === 'reference' ? 'scopeReference' : runDriver === 'dsh' ? 'scopeModel' : 'scopeExternal'), h('p', { className: 'sgym-section' }, t('modeLabel', { mode: modeLabel(safeRun.config?.evaluationMode) }))), activeRun(safeRun.status) && h(React.Fragment, null, h('div', { className: 'sgym-row' }, btn(t('drain'), () => control('drain'), Boolean(busy) || safeRun.status === 'draining'), btn(t('stop'), () => control('stop'), Boolean(busy), 'sgym-btn-danger')), h('p', { className: 'sgym-muted sgym-small' }, t('stopHint'))))),
                  h('section', { className: 'sgym-card' }, h('div', { className: 'sgym-tabs', role: 'tablist', 'aria-label': t('selectedRun') }, tabs.map((key, index) => h('button', { type: 'button', key, className: 'sgym-tab', id: `${uid}-tab-${key}`, role: 'tab', 'aria-selected': tab === key, 'aria-controls': `${uid}-panel`, tabIndex: tab === key ? 0 : -1, onClick: () => setTab(key), onKeyDown: event => tabKeyDown(event, index) }, t(key)))), h('div', { className: 'sgym-panel', id: `${uid}-panel`, role: 'tabpanel', 'aria-labelledby': `${uid}-tab-${tab}`, tabIndex: 0 }, panels[tab]()))))),
            snapshot && h('footer', { className: 'sgym-footer' }, h('span', null, `${t('version')}: ${snapshot.version || t('unknown')}`), snapshot.runtimeDir && h('details', { className: 'sgym-section' }, h('summary', null, t('runtimeDir')), h('code', null, snapshot.runtimeDir)))));
        }
        // The owning context disposes every locale and slot registration.
        ctx.effect(() => {
          const disposers = [
            ctx.locale.register(NS, 'en', en), ctx.locale.register(NS, 'zh', zh), ctx.locale.register(NS, 'zh-CN', zh),
            ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'shiyu-gym', locale: NS }, GymPanel)),
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'shiyu-gym', order: -5, label: () => t('title'), locale: NS }, GymIcon)),
          ];
          return () => { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose(); };
        });
      },
    };
  },
});
