import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const digest = value => createHash('sha256').update(value).digest();
const forbidden = () => Object.assign(new Error('This credential cannot access that Bot'), { status: 403 });

export class NodeCredentials {
  constructor({ dataRoot, legacySecret, setup }) {
    this.filename = path.join(dataRoot, 'node-credentials.sqlite');
    this.legacyDigest = digest(legacySecret);
    this.setup = setup;
  }

  async initialize() {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filename);
    await chmod(this.filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS node_credentials (
        bot_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, secret TEXT NOT NULL,
        secret_digest TEXT UNIQUE NOT NULL
      );`);
    return this;
  }

  async issue(bot) {
    const current = bot && this.setup.participants.find(person => person.id === bot.id && person.kind === 'bot');
    if (!current || typeof bot.localpart !== 'string' || current.localpart !== bot.localpart) throw forbidden();
    const candidate = randomBytes(32).toString('hex');
    this.db.prepare('INSERT OR IGNORE INTO node_credentials VALUES (?,?,?,?)')
      .run(bot.id, bot.localpart, candidate, digest(candidate).toString('hex'));
    const binding = this.db.prepare('SELECT node_id,secret FROM node_credentials WHERE bot_id=?').get(bot.id);
    if (!binding || binding.node_id !== bot.localpart || !/^[a-f0-9]{64}$/.test(binding.secret)) throw forbidden();
    return binding.secret;
  }

  authorize(request) {
    const authorization = request.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) throw Object.assign(new Error('Node credential is required'), { status: 401 });
    const supplied = digest(authorization.slice(7));
    if (timingSafeEqual(supplied, this.legacyDigest)) return null;
    const binding = this.db.prepare('SELECT bot_id,node_id FROM node_credentials WHERE secret_digest=?').get(supplied.toString('hex'));
    if (binding) {
      const bot = this.setup.participants.find(person => person.id === binding.bot_id && person.kind === 'bot');
      if (!bot || bot.localpart !== binding.node_id) throw forbidden();
      return { botId: binding.bot_id, nodeId: binding.node_id };
    }
    throw Object.assign(new Error('Invalid node credential'), { status: 401 });
  }

  async close() { this.db?.close(); this.db = null; }
}

export function requireNodeScope(scope, { botId, nodeId }) {
  if (scope && ((botId !== undefined && scope.botId !== botId) || (nodeId !== undefined && scope.nodeId !== nodeId))) {
    throw forbidden();
  }
}
