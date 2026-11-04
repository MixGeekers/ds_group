import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MatrixClient } from '../src/matrix-client.mjs';
import { packageRoot, localRoot } from '../src/paths.mjs';

const execute = promisify(execFile);
const matrixRoot = path.join(localRoot, 'matrix');
const setupPath = path.join(localRoot, 'matrix-setup.json');
const lockPath = path.join(matrixRoot, 'bootstrap.lock');
const registrationPath = path.join(matrixRoot, 'registration.yaml');
// The OCI index selects the matching amd64 or arm64 image on the Docker host.
const image = 'ghcr.io/element-hq/synapse@sha256:f0df87cff259872637b4b5e5174b9977e5e3046dd421505407803b5e45c5f842';
const previousArmImage = 'ghcr.io/element-hq/synapse@sha256:37090b4e5f26171922321a6acd1acf2675cb862f3b0cdf368f0dbbae6a70439a';
const containerName = process.env.DS_GROUP_MATRIX_CONTAINER || 'ds-group-matrix';
const matrixPort = Number(process.env.DS_GROUP_MATRIX_PORT || 18008);
if (!Number.isInteger(matrixPort) || matrixPort < 1 || matrixPort > 65535) throw new Error('Invalid DS_GROUP_MATRIX_PORT');
const homeserverUrl = `http://127.0.0.1:${matrixPort}`;
const serverName = process.env.DS_GROUP_MATRIX_SERVER_NAME || 'ds-group.local';
if (!/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(serverName)) throw new Error('Invalid DS_GROUP_MATRIX_SERVER_NAME');
const roomAlias = `#ds-group-first-collaboration:${serverName}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function docker(args) {
  const { stdout } = await execute('docker', args, { timeout: 900_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function saveJson(file, value, mode = 0o600) {
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, file);
  await chmod(file, mode);
}

async function inspectContainer() {
  try {
    const result = JSON.parse(await docker(['inspect', containerName]))[0];
    const ownData = result.Mounts.some(mount => mount.Destination === '/data' && mount.Source === matrixRoot);
    if (result.Config.Labels?.['org.ds-group.component'] !== 'matrix' || !ownData) {
      throw new Error(`Container ${containerName} belongs to another installation`);
    }
    if (![image, previousArmImage].includes(result.Config.Image)) throw new Error('The existing DS-Group Matrix container uses a different image');
    return result;
  } catch (error) {
    if (/no such (object|container)/i.test(error.stderr ?? '')) return undefined;
    throw error;
  }
}

async function ensureDocker() {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}']);
    return;
  } catch {
    if (process.platform !== 'darwin') throw new Error('Start Docker before running Matrix');
    console.log('Starting the installed Docker Desktop');
    await execute('open', ['-a', 'Docker']);
  }
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      await docker(['info', '--format', '{{.ServerVersion}}']);
      return;
    } catch {
      await delay(2000);
    }
  }
  throw new Error('Docker Desktop did not become ready within three minutes');
}

async function waitForServer() {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(`${homeserverUrl}/_matrix/client/versions`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return response.json();
    } catch {
      // Startup may take a few seconds while Synapse initializes its database.
    }
    await delay(1000);
  }
  throw new Error('Matrix did not become ready within 90 seconds. Inspect docker logs ds-group-matrix');
}

async function ensureConfiguration() {
  const configPath = path.join(matrixRoot, 'homeserver.yaml');
  try {
    await readFile(configPath, 'utf8');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const configuration = `server_name: ${serverName}
public_baseurl: ${homeserverUrl}/
pid_file: /data/homeserver.pid
listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: false
    bind_addresses: ['0.0.0.0']
    resources:
      - names: [client]
        compress: false
database:
  name: sqlite3
  args:
    database: /data/homeserver.db
media_store_path: /data/media_store
signing_key_path: /data/ds-group.local.signing.key
macaroon_secret_key: ${randomBytes(48).toString('hex')}
form_secret: ${randomBytes(48).toString('hex')}
report_stats: false
enable_registration: false
federation_domain_whitelist: []
trusted_key_servers: []
suppress_key_server_warning: true
rc_message:
  per_second: 100
  burst_count: 200
