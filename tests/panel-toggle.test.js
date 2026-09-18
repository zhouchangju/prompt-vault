import test from 'node:test';
import assert from 'node:assert/strict';
import { installPanelStateTracking, togglePanel } from '../core/panel-toggle.js';

function fixture(data = {}) {
  const event=()=>{const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:info=>listeners.forEach(fn=>fn(info))};};
  const calls=[];
  const api={storage:{session:{get:(key,callback)=>queueMicrotask(()=>callback({[key]:data[key]})),set:async values=>Object.assign(data,values)}},sidePanel:{onOpened:event(),onClosed:event()}};
  api.sidePanel.open=async({windowId})=>{calls.push(`open:${windowId}`);api.sidePanel.onOpened.emit({windowId});};
  api.sidePanel.close=async({windowId})=>{calls.push(`close:${windowId}`);api.sidePanel.onClosed.emit({windowId});};
  installPanelStateTracking(api);return {api,calls,data};
}
test('consecutive shortcut actions open, close and reopen the current window',async()=>{
  const {api,calls}=fixture();await togglePanel(1,api);await togglePanel(1,api);await togglePanel(1,api);
  assert.deepEqual(calls,['open:1','close:1','open:1']);
});
test('native toolbar open and close button events update shortcut behavior',async()=>{
  const {api,calls}=fixture();api.sidePanel.onOpened.emit({windowId:7});await togglePanel(7,api);
  api.sidePanel.onClosed.emit({windowId:7});await togglePanel(7,api);
  assert.deepEqual(calls,['close:7','open:7']);
});
test('window states are independent and persisted state restores after worker restart',async()=>{
  const {api,calls,data}=fixture();await togglePanel(1,api);await togglePanel(2,api);await togglePanel(1,api);
  assert.deepEqual(calls,['open:1','open:2','close:1']);
  await new Promise(resolve=>setImmediate(resolve));
  const restarted=fixture(data);await togglePanel(2,restarted.api);assert.deepEqual(restarted.calls,['close:2']);
});
test('failed open remains retryable and does not invent visible state',async()=>{
  const {api,calls}=fixture();const open=api.sidePanel.open;
  api.sidePanel.open=async()=>{throw new Error('open failed');};await assert.rejects(togglePanel(3,api),/open failed/);
  api.sidePanel.open=open;await togglePanel(3,api);assert.deepEqual(calls,['open:3']);
});
test('overlapping presses coalesce during one native transition',async()=>{
  const {api,calls}=fixture();let finish;
  api.sidePanel.open=({windowId})=>{calls.push(`open:${windowId}`);return new Promise(resolve=>{finish=()=>{api.sidePanel.onOpened.emit({windowId});resolve();};});};
  const first=togglePanel(8,api);const second=togglePanel(8,api);assert.equal(first,second);
  await new Promise(resolve=>setImmediate(resolve));finish();await first;
  await togglePanel(8,api);assert.deepEqual(calls,['open:8','close:8']);
});

test('API completion before native events still makes the next action close',async()=>{
  const {api,calls}=fixture();
  api.sidePanel.open=async({windowId})=>{calls.push(`open:${windowId}`);};
  api.sidePanel.close=async({windowId})=>{calls.push(`close:${windowId}`);};
  await togglePanel(1,api);await togglePanel(1,api);
  assert.deepEqual(calls,['open:1','close:1']);
});
test('newer manual native event wins over late command completion',async()=>{
  const {api,calls}=fixture();let finish;
  api.sidePanel.open=({windowId})=>{calls.push(`open:${windowId}`);return new Promise(resolve=>{finish=resolve;});};
  const opening=togglePanel(4,api);await new Promise(resolve=>setImmediate(resolve));
  api.sidePanel.onOpened.emit({windowId:4});api.sidePanel.onClosed.emit({windowId:4});finish();await opening;
  api.sidePanel.open=async({windowId})=>{calls.push(`open:${windowId}`);api.sidePanel.onOpened.emit({windowId});};
  await togglePanel(4,api);assert.deepEqual(calls,['open:4','open:4']);
});

test('cold storage read opens inside the native callback gesture, not a Promise continuation', async () => {
  let gesture=false;
  const api={storage:{session:{
    get:(key,callback)=>{
      if(!callback)return Promise.resolve({});
      queueMicrotask(()=>{gesture=true;try{callback({});}finally{gesture=false;}});
    },set:async()=>{}
  }},sidePanel:{open:()=>{assert.equal(gesture,true,'native open lost command gesture');return Promise.resolve();}}};
  await togglePanel(10,api);
});
test('cold storage callback error rejects without attempting to open', async () => {
  let called=false;
  const api={runtime:{},storage:{session:{get:(key,callback)=>{
    api.runtime.lastError={message:'storage unavailable'};try{callback({});}finally{delete api.runtime.lastError;}
  }}},sidePanel:{open:()=>{called=true;}}};
  await assert.rejects(togglePanel(11,api),/storage unavailable/);assert.equal(called,false);
});
