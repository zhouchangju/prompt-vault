import { test, expect } from './fixtures.js';

test('dynamic shortcut dialog closes on backdrop without a null-node error', async ({ extension }) => {
  const page = await extension.open();
  await page.locator('#shortcutsHelp').click();
  const dialog = page.getByRole('dialog', { name: '快捷键' });
  await expect(dialog).toBeVisible();
  await page.locator('.modal-backdrop:not(.hidden)').click({ position: { x: 3, y: 3 } });
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(dialog).toBeHidden();
  await expect(page.locator('#shortcutsHelp')).toBeFocused();
});

test('side panel plus uses geometrically centered SVG at narrow widths', async ({ extension }) => {
  const panel=await extension.open('sidepanel.html');
  for(const width of [320,360,420]) {
    await panel.setViewportSize({width,height:850});
    const button=await panel.locator('#panelNewPrompt').boundingBox();
    const icon=await panel.locator('#panelNewPrompt svg').boundingBox();
    expect(Math.abs(button.x+button.width/2-icon.x-icon.width/2)).toBeLessThan(0.5);
    expect(Math.abs(button.y+button.height/2-icon.y-icon.height/2)).toBeLessThan(0.5);
  }
});

test('Mac new installation registers only panel shortcut Option Shift P', async ({ extension }) => {
  const commands=await extension.worker.evaluate(()=>chrome.commands.getAll());
  // Chrome also reports its implicit, unbound toolbar action.
  expect(commands.filter(command=>!command.name.startsWith('_')).map(command=>command.name)).toEqual(['open-panel']);
  if(process.platform==='darwin') {
    const shortcut=commands.find(command=>command.name==='open-panel').shortcut;
    expect(shortcut).toContain('⌥');expect(shortcut).toContain('⇧');expect(shortcut).toContain('P');
  }
  const manager=await extension.open();await manager.locator('#shortcutsHelp').click();
  await expect(manager.locator('[data-command="open-panel"]')).toContainText(commands.find(command=>command.name==='open-panel').shortcut||'未分配');
  await expect(manager.locator('[data-command="open-manager"]')).toHaveCount(0);
});
