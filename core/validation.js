// Exchange files are data, never executable input. Reject the whole file on error.
export const MAX_IMPORT_ROWS = 100000;
// Leave ample exact-integer headroom for the persistent local version clock.
export const MAX_IMPORTED_VERSION = 1_000_000_000_000;
const MAX_TEXT = 2_000_000;
function fail(message) { throw new Error(`导入数据无效：${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
}
function string(value, label, { optional = false, nonempty = false } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > MAX_TEXT || (nonempty && !value.trim())) fail(label);
  return value;
}
function number(value, label, fallback, integer = false) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) fail(label);
  return value;
}
function relation(value, label) {
  if (value === undefined || value === null) return null;
  return string(value, label, { nonempty: true });
}
function common(row, label, now, imported) {
  object(row, label);
  if (row.deletedAt !== undefined && row.deletedAt !== null) fail(`${label}: 不接受已删除记录`);
  if (imported && row.version !== undefined && row.version > MAX_IMPORTED_VERSION) fail(`${label}.version 超过导入上限 ${MAX_IMPORTED_VERSION}`);
  return {
    id: string(row.id, `${label}.id`, { nonempty: true }),
    sortOrder: number(row.sortOrder, `${label}.sortOrder`, 0),
    createdAt: number(row.createdAt, `${label}.createdAt`, now),
    updatedAt: number(row.updatedAt, `${label}.updatedAt`, now),
    version: number(row.version, `${label}.version`, 1, true),
    deviceId: string(row.deviceId, `${label}.deviceId`, { optional: true }),
    deletedAt: null
  };
}
export function validateSnapshot(snapshot, { imported = true } = {}) {
  object(snapshot, 'JSON 顶层必须为对象');
  if (snapshot.schemaVersion !== 1) fail('不支持的 schemaVersion');
  if (!Array.isArray(snapshot.prompts) || !Array.isArray(snapshot.folders)) fail('prompts/folders 必须为数组');
  if (snapshot.prompts.length + snapshot.folders.length > MAX_IMPORT_ROWS) fail('记录过多');
  const now = Date.now();
  const folders = snapshot.folders.map((row, index) => ({
    ...common(row, `folders[${index}]`, now, imported),
    name: string(row.name, `folders[${index}].name`, { nonempty: true }).trim(),
    parentId: relation(row.parentId, 'parentId')
  }));
  const prompts = snapshot.prompts.map((row, index) => {
    const base = common(row, `prompts[${index}]`, now, imported);
    if (row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== 'string' || tag.length > MAX_TEXT))) fail('tags 必须为字符串数组');
    if (row.favorite !== undefined && typeof row.favorite !== 'boolean') fail('favorite 必须为布尔值');
    return {
      ...base,
      title: string(row.title, 'title', { nonempty: true }).trim(),
      content: string(row.content, 'content', { nonempty: true }),
      description: string(row.description, 'description', { optional: true }),
      folderId: relation(row.folderId, 'folderId'), tags: row.tags ? [...row.tags] : [], favorite: row.favorite || false,
      lastUsedAt: row.lastUsedAt == null ? null : number(row.lastUsedAt, 'lastUsedAt', null),
      useCount: number(row.useCount, 'useCount', 0, true)
    };
  });
  for (const [label, rows] of [['folders', folders], ['prompts', prompts]]) {
    if (new Set(rows.map(row => row.id)).size !== rows.length) fail(`${label} ID 重复`);
  }
  const folderMap = new Map(folders.map(folder => [folder.id, folder]));
  for (const prompt of prompts) if (prompt.folderId && !folderMap.has(prompt.folderId)) fail('提示词引用不存在的文件夹');
  const complete = new Set();
  for (const folder of folders) {
    const path = new Set();
    let id = folder.id;
    while (id && !complete.has(id)) {
      if (!folderMap.has(id) || path.has(id)) fail('文件夹父级缺失或循环');
      path.add(id); id = folderMap.get(id).parentId;
    }
    for (const visited of path) complete.add(visited);
  }
  return { schemaVersion: 1, folders, prompts };
}
export function validateCsvRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS) fail('CSV 行数无效');
  return rows.map((row, index) => {
    object(row, `CSV 行 ${index + 2}`);
    for (const key of ['title', 'content']) string(row[key], `CSV 行 ${index + 2} ${key}`, { nonempty: true });
    for (const key of ['description', 'tags', 'folder', 'favorite']) string(row[key], `CSV 行 ${index + 2} ${key}`, { optional: true });
    const favorite = (row.favorite || '').trim().toLowerCase();
    if (!['', 'true', 'false'].includes(favorite)) fail(`CSV 行 ${index + 2} favorite 必须为 true/false`);
    return { ...row, favorite: favorite === 'true' };
  });
}
