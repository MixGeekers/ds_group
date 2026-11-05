import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export class MatrixError extends Error {
  constructor(status, errcode, message, retryAfterMs) {
    super(message);
    this.name = 'MatrixError';
    this.status = status;
    this.errcode = errcode;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

function retryDelay(response, result) {
  if (typeof result.retry_after_ms === 'number' && Number.isFinite(result.retry_after_ms) && result.retry_after_ms >= 0) {
    return Math.ceil(result.retry_after_ms);
  }
  const header = response.headers.get('Retry-After');
  if (!header?.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(header.trim())) {
    const milliseconds = Math.ceil(Number(header) * 1000);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  const deadline = Date.parse(header);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : undefined;
}

async function jsonResult(response) {
  let result;
  try {
    const text = await response.text();
    result = text ? JSON.parse(text) : {};
  } catch {
    throw new MatrixError(response.status, 'M_INVALID_RESPONSE', 'Matrix returned invalid JSON');
  }
  if (!response.ok) throw new MatrixError(response.status, result.errcode ?? 'M_UNKNOWN', result.error ?? `Matrix HTTP ${response.status}`, retryDelay(response, result));
  return result;
}

export class MatrixClient {
  constructor({ baseUrl, accessToken } = {}) {
    this.baseUrl = new URL(baseUrl).href.replace(/\/$/, '');
    this.accessToken = accessToken;
  }

  async request(method, path, body, { signal, clientIp } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error('Matrix request paths must start with one slash');
    }
    const headers = { Accept: 'application/json' };
    if (clientIp !== undefined) {
      if (typeof clientIp !== 'string' || !isIP(clientIp)) throw new Error('Invalid client IP address');
      headers['X-Forwarded-For'] = clientIp;
    }
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      redirect: 'error',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
    });
    return jsonResult(response);
  }

  whoami() {
    return this.request('GET', '/_matrix/client/v3/account/whoami');
  }

  uploadMedia(body, { filename, mimeType = 'application/octet-stream', size, signal } = {}) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Matrix media upload needs its exact byte length');
    const query = new URLSearchParams({ filename });
    return fetch(`${this.baseUrl}/_matrix/media/v3/upload?${query}`, {
      method: 'POST', body, duplex: 'half', redirect: 'error',
      headers: { 'Content-Type': mimeType, 'Content-Length': String(size), Authorization: `Bearer ${this.accessToken}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    }).then(jsonResult);
  }

  async downloadMedia(contentUri, { signal, range } = {}) {
    const match = typeof contentUri === 'string' && contentUri.match(/^mxc:\/\/([^/?#]+)\/([^/?#]+)$/);
    if (!match) throw new Error('Invalid Matrix media URI');
    const route = `/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
    const response = await fetch(`${this.baseUrl}${route}`, {
      redirect: 'error',
      headers: { Authorization: `Bearer ${this.accessToken}`, ...(range ? { Range: range } : {}) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
    if (!response.ok) await jsonResult(response);
    return response;
  }

  send(roomId, body, { transactionId = randomUUID(), to = [], replyTo, taskId, returnTo, kind, hop, originSenderId, originRoomId, originEventId,
    attachments = [], mentions, mMentions, replyMention, fileBatch, delivery, conversationKind } = {}) {
    if (typeof body !== 'string' || (!body.trim() && !attachments.length)) throw new Error('A message needs text or an attachment');
    if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some(file => !file || typeof file.id !== 'string'
      || typeof file.name !== 'string' || typeof file.contentUri !== 'string' || !file.contentUri.startsWith('mxc://')
      || typeof file.mimeType !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))) {
      throw new Error('Invalid message attachments');
    }
    if (!Array.isArray(to) || to.some(id => typeof id !== 'string')) throw new Error('Message recipients must be an array of member IDs');
    for (const value of [replyTo, taskId, returnTo, kind, originSenderId, originRoomId, originEventId]) {
      if (value !== undefined && (typeof value !== 'string' || !value)) throw new Error('Message references must be non-empty strings');
    }
    if (hop !== undefined && (!Number.isSafeInteger(hop) || hop < 0)) throw new Error('Message hop must be a non-negative integer');
    if (conversationKind !== undefined && !['direct', 'group'].includes(conversationKind)) throw new Error('Invalid conversation kind');
    if (fileBatch !== undefined && (!fileBatch || typeof fileBatch.id !== 'string' || !fileBatch.id
      || !Number.isSafeInteger(fileBatch.index) || !Number.isSafeInteger(fileBatch.total)
      || fileBatch.index < 1 || fileBatch.total < fileBatch.index || fileBatch.total > 100)) throw new Error('Invalid attachment batch');
    const content = {
      msgtype: attachments.length ? (attachments[0].mimeType.startsWith('image/') ? 'm.image' : 'm.file') : 'm.text',
      body: body.trim() ? body : attachments.map(file => file.name).join(', '),
      ...(attachments.length ? { filename: attachments[0].name, url: attachments[0].contentUri,
        info: { mimetype: attachments[0].mimeType, size: attachments[0].size } } : {}),
      'org.ds_group': {
        to,
        ...(attachments.length ? { attachments } : {}),
        ...(mentions !== undefined ? { mentions } : {}),
        ...(replyMention !== undefined ? { replyMention } : {}),
        ...(fileBatch !== undefined ? { fileBatch: { id: fileBatch.id, index: fileBatch.index, total: fileBatch.total } } : {}),
        ...(delivery !== undefined ? { delivery } : {}),
        ...(conversationKind !== undefined ? { conversationKind } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(taskId ? { taskId } : {}),
        ...(returnTo ? { returnTo } : {}),
        ...(kind ? { kind } : {}),
        ...(hop === undefined ? {} : { hop }),
        ...(originSenderId ? { originSenderId } : {}),
        ...(originRoomId ? { originRoomId } : {}),
        ...(originEventId ? { originEventId } : {}),
      },
      ...(mMentions !== undefined ? { 'm.mentions': mMentions } : {}),
      ...(replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo } } } : {}),
    };
    return this.request('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`, content);
  }

  async timeline(roomId, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Timeline limit must be between 1 and 1000');
    const result = await this.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`);
    return [...(result.chunk ?? [])].reverse();
  }

  sync({ since, timeout = 0, signal } = {}) {
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 60_000) throw new Error('Sync timeout must be between 0 and 60000 milliseconds');
    const query = new URLSearchParams({ timeout: String(timeout) });
    if (since) query.set('since', since);
    return this.request('GET', `/_matrix/client/v3/sync?${query}`, undefined, { signal });
  }

  join(roomId) {
    return this.request('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {});
  }

  createRoom(options) {
    return this.request('POST', '/_matrix/client/v3/createRoom', options);
  }

  static login(baseUrl, user, password, { deviceId = `DSCORD_${randomUUID()}`, deviceName = 'DSCord', clientIp } = {}) {
    return new MatrixClient({ baseUrl }).request('POST', '/_matrix/client/v3/login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      device_id: deviceId,
      initial_device_display_name: deviceName,
    }, { clientIp });
  }
}
