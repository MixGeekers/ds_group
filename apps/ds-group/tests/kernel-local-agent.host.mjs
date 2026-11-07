import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { LocalAgentAdapter } from '../vendor/ds-bot/src/host/local-agents/adapter.js';
import { AcpEngine } from '../vendor/ds-bot/src/host/local-agents/acp.js';

const user = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text }], source });
const context = (id, text) => user(id, text, { kind: 'knowledge-context', form: 'snapshot', sections: [{ name: 'memory', text }] });
async function adapterFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dscord-cli-'));
  const records = new Map(), engines = [];
  const adapter = new LocalAgentAdapter({ rt: { warn() {} },
    customAgents: () => [{ id: 'echo', name: 'Echo', command: process.execPath }], findExecutable: value => value,
    spawnEngine(_kind, route, spec) {
      const engine = new AcpEngine(route, { ...spec, command: process.execPath, args: [path.join(import.meta.dirname, 'fixtures/kernel-echo-acp.mjs')] }, { findExecutable: value => value });
      engines.push(engine); return engine;
    },
    record: id => records.get(id), saveRecord: (id, record) => records.set(id, record),
    presetFor: () => 'workspace-write', cwdFor: async () => directory, probeCwd: () => directory, toolsFor: () => [],
  });
  t.after(async () => { await adapter.dispose(); await rm(directory, { recursive: true, force: true }); });
  const send = async messages => {
    let text = '';
    for await (const chunk of adapter.stream({ provider: 'acp-echo', model: 'default', sessionId: 'same-native-session', messages, tools: [], signal: AbortSignal.timeout(10000) })) if (chunk.type === 'text-delta') text += chunk.text;
    return text;
  };
  return { adapter, engines, send };
}

test('knowledge-only context starts no CLI and reaches the next real input as labelled context', async t => {
  const f = await adapterFor(t), snapshot = context('memory-one', '林青 @lin:a.test prefers a table.');
  assert.equal(await f.send([snapshot]), ''); assert.ok(f.engines.every(engine => engine.child === undefined));
  const text = await f.send([snapshot, user('input', 'Report the figures.', { kind: 'user', sender: { id: '@lin:a.test', name: '林青', kind: 'human' }, roomId: '!north:test' })]);
  assert.match(text, /Context \(knowledge-context\)/); assert.match(text, /Human \(@lin:a.test; room !north:test\)/);
  assert.match(text, /prefers a table/); assert.doesNotMatch(text, /User: 林青/);
});

test('memory snapshots never answer an open human question; Bot input keeps its own identity', async t => {
  const f = await adapterFor(t), first = user('first', 'hello'); await f.send([first]);
  const live = f.adapter.live.get('same-native-session'); let answered = false;
  live.pending.set('human-question', { name: 'ask_user', resolve: () => { answered = true; } });
  const snapshot = context('memory-next', 'A background lookup result.');
  assert.equal(await f.send([first, snapshot]), ''); assert.equal(answered, false);
  const bot = user('bot-input', 'Peer progress.', { kind: 'bot', sender: { id: '@bot:test', kind: 'bot' } });
  const text = await f.send([first, snapshot, bot]);
  assert.equal(answered, false); assert.match(text, /Bot \(@bot:test\): Peer progress/);
  assert.match(text, /Context \(knowledge-context\)/); assert.equal(f.adapter.live.size, 1);
});
