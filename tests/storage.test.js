import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  clearAllData, savePrompt, saveFolder, listPrompts, listFolders, getPrompt,
  softDeletePrompt, softDeleteFolder, touchPromptUsage, exportSnapshot,
  previewSnapshotImport, importSnapshot, previewCsvImport, importCsvRows,
  getPendingSyncCount, subscribeToChanges, openDatabase
} from '../db.js';

const prompt = (title = 'Example') => ({ title, content: 'Hello {{name}}', tags: [] });
const snapshot = (prompts = [], folders = []) => ({ schemaVersion: 1, prompts, folders });

test('concurrent stale updates and deletes reject without overwriting committed data', async () => {
  await clearAllData();
  const original = await savePrompt(prompt());
  const results = await Promise.allSettled([
    savePrompt({ ...original, title: 'First' }), savePrompt({ ...original, title: 'Second' })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.name, 'ConflictError');
  await assert.rejects(softDeletePrompt(original.id, { expectedVersion: original.version }), { name: 'ConflictError' });
  const current = await getPrompt(original.id);
  await softDeletePrompt(current.id, { expectedVersion: current.version });
  await assert.rejects(savePrompt({ ...current, title: 'Resurrect' }), { name: 'ConflictError' });
  assert.equal((await listPrompts()).length, 0);
});

test('device identity is stable across concurrent creates and clear, queue coalesces', async () => {
  await clearAllData();
  const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => savePrompt(prompt(`Item ${i}`))));
  assert.equal(new Set(rows.map(row => row.deviceId)).size, 1);
  let row = rows[0];
  for (let i = 0; i < 8; i++) row = await savePrompt({ ...row, title: `Edit ${i}` });
  assert.equal(await getPendingSyncCount(), 12);
  await clearAllData();
  assert.equal((await savePrompt(prompt())).deviceId, rows[0].deviceId);
});

test('usage survives editing from an earlier content version and emits after commit', async () => {
  await clearAllData();
  const original = await savePrompt(prompt());
  const events = [];
  const unsubscribe = subscribeToChanges(event => events.push(event.type));
  await touchPromptUsage(original.id);
  const edited = await savePrompt({ ...original, title: 'Edited' });
  unsubscribe();
  assert.equal(edited.useCount, 1);
  assert.ok(edited.lastUsedAt);
  assert.deepEqual(events, ['usage', 'data']);
});

test('folder deletion atomically ungroups prompts and checks stale folder versions', async () => {
  await clearAllData();
  const folder = await saveFolder({ name: 'Work' });
  const child = await saveFolder({ name: 'Child', parentId: folder.id });
  const item = await savePrompt({ ...prompt(), folderId: folder.id });
  await softDeleteFolder(folder.id, { expectedVersion: folder.version });
  assert.equal((await getPrompt(item.id)).folderId, null);
  assert.equal((await listFolders()).find(row => row.id === child.id).parentId, null);
  await assert.rejects(savePrompt({ ...item, title: 'Stale' }), { name: 'ConflictError' });
});

test('JSON rejects bad schema/types/duplicates/references and later invalid rows with zero writes', async () => {
  await clearAllData();
  const original = await savePrompt(prompt('Original'));
  const good = { id: 'new', ...prompt('New') };
  const bad = [
    { ...snapshot([good]), schemaVersion: 2 }, snapshot([good, good]),
    snapshot([good, { ...good, id: 'bad', content: 123 }]),
    snapshot([{ ...good, tags: [null] }]), snapshot([{ ...good, folderId: 'missing' }]),
    snapshot([], [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }])
  ];
  for (const value of bad) await assert.rejects(importSnapshot(value));
  assert.deepEqual((await listPrompts()).map(row => row.id), [original.id]);
});

test('preview requires unchanged data including usage/clear and unchanged input', async () => {
  await clearAllData();
  const row = await savePrompt(prompt());
  const data = snapshot([{ ...row, title: 'Imported' }]);
  let preview = await previewSnapshotImport(data);
  assert.equal(preview.updated, 1);
  await touchPromptUsage(row.id);
  await assert.rejects(importSnapshot(data, { preview }), { name: 'ConflictError' });
  preview = await previewSnapshotImport(data);
  await clearAllData();
  await assert.rejects(importSnapshot(data, { preview }), { name: 'ConflictError' });
  preview = await previewSnapshotImport(data);
  data.prompts[0].title = 'Changed after preview';
  await assert.rejects(importSnapshot(data, { preview }), { name: 'ConflictError' });
});

