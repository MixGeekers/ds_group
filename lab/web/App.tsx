import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight, BarChart3, Bot, Briefcase, Check,
  CheckCircle2, ChevronDown, ChevronRight, Clock, Copy, Cpu, Database, Download,
  ExternalLink, FileText, FlaskConical, GitCompare, Layers, Loader2, MessageSquare,
  Play, Plus, Radio, RefreshCw, Search, Server, Settings2, ShieldCheck, Square, Users, X, Zap,
} from 'lucide-react';
import type {
  Artifact, Assertion, Catalog, LabEvent, ReviewResult, Role, RunConfig, RunDetail,
  RunStatus, RunSummary, TaskRecord, TaskStatus,
} from '../src/types';

type Tab = 'overview' | 'timeline' | 'tasks' | 'artifacts' | 'evaluation' | 'compare';
type Settings = { judgeConfigured: boolean; version: string };
const active = (status?: RunStatus) => ['prepared', 'running', 'draining'].includes(status ?? '');
const statusNames: Record<RunStatus | TaskStatus, string> = {
  prepared: '准备中', running: '运行中', draining: '排空中', completed: '已完成',
  stopped: '已停止', interrupted: '已中断', failed: '失败', queued: '排队中',
  waiting: '等待中', cancelled: '已取消',
};
const roleNames: Record<Role, string> = { core: '核心', worker: '执行者', replyer: '回复者', world: '公司', lab: '实验室', memory: '记忆' };
const defaultConfig: RunConfig = {
  scenarioId: 'mixed-office', target: 'reference', seed: 42, noiseCount: 60,
  speed: 10, workerConcurrency: 2, taskDelayMs: 800, fault: 'none', maxDurationMs: 60000,
};
const tabs: Array<{ key: Tab; label: string; icon: typeof Activity }> = [
  { key: 'overview', label: '运行总览', icon: Activity },
  { key: 'timeline', label: '信息流', icon: MessageSquare },
  { key: 'tasks', label: '工作任务', icon: Layers },
  { key: 'artifacts', label: '交付产物', icon: FileText },
  { key: 'evaluation', label: '验收与评分', icon: ShieldCheck },
  { key: 'compare', label: '实验对比', icon: GitCompare },
];

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message ?? body?.error ?? `请求失败（${response.status}）`);
  return body as T;
}
const humanTime = (date: string) => new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const humanDate = (date: string) => new Date(date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function Badge({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`badge badge-${status}`}><span className="badge-dot" />{children ?? statusNames[status as RunStatus] ?? status}</span>;
}
function Empty({ icon: Icon = Layers, title, children }: { icon?: typeof Activity; title: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon size={25} /></span><strong>{title}</strong><p>{children}</p></div>;
}
function Metric({ label, value, detail, icon: Icon }: { label: string; value: ReactNode; detail: string; icon: typeof Activity }) {
  return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={17} /></div><strong>{value}</strong><small>{detail}</small></div>;
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [settings, setSettings] = useState<Settings>({ judgeConfigured: false, version: '0.1.0' });
  const [booting, setBooting] = useState(true);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const selectedRef = useRef<string | undefined>(undefined);
  selectedRef.current = selectedId;
  const [run, setRun] = useState<RunDetail>();
  const [draft, setDraft] = useState<RunConfig>(defaultConfig);
  const [tab, setTab] = useState<Tab>('overview');
  const [creating, setCreating] = useState(false);
  const [command, setCommand] = useState<string>();
  const [live, setLive] = useState(false);
  const [targetTokens, setTargetTokens] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [preview, setPreview] = useState<{ path: string; content: string; truncated: boolean }>();
  const [previewBusy, setPreviewBusy] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [comparisonId, setComparisonId] = useState('');
  const createKey = useRef<string | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewAbort.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBooting(true);
    Promise.all([
      request<Catalog>('/api/catalog', { signal: controller.signal }),
      request<RunSummary[]>('/api/runs', { signal: controller.signal }),
      request<Settings>('/api/config', { signal: controller.signal }),
    ]).then(([data, history, config]) => {
      setCatalog(data); setRuns(history); setSettings(config); setError('');
      setDraft(current => ({ ...current, scenarioId: data.scenarios.some(s => s.id === current.scenarioId) ? current.scenarioId : data.scenarios[0]?.id ?? '' }));
    }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setBooting(false); });
    return () => controller.abort();
  }, [bootAttempt]);

  useEffect(() => {
    if (!selectedId) { setRun(undefined); setLive(false); return; }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let pending = false;
    setRun(undefined); setPreview(undefined); setPreviewError(''); previewAbort.current?.abort();
    const refresh = async () => {
      if (loading) { pending = true; return; }
      loading = true;
      try {
        const [detail, history] = await Promise.all([
          request<RunDetail>(`/api/runs/${encodeURIComponent(selectedId)}`, { signal: controller.signal }),
          request<RunSummary[]>('/api/runs', { signal: controller.signal }),
        ]);
        if (!controller.signal.aborted) { setRun(detail); setRuns(history); }
      } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
      finally { loading = false; if (pending && !controller.signal.aborted) { pending = false; void refresh(); } }
    };
    void refresh();
    const events = new EventSource(`/api/runs/${encodeURIComponent(selectedId)}/events?after=0`);
    events.onopen = () => { if (!controller.signal.aborted) setLive(true); };
    events.onerror = () => { if (!controller.signal.aborted) setLive(false); };
    events.addEventListener('lab', () => {
      if (timeout === undefined) timeout = setTimeout(() => { timeout = undefined; void refresh(); }, 180);
    });
    const poll = setInterval(() => void refresh(), 4000);
    return () => { controller.abort(); events.close(); clearTimeout(timeout); clearInterval(poll); setLive(false); };
  }, [selectedId]);

  useEffect(() => {
    if (importOpen && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!importOpen && dialogRef.current?.open) dialogRef.current?.close();
  }, [importOpen]);

  const updateDraft = <K extends keyof RunConfig>(key: K, value: RunConfig[K]) => {
    createKey.current = null;
    setDraft(current => ({ ...current, [key]: value }));
  };
  const chooseRun = (id: string) => { setSelectedId(id); setTab('overview'); setSearch(''); setRoleFilter(''); setChannelFilter(''); setError(''); };
  const refreshRun = async (id: string) => {
    const [detail, history] = await Promise.all([request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`), request<RunSummary[]>('/api/runs')]);
    if (mounted.current) { if (selectedRef.current === id) setRun(detail); setRuns(history); }
  };
  const startRun = async () => {
    setCreating(true); setError('');
    createKey.current ??= crypto.randomUUID();
    try {
      const result = await request<{ run: RunDetail; targetToken?: string }>('/api/runs', {
        method: 'POST', body: JSON.stringify({ config: draft, idempotencyKey: createKey.current }),
      });
      if (!mounted.current) return;
      if (result.targetToken) setTargetTokens(current => ({ ...current, [result.run.id]: result.targetToken! }));
      setRuns(current => [result.run, ...current.filter(r => r.id !== result.run.id)]);
      chooseRun(result.run.id); createKey.current = null;
    } catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { if (mounted.current) setCreating(false); }
  };
  const control = async (value: 'drain' | 'stop') => {
    if (!run) return;
    setCommand(value); setError('');
    try { await request(`/api/runs/${run.id}/control`, { method: 'POST', body: JSON.stringify({ command: value }) }); await refreshRun(run.id); }
    catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { if (mounted.current) setCommand(undefined); }
  };
  const showArtifact = async (artifact: Artifact) => {
    if (!run) return;
    setTab('artifacts'); setPreview(undefined); setPreviewError(''); setPreviewBusy(artifact.path);
    previewAbort.current?.abort(); const controller = new AbortController(); previewAbort.current = controller;
    try {
      const value = await request<{ path: string; content: string; truncated: boolean }>(`/api/runs/${run.id}/preview?path=${encodeURIComponent(artifact.path)}`, { signal: controller.signal });
      if (!controller.signal.aborted) setPreview(value);
    } catch (error) { if (!controller.signal.aborted) setPreviewError(errorText(error)); }
    finally { if (!controller.signal.aborted) setPreviewBusy(''); }
  };
  const startReview = async () => {
    if (!run) return; setReviewBusy(true); setError('');
    try { await request(`/api/runs/${run.id}/reviews`, { method: 'POST', body: '{}' }); await refreshRun(run.id); }
    catch (error) { if (mounted.current) setError(errorText(error)); }
    finally { if (mounted.current) setReviewBusy(false); }
  };
  const importReview = async () => {
    if (!run) return; setReviewBusy(true); setImportError('');
    try {
      const review = JSON.parse(importText);
      await request(`/api/runs/${run.id}/reviews/import`, { method: 'POST', body: JSON.stringify({ review }) });
      await refreshRun(run.id); if (mounted.current) { setImportOpen(false); setImportText(''); }
    } catch (error) { if (mounted.current) setImportError(errorText(error)); }
    finally { if (mounted.current) setReviewBusy(false); }
  };

  const actorName = useCallback((id?: string) => catalog?.actors.find(a => a.id === id)?.name ?? id ?? '实验室', [catalog]);
  const channelName = (id?: string) => catalog?.channels.find(c => c.id === id)?.name ?? id ?? '';
  const filteredEvents = useMemo(() => run?.events.filter(event =>
    (!channelFilter || event.channelId === channelFilter) && (!roleFilter || event.role === roleFilter) &&
    (!search || `${event.text} ${event.id} ${event.taskId ?? ''} ${actorName(event.actorId)}`.toLowerCase().includes(search.toLowerCase())),
  ) ?? [], [run, channelFilter, roleFilter, search, actorName]);
  const scenario = catalog?.scenarios.find(s => s.id === draft.scenarioId);
  const history = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const departments = [...new Set(catalog?.actors.map(a => a.department) ?? [])];
  const targetToken = selectedId ? targetTokens[selectedId] : undefined;
  const reference = run?.config.target === 'reference';
  const viewEvidence = (ref: string) => {
    if (ref.startsWith('artifact:')) {
      const artifact = run?.artifacts.find(a => a.path === ref.slice(9)); if (artifact) { void showArtifact(artifact); return; }
    }
    if (run?.factReport?.assertions.some(assertion => assertion.id === ref)) {
      setTab('evaluation');
      requestAnimationFrame(() => {
        const node = document.getElementById(`assertion-${ref}`) as HTMLDetailsElement | null;
        if (node) { node.open = true; node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
      return;
    }
    if (ref.startsWith('task:')) { setTab('tasks'); return; }
    setSearch(ref); setRoleFilter(''); setChannelFilter(''); setTab('timeline');
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setSelectedId(undefined)} aria-label="识雨 Lab 首页"><span className="brand-icon"><FlaskConical size={24} /></span><span>识雨 <b>lab</b><small>WORKPLACE SIMULATION</small></span></button>
      <div className="sidebar-section">实验空间</div>
      <button className={`nav-item ${!selectedId ? 'nav-active' : ''}`} onClick={() => { setSelectedId(undefined); setError(''); }}><Layers size={18} /><span>实验工作台</span><ChevronRight size={15} /></button>
      <div className="sidebar-section history-heading"><span>运行记录</span><span>{runs.length.toString().padStart(2, '0')}</span></div>
      <div className="history-list">
        {!runs.length && <div className="history-empty">还没有运行记录<br />从一次混合工作日开始。</div>}
        {history.map(item => <button key={item.id} className={`history-item ${selectedId === item.id ? 'history-active' : ''}`} onClick={() => chooseRun(item.id)}>
          <span className={`history-dot dot-${item.status}`} /><span className="history-text"><strong>{item.name}</strong><small>{humanDate(item.createdAt)} · {item.config.target === 'reference' ? '自检' : '外部 Agent'}</small></span>{active(item.status) && <Activity size={14} />}
        </button>)}
      </div>
      <div className="sidebar-footer"><div className="local-marker"><span />本机实验环境</div><p>合成公司 · 独立证据 · 可重复运行</p><span className="version">LAB {settings.version}</span></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb">识雨实验室 <ChevronRight size={14} /><span>{selectedId ? '实验详情' : '实验工作台'}</span></div><div className="topbar-right"><select className="mobile-run-select" aria-label="选择实验记录" value={selectedId ?? ''} onChange={event => event.target.value ? chooseRun(event.target.value) : setSelectedId(undefined)}><option value="">实验工作台</option>{history.map(item => <option key={item.id} value={item.id}>{item.name} · {humanDate(item.createdAt)}</option>)}</select><span className="environment-tag"><span />LOCAL</span><span className="avatar operator-avatar">研</span></div></header>
      <div className="page-content">
        {error && <div className="notice notice-error" role="alert"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={16} /></button></div>}
        {booting ? <div className="page-loading"><Loader2 className="spin" size={26} /><p>正在连接实验室…</p></div> : !catalog ? <Empty icon={AlertCircle} title="暂时无法连接实验室"><span>请确认本地服务正在运行。</span><br /><button className="button button-secondary retry-button" onClick={() => setBootAttempt(value => value + 1)}><RefreshCw size={16} />重新连接</button></Empty> : !selectedId ? <>
          <div className="page-heading"><div><div className="eyebrow">EXPERIMENT WORKSPACE</div><h1>实验工作台</h1><p>让多部门的真实工作，在持续的信息流中发生。</p></div><span className="subtle-tag"><FlaskConical size={15} />合成公司 / 开发测试集</span></div>
          <div className="company-strip"><div className="company-title"><span className="company-icon"><Briefcase size={21} /></span><div><strong>合成公司环境</strong><small>各自的职责，共同的工作现场</small></div></div><div className="company-number"><b>{catalog.actors.length}</b><span>参与者</span></div><div className="company-number"><b>{departments.length}</b><span>部门 / 组织</span></div><div className="company-number"><b>{catalog.channels.length}</b><span>交流场所</span></div><div className="company-number"><b>{catalog.subjects.length}</b><span>工作科目</span></div></div>
          <div className="workspace-grid"><section className="panel scenario-panel"><div className="panel-heading"><div><span className="step-label">01 / 选择场景</span><h2>从一个工作现场开始</h2></div><span className="count-label">{catalog.scenarios.length} 个场景</span></div>
            <div className="scenario-list">{catalog.scenarios.map((item, index) => <button key={item.id} className={`scenario-card ${draft.scenarioId === item.id ? 'scenario-selected' : ''}`} aria-pressed={draft.scenarioId === item.id} onClick={() => updateDraft('scenarioId', item.id)}><span className="scenario-symbol">{index === 0 ? <Briefcase size={21} /> : index === 1 ? <Radio size={21} /> : index === 2 ? <GitCompare size={21} /> : <Database size={21} />}</span><div className="scenario-copy"><div className="scenario-title"><strong>{item.name}</strong><span className="scenario-check">{draft.scenarioId === item.id && <Check size={13} />}</span></div><p>{item.description}</p><div className="scenario-tags"><span>{item.tasks.length} 项工作</span>{item.focus.slice(0, 3).map(f => <span key={f}>{f}</span>)}</div></div></button>)}</div>
            <div className="scenario-footnote"><Clock size={15} /><span>消息按计划持续到达，任务独立推进。</span></div>
          </section>
          <section className="panel config-panel"><div className="panel-heading"><div><span className="step-label">02 / 配置运行</span><h2>设定实验条件</h2></div><Settings2 size={20} className="muted" /></div>
            <div className="field"><label htmlFor="target">被测对象</label><select id="target" value={draft.target} onChange={e => updateDraft('target', e.target.value as RunConfig['target'])}><option value="reference">参考执行器 · Lab 自检</option><option value="external">外部 Agent · 协议接入</option></select><p className="field-hint">{draft.target === 'reference' ? '验证消息、工具与验收链路。结果不代表识雨能力。' : '创建运行后，将专属接入令牌交给你的 Agent。'}</p></div>
            <div className="field"><div className="field-label-row"><label htmlFor="noise">背景噪声</label><span>{draft.noiseCount} 条</span></div><input id="noise" type="range" min="0" max="1000" step="10" value={draft.noiseCount} onChange={e => updateDraft('noiseCount', Number(e.target.value))} /><div className="range-labels"><span>安静办公</span><span>信息洪峰</span></div></div>
            <div className="form-row"><div className="field"><label htmlFor="workers">Worker 并发</label><input id="workers" type="number" min="1" max="8" value={draft.workerConcurrency} onChange={e => updateDraft('workerConcurrency', Math.max(1, Math.min(8, Number(e.target.value) || 1)))} /></div><div className="field"><label htmlFor="speed">时间倍率</label><select id="speed" value={draft.speed} onChange={e => updateDraft('speed', Number(e.target.value))}>{[1, 2, 5, 10, 20, 50, 100].map(n => <option key={n} value={n}>{n}×</option>)}</select></div></div>
            <div className="form-row"><div className="field"><label htmlFor="seed">随机种子</label><input id="seed" type="number" min="1" max="2147483647" value={draft.seed} onChange={e => updateDraft('seed', Math.max(1, Math.min(2147483647, Number(e.target.value) || 1)))} /></div><div className="field"><label htmlFor="fault">故障条件</label><select id="fault" value={draft.fault} onChange={e => updateDraft('fault', e.target.value as RunConfig['fault'])}><option value="none">无额外故障</option><option value="tool-once">工具首次失败</option><option value="lost-receipt">回执丢失</option></select></div></div>
            <details className="advanced"><summary>更多运行参数<ChevronDown size={14} /></summary><div className="form-row"><div className="field"><label htmlFor="task-delay">任务等待（ms）</label><input id="task-delay" type="number" min="0" max="10000" step="100" value={draft.taskDelayMs} onChange={e => updateDraft('taskDelayMs', Math.max(0, Math.min(10000, Number(e.target.value) || 0)))} /></div><div className="field"><label htmlFor="max-duration">最长运行（秒）</label><input id="max-duration" type="number" min="5" max="600" value={draft.maxDurationMs / 1000} onChange={e => updateDraft('maxDurationMs', Math.max(5, Math.min(600, Number(e.target.value) || 5)) * 1000)} /></div></div></details>
            <button className="button button-primary start-button" disabled={creating || !scenario} onClick={() => void startRun()}>{creating ? <Loader2 className="spin" size={17} /> : <Play size={17} fill="currentColor" />} {creating ? '正在创建实验…' : '开始实验'}<ArrowRight size={17} /></button><p className="start-note">配置将随运行保存，可在历史中重新查看。</p>
          </section></div>
          <section className="subjects-section"><div className="section-heading"><div><h2>实际工作，实际产物</h2><p>每个科目配有输入资料、可执行工作和独立验收。</p></div><span className="subtle-tag">{catalog.subjects.length} 个工作科目</span></div><div className="subjects-grid">{catalog.subjects.map((subject, index) => <div className="subject-card" key={subject.id}><div className="subject-top"><span className="subject-index">{String(index + 1).padStart(2, '0')}</span><span>{subject.department}</span></div><h3>{subject.name}</h3><p>{subject.description}</p><div className="subject-output"><ArrowUpRight size={14} /><span>{subject.outputSummary}</span></div></div>)}</div></section>
          <section className="people-section"><div className="section-heading"><h2>公司里的参与者</h2><span className="muted">各自掌握信息，各自参与协作</span></div><div className="people-grid">{catalog.actors.map(person => <div className="person" key={person.id}><span className="avatar" style={{ backgroundColor: person.color || '#ddede7' }}>{person.name.slice(-2)}</span><div><strong>{person.name}</strong><small>{person.department} · {person.title}</small></div></div>)}</div></section>
        </> : !run ? <div className="page-loading"><Loader2 className="spin" size={25} /><p>正在读取实验记录…</p></div> : <>
          <div className="page-heading run-heading"><div><div className="eyebrow">RUN / {run.id.slice(-12)}</div><div className="run-title"><h1>{run.name}</h1><Badge status={run.status} /></div><p>{humanDate(run.createdAt)} <span className="text-divider">/</span> 种子 {run.config.seed} <span className="text-divider">/</span> {run.config.noiseCount} 条背景消息 <span className="text-divider">/</span> {run.config.workerConcurrency} 个 Worker</p></div><div className="run-actions">{active(run.status) && <><button className="button button-secondary" disabled={!!command || run.status === 'draining'} onClick={() => void control('drain')}>{command === 'drain' ? <Loader2 className="spin" size={15} /> : <Layers size={15} />}排空并结束</button><button className="button button-danger" disabled={!!command} onClick={() => void control('stop')}>{command === 'stop' ? <Loader2 className="spin" size={15} /> : <Square size={13} />}停止</button></>}<button className="button button-secondary" onClick={() => { setSelectedId(undefined); setDraft(run.config); }}><Plus size={16} />新实验</button></div></div>
          <div className={`scope-banner ${reference ? '' : 'scope-external'}`}><span className="scope-symbol">{reference ? <FlaskConical size={20} /> : <Bot size={20} />}</span><div><strong>{reference ? '参考执行器 · Lab 自检' : '外部 Agent · 被测运行'}</strong><span>{reference ? '本次用于检查实验系统的工作链路；不代表识雨 core、worker 或记忆能力已通过验证。' : '任务进度来自被测对象，完成情况以独立验收为准。'}</span></div><span className="live-label"><span className={live && active(run.status) ? 'pulse-dot' : ''} />{active(run.status) ? live ? '实时更新' : '定时刷新' : '已封存'}</span></div>
          {run.error && <div className="notice notice-error"><AlertCircle size={18} /><span>{run.error}</span></div>}
          {targetToken && <div className="target-connection"><div><strong>Agent 接入令牌</strong><p>仅本次页面会话显示。将运行 ID 与令牌交给测试适配器。</p></div><code>{targetToken}</code><button className="button button-secondary" onClick={async () => { try { await navigator.clipboard.writeText(targetToken); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('无法自动复制，请手动选择令牌。'); } }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}</button><a href="/api/protocol" target="_blank" rel="noreferrer" className="text-link">接入协议<ExternalLink size={14} /></a></div>}
          <div className="metrics-grid"><Metric label="验收通过的工作" value={run.factReport ? `${run.factReport.tasksPassed} / ${run.factReport.tasksTotal}` : '待验收'} detail={run.factReport ? `${Math.round(run.factReport.completionRate * 100)}% 已引入工作通过` : `${run.metrics.completedTasks} 项声明完成`} icon={CheckCircle2} /><Metric label="收到的输入" value={run.metrics.injectedInputs} detail={`计划 ${run.metrics.scheduledInputs} 条`} icon={MessageSquare} /><Metric label="实际回复" value={run.metrics.replies} detail="独立发送记录" icon={Radio} /><Metric label="工具调用" value={run.metrics.toolCalls} detail={`${run.artifacts.length} 份已记录产物`} icon={Cpu} /><Metric label="运行耗时" value={duration(run.metrics.elapsedMs)} detail={`注入最大延迟 ${duration(run.metrics.maxInjectionLagMs)}`} icon={Clock} /></div>
          <div className="tab-bar" role="tablist" aria-label="实验详情">{tabs.map(item => <button role="tab" aria-selected={tab === item.key} key={item.key} className={tab === item.key ? 'tab-active' : ''} onClick={() => setTab(item.key)}><item.icon size={16} />{item.label}{item.key === 'artifacts' && run.artifacts.length > 0 && <span className="tab-count">{run.artifacts.length}</span>}</button>)}</div>

          {tab === 'overview' && <div className="overview-grid"><section className="panel"><div className="panel-heading"><div><span className="step-label">WORK IN PROGRESS</span><h2>工作正在怎样推进</h2></div><button className="text-link" onClick={() => setTab('tasks')}>全部任务<ArrowRight size={14} /></button></div><div className="task-summary-list">{run.tasks.length ? run.tasks.map(task => <button className="task-summary" key={task.id} onClick={() => setTab('tasks')}><span className={`task-number task-number-${task.status}`}>{task.status === 'completed' ? <Check size={16} /> : task.id.replace(/^T/, '')}</span><div><strong>{task.title}</strong><small>{actorName(task.ownerId)} · {task.introduced ? task.detail ?? (task.dependencies.length ? `依赖 ${task.dependencies.join('、')}` : '独立工作') : '尚未进入信息流'}</small></div><Badge status={task.introduced ? task.status : 'prepared'}>{task.introduced ? undefined : '未引入'}</Badge></button>) : <Empty title="没有工作任务" />}</div></section>
            <div className="overview-side"><section className="panel service-panel"><div className="panel-heading"><h2>测试服务</h2><Server size={19} className="muted" /></div><div className="service-status"><span className={`service-icon ${run.service.healthy ? 'service-healthy' : ''}`}><Activity size={21} /></span><div><strong>{run.service.name}</strong><small>{run.service.healthy ? '当前检查正常' : '当前存在异常'}</small></div><Badge status={run.service.healthy ? 'pass' : 'fail'}>{run.service.healthy ? '健康' : '异常'}</Badge></div><div className="key-values"><div><span>连接容量</span><strong>{run.service.config.maxConnections} / 需求 {run.service.config.requiredConnections}</strong></div><div><span>维护模式</span><strong>{run.service.config.maintenance ? '开启' : '关闭'}</strong></div><div><span>状态版本</span><strong>v{run.service.revision}</strong></div></div><p className="panel-footnote">可复位的实验服务，显示实际模拟状态。</p></section><section className="panel"><div className="panel-heading"><h2>本次条件</h2><Settings2 size={18} className="muted" /></div><div className="key-values"><div><span>时间倍率</span><strong>{run.config.speed}×</strong></div><div><span>故障条件</span><strong>{run.config.fault === 'none' ? '无额外故障' : run.config.fault === 'tool-once' ? '工具首次失败' : '回执丢失'}</strong></div><div><span>任务等待</span><strong>{run.config.taskDelayMs} ms</strong></div><div><span>最长运行</span><strong>{duration(run.config.maxDurationMs)}</strong></div></div></section></div>
            <section className="panel overview-events"><div className="panel-heading"><div><span className="step-label">LATEST ACTIVITY</span><h2>最近发生的事</h2></div><button className="text-link" onClick={() => setTab('timeline')}>打开信息流<ArrowRight size={14} /></button></div>{run.events.length ? <div className="compact-events">{run.events.slice(-7).reverse().map(event => <div key={event.id}><span className={`event-role-dot role-${event.role}`} /><time>{humanTime(event.at)}</time><span className="compact-role">{roleNames[event.role]}</span><p>{event.text}</p></div>)}</div> : <Empty icon={MessageSquare} title="等待第一条事件">事件发生后会显示在这里。</Empty>}</section>
            {Object.keys(run.memory).length > 0 && <section className="panel memory-panel"><div className="panel-heading"><h2>内部状态观测</h2><Database size={18} className="muted" /></div><p className="panel-footnote">被测对象上报的观测；独立能力验收另行判断。</p><pre className="code-block">{JSON.stringify(run.memory, null, 2)}</pre></section>}
          </div>}

          {tab === 'timeline' && <section className="panel timeline-panel"><div className="panel-heading"><div><h2>信息流与执行轨迹</h2><p>{filteredEvents.length} 条匹配事件 · 按实际发生顺序</p></div><span className="subtle-tag">输入、决策、工具、回复</span></div><div className="filter-bar"><div className="search-field"><Search size={17} /><input aria-label="搜索事件" placeholder="搜索消息、任务或证据 ID" value={search} onChange={e => setSearch(e.target.value)} /></div><select aria-label="筛选会话" value={channelFilter} onChange={e => setChannelFilter(e.target.value)}><option value="">全部会话</option>{catalog.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select><select aria-label="筛选角色" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option value="">全部角色</option>{Object.entries(roleNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>{(search || channelFilter || roleFilter) && <button className="text-link" onClick={() => { setSearch(''); setChannelFilter(''); setRoleFilter(''); }}>清除</button>}</div>{filteredEvents.length > 400 && <div className="list-note">当前显示最近 400 条匹配事件；使用筛选定位更早的记录。</div>}<div className="timeline-list">{filteredEvents.length ? filteredEvents.slice(-400).map(event => <article className={`timeline-event timeline-${event.role}`} key={event.id} id={event.id}><div className="timeline-stamp"><time>{humanTime(event.at)}</time><small>+{duration(event.elapsedMs)}</small></div><div className="timeline-marker"><span className={`event-role-dot role-${event.role}`} /></div><div className="timeline-body"><div className="event-heading"><strong>{event.actorId ? actorName(event.actorId) : roleNames[event.role]}</strong><span className={`role-label role-label-${event.role}`}>{roleNames[event.role]}</span>{event.channelId && <span className="channel-label"># {channelName(event.channelId)}</span>}{event.taskId && <span className="event-task">{event.taskId}</span>}</div><p>{event.text}</p><details className="event-details"><summary>事件证据 <span>{event.type}</span></summary><div className="event-id">{event.id}</div>{event.data && <pre>{JSON.stringify(event.data, null, 2)}</pre>}</details></div></article>) : <Empty icon={MessageSquare} title={run.events.length ? '没有匹配的事件' : '信息流还未开始'}>{run.events.length ? '试着调整搜索词或筛选条件。' : '启动后的输入和执行轨迹会实时出现在这里。'}</Empty>}</div></section>}

          {tab === 'tasks' && <section className="panel"><div className="panel-heading"><div><h2>工作任务</h2><p>执行状态来自被测对象，产物由独立验收检查。</p></div><span className="subtle-tag">{run.tasks.filter(t => t.introduced).length} / {run.tasks.length} 已引入</span></div><div className="task-detail-list">{run.tasks.map(task => <TaskCard key={task.id} task={task} owner={actorName(task.ownerId)} assertions={run.factReport?.assertions.filter(a => a.taskId === task.id) ?? []} artifacts={run.artifacts.filter(a => a.taskId === task.id)} onArtifact={artifact => void showArtifact(artifact)} />)}</div></section>}

          {tab === 'artifacts' && <div className="artifacts-grid"><section className="panel artifact-list-panel"><div className="panel-heading"><div><h2>交付产物</h2><p>{run.artifacts.length} 份文件 · 可下载并独立检查</p></div><FileText size={20} className="muted" /></div>{run.artifacts.length ? <div className="artifact-list">{run.artifacts.map(artifact => <div className={`artifact-row ${preview?.path === artifact.path || previewBusy === artifact.path ? 'artifact-selected' : ''}`} key={artifact.path}><button onClick={() => void showArtifact(artifact)} className="artifact-main"><span className={`file-icon file-${artifact.name.split('.').pop()}`}><FileText size={20} /></span><span><strong>{artifact.name}</strong><small>{artifact.taskId ?? '运行附件'} · {size(artifact.bytes)}</small></span></button><a className="icon-button" href={`/api/runs/${run.id}/artifacts?path=${encodeURIComponent(artifact.path)}`} download={artifact.name} aria-label={`下载 ${artifact.name}`}><Download size={16} /></a></div>)}</div> : <Empty icon={FileText} title="等待第一份交付">Worker 实际生成的文件会保存在本次运行中。</Empty>}</section><section className="panel preview-panel"><div className="panel-heading"><h2>文件预览</h2>{preview && <span className="preview-path" title={preview.path}>{preview.path}</span>}</div>{previewBusy ? <div className="empty"><Loader2 size={24} className="spin" /><p>正在读取文件…</p></div> : previewError ? <Empty icon={FileText} title="此文件暂不支持预览">{previewError} 可使用左侧下载按钮打开原文件。</Empty> : preview ? <>{preview.truncated && <div className="list-note">内容较长，当前展示部分预览；完整内容请下载原文件。</div>}<pre className="file-preview">{preview.content}</pre></> : <Empty icon={FileText} title="选择文件查看内容">文本和结构化结果可直接预览，办公文档可下载打开。</Empty>}</section></div>}

          {tab === 'evaluation' && <div className="evaluation-grid"><section className="panel fact-panel"><div className="panel-heading"><div><span className="step-label">INDEPENDENT VERIFICATION</span><h2>独立事实验收</h2></div><ShieldCheck size={21} className="muted" /></div>{run.factReport ? <><div className="fact-summary"><span className="fact-score">{run.factReport.tasksPassed}<small> / {run.factReport.tasksTotal}</small></span><div><strong>项已引入工作通过验收</strong><p>{run.factReport.summary}</p></div></div><div className="assertion-list">{run.factReport.assertions.map(assertion => <AssertionRow key={assertion.id} assertion={assertion} onEvidence={viewEvidence} />)}</div>{run.factReport.limitations.length > 0 && <div className="limitations"><strong>本次结论的范围</strong>{run.factReport.limitations.map((line, i) => <p key={i}>{line}</p>)}</div>}</> : <Empty icon={ShieldCheck} title="运行结束后生成验收报告">验收会读取实际文件和效果记录，独立判断工作是否完成。</Empty>}</section><section className="panel judge-panel"><div className="panel-heading"><div><span className="step-label">AGENT REVIEW</span><h2>Agent 评审</h2></div><Bot size={21} className="muted" /></div><p className="judge-intro">评价成果实用性、协作判断和表达质量。评审意见与事实验收分别保留。</p><div className="judge-controls"><button className="button button-primary" disabled={reviewBusy || active(run.status) || !run.factReport || !settings.judgeConfigured} onClick={() => void startReview()}>{reviewBusy ? <Loader2 className="spin" size={16} /> : <Bot size={16} />}{reviewBusy ? '正在评审…' : '运行 Agent 评审'}</button><button className="button button-secondary" disabled={reviewBusy || active(run.status) || !run.factReport} onClick={() => { setImportError(''); setImportOpen(true); }}>导入评分 JSON</button>{!active(run.status) && run.factReport && <a className="button button-secondary" href={`/api/runs/${run.id}/evidence`} download={`evidence-${run.id}.json`}><Download size={14} />评审证据</a>}</div>{!settings.judgeConfigured && <p className="field-hint">尚未配置评分服务。可先导入外部 Agent 的结构化评审。</p>}{run.reviews.length ? <div className="review-list">{[...run.reviews].reverse().map(review => <ReviewCard key={review.id} review={review} onEvidence={viewEvidence} />)}</div> : <Empty icon={Bot} title="尚无 Agent 评审">评分只在手动触发后执行；每次评审会形成独立记录。</Empty>}</section></div>}

          {tab === 'compare' && <Comparison current={run} candidates={history.filter(r => r.id !== run.id)} selectedId={comparisonId} onSelect={setComparisonId} />}
        </>}
        <footer className="page-footer"><span>识雨 Lab · 让每次判断都有可检查的结果</span><span>合成数据 / 本地运行</span></footer>
      </div>
    </main>
    <dialog ref={dialogRef} className="import-dialog" onCancel={() => setImportOpen(false)} onClose={() => setImportOpen(false)}><div className="dialog-heading"><div><h2>导入 Agent 评审</h2><p>保留外部评审原始意见，并校验证据引用。</p></div><button className="icon-button" onClick={() => setImportOpen(false)} aria-label="关闭导入"><X size={20} /></button></div><label htmlFor="review-json">评审 JSON</label><textarea id="review-json" spellCheck={false} value={importText} onChange={e => setImportText(e.target.value)} placeholder={'{\n  "provider": "your-judge",\n  "dimensions": [\n    { "name": "协作推进", "status": "scored", "score": 4,\n      "reason": "根据实际轨迹评价", "evidenceRefs": ["实际证据 ID"] }\n  ],\n  "needsHumanReview": false\n}'} /><p className="field-hint">分数为 1–5；证据 ID 应来自当前运行。无法评价时使用 insufficient_evidence。</p>{importError && <div className="notice notice-error" role="alert"><AlertCircle size={16} /><span>{importError}</span></div>}<div className="dialog-actions"><button className="button button-secondary" disabled={reviewBusy} onClick={() => setImportOpen(false)}>取消</button><button className="button button-primary" disabled={reviewBusy || !importText.trim()} onClick={() => void importReview()}>{reviewBusy && <Loader2 className="spin" size={16} />}导入并校验</button></div></dialog>
  </div>;
}

function TaskCard({ task, owner, assertions, artifacts, onArtifact }: { task: TaskRecord; owner: string; assertions: Assertion[]; artifacts: Artifact[]; onArtifact: (artifact: Artifact) => void }) {
  const failed = assertions.some(a => a.status === 'fail');
  const checked = assertions.length > 0 && assertions.every(a => a.status === 'pass' || a.status === 'not_applicable');
  return <article className={`task-card ${!task.introduced ? 'task-not-introduced' : ''}`}><div className="task-card-heading"><span className="task-id">{task.id}</span><div><h3>{task.title}</h3><p>{owner} · {task.subjectId}</p></div><Badge status={task.introduced ? task.status : 'prepared'}>{task.introduced ? undefined : '尚未引入'}</Badge></div><p className="task-instructions">{task.instructions}</p><div className="task-meta"><span><FileText size={14} />{task.inputs.length} 份输入资料</span><span><Layers size={14} />{task.dependencies.length ? `依赖 ${task.dependencies.join('、')}` : '独立执行'}</span><span><Clock size={14} />{task.startedAt ? `开始于 ${humanTime(task.startedAt)}` : '尚未开始'}</span></div>{task.detail && <div className="task-detail-text">{task.detail}</div>}<div className="task-deliverables"><span>要求交付</span>{task.deliverables.map(path => <code key={path}>{path.split('/').pop()}</code>)}</div><div className="task-card-footer"><span className={failed ? 'text-danger' : checked ? 'text-success' : 'muted'}>{failed ? <AlertCircle size={14} /> : checked ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}{failed ? '独立验收发现问题' : checked ? '独立验收通过' : '等待独立验收'}</span><div>{artifacts.map(artifact => <button key={artifact.path} className="artifact-chip" onClick={() => onArtifact(artifact)}><FileText size={12} />{artifact.name}</button>)}</div></div></article>;
}

function EvidenceLinks({ refs, onEvidence }: { refs: string[]; onEvidence: (ref: string) => void }) {
  return refs.length ? <div className="evidence-links">{refs.map(ref => <button key={ref} onClick={() => onEvidence(ref)} title={ref}>{ref.length > 38 ? `${ref.slice(0, 19)}…${ref.slice(-15)}` : ref}<ArrowUpRight size={11} /></button>)}</div> : null;
}
function AssertionRow({ assertion, onEvidence }: { assertion: Assertion; onEvidence: (ref: string) => void }) {
  const names = { pass: '通过', fail: '未通过', inconclusive: '证据不足', not_applicable: '不适用' };
  return <details id={`assertion-${assertion.id}`} className={`assertion assertion-${assertion.status}`}><summary><span className="assertion-icon">{assertion.status === 'pass' ? <CheckCircle2 size={17} /> : assertion.status === 'fail' ? <AlertCircle size={17} /> : <Clock size={17} />}</span><strong>{assertion.name}</strong>{assertion.taskId && <span className="event-task">{assertion.taskId}</span>}<Badge status={assertion.status}>{names[assertion.status]}</Badge><ChevronDown size={14} /></summary><div className="assertion-body"><p>{assertion.detail}</p><EvidenceLinks refs={assertion.evidenceRefs} onEvidence={onEvidence} /><small className="muted">{assertion.id}</small></div></details>;
}
function ReviewCard({ review, onEvidence }: { review: ReviewResult; onEvidence: (ref: string) => void }) {
  return <article className={`review-card ${review.status === 'judge_error' ? 'review-error' : ''}`}><div className="review-heading"><strong>{review.provider}</strong><time>{humanDate(review.at)}</time></div>{review.status === 'judge_error' ? <div className="notice notice-error"><AlertCircle size={17} /><span>评审未完成：{review.error ?? '评分结果无效'}。此记录不作为低分或通过结论。</span></div> : <>{review.needsHumanReview && <div className="review-warning"><AlertCircle size={15} />本次评审建议人工复核</div>}{review.dimensions.map((dimension, index) => <div className="review-dimension" key={`${dimension.name}-${index}`}><div><strong>{dimension.name}</strong>{dimension.status === 'scored' ? <span className="dimension-score">{dimension.score}<small> / 5</small></span> : <span className="muted">{dimension.status === 'not_applicable' ? '不适用' : '证据不足'}</span>}</div><p>{dimension.reason}</p><EvidenceLinks refs={dimension.evidenceRefs} onEvidence={onEvidence} /></div>)}</>}</article>;
}

function Comparison({ current, candidates, selectedId, onSelect }: { current: RunSummary; candidates: RunSummary[]; selectedId: string; onSelect: (id: string) => void }) {
  const baseline = candidates.find(r => r.id === selectedId);
  const comparable = baseline && (['scenarioId', 'seed', 'noiseCount', 'speed', 'workerConcurrency', 'taskDelayMs', 'fault', 'maxDurationMs'] as const).every(key => baseline.config[key] === current.config[key]);
  const rows: Array<{ label: string; value: (run: RunSummary) => ReactNode }> = [
    { label: '被测对象', value: r => r.config.target === 'reference' ? '参考执行器 / Lab 自检' : '外部 Agent' },
    { label: '运行状态', value: r => <Badge status={r.status} /> },
    { label: '独立验收通过', value: r => r.factReport ? `${r.factReport.tasksPassed} / ${r.factReport.tasksTotal}` : '尚未验收' },
    { label: '收到 / 计划输入', value: r => `${r.metrics.injectedInputs} / ${r.metrics.scheduledInputs}` },
    { label: '实际回复', value: r => r.metrics.replies },
    { label: '工具调用', value: r => r.metrics.toolCalls },
    { label: '未完成任务', value: r => r.metrics.pendingTasks },
    { label: '运行耗时', value: r => duration(r.metrics.elapsedMs) },
    { label: '最大注入延迟', value: r => duration(r.metrics.maxInjectionLagMs) },
    { label: '噪声 / 并发 / 倍率', value: r => `${r.config.noiseCount} 条 / ${r.config.workerConcurrency} / ${r.config.speed}×` },
    { label: '随机种子 / 故障', value: r => `${r.config.seed} / ${r.config.fault}` },
  ];
  return <section className="panel comparison-panel"><div className="panel-heading"><div><h2>实验对比</h2><p>先核对实验条件，再比较工作成果和运行效率。</p></div><GitCompare size={22} className="muted" /></div>{candidates.length ? <><div className="comparison-selector"><label htmlFor="compare-run">选择对照运行</label><select id="compare-run" value={selectedId} onChange={e => onSelect(e.target.value)}><option value="">选择一条历史记录</option>{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} · {humanDate(candidate.createdAt)} · {candidate.id.slice(-6)}</option>)}</select></div>{baseline ? <><div className={`comparison-note ${comparable ? 'comparison-matched' : ''}`}>{comparable ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}<span>{comparable ? '场景、随机种子、负载和运行参数一致。单次实验只用于观察差异，不构成稳定排名。' : '两次运行的条件不同。下表保留差异，不据此判断哪个被测对象更好。'}</span></div><div className="table-scroll"><table className="comparison-table"><thead><tr><th>观察项</th><th>当前实验<small>{current.name} / {current.id.slice(-8)}</small></th><th>对照实验<small>{baseline.name} / {baseline.id.slice(-8)}</small></th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><td>{row.label}</td><td>{row.value(current)}</td><td>{row.value(baseline)}</td></tr>)}</tbody></table></div><p className="panel-footnote">参考执行器是 Lab 自检基线。当前未收集真实模型计费信息，不将调用数换算为费用。</p></> : <Empty icon={GitCompare} title="选择一个对照实验">可比较不同噪声、并发或被测对象下的实际结果。</Empty>}</> : <Empty icon={GitCompare} title="还需要另一条运行记录">完成或创建第二次实验后，可以在这里并排查看结果。</Empty>}</section>;
}
