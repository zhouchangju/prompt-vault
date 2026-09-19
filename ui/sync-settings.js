import { getConnection, saveConnection, removeConnection, testConnection, runSync, resolveCloudConflict, installSyncLifecycle } from '../core/sync.js';
import { cloudDetails, cloudBackup } from '../core/sync-storage.js';
import { subscribeToChanges } from '../db.js';
import { downloadText } from '../shared.js';

const el = id => document.getElementById(id);
let busy = false, previewRevision = null, generation = 0;
function message(text) { el('cloudStatus').textContent = text; el('syncStatus').textContent = text; }
async function refresh() {
  const current = ++generation;
  const [config, detail] = await Promise.all([getConnection(), cloudDetails()]);
  if (current !== generation) return;
  if (!busy) message(!config ? '云同步未配置' : detail.conflict ? `存在 ${detail.conflict.conflicts.length} 项冲突，请在设置中处理` :
    `待同步 ${detail.pendingCount} 项${detail.pending ? ' · 有上传等待确认' : ''} · ${detail.lastPullAt ? `上次拉取 ${new Date(detail.lastPullAt).toLocaleString()}` : '尚未拉取'}`);
  el('syncQueueCount').textContent = `${detail.pendingCount} 项本地修改；点击立即同步才上传`;
  const container = el('syncConflicts'); container.replaceChildren();
  el('syncConflictActions').hidden = !detail.conflict;
  previewRevision = detail.revision;
  if (detail.conflict) {
    const heading = document.createElement('h3'); heading.textContent = `待处理冲突（${detail.conflict.conflicts.length} 项）`; container.append(heading);
    for (const item of detail.conflict.conflicts.slice(0, 10)) {
      const box = document.createElement('details'); const summary = document.createElement('summary');
      summary.textContent = item.local.title || item.local.name || item.remote.id;
      const text = document.createElement('pre');
      text.textContent = `本地${item.local.deletedAt ? '（已删除）' : ''}：\n${JSON.stringify(item.local, null, 2).slice(0, 5000)}\n\n云端${item.remote.deletedAt ? '（已删除）' : ''}：\n${JSON.stringify(item.remote.data, null, 2).slice(0, 5000)}`;
      box.append(summary, text); container.append(box);
    }
    const note = document.createElement('p'); note.textContent = '选择将处理本次整组冲突；预览最多前 10 项、每版前 5000 字。处理前自动保留完整本地备份。'; container.append(note);
  }
  const previous = el('syncBackupSelect').value;
  el('syncBackupSelect').replaceChildren(...detail.backups.sort((a,b) => b.at-a.at).map(x => new Option(new Date(x.at).toLocaleString(), x.key)));
  if (detail.backups.some(x => x.key === previous)) el('syncBackupSelect').value = previous;
}
export async function loadSyncSettings() {
  const config = await getConnection();
  el('supabaseUrl').value = config?.url || ''; el('supabaseKey').value = config?.key || '';
  el('supabaseKey').type = 'password'; el('showSupabaseKey').checked = false;
  el('autoPullOnOpen').checked = config?.autoPull ?? true;
  await refresh();
}
async function perform(task, success) {
  if (busy) return;
  busy = true; message('正在处理…本地功能可正常使用');
  const controls = [...document.querySelectorAll('[data-sync-control]')]; controls.forEach(x => { x.disabled = true; });
  try {
    const result = await task(); // Invoke before await: keep permission user gesture.
    busy = false; await refresh();
    if (success) message(typeof success === 'function' ? success(result) : success);
  } catch (error) {
    busy = false; await refresh().catch(() => {}); message(error.message);
  } finally { busy = false; controls.forEach(x => { x.disabled = false; }); }
}
const summary = result => result.skipped ? '尚未配置云同步' : result.conflict ? '同步已暂停，请在设置 → 云同步中处理冲突' :
  result.pendingCount || !result.caughtUp ? `本轮已结束，仍有待同步内容；点击立即同步继续（本地修改 ${result.pendingCount} 项）` : '本轮同步完成';
export function initializeSyncManager({ showSettings }) {
  installSyncLifecycle();
  el('syncConnectionForm').addEventListener('submit', event => {
    event.preventDefault();
    void perform(() => saveConnection({ url: el('supabaseUrl').value, key: el('supabaseKey').value, autoPull: el('autoPullOnOpen').checked }), '连接已保存在本机，点击立即同步开始');
  });
  el('showSupabaseKey').addEventListener('change', event => { el('supabaseKey').type = event.target.checked ? 'text' : 'password'; });
  el('testSyncConnection').addEventListener('click', () => { void perform(testConnection, '连接成功，云端 schema v3 就绪；未上传数据'); });
  el('removeSyncConnection').addEventListener('click', () => {
    if (confirm('移除本机连接配置？提示词和待同步内容会保留，后续不再发送云请求。')) void perform(async () => { await removeConnection(); await loadSyncSettings(); }, '连接配置已移除，本地数据已保留');
  });
  el('syncNow').addEventListener('click', () => {
    void perform(async () => {
      if (!await getConnection()) { await showSettings(); return { skipped: true }; }
      return runSync({ upload: true });
    }, summary);
  });
  for (const [id, choice] of [['resolveSyncLocal','local'],['resolveSyncCloud','cloud']]) el(id).addEventListener('click', () => {
    const revision = previewRevision;
    void perform(() => resolveCloudConflict(choice, revision), '冲突已处理并保留本地备份；点击立即同步继续');
  });
  el('exportSyncBackup').addEventListener('click', () => { void perform(async () => {
    const data = await cloudBackup(el('syncBackupSelect').value);
    if (!data) throw new Error('未找到备份');
    downloadText(`prompt-vault-conflict-backup-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json');
  }, '冲突处理前的本地备份已导出'); });
  subscribeToChanges(() => { void refresh().catch(() => {}); });
  void refresh().catch(error => message(error.message));
  requestAnimationFrame(() => { void perform(() => runSync(), result => result.skipped ? '云同步未配置或已关闭打开时拉取' : result.conflict ? '存在同步冲突，请在设置中处理' : `本次增量拉取已结束 · 待上传 ${result.pendingCount} 项`); });
}
