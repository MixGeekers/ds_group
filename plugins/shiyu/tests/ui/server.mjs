import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { makeLocalTask, makeSession, makeSnapshot, makeVerificationReceipt } from './fixtures.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.SHIYU_UI_PORT ?? 4341);
let snapshot = makeSnapshot(), failReads = false, stateReads = 0, commands = [];
let verification = {}, verificationAborts = 0;
const pendingVerifications = new Map();
let taskAdmission = {}, admissionAborts = 0;
const admittedTasks = new Map(), pendingTaskAdmissions = new Map();
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const readJson = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/__test/control' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.reset) {
        for (const pending of pendingVerifications.values()) pending.cancel();
        pendingVerifications.clear();
        for (const pending of pendingTaskAdmissions.values()) pending.cancel();
        pendingTaskAdmissions.clear(); admittedTasks.clear();
        snapshot = makeSnapshot(body); stateReads = 0; commands = []; failReads = false;
        verification = {}; verificationAborts = 0;
        taskAdmission = {}; admissionAborts = 0;
      }
      if (Object.hasOwn(body, 'failReads')) failReads = Boolean(body.failReads);
      if (body.snapshot) snapshot = body.snapshot;
      if (body.verification) verification = { ...body.verification };
      if (body.releaseVerification) for (const pending of [...pendingVerifications.values()]) pending.finish();
      if (body.taskAdmission) taskAdmission = { ...body.taskAdmission };
      if (body.releaseTaskAdmission) for (const pending of [...pendingTaskAdmissions.values()]) pending.finish();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__test/stats' && req.method === 'GET') return json(res, 200, { stateReads, commands, pendingVerifications: pendingVerifications.size, verificationAborts, taskAdmissions: admittedTasks.size, pendingTaskAdmissions: pendingTaskAdmissions.size, admissionAborts });
    if (url.pathname === '/api/shiyu/state') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Only GET is supported.' });
      stateReads++;
      return failReads ? json(res, 503, { error: { code: 'TEST_UNAVAILABLE', message: '合成测试：状态读取暂不可用。' } }) : json(res, 200, snapshot);
    }
    if (url.pathname === '/api/shiyu/commands') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Only POST is supported.' });
      const body = await readJson(req);
      if (!['session.probe', 'session.verify-model', 'task.createLocal', 'runtime.pause', 'runtime.resume'].includes(body.action)) return json(res, 400, { error: 'Unknown synthetic command.' });
      commands.push(body);
      if (body.action === 'task.createLocal') {
        const responseId = `test-admission-response-${commands.length}`, options = { ...taskAdmission };
        let task = admittedTasks.get(body.requestId);
        if (!task) { task = makeLocalTask(`test-local-task-${admittedTasks.size + 1}`); admittedTasks.set(body.requestId, task); }
        if (options.publish !== false && !snapshot.tasks?.some(item => item.taskId === task.taskId)) snapshot = { ...snapshot, tasks: [...snapshot.tasks || [], task] };
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true; pendingTaskAdmissions.delete(responseId);
          if (options.error) return json(res, 503, { error: { code: 'SYNTHETIC_ADMISSION_UNCONFIRMED', message: '合成测试：受理回执未确认。' } });
          const receipt = { accepted: true, task: { ...task } };
          for (const key of options.omit || []) delete receipt[key];
          for (const key of options.omitTask || []) delete receipt.task?.[key];
          Object.assign(receipt, options.overrides || {});
          return json(res, 200, receipt);
        };
        const cancel = () => { if (finished) return; finished = true; pendingTaskAdmissions.delete(responseId); json(res, 409, { error: { message: 'Synthetic test reset.' } }); };
        res.once('close', () => {
          if (finished) return;
          finished = true; pendingTaskAdmissions.delete(responseId); admissionAborts++;
          // The synthetic task remains admitted even when its HTTP reply closes.
        });
        if (options.defer) pendingTaskAdmissions.set(responseId, { finish, cancel });
        else finish();
        return;
      }
      if (body.action === 'session.verify-model') {
        const requestId = `test-verification-${commands.length}`, options = { ...verification };
        snapshot = { ...snapshot, state: 'busy', activeWork: [{ id: requestId, title: '合成测试：模型与会话验证', phase: '模型验证 0/2', status: 'running' }] };
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true; pendingVerifications.delete(requestId);
          snapshot = { ...snapshot, state: snapshot.state === 'paused' ? 'paused' : 'idle', activeWork: [] };
          if (options.error) return json(res, 503, { error: { code: 'SYNTHETIC_VERIFICATION_FAILURE', message: '合成测试：模型验证失败。' } });
          const receipt = makeVerificationReceipt();
          for (const key of options.omit || []) delete receipt[key];
          Object.assign(receipt, options.overrides || {});
          return json(res, 200, receipt);
        };
        const cancel = () => { if (finished) return; finished = true; pendingVerifications.delete(requestId); json(res, 409, { error: { message: 'Synthetic test reset.' } }); };
        res.once('close', () => {
          if (finished) return;
          finished = true; pendingVerifications.delete(requestId); verificationAborts++;
        });
        if (options.defer) pendingVerifications.set(requestId, { finish, cancel });
        else finish();
        return;
      }
      if (body.action === 'runtime.pause') snapshot = { ...snapshot, state: 'paused' };
      else if (body.action === 'runtime.resume') snapshot = { ...snapshot, state: 'idle' };
      else {
        snapshot = { ...snapshot, sessions: [makeSession()], activities: [{ id: 'test-probe-activity', at: snapshot.observedAt, kind: 'diagnostic', title: '合成测试活动：无模型会话检查完成', status: 'succeeded' }] };
      }
      return json(res, 200, { ok: true, action: body.action, ...(body.action === 'session.probe' ? { ready: true, noModelCalled: true, released: true, archived: true } : {}), snapshot });
    }
    return vite.middlewares(req, res);
  } catch (error) {
    return json(res, 500, { error: { message: error.message } });
  }
});
// Vite 8's client still opens its transport when HMR is off. Attach that
// transport to this same loopback server, rather than opening another port.
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL('./', import.meta.url)),
  cacheDir: path.join(packageRoot, '.local', 'ui', 'vite'), appType: 'spa',
  server: { middlewareMode: true, hmr: false, ws: { server }, fs: { allow: [packageRoot] } },
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
let closing;
const close = () => closing ??= (async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await vite.close(); })();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void close().then(() => process.exit(0)));
console.log(`Shiyu synthetic UI harness, no models: http://127.0.0.1:${port}`);
