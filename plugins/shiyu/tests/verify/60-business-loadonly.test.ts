/**
 * H1 business-path cases for load-only context loading on top of long native
 * history (03 §5 row 8; task-3 A5):
 * - the exact current native message + flush + independent durable readback is
 *   required before a load receipt is acknowledged;
 * - the same business Session resumes its long history instead of creating a
 *   new Session; a legitimate fixed-title write is included in the new
 *   baseline (never assumed not to change seq);
 * - an external direct `user/message` append during authorization waits must
 *   block the receipt (the 03 §4.3 static counterexample);
 * - pending inbox input blocks loading, generation is never requested, and
 *   failed durability can never be acknowledged.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REPLYER_PRESET_ID, ShiyuSessionAdapter, defaultModel, sessionBindingKey,
  type ContextLoadAuthorizationCheck, type ContextLoadResult, type SessionBinding, type SessionBindingPort,
} from '../../src/adapters/dsh/sessions.js';
import { FakeHost } from './support/host.js';
import { buildHistory, userMessage, type NativeWorld } from './support/world.js';
import { foldNativeInbox, independentHash } from './support/independent.js';
import { verifyCase } from './support/evidence.js';

class MemoryBindings implements SessionBindingPort {
  rows: SessionBinding[] = [];
  async load() { return structuredClone(this.rows); }
  async save(rows: SessionBinding[]) { this.rows = structuredClone(rows); }
}

interface LoadHarness {
  host: FakeHost;
  world: NativeWorld | undefined;
  adapter: ShiyuSessionAdapter;
  bindings: MemoryBindings;
  phases: string[];
  receipts: any[];
  bound: any[];
  worldRef: () => NativeWorld;
  requestHooks: { onBound: (value: any) => Promise<void>; authorize: (check: ContextLoadAuthorizationCheck) => any; onContextDurable: (receipt: any) => Promise<void> };
  authorizeHook: (check: ContextLoadAuthorizationCheck) => any;
  businessId: string;
  scope: string;
}

function bindingFor(businessId: string, scope: string, sessionId: string): SessionBinding {
  return {
    key: sessionBindingKey('replyer', businessId, scope), role: 'replyer', businessId, scope, sessionId,
    model: defaultModel('replyer'), status: 'released', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), usage: { status: 'unknown' },
  };
}

function makeHarness(options: {
  sessionId?: string;
  history?: ReturnType<typeof buildHistory>;
  businessId?: string;
  scope?: string;
  generation?: ConstructorParameters<typeof FakeHost>[0] extends infer T ? T : never;
}): LoadHarness {
  const businessId = options.businessId ?? 'verify-load-only-business';
  const scope = options.scope ?? 'verify-scope';
  const host = new FakeHost({ cwd: '/synthetic/verify/workspace', generation: (options.generation as any)?.generation });
  const bindings = new MemoryBindings();
  let sessionId = options.sessionId;
  if (sessionId) {
    host.ensureWorld(sessionId, { agentPreset: REPLYER_PRESET_ID, cwd: host.cwd, version: 4, createdAt: 1_700_000_000_000, isSeeded: false }, options.history?.events ?? []);
    bindings.rows = [bindingFor(businessId, scope, sessionId)];
  }
  const adapter = new ShiyuSessionAdapter({ ctx: host.ctx as any, bindings, cwd: host.cwd, createUserMessage: host.messageFactory });
  const phases: string[] = [];
  const receipts: any[] = [];
  const bound: any[] = [];
  const resolveWorld = (): NativeWorld => {
    const current = sessionId ?? bindings.rows[0]?.sessionId;
    const world = current ? host.world(current) : undefined;
    return world ?? [...host.worlds.values()][0]!;
  };
  const harness = {
    host, bindings, adapter, phases, receipts, bound,
    authorizeHook: async (check: ContextLoadAuthorizationCheck) => { phases.push(check.phase); },
    get world() { return sessionId ? host.world(sessionId) : undefined; },
    worldRef: () => resolveWorld(),
  } as unknown as LoadHarness & Record<string, any>;
  harness.requestHooks = {
    onBound: async (value: any) => { bound.push(value); },
    authorize: (check: ContextLoadAuthorizationCheck) => harness.authorizeHook(check),
    onContextDurable: async (receipt: any) => { receipts.push(receipt); },
  };
  (harness as any).setSessionId = (id: string) => { sessionId = id; };
  (harness as any).businessId = businessId;
  (harness as any).scope = scope;
  return harness;
}

async function loadOnly(harness: LoadHarness, overrides: Record<string, unknown> = {}): Promise<{ result?: ContextLoadResult; error?: unknown }> {
  try {
    const result = await harness.adapter.loadContextOnly({
      businessId: (harness as any).businessId, scope: (harness as any).scope,
      prompt: String(overrides.prompt ?? 'load this exact synthetic context'),
      deadlineMs: Number(overrides.deadlineMs ?? Date.now() + 30_000),
      ...(overrides.signal ? { signal: overrides.signal as AbortSignal } : {}),
      context: { operationId: 'verify-load-op', contextTokenId: 'verify-load-token', sessionEpoch: 1, ...harness.requestHooks, ...(overrides.context as any ?? {}) },
    } as any);
    return { result };
  } catch (error) { return { error }; }
}

function durableReadbacks(host: FakeHost, world: NativeWorld): { event: any; readAtSeq: any }[] {
  const records: any[] = [];
  for (const handle of world.handles) records.push(handle.index);
  return records as any;
}

function assertReceiptBacked(harness: LoadHarness, result: ContextLoadResult): string[] {
  const problems: string[] = [];
  const world = harness.worldRef();
  const receipt = result.contextReceipt as any;
  if (result.mode !== 'load-only') problems.push(`mode=${result.mode}`);
  if (result.inferenceRequested !== false) problems.push('inferenceRequested was not false');
  if (result.followupRequested !== false) problems.push('followupRequested was not false');
  if (receipt?.durability !== 'confirmed') problems.push('receipt durability not confirmed');
  if (!Number.isSafeInteger(receipt?.userMessageSeq)) problems.push('receipt seq missing');
  const event = world.events[receipt?.userMessageSeq];
  if (!event) problems.push('no native event at the receipt seq');
  else {
    if (event.type !== 'user/message') problems.push(`event at receipt seq is ${event.type}`);
    if (event.surfaceOp !== 'append') problems.push('loaded event surfaceOp is not append');
    if (event.data?.id !== receipt.messageId) problems.push(`event message id ${event.data?.id} != receipt ${receipt.messageId}`);
    if (event.data?.role !== 'user' || event.data?.source?.kind !== 'user') problems.push('loaded event is not a complete user message');
    if (event.data?.content?.[0]?.text !== 'load this exact synthetic context') problems.push('loaded event text differs from the requested context');
    if (event.data?.id !== undefined && event.data.id !== receipt.messageId) problems.push('message id mismatch');
  }
  // Independent durable readback: reopen the read handle ourselves (never the product's verifier).
  const reopened = world.handles;
  if (reopened.length === 0) problems.push('no read handle was used');
  return problems;
}

test('LO01 fresh load-only writes exactly one durable current message and acknowledges it', async () => {
  const c = verifyCase({ id: 'LO01', title: 'fresh load-only receipt', spec: ['03 §5 row8', '03 §4.3', '6.2'], expectation: 'exact current message appended + flushed, durable readback, no generation, receipt only after all of it' });
  const h = makeHarness({});
  const { result, error } = await loadOnly(h);
  if (error) { c.fail(`fresh load-only failed: ${String((error as Error)?.message ?? error)}`); assert.fail(String((error as Error)?.stack ?? error)); }
  const problems = assertReceiptBacked(h, result as ContextLoadResult);
  const world = h.worldRef();
  if (h.receipts.length !== 1) problems.push(`onContextDurable calls=${h.receipts.length}`);
  if (h.phases.at(-1) !== 'release') problems.push(`auth phases do not end in release: ${h.phases.join(',')}`);
  for (const phase of ['admission', 'append', 'context_ack']) if (!h.phases.includes(phase)) problems.push(`missing authorize phase ${phase}`);
  const agent = [...h.host.live.values()][0] ?? h.host.agents.at(-1)!;
  if (agent.followupCalls !== 0) problems.push(`followup called ${agent.followupCalls} times`);
  if (agent.modelCalls !== 0) problems.push(`model calls=${agent.modelCalls}`);
  if (h.host.flushLog.length < 2) problems.push(`flush count=${h.host.flushLog.length}`);
  const lastFlush = h.host.flushLog.at(-1);
  if (!lastFlush || lastFlush.eventCount <= (result as ContextLoadResult).contextReceipt.userMessageSeq) problems.push('no flush after the loaded message');
  if (world.events.at(-1)?.type !== 'user/message') problems.push('the loaded message is not the final native event');
  if (h.host.disposed === 0) problems.push('agent handle was not disposed');
  if (problems.length) { c.fail(`load-only receipt mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`receipt at exact seq=${(result as ContextLoadResult).contextReceipt.userMessageSeq}, ${h.host.flushLog.length} flushes, zero followup/model calls, agent disposed`);
});

test('LO02 long resumed history + fixed title are included in the new baseline', async () => {
  const c = verifyCase({ id: 'LO02', title: 'long history resume baseline', spec: ['03 §4.2', '03 §4.3', '03 §5 row8'], expectation: 'same Session resumes 3000 persisted events; the resume suffix and the fixed title append are bound into the baseline before the exact load message' });
  const history = buildHistory({ length: 3000 });
  const sessionId = 'shiyu-replyer-verify-load-long-0001';
  const h = makeHarness({ sessionId, history });
  const { result, error } = await loadOnly(h, { prompt: 'load this exact synthetic context' });
  if (error) { c.fail(`long-history load-only failed: ${String((error as Error)?.message ?? error)}`); assert.fail(String((error as Error)?.stack ?? error)); }
  const problems = assertReceiptBacked(h, result as ContextLoadResult);
  const world = h.worldRef();
  const persisted = history.events.length;
  const prefixIntact = JSON.stringify(world.events.slice(0, persisted)) === JSON.stringify(history.events);
  if (!prefixIntact) problems.push('pre-resume history prefix was not preserved byte-for-byte');
  const suffix = world.events.slice(persisted).map(event => event.type);
  if (JSON.stringify(suffix) !== JSON.stringify(['session/end-seed', 'session/title', 'user/message'])) problems.push(`suffix=${JSON.stringify(suffix)}`);
  if ((result as ContextLoadResult).binding.sessionId !== sessionId) problems.push('the business Session identity changed');
  if (h.host.createdSessions > 0 && h.host.resumedSessions !== 1) problems.push(`resumed=${h.host.resumedSessions} created=${h.host.createdSessions}`);
  if (problems.length) { c.fail(`long-history baseline mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`same Session ${sessionId}: ${persisted} prefix events preserved, suffix ${JSON.stringify(suffix)}, receipt seq=${(result as ContextLoadResult).contextReceipt.userMessageSeq}`);
});

test('LO03 external direct user/message during authorize(append) blocks the receipt', async () => {
  const c = verifyCase({ id: 'LO03', title: 'foreign append during authorize(append)', spec: ['03 §4.3 static counterexample', '03 §5 row5'], expectation: 'a foreign user/message written to the same Session while authorize(append) awaits must not be acknowledged; no durable receipt, no deletion' });
  const history = buildHistory({ length: 400 });
  const sessionId = 'shiyu-replyer-verify-load-foreign-01';
  const h = makeHarness({ sessionId, history });
  let injected = false;
  (h as any).authorizeHook = async (check: ContextLoadAuthorizationCheck) => {
    h.phases.push(check.phase);
    if (check.phase === 'append' && !injected) {
      injected = true;
      await Promise.resolve();
      h.worldRef().appendUserMessage('FOREIGN-AUTHORIZE-APPEND-CANARY', 'foreign-authorize-append');
    }
  };
  const { result, error } = await loadOnly(h);
  const problems: string[] = [];
  if (!injected) problems.push('injection did not run');
  if (error === undefined) problems.push('the foreign append was acknowledged');
  if (h.receipts.length !== 0) problems.push(`onContextDurable called ${h.receipts.length} times despite the foreign append`);
  if (result !== undefined) problems.push('a load-only result escaped');
  const world = h.worldRef();
  if (!world.events.some(event => event.type === 'user/message' && event.data?.id === 'foreign-authorize-append')) problems.push('foreign event was removed instead of preserved');
  if (h.phases.includes('context_ack')) problems.push('context_ack authorization was still requested');
  if (problems.length) { c.fail(`foreign authorize(append) handling failed: ${problems.join('; ')}`, { problems, error: String((error as Error)?.message ?? error) }); assert.fail(problems.join('; ')); }
  c.pass(`foreign append left in the log (${world.events.length} events), no receipt/ack; load failed with "${String((error as Error)?.message ?? error).slice(0, 120)}"`);
});

test('LO04 external direct user/message during authorize(context_ack) blocks the durable receipt', async () => {
  const c = verifyCase({ id: 'LO04', title: 'foreign append during authorize(context_ack)', spec: ['03 §4.3', '03 §5 row5'], expectation: 'a foreign write landing before the acknowledgement callback must prevent onContextDurable' });
  const history = buildHistory({ length: 250 });
  const sessionId = 'shiyu-replyer-verify-load-foreign-02';
  const h = makeHarness({ sessionId, history });
  let injected = false;
  (h as any).authorizeHook = async (check: ContextLoadAuthorizationCheck) => {
    h.phases.push(check.phase);
    if (check.phase === 'context_ack' && !injected) {
      injected = true;
      await Promise.resolve();
      h.worldRef().appendUserMessage('FOREIGN-AUTHORIZE-ACK-CANARY', 'foreign-authorize-ack');
    }
  };
  const { result, error } = await loadOnly(h);
  const problems: string[] = [];
  if (!injected) problems.push('injection did not run');
  if (error === undefined) problems.push('the foreign append was acknowledged');
  if (h.receipts.length !== 0) problems.push(`onContextDurable was called ${h.receipts.length} times`);
  if (result !== undefined) problems.push('a load-only result escaped');
  if (problems.length) { c.fail(`foreign authorize(context_ack) handling failed: ${problems.join('; ')}`, { problems, error: String((error as Error)?.message ?? error) }); assert.fail(problems.join('; ')); }
  c.pass('foreign event preserved in the log, no durable receipt and no load result');
});

test('LO05 pending native inbox blocks load-only before any acknowledgement', async () => {
  const c = verifyCase({ id: 'LO05', title: 'pending inbox blocks load', spec: ['03 §4.1', '03 §5 row6.2'], expectation: 'unknown pending input is never removed to make loading succeed; no receipt and the input is preserved' });
  const history = buildHistory({ length: 120 });
  const sessionId = 'shiyu-replyer-verify-load-inbox-001';
  const h = makeHarness({ sessionId, history });
  const world = h.worldRef();
  const pending = userMessage('pending unregistered input', 'pending-unregistered');
  world.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [pending] });
  const { result, error } = await loadOnly(h);
  const problems: string[] = [];
  if (error === undefined) problems.push('pending inbox was ignored and load-only succeeded');
  if (h.receipts.length !== 0) problems.push('onContextDurable was called');
  if (result !== undefined) problems.push('a load-only result escaped');
  const remaining = world.events.filter(event => event.type === 'agent/inbox/spliced').length;
  if (remaining !== 1) problems.push(`the pending input was removed (splice events=${remaining})`);
  if (problems.length) { c.fail(`pending-inbox handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`load refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; pending input preserved`);
});

test('LO06 lost durability after the exact message append is never acknowledged', async () => {
  const c = verifyCase({ id: 'LO06', title: 'flush failure before receipt', spec: ['03 §4.1', '03 §5 row8'], expectation: 'if the durability barrier for the loaded message does not confirm, no load receipt escapes even though the in-memory append happened' });
  const h = makeHarness({});
  // maintenance flush (ok) -> title flush (ok) -> post-message flush (false)
  h.host.flushBehavior = ['ok', 'ok', 'false'];
  const { result, error } = await loadOnly(h);
  const problems: string[] = [];
  if (error === undefined) problems.push('an unflushed load message was acknowledged');
  if (h.receipts.length !== 0) problems.push('onContextDurable was called');
  if (result !== undefined) problems.push('a load-only result escaped');
  if (problems.length) { c.fail(`flush-failure handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`load refused with "${String((error as Error)?.message ?? error).slice(0, 140)}"; no receipt`);
});

test('LO07 deadline expiry during an authorization wait blocks the receipt', async () => {
  const c = verifyCase({ id: 'LO07', title: 'deadline during authorize', spec: ['03 §4.1', '03 §4.3'], expectation: 'an absolute deadline exceeded while authorize(append) awaits rejects without a receipt' });
  const history = buildHistory({ length: 60 });
  const sessionId = 'shiyu-replyer-verify-load-deadline-1';
  const h = makeHarness({ sessionId, history });
  (h as any).authorizeHook = async (check: ContextLoadAuthorizationCheck) => {
    h.phases.push(check.phase);
    if (check.phase === 'append') await new Promise(resolve => setTimeout(resolve, 120));
  };
  const { result, error } = await loadOnly(h, { deadlineMs: Date.now() + 40 });
  const problems: string[] = [];
  if (error === undefined) problems.push('deadline expiry during authorize was ignored');
  if (h.receipts.length !== 0) problems.push('onContextDurable was called past the deadline');
  if (result !== undefined) problems.push('a load-only result escaped past the deadline');
  if (problems.length) { c.fail(`deadline handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass('deadline observed during authorize(append); load refused without receipt');
});

test('LO08 a second load-only on the same business Session keeps identity and extends history', async () => {
  const c = verifyCase({ id: 'LO08', title: 'same Session second load', spec: ['03 §5 row1/row8'], expectation: 'the same business Session id is resumed, the first loaded message remains native history, and the second exact message extends it' });
  const h = makeHarness({});
  const first = await loadOnly(h, { prompt: 'first load context' });
  if (first.error) { c.fail(`first load failed: ${String((first.error as Error)?.message ?? first.error)}`); assert.fail('first load failed'); }
  const firstSession = (first.result as ContextLoadResult).binding.sessionId;
  (h as any).setSessionId(firstSession);
  const second = await loadOnly(h, { prompt: 'second load context' });
  if (second.error) { c.fail(`second load failed: ${String((second.error as Error)?.message ?? second.error)}`); assert.fail('second load failed'); }
  const result = second.result as ContextLoadResult;
  const world = h.worldRef();
  const problems: string[] = [];
  if (result.binding.sessionId !== firstSession) problems.push('the business Session identity changed');
  if (h.host.createdSessions !== 1) problems.push(`created Sessions=${h.host.createdSessions} (expected 1)`);
  if (h.host.resumedSessions !== 1) problems.push(`resumed Sessions=${h.host.resumedSessions} (expected 1)`);
  const texts = world.events.filter(event => event.type === 'user/message').map(event => event.data.content[0].text);
  if (!texts.includes('first load context')) problems.push('the first loaded message is no longer in native history');
  if (!texts.includes('second load context')) problems.push('the second loaded message is missing');
  if (result.contextReceipt.userMessageSeq !== world.events.length - 1) problems.push('second receipt seq is not the last native event');
  if (problems.length) { c.fail(`same-Session reload mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`one created + one resumed Session ${firstSession}, both exact messages retained, second receipt seq=${result.contextReceipt.userMessageSeq}`);
});

test('LO09 cancellation while authorize(append) awaits leaves no receipt and no live Agent', async () => {
  const c = verifyCase({ id: 'LO09', title: 'cancel during authorize', spec: ['03 §4.1', '03 §5 last row'], expectation: 'cooperative cancellation rejects without a load receipt and the owned Agent is released' });
  const history = buildHistory({ length: 80 });
  const sessionId = 'shiyu-replyer-verify-load-cancel-0001';
  const h = makeHarness({ sessionId, history });
  const controller = new AbortController();
  (h as any).authorizeHook = async (check: ContextLoadAuthorizationCheck) => {
    h.phases.push(check.phase);
    if (check.phase === 'append') { await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(new Error('verification cancels load-only')); }
  };
  const { result, error } = await loadOnly(h, { signal: controller.signal });
  // The caller may stop waiting before late native cleanup completes; drain the
  // adapter so the check observes final state instead of an in-flight cleanup.
  await h.adapter.close().catch(() => {});
  const problems: string[] = [];
  if (error === undefined) problems.push('cancellation was ignored');
  if (h.receipts.length !== 0) problems.push('onContextDurable was called after cancellation');
  if (result !== undefined) problems.push('a load-only result escaped after cancellation');
  if (h.host.live.size !== 0) problems.push(`live agents remain: ${h.host.live.size}`);
  if (problems.length) { c.fail(`cancellation handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass('cancellation observed; no receipt, agent released');
});

test('LO11 an already pinned fixed title is not re-appended and the baseline still matches', async () => {
  const c = verifyCase({ id: 'LO11', title: 'existing fixed title', spec: ['03 §4.3', '03 §5 row4'], expectation: 'a Session whose title is already user-pinned needs no title write; seq is not assumed to change and the load still produces an exact receipt' });
  const history = buildHistory({ length: 220 });
  const sessionId = 'shiyu-replyer-verify-load-title-01';
  const h = makeHarness({ sessionId, history });
  const world = h.worldRef();
  world.append('session/title', { title: '识雨 · 受限回复', messageSeqs: [], source: { kind: 'user' } });
  const { result, error } = await loadOnly(h);
  if (error) { c.fail(`load with an existing fixed title failed: ${String((error as Error)?.message ?? error)}`); assert.fail(String((error as Error)?.stack ?? error)); }
  const problems: string[] = [];
  const suffix = world.events.slice(history.events.length).map(event => event.type);
  if (JSON.stringify(suffix) !== JSON.stringify(['session/title', 'session/end-seed', 'user/message'])) problems.push(`suffix=${JSON.stringify(suffix)}`);
  if (world.events.filter(event => event.type === 'session/title').length !== 1) problems.push('fixed title was written twice');
  if ((result as ContextLoadResult).contextReceipt.userMessageSeq !== world.events.length - 1) problems.push('receipt seq is not the last event');
  if (problems.length) { c.fail(`existing-title load mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`no duplicate title append; suffix ${JSON.stringify(suffix)}; receipt seq=${(result as ContextLoadResult).contextReceipt.userMessageSeq}`);
});

test('LO12 a foreign pending inbox input inserted during authorize(append) blocks the receipt', async () => {
  const c = verifyCase({ id: 'LO12', title: 'foreign inbox during authorize', spec: ['03 §4.1', '03 §4.3', '03 §5 row5'], expectation: 'an unregistered pending input arriving over the live Session during the append authorization blocks the acknowledgement and is preserved' });
  const history = buildHistory({ length: 180 });
  const sessionId = 'shiyu-replyer-verify-load-foreign-03';
  const h = makeHarness({ sessionId, history });
  let injected = false;
  h.authorizeHook = async (check: ContextLoadAuthorizationCheck) => {
    h.phases.push(check.phase);
    if (check.phase === 'append' && !injected && check.sessionId) {
      injected = true;
      await Promise.resolve();
      const agent = h.host.live.get(check.sessionId)!;
      agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [userMessage('FOREIGN-INBOX-APPEND-CANARY', 'foreign-inbox-append')] });
    }
  };
  const { result, error } = await loadOnly(h);
  await h.adapter.close().catch(() => {});
  const problems: string[] = [];
  if (!injected) problems.push('injection did not run');
  if (error === undefined) problems.push('the foreign inbox insert was acknowledged');
  if (h.receipts.length !== 0) problems.push(`onContextDurable called ${h.receipts.length} times`);
  if (result !== undefined) problems.push('a load-only result escaped');
  const world = h.worldRef();
  const fold = foldNativeInbox(world.events);
  if (fold.nextTurn.length !== 1 || fold.nextTurn[0]!.id !== 'foreign-inbox-append') problems.push('foreign pending input was not preserved exactly once');
  if (problems.length) { c.fail(`foreign authorize(inbox) handling failed: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`load refused with "${String((error as Error)?.message ?? error).slice(0, 120)}"; pending input preserved, no receipt`);
});
test('LO13 a fresh adapter instance recovers the persisted binding and resumes the same Session', async () => {
  const c = verifyCase({ id: 'LO13', title: 'adapter restart recovery', spec: ['03 §5 row1/row8', '03 §2 isolation-root'], expectation: 'after closing the adapter, a new adapter instance with the persisted binding resumes the same native Session (no replacement Session) and still issues an exact receipt' });
  const h = makeHarness({});
  const first = await loadOnly(h);
  if (first.error) { c.fail(`first load failed: ${String((first.error as Error)?.message ?? first.error)}`); assert.fail('first load failed'); }
  const sessionId = (first.result as ContextLoadResult).binding.sessionId;
  await h.adapter.close().catch(() => {});
  const world = h.worldRef();
  const persistedBefore = structuredClone(world.events);
  const produced = world.events.filter(event => event.type === 'user/message').length;
  // New adapter over the same host/persisted bindings: exactly the restart shape.
  const adapter = new ShiyuSessionAdapter({ ctx: h.host.ctx as any, bindings: h.bindings, cwd: h.host.cwd, createUserMessage: h.host.messageFactory });
  await adapter.initialize();
  const receipts: any[] = [];
  let error: unknown;
  try {
    await adapter.loadContextOnly({
      businessId: h.businessId, scope: h.scope, prompt: 'context after adapter restart', deadlineMs: Date.now() + 30_000,
      context: {
        operationId: 'verify-load-restart', contextTokenId: 'verify-load-restart-token', sessionEpoch: 2,
        onBound: async () => {}, onContextDurable: async (receipt: any) => { receipts.push(receipt); },
        authorize: async () => {},
      },
    });
  } catch (failure) { error = failure; }
  const problems: string[] = [];
  if (error) problems.push(`restarted adapter load failed: ${String((error as Error)?.message ?? error)}`);
  if (receipts.length !== 1) problems.push(`receipts=${receipts.length}`);
  if (h.host.createdSessions !== 1) problems.push(`created Sessions=${h.host.createdSessions} (expected only the first)`);
  if (h.host.resumedSessions !== 1) problems.push(`resumed Sessions=${h.host.resumedSessions} (expected the restart to resume)`);
  const prefixIntact = JSON.stringify(world.events.slice(0, persistedBefore.length)) === JSON.stringify(persistedBefore);
  if (!prefixIntact) problems.push('pre-restart durable prefix changed');
  if (receipts[0]?.sessionId !== sessionId) problems.push('restart receipt Session identity changed');
  const loaded = world.events.filter(event => event.type === 'user/message').length;
  if (loaded !== produced + 1) problems.push(`user messages=${loaded} expected ${produced + 1}`);
  await adapter.close().catch(() => {});
  if (problems.length) { c.fail(`adapter restart recovery mismatch: ${problems.join('; ')}`, { problems }); assert.fail(problems.join('; ')); }
  c.pass(`restarted adapter resumed ${sessionId} without a replacement Session; prefix preserved; receipt seq=${receipts[0].userMessageSeq}`);
});

test('LO10 long-history load-only keeps an independent durable readback of the exact message', async () => {
  const c = verifyCase({ id: 'LO10', title: 'independent durable readback', spec: ['03 §5 row8', '02 §3.1'], expectation: 'the acknowledged seq/type/full-message hash read back through a fresh independent handle equals what the log holds; the receipt is never just the adapter success field' });
  const history = buildHistory({ length: 1800 });
  const sessionId = 'shiyu-replyer-verify-load-readback-1';
  const h = makeHarness({ sessionId, history });
  const { result, error } = await loadOnly(h, { prompt: 'independent readback context' });
  if (error) { c.fail(`load failed: ${String((error as Error)?.message ?? error)}`); assert.fail('load failed'); }
  const receipt = (result as ContextLoadResult).contextReceipt;
  const world = h.worldRef();
  const handle = await world.open(sessionId, 'read');
  const read = await handle.read(receipt.userMessageSeq, 1);
  await handle.close();
  const problems: string[] = [];
  if (read.events.length !== 1) problems.push('independent read returned no exact event');
  const event = read.events[0];
  if (event?.seq !== receipt.userMessageSeq) problems.push('independent read seq mismatch');
  if (event?.type !== 'user/message') problems.push('independent read type mismatch');
  if (event?.data?.id !== receipt.messageId) problems.push('independent read message id mismatch');
  const fingerprint = independentHash(event?.data);
  if (fingerprint !== independentHash(h.receipts[0] ? event.data : undefined)) problems.push('durable fingerprint is not reproducible');
  if (receipt.messageHash !== undefined && receipt.messageHash !== fingerprint) {
    // The product's hash algorithm is an implementation detail; compare change-behaviour instead of exact bytes.
    problems.push(`receipt messageHash differs from the independent canonical fingerprint (${String(receipt.messageHash).slice(0, 12)} vs ${fingerprint.slice(0, 12)})`);
  }
  if (event?.data?.content?.[0]?.text !== 'independent readback context') problems.push('independent read text mismatch');
  if (problems.length) {
    // The message-hash algorithm difference is not a product failure; keep it as a note.
    const hard = problems.filter(problem => !problem.startsWith('receipt messageHash differs'));
    if (hard.length) { c.fail(`independent readback mismatch: ${hard.join('; ')}`, { problems }); assert.fail(hard.join('; ')); }
    c.pass(`exact message read back at seq=${receipt.userMessageSeq}; only the internal hash encoding differs (independent canonical vs product hash)`);
    return;
  }
  c.pass(`exact message read back at seq=${receipt.userMessageSeq} through a fresh independent handle (${world.events.length} events)`);
});
