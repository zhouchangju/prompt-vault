import { test as base, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const test = base.extend({
  extension: async ({}, use) => {
    const profile = await mkdtemp(path.join(tmpdir(), 'prompt-vault-e2e-'));
    const root = process.env.PROMPT_VAULT_TEST_ROOT || process.cwd();
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const errors = []; const requests = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const origin = `chrome-extension://${new URL(worker.url()).host}`;
      const open = async (entry = 'manager.html') => {
        const page = await context.newPage();
        await page.goto(`${origin}/${entry}`);
        await expect(page.locator('html')).toHaveAttribute('data-theme', /.+/);
        if (entry.startsWith('manager')) await expect(page.locator('#headerThemeSelect option')).toHaveCount(13);
        return page;
      };
      await use({ context, worker, origin, open, errors });
      expect(errors, 'Uncaught extension errors').toEqual([]);
      expect(requests, 'Runtime must remain local').toEqual([]);
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  }
});
export { expect };

export function snapshot(count = 3) {
  return { schemaVersion: 1, folders: [{ id: 'work', name: '工作范例' }], prompts: Array.from({ length: count }, (_, i) => ({
    id: `prompt-${i}`, title: `示例提示 ${String(i + 1).padStart(3, '0')}`, content: `合成测试正文 ${i} searchable-body`,
    description: '用于回归验证的合成样例', tags: ['示例'], folderId: 'work', favorite: i === 0
  })) };
}
export async function seed(page, data = snapshot()) {
  await page.evaluate(async data => { await (await import('./db.js')).importSnapshot(data); }, data);
  await expect(page.locator('#allCount')).toHaveText(String(data.prompts.length));
}
export async function openSettings(page, tab = 'importexport') {
  await page.locator('#settingsButton').click();
  await page.locator(`[data-settings-tab="${tab}"]`).click();
}

export async function setViewMode(page, mode) {
  const toggle = page.locator("#viewModeToggle");
  const compact = (await toggle.getAttribute("aria-pressed")) === "true";
  if (compact !== (mode === "compact")) await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-view", mode);
}
