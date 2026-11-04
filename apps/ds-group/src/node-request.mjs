const MAX_BRIDGE_BYTES = 512000;

function requestBytes(input) {
  return Buffer.byteLength(JSON.stringify({ ...input, async: true }), 'utf8');
}

/** Keep the current task intact while fitting recent room history into the bridge body. */
export function boundTaskRequest(input, { maxBytes = 500000 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('A task request must be an object');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BRIDGE_BYTES) {
    throw new RangeError(`Task request budget must be between 1 and ${MAX_BRIDGE_BYTES} bytes`);
  }
  if (input.history !== undefined && !Array.isArray(input.history)) throw new TypeError('Task history must be an array');
  if (input.historyWarnings !== undefined && (!Array.isArray(input.historyWarnings)
    || input.historyWarnings.some(warning => typeof warning !== 'string'))) throw new TypeError('History warnings must contain strings');

  const history = input.history || [];
  const warnings = input.historyWarnings || [];
  const bounded = { ...input,
    ...(input.history === undefined ? {} : { history: [...history] }),
    ...(input.historyWarnings === undefined ? {} : { historyWarnings: [...warnings] }),
  };
  if (requestBytes(bounded) <= maxBytes) return bounded;

  for (let omitted = 1; omitted <= history.length; omitted++) {
    bounded.history = history.slice(omitted);
    bounded.historyWarnings = [...warnings, `为满足请求大小限制，本次额外省略最早的 ${omitted} 条历史消息。`];
    if (requestBytes(bounded) <= maxBytes) return bounded;
  }
  throw Object.assign(new Error('Current task, file metadata and history warnings exceed the bridge request size limit'), {
    code: 'TASK_REQUEST_TOO_LARGE', status: 413,
  });
}
