import { test, expect, snapshot, seed } from './fixtures.js';

test('original v1 database and legacy device ID upgrade without losing content', async ({ extension }) => {
  await extension.worker.evaluate(async () => {
    await chrome.storage.local.set({ deviceId: 'legacy-device', settings: { theme: 'dark', cardDensity: 'compact' } });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('prompt-vault-db', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ['prompts', 'folders']) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          for (const key of name === 'prompts' ? ['folderId','updatedAt','deletedAt'] : ['updatedAt','deletedAt']) store.createIndex(key,key);
        }
        db.createObjectStore('syncQueue', { keyPath: 'id' }).createIndex('createdAt','createdAt');
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['prompts', 'syncQueue'], 'readwrite');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      tx.objectStore('prompts').put({id:'legacy',title:'旧版提示',content:'必须保留的旧数据',description:'',folderId:null,tags:[],favorite:false,
        sortOrder:0,createdAt:100,updatedAt:100,lastUsedAt:null,useCount:0,version:7,deviceId:'legacy-device',deletedAt:null});
      tx.objectStore('syncQueue').put({id:'old-random-id',entityType:'prompt',entityId:'legacy',operation:'update',createdAt:100});
    });
    db.close();
  });
  const page = await extension.open();
  await expect(page.locator('#allCount')).toHaveText('1');
  await expect(page.locator('#headerThemeSelect')).toHaveValue('dark');
  await page.locator('[data-action="edit"]').click();
  await expect(page.locator('#promptContent')).toHaveValue('必须保留的旧数据');
  await page.locator('#promptTitle').fill('旧版编辑成功');
  await page.locator('button[form="promptForm"]').click();
  const row = await page.evaluate(async () => (await import('./db.js')).getPrompt('legacy'));
  expect(row.content).toBe('必须保留的旧数据'); expect(row.deviceId).toBe('legacy-device'); expect(row.version).toBeGreaterThan(7);
});

test('actual IndexedDB abort rolls back entire import after a write failure', async ({ extension }) => {
  const page = await extension.open();
  const result = await page.evaluate(async data => {
    const db = await import('./db.js'); const preview = await db.previewSnapshotImport(data);
    const original = IDBObjectStore.prototype.put; let puts = 0; let message;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'prompts' && ++puts === 2) throw new DOMException('Injected storage quota failure', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
    try { await db.importSnapshot(data, { preview }); }
    catch (error) { message = error.message; }
    finally { IDBObjectStore.prototype.put = original; }
    return { message, prompts: await db.listPrompts(), folders: await db.listFolders(), pending: await db.getPendingSyncCount() };
  }, snapshot(3));
  expect(result.message).toContain('Injected storage quota');
  expect(result.prompts).toEqual([]); expect(result.folders).toEqual([]); expect(result.pending).toBe(0);
});

test('versionchange closes old connections and reports incompatible upgraded database', async ({ extension }) => {
  const page = await extension.open(); await seed(page, snapshot(1));
  const upgraded = await extension.worker.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('prompt-vault-db', 2);
    request.onsuccess = () => { const version = request.result.version; request.result.close(); resolve(version); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Old connection did not close'));
  }));
  expect(upgraded).toBe(2);
  await expect(page.locator('.toast').last()).toContainText('失败');
});

test('first database open failure is visible and focus retry recovers', async ({ extension }) => {
  const page = await extension.context.newPage();
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB); let once = true;
    indexedDB.open = (...args) => { if (once) { once = false; throw new Error('Injected transient open error'); } return open(...args); };
  });
  await page.goto(`${extension.origin}/manager.html`);
  await expect(page.locator('.toast').last()).toContainText('Injected transient open error');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('#newPromptButton').click();
  await page.locator('#promptTitle').fill('重试成功'); await page.locator('#promptContent').fill('新记录');
  await page.locator('button[form="promptForm"]').click();
  await expect(page.locator('#allCount')).toHaveText('1');
});
