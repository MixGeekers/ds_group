import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewArtifactBindings } from '../scripts/platform-natural-review-check.mjs';

const report = { bots: [{ id: 'bot' }] }, file = { id: 'file-1', name: 'packing.mjs', sha256: 'digest', size: 10 };
const ledger = [{ sender: 'bot', type: 'm.room.message', event_id: 'message', roomKey: 'private-b', content: { 'org.ds_group': { attachments: [file] } } },
  { sender: 'bot', type: 'm.room.member', event_id: 'membership', content: {} }];
const received = { ...file, eventId: 'message', room: 'private-b' };
test('post-run artifact binding follows actual message audience and ignores membership events', () => {
  assert.equal(reviewArtifactBindings(report, ledger, [received]).length, 1);
});
test('missing, duplicate or incorrectly attributed deliveries cannot pass review completeness', () => {
  assert.throws(() => reviewArtifactBindings(report, ledger, []), /Every actual attachment/);
  assert.throws(() => reviewArtifactBindings(report, ledger, [received, received]), /Duplicate/);
  assert.throws(() => reviewArtifactBindings(report, ledger, [{ ...received, room: 'work' }]), /audience/);
  assert.throws(() => reviewArtifactBindings(report, ledger, [{ ...received, eventId: 'membership' }]), /Missing actual artifact/);
});
