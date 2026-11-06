import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonical, sha } from './store.mjs';

export const HARRIER = { model: 'shiyu-harrier-0.6b-q8_0', dimensions: 1024,
  sha256: 'b017b8fceae7c77864652c63d07af51480088b078771a89cafe1a467b069ea75' };
const service = fileURLToPath(new URL('../service/ombre/service.py', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'close').catch(() => {}); child.kill('SIGTERM');
  await Promise.race([ended, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
}
export async function startHarrier({ serverBinary, modelArtifact, directory }) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(modelArtifact)) hash.update(chunk);
  if (hash.digest('hex') !== HARRIER.sha256) throw new Error('HARRIER_ARTIFACT_MISMATCH');
  await mkdir(directory, { recursive: true });
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const log = await open(path.join(directory, 'harrier.log'), 'a');
  const child = spawn(serverBinary, ['-m', modelArtifact, '--embeddings', '--pooling', 'last', '--alias', HARRIER.model,
    '-ngl', '999', '-c', '4096', '-b', '512', '-ub', '512', '-t', '4', '--host', '127.0.0.1', '--port', String(port), '-fa', 'off'],
  { stdio: ['ignore', log.fd, log.fd] });
  let spawnError; child.on('error', error => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('HARRIER_EXITED');
      try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) {
        return { endpoint: `${base}/v1/embeddings`, pid: child.pid,
          healthy: async () => child.exitCode === null && child.signalCode === null
            && await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false),
          close: async () => { await stop(child); await log.close(); } };
      } } catch { /* loading */ }
      await delay(200);
    }
    throw new Error('HARRIER_START_TIMEOUT');
  } catch (error) { await stop(child); await log.close(); throw error; }
}

