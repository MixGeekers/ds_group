"""One-shot isolated public API experiment; no product imports or upstream edits."""
from __future__ import annotations
import asyncio, contextlib, hashlib, importlib.metadata, io, json, os, pathlib, re, secrets, signal, socket, subprocess, sys, threading, time, urllib.request, zipfile
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import httpx, yaml
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

BASE=pathlib.Path(__file__).resolve().parents[1]
SOURCE=BASE/'vendor/Ombre-Brain-115d831d979bf67efc7150f976e2cb34c333c935'
RUNTIME=BASE/'runtime'; ART=BASE/'artifacts'
MODEL=pathlib.Path('/Users/caja/Documents/DFY/embed-eval/models/harrier-0.6b-q8_0.gguf')
LLAMA=pathlib.Path('/Users/caja/Documents/DFY/embed-eval/tools/llama.cpp/build/bin/llama-server')
CONTENT='SHIYU_OMBRE_SYNTHETIC_20261102：这是唯一的合成测试记忆。青色纸鹤放在实验桌左侧，约定明天十点检查。'
TITLE='识雨单桶合成验证 20261102'
EVIDENCE={'schemaVersion':1,'startedAt':datetime.now(timezone.utc).isoformat(),'status':'running','scope':'one synthetic test-data bucket; public API only; no DSH or real material','calls':[],'processes':[],'embeddingRequests':[],'generationRequests':[],'otherProxyRequests':[],'checks':{},'stages':[]}
PROCESSES=[]; LOGS=[]; proxy=None; proxy_thread=None

def sha(data):return hashlib.sha256(data).hexdigest()
def file_sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for c in iter(lambda:f.read(1024*1024),b''):h.update(c)
 return h.hexdigest()
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def stage(name):
 EVIDENCE['stages'].append({'name':name,'at':datetime.now(timezone.utc).isoformat()});print(name,flush=True)
def check(name,condition,details=None):
 EVIDENCE['checks'][name]={'passed':bool(condition),**({'details':details} if details is not None else {})}
 if not condition:raise AssertionError(name)
def clean_env():
 return {'PATH':'/usr/bin:/bin','LANG':'en_US.UTF-8','PYTHONUNBUFFERED':'1','PYTHONDONTWRITEBYTECODE':'1','TMPDIR':str(BASE/'tmp'),'NO_PROXY':'127.0.0.1,localhost'}
