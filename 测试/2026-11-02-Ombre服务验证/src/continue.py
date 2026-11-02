"""Continue the confirmed existing bucket after the harness-only shutdown assertion failure.
No grow/hold/create call exists in this continuation.
"""
import run as r
import asyncio, io, json, pathlib, secrets, signal, threading, zipfile
from datetime import datetime,timezone
import yaml

async def continuation():
 prior=json.loads((r.ART/'attempt-1.json').read_text());bucket=prior['bucketId']
 r.EVIDENCE['scope']='continuation of the one confirmed existing test bucket; never create again'
 r.EVIDENCE['priorAttempt']={'file':'artifacts/attempt-1.json','sha256':r.file_sha(r.ART/'attempt-1.json'),'status':prior['status'],'failure':prior['failure']}
 r.EVIDENCE['bucketId']=bucket
 r.check('existing_confirmed_bucket',bucket=='b5f8d3bc4c85' and prior['checks']['read_after_create_fixed_content']['passed'] and prior['checks']['read_after_create_id_bound']['passed'])
 first=next(p for p in prior['processes'] if p['name']=='ombre_first')
 log=(r.RUNTIME/'ombre_first.log').read_text()
 r.check('prior_graceful_shutdown_verified',first['exitCode']==-signal.SIGTERM and first['alive'] is False and 'Application shutdown complete.' in log and ('Finished server process ['+str(first['pid'])+']') in log)
 r.check('pinned_harrier',r.file_sha(r.MODEL)=='b017b8fceae7c77864652c63d07af51480088b078771a89cafe1a467b069ea75')
 r.check('pinned_llama',r.file_sha(r.LLAMA)=='0e142035f2622a23ff6a04f51a0c4594dce87acf0389a4e839e4714c953bdac8')
 llport,obport=r.port(),r.port();r.Proxy.backend=f'http://127.0.0.1:{llport}'
 r.proxy=r.ThreadingHTTPServer(('127.0.0.1',0),r.Proxy);r.proxy.daemon_threads=False
 r.proxy_thread=threading.Thread(target=r.proxy.serve_forever,daemon=True);r.proxy_thread.start();proxybase=f'http://127.0.0.1:{r.proxy.server_port}'
 llargs=[str(r.LLAMA),'-m',str(r.MODEL),'--embeddings','--pooling','last','--alias','shiyu-harrier-0.6b-q8_0','-ngl','999','-c','4096','-b','512','-ub','512','-t','4','--host','127.0.0.1','--port',str(llport),'-fa','off']
 ll=r.start('harrier_continuation',llargs,r.clean_env(),r.RUNTIME);await r.ready(ll,f'http://127.0.0.1:{llport}/health')
 configfile=r.RUNTIME/'config.yaml';config=yaml.safe_load(configfile.read_text());config['embedding']['base_url']=proxybase+'/v1';config['dehydration']['base_url']=proxybase+'/v1';configfile.write_text(yaml.safe_dump(config,allow_unicode=True))
 token,password=secrets.token_hex(24),secrets.token_hex(24)
 env=r.clean_env()|{'OMBRE_CONFIG_PATH':str(configfile),'OMBRE_VAULT_DIR':str(r.RUNTIME/'vault'),'OMBRE_BUCKETS_DIR':str(r.RUNTIME/'vault'),'OMBRE_LOG_DIR':str(r.RUNTIME/'logs'),'OMBRE_MEDIA_DIR':str(r.RUNTIME/'vault/_media'),'OMBRE_BIND_HOST':'127.0.0.1','OMBRE_BIND_ADDRESS':'127.0.0.1','OMBRE_PORT':str(obport),'OMBRE_HOOK_SKIP':'1','OMBRE_MCP_TOKEN':token,'OMBRE_DASHBOARD_PASSWORD':password}
 r.EVIDENCE['configuration']={'configSha256':r.file_sha(configfile),'sameVault':True,'environmentNames':sorted(env),'generationApiKeyEmpty':config['dehydration']['api_key']=='','generationBaseIsDenyProxy':True,'embeddingBackgroundIndexing':False}
 endpoint=f'http://127.0.0.1:{obport}';ob=r.start('ombre_restart',[r.sys.executable,str(r.SOURCE/'src/server.py')],env,r.SOURCE);await r.ready(ob,endpoint+'/health');r.stage('normal_restart_ready')
 async with r.mcp_session(endpoint,token) as session:
  await r.exact(session,bucket,'read_after_restart')
  client=None
  try:
   client=await r.dashboard(endpoint,password)
   detail=await client.get('/api/bucket/'+bucket)
   r.check('public_raw_read',detail.status_code==200 and detail.json().get('id')==bucket and detail.json().get('content')==r.CONTENT,{'status':detail.status_code,'keys':list(detail.json())})
   (r.ART/'bucket-before.json').write_text(json.dumps(detail.json(),ensure_ascii=False,indent=2)+'\n')
   r.stage('native_export');export=await client.get('/api/export');r.check('export_http',export.status_code==200,{'status':export.status_code})
   z=zipfile.ZipFile(io.BytesIO(export.content));manifest=json.loads(z.read('backup_manifest.json'));members=[i.filename for i in z.infolist() if not i.is_dir()];declared=[f['path'] for f in manifest['files']]
   r.check('export_manifest_structure',manifest.get('schema_version')==1 and manifest.get('kind')=='ombre-brain-backup' and manifest.get('version')=='3.6.14' and len(members)==len(set(members)) and len(declared)==len(set(declared)) and set(members)==set(declared)|{'backup_manifest.json'} and manifest['file_count']==len(declared) and manifest['total_bytes']==sum(f['size'] for f in manifest['files']))
   r.check('export_manifest',all(len(z.read(f['path']))==f['size'] and r.sha(z.read(f['path']))==f['sha256'] for f in manifest['files']))
   meta=json.loads(z.read('export_meta.json'));r.check('export_metadata',meta.get('version')=='3.6.14' and meta.get('exported_at')==manifest.get('created_at'))
   r.check('export_no_configuration',not any('config.yaml' in name or 'auth' in name for name in members))
   r.check('export_contains_synthetic_bucket',any(r.CONTENT.encode() in z.read(n) for n in members if n.endswith('.md')))
   r.EVIDENCE['export']={'bytes':len(export.content),'sha256':r.sha(export.content),'manifest':manifest,'responseVerifiedHeader':export.headers.get('X-Ombre-Backup-Verified')};(r.ART/'export-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
  except Exception as exc:r.EVIDENCE['exportFailure']={'type':type(exc).__name__,'detail':str(exc)[:300]}
  finally:
   if client:await client.aclose()
  await r.call(session,'trace',{'bucket_id':bucket,'delete':True},'archive')
  archived=await r.exact(session,bucket,'read_archive',archived=True)
  r.check('archive_explicit','[query 命中·已删除到档案]' in archived and '[状态:已退出日常记忆，原文仍保留]' in archived)
  await r.call(session,'trace',{'bucket_id':bucket,'restore':True},'restore');await r.exact(session,bucket,'read_restored')
  await r.call(session,'trace',{'bucket_id':bucket,'hard_delete':True,'delete_reason':'Cleanup of the single explicitly synthetic Shiyu feasibility bucket'},'hard_delete')
  missing=await r.call(session,'breath_advanced',{'query':bucket,'max_results':5,'max_tokens':4000,'mode':'manual','with_ids':True},'read_missing_after_delete')
  r.check('deleted_id_not_returned','[bucket_id:'+bucket+']' not in missing and r.CONTENT not in missing)
  client=await r.dashboard(endpoint,password)
  try:
   res=await client.get('/api/bucket/'+bucket);r.check('deleted_public_404',res.status_code==404,{'status':res.status_code})
  finally:await client.aclose()
 await asyncio.sleep(.2)
 r.EVIDENCE['status']='passed' if not r.EVIDENCE.get('exportFailure') else 'partial'
 r.EVIDENCE['continuationScriptSha256']=r.file_sha(pathlib.Path(__file__))
 r.EVIDENCE['continuationPlanSha256']=r.file_sha(r.BASE/'续跑计划.md')
r.experiment=continuation
if __name__=='__main__':asyncio.run(r.main())
