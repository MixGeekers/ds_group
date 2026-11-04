import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const localRoot = path.resolve(process.env.DS_GROUP_DATA_DIR || path.join(packageRoot, '.local'));

export function localPath(...parts) {
  return path.join(localRoot, ...parts);
}
