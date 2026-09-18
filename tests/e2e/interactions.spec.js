import { test, expect, seed, snapshot, setViewMode } from './fixtures.js';

test('manager whole cards use prompts while controls and selected text remain independent', async ({ extension }) => {
  const page = await extension.open();
  const data = snapshot(2); data.prompts[1].content = '你好 {{name}}'; await seed(page, data);
  for (const mode of ['cards', 'compact']) {
    await setViewMode(page, mode);
    await page.locator('[data-prompt-id="prompt-0"] .card-title').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(data.prompts[0].content);
    await page.evaluate(() => navigator.clipboard.writeText('control sentinel'));
    await page.locator('[data-prompt-id="prompt-0"] [data-action="favorite"]').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('control sentinel');
    await page.locator('[data-prompt-id="prompt-0"] [data-action="edit"]').click();
    await expect(page.locator('#promptModalBackdrop')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('control sentinel');
    await page.keyboard.press('Escape');
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('[data-prompt-id="prompt-0"] [data-action="delete"]').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('control sentinel');
    await page.locator('[data-prompt-id="prompt-0"] .card-title').evaluate(title => {
      const range = document.createRange(); range.selectNodeContents(title); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      title.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('control sentinel');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.locator('[data-prompt-id="prompt-1"] .card-title').click();
    await expect(page.locator('#variableModalBackdrop')).toBeVisible();
    await page.locator('[data-variable-name="name"]').fill('小明');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#variableModalBackdrop')).toBeHidden();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('你好 小明');
  }
});

test('panel one-click folders and favorite toggle never activate copy', async ({ extension }, testInfo) => {
  const manager = await extension.open(); const data = snapshot(3); data.prompts[2].folderId = null; await seed(manager, data);
  const panel = await extension.open('sidepanel.html'); await panel.setViewportSize({ width: 360, height: 850 });
  await panel.locator('button[data-nav-key="folder:work"]').click();
  await expect(panel.locator('#panelList article')).toHaveCount(2);
  await panel.locator('button[data-nav-key="unfiled"]').click();
  await expect(panel.locator('#panelList article')).toHaveCount(1);
  await expect(panel.locator('#panelList article')).toHaveAttribute('data-prompt-id', 'prompt-2');
  await panel.evaluate(() => navigator.clipboard.writeText('star sentinel'));
  await panel.locator('.item-fav').click();
  await expect(panel.locator('.item-fav')).toHaveAttribute('aria-pressed','true');
  expect(await panel.evaluate(() => navigator.clipboard.readText())).toBe('star sentinel');
  await expect.poll(() => manager.evaluate(async () => (await (await import('./db.js')).getPrompt('prompt-2')).favorite)).toBe(true);
  await panel.locator('button[data-nav-key="favorite"]').click();
  await expect(panel.locator('#panelList article')).toHaveCount(2);
  await panel.locator('[data-prompt-id="prompt-2"] .item-fav').click();
  await expect(panel.locator('#panelList article')).toHaveCount(1);
  await panel.locator('button[data-nav-key="all"]').click();
  await panel.locator('[data-prompt-id="prompt-1"] .item-title').click();
  await expect.poll(() => panel.evaluate(() => navigator.clipboard.readText())).toBe(data.prompts[1].content);
  for (const width of [320,360,420]) {
    await panel.setViewportSize({width,height:850});
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(panel.locator('button[data-nav-key="folder:work"]')).toBeVisible();
  }
  await panel.setViewportSize({width:360,height:850});
  await panel.screenshot({path:testInfo.outputPath('sidepanel-navigation.png')});
});

test('search and card keyboard navigation, IME protection, help and new shortcut', async ({ extension }) => {
  const page = await extension.open(); await seed(page, snapshot(3));
  await page.locator('#searchInput').fill('示例提示 002'); await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-prompt-id="prompt-1"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('合成测试正文 1');
  await page.keyboard.press('Control+k'); await expect(page.locator('#searchInput')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('#searchInput')).toHaveValue('');
  await page.locator('#newPromptButton').click(); await page.locator('#promptTitle').fill('保留草稿');
  await page.locator('#promptTitle').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true})));
  await expect(page.locator('#promptModalBackdrop')).toBeVisible(); await expect(page.locator('#promptTitle')).toHaveValue('保留草稿');
  await page.keyboard.press('Escape');
  await page.locator('#shortcutsHelp').click(); await expect(page.getByRole('dialog',{name:'快捷键'})).toBeVisible(); await page.keyboard.press('Escape');
  await page.locator('[data-prompt-id="prompt-0"]').focus();
  await page.locator('[data-prompt-id="prompt-0"]').evaluate(card=>card.dispatchEvent(new KeyboardEvent('keydown',{key:'Dead',code:'KeyN',altKey:true,bubbles:true,cancelable:true})));
  await expect(page.locator('#promptModalBackdrop')).toBeVisible();
});

