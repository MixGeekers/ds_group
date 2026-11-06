import { randomUUID } from 'node:crypto';
import { sha } from './store.mjs';

// Preserve DS-Bot's existing personal and group panel contract. All writes still
// use the same source-aware backend as chat and automatic review.
export function createMemoryPanel(rt, memory, { flush, botShot }) {
  const store = memory.store;
  const scopeTag = scope => scope.startsWith('room:') ? 'group' : scope;
  function panelOf(body) {
    if (body.roomId !== undefined && body.roomId !== null) {
      const room = rt.roomOf(String(body.roomId));
      if (!room) throw new Error('Unknown group chat');
      const keeper = rt.botOf(room.admin) || room.members.map(id => rt.botOf(id)).find(Boolean);
      return { body: { roomId: room.id }, roomId: room.id, keeper, filter: { scopes: [`room:${room.id}`] } };
    }
    const keeper = rt.botOf(String(body.botId || ''));
    if (!keeper) throw new Error('Unknown Bot');
    return { body: { botId: keeper.id }, keeper, filter: { botId: keeper.id } };
  }
  const entries = panel => store.list(panel.filter).map(row => ({ ...memory.describe(row), scope: scopeTag(row.scope), memoryScope: row.scope,
    added: new Date(row.observedAt).toISOString().slice(0, 10), by: row.saidBy,
    source: row.sourceRefs.map(ref => { const source = store.source(ref.id, ref.revision); return `${source?.authorId} · ${source?.roomId || '本地'} · ${source?.eventId || ref.id}`; }).join(', ') }));
  const changes = panel => {
    const ids = new Set(store.list({ ...panel.filter, history: true }).map(row => row.id));
    return store.history().filter(row => ids.has(row.id) && ['remember', 'forget'].includes(row.action));
  };
  function view(panel) {
    const rows = entries(panel);
    return { ...panel.body, entries: rows, sizes: {}, limits: { entry: 15000, main: 1e9, topic: 1e9, topics: 1e9 },
      summary: { text: rows.map(row => `- ${row.text}（${row.kind}，${row.memoryScope}；${row.saidBy}）`).join('\n'), at: Date.now() },
      fresh: true, summarizing: false, error: null, backend: memory.backend ? 'ombre' : 'local-exact', diagnostics: memory.errors.slice(-10) };
  }
  return async function memoryEndpoint(endpoint, body) {
    await rt.load();
    const panel = panelOf(body);
    if (endpoint === 'memory-view') return view(panel);
    if (endpoint === 'memory-history') {
      let rows = changes(panel);
      const idOf = row => row.changeId || `${row.action}:${row.id}`;
      if (body.before) { const at = rows.findIndex(row => idOf(row) === body.before); rows = at < 0 ? [] : rows.slice(at + 1); }
      return { rows: rows.slice(0, 50).map(row => {
        const record = store.get(row.id), id = idOf(row);
        return { id, time: new Date(row.at).toISOString(), op: row.action === 'forget' ? 'remove' : row.replaces ? 'replace' : 'add',
          scope: scopeTag(record.scope), text: record.text, by: record.saidBy, restored: Boolean(store.getMeta(`undone:${id}`)) };
      }), more: rows.length > 50 ? idOf(rows[49]) : null };
    }
    if (endpoint === 'memory-forget') {
      const matches = entries(panel).filter(row => body.id ? row.id === body.id : row.text === body.text
        && (!body.scope || row.scope === body.scope) && (body.topic === undefined || row.topic === body.topic));
      if (matches.length !== 1) throw new Error('MEMORY_FORGET_AMBIGUOUS');
      const entry = matches[0]; memory.forget(entry.botId, { id: entry.id, scope: entry.memoryScope }); return view(panel);
    }
    if (endpoint === 'memory-restore') {
      const change = changes(panel).find(row => row.changeId === body.id || `${row.action}:${row.id}` === body.id);
      if (!change) throw new Error('MEMORY_CHANGE_NOT_FOUND');
      store.undo(change.changeId || body.id); return view(panel);
    }
    if (endpoint === 'memory-ask') {
      if (!panel.keeper) throw new Error('No Bot is left in this group chat');
      const text = String(body.text || '').trim(); if (!text) throw new Error('Type a question or a change first');
      const before = new Set(changes(panel).map(row => row.changeId));
      const id = panel.keeper.id;
      memory.ingest(id, { event: { eventId: `panel:${randomUUID()}`, roomId: panel.roomId, body: text },
        context: { source: { transport: 'native', roomId: panel.roomId,
          sender: { id: `user-${sha(rt.home).slice(0, 16)}`, name: 'Local user', kind: 'human' } } } });
      await flush(id);
      const result = await memory.recall(id, { query: text, scope: panel.roomId ? `room:${panel.roomId}` : 'all' });
      const reply = await botShot(panel.keeper, 'Answer the user’s memory-panel question briefly in their language using only the supplied current records. Distinguish original authors, room scope, reported claims and unresolved conflicts. State when information is missing.', JSON.stringify({ question: text, memories: result }));
      return { reply, changes: changes(panel).filter(row => !before.has(row.changeId)).map(row => ({
        op: row.action === 'forget' ? 'remove' : row.replaces ? 'edit' : 'add', scope: scopeTag(store.get(row.id).scope), text: store.get(row.id).text, ok: true })), view: view(panel) };
    }
    throw new Error(`Unknown memory endpoint ${endpoint}`);
  };
}
