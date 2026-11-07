#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { packageRoot } from '../src/paths.mjs';
import { resolveDsh } from './runtime-config.mjs';

// Native DSH Sessions/tools; synthetic home authorization and scripted localhost provider.
// This does not substitute for the separate real federated Matrix / remote-model acceptance.
const hash = (value) => createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const basePort = Number(process.env.DS_GROUP_SCOPED_SMOKE_PORT || 24570);
assert.ok(
  Number.isSafeInteger(basePort) && basePort >= 1024 && basePort <= 65534,
  'DS_GROUP_SCOPED_SMOKE_PORT must be an integer from 1024 to 65534',
);
const directory = await realpath(
  await mkdtemp(path.join(tmpdir(), 'dscord-scoped-runtime-')),
);
const installation = await resolveDsh();
const botId = '@helper:a.runtime.test';
const ownerId = '@owner:a.runtime.test';
const privateMarker = `PRIVATE_OWNER_${hash(directory).slice(0, 12)}`;
const roomMarker = `SHARED_ROOM_${hash(directory).slice(0, 12)}`;
const otherMarker = `OTHER_ROOM_${hash(directory).slice(0, 12)}`;
const privateFile = path.join(directory, 'owner-private.txt');
await writeFile(privateFile, privateMarker);
const cases = new Map();
const checkCalls = [];
const ledger = [];
const providerCalls = [];
const report = {
  date: new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()),
  checkedAt: new Date().toISOString(),
  level: 'native-dsh-scripted-provider-synthetic-work-authority',
  modelCalls: 0,
  scriptedProviderCalls: 0,
  physicalHosts: 1,
  checks: [],
  status: 'failed',
  sourceHashes: {},
};
for (const file of [
  'dsh-plugin/runtime.mjs',
  'dsh-plugin/scoped-work.mjs',
  'src/bot-work.mjs',
  'src/bot-work-policy.mjs',
  'scripts/cross-server-runtime-smoke.mjs',
]) {
  report.sourceHashes[file] = hash(
    await readFile(path.join(packageRoot, file)),
  );
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
function completion(response, input, entry) {
  const item = {
    id: `scripted-${providerCalls.length}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          reasoning_content: 'Check the authorized task files.',
        },
        finish_reason: null,
      },
    ],
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify(item)}\n\n`);
  item.choices[0].delta = entry.tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `tool-${providerCalls.length}`,
            type: 'function',
            function: {
              name: entry.tool,
              arguments: JSON.stringify(entry.args),
            },
          },
        ],
      }
    : { content: JSON.stringify(entry.output || { text: 'Done.' }) };
  response.write(`data: ${JSON.stringify(item)}\n\n`);
  item.choices[0].delta = {};
  item.choices[0].finish_reason = entry.tool ? 'tool_calls' : 'stop';
  item.usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
  response.end(`data: ${JSON.stringify(item)}\n\ndata: [DONE]\n\n`);
}

