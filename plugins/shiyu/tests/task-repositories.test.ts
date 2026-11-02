import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { SQLiteTaskRepositories, TriggerPayloadConflict } from '../src/adapters/control-store/task-repositories.js';
import { SqliteTransactions } from '../src/adapters/control-store/transaction.js';
import { Engine } from '../src/control/tasks/upstream/engine.js';
import type { Candidate, Policy, Repositories } from '../src/control/tasks/upstream/ports.js';
import type { Assignment, Decision, Thread, Ticket, Trigger } from '../src/control/tasks/upstream/model.js';
import type { TaskRecord } from '../src/control/tasks/types.js';

// Fixed original snapshot is a conformance oracle only, never a production dependency.
const { MemoryRepositories } = await import(new URL('../vendor/dsh-superagent/src/core/memory.ts', import.meta.url).href) as { MemoryRepositories: new () => Repositories };
const at = '2026-11-02T00:00:00.000Z';
const trigger = (id = 'trigger-1', patch: Partial<Trigger> = {}): Trigger => ({
  id, source: 'synthetic', threads: [{ source: 'synthetic', id: 'a' }], actor: { source: 'synthetic', id: 'owner' },
  human: true, addressed: 'direct', at, text: 'Synthetic input only', meta: { details: { tag: 'original' } }, ...patch,
});
const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  key: `synthetic:${id}`, ref: { source: 'synthetic', id }, createdAt: at, subscriptions: [], correlated: [], pending: [], meta: {}, ...patch,
});
const assignment = (id: string, state: Assignment['state']): Assignment => ({ id, state, createdAt: at });
const ticket = (id: string, patch: Partial<Ticket> = {}): Ticket => ({
  id, title: id, decisionId: `decision-${id}`, mandate: { strength: 'explicit', policyVersion: 'policy-1', basis: { via: 'addressed', addressed: 'direct' }, actor: { source: 'synthetic', id: 'owner' }, scope: 'test-only' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...patch,
});
const decision = (id: string, threadKey: string): Decision => ({
  id, evalId: `eval-${id}`, threadKey, triggerIds: ['trigger-1'], policyVersion: 'policy-1', at, kind: 'ignore', reason: [{ code: 'synthetic' }], strength: 'explicit',
});
const record = (taskId: string, patch: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId, version: 1, createdAt: at, updatedAt: at, mandateId: 'synthetic-mandate', mandateVersion: 1,
  requestScope: 'synthetic-scope', requestId: `request-${taskId}`, payloadHash: 'synthetic-hash',
  completionSpec: { version: 1, checks: [{ checkId: 'check-1', type: 'synthetic', targetRef: 'artifact-1', evidenceRequired: true }] }, ...patch,
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiyu-task-repo-'));
  const filename = join(directory, 'control.sqlite');
  const opened = new Set<DatabaseSync>();
  const open = () => {
    const db = new DatabaseSync(filename); opened.add(db);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    const transactions = new SqliteTransactions(db);
    try { return { db, transactions, repo: new SQLiteTaskRepositories(db, transactions) }; }
    catch (error) { db.close(); opened.delete(db); throw error; }
  };
  const close = (db: DatabaseSync) => { db.close(); opened.delete(db); };
  t.after(async () => { for (const db of opened) db.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...open(), directory, filename, open, close };
}

test('SQLite CRUD and active-query ordering conform to the fixed upstream MemoryRepositories', async t => {
  const { repo } = await fixture(t);
  const memory = new MemoryRepositories();
  const evaluating = { id: 'eval-active', threadKey: 'synthetic:b', triggerIds: ['trigger-1'], strength: 'explicit' as const,
    actor: { source: 'synthetic', id: 'owner' }, basis: { via: 'addressed' as const, addressed: 'direct' as const }, policyVersion: 'policy-1', startedAt: at, deadline: at };
  const ended = { at, by: 'executor' as const, outcome: 'completed' as const };
  for (const target of [repo, memory]) {
    target.threads.save(thread('a', { pending: ['trigger-1'] }));
    target.threads.save(thread('b', { evaluating }));
    target.threads.save(thread('idle'));
    target.tickets.save(ticket('older-running', { assignments: [assignment('old', 'running'), assignment('latest', 'ended')] }));
    target.tickets.save(ticket('ended-with-input', { ended, undelivered: ['new-input'] }));
    target.tickets.save(ticket('latest-pending', { assignments: [assignment('pending', 'pending')] }));
    target.tickets.save(ticket('latest-running', { assignments: [assignment('running', 'running')] }));
    target.tickets.save(ticket('idle'));
    target.tickets.save(ticket('ended', { ended, assignments: [assignment('ended', 'ended')] }));
    target.decisions.save(decision('one', 'synthetic:a'));
    target.decisions.save(decision('two', 'synthetic:b'));
    target.decisions.save(decision('three', 'synthetic:a'));
    target.tickets.save({ ...target.tickets.get('older-running')!, title: 'updated without changing insertion order', createdAt: '2030-01-01T00:00:00.000Z' });
    target.threads.save({ ...target.threads.get('synthetic:a')!, pending: [] });
    target.decisions.save({ ...target.decisions.get('one')!, threadKey: 'synthetic:b' });
  }
  assert.deepEqual(repo.threads.list(), memory.threads.list());
  assert.deepEqual(repo.threads.active(), memory.threads.active());
  assert.deepEqual(repo.tickets.list(), memory.tickets.list());
  assert.deepEqual(repo.tickets.open(), memory.tickets.open());
  assert.deepEqual(repo.tickets.active(), memory.tickets.active());
  assert.deepEqual(repo.decisions.byThread('synthetic:a'), memory.decisions.byThread('synthetic:a'));
  assert.deepEqual(repo.decisions.byThread('synthetic:b'), memory.decisions.byThread('synthetic:b'));
  assert.deepEqual(repo.tickets.active().map(value => value.id), ['latest-running', 'latest-pending', 'ended-with-input']);
  repo.tickets.list()[0].title = 'unsaved mutation';
  repo.threads.get('synthetic:b')!.evaluating!.triggerIds.push('unsaved mutation');
  assert.deepEqual(repo.tickets.list(), memory.tickets.list());
  assert.deepEqual(repo.threads.list(), memory.threads.list());
});

test('trigger identities reject changed payloads without damaging disposition or thread links', async t => {
  const { db, repo } = await fixture(t);
  const original = trigger('immutable', { threads: [{ source: 'synthetic', id: 'a' }, { source: 'synthetic', id: 'b' }] });
  repo.triggers.save(original);
  repo.triggers.saveDisposition(original.id, { fanout: ['task-1'], at, acked: ['task-1'] });
  // Object property order is not a changed original input.
  const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as Trigger;
  repo.triggers.save(reordered);
  const rows = () => db.prepare('SELECT trigger_id,thread_key,at,human FROM shiyu_task_trigger_thread ORDER BY thread_key').all();
  const links = rows();
  assert.equal(links.length, 2);
  assert.throws(() => repo.triggers.save({ ...original, text: 'different original input', threads: [{ source: 'synthetic', id: 'private' }] }), TriggerPayloadConflict);
  assert.deepEqual(repo.triggers.get(original.id), original);
  assert.deepEqual(rows(), links);
  const disposition = repo.triggers.disposition(original.id)!;
  disposition.acked!.push('unsaved');
  assert.deepEqual(repo.triggers.disposition(original.id)!.acked, ['task-1']);
});

test('all core aggregates, trigger links and TaskRecord metadata survive a temporary database reopen', async t => {
  const first = await fixture(t);
  first.db.exec('PRAGMA user_version=23');
  first.repo.atomic(() => {
    first.repo.triggers.save(trigger());
    first.repo.triggers.saveDisposition('trigger-1', { fanout: ['task-1'], at });
    first.repo.threads.save(thread('a', { subscriptions: ['task-1'] }));
    first.repo.tickets.save(ticket('task-1'));
    first.repo.decisions.save(decision('decision-1', 'synthetic:a'));
    first.repo.records.save(record('task-1', { uncertainty: { reason: 'synthetic unknown receipt', at, evidenceRefs: ['receipt-1'] } }));
  });
  first.close(first.db);
  const reopened = first.open();
  assert.equal(reopened.db.prepare('PRAGMA user_version').get()!.user_version, 23);
  assert.deepEqual(reopened.repo.triggers.get('trigger-1'), trigger());
  assert.deepEqual(reopened.repo.triggers.disposition('trigger-1'), { fanout: ['task-1'], at });
  assert.equal(reopened.repo.threads.get('synthetic:a')!.subscriptions[0], 'task-1');
  assert.equal(reopened.repo.tickets.get('task-1')!.id, 'task-1');
  assert.equal(reopened.repo.decisions.byThread('synthetic:a')[0].id, 'decision-1');
  assert.equal(reopened.repo.records.get('task-1')!.uncertainty!.reason, 'synthetic unknown receipt');
  assert.equal(reopened.repo.records.list().length, 1);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM shiyu_task_trigger_thread').get()!.n, 1);
  assert.throws(() => reopened.repo.triggers.save({ ...trigger(), text: 'conflicting replay after restart' }), TriggerPayloadConflict);
});

test('one transaction rolls back TaskRecord metadata together with all upstream repositories and indices', async t => {
  const { db, repo } = await fixture(t);
  assert.throws(() => repo.atomic(() => {
    repo.triggers.save(trigger());
    repo.triggers.saveDisposition('trigger-1', { fanout: ['task-1'], at });
    repo.threads.save(thread('a', { pending: ['trigger-1'] }));
    repo.tickets.save(ticket('task-1'));
    repo.decisions.save(decision('decision-1', 'synthetic:a'));
    repo.records.save(record('task-1'));
    throw new Error('synthetic command failure');
  }), /synthetic command failure/);
  assert.equal(repo.triggers.get('trigger-1'), undefined);
  assert.equal(repo.triggers.disposition('trigger-1'), undefined);
  assert.deepEqual(repo.threads.active(), []);
  assert.deepEqual(repo.tickets.list(), []);
  assert.deepEqual(repo.decisions.byThread('synthetic:a'), []);
  assert.deepEqual(repo.records.list(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shiyu_task_trigger_thread').get()!.n, 0);
  repo.atomic(() => {
    repo.tickets.save(ticket('outer'));
    repo.records.save(record('outer'));
    assert.throws(() => repo.atomic(() => {
      repo.tickets.save(ticket('outer', { title: 'inner mutation' }));
      repo.records.save(record('outer', { version: 2 }));
      throw new Error('inner rollback');
    }), /inner rollback/);
  });
  assert.equal(repo.tickets.get('outer')!.title, 'outer');
  assert.equal(repo.records.get('outer')!.version, 1);
});

test('the real copied Engine uses this repository and atomically queues only synthetic SQL effects', async t => {
  const { db, repo } = await fixture(t);
  db.exec('CREATE TABLE synthetic_task_effect(id TEXT PRIMARY KEY)');
  const candidates: Candidate[] = [];
  const policy: Policy = { version: 'policy-1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct' } }),
    revalidate: () => true, admitsInferred: () => false };
  const engine = new Engine({
    repo, now: () => at, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: candidate => { candidates.push(candidate); } },
    executor: {
      start: (_ticket, assignment) => { db.prepare('INSERT INTO synthetic_task_effect(id) VALUES(?)').run(`start:${assignment.id}`); },
      deliver: () => {},
      stop: (_ticket, assignment) => { db.prepare('INSERT INTO synthetic_task_effect(id) VALUES(?)').run(`stop:${assignment.id}`); },
    },
    outbox: { send: () => { throw new Error('No real messages are allowed in this synthetic test'); }, status: () => undefined, withdraw: () => {} },
    prepareTicket: value => { repo.records.save(record(value.id)); return value; },
  });
  assert.equal(engine.receive(trigger()), 'stored');
  engine.evaluateDue();
  assert.equal(candidates.length, 1);
  const accepted = engine.decide('trigger-1', { kind: 'accept', title: 'Synthetic Task', scope: 'test-only', reason: 'requested', evalId: candidates[0].evalId });
  const taskId = accepted.ticketId!;
  const before = repo.tickets.get(taskId)!;
  assert.equal(repo.records.get(taskId)!.taskId, taskId);
  assert.equal(before.assignments.at(-1)!.state, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM synthetic_task_effect').get()!.n, 1);
  assert.throws(() => repo.atomic(() => {
    engine.stopTicket(taskId, 'synthetic stop');
    repo.records.save({ ...repo.records.get(taskId)!, version: 2, cancelRequested: { reason: 'synthetic stop', at } });
    throw new Error('rollback command and sidecar');
  }), /rollback command and sidecar/);
  assert.deepEqual(repo.tickets.get(taskId), before);
  assert.equal(repo.records.get(taskId)!.version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM synthetic_task_effect').get()!.n, 1);
});

test('a mismatched transaction owner or unknown task schema fails without clearing stored records', async t => {
  const first = await fixture(t);
  const other = new DatabaseSync(':memory:');
  try { assert.throws(() => new SQLiteTaskRepositories(first.db, new SqliteTransactions(other)), /same SQLite connection/); }
  finally { other.close(); }
  first.repo.records.save(record('preserved'));
  first.db.prepare('UPDATE shiyu_component_schema SET version=99 WHERE owner=?').run('task-repositories');
  assert.throws(() => new SQLiteTaskRepositories(first.db, first.transactions), /explicit migration is required/);
  assert.equal(first.repo.records.get('preserved')!.taskId, 'preserved');
  assert.equal(first.db.prepare('SELECT version FROM shiyu_component_schema WHERE owner=?').get('task-repositories')!.version, 99);
});

test('the upstream atomic signature still rejects async work before running its body', async t => {
  const { repo } = await fixture(t);
  let entered = false;
  assert.throws(() => repo.atomic(async () => { entered = true; repo.records.save(record('must-not-run')); }), /must be synchronous/);
  assert.equal(entered, false);
  assert.deepEqual(repo.records.list(), []);
});
