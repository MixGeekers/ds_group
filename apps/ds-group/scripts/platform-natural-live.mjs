import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, appendFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MatrixClient } from '../src/matrix-client.mjs';
import { importNodeBundle } from './server-admin.mjs';
import { prepareNaturalHost, observedNaturalTopology } from './platform-natural-host.mjs';
import { naturalAssets } from './platform-natural-corpus.mjs';
import { readGoQuota } from './go-quota.mjs';
import { readCommandCodeCatalog } from './commandcode-preflight.mjs';
import { MODEL, ORIGINAL_TEST_MODEL } from './memory-test-model.mjs';
import { isModelQuotaFailure } from '../src/model-failure.mjs';
import { readNaturalDecisions } from './platform-natural-accounting.mjs';
import { KERNEL_API } from '../dsh-connect/kernel-runtime.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const activeStatuses = new Set(['queued', 'running', 'waiting', 'waiting-peer', 'awaiting-peer']);
const terminalStatuses = new Set(['completed', 'cancelled', 'failed', 'unknown']);
export const nativeRequestId = (botId, eventId) => `matrix-${sha(`${botId}\0${eventId}`)}`;

export class NaturalLiveAdapter {
  constructor({ environment, directory, corpus, corpusHash, resume = false, timeoutMs = 720000, paceMs = 700, configureHost }) {
    Object.assign(this, { environment, directory, corpus, corpusHash, resume, timeoutMs, paceMs, configureHost });
    this.rooms = {}; this.bots = []; this.ledger = []; this.seen = new Set(); this.kernel = []; this.requests = new Map(); this.hostDirectory = path.join(directory, 'host');
  }
  async api(route, { person = this.owner, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(this.environment.coreUrl + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${person.accessToken}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Core ${route} HTTP ${response.status}: ${value.error || 'request failed'}`);
    return value;
  }
  matrix(person) { return new MatrixClient({ baseUrl: this.environment.matrixUrl, accessToken: person.accessToken }); }
  async initialize() {
    if (this.resume) {
      try {
        this.ledger = (await readFile(path.join(this.directory, 'matrix-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        for (const event of this.ledger) this.seen.add(`${event.room_id}/${event.event_id}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const setup = JSON.parse(await readFile(path.join(this.environment.directory, 'core/matrix-setup.json'), 'utf8'));
    this.people = Object.fromEntries(this.corpus.people.map(profile => {
      const participant = setup.participants.find(person => person.localpart === profile.localpart && person.kind === 'human');
      assert.ok(participant?.accessToken, `Synthetic participant is missing: ${profile.localpart}`);
      if (!this.resume) assert.equal(participant.name, profile.name, 'Prepare this scenario with its own profiles; do not rename a historical account into a new character');
      return [profile.key, { ...participant, name: profile.name }];
    }));
    this.owner = this.people.d;
    if (!this.resume) for (const profile of this.corpus.people) {
      const current = await this.matrix(this.people[profile.key]).request('GET', `/_matrix/client/v3/profile/${encodeURIComponent(this.people[profile.key].id)}/displayname`);
      assert.equal(current.displayname, profile.name, 'Core and Matrix initial names must agree before scenario messages');
    }
    this.host = await prepareNaturalHost(this.hostDirectory, { corpusHash: this.corpusHash, profile: this.corpus.profile, resume: this.resume, configure: this.configureHost });
    const quota = MODEL === ORIGINAL_TEST_MODEL ? await readGoQuota(this.host.home) : await readCommandCodeCatalog(this.host.home);
    await writeFile(path.join(this.directory, 'provider-preflight.json'), JSON.stringify(quota, null, 2), { mode: 0o600 });
    if (!quota.available) throw Object.assign(new Error(quota.kind === 'model-catalog'
      ? 'The authorized ordinary model is absent from the provider catalog; no model host was started'
      : 'The selected Go allowance is exhausted; no model host was started'), { code: quota.kind === 'model-catalog' ? 'MODEL_UNAVAILABLE' : 'MODEL_QUOTA_EXCEEDED' });
    await this.host.start();
    await this.saveHostState();
    this.nativeBots = await this.host.api('init');
    assert.equal(this.nativeBots.length, 3);
    this.memoryObservation = await this.observeMemoryBackend();
    const hostId = `natural-${sha(this.directory).slice(0, 20)}`;
    await this.api('/api/bot-catalog', { body: { hostId, label: this.corpus.scenario, bots: this.nativeBots } });
    const nodes = [];
    for (const [index, nativeBot] of this.nativeBots.entries()) {
      const { bot } = await this.api('/api/bots/attach', { body: { hostId, nativeBotId: nativeBot.id } });
      const stateBot = (await this.host.api('state')).bots.find(item => item.id === nativeBot.id);
      this.bots.push({ ...bot, nativeBotId: nativeBot.id, sessionId: stateBot?.sessionId });
      const { bundle } = await this.api(`/api/bots/${encodeURIComponent(bot.id)}/connect`, { body: {} });
      const nodeDirectory = path.join(this.hostDirectory, `node-${index}`);
      if (!(await exists(path.join(nodeDirectory, 'matrix-setup.json')))) await importNodeBundle(bundle, nodeDirectory);
      nodes.push({ ...bot, nativeBotId: nativeBot.id, directory: nodeDirectory, serverUrl: this.environment.coreUrl });
      await this.api(`/api/bots/${encodeURIComponent(bot.id)}/attention`, { method: 'PATCH', body: { mode: 'natural' } });
    }
    await writeFile(path.join(this.hostDirectory, 'nodes.json'), JSON.stringify(nodes, null, 2), { mode: 0o600 });
    for (const definition of this.corpus.rooms) {
      if (definition.kind === 'direct') {
        const person = this.people[definition.human];
        this.rooms[definition.key] = { ...(await this.api('/api/dm', { person, body: { participantId: this.bots[definition.bot].id } })), reader: definition.human, definition };
      } else {
        // The owner initially creates the project room, then actually leaves it.
        // history_visibility=joined prevents join-later actors from reading its earlier timeline.
        const inviteIds = [...definition.humans.map(key => this.people[key].id), ...definition.bots.map(index => this.bots[index].id)];
        const room = await this.api('/api/rooms', { body: { name: definition.name,
          requestId: `natural-${this.corpus.profile}-${sha(this.directory).slice(0, 12)}-${definition.key}`, inviteIds } });
        this.rooms[definition.key] = { ...room, reader: definition.humans[0], definition };
        if (definition.historyVisibility && !this.resume) await this.matrix(this.owner).request('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/state/m.room.history_visibility/`, { history_visibility: definition.historyVisibility });
        if (!definition.humans.includes('d') && !this.resume) await this.matrix(this.owner).request('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/leave`, {});
      }
    }
    const membershipEvidence = [];
    for (const [key, room] of Object.entries(this.rooms)) {
      const client = this.matrix(this.people[room.reader]);
      const members = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/joined_members`);
      const visibility = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/state/m.room.history_visibility/`);
      membershipEvidence.push({ key, roomId: room.roomId, joinedIds: Object.keys(members.joined || {}), historyVisibility: visibility.history_visibility, at: new Date().toISOString() });
    }
    await this.host.api('connect');
    await this.capture();
    return { model: MODEL, bots: this.bots.map(({ id, nativeBotId, sessionId, name }) => ({ id, nativeBotId, sessionId, name })),
      people: Object.fromEntries(Object.entries(this.people).map(([key, person]) => [key, { id: person.id, name: person.name }])),
      rooms: Object.fromEntries(Object.entries(this.rooms).map(([key, room]) => [key, { roomId: room.roomId, kind: room.definition.kind || 'group', historyVisibility: room.definition.historyVisibility }])),
      membershipEvidence,
      memoryObservation: this.memoryObservation, topology: observedNaturalTopology(this.memoryObservation) };
  }
  async observeMemoryBackend() {
    const state = await this.host.api('state');
    const result = { enabled: state.memory, nativeBackend: state.memoryBackend || 'unknown', backend: 'unknown', observedAt: new Date().toISOString() };
    try {
      const response = await fetch(`http://127.0.0.1:${this.host.port}${KERNEL_API}`, { method: 'POST',
        headers: { 'content-type': 'application/json', cookie: this.host.cookie },
        body: JSON.stringify({ endpoint: 'memory-view', payload: { botId: state.bots[0].id } }), signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error?.message || `Memory view HTTP ${response.status}`);
      result.backend = body.value?.backend || 'unknown';
    } catch (error) { result.observationError = error.message; }
    return result;
  }
  async saveHostState() {
    await writeFile(path.join(this.directory, 'host-current.json'), JSON.stringify({ pid: this.host.child?.pid, port: this.host.port, logfile: this.host.logfile, home: this.host.home, workspace: this.host.workspace }, null, 2), { mode: 0o600 });
  }
  restoreRows(rows) {
    for (const row of rows) this.requests.set(row.id, { eventId: row.eventId, roomId: row.roomId, senderId: row.senderId,
      botId: row.botId, requestId: row.requestId, postedAt: row.postedAt, step: this.corpus.steps.find(step => step.id === row.id) });
  }
  async join(step) {
    const room = this.rooms[step.room], inviter = this.people.a, client = this.matrix(inviter), records = [];
    for (const actor of step.joins || []) {
      const participant = typeof actor === 'number' ? this.bots[actor] : this.people[actor];
      const members = await client.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/joined_members`);
      if (members.joined?.[participant.id]) { records.push({ actor, id: participant.id, roomId: room.roomId, alreadyJoined: true, at: new Date().toISOString() }); continue; }
      await client.request('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/invite`, { user_id: participant.id });
      const matrix = typeof actor === 'number' ? new MatrixClient({ baseUrl: this.environment.matrixUrl,
        accessToken: JSON.parse(await readFile(path.join(this.hostDirectory, `node-${actor}/matrix-setup.json`), 'utf8')).participants.find(person => person.id === participant.id).accessToken }) : this.matrix(participant);
      await matrix.join(room.roomId);
      records.push({ actor, id: participant.id, roomId: room.roomId, joinedAt: new Date().toISOString() });
    }
    return records;
  }
  async upload(name, person) {
    assert.ok(Object.hasOwn(naturalAssets, name), `Unknown scenario asset: ${name}`);
    const bytes = Buffer.from(naturalAssets[name]), response = await fetch(`${this.environment.coreUrl}/api/attachments?filename=${encodeURIComponent(name)}`, { method: 'POST',
      headers: { authorization: `Bearer ${person.accessToken}`, 'content-type': name.endsWith('.csv') ? 'text/csv' : 'text/plain', 'x-upload-id': `natural-${person.localpart}-${sha(bytes)}` }, body: bytes, signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Scenario upload HTTP ${response.status}`);
    assert.equal(value.attachment.sha256, sha(bytes));
    return value.attachment.id;
  }
  async post(step) {
    const person = this.people[step.sender], room = this.rooms[step.room], actions = {};
    if (step.rename) { await this.matrix(person).request('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(person.id)}/displayname`, { displayname: step.rename }); actions.rename = { id: person.id, name: step.rename }; }
    if (step.joins) actions.joins = await this.join(step);
    const attachments = [];
    for (const name of step.files || []) attachments.push(await this.upload(name, person));
    const bot = step.bot === null ? null : this.bots[step.bot], to = bot ? [bot.id] : [];
    const event = await this.api(`/api/rooms/${encodeURIComponent(room.roomId)}/messages`, { person, body: {
      body: bot ? `<@${bot.id}> ${step.body}` : step.body, transactionId: `natural-${this.corpusHash.slice(0, 12)}-${step.id}`,
      to, attachments, mentions: { users: to, roles: [], everyone: false, here: false } } });
    const value = { eventId: event.event_id, roomId: room.roomId, senderId: person.id, botId: bot?.id || null,
      requestId: bot ? nativeRequestId(bot.id, event.event_id) : null, actions, postedAt: Date.now() };
    this.requests.set(step.id, { ...value, step });
    return value;
  }
  async capture() {
    const captured = [];
    for (const [roomKey, room] of Object.entries(this.rooms)) {
      const result = await this.api(`/api/rooms/${encodeURIComponent(room.roomId)}/messages?limit=200`, { person: this.people[room.reader] });
      for (const event of result.events || []) {
        const key = `${room.roomId}/${event.event_id}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const value = { ...event, roomKey, room_id: room.roomId, capturedAt: new Date().toISOString() };
        this.ledger.push(value); captured.push(value);
        await appendFile(path.join(this.directory, 'matrix-events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
      }
    }
    for (const bot of this.bots) {
      const value = await this.api(`/api/bots/${encodeURIComponent(bot.id)}/kernel`);
      const snapshot = { botId: bot.id, at: new Date().toISOString(), value };
      this.kernel.push(snapshot);
      await appendFile(path.join(this.directory, 'kernel-snapshots.jsonl'), JSON.stringify(snapshot) + '\n', { mode: 0o600 });
    }
    return captured;
  }
  related(request) {
    return this.ledger.filter(event => event.sender === request.botId &&
      [event.content?.['org.ds_group']?.replyTo, event.content?.['org.ds_group']?.originEventId,
        event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id].includes(request.eventId));
  }
  async receipt(id) {
    const request = this.requests.get(id);
    return request?.requestId ? this.host.api('receipt', { botId: request.botId, requestId: request.requestId }) : null;
  }
  async waitStarted(step) {
    const deadline = Date.now() + Math.min(this.timeoutMs, 120000);
    while (Date.now() < deadline) {
      const receipt = await this.receipt(step.id);
      if (receipt && (activeStatuses.has(receipt.status) || terminalStatuses.has(receipt.status))) return { status: receipt.status, observedActive: activeStatuses.has(receipt.status), at: Date.now(), receipt };
      await this.capture(); await pause(400);
    }
    return { observedActive: false, status: 'not-observed', at: Date.now() };
  }
  async waitReply(step) {
    const request = this.requests.get(step.id), deadline = Date.now() + this.timeoutMs;
    let receipt;
    while (Date.now() < deadline) {
      await this.capture(); receipt = await this.receipt(step.id);
      const delivered = this.related(request);
      if (receipt && terminalStatuses.has(receipt.status)) {
        if (isModelQuotaFailure(receipt)) throw Object.assign(new Error(`Provider blocked during ${step.id}`), { code: 'MODEL_QUOTA_EXCEEDED', receipt });
        if (receipt.status !== 'completed' || delivered.length) return { receipt, delivered };
      }
      await pause(1200);
    }
    return { receipt: receipt || { status: 'unknown' }, delivered: this.related(request), timeout: true };
  }
  async settle(step) {
    const duration = step.followupWindowMs || this.paceMs;
    // The follow-up window is observation time, not an instruction to speak.
    const end = Date.now() + duration;
    do { await pause(Math.min(Math.max(1, end - Date.now()), 1500)); await this.capture(); } while (Date.now() < end);
    if (step.bot === null) return { delivered: [], receipt: null };
    return { delivered: this.related(this.requests.get(step.id)), receipt: await this.receipt(step.id) };
  }
  async quiet({ quietMs = 1200, maxMs = 30000 } = {}) {
    const startedAt = Date.now(); let lastActivity = startedAt;
    const busy = value => {
      if (!value || typeof value !== 'object') return false;
      if (value.queue && (Number(value.queue.pending) > 0 || Number(value.queue.evaluating) > 0)) return true;
      return Object.values(value).some(child => child && typeof child === 'object' && busy(child));
    };
    while (Date.now() - startedAt < maxMs) {
      const events = await this.capture();
      const receipts = await this.host.api('receipts');
      const active = receipts.some(receipt => ['queued', 'running'].includes(receipt.status));
      if (events.some(event => this.bots.some(bot => bot.id === event.sender)) || active || this.kernel.slice(-this.bots.length).some(snapshot => busy(snapshot.value))) lastActivity = Date.now();
      if (Date.now() - lastActivity >= quietMs) return { observedQuiet: true, startedAt, finishedAt: Date.now(), quietMs };
      await pause(400);
    }
    return { observedQuiet: false, startedAt, finishedAt: Date.now(), quietMs, reason: 'bounded-observation-window-ended' };
  }
  async inspectTarget(kind, targetId) {
    const target = this.requests.get(targetId); assert.ok(target?.requestId, `Control target not posted: ${targetId}`);
    const observed = await this.receipt(targetId);
    return { kind, targetId, requestId: target.requestId, botId: target.botId, roomId: target.roomId, sourceEventId: target.eventId,
      observedStatus: observed?.status || null, observedActive: Boolean(observed && activeStatuses.has(observed.status)), observedAt: Date.now() };
  }
  async control(kind, targetId, observed) {
    const target = this.requests.get(targetId); assert.ok(target?.requestId, `Control target not posted: ${targetId}`);
    observed ||= await this.inspectTarget(kind, targetId);
    let result;
    if (kind === 'cancel') result = await this.api(`/api/tasks/${encodeURIComponent(target.requestId)}/cancel`, { person: this.people[target.step.sender], body: {} });
    return { ...observed, completedAt: Date.now(), result };
  }
  async downloads(delivered, step) {
    const directory = path.join(this.directory, 'downloads', step.id); await mkdir(directory, { recursive: true });
    const files = [];
    for (const event of delivered) for (const file of event.content?.['org.ds_group']?.attachments || []) {
      if (files.some(previous => previous.id === file.id)) continue;
      const room = this.rooms[event.roomKey], response = await fetch(`${this.environment.coreUrl}/api/rooms/${encodeURIComponent(room.roomId)}/attachments/${encodeURIComponent(file.id)}?eventId=${encodeURIComponent(event.event_id)}`,
        { headers: { authorization: `Bearer ${this.people[room.reader].accessToken}` }, signal: AbortSignal.timeout(30000) });
      assert.ok(response.ok, `Real attachment download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.length, file.size); assert.equal(sha(bytes), file.sha256);
      const filename = path.join(directory, `${sha(file.id).slice(0, 12)}-${path.basename(file.name)}`);
      await writeFile(filename, bytes, { mode: 0o600 });
      files.push({ id: file.id, name: file.name, path: filename, size: bytes.length, sha256: sha(bytes), eventId: event.event_id, roomKey: event.roomKey });
    }
    return files;
  }
  async flush() { return this.host.api('flush'); }
  async nativeState() { return this.host.api('state'); }
  async compact(index) {
    await this.flush();
    const before = await this.nativeState(), result = await this.host.api('compact', { index }), after = await this.nativeState();
    return { ...result, before: before.bots.map(({ id, sessionId }) => ({ id, sessionId })), after: after.bots.map(({ id, sessionId }) => ({ id, sessionId })) };
  }
  async restart() {
    await this.flush(); const before = await this.nativeState();
    const memory = await this.host.api('memory');
    await this.host.api('disconnect'); await this.host.stop(); await this.host.start();
    await this.host.api('init'); const after = await this.nativeState(); await this.host.api('connect'); await this.saveHostState();
    const old = before.bots.map(bot => ({ id: bot.id, sessionId: bot.sessionId }));
    const next = after.bots.map(bot => ({ id: bot.id, sessionId: bot.sessionId }));
    return { before: old, after: next, identitiesPreserved: old.map(bot => bot.id).join('\0') === next.map(bot => bot.id).join('\0'),
      sessionsPreserved: old.map(bot => bot.sessionId).join('\0') === next.map(bot => bot.sessionId).join('\0'), memoryUsageBefore: memory.usage };
  }
  async protocolEvents() {
    try { return (await readFile(path.join(this.hostDirectory, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async finalize() {
    await this.capture();
    const receipts = await this.host.api('receipts'), connectionState = await this.host.api('connection-state'), memory = await this.host.api('memory');
    await writeFile(path.join(this.directory, 'native-final.json'), JSON.stringify({ receipts, connectionState, memory }, null, 2), { mode: 0o600 });
    let calls = [];
    try { calls = (await readFile(path.join(this.hostDirectory, 'calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { decisions, records, errors: decisionExportErrors } = await readNaturalDecisions(this.bots.map((bot, index) => ({ ...bot, directory: path.join(this.hostDirectory, `node-${index}`) })));
    await writeFile(path.join(this.directory, 'decision-evidence.json'), JSON.stringify({ source: 'read-only node attention_decisions tables', records }, null, 2), { mode: 0o600 });
    return { calls, decisions, decisionExportErrors, receipts, memoryUsage: memory.usage,
      memoryObservation: await this.observeMemoryBackend(), eventCount: this.ledger.length, kernelSnapshots: this.kernel.length };
  }
  async close() {
    if (this.host?.child) await this.host.api('disconnect').catch(() => {});
    if (this.host) await this.host.stop();
  }
}
