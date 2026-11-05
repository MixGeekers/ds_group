// Verification fixture only. The real client implements its own TS session transport.
const error = (message, code = 'INVALID_HOME') => Object.assign(new Error(message), { code });
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw error('Invalid home origin'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw error('Invalid home origin');
  if (url.protocol !== 'https:' && !['localhost', '[::1]'].includes(url.hostname) && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)) throw error('Home connections require HTTPS except on loopback');
  return url.origin;
}

export function parseHomeDiscovery(value, sourceUrl) {
  const source = new URL(sourceUrl);
  const sourceOrigin = origin(source.origin);
  if (value?.schemaVersion !== 1 || !['1.0.0', '1.0.1'].includes(value.contractVersion) || !['central', 'standalone'].includes(value.mode) ||
    typeof value.authorityId !== 'string' || !value.authorityId.startsWith('urn:uuid:') ||
    typeof value.home?.serverName !== 'string' || !value.home.serverName || value.auth?.mode !== 'matrix-password' ||
    value.auth.cookieCredentials !== false || value.credentials?.type !== 'matrix-access-token') throw error('Unsupported home discovery');
  const home = { serverName: value.home.serverName,
    coreUrl: value.mode === 'standalone' && value.home.coreUrl === null ? sourceOrigin : origin(value.home.coreUrl),
    matrixUrl: origin(value.home.matrixUrl) };
  if ((value.credentials.coreOrigin !== null && value.credentials.coreOrigin !== home.coreUrl) || value.credentials.matrixOrigin !== home.matrixUrl ||
    value.credentials.remoteCore !== 'forbidden' || value.credentials.deploymentAdmin !== 'forbidden') throw error('Inconsistent credential destinations');
  return Object.freeze({ authorityId: value.authorityId, home: Object.freeze(home) });
}

async function result(response) {
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status, code: value.code });
  return value;
}

export async function discoverHome(coreUrl, { fetchImpl = globalThis.fetch } = {}) {
  const base = origin(coreUrl);
  const response = await fetchImpl(`${base}/.well-known/dscord/client`, { credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
  return result(response);
}

export class HomeSession {
  #pinned;
  #session;
  #fetch;
  constructor(discovery, sourceUrl, { fetchImpl = globalThis.fetch } = {}) {
    this.#pinned = parseHomeDiscovery(discovery, sourceUrl);
    this.#fetch = fetchImpl.bind(globalThis);
  }
  get home() { return this.#pinned.home; }
  get authorityId() { return this.#pinned.authorityId; }

  restore(value) {
    if (!value || typeof value.access_token !== 'string' || !value.access_token ||
      typeof value.user_id !== 'string' || !value.user_id.startsWith('@') || !value.user_id.endsWith(`:${this.home.serverName}`) ||
      value.identity?.authorityId !== this.authorityId || value.identity.matrixUserId !== value.user_id || value.identity.kind !== 'human' ||
      typeof value.identity.subjectId !== 'string' ||
      (value.home?.coreUrl !== null && value.home?.coreUrl !== this.home.coreUrl) || value.home?.matrixUrl !== this.home.matrixUrl || value.home?.serverName !== this.home.serverName) {
      throw error('This session belongs to another home identity', 'SESSION_HOME_MISMATCH');
    }
    if (value.expiresAt !== undefined && (!Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now())) throw error('Sign in again: the session expired', 'SESSION_EXPIRED');
    this.#session = structuredClone({ ...value, home: this.home });
    return this.export();
  }
  export() { return this.#session ? structuredClone(this.#session) : null; }

  async #password(path, input) {
    const session = await result(await this.#fetch(this.home.coreUrl + path, {
      method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }));
    if (session.expires_in_ms !== undefined && (!Number.isFinite(session.expires_in_ms) || session.expires_in_ms <= 0)) throw error('Invalid session expiry');
    return this.restore({ ...session, ...(session.expires_in_ms === undefined ? {} : { expiresAt: Date.now() + session.expires_in_ms }) });
  }
  login(input) { return this.#password('/api/login', input); }
  register(input) { return this.#password('/api/register', input); }

  async #request(path, options, matrix) {
    const base = matrix ? this.home.matrixUrl : this.home.coreUrl;
    if (typeof path !== 'string' || path.includes('\\') || /[\r\n]/.test(path) ||
      !(matrix ? /^\/_matrix\/(client|media)\//.test(path) : path.startsWith('/api/'))) throw error('Credential target must be a home API path', 'CREDENTIAL_TARGET_DENIED');
    const url = new URL(path, base);
    if (url.origin !== base || !(matrix ? /^\/_matrix\/(client|media)\//.test(url.pathname) : url.pathname.startsWith('/api/'))) throw error('Credential target must be a home API path', 'CREDENTIAL_TARGET_DENIED');
    if (!this.#session || (this.#session.expiresAt !== undefined && this.#session.expiresAt <= Date.now())) throw error('Sign in again', 'SESSION_EXPIRED');
    const headers = new Headers(options?.headers);
    headers.set('Authorization', `Bearer ${this.#session.access_token}`);
    return this.#fetch(url.href, { ...options, headers, credentials: 'omit', redirect: 'error' });
  }
  request(path, options) { return this.#request(path, options, false); }
  matrixRequest(path, options) { return this.#request(path, options, true); }
  async me() { return result(await this.request('/api/me')); }
  async logout() {
    if (!this.#session) return { loggedOut: true };
    try { return await result(await this.request('/api/logout', { method: 'POST' })); }
    finally { this.#session = null; }
  }
}
