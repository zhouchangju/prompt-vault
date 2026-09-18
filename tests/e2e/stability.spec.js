import { test, expect, seed, snapshot, setViewMode } from './fixtures.js';

test('panel frequency order freezes during use and refreshes only next session', async ({ extension }) => {
  const manager=await extension.open();const data=snapshot(3);
  data.prompts[0].useCount=0;data.prompts[1].useCount=2;data.prompts[2].useCount=1;
  await seed(manager,data);const panel=await extension.open('sidepanel.html');
  const order=()=>panel.locator('#panelList article').evaluateAll(cards=>cards.map(card=>card.dataset.promptId));
  await expect.poll(order).toEqual(['prompt-0','prompt-1','prompt-2']);
  for(const count of [2,3]) {
    await panel.locator('[data-prompt-id="prompt-2"] .item-title').click();
    await expect.poll(()=>manager.evaluate(async()=> (await (await import('./db.js')).getPrompt('prompt-2')).useCount)).toBe(count);
    expect(await order()).toEqual(['prompt-0','prompt-1','prompt-2']);
  }
  await panel.evaluate(()=>window.dispatchEvent(new Event('focus')));
  expect(await order()).toEqual(['prompt-0','prompt-1','prompt-2']);
  await panel.reload();await expect.poll(order).toEqual(['prompt-0','prompt-2','prompt-1']);
});

test('folder mouse drag and keyboard ordering persist across pages and reload', async ({ extension }) => {
  const manager=await extension.open();const data=snapshot(1);
  data.folders=[{id:'work',name:'工作',sortOrder:0},{id:'study',name:'学习',sortOrder:1},{id:'writing',name:'写作',sortOrder:2}];
  await seed(manager,data);const panel=await extension.open('sidepanel.html');
  const managerOrder=()=>manager.locator('#folderList > .folder-item').evaluateAll(rows=>rows.map(row=>row.dataset.folderId));
  const panelOrder=()=>panel.locator('#panelFolderNav .folder-drag-handle').evaluateAll(handles=>handles.map(handle=>handle.dataset.dragFolder));
  await manager.locator('[data-drag-folder="writing"]').dragTo(manager.locator('#folderList > [data-folder-id="work"]'),{targetPosition:{x:40,y:3}});
  await expect.poll(managerOrder).toEqual(['writing','work','study']);
  await expect.poll(panelOrder).toEqual(['writing','work','study']);
  const handle=panel.locator('[data-drag-folder="study"]');await handle.focus();await panel.keyboard.press('Alt+ArrowUp');
  await expect.poll(panelOrder).toEqual(['writing','study','work']);await expect(handle).toBeFocused();
  await panel.keyboard.press('Alt+ArrowUp');await expect.poll(panelOrder).toEqual(['study','writing','work']);await expect(handle).toBeFocused();
  await manager.reload();await expect.poll(managerOrder).toEqual(['study','writing','work']);
});

test('large multiline variables, compact header and one-click view toggle', async ({ extension },testInfo) => {
  const manager=await extension.open();const data=snapshot(1);data.prompts[0].content='{{text}} / {{count::number-2}} / {{tone::list-a;b}}';await seed(manager,data);
  await expect(manager.locator('#viewModeSelect')).toHaveCount(0);
  await setViewMode(manager,'compact');await manager.reload();await expect(manager.locator('#viewModeToggle')).toHaveAttribute('aria-pressed','true');
  const panel=await extension.open('sidepanel.html');await panel.setViewportSize({width:360,height:850});
  await expect(panel.locator('.panel-header #panelNewPrompt')).toBeVisible();await expect(panel.locator('.panel-actions')).toHaveCount(0);
  await panel.locator('.item-title').click();
  const input=panel.locator('[data-variable-name="text"]');await expect(input).toHaveJSProperty('tagName','TEXTAREA');
  expect((await input.boundingBox()).height).toBeGreaterThanOrEqual(160);
  await expect(panel.locator('[data-variable-name="count"]')).toHaveAttribute('type','number');
  await expect(panel.locator('[data-variable-name="tone"]')).toHaveJSProperty('tagName','SELECT');
  await input.fill('第一行\n第二行\n第三行');await panel.keyboard.press('Meta+Enter');
  await expect.poll(()=>panel.evaluate(()=>navigator.clipboard.readText())).toBe('第一行\n第二行\n第三行 / 2 / a');
  await panel.screenshot({path:testInfo.outputPath('stable-panel.png')});
});

test('shortcut help displays actual Mac command binding and missing assignment', async ({ extension }) => {
  const manager=await extension.open();await manager.locator('#shortcutsHelp').click();
  const bindings=await extension.worker.evaluate(()=>chrome.commands.getAll());
  const panelBinding=bindings.find(command=>command.name==='open-panel');expect(panelBinding).toBeTruthy();
  await expect(manager.locator('[data-command="open-panel"]')).toContainText(panelBinding.shortcut||'未分配');
  await manager.keyboard.press('Escape');
  await manager.evaluate(()=>{chrome.commands.getAll=async()=>[{name:'open-panel',shortcut:''},{name:'open-manager',shortcut:'⇧⌘P'}];});
  await manager.locator('#shortcutsHelp').click();await expect(manager.locator('[data-command="open-panel"]')).toContainText('未分配');
});

test('explicit panel command handler opens native panel in source window', async ({ extension }) => {
  const page=await extension.open();
  await extension.worker.evaluate(()=>{globalThis.commandPanelEvents=[];chrome.sidePanel.onOpened.addListener(e=>commandPanelEvents.push(e.windowId));});
  const windowId=await page.evaluate(async()=>{
    const {executeCommand}=await import('./core/commands.js');const {id}=await chrome.windows.getCurrent();
    const button=document.createElement('button');button.id='command-test';button.style.cssText='position:fixed;right:0;bottom:0;z-index:9999';button.textContent='Command';
    button.onclick=()=>executeCommand('open-panel',{windowId:id});document.body.append(button);return id;
  });
  await page.locator('#command-test').click();await expect.poll(()=>extension.worker.evaluate(()=>commandPanelEvents)).toContain(windowId);
  expect((await extension.worker.evaluate(()=>chrome.commands.getAll())).map(c=>c.name)).toEqual(expect.arrayContaining(['open-panel']));
});
