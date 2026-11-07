import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserMessage, createMessage, createDeveloperMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createSessionContext } from './fixtures/sdk-session-context.mjs';
import { createSnapshotContext, RETIRED_SNAPSHOT_KIND, snapshotRequestMessages } from '../memory/snapshot-context.mjs';

const user = (text, source = { kind: 'user' }) => createUserMessage({ content: [{ type: 'text', text }], source });
const snapshot = text => user(text, { kind: 'knowledge-context', form: 'snapshot', sections: [{ name: 'source-memory', text }] });
const frames = session => session.deriveMessages().filter(message => message.source?.kind === 'knowledge-context');
async function fixture(t) {
  const ctx = await createSessionContext();
  t.after(() => ctx.fiber.dispose());
  const events = [];
  ctx.on('session/event', (session, event) => { if (session.id === 'snapshots') events.push(event); });
  const session = ctx.sessions.create(SessionId('snapshots'));
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  return { ctx, session, events, context: createSnapshotContext(ctx) };
}

test('the official projection/surface removes 53 old knowledge frames without rewriting source events', async t => {
  const { session, events, context } = await fixture(t), human = user('human-history-proof');
  session.append('user/message', human, { surfaceOp: 'append' });
  const originals = [];
  for (let n = 0; n < 53; n++) originals.push(session.append('user/message', snapshot(`old-frame-${n}:` + 'x'.repeat(9000)), { surfaceOp: 'append' }));
  assert.equal(frames(session).length, 53);
  const originalBytes = originals.map(event => JSON.stringify(event));
  const retired = await context.retire(session);
  assert.equal(retired.length, 53); assert.equal(frames(session).length, 0);
  assert.deepEqual(events.filter(event => originals.some(original => original.seq === event.seq)).map(event => JSON.stringify(event)), originalBytes);
  const latest = snapshot('latest-frame-only'); session.append('user/message', latest, { surfaceOp: 'append' });
  assert.deepEqual(frames(session).map(message => message.id), [latest.id]);
  assert.equal(session.deriveMessages().some(message => message.id === human.id), true);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'knowledge-context').length, 54);
  assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === RETIRED_SNAPSHOT_KIND).length, 53);
});

test('retirement is idempotent and never replaces human, tool or Bot relay nodes', async t => {
  const { session, events, context } = await fixture(t);
  const human = user('human'), peer = user('peer relay', { kind: 'bot', senderSessionId: 'peer', role: 'message' });
  const tool = createMessage({ role: 'tool', source: { kind: 'tool', callId: 'call-one' }, toolCallId: 'call-one', content: [{ type: 'text', text: 'exact-tool-proof' }] });
  session.append('user/message', human, { surfaceOp: 'append' });
  const old = session.append('user/message', snapshot('old'), { surfaceOp: 'append' });
  session.append('tool/result', { turn: 1, message: tool }, { surfaceOp: 'append' });
  session.append('user/message', peer, { surfaceOp: 'append' });
  await context.retire(session); const seq = session.seq;
  assert.deepEqual(await context.retire(session), []); assert.equal(session.seq, seq);
  assert.deepEqual(snapshotRequestMessages(session.deriveMessages()).map(message => message.id), [human.id, tool.id, peer.id]);
  const replacement = events.at(-1);
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: old.seq, endSeq: old.seq }); assert.ok(replacement.sourceEventSeqs.includes(old.seq));
  const prune = events.at(-2); assert.equal(prune.type, 'compaction/prune');
  assert.deepEqual(prune.data.shadowedSeqs, [old.seq]); assert.ok(prune.data.shadowedTokenCount > 0);
});

test('native cold restore needs no custom message interpreter and retains one current knowledge frame', async t => {
  const { session, events, context } = await fixture(t);
  session.append('user/message', user('persistent human'), { surfaceOp: 'append' });
  session.append('user/message', snapshot('previous snapshot'), { surfaceOp: 'append' });
  await context.retire(session);
  const latest = snapshot('latest snapshot'); session.append('user/message', latest, { surfaceOp: 'append' });
  const restored = Session.create(SessionId('snapshots'), events, session.header, session.inheritedEventCount);
  assert.deepEqual(restored.deriveMessages(), session.deriveMessages());
  assert.deepEqual(frames(restored).map(message => message.id), [latest.id]);
  assert.equal(events.some(event => event.type === 'user/message' && event.data.content[0].text === 'previous snapshot'), true);
});

test('idle maintenance retains the latest frame before the next model step replaces it', async t => {
  const { session, context } = await fixture(t);
  for (let n = 0; n < 5; n++) session.append('user/message', snapshot(`snapshot-${n}`), { surfaceOp: 'append' });
  const latest = frames(session).at(-1);
  assert.equal((await context.retire(session, { keepLatest: true })).length, 4);
  assert.deepEqual(frames(session).map(message => message.id), [latest.id]);
  assert.deepEqual(await context.retire(session, { keepLatest: true }), []);
  assert.equal((await context.retire(session)).length, 1);
  assert.equal(frames(session).length, 0);
});

test('retirement preserves an official compaction surface and removes only its following old frame', async t => {
  const { session, events, context } = await fixture(t);
  const first = session.append('user/message', user('human before checkpoint'), { surfaceOp: 'append' });
  const old = session.append('user/message', snapshot('already compacted memory'), { surfaceOp: 'append' });
  // Use the same official replacement operation as a native range checkpoint.
  const checkpoint = createDeveloperMessage({ content: [{ type: 'text', text: 'Checkpoint of real earlier work.' }], source: { kind: 'compaction' } });
  session.append('developer/message', { turn: 1, step: 1, message: checkpoint }, {
    surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: old.seq }, sourceEventSeqs: [first.seq, old.seq],
  });
  const following = session.append('user/message', snapshot('replace this latest obsolete frame'), { surfaceOp: 'append' });
  const retired = await context.retire(session);
  assert.deepEqual(retired.map(frame => frame.seq), [following.seq]);
  assert.deepEqual(snapshotRequestMessages(session.deriveMessages()).map(message => message.id), [checkpoint.id]);
  assert.equal(events.filter(event => event.type === 'user/message').length, 4);
});

test('dispatch omits only empty retired nodes and preserves every other empty or nonempty message', () => {
  const human = createUserMessage({ content: [], source: { kind: 'user' } });
  const retired = createUserMessage({ content: [], source: { kind: RETIRED_SNAPSHOT_KIND, input: 'context' } });
  const ordinary = user('Retained text', { kind: RETIRED_SNAPSHOT_KIND, input: 'context' });
  const current = snapshot('current');
  const unchanged = [human, ordinary, current]; assert.equal(snapshotRequestMessages(unchanged), unchanged);
  assert.deepEqual(snapshotRequestMessages([human, retired, ordinary, current]), unchanged);
});
