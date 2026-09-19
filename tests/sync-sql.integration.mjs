// Explicit integration test, only run by scripts/test-supabase.sh in its cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import 'fake-indexeddb/auto';
import { savePrompt, saveFolder, softDeleteFolder, listPrompts, listFolders, getPrompt, openDatabase } from '../db.js';
import { runSync, saveConnection } from '../core/sync.js';
import { cloudDetails } from '../core/sync-storage.js';

const socket=process.env.PROMPT_VAULT_TEST_SOCKET;
if (!socket?.startsWith('/tmp/prompt-vault-sql.')) throw new Error('Run only through isolated SQL test runner');
const storage={}; const calls=[];
globalThis.chrome={storage:{local:{get:async key=>({[key]:storage[key]}),set:async values=>Object.assign(storage,values)}},
  permissions:{request:async()=>true,contains:async()=>true}};
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(name,options,callback)=>callback({})}},configurable:true});
function sql(statement) {
  return new Promise((resolve,reject)=>{
    const child=spawn('psql',['-X','-h',socket,'-p','5432','-U','postgres','-d','postgres','-Atq','-v','ON_ERROR_STOP=1']);
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
    child.on('error',reject);child.on('close',code=>code?reject(new Error(err)):resolve(out.trim()));child.stdin.end(statement);
  });
}
let loseNextPush=false;
globalThis.fetch=async(target,options)=>{
  const method=new URL(target).pathname.split('/').at(-1);const body=JSON.parse(options.body);calls.push({method,body});
  const literal=x=>`'${JSON.stringify(x).replaceAll("'","''")}'::jsonb`;
  let invocation;
  if(method==='pv_sync_status') invocation='public.pv_sync_status()';
  else if(method==='pv_sync_push') invocation=`public.pv_sync_push(${literal(body.p_request)})`;
  else if(method==='pv_sync_pull') invocation=`public.pv_sync_pull('${body.p_cursor}',${body.p_limit},${body.p_until===null?'null':`'${body.p_until}'`})`;
  else throw new Error('Unexpected RPC');
  const reply=await sql(`set role anon; select ${invocation};`);
  if(method==='pv_sync_push'&&loseNextPush){loseNextPush=false;throw new TypeError('Simulated response loss');}
  return new Response(reply);
};
async function freshReplica() {
  const db=await openDatabase();await new Promise((resolve,reject)=>{const tx=db.transaction(['prompts','folders','meta','syncQueue'],'readwrite');for(const n of ['prompts','folders','meta','syncQueue'])tx.objectStore(n).clear();tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
}
test('actual JS client interoperates with schema v3: offline push, pull-only second replica, response-loss recovery and deletion',async()=>{
  await sql('truncate prompt_vault.entities,prompt_vault.sync_changes,prompt_vault.sync_receipts; update prompt_vault.sync_state set cursor=0;');
  await saveConnection({url:'https://synthetic.supabase.co',key:'sb_publishable_TEST'});
  const folder=await saveFolder({name:'Work'});
  const row=await savePrompt({title:'Original',content:'Hello',tags:[],folderId:folder.id});
  assert.equal(calls.length,0,'configuration and edits make no requests');
  const first=await runSync({upload:true});assert.equal(first.pendingCount,0);
  assert.equal(JSON.parse(await sql('select count(*)::text from prompt_vault.entities;')),2);
  await savePrompt({...await getPrompt(row.id),title:'Response lost edit'});
  loseNextPush=true;await assert.rejects(runSync({upload:true}));
  const frozen=(await cloudDetails()).pending.request;
  await savePrompt({...await getPrompt(row.id),content:'New edit during uncertain upload'});
  const recovered=await runSync({upload:true});assert.equal(recovered.pendingCount,0);
  assert.equal(calls.filter(x=>x.method==='pv_sync_push'&&x.body.p_request.opId===frozen.opId).length,2);
  const priorPushes=calls.filter(x=>x.method==='pv_sync_push').length;
  await freshReplica(); // Model a second device with no local data or cursor.
  await runSync();assert.equal(calls.filter(x=>x.method==='pv_sync_push').length,priorPushes);
  assert.equal((await listPrompts())[0].title,'Response lost edit');
  assert.equal((await listPrompts())[0].content,'New edit during uncertain upload');
  const f=(await listFolders())[0];await softDeleteFolder(f.id,{expectedVersion:f.version});
  assert.equal((await runSync({upload:true})).pendingCount,0);
  await freshReplica();await runSync();assert.equal((await listFolders()).length,0);assert.equal((await listPrompts())[0].folderId,null);
});
