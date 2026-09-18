import { touchPromptUsage } from '../db.js';

// Clipboard success is independent of optional local usage bookkeeping.
export async function copyAndRefresh(content, id, refresh) {
  await navigator.clipboard.writeText(content);
  let warning = '';
  try { await touchPromptUsage(id); }
  catch { warning = '已复制，但使用记录更新失败'; }
  try { await refresh(); }
  catch { warning ||= '已复制，但列表刷新失败'; }
  return warning;
}
