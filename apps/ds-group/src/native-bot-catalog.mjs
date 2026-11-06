import { createHash } from 'node:crypto';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);

/** Owner-only discovery metadata. Bot state and credentials never enter this catalog. */
export class NativeBotCatalog {
  constructor(accounts) {
    this.accounts = accounts;
    this.db = accounts.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_bot_hosts (
      owner_id TEXT NOT NULL, host_id TEXT NOT NULL, label TEXT NOT NULL, bots TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(owner_id,host_id));
      CREATE TABLE IF NOT EXISTS native_bot_bindings (
      owner_id TEXT NOT NULL, host_id TEXT NOT NULL, native_id TEXT NOT NULL, bot_id TEXT UNIQUE NOT NULL,
      PRIMARY KEY(owner_id,host_id,native_id));`);
  }

  publish(ownerId, input) {
    this.accounts.human(ownerId);
    if (!identifier(input?.hostId) || !Array.isArray(input.bots) || input.bots.length > 500) throw invalid('Invalid native Bot catalog');
    const bots = input.bots.map(bot => {
      if (!identifier(bot?.id) || typeof bot.name !== 'string' || !bot.name.trim() || bot.name.length > 80) throw invalid('Invalid native Bot');
      return { id: bot.id, name: bot.name, role: String(bot.role || '').slice(0, 200),
        model: String(bot.model || '').slice(0, 200), main: bot.main === true };
    });
    if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw invalid('Duplicate native Bot');
    this.db.prepare(`INSERT INTO native_bot_hosts VALUES (?,?,?,?,?) ON CONFLICT(owner_id,host_id)
      DO UPDATE SET label=excluded.label,bots=excluded.bots,updated_at=excluded.updated_at`)
      .run(ownerId, input.hostId, String(input.label || 'DSH').slice(0, 80), JSON.stringify(bots), Date.now());
    return { published: bots.length };
  }

  list(ownerId) {
    this.accounts.human(ownerId);
    return this.db.prepare('SELECT * FROM native_bot_hosts WHERE owner_id=? ORDER BY label,host_id').all(ownerId)
      .flatMap(host => JSON.parse(host.bots).map(bot => ({ ...bot, hostId: host.host_id, hostName: host.label,
        available: Date.now() - host.updated_at < 90_000, lastSeen: host.updated_at,
        botId: this.db.prepare('SELECT bot_id FROM native_bot_bindings WHERE owner_id=? AND host_id=? AND native_id=?')
          .get(ownerId, host.host_id, bot.id)?.bot_id ?? null })));
  }

  bindings(ownerId) {
    return this.db.prepare('SELECT host_id AS hostId,native_id AS nativeBotId,bot_id AS botId FROM native_bot_bindings WHERE owner_id=?').all(ownerId);
  }

  isNative(botId) { return Boolean(this.db.prepare('SELECT 1 FROM native_bot_bindings WHERE bot_id=?').get(botId)); }

  async attach(ownerId, input) {
    this.accounts.human(ownerId);
    if (!identifier(input?.hostId) || !identifier(input.nativeBotId)) throw invalid('Choose an existing local Bot');
    const key = [ownerId, input.hostId, input.nativeBotId];
    return this.accounts.serialize(`native:${JSON.stringify(key)}`, async () => {
      const prior = this.db.prepare('SELECT bot_id FROM native_bot_bindings WHERE owner_id=? AND host_id=? AND native_id=?').get(...key);
      if (prior) {
        if (input.botId && input.botId !== prior.bot_id) throw invalid('This local Bot is already linked', 409);
        return this.accounts.ownedBots(ownerId).find(bot => bot.id === prior.bot_id);
      }
      const native = this.list(ownerId).find(bot => bot.hostId === input.hostId && bot.id === input.nativeBotId);
      if (!native?.available) throw invalid('Open DSH and refresh its DSCord connection first', 409);
      let bot;
      if (input.botId) {
        bot = this.accounts.ownedBots(ownerId).find(bot => bot.id === input.botId);
        if (!bot) throw invalid('Choose your own Bot account', 403);
        if (this.db.prepare('SELECT 1 FROM native_bot_bindings WHERE bot_id=?').get(bot.id)) throw invalid('This account is already linked', 409);
      } else {
        // A retry provisions the same Matrix identity, without creating a native Bot.
        const requestId = `native:${createHash('sha256').update(JSON.stringify(key)).digest('hex')}`;
        bot = await this.accounts.createBot(ownerId, { name: native.name, requestId });
      }
      this.db.prepare('INSERT INTO native_bot_bindings VALUES (?,?,?,?)').run(...key, bot.id);
      return bot;
    });
  }
}
