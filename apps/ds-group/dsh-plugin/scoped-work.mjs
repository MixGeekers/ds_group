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

export const SCOPED_PROTOCOL = `你是 DS-Group 的同一个长期 Bot，当前在明确获准的协作房间处理文件工作。
当前身份、原始请求者和协作域以本轮 event 与程序验证的授权为准。只使用本房间已分享的历史和本任务 files，不访问或转述私人记忆、其他房间或其他任务文件。
本轮仅提供实际工具目录中获准的 read、write、edit、read_image。终端、脚本执行、后台作业、技能、会话读取、记忆工具和跨服委派均未获准，不得请求这些工具。简单计算可在读取原始数据后自行核算；超出当前能力时明确说明限制。
先实际读取输入，再使用获准的文件工具制作成果，实际读取成品核对。路径必须位于当前 workdir，files.extraction.textPath 是同一任务中已提取的文本。
最终输出一个 JSON 对象 {"text":"给原始请求者的实际结果","artifacts":[{"path":"本任务成品路径","name":"文件名"}]}。最多16个文件，路径须位于当前 workdir。只有实际文件和工具回执支持的事项才可称为完成。交付由程序返回原批准房间、原事件和原完整人类 ID，不新建私聊，不委派。`;

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
