import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localPath } from '../src/paths.mjs';
import { savePrivateJson } from './server-init.mjs';

export function nodeBundle(setup, coreConfig, nodeId) {
  const bot = setup.participants.find(participant => participant.kind === 'bot' && participant.localpart === nodeId);
  if (!bot?.accessToken) throw new Error('Choose a registered Bot with an access token');
  if (!setup.publicHomeserverUrl || !coreConfig.publicUrl) throw new Error('Configure public Matrix and core URLs before exporting a node');
  return {
    schemaVersion: 1, nodeId, coreUrl: coreConfig.publicUrl,
    setup: { serverName: setup.serverName, roomId: setup.roomId,
      homeserverUrl: setup.publicHomeserverUrl, publicHomeserverUrl: setup.publicHomeserverUrl,
      participants: setup.participants.map(({ id, name, kind, localpart, ownerId, accessToken }) => ({
        id, name, kind, localpart, ...(ownerId ? { ownerId } : {}),
        ...(id === bot.id ? { accessToken } : {}),
      })),
    },
    coreConfig: { nodeSecret: coreConfig.nodeSecret, modelCallLimit: coreConfig.modelCallLimit,
      maxOutputTokens: coreConfig.maxOutputTokens, publicUrl: coreConfig.publicUrl },
  };
}

export async function importNodeBundle(bundle, directory) {
  if (bundle.schemaVersion !== 1 || !bundle.setup?.participants || !bundle.coreConfig?.nodeSecret || !bundle.coreUrl) throw new Error('Invalid node bundle');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, 'node-import.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const files = [['matrix-setup.json', bundle.setup], ['core-config.json', bundle.coreConfig]];
    const missing = [];
    for (const [filename, value] of files) {
      try {
        const current = JSON.parse(await readFile(path.join(directory, filename), 'utf8'));
        if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error(`Refusing to replace ${filename} with another node identity`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push([filename, value]);
      }
    }
    for (const [filename, value] of missing) await savePrivateJson(path.join(directory, filename), value);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
  return { nodeId: bundle.nodeId, coreUrl: bundle.coreUrl, dataDirectory: directory };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [command, argument, destination] = process.argv.slice(2);
  if (command === 'import-node') {
    if (!argument || !destination) throw new Error('Use import-node BUNDLE.json DATA_DIRECTORY');
    const bundle = JSON.parse(await readFile(argument, 'utf8'));
    const directory = path.resolve(destination);
    console.log(JSON.stringify(await importNodeBundle(bundle, directory)));
  } else {
    const setup = JSON.parse(await readFile(localPath('matrix-setup.json'), 'utf8'));
    if (command === 'credentials') {
      const human = setup.participants.find(participant => participant.kind === 'human' && participant.localpart === (argument || 'alice'));
      if (!human?.password) throw new Error('Choose a registered human');
      console.log(JSON.stringify({ user: human.id, password: human.password }));
    } else if (command === 'export-node') {
      const config = JSON.parse(await readFile(localPath('core-config.json'), 'utf8'));
      console.log(JSON.stringify(nodeBundle(setup, config, argument)));
    } else {
      throw new Error('Use credentials [alice|bob], export-node BOT, or import-node BUNDLE.json DATA_DIRECTORY');
    }
  }
}
