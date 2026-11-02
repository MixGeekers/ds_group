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
        function dateTime(value, locale) {
          if (!value) return t('unknownValue');
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return t('unknownValue');
          try { return date.toLocaleString(locale || 'zh', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
          catch { return date.toISOString(); }
        }
        async function api(name, { signal, action } = {}) {
          let response;
          try {
            response = await fetch(endpoint(name), { method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
              ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : {}) });
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
        function RuntimePanel() {
          const locale = useSyncExternalStore(subscribe, getLocale, getLocale).active;
          const [snapshot, setSnapshot] = useState(null);
          const [readError, setReadError] = useState('');
          const [loading, setLoading] = useState(true);
          const [lastRead, setLastRead] = useState(null);
          const [clock, setClock] = useState(Date.now());
          const [tab, setTab] = useState('overview');
          const [selectedSession, setSelectedSession] = useState(null);
          const [command, setCommand] = useState('');
          const [commandError, setCommandError] = useState('');
          const [commandNotice, setCommandNotice] = useState('');
          const rootRef = useRef(null);
          const operations = useRef({ refresh: () => {}, command: () => {} });
          useEffect(() => {
            if (disposed) return;
            let alive = true, panelVisible = Boolean(rootRef.current?.getClientRects().length), reading = null, writing = null, commandInFlight = false;
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
            async function issue(action) {
              if (!alive || disposed || commandInFlight) return;
              commandInFlight = true; setCommand(action); setCommandError(''); setCommandNotice('');
              const controller = new AbortController(); writing = controller;
              const timeout = setTimeout(() => controller.abort(), 20000);
              try {
                const result = await api('commands', { signal: controller.signal, action });
                if (action === 'session.probe' && (result?.ready !== true || result?.noModelCalled !== true || result?.released !== true || result?.archived !== true)) throw new Error(t('probeUnconfirmed'));
                if (!alive || disposed) return;
                const refreshed = await refresh(true);
                if (alive && !disposed && refreshed) setCommandNotice(t(action === 'session.probe' ? 'probeDone' : action === 'runtime.pause' ? 'pausedDone' : 'resumedDone'));
              } catch (error) {
                if (alive && !disposed) { setCommandError(controller.signal.aborted ? t('commandUncertain') : error.message || t('commandFailed')); await refresh(true); }
              } finally {
                clearTimeout(timeout); writing = null; commandInFlight = false;
                if (alive && !disposed) setCommand('');
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
              reading?.abort(); writing?.abort(); clearInterval(timer); observer?.disconnect();
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
          const canCommand = Boolean(snapshot && !stale && snapshot.lifecycle !== 'stopping' && !command);
          const work = arr(snapshot?.activeWork), activities = arr(snapshot?.activities), sessions = arr(snapshot?.sessions);
          const systems = arr(snapshot?.systems), dependencies = arr(snapshot?.dependencies), notices = arr(snapshot?.notices);
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
          function diagnostics() {
            return h('div', { className: 'syr-stack' },
              h('section', { className: 'syr-box syr-diagnostic-head' }, h('div', null, h('h2', null, t('diagnostics')), h('p', { className: 'syr-small syr-muted' }, t('probeHint'))), h(Button, { disabled: !canCommand, onClick: () => void operations.current.command('session.probe') }, t(command === 'session.probe' ? 'probing' : 'probe'))),
              h('div', { className: 'syr-columns' },
                h('section', { className: 'syr-box' }, h(Title, null, t('dependencies')), dependencies.length ? dependencies.map(item => h('div', { key: item.id, className: 'syr-dependency' }, h('div', { className: 'syr-row syr-between' }, h('h3', null, item.name), h(Status, { value: item.status })), h('p', null, item.summary), item.checkedAt && h('p', null, `${t('checked')} · ${dateTime(item.checkedAt, locale)}`))) : h(Empty, null, t('noDependencies'))),
                h('section', { className: 'syr-box' }, h(Title, null, t('usage')), h(Facts, { rows: [['calls', numeric(snapshot.usage?.calls)], ...usageRows(snapshot.usage)] }), h('p', { className: 'syr-small syr-muted syr-section-gap' }, t('usageHint')))),
              h('section', null, h(Title, null, t('subscriptions')), arr(snapshot.events?.subscriptions).length ? h('div', null, ...snapshot.events.subscriptions.map(item => h('div', { key: item.id, className: 'syr-entry' }, h('div', { className: 'syr-row syr-between' }, h('span', { className: 'syr-code' }, item.type), h(Status, { value: item.status })), h('p', { className: 'syr-muted' }, `${t('target')} · ${text(item.target)}`)))) : h(Empty, null, t('noSubscriptions'))),
              h('section', null, h(Title, null, t('recentEvents')), eventMetrics(), arr(snapshot.events?.recent).length ? h('ol', { className: 'syr-timeline' }, ...snapshot.events.recent.map(item => h('li', { key: item.id }, h('time', { dateTime: item.at }, dateTime(item.at, locale)), h('span', { className: 'syr-code' }, item.type), h(Status, { value: item.status })))) : h(Empty, null, t('noEvents'))),
              h('section', { className: 'syr-box' }, h(Facts, { rows: [['instance', snapshot.instanceId, true], ['version', snapshot.version], ['lifecycle', label(snapshot.lifecycle)], ['started', dateTime(snapshot.startedAt, locale)], ['observed', dateTime(snapshot.observedAt, locale)]] })));
          }
          return h('div', { className: 'syr', ref: rootRef }, h('style', null, css), h('div', { className: 'syr-wrap' },
            h('header', { className: 'syr-header' }, h('div', { className: 'syr-brand' }, h(Icon, { size: 27 }), h('div', null, h('h1', null, t('title')), h('div', { className: 'syr-meta' }, snapshot && h('span', null, `v${snapshot.version}`), h('span', null, t('source'))))),
              h('div', { className: 'syr-actions' }, snapshot && h(Button, { icon: state === 'paused' ? 'play' : 'pause', disabled: !canCommand, onClick: () => void operations.current.command(state === 'paused' ? 'runtime.resume' : 'runtime.pause') }, t(state === 'paused' ? 'resume' : 'pause')), h(Button, { icon: 'refresh', disabled: loading, onClick: () => void operations.current.refresh(), 'aria-label': t('refresh'), 'aria-busy': loading }, t(loading ? 'refreshing' : 'refresh')))),
            h('nav', { className: 'syr-tabs', 'aria-label': t('title') }, ...['overview', 'systems', 'sessions', 'diagnostics'].map(id => h('button', { type: 'button', className: 'syr-tab', key: id, 'aria-current': tab === id ? 'page' : undefined, onClick: () => setTab(id) }, t(id)))),
            stale && h('div', { className: 'syr-alert', role: 'alert', 'data-testid': 'snapshot-stale' }, h('strong', null, t(snapshot ? 'staleTitle' : 'loadFailed')), h('p', null, readError || t('snapshotOld')), snapshot && h('p', null, t('staleHint'))),
            commandError && h('div', { className: 'syr-alert', role: 'alert' }, h('strong', null, t('commandFailed')), commandError),
            commandNotice && h('p', { className: 'syr-feedback', role: 'status' }, commandNotice),
            command && h('p', { className: 'syr-feedback', role: 'status' }, t('controlPending')),
            snapshot ? (tab === 'overview' ? overview() : tab === 'systems' ? systemContent() : tab === 'sessions' ? sessionContent() : diagnostics()) : !readError && h('p', { className: 'syr-loading', role: 'status' }, t('loading')),
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
