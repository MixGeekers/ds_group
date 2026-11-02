import { createHash } from 'node:crypto';
import { HARRIER_PROFILE } from './index.js';

/** The user's inspected DFY llama.cpp build, not a downloadable or mutable version range. */
export const HARRIER_RUNTIME_MANIFEST = Object.freeze({
  id: 'llama-cpp-c3df4b7-darwin-arm64-v1', platform: 'darwin', arch: 'arm64',
  files: Object.freeze([
    { name: 'llama-server', sha256: '0e142035f2622a23ff6a04f51a0c4594dce87acf0389a4e839e4714c953bdac8', bytes: 33472 },
    { name: 'libllama-server-impl.dylib', bytes: 7075352, sha256: 'b32d32c5b25cb74859f05d13d8e7cccbba430ef4fd7cdf1a0fbb3b125ad2ffd2' },
    { name: 'libllama-common.0.8.0.dylib', bytes: 5333080, alias: 'libllama-common.0.dylib', sha256: '99c6353cc5d076344db853c54c9f2d9f7ab688500ecc1682692f022d6bc86dfb' },
    { name: 'libmtmd.0.8.0.dylib', bytes: 1620384, alias: 'libmtmd.0.dylib', sha256: 'f1692024831ea0aae84069386be97082d3b0d12e682af1b4ec43db269b7debe7' },
    { name: 'libllama.0.8.0.dylib', bytes: 3653728, alias: 'libllama.0.dylib', sha256: '218819ff3523e2f49fe56861b6eceaa99a8ef79daff6b9740fd5f13af545b82d' },
    { name: 'libggml.0.28.0.dylib', bytes: 59936, alias: 'libggml.0.dylib', sha256: '7c659561329b4008428697cc4ba7ce9730ca58d5ff42a2c237641ac0e02107fb' },
    { name: 'libggml-cpu.0.28.0.dylib', bytes: 974240, alias: 'libggml-cpu.0.dylib', sha256: 'fade5321b497c8dcebab01c8ec521904a47e92c48fc398316400274712b98d70' },
    { name: 'libggml-blas.0.28.0.dylib', bytes: 58776, alias: 'libggml-blas.0.dylib', sha256: 'a338d9fa86111936cccf045eaa751058e2a59e1832ed42ebdf48c9c8d77bd534' },
    { name: 'libggml-metal.0.28.0.dylib', bytes: 5619592, alias: 'libggml-metal.0.dylib', sha256: '8d774f8cbcee67b32182972cc601bf3058659f6b61c401c714638a6d5a6d7c6e' },
    { name: 'libggml-base.0.28.0.dylib', bytes: 751896, alias: 'libggml-base.0.dylib', sha256: '1c11b8be8cb5841e119286a4264fb13a10a146d203eb07ab4721ef7d5183bbb2' },
  ].map(entry => Object.freeze(entry))),
} as const);

export const HARRIER_RUNTIME_FINGERPRINT = createHash('sha256').update(JSON.stringify({
  runtime: HARRIER_RUNTIME_MANIFEST, artifactSha256: HARRIER_PROFILE.artifactSha256,
})).digest('hex');
