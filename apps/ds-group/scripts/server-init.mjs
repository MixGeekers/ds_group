import { randomBytes } from 'node:crypto';
import { chmod, chown, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Governance, privateJson } from '../src/governance.mjs';
import { synapseGovernanceConfig } from '../src/synapse-control.mjs';
import { parseArgs } from 'node:util';
import { parseWebMode } from '../src/web-mode.mjs';

export async function readOptionalJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
}

export async function savePrivateJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
  await chmod(filename, 0o600);
}

function validateMediaStorage(storage) {
  if (storage?.backend === 'local') return { backend: 'local' };
  if (storage?.backend !== 's3') throw new Error('DS_GROUP_MEDIA_BACKEND must be local or s3');
  if (typeof storage.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(storage.bucket) || storage.bucket.includes('..')) {
    throw new Error('DS_GROUP_S3_BUCKET must be a valid S3 bucket name');
  }
  if (typeof storage.accessKeyId !== 'string' || !storage.accessKeyId || typeof storage.secretAccessKey !== 'string' || !storage.secretAccessKey) {
    throw new Error('DS_GROUP_S3_ACCESS_KEY_ID and DS_GROUP_S3_SECRET_ACCESS_KEY are required together');
  }
  const region = storage.region || 'us-east-1';
  if (typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region)) throw new Error('DS_GROUP_S3_REGION must be a region identifier');
  if (storage.sessionToken !== undefined && typeof storage.sessionToken !== 'string') throw new Error('DS_GROUP_S3_SESSION_TOKEN must be a string');
  let endpointUrl;
  if (storage.endpointUrl) {
    let endpoint;
    try { endpoint = new URL(storage.endpointUrl); }
    catch { throw new Error('DS_GROUP_S3_ENDPOINT must be an HTTP(S) origin'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('DS_GROUP_S3_ENDPOINT must be an HTTP(S) origin');
    }
    endpointUrl = endpoint.origin;
  }
  const prefix = storage.prefix ?? 'dscord/';
  if (typeof prefix !== 'string' || prefix.startsWith('/') || prefix.includes('\\') || prefix.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('DS_GROUP_S3_PREFIX must be a relative object prefix without dot segments');
  }
  return { backend: 's3', bucket: storage.bucket, region, ...(endpointUrl ? { endpointUrl } : {}),
    prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
    accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey,
    ...(storage.sessionToken ? { sessionToken: storage.sessionToken } : {}) };
}

function mediaStorageOptions(env) {
  if (!env.DS_GROUP_MEDIA_BACKEND) return undefined;
  return validateMediaStorage({ backend: env.DS_GROUP_MEDIA_BACKEND, bucket: env.DS_GROUP_S3_BUCKET,
    endpointUrl: env.DS_GROUP_S3_ENDPOINT, region: env.DS_GROUP_S3_REGION, prefix: env.DS_GROUP_S3_PREFIX,
    accessKeyId: env.DS_GROUP_S3_ACCESS_KEY_ID, secretAccessKey: env.DS_GROUP_S3_SECRET_ACCESS_KEY,
    sessionToken: env.DS_GROUP_S3_SESSION_TOKEN });
}

export function serverOptions(env = process.env) {
  const serverName = env.DS_GROUP_SERVER_NAME || 'localhost';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?$/.test(serverName)) {
    throw new Error('DS_GROUP_SERVER_NAME must be a hostname with an optional port');
  }
  const normalizedUrl = (value, name) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error(`${name} must be an HTTP(S) origin`);
    }
    return url.origin;
  };
  return {
    dataRoot: path.resolve(env.DS_GROUP_DATA_DIR || '.local/server'),
    synapseRoot: path.resolve(env.DS_GROUP_SYNAPSE_DIR || '.local/server-synapse'),
    serverName,
    homeserverUrl: normalizedUrl(env.DS_GROUP_MATRIX_URL || 'http://synapse:8008', 'DS_GROUP_MATRIX_URL'),
    publicUrl: normalizedUrl(env.DS_GROUP_PUBLIC_URL || 'http://localhost:18100', 'DS_GROUP_PUBLIC_URL'),
    publicHomeserverUrl: normalizedUrl(env.DS_GROUP_MATRIX_PUBLIC_URL || 'http://localhost:18008', 'DS_GROUP_MATRIX_PUBLIC_URL'),
    mediaStorage: mediaStorageOptions(env),
    ...(env.DS_GROUP_WEB_MODE ? { webMode: parseWebMode(env.DS_GROUP_WEB_MODE) } : {}),
  };
}

