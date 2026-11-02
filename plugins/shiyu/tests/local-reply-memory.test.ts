import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ControlStore } from '../src/adapters/control-store/index.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { installCommitWatermark } from '../src/adapters/control-store/commit-watermark.js';
import { createControlAuthority } from '../src/adapters/control-store/authority.js';
import { MemoryDomain, type LocalMemoryEntry } from '../src/adapters/control-store/memory-domain.js';
import { LocalReplyDomain } from '../src/adapters/control-store/local-reply-domain.js';
import { ViewDomain } from '../src/adapters/control-store/view-domain.js';
import { ConversationStore } from '../src/control/conversations/index.js';
import type { TaskView } from '../src/control/tasks/index.js';
import { LocalReplyService, type LocalReplySessionDriver } from '../src/control/local-reply.js';
import { defaultModel, sessionBindingKey, type ContextLoadRequest, type ContextLoadResult } from '../src/adapters/dsh/sessions.js';
import { memoryBodyDigest, memoryCommandDigest, type MemoryBackendObservation } from '../src/contracts/memory.js';
import { createStatePublisher, initialStateManifest, StatePublicationStore } from '../src/state/publication.js';
import { LocalReadSafetyStore } from '../src/state/safety.js';

const OWNER = { principalId: 'local-owner', kind: 'owner' as const, scopes: ['local-owner'] };
const BODY = 'Synthetic memory source: the copper notebook belongs in drawer eight.';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
// This fixture exercises the actual synchronous shared transaction/domain chain
// and asynchronous ReadView composition. Native maintenance/IO is a double; no
// DSH Session, MCP process, embedding or inference is invoked.
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'), tx = new SqliteTransactions(db), watermark = installCommitWatermark(db, tx);
  const now = () => new Date(), conversations = new ConversationStore(db, tx, { ownerIds: ['local-owner'], componentPermissions: {}, authorizeReference: () => true, now });
  const conversation = conversations.ensureConversation(OWNER, { connectionId: 'local-synthetic', platformConversationId: 'memory-reply', kind: 'direct', scope: 'local-owner' });
  const topic = conversations.createTopic(OWNER, { topicId: 'local-topic', scope: 'local-owner' });
  conversations.linkTopic(OWNER, { conversationId: conversation.conversationId, topicId: topic.topicId, expectedConversationRevision: conversation.revision, expectedTopicRevision: topic.revision });
  conversations.linkReference(OWNER, { topicId: topic.topicId, expectedRevision: conversations.getTopic(OWNER, topic.topicId).revision, reference: { kind: 'task', id: 'synthetic-task' } });
  const initialBinding = conversations.ensureReplyBinding(OWNER, { conversationId: conversation.conversationId });
  const binding = () => conversations.getReplyBinding(OWNER, initialBinding.bindingId);
  const replies = new LocalReplyDomain(db, tx, { conversations, bindingFor: () => binding(), now });
  const memories = new MemoryDomain(db, tx, { runtimeIdentity: { hostEpoch: 'fixture-host', installationGeneration: 'fixture-install' }, backendId: 'fixture-memory', deploymentId: 'fixture-deployment',
    getConversation: id => conversations.getConversation(OWNER, id), now, onWithdrawSources: input => replies.invalidateMemorySources(input) });
  const authority = createControlAuthority(db, tx, { now });
  const safety = new LocalReadSafetyStore(db, tx, { getAuthEpoch: () => authority.health().authEpoch, now });
  const publication = new StatePublicationStore(db, tx, { publisherIds: ['fixture-state'], now });
  const publisher = createStatePublisher('fixture-state');
  publication.publish(publisher, { requestId: 'initial-unavailable', manifest: initialStateManifest() });
  const baseline = publication.get()!;
  publication.publish(publisher, { requestId: 'memory-capability', expectedBaselineId: baseline.baselineId, expectedStateVersion: baseline.stateVersion, manifest: { schemaVersion: 2, domains: { ...initialStateManifest().domains,
    memory: { status: 'available', backendId: 'fixture-memory', deploymentId: 'fixture-deployment', capabilities: ['exact_read'] } } } });
  const views = new ViewDomain(db, tx, { publication, safety, watermark, memory: memories, now,
    context: () => ({ ...conversations.contextSnapshot(OWNER, binding().bindingId), businessId: binding().businessId, ...(binding().sessionId ? { sessionId: binding().sessionId } : {}) }),
    getTask: () => ({ taskId: 'synthetic-task', title: 'Synthetic task metadata', state: 'queued', version: 1, updatedAt: '2026-11-02T00:00:00.000Z', stopRequested: false }) as TaskView });
  replies.setAuthority({ validateCapture: (id, phase) => views.validateReplyCapture(id, { for: phase }), assertMemorySourcesCurrent: sources => memories.validateExposedSources(sources) });
  const store = { async request(command: string, args: never) {
    if (command.startsWith('view.')) return views.execute({ command, args } as never);
    if (command.startsWith('conversation.reply.')) return replies.execute({ command, args } as never);
    throw new Error(`Unexpected fixture command ${command}`);
  } } as unknown as ControlStore;
  const observation = (entry: LocalMemoryEntry): MemoryBackendObservation => ({ command: entry.command, commandDigest: memoryCommandDigest(entry.command), deploymentId: 'fixture-deployment',
    nativeId: `shiyu_${sha(entry.operation.operationId).slice(0, 32)}`, receiptId: `receipt_${sha(entry.operation.operationId)}`,
    componentVersion: `sha256:${sha(BODY)}`, ...memoryBodyDigest(BODY), sourceRefs: entry.command.sourceRefs, observedAt: now().toISOString() });
  const bytes = memoryBodyDigest(BODY), prepared = memories.prepareLocal({ requestId: 'explicit-save', conversationId: conversation.conversationId, bodyDigest: bytes.bodyDigest, bytes: bytes.bodyBytes });
  const plan = memories.claim({ operationId: prepared.operation.operationId })!, observed = observation(prepared);
  const saved = memories.recordVerifiedReceipt({ operationId: prepared.operation.operationId, claim: plan.claim, observation: observed, reconciliation: false });
  let selected = [saved.operation.operationId], reads = 0, generations = 0;
  const requests: ContextLoadRequest[] = [], nativeHistory = new Map<string, string[]>();
  let afterBind: (() => void | Promise<void>) | undefined, beforeRead: (() => void | Promise<void>) | undefined;
  const native: LocalReplySessionDriver = {
    async generateReply() { generations++; throw new Error('No model generation allowed'); },
    async loadContextOnly(request): Promise<ContextLoadResult> {
      requests.push(request);
      const sessionId = request.context.expectedSessionId ?? `shiyu-replyer-${sha(request.businessId).slice(0, 24)}`;
      const bound = { operationId: request.context.operationId, contextTokenId: request.context.contextTokenId, sessionEpoch: request.context.sessionEpoch,
        key: sessionBindingKey('replyer', request.businessId, request.scope), businessId: request.businessId, scope: request.scope, sessionId,
        messageId: `message-${request.context.operationId}`, messageHash: sha(request.prompt) };
      await request.context.authorize({ phase: 'admission', ...bound }); await request.context.onBound(bound); await afterBind?.();
      await request.context.authorize({ phase: 'append', ...bound });
      const history = nativeHistory.get(sessionId) ?? []; history.push(request.prompt); nativeHistory.set(sessionId, history);
      const receipt = { ...bound, userMessageSeq: history.length, confirmedAt: now().toISOString(), durability: 'confirmed' as const };
      await request.context.authorize({ phase: 'context_ack', ...bound }); await request.context.onContextDurable(receipt);
      await request.context.authorize({ phase: 'release', ...bound });
      return { mode: 'load-only', inferenceRequested: false, followupRequested: false, contextReceipt: receipt,
        binding: { key: bound.key, role: 'replyer', businessId: request.businessId, scope: request.scope, sessionId, model: defaultModel('replyer'),
          status: 'released', createdAt: receipt.confirmedAt, updatedAt: receipt.confirmedAt, usage: { status: 'unknown' } } };
    },
  };
  const service = new LocalReplyService({ store, sessions: native, now, assertRuntimeAllowed() {}, memory: {
    async select() { return { operationIds: [...selected] }; },
    async read(source) { reads++; assert.equal(source.operationId, saved.operation.operationId); await beforeRead?.(); return { body: BODY, observation: observed }; },
  } });
  t.after(async () => { await service.close(); db.close(); assert.equal(generations, 0); });
  return { db, tx, watermark, service, memories, saved, replies, binding, requests, nativeHistory,
    get reads() { return reads; }, select(ids: string[]) { selected = ids; }, afterBind(fn: typeof afterBind) { afterBind = fn; }, beforeRead(fn: typeof beforeRead) { beforeRead = fn; },
    load(inputId: string) { return service.load({ conversationId: conversation.conversationId, inputId, text: 'Read the authorized synthetic context.' }); },
    withdraw() { return memories.withdrawLocal({ requestId: 'withdraw-source', operationId: saved.operation.operationId }); } };
}

