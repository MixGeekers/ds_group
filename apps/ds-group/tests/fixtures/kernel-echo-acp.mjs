// Synthetic CLI: echo the exact ACP prompt, without a model or filesystem tools.
import { createInterface } from 'node:readline';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
let serial = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'initialize') reply(id, { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, loadSession: true }, authMethods: [] });
  else if (method === 'session/new') reply(id, { sessionId: `echo-${++serial}` });
  else if (method === 'session/load') reply(id, { sessionId: params.sessionId });
  else if (method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: params.prompt.map(block => block.text ?? '').join('\n') } } } }) + '\n');
    reply(id, { stopReason: 'end_turn' });
  } else if (id !== undefined) reply(id, {});
}
