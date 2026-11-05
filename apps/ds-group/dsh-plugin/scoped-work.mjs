import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const SCOPED_FILE_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'read_image',
]);
const denied = (message) =>
  Object.assign(new Error(message), { code: 'WORK_FILE_SCOPE_DENIED' });
const inside = (filename, directory) =>
  filename === directory || filename.startsWith(directory + path.sep);

/** File tools cannot open private memory, other domains or a symlink out of this task. */
export async function checkScopedFile(
  { name, arguments: args },
  workdir,
  tools,
) {
  if (!SCOPED_FILE_TOOLS.has(name) || !tools.includes(name))
    throw denied('This task permits only its effective file tools');
  if (
    typeof args?.file_path !== 'string' ||
    !args.file_path ||
    args.file_path.includes('\0')
  )
    throw denied('A literal task file path is required');
  const directory = await realpath(workdir);
  const filename = path.resolve(directory, args.file_path);
  if (!inside(filename, directory))
    throw denied('The requested file is outside this task workspace');
  let current = filename;
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !inside(await realpath(current), directory))
        throw denied('Task file paths cannot traverse symbolic links');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === directory) break;
    current = path.dirname(current);
  }
  return filename;
}

export function validateScopedInput(input, work) {
  if (
    work.kind !== 'scoped' ||
    work.requestId !== input.requestId ||
    work.botId !== input.botId ||
    work.eventId !== input.event.eventId ||
    work.roomId !== input.event.roomId ||
    work.requesterId !== input.event.senderId ||
    !/^[a-f0-9]{64}$/.test(work.domainId || '') ||
    work.domainId !== input.authorization?.domainId ||
    work.proofHash !== input.authorization?.proofHash ||
    !Array.isArray(work.tools) ||
    work.tools.some((tool) => !SCOPED_FILE_TOOLS.has(tool))
  )
    throw Object.assign(
      new Error('The work proof does not bind this Bot task'),
      { code: 'WORK_AUTHORIZATION_MISMATCH' },
    );
  return work;
}
