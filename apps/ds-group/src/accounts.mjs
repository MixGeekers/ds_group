import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MatrixClient } from './matrix-client.mjs';

const failure = (status, message) => Object.assign(new Error(message), { status });
const publicPerson = ({ id, localpart, name, kind, ownerId }) => ({ id, localpart, name, kind,
  ...(kind === 'bot' ? { ownerId } : {}) });
function accountInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, 'Account details must be an object');
  return value;
}

/** Persistent local identities. Matrix owns passwords and browser sessions. */
export class AccountService {
  constructor({ setup, config = {}, dataRoot, onParticipant, registrationSecret, clientFactory } = {}) {
    this.setup = setup;
    this.config = config;
    this.dataRoot = dataRoot;
    this.onParticipant = onParticipant;
    this.registrationSecret = registrationSecret;
    this.clientFactory = clientFactory || (accessToken => new MatrixClient({ baseUrl: setup.homeserverUrl, accessToken }));
    this.serverName = setup.serverName || setup.participants[0]?.id.split(':').slice(1).join(':');
    this.mode = config.registrationMode ?? 'open';
    if (!['open', 'closed'].includes(this.mode)) throw new Error('registrationMode must be open or closed');
    this.operations = new Map();
  }

  async initialize() {
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    try {
      const metadata = JSON.parse(await readFile(path.join(this.dataRoot, 'server.json'), 'utf8'));
      if (this.serverName && metadata.serverName && metadata.serverName !== this.serverName) throw new Error('Account registration belongs to another Matrix server');
      this.serverName ||= metadata.serverName;
      this.registrationSecret ??= metadata.registrationSecret;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const filename = path.join(this.dataRoot, 'accounts.sqlite');
    this.db = new DatabaseSync(filename);
    try { return await this.#initializeDatabase(filename); }
    catch (error) { this.close(); throw error; }
  }

  async #initializeDatabase(filename) {
    await chmod(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS account_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY, localpart TEXT UNIQUE NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        owner_id TEXT, status TEXT NOT NULL, service_token TEXT, service_device_id TEXT,
        recovery_password TEXT, registration_hash TEXT, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_creation_requests (
        request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, user_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_subjects (
        user_id TEXT PRIMARY KEY, subject_id TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL
      );`);
    const identityVersion = this.db.prepare("SELECT value FROM account_metadata WHERE key='identitySchemaVersion'").get()?.value;
    if (identityVersion !== undefined && identityVersion !== '1') throw new Error('Unsupported account identity schema version');
    const storedServer = this.db.prepare("SELECT value FROM account_metadata WHERE key='serverName'").get()?.value;
    if (storedServer && this.serverName && storedServer !== this.serverName) throw new Error('Account database belongs to another Matrix server');
    this.serverName ||= storedServer;
    if (this.serverName) {
      this.setup.serverName = this.serverName;
      this.db.prepare("INSERT OR IGNORE INTO account_metadata VALUES ('serverName',?)").run(this.serverName);
    }
    this.db.prepare("INSERT OR IGNORE INTO account_metadata VALUES ('authorityId',?)").run(`urn:uuid:${randomUUID()}`);
    this.authorityId = this.db.prepare("SELECT value FROM account_metadata WHERE key='authorityId'").get().value;
    const seedOwner = this.setup.participants.find(person => person.kind === 'human')?.id;
    if (seedOwner) this.db.prepare("INSERT OR IGNORE INTO account_metadata VALUES ('ownerId',?)").run(seedOwner);
    this.ownerId = this.db.prepare("SELECT value FROM account_metadata WHERE key='ownerId'").get()?.value;
    for (const person of this.setup.participants) {
      if (!['human', 'bot'].includes(person.kind) || person.id !== `@${person.localpart}:${this.serverName}`) {
        throw new Error('Account registry must contain complete identities on its own Matrix server');
      }
      const existing = this.row(person.id);
      if (existing && existing.kind !== person.kind) throw new Error('An existing account cannot change identity kind');
      this.db.prepare(`INSERT OR IGNORE INTO accounts
        (user_id,localpart,name,kind,owner_id,status,service_token,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)`)
        .run(person.id, person.localpart, person.name, person.kind, person.kind === 'bot' ? person.ownerId || this.ownerId : null,
          person.accessToken || null, Date.now(), Date.now());
    }
    // Additive migration: neither Matrix accounts nor owner/node bindings are replaced.
    for (const row of this.db.prepare("SELECT user_id FROM accounts WHERE status='active'").all()) this.ensureSubject(row.user_id);
    this.db.prepare("INSERT OR REPLACE INTO account_metadata VALUES ('identitySchemaVersion','1')").run();
    this.refreshSetup();
    return this;
  }

  registration() { return { enabled: this.mode === 'open' && Boolean(this.serverName && this.registrationSecret), mode: this.mode }; }

  row(userId) { return this.db.prepare('SELECT * FROM accounts WHERE user_id=?').get(userId); }

  ensureSubject(userId) {
    this.db.prepare('INSERT OR IGNORE INTO account_subjects VALUES (?,?,?)').run(userId, randomUUID(), Date.now());
    return this.db.prepare('SELECT subject_id FROM account_subjects WHERE user_id=?').get(userId).subject_id;
  }

  identity(userId) {
    const row = this.row(userId);
    if (!row) throw failure(403, 'A registered account is required');
    const owner = row.owner_id && this.row(row.owner_id);
    return { authorityId: this.authorityId, subjectId: this.ensureSubject(userId), matrixUserId: userId, kind: row.kind,
      ...(row.owner_id ? { ownerMatrixUserId: row.owner_id, ...(owner?.kind === 'human' ? { ownerSubjectId: this.ensureSubject(row.owner_id) } : {}) } : {}) };
  }

  assertActive(userId) {
    if (this.row(userId)?.status !== 'active') throw Object.assign(failure(403, 'This account is not active on its home server'), { code: 'ACCOUNT_INACTIVE' });
    return userId;
  }

  async authenticate(token) {
    const result = await this.clientFactory(token).whoami();
    this.assertActive(result.user_id);
    return result;
  }

  session(session) {
    this.assertActive(session.user_id);
    return { ...session, identity: this.identity(session.user_id), ...(this.home ? { home: this.home } : {}) };
  }

  participant(row) {
    return { id: row.user_id, localpart: row.localpart, name: row.name, kind: row.kind,
      ...(row.owner_id ? { ownerId: row.owner_id } : {}), ...(row.service_token ? { accessToken: row.service_token } : {}) };
  }

  refreshSetup() {
    const existing = new Map(this.setup.participants.map(person => [person.id, person]));
    const people = this.db.prepare("SELECT * FROM accounts WHERE status='active' ORDER BY created_at,rowid").all()
      .map(row => ({ ...existing.get(row.user_id), ...this.participant(row) }));
    this.setup.participants.splice(0, this.setup.participants.length, ...people);
  }

  person(userId) { return this.setup.participants.find(person => person.id === userId); }
  publicParticipants() { return this.setup.participants.map(publicPerson); }
  ownedBots(userId) { return this.setup.participants.filter(person => person.kind === 'bot' && person.ownerId === userId).map(publicPerson); }

  human(userId) {
    this.assertActive(userId);
    const person = this.person(userId);
    if (person?.kind !== 'human') throw failure(403, 'A registered human account is required');
    return person;
  }

  async publish(userId) {
    this.refreshSetup();
    const person = this.person(userId);
    await this.onParticipant?.(person);
    return person;
  }

  normalizeUsername(value) {
    if (!this.serverName) throw failure(503, 'This server has no Matrix account identity configured');
    if (typeof value !== 'string') throw failure(400, 'Choose an account name');
    let localpart = value.trim();
    if (localpart.startsWith('@')) {
      const suffix = `:${this.serverName}`;
      if (!localpart.endsWith(suffix)) throw failure(400, 'Use an account on this server');
      localpart = localpart.slice(1, -suffix.length);
    }
    if (!/^[a-z0-9][a-z0-9._=-]{0,63}$/.test(localpart)) throw failure(400, 'Account names use 1–64 lowercase letters, digits, dots, underscores, equals or hyphens');
    return localpart;
  }

  password(value) {
    if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) throw failure(400, 'Enter a password of 1–1024 characters');
    return value;
  }

  displayName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f]/.test(value)) throw failure(400, 'Choose a display name of 1–80 characters');
    return value.trim();
  }

  async serialize(key, work) {
    const previous = this.operations.get(key);
    if (previous) return previous;
    const promise = Promise.resolve().then(work);
    this.operations.set(key, promise);
    try { return await promise; }
    finally { this.operations.delete(key); }
  }

  async passwordLogin(userId, password, service = false, clientIp) {
    const deviceId = service ? `DSCORD_CORE_${createHash('sha256').update(userId).digest('hex').slice(0, 24)}` : `DSCORD_${randomUUID()}`;
    const session = await this.clientFactory().request('POST', '/_matrix/client/v3/login', {
      type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password,
      device_id: deviceId, initial_device_display_name: service ? 'DSCord server' : 'DSCord client',
    }, { clientIp });
    if (session.user_id !== userId || !session.access_token) throw failure(502, 'Matrix returned another account identity');
    return session;
  }

  async saveServiceSession(userId, session) {
    this.db.prepare('UPDATE accounts SET service_token=?,service_device_id=?,updated_at=? WHERE user_id=?')
      .run(session.access_token, session.device_id || null, Date.now(), userId);
  }

  async ensureServiceSession(userId, password, clientIp) {
    const row = this.row(userId);
    if (row?.service_token) {
      try {
        if ((await this.clientFactory(row.service_token).whoami()).user_id === userId) return;
      } catch (error) { if (![401, 403].includes(error.status)) throw error; }
    }
    await this.saveServiceSession(userId, await this.passwordLogin(userId, password, true, clientIp));
  }

  async joinInitialRoom(userId) {
    if (!this.setup.roomId || userId === this.ownerId || this.row(userId).kind === 'bot') return;
    const person = this.row(userId);
    const client = this.clientFactory(person.service_token);
    const { joined_rooms: joined = [] } = await client.request('GET', '/_matrix/client/v3/joined_rooms');
    if (joined.includes(this.setup.roomId)) return;
    const owner = this.row(this.ownerId);
    if (!owner?.service_token) throw failure(503, 'The server owner must sign in before new members can join');
    await this.clientFactory(owner.service_token).request('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(this.setup.roomId)}/invite`, { user_id: userId });
    await client.join(this.setup.roomId);
  }

  async activate(userId) {
    if (['disabled', 'deactivated'].includes(this.row(userId)?.status)) throw failure(403, 'This account is disabled');
    this.ensureSubject(userId);
    this.db.prepare("UPDATE accounts SET status='active',last_error=NULL,updated_at=? WHERE user_id=?").run(Date.now(), userId);
    if (!this.ownerId && this.row(userId).kind === 'human') {
      this.db.prepare("INSERT OR IGNORE INTO account_metadata VALUES ('ownerId',?)").run(userId);
      this.ownerId = this.db.prepare("SELECT value FROM account_metadata WHERE key='ownerId'").get().value;
    }
    return this.publish(userId);
  }

  async provision(userId, password, clientIp) {
    const row = this.row(userId);
    if (['disabled', 'deactivated'].includes(row?.status)) throw failure(403, 'This account is disabled');
    try {
      if (!row.service_token) {
        const recovering = Boolean(row.last_error);
        this.db.prepare("UPDATE accounts SET last_error='REGISTRATION_STARTED' WHERE user_id=?").run(userId);
        const anonymous = this.clientFactory();
        const { nonce } = await anonymous.request('GET', '/_synapse/admin/v1/register', undefined, { clientIp });
        const mac = createHmac('sha1', this.registrationSecret).update([nonce, row.localpart, password, 'notadmin'].join('\0')).digest('hex');
        let session;
        try {
          session = await anonymous.request('POST', '/_synapse/admin/v1/register', {
            nonce, username: row.localpart, password, displayname: row.name, admin: false, mac,
          }, { clientIp });
        } catch (error) {
          if (error.errcode !== 'M_USER_IN_USE') throw error;
          if (!recovering) throw Object.assign(failure(409, 'This Matrix account already exists. Sign in to continue'), { code: 'ACCOUNT_EXISTS' });
          // A previous attempt may have reached Matrix before its response was lost.
          session = await this.passwordLogin(userId, password, true, clientIp);
        }
        if (session.user_id !== userId || !session.access_token) throw failure(502, 'Matrix returned another account identity');
        await this.saveServiceSession(userId, session);
      } else await this.ensureServiceSession(userId, password, clientIp);
      const client = this.clientFactory(this.row(userId).service_token);
      await client.request('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`, { displayname: row.name });
      await this.joinInitialRoom(userId);
      return await this.activate(userId);
    } catch (error) {
      this.db.prepare('UPDATE accounts SET last_error=?,updated_at=? WHERE user_id=?').run(error.code || error.errcode || 'PROVISIONING_PENDING', Date.now(), userId);
      throw error;
    }
  }

  async register(input = {}, { clientIp } = {}) {
    accountInput(input);
    if (!this.registration().enabled) throw failure(403, this.mode === 'closed' ? 'Registration is closed on this server' : 'This server has no account registration configuration');
    const localpart = this.normalizeUsername(input.username);
    const password = this.password(input.password);
    const name = this.displayName(input.displayName ?? localpart);
    const userId = `@${localpart}:${this.serverName}`;
    const hash = createHmac('sha256', this.registrationSecret).update(JSON.stringify([localpart, name, password])).digest('hex');
    const previous = this.row(userId);
    if (['disabled', 'deactivated'].includes(previous?.status)) throw failure(403, 'This account is disabled');
    if (previous && (previous.kind !== 'human' || previous.registration_hash !== hash || previous.status === 'active' || previous.last_error === 'ACCOUNT_EXISTS')) throw failure(409, 'This account name is already in use. Sign in to continue');
    if (!previous) this.db.prepare(`INSERT INTO accounts
      (user_id,localpart,name,kind,status,registration_hash,created_at,updated_at) VALUES (?,?,?,'human','provisioning',?,?,?)`)
      .run(userId, localpart, name, hash, Date.now(), Date.now());
    await this.serialize(userId, () => this.provision(userId, password, clientIp));
    return this.session(await this.passwordLogin(userId, password, false, clientIp));
  }

  async login(input = {}, { clientIp } = {}) {
    accountInput(input);
    const localpart = this.normalizeUsername(input.user);
    const password = this.password(input.password);
    const userId = `@${localpart}:${this.serverName}`;
    const previous = this.row(userId);
    if (previous?.kind === 'bot') throw failure(403, 'Sign in with a human account');
    if (['disabled', 'deactivated'].includes(previous?.status)) throw failure(403, 'This account is disabled');
    const session = await this.passwordLogin(userId, password, false, clientIp);
    try {
      await this.serialize(userId, async () => {
        const current = this.row(userId);
        if (!current || current.last_error === 'ACCOUNT_EXISTS') {
          const profile = await this.clientFactory(session.access_token).request('GET', `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`);
          this.db.prepare(`INSERT INTO accounts (user_id,localpart,name,kind,status,created_at,updated_at)
            VALUES (?,?,?,'human','provisioning',?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name`)
            .run(userId, localpart, profile.displayname || localpart, Date.now(), Date.now());
        }
        await this.ensureServiceSession(userId, password, clientIp);
        await this.joinInitialRoom(userId);
        await this.activate(userId);
      });
      return this.session(session);
    } catch (error) {
      await this.clientFactory(session.access_token).request('POST', '/_matrix/client/v3/logout', {}).catch(() => {});
      throw error;
    }
  }

  async me(token) {
    const { user_id: userId } = await this.authenticate(token);
    return { user: publicPerson(this.human(userId)), ownedBots: this.ownedBots(userId), identity: this.identity(userId),
      ...(this.home ? { home: this.home } : {}) };
  }

  async logout(token) {
    // Synthetic demo credentials are also the Core service credential. They are never revoked here.
    if (this.setup.participants.some(person => person.accessToken === token)) return { loggedOut: true, localOnly: true };
    try { await this.clientFactory(token).request('POST', '/_matrix/client/v3/logout', {}); }
    catch (error) { if (error.status !== 401) throw error; }
    return { loggedOut: true };
  }

  async createBot(userId, input = {}) {
    accountInput(input);
    this.human(userId);
    if (!this.registrationSecret) throw failure(503, 'This server has no Bot account registration configuration');
    const name = this.displayName(input.name);
    const requestId = input.requestId ?? randomUUID();
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(requestId)) throw failure(400, 'Invalid Bot creation request ID');
    const key = JSON.stringify([userId, requestId]);
    const hash = createHash('sha256').update(name).digest('hex');
    let request = this.db.prepare('SELECT * FROM bot_creation_requests WHERE request_key=?').get(key);
    if (request && request.input_hash !== hash) throw failure(409, 'This Bot creation request belongs to another name');
    if (!request) {
      const localpart = `bot-${randomUUID()}`;
      const botId = `@${localpart}:${this.serverName}`;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare(`INSERT INTO accounts
          (user_id,localpart,name,kind,owner_id,status,recovery_password,created_at,updated_at) VALUES (?,?,?,'bot',?,'provisioning',?,?,?)`)
          .run(botId, localpart, name, userId, randomBytes(32).toString('base64url'), Date.now(), Date.now());
        this.db.prepare('INSERT INTO bot_creation_requests VALUES (?,?,?)').run(key, hash, botId);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      request = { user_id: botId };
    }
    const row = this.row(request.user_id);
    if (row.status === 'active') return publicPerson(this.person(row.user_id));
    const person = await this.serialize(row.user_id, () => this.provision(row.user_id, row.recovery_password));
    return publicPerson(person);
  }

  close() { this.db?.close(); this.db = null; }
}
