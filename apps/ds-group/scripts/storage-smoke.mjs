#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCore } from '../src/core.mjs';
import { packageRoot } from '../src/paths.mjs';
import { bootstrapServer } from './server-bootstrap.mjs';
import { initializeServer, serverOptions } from './server-init.mjs';

// This smoke owns synthetic local storage only, regardless of the caller's cloud configuration.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DS_GROUP_')) delete process.env[key];
}
const execute = promisify(execFile);
const rcloneImage = 'rclone/rclone:1.75.2@sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5';
const synapseImage = 'dscord-storage-synapse:1.164.2-1.7.0';
const names = { rclone: 'dscord-storage-rclone', synapse: 'dscord-storage-synapse', network: 'dscord-storage-network' };
const matrixUrl = 'http://127.0.0.1:22408';
const coreUrl = 'http://127.0.0.1:22400';
const base = path.join(packageRoot, '.local', 'storage-smoke');
await mkdir(base, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(base, 'run-'));
const secrets = [randomBytes(16).toString('hex'), randomBytes(32).toString('hex')];
const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value));
const created = [];
let networkCreated = false;
let core;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
  level: 'real-core-matrix-s3-protocol-local-remote', platform: `${process.platform}/${process.arch}`,
  versions: { synapse: '1.164.2', provider: '1.7.0', rclone: '1.75.2' },
  modelCalls: 0, cloudAccountCalls: 0, checks: [],
  mediaSourceSha256: createHash('sha256').update(await readFile(new URL('../src/media.mjs', import.meta.url))).digest('hex'),
  scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') };

