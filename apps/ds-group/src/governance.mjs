import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const FILE_TOOLS = ['read', 'write', 'edit', 'read_image'];
export const policyError = (status, message) => Object.assign(new Error(message), { status });
export const serverOf = id => typeof id === 'string' && id.startsWith('@') && id.includes(':') ? id.slice(id.indexOf(':') + 1) : undefined;
export function serverName(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?$/.test(value)
    || value.includes('..') || value.endsWith('.') || (value.includes(':') && Number(value.split(':')[1]) > 65535)) throw policyError(400, 'Invalid Matrix server name');
  return value;
}
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw policyError(400, `Invalid ${name}`);
  return value;
}
function identity(value) {
  text(value, 'full Matrix identity', 512);
  if (!/^@[^:\s]+:/.test(value)) throw policyError(400, 'Use a full Matrix identity');
  serverName(serverOf(value));
  return value;
}
function list(value, validate, name) {
  if (!Array.isArray(value) || value.length > 500) throw policyError(400, `Invalid ${name}`);
  const result = value.map(validate);
  if (new Set(result).size !== result.length) throw policyError(400, `Duplicate ${name}`);
  return result;
}
function unique(rows, key) {
  if (new Set(rows.map(row => row[key])).size !== rows.length) throw policyError(400, `Duplicate ${key}`);
  return rows;
}
const enabled = value => { if (typeof value !== 'boolean') throw policyError(400, 'enabled must be a boolean'); return value; };
const tools = value => list(value, tool => {
  if (!FILE_TOOLS.includes(tool)) throw policyError(400, 'Cross-server work supports scoped file tools only');
  return tool;
}, 'tools');

export function emptyPolicy(domain) {
  return { schemaVersion: 1, serverName: serverName(domain), revision: 0, partners: [], members: [], rooms: [], botPolicies: [],
    settings: { registrationMode: null, maxUploadBytes: null } };
}

export function validatePolicy(value, domain) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || value.serverName !== domain
    || !Number.isSafeInteger(value.revision) || value.revision < 0) throw policyError(400, 'Policy identity or revision is invalid');
  const rows = (input, convert, key) => {
    if (!Array.isArray(input) || input.length > 500) throw policyError(400, `Invalid ${key} list`);
    return unique(input.map(convert), key);
  };
  const partners = rows(value.partners, row => {
    const domainName = serverName(row.serverName);
    if (domainName === domain) throw policyError(400, 'A server cannot be its own partner');
    let publicUrl;
    if (row.publicUrl) {
      const url = new URL(row.publicUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw policyError(400, 'Invalid partner public origin');
      publicUrl = url.origin;
    }
    return { serverName: domainName, name: text(row.name, 'partner name'), enabled: enabled(row.enabled), ...(publicUrl ? { publicUrl } : {}) };
  }, 'serverName');
  const members = rows(value.members, row => {
    const id = identity(row.id);
    if (serverOf(id) === domain || !['human', 'bot'].includes(row.kind)) throw policyError(400, 'Admission is for external humans or Bots');
    return { id, name: text(row.name, 'member name'), kind: row.kind, enabled: enabled(row.enabled),
      ...(row.kind === 'bot' && row.ownerId ? { ownerId: identity(row.ownerId) } : {}) };
  }, 'id');
  const rooms = rows(value.rooms, row => {
    const roomId = text(row.roomId, 'room ID', 512);
    if (!roomId.startsWith('!') || /\s/.test(roomId)) throw policyError(400, 'Use a full Matrix room ID');
    return { roomId, authority: serverName(row.authority), name: text(row.name, 'room name'), enabled: enabled(row.enabled),
      memberIds: list(row.memberIds, identity, 'room members'), tools: tools(row.tools || []),
      botIds: list(row.botIds || [], identity, 'room Bots') };
  }, 'roomId');
  const botPolicies = rows(value.botPolicies, row => ({ botId: identity(row.botId), enabled: enabled(row.enabled),
    roomIds: list(row.roomIds, id => text(id, 'room ID', 512), 'Bot rooms'),
    requesterIds: list(row.requesterIds, identity, 'Bot requesters'), tools: tools(row.tools), canDelegate: enabled(row.canDelegate),
  }), 'botId');
  const settings = value.settings || {};
  if (![null, 'open', 'closed'].includes(settings.registrationMode)) throw policyError(400, 'Invalid registration mode');
  if (settings.maxUploadBytes !== null && (!Number.isSafeInteger(settings.maxUploadBytes) || settings.maxUploadBytes < 1024 || settings.maxUploadBytes > 52428800)) throw policyError(400, 'Upload limit must be between 1 KiB and 50 MiB');
  return { schemaVersion: 1, serverName: domain, revision: value.revision, partners, members, rooms, botPolicies,
    settings: { registrationMode: settings.registrationMode, maxUploadBytes: settings.maxUploadBytes } };
}

export async function privateJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, filename);
  await chmod(filename, 0o600);
}

/** Single admin writer. Revision CAS prevents stale browser edits; readers fail closed on corrupt policy. */
export class Governance {
  constructor({ dataRoot, serverName: domain, governanceRoot = process.env.DS_GROUP_GOVERNANCE_DIR }) { this.domain = domain; this.root = governanceRoot || path.join(dataRoot, 'governance'); this.filename = path.join(this.root, 'policy.json'); this.writing = Promise.resolve(); }
  async read() {
    try { return validatePolicy(JSON.parse(await readFile(this.filename, 'utf8')), this.domain); }
    catch (error) { if (error.code === 'ENOENT') return emptyPolicy(this.domain); throw error; }
  }
  async save(input, afterSave) {
    const operation = this.writing.catch(() => {}).then(async () => {
      const current = await this.read();
      if (input.revision !== current.revision) throw policyError(409, 'Policy changed; reload before saving');
      const next = validatePolicy({ ...input, revision: current.revision + 1 }, this.domain);
      await privateJson(this.filename, next);
      if (afterSave) await afterSave(next, current);
      return next;
    });
    this.writing = operation;
    return operation;
  }
  async ensure() { const policy = await this.read(); try { await readFile(this.filename); } catch (e) { if (e.code !== 'ENOENT') throw e; await privateJson(this.filename, policy); } return policy; }
  async admittedParticipants() {
    const policy = await this.read();
    return policy.members.filter(row => admitted(policy, row.id)).map(row => ({ ...row, localpart: row.id.slice(1, row.id.indexOf(':')), homeServer: serverOf(row.id) }));
  }
}

export const partnersOf = policy => policy.partners.filter(row => row.enabled).map(row => row.serverName).sort();
export function admitted(policy, id) {
  return serverOf(id) === policy.serverName || partnersOf(policy).includes(serverOf(id)) && policy.members.some(row => row.id === id && row.enabled);
}
export function roomAllows(policy, roomId, id) {
  const rule = policy.rooms.find(row => row.roomId === roomId);
  if (!rule?.enabled || !admitted(policy, id)) return false;
  return rule.memberIds.includes(id) || serverOf(id) === policy.serverName && rule.authority === policy.serverName;
}
export function roomAcl(policy, rule) {
  return { allow_ip_literals: false, allow: [policy.serverName, ...(rule.enabled ? [...new Set(rule.memberIds.filter(id => admitted(policy, id)).map(serverOf))].filter(domain => domain !== policy.serverName) : [])].sort(), deny: [] };
}
