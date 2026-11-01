import path from 'node:path';

export const VERSION = '0.1.0';
export const MAX_BYTES = 512 * 1024;
export const MAX_FILES = 120;
const SECTIONS = { candidates: '技术候选', architecture: '架构与设计' };
export class WorkbenchError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkbenchError'; this.code = code; }
}
const fail = (code, message) => { throw new WorkbenchError(code, message); };
export function plain(value = '') {
  return value.replace(/\[([^\]]+)\]\((?:<[^>]+>|[^)]+)\)/g, '$1').replace(/[*`]/g, '').trim();
}
export function parseIndex(text, section) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim());
    const match = cells[0]?.match(/\[([^\]]+)\]\(<?([^>)]+)>?\)/);
    if (!match) continue;
    let filename;
    try { filename = decodeURIComponent(match[2]); } catch { continue; }
    if (filename.includes('/') || filename.includes('\\') || !/\.md$/i.test(filename)) continue;
    const c = cells.map(plain);
    rows.set(filename, section === 'candidates'
      ? { title: match[1], type: c[1] || '', direction: c[2] || '', status: c[3] || '', summary: c[4] || '', updated: c[5] || '' }
      : { title: match[1], summary: c[1] || '', status: c[2] || '', implementation: c[3] || '', updated: c[4] || '' });
  }
  return rows;
}
export function parseDocument(text, relativePath) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const fields = {};
  let heading = '', fence = null;
  const diagrams = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence && /^#{1,6}\s/.test(line)) heading = plain(line.replace(/^#+\s+/, ''));
    const marker = line.match(/^\s*(`{3,}|~{3,})([^`]*)$/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length, language: marker[2].trim().toLowerCase(), start: i + 2, heading, lines: [] };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
        if (['text', 'plaintext', 'mermaid', ''].includes(fence.language) && fence.lines.some(s => s.trim())) diagrams.push({ id: `${relativePath}:${fence.start}`, title: fence.heading, language: fence.language || 'text', line: fence.start, source: fence.lines.join('\n') });
        fence = null;
      } else fence.lines.push(line);
    } else if (fence) fence.lines.push(line);
    else if (/^\s*[-*]\s+\*\*/.test(line)) {
      const match = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*\s*(.*)$/);
      if (match) {
        const colon = match[1].search(/[:：]/);
        const key = (colon >= 0 ? match[1].slice(0, colon) : match[1]).trim();
        const value = (colon >= 0 ? match[1].slice(colon + 1) + match[2] : match[2]).replace(/^[:：]\s*/, '');
        if (key && value && !['__proto__', 'constructor', 'prototype'].includes(key)) fields[key] = plain(value);
      }
    } else if (line.trim().startsWith('|')) {
      const c = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(plain);
      if (c.length === 2 && c[0] && !/^[-:]+$/.test(c[0])) fields[c[0]] = c[1];
    }
  }
  const title = plain(lines.find(l => /^#\s/.test(l))?.replace(/^#\s+/, '') || path.basename(relativePath, '.md'));
  const summaryMatch = text.match(/##\s+(?:一句话判断|当前判断)[^\n]*\n+([^\n]+(?:\n(?!#|\n)[^\n]+)*)/);
  return { title, fields, diagrams, summary: plain(summaryMatch?.[1] || ''), lineCount: lines.length };
}
const validState = value => value && typeof value.workspacePath === 'string' && Array.isArray(value.recent) && value.recent.every(p => typeof p === 'string');

/** Plugin-owned state is only selected/recent directories. Documents stay read-only. */
export class ShiyuWorkbench {
  constructor(fs, unit, options = {}) {
    this.fs = fs; this.unit = unit; this.initialWorkspace = options.initialWorkspace;
    this.state = null; this.queue = Promise.resolve(); this.closed = false;
  }
  async initialize() {
    const stored = (await this.unit.loadAll()).global;
    if (stored != null && !validState(stored)) fail('INVALID_STATE', '工作台设置格式不正确；未覆盖原数据。');
    if (stored) this.state = { workspacePath: stored.workspacePath, recent: stored.recent.slice(0, 8) };
    else {
      const root = await this.validateWorkspace(this.initialWorkspace);
      this.state = { workspacePath: root.path, recent: [root.path] };
      await this.unit.setGlobal(this.state);
    }
  }
  async validateWorkspace(input, signal) {
    if (typeof input !== 'string' || !input.trim() || !path.isAbsolute(input.trim())) fail('INVALID_PATH', '请输入工作区的绝对目录路径。');
    const target = await this.fs.resolve(input.trim(), { signal });
    if ((await this.fs.stat(target, signal))?.type !== 'directory') fail('NOT_DIRECTORY', '工作区不存在或不是目录。');
    return { target, path: this.fs.processPath(target) };
  }
  async safeTarget(root, relativePath, signal) {
    if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\0') || relativePath.includes('\\')) fail('INVALID_DOCUMENT', '文档必须使用工作区内的相对路径。');
    const normalized = path.posix.normalize(relativePath);
    if (normalized === '..' || normalized.startsWith('../') || !/\.md$/i.test(normalized)) fail('INVALID_DOCUMENT', '仅支持工作区内的 Markdown 文档。');
    const target = await this.fs.resolve(normalized, { cwd: root.path, signal });
    if (!this.fs.contains(root.target, target)) fail('OUTSIDE_WORKSPACE', '拒绝读取指向工作区外的文件或符号链接。');
    return { target, relativePath: normalized };
  }
  async text(target, signal) {
    const info = await this.fs.stat(target, signal);
    if (info?.type !== 'file') fail('NOT_FILE', '文档不存在或不是普通文件。');
    if (info.size > MAX_BYTES) fail('TOO_LARGE', '文档超过第一版的 512 KiB 阅读限制。');
    const bytes = await this.fs.readBytes(target, signal, MAX_BYTES);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) fail('NOT_TEXT', '此文件不是 UTF-8 文本文档。');
    return { text, version: info.version, bytes: bytes.length };
  }
  async snapshot(signal) {
    const state = { ...this.state, recent: [...this.state.recent] };
    let root;
    const result = { version: VERSION, ...state, scannedAt: new Date().toISOString(), candidates: [], architecture: [], warnings: [], indexes: [], counts: {} };
    try { root = await this.validateWorkspace(state.workspacePath, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      result.warnings.push({ code: error.code || 'WORKSPACE_UNAVAILABLE', path: state.workspacePath, message: error.message });
      result.counts = { candidates: 0, architecture: 0, diagrams: 0 }; return result;
    }
    for (const [section, folder] of Object.entries(SECTIONS)) {
      signal?.throwIfAborted();
      const dir = await this.fs.resolve(folder, { cwd: root.path, signal });
      if (!this.fs.contains(root.target, dir)) { result.warnings.push({ code: 'OUTSIDE_WORKSPACE', path: folder, message: '资料目录指向工作区外，未读取。' }); continue; }
      try {
        if ((await this.fs.stat(dir, signal))?.type !== 'directory') { result.warnings.push({ code: 'MISSING_DIRECTORY', path: folder, message: '未找到资料目录；工作台不会自动创建或写入。' }); continue; }
        const entries = (await this.fs.listDir(dir, signal)).filter(e => e.type === 'file' && /\.md$/i.test(e.name));
        let index = new Map();
        if (entries.some(e => e.name === '目录.md')) {
          try {
            const safe = await this.safeTarget(root, `${folder}/目录.md`, signal);
            index = parseIndex((await this.text(safe.target, signal)).text, section);
            result.indexes.push({ section, path: `${folder}/目录.md` });
          } catch (error) { result.warnings.push({ code: error.code || 'READ_FAILED', path: `${folder}/目录.md`, message: error.message }); }
        }
        const documents = entries.filter(e => e.name !== '目录.md');
        if (documents.length > MAX_FILES) result.warnings.push({ code: 'FILE_LIMIT', path: folder, message: `仅加载前 ${MAX_FILES} 份文档。` });
        for (const entry of documents.slice(0, MAX_FILES)) {
          signal?.throwIfAborted();
          const relativePath = `${folder}/${entry.name}`;
          try {
            const safe = await this.safeTarget(root, relativePath, signal);
            const { text, version, bytes } = await this.text(safe.target, signal);
            const parsed = parseDocument(text, relativePath), row = index.get(entry.name);
            const item = {
              path: relativePath, title: row?.title || parsed.title,
              type: row?.type || parsed.fields['类型'] || parsed.fields['类型 / 方向'] || '', direction: row?.direction || parsed.fields['方向'] || '',
              status: row?.status || parsed.fields['设计状态'] || parsed.fields['当前状态'] || parsed.fields['状态'] || '未标注',
              statusDetail: parsed.fields['当前状态'] || parsed.fields['状态'] || parsed.fields['记录日期 / 状态'] || '',
              summary: row?.summary || parsed.summary, implementation: row?.implementation || parsed.fields['实现状态'] || parsed.fields['实现'] || '',
              updated: row?.updated || (parsed.fields['记录日期'] || parsed.fields['来源与日期'] || parsed.fields['创建 / 更新'] || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
              indexed: !!row, version, bytes, diagramCount: parsed.diagrams.length,
            };
            if (section === 'architecture') item.diagrams = parsed.diagrams;
            result[section].push(item);
          } catch (error) {
            if (signal?.aborted) throw error;
            result.warnings.push({ code: error.code || 'READ_FAILED', path: relativePath, message: error.message });
          }
        }
        for (const filename of index.keys()) if (!documents.some(e => e.name === filename)) result.warnings.push({ code: 'INDEX_TARGET_MISSING', path: `${folder}/${filename}`, message: '目录索引引用了缺失文档。' });
        const order = [...index.keys()];
        result[section].sort((a, b) => {
          const ai = order.indexOf(path.basename(a.path)), bi = order.indexOf(path.basename(b.path));
          return (ai < 0 ? MAX_FILES : ai) - (bi < 0 ? MAX_FILES : bi) || a.title.localeCompare(b.title, 'zh');
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        result.warnings.push({ code: error.code || 'SCAN_FAILED', path: folder, message: error.message });
      }
    }
    result.counts = { candidates: result.candidates.length, architecture: result.architecture.length, diagrams: result.architecture.reduce((n, d) => n + d.diagramCount, 0) };
    return result;
  }
  async selectWorkspace(input, signal) {
    const run = this.queue.then(async () => {
      signal?.throwIfAborted();
      const root = await this.validateWorkspace(input, signal);
      const next = { workspacePath: root.path, recent: [root.path, ...this.state.recent.filter(p => p !== root.path)].slice(0, 8) };
      signal?.throwIfAborted();
      await this.unit.setGlobal(next); this.state = next;
      return { workspacePath: next.workspacePath, recent: [...next.recent] };
    });
    this.queue = run.catch(() => {}); return run;
  }
  async readDocument(relativePath, workspacePath, signal) {
    if (workspacePath && workspacePath !== this.state.workspacePath) fail('WORKSPACE_CHANGED', '主要工作区已经变化，请刷新后重试。');
    const root = await this.validateWorkspace(this.state.workspacePath, signal);
    const safe = await this.safeTarget(root, relativePath, signal);
    const data = await this.text(safe.target, signal);
    return { workspacePath: root.path, path: safe.relativePath, ...data, ...parseDocument(data.text, safe.relativePath) };
  }
  async operate(request, signal) {
    if (this.closed) return { ok: false, error: { code: 'CLOSED', message: '工作台已卸载。' } };
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_REQUEST', '请求必须是对象。');
      let data;
      if (request.action === 'snapshot') data = await this.snapshot(signal);
      else if (request.action === 'select_workspace') data = await this.selectWorkspace(request.path, signal);
      else if (request.action === 'read_document') data = await this.readDocument(request.path, request.workspacePath, signal);
      else fail('INVALID_ACTION', '支持 snapshot、select_workspace、read_document。');
      return { ok: true, data };
    } catch (error) { return { ok: false, error: { code: error.code || (signal?.aborted ? 'ABORTED' : 'READ_FAILED'), message: error.message || String(error) } }; }
  }
  async close() { this.closed = true; await this.queue; await this.unit.close(); }
}
export const toolSchema = {
  name: 'shiyu_workbench',
  description: '查看识雨工作台资料、读取原文或选择主要工作区。选择会持久影响此配置下的工作台，但不改变会话目录或修改资料。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['snapshot', 'select_workspace', 'read_document'], description: 'snapshot 返回候选/图纸目录；read_document 返回 Markdown 原文；select_workspace 保存数据源目录。' },
      path: { type: 'string', description: 'select_workspace 使用绝对目录；read_document 使用 snapshot 返回的相对文档路径。' },
      workspacePath: { type: 'string', description: 'read_document 可传 snapshot 的 workspacePath，防止切换后的过期读取。' },
    }, required: ['action'],
  },
};
export function toolDefinition(service) {
  return { ...toolSchema,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => service.operate(args, exec.signal),
    isConcurrencySafe: args => args?.action !== 'select_workspace',
  };
}
export async function serveRequest(service, request) {
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return Response.json({ ok: false, error: { code: 'CONTENT_TYPE', message: '需要 application/json。' } }, { status: 415 });
  const text = await request.text();
  if (text.length > 8192) return Response.json({ ok: false, error: { code: 'TOO_LARGE', message: '请求过大。' } }, { status: 413 });
  let input;
  try { input = JSON.parse(text); } catch { return Response.json({ ok: false, error: { code: 'INVALID_JSON', message: 'JSON 格式错误。' } }, { status: 400 }); }
  const result = await service.operate(input, request.signal);
  return Response.json(result, { status: result.ok ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
}
