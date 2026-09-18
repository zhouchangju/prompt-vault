import { sortFolders } from './core/order.js';
import { createFolderHandle, bindFolderReorder } from './ui/folder-drag.js';
import { openDialog, closeDialog } from './ui/dialog.js';
import { renderVariableFields, readVariableValues } from './ui/variables.js';
import { bindShortcuts, prepareCard, shouldUseCard, installShortcutsHelp } from './ui/interactions.js';
import { copyAndRefresh } from './ui/copy.js';
import {
  listPrompts,
  savePrompt,
  softDeletePrompt,
  listFolders, reorderFolders,
  saveFolder,
  softDeleteFolder,
  getPendingSyncCount,
  exportSnapshot,
  importSnapshot,
  previewSnapshotImport, previewCsvImport, importCsvRows, subscribeToChanges,
  clearAllData
} from './db.js';
import {
  debounce,
  normalizeText,
  formatRelativeTime,
  parseTags,
  extractVariables,
  resolveTemplate,
  downloadText,
  snapshotToCsv,
  parseCsv,
  getSettings,
  saveSettings,
  THEMES, watchSettings,
  applyTheme
} from './shared.js';

const PAGE_SIZE = 60;

const state = {
  prompts: [],
  folders: [],
  filter: 'all',
  folderId: null,
  query: '',
  sort: 'updated',
  visibleCount: PAGE_SIZE,
  settings: null,
  variableActionPromptId: null,
  pendingImportType: null, editPrompt: null, editFolder: null, variablePrompt: null
};

const el = (id) => document.getElementById(id);

async function init() {
  state.settings = await getSettings();
  for (const id of ['themeSelect', 'headerThemeSelect']) {
    el(id).replaceChildren(...THEMES.map(theme => new Option(theme.label, theme.id)));
  }
  applySettingsToDom();
  watchSettings(settings => { state.settings = settings; applySettingsToDom(); renderCards(); });
  subscribeToChanges(() => reloadData().catch(reportError));
  on(window, 'focus', () => reloadData().catch(reportError));
  bindEvents();
  setupInfiniteScroll();
  await reloadData();

  const params = new URLSearchParams(location.search);
  if (params.get('new') === '1') openPromptModal();
}

function applySettingsToDom() {
  applyTheme(state.settings.theme);
  document.documentElement.dataset.density = state.settings.cardDensity;
  document.documentElement.dataset.view = state.settings.viewMode;
  const compact = state.settings.viewMode === 'compact';
  el('viewModeToggle').setAttribute('aria-pressed', String(compact));
  el('viewModeToggle').textContent = compact ? '精简模式 · 切换完整卡片' : '完整卡片 · 切换精简模式';
  el('viewModeToggle').setAttribute('aria-label', el('viewModeToggle').textContent);
  el('headerThemeSelect').value = state.settings.theme;
  el('themeSelect').value = state.settings.theme;
  el('densitySelect').value = state.settings.cardDensity;
}

let reloadRevision = 0;
async function reloadData() {
  const revision = ++reloadRevision;
  const [prompts, folders] = await Promise.all([listPrompts(), listFolders()]);
  if (revision !== reloadRevision) return;
  state.prompts = prompts; state.folders = folders;
  if (state.folderId && !folders.some(folder => folder.id === state.folderId)) state.folderId = null;
  renderAll();
}

function renderAll() {
  renderSidebar();
  if (el('promptModalBackdrop').classList.contains('hidden')) renderFolderSelect();
  renderCards();
  if (el('settingsModalBackdrop').classList.contains('hidden')) renderSettingsFolders();
}

function getFolderMap() {
  return new Map(state.folders.map((folder) => [folder.id, folder]));
}

