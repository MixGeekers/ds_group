#!/usr/bin/env node
/**
 * Read-only extractor for the installed DeepSeek Harness app.asar archive.
 *
 * The installed DSH SDK packages live inside Electron's ASAR container. This
 * script implements the public ASAR container format (pickle header followed by
 * concatenated file payloads) so fixed-host contract review does not need to
 * run Electron, install extra packages, or modify the installed app.
 *
 * Container layout, as observed in the installed 0.2.1-rc.5 archive and
 * cross-checked against known SHA256 values:
 *   [0:4]   UInt32 constant 4 (payload size of the first pickle)
 *   [4:8]   UInt32 headerSize; dataOffset = 8 + headerSize
 *   [8:12]  UInt32 header payload size (headerSize - 4)
 *   [12:16] UInt32 JSON string length
 *   [16:..] UTF-8 JSON directory tree, zero-padded to a 4-byte boundary
 *   [dataOffset:..] concatenated file payloads; header entries carry string
 *                   offsets relative to dataOffset.
 *
 * Usage:
 *   node scripts/read-dsh-asar.mjs list [prefix]
 *   node scripts/read-dsh-asar.mjs cat <archive-relative-path>
 *   node scripts/read-dsh-asar.mjs hash <archive-relative-path>...
 *
 * The archive path is process.env.DSH_ASAR or the default installed app path.
 * Nothing is written to disk; content is printed or hashed in memory.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

function archivePath() {
  const path = process.env.DSH_ASAR || DEFAULT_ASAR;
  if (!existsSync(path)) throw new Error(`DSH ASAR archive not found at ${path}; set DSH_ASAR`);
  return path;
}

function fail(message) {
  process.stderr.write(`read-dsh-asar: ${message}\n`);
  process.exit(1);
}

async function readExact(handle, start, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, start + done);
    if (bytesRead <= 0) throw new Error(`Unexpected end of archive at offset ${start + done}`);
    done += bytesRead;
  }
  return buffer;
}

/** Parse the ASAR header. Returns { header, dataOffset }. */
async function readHeader(handle) {
  const prefix = await readExact(handle, 0, 16);
  const constant = prefix.readUInt32LE(0);
  const headerSize = prefix.readUInt32LE(4);
  const headerPayloadSize = prefix.readUInt32LE(8);
  const jsonLength = prefix.readUInt32LE(12);
  if (constant !== 4) throw new Error(`Unexpected ASAR first pickle size ${constant}`);
  if (headerPayloadSize !== headerSize - 4) throw new Error('Unexpected ASAR header payload size');
  const dataOffset = 8 + headerSize;
  const paddedLength = 16 + Math.ceil(jsonLength / 4) * 4;
  if (dataOffset !== paddedLength) throw new Error('Unexpected ASAR header/data alignment');
  const headerBuffer = await readExact(handle, 16, jsonLength);
  const header = JSON.parse(headerBuffer.toString('utf8'));
  return { header, dataOffset };
}

function walk(node, prefix, out) {
  if (!node || typeof node !== 'object') return;
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix ? `${prefix}/${name}` : name, out);
    return;
  }
  if (typeof node.offset === 'string' && typeof node.size === 'number') {
    out.push({ path: prefix, size: node.size, executable: node.executable === true });
  }
}

async function list(header, prefix) {
  const entries = [];
  walk(header, '', entries);
  const normalized = prefix ? prefix.replace(/\/$/, '') : '';
  for (const entry of entries) {
    if (!normalized || entry.path === normalized || entry.path.startsWith(`${normalized}/`)) {
      process.stdout.write(`${entry.size}\t${entry.path}\n`);
    }
  }
}

async function readFileBytes(handle, header, dataOffset, path) {
  let node = header;
  for (const part of path.split('/')) {
    if (!node?.files?.[part]) throw new Error(`No such archive entry: ${path}`);
    node = node.files[part];
  }
  if (typeof node.offset !== 'string' || typeof node.size !== 'number') throw new Error(`Archive entry is not a file: ${path}`);
  const bytes = node.size > 0 ? await readExact(handle, dataOffset + Number(node.offset), node.size) : Buffer.alloc(0);
  return { bytes, executable: node.executable === true };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) fail('usage: read-dsh-asar.mjs list [prefix] | cat <path> | hash <path>...');
  const handle = await open(archivePath(), 'r');
  try {
    const { header, dataOffset } = await readHeader(handle);
    if (command === 'list') return list(header, rest[0]);
    if (command === 'cat') {
      if (!rest[0]) fail('cat requires an archive-relative path');
      const { bytes } = await readFileBytes(handle, header, dataOffset, rest[0]);
      process.stdout.write(bytes);
      return;
    }
    if (command === 'hash') {
      if (rest.length === 0) fail('hash requires at least one archive-relative path');
      for (const path of rest) {
        const { bytes } = await readFileBytes(handle, header, dataOffset, path);
        process.stdout.write(`${createHash('sha256').update(bytes).digest('hex')}\t${bytes.length}\t${path}\n`);
      }
      return;
    }
    fail(`unknown command: ${command}`);
  } finally {
    await handle.close();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
