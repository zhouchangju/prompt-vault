import { test, expect } from './fixtures.js';

test('native panel shortcut toggles open closed open and respects manual closing',async({extension})=>{
  const page=await extension.open();
  await extension.worker.evaluate(()=>{globalThis.toggleEvents=[];chrome.sidePanel.onOpened.addListener(()=>toggleEvents.push('opened'));chrome.sidePanel.onClosed.addListener(()=>toggleEvents.push('closed'));});
  await page.evaluate(async()=>{
    const {executeCommand}=await import('./core/commands.js');const {id}=await chrome.windows.getCurrent();
    const button=document.createElement('button');button.id='toggle-native';button.textContent='Toggle';button.style.cssText='position:fixed;right:0;bottom:0;z-index:9999';
    button.onclick=()=>executeCommand('open-panel',{windowId:id});document.body.append(button);
  });
  const events=()=>extension.worker.evaluate(()=>toggleEvents);
  const contexts=()=>extension.worker.evaluate(async()=>(await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']})).length);
  await page.locator('#toggle-native').click();await expect.poll(events).toEqual(['opened']);await expect.poll(contexts).toBe(1);
  await page.locator('#toggle-native').click();await expect.poll(events).toEqual(['opened','closed']);await expect.poll(contexts).toBe(0);
  await page.locator('#toggle-native').click();await expect.poll(events).toEqual(['opened','closed','opened']);
  await page.evaluate(async()=>{const {id}=await chrome.windows.getCurrent();await chrome.sidePanel.close({windowId:id});});
  await expect.poll(events).toEqual(['opened','closed','opened','closed']);
  await page.locator('#toggle-native').click();await expect.poll(events).toEqual(['opened','closed','opened','closed','opened']);
});
