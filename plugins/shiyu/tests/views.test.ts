import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadViewError, ReadViewService } from '../src/views/index.js';
import type { ComponentSnapshot, ReadViewAuthorityPort, ReadViewComponentPort, SourceVisibility, TrustedViewActor, ViewAccess, ViewRecord, ViewRequest, ViewSourceRef } from '../src/views/index.js';

const start = '2026-11-02T12:00:00.000Z';
const actor: TrustedViewActor = { principalId: 'reply-agent', role: 'replyer', scopes: ['group:one'] };
const request: ViewRequest = { requestId: 'request-one', purpose: 'reply_context', conversationId: 'conversation-one' };
const use = { purpose: 'reply_context' as const, conversationId: 'conversation-one' };
const code = (...values: string[]) => (error: unknown) => error instanceof ReadViewError && values.includes(error.code);
const ref = (sourceId = 'source-public', revision: string | number = 7): ViewSourceRef => ({ sourceId, revision, observedAt: start, trustClass: 'observed' });
const record = (patch: Partial<ViewRecord> = {}): ViewRecord => ({
  recordId: 'record-public', scope: 'group:one', audienceIds: ['owner', 'peer'], resourceRefs: ['conversation:conversation-one'],
  fields: { title: '公开合成事实', summary: '合成内容，仅用于模块测试', secret: 'do-not-return-this-field' }, sourceRefs: [ref()],
  aggregateVersion: { aggregateType: 'fact', aggregateId: 'aggregate-public', version: 3 }, ...patch,
});
function access(): ViewAccess {
  return {
    principalId: actor.principalId, purpose: 'reply_context', scope: 'group:one', audienceIds: ['owner', 'peer'],
    resourceRefs: ['conversation:conversation-one', 'task:task-one'], components: [{ backendId: 'control', fields: ['title', 'summary'] }],
    expiresAt: '2026-11-02T13:00:00.000Z', policyVersion: 1, authEpoch: 4, tombstoneWatermark: 6,
    appliedSafety: { authEpoch: 4, tombstoneWatermark: 6 }, commitSeq: 19, stateVersion: 2, indexWatermark: 11,
    conversation: { bindingId: 'binding-one', conversationId: 'conversation-one', scope: 'group:one', audienceVersion: 3,
      conversationGeneration: 5, routingRevision: 2, sessionEpoch: 1, contextVersion: 8 },
  };
}
function component(records: ViewRecord[] = [record()]): ComponentSnapshot {
  return { capturedAt: start, componentRevision: 22, indexVersion: 9, freshness: { status: 'current' },
    appliedSafety: { authEpoch: 4, tombstoneWatermark: 6 }, records };
}
function fixture() {
  let now = new Date(start), sequence = 0, reads = 0, checks = 0, writes = 0, authorityCalls = 0;
  const state = {
    access: access(), component: component(), visibility: new Map<string, SourceVisibility['status']>(),
    missingSources: new Set<string>(), sourceRevisions: new Map<string, string | number>(), beforeRead: undefined as undefined | (() => void),
    beforeVisibility: undefined as undefined | (() => void), readFailure: false, authorityFailure: false,
    authorityRequests: [] as ViewRequest[], componentRequests: [] as unknown[],
  };
  const authority: ReadViewAuthorityPort = {
    resolve(who, req) {
      authorityCalls++; state.authorityRequests.push(structuredClone(req));
      if (state.authorityFailure) throw new Error('secret internal diagnostic');
      if (who.principalId !== actor.principalId) return null;
      return structuredClone(state.access);
    },
    checkSources(_access, refs) {
      checks++; state.beforeVisibility?.();
      return refs.filter(item => !state.missingSources.has(item.sourceId)).map(item => ({ sourceId: item.sourceId, revision: state.sourceRevisions.get(item.sourceId) ?? item.revision,
        ...(item.contentHash ? { contentHash: item.contentHash } : {}), status: state.visibility.get(item.sourceId) ?? 'visible' }));
    },
  };
  const port: ReadViewComponentPort & { write(): void } = {
    backendId: 'control', read(req) {
      reads++; state.componentRequests.push(structuredClone(req)); state.beforeRead?.();
      if (state.readFailure) throw new Error('business body must not appear in fallback');
      return structuredClone(state.component);
    }, write() { writes++; },
  };
  const service = new ReadViewService({ authority, components: [port], now: () => new Date(now), newId: () => `view-${++sequence}` });
  return { service, state, port, authority, setTime(value: string) { now = new Date(value); }, stats: () => ({ reads, checks, writes, authorityCalls }) };
}

