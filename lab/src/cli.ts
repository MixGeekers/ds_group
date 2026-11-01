import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LabEngine, DEFAULT_CONFIG } from './engine.ts';
import { catalog } from './catalog.ts';
import { buildEvidencePacket } from './evaluation.ts';
import type { RunConfig, RunDetail } from './types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = new LabEngine({ runtimeDir: process.env.LAB_RUNTIME_DIR ?? path.join(root, 'runtime') });
const command = process.argv[2] ?? 'help';
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; });

async function waitForRun(id: string): Promise<RunDetail> {
  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) {
    const run = engine.getRun(id);
    if (interrupted) { await engine.controlRun(id, 'stop'); return engine.getRun(id); }
    if (run.factReport && !['prepared', 'running', 'draining'].includes(run.status)) return run;
    if (run.error && !['prepared', 'running', 'draining'].includes(run.status)) throw new Error(run.error);
    await delay(30);
  }
  await engine.controlRun(id, 'stop');
  throw new Error(`实验 ${id} 超过 CLI 等待时间`);
}
async function runOne(config: Partial<RunConfig>) {
  const { run } = await engine.createRun({ ...DEFAULT_CONFIG, speed: 20, taskDelayMs: 20, ...config });
  const finished = await waitForRun(run.id);
  console.log(`${finished.id} · ${finished.name} · ${finished.status} · ${finished.factReport?.tasksPassed ?? 0}/${finished.factReport?.tasksTotal ?? 0} 项交付核验通过 · ${finished.artifacts.length} 份文件`);
  return finished;
}

try {
  await engine.init();
  if (command === 'list') {
    for (const scenario of catalog.scenarios) console.log(`${scenario.id}\t${scenario.name}\t${scenario.tasks.length} 项工作`);
  } else if (command === 'run') {
    const result = await runOne({ scenarioId: process.argv[3] ?? 'mixed-office' });
    if (result.factReport?.completionRate !== 1 || result.factReport.assertions.some(a => a.status === 'fail')) process.exitCode = 1;
  } else if (command === 'smoke') {
    const matrix: Array<Partial<RunConfig>> = [
      { scenarioId: 'mixed-office', noiseCount: 0 },
      { scenarioId: 'noise-storm', noiseCount: 400 },
      { scenarioId: 'async-handoff', noiseCount: 60, fault: 'tool-once' },
      { scenarioId: 'async-handoff', noiseCount: 60, fault: 'lost-receipt' },
      { scenarioId: 'memory-followup', noiseCount: 60 }
    ];
    const results = [];
    for (const config of matrix) {
      if (interrupted) break;
      const run = await runOne(config);
      results.push({ id: run.id, config: run.config, status: run.status, metrics: run.metrics, artifacts: run.artifacts.map(a => ({ path: a.path, bytes: a.bytes, sha256: a.sha256 })), factReport: run.factReport });
    }
    const passed = results.length === matrix.length && results.every(r => r.status === 'completed' && r.factReport?.completionRate === 1 && !r.factReport.assertions.some(a => a.status === 'fail'));
    await mkdir(path.join(root, 'artifacts'), { recursive: true });
    await writeFile(path.join(root, 'artifacts', 'smoke-summary.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, scope: 'lab_self_test', passed, limitations: ['使用确定性参考执行器；未调用真实识雨模型或付费评分 Agent。', '业务服务为本地有状态替身；不代表真实系统维护能力。'], results }, null, 2) + '\n');
    console.log(passed ? 'Lab 自检矩阵通过；真实 Agent 能力尚未测评。' : 'Lab 自检存在失败，请检查 artifacts/smoke-summary.json。');
    if (!passed) process.exitCode = 1;
  } else if (command === 'evidence') {
    if (!process.argv[3]) throw new Error('用法：npm run lab -- evidence <runId>');
    const run = engine.getRun(process.argv[3]);
    if (!run.factReport || ['prepared', 'running', 'draining'].includes(run.status)) throw new Error('运行尚未封存');
    const packet = await buildEvidencePacket(run, engine.runDir(run.id));
    const filename = path.join(engine.runDir(run.id), 'review-packet.json');
    await writeFile(filename, JSON.stringify(packet, null, 2));
    console.log(filename);
  } else {
    console.log('识雨 Lab\n  npm run lab -- list\n  npm run lab -- run [scenarioId]\n  npm run smoke\n  npm run lab -- evidence <runId>\n  npm run build && npm start');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await engine.close();
}
