import { randomBytes } from 'node:crypto';
import { chmod, chown, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  };
}

export async function initializeServer(options = serverOptions(), { containerOwnership = process.getuid?.() === 0 } = {}) {
  const { dataRoot, synapseRoot, serverName, homeserverUrl, publicUrl, publicHomeserverUrl } = options;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(synapseRoot, { recursive: true, mode: 0o700 });
  const metadataPath = path.join(dataRoot, 'server.json');
  const previous = await readOptionalJson(metadataPath);
  if (previous && previous.serverName !== serverName) {
    throw new Error(`Existing Matrix identity is ${previous.serverName}; restore DS_GROUP_SERVER_NAME before starting`);
  }
  const metadata = previous || {
    schemaVersion: 1, serverName, createdAt: new Date().toISOString(),
    registrationSecret: randomBytes(48).toString('hex'),
    macaroonSecret: randomBytes(48).toString('hex'), formSecret: randomBytes(48).toString('hex'),
  };
  if (metadata.schemaVersion !== 1) throw new Error('Unsupported server metadata version');
  Object.assign(metadata, { homeserverUrl, publicUrl, publicHomeserverUrl });
  await savePrivateJson(metadataPath, metadata);
  const corePath = path.join(dataRoot, 'core-config.json');
  const core = await readOptionalJson(corePath) || {
    nodeSecret: randomBytes(32).toString('hex'), modelCallLimit: null, maxOutputTokens: 8192, demoLogin: false,
  };
  core.publicUrl = publicUrl;
  await savePrivateJson(corePath, core);
  const configPath = path.join(synapseRoot, 'homeserver.yaml');
  // JSON is valid YAML and keeps environment values out of the YAML grammar.
  const synapse = {
    server_name: serverName, public_baseurl: `${publicHomeserverUrl}/`, pid_file: '/data/homeserver.pid',
    listeners: [{ port: 8008, tls: false, type: 'http', x_forwarded: true, bind_addresses: ['0.0.0.0'],
      resources: [{ names: ['client'], compress: false }] }],
    database: { name: 'sqlite3', args: { database: '/data/homeserver.db' } },
    media_store_path: '/data/media_store', signing_key_path: '/data/signing.key',
    registration_shared_secret: metadata.registrationSecret,
    macaroon_secret_key: metadata.macaroonSecret, form_secret: metadata.formSecret,
    report_stats: false, enable_registration: false, federation_domain_whitelist: [], trusted_key_servers: [],
    suppress_key_server_warning: true, rc_message: { per_second: 100, burst_count: 200 },
  };
  await savePrivateJson(configPath, synapse);
  if (containerOwnership) {
    for (const filename of [dataRoot, synapseRoot, metadataPath, corePath, configPath]) await chown(filename, 1000, 1000);
  }
  return { serverName, publicUrl, publicHomeserverUrl, reused: Boolean(previous) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await initializeServer()));
}
