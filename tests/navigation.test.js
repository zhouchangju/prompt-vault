import test from 'node:test';
import assert from 'node:assert/strict';
import { openManagerFromPanel } from '../ui/navigation.js';

test('manager navigation captures source window and closes panel only after successful open', async () => {
  const calls = [];
  globalThis.chrome = { windows: {getCurrent: async () => ({id:42})}, runtime: {openOptionsPage:async()=>calls.push('manager')},
    sidePanel: {close:async options=>calls.push(['close', options.windowId])} };
  globalThis.window = {close:()=>calls.push('fallback')};
  try {
    await openManagerFromPanel(); assert.deepEqual(calls,['manager',['close',42]]);
    calls.length=0;
    chrome.runtime.openOptionsPage=async()=>{throw new Error('open failed');};
    await assert.rejects(openManagerFromPanel(),/open failed/); assert.deepEqual(calls,[]);
  } finally {delete globalThis.chrome; delete globalThis.window;}
});
test('new prompt opens correct URL and legacy close fallback does not disable future panels',async()=>{
  const calls=[];
  globalThis.chrome={windows:{getCurrent:async()=>({id:9})},runtime:{getURL:p=>`chrome-extension://test/${p}`},tabs:{create:async options=>calls.push(options.url)}};
  globalThis.window={close:()=>calls.push('close-document')};
  try {await openManagerFromPanel({newPrompt:true});assert.deepEqual(calls,['chrome-extension://test/manager.html?new=1','close-document']);}
  finally {delete globalThis.chrome;delete globalThis.window;}
});
