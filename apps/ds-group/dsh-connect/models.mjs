import { checkModel, modelError, modelReference, modelSelection } from '../src/model-config.mjs';

export class DshModels {
  constructor(ctx) {
    this.ctx = ctx;
  }

  profiles(redactSecrets = true) {
    return this.ctx.get('settings')?.describe({ redactSecrets }).find(section => section.ns === 'llm-pi-ai')?.value?.providers || {};
  }

  async view() {
    const profiles = this.profiles();
    const directory = this.ctx.llm.listConfigurableProviders().filter(entry => entry.settingsNs === 'llm-pi-ai');
    const providers = [];
    for (const [id, profile] of Object.entries(profiles)) {
      const entry = directory.find(item => item.provider === id);
      const ref = profile.apiKeyEnv;
      const credential = ref ? await this.ctx.get('credentials')?.describe(ref) : undefined;
      let models = [];
      let errorCode = entry?.error ? 'MODEL_PROFILE_INVALID' : null;
      try {
        models = (await this.ctx.llm.listModels(id)).map(model => ({ model: `${id}/${model.id}`, name: model.name || model.id }));
      } catch { errorCode = 'MODEL_PROFILE_INVALID'; }
      providers.push({ id, name: profile.displayName || id, models,
        credential: ref ? (credential?.configured ? 'configured' : 'missing') : 'native', errorCode });
    }
    const defaults = this.ctx.get('agentDefaultModel')?.currentSelection?.();
    const defaultSelection = defaults?.provider && defaults?.model ? modelSelection({
      model: `${defaults.provider}/${defaults.model}`, reasoningEffort: defaults.reasoningEffort,
    }) : null;
    return { available: true, providers, defaultSelection };
  }

  async export(input) {
    const defaults = (await this.view()).defaultSelection;
    const inherited = !input || input.model === defaults?.model ? defaults : {};
    const selection = modelSelection({ ...inherited, ...input });
    const route = modelReference(selection.model);
    const profile = this.profiles(false)[route.provider];
    if (!profile) throw modelError('MODEL_PROVIDER_UNAVAILABLE', 'Choose a provider configured in DSH Models.');
    const credentials = { version: 1, refs: {}, records: {} };
    const store = this.ctx.get('credentials');
    if (profile.apiKeyEnv) {
      const key = (await store?.resolve(profile.apiKeyEnv))?.value;
      if (!key) throw modelError('MISSING_CREDENTIAL', 'Configure the selected model’s credential in DSH model settings.');
      credentials.refs[profile.apiKeyEnv] = key;
    } else {
      const recordKey = `llm-pi-ai/${route.provider}`;
      const record = await store?.readRecord(recordKey);
      if (record) credentials.records[recordKey] = record;
      const entry = this.ctx.llm.listConfigurableProviders().find(item => item.provider === route.provider && item.settingsNs === 'llm-pi-ai');
      for (const ref of entry?.nativeAuth?.env || []) {
        const value = (await store?.resolve(ref))?.value;
        if (value) credentials.refs[ref] = value;
      }
      if (entry?.nativeAuth?.env?.length && !record && !Object.keys(credentials.refs).length) {
        throw modelError('MISSING_CREDENTIAL', 'Configure this provider’s native authentication in DSH Models.');
      }
    }
    await checkModel(this.ctx.llm, selection);
    return { selection, providers: { [route.provider]: structuredClone(profile) }, credentials, credentialRefs: Object.keys(credentials.refs) };
  }
}
