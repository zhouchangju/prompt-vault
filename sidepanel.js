import { sortFolders, createPanelOrder } from './core/order.js';
import { createFolderHandle, bindFolderReorder } from './ui/folder-drag.js';
import { openDialog, closeDialog } from './ui/dialog.js';
import { renderVariableFields, readVariableValues } from './ui/variables.js';
import { bindShortcuts, shouldUseCard, installShortcutsHelp } from './ui/interactions.js';
import { openManagerFromPanel } from './ui/navigation.js';
import { listPrompts, listFolders, reorderFolders, savePrompt, subscribeToChanges } from './db.js';
import { copyAndRefresh } from './ui/copy.js';
import { runSync, installSyncLifecycle } from './core/sync.js';
import { normalizeText, extractVariables, resolveTemplate, getSettings, applyTheme, watchSettings } from './shared.js';

const PAGE_SIZE = 60;
const sessionOrder = createPanelOrder();
const state = { prompts: [], folders: [], query: '', filter: 'all', folderId: '', variablePrompt: null, visibleCount: PAGE_SIZE };
const pending = new Set();
const el = id => document.getElementById(id);

async function init() {
  applyTheme((await getSettings()).theme);
  watchSettings(settings => applyTheme(settings.theme));
  subscribeToChanges(() => reloadData().catch(reportError));
  on(window, 'focus', reloadData);
  bind();
  await reloadData();
  installSyncLifecycle();
  requestAnimationFrame(() => {
    void runSync().then(result => {
      if (!result.skipped) el('panelSyncStatus').textContent = result.conflict ? '存在同步冲突，请打开管理页处理' : '本次云端拉取已结束';
    }).catch(error => { el('panelSyncStatus').textContent = error.message; });
  });
}

let reloadRevision = 0;
async function reloadData() {
  const revision = ++reloadRevision;
  const [prompts, folders] = await Promise.all([listPrompts(), listFolders()]);
  if (revision !== reloadRevision) return;
  state.prompts = prompts; state.folders = folders;
  state.prompts = sessionOrder.sort(state.prompts);
  if (state.folderId && !folders.some(folder => folder.id === state.folderId)) state.folderId = '';
  renderFolders(); render();
}

function bind() {
  bindFolderReorder(el('panelFolderNav'), { getFolders: () => sortFolders(state.folders), save: reorderFolders, onError: reportError, onSuccess: async () => { await reloadData(); toast('文件夹顺序已保存'); } });
  on(el('panelSearch'), 'input', event => { state.query = event.target.value; state.visibleCount = PAGE_SIZE; render(); });
  on(el('panelClearSearch'), 'click', () => { state.query = ''; el('panelSearch').value = ''; state.visibleCount = PAGE_SIZE; render(); el('panelSearch').focus(); });
  on(el('panelFolderNav'), 'click', event => {
    const button = event.target.closest('.folder-nav-button');
    if (!button) return;
    state.folderId = button.dataset.folderId || '';
    state.filter = button.dataset.filter || 'all';
    state.visibleCount = PAGE_SIZE;
    renderFolders(); render();
    el('panelResults').scrollTop = 0;
  });
  on(el('openManager'), 'click', () => navigate());
  on(el('panelNewPrompt'), 'click', () => navigate(true));
  on(el('panelLoadMore'), 'click', () => { state.visibleCount += PAGE_SIZE; render(); });
  on(el('panelList'), 'click', async event => {
    const card = event.target.closest('[data-prompt-id]');
    if (!card) return;
    const prompt = state.prompts.find(row => row.id === card.dataset.promptId);
    if (!prompt) return;
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'favorite') {
      event.stopPropagation();
      await guarded(`favorite:${prompt.id}`, async () => {
        try { await savePrompt({ ...prompt, favorite: !prompt.favorite }, { expectedVersion: prompt.version }); }
        finally { await reloadData(); }
      });
    } else if (action === 'copy' || shouldUseCard(event, card)) await usePrompt(prompt);
  });
  on(el('closePanelVariable'), 'click', closeVariable);
  on(el('panelVariableBackdrop'), 'dialog-dismiss', closeVariable);
  on(el('panelVariableForm'), 'submit', async event => {
    event.preventDefault();
    await guarded('variable-submit', handleVariableSubmit);
  });
  installShortcutsHelp(el('panelShortcutsHelp'));
  bindShortcuts({
    search: el('panelSearch'), getCards: () => [...el('panelList').querySelectorAll('[data-prompt-id]')],
    onUse: card => { const prompt = state.prompts.find(row => row.id === card.dataset.promptId); if (prompt) return usePrompt(prompt); },
    onNew: () => navigate(true), formIds: ['panelVariableForm'], onError: reportError
  });
}