function renderSidebar() {
  el('allCount').textContent = state.prompts.length;
  el('favoriteCount').textContent = state.prompts.filter((p) => p.favorite).length;
  el('recentCount').textContent = state.prompts.filter((p) => p.lastUsedAt).length;

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.filter && !state.folderId);
  });

  const folderList = el('folderList');
  const previousFocus = document.activeElement;
  const focusFolder = folderList.contains(previousFocus) ? previousFocus.closest('[data-folder-id]')?.dataset.folderId : null;
  const focusKind = previousFocus.matches('[data-drag-folder]') ? 'handle' : previousFocus.matches('[data-edit-folder]') ? 'edit' : 'name';
  folderList.replaceChildren();
  const counts = new Map();
  for (const prompt of state.prompts) {
    if (prompt.folderId) counts.set(prompt.folderId, (counts.get(prompt.folderId) || 0) + 1);
  }

  for (const folder of sortFolders(state.folders)) {
    const button = document.createElement('div');
    button.className = `folder-item ${state.folderId === folder.id ? 'active' : ''}`;
    button.dataset.folderId = folder.id;

    const icon = document.createElement('span');
    icon.className = 'folder-symbol';
    icon.setAttribute('aria-hidden', 'true');

    const name = document.createElement('button');
    name.className = 'folder-name';
    name.dataset.folderId = folder.id;
    name.textContent = folder.name;

    const end = document.createElement('span');
    end.style.display = 'flex';
    end.style.alignItems = 'center';
    end.style.gap = '4px';

    const count = document.createElement('span');
    count.className = 'folder-count';
    count.textContent = counts.get(folder.id) || 0;

    const edit = document.createElement('button');
    edit.className = 'folder-edit';
    edit.setAttribute('aria-label', `编辑文件夹 ${folder.name}`);
    edit.textContent = '✎';
    edit.title = '编辑文件夹';
    edit.dataset.editFolder = folder.id;

    end.append(count, edit);
    button.append(createFolderHandle(folder), icon, name, end);
    folderList.append(button);
  }
  if (focusFolder && document.activeElement === document.body) {
    const row = [...folderList.children].find(node => node.dataset.folderId === focusFolder);
    const selector = focusKind === 'handle' ? '[data-drag-folder]' : focusKind === 'edit' ? '[data-edit-folder]' : '.folder-name';
    row?.querySelector(selector)?.focus({ preventScroll: true });
  }
}

