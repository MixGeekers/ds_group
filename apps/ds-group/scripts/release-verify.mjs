import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { packageRoot } from '../src/paths.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const stringAt = (header, offset, length) => header.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');

export function readReleaseArchive(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 });
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const checksum = parseInt(stringAt(header, 148, 8), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error('Invalid tar header checksum');
    const prefix = stringAt(header, 345, 155);
    const filename = [prefix, stringAt(header, 0, 100)].filter(Boolean).join('/');
    if (!filename || filename.startsWith('/') || filename.includes('\\') || filename.includes(':')
      || filename.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe release archive path');
    if (header[156] !== 48 || stringAt(header, 257, 6) !== 'ustar') throw new Error('Only regular USTAR files are accepted');
    const size = parseInt(stringAt(header, 124, 12), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid archive size');
    if (entries.has(filename)) throw new Error('Duplicate archive entry');
    entries.set(filename, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!entries.size) throw new Error('Empty release archive');
  return entries;
}

export async function verifyRelease({ archive, extract } = {}) {
  if (!archive) {
    const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    archive = path.join(packageRoot, '.local', 'release', `ds-group-${pkg.version}-source.tar.gz`);
  }
  const archiveBytes = await readFile(archive);
  const checksums = await readFile(path.join(path.dirname(archive), 'SHA256SUMS'), 'utf8');
  const expected = checksums.split('\n').find(line => line.endsWith(`  ${path.basename(archive)}`))?.split('  ')[0];
  if (!expected || expected !== sha256(archiveBytes)) throw new Error('Release archive SHA256 does not match SHA256SUMS');
  const entries = readReleaseArchive(archiveBytes);
  const manifestEntry = [...entries].find(([filename]) => /^[^/]+\/release-manifest\.json$/.test(filename));
  if (!manifestEntry) throw new Error('Release archive has no manifest');
  const externalManifest = await readFile(path.join(path.dirname(archive), 'release-manifest.json'));
  const manifestChecksum = checksums.split('\n').find(line => line.endsWith('  release-manifest.json'))?.split('  ')[0];
  if (sha256(externalManifest) !== manifestChecksum || !externalManifest.equals(manifestEntry[1])) throw new Error('Release manifest does not match the verified archive');
  const manifest = JSON.parse(manifestEntry[1].toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.name !== 'ds-group' || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest');
  const prefix = `ds-group-${manifest.version}/`;
  if (manifestEntry[0] !== `${prefix}release-manifest.json`) throw new Error('Archive root does not match release version');
  const seen = new Set();
  for (const file of manifest.files) {
    const bytes = entries.get(`${prefix}${file.path}`);
    if (seen.has(file.path) || !bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Release file verification failed: ${file.path}`);
    seen.add(file.path);
  }
  if (entries.size !== manifest.files.length + 1) throw new Error('Release archive contains unlisted files');
  if (extract) {
    await mkdir(extract, { recursive: true });
    if ((await readdir(extract)).length) throw new Error('Extraction destination must be empty');
    for (const [filename, bytes] of entries) {
      const destination = path.join(extract, ...filename.slice(prefix.length).split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o644 });
    }
  }
  return { version: manifest.version, files: manifest.files.length, sha256: expected, extracted: extract || null };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const options = {};
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift();
    if (!['--archive', '--extract'].includes(option) || !args.length) throw new Error('Use release-verify.mjs [--archive FILE] [--extract EMPTY_DIRECTORY]');
    options[option.slice(2)] = path.resolve(args.shift());
  }
  console.log(JSON.stringify(await verifyRelease(options), null, 2));
}
