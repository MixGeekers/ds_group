import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalRestartRecord, auditNaturalRestarts } from '../scripts/platform-natural-maintenance.mjs';

const ids = [{ id: 'n0', sessionId: 's0' }, { id: 'n1', sessionId: 's1' }, { id: 'n2', sessionId: 's2' }];
const legacy = { before: ids, after: ids, identitiesPreserved: true, sessionsPreserved: true };
const time = n => new Date(n).toISOString();
const rows = [{ id: 'full-036', number: 36, completedAt: time(10000) },
  { id: 'full-037', number: 37, postedAt: 20000, completedAt: time(22000) },
  { id: 'full-038', number: 38, postedAt: 30000, completedAt: time(31000) }];
test('restart result identity arrays cannot overwrite its step or type', () => {
  const record = naturalRestartRecord(36, { ...legacy, type: 'wrong' }, time(15000));
  assert.equal(record.after, 36); assert.equal(record.type, 'native-restart');
  assert.deepEqual(record.identitiesAfter, ids); assert.deepEqual(record.identitiesBefore, ids);
  assert.equal(record.before, undefined);
  assert.equal([record].some(row => row.type === 'native-restart' && row.after === 36 && row.identitiesPreserved && row.sessionsPreserved), true);
});
test('new explicit identity fields use the same unambiguous restart contract', () => {
  const record = naturalRestartRecord(72, { identitiesBefore: ids, identitiesAfter: ids, identitiesPreserved: true, sessionsPreserved: true });
  assert.equal(record.after, 72); assert.deepEqual(record.identitiesAfter, ids);
});
test('historical overwritten boundary is independently located from rows and actual boot time', () => {
  const report = { rows, maintenance: [{ type: 'native-restart', ...legacy, at: time(15000) }] }, original = JSON.stringify(report);
  const audit = auditNaturalRestarts(report, { planned: [36, 72], hostBoots: [{ boot: 2, filename: 'host-2.log', bornAtMs: 14000 }] });
  assert.deepEqual(audit.verifiedBoundaries, [36]); assert.equal(audit.records[0].legacyAfterWasIdentityArray, true);
  assert.deepEqual(audit.plannedBoundaryChecks, [{ step: 36, passed: true }, { step: 72, passed: false }]);
  assert.equal(JSON.stringify(report), original);
});
test('a planned number alone never substitutes for missing row or boot evidence', () => {
  const report = { rows, maintenance: [naturalRestartRecord(36, legacy, time(15000))] };
  const noBoot = auditNaturalRestarts(report, { planned: [36] }); assert.equal(noBoot.records[0].restartEvidenceVerified, false);
  const noTime = auditNaturalRestarts({ rows, maintenance: [{ type: 'native-restart', ...legacy }] }, { planned: [36], hostBoots: [{ boot: 2, bornAtMs: 14000 }] });
  assert.equal(noTime.records[0].inferredStep, null); assert.deepEqual(noTime.verifiedBoundaries, []);
});
test('duplicated records do not count one host boot as two planned restarts', () => {
  const record = { type: 'native-restart', ...legacy, at: time(15000) };
  const audit = auditNaturalRestarts({ rows, maintenance: [record, record] }, { planned: [36, 72], hostBoots: [{ boot: 2, bornAtMs: 14000 }] });
  assert.deepEqual(audit.verifiedBoundaries, [36]); assert.equal(audit.records[1].repeatedBootEvidence, true);
});
test('changed native sessions fail identity evidence even when old booleans say preserved', () => {
  const report = { rows, maintenance: [{ type: 'native-restart', ...legacy, after: [{ id: 'n0', sessionId: 'different' }], at: time(15000) }] };
  const audit = auditNaturalRestarts(report, { planned: [36], hostBoots: [{ boot: 2, bornAtMs: 14000 }] });
  assert.equal(audit.records[0].restartEvidenceVerified, false); assert.deepEqual(audit.verifiedBoundaries, []);
});