test('verified memory body reaches load-only native context with pre-append exposure and metadata-only control storage', async t => {
  const f = fixture(t);
  f.afterBind(() => {
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_reply_memory_exposures').get()!.n, 1);
    assert.equal(f.nativeHistory.size, 0);
  });
  const result = await f.load('memory-load');
  assert.equal(result.operation.status, 'loaded'); assert.equal(result.operation.memorySources!.length, 1); assert.equal(f.reads, 1);
  assert.ok(f.requests[0]!.prompt.includes(BODY)); assert.equal(result.view!.data.find(item => item.backendId === 'native-memory')!.fields.text, BODY);
  for (const row of f.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${row.name}`).all()).includes(BODY), false);
  }
  const duplicate = await f.load('memory-load'); assert.equal(duplicate.duplicate, true); assert.equal(f.requests.length, 1); assert.equal(f.reads, 1);
});

test('withdrawal retires the already-loaded Session atomically and fresh context never reuses its retained history', async t => {
  const f = fixture(t), first = await f.load('before-withdraw'), old = f.binding();
  f.select([]); const taskOnly = await f.load('task-only-before-withdraw'); assert.equal(taskOnly.load!.binding.sessionId, old.sessionId);
  const withdrawn = f.withdraw(); assert.equal(withdrawn.contextInvalidation!.retiredSessions[0]!.sessionId, first.load!.binding.sessionId);
  assert.equal(f.binding().sessionEpoch, old.sessionEpoch + 1); assert.notEqual(f.binding().businessId, old.businessId); assert.equal(f.binding().sessionId, undefined);
  assert.ok(f.nativeHistory.get(old.sessionId!)![0]!.includes(BODY), 'Retirement is not physical history deletion');
  f.select([]);
  const next = await f.load('after-withdraw'); assert.equal(next.operation.status, 'loaded');
  assert.notEqual(next.load!.binding.sessionId, first.load!.binding.sessionId);
  assert.equal(f.requests.length, 3); assert.equal(f.requests[2]!.prompt.includes(BODY), false);
  assert.ok(f.nativeHistory.get(next.load!.binding.sessionId)!.every(text => !text.includes(BODY)));
  assert.equal(f.reads, 1);
});

test('withdrawal after bind but before append fences the uncertain native exposure and releases no loaded result', async t => {
  const f = fixture(t), old = f.binding(); f.afterBind(() => { f.withdraw(); });
  await assert.rejects(f.load('race-withdraw'));
  assert.equal(f.nativeHistory.size, 0); assert.equal(f.binding().sessionEpoch, old.sessionEpoch + 1);
  const row = f.db.prepare('SELECT record_json FROM shiyu_local_reply_inputs').get()!;
  const operation = JSON.parse(String(row.record_json)); assert.equal(operation.status, 'unknown'); assert.equal(operation.durability, 'unconfirmed');
});

test('withdrawal during the independent native body read prevents any native dispatch or exposure', async t => {
  const f = fixture(t); f.beforeRead(() => { f.withdraw(); });
  await assert.rejects(f.load('race-read'));
  assert.equal(f.requests.length, 0); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM shiyu_local_reply_memory_exposures').get()!.n, 0);
  assert.equal(f.binding().sessionEpoch, 1);
});
