import { openDialog, closeDialog } from './dialog.js';
import { getCommandBindings } from '../core/commands.js';

export const SHORTCUTS = Object.freeze([
  { keys: '⌘ / Ctrl + K', description: '搜索提示词' },
  { keys: '↓ / ↑', description: '从搜索框进入结果，或在卡片间移动' },
  { keys: 'Enter / 空格', description: '使用当前卡片；有变量时先填写' },
  { keys: '⌘ / Ctrl + Enter', description: '提交当前打开的编辑或变量表单' },
  { keys: 'Esc', description: '关闭最上层弹窗；无弹窗时清空搜索或返回搜索框' },
  { keys: 'Alt + N', description: '新建提示词（输入时不触发）' }
].map(Object.freeze));
const interactive = 'button,a,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[role="button"]';
export function isEditable(target) {
  return Boolean(target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
}
export function shouldUseCard(event, card) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const control = event.target?.closest?.(interactive);
  if (control && control !== card) return false;
  const selection = card.ownerDocument?.getSelection?.();
  return !selection || selection.isCollapsed;
}
export function prepareCard(card, prompt, { variable = false } = {}) {
  card.tabIndex = 0;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `${prompt.title || '未命名提示词'}，${variable ? '填写变量并复制' : '复制提示词'}；按 Enter 或空格使用`);
}
function visible(element) {
  return Boolean(element && element.getClientRects().length && !element.closest('.hidden,[hidden],[inert]'));
}
function activeModal(document) {
  return [...document.querySelectorAll('[role="dialog"]')].some(visible);
}
export function bindShortcuts({ search, getCards, onUse, onNew, formIds = [], onError = console.error, onSearchFlush }) {
  const document = search.ownerDocument;
  const listener = event => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const command = event.metaKey || event.ctrlKey;
    const modal = activeModal(document);
    const run = fn => Promise.resolve().then(fn).catch(onError);
    if (command && !event.altKey && !event.shiftKey && event.key === 'Enter') {
      const forms = formIds.map(id => document.getElementById(id)).filter(visible);
      const form = forms.find(item => item.contains(document.activeElement)) || (modal ? forms.at(-1) : null);
      if (form && (modal || form.contains(document.activeElement))) { event.preventDefault(); form.requestSubmit(); }
      return;
    }
    if (modal) return;
    if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault(); search.focus(); search.select(); return;
    }
    if (event.altKey && !command && !event.shiftKey && event.code === 'KeyN' && !isEditable(event.target)) {
      event.preventDefault(); run(onNew); return;
    }
    if (command || event.altKey || event.shiftKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (search.value) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); }
      search.focus(); return;
    }
    if (event.key === 'ArrowDown' && event.target === search) {
      event.preventDefault(); run(async () => { await onSearchFlush?.(); getCards().find(visible)?.focus(); }); return;
    }
    const cards = getCards().filter(visible);
    const index = cards.indexOf(event.target);
    if (index < 0) return; // Child buttons retain their own keyboard behavior.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.key === 'ArrowUp' && index === 0) search.focus();
      else cards[Math.min(cards.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); run(() => onUse(event.target));
    }
  };
  document.addEventListener('keydown', listener);
  return () => document.removeEventListener('keydown', listener);
}
export function installShortcutsHelp(button) {
  const document = button.ownerDocument;
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop hidden';
  const card = document.createElement('section'); card.className = 'modal variable-card';
  card.style.cssText = 'width:100%;max-width:520px;max-height:85vh;overflow:auto;padding:24px;gap:16px';
  const heading = document.createElement('h2'); heading.textContent = '快捷键';
  const browserHeading = document.createElement('h3'); browserHeading.textContent = '浏览器中 · 当前实际绑定';
  const bindings = document.createElement('div'); bindings.dataset.commandBindings = '';
  bindings.setAttribute('role', 'status');
  const commandStatus = document.createElement('p'); commandStatus.dataset.commandStatus = '';
  commandStatus.setAttribute('role', 'status');
  const refresh = async () => {
    bindings.textContent = '正在读取 Chrome 的快捷键分配…';
    try {
      const rows = await getCommandBindings();
      bindings.replaceChildren(...rows.map(row => {
        const line = document.createElement('p'); line.dataset.command = row.name;
        line.textContent = `${row.label}：${row.shortcut || '未分配（可能冲突或已清除）'}`;
        return line;
      }));
      try {
        const stored = await chrome.storage.session.get('lastCommand:open-panel');
        const last = stored['lastCommand:open-panel'];
        commandStatus.textContent = last
          ? `最近一次侧边栏快捷键：${new Date(last.at).toLocaleTimeString()} ${last.status === 'success' ? '已收到并执行成功' : `已收到，但执行失败：${last.message}`}`
          : '本次浏览器会话尚未收到侧边栏快捷键事件。';
      } catch { commandStatus.textContent = '无法读取快捷键执行记录。'; }
    } catch { bindings.textContent = '无法读取快捷键分配，请到 Chrome 快捷键设置检查。'; }
  };
  const configure = document.createElement('button'); configure.type = 'button'; configure.textContent = '打开 Chrome 快捷键设置'; configure.style.minHeight = '40px';
  configure.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => { bindings.textContent = '请在地址栏手动打开 chrome://extensions/shortcuts'; });
  });
  const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.textContent = '刷新检测'; refreshButton.style.minHeight = '40px'; refreshButton.addEventListener('click', refresh);
  const note = document.createElement('p'); note.textContent = '浏览器级按键只在 Chrome 内生效。修改后可返回刷新检测；下面这些按键只在插件页面内生效。';
  const localHeading = document.createElement('h3'); localHeading.textContent = '插件页面内';
  const list = document.createElement('dl'); list.style.cssText = 'display:grid;grid-template-columns:1fr;gap:6px;margin:0';
  for (const { keys, description } of SHORTCUTS) {
    const term = document.createElement('dt'); term.textContent = keys; term.style.fontWeight = '700';
    const detail = document.createElement('dd'); detail.textContent = description; detail.style.cssText = 'margin:0 0 10px;color:var(--muted)';
    list.append(term, detail);
  }
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
  close.className = 'secondary-button'; close.style.minHeight = '40px';
  close.addEventListener('click', () => closeDialog(backdrop));
  card.append(heading, browserHeading, bindings, commandStatus, configure, refreshButton, note, localHeading, list, close); backdrop.append(card); document.body.append(backdrop);
  const open = () => { openDialog(backdrop); void refresh(); };
  button.addEventListener('click', open);
  return () => { closeDialog(backdrop); backdrop.remove(); button.removeEventListener('click', open); };
}