`;
  await writeFile(configPath, configuration, { mode: 0o600, flag: 'wx' });
}

async function ensureSetup() {
  const existing = await readJson(setupPath);
  if (existing) {
    if (existing.homeserverUrl !== homeserverUrl || existing.serverName !== serverName || !Array.isArray(existing.participants)) {
      throw new Error('Existing Matrix setup has a different configuration');
    }
    return existing;
  }
  const profiles = [
    { localpart: 'alice', name: 'Alice', kind: 'human' },
    { localpart: 'bob', name: 'Bob', kind: 'human' },
    { localpart: 'finance', name: '小雨 · 财务', kind: 'bot' },
    { localpart: 'hr', name: '小晴 · 人事', kind: 'bot' },
  ];
  const setup = {
    homeserverUrl,
    serverName,
    roomId: null,
    participants: profiles.map(profile => ({ ...profile, id: `@${profile.localpart}:${serverName}`, password: randomBytes(24).toString('base64url'), accessToken: null })),
  };
  await saveJson(setupPath, setup);
  return setup;
}

async function registerParticipant(participant, secret) {
  const client = new MatrixClient({ baseUrl: homeserverUrl });
  const { nonce } = await client.request('GET', '/_synapse/admin/v1/register');
  const mac = createHmac('sha1', secret)
    .update([nonce, participant.localpart, participant.password, 'notadmin'].join('\0'))
    .digest('hex');
  return client.request('POST', '/_synapse/admin/v1/register', {
    nonce, username: participant.localpart, password: participant.password, admin: false, mac,
  });
}

async function ensureParticipants(setup, secret) {
  for (const participant of setup.participants) {
    let ready = false;
    if (participant.accessToken) {
      try {
        const identity = await new MatrixClient({ baseUrl: homeserverUrl, accessToken: participant.accessToken }).whoami();
        ready = identity.user_id === participant.id;
      } catch {
        ready = false;
      }
    }
    if (!ready) {
      let login;
      if (!participant.accessToken && secret) {
        try {
          login = await registerParticipant(participant, secret);
        } catch (error) {
          if (error.errcode !== 'M_USER_IN_USE') throw error;
          login = await MatrixClient.login(homeserverUrl, participant.id, participant.password);
        }
      } else {
        login = await MatrixClient.login(homeserverUrl, participant.id, participant.password);
      }
      if (login.user_id !== participant.id || !login.access_token) throw new Error('Matrix returned an unexpected member identity');
      participant.accessToken = login.access_token;
      await saveJson(setupPath, setup);
    }
    const client = new MatrixClient({ baseUrl: homeserverUrl, accessToken: participant.accessToken });
    await client.request('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(participant.id)}/displayname`, { displayname: participant.name });
  }
}

