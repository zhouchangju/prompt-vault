import { validateSnapshot, validateCsvRows } from './core/validation.js';
import { sortFolders } from './core/order.js';

const DB_NAME = 'prompt-vault-db';
const DB_VERSION = 1;
const STORES = ['prompts', 'folders', 'syncQueue', 'meta'];
const MAX_PENDING = 10000;
let dbPromise;
let legacyDevicePromise;
const listeners = new Set();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('prompt-vault-changes') : null;
channel?.unref?.();
function deliver(change) {
  for (const callback of listeners) { try { callback(change); } catch (error) { console.error(error); } }
}
if (channel) channel.onmessage = event => deliver(event.data);
export function subscribeToChanges(callback) { listeners.add(callback); return () => listeners.delete(callback); }
function notify(change) { deliver(change); channel?.postMessage(change); }
export class ConflictError extends Error {
  constructor(message = '数据已在其他页面更新或删除，请重新读取后再保存。') { super(message); this.name = 'ConflictError'; }
}
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('数据库事务已取消'));
    tx.onerror = () => {}; // onabort reports the final transaction outcome.
  });
}
export function openDatabase() {
  if (dbPromise) return dbPromise;
  const pending = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onblocked = () => { blocked = true; reject(new Error('数据库被旧页面占用，请关闭其他扩展页面后重试。')); };
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['prompts', 'folders']) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: 'id' });
        for (const index of (name === 'prompts' ? ['folderId', 'updatedAt', 'deletedAt'] : ['updatedAt', 'deletedAt'])) store.createIndex(index, index);
      }
      if (!db.objectStoreNames.contains('syncQueue')) db.createObjectStore('syncQueue', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); dbPromise = undefined; deliver({ type: 'database-closed' }); };
      db.onclose = () => { dbPromise = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  dbPromise = pending;
  pending.catch(() => { if (dbPromise === pending) dbPromise = undefined; });
  return pending;
}
async function transaction(names, mode, body) {
  const db = await openDatabase();
  const tx = db.transaction(names, mode);
  const done = txDone(tx);
  // Attach a handler immediately: a request failure may abort before body unwinds.
  done.catch(() => {});
  try {
    const result = await body(tx);
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* It may already have aborted. */ }
    await done.catch(() => {});
    throw error;
  }
}
async function legacyDeviceId() {
  if (!legacyDevicePromise) legacyDevicePromise = (async () => {
    try {
      const stored = await globalThis.chrome?.storage?.local?.get(['deviceId']);
      return typeof stored?.deviceId === 'string' && stored.deviceId ? stored.deviceId : null;
    } catch { return null; } // Legacy metadata is optional; IndexedDB remains authoritative.
  })();
  return legacyDevicePromise;
}
async function deviceId(tx, legacy) {
  const store = tx.objectStore('meta');
  let row = await requestToPromise(store.get('deviceId'));
  if (!row) { row = { key: 'deviceId', value: legacy || crypto.randomUUID() }; store.put(row); }
  return row.value;
}
function enqueue(tx, type, id, operation, now) {
  tx.objectStore('syncQueue').put({ id: `${type}:${id}`, entityType: type, entityId: id, operation, createdAt: now });
}
async function boundQueue(tx) {
  const queue = tx.objectStore('syncQueue');
  const meta = tx.objectStore('meta');
  const migrated = await requestToPromise(meta.get('coalescedQueue'));
  if (!migrated) {
    const rows = await requestToPromise(queue.getAll());
    const latest = new Map();
    for (const row of rows) {
      const key = `${row.entityType}:${row.entityId}`;
      if (!latest.has(key) || latest.get(key).createdAt <= row.createdAt) latest.set(key, { ...row, id: key });
    }
    queue.clear();
    for (const row of latest.values()) queue.put(row);
    meta.put({ key: 'coalescedQueue', value: true });
  }
  const count = await requestToPromise(queue.count());
  if (count > MAX_PENDING) {
    // No cloud consumer exists. A full rescan flag preserves the intention when
    // the bounded placeholder queue cannot represent every changed entity.
    meta.put({ key: 'syncNeedsFullRescan', value: true });
    const keys = await requestToPromise(queue.index('createdAt').getAllKeys(undefined, count - MAX_PENDING));
    for (const key of keys) queue.delete(key);
  }
}
async function mutate(body, type = 'data') {
  const legacy = await legacyDeviceId();
  const result = await transaction(STORES, 'readwrite', async tx => {
    // Normalize old random-key queue entries before writing the new intent.
    await boundQueue(tx);
    const meta = tx.objectStore('meta');
    const revision = await requestToPromise(meta.get('revision'));
    const previousRevision = revision?.value || 0;
    if (!Number.isSafeInteger(previousRevision) || previousRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('数据库版本计数超出安全范围，请先导出数据并联系维护者。');
    }
    const nextRevision = { value: previousRevision + 1 };
    const result = await body(tx, await deviceId(tx, legacy), nextRevision);
    await boundQueue(tx);
    meta.put({ key: 'revision', value: nextRevision.value });
    return result;
  });
  notify({ type });
  return result;
}
async function list(name, { includeDeleted = false } = {}) {
  const rows = await transaction([name], 'readonly', tx => requestToPromise(tx.objectStore(name).getAll()));
  return includeDeleted ? rows : rows.filter(row => !row.deletedAt);
}
async function get(name, id) { return (await transaction([name], 'readonly', tx => requestToPromise(tx.objectStore(name).get(id)))) || null; }
export const listPrompts = options => list('prompts', options);
export const listFolders = options => list('folders', options);
export const getPrompt = id => get('prompts', id);
export const getFolder = id => get('folders', id);
function checkVersion(existing, expected) {
  if (!existing || existing.deletedAt || !Number.isSafeInteger(expected) || existing.version !== expected) throw new ConflictError();
}
async function save(name, input, options = {}) {
  return mutate(async (tx, device, revision) => {
    const store = tx.objectStore(name);
    const existing = input.id ? await requestToPromise(store.get(input.id)) : null;
    const expected = options.expectedVersion ?? input.version;
    if (existing) checkVersion(existing, expected);
    else if (expected !== undefined && expected !== null) throw new ConflictError();
    const now = Date.now();
    const row = {
      id: input.id || crypto.randomUUID(), sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
      createdAt: existing?.createdAt ?? now, updatedAt: now, version: (revision.value = Math.max((existing?.version || 0) + 1, revision.value)),
      deviceId: device, deletedAt: null
    };
    if (name === 'prompts') {
      Object.assign(row, { title: input.title?.trim(), content: input.content, description: input.description ?? '',
        folderId: input.folderId || null, tags: input.tags || [], favorite: input.favorite ?? false,
        lastUsedAt: existing?.lastUsedAt ?? null, useCount: existing?.useCount ?? 0 });
      const folder = row.folderId ? await requestToPromise(tx.objectStore('folders').get(row.folderId)) : null;
      if (row.folderId && (!folder || folder.deletedAt)) throw new ConflictError('文件夹已删除，请重新选择。');
      validateSnapshot({ schemaVersion: 1, prompts: [row], folders: folder ? [{ ...folder, parentId: null }] : [] }, { imported: false });
    } else {
      Object.assign(row, { name: input.name?.trim(), parentId: input.parentId === undefined ? (existing?.parentId ?? null) : (input.parentId || null) });
      const folders = (await requestToPromise(store.getAll())).filter(item => !item.deletedAt && item.id !== row.id);
      if (!existing && input.sortOrder === undefined) {
        const maximum = folders.reduce((max, folder) => Math.max(max, folder.sortOrder || 0), -1);
        const next = maximum + 1;
        if (Number.isSafeInteger(next) && next > maximum) {
          row.sortOrder = next;
        } else {
          // Imported/legacy ranks can exceed precise integer arithmetic. Compact
          // them atomically in visible order before appending the new folder.
          sortFolders(folders).forEach((folder, index) => {
            if (folder.sortOrder === index) return;
            folder.sortOrder = index;
            folder.version = (revision.value = Math.max(folder.version + 1, revision.value));
            folder.deviceId = device;
            folder.updatedAt = now;
            store.put(folder);
            enqueue(tx, 'folder', folder.id, 'update', now);
          });
          row.sortOrder = folders.length;
        }
      }
      validateSnapshot({ schemaVersion: 1, prompts: [], folders: [...folders, row] }, { imported: false });
    }
    store.put(row);
    if (options.enqueue !== false) enqueue(tx, name === 'prompts' ? 'prompt' : 'folder', row.id, existing ? 'update' : 'create', now);
    return row;
  });
}
export const savePrompt = (input, options) => save('prompts', input, options);
export const saveFolder = (input, options) => save('folders', input, options);
/** Persist a full live-folder permutation, guarded by the rendered versions. */
export async function reorderFolders(ordered) {
  if (!Array.isArray(ordered) || ordered.some(row => !row || typeof row.id !== 'string'
    || !Number.isSafeInteger(row.version)) || new Set(ordered.map(row => row.id)).size !== ordered.length) {
    throw new ConflictError('文件夹排序数据无效，请刷新列表后重试。');
  }
  // Capture caller-owned data before waiting for the database transaction.
  const requested = ordered.map(({ id, version }) => ({ id, version }));
  return mutate(async (tx, device, revision) => {
    const store = tx.objectStore('folders');
    const live = (await requestToPromise(store.getAll())).filter(row => !row.deletedAt);
    if (live.length !== requested.length) throw new ConflictError('文件夹列表已变化，请刷新后重新排序。');
    const byId = new Map(live.map(row => [row.id, row]));
    for (const entry of requested) checkVersion(byId.get(entry.id), entry.version);
    const now = Date.now();
    return requested.map((entry, index) => {
      const row = byId.get(entry.id);
      row.sortOrder = index;
      row.version = (revision.value = Math.max(row.version + 1, revision.value));
      row.updatedAt = now;
      row.deviceId = device;
      store.put(row);
      enqueue(tx, 'folder', row.id, 'update', now);
      return row;
    });
  });
}
export async function touchPromptUsage(id) {
  return mutate(async tx => {
    const store = tx.objectStore('prompts');
    const row = await requestToPromise(store.get(id));
    if (!row || row.deletedAt) throw new ConflictError('提示词已删除，请刷新列表。');
    row.lastUsedAt = Date.now(); row.useCount = (row.useCount || 0) + 1;
    store.put(row); return row;
  }, 'usage');
}
async function remove(name, id, { expectedVersion } = {}) {
  return mutate(async (tx, device, revision) => {
    const store = tx.objectStore(name);
    const row = await requestToPromise(store.get(id));
    checkVersion(row, expectedVersion);
    const now = Date.now();
    const update = (target, entity, operation) => {
      target.updatedAt = now; target.version = (revision.value = Math.max(target.version + 1, revision.value)); target.deviceId = device;
      tx.objectStore(entity === 'prompt' ? 'prompts' : 'folders').put(target);
      enqueue(tx, entity, target.id, operation, now);
    };
    row.deletedAt = now; update(row, name === 'prompts' ? 'prompt' : 'folder', 'delete');
    if (name === 'folders') {
      for (const prompt of await requestToPromise(tx.objectStore('prompts').getAll())) {
        if (!prompt.deletedAt && prompt.folderId === id) { prompt.folderId = null; update(prompt, 'prompt', 'update'); }
      }
      for (const folder of await requestToPromise(store.getAll())) {
        if (!folder.deletedAt && folder.parentId === id) { folder.parentId = null; update(folder, 'folder', 'update'); }
      }
    }
  });
}
export const softDeletePrompt = (id, options) => remove('prompts', id, options);
export const softDeleteFolder = (id, options) => remove('folders', id, options);
export const getPendingSyncCount = () => transaction(['syncQueue'], 'readonly', tx => requestToPromise(tx.objectStore('syncQueue').count()));
async function state(tx) {
  const [prompts, folders, revision] = await Promise.all([
    requestToPromise(tx.objectStore('prompts').getAll()), requestToPromise(tx.objectStore('folders').getAll()),
    requestToPromise(tx.objectStore('meta').get('revision'))
  ]);
  return { prompts, folders, revision: revision?.value || 0 };
}
export async function exportSnapshot() {
  const data = await transaction(['prompts', 'folders', 'meta'], 'readonly', state);
  return { schemaVersion: 1, app: 'Prompt Vault', exportedAt: new Date().toISOString(),
    prompts: data.prompts.filter(row => !row.deletedAt), folders: data.folders.filter(row => !row.deletedAt) };
}
const importPlans = new WeakMap();
function previewCounts(snapshot, baseline, replace) {
  const counts = { prompts: { added: 0, updated: 0 }, folders: { added: 0, updated: 0 } };
  for (const name of ['prompts', 'folders']) {
    const existing = new Map(baseline[name].map(row => [row.id, row]));
    for (const row of snapshot[name]) counts[name][existing.has(row.id) ? 'updated' : 'added'] += 1;
  }
  return { ...counts, added: counts.prompts.added + counts.folders.added, updated: counts.prompts.updated + counts.folders.updated,
    removed: replace ? baseline.prompts.length + baseline.folders.length : 0 };
}
async function makePreview(snapshot, replace, source) {
  const baseline = await transaction(['prompts', 'folders', 'meta'], 'readonly', state);
  const preview = { ...previewCounts(snapshot, baseline, replace), baseline: baseline.revision };
  importPlans.set(preview, { snapshot, replace, source, revision: baseline.revision });
  return preview;
}
export async function previewSnapshotImport(snapshot, { replace = false } = {}) {
  return makePreview(validateSnapshot(snapshot), replace, JSON.stringify(snapshot));
}
function csvSnapshot(rows, folders) {
  const valid = validateCsvRows(rows);
  const folderByName = new Map(folders.filter(row => !row.deletedAt).map(row => [row.name.trim().toLocaleLowerCase(), row]));
  const newFolders = [];
  const prompts = valid.map(row => {
    const name = (row.folder || '').trim();
    let folder = name ? folderByName.get(name.toLocaleLowerCase()) : null;
    if (name && !folder) {
      folder = { id: crypto.randomUUID(), name, parentId: null };
      folderByName.set(name.toLocaleLowerCase(), folder); newFolders.push(folder);
    }
    const seen = new Set();
    const tags = (row.tags || '').split(/[,，\n]/).map(tag => tag.trim()).filter(tag => {
      const key = tag.toLocaleLowerCase(); if (!tag || seen.has(key)) return false; seen.add(key); return true;
    });
    return { id: crypto.randomUUID(), title: row.title.trim(), content: row.content, description: row.description || '',
      tags, favorite: row.favorite, folderId: folder?.id || null };
  });
  // Existing folders are references, not imported updates.
  const validated = validateSnapshot({ schemaVersion: 1, prompts, folders: [...folders.filter(row => !row.deletedAt), ...newFolders] }, { imported: false });
  const newIds = new Set(newFolders.map(folder => folder.id));
  validated.folders = validated.folders.filter(row => newIds.has(row.id));
  return validated;
}
export async function previewCsvImport(rows) {
  const baseline = await transaction(['prompts', 'folders', 'meta'], 'readonly', state);
  const snapshot = csvSnapshot(rows, baseline.folders);
  const preview = { ...previewCounts(snapshot, baseline, false), baseline: baseline.revision };
  importPlans.set(preview, { snapshot, replace: false, source: JSON.stringify(rows), revision: baseline.revision });
  return preview;
}
async function commitImport(source, preview) {
  const plan = importPlans.get(preview);
  if (!plan || plan.source !== JSON.stringify(source)) throw new ConflictError('导入内容或预览已失效，请重新预览。');
  await mutate(async (tx, device, revision) => {
    const current = await state(tx);
    if (current.revision !== plan.revision) throw new ConflictError('预览后数据发生变化，请重新预览导入。');
    const now = Date.now();
    if (plan.replace && (await requestToPromise(tx.objectStore('meta').get('cloudState')))) throw new Error('已绑定云同步时不支持覆盖式替换，请使用合并导入。');
    if (plan.replace) {
      for (const row of [...current.prompts, ...current.folders]) revision.value = Math.max(revision.value, row.version + 1);
      tx.objectStore('prompts').clear(); tx.objectStore('folders').clear(); tx.objectStore('syncQueue').clear(); tx.objectStore('meta').put({ key: 'syncNeedsFullRescan', value: true }); }
    for (const name of ['folders', 'prompts']) {
      const old = new Map(current[name].map(row => [row.id, row]));
      for (const input of plan.snapshot[name]) {
        const existing = old.get(input.id);
        const row = { ...input, version: (revision.value = Math.max((existing?.version || 0) + 1, revision.value)), deviceId: device, updatedAt: now };
        tx.objectStore(name).put(row); enqueue(tx, name === 'prompts' ? 'prompt' : 'folder', row.id, existing ? 'update' : 'create', now);
      }
    }
  });
  importPlans.delete(preview);
}
export async function importSnapshot(snapshot, { preview, replace = false } = {}) {
  await commitImport(snapshot, preview || await previewSnapshotImport(snapshot, { replace }));
}
export async function importCsvRows(rows, { preview } = {}) { await commitImport(rows, preview || await previewCsvImport(rows)); }
export async function clearAllData() {
  await mutate(async (tx, device, revision) => {
    const cloud = await requestToPromise(tx.objectStore('meta').get('cloudState'));
    if (cloud?.value.pending) throw new Error('存在结果尚未确认的上传，请先立即同步完成确认，再清空本机数据。');
    for (const entry of await requestToPromise(tx.objectStore('meta').getAll())) {
      if (entry.key.startsWith('cloud:')) tx.objectStore('meta').delete(entry.key);
    }
    if (cloud) tx.objectStore('meta').put({ key: 'cloudState', value: { project: cloud.value.project, epoch: crypto.randomUUID(), cursor: '0' } });
    const current = await state(tx);
    for (const row of [...current.prompts, ...current.folders]) revision.value = Math.max(revision.value, row.version + 1);
    tx.objectStore('prompts').clear(); tx.objectStore('folders').clear(); tx.objectStore('syncQueue').clear();
    tx.objectStore('meta').put({ key: 'syncNeedsFullRescan', value: true });
  });
}

// Cloud metadata lives in the existing meta store: additive, no database upgrade.
export const readCloudTransaction = body => transaction(STORES, 'readonly', body);
export const writeCloudTransaction = body => mutate(body, 'sync');
