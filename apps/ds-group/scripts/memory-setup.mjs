import { mkdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) { if (!value.startsWith('--') || all[index + 1] === undefined) throw new Error('Use --home PATH --python PATH --ombre PATH [--llama-server PATH --gguf PATH | --endpoint URL]'); pairs.push([value.slice(2), all[index + 1]]); }
  return pairs;
}, []));
const config = { python: resolve(args.python || ''), upstream: resolve(args.ombre || '') };
if (!args.python || !args.ombre) throw new Error('--python and --ombre are required');
await access(config.python); await access(join(config.upstream, 'src/embedding_engine.py'));
if (args.endpoint) config.endpoint = args.endpoint;
else if (args['llama-server'] && args.gguf) { config.serverBinary = resolve(args['llama-server']); config.modelArtifact = resolve(args.gguf); await access(config.serverBinary); await access(config.modelArtifact); }
else throw new Error('Provide --llama-server and --gguf, or a running --endpoint');
const directory = join(resolve(args.home || process.env.DSH_HOME || join(homedir(), '.dsh')), 'bot/knowledge');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'backend.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ configured: true, filename: join(directory, 'backend.json'), activation: 'Next native Bot runtime startup' }));
