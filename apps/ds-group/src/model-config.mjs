export const LEGACY_MODEL = 'opencode-go/deepseek-v4.1-flash';
export const DEFAULT_OUTPUT_TOKENS = 4096;

export function modelError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

export function modelReference(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[^\s\x00-\x1f\x7f]+$/.test(value)) {
    throw modelError('INVALID_MODEL', 'Use a provider/model reference from the DSH model catalog.');
  }
  const slash = value.indexOf('/');
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function modelSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw modelError('INVALID_MODEL', 'Choose a model.');
  const route = modelReference(input.model);
  const maxTokens = input.maxTokens ?? DEFAULT_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw modelError('INVALID_OUTPUT_LIMIT', 'Output tokens must be a positive integer.');
  const effort = input.reasoningEffort;
  if (effort !== undefined && (typeof effort !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(effort))) {
    throw modelError('INVALID_REASONING_EFFORT', 'Choose a thinking level offered by the model.');
  }
  return { model: `${route.provider}/${route.model}`, maxTokens, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
}

export function checkModelPolicy(selection, policy = {}) {
  if (Array.isArray(policy.allowedModels) && !policy.allowedModels.includes(selection.model)) {
    throw Object.assign(modelError('MODEL_POLICY_DENIED', 'This server’s model policy does not allow the selected model.'), { status: 403 });
  }
  if (Number.isSafeInteger(policy.maxTokens) && selection.maxTokens > policy.maxTokens) {
    throw Object.assign(modelError('MODEL_OUTPUT_LIMIT', `This server accepts at most ${policy.maxTokens} output tokens per call.`), { status: 403 });
  }
}

// Query the native catalog and descriptors without starting a generation or discovery request.
export async function checkModel(llm, selection) {
  const route = modelReference(selection.model);
  if (!llm?.listProviders().some(provider => provider.id === route.provider)) {
    throw modelError('MODEL_PROVIDER_UNAVAILABLE', 'Configure this provider in DSH Models.');
  }
  if (!(await llm.listModels(route.provider)).some(model => model.id === route.model)) {
    throw modelError('MODEL_UNAVAILABLE', 'This model is unavailable. Check its DSH configuration and credentials.');
  }
  const info = await llm.resolveModelInfo?.(route.provider, route.model);
  if (selection.reasoningEffort !== undefined && !info?.reasoning?.efforts?.some(effort => effort.id === selection.reasoningEffort)) {
    throw modelError('INVALID_REASONING_EFFORT', 'This model does not offer the selected thinking level.');
  }
  return route;
}