test('JSON export/import round trip retains user fields and atomically imports all entities', async () => {
  await clearAllData();
  const folder = await saveFolder({ name: 'Work' });
  await savePrompt({ ...prompt('One'), folderId: folder.id, favorite: true, tags: ['tag'] });
  const backup = await exportSnapshot();
  await clearAllData();
  const preview = await previewSnapshotImport(backup);
  assert.equal(preview.added, 2);
  await importSnapshot(backup, { preview });
  const restored = await exportSnapshot();
  for (const key of ['title', 'content', 'folderId', 'favorite', 'tags', 'createdAt']) assert.deepEqual(restored.prompts[0][key], backup.prompts[0][key]);
  assert.equal(restored.folders[0].id, folder.id);
});

test('CSV prevalidates all rows and uses a single import plan with existing/new folders', async () => {
  await clearAllData();
  await saveFolder({ name: 'Existing' });
  const rows = [{ title: 'One', content: 'Text', folder: 'Existing', favorite: 'true' },
    { title: 'Two', content: 'More', folder: 'New', tags: 'tag,TAG,other' }];
  await assert.rejects(importCsvRows([...rows, { title: 'Broken', content: '' }]));
  assert.equal((await listPrompts()).length, 0);
  assert.equal((await listFolders()).length, 1);
  const preview = await previewCsvImport(rows);
  assert.deepEqual(preview.prompts, { added: 2, updated: 0 });
  assert.deepEqual(preview.folders, { added: 1, updated: 0 });
  await importCsvRows(rows, { preview });
  assert.equal((await listPrompts()).length, 2);
  assert.equal((await listFolders()).length, 2);
  assert.deepEqual((await listPrompts()).find(row => row.title === 'Two').tags, ['tag', 'other']);
});

