// Folder order uses one versioned write. Native drag only starts at its explicit handle.
export function createFolderHandle(folder) {
  const handle = document.createElement('button');
  handle.type = 'button'; handle.className = 'folder-drag-handle';
  handle.draggable = true; handle.dataset.dragFolder = folder.id;
  handle.textContent = '⠿';
  handle.title = `拖动排序 ${folder.name}；Alt + ↑ / ↓ 调整`;
  handle.setAttribute('aria-label', `排序文件夹 ${folder.name}，Alt 加上下方向键移动`);
  return handle;
}
export function bindFolderReorder(container, { getFolders, save, onError, onSuccess }) {
  let dragged = null; let baseline = null; let busy = false;
  const rows = () => getFolders().map(({ id, version }) => ({ id, version }));
  const markBusy = value => container.querySelectorAll('[data-drag-folder]').forEach(handle => { handle.disabled = value; });
  const commit = async (order, focusId) => {
    if (busy) return;
    const previous = document.activeElement;
    const shouldRestore = previous?.dataset.dragFolder === focusId;
    busy = true; markBusy(true);
    try {
      await save(order); await onSuccess();
    } catch (error) { onError(error); }
    finally {
      busy = false; markBusy(false);
      if (shouldRestore && (document.activeElement === document.body || document.activeElement === previous)) {
        [...container.querySelectorAll('[data-drag-folder]')].find(handle => handle.dataset.dragFolder === focusId)?.focus({ preventScroll: true });
      }
    }
  };
  container.addEventListener('click', event => {
    if (event.target.closest('[data-drag-folder]')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  container.addEventListener('dragstart', event => {
    const handle = event.target.closest('[data-drag-folder]');
    if (!handle || busy) { event.preventDefault(); return; }
    dragged = handle.dataset.dragFolder; baseline = rows();
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragged);
    handle.classList.add('dragging');
  });
  container.addEventListener('dragover', event => {
    if (dragged && event.target.closest('[data-folder-id]')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
  });
  container.addEventListener('drop', event => {
    const target = event.target.closest('[data-folder-id]');
    if (!dragged || !target) return;
    event.preventDefault(); event.stopPropagation();
    const targetId = target.dataset.folderId; const sourceId = dragged;
    const order = baseline; dragged = null; baseline = null;
    const from = order.findIndex(folder => folder.id === sourceId);
    const to = order.findIndex(folder => folder.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const bounds = target.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    const [source] = order.splice(from, 1);
    const destination = order.findIndex(folder => folder.id === targetId) + (after ? 1 : 0);
    order.splice(destination, 0, source);
    void commit(order, sourceId);
  });
  container.addEventListener('dragend', () => {
    dragged = null; baseline = null;
    container.querySelectorAll('.dragging').forEach(handle => handle.classList.remove('dragging'));
  });
  container.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.repeat || event.shiftKey) return;
    const handle = event.target.closest('[data-drag-folder]');
    if (!handle || !event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (busy) return;
    const order = rows(); const index = order.findIndex(folder => folder.id === handle.dataset.dragFolder);
    const next = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (index < 0 || next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    void commit(order, handle.dataset.dragFolder);
  }, true);
}
