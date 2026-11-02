import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getScenario } from '../src/catalog.ts';
import { ScenarioLibrary, validateScenario } from '../src/scenarios.ts';

const runtimeRoot = fileURLToPath(new URL('../runtime/scenario-tests/', import.meta.url));
async function library(t: test.TestContext) {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'library-'));
  const store = new ScenarioLibrary(root); store.init();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { store, root };
}
function script() {
  return { id: 'draft', name: '自定义资料练习', description: '', durationMs: 100, actors: [], channels: [], assets: [{ path: 'inputs/custom/data.json', content: '[1,2,3]' }], tasks: [{ id: 'CustomTask', title: '汇总列表', instructions: '给出列表数量与总和', inputs: ['inputs/custom/data.json'] }], inputs: [{ id: 'RequestOne', kind: 'request', atMs: 0, actorId: 'HUMAN', channelId: 'D-SHIYU', taskId: 'CustomTask', text: '请汇总附件中的列表。' }] };
}

test('all built-in scenario modes and normalized snapshots validate repeatedly', async t => {
  const { store } = await library(t);
  for (const mode of ['protocol', 'outcome'] as const) {
    const entries = store.list(mode);
    assert.equal(entries.length, 5);
    for (const entry of entries) {
      const scenario = store.get(entry.id, mode).scenario;
      assert.deepEqual(validateScenario(scenario, mode), scenario);
      assert.equal(scenario.actors?.filter(actor => actor.id === 'HUMAN').length, 1);
      assert.equal(scenario.channels?.filter(channel => channel.id === 'D-SHIYU').length, 1);
    }
  }
});

test('scenario saves preserve originals, reject stale revisions, and survive reopening', async t => {
  const { store, root } = await library(t);
  const original = store.get('mixed-office');
  const saved = store.save({ scenario: { ...original.scenario, name: '副本' }, expectedRevision: 1 });
  assert.match(saved.scenario.id, /^user-/); assert.equal(saved.revision, 1);
  assert.equal(store.get('mixed-office').scenario.name, original.scenario.name);
  const second = new ScenarioLibrary(root); second.init();
  const firstView = store.get(saved.scenario.id), staleView = second.get(saved.scenario.id);
  const updated = store.save({ scenario: { ...firstView.scenario, name: '最新剧本' }, expectedRevision: firstView.revision });
  assert.equal(updated.revision, 2);
  assert.throws(() => second.save({ scenario: { ...staleView.scenario, name: '过期覆盖' }, expectedRevision: staleView.revision }), /revision 冲突/);
  assert.equal(second.get(saved.scenario.id).scenario.name, '最新剧本');
  assert.throws(() => store.get(saved.scenario.id, 'protocol'), /只支持 outcome/);
  assert.equal(store.list('protocol').length, 5);
});

test('maximum authored company remains valid after normalization and persistence', async t => {
  const { store } = await library(t);
  const actors = Array.from({ length: 64 }, (_, index) => ({ id: `Actor${index}`, name: `角色${index}` }));
  const channels = Array.from({ length: 64 }, (_, index) => ({ id: `Room${index}`, name: `会话${index}`, kind: 'group', memberIds: [`Actor${index}`] }));
  const saved = store.save({ scenario: { ...script(), actors, channels } });
  assert.equal(store.get(saved.scenario.id).scenario.actors?.length, 66);
  assert.equal(store.get(saved.scenario.id).scenario.channels?.length, 65);
  assert.throws(() => validateScenario({ ...script(), actors: [...actors, { id: 'OneTooMany', name: '额外角色' }] }), /最多64/);
});

test('custom scripts reject invalid membership, missing assets, cyclic dependencies and spoofed requests', () => {
  assert.throws(() => validateScenario({ ...script(), assets: [{ path: 'inputs/../escape', content: 'bad' }] }), /跳转/);
  assert.throws(() => validateScenario({ ...script(), assets: [{ path: 'inputs/orders.json', content: '{}' }] }), /覆盖内置/);
  assert.throws(() => validateScenario({ ...script(), assets: [] }), /不存在的输入/);
  assert.throws(() => validateScenario({ ...script(), inputs: [] }), /必须有且仅有/);
  assert.throws(() => validateScenario({ ...script(), inputs: [{ ...script().inputs[0], actorId: 'SHIYU' }] }), /冒充/);
  const base = script();
  assert.throws(() => validateScenario({ ...base, tasks: [{ ...base.tasks[0], dependencies: ['CustomTask'] }] }), /依赖引用无效/);
  assert.throws(() => validateScenario({ ...base, actors: [{ id: 'Staff', name: '职员' }], channels: [{ id: 'PrivateRoom', name: '职员私聊', kind: 'direct', memberIds: ['Staff', 'HUMAN'] }] }), /职员私聊/);
});

test('scenario library rejects symlink records and does not consume their content', async t => {
  const { store, root } = await library(t);
  const saved = store.save({ scenario: script() });
  const link = path.join(store.directory, 'user-linked.json');
  await symlink(path.join(root, 'scenarios', `${saved.scenario.id}.json`), link);
  assert.throws(() => store.get('user-linked'), /剧本文件无效/);
  assert.throws(() => store.list(), /链接或目录/);
  assert.equal(getScenario('mixed-office').tasks.length, 8);
});
