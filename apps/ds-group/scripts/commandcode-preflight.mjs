import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {memoryTestModel} from './memory-test-model.mjs';
import {modelReference} from '../src/model-config.mjs';

// Catalog access is not a quota balance. Generation availability is verified by
// the separate actual DSH smoke run and each subsequent request's real result.
export async function readCommandCodeCatalog(home,{fetchImpl=fetch,model}={}){
  const route=modelReference(memoryTestModel(model));
  if(route.provider!=='commandcode-goat')throw new Error('This optional catalog helper only supports the CommandCode provider');
  const config=parse(await readFile(path.join(home,'profiles/web/cordis.patch.yml'),'utf8'));
  const provider=config.find(row=>row.id==='llm-pi-ai')?.config?.providers?.[route.provider];
  const credentials=parse(await readFile(path.join(home,'.credentials.yaml'),'utf8'));
  const key=provider?.apiKeyEnv?credentials.refs?.[provider.apiKeyEnv]:credentials.records?.[`llm-pi-ai/${route.provider}`]?.apiKey;
  if(typeof key!=='string'||!key)throw new Error('CommandCode credential unavailable');
  const base=new URL(provider.baseURL);if(base.origin!=='https://api.commandcode.ai'||base.username||base.password||base.search||base.hash)throw new Error('Unexpected CommandCode endpoint');
  const endpoint=provider.baseURL.replace(/\/$/,'')+'/models';
  const response=await fetchImpl(endpoint,{headers:{authorization:`Bearer ${key}`,accept:'application/json'},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`CommandCode catalog HTTP ${response.status}`);
  const body=await response.json();if(!Array.isArray(body.data))throw new Error('Unrecognized CommandCode model catalog');
  const selected=body.data.find(item=>item.id===route.model);
  return{at:new Date().toISOString(),kind:'model-catalog',endpoint,status:response.status,available:Boolean(selected),model,
    selected:selected?{id:selected.id,name:selected.name,contextLength:selected.context_length,supportedEndpoints:selected.supported_endpoints}:null,
    allowanceKnown:false,blockedWindows:[],resetAt:null};
}
