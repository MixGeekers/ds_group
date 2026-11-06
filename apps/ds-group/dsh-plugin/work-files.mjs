import { createHash } from 'node:crypto';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_ARTIFACTS = 16;
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const mimeTypes = new Map([
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.csv', 'text/csv'],
  ['.json', 'application/json'], ['.html', 'text/html'], ['.xml', 'application/xml'],
  ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'], ['.zip', 'application/zip'], ['.gz', 'application/gzip'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xls', 'application/vnd.ms-excel'], ['.doc', 'application/msword'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
]);

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw fail('INVALID_WORK_FILE', `${field} must be a non-empty string`);
  }
  return value;
}

function contained(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function displayName(value, filename) {
  const name = value === undefined ? path.basename(filename) : requiredString(value, 'name');
  if (name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/u.test(name)) {
    throw fail('INVALID_WORK_FILE', 'A file name must not contain path separators or control characters');
  }
  return name;
}

function mimeType(value, filename) {
  if (value === undefined) return mimeTypes.get(path.extname(filename).toLowerCase()) || 'application/octet-stream';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value)) {
    throw fail('INVALID_WORK_FILE', 'Invalid file MIME type');
  }
  return value.toLowerCase();
}

async function inspectFile(descriptor, directory, maximumBytes = Infinity, allowExternalPaths = false) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw fail('INVALID_WORK_FILE', 'A file descriptor is required');
  }
  const requested = path.resolve(directory, requiredString(descriptor.path, 'path'));
  let filename;
  try { filename = await realpath(requested); }
  catch (error) {
    if (error.code === 'ENOENT') throw fail('WORK_FILE_NOT_FOUND');
    throw error;
  }
  if (!allowExternalPaths && !contained(filename, directory)) throw fail('WORK_FILE_OUTSIDE_DIRECTORY');
  if (!(await stat(filename)).isFile()) throw fail('WORK_FILE_NOT_REGULAR');
  const handle = await open(filename, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw fail('WORK_FILE_NOT_REGULAR');
    if (initial.size > maximumBytes) throw fail('WORK_FILE_TOO_LARGE');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximumBytes) throw fail('WORK_FILE_TOO_LARGE');
      hash.update(chunk);
    }
    const final = await handle.stat();
    const current = await stat(filename);
    if (size !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs
      || final.ctimeMs !== initial.ctimeMs || current.ino !== final.ino || current.dev !== final.dev) {
      throw fail('WORK_FILE_CHANGED');
    }
    return {
      name: displayName(descriptor.name, filename), path: filename,
      mimeType: mimeType(descriptor.mimeType, descriptor.name || filename), size, sha256: hash.digest('hex'),
    };
  } finally { await handle.close(); }
}

async function normalizeExtraction(extraction, directory) {
  if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) {
    throw fail('INVALID_WORK_FILE', 'extraction must be an object');
  }
  const normalized = { type: requiredString(extraction.type, 'extraction.type') };
  for (const field of ['supported', 'truncated']) {
    if (extraction[field] === undefined) continue;
    if (typeof extraction[field] !== 'boolean') throw fail('INVALID_WORK_FILE', `extraction.${field} must be a boolean`);
    normalized[field] = extraction[field];
  }
  if (extraction.warnings !== undefined) {
    if (!Array.isArray(extraction.warnings) || extraction.warnings.some(warning => typeof warning !== 'string')) {
      throw fail('INVALID_WORK_FILE', 'extraction.warnings must contain strings');
    }
    normalized.warnings = [...extraction.warnings];
  }
  if (extraction.textPath !== undefined) {
    const sidecar = await inspectFile({ path: extraction.textPath }, directory, MAX_ARTIFACT_BYTES);
    normalized.textPath = sidecar.path;
  }
  return normalized;
}

