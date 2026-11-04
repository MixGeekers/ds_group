import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseMetadata } from '../scripts/release-metadata.mjs';

test('release publishing binds the package version to an exact DS-Group tag', () => {
  const metadata = releaseMetadata({ version: '0.1.0', tag: 'ds-group-v0.1.0', repository: 'MixGeekers/shiyu' });
  assert.equal(metadata.image, 'ghcr.io/mixgeekers/ds-group');
  assert.equal(metadata.prerelease, 'false');
  assert.throws(() => releaseMetadata({ version: '0.1.0', tag: 'v0.1.0', repository: 'MixGeekers/shiyu' }), /exactly match/);
  assert.throws(() => releaseMetadata({ version: '0.1.0', tag: 'ds-group-v0.2.0', repository: 'MixGeekers/shiyu' }), /exactly match/);
  assert.equal(releaseMetadata({ version: '0.2.0-rc.1', tag: 'ds-group-v0.2.0-rc.1', repository: 'MixGeekers/shiyu' }).prerelease, 'true');
});
