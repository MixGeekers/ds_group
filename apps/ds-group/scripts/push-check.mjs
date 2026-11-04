#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { localPath } from '../src/paths.mjs';

const baseUrl = process.env.DS_GROUP_CORE_URL || 'http://127.0.0.1:18100';
const setup = JSON.parse(await readFile(localPath('matrix-setup.json'), 'utf8'));
const human = setup.participants.find(person => person.kind === 'human');
if (!human) throw new Error('A synthetic human account is required');

const configResponse = await fetch(`${baseUrl}/api/push/config`);
assert.equal(configResponse.status, 200);
const config = await configResponse.json();
assert.equal(config.enabled, true);
assert.equal(config.requiresSecureContext, true);
assert.equal(Buffer.from(config.publicKey, 'base64url').length, 65);
assert.equal('privateKey' in config, false);

const headers = { Authorization: `Bearer ${human.accessToken}` };
const subscriptionsResponse = await fetch(`${baseUrl}/api/push/subscriptions`, { headers });
assert.equal(subscriptionsResponse.status, 200);
const result = await subscriptionsResponse.json();
const subscriptions = Array.isArray(result) ? result : result.subscriptions;
assert.ok(Array.isArray(subscriptions));
assert.ok(subscriptions.every(subscription => !('endpoint' in subscription) && !('keys' in subscription)));

let emptyTestRejected = null;
if (subscriptions.length === 0) {
  const response = await fetch(`${baseUrl}/api/push/test`, { method: 'POST', headers });
  assert.equal(response.status, 404);
  emptyTestRejected = true;
}

console.log(JSON.stringify({
  status: 'passed', evidenceLevel: 'real-local-http-push-configuration',
  checks: { publicKeyAvailable: true, privateKeyAbsent: true, accountScopedDeviceList: true, emptyTestRejected },
  registeredDevices: subscriptions.length, pushMessagesSent: 0, modelCalls: 0,
  limitations: ['Does not verify subscription at a browser push service', 'Does not verify notification display on a physical phone'],
}, null, 2));
