/**
 * H1 business-path cases for context-safe replyer generation on top of long
 * native history (03 §5 row 8; task-3 A5):
 * - the exact current native message + flush + independent durable readback is
 *   required before the context receipt;
 * - generation continues under its explicit budget (one bounded primary stream,
 *   observed usage) and reuses the same native Session;
 * - a foreign user/message or inbox input arriving across an authorization or
 *   onBound await must not produce a receipt or a delivered draft.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPLYER_PRESET_ID, ShiyuSessionAdapter, defaultModel, sessionBindingKey,
  type ReplyAuthorizationCheck, type ReplyResult, type SessionBinding, type SessionBindingPort,
} from '../../src/adapters/dsh/sessions.js';
import { FakeHost } from './support/host.js';
import { buildHistory, userMessage, type NativeWorld } from './support/world.js';
import { foldNativeInbox, independentHash } from './support/independent.js';
import { cold } from './support/harness.js';
import { loadColdSeam } from './support/seam.js';
import { verifyCase } from './support/evidence.js';

class MemoryBindings implements SessionBindingPort {
  rows: SessionBinding[] = [];
  async load() { return structuredClone(this.rows); }
  async save(rows: SessionBinding[]) { this.rows = structuredClone(rows); }
}

function bindingFor(businessId: string, scope: string, sessionId: string): SessionBinding {
  return {
    key: sessionBindingKey('replyer', businessId, scope), role: 'replyer', businessId, scope, sessionId,
    model: defaultModel('replyer'), status: 'released', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), usage: { status: 'unknown' },
  };
}

interface ReplyHarness {
  host: FakeHost;
  bindings: MemoryBindings;
  adapter: ShiyuSessionAdapter;
  phases: string[];
  receipts: any[];
  bound: any[];
  authorizeHook: (check: ReplyAuthorizationCheck) => any;
  onBoundHook: (binding: any) => any;
  requestHooks: any;
  businessId: string;
  scope: string;
  setSessionId: (id: string) => void;
  world: () => NativeWorld;
}

function makeHarness(options: { sessionId?: string; history?: ReturnType<typeof buildHistory>; generation?: any } = {}): ReplyHarness {
  const businessId = 'verify-reply-business', scope = 'verify-reply-scope';
  const host = new FakeHost({ cwd: '/synthetic/verify/workspace', generation: options.generation });
  const bindings = new MemoryBindings();
  let sessionId = options.sessionId;
  if (sessionId) {
    host.ensureWorld(sessionId, { agentPreset: REPLYER_PRESET_ID, cwd: host.cwd, version: 4, createdAt: 1_700_000_000_000, isSeeded: false }, options.history?.events ?? []);
    bindings.rows = [bindingFor(businessId, scope, sessionId)];
  }
  const adapter = new ShiyuSessionAdapter({ ctx: host.ctx as any, bindings, cwd: host.cwd, createUserMessage: host.messageFactory, isAgentLoopRequest: () => true });
  const phases: string[] = [], receipts: any[] = [], bound: any[] = [];
  const world = (): NativeWorld => {
    const current = sessionId ?? bindings.rows[0]?.sessionId ?? [...host.worlds.keys()][0];
    return host.world(current!)!;
  };
  const harness = {
    host, bindings, adapter, phases, receipts, bound, businessId, scope,
    authorizeHook: async (check: ReplyAuthorizationCheck) => { phases.push(check.phase); },
    onBoundHook: async (binding: any) => { bound.push(binding); },
    world,
    setSessionId: (id: string) => { sessionId = id; },
  } as unknown as ReplyHarness;
  harness.requestHooks = {
    onBound: (binding: any) => harness.onBoundHook(binding),
    authorize: (check: ReplyAuthorizationCheck) => harness.authorizeHook(check),
    onContextDurable: async (receipt: any) => { receipts.push(receipt); },
  };
  return harness;
}

async function contextReply(harness: ReplyHarness, overrides: Record<string, unknown> = {}): Promise<{ result?: ReplyResult; error?: unknown }> {
  try {
    const result = await harness.adapter.generateReply({
      businessId: harness.businessId, scope: harness.scope,
      prompt: String(overrides.prompt ?? 'generate this exact synthetic reply'),
      deadlineMs: Number(overrides.deadlineMs ?? Date.now() + 60_000),
      maxTokens: Number(overrides.maxTokens ?? 512),
      ...(overrides.signal ? { signal: overrides.signal as AbortSignal } : {}),
      context: {
        operationId: 'verify-reply-op', contextTokenId: 'verify-reply-token', sessionEpoch: 1,
        ...harness.requestHooks, ...(overrides.context as any ?? {}),
      },
    } as any);
    return { result };
  } catch (error) { return { error }; }
}

test('RP01 fresh context reply: exact current message + flush + readback precede the receipt, generation continues', async () => {
  const c = verifyCase({ id: 'RP01', title: 'fresh replyer generation receipt', spec: ['03 §5 row8', '03 §4.3', '6.2'], expectation: 'one exact owner message durably loaded, one bounded primary stream under maxTokens, observed usage, complete accounting' });
  const h = makeHarness({ generation: { text: 'synthetic reply body', usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 } } });
  const { result, error } = await contextReply(h);
  if (error) { c.fail(`fresh context reply failed: ${String((error as Error)?.message ?? error)}`); assert.fail(String((error as Error)?.stack ?? error)); }
  const reply = result as ReplyResult;
  const world = h.world();
  const receipt = reply.contextReceipt!;
  const problems: string[] = [];
  if (h.receipts.length !== 1) problems.push(`onContextDurable calls=${h.receipts.length}`);
  if (receipt?.durability !== 'confirmed') problems.push('receipt not confirmed');
  const inputEvent = world.events[receipt?.userMessageSeq];
  if (inputEvent?.type !== 'user/message' || inputEvent.data?.id !== receipt.messageId) problems.push('receipt does not point at the exact native user message');
  if (inputEvent?.data?.content?.[0]?.text !== 'generate this exact synthetic reply') problems.push('loaded user message text mismatch');
  if (reply.text !== 'synthetic reply body') problems.push(`draft text="${reply.text}"`);
  if (!Number.isSafeInteger(reply.assistantRef?.eventSeq)) problems.push('assistant ref missing');
  const assistantEvent = world.events[reply.assistantRef!.eventSeq];
  if (assistantEvent?.type !== 'assistant/message' || assistantEvent.data?.message?.id !== reply.assistantRef?.messageId) problems.push('assistant ref does not point at the persisted assistant event');
  if (statusOf(reply) !== 'idle') problems.push(`binding status=${statusOf(reply)}`);
  if (reply.usage?.status !== 'reported' || reply.usage?.totalTokens !== 38) problems.push(`usage=${JSON.stringify(reply.usage)}`);
  if (!reply.accounting || reply.accounting.complete !== true || reply.accounting.calls !== 1 || reply.accounting.tokens !== 38) problems.push(`accounting=${JSON.stringify(reply.accounting)}`);
  const agent = h.host.agents.at(-1)!;
  if (agent.modelCalls !== 1) problems.push(`model calls=${agent.modelCalls}`);
  if (agent.followupCalls !== 1) problems.push(`followup calls=${agent.followupCalls}`);
  if (h.phases.at(-1) !== 'release') problems.push(`authorize phases=${h.phases.join(',')}`);
  for (const phase of ['admission', 'pre_step', 'context_ack', 'release']) if (!h.phases.includes(phase)) problems.push(`missing phase ${phase}`);
  if (h.host.live.size !== 1) problems.push('the reusable managed Session was released instead of kept live');
  if (problems.length) { c.fail(`replyer receipt/generation mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`receipt seq=${receipt.userMessageSeq}, draft+assistant ref durable, 1 model call, usage reported, accounting complete`);
});

function statusOf(reply: ReplyResult): string { return (reply.binding as any)?.status; }

test('RP02 long resumed history: same Session, prefix preserved, generation continues', async () => {
  const c = verifyCase({ id: 'RP02', title: 'long history replyer resume', spec: ['03 §4.2', '03 §5 row8', '6.6'], expectation: '2500 persisted events are preserved; resume suffix + fixed title are bound; the exact new message and one generation extend the same Session' });
  const history = buildHistory({ length: 2500, inbox: [] });
  const sessionId = 'shiyu-replyer-verify-reply-long-1';
  const h = makeHarness({ sessionId, history, generation: { text: 'long-history reply', usage: { totalTokens: 44, inputTokens: 37, outputTokens: 7 } } });
  const { result, error } = await contextReply(h, { prompt: 'long history generation prompt', maxTokens: 512 });
  if (error) { c.fail(`long-history reply failed: ${String((error as Error)?.message ?? error)}`); assert.fail(String((error as Error)?.stack ?? error)); }
  const reply = result as ReplyResult;
  const world = h.world();
  const problems: string[] = [];
  if (reply.binding.sessionId !== sessionId) problems.push('business Session identity changed');
  if (h.host.createdSessions !== 0 || h.host.resumedSessions !== 1) problems.push(`created=${h.host.createdSessions} resumed=${h.host.resumedSessions}`);
  if (JSON.stringify(world.events.slice(0, history.events.length)) !== JSON.stringify(history.events)) problems.push('persisted prefix not preserved');
  const suffix = world.events.slice(history.events.length).map(event => event.type);
  if (suffix[0] !== 'session/end-seed') problems.push(`first suffix event=${suffix[0]}`);
  if (!suffix.includes('session/title')) problems.push('fixed title append missing from the resumed history');
  const receipt = reply.contextReceipt!;
  const input = world.events[receipt.userMessageSeq];
  if (input?.type !== 'user/message' || input.data?.id !== receipt.messageId) problems.push('receipt is not the exact new native message');
  if (reply.text !== 'long-history reply') problems.push('draft text mismatch');
  if (h.host.agents.at(-1)!.modelCalls !== 1) problems.push('expected exactly one primary model call');
  if (problems.length) { c.fail(`long-history reply mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`same Session ${sessionId}: ${history.events.length} prefix events + suffix ${JSON.stringify(suffix)}, receipt seq=${receipt.userMessageSeq}, one call`);
});

test('RP03 foreign user/message appended during authorize(pre_step) cannot produce a draft', async () => {
  const c = verifyCase({ id: 'RP03', title: 'foreign input during authorize(pre_step)', spec: ['03 §4.3', '03 §5 row5', '6.2'], expectation: 'an unregistered native user input arriving during an authorization await blocks the stream/draft; no context receipt' });
  const history = buildHistory({ length: 300 });
  const sessionId = 'shiyu-replyer-verify-reply-foreign-1';
  const h = makeHarness({ sessionId, history });
  let injected = false;
  h.authorizeHook = async (check: ReplyAuthorizationCheck) => {
    h.phases.push(check.phase);
    if (check.phase === 'pre_step' && !injected && check.sessionId) {
      injected = true;
      await Promise.resolve();
      // Another component writes through the same live native Session object
      // while the authorization await is open (not a second backend writer).
      const agent = h.host.live.get(check.sessionId)!;
      agent.session.append('user/message', { id: 'foreign-pre-step-user', role: 'user', content: [{ type: 'text', text: 'FOREIGN-PRE-STEP-CANARY' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    }
  };
  const { result, error } = await contextReply(h);
  await h.adapter.close().catch(() => {});
  const problems: string[] = [];
  if (!injected) problems.push('injection did not run');
  if (error === undefined) problems.push('foreign native input still produced a reply');
  if (result !== undefined) problems.push('a reply result escaped');
  if (h.receipts.length !== 0) problems.push(`onContextDurable called ${h.receipts.length} times`);
  const world = h.world();
  if (!world.events.some(event => event.type === 'user/message' && event.data?.id === 'foreign-pre-step-user')) problems.push('foreign event was removed rather than preserved');
  if (problems.length) { c.fail(`foreign pre-step handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`reply refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; foreign event preserved; no receipt/draft`);
});

test('RP04 foreign pending inbox inserted during onBound cannot produce a receipt', async () => {
  const c = verifyCase({ id: 'RP04', title: 'foreign inbox during onBound', spec: ['03 §4.3', '03 §5 row4/row5'], expectation: 'an unregistered pending inbox input inserted while the binding callback awaits blocks loading/acknowledgement' });
  const history = buildHistory({ length: 200 });
  const sessionId = 'shiyu-replyer-verify-reply-foreign-2';
  const h = makeHarness({ sessionId, history });
  let injected = false;
  h.onBoundHook = async (binding: any) => {
    h.bound.push(binding);
    if (!injected) {
      injected = true;
      const agent = h.host.live.get(binding.sessionId)!;
      agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [userMessage('FOREIGN-ONBOUND-INBOX-CANARY', 'foreign-onbound-inbox')] });
    }
  };
  const { result, error } = await contextReply(h);
  await h.adapter.close().catch(() => {});
  const problems: string[] = [];
  if (!injected) problems.push('injection did not run');
  if (error === undefined) problems.push('foreign inbox input still produced a reply');
  if (result !== undefined) problems.push('a reply result escaped');
  if (h.receipts.length !== 0) problems.push(`onContextDurable called ${h.receipts.length} times`);
  if (problems.length) { c.fail(`foreign onBound inbox handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`reply refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; no receipt or draft`);
});

test('RP05 bounded request parameters and single stream are observable', async () => {
  const c = verifyCase({ id: 'RP05', title: 'bounded generation', spec: ['03 §5 row8', 'NATIVE_SEAMS modelCalls'], expectation: 'maxTokens from the operation reaches the single native stream; no title/compaction model calls are counted' });
  const h = makeHarness({ generation: { text: 'bounded reply', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } } });
  const { result, error } = await contextReply(h, { maxTokens: 256 });
  if (error) { c.fail(`bounded reply failed: ${String((error as Error)?.message ?? error)}`); assert.fail('bounded reply failed'); }
  const reply = result as ReplyResult;
  const problems: string[] = [];
  if (reply.accounting?.complete !== true || reply.accounting.calls !== 1) problems.push(`accounting=${JSON.stringify(reply.accounting)}`);
  if (reply.usage?.totalTokens !== 13) problems.push(`usage=${JSON.stringify(reply.usage)}`);
  if (h.host.agents.at(-1)!.modelCalls !== 1) problems.push('more than one primary model call');
  // No session/title-llm-request or compaction events may appear in the managed Session.
  const world = h.world();
  const sideEvents = world.events.filter(event => event.type === 'session/title-llm-request' || event.type.startsWith('compaction/'));
  if (sideEvents.length) problems.push(`side inference events=${sideEvents.map(event => event.type).join(',')}`);
  if (problems.length) { c.fail(`bounded generation mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass('one bounded primary stream, reported usage, no title/compaction inference events');
});

test('RP06 two consecutive replies reuse one Session and keep both exact messages', async () => {
  const c = verifyCase({ id: 'RP06', title: 'same Session reply reuse', spec: ['03 §5 row1/row8', '6.6'], expectation: 'normal input reuses the native Session (no new Session), the first message/assistant remain history, and the second receipt/assistant are exact' });
  const h = makeHarness({ generation: { text: 'first reply' } });
  const first = await contextReply(h, { prompt: 'first business prompt' });
  if (first.error) { c.fail(`first reply failed: ${String((first.error as Error)?.message ?? first.error)}`); assert.fail('first reply failed'); }
  h.host.generationPlan.text = 'second reply';
  const second = await contextReply(h, { prompt: 'second business prompt' });
  if (second.error) { c.fail(`second reply failed: ${String((second.error as Error)?.message ?? second.error)}`); assert.fail('second reply failed'); }
  const world = h.world();
  const problems: string[] = [];
  if (h.host.createdSessions !== 1) problems.push(`created Sessions=${h.host.createdSessions}`);
  if (h.host.resumedSessions !== 0) problems.push(`unexpected resume count=${h.host.resumedSessions} (a live managed Session should be reused)`);
  if ((first.result as ReplyResult).binding.sessionId !== (second.result as ReplyResult).binding.sessionId) problems.push('Session id changed between replies');
  const texts = world.events.filter(event => event.type === 'user/message').map(event => event.data.content[0].text);
  if (!texts.includes('first business prompt') || !texts.includes('second business prompt')) problems.push(`user texts=${JSON.stringify(texts)}`);
  if ((second.result as ReplyResult).contextReceipt!.userMessageSeq !== world.events.filter(event => event.type === 'user/message').at(-1)!.seq) problems.push('second receipt is not the last user message');
  const assistantTexts = world.events.filter(event => event.type === 'assistant/message').map(event => event.data.message.content[0].text);
  if (assistantTexts.length !== 2) problems.push(`assistant events=${assistantTexts.length}`);
  if (problems.length) { c.fail(`same-Session reply reuse mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`one created + one resumed Session, both exact messages and assistant drafts retained`);
});

test('RP09 a stale-inbox declaration with a wrong hash cannot remove an unknown input', async () => {
  const c = verifyCase({ id: 'RP09', title: 'stale inbox hash mismatch', spec: ['03 §4.3', 'NATIVE_SEAMS exact removal'], expectation: 'only a controller declaration whose exact id+hash matches the durable input may remove it; a wrong hash blocks the reply and preserves the input' });
  const history = buildHistory({ length: 120 });
  const sessionId = 'shiyu-replyer-verify-reply-stale-02';
  const h = makeHarness({ sessionId, history });
  const pending = userMessage('wrong-hash pending input', 'wrong-hash-pending');
  h.world().append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [pending] });
  const { result, error } = await contextReply(h, { context: { staleInbox: [{ messageId: pending.id, messageHash: 'ab'.repeat(32) }] } });
  await h.adapter.close().catch(() => {});
  const problems: string[] = [];
  if (error === undefined) problems.push('a wrong-hash stale declaration still allowed the reply');
  if (result !== undefined) problems.push('a reply result escaped');
  if (h.receipts.length !== 0) problems.push('onContextDurable was called');
  const fold = foldNativeInbox(h.world().events);
  if (fold.nextTurn.length !== 1 || fold.nextTurn[0]!.id !== pending.id) problems.push('the unknown pending input was removed');
  if (problems.length) { c.fail(`wrong-hash stale declaration handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`reply refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; pending input preserved`);
});

test('RP08 declared obsolete pending input is removed precisely and bound into the new baseline', async () => {
  const c = verifyCase({ id: 'RP08', title: 'known stale inbox removal', spec: ['03 §4.3', '03 §5 row4', 'NATIVE_SEAMS exact removal'], expectation: 'a controller-declared obsolete pending input is removed by its exact id/hash, the removal events are re-read into the baseline, and the reply proceeds with an empty inbox' });
  const history = buildHistory({ length: 400 });
  const sessionId = 'shiyu-replyer-verify-reply-stale-01';
  const h = makeHarness({ sessionId, history, generation: { text: 'reply after stale removal' } });
  const staleMessage = userMessage('declared obsolete pending input', 'declared-obsolete-pending');
  h.world().append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [staleMessage] });
  // Read the exact durable reference through the public seam (fixture setup only).
  const seam = await loadColdSeam();
  const before = await cold(seam, h.host.world(sessionId)!);
  if (before.error !== undefined) { c.fail(`pre-reply baseline read failed: ${String((before.error as Error)?.message ?? before.error)}`); assert.fail('baseline read failed'); }
  const references = (before.result as any).references ?? [];
  const stale = references.find((reference: any) => reference.messageId === staleMessage.id);
  if (!stale) { c.fail('the pending input was not projected by the official reader before removal'); assert.fail('pending input missing'); }
  const { result, error } = await contextReply(h, { context: { staleInbox: [{ messageId: stale.messageId, messageHash: stale.messageHash }] } });
  if (error) { c.fail(`reply after declared stale removal failed: ${String((error as Error)?.message ?? error)}`); assert.fail(String((error as Error)?.stack ?? error)); }
  const reply = result as ReplyResult;
  const world = h.world();
  const problems: string[] = [];
  const removals = world.events.filter(event => event.type === 'agent/inbox/spliced' && event.data?.removedCount === 1 && Array.isArray(event.data?.inserted) && event.data.inserted.length === 0 && event.data?.outcome === 'canceled');
  if (removals.length !== 1) problems.push(`precise removal events=${removals.length}`);
  if (removals[0]?.data?.outcome !== 'canceled') problems.push(`removal outcome=${removals[0]?.data?.outcome}`);
  if (foldInbox(world.events).nextTurn.length || foldInbox(world.events).nextStep.length) problems.push('inbox not empty after declared removal');
  const receipt = reply.contextReceipt!;
  const input = world.events[receipt.userMessageSeq];
  if (input?.type !== 'user/message' || input.data?.id !== receipt.messageId) problems.push('receipt is not the exact new native message');
  if (world.events.findIndex(event => event.data?.id === staleMessage.id) >= 0) problems.push('obsolete pending message resurrected as a stored user message');
  if (reply.text !== 'reply after stale removal') problems.push('generation did not proceed after the declared removal');
  if (problems.length) { c.fail(`declared stale removal mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`one exact removal (seq=${removals[0]!.seq}) bound into the baseline; inbox empty; reply receipt seq=${receipt.userMessageSeq}`);
});

function foldInbox(events: any[]): { nextTurn: any[]; nextStep: any[] } { return foldNativeInbox(events); }

test('RP10 a fresh adapter instance resumes the persisted replyer Session and generates again', async () => {
  const c = verifyCase({ id: 'RP10', title: 'replyer adapter restart', spec: ['03 §5 row1/row8'], expectation: 'a new adapter instance + persisted binding resumes the same native Session, preserves history and produces a second exact receipt with one bounded generation' });
  const h = makeHarness({ generation: { text: 'first restart reply' } });
  const first = await contextReply(h, { prompt: 'first restart prompt' });
  if (first.error) { c.fail(`first reply failed: ${String((first.error as Error)?.message ?? first.error)}`); assert.fail('first reply failed'); }
  const sessionId = (first.result as ReplyResult).binding.sessionId;
  await h.adapter.close().catch(() => {});
  const world = h.world();
  const before = structuredClone(world.events);
  const adapter = new ShiyuSessionAdapter({ ctx: h.host.ctx as any, bindings: h.bindings, cwd: h.host.cwd, createUserMessage: h.host.messageFactory, isAgentLoopRequest: () => true });
  await adapter.initialize();
  const receipts: any[] = [];
  let result: ReplyResult | undefined, error: unknown;
  try {
    result = await adapter.generateReply({
      businessId: h.businessId, scope: h.scope, prompt: 'second restart prompt', deadlineMs: Date.now() + 60_000, maxTokens: 512,
      context: {
        operationId: 'verify-reply-restart', contextTokenId: 'verify-reply-restart-token', sessionEpoch: 2,
        onBound: async () => {}, authorize: async () => {}, onContextDurable: async (receipt: any) => { receipts.push(receipt); },
      },
    } as any);
  } catch (failure) { error = failure; }
  const problems: string[] = [];
  if (error) problems.push(`restarted reply failed: ${String((error as Error)?.message ?? error)}`);
  if (receipts.length !== 1) problems.push(`receipts=${receipts.length}`);
  if (result?.binding.sessionId !== sessionId) problems.push('Session identity changed across restart');
  if (h.host.createdSessions !== 1) problems.push(`created Sessions=${h.host.createdSessions}`);
  if (h.host.resumedSessions !== 1) problems.push(`resumed Sessions=${h.host.resumedSessions}`);
  if (JSON.stringify(world.events.slice(0, before.length)) !== JSON.stringify(before)) problems.push('pre-restart prefix changed');
  if (h.host.agents.at(-1)!.modelCalls !== 1) problems.push('restart generation did not run exactly once');
  await adapter.close().catch(() => {});
  if (problems.length) { c.fail(`replyer restart mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`restarted adapter resumed ${sessionId}, preserved ${before.length} durable events and generated one bounded reply`);
});

test('RP07 pending inbox blocks context-safe generation before any model call', async () => {
  const c = verifyCase({ id: 'RP07', title: 'pending inbox blocks generation', spec: ['03 §4.1', '6.2'], expectation: 'unknown pending input blocks the reply before any model call; no receipt' });
  const history = buildHistory({ length: 150 });
  const sessionId = 'shiyu-replyer-verify-reply-inbox-01';
  const h = makeHarness({ sessionId, history });
  h.world().append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [userMessage('blocking pending input', 'blocking-pending')] });
  const { result, error } = await contextReply(h);
  await h.adapter.close().catch(() => {});
  const problems: string[] = [];
  if (error === undefined) problems.push('pending inbox did not block the reply');
  if (result !== undefined) problems.push('a reply result escaped');
  if (h.receipts.length !== 0) problems.push('onContextDurable was called');
  if (h.host.agents.some(agent => agent.modelCalls > 0)) problems.push('model was called despite blocking inbox');
  if (problems.length) { c.fail(`pending-inbox reply handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`reply refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; zero model calls`);
});
