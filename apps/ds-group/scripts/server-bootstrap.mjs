import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MatrixClient } from '../src/matrix-client.mjs';
import { readOptionalJson, savePrivateJson, serverOptions } from './server-init.mjs';

const demoProfiles = [
  { localpart: 'alice', name: 'Alice', kind: 'human' },
  { localpart: 'bob', name: 'Bob', kind: 'human' },
  { localpart: 'finance', name: '小雨 · 财务', kind: 'bot' },
  { localpart: 'hr', name: '小晴 · 人事', kind: 'bot' },
];

export function bootstrapOptions(env = process.env) {
  if (env.DS_GROUP_BOOTSTRAP_DEMO !== undefined && !['true', 'false', ''].includes(env.DS_GROUP_BOOTSTRAP_DEMO)) {
    throw new Error('DS_GROUP_BOOTSTRAP_DEMO must be true or false');
  }
  return { ...serverOptions(env), demo: env.DS_GROUP_BOOTSTRAP_DEMO === 'true',
    ...(env.DS_GROUP_BOOTSTRAP_PROFILES_PATH ? { profilesPath: path.resolve(env.DS_GROUP_BOOTSTRAP_PROFILES_PATH) } : {}) };
}

function initialProfiles(profiles, serverName) {
  if (!Array.isArray(profiles)) throw new Error('Bootstrap profiles must be an array');
  const localparts = new Set();
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)
      || Object.keys(profile).some(key => !['localpart', 'name', 'kind', 'ownerId'].includes(key))
      || typeof profile.localpart !== 'string' || !/^[a-z0-9][a-z0-9._=-]{0,63}$/.test(profile.localpart)
      || localparts.has(profile.localpart) || !['human', 'bot'].includes(profile.kind)
      || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 200
      || profile.kind === 'human' && profile.ownerId !== undefined) {
      throw new Error('Invalid bootstrap profile; use unique localpart, name, kind and optional Bot ownerId');
    }
    localparts.add(profile.localpart);
  }
  const humans = profiles.filter(profile => profile.kind === 'human').map(profile => `@${profile.localpart}:${serverName}`);
  return profiles.map(profile => {
    const ownerId = profile.ownerId ?? humans[0];
    if (profile.kind === 'bot' && !humans.includes(ownerId)) throw new Error('Each bootstrap Bot needs an owner among the initial humans');
    return { ...profile, ...(profile.kind === 'bot' ? { ownerId } : {}) };
  });
}

export async function bootstrapServer(options = bootstrapOptions()) {
  const { dataRoot, serverName, homeserverUrl, publicHomeserverUrl } = options;
  if (options.demo !== undefined && typeof options.demo !== 'boolean') throw new Error('Bootstrap demo must be a boolean');
  if (options.demo && (options.profiles !== undefined || options.profilesPath)) throw new Error('Choose demo or custom bootstrap profiles');
  if (options.profiles !== undefined && options.profilesPath) throw new Error('Choose inline bootstrap profiles or a profiles file');
  const metadata = await readOptionalJson(path.join(dataRoot, 'server.json'));
  if (!metadata || metadata.serverName !== serverName) throw new Error('Run server-init before bootstrap with the same server name');
  const setupPath = path.join(dataRoot, 'matrix-setup.json');
  let setup = await readOptionalJson(setupPath);
  const reused = Boolean(setup);
  if (setup && setup.serverName !== serverName) throw new Error('Existing registry belongs to another Matrix server');
  if (!setup) {
    let profiles = options.demo ? demoProfiles : options.profiles ?? [];
    if (options.profilesPath) {
      profiles = await readOptionalJson(options.profilesPath);
      if (profiles === undefined) throw new Error('Bootstrap profiles file does not exist');
    }
    profiles = initialProfiles(profiles, serverName);
    setup = { serverName, homeserverUrl, publicHomeserverUrl, roomId: null,
      bootstrapMode: options.demo ? 'demo' : profiles.length ? 'custom' : 'empty', participants: profiles.map(profile => ({
      ...profile, id: `@${profile.localpart}:${serverName}`, password: randomBytes(24).toString('base64url'), accessToken: null,
    })) };
  }
  Object.assign(setup, { homeserverUrl, publicHomeserverUrl, deploymentMode: 'server' });
  // Persist generated passwords before the first external registration so retries can log in.
  await savePrivateJson(setupPath, setup);
  const anonymous = new MatrixClient({ baseUrl: homeserverUrl });
  for (const participant of setup.participants) {
    let client = new MatrixClient({ baseUrl: homeserverUrl, accessToken: participant.accessToken });
    let valid = false;
    if (participant.accessToken) {
      try { valid = (await client.whoami()).user_id === participant.id; }
      catch (error) { if (![401, 403].includes(error.status)) throw error; }
    }
    if (!valid) {
      const { nonce } = await anonymous.request('GET', '/_synapse/admin/v1/register');
      const mac = createHmac('sha1', metadata.registrationSecret)
        .update([nonce, participant.localpart, participant.password, 'notadmin'].join('\0')).digest('hex');
      let login;
      try {
        login = await anonymous.request('POST', '/_synapse/admin/v1/register', {
          nonce, username: participant.localpart, password: participant.password, admin: false, mac,
        });
      }
      catch (error) {
        if (error.errcode !== 'M_USER_IN_USE') throw error;
        login = await MatrixClient.login(homeserverUrl, participant.id, participant.password);
      }
      if (login.user_id !== participant.id || !login.access_token) throw new Error('Matrix identity does not match the server registry');
      participant.accessToken = login.access_token;
      await savePrivateJson(setupPath, setup);
      client = new MatrixClient({ baseUrl: homeserverUrl, accessToken: participant.accessToken });
    }
    await client.request('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(participant.id)}/displayname`, { displayname: participant.name });
  }
  const creator = setup.participants.find(participant => participant.kind === 'human');
  if (!creator) {
    if (setup.participants.length) throw new Error('Bootstrap registry has no human room creator');
    return { serverName, roomId: setup.roomId, participants: [], reused, bootstrapMode: setup.bootstrapMode || 'existing' };
  }
  const creatorClient = new MatrixClient({ baseUrl: homeserverUrl, accessToken: creator.accessToken });
  if (!setup.roomId) {
    const alias = `#ds-group-collaboration:${serverName}`;
    try { setup.roomId = (await creatorClient.request('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`)).room_id; }
    catch (error) {
      if (error.errcode !== 'M_NOT_FOUND') throw error;
      setup.roomId = (await creatorClient.createRoom({ name: 'DS-Group', room_alias_name: 'ds-group-collaboration',
        preset: 'private_chat', invite: setup.participants.filter(participant => participant.id !== creator.id).map(participant => participant.id) })).room_id;
    }
    await savePrivateJson(setupPath, setup);
  }
  for (const participant of setup.participants) {
    await new MatrixClient({ baseUrl: homeserverUrl, accessToken: participant.accessToken }).join(setup.roomId);
  }
  return { serverName, roomId: setup.roomId, participants: setup.participants.map(({ id, kind }) => ({ id, kind })),
    reused, bootstrapMode: setup.bootstrapMode || 'existing' };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await bootstrapServer()));
}
