import path from 'node:path';
import { chmod } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { requireNodeScope } from './node-auth.mjs';

const modes = new Set(['mention', 'shadow', 'natural']);
const activities = new Set(['listening', 'waiting', 'working', 'speaking']);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 512) => typeof value === 'string' && value.length <= limit && !value.includes('\0') ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const identifier = value => Boolean(text(value, 200));
const secretField = /decision.?key|api.?key|access.?token|refresh.?token|authorization|secret|password|credential|^key$|^token$|^cookie$|^__proto__$|^constructor$|^prototype$/i;

// A management response can carry memory evidence, never provider configuration.
// Do not pass native state or arbitrary heartbeat objects to a browser.
function publicValue(value, depth = 0) {
  if (depth > 20) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 16000);
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => publicValue(item, depth + 1));
  if (!object(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretField.test(key))
    .map(([key, item]) => [key, publicValue(item, depth + 1)]));
}

export function publicKernelSummary(input) {
  const runtime = input?.runtime;
  const attention = input?.attention;
  const provider = attention?.provider;
  const queue = attention?.queue;
  const decision = attention?.lastDecision;
  const watermark = decision?.watermark;
  return {
    runtime: { id: text(runtime?.id), version: text(runtime?.version), upstreamVersion: text(runtime?.upstreamVersion), available: boolean(runtime?.available) },
    attention: {
      mode: modes.has(attention?.mode) ? attention.mode : null,
      provider: { configured: boolean(provider?.configured), available: boolean(provider?.available), model: text(provider?.model) },
      activity: activities.has(attention?.activity) ? attention.activity : null,
      queue: object(queue) ? { pending: count(queue.pending), waiting: count(queue.waiting), evaluating: count(queue.evaluating), errors: count(queue.errors) } : null,
      lastDecision: object(decision) ? {
        id: text(decision.id), action: ['LISTEN', 'WAIT', 'SPEAK'].includes(decision.action) ? decision.action : null,
        status: ['evaluating', 'decided', 'error'].includes(decision.status) ? decision.status : null,
        outcome: text(decision.outcome), at: count(decision.at),
        eventIds: Array.isArray(decision.eventIds) ? decision.eventIds.slice(0, 100).map(id => text(id)).filter(Boolean) : [],
        watermark: object(watermark) ? { sequence: count(watermark.sequence), eventId: text(watermark.eventId), roomId: text(watermark.roomId) } : null,
        latencyMs: count(decision.latencyMs),
      } : null,
    },
    work: { status: text(input?.work?.status, 80) || 'unknown', activeTasks: count(input?.work?.activeTasks), waiting: count(input?.work?.waiting) },
    memorySummary: { people: count(input?.memorySummary?.people), projects: count(input?.memorySummary?.projects), pendingReview: count(input?.memorySummary?.pendingReview) },
  };
}

function memoryResult(operation, args, result) {
  if (!object(result) || result.kind !== args.kind) throw failure(502, 'KERNEL_INVALID_RESULT', 'The Bot returned an invalid memory profile');
  if (operation === 'memory-profiles') {
    if (!Array.isArray(result.items) || result.items.length > 1000 || typeof result.more !== 'boolean') {
      throw failure(502, 'KERNEL_INVALID_RESULT', 'The Bot returned an invalid memory profile list');
    }
    return { kind: args.kind, items: result.items.map(item => {
      if (!object(item) || !text(item.id, 1024) || !text(item.name) || item.kind !== args.kind) {
        throw failure(502, 'KERNEL_INVALID_RESULT', 'The Bot returned an invalid memory profile identity');
      }
      return { id: item.id, name: item.name, kind: item.kind,
        ...(Array.isArray(item.aliases) ? { aliases: item.aliases.map(alias => text(alias)).filter(Boolean) } : {}),
        currentCount: count(item.currentCount), historyCount: count(item.historyCount), scopes: publicValue(item.scopes ?? null) };
    }), more: result.more };
  }
  if (result.id !== args.id || !object(result.view)) throw failure(502, 'KERNEL_INVALID_RESULT', 'The Bot returned another memory profile identity');
  const fields = ['currentClaims', 'preferences', 'projectFacts', 'changes', 'recentSources', 'people', 'historyGaps',
    'watermarks', 'knowledgeBoundary', 'budget', 'version'];
  return { kind: args.kind, id: args.id, identity: publicValue(result.identity ?? null),
    view: Object.fromEntries(fields.map(field => [field, publicValue(result.view[field] ?? null)])) };
}

