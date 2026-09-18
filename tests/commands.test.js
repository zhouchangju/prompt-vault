import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCommand, getCommandBindings, dispatchCommand } from '../core/commands.js';

test('panel command uses source window without querying another window', async () => {
  const calls=[];const api={storage:{session:{get:(key,callback)=>callback({}),set:async()=>{}}},sidePanel:{open: options=>{calls.push(options);return Promise.resolve();}},windows:{getLastFocused:()=>{throw new Error('Unexpected await');}}};
  const result=executeCommand('open-panel',{windowId:42},api);
  await result;assert.deepEqual(calls,[{windowId:42}]);
});
test('removed manager command is ignored and panel supports missing tab context',async()=>{
  const calls=[];const api={storage:{session:{get:(key,callback)=>callback({}),set:async()=>{}}},runtime:{openOptionsPage:async()=>calls.push('manager')},windows:{getLastFocused:callback=>callback({id:9})},sidePanel:{open:async o=>calls.push(o.windowId)}};
  await executeCommand('open-manager',undefined,api);await executeCommand('open-panel',undefined,api);await executeCommand('unknown',undefined,api);
  assert.deepEqual(calls,[9]);
});
test('actual shortcut assignments are used and missing commands are not advertised as bound',async()=>{
  const api={commands:{getAll:async()=>[{name:'open-manager',shortcut:'⇧⌘P'},{name:'open-panel',shortcut:''}]}};
  const rows=await getCommandBindings(api);assert.equal(rows.length,1);assert.equal(rows[0].shortcut,'');
  api.commands.getAll=async()=>[];assert((await getCommandBindings(api)).every(row=>row.shortcut===''));
});

test('shortcut dispatch records native toggle completion', async () => {
  const calls=[];
  const api={sidePanel:{open:options=>{calls.push(['open',options.windowId]);return Promise.resolve();}},storage:{session:{get:(key,callback)=>callback({}),set:async value=>calls.push(['record',value])}}};
  const work=dispatchCommand('open-panel',{windowId:3},api);
  await work;assert.deepEqual(calls[0],['open',3]);
  assert.equal(calls.at(-1)[1]['lastCommand:open-panel'].status,'success');
  api.sidePanel.close=()=>Promise.reject(new Error('native failure'));
  await assert.rejects(dispatchCommand('open-panel',{windowId:3},api),/native failure/);
  assert.equal(calls.at(-1)[1]['lastCommand:open-panel'].status,'failed');
});
