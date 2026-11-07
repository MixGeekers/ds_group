/** A synthetic DSH service boundary. No model, shell, network or real profile. */
export function kernelContext() {
  const listeners = new Map(), routes = new Map(), agents = new Map(), disposers = [], tools = new Map(), guards = [];
  let serial = 0, modelCalls = 0;
  const nativeNames = ['bash', 'write', 'present', 'create_goal', 'update_goal', 'subagent', 'spawn_teammate', 'schedule_create'];
  const services = new Map();
  const ctx = {
    listeners, routes, agents, guards, toolsMap: tools,
    logger: { info() {}, warn() {} }, reflect: { get: name => services.get(name) }, get: name => services.get(name),
    inject() { return { dispose: async () => {} }; },
    on(name, fn) {
      const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list);
      return () => { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); };
    },
    async emit(name, ...args) { for (const fn of listeners.get(name) ?? []) await fn(...args); },
    effect(execute) { const dispose = execute(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
    async dispose() { for (const dispose of disposers.splice(0).reverse()) await dispose(); },
    tools: {
      schemas: agent => [...nativeNames.map(name => ({ name })), ...[...(agent?.toolMap ?? tools).values()].map(tool => ({ name: tool.name }))],
      register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
      guard(fn) { guards.push(fn); return () => {}; },
    },
    systemPrompt: { section: () => () => {} },
    connection: {
      browserPeer: 'synthetic-owner',
      fetch: { register(route) { if (routes.has(route.path)) throw new Error('duplicate route'); routes.set(route.path, route); return () => routes.delete(route.path); } },
      createSharedFetchHandler() { return { fetch: request => routes.get(new URL(request.url).pathname)?.fetch(request) ?? new Response('', { status: 404 }) }; },
    },
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}),
      registerAdapter() { const dispose = () => {}; dispose.replace = () => {}; return dispose; },
      stream() { modelCalls++; throw new Error('No model is installed in the synthetic host'); },
    },
    workspaceRegistry: { get: () => ({ id: 'workspace' }), resolveByPath: async () => ({ id: 'workspace' }), create: async () => ({ id: 'workspace' }), archiveSession: async () => {}, unarchiveSession: async () => {} },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: `created-${++serial}` }),
      resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }),
      prompt: async () => { throw new Error('Structured sources must not be discarded through user-only prompt RPC'); },
    },
    modelCalls: () => modelCalls,
  };
  function agentOf(id) {
    if (agents.has(id)) return agents.get(id);
    const received = [], messages = [], toolMap = new Map(), restricted = [];
    const agent = { id, status: 'idle', received, toolMap, restricted,
      session: { id, requestHeader: () => undefined, snapshotEvents: () => [], deriveMessages: () => messages },
      model: { current: () => undefined }, inbox: { nextTurn: [], nextStep: [] },
      ctx: { tools: { register(tool) { toolMap.set(tool.name, tool); return () => toolMap.delete(tool.name); }, restrict(rule) { restricted.push(rule); return () => {}; } }, on: () => () => {}, effect: execute => execute() },
      followup(message) { received.push({ mode: 'followup', message }); messages.push(message); },
      inject(message) { received.push({ mode: 'inject', message }); messages.push(message); },
      steer(message) { received.push({ mode: 'steer', message }); messages.push(message); },
      whenIdle: async () => {}, cancel() {},
    };
    agents.set(id, agent); return agent;
  }
  services.set('agents', { list: () => [...agents.values()] });
  services.set('attachments', { admitPromptContent: async content => content });
  return ctx;
}
