// A headed, disposable browser for real macOS/browser shortcut dispatch.
// Press the displayed shortcut three times. No user Chrome profile is accessed.
import { chromium } from '@playwright/test';
import { runtimeFiles } from './runtime-files.mjs';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const source=path.resolve(process.env.PROMPT_VAULT_TEST_ROOT || '.');
const temp=await mkdtemp(path.join(tmpdir(),'prompt-vault-keyboard-'));
let context;
try {
  const root=path.join(temp,'extension');await mkdir(root);
  for(const file of await runtimeFiles(source)) {
    await mkdir(path.dirname(path.join(root,file)),{recursive:true});await copyFile(path.join(source,file),path.join(root,file));
  }
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
    channel:'chromium',headless:false,viewport:{width:1000,height:650},
    args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]
  });
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(()=>{
    globalThis.shortcutEvidence=[];
    chrome.commands.onCommand.addListener(command=>shortcutEvidence.push({type:'command',command}));
    chrome.sidePanel.onOpened.addListener(()=>shortcutEvidence.push({type:'opened'}));
    chrome.sidePanel.onClosed.addListener(()=>shortcutEvidence.push({type:'closed'}));
  });
  const bindings=await worker.evaluate(()=>chrome.commands.getAll());
  const page=context.pages()[0] || await context.newPage();await page.goto('about:blank');
  await page.setContent('<title>Prompt Vault fixed shortcut test</title><h1>Prompt Vault — isolated keyboard verification</h1><p>This is a temporary browser with no personal data.</p><p>Press the extension shortcut three times: open, close, open.</p><p id="binding"></p>');
  await page.locator('#binding').evaluate((node,value)=>{node.textContent=`Registered shortcut: ${value}`;},bindings.find(item=>item.name==='open-panel')?.shortcut || 'Not assigned');
  console.log(JSON.stringify({ready:true,bindings}));
  let result;let last='';
  for(let i=0;i<180;i++) {
    await new Promise(resolve=>setTimeout(resolve,1000));
    result=await worker.evaluate(async()=>({events:shortcutEvidence,status:(await chrome.storage.session.get('lastCommand:open-panel'))['lastCommand:open-panel']}));
    const text=JSON.stringify(result);if(text!==last){console.log(text);last=text;}
    if(result.status?.status==='failed' || result.events.filter(item=>item.type!=='command').length>=3)break;
  }
  const sequence=result.events.filter(item=>item.type!=='command').map(item=>item.type);
  await mkdir('.local',{recursive:true});
  await writeFile('.local/shortcut-keyboard-evidence.json',JSON.stringify({timestamp:new Date().toISOString(),browser:context.browser().version(),bindings,...result},null,2));
  assert.deepEqual(sequence.slice(0,3),['opened','closed','opened']);
  assert.deepEqual(result.events.slice(0,6),[
    {type:'command',command:'open-panel'},{type:'opened'},
    {type:'command',command:'open-panel'},{type:'closed'},
    {type:'command',command:'open-panel'},{type:'opened'}
  ],'Each native transition must follow a real shortcut command event');
  assert.equal(result.status?.status,'success');
  console.log('PASS: real command events opened, closed and reopened the native panel');
  await new Promise(resolve=>setTimeout(resolve,1500));
} finally {await context?.close();await rm(temp,{recursive:true,force:true});}
