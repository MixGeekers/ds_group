window.__ModuleLoader__.load({
  id: '@shiyu/workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useSyncExternalStore } = React;
    const dictionaries = {
      zh: {
        nav: '识雨', title: '识雨 · 工作台', subtitle: '让方向、候选与图纸有迹可循。', version: '第一版 · 0.1.0',
        workspace: '主要工作区', workspaceHint: '仅切换工作台资料来源，不改变会话目录。资料只读，选择保存在当前配置中。',
        choose: '选择文件夹', save: '设为主要工作区', path: '工作区绝对路径', recent: '最近使用', refresh: '刷新资料',
        candidates: '技术候选', architecture: '架构图纸', topics: '设计主题', diagrams: '原始图纸', search: '搜索名称、方向或判断',
        all: '全部状态', noResult: '没有匹配的条目', empty: '此工作区还没有对应资料。', emptyHint: '从“技术候选”和“架构与设计”目录读取 Markdown；目录.md 提供顺序与状态。不会自动创建文件。',
        candidateNote: '收录不等于采用。以下判断来自工作区文档，不授权安装、接入服务或上传数据。',
        designNote: '设计状态与实现状态分开显示。图纸是原文中的设计表达，不是运行系统的实时状态。',
        read: '阅读原文', source: '出处', unindexed: '尚未列入目录', evidence: '条目中的状态', implementation: '实现状态',
        loading: '正在读取工作区…', loadingDoc: '正在读取文档…', retry: '重试', error: '操作未完成', warnings: '读取提示',
        back: '返回工作台', document: '文档', raw: 'Markdown 源码', formatted: '阅读视图', outline: '章节导航',
        updated: '文档更新', scanned: '最近读取', index: '打开目录', designStatus: '设计状态', noDiagram: '此主题没有字符图，请阅读设计原文。',
        original: '原始字符图', mermaid: 'Mermaid 源码（第一版不渲染）', zoomIn: '放大图纸', zoomOut: '缩小图纸',
        reset: '重置缩放', saved: '主要工作区已保存。', readOnly: '文档只读', brokenLink: '此链接不是可在工作台打开的 Markdown 文档。',
        countHint: '不含目录索引', unknown: '未标注', lines: '行', boundary: '先感知，再行动；保留事实与愿望的边界。',
      },
      en: {
        nav: 'Shiyu', title: 'Shiyu · Workbench', subtitle: 'Keep directions, candidates and blueprints traceable.', version: 'First release · 0.1.0',
        workspace: 'Primary workspace', workspaceHint: 'Changes this workbench’s data source, not the session directory. Documents stay read-only. Selection is saved in this profile.',
        choose: 'Choose folder', save: 'Set primary workspace', path: 'Absolute workspace path', recent: 'Recent workspaces', refresh: 'Refresh documents',
        candidates: 'Technology candidates', architecture: 'Architecture blueprints', topics: 'Design topics', diagrams: 'Original diagrams', search: 'Search name, direction or assessment',
        all: 'All statuses', noResult: 'No matching entries', empty: 'No documents in this workspace yet.', emptyHint: 'Reads Markdown from 技术候选 and 架构与设计. 目录.md provides ordering and status. No files are created.',
        candidateNote: 'Listed does not mean adopted. Assessments come from workspace documents; they do not authorize installation, integration or data upload.',
        designNote: 'Design and implementation statuses are separate. These are source blueprints, not live system status.',
        read: 'Read document', source: 'Source', unindexed: 'Not in index yet', evidence: 'Status in document', implementation: 'Implementation status',
        loading: 'Reading workspace…', loadingDoc: 'Reading document…', retry: 'Retry', error: 'Operation failed', warnings: 'Read notices',
        back: 'Back to workbench', document: 'Document', raw: 'Markdown source', formatted: 'Reading view', outline: 'Contents',
        updated: 'Document updated', scanned: 'Last read', index: 'Open index', designStatus: 'Design status', noDiagram: 'This topic has no text diagram. Read the source document.',
        original: 'Original text diagram', mermaid: 'Mermaid source (not rendered in v1)', zoomIn: 'Enlarge diagram', zoomOut: 'Shrink diagram',
        reset: 'Reset zoom', saved: 'Primary workspace saved.', readOnly: 'Read-only documents', brokenLink: 'This link is not a Markdown document supported by the workbench.',
        countHint: 'Excludes indexes', unknown: 'Not specified', lines: 'lines', boundary: 'Observe before acting. Keep facts distinct from aspirations.',
      },
    };
    const css = `
.sy-workbench{height:100%;min-width:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6;box-sizing:border-box}
.sy-workbench *{box-sizing:border-box}.sy-wrap{max-width:1240px;margin:0 auto;padding:32px 32px 48px}.sy-header{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:26px}
.sy-heading{display:flex;gap:14px;align-items:center}.sy-heading h1{font-size:24px;line-height:1.35;margin:0;font-weight:650;letter-spacing:-.5px}.sy-sub{color:var(--dsw-alias-label-secondary);font-size:13px;margin:5px 0 0}
.sy-logo{color:var(--dsw-alias-brand-primary);flex-shrink:0}.sy-eyebrow{font-size:11px;letter-spacing:1.4px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;margin-bottom:4px}.sy-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sy-btn,.sy-input,.sy-select{font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:6px 12px}
.sy-btn{cursor:pointer;white-space:nowrap;display:inline-flex;gap:6px;align-items:center;justify-content:center}.sy-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}.sy-btn:disabled{opacity:.5;cursor:wait}.sy-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.sy-workbench :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.sy-input{width:100%;min-width:0}.sy-select{max-width:100%}.sy-workspace{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:20px;margin-bottom:20px}.sy-label{font-size:14px;font-weight:600;margin:0 0 8px}.sy-path{display:block;font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);margin-bottom:14px}.sy-form{display:flex;gap:8px;flex-wrap:wrap}.sy-form .sy-input{flex:1 1 260px}.sy-help{color:var(--dsw-alias-label-secondary);font-size:12px;margin:10px 0 0}.sy-history{display:flex;align-items:center;gap:10px;margin-top:10px}.sy-history label{font-size:12px;flex-shrink:0}.sy-history select{min-width:0;max-width:640px;width:100%}
.sy-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0 28px}.sy-stat{padding:14px 18px;border-left:2px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:0 8px 8px 0}.sy-stat strong{font-size:26px;font-weight:600;margin-right:10px}.sy-stat span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sy-tabs{display:flex;border-bottom:1px solid var(--dsw-alias-border-l1);gap:24px;margin-bottom:20px}.sy-tab{font:inherit;border:0;border-bottom:2px solid transparent;padding:10px 2px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}.sy-tab[aria-current=true]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.sy-note{font-size:12px;color:var(--dsw-alias-label-secondary);padding:12px 14px;background:var(--dsw-alias-bg-layer-1);border-radius:8px;margin-bottom:18px;border-left:2px solid var(--dsw-alias-brand-primary)}.sy-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}.sy-toolbar .sy-input{flex:1 1 200px}.sy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px}.sy-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:20px;display:flex;flex-direction:column;min-width:0}.sy-card:hover{border-color:var(--dsw-alias-border-l2)}.sy-card h3{font-size:16px;margin:0 0 10px;font-weight:600;overflow-wrap:anywhere}.sy-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.sy-tag{font-size:11px;line-height:1.5;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:2px 7px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}.sy-card p{margin:0 0 12px;font-size:13px}.sy-direction{color:var(--dsw-alias-label-secondary)}.sy-card footer{margin-top:auto;padding-top:12px;display:flex;justify-content:space-between;align-items:center;gap:12px}.sy-date{font-size:11px;color:var(--dsw-alias-label-secondary)}.sy-link{background:none;border:0;padding:0;text-align:left;cursor:pointer;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;text-decoration:none}.sy-link:hover{text-decoration:underline}.sy-status{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sy-blueprints{display:flex;flex-direction:column;gap:24px}.sy-design{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}.sy-design-head{padding:20px;border-bottom:1px solid var(--dsw-alias-border-l1)}.sy-design-head h3{font-size:17px;margin:0 0 8px}.sy-design-head p{margin:8px 0;font-size:13px}.sy-design-meta{display:grid;gap:6px;margin:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}.sy-figure{margin:0;padding:18px 20px;border-top:1px solid var(--dsw-alias-border-l1)}.sy-figure:first-child{border-top:0}.sy-fig-top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.sy-fig-top strong{font-size:13px}.sy-figure figcaption{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:10px}.sy-canvas{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background-color:var(--dsw-alias-bg-layer-1);background-image:radial-gradient(var(--dsw-alias-border-l1) .7px,transparent .7px);background-size:18px 18px;padding:24px}.sy-canvas pre{margin:0;line-height:1.75;white-space:pre;tab-size:4;font-family:ui-monospace,'SFMono-Regular','Menlo','Noto Sans Mono CJK SC',monospace;min-width:max-content}.sy-zoom{display:flex;gap:5px}.sy-zoom .sy-btn{min-height:28px;padding:2px 8px;font-size:12px}
.sy-error{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:12px 14px;margin:12px 0;overflow-wrap:anywhere}.sy-notice{font-size:12px;color:var(--dsw-alias-state-success-primary);margin:8px 0}.sy-warnings{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 14px;margin:16px 0;color:var(--dsw-alias-label-secondary);font-size:12px}.sy-warnings li{margin:8px 0;overflow-wrap:anywhere}.sy-empty{text-align:center;padding:44px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-secondary)}.sy-bottom{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:28px}
.sy-reader-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px}.sy-reader-layout{display:grid;grid-template-columns:minmax(0,1fr) 180px;gap:28px}.sy-toc{font-size:12px;position:sticky;top:14px;align-self:start;max-height:75vh;overflow:auto}.sy-toc a{display:block;text-decoration:none;color:var(--dsw-alias-label-secondary);padding:5px 0;overflow-wrap:anywhere}.sy-toc a:hover{color:var(--dsw-alias-brand-primary)}.sy-prose{font-size:14px;line-height:1.85;overflow-wrap:anywhere;min-width:0}.sy-prose h1{font-size:25px}.sy-prose h2{font-size:19px;margin-top:30px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}.sy-prose h3{font-size:16px;margin-top:24px}.sy-prose h4{font-size:14px}.sy-prose p{margin:12px 0}.sy-prose a{color:var(--dsw-alias-brand-primary)}.sy-prose blockquote{margin:14px 0;padding:8px 16px;border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}.sy-prose pre,.sy-raw{white-space:pre;overflow:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:16px;font-size:12px;line-height:1.8}.sy-prose code{font-family:ui-monospace,monospace;font-size:.9em;background:var(--dsw-alias-bg-layer-1);padding:1px 4px;border-radius:3px}.sy-table{overflow:auto;margin:16px 0}.sy-table table{border-collapse:collapse;width:100%;font-size:12px;min-width:420px}.sy-table th,.sy-table td{border:1px solid var(--dsw-alias-border-l1);padding:9px 12px;text-align:left;vertical-align:top}.sy-table th{background:var(--dsw-alias-bg-layer-1)}.sy-line-item{margin:5px 0;padding-left:12px}.sy-reader-source{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin-bottom:18px}
@media(max-width:800px){.sy-wrap{padding:22px 18px}.sy-reader-layout{grid-template-columns:1fr}.sy-toc{display:none}.sy-stats{gap:8px}.sy-stat{padding:10px}.sy-stat strong{display:block;font-size:23px}.sy-heading h1{font-size:21px}.sy-canvas{padding:16px}.sy-workspace{padding:16px}.sy-tabs{gap:20px}}
`;
    function RainIcon({ size = 24 }) {
      return h('svg', { viewBox: '0 0 32 32', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true, className: 'sy-logo' },
        h('path', { d: 'M16 3C13 8 9 11 9 15a7 7 0 0 0 14 0c0-4-4-7-7-12Z' }),
        h('path', { d: 'M4 26q12-14 24 0M4 26v4m8-9v9m8-9v9m8-4v4', strokeLinecap: 'round' }));
    }
    function internalPath(href, current) {
      if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null;
      try {
        const url = new URL(href, `https://shiyu.invalid/${current}`);
        return /\.md$/i.test(url.pathname) ? decodeURIComponent(url.pathname.slice(1)) : null;
      } catch { return null; }
    }
    function Inline({ text, documentPath, openDocument }) {
      const pattern = /(!?\[([^\]]+)\]\((?:<([^>]+)>|([^\s)]+))\)|`([^`]+)`|\*\*([^*]+)\*\*)/g;
      const out = []; let start = 0, match;
      while ((match = pattern.exec(text))) {
        if (match.index > start) out.push(text.slice(start, match.index));
        if (match[2]) {
          const href = match[3] || match[4];
          if (/^https?:\/\//i.test(href) && !match[0].startsWith('!')) out.push(h('a', { key: match.index, href, target: '_blank', rel: 'noopener noreferrer' }, match[2]));
          else {
            const target = internalPath(href, documentPath);
            out.push(target && !match[0].startsWith('!') ? h('a', { key: match.index, href: '#', onClick: e => { e.preventDefault(); openDocument(target); } }, match[2]) : h('span', { key: match.index, title: href }, match[2]));
          }
        } else out.push(h(match[5] ? 'code' : 'strong', { key: match.index }, match[5] || match[6]));
        start = pattern.lastIndex;
      }
      out.push(text.slice(start)); return h(React.Fragment, null, ...out);
    }
    function Markdown({ document, openDocument }) {
      const lines = document.text.replace(/\r\n/g, '\n').split('\n'), blocks = [];
      const inline = text => h(Inline, { text, documentPath: document.path, openDocument });
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i], key = i;
        const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
          const text = []; i++;
          while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) text.push(lines[i++]);
          blocks.push(h('pre', { key, id: `sy-line-${key + 1}` }, h('code', null, text.join('\n')))); continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)/);
        if (heading) { blocks.push(h(`h${heading[1].length}`, { key, id: `sy-line-${key + 1}` }, inline(heading[2]))); continue; }
        if (!line.trim()) continue;
        if (line.trim().startsWith('|') && /^\s*\|?\s*:?-+/.test(lines[i + 1] || '')) {
          const cells = row => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim());
          const headers = cells(line), rows = []; i += 2;
          while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(cells(lines[i])); i++; } i--;
          blocks.push(h('div', { key, className: 'sy-table' }, h('table', null,
            h('thead', null, h('tr', null, ...headers.map((c, n) => h('th', { key: n, scope: 'col' }, inline(c))))),
            h('tbody', null, ...rows.map((r, n) => h('tr', { key: n }, ...r.map((c, k) => h('td', { key: k }, inline(c))))))))); continue;
        }
        if (/^\s*>/.test(line)) { blocks.push(h('blockquote', { key }, inline(line.replace(/^\s*>\s?/, '')))); continue; }
        if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) { blocks.push(h('div', { key, className: 'sy-line-item' }, inline(line.replace(/^\s*[-*]\s/, '• ').replace(/\[ \]/g, '☐').replace(/\[x\]/gi, '☑')))); continue; }
        if (/^\s*---+\s*$/.test(line)) { blocks.push(h('hr', { key })); continue; }
        const paragraph = [line];
        while (i + 1 < lines.length && lines[i + 1].trim() && !/^(?:\s*[#>|`~*-]|\s*\d+\.\s)/.test(lines[i + 1])) paragraph.push(lines[++i]);
        blocks.push(h('p', { key }, inline(paragraph.join('\n'))));
      }
      return h('article', { className: 'sy-prose' }, ...blocks);
    }
    function Figure({ diagram, sourcePath, openDocument, t }) {
      const [zoom, setZoom] = useState(13);
      return h('figure', { className: 'sy-figure' },
        h('div', { className: 'sy-fig-top' }, h('strong', null, diagram.title),
          h('div', { className: 'sy-zoom' },
            h('button', { className: 'sy-btn', onClick: () => setZoom(z => Math.max(10, z - 1)), 'aria-label': t('zoomOut'), disabled: zoom === 10 }, '−'),
            h('button', { className: 'sy-btn', onClick: () => setZoom(13), title: t('reset') }, `${Math.round(zoom / 13 * 100)}%`),
            h('button', { className: 'sy-btn', onClick: () => setZoom(z => Math.min(22, z + 1)), 'aria-label': t('zoomIn'), disabled: zoom === 22 }, '+'))),
        h('div', { className: 'sy-canvas', tabIndex: 0, role: 'region', 'aria-label': diagram.title }, h('pre', { style: { fontSize: zoom } }, diagram.source)),
        h('figcaption', null, t(diagram.language === 'mermaid' ? 'mermaid' : 'original'), ' · ', h('button', { className: 'sy-link', onClick: () => openDocument(sourcePath, diagram.line) }, `${sourcePath}:${diagram.line}`)));
    }
    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        for (const [locale, dict] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register('shiyuWorkbench', locale, dict));
        const t = ctx.locale.bind('shiyuWorkbench');
        async function api(input, signal) {
          const response = await fetch(new URL('api/shiyu-workbench', window.location.href), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
          let result;
          try { result = await response.json(); } catch { throw new Error(`${t('error')} (HTTP ${response.status})`); }
          if (!result.ok) throw new Error(`${result.error?.message || t('error')} [${result.error?.code || response.status}]`);
          return result.data;
        }
        function Workbench() {
          useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
          const [snapshot, setSnapshot] = useState(null), [pathInput, setPathInput] = useState('');
          const [tab, setTab] = useState('candidates'), [query, setQuery] = useState(''), [filter, setFilter] = useState('');
          const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
          const [document, setDocument] = useState(null), [docLoading, setDocLoading] = useState(false), [raw, setRaw] = useState(false), [docLine, setDocLine] = useState(null);
          const request = useRef(null), docRequest = useRef(null), mounted = useRef(true), container = useRef(null);
          function cancelDocument() { docRequest.current?.abort(); docRequest.current = null; setDocument(null); setDocLoading(false); setDocLine(null); }
          async function refresh(selection) {
            request.current?.abort(); cancelDocument();
            const controller = new AbortController(); request.current = controller;
            setBusy(true); setError(''); setNotice('');
            try {
              if (selection) {
                await api({ action: 'select_workspace', path: selection }, controller.signal);
                if (controller.signal.aborted) return;
                setSnapshot(null); setQuery(''); setFilter(''); setNotice(t('saved'));
              }
              const data = await api({ action: 'snapshot' }, controller.signal);
              if (!controller.signal.aborted && mounted.current) { setSnapshot(data); setPathInput(data.workspacePath); }
            } catch (err) { if (!controller.signal.aborted && mounted.current) setError(err.message); }
            finally { if (request.current === controller && mounted.current) setBusy(false); }
          }
          async function openDocument(path, line) {
            docRequest.current?.abort(); const controller = new AbortController(); docRequest.current = controller;
            setDocLoading(true); setDocument(null); setError(''); setRaw(false); setDocLine(line || null);
            try {
              const result = await api({ action: 'read_document', path, workspacePath: snapshot.workspacePath }, controller.signal);
              if (!controller.signal.aborted && mounted.current) { setDocument(result); container.current?.scrollTo({ top: 0 }); }
            } catch (err) { if (!controller.signal.aborted && mounted.current) setError(err.message); }
            finally { if (docRequest.current === controller && mounted.current) setDocLoading(false); }
          }
          async function choose() {
            setError('');
            try { const value = await ctx.uiWorkspace.pickDirectory(); if (value && mounted.current) setPathInput(value); }
            catch (err) { if (mounted.current) setError(err.message); }
          }
          useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; request.current?.abort(); docRequest.current?.abort(); }; }, []);
          useEffect(() => {
            if (document && docLine && !raw) {
              const heads = [...container.current.querySelectorAll('[id^="sy-line-"]')];
              const target = heads.filter(e => Number(e.id.slice(8)) <= docLine).pop();
              target?.scrollIntoView({ block: 'start' });
            }
          }, [document, docLine, raw]);
          const button = (label, onClick, extra = {}) => h('button', { type: 'button', className: 'sy-btn', onClick, ...extra }, label);
          const locale = ctx.locale.getLocale().active;
          const formattedTime = snapshot ? new Date(snapshot.scannedAt).toLocaleString(locale) : '';
          const data = snapshot?.[tab] || [];
          const visible = data.filter(item => (!filter || item.status === filter) && `${item.title} ${item.direction} ${item.summary} ${item.type} ${item.status}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
          const stats = snapshot ? h('div', { className: 'sy-stats', title: t('countHint') }, ...[['candidates', 'candidates'], ['architecture', 'topics'], ['diagrams', 'diagrams']].map(([key, label]) => h('div', { className: 'sy-stat', key }, h('strong', null, snapshot.counts[key]), h('span', null, t(label))))) : null;
          const sourceLink = path => h('button', { type: 'button', className: 'sy-link', onClick: () => openDocument(path) }, t('read'), ' ↗');
          return h('div', { className: 'sy-workbench', ref: container }, h('style', null, css), h('div', { className: 'sy-wrap' },
            h('header', { className: 'sy-header' },
              h('div', { className: 'sy-heading' }, h(RainIcon, { size: 42 }), h('div', null, h('div', { className: 'sy-eyebrow' }, 'SHIYU / WORKBENCH'), h('h1', null, t('title')), h('p', { className: 'sy-sub' }, t('subtitle')))),
              h('div', { className: 'sy-actions' }, h('span', { className: 'sy-tag' }, t('version')), button(t('refresh'), () => refresh(), { disabled: busy, 'aria-busy': busy }))),
            error && h('div', { className: 'sy-error', role: 'alert' }, error, !snapshot && button(t('retry'), () => refresh())),
            notice && h('div', { className: 'sy-notice', role: 'status' }, notice),
            (document || docLoading) ? h(React.Fragment, null,
              h('div', { className: 'sy-reader-head' }, button('← ' + t('back'), cancelDocument), document && button(t(raw ? 'formatted' : 'raw'), () => setRaw(!raw))),
              docLoading ? h('div', { className: 'sy-empty', role: 'status' }, t('loadingDoc')) : h(React.Fragment, null,
                h('div', { className: 'sy-reader-source' }, t('source'), ' · ', document.path, ' · ', document.lineCount, ' ', t('lines'), ' · ', t('readOnly')),
                raw ? h('pre', { className: 'sy-raw' }, document.text) : h('div', { className: 'sy-reader-layout' }, h(Markdown, { document, openDocument }), h('nav', { className: 'sy-toc', 'aria-label': t('outline') },
                  h('strong', null, t('outline')), ...document.text.split('\n').map((line, i) => /^#{2,3}\s/.test(line) ? h('a', { key: i, href: `#sy-line-${i + 1}` }, line.replace(/^#+\s+/, '')) : null)))))
            : h(React.Fragment, null,
              h('section', { className: 'sy-workspace', 'aria-label': t('workspace') },
                h('h2', { className: 'sy-label' }, t('workspace')),
                snapshot && h('code', { className: 'sy-path' }, snapshot.workspacePath),
                h('form', { className: 'sy-form', onSubmit: e => { e.preventDefault(); if (!busy && pathInput.trim()) refresh(pathInput.trim()); } },
                  h('input', { className: 'sy-input', value: pathInput, onChange: e => setPathInput(e.target.value), 'aria-label': t('path'), placeholder: t('path'), disabled: busy }),
                  button(t('choose'), choose, { disabled: busy }),
                  h('button', { type: 'submit', className: 'sy-btn sy-primary', disabled: busy || !pathInput.trim() }, t('save'))),
                snapshot?.recent.length > 1 && h('div', { className: 'sy-history' }, h('label', { htmlFor: 'sy-recent' }, t('recent')), h('select', { id: 'sy-recent', className: 'sy-select', value: '', disabled: busy, onChange: e => { if (e.target.value) setPathInput(e.target.value); } }, h('option', { value: '' }, '—'), ...snapshot.recent.map(p => h('option', { key: p, value: p }, p)))),
                h('p', { className: 'sy-help' }, t('workspaceHint'))),
              busy && !snapshot && h('div', { className: 'sy-empty', role: 'status' }, t('loading')),
              stats,
              !!snapshot?.warnings.length && h('details', { className: 'sy-warnings' }, h('summary', null, `${t('warnings')} (${snapshot.warnings.length})`), h('ul', null, ...snapshot.warnings.map((w, i) => h('li', { key: i }, w.path, ' — ', w.message)))),
              snapshot && h(React.Fragment, null,
                h('nav', { className: 'sy-tabs', 'aria-label': t('document') }, ...['candidates', 'architecture'].map(key => h('button', { className: 'sy-tab', key, 'aria-current': tab === key, onClick: () => { setTab(key); setQuery(''); setFilter(''); } }, t(key)))),
                h('div', { className: 'sy-note' }, t(tab === 'candidates' ? 'candidateNote' : 'designNote')),
                h('div', { className: 'sy-toolbar' }, h('input', { className: 'sy-input', type: 'search', value: query, onChange: e => setQuery(e.target.value), placeholder: t('search'), 'aria-label': t('search') }),
                  tab === 'candidates' && h('select', { className: 'sy-select', value: filter, 'aria-label': t('all'), onChange: e => setFilter(e.target.value) }, h('option', { value: '' }, t('all')), ...[...new Set(data.map(d => d.status))].map(s => h('option', { value: s, key: s }, s))),
                  snapshot.indexes.some(i => i.section === tab) && button(t('index'), () => openDocument(snapshot.indexes.find(i => i.section === tab).path))),
                visible.length === 0 ? h('div', { className: 'sy-empty' }, h('p', null, t(data.length ? 'noResult' : 'empty')), !data.length && h('p', { className: 'sy-help' }, t('emptyHint'))) :
                  tab === 'candidates' ? h('div', { className: 'sy-grid' }, ...visible.map(item => h('article', { key: item.path, className: 'sy-card' },
                    h('h3', null, item.title), h('div', { className: 'sy-tags' }, h('span', { className: 'sy-tag' }, item.status), item.type && h('span', { className: 'sy-tag' }, item.type), !item.indexed && h('span', { className: 'sy-tag' }, t('unindexed'))),
                    h('p', { className: 'sy-direction' }, item.direction), h('p', null, item.summary),
                    item.statusDetail && h('p', { className: 'sy-status' }, `${t('evidence')}：${item.statusDetail}`),
                    h('footer', null, h('span', { className: 'sy-date' }, t('updated'), ' · ', item.updated || t('unknown')), sourceLink(item.path))))) :
                  h('div', { className: 'sy-blueprints' }, ...visible.map(item => h('article', { className: 'sy-design', key: item.path },
                    h('div', { className: 'sy-design-head' }, h('h3', null, item.title), h('p', { className: 'sy-direction' }, item.summary),
                      h('div', { className: 'sy-design-meta' }, h('div', null, `${t('designStatus')} · ${item.status}`), h('div', null, `${t('implementation')} · ${item.implementation || t('unknown')}`)), sourceLink(item.path)),
                    item.diagrams.length ? item.diagrams.map(diagram => h(Figure, { key: diagram.id, diagram, sourcePath: item.path, openDocument, t })) : h('div', { className: 'sy-figure sy-help' }, t('noDiagram'))))))),
            h('footer', { className: 'sy-bottom' }, h('span', null, t('boundary')), snapshot && h('span', null, `${t('scanned')} · ${formattedTime}`))));
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'shiyu-workbench', order: -10, label: () => t('nav') }, RainIcon));
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'shiyu-workbench' }, Workbench));
      },
    };
  },
});
