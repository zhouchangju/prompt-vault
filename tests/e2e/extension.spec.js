import { test, expect, seed, snapshot, openSettings, setViewMode } from './fixtures.js';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

test('create once, persist, compact body search and real clipboard', async ({ extension }) => {
  const page = await extension.open();
  await page.locator('#newPromptButton').click();
  await page.locator('#promptTitle').fill('我的测试提示');
  await page.locator('#promptContent').fill('保留原文 searchable-body');
  await page.locator('#promptForm').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#promptModalBackdrop')).toBeHidden();
  await expect(page.locator('#allCount')).toHaveText('1');
  await setViewMode(page, 'compact');
  await expect(page.locator('#cardsGrid .card-content')).toHaveCount(0);
  await page.locator('#searchInput').fill('searchable-body');
  await expect(page.locator('#cardsGrid article')).toHaveCount(1);
  await page.locator('[data-action="copy"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('保留原文 searchable-body');
  await page.reload();
  await expect(page.locator('#viewModeToggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#allCount')).toHaveText('1');
  for (const [width, columns] of [[1440, 3], [1000, 2], [600, 1]]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator('#cardsGrid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(columns);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('all themes synchronize with side panel and remain accessible', async ({ extension }, testInfo) => {
  test.setTimeout(90_000);
  const page = await extension.open(); await seed(page, snapshot(9));
  const panel = await extension.open('sidepanel.html');
  await setViewMode(page, 'compact');
  const themes = await page.locator('#headerThemeSelect option').evaluateAll(options => options.map(o => o.value));
  for (const theme of themes) {
    await page.locator('#headerThemeSelect').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(panel.locator('html')).toHaveAttribute('data-theme', theme);
    for (const mode of ['compact', 'cards']) {
      await setViewMode(page, mode);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), `${theme}/${mode}`).toEqual([]);
    }
    const panelResults = await new AxeBuilder({ page: panel }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(panelResults.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), `${theme}/panel`).toEqual([]);
  }
  await page.locator('#headerThemeSelect').selectOption('winter');
  await setViewMode(page, 'compact');
  await page.screenshot({ path: testInfo.outputPath('compact-winter.png'), fullPage: true });
  await setViewMode(page, 'cards');
  await page.locator('#headerThemeSelect').selectOption('forest');
  await page.screenshot({ path: testInfo.outputPath('cards-forest.png'), fullPage: true });
  await page.reload(); await expect(page.locator('#headerThemeSelect')).toHaveValue('forest');
  await page.locator('#headerThemeSelect').selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme)).toContain('dark');
});

test('cross-page refresh preserves drafts and rejects stale saves/deletes', async ({ extension }) => {
  const a = await extension.open(); await seed(a);
  const b = await extension.open(); const panel = await extension.open('sidepanel.html');
  await a.locator('[data-prompt-id="prompt-0"] [data-action="edit"]').click();
  await a.locator('#promptContent').fill('未保存草稿');
  await b.evaluate(async () => { const db = await import('./db.js'); const row = await db.getPrompt('prompt-0'); await db.savePrompt({ ...row, content: '另一页保存' }); });
  await expect(panel.locator('[data-prompt-id="prompt-0"] .item-preview')).toHaveText('另一页保存');
  await expect(a.locator('#promptContent')).toHaveValue('未保存草稿');
  await a.locator('button[form="promptForm"]').click();
  await expect(a.locator('.toast').last()).toContainText('其他页面');
  await expect(a.locator('#promptModalBackdrop')).toBeVisible();
  expect(await b.evaluate(async () => (await (await import('./db.js')).getPrompt('prompt-0')).content)).toBe('另一页保存');
  a.once('dialog', dialog => dialog.accept());
  await a.locator('#deletePromptButton').click();
  await expect(a.locator('.toast').last()).toContainText('其他页面');
});