async function ensureRoom(setup) {
  const creator = new MatrixClient({ baseUrl: homeserverUrl, accessToken: setup.participants[0].accessToken });
  if (!setup.roomId) {
    try {
      setup.roomId = (await creator.request('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(roomAlias)}`)).room_id;
    } catch (error) {
      if (error.errcode !== 'M_NOT_FOUND') throw error;
      const room = await creator.createRoom({
        name: 'DS-Group · 初次协作',
        topic: '两个人类与两个独立 Bot 的首个协作房间',
        room_alias_name: 'ds-group-first-collaboration',
        preset: 'private_chat',
        invite: setup.participants.slice(1).map(participant => participant.id),
      });
      setup.roomId = room.room_id;
    }
    await saveJson(setupPath, setup);
  }
  for (const participant of setup.participants) {
    await new MatrixClient({ baseUrl: homeserverUrl, accessToken: participant.accessToken }).join(setup.roomId);
  }
}

async function recordSmoke(setup, versions) {
  const alice = new MatrixClient({ baseUrl: homeserverUrl, accessToken: setup.participants[0].accessToken });
  const bob = new MatrixClient({ baseUrl: homeserverUrl, accessToken: setup.participants[1].accessToken });
  const first = await alice.send(setup.roomId, 'DS-Group 已建立共同房间。Alice 的成员身份已接通。', { transactionId: 'matrix-bootstrap-alice-v1' });
  const second = await bob.send(setup.roomId, 'Bob 已加入，能够看到 Alice 的消息并引用回复。', { transactionId: 'matrix-bootstrap-bob-v1', replyTo: first.event_id });
  const duplicate = await alice.send(setup.roomId, 'DS-Group 已建立共同房间。Alice 的成员身份已接通。', { transactionId: 'matrix-bootstrap-alice-v1' });
  const events = await alice.timeline(setup.roomId, 100);
  const aliceEvent = events.find(event => event.event_id === first.event_id);
  const bobEvent = events.find(event => event.event_id === second.event_id);
  const members = await alice.request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(setup.roomId)}/joined_members`);
  const anonymous = new MatrixClient({ baseUrl: homeserverUrl });
  let publicRegistrationClosed = false;
  let temporaryRegistrationClosed = false;
  try {
    await anonymous.request('POST', '/_matrix/client/v3/register', {});
  } catch (error) {
    publicRegistrationClosed = error.status === 403 && error.errcode === 'M_FORBIDDEN';
  }
  try {
    await anonymous.request('POST', '/_synapse/admin/v1/register', {});
  } catch (error) {
    temporaryRegistrationClosed = error.status === 400 && error.message === 'Shared secret registration is not enabled';
  }
  const passed = aliceEvent?.sender === setup.participants[0].id
    && bobEvent?.sender === setup.participants[1].id
    && bobEvent?.content?.['m.relates_to']?.['m.in_reply_to']?.event_id === first.event_id
    && duplicate.event_id === first.event_id
    && setup.participants.every(participant => Object.hasOwn(members.joined, participant.id))
    && publicRegistrationClosed && temporaryRegistrationClosed;
  const evidence = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    status: passed ? 'passed' : 'failed',
    level: 'real-local-matrix-http',
    image,
    versions: versions.versions,
    homeserverUrl,
    roomId: setup.roomId,
    participants: setup.participants.map(({ id, name, kind }) => ({ id, name, kind })),
    checks: {
      fourMembersJoined: setup.participants.every(participant => Object.hasOwn(members.joined, participant.id)),
      humanSendersPreserved: aliceEvent?.sender === setup.participants[0].id && bobEvent?.sender === setup.participants[1].id,
      replyReferencePreserved: bobEvent?.content?.['m.relates_to']?.['m.in_reply_to']?.event_id === first.event_id,
      transactionDeduplicated: duplicate.event_id === first.event_id,
      publicRegistrationClosed,
      temporaryRegistrationClosed,
    },
    eventIds: [first.event_id, second.event_id],
    modelCalls: 0,
    physicalHosts: 1,
    limitation: 'Verifies the Matrix core over HTTP. Bot reasoning and two-physical-machine operation require separate evidence.',
  };
  await saveJson(process.env.DS_GROUP_MATRIX_REPORT || path.join(packageRoot, 'artifacts', 'matrix-smoke.json'), evidence, 0o644);
  if (!passed) throw new Error('Matrix HTTP smoke checks failed');
}

async function up() {
  await ensureDocker();
  await mkdir(matrixRoot, { recursive: true, mode: 0o700 });
  try {
    const previousPid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isInteger(previousPid) || previousPid < 1) throw new Error('Matrix bootstrap lock contains an invalid process ID');
    try {
      process.kill(previousPid, 0);
      throw new Error('Another Matrix bootstrap is active');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      await rm(lockPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  let registrationEnabled = false;
  try {
    const setup = await ensureSetup();
    await ensureConfiguration();
    const secret = setup.participants.some(participant => !participant.accessToken) ? randomBytes(48).toString('hex') : undefined;
    const registration = secret ? `registration_shared_secret: ${secret}\n` : '{}\n';
    let previousRegistration;
    try { previousRegistration = await readFile(registrationPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(registrationPath, registration, { mode: 0o600 });
    registrationEnabled = Boolean(secret);
    let container = await inspectContainer();
    if (!container) {
      console.log('Preparing the pinned Synapse image');
      await docker(['pull', image]);
      await docker(['run', '--detach', '--name', containerName, '--label', 'org.ds-group.component=matrix', '--publish', `127.0.0.1:${matrixPort}:8008`, '--mount', `type=bind,source=${matrixRoot},target=/data`, '--env', 'UID=0', '--env', 'GID=0', image, 'run', '-m', 'synapse.app.homeserver', '--config-path=/data/homeserver.yaml', '--config-path=/data/registration.yaml']);
    } else if (!container.State.Running) {
      await docker(['start', containerName]);
    } else if (previousRegistration !== registration) {
      await docker(['restart', containerName]);
    }
    const versions = await waitForServer();
    await ensureParticipants(setup, secret);
    await ensureRoom(setup);
    if (registrationEnabled) {
      await writeFile(registrationPath, '{}\n', { mode: 0o600 });
      await docker(['restart', containerName]);
      await waitForServer();
      registrationEnabled = false;
    }
    await recordSmoke(setup, versions);
    console.log(`Matrix ready at ${homeserverUrl}; four members joined the initial room`);
    console.log('Credentials are saved in .local/matrix-setup.json');
  } finally {
    try {
      if (registrationEnabled) {
        await writeFile(registrationPath, '{}\n', { mode: 0o600 });
        const container = await inspectContainer();
        if (container?.State.Running) {
          await docker(['restart', containerName]);
          await waitForServer();
        }
      }
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

async function main() {
  const action = process.argv[2] ?? 'status';
  if (action === 'up') return up();
  if (!['down', 'status'].includes(action)) throw new Error('Usage: node scripts/matrix.mjs up|down|status');
  const container = await inspectContainer();
  if (action === 'down') {
    if (container?.State.Running) await docker(['stop', containerName]);
    console.log('DS-Group Matrix stopped; its data is retained');
    return;
  }
  const setup = await readJson(setupPath);
  console.log(JSON.stringify({ container: containerName, running: Boolean(container?.State.Running), homeserverUrl, serverName, roomId: setup?.roomId ?? null, members: setup?.participants.map(({ id, name, kind }) => ({ id, name, kind })) ?? [], image }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
