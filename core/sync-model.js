import { validateSnapshot } from './validation.js';

export const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
export const entityKey = (type, id) => `${type}:${id}`;
export const storeName = type => type === 'prompt' ? 'prompts' : 'folders';
export function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('云端版本或游标无效');
  return BigInt(value);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export function sameEntity(a, b) {
  if (!a || !b) return !a && !b;
  if (Boolean(a.deletedAt) !== Boolean(b.deletedAt)) return false;
  return a.deletedAt ? true : JSON.stringify(stable(a.data)) === JSON.stringify(stable(b.data));
}
export function localEntity(type, row) {
  if (!row) return null;
  const fields = type === 'prompt' ? ['title','content','description','folderId','tags','favorite','sortOrder','createdAt'] : ['name','parentId','sortOrder','createdAt'];
  return { entityType: type, id: row.id, deletedAt: row.deletedAt, data: Object.fromEntries(fields.map(f => [f, row[f]])) };
}
export function validateEntity(entity) {
  if (!entity || !['prompt','folder'].includes(entity.entityType) || typeof entity.id !== 'string' || !entity.id.trim() || bytes(entity.id) > 512) throw new Error('同步实体 ID 无效或超过 512 字节');
  if (entity.deletedAt != null && (!Number.isSafeInteger(entity.deletedAt) || entity.deletedAt <= 0)) throw new Error('云端删除标记无效');
  const body = entity.data;
  const fields = entity.entityType === 'prompt' ? ['title','content','description','folderId','tags','favorite','sortOrder','createdAt'] : ['name','parentId','sortOrder','createdAt'];
  if (!body || Object.keys(body).length !== fields.length || fields.some(f => !Object.hasOwn(body, f))) throw new Error('同步实体字段无效');
  const ref = body[entity.entityType === 'prompt' ? 'folderId' : 'parentId'];
  if (ref !== null && (typeof ref !== 'string' || !ref.trim() || bytes(ref) > 512)) throw new Error('同步目录引用无效');
  if (!Number.isSafeInteger(body.createdAt) || body.createdAt < 0 || !Number.isFinite(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > Number.MAX_SAFE_INTEGER) throw new Error('同步时间或顺序超出范围');
  if (entity.entityType === 'prompt' && (!Array.isArray(body.tags) || body.tags.length > 1000)) throw new Error('同步标签过多或无效');
  // Validate isolated bodies; complete graph validation follows inside IDB.
  const row = { ...body, id: entity.id, deletedAt: null };
  validateSnapshot({ schemaVersion: 1,
    prompts: entity.entityType === 'prompt' ? [{ ...row, folderId: null }] : [],
    folders: entity.entityType === 'folder' ? [{ ...row, parentId: null }] : []
  });
  return entity;
}
export function validatePull(reply, cursor, until = null) {
  if (!reply || reply.protocolVersion !== 1 || !Array.isArray(reply.events) || reply.events.length > 50) throw new Error('云端增量响应格式无效');
  const high = version(reply.highWater);
  if (high < version(cursor) || (until !== null && reply.highWater !== until)) throw new Error('云端增量水位无效');
  let previous = version(cursor);
  for (const event of reply.events) {
    if (version(event.cursor) !== previous + 1n || version(event.cursor) > high || typeof event.opId !== 'string' || !Array.isArray(event.changes) || !event.changes.length) throw new Error('云端增量顺序不连续');
    const seen = new Set();
    for (const row of event.changes) {
      validateEntity(row);
      if (row.serverVersion !== event.cursor || !Number.isFinite(Date.parse(row.serverUpdatedAt))) throw new Error('云端实体版本无效');
      const key = entityKey(row.entityType, row.id);
      if (seen.has(key)) throw new Error('云端变更组包含重复记录');
      seen.add(key);
    }
    previous = version(event.cursor);
  }
  if (version(reply.nextCursor) !== previous || reply.hasMore !== (previous < high) || (reply.hasMore && !reply.events.length)) throw new Error('云端分页游标无效');
  return reply;
}