/** Small owner-management transport. It never accepts tool calls or chat tasks.
 * Nodes behind NAT poll with their existing scoped node credential. A command
 * is bound to its Bot, current node runtime and a fresh, expiring lease.
 */
export class KernelControl {
  constructor({ dataRoot, accounts, node, now = Date.now, rpcTimeoutMs = 15000, leaseMs = 10000, onlineMs = 20000 }) {
    Object.assign(this, { accounts, node, now, rpcTimeoutMs, leaseMs, onlineMs });
    for (const [key, value] of Object.entries({ rpcTimeoutMs, leaseMs, onlineMs })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 300000) throw new Error(`Invalid kernel ${key}`);
    }
    this.filename = path.join(dataRoot, 'kernel-control.sqlite');
    this.waiters = new Map();
  }

  async initialize() {
    this.db = new DatabaseSync(this.filename);
    await chmod(this.filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kernel_attention (
        bot_id TEXT PRIMARY KEY, mode TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        applied_revision INTEGER, applied_node_id TEXT, applied_runtime_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS kernel_commands (
        command_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, operation TEXT NOT NULL, args_json TEXT NOT NULL,
        revision INTEGER, status TEXT NOT NULL, node_id TEXT, runtime_id TEXT, lease_id TEXT, lease_until INTEGER,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, response_json TEXT, response_hash TEXT);
      CREATE INDEX IF NOT EXISTS kernel_commands_pending ON kernel_commands(bot_id,status,created_at);`);
    // An HTTP read cannot survive a Core restart. Retire it explicitly; a new
    // GET is safe to retry. Desired configuration survives in kernel_attention.
    const restart = JSON.stringify({ status: 'failed', error: { code: 'KERNEL_CORE_RESTARTED' } });
    this.db.prepare(`UPDATE kernel_commands SET status='failed',response_json=?,completed_at=? WHERE status IN ('queued','leased')`)
      .run(restart, this.now());
    this.cleanup();
    return this;
  }

  handles(pathname) { return /^\/api\/bots\/[^/]+\/(?:kernel|attention|memory\/profile)$/.test(pathname) || ['/internal/kernel/poll', '/internal/kernel/result'].includes(pathname); }

  owner(userId, botId) {
    this.accounts.human(userId);
    const bot = this.accounts.person(botId);
    if (!bot || bot.kind !== 'bot' || bot.ownerId !== userId) throw failure(403, 'BOT_OWNER_REQUIRED', 'Choose one of your own Bots');
    return bot;
  }

  online(botId) {
    const node = this.node(botId);
    return Boolean(node && node.status !== 'offline' && this.now() - node.heartbeatAt < this.onlineMs);
  }

  desired(botId) {
    const row = this.db.prepare('SELECT * FROM kernel_attention WHERE bot_id=?').get(botId);
    if (!row) return null;
    const node = this.node(botId);
    const applied = this.online(botId) && row.applied_revision === row.revision && row.applied_node_id === node?.id && row.applied_runtime_id === node?.runtimeId;
    return { mode: row.mode, revision: row.revision, status: applied ? 'applied' : 'pending' };
  }

  snapshot(botId) {
    const node = this.node(botId);
    const online = this.online(botId);
    const result = publicKernelSummary(online ? node?.kernel : null);
    const desiredAttention = this.desired(botId);
    if (!online) result.runtime.available = false;
    result.attention.mode ??= desiredAttention?.mode ?? null;
    return { ...result, online, updatedAt: node?.heartbeatAt ?? null, desiredAttention };
  }

  observeNode(botId) {
    if (this.online(botId)) return;
    for (const row of this.db.prepare(`SELECT command_id FROM kernel_commands WHERE bot_id=? AND operation<>'attention-set' AND status IN ('queued','leased')`).all(botId)) {
      this.failCommand(row.command_id, 'BOT_OFFLINE');
    }
  }

  setAttention(botId, input) {
    if (!object(input) || !modes.has(input.mode) || Object.keys(input).some(key => key !== 'mode')) {
      throw failure(400, 'INVALID_ATTENTION_MODE', 'Choose mention, shadow or natural attention');
    }
    const prior = this.db.prepare('SELECT * FROM kernel_attention WHERE bot_id=?').get(botId);
    if (!prior || prior.mode !== input.mode) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare(`INSERT INTO kernel_attention (bot_id,mode,revision,updated_at) VALUES (?,?,1,?)
          ON CONFLICT(bot_id) DO UPDATE SET mode=excluded.mode,revision=kernel_attention.revision+1,updated_at=excluded.updated_at,retry_at=0`)
          .run(botId, input.mode, this.now());
        this.db.prepare(`UPDATE kernel_commands SET status='superseded',completed_at=? WHERE bot_id=? AND operation='attention-set' AND status IN ('queued','leased')`)
          .run(this.now(), botId);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } else this.db.prepare('UPDATE kernel_attention SET retry_at=0 WHERE bot_id=?').run(botId);
    const desired = this.desired(botId);
    return { ...desired, applied: desired.status === 'applied', online: this.online(botId) };
  }

  activeNode(input, scope) {
    requireNodeScope(scope, { botId: input.botId, nodeId: input.nodeId });
    if (!text(input.botId, 1024) || !identifier(input.nodeId) || !identifier(input.runtimeId)) {
      throw failure(400, 'INVALID_KERNEL_NODE', 'A Bot, node and runtime identity are required');
    }
    const bot = this.accounts.person(input.botId);
    const node = this.node(input.botId);
    if (!bot || bot.kind !== 'bot') throw failure(400, 'INVALID_KERNEL_NODE', 'Unknown Bot node');
    if (!this.online(input.botId)) throw failure(409, 'KERNEL_NODE_OFFLINE', 'Send a current heartbeat before polling management commands');
    if (node.id !== input.nodeId || node.runtimeId !== input.runtimeId) throw failure(409, 'KERNEL_RUNTIME_CHANGED', 'This is not the active Bot runtime');
    if (node.kernelControl?.version !== 1) throw failure(409, 'KERNEL_CONTROL_UNAVAILABLE', 'This Bot node does not support kernel management');
    return node;
  }

  createCommand(botId, operation, args, revision, expiresAt) {
    const commandId = randomUUID();
    this.db.prepare(`INSERT INTO kernel_commands (command_id,bot_id,operation,args_json,revision,status,expires_at,created_at)
      VALUES (?,?,?,?,?,'queued',?,?)`).run(commandId, botId, operation, JSON.stringify(args), revision ?? null, expiresAt, this.now());
    return commandId;
  }

  cleanup() {
    const now = this.now();
    for (const row of this.db.prepare(`SELECT command_id FROM kernel_commands WHERE status IN ('queued','leased') AND expires_at<=?`).all(now)) {
      this.failCommand(row.command_id, 'KERNEL_TIMEOUT');
    }
    // Read results are private and transient, not a second memory database.
    this.db.prepare(`DELETE FROM kernel_commands WHERE completed_at IS NOT NULL AND completed_at<?`).run(now - 300000);
  }

  ensureAttention(botId, node) {
    const desired = this.db.prepare('SELECT * FROM kernel_attention WHERE bot_id=?').get(botId);
    if (!desired || desired.retry_at > this.now() || (desired.applied_revision === desired.revision && desired.applied_node_id === node.id && desired.applied_runtime_id === node.runtimeId)) return;
    const existing = this.db.prepare(`SELECT command_id FROM kernel_commands WHERE bot_id=? AND operation='attention-set' AND revision=? AND status IN ('queued','leased')`)
      .get(botId, desired.revision);
    if (!existing) this.createCommand(botId, 'attention-set', { mode: desired.mode }, desired.revision, this.now() + 300000);
  }

  poll(input, scope) {
    const node = this.activeNode(input, scope);
    this.cleanup();
    // A new runtime can retry a read. Its predecessor's lease no longer grants
    // permission to publish a result, even when the command ID is unchanged.
    this.db.prepare(`UPDATE kernel_commands SET status='queued',lease_id=NULL,lease_until=NULL
      WHERE bot_id=? AND status='leased' AND (lease_until<=? OR node_id<>? OR runtime_id<>?)`)
      .run(input.botId, this.now(), node.id, node.runtimeId);
    this.ensureAttention(input.botId, node);
    const commands = [];
    for (const row of this.db.prepare(`SELECT * FROM kernel_commands WHERE bot_id=? AND status='queued' AND expires_at>?
      ORDER BY CASE operation WHEN 'attention-set' THEN 0 ELSE 1 END,created_at,command_id LIMIT 4`).all(input.botId, this.now())) {
      const leaseId = randomUUID();
      const expiresAt = Math.min(row.expires_at, this.now() + this.leaseMs);
      this.db.prepare(`UPDATE kernel_commands SET status='leased',node_id=?,runtime_id=?,lease_id=?,lease_until=? WHERE command_id=? AND status='queued'`)
        .run(node.id, node.runtimeId, leaseId, expiresAt, row.command_id);
      commands.push({ commandId: row.command_id, leaseId, botId: row.bot_id, nodeId: node.id, runtimeId: node.runtimeId,
        operation: row.operation, args: JSON.parse(row.args_json), ...(row.revision === null ? {} : { revision: row.revision }), expiresAt });
    }
    return { commands, desiredAttention: this.desired(input.botId) };
  }

  failCommand(commandId, code) {
    const receipt = { status: 'failed', error: { code } };
    this.db.prepare(`UPDATE kernel_commands SET status='failed',completed_at=?,response_json=? WHERE command_id=? AND status IN ('queued','leased')`)
      .run(this.now(), JSON.stringify(receipt), commandId);
    this.settle(commandId, receipt);
  }

  settle(commandId, receipt) {
    const waiter = this.waiters.get(commandId);
    if (!waiter) return;
    this.waiters.delete(commandId);
    clearTimeout(waiter.timer);
    if (receipt.status === 'completed') waiter.resolve(receipt.result);
    else {
      const code = receipt.error?.code;
      if (code === 'MEMORY_PROFILE_NOT_KNOWN') waiter.reject(failure(404, code, 'This Bot has no evidence for that memory profile'));
      else if (code === 'BOT_OFFLINE') waiter.reject(failure(503, code, 'The Bot disconnected during the memory query'));
      else if (code === 'KERNEL_TIMEOUT') waiter.reject(failure(504, code, 'The Bot did not answer the memory query in time'));
      else if (code === 'KERNEL_CORE_RESTARTED') waiter.reject(failure(503, code, 'Core restarted during the memory query; try again'));
      else waiter.reject(Object.assign(failure(502, 'KERNEL_NODE_ERROR', 'The Bot could not read its memory profile'), { nodeCode: code }));
    }
  }

  result(input, scope) {
    this.activeNode(input, scope);
    if (!identifier(input.commandId) || !identifier(input.leaseId)) throw failure(400, 'INVALID_KERNEL_RESULT', 'A command and lease identity are required');
    const row = this.db.prepare('SELECT * FROM kernel_commands WHERE command_id=?').get(input.commandId);
    if (!row) throw failure(404, 'KERNEL_COMMAND_UNKNOWN', 'Unknown management command');
    requireNodeScope(scope, { botId: row.bot_id, nodeId: row.node_id ?? undefined });
    if (row.bot_id !== input.botId || row.node_id !== input.nodeId || row.runtime_id !== input.runtimeId || row.lease_id !== input.leaseId) {
      throw failure(409, 'KERNEL_LEASE_MISMATCH', 'This result belongs to another Bot runtime or command lease');
    }
    if (!['completed', 'failed', 'error'].includes(input.status)) throw failure(400, 'INVALID_KERNEL_RESULT', 'Choose a completed or failed result');
    const args = JSON.parse(row.args_json);
    const status = input.status === 'completed' ? 'completed' : 'failed';
    let receipt;
    if (status === 'completed') {
      if (row.operation === 'attention-set') {
        if (input.result?.mode !== args.mode || input.result?.revision !== row.revision) {
          throw failure(400, 'INVALID_ATTENTION_RESULT', 'Confirm the applied attention mode and revision');
        }
        receipt = { status, result: { mode: args.mode, revision: row.revision } };
      } else receipt = { status, result: memoryResult(row.operation, args, input.result) };
    } else {
      const code = text(input.error?.code, 100);
      if (!code || !/^[A-Z][A-Z0-9_]*$/.test(code)) throw failure(400, 'INVALID_KERNEL_RESULT', 'A failed result requires an error code');
      receipt = { status, error: { code } };
    }
    const encoded = JSON.stringify(receipt);
    const hash = createHash('sha256').update(encoded).digest('hex');
    if (['completed', 'failed'].includes(row.status) && row.response_hash === hash) return { recorded: true, duplicate: true };
    if (row.status !== 'leased' || row.lease_until <= this.now() || row.expires_at <= this.now()) {
      throw failure(409, 'KERNEL_LEASE_EXPIRED', 'This management command is no longer accepting results');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE kernel_commands SET status=?,completed_at=?,response_json=?,response_hash=? WHERE command_id=?`)
        .run(status, this.now(), encoded, hash, row.command_id);
      if (row.operation === 'attention-set') {
        if (status === 'completed') this.db.prepare(`UPDATE kernel_attention SET applied_revision=?,applied_node_id=?,applied_runtime_id=?,retry_at=0 WHERE bot_id=? AND revision=?`)
          .run(row.revision, input.nodeId, input.runtimeId, row.bot_id, row.revision);
        else this.db.prepare('UPDATE kernel_attention SET retry_at=? WHERE bot_id=? AND revision=?').run(this.now() + 5000, row.bot_id, row.revision);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.settle(row.command_id, receipt);
    return { recorded: true, duplicate: false };
  }

  readMemory(botId, { kind, id }, signal) {
    if (!['person', 'project'].includes(kind) || (id !== undefined && !text(id, 1024))) throw failure(400, 'INVALID_MEMORY_PROFILE', 'Choose a person or project profile');
    if (!this.online(botId)) throw failure(503, 'BOT_OFFLINE', 'Connect this Bot before reading its memory');
    if (this.node(botId)?.kernelControl?.version !== 1) throw failure(503, 'KERNEL_CONTROL_UNAVAILABLE', 'This Bot node does not support memory management');
    if (signal?.aborted) throw failure(499, 'KERNEL_QUERY_CANCELLED', 'The memory query was cancelled');
    this.cleanup();
    if (this.db.prepare(`SELECT COUNT(*) AS count FROM kernel_commands WHERE bot_id=? AND operation<>'attention-set' AND status IN ('queued','leased')`).get(botId).count >= 32) {
      throw failure(429, 'KERNEL_QUEUE_FULL', 'This Bot already has too many pending memory queries');
    }
    const args = { kind, ...(id === undefined ? {} : { id }) };
    const commandId = this.createCommand(botId, id === undefined ? 'memory-profiles' : 'memory-profile', args, null, this.now() + this.rpcTimeoutMs);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failCommand(commandId, 'KERNEL_TIMEOUT'), this.rpcTimeoutMs);
      this.waiters.set(commandId, { resolve, reject, timer });
    });
    const abort = () => {
      const waiter = this.waiters.get(commandId);
      if (!waiter) return;
      this.waiters.delete(commandId);
      clearTimeout(waiter.timer);
      this.db.prepare(`UPDATE kernel_commands SET status='cancelled',completed_at=? WHERE command_id=? AND status IN ('queued','leased')`).run(this.now(), commandId);
      waiter.reject(failure(499, 'KERNEL_QUERY_CANCELLED', 'The memory query was cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    return promise.finally(() => signal?.removeEventListener('abort', abort));
  }

  async handle({ request, response, url, send, userId, scope, readJsonBody }) {
    if (url.pathname.startsWith('/internal/')) {
      if (request.method !== 'POST') return send(405, { error: 'Use POST for node management' });
      const input = await readJsonBody(request);
      return send(200, url.pathname === '/internal/kernel/poll' ? this.poll(input, scope) : this.result(input, scope));
    }
    const match = url.pathname.match(/^\/api\/bots\/([^/]+)\/(kernel|attention|memory\/profile)$/);
    let botId;
    try { botId = decodeURIComponent(match[1]); }
    catch { throw failure(400, 'INVALID_BOT_ID', 'Use a complete Bot identity'); }
    this.owner(userId, botId);
    if (match[2] === 'kernel' && request.method === 'GET') return send(200, this.snapshot(botId));
    if (match[2] === 'attention' && request.method === 'PATCH') return send(200, this.setAttention(botId, await readJsonBody(request)));
    if (match[2] === 'memory/profile' && request.method === 'GET') {
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableFinished) controller.abort(); };
      response.once('close', disconnected);
      try {
        const id = url.searchParams.has('id') ? url.searchParams.get('id') : undefined;
        return send(200, await this.readMemory(botId, { kind: url.searchParams.get('kind'), id }, controller.signal));
      } finally { response.off('close', disconnected); }
    }
    return send(405, { error: 'Unsupported Bot management method' });
  }

  close() {
    for (const commandId of [...this.waiters.keys()]) this.failCommand(commandId, 'KERNEL_CORE_RESTARTED');
    this.db?.close();
    this.db = null;
  }
}
