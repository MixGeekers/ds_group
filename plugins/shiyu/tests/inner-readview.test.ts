import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadViewError, ReadViewService, type ComponentBodyRecord, type ComponentSnapshot, type ReadViewAuthorityPort,
  type ReadViewBodyRequest, type ReadViewComponentPort, type SourceVisibility, type TrustedViewActor, type ViewAccess,
  type ViewInnerAuthority, type ViewRecord, type ViewRequest, type ViewSourceRef } from '../src/views/index.js';

const start = '2026-11-02T12:00:00.000Z';
const actor: TrustedViewActor = { principalId: 'reply-agent', role: 'replyer', scopes: ['local-owner'] };
const request: ViewRequest = { requestId: 'request-one', purpose: 'reply_context', conversationId: 'conversation-one' };
const use = { purpose: 'reply_context' as const, conversationId: 'conversation-one' };
const code = (...values: string[]) => (error: unknown) => error instanceof ReadViewError && values.includes(error.code);
const ref = (sourceId = 'source-public'): ViewSourceRef => ({ sourceId, revision: 3, observedAt: start, trustClass: 'trusted-control-ledger' });
const authority = (): ViewInnerAuthority => ({ domain: 'relationship', authorityId: 'relationship-authority', installationGeneration: 'install-one',
  policyVersion: 1, tombstoneWatermark: 0, baselineId: 'baseline-one' });
const record = (recordId: string, patch: Partial<ViewRecord> = {}): ViewRecord => ({
  recordId, scope: 'local-owner', audienceIds: ['local-owner'], resourceRefs: [`inner:relationship:${recordId}`],
  fields: { recordId, kind: 'assertion' }, sourceRefs: [ref(`source-${recordId}`)], ...patch,
});
function access(): ViewAccess {
  return {
    principalId: actor.principalId, purpose: 'reply_context', scope: 'local-owner', audienceIds: ['local-owner'],
    resourceRefs: ['conversation:conversation-one', 'inner:relationship:record-a'],
    components: [{ backendId: 'control-relationship', fields: ['recordId', 'kind'], bodyFields: ['body'], authority: 'relationship' }],
    expiresAt: '2026-11-02T13:00:00.000Z', policyVersion: 1, authEpoch: 4, tombstoneWatermark: 6,
    appliedSafety: { authEpoch: 4, tombstoneWatermark: 6 }, commitSeq: 19, stateVersion: 2, indexWatermark: 0,
    conversation: { bindingId: 'binding-one', conversationId: 'conversation-one', scope: 'local-owner', audienceVersion: 1,
      conversationGeneration: 2, routingRevision: 1, sessionEpoch: 1, contextVersion: 3 },
    authority: { publicationBaselineId: 'published', policyAuthorityId: 'policy', deletionAuthorityId: 'task-deletion',
      deletionScope: 'local-task-source', indexMode: 'not-used', inner: { relationship: authority() } },
  };
}
function component(): ComponentSnapshot {
  return { capturedAt: start, componentRevision: 4, verifiedSourceHash: 'a'.repeat(64), innerAuthority: authority(),
    freshness: { status: 'current' }, appliedSafety: { authEpoch: 4, tombstoneWatermark: 6 },
    records: [record('record-a'), record('record-private', { audienceIds: ['other'], resourceRefs: ['conversation:private'], sourceRefs: [ref('private-source')] })] };
}
function fixture() {
  const state = {
    access: access(), component: component(), visibility: new Map<string, SourceVisibility['status']>(), bodyRequests: [] as ReadViewBodyRequest[],
    body: [{ recordId: 'record-a', fields: { body: '合成正文A' } }] as readonly ComponentBodyRecord[],
    bodyFailure: undefined as undefined | 'throw', bodyMissing: false, bodyUnknown: false, bodyDuplicate: false,
    resolveCount: 0, changeOnSecondResolve: false, bodyFields: undefined as undefined | readonly string[],
  };
  const authorityPort: ReadViewAuthorityPort = {
    resolve() {
      state.resolveCount++;
      if (state.changeOnSecondResolve && state.resolveCount > 1) state.access.authority!.inner!.relationship!.tombstoneWatermark++;
      return structuredClone(state.access);
    },
    checkSources(_access, refs) { return refs.map(item => ({ sourceId: item.sourceId, revision: item.revision, status: state.visibility.get(item.sourceId) ?? 'visible' as const })); },
  };
  const port: ReadViewComponentPort = {
    backendId: 'control-relationship',
    read: () => structuredClone(state.component),
    readBody(req) {
      state.bodyRequests.push(structuredClone(req));
      if (state.bodyFailure === 'throw') throw new Error('synthetic body timeout');
      if (state.bodyMissing) return [{ recordId: 'record-a', fields: { body: '部分正文' } }].filter(() => false);
      if (state.bodyUnknown) return [...state.body, { recordId: 'record-not-captured', fields: { body: '泄露正文' } }];
      if (state.bodyDuplicate) return [...state.body, ...state.body];
      return state.body.filter(entry => req.recordIds.includes(entry.recordId));
    },
  };
  let now = new Date(start), sequence = 0;
  const service = new ReadViewService({ authority: authorityPort, components: [port], now: () => new Date(now), newId: () => `view-${++sequence}` });
  return { service, state };
}