test('synchronous put failure aborts the complete import transaction', async () => {
  await clearAllData();
  const data = snapshot([{ id: 'one', ...prompt('One') }, { id: 'two', ...prompt('Two') }]);
  const preview = await previewSnapshotImport(data);
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (this.name === 'prompts' && value.id === 'two') throw new DOMException('Injected quota failure', 'QuotaExceededError');
    return originalPut.call(this, value, ...args);
  };
  try { await assert.rejects(importSnapshot(data, { preview }), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.equal((await listPrompts()).length, 0);
  assert.equal(await getPendingSyncCount(), 0);
});

test('bounded placeholder queue records full rescan intent without losing entities', async () => {
  await clearAllData();
  const data = snapshot(Array.from({ length: 10001 }, (_, i) => ({ id: `bulk-${i}`, ...prompt(`Item ${i}`) })));
  await importSnapshot(data);
  assert.equal(await getPendingSyncCount(), 10000);
  assert.equal((await listPrompts()).length, 10001);
  const db = await openDatabase();
  const flag = await new Promise((resolve, reject) => {
    const request = db.transaction('meta').objectStore('meta').get('syncNeedsFullRescan');
    request.onsuccess = () => resolve(request.result?.value); request.onerror = () => reject(request.error);
  });
  assert.equal(flag, true);
});

test('clear/reimport and replace/restore reject ABA stale editors even for high imported versions', async () => {
  await clearAllData();
  const data = snapshot([{ id: 'aba', ...prompt(), version: 500000 }]);
  await importSnapshot(data);
  const stale = await getPrompt('aba');
  await clearAllData();
  await importSnapshot(data);
  assert.ok((await getPrompt('aba')).version > stale.version);
  await assert.rejects(savePrompt({ ...stale, title: 'Stale overwrite' }), { name: 'ConflictError' });
  const second = await getPrompt('aba');
  await importSnapshot(snapshot(), { replace: true });
  await importSnapshot(data);
  assert.ok((await getPrompt('aba')).version > second.version);
  await assert.rejects(softDeletePrompt('aba', { expectedVersion: second.version }), { name: 'ConflictError' });
});

test('folder graph validation handles deep chains iteratively and rejects a deep cycle', async () => {
  const { validateSnapshot } = await import('../core/validation.js');
  const folders = Array.from({ length: 10000 }, (_, i) => ({ id: `f${i}`, name: `Folder ${i}`, parentId: i ? `f${i - 1}` : null }));
  assert.equal(validateSnapshot(snapshot([], folders)).folders.length, 10000);
  folders[0].parentId = 'f9999';
  assert.throws(() => validateSnapshot(snapshot([], folders)), /循环/);
});

test('legacy device id migrates atomically and a future legacy queue timestamp cannot override a new delete', async () => {
  await clearAllData();
  const item = await savePrompt(prompt('Legacy'));
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'syncQueue'], 'readwrite');
    tx.objectStore('meta').delete('deviceId');
    tx.objectStore('meta').delete('coalescedQueue');
    tx.objectStore('syncQueue').put({ id: 'legacy-random-key', entityType: 'prompt', entityId: item.id, operation: 'update', createdAt: Date.now() + 1e9 });
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: { get: async () => ({ deviceId: 'legacy-device-id' }) } } };
  try {
    const migrated = await import('../db.js?legacy-test');
    await migrated.softDeletePrompt(item.id, { expectedVersion: item.version });
    const rows = await Promise.all([migrated.savePrompt(prompt('A')), migrated.savePrompt(prompt('B'))]);
    assert.ok(rows.every(row => row.deviceId === 'legacy-device-id'));
    const queued = await new Promise((resolve, reject) => {
      const request = db.transaction('syncQueue').objectStore('syncQueue').get(`prompt:${item.id}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    assert.equal(queued.operation, 'delete');
    (await migrated.openDatabase()).close();
  } finally { globalThis.chrome = previousChrome; }
});

test('failed database open is retryable', async () => {
  const fresh = await import('../db.js?retry-test');
  const originalOpen = indexedDB.open;
  indexedDB.open = () => { throw new DOMException('Unavailable', 'UnknownError'); };
  try { await assert.rejects(fresh.openDatabase(), { name: 'UnknownError' }); }
  finally { indexedDB.open = originalOpen; }
  const db = await fresh.openDatabase();
  assert.equal(db.name, 'prompt-vault-db');
  db.close();
});

test('unsafe imported versions cannot poison the persistent clock or partially import', async () => {
  await clearAllData();
  const original = await savePrompt(prompt('Kept'));
  for (const version of [Number.MAX_SAFE_INTEGER, 1_000_000_000_001, Infinity]) {
    await assert.rejects(importSnapshot(snapshot([{ id: 'safe-first', ...prompt() }, { id: 'poison', ...prompt(), version }])));
  }
  assert.deepEqual((await listPrompts()).map(row => row.id), [original.id]);
  await savePrompt(prompt('Still writable'));
  await clearAllData();
  await savePrompt(prompt('Writable after clear'));
});

test('preview owns copied tags and cannot be mutated through the original input alias', async () => {
  await clearAllData();
  const data = snapshot([{ id: 'tag-copy', ...prompt(), tags: ['valid'] }]);
  const original = structuredClone(data);
  const preview = await previewSnapshotImport(data);
  data.prompts[0].tags.push({ invalid: true });
  await importSnapshot(original, { preview });
  assert.deepEqual((await getPrompt('tag-copy')).tags, ['valid']);
});

test('maximum accepted import version permits repeated edits and an exported reimport', async () => {
  await clearAllData();
  const { MAX_IMPORTED_VERSION } = await import('../core/validation.js');
  await importSnapshot(snapshot([{ id: 'max-accepted', ...prompt(), version: MAX_IMPORTED_VERSION }]));
  let row = await getPrompt('max-accepted');
  row = await savePrompt({ ...row, title: 'First edit' });
  row = await savePrompt({ ...row, title: 'Second edit' });
  assert.equal(row.title, 'Second edit');
  const backup = await exportSnapshot();
  await importSnapshot(backup);
  assert.equal((await getPrompt('max-accepted')).title, 'Second edit');
});

test('legacy v1 rows without a revision clock seed a safe floor before clear and restore', async () => {
  await clearAllData();
  const row = await savePrompt({ id: 'legacy-aba', ...prompt() });
  const legacy = { ...row, version: 2 };
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['prompts', 'meta'], 'readwrite');
    tx.objectStore('prompts').put(legacy);
    tx.objectStore('meta').delete('revision');
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
  await clearAllData();
  await importSnapshot(snapshot([legacy]));
  assert.ok((await getPrompt(legacy.id)).version > 2);
  await assert.rejects(savePrompt({ ...legacy, title: 'Stale legacy editor' }), { name: 'ConflictError' });
});

test('renaming an imported nested folder preserves its parent unless explicitly changed', async () => {
  await clearAllData();
  const parent = await saveFolder({ name: 'Parent' });
  const child = await saveFolder({ name: 'Child', parentId: parent.id });
  const renamed = await saveFolder({ id: child.id, name: 'Renamed', version: child.version });
  assert.equal(renamed.parentId, parent.id);
  const moved = await saveFolder({ id: child.id, name: 'Root', parentId: null, version: renamed.version });
  assert.equal(moved.parentId, null);
});
