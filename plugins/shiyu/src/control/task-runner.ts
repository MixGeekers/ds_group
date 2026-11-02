import { randomUUID } from 'node:crypto';
import type { ControlStore } from '../adapters/control-store/index.js';
import type { TaskView } from './tasks/index.js';
import type { WorkerRunRequest, WorkerRunResult } from '../adapters/dsh/workers.js';
import type { LocalArtifactStore } from '../adapters/artifacts/index.js';

export interface TaskWorkerDriver {
  initialize(): Promise<void>;
  /** Trusted zero-model dependency preflight; absent drivers cannot claim capability availability. */
  prepareLocalNote?(): Promise<{ dependencyFingerprint: string }>;
  run(request: WorkerRunRequest): Promise<WorkerRunResult>;
  close(): Promise<void>;
}
export interface TaskRunOptions {
  signal: AbortSignal;
  progress(phase: string): void;
}

/** Coordinates existing native workers and durable domain commands. No Agent loop. */
export class LocalTaskRunner {
  constructor(private readonly store: ControlStore, private readonly worker: TaskWorkerDriver, private readonly artifacts: LocalArtifactStore) {}

  async run(taskId: string, options: TaskRunOptions): Promise<TaskView> {
    options.signal.throwIfAborted();
    options.progress('领取受限执行实例');
    const plan = await this.store.request('task.claimAssignment', { taskId, leaseMs: 180000 });
    const permit = plan.permit;
    try {
      const cwd = await this.artifacts.prepareWorkspace(taskId);
      options.signal.throwIfAborted();
      const result = await this.worker.run({
        taskId, assignmentId: plan.assignmentId, scope: plan.scope, cwd, sessionId: plan.sessionId,
        permit: { ...permit, check: async () => this.store.request('task.checkPermit', { permit }) },
        signal: options.signal, ...plan.budget,
        onBound: async binding => {
          await this.store.request('task.bindAssignment', { permit, sessionId: binding.sessionId });
          await this.store.request('task.assignmentStarted', { permit });
          options.progress('受限 worker 正在处理本地任务');
        },
        prompt: `完成这项已授权本地任务：${plan.title}\n请调用 shiyu_worker_write_note，content 参数严格使用下列 JSON 字符串的内容，不增删任何字符：\n${JSON.stringify(plan.content)}\n工具返回后，以规定 JSON 格式给出候选摘要；evidenceRequests 可引用 ${plan.artifactRef}。任务成功由独立核验决定。`,
        tools: [{
          name: 'shiyu_worker_write_note',
          description: '将本任务预授权正文写入本体专属产物目录。正文必须与本任务预登记值一致；无任意路径或文件权限。',
          parameters: { type: 'object', properties: { content: { type: 'string', description: '预登记正文，最多 1024 UTF-8 bytes。' } }, required: ['content'], additionalProperties: false },
          execute: async (args, tool) => {
            if (Object.keys(args).some(key => key !== 'content') || typeof args.content !== 'string') throw new Error('Invalid local artifact arguments');
            await tool.assertPermit(); options.signal.throwIfAborted();
            const intent = await this.store.request('task.enqueueArtifact', { permit, content: args.content });
            if (intent.effect.status === 'succeeded') {
              const previous = await this.artifacts.inspect({ taskId, expectedSha256: intent.payload.sha256 });
              if (!previous) throw new Error('Previously completed artifact is missing');
              return { accepted: true, artifactRef: plan.artifactRef, sha256: previous.sha256, reused: true };
            }
            const claim = await this.store.request('task.claimEffect', { permit, effectId: intent.effect.effectId, leaseMs: 120000 });
            if (!claim) throw new Error('Effect is not available for a new dispatch');
            await tool.assertPermit(); tool.signal.throwIfAborted();
            const dispatch = await this.store.request('task.assertEffect', { permit, claim });
            options.progress('写入本体专属产物并独立读取核对');
            await this.artifacts.write({ taskId, content: dispatch.payload.content, expectedSha256: dispatch.payload.sha256, signal: tool.signal,
              beforePublish: async () => {
                // The temporary file is durable, but the named effect is not yet published.
                // Recheck the original durable claim immediately before the no-overwrite link.
                await this.store.request('task.assertEffect', { permit, claim });
                tool.signal.throwIfAborted(); options.signal.throwIfAborted();
              } });
            // Read again independently. A tool's own success message is not proof.
            const observed = await this.artifacts.inspect({ taskId, expectedSha256: dispatch.payload.sha256 });
            if (!observed) throw new Error('Artifact disappeared before independent verification');
            await this.store.request('task.recordArtifactReceipt', { permit, claim, observedSha256: observed.sha256, observedBytes: observed.byteLength, observedAt: observed.observedAt, receiptId: randomUUID() });
            return { accepted: true, artifactRef: plan.artifactRef, sha256: observed.sha256, taskVerified: false };
          },
        }],
      });
      await this.store.request('task.settleUsage', { permit, usage: result.usage, calls: result.modelCalls, nativeObservations: result.nativeObservations });
      options.signal.throwIfAborted();
      options.progress('核验产物、效果回执与完成条件');
      const observed = await this.artifacts.inspect({ taskId, expectedSha256: plan.expectedSha256 });
      if (!observed) throw new Error('Worker did not produce the required artifact');
      await this.store.request('task.report', { permit, state: 'ready', summary: result.candidate.summary });
      const task = await this.store.request('task.verify', { taskId });
      if (task.state !== 'succeeded') throw new Error('Independent completion verification is incomplete');
      options.progress('独立核验通过');
      return task;
    } catch (error) {
      // Cancellation or a crashed dispatch does not prove the external effect
      // stopped. Retain uncertainty until the recovery coordinator reconciles it.
      try { await this.store.request('task.markUnknown', { taskId, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) }); }
      catch (recordError) { throw new AggregateError([error, recordError], 'Task execution and uncertainty recording failed'); }
      throw error;
    }
  }
}
