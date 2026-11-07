// One version identifies the source archive, container and npm package.
// Build metadata is excluded because '+' is not valid in a container tag.
const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`);

export function releaseVersion(version) {
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    throw new Error('Release version must be canonical SemVer without build metadata');
  }
  const prerelease = version.includes('-');
  const channel = prerelease ? version.split('-')[1].split('.')[0] : null;
  const npmTag = prerelease ? (['alpha', 'beta', 'rc'].includes(channel) ? channel : 'next') : 'latest';
  return { version, prerelease, npmTag };
}