function renderFolders() {
  const counts = new Map();
  for (const prompt of state.prompts) counts.set(prompt.folderId, (counts.get(prompt.folderId) || 0) + 1);
  const entries = [
    { key: 'all', label: '全部', count: state.prompts.length, filter: 'all' },
    { key: 'favorite', label: '收藏', count: state.prompts.filter(row => row.favorite).length, filter: 'favorite' },
    { key: 'unfiled', label: '未分类', count: state.prompts.filter(row => !row.folderId).length, filter: 'unfiled' },
    ...sortFolders(state.folders).map(folder => ({ key: `folder:${folder.id}`, label: folder.name, count: counts.get(folder.id) || 0, folderId: folder.id }))
  ];
  const nav = el('panelFolderNav');
  const old = new Map([...nav.children].map(node => [node.dataset.navKey, node]));
  const active = state.folderId ? `folder:${state.folderId}` : state.filter;
  for (const [index, entry] of entries.entries()) {
    let row = old.get(entry.key);
    if (!row) {
      row = document.createElement('div'); row.className = 'folder-nav-row'; row.dataset.navKey = entry.key;
      const button = document.createElement('button'); button.className = 'folder-nav-button';
      button.append(document.createElement('span'), document.createElement('small')); row.append(button);
      if (entry.folderId) row.append(createFolderHandle(state.folders.find(folder => folder.id === entry.folderId)));
    }
    row.dataset.folderId = entry.folderId || '';
    const button = row.querySelector('.folder-nav-button');
    button.dataset.navKey = entry.key; button.dataset.folderId = entry.folderId || ''; button.dataset.filter = entry.filter || 'all';
    text(button.firstChild, entry.label); text(button.lastChild, entry.count);
    button.setAttribute('aria-label', `${entry.label}，${entry.count} 个提示`);
    button.setAttribute('aria-pressed', String(active === entry.key)); button.title = entry.label;
    if (nav.children[index] !== row) nav.insertBefore(row, nav.children[index] || null);
    old.delete(entry.key);
  }
  old.forEach(node => node.remove());
}

function text(node, value) { if (node.textContent !== String(value)) node.textContent = value; }
function render() {
  const q = normalizeText(state.query);
  const folderMap = new Map(state.folders.map(folder => [folder.id, folder]));
  const all = state.prompts.filter(prompt => {
    if (state.folderId && prompt.folderId !== state.folderId) return false;
    if (!state.folderId && state.filter === 'favorite' && !prompt.favorite) return false;
    if (!state.folderId && state.filter === 'unfiled' && prompt.folderId) return false;
    return !q || [prompt.title, prompt.content, prompt.description, ...(prompt.tags || []), folderMap.get(prompt.folderId)?.name || ''].join('\n').toLocaleLowerCase().includes(q);
  });
  const rows = all.slice(0, state.visibleCount);
  text(el('panelResultCount'), `显示 ${rows.length} / ${all.length} 个提示`);
  el('panelLoadMore').classList.toggle('hidden', state.visibleCount >= all.length);
  el('panelClearSearch').classList.toggle('hidden', !state.query);
  const list = el('panelList');
  const selection = window.getSelection();
  const range = selection?.rangeCount && !selection.isCollapsed && list.contains(selection.anchorNode) ? selection.getRangeAt(0) : null;
  const selectedRange = range ? { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset } : null;
  const focused = document.activeElement;
  const focusedCard = focused.closest('[data-prompt-id]');
  const focusId = focusedCard?.dataset.promptId;
  const focusAction = focused.dataset.action;
  const old = new Map([...list.children].map(node => [node.dataset.promptId, node]));
  for (const [index, prompt] of rows.entries()) {
    const card = old.get(prompt.id) || createCard(prompt.id);
    card.setAttribute('aria-label', `使用 ${prompt.title}`);
    text(card.querySelector('.item-title'), prompt.title);
    const favorite = card.querySelector('.item-fav');
    text(favorite, prompt.favorite ? '★' : '☆');
    favorite.setAttribute('aria-label', `${prompt.favorite ? '取消收藏' : '收藏'} ${prompt.title}`);
    favorite.setAttribute('aria-pressed', String(Boolean(prompt.favorite)));
    favorite.disabled = pending.has(`favorite:${prompt.id}`);
    text(card.querySelector('.item-preview'), prompt.content.slice(0, 400));
    text(card.querySelector('.item-meta'), folderMap.get(prompt.folderId)?.name || '未分类');
    const copy = card.querySelector('.item-copy');
    text(copy, extractVariables(prompt.content).length ? '填写并复制' : '复制');
    copy.setAttribute('aria-label', `复制 ${prompt.title}`);
    copy.disabled = pending.has(`copy:${prompt.id}`);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    old.delete(prompt.id);
  }
  old.forEach(node => node.remove());
  if (selectedRange && list.contains(selectedRange.start) && list.contains(selectedRange.end)) {
    const restored = document.createRange();
    restored.setStart(selectedRange.start, selectedRange.startOffset); restored.setEnd(selectedRange.end, selectedRange.endOffset);
    selection.removeAllRanges(); selection.addRange(restored);
  }
  if (focusId && (!focused.isConnected || document.activeElement !== focused) && !document.querySelector('.modal-backdrop:not(.hidden)')) {
    const card = [...list.children].find(node => node.dataset.promptId === focusId) || list.firstElementChild;
    (focusAction ? card?.querySelector(`[data-action="${focusAction}"]`) : card)?.focus({ preventScroll: true });
  }
  el('panelEmpty').classList.toggle('hidden', all.length !== 0);
}

