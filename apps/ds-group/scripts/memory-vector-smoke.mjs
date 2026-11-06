import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packageRoot } from '../src/paths.mjs';
import { MemoryService } from '../memory/service.mjs';

await mkdir(join(packageRoot, '.local'), { recursive: true });
const directory = await mkdtemp(join(packageRoot, '.local/memory-vector-'));
const backend = { python: process.env.DSCORD_MEMORY_PYTHON, upstream: process.env.DSCORD_MEMORY_OMBRE,
  serverBinary: process.env.DSCORD_MEMORY_LLAMA_SERVER, modelArtifact: process.env.DSCORD_MEMORY_GGUF };
for (const [name, value] of Object.entries(backend)) if (!value) throw new Error(`Missing ${name}`);
const service = new MemoryService({ directory, backend });
const report = { status: 'failed', startedAt: new Date().toISOString(), checks: [], queries: [], generationCalls: 0 };
const facts = [
  ['阿岚需要只含植物食材的午餐，连奶酪和蜂蜜都不吃。', '聚餐给阿岚准备什么样的菜？'],
  ['河湾计划的备份保存在北侧机柜的蓝色移动硬盘。', '河湾项目的数据恢复介质放哪了？'],
  ['宋禾每周三下午在远程办公室，周五才到总部。', '宋禾星期三在哪里办公？'],
  ['橙灯项目演示时只展示离线地图，不联网查询位置。', '橙灯展示会要怎么处理地图网络？'],
  ['账号 @lin:a.test 的林青喜欢短中文周报，最多五条要点。', '林青希望收到怎样的周度汇报？'],
  ['账号 @lin:b.test 的林青要求英文详细报告，附原始计算表。', '另一个林青的报告语言与附件要求是什么？'],
  ['群 !south:test 把发布窗口定在周六早晨八点。', '南组什么时候上线？'],
  ['群 !north:test 的发布窗口是周日晚上九点。', '北组选择哪个上线时间？'],
];
try {
  const saved = [];
  for (const [index, [text]] of facts.entries()) {
    service.ingest('bot-a', { event: { eventId: `$${index}`, roomId: '!test:local', sender: '@owner:local', body: text } });
    saved.push(await service.remember('bot-a', { text, subjectId: `test:subject-${index}`, predicate: 'preference' }));
  }
  for (const [index, [, query]] of facts.entries()) {
    const result = await service.recall('bot-a', { query, limit: 3 });
    const rank = result.entries.findIndex(row => row.id === saved[index].id) + 1;
    report.queries.push({ query, rank, mode: result.mode });
    assert.equal(result.mode, 'semantic', JSON.stringify(result)); assert.ok(rank > 0 && rank <= 3);
    assert.equal(result.entries.find(row => row.id === saved[index].id).text, facts[index][0]);
  }
  report.checks.push('eightParaphraseQueriesRecallAt3AndExactRead');
  service.forget('bot-a', { id: saved[0].id });
  assert.ok(!(await service.recall('bot-a', { query: facts[0][1] })).entries.some(row => row.id === saved[0].id));
  report.checks.push('withdrawnExcluded');
  report.usage = { ...service.backend.usage }; report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  await service.close(); report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }, null, 2));
}