test('metadata is audience-trimmed before any body read; only eligible records are requested', async t => {
  const f = fixture();
  const view = await f.service.read(actor, request);
  assert.deepEqual(f.state.bodyRequests.map(item => [...item.recordIds]), [['record-a']]);
  assert.deepEqual(f.state.bodyRequests[0]!.fields, ['body']);
  assert.deepEqual(view.data, [{ backendId: 'control-relationship', recordId: 'record-a', fields: { recordId: 'record-a', kind: 'assertion', body: '合成正文A' } }]);
  assert.doesNotMatch(JSON.stringify(view), /record-private|private-source|泄露正文/);
  assert.equal(view.authority!.inner!.relationship!.authorityId, 'relationship-authority');
  assert.equal(view.freshness.status, 'current');
  await f.service.assertCurrent(actor, view.viewId, use);
  t.diagnostic(`body requests: ${f.state.bodyRequests.length}`);
});

test('a missing body port is an explicit unavailable component, never an empty success', async () => {
  const f = fixture(), service = new ReadViewService({ now: () => new Date(start), authority: {
    resolve: () => structuredClone(f.state.access), checkSources: (_a, refs) => refs.map(item => ({ ...item, status: 'visible' as const })) },
  components: [{ backendId: 'control-relationship', read: () => structuredClone(f.state.component) }] });
  const view = await service.read(actor, request);
  assert.equal(view.freshness.status, 'unavailable'); assert.equal(view.freshness.reason, 'component_unavailable');
  assert.deepEqual(view.data, []);
  assert.equal(view.components[0]!.freshness.reason, 'body_not_connected');
});

test('an incomplete, unknown or duplicate body response is refused instead of exposing partial content', async () => {
  for (const mode of ['missing', 'unknown', 'duplicate'] as const) {
    const f = fixture(); f.state[mode === 'missing' ? 'bodyMissing' : mode === 'unknown' ? 'bodyUnknown' : 'bodyDuplicate'] = true;
    await assert.rejects(f.service.read(actor, request), code('INVALID_COMPONENT'));
  }
});

test('a failing or timed-out body read marks the component unavailable without falling back to metadata success', async () => {
  const f = fixture(); f.state.bodyFailure = 'throw';
  const view = await f.service.read(actor, request);
  assert.equal(view.freshness.status, 'unavailable'); assert.deepEqual(view.data, []);
});

test('the inner-domain authority must match the live domain exactly and requires an explicit grant', async () => {
  for (const key of ['authorityId', 'installationGeneration', 'policyVersion', 'tombstoneWatermark', 'baselineId'] as const) {
    const f = fixture();
    const value = f.state.component.innerAuthority!;
    if (key === 'policyVersion' || key === 'tombstoneWatermark') (value as unknown as Record<string, number>)[key] += 1;
    else if (typeof value[key] === 'number') (value as unknown as Record<string, number>)[key] += 1;
    else (value as unknown as Record<string, string>)[key] = `${value[key]}-changed`;
    await assert.rejects(f.service.read(actor, request), code('SECURITY_STATE_UNAVAILABLE'));
  }
  const absent = fixture(); delete (absent.state.component as { innerAuthority?: ViewInnerAuthority }).innerAuthority;
  await assert.rejects(absent.service.read(actor, request), code('SECURITY_STATE_UNAVAILABLE'));
  const ungranted = fixture(); delete ungranted.state.access.authority!.inner;
  await assert.rejects(ungranted.service.read(actor, request), code('DEPENDENCY_UNAVAILABLE'));
  const wrongBackend = fixture(); wrongBackend.state.access.components[0]!.backendId = 'control-emotion';
  await assert.rejects(wrongBackend.service.read(actor, request), code('DEPENDENCY_UNAVAILABLE'));
});

test('a domain authority change between metadata and content refuses to return the view', async () => {
  const f = fixture(); f.state.changeOnSecondResolve = true;
  await assert.rejects(f.service.read(actor, request), code('VIEW_INVALIDATED'));
});

test('unexpected body fields are filtered and never widen the granted field surface', async () => {
  const f = fixture(); f.state.body = [{ recordId: 'record-a', fields: { body: '正文A', extra: '不该出现' } }];
  const view = await f.service.read(actor, request);
  assert.deepEqual(view.data[0]!.fields, { recordId: 'record-a', kind: 'assertion', body: '正文A' });
  assert.doesNotMatch(JSON.stringify(view), /不该出现/);
});

test('bodyFields metadata is part of the scope identity and cannot be replaced by a stale authority', async () => {
  const f = fixture(), first = await f.service.read(actor, request);
  f.state.access.components[0]!.bodyFields = ['body', 'kind'];
  await assert.rejects(f.service.assertCurrent(actor, first.viewId, use), code('VIEW_INVALIDATED'));
});
