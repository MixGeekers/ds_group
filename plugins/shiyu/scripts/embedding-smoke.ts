/** Explicit, bounded local smoke: node --import tsx scripts/embedding-smoke.ts /path/model.gguf /path/llama-server */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { HARRIER_PROFILE, LocalHarrierEmbedder, verifyHarrierArtifact } from '../src/adapters/embedding/index.js';

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelFile = process.argv[2], serverFile = process.argv[3];
if (!modelFile || !serverFile) throw new Error('Pass the existing GGUF model path and llama-server path; this script does not download assets');
const pinnedServerSha256 = '0e142035f2622a23ff6a04f51a0c4594dce87acf0389a4e839e4714c953bdac8';
const pinnedCommit = 'c3df4b7';
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, '-');
const localDir = resolve(packageRoot, '.local', 'embedding-smoke', runId);
const artifactFile = resolve(packageRoot, 'artifacts', 'embedding-validation.json');
await mkdir(localDir, { recursive: true });
await mkdir(dirname(artifactFile), { recursive: true });
const controller = new AbortController();
const abort = () => controller.abort(new Error('Embedding smoke interrupted'));
process.on('SIGINT', abort); process.on('SIGTERM', abort);
const deadline = setTimeout(() => controller.abort(new Error('Embedding smoke exceeded its 120-second limit')), 120000);

async function sha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes()));
  return port;
}
function dot(a: number[], b: number[]) { return a.reduce((sum, value, index) => sum + value * b[index]!, 0); }
function summaries(vectors: number[][]) {
  return vectors.map(value => ({ dimensions: value.length, finite: value.every(Number.isFinite), norm: Math.hypot(...value) }));
}

const evidence: Record<string, any> = {
  schemaVersion: 1, startedAt, status: 'running', evidenceLevel: 'current-run-local-inference',
  profile: HARRIER_PROFILE,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  scope: { syntheticDocuments: 3, syntheticQueries: 2, repeatDocuments: 1, maxDurationSeconds: 120, paidModelCalls: 0, externalNetworkCalls: 0 },
  limitations: ['Small synthetic wiring and vector sanity check; not a rerun of the 102-query benchmark.', 'No long-running service installed; plugin runtime must receive an explicitly configured loopback endpoint.'],
};
let child: ReturnType<typeof spawn> | undefined;
let childClosed: Promise<void> | undefined;
let isClosed = false;
let spawnFailed = false;
let log: Awaited<ReturnType<typeof open>> | undefined;
try {
  evidence.artifact = await verifyHarrierArtifact(resolve(modelFile));
  const serverSha256 = await sha256(resolve(serverFile));
  assert.equal(serverSha256, pinnedServerSha256, 'llama-server binary differs from the inspected build');
  const versionResult = await exec(resolve(serverFile), ['--version'], { timeout: 10000, maxBuffer: 16384 });
  const versionText = (versionResult.stdout + versionResult.stderr).trim();
  assert.match(versionText, new RegExp(`commit ${pinnedCommit}\\)`), 'llama-server version differs from the inspected build');
  evidence.server = { binarySha256: serverSha256, version: versionText };
  controller.signal.throwIfAborted();
  const port = await unusedLoopbackPort();
  const args = ['-m', resolve(modelFile), '--embeddings', '--pooling', 'last', '--alias', HARRIER_PROFILE.model,
    '-ngl', '999', '-c', '4096', '-b', '512', '-ub', '512', '-t', '4', '--host', '127.0.0.1', '--port', String(port), '-fa', 'off'];
  evidence.server.configuration = { loopbackOnly: true, pooling: 'last', gpuLayers: 999, context: 4096, batch: 512, microBatch: 512, threads: 4, flashAttention: false };
  log = await open(resolve(localDir, 'llama-server.log'), 'w', 0o600);
  child = spawn(resolve(serverFile), args, { stdio: ['ignore', log.fd, log.fd], cwd: localDir });
  childClosed = new Promise<void>(done => {
    child!.once('error', () => { spawnFailed = true; });
    child!.once('close', (code, signal) => { isClosed = true; evidence.server.exit = { code, signal }; done(); });
  });
  const readyDeadline = Date.now() + 45000;
  let ready = false;
  while (!ready && Date.now() < readyDeadline) {
    controller.signal.throwIfAborted();
    if (isClosed || spawnFailed) throw new Error('Owned llama-server exited before readiness');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]), redirect: 'manual' });
      ready = response.status === 200;
      await response.body?.cancel();
    } catch { controller.signal.throwIfAborted(); }
    if (!ready) await delay(150, undefined, { signal: controller.signal });
  }
  assert.ok(ready, 'Owned llama-server readiness timed out');
  assert.equal(isClosed, false, 'Owned llama-server must still be alive');
  const embedder = new LocalHarrierEmbedder({ endpoint: `http://127.0.0.1:${port}/v1/embeddings`, timeoutMs: 15000 });
  const documents = ['林雨最喜欢喝乌龙茶。', 'Marta commutes to work by bicycle.', 'The observatory opens at nine on Saturdays.'];
  const queries = ['林雨最喜欢喝什么？', 'How does Marta get to work?'];
  const start = performance.now();
  const docs = await embedder.embedDocuments(documents, { signal: controller.signal });
  const qs = await embedder.embedQueries(queries, { signal: controller.signal });
  const repeated = await embedder.embedDocuments([documents[0]!], { signal: controller.signal });
  const similarity = qs.vectors.map(query => docs.vectors.map(document => dot(query, document)));
  const topIndices = similarity.map(scores => scores.indexOf(Math.max(...scores)));
  const repeatCosine = dot(docs.vectors[0]!, repeated.vectors[0]!);
  const differentCosine = dot(docs.vectors[0]!, docs.vectors[1]!);
  assert.deepEqual(topIndices, [0, 1], 'Obvious synthetic query/document matching failed');
  assert.ok(Math.abs(1 - repeatCosine) < 1e-6, 'Repeated document embedding drifted');
  assert.ok(differentCosine < 0.999, 'Different documents produced degenerate identical vectors');
  const all = [...docs.vectors, ...qs.vectors, ...repeated.vectors];
  assert.ok(all.every(value => Math.abs(Math.hypot(...value) - 1) < 1e-6), 'L2 normalization failed');
  evidence.results = { requestCount: 3, vectorCount: all.length, elapsedMs: Math.round(performance.now() - start), vectors: summaries(all), queryTopDocumentIndices: topIndices, similarity, repeatCosine, differentDocumentCosine: differentCosine };
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  // Raw server logs stay local; do not persist paths, request bodies, or remote response text.
  evidence.failure = { name: error instanceof Error ? error.name : 'UnknownError', reason: 'Pinned artifact, local server startup, or synthetic vector validation failed; inspect the local run log.' };
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : 'Embedding smoke failed');
} finally {
  if (child && childClosed && !isClosed) {
    child.kill('SIGTERM');
    await Promise.race([childClosed, delay(5000, undefined, { ref: false })]);
    if (!isClosed) { child.kill('SIGKILL'); await Promise.race([childClosed, delay(5000, undefined, { ref: false })]); }
  }
  evidence.cleanup = { ownedProcessStarted: !!child?.pid, ownedProcessExited: child ? isClosed : true, persistentServiceInstalled: false };
  if (child && !isClosed) { evidence.status = 'failed'; process.exitCode = 1; }
  await log?.close();
  clearTimeout(deadline);
  process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(artifactFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, vectors: evidence.results?.vectorCount ?? 0, cleanup: evidence.cleanup, artifact: 'artifacts/embedding-validation.json' }));
}
