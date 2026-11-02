import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { defaultModel, REPLYER_PRESET_ID, sessionBindingKey, ShiyuSessionAdapter } from '../src/adapters/dsh/sessions.js';
import type { DshContext, ReplyDraftReadRequest, SessionBinding, SessionEvent } from '../src/adapters/dsh/sessions.js';

const text = '第一段 synthetic\n second block ';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const businessId = 'conversation-draft-read', scope = 'local-owner', sessionId = 'shiyu-replyer-persisted-synthetic';
  const binding: SessionBinding = { key: sessionBindingKey('replyer', businessId, scope), role: 'replyer', businessId, scope, sessionId,
    model: defaultModel('replyer'), status: 'released', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', usage: { status: 'unknown' } };
  const event: SessionEvent = { seq: 17, type: 'assistant/message', surfaceOp: 'append', data: { interrupted: false,
    message: { id: 'synthetic-assistant-id', role: 'assistant', content: [
      { type: 'text', text: '第一段 synthetic' }, { type: 'reasoning', text: 'not reply text' }, { type: 'text', text: ' second block ' },
    ] } } };
  const state = { bindings: [structuredClone(binding)], events: [structuredClone(event)], preset: REPLYER_PRESET_ID,
    loads: 0, opens: 0, reads: 0, closes: 0, services: [] as string[] };
  let onLoad: (() => void | Promise<void>) | undefined;
  let onOpen: (() => void | Promise<void>) | undefined;
  let onRead: (() => void | Promise<void>) | undefined;
  let onClose: (() => void | Promise<void>) | undefined;
  const forbidden = () => { throw new Error('A draft read attempted a forbidden native capability'); };
  const ctx = {
    on: forbidden, agents: { create: forbidden, resume: forbidden, list: forbidden },
    get(name: string) {
      state.services.push(name); assert.equal(name, 'sessionPersistence');
      return { async open(id: string, mode: string, options: { signal?: AbortSignal }) {
        state.opens++; assert.equal(id, sessionId); assert.equal(mode, 'read'); assert.ok(options && 'signal' in options);
        await onOpen?.();
        return { header: { agentPreset: state.preset },
          async read(offset: number, count: number, readOptions: { signal?: AbortSignal }) {
            state.reads++; assert.equal(offset, 17); assert.equal(count, 1); assert.equal(readOptions.signal, options.signal);
            await onRead?.(); return { events: structuredClone(state.events), eventState: 'detached' };
          },
          async close() { state.closes++; await onClose?.(); },
        };
      } };
    },
  } as unknown as DshContext;
  const options = { ctx, cwd: '/synthetic/unused', bindings: {
    async load() { state.loads++; await onLoad?.(); return structuredClone(state.bindings); },
    async save() { forbidden(); },
  } };
  const request: ReplyDraftReadRequest = { businessId, scope, assistantRef: { sessionId, eventSeq: 17, messageId: 'synthetic-assistant-id' }, textSha256: hash(text) };
  return { state, binding, event, request, adapter: new ShiyuSessionAdapter(options), reopen: () => new ShiyuSessionAdapter(options),
    onLoad(value: typeof onLoad) { onLoad = value; }, onOpen(value: typeof onOpen) { onOpen = value; },
    onRead(value: typeof onRead) { onRead = value; }, onClose(value: typeof onClose) { onClose = value; } };
}

test('cold draft read survives a new uninitialized adapter and never attaches, flushes or saves', async () => {
  const f = fixture(), before = structuredClone(f.state.bindings);
  const first = await f.adapter.readReplyDraft(f.request);
  assert.equal(first.text, text); assert.deepEqual(first.binding, f.binding); assert.deepEqual(first.assistantRef, f.request.assistantRef);
  first.binding.businessId = 'caller-local-copy'; first.assistantRef.messageId = 'caller-local-copy';
  await f.adapter.close();
  const reopened = f.reopen();
  try {
    const result = await reopened.readReplyDraft(f.request);
    assert.equal(result.text, text); assert.deepEqual(result.binding, f.binding); assert.deepEqual(result.assistantRef, f.request.assistantRef);
    assert.deepEqual(f.state.bindings, before);
    assert.deepEqual(f.state.services, ['sessionPersistence', 'sessionPersistence']);
    assert.deepEqual([f.state.loads, f.state.opens, f.state.reads, f.state.closes], [4, 2, 2, 2]);
  } finally { await reopened.close(); }
});

test('draft read rejects absent, wrong-scope, wrong-role and aliased persisted bindings before native access', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.bindings = []; },
    (f: ReturnType<typeof fixture>) => { f.state.bindings[0]!.scope = 'other-scope'; },
    (f: ReturnType<typeof fixture>) => { f.state.bindings[0]!.businessId = 'other-business'; },
    (f: ReturnType<typeof fixture>) => { f.state.bindings[0]!.role = 'worker'; },
    (f: ReturnType<typeof fixture>) => { f.state.bindings[0]!.sessionId = 'shiyu-replyer-another'; },
    (f: ReturnType<typeof fixture>) => { f.state.bindings.push({ ...f.binding, key: 'different-key', businessId: 'another-business' }); },
  ]) {
    const f = fixture(); change(f);
    try { await assert.rejects(f.adapter.readReplyDraft(f.request), /persisted managed Session binding/); assert.equal(f.state.opens, 0); }
    finally { await f.adapter.close(); }
  }
});

