import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MemoryService } from '../memory/service.mjs';
import { packageRoot } from '../src/paths.mjs';

await mkdir(join(packageRoot, '.local'), { recursive: true });
const directory = await mkdtemp(join(packageRoot, '.local/memory-vector-scale-'));
const service = new MemoryService({ directory, backend: {
  python: process.env.DSCORD_MEMORY_PYTHON, upstream: process.env.DSCORD_MEMORY_OMBRE,
  serverBinary: process.env.DSCORD_MEMORY_LLAMA_SERVER, modelArtifact: process.env.DSCORD_MEMORY_GGUF,
} });
const corpus = ['水杉项目的归档密钥为「芒星-5319」，保存在赤铜色的密封盒里。',
  ...Array.from({ length: 132 }, (_, n) => `办公耗材库存条目 ${n + 1}：${['胶带','白纸','铅笔','文件夹'][n % 4]}有 ${n * 7 + 3} 包，放在耗材柜第 ${n % 19 + 1} 格。`),
  '海盐书稿的校对负责人是燕青，每周五下午统一审阅。'];
const report = { startedAt: new Date().toISOString(), status: 'failed', generationCalls: 0, records: corpus.length, queries: [] };
report.sourceHashes = Object.fromEntries(await Promise.all(['memory/service.mjs','memory/store.mjs','memory/ombre.mjs'].map(async file =>
  [file, createHash('sha256').update(await readFile(join(packageRoot, file))).digest('hex')])));
try {
  const ids = [];
  for (const [n, text] of corpus.entries()) {
    service.ingest('scale-bot', { event: { eventId: `$scale-${n}`, roomId: '!archive:test', senderId: '@archivist:test', body: text } });
    ids.push((await service.remember('scale-bot', { text })).id);
  }
  for (const [query, expected] of [['水杉档案的恢复钥匙放在哪种容器中？', ids[0]], ['海盐文稿由谁负责校对、何时检查？', ids.at(-1)]]) {
    const before = service.backend.usage.queryCalls;
    const result = await service.recall('scale-bot', { query, limit: 3 });
    const rank = result.entries.findIndex(row => row.id === expected) + 1;
    report.queries.push({ query, mode: result.mode, totalEligible: result.totalEligible, rank, newEmbeddings: service.backend.usage.queryCalls - before });
    assert.equal(result.mode, 'semantic'); assert.equal(result.totalEligible, corpus.length); assert.ok(rank > 0 && rank <= 3);
    assert.equal(service.backend.usage.queryCalls - before, 1);
  }
  assert.equal(service.backend.usage.indexCalls, corpus.length); report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  report.usage = service.backend.usage; await service.close(); report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'corpus.json'), JSON.stringify(corpus, null, 2) + '\n');
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
