import test from 'node:test';
import assert from 'node:assert/strict';
import { boundTaskRequest } from '../src/node-request.mjs';

const bytes = request => Buffer.byteLength(JSON.stringify({ ...request, async: true }), 'utf8');
const request = () => ({ requestId: 'current-task', botId: '@finance:test',
  event: { eventId: '$current', body: '核对'.repeat(8000), attachments: [{ id: 'current-file' }] },
  history: Array.from({ length: 40 }, (_, index) => ({ eventId: `$history-${index}`, body: '中'.repeat(16000) })),
  workdir: '/task/current', files: [{ id: 'current-file', path: '/task/current/inputs/费用.xlsx', name: '费用.xlsx',
    extraction: { type: 'xlsx', textPath: '/task/current/extracted/费用.txt', supported: true } }],
  historyWarnings: ['An earlier source was unavailable'],
});

test('request budget counts UTF8 bytes and keeps current task files with the newest complete history', () => {
  const input = request();
  const original = structuredClone(input);
  assert.ok(bytes(input) > 512000);
  const bounded = boundTaskRequest(input);
  assert.ok(bytes(bounded) <= 500000);
  assert.ok(bounded.history.length > 0 && bounded.history.length < input.history.length);
  assert.deepEqual(bounded.history, input.history.slice(-bounded.history.length));
  assert.equal(bounded.history.at(-1).eventId, '$history-39');
  assert.deepEqual(bounded.event, input.event);
  assert.deepEqual(bounded.files, input.files);
  assert.equal(bounded.workdir, input.workdir);
  assert.equal(bounded.historyWarnings[0], input.historyWarnings[0]);
  assert.ok(bounded.historyWarnings.at(-1).includes(String(input.history.length - bounded.history.length)));
  assert.deepEqual(input, original);
  assert.notEqual(bounded, input);
  assert.notEqual(bounded.history, input.history);
  assert.notEqual(bounded.historyWarnings, input.historyWarnings);
});

test('the omission warning participates in the body limit and repeated bounding is deterministic', () => {
  const input = { event: { body: 'current' }, history: Array.from({ length: 3 }, (_, index) => ({ eventId: String(index), body: 'x'.repeat(200) })) };
  const oneOmitted = { ...input, history: input.history.slice(1),
    historyWarnings: ['为满足请求大小限制，本次额外省略最早的 1 条历史消息。'] };
  const maxBytes = bytes(oneOmitted) - 1;
  const first = boundTaskRequest(input, { maxBytes });
  assert.deepEqual(first.history, [input.history[2]]);
  assert.ok(first.historyWarnings[0].includes('2 条'));
  assert.ok(bytes(first) <= maxBytes);
  assert.deepEqual(boundTaskRequest(input, { maxBytes }), first);
  assert.deepEqual(boundTaskRequest(first, { maxBytes }), first);
});

test('adding file metadata can trim more history while preserving previous warnings and all explicit files', () => {
  const first = boundTaskRequest(request());
  const input = { ...first, files: [...first.files, { id: 'another-file', path: '/task/second', name: 'a'.repeat(90000) }] };
  const bounded = boundTaskRequest(input);
  assert.ok(bytes(bounded) <= 500000);
  assert.ok(bounded.history.length < first.history.length);
  assert.deepEqual(bounded.files, input.files);
  assert.deepEqual(bounded.historyWarnings.slice(0, first.historyWarnings.length), first.historyWarnings);
  assert.equal(bounded.historyWarnings.length, first.historyWarnings.length + 1);
});

test('oversized mandatory task input is rejected instead of truncating the current event or file metadata', () => {
  const input = { event: { body: '中'.repeat(200) }, history: [{ body: 'old' }], files: [{ id: 'keep-this-file' }] };
  const original = structuredClone(input);
  assert.throws(() => boundTaskRequest(input, { maxBytes: 300 }), error => error.code === 'TASK_REQUEST_TOO_LARGE' && error.status === 413);
  assert.deepEqual(input, original);
  assert.throws(() => boundTaskRequest({ event: { body: 'x' }, files: [{ name: 'x'.repeat(512000) }] }), { code: 'TASK_REQUEST_TOO_LARGE' });
});

test('small requests keep their schema and invalid body limits fail before serializing', () => {
  const input = { requestId: 'small', event: { body: 'hello' } };
  assert.deepEqual(boundTaskRequest(input), input);
  for (const maxBytes of [0, -1, 512001, 1.5, Infinity]) assert.throws(() => boundTaskRequest(input, { maxBytes }), RangeError);
  assert.throws(() => boundTaskRequest({ ...input, history: 'invalid' }), TypeError);
  assert.throws(() => boundTaskRequest({ ...input, historyWarnings: [1] }), TypeError);
});