def start(name,args,env,cwd):
 log=(RUNTIME/(name+'.log')).open('wb');LOGS.append(log)
 proc=subprocess.Popen(args,env=env,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 rec={'name':name,'pid':proc.pid,'startedAt':datetime.now(timezone.utc).isoformat(),'owned':True}
 EVIDENCE['processes'].append(rec);PROCESSES.append((proc,rec));return proc

def stop(proc):
 rec=next(r for p,r in PROCESSES if p is proc)
 if proc.poll() is None:
  rec['stopSignal']='SIGTERM'
  os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:
   rec['escalatedToKill']=True;os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
 rec.update(exitCode=proc.returncode,stoppedAt=datetime.now(timezone.utc).isoformat(),alive=False)

async def ready(proc,url):
 async with httpx.AsyncClient(trust_env=False,timeout=1) as client:
  for _ in range(120):
   if proc.poll() is not None:raise RuntimeError('Owned service exited before readiness')
   try:
    response=await client.get(url)
    if response.status_code==200:return response
   except httpx.HTTPError:pass
   await asyncio.sleep(.25)
 raise TimeoutError('Owned service startup deadline')

class Proxy(BaseHTTPRequestHandler):
 backend='';
 def log_message(self,*args):pass
 def do_POST(self):
  length=int(self.headers.get('Content-Length','0'))
  if length>65536:self.send_error(413);return
  raw=self.rfile.read(length)
  if self.path=='/v1/embeddings':
   data=json.loads(raw);texts=data.get('input',[]);texts=[texts] if isinstance(texts,str) else texts
   rec={'path':self.path,'model':data.get('model'),'textHashes':[sha(t.encode()) for t in texts],'inputLengths':[len(t) for t in texts]}
   EVIDENCE['embeddingRequests'].append(rec)
   try:
    req=urllib.request.Request(self.backend+self.path,data=raw,headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=20) as res:body=res.read(1024*1024);status=res.status
    decoded=json.loads(body);rec.update(status=status,dimensions=[len(v['embedding']) for v in decoded.get('data',[])])
   except Exception as exc:body=json.dumps({'error':type(exc).__name__}).encode();status=502;rec['status']=status
  else:
   target='generationRequests' if '/chat/completions' in self.path or '/completions' in self.path else 'otherProxyRequests'
   EVIDENCE[target].append({'path':self.path,'bodySha256':sha(raw)});body=b'{"error":"generation and other upstream routes disabled by experiment"}';status=403
  self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

@contextlib.asynccontextmanager
async def mcp_session(endpoint,token):
 def client_factory(headers=None,timeout=None,auth=None):return httpx.AsyncClient(headers=headers,timeout=timeout,auth=auth,trust_env=False)
 async with streamablehttp_client(endpoint+'/mcp',headers={'Authorization':'Bearer '+token},timeout=20,sse_read_timeout=30,httpx_client_factory=client_factory) as streams:
  async with ClientSession(streams[0],streams[1],read_timeout_seconds=timedelta(seconds=30)) as session:
   init=await session.initialize();EVIDENCE.setdefault('serverInfo',[]).append(init.serverInfo.model_dump(mode='json'))
   yield session

async def call(session,name,args,label):
 stage(label);beg=time.monotonic()
 result=await session.call_tool(name,args)
 payload=result.model_dump(mode='json');text='\n'.join(x.text for x in result.content if getattr(x,'type',None)=='text')
 record={'label':label,'name':name,'arguments':args,'durationMs':round((time.monotonic()-beg)*1000),'isError':bool(result.isError),'responseSha256':sha(text.encode()),'responseText':text}
 EVIDENCE['calls'].append(record)
 # Every body here comes only from one synthetic empty vault. Do not generalize this recorder to real material.
 check(label+'_protocol_ok',not result.isError)
 check(label+'_no_runtime_error_text','[OB-E004]' not in text)
 return text

async def exact(session,bucket,label,archived=False):
 text=await call(session,'breath_advanced',{'query':bucket,'max_results':1,'max_tokens':4000,'mode':'manual','with_ids':True},label)
 check(label+'_id_bound',bucket in text)
 check(label+'_fixed_content',CONTENT in text)
 if not archived:check(label+'_exact_marker','[exact_bucket_id:true]' in text)
 return text

async def dashboard(endpoint,password):
 client=httpx.AsyncClient(base_url=endpoint,trust_env=False,timeout=25)
 try:
  res=await client.post('/auth/login',json={'password':password},headers={'Origin':endpoint})
  check('dashboard_login',res.status_code==200 and res.json().get('ok') is True)
  return client
 except BaseException:
  await client.aclose();raise

async def experiment():
 global proxy,proxy_thread
 RUNTIME.mkdir(exist_ok=True);ART.mkdir(exist_ok=True);(BASE/'tmp').mkdir(exist_ok=True)
 check('fresh_vault',not (RUNTIME/'vault').exists())
 check('pinned_harrier',file_sha(MODEL)=='b017b8fceae7c77864652c63d07af51480088b078771a89cafe1a467b069ea75')
 check('pinned_llama',file_sha(LLAMA)=='0e142035f2622a23ff6a04f51a0c4594dce87acf0389a4e839e4714c953bdac8')
 EVIDENCE['environment']={'python':sys.version,'platform':sys.platform,'machine':os.uname().machine,'packages':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()}}
 EVIDENCE['source']=json.loads((ART/'source.json').read_text())
 llport,obport=port(),port();Proxy.backend=f'http://127.0.0.1:{llport}'
 proxy=ThreadingHTTPServer(('127.0.0.1',0),Proxy);proxy.daemon_threads=False
 proxy_thread=threading.Thread(target=proxy.serve_forever,daemon=True);proxy_thread.start();proxy_base=f'http://127.0.0.1:{proxy.server_port}'
 llargs=[str(LLAMA),'-m',str(MODEL),'--embeddings','--pooling','last','--alias','shiyu-harrier-0.6b-q8_0','-ngl','999','-c','4096','-b','512','-ub','512','-t','4','--host','127.0.0.1','--port',str(llport),'-fa','off']
 ll=start('harrier',llargs,clean_env(),RUNTIME);await ready(ll,f'http://127.0.0.1:{llport}/health');stage('harrier_ready')
 config={'transport':'streamable-http','timezone':'America/Caracas','log_level':'INFO','mcp_require_auth':True,'mcp_auth_mode':'token','embedding':{'enabled':True,'background_indexing':False,'api_format':'openai_compat','api_key':'local-placeholder','base_url':proxy_base+'/v1','model':'shiyu-harrier-0.6b-q8_0','dim':1024,'timeout_seconds':15},'dehydration':{'api_key':'','api_format':'openai_compat','base_url':proxy_base+'/v1','model':'disabled','timeout_seconds':1},'github_sync':{'auto_interval_minutes':0,'repo':'','token':''},'hooks':{'allow_public':False},'decay':{'check_interval_hours':24},'surfacing':{'breath_max_tokens':4000,'breath_max_results':5}}
 config_file=RUNTIME/'config.yaml';config_file.write_text(yaml.safe_dump(config,allow_unicode=True))
 token,password=secrets.token_hex(24),secrets.token_hex(24)
 env=clean_env()|{'OMBRE_CONFIG_PATH':str(config_file),'OMBRE_VAULT_DIR':str(RUNTIME/'vault'),'OMBRE_BUCKETS_DIR':str(RUNTIME/'vault'),'OMBRE_LOG_DIR':str(RUNTIME/'logs'),'OMBRE_MEDIA_DIR':str(RUNTIME/'vault/_media'),'OMBRE_BIND_HOST':'127.0.0.1','OMBRE_BIND_ADDRESS':'127.0.0.1','OMBRE_PORT':str(obport),'OMBRE_HOOK_SKIP':'1','OMBRE_MCP_TOKEN':token,'OMBRE_DASHBOARD_PASSWORD':password}
 EVIDENCE['configuration']={'transport':'streamable-http','loopbackOnly':True,'generationApiKeyEmpty':True,'generationRequestsRejectedAtLoopback':True,'embeddingBackgroundIndexing':False,'embeddingQueryDocumentPrefixApplied':False,'githubAutoIntervalMinutes':0,'hookSkip':True,'newEmptyVault':True,'dashboardCredential':'ephemeral-in-memory-only','mcpCredential':'ephemeral-in-memory-only','configSha256':file_sha(config_file),'environmentNames':sorted(env)}
 endpoint=f'http://127.0.0.1:{obport}'
 ob=start('ombre_first',[sys.executable,str(SOURCE/'src/server.py')],env,SOURCE)
 await ready(ob,endpoint+'/health');stage('ombre_first_ready')
 async with mcp_session(endpoint,token) as session:
  tools=await session.list_tools();names=[t.name for t in tools.tools]
  (ART/'tools.json').write_text(json.dumps([t.model_dump(mode='json') for t in tools.tools],ensure_ascii=False,indent=2)+'\n')
  check('public_tools_present',all(n in names for n in ['grow','trace','breath_advanced']))
  check('relations_tools_disabled','you' not in [n.lower() for n in names] and 'them' not in [n.lower() for n in names],names)
  created=await call(session,'grow',{'content':'','items':[{'content':CONTENT,'title':TITLE,'tags':['shiyu-synthetic'],'domain':['shiyu-test'],'valence':0.5,'arousal':0.3,'importance':5}],'test_data':True},'create_once')
  check('create_no_metadata_fallback','打标失败' not in created and 'fallback' not in created.lower())
  found=await call(session,'breath_advanced',{'query':'SHIYU_OMBRE_SYNTHETIC_20261102','max_results':5,'max_tokens':4000,'mode':'manual','with_ids':True},'discover_created_id')
  marker=re.search(r'=== ombre:result-ids ===\s*```json\s*(\{[^\n]+\})',found)
  check('id_manifest_present',marker is not None)
  ids=json.loads(marker.group(1))['bucket_ids'];check('exactly_one_created_bucket',len(ids)==1)
  bucket=ids[0];EVIDENCE['bucketId']=bucket
  await exact(session,bucket,'read_after_create')
 stage('normal_restart');stop(ob)
 check('first_normal_exit',ob.returncode==0)
 ob=start('ombre_second',[sys.executable,str(SOURCE/'src/server.py')],env,SOURCE);await ready(ob,endpoint+'/health')
 async with mcp_session(endpoint,token) as session:
  await exact(session,bucket,'read_after_restart')
  client=None
  try:
   client=await dashboard(endpoint,password)
   detail=await client.get('/api/bucket/'+bucket)
   check('public_raw_read',detail.status_code==200 and detail.json().get('id')==bucket and detail.json().get('content')==CONTENT,{'status':detail.status_code,'keys':list(detail.json())})
   (ART/'bucket-before.json').write_text(json.dumps(detail.json(),ensure_ascii=False,indent=2)+'\n')
   stage('native_export');export=await client.get('/api/export');check('export_http',export.status_code==200,{'status':export.status_code})
   z=zipfile.ZipFile(io.BytesIO(export.content));manifest=json.loads(z.read('backup_manifest.json'))
   members=[i.filename for i in z.infolist() if not i.is_dir()]
   declared=[f['path'] for f in manifest['files']]
   check('export_manifest_structure',manifest.get('schema_version')==1 and manifest.get('kind')=='ombre-brain-backup' and manifest.get('version')=='3.6.14'
     and len(members)==len(set(members)) and len(declared)==len(set(declared)) and set(members)==set(declared)|{'backup_manifest.json'}
     and manifest['file_count']==len(declared) and manifest['total_bytes']==sum(f['size'] for f in manifest['files']))
   check('export_manifest',all(len(z.read(f['path']))==f['size'] and sha(z.read(f['path']))==f['sha256'] for f in manifest['files']))
   export_meta=json.loads(z.read('export_meta.json'))
   check('export_metadata',export_meta.get('version')=='3.6.14' and export_meta.get('exported_at')==manifest.get('created_at'))
   check('export_no_configuration',not any('config.yaml' in name or 'auth' in name for name in z.namelist()))
   check('export_contains_synthetic_bucket',any(CONTENT.encode() in z.read(n) for n in z.namelist() if n.endswith('.md')))
   EVIDENCE['export']={'bytes':len(export.content),'sha256':sha(export.content),'manifest':manifest,'responseVerifiedHeader':export.headers.get('X-Ombre-Backup-Verified')}
   (ART/'export-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
  except Exception as exc:
   EVIDENCE['exportFailure']={'type':type(exc).__name__,'detail':str(exc)[:300]}
  finally:
   if client:await client.aclose()
  await call(session,'trace',{'bucket_id':bucket,'delete':True},'archive')
  archived=await exact(session,bucket,'read_archive',archived=True)
  check('archive_explicit','[query 命中·已删除到档案]' in archived and '[状态:已退出日常记忆，原文仍保留]' in archived)
  await call(session,'trace',{'bucket_id':bucket,'restore':True},'restore')
  await exact(session,bucket,'read_restored')
  await call(session,'trace',{'bucket_id':bucket,'hard_delete':True,'delete_reason':'Cleanup of the single explicitly synthetic Shiyu feasibility bucket'},'hard_delete')
  missing=await call(session,'breath_advanced',{'query':bucket,'max_results':5,'max_tokens':4000,'mode':'manual','with_ids':True},'read_missing_after_delete')
  check('deleted_id_not_returned','[bucket_id:'+bucket+']' not in missing and CONTENT not in missing)
  # Exact-id search intentionally falls through for missing IDs: authoritative HTTP 404 is an independent public check.
  client=await dashboard(endpoint,password)
  try:
   res=await client.get('/api/bucket/'+bucket);check('deleted_public_404',res.status_code==404,{'status':res.status_code})
  finally:await client.aclose()
 await asyncio.sleep(.2)
 check('zero_generation_endpoint_requests',len(EVIDENCE['generationRequests'])==0)
 check('no_other_proxy_requests',len(EVIDENCE['otherProxyRequests'])==0)
 check('local_embeddings_observed',len(EVIDENCE['embeddingRequests'])>0 and all(r.get('status')==200 and r.get('dimensions')==[1024] for r in EVIDENCE['embeddingRequests']))
 EVIDENCE['status']='passed' if not EVIDENCE.get('exportFailure') else 'partial'

async def main():
 try:
  async with asyncio.timeout(300):await experiment()
 except BaseException as exc:
  EVIDENCE['status']='failed';EVIDENCE['failure']={'type':type(exc).__name__,'detail':str(exc)[:500]};print('experiment_failed: '+type(exc).__name__+': '+str(exc)[:200],flush=True)
 finally:
  for proc,rec in reversed(PROCESSES):
   try:stop(proc)
   except Exception as exc:rec['cleanupError']=type(exc).__name__
  if proxy:proxy.shutdown();proxy.server_close()
  if proxy_thread:proxy_thread.join(timeout=2)
  for log in LOGS:log.close()
  EVIDENCE['finishedAt']=datetime.now(timezone.utc).isoformat()
  EVIDENCE['allOwnedChildrenStopped']=all(p.poll() is not None for p,_ in PROCESSES)
  EVIDENCE['finalCountsAfterOwnedProcessesAndProxyStopped']={k:len(EVIDENCE[k]) for k in ['embeddingRequests','generationRequests','otherProxyRequests']}
  EVIDENCE['checks']['final_zero_generation_requests']={'passed':not EVIDENCE['generationRequests']}
  EVIDENCE['checks']['final_no_other_proxy_requests']={'passed':not EVIDENCE['otherProxyRequests']}
  EVIDENCE['checks']['final_embeddings_valid']={'passed':bool(EVIDENCE['embeddingRequests']) and all(r.get('status')==200 and r.get('dimensions')==[1024] for r in EVIDENCE['embeddingRequests'])}
  if not EVIDENCE['allOwnedChildrenStopped'] or any(r.get('cleanupError') or r.get('escalatedToKill') for _,r in PROCESSES) or not all(EVIDENCE['checks'][k]['passed'] for k in ['final_zero_generation_requests','final_no_other_proxy_requests','final_embeddings_valid']):EVIDENCE['status']='failed'
  EVIDENCE['scriptSha256']=file_sha(pathlib.Path(__file__))
  EVIDENCE['planSha256']=file_sha(BASE/'实验计划.md')
  ART.mkdir(exist_ok=True);(ART/'run.json').write_text(json.dumps(EVIDENCE,ensure_ascii=False,indent=2)+'\n')
  print(json.dumps({'status':EVIDENCE['status'],'allOwnedChildrenStopped':EVIDENCE['allOwnedChildrenStopped'],'embeddingRequests':len(EVIDENCE['embeddingRequests']),'generationRequests':len(EVIDENCE['generationRequests'])}),flush=True)
if __name__=='__main__':asyncio.run(main())