export async function initializeServer(options = serverOptions(), { containerOwnership = process.getuid?.() === 0 } = {}) {
  const { dataRoot, synapseRoot, serverName, homeserverUrl, publicUrl, publicHomeserverUrl } = options;
  if (options.webMode !== undefined) parseWebMode(options.webMode);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(synapseRoot, { recursive: true, mode: 0o700 });
  const metadataPath = path.join(dataRoot, 'server.json');
  const previous = await readOptionalJson(metadataPath);
  if (previous && previous.serverName !== serverName) {
    throw new Error(`Existing Matrix identity is ${previous.serverName}; restore DS_GROUP_SERVER_NAME before starting`);
  }
  const governance = new Governance({ dataRoot, serverName });
  const policy = await governance.ensure();
  await copyFile(new URL('../deploy/synapse/dscord_guard.py', import.meta.url), path.join(synapseRoot, 'dscord_guard.py'));
  await privateJson(path.join(synapseRoot, 'governance.generated.yaml'), synapseGovernanceConfig(policy));
  const storagePath = path.join(dataRoot, 'media-storage.json');
  const storedStorage = await readOptionalJson(storagePath);
  const previousStorage = storedStorage && validateMediaStorage(storedStorage);
  const mediaStorage = validateMediaStorage(options.mediaStorage || previousStorage || { backend: 'local' });
  if (previousStorage?.backend === 's3' && ['backend', 'bucket', 'endpointUrl', 'prefix'].some(key => mediaStorage[key] !== previousStorage[key])) {
    throw new Error('Changing an existing S3 media destination requires an explicit migration');
  }
  const corePath = path.join(dataRoot, 'core-config.json');
  const core = await readOptionalJson(corePath) || {
    nodeSecret: randomBytes(32).toString('hex'), modelCallLimit: null, maxOutputTokens: 8192, demoLogin: false,
  };
  core.webMode = parseWebMode(options.webMode ?? core.webMode);
  core.publicUrl = publicUrl;
  const metadata = previous || {
    schemaVersion: 1, serverName, createdAt: new Date().toISOString(),
    registrationSecret: randomBytes(48).toString('hex'),
    macaroonSecret: randomBytes(48).toString('hex'), formSecret: randomBytes(48).toString('hex'),
  };
  if (metadata.schemaVersion !== 1) throw new Error('Unsupported server metadata version');
  Object.assign(metadata, { homeserverUrl, publicUrl, publicHomeserverUrl });
  await savePrivateJson(metadataPath, metadata);
  await savePrivateJson(corePath, core);
  const configPath = path.join(synapseRoot, 'homeserver.yaml');
  // JSON is valid YAML and keeps environment values out of the YAML grammar.
  const synapse = {
    server_name: serverName, public_baseurl: `${publicHomeserverUrl}/`, pid_file: '/data/homeserver.pid',
    listeners: [{ port: 8008, tls: false, type: 'http', x_forwarded: true, bind_addresses: ['0.0.0.0'],
      resources: [{ names: ['client', 'federation'], compress: false }] }],
    database: { name: 'sqlite3', args: { database: '/data/homeserver.db' } },
    media_store_path: '/data/media_store', signing_key_path: '/data/signing.key',
    registration_shared_secret: metadata.registrationSecret,
    macaroon_secret_key: metadata.macaroonSecret, form_secret: metadata.formSecret,
    report_stats: false, enable_registration: false, federation_domain_whitelist: [], trusted_key_servers: [],
    suppress_key_server_warning: true, rc_message: { per_second: 100, burst_count: 200 },
    rc_login: {
      address: { per_second: 1, burst_count: 20 },
      account: { per_second: 0.003, burst_count: 5 },
      failed_attempts: { per_second: 0.17, burst_count: 3 },
    },
  };
  if (mediaStorage.backend === 's3') {
    synapse.media_storage_providers = [{ module: 's3_storage_provider.S3StorageProviderBackend',
      store_local: true, store_remote: true, store_synchronous: true,
      config: { bucket: mediaStorage.bucket, region_name: mediaStorage.region, prefix: mediaStorage.prefix,
        ...(mediaStorage.endpointUrl ? { endpoint_url: mediaStorage.endpointUrl } : {}),
        access_key_id: mediaStorage.accessKeyId, secret_access_key: mediaStorage.secretAccessKey,
        ...(mediaStorage.sessionToken ? { session_token: mediaStorage.sessionToken } : {}) } }];
  }
  // Persist the selected destination before publishing Synapse configuration so a retry can finish it.
  await savePrivateJson(storagePath, mediaStorage);
  await savePrivateJson(configPath, synapse);
  if (containerOwnership) {
    for (const filename of [dataRoot, synapseRoot, metadataPath, corePath, storagePath, configPath, governance.root, governance.filename,
      path.join(synapseRoot, 'dscord_guard.py'), path.join(synapseRoot, 'governance.generated.yaml')]) await chown(filename, 1000, 1000);
  }
  return { serverName, publicUrl, publicHomeserverUrl, mediaBackend: mediaStorage.backend, webMode: core.webMode, reused: Boolean(previous) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { values } = parseArgs({ options: { 'web-mode': { type: 'string' } } });
  const options = serverOptions();
  if (values['web-mode'] !== undefined) options.webMode = parseWebMode(values['web-mode']);
  console.log(JSON.stringify(await initializeServer(options)));
}
