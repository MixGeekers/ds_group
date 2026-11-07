import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../src/paths.mjs';
import { releaseVersion } from './release-version.mjs';
import { projectLicense } from './release-content.mjs';

export function releaseMetadata({ version, tag, repository }) {
  const { prerelease, npmTag } = releaseVersion(version);
  if (tag !== `ds-group-v${version}`) throw new Error(`Release tag must exactly match ds-group-v${version}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Invalid GitHub repository');
  return {
    version,
    tag,
    image: `ghcr.io/${repository.split('/')[0].toLowerCase()}/ds-group`,
    archive: `ds-group-${version}-source.tar.gz`,
    prerelease: String(prerelease),
    npmTag,
    npmArchive: `dscord-${version}.tgz`,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(packageRoot, 'package-lock.json'), 'utf8'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Package and lock versions differ');
  await projectLicense(packageRoot, pkg);
  if (process.env.GITHUB_REF_TYPE !== 'tag') throw new Error('Publishing requires a version tag');
  const metadata = releaseMetadata({ version: pkg.version, tag: process.env.GITHUB_REF_NAME, repository: process.env.GITHUB_REPOSITORY });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(metadata, null, 2));
}
