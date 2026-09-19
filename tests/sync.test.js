import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDatabase, clearAllData, savePrompt, saveFolder, getPrompt, listPrompts, listFolders, touchPromptUsage, softDeletePrompt, softDeleteFolder, exportSnapshot } from '../db.js';
import { bindCloudProject, cloudDetails, prepareUpload, acceptUpload, applyCloudEvent, cloudBackup } from '../core/sync-storage.js';
import { localEntity, validatePull } from '../core/sync-model.js';
import { normalizeConnection, rpc } from '../core/sync.js';

const url = 'https://synthetic.supabase.co';
const prompt = title => ({ title, content: 'Synthetic content', tags: [] });
const remote = (type, row, v) => ({ ...localEntity(type,row), serverVersion:String(v), serverUpdatedAt:new Date(10000 + v).toISOString() });
const event = (v, changes, opId = crypto.randomUUID()) => ({ cursor:String(v), changes, opId, deviceId:'other' });
async function reset() {
  const db = await openDatabase();
  await new Promise((resolve,reject) => {
    const tx = db.transaction('meta','readwrite'); tx.objectStore('meta').clear(); tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error);
  });
  await clearAllData(); return bindCloudProject(url);
}
async function uploaded(token) {
  const pending = await prepareUpload(token);
  const changes = [];
  for (const c of pending.request.changes) {
    const rows = c.entityType === 'prompt' ? await listPrompts({includeDeleted:true}) : await listFolders({includeDeleted:true});
    changes.push(remote(c.entityType,rows.find(x=>x.id===c.id),1));
  }
  await acceptUpload(token,pending.request.opId,{status:'applied',opId:pending.request.opId,cursor:'1'});
  await applyCloudEvent(token,event(1,changes,pending.request.opId));
}

