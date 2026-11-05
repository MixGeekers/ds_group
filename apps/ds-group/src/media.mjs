import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

export const MAX_ATTACHMENTS = 10;
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function uploadName(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure(400, 'A valid filename is required');
  }
  const name = path.posix.basename(value.replaceAll('\\', '/')).normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name) > 255) throw failure(400, 'Filename is too long or invalid');
  return name;
}

function uploadType(value) {
  const mimeType = String(value || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) throw failure(400, 'Invalid file content type');
  return mimeType;
}

function descriptor(row) {
  return {
    id: row.id, name: row.name, mimeType: row.mime_type, size: row.size,
    sha256: row.sha256, contentUri: row.content_uri, createdAt: row.created_at,
  };
}

function byteRange(value, size) {
  const match = typeof value === 'string' && /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw failure(400, 'Invalid byte range');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

async function* selectBytes(stream, { start, end }) {
  let offset = 0;
  for await (const chunk of stream) {
    const first = Math.max(0, start - offset);
    const last = Math.min(chunk.length, end - offset + 1);
    if (first < last) yield chunk.subarray(first, last);
    offset += chunk.length;
    if (offset > end) return;
  }
  throw failure(502, 'Media ended before the requested byte range');
}

export class MediaService {
  constructor({ dataRoot, maxBytes = DEFAULT_MAX_UPLOAD_BYTES }) {
    this.maxBytes = Number(maxBytes);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Attachment size limit must be a positive integer');
    this.directory = path.join(dataRoot, 'media-staging');
    this.db = new DatabaseSync(path.join(dataRoot, 'media.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, upload_id TEXT NOT NULL,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        status TEXT NOT NULL, content_uri TEXT, created_at TEXT NOT NULL,
        UNIQUE(owner_id,upload_id)
      );
      UPDATE attachments SET status='failed' WHERE status='uploading';`);
    this.uploads = new Map();
  }

  get(id) {
    if (typeof id !== 'string' || !/^attachment-[a-f0-9-]{36}$/.test(id)) throw failure(404, 'Attachment not found');
    const row = this.db.prepare("SELECT * FROM attachments WHERE id=? AND status='ready'").get(id);
    if (!row) throw failure(404, 'Attachment not found');
    return descriptor(row);
  }

  resolve(values = []) {
    if (!Array.isArray(values) || values.length > MAX_ATTACHMENTS) throw failure(400, `A message can contain up to ${MAX_ATTACHMENTS} attachments`);
    const ids = values.map(value => typeof value === 'string' ? value : value?.id);
    if (ids.some(id => typeof id !== 'string')) throw failure(400, 'Each attachment needs its uploaded ID');
    return [...new Set(ids)].map(id => this.get(id));
  }

  async receive(request, filename, mimeType) {
    const declaredSize = request.headers['content-length'];
    if (declaredSize !== undefined && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > this.maxBytes)) {
      request.resume();
      throw failure(413, `File exceeds the ${this.maxBytes}-byte upload limit`);
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, randomUUID());
    const file = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    let received = false;
    try {
      // Do not destroy the HTTP socket on a bounded-read failure, so the client
      // can receive the 413 response while the remaining request is drained.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > this.maxBytes) {
          request.resume();
          throw failure(413, `File exceeds the ${this.maxBytes}-byte upload limit`);
        }
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (declaredSize !== undefined && size !== Number(declaredSize)) throw failure(400, 'Upload was interrupted');
      received = true;
      return { temporary, name: filename, mimeType, size, sha256: hash.digest('hex') };
    } finally {
      await file.close();
      if (!received) await rm(temporary, { force: true });
    }
  }

  async upload({ request, filename, ownerId, client, signal }) {
    const uploadId = request.headers['x-upload-id'];
    if (typeof uploadId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(uploadId)) {
      request.resume();
      throw failure(400, 'A stable X-Upload-Id is required');
    }
    const name = uploadName(filename);
    const mimeType = uploadType(request.headers['content-type']);
    const received = await this.receive(request, name, mimeType);
    const key = JSON.stringify([ownerId, uploadId]);
    try {
      const current = this.uploads.get(key);
      if (current) await current;
      const previous = this.db.prepare('SELECT * FROM attachments WHERE owner_id=? AND upload_id=?').get(ownerId, uploadId);
      if (previous && (previous.sha256 !== received.sha256 || previous.name !== name || previous.mime_type !== mimeType)) {
        throw failure(409, 'This upload ID belongs to a different file');
      }
      if (previous?.status === 'ready') return descriptor(previous);
      const work = this.publish({ client, ownerId, uploadId, received, previous, signal });
      this.uploads.set(key, work);
      try { return await work; }
      finally { if (this.uploads.get(key) === work) this.uploads.delete(key); }
    } finally {
      await rm(received.temporary, { force: true });
    }
  }

  async publish({ client, ownerId, uploadId, received, previous, signal }) {
    const id = previous?.id || `attachment-${randomUUID()}`;
    const createdAt = previous?.created_at || new Date().toISOString();
    if (!previous) {
      this.db.prepare("INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', NULL, ?)")
        .run(id, ownerId, uploadId, received.name, received.mimeType, received.size, received.sha256, createdAt);
    } else {
      this.db.prepare("UPDATE attachments SET status='uploading' WHERE id=?").run(id);
    }
    const body = createReadStream(received.temporary);
    try {
      const result = await client.uploadMedia(body, { filename: received.name, mimeType: received.mimeType, size: received.size, signal });
      if (typeof result.content_uri !== 'string' || !result.content_uri.startsWith('mxc://')) throw new Error('Matrix returned an invalid media receipt');
      this.db.prepare("UPDATE attachments SET status='ready',content_uri=? WHERE id=?").run(result.content_uri, id);
      return this.get(id);
    } catch (error) {
      this.db.prepare("UPDATE attachments SET status='failed' WHERE id=?").run(id);
      throw error;
    } finally {
      body.destroy();
      await finished(body).catch(() => {});
    }
  }

  async download({ id, client, request, response, asDownload = false }) {
    const attachment = this.get(id);
    const range = request.headers.range;
    const selected = range ? byteRange(range, attachment.size) : undefined;
    if (selected === null) {
      response.writeHead(416, { 'Content-Range': `bytes */${attachment.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
      response.end();
      return;
    }
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnected);
    try {
      const upstream = await client.downloadMedia(attachment.contentUri, { range, signal: controller.signal });
      if (upstream.status === 200 && upstream.headers.has('content-length') && Number(upstream.headers.get('content-length')) !== attachment.size) {
        await upstream.body?.cancel();
        throw failure(502, 'Media size differs from the uploaded attachment');
      }
      const contentRange = selected && `bytes ${selected.start}-${selected.end}/${attachment.size}`;
      if (upstream.status === 206 && (!selected || upstream.headers.get('content-range') !== contentRange
        || (upstream.headers.has('content-length') && Number(upstream.headers.get('content-length')) !== selected.end - selected.start + 1))) {
        await upstream.body?.cancel();
        throw failure(502, 'Media returned an unexpected byte range');
      }
      const headers = {
        'Content-Type': attachment.mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        'Content-Disposition': `${asDownload ? 'attachment' : 'inline'}; filename="download"; filename*=UTF-8''${encodeURIComponent(attachment.name).replaceAll("'", '%27')}`,
        'Accept-Ranges': 'bytes',
      };
      for (const name of ['content-length', 'content-range']) {
        if (upstream.headers.has(name)) headers[name] = upstream.headers.get(name);
      }
      if (selected) {
        headers['content-length'] = String(selected.end - selected.start + 1);
        headers['content-range'] = contentRange;
      }
      response.writeHead(selected ? 206 : upstream.status, headers);
      if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body);
        // Synapse storage providers can return a full stream even when Range was requested.
        await pipeline(selected && upstream.status === 200 ? Readable.from(selectBytes(stream, selected)) : stream, response);
      }
      else response.end();
    } finally {
      response.off('close', disconnected);
    }
  }

  async close() {
    await Promise.allSettled(this.uploads.values());
    this.db.close();
  }
}
