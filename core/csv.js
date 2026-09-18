function csvEscape(value, raw) {
  let text = String(value ?? '');
  if (!raw && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function snapshotToCsv(snapshot, folderMap, { raw = false } = {}) {
  const headers = ['title', 'content', 'description', 'tags', 'folder', 'favorite'];
  const rows = snapshot.prompts.map(p => [p.title, p.content, p.description || '',
    (p.tags || []).join(','), folderMap.get(p.folderId)?.name || '', p.favorite ? 'true' : 'false']);
  return [headers, ...rows].map(row => row.map(v => csvEscape(v, raw)).join(',')).join('\r\n');
}

export function parseCsv(text) {
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  if (!input) return [];
  const rows = []; let row = []; let field = ''; let state = 'start';
  const endField = () => { row.push(field); field = ''; state = 'start'; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (state === 'quoted') {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += c;
    } else if (c === ',') endField();
    else if (c === '\r' || c === '\n') {
      endRow(); if (c === '\r' && input[i + 1] === '\n') i++;
    } else if (state === 'closed') throw new Error('CSV 引号结束后只能是分隔符或换行');
    else if (c === '"') {
      if (state !== 'start') throw new Error('CSV 字段中的引号必须转义');
      state = 'quoted';
    } else { field += c; state = 'plain'; }
  }
  if (state === 'quoted') throw new Error('CSV 存在未闭合引号');
  if (state !== 'start' || row.length || field) endRow();
  const headers = rows.shift().map(h => h.trim().toLowerCase());
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error('CSV 列名为空或重复');
  if (!headers.includes('title') || !headers.includes('content')) throw new Error('CSV 必须包含 title 和 content 列');
  return rows.filter(r => r.some(v => v.trim())).map(r => {
    if (r.length !== headers.length) throw new Error('CSV 行的列数与表头不一致');
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}
