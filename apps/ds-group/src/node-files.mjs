import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractFile } from './file-formats.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const maximumBytes = 50 * 1024 * 1024;

export function eventAttachments(event) {
  const values = event.content?.['org.ds_group']?.attachments;
  return Array.isArray(values) ? values.filter(value => value && typeof value.id === 'string' && value.id).map(value => ({ ...value,
    ...(event.room_id && event.event_id ? { source: { roomId: event.room_id, eventId: event.event_id, senderId: event.sender } } : {}) })) : [];
}

function filesFromEvents(events) {
  const files = new Map();
  for (const event of events) {
    for (const file of event.attachments || []) {
      if (!files.has(file.id)) files.set(file.id, file);
    }
  }
  return [...files.values()];
}

function batchEvents(event, history) {
  if (!event.fileBatch?.id) return [event];
  return [...history.filter(previous => previous.senderId === event.senderId && previous.taskId === event.taskId
    && previous.kind === event.kind && previous.fileBatch?.id === event.fileBatch.id), event];
}

export function selectInputAttachments(request) {
  const event = request.event;
  const history = request.history || [];
  if (['task.request', 'task.result'].includes(event.kind)) {
    const parts = event.fileBatch?.id ? batchEvents(event, history)
      : [...history.filter(previous => event.taskId && previous.taskId === event.taskId
        && previous.senderId === event.senderId && previous.kind === event.kind), event];
    return filesFromEvents(parts);
  }
  if (event.attachments?.length || event.replyTo) return filesFromEvents([event]);
  if (!event.senderId || event.senderKind === 'bot') return [];
  const previous = history.findLast(candidate => candidate.attachments?.length
    && (candidate.senderId === event.senderId
      || candidate.senderId === request.botId && candidate.originSenderId === event.senderId));
  return previous ? filesFromEvents(batchEvents(previous, history.filter(candidate => candidate.eventId !== previous.eventId))) : [];
}

export function attachmentSourceFor(request, attachment) {
  if (!request?.event) return null;
  const events = [request.event, ...(request.history || []).toReversed()];
  for (const event of events) {
    const roomId = event.roomId || request.event.roomId;
    if (!roomId || !event.eventId || !(event.attachments || []).some(file => ['id', 'contentUri', 'sha256', 'size']
      .every(key => file[key] === attachment[key]))) continue;
    // A reply/followup may carry an older file in the normalized current input.
    // Prefer the proven origin attached during Matrix normalization when known.
    const source = (event.attachments || []).find(file => file.id === attachment.id)?.source;
    return source?.roomId && source?.eventId ? { roomId: source.roomId, eventId: source.eventId } : { roomId, eventId: event.eventId };
  }
  return null;
}

function localName(name) {
  const clean = String(name || 'attachment').replace(/[\\/\u0000-\u001f\u007f]/g, '_');
  const extension = path.extname(clean);
  const suffix = Buffer.byteLength(extension) <= 20 ? extension : '';
  const stem = suffix ? clean.slice(0, -suffix.length) : clean;
  let filename = '';
  for (const character of stem) {
    if (Buffer.byteLength(filename + character + suffix) > 160) break;
    filename += character;
  }
  return (filename.replace(/^\.+$/, 'attachment') || 'attachment') + suffix;
}

async function fileDigest(filename, limit) {
  const metadata = await stat(filename);
  if (!metadata.isFile() || metadata.size > limit) throw new Error('Task artifact must be a regular file within the attachment size limit');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return { size: metadata.size, sha256: hash.digest('hex') };
}

export class NodeFiles {
  constructor({ coreUrl, accessToken, directory, fetchImpl = fetch, maxBytes = maximumBytes, work, matrix }) {
    this.coreUrl = coreUrl;
    this.accessToken = accessToken;
    this.directory = path.resolve(directory);
    this.fetch = fetchImpl;
    this.maxBytes = maxBytes;
    this.work = work;
    this.matrix = matrix;
  }

  async prepare(request, signal) {
    const scoped = request.authorization?.kind === 'scoped';
    const workdir = scoped ? path.join(this.directory, 'domains', request.authorization.domainId, digest(request.requestId).slice(0, 32))
      : path.join(this.directory, digest(request.requestId).slice(0, 32));
    const inputs = path.join(workdir, 'inputs');
    await mkdir(inputs, { recursive: true, mode: 0o700 });
    await mkdir(path.join(workdir, 'outputs'), { recursive: true, mode: 0o700 });
    const attachments = scoped ? request.event.attachments || [] : selectInputAttachments(request);
    const files = [];
    const selected = attachments.slice(0, 64);
    for (const attachment of selected) {
      const file = await this.download(attachment, inputs, signal, request);
      try {
        const extraction = await extractFile(file.path, { outputDirectory: path.join(workdir, 'extracted') });
        file.extraction = { type: extraction.type, textPath: extraction.textPath, truncated: extraction.truncated,
          warnings: extraction.warnings, supported: extraction.supported };
      } catch (error) {
        file.extraction = { type: 'unknown', supported: false, warnings: [`文件预读失败，可使用工具检查原文件：${error.message}`] };
      }
      files.push(file);
    }
    return { ...request, workdir, files,
      ...(attachments.length > selected.length ? { attachmentWarnings: [`当前任务文件较多，本轮准备 ${selected.length} 个文件，其余文件可以重新引用后处理。`] } : {}) };
  }