function renderFolderSelect() {
  const select = el('promptFolder');
  const current = select.value;
  select.replaceChildren();
  const empty = new Option('无文件夹', '');
  select.add(empty);
  for (const folder of sortFolders(state.folders)) {
    select.add(new Option(folder.name, folder.id));
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function getFilteredPrompts() {
  const folderMap = getFolderMap();
  let prompts = [...state.prompts];

  if (state.folderId) {
    prompts = prompts.filter((prompt) => prompt.folderId === state.folderId);
  } else if (state.filter === 'favorite') {
    prompts = prompts.filter((prompt) => prompt.favorite);
  } else if (state.filter === 'recent') {
    prompts = prompts.filter((prompt) => prompt.lastUsedAt);
  }

  if (state.query) {
    const q = normalizeText(state.query);
    prompts = prompts.filter((prompt) => {
      const haystack = [
        prompt.title,
        prompt.content,
        prompt.description,
        ...(prompt.tags || []),
        folderMap.get(prompt.folderId)?.name || ''
      ].join('\n').toLocaleLowerCase();
      return haystack.includes(q);
    });
  }

  if (state.sort === 'title') {
    prompts.sort((a, b) => a.title.localeCompare(b.title));
  } else if (state.sort === 'used') {
    prompts.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || b.updatedAt - a.updatedAt);
  } else {
    prompts.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  return prompts;
}

function renderCards(append = false) {
  const focused = document.activeElement.closest?.('#cardsGrid [data-prompt-id]');
  const focusedId = focused?.dataset.promptId;
  const focusedAction = document.activeElement.dataset?.action;
  const all = getFilteredPrompts();
  const prompts = all.slice(append ? el('cardsGrid').childElementCount : 0, state.visibleCount);
  const grid = el('cardsGrid');
  if (!append) grid.replaceChildren();
  const fragment = document.createDocumentFragment();
  const folderMap = getFolderMap();

  for (const prompt of prompts) fragment.append(createPromptCard(prompt, folderMap));
  grid.append(fragment);
  if (!append && focusedId) {
    const replacement = [...grid.children].find(card => card.dataset.promptId === focusedId);
    (focusedAction ? replacement?.querySelector(`[data-action="${focusedAction}"]`) : replacement)?.focus({ preventScroll: true });
  }

  const empty = all.length === 0;
  el('emptyState').classList.toggle('hidden', !empty);
  grid.classList.toggle('hidden', empty);

  const title = state.folderId
    ? (folderMap.get(state.folderId)?.name || '文件夹')
    : state.filter === 'favorite'
      ? '收藏'
      : state.filter === 'recent'
        ? '最近使用'
        : '所有提示';
  el('pageTitle').textContent = title;
  el('pageSubtitle').textContent = state.query ? `找到 ${all.length} 个匹配结果` : `${all.length} 个提示`;
}

function createPromptCard(prompt, folderMap) {
  const article = document.createElement('article');
  article.className = 'prompt-card';
  article.dataset.promptId = prompt.id;
  prepareCard(article, prompt, { variable: extractVariables(prompt.content).length > 0 });

  const head = document.createElement('div');
  head.className = 'card-head';
  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = prompt.title || '未命名提示';

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const favorite = document.createElement('button');
  favorite.className = `card-icon-button favorite ${prompt.favorite ? 'active' : ''}`;
  favorite.dataset.action = 'favorite';
  favorite.title = prompt.favorite ? '取消收藏' : '收藏';
  favorite.textContent = prompt.favorite ? '★' : '☆';
  favorite.setAttribute('aria-pressed', String(prompt.favorite));

  const edit = document.createElement('button');
  edit.className = 'card-icon-button';
  edit.dataset.action = 'edit';
  edit.title = '编辑';
  edit.textContent = '✎';
  const remove = document.createElement('button');
  remove.className = 'card-icon-button'; remove.dataset.action = 'delete';
  remove.title = '删除'; remove.textContent = '×';
  actions.append(favorite, edit, remove);
  for (const button of actions.children) button.setAttribute('aria-label', `${button.title} ${prompt.title}`);
  head.append(title, actions);
  article.append(head);

  if (state.settings.viewMode === 'compact') {
    const copy = document.createElement('button');
    copy.className = 'copy-button'; copy.dataset.action = 'copy'; copy.textContent = extractVariables(prompt.content).length ? '填写' : '复制';
    copy.setAttribute('aria-label', `复制 ${prompt.title}`);
    actions.prepend(copy);
    return article;
  }

  if (prompt.description) {
    const description = document.createElement('p');
    description.className = 'card-description';
    description.textContent = prompt.description.slice(0, 240);
    article.append(description);
  }

  const content = document.createElement('div');
  content.className = 'card-content';
  content.textContent = prompt.content.slice(0, 1200);
  article.append(content);

  if ((prompt.tags || []).length) {
    const tags = document.createElement('div');
    tags.className = 'card-tags';
    prompt.tags.slice(0, 6).forEach((tagText) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tagText;
      tags.append(tag);
    });
    article.append(tags);
  }

  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const folderName = folderMap.get(prompt.folderId)?.name;
  meta.textContent = [folderName, prompt.lastUsedAt ? `使用于 ${formatRelativeTime(prompt.lastUsedAt)}` : null]
    .filter(Boolean)
    .join(' · ') || `更新于 ${formatRelativeTime(prompt.updatedAt)}`;

  const copy = document.createElement('button');
  copy.className = 'copy-button';
  copy.dataset.action = 'copy';
  copy.textContent = extractVariables(prompt.content).length ? '填写并复制' : '复制';
  footer.append(meta, copy);
  article.append(footer);
  return article;
}

function bindEvents() {
  bindFolderReorder(el('folderList'), { getFolders: () => sortFolders(state.folders), save: reorderFolders, onError: reportError, onSuccess: async () => { await reloadData(); toast('文件夹顺序已保存'); } });
  document.querySelectorAll('.nav-item').forEach((button) => {
    on(button, 'click', () => {
      state.filter = button.dataset.filter;
      state.sort = state.filter === 'recent' ? 'used' : 'updated';
      el('sortSelect').value = state.sort;
      state.folderId = null;
      state.visibleCount = PAGE_SIZE;
      renderAll();
    });
  });

  on(el('folderList'), 'click', (event) => {
    const editTarget = event.target.closest('[data-edit-folder]');
    if (editTarget) {
      event.stopPropagation();
      openFolderModal(editTarget.dataset.editFolder);
      return;
    }
    const item = event.target.closest('[data-folder-id]');
    if (!item) return;
    state.folderId = item.dataset.folderId;
    state.filter = 'all';
    state.visibleCount = PAGE_SIZE;
    renderAll();
  });

  const updateSearch = debounce((value) => {
    state.query = value;
    state.visibleCount = PAGE_SIZE;
    renderCards();
  }, 80);
  on(el('searchInput'), 'input', (event) => updateSearch(event.target.value));
  on(el('clearSearch'), 'click', () => {
    el('searchInput').value = ''; el('searchInput').dispatchEvent(new Event('input', { bubbles: true })); el('searchInput').focus();
  });
  installShortcutsHelp(el('shortcutsHelp'));
  bindShortcuts({
    search: el('searchInput'), getCards: () => [...el('cardsGrid').children],
    onUse: card => { const prompt = state.prompts.find(row => row.id === card.dataset.promptId); if (prompt) return copyPrompt(prompt); },
    onNew: () => openPromptModal(), formIds: ['promptForm', 'folderForm', 'variableForm'], onError: reportError,
    onSearchFlush: () => { state.query = el('searchInput').value; state.visibleCount = PAGE_SIZE; renderCards(); }
  });

  on(el('sortSelect'), 'change', (event) => {
    state.sort = event.target.value;
    renderCards();
  });

  ['newPromptButton', 'newPromptSidebar', 'emptyNewPrompt'].forEach((id) => on(el(id), 'click', () => openPromptModal()));
  ['newFolderSidebar', 'quickAddFolder', 'settingsAddFolder'].forEach((id) => on(el(id), 'click', () => openFolderModal()));
  ['openSettings', 'settingsButton'].forEach((id) => on(el(id), 'click', openSettings));

  on(el('cardsGrid'), 'click', async (event) => {
    const card = event.target.closest('[data-prompt-id]');
    if (!card) return;
    const prompt = state.prompts.find((item) => item.id === card.dataset.promptId);
    if (!prompt) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'delete' && confirm('确定删除这个提示吗？')) {
      await softDeletePrompt(prompt.id, { expectedVersion: prompt.version }); await reloadData(); toast('提示已删除');
    }
    if (action === 'edit') openPromptModal(prompt.id);
    if (action === 'favorite') await toggleFavorite(prompt);
    if (action === 'copy' || (!action && shouldUseCard(event, card))) await copyPrompt(prompt);
  });

  onSubmit(el('promptForm'), handlePromptSubmit);
  on(el('promptContent'), 'input', updateVariableHint);
  on(el('deletePromptButton'), 'click', handlePromptDelete);

  onSubmit(el('folderForm'), handleFolderSubmit);
  on(el('deleteFolderButton'), 'click', handleFolderDelete);

  onSubmit(el('variableForm'), handleVariableSubmit);

  document.querySelectorAll('[data-close]').forEach((button) => {
    on(button, 'click', () => closeModal(button.dataset.close));
  });

  document.querySelectorAll('.settings-tab').forEach((button) => {
    on(button, 'click', () => switchSettingsTab(button.dataset.settingsTab));
  });

  on(el('headerThemeSelect'), 'change', async event => { state.settings = await saveSettings({ theme: event.target.value }); applySettingsToDom(); });
  on(el('viewModeToggle'), 'click', async () => {
    const button = el('viewModeToggle'); if (button.disabled) return; button.disabled = true;
    try { state.settings = await saveSettings({ viewMode: state.settings.viewMode === 'compact' ? 'cards' : 'compact' }); applySettingsToDom(); renderCards(); }
    finally { button.disabled = false; }
  });
  on(el('themeSelect'), 'change', async (event) => {
    state.settings = await saveSettings({ theme: event.target.value });
    applySettingsToDom();
  });
  on(el('densitySelect'), 'change', async (event) => {
    state.settings = await saveSettings({ cardDensity: event.target.value });
    applySettingsToDom();
  });

  on(el('settingsFolderList'), 'click', async (event) => {
    const row = event.target.closest('[data-settings-folder-id]');
    if (!row) return;
    const id = row.dataset.settingsFolderId;
    if (event.target.matches('[data-folder-save]')) {
      const input = row.querySelector('input');
      if (!input.value.trim()) return toast('文件夹名称不能为空');
      const saved = await saveFolder({ id, name: input.value.trim() }, { expectedVersion: Number(row.dataset.version) });
      row.dataset.version = saved.version;
      await reloadData();
      toast('文件夹已保存');
    }
    if (event.target.matches('[data-folder-delete]')) {
      if (!confirm('删除这个文件夹？其中的提示词会保留并移动到“无文件夹”。')) return;
      await softDeleteFolder(id, { expectedVersion: Number(row.dataset.version) });
      row.remove();
      if (state.folderId === id) state.folderId = null;
      await reloadData();
      toast('文件夹已删除');
    }
  });

  on(el('exportJson'), 'click', exportJson);
  on(el('exportCsv'), 'click', () => exportCsv());
  on(el('exportRawCsv'), 'click', () => exportCsv(true));
  on(el('importJson'), 'click', () => chooseImport('json'));
  on(el('importCsv'), 'click', () => chooseImport('csv'));
  on(el('fileInput'), 'change', handleImportFile);
  on(el('clearAll'), 'click', handleClearAll);
}