test('trusted scope, whole audience and exact resources clip both fields and private metadata', async () => {
  const f = fixture();
  f.state.component.records = [record(),
    record({ recordId: 'private-audience', audienceIds: ['owner'], sourceRefs: [ref('private-audience-source')], aggregateVersion: { aggregateType: 'private', aggregateId: 'do-not-expose-audience', version: 1 } }),
    record({ recordId: 'private-scope', scope: 'private:owner', sourceRefs: [ref('private-scope-source')] }),
    record({ recordId: 'private-resource', resourceRefs: ['task:task-two'], sourceRefs: [ref('private-task-source')] }),
  ];
  const view = await f.service.read(actor, request);
  assert.deepEqual(view.data, [{ backendId: 'control', recordId: 'record-public', fields: { title: '公开合成事实', summary: '合成内容，仅用于模块测试' } }]);
  assert.deepEqual(view.sourceRefs, [ref()]); assert.deepEqual(view.aggregateVersions, [{ aggregateType: 'fact', aggregateId: 'aggregate-public', version: 3 }]);
  assert.doesNotMatch(JSON.stringify(view), /private-|do-not-return|do-not-expose/);
  assert.equal(f.stats().writes, 0);
  await assert.rejects(f.service.read(actor, { ...request, actor, scope: 'private:owner' } as ViewRequest), code('INVALID_SCHEMA'));
  await assert.rejects(f.service.read({ ...actor, scopes: ['private:owner'] }, request), code('FORBIDDEN'));
  await assert.rejects(f.service.read(actor, { ...request, taskId: 'task-two' }), code('FORBIDDEN'));
  await assert.rejects(f.service.read(actor, { ...request, purpose: 'core_decision' }), code('FORBIDDEN'));
});

test('every source of mixed content must be visible, live and independently checked', async () => {
  const f = fixture();
  f.state.component.records = [record(),
    record({ recordId: 'mixed-private', fields: { title: 'hidden mixture' }, sourceRefs: [ref(), ref('private')] }),
    record({ recordId: 'mixed-deleted', fields: { title: 'deleted mixture' }, sourceRefs: [ref(), ref('deleted')] }),
    record({ recordId: 'missing-check', fields: { title: 'unchecked mixture' }, sourceRefs: [ref(), ref('missing')] }),
    record({ recordId: 'untraced', fields: { title: 'untraced summary' }, sourceRefs: [] }),
  ];
  f.state.visibility.set('private', 'forbidden'); f.state.visibility.set('deleted', 'deleted'); f.state.missingSources.add('missing');
  const view = await f.service.read(actor, request);
  assert.equal(view.data.length, 1); assert.deepEqual(view.sourceRefs, [ref()]);
  assert.equal(view.freshness.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(view), /hidden mixture|deleted mixture|unchecked mixture|untraced summary|"private"|"deleted"|"missing"/);
});

test('unavailable, missing, changed or absent provenance is unknown rather than confirmed empty', async () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => f.state.visibility.set('source-public', 'unavailable'),
    (f: ReturnType<typeof fixture>) => f.state.missingSources.add('source-public'),
    (f: ReturnType<typeof fixture>) => f.state.sourceRevisions.set('source-public', 8),
    (f: ReturnType<typeof fixture>) => { f.state.component.records[0].sourceRefs = []; },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    const view = await f.service.read(actor, request);
    assert.deepEqual(view.data, []); assert.deepEqual(view.sourceRefs, []);
    assert.equal(view.freshness.status, 'unavailable');
    assert.deepEqual(view.components[0].freshness, { status: 'unavailable', reason: 'source_unverified' });
  }
  const deleted = fixture(); deleted.state.visibility.set('source-public', 'deleted');
  const view = await deleted.service.read(actor, request);
  assert.equal(view.freshness.status, 'current'); assert.deepEqual(view.data, []);
});