export async function prepareWorkFiles({ dataDir, requestId, workdir, files = [] }) {
  requiredString(requestId, 'requestId');
  if (workdir !== undefined) {
    requiredString(workdir, 'workdir');
    if (!path.isAbsolute(workdir)) throw fail('INVALID_WORK_DIRECTORY', 'workdir must be absolute');
  } else {
    requiredString(dataDir, 'dataDir');
    const identifier = createHash('sha256').update(requestId).digest('hex');
    workdir = path.resolve(dataDir, 'workspaces', 'tasks', identifier);
  }
  if (!Array.isArray(files)) throw fail('INVALID_WORK_FILE', 'files must be an array');
  await mkdir(workdir, { recursive: true });
  workdir = await realpath(workdir);
  const normalized = [];
  const paths = new Set();
  const identifiers = new Set();
  for (const input of files) {
    const file = await inspectFile(input, workdir);
    if (paths.has(file.path)) throw fail('DUPLICATE_WORK_FILE');
    paths.add(file.path);
    if (input.id !== undefined) {
      requiredString(input.id, 'id');
      if (identifiers.has(input.id)) throw fail('DUPLICATE_WORK_FILE');
      identifiers.add(input.id);
      file.id = input.id;
    }
    if (input.sha256 !== undefined && (typeof input.sha256 !== 'string'
      || !/^[a-fA-F0-9]{64}$/.test(input.sha256) || input.sha256.toLowerCase() !== file.sha256)) {
      throw fail('WORK_FILE_HASH_MISMATCH');
    }
    if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < 0 || input.size !== file.size)) {
      throw fail('WORK_FILE_SIZE_MISMATCH');
    }
    if (input.extraction !== undefined) file.extraction = await normalizeExtraction(input.extraction, workdir);
    normalized.push(file);
  }
  return { workdir, files: normalized };
}

export function parseFinalOutput(value) {
  const text = requiredString(value, 'final output').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let result;
  try { result = JSON.parse(fenced ? fenced[1] : text); }
  catch { return { text, artifacts: [] }; }
  // A user may ask for ordinary structured data. Only objects using a delivery
  // field opt into DSCord's text/artifacts/delegate envelope.
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !['text', 'artifacts', 'delegate'].some(key => Object.hasOwn(result, key))) return { text, artifacts: [] };
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string' || !result.text.trim()) {
    throw fail('INVALID_FINAL_OUTPUT', 'Structured output requires non-empty text');
  }
  if (result.artifacts !== undefined && !Array.isArray(result.artifacts)) {
    throw fail('INVALID_FINAL_OUTPUT', 'artifacts must be an array');
  }
  return { ...result, artifacts: result.artifacts || [] };
}

export async function collectArtifacts(text, workdir, { maxFiles = MAX_ARTIFACTS, maxBytes = MAX_ARTIFACT_BYTES, allowExternalPaths = false } = {}) {
  const output = parseFinalOutput(text);
  if (output.artifacts.length > maxFiles) throw fail('TOO_MANY_ARTIFACTS');
  if (output.artifacts.length === 0) return [];
  const directory = await realpath(requiredString(workdir, 'workdir'));
  const paths = new Set();
  const files = [];
  for (const artifact of output.artifacts) {
    const file = await inspectFile(artifact, directory, maxBytes, allowExternalPaths);
    if (paths.has(file.path)) throw fail('DUPLICATE_ARTIFACT');
    paths.add(file.path);
    files.push(file);
  }
  return files;
}

// outputs/ is the current task's deliberate handoff area, never its input or
// native working folder. Used only when no explicit file delivery was made.
export async function collectStagedArtifacts(workdir) {
  const directory = await realpath(requiredString(workdir, 'workdir'));
  const output = path.join(directory, 'outputs');
  let entries;
  try {
    if (!contained(await realpath(output), directory)) throw fail('WORK_FILE_OUTSIDE_DIRECTORY');
    entries = await readdir(output, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const artifacts = entries.filter(entry => !entry.name.startsWith('.') && !entry.isDirectory())
    .sort((a,b) => a.name.localeCompare(b.name)).map(entry => ({path:path.join(output,entry.name)}));
  return collectArtifacts(JSON.stringify({text:'Staged task outputs',artifacts}),directory);
}