function setupInfiniteScroll() {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    const total = getFilteredPrompts().length;
    if (state.visibleCount < total) {
      state.visibleCount += PAGE_SIZE;
      renderCards(true);
    }
  }, { rootMargin: '500px' });
  observer.observe(el('loadSentinel'));
}

function openPromptModal(promptId = null) {
  const prompt = promptId ? state.prompts.find((item) => item.id === promptId) : null;
  state.editPrompt = prompt ? { ...prompt } : null;
  el('promptModalTitle').textContent = prompt ? '编辑提示' : '新建提示';
  el('promptId').value = prompt?.id || '';
  el('promptTitle').value = prompt?.title || '';
  el('promptContent').value = prompt?.content || '';
  el('promptDescription').value = prompt?.description || '';
  el('promptTags').value = (prompt?.tags || []).join(', ');
  renderFolderSelect();
  el('promptFolder').value = prompt?.folderId || '';
  el('promptFavorite').checked = Boolean(prompt?.favorite);
  el('deletePromptButton').classList.toggle('hidden', !prompt);
  updateVariableHint();
  showModal('prompt');
  el('promptTitle').focus();
}

async function handlePromptSubmit(event) {
  event.preventDefault();
  const id = el('promptId').value || null;
  const existing = state.editPrompt;
  const title = el('promptTitle').value.trim();
  const content = el('promptContent').value;
  if (!title || !content.trim()) return toast('标题和文本不能为空');

  await savePrompt({
    ...(existing || {}),
    id,
    title,
    content,
    description: el('promptDescription').value.trim(),
    tags: parseTags(el('promptTags').value),
    folderId: el('promptFolder').value || null,
    favorite: el('promptFavorite').checked
  }, { expectedVersion: existing?.version });
  closeModal('prompt');
  await reloadData();
  toast(id ? '提示已更新' : '提示已创建');
}

