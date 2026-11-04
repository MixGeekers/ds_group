import { randomUUID } from 'node:crypto';

export class MatrixError extends Error {
  constructor(status, errcode, message) {
    super(message);
    this.name = 'MatrixError';
    this.status = status;
    this.errcode = errcode;
  }
}

export class MatrixClient {
  constructor({ baseUrl, accessToken } = {}) {
    this.baseUrl = new URL(baseUrl).href.replace(/\/$/, '');
    this.accessToken = accessToken;
  }

  async request(method, path, body, { signal } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new Error('Matrix request paths must start with one slash');
    }
    const headers = { Accept: 'application/json' };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : AbortSignal.timeout(65_000),
    });
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new MatrixError(response.status, 'M_INVALID_RESPONSE', 'Matrix returned invalid JSON');
    }
    if (!response.ok) {
      throw new MatrixError(response.status, result.errcode ?? 'M_UNKNOWN', result.error ?? `Matrix HTTP ${response.status}`);
    }
    return result;
  }

  whoami() {
    return this.request('GET', '/_matrix/client/v3/account/whoami');
  }

  send(roomId, body, { transactionId = randomUUID(), to = [], replyTo, taskId, returnTo, kind, hop, originSenderId, originRoomId, originEventId } = {}) {
    if (typeof body !== 'string' || !body.trim()) throw new Error('A message needs non-empty text');
    if (!Array.isArray(to) || to.some(id => typeof id !== 'string')) throw new Error('Message recipients must be an array of member IDs');
    for (const value of [replyTo, taskId, returnTo, kind, originSenderId, originRoomId, originEventId]) {
      if (value !== undefined && (typeof value !== 'string' || !value)) throw new Error('Message references must be non-empty strings');
    }
    if (hop !== undefined && (!Number.isSafeInteger(hop) || hop < 0)) throw new Error('Message hop must be a non-negative integer');
    const content = {
      msgtype: 'm.text',
      body,
      'org.ds_group': {
        to,
        ...(replyTo ? { replyTo } : {}),
        ...(taskId ? { taskId } : {}),
        ...(returnTo ? { returnTo } : {}),
        ...(kind ? { kind } : {}),
        ...(hop === undefined ? {} : { hop }),
        ...(originSenderId ? { originSenderId } : {}),
        ...(originRoomId ? { originRoomId } : {}),
        ...(originEventId ? { originEventId } : {}),
      },
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

  static login(baseUrl, user, password) {
    return new MatrixClient({ baseUrl }).request('POST', '/_matrix/client/v3/login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      device_id: 'DS_GROUP_FRAMEWORK',
      initial_device_display_name: 'DS-Group framework',
    });
  }
}
