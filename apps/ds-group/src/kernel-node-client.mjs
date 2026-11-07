import { setTimeout as sleep } from 'node:timers/promises';

/** The node initiates management requests so it can run behind a private network. */
export class KernelNodeClient {
  constructor({ coreUrl, nodeSecret, botId, nodeId, runtimeId, operations,
    fetchImpl = fetch, pollMs = 1000, onError = () => {} }) {
    Object.assign(this, { coreUrl, nodeSecret, botId, nodeId, runtimeId, operations, fetchImpl, pollMs, onError });
    this.controller = new AbortController();
    this.pendingResults = new Map();
    this.appliedAttention = null;
    this.lastError = null;
    this.loop = null;
  }

  identity() {
    return { botId: this.botId, nodeId: this.nodeId, runtimeId: this.runtimeId };
  }

  async request(pathname, payload) {
    const response = await this.fetchImpl(new URL(pathname, this.coreUrl), {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.nodeSecret}` },
      body: JSON.stringify({ ...this.identity(), ...payload }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'Kernel management request failed'), {
      status: response.status, code: value.code || 'KERNEL_MANAGEMENT_FAILED',
    });
    return value;
  }

  async applyAttention(desired) {
    if (!desired) return null;
    if (!['mention', 'shadow', 'natural'].includes(desired.mode)
      || !Number.isInteger(desired.revision) || desired.revision < 1) {
      throw Object.assign(new Error('Invalid participation setting'), { code: 'INVALID_ATTENTION_SETTING' });
    }
    const previous = this.appliedAttention;
    if (previous && desired.revision < previous.revision) {
      throw Object.assign(new Error('The participation setting was superseded'), { code: 'ATTENTION_REVISION_CONFLICT' });
    }
    if (previous?.revision === desired.revision) {
      if (previous.mode !== desired.mode) {
        throw Object.assign(new Error('The participation revision contains different settings'), { code: 'ATTENTION_REVISION_CONFLICT' });
      }
      return previous;
    }
    if (!this.operations.configureAttention) {
      throw Object.assign(new Error('This node cannot configure participation'), { code: 'KERNEL_CONTROL_UNAVAILABLE' });
    }
    const state = await this.operations.configureAttention({ mode: desired.mode, revision: desired.revision });
    if (state?.mode !== desired.mode) {
      throw Object.assign(new Error('The participation setting has not been applied'), { code: 'ATTENTION_NOT_APPLIED' });
    }
    this.appliedAttention = { mode: desired.mode, revision: desired.revision };
    return this.appliedAttention;
  }

  async execute(command) {
    const receipt = { commandId: command.commandId, leaseId: command.leaseId };
    try {
      if (command.botId !== this.botId || command.nodeId !== this.nodeId || command.runtimeId !== this.runtimeId
        || typeof command.commandId !== 'string' || typeof command.leaseId !== 'string'
        || !Number.isFinite(command.expiresAt) || command.expiresAt <= Date.now()) {
        throw Object.assign(new Error('Kernel command identity or lease is stale'), { code: 'KERNEL_COMMAND_STALE' });
      }
      let result;
      if (command.operation === 'attention-set') {
        result = await this.applyAttention({ ...command.args, revision: command.revision });
      } else {
        const operation = {
          'memory-profiles': this.operations.memoryProfiles,
          'memory-profile': this.operations.memoryProfile,
        }[command.operation];
        if (!operation) throw Object.assign(new Error('Unsupported kernel operation'), { code: 'KERNEL_CONTROL_UNAVAILABLE' });
        result = await operation(command.args || {});
      }
      return { ...receipt, status: 'completed', result };
    } catch (error) {
      return { ...receipt, status: 'failed', error: {
        code: typeof error.code === 'string' ? error.code : 'KERNEL_NODE_ERROR',
        message: 'The node could not complete this kernel operation',
      } };
    }
  }

  async flushResults() {
    for (const [id, receipt] of this.pendingResults) {
      try {
        await this.request('/internal/kernel/result', receipt);
        this.pendingResults.delete(id);
      } catch (error) {
        if ([400, 403, 404, 409, 410].includes(error.status)) this.pendingResults.delete(id);
        throw error;
      }
    }
  }

  async tick() {
    await this.flushResults();
    const response = await this.request('/internal/kernel/poll', {});
    for (const command of response.commands || []) {
      if (this.controller.signal.aborted) break;
      const receipt = await this.execute(command);
      this.pendingResults.set(command.commandId, receipt);
      await this.flushResults();
    }
    if (response.desiredAttention) await this.applyAttention(response.desiredAttention);
    this.lastError = null;
  }

  start() {
    if (this.loop) return;
    this.loop = (async () => {
      while (!this.controller.signal.aborted) {
        try { await this.tick(); }
        catch (error) {
          if (this.controller.signal.aborted) break;
          this.lastError = error.code || 'KERNEL_CONTROL_UNAVAILABLE';
          this.onError(this.lastError);
        }
        await sleep(this.pollMs, undefined, { signal: this.controller.signal }).catch(() => {});
      }
    })();
  }

  async stop() {
    this.controller.abort();
    await this.loop;
  }
}
