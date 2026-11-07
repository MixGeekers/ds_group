import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';
import { sha } from '../memory/store.mjs';

const roomId = '!project:test';
const input = (eventId, body, sender = '@alice:test', kind = 'human', timestamp = 100) => ({
  event: { eventId, roomId, senderId: sender, body, timestamp }, context: { room: { id: roomId, name: 'Project' },
    source: { transport: 'matrix', roomId, sender: { id: sender, name: sender, kind }, timestamp } },
});
async function withMemory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-provenance-')), memory = new MemoryService({ directory, clock: () => 2000 });
  try { await run(memory, directory); } finally { await memory.close(); await rm(directory, { recursive: true }); }
}

test('omission from a bounded view and a peer missing citation do not remove the original source or its recall path', async () => withMemory(async memory => {
  const original = input('$allowance', 'The allowance is 2400 yuan.');
  const current = memory.ingest('a', original, { sessionId: 's' });
  const fact = await memory.remember('a', { text: 'Project allowance is 2400 yuan.', predicate: 'allowance' });
  for (let index = 0; index < 35; index++) {
    const source = input(`$fact-${index}`, `Handoff fact ${index}`, '@other:test', 'human', 200 + index);
    const observed = memory.observe('a', source).sourceRefs;
    await memory.remember('a', { text: `Handoff project detail ${index}`, subjectId: `matrix:${roomId}`, predicate: `detail-${index}`, sourceRefs: observed });
  }
  memory.ingest('a', input('$current', 'Handoff overview', '@ops:test', 'human', 300), { sessionId: 's' });
  const peer = memory.observe('a', input('$peer', 'I cannot cite the allowance source.', '@peer:test', 'bot', 400));
  await memory.remember('a', { text: 'A peer cannot cite the original allowance statement.', subjectId: fact.subjectId,
    predicate: 'peer-source-access', kind: 'reported', saidBy: '@peer:test', sourceRefs: peer.sourceRefs });
  const view = memory.contextSnapshot('a', 's', { budgetChars: 4096 });
  assert.ok(view.budget.omitted.currentClaims > 0);
  assert.equal(JSON.stringify(view).includes(current.sourceRefs[0].id), false);
  const recalled = await memory.recall('a', { query: 'allowance 2400', scope: 'group' });
  const saved = recalled.entries.find(row => row.id === fact.id);
  assert.ok(saved); assert.equal(saved.derivation, 'current'); assert.equal(saved.kind, 'stated');
  assert.equal(saved.sources[0].eventId, '$allowance');
  const raw = memory.querySources('a', { query: '2400', authorKind: 'human' });
  assert.equal(raw.entries.find(row => row.eventId === '$allowance').id, current.sourceRefs[0].id);
  assert.equal(memory.readSource('a', current.sourceRefs[0]).body, original.event.body);
}));

test('two actual runs at the same path remain attributable to their own artifact, suite and log versions', async () => withMemory(async (memory, directory) => {
  const work = join(directory, 'runs'); await mkdir(work);
  memory.ingest('a', input('$run-a', 'Run the first version.'), { sessionId: 's' });
  const moduleA = 'export const value = 1;\n';
  const suiteA = "import test from 'node:test';import assert from 'node:assert/strict';import {value} from './unit.mjs';test('value',()=>assert.equal(value,1));test('positive',()=>assert.ok(value>0));\n";
  const moduleB = 'export const value = 2;\n';
  const suiteB = "import test from 'node:test';import assert from 'node:assert/strict';import {value} from './unit.mjs';test('value',()=>assert.equal(value,2));\n";
  const runs = [];
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  for (const [name, module, suite, expected] of [['a', moduleA, suiteA, 2], ['b', moduleB, suiteB, 1]]) {
    if (name === 'b') memory.ingest('a', input('$run-b', 'Run the changed version.', '@alice:test', 'human', 500), { sessionId: 's' });
    await writeFile(join(work, 'unit.mjs'), module); await writeFile(join(work, 'unit.test.mjs'), suite);
    const log = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'unit.test.mjs'], { cwd: work, encoding: 'utf8', env: childEnv });
    const tests = Number(log.match(/^# tests (\d+)/m)?.[1]), passed = Number(log.match(/^# pass (\d+)/m)?.[1]);
    assert.equal(tests, expected); assert.equal(passed, expected);
    const evidence = { path: 'unit.mjs', artifactSha256: sha(module), suiteSha256: sha(suite), logSha256: sha(log), tests, passed, log };
    const source = memory.observeTool('a', { sessionId: 's', callId: `run-${name}`, name: 'node-test', body: JSON.stringify(evidence), timestamp: name === 'a' ? 200 : 600 });
    const saved = await memory.remember('a', { text: `unit.mjs version ${evidence.artifactSha256}: ${passed} tests passed.`,
      subjectId: `artifact:${evidence.artifactSha256}`, predicate: 'unit-test-result', kind: 'observation', sourceRefs: [{ id: source.id, revision: 1 }] });
    runs.push({ source, saved, evidence });
  }
  assert.notEqual(runs[0].evidence.artifactSha256, runs[1].evidence.artifactSha256);
  assert.notEqual(runs[0].evidence.suiteSha256, runs[1].evidence.suiteSha256);
  assert.equal(sha(await readFile(join(work, 'unit.mjs'), 'utf8')), runs[1].evidence.artifactSha256);
  const old = JSON.parse(memory.readSource('a', { id: runs[0].source.id, revision: 1 }).body);
  assert.deepEqual(old, runs[0].evidence); assert.equal(old.tests, 2);
  const recalled = await memory.recall('a', { query: 'unit.mjs', history: true, scope: 'all' });
  for (const run of runs) {
    const found = recalled.entries.find(row => row.id === run.saved.id);
    assert.ok(found); assert.equal(found.kind, 'observation');
    assert.equal(JSON.parse(found.sources[0].body).artifactSha256, run.evidence.artifactSha256);
  }
}));
