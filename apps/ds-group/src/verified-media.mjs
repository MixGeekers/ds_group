import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";

export const DEFAULT_VERIFIED_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const fail = (status, message, code = "MEDIA_INTEGRITY_FAILED") =>
  Object.assign(new Error(message), { status, code });
function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`${name} must be a positive safe integer`);
  return number;
}

/** Stream to a bounded private file, verify it, then send verified bytes only.
 * A checksum failure cannot become a completed (and cacheable) browser blob.
 */
export class VerifiedMedia {
  constructor({
    dataRoot,
    maxBytes = DEFAULT_VERIFIED_DOWNLOAD_BYTES,
    concurrency = 2,
    rangeFor,
    headersFor,
  }) {
    this.maxBytes = positiveInteger(maxBytes, "verifiedDownloadMaxBytes");
    this.concurrency = positiveInteger(
      concurrency,
      "verifiedDownloadConcurrency",
    );
    if (
      this.concurrency > 16 ||
      !Number.isSafeInteger(this.maxBytes * this.concurrency)
    )
      throw new Error("Verified media resource budget is too large");
    this.directory = path.join(dataRoot, "media-verified-downloads");
    this.rangeFor = rangeFor;
    this.headersFor = headersFor;
    this.queueLimit = 16;
    this.active = 0;
    this.reserved = 0;
    this.waiters = [];
    this.files = new Set();
    this.controllers = new Set();
    this.tasks = new Set();
    this.closing = false;
  }

  async acquire(signal) {
    signal.throwIfAborted();
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    if (this.waiters.length >= this.queueLimit)
      throw Object.assign(
        fail(
          429,
          "Verified downloads are busy; try again shortly",
          "MEDIA_VERIFICATION_BUSY",
        ),
        { retryAfterMs: 1000 },
      );
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.waiters = this.waiters.filter((row) => row !== waiter);
          reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve();
    } else this.active--;
  }

  async checkStorage() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let orphanBytes = 0;
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      const filename = path.join(this.directory, entry.name);
      if (!entry.isFile() || this.files.has(filename)) continue;
      try {
        orphanBytes += (await stat(filename)).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (orphanBytes + this.reserved > this.maxBytes * this.concurrency) {
      throw fail(
        507,
        "Verified media staging budget is full",
        "MEDIA_VERIFICATION_STORAGE_FULL",
      );
    }
  }

  download(options) {
    const task = this.perform(options);
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  async perform({
    attachment,
    client,
    request,
    response,
    asDownload = false,
    authorize,
  }) {
    if (this.closing) throw fail(503, "Verified media service is stopping");
    if (attachment.size > this.maxBytes)
      throw fail(
        413,
        `File exceeds the ${this.maxBytes}-byte verified download limit`,
        "MEDIA_VERIFICATION_LIMIT",
      );
    const selected = request.headers.range
      ? this.rangeFor(request.headers.range, attachment.size)
      : undefined;
    if (selected === null) {
      response.writeHead(416, {
        "Content-Range": `bytes */${attachment.size}`,
        "Cache-Control": "private, no-store",
      });
      response.end();
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(300000),
    ]);
    const disconnected = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once("close", disconnected);
    let acquired = false;
    let reserved = false;
    let created = false;
    const filename = path.join(
      this.directory,
      `verify-${process.pid}-${randomUUID()}.part`,
    );
    try {
      await this.acquire(signal);
      acquired = true;
      this.reserved += attachment.size;
      reserved = true;
      this.files.add(filename);
      await this.checkStorage();
      if (authorize) await authorize();
      // A Range response is also derived from a verified full object. Never
      // equate the hash of an isolated range with the whole-file SHA256.
      const upstream = await client.downloadMedia(attachment.contentUri, {
        signal,
      });
      if (upstream.status !== 200) {
        await upstream.body?.cancel();
        throw fail(502, "Expected a complete media object for verification");
      }
      const length = upstream.headers.get("content-length");
      const encoding = upstream.headers.get("content-encoding");
      if (
        length !== null &&
        (!encoding || encoding === "identity") &&
        (!/^\d+$/.test(length) || Number(length) !== attachment.size)
      ) {
        await upstream.body?.cancel();
        throw fail(
          502,
          "Media length header differs from the proven attachment",
        );
      }
      let bytes = 0;
      const digest = createHash("sha256");
      const verifier = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > attachment.size)
            return callback(
              fail(502, "Media contains more bytes than the proven attachment"),
            );
          digest.update(chunk);
          callback(null, chunk);
        },
        flush(callback) {
          if (bytes !== attachment.size)
            return callback(
              fail(502, "Media ended before the proven attachment length"),
            );
          if (digest.digest("hex") !== attachment.sha256)
            return callback(
              fail(502, "Media SHA256 differs from the proven attachment"),
            );
          callback();
        },
      });
      const destination = createWriteStream(filename, {
        flags: "wx",
        mode: 0o600,
      });
      destination.once("open", () => {
        created = true;
      });
      await pipeline(
        upstream.body ? Readable.fromWeb(upstream.body) : Readable.from([]),
        verifier,
        destination,
        { signal },
      );
      if (authorize) await authorize();
      signal.throwIfAborted();
      const headers = {
        ...this.headersFor(attachment, asDownload),
        "Content-Length": String(
          selected ? selected.end - selected.start + 1 : attachment.size,
        ),
      };
      if (selected)
        headers["Content-Range"] =
          `bytes ${selected.start}-${selected.end}/${attachment.size}`;
      response.writeHead(selected ? 206 : 200, headers);
      await pipeline(
        createReadStream(
          filename,
          selected ? { start: selected.start, end: selected.end } : {},
        ),
        response,
        { signal },
      );
    } catch (error) {
      if (error.status) throw error;
      if (error.code === "ENOSPC")
        throw fail(
          507,
          "Verified media staging storage is full",
          "MEDIA_VERIFICATION_STORAGE_FULL",
        );
      if (signal.aborted)
        throw fail(this.closing ? 503 : 408, "Verified download was cancelled");
      throw fail(502, "Media transfer could not be verified");
    } finally {
      response.off("close", disconnected);
      this.controllers.delete(controller);
      try {
        if (created) await rm(filename, { force: true });
      } finally {
        this.files.delete(filename);
        if (reserved) this.reserved -= attachment.size;
        if (acquired) this.release();
      }
    }
  }

  stop() {
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
  }
  async close() {
    this.stop();
    await Promise.allSettled([...this.tasks]);
  }
}
