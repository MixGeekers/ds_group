// Read the configured Go account's allowance without generating a model turn.
// No credentials or account identifiers are returned or logged.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
export async function readGoQuota(home,{fetchImpl=fetch}={}) {
  const patches=parse(await readFile(path.join(home,'profiles/web/cordis.patch.yml'),'utf8'));
  const provider=patches.find(x=>x.id==='llm-pi-ai')?.config?.providers?.['opencode-go'];
  const credentials=parse(await readFile(path.join(home,'.credentials.yaml'),'utf8'));
  const key=provider?.apiKeyEnv?credentials.refs?.[provider.apiKeyEnv]:credentials.records?.['llm-pi-ai/opencode-go']?.apiKey;
  if(typeof key!=='string')throw new Error('The configured Go credential cannot be read for allowance preflight');
  const endpoint='https://opencode.ai/zen/go/v1/usage';
  const response=await fetchImpl(endpoint,{headers:{authorization:`Bearer ${key}`,accept:'application/json'},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Go allowance preflight HTTP ${response.status}`);
  const body=await response.json(),usage={};
  for(const name of ['rolling','weekly','monthly']) {
    const window=body.usage?.[name];
    if(!window||!['ok','rate-limited'].includes(window.status))throw new Error('Unrecognized Go allowance response');
    usage[name]={status:window.status,percent:window.percent,resetsAt:window.resetsAt};
  }
  const limited=Object.entries(usage).filter(([,window])=>window.status==='rate-limited');
  return{at:new Date().toISOString(),endpoint,status:response.status,available:limited.length===0,usage,
    blockedWindows:limited.map(([name])=>name),resetAt:limited.length?limited.map(([,window])=>window.resetsAt).sort().at(-1):null};
}
