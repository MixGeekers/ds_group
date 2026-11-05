import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const IDENTITY_CONTRACT_VERSION = '1.0.1';
const fail = message => { throw new Error(message); };
const forbidden = message => Object.assign(new Error(message), { status: 403, code: 'CLIENT_ORIGIN_DENIED' });

export function identityOrigin(value, name, { secure = true } = {}) {
  let url;
  try { url = new URL(value); } catch { fail(`${name} must be an HTTP(S) origin`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail(`${name} must be an HTTP(S) origin without credentials, path, query or fragment`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (secure && url.protocol !== 'https:' && !loopback) fail(`${name} requires HTTPS except on loopback`);
  return url.origin;
}

export function validateIdentityOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('identity configuration must be an object');
  const { mode = 'standalone', coreUrl, matrixUrl, clientOrigins = [] } = value;
  if (!['central', 'standalone'].includes(mode)) fail('identity.mode must be central or standalone');
  if (!Array.isArray(clientOrigins) || clientOrigins.length > 32) fail('identity.clientOrigins must be an array of at most 32 origins');
  return { mode,
    ...(coreUrl === undefined ? {} : { coreUrl: identityOrigin(coreUrl, 'identity.coreUrl', { secure: mode === 'central' }) }),
    ...(matrixUrl === undefined ? {} : { matrixUrl: identityOrigin(matrixUrl, 'identity.matrixUrl', { secure: mode === 'central' }) }),
    clientOrigins: [...new Set(clientOrigins.map(origin => identityOrigin(origin, 'identity.clientOrigins')))].sort() };
}

/** Public discovery and browser-origin policy, independent of the static client bundle. */
export class IdentityService {
  constructor({ accounts, setup, config, dataRoot }) { Object.assign(this, { accounts, setup, config, dataRoot }); }

  async initialize() {
    const filename = path.join(this.dataRoot, 'identity-config.json');
    let stored;
    try { stored = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stored && (stored.schemaVersion !== 1 || stored.authorityId !== this.accounts.authorityId)) {
      fail('Restore identity-config.json and accounts.sqlite from the same identity authority');
    }
    const serverName = this.accounts.serverName || null;
    if (stored?.serverName && stored.serverName !== serverName) fail('The default Matrix home cannot change in an existing identity authority');
    const selected = validateIdentityOptions(this.config.identity ?? stored?.options ?? {});
    const coreUrl = selected.coreUrl ?? (this.config.publicUrl ? identityOrigin(this.config.publicUrl, 'publicUrl', { secure: selected.mode === 'central' }) : null);
    const matrixUrl = selected.matrixUrl ?? identityOrigin(this.setup.publicHomeserverUrl || this.setup.homeserverUrl, 'public Matrix URL', { secure: selected.mode === 'central' });
    if (selected.mode === 'central' && (!serverName || !coreUrl)) fail('Central identity requires a Matrix server name and explicit public Core/Matrix URLs');
    if (selected.mode === 'central' && !this.setup.publicHomeserverUrl && !selected.matrixUrl) fail('Central identity requires an explicit public Matrix URL');
    this.options = { ...selected, ...(coreUrl ? { coreUrl } : {}), matrixUrl };
    this.home = { serverName, coreUrl, matrixUrl };
    this.accounts.home = this.home;
    if (selected.mode === 'central') this.setup.publicHomeserverUrl = matrixUrl;
    const state = { schemaVersion: 1, authorityId: this.accounts.authorityId, serverName, options: this.options };
    if (JSON.stringify(state) !== JSON.stringify(stored)) {
      const temporary = `${filename}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, filename);
    }
    await chmod(filename, 0o600);
    return this;
  }

  discovery() {
    return { schemaVersion: 1, contractVersion: IDENTITY_CONTRACT_VERSION, name: 'DSCord', mode: this.options.mode,
      authorityId: this.accounts.authorityId, home: this.home,
      auth: { mode: 'matrix-password', loginPath: '/api/login', registerPath: '/api/register', mePath: '/api/me', logoutPath: '/api/logout', cookieCredentials: false },
      credentials: { type: 'matrix-access-token', coreOrigin: this.home.coreUrl, matrixOrigin: this.home.matrixUrl, remoteCore: 'forbidden', deploymentAdmin: 'forbidden' } };
  }

  cors(request, response, pathname) {
    const publicDiscovery = ['/.well-known/dscord/client', '/.well-known/matrix/client', '/api/client-config', '/api/bootstrap'].includes(pathname);
    if (publicDiscovery && ['GET', 'OPTIONS'].includes(request.method)) {
      if (request.headers.authorization || request.headers.cookie) throw forbidden('Public discovery requires omitted credentials');
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (request.method === 'OPTIONS') response.setHeader('Access-Control-Allow-Methods', 'GET');
      return;
    }
    if (!pathname.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (origin === undefined) return; // CLI/node callers still need their normal authentication.
    let normalized;
    try { normalized = identityOrigin(origin, 'Origin', { secure: false }); } catch { throw forbidden('Invalid client Origin'); }
    // Unconfigured legacy single-origin deployments keep their existing browser path.
    const localOrigins = !this.home.coreUrl && request.headers.host ? [`http://${request.headers.host}`, `https://${request.headers.host}`] : [];
    if (origin !== normalized || ![this.home.coreUrl, ...localOrigins, ...this.options.clientOrigins].includes(normalized)) {
      throw forbidden('This client origin is not allowed by the home server');
    }
    response.setHeader('Access-Control-Allow-Origin', normalized);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-Upload-Id');
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After, Content-Disposition, Content-Length, Content-Range');
    if (request.method === 'OPTIONS') {
      const method = request.headers['access-control-request-method'];
      const headers = request.headers['access-control-request-headers']?.toLowerCase().split(',').map(value => value.trim()) || [];
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method) || headers.some(header => !['authorization', 'content-type', 'range', 'x-upload-id'].includes(header))) {
        throw forbidden('This cross-origin request method or header is not supported');
      }
    }
  }
}