  async download(attachment, directory, signal, request) {
    const scoped = request?.authorization?.kind === 'scoped';
    if (scoped) {
      if (!this.work || !this.matrix || !/^[a-f0-9]{64}$/.test(request.authorization.domainId)) throw new Error('Scoped file transfer needs the home work authority and Matrix client');
      await this.work.check(request, 'download', { attachment });
    }
    if (attachment.size > this.maxBytes) throw new Error('Input attachment exceeds this node’s file size limit');
    const key = scoped ? JSON.stringify([attachment.source, attachment.id, attachment.contentUri, attachment.sha256]) : attachment.id;
    const filename = path.join(directory, `${digest(key).slice(0, 16)}-${localName(attachment.name)}`);
    const cacheDirectory = scoped ? path.join(this.directory, '_attachments', request.authorization.domainId) : path.join(this.directory, '_attachments');
    const cacheFile = /^[a-f0-9]{64}$/.test(attachment.sha256 || '') ? path.join(cacheDirectory, attachment.sha256) : null;
    if (typeof attachment.sha256 === 'string') {
      try {
        const existing = await fileDigest(filename, this.maxBytes);
        if (existing.sha256 === attachment.sha256 && existing.size === attachment.size) return { ...attachment, path: filename };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (cacheFile) {
      try {
        const cached = await fileDigest(cacheFile, this.maxBytes);
        if (cached.sha256 === attachment.sha256 && cached.size === attachment.size) {
          await copyFile(cacheFile, filename);
          return { ...attachment, path: filename };
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let response;
    try {
      const source = attachmentSourceFor(request, attachment);
      const downloadPath = source
        ? `/api/rooms/${encodeURIComponent(source.roomId)}/attachments/${encodeURIComponent(attachment.id)}?eventId=${encodeURIComponent(source.eventId)}`
        : `/api/attachments/${encodeURIComponent(attachment.id)}`;
      response = scoped ? await this.matrix.downloadMedia(attachment.contentUri, { signal })
        : await this.fetch(new URL(downloadPath, this.coreUrl), {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
    } catch (cause) { throw Object.assign(new Error(`Attachment download failed: ${cause.message}`), { networkError: true, cause }); }
    if (!response.ok || !response.body) throw Object.assign(new Error(`Attachment download HTTP ${response.status}`), { status: response.status });
    const temporary = `${filename}.${randomUUID()}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const check = new Transform({ transform: (chunk, _encoding, callback) => {
      size += chunk.length;
      if (size > this.maxBytes) return callback(new Error('Attachment exceeds this node’s file size limit'));
      hash.update(chunk);
      callback(null, chunk);
    } });
    let received = false;
    try {
      await pipeline(Readable.fromWeb(response.body), check, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      received = true;
      const sha256 = hash.digest('hex');
      if (attachment.sha256 && attachment.sha256 !== sha256) throw new Error('Downloaded attachment checksum does not match its message');
      if (Number.isInteger(attachment.size) && attachment.size !== size) throw new Error('Downloaded attachment length does not match its message');
      await rename(temporary, filename);
      if (cacheFile) {
        await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
        await copyFile(filename, cacheFile);
      }
      return { ...attachment, path: filename, sha256, size };
    } catch (error) {
      const code = error.cause?.code || error.code;
      if (!received && (['ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code) || String(code || '').startsWith('UND_ERR_'))) {
        error.networkError = true;
      }
      throw error;
    } finally { await rm(temporary, { force: true }); }
  }

  async upload(artifact, request, signal) {
    await this.work?.check(request, 'upload');
    const workspace = await realpath(request.workdir);
    const filename = await realpath(artifact.path);
    if (request.executionMode !== 'native' && !filename.startsWith(workspace + path.sep)) throw new Error('Task artifact is outside its working directory');
    const actual = await fileDigest(filename, this.maxBytes);
    if (artifact.sha256 && artifact.sha256 !== actual.sha256) throw new Error('Task artifact changed after verification');
    if (Number.isInteger(artifact.size) && artifact.size !== actual.size) throw new Error('Task artifact length changed after verification');
    const url = new URL('/api/attachments', this.coreUrl);
    url.searchParams.set('filename', artifact.name || path.basename(filename));
    let response;
    try { response = await this.fetch(url, { method: 'POST', redirect: 'error', headers: {
      Authorization: `Bearer ${this.accessToken}`, 'Content-Type': artifact.mimeType || 'application/octet-stream',
      'Content-Length': String(actual.size), 'X-Upload-Id': `artifact-${digest(`${request.botId}\0${request.requestId}\0${filename}\0${actual.sha256}`)}`,
    }, body: createReadStream(filename), duplex: 'half',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
    } catch (cause) { throw Object.assign(new Error(`Artifact upload failed: ${cause.message}`), { networkError: true, cause }); }
    let body;
    try { body = await response.json(); }
    catch (cause) { throw Object.assign(new Error('Artifact upload receipt is unreadable'), { networkError: true, cause }); }
    if (!response.ok) throw Object.assign(new Error(body.error || `Artifact upload HTTP ${response.status}`), { status: response.status });
    if (!body.attachment?.id || body.attachment.sha256 !== actual.sha256 || body.attachment.size !== actual.size) {
      throw new Error('Artifact upload returned an inconsistent file receipt');
    }
    let observationPending = false;
    try { await this.work?.check(request, 'observe', { effectStatus: 'completed', callId: `upload:${body.attachment.id}` }); }
    catch { observationPending = true; }
    return { ...body.attachment, ...(observationPending ? { observationPending: true } : {}) };
  }
}