test('panel card keyboard activation and variable submission', async ({ extension }) => {
  const manager=await extension.open(); const data=snapshot(1); data.prompts[0].content='{{value}}'; await seed(manager,data);
  const panel=await extension.open('sidepanel.html');
  await panel.locator('#panelSearch').focus();await panel.keyboard.press('ArrowDown');await expect(panel.locator('#panelList article')).toBeFocused();
  await panel.keyboard.press('Space');await expect(panel.locator('#panelVariableBackdrop')).toBeVisible();
  await panel.locator('[data-variable-name="value"]').fill('快捷复制');await panel.keyboard.press('Control+Enter');
  await expect(panel.locator('#panelVariableBackdrop')).toBeHidden();
  await expect.poll(()=>panel.evaluate(()=>navigator.clipboard.readText())).toBe('快捷复制');
  await panel.locator('#panelShortcutsHelp').click();await expect(panel.getByRole('dialog',{name:'快捷键'})).toBeVisible();
});

test('copy success stays explicit when local usage bookkeeping fails', async ({ extension }) => {
  const page=await extension.open();const data=snapshot(1);data.prompts[0].content='{{value}}';await seed(page,data);
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,...rest){if(this.name==='prompts')throw new Error('usage failure');return put.call(this,value,...rest);};});
  await page.locator('.card-title').click();await page.locator('[data-variable-name="value"]').fill('已经复制');await page.keyboard.press('Control+Enter');
  await expect(page.locator('#variableModalBackdrop')).toBeHidden();await expect(page.locator('.toast').last()).toContainText('已复制，但使用记录');
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('已经复制');
});

// Native side-panel pages are not exposed by Playwright's page list. CDP is used
// only to exercise our own arrow button in the isolated browser's actual panel.
test('actual native panel closes when its arrow opens the manager', async ({ extension }) => {
  const page=await extension.open();
  await extension.worker.evaluate(()=>{globalThis.panelEvents=[];chrome.sidePanel.onOpened.addListener(()=>panelEvents.push('opened'));chrome.sidePanel.onClosed.addListener(()=>panelEvents.push('closed'));});
  await page.evaluate(async()=>{const {id}=await chrome.windows.getCurrent();const b=document.createElement('button');b.id='open-native-test';b.textContent='open native panel';b.style.cssText='position:fixed;right:0;bottom:0;z-index:9999';b.onclick=()=>chrome.sidePanel.open({windowId:id});document.body.append(b);});
  await page.locator('#open-native-test').click();
  await expect.poll(()=>extension.worker.evaluate(()=>panelEvents)).toContain('opened');
  const cdp=await extension.context.browser().newBrowserCDPSession();
  let target;
  await expect.poll(async()=>{target=(await cdp.send('Target.getTargets')).targetInfos.find(t=>t.url===`${extension.origin}/sidepanel.html`);return Boolean(target);}).toBe(true);
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
  let sequence=0;
  const evaluate=expression=>new Promise((resolve,reject)=>{
    const id=++sequence;
    const listener=event=>{if(event.sessionId!==sessionId)return;const response=JSON.parse(event.message);if(response.id!==id)return;clearTimeout(timer);cdp.off('Target.receivedMessageFromTarget',listener);if(response.error)reject(new Error(response.error.message));else resolve(response.result?.result?.value);};
    const timer=setTimeout(()=>{cdp.off('Target.receivedMessageFromTarget',listener);reject(new Error('Native panel evaluation timed out'));},3000);
    cdp.on('Target.receivedMessageFromTarget',listener);
    cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}})}).catch(error=>{clearTimeout(timer);cdp.off('Target.receivedMessageFromTarget',listener);reject(error);});
  });
  await expect.poll(()=>evaluate('document.querySelectorAll("#panelFolderNav button").length')).toBeGreaterThan(0);
  await evaluate('document.getElementById("openManager").click(); true');
  await expect.poll(()=>extension.worker.evaluate(()=>panelEvents)).toContain('closed');
  await expect.poll(()=>extension.worker.evaluate(async()=>(await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']})).length)).toBe(0);
  await expect(page).toHaveURL(`${extension.origin}/manager.html`);
  const commands=await extension.worker.evaluate(()=>chrome.commands.getAll());
  expect(commands.map(c=>c.name)).toEqual(expect.arrayContaining(['open-panel']));
  await cdp.detach();
});
