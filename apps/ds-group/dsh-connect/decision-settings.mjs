import path from 'node:path';
import { readOptionalJson, savePrivateJson } from '../scripts/server-init.mjs';
import { createOpenAIDecisionProvider } from '../src/decision-provider.mjs';

/** A private node setting. Only publicStatus is returned to a browser or Core. */
export class DecisionSettings {
  constructor({ directory, environment = process.env, providerFactory = createOpenAIDecisionProvider }) {
    this.filename = path.join(directory, 'decision-provider.json');
    this.environment = environment;
    this.providerFactory = providerFactory;
    this.config = { version: 1, enabled: true };
    this.provider = null;
  }

  async initialize() {
    const saved = await readOptionalJson(this.filename);
    if (saved) {
      if (saved.version !== 1 || typeof saved.enabled !== 'boolean'
        || saved.apiKey !== undefined && typeof saved.apiKey !== 'string') {
        throw new Error('DECISION_SETTINGS_INVALID');
      }
      this.config = saved;
    }
    this.refresh();
    return this;
  }

  key() {
    return this.config.apiKey || this.environment.DSCORD_DECISION_API_KEY || this.environment.OPENAI_API_KEY || '';
  }

  refresh() {
    this.provider = this.config.enabled && this.key()
      ? this.providerFactory({ apiKey: this.key() }) : null;
  }

  publicStatus() {
    const health = this.provider?.health?.();
    return { configured: Boolean(this.key()), enabled: this.config.enabled,
      available: !this.config.enabled || !this.provider ? false
        : health?.health === 'ok' ? true : health?.health === 'error' ? false : null,
      model: this.provider?.model || 'gpt-6-luna', health: health?.status || health?.health || 'unknown' };
  }

  async save({ apiKey, enabled } = {}) {
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('INVALID_DECISION_SETTING');
    if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 4096)) throw new Error('INVALID_DECISION_KEY');
    const next = { ...this.config,
      ...(enabled === undefined ? {} : { enabled }),
      ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
    };
    await savePrivateJson(this.filename, next);
    this.config = next;
    this.refresh();
    return this.publicStatus();
  }
}