function createCard(id) {
  const card = document.createElement('article');
  card.className = 'panel-item'; card.dataset.promptId = id; card.tabIndex = 0; card.setAttribute('role', 'group');
  const head = document.createElement('div'); head.className = 'item-head';
  const title = document.createElement('div'); title.className = 'item-title';
  const favorite = document.createElement('button'); favorite.className = 'item-fav'; favorite.dataset.action = 'favorite';
  head.append(title, favorite);
  const preview = document.createElement('div'); preview.className = 'item-preview';
  const footer = document.createElement('div'); footer.className = 'item-footer';
  const meta = document.createElement('div'); meta.className = 'item-meta';
  const copy = document.createElement('button'); copy.className = 'item-copy'; copy.dataset.action = 'copy';
  footer.append(meta, copy); card.append(head, preview, footer); return card;
}

async function navigate(newPrompt = false) {
  if (pending.has('navigation')) return;
  pending.add('navigation');
  el('openManager').disabled = true; el('panelNewPrompt').disabled = true;
  try { await openManagerFromPanel({ newPrompt }); }
  finally { pending.delete('navigation'); el('openManager').disabled = false; el('panelNewPrompt').disabled = false; }
}
async function guarded(key, action) {
  if (pending.has(key)) return;
  const previousFocus = document.activeElement;
  const previousCardId = previousFocus.closest('[data-prompt-id]')?.dataset.promptId;
  const previousAction = previousFocus.dataset.action;
  pending.add(key);
  if (key === 'variable-submit') el('panelVariableSubmit').disabled = true;
  else render();
  try { await action(); }
  finally {
    pending.delete(key);
    if (key === 'variable-submit') el('panelVariableSubmit').disabled = false;
    else render();
    if (previousCardId && document.activeElement === document.body && !document.querySelector('.modal-backdrop:not(.hidden)')) {
      const card = [...el('panelList').children].find(node => node.dataset.promptId === previousCardId) || el('panelList').firstElementChild;
      (previousAction ? card?.querySelector(`[data-action="${previousAction}"]`) : card)?.focus({ preventScroll: true });
    }
  }
}
async function usePrompt(prompt) { await guarded(`copy:${prompt.id}`, () => copyPrompt(prompt)); }
async function copyPrompt(prompt) {
  const variables = extractVariables(prompt.content);
  if (!variables.length) {
    const warning = await copyAndRefresh(prompt.content, prompt.id, reloadData);
    toast(warning || '已复制'); return;
  }
  if (!el('panelVariableBackdrop').classList.contains('hidden')) return;
  state.variablePrompt = { ...prompt };
  text(el('panelVariableTitle'), prompt.title);
  const form = el('panelVariableForm'); renderVariableFields(form, variables);
  openDialog(el('panelVariableBackdrop'));
  form.querySelector('input,textarea,select')?.focus();
}
async function handleVariableSubmit() {
  const prompt = state.variablePrompt;
  if (!prompt) return;
  const warning = await copyAndRefresh(resolveTemplate(prompt.content, extractVariables(prompt.content), readVariableValues(el('panelVariableForm'))), prompt.id, reloadData);
  closeVariable(); toast(warning || '已生成并复制');
}
function closeVariable() { state.variablePrompt = null; closeDialog(el('panelVariableBackdrop')); }
function reportError(error) { toast(`操作失败：${error.message}`); }
function on(target, type, handler) {
  target.addEventListener(type, event => { try { Promise.resolve(handler(event)).catch(reportError); } catch (error) { reportError(error); } });
}
function toast(message) {
  text(el('panelToast'), message); el('panelToast').classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el('panelToast').classList.add('hidden'), 3500);
}
init().catch(reportError);