async function handlePromptDelete() {
  const id = el('promptId').value;
  if (!id || !confirm('确定删除这个提示吗？')) return;
  await softDeletePrompt(id, { expectedVersion: state.editPrompt?.version });
  closeModal('prompt');
  await reloadData();
  toast('提示已删除');
}

function updateVariableHint() {
  const variables = extractVariables(el('promptContent').value);
  el('variableHint').textContent = variables.length
    ? `检测到 ${variables.length} 个变量：${variables.map((v) => `{{${v.name}}}`).join('、')}`
    : '未检测到变量。支持 {{name}}、{{tone::list-happy;sad}}、{{count::number-0}}、{{bio::largeText}}。';
}

async function toggleFavorite(prompt) {
  await savePrompt({ ...prompt, favorite: !prompt.favorite });
  await reloadData();
}

let useInProgress = false;
async function copyPrompt(prompt) {
  if (useInProgress) return;
  useInProgress = true;
  try { await usePrompt(prompt); }
  finally { useInProgress = false; }
}

async function usePrompt(prompt) {
  const variables = extractVariables(prompt.content);
  if (!variables.length) {
    const warning = await copyAndRefresh(prompt.content, prompt.id, reloadData);
    toast(warning || '已复制到剪贴板');
    return;
  }

  state.variableActionPromptId = prompt.id;
  state.variablePrompt = { ...prompt };
  el('variablePromptTitle').textContent = prompt.title;
  const form = el('variableForm');
  form.replaceChildren();
  renderVariableFields(form, variables);
  showModal('variable');
  form.querySelector('input, textarea, select')?.focus();
}

