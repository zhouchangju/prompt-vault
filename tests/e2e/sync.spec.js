import { test, expect, seed, snapshot, openSettings } from './fixtures.js';

const url='https://synthetic.supabase.co', key='sb_publishable_TEST_ONLY';
async function mockCloud(extension) {
  extension.allowNetwork(url);
  // Runtime host-consent UI is mocked; exact requested origin is asserted below.
  // Native IDB, Web Locks, Chrome local storage and extension pages remain real.
  await extension.context.addInitScript(() => {
    if (!globalThis.chrome?.permissions) return;
    chrome.permissions.request=async value=>{window.requestedOrigin=value.origins;window.permissionGesture=navigator.userActivation.isActive;return true;};
    chrome.permissions.contains=async()=>true;
    chrome.permissions.remove=async()=>true;
  });
  const cloud={events:[],requests:[],rows:new Map(),hold:null};
  cloud.change=(changes,opId=crypto.randomUUID())=>{
    const cursor=String(cloud.events.length+1);
    const rows=changes.map(c=>({entityType:c.entityType,id:c.id,data:c.data,deletedAt:c.deleted?Date.now():null,serverVersion:cursor,serverUpdatedAt:new Date().toISOString()}));
    rows.forEach(r=>cloud.rows.set(`${r.entityType}:${r.id}`,r));
    cloud.events.push({cursor,opId,deviceId:'test',changes:rows});return cursor;
  };
  await extension.context.route(`${url}/**`,async route=>{
    if(route.request().method()==='OPTIONS') return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'apikey,content-type','Access-Control-Allow-Methods':'POST'}});
    const method=new URL(route.request().url()).pathname.split('/').at(-1), body=route.request().postDataJSON();
    cloud.requests.push({method,body,headers:await route.request().allHeaders()});
    if(cloud.hold) await cloud.hold;
    let reply;
    if(method==='pv_sync_status') reply={protocolVersion:1,schemaVersion:3,deploymentMode:'personal-project-key',cursor:String(cloud.events.length)};
    else if(method==='pv_sync_pull') {
      const high=body.p_until??String(cloud.events.length);
      const events=cloud.events.filter(e=>BigInt(e.cursor)>BigInt(body.p_cursor)&&BigInt(e.cursor)<=BigInt(high)).slice(0,body.p_limit);
      const next=events.at(-1)?.cursor??body.p_cursor;reply={protocolVersion:1,events,nextCursor:next,highWater:high,hasMore:BigInt(next)<BigInt(high)};
    } else if(method==='pv_sync_push') {
      const request=body.p_request;
      const previous=cloud.events.find(e=>e.opId===request.opId);
      const cursor=previous?.cursor??cloud.change(request.changes,request.opId);
      reply={status:'applied',opId:request.opId,cursor};
    } else throw new Error('Unexpected endpoint');
    await route.fulfill({json:reply,headers:{'Access-Control-Allow-Origin':'*'}}).catch(()=>{});
  });
  return cloud;
}
async function saveConfig(page) {
  await openSettings(page,'sync');
  await page.locator('#supabaseUrl').fill(url);await page.locator('#supabaseKey').fill(key);
  await page.getByRole('button',{name:'保存连接',exact:true}).click();
  await expect(page.locator('#syncStatus')).toContainText('连接已保存在本机');
  await page.locator('[data-close="settings"]').click();
}

