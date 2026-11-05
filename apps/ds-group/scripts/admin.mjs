import { randomBytes } from 'node:crypto';
import { AdminAuth } from '../src/admin-auth.mjs';
import { localPath } from '../src/paths.mjs';
import { privateJson } from '../src/governance.mjs';
import path from 'node:path';

const [command, name = 'admin'] = process.argv.slice(2);
if (command !== 'init') throw new Error('Use node scripts/admin.mjs init [administrator]. Optional DS_GROUP_ADMIN_PASSWORD supplies the password.');
const root = localPath();
const auth = await new AdminAuth(root).initialize();
try {
  const password = process.env.DS_GROUP_ADMIN_PASSWORD || randomBytes(24).toString('base64url');
  await auth.change('local-console', { username: name, password, role: 'owner', enabled: true }, { bootstrap: true });
  const credentialFile = path.join(root, 'initial-administrator.json');
  if (!process.env.DS_GROUP_ADMIN_PASSWORD) await privateJson(credentialFile, { username: name, password, purpose: 'Initial DSCord administration sign-in. Remove after recording it in your password manager.' });
  console.log(JSON.stringify({ username: name, ...(process.env.DS_GROUP_ADMIN_PASSWORD ? { password: 'supplied-by-environment' } : { credentialFile }) }));
} finally { auth.close(); }