/** The actual Shiyu/Ombre service is reused, including its native receipts and vector engine. */
export class OmbreBackend {
  constructor(config) { this.config = config; this.pending = new Map(); this.sequence = 0;
    this.chain = Promise.resolve(); this.usage = { indexCalls: 0, queryCalls: 0, complete: true }; }
  async resetConnection() {
    await stop(this.child); this.lines?.close(); this.child = null;
    await this.log?.close(); this.log = null;
  }
  async open({ embedding = false } = {}) {
    const alive = this.child && this.child.exitCode === null && this.child.signalCode === null;
    if (alive && (!embedding || !this.harrier || await this.harrier.healthy())) return;
    const c = this.config; await mkdir(c.directory, { recursive: true });
    if (!c.endpoint && c.serverBinary && c.modelArtifact && (!this.harrier || !await this.harrier.healthy())) {
      // Start the replacement before stopping the body service. If loading fails,
      // its still-live exact-read path remains available for lexical fallback.
      const previous = this.harrier;
      this.harrier = await startHarrier(c);
      await previous?.close();
    }
    await this.resetConnection();
    const endpoint = c.endpoint || this.harrier?.endpoint;
    this.semantic = Boolean(endpoint);
    this.log = await open(path.join(c.directory, 'ombre.log'), 'a');
    const args = [service, '--upstream', c.upstream, '--root', path.join(c.directory, 'vault'),
      '--backend-id', 'dscord-ombre', '--scope', 'native-team', '--deployment-id', c.deploymentId,
      ...(endpoint ? ['--embedding-endpoint', endpoint, '--semantic-api'] : ['--without-embedding'])];
    this.child = spawn(c.python, args, { stdio: ['pipe', 'pipe', this.log.fd] });
    const abort = error => { for (const held of this.pending.values()) held.reject(error); this.pending.clear(); };
    this.child.on('error', abort); this.child.on('exit', () => abort(new Error('OMBRE_DISCONNECTED')));
    this.child.stdin.on('error', abort);
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const held = this.pending.get(message.id); if (!held) return;
      this.pending.delete(message.id);
      if (message.error) held.reject(new Error(`OMBRE_RPC: ${message.error.message}`)); else held.resolve(message.result);
    });
    try {
      await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dscord-memory', version: '1' } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    } catch (error) { await this.resetConnection(); throw error; }
  }
  async rpc(method, params) {
    const id = ++this.sequence;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('OMBRE_TIMEOUT')); }, 65000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (error) { const held = this.pending.get(id); this.pending.delete(id); held?.reject(error); }
    return response;
  }
  async call(name, args) {
    const result = await this.rpc('tools/call', { name: `shiyu_memory_${name}`, arguments: args });
    if (result.isError) throw new Error(`OMBRE_${name}: ${result.content?.map(item => item.text || '').join(' ').slice(0, 800)}`);
    return result.structuredContent || JSON.parse(result.content.find(item => item.type === 'text').text);
  }
  async embeddingCall(name, args) {
    try { return await this.call(name, args); }
    catch (error) { this.usage.complete = false; throw error; }
  }
  run(fn, options) {
    if (this.closing) return Promise.reject(new Error('OMBRE_CLOSED'));
    const task = this.chain.catch(() => {}).then(async () => { await this.open(options); return fn(); }); this.chain = task; return task;
  }
  save(row) { return this.run(async () => {
    const command = { schemaVersion: 1, kind: 'create', operationId: row.id, backendId: 'dscord-ombre', scope: 'native-team',
      targetRef: row.id, bodyDigest: row.bodyDigest, bodyBytes: Buffer.byteLength(row.text),
      sourceRefs: row.sourceRefs.map(ref => ({ sourceId: ref.id, revision: ref.revision })).sort((a, b) => a.sourceId < b.sourceId ? -1 : 1) };
    const saved = await this.call('create', { command, commandDigest: sha(canonical(command)), body: row.text });
    if (saved.state !== 'applied' || saved.receipt?.bodyDigest !== row.bodyDigest) throw new Error(`OMBRE_WRITE_${saved.state}`);
    return saved.receipt;
  }); }
  ref(row) { const r = row.receipt; return { memoryOperationId: row.id, bodyReceiptId: r.receiptId,
    nativeId: r.nativeId, componentVersion: r.componentVersion, bodyDigest: row.bodyDigest }; }
  index(row) { return this.run(async () => {
    if (!this.semantic) return null;
    if (row.index?.state === 'applied') return row.index;
    const status = await this.call('backend_status', { scope: 'native-team' });
    const command = { schemaVersion: 1, kind: 'ensure-index', indexOperationId: `index_${row.id}_${Date.now()}`,
      ...this.ref(row), backendId: 'dscord-ombre', deploymentId: this.config.deploymentId, scope: 'native-team',
      profileFingerprint: status.profileFingerprint, indexBaselineId: status.indexBaselineId,
      expectedIndexWatermark: status.indexWatermark, deadlineAtMs: Date.now() + 60000, maxEmbeddingCalls: 2 };
    const result = await this.embeddingCall('index_ensure', { command, commandDigest: sha(canonical(command)) });
    this.usage.indexCalls += result.embeddingCalls ?? result.receipt?.embeddingCalls ?? 0;
    if (result.usageComplete === false) this.usage.complete = false;
    if (result.state !== 'applied') throw new Error(`OMBRE_INDEX_${result.state}: ${result.reason || result.error || ''}`);
    return result;
  }, { embedding: true }); }
  search(query, rows, limit = 10) { return this.run(async () => {
    if (!this.semantic) return { mode: 'exact', matches: [] };
    const status = await this.call('backend_status', { scope: 'native-team' });
    const matches = [];
    // The reused engine supports 128 eligible refs per call. Every partition is ranked;
    // no newest-N truncation hides early memories. Its query cache avoids re-embedding.
    for (let offset = 0; offset < rows.length; offset += 128) {
      const eligibleRefs = rows.slice(offset, offset + 128).map(row => this.ref(row)).sort((a, b) => a.nativeId < b.nativeId ? -1 : 1);
      const result = await this.embeddingCall('search_candidates', { scope: 'native-team', query, limit: Math.min(limit, 10), eligibleRefs,
        profileFingerprint: status.profileFingerprint, expectedIndexBaselineId: status.indexBaselineId,
        expectedIndexWatermark: status.indexWatermark, deadlineAtMs: Date.now() + 60000 });
      this.usage.queryCalls += result.embeddingCalls || 0;
      if (!result.usageComplete) this.usage.complete = false;
      if (result.state !== 'ok') throw new Error(`OMBRE_SEARCH_${result.state}`);
      matches.push(...result.matches);
    }
    return { mode: 'semantic', matches: matches.sort((a, b) => b.score - a.score).slice(0, limit) };
  }, { embedding: true }); }
  read(row) { return this.run(async () => {
    const result = await this.call('get', { nativeId: row.receipt.nativeId, scope: 'native-team' });
    if (result.state !== 'found' || result.bodyDigest !== row.bodyDigest || sha(result.body) !== row.bodyDigest
      || result.componentVersion !== row.receipt.componentVersion) throw new Error('OMBRE_EXACT_READ_MISMATCH');
    return result.body;
  }); }
  async close() { this.closing = true; await this.chain.catch(() => {}); await this.resetConnection(); await this.harrier?.close(); this.harrier = null; }
}