test('configuration stays local, only explicit manual sync uploads, idle/focus/edit never poll',async({extension})=>{
  const cloud=await mockCloud(extension), page=await extension.open(); await seed(page,snapshot(2));
  await saveConfig(page); expect(cloud.requests).toHaveLength(0);
  expect(await page.evaluate(()=>window.requestedOrigin)).toEqual([`${url}/*`]);
  expect(await page.evaluate(()=>window.permissionGesture)).toBe(true);
  expect(await page.evaluate(async()=> (await chrome.storage.local.get('cloudConnection')).cloudConnection.key)).toBe(key);
  await page.locator('#syncNow').click();await expect(page.locator('#cloudStatus')).toContainText('本轮同步完成');
  expect(cloud.rows.size).toBe(3);
  expect(cloud.requests.every(r=>r.headers.apikey===key&&!r.headers.authorization)).toBe(true);
  const count=cloud.requests.length;
  await page.evaluate(async()=>{const db=await import('./db.js');const p=(await db.listPrompts())[0];await db.savePrompt({...p,title:'Local only'});window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});
  await page.clock.install();await page.clock.fastForward(16*60*1000);
  expect(cloud.requests).toHaveLength(count);
  const exported=await page.evaluate(async()=>JSON.stringify(await (await import('./db.js')).exportSnapshot()));expect(exported).not.toContain(key);expect(exported).not.toContain(url);
  const stored=await page.evaluate(async()=>{const db=await (await import('./db.js')).openDatabase();return new Promise(r=>{const q=db.transaction('meta').objectStore('meta').getAll();q.onsuccess=()=>r(JSON.stringify(q.result));});});expect(stored).not.toContain(key);
});
test('open-first local render remains usable during a slow cloud request; reopening pulls only',async({extension})=>{
  const cloud=await mockCloud(extension), page=await extension.open();await seed(page,snapshot(1));await saveConfig(page);
  let release;cloud.hold=new Promise(resolve=>release=resolve);
  await page.reload();await expect(page.locator('#allCount')).toHaveText('1');
  await page.locator('#searchInput').fill('searchable-body');await expect(page.locator('.prompt-card')).toHaveCount(1);
  await page.locator('#newPromptButton').click();await expect(page.locator('#promptTitle')).toBeVisible();
  await page.locator('[data-close="prompt"]').first().click();
  await expect.poll(()=>cloud.requests.length).toBeGreaterThan(0);
  release();cloud.hold=null;
  await expect(page.locator('#cloudStatus')).toContainText('本次增量拉取已结束');
  expect(cloud.requests.some(r=>r.method==='pv_sync_push')).toBe(false);
  const panel=await extension.open('sidepanel.html');await expect(panel.locator('#panelSyncStatus')).toContainText('拉取已结束');
  await expect(panel.locator('#syncNow')).toHaveCount(0);
});
test('remote conflict never overwrites a local edit and choice creates an exportable backup',async({extension})=>{
  const cloud=await mockCloud(extension), page=await extension.open();await seed(page,snapshot(1));await saveConfig(page);
  await page.locator('#syncNow').click();await expect(page.locator('#cloudStatus')).toContainText('本轮同步完成');
  await page.evaluate(async()=>{const db=await import('./db.js');const p=await db.getPrompt('prompt-0');await db.savePrompt({...p,title:'本地草稿'});});
  const remote=cloud.rows.get('prompt:prompt-0');cloud.change([{...remote,data:{...remote.data,title:'远端草稿'}}]);
  await page.reload();await expect(page.locator('#cloudStatus')).toContainText('冲突');
  expect(await page.evaluate(async()=> (await (await import('./db.js')).getPrompt('prompt-0')).title)).toBe('本地草稿');
  await openSettings(page,'sync');await page.locator('#resolveSyncCloud').click();await expect(page.locator('#syncStatus')).toContainText('冲突已处理');
  expect(await page.evaluate(async()=> (await (await import('./db.js')).getPrompt('prompt-0')).title)).toBe('远端草稿');
  await expect(page.locator('#syncBackupSelect option')).toHaveCount(1);
  const downloadPromise=page.waitForEvent('download');await page.locator('#exportSyncBackup').click();const download=await downloadPromise;
  expect(download.suggestedFilename()).toContain('conflict-backup');
  await page.screenshot({path:'test-results/sync-settings.png',fullPage:true});
});
test('a real Web Lock prevents simultaneous sync runs across callers',async({extension})=>{
  const cloud=await mockCloud(extension),page=await extension.open();await saveConfig(page);
  const result=await page.evaluate(async()=>{const {runSync}=await import('./core/sync.js');return (await Promise.allSettled([runSync({upload:true}),runSync({upload:true})])).map(x=>x.status);});
  expect(result.filter(x=>x==='rejected')).toHaveLength(1);expect(result.filter(x=>x==='fulfilled')).toHaveLength(1);
  expect(cloud.requests.filter(x=>x.method==='pv_sync_status')).toHaveLength(1);
});
test('permission refusal keeps configuration unsaved and failed requests never auto-retry',async({extension})=>{
  const cloud=await mockCloud(extension),page=await extension.open();
  await openSettings(page,'sync');await page.locator('#supabaseUrl').fill(url);await page.locator('#supabaseKey').fill(key);
  await page.evaluate(()=>{chrome.permissions.request=async()=>false;});
  await page.getByRole('button',{name:'保存连接',exact:true}).click();await expect(page.locator('#syncStatus')).toContainText('未授予');
  expect(await page.evaluate(async()=> (await chrome.storage.local.get('cloudConnection')).cloudConnection)).toBeUndefined();
  expect(cloud.requests).toHaveLength(0);
  await page.evaluate(()=>{chrome.permissions.request=async()=>true;});
  await page.getByRole('button',{name:'保存连接',exact:true}).click();await expect(page.locator('#syncStatus')).toContainText('连接已保存在本机');
  let failures=0;
  await extension.context.route(`${url}/rest/v1/rpc/pv_sync_status`,async route=>{failures++;await route.abort('failed');});
  await page.locator('#testSyncConnection').click();await expect(page.locator('#syncStatus')).toContainText('无法连接');
  await page.clock.install();await page.clock.fastForward(16*60*1000);expect(failures).toBe(1);
});