test('local and component authorization/deletion barriers fail closed before business output', async () => {
  for (const patch of [{ authEpoch: null, tombstoneWatermark: 6 }, { authEpoch: 3, tombstoneWatermark: 6 }, { authEpoch: 4, tombstoneWatermark: 5 }]) {
    const f = fixture(); f.state.access.appliedSafety = patch;
    await assert.rejects(f.service.read(actor, request), code('SECURITY_STATE_UNAVAILABLE')); assert.equal(f.stats().reads, 0);
  }
  const f = fixture(); f.state.component.appliedSafety = { authEpoch: 4, tombstoneWatermark: null };
  await assert.rejects(f.service.read(actor, request), code('SECURITY_STATE_UNAVAILABLE'));
  assert.equal(f.stats().checks, 0);
});

test('component versions and freshness remain independent; unavailable sources never recover old summaries', async () => {
  const f = fixture();
  // ReadView access is readonly at the service boundary; the synthetic authority owns this update.
  f.state.access.components = [...f.state.access.components.filter(item => item.backendId !== 'ombre'), { backendId: 'ombre', fields: ['summary'] }];
  f.state.component.freshness = { status: 'stale', reason: 'private backend diagnostic must be hidden' };
  const view = await f.service.read(actor, request);
  assert.equal(view.commitSeq, 19); assert.equal(view.stateVersion, 2); assert.equal(view.consistency, 'component-scoped');
  assert.deepEqual(view.components.find(item => item.backendId === 'control'), { backendId: 'control', capturedAt: start, componentRevision: 22, indexVersion: 9, freshness: { status: 'stale', reason: 'source_reported_stale' } });
  assert.deepEqual(view.components.find(item => item.backendId === 'ombre'), { backendId: 'ombre', capturedAt: null, freshness: { status: 'unavailable', reason: 'not_connected' } });
  assert.equal(view.components.find(item => item.backendId === 'conversation')?.componentRevision, 8);
  assert.equal(view.freshness.status, 'unavailable'); assert.equal(view.data.length, 1);
  assert.doesNotMatch(JSON.stringify(view), /private backend/);
  f.state.readFailure = true;
  const failed = await f.service.read(actor, request);
  assert.deepEqual(failed.data, []); assert.deepEqual(failed.sourceRefs, []);
  assert.equal(failed.components[0].freshness.reason, 'read_failed');
  f.state.readFailure = false; delete f.state.component.componentRevision;
  const unknown = await f.service.read(actor, request);
  assert.deepEqual(unknown.data, []); assert.equal(unknown.components[0].freshness.reason, 'version_unknown');
  assert.equal(unknown.components[0].componentRevision, undefined);
});