test('invalid draft references and caller scope cannot choose another native Session', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { textSha256: 'not-a-hash' }, { assistantRef: { ...f.request.assistantRef, eventSeq: -1 } },
      { assistantRef: { ...f.request.assistantRef, messageId: '' } },
      { assistantRef: { ...f.request.assistantRef, sessionId: 'unmanaged-session' } },
      { assistantRef: { ...f.request.assistantRef, sessionId: 'shiyu-replyer-foreign' } },
      { scope: 'another-scope' }, { businessId: 'another-business' },
    ]) await assert.rejects(f.adapter.readReplyDraft({ ...f.request, ...patch }));
    assert.equal(f.state.opens, 0);
  } finally { await f.adapter.close(); }
});

test('a wrong native preset is refused and its read-only handle is closed', async () => {
  const f = fixture(); f.state.preset = 'unrestricted-preset';
  try {
    await assert.rejects(f.adapter.readReplyDraft(f.request), /preset/);
    assert.deepEqual([f.state.opens, f.state.reads, f.state.closes], [1, 0, 1]);
  } finally { await f.adapter.close(); }
});

test('only the exact completed assistant event may supply a draft', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.events = []; },
    (f: ReturnType<typeof fixture>) => { f.state.events.push(structuredClone(f.event)); },
    (f: ReturnType<typeof fixture>) => { f.state.events[0]!.seq = 18; },
    (f: ReturnType<typeof fixture>) => { f.state.events[0]!.type = 'user/message'; },
    (f: ReturnType<typeof fixture>) => { f.state.events[0]!.data.message.id = 'another-assistant'; },
    (f: ReturnType<typeof fixture>) => { f.state.events[0]!.data.message.role = 'user'; },
    (f: ReturnType<typeof fixture>) => { f.state.events[0]!.data.interrupted = true; },
  ]) {
    const f = fixture(); change(f);
    try {
      await assert.rejects(f.adapter.readReplyDraft(f.request), /exact draft reference/);
      assert.equal(f.state.closes, 1);
    } finally { await f.adapter.close(); }
  }
});

test('text extraction preserves block order and whitespace and refuses changed or malformed text', async () => {
  for (const content of [[{ type: 'text', text: 'changed body' }], [{ type: 'text', text: 42 }], [{ type: 'reasoning', text: text }], [{ type: 'text', text: '  ' }]]) {
    const f = fixture(); f.state.events[0]!.data.message.content = content;
    try { await assert.rejects(f.adapter.readReplyDraft(f.request), /reply text|text hash/); assert.equal(f.state.closes, 1); }
    finally { await f.adapter.close(); }
  }
  const f = fixture();
  try { await assert.rejects(f.adapter.readReplyDraft({ ...f.request, textSha256: hash(text.trim()) }), /text hash/); }
  finally { await f.adapter.close(); }
});

test('persisted binding replacement during native read prevents draft release', async () => {
  const f = fixture();
  f.onRead(() => { f.state.bindings[0]!.sessionId = 'shiyu-replyer-replaced'; });
  try {
    await assert.rejects(f.adapter.readReplyDraft(f.request), /persisted managed Session binding/);
    assert.equal(f.state.loads, 2); assert.equal(f.state.closes, 1);
  } finally { await f.adapter.close(); }
});

test('pre-cancelled reads do no I/O and cancellation across open, read or close never releases text', async () => {
  for (const phase of ['before', 'open', 'read', 'close'] as const) {
    const f = fixture(), controller = new AbortController(), abort = () => controller.abort(new Error('synthetic cancelled read'));
    if (phase === 'before') abort();
    else if (phase === 'open') f.onOpen(abort);
    else if (phase === 'read') f.onRead(abort);
    else f.onClose(abort);
    try {
      await assert.rejects(f.adapter.readReplyDraft({ ...f.request, signal: controller.signal }), /synthetic cancelled read/);
      assert.equal(f.state.opens, phase === 'before' ? 0 : 1); assert.equal(f.state.closes, f.state.opens);
      if (phase === 'before') assert.equal(f.state.loads, 0);
    } finally { await f.adapter.close(); }
  }
});

test('read errors and close failures are not mistaken for a confirmed draft', async () => {
  for (const phase of ['read', 'close'] as const) {
    const f = fixture(), fail = () => { throw new Error(`synthetic ${phase} failure`); };
    if (phase === 'read') f.onRead(fail); else f.onClose(fail);
    try { await assert.rejects(f.adapter.readReplyDraft(f.request), new RegExp(`synthetic ${phase} failure`)); assert.equal(f.state.closes, 1); }
    finally { await f.adapter.close(); }
  }
});

test('adapter close drains a pending draft handle and prevents late body release', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.onRead(async () => { entered.resolve(); await release.promise; });
  const reading = f.adapter.readReplyDraft(f.request), rejected = assert.rejects(reading, /adapter is closed/);
  await entered.promise;
  let closed = false;
  const closing = f.adapter.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(closed, false); assert.equal(f.state.closes, 0);
  release.resolve(); await rejected; await closing;
  assert.equal(f.state.closes, 1); assert.equal(closed, true);
  await assert.rejects(f.adapter.readReplyDraft(f.request), /adapter is closed/);
});
