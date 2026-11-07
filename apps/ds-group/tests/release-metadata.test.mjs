import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseMetadata } from '../scripts/release-metadata.mjs';

test('release publishing binds the package version to an exact DS-Group tag', () => {
  const metadata = releaseMetadata({ version: '0.1.0', tag: 'ds-group-v0.1.0', repository: 'MixGeekers/shiyu' });
  assert.equal(metadata.image, 'ghcr.io/mixgeekers/ds-group');
  assert.equal(metadata.prerelease, 'false');
  assert.equal(metadata.npmTag, 'latest');
  assert.equal(metadata.npmArchive, 'dscord-0.1.0.tgz');
  assert.throws(() => releaseMetadata({ version: '0.1.0', tag: 'v0.1.0', repository: 'MixGeekers/shiyu' }), /exactly match/);
  assert.throws(() => releaseMetadata({ version: '0.1.0', tag: 'ds-group-v0.2.0', repository: 'MixGeekers/shiyu' }), /exactly match/);
  assert.equal(releaseMetadata({ version: '0.2.0-rc.1', tag: 'ds-group-v0.2.0-rc.1', repository: 'MixGeekers/shiyu' }).prerelease, 'true');
  assert.equal(releaseMetadata({ version: '0.2.0-rc.1', tag: 'ds-group-v0.2.0-rc.1', repository: 'MixGeekers/shiyu' }).npmTag, 'rc');
  assert.equal(releaseMetadata({ version: '0.4.0-alpha.1', tag: 'ds-group-v0.4.0-alpha.1', repository: 'MixGeekers/dscord' }).npmTag, 'alpha');
  for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3+build', 'v1.2.3']) {
    assert.throws(() => releaseMetadata({ version, tag: `ds-group-v${version}`, repository: 'MixGeekers/dscord' }), /canonical SemVer/);
  }
});
