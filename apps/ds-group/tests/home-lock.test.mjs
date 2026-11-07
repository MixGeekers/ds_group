import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const fixture = fileURLToPath(new URL('./fixtures/home-lock-child.mjs', import.meta.url));
async function setup(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'dscord-home-lock-'));
  const filename = path.join(home, 'state.lock');
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited));
    await rm(home, { recursive: true, force: true });
  });
  async function client(options = {}) {
    const child = fork(fixture, [filename, JSON.stringify(options)], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let next = 0, stderr = '', readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const pending = new Map();
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => {
      const error = new Error(`Lock child exited (${code ?? signal}): ${stderr}`);
      readyReject(error);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear(); resolve({ code, signal });
    }));
    child.once('error', readyReject);
    child.on('message', message => {
      if (message.ready) { readyResolve(); return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else entry.resolve(message);
    });
    const result = { process: child, exited, call(command) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Lock child ${command} timed out: ${stderr}`)); }, 10_000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, command }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
      });
    } };
    children.push(result); await ready; return result;
  }
  return { home, filename, client };
}
async function waitFor(filename) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`Lock test did not reach ${path.basename(filename)}`);
    await delay(5);
  }
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.equal(child.status, 0); assert.ok(child.pid > 0);
  return child.pid;
}

test('two processes cannot interleave stale PID reclamation into two successful claims', async t => {
  const f = await setup(t), pauseMarker = path.join(f.home, 'paused'), resumeMarker = path.join(f.home, 'resume');
  const stale = JSON.stringify({ pid: deadPid(), host: hostname(), token: 'previous-owner', since: Date.now() });
  await writeFile(f.filename, stale);
  const a = await f.client({ pauseUnlink: true, pauseMarker, resumeMarker }), b = await f.client();
  const pending = a.call('claim'); await waitFor(pauseMarker);
  try {
    const blocked = await b.call('claim'); assert.equal(blocked.accepted, false); assert.equal(blocked.holder.reason, 'runtime-lock-unavailable');
    assert.equal(await readFile(f.filename, 'utf8'), stale);
  } finally { await writeFile(resumeMarker, 'resume'); }
  assert.equal((await pending).accepted, true);
  assert.equal((await a.call('inspect')).owns, true);
  assert.equal((await b.call('claim')).accepted, false);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).pid, a.process.pid);
});

test('concurrent first startups publish one database and admit exactly one process', async t => {
  const f = await setup(t), clients = await Promise.all(Array.from({ length: 8 }, () => f.client()));
  const results = await Promise.all(clients.map(client => client.call('claim')));
  const winners = results.filter(result => result.accepted);
  assert.equal(winners.length, 1);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).pid, winners[0].pid);
  assert.deepEqual((await readdir(f.home)).filter(name => name.endsWith('.tmp')), []);
  for (let i = 0; i < clients.length; i++) assert.equal((await clients[i].call('inspect')).owns, results[i].accepted);
});

test('an initializer paused before atomic publication cannot later split the lock database', async t => {
  const f = await setup(t), pauseMarker = path.join(f.home, 'paused'), resumeMarker = path.join(f.home, 'resume');
  const a = await f.client({ pausePublish: true, pauseMarker, resumeMarker }), b = await f.client();
  const pending = a.call('claim'); await waitFor(pauseMarker);
  try { assert.equal((await b.call('claim')).accepted, true); }
  finally { await writeFile(resumeMarker, 'resume'); }
  assert.equal((await pending).accepted, false);
  assert.equal((await b.call('inspect')).owns, true);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).pid, b.process.pid);
});

test('SIGKILL releases the OS reservation and a fresh heartbeat does not prevent recovery', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client();
  const first = await a.call('claim'); assert.equal(first.accepted, true);
  a.process.kill('SIGKILL'); assert.equal((await a.exited).signal, 'SIGKILL');
  const second = await b.call('claim'); assert.equal(second.accepted, true); assert.equal(second.owns, true);
  assert.notEqual(second.record.token, first.record.token);
  assert.equal(second.record.pid, b.process.pid);
});

test('crashing before database publication leaves no canonical guard that could block a new startup', async t => {
  const f = await setup(t), pauseMarker = path.join(f.home, 'paused'), resumeMarker = path.join(f.home, 'resume');
  const a = await f.client({ pausePublish: true, pauseMarker, resumeMarker });
  const pending = a.call('claim').catch(error => error);
  await waitFor(pauseMarker); a.process.kill('SIGKILL'); await a.exited; await pending;
  assert.equal(existsSync(`${f.filename}.sqlite`), false);
  const b = await f.client(); assert.equal((await b.call('claim')).accepted, true);
  assert.equal((await b.call('inspect')).owns, true);
});

test('releasing a previous owner twice never removes the next process PID or reservation', async t => {
  const f = await setup(t), a = await f.client(), b = await f.client();
  assert.equal((await a.call('claim')).accepted, true); await a.call('release');
  const next = await b.call('claim'); assert.equal(next.accepted, true);
  await a.call('release');
  assert.equal((await b.call('inspect')).owns, true);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).token, next.record.token);
  assert.equal((await a.call('claim')).accepted, false);
  await b.call('release'); assert.equal((await a.call('claim')).accepted, true);
});

test('live legacy PID and unknown old files remain byte-for-byte intact', async t => {
  for (const [name, bytes] of [
    ['live-legacy', JSON.stringify({ pid: process.pid, host: hostname(), token: 'legacy', since: Date.now() })],
    ['unknown-json', '{"custom":"preserve"}'], ['partial', '{"pid":'], ['null', 'null'],
  ]) await t.test(name, async t => {
    const f = await setup(t); await writeFile(f.filename, bytes); await utimes(f.filename, new Date(0), new Date(0));
    const a = await f.client(), result = await a.call('claim');
    assert.equal(result.accepted, false); assert.equal(await readFile(f.filename, 'utf8'), bytes);
    if (name === 'live-legacy') assert.equal(result.holder.pid, process.pid);
    else assert.equal(result.holder.reason, 'unrecognized-legacy-lock');
    await a.call('release'); assert.equal(await readFile(f.filename, 'utf8'), bytes);
  });
});

test('unknown database and legacy symlink are preserved without acquiring a writer', async t => {
  const f = await setup(t), bytes = 'unrecognized existing database';
  await writeFile(`${f.filename}.sqlite`, bytes);
  const a = await f.client(); const result = await a.call('claim');
  assert.equal(result.accepted, false); assert.equal(result.holder.error, 'DSCORD_LOCK_DATABASE_INVALID');
  assert.equal(await readFile(`${f.filename}.sqlite`, 'utf8'), bytes); assert.equal(existsSync(f.filename), false);
  await rm(`${f.filename}.sqlite`);
  const target = path.join(f.home, 'legacy-target');
  const legacy = JSON.stringify({ pid: deadPid(), host: hostname(), token: 'legacy-link', since: 1 });
  await writeFile(target, legacy); await symlink(target, f.filename);
  assert.equal((await a.call('claim')).accepted, false); assert.equal(await readFile(f.filename, 'utf8'), legacy);
  assert.equal(await readFile(target, 'utf8'), legacy);
});

test('failed and partial PID writes release the transaction and leave no half-published owner', async t => {
  for (const failure of ['before', 'partial']) await t.test(failure, async t => {
    const f = await setup(t), a = await f.client({ failPidWrite: failure }), b = await f.client();
    const failed = await a.call('claim'); assert.equal(failed.accepted, false); assert.equal(failed.holder.error, 'EACCES');
    assert.equal(existsSync(f.filename), false);
    assert.deepEqual((await readdir(f.home)).filter(name => name.endsWith('.tmp')), []);
    assert.equal((await b.call('claim')).accepted, true);
    assert.equal((await a.call('claim')).accepted, false);
    await b.call('release'); assert.equal((await a.call('claim')).accepted, true);
  });
});
