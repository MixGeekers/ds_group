import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const ALLOWED_MODEL = 'opencode-go/deepseek-v4.1-flash';

export class ModelBudget {
  constructor(filename, { limit = null, maxTokens = 8192 } = {}) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS budget_config (id INTEGER PRIMARY KEY CHECK(id=1), call_limit INTEGER, max_tokens INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_claims (
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, request_id TEXT NOT NULL,
        model TEXT NOT NULL, max_tokens INTEGER NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, claimed_at TEXT NOT NULL, completed_at TEXT, result_json TEXT
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO budget_config VALUES (1, ?, ?)').run(limit, maxTokens);
  }

  claim(input) {
    if (input.model !== ALLOWED_MODEL) throw Object.assign(new Error('Only opencode dsv4.1f is enabled'), { status: 403 });
    if (!input.nodeId || !input.requestId || !Number.isInteger(input.maxTokens) || input.maxTokens < 1) {
      throw Object.assign(new Error('Invalid model claim'), { status: 400 });
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const config = this.db.prepare('SELECT * FROM budget_config WHERE id=1').get();
      const used = this.db.prepare('SELECT COUNT(*) AS count FROM model_claims').get().count;
      if (config.call_limit !== null && used >= config.call_limit) throw Object.assign(new Error('Model call budget exhausted'), { status: 429 });
      if (input.maxTokens > config.max_tokens) throw Object.assign(new Error('Output token limit exceeded'), { status: 403 });
      const claimId = randomUUID();
      this.db.prepare('INSERT INTO model_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(
        claimId, input.nodeId, input.requestId, input.model, input.maxTokens,
        input.kind || 'generation', 'claimed', new Date().toISOString(),
      );
      this.db.exec('COMMIT');
      return { claimId, maxTokens: input.maxTokens, remaining: config.call_limit === null ? null : config.call_limit - used - 1 };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  complete(input) {
    const claim = this.db.prepare('SELECT * FROM model_claims WHERE id=?').get(input.claimId);
    if (!claim) throw Object.assign(new Error('Unknown model claim'), { status: 404 });
    if (claim.status !== 'claimed') return { recorded: true, duplicate: true };
    if (!['completed', 'failed', 'cancelled', 'unknown'].includes(input.status)) throw Object.assign(new Error('Invalid completion state'), { status: 400 });
    const result = { usage: input.usage ?? null, textBytes: input.textBytes ?? null, errorCode: input.errorCode ?? null };
    this.db.prepare('UPDATE model_claims SET status=?, completed_at=?, result_json=? WHERE id=? AND status=\'claimed\'').run(
      input.status, new Date().toISOString(), JSON.stringify(result), input.claimId,
    );
    return { recorded: true, duplicate: false };
  }

  snapshot() {
    const config = this.db.prepare('SELECT * FROM budget_config WHERE id=1').get();
    const claims = this.db.prepare('SELECT * FROM model_claims ORDER BY claimed_at, rowid').all().map(row => ({
      claimId: row.id, nodeId: row.node_id, requestId: row.request_id,
      model: row.model, maxTokens: row.max_tokens, kind: row.kind,
      status: row.status, claimedAt: row.claimed_at, completedAt: row.completed_at,
      result: row.result_json ? JSON.parse(row.result_json) : null,
    }));
    return { limit: config.call_limit, used: claims.length, remaining: config.call_limit === null ? null : config.call_limit - claims.length, maxTokens: config.max_tokens, model: ALLOWED_MODEL, claims };
  }

  close() { this.db.close(); }
}
