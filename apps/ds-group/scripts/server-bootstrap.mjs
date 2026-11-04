import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MatrixClient } from '../src/matrix-client.mjs';
import { readOptionalJson, savePrivateJson, serverOptions } from './server-init.mjs';

const profiles = [
  { localpart: 'alice', name: 'Alice', kind: 'human' },
  { localpart: 'bob', name: 'Bob', kind: 'human' },
  { localpart: 'finance', name: '小雨 · 财务', kind: 'bot' },
  { localpart: 'hr', name: '小晴 · 人事', kind: 'bot' },
];

export async function bootstrapServer(options = serverOptions()) {
  const { dataRoot, serverName, homeserverUrl, publicHomeserverUrl } = options;
  const metadata = await readOptionalJson(path.join(dataRoot, 'server.json'));
  if (!metadata || metadata.serverName !== serverName) throw new Error('Run server-init before bootstrap with the same server name');
  const setupPath = path.join(dataRoot, 'matrix-setup.json');
  let setup = await readOptionalJson(setupPath);
  if (setup && setup.serverName !== serverName) throw new Error('Existing registry belongs to another Matrix server');
  if (!setup) {
    setup = { serverName, homeserverUrl, publicHomeserverUrl, roomId: null, participants: profiles.map(profile => ({
      ...profile, id: `@${profile.localpart}:${serverName}`, password: randomBytes(24).toString('base64url'), accessToken: null,
      ...(profile.kind === 'bot' ? { ownerId: `@alice:${serverName}` } : {}),
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
  const creator = new MatrixClient({ baseUrl: homeserverUrl, accessToken: setup.participants[0].accessToken });
  if (!setup.roomId) {
    const alias = `#ds-group-collaboration:${serverName}`;
    try { setup.roomId = (await creator.request('GET', `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`)).room_id; }
    catch (error) {
      if (error.errcode !== 'M_NOT_FOUND') throw error;
      setup.roomId = (await creator.createRoom({ name: 'DS-Group', room_alias_name: 'ds-group-collaboration',
        preset: 'private_chat', invite: setup.participants.slice(1).map(participant => participant.id) })).room_id;
    }
    await savePrivateJson(setupPath, setup);
  }
  for (const participant of setup.participants) {
    await new MatrixClient({ baseUrl: homeserverUrl, accessToken: participant.accessToken }).join(setup.roomId);
  }
  return { serverName, roomId: setup.roomId, participants: setup.participants.map(({ id, kind }) => ({ id, kind })) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.log(JSON.stringify(await bootstrapServer()));
}
