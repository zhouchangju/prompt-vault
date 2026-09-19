import { bindCloudProject, cloudDetails, prepareUpload, acceptUpload, applyCloudEvent, finishCloudPull } from './sync-storage.js';
import { validatePull, version } from './sync-model.js';

export const SYNC_CONFIG_KEY = 'cloudConnection';
const LOCK = 'prompt-vault-cloud';
let active;
export function normalizeConnection(input) {
  let url;
  try { url = new URL(input.url.trim()); } catch { throw new Error('请填写有效的 Supabase Project URL'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写 https://项目标识.supabase.co，不含路径或参数');
  const key = input.key?.trim();
  let publicKey = typeof key === 'string' && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publicKey && typeof key === 'string' && key.split('.').length === 3) {
    try {
      const segment = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      publicKey = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '='))).role === 'anon';
    } catch { publicKey = false; }
  }
  if (!publicKey || key.length > 4096) throw new Error('仅接受 publishable key 或 legacy anon key，不接受 secret/service_role');
  return { url: url.origin, key, autoPull: input.autoPull !== false };
}
export async function getConnection() {
  const stored = (await chrome.storage.local.get(SYNC_CONFIG_KEY))[SYNC_CONFIG_KEY];
  return stored ? normalizeConnection(stored) : null;
}
export async function exclusive(action) {
  if (!navigator.locks) throw new Error('浏览器不支持同步并发锁，请升级 Chrome');
  return navigator.locks.request(LOCK, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('其他页面正在同步或修改配置，请稍后再试');
    return action();
  });
}
export async function saveConnection(input) {
  const next = normalizeConnection(input);
  // Invoke request BEFORE any await to preserve the click/submit user gesture.
  const permitted = await chrome.permissions.request({ origins: [`${next.url}/*`] });
  if (!permitted) throw new Error('未授予项目域名访问权限，配置未保存');
  return exclusive(async () => {
    const old = await getConnection();
    await bindCloudProject(next.url);
    await chrome.storage.local.set({ [SYNC_CONFIG_KEY]: next });
    if (old && old.url !== next.url) await chrome.permissions.remove({ origins: [`${old.url}/*`] });
    return next;
  });
}
export async function removeConnection() {
  return exclusive(async () => {
    const old = await getConnection();
    await chrome.storage.local.remove(SYNC_CONFIG_KEY);
    if (old) await chrome.permissions.remove({ origins: [`${old.url}/*`] });
  });
}
export function cancelSync() { active?.abort(); }

// No SDK/session/automatic refresh; credentials go only to the configured origin.
export async function rpc(config, method, body, signal, fetcher = fetch) {
  if (!['pv_sync_status','pv_sync_pull','pv_sync_push'].includes(method)) throw new Error('无效同步接口');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
    const response = await fetcher(`${config.url}/rest/v1/rpc/${method}`, {
      method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
    });
    if (!response.ok) {
      const messages = { 401: '连接密钥无效，请检查设置', 403: '云端权限不足，请检查 SQL 安装版本', 404: '找不到同步接口，请确认已执行初始化 SQL', 429: '云端请求受限，请稍后手动重试' };
      throw new Error(messages[response.status] || `云端拒绝本次请求（HTTP ${response.status}），本地数据和未确认上传已保留`);
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0, text = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 22 * 1024 * 1024) throw new Error('云端响应过大，本轮已停止');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(text); } catch { throw new Error('云端返回了无效 JSON'); }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('同步已取消或请求超时，本地数据已保留');
    if (error instanceof TypeError) throw new Error('无法连接云端，请检查网络；不会自动重试');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
async function connect(config, signal) {
  if (!await chrome.permissions.contains({ origins: [`${config.url}/*`] })) throw new Error('项目访问权限已撤销，请重新保存连接配置');
  const result = await rpc(config, 'pv_sync_status', {}, signal);
  if (result?.protocolVersion !== 1 || result.schemaVersion !== 3 || result.deploymentMode !== 'personal-project-key') throw new Error('云端协议不匹配，请使用 schema v3 初始化 SQL');
  version(result.cursor); return result;
}
export async function testConnection() {
  return exclusive(async () => {
    const config = await getConnection(); if (!config) throw new Error('请先保存连接配置');
    return connect(config);
  });
}
export async function runSync({ upload = false } = {}) {
  return exclusive(async () => {
    const config = await getConnection();
    if (!config || (!upload && !config.autoPull)) return { skipped: true };
    active = new AbortController(); const controller = active;
    const deadline = setTimeout(() => controller.abort(), 45000);
    let requests = 0, uploaded = 0;
    try {
      const status = await connect(config, controller.signal);
      const token = await bindCloudProject(config.url);
      if (version(token.cursor) > version(status.cursor)) throw new Error('云端历史可能已重置，请先备份并检查项目，不会自动覆盖云端');
      const send = async pending => {
        if (pending.acked) return;
        const response = await rpc(config, 'pv_sync_push', { p_request: pending.request }, controller.signal);
        await acceptUpload(token, pending.request.opId, response); requests++;
        if (response.status === 'applied') uploaded += pending.request.changes.length;
      };
      if (upload && token.pending && !token.conflict) await send(token.pending);
      const pull = async () => {
        let until = null;
        do {
          controller.signal.throwIfAborted();
          const before = await cloudDetails();
          const reply = validatePull(await rpc(config, 'pv_sync_pull', { p_cursor: before.cursor, p_limit: 10, p_until: until }, controller.signal), before.cursor, until);
          requests++; until = reply.highWater;
          for (const event of reply.events) {
            controller.signal.throwIfAborted();
            if (!await applyCloudEvent(token, event)) return false;
          }
          if (!reply.hasMore) { await finishCloudPull(token); return true; }
        } while (requests < 20);
        return false;
      };
      let caughtUp = await pull();
      if (upload) while (caughtUp && requests < 18) {
        controller.signal.throwIfAborted();
        const pending = await prepareUpload(token);
        if (!pending) break;
        if (pending.acked) throw new Error('上传已确认但尚未拉取到对应事件，请稍后继续同步');
        await send(pending);
        caughtUp = await pull();
      }
      return { ...(await cloudDetails()), uploaded, caughtUp };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('本轮同步已停止，未完成项将在下次主动同步时继续');
      throw error;
    } finally { clearTimeout(deadline); if (active === controller) active = null; }
  });
}
export async function resolveCloudConflict(choice, revision) {
  if (!['local','cloud'].includes(choice)) throw new Error('无效冲突处理方式');
  return exclusive(async () => {
    const detail = await cloudDetails();
    if (!detail.conflict) throw new Error('冲突已被其他页面处理');
    await applyCloudEvent(detail, detail.conflict.event, { choice, revision });
  });
}
export function installSyncLifecycle() {
  window.addEventListener('pagehide', cancelSync);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelSync(); });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[SYNC_CONFIG_KEY]) cancelSync(); });
}