test('atomic JSON preview, cancellation and stale preview protection', async ({ extension }) => {
  const page = await extension.open();
  await openSettings(page); await page.locator('#importJson').click();
  const invalid = snapshot(); invalid.prompts[1].tags = [12];
  await page.locator('#fileInput').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await expect(page.locator('.toast').last()).toContainText('无效');
  expect(await page.evaluate(async () => (await (await import('./db.js')).listPrompts()).length)).toBe(0);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#importJson').click();
  await page.locator('#fileInput').setInputFiles({ name: 'sample.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot())) });
  expect(await page.evaluate(async () => (await (await import('./db.js')).listPrompts()).length)).toBe(0);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#importJson').click();
  await page.locator('#fileInput').setInputFiles({ name: 'sample.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot())) });
  await expect(page.locator('.toast').last()).toContainText('导入完成');
  // Native confirm blocks other pages in the same renderer. Exercise the
  // preview race separately against real IndexedDB without mocking confirm.
  const outcome = await page.evaluate(async data => {
    const db = await import('./db.js');
    const preview = await db.previewSnapshotImport(data);
    await db.savePrompt({ title: '预览后的写入', content: '必须保留' });
    try { await db.importSnapshot(data, { preview }); return 'unexpected success'; }
    catch (error) { return error.message; }
  }, snapshot());
  expect(outcome).toContain('重新预览');
  expect(await page.evaluate(async () => (await (await import('./db.js')).listPrompts()).length)).toBe(4);
});

test('CSV all-or-nothing and safe export download', async ({ extension }) => {
  const page = await extension.open(); await openSettings(page);
  await page.locator('#importCsv').click();
  await page.locator('#fileInput').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('title,content\r\nvalid,ok\r\ninvalid,') });
  await expect(page.locator('.toast').last()).toContainText('无效');
  expect(await page.evaluate(async () => (await (await import('./db.js')).listPrompts()).length)).toBe(0);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#importCsv').click();
  await page.locator('#fileInput').setInputFiles({ name: 'valid.csv', mimeType: 'text/csv', buffer: Buffer.from('title,content\r\n=1+1,"多行\n正文"') });
  await expect(page.locator('.toast').last()).toContainText('导入完成');
  const downloadEvent = page.waitForEvent('download'); await page.locator('#exportCsv').click();
  const download = await downloadEvent;
  const content = await readFile(await download.path(), 'utf8');
  expect(content).toContain("'=1+1"); expect(content).toContain('多行\n正文');
});

test('variable literal substitution, failure feedback and focus containment', async ({ extension }) => {
  const page = await extension.open();
  const data = snapshot(1); data.prompts[0].content = '{{a}} / {{b}}'; await seed(page, data);
  await page.locator('[data-action="copy"]').click();
  await expect(page.getByRole('dialog', { name: '填写变量' })).toBeVisible();
  await page.locator('[data-variable-name="a"]').fill('{{b}}');
  await page.locator('[data-variable-name="b"]').fill('VALUE');
  await page.keyboard.press('Control+k');
  expect(await page.evaluate(() => Boolean(document.activeElement.closest('#variableModalBackdrop')))).toBe(true);
  await page.locator('button[form="variableForm"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('{{b}} / VALUE');
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('clipboard denied test'); } }); });
  await page.locator('[data-action="copy"]').click();
  await page.locator('[data-variable-name="a"]').fill('保留输入');
  await page.locator('button[form="variableForm"]').click();
  await expect(page.locator('.toast').last()).toContainText('clipboard denied test');
  await expect(page.locator('[data-variable-name="a"]')).toHaveValue('保留输入');
  await page.keyboard.press('Escape');
  await expect(page.locator('#variableModalBackdrop')).toBeHidden();
});

test('nested folder creation preserves other inline drafts and restores focus', async ({ extension }) => {
  const page = await extension.open(); await seed(page);
  await openSettings(page, 'folders');
  await page.locator('[data-settings-folder-id="work"] input').fill('尚未保存的改名');
  await page.locator('#settingsAddFolder').click();
  await page.locator('#folderName').fill('新文件夹');
  await page.locator('#folderForm').evaluate(form => {
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  await expect(page.locator('#folderModalBackdrop')).toBeHidden();
  await expect(page.locator('[data-settings-folder-id="work"] input')).toHaveValue('尚未保存的改名');
  await expect(page.locator('#settingsFolderList .settings-folder-row')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#settingsModalBackdrop')).toBeHidden();
  await expect(page.locator('#settingsButton')).toBeFocused();
});

test('side panel pagination and incremental manager nodes', async ({ extension }) => {
  const page = await extension.open(); await seed(page, snapshot(135));
  await page.locator('#cardsGrid article').first().evaluate(el => { el.dataset.testSentinel = 'retained'; });
  await page.locator('#loadSentinel').scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('#cardsGrid article').count()).toBeGreaterThan(60);
  await expect(page.locator('[data-test-sentinel="retained"]')).toHaveCount(1);
  const panel = await extension.open('sidepanel.html');
  await expect(panel.locator('#panelResultCount')).toContainText('60 / 135');
  await panel.locator('#panelLoadMore').click();
  await expect(panel.locator('#panelResultCount')).toContainText('120 / 135');
  await panel.locator('#panelLoadMore').click();
  await expect(panel.locator('#panelList article')).toHaveCount(135);
  await expect(panel.locator('#panelLoadMore')).toBeHidden();
  const beforeOrder = await panel.locator('#panelList article').evaluateAll(cards => cards.map(card => card.dataset.promptId));
  const lastId = beforeOrder.at(-1);
  await panel.locator('#panelList article').last().locator('.item-copy').click();
  await expect(panel.locator('#panelToast')).toContainText('已复制');
  expect(await panel.locator('#panelList article').evaluateAll(cards => cards.map(card => card.dataset.promptId))).toEqual(beforeOrder);
  await page.locator('[data-filter="recent"]').click();
  await expect(page.locator('#sortSelect')).toHaveValue('used');
  await expect(page.locator('#cardsGrid article').first()).toHaveAttribute('data-prompt-id', lastId);
  await panel.setViewportSize({ width: 360, height: 800 });
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('file read and quota failures are visible without losing editor input', async ({ extension }) => {
  const page = await extension.open(); await openSettings(page);
  await page.locator('#importJson').click();
  await page.evaluate(() => { File.prototype.text = async () => { throw new Error('Injected file read failure'); }; });
  await page.locator('#fileInput').setInputFiles({ name: 'unreadable.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.locator('.toast').last()).toContainText('Injected file read failure');
  await page.keyboard.press('Escape');
  await page.locator('#newPromptButton').click();
  await page.locator('#promptTitle').fill('失败也保留'); await page.locator('#promptContent').fill('未保存文本');
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...rest) {
      if (this.name === 'prompts') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return put.call(this, value, ...rest);
    };
  });
  await page.locator('button[form="promptForm"]').click();
  await expect(page.locator('.toast').last()).toContainText('Injected quota failure');
  await expect(page.locator('#promptContent')).toHaveValue('未保存文本');
  await expect(page.locator('#allCount')).toHaveText('0');
});