const origin = `http://127.0.0.1:${basePort}`;
const bridge = `http://127.0.0.1:${basePort + 1}/api/ds-group-node`;
const model = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url === '/internal/bot-work/check') {
      checkCalls.push(input);
      const scenario = cases.get(input.requestId);
      if (!scenario?.work)
        return send(response, 403, { error: 'No synthetic work admission' });
      if (scenario.revoked)
        return input.stage === 'observe'
          ? send(response, 200, { authorized: false, late: true })
          : send(response, 403, { error: 'Revoked' });
      return send(response, 200, { authorized: true, work: scenario.work });
    }
    if (request.url.startsWith('/internal/model/')) {
      ledger.push({ route: request.url, input });
      return send(
        response,
        200,
        request.url.endsWith('/claim')
          ? { claimId: `scripted-claim-${ledger.length}` }
          : { recorded: true },
      );
    }
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(input.model, 'deepseek-v4.1-flash');
    await writeFile(
      path.join(directory, 'provider-last.json'),
      JSON.stringify(input, null, 2),
      { mode: 0o600 },
    );
    const messageTexts = input.messages
      .filter((message) => message.role === 'user')
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content || []).map((block) => block.text || '').join(''),
      );
    const currentText =
      messageTexts.findLast((text) =>
        text.includes('"kind":"ds-group-turn"'),
      ) || '';
    const scenario = [...cases.values()].find((item) =>
      currentText.includes(`"requestId":"${item.id}"`),
    );
    assert.ok(
      scenario,
      'Every native provider request must belong to a scheduled smoke case',
    );
    providerCalls.push({
      case: scenario.id,
      tools: input.tools.map((tool) => tool.function.name),
    });
    const step = scenario.steps++;
    const serialized = JSON.stringify(input.messages);
    if (scenario.work) {
      assert.equal(
        serialized.includes(privateMarker),
        false,
        'Private owner Session must never enter a scoped request',
      );
      assert.equal(
        input.tools.some((tool) =>
          ['bash', 'skill', 'read_own_chat', 'remember'].includes(
            tool.function.name,
          ),
        ),
        false,
      );
    }
    if (scenario.id === 'private-owner')
      return completion(response, input, {
        output: { text: 'Owner context saved.' },
      });
    if (scenario.id === 'scope-first') {
      const entries = [
        { tool: 'read', args: { file_path: privateFile } },
        {
          tool: 'read',
          args: { file_path: path.join(scenario.workdir, 'input.txt') },
        },
        {
          tool: 'write',
          args: {
            file_path: path.join(scenario.workdir, 'result.txt'),
            content: 'checked result\n',
          },
        },
        {
          tool: 'read',
          args: { file_path: path.join(scenario.workdir, 'result.txt') },
        },
        {
          output: {
            text: 'Read, wrote and checked the report.',
            artifacts: [
              {
                path: path.join(scenario.workdir, 'result.txt'),
                name: 'result.txt',
              },
            ],
          },
        },
      ];
      if (step > 0)
        assert.equal(
          serialized.includes(privateMarker),
          false,
          'A refused read cannot reveal private bytes',
        );
      assert.ok(entries[step], 'Unexpected extra scoped generation');
      return completion(response, input, entries[step]);
    }
    if (scenario.id === 'scope-other') {
      assert.equal(
        serialized.includes(roomMarker),
        false,
        'Another room must have a distinct native Session',
      );
      return completion(response, input, {
        output: { text: 'Other domain acknowledged.' },
      });
    }
    if (scenario.id === 'scope-followup') {
      assert.ok(
        serialized.includes(roomMarker),
        'Same approved domain must retain its prior native context',
      );
      assert.equal(serialized.includes(otherMarker), false);
      return completion(response, input, {
        output: { text: 'Same room context retained.' },
      });
    }
    if (scenario.id === 'scope-revoke') {
      if (step === 0)
        return completion(response, input, {
          tool: 'write',
          args: {
            file_path: path.join(scenario.workdir, 'before.txt'),
            content: 'observed effect',
          },
        });
      assert.equal(step, 1);
      scenario.revoked = true;
      return completion(response, input, {
        tool: 'write',
        args: {
          file_path: path.join(scenario.workdir, 'after.txt'),
          content: 'must not exist',
        },
      });
    }
    throw new Error('Unrecognized smoke scenario');
  } catch (error) {
    report.providerError = error.message;
    if (!response.headersSent) send(response, 500, { error: error.message });
    else response.destroy();
  }
});

