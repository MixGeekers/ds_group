import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { policyError } from './governance.mjs';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const roles = new Set(['owner', 'operator', 'auditor']);
const username = value => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{2,63}$/.test(value)) throw policyError(400, 'Administrator name must use 3–64 lowercase letters, digits, dots or hyphens');
  return value;
};
async function passwordHash(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 512) throw policyError(400, 'Use an administrator password of 12–512 characters');
  return Buffer.from(await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 })).toString('hex');
}

/** Purpose-specific, instance-local credentials. Matrix tokens are never accepted here. */
export class AdminAuth {
  constructor(dataRoot) { this.filename = path.join(dataRoot, 'administrators.sqlite'); this.mutations = Promise.resolve(); }
  async initialize() {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filename);
    await chmod(this.filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS administrators (username TEXT PRIMARY KEY,role TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,enabled INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_login_limits (scope TEXT PRIMARY KEY,failures INTEGER NOT NULL,reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);`);
    return this;
  }
  audit(actor, action, detail = {}) {
    this.db.prepare('INSERT INTO admin_audit(at,actor,action,detail) VALUES(?,?,?,?)').run(Date.now(), actor, action, JSON.stringify(detail));
  }
  list() { return this.db.prepare('SELECT username,role,enabled,created_at AS createdAt FROM administrators ORDER BY username').all().map(row => ({ ...row, enabled: Boolean(row.enabled) })); }
  change(actor, input, { bootstrap = false } = {}) {
    const operation = this.mutations.catch(() => {}).then(async () => {
      const name = username(input.username);
      if (!roles.has(input.role) || typeof input.enabled !== 'boolean') throw policyError(400, 'Invalid administrator role or state');
      if (bootstrap && this.list().length) throw policyError(409, 'This instance already has an administrator');
      const previous = this.db.prepare('SELECT * FROM administrators WHERE username=?').get(name);
      if (previous?.role === 'owner' && previous.enabled && (input.role !== 'owner' || !input.enabled)
        && this.list().filter(row => row.enabled && row.role === 'owner').length < 2) throw policyError(409, 'Keep at least one active owner');
      const salt = input.password !== undefined ? randomBytes(32).toString('hex') : previous?.salt;
      const encoded = input.password !== undefined ? await passwordHash(input.password, salt) : previous?.password_hash;
      if (!encoded) throw policyError(400, 'A password is required for a new administrator');
      this.db.prepare(`INSERT INTO administrators VALUES(?,?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET
        role=excluded.role,salt=excluded.salt,password_hash=excluded.password_hash,enabled=excluded.enabled`).run(name, input.role, salt, encoded, Number(input.enabled), Date.now());
      this.db.prepare('DELETE FROM admin_sessions WHERE username=?').run(name);
      this.audit(actor, bootstrap ? 'admin.bootstrap' : 'admin.change', { username: name, role: input.role, enabled: input.enabled, passwordChanged: input.password !== undefined });
      return this.list();
    });
    this.mutations = operation;
    return operation;
  }
  async login(input, address) {
    const name = typeof input.username === 'string' ? input.username : '';
    const now = Date.now();
    const scopes = [`address:${hash(address || 'unknown')}`, `account:${hash(name)}`];
    for (const scope of scopes) {
      const limit = this.db.prepare('SELECT * FROM admin_login_limits WHERE scope=?').get(scope);
      if (limit?.reset_at > now && limit.failures >= 10) throw policyError(429, 'Too many administrator login attempts; try again in 15 minutes');
    }
    const row = this.db.prepare('SELECT * FROM administrators WHERE username=?').get(name);
    const candidate = typeof input.password === 'string' && input.password.length >= 12 && input.password.length <= 512
      ? await passwordHash(input.password, row?.salt || 'dscord-admin-unknown-account') : await passwordHash('dummy-password-for-authentication', 'dscord-admin-unknown-account');
    if (!row?.enabled || !timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(row.password_hash, 'hex'))) {
      for (const scope of scopes) this.db.prepare(`INSERT INTO admin_login_limits VALUES(?,1,?) ON CONFLICT(scope) DO UPDATE SET
        failures=CASE WHEN reset_at<=? THEN 1 ELSE failures+1 END, reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END`).run(scope, now + 900000, now, now);
      this.audit('unauthenticated', 'admin.login_rejected', { accountHash: hash(name) });
      throw policyError(401, 'Administrator sign-in failed');
    }
    for (const scope of scopes) this.db.prepare('DELETE FROM admin_login_limits WHERE scope=?').run(scope);
    const token = `dscord_admin_${randomBytes(48).toString('base64url')}`;
    const expiresAt = now + 8 * 3600000;
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at<=? OR last_seen<=?').run(now, now - 3600000);
    this.db.prepare('INSERT INTO admin_sessions VALUES(?,?,?,?)').run(hash(token), row.username, expiresAt, now);
    this.audit(row.username, 'admin.login');
    return { access_token: token, administrator: { username: row.username, role: row.role }, expiresAt };
  }
  authorize(request, allowed = ['owner', 'operator', 'auditor']) {
    const header = request.headers.authorization || '';
    if (!header.startsWith('Bearer dscord_admin_')) throw policyError(401, 'An instance administrator session is required');
    const tokenHash = hash(header.slice(7));
    const row = this.db.prepare(`SELECT s.*,a.role,a.enabled FROM admin_sessions s JOIN administrators a ON a.username=s.username WHERE s.token_hash=?`).get(tokenHash);
    const now = Date.now();
    if (!row?.enabled || row.expires_at <= now || row.last_seen <= now - 3600000) throw policyError(401, 'Administrator session expired');
    if (!allowed.includes(row.role)) throw policyError(403, 'Your administrator role cannot perform this operation');
    this.db.prepare('UPDATE admin_sessions SET last_seen=? WHERE token_hash=?').run(now, tokenHash);
    return { username: row.username, role: row.role, tokenHash };
  }
  logout(actor) { this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(actor.tokenHash); this.audit(actor.username, 'admin.logout'); }
  events(before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT * FROM admin_audit WHERE sequence<? ORDER BY sequence DESC LIMIT 100').all(before).map(row => ({ ...row, detail: JSON.parse(row.detail) }));
  }
  close() { this.db.close(); }
}