async function handleVariableSubmit(event) {
  event.preventDefault();
  const prompt = state.variablePrompt;
  if (!prompt) return closeModal('variable');
  const variables = extractVariables(prompt.content);
  const values = readVariableValues(el('variableForm'));
  const resolved = resolveTemplate(prompt.content, variables, values);
  const warning = await copyAndRefresh(resolved, prompt.id, reloadData);
  closeModal('variable');
  toast(warning || '已生成并复制');
}

function openFolderModal(folderId = null) {
  const folder = folderId ? state.folders.find((item) => item.id === folderId) : null;
  state.editFolder = folder ? { ...folder } : null;
  el('folderModalTitle').textContent = folder ? '编辑文件夹' : '新建文件夹';
  el('folderId').value = folder?.id || '';
  el('folderName').value = folder?.name || '';
  el('deleteFolderButton').classList.toggle('hidden', !folder);
  showModal('folder');
  el('folderName').focus();
}

async function handleFolderSubmit(event) {
  event.preventDefault();
  const id = el('folderId').value || null;
  const name = el('folderName').value.trim();
  if (!name) return toast('文件夹名称不能为空');
  await saveFolder({ id, name }, { expectedVersion: state.editFolder?.version });
  closeModal('folder');
  await reloadData();
  if (!el('settingsModalBackdrop').classList.contains('hidden')) renderSettingsFolders(true);
  toast(id ? '文件夹已更新' : '文件夹已创建');
}

async function handleFolderDelete() {
  const id = el('folderId').value;
  if (!id || !confirm('删除文件夹？其中的提示词不会被删除。')) return;
  await softDeleteFolder(id, { expectedVersion: state.editFolder?.version });
  if (state.folderId === id) state.folderId = null;
  closeModal('folder');
  await reloadData();
  if (!el('settingsModalBackdrop').classList.contains('hidden')) renderSettingsFolders(true);
  toast('文件夹已删除');
}