let child;
let childExit;
const log = await open(path.join(directory, 'host.log'), 'a', 0o600);
async function api(route, input) {
  const response = await fetch(bridge + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
async function start() {
  child = spawn(
    process.execPath,
    [path.join(packageRoot, 'scripts/dsh-node.mjs'), 'run', 'helper'],
    {
      cwd: packageRoot,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: {
        ...process.env,
        DS_GROUP_DSH_CLI: installation.cli,
        DS_GROUP_DSH_RUNTIME: installation.runtime,
        DS_GROUP_DATA_DIR: directory,
        DS_GROUP_CORE_CONFIG_PATH: path.join(directory, 'core-config.json'),
        DS_GROUP_CORE_URL: origin,
        DS_GROUP_BRIDGE_PORT: String(basePort + 1),
        OPENCODE_API_KEY: 'synthetic-scoped-runtime-no-remote-key',
        DS_GROUP_OPENCODE_BASE_URL: `${origin}/v1`,
      },
    },
  );
  childExit = new Promise((resolve) => child.once('close', resolve));
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null)
      throw new Error(
        `Scoped native host exited ${child.exitCode}; inspect ${directory}/host.log`,
      );
    try {
      return await api('/status');
    } catch {
      await delay(250);
    }
  }
  throw new Error('Scoped native host did not become ready');
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([
    childExit.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 40_000);
    }),
  ]);
  clearTimeout(timer);
  if (!stopped) {
    process.kill(-child.pid, 'SIGKILL');
    await childExit;
    throw new Error('Native scoped host required forced stop');
  }
}
async function scenario(
  id,
  {
    marker = id,
    room = '!first:b.runtime.test',
    domain = 'first',
    scoped = true,
  } = {},
) {
  const workdir = path.join(directory, 'tasks', id);
  await mkdir(workdir, { recursive: true });
  const inputFile = path.join(workdir, 'input.txt');
  await writeFile(inputFile, 'shared input\n');
  const event = {
    eventId: `$${id}`,
    roomId: room,
    senderId: scoped ? '@alice:b.runtime.test' : ownerId,
    body: marker,
  };
  const work = {
    kind: 'scoped',
    requestId: id,
    botId,
    ownerId,
    requesterId: event.senderId,
    roomId: room,
    eventId: event.eventId,
    authority: 'b.runtime.test',
    tools: ['read', 'write', 'edit', 'read_image'],
    domainId: hash(domain),
    proofHash: hash(`proof-${domain}`),
  };
  const input = {
    async: true,
    requestId: id,
    botId,
    event,
    workdir,
    history: [],
    ...(scoped ? { authorization: work } : {}),
  };
  const entry = {
    id,
    workdir,
    work: scoped ? work : undefined,
    input,
    steps: 0,
  };
  cases.set(id, entry);
  let receipt = await api('/turns', input);
  for (
    let attempt = 0;
    attempt < 300 && ['queued', 'running'].includes(receipt.status);
    attempt++
  ) {
    await delay(100);
    receipt = await api(`/turns/${id}`);
  }
  entry.receipt = receipt;
  return entry;
}

