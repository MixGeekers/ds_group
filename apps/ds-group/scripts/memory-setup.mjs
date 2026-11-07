import { mkdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: Object.fromEntries([
  'home', 'kernel-home', 'python', 'ombre', 'llama-server', 'gguf', 'endpoint',
].map(name => [name, { type: 'string' }])) });
if (args.home && args['kernel-home']) throw new Error('Choose --home for a DSH home or --kernel-home for an exact kernel home');
const config = { python: resolve(args.python || ''), upstream: resolve(args.ombre || '') };
if (!args.python || !args.ombre) throw new Error('--python and --ombre are required');
await access(config.python); await access(join(config.upstream, 'src/embedding_engine.py'));
if (args.endpoint) config.endpoint = args.endpoint;
else if (args['llama-server'] && args.gguf) { config.serverBinary = resolve(args['llama-server']); config.modelArtifact = resolve(args.gguf); await access(config.serverBinary); await access(config.modelArtifact); }
else throw new Error('Provide --llama-server and --gguf, or a running --endpoint');
const kernelHome = args['kernel-home'] ? resolve(args['kernel-home'])
  : join(resolve(args.home || process.env.DSH_HOME || join(homedir(), '.dsh')), 'bot');
const directory = join(kernelHome, 'knowledge');
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, 'backend.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ configured: true, filename: join(directory, 'backend.json'), activation: 'Next native Bot runtime startup' }));
