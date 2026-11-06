// Read a stopped test's durable memory without booting DSH or flushing model work.
import {readFile,writeFile,mkdtemp,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {MemoryStore} from '../memory/store.mjs';
if(!process.argv[2])throw new Error('Pass the isolated, stopped collaboration run directory');
const directory=path.resolve(process.argv[2]);
const report=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'));
if(!['provider-blocked','failed','stopped-by-operator'].includes(report.status))throw new Error('This snapshot is for an interrupted, stopped run');
const filename=path.join(report.runtimeDirectory||path.join(directory,'host'),'home/bot/knowledge/knowledge.sqlite');
const hashes=async()=>Object.fromEntries(await Promise.all(['','-wal'].map(async suffix=>{
  try{return[path.basename(filename)+suffix,createHash('sha256').update(await readFile(filename+suffix)).digest('hex')];}
  catch(error){if(error.code==='ENOENT')return[path.basename(filename)+suffix,null];throw error;}
})));
const before=await hashes();
// SQLite can create an empty WAL/SHM even for a read-only connection. Open a
// private snapshot copy, and verify the source database and WAL did not change.
const copyDirectory=await mkdtemp(path.join(directory,'offline-memory-'));
const copy=path.join(copyDirectory,path.basename(filename));
await copyFile(filename,copy);
if(before[path.basename(filename)+'-wal']!==null)await copyFile(filename+'-wal',copy+'-wal');
// Skip the normal constructor's schema/deployment writes. Use only query methods.
const store=Object.create(MemoryStore.prototype);
store.db=new DatabaseSync(copy,{readOnly:true});store.db.exec('PRAGMA query_only=ON');store.clock=Date.now;
let snapshot;
try{snapshot={at:new Date().toISOString(),kind:'offline-read-only-copy',reviewFlushed:false,reason:report.status,
  entries:store.list({history:true}),sources:store.sources(),contacts:store.contacts(),
  pendingReviews:(report.bots||[]).map(bot=>({botId:bot.nativeBotId,refs:store.getMeta(`unreviewed:${bot.nativeBotId}`)||[]})),
  errors:null,usage:null,note:'Runtime errors and embedding counters are not reconstructed by this SQLite read. Pending reviews remain unprocessed.'};}
finally{store.close();}
const after=await hashes();assert.deepEqual(after,before,'Reading the snapshot changed the durable database');
snapshot.databaseIntegrity={before,after,unchanged:true};
await writeFile(path.join(directory,'memory-after-stop.json'),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({entries:snapshot.entries.length,sources:snapshot.sources.length,contacts:snapshot.contacts.length,
  pendingReviews:snapshot.pendingReviews.map(row=>({botId:row.botId,count:row.refs.length})),databaseUnchanged:true}));