try {
  const reserve = createServer();
  reserve.listen(basePort + 1, '127.0.0.1');
  await once(reserve, 'listening');
  await new Promise((resolve) => reserve.close(resolve));
  model.listen(basePort, '127.0.0.1');
  await once(model, 'listening');
  await writeFile(
    path.join(directory, 'core-config.json'),
    JSON.stringify({ nodeSecret: 'synthetic-scoped-node', publicUrl: origin }),
    { mode: 0o600 },
  );
  await start();
  const setup = () =>
    api('/bots', {
      botId,
      name: 'Helper',
      role: '文件助手',
      instructions: 'Handle current approved requests with available tools.',
    });
  const bot = await setup();
  assert.ok(bot.tools.includes('read') && bot.tools.includes('write'));
  const owner = await scenario('private-owner', {
    marker: privateMarker,
    scoped: false,
    room: '!owner:a.runtime.test',
  });
  assert.equal(owner.receipt.status, 'completed');
  const first = await scenario('scope-first', { marker: roomMarker });
  assert.equal(
    first.receipt.status,
    'completed',
    JSON.stringify(first.receipt),
  );
  assert.notEqual(first.receipt.sessionId, bot.sessionId);
  assert.equal(first.receipt.toolReceipts[0].status, 'failed');
  assert.ok(
    first.receipt.toolReceipts
      .slice(1)
      .every((tool) => tool.status === 'completed'),
  );
  assert.equal(
    await readFile(path.join(first.workdir, 'result.txt'), 'utf8'),
    'checked result\n',
  );
  assert.equal(first.receipt.artifacts.length, 1);
  report.checks.push(
    'nativeFileToolsAndPrivatePathRefusal',
    'ownerSessionAndPrivateMemoryExcluded',
  );
  const other = await scenario('scope-other', {
    marker: otherMarker,
    room: '!second:b.runtime.test',
    domain: 'second',
  });
  assert.equal(other.receipt.status, 'completed');
  assert.notEqual(other.receipt.sessionId, first.receipt.sessionId);
  const followup = await scenario('scope-followup');
  assert.equal(followup.receipt.status, 'completed');
  assert.equal(followup.receipt.sessionId, first.receipt.sessionId);
  report.checks.push(
    'roomDomainsIsolateNativeHistory',
    'sameAuthorizedDomainReusesNativeSession',
  );
  const revoked = await scenario('scope-revoke', {
    domain: 'revoke',
    room: '!revocation:b.runtime.test',
  });
  assert.equal(revoked.receipt.status, 'failed');
  assert.equal(revoked.receipt.errorCode, 'WORK_AUTHORIZATION_REVOKED');
  assert.equal(
    await readFile(path.join(revoked.workdir, 'before.txt'), 'utf8'),
    'observed effect',
  );
  await assert.rejects(readFile(path.join(revoked.workdir, 'after.txt')), {
    code: 'ENOENT',
  });
  report.checks.push('revocationStopsNextNativeEffectAndPreservesEarlierFile');
  const callsBefore = providerCalls.length;
  await stop();
  await start();
  const restored = await setup();
  assert.equal(restored.dsBotId, bot.dsBotId);
  assert.equal(restored.sessionId, bot.sessionId);
  assert.ok(
    restored.scopedWork.domains.some(
      (domain) => domain.sessionId === first.receipt.sessionId,
    ),
  );
  const duplicate = await api('/turns', first.input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sessionId, first.receipt.sessionId);
  assert.equal(providerCalls.length, callsBefore);
  report.checks.push(
    'restartRetainsOriginalBotAndDomainBindings',
    'duplicateCompletedRequestNeverReexecutes',
  );
  assert.ok(
    checkCalls.some((item) => item.stage === 'tool' && item.tool === 'write'),
  );
  assert.ok(
    ledger.filter((item) => item.route.endsWith('/claim')).length ===
      providerCalls.length,
  );
  assert.ok(
    ledger.filter((item) => item.route.endsWith('/complete')).length ===
      providerCalls.length,
  );
  report.checks.push('nativeToolAndEveryModelStreamAuthorizationAndLedger');
  report.sessions = {
    original: bot.sessionId,
    firstRoom: first.receipt.sessionId,
    secondRoom: other.receipt.sessionId,
  };
  report.receipts = [...cases.values()].map(({ id, receipt }) => ({
    id,
    status: receipt.status,
    errorCode: receipt.errorCode,
    sessionId: receipt.sessionId,
    toolReceipts: receipt.toolReceipts,
    modelClaims: receipt.claims.length,
  }));
  report.status = 'passed';
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    await stop();
  } catch (error) {
    report.cleanupError = error.message;
    report.status = 'failed';
    process.exitCode = 1;
  }
  await log.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  report.scriptedProviderCalls = providerCalls.length;
  report.authorizationChecks = checkCalls.length;
  report.directory = directory;
  const reportPath =
    process.env.DS_GROUP_SCOPED_SMOKE_REPORT ||
    path.join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
