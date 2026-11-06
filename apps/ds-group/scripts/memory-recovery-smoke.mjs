import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { packageRoot } from '../src/paths.mjs';

const implementation = resolve(packageRoot, process.argv[2] || 'memory/service.mjs');
const { MemoryService } = await import(pathToFileURL(implementation).href);
await mkdir(join(packageRoot, '.local'), { recursive: true });
const directory = await mkdtemp(join(packageRoot, '.local/memory-recovery-'));
const backend = { python: process.env.DSCORD_MEMORY_PYTHON, upstream: process.env.DSCORD_MEMORY_OMBRE,
  serverBinary: process.env.DSCORD_MEMORY_LLAMA_SERVER, modelArtifact: process.env.DSCORD_MEMORY_GGUF };
const report = { startedAt: new Date().toISOString(), status: 'failed', checks: [], generationCalls: 0, sourceHashes: {}, usage: [] };
for (const file of ['service.mjs', 'store.mjs', 'ombre.mjs']) report.sourceHashes[file] = createHash('sha256').update(await readFile(join(dirname(implementation), file))).digest('hex');
let service = new MemoryService({ directory: join(directory, 'knowledge'), backend });
try {
  service.ingest('recovery-bot', { event: { eventId: '$recovery', roomId: '!north:test', senderId: '@lin:test', body: '离线备份苍鹭-2518放在蓝色硬盘' } });
  const saved = await service.remember('recovery-bot', { text: '离线备份苍鹭-2518放在蓝色硬盘' });
  const query = async text => { const result = await service.recall('recovery-bot', { query: text });
    assert.equal(result.entries[0]?.id, saved.id); assert.equal(result.entries[0]?.sources[0].eventId, '$recovery'); return result; };
  assert.equal((await query('离线备份用什么介质')).mode, 'semantic'); report.checks.push('realSemanticBaseline');
  const oldPython = service.backend.child, ended = once(oldPython, 'close'); oldPython.kill('SIGKILL'); await ended;
  assert.equal((await query('备用数据放在哪里')).mode, 'semantic');
  assert.notEqual(service.backend.child.pid, oldPython.pid); report.checks.push('killedOmbreProcessRecoversSameBodyAndSources');
  const oldHarrier = service.backend.harrier.pid; process.kill(oldHarrier, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 150));
  const binary = service.backend.config.serverBinary;
  service.backend.config.serverBinary = join(directory, 'deliberately-unavailable-llama-server');
  const fallback = await query('向量模型不可用时查离线备份');
  assert.equal(fallback.mode, 'lexical-fallback'); assert.ok(fallback.issue); report.checks.push('embeddingUnavailableKeepsExactReadWithExplicitFallback');
  service.backend.config.serverBinary = binary;
  assert.equal((await query('向量恢复后查离线备份')).mode, 'semantic');
  assert.notEqual(service.backend.harrier.pid, oldHarrier); report.checks.push('ownedHarrierRecoversAndRebindsOmbre');
  report.usage.push({ ...service.backend.usage }); await service.close();
  service = new MemoryService({ directory: join(directory, 'knowledge'), backend });
  assert.equal((await query('重开后备份介质在哪里')).mode, 'semantic'); report.checks.push('serviceRestartPreservesReceiptAndSource');
  service.forget('recovery-bot', { id: saved.id });
  assert.equal((await service.recall('recovery-bot', { query: '苍鹭' })).entries.length, 0); report.checks.push('withdrawalStillExcluded');
  report.usage.push({ ...service.backend.usage }); report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await service.close(); report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error, directory }, null, 2));
}
