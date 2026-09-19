import { readCloudTransaction, writeCloudTransaction } from '../db.js';
import { validateSnapshot } from './validation.js';
import { entityKey, localEntity, sameEntity, storeName, validateEntity, version, bytes } from './sync-model.js';

const req = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const baseKey = (type, id) => `cloud:base:${entityKey(type, id)}`;
const putState = (tx, value) => tx.objectStore('meta').put({ key: 'cloudState', value });
async function read(tx) {
  const meta = tx.objectStore('meta');
  const range = prefix => IDBKeyRange.bound(prefix, `${prefix}\uffff`);
  const [prompts, folders, savedState, revision, bases, backupKeys] = await Promise.all([
    req(tx.objectStore('prompts').getAll()), req(tx.objectStore('folders').getAll()),
    req(meta.get('cloudState')), req(meta.get('revision')),
    req(meta.getAll(range('cloud:base:'))), req(meta.getAllKeys(range('cloud:backup:')))
  ]);
  // Recovery snapshots can be large; routine sync/status reads only their keys.
  const metadata = [savedState, revision, ...bases, ...backupKeys.map(key => ({ key, value: { at: Number(key.split(':')[2]) } }))].filter(Boolean);
  const state = metadata.find(x => x.key === 'cloudState')?.value;
  return { prompts, folders, state, metadata, bases: new Map(metadata.filter(x => x.key.startsWith('cloud:base:')).map(x => [x.key.slice(11), x.value])) };
}
function checkState(state, token) {
  if (!state || state.project !== token.project || state.epoch !== token.epoch) throw new Error('本机数据或连接已变化，本轮同步已停止');
}
function dirtyRows(data) {
  const rows = [];
  for (const type of ['folder','prompt']) for (const row of data[storeName(type)]) {
    const local = localEntity(type, row), base = data.bases.get(entityKey(type, row.id));
    if ((!base && row.deletedAt) || sameEntity(local, base)) continue;
    rows.push({ ...local, baseVersion: base?.serverVersion || '0' });
  }
  return rows;
}
export async function bindCloudProject(project) {
  return writeCloudTransaction(async tx => {
    const data = await read(tx);
    if (data.state?.project === project) return data.state;
    if (data.state && (data.state.pending || data.bases.size || version(data.state.cursor) > 0n)) throw new Error('已绑定其他云库，请先导出备份、清空本机数据，再更换项目');
    const state = { project, epoch: crypto.randomUUID(), cursor: '0' };
    putState(tx, state); return state;
  });
}
export const cloudDetails = () => readCloudTransaction(async tx => {
  const data = await read(tx);
  return { ...data.state, pendingCount: dirtyRows(data).length, conflict: data.state?.conflict,
    revision: data.metadata.find(x => x.key === 'revision')?.value || 0,
    backups: data.metadata.filter(x => x.key.startsWith('cloud:backup:')).map(x => ({ key: x.key, at: x.value.at })) };
});
export const cloudBackup = key => readCloudTransaction(async tx => {
  if (!key.startsWith('cloud:backup:')) throw new Error('无效备份');
  return (await req(tx.objectStore('meta').get(key)))?.value.snapshot;
});
export async function prepareUpload(token) {
  return writeCloudTransaction(async (tx, device) => {
    const data = await read(tx); checkState(data.state, token);
    if (data.state.pending) return data.state.pending;
    if (data.state.conflict) throw new Error('请先处理云同步冲突');
    const dirty = dirtyRows(data);
    const folders = dirty.filter(x => x.entityType === 'folder' && !x.deletedAt);
    const prompts = dirty.filter(x => x.entityType === 'prompt');
    const deletions = dirty.filter(x => x.entityType === 'folder' && x.deletedAt);
    const source = folders.length ? folders : prompts.length ? prompts : deletions;
    if (!source.length) return null;
    const isFolderGroup = source !== prompts;
    if (isFolderGroup && source.length > 500) throw new Error('关联目录变更超过云端单组 500 项限制，请先分批整理');
    const changes = []; let size = 0;
    for (const row of source) {
      validateEntity(row);
      const change = { entityType: row.entityType, id: row.id, baseVersion: row.baseVersion, deleted: Boolean(row.deletedAt), data: row.deletedAt ? null : row.data };
      const length = bytes(change);
      if (!isFolderGroup && changes.length && (size + length > 4 * 1024 * 1024 || changes.length >= 100)) break;
      changes.push(change); size += length;
    }
    const pending = { request: { protocolVersion: 1, opId: crypto.randomUUID(), deviceId: device, changes }, acked: false };
    if (bytes(pending.request) > 12 * 1024 * 1024) throw new Error('同步变更组过大，请缩小单次修改或导出备份');
    data.state.pending = pending; putState(tx, data.state); return pending;
  });
}
export async function acceptUpload(token, opId, response) {
  if (!response || response.opId !== opId || !['applied','conflict'].includes(response.status)) throw new Error('上传确认格式无效，待下次手动同步确认');
  if (response.status === 'applied') version(response.cursor);
  return writeCloudTransaction(async tx => {
    const data = await read(tx); checkState(data.state, token);
    if (data.state.pending?.request.opId !== opId) throw new Error('上传确认已过期');
    if (response.status === 'conflict') data.state.pending = null;
    else data.state.pending.acked = true;
    putState(tx, data.state);
  });
}
function remoteLocal(remote, prior, device, nextVersion) {
  return { ...remote.data, id: remote.id, version: nextVersion, deviceId: device, deletedAt: remote.deletedAt,
    updatedAt: Date.parse(remote.serverUpdatedAt),
    ...(remote.entityType === 'prompt' ? { useCount: prior?.useCount || 0, lastUsedAt: prior?.lastUsedAt || null } : {}) };
}
export async function applyCloudEvent(token, event, resolution = null) {
  return writeCloudTransaction(async (tx, device, revision) => {
    const data = await read(tx); const state = data.state; checkState(state, token);
    if (version(event.cursor) !== version(state.cursor) + 1n) throw new Error('本地同步游标已变化');
    if (resolution && data.metadata.find(x => x.key === 'revision')?.value !== resolution.revision) throw new Error('预览后本地数据已变化，请重新检查冲突');
    const beforeMaps = Object.fromEntries(['prompts','folders'].map(name => [name, new Map(data[name].map(row => [row.id, row]))]));
    const maps = Object.fromEntries(['prompts','folders'].map(name => [name, new Map(data[name].map(row => [row.id, row]))]));
    const own = state.pending?.request.opId === event.opId;
    const sent = new Set(own ? state.pending.request.changes.map(x => entityKey(x.entityType, x.id)) : []);
    const conflicts = [];
    for (const remote of event.changes) {
      const key = entityKey(remote.entityType, remote.id), base = data.bases.get(key);
      const row = maps[storeName(remote.entityType)].get(remote.id), local = localEntity(remote.entityType, row);
      // Old local-only tombstones must not delete pre-existing cloud records.
      if (!local || (!base && local.deletedAt) || sameEntity(local, base) || sameEntity(local, remote) || sent.has(key)) continue;
      conflicts.push({ key, local: row, remote });
    }
    if (conflicts.length && !resolution) {
      state.conflict = { event, conflicts }; putState(tx, state); return false;
    }
    if (resolution) {
      const snapshot = { schemaVersion: 1, prompts: data.prompts.filter(x => !x.deletedAt), folders: data.folders.filter(x => !x.deletedAt) };
      tx.objectStore('meta').put({ key: `cloud:backup:${Date.now()}:${crypto.randomUUID()}`, value: { snapshot } });
    }
    const conflictKeys = new Set(conflicts.map(x => x.key));
    const clones = new Map();
    const changed = new Set();
    const writeLocal = (type, row) => { maps[storeName(type)].set(row.id, row); changed.add(entityKey(type, row.id)); };
    if (resolution?.choice === 'cloud' && state.conflict?.structural) {
      for (const row of data.folders) {
        const base = data.bases.get(entityKey('folder', row.id));
        if (base && !sameEntity(localEntity('folder', row), base)) writeLocal('folder', remoteLocal(base, row, device, revision.value));
      }
    }
    for (const remote of event.changes) {
      const type = remote.entityType, key = entityKey(type, remote.id), prior = maps[storeName(type)].get(remote.id);
      const local = localEntity(type, prior);
      const preserve = (sent.has(key) && !sameEntity(local, remote)) || (resolution?.choice === 'local' &&
        (conflictKeys.has(key) || (state.conflict?.structural && type === 'folder' && prior)));
      if (preserve && prior && !prior.deletedAt && remote.deletedAt) {
        const copy = { ...prior, id: crypto.randomUUID(), deletedAt: null };
        writeLocal(type, copy);
        if (type === 'folder') clones.set(prior.id, copy.id);
        writeLocal(type, remoteLocal(remote, prior, device, revision.value));
      } else if (!preserve) {
        writeLocal(type, remoteLocal(remote, prior, device, revision.value));
      }
    }
    // Deleted remote folders ungroup local-only children without losing content.
    const removed = new Set(event.changes.filter(x => x.entityType === 'folder' && x.deletedAt).map(x => x.id));
    for (const type of ['folder','prompt']) for (const row of maps[storeName(type)].values()) {
      if (row.deletedAt) continue;
      const field = type === 'folder' ? 'parentId' : 'folderId';
      const before = beforeMaps[storeName(type)].get(row.id);
      const restore = resolution?.choice === 'local' && clones.get(before?.[field]);
      const target = restore || clones.get(row[field]) || (removed.has(row[field]) || maps.folders.get(row[field])?.deletedAt ? null : row[field]);
      if (target !== row[field]) writeLocal(type, { ...row, [field]: target });
    }
    try {
      validateSnapshot({ schemaVersion: 1, prompts: [...maps.prompts.values()].filter(x => !x.deletedAt), folders: [...maps.folders.values()].filter(x => !x.deletedAt) }, { imported: false });
    } catch (error) {
      const dirtyFolders = data.folders.filter(row => {
        const base = data.bases.get(entityKey('folder', row.id));
        return base && !sameEntity(localEntity('folder', row), base);
      });
      if (resolution || !dirtyFolders.length) throw error;
      state.conflict = { event, structural: true, conflicts: dirtyFolders.map(row => ({ key: entityKey('folder',row.id), local: row, remote: data.bases.get(entityKey('folder',row.id)) })) };
      putState(tx, state); return false;
    }
    for (const remote of event.changes) {
      tx.objectStore('meta').put({ key: baseKey(remote.entityType, remote.id), value: remote });
      if (sameEntity(localEntity(remote.entityType, maps[storeName(remote.entityType)].get(remote.id)), remote)) tx.objectStore('syncQueue').delete(entityKey(remote.entityType, remote.id));
    }
    for (const type of ['folder','prompt']) for (const row of maps[storeName(type)].values()) {
      if (!changed.has(entityKey(type, row.id))) continue;
      revision.value = Math.max(revision.value, row.version || 0) + 1;
      if (!Number.isSafeInteger(revision.value)) throw new Error('本机版本超出范围');
      tx.objectStore(storeName(type)).put({ ...row, version: revision.value, deviceId: device });
    }
    state.cursor = event.cursor; state.conflict = null;
    if (own) state.pending = null;
    putState(tx, state); return true;
  });
}
export async function finishCloudPull(token) {
  return writeCloudTransaction(async tx => {
    const row = await req(tx.objectStore('meta').get('cloudState')); checkState(row?.value, token);
    row.value.lastPullAt = Date.now(); tx.objectStore('meta').put(row);
  });
}