test('revoke/delete/audience/generation/route/session changes during reads cannot escape final validation', async () => {
  const mutations: ((access: ViewAccess) => void)[] = [
    value => { value.authEpoch++; value.appliedSafety.authEpoch = value.authEpoch; },
    value => { value.tombstoneWatermark++; value.appliedSafety.tombstoneWatermark = value.tombstoneWatermark; },
    value => { value.audienceIds = [...value.audienceIds, 'new-member']; value.conversation!.audienceVersion++; },
    value => { value.conversation!.conversationGeneration++; }, value => { value.conversation!.routingRevision++; },
    value => { value.conversation!.sessionEpoch++; }, value => { delete value.conversation; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.state.beforeVisibility = () => mutate(f.state.access);
    await assert.rejects(f.service.read(actor, request), code('VIEW_INVALIDATED', 'FORBIDDEN'));
  }
  const beforeRead = fixture(); beforeRead.state.beforeRead = () => { beforeRead.state.access.policyVersion++; };
  await assert.rejects(beforeRead.service.read(actor, request), code('VIEW_INVALIDATED'));
});

test('view IDs are not bearer authority and are bound to actor, role, purpose and usage context', async () => {
  const f = fixture(); const view = await f.service.read(actor, request);
  await f.service.assertCurrent(actor, view.viewId, use);
  await assert.rejects(f.service.assertCurrent({ ...actor, principalId: 'another' }, view.viewId, use), code('FORBIDDEN'));
  await assert.rejects(f.service.assertCurrent({ ...actor, role: 'core' }, view.viewId, use), code('FORBIDDEN'));
  await assert.rejects(f.service.assertCurrent(actor, view.viewId, { ...use, conversationId: 'other' }), code('FORBIDDEN'));
  await assert.rejects(f.service.assertCurrent(actor, view.viewId, { purpose: 'task_status', taskId: 'task-one' }), code('FORBIDDEN'));
  await assert.rejects(f.service.assertCurrent(actor, 'guessed-view', use), code('FORBIDDEN'));
  assert.throws(() => view.sourceRefs.push(ref('forged')));
  assert.throws(() => { view.data[0].fields.title = 'mutated'; });
  f.state.component.records[0].fields = { title: 'later source object' };
  assert.equal(view.data[0].fields.title, '公开合成事实');
  await f.service.assertCurrent(actor, view.viewId, use);
});

test('invalidation does not depend on notifications or global stateVersion, while unrelated context changes survive', async () => {
  const f = fixture(); const view = await f.service.read(actor, request);
  f.state.access.conversation!.contextVersion++; f.state.access.commitSeq++;
  await f.service.assertCurrent(actor, view.viewId, use);
  f.state.visibility.set('source-public', 'deleted');
  await assert.rejects(f.service.assertCurrent(actor, view.viewId, use), code('VIEW_INVALIDATED'));
  f.state.visibility.clear(); f.state.access.authEpoch++; f.state.access.appliedSafety.authEpoch = f.state.access.authEpoch;
  assert.equal(f.state.access.stateVersion, 2);
  await assert.rejects(f.service.assertCurrent(actor, view.viewId, use), code('VIEW_INVALIDATED'));
});

test('assertCurrent rechecks security after source inspection and cannot race an audience change', async () => {
  const f = fixture(); const view = await f.service.read(actor, request);
  f.state.beforeVisibility = () => { f.state.access.conversation!.audienceVersion++; };
  await assert.rejects(f.service.assertCurrent(actor, view.viewId, use), code('VIEW_INVALIDATED'));
});

test('TTL is capped by authority expiry and slow reads fail at the exact boundary', async () => {
  const f = fixture(); f.state.access.expiresAt = '2026-11-02T12:00:05.000Z';
  const view = await f.service.read(actor, request); assert.equal(view.expiresAt, f.state.access.expiresAt);
  f.setTime('2026-11-02T12:00:05.000Z');
  await assert.rejects(f.service.assertCurrent(actor, view.viewId, use), code('FORBIDDEN', 'EXPIRED'));
  const slow = fixture(); slow.state.beforeVisibility = () => slow.setTime('2026-11-02T12:00:30.000Z');
  await assert.rejects(slow.service.read(actor, request), code('EXPIRED'));
  const ordinary = fixture(); assert.equal((await ordinary.service.read(actor, request)).expiresAt, '2026-11-02T12:00:30.000Z');
  const componentExpiry = fixture(); componentExpiry.state.component.expiresAt = '2026-11-02T12:00:03.000Z';
  const current = await componentExpiry.service.read(actor, request); assert.equal(current.expiresAt, '2026-11-02T12:00:03.000Z');
  componentExpiry.setTime(current.expiresAt);
  await assert.rejects(componentExpiry.service.assertCurrent(actor, current.viewId, use), code('FORBIDDEN', 'EXPIRED'));
  const historical = await componentExpiry.service.read(actor, request);
  assert.equal(historical.freshness.status, 'stale'); assert.equal(historical.data.length, 1);
});

test('hung component reads become unavailable with no old content, and disposal aborts outstanding reads', async () => {
  const f = fixture(); let aborted = 0;
  const service = new ReadViewService({ authority: f.authority, now: () => new Date(start), componentTimeoutMs: 2,
    components: [{ backendId: 'control', read(_request, signal) { signal!.addEventListener('abort', () => aborted++, { once: true }); return new Promise(() => {}); } }] });
  const view = await service.read(actor, request);
  assert.equal(aborted, 1); assert.deepEqual(view.data, []); assert.equal(view.components[0].freshness.reason, 'read_timeout');
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const disposable = new ReadViewService({ authority: f.authority, now: () => new Date(start),
    components: [{ backendId: 'control', read(_request, signal) { signal!.addEventListener('abort', () => aborted++, { once: true }); began(); return new Promise(() => {}); } }] });
  const pending = assert.rejects(disposable.read(actor, request), code('DISPOSED'));
  await started; disposable.dispose(); await pending; assert.equal(aborted, 2);
});

test('limits apply to actual UTF-8 bytes and all records, without increasing caller limits', async () => {
  const f = fixture();
  f.state.component.records = Array.from({ length: 12 }, (_, index) => record({ recordId: `record-${index}`, fields: { title: `item ${index}` } }));
  const small = await f.service.read(actor, { ...request, maxItems: 3 });
  assert.equal(small.data.length, 3); assert.equal(small.truncated.items, true);
  f.state.component.records = [record({ fields: { title: '雨'.repeat(3000) } })];
  const bytes = await f.service.read(actor, { ...request, maxBytes: 4096 });
  assert.equal(bytes.truncated.bytes, true); assert.deepEqual(bytes.data, []); assert.ok(Buffer.byteLength(JSON.stringify(bytes), 'utf8') <= 4096);
  await assert.rejects(f.service.read(actor, { ...request, maxBytes: 1 }), code('VIEW_TOO_LARGE'));
  await assert.rejects(f.service.read(actor, { ...request, maxItems: 21 }), code('INVALID_SCHEMA'));
  await assert.rejects(f.service.read(actor, { ...request, maxBytes: 65537 }), code('INVALID_SCHEMA'));
});

test('read ports stay read-only and query text is not retained as authority or substituted for absent sources', async () => {
  const f = fixture(); const query = 'private-synthetic-query-not-authority';
  const one = await f.service.read(actor, { ...request, query });
  await f.service.read(actor, request); await f.service.assertCurrent(actor, one.viewId, use);
  assert.equal(f.stats().reads, 2); assert.equal(f.stats().writes, 0);
  assert.ok(f.state.authorityRequests.every(item => item.query === undefined));
  assert.doesNotMatch(JSON.stringify(one), /private-synthetic-query|write\(\)/);
  f.state.authorityFailure = true;
  await assert.rejects(f.service.read(actor, { ...request, query: 'fall back to chat summary' }), code('DEPENDENCY_UNAVAILABLE'));
  f.service.release(one.viewId); f.state.authorityFailure = false;
  await assert.rejects(f.service.assertCurrent(actor, one.viewId, use), code('FORBIDDEN'));
  f.service.dispose(); await assert.rejects(f.service.read(actor, request), code('DISPOSED'));
});

test('scoped authority baseline identities are returned and invalidate views independently of numeric watermarks', async () => {
  const f = fixture();
  f.state.access.authority = { publicationBaselineId: 'publication-one', policyAuthorityId: 'policy-one', deletionAuthorityId: 'deletion-one', deletionScope: 'local-task-source', indexMode: 'not-used' };
  const view = await f.service.read(actor, request); assert.deepEqual(view.authority, f.state.access.authority);
  f.state.access.authority.deletionAuthorityId = 'replacement-deletion-baseline';
  await assert.rejects(f.service.assertCurrent(actor, view.viewId, use), code('VIEW_INVALIDATED'));
});