test('connection rejects privileged keys, credentials, URL redirects and unsupported origins', () => {
  assert.deepEqual(normalizeConnection({url,key:'sb_publishable_synthetic'}), {url,key:'sb_publishable_synthetic',autoPull:true});
  for (const key of ['sb_secret_private','anything',`x.${btoa('{"role":"service_role"}')}.x`]) assert.throws(()=>normalizeConnection({url,key}));
  for (const bad of ['http://synthetic.supabase.co','https://supabase.co.evil.test','https://u:p@synthetic.supabase.co','https://synthetic.supabase.co/path','https://synthetic.supabase.co/?x=1']) assert.throws(()=>normalizeConnection({url:bad,key:'sb_publishable_test'}));
  assert.equal(normalizeConnection({url,key:`x.${btoa('{"role":"anon"}')}.x`}).url,url);
});
test('frozen upload survives edits and ACK does not clear a newer generation', async () => {
  const token=await reset(); const row=await savePrompt(prompt('Before'));
  const pending=await prepareUpload(token);
  await savePrompt({...row,title:'After'});
  assert.deepEqual(await prepareUpload(token),pending);
  await acceptUpload(token,pending.request.opId,{status:'applied',opId:pending.request.opId,cursor:'1'});
  assert.equal((await cloudDetails()).pendingCount,1);
  await applyCloudEvent(token,event(1,[remote('prompt',row,1)],pending.request.opId));
  assert.equal((await getPrompt(row.id)).title,'After');
  const next=await prepareUpload(token);
  assert.equal(next.request.changes[0].baseVersion,'1');
  assert.equal(next.request.changes[0].data.title,'After');
  assert.notEqual(next.request.opId,pending.request.opId);
});
test('pull alone can acknowledge a response-lost upload without pushing anything', async () => {
  const token=await reset(), row=await savePrompt(prompt('One')), pending=await prepareUpload(token);
  await applyCloudEvent(token,event(1,[remote('prompt',row,1)],pending.request.opId));
  assert.equal((await cloudDetails()).pending,null);
  assert.equal((await cloudDetails()).pendingCount,0);
});
test('remote edit is atomic with cursor, preserves usage and invalidates stale edit forms', async () => {
  const token=await reset(), row=await savePrompt(prompt('Initial')); await uploaded(token);
  const before=await getPrompt(row.id); await touchPromptUsage(row.id);
  await applyCloudEvent(token,event(2,[remote('prompt',{...before,title:'Remote'},2)]));
  const updated=await getPrompt(row.id);
  assert.equal(updated.title,'Remote'); assert.equal(updated.useCount,1);
  await assert.rejects(savePrompt({...before,title:'stale'}));
  assert.equal((await cloudDetails()).cursor,'2'); assert.equal((await cloudDetails()).pendingCount,0);
});
test('concurrent edits pause before overwriting; keep local rebases only after explicit choice and archives JSON', async () => {
  const token=await reset(), original=await savePrompt(prompt('Base')); await uploaded(token);
  const local=await savePrompt({...await getPrompt(original.id),title:'My edit'});
  const incoming=event(2,[remote('prompt',{...local,title:'Their edit'},2)]);
  assert.equal(await applyCloudEvent(token,incoming),false);
  assert.equal((await getPrompt(local.id)).title,'My edit'); assert.equal((await cloudDetails()).cursor,'1');
  let detail=await cloudDetails();
  await applyCloudEvent(token,incoming,{choice:'local',revision:detail.revision});
  assert.equal((await getPrompt(local.id)).title,'My edit');
  detail=await cloudDetails(); assert.equal(detail.backups.length,1);
  assert.equal((await cloudBackup(detail.backups[0].key)).prompts[0].title,'My edit');
  const next=await prepareUpload(token); assert.equal(next.request.changes[0].baseVersion,'2');
});
test('choosing cloud preserves a complete local recovery snapshot', async () => {
  const token=await reset(), row=await savePrompt(prompt('Local-only'));
  const incoming=event(1,[remote('prompt',{...row,title:'Existing cloud'},1)]);
  assert.equal(await applyCloudEvent(token,incoming),false);
  await applyCloudEvent(token,incoming,{choice:'cloud',revision:(await cloudDetails()).revision});
  assert.equal((await getPrompt(row.id)).title,'Existing cloud');
  assert.equal((await cloudBackup((await cloudDetails()).backups[0].key)).prompts[0].title,'Local-only');
});
test('stale conflict decisions rejected after another edit', async () => {
  const token=await reset(), row=await savePrompt(prompt('Local'));
  const incoming=event(1,[remote('prompt',{...row,title:'Remote'},1)]);
  await applyCloudEvent(token,incoming); const detail=await cloudDetails();
  await savePrompt({...row,title:'New edit'});
  await assert.rejects(applyCloudEvent(token,incoming,{choice:'cloud',revision:detail.revision}),/变化/);
  assert.equal((await getPrompt(row.id)).title,'New edit');
});
test('keep local after remote deletion creates a new ID, never resurrects the tombstone', async () => {
  const token=await reset(), row=await savePrompt(prompt('Base')); await uploaded(token);
  await savePrompt({...await getPrompt(row.id),title:'Offline work'});
  const incoming=event(2,[remote('prompt',{...row,deletedAt:2000},2)]);
  await applyCloudEvent(token,incoming);
  await applyCloudEvent(token,incoming,{choice:'local',revision:(await cloudDetails()).revision});
  const rows=await listPrompts(); assert.equal(rows.length,1); assert.notEqual(rows[0].id,row.id); assert.equal(rows[0].title,'Offline work');
  assert.ok((await getPrompt(row.id)).deletedAt);
  assert.equal((await prepareUpload(token)).request.changes[0].baseVersion,'0');
});
test('remote folder deletion ungroups local-only children without discarding their content', async () => {
  const token=await reset(), folder=await saveFolder({name:'Folder'}); await uploaded(token);
  const local=await savePrompt({...prompt('New offline child'),folderId:folder.id});
  await applyCloudEvent(token,event(2,[remote('folder',{...folder,deletedAt:2000},2)]));
  assert.equal((await getPrompt(local.id)).folderId,null); assert.equal((await getPrompt(local.id)).title,'New offline child');
});
test('inconsistent remote graph rolls back entity and base/cursor writes', async () => {
  const token=await reset(); const row={id:'bad',...prompt('Bad'),description:'',sortOrder:0,createdAt:100,tags:[],favorite:false,folderId:'missing',deletedAt:null};
  await assert.rejects(applyCloudEvent(token,event(1,[remote('prompt',row,1)])));
  assert.equal((await listPrompts()).length,0); assert.equal((await cloudDetails()).cursor,'0');
});
test('independently valid folder edits that form a merged cycle become a resolvable structural conflict', async () => {
  const token=await reset(), a=await saveFolder({name:'A'}), b=await saveFolder({name:'B'});await uploaded(token);
  const folders=await listFolders();const currentA=folders.find(x=>x.id===a.id),currentB=folders.find(x=>x.id===b.id);
  await saveFolder({...currentA,parentId:b.id});
  const incoming=event(2,[remote('folder',{...currentB,parentId:a.id},2)]);
  assert.equal(await applyCloudEvent(token,incoming),false);
  let detail=await cloudDetails();assert.equal(detail.cursor,'1');assert.equal(detail.conflict.structural,true);
  await applyCloudEvent(token,incoming,{choice:'local',revision:detail.revision});
  const pending=await prepareUpload(token);assert.equal(pending.request.changes.length,2);
  assert.equal(pending.request.changes.find(x=>x.id===b.id).baseVersion,'2');
});
test('initial old tombstones are not interpreted as an instruction to delete cloud content', async () => {
  const token=await reset(),row=await savePrompt(prompt('Old'));
  await softDeletePrompt(row.id,{expectedVersion:row.version});
  assert.equal(await prepareUpload(token),null);
  await applyCloudEvent(token,event(1,[remote('prompt',row,1)]));
  assert.equal((await listPrompts()).length,1);assert.equal((await cloudDetails()).pendingCount,0);
});
test('local folder deletion and a newly downloaded child converge without an orphan', async () => {
  const token=await reset(),folder=await saveFolder({name:'Old folder'});await uploaded(token);
  const f=(await listFolders())[0];await softDeleteFolder(f.id,{expectedVersion:f.version});
  const child={id:'remote-child',...prompt('Remote child'),description:'',folderId:f.id,favorite:false,sortOrder:0,createdAt:100,deletedAt:null};
  await applyCloudEvent(token,event(2,[remote('prompt',child,2)]));
  assert.equal((await getPrompt(child.id)).folderId,null);
  assert.equal((await prepareUpload(token)).request.changes[0].data.folderId,null);
});
test('clear refuses unknown upload results, then clears only replica and rejects stale response', async () => {
  const token=await reset(), row=await savePrompt(prompt('One')), pending=await prepareUpload(token);
  await assert.rejects(clearAllData(),/尚未确认/);
  await applyCloudEvent(token,event(1,[remote('prompt',row,1)],pending.request.opId));
  await clearAllData();
  await assert.rejects(applyCloudEvent(token,event(2,[remote('prompt',row,2)])),/变化/);
  assert.equal((await cloudDetails()).cursor,'0');
});
test('project changes do not reuse another project baselines and exports contain no sync metadata', async () => {
  const token=await reset(); await savePrompt(prompt('One')); await uploaded(token);
  await assert.rejects(bindCloudProject('https://other.supabase.co'),/其他云库/);
  const json=JSON.stringify(await exportSnapshot()); assert.ok(!json.includes('cloudState')); assert.ok(!json.includes('serverVersion')); assert.ok(!json.includes(url));
});
test('remote pagination cannot skip cursors or split versions', () => {
  assert.throws(()=>validatePull({protocolVersion:1,events:[],nextCursor:'2',highWater:'2',hasMore:false},'0'));
  assert.throws(()=>validatePull({protocolVersion:1,events:[],nextCursor:'0',highWater:'2',hasMore:true},'0'));
});
test('RPC sends key only to fixed endpoint, refuses redirects and does not echo upstream secrets', async () => {
  const config={url,key:'sb_publishable_TEST'};
  let options;
  await rpc(config,'pv_sync_status',{},null,async(target,opt)=>{options=opt;assert.equal(target,`${url}/rest/v1/rpc/pv_sync_status`);return new Response('{}');});
  assert.equal(options.headers.apikey,config.key); assert.equal(options.redirect,'error'); assert.equal(options.credentials,'omit');
  assert.ok(!options.headers.Authorization);
  await assert.rejects(rpc(config,'pv_sync_status',{},null,async()=>new Response(config.key,{status:403})),e=>!e.message.includes(config.key));
});
