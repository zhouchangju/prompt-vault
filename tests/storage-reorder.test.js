import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { clearAllData, saveFolder, listFolders, reorderFolders, softDeleteFolder,
  getPendingSyncCount, subscribeToChanges, openDatabase } from '../db.js';
import { sortFolders } from '../core/order.js';
const refs = rows => rows.map(({ id, version }) => ({ id, version }));
const ids = rows => rows.map(row => row.id);
async function seed() {
  await clearAllData();
  return Promise.all(['A', 'B', 'C'].map(name => saveFolder({ name })));
}

test('concurrent folder creates append; reorder persists all ranks, versions, queue and one notification', async () => {
  const rows = await seed();
  assert.deepEqual(rows.map(row => row.sortOrder), [0, 1, 2]);
  const events = [];
  const unsubscribe = subscribeToChanges(change => events.push(change));
  const reordered = await reorderFolders(refs([rows[2], rows[0], rows[1]]));
  unsubscribe();
  assert.equal(events.length, 1);
  assert.deepEqual(ids(sortFolders(await listFolders())), [rows[2].id, rows[0].id, rows[1].id]);
  assert.deepEqual(reordered.map(row => row.sortOrder), [0, 1, 2]);
  assert.ok(reordered.every(row => row.version > rows.find(old => old.id === row.id).version));
  assert.equal(await getPendingSyncCount(), 3);
  const next = await saveFolder({ name: 'Appended' });
  assert.equal(next.sortOrder, 3);
});

test('duplicate/missing/stale/deleted and concurrently added folders reject with zero reorder writes', async () => {
  const rows = await seed();
  const before = await listFolders();
  for (const input of [refs([rows[0], rows[0], rows[2]]), refs(rows.slice(1)),
    [{ id: 'missing', version: 1 }, ...refs(rows.slice(1))], refs(rows).map((row, i) => i ? row : { ...row, version: 0 })]) {
    await assert.rejects(reorderFolders(input), { name: 'ConflictError' });
    assert.deepEqual(await listFolders(), before);
  }
  const added = await saveFolder({ name: 'Added' });
  await assert.rejects(reorderFolders(refs(rows)), { name: 'ConflictError' });
  await softDeleteFolder(added.id, { expectedVersion: added.version });
  await softDeleteFolder(rows[0].id, { expectedVersion: rows[0].version });
  await assert.rejects(reorderFolders(refs(rows)), { name: 'ConflictError' });
});

test('two concurrent reorder requests cannot silently overwrite each other', async () => {
  const rows = await seed();
  const results = await Promise.allSettled([reorderFolders(refs([...rows].reverse())), reorderFolders(refs(rows))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.name, 'ConflictError');
});

test('mid-reorder failure rolls back ranks, entity versions, and queue', async () => {
  const rows = await seed();
  const before = await listFolders();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) {
    if (this.name === 'folders' && value.id === rows[1].id) throw new DOMException('Injected failure', 'QuotaExceededError');
    return originalPut.call(this, value, ...args);
  };
  try { await assert.rejects(reorderFolders(refs([...rows].reverse())), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.deepEqual(await listFolders(), before);
  const db = await openDatabase();
  const queue = await new Promise((resolve, reject) => {
    const request = db.transaction('syncQueue').objectStore('syncQueue').getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  assert.ok(queue.every(entry => entry.operation === 'create'));
});

test('append normalizes unsafe imported ranks atomically and remains last after further appends', async () => {
  await clearAllData();
  const { importSnapshot, exportSnapshot } = await import('../db.js');
  await importSnapshot({ schemaVersion: 1, prompts: [], folders: [
    { id: 'z', name: 'Z', sortOrder: 9007199254740992 },
    { id: 'm', name: 'M', sortOrder: 4 }
  ] });
  const before = await listFolders();
  const added = await saveFolder({ name: 'A' });
  const current = sortFolders(await listFolders());
  assert.deepEqual(ids(current), ['m', 'z', added.id]);
  assert.deepEqual(current.map(row => row.sortOrder), [0, 1, 2]);
  for (const old of before) {
    const updated = current.find(row => row.id === old.id);
    assert.ok(updated.version > old.version);
    assert.equal(updated.deviceId, added.deviceId);
    assert.equal(updated.updatedAt, added.updatedAt);
  }
  const second = await saveFolder({ name: 'Another' });
  assert.equal(second.sortOrder, 3);
  assert.equal(sortFolders(await listFolders()).at(-1).id, second.id);
  const db = await openDatabase();
  const queue = await new Promise((resolve, reject) => {
    const request = db.transaction('syncQueue').objectStore('syncQueue').getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  for (const old of before) assert.equal(queue.find(entry => entry.entityId === old.id).operation, 'update');
  assert.equal((await exportSnapshot()).folders.length, 4);
});