async function docker(args) {
  try {
    return (await execute('docker', args, { cwd: packageRoot, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    throw new Error(redact(`Docker ${args[0]} failed (${error.code}): ${error.stderr || 'no diagnostics'}`));
  }
}

async function freePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}

async function waitFor(url, accepts = response => response.ok) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      await response.arrayBuffer();
      if (accepts(response)) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Service did not become ready at ${url}`);
}

async function createContainer(name, args) {
  await docker(['create', '--name', name, '--network', names.network, ...args]);
  created.push(name);
  await docker(['start', name]);
}

async function request(route, { token, body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  return fetch(`${coreUrl}${route}`, { method, headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(120_000) });
}

async function jsonRequest(route, body, token) {
  const response = await request(route, { token, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(response.status, 200, `${route} returned HTTP ${response.status}`);
  return response.json();
}

async function filesIn(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

try {
  const existing = (await docker(['ps', '--all', '--format', '{{.Names}}'])).split('\n');
  assert.ok(![names.rclone, names.synapse].some(name => existing.includes(name)), 'Storage smoke container name is already in use');
  const networks = (await docker(['network', 'ls', '--format', '{{.Name}}'])).split('\n');
  assert.ok(!networks.includes(names.network), 'Storage smoke network name is already in use');
  for (const port of [22300, 22400, 22408]) await freePort(port);
  await docker(['build', '--file', 'deploy/storage/Dockerfile.synapse-s3', '--tag', synapseImage, '.']);
  await docker(['pull', rcloneImage]);
  report.images = JSON.parse(await docker(['image', 'inspect', synapseImage, rcloneImage])).map(image => ({ id: image.Id, digests: image.RepoDigests, architecture: image.Architecture }));
  const objectRoot = path.join(directory, 'objects');
  await mkdir(path.join(objectRoot, 'dscord-media'), { recursive: true, mode: 0o700 });
  const authFile = path.join(directory, 'rclone.env');
  await writeFile(authFile, `RCLONE_AUTH_KEY="${secrets[0]},${secrets[1]}"\n`, { mode: 0o600 });
  await docker(['network', 'create', names.network]);
  networkCreated = true;
  await createContainer(names.rclone, ['--user', '0:0', '--env-file', authFile,
    '--mount', `type=bind,source=${objectRoot},target=/objects`, '--publish', '127.0.0.1:22300:8080',
    rcloneImage, 'serve', 's3', '/objects', '--addr', ':8080', '--vfs-cache-mode', 'off', '--log-level', 'INFO']);
  assert.match(await docker(['exec', names.rclone, 'rclone', 'version']), /^rclone v1\.75\.2\n/);
  report.checks.push('fixedImagesAndProviderImport');
  await waitFor('http://127.0.0.1:22300/', response => [400, 401, 403].includes(response.status));
  const env = { DS_GROUP_DATA_DIR: path.join(directory, 'core'), DS_GROUP_SYNAPSE_DIR: path.join(directory, 'matrix'),
    DS_GROUP_SERVER_NAME: 'dscord-storage.local', DS_GROUP_MATRIX_URL: matrixUrl,
    DS_GROUP_PUBLIC_URL: coreUrl, DS_GROUP_MATRIX_PUBLIC_URL: matrixUrl,
    DS_GROUP_MEDIA_BACKEND: 's3', DS_GROUP_S3_BUCKET: 'dscord-media',
    DS_GROUP_S3_ENDPOINT: `http://${names.rclone}:8080`, DS_GROUP_S3_REGION: 'us-east-1',
    DS_GROUP_S3_PREFIX: 'dscord/', DS_GROUP_S3_ACCESS_KEY_ID: secrets[0], DS_GROUP_S3_SECRET_ACCESS_KEY: secrets[1] };
  const options = serverOptions(env);
  await initializeServer(options, { containerOwnership: false });
  const before = await readFile(path.join(options.synapseRoot, 'homeserver.yaml'), 'utf8');
  await initializeServer({ ...options, mediaStorage: undefined }, { containerOwnership: false });
  assert.equal(await readFile(path.join(options.synapseRoot, 'homeserver.yaml'), 'utf8'), before);
  report.checks.push('storedS3SelectionSurvivesInit');
  await createContainer(names.synapse, ['--env', 'UID=0', '--env', 'GID=0', '--env', 'AWS_MAX_ATTEMPTS=1',
    '--mount', `type=bind,source=${options.synapseRoot},target=/data`, '--publish', '127.0.0.1:22408:8008',
    synapseImage, 'run', '-m', 'synapse.app.homeserver', '--config-path=/data/homeserver.yaml']);
  await waitFor(`${matrixUrl}/_matrix/client/versions`);
  const providerDetails = 'import hashlib,importlib.metadata,json,s3_storage_provider as p; print(json.dumps({"version":importlib.metadata.version("synapse-s3-storage-provider"),"sourceSha256":hashlib.sha256(open(p.__file__,"rb").read()).hexdigest(),"boto3":importlib.metadata.version("boto3"),"configFields":sorted(p.S3StorageProviderBackend.parse_config({"bucket":"synthetic","threadpool_size":7,"request_checksum_calculation":"when_supported","response_checksum_validation":"when_supported"}))}))';
  report.provider = JSON.parse(await docker(['exec', names.synapse, 'python', '-c', providerDetails]));
  assert.equal(report.provider.version, '1.7.0');
  await bootstrapServer(options);
  const setup = JSON.parse(await readFile(path.join(options.dataRoot, 'matrix-setup.json'), 'utf8'));
  for (const participant of setup.participants) secrets.push(participant.accessToken, participant.password);
  core = await createCore({ dataRoot: options.dataRoot, enablePush: false });
  await new Promise((resolve, reject) => { core.server.once('error', reject); core.server.listen(22400, '127.0.0.1', resolve); });
  const alice = setup.participants.find(person => person.localpart === 'alice');
  const login = await jsonRequest('/api/login', { user: alice.id, password: alice.password });
  const token = login.access_token;
  assert.ok(token);
  secrets.push(token);
  const samples = [
    { name: '存储验证.txt', bytes: Buffer.from('DSCord synthetic attachment\n重复验证与跨进程读取\n') },
    { name: 'multipart.bin', bytes: Buffer.alloc(9 * 1024 * 1024, 0x5a) },
  ];
  for (const [index, sample] of samples.entries()) {
    const response = await request(`/api/attachments?filename=${encodeURIComponent(sample.name)}`, { token,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Id': `storage-smoke-${index}` }, body: sample.bytes });
    assert.equal(response.status, 200, `Attachment upload returned HTTP ${response.status}`);
    sample.attachment = (await response.json()).attachment;
    assert.equal(sample.attachment.sha256, hash(sample.bytes));
    const downloaded = await request(`/api/attachments/${sample.attachment.id}`, { token });
    assert.equal(downloaded.status, 200);
    assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), hash(sample.bytes));
  }
  const objects = await filesIn(objectRoot);
  const remoteHashes = await Promise.all(objects.map(async filename => hash(await readFile(filename))));
  for (const sample of samples) assert.ok(remoteHashes.includes(hash(sample.bytes)), 'Uploaded bytes are absent from S3 remote');
  report.attachments = samples.map(sample => ({ name: sample.name, bytes: sample.bytes.length, sha256: hash(sample.bytes) }));
  report.remoteObjects = objects.length;
  report.checks.push('normalAttachmentUploadDownload', 'singleAndMultipartBytesPersistedInRemote');
  await docker(['stop', '--time', '30', names.synapse]);
  await rename(path.join(options.synapseRoot, 'media_store'), path.join(options.synapseRoot, 'media_store.before-remote-read'));
  await docker(['restart', names.rclone]);
  await docker(['start', names.synapse]);
  await waitFor(`${matrixUrl}/_matrix/client/versions`);
  for (const sample of samples) {
    const downloaded = await request(`/api/attachments/${sample.attachment.id}`, { token });
    assert.equal(downloaded.status, 200, `Remote download returned HTTP ${downloaded.status}`);
    assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), hash(sample.bytes));
  }
  report.checks.push('restartAndRemoteReadAfterLocalCacheIsolation');
  const sample = samples[1];
  const range = await request(`/api/attachments/${sample.attachment.id}`, { token, headers: { Range: 'bytes=11-1041' } });
  const rangeBytes = Buffer.from(await range.arrayBuffer());
  assert.equal(range.status, 206, `Range returned HTTP ${range.status}`);
  assert.equal(range.headers.get('content-range'), `bytes 11-1041/${sample.bytes.length}`);
  assert.deepEqual(rangeBytes, sample.bytes.subarray(11, 1042));
  report.checks.push('remoteRangeDownload');
  await core.close();
  core = undefined;
  core = await createCore({ dataRoot: options.dataRoot, enablePush: false });
  await new Promise((resolve, reject) => { core.server.once('error', reject); core.server.listen(22400, '127.0.0.1', resolve); });
  const reopened = await request(`/api/attachments/${sample.attachment.id}`, { token, headers: { Range: 'bytes=37-99' } });
  assert.equal(reopened.status, 206);
  assert.deepEqual(Buffer.from(await reopened.arrayBuffer()), sample.bytes.subarray(37, 100));
  report.checks.push('coreRestartKeepsAttachmentAndRange');
  await docker(['stop', '--time', '10', names.rclone]);
  const retryBytes = Buffer.from('Synthetic storage recovery after a failed remote upload.');
  const retryInput = { token, headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Id': 'storage-failure-retry' }, body: retryBytes };
  const failed = await request('/api/attachments?filename=recovery.txt', retryInput);
  await failed.arrayBuffer();
  assert.ok(failed.status >= 500, `Offline provider upload returned HTTP ${failed.status}`);
  const failedRow = core.media.db.prepare('SELECT id,status FROM attachments WHERE upload_id=?').get('storage-failure-retry');
  assert.equal(failedRow.status, 'failed');
  await docker(['start', names.rclone]);
  await waitFor('http://127.0.0.1:22300/', response => [400, 401, 403].includes(response.status));
  const recovered = await request('/api/attachments?filename=recovery.txt', retryInput);
  const recoveryResult = await recovered.json();
  assert.equal(recovered.status, 200);
  assert.equal(recoveryResult.attachment.id, failedRow.id);
  assert.equal(recoveryResult.attachment.sha256, hash(retryBytes));
  const recoveredDownload = await request(`/api/attachments/${failedRow.id}`, { token });
  assert.equal(hash(Buffer.from(await recoveredDownload.arrayBuffer())), hash(retryBytes));
  report.remoteObjects = (await filesIn(objectRoot)).length;
  report.checks.push('failedRemoteUploadRemainsFailedAndStableRetryRecovers');
  const status = await jsonRequest('/api/status');
  assert.equal(status.budget.used, 0);
  report.loadedCoreSha256 = status.core.loadedCoreSha256;
  report.checks.push('zeroModelCalls');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error.message);
  process.exitCode = 1;
  for (const name of created) {
    const log = await execute('docker', ['logs', '--tail', '150', name], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })
      .then(result => `${result.stdout}\n${result.stderr}`).catch(error => error.message);
    await writeFile(path.join(directory, `${name}.log`), redact(log), { mode: 0o600 });
  }
} finally {
  const cleanupErrors = [];
  if (core) {
    core.server.closeAllConnections();
    await core.close().catch(error => cleanupErrors.push(error.message));
  }
  for (const name of created.toReversed()) await docker(['rm', '--force', name]).catch(error => cleanupErrors.push(error.message));
  if (networkCreated) await docker(['network', 'rm', names.network]).catch(error => cleanupErrors.push(error.message));
  report.cleanedUp = cleanupErrors.length === 0;
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors.map(redact); process.exitCode = 1; }
  report.completedAt = new Date().toISOString();
  const reportPath = path.join(directory, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, cleanedUp: report.cleanedUp, report: reportPath,
    ...(report.error ? { error: report.error } : {}) }));
}