function renderSettingsFolders(preserveDrafts = false) {
  const container = el('settingsFolderList');
  const existing = new Map(preserveDrafts ? [...container.children].map(row => [row.dataset.settingsFolderId, row]) : []);
  const liveIds = new Set(state.folders.map(folder => folder.id));
  if (!preserveDrafts) container.replaceChildren();
  else for (const [id, row] of existing) if (!liveIds.has(id)) row.remove();
  for (const folder of sortFolders(state.folders)) {
    if (existing.has(folder.id)) continue;
    const row = document.createElement('div');
    row.className = 'settings-folder-row';
    row.dataset.settingsFolderId = folder.id;
    row.dataset.version = folder.version;
    const input = document.createElement('input');
    input.value = folder.name;
    input.setAttribute('aria-label', `文件夹名称 ${folder.name}`);
    const save = document.createElement('button');
    save.className = 'secondary-button';
    save.dataset.folderSave = '1';
    save.textContent = '保存';
    const remove = document.createElement('button');
    remove.className = 'secondary-button';
    remove.dataset.folderDelete = '1';
    remove.textContent = '删除';
    row.append(input, save, remove);
    container.append(row);
  }
}

async function openSettings() {
  const count = await getPendingSyncCount();
  el('syncQueueCount').textContent = `${count} 个待同步变更（当前版本未连接云端）`;
  renderSettingsFolders();
  showModal('settings');
}

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
  document.querySelectorAll('.settings-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.settingsPanel === tab));
}

async function exportJson() {
  const snapshot = await exportSnapshot();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`prompt-vault-${stamp}.json`, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8');
  toast('JSON 已导出');
}

async function exportCsv(raw = false) {
  if (raw && !confirm('原始 CSV 保留公式前缀，不适合直接在电子表格中打开。继续导出？')) return;
  const snapshot = await exportSnapshot();
  const csv = snapshotToCsv(snapshot, new Map(snapshot.folders.map(folder => [folder.id, folder])), { raw });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(`prompt-vault-${stamp}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
  toast('CSV 已导出');
}

function chooseImport(type) {
  state.pendingImportType = type;
  const input = el('fileInput');
  input.accept = type === 'json' ? '.json,application/json' : '.csv,text/csv';
  input.value = '';
  input.click();
}

async function handleImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error('导入文件不能超过 32 MB，请拆分文件后重试');
    const text = await file.text();
    const json = state.pendingImportType === 'json';
    const data = json ? JSON.parse(text) : parseCsv(text);
    const preview = await (json ? previewSnapshotImport(data) : previewCsvImport(data));
    if (!confirm(`导入预览：新增 ${preview.added} 项，覆盖 ${preview.updated} 项。确认导入？`)) return;
    if (json) await importSnapshot(data, { preview });
    else await importCsvRows(data, { preview });
    await reloadData();
    toast('导入完成');
  } catch (error) { reportError(error); }
}

async function handleClearAll() {
  if (!confirm('确定清空所有提示词、文件夹和待同步记录吗？设置与设备标识会保留，建议先导出 JSON 备份。')) return;
  if (!confirm('再次确认：此操作不可恢复。')) return;
  await clearAllData();
  state.folderId = null;
  state.filter = 'all';
  closeModal('settings');
  await reloadData();
  toast('提示词、文件夹和待同步记录已清空');
}

function showModal(name) {
  const id = `${name}ModalBackdrop`;
  openDialog(el(id));
}

function closeModal(name) {
  const id = `${name}ModalBackdrop`;
  closeDialog(el(id));
  if (name === 'variable') state.variableActionPromptId = null;
}

function reportError(error) { if (state.settings) applySettingsToDom(); toast(`操作失败：${error.message}。未保存的编辑内容仍保留。`); }
function onSubmit(form, handler) {
  let pending = false;
  on(form, 'submit', async event => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    const buttons = [...document.querySelectorAll('button[type="submit"]')].filter(button => button.form === form);
    const disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    try { await handler(event); }
    finally { pending = false; buttons.forEach((button, index) => { button.disabled = disabled[index]; }); }
  });
}
function on(target, type, handler) {
  target.addEventListener(type, event => {
    try { Promise.resolve(handler(event)).catch(reportError); } catch (error) { reportError(error); }
  });
}

function toast(message) {
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = message;
  el('toastContainer').append(item);
  setTimeout(() => item.remove(), 2600);
}

init().catch((error) => {
  console.error(error);
  toast(`初始化失败：${error.message}`);
});
